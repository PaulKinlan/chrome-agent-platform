// Typed, validate-only inspection for the closed Emscripten admission profile.
// No instance, import implementation, constructor or package JavaScript is run.
import { WasmPackageAuthorityError, canonicalJson, exactKeys, assertRelativePath } from "./wasm-package-authority.js";
import { sha256HexBytes } from "./pure.js";

const fail = (code, detail = null) => { throw new WasmPackageAuthorityError(code, "wasm", detail); };
const TYPES = new Map([[0x7f, "i32"], [0x7e, "i64"], [0x7d, "f32"], [0x7c, "f64"], [0x7b, "v128"], [0x70, "funcref"]]);
const KINDS = ["function", "table", "memory", "global", "tag"];
const ORDER = [1, 2, 3, 4, 5, 13, 6, 7, 8, 9, 12, 10, 11];
const decoder = new TextDecoder("utf-8", { fatal: true });

/** @typedef {{params:string[],results:string[]}} FunctionType */
/** @typedef {{address:string,shared:boolean,min:number,max:number|null}} MemoryType */
/** @typedef {{element:string,min:number,max:number|null}} TableType */
/** @typedef {{value:string,mutable:boolean}} GlobalType */
/** @typedef {{attribute:number,signature:FunctionType}} TagType */
/** @typedef {FunctionType|MemoryType|TableType|GlobalType|TagType} ExternalType */
/** @typedef {{op:string,value?:number|string,bits?:string,index?:number,type?:string}} ConstantExpression */
/** @typedef {{memorySize:number,memoryAlignment:number,tableSize:number,tableAlignment:number,needed:string[]}} Dylink */
/** @typedef {{imports:{module:string,symbol:string,kind:string,index:number,type:ExternalType}[],exports:{name:string,kind:string,index:number,type:ExternalType}[],memories:{index:number,type:MemoryType}[],tables:{index:number,type:TableType}[],globals:{index:number,type:GlobalType,initializer:ConstantExpression}[],tags:{index:number,type:TagType}[],start:number|null,dylink:Dylink|null}} ModuleMetadata */

class Reader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  get remaining() { return this.bytes.length - this.offset; }
  byte() { if (!this.remaining) fail("section_framing"); return this.bytes[this.offset++]; }
  take(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.remaining) fail("section_size_overflow");
    const bytes = this.bytes.subarray(this.offset, this.offset + n); this.offset += n; return bytes;
  }
  // Wasm permits padded LEBs. Check their bit width/sign, not minimal encoding.
  leb(bits, signed = false) {
    let value = 0n;
    for (let i = 0; i < Math.ceil(bits / 7); i++) {
      const b = this.byte();
      value |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) {
        if (signed && (b & 64)) value -= 1n << BigInt((i + 1) * 7);
        const low = signed ? -(1n << BigInt(bits - 1)) : 0n;
        const high = (1n << BigInt(bits - (signed ? 1 : 0))) - 1n;
        if (value < low || value > high) fail("leb_overflow");
        return value;
      }
    }
    fail("leb_overflow");
  }
  u32() { return Number(this.leb(32)); }
  name() {
    let text;
    try { text = decoder.decode(this.take(this.u32())); } catch (e) { if (e instanceof WasmPackageAuthorityError) throw e; fail("wasm_name_invalid"); }
    if (!/^[\x20-\x7e]{0,256}$/u.test(text)) fail("wasm_name_invalid");
    return text;
  }
  vector(read) {
    const count = this.u32();
    // Every supported vector entry consumes at least one byte. Never allocate
    // from an attacker count before checking the enclosing payload.
    if (count > this.remaining) fail("vector_framing");
    const out = [];
    for (let i = 0; i < count; i++) out.push(read());
    return out;
  }
  end() { if (this.remaining) fail("section_framing"); }
}

