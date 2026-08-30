// RETENTION LAYER, NOT THE VIEW: this module owns sha256-addressed patch
// identity + storage. The real line diff (hunks, counts, apply) is
// extension/shared/diff-core.js, bundled to dist/shared/diff-core.bundle.js.
// lib/code-diff-artifacts.js — source-only retained code-change authority.
//
// This module validates and retains immutable change documents and derives
// bounded, non-authoritative text views. It has deliberately NO workspace,
// route, approval, provider, OPFS, WebAssembly, or mutation authority.

import { ASSET_BOUNDS, createAssetKeyed, getAsset } from "./artifacts.js";

export const CODE_DIFF_MEDIA = "application/x-cap-code-diff@1";
export const CODE_DIFF_LIMITS = Object.freeze({
  maxPathBytes: 1024,
  maxSegmentBytes: 255,
  maxPathCount: 256,
  maxChanges: 512,
  maxInputs: 64,
  maxRetainedBlobBytes: 180 * 1024,
  maxRetainedCasBytes: 4 * 1024 * 1024,
  maxRetainedBlobs: 64,
  maxViewLines: 2000,
  maxViewBytes: 512 * 1024,
  maxLineBytes: 8192,
  maxPatchBytes: 240 * 1024,
});

export const MAX_RETAINED_BLOB_BYTES = CODE_DIFF_LIMITS.maxRetainedBlobBytes;
export const MAX_RETAINED_CAS_BYTES = CODE_DIFF_LIMITS.maxRetainedCasBytes;
export const MAX_RETAINED_BLOBS = CODE_DIFF_LIMITS.maxRetainedBlobs;

const HEX64 = /^[0-9a-f]{64}$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SOURCE_KINDS = new Set(["extension-builtin", "chrome-api", "management", "webmcp-declared", "webmcp-inferred", "package"]);
const REPLAY_CLASSES = new Set(["read-only", "idempotent", "mutating", "unknown"]);
const textEncoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

function fail(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function ownData(value, label, { array = false } = {}) {
  try {
    if (value == null || typeof value !== "object") fail("hostile_input", label);
    const proto = Object.getPrototypeOf(value);
    if (array) {
      if (proto !== Array.prototype) fail("hostile_input", label);
    } else if (proto !== Object.prototype && proto !== null) {
      fail("hostile_input", label);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) fail("hostile_input", label);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const out = Object.create(null);
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
        fail("hostile_input", `${label}.${key}`);
      }
      out[key] = descriptor.value;
    }
    return { keys: keys.filter((key) => !(array && key === "length")), values: out };
  } catch (error) {
    if (error?.code) throw error;
    fail("hostile_input", label);
  }
}

function snapshot(value, label = "input", depth = 0, seen = new WeakSet(), budget = { nodes: 0 }) {
  if (++budget.nodes > 8192 || depth > 32) fail("input_over_budget", label);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("hostile_input", label);
    return value;
  }
  if (typeof value !== "object") fail("hostile_input", label);
  if (seen.has(value)) fail("hostile_input", `${label}: cyclic`);
  seen.add(value);
  const isArray = (() => {
    try { return Object.getPrototypeOf(value) === Array.prototype; } catch { fail("hostile_input", label); }
  })();
  const { keys, values } = ownData(value, label, { array: isArray });
  let result;
  if (isArray) {
    const length = (() => {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(value, "length");
        if (!descriptor || !("value" in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) fail("hostile_input", `${label}.length`);
        return descriptor.value;
      } catch (error) { if (error?.code) throw error; fail("hostile_input", `${label}.length`); }
    })();
    if (keys.length !== length) fail("hostile_input", `${label}: sparse or exotic array`);
    result = [];
    for (let index = 0; index < length; index++) {
      if (!Object.hasOwn(values, String(index))) fail("hostile_input", `${label}[${index}]`);
      result.push(snapshot(values[index], `${label}[${index}]`, depth + 1, seen, budget));
    }
  } else {
    result = {};
    for (const key of keys) result[key] = snapshot(values[key], `${label}.${key}`, depth + 1, seen, budget);
  }
  seen.delete(value);
  return result;
}

