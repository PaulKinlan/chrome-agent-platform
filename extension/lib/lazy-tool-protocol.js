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
  adaptMcpTools,
  adaptWebMcpTools,
  buildToolCatalog,
  canonicalToolDescriptor,
  TOOL_CATALOG_BOUNDS,
} from "./tool-catalog.js";
import { buildToolSearchIndex, searchToolIndex } from "./tool-search.js";
import { loadToolVectorTable } from "./tool-vectors.js";
import {
  toolArgumentContract,
} from "./tool-argument-contract.js";
import { descriptorByIdentity, ToolSelectionAuthority, toolIdentityKey } from "./tool-selection.js";
import { assertRunOwned } from "./run-fence.js";
import { observeToolCall } from "./cap-log.js";
import {
  buildLazyProviderCapture,
  LAZY_PROTOCOL_TOOL_WIRE,
} from "./lazy-tool-wire.js";
import { runPipeline } from "./tool-pipeline.js";
import { createWorkflowPipelineDispatcher } from "./workflows.js";
import {
  fenceUntrustedText,
  fenceUntrustedValue,
  isUntrustedToken,
  mintUntrustedToken,
} from "./untrusted-fence.js";
import {
  executeBundledWasiJob,
  isStreamBackedBundledTool,
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
} from "./pure.js";

// dptw (2026-09-03): no size limits on arguments, results, or source counts.
// Sanitization keeps its SHAPE checks (plain JSON data: finite numbers, no
// lone surrogates, no symbol/proto keys, no accessors) — every size ceiling
// is gone and a provider-side limit surfaces as the provider's honest error.
const NO_LIMIT = Number.POSITIVE_INFINITY;

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

// Owner-only site activity enters from the trusted dispatch wrapper through a
// symbol, then emits on the run's local progress channel. It never enters the
// lazy result, output schema, provider/model content, or argument/result log.
// The dispatch wrapper is accepted only for a WebMCP record.
const OWNER_SITE_TOOL_DISPATCH = Symbol("cap.owner-site-tool-dispatch");

function normalizeOwnerSiteActivity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let keys;
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    keys = Reflect.ownKeys(value);
  } catch { return null; }
  if (keys.length !== 2 || !keys.includes("origin") || !keys.includes("tool")) return null;
  const originDescriptor = Object.getOwnPropertyDescriptor(value, "origin");
  const toolDescriptor = Object.getOwnPropertyDescriptor(value, "tool");
  if (!originDescriptor?.enumerable || !("value" in originDescriptor) || !toolDescriptor?.enumerable || !("value" in toolDescriptor)) return null;
  const origin = originDescriptor.value;
  const toolName = toolDescriptor.value;
  if (typeof origin !== "string" || origin.length > 240 || typeof toolName !== "string" || !toolName || toolName.length > 128) return null;
  try {
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) return null;
  } catch { return null; }
  return Object.freeze({ origin, tool: toolName });
}

function ownerSafeToolLabel(value) {
  try {
    const label = value.normalize("NFC").replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, (char) =>
      `\\u{${char.codePointAt(0).toString(16).toUpperCase()}}`
    );
    if (label.length <= 128) return label;
    let clipped = "";
    for (const char of label) {
      if (clipped.length + char.length > 127) break;
      clipped += char;
    }
    return `${clipped}…`;
  } catch { return "site tool"; }
}

/** Wrap a trusted WebMCP dispatch result with owner-only provenance. */
export function withOwnerSiteToolActivity(result, activity) {
  const normalized = normalizeOwnerSiteActivity(activity);
  if (!normalized) return result;
  const wrapped = { result };
  Object.defineProperty(wrapped, OWNER_SITE_TOOL_DISPATCH, { value: normalized });
  return Object.freeze(wrapped);
}

function splitOwnerSiteToolDispatch(value, descriptor) {
  if (!String(ownData(descriptor, "sourceKind") ?? "").startsWith("webmcp")) {
    return { result: value, activity: null };
  }
  const wrappedActivity = ownData(value, OWNER_SITE_TOOL_DISPATCH);
  if (wrappedActivity === undefined) return { result: value, activity: null };
  const activity = normalizeOwnerSiteActivity(wrappedActivity);
  const descriptorName = ownData(descriptor, "name");
  if (!activity || typeof descriptorName !== "string" || activity.tool !== descriptorName) {
    return { result: ownData(value, "result"), activity: null };
  }
  return {
    result: ownData(value, "result"),
    activity: Object.freeze({ origin: activity.origin, tool: ownerSafeToolLabel(activity.tool) }),
  };
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

// CAP-FB-20260901-APPROVAL-RESUME-REEXECUTES-01 — the paused-call memory and
// the per-run approval window (see LazyToolProtocol#pausedCalls).
const MAX_PAUSED_CALLS = 8;
const MAX_APPROVAL_WINDOWS = 32;
// How long after an approval settles an in-flight sibling may still
// revalidate across the grant's catalog regeneration.
const APPROVAL_GRACE_MS = 30 * 1000;
// The failures a catalog regeneration produces for a claim that pre-dates it.
const GRANT_DRIFT_ERRORS = new Set([
  "selection-scope-mismatch",
  "selection-catalog-stale",
  "selection-source-stale",
]);

/** The structured owner-permission denial a tool returns when it lacks a
 * capability ({ waitingForPermission:true, permissionRequirement }). */
function isPermissionPause(result) {
  const requirement = ownData(result, "permissionRequirement");
  return ownData(result, "waitingForPermission") === true &&
    typeof requirement === "object" && requirement !== null;
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
  return validationError("bad-data", `${prefix}arguments must be a plain, finite JSON object`);
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
    // Secret-redacted, never size-clipped: the model needs the WHOLE reason
    // to repair its arguments (dptw — the 600-char clip hid real causes).
    out.detail = redactSecretText(detail);
  }
  return Object.freeze(out);
}

