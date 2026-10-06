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

/** The always-on files that are also in this run's parallel set. */
export function guardSubset(parallel, alwaysOn) {
  const on = new Set(alwaysOn);
  return parallel.filter((f) => on.has(f));
}

/**
 * @param {{ serialRc: number, parallel: string[], alwaysOn: string[] }} args
 * @returns {{ files: string[], skipped: number, announce: string|null }}
 *   files    — the parallel files to run
 *   skipped  — how many parallel files this run does NOT execute
 *   announce — a line to print when files were skipped, else null
 */
export function parallelPlan({ serialRc, parallel, alwaysOn }) {
  if (serialRc === 0) return { files: parallel, skipped: 0, announce: null };
  const files = guardSubset(parallel, alwaysOn);
  return {
    files,
    skipped: parallel.length - files.length,
    announce:
      `run-tests: the serial phase failed, so ${parallel.length - files.length} of ${parallel.length} ` +
      `parallel file(s) are SKIPPED — except the ALWAYS-ON GUARD SET (${files.length} file(s)), which ` +
      `runs regardless, because a guard result must never be conditional on an unrelated phase passing.`,
  };
}
