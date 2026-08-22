// lib/lazy-tool-protocol.js — bounded run-bound search/execute protocol core.
//
// This module is deliberately NOT provider-bound. It composes the landed
// canonical catalog, lexical index and selection authority with source records
// whose dispatch closures are the existing product tool closures. Search never
// grants authority. Execute re-reads live sources before validation, before
// dispatch and after dispatch; the existing source closure remains the only
// permission/grant/cancellation/replay authority.

import { z } from "zod";
import {
  adaptBrowserTools,
  adaptBuiltinTools,
  adaptManagementTools,
  adaptWebMcpTools,
  buildToolCatalog,
  canonicalToolDescriptor,
  TOOL_CATALOG_BOUNDS,
} from "./tool-catalog.js";
import { buildToolSearchIndex, searchToolIndex } from "./tool-search.js";
import { ToolSelectionAuthority } from "./tool-selection.js";
export {
  buildLazyProviderCapture,
  LAZY_PROTOCOL_TOOL_WIRE,
} from "./lazy-tool-wire.js";
import {
  hasLoneSurrogates,
  redactSecretText,
  safeProviderError,
  schemaToZod,
  SECRET_KEY_RE,
  truncateUtf8,
  utf8ByteLength,
} from "./pure.js";

export const LAZY_TOOL_PROTOCOL_BOUNDS = Object.freeze({
  maxSources: TOOL_CATALOG_BOUNDS.maxDescriptors * 2,
  maxArgumentBytes: 32 * 1024,
  maxArgumentDepth: 8,
  maxArgumentNodes: 256,
  maxObjectKeys: 64,
  maxArrayItems: 64,
  maxKeyBytes: 128,
  maxStringBytes: 16 * 1024,
  maxResultBytes: 64 * 1024,
  maxResultDepth: 8,
  maxResultNodes: 512,
  maxErrorBytes: 1024,
});

function ownData(value, key) {
  try {
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isAborted(signal) {
  try {
    return signal?.aborted === true;
  } catch {
    return true;
  }
}

function fixedError(code) {
  return Object.freeze({ ok: false, error: code });
}

function safeKey(key) {
  if (typeof key !== "string" || hasLoneSurrogates(key)) return "";
  let normalized;
  try {
    normalized = key.normalize("NFKC");
  } catch {
    return "";
  }
  if (
    !normalized ||
    utf8ByteLength(normalized) > LAZY_TOOL_PROTOCOL_BOUNDS.maxKeyBytes
  ) {
    return "";
  }
  if (["__proto__", "prototype", "constructor"].includes(normalized)) return "";
  return normalized;
}

function projectData(value, limits, state, depth = 0) {
  if (++state.nodes > limits.maxNodes || depth > limits.maxDepth) {
    throw new Error("data-bound-exceeded");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("data-number-invalid");
    return value;
  }
  if (typeof value === "string") {
    if (hasLoneSurrogates(value)) throw new Error("data-unicode-invalid");
    const normalized = value.normalize("NFKC");
    if (
      !limits.truncateStrings &&
      utf8ByteLength(normalized) > limits.maxStringBytes
    ) {
      throw new Error("data-string-bound");
    }
    return truncateUtf8(normalized, limits.maxStringBytes);
  }
  if (
    value === undefined || typeof value === "bigint" ||
    typeof value === "function" || typeof value === "symbol"
  ) {
    throw new Error("data-type-invalid");
  }
  if (Array.isArray(value)) {
    let length;
    try {
      length = Number(Object.getOwnPropertyDescriptor(value, "length")?.value);
    } catch {
      throw new Error("data-hostile");
    }
    if (
      !Number.isSafeInteger(length) || length < 0 ||
      length > limits.maxArrayItems
    ) {
      throw new Error("data-array-bound");
    }
    const out = [];
    for (let index = 0; index < length; index++) {
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      } catch {
        throw new Error("data-hostile");
      }
      if (!descriptor || !("value" in descriptor)) {
        throw new Error("data-accessor");
      }
      out.push(projectData(descriptor.value, limits, state, depth + 1));
    }
    return out;
  }
  if (typeof value === "object") {
    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      throw new Error("data-hostile");
    }
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.some((key) => typeof key !== "string") ||
      keys.length > limits.maxObjectKeys
    ) {
      throw new Error("data-object-bound");
    }
    const out = Object.create(null);
    for (const rawKey of keys.sort()) {
      const key = safeKey(rawKey);
      const descriptor = descriptors[rawKey];
      if (!key || !("value" in descriptor)) throw new Error("data-accessor");
      out[key] = projectData(descriptor.value, limits, state, depth + 1);
    }
    return out;
  }
  throw new Error("data-type-invalid");
}

