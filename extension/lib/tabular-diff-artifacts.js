// lib/tabular-diff-artifacts.js — unreachable retained table-diff adapter.
//
// The only durable authority admitted here is the existing digest-keyed asset
// API. There is no route, provider, OPFS handle, package execution, owner
// approval, code-change document, apply, export, or workspace mutation surface.

import { ASSET_BOUNDS, createAssetKeyed, getAsset } from "./artifacts.js";
import {
  canonicalTabularJson,
  deriveTabularDiffPreview,
  planTabularDiffRetention,
  rebuildTabularDiffOperationIdentity,
  TABULAR_CHUNK_MEDIA,
  TABULAR_DIFF_LIMITS,
  TABULAR_DIFF_MEDIA,
  TABULAR_MANIFEST_MEDIA,
  tabularSha256Hex,
  validateTabularDiffBytes,
} from "./tabular-diff-artifacts-core.js";

export {
  buildTabularDiffIdentity,
  canonicalTabularJson,
  deriveTabularDiffPreview,
  planTabularDiffRetention,
  rebuildTabularDiffOperationIdentity,
  TABULAR_CHUNK_MEDIA,
  TABULAR_DIFF_LIMITS,
  TABULAR_DIFF_MEDIA,
  TABULAR_MANIFEST_MEDIA,
  TABULAR_VIEW_MEDIA,
  tabularSha256Hex,
  validateTabularDiffBytes,
} from "./tabular-diff-artifacts-core.js";

const HEX64 = /^[0-9a-f]{64}$/u;
const ASSET_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

function fail(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function ownData(value, label, { array = false } = {}) {
  try {
    if (value == null || typeof value !== "object") {
      fail("hostile_input", label);
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    ) fail("hostile_input", label);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      fail("hostile_input", label);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output = Object.create(null);
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = descriptors[key];
      if (
        !descriptor || !("value" in descriptor) || descriptor.get ||
        descriptor.set || !descriptor.enumerable
      ) fail("hostile_input", `${label}.${key}`);
      output[key] = descriptor.value;
    }
    return {
      keys: keys.filter((key) => !(array && key === "length")),
      values: output,
    };
  } catch (error) {
    if (error?.code) throw error;
    fail("hostile_input", label);
  }
}

function snapshot(
  value,
  label = "input",
  depth = 0,
  seen = new WeakSet(),
  budget = { nodes: 0 },
) {
  if (++budget.nodes > 8192 || depth > 32) fail("input_over_budget", label);
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("hostile_input", label);
    return value;
  }
  if (typeof value !== "object") fail("hostile_input", label);
  if (seen.has(value)) fail("hostile_input", `${label}: cyclic`);
  seen.add(value);
  let isArray;
  try {
    isArray = Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    fail("hostile_input", label);
  }
  const { keys, values } = ownData(value, label, { array: isArray });
  let output;
  if (isArray) {
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length) {
      fail("hostile_input", `${label}: sparse or exotic array`);
    }
    output = [];
    for (let index = 0; index < length; index++) {
      if (!Object.hasOwn(values, String(index))) {
        fail("hostile_input", `${label}[${index}]`);
      }
      output.push(
        snapshot(values[index], `${label}[${index}]`, depth + 1, seen, budget),
      );
    }
  } else {
    output = {};
    for (const key of keys) {
      output[key] = snapshot(
        values[key],
        `${label}.${key}`,
        depth + 1,
        seen,
        budget,
      );
    }
  }
  seen.delete(value);
  return output;
}

function exactKeys(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("retention_schema", label);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail("retention_unknown_field", `${label}.${key}`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("retention_missing_field", `${label}.${key}`);
    }
  }
}

function bytes(value) {
  return encoder.encode(value).byteLength;
}

function digest(value, label) {
  if (typeof value !== "string" || !HEX64.test(value)) {
    fail("retention_digest_invalid", label);
  }
  return value;
}

function uint(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("retention_number_invalid", label);
  }
  return value;
}

function same(left, right) {
  return canonicalTabularJson(left) === canonicalTabularJson(right);
}

function apiFrom(input) {
  if (input == null) return { createAssetKeyed, getAsset };
  const { keys, values } = ownData(input, "artifactApi");
  if (
    keys.length !== 2 || !keys.includes("createAssetKeyed") ||
    !keys.includes("getAsset") ||
    typeof values.createAssetKeyed !== "function" ||
    typeof values.getAsset !== "function"
  ) fail("hostile_input", "artifactApi");
  return values;
}

