// lib/owner-approval.js — bounded, owner-bound approval capabilities.
//
// Security boundary:
// - arbitrary JavaScript objects are NEVER introspected for an approval digest;
//   handlers must build a branded canonical payload from explicit primitives;
// - approval tuples bind the immutable execution, normalized action/target and
//   complete canonical payload digest;
// - pending requests are deduplicated and bounded without evicting an owner's
//   approved-but-not-yet-consumed decision;
// - identifiers/targets never cross into model results. Approval ids are sent
//   only to the exact Settings page and held in click-handler closures.

import { canonicalOrigin } from "./memory.js";

export const MAX_PENDING_APPROVALS = 64;
export const APPROVAL_TTL_MS = 60_000;
// Large enough to bind the existing 256 KiB artifact content limit plus
// framing, while still rejecting before unbounded encode/hash work.
const MAX_NODE_BYTES = 320 * 1024;
const MAX_ITEMS = 128;
const MAX_FIELDS = 64;

export const DESTRUCTIVE_ACTIONS = new Set([
  "agent.delete",
  "agent.update",
  "asset.delete",
  // A model-initiated restore of an earlier version rewrites the head
  // (CAP-FB-20260830-ARTIFACT-VERSIONS-01): the same card as an update.
  "asset.restore",
  "asset.update",
  "capability.revoke",
  "hooks.subscribe",
  "hooks.unsubscribe",
  "named-agent.create",
  "named-agent.delete",
  "named-agent.set-provider",
  "named-agent.set-schedule",
  "named-agent.update",
  "script.delete",
  "script.update",
  // A MODEL-created / -run / -scheduled script (CAP-FB-20260830-RUN-SCRIPT-
  // FETCH-APPROVAL-01): the script's controlled fetch is an exfiltration +
  // SSRF channel, so the owner approves the exact source (digest-bound) and
  // sees the hosts it fetches before it runs. The owner's own hub/Settings
  // action on the same routes is owner-direct (below).
  "script.create",
  "script.run",
  "task.schedule-script",
  // Per-agent schedule controls are approvable mutations: a MODEL-initiated
  // pause/resume/update creates a pending approval (the in-context card flow,
  // per-agent alarms P1-3). Without membership here createPendingApproval
  // refuses and no approval could ever be requested.
  "task.pause",
  "task.resume",
  "task.update",
  // Reading a cookie VALUE (CAP-FB-20260830-COOKIE-TOOLS-CUT-01). A cookie
  // value is a bearer credential and a tool result is sent verbatim to the
  // model provider, so the owner approves the exact origin + cookie name
  // before the value is read at all.
  "browser.cookie-value",
]);

export class CanonicalPayloadError extends Error {
  constructor(message = "invalid canonical approval payload") {
    super(message);
    this.name = "CanonicalPayloadError";
  }
}

// Owner-DIRECT actions (CAP-FB-20260823-ARTIFACT-DELETE-PERMISSION-01): for
// these actions, a browser-attested owner UI document's own in-page action IS
// the approval — the owner's click is the authority, so the operation must
// never demand a pre-granted Settings decision (the hidden-dependency bug).
// Agent-initiated calls (principal "model") and every other destructive action
// keep the full approval flow. A page/content-script principal can never
// satisfy this predicate: the router denies asset routes to page senders before
// any handler runs, and the predicate only matches extension-document
// principals with a non-empty browser-supplied documentId.
export const OWNER_DIRECT_ACTIONS = new Set([
  "asset.delete",
  // The owner's own Restore click in the viewer IS the approval.
  "asset.restore",
  "agent.delete",
  "named-agent.delete",
  // The owner's own schedule edit in the agent dialog IS the approval (same
  // owner-direct principle as task.pause/resume/update below).
  "named-agent.set-schedule",
  "recipe.delete",
  // Per-agent schedule controls (pause/resume/update): the owner's own click in
  // an extension UI document IS the approval — the same owner-direct principle
  // as asset.delete. A MODEL calling the same actions keeps the full
  // pending-approval flow (the in-context approval card + exact-retry).
  "task.pause",
  "task.resume",
  "task.update",
  // The owner writing or running a script from the hub/Settings IS the
  // approval; only a model-initiated create/run pays the card.
  "script.create",
  "script.run",
]);

