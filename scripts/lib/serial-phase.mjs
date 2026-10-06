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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { durableRoot } from "./durable-root.mjs";
// The per-file serial windows live in ONE table (chrome-agent-platform-kj9s). They are the DEFAULT
// here, not an opt-in argument, so every caller gets them — including scripts/select-tests.mjs,
// which runs a subset of the same serial files under `npm run test:changed` and would otherwise
// hand a build-heavy file the base window and kill it. A caller that wants the old behaviour passes
// `perFileTimeoutMs: null` explicitly.
import { SERIAL_FILE_TIMEOUTS } from "../test-partition.mjs";

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
    // A generous cap on CAPTURED output: spawnSync's 1 MiB default would turn a
    // talkative-but-passing build file into an ENOBUFS "failure" (chrome-agent-platform-dsoq).
    maxBuffer: 64 * 1024 * 1024,
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
    announce(`\nrun-tests: serial file ${file} TIMED OUT after ${timeoutMs / 1000}s`);
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
 * Where per-file serial logs are written: a DURABLE directory, never tmpfs (the
 * repo's one durable-root rule). Returns null when that root is unusable, and says
 * so — the captured output is still printed, so attribution never depends on it.
 * @returns {string|null}
 */
function serialLogDir() {
  try {
    const dir = join(durableRoot(), "serial-phase-logs");
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    announce(
      `run-tests: WARNING — per-file serial logs unavailable (${e?.message ?? e}); ` +
        `failing files are still named and their output printed below`,
    );
    return null;
  }
}

/**
 * chrome-agent-platform-ia4z: the per-file failure notices and the named failing-file
 * block used to go to STDERR ONLY, while the phase headers and the summary went to
 * STDOUT. A consumer that captures stdout alone therefore got a COUNT WITH NO NAME —
 * which is how a red gets misattributed to whoever changed something, and it happened
 * twice on 2026-10-06 (0iln's gate and o2t3's, where the name had to be recovered from
 * the durable per-file belt). Attribution now goes to BOTH streams: stdout so it
 * survives a stdout-only capture AND a mid-phase kill (a kill deletes any end-of-phase-
 * only mechanism), stderr because a human running the command reads it there.
 */
function announce(line) {
  console.log(line);
  console.error(line);
}

// chrome-agent-platform-ulcw: a per-process monotonic run counter. Millisecond stamp + pid is NOT
// unique within one process — two calls started in the same millisecond share it — and a reader who
// then counts the durable per-file logs under one stamp can see MORE failures than the summary of any
// single run reported, which is exactly the '1/6 failed with two failure logs' evidence on this bead.
// The counter makes each call's run id unique on the box, and the summary PRINTS that id, so the count
// and its logs are matched by the same value instead of inferred from a timestamp.
let SERIAL_RUN_SEQ = 0;

/**
 * @param {string[]} files
 * @param {{ timeoutMs?: number, perFileTimeoutMs?: Record<string, number> | null, stdio?: import("node:child_process").StdioOptions, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {number}
 *
 * chrome-agent-platform-dsoq: this used to print only a COUNT — "serial phase (19 build/artifact
 * files) FAILED (1/19 failed)" — with no file named, which made a landing gate UNREADABLE: the
 * merger could not tell whether the change under test had caused the failure, and had to re-run the
 * whole bounded gate (once losing it to queue-wait). Worse, several serial files print no
 * "running N tests" banner when they fail early (a type-check error prints only "Check <file>" + an
 * error), so "which file failed" was not even recoverable by reading the log. A gate verdict that
 * reports a count without a name cannot be acted on.
 *
 * THE FIX: the per-file output is CAPTURED (stdio defaults to "pipe" here) instead of streamed, a
 * header naming the file is printed BEFORE it runs — so a hang still says which file is hanging —
 * every failing file is named with its exit code, its captured output is printed under a delimiter,
 * and it is written to a durable per-file log whose path is named. Passing files print nothing but
 * their header, which is what keeps the phase readable. `stdio` can still be passed explicitly
 * (the focused tests pass ["ignore","ignore","ignore"]).
 */
export function runSerialFiles(files, {
  timeoutMs = defaultSerialTimeoutMs(),
  perFileTimeoutMs = SERIAL_FILE_TIMEOUTS,
  stdio = "pipe",
  cwd = undefined,
  env = process.env,
} = {}) {
  const t0 = Date.now();
  /** @type {{ file: string, code: number, timedOut: boolean, secs: string, log: string|null }[]} */
  const failures = [];
  const logDir = serialLogDir();
  // (2) chrome-agent-platform-grj9: the durable per-file log directory is SHARED across worktrees
  // ($HOME/cap-evidence/serial-phase-logs), so a millisecond-resolution stamp alone let two runs
  // that failed the same file in the same millisecond write the same path and overwrite each
  // other's evidence — losing exactly what this cluster exists to preserve. The pid namespaces the
  // run; the millisecond stamp still orders runs within one process. (ulcw adds the per-process
  // counter: pid separates processes, the counter separates CALLS inside one process.)
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-p${process.pid}-r${++SERIAL_RUN_SEQ}`;

  for (const file of files) {
    const started = Date.now();
    // chrome-agent-platform-kj9s: ONE global window for every serial file was the mismatch that
    // made a handful of build-heavy files look like a capacity problem. A per-file bound (measured
    // work x a modest factor, see SERIAL_FILE_TIMEOUTS) is used where one exists; the base window
    // stays the fallback for every other file. The effective window is PRINTED when it differs, so
    // a reader never has to guess which bound a file ran under.
    const fileTimeoutMs = perFileTimeoutMs?.[file] ?? timeoutMs;
    console.log(`run-tests: serial file ${file}${fileTimeoutMs !== timeoutMs ? ` (per-file bound ${fileTimeoutMs / 1000}s)` : ""}`);
    const result = runSerialFile(file, { timeoutMs: fileTimeoutMs, stdio, cwd, env });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    // (1) chrome-agent-platform-grj9: an OS-level spawnSync failure (ENOENT when the runtime is
    // missing, EACCES, ENOBUFS when maxBuffer is exceeded) carries NO stdout and NO stderr — the
    // REASON lives in result.error. Without it the file was named with exit 1 and no explanation,
    // which is the unreadable-gate class this cluster exists to fix. stdout/stderr stay in their
    // order after the reason, so an ordinary failing test reads exactly as before.
    const spawnError = result.error ? `${result.error.stack ?? String(result.error)}\n` : "";
    const text = `${spawnError}${result.stdout?.toString?.() ?? ""}${result.stderr?.toString?.() ?? ""}`;

    if (result.code !== 0) {
      let log = null;
      if (logDir) {
        log = join(logDir, `${stamp}-${file.replaceAll("/", "_")}.log`);
        try {
          writeFileSync(log, text);
        } catch {
          log = null;
        }
      }
      failures.push({ file, code: result.code, timedOut: Boolean(result.timedOut), secs, log });
      // Named HERE as well as in the summary: the reader watching the log sees which file broke the
      // moment it breaks, instead of scrolling back to guess from a missing banner.
      announce(
        `\nrun-tests: serial file ${file} FAILED (exit ${result.code}${result.timedOut ? ", TIMED OUT" : ""}) in ${secs}s` +
          `${log ? ` — captured output: ${log}` : ""}`,
      );
      // The captured output stays on stderr: it is unbounded, and BOTH streams above name the
      // durable per-file log that holds it, so a stdout-only reader loses no attribution.
      if (text.trim()) console.error(text.replace(/\n$/, ""));
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const statusStr = failures.length === 0 ? "GREEN" : `FAILED (${failures.length}/${files.length} failed)`;
  // ulcw: the run id is printed WITH the count, so a reader can match this summary to exactly the
  // durable logs whose names carry the same id — the count and its evidence share one value.
  console.log(`\nrun-tests: serial phase (${files.length} build/artifact files) ${statusStr} in ${secs}s [run ${stamp}]`);

  if (failures.length > 0) {
    // THE WHOLE POINT (dsoq): a COUNT without a NAME cannot be acted on. This block is what a
    // landing gate must print, and tests/serial-phase-failure-attribution.test.ts fails if it stops.
    announce("run-tests: FAILING SERIAL FILE(S):");
    for (const f of failures) {
      announce(
        `  - ${f.file} (exit ${f.code}${f.timedOut ? ", TIMED OUT" : ""}) in ${f.secs}s` +
          `${f.log ? ` — log: ${f.log}` : ""}`,
      );
    }
  }

  return failures.length > 0 ? failures[0].code : 0;
}
