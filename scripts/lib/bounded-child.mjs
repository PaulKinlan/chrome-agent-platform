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
    child.on("error", () => resolve([null, null]));
  });
  clearTimeout(timer);
  // Reap any descendant that outlived the direct child (pozs).
  if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* clean */ } }
  const ms = Date.now() - started;
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
