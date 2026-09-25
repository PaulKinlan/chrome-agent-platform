// @ts-nocheck — real emitted modules and isolated build-loop fixtures.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { denyZodDocCompiles } from "../scripts/lib/scrub-zod-doc.mjs";
import { assertNoDynamicEvaluators } from "../scripts/lib/dynamic-evaluator-scan.mjs";
const require = createRequire(import.meta.url);
const { build, transform, stop } = require("esbuild");
const { parse } = require("acorn");
const ROOT = new URL("../", import.meta.url).pathname;
const sources = [
  ["3.25.76", "cjs", "ae6c5bfe9570d30c119cd6bc9dff33f6956858b4fa6887b2b1f9680f11d1b65d"],
  ["3.25.76", "js", "e084bbcc536746a8942fd33b08afe4db345554b3a0383114f1dca95261c958d9"],
  ["4.4.3", "js", "e084bbcc536746a8942fd33b08afe4db345554b3a0383114f1dca95261c958d9"],
];
async function emitted(version, ext, minifySyntax) {
  const file = `${ROOT}node_modules/.deno/zod@${version}/node_modules/zod/v4/core/doc.${ext}`;
  const result = await build({ entryPoints: [file], bundle: true, write: false, platform: "browser", format: "esm", target: "chrome120", minifySyntax, legalComments: "none" });
  return result.outputFiles[0].text;
}
Deno.test("scrub-zod-doc: exact pinned classes deny only compile in developer and syntax-optimized output", async () => {
  try {
    for (const [version, ext, hash] of sources) {
      const bytes = await Deno.readFile(`${ROOT}node_modules/.deno/zod@${version}/node_modules/zod/v4/core/doc.${ext}`);
      assertEquals(createHash("sha256").update(bytes).digest("hex"), hash);
      for (const minifySyntax of [false, true]) {
        const source = await emitted(version, ext, minifySyntax);
        const denied = denyZodDocCompiles(source);
        assertEquals(denied.count, 1);
        assertNoDynamicEvaluators(denied.code, "denied exact Doc");
        assertThrows(() => assertNoDynamicEvaluators(source, "original Doc"), Error, "dynamic source evaluator");
        for (const changed of [source.replace("compile()", "compile(arg)"), source.replace("compile() {", "compile() { globalThis.changed = true;"), source.replace("indented(fn)", "other(fn)")]) {
          const untouched = denyZodDocCompiles(changed);
          assertEquals(untouched, { code: changed, count: 0 }, "unknown shape must not lose any statements");
          assertThrows(() => assertNoDynamicEvaluators(untouched.code, "unrecognized Doc"));
        }
        const unrelated = 'class Other { compile() { return "safe"; } }';
        const combined = unrelated + source + '\nclass More { compile(){ return 9; } }';
        const result = denyZodDocCompiles(combined);
        assertEquals(result.count, 1);
        assert(result.code.startsWith(unrelated));
        assert(result.code.endsWith('class More { compile(){ return 9; } }'));
        // Only the denied module is imported: original evaluator payloads never run.
        const safe = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(denied.code)))}`);
        const Doc = safe.Doc ?? safe.default.Doc;
        const doc = new Doc(["input"]); doc.write("return input;");
        assertEquals(doc.args, ["input"]);
        assert(doc.content.length > 0);
        assertThrows(() => doc.compile(), Error, "eval disabled (MV3 CSP)");
      }
    }
  } finally { stop(); }
});
Deno.test("scrub-zod-doc: ol0j lexical Function shadows preserve ordinary DataConstructor behavior", async () => {
  const file = `${ROOT}node_modules/.deno/zod@4.4.3/node_modules/zod/v4/core/doc.js`;
  const original = (await Deno.readTextFile(file)).replace("export class Doc", "class Doc");
  const dataConstructor = 'function DataConstructor(...args){return args;}';
  const imported = `data:text/javascript;base64,${btoa(`export default ${dataConstructor}`)}`;
  const variants = [
    `export function makeDoc(Function){${original};return Doc;}`,
    `export function makeDoc(){const Function=${dataConstructor};${original};return Doc;}`,
    `import Function from ${JSON.stringify(imported)};${original};export function makeDoc(){return Doc;}`,
  ];
  try {
    for (const minifySyntax of [false, true]) for (const input of variants) {
      const source = (await transform(input, { format: "esm", target: "chrome120", minifySyntax })).code;
      assertNoDynamicEvaluators(source, "ordinary lexical constructor");
      const rewritten = denyZodDocCompiles(source);
      assertEquals(rewritten.count, 0, "pinned spelling is not global evaluator authority");
      assertEquals(rewritten.code, source, "ordinary code must remain byte-identical");
      const nativeFunction = globalThis.Function;
      let evaluatorTraps = 0;
      globalThis.Function = new Proxy(nativeFunction, {
        apply() { evaluatorTraps++; throw new Error("unexpected evaluator"); },
        construct() { evaluatorTraps++; throw new Error("unexpected evaluator"); },
      });
      try {
        const module = await import(`data:text/javascript;base64,${btoa(unescape(encodeURIComponent(rewritten.code)))}`);
        function DataConstructor(...args) { return args; }
        const Doc = module.makeDoc(DataConstructor);
        const doc = new Doc(["value"]); doc.write("return value;");
        assertEquals(doc.compile(), ["value", "  return value;"]);
        assertEquals(evaluatorTraps, 0);
      } finally { globalThis.Function = nativeFunction; }
    }
  } finally { stop(); }
});

function loops(source) {
  const found = {};
  function visit(node) {
    if (!node?.type) return;
    if (node.type === "ForOfStatement") {
      const name = node.left.declarations?.[0]?.id?.name;
      if (["scrubPath", "output"].includes(name)) found[name] = source.slice(node.start, node.end);
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value?.type) visit(value);
  }
  visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  assert(found.scrubPath && found.output, "actual build scrub and final AST loops are required");
  return found;
}
Deno.test("scrub-zod-doc: actual four-output build loops remove Doc/probes and final AST refuses unsanitized Options", async () => {
  try {
    const source = await Deno.readTextFile(`${ROOT}build.mjs`);
    const actual = loops(source);
    const doc = await emitted("4.4.3", "js", true);
    const input = doc + '\nfunction probe(){const F=Function;return new F("");}\nfunction direct(){return new Function("return 1");}\n';
    const files = new Map(["SW", "WORKER", "OPT", "DIFF_CORE"].map(f => [f, f === "DIFF_CORE" ? 'export const safe = true;' : input]));
    const env = { SW: "SW", WORKER: "WORKER", OPT: "OPT", DIFF_CORE: "DIFF_CORE", STAGE: "stage", denyZodDocCompiles, assertNoDynamicEvaluators, path, console: { log() {} }, readFile: async f => files.get(f), writeFile: async (f, data) => files.set(f, data), walkJs: async () => [...files.keys()] };
    // Execute the literal build-loop source with in-memory file I/O, not its
    // publisher. Generated dependency code remains data throughout this check.
    const scrub = runInNewContext(`(async()=>{let occurrences=0,zodProbes=0,zodDocCompiles=0;${actual.scrubPath};return {occurrences,zodProbes,zodDocCompiles};})()`, env);
    assertEquals(JSON.parse(JSON.stringify(await scrub)), { occurrences: 3, zodProbes: 3, zodDocCompiles: 3 });
    for (const [f, data] of files) {
      const transformed = await transform(data, { minify: true, target: "chrome120", legalComments: "none", format: "esm" });
      files.set(f, transformed.code);
    }
    await runInNewContext(`(async()=>{${actual.output}})()`, env);
    // Restoring either original Options site must be refused by the REAL final
    // loop. This test also fails if that gate is bypassed; no artifact publishes.
    for (const unsafe of [doc, 'const F=Function;new F("");', 'new Function("return 1");']) {
      files.set("OPT", (await transform(unsafe, { minify: true, target: "chrome120", format: "esm" })).code);
      await assertRejects(() => runInNewContext(`(async()=>{${actual.output}})()`, env), Error, "dynamic source evaluator");
    }
  } finally { stop(); }
});