export function isOwnerDirectApproval(context, action) {
  if (!OWNER_DIRECT_ACTIONS.has(action)) return false;
  const principal = context?.principal;
  if (principal !== "extension" && principal !== "owner-options") return false;
  return typeof context.documentId === "string" && context.documentId.length > 0;
}

const nodeEncoding = new WeakMap();
const fieldEncoding = new WeakMap();
const encoder = new TextEncoder();
// Intrinsic binary-view getters bypass hostile own accessors / @@toStringTag.
// Reflect.apply performs an internal-slot check and never reads a property from
// the supplied view.
const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedBuffer = Object.getOwnPropertyDescriptor(TypedArrayPrototype, "buffer").get;
const typedByteOffset = Object.getOwnPropertyDescriptor(TypedArrayPrototype, "byteOffset").get;
const typedByteLength = Object.getOwnPropertyDescriptor(TypedArrayPrototype, "byteLength").get;
const typedTag = Object.getOwnPropertyDescriptor(TypedArrayPrototype, Symbol.toStringTag).get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer").get;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset").get;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength").get;

function boundedString(value, label) {
  if (typeof value !== "string") throw new CanonicalPayloadError(`${label} must be a string`);
  if (value.length > MAX_NODE_BYTES) throw new CanonicalPayloadError(`${label} is too large`);
  const bytes = encoder.encode(value);
  if (bytes.byteLength > MAX_NODE_BYTES) throw new CanonicalPayloadError(`${label} is too large`);
  return { value, bytes };
}

function pack(tag, parts = []) {
  let total = encoder.encode(tag).byteLength + 2;
  for (const part of parts) total += encoder.encode(part).byteLength + 12;
  if (total > MAX_NODE_BYTES) throw new CanonicalPayloadError("canonical payload is too large");
  const encoded = `${tag}${parts.map((part) => `${encoder.encode(part).byteLength}:${part}`).join("")}`;
  if (encoder.encode(encoded).byteLength > MAX_NODE_BYTES) throw new CanonicalPayloadError("canonical payload is too large");
  const node = Object.freeze(Object.create(null));
  nodeEncoding.set(node, encoded);
  return node;
}

function nodeText(node) {
  const value = (node && (typeof node === "object" || typeof node === "function"))
    ? nodeEncoding.get(node)
    : undefined;
  if (typeof value !== "string") {
    // WeakMap identity is deliberately the only brand check. A Proxy around a
    // node has a different identity and is rejected without invoking any trap.
    throw new CanonicalPayloadError();
  }
  return value;
}

export function canonicalScalar(value) {
  if (value === null) return pack("null;");
  switch (typeof value) {
    case "undefined": return pack("undefined;");
    case "boolean": return pack(value ? "boolean:true;" : "boolean:false;");
    case "string": {
      const { value: text } = boundedString(value, "string");
      return pack("string;", [text]);
    }
    case "number": {
      if (Number.isNaN(value)) return pack("number:nan;");
      if (value === Infinity) return pack("number:+infinity;");
      if (value === -Infinity) return pack("number:-infinity;");
      if (Object.is(value, -0)) return pack("number:-0;");
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, value, false);
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      return pack("number:ieee754;", [hex]);
    }
    case "bigint": return pack("bigint;", [value.toString(10)]);
    default:
      throw new CanonicalPayloadError(`unsupported scalar type: ${typeof value}`);
  }
}

export function canonicalBinary(view) {
  // ArrayBuffer.isView does not execute Proxy traps. Proxied views return false
  // and fail closed. Intrinsic getters below bypass hostile own accessors.
  if (!ArrayBuffer.isView(view)) throw new CanonicalPayloadError("binary value must be an ArrayBuffer view");
  let buffer;
  let byteOffset;
  let byteLength;
  let type;
  try {
    // DataView's intrinsic getter succeeds only for a genuine DataView.
    byteLength = Reflect.apply(dataViewByteLength, view, []);
    byteOffset = Reflect.apply(dataViewByteOffset, view, []);
    buffer = Reflect.apply(dataViewBuffer, view, []);
    type = "DataView";
  } catch {
    byteLength = Reflect.apply(typedByteLength, view, []);
    byteOffset = Reflect.apply(typedByteOffset, view, []);
    buffer = Reflect.apply(typedBuffer, view, []);
    type = Reflect.apply(typedTag, view, []);
  }
  if (!Number.isSafeInteger(byteLength) || !Number.isSafeInteger(byteOffset) ||
      typeof type !== "string" || !type || byteLength > 128 * 1024) {
    throw new CanonicalPayloadError("binary value is invalid or too large");
  }
  const bytes = new Uint8Array(buffer, byteOffset, byteLength);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return pack("binary;", [type, String(byteOffset), String(byteLength), hex]);
}

