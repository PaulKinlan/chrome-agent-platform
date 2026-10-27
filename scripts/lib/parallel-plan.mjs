// scripts/lib/parallel-plan.mjs — which parallel files a test run executes, and what it says about
// what it skipped (chrome-agent-platform-kz27).
//
// THE DEFECT THIS ENCODES: run-tests.mjs ran the parallel phase only when the serial phase was green
// (`if (rc === 0) rc = runParallel(parallel)`), so ONE serial failure skipped ~500 parallel files —
// and the always-on guards live in the parallel set. Measured cost: two guard violations reached main
// from one landing while its full-suite gate reported the guards green, because the guards never ran.
//
// THE RULE: a guard result must never be conditional on an unrelated phase passing.
//
// 0o0um/5xg1w UPGRADE: kz27's first compromise ran only the 48-file guard subset after a serial
// failure and skipped the other ~711 files. That turned ONE serial death (an assertion, or a driver
// OOM-killed with SIGKILL — not even a product red) into an unadjudicable gate record: 94% of the
// evidence never ran, yet the run was indistinguishable from a completed FAIL, and a content-addressed
// cache filed it against the tree permanently. A serial death is a finding about ONE file, not a
// licence to skip the rest — so a failed serial phase now STILL RUNS the parallel phase in full, and
// the run is a COMPLETED verdict (red on the serial failure, with every parallel result known).
// The skip vocabulary below (skipped/gaps/INCOMPLETE) survives only for runs that genuinely cannot
// continue: test seams and phases killed by their bounds.
//
// Pure on purpose: the acceptance is about which files run in which state, so it is unit-tested
// rather than inferred from the shape of a print statement in a script.

import os from "node:os";
import { ENVIRONMENTAL_REFUSAL_EXIT } from "./environmental-verdict.mjs";

export const DEFAULT_PARALLEL_TIMEOUT_MS = 1800_000;

/**
 * Computes a concurrency- and file-count-adaptive parallel phase timeout
 * (chrome-agent-platform-877x1).
 *
 * Sizing adapts to available parallelism:
 * On 2-vCPU machines (nproc=2), Deno default concurrency is 2 workers;
 * running ~550+ files requires >1000 CPU-seconds (>600s wall time). A flat bound
 * risks timing out by construction under lower core counts or growing suites.
 *
 * @param {number} filesCount - Number of test files to execute in parallel
 * @param {object} [options]
 * @param {number} [options.cpus] - Available concurrency (defaults to os.availableParallelism or cpus.length)
 * @param {string|number} [options.envTimeout] - Explicit timeout override from env
 * @param {boolean} [options.ignoreEnv] - Whether to ignore process.env overrides
 * @param {number} [options.msPerFile] - Estimated CPU budget per file (default 5000ms: ~2.5s work + 2x margin)
 * @param {number} [options.baselineMs] - Baseline floor for isolate spin-up and long test tail (default 120,000ms)
 * @param {number} [options.minMs] - Minimum timeout floor (default DEFAULT_PARALLEL_TIMEOUT_MS = 1,800,000ms)
 * @returns {number} Timeout in milliseconds
 */
export function computeParallelPhaseTimeout(filesCount, options = {}) {
  let envVal;
  if ("envTimeout" in options) {
    envVal = options.envTimeout;
  } else if (!options.ignoreEnv) {
    envVal = process.env.CAP_PARALLEL_TEST_TIMEOUT_MS;
  }
  if (envVal !== undefined && envVal !== null && envVal !== "") {
    const parsed = Number(envVal);
    if (Number.isFinite(parsed)) {
      if (parsed <= 0) return 0; // Explicit 0/negative disables the timeout (pre-delta escape hatch; bzk6g)
      return parsed;
    }
  }
  const cpus = options.cpus ?? (typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length) ?? 1;
  const count = typeof filesCount === "number" && Number.isFinite(filesCount) && filesCount > 0 ? filesCount : 0;
  const msPerFile = options.msPerFile ?? 5_000;
  const baselineMs = options.baselineMs ?? 120_000;
  const scaledMs = Math.ceil(baselineMs + (count * msPerFile) / Math.max(1, cpus));
  const minMs = options.minMs ?? DEFAULT_PARALLEL_TIMEOUT_MS;
  return Math.max(minMs, scaledMs);
}

/** The always-on files that are also in this run's parallel set. Kept as the intersection primitive
 *  select-tests and the unit tests use; the failure plan no longer narrows to it (0o0um/5xg1w). */
export function guardSubset(parallel, alwaysOn) {
  const on = new Set(alwaysOn);
  return parallel.filter((f) => on.has(f));
}

/**
 * @param {{ serialRc: number, parallel: string[], alwaysOn: string[], failingFiles?: string[] }} args
 * @returns {{ files: string[], skipped: number, incomplete?: boolean, announce: string|null }}
 *   files    — the parallel files to run
 *   skipped  — how many parallel files this run does NOT execute
 *   incomplete — true when files were SKIPPED, i.e. the run cannot certify the tree (w6kc0)
 *   announce — a line to print when files were skipped or refusal occurred, else null
 */
export function parallelPlan({ serialRc, parallel, alwaysOn, failingFiles = [] }) {
  if (serialRc === 0) return { files: parallel, skipped: 0, announce: null };
  if (serialRc === ENVIRONMENTAL_REFUSAL_EXIT) {
    return {
      files: parallel,
      skipped: 0,
      announce:
        `run-tests: the serial phase was REFUSED (environmental verdict, exit ${ENVIRONMENTAL_REFUSAL_EXIT}) — ` +
        `running the full parallel phase (${parallel.length} file(s)) with the refusal stated; never quietly skipping files on environmental contention.`,
    };
  }
  const names = Array.isArray(failingFiles) && failingFiles.length > 0
    ? ` [${failingFiles.join(", ")}]`
    : "";
  // chrome-agent-platform-0o0um/5xg1w: the serial failure no longer narrows the parallel set. The old
  // guard-subset compromise (kz27) skipped ~711 of 759 files and the gate record could not tell a
  // consumer which of them would have gone red — unadjudicable evidence, filed as a permanent FAIL
  // against a content-addressed tree. Now every selected file runs, the serial failure STILL decides
  // the verdict (combinePhaseExitCodes keeps it red), and the announcement says so. Nothing is
  // skipped, so there is no INCOMPLETE gap on this route: a completed red IS a verdict on the tree.
  return {
    files: parallel,
    skipped: 0,
    announce:
      `run-tests: serial file(s) failed${names} — the parallel phase STILL RUNS in full ` +
      `(${parallel.length} file(s)): a serial death is a finding about one file, not a licence to skip ` +
      `the others. The gate stays RED on the serial failure; every parallel result below is real ` +
      `evidence, and this run is a COMPLETED verdict, not an abort.`,
  };
}

/**
 * The certification gaps a plan implies (chrome-agent-platform-w6kc0). A run that skipped files cannot be
 * a verdict on the tree, whatever its guard subset said, so the gaps are derived from the PLAN rather than
 * inferred from whichever exit code the phases happened to produce. Pure, so the falsifier is a unit test:
 * a failed serial phase yields a named gap with its count, a clean one yields none.
 *
 * @param {{ skipped?: number }} plan
 * @returns {string[]} empty when the run executed everything it selected
 */
export function certificationGaps(plan) {
  const skipped = Number(plan?.skipped ?? 0);
  if (!Number.isFinite(skipped) || skipped <= 0) return [];
  return [`parallel phase skipped after serial failure (${skipped} file(s) unrun)`];
}

