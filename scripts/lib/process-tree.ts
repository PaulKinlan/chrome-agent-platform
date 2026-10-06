// scripts/lib/process-tree.ts — kill a spawned process AND its whole tree.
// The journeys suite learned this the hard way: killing only the Chromium
// parent leaves orphaned children running (they keep the profile dir alive
// and recreate files after it is removed). chrome-journeys.ts carries its own
// copy with suite-specific hard-fail wiring; this is the shared helper for
// live scripts (CAP-FB-20260902-LIVE-SCRIPT-CLEANUP-01, chrome-agent-platform-2ypf).

const PKILL = "/usr/bin/pkill";
const PGREP = "/usr/bin/pgrep";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Linux /proc stat has a parenthesized comm (which may contain spaces or ')'). */
function processGroup(pid: number): { group: number; state: string } | null {
  try {
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]) };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

/** The launcher waits for setsid to exec before recording the isolated group. */
export async function isolatedProcessGroup(proc: Deno.ChildProcess): Promise<number | undefined> {
  for (let i = 0; i < 20; i++) {
    const stat = processGroup(proc.pid);
    if (stat?.group === proc.pid) return proc.pid;
    if (!stat || stat.state === "Z") return undefined; // exited before observation
    await sleep(25);
  }
  throw new Error(`Chrome pid ${proc.pid} did not enter its own process group; refusing group kill`);
}

function liveGroupMembers(group: number): number[] {
  const members: number[] = [];
  for (const entry of Deno.readDirSync("/proc")) {
    if (!/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const stat = processGroup(pid);
    // Reparented zombies await init, and cannot run or hold a Chrome profile.
    if (stat?.group === group && stat.state !== "Z" && stat.state !== "X") members.push(pid);
  }
  return members;
}

async function runOut(bin: string, args: string[]) {
  // Absolute path + a cleared environment: no PATH/LD_* tricks in a cleanup path.
  return await new Deno.Command(bin, { args, stdout: "piped", stderr: "piped", clearEnv: true }).output();
}

/**
 * Kill `proc`, its isolated group when provided, and processes whose argv
 * contains `treeMatch`, then verify both group and profile have no live members. `treeMatch` must NOT start with "-" (pkill/pgrep would parse a
 * leading "--user-data-dir=…" as an OPTION and exit 2). Throws when survivors
 * or a pgrep failure make cleanup unconfirmable — never silently fails open.
 */
export async function killProcessTree(
  proc: Deno.ChildProcess | null,
  treeMatch: string,
  { attempts = 20, intervalMs = 250, group }: { attempts?: number; intervalMs?: number; group?: number } = {},
): Promise<void> {
  if (treeMatch.startsWith("-")) {
    throw new Error("treeMatch must not start with '-' (pkill would parse it as an option)");
  }
  if (group !== undefined) {
    if (!Number.isSafeInteger(group) || group <= 1 || group === Deno.pid ||
      processGroup(Deno.pid)?.group === group || (proc && group !== proc.pid)) {
      throw new Error(`refusing unsafe process group ${group}`);
    }
    // The launcher starts Chrome through setsid. Kill the isolated group BEFORE
    // reaping the leader: children with rewritten argv still belong to it.
    try { Deno.kill(-group, "SIGKILL"); } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  try { proc?.kill("SIGKILL"); } catch { /* already gone */ }
  try { await proc?.status; } catch { /* reaped */ }
  const killed = await runOut(PKILL, ["-9", "-f", treeMatch]);
  if (killed.code !== 0 && killed.code !== 1) throw new Error(`pkill exited ${killed.code} — cannot confirm cleanup`);
  for (let i = 0; i < attempts; i++) {
    let out;
    try {
      out = await runOut(PGREP, ["-f", treeMatch]);
    } catch (e) {
      throw new Error(`pgrep failed (${(e as Error)?.message ?? e}) — cannot confirm cleanup`);
    }
    if (out.code === 1 && (group === undefined || liveGroupMembers(group).length === 0)) return;
    if (out.code !== 0 && out.code !== 1) {
      throw new Error(`pgrep exited ${out.code} — cannot confirm cleanup`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`process tree survived cleanup${group === undefined ? "" : ` (group ${group}: ${liveGroupMembers(group).join(",")})`}`);
}
