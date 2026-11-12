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
// pre-flight is wrong rather than the commit. The missing-trailer branch had
// the same shape from the other side: it quoted a truncated sentence whose real
// text carries the remedy ("… pass --internal <sha> explicitly if it is
// internal-only"), which is the part an author needs.
//
// WHY THIS DRIVES classifyCommit AND ALSO SWEEPS THE SOURCE. Driving the real
// function is what the author sees, and it puts this suite in the changed-file
// selector's import graph for scripts/check-release-note-preflight.mjs — the
// gate reported that file as an UNMAPPED changed file while the only other
// suite reached it through a spawned CLI, which the import graph cannot see.
// The sweep is the complement: a claim on a branch no fixture can reach would
// otherwise rot unnoticed.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import * as acorn from "npm:acorn@8";
import { classifyCommit } from "../scripts/check-release-note-preflight.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PREFLIGHT = `${ROOT}scripts/check-release-note-preflight.mjs`;
const BUMP_VERSION = `${ROOT}scripts/bump-version.mjs`;

/**
 * A quote read from SOURCE text carries the string concatenation that produced it
 * (`"…if ` + `it is…"`), and bump-version's own template literals carry `${sha}`
 * holes and line wrapping. Normalise both sides to single-spaced sentences with
 * the holes removed, then compare the remaining static segments.
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

/** The single refusal a reason quotes, or a failure naming what it printed instead. */
function quotedRefusal(reason: string): string {
  const quotes = [...reason.matchAll(/"([^"]{8,})"/g)].map((m) => m[1]);
  // The note itself is also quoted on the filter branch; the REFUSAL is the quote
  // that follows the 'bump-version refuses' claim.
  const afterClaim = reason.slice(reason.indexOf("bump-version refuses"));
  const m = /"([^"]{8,})"/.exec(afterClaim);
  assert(m, `a pre-flight refusal must quote the bump-version sentence it predicts: ${JSON.stringify(reason)}`);
  return m[1];
}

/**
 * The refusals bump-version EMITS — the argument text of its `console.error(...)` calls, not the
 * file's raw bytes. qm0pv: a source-substring check greened a mutant that replaced
 * `console.error("[bump-version] ERROR: …")` with `void ("[bump-version] ERROR: …")` — the sentence
 * was still in the file, and no longer printed. What is emitted is the claim a quote makes, so the
 * comparison is against call arguments.
 */
function emittedRefusals(source: string): string {
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "MemberExpression" &&
      node.callee.object?.name === "console" &&
      node.callee.property?.name === "error"
    ) {
      calls.push(source.slice(node.start, node.end));
    }
    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      walk(node[key]);
    }
  };
  walk(ast);
  assert(calls.length >= 3, `bump-version must still print its refusals through console.error; found ${calls.length} call(s)`);
  return normalise(calls.join("\n"));
}

function assertPrintedByBumpVersion(quote: string, bumpVersion: string, context: string) {
  const missing = staticSegments(quote).filter((segment) => !bumpVersion.includes(segment));
  assertEquals(
    missing,
    [],
    `${context}: the pre-flight quotes a refusal bump-version does not print. A quote is a claim about ` +
      `another file's output — either fix the quote to the sentence ${BUMP_VERSION} actually emits, or ` +
      `change that file in the same commit. Not found: ${missing.map((s) => JSON.stringify(s)).join("; ")}`,
  );
}

Deno.test("vggt7: each refusal classifyCommit prints is a sentence bump-version actually emits", async () => {
  const bumpVersion = emittedRefusals(await Deno.readTextFile(BUMP_VERSION));

  const cases: Array<{ what: string; commit: { files: string[]; body: string } }> = [
    // No trailer at all on a product path.
    { what: "missing trailer", commit: { files: ["extension/lib/x.js"], body: "no trailer here" } },
    // A trailer that sanitises to nothing.
    { what: "empty after sanitise", commit: { files: ["extension/lib/x.js"], body: "Release-note:   " } },
    // The self-declared internal form (refused verbatim, not by the filter).
    { what: "none: internal", commit: { files: ["extension/lib/x.js"], body: "Release-note: none: internal refactor" } },
    // A note the project's user-facing filter rejects — the vggt7 quote.
    {
      what: "filter rejection",
      commit: { files: ["extension/lib/x.js"], body: "Release-note: internal: rewrote the guard" },
    },
  ];

  const seen = new Set<string>();
  for (const { what, commit } of cases) {
    const result = classifyCommit(commit);
    assertEquals(result.ok, false, `${what}: expected a refusal, got a pass`);
    const quote = quotedRefusal((result as { reason: string }).reason);
    seen.add(quote);
    assertPrintedByBumpVersion(quote, bumpVersion, what);
  }
  // Non-vacuity: the four cases must reach at least three distinct refusals, or a
  // single branch would be certifying the whole file.
  assertEquals(seen.size >= 3, true, `expected >=3 distinct quoted refusals, got ${JSON.stringify([...seen])}`);
});

Deno.test("vggt7: no claim in the pre-flight is left unchecked, including unreachable branches", async () => {
  const preflight = await Deno.readTextFile(PREFLIGHT);
  const bumpVersion = emittedRefusals(await Deno.readTextFile(BUMP_VERSION));

  // A claim often spans a JS string concatenation, so the gap between the claim
  // and its quote crosses backtick/`+` boundaries: match it, do not parse it.
  const claim = /bump-version refuses (?:the landing|it)\b[\s\S]{0,220}?"([^"]+)"/g;
  const quotes = [...new Set([...preflight.matchAll(claim)].map((m) => m[1]))];
  assertEquals(quotes.length >= 3, true, `expected the landing refusals to be quoted, got ${JSON.stringify(quotes)}`);
  for (const quote of quotes) assertPrintedByBumpVersion(quote, bumpVersion, "source sweep");
});

Deno.test("vggt7: the filter refusal quotes the LANDING sentence, not the hook's", async () => {
  // bump-version refuses a non-user-facing note twice with different words: the
  // landing path prints "landing note is empty or not user-facing" (:172) and
  // the hook path prints "changelog note … fails user-facing check" (:196). The
  // pre-flight predicts the LANDING, so it must quote the landing sentence.
  const result = classifyCommit({ files: ["extension/lib/x.js"], body: "Release-note: internal: rewrote the guard" });
  assertEquals(result.ok, false);
  assert(
    (result as { reason: string }).reason.includes('"landing note is empty or not user-facing"'),
    "the user-facing-filter refusal must quote bump-version's LANDING sentence",
  );
});
