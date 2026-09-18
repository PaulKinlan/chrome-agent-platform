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
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { denyZodDocCompiles } from "../scripts/lib/scrub-zod-doc.mjs";
import { findDynamicEvaluators } from "../scripts/lib/dynamic-evaluator-scan.mjs";
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
 * the exact false-positive shape the parent review found. */
async function emittedDoc({ shadow, minifySyntax }) {
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
  try {
    const out = await build({
      stdin: { contents: source, sourcefile: shadow ? "foreign-shadow-doc.js" : "zod-doc.js" },
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