export function sanitizeLazyToolArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("arguments-must-be-object");
  }
  const projected = projectData(value, {
    maxNodes: LAZY_TOOL_PROTOCOL_BOUNDS.maxArgumentNodes,
    maxDepth: LAZY_TOOL_PROTOCOL_BOUNDS.maxArgumentDepth,
    maxObjectKeys: LAZY_TOOL_PROTOCOL_BOUNDS.maxObjectKeys,
    maxArrayItems: LAZY_TOOL_PROTOCOL_BOUNDS.maxArrayItems,
    maxStringBytes: LAZY_TOOL_PROTOCOL_BOUNDS.maxStringBytes,
    truncateStrings: false,
  }, { nodes: 0 });
  if (
    utf8ByteLength(JSON.stringify(projected)) >
      LAZY_TOOL_PROTOCOL_BOUNDS.maxArgumentBytes
  ) {
    throw new Error("arguments-too-large");
  }
  return projected;
}

function projectResult(value) {
  try {
    const projected = projectData(value, {
      maxNodes: LAZY_TOOL_PROTOCOL_BOUNDS.maxResultNodes,
      maxDepth: LAZY_TOOL_PROTOCOL_BOUNDS.maxResultDepth,
      maxObjectKeys: LAZY_TOOL_PROTOCOL_BOUNDS.maxObjectKeys,
      maxArrayItems: LAZY_TOOL_PROTOCOL_BOUNDS.maxArrayItems,
      maxStringBytes: LAZY_TOOL_PROTOCOL_BOUNDS.maxStringBytes,
      truncateStrings: true,
    }, { nodes: 0 });
    const redacted = redactResultStrings(projected);
    if (
      utf8ByteLength(JSON.stringify(redacted)) >
        LAZY_TOOL_PROTOCOL_BOUNDS.maxResultBytes
    ) {
      return Object.freeze({
        bounded: true,
        summary:
          "tool completed; result exceeded the lazy protocol output bound",
      });
    }
    return redacted;
  } catch {
    return Object.freeze({
      bounded: true,
      summary: "tool completed; result was not safely serializable",
    });
  }
}

function redactResultStrings(value) {
  if (typeof value === "string") return redactSecretText(value);
  if (Array.isArray(value)) return value.map(redactResultStrings);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SECRET_KEY_RE.test(key)
        ? "[REDACTED]"
        : redactResultStrings(child);
    }
    return out;
  }
  return value;
}

function sourceContext(context, catalogGeneration) {
  return {
    runId: ownData(context, "runId"),
    agentId: ownData(context, "agentId"),
    origin: ownData(context, "origin"),
    documentId: ownData(context, "documentId"),
    catalogGeneration,
  };
}

function replayProjection(context, descriptor) {
  const raw = ownData(context, "replayMetadata");
  const safety = ownData(raw, "safety");
  return Object.freeze({
    safety: ["read-only", "idempotent", "mutating", "unknown"].includes(safety)
      ? safety
      : "unknown",
    trustedToolSafety: descriptor?.trustedReplaySafety ?? "unknown",
  });
}

function inputForRecord(record) {
  return ownData(record, "descriptorInput") ?? ownData(record, "input");
}

async function liveSnapshot(readSources) {
  const raw = await readSources();
  if (
    !Array.isArray(raw) || raw.length > LAZY_TOOL_PROTOCOL_BOUNDS.maxSources
  ) {
    throw new Error("lazy-source-bound");
  }
  const records = [];
  const inputs = [];
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !("value" in descriptor)) continue;
    const record = descriptor.value;
    const input = inputForRecord(record);
    if (!input || typeof input !== "object") continue;
    records.push(record);
    inputs.push(input);
  }
  const catalog = buildToolCatalog(inputs);
  const byStableId = new Map();
  const ambiguous = new Set();
  for (const record of records) {
    let descriptor;
    try {
      descriptor = canonicalToolDescriptor(inputForRecord(record));
    } catch {
      continue;
    }
    if (!catalog.byStableId[descriptor.stableId]) continue;
    if (byStableId.has(descriptor.stableId)) {
      ambiguous.add(descriptor.stableId);
      byStableId.delete(descriptor.stableId);
    } else if (!ambiguous.has(descriptor.stableId)) {
      byStableId.set(descriptor.stableId, record);
    }
  }
  return Object.freeze({
    catalog,
    index: buildToolSearchIndex(catalog),
    byStableId,
  });
}