/** The lazy-arguments-invalid error with the un-consumed selectionRef and an
 * explicit retry signal. The detail is complete (secret-redacted, never
 * size-clipped). */
function retryableArgumentFailure(failure, selectionRef) {
  if (ownData(failure, "error") !== "lazy-arguments-invalid") return failure;
  return Object.freeze({ ...failure, selectionRef, retryable: true });
}

function safeKey(key) {
  if (typeof key !== "string" || hasLoneSurrogates(key)) return "";
  let normalized;
  try {
    normalized = key.normalize("NFKC");
  } catch {
    return "";
  }
  if (!normalized) return "";
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
    // No size limit (dptw): strings pass whole. preserveString marks the
    // contract's exact-content fields (write_file.content, asset bodies) so
    // their bytes are carried without Unicode normalization.
    const preserve = limits.preserveString?.(path) === true;
    return preserve ? value : value.normalize("NFKC");
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
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ArgumentSanitizationError(
        "invalid-shape",
        `${argumentPath(path)} must be an array of plain data values.`,
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
          `${argumentPath([...path, rawKey])} is forbidden or invalid Unicode; rename the field.`,
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
  // Shape-only projection (dptw): plain JSON data of ANY size passes; the
  // designated content field keeps its exact bytes (no NFKC normalization).
  const projected = projectData(value, {
    maxNodes: NO_LIMIT,
    maxDepth: NO_LIMIT,
    maxObjectKeys: NO_LIMIT,
    maxArrayItems: NO_LIMIT,
    preserveString: (path) => path.length === 1 && path[0] === contentField,
  }, { nodes: 0 });
  return projected;
}

/** Is this result untrusted content — page/site/board data, never an
 * instruction? Either the tool tagged it (`untrusted: true`, e.g. read_page,
 * board reads, cap:fetch) or it came from a site-origin (WebMCP) tool, whose
 * output is page-controlled by construction. */
function isUntrustedResult(value, descriptor) {
  if (ownData(value, "untrusted") === true) return true;
  const kind = String(ownData(descriptor, "sourceKind") ?? "");
  // WebMCP (page-exposed) and remote MCP (connect-out) tool output is external
  // content by construction — fenced even if the tool forgot to tag it.
  return kind.startsWith("webmcp") || kind === "mcp";
}

/* ── the binary side channel (CAP-FB-20260830-SCREENSHOT-TO-MODEL-01) ────────
 *
 * A screenshot is PNG bytes, and bytes are not JSON. `projectResultWithAttachments`
 * lifts any top-level `data:image/*;base64,` field OUT of the result — the model
 * JSON keeps the id, the URL and the dimensions — and returns it beside the
 * projection as an attachment. The provider toolset re-attaches it as a real
 * image content part on lanes whose transport carries one. Nothing is
 * truncated: an attachment is carried whole (dptw: at any size; a provider
 * image limit surfaces as the provider's honest error). */
const IMAGE_ATTACHMENT_FIELD = "screenshot";
const IMAGE_DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i;

/** Lift the image bytes out of a raw dispatch result. Returns the result with
 * the image field REMOVED (never truncated) plus the attachments it carried.
 * Reads only own data properties — a hostile accessor is never invoked. */
function liftImageAttachments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value, attachments: [] };
  }
  const dataUrl = ownData(value, IMAGE_ATTACHMENT_FIELD);
  if (typeof dataUrl !== "string") return { value, attachments: [] };
  const match = IMAGE_DATA_URL_RE.exec(dataUrl);
  if (!match) return { value, attachments: [] };
  const [, mediaType, data] = match;
  const stripped = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (key === IMAGE_ATTACHMENT_FIELD) continue;
    if (!("value" in descriptor)) continue;
    stripped[key] = descriptor.value;
  }
  const screenshotId = ownData(value, "screenshotId");
  return {
    value: stripped,
    attachments: [Object.freeze({
      type: "image",
      mediaType: mediaType.toLowerCase(),
      data,
      screenshotId: typeof screenshotId === "string" ? screenshotId : null,
    })],
  };
}

const EMPTY_ATTACHMENTS = Object.freeze([]);

/** `projectResult` plus the lifted image attachments (see above).
 *
 * UNTRUSTED results are never lifted. An image part is content the model LOOKS
 * AT, and a site-origin (WebMCP) tool that returned
 * `screenshot: "data:image/png;base64,…"` would otherwise get a picture of its
 * own choosing — instructions rendered as pixels — into the conversation,
 * straight past the text fence that exists to stop exactly that. Page data
 * stays text, bounded and fenced, as it was. */
function projectResultWithAttachments(value, options) {
  const lifted = options?.untrusted === true
    ? { value, attachments: EMPTY_ATTACHMENTS }
    : liftImageAttachments(value);
  return {
    result: projectResult(lifted.value, options),
    attachments: Object.freeze(lifted.attachments),
  };
}

