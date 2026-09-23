// tests/wasm-tree-shaking.test.ts — chrome-agent-platform-cc18.
//
// THE PROPERTY: the three PAGE bundles (options, ntp, sidepanel) ship ZERO
// WebAssembly API calls. Wasm executes in the workers
// (extension/lib/wasm-execution-worker.js, wasm-stream-worker.js) and in the
// bundled runtimes; a page bundle that carries `WebAssembly.instantiate` has
// stopped tree-shaking the runtime away. chrome-agent-platform-j6au traded a
// dynamic import for static rehydration imports via wasm-preview-host and kept
// the validator shaken out — and NOTHING asserted it, so the property was
// holding by luck across 216 commits. One static import from anyone restores
// the regression silently. That is what this file exists to stop.
//
// WHY A SCANNER AND NOT A grep (the trap this guard had to avoid): each page
// bundle contains the word "WebAssembly" FIVE times at e14e436f, and every one
// is UI copy — "Add a WebAssembly file", "Admitted bundled WebAssembly tool
// packages will be listed here". Counting the bare word reports 5 and means
// nothing. Counting API calls reports 0 and is the property.
//
// FALSIFICATION (run, not asserted — see the cc18 bead comment for the log):
// adding `import { runWasm } from "../lib/wasm-execution-worker.js"` to the
// options entry and rebuilding turned the options assertion RED naming the call
// site; removing it returned the file to GREEN.
//
// The POSITIVE CONTROL is in the same shape as the property: the tracked
// pyodide runtime carries real calls, so a scanner that found nothing anywhere
// (a broken regex, a renamed API) fails this file rather than reporting a clean
// tree. Without it, "0 calls" would be satisfiable by a scanner that cannot see.
// @ts-nocheck

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  formatWasmCallSites,
  WASM_CALL_NAMES,
  wasmApiCallCount,
  wasmApiCalls,
} from "../scripts/lib/wasm-call-scan.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The three page bundles the property is about. */
const PAGE_BUNDLES = [
  "extension/dist/options.bundle.js",
  "extension/dist/ntp.bundle.js",
  "extension/dist/sidepanel.bundle.js",
];

/** The real UI copy from those bundles at e14e436f — the exact strings that
 *  made a bare-word count report 5 per bundle. */
const UI_COPY = [
  `<p class="meta">Admitted bundled WebAssembly tool packages will be listed here when loaded.</p>`,
  "${c} immutable bundled WebAssembly tool packages are admitted in this build.",
  `<form aria-label="Add a WebAssembly file">`,
  `<span class="field-label">WebAssembly file</span>`,
  `<ul id="files" aria-label="Saved WebAssembly files"></ul>`,
];

Deno.test("cc18 scanner: UI copy naming WebAssembly is NOT an API call", () => {
  for (const copy of UI_COPY) {
    assertEquals(
      wasmApiCallCount(copy),
      0,
      `UI copy must not count as a call: ${copy.slice(0, 60)}`,
    );
  }
  // All five together, which is what a page bundle actually contains.
  assertEquals(wasmApiCallCount(UI_COPY.join("\n")), 0);
  // And the bare word is genuinely present, so this test is not passing because
  // the fixtures lost the word they are about.
  assertEquals(UI_COPY.join("\n").split("WebAssembly").length - 1, 5);
});

Deno.test("cc18 scanner: every execution/materialisation API is a call", () => {
  for (const name of WASM_CALL_NAMES) {
    const sites = wasmApiCalls(`const x = await WebAssembly.${name}(bytes);`);
    assertEquals(sites.length, 1, `WebAssembly.${name} must be detected`);
    assertEquals(sites[0].name, name);
  }
  // The constructors count: `new WebAssembly.Module(bytes)` is compilation.
  assertEquals(wasmApiCallCount("new WebAssembly.Module(b)"), 1);
  assertEquals(wasmApiCallCount("new WebAssembly.Instance(m, imports)"), 1);
  // Minified/spaced shapes survive — esbuild never renames property names, so
  // the store bundle keeps the literal member access.
  assertEquals(wasmApiCallCount("await WebAssembly . instantiate (a,b)"), 1);
  assertEquals(wasmApiCallCount("x=WebAssembly.instantiateStreaming(f)"), 1);
  // A longer identifier must not match the shorter name (validate vs validateX).
  assertEquals(wasmApiCallCount("WebAssembly.validateThing(b)"), 0);
  // Unrelated `.validate(` — a schema validator — is not a wasm call.
  assertEquals(wasmApiCallCount("schema.validate(input); ajv.compile(s);"), 0);
});

Deno.test("cc18 scanner POSITIVE CONTROL: the tracked pyodide runtime has real calls", async () => {
  // Tracked source, so its absence is a real defect rather than an unbuilt tree.
  // This is what stops "0 calls everywhere" from being satisfiable by a scanner
  // that can no longer see (a renamed API, a broken regex, a changed member
  // shape). If this ever reports 0, the instrument is broken — not the tree.
  const path = `${ROOT}wasm-tools/python/pyodide.asm.js`;
  const source = await Deno.readTextFile(path);
  const sites = wasmApiCalls(source);
  assert(
    sites.length > 0,
    `the scanner found NO WebAssembly calls in ${path} — the instrument is broken, ` +
      `so a zero result on the page bundles would prove nothing`,
  );
  // The report names the construct, so a failure elsewhere is self-explaining.
  const report = formatWasmCallSites("pyodide.asm.js", sites);
  assertStringIncludes(report, "WebAssembly.");
  assertStringIncludes(report, "call site(s)");
});

Deno.test("cc18: the page bundles ship ZERO WebAssembly API calls (j6au tree-shaking holds)", async () => {
  // FAILS CLOSED on an unbuilt tree rather than skipping silently: a guard that
  // quietly asserts nothing when its subject is missing is the conditional-death
  // shape this repo has already been bitten by. Both gates build before the
  // serial phase, so an absent dist here means the build did not run.
  const marker = `${ROOT}extension/dist/dist.complete`;
  const built = await Deno.stat(marker).then(() => true).catch(() => false);
  assert(
    built,
    `no built dist at ${marker} — run \`npm run build:production\` first; ` +
      `this guard reads the built page bundles and refuses to pass without them`,
  );

  const failures: string[] = [];
  for (const rel of PAGE_BUNDLES) {
    const source = await Deno.readTextFile(`${ROOT}${rel}`);
    const sites = wasmApiCalls(source);
    if (sites.length > 0) failures.push(formatWasmCallSites(rel, sites));
    // The word itself is expected (UI copy) — asserting its presence keeps this
    // honest about WHAT is being counted, so a bundle that lost the wasm UI
    // entirely cannot read as a tree-shaking pass.
    assert(
      source.includes("WebAssembly"),
      `${rel} carries no "WebAssembly" text at all — the bundle shape changed; ` +
        `re-derive what this guard should count before trusting a zero`,
    );
  }
  assertEquals(
    failures.length,
    0,
    `page bundles must not execute or materialise Wasm — it belongs in the ` +
      `workers (wasm-execution-worker / wasm-stream-worker):\n${failures.join("\n")}`,
  );
});
