// scripts/lib/parallel-plan.mjs — which parallel files a test run executes, and what it says about
// what it skipped (chrome-agent-platform-kz27).
//
// THE DEFECT THIS ENCODES: run-tests.mjs ran the parallel phase only when the serial phase was green
// (`if (rc === 0) rc = runParallel(parallel)`), so ONE serial failure skipped ~500 parallel files —
// and the always-on guards live in the parallel set. Measured cost: two guard violations reached main
// from one landing while its full-suite gate reported the guards green, because the guards never ran.
//
// THE RULE: a guard result must never be conditional on an unrelated phase passing. So a serial
// failure now still runs the always-on guard subset, and the run SAYS how much it skipped — a gate
// that cannot tell you what it ran is the other half of this bead's family.
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

/** The always-on files that are also in this run's parallel set. */
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
  const files = guardSubset(parallel, alwaysOn);
  const skipped = parallel.length - files.length;
  const names = Array.isArray(failingFiles) && failingFiles.length > 0
    ? ` [${failingFiles.join(", ")}]`
    : "";
  // chrome-agent-platform-w6kc0: the outcome must never read as a certification of the tree. The run is
  // INCOMPLETE in the marker a reader greps for, and it names the count, because "698 skipped" inside a
  // sentence was read past twice while the guard subset came back green.
  // The log contract keeps BOTH markers a reader greps for: SKIPPED (the historical wording this announcement
  // has always used, pinned by tests/parallel-plan.test.ts) and INCOMPLETE (the certification verdict w6kc0
  // added). Replacing one with the other silently changed the log contract; they say different things - what was
  // omitted, and what that means for the run.
  return {
    files,
    skipped,
    incomplete: true,
    announce:
      `run-tests: serial file(s) failed${names}, so ${skipped} of ${parallel.length} parallel file(s) are ` +
      `SKIPPED — except the ALWAYS-ON GUARD SET (${files.length} file(s)), which runs regardless, because a ` +
      `guard result must never be conditional on an unrelated phase passing. ` +
      `INCOMPLETE: the parallel phase was skipped after the serial failure (${skipped} file(s) unrun); this ` +
      `run CANNOT certify the tree.`,
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