function exactKeys(object, allowed, required, label) {
  const keys = Object.keys(object);
  for (const key of keys) if (!allowed.includes(key)) fail("unknown_field", `${label}.${key}`);
  for (const key of required) if (!Object.hasOwn(object, key)) fail("missing_field", `${label}.${key}`);
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function sha256Hex(bytes) {
  const source = typeof bytes === "string" ? textEncoder.encode(bytes) : bytes;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareUtf8(left, right) {
  const a = textEncoder.encode(left);
  const b = textEncoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function decodePath(raw) {
  if (typeof raw === "string") return raw;
  try {
    if (raw && Object.getPrototypeOf(raw) === Uint8Array.prototype) return fatalDecoder.decode(new Uint8Array(raw));
  } catch { fail("path_bad_unicode"); }
  fail("path_bad_unicode");
}

function caseFold(value) {
  // Deterministic conservative filesystem-collision policy. NFKC plus lower
  // case catches compatibility/case aliases; the explicit folds cover the
  // common Unicode full-fold expansions absent from toLowerCase().
  return value.normalize("NFKC").toLocaleLowerCase("und").replaceAll("ß", "ss").replaceAll("ς", "σ").normalize("NFC");
}

export function normalizeUserPath(raw) {
  let value;
  try { value = decodePath(raw); } catch (error) { if (error?.code) throw error; fail("path_bad_unicode"); }
  if (hasLoneSurrogate(value) || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) fail("path_bad_unicode");
  if (value.includes("\\")) fail("path_backslash");
  if (!value || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.startsWith("//")) fail("path_traversal");
  if (/%(?:2e|2f|5c)(?:%[0-9a-f]{2})*/iu.test(value)) fail("path_traversal");
  const rawSegments = value.split("/");
  if (rawSegments.some((segment) => !segment || segment === "." || segment === "..")) fail("path_traversal");
  const segments = rawSegments.map((segment) => {
    const normalized = segment.normalize("NFC");
    if (!normalized || normalized === "." || normalized === "..") fail("path_traversal");
    if (textEncoder.encode(normalized).byteLength > CODE_DIFF_LIMITS.maxSegmentBytes) fail("path_over_budget");
    return normalized;
  });
  const canonical = segments.join("/");
  if (textEncoder.encode(canonical).byteLength > CODE_DIFF_LIMITS.maxPathBytes) fail("path_over_budget");
  return canonical;
}

function validateDigest(value, label) {
  if (typeof value !== "string" || !HEX64.test(value)) fail("invalid_digest", label);
  return value;
}

function validateSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail("invalid_size", label);
  return value;
}

function primaryPath(change) {
  return change.op === "rename" ? change.from : change.path;
}

export function validateChangeDocument(input) {
  const doc = snapshot(input, "changeDoc");
  exactKeys(doc, ["schemaVersion", "canonicalPathSet", "displayPaths", "changes"], ["schemaVersion", "canonicalPathSet", "displayPaths", "changes"], "changeDoc");
  if (doc.schemaVersion !== 1) fail("unsupported_schema");
  if (!Array.isArray(doc.canonicalPathSet) || doc.canonicalPathSet.length < 1 || doc.canonicalPathSet.length > CODE_DIFF_LIMITS.maxPathCount) fail("path_count_exceeded");
  const paths = [];
  const canonicalSeen = new Set();
  const foldedSeen = new Set();
  for (const raw of doc.canonicalPathSet) {
    if (typeof raw !== "string") fail("path_bad_unicode");
    const canonical = normalizeUserPath(raw);
    if (canonicalSeen.has(canonical)) fail("path_canonical_collision", canonical);
    if (canonical !== raw) fail("path_not_canonical", raw);
    const folded = caseFold(canonical);
    if (foldedSeen.has(folded)) fail("path_casefold_collision", canonical);
    canonicalSeen.add(canonical);
    foldedSeen.add(folded);
    paths.push(canonical);
  }
  const sorted = [...paths].sort(compareUtf8);
  if (sorted.some((path, index) => path !== paths[index])) fail("path_set_not_sorted");

  let displayPaths = null;
  if (doc.displayPaths !== null) {
    if (!doc.displayPaths || typeof doc.displayPaths !== "object" || Array.isArray(doc.displayPaths)) fail("display_path_mismatch");
    const keys = Object.keys(doc.displayPaths).sort(compareUtf8);
    if (keys.length !== paths.length || keys.some((key, index) => key !== paths[index])) fail("display_path_mismatch");
    const originals = new Set();
    displayPaths = {};
    for (const path of paths) {
      const original = doc.displayPaths[path];
      if (typeof original !== "string" || normalizeUserPath(original) !== path || originals.has(original)) fail("display_path_mismatch", path);
      originals.add(original);
      displayPaths[path] = original;
    }
  }

  if (!Array.isArray(doc.changes) || doc.changes.length < 1 || doc.changes.length > CODE_DIFF_LIMITS.maxChanges) fail("change_count_exceeded");
  const changes = [];
  const usedPaths = new Set();
  const usePath = (path, label) => {
    if (typeof path !== "string" || normalizeUserPath(path) !== path || !canonicalSeen.has(path)) fail("path_not_declared", label);
    if (usedPaths.has(path)) fail("duplicate_change_path", path);
    usedPaths.add(path);
    return path;
  };
  for (let index = 0; index < doc.changes.length; index++) {
    const change = doc.changes[index];
    if (!change || typeof change !== "object" || Array.isArray(change) || typeof change.op !== "string") fail("invalid_change", String(index));
    const label = `changes[${index}]`;
    let normalized;
    if (change.op === "add") {
      exactKeys(change, ["op", "path", "contentSha256", "size", "encoding"], ["op", "path", "contentSha256", "size", "encoding"], label);
      if (!["utf8", "bytes"].includes(change.encoding)) fail("invalid_encoding", label);
      normalized = { op: "add", path: usePath(change.path, label), contentSha256: validateDigest(change.contentSha256, label), size: validateSize(change.size, label), encoding: change.encoding };
    } else if (change.op === "update") {
      exactKeys(change, ["op", "path", "baseSha256", "resultSha256", "resultSize", "encoding"], ["op", "path", "baseSha256", "resultSha256", "resultSize", "encoding"], label);
      if (!["utf8", "bytes"].includes(change.encoding)) fail("invalid_encoding", label);
      const baseSha256 = validateDigest(change.baseSha256, label);
      const resultSha256 = validateDigest(change.resultSha256, label);
      if (baseSha256 === resultSha256) fail("no_op_change", label);
      normalized = { op: "update", path: usePath(change.path, label), baseSha256, resultSha256, resultSize: validateSize(change.resultSize, label), encoding: change.encoding };
    } else if (change.op === "delete") {
      exactKeys(change, ["op", "path", "baseSha256"], ["op", "path", "baseSha256"], label);
      normalized = { op: "delete", path: usePath(change.path, label), baseSha256: validateDigest(change.baseSha256, label) };
    } else if (change.op === "rename") {
      exactKeys(change, ["op", "from", "to", "baseSha256"], ["op", "from", "to", "baseSha256"], label);
      if (change.from === change.to) fail("no_op_change", label);
      normalized = { op: "rename", from: usePath(change.from, `${label}.from`), to: usePath(change.to, `${label}.to`), baseSha256: validateDigest(change.baseSha256, label) };
    } else if (change.op === "binary") {
      exactKeys(change, ["op", "path", "baseSha256", "resultSha256", "resultSize", "mediaType", "encoding"], ["op", "path", "baseSha256", "resultSha256", "resultSize", "mediaType", "encoding"], label);
      if (change.baseSha256 !== null) validateDigest(change.baseSha256, label);
      const resultSha256 = validateDigest(change.resultSha256, label);
      if (change.baseSha256 === resultSha256) fail("no_op_change", label);
      if (typeof change.mediaType !== "string" || textEncoder.encode(change.mediaType).byteLength > 64 || !/^[\x20-\x7e]+$/u.test(change.mediaType)) fail("invalid_media_type", label);
      if (change.encoding !== "bytes") fail("invalid_encoding", label);
      normalized = { op: "binary", path: usePath(change.path, label), baseSha256: change.baseSha256, resultSha256, resultSize: validateSize(change.resultSize, label), mediaType: change.mediaType, encoding: "bytes" };
    } else fail("unknown_operation", change.op);
    changes.push(normalized);
  }
  if (usedPaths.size !== canonicalSeen.size || paths.some((path) => !usedPaths.has(path))) fail("path_set_mismatch");
  return { schemaVersion: 1, canonicalPathSet: paths, displayPaths, changes };
}

function expectedBaseResult(doc) {
  const base = [];
  const result = [];
  for (const change of doc.changes) {
    if (change.op === "add") result.push({ path: change.path, sha256: change.contentSha256 });
    else if (change.op === "update") {
      base.push({ path: change.path, sha256: change.baseSha256 });
      result.push({ path: change.path, sha256: change.resultSha256 });
    } else if (change.op === "delete") base.push({ path: change.path, sha256: change.baseSha256 });
    else if (change.op === "rename") {
      base.push({ path: change.from, sha256: change.baseSha256 });
      result.push({ path: change.to, sha256: change.baseSha256 });
    } else if (change.op === "binary") {
      if (change.baseSha256 !== null) base.push({ path: change.path, sha256: change.baseSha256 });
      result.push({ path: change.path, sha256: change.resultSha256 });
    }
  }
  base.sort((a, b) => compareUtf8(a.path, b.path));
  result.sort((a, b) => compareUtf8(a.path, b.path));
  return { base, result };
}

function boundedIdentityString(value, label, maxBytes = 256, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !value || hasLoneSurrogate(value) || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value) || textEncoder.encode(value).byteLength > maxBytes) fail("invalid_identity", label);
  return value.normalize("NFC");
}

