// Closed schema-2 records. Inventory trust and execution eligibility are separate
// from structural graph validity; none of these functions loads package code.
import { exactKeys, assertRelativePath, canonicalJson, WasmPackageAuthorityError, parseCanonicalJson } from "./wasm-package-authority.js";
import { sha256Hex } from "./pure.js";

const fail = (code, path = "schema2") => { throw new WasmPackageAuthorityError(code, path); };
const keys = (o, names) => exactKeys(o, names.split(" "));
const eq = (a, b) => canonicalJson(a) === canonicalJson(b);
const hash = v => sha256Hex(canonicalJson(v));
const id = v => { if (typeof v !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(v)) fail("manifest_id_invalid"); };
const text = v => { if (typeof v !== "string" || !/^[\x20-\x7e]{1,256}$/u.test(v)) fail("manifest_string_invalid"); };
const digest = v => { if (typeof v !== "string" || !/^[0-9a-f]{64}$/u.test(v)) fail("digest_invalid"); };
const count = v => { if (!Number.isSafeInteger(v) || v < 0) fail("manifest_integer_invalid"); };
const list = v => { if (!Array.isArray(v)) fail("manifest_array_invalid"); return v; };
const bool = v => { if (typeof v !== "boolean") fail("manifest_boolean_invalid"); };
function ordered(values, key = v => v) {
  let prior = "";
  for (const value of list(values)) { const next = key(value); text(next); if (next <= prior) fail("manifest_order"); prior = next; }
}
function valueType(v) { if (!["i32", "i64", "f32", "f64", "v128", "funcref"].includes(v)) fail("wasm_type_unsupported"); }
function externalType(kind, type) {
  if (kind === "function") {
    keys(type, "params results"); list(type.params).forEach(valueType); list(type.results).forEach(valueType);
    if (type.results.length > 1) fail("multi_value_unsupported");
  } else if (kind === "memory" || kind === "table") {
    keys(type, kind === "memory" ? "address shared min max" : "element min max");
    if (kind === "memory") { if (type.address !== "i32") fail("memory64_rejected"); bool(type.shared); }
    else if (type.element !== "funcref") fail("table_type_unsupported");
    count(type.min); if (type.max !== null) { count(type.max); if (type.min > type.max) fail("memory_limits_invalid"); }
    if (kind === "memory" && (type.min > 65536 || (type.max !== null && type.max > 65536))) fail("memory_limits_invalid");
  } else if (kind === "global") { keys(type, "value mutable"); valueType(type.value); bool(type.mutable); }
  else if (kind === "tag") { keys(type, "attribute signature"); if (type.attribute !== 0) fail("tag_attribute_invalid"); externalType("function", type.signature); if (type.signature.results.length) fail("tag_signature_invalid"); }
  else fail("wasm_kind_invalid");
}
function constant(expr) {
  if (expr?.op === "i32.const" || expr?.op === "i64.const") {
    keys(expr, "op value");
    if (expr.op === "i32.const") { if (!Number.isInteger(expr.value) || expr.value < -2147483648 || expr.value > 2147483647) fail("constant_invalid"); }
    else { if (typeof expr.value !== "string" || !/^(?:0|-?[1-9][0-9]{0,18})$/u.test(expr.value)) fail("constant_invalid"); const n = BigInt(expr.value); if (n < -(1n << 63n) || n >= (1n << 63n)) fail("constant_invalid"); }
  } else if (expr?.op === "f32.const" || expr?.op === "f64.const") {
    keys(expr, "op bits"); if (!(expr.op === "f32.const" ? /^[0-9a-f]{8}$/u : /^[0-9a-f]{16}$/u).test(expr.bits)) fail("constant_invalid");
  } else if (expr?.op === "global.get" || expr?.op === "ref.func") { keys(expr, "op index"); count(expr.index); }
  else if (expr?.op === "ref.null") { keys(expr, "op type"); if (expr.type !== "funcref") fail("constant_invalid"); }
  else fail("constant_expression_unsupported");
}
function moduleDeclaration(m) {
  keys(m, "asset imports exports memories tables globals tags start dylink"); id(m.asset);
  for (const imported of list(m.imports)) {
    keys(imported, "module symbol kind index type provider"); text(imported.module); text(imported.symbol); count(imported.index); externalType(imported.kind, imported.type);
    const p = imported.provider;
    if (p?.kind === "glue") { keys(p, "kind asset binding"); text(p.binding); }
    else if (p?.kind === "module") { keys(p, "kind asset exportName"); text(p.exportName); }
    else fail("provider_unsupported"); id(p.asset);
  }
  const names = new Set();
  for (const e of list(m.exports)) { keys(e, "name kind index type"); text(e.name); if (names.has(e.name)) fail("export_name_duplicate"); names.add(e.name); count(e.index); externalType(e.kind, e.type); }
  for (const [field, kind] of [["memories", "memory"], ["tables", "table"], ["globals", "global"], ["tags", "tag"]]) {
    let previous = -1;
    for (const d of list(m[field])) { keys(d, kind === "global" ? "index type initializer" : "index type"); count(d.index); if (d.index <= previous) fail("definition_order"); previous = d.index; externalType(kind, d.type); if (kind === "global") constant(d.initializer); }
  }
  if (m.start !== null) count(m.start);
  if (m.dylink !== null) {
    keys(m.dylink, "memorySize memoryAlignment tableSize tableAlignment needed");
    for (const k of ["memorySize", "memoryAlignment", "tableSize", "tableAlignment"]) { count(m.dylink[k]); if (m.dylink[k] > 0xffffffff) fail("dylink_overflow"); }
    if (m.dylink.memoryAlignment > 32 || m.dylink.tableAlignment > 32) fail("dylink_alignment_overflow");
    list(m.dylink.needed).forEach(n => assertRelativePath(n, "needed"));
  }
}
function asset(a) {
  keys(a, "id role path sha256 size"); id(a.id); assertRelativePath(a.path, "asset.path"); digest(a.sha256); count(a.size); if (!a.size) fail("asset_size_invalid");
  if (!["adapter", "glue", "main-wasm", "side-wasm", "pthread-bootstrap", "data"].includes(a.role)) fail("asset_role_invalid");
  if (a.role.endsWith("wasm") && a.path !== `extension/wasm/cas/${a.sha256}.wasm`) fail("asset_cas_path_mismatch");
}
function filePin(p) { keys(p, "path sha256 size"); assertRelativePath(p.path, "provenance.path"); digest(p.sha256); count(p.size); if (!p.size) fail("provenance_incomplete"); }

