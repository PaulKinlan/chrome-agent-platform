// @ts-nocheck — publisher-free real esbuild/marker/policy fixtures.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createValidateOriginBuild, wasmCallSites, VALIDATE_SOURCE } from "../scripts/lib/wasm-validate-origin.mjs";
import { writeDistCompleteMarker, validateDistCompleteMarker } from "../scripts/dist-complete.mjs";
import { assertStoreTargetBoundary, STORE_EXTENSION_CSP } from "../scripts/store-target-policy.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";
const { build, stop } = createRequire(import.meta.url)("esbuild");
const { parse } = createRequire(import.meta.url)("acorn");
const ROOT = new URL("../", import.meta.url).pathname;
const wrap = code => new Map([["background/service-worker.js", code], ["options.bundle.js", code], ["workers/agent-worker.js", "export const worker=1;"], ["shared/diff-core.bundle.js", "export const diff=1;"]]);
async function emit(builder, entry) {
  const result = await build({ stdin: { contents: entry, resolveDir: ROOT, loader: "js" }, bundle: true, write: false, format: "esm", platform: "browser", target: "chrome120", minify: true, metafile: true, plugins: [builder.plugin] });
  return { code: result.outputFiles[0].text, meta: result.metafile };
}
const canonical = `export { auditEmscriptenModule } from './${VALIDATE_SOURCE.path}';`;
const foreign = 'export function unrelated(attackerBytes){void "data_index_invalid";if(!WebAssembly.validate(attackerBytes))throw new Error("wasm_engine_invalid");return {"features":[]};}';
Deno.test("validate origin: actual esbuild canonical positive, tree-shaken presence and foreign substitution refuse", async () => {
  try {
    const builder = createValidateOriginBuild(ROOT), built = await emit(builder, canonical);
    const marked = wasmCallSites(built.code)[0];
    assertEquals(marked.arguments.length, 2);
    const nonce = marked.arguments[1].value;
    const clean = builder.finish(wrap(built.code));
    for (const source of clean.outputs.values()) assert(!source.includes(nonce));
    assertEquals(clean.derivation.source, VALIDATE_SOURCE);
    assertEquals(wasmCallSites(clean.outputs.get("options.bundle.js"))[0].arguments.length, 1);
    const other = createValidateOriginBuild(ROOT), second = await emit(other, canonical);
    assert(wasmCallSites(second.code)[0].arguments[1].value !== nonce);
    assertThrows(() => builder.finish(wrap(second.code)), Error, "marked call");
    for (const entry of [
      `export { compatibleEmscriptenType } from './${VALIDATE_SOURCE.path}';`,
      `export { compatibleEmscriptenType } from './${VALIDATE_SOURCE.path}';${foreign}`,
    ]) {
      const b = createValidateOriginBuild(ROOT), output = await emit(b, entry);
      assert(Object.keys(output.meta.inputs).some(p => p.endsWith(VALIDATE_SOURCE.path)), "actual canonical input remains in metafile");
      assertThrows(() => b.finish(wrap(output.code)), Error, "marked call");
    }
    for (const changed of [
      built.code.replace(JSON.stringify(nonce), '"fake-nonce"'),
      built.code + foreign,
      built.code + `;void ${JSON.stringify(nonce)};`,
      built.code.replace("WebAssembly.validate(", "WebAssembly.compile("),
      built.code.replace("WebAssembly.validate(", "WebAssembly.instantiate("),
      built.code.replace("WebAssembly.validate(", "new WebAssembly.Module("),
      built.code.replace(JSON.stringify(nonce), `${JSON.stringify(nonce)},0`),
      built.code.replace("WebAssembly.validate(", 'WebAssembly["validate"]('),
    ]) assertThrows(() => builder.finish(wrap(changed)));
    for (const shadow of ['const WebAssembly={validate(){}};', 'function shadow(WebAssembly){}', 'import WebAssembly from "ordinary-data";']) {
      assertThrows(() => builder.finish(wrap(built.code + shadow)), Error, "shadowed WebAssembly");
    }
    const extra = wrap(built.code); extra.set("workers/agent-worker.js", foreign);
    assertThrows(() => builder.finish(extra), Error, "unexpected Wasm output");
    const leak = wrap(built.code); leak.set("shared/diff-core.bundle.js", `//${nonce}`);
    assertThrows(() => builder.finish(leak), Error, "nonce leak");
    const unknown = wrap(built.code); unknown.set("foreign.js", "export{}");
    assertThrows(() => builder.finish(unknown), Error, "unexpected generated");
    const dir = await mkdtemp(path.join(durableDir("origin-tests"), "leak-"));
    try {
      await writeFile(path.join(dir, "source.js.map"), JSON.stringify({ sourcesContent: [nonce] }));
      await assertRejects(() => builder.assertDirectoryNonceFree(dir), Error, "nonce leak");
      await writeFile(path.join(dir, "source.js.map"), "{}");
      await assertRejects(() => builder.assertDirectoryNonceFree(dir), Error, "unexpected Store source map");
    }
    finally { await rm(dir, { recursive: true }); }
  } finally { stop(); }
});
Deno.test("validate origin: onLoad source identity refuses wrong body/argument/location/path without disk mutation", async () => {
  const original = await readFile(path.join(ROOT, VALIDATE_SOURCE.path), "utf8");
  const dir = await mkdtemp(path.join(durableDir("origin-tests"), "source-"));
  try {
    const file = path.join(dir, VALIDATE_SOURCE.path); await mkdir(path.dirname(file), { recursive: true });
    for (const text of [original + "\n", original.replace("WebAssembly.validate(bytes)", "WebAssembly.validate(other)"), original.replace("WebAssembly.validate(bytes)", "WebAssembly.validate(bytes, 0)")]) {
      await writeFile(file, text); const b = createValidateOriginBuild(dir); let load;
      b.plugin.setup({ onLoad(_options, callback) { load = callback; } });
      await assertRejects(() => load({ path: file }), Error, "source hash mismatch");
    }
    const b = createValidateOriginBuild(ROOT); let load;
    b.plugin.setup({ onLoad(_options, callback) { load = callback; } });
    await assertRejects(() => load({ path: file }), Error, "noncanonical source path");
    await load({ path: path.join(ROOT, VALIDATE_SOURCE.path) });
    assertEquals(await readFile(path.join(ROOT, VALIDATE_SOURCE.path), "utf8"), original);
  } finally { await rm(dir, { recursive: true }); }
});
Deno.test("validate origin: strict marker/physical-logical policy accepts bound output and rejects missing/stale/mismatched derivations", async () => {
  const dir = await mkdtemp(path.join(durableDir("origin-tests"), "marker-"));
  try {
    const b = createValidateOriginBuild(ROOT), emitted = await emit(b, canonical), clean = b.finish(wrap(emitted.code));
    for (const [rel, code] of clean.outputs) { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), code); }
    await writeDistCompleteMarker({ root: ROOT, distRoot: dir, target: "store", validateOrigin: clean.derivation });
    const markerPath = path.join(dir, "dist.complete"), originalMarker = await readFile(markerPath, "utf8");
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, content_security_policy: { extension_pages: STORE_EXTENSION_CSP } }));
    const inventory = ["background/service-worker.js", "options.bundle.js", "dist.complete"].map(rel => ({ sourcePath: path.join(dir, rel), archivePath: `dist/${rel}` }));
    inventory.push({ sourcePath: path.join(dir, "manifest.json"), archivePath: "manifest.json" });
    await assertStoreTargetBoundary({ target: "store", inventory });
    for (const [index, change] of [
      m => delete m.validateOrigin,
      m => m.validateOrigin.source.sha256 = "a".repeat(64),
      m => m.validateOrigin.source.line++,
      m => m.validateOrigin.sites[0].start++,
      m => m.validateOrigin.sites[0].output = "workers/agent-worker.js",
      m => m.outputs[0].sha256 = "b".repeat(64),
    ].entries()) {
      const marker = JSON.parse(originalMarker); change(marker); await writeFile(markerPath, JSON.stringify(marker) + "\n");
      if (index !== 0) await assertRejects(() => validateDistCompleteMarker({ root: ROOT, distRoot: dir, expectedTarget: "store" }));
      await assertRejects(() => assertStoreTargetBoundary({ target: "store", inventory }));
    }
    await writeFile(markerPath, originalMarker);
    const copied = path.join(dir, "copied.js"); await writeFile(copied, clean.outputs.get("options.bundle.js"));
    const wrongPhysical = inventory.map(e => e.archivePath === "dist/options.bundle.js" ? { ...e, sourcePath: copied } : e);
    await assertRejects(() => assertStoreTargetBoundary({ target: "store", inventory: wrongPhysical }), Error, "physical/logical binding");
    await writeFile(path.join(dir, "options.bundle.js"), foreign);
    await assertRejects(() => validateDistCompleteMarker({ root: ROOT, distRoot: dir, expectedTarget: "store" }), Error, "output is stale");
    // An operator replacing BOTH matching marker and bytes is explicitly outside
    // coord242's trusted-writer boundary; do not pretend public hashes defeat it.
  } finally { stop(); await rm(dir, { recursive: true }); }
});
Deno.test("validate origin: actual build mode wiring never marks developer input/maps", async () => {
  const source = await readFile(path.join(ROOT, "build.mjs"), "utf8");
  let declaration, plugins;
  function visit(n) {
    if (!n?.type) return;
    if (n.type === "VariableDeclaration" && n.declarations.some(d => d.id?.name === "validateOriginBuild")) declaration = source.slice(n.start, n.end);
    if (n.type === "VariableDeclarator" && n.id?.name === "shared") {
      const p = n.init.properties.find(p => p.key?.name === "plugins"); plugins = source.slice(p.value.start, p.value.end);
    }
    for (const c of Object.values(n)) if (Array.isArray(c)) c.forEach(visit); else if (c?.type) visit(c);
  }
  visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  assert(declaration && plugins);
  for (const DEBUG_BUILD of [true, false]) {
    let calls = 0; const plugin = {};
    const env = { DEBUG_BUILD, ROOT, createValidateOriginBuild() { calls++; return { plugin }; }, diffCoreFromSource: {}, capAiSdkDedup: {} };
    const values = runInNewContext(`${declaration};${plugins}`, env);
    assertEquals(calls, DEBUG_BUILD ? 0 : 1);
    assertEquals(values.includes(plugin), !DEBUG_BUILD);
  }
});
