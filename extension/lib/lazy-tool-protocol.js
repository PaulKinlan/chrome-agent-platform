// lib/lazy-tool-protocol.js — bounded run-bound search/execute protocol core.
//
// This module is deliberately NOT provider-bound. It composes the landed
// canonical catalog, lexical index and selection authority with source records
// whose dispatch closures are the existing product tool closures. Search never
// grants authority. Execute re-reads live sources before validation, before
// dispatch and after dispatch; the existing source closure remains the only
// permission/grant/cancellation/replay authority.

import { jsonSchema, tool } from "ai";
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
import {
  TOOL_ARGUMENT_LIMITS,
  toolArgumentContract,
} from "./tool-argument-contract.js";
import { ToolSelectionAuthority } from "./tool-selection.js";
import { assertRunOwned } from "./run-fence.js";
import { observeToolCall } from "./cap-log.js";
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
  compileSchemaToZod,
  schemaToZod,
  SECRET_KEY_RE,
  truncateUtf8,
  utf8ByteLength,
} from "./pure.js";

export const LAZY_TOOL_PROTOCOL_BOUNDS = Object.freeze({
  maxSources: TOOL_CATALOG_BOUNDS.maxDescriptors * 2,
  maxArgumentBytes: TOOL_ARGUMENT_LIMITS.maxJsonUtf8Bytes,
  maxArgumentDepth: TOOL_ARGUMENT_LIMITS.maxDepth,
  maxArgumentNodes: TOOL_ARGUMENT_LIMITS.maxNodes,
  maxObjectKeys: TOOL_ARGUMENT_LIMITS.maxObjectKeys,
  maxArrayItems: TOOL_ARGUMENT_LIMITS.maxArrayItems,
  maxKeyBytes: TOOL_ARGUMENT_LIMITS.maxKeyUtf8Bytes,
  maxStringBytes: TOOL_ARGUMENT_LIMITS.maxStringUtf8Bytes,
  // Deliberate large-content channel: only product-owned fields named by the
  // shared argument contract may use their backing store's real body bound.
  maxLargeContentBytes: TOOL_ARGUMENT_LIMITS.maxAssetContentUtf8Bytes,
  maxLargeArgumentBytes: TOOL_ARGUMENT_LIMITS.maxLargeJsonUtf8Bytes,
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

class ArgumentSanitizationError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.name = "ArgumentSanitizationError";
    this.reason = reason;
    this.detail = detail;
  }
}

function argumentPath(path) {
  return path.length ? path.map((part) => typeof part === "number" ? `[${part}]` : String(part)).join(".").replace(".[", "[") : "(arguments)";
}

function sanitizationFailure(error, prefix = "") {
  if (error instanceof ArgumentSanitizationError) {
    return validationError(error.reason, `${prefix}${error.detail}`);
  }
  return validationError("bad-data", `${prefix}arguments must be a plain, finite JSON object within the published x-cap-argument-limits`);
}

/** The lazy-arguments-invalid error, enriched with a NAMED reason + bounded,
 * secret-redacted detail so the MODEL can see exactly which field failed and
 * repair its arguments (CAP-FB-20260824-WEBMCP-ARGSVALIDATION-01) — the opaque
 * code alone left the model guessing (it invented "ensure the tab is open and
 * has permissions" for a pure args mismatch). */