function validateProducer(input) {
  const producer = snapshot(input, "producer");
  const allowed = ["sourceKind", "toolId", "version", "sourceDigest", "replayClass", "packageId", "executableSha256", "capabilityDigest"];
  exactKeys(producer, allowed, ["sourceKind", "toolId", "version", "sourceDigest", "replayClass"], "producer");
  if (!SOURCE_KINDS.has(producer.sourceKind)) fail("invalid_producer", "sourceKind");
  if (!REPLAY_CLASSES.has(producer.replayClass)) fail("invalid_producer", "replayClass");
  const result = {
    sourceKind: producer.sourceKind,
    toolId: boundedIdentityString(producer.toolId, "toolId"),
    version: boundedIdentityString(producer.version, "version", 64),
    sourceDigest: validateDigest(producer.sourceDigest, "sourceDigest"),
    replayClass: producer.replayClass,
  };
  if (producer.sourceKind === "package") {
    for (const key of ["packageId", "executableSha256", "capabilityDigest"]) if (!Object.hasOwn(producer, key)) fail("missing_field", `producer.${key}`);
    if (!SEMVER.test(producer.version)) fail("invalid_producer", "version");
    result.packageId = boundedIdentityString(producer.packageId, "packageId", 128);
    result.executableSha256 = validateDigest(producer.executableSha256, "executableSha256");
    result.capabilityDigest = validateDigest(producer.capabilityDigest, "capabilityDigest");
  } else {
    for (const key of ["packageId", "executableSha256", "capabilityDigest"]) if (Object.hasOwn(producer, key)) fail("invalid_producer", key);
  }
  return result;
}