export function canonicalArray(...nodes) {
  if (nodes.length > MAX_ITEMS) throw new CanonicalPayloadError("canonical array has too many items");
  return pack("array;", nodes.map(nodeText));
}

export function canonicalField(name, node) {
  const normalized = boundedString(name, "field name").value.normalize("NFKC");
  if (!normalized || normalized.length > 128) throw new CanonicalPayloadError("invalid field name");
  const field = Object.freeze(Object.create(null));
  fieldEncoding.set(field, { name: normalized, value: nodeText(node) });
  return field;
}

export function canonicalRecord(...fields) {
  if (fields.length > MAX_FIELDS) throw new CanonicalPayloadError("canonical record has too many fields");
  const rows = [];
  for (const field of fields) {
    const row = (field && typeof field === "object") ? fieldEncoding.get(field) : undefined;
    if (!row) throw new CanonicalPayloadError("invalid canonical field");
    rows.push(row);
  }
  rows.sort((a, b) => a.name < b.name ? -1 : (a.name > b.name ? 1 : 0));
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].name === rows[i].name) throw new CanonicalPayloadError("duplicate canonical field");
  }
  return pack("record;", rows.flatMap((row) => [row.name, row.value]));
}

export async function payloadDigest(payloadNode) {
  const encoded = nodeText(payloadNode); // rejects raw objects without observation
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(encoded));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function lengthPart(value) {
  if (typeof value !== "string" || !value || value.length > 4096) return "";
  const bytes = encoder.encode(value);
  if (!bytes.byteLength || bytes.byteLength > 8192) return "";
  return `${bytes.byteLength}:${value}`;
}

function normalizedOrigin(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "master") return "master";
  return canonicalOrigin(raw) || "";
}