function at(values, index) { if (index >= values.length) fail("wasm_index_invalid"); return values[index]; }
function valueType(r, features) {
  const type = TYPES.get(r.byte());
  if (!type) fail("wasm_type_unsupported");
  if (type === "v128") features.add("simd128");
  if (type === "funcref") features.add("reference-types");
  return type;
}
function limits(r, memory) {
  const flags = r.u32();
  if (flags & 4) fail(memory ? "memory64_rejected" : "table64_rejected");
  if (flags > (memory ? 3 : 1)) fail("limits_flags_unknown");
  const min = r.u32(), max = flags & 1 ? r.u32() : null;
  if ((max !== null && min > max) || (memory && (min > 65536 || (max !== null && max > 65536)))) fail("memory_limits_invalid");
  if (memory && (flags & 2) && max === null) fail("memory_shared_max_missing");
  return memory ? { address: "i32", shared: Boolean(flags & 2), min, max } : { element: "funcref", min, max };
}
function objectType(r, kind, types, features) {
  if (kind === "function") return at(types, r.u32());
  if (kind === "memory") return limits(r, true);
  if (kind === "table") {
    if (r.byte() !== 0x70) fail("table_type_unsupported");
    return limits(r, false);
  }
  if (kind === "global") {
    const value = valueType(r, features), mutable = r.byte();
    if (mutable > 1) fail("global_mutability_invalid");
    return { value, mutable: Boolean(mutable) };
  }
  if (kind === "tag") {
    features.add("exception-tags");
    if (r.byte() !== 0) fail("tag_attribute_invalid");
    const signature = at(types, r.u32());
    if (signature.results.length) fail("tag_signature_invalid");
    return { attribute: 0, signature };
  }
  fail("wasm_kind_invalid");
}
function constant(r, features) {
  const op = r.byte(); let expr;
  if (op === 0x41) expr = { op: "i32.const", value: Number(r.leb(32, true)) };
  else if (op === 0x42) expr = { op: "i64.const", value: String(r.leb(64, true)) };
  else if (op === 0x43 || op === 0x44) expr = { op: op === 0x43 ? "f32.const" : "f64.const", bits: [...r.take(op === 0x43 ? 4 : 8)].reverse().map(b => b.toString(16).padStart(2, "0")).join("") };
  else if (op === 0x23) expr = { op: "global.get", index: r.u32() };
  else if (op === 0xd0) { features.add("reference-types"); if (r.byte() !== 0x70) fail("wasm_type_unsupported"); expr = { op: "ref.null", type: "funcref" }; }
  else if (op === 0xd2) { features.add("reference-types"); expr = { op: "ref.func", index: r.u32() }; }
  else fail("constant_expression_unsupported");
  if (r.byte() !== 0x0b) fail("constant_expression_unsupported");
  return expr;
}

function instructions(r, features, counts) {
  let depth = 1;
  while (depth) {
    const op = r.byte();
    if (op === 0x02 || op === 0x03 || op === 0x04) {
      const block = r.byte();
      if (block !== 0x40 && ![0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70].includes(block)) fail("block_type_unsupported");
      if (block === 0x7b) features.add("simd128");
      if (block === 0x70) features.add("reference-types");
      depth++;
    } else if (op === 0x0b) depth--;
    else if ([0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24].includes(op)) r.u32();
    else if (op === 0x0e) { r.vector(() => r.u32()); r.u32(); }
    else if (op === 0x11) { r.u32(); if (r.u32() !== 0) fail("multi_table_unsupported"); }
    else if (op === 0x1c) { features.add("reference-types"); const ts = r.vector(() => valueType(r, features)); if (ts.length !== 1) fail("select_type_unsupported"); }
    else if (op === 0x25 || op === 0x26) { features.add("reference-types"); r.u32(); }
    else if (op >= 0x28 && op <= 0x3e) { if (r.u32() > 4) fail("memory_alignment_invalid"); r.u32(); }
    else if (op === 0x3f || op === 0x40) { if (r.byte() !== 0) fail("multi_memory_rejected"); }
    else if (op === 0x41) r.leb(32, true);
    else if (op === 0x42) r.leb(64, true);
    else if (op === 0x43 || op === 0x44) r.take(op === 0x43 ? 4 : 8);
    else if (op >= 0xc0 && op <= 0xc4) features.add("sign-extension");
    else if (op === 0xd0) { features.add("reference-types"); if (r.byte() !== 0x70) fail("wasm_type_unsupported"); }
    else if (op === 0xd1 || op === 0xd2) { features.add("reference-types"); if (op === 0xd2) r.u32(); }
    else if (op === 0xfc) {
      const sub = r.u32();
      if (sub <= 7) features.add("nontrapping-fptoint");
      else if (sub >= 8 && sub <= 17) {
        features.add(sub >= 15 ? "reference-types" : "bulk-memory");
        if (sub === 8 || sub === 9) { counts.dataInstructions.push(r.u32()); if (sub === 8 && r.byte() !== 0) fail("multi_memory_rejected"); }
        else if (sub === 10) { if (r.byte() !== 0 || r.byte() !== 0) fail("multi_memory_rejected"); }
        else if (sub === 11) { if (r.byte() !== 0) fail("multi_memory_rejected"); }
        else if (sub === 12 || sub === 14) { r.u32(); r.u32(); }
        else r.u32();
      } else fail("opcode_unsupported", sub);
    } else if (op === 0xfd) {
      const sub = r.u32(); features.add("simd128");
      // The closed SIMD subset has explicit immediate formats; engine validation
      // checks reserved encodings and lane/alignment/type constraints.
      if (sub <= 11 || sub === 92 || sub === 93) { if (r.u32() > 4) fail("memory_alignment_invalid"); r.u32(); }
      else if (sub === 12 || sub === 13) r.take(16);
      else if (sub >= 21 && sub <= 34) r.byte();
      else if (sub >= 84 && sub <= 91) { if (r.u32() > 4) fail("memory_alignment_invalid"); r.u32(); r.byte(); }
      else if (!((sub >= 14 && sub <= 20) || (sub >= 35 && sub <= 83) || (sub >= 94 && sub <= 255))) fail("opcode_unsupported", sub);
    } else if (!([0x00, 0x01, 0x05, 0x0f, 0x1a, 0x1b].includes(op) || (op >= 0x45 && op <= 0xbf))) fail("opcode_unsupported", op);
  }
  r.end();
}