async function validateRecordArguments(record, args) {
  const validate = ownData(record, "validateArguments");
  if (typeof validate !== "function") {
    return fixedError("lazy-validator-unavailable");
  }
  let result;
  try {
    result = await validate(args);
  } catch {
    return fixedError("lazy-arguments-invalid");
  }
  if (ownData(result, "ok") !== true) {
    return fixedError("lazy-arguments-invalid");
  }
  const data = ownData(result, "data");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return fixedError("lazy-arguments-invalid");
  }
  try {
    // A trusted validator may apply defaults/transforms. Bound and accessor-check
    // that derived object too before it reaches the existing dispatcher.
    return Object.freeze({ ok: true, data: sanitizeLazyToolArguments(data) });
  } catch {
    return fixedError("lazy-arguments-invalid");
  }
}

export class LazyToolProtocol {
  #readSources;
  #selections;

  constructor({ readSources, selectionAuthority } = {}) {
    if (typeof readSources !== "function") {
      throw new TypeError("lazy protocol needs a live source reader");
    }
    this.#readSources = readSources;
    this.#selections = selectionAuthority ?? new ToolSelectionAuthority();
  }

  async search(request = {}, context = {}) {
    const signal = ownData(context, "signal");
    if (isAborted(signal)) return fixedError("lazy-run-aborted");
    let snapshot;
    try {
      snapshot = await liveSnapshot(this.#readSources);
    } catch {
      return fixedError("lazy-source-unavailable");
    }
    if (isAborted(signal)) return fixedError("lazy-run-aborted");
    const search = searchToolIndex(snapshot.index, ownData(request, "query"), {
      limit: ownData(request, "limit"),
    });
    return this.#selections.issue(
      search,
      sourceContext(context, snapshot.catalog.generation),
      snapshot.catalog,
      { ttlMs: ownData(request, "ttlMs") },
    );
  }

  async execute(request = {}, context = {}) {
    const signal = ownData(context, "signal");
    if (isAborted(signal)) return fixedError("lazy-run-aborted");
    let first;
    try {
      first = await liveSnapshot(this.#readSources);
    } catch {
      return fixedError("lazy-source-unavailable");
    }
    const selectionRef = ownData(request, "selectionRef");
    const firstResolved = this.#selections.resolve(
      selectionRef,
      sourceContext(context, first.catalog.generation),
      first.catalog,
    );
    if (!firstResolved.ok) return firstResolved;
    let args;
    try {
      args = sanitizeLazyToolArguments(ownData(request, "arguments"));
    } catch {
      return fixedError("lazy-arguments-invalid");
    }
    const firstRecord = first.byStableId.get(firstResolved.descriptor.stableId);
    const validated = await validateRecordArguments(firstRecord, args);
    if (!validated.ok) return validated;
    if (isAborted(signal)) return fixedError("lazy-run-aborted");

    // Validation was an async boundary. Rebuild and re-resolve immediately
    // before dispatch so source/package/enrollment changes fail closed.
    let before;
    try {
      before = await liveSnapshot(this.#readSources);
    } catch {
      return fixedError("lazy-source-unavailable");
    }
    const beforeResolved = this.#selections.resolve(
      selectionRef,
      sourceContext(context, before.catalog.generation),
      before.catalog,
    );
    if (!beforeResolved.ok) return beforeResolved;
    const beforeRecord = before.byStableId.get(
      beforeResolved.descriptor.stableId,
    );
    const beforeValidated = await validateRecordArguments(beforeRecord, args);
    if (!beforeValidated.ok) return beforeValidated;
    if (isAborted(signal)) return fixedError("lazy-run-aborted");

    // The live validator itself may await or initialize parser state. Resolve
    // once more, then call the dispatcher synchronously from that exact record
    // without another gap in which a different closure could be substituted.
    let dispatchSnapshot;
    try {
      dispatchSnapshot = await liveSnapshot(this.#readSources);
    } catch {
      return fixedError("lazy-source-unavailable");
    }
    const dispatchResolved = this.#selections.resolve(
      selectionRef,
      sourceContext(context, dispatchSnapshot.catalog.generation),
      dispatchSnapshot.catalog,
    );
    if (!dispatchResolved.ok) return dispatchResolved;
    const dispatchRecord = dispatchSnapshot.byStableId.get(
      dispatchResolved.descriptor.stableId,
    );
    const dispatch = ownData(dispatchRecord, "dispatch");
    if (typeof dispatch !== "function") {
      return fixedError("lazy-dispatch-unavailable");
    }
    if (isAborted(signal)) return fixedError("lazy-run-aborted");

    let rawResult;
    try {
      rawResult = await dispatch(
        beforeValidated.data,
        Object.freeze({
          signal,
          runId: ownData(context, "runId"),
          agentId: ownData(context, "agentId"),
          origin: ownData(context, "origin"),
          documentId: ownData(context, "documentId"),
          replayMetadata: replayProjection(
            context,
            dispatchResolved.descriptor,
          ),
        }),
      );
    } catch (error) {
      return Object.freeze({
        ok: false,
        error: truncateUtf8(
          safeProviderError(
            typeof error === "string" ? error : "lazy dispatcher failed",
          ),
          LAZY_TOOL_PROTOCOL_BOUNDS.maxErrorBytes,
        ),
      });
    }
    if (isAborted(signal)) return fixedError("lazy-run-aborted");

    // Discard a result if the source or any scope/package/catalog fence changed
    // while the existing dispatcher was awaiting its own authority boundaries.
    let after;
    try {
      after = await liveSnapshot(this.#readSources);
    } catch {
      return fixedError("lazy-source-unavailable");
    }
    const afterResolved = this.#selections.resolve(
      selectionRef,
      sourceContext(context, after.catalog.generation),
      after.catalog,
    );
    if (!afterResolved.ok) return afterResolved;
    if (!after.byStableId.has(afterResolved.descriptor.stableId)) {
      return fixedError("lazy-dispatch-source-stale");
    }
    return Object.freeze({
      ok: true,
      result: projectResult(rawResult),
      selectionRef: afterResolved.selectionRef,
      authorizes: false,
      requiresLiveAuthorization: true,
      replay: replayProjection(context, afterResolved.descriptor),
    });
  }