function normalizedSlug(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/** Canonical targets encode the identity the mutation actually uses. */
export function canonicalOperationTarget(kind, parts = Object.create(null)) {
  if (!parts || typeof parts !== "object") return "";
  let values;
  switch (kind) {
    case "asset":
    case "script": {
      const origin = normalizedOrigin(parts.origin);
      // Asset/script stores address the raw string id verbatim; whitespace is
      // therefore identity, not presentation, and must not be trimmed.
      const id = typeof parts.id === "string" ? parts.id : "";
      values = [origin, id];
      break;
    }
    case "origin":
      values = [normalizedOrigin(parts.origin)];
      break;
    case "cookie": {
      // A cookie's identity is its origin + its name; the name is taken
      // verbatim (bounded), never slug-normalized — two differently-cased
      // cookie names are two different cookies and must not share an approval.
      const cookieName = typeof parts.name === "string" ? parts.name.trim() : "";
      values = [normalizedOrigin(parts.origin), cookieName.slice(0, 512)];
      break;
    }
    case "named":
    case "provider":
      values = [normalizedSlug(parts.id)];
      break;
    case "scheduled": {
      // A scheduled-task name is already a system-generated id (task_<ts>_<rand>,
      // recipe:<id>, or an explicit owner name) — taken verbatim, length-bounded;
      // slug-normalizing it would be lossy (two names could collapse to one
      // target and share an approval row).
      const id = typeof parts.id === "string" ? parts.id.trim() : "";
      values = [id.slice(0, 200)];
      break;
    }
    case "capability":
      values = [typeof parts.id === "string" && /^[a-z][a-zA-Z0-9-]{0,63}$/.test(parts.id) ? parts.id : ""];
      break;
    case "hook": {
      const hookId = typeof parts.hookId === "string" ? parts.hookId.trim() : "";
      const recipeId = parts.recipeId == null ? "" : (typeof parts.recipeId === "string" ? parts.recipeId.trim() : "");
      values = [hookId, recipeId];
      break;
    }
    default:
      return "";
  }
  const encoded = values.map(lengthPart);
  if (encoded.some((value) => !value)) {
    // hook's null recipe is an intentional empty identity and gets a distinct
    // explicit marker; all other empty effective identities are invalid.
    if (kind === "hook" && encoded[0] && values[1] === "") encoded[1] = "0:";
    else return "";
  }
  return `${kind}:${encoded.join("")}`;
}

export async function opaqueTargetRefWithKey(target, rawKey) {
  if (typeof target !== "string" || !target || !(rawKey instanceof Uint8Array) || rawKey.byteLength !== 32) return "";
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const domain = `owner-approval-target-ref:v1\0${target}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(domain));
  return [...new Uint8Array(signature).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let installKeyPromise = null;
async function readInstallKey() {
  const root = await navigator.storage.getDirectory();
  const privateDir = await root.getDirectoryHandle("chrome-agent-platform-private", { create: true });
  let fileHandle;
  try {
    fileHandle = await privateDir.getFileHandle("owner-approval-hmac-v1", { create: false });
  } catch (error) {
    if (error?.name !== "NotFoundError" && error?.name !== "NotFound") throw error;
    fileHandle = await privateDir.getFileHandle("owner-approval-hmac-v1", { create: true });
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const writable = await fileHandle.createWritable();
    try { await writable.write(hex); await writable.close(); }
    catch (writeError) { try { await writable.abort?.(); } catch { /* best effort */ } throw writeError; }
    return bytes;
  }
  const text = await (await fileHandle.getFile()).text();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error("owner approval key is corrupt");
  return new Uint8Array(text.match(/../g).map((pair) => Number.parseInt(pair, 16)));
}

/** Stable for this extension installation; failure is fail-closed, never ephemeral. */
export async function opaqueTargetRef(target) {
  if (!installKeyPromise) installKeyPromise = readInstallKey().catch((error) => {
    installKeyPromise = null;
    throw error;
  });
  return await opaqueTargetRefWithKey(target, await installKeyPromise);
}

/** Build-local model dispatcher: the execution id is captured once forever. */
export function bindModelApprovalDispatcher(executionId, dispatch, onApprovalEvent = null) {
  if (typeof dispatch !== "function") throw new TypeError("dispatch function required");
  const captured = typeof executionId === "string" ? executionId : "";
  const context = Object.freeze({
    principal: "model",
    executionId: captured,
    onApprovalEvent: typeof onApprovalEvent === "function" ? onApprovalEvent : null,
  });
  return (type, args) => dispatch(type, args, context);
}

export function createApprovalStore() {
  // `details` holds the PRIVATE, extension-principal-only edit detail for a
  // pending approval (the diff bodies the owner reads on the card). Keyed by
  // approvalId, it lives exactly as long as its approval row — removeApproval /
  // sweep / consumeApproved evict it — and never reaches the model
  // (EDIT-APPROVAL-SHOWS-DIFF-01).
  return { approvals: new Map(), byTuple: new Map(), waiters: new Map(), details: new Map() };
}

function approvalKey(runId, action, target, digest) {
  return `${lengthPart(runId)}${lengthPart(action)}${lengthPart(target)}${lengthPart(digest)}`;
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `ap_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function settleWaiters(store, approvalId, result) {
  const waiters = store?.waiters?.get(approvalId);
  if (!waiters) return;
  store.waiters.delete(approvalId);
  for (const settle of waiters) settle(result);
}

function removeApproval(store, approvalId, entry) {
  store.approvals.delete(approvalId);
  store.byTuple.delete(entry.key);
  store.details?.delete(approvalId);
}

function sweep(store, now = Date.now()) {
  for (const [id, entry] of store.approvals) {
    if (entry.expiresAt > now) continue;
    removeApproval(store, id, entry);
    settleWaiters(store, id, { ok: false, decision: "expired", error: "approval expired before a decision" });
  }
}

export function createPendingApproval(store, runId, action, target, digest, ttlMs = APPROVAL_TTL_MS) {
  if (!store?.approvals || !DESTRUCTIVE_ACTIONS.has(action)) return { ok: false, error: "operation is not approvable" };
  if (
    typeof runId !== "string" || !runId || runId.length > 160 ||
    typeof target !== "string" || !target || target.length > 2048 ||
    typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)
  ) {
    return { ok: false, error: "invalid approval tuple" };
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > APPROVAL_TTL_MS) return { ok: false, error: "invalid approval lifetime" };
  sweep(store);
  const key = approvalKey(runId, action, target, digest);
  const existingId = store.byTuple.get(key);
  if (existingId) {
    const existing = store.approvals.get(existingId);
    if (existing) return { ok: true, approvalId: existingId, deduped: true, status: existing.status };
    store.byTuple.delete(key);
  }
  if (store.approvals.size >= MAX_PENDING_APPROVALS) return { ok: false, error: "approval queue is full" };
  const approvalId = randomId();
  store.approvals.set(approvalId, {
    key,
    runId,
    action,
    target,
    digest,
    status: "pending",
    at: Date.now(),
    expiresAt: Date.now() + ttlMs,
  });
  store.byTuple.set(key, approvalId);
  return { ok: true, approvalId, deduped: false, status: "pending" };
}

export function resolvePendingApproval(store, approvalId, approve) {
  if (!store?.approvals || typeof approvalId !== "string") return { ok: false, error: "invalid approval" };
  sweep(store);
  const entry = store.approvals.get(approvalId);
  if (!entry || entry.status !== "pending") return { ok: false, error: "no such pending approval" };
  if (approve !== true) {
    removeApproval(store, approvalId, entry);
    const result = { ok: true, decision: "denied" };
    settleWaiters(store, approvalId, result);
    return result;
  }
  entry.status = "approved";
  const result = { ok: true, decision: "approved" };
  settleWaiters(store, approvalId, result);
  return result;
}

/** Keep the originating tool invocation pending until its exact approval is
 * resolved. The approval's own expiry is the timeout authority; timeout removes
 * the tuple and fails closed, so a late click can never authorize stale work. */
export function waitForApprovalDecision(store, approvalId) {
  if (!store?.approvals || !store?.waiters || typeof approvalId !== "string") {
    return Promise.resolve({ ok: false, decision: "invalid", error: "invalid approval" });
  }
  sweep(store);
  const entry = store.approvals.get(approvalId);
  if (!entry) return Promise.resolve({ ok: false, decision: "expired", error: "approval expired before a decision" });
  if (entry.status === "approved") return Promise.resolve({ ok: true, decision: "approved" });
  if (entry.status !== "pending") return Promise.resolve({ ok: false, decision: "invalid", error: "approval is not pending" });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const waiters = store.waiters.get(approvalId) ?? new Set();
    waiters.add(finish);
    store.waiters.set(approvalId, waiters);
    const timer = setTimeout(() => {
      const current = store.approvals.get(approvalId);
      if (current?.status === "pending") removeApproval(store, approvalId, current);
      settleWaiters(store, approvalId, { ok: false, decision: "expired", error: "approval expired before a decision" });
    }, Math.max(0, entry.expiresAt - Date.now()));
  });
}