/** Project a raw dispatch result for the model: redact secrets and — for
 * untrusted content — wrap every string leaf in the run's boundary
 * (lib/untrusted-fence.js, CAP-FB-20260830-UNTRUSTED-CONTENT-FENCING-01).
 * No size limits (dptw): the complete result reaches the model; a result that
 * cannot be serialized at all degrades honestly (see degradeResult). */
function projectResult(value, { untrusted = false, token = null } = {}) {
  const fence = (projected) => untrusted ? fenceUntrustedValue(projected, token) : projected;
  try {
    const projected = projectData(value, {
      maxNodes: NO_LIMIT,
      maxDepth: NO_LIMIT,
      maxObjectKeys: NO_LIMIT,
      maxArrayItems: NO_LIMIT,
    }, { nodes: 0 });
    return fence(redactResultStrings(projected));
  } catch {
    return fence(degradeResult(value, "result was not safely serializable in full"));
  }
}

/** SERIALIZATION-FAILURE FALLBACK (CAP-FB-20260828-TOOL-RESULT-ENVELOPE-01).
 *
 * Runs only when a result cannot be projected as plain JSON at all (hostile
 * accessors, circular shapes). Never a size path — results of any size pass
 * whole (dptw). Keep what is small and identifying — the top-level scalars,
 * which is where `ok`, `id`, `error` and counts live — and say plainly that
 * the rest could not be carried. */
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
      kept[key] = typeof child === "string"
        ? redactSecretText(child.normalize("NFKC"))
        : child;
      if (SECRET_KEY_RE.test(key)) kept[key] = "[REDACTED]";
    }
    return Object.freeze({ ...kept, bounded: true, droppedFields: dropped, summary });
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

