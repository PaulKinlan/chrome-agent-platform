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
// To preserve diagnostic visibility, the runner does NOT fail-fast: it runs
// every file in the list and reports all failures.
import { spawnSync } from "node:child_process";

export const DEFAULT_SERIAL_FILE_TIMEOUT_MS = 180_000; // 3 minutes per file

/**
 * @param {string} file
 * @param {{ timeoutMs?: number, stdio?: import("node:child_process").StdioOptions, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ code: number, timedOut: boolean, error?: Error }}
 */
export function runSerialFile(file, {
  timeoutMs = Number(process.env.CAP_SERIAL_TEST_TIMEOUT_MS ?? DEFAULT_SERIAL_FILE_TIMEOUT_MS),
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
  });
  if (r.error && r.error.code === "ETIMEDOUT") {
    console.error(`\nrun-tests: serial file ${file} TIMED OUT after ${timeoutMs / 1000}s`);
    return { code: 124, timedOut: true, error: r.error };
  }
  return { code: r.status ?? 1, timedOut: false, error: r.error };
}

/**
 * @param {string[]} files
 * @param {{ timeoutMs?: number, stdio?: import("node:child_process").StdioOptions, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {number}
 */
export function runSerialFiles(files, {
  timeoutMs = Number(process.env.CAP_SERIAL_TEST_TIMEOUT_MS ?? DEFAULT_SERIAL_FILE_TIMEOUT_MS),
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
