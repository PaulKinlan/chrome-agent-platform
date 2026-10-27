// scripts/lib/phase-outcome.mjs — what a test phase KILLED BY ITS OWN BOUND can honestly say about
// how far it got (chrome-agent-platform-jtrny).
//
// WHY THIS EXISTS: a full gate was read, by two agents, as "the suite COMPLETED (764 files, wall 2681s)
// and then something hung for 568s in a POST-TEST phase". Neither half was true. The parallel phase had
// been killed by its own 1800s bound with only 108 of 742 files reporting, and the completion-shaped
// line in the log was the PLANNER summary ("N files total … wall Xs"), printed after the phases whether
// or not any of them finished. The runner had no vocabulary for "I was killed, and here is how far I
// actually got", so nothing in the log could contradict the misreading.
//
// The one measurement that separates the two possible causes is already in the captured output: Deno's
// pretty reporter prints a line per COMPLETED test as
//   ./tests/x.test.ts => <test name> ... ok (12s)
// so the set of files that completed at least one test before the kill is recoverable. A run whose
// files mostly never completed anything did not hang on a tail — it was starved of CPU, or every worker
// was blocked. The report states the count as a fact and lets the reader draw that conclusion; it never
// asserts a cause it did not measure (a hang on N of the workers also leaves files with no result).
//
// A file that merely STARTED is not counted: Deno prints an in-progress line without a verdict and
// duration, and that is exactly the shape a hung test has — counting it would report "0 never started"
// for the one case the report exists to name.
//
// Pure on purpose: the honest shape of a kill report is unit-tested, so a later edit cannot quietly
// turn it back into "culprit unconfirmed" for all N files.

import { ENVIRONMENTAL_REFUSAL_EXIT } from "./environmental-verdict.mjs";

const ANSI_RE = /\x1b\[[0-9;]*[mGKH]/g;
// Mirrors the measured format facts in scripts/lib/parallel-durations.mjs: a STEP line carries two
// ` ... ` separators, so the verdict+duration must END the line. Anything else is in-progress output.
// The path is any `*.test.ts`, not only `tests/**`: a bounded probe or a scratch fixture is a real
// candidate of a real run, and a report that cannot see its result would call a finished file a culprit.
const COMPLETED_RE = /([^\s]+\.test\.ts) => (.*) \.\.\. (?:ok|FAILED|ignored) \(([^)]+)\)\s*$/u;

