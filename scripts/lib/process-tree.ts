// scripts/lib/process-tree.ts — kill a spawned process AND its whole tree.
// The journeys suite learned this the hard way: killing only the Chromium
// parent leaves orphaned children running (they keep the profile dir alive
// and recreate files after it is removed). chrome-journeys.ts carries its own
// copy with suite-specific hard-fail wiring; this is the shared helper for
// live scripts (CAP-FB-20260902-LIVE-SCRIPT-CLEANUP-01, chrome-agent-platform-2ypf).

const PKILL = "/usr/bin/pkill";
const PGREP = "/usr/bin/pgrep";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOut(bin: string, args: string[]) {
  // Absolute path + a cleared environment: no PATH/LD_* tricks in a cleanup path.
  return await new Deno.Command(bin, { args, stdout: "piped", stderr: "piped", clearEnv: true }).output();
}

/**
 * Kill `proc` and every process whose argv contains `treeMatch`, then verify
 * none remain. `treeMatch` must NOT start with "-" (pkill/pgrep would parse a
 * leading "--user-data-dir=…" as an OPTION and exit 2). Throws when survivors
 * or a pgrep failure make cleanup unconfirmable — never silently fails open.
 */
export async function killProcessTree(
  proc: Deno.ChildProcess | null,
  treeMatch: string,
  { attempts = 20, intervalMs = 250 }: { attempts?: number; intervalMs?: number } = {},
): Promise<void> {
  if (treeMatch.startsWith("-")) {
    throw new Error("treeMatch must not start with '-' (pkill would parse it as an option)");
  }
  try { proc?.kill("SIGKILL"); } catch { /* already gone */ }
  try { await proc?.status; } catch { /* reaped */ }
  await runOut(PKILL, ["-9", "-f", treeMatch]).catch(() => { /* nothing matched */ });
  for (let i = 0; i < attempts; i++) {
    let out;
    try {
      out = await runOut(PGREP, ["-f", treeMatch]);
    } catch (e) {
      throw new Error(`pgrep failed (${(e as Error)?.message ?? e}) — cannot confirm cleanup`);
    }
    if (out.code === 1) return; // pgrep found nothing → no matching process
    if (out.code !== 0) {
      throw new Error(`pgrep exited ${out.code} — cannot confirm cleanup`);
    }
    await sleep(intervalMs);
  }
  throw new Error("process tree survived cleanup");
}