function dylink(r) {
  let info = null, needed = []; const seen = new Set();
  while (r.remaining) {
    const kind = r.byte(), sub = new Reader(r.take(r.u32()));
    if (seen.has(kind)) fail("dylink_duplicate_subsection"); seen.add(kind);
    if (kind === 1) {
      info = { memorySize: sub.u32(), memoryAlignment: sub.u32(), tableSize: sub.u32(), tableAlignment: sub.u32() };
      // Bound before any shift: a u32 exponent must never allocate a giant BigInt.
      if (info.memoryAlignment > 32 || info.tableAlignment > 32) fail("dylink_alignment_overflow");
    } else if (kind === 2) needed = sub.vector(() => {
      const name = sub.name();
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(name) || name.split("/").some(p => !p || p === "." || p === "..")) fail("path_escape");
      return name;
    });
    else fail("dylink_subsection_unsupported");
    sub.end();
  }
  if (!info) fail("dylink_memory_info_missing");
  return { ...info, needed };
}

/** Complete typed metadata plus measured features; not package admission. */
export function auditEmscriptenModule(input) {
  if (!(input instanceof Uint8Array)) fail("wasm_bytes_required");
  const bytes = input;
  const r = new Reader(bytes);
  if ([...r.take(8)].join(",") !== "0,97,115,109,1,0,0,0") fail("wasm_header_invalid");
  const features = new Set(), types = [], functions = [];
  const spaces = Object.fromEntries(KINDS.map(k => [k, []]));
  /** @type {ModuleMetadata} */
  const result = { imports: [], exports: [], memories: [], tables: [], globals: [], tags: [], start: null, dylink: null };
  const fields = { memory: "memories", table: "tables", global: "globals", tag: "tags" };
  const counts = { code: 0, data: 0, dataCount: null, dataInstructions: [] };
  const seen = new Set(); let order = -1;
  while (r.remaining) {
    const id = r.byte(), s = new Reader(r.take(r.u32()));
    if (id === 0) {
      if (s.name() !== "dylink.0") fail("custom_section_unsupported");
      if (result.dylink) fail("dylink_duplicate_section"); result.dylink = dylink(s); continue;
    }
    const rank = ORDER.indexOf(id);
    if (rank === -1) fail("unknown_section");
    if (seen.has(id)) fail("duplicate_section");
    if (rank < order) fail("section_order"); seen.add(id); order = rank;
    if (id === 1) for (const type of s.vector(() => {
      if (s.byte() !== 0x60) fail("wasm_type_unsupported");
      const params = s.vector(() => valueType(s, features)), results = s.vector(() => valueType(s, features));
      if (results.length > 1) fail("multi_value_unsupported"); return { params, results };
    })) types.push(type);
    else if (id === 2) result.imports = s.vector(() => {
      const module = s.name(), symbol = s.name(), kind = KINDS[s.byte()];
      const type = objectType(s, kind, types, features), index = spaces[kind].length;
      spaces[kind].push(type);
      if (kind === "global" && type.mutable) features.add("mutable-globals");
      return { module, symbol, kind, index, type };
    });
    else if (id === 3) for (const type of s.vector(() => at(types, s.u32()))) { functions.push(type); spaces.function.push(type); }
    else if ([4, 5, 6, 13].includes(id)) {
      const kind = ({ 4: "table", 5: "memory", 6: "global", 13: "tag" })[id];
      result[fields[kind]] = s.vector(() => {
        const type = objectType(s, kind, types, features), index = spaces[kind].length;
        const def = { index, type };
        if (kind === "global") def.initializer = constant(s, features);
        spaces[kind].push(type); return def;
      });
    } else if (id === 7) {
      const names = new Set(); result.exports = s.vector(() => {
        const name = s.name(), kind = KINDS[s.byte()], index = s.u32();
        if (!kind) fail("wasm_kind_invalid"); if (names.has(name)) fail("export_name_duplicate"); names.add(name);
        const type = at(spaces[kind], index);
        if (kind === "global" && type.mutable) features.add("mutable-globals");
        return { name, kind, index, type };
      });
    } else if (id === 8) {
      result.start = s.u32(); const type = at(spaces.function, result.start);
      if (type.params.length || type.results.length) fail("start_signature_invalid");
    } else if (id === 9) s.vector(() => {
      const flags = s.u32(); if (flags > 7) fail("element_mode_unsupported");
      if (flags !== 0) features.add(flags < 4 ? "bulk-memory" : "reference-types");
      if (flags === 0 || flags === 4) { at(spaces.table, 0); constant(s, features); }
      if (flags === 2 || flags === 6) { at(spaces.table, s.u32()); constant(s, features); }
      if (flags > 0 && flags < 4 && s.byte() !== 0) fail("element_kind_invalid");
      if (flags >= 5 && s.byte() !== 0x70) fail("element_type_unsupported");
      if (flags < 4) s.vector(() => at(spaces.function, s.u32()));
      else s.vector(() => constant(s, features));
    });
    else if (id === 12) { features.add("bulk-memory"); counts.dataCount = s.u32(); }
    else if (id === 10) {
      const bodies = s.u32(); if (bodies > s.remaining) fail("vector_framing"); counts.code = bodies;
      for (let i = 0; i < bodies; i++) {
        const body = new Reader(s.take(s.u32())); let locals = 0;
        body.vector(() => { locals += body.u32(); if (locals > 0xffffffff) fail("locals_overflow"); valueType(body, features); });
        instructions(body, features, counts);
      }
    } else if (id === 11) {
      const segments = s.vector(() => {
        const mode = s.u32(); if (mode > 2) fail("data_mode_unsupported");
        if (mode !== 0) features.add("bulk-memory");
        if (mode !== 1) { at(spaces.memory, mode === 2 ? s.u32() : 0); constant(s, features); }
        s.take(s.u32());
      }); counts.data = segments.length;
    }
    s.end();
  }
  if (spaces.memory.length > 1) fail("multi_memory_rejected");
  if (functions.length !== counts.code) fail("function_code_count_mismatch");
  if (counts.dataCount !== null && counts.dataCount !== counts.data) fail("data_count_mismatch");
  if (counts.dataInstructions.length && counts.dataCount === null) fail("data_count_missing");
  if (counts.dataInstructions.some(i => i >= counts.data)) fail("data_index_invalid");
  if (!WebAssembly.validate(bytes)) fail("wasm_engine_invalid");
  // MVP permits one table total, including imports in the table index space.
  if (spaces.table.length > 1) features.add("reference-types");
  return { ...result, features: [...features].sort() };
}