function base64Decode(value, code = "chunk_verify_failed") {
  if (typeof value !== "string") fail(code);
  try {
    const binary = atob(value);
    const output = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    let roundTrip = "";
    for (let offset = 0; offset < output.length; offset += 0x8000) {
      roundTrip += String.fromCharCode(
        ...output.subarray(offset, offset + 0x8000),
      );
    }
    if (btoa(roundTrip) !== value) fail(code);
    return output;
  } catch (error) {
    if (error?.code) throw error;
    fail(code);
  }
}

function parseCanonical(content, maximum, code) {
  if (
    typeof content !== "string" || bytes(content) < 1 ||
    bytes(content) > maximum
  ) fail(code);
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    fail(code);
  }
  if (canonicalTabularJson(value) !== content) fail(code);
  return value;
}

function chunkMeta(chunk) {
  return {
    kind: "tabular-diff-cas",
    media: TABULAR_CHUNK_MEDIA,
    sha256: chunk.sha256,
    size: chunk.size,
    encoding: "base64",
  };
}

async function verifyChunkAsset(asset, expected) {
  if (
    !asset || typeof asset.content !== "string" ||
    (expected.content != null && asset.content !== expected.content) ||
    !same(asset.meta, chunkMeta(expected))
  ) fail("chunk_verify_failed", String(expected.index));
  const envelope = parseCanonical(
    asset.content,
    ASSET_BOUNDS.maxContentBytes,
    "chunk_verify_failed",
  );
  exactKeys(
    envelope,
    ["schemaVersion", "media", "encoding", "sha256", "size", "bytes"],
    ["schemaVersion", "media", "encoding", "sha256", "size", "bytes"],
    "chunk",
  );
  if (
    envelope.schemaVersion !== 1 || envelope.media !== TABULAR_CHUNK_MEDIA ||
    envelope.encoding !== "base64" || envelope.sha256 !== expected.sha256 ||
    envelope.size !== expected.size
  ) fail("chunk_verify_failed", String(expected.index));
  const raw = base64Decode(envelope.bytes);
  if (
    raw.byteLength !== expected.size ||
    await tabularSha256Hex(raw) !== expected.sha256
  ) fail("chunk_verify_failed", String(expected.index));
  return raw;
}

async function validatePlan(input) {
  const plan = snapshot(input, "retentionPlan");
  const keys = [
    "schema",
    "canonicalArtifact",
    "operationIdentity",
    "tuple",
    "options",
    "summary",
    "chunks",
    "label",
    "quota",
  ];
  exactKeys(plan, keys, keys, "retentionPlan");
  if (plan.schema !== "cap-tabular-diff-retention-plan-v1") {
    fail("retention_plan_invalid");
  }
  const rebuilt = await planTabularDiffRetention({
    producer: plan.tuple?.producer,
    context: plan.tuple?.context,
    inputs: plan.tuple?.inputs,
    options: plan.options,
    artifact: plan.canonicalArtifact,
    ...(plan.label === null ? {} : { label: plan.label }),
  });
  if (!same(plan, rebuilt)) fail("retention_plan_invalid");
  return rebuilt;
}

function capacityLike(value) {
  return /(?:asset limit|capacity|quota|repair queue|index.*(?:bound|limit|size))/iu
    .test(String(value ?? ""));
}

function writeFailure(code, result, retained, phase) {
  const capacity = capacityLike(result?.error);
  const error = new Error(
    `${capacity ? "artifact_capacity" : code}: ${
      String(result?.error ?? phase)
    }`,
  );
  error.code = capacity ? "artifact_capacity" : code;
  error.phase = phase;
  error.orphanedChunks = Object.freeze(
    retained.map((row) =>
      Object.freeze({
        index: row.index,
        sha256: row.sha256,
        assetId: row.assetId,
      })
    ),
  );
  error.orphanPolicy = Object.freeze({
    automaticDeletion: false,
    collectionAvailable: false,
    reservationAvailable: false,
  });
  throw error;
}

function buildManifest(plan, retained) {
  return {
    schema: "cap-tabular-diff-retention-v1",
    media: TABULAR_DIFF_MEDIA,
    operationIdentity: plan.operationIdentity,
    content: {
      sha256: plan.tuple.contentSha256,
      size: plan.tuple.contentSize,
      semanticDigest: plan.tuple.semanticDigest,
      optionsDigest: plan.tuple.optionsDigest,
      chunks: retained.map((chunk) => ({
        index: chunk.index,
        size: chunk.size,
        sha256: chunk.sha256,
        assetId: chunk.assetId,
      })),
    },
    identity: {
      producer: plan.tuple.producer,
      context: plan.tuple.context,
      inputs: plan.tuple.inputs,
    },
    summary: plan.summary,
  };
}

