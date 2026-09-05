// lib/table-tool-runtime.js — run-bound artifact custody for local table tools.
// Full table bodies are read and written only inside the extension. The value
// returned to a model is fixed, bounded metadata and never contains cells.

import { createAssetKeyed, getAsset, ASSET_BOUNDS } from "./artifacts.js";
import {
  assertCanonicalTable,
  canonicalTableJson,
  TABLE_LIMITS,
  TABLE_MEDIA_TYPE,
  TABLE_VERSION,
  tableUtf8Bytes,
} from "./table-core.js";
import { sha256Hex } from "./pure.js";
import { canonicalJson } from "./wasm-package-authority.js";
import { stageAssetAsWasmStream } from "./tool-stream-platform.js";
import { discardWasmStream, readWasmStreamReceipt } from "./wasm-stream-files.js";
import { runTableWorkerJob } from "./table-worker-host.js";

export const TABLE_TOOL_NAMES = Object.freeze([
  "table_filter",
  "table_select",
  "table_join",
  "table_group_aggregate",
  "table_pivot",
  "table_formula",
]);

const COMMON_KEYS = ["outputName", "timeoutMs"];
const TABLE_RUN_ID_RE = /^(?:exec:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|exec_[A-Za-z0-9][A-Za-z0-9_-]{7,194})$/iu;
const TOOL_SHAPES = Object.freeze({
  table_filter: Object.freeze({ sources: ["source"], request: ["predicate"] }),
  table_select: Object.freeze({ sources: ["source"], request: ["columns"] }),
  table_join: Object.freeze({ sources: ["leftSource", "rightSource"], request: ["kind", "keys", "leftColumns", "rightColumns"] }),
  table_group_aggregate: Object.freeze({ sources: ["source"], request: ["groupBy", "metrics"] }),
  table_pivot: Object.freeze({ sources: ["source"], request: ["rowGroupBy", "pivotColumn", "categories", "metrics"] }),
  table_formula: Object.freeze({ sources: ["source"], request: ["mode", "readRange", "targetRows", "expression", "result", "numericPolicy"], optionalRequest: ["targetRows"] }),
});

const PROVIDER_ERROR_CODES = new Set([
  "table_artifact_promotion_failed",
  "table_artifact_read_failed",
  "table_artifact_stage_failed",
  "table_bad_request",
  "table_cancelled",
  "table_cleanup_failed",
  "table_failed",
  "table_format_invalid",
  "table_input_bound",
  "table_invalid_input",
  "table_join_input_bound",
  "table_output_bound",
  "table_provider_bound",
  "table_run_required",
  "table_timeout",
  "table_tool_unknown",
  "table_unknown_field",
  "table_work_bound",
  "table_worker_failed",
  "table_worker_unavailable",
]);

const DISPLAY_NAMES = Object.freeze({
  table_filter: "Filtered table",
  table_select: "Selected table",
  table_join: "Joined table",
  table_group_aggregate: "Grouped table",
  table_pivot: "Pivot table",
  table_formula: "Formula result",
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("table_bad_request");
  let descriptors;
  let proto;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    proto = Object.getPrototypeOf(value);
  } catch {
    fail("table_bad_request");
  }
  if (proto !== Object.prototype && proto !== null) fail("table_bad_request");
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || !descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
      fail("table_bad_request");
    }
  }
  return value;
}

function exactKeys(value, allowed, required, label) {
  plainObject(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("table_unknown_field");
  for (const key of required) if (!Object.hasOwn(value, key)) fail("table_bad_request");
  return value;
}

// Snapshot route data before the first await. All valid tool schemas fit well
// below these structural bounds; the copy prevents getters, sparse arrays, or
// later caller mutation from changing what the worker executes versus what the
// publication digest and owner-local provenance record bind.
function copyOwnData(value, state = { compounds: 0 }, depth = 0) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (!value || typeof value !== "object" || depth > 32 || ++state.compounds > 8192) fail("table_bad_request");
  let descriptors;
  let proto;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    proto = Object.getPrototypeOf(value);
  } catch {
    fail("table_bad_request");
  }
  if (Array.isArray(value)) {
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 4096) fail("table_bad_request");
    const copy = new Array(length);
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) fail("table_bad_request");
      copy[index] = copyOwnData(descriptor.value, state, depth + 1);
    }
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))) fail("table_bad_request");
    }
    return Object.freeze(copy);
  }
  if (proto !== Object.prototype && proto !== null) fail("table_bad_request");
  const copy = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || !descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
      fail("table_bad_request");
    }
    copy[key] = copyOwnData(descriptor.value, state, depth + 1);
  }
  return Object.freeze(copy);
}

