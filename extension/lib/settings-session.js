// extension/lib/settings-session.js — short-lived, document-bound Settings
// session tokens for in-hub Settings panels (chrome-agent-platform-8v5l.2).
//
// HONEST LIMIT (chrome-agent-platform-8v5l.2 / decision bead chrome-agent-platform-l354r):
// The hub document (ntp/ntp.html) also renders untrusted content. Any script
// running inside ntp.html can call the mint route (`settings.session.open`) and
// then invoke every route the allowlist (`SETTINGS_SESSION_ROUTES`) admits. A
// settings session therefore NARROWS scope and lifetime and makes admission
// explicit, revocable, and auditable. It does NOT recreate the browser-enforced
// process/document boundary that the exact-options (`options/options.html`)
// iframe provides today. The only unforgeable input is `sender.documentId`
// (browser-attested). The session token is not a secret that defends against
// script running in the hub document, and no comment or document may claim it
// is. That is why `SETTINGS_SESSION_ROUTES` starts empty and why credential
// routes stay out by default.

import { authorizeToolReport } from "./pure.js";

/**
 * Static allowlist mapping an admitted SW route name to the Settings panel
 * scope(s) that may invoke it: `{ [routeName]: readonly string[] }`.
 *
 * STARTS EMPTY in Stage 3b (`8v5l.2`). Adding any entry requires:
 *   1. Naming the Settings panel scope,
 *   2. Recording owner approval on decision bead `chrome-agent-platform-l354r`,
 *   3. Updating the SW dispatch authority census in the same commit,
 *   4. Adding a test proving the route is refused without a valid session.
 */
export const SETTINGS_SESSION_ROUTES = Object.freeze({});

export const DEFAULT_SETTINGS_SESSION_TTL_MS = 15 * 60 * 1000;
export const MAX_SETTINGS_SESSION_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_SETTINGS_SESSION_MAX = 32;
export const SETTINGS_SESSION_STORAGE_KEY = "cap:settingsSessions";

// Tracks the normalized allowlist that minted/verified a session object so
// `requireSettingsSession(context, route)` can resolve panel-scope -> route
// mappings without exposing internal fields on `routeContext.settingsSession`.
const sessionAllowedRoutesMap = new WeakMap();

/**
 * Normalize a route -> [panel scopes] allowlist into lookup sets.
 * Accepts `{ [route]: string[] | Set<string> | string | true }`, `Map`, `Set`, or `string[]`.
 */
export function normalizeSettingsSessionRoutes(allowedRoutes = SETTINGS_SESSION_ROUTES) {
  const routeToScopes = new Map();
  const allowedScopes = new Set();

  if (!allowedRoutes || typeof allowedRoutes !== "object") {
    return { routeToScopes, allowedScopes };
  }

  if (Array.isArray(allowedRoutes) || allowedRoutes instanceof Set) {
    for (const entry of allowedRoutes) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        const route = entry.trim();
        routeToScopes.set(route, new Set([route]));
        allowedScopes.add(route);
      }
    }
    return { routeToScopes, allowedScopes };
  }

  const entries = allowedRoutes instanceof Map
    ? [...allowedRoutes.entries()]
    : Object.entries(allowedRoutes);

  for (const [rawRoute, rawScopes] of entries) {
    if (typeof rawRoute !== "string" || rawRoute.trim().length === 0) continue;
    const route = rawRoute.trim();
    const scopesForRoute = new Set();

    if (Array.isArray(rawScopes) || rawScopes instanceof Set) {
      for (const s of rawScopes) {
        if (typeof s === "string" && s.trim().length > 0) {
          const clean = s.trim();
          scopesForRoute.add(clean);
          allowedScopes.add(clean);
        }
      }
    } else if (typeof rawScopes === "string" && rawScopes.trim().length > 0) {
      const clean = rawScopes.trim();
      scopesForRoute.add(clean);
      allowedScopes.add(clean);
    } else if (rawScopes === true) {
      scopesForRoute.add(route);
      allowedScopes.add(route);
    }

    if (scopesForRoute.size > 0) {
      scopesForRoute.add(route);
      allowedScopes.add(route);
      routeToScopes.set(route, scopesForRoute);
    }
  }

  return { routeToScopes, allowedScopes };
}

/**
 * Check whether `route` is authorized by `sessionScopes` under `normalizedRoutes`.
 */
