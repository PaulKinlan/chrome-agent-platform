// lib/wasm-package-authority.js — strict bundled-lane Wasm package records.
//
// SOURCE/RECORD AUTHORITY ONLY. This module validates immutable release bytes,
// measures bounded Wasm framing/import/memory metadata, and journals mutable
// registry records. It exposes no route, tool, provider, runtime, install UI,
// permission, network, filesystem, or execution surface.

import { masterMemory } from "./memory.js";
import { sha256Hex, sha256HexBytes } from "./pure.js";

export const LANES = Object.freeze(["bundled"]);
export const WASM_PACKAGE_LIMITS = Object.freeze({
  // dptw (2026-09-03): the package SIZE ceilings (binary/manifest/section
  // bytes, tools/executables/packages/history counts, tier byte gates) are
  // gone — a bundled tool's bytes are admitted whole. What remains:
  //   - MAX_CAPABILITIES: the capability list IS the permission surface
  //     (security, not size),
  //   - tier maxPages: wasm32 memory pages — the browser's real RAM ceiling.
  MAX_CAPABILITIES: 32,
  TIERS: Object.freeze({
    tiny: Object.freeze({ maxPages: 512, maxBytes: Number.POSITIVE_INFINITY, admission: "allowed" }),
    default: Object.freeze({ maxPages: 2048, maxBytes: Number.POSITIVE_INFINITY, admission: "allowed" }),
    large: Object.freeze({ maxPages: 4096, maxBytes: Number.POSITIVE_INFINITY, admission: "allowed" }),
  }),
});

const REGISTRY_KEY = "wasmPkg";
const WAL_KEY = "__wasmTx";
const REPAIR_KEY = "wasmPkgRepair";
const HEX64_RE = /^[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40}$/u;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const PACKAGE_ID_RE = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]{1,16}(?:\.[0-9A-Za-z-]{1,16})*))?(?:\+([0-9A-Za-z-]{1,16}(?:\.[0-9A-Za-z-]{1,16})*))?$/u;
const TOKEN_RE = /^[a-z][a-z0-9.-]{0,15}$/u;
const IMPORT_MODULE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
export const BUNDLED_ALLOWED_IMPORT_MODULES = Object.freeze([
  "wasi_snapshot_preview1",
]);
const BUNDLED_ALLOWED_IMPORT_MODULE_SET = new Set(BUNDLED_ALLOWED_IMPORT_MODULES);
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const REPLAY = new Set(["read-only", "idempotent", "mutating", "unknown"]);
const PACKAGE_TYPES = new Set(["tool-bundle", "runtime", "library", "model-support"]);
const SPDX_IDS = new Set(["0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0", "PSF-2.0", "Zlib", "blessing"]);
// Licence field: either one exact SPDX token from SPDX_IDS, or one exact
// two-operand composite "<id> AND <id>" where BOTH operands are SPDX_IDS
// tokens (e.g. "MIT AND Apache-2.0", "Zlib AND Apache-2.0"). Nothing else:
// no OR, no WITH, no parentheses, no LicenseRef, no three-operand chains,
// no irregular whitespace.
export function isValidLicenseExpression(value) {
  if (typeof value !== "string") return false;
  if (SPDX_IDS.has(value)) return true;
  const parts = value.split(" AND ");
  return parts.length === 2 && SPDX_IDS.has(parts[0]) && SPDX_IDS.has(parts[1]);
}
const CAPABILITY_ALLOWLIST = new Set([
  "artifact.create", "compute", "crypto", "data.read", "data.write",
  "file.read", "file.write", "text.transform",
]);
const META_FIELDS = new Set(["category", "channel", "description", "homepage", "label", "note", "owner", "status"]);
const SECTION_NAMES = Object.freeze({
  1: "type", 2: "import", 3: "function", 4: "table", 5: "memory",
  6: "global", 7: "export", 8: "start", 9: "element", 10: "code",
  11: "data", 12: "datacount",
});
const KIND_NAMES = Object.freeze({ 0: "function", 1: "table", 2: "memory", 3: "global", 4: "tag" });
const decoder = new TextDecoder("utf-8", { fatal: true });

export class WasmPackageAuthorityError extends Error {
  constructor(code, path = "", detail = null) {
    super(`${code}${path ? ` at ${path}` : ""}`);
    this.name = "WasmPackageAuthorityError";
    this.code = code;
    this.path = path;
    this.detail = detail;
  }
}

function fail(code, path = "", detail = null) {
  throw new WasmPackageAuthorityError(code, path, detail);
}

function exactKeys(value, required, optional = [], path = "$manifest") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("manifest_type", path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("manifest_unknown_field", `${path}.${key}`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail("manifest_missing_field", `${path}.${key}`);
}

function assertAscii(value, path, { min = 0, max = 256 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) fail("manifest_string_bound", path);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code > 0x7f || code < 0x20 || code === 0x7f) fail("manifest_non_ascii", path);
  }
  return value;
}