async function liveSnapshot(readSources, { vectorTable = null } = {}) {
  const raw = await readSources();
  if (!Array.isArray(raw)) {
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
    index: buildToolSearchIndex(catalog, { vectorTable }),
    vectorTable,
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
  // The fallback boundary token for a run context that carries none (a caller
  // that never threaded runtime-context's token). Untrusted content is STILL
  // fenced — the model just cannot cross-check the token against its policy
  // layer. Per instance, random, never a fixed string a page could forge.
  #fallbackToken = mintUntrustedToken();
  // The binary side channel: selectionRef -> the image parts lifted out of that
  // execution's result. Bounded to the last few calls so a run that screenshots
  // repeatedly can never hold more than a few megabytes of PNG in the worker.
  #attachments = new Map();
  // The calls PAUSED on an owner permission card (CAP-FB-20260901-APPROVAL-
  // RESUME-REEXECUTES-01): selectionRef -> { toolIdentity, name, args, context }
  // recorded when a dispatch returned the structured permission denial. The
  // runtime (lib/agent.js's post-tool hook, never the model) re-runs exactly
  // that call once the owner approves — the same tool, the ORIGINAL validated
  // arguments, a runtime-issued selection — and the model receives the real
  // result. Single-use, bounded, and only ever consumed for the run fence
  // that recorded it.
  #pausedCalls = new Map();
  // Per-run approval windows: while a run has a pause pending, or for a short
  // grace period after the owner approved, an owner grant is the EXPECTED
  // cause of a mid-flight catalog regeneration (the grant changes every
  // chrome-api stableId), so a claimed call revalidates across it by tool
  // identity instead of failing as scope-mismatch. runId -> { pending, until }.
  #approvalWindows = new Map();
  // 4kl: optional loader for the bundled semantic vector table (parsed lazily,
  // cached by tool-vectors.js). Absent/failed load = lexical-only search,
  // reported honestly in diagnostics as semantic: "unavailable".
  #vectorTableLoader;

  /**
   * @param {{
   *   readSources?: any,
   *   selectionAuthority?: any,
   *   vectorTableLoader?: null | (() => Promise<any>),
   * }} [options]
   */
  constructor({ readSources, selectionAuthority, vectorTableLoader = null } = {}) {
    if (typeof readSources !== "function") {
      throw new TypeError("lazy protocol needs a live source reader");
    }
    this.#readSources = readSources;
    this.#selections = selectionAuthority ?? new ToolSelectionAuthority();
    this.#vectorTableLoader = vectorTableLoader;
  }

  async #snapshot() {
    const vectorTable = this.#vectorTableLoader
      ? await loadToolVectorTable(this.#vectorTableLoader)
      : null;
    return liveSnapshot(this.#readSources, { vectorTable });
  }

  #untrustedToken(context) {
    const token = ownData(context, "untrustedToken");
    return isUntrustedToken(token) ? token : this.#fallbackToken;
  }

  /** Record one execution's lifted image parts. */
  #rememberAttachments(selectionRef, attachments) {
    if (!attachments?.length || typeof selectionRef !== "string") return;
    this.#attachments.set(selectionRef, attachments);
  }

  /** The image parts belonging to one completed execution — the side channel
   * the provider toolset re-attaches as a real image content part. Never part
   * of the model-facing JSON. Returns a (possibly empty) frozen array. */
  attachmentsFor(selectionRef) {
    return this.#attachments.get(selectionRef) ?? EMPTY_ATTACHMENTS;
  }

  #approvalWindow(runId, now = Date.now()) {
    for (const [key, window] of this.#approvalWindows) {
      if (window.pending.size === 0 && window.until <= now) this.#approvalWindows.delete(key);
    }
    if (typeof runId !== "string" || !runId) return null;
    let window = this.#approvalWindows.get(runId);
    if (!window) {
      window = { pending: new Set(), until: 0 };
      this.#approvalWindows.set(runId, window);
      while (this.#approvalWindows.size > MAX_APPROVAL_WINDOWS) {
        const oldest = this.#approvalWindows.keys().next().value;
        if (oldest === runId) break;
        this.#approvalWindows.delete(oldest);
      }
    }
    return window;
  }

  /** Whether a claimed call of `context`'s run may revalidate ACROSS a catalog
   * regeneration right now (a pause pending, or an approval settled within
   * the grace period) and `error` is the drift a grant produces. */
  #toleratesGrantDrift(context, error) {
    if (!GRANT_DRIFT_ERRORS.has(error)) return false;
    const runId = ownData(context, "runId");
    const window = typeof runId === "string" && runId ? this.#approvalWindows.get(runId) : null;
    if (!window) return false;
    return window.pending.size > 0 || window.until > Date.now();
  }

  /** revalidateClaim, then — only inside the run's approval window and only
   * for the drift a grant produces — the across-grant revalidation by tool
   * identity (tool-selection.js revalidateClaimAcrossGrant). The caller still
   * re-authorizes live against whatever descriptor comes back. */
  #revalidateAcrossGrant(claim, context, catalog) {
    const resolved = this.#selections.revalidateClaim(claim, context, catalog);
    if (resolved.ok || !this.#toleratesGrantDrift(context, resolved.error)) return resolved;
    return this.#selections.revalidateClaimAcrossGrant(claim, context, catalog);
  }

  /** Remember a dispatch that returned the structured permission denial so
   * the runtime can re-run it after the owner's Allow. Opens the run's
   * approval window. */
  #rememberPausedCall(selectionRef, descriptor, args, context, catalogGeneration) {
    if (typeof selectionRef !== "string" || !selectionRef) return;
    this.#pausedCalls.set(selectionRef, Object.freeze({
      selectionRef,
      toolIdentity: toolIdentityKey(descriptor),
      name: descriptor.name,
      args,
      context: sourceContext(context, catalogGeneration),
    }));
    while (this.#pausedCalls.size > MAX_PAUSED_CALLS) {
      const oldest = this.#pausedCalls.keys().next().value;
      this.#pausedCalls.delete(oldest);
    }
    this.#approvalWindow(ownData(context, "runId"))?.pending.add(selectionRef);
  }

  /** Forget a paused call the owner did NOT approve (denied / expired /
   * aborted): the call is never executed, and the run's approval window
   * closes when no other pause is pending. Runtime-only. */
  settlePausedCall(selectionRef) {
    const paused = this.#pausedCalls.get(selectionRef);
    if (!paused) return false;
    this.#pausedCalls.delete(selectionRef);
    this.#approvalWindows.get(paused.context.runId)?.pending.delete(selectionRef);
    return true;
  }

  /** RUNTIME-ONLY (CAP-FB-20260901-APPROVAL-RESUME-REEXECUTES-01): after the
   * owner approved the permission card a dispatch paused on, run THAT call
   * again — the same tool (by its grant-independent identity, because the
   * grant just changed its stableId), the ORIGINAL validated arguments, under
   * the SAME run fence — through the ordinary execute path, so every fence
   * (claim, live authority before/after dispatch, validation through the live
   * record, the run signal, the untrusted-content projection) applies exactly
   * as it does to a model-issued call. The selection it needs is issued here,
   * by the runtime, never by a model-facing search. The run's other live
   * selections are re-keyed to the post-grant catalog first, so references
   * the model already holds keep resolving. Single-use: a paused call resumes
   * at most once, and a denied/expired call never reaches here. Not on the
   * tool wire — no model, page or site principal can call it. */
  async resumeApprovedCall(selectionRef, context = {}) {
    const paused = this.#pausedCalls.get(selectionRef);
    if (!paused) return fixedError("lazy-resume-unavailable");
    this.#pausedCalls.delete(selectionRef);
    const window = this.#approvalWindows.get(paused.context.runId);
    // The grant has landed: in-flight siblings finish their revalidation
    // across it. Opened BEFORE the first await below (a sibling's after-check
    // can run in any gap) and before this pause stops counting as pending.
    if (window) window.until = Date.now() + APPROVAL_GRACE_MS;
    window?.pending.delete(selectionRef);
    const signal = ownData(context, "signal");
    if (isAborted(signal)) return fixedError("lazy-run-aborted");
    const fence = sourceContext(context, paused.context.catalogGeneration);
    if (
      fence.runId !== paused.context.runId || fence.taskId !== paused.context.taskId ||
      fence.agentId !== paused.context.agentId || fence.origin !== paused.context.origin ||
      fence.documentId !== paused.context.documentId ||
      fence.runGeneration !== paused.context.runGeneration
    ) {
      return fixedError("lazy-resume-scope-mismatch");
    }
    let snapshot;
    try {
      snapshot = await liveSnapshot(this.#readSources);
    } catch {
      return fixedError("lazy-source-unavailable");
    }
    if (isAborted(signal)) return fixedError("lazy-run-aborted");
    const nextContext = sourceContext(context, snapshot.catalog.generation);
    // Siblings and later steps: the references issued before the grant.
    this.#selections.rebindAfterGrant(paused.context, nextContext, snapshot.catalog);
    const descriptor = descriptorByIdentity(snapshot.catalog, paused.toolIdentity);
    if (!descriptor || descriptor.availability !== "ready") {
      return fixedError("lazy-resume-tool-unavailable");
    }
    const issued = this.#selections.issue(
      { catalogGeneration: snapshot.catalog.generation, results: [{ stableId: descriptor.stableId, name: descriptor.name }] },
      nextContext,
      snapshot.catalog,
    );
    const reissued = issued?.ok ? ownData(ownData(issued.results, "0"), "selectionRef") : null;
    if (typeof reissued !== "string") return issued?.ok ? fixedError("lazy-resume-unavailable") : issued;
    return this.execute({ selectionRef: reissued, arguments: paused.args }, context);
  }

  /** Site-origin (WebMCP) tool descriptions are page-authored: fence them in
   * every listing the model sees (search summaries + list descriptions). */
  #fenceWebMcpListing(entry, context, field) {
    if (!String(ownData(entry, "sourceKind") ?? "").startsWith("webmcp")) return entry;
    const text = ownData(entry, field);
    if (typeof text !== "string" || !text.length) return entry;
    return Object.freeze({ ...entry, [field]: fenceUntrustedText(text, this.#untrustedToken(context)) });
  }

  async search(request = {}, context = {}) {
    const signal = ownData(context, "signal");
    if (isAborted(signal)) return fixedError("lazy-run-aborted");
    let snapshot;
    try {
      snapshot = await this.#snapshot();
    } catch {
      return fixedError("lazy-source-unavailable");
    }
    if (isAborted(signal)) return fixedError("lazy-run-aborted");
    const search = searchToolIndex(snapshot.index, ownData(request, "query"), {
      limit: ownData(request, "limit"),
      vectorTable: snapshot.vectorTable,
    });
    const issued = this.#selections.issue(
      search,
      sourceContext(context, snapshot.catalog.generation),
      snapshot.catalog,
      { ttlMs: ownData(request, "ttlMs") },
    );
    if (!issued?.ok || !Array.isArray(issued.results)) return issued;
    return Object.freeze({
      ...issued,
      results: Object.freeze(issued.results.map((entry) => this.#fenceWebMcpListing(entry, context, "summary"))),
    });
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

    // dptw: no per-category cap, no description clipping, no envelope byte
    // budget — the listing carries every descriptor, complete. `truncated`
    // stays in the shape (always false) for older consumers.
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

      const entry = this.#fenceWebMcpListing({
        name: String(desc.name ?? ""),
        description: String(desc.description ?? ""),
        capabilities: Array.isArray(desc.capabilities) ? desc.capabilities : [],
        availability: desc.availability ?? "ready",
        sourceKind: desc.sourceKind ?? "extension-builtin",
        schemaSummary: String(desc.schemaSummary ?? ""),
        outputSchemaSummary: String(desc.outputSchemaSummary ?? ""),
      }, context, "description");

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
      truncated: false,
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
    // A claim counts ONE use of a reusable ref (CAP-FB-20260901-RUN-BUDGET-
    // EVERY-ITEM-01). Any failure after the claim — an argument slip that
    // never reaches dispatch (CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01),
    // a stale fence, or a tool that ran and FAILED — hands that use back, so a
    // failed call never burns the ref and the model's retry on the SAME ref is
    // never `selection-replayed` (the owner's log: "No tab with id" → retry →
    // replayed → the run gave up).
    const released = (failure) => {
      this.#selections.release(firstResolved.claim);
      return failure;
    };
    const retryable = (failure) =>
      released(retryableArgumentFailure(failure, firstResolved.selectionRef));
    let args;
    try {
      args = sanitizeLazyToolArguments(ownData(request, "arguments"), firstResolved.descriptor);
    } catch (error) {
      return retryable(sanitizationFailure(error));
    }
    const firstRecord = first.byStableId.get(firstResolved.descriptor.stableId);
    const firstAuthority = await authorizeRecord(
      firstRecord,
      args,
      context,
      firstResolved.descriptor,
      "before-validation",
    );
    if (!firstAuthority.ok) return released(firstAuthority);
    const validated = await validateRecordArguments(firstRecord, args, firstResolved.descriptor);
    if (!validated.ok) return retryable(validated);
    if (isAborted(signal)) return released(fixedError("lazy-run-aborted"));

    // Validation is an async boundary. Rebuild and re-resolve every live
    // scope/source/package/capability/permission/grant fence before dispatch.
    let dispatchSnapshot;
    try {
      dispatchSnapshot = await liveSnapshot(this.#readSources);
    } catch {
      return released(fixedError("lazy-source-unavailable"));
    }
    const dispatchResolved = this.#revalidateAcrossGrant(
      firstResolved.claim,
      sourceContext(context, dispatchSnapshot.catalog.generation),
      dispatchSnapshot.catalog,
    );
    if (!dispatchResolved.ok) return released(dispatchResolved);
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
    if (!beforeDispatchAuthority.ok) return released(beforeDispatchAuthority);
    // Validate through the SAME live record whose closure will dispatch. A
    // same-label closure/validator ABA cannot borrow an earlier validation.
    const dispatchValidated = await validateRecordArguments(
      dispatchRecord,
      validated.data,
      dispatchResolved.descriptor,
    );
    if (!dispatchValidated.ok) return released(dispatchValidated);
    const dispatch = ownData(dispatchRecord, "dispatch");
    if (typeof dispatch !== "function") {
      return released(fixedError("lazy-dispatch-unavailable"));
    }
    if (isAborted(signal)) return released(fixedError("lazy-run-aborted"));

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
            // A genuine first-use owner Allow changes the exact consent
            // revision while this call is paused inside dispatch. The trusted
            // WebMCP closure may mark that transition so this one run can
            // revalidate by tool identity; live post-dispatch authorization
            // still checks the new revision/state before publishing output.
            authorizationTransition: () => {
              const window = this.#approvalWindow(ownData(context, "runId"));
              if (window) window.until = Date.now() + APPROVAL_GRACE_MS;
            },
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
    const ownerDispatch = splitOwnerSiteToolDispatch(rawResult, dispatchResolved.descriptor);
    rawResult = ownerDispatch.result;
    if (ownerDispatch.activity) {
      const emit = ownData(context, "onProgress");
      if (typeof emit === "function") {
        try {
          await emit(Object.freeze({
            type: "site-activity",
            toolName: "execute_tool",
            selectedTool: dispatchResolved.descriptor.name,
            siteActivity: ownerDispatch.activity,
          }));
        } catch { /* owner navigation metadata never changes tool semantics */ }
      }
    }
    if (isAborted(signal)) return released(fixedError("lazy-run-aborted"));

    // Discard both success and failure output if any live authority changed
    // during dispatch. A relay/provider-style completion is never authority.
    let after;
    try {
      after = await liveSnapshot(this.#readSources);
    } catch {
      return released(fixedError("lazy-source-unavailable"));
    }
    // An owner grant that landed while this call was in flight regenerated
    // the catalog (every chrome-api stableId hashes the grant digest); inside
    // the run's approval window that is the expected drift, and the call
    // revalidates by tool identity — then re-authorizes live against the NEW
    // descriptor's digests below, exactly as before
    // (CAP-FB-20260901-APPROVAL-RESUME-REEXECUTES-01).
    const afterResolved = this.#revalidateAcrossGrant(
      firstResolved.claim,
      sourceContext(context, after.catalog.generation),
      after.catalog,
    );
    if (!afterResolved.ok) return released(afterResolved);
    const afterRecord = after.byStableId.get(afterResolved.descriptor.stableId);
    if (!afterRecord) return released(fixedError("lazy-dispatch-source-stale"));
    const afterAuthority = await authorizeRecord(
      afterRecord,
      dispatchValidated.data,
      context,
      afterResolved.descriptor,
      "after-dispatch",
    );
    if (!afterAuthority.ok) return released(afterAuthority);
    if (dispatchError) {
      const toolName = afterResolved.descriptor.name;
      // Complete (secret-safe) failure text — a provider's own limit error
      // must reach the model verbatim, not clipped to 1024 bytes (dptw).
      const detail = safeProviderError(
        typeof dispatchError === "string"
          ? dispatchError
          : (typeof ownData(dispatchError, "message") === "string" && ownData(dispatchError, "message"))
            ? ownData(dispatchError, "message")
            : "lazy dispatcher failed",
      );
      // The failed call's use goes back to the ref: the SAME selectionRef is
      // valid for the next item, and the sentence says so (no bare token).
      return released(Object.freeze({
        ok: false,
        selectedTool: toolName,
        error: detail,
        selectionRef,
        message: `${toolName} failed: ${detail}. The same selectionRef is still valid — fix the arguments or move on to the next item and call execute_tool again; do not search again.`,
      }));
    }
    // A tool that reports its own failure ({error} / ok:false) ran but did no
    // work: give the use back the same way, so a loop that fails on most of
    // its items keeps one ref for all of them.
    if (
      rawResult && typeof rawResult === "object" && !Array.isArray(rawResult) &&
      (ownData(rawResult, "ok") === false || typeof ownData(rawResult, "error") === "string")
    ) {
      this.#selections.release(firstResolved.claim);
    }
    // The image bytes are lifted OUT of the model JSON here and remembered for
    // the provider toolset to re-attach as a real image content part
    // (CAP-FB-20260830-SCREENSHOT-TO-MODEL-01).
    const projected = projectResultWithAttachments(rawResult, {
      untrusted: isUntrustedResult(rawResult, afterResolved.descriptor),
      token: this.#untrustedToken(context),
    });
    this.#rememberAttachments(selectionRef, projected.attachments);
    // A structured permission denial pauses the run on an owner card; keep
    // what it takes to re-run THIS call once the owner approves.
    if (isPermissionPause(rawResult)) {
      this.#rememberPausedCall(selectionRef, afterResolved.descriptor, dispatchValidated.data, context, after.catalog.generation);
    }
    return Object.freeze({
      ok: true,
      selectedTool: afterResolved.descriptor.name,
      result: projected.result,
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

// Remote MCP server tools (mcp__<server>__<tool>), folded into the run's lazy
// catalog exactly like the built-in AI toolsets. Their `execute` closure (built
// by lib/mcp-run-tools.js) owns the per-server owner-approval card, the ledger
// write, and the untrusted fence-tag — this only supplies validation, the
// run-ownership gate, and the dispatch closure (MCP-TOOL-INJECTION-01).
export function executableMcpToolRecords(toolMap, context) {
  return executableAiRecords(toolMap, adaptMcpTools, context);
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
        let normalizedInputRef = null;
        if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
          const keys = Object.keys(rawArgs);
          const allowed = new Set([
            "toolId", "args", "stdin", "input", "text", "docA", "docB",
            ...(isStreamBackedBundledTool(toolId) ? ["inputRef"] : []),
          ]);
          if ((Object.hasOwn(rawArgs, "toolId") && rawArgs.toolId !== toolId) ||
              keys.some((key) => !allowed.has(key)) ||
              (Object.hasOwn(rawArgs, "args") &&
                (!Array.isArray(rawArgs.args) || rawArgs.args.some((arg) => typeof arg !== "string")))) {
            return { ok: false, error: "invalid_arguments: shape" };
          }
          if (Array.isArray(rawArgs.args)) normalizedArgs = [...rawArgs.args];
          const textKeys = ["stdin", "input", "text"].filter((key) => Object.hasOwn(rawArgs, key));
          const hasDocs = Object.hasOwn(rawArgs, "docA") || Object.hasOwn(rawArgs, "docB");
          if (textKeys.length > 1 || (hasDocs && textKeys.length) ||
              (hasDocs && Object.hasOwn(rawArgs, "args")) ||
              (hasDocs && !(typeof rawArgs.docA === "string" && typeof rawArgs.docB === "string")) ||
              (textKeys.length && typeof rawArgs[textKeys[0]] !== "string") ||
              (Object.hasOwn(rawArgs, "inputRef") && (textKeys.length || hasDocs))) {
            return { ok: false, error: "invalid_arguments: ambiguous input" };
          }
          if (textKeys.length) normalizedStdin = rawArgs[textKeys[0]];
          else if (hasDocs) normalizedArgs = [rawArgs.docA, rawArgs.docB];
          if (Object.hasOwn(rawArgs, "inputRef")) {
            const ref = rawArgs.inputRef;
            if (!ref || typeof ref !== "object" || Array.isArray(ref) ||
                JSON.stringify(Object.keys(ref).sort()) !== JSON.stringify(["id", "kind", "version"]) ||
                ref.version !== 1 || !/^[0-9a-f]{32}$/u.test(ref.id) ||
                !new Set(["input", "stdout"]).has(ref.kind)) {
              return { ok: false, error: "invalid_arguments: inputRef" };
            }
            normalizedInputRef = Object.freeze({ version: 1, id: ref.id, kind: ref.kind });
          }
        } else if (typeof rawArgs === "string") {
          normalizedStdin = rawArgs;
        } else if (Array.isArray(rawArgs)) {
          if (rawArgs.some((arg) => typeof arg !== "string")) {
            return { ok: false, error: "invalid_arguments: args" };
          }
          normalizedArgs = [...rawArgs];
        } else if (rawArgs != null) {
          return { ok: false, error: "invalid_arguments: shape" };
        }

        const validated = validatePreviewInput({
          toolId,
          args: normalizedArgs,
          stdin: normalizedStdin,
        });
        return {
          ok: true,
          data: normalizedInputRef
            ? Object.freeze({ toolId: validated.toolId, args: validated.args, inputRef: normalizedInputRef })
            : validated,
        };
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

/**
 * @param {{
 *   readSources?: any,
 *   contextReader?: any,
 *   selectionAuthority?: any,
 *   acceptsImageToolResults?: boolean | (() => boolean),
 *   vectorTableLoader?: null | (() => Promise<any>),
 *   onPermissionRequest?: null | ((denial: any) => Promise<string> | string),
 * }} [options]
 */
export function createLazyProviderToolset({
  readSources,
  contextReader,
  selectionAuthority,
  // Does THIS run's transport carry a real image part in a tool result? Only a
  // lane that does gets one; the OpenAI-compatible chat transport, for one,
  // JSON-stringifies a `content` output, which would put the base64 straight
  // back into the text this change exists to keep it out of
  // (CAP-FB-20260830-SCREENSHOT-TO-MODEL-01). Read per call — a per-agent
  // provider override can change the answer mid-session.
  acceptsImageToolResults = false,
  vectorTableLoader = null,
  // The run's owner-approval seam (agent.js's onPermissionRequest). A
  // run_pipeline STEP whose dispatch pauses on a capability surfaces the real
  // owner card through it; Allow re-runs the step through the runtime-only
  // resume path (chrome-agent-platform-3cb6). Absent here, a pause fails the
  // step closed exactly as a direct call's pause would with no approval
  // surface.
  onPermissionRequest = null,
} = {}) {
  const protocol = new LazyToolProtocol({ readSources, selectionAuthority, vectorTableLoader });
  if (typeof contextReader !== "function") {
    throw new TypeError("lazy provider needs a run context reader");
  }
  const imageToolResultsAllowed = () => {
    try {
      return typeof acceptsImageToolResults === "function"
        ? acceptsImageToolResults() === true
        : acceptsImageToolResults === true;
    } catch {
      return false;
    }
  };
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
        query: z.string(),
        limit: z.number().int().min(1).optional(),
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
      // THE IMAGE PATH. A tool that captured pixels (capture_screenshot) put
      // its PNG in the protocol's side channel, not in the JSON above. Here it
      // becomes a real image content part beside the (image-free) envelope
      // text, so a vision model actually SEES the page instead of reading a
      // truncated base64 fragment (CAP-FB-20260830-SCREENSHOT-TO-MODEL-01).
      toModelOutput: ({ output }) => {
        const parts = imageToolResultsAllowed()
          ? protocol.attachmentsFor(ownData(output, "selectionRef"))
          : EMPTY_ATTACHMENTS;
        // Copy enumerable string data only. Owner-only site provenance was
        // emitted separately on the local progress channel and never entered
        // this provider/model value.
        const modelOutput = output && typeof output === "object" && !Array.isArray(output)
          ? Object.fromEntries(Object.keys(output).map((key) => [key, ownData(output, key)]))
          : (output ?? null);
        if (!parts.length) return { type: "json", value: modelOutput };
        return {
          type: "content",
          value: [
            { type: "text", text: JSON.stringify(modelOutput) },
            ...parts.map((part) => ({
              type: "file",
              mediaType: part.mediaType,
              data: { type: "data", data: part.data },
            })),
          ],
        };
      },
    }),
    // run_pipeline (chrome-agent-platform-qsm4, slice 2): the declarative
    // pipeline core (lib/tool-pipeline.js) wired LIVE. Each step dispatches
    // through THIS protocol's public search → execute seam — the exact-name
    // catalog entry's selectionRef, the ordinary validation/authority/
    // fencing/ledger path — via the same dispatcher adapter the workflow
    // runner uses (lib/workflows.js createWorkflowPipelineDispatcher), so a
    // step's owner-approval pause surfaces the run's real card (the 3cb6
    // machinery: requestApproval → resumeApprovedCall) and a deny/failure
    // halts the pipeline fail-closed. Per-step progress rides the run
    // context's onProgress for the plan strip.
    run_pipeline: tool({
      description: LAZY_PROTOCOL_TOOL_WIRE[3].description,
      inputSchema: z.object({
        name: z.string().max(80).optional(),
        steps: z.array(z.object({
          id: z.string(),
          tool: z.string(),
          args: z.record(z.unknown()).optional(),
        }).strict()).min(1),
      }).strict(),
      outputSchema: jsonSchema(LAZY_PROTOCOL_TOOL_WIRE[3].outputSchema),
      execute: async (request) => {
        const context = await readContext();
        if (!context) return fixedError("lazy-run-context-unavailable");
        const dispatchStep = createWorkflowPipelineDispatcher({
          search: (req, ctx) => protocol.search(req, ctx),
          execute: (req, ctx) => protocol.execute(req, ctx),
          settle: (ref) => protocol.settlePausedCall(ref),
          requestApproval: typeof onPermissionRequest === "function" ? onPermissionRequest : null,
          // The paused record lives under THIS run's fence. Re-read the LIVE
          // context per resume (parity with the agent-loop wrapper): an earlier
          // step may have moved the run's documentId/origin, and the fence
          // check must see the scope as it stands at resume time.
          resume: async (ref) => protocol.resumeApprovedCall(ref, await readContext()),
          // Each step re-reads the LIVE context (a long pipeline tracks the
          // run's current scope exactly as a model-issued call would).
          context: readContext,
        });
        const emit = ownData(context, "onProgress");
        const pipelineName = typeof ownData(request, "name") === "string" ? ownData(request, "name") : "";
        // runPipeline awaits each step before dispatching the next, so the
        // counter IS the current step's index.
        let stepIndex = 0;
        return await runPipeline(
          { name: pipelineName, steps: ownData(request, "steps") },
          {
            dispatchTool: (name, args) => dispatchStep(name, args, stepIndex++),
            onStep: typeof emit === "function"
              ? (evt) => {
                try {
                  emit({
                    type: "pipeline-step",
                    status: evt.status === "running" ? "running" : evt.status === "ok" ? "ok" : "failed",
                    tool: evt.tool,
                    id: evt.id,
                    index: evt.index,
                    pipeline: pipelineName,
                  });
                } catch { /* progress is telemetry — never break the run */ }
              }
              : undefined,
          },
        );
      },
    }),
  });
  return Object.freeze({
    tools,
    protocol,
    // RUNTIME handles (CAP-FB-20260901-APPROVAL-RESUME-REEXECUTES-01) — NOT in
    // `tools`, so no model can call them: the agent loop re-runs a paused
    // call after the owner's Allow, or forgets it after a deny/expiry.
    resumeApprovedCall: async (selectionRef) => {
      const context = await readContext();
      return context
        ? await protocol.resumeApprovedCall(selectionRef, context)
        : fixedError("lazy-run-context-unavailable");
    },
    settlePausedCall: (selectionRef) => protocol.settlePausedCall(selectionRef),
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
        const detail = redactSecretText(validationIssueDetail(args, parsed.error?.issues));
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
            runId: ownData(dispatchContext, "runId"),
            taskId: ownData(dispatchContext, "taskId"),
            agentId: ownData(dispatchContext, "agentId"),
            replayMetadata: ownData(dispatchContext, "replayMetadata"),
            authorizationTransition: ownData(dispatchContext, "authorizationTransition"),
          }))
        : null,
    });
  });
}
