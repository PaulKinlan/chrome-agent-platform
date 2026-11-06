// tests/fs-grep-redos-bound.test.ts — chrome-agent-platform-coz19
//
// grep_files compiles a MODEL-SUPPLIED regex and matches it per line inside the
// privileged service worker, where V8 backtracks and one catastrophic re.test()
// is uninterruptible — a nested-quantifier pattern over a large line freezes
// every extension surface. These pins hold the interim bounds:
//   1. the syntactic complexity bound (regexComplexityViolation) refuses the
//      exponential classes and backreferences BEFORE compilation, and admits
//      the ordinary patterns grep actually needs;
//   2. grepFsGrant returns the actionable fs_grep_regex_too_complex refusal;
//   3. the content bounds (per-line cap, cumulative scan budget, wall-clock
//      deadline) contain the residue and are HONESTLY reported via regexBounds
//      + truncated — round 2: EVERY partial-result path sets truncated, and
//      the bound refuses adjacent unbounded quantifiers (a+a+), multiple
//      universal repetitions (.*a.*b) and >2 unbounded repetitions per branch
//      (\d+:\d+:\d+), after the review falsified round 1's claim that the
//      content bounds contain adjacent-quantifier polynomials: a+a+a+a+a+b
//      over one 8192-char line froze the real V8 matcher past a 5s timeout;
//   4. literal mode and admitted regex semantics are unchanged.
// The managed ReDoS-safe engine is tmdm (rregex); this is the interim.
// @ts-nocheck
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import {
  grepFsGrant,
  saveFsGrant,
  deleteFsGrant,
  regexComplexityViolation,
  MAX_REGEX_LINE_CHARS,
  MAX_REGEX_SCAN_CHARS,
  REGEX_MATCH_DEADLINE_MS,
} from "../extension/lib/fs-grants.js";

// --- self-contained in-memory handles (same shape as fs-tools.test.ts) --------
function fileHandle(name: string, content: string | Uint8Array) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    kind: "file",
    name,
    getFile: async () => ({
      name,
      size: bytes.byteLength,
      lastModified: 1700000000000,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }),
  };
}

function dirHandle(name: string, children: Record<string, any>) {
  const entries = Object.entries(children);
  return {
    kind: "directory",
    name,
    values: async function* () { for (const [, child] of entries) yield child; },
    getDirectoryHandle: async (childName: string) => {
      const found = children[childName];
      if (!found || found.kind !== "directory") throw new Error(`no directory ${childName}`);
      return found;
    },
  };
}

// --- 1. the syntactic bound ----------------------------------------------------

Deno.test("coz19: the complexity bound refuses the exponential classes and backreferences", () => {
  const refused = [
    "(a+)+b",        // the canonical freeze repro from the finding
    "(a*)*$",
    "(a|b)+",        // quantified alternation
    "(a|a)+",
    "([a-z]+)+",
    "(x(a|b)y)+",    // alternation nested one level deeper inside a quantified group
    "(\\d+)*",
    "x(?=(a+)+b)",   // exponential class inside an UNquantified lookahead — refused at any depth
    "(a+)+?",        // lazy suffix does not launder the nesting
    "(ab|c)*",
    "(a)(b)\\1",     // numeric backreference
    "(?<g>a)\\k<g>", // named backreference
    "(?:a+)+",       // non-capturing groups are groups too
  ];
  for (const pattern of refused) {
    const violation = regexComplexityViolation(pattern);
    assert(typeof violation === "string" && violation.length > 0, `must refuse: ${pattern}`);
  }
  // the freeze repro's refusal is actionable, not a bare no
  assertStringIncludes(String(regexComplexityViolation("(a+)+b")), "quantified group");
  assertStringIncludes(String(regexComplexityViolation("(a)\\1")), "backreference");
});

Deno.test("coz19: the complexity bound admits the patterns grep actually needs", () => {
  const admitted = [
    "needle",                 // plain literal-ish
    "\\d{2,4}",               // bounded quantifier on a class
    "[a-z]+",                 // quantified class (linear)
    "(ab)+",                  // quantified group with a quantifier-free body
    "foo(bar)?",              // optional quantifier-free group
    "^\\s*TODO(\\(|:)",       // anchors, classes, quantifier-free groups
    // round 2: "a+b+" moved to the REFUSED list — round 1 admitted adjacent
    // quantifiers as "polynomial, contained by the CONTENT bounds" and the
    // review falsified exactly that (a+a+a+a+a+b froze real V8 past a 5s
    // timeout on one 8192-char line: the line cap bounds the SUBJECT, not the
    // backtracking).
    "a|b|c",                  // top-level alternation (linear)
    "(?<=\\s)x",              // lookbehind with a quantifier-free body
    "\\(\\)",                 // escaped metacharacters
    "[()\\]]+",               // class containing group-ish characters
    "(?:ab)+",                // non-capturing, quantifier-free body
    "(?<name>ab)+",           // named group, quantifier-free body
    "err(or)?s{0,2}",
    // round-2 admissions: the shapes the strengthened bound must NOT break
    "a+b",                    // one unbounded repetition + a mandatory literal
    "foo.*bar",               // a single universal repetition between literals
    ".*",                     // a lone wildcard
    "[^}]+x",                 // one negated-class repetition (universal-ish) alone
    "\\d+:\\d+",              // two restricted repetitions, disjoint mandatory separator
    ".*x\\d+",                // universal + restricted separated by a literal (O(line²) worst case)
    "a+?b",                   // lazy modifier on a single repetition
    ".*?foo",                 // lazy single universal
    "\\d{1,3}\\d{2,4}x",      // BOUNDED adjacent repetitions are finite work
    "x{2,}",                  // one {n,} repetition
    "^(.*)$",                 // anchors around one universal repetition
  ];
  for (const pattern of admitted) {
    assertEquals(regexComplexityViolation(pattern), null, `must admit: ${pattern}`);
    // admitted patterns must also genuinely compile — the bound is not stricter
    // than RegExp itself in a way that would refuse valid syntax
    new RegExp(pattern);
  }
});

