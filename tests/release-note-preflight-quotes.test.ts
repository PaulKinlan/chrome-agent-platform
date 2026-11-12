// tests/release-note-preflight-quotes.test.ts — chrome-agent-platform-vggt7
//
// THE DEFECT CLASS. The pre-flight exists to fail a lane EARLY with the same
// predicate bump-version applies at landing, and its reason strings justify
// themselves by QUOTING the refusal the author would otherwise hit at the end
// of a landing: 'bump-version refuses the landing: "…"'. A quote is a claim
// about another file's output, and nothing checked it — vggt7 found the
// filter branch quoting "note is not user-facing", a sentence bump-version has
// never printed (the real one is "landing note is empty or not user-facing").
// An author who trusts the quote greps for it, finds nothing, and concludes the
// pre-flight is wrong rather than the commit.
//
// WHAT THIS DRIVES. Every quoted refusal in the pre-flight must be findable,
// verbatim, in scripts/bump-version.mjs — the file that prints it. `<sha>`
// placeholders are honoured as the tool's own interpolations, so a quote may
// span a template hole; every static segment must still be present. The remedy
// for a failure is therefore a real sentence from a real tool, at the moment the
// author can still act on it.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const PREFLIGHT = `${ROOT}scripts/check-release-note-preflight.mjs`;
const BUMP_VERSION = `${ROOT}scripts/bump-version.mjs`;

/** Every `bump-version refuses …: "<refusal>"` claim in the pre-flight's reasons. */
function quotedRefusals(source: string, path: string): string[] {
  const quotes: string[] = [];
  // A claim often spans a JS string concatenation, so the gap between the claim
  // and its quote crosses backtick/`+` boundaries: match it, do not parse it.
  const claim = /bump-version refuses (?:the landing|it)\b[\s\S]{0,220}?"([^"]+)"/g;
  for (const m of source.matchAll(claim)) if (!quotes.includes(m[1])) quotes.push(m[1]);
  assert(quotes.length > 0, `${path} no longer quotes any bump-version refusal — this guard would pass vacuously`);
  return quotes;
}

/**
 * A quote read from SOURCE text carries the string concatenation that produced it
 * (`"…if ` + `it is…"`), and bump-version's own template literals carry `${sha}` holes
 * and line wrapping. Normalise both sides to single-spaced sentences with the holes
 * removed, then compare the remaining static segments.
 */
function normalise(text: string): string {
  return text
    .replace(/`\s*\+\s*`/g, "")
    .replace(/\$\{[^}]+\}/g, "<hole>")
    .replace(/\s+/g, " ")
    .trim();
}

/** The static segments of a quote, with `<sha>`-style template holes removed. */
function staticSegments(quote: string): string[] {
  return normalise(quote)
    .split(/<[a-z-]+>|<hole>/)
    .map((part) => part.trim())
    .filter((part) => part.length > 4);
}

Deno.test("vggt7: every refusal the pre-flight quotes is a sentence bump-version actually prints", async () => {
  const preflight = await Deno.readTextFile(PREFLIGHT);
  const bumpVersion = normalise(await Deno.readTextFile(BUMP_VERSION));

  const quotes = quotedRefusals(preflight, PREFLIGHT);
  assertEquals(quotes.length >= 3, true, `expected the three landing refusals to be quoted, got ${JSON.stringify(quotes)}`);

  const missing: string[] = [];
  for (const quote of quotes) {
    for (const segment of staticSegments(quote)) {
      if (!bumpVersion.includes(segment)) missing.push(`${JSON.stringify(segment)} (from "${quote}")`);
    }
  }
  assertEquals(
    missing,
    [],
    `the pre-flight quotes a refusal bump-version does not print. A quote is a claim about another ` +
      `file's output: either fix the quote to the sentence ${BUMP_VERSION} actually emits, or change ` +
      `that file in the same commit. Not found: ${missing.join("; ")}`,
  );
});

Deno.test("vggt7: the filter refusal quotes the LANDING sentence, not the hook's", async () => {
  // bump-version refuses a non-user-facing note twice with different words: the
  // landing path prints "landing note is empty or not user-facing" (:172) and
  // the hook path prints "changelog note … fails user-facing check" (:196). The
  // pre-flight predicts the LANDING, so it must quote the landing sentence —
  // asserting the specific string keeps a future edit from re-shelving the
  // wrong one behind a passing generic check above.
  const preflight = await Deno.readTextFile(PREFLIGHT);
  const filterBranch = preflight.slice(preflight.indexOf("explainUserFacingEntry(note)"));
  const reason = filterBranch.slice(0, filterBranch.indexOf("return { ok: true }"));
  assert(
    reason.includes('"landing note is empty or not user-facing"'),
    "the user-facing-filter refusal must quote bump-version's LANDING sentence",
  );
});