function assertRelativePath(value, path) {
  const text = assertAscii(value, path, { min: 1, max: 128 });
  let decoded;
  try { decoded = decodeURIComponent(text); } catch { fail("path_escape", path); }
  if (!PATH_RE.test(text) || text.startsWith("/") || text.includes("\\") || text.split("/").some((part) => !part || part === "." || part === "..") || decoded !== text) {
    fail("path_escape", path);
  }
  return text;
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical_number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("canonical_type");
}

// Bounded syntax/duplicate-key pre-parser. It records object keys before the
// platform JSON parser can collapse duplicates. Escaped keys are decoded before
// comparison, so `"a"` and `"\u0061"` collide.
function preparseJson(raw) {
  let index = 0;
  let keysSeen = 0;
  const maxDepth = 24;
  const whitespace = () => { while (/[\u0009\u000a\u000d\u0020]/u.test(raw[index] ?? "")) index++; };
  const parseString = () => {
    if (raw[index++] !== '"') fail("manifest_json_syntax");
    let out = "";
    while (index < raw.length) {
      const char = raw[index++];
      if (char === '"') return out;
      if (char === "\\") {
        const escape = raw[index++];
        if ('"\\/bfnrt'.includes(escape ?? "")) {
          out += ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[escape] ?? escape);
        } else if (escape === "u") {
          const hex = raw.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail("manifest_json_syntax");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else fail("manifest_json_syntax");
      } else {
        if (char.charCodeAt(0) < 0x20) fail("manifest_json_syntax");
        out += char;
      }
    }
    fail("manifest_json_syntax");
  };
  const parseNumber = () => {
    const match = raw.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (!match) fail("manifest_json_syntax");
    index += match[0].length;
  };
  const parseValue = (depth) => {
    if (depth > maxDepth) fail("manifest_depth_bound");
    whitespace();
    const char = raw[index];
    if (char === '"') { parseString(); return; }
    if (char === "{") {
      index++;
      whitespace();
      const local = new Set();
      if (raw[index] === "}") { index++; return; }
      while (index < raw.length) {
        whitespace();
        if (raw[index] !== '"') fail("manifest_json_syntax");
        const key = parseString();
        if (++keysSeen > 4096) fail("manifest_key_bound");
        if (local.has(key)) fail("manifest_duplicate_key", key);
        local.add(key);
        whitespace();
        if (raw[index++] !== ":") fail("manifest_json_syntax");
        parseValue(depth + 1);
        whitespace();
        const separator = raw[index++];
        if (separator === "}") return;
        if (separator !== ",") fail("manifest_json_syntax");
      }
      fail("manifest_json_syntax");
    }
    if (char === "[") {
      index++;
      whitespace();
      if (raw[index] === "]") { index++; return; }
      while (index < raw.length) {
        parseValue(depth + 1);
        whitespace();
        const separator = raw[index++];
        if (separator === "]") return;
        if (separator !== ",") fail("manifest_json_syntax");
      }
      fail("manifest_json_syntax");
    }
    if (raw.startsWith("true", index)) { index += 4; return; }
    if (raw.startsWith("false", index)) { index += 5; return; }
    if (raw.startsWith("null", index)) { index += 4; return; }
    parseNumber();
  };
  parseValue(0);
  whitespace();
  if (index !== raw.length) fail("manifest_json_syntax");
}

function validateCapabilities(value, path) {
  if (!Array.isArray(value) || value.length > WASM_PACKAGE_LIMITS.MAX_CAPABILITIES) fail("capability_bound", path);
  const out = value.map((item, index) => {
    const token = assertAscii(item, `${path}[${index}]`, { min: 1, max: 16 });
    if (!TOKEN_RE.test(token)) fail("capability_invalid", `${path}[${index}]`);
    if (!CAPABILITY_ALLOWLIST.has(token)) fail("capability_not_declared", `${path}[${index}]`);
    return token;
  });
  if (new Set(out).size !== out.length || JSON.stringify(out) !== JSON.stringify([...out].sort())) fail("capability_order", path);
  return out;
}

function capabilityDigest(capabilities) {
  return sha256Hex(canonicalJson(capabilities));
}

function validateReplay(value, path) {
  if (!REPLAY.has(value)) fail("replay_class_invalid", path);
}

