// lib/permission-orchestration.js — canonical, least-privilege permission plans.
//
// This module is deliberately model-inaccessible. Tools/actions declare exact
// Chrome API permissions and host match patterns here; owner-facing pages may
// use the resulting immutable bundle with chrome.permissions.request from a
// fresh click. Browser grants are global extension state; task/product policy
// authorization is deliberately not implemented by this partial foundation.

const API_PERMISSIONS = new Set([
  "alarms", "storage", "sidePanel", "tabs", "scripting", "notifications",
  "audioCapture", "videoCapture", "declarativeNetRequest", "bookmarks",
  "contextMenus", "downloads", "history", "idle", "webNavigation",
  // Tranche-8 site-data control (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01).
  "cookies", "browsingData", "contentSettings",
]);
const MAX_DECLARATIONS = 32;
const MAX_PERMISSIONS = 16;
const MAX_ORIGINS = 32;
const MAX_TEXT = 160;

function boundedText(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("permission metadata must be plain text");
  }
  const text = value.trim().replace(/\s+/g, " ");
  if (!text || text.length > MAX_TEXT) throw new TypeError("permission metadata is empty or too long");
  return text;
}

function stringArray(value, name, max) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must be a bounded string array`);
  }
  return value;
}

/** Normalize one exact http(s) host match. Wildcard hosts/paths are rejected.
 * `<all_urls>` is accepted only for an explicitly truthful arbitrary-sites
 * declaration and remains visually high-friction in the returned plan. */
export function normalizeHostPattern(value, { arbitrarySites = false } = {}) {
  if (typeof value !== "string") throw new TypeError("host permission must be a string");
  const raw = value.trim();
  if (raw === "<all_urls>") {
    if (!arbitrarySites) throw new TypeError("<all_urls> requires an explicit arbitrary-sites declaration");
    return raw;
  }
  if (!/^https?:\/\//i.test(raw)) throw new TypeError("host permission must use http or https");
  let url;
  try { url = new URL(raw); } catch { throw new TypeError("malformed host permission"); }
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) {
    throw new TypeError("malformed host permission");
  }
  if (url.hostname.includes("*") || url.search || url.hash) {
    throw new TypeError("wildcard or decorated host permissions are not allowed");
  }
  if (url.pathname !== "/" && url.pathname !== "/*") {
    throw new TypeError("host permission must cover one exact origin");
  }
  return `${url.protocol}//${url.host}/*`;
}