export function consumeApproved(store, runId, action, target, digest) {
  if (!store?.approvals) return { ok: false };
  sweep(store);
  const key = approvalKey(runId, action, target, digest);
  const id = store.byTuple.get(key);
  const entry = id ? store.approvals.get(id) : null;
  if (id && entry?.status === "approved") {
    store.approvals.delete(id);
    store.byTuple.delete(key);
    store.details?.delete(id);
    return { ok: true };
  }
  return { ok: false };
}

/** ONE-SHOT approval bridge (per-agent alarms P1-A): the owner approved a
 * pending tuple for execution A, but the automatic retry starts a FRESH
 * execution B whose executionId can never consume A's tuple by exact key —
 * the agent would re-request approval forever. The TRUSTED surface (the same
 * extension page whose owner click resolved the approval) passes the resolved
 * approvalId with the retry's run start; the service worker re-keys the
 * approved-but-unconsumed tuple onto the new execution EXACTLY ONCE.
 * Guards: the entry must exist, be `approved` (never pending/denied/consumed),
 * be un-bridged (bridgedFrom absent — no chains), and the target run must be
 * a bounded distinct id. TTL still applies (sweep). A failed bridge degrades
 * to a fresh approval request — it never fails the run. */
export function bridgeApprovedApprovalToRun(store, approvalId, toRunId) {
  if (!store?.approvals) return { ok: false, error: "invalid approval store" };
  sweep(store);
  if (typeof approvalId !== "string" || !approvalId || approvalId.length > 160) {
    return { ok: false, error: "invalid approval id" };
  }
  if (typeof toRunId !== "string" || !toRunId || toRunId.length > 160) {
    return { ok: false, error: "invalid target run" };
  }
  const entry = store.approvals.get(approvalId);
  if (!entry) return { ok: false, error: "no such approval" };
  if (entry.status !== "approved") return { ok: false, error: "approval is not approved" };
  if (entry.bridgedFrom) return { ok: false, error: "approval was already bridged" };
  if (entry.runId === toRunId) {
    return { ok: true, bridged: false, action: entry.action, targetRef: entry.targetRef ?? "" };
  }
  store.byTuple.delete(entry.key);
  entry.bridgedFrom = entry.runId;
  entry.runId = toRunId;
  entry.key = approvalKey(toRunId, entry.action, entry.target, entry.digest);
  store.byTuple.set(entry.key, approvalId);
  return { ok: true, bridged: true, action: entry.action, targetRef: entry.targetRef ?? "" };
}

