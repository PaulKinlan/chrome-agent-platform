// tests/scrub-zod-doc.test.ts — chrome-agent-platform-ol0j: the pinned Zod
// Doc.compile denial must respect LEXICAL provenance. The pinned class body is
// recognized structurally (a sha256 over the esbuild-emitted ClassBody AST),
// but a matching body can sit inside a scope that binds `Function` lexically
// (parameter/local/import) — then `new F(...)` is an ORDINARY constructor, and
// rewriting it breaks working code (parent review, tptx-binding-parent-check:
// denied count 1 where 0 was correct, and the rewritten module threw where the
// original returned a data constructor). The denial fires only when the pinned
// constructor's own whole-AST provenance resolves to the GLOBAL evaluator.
//
// Falsification: the pre-fix scrub (hash-only, no lexical guard) reds the two
// shadow tests below (denied count 1, code changed) — shown in the bead's
// review evidence. These tests can never pass vacuously: the denial test
// requires count === 1 on the REAL installed zod emitted through esbuild, so a
// rotted class-body pin (zod bump, pipeline change) fails loudly here.

// @ts-nocheck — dynamic esbuild import + Proxy-guarded globals + data: module
// shapes; behavior is pinned by execution, not types.
import { assert, assertEquals, assertNotEquals, assertStrictEquals, assertThrows } from "jsr:@std/assert@1";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { denyZodDocCompiles } from "../scripts/lib/scrub-zod-doc.mjs";
import { assertNoDynamicEvaluators, findDynamicEvaluators } from "../scripts/lib/dynamic-evaluator-scan.mjs";
import { parse } from "npm:acorn";

const require = createRequire(import.meta.url);
// The pins in scrub-zod-doc.mjs were derived from EXACTLY this zod build
// (v4/core/doc.js @ 3.25.76 / 4.4.3). If the installed zod moves, this fails
// here — before the class-body pins silently stop matching real bundles.
const ZOD_DOC_SHA256 = "e084bbcc536746a8942fd33b08afe4db345554b3a0383114f1dca95261c958d9";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** The zod Doc class the way the real pipeline emits it: bundled by esbuild
 * for chrome120 as ESM, developer (plain) and Store (minifySyntax) variants.
 * `shadow` wraps the class in a function whose PARAMETER is named `Function` —
 * the exact false-positive shape the parent review found. `escapedClassName`
 * (N5, default false) writes the INPUT class name as `class \u0044oc` so a test
 * can see what the real esbuild pipeline emits for an escaped identifier. */
async function emittedDoc({ shadow, minifySyntax, escapedClassName = false }) {
  const { build, stop } = await import("npm:esbuild@^0.25.0");
  // zod's exports map blocks the deep subpath — resolve the package root and
  // walk down to the pinned file.
  const zodRoot = require.resolve("zod/package.json").replace(/\/package\.json$/, "");
  const input = await Deno.readTextFile(`${zodRoot}/v4/core/doc.js`);
  assertEquals(sha256(input), ZOD_DOC_SHA256, "installed zod doc.js moved — re-derive the Doc class-body pins");
  const source = shadow
    ? "export function makeDoc(Function) {\n" + input.replace("export class Doc", "class Doc") + '\nreturn new Doc(["value"]);\n}'
    : input;
  assertEquals(source.split("class Doc").length, 2, "fixture must contain exactly one Doc class");
  const contents = escapedClassName ? source.replace("class Doc", "class \\u0044oc") : source;
  try {
    const out = await build({
      stdin: { contents, sourcefile: shadow ? "foreign-shadow-doc.js" : "zod-doc.js" },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      target: "chrome120",
      minifySyntax,
      legalComments: "none",
    });
    return out.outputFiles[0].text;
  } finally {
    await stop();
  }
}