function validateContext(input) {
  const context = snapshot(input, "context");
  const keys = ["workspace", "executionId", "callIndex", "runId", "agentId", "origin", "documentId"];
  exactKeys(context, keys, keys, "context");
  if (!Number.isSafeInteger(context.callIndex) || context.callIndex < 0) fail("invalid_identity", "callIndex");
  return {
    workspace: boundedIdentityString(context.workspace, "workspace", 256),
    executionId: boundedIdentityString(context.executionId, "executionId", 128),
    callIndex: context.callIndex,
    runId: boundedIdentityString(context.runId, "runId", 128),
    agentId: boundedIdentityString(context.agentId, "agentId", 128, true),
    origin: boundedIdentityString(context.origin, "origin", 2048, true),
    documentId: boundedIdentityString(context.documentId, "documentId", 128, true),
  };
}

function validateDigestList(input, label, { withPath = false, max = 256 } = {}) {
  const list = snapshot(input, label);
  if (!Array.isArray(list) || list.length > max) fail("identity_over_budget", label);
  const output = [];
  const seen = new Set();
  for (let index = 0; index < list.length; index++) {
    const row = list[index];
    const allowed = withPath ? ["path", "sha256"] : ["sha256"];
    exactKeys(row, allowed, allowed, `${label}[${index}]`);
    const sha256 = validateDigest(row.sha256, label);
    const key = withPath ? normalizeUserPath(row.path) : sha256;
    if (withPath && key !== row.path) fail("path_not_canonical", row.path);
    if (seen.has(key)) fail("identity_collision", `${label}:${key}`);
    seen.add(key);
    output.push(withPath ? { path: key, sha256 } : { sha256 });
  }
  const sorted = [...output].sort((a, b) => withPath ? compareUtf8(a.path, b.path) : a.sha256.localeCompare(b.sha256));
  if (sorted.some((row, index) => canonicalJson(row) !== canonicalJson(output[index]))) fail("identity_not_sorted", label);
  return output;
}

