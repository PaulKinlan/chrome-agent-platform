// scripts/lib/process-tree.ts — kill a spawned process AND its whole tree.
// The journeys suite learned this the hard way: killing only the Chromium
// parent leaves orphaned children running (they keep the profile dir alive
// and recreate files after it is removed). chrome-journeys.ts carries its own
// copy with suite-specific hard-fail wiring; this is the shared helper for
// live scripts (CAP-FB-20260902-LIVE-SCRIPT-CLEANUP-01, chrome-agent-platform-2ypf).

const PKILL = "/usr/bin/pkill";
const PGREP = "/usr/bin/pgrep";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HAS_PROC = (() => {
  try { return Deno.statSync("/proc").isDirectory; } catch { return false; }
})();

const HAS_SETSID = (() => {
  try { return Deno.statSync("/usr/bin/setsid").isFile; } catch { return false; }
})();

/**
 * Build a command + args pair that launches `binary` as a new session and
 * process-group leader (`pgid === sid === pid`) in-place via `exec`. Uses
 * `/usr/bin/setsid` when present (Linux) and `/usr/bin/perl -MPOSIX` when
 * `/usr/bin/setsid` is absent (macOS).
 */
export function setsidSpawnSpec(binary: string, args: string[]): { command: string; args: string[] } {
  if (HAS_SETSID) {
    return { command: "/usr/bin/setsid", args: [binary, ...args] };
  }
  return {
    command: "/usr/bin/perl",
    args: [
      "-MPOSIX",
      "-e",
      "POSIX::setsid() >= 0 or die $!; exec {$ARGV[0]} @ARGV; POSIX::_exit(127)",
      "--",
      binary,
      ...args,
    ],
  };
}

/** Linux /proc stat has a parenthesized comm (which may contain spaces or ')').
 *  Falls back to `/bin/ps` when `/proc` is absent (macOS). */
function processGroup(pid: number): { group: number; state: string; startTicks: string } | null {
  if (!HAS_PROC) {
    try {
      const out = new Deno.Command("/bin/ps", {
        args: ["-o", "pid=,pgid=,state=,lstart=", "-p", String(pid)],
        stdout: "piped",
        stderr: "null",
        clearEnv: true,
      }).outputSync();
      if (out.code !== 0) return null;
      const line = new TextDecoder().decode(out.stdout).trim();
      if (!line) return null;
      const parts = line.split(/\s+/);
      if (parts.length < 4) return null;
      return {
        state: parts[2][0] ?? "?",
        group: Number(parts[1]),
        startTicks: parts.slice(3).join(" "),
      };
    } catch {
      return null;
    }
  }
  try {
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]), startTicks: fields[19] };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

// Bind a group to the exact leader observed after setsid exec, not just its PID:
// Linux may reuse a reaped leader's PID for an unrelated process group.
const leaderStartTicks = new WeakMap<Deno.ChildProcess, string>();
const lifelines = new WeakMap<Deno.ChildProcess, () => Promise<void>>();

/**
 * Attach a crash-safe lifeline watchdog to `proc`. The watchdog runs in its own
 * session and reads a pipe whose write end is held exclusively by this parent
 * process. If this process dies for ANY reason (including `SIGKILL` or a test
 * runner killing the parent's process group), the kernel closes the pipe and the
 * watchdog immediately terminates `proc`, its isolated process group, and any
 * helper matching `treeMatch`. Normal `killProcessTree` disarms the watchdog
 * before cleanup.
 */