function normalizeSource(value, label) {
  plainObject(value, label);
  const format = value.format;
  if (format === TABLE_VERSION) {
    exactKeys(value, ["artifactId", "format"], ["artifactId", "format"], label);
  } else if (format === "csv" || format === "tsv") {
    exactKeys(value, ["artifactId", "format", "hasHeader", "schemaMode", "columns", "localeProfile"], ["artifactId", "format", "hasHeader", "schemaMode", "localeProfile"], label);
    if (typeof value.hasHeader !== "boolean" || !["text", "infer", "explicit"].includes(value.schemaMode)) fail("table_bad_request");
    if (typeof value.localeProfile !== "string") fail("table_bad_request");
    if (value.schemaMode === "explicit") {
      if (!Object.hasOwn(value, "columns") || !Array.isArray(value.columns) || value.columns.length > TABLE_LIMITS.maxColumns) fail("table_bad_request");
    } else if (Object.hasOwn(value, "columns")) {
      fail("table_unknown_field");
    }
  } else {
    fail("table_format_invalid");
  }
  if (typeof value.artifactId !== "string" || !value.artifactId || value.artifactId.length > 200) fail("table_bad_request");
  return Object.freeze({
    artifactId: value.artifactId,
    format,
    ...(format === TABLE_VERSION ? {} : { options: Object.freeze({
      hasHeader: value.hasHeader,
      schemaMode: value.schemaMode,
      localeProfile: value.localeProfile,
      ...(Object.hasOwn(value, "columns") ? { columns: value.columns } : {}),
    }) }),
  });
}

export function providerSafeTableAssetRead(response) {
  const asset = response?.asset;
  if (!response?.ok || asset?.meta?.schema !== TABLE_VERSION) return response;
  const meta = asset.meta;
  return Object.freeze({
    ok: true,
    asset: Object.freeze({
      id: typeof asset.id === "string" ? asset.id : "",
      type: "data",
      size: Number.isSafeInteger(asset.size) && asset.size >= 0 ? asset.size : 0,
      meta: Object.freeze({
        schema: TABLE_VERSION,
        ...(typeof meta.sha256 === "string" && /^[0-9a-f]{64}$/u.test(meta.sha256) ? { sha256: meta.sha256 } : {}),
        ...(Number.isSafeInteger(meta.rows) && meta.rows >= 0 ? { rows: meta.rows } : {}),
        ...(Number.isSafeInteger(meta.columns) && meta.columns >= 0 ? { columns: meta.columns } : {}),
        previewAvailableLocally: true,
      }),
    }),
  });
}

export function tableRunOwner(context) {
  if (context?.principal !== "model") fail("table_run_required");
  const runId = context.runId;
  const agentId = context.agentId;
  if (typeof runId !== "string" || runId !== context.executionId || !TABLE_RUN_ID_RE.test(runId)) fail("table_run_required");
  if (typeof agentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(agentId)) fail("table_run_required");
  return `agent:${runId}:${agentId}`;
}

function normalizeCall(toolId, args) {
  const shape = TOOL_SHAPES[toolId];
  if (!shape) fail("table_tool_unknown");
  args = copyOwnData(args);
  const allowed = [...shape.sources, ...shape.request, ...COMMON_KEYS];
  const optional = new Set([...(shape.optionalRequest ?? []), ...COMMON_KEYS]);
  exactKeys(args, allowed, allowed.filter((key) => !optional.has(key)), "args");
  if (Object.hasOwn(args, "timeoutMs") && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 100 || args.timeoutMs > 180_000)) fail("table_bad_request");
  if (Object.hasOwn(args, "outputName")) {
    if (typeof args.outputName !== "string" || !args.outputName.trim() || args.outputName.length > ASSET_BOUNDS.maxNameLength) fail("table_bad_request");
  }
  const sources = Object.freeze(Object.fromEntries(shape.sources.map((key) => [key, normalizeSource(args[key], key)])));
  const request = Object.freeze(Object.fromEntries(shape.request.filter((key) => Object.hasOwn(args, key)).map((key) => [key, args[key]])));
  return Object.freeze({ sources, request, timeoutMs: args.timeoutMs, outputName: args.outputName?.trim() });
}

