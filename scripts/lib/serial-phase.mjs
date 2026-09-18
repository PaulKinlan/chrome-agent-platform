// scripts/lib/serial-phase.mjs — serial test phase execution with process
// isolation and per-file timeouts (chrome-agent-platform-6yrq, xn2q item 3).
//
// Invariant: tests in the serial phase MUST execute in their own process so
// process-global environment variables (CAP_CHROME_LOCK_PATH, CAP_CHROME_SLOT_DIR)
// and in-memory module-level state (heldSlots in chrome-slots.ts, lockStates in
// chrome-launch.ts) never leak from one test file to another.
//
// Every test file is guarded by an explicit timeout (default 180s, tunable via
// CAP_SERIAL_TEST_TIMEOUT_MS) with SIGKILL; a timed-out test logs an explicit
// TIMED OUT notice and returns exit code 124 rather than wedging the suite.
//
// Process group isolation (chrome-agent-platform-pozs): tests spawn detached so
// they run as their own process group leader. On timeout, SIGKILL is sent to the
// whole process group (-r.pid) so no background grandchildren or subprocesses
// survive as orphans holding file locks or descriptors.
//
// To preserve diagnostic visibility, the runner does NOT fail-fast: it runs
// every file in the list and reports all failures.
import { spawnSync } from "node:child_process";
import os from "node:os";

export const DEFAULT_SERIAL_FILE_TIMEOUT_MS = 180_000; // 3 minutes per file ON AN IDLE BOX

// chrome-agent-platform-86gg: a flat 180s is sized for an idle box. The same
// BUILD work takes several times longer under the fleet's normal load (two runs
// on 2026-09-18 timed out at load 42-48 and 31-36 while the same files passed at
// low load, and both passed focused in seconds), so the bound false-reds exactly
// when the box is busy — the condition the suite exists to work in.
//
// The default is therefore scaled by load per CPU, and the ceiling keeps it a
// BOUND rather than a licence: an idle box gets the base unchanged, a box at
// MAX_LOAD_SCALE x cores-per-CPU (or beyond) gets the ceiling, and an explicit
// CAP_SERIAL_TEST_TIMEOUT_MS always wins unscaled — the operator asked for that
// number. The effective bound is printed when it is scaled, so a timeout
// explains itself instead of looking like a hang.
export const MAX_LOAD_SCALE = 4;

/**
 * Pure: the timeout for one serial file, given the machine's load.
 * @param {{ base?: number, loadPerCpu?: number, override?: string|number|null }} [options]
 * @returns {number}
 */
export function serialFileTimeoutMs({ base = DEFAULT_SERIAL_FILE_TIMEOUT_MS, loadPerCpu = 1, override = null } = {}) {
  const explicit = Number(override ?? NaN);
  if (Number.isFinite(explicit) && explicit > 0) return explicit; // the operator's number, unscaled
  const ratio = Number.isFinite(loadPerCpu) && loadPerCpu > 1 ? loadPerCpu : 1;
  const scale = Math.min(ratio, MAX_LOAD_SCALE);
  return Math.round(base * scale);
}

/** The machine's current load per CPU (1 when it is idle or unsizable).
 * @returns {number}
 */
export function currentLoadPerCpu() {
  try {
    const cpus = os.cpus?.().length ?? 0;
    const load = os.loadavg?.()[0] ?? 0;
    if (!cpus) return 1;
    return load / cpus;
  } catch {
    return 1;
  }
}

/** The default timeout for this run, with the reason printed when it is scaled.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function defaultSerialTimeoutMs(env = process.env) {
  const override = env?.CAP_SERIAL_TEST_TIMEOUT_MS ?? null;
  const loadPerCpu = currentLoadPerCpu();
  const ms = serialFileTimeoutMs({ base: DEFAULT_SERIAL_FILE_TIMEOUT_MS, loadPerCpu, override });
  if (!override && ms !== DEFAULT_SERIAL_FILE_TIMEOUT_MS) {
    console.log(`run-tests: serial timeout scaled to ${ms / 1000}s (base ${DEFAULT_SERIAL_FILE_TIMEOUT_MS / 1000}s x load ${loadPerCpu.toFixed(2)} per CPU, ceiling x${MAX_LOAD_SCALE})`);
  }
  return ms;
}

/**
 * @param {string} file
 * @param {{ timeoutMs?: number, stdio?: import("node:child_process").StdioOptions, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ code: number, timedOut: boolean, error?: Error, stdout?: Buffer|null, stderr?: Buffer|null }}
 */
export function runSerialFile(file, {
  timeoutMs = defaultSerialTimeoutMs(),
  stdio = "inherit",
  cwd = undefined,
  env = process.env,
} = {}) {
  const r = spawnSync("deno", ["test", "-A", "--config", "deno.runner.jsonc", file], {
    stdio,
    cwd,
    env: { ...env, CAP_TEST_RUNNER: "1" },
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    detached: true,
  });
  if (r.error && r.error.code === "ETIMEDOUT") {
    // Kill the entire process group so no grandchild survives as an orphan.
    if (r.pid) {
      try {
        process.kill(-r.pid, "SIGKILL");
      } catch {
        // Group already gone or reaped.
      }
    }
    console.error(`\nrun-tests: serial file ${file} TIMED OUT after ${timeoutMs / 1000}s`);
    return { code: 124, timedOut: true, error: r.error, stdout: r.stdout, stderr: r.stderr };
  }
  // Safety: kill any remaining process group descendants so orphaned background processes
  // cannot linger even if the direct child exited or crashed.
  if (r.pid) {
    try {
      process.kill(-r.pid, "SIGKILL");
    } catch {
      // Clean.
    }
  }
  return { code: r.status ?? 1, timedOut: false, error: r.error, stdout: r.stdout, stderr: r.stderr };
}

/**
 * @param {string[]} files
 * @param {{ timeoutMs?: number, stdio?: import("node:child_process").StdioOptions, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {number}
 */
export function runSerialFiles(files, {
  timeoutMs = defaultSerialTimeoutMs(),
  stdio = "inherit",
  cwd = undefined,
  env = process.env,
} = {}) {
  const t0 = Date.now();
  let firstFailure = 0;
  let failedCount = 0;
  for (const file of files) {
    const result = runSerialFile(file, { timeoutMs, stdio, cwd, env });
    if (result.code !== 0) {
      if (firstFailure === 0) firstFailure = result.code;
      failedCount++;
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const statusStr = failedCount === 0 ? "GREEN" : `FAILED (${failedCount}/${files.length} failed)`;
  console.log(`\nrun-tests: serial phase (${files.length} build/artifact files) ${statusStr} in ${secs}s`);
  return firstFailure;
}