export function attachProcessLifeline(
  proc: Deno.ChildProcess,
  { group, treeMatch }: { group?: number; treeMatch?: string } = {},
): () => Promise<void> {
  const existing = lifelines.get(proc);
  if (existing) return existing;
  const target = String(group ?? proc.pid);
  const match = treeMatch && !treeMatch.startsWith("-") ? treeMatch : "";
  const spec = setsidSpawnSpec("/bin/sh", [
    "-c",
    'cat >/dev/null 2>&1; ' +
      'if [ -n "$CAP_LIFELINE_TARGET" ]; then ' +
      'kill -TERM -"$CAP_LIFELINE_TARGET" "$CAP_LIFELINE_TARGET" 2>/dev/null || true; ' +
      'sleep 0.1; ' +
      'kill -KILL -"$CAP_LIFELINE_TARGET" "$CAP_LIFELINE_TARGET" 2>/dev/null || true; ' +
      'fi; ' +
      'if [ -n "$CAP_LIFELINE_MATCH" ]; then ' +
      '/usr/bin/pkill -9 -f "$CAP_LIFELINE_MATCH" 2>/dev/null || true; ' +
      'fi',
  ]);
  let watcher: Deno.ChildProcess | null = null;
  try {
    watcher = new Deno.Command(spec.command, {
      args: spec.args,
      stdin: "piped",
      stdout: "null",
      stderr: "null",
      clearEnv: true,
      env: {
        CAP_LIFELINE_TARGET: target,
        CAP_LIFELINE_MATCH: match,
      },
    }).spawn();
  } catch {
    const noop = async () => {};
    lifelines.set(proc, noop);
    return noop;
  }
  let disarmed = false;
  const disarm = async () => {
    if (disarmed || !watcher) return;
    disarmed = true;
    try { watcher.kill("SIGKILL"); } catch { /* gone */ }
    try { await watcher.stdin.close(); } catch { /* closed */ }
    try { await watcher.status; } catch { /* reaped */ }
  };
  lifelines.set(proc, disarm);
  proc.status.then(disarm, disarm);
  return disarm;
}

/** The launcher waits for setsid to exec before recording the isolated group. */
export async function isolatedProcessGroup(proc: Deno.ChildProcess): Promise<number | undefined> {
  for (let i = 0; i < 20; i++) {
    const stat = processGroup(proc.pid);
    if (stat?.group === proc.pid) {
      leaderStartTicks.set(proc, stat.startTicks);
      return proc.pid;
    }
    if (!stat || stat.state === "Z") return undefined; // exited before observation
    await sleep(25);
  }
  throw new Error(`Chrome pid ${proc.pid} did not enter its own process group; refusing group kill`);
}

export function liveGroupMembers(group: number): number[] {
  if (!HAS_PROC) {
    try {
      const out = new Deno.Command("/bin/ps", {
        args: ["-axo", "pid=,pgid=,state="],
        stdout: "piped",
        stderr: "null",
        clearEnv: true,
      }).outputSync();
      if (out.code !== 0) return [];
      return new TextDecoder().decode(out.stdout).split("\n").flatMap((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) return [];
        const pid = Number(parts[0]);
        const pgid = Number(parts[1]);
        const state = parts[2][0];
        return pgid === group && state !== "Z" && state !== "X" ? [pid] : [];
      });
    } catch {
      return [];
    }
  }
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
 * contains `treeMatch`, then verify both group and profile have no live
 * members. `treeMatch` must NOT start with "-": pkill/pgrep would parse a
 * leading "--user-data-dir=…" as an option and exit 2. Throws when survivors
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
  if (proc) {
    const disarm = lifelines.get(proc);
    if (disarm) await disarm();
  }
  if (group !== undefined) {
    if (!proc || !Number.isSafeInteger(group) || group <= 1 || group === Deno.pid ||
      processGroup(Deno.pid)?.group === group || group !== proc.pid) {
      throw new Error(`refusing unsafe process group ${group}`);
    }
    // Signal only the exact leader observed by isolatedProcessGroup. If it
    // exited or its PID was reused, the profile match remains the fallback.
    const current = processGroup(group);
    if (current?.group === group && current.startTicks === leaderStartTicks.get(proc)) {
      try { Deno.kill(-group, "SIGKILL"); } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
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