function validateManifestObject(manifest) {
  exactKeys(manifest, ["schemaVersion", "package", "tools", "executables", "signer", "source", "build", "sbom", "license", "meta"]);
  if (manifest.schemaVersion !== 1) fail("manifest_schema_version", "$.schemaVersion");

  exactKeys(manifest.package, ["id", "version", "name", "type"], [], "$.package");
  const packageId = assertAscii(manifest.package.id, "$.package.id", { min: 1, max: 128 });
  if (!PACKAGE_ID_RE.test(packageId) || packageId.includes("..") || packageId.startsWith(".") || packageId.endsWith(".")) fail("package_id_invalid", "$.package.id");
  const version = assertAscii(manifest.package.version, "$.package.version", { min: 5, max: 96 });
  if (!SEMVER_RE.test(version)) fail("semver_invalid", "$.package.version");
  if (!ID_RE.test(assertAscii(manifest.package.name, "$.package.name", { min: 1, max: 64 }))) fail("package_name_invalid", "$.package.name");
  if (!PACKAGE_TYPES.has(manifest.package.type)) fail("package_type_invalid", "$.package.type");

  if (!Array.isArray(manifest.tools)) fail("tool_bound", "$.tools");
  const toolIds = new Set();
  for (let index = 0; index < manifest.tools.length; index++) {
    const path = `$.tools[${index}]`;
    const tool = manifest.tools[index];
    exactKeys(tool, ["toolId", "digest", "capabilityDigest", "replayClass", "capabilities"], [], path);
    if (!ID_RE.test(assertAscii(tool.toolId, `${path}.toolId`, { min: 1, max: 64 }))) fail("tool_id_invalid", `${path}.toolId`);
    if (toolIds.has(tool.toolId)) fail("tool_id_duplicate", `${path}.toolId`);
    toolIds.add(tool.toolId);
    if (!HEX64_RE.test(tool.digest)) fail("digest_invalid", `${path}.digest`);
    const capabilities = validateCapabilities(tool.capabilities, `${path}.capabilities`);
    if (tool.capabilityDigest !== capabilityDigest(capabilities)) fail("capability_digest_mismatch", `${path}.capabilityDigest`);
    validateReplay(tool.replayClass, `${path}.replayClass`);
  }

  if (!Array.isArray(manifest.executables) || manifest.executables.length === 0) fail("executable_bound", "$.executables");
  const executableIds = new Set();
  for (let index = 0; index < manifest.executables.length; index++) {
    const path = `$.executables[${index}]`;
    const executable = manifest.executables[index];
    exactKeys(executable, ["id", "sha256", "size", "imports", "memory", "runtimeCompat", "replayClass", "capabilities", "capabilityDigest"], [], path);
    if (!ID_RE.test(assertAscii(executable.id, `${path}.id`, { min: 1, max: 64 }))) fail("executable_id_invalid", `${path}.id`);
    if (executableIds.has(executable.id)) fail("executable_id_duplicate", `${path}.id`);
    executableIds.add(executable.id);
    if (!HEX64_RE.test(executable.sha256)) fail("digest_invalid", `${path}.sha256`);
    if (!Number.isSafeInteger(executable.size) || executable.size < 1) fail("size_invalid", `${path}.size`);
    exactKeys(executable.imports, ["allowed", "disallowed"], [], `${path}.imports`);
    for (const field of ["allowed", "disallowed"]) {
      const values = executable.imports[field];
      if (!Array.isArray(values)) fail("import_bound", `${path}.imports.${field}`);
      for (let item = 0; item < values.length; item++) {
        const itemPath = `${path}.imports.${field}[${item}]`;
        const module = assertAscii(values[item], itemPath, {
          min: 1,
          max: Number.POSITIVE_INFINITY,
        });
        if (field === "disallowed" && module === "*") continue;
        if (!IMPORT_MODULE_RE.test(module)) fail("import_invalid", itemPath);
        if (field === "allowed" && !BUNDLED_ALLOWED_IMPORT_MODULE_SET.has(module)) {
          fail("import_not_allowed", itemPath, module);
        }
      }
      if (new Set(values).size !== values.length || JSON.stringify(values) !== JSON.stringify([...values].sort())) fail("import_order", `${path}.imports.${field}`);
    }
    exactKeys(executable.memory, ["tier", "initialPages", "maxPages"], [], `${path}.memory`);
    const tier = WASM_PACKAGE_LIMITS.TIERS[executable.memory.tier];
    if (!tier) fail("tier_invalid", `${path}.memory.tier`);
    if (!Number.isSafeInteger(executable.memory.initialPages) || !Number.isSafeInteger(executable.memory.maxPages) || executable.memory.initialPages < 0 || executable.memory.initialPages > executable.memory.maxPages) fail("memory_declaration_invalid", `${path}.memory`);
    if (executable.memory.maxPages > tier.maxPages || executable.size > tier.maxBytes) fail("tier_mismatch", `${path}.memory`);
    if (!Array.isArray(executable.runtimeCompat) || JSON.stringify(executable.runtimeCompat) !== '["wasm32"]') fail("runtime_incompatible", `${path}.runtimeCompat`);
    validateReplay(executable.replayClass, `${path}.replayClass`);
    const capabilities = validateCapabilities(executable.capabilities, `${path}.capabilities`);
    if (executable.capabilityDigest !== capabilityDigest(capabilities)) fail("capability_digest_mismatch", `${path}.capabilityDigest`);
  }

  exactKeys(manifest.signer, ["lane", "keyId", "alg"], ["sig"], "$.signer");
  if (manifest.signer.lane !== "bundled") fail("lane_not_admitted", "$.signer.lane");
  if (!/^[a-z0-9-]{1,64}$/u.test(assertAscii(manifest.signer.keyId, "$.signer.keyId", { min: 1, max: 64 }))) fail("signer_key_invalid", "$.signer.keyId");
  if (!new Set(["Ed25519", "none"]).has(manifest.signer.alg)) fail("signer_alg_invalid", "$.signer.alg");
  if (manifest.signer.sig != null && !/^(?:[0-9a-f]{2}){1,512}$/u.test(assertAscii(manifest.signer.sig, "$.signer.sig", { min: 2, max: 1024 }))) fail("signature_invalid", "$.signer.sig");

  exactKeys(manifest.source, ["repo", "commit"], ["tag"], "$.source");
  const repo = assertAscii(manifest.source.repo, "$.source.repo", { min: 1, max: 256 });
  try { const url = new URL(repo); if (!new Set(["https:"]).has(url.protocol) || url.username || url.password) fail("source_repo_invalid", "$.source.repo"); } catch { fail("source_repo_invalid", "$.source.repo"); }
  if (!COMMIT_RE.test(manifest.source.commit)) fail("provenance_incomplete", "$.source.commit");
  if (manifest.source.tag != null) assertAscii(manifest.source.tag, "$.source.tag", { min: 1, max: 64 });

  exactKeys(manifest.build, ["toolchain", "profile", "reproducible"], ["rebuildRef"], "$.build");
  assertAscii(manifest.build.toolchain, "$.build.toolchain", { min: 1, max: 64 });
  if (!new Set(["release", "debug"]).has(manifest.build.profile) || typeof manifest.build.reproducible !== "boolean") fail("build_invalid", "$.build");
  if (manifest.build.rebuildRef != null) assertAscii(manifest.build.rebuildRef, "$.build.rebuildRef", { min: 1, max: 128 });

  exactKeys(manifest.sbom, ["format", "sha256", "ref"], [], "$.sbom");
  if (!new Set(["cyclonedx-json@1.5", "spdx-json@2.3"]).has(manifest.sbom.format) || !HEX64_RE.test(manifest.sbom.sha256)) fail("provenance_incomplete", "$.sbom");
  assertRelativePath(manifest.sbom.ref, "$.sbom.ref");

  exactKeys(manifest.license, ["spdx", "file"], ["notices"], "$.license");
  if (!isValidLicenseExpression(manifest.license.spdx)) fail("license_invalid", "$.license.spdx");
  assertRelativePath(manifest.license.file, "$.license.file");
  if (manifest.license.notices != null) assertRelativePath(manifest.license.notices, "$.license.notices");

  if (!manifest.meta || typeof manifest.meta !== "object" || Array.isArray(manifest.meta) || Object.keys(manifest.meta).length > 8) fail("meta_bound", "$.meta");
  for (const [key, value] of Object.entries(manifest.meta)) {
    if (!META_FIELDS.has(key)) fail("manifest_unknown_field", `$.meta.${key}`);
    if (!(typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)) fail("meta_scalar", `$.meta.${key}`);
    if (typeof value === "string") assertAscii(value, `$.meta.${key}`, { max: 256 });
    if (typeof value === "number" && !Number.isFinite(value)) fail("meta_scalar", `$.meta.${key}`);
  }
  return manifest;
}

