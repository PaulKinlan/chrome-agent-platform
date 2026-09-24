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
// chrome-agent-platform-4zp3: the words that ACTUALLY leaked into a shipped
// entry ("correct my own capability claim — NO pinned adapter implements
// client-hosted MCP") are in the alternation now. The phrases that never
// legitimately appear (fleet-internal architecture shorthand) are banned;
// \bMCP\b is deliberately absent (five shipped entries use it as product
// vocabulary — see tests/changelog.test.ts 4zp3 for the measured policy).
const JARGON_RE = /journey|KAT|assertion|CDP|harness|worktree|lane|tracker|splice|capability claim|pinned adapter|client-hosted/i;
const GATE_STATE_RE = /\b(RED|GREEN)\b/;
const WORKFLOW_RE = /\blanded\b|in review|in progress|recorded as|\bclaimed\b/i;
// First-person engineering prose is the author's voice, never the reader's
// (chrome-agent-platform-4zp3): the leaked sentence began "correct my own…".
// \bI\b excludes "I/O" (a real technical term that must stay user-facing).
const FIRST_PERSON_RE = /\b(?:my|myself|mine|we|our|ours|us)\b|\bI\b(?!\s*\/)/i;
// The same joiner class scripts/bump-version.mjs strips from a subject (y6z6):
// a bullet still starting with one, followed by whitespace or nothing, is a leak.
const LEAKED_JOINER_RE = /^[+&:;,./|—–-]+(?:\s|$)/;

export function isInternalEntry(text) {
  return INTERNAL_MARKER_RE.test(String(text).trim());
}

// The rejection rules in EXACTLY the order isUserFacingEntry has always
// applied them — the explain view must never disagree with the boolean.
const REJECTION_RULES = [
  { name: "INTERNAL_MARKER_RE", why: "declared internal (leading 'internal:')", re: INTERNAL_MARKER_RE },
  { name: "LEAKED_JOINER_RE", why: "a leading joiner-punctuation leak", re: LEAKED_JOINER_RE },
  { name: "ENGINEERING_PREFIX_RE", why: "a conventional commit prefix", re: ENGINEERING_PREFIX_RE },
  { name: "SHA_RE", why: "a bare git SHA", re: SHA_RE },
  { name: "JARGON_RE", why: "internal vocabulary (jargon)", re: JARGON_RE },
  { name: "GATE_STATE_RE", why: "a RED/GREEN gate-state word", re: GATE_STATE_RE },
  { name: "WORKFLOW_RE", why: "a workflow-status word (landed / in review / in progress / recorded as / claimed)", re: WORKFLOW_RE },
  { name: "FIRST_PERSON_RE", why: "first-person engineering prose (mark the note 'internal:' instead)", re: FIRST_PERSON_RE },
];

/**
 * chrome-agent-platform-smxw: WHY an entry was rejected, not just that it was.
 * Returns `{ ok: true }` for user-facing copy, or
 * `{ ok: false, rule, why, token }` naming the FIRST rule that matched and the
 * exact token it matched (e.g. rule JARGON_RE, token "harness"). The rules and
 * their order are identical to isUserFacingEntry — same list, same sequence.
 * @param {unknown} text
 * @returns {{ ok: true } | { ok: false, rule: string, why: string, token: string }}
 */
export function explainUserFacingEntry(text) {
  const line = String(text).trim();
  for (const rule of REJECTION_RULES) {
    const m = rule.re.exec(line);
    if (m) return { ok: false, rule: rule.name, why: rule.why, token: m[0] };
  }
  return { ok: true };
}

export function isUserFacingEntry(text) {
  return explainUserFacingEntry(text).ok;
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