export function exactOriginPattern(value) {
  if (typeof value !== "string") throw new TypeError("origin must be a string");
  let url;
  try { url = new URL(value); } catch { throw new TypeError("invalid origin"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("an exact http(s) origin is required");
  }
  return normalizeHostPattern(`${url.origin}/*`);
}

/** Validate one canonical action/tool declaration. `activeTab` is not a
 * requestable background fallback: it is eligible only for an action invoked
 * by one of Chrome's activeTab owner gestures on the current tab. */
export function normalizeRequirement(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("permission requirement must be an object");
  const allowedKeys = new Set(["tool", "reason", "context", "arbitrarySites", "permissions", "origins"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw new TypeError("unknown permission requirement field");
  const tool = boundedText(input.tool, "action");
  const reason = boundedText(input.reason, "Required for this action");
  if (input.context != null && input.context !== "owner-current-tab" && input.context !== "background") {
    throw new TypeError("invalid permission context");
  }
  if (input.arbitrarySites != null && typeof input.arbitrarySites !== "boolean") {
    throw new TypeError("arbitrarySites must be a boolean");
  }
  const context = input.context ?? "background";
  const arbitrarySites = input.arbitrarySites === true;
  const permissions = [...new Set(stringArray(input.permissions, "permissions", MAX_PERMISSIONS))].sort();
  for (const permission of permissions) {
    if (permission === "activeTab") {
      if (context !== "owner-current-tab") {
        throw new TypeError("activeTab is only eligible for an owner-invoked current-tab action");
      }
      continue;
    }
    if (!API_PERMISSIONS.has(permission)) throw new TypeError(`unsupported Chrome permission: ${permission}`);
  }
  const origins = [...new Set(stringArray(input.origins, "origins", MAX_ORIGINS).map((origin) =>
    normalizeHostPattern(origin, { arbitrarySites })))].sort();
  if (origins.includes("<all_urls>") && origins.length !== 1) {
    throw new TypeError("<all_urls> cannot be bundled with narrower origins");
  }
  if (arbitrarySites && !origins.includes("<all_urls>")) {
    throw new TypeError("arbitrary-sites must truthfully declare <all_urls>");
  }
  if (!permissions.length && !origins.length) throw new TypeError("permission requirement is empty");
  return Object.freeze({ tool, reason, context, permissions: Object.freeze(permissions), origins: Object.freeze(origins), arbitrarySites });
}

function requestableBundle(requirements) {
  const permissions = new Set();
  const origins = new Set();
  for (const req of requirements) {
    for (const permission of req.permissions) {
      // activeTab is acquired by Chrome's qualifying invocation, never by a
      // side-panel/settings permissions.request button.
      if (permission !== "activeTab") permissions.add(permission);
    }
    for (const origin of req.origins) origins.add(origin);
  }
  if (permissions.size > MAX_PERMISSIONS || origins.size > MAX_ORIGINS) throw new TypeError("permission plan is too large");
  return Object.freeze({
    permissions: Object.freeze([...permissions].sort()),
    origins: Object.freeze([...origins].sort()),
  });
}

async function missingBundle(bundle, contains) {
  const permissions = [];
  const origins = [];
  for (const permission of bundle.permissions) {
    if (!(await contains({ permissions: [permission] }))) permissions.push(permission);
  }
  for (const origin of bundle.origins) {
    if (!(await contains({ origins: [origin] }))) origins.push(origin);
  }
  return Object.freeze({ permissions: Object.freeze(permissions), origins: Object.freeze(origins) });
}

/** Compute the deterministic minimal union and compare every exact member via
 * chrome.permissions.contains. No capability or grant function crosses to the
 * model. */
export async function computePermissionPlan(inputs, {
  contains = (bundle) => chrome.permissions.contains(bundle),
  ownerId = "owner",
  taskId = "task",
  executionId = "execution",
} = {}) {
  if (!Array.isArray(inputs) || inputs.length > MAX_DECLARATIONS) throw new TypeError("invalid permission declaration list");
  const requirements = inputs.map(normalizeRequirement);
  const bundle = requestableBundle(requirements);
  const missing = await missingBundle(bundle, contains);
  const transient = requirements.some((req) => req.permissions.includes("activeTab"));
  return Object.freeze({
    version: 1,
    ownerId: boundedText(ownerId, "owner"),
    taskId: boundedText(taskId, "task"),
    executionId: boundedText(executionId, "execution"),
    state: (missing.permissions.length || missing.origins.length || transient) ? "waiting-for-permission" : "ready",
    bundle,
    missing,
    transientActiveTab: transient,
    highFriction: bundle.origins.includes("<all_urls>"),
    groups: Object.freeze(requirements.map((req) => Object.freeze({
      tool: req.tool, reason: req.reason, origins: req.origins, permissions: req.permissions,
    }))),
  });
}

/** MUST be invoked directly from the owner's click handler. There is
 * intentionally no await or other asynchronous work before request(). */
export function requestPermissionBundleFromGesture(bundle, request = (b) => chrome.permissions.request(b)) {
  const normalized = requestableBundle([normalizeRequirement({
    tool: "owner grant", reason: "Approved permission plan",
    permissions: bundle?.permissions ?? [], origins: bundle?.origins ?? [],
    arbitrarySites: bundle?.origins?.includes?.("<all_urls>") === true,
  })]);
  const requestBundle = {};
  if (normalized.permissions.length) requestBundle.permissions = [...normalized.permissions];
  if (normalized.origins.length) requestBundle.origins = [...normalized.origins];
  if (!Object.keys(requestBundle).length) return Promise.resolve(true);
  return request(requestBundle);
}

export async function verifyPermissionBundle(bundle, contains = (b) => chrome.permissions.contains(b)) {
  const missing = await missingBundle(requestableBundle([normalizeRequirement({
    tool: "verification", reason: "Verify the exact granted bundle",
    permissions: bundle?.permissions ?? [], origins: bundle?.origins ?? [],
    arbitrarySites: bundle?.origins?.includes?.("<all_urls>") === true,
  })]), contains);
  return { granted: missing.permissions.length === 0 && missing.origins.length === 0, missing };
}