function manifestMeta(manifest) {
  const producer = manifest.identity.producer;
  return {
    kind: "tabular-diff",
    schemaVersion: 1,
    media: TABULAR_DIFF_MEDIA,
    storageMedia: TABULAR_MANIFEST_MEDIA,
    state: "retained-read-only",
    operationIdentity: manifest.operationIdentity,
    contentSha256: manifest.content.sha256,
    semanticDigest: manifest.content.semanticDigest,
    producer: {
      sourceKind: producer.sourceKind,
      packageId: producer.packageId,
      toolId: producer.toolId,
      version: producer.version,
      executableSha256: producer.executableSha256,
      capabilityDigest: producer.capabilityDigest,
      replayClass: producer.replayClass,
    },
    mode: manifest.summary.mode,
    counts: manifest.summary.counts,
    columnCounts: manifest.summary.columns,
    chunkCount: manifest.content.chunks.length,
    contentSize: manifest.content.size,
    complete: true,
    mutationAvailable: false,
  };
}

export async function retainTabularDiff(planInput, apiInput = null) {
  // Full source/identity/chunk revalidation and materialization completes before
  // API validation or write 1. The store cannot reserve this multi-key group;
  // any later capacity error is surfaced with explicit orphan accounting.
  const plan = await validatePlan(planInput);
  const api = apiFrom(apiInput);
  const retained = [];
  for (const chunk of plan.chunks) {
    let created;
    try {
      created = await api.createAssetKeyed("master", {
        key: chunk.key,
        type: "data",
        name: `Tabular diff chunk ${chunk.sha256.slice(0, 12)}`,
        content: chunk.content,
        meta: chunkMeta(chunk),
      });
    } catch (error) {
      error.orphanedChunks = Object.freeze(
        retained.map((row) =>
          Object.freeze({
            index: row.index,
            sha256: row.sha256,
            assetId: row.assetId,
          })
        ),
      );
      error.orphanPolicy = Object.freeze({
        automaticDeletion: false,
        collectionAvailable: false,
        reservationAvailable: false,
        closeOutcomeUnknown: true,
      });
      throw error;
    }
    if (
      !created?.ok || typeof created.id !== "string" ||
      !ASSET_ID.test(created.id) ||
      bytes(created.id) > TABULAR_DIFF_LIMITS.maxAssetIdBytes
    ) {
      writeFailure(
        "chunk_write_failed",
        created,
        retained,
        `chunk:${chunk.index}`,
      );
    }
    const read = await api.getAsset("master", created.id);
    if (!read?.ok) fail("chunk_verify_failed", String(chunk.index));
    await verifyChunkAsset(read.asset, chunk);
    retained.push({
      index: chunk.index,
      size: chunk.size,
      sha256: chunk.sha256,
      assetId: created.id,
      deduped: created.deduped === true,
    });
  }

  // Re-read and hash every authoritative chunk in manifest order before the
  // manifest is materialized or written.
  const body = new Uint8Array(plan.tuple.contentSize);
  let cursor = 0;
  for (const chunk of retained) {
    const read = await api.getAsset("master", chunk.assetId);
    if (!read?.ok) fail("chunk_verify_failed", String(chunk.index));
    const raw = await verifyChunkAsset(read.asset, chunk);
    body.set(raw, cursor);
    cursor += raw.byteLength;
  }
  if (
    cursor !== body.byteLength ||
    await tabularSha256Hex(body) !== plan.tuple.contentSha256
  ) fail("content_reassembly_failed");
  let decoded;
  try {
    decoded = fatalDecoder.decode(body);
  } catch {
    fail("content_reassembly_failed");
  }
  const validated = await validateTabularDiffBytes(decoded);
  if (
    validated.canonical !== plan.canonicalArtifact ||
    validated.contentSha256 !== plan.tuple.contentSha256
  ) fail("content_reassembly_failed");

  const manifest = buildManifest(plan, retained);
  const content = canonicalTabularJson(manifest);
  if (
    bytes(content) > TABULAR_DIFF_LIMITS.maxManifestBytes ||
    bytes(content) > ASSET_BOUNDS.maxContentBytes
  ) fail("manifest_over_budget");
  const retentionDigest = await tabularSha256Hex(content);
  const artifactKey = `opfs:tabular-diff:${retentionDigest}`;
  const meta = manifestMeta(manifest);
  let created;
  try {
    created = await api.createAssetKeyed("master", {
      key: artifactKey,
      type: "json",
      name: plan.label ?? `Table diff ${plan.operationIdentity.slice(0, 12)}`,
      content,
      meta,
    });
  } catch (error) {
    error.orphanedChunks = Object.freeze(
      retained.map((row) =>
        Object.freeze({
          index: row.index,
          sha256: row.sha256,
          assetId: row.assetId,
        })
      ),
    );
    error.orphanPolicy = Object.freeze({
      automaticDeletion: false,
      collectionAvailable: false,
      reservationAvailable: false,
      closeOutcomeUnknown: true,
    });
    throw error;
  }
  if (
    !created?.ok || typeof created.id !== "string" ||
    !ASSET_ID.test(created.id) ||
    bytes(created.id) > TABULAR_DIFF_LIMITS.maxAssetIdBytes
  ) writeFailure("manifest_write_failed", created, retained, "manifest");
  const read = await api.getAsset("master", created.id);
  if (
    !read?.ok || read.asset?.content !== content ||
    !same(read.asset?.meta, meta)
  ) fail("manifest_verify_failed");
  const parsed = parseCanonical(
    read.asset.content,
    TABULAR_DIFF_LIMITS.maxManifestBytes,
    "manifest_verify_failed",
  );
  if (
    !same(parsed, manifest) ||
    parsed.operationIdentity !== plan.operationIdentity ||
    parsed.content.sha256 !== plan.tuple.contentSha256 ||
    parsed.content.semanticDigest !== plan.tuple.semanticDigest
  ) fail("manifest_verify_failed");
  return Object.freeze({
    ok: true,
    id: created.id,
    operationIdentity: plan.operationIdentity,
    contentSha256: plan.tuple.contentSha256,
    semanticDigest: plan.tuple.semanticDigest,
    retentionDigest,
    deduped: created.deduped === true,
    retainedChunks: Object.freeze(
      retained.map((row) => Object.freeze({ ...row })),
    ),
  });
}