export async function buildPatchIdentity(input) {
  const value = snapshot(input, "identityInput");
  exactKeys(value, ["producer", "context", "inputs", "base", "result", "changeDoc"], ["producer", "context", "inputs", "base", "result", "changeDoc"], "identityInput");
  const producer = validateProducer(value.producer);
  const context = validateContext(value.context);
  const inputs = validateDigestList(value.inputs, "inputs", { max: CODE_DIFF_LIMITS.maxInputs });
  const base = validateDigestList(value.base, "base", { withPath: true, max: CODE_DIFF_LIMITS.maxPathCount });
  const result = validateDigestList(value.result, "result", { withPath: true, max: CODE_DIFF_LIMITS.maxPathCount });
  const changeDoc = validateChangeDocument(value.changeDoc);
  const expected = expectedBaseResult(changeDoc);
  if (canonicalJson(base) !== canonicalJson(expected.base) || canonicalJson(result) !== canonicalJson(expected.result)) fail("identity_change_mismatch");
  const changes = await sha256Hex(canonicalJson(changeDoc));
  const tuple = { schemaVersion: 1, producer, context, inputs, base, result, changes, media: CODE_DIFF_MEDIA };
  const identity = await sha256Hex(canonicalJson(tuple));
  return Object.freeze({ identity, artifactKey: `opfs:code-diff:${identity}`, tuple: Object.freeze(tuple) });
}

function bytesFrom(value, label) {
  try {
    if (!value || Object.getPrototypeOf(value) !== Uint8Array.prototype) fail("hostile_input", label);
    return new Uint8Array(value);
  } catch (error) { if (error?.code) throw error; fail("hostile_input", label); }
}

function snapshotCasBlobs(input) {
  const { keys, values } = ownData(input, "casBlobs", { array: true });
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length) fail("hostile_input", "casBlobs");
  const rows = [];
  for (let index = 0; index < length; index++) {
    const raw = values[index];
    const { keys: rowKeys, values: row } = ownData(raw, `casBlobs[${index}]`);
    if (rowKeys.length !== 2 || !rowKeys.includes("sha256") || !rowKeys.includes("bytes")) fail("unknown_field", `casBlobs[${index}]`);
    rows.push({ sha256: validateDigest(row.sha256, `casBlobs[${index}]`), bytes: bytesFrom(row.bytes, `casBlobs[${index}].bytes`) });
  }
  return rows;
}

function requiredCas(changeDoc) {
  const required = new Map();
  const add = (sha256, role, size = null, encoding = null) => {
    const current = required.get(sha256) ?? { sha256, roles: new Set(), sizes: new Set(), encodings: new Set() };
    current.roles.add(role);
    if (size !== null) current.sizes.add(size);
    if (encoding !== null) current.encodings.add(encoding);
    required.set(sha256, current);
  };
  for (const change of changeDoc.changes) {
    if (change.op === "add") add(change.contentSha256, "result", change.size, change.encoding);
    else if (change.op === "update") {
      add(change.baseSha256, "base", null, change.encoding);
      add(change.resultSha256, "result", change.resultSize, change.encoding);
    } else if (change.op === "delete") add(change.baseSha256, "base", null, "utf8");
    else if (change.op === "rename") add(change.baseSha256, "base-result");
    else if (change.op === "binary") {
      if (change.baseSha256 !== null) add(change.baseSha256, "base", null, "bytes");
      add(change.resultSha256, "result", change.resultSize, "bytes");
    }
  }
  return required;
}