function validationError(reason, detail) {
  const out = {
    ok: false,
    error: "lazy-arguments-invalid",
    reason: String(reason ?? "parse-rejected"),
  };
  if (typeof detail === "string" && detail) {
    out.detail = truncateUtf8(redactSecretText(detail), 600);
  }
  return Object.freeze(out);
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

function projectData(value, limits, state, depth = 0, path = []) {
  if (++state.nodes > limits.maxNodes) {
    throw new ArgumentSanitizationError(
      "node-limit-exceeded",
      `${argumentPath(path)} makes the payload ${state.nodes} nodes; limit ${limits.maxNodes}. Remove fields or split the operation.`,
    );
  }
  if (depth > limits.maxDepth) {
    throw new ArgumentSanitizationError(
      "depth-limit-exceeded",
      `${argumentPath(path)} is at depth ${depth}; limit ${limits.maxDepth}. Flatten the object before retrying.`,
    );
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ArgumentSanitizationError(
        "invalid-number",
        `${argumentPath(path)} must be a finite JSON number.`,
      );
    }
    return value;
  }
  if (typeof value === "string") {
    if (hasLoneSurrogates(value)) {
      throw new ArgumentSanitizationError(
        "invalid-unicode",
        `${argumentPath(path)} contains an unpaired Unicode surrogate; send valid Unicode text.`,
      );
    }
    const fieldLimit = limits.stringLimit?.(path) ?? limits.maxStringBytes;
    const preserve = limits.preserveString?.(path) === true;
    const normalized = preserve ? value : value.normalize("NFKC");
    const actualBytes = utf8ByteLength(normalized);
    if (!limits.truncateStrings && actualBytes > fieldLimit) {
      const remediation = preserve
        ? `Reduce the complete content to ≤${fieldLimit} UTF-8 bytes; it will never be silently truncated.`
        : `Shorten this field to ≤${fieldLimit} UTF-8 bytes, or use the designated create_asset.content large-content path for a complete document.`;
      throw new ArgumentSanitizationError(
        "string-limit-exceeded",
        `${argumentPath(path)} is ${actualBytes} UTF-8 bytes; limit ${fieldLimit}. ${remediation}`,
      );
    }
    return truncateUtf8(normalized, fieldLimit);
  }
  if (
    value === undefined || typeof value === "bigint" ||
    typeof value === "function" || typeof value === "symbol"
  ) {
    throw new ArgumentSanitizationError(
      "invalid-type",
      `${argumentPath(path)} has unsupported type ${typeof value}; send JSON data only.`,
    );
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
      throw new ArgumentSanitizationError(
        "array-limit-exceeded",
        `${argumentPath(path)} has ${length} items; limit ${limits.maxArrayItems}. Split it into smaller calls.`,
      );
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
        throw new ArgumentSanitizationError(
          "invalid-shape",
          `${argumentPath([...path, index])} must be a plain data value, not a hole or accessor.`,
        );
      }
      out.push(projectData(descriptor.value, limits, state, depth + 1, [...path, index]));
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
    if (keys.some((key) => typeof key !== "string")) {
      throw new ArgumentSanitizationError(
        "invalid-key",
        `${argumentPath(path)} contains a symbol key; object keys must be plain strings.`,
      );
    }
    if (keys.length > limits.maxObjectKeys) {
      throw new ArgumentSanitizationError(
        "object-limit-exceeded",
        `${argumentPath(path)} has ${keys.length} keys; limit ${limits.maxObjectKeys}. Remove fields or split the operation.`,
      );
    }
    const out = Object.create(null);
    for (const rawKey of keys.sort()) {
      const key = safeKey(rawKey);
      const descriptor = descriptors[rawKey];
      if (!key) {
        throw new ArgumentSanitizationError(
          "invalid-key",
          `${argumentPath([...path, rawKey])} is forbidden, invalid Unicode, or exceeds ${LAZY_TOOL_PROTOCOL_BOUNDS.maxKeyBytes} UTF-8 bytes; rename the field.`,
        );
      }
      if (!("value" in descriptor)) {
        throw new ArgumentSanitizationError(
          "invalid-shape",
          `${argumentPath([...path, rawKey])} must be a plain data value, not an accessor.`,
        );
      }
      out[key] = projectData(descriptor.value, limits, state, depth + 1, [...path, key]);
    }
    return out;
  }
  throw new Error("data-type-invalid");
}

export function sanitizeLazyToolArguments(value, descriptor) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ArgumentSanitizationError(
      "arguments-must-be-object",
      `(arguments) must be an object; received ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}.`,
    );
  }
  const contract = toolArgumentContract(descriptor?.sourceKind, descriptor?.toolId);
  const contentField = contract.largeContent?.field ?? null;
  const contentLimit = contract.largeContent?.maxUtf8Bytes ?? LAZY_TOOL_PROTOCOL_BOUNDS.maxStringBytes;
  const projected = projectData(value, {
    maxNodes: LAZY_TOOL_PROTOCOL_BOUNDS.maxArgumentNodes,
    maxDepth: LAZY_TOOL_PROTOCOL_BOUNDS.maxArgumentDepth,
    maxObjectKeys: LAZY_TOOL_PROTOCOL_BOUNDS.maxObjectKeys,
    maxArrayItems: LAZY_TOOL_PROTOCOL_BOUNDS.maxArrayItems,
    maxStringBytes: LAZY_TOOL_PROTOCOL_BOUNDS.maxStringBytes,
    stringLimit: (path) => path.length === 1 && path[0] === contentField
      ? contentLimit
      : LAZY_TOOL_PROTOCOL_BOUNDS.maxStringBytes,
    preserveString: (path) => path.length === 1 && path[0] === contentField,
    truncateStrings: false,
  }, { nodes: 0 });
  const maxArgumentBytes = contract.maxJsonUtf8Bytes;
  const actualArgumentBytes = utf8ByteLength(JSON.stringify(projected));
  if (actualArgumentBytes > maxArgumentBytes) {
    throw new ArgumentSanitizationError(
      "payload-limit-exceeded",
      `(arguments) is ${actualArgumentBytes} JSON UTF-8 bytes; limit ${maxArgumentBytes}. Split the operation into smaller calls${contentField ? ` while keeping ${contentField} complete and ≤${contentLimit} bytes` : ", or use the designated large-content path for documents"}.`,
    );
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
      return degradeResult(value, "result exceeded the lazy protocol output bound");
    }
    return redacted;
  } catch {
    return degradeResult(value, "result was not safely serializable in full");
  }
}

