// scripts/lib/bounded-child.mjs — run a child with a wall-clock bound, take its
// whole process group down on timeout, and NAME the hang
// (chrome-agent-platform-fnmr).
//
// Why: scripts/build-bundled-tool-packages.mjs --verify can block in a futex
// wait and never exit (measured: 0% CPU, 3 threads, no children, no locks).
// Unbounded callers then either wedge (a `node build.mjs` sat alive for 3h37m)
// or present the block as "the test timed out", naming the wrong cause. A child
// that can block forever must be bounded by its caller, and the failure must say
// what hung — including the child's state, sampled BEFORE it is killed, so the
// next occurrence is evidence. Process-group kill follows pozs: killing only the
// direct child leaves an orphan that keeps the worktree.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Per-thread wchan, which is what identifies a futex hang when a signal report cannot be written.
 *  MEASURED (2026-09-24, node v24.21.0): `--report-on-signal --report-signal=SIGUSR2` writes a full
 *  report for an idle child (measured: 31 KB file, child survives) but for a child BLOCKED in a
 *  futex (`Atomics.wait`, the `wchan=futex_do_wait` shape this bead is about) the signal TERMINATES
 *  it and no report appears — so the report path cannot diagnose fnmr and the thread table is the
 *  evidence. Bounded to a few threads to keep the message readable. */
function threadTable(pid) {
  try {
    const tasks = readdirSync(`/proc/${pid}/task`).sort((a, b) => Number(a) - Number(b));
    return tasks.slice(0, 4).map((tid) => {
      let wchan = "?";
      try { wchan = readFileSync(`/proc/${pid}/task/${tid}/wchan`, "utf8").trim() || "running"; } catch { /* gone */ }
      return `${tid}:${wchan}`;
    }).join(",") + (tasks.length > 4 ? `,(+${tasks.length - 4} more)` : "");
  } catch {
    return "unavailable";
  }
}

/** Best-effort state of a live child, for the hang message. */
function snapshot(pid) {
  try {
    const wchan = readFileSync(`/proc/${pid}/wchan`, "utf8").trim() || "unknown";
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const state = /State:\s*(\S+)/.exec(status)?.[1] ?? "?";
    const threads = /Threads:\s*(\d+)/.exec(status)?.[1] ?? "?";
    return `pid=${pid} state=${state} threads=${threads} wchan=${wchan} thread-wchan[${threadTable(pid)}]`;
  } catch {
    return `pid=${pid} (state unavailable — process already gone)`;
  }
}

export const DEFAULT_BOUNDED_CHILD_TIMEOUT_MS = 120_000;

/** How long the child gets to write a diagnostic report after SIGUSR2, before the kill. Kept
 *  short: it is added to the bound, not a new bound. */
const REPORT_GRACE_MS = 1500;

/** The newest Node diagnostic report for `pid` in the child's cwd, or "none".
 *  `wchan=futex_do_wait` says WHERE the thread sleeps; the report says WHAT it was doing
 *  (chrome-agent-platform-fnmr). A child that was not started with the report flags is simply
 *  terminated by SIGUSR2, and this returns "none" — which the message states rather than hides. */
function findReport(pid, dir) {
  try {
    const hit = readdirSync(dir)
      .filter((f) => f.startsWith("report.") && f.includes(`.${pid}.`) && f.endsWith(".json"))
      .sort()
      .at(-1);
    return hit ? join(dir, hit) : "none";
  } catch {
    return "none";
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdio?: import("node:child_process").StdioOptions,
 *           timeoutMs?: number, label?: string }} [options]
 * @returns {Promise<{ status: number, signal: NodeJS.Signals | null, ms: number }>}
 */
export async function runBoundedChild(command, args, {
  cwd,
  env = process.env,
  stdio = "inherit",
  timeoutMs = Number(env.CAP_BOUNDED_CHILD_TIMEOUT_MS ?? DEFAULT_BOUNDED_CHILD_TIMEOUT_MS),
  label = command,
} = {}) {
  const started = Date.now();
  const child = spawn(command, args, { cwd, env, stdio, detached: true });
  const capture = Array.isArray(stdio) && (stdio[1] === "pipe" || stdio[2] === "pipe");
  const outChunks = [];
  const errChunks = [];
  if (capture) {
    child.stdout?.on("data", (d) => outChunks.push(d));
    child.stderr?.on("data", (d) => errChunks.push(d));
  }
  let timedOut = false;
  let spawnError = null;
  let at = "no snapshot";
  let report = "none";
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    at = child.pid ? snapshot(child.pid) : "pid unknown";
    if (child.pid) {
      // ASK FOR THE FRAMES BEFORE KILLING (fnmr): the state sample above says where the thread
      // sleeps (futex_do_wait), not what it was doing. A child started with
      // `--report-on-signal --report-signal=SIGUSR2` writes a diagnostic report on that signal;
      // one that was not is terminated by it, which is what the kill below does anyway. Either
      // way the process-group kill still happens, REPORT_GRACE_MS later, so the bound is honoured
      // and a hang now leaves a stack behind.
      const dir = cwd ?? process.cwd();
      try { child.kill("SIGUSR2"); } catch { /* gone */ }
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
        report = findReport(child.pid, dir);
        // WRITE IT DOWN, because the message may never be read: when this hang happens inside a
        // serial test FILE, the runner's own per-file timeout can kill the file before its ERRORS
        // section prints, and the message below is lost (observed: p15i reconciliation hung 121 s,
        // the file timed out at 180 s, and no HUNG text appeared in the log at all). A durable line
        // is what makes the next occurrence evidence.
        try {
          const cacheDir = join(dir, ".cache");
          mkdirSync(cacheDir, { recursive: true });
          appendFileSync(join(cacheDir, "bounded-child-hangs.log"), JSON.stringify({
            at: new Date().toISOString(), label, timeoutMs, snapshot: at, report,
          }) + "\n");
        } catch { /* best effort: never turn logging into a second failure */ }
      }, REPORT_GRACE_MS);
    }
  }, timeoutMs);
  const [status, signal] = await new Promise((resolve) => {
    child.on("close", (code, sig) => resolve([code, sig]));
    child.on("error", (error) => { spawnError = error; resolve([null, null]); });
  });
  clearTimeout(timer);
  if (killTimer !== undefined) clearTimeout(killTimer);
  // Reap any descendant that outlived the direct child (pozs).
  if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* clean */ } }
  const ms = Date.now() - started;
  // A child that never STARTED is not a hang: naming it HUNG would be the
  // wrong-cause error this helper exists to prevent (4ctv).
  if (spawnError) {
    throw new Error(`${label} FAILED TO START: ${spawnError.message}`);
  }
  if (timedOut || status === null) {
    throw new Error(
      `${label} HUNG: no exit within ${(timeoutMs / 1000).toFixed(0)}s (${at}); its process group was killed. ` +
      `This is a hang, not slow work — chrome-agent-platform-fnmr. ` +
      (report === "none"
        ? `No diagnostic report was produced — expected when the child is BLOCKED in a futex (measured: the signal terminates such a child without writing one), so read the thread-wchan table above; start the child with --report-on-signal --report-signal=SIGUSR2 for the cases where a report IS possible.`
        : `Diagnostic report: ${report} (it holds the frames of the futex wait).`) +
      ` A durable record was appended to .cache/bounded-child-hangs.log in the child's cwd.`,
    );
  }
  return {
    status,
    signal,
    ms,
    stdout: capture ? Buffer.concat(outChunks).toString("utf8") : undefined,
    stderr: capture ? Buffer.concat(errChunks).toString("utf8") : undefined,
  };
}