function withoutSignature(manifest) {
  const clone = structuredClone(manifest);
  delete clone.signer.sig;
  return clone;
}

function encodeU32(value) {
  const out = [];
  let current = BigInt(value);
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    out.push(byte);
  } while (current);
  return out;
}

class WasmReader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.offset = start;
    this.end = end;
  }
  byte(code = "section_framing") {
    if (this.offset >= this.end) fail(code);
    return this.bytes[this.offset++];
  }
  u32() {
    const start = this.offset;
    let value = 0n;
    let shift = 0n;
    for (let count = 0; count < 5; count++) {
      const byte = this.byte("leb_truncated");
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        if (value > 0xffffffffn) fail("leb_overflow");
        const canonical = encodeU32(value);
        const actual = [...this.bytes.slice(start, this.offset)];
        if (JSON.stringify(canonical) !== JSON.stringify(actual)) fail("leb_non_canonical");
        return Number(value);
      }
      shift += 7n;
    }
    fail("leb_truncated");
  }
  name() {
    const length = this.u32();
    if (length > 256 || this.offset + length > this.end) fail("import_name_bound");
    const bytes = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    let value;
    try { value = decoder.decode(bytes); } catch { fail("import_name_invalid"); }
    assertAscii(value, "wasm.import", { max: 256 });
    return value;
  }
  done() { return this.offset === this.end; }
}

function readMemoryLimits(reader) {
  const flags = reader.u32();
  if (flags & 0x04) fail("memory64_rejected");
  if (flags & 0x02) fail("memory_shared_rejected");
  if (flags & ~0x07) fail("memory_flags_unknown");
  const min = reader.u32();
  if (!(flags & 0x01)) fail("memory_max_missing");
  const max = reader.u32();
  if (min > max) fail("memory_limits_invalid");
  return { min, max, shared: false, memory64: false };
}

function readTableLimits(reader) {
  const flags = reader.u32();
  if (flags & ~0x01) fail("table_flags_unknown");
  reader.u32();
  if (flags & 0x01) reader.u32();
}