export function isRouteAuthorizedForScopes(route, sessionScopes, normalizedRoutes) {
  if (typeof route !== "string" || route.length === 0) return false;
  if (!normalizedRoutes || !(normalizedRoutes.routeToScopes instanceof Map)) return false;
  const routeScopes = normalizedRoutes.routeToScopes.get(route);
  if (!routeScopes || routeScopes.size === 0) return false;

  const list = Array.isArray(sessionScopes)
    ? sessionScopes
    : sessionScopes instanceof Set
    ? [...sessionScopes]
    : [];
  if (list.length === 0) return false;

  for (const s of list) {
    if (typeof s === "string" && routeScopes.has(s)) return true;
  }
  return false;
}

/**
 * Check whether `route` is within a verified `settingsSession` object's scopes.
 */
export function isRouteWithinSettingsSession(session, route, explicitAllowedRoutes) {
  if (!session || typeof session !== "object") return false;
  if (typeof route !== "string" || route.length === 0) return false;
  const rawScopes = session.scopes;
  const scopeList = Array.isArray(rawScopes)
    ? rawScopes.filter((s) => typeof s === "string" && s.length > 0)
    : rawScopes instanceof Set
    ? [...rawScopes].filter((s) => typeof s === "string" && s.length > 0)
    : [];
  if (scopeList.length === 0) return false;

  if (explicitAllowedRoutes !== undefined) {
    const norm = normalizeSettingsSessionRoutes(explicitAllowedRoutes);
    return isRouteAuthorizedForScopes(route, scopeList, norm);
  }
  if (sessionAllowedRoutesMap.has(session)) {
    const norm = sessionAllowedRoutesMap.get(session);
    return isRouteAuthorizedForScopes(route, scopeList, norm);
  }
  if (Object.keys(SETTINGS_SESSION_ROUTES).length > 0) {
    const norm = normalizeSettingsSessionRoutes(SETTINGS_SESSION_ROUTES);
    return isRouteAuthorizedForScopes(route, scopeList, norm);
  }
  return scopeList.includes(route);
}

function defaultCanonicalOrigin(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.origin;
    }
    return null;
  } catch {
    return null;
  }
}

function isWebTabSender(sender, extensionId) {
  const tabUrl = typeof sender?.tab?.url === "string" ? sender.tab.url.trim() : "";
  if (!tabUrl) return false;
  if (tabUrl.startsWith(`chrome-extension://${extensionId}/`)) return false;
  if (tabUrl.startsWith("chrome://newtab") || tabUrl.startsWith("chrome://new-tab-page")) return false;
  if (tabUrl === "about:blank") return false;
  return true;
}

/**
 * Validate that a `chrome.runtime.onMessage` sender is eligible to mint an
 * in-hub Settings session via `settings.session.open`.
 *
 * Refused unless ALL hold:
 *   1. `sender.id === extensionId`
 *   2. Not a content script (`authorizeToolReport(...).kind !== "content-script"`)
 *      and not hosted in a web tab
 *   3. `sender.frameId == null || sender.frameId === 0` (subframes of the hub
 *      such as sandboxed artifact frames must never mint)
 *   4. `sender.url` is `ntp/ntp.html` (or `ntp/ntp.html#<fragment>` with no `?`
 *      query; options, sidepanel, and other paths are refused)
 *   5. Non-empty `sender.documentId`
 *   6. `sender.documentLifecycle == null || sender.documentLifecycle === "active"`
 */