export function listPendingApprovals(store) {
  if (!store?.approvals) return [];
  sweep(store);
  return [...store.approvals.entries()]
    .filter(([, entry]) => entry.status === "pending")
    .sort((a, b) => a[1].at - b[1].at)
    .map(([approvalId, entry]) => ({ approvalId, action: entry.action, target: entry.target, at: entry.at }));
}

export function approvalPendingCount(store) {
  return listPendingApprovals(store).length;
}

/** The STRUCTURED in-context denial for a just-created pending approval
 * (per-agent alarms P1-3): the conversation renders `permissionRequirement`
 * as an approval card; the owner's Allow resolves `approvalId` through the
 * resolve-approval authority and the EXACT retry consumes it by digest match.
 * The requirement is a bounded DESCRIPTION (action + opaque target ref) — it
 * grants nothing by itself. Returns null for an unusable tuple (fail closed). */
// The actions whose card discloses the exact script source + the hosts it
// fetches. The owner cannot approve code they have not seen, so for these
// (and only these) the card carries the bounded source and host list.
export const SOURCE_DISCLOSING_ACTIONS = new Set(["script.create", "script.run", "task.schedule-script"]);
export const APPROVAL_DETAIL_BOUNDS = Object.freeze({ maxSourceChars: 64 * 1024, maxHosts: 64, maxHostChars: 253 });

/** Bound a script-approval detail ({ source, hosts, dynamic }) for the card;
 * a malformed detail is dropped (the card still renders without it). */
export function boundApprovalDetail(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  const source = typeof detail.source === "string" ? detail.source.slice(0, APPROVAL_DETAIL_BOUNDS.maxSourceChars) : "";
  const hosts = Array.isArray(detail.hosts)
    ? detail.hosts.filter((h) => typeof h === "string" && h.length > 0 && h.length <= APPROVAL_DETAIL_BOUNDS.maxHostChars).slice(0, APPROVAL_DETAIL_BOUNDS.maxHosts)
    : [];
  return { source, hosts, dynamic: detail.dynamic === true };
}

export function approvalCardDenial({ approvalId, action, targetRef, detail }) {
  if (typeof approvalId !== "string" || !approvalId || approvalId.length > 160) return null;
  if (typeof action !== "string" || !DESTRUCTIVE_ACTIONS.has(action)) return null;
  const ref = String(targetRef ?? "").slice(0, 200);
  const bounded = SOURCE_DISCLOSING_ACTIONS.has(action) ? boundApprovalDetail(detail) : undefined;
  return {
    ok: false,
    waitingForPermission: true,
    permissionRequirement: {
      reason: `${action}: ${ref}`,
      approvals: [{ approvalId, action, targetRef: ref, ...(bounded ? { detail: bounded } : {}) }],
    },
  };
}

