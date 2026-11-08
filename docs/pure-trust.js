// lib/pure-trust.js — the trust seam (settings sections, exact-options sender, tool-report
// authorisation, service-worker sender predicate). Extracted from lib/pure.js by
// chrome-agent-platform-ux4ud; pure.js re-exports all of it.
import { redactSecrets } from "./pure-redact.js";

/**
 * Classify a runtime message sender + derive/validate the tool-report origin.
 * Pure: takes a sender-shaped object, returns a decision. This is the sender
 * authorization boundary — a content script may only report tools for ITS OWN
 * page origin, never a message-supplied one.
 *
 * Returns: { kind: "content-script"|"extension"|"unmatched", origin?, error? }
 */
/**
 * Owner approvals may be resolved only by the exact Settings document. This
 * checks browser-supplied sender metadata, never message-body claims. A tab
 * sender is rejected even if it claims the extension URL.
 */
export const SETTINGS_SECTIONS = Object.freeze([
  "providers",
  "mcp-servers",
  "local-folders",
  "user-wasm",
  "tool-library",
  "skills",
  "agents",
  "browser",
  "board-permissions",
  "permissions",
  "web-services",
  "hooks",
  "prompts",
  "usage",
  "data",
  "about",
]);

// The DEVELOPER-only subset of the Settings sections. With the developer flag
// off (the default, CAP-FB-20260830-EXEC-BUILD-FLAG-01) these nav items and
// panels are hidden and their renderers are skipped; the ids stay valid so a
// deep link still resolves (and shows a "turn on developer features" notice).
// These are the platform/plumbing lanes, never a user-facing surface — Local
// folders and Browser control stay visible because they are legitimate user
// features (their monolith fold is owned by CAP-FB-20260827-SETTINGS-MONOLITH-01,
// not this flag).
export const DEVELOPER_SECTIONS = Object.freeze([
  "tool-library",
  "board-permissions",
  "hooks",
  "prompts",
]);

export const DEVELOPER_SECTIONS_SET = new Set(DEVELOPER_SECTIONS);

// The kv key for the developer-features preference. Defined here (a dependency-
// free module) so the Settings page can read/write it without importing the
// heavy model layer; lib/provider.js re-exports it as DEVELOPER_FEATURES_KEY so
// developerFeaturesOn() and the Settings toggle share one source of truth.
export const DEVELOPER_FEATURES_KEY = "cap:developerFeatures";

export function normalizeSettingsSectionId(hash) {
  if (typeof hash !== "string" || !hash) return null;
  const clean = hash.startsWith("#") ? hash.slice(1).trim() : hash.trim();
  // Legacy background-agent deep links now land on the unified Agents section.
  if (clean === "background-agents" || clean === "background") return "agents";
  if (SETTINGS_SECTIONS.includes(clean)) return clean;
  return null;
}

export const OPTIONS_PRODUCT_HASHES = new Set([
  "#providers", "#mcp-servers", "#local-folders", "#user-wasm", "#tool-library", "#skills", "#agents", "#background",
  "#background-agents", "#board-permissions",
  "#browser", "#permissions", "#web-services", "#hooks",
  "#prompts", "#usage", "#data", "#about",
]);