Deno.test("coz19: structural invalidity stays RegExp's job — the bound never misclassifies it as complexity", () => {
  // (fs-tools.test.ts pins the fs_grep_invalid_regex error for these; the bound
  // must admit them so compilation produces the genuine, more accurate error.)
  for (const pattern of ["(a", "a)", "[a-z", "\\"]) {
    assertEquals(regexComplexityViolation(pattern), null, `structural problem, not a complexity one: ${pattern}`);
    assertThrows(() => new RegExp(pattern), RegExp, undefined, `RegExp refuses: ${pattern}`);
  }
});

// --- 2/3/4. integration through grepFsGrant ------------------------------------

async function withTree(tree: Record<string, any>, fn: (grantId: string) => Promise<void>) {
  const grantId = `fsg_grep_redos_${crypto.randomUUID()}`;
  await saveFsGrant({ grantId, handle: dirHandle("project", tree), name: "project" });
  try {
    await fn(grantId);
  } finally {
    await deleteFsGrant(grantId);
  }
}

Deno.test("coz19: grepFsGrant refuses a catastrophic pattern with fs_grep_regex_too_complex — before compilation and before any scan", async () => {
  await withTree({ "a.txt": fileHandle("a.txt", "a".repeat(50) + "\nplain line") }, async (grantId) => {
    const res: any = await grepFsGrant(grantId, { query: "(a+)+b", regex: true });
    assertEquals(res.ok, false);
    assertEquals(res.error, "fs_grep_regex_too_complex");
    assertStringIncludes(String(res.detail), "quantified group");
    // an INVALID-but-also-catastrophic pattern must still report the complexity
    // refusal — proof the bound runs BEFORE new RegExp (ordering, not luck)
    const both: any = await grepFsGrant(grantId, { query: "(a+)+b(", regex: true });
    assertEquals(both.error, "fs_grep_regex_too_complex", "the bound fires before RegExp compilation");
  });
});

Deno.test("coz19: admitted regex mode still matches normally, and reports regexBounds", async () => {
  await withTree({ "code.js": fileHandle("code.js", "const x = 1;\nababab end\nnope") }, async (grantId) => {
    const res: any = await grepFsGrant(grantId, { query: "(ab)+", regex: true });
    assertEquals(res.ok, true);
    assertEquals(res.matches.length, 1);
    assertEquals(res.matches[0].line, 2);
    assert(res.regexBounds, "regex mode reports its bounds honestly");
    assertEquals(res.regexBounds.skippedLongLines, 0);
    assertEquals(res.regexBounds.scanBudgetHit, false);
    assert(res.regexBounds.charsTested > 0, "charsTested counts what the matcher saw");
  });
});

Deno.test("coz19: literal mode is untouched — no bounds object, same semantics", async () => {
  await withTree({ "a.txt": fileHandle("a.txt", "the needle is here\nsecond") }, async (grantId) => {
    const res: any = await grepFsGrant(grantId, { query: "needle" });
    assertEquals(res.ok, true);
    assertEquals(res.matches.length, 1);
    assertEquals(res.regexBounds, undefined, "literal mode carries no regex bounds (it cannot ReDoS)");
  });
});

Deno.test("coz19: lines longer than MAX_REGEX_LINE_CHARS are SKIPPED and counted, never silently", async () => {
  const longLine = "x".repeat(MAX_REGEX_LINE_CHARS + 1);
  await withTree({ "big.txt": fileHandle("big.txt", `${longLine}\nshort match me\n${longLine}`) }, async (grantId) => {
    const res: any = await grepFsGrant(grantId, { query: "match", regex: true });
    assertEquals(res.ok, true);
    assertEquals(res.matches.length, 1, "the short line still matches");
    assertEquals(res.regexBounds.skippedLongLines, 2, "both long lines are counted");
    assertEquals(res.truncated, true, "round 2 (review): a skipped long line IS a partial result — the field the model reads must say so");
  });
});