// ── staged edit detail for the approval card (EDIT-APPROVAL-SHOWS-DIFF-01) ──
// When the model calls asset.update / script.update, the owner is asked to
// approve an EDIT. The card must show the diff between the current stored body
// and the proposed new body — not an opaque digest. The two bodies are the
// PRIVATE record of the extension principal (the owner surface renders them);
// they never enter the model-facing envelope (approvalCardDenial), because the
// current body is not necessarily model-authored. The record is staged in the
// approval store keyed by approvalId and evicted with the approval row.
export const STAGED_APPROVAL_DETAIL_KINDS = new Set(["asset.update", "script.update"]);
export const STAGED_APPROVAL_DETAIL_BOUNDS = Object.freeze({
  maxContentChars: 1024 * 1024,
  maxNameChars: 256,
  maxLabelChars: 256,
});

/** Bound a staged edit detail ({ kind, name, oldContent, newContent, added,
 * removed, oldLabel, newLabel }). A malformed record (unknown kind, no name)
 * is dropped — the card then falls back to the opaque form. The `added` /
 * `removed` counts are computed by the caller with the diff core over the SAME
 * two bodies stored here, so the card title's `+n -m` can never disagree with
 * the rendered diff. */
export function boundStagedApprovalDetail(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  if (!STAGED_APPROVAL_DETAIL_KINDS.has(detail.kind)) return null;
  const str = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  const name = str(detail.name, STAGED_APPROVAL_DETAIL_BOUNDS.maxNameChars);
  if (!name) return null;
  return {
    kind: detail.kind,
    name,
    oldContent: str(detail.oldContent, STAGED_APPROVAL_DETAIL_BOUNDS.maxContentChars),
    newContent: str(detail.newContent, STAGED_APPROVAL_DETAIL_BOUNDS.maxContentChars),
    added: count(detail.added),
    removed: count(detail.removed),
    oldLabel: str(detail.oldLabel, STAGED_APPROVAL_DETAIL_BOUNDS.maxLabelChars) || `${name} (current)`,
    newLabel: str(detail.newLabel, STAGED_APPROVAL_DETAIL_BOUNDS.maxLabelChars) || `${name} (proposed)`,
  };
}

/** Stage the private edit detail for a still-pending approval. Fails closed if
 * no such pending row exists (no orphan staging) or the detail is malformed. */
export function stageApprovalDetail(store, approvalId, detail) {
  if (!store?.details || typeof approvalId !== "string" || !store.approvals?.has(approvalId)) {
    return { ok: false, error: "no pending approval to stage detail for" };
  }
  const bounded = boundStagedApprovalDetail(detail);
  if (!bounded) return { ok: false, error: "invalid staged detail" };
  store.details.set(approvalId, bounded);
  return { ok: true };
}

/** Read the staged detail for an approval (the owner surface only — the caller
 * enforces `mayReadApprovalDetail` on the sender). Sweeps first, so an expired
 * approval's detail is already gone (fail closed). */
export function getStagedApprovalDetail(store, approvalId) {
  if (!store?.details || typeof approvalId !== "string") return null;
  sweep(store);
  return store.details.get(approvalId) ?? null;
}

/** WHICH principal may read a staged approval detail: only the owner surfaces
 * (the conversation's extension document, or Settings). The model and any page
 * / content-script sender are refused — the staged bodies never cross to a
 * model-controlled or web principal. */
export function mayReadApprovalDetail(principal) {
  return principal === "extension" || principal === "owner-options";
}

/** Which surface may resolve WHICH approval (per-agent alarms P1-3): Settings
 * (owner-options) resolves anything; an extension surface (the conversation's
 * approval card) may resolve ONLY run-bound approvals — a model-initiated
 * action awaiting its owner — never a `ui:`-bound one, which stays an exact
 * Settings-document decision. Every other principal resolves nothing. */
export function mayResolveApproval(row, principal) {
  if (principal === "owner-options") return Boolean(row);
  if (principal === "extension") {
    return Boolean(row) && typeof row.runId === "string" && !row.runId.startsWith("ui:");
  }
  return false;
}