export function validateEmscriptenManifest(m) {
  const r = m.runtime;
  keys(r, "kind abi compiler glue features profileDigest");
  if (r.kind !== "emscripten-module-v1" || r.abi !== "emscripten-6.0.0-thin-native-v1") fail("runtime_unsupported");
  if (!eq(r.compiler, { version: "6.0.0", emsdkCommit: "d223ae73c6998296e3ab27cf81dc2c2c9fd383de", emscriptenCommit: "afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3" })) fail("compiler_profile_unsupported");
  if (!eq(r.glue, { format: "es-module-factory", environment: "worker", dynamicExecution: false, filesystem: false })) fail("glue_profile_unsupported");
  ordered(r.features);
  if (r.features.some(f => !["mutable-globals", "sign-extension", "nontrapping-fptoint", "bulk-memory", "reference-types", "simd128", "exception-tags"].includes(f))) fail("runtime_feature_unsupported");
  const { profileDigest, ...profile } = r; if (profileDigest !== hash(profile)) fail("profile_digest_mismatch");
  ordered(m.assets, a => a.id); m.assets.forEach(asset);
  if (new Set(m.assets.map(a => a.path)).size !== m.assets.length) fail("asset_path_duplicate");
  for (const a of m.assets.filter(a => ["glue", "adapter", "pthread-bootstrap"].includes(a.role))) {
    const prefix = `extension/wasm/runtime/${m.package.name}/${m.package.version}/`;
    if (!a.path.startsWith(prefix) || !a.path.endsWith(".mjs")) fail("asset_runtime_path_invalid");
  }
  const e = m.entry; keys(e, "adapterId adapterAsset glueAsset mainAsset operations");
  for (const k of ["adapterId", "adapterAsset", "glueAsset", "mainAsset"]) id(e[k]);
  for (const [field, role] of [["adapterAsset", "adapter"], ["glueAsset", "glue"], ["mainAsset", "main-wasm"]]) if (m.assets.filter(a => a.role === role).length !== 1 || !m.assets.some(a => a.id === e[field] && a.role === role)) fail("entry_asset_mismatch");
  ordered(e.operations, op => op.id); const tools = new Set();
  for (const op of e.operations) {
    keys(op, "id toolId kind exportName params result capabilities replayClass io"); id(op.id); id(op.toolId);
    if (op.kind !== "native-scalar-v1" || !/^[A-Za-z0-9_.$-]{1,64}$/u.test(op.exportName) || !["i32", "f64"].includes(op.result)) fail("operation_invalid");
    if (!eq(op.io, { kind: "none" })) fail("operation_io_unsupported");
    const names = new Set();
    for (const p of list(op.params)) { keys(p, "name type minimum maximum"); id(p.name); if (names.has(p.name)) fail("parameter_duplicate"); names.add(p.name); if (!["i32", "f64"].includes(p.type) || typeof p.minimum !== "number" || typeof p.maximum !== "number" || !Number.isFinite(p.minimum) || !Number.isFinite(p.maximum) || p.minimum > p.maximum) fail("parameter_invalid"); if (p.type === "i32" && (!Number.isInteger(p.minimum) || !Number.isInteger(p.maximum) || p.minimum < -2147483648 || p.maximum > 2147483647)) fail("parameter_invalid"); }
    const tool = m.tools.find(t => t.toolId === op.toolId);
    if (!tool || tools.has(op.toolId) || tool.digest !== hash(op) || !eq(tool.capabilities, op.capabilities) || tool.replayClass !== op.replayClass) fail("operation_tool_mismatch"); tools.add(op.toolId);
  }
  if (!tools.size || tools.size !== m.tools.length) fail("operation_tool_mismatch");
  ordered(m.modules, d => d.asset); m.modules.forEach(moduleDeclaration);
  keys(m.linkGraph, "policy main dependencies"); id(m.linkGraph.main);
  if (!["none", "eager"].includes(m.linkGraph.policy) || m.linkGraph.main !== e.mainAsset) fail("link_policy_mismatch");
  let previousDependency = null;
  for (const d of list(m.linkGraph.dependencies)) {
    keys(d, "from name to"); id(d.from); id(d.to); assertRelativePath(d.name, "dependency.name");
    if (previousDependency && (d.from < previousDependency.from || (d.from === previousDependency.from && d.name <= previousDependency.name))) fail("manifest_order");
    previousDependency = d;
  }
  const p = m.provenance; keys(p, "record comparison hermeticReprovisioned"); filePin(p.record);
  if (p.comparison !== "same-sdk-byte-identical" || p.hermeticReprovisioned !== false || m.build.reproducible !== false) fail("provenance_claim_invalid");
  const resources = m.resources; keys(resources, "class memory table threads io lifecycle");
  keys(resources.memory, "owner index initialPages maxPages growth"); id(resources.memory.owner); [resources.memory.index, resources.memory.initialPages, resources.memory.maxPages].forEach(count); bool(resources.memory.growth);
  keys(resources.table, "owner index initialElements maxElements growth"); id(resources.table.owner); [resources.table.index, resources.table.initialElements, resources.table.maxElements].forEach(count); bool(resources.table.growth);
  if (!eq(resources.threads, { mode: "none" }) || !eq(resources.io, { filesystem: "none", network: false, clock: false, random: false }) || !eq(resources.lifecycle, { freshInstance: true, startupMs: 10000, callMs: 30000, concurrentJobs: 1 })) fail("resource_profile_unsupported");
  if (resources.class !== "em32-unshared-fixed-16") fail("resource_profile_unsupported");
}

