// scripts/lib/release-note.mjs — how a commit tells the project what the user
// gets: the `Release-note:` trailer extraction and the note sanitiser, extracted
// from scripts/bump-version.mjs for chrome-agent-platform-2h4j7 so the merger's
// release stamp and the lane's pre-flight gate (scripts/check-release-note-
// preflight.mjs) share ONE implementation. A second copy of either rule is how
// two gates drift apart — the filter module header in
// extension/options/changelog-filter.js records what that cost (three published
// `internal:` notes and a burned version).

/** Every `Release-note:` trailer in a commit body (bump-version.mjs's landing
 *  mode reads exactly these). */
export function releaseNoteTrailers(body) {
  return [...String(body ?? "").matchAll(/^Release-note:\s*(.*)$/gim)].map((match) => match[1]);
}

/** Release notes are for the person using the extension, not the VCS: strip
 *  conventional-commit prefixes, bare SHAs and CAP-FB tracker ids so the
 *  automated plain-language check (tests/changelog.test.ts) keeps passing no
 *  matter what the commit subject said (CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01 follow-through). */
export const sanitizeEntry = (note) => String(note)
  .replace(/^(merge|chore|fix|test|ci|docs|tasks|feat|refactor)(?:\([^)]*\))?\s*:\s*/i, "")
  .replace(/^chrome-agent-platform-[a-z0-9.]+:?\s*/i, "")
  .replace(/\bchrome-agent-platform-[a-z0-9.]+\b/gi, "")
  .replace(/\(\s*[0-9a-f]{7,40}\s*\)/gi, "")
  .replace(/\[\s*CAP-FB-\d{8}-[A-Z0-9-]+\s*\]/gi, "")
  .replace(/\bCAP-FB-\d{8}-[A-Z0-9-]+\b/g, "")
  .replace(/\[\s*\]/g, "")
  .replace(/\b\w+ lane\b/gi, "work")
  .replace(/\bjourneys\b/gi, "checks")
  .replace(/\bjourney\b/gi, "check")
  .replace(/^\s*(Merge remote-tracking branch|Merge branch)\b.*$/i, "")
  .replace(/^\s*(cap-beads-|cap-|work-)[a-z0-9-]+\s*$/i, "")
  .replace(/\s{2,}/g, " ")
  .trim()
  // y6z6: a subject that closes several beads at once ("<id> + <id>: the
  // change") loses EVERY id to the strips above and keeps the joiner, so the
  // entry read "- + : the change". Drop a leading run of joiner punctuation —
  // but only when whitespace (or the end) follows it: "/folder work" is copy,
  // not a leaked joiner. A subject that is nothing but ids and joiners now
  // sanitizes to EMPTY, so skip-on-empty treats it as bookkeeping.
  .replace(/^(?:[+&:;,./|—–-]+(?:\s+|$))+/, "")
  .trim();