function validateManifest(value) {
  exactKeys(
    value,
    ["schema", "media", "operationIdentity", "content", "identity", "summary"],
    ["schema", "media", "operationIdentity", "content", "identity", "summary"],
    "manifest",
  );
  if (
    value.schema !== "cap-tabular-diff-retention-v1" ||
    value.media !== TABULAR_DIFF_MEDIA
  ) fail("manifest_invalid");
  digest(value.operationIdentity, "manifest.operationIdentity");
  exactKeys(
    value.content,
    ["sha256", "size", "semanticDigest", "optionsDigest", "chunks"],
    ["sha256", "size", "semanticDigest", "optionsDigest", "chunks"],
    "manifest.content",
  );
  digest(value.content.sha256, "manifest.content.sha256");
  digest(value.content.semanticDigest, "manifest.content.semanticDigest");
  digest(value.content.optionsDigest, "manifest.content.optionsDigest");
  const size = uint(value.content.size, "manifest.content.size");
  if (
    size < 1 || size > TABULAR_DIFF_LIMITS.maxContentBytes ||
    !Array.isArray(value.content.chunks) || value.content.chunks.length < 1 ||
    value.content.chunks.length > TABULAR_DIFF_LIMITS.maxChunks
  ) fail("manifest_invalid");
  let total = 0;
  for (let index = 0; index < value.content.chunks.length; index++) {
    const chunk = value.content.chunks[index];
    exactKeys(chunk, ["index", "size", "sha256", "assetId"], [
      "index",
      "size",
      "sha256",
      "assetId",
    ], `manifest.content.chunks[${index}]`);
    if (
      chunk.index !== index || uint(chunk.size, "chunk.size") < 1 ||
      chunk.size > TABULAR_DIFF_LIMITS.maxChunkRawBytes
    ) fail("manifest_invalid");
    digest(chunk.sha256, "chunk.sha256");
    if (
      typeof chunk.assetId !== "string" || !ASSET_ID.test(chunk.assetId) ||
      bytes(chunk.assetId) > TABULAR_DIFF_LIMITS.maxAssetIdBytes
    ) fail("manifest_invalid");
    total += chunk.size;
  }
  if (total !== size) fail("manifest_invalid");
  exactKeys(value.identity, ["producer", "context", "inputs"], [
    "producer",
    "context",
    "inputs",
  ], "manifest.identity");
  exactKeys(value.summary, ["mode", "columns", "counts", "complete"], [
    "mode",
    "columns",
    "counts",
    "complete",
  ], "manifest.summary");
  if (
    !["keyed", "ordered"].includes(value.summary.mode) ||
    value.summary.complete !== true
  ) fail("manifest_invalid");
  exactKeys(
    value.summary.columns,
    ["keyCount", "common", "added", "removed", "ignored", "compared"],
    ["keyCount", "common", "added", "removed", "ignored", "compared"],
    "manifest.summary.columns",
  );
  exactKeys(
    value.summary.counts,
    ["leftRows", "rightRows", "added", "removed", "changed", "unchanged"],
    ["leftRows", "rightRows", "added", "removed", "changed", "unchanged"],
    "manifest.summary.counts",
  );
  for (const [key, number] of Object.entries(value.summary.columns)) {
    uint(number, `manifest.summary.columns.${key}`);
  }
  for (const [key, number] of Object.entries(value.summary.counts)) {
    uint(number, `manifest.summary.counts.${key}`);
  }
  return value;
}