export function validateSettingsSessionMintSender(
  sender,
  {
    extensionId = "",
    hubUrl = "",
    canonicalOrigin = defaultCanonicalOrigin,
  } = {},
) {
  if (!sender || typeof sender !== "object") {
    return { ok: false, reason: "invalid-sender", error: "invalid sender" };
  }
  if (typeof extensionId !== "string" || extensionId.length === 0 || sender.id !== extensionId) {
    return { ok: false, reason: "wrong-extension-id", error: "sender is not this extension" };
  }

  // Content-script / web-tab exclusion (m5): content scripts and web-tab frames
  // must never mint a settings session.
  const auth = authorizeToolReport(
    sender,
    null,
    typeof canonicalOrigin === "function" ? canonicalOrigin : defaultCanonicalOrigin,
    extensionId,
  );
  if (auth.kind === "content-script" || auth.kind === "unmatched" || isWebTabSender(sender, extensionId)) {
    return { ok: false, reason: "content-script", error: "content scripts cannot open a settings session" };
  }

  // Top-frame requirement (m4): subframes of the hub must never mint.
  if (sender.frameId != null && sender.frameId !== 0) {
    return { ok: false, reason: "subframe-not-allowed", error: "subframes cannot open a settings session" };
  }

  if (typeof hubUrl !== "string" || hubUrl.length === 0 || /[?#]/.test(hubUrl)) {
    return { ok: false, reason: "invalid-hub-url", error: "invalid hub URL configuration" };
  }
  if (typeof sender.url !== "string" || sender.url.length === 0) {
    return { ok: false, reason: "wrong-sender-url", error: "only the hub document may open a settings session" };
  }
  // Pin on hub URL matching:
  //   - Exact hub URL `chrome-extension://<id>/ntp/ntp.html` is accepted.
  //   - Same-document `#` fragments on `ntp/ntp.html` (e.g. `#view=...`,
  //     `#settings`, `#providers`) are accepted so mounting Settings on a
  //     deep-linked or navigated hub URL works.
  //   - Every `?` query string is rejected (`query-not-allowed`), whether before
  //     or inside the `#` fragment.
  //   - Any other extension document (`options/options.html`,
  //     `sidepanel/sidepanel.html`, etc.) is rejected (`wrong-sender-url`).
  if (sender.url.includes("?")) {
    return { ok: false, reason: "query-not-allowed", error: "query parameters are not permitted on settings session mint" };
  }
  const isExactHubDocument =
    sender.url === hubUrl ||
    (sender.url.startsWith(`${hubUrl}#`) && !/[\s\u0000-\u001f\u007f]/.test(sender.url.slice(hubUrl.length + 1)));
  if (!isExactHubDocument) {
    return { ok: false, reason: "wrong-sender-url", error: "only the hub document may open a settings session" };
  }
  if (sender.origin != null && sender.origin !== `chrome-extension://${extensionId}`) {
    return { ok: false, reason: "wrong-sender-origin", error: "sender origin does not match extension origin" };
  }

  if (typeof sender.documentId !== "string" || sender.documentId.trim().length === 0) {
    return { ok: false, reason: "missing-document-id", error: "sender documentId is required" };
  }
  if (sender.documentLifecycle != null && sender.documentLifecycle !== "active") {
    return { ok: false, reason: "inactive-document-lifecycle", error: "sender document must be active" };
  }

  return {
    ok: true,
    documentId: sender.documentId,
    tabId: Number.isInteger(sender?.tab?.id) ? sender.tab.id : null,
  };
}

function isValidStoredRecord(entry) {
  return Boolean(
    entry &&
      typeof entry === "object" &&
      typeof entry.token === "string" &&
      entry.token.length > 0 &&
      typeof entry.documentId === "string" &&
      entry.documentId.length > 0 &&
      Array.isArray(entry.scopes) &&
      entry.scopes.length > 0 &&
      entry.scopes.every((s) => typeof s === "string" && s.length > 0) &&
      typeof entry.issuedAt === "number" &&
      Number.isFinite(entry.issuedAt) &&
      typeof entry.expiresAt === "number" &&
      Number.isFinite(entry.expiresAt),
  );
}

/**
 * Create a bounded, clock- and store-injectable Settings session manager.
 */
export function createSettingsSessions({
  now = () => Date.now(),
  store = null,
  ttlMs = DEFAULT_SETTINGS_SESSION_TTL_MS,
  maxSessions = DEFAULT_SETTINGS_SESSION_MAX,
  allowedRoutes,
  routes,
  allowlist,
  allowedScopes,
  tokenFactory = () => crypto.randomUUID(),
} = {}) {
  const clock = typeof now === "function" ? now : () => Date.now();
  const effectiveTtlMs =
    typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0
      ? Math.min(ttlMs, MAX_SETTINGS_SESSION_TTL_MS)
      : DEFAULT_SETTINGS_SESSION_TTL_MS;
  const effectiveMax =
    typeof maxSessions === "number" && Number.isInteger(maxSessions) && maxSessions > 0
      ? maxSessions
      : DEFAULT_SETTINGS_SESSION_MAX;
  const mintToken = typeof tokenFactory === "function" ? tokenFactory : () => crypto.randomUUID();
  const configuredAllowlist =
    allowedRoutes ?? routes ?? allowlist ?? allowedScopes ?? SETTINGS_SESSION_ROUTES;
  const normalizedRoutes = normalizeSettingsSessionRoutes(configuredAllowlist);

  // Ordered oldest-first: token -> { token, documentId, scopes, issuedAt, expiresAt, tabId? }
  const byToken = new Map();
  let hydrated = false;

  async function readRawFromStore() {
    if (!store) return null;
    try {
      if (store instanceof Map) {
        if (store.has(SETTINGS_SESSION_STORAGE_KEY)) {
          return store.get(SETTINGS_SESSION_STORAGE_KEY);
        }
        return Object.fromEntries(store.entries());
      }
      if (typeof store.get === "function") {
        const res = await store.get(SETTINGS_SESSION_STORAGE_KEY);
        if (res && typeof res === "object" && Object.prototype.hasOwnProperty.call(res, SETTINGS_SESSION_STORAGE_KEY)) {
          return res[SETTINGS_SESSION_STORAGE_KEY];
        }
        return res ?? null;
      }
      if (typeof store.read === "function") {
        return await store.read();
      }
      if (typeof store.load === "function") {
        return await store.load();
      }
    } catch {
      return null;
    }
    return null;
  }

  async function persistToStore() {
    if (!store) return;
    const serialized = {};
    for (const [tok, rec] of byToken.entries()) {
      serialized[tok] = {
        token: rec.token,
        documentId: rec.documentId,
        scopes: [...rec.scopes],
        issuedAt: rec.issuedAt,
        expiresAt: rec.expiresAt,
        ...(Number.isInteger(rec.tabId) ? { tabId: rec.tabId } : {}),
      };
    }
    try {
      if (store instanceof Map) {
        store.set(SETTINGS_SESSION_STORAGE_KEY, serialized);
        return;
      }
      if (typeof store.set === "function") {
        await store.set({ [SETTINGS_SESSION_STORAGE_KEY]: serialized });
        return;
      }
      if (typeof store.write === "function") {
        await store.write(serialized);
        return;
      }
      if (typeof store.save === "function") {
        await store.save(serialized);
      }
    } catch {
      /* best-effort persistence; in-memory map remains authoritative for this worker turn */
    }
  }

  async function hydrateFromStore() {
    if (hydrated) return;
    hydrated = true;
    const raw = await readRawFromStore();
    if (!raw || typeof raw !== "object") return;
    const entries = Array.isArray(raw) ? raw : Object.values(raw);
    for (const entry of entries) {
      if (!isValidStoredRecord(entry)) continue;
      if (byToken.has(entry.token)) continue;
      // Keep only the newest record per documentId
      for (const [existingToken, existingRec] of byToken.entries()) {
        if (existingRec.documentId === entry.documentId) {
          byToken.delete(existingToken);
        }
      }
      byToken.set(
        entry.token,
        Object.freeze({
          token: entry.token,
          documentId: entry.documentId,
          scopes: Object.freeze([...entry.scopes]),
          issuedAt: entry.issuedAt,
          expiresAt: entry.expiresAt,
          ...(Number.isInteger(entry.tabId) ? { tabId: entry.tabId } : {}),
        }),
      );
    }
    while (byToken.size > effectiveMax) {
      const oldestKey = byToken.keys().next().value;
      if (oldestKey === undefined) break;
      byToken.delete(oldestKey);
    }
  }

  return Object.freeze({
    async open({ documentId, scopes, tabId = null } = {}) {
      if (
        typeof documentId !== "string" ||
        documentId.trim().length === 0 ||
        documentId !== documentId.trim()
      ) {
        return { ok: false, reason: "invalid-document", error: "valid documentId is required" };
      }
      if (!Array.isArray(scopes) && !(scopes instanceof Set)) {
        return { ok: false, reason: "empty-scope", error: "no allowed settings session scopes requested" };
      }

      const grantedScopes = [];
      const seen = new Set();
      for (const s of scopes) {
        if (
          typeof s === "string" &&
          s.length > 0 &&
          !seen.has(s) &&
          normalizedRoutes.allowedScopes.has(s)
        ) {
          seen.add(s);
          grantedScopes.push(s);
        }
      }
      if (grantedScopes.length === 0) {
        return { ok: false, reason: "empty-scope", error: "no allowed settings session scopes requested" };
      }

      await hydrateFromStore();
      const currentNow = clock();

      // Remove expired sessions before inserting
      for (const [tok, rec] of byToken.entries()) {
        if (!(currentNow < rec.expiresAt)) {
          byToken.delete(tok);
        }
      }
      // Replace any previous session for the same documentId
      for (const [tok, rec] of byToken.entries()) {
        if (rec.documentId === documentId) {
          byToken.delete(tok);
        }
      }

      const token = String(mintToken());
      const expiresAt = currentNow + effectiveTtlMs;
      const frozenScopes = Object.freeze([...grantedScopes]);
      const record = Object.freeze({
        token,
        documentId,
        scopes: frozenScopes,
        issuedAt: currentNow,
        expiresAt,
        ...(Number.isInteger(tabId) ? { tabId } : {}),
      });
      byToken.set(token, record);

      while (byToken.size > effectiveMax) {
        const oldestKey = byToken.keys().next().value;
        if (oldestKey === undefined) break;
        byToken.delete(oldestKey);
      }

      await persistToStore();
      return {
        ok: true,
        token,
        documentId,
        scopes: frozenScopes,
        expiresAt,
      };
    },

    async verify({ token, documentId, route } = {}) {
      if (typeof token !== "string" || token.length === 0) {
        return { ok: false, reason: "missing-token", error: "settings session token is required" };
      }
      if (typeof documentId !== "string" || documentId.length === 0) {
        return { ok: false, reason: "missing-document", error: "sender documentId is required" };
      }
      if (typeof route !== "string" || route.length === 0) {
        return { ok: false, reason: "missing-route", error: "route name is required" };
      }

      await hydrateFromStore();
      const record = byToken.get(token);
      if (!record) {
        return { ok: false, reason: "unknown-token", error: "settings session is not recognized" };
      }

      const currentNow = clock();
      // Expiry check (m2): expired at or after expiresAt.
      if (!(currentNow < record.expiresAt)) {
        byToken.delete(token);
        await persistToStore();
        return { ok: false, reason: "expired", error: "settings session has expired" };
      }

      // Document binding check (m1): session is bound to browser-attested sender.documentId.
      if (record.documentId !== documentId) {
        return { ok: false, reason: "document-mismatch", error: "settings session belongs to another document" };
      }

      // Scope / route check (m3): route must be permitted by the session's scopes.
      if (!isRouteAuthorizedForScopes(route, record.scopes, normalizedRoutes)) {
        return { ok: false, reason: "scope-mismatch", error: "route is not within the settings session scope" };
      }

      const session = Object.freeze({
        documentId: record.documentId,
        scopes: Object.freeze([...record.scopes]),
        expiresAt: record.expiresAt,
      });
      sessionAllowedRoutesMap.set(session, normalizedRoutes);
      return { ok: true, session };
    },

    async close({ documentId, tabId } = {}) {
      const hasDoc = typeof documentId === "string" && documentId.trim().length > 0;
      const hasTab = Number.isInteger(tabId);
      if (!hasDoc && !hasTab) {
        return { ok: false, closed: false, reason: "invalid-document", error: "sender documentId is required" };
      }

      await hydrateFromStore();
      let removed = 0;
      for (const [tok, rec] of byToken.entries()) {
        if ((hasDoc && rec.documentId === documentId) || (hasTab && rec.tabId === tabId)) {
          byToken.delete(tok);
          removed += 1;
        }
      }
      if (removed > 0) {
        await persistToStore();
      }
      return { ok: true, closed: removed > 0 };
    },

    async sweep() {
      await hydrateFromStore();
      const currentNow = clock();
      let swept = 0;
      for (const [tok, rec] of byToken.entries()) {
        if (!(currentNow < rec.expiresAt)) {
          byToken.delete(tok);
          swept += 1;
        }
      }
      while (byToken.size > effectiveMax) {
        const oldestKey = byToken.keys().next().value;
        if (oldestKey === undefined) break;
        byToken.delete(oldestKey);
        swept += 1;
      }
      if (swept > 0) {
        await persistToStore();
      }
      return { ok: true, swept, remaining: byToken.size };
    },
  });
}