export function auditWasmBinary(input, executable, { limits = WASM_PACKAGE_LIMITS, allowLarge = false } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
  if (bytes.byteLength < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) fail("wasm_magic");
  if (bytes[4] !== 0x01 || bytes[5] !== 0x00 || bytes[6] !== 0x00 || bytes[7] !== 0x00) fail("wasm_version");
  const tier = limits.TIERS[executable?.memory?.tier];
  if (!tier) fail("tier_invalid");
  if (executable.memory.tier === "large" && !allowLarge) fail("tier_blocked");
  if (bytes.byteLength > tier.maxBytes) fail("binary_too_large_for_tier");

  const reader = new WasmReader(bytes, 8);
  const seen = new Set();
  let lastOrder = 0;
  let sections = 0;
  let customBytes = 0;
  const skippedSections = [];
  const imports = [];
  const memories = [];
  while (!reader.done()) {
    sections += 1;
    const id = reader.byte();
    const size = reader.u32();
    if (reader.offset + size > reader.end) fail("section_size_overflow");
    const end = reader.offset + size;
    if (id === 0) {
      customBytes += size;
      reader.offset = end;
      continue;
    }
    if (!SECTION_NAMES[id]) fail("unknown_section");
    if (seen.has(id)) fail("duplicate_section");
    if (id < lastOrder) fail("section_order");
    seen.add(id);
    lastOrder = id;
    const section = new WasmReader(bytes, reader.offset, end);
    if (id === 2) {
      const count = section.u32();
      if (count > 1024) fail("import_count_bound");
      for (let index = 0; index < count; index++) {
        const module = section.name();
        const name = section.name();
        const kind = section.byte();
        if (!Object.hasOwn(KIND_NAMES, kind)) fail("import_kind_invalid");
        if (!BUNDLED_ALLOWED_IMPORT_MODULE_SET.has(module) || !executable.imports.allowed.includes(module) || executable.imports.disallowed.includes(module) || executable.imports.disallowed.includes("*")) fail("import_not_allowed", module);
        imports.push({ module, name, kind: KIND_NAMES[kind] });
        if (kind === 0) section.u32();
        else if (kind === 1) { section.byte(); readTableLimits(section); }
        else if (kind === 2) memories.push({ ...readMemoryLimits(section), imported: true });
        else if (kind === 3) { section.byte(); section.byte(); }
        else if (kind === 4) { section.byte(); section.u32(); }
      }
      if (!section.done()) fail("section_framing");
    } else if (id === 5) {
      const count = section.u32();
      if (count > 2) fail("multi_memory_rejected");
      for (let index = 0; index < count; index++) memories.push({ ...readMemoryLimits(section), imported: false });
      if (!section.done()) fail("section_framing");
    } else {
      skippedSections.push({ id, name: SECTION_NAMES[id], reason: "not_audited_in_authority_slice" });
    }
    reader.offset = end;
  }
  if (memories.length === 0) fail("no_memory");
  if (memories.length !== 1) fail("multi_memory_rejected");
  const measured = memories[0];
  if (measured.max > executable.memory.maxPages || measured.max > tier.maxPages) fail("memory_exceeds_ceiling", executable.memory.tier);
  return Object.freeze({
    ok: true,
    bytes: bytes.byteLength,
    imports: Object.freeze(imports.map((entry) => Object.freeze(entry))),
    measured: Object.freeze({ memoryInitial: measured.min, memoryMax: measured.max, imported: measured.imported, tier: executable.memory.tier }),
    skippedSections: Object.freeze(skippedSections.map((entry) => Object.freeze(entry))),
    sections,
    customBytes,
  });
}

function normalizeFiles(files) {
  if (files instanceof Map) return files;
  if (files && typeof files === "object" && !Array.isArray(files)) return new Map(Object.entries(files));
  fail("files_invalid");
}

function semverCompare(a, b) {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  for (let index = 1; index <= 3; index++) {
    const delta = Number(pa[index]) - Number(pb[index]);
    if (delta) return delta;
  }
  if (pa[4] == null && pb[4] != null) return 1;
  if (pa[4] != null && pb[4] == null) return -1;
  return String(pa[4] ?? "").localeCompare(String(pb[4] ?? ""));
}

function validateRegistry(raw) {
  if (raw == null) return { schemaVersion: 1, packages: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== 1 || !raw.packages || typeof raw.packages !== "object" || Array.isArray(raw.packages) || Object.keys(raw).some((key) => !new Set(["schemaVersion", "packages"]).has(key))) fail("registry_corrupt");

  for (const [packageId, record] of Object.entries(raw.packages)) {
    if (record?.packageId !== packageId || record?.lane !== "bundled" || !record.current || !Array.isArray(record.history)) fail("registry_corrupt", packageId);
    if (!new Set(["committed", "revoked"]).has(record.current.state)) fail("registry_corrupt", packageId);
  }
  return structuredClone(raw);
}

function validateWal(raw) {
  if (raw == null || raw?.state === "none") return null;
  if (!raw || typeof raw !== "object" || !new Set(["prepared", "committed", "compensated"]).has(raw.state) || !new Set(["install", "update", "revoke"]).has(raw.op) || !PACKAGE_ID_RE.test(raw.packageId ?? "") || !Number.isSafeInteger(raw.registryBeforeGen) || (raw.registryAfterGen != null && !Number.isSafeInteger(raw.registryAfterGen)) || !Object.hasOwn(raw, "prevRecord") || !raw.nextRecord) fail("wasm_wal_corrupt");
  return raw;
}

