// extension/options/changelog-filter.js — the single source of truth for what
// counts as a user-facing changelog bullet, and how a changelog partitions into
// the "recent, readable" five and "everything else".
//
// Imported by:
//   - extension/options/options.js (the About renderer)
//   - tests/changelog.test.ts (unit tests pin the rules)
//   - scripts/check-changelog.mjs (the release gate)
//
// No DOM, no chrome.*, no side effects — safe under Deno and Node so the test
// and the gate exercise the SAME implementation the renderer ships.
//
// A bullet is user-facing unless it reads like an engineering log line:
//   - a conventional commit prefix (merge:/chore:/fix(...):/test:/ci:/docs:)
//   - a bare git SHA
//   - the project's internal vocabularies (journeys, KAT, CDP, harnesses,
//     worktrees, lanes, trackers, RED/GREEN gates, merge splices)
//   - a workflow-status word (landed, in review, in progress, recorded as,
//     claimed) — "what happened in the tracker" is not "what changed for me".
//   - a leading run of joiner punctuation ("+ : the change", ": merge — …"):
//     what is left of a multi-task commit subject once its ids are stripped
//     (chrome-agent-platform-p7k4). Punctuation glued to a word is copy
//     ("/folder work …", "(Beta) …", "…and") and stays.

const ENGINEERING_PREFIX_RE = /^(merge|chore|fix|test|ci|docs)(\([^)]*\))?:/i;
// A bullet may DECLARE itself an internal note. Deliberate and explicit, never
// inferred: some commits record work with no user-visible change at all (a
// rationale corrected, measurements taken). 0.3.446 and 0.3.448 are those, and
// before this marker the gate required every modern bullet to read as
// user-facing — so the writer had to invent a sentence for a change no reader
// could observe. Marked bullets are hidden from the readable list by
// partitionChangelog and stay readable under Show all.
//
// TWO RESIDUAL RISKS, stated because the marker is a trust decision and not a
// verification, and neither is caught by anything in this repo:
//   1. A bullet that SHOULD be marked and is not still passes the filter if it
//      reads as user-facing. The marker suppresses; its absence never accuses.
//      An engineering note phrased in plain words ships to readers.
//   2. The marker can hide real user-facing copy, and nothing notices. `internal:`
//      on a bullet describing a genuine change removes it from the readable five
//      with no gate objecting — the failure is silent by construction, because
//      the point of the marker is that nobody has to justify it.
// Both are the accepted cost of not inferring intent. If either starts biting, the
// fix is a review convention or a second signal, not a guess at the writer's meaning.
const INTERNAL_MARKER_RE = /^internal:/i;
const SHA_RE = /\b[0-9a-f]{7,40}\b/i;
const JARGON_RE = /journey|KAT|assertion|CDP|harness|worktree|lane|tracker|splice/i;
const GATE_STATE_RE = /\b(RED|GREEN)\b/;
const WORKFLOW_RE = /\blanded\b|in review|in progress|recorded as|\bclaimed\b/i;
// The same joiner class scripts/bump-version.mjs strips from a subject (y6z6):
// a bullet still starting with one, followed by whitespace or nothing, is a leak.
const LEAKED_JOINER_RE = /^[+&:;,./|—–-]+(?:\s|$)/;

export function isInternalEntry(text) {
  return INTERNAL_MARKER_RE.test(String(text).trim());
}

export function isUserFacingEntry(text) {
  const line = String(text).trim();
  if (isInternalEntry(line)) return false;
  if (LEAKED_JOINER_RE.test(line)) return false;
  if (ENGINEERING_PREFIX_RE.test(line)) return false;
  if (SHA_RE.test(line)) return false;
  if (JARGON_RE.test(line)) return false;
  if (GATE_STATE_RE.test(line)) return false;
  if (WORKFLOW_RE.test(line)) return false;
  return true;
}

/** Parse a CHANGELOG.md body into [{ version, date, bullets }]. */
export function parseChangelog(md) {
  const lines = String(md).split(/\r?\n/);
  const versions = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^##\s+\[([^\]]+)\]\s*—?\s*(.*)$/);
    if (h) {
      current = { version: h[1].trim(), date: h[2].trim(), bullets: [] };
      versions.push(current);
      continue;
    }
    if (current && line.startsWith("- ")) {
      current.bullets.push(line.slice(2).trim());
    }
  }
  return versions;
}

/**
 * Partition a changelog into the up-front "recent" entries and the "rest".
 *
 * recent: the first `limit` versions that have at least one user-facing bullet,
 * each carrying ONLY its user-facing bullets. Internal bullets are dropped from
 * `recent` and are NOT counted anywhere in the returned shape — a version whose
 * bullets are all internal falls through to `rest` with its full unfiltered text.
 *
 * rest (the Show-all complement): EXACTLY the entries that were NOT shown up
 * front — a version that made the visible five never reappears here, even for
 * bullets the filter hid. Non-shown versions carry their FULL unfiltered text.
 * Invariant: visible set ∩ show-all set = ∅ (no version appears in both).
 */
export function partitionChangelog(md, { limit = 5 } = {}) {
  const versions = parseChangelog(md);
  const recent = [];
  const rest = [];
  for (const v of versions) {
    if (v.bullets.length === 0) continue;
    const visible = v.bullets.filter(isUserFacingEntry);
    if (visible.length > 0 && recent.length < limit) {
      recent.push({ version: v.version, date: v.date, bullets: visible });
    } else {
      rest.push({ version: v.version, date: v.date, bullets: v.bullets });
    }
  }
  return { recent, rest };
}