async function preflightCas(changeDoc, casInput) {
  const rows = snapshotCasBlobs(casInput);
  const required = requiredCas(changeDoc);
  if (required.size > MAX_RETAINED_BLOBS || rows.length > MAX_RETAINED_BLOBS) fail("cas_budget_exceeded", "blob count");
  const supplied = new Map();
  let total = 0;
  for (const row of rows) {
    if (supplied.has(row.sha256)) fail("cas_duplicate", row.sha256);
    if (!required.has(row.sha256)) fail("cas_unreferenced", row.sha256);
    if (row.bytes.byteLength > MAX_RETAINED_BLOB_BYTES) fail("cas_budget_exceeded", row.sha256);
    total += row.bytes.byteLength;
    if (total > MAX_RETAINED_CAS_BYTES) fail("cas_budget_exceeded", "total bytes");
    if (await sha256Hex(row.bytes) !== row.sha256) fail("cas_digest_mismatch", row.sha256);
    const rule = required.get(row.sha256);
    if (rule.sizes.size > 1 || (rule.sizes.size === 1 && !rule.sizes.has(row.bytes.byteLength))) fail("cas_size_mismatch", row.sha256);
    if (rule.encodings.has("utf8")) {
      try { fatalDecoder.decode(row.bytes); } catch { fail("cas_encoding_mismatch", row.sha256); }
    }
    supplied.set(row.sha256, { ...row, roles: [...rule.roles].sort(), encodings: [...rule.encodings].sort() });
  }
  for (const digest of required.keys()) if (!supplied.has(digest)) fail("cas_missing", digest);
  return [...supplied.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
}

function toBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function fromBase64(value) {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch { fail("cas_write_verify_failed"); }
}

function counts(changeDoc) {
  const result = { add: 0, update: 0, delete: 0, rename: 0, binary: 0 };
  for (const change of changeDoc.changes) result[change.op]++;
  return result;
}

function validateRetainMeta(input) {
  if (input == null) return {};
  const meta = snapshot(input, "meta");
  exactKeys(meta, ["label"], [], "meta");
  if (Object.hasOwn(meta, "label")) return { label: boundedIdentityString(meta.label, "meta.label", 120) };
  return {};
}

async function verifyIdentityRecord(recordInput, changeDoc) {
  const record = snapshot(recordInput, "identity");
  exactKeys(record, ["identity", "artifactKey", "tuple"], ["identity", "artifactKey", "tuple"], "identity");
  validateDigest(record.identity, "identity");
  if (record.artifactKey !== `opfs:code-diff:${record.identity}`) fail("identity_mismatch");
  const tuple = record.tuple;
  exactKeys(tuple, ["schemaVersion", "producer", "context", "inputs", "base", "result", "changes", "media"], ["schemaVersion", "producer", "context", "inputs", "base", "result", "changes", "media"], "identity.tuple");
  if (tuple.schemaVersion !== 1 || tuple.media !== CODE_DIFF_MEDIA) fail("identity_mismatch");
  const rebuilt = await buildPatchIdentity({ producer: tuple.producer, context: tuple.context, inputs: tuple.inputs, base: tuple.base, result: tuple.result, changeDoc });
  if (rebuilt.identity !== record.identity || rebuilt.artifactKey !== record.artifactKey || canonicalJson(rebuilt.tuple) !== canonicalJson(tuple)) fail("identity_mismatch");
  return rebuilt;
}

function artifactApi(api) {
  if (api == null) return { createAssetKeyed, getAsset };
  const value = ownData(api, "artifactApi").values;
  if (Object.keys(value).length !== 2 || typeof value.createAssetKeyed !== "function" || typeof value.getAsset !== "function") fail("hostile_input", "artifactApi");
  return value;
}

export async function retainPatch(input, apiInput = null) {
  const { keys, values } = ownData(input, "retainPatch");
  const allowed = ["identity", "changeDoc", "casBlobs", "meta"];
  if (keys.some((key) => !allowed.includes(key)) || !["identity", "changeDoc", "casBlobs"].every((key) => keys.includes(key))) fail("unknown_field", "retainPatch");
  const changeDoc = validateChangeDocument(values.changeDoc);
  const identity = await verifyIdentityRecord(values.identity, changeDoc);
  const meta = validateRetainMeta(values.meta);
  // ALL caller bytes, hashes, declared sizes, counts and final patch size are
  // checked before the first artifact write. A later write failure is recovered
  // by createAssetKeyed's WAL and the same digest-bound retry keys.
  const cas = await preflightCas(changeDoc, values.casBlobs);
  const patchContent = canonicalJson(changeDoc);
  if (textEncoder.encode(patchContent).byteLength > CODE_DIFF_LIMITS.maxPatchBytes) fail("patch_over_budget");
  // Materialize every deterministic artifact body before the first write too;
  // a base64/envelope failure can therefore never strand an earlier blob.
  const plan = cas.map((blob) => {
    const content = canonicalJson({ schemaVersion: 1, encoding: "base64", sha256: blob.sha256, size: blob.bytes.byteLength, bytes: toBase64(blob.bytes) });
    if (textEncoder.encode(content).byteLength > ASSET_BOUNDS.maxContentBytes) fail("cas_budget_exceeded", blob.sha256);
    return { ...blob, content };
  });
  const api = artifactApi(apiInput);
  const retained = [];
  for (const blob of plan) {
    const created = await api.createAssetKeyed("master", {
      key: `opfs:code-diff:cas:${blob.sha256}`,
      type: "data",
      name: `Code diff CAS ${blob.sha256}`,
      content: blob.content,
      meta: { kind: "code-diff-cas", sha256: blob.sha256, roles: blob.roles, encoding: "base64" },
    });
    if (!created?.ok || typeof created.id !== "string") fail("cas_write_failed", created?.error ?? blob.sha256);
    const read = await api.getAsset("master", created.id);
    if (!read?.ok || typeof read.asset?.content !== "string" || read.asset.content !== blob.content) fail("cas_write_verify_failed", blob.sha256);
    let envelope;
    try { envelope = JSON.parse(read.asset.content); } catch { fail("cas_write_verify_failed", blob.sha256); }
    if (!envelope || envelope.schemaVersion !== 1 || envelope.encoding !== "base64" || envelope.sha256 !== blob.sha256 || envelope.size !== blob.bytes.byteLength || typeof envelope.bytes !== "string") fail("cas_write_verify_failed", blob.sha256);
    const reread = fromBase64(envelope.bytes);
    if (reread.byteLength !== blob.bytes.byteLength || await sha256Hex(reread) !== blob.sha256) fail("cas_write_verify_failed", blob.sha256);
    retained.push({ sha256: blob.sha256, id: created.id });
  }
  const summary = counts(changeDoc);
  const patch = await api.createAssetKeyed("master", {
    key: identity.artifactKey,
    type: "json",
    name: meta.label ?? `Code diff ${identity.identity.slice(0, 12)}`,
    content: patchContent,
    meta: {
      kind: "code-diff",
      schemaVersion: 1,
      media: CODE_DIFF_MEDIA,
      identity: identity.identity,
      state: "pending",
      producer: identity.tuple.producer,
      pathCount: changeDoc.canonicalPathSet.length,
      changeCount: changeDoc.changes.length,
      counts: summary,
      retainedCas: retained.map((row) => row.sha256),
    },
  });
  if (!patch?.ok || typeof patch.id !== "string") fail("patch_write_failed", patch?.error ?? identity.identity);
  const readPatch = await api.getAsset("master", patch.id);
  if (!readPatch?.ok || readPatch.asset?.content !== patchContent || readPatch.asset?.meta?.identity !== identity.identity) fail("patch_write_verify_failed");
  return { ok: true, id: patch.id, identity: identity.identity, deduped: patch.deduped === true, retainedCas: retained };
}

function neutralizeText(value) {
  if (hasLoneSurrogate(value)) fail("view_bad_unicode");
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, (character) => character === "\n" ? "\n" : "�");
}

