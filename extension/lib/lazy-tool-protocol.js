// lib/lazy-tool-protocol.js — bounded run-bound search/execute protocol core.
//
// This module is deliberately NOT provider-bound. It composes the landed
// canonical catalog, lexical index and selection authority with source records
// whose dispatch closures are the existing product tool closures. Search never
// grants authority. Execute re-reads live sources before validation, before
// dispatch and after dispatch; the existing source closure remains the only
// permission/grant/cancellation/replay authority.

import { tool } from "ai";
import { z } from "zod";
import {
  adaptBrowserTools,
  adaptBuiltinTools,
  adaptBundledTools,
  adaptManagementTools,
  adaptWebMcpTools,
  buildToolCatalog,
  canonicalToolDescriptor,
  TOOL_CATALOG_BOUNDS,
} from "./tool-catalog.js";
import { buildToolSearchIndex, searchToolIndex } from "./tool-search.js";
import { ToolSelectionAuthority } from "./tool-selection.js";
import { assertRunOwned } from "./run-fence.js";
import {
  buildLazyProviderCapture,
  LAZY_PROTOCOL_TOOL_WIRE,
} from "./lazy-tool-wire.js";
import {
  executeBundledWasiJob,
  previewSpecFor,
  validatePreviewInput,
} from "./tool-exec-preview.js";
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
  maxContextBytes: 256,
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
    taskId: ownData(context, "taskId"),
    agentId: ownData(context, "agentId"),
    origin: ownData(context, "origin"),
    documentId: ownData(context, "documentId"),
    runGeneration: ownData(context, "runGeneration"),
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