export function emscriptenIdentity(m) {
  const { runtime, assets, entry, modules, linkGraph, resources, provenance } = m;
  const graphDigest = hash({ runtime, assets, entry, modules, linkGraph, resources, provenance });
  const operationDigests = entry.operations.map(op => ({ id: op.id, digest: hash(op) }));
  const tools = m.tools.map(t => ({ id: t.toolId, digest: t.digest, capabilityDigest: t.capabilityDigest }));
  return { graphDigest, operationDigests, capabilityDigest: hash({ runtime, graphDigest, operationDigests, tools }) };
}

export function validateEmscriptenProvenance(raw, m) {
  const p = parseCanonicalJson(raw);
  keys(p, "format toolchain sources dependencies patches buildScript argv environment outputAssets comparison");
  if (p.format !== "cap-emscripten-admission-provenance-v1") fail("provenance_format");
  const pin = a => {
    keys(a, "name source revision sha256 size"); text(a.name); text(a.source); text(a.revision); digest(a.sha256); count(a.size); if (!a.size) fail("provenance_incomplete");
    if (a.source.startsWith("https:")) { const url = new URL(a.source); if (url.protocol !== "https:" || url.username || url.password) fail("provenance_source_invalid"); }
    else assertRelativePath(a.source, "provenance.source");
  };
  for (const k of ["toolchain", "sources", "patches"]) { ordered(p[k], a => a.name); p[k].forEach(pin); }
  if (!p.toolchain.length || !p.sources.length) fail("provenance_incomplete");
  ordered(p.dependencies, a => a.name);
  for (const d of p.dependencies) { keys(d, "name version source license"); text(d.name); text(d.version); pin(d.source); pin(d.license); }
  pin(p.buildScript); list(p.argv).forEach(text); if (!p.argv.length) fail("provenance_incomplete");
  keys(p.environment, "SOURCE_DATE_EPOCH"); if (typeof p.environment.SOURCE_DATE_EPOCH !== "string" || !/^(0|[1-9][0-9]*)$/u.test(p.environment.SOURCE_DATE_EPOCH)) fail("provenance_environment");
  ordered(p.outputAssets); p.outputAssets.forEach(id);
  if (!eq(p.outputAssets, m.assets.map(a => a.id))) fail("provenance_output_mismatch");
  const c = p.comparison; keys(c, "kind buildA buildB hermeticReprovisioned assets"); pin(c.buildA); pin(c.buildB); ordered(c.assets); c.assets.forEach(id);
  if (c.kind !== "same-sdk-byte-identical" || c.hermeticReprovisioned !== false || !eq(c.assets, [m.entry.glueAsset, m.entry.mainAsset].sort())) fail("provenance_comparison_scope");
  const adapter = m.assets.find(a => a.id === m.entry.adapterAsset);
  if (!p.sources.some(s => s.sha256 === adapter.sha256 && s.size === adapter.size && s.revision === `sha256:${s.sha256}`)) fail("adapter_source_provenance");
  return p;
}