function decodeText(bytes) {
  try { return neutralizeText(fatalDecoder.decode(bytes)); } catch (error) { if (error?.code) throw error; fail("view_bad_unicode"); }
}

function truncateLine(value) {
  const clean = neutralizeText(value);
  // Reserve one byte for the unified +/- row marker. Side-by-side cells are
  // therefore bounded one byte more conservatively than the public ceiling.
  const limit = CODE_DIFF_LIMITS.maxLineBytes - 1;
  const encoded = textEncoder.encode(clean);
  if (encoded.byteLength <= limit) return clean;
  let low = 0;
  let high = clean.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (textEncoder.encode(clean.slice(0, mid)).byteLength <= limit - 3) low = mid;
    else high = mid - 1;
  }
  let cut = low;
  while (cut > 0 && /[\ud800-\udbff]/u.test(clean[cut - 1])) cut--;
  return `${clean.slice(0, cut)}…`;
}

function lines(bytes) {
  return decodeText(bytes).split(/\r?\n/u).map(truncateLine);
}

async function viewInput(input) {
  const { keys, values } = ownData(input, "view");
  if (keys.length !== 2 || !keys.includes("changeDoc") || !keys.includes("casBlobs")) fail("unknown_field", "view");
  const changeDoc = validateChangeDocument(values.changeDoc);
  let cas;
  try {
    cas = await preflightCas(changeDoc, values.casBlobs);
  } catch (error) {
    if (error?.code === "cas_missing") fail("view_base_missing", error.message);
    if (["cas_digest_mismatch", "cas_size_mismatch"].includes(error?.code)) fail("view_digest_mismatch", error.message);
    if (error?.code === "cas_encoding_mismatch") fail("view_bad_unicode", error.message);
    throw error;
  }
  return { changeDoc, blobs: new Map(cas.map((row) => [row.sha256, row.bytes])) };
}