for (const minifySyntax of [false, true]) {
  Deno.test(`Doc denial: a real GLOBAL evaluator at the pinned method is denied (minifySyntax=${minifySyntax})`, async () => {
    const emitted = await emittedDoc({ shadow: false, minifySyntax });
    // The classifier sees the evaluator before the scrub — the denial must
    // have a live target, not fire on a hunch.
    const before = findDynamicEvaluators(parse(emitted, { ecmaVersion: "latest", sourceType: "module" }));
    assert(before.length >= 1, "the unmodified emitted Doc must contain a recognized evaluator site");
    const { code, count } = denyZodDocCompiles(emitted);
    assertEquals(count, 1, "exactly the pinned Doc.compile body is denied");
    assert(code.includes('eval disabled (MV3 CSP)'), "the denial replacement is present");
    assertNotEquals(code, emitted);
    // No evaluator survives the denial.
    const after = findDynamicEvaluators(parse(code, { ecmaVersion: "latest", sourceType: "module" }));
    assertEquals(after.length, 0, "no recognized evaluator site may survive the denial");
  });

  Deno.test(`Doc denial: a LEXICAL Function binding is preserved, byte-identical (minifySyntax=${minifySyntax})`, async () => {
    const emitted = await emittedDoc({ shadow: true, minifySyntax });
    // Sanity: the pinned class body IS recognized (otherwise this test proves
    // nothing) — but the classifier finds no evaluator, because `Function`
    // here is the ordinary parameter.
    const sites = findDynamicEvaluators(parse(emitted, { ecmaVersion: "latest", sourceType: "module" }));
    assertEquals(sites.length, 0, "a shadowed Function parameter is not an evaluator");
    const { code, count } = denyZodDocCompiles(emitted);
    assertEquals(count, 0, "a lexical Function binding must never be denied");
    assertEquals(code, emitted, "shadowed output is preserved byte-identical");
  });

  Deno.test(`Doc denial: shadowed output keeps its working ordinary-constructor behavior (minifySyntax=${minifySyntax})`, async () => {
    // Execute the (preserved) shadow module under a TRIPPED global Function:
    // any global evaluator use throws here, so a passing run proves the module
    // only ever used its ordinary parameter. The body text stays DATA.
    const emitted = await emittedDoc({ shadow: true, minifySyntax });
    const { code } = denyZodDocCompiles(emitted);
    assertEquals(code, emitted, "nothing to execute differently when the scrub preserved the module");
    const originalFunction = globalThis.Function;
    let evaluatorUses = 0;
    globalThis.Function = new Proxy(originalFunction, {
      apply() { evaluatorUses++; throw new Error("global evaluator guard"); },
      construct() { evaluatorUses++; throw new Error("global evaluator guard"); },
    });
    class DataConstructor {
      constructor(...parts) { this.parts = parts; }
    }
    try {
      const mod = await import(`data:text/javascript;base64,${btoa(code)}`);
      const doc = mod.makeDoc(DataConstructor);
      doc.write("return value;");
      const value = doc.compile();
      assert(value instanceof DataConstructor, "compile must return the ORDINARY constructor's instance");
      assertEquals(value.parts, ["value", "  return value;"], "body text is data, never evaluated");
      assertEquals(evaluatorUses, 0, "no global evaluator use while compiling under a lexical binding");
    } finally {
      globalThis.Function = originalFunction;
    }
  });
}

// ── N5 (round-2 review): the `\bDoc\d*\b` fast path in denyZodDocCompiles ─────────────────────────
//
// scripts/lib/scrub-zod-doc.mjs returns `{ code: source, count: 0 }` BEFORE parsing when the text has
// no `Doc` token. It is a speed-up (the scrub runs over every generated bundle, and almost none carry
// zod's Doc class), but it changes two observable things, pinned below so that a change to either is a
// conscious one rather than a silent one:
//   1. no `Doc` token  => the source comes back byte-identical with count 0, and it is NEVER PARSED, so
//      even text that is not JavaScript comes back untouched instead of throwing from the parser;
//   2. a `Doc` the regex cannot SEE is never scrubbed. The one such shape is an escaped class name
//      (`class \u0044oc`): acorn decodes it to `Doc`, the regex does not. KNOWN LIMIT, last test.
const ACORN_OPTIONS = { ecmaVersion: "latest", sourceType: "module" };

const SOURCES_WITHOUT_A_DOC_TOKEN: Array<[label: string, source: string, parseable: boolean]> = [
  ["the empty string", "", true],
  ["an ordinary module", "const a = 1;\nexport { a };\n", true],
  // The denial is not an evaluator scrubber: an evaluator that is not zod's Doc class is the
  // regex scrub's and the final gate's business, so it must come back byte-identical here.
  ["an evaluator that is not a Doc class", 'export const f = new Function("return 1");\n', true],
  ["text that is not JavaScript", "}{ ((( this is not javascript", false],
  // Every near miss of the token, inside text acorn rejects: if the gate ever widened (no word
  // boundary, no digit suffix rule) one of these would reach the parser and throw.
  ["near misses of the token, unparseable", "}{ Documentation myDoc Doc_ Doc2x DocX doc DOC (((", false],
];
for (const [label, source, parseable] of SOURCES_WITHOUT_A_DOC_TOKEN) {
  Deno.test(`Doc fast path: ${label} (no Doc token) comes back byte-identical, count 0, and is never parsed`, () => {
    // The fixture really is what its label says: acorn accepts it iff `parseable`.
    if (parseable) parse(source, ACORN_OPTIONS);
    else assertThrows(() => parse(source, ACORN_OPTIONS), SyntaxError);
    const result = denyZodDocCompiles(source);
    assertStrictEquals(result.code, source, "the very same string, not a re-serialisation");
    assertEquals(result.count, 0);
  });
}