async function readSource(source, owner, { readAsset, stageAsset, readStreamReceipt, storage }) {
  let response;
  try { response = await readAsset("master", source.artifactId); }
  catch { fail("table_artifact_read_failed"); }
  if (!response?.ok || !response.asset || typeof response.asset !== "object") fail("table_artifact_read_failed");
  // Ordinary artifacts can be rejected before any staging write. Stream-backed
  // artifacts are measured by the sealed-reference authority below.
  if (!response.asset.meta?.streamRef) {
    if (typeof response.asset.content !== "string") fail("table_artifact_read_failed");
    if (tableUtf8Bytes(response.asset.content) > TABLE_LIMITS.maxInputBytes) fail("table_input_bound");
  }
  let staged;
  try { staged = await stageAsset(response.asset, { owner, storage, chunkSize: TABLE_LIMITS.chunkSize }); }
  catch { fail("table_artifact_stage_failed"); }
  if (!staged?.ok || !staged.inputRef || !Number.isSafeInteger(staged.bytes) || staged.bytes < 0) fail("table_artifact_stage_failed");
  let sourceSha256;
  if (response.asset.meta?.streamRef) {
    let receiptResult;
    try { receiptResult = await readStreamReceipt({ ref: staged.inputRef, owner, storage }); }
    catch { fail("table_artifact_stage_failed"); }
    const receipt = receiptResult?.receipt;
    const prefix = staged.inputRef.kind === "stdout" ? "stdout" : staged.inputRef.kind === "stderr" ? "stderr" : null;
    sourceSha256 = prefix ? receipt?.[`${prefix}Sha256`] : null;
    if (receipt?.[`${prefix}Bytes`] !== staged.bytes || typeof sourceSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sourceSha256)) {
      fail("table_artifact_stage_failed");
    }
  } else {
    sourceSha256 = typeof response.asset.sha256 === "string" && /^[0-9a-f]{64}$/u.test(response.asset.sha256)
      ? response.asset.sha256
      : sha256Hex(response.asset.content);
  }
  return {
    artifactId: source.artifactId,
    bytes: staged.bytes,
    sha256: sourceSha256,
    temporary: staged.chained !== true,
    ref: staged.inputRef,
    jobSource: {
      format: source.format,
      ref: staged.inputRef,
      owner,
      bytes: staged.bytes,
      ...(source.options ? { options: source.options } : {}),
    },
  };
}

function safeError(code) {
  const safeCode = typeof code === "string" && PROVIDER_ERROR_CODES.has(code) ? code : "table_failed";
  const bound = safeCode.includes("bound") || safeCode === "table_timeout";
  return Object.freeze({
    ok: false,
    code: safeCode,
    error: bound ? "The local table operation exceeded a safety bound." : "The local table operation failed.",
  });
}

