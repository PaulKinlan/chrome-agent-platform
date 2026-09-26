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
import { durableDir } from "./durable-root.mjs";

/** Per-thread wchan, which is what identifies a futex hang when a signal report cannot be written.
 *  MEASURED (2026-09-24, node v24.21.0): `--report-on-signal --report-signal=SIGUSR2` writes a full
 *  report for an idle child (measured: 31 KB file, child survives), but a child BLOCKED in a futex
 *  (`Atomics.wait`, the `wchan=futex_do_wait` shape this bead is about) writes none. Re-measured
 *  2026-09-25: WITH the flags that child survives the signal (alive 1.6 s later, 0 reports) and only
 *  the kill ends it; WITHOUT them the signal terminates it. Either way the report path cannot
 *  diagnose fnmr, and the thread table is the evidence. Bounded to a few threads to keep the message
 *  readable. */
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

/** The longest delay a JS timer can carry: 2^31 - 1 ms (~24.8 days). Node and Deno silently
 *  clamp a longer setTimeout delay to 1 ms, so an "unscaled" huge override killed a fast child
 *  after ~5 ms and reported a nonsense bound (chrome-agent-platform-61h3 re-review). */
export const MAX_TIMER_MS = 2_147_483_647;

/** The operator's bound, or the default. The variable name is a parameter because build.mjs
 *  guards its own child with CAP_BUNDLED_TOOL_TIMEOUT_MS and must not carry a second copy of
 *  this parse (chrome-agent-platform-61h3). An absent, empty, whitespace, non-numeric or
 *  non-positive value means UNSET — `Number("") === 0` used to hand every child a 0 ms bound,
 *  so it was killed on the first tick and the failure read as a hang. A positive number is the
 *  operator's value, clamped to what a timer can actually carry. */
export function boundedChildTimeoutMs(env = process.env, variable = "CAP_BOUNDED_CHILD_TIMEOUT_MS") {
  const raw = env[variable];
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_BOUNDED_CHILD_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BOUNDED_CHILD_TIMEOUT_MS;
  return Math.min(Math.round(value), MAX_TIMER_MS);
}

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

/** Append one JSON line describing a hang to `<recordDir>/hangs.jsonl`, and return the sentence that
 *  says what happened to it. The sentence names the file ONLY when the append succeeded: the old
 *  sentence was unconditional, and it was false in the futex case this helper exists for (fnmr
 *  review, 2026-09-25). The default directory is on the durable root, not in the worktree: a
 *  worktree is reset and pruned, and a record whose only copy lives there is not evidence. Never
 *  throws — logging must not become a second failure. */
function recordHang(recordDir, entry) {
  try {
    const dir = recordDir ?? durableDir("bounded-child-hangs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "hangs.jsonl");
    appendFileSync(file, JSON.stringify(entry) + "\n");
    return `A durable record was appended to ${file}.`;
  } catch (e) {
    return `No durable record was written (${e?.message ?? e}).`;
  }
}

/**
 * `recordDir`: where a hang's record is appended (hangs.jsonl). The default is
 * durableDir("bounded-child-hangs"); tests pass their own, so a record they read back is theirs.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, stdio?: import("node:child_process").StdioOptions,
 *           timeoutMs?: number, label?: string, recordDir?: string }} [options]
 * @returns {Promise<{ status: number, signal: NodeJS.Signals | null, ms: number }>}
 */
export async function runBoundedChild(command, args, {
  cwd,
  env = process.env,
  stdio = "inherit",
  timeoutMs = boundedChildTimeoutMs(env),
  label = command,
  recordDir,
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
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    at = child.pid ? snapshot(child.pid) : "pid unknown";
    if (child.pid) {
      // ASK FOR THE FRAMES BEFORE KILLING (fnmr): the state sample above says where the thread
      // sleeps (futex_do_wait), not what it was doing. A child started with
      // `--report-on-signal --report-signal=SIGUSR2` can write a diagnostic report on that signal
      // (an idle one does; a futex-blocked one does not, see threadTable); one started without
      // them is terminated by it. Either way the process-group kill still happens,
      // REPORT_GRACE_MS later, so the bound is honoured.
      try { child.kill("SIGUSR2"); } catch { /* gone */ }
      // This timer ONLY kills. The report lookup and the durable record happen once, after the
      // child is gone (below). They used to live in here, and a child that DIES on SIGUSR2 inside
      // the grace window cancels this timer: that case wrote no record while the message said it
      // had (fnmr review, 2026-09-25).
      killTimer = setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
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
    const report = findReport(child.pid, cwd ?? process.cwd());
    // How the child actually ended: SIGUSR2 when the diagnostic signal killed it, SIGKILL when it
    // outlived the grace window. Recorded and said, because it is observed rather than assumed.
    const endedBy = signal ?? `exit ${status}`;
    // WRITE IT DOWN, because the message may never be read: when this hang happens inside a
    // serial test FILE, the runner's own per-file timeout can kill the file before its ERRORS
    // section prints, and the message below is lost (observed: p15i reconciliation hung 121 s,
    // the file timed out at 180 s, and no HUNG text appeared in the log at all). A durable line
    // is what makes the next occurrence evidence.
    // stdoutTail answers the question the FIX depends on: did the child finish its WORK and
    // then fail to exit (a teardown-only hang, which a caller could accept), or did it hang
    // mid-work (which it cannot)? Captured only when stdio was piped.
    const tail = capture ? Buffer.concat(outChunks).toString("utf8").trim().split("\n").slice(-2).join(" ⏎ ") : "(stdout not captured)";
    // cwd says WHICH checkout hung: the default record file is shared by every lane on the box.
    const recorded = recordHang(recordDir, {
      at: new Date().toISOString(), label, cwd: cwd ?? process.cwd(), timeoutMs, snapshot: at, report, endedBy, stdoutTail: tail,
    });
    throw new Error(
      `${label} HUNG: no exit within ${(timeoutMs / 1000).toFixed(0)}s (${at}); its process group was killed. ` +
      `This is a hang, not slow work — chrome-agent-platform-fnmr. ` +
      (report === "none"
        ? `No diagnostic report was produced (the child ended on ${endedBy}), so read the thread-wchan table above; start the child with --report-on-signal --report-signal=SIGUSR2 for the cases where a report IS possible.`
        : `Diagnostic report: ${report} (the child ended on ${endedBy}).`) +
      ` ${recorded}`,
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