export function isExactOptionsSender(sender, extensionId, exactOptionsUrl) {
  if (!sender || typeof sender !== "object") return false;
  if (typeof extensionId !== "string" || !extensionId) return false;
  if (typeof exactOptionsUrl !== "string" || !exactOptionsUrl || /[?#]/.test(exactOptionsUrl)) return false;
  // Settings owns these fragment-only deep links. Accepting an explicit closed
  // set reconciles the product's own navigation with sender authorization while
  // preserving exact document/origin equality and rejecting every query,
  // foreign path, unknown fragment, or mixed query+fragment.
  const exactDocument = sender.url === exactOptionsUrl ||
    (typeof sender.url === "string" && OPTIONS_PRODUCT_HASHES.has(sender.url.slice(exactOptionsUrl.length)) && sender.url.startsWith(exactOptionsUrl));
  // The shipped NTP presents this exact private extension document in an
  // iframe. Chrome may omit frame/lifecycle/tab metadata for extension pages.
  // Web pages cannot load this non-web-accessible document; browser-supplied
  // extension id + exact document URL/product-owned hash + document id are the
  // authority.
  return sender.id === extensionId &&
    exactDocument &&
    // Chrome omits `origin` for extension-page runtime messages; the exact
    // browser-supplied chrome-extension:// URL already binds the origin.
    (sender.origin == null || sender.origin === `chrome-extension://${extensionId}`) &&
    (sender.documentLifecycle == null || sender.documentLifecycle === "active") &&
    typeof sender.documentId === "string" && sender.documentId.length > 0;
}

/** cac6c r3 (1fn9j): the central dispatcher's sender ENFORCEMENT point.
 * True iff the message comes from THIS extension itself — every surface
 * Chrome attests with sender.id === runtime.id (extension pages in tabs or
 * not, iframes, offscreen, side panel, popup) including our content scripts,
 * which the dispatcher then restricts to page-allowed routes downstream.
 * Everything else — foreign pages via externally_connectable, other
 * extensions, crafted senders with no id (which the classifier alone would
 * mislabel kind:"extension" when tab and url are absent) — is refused BY THE
 * CALLER uniformly: the dispatcher's single deny() reply, ONE generic literal
 * ({ ok: false, error: "unknown message" }), emitted before route resolution.
 * The refusal is a REPLY, not silence, because the shipped integration
 * contracts pin a refusal response from untrusted senders; the IDENTICAL
 * literal on every rejection path is what keeps a hostile sender from
 * enumerating routes through differentiated replies (the r2 review's finding
 * 1). This is
 * a predicate that yields the rejection at the call site — a real
 * enforcement point, unlike authorizeToolReport below, which CLASSIFIES
 * already-admitted senders and is deliberately NOT credited as an authoriser
 * (1fn9j finding 3: crediting a classifier was an allowlist in a new coat).
 */
export function isOwnExtensionSender(
  sender,
  runtimeId = globalThis.chrome?.runtime?.id,
) {
  return (
    typeof runtimeId === "string" &&
    runtimeId !== "" &&
    typeof sender?.id === "string" &&
    sender.id === runtimeId
  );
}

export function authorizeToolReport(
  sender,
  messageOrigin,
  canonicalOrigin,
  extensionId,
) {
  const senderUrl = sender?.url ?? "";
  const senderTabUrl = sender?.tab?.url ?? "";
  const isContentScript = Boolean(
    sender?.id === extensionId &&
      senderTabUrl &&
      !senderUrl.startsWith("chrome-extension://") &&
      !senderUrl.startsWith("moz-extension://") &&
      sender?.frameId === 0,
  );
  if (!isContentScript) {
    if (!senderUrl.startsWith("chrome-extension://") && senderTabUrl) {
      return {
        kind: "unmatched",
        error: "tool reports must come from the page's top frame",
      };
    }
    return { kind: "extension" };
  }
  const senderOrigin = canonicalOrigin(senderTabUrl);
  if (!senderOrigin) {
    return { kind: "content-script", error: "invalid sender origin" };
  }
  if (sender?.origin && canonicalOrigin(sender.origin) !== senderOrigin) {
    return { kind: "content-script", error: "sender origin mismatch — tool report rejected" };
  }
  if (messageOrigin && canonicalOrigin(messageOrigin) !== senderOrigin) {
    return {
      kind: "content-script",
      error: "origin mismatch — tool report rejected",
    };
  }
  return { kind: "content-script", origin: senderOrigin };
}

export const SERVICE_WORKER_BUNDLE_PATH = "dist/background/service-worker.js";

/**
 * Validates that a runtime message sender is the extension's own background service worker.
 * Same-extension documents/tabs share sender.id, so checking id alone is insufficient;
 * documentId and tab are strictly forbidden, and the sender URL must match the background service worker bundle.
 */
export function isTrustedServiceWorkerSender(sender, runtime = globalThis.chrome?.runtime) {
  if (!runtime || !runtime.id || sender?.id !== runtime.id || sender?.tab != null || sender?.documentId != null) return false;
  const url = typeof sender?.url === "string" ? sender.url : "";
  const declared = runtime.getManifest?.()?.background?.service_worker;
  if (typeof declared === "string" && declared.length > 0 && declared !== SERVICE_WORKER_BUNDLE_PATH) return false;
  return url === runtime.getURL(SERVICE_WORKER_BUNDLE_PATH);
}
export const isTrustedWasmStreamSender = isTrustedServiceWorkerSender;