/** Type compatibility is structural; provider limits are not allocation sizes. */
export function compatibleEmscriptenType(kind, required, supplied) {
  if (!KINDS.includes(kind)) fail("wasm_kind_invalid");
  if (kind !== "memory" && kind !== "table") return canonicalJson(required) === canonicalJson(supplied);
  return (kind === "memory" ? required.address === supplied.address && required.shared === supplied.shared : required.element === supplied.element) &&
    supplied.min >= required.min && (required.max === null || (supplied.max !== null && supplied.max <= required.max));
}

// Reviewed emitted import-object mappings, not namespace grants. These hashes
// identify unchanged A0 glue; no function is imported or looked up reflectively.
const IMAGE_GLUE = "3c1c0e4381fe914b33dd554905d28e8dc777f1bda4bd42dcf05edd1380d7bea0";
const LINK_GLUE = "bcddb43afe69fc2fb90102bf3ab0fcf83395177098ce647659bf1ee707292d76";
function reviewedGlueProvider(asset, imported, provider) {
  if (imported.module !== "env" || imported.kind !== "function") return false;
  const resize = imported.symbol === "emscripten_resize_heap" && provider.binding === "_emscripten_resize_heap" &&
    canonicalJson(imported.type) === canonicalJson({ params: ["i32"], results: ["i32"] });
  if (asset.sha256 === LINK_GLUE) return resize;
  return asset.sha256 === IMAGE_GLUE && (resize || (imported.symbol === "__assert_fail" && provider.binding === "___assert_fail" &&
    canonicalJson(imported.type) === canonicalJson({ params: ["i32", "i32", "i32", "i32"], results: [] })));
}