/** Candidate paths arrive as `tests/x.test.ts`; the reporter prints `./tests/x.test.ts`. One form. */
function normalizeTestPath(path) {
  return String(path ?? "").trim().replace(/^\.\//u, "");
}

/** Bound on the named no-result files: a starvation kill can leave hundreds, and a 600-line list is the
 *  noise that hid the count in the first place. The count itself is always reported in full. */
export const CANDIDATE_LIST_LIMIT = 40;

/**
 * The test files that COMPLETED at least one test in `output` (ANSI-tolerant, unmatched lines ignored —
 * a kill report must never be able to fail the gate that produced it).
 * @param {string} output
 * @returns {Set<string>} e.g. Set { "tests/agent-alarms.test.ts" }
 */
export function completedTestFiles(output) {
  const done = new Set();
  const text = String(output ?? "");
  if (!text) return done;
  for (const raw of text.split("\n")) {
    const line = raw.replace(ANSI_RE, "");
    const match = COMPLETED_RE.exec(line);
    if (match) done.add(normalizeTestPath(match[1]));
  }
  return done;
}

/**
 * Split the phase's candidate list by whether it produced a completed result.
 * @param {string[]} files candidates in the order they were scheduled
 * @param {string} output the phase's captured output at the moment of the kill
 * @returns {{completed: string[], noResult: string[]}}
 */
export function killProgress(files = [], output = "") {
  const done = completedTestFiles(output);
  const completed = [];
  const noResult = [];
  for (const file of files) (done.has(normalizeTestPath(file)) ? completed : noResult).push(file);
  return { completed, noResult };
}

/**
 * The progress line. States only what was measured: how many candidates completed a test, how many did
 * not, and how long the phase ran. Never a cause.
 * @param {{phase: string, files: string[], output: string, elapsedSecs: number}} args
 * @returns {string}
 */
export function killProgressLine({ phase, files = [], output = "", elapsedSecs = 0 }) {
  const { completed, noResult } = killProgress(files, output);
  const secs = Number.isFinite(elapsedSecs) ? Math.max(0, Math.round(elapsedSecs)) : 0;
  return (
    `run-tests: ${phase} progress at the kill: ${completed.length} of ${files.length} file(s) completed ` +
    `a test, ${noResult.length} produced no completed result (${secs}s elapsed)`
  );
}

/**
 * The candidate block for a kill. Named are the files with no completed result — the only thing the
 * output can say with evidence. When the list is bounded the truncation is disclosed with the exact
 * remainder.
 * @param {{phase: string, candidates: string[], total: number, limit?: number}} args
 * @returns {string[]}
 */
export function candidateBlockLines({ phase, candidates = [], total = 0, limit = CANDIDATE_LIST_LIMIT }) {
  const shown = candidates.slice(0, Math.max(0, limit));
  const lines = [
    `run-tests: TIMED-OUT ${String(phase).toUpperCase()} CANDIDATE FILE(S) (culprit unconfirmed; ` +
      `${candidates.length} of ${total} produced no completed result):`,
  ];
  for (const file of shown) lines.push(`  - ${file} (${phase} timed out; individual culprit unknown)`);
  const remainder = candidates.length - shown.length;
  if (remainder > 0) lines.push(`  … and ${remainder} more file(s) with no completed result (see the progress line)`);
  return lines;
}

/**
 * The suffix that stops a planner summary reading as a completion record. Empty when nothing was killed,
 * so an intact run's summary is byte-identical to what it always was.
 * @param {string[]} killedPhases one entry per killed phase, e.g. "parallel phase killed at its 1800s bound"
 * @returns {string}
 */
export function incompleteNote(killedPhases = []) {
  const named = (killedPhases ?? []).map((entry) => String(entry ?? "").trim()).filter(Boolean);
  return named.length ? ` — INCOMPLETE: ${named.join("; ")}` : "";
}

/**
 * The exit code for a run that did NOT complete the selection it made (chrome-agent-platform-5xg1w).
 * A serial-phase abort used to exit 1 — indistinguishable from a completed run that genuinely failed —
 * so a content-addressed gate cache filed the abort as a permanent FAIL for the tree. The repo already
 * has a vocabulary of distinct verdict codes (0 green, 1 product red, 75 environmental refusal, 124
 * bound kill); 76 is the fourth: "INCOMPLETE — files were selected but not run; this is not a verdict
 * on the tree". A consumer that has not learned 76 still sees non-zero, so it can never read as a pass.
 */
export const INCOMPLETE_EXIT = 76;

/** Exit codes that already tell a consumer "unknown / do not cache a verdict"; 76 must not mask them. */
export const BOUND_KILL_EXIT_CODES = new Set([124, 137, 143]);

/**
 * The exit code a run must exit with, given what it failed to run (chrome-agent-platform-5xg1w).
 * Pure, so the precedence is unit-tested rather than inferred from a seven-minute gate:
 *   - a run that skipped nothing and had no killed phase keeps its rc byte-for-byte (a completed
 *     FAIL stays 1; a completed green stays 0);
 *   - a bound-kill rc (124/137/143) or an environmental refusal (75) keeps its code: those already
 *     carry "not a product verdict" to every existing consumer, and 76 would erase that signal;
 *   - any other rc on an incomplete run (gaps = selected files not run, or a killed phase) becomes
 *     INCOMPLETE_EXIT, including the w6kc0 forced-red case where every phase that ran exited 0.
 *
 * @param {number} rc the combined phase exit code (pre-mapping)
 * @param {{ gaps?: string[], killedPhases?: string[] }} evidence
 * @returns {number} the exit code the runner must use
 */
export function incompleteRunExit(rc, { gaps = [], killedPhases = [] } = {}) {
  const incomplete = (Array.isArray(gaps) && gaps.length > 0) ||
    (Array.isArray(killedPhases) && killedPhases.length > 0);
  if (!incomplete) return rc;
  if (BOUND_KILL_EXIT_CODES.has(rc) || rc === ENVIRONMENTAL_REFUSAL_EXIT) return rc;
  return INCOMPLETE_EXIT;
}
