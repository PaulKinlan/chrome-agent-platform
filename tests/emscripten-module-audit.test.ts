import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { auditEmscriptenModule, compatibleEmscriptenType } from "../extension/lib/emscripten-module-audit.js";
import { sha256HexBytes } from "../extension/lib/pure.js";

const root = "packages/bundled/evidence/emscripten-abi";
const read = (name: string) => Deno.readFile(`${root}/build-a/${name}.wasm`);
const header = [0, 97, 115, 109, 1, 0, 0, 0];
const u32 = (n: number): number[] => { const out = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; out.push(b); } while (n); return out; };
const section = (id: number, body: number[]) => [id, ...u32(body.length), ...body];
const wasm = (...sections: number[][]) => Uint8Array.from([...header, ...sections.flat()]);
const type = section(1, [1, 0x60, 0, 0]);
const fn = section(3, [1, 0]);
const code = (body: number[]) => section(10, [1, ...u32(body.length), ...body]);
function refused(bytes: Uint8Array, code: string) { assertThrows(() => auditEmscriptenModule(bytes), Error, code); }

Deno.test("emscripten module audit: source-pinned numeric has complete exported types, not just names", async () => {
  const bytes = await read("numeric");
  assertEquals(await sha256HexBytes(bytes), "fea83472b7e56292785f132d0c5f564048cf34ae047627334f504b28dd405503");
  const scan = auditEmscriptenModule(bytes);
  assertEquals(scan.imports, []);
  assertEquals(scan.features, []); // MVP internal mutable global/table are not proposal use.
  assertEquals(scan.memories, [{ index: 0, type: { address: "i32", shared: false, min: 256, max: 256 } }]);
  assertEquals(scan.tables, [{ index: 0, type: { element: "funcref", min: 1, max: 1 } }]);
  assertEquals(scan.exports.map(e => [e.name, e.kind, e.type]), [
    ["memory", "memory", { address: "i32", shared: false, min: 256, max: 256 }],
    ["__wasm_call_ctors", "function", { params: [], results: [] }],
    ["cap_weighted_sum", "function", { params: ["f64", "f64", "f64"], results: ["f64"] }],
    ["__indirect_function_table", "table", { element: "funcref", min: 1, max: 1 }],
    ["_emscripten_stack_restore", "function", { params: ["i32"], results: [] }],
    ["_emscripten_stack_alloc", "function", { params: ["i32"], results: ["i32"] }],
    ["emscripten_stack_get_current", "function", { params: [], results: ["i32"] }],
  ]);
  assertEquals(scan.exports.map(e => e.index), [0, 0, 1, 0, 2, 3, 4]);
  assertEquals(scan.globals, [{ index: 0, type: { value: "i32", mutable: true }, initializer: { op: "i32.const", value: 66560 } }]);
  assertEquals(scan.tags, []); assertEquals(scan.start, null); assertEquals(scan.dylink, null);
});

Deno.test("emscripten module audit: actual image and memoryless side are structural positives", async () => {
  const image = auditEmscriptenModule(await read("image-resize"));
  assertEquals(image.imports.map(i => [i.module, i.symbol, i.kind, i.type]), [
    ["env", "__assert_fail", "function", { params: ["i32", "i32", "i32", "i32"], results: [] }],
    ["env", "emscripten_resize_heap", "function", { params: ["i32"], results: ["i32"] }],
  ]);
  assertEquals(image.tables[0].type, { element: "funcref", min: 216, max: 216 });
  const main = auditEmscriptenModule(await read("link-main"));
  const side = auditEmscriptenModule(await read("link-side"));
  assertEquals(main.dylink, { memorySize: 0, memoryAlignment: 2, tableSize: 0, tableAlignment: 0, needed: ["link-side.wasm"] });
  assertEquals(main.tables[0].type.max, null);
  assertEquals(side.memories, []); assertEquals(side.tables, []);
  const exported = side.exports.find(e => e.name === "side_increment");
  const imported = main.imports.find(i => i.symbol === "side_increment");
  assert(exported && imported);
  assertEquals(exported.type, { params: ["i32"], results: ["i32"] });
  assert(compatibleEmscriptenType("function", imported.type, exported.type));
});