Deno.test("coz19: the cumulative scan budget stops the walk with truncated + scanBudgetHit, never a silent drop", async () => {
  // ~1.25x the budget in short-enough lines: the scan must stop partway and say so.
  const lineCount = Math.ceil((MAX_REGEX_SCAN_CHARS * 1.25) / 1001);
  const content = Array.from({ length: lineCount }, () => "a".repeat(1000)).join("\n");
  await withTree({ "huge.txt": fileHandle("huge.txt", content) }, async (grantId) => {
    const res: any = await grepFsGrant(grantId, { query: "zzz-no-match", regex: true });
    assertEquals(res.ok, true);
    assertEquals(res.matches.length, 0);
    assertEquals(res.truncated, true, "the budget hit sets the EXISTING truncated flag");
    assertEquals(res.regexBounds.scanBudgetHit, true, "and names itself in regexBounds");
    assert(res.regexBounds.charsTested <= MAX_REGEX_SCAN_CHARS, "the matcher never saw more than the budget");
  });
});

// --- round 2: the review falsification and the strengthened admission ----------

Deno.test("coz19 r2: the reviewer's repro — adjacent unbounded quantifiers are REFUSED, and the refusal reaches the model as fs_grep_regex_too_complex", async () => {
  // a+a+a+a+a+b over 8192 'a' chars was ADMITTED by round 1 and never returned
  // (real V8 matcher, 5s timeout, REPRO_EXIT=124). Adjacent unbounded
  // quantifiers are now refused before compilation.
  const violation = regexComplexityViolation("a+a+a+a+a+b");
  assert(violation !== null, "the coord repro must be refused");
  assertStringIncludes(violation!, "direct concatenation");
  for (const pattern of ["a+a+", ".*.*", "(a+)(a+)", "\\w+\\d+x", ".+a*", "a+?b+?", "(a+)c+", "x{2,}y{3,}"]) {
    const v = regexComplexityViolation(pattern);
    assert(v !== null && v.includes("direct concatenation"), `adjacent unbounded must be refused: ${pattern}`);
  }
  // and through the real entry point, before any scan
  await withTree({ "a.txt": fileHandle("a.txt", "a".repeat(50)) }, async (grantId) => {
    const res: any = await grepFsGrant(grantId, { query: "a+a+a+a+a+b", regex: true });
    assertEquals(res.ok, false);
    assertEquals(res.error, "fs_grep_regex_too_complex");
    assertStringIncludes(String(res.detail), "direct concatenation");
  });
});

Deno.test("coz19 r2: multiple universal repetitions are refused; >2 unbounded repetitions per branch are refused", () => {
  for (const pattern of [".*a.*b", ".+a.+b.+", "a.*b.*c", "(?=.*)x.*y"]) {
    const v = regexComplexityViolation(pattern);
    assert(v !== null && v.includes("universal"), `universal>1 must be refused: ${pattern} (got ${v})`);
  }
  for (const pattern of ["\\d+:\\d+:\\d+", "import\\s+\\{[^}]+\\}\\s+from", "\\d+x\\d+y\\d+"]) {
    const v = regexComplexityViolation(pattern);
    assert(v !== null && (v.includes("two unbounded repetitions") || v.includes("more than two")), `U>2 must be refused: ${pattern} (got ${v})`);
  }
  // per-BRANCH accounting: one universal in EACH alternation branch is fine
  assertEquals(regexComplexityViolation("a.*b|c.*d"), null, "alternation branches are accounted separately");
});

Deno.test("coz19 r2: the wall-clock deadline stops the walk with deadlineHit + truncated, honestly", async () => {
  assert(REGEX_MATCH_DEADLINE_MS > 0, "the default deadline is a positive wall-clock bound");
  const content = Array.from({ length: 20 }, (_, i) => `line ${i} match`).join("\n");
  await withTree({ "d.txt": fileHandle("d.txt", content) }, async (grantId) => {
    let calls = 0;
    const res: any = await grepFsGrant(
      grantId,
      { query: "match", regex: true, regexDeadlineMs: 1 },
      { _now: () => (calls++) * 1000 }, // the first call stamps the start; every later check is way over
    );
    assertEquals(res.ok, true, "a deadline hit is a PARTIAL result, never an error");
    assertEquals(res.regexBounds.deadlineHit, true, "and names itself in regexBounds");
    assertEquals(res.truncated, true, "and sets the field the model reads");
    assert(res.matches.length < 20, "the walk actually stopped early");
  });
});

Deno.test("coz19 r2: an admitted regex under the default deadline reports deadlineHit:false and full results", async () => {
  await withTree({ "ok.txt": fileHandle("ok.txt", "alpha\nbeta\ngamma") }, async (grantId) => {
    const res: any = await grepFsGrant(grantId, { query: "[a-z]+", regex: true });
    assertEquals(res.ok, true);
    assertEquals(res.matches.length, 3);
    assertEquals(res.regexBounds.deadlineHit, false);
    assertEquals(res.truncated, false);
  });
});
