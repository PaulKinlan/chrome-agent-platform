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
import { readFileSync } from "node:fs";

/** Best-effort state of a live child, for the hang message. */
function snapshot(pid) {
  try {
    const wchan = readFileSync(`/proc/${pid}/wchan`, "utf8").trim() || "unknown";
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const state = /State:\s*(\S+)/.exec(status)?.[1] ?? "?";
    const threads = /Threads:\s*(\d+)/.exec(status)?.[1] ?? "?";
    return `pid=${pid} state=${state} threads=${threads} wchan=${wchan}`;
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
  timeoutMs = boundedChildTimeoutMs(env),
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
  const timer = setTimeout(() => {
    timedOut = true;
    at = child.pid ? snapshot(child.pid) : "pid unknown";
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    }
  }, timeoutMs);
  const [status, signal] = await new Promise((resolve) => {
    child.on("close", (code, sig) => resolve([code, sig]));
    child.on("error", (error) => { spawnError = error; resolve([null, null]); });
  });
  clearTimeout(timer);
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
      `This is a hang, not slow work — chrome-agent-platform-fnmr.`,
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