Deno.test("emscripten module audit: bounded legal padded LEB, overflow, framing and unsupported types", () => {
  assertEquals(auditEmscriptenModule(wasm([1, 0x84, 0x80, 0x80, 0x80, 0, 1, 0x60, 0, 0])).imports, []);
  refused(wasm([1, 0xff, 0xff, 0xff, 0xff, 0x10]), "leb_overflow");
  refused(wasm([1, 0xff, 0xff, 0xff, 0xff, 0x8f]), "leb_overflow");
  refused(wasm(section(1, [0xff, 0xff, 0xff, 0xff, 0x0f])), "vector_framing");
  refused(wasm(section(1, [1, 0x60, 0, 2, 0x7f, 0x7f])), "multi_value_unsupported");
  refused(wasm(section(1, [1, 0x60, 1, 0x6f, 0])), "wasm_type_unsupported");
  refused(wasm(type, type), "duplicate_section");
  refused(wasm(fn, type), "wasm_index_invalid");
  refused(wasm(section(14, [])), "unknown_section");
  refused(wasm(type, fn), "function_code_count_mismatch");
});

Deno.test("emscripten module audit: DataCount and tag use standard nonnumeric order", () => {
  const memory = section(5, [1, 1, 1, 1]);
  const data = section(11, [1, 1, 0]);
  const count = section(12, [1]);
  const body = code([0, 0x41, 0, 0x41, 0, 0x41, 0, 0xfc, 8, 0, 0, 0x0b]);
  assertEquals(auditEmscriptenModule(wasm(type, fn, memory, count, body, data)).features, ["bulk-memory"]);
  refused(wasm(type, fn, memory, body, count, data), "section_order");
  refused(wasm(type, fn, memory, body, data), "data_count_missing");
  refused(wasm(type, fn, memory, section(12, [0]), body, data), "data_count_mismatch");
  const tag = section(13, [1, 0, 0]);
  const global = section(6, [1, 0x7f, 0, 0x41, 0, 0x0b]);
  const scan = auditEmscriptenModule(wasm(type, tag, global));
  assertEquals(scan.tags, [{ index: 0, type: { attribute: 0, signature: { params: [], results: [] } } }]);
  assertEquals(scan.features, ["exception-tags"]);
  refused(wasm(type, global, tag), "section_order");
  refused(wasm(type, section(13, [1, 1, 0])), "tag_attribute_invalid");
  refused(wasm(type, section(13, [1, 0, 1])), "wasm_index_invalid");
});

Deno.test("emscripten module audit: mandatory engine validity catches an invalid stack with valid framing", () => {
  refused(wasm(type, fn, code([0, 0x6a, 0x0b])), "wasm_engine_invalid");
  refused(wasm(type, fn, code([0, 0xfe, 0, 0x0b])), "opcode_unsupported");
  refused(wasm(section(5, [1, 4, 0])), "memory64_rejected");
  refused(wasm(section(5, [1, 1, 2, 1])), "memory_limits_invalid");
  refused(wasm(section(6, [1, 0x7f, 2])), "global_mutability_invalid");
  refused(wasm(type, fn, section(7, [1, 1, 120, 0, 9])), "wasm_index_invalid");
});

Deno.test("emscripten module audit: dylink guards exponent before shifting and rejects unknown semantics", () => {
  const name = [8, ...new TextEncoder().encode("dylink.0")];
  refused(wasm(section(0, [...name, 1, 8, 0, 0xff, 0xff, 0xff, 0xff, 15, 0, 0])), "dylink_alignment_overflow");
  refused(wasm(section(0, [...name, 3, 0])), "dylink_subsection_unsupported");
  refused(wasm(section(0, [...name, 1, 4, 0, 0, 0, 0, 1, 4, 0, 0, 0, 0])), "dylink_duplicate_subsection");
});

Deno.test("emscripten module audit: provider compatibility preserves kind types and limit direction", () => {
  const memory = { address: "i32", shared: false, min: 1, max: 65536 };
  assert(compatibleEmscriptenType("memory", memory, { ...memory, min: 256, max: 256 }));
  assert(!compatibleEmscriptenType("memory", memory, { ...memory, min: 0 }));
  assert(!compatibleEmscriptenType("memory", memory, { ...memory, max: null }));
  assert(!compatibleEmscriptenType("memory", memory, { ...memory, shared: true }));
  assert(!compatibleEmscriptenType("function", { params: ["i32"], results: [] }, { params: ["f64"], results: [] }));
  assert(!compatibleEmscriptenType("global", { value: "i32", mutable: false }, { value: "i32", mutable: true }));
});

