// lib/site-identity.js — page/document/toolset-scoped Site Agent identities and
// truthful proactive-tab discovery states (CAP-FB-20260824-WEBMCP-PAGE-IDENTITY-01).
//
// This module is DOM- and chrome-free. Browser-attested tab/document fields are
// supplied by the service worker; page URL/title/tool descriptors remain bounded
// untrusted metadata. Stable identity keys contain digests, not raw URLs or
// document ids. Origin remains an explicit field so origin isolation is never
// replaced by (or inferred from) a digest.

export const SITE_IDENTITY_VERSION = 2;
export const SITE_TITLE_MAX = 200;
export const SITE_URL_MAX = 4096;
export const SITE_HISTORY_MAX = 24;
export const SITE_TOOL_NAMES_MAX = 50;

function webOrigin(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Canonical page URL. Hashes are document-local state and are excluded; path
 * and query remain because two same-origin application pages must not collapse.
 * Credentials are never retained. */
export function canonicalPageUrl(value, expectedOrigin = null) {
  try {
    const raw = String(value ?? "");
    if (!raw || raw.length > SITE_URL_MAX) return null;
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (expectedOrigin && u.origin !== webOrigin(expectedOrigin)) return null;
    u.username = "";
    u.password = "";
    u.hash = "";
    const out = u.href;
    return out.length <= SITE_URL_MAX ? out : null;
  } catch {
    return null;
  }
}

/** Extract the canonical pathname from a page URL. */
export function canonicalPath(pageUrl) {
  try {
    const u = new URL(String(pageUrl ?? ""));
    return u.pathname || "/";
  } catch {
    return "/";
  }
}

export function boundedPageTitle(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim()
    .slice(0, SITE_TITLE_MAX);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${
    keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")
  }}`;
}

async function digest(value) {
  const bytes = new TextEncoder().encode(String(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalToolset(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => ({
      name: String(tool?.name ?? ""),
      source: String(tool?.source ?? ""),
      description: String(tool?.description ?? ""),
      inputSchema: tool?.inputSchema ?? null,
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name) || a.source.localeCompare(b.source)
    );
}

export function classifyInjectability(pageUrl, {
  hasScripting = false,
  hasHost = false,
  currentVerified = false,
} = {}) {
  const canonical = canonicalPageUrl(pageUrl);
  if (!canonical) return "non-injectable";
  const host = new URL(canonical).hostname;
  // Chrome forbids extension script injection into its Web Store even though
  // the pages are https. Do not present a permission prompt that cannot work.
  if (
    host === "chromewebstore.google.com" ||
    (host === "chrome.google.com" &&
      new URL(canonical).pathname.startsWith("/webstore"))
  ) {
    return "non-injectable";
  }
  if (!hasScripting || !hasHost) return "permission-required";
  return currentVerified ? "injected" : "injectable";
}

export function documentScopeKey(tabId, documentId, navigationEpoch) {
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  if (
    typeof documentId !== "string" || !documentId || documentId.length > 256
  ) return null;
  if (!Number.isInteger(navigationEpoch) || navigationEpoch < 0) return null;
  // This key is lifecycle authority only and is never used as durable identity.
  return `${tabId}:${navigationEpoch}:${documentId}`;
}

/** Build a verified v2 identity. The canonical id changes when the page URL or
 * canonical toolset changes, while documentKey proves only the current live
 * continuity. */
export async function buildSiteIdentity({
  origin,
  pageUrl,
  title = "",
  tabId,
  documentId,
  navigationEpoch,
  tools = [],
  observedAt = Date.now(),
}) {
  const canonicalOrigin = webOrigin(origin);
  const canonicalUrl = canonicalPageUrl(pageUrl, canonicalOrigin);
  const documentKey = documentScopeKey(tabId, documentId, navigationEpoch);
  if (!canonicalOrigin || !canonicalUrl || !documentKey) return null;
  const canonicalTools = canonicalToolset(tools);
  const path = canonicalPath(canonicalUrl);
  const [pageKey, toolsetKey] = await Promise.all([
    digest(canonicalUrl),
    digest(canonicalJson(canonicalTools)),
  ]);
  const id = `v2:${
    encodeURIComponent(canonicalOrigin)
  }:${pageKey}:${toolsetKey}`;
  return {
    version: SITE_IDENTITY_VERSION,
    id,
    origin: canonicalOrigin,
    pageKey,
    pageUrl: canonicalUrl,
    path,
    title: boundedPageTitle(title),
    documentKey,
    tabId,
    documentId,
    navigationEpoch,
    toolsetKey,
    toolCount: canonicalTools.length,
    toolNames: canonicalTools.slice(0, SITE_TOOL_NAMES_MAX).map((tool) =>
      tool.name
    ),
    observedAt: Number.isFinite(Number(observedAt))
      ? Number(observedAt)
      : Date.now(),
    state: "known",
  };
}

/** Loading identity intentionally has no site-agent id or toolset authority. */
export function buildLoadingSiteIdentity({
  origin,
  pageUrl,
  title = "",
  tabId,
  documentId,
  navigationEpoch,
  observedAt = Date.now(),
}) {
  const canonicalOrigin = webOrigin(origin);
  const canonicalUrl = canonicalPageUrl(pageUrl, canonicalOrigin);
  const documentKey = documentScopeKey(tabId, documentId, navigationEpoch);
  if (!canonicalOrigin || !canonicalUrl || !documentKey) return null;
  return {
    version: SITE_IDENTITY_VERSION,
    id: null,
    origin: canonicalOrigin,
    pageKey: null,
    pageUrl: canonicalUrl,
    path: canonicalPath(canonicalUrl),
    title: boundedPageTitle(title),
    documentKey,
    tabId,
    documentId,
    navigationEpoch,
    toolsetKey: null,
    toolCount: null,
    toolNames: [],
    observedAt: Number.isFinite(Number(observedAt))
      ? Number(observedAt)
      : Date.now(),
    state: "loading",
  };
}

export function historicalSiteIdentity(identity) {
  if (!identity || typeof identity !== "object" || !identity.id) return null;
  return {
    version: SITE_IDENTITY_VERSION,
    id: identity.id,
    origin: identity.origin,
    pageKey: identity.pageKey,
    pageUrl: identity.pageUrl,
    path: identity.path ?? canonicalPath(identity.pageUrl),
    title: boundedPageTitle(identity.title),
    documentKey: null,
    tabId: null,
    documentId: null,
    navigationEpoch: null,
    toolsetKey: identity.toolsetKey,
    toolCount: Number.isInteger(identity.toolCount) ? identity.toolCount : null,
    toolNames: Array.isArray(identity.toolNames)
      ? identity.toolNames.slice(0, SITE_TOOL_NAMES_MAX).map((name) =>
        String(name).slice(0, 128)
      )
      : [],
    observedAt: Number(identity.observedAt) || 0,
    state: "history",
  };
}

export function staleSiteIdentity(identity, observedAt = Date.now()) {
  if (!identity || typeof identity !== "object") return null;
  return {
    ...identity,
    documentKey: null,
    documentId: null,
    toolCount: identity.toolCount ?? null,
    observedAt: Number.isFinite(Number(observedAt))
      ? Number(observedAt)
      : Date.now(),
    state: "stale",
  };
}

/** Browser-attested page-URL check for an accepted tool snapshot: the page
 * reports its current location.href, but the authority is the browser's own
 * chrome.tabs.get(tabId).url. Both canonicalize against the expected origin
 * and must be EXACTLY equal — a mismatch means the report raced a navigation
 * (e.g. an SPA pushState that landed between collect and accept); reject and
 * let the fresh report win. Never derive authority from sender.url (it stays
 * the originally committed document URL for same-document navigations). */
export function attestReportedPageUrl(reportedUrl, tabUrl, expectedOrigin) {
  const origin = webOrigin(expectedOrigin);
  if (!origin) return { ok: false, canonicalUrl: null, reason: "invalid origin" };
  const reported = canonicalPageUrl(reportedUrl, origin);
  if (!reported) return { ok: false, canonicalUrl: null, reason: "reported page URL missing or cross-origin" };
  const attested = canonicalPageUrl(tabUrl, origin);
  if (!attested) return { ok: false, canonicalUrl: null, reason: "browser-attested tab URL missing or cross-origin" };
  if (reported !== attested) return { ok: false, canonicalUrl: null, reason: "reported page URL does not match the browser-attested tab URL" };
  return { ok: true, canonicalUrl: attested, reason: null };
}

export function samePage(identity, tab) {
  if (!identity || !tab || identity.tabId !== tab.id) return false;
  const pageUrl = canonicalPageUrl(tab.url, identity.origin);
  return Boolean(pageUrl && pageUrl === identity.pageUrl);
}

/** Recover the DECLARING page for a tool from site identities (page-open fix):
 * a legacy directory entry (written before page scoping) carries no pageUrl,
 * so invocation would open the origin ROOT where the tool is not registered.
 * The identity records know which page declared which toolNames — return the
 * freshest identity (current first, then history by observedAt) naming the
 * tool, as { pageUrl, path } or null. Pure. */
export function recoverDeclaringPageIdentity(identities, toolName) {
  const list = (Array.isArray(identities) ? identities : [])
    .filter((i) =>
      i && typeof i === "object" &&
      Array.isArray(i.toolNames) && i.toolNames.includes(toolName) &&
      typeof i.pageUrl === "string" && i.pageUrl
    )
    .sort((a, b) => {
      // "known"/current identity outranks history at equal observedAt.
      const rank = (x) => (x.state === "known" ? 1 : 0);
      return (rank(b) - rank(a)) || (Number(b.observedAt ?? 0) - Number(a.observedAt ?? 0));
    });
  const declaring = list[0];
  if (!declaring) return null;
  return { pageUrl: declaring.pageUrl, path: declaring.path ?? canonicalPath(declaring.pageUrl) };
}

/** Format a human-readable, page-aware site agent label. */
export function formatSiteAgentName({ origin, pageUrl = null, path = null, title = null } = {}) {
  const host = String(origin ?? "").replace(/^https?:\/\//, "").replace(/\/.*/, "");
  if (!host) return "Site Agent";
  const p = path ?? (pageUrl ? canonicalPath(pageUrl) : "/");
  if (p && p !== "/") {
    return `@${host}${p}`;
  }
  return `@${host}`;
}

/** Build the owner-visible state used before discovery. Known means the exact
 * current tab/document identity is still live. Probable is history for this
 * exact canonical page URL and is never execution authority. */
export function buildTabDiscoveryState(tab, {
  current = null,
  history = [],
  enrolled = false,
  injectability = "unknown",
  error = null,
  now = Date.now(),
} = {}) {
  const observedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const base = {
    state: "unknown",
    authority: false,
    toolCount: null,
    toolNames: [],
    capabilitySummary: "Tool availability has not been verified for this page.",
    observedAt: null,
    injectability,
    enrollment: enrolled ? "enrolled" : "not-enrolled",
    pageState: tab?.status === "loading"
      ? "loading"
      : tab?.discarded
      ? "discarded"
      : "ready",
    screenshot: {
      state: "not-captured",
      reason: "No screenshot permission was used.",
    },
    description: boundedPageTitle(tab?.title) || canonicalPageUrl(tab?.url) ||
      "Open web page",
    error: null,
  };
  if (error) {
    return {
      ...base,
      state: "error",
      capabilitySummary: "Page capability state could not be loaded.",
      error: String(error).slice(0, 300),
    };
  }
  if (tab?.status === "loading") {
    return {
      ...base,
      state: "loading",
      capabilitySummary:
        "The page is loading; tool availability is not yet known.",
    };
  }
  if (
    current?.state === "known" && current.documentKey && samePage(current, tab)
  ) {
    return {
      ...base,
      state: current.toolCount === 0 ? "empty" : "known",
      authority: true,
      toolCount: current.toolCount,
      toolNames: Array.isArray(current.toolNames)
        ? current.toolNames.slice(0, SITE_TOOL_NAMES_MAX)
        : [],
      capabilitySummary: current.toolCount === 0
        ? "Verified: this page reported no tools."
        : `Verified: ${current.toolCount} tool${
          current.toolCount === 1 ? "" : "s"
        } on this page.`,
      observedAt: current.observedAt ?? observedAt,
    };
  }
  const url = canonicalPageUrl(tab?.url);
  const probable = (Array.isArray(history) ? history : [])
    .filter((item) =>
      (item?.state === "history" || item?.state === "known") &&
      item.pageUrl === url
    )
    .sort((a, b) => Number(b.observedAt ?? 0) - Number(a.observedAt ?? 0))[0];
  if (probable) {
    return {
      ...base,
      state: "probable",
      authority: false,
      toolCount: probable.toolCount,
      toolNames: Array.isArray(probable.toolNames)
        ? probable.toolNames.slice(0, SITE_TOOL_NAMES_MAX)
        : [],
      capabilitySummary: probable.toolCount === 0
        ? "Previously verified with no tools; this document has not been checked."
        : `Probable: ${probable.toolCount} previously verified tool${
          probable.toolCount === 1 ? "" : "s"
        }; this document has not been checked.`,
      observedAt: probable.observedAt ?? null,
    };
  }
  return base;
}