const storeLocks = new WeakMap();
async function withStoreLock(store, fn) {
  const prior = storeLocks.get(store) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  storeLocks.set(store, run.then(() => {}, () => {}));
  return await run;
}

function same(value, expected) {
  return canonicalJson(value) === canonicalJson(expected);
}

export class WasmPackageAuthority {
  constructor({ getStore = null, now = null, inventory = null } = {}) {
    this._getStore = getStore ?? (() => masterMemory());
    this._storePromise = null;
    this._now = now ?? (() => Date.now());
    this._inventory = inventory;
    this._inventoryFiles = null;
  }

  canonicalize(manifest) { return canonicalJson(manifest); }
  manifestDigest(canonicalBytesOrManifest) {
    const manifest = typeof canonicalBytesOrManifest === "string" ? JSON.parse(canonicalBytesOrManifest) : canonicalBytesOrManifest;
    return sha256Hex(canonicalJson(withoutSignature(manifest)));
  }

  validateManifest(raw) {
    try {
      if (typeof raw !== "string") fail("manifest_raw_required");
      preparseJson(raw);
      let manifest;
      try { manifest = JSON.parse(raw); } catch { fail("manifest_json_syntax"); }
      validateManifestObject(manifest);
      const canonical = canonicalJson(manifest);
      if (raw !== canonical) fail("manifest_not_canonical");
      const digest = this.manifestDigest(manifest);
      const signatureScope = `cap-wasm-manifest:v1\u0000${digest}`;
      return { ok: true, manifest: Object.freeze(manifest), canonical, manifestDigest: digest, signatureScope };
    } catch (error) {
      if (error instanceof WasmPackageAuthorityError) return { ok: false, error: error.code, path: error.path, detail: error.detail };
      return { ok: false, error: "manifest_invalid" };
    }
  }

  async _store() {
    // One authority instance holds one stable store object so its module-level
    // WeakMap mutex serializes every admission/query/recovery boundary.
    this._storePromise ??= Promise.resolve(this._getStore());
    return await this._storePromise;
  }

  async loadInventory() {
    const inventory = this._inventory;
    if (!inventory || typeof inventory !== "object" || !Array.isArray(inventory.files) || !Array.isArray(inventory.manifests) || !inventory.signer || !Array.isArray(inventory.evidence ?? []) || !Array.isArray(inventory.revocations ?? []) || typeof inventory.readFile !== "function" || typeof inventory.listFiles !== "function") fail("inventory_mismatch");
    if (inventory.signer.lane !== "bundled" || !/^[a-z0-9-]{1,64}$/u.test(inventory.signer.keyId ?? "")) fail("inventory_mismatch", "signer");
    const manifestIdentities = new Set();
    for (const row of inventory.manifests) {
      if (!row || !PACKAGE_ID_RE.test(row.pkg ?? "") || !SEMVER_RE.test(row.version ?? "") || !HEX64_RE.test(row.digest ?? "")) fail("inventory_mismatch", "manifest");
      const identity = `${row.pkg}\u0000${row.version}`;
      if (manifestIdentities.has(identity)) fail("manifest_identity_conflict", identity);
      manifestIdentities.add(identity);
    }
    const declared = new Map();
    for (const entry of inventory.files) {
      if (!entry || !assertRelativePath(entry.rel, "inventory.rel") || !HEX64_RE.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0 || declared.has(entry.rel)) fail("inventory_mismatch");
      declared.set(entry.rel, entry);
    }
    const observed = await inventory.listFiles();
    if (!Array.isArray(observed) || JSON.stringify([...observed].sort()) !== JSON.stringify([...declared.keys()].sort())) fail("inventory_mismatch");
    const verified = new Map();
    for (const [rel, entry] of declared) {
      const bytes = new Uint8Array(await inventory.readFile(rel));
      if (bytes.byteLength !== entry.size || await sha256HexBytes(bytes) !== entry.sha256) fail("inventory_mismatch", rel);
      verified.set(rel, bytes);
    }
    this._inventoryFiles = verified;
    return { ok: true, files: verified.size, release: inventory.release ?? null };
  }

  _largeEvidence(executable) {
    return executable.memory.tier !== "large" || (this._inventory?.evidence ?? []).some((row) => row?.kind === "mv3-worker-memory" && row?.tier === "large" && row?.result === "PASS");
  }