async function graphFixture(linked = false) {
  const names = linked ? ["link-main", "link-side"] : ["image-resize"];
  const files = new Map<string, Uint8Array>();
  const assets = [];
  const modules = [];
  const glueName = linked ? "link-main" : "image-resize";
  const glueBytes = await Deno.readFile(`${root}/build-a/${glueName}.mjs`);
  const glue = { id: "glue", role: "glue", path: `extension/wasm/runtime/a0/1.0.0/${glueName}.mjs`, sha256: await sha256HexBytes(glueBytes), size: glueBytes.length };
  assets.push(glue); files.set(glue.path, glueBytes);
  for (const [i, name] of names.entries()) {
    const bytes = await read(name), sha256 = await sha256HexBytes(bytes), id = i ? "side" : "main";
    const asset = { id, role: i ? "side-wasm" : "main-wasm", path: `extension/wasm/cas/${sha256}.wasm`, sha256, size: bytes.length };
    assets.push(asset); files.set(asset.path, bytes);
    const { features: _features, ...scan } = auditEmscriptenModule(bytes);
    const imports = scan.imports.map(imported => ({ ...imported, provider: imported.symbol === "side_increment"
      ? { kind: "module", asset: "side", exportName: "side_increment" }
      : { kind: "glue", asset: "glue", binding: imported.symbol === "__assert_fail" ? "___assert_fail" : "_emscripten_resize_heap" } }));
    modules.push({ asset: id, ...scan, imports });
  }
  return { graph: { assets, modules, linkGraph: { policy: linked ? "eager" : "none", main: "main", dependencies: linked ? [{ from: "main", name: "link-side.wasm", to: "side" }] : [] } }, files };
}

Deno.test("emscripten graph audit: real emitted abort bindings and side export close the graph without execution", async () => {
  const { auditEmscriptenGraph } = await import("../extension/lib/emscripten-module-audit.js");
  for (const linked of [false, true]) {
    const { graph, files } = await graphFixture(linked);
    const result = await auditEmscriptenGraph(graph, files);
    assertEquals(result.modules.length, linked ? 2 : 1);
    assertEquals(result.allocation, { memoryBytes: 0, tableElements: 0 });
  }
});

Deno.test("emscripten graph audit: missing dependency, wrong type and untrusted provider are independent semantic refusals", async () => {
  const { auditEmscriptenGraph } = await import("../extension/lib/emscripten-module-audit.js");
  const { assertRejects } = await import("jsr:@std/assert@1");
  const { graph, files } = await graphFixture(true);
  const missing = structuredClone(graph); missing.linkGraph.dependencies = [];
  await assertRejects(() => auditEmscriptenGraph(missing, files), Error, "dependency_missing");
  const wrong = structuredClone(graph); wrong.modules[0].imports[0].type = { params: ["f64"], results: ["i32"] };
  await assertRejects(() => auditEmscriptenGraph(wrong, files), Error, "module_type_mismatch");
  const wrongExport = structuredClone(graph); wrongExport.modules[0].imports[0].provider.exportName = "__wasm_call_ctors";
  await assertRejects(() => auditEmscriptenGraph(wrongExport, files), Error, "provider_type_mismatch");
  const invented = structuredClone(graph); invented.modules[0].imports[1].provider.binding = "returnZero";
  await assertRejects(() => auditEmscriptenGraph(invented, files), Error, "provider_untrusted");
  const missingExport = structuredClone(graph); missingExport.modules[0].imports[0].provider.exportName = "absent";
  await assertRejects(() => auditEmscriptenGraph(missingExport, files), Error, "provider_export_missing");
});

Deno.test("emscripten graph audit: glue tamper and repinned unreviewed glue fail different gates", async () => {
  const { auditEmscriptenGraph } = await import("../extension/lib/emscripten-module-audit.js");
  const { assertRejects } = await import("jsr:@std/assert@1");
  const { graph, files } = await graphFixture();
  const glue = graph.assets[0], changed = files.get(glue.path)!.slice();
  changed[changed.length - 1] ^= 1; files.set(glue.path, changed);
  await assertRejects(() => auditEmscriptenGraph(graph, files), Error, "asset_digest_mismatch");
  glue.sha256 = await sha256HexBytes(changed);
  await assertRejects(() => auditEmscriptenGraph(graph, files), Error, "provider_untrusted");
});