export async function readTabularDiff(idInput, apiInput = null) {
  if (
    typeof idInput !== "string" || !ASSET_ID.test(idInput) ||
    bytes(idInput) > TABULAR_DIFF_LIMITS.maxAssetIdBytes
  ) fail("artifact_id_invalid");
  const api = apiFrom(apiInput);
  const manifestRead = await api.getAsset("master", idInput);
  if (!manifestRead?.ok) fail("manifest_read_failed");
  const manifest = validateManifest(
    parseCanonical(
      manifestRead.asset?.content,
      TABULAR_DIFF_LIMITS.maxManifestBytes,
      "manifest_invalid",
    ),
  );
  if (!same(manifestRead.asset?.meta, manifestMeta(manifest))) {
    fail("manifest_invalid");
  }
  const assembled = new Uint8Array(manifest.content.size);
  let cursor = 0;
  for (const chunk of manifest.content.chunks) {
    const read = await api.getAsset("master", chunk.assetId);
    if (!read?.ok) fail("chunk_read_failed", String(chunk.index));
    const raw = await verifyChunkAsset(read.asset, chunk);
    assembled.set(raw, cursor);
    cursor += raw.byteLength;
  }
  if (
    cursor !== assembled.byteLength ||
    await tabularSha256Hex(assembled) !== manifest.content.sha256
  ) fail("content_reassembly_failed");
  const validated = await validateTabularDiffBytes(assembled);
  if (
    validated.semanticDigest !== manifest.content.semanticDigest ||
    validated.optionsDigest !== manifest.content.optionsDigest ||
    validated.contentSize !== manifest.content.size
  ) fail("manifest_content_mismatch");
  const operation = await rebuildTabularDiffOperationIdentity({
    producer: manifest.identity.producer,
    context: manifest.identity.context,
    inputs: manifest.identity.inputs,
    artifact: assembled,
  });
  if (
    operation.operationIdentity !== manifest.operationIdentity ||
    !same(operation.validated.artifact.counts, manifest.summary.counts) ||
    operation.validated.mode !== manifest.summary.mode
  ) fail("manifest_identity_mismatch");
  const expectedColumns = {
    keyCount: operation.validated.artifact.columns.keys.length,
    common: operation.validated.artifact.columns.common.length,
    added: operation.validated.artifact.columns.added.length,
    removed: operation.validated.artifact.columns.removed.length,
    ignored: operation.validated.artifact.columns.ignored.length,
    compared: operation.validated.artifact.columns.compared.length,
  };
  if (!same(expectedColumns, manifest.summary.columns)) {
    fail("manifest_content_mismatch");
  }
  return Object.freeze({
    ok: true,
    id: idInput,
    manifest,
    validated: operation.validated,
    operationIdentity: operation.operationIdentity,
  });
}

export async function previewTabularDiff(id, request, apiInput = null) {
  const retained = await readTabularDiff(id, apiInput);
  return deriveTabularDiffPreview(
    retained.validated,
    request,
    retained.operationIdentity,
  );
}

function mutationUnavailable(action) {
  fail(
    "mutation_authority_required",
    `${action} requires separately approved mutation authority`,
  );
}

// Deliberately zero-argument declarations: hostile arguments/proxies are never
// observed before the synchronous refusal.
export function applyTabularDiff() {
  mutationUnavailable("apply");
}
export function rejectTabularDiff() {
  mutationUnavailable("reject");
}
export function undoTabularDiff() {
  mutationUnavailable("undo");
}
export function exportPatchedCsv() {
  mutationUnavailable("export");
}