/**
 * Verify bytes, declarations and the closed provider/dependency graph.
 * This structural result is NOT runtime/resource eligibility or admission.
 * @param {{assets:object[],modules:object[],linkGraph:object}} graph
 * @param {Map<string,Uint8Array>} files package-relative path -> bytes
 */
export async function auditEmscriptenGraph(graph, files) {
  exactKeys(graph, ["assets", "modules", "linkGraph"]);
  if (!(files instanceof Map) || !Array.isArray(graph.assets) || !Array.isArray(graph.modules)) fail("graph_type");
  const assets = new Map(), paths = new Set(), scans = new Map(), declarations = new Map();
  let previous = "";
  for (const asset of graph.assets) {
    exactKeys(asset, ["id", "role", "path", "sha256", "size"]);
    if (typeof asset.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(asset.id) || asset.id <= previous) fail("asset_id_order");
    previous = asset.id;
    if (!["adapter", "glue", "main-wasm", "side-wasm", "pthread-bootstrap", "data"].includes(asset.role)) fail("asset_role_invalid");
    assertRelativePath(asset.path, "asset.path");
    if (paths.has(asset.path)) fail("asset_path_duplicate"); paths.add(asset.path);
    if (!/^[0-9a-f]{64}$/u.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 1) fail("asset_identity_invalid");
    if ((asset.role === "main-wasm" || asset.role === "side-wasm") && asset.path !== `extension/wasm/cas/${asset.sha256}.wasm`) fail("asset_cas_path_mismatch");
    const bytes = files.get(asset.path);
    if (!(bytes instanceof Uint8Array) || bytes.length !== asset.size) fail("asset_size_mismatch", asset.id);
    if (await sha256HexBytes(bytes) !== asset.sha256) fail("asset_digest_mismatch", asset.id);
    assets.set(asset.id, asset);
  }
  if (files.size !== paths.size || [...files.keys()].some(path => !paths.has(path))) fail("asset_files_mismatch");
  const wasmAssets = [...assets.values()].filter(a => a.role === "main-wasm" || a.role === "side-wasm");
  if (wasmAssets.filter(a => a.role === "main-wasm").length !== 1 || [...assets.values()].filter(a => a.role === "glue").length !== 1) fail("graph_root_invalid");
  // All asset bytes are checked before any binary parsing.
  for (const asset of wasmAssets) scans.set(asset.id, auditEmscriptenModule(files.get(asset.path)));
  previous = "";
  for (const declared of graph.modules) {
    exactKeys(declared, ["asset", "imports", "exports", "memories", "tables", "globals", "tags", "start", "dylink"]);
    if (typeof declared.asset !== "string" || declared.asset <= previous || !scans.has(declared.asset)) fail("module_identity_invalid"); previous = declared.asset;
    if (!Array.isArray(declared.imports)) fail("module_imports_invalid");
    const measured = scans.get(declared.asset);
    const imports = declared.imports.map(imported => {
      exactKeys(imported, ["module", "symbol", "kind", "index", "type", "provider"]);
      const { provider, ...native } = imported;
      if (provider?.kind === "glue") exactKeys(provider, ["kind", "asset", "binding"]);
      else if (provider?.kind === "module") exactKeys(provider, ["kind", "asset", "exportName"]);
      else fail("provider_unsupported");
      return native;
    });
    const { features, ...metadata } = measured;
    const { asset, ...expected } = declared;
    if (canonicalJson({ ...expected, imports }) !== canonicalJson(metadata)) fail("module_type_mismatch", asset);
    declarations.set(asset, declared);
  }
  if (declarations.size !== scans.size) fail("module_missing");
  const links = graph.linkGraph;
  exactKeys(links, ["policy", "main", "dependencies"]);
  if (!["none", "eager"].includes(links.policy) || assets.get(links.main)?.role !== "main-wasm" || !Array.isArray(links.dependencies)) fail("link_graph_invalid");
  const edges = new Map(); previous = "";
  for (const edge of links.dependencies) {
    exactKeys(edge, ["from", "name", "to"]); assertRelativePath(edge.name, "dependency.name");
    const key = `${edge.from}\0${edge.name}`;
    if (key <= previous || !scans.has(edge.from) || assets.get(edge.to)?.role !== "side-wasm") fail("dependency_invalid"); previous = key;
    if (!scans.get(edge.from).dylink?.needed.includes(edge.name)) fail("dependency_undeclared");
    edges.set(key, edge.to);
  }
  for (const [id, scan] of scans) for (const name of scan.dylink?.needed ?? []) if (!edges.has(`${id}\0${name}`)) fail("dependency_missing");
  if (links.policy === "none" && (scans.size !== 1 || edges.size || scans.get(links.main).dylink)) fail("link_policy_mismatch");
  const visiting = new Set(), visited = new Set(), ordered = [];
  // Iterative traversal avoids attacker-controlled recursion depth.
  const stack = [[links.main, false]];
  while (stack.length) {
    const [id, leaving] = stack.pop();
    if (leaving) { visiting.delete(id); visited.add(id); ordered.push(id); continue; }
    if (visiting.has(id)) fail("dependency_cycle"); if (visited.has(id)) continue;
    visiting.add(id); stack.push([id, true]);
    const children = [...new Set((scans.get(id).dylink?.needed ?? []).map(name => edges.get(`${id}\0${name}`)))];
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], false]);
  }
  if (visited.size !== scans.size) fail("module_orphan");
  const resolve = (assetId, kind, index) => {
    const trail = new Set();
    for (;;) {
      const key = `${assetId}\0${kind}\0${index}`;
      if (trail.has(key)) fail("provider_cycle"); trail.add(key);
      const imported = declarations.get(assetId).imports.find(i => i.kind === kind && i.index === index);
      if (!imported) return;
      const provider = imported.provider, asset = assets.get(provider.asset);
      if (!asset) fail("provider_missing");
      if (provider.kind === "glue") {
        if (asset.role !== "glue" || !reviewedGlueProvider(asset, imported, provider)) fail("provider_untrusted"); return;
      }
      const supplied = scans.get(provider.asset)?.exports.find(e => e.name === provider.exportName);
      if (!supplied) fail("provider_export_missing");
      if (supplied.kind !== kind || !compatibleEmscriptenType(kind, imported.type, supplied.type)) fail("provider_type_mismatch");
      assetId = provider.asset; index = supplied.index;
    }
  };
  for (const [id, declared] of declarations) for (const imported of declared.imports) resolve(id, imported.kind, imported.index);
  let memoryBytes = 0n, tableElements = 0n;
  for (const id of ordered) {
    const info = scans.get(id).dylink; if (!info) continue;
    const align = (value, exponent, size) => {
      // Decoder already checked this; retain the arithmetic boundary locally.
      if (exponent > 32) fail("dylink_alignment_overflow");
      const alignment = 1n << BigInt(exponent);
      const end = ((value + alignment - 1n) / alignment) * alignment + BigInt(size);
      if (end > 0x100000000n) fail("dylink_allocation_overflow"); return end;
    };
    memoryBytes = align(memoryBytes, info.memoryAlignment, info.memorySize);
    tableElements = align(tableElements, info.tableAlignment, info.tableSize);
  }
  return { modules: [...scans].map(([asset, scan]) => ({ asset, ...scan })), features: [...new Set([...scans.values()].flatMap(s => s.features))].sort(), allocation: { memoryBytes: Number(memoryBytes), tableElements: Number(tableElements) } };
}