Deno.test("emscripten module audit: scanner allows only the one validate-only site", async () => {
  const { scanShippedJs } = await import("../scripts/scan-shipped.mjs");
  const path = "extension/lib/emscripten-module-audit.js";
  const source = await Deno.readTextFile(path);
  const scan = (file: string, text: string) => scanShippedJs([file], { readText: async () => text });
  assertEquals(await scan(path, source), []);
  for (const api of ["compile", "instantiate", "Instance", "Module"]) {
    const violations = await scan(path, source.replace("WebAssembly.validate(bytes)", `WebAssembly.${api}(bytes)`));
    assert(violations.some(v => v.includes("dynamic WebAssembly")), api);
  }
  for (const mutated of [
    source.replace("WebAssembly.validate(bytes)", "WebAssembly.validate(other)"),
    source.replace("WebAssembly.validate(bytes)", "WebAssembly.validate(bytes, {})"),
    source + "\nWebAssembly.validate(bytes);\n",
  ]) assert((await scan(path, mutated)).some(v => v.includes("dynamic WebAssembly")));
  assert((await scan("extension/lib/other.js", source)).some(v => v.includes("dynamic WebAssembly")));
});

// Fixed binary encodings and hand-written expectations: neither the fixture
// bytes nor expected metadata come from the auditor or its section builders.
const mvpTable = { element: "funcref", min: 1, max: 1 };
const internalMutableGlobal = [{ index: 0, type: { value: "i32", mutable: true }, initializer: { op: "i32.const", value: 7 } }];
for (const fixture of [
  {
    name: "two defined tables require reference-types",
    bytes: [0, 97, 115, 109, 1, 0, 0, 0, 4, 9, 2, 112, 1, 1, 1, 112, 1, 1, 1],
    imports: [],
    tables: [{ index: 0, type: mvpTable }, { index: 1, type: mvpTable }],
    globals: [], features: ["reference-types"],
  },
  {
    name: "two imported tables require reference-types",
    bytes: [0, 97, 115, 109, 1, 0, 0, 0, 2, 19, 2, 1, 109, 1, 97, 1, 112, 1, 1, 1, 1, 109, 1, 98, 1, 112, 1, 1, 1],
    imports: [
      { module: "m", symbol: "a", kind: "table", index: 0, type: mvpTable },
      { module: "m", symbol: "b", kind: "table", index: 1, type: mvpTable },
    ],
    tables: [], globals: [], features: ["reference-types"],
  },
  {
    name: "one imported plus one defined table require reference-types",
    bytes: [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 109, 1, 97, 1, 112, 1, 1, 1, 4, 5, 1, 112, 1, 1, 1],
    imports: [{ module: "m", symbol: "a", kind: "table", index: 0, type: mvpTable }],
    tables: [{ index: 1, type: mvpTable }],
    globals: [], features: ["reference-types"],
  },
  {
    name: "one defined funcref table and internal mutable global remain MVP",
    bytes: [0, 97, 115, 109, 1, 0, 0, 0, 4, 5, 1, 112, 1, 1, 1, 6, 6, 1, 127, 1, 65, 7, 11],
    imports: [], tables: [{ index: 0, type: mvpTable }],
    globals: internalMutableGlobal, features: [],
  },
  {
    name: "one imported funcref table and internal mutable global remain MVP",
    bytes: [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 109, 1, 97, 1, 112, 1, 1, 1, 6, 6, 1, 127, 1, 65, 7, 11],
    imports: [{ module: "m", symbol: "a", kind: "table", index: 0, type: mvpTable }],
    tables: [], globals: internalMutableGlobal, features: [],
  },
]) Deno.test(`emscripten module audit: ${fixture.name}`, () => {
  const bytes = Uint8Array.from(fixture.bytes);
  assert(WebAssembly.validate(bytes), "positive control must be engine-valid");
  const scan = auditEmscriptenModule(bytes);
  assertEquals(scan.imports, fixture.imports);
  assertEquals(scan.tables, fixture.tables);
  assertEquals(scan.globals, fixture.globals);
  assertEquals(scan.features, fixture.features);
});