/** Execute one normalized model table call and atomically publish its full output artifact. */
export async function runTableArtifactTool(toolId, args, context, {
  readAsset = getAsset,
  stageAsset = stageAssetAsWasmStream,
  discardStream = discardWasmStream,
  createArtifact = createAssetKeyed,
  runJob = runTableWorkerJob,
  readStreamReceipt = readWasmStreamReceipt,
  hash = sha256Hex,
  isRunLive,
  storage,
} = {}) {
  let owner;
  let call;
  try {
    owner = tableRunOwner(context);
    call = normalizeCall(toolId, args);
  } catch (error) {
    return safeError(error?.code);
  }

  const stagedInputs = [];
  const runIsLive = () => {
    try { return typeof isRunLive === "function" && isRunLive(context) === true; } catch { return false; }
  };
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return true;
    cleaned = true;
    let ok = true;
    for (const staged of stagedInputs) {
      if (!staged.temporary) continue;
      try {
        const removed = await discardStream({ ref: staged.ref, owner, storage });
        if (removed?.ok !== true) ok = false;
      } catch { ok = false; }
    }
    return ok;
  };

  try {
    if (!runIsLive()) fail("table_cancelled");
    const sourceEntries = [];
    for (const [key, descriptor] of Object.entries(call.sources)) {
      const source = await readSource(descriptor, owner, { readAsset, stageAsset, readStreamReceipt, storage });
      stagedInputs.push(source);
      if (source.bytes > TABLE_LIMITS.maxInputBytes) fail("table_input_bound");
      sourceEntries.push([key, source]);
    }
    const inputBytes = sourceEntries.reduce((sum, [, source]) => sum + source.bytes, 0);
    if (toolId === "table_join" && inputBytes > TABLE_LIMITS.maxJoinInputBytes) fail("table_join_input_bound");

    const job = { toolId, request: call.request };
    for (const [key, source] of sourceEntries) {
      job[key === "leftSource" ? "left" : key === "rightSource" ? "right" : "source"] = source.jobSource;
    }
    if (!runIsLive()) fail("table_cancelled");
    const executed = await runJob(job, {
      runId: context.runId,
      timeoutMs: call.timeoutMs,
      storage,
    });
    if (!(await cleanup())) return safeError("table_cleanup_failed");
    if (!executed?.ok) return safeError(executed?.code);
    if (!runIsLive()) return safeError("table_cancelled");
    if (!Number.isSafeInteger(executed.workUnits) || executed.workUnits < 0 || executed.workUnits > TABLE_LIMITS.maxWorkUnits) {
      return safeError("table_work_bound");
    }

    const table = assertCanonicalTable(executed.table);
    const content = canonicalTableJson(table);
    const outputBytes = tableUtf8Bytes(content);
    if (outputBytes > TABLE_LIMITS.maxOutputBytes) return safeError("table_output_bound");
    const outputDigest = hash(content);
    const sourceArtifactIds = sourceEntries.map(([, source]) => source.artifactId);
    const outputName = call.outputName ?? DISPLAY_NAMES[toolId];
    const sourceProvenance = Object.freeze(sourceEntries.map(([key, source]) => Object.freeze({
      role: key,
      ...call.sources[key],
      bytes: source.bytes,
      sha256: source.sha256,
    })));
    // Keep the complete reproducible operation beside the owner-local artifact:
    // source roles/parser options/current digests, transform request and output
    // name. The provider-safe asset route strips this provenance together with
    // every cell/header, while the publication key binds the same document plus
    // the bounded output digest.
    const operation = Object.freeze({
      version: "cap.table-publication/1",
      toolId,
      sources: sourceProvenance,
      request: call.request,
      outputName,
    });
    const publicationDigest = hash(canonicalJson({ ...operation, outputSha256: outputDigest }));
    // Output validation/hashing can be the longest post-worker phase. Close
    // the settlement race again at the atomic publication edge, not merely
    // when the worker result first arrived.
    if (!runIsLive()) return safeError("table_cancelled");
    const created = await createArtifact("master", {
      key: `table:${publicationDigest}`,
      type: "data",
      name: outputName,
      content,
      meta: {
        schema: TABLE_VERSION,
        mediaType: TABLE_MEDIA_TYPE,
        sha256: outputDigest,
        rows: table.rows.length,
        columns: table.columns.length,
        operation,
        operationDigest: publicationDigest,
        outputSha256: outputDigest,
        sourceArtifactIds,
        sourceSha256: sourceEntries.map(([, source]) => source.sha256),
        runOwner: owner,
      },
    });
    if (!created?.ok) return safeError("table_artifact_promotion_failed");
    if (created.deduped === true && (
      created.asset?.sha256 !== outputDigest ||
      created.asset?.type !== "data" ||
      created.asset?.meta?.schema !== TABLE_VERSION ||
      created.asset?.meta?.operationDigest !== publicationDigest
    )) {
      return safeError("table_artifact_promotion_failed");
    }
    const artifactId = created.id ?? created.asset?.id;
    if (typeof artifactId !== "string" || !artifactId) return safeError("table_artifact_promotion_failed");

    const result = Object.freeze({
      ok: true,
      artifactId,
      schema: TABLE_VERSION,
      sha256: outputDigest,
      rows: table.rows.length,
      columns: table.columns.length,
      inputBytes,
      outputBytes,
      workUnits: executed.workUnits,
      warnings: Object.freeze([]),
      previewAvailableLocally: true,
      deduped: created.deduped === true,
    });
    if (tableUtf8Bytes(JSON.stringify(result)) > TABLE_LIMITS.maxProviderResultBytes) {
      return safeError("table_provider_bound");
    }
    return result;
  } catch (error) {
    const cleanupOk = await cleanup();
    return safeError(cleanupOk ? error?.code : "table_cleanup_failed");
  }
}