async function authorizeRecord(record, args, context, descriptor, phase) {
  const authorize = ownData(record, "authorize");
  if (typeof authorize !== "function") {
    return fixedError("lazy-authority-unavailable");
  }
  let result;
  try {
    result = await authorize(args, Object.freeze({
      signal: ownData(context, "signal"),
      runId: ownData(context, "runId"),
      taskId: ownData(context, "taskId"),
      agentId: ownData(context, "agentId"),
      origin: ownData(context, "origin"),
      documentId: ownData(context, "documentId"),
      runGeneration: ownData(context, "runGeneration"),
      phase,
      descriptor,
    }));
  } catch {
    return fixedError("lazy-authority-denied");
  }
  if (
    ownData(result, "ok") !== true ||
    ownData(result, "permissionDigest") !== descriptor.permissionDigest ||
    ownData(result, "grantDigest") !== descriptor.grantDigest
  ) {
    return fixedError("lazy-authority-stale-or-denied");
  }
  return Object.freeze({ ok: true });
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

  async list(request = {}, context = {}) {
    const signal = ownData(context, "signal");
    if (isAborted(signal)) return fixedError("lazy-run-aborted");
    let snapshot;
    try {
      snapshot = await liveSnapshot(this.#readSources);
    } catch {
      return fixedError("lazy-source-unavailable");
    }
    if (isAborted(signal)) return fixedError("lazy-run-aborted");

    const descriptors = snapshot.catalog.descriptors || [];
    const filterSource = typeof request?.source === "string" ? request.source.trim().toLowerCase() : null;

    const bySource = {
      builtin: [],
      browser: [],
      management: [],
      "bundled-wasm": [],
      webmcp: [],
    };

    const maxPerCategory = 50;
    const maxDescBytes = 256;
    const MAX_RESULT_BYTES = 32 * 1024;
    let currentEstimatedBytes = 256; // envelope baseline
    let truncated = false;

    for (const desc of descriptors) {
      const srcKind = desc.sourceKind;
      let group = "builtin";
      if (srcKind === "chrome-api") group = "browser";
      else if (srcKind === "management") group = "management";
      else if (srcKind === "bundled-package") group = "bundled-wasm";
      else if (srcKind.startsWith("webmcp")) group = "webmcp";

      if (filterSource && filterSource !== group && filterSource !== srcKind) {
        continue;
      }

      if (bySource[group].length >= maxPerCategory) {
        truncated = true;
        continue;
      }

      const itemDesc = truncateUtf8(String(desc.description ?? ""), maxDescBytes);
      const entry = {
        name: String(desc.name ?? ""),
        description: itemDesc,
        capabilities: Array.isArray(desc.capabilities) ? desc.capabilities.slice(0, 8) : [],
        availability: desc.availability ?? "ready",
        sourceKind: desc.sourceKind ?? "extension-builtin",
      };

      const entryBytes = utf8ByteLength(JSON.stringify(entry));
      if (currentEstimatedBytes + entryBytes > MAX_RESULT_BYTES) {
        truncated = true;
        break;
      }

      currentEstimatedBytes += entryBytes;
      bySource[group].push(entry);
    }

    const counts = {
      total: descriptors.length,
      builtin: bySource.builtin.length,
      browser: bySource.browser.length,
      management: bySource.management.length,
      bundledWasm: bySource["bundled-wasm"].length,
      webmcp: bySource.webmcp.length,
    };

    return Object.freeze({
      ok: true,
      counts,
      truncated,
      tools: bySource,
      summary: `Total tools: ${descriptors.length} (builtin: ${counts.builtin}, browser: ${counts.browser}, management: ${counts.management}, bundled-wasm: ${counts.bundledWasm}, webmcp: ${counts.webmcp}). Use search_tools to get an executable selectionRef for a tool.`,
    });
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
    // Atomically claim the run-bound reference before the first async
    // authorization/validation boundary. A concurrent or later reuse fails as
    // replay even when every live source label remains unchanged.
    const firstResolved = this.#selections.claim(
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
    const firstAuthority = await authorizeRecord(
      firstRecord,
      args,
      context,
      firstResolved.descriptor,
      "before-validation",
    );
    if (!firstAuthority.ok) return firstAuthority;
    const validated = await validateRecordArguments(firstRecord, args);
    if (!validated.ok) return validated;
    if (isAborted(signal)) return fixedError("lazy-run-aborted");

    // Validation is an async boundary. Rebuild and re-resolve every live
    // scope/source/package/capability/permission/grant fence before dispatch.
    let dispatchSnapshot;
    try {
      dispatchSnapshot = await liveSnapshot(this.#readSources);
    } catch {
      return fixedError("lazy-source-unavailable");
    }
    const dispatchResolved = this.#selections.revalidateClaim(
      firstResolved.claim,
      sourceContext(context, dispatchSnapshot.catalog.generation),
      dispatchSnapshot.catalog,
    );
    if (!dispatchResolved.ok) return dispatchResolved;
    const dispatchRecord = dispatchSnapshot.byStableId.get(
      dispatchResolved.descriptor.stableId,
    );
    const beforeDispatchAuthority = await authorizeRecord(
      dispatchRecord,
      validated.data,
      context,
      dispatchResolved.descriptor,
      "before-dispatch",
    );
    if (!beforeDispatchAuthority.ok) return beforeDispatchAuthority;
    // Validate through the SAME live record whose closure will dispatch. A
    // same-label closure/validator ABA cannot borrow an earlier validation.
    const dispatchValidated = await validateRecordArguments(
      dispatchRecord,
      validated.data,
    );
    if (!dispatchValidated.ok) return dispatchValidated;
    const dispatch = ownData(dispatchRecord, "dispatch");
    if (typeof dispatch !== "function") {
      return fixedError("lazy-dispatch-unavailable");
    }
    if (isAborted(signal)) return fixedError("lazy-run-aborted");

    let rawResult;
    let dispatchError = null;
    try {
      rawResult = await dispatch(
        dispatchValidated.data,
        Object.freeze({
          signal,
          runId: ownData(context, "runId"),
          taskId: ownData(context, "taskId"),
          agentId: ownData(context, "agentId"),
          origin: ownData(context, "origin"),
          documentId: ownData(context, "documentId"),
          runGeneration: ownData(context, "runGeneration"),
          replayMetadata: replayProjection(
            context,
            dispatchResolved.descriptor,
          ),
        }),
      );
    } catch (error) {
      // Preserve the platform's typed cancellation/ownership failures as real
      // AI-SDK tool errors; a lazy wrapper must never turn an abort into a
      // successful tool-result envelope.
      if (
        ownData(error, "name") === "RunAbortedError" ||
        ownData(error, "name") === "AbortError"
      ) {
        throw error;
      }
      dispatchError = error;
    }
    if (isAborted(signal)) return fixedError("lazy-run-aborted");

    // Discard both success and failure output if any live authority changed
    // during dispatch. A relay/provider-style completion is never authority.
    let after;
    try {
      after = await liveSnapshot(this.#readSources);
    } catch {
      return fixedError("lazy-source-unavailable");
    }
    const afterResolved = this.#selections.revalidateClaim(
      firstResolved.claim,
      sourceContext(context, after.catalog.generation),
      after.catalog,
    );
    if (!afterResolved.ok) return afterResolved;
    const afterRecord = after.byStableId.get(afterResolved.descriptor.stableId);
    if (!afterRecord) return fixedError("lazy-dispatch-source-stale");
    const afterAuthority = await authorizeRecord(
      afterRecord,
      dispatchValidated.data,
      context,
      afterResolved.descriptor,
      "after-dispatch",
    );
    if (!afterAuthority.ok) return afterAuthority;
    if (dispatchError) {
      return Object.freeze({
        ok: false,
        selectedTool: afterResolved.descriptor.name,
        error: truncateUtf8(
          safeProviderError(
            typeof dispatchError === "string"
              ? dispatchError
              : "lazy dispatcher failed",
          ),
          LAZY_TOOL_PROTOCOL_BOUNDS.maxErrorBytes,
        ),
      });
    }
    return Object.freeze({
      ok: true,
      selectedTool: afterResolved.descriptor.name,
      result: projectResult(rawResult),
      selectionRef,
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
    const toolId = ownData(descriptorInput, "toolId");
    const aiTool = ownData(toolMap, toolId);
    const execute = ownData(aiTool, "execute");
    const authorizationGuard = ownData(context, "authorizationGuard");
    return Object.freeze({
      descriptorInput,
      validateArguments: trustedAiValidator(aiTool),
      authorize: async (args, authorityContext) => {
        try {
          await assertRunOwned();
          if (typeof authorizationGuard === "function") {
            const guarded = await authorizationGuard(Object.freeze({
              toolId,
              args,
              phase: ownData(authorityContext, "phase"),
              context: authorityContext,
              descriptorInput,
            }));
            if (ownData(guarded, "ok") !== true) return { ok: false };
            return guarded;
          }
          return {
            ok: true,
            permissionDigest: ownData(descriptorInput, "permissionDigest") ?? "none",
            grantDigest: ownData(descriptorInput, "grantDigest") ?? "none",
          };
        } catch {
          return { ok: false };
        }
      },
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

export { buildLazyProviderCapture, LAZY_PROTOCOL_TOOL_WIRE };

/**
 * Single insertion point for model-invoked bundled WebAssembly execution authorization.
 *
 * Owner Policy Decision (2026-08-23):
 * "They're all approved to run because they are installed"
 *
 * Bundled WebAssembly tools are approved to run in owner/agent tasks because they are
 * technically installed (admitted) in the extension build. The build admission serves
 * as the owner grant.
 *
 * Authorization invariants:
 *   1. Admission & Availability: The tool must be in the admitted set of the live catalog
 *      at call time (`spec` exists, `descriptorInput.availability !== "disabled"`, not revoked).
 *      Disabled or revoked packages fail closed immediately.
 *   2. Run Ownership: The call must be within a valid, active owner run (`await assertRunOwned()`).
 *   3. Context Guard: If a run-level authorization guard is present, it is evaluated.
 *   4. Per-Call Execution Revalidation: Package CAS SHA/size, manifest digests, auditWasmBinary,
 *      and spec immutability are independently re-checked at dispatch time by the executor.
 */
export async function assertBundledExecutionAuthority({
  toolId,
  descriptorInput,
  validatedArgs,
  context,
} = {}) {
  // 1. Run ownership check (active, non-aborted owner run)
  await assertRunOwned();

  // 2. Admission check (owner policy: admission in build is the execution grant)
  const spec = previewSpecFor(toolId);
  if (!spec || descriptorInput?.availability === "disabled") {
    const error = new Error(`tool_${toolId}_not_admitted: bundled package is disabled or unadmitted`);
    error.code = "tool_not_admitted";
    throw error;
  }

  // 3. Optional context guard verification
  if (typeof context?.authorizationGuard === "function") {
    const guarded = await context.authorizationGuard({
      name: toolId,
      source: "bundled-package",
      args: validatedArgs,
      descriptorInput,
    });
    if (guarded?.ok !== true) {
      const error = new Error(`authorization_guard_rejected for tool ${toolId}`);
      error.code = "authorization_guard_rejected";
      throw error;
    }
  }

  return Object.freeze({
    ok: true,
    authorized: true,
    policy: "owner-build-admission",
    toolId,
    permissionDigest: "none",
    grantDigest: "none",
  });
}

export function executableBundledToolRecords(rows, context = {}) {
  return adaptBundledTools(rows, context).map((descriptorInput) => {
    const toolId = descriptorInput.toolId;
    const spec = previewSpecFor(toolId);
    const isAdmitted = Boolean(spec && descriptorInput.availability !== "disabled");

    const validator = async (rawArgs) => {
      if (!isAdmitted) {
        return { ok: false, error: `tool_${toolId}_disabled` };
      }
      try {
        let normalizedArgs = [];
        let normalizedStdin = "";
        if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
          if (Array.isArray(rawArgs.args)) {
            normalizedArgs = rawArgs.args.filter((a) => typeof a === "string");
          }
          if (typeof rawArgs.stdin === "string") {
            normalizedStdin = rawArgs.stdin;
          } else if (typeof rawArgs.input === "string") {
            normalizedStdin = rawArgs.input;
          } else if (typeof rawArgs.text === "string") {
            normalizedStdin = rawArgs.text;
          } else if (typeof rawArgs.docA === "string" && typeof rawArgs.docB === "string") {
            normalizedArgs = [rawArgs.docA, rawArgs.docB];
          }
        } else if (typeof rawArgs === "string") {
          normalizedStdin = rawArgs;
        } else if (Array.isArray(rawArgs)) {
          normalizedArgs = rawArgs.filter((a) => typeof a === "string");
        }

        const validated = validatePreviewInput({
          toolId,
          args: normalizedArgs,
          stdin: normalizedStdin,
        });
        return { ok: true, data: validated };
      } catch (err) {
        return { ok: false, error: `invalid_arguments: ${err?.message || err}` };
      }
    };

    const authorizer = async (validatedArgs, _authorityContext) => {
      try {
        return await assertBundledExecutionAuthority({
          toolId,
          descriptorInput,
          validatedArgs,
          context,
        });
      } catch (err) {
        return { ok: false, error: `authorization_failed: ${err?.message || err}` };
      }
    };

    const dispatcher = async (validatedArgs, runContext) => {
      if (typeof context.dispatchBundledTool === "function") {
        return await context.dispatchBundledTool({
          toolId,
          args: validatedArgs,
          context: runContext,
          descriptorInput,
        });
      }
      return await executeBundledWasiJob({
        toolId,
        args: validatedArgs.args,
        stdin: validatedArgs.stdin,
        runContext,
      });
    };

    return Object.freeze({
      descriptorInput,
      validateArguments: isAdmitted ? validator : null,
      authorize: isAdmitted ? authorizer : null,
      dispatch: isAdmitted ? dispatcher : null,
    });
  });
}

export function createLazyProviderToolset({
  readSources,
  contextReader,
  selectionAuthority,
} = {}) {
  const protocol = new LazyToolProtocol({ readSources, selectionAuthority });
  if (typeof contextReader !== "function") {
    throw new TypeError("lazy provider needs a run context reader");
  }
  const readContext = async () => {
    let context;
    try {
      context = await contextReader();
    } catch {
      return null;
    }
    return context && typeof context === "object" ? context : null;
  };
  const tools = Object.freeze({
    search_tools: tool({
      description: LAZY_PROTOCOL_TOOL_WIRE[0].description,
      inputSchema: z.object({
        query: z.string().max(512),
        limit: z.number().int().min(1).max(12).optional(),
      }).strict(),
      execute: async (request) => {
        const context = await readContext();
        return context
          ? await protocol.search(request, context)
          : fixedError("lazy-run-context-unavailable");
      },
    }),
    list_tools: tool({
      description: LAZY_PROTOCOL_TOOL_WIRE[1].description,
      inputSchema: z.object({
        source: z.string().optional(),
      }).strict(),
      execute: async (request) => {
        const context = await readContext();
        return context
          ? await protocol.list(request, context)
          : fixedError("lazy-run-context-unavailable");
      },
    }),
    execute_tool: tool({
      description: LAZY_PROTOCOL_TOOL_WIRE[2].description,
      inputSchema: z.object({
        selectionRef: z.string().regex(/^sel_[a-f0-9]{36}$/u),
        arguments: z.record(z.unknown()),
      }).strict(),
      execute: async (request) => {
        const context = await readContext();
        return context
          ? await protocol.execute(request, context)
          : fixedError("lazy-run-context-unavailable");
      },
    }),
  });
  return Object.freeze({
    tools,
    protocol,
    diagnostics: () => Object.freeze({
      ...protocol.diagnostics(),
      providerBound: true,
      eagerBindingChanged: true,
      exposedToolNames: Object.freeze(Object.keys(tools)),
      exposedToolCount: Object.keys(tools).length,
    }),
  });
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
    const authorizationGuard = ownData(context, "authorizationGuard");
    return Object.freeze({
      descriptorInput,
      validateArguments: validator,
      authorize: async (args, authorityContext) => {
        try {
          await assertRunOwned();
          if (typeof authorizationGuard === "function") {
            const guarded = await authorizationGuard(Object.freeze({
              name,
              source: expectedSource,
              args,
              phase: ownData(authorityContext, "phase"),
              context: authorityContext,
              descriptorInput,
            }));
            if (ownData(guarded, "ok") !== true) return { ok: false };
            return guarded;
          }
          return {
            ok: true,
            permissionDigest: ownData(descriptorInput, "permissionDigest") ?? "none",
            grantDigest: ownData(descriptorInput, "grantDigest") ?? "none",
          };
        } catch {
          return { ok: false };
        }
      },
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