/** Eligibility is deliberately narrower than structural image/link validity. */
export function assertEmscriptenNumericEligibility(m, graph) {
  if (m.linkGraph.policy !== "none") fail("link_runtime_unsupported");
  if (m.assets.some(a => a.role === "pthread-bootstrap")) fail("threads_unsupported");
  if (m.assets.length !== 3 || m.modules.length !== 1) fail("numeric_graph_unsupported");
  if (!eq(graph.features, m.runtime.features)) fail("runtime_feature_mismatch");
  const main = graph.modules[0];
  if (main.asset !== m.entry.mainAsset || main.imports.length || main.tags.length || main.start !== null || main.dylink !== null || graph.features.length) fail("numeric_abi_unsupported");
  if (!eq(main.memories, [{ index: 0, type: { address: "i32", shared: false, min: 256, max: 256 } }]) || !eq(main.tables, [{ index: 0, type: { element: "funcref", min: 1, max: 1 } }])) fail("resource_profile_unsupported");
  if (!eq(m.resources.memory, { owner: main.asset, index: 0, initialPages: 256, maxPages: 256, growth: false }) || !eq(m.resources.table, { owner: main.asset, index: 0, initialElements: 1, maxElements: 1, growth: false })) fail("resource_profile_unsupported");
  const op = m.entry.operations[0];
  if (m.entry.adapterId !== "cap-a0-numeric-v1" || m.entry.operations.length !== 1 || !eq(op.params, ["value", "weight", "bias"].map(name => ({ name, type: "f64", minimum: -1000000, maximum: 1000000 }))) || op.exportName !== "cap_weighted_sum" || op.result !== "f64" || !eq(op.capabilities, ["compute"]) || op.replayClass !== "read-only") fail("operation_profile_unsupported");
  if (!main.exports.some(e => e.name === op.exportName && e.kind === "function" && eq(e.type, { params: ["f64", "f64", "f64"], results: ["f64"] }))) fail("operation_export_mismatch");
}