  async _verifyBundle(validated, filesInput) {
    if (!this._inventoryFiles) await this.loadInventory();
    const { manifest, manifestDigest } = validated;
    if ((this._inventory.revocations ?? []).some((row) => row?.keyId === manifest.signer.keyId)) fail("key_revoked");
    if (this._inventory.signer?.lane !== "bundled" || this._inventory.signer?.keyId !== manifest.signer.keyId) fail("key_not_active");
    if (!(this._inventory.manifests ?? []).some((row) => row?.pkg === manifest.package.id && row?.version === manifest.package.version && row?.digest === manifestDigest)) fail("inventory_mismatch", "manifest");
    const files = normalizeFiles(filesInput);
    const measured = [];
    for (const executable of manifest.executables) {
      const bytes = new Uint8Array(files.get(executable.sha256) ?? []);
      if (bytes.byteLength !== executable.size) fail("size_mismatch", executable.id);
      if (await sha256HexBytes(bytes) !== executable.sha256) fail("digest_mismatch", executable.id);
      const rel = `extension/wasm/cas/${executable.sha256}.wasm`;
      const inventoryBytes = this._inventoryFiles.get(rel);
      if (!inventoryBytes || inventoryBytes.byteLength !== bytes.byteLength || await sha256HexBytes(inventoryBytes) !== executable.sha256) fail("inventory_mismatch", rel);
      if (!this._largeEvidence(executable)) fail("tier_blocked", executable.id);
      measured.push({ id: executable.id, ...auditWasmBinary(bytes, executable, { allowLarge: executable.memory.tier === "large" }) });
    }
    const sbom = this._inventoryFiles.get(manifest.sbom.ref);
    if (!sbom || await sha256HexBytes(sbom) !== manifest.sbom.sha256) fail("sbom_mismatch");
    if (!this._inventoryFiles.has(manifest.license.file) || (manifest.license.notices && !this._inventoryFiles.has(manifest.license.notices))) fail("provenance_incomplete");
    return measured;
  }

  _record(validated, measured, previous = null) {
    const { manifest, manifestDigest, signatureScope } = validated;
    const identityDigest = sha256Hex(canonicalJson({
      tools: manifest.tools.map((tool) => ({ id: tool.toolId, digest: tool.digest, capabilityDigest: tool.capabilityDigest })),
      executables: manifest.executables.map((executable) => ({ id: executable.id, sha256: executable.sha256, capabilityDigest: executable.capabilityDigest })),
    }));
    const current = {
      version: manifest.package.version,
      manifestDigest,
      capabilityDigest: identityDigest,
      executables: manifest.executables.map((executable) => {
        const scan = measured.find((row) => row.id === executable.id);
        return { id: executable.id, sha256: executable.sha256, size: executable.size, declared: structuredClone(executable.memory), measured: structuredClone(scan.measured), imports: structuredClone(scan.imports), skippedSections: structuredClone(scan.skippedSections) };
      }),
      state: "committed",
      at: this._now(),
    };
    const history = previous ? [...previous.history, { ...previous.current, state: previous.current.state === "revoked" ? "revoked" : "superseded", at: this._now() }]: [];
    return {
      packageId: manifest.package.id,
      lane: "bundled",
      current,
      history,
      signer: {
        keyId: manifest.signer.keyId,
        alg: manifest.signer.alg,
        signaturePresent: typeof manifest.signer.sig === "string",
        verified: false,
        verification: "not-implemented",
        scope: signatureScope,
      },
      provenance: { source: structuredClone(manifest.source), build: structuredClone(manifest.build), sbom: structuredClone(manifest.sbom), license: structuredClone(manifest.license) },
    };
  }

  async _readRegistry(store) {
    let raw;
    try { raw = await store.getStrict(REGISTRY_KEY); } catch { fail("registry_corrupt"); }
    return validateRegistry(raw);
  }

  async _readWal(store) {
    let raw;
    try { raw = await store.getStrict(WAL_KEY); } catch { fail("wasm_wal_corrupt"); }
    return validateWal(raw);
  }

  async _writeWal(store, intent) { return await store.setTrusted(WAL_KEY, intent); }
  async _clearWal(store) { return await store.setTrusted(WAL_KEY, { state: "none" }); }

  async _recoverLocked(store) {
    const intent = await this._readWal(store);
    if (!intent) return { ok: true, recovered: false };
    if (intent.state === "committed" || intent.state === "compensated") {
      await this._clearWal(store);
      return { ok: true, recovered: true, terminal: intent.state };
    }
    const registry = await this._readRegistry(store);
    const currentGen = await store.getVersion(REGISTRY_KEY);
    const current = registry.packages[intent.packageId] ?? null;
    if (same(current, intent.nextRecord)) {
      // A recorded post-CAS token must still be exact. When the crash occurred
      // in the CAS→token gap, the exact next-record identity lets recovery bind
      // the currently observed durable token once and record it as committed.
      if (intent.registryAfterGen != null && intent.registryAfterGen !== currentGen) {
        fail("wasm_wal_recovery_conflict", intent.packageId);
      }
      await this._writeWal(store, { ...intent, state: "committed", registryAfterGen: currentGen });
      await this._clearWal(store);
      return { ok: true, recovered: true, terminal: "committed" };
    }
    if (same(current, intent.prevRecord)) {
      if (currentGen !== intent.registryBeforeGen) {
        fail("wasm_wal_recovery_conflict", intent.packageId);
      }
      await this._writeWal(store, { ...intent, state: "compensated" });
      await this._clearWal(store);
      return { ok: true, recovered: true, terminal: "compensated" };
    }
    fail("wasm_wal_recovery_conflict", intent.packageId);
  }