Deno.test("Doc fast path: unparseable input WITH a Doc token IS parsed (and rejected) — the fast path gates on the token, it is not a blanket skip", () => {
  for (const source of ["class Doc {{{", "}{ ((( Doc", "}{ ((( Doc2", "}{ ((( Doc10 }"]) {
    assertThrows(() => denyZodDocCompiles(source), SyntaxError, undefined, `${JSON.stringify(source)} carries a Doc token`);
  }
});

for (const minifySyntax of [false, true]) {
  Deno.test(`Doc fast path: a real Doc.compile is still scrubbed past the gate, as Doc and as the bundler-renamed Doc2 (minifySyntax=${minifySyntax})`, async () => {
    const emitted = await emittedDoc({ shadow: false, minifySyntax });
    // A bundler that finds two `Doc`s in one graph renames the second to Doc2: same class body, new name.
    const renamed = emitted.replaceAll(/\bDoc\b/gu, "Doc2");
    assertNotEquals(renamed, emitted, "the fixture must actually be renamed");
    assert(/\bDoc2\b/u.test(renamed) && !/\bDoc\b/u.test(renamed), "only the Doc2 spelling remains");
    for (const [spelling, source] of [["Doc", emitted], ["Doc2", renamed]]) {
      const { code, count } = denyZodDocCompiles(source);
      assertEquals(count, 1, `the pinned class body is denied when the class is named ${spelling}`);
      assertNotEquals(code, source, `the ${spelling} source must actually be rewritten`);
      const after = findDynamicEvaluators(parse(code, ACORN_OPTIONS));
      assertEquals(after.length, 0, `no evaluator site survives the denial for ${spelling}`);
    }
  });
}

Deno.test("Doc fast path KNOWN LIMIT: an escaped class name (class \\u0044oc) is NOT detected by the fast path — the final whole-AST evaluator gate is the backstop", async () => {
  // This asserts the CURRENT behaviour on purpose, so that changing it is a conscious decision. It is
  // adversarial-only input: esbuild never emits an escaped class name (checked executably below), so
  // no real bundle reaches the scrub in this shape, and build.mjs's final `assertNoDynamicEvaluators`
  // gate (a settleAll over every generated bundle, pinned by tests/build-parallel-discipline.test.ts)
  // refuses a surviving evaluator whatever its class is called.
  const emitted = await emittedDoc({ shadow: false, minifySyntax: false });
  const escaped = emitted.replaceAll(/\bDoc\b/gu, "\\u0044oc");
  assertNotEquals(escaped, emitted, "the fixture must actually be escaped");
  assert(escaped.includes("\\u0044oc"), "the escape is literally present in the source text");

  // (a) acorn DECODES the escape, so the scrub's own name check would match `Doc` ...
  const declaration = parse(escaped, ACORN_OPTIONS).body.find((n) => n.type === "VariableDeclaration");
  assertEquals(declaration.declarations[0].id.name, "Doc", "acorn decodes \\u0044oc to Doc");

  // (b) ... but the fast path's textual gate never lets the source reach it: untouched, count 0.
  const missed = denyZodDocCompiles(escaped);
  assertStrictEquals(missed.code, escaped, "KNOWN LIMIT: the escaped class is not scrubbed");
  assertEquals(missed.count, 0, "KNOWN LIMIT: the escaped class is not counted");

  // (c) the miss is purely the TEXTUAL gate: give the regex a token to find and the very same
  // escaped class IS denied, so the scrub's logic itself resolves the escape correctly.
  assertEquals(denyZodDocCompiles("/* Doc */\n" + escaped).count, 1, "with a visible token the escaped class is denied");

  // (d) the BACKSTOP: the evaluator that survived the scrub is refused by the final whole-AST gate.
  assert(findDynamicEvaluators(parse(missed.code, ACORN_OPTIONS)).length >= 1, "the evaluator survived the scrub");
  assertThrows(
    () => assertNoDynamicEvaluators(missed.code, "escaped-doc.js"),
    Error,
    "dynamic source evaluator is forbidden",
  );

  // (e) esbuild never EMITS the escaped spelling: fed `class \u0044oc` it prints the plain name, so
  // the token is visible and the scrub denies it. The shape above cannot come out of the real pipeline.
  const viaEsbuild = await emittedDoc({ shadow: false, minifySyntax: false, escapedClassName: true });
  assert(!viaEsbuild.includes("\\u0044"), "esbuild normalises the escaped class name away");
  assert(/\bDoc\b/u.test(viaEsbuild), "the emitted class carries the plain Doc token");
  assertEquals(denyZodDocCompiles(viaEsbuild).count, 1, "so the emitted class is denied as usual");
});
