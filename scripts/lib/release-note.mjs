// scripts/lib/release-note.mjs — how a commit tells the project what the user
// gets: the `Release-note:` trailer extraction and the note sanitiser, extracted
// from scripts/bump-version.mjs for chrome-agent-platform-2h4j7 so the merger's
// release stamp and the lane's pre-flight gate (scripts/check-release-note-
// preflight.mjs) share ONE implementation. A second copy of either rule is how
// two gates drift apart — the filter module header in
// extension/options/changelog-filter.js records what that cost (three published
// `internal:` notes and a burned version).

import { execFileSync } from "node:child_process";

/** Every `Release-note:` trailer in a commit body (bump-version.mjs's landing
 *  mode reads exactly these). */
export function releaseNoteTrailers(body) {
  return [...String(body ?? "").matchAll(/^Release-note:\s*(.*)$/gim)].map((match) => match[1]);
}

/** The same notes as GIT ITSELF reads them — `git interpret-trailers --parse`,
 *  the parser behind `%(trailers)` and every trailer-aware tool.
 *
 *  Two views of one fact, and they do not agree (chrome-agent-platform-g0bfz):
 *  the grep above finds a `Release-note:` line ANYWHERE in the message, while
 *  git only reads a TRAILER BLOCK at the end — after a blank line, nothing but
 *  trailers after it, single-line values. Measured on the fleet's own commits:
 *  a note in the SUBJECT (gzkmx) and a note in the MIDDLE of a body (0740d9df0,
 *  where `grep -n -i release-note` finds it at line 44) both satisfy the stamp
 *  and are invisible to `git log --format=%(trailers)`. A WRAPPED value is
 *  dropped by git entirely (measured: `Release-note: one line\nand continues`
 *  parses to nothing) while the grep view keeps the truncated first line.
 *
 *  Returns the parsed values, or null when git cannot answer at all — a caller
 *  must treat null as "no verdict", never as "no note". */
export function trailerParserNotes(body) {
  try {
    const parsed = execFileSync("git", ["interpret-trailers", "--parse"], {
      input: String(body ?? ""),
      encoding: "utf8",
    });
    return [...parsed.matchAll(/^Release-note:\s*(.*)$/gim)].map((match) => match[1]);
  } catch {
    return null;
  }
}

/** Why a note the release stamp accepts is invisible to git's trailer parser,
 *  or an empty list when the two views agree (or git cannot answer).
 *
 *  The message names the SHAPE, not just the disagreement: the natural mistake
 *  is a note written as the commit SUBJECT, which is what both sightings did,
 *  and a refusal that explains the shape costs one edit instead of an
 *  investigation at landing time. */
export function releaseNoteShapeProblems(body) {
  const grepped = releaseNoteTrailers(body);
  if (!grepped.length) return [];
  const parsed = trailerParserNotes(body);
  if (parsed === null) return [];
  if (parsed.length === grepped.length && parsed.every((note, i) => note.trim() === grepped[i].trim())) return [];
  return [
    `the release stamp reads ${grepped.length} Release-note line(s) ` +
    `(${grepped.map((note) => JSON.stringify(note.trim().slice(0, 48))).join(", ")}) ` +
    `but git's trailer parser reads ${parsed.length} — so the note exists for the stamp and does not exist for ` +
    `\`git log --format=%(trailers)\`, fleet-land-message, or any other trailer-aware tool. ` +
    `The accepted shape is a TRAILER BLOCK at the END of the message: a blank line, then one ` +
    `single-line \`Release-note: <what the user gets>\`, with nothing after it. A note in the ` +
    `SUBJECT or in the MIDDLE of the body is accepted-and-invisible; a WRAPPED value is dropped ` +
    `by git entirely.`,
  ];
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