  diagnostics() {
    return Object.freeze({
      providerBound: false,
      eagerBindingChanged: false,
      ...this.#selections.diagnostics(),
    });
  }
}

function trustedAiValidator(aiTool) {
  const schema = ownData(aiTool, "inputSchema");
  const safeParse = ownData(schema, "safeParse");
  return async (args) => {
    if (typeof safeParse !== "function") return { ok: false };
    let parsed;
    try {
      parsed = await safeParse(args);
    } catch {
      return { ok: false };
    }
    return ownData(parsed, "success") === true
      ? { ok: true, data: ownData(parsed, "data") }
      : { ok: false };
  };
}

function executableAiRecords(toolMap, adapter, context) {
  const inputs = adapter(toolMap, context);
  return inputs.map((descriptorInput) => {
    const aiTool = ownData(toolMap, ownData(descriptorInput, "toolId"));
    const execute = ownData(aiTool, "execute");
    return Object.freeze({
      descriptorInput,
      validateArguments: trustedAiValidator(aiTool),
      dispatch: typeof execute === "function"
        ? (args, dispatchContext) =>
          execute(args, {
            abortSignal: ownData(dispatchContext, "signal"),
            lazyReplayMetadata: ownData(dispatchContext, "replayMetadata"),
          })
        : null,
    });
  });
}

export function executableBuiltinToolRecords(toolMap, context) {
  return executableAiRecords(toolMap, adaptBuiltinTools, context);
}

export function executableBrowserToolRecords(toolMap, context) {
  return executableAiRecords(toolMap, adaptBrowserTools, context);
}

export function executableManagementToolRecords(toolMap, context) {
  return executableAiRecords(toolMap, adaptManagementTools, context);
}

export function executableWebMcpToolRecords(tools, context, dispatch) {
  const inputs = adaptWebMcpTools(tools, context);
  const rawTools = Array.isArray(tools) ? tools : [];
  return inputs.map((descriptorInput) => {
    const name = ownData(descriptorInput, "toolId");
    const expectedSource = String(ownData(descriptorInput, "sourceKind") ?? "")
      .replace("webmcp-", "");
    const sourceTool = rawTools.find((candidate) =>
      ownData(candidate, "name") === name &&
      ownData(candidate, "source") === expectedSource
    );
    let validator;
    try {
      const schema = sanitizeLazyToolArguments(
        ownData(sourceTool, "inputSchema") ?? {},
      );
      const zodSchema = schemaToZod(z, schema);
      validator = async (args) => {
        const parsed = zodSchema.safeParse(args);
        return parsed.success ? { ok: true, data: parsed.data } : { ok: false };
      };
    } catch {
      validator = async () => ({ ok: false });
    }
    return Object.freeze({
      descriptorInput,
      validateArguments: validator,
      dispatch: typeof dispatch === "function"
        ? (args, dispatchContext) =>
          dispatch(Object.freeze({
            origin: context?.origin ?? "",
            name,
            source: expectedSource,
            args,
            signal: ownData(dispatchContext, "signal"),
            replayMetadata: ownData(dispatchContext, "replayMetadata"),
          }))
        : null,
    });
  });
}