function pushViewRow(state, row) {
  const serialized = typeof row === "string" ? row : canonicalJson(row);
  const bytes = textEncoder.encode(serialized).byteLength + 1;
  if (state.rows.length + 1 > CODE_DIFF_LIMITS.maxViewLines || state.bytes + bytes > CODE_DIFF_LIMITS.maxViewBytes) fail("view_over_budget");
  state.rows.push(row);
  state.bytes += bytes;
}

function binaryLike(change) {
  return change.op === "binary" || change.encoding === "bytes";
}

export async function deriveUnified(input) {
  const { changeDoc, blobs } = await viewInput(input);
  const state = { rows: [], bytes: 0 };
  for (const change of changeDoc.changes) {
    const path = primaryPath(change);
    pushViewRow(state, `@@ ${change.op} ${path}`);
    if (binaryLike(change)) {
      const base = change.baseSha256 ? blobs.get(change.baseSha256)?.byteLength ?? 0 : 0;
      const resultDigest = change.resultSha256 ?? change.contentSha256;
      const result = resultDigest ? blobs.get(resultDigest)?.byteLength ?? 0 : 0;
      pushViewRow(state, `[binary] ${change.mediaType ?? "application/octet-stream"} ${base}→${result} bytes`);
      continue;
    }
    if (change.op === "rename") {
      pushViewRow(state, `~ ${change.from} → ${change.to} [${change.baseSha256}]`);
      continue;
    }
    const baseDigest = change.baseSha256 ?? null;
    const resultDigest = change.resultSha256 ?? change.contentSha256 ?? null;
    if (baseDigest) for (const line of lines(blobs.get(baseDigest))) pushViewRow(state, `-${line}`);
    if (resultDigest) for (const line of lines(blobs.get(resultDigest))) pushViewRow(state, `+${line}`);
  }
  return { kind: "unified", authoritative: false, media: "text/plain", rows: state.rows, text: state.rows.join("\n"), bytes: state.bytes };
}

export async function deriveSideBySide(input) {
  const { changeDoc, blobs } = await viewInput(input);
  const state = { rows: [], bytes: 0 };
  for (const change of changeDoc.changes) {
    const path = primaryPath(change);
    if (binaryLike(change)) {
      const base = change.baseSha256 ? blobs.get(change.baseSha256)?.byteLength ?? 0 : 0;
      const resultDigest = change.resultSha256 ?? change.contentSha256;
      const result = resultDigest ? blobs.get(resultDigest)?.byteLength ?? 0 : 0;
      pushViewRow(state, { path, kind: "binary", left: `${base} bytes`, right: `${result} bytes`, mediaType: change.mediaType ?? "application/octet-stream" });
      continue;
    }
    if (change.op === "rename") {
      pushViewRow(state, { path, kind: "rename", left: change.from, right: change.to });
      continue;
    }
    const baseDigest = change.baseSha256 ?? null;
    const resultDigest = change.resultSha256 ?? change.contentSha256 ?? null;
    const left = baseDigest ? lines(blobs.get(baseDigest)) : [];
    const right = resultDigest ? lines(blobs.get(resultDigest)) : [];
    const count = Math.max(left.length, right.length, 1);
    for (let index = 0; index < count; index++) pushViewRow(state, { path, kind: change.op, left: left[index] ?? "", right: right[index] ?? "" });
  }
  return { kind: "side-by-side", authoritative: false, media: "text/plain", rows: state.rows, bytes: state.bytes };
}

function mutationUnavailable(action) {
  fail("mutation_authority_required", `${action} requires the deferred owner-approved workspace mutation authority`);
}

export function applyPending() { mutationUnavailable("apply"); }
export function rejectPending() { mutationUnavailable("reject"); }
export function undoApplied() { mutationUnavailable("undo"); }
