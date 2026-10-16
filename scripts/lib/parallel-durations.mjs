// scripts/lib/parallel-durations.mjs — per-file durations recovered from the
// parallel phase's own output (chrome-agent-platform-6gk81).
//
// Deno's pretty reporter already prints one line per finished test in
// --parallel mode:
//
//   ./tests/x.test.ts => <test name> ... ok (12s)
//
// Summing those lines per file gives the file's test-seconds: the quantity
// longest-first scheduling (scripts/lib/parallel-schedule.mjs) orders by, and
// the quantity whose absence left the heaviest file in the suite
// (tests/python-documents-bundle-3p3e11.test.ts, 95s in the 2026-10-16 FULL
// log) unweighted and finishing last. This module is the ONE parser: the
// runner uses it to publish durations into the gate manifest, and
// scripts/update-test-weights.mjs uses it to re-derive
// scripts/lib/test-weights.json from a gate log.
//
// MEASURED FORMAT FACTS (tree 55876826 FULL log, 2026-10-16): result lines
// numbered exactly 6883 = 6671 passed + 2 ignored + 121 steps (parallel
// phase) + 89 passed (post-build read-only phase). A STEP line carries TWO
// ` ... ` separators (`<test> ... <step> ... ok (1ms)`); the parent test's own
// line carries the total, so step lines are skipped or their seconds would be
// counted twice. Residue, stated plainly: a test NAME containing the literal
// ` ... ` would be misread as a step and dropped — the exact 121 count proves
// no current test name does. `----- output -----` interleave lines never end
// in a verdict + duration, so they cannot match.
//
// A duration sum is TEST-seconds, not file wall time: module load and the
// type-check ("Check") pass are not in it. That is the right input for
// ordering (it is the part that occupies a worker), and the manifest names it
// as measured from the reporter's own per-test durations.

const RESULT_RE = /^\.\/(tests\/[^\s]+\.test\.ts) => (.*) \.\.\. (?:ok|FAILED|ignored) \(([^)]+)\)\s*$/;
const ANSI_RE = /\x1b\[[0-9;]*[mGKH]/g;

/**
 * Deno's duration spellings -> seconds. Observed: `330µs`, `3ms`, `12s`,
 * `3m56s`; a bare `2m` and fractional seconds are accepted defensively.
 * Anything else is null (never a guess).
 * @param {string} text
 * @returns {number | null}
 */
export function parseDenoDuration(text) {
  const s = String(text ?? "").trim();
  let m = /^(\d+(?:\.\d+)?)(µs|us)$/.exec(s);
  if (m) return Number(m[1]) / 1e6;
  m = /^(\d+(?:\.\d+)?)ms$/.exec(s);
  if (m) return Number(m[1]) / 1e3;
  m = /^(?:(\d+)m)?(\d+(?:\.\d+)?)s$/.exec(s);
  if (m) return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  m = /^(\d+)m$/.exec(s);
  if (m) return Number(m[1]) * 60;
  return null;
}

/**
 * Sum per-test durations per suite file from captured `deno test --parallel`
 * output (ANSI tolerated). Pure: unknown lines are ignored, never an error —
 * a duration ledger must not be able to fail the gate that produced it.
 * @param {string} output
 * @returns {Map<string, number>} file -> test-seconds
 */
export function parseSuiteDurations(output) {
  const totals = new Map();
  const clean = String(output ?? "").replace(ANSI_RE, "");
  for (const line of clean.split("\n")) {
    const m = RESULT_RE.exec(line);
    if (!m) continue;
    // A step line (`<test> ... <step> ... ok`) — the parent line has the total.
    if (m[2].includes(" ... ")) continue;
    const secs = parseDenoDuration(m[3]);
    if (secs === null) continue;
    totals.set(m[1], (totals.get(m[1]) ?? 0) + secs);
  }
  return totals;
}

/**
 * The `n` slowest suites, heaviest first, seconds rounded to 0.1 (the
 * reporter's own resolution below 1s is finer than scheduling can use).
 * Ties break by file name so the output is deterministic.
 * @param {Map<string, number> | Record<string, number>} durations
 * @param {number} n
 * @returns {Array<{ file: string, secs: number }>}
 */
export function slowestSuites(durations, n = 20) {
  const entries = durations instanceof Map ? [...durations.entries()] : Object.entries(durations ?? {});
  return entries
    .filter(([, secs]) => Number.isFinite(secs) && secs >= 0)
    .map(([file, secs]) => ({ file, secs: Math.round(secs * 10) / 10 }))
    .sort((a, b) => (b.secs - a.secs) || a.file.localeCompare(b.file, "en"))
    .slice(0, Math.max(0, n));
}

/**
 * Manifest-ready durations object: `{file: secs}` with sorted keys and 0.1s
 * rounding. Entries that are not finite non-negative numbers are DROPPED, not
 * thrown on — this runs after the suite, where throwing would convert a
 * finished gate into a runner crash.
 * @param {Map<string, number> | Record<string, number>} durations
 * @returns {Record<string, number>}
 */
export function suiteDurationsObject(durations) {
  const entries = durations instanceof Map ? [...durations.entries()] : Object.entries(durations ?? {});
  const out = {};
  for (const [file, secs] of entries.sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (typeof file !== "string" || !file.startsWith("tests/")) continue;
    if (!Number.isFinite(secs) || secs < 0) continue;
    out[file] = Math.round(secs * 10) / 10;
  }
  return out;
}