  async recoverTx() {
    const store = await this._store();
    return await withStoreLock(store, () => this._recoverLocked(store));
  }

  async _commit(store, { op, packageId, prevRecord, nextRecord, registry, registryGen }) {
    const prepared = { op, packageId, version: nextRecord.current.version, manifestDigest: nextRecord.current.manifestDigest, capabilityDigest: nextRecord.current.capabilityDigest, executables: nextRecord.current.executables.map(({ id, sha256, size }) => ({ id, sha256, size })), state: "prepared", registryBeforeGen: registryGen, prevRecord: structuredClone(prevRecord), nextRecord: structuredClone(nextRecord), at: this._now() };
    await this._writeWal(store, prepared);
    const nextRegistry = structuredClone(registry);
    nextRegistry.packages[packageId] = nextRecord;
    let applied;
    try { applied = await store.compareAndRestore(REGISTRY_KEY, registryGen, nextRegistry); } catch (error) { throw error; }
    if (!applied) {
      await this._writeWal(store, { ...prepared, state: "compensated" });
      await this._clearWal(store);
      fail("concurrent_package_write", packageId);
    }
    const afterGen = await store.getVersion(REGISTRY_KEY);
    await this._writeWal(store, { ...prepared, state: "committed", registryAfterGen: afterGen });
    await this._clearWal(store);
    return nextRecord;
  }

  async admitBundled({ manifest, files, expectedVersion = null }) {
    const validated = this.validateManifest(manifest);
    if (!validated.ok) fail(validated.error, validated.path, validated.detail);
    const measured = await this._verifyBundle(validated, files);
    const store = await this._store();
    return await withStoreLock(store, async () => {
      await this._recoverLocked(store);
      const registry = await this._readRegistry(store);
      const registryGen = await store.getVersion(REGISTRY_KEY);
      const previous = registry.packages[validated.manifest.package.id] ?? null;
      if (previous?.current?.state === "revoked") fail("revoked", previous.packageId);
      if (previous && previous.current.manifestDigest === validated.manifestDigest) return { ok: true, deduped: true, record: previous };
      const op = previous ? "update" : "install";
      if (previous) {
        if (expectedVersion == null || expectedVersion !== previous.current.version) fail("stale_version", previous.packageId);
        if (validated.manifest.package.version === previous.current.version) fail("manifest_identity_conflict", previous.packageId);
        if (semverCompare(validated.manifest.package.version, previous.current.version) <= 0) fail("version_not_newer", previous.packageId);
      } else if (expectedVersion != null) fail("stale_version", validated.manifest.package.id);

      const next = this._record(validated, measured, previous);
      const record = await this._commit(store, { op, packageId: next.packageId, prevRecord: previous, nextRecord: next, registry, registryGen });
      return { ok: true, record };
    });
  }

  async revoke({ packageId, version, reason }) {
    if (!PACKAGE_ID_RE.test(packageId ?? "")) fail("package_id_invalid");
    assertAscii(reason, "reason", { min: 1, max: 128 });
    const store = await this._store();
    return await withStoreLock(store, async () => {
      await this._recoverLocked(store);
      const registry = await this._readRegistry(store);
      const registryGen = await store.getVersion(REGISTRY_KEY);
      const previous = registry.packages[packageId];
      if (!previous) fail("absent", packageId);
      if (previous.current.state === "revoked") {
        if (previous.current.version === version) return { ok: true, deduped: true, record: previous };
        fail("stale_version", packageId);
      }
      if (previous.current.version !== version) fail("stale_version", packageId);
      const next = structuredClone(previous);
      next.current = { ...next.current, state: "revoked", revokedAt: this._now(), reason };
      const record = await this._commit(store, { op: "revoke", packageId, prevRecord: previous, nextRecord: next, registry, registryGen });
      return { ok: true, record };
    });
  }

  async query({ packageId, version = null }) {
    if (!PACKAGE_ID_RE.test(packageId ?? "")) return { ok: false, error: "package_id_invalid" };
    const store = await this._store();
    return await withStoreLock(store, async () => {
      await this._recoverLocked(store);
      const registry = await this._readRegistry(store);
      const record = registry.packages[packageId];
      if (!record) return { ok: false, error: "absent" };
      if (version != null && version !== record.current.version) {
        const historical = record.history.find((entry) => entry.version === version);
        return historical ? { ok: true, record: structuredClone(historical) } : { ok: false, error: "absent" };
      }
      if (record.current.state === "revoked") return { ok: false, error: "revoked", version: record.current.version };
      return { ok: true, record: structuredClone(record) };
    });
  }

  async grantEpoch(packageId) {
    const result = await this.query({ packageId });
    if (!result.ok) return result;
    return { ok: true, epoch: `${result.record.current.version}:${result.record.current.capabilityDigest}` };
  }
}

export const WASM_PACKAGE_KEYS = Object.freeze({ registry: REGISTRY_KEY, wal: WAL_KEY, repair: REPAIR_KEY });
