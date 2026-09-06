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
const SHA_RE = /\b[0-9a-f]{7,40}\b/i;
const JARGON_RE = /journey|KAT|assertion|CDP|harness|worktree|lane|tracker|splice|\bRED\b|\bGREEN\b/i;
const WORKFLOW_RE = /\blanded\b|in review|in progress|recorded as|\bclaimed\b/i;
// The same joiner class scripts/bump-version.mjs strips from a subject (y6z6):
// a bullet still starting with one, followed by whitespace or nothing, is a leak.
const LEAKED_JOINER_RE = /^[+&:;,./|—–-]+(?:\s|$)/;

export function isUserFacingEntry(text) {
  const line = String(text).trim();
  if (LEAKED_JOINER_RE.test(line)) return false;
  if (ENGINEERING_PREFIX_RE.test(line)) return false;
  if (SHA_RE.test(line)) return false;
  if (JARGON_RE.test(line)) return false;
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
 * each carrying ONLY its user-facing bullets (plus how many internal bullets it
 * hides).
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