/** BOUNDING MUST DEGRADE, NOT ERASE (CAP-FB-20260828-TOOL-RESULT-ENVELOPE-01).
 *
 * This previously replaced an over-bound result with a bare summary string, so
 * a `create_asset` whose payload tripped a bound came back as
 * `{bounded:true, summary:"tool completed; result was not safely serializable"}`
 * — the model never learned the id of the artifact it had just made, and the UI
 * had nothing to render. The bound is there to stop unbounded data reaching the
 * provider; it was never meant to destroy the answer.
 *
 * So keep what is small and identifying — the top-level scalars, which is where
 * `ok`, `id`, `error` and counts live — drop the bulk, and say plainly that the
 * rest was dropped. Everything kept still goes through the same redaction and
 * truncation, and the whole thing is re-checked against the byte bound; if even
 * this does not fit, THEN fall back to the summary. */
function degradeResult(value, why) {
  const summary = `tool completed; ${why} — identifying fields kept, bulk omitted`;
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return Object.freeze({ bounded: true, summary });
    }
    const kept = {};
    let dropped = 0;
    for (const [key, child] of Object.entries(value)) {
      const scalar = child === null || typeof child === "string" ||
        typeof child === "number" || typeof child === "boolean";
      if (!scalar) { dropped += 1; continue; }
      if (typeof child === "number" && !Number.isFinite(child)) { dropped += 1; continue; }
      if (utf8ByteLength(String(key)) > LAZY_TOOL_PROTOCOL_BOUNDS.maxKeyBytes) { dropped += 1; continue; }
      if (Object.keys(kept).length >= LAZY_TOOL_PROTOCOL_BOUNDS.maxObjectKeys) { dropped += 1; continue; }
      kept[key] = typeof child === "string"
        ? redactSecretText(truncateUtf8(child.normalize("NFKC"), LAZY_TOOL_PROTOCOL_BOUNDS.maxStringBytes))
        : child;
      if (SECRET_KEY_RE.test(key)) kept[key] = "[REDACTED]";
    }
    const out = { ...kept, bounded: true, droppedFields: dropped, summary };
    if (utf8ByteLength(JSON.stringify(out)) > LAZY_TOOL_PROTOCOL_BOUNDS.maxResultBytes) {
      return Object.freeze({ bounded: true, summary });
    }
    return Object.freeze(out);
  } catch {
    return Object.freeze({ bounded: true, summary });
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

function valueAtPath(value, path) {
  let current = value;
  for (const part of path) current = ownData(current, String(part));
  return current;
}

function validationIssueDetail(args, issues) {
  return (issues ?? []).slice(0, 8).map((issue) => {
    const path = Array.isArray(issue?.path) ? issue.path : [];
    const field = argumentPath(path);
    const actual = valueAtPath(args, path);
    if (issue?.code === "too_big") {
      const unit = issue?.type === "string" ? "characters" : issue?.type === "array" ? "items" : "values";
      const size = typeof actual === "string" || Array.isArray(actual) ? actual.length : "unknown";
      return `${field} has ${size} ${unit}; limit ${issue.maximum}`;
    }
    if (issue?.code === "too_small") {
      const size = typeof actual === "string" || Array.isArray(actual) ? actual.length : "unknown";
      return `${field} has ${size} ${issue?.type === "array" ? "items" : "characters"}; minimum ${issue.minimum}`;
    }
    if (issue?.code === "invalid_type") {
      return `${field} must be ${issue.expected}; received ${issue.received}`;
    }
    return `${field}: ${String(issue?.message ?? "invalid; follow the published schema")}`;
  }).join("; ");
}

async function validateRecordArguments(record, args, descriptor) {
  const validate = ownData(record, "validateArguments");
  if (typeof validate !== "function") {
    return fixedError("lazy-validator-unavailable");
  }
  let result;
  try {
    result = await validate(args);
  } catch {
    return validationError("validator-threw", "the tool's argument validator threw");
  }
  if (ownData(result, "ok") !== true) {
    return validationError(ownData(result, "reason"), ownData(result, "detail"));
  }
  const data = ownData(result, "data");
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return validationError("bad-data", "the validator returned a non-object payload");
  }
  try {
    // A trusted validator may apply defaults/transforms. Bound and accessor-check
    // that derived object too before it reaches the existing dispatcher.
    return Object.freeze({ ok: true, data: sanitizeLazyToolArguments(data, descriptor) });
  } catch (error) {
    return sanitizationFailure(error, "the validator returned invalid data: ");
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
      "provider-server": [],
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
      else if (srcKind === "provider-server") group = "provider-server";
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
        schemaSummary: truncateUtf8(String(desc.schemaSummary ?? ""), 4096),
        outputSchemaSummary: truncateUtf8(String(desc.outputSchemaSummary ?? ""), 4096),
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
      providerServer: bySource["provider-server"].length,
    };

    return Object.freeze({
      ok: true,
      counts,
      truncated,
      tools: bySource,
      summary: `Total tools: ${descriptors.length} (builtin: ${counts.builtin}, browser: ${counts.browser}, management: ${counts.management}, bundled-wasm: ${counts.bundledWasm}, webmcp: ${counts.webmcp}, provider-server: ${counts.providerServer}). Use search_tools to get an executable selectionRef for a tool.`,
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
      args = sanitizeLazyToolArguments(ownData(request, "arguments"), firstResolved.descriptor);
    } catch (error) {
      return sanitizationFailure(error);
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
    const validated = await validateRecordArguments(firstRecord, args, firstResolved.descriptor);
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
      dispatchResolved.descriptor,
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
      rawResult = await observeToolCall(
        dispatchResolved.descriptor.name,
        dispatchValidated.data,
        () => dispatch(
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
        ),
        {
          source: ownData(dispatchResolved.descriptor, "sourceKind") ?? "lazy",
          runId: ownData(context, "runId") ?? null,
        },
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
      // Renderer-only metadata: the UI consumes this bounded selected-tool
      // contract and does not display it as part of the result tree.
      schemaSummary: afterResolved.descriptor.outputSchemaSummary,
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
    if (ownData(parsed, "success") === true) {
      return { ok: true, data: ownData(parsed, "data") };
    }
    let issues;
    try {
      // Zod exposes `error` as an accessor on the parse-result envelope. The
      // schema is product-owned here, so read it inside the guard rather than
      // dropping the model-repair detail through ownData's accessor defence.
      issues = parsed.error?.issues;
    } catch {
      issues = [];
    }
    return {
      ok: false,
      reason: "parse-rejected",
      detail: validationIssueDetail(args, issues),
    };
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
      outputSchema: jsonSchema(LAZY_PROTOCOL_TOOL_WIRE[0].outputSchema),
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
      outputSchema: jsonSchema(LAZY_PROTOCOL_TOOL_WIRE[1].outputSchema),
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
      outputSchema: jsonSchema(LAZY_PROTOCOL_TOOL_WIRE[2].outputSchema),
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
    const schema = ownData(sourceTool, "inputSchema") ?? {};
    // Fail-open compile (CAP-FB-20260824-WEBMCP-ARGSVALIDATION-01): unknown /
    // unsupported / optional keywords ($schema, format, pattern, oneOf, ...)
    // are dropped with a record, never bricking the tool; DoS-bounds violations
    // still fail closed as a named schema-compile-failed. Parse rejections
    // carry the per-field zod issues so the model can repair its arguments.
    const compiled = compileSchemaToZod(z, schema);
    const onValidationDenied = ownData(context, "onValidationDenied");
    let validator;
    const deny = (reason, detail) => {
      try {
        onValidationDenied?.({ name, origin: ownData(context, "origin") ?? "", reason, detail });
      } catch { /* diagnostics must never break validation */ }
    };
    if (compiled.fatal) {
      deny("schema-compile-failed", compiled.fatal);
      validator = async () => ({ ok: false, reason: "schema-compile-failed", detail: compiled.fatal });
    } else {
      validator = async (args) => {
        const parsed = compiled.zodSchema.safeParse(args);
        if (parsed.success) return { ok: true, data: parsed.data };
        const detail = truncateUtf8(
          redactSecretText(validationIssueDetail(args, parsed.error?.issues)),
          600,
        );
        deny("parse-rejected", detail);
        return { ok: false, reason: "parse-rejected", detail };
      };
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
