// @ts-nocheck
// tests/settings-session.test.ts — Stage 3b SW settings-session mechanism & falsification tests
// (chrome-agent-platform-8v5l.2 / chrome-agent-platform-l354r).

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1";
import * as acorn from "npm:acorn";

import {
  DEFAULT_SETTINGS_SESSION_MAX,
  DEFAULT_SETTINGS_SESSION_TTL_MS,
  MAX_SETTINGS_SESSION_TTL_MS,
  SETTINGS_SESSION_ROUTES,
  createSettingsSessions,
  isRouteWithinSettingsSession,
  validateSettingsSessionMintSender,
} from "../extension/lib/settings-session.js";
import {
  requireSettingsSender,
  requireSettingsSession,
  requireSettingsSurface,
} from "../extension/background/routes/index.js";
import {
  PAGE_ALLOWED_ROUTES,
  authorizeToolReport,
  isExactOptionsSender,
} from "../extension/lib/pure.js";
import { mayResolveApproval } from "../extension/lib/owner-approval.js";
import { canonicalOrigin } from "../extension/lib/memory.js";
import { errorDetail } from "../extension/lib/error-report.js";
import {
  CENSUS_CATEGORIES,
  assertSettingsSessionRoutesInCensus,
} from "./sw-dispatch-authority-census.test.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXT_ID = "test-extension-id";
const HUB_URL = `chrome-extension://${EXT_ID}/ntp/ntp.html`;
const OPTIONS_URL = `chrome-extension://${EXT_ID}/options/options.html`;
const SIDEPANEL_URL = `chrome-extension://${EXT_ID}/sidepanel/sidepanel.html`;

// ── Live Service Worker harness (mirrors tests/provider-gate.test.ts) ────────

const memStorage: Record<string, unknown> = {};
const sessionStorage: Record<string, unknown> = {};
const swListeners: Array<(msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean> = [];
const tabRemovedListeners: Array<(tabId: number) => void> = [];
const forwardedRuntimeMessages: Array<Record<string, unknown>> = [];

(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    id: EXT_ID,
    getURL: (p: string) => `chrome-extension://${EXT_ID}/${String(p ?? "").replace(/^\//, "")}`,
    getManifest: () => ({ version: "0.0.0" }),
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onConnect: { addListener: () => {} },
    onMessage: {
      addListener: (fn: (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean) => {
        swListeners.push(fn);
      },
    },
    sendMessage: async (msg: Record<string, unknown>) => {
      forwardedRuntimeMessages.push(msg);
      return { ok: true, availability: "available" };
    },
  },
  storage: {
    local: {
      get: async (k?: string | string[] | Record<string, unknown>) => {
        if (!k) return { ...memStorage };
        if (typeof k === "string") return k in memStorage ? { [k]: memStorage[k] } : {};
        if (Array.isArray(k)) {
          const out: Record<string, unknown> = {};
          for (const key of k) if (key in memStorage) out[key] = memStorage[key];
          return out;
        }
        return { ...k, ...memStorage };
      },
      set: async (obj: Record<string, unknown>) => {
        Object.assign(memStorage, obj);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete memStorage[k];
      },
    },
    session: {
      get: async (k?: string | string[]) => {
        if (!k) return { ...sessionStorage };
        if (typeof k === "string") return k in sessionStorage ? { [k]: sessionStorage[k] } : {};
        const out: Record<string, unknown> = {};
        for (const key of k) if (key in sessionStorage) out[key] = sessionStorage[key];
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        Object.assign(sessionStorage, obj);
      },
      remove: async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete sessionStorage[k];
      },
    },
    onChanged: { addListener: () => {} },
  },
  alarms: {
    create: async () => {},
    clear: async () => true,
    get: async () => null,
    getAll: async () => [],
    onAlarm: { addListener: () => {} },
  },
  permissions: {
    contains: async () => true,
    request: async () => true,
    remove: async () => true,
    onAdded: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
  },
  tabs: {
    query: async () => [],
    onUpdated: { addListener: () => {} },
    onRemoved: {
      addListener: (fn: (tabId: number) => void) => {
        tabRemovedListeners.push(fn);
      },
    },
    onActivated: { addListener: () => {} },
    onCreated: { addListener: () => {} },
  },
  sidePanel: { setPanelBehavior: async () => {} },
  action: {
    onClicked: { addListener: () => {} },
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    setBadgeTextColor: async () => {},
    setTitle: async () => {},
  },
  omnibox: {
    onInputEntered: { addListener: () => {} },
    onInputChanged: { addListener: () => {} },
  },
  commands: { onCommand: { addListener: () => {} } },
  notifications: {
    onClicked: { addListener: () => {} },
    onButtonClicked: { addListener: () => {} },
    onClosed: { addListener: () => {} },
  },
  offscreen: {
    createDocument: async () => {},
    Reason: { WORKERS: "WORKERS" },
  },
};

await import("../extension/background/service-worker.js");

function dispatchLiveSw(
  message: Record<string, unknown>,
  sender: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const listener = swListeners[swListeners.length - 1];
  assert(typeof listener === "function", "service-worker.js must register a runtime.onMessage listener");
  return new Promise((resolve) => {
    listener(message, { id: EXT_ID, ...sender }, (resp) => {
      resolve((resp ?? {}) as Record<string, unknown>);
    });
  });
}

// ── AST-extracted SW dispatcher + listener harness for non-empty allowlist tests ─
//
// Because SETTINGS_SESSION_ROUTES is empty at Stage 3b merge, this helper
// parses the REAL extension/background/service-worker.js AST and extracts the
// exact source of:
//   - dispatchRoute
//   - "settings.session.open" and "settings.session.close" in mergeRouteMaps
//   - the central chrome.runtime.onMessage.addListener callback
// and binds them to a createSettingsSessions instance with an explicit test
// route allowlist, so any mutation in service-worker.js, settings-session.js,
// or routes/auth.js is exercised end-to-end without adding test hooks to
// shipped code.

function createExtractedSwHarness({
  allowedRoutes = {
    "test.settings.panel": ["providers"],
    "test.settings.mcp": ["mcp-servers"],
  },
  now = () => Date.now(),
  store = new Map(),
  ttlMs = DEFAULT_SETTINGS_SESSION_TTL_MS,
  maxSessions = DEFAULT_SETTINGS_SESSION_MAX,
  tokenFactory,
}: {
  allowedRoutes?: Record<string, string[]>;
  now?: () => number;
  store?: unknown;
  ttlMs?: number;
  maxSessions?: number;
  tokenFactory?: () => string;
} = {}) {
  const swSource = Deno.readTextFileSync(`${ROOT}extension/background/service-worker.js`);
  const ast = acorn.parse(swSource, { ecmaVersion: "latest", sourceType: "module" });

  let dispatchRouteNode: any = null;
  let isOwnerPrincipalNode: any = null;
  let openPropNode: any = null;
  let closePropNode: any = null;
  let listenerCallbackNode: any = null;

  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "FunctionDeclaration" && node.id?.name === "dispatchRoute") {
      dispatchRouteNode = node;
    }
    if (node.type === "FunctionDeclaration" && node.id?.name === "isOwnerPrincipal") {
      isOwnerPrincipalNode = node;
    }
    if (
      node.type === "Property" &&
      node.key?.type === "Literal" &&
      node.key.value === "settings.session.open"
    ) {
      openPropNode = node;
    }
    if (
      node.type === "Property" &&
      node.key?.type === "Literal" &&
      node.key.value === "settings.session.close"
    ) {
      closePropNode = node;
    }
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "MemberExpression" &&
      node.callee.property?.name === "addListener" &&
      node.callee.object?.type === "MemberExpression" &&
      node.callee.object.property?.name === "onMessage"
    ) {
      listenerCallbackNode = node.arguments[0];
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "start" || k === "end" || k === "loc") continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(ast);

  assert(dispatchRouteNode, "must find dispatchRoute in service-worker.js AST");
  assert(isOwnerPrincipalNode, "must find isOwnerPrincipal in service-worker.js AST");
  assert(openPropNode, "must find settings.session.open in service-worker.js AST");
  assert(closePropNode, "must find settings.session.close in service-worker.js AST");
  assert(listenerCallbackNode, "must find onMessage.addListener callback in service-worker.js AST");

  const dispatchRouteCode = swSource.slice(dispatchRouteNode.start, dispatchRouteNode.end);
  const isOwnerPrincipalCode = swSource.slice(isOwnerPrincipalNode.start, isOwnerPrincipalNode.end);
  const openPropCode = swSource.slice(openPropNode.start, openPropNode.end);
  const closePropCode = swSource.slice(closePropNode.start, closePropNode.end);
  const listenerCode = swSource.slice(listenerCallbackNode.start, listenerCallbackNode.end);

  const settingsSessions = createSettingsSessions({
    now,
    store,
    ttlMs,
    maxSessions,
    allowedRoutes,
    ...(tokenFactory ? { tokenFactory } : {}),
  });

  const securityEvents: Array<{ kind: string; detail: string }> = [];
  const observedCalls: Array<{ route: string; body: Record<string, unknown>; context: Record<string, unknown> }> = [];
  const ERR_OWNER_EXT_REQUIRED = Object.freeze({ ok: false, error: "owner_extension_required" });

  const customHandlers: Record<string, (body: any, context: any) => any> = {
    async "test.settings.panel"(body, context) {
      observedCalls.push({ route: "test.settings.panel", body, context });
      requireSettingsSurface(context, "test.settings.panel", {
        now,
        allowedRoutes,
      });
      let strictSettingsRejected = false;
      try {
        requireSettingsSender(context);
      } catch (e: any) {
        strictSettingsRejected = e?.name === "SettingsSurfaceRequiredError";
      }
      return {
        ok: true,
        principal: context.principal,
        hasSettingsSession: Boolean(context.settingsSession),
        strictSettingsRejected,
        mayResolveOwnerOptionsApproval: mayResolveApproval(
          { runId: `ui:${context.documentId}` },
          context.principal,
          context.documentId,
        ),
        receivedBodyKeys: Object.keys(body ?? {}),
      };
    },
    async "test.settings.sessionOnly"(body, context) {
      observedCalls.push({ route: "test.settings.sessionOnly", body, context });
      requireSettingsSession(context, "test.settings.panel", {
        now,
        allowedRoutes,
      });
      return { ok: true, principal: context.principal };
    },
    async "test.settings.mcp"(body, context) {
      observedCalls.push({ route: "test.settings.mcp", body, context });
      requireSettingsSurface(context, "test.settings.mcp", {
        now,
        allowedRoutes,
      });
      return { ok: true, principal: context.principal };
    },
  };

  const factory = new Function(
    "deps",
    `
    const {
      chrome,
      authorizeToolReport,
      canonicalOrigin,
      isExactOptionsSender,
      PAGE_ALLOWED_ROUTES,
      securityEvent,
      errorDetail,
      ERR_OWNER_EXT_REQUIRED,
      validateSettingsSessionMintSender,
      settingsSessions,
      customHandlers,
      routeLog,
    } = deps;
    ${isOwnerPrincipalCode}
    const handlers = {
      ...customHandlers,
      ${openPropCode},
      ${closePropCode},
    };
    ${dispatchRouteCode}
    const listener = ${listenerCode};
    return { handlers, dispatchRoute, listener };
  `,
  );

  const built = factory({
    chrome: (globalThis as any).chrome,
    authorizeToolReport,
    canonicalOrigin,
    isExactOptionsSender,
    PAGE_ALLOWED_ROUTES,
    securityEvent: (kind: string, detail: string) => {
      securityEvents.push({ kind, detail: String(detail ?? "") });
    },
    errorDetail,
    ERR_OWNER_EXT_REQUIRED,
    validateSettingsSessionMintSender,
    settingsSessions,
    customHandlers,
    routeLog: { debug: () => {} },
  });

  function send(message: Record<string, unknown>, sender: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      built.listener(message, sender, (resp: unknown) => {
        resolve((resp ?? {}) as Record<string, unknown>);
      });
    });
  }

  return {
    send,
    handlers: built.handlers,
    dispatchRoute: built.dispatchRoute,
    settingsSessions,
    securityEvents,
    observedCalls,
  };
}

// ── Acceptance 5 & Mutant (m9): empty allowlist at merge + census lockstep ──

Deno.test("settings-session: SETTINGS_SESSION_ROUTES is frozen and EMPTY at Stage 3b merge (m9)", () => {
  assert(Object.isFrozen(SETTINGS_SESSION_ROUTES), "SETTINGS_SESSION_ROUTES must be Object.freeze'd");
  assertSettingsSessionRoutesInCensus(SETTINGS_SESSION_ROUTES, CENSUS_CATEGORIES);
  assertEquals(
    Object.keys(SETTINGS_SESSION_ROUTES),
    [],
    "SETTINGS_SESSION_ROUTES must be EMPTY at merge (Stage 3b admits zero routes to the hub)",
  );

  // Mutant (m9) falsification: any route in SETTINGS_SESSION_ROUTES without a census entry throws.
  assertThrows(
    () =>
      assertSettingsSessionRoutesInCensus(
        { "unclassified.settings.route": ["providers"] },
        CENSUS_CATEGORIES,
      ),
    Error,
    "unclassified.settings.route",
  );
});

// ── Acceptance 1: Pure module tests (fake clock + fake store) ───────────────

Deno.test("settings-session pure: open, verify, and close lifecycle with fake clock and store", async () => {
  let currentNow = 1_000_000;
  const backingStore = new Map();
  const sessions = createSettingsSessions({
    now: () => currentNow,
    store: backingStore,
    ttlMs: 10 * 60 * 1000,
    maxSessions: 8,
    allowedRoutes: {
      "provider.summary": ["providers"],
      "mcp.servers.global-redacted": ["mcp-servers"],
    },
  });

  assert(
    DEFAULT_SETTINGS_SESSION_TTL_MS <= 15 * 60 * 1000 &&
      MAX_SETTINGS_SESSION_TTL_MS <= 15 * 60 * 1000,
    "default and maximum settings session TTL must be <= 15 minutes",
  );

  const minted = await sessions.open({
    documentId: "doc-hub-alpha",
    scopes: ["providers", "unlisted-scope"],
    tabId: 42,
  });
  assertEquals(minted.ok, true);
  assert(typeof minted.token === "string" && minted.token.length >= 16);
  assertEquals(minted.documentId, "doc-hub-alpha");
  assertEquals([...minted.scopes], ["providers"]);
  assertEquals(minted.expiresAt, 1_000_000 + 10 * 60 * 1000);

  const verified = await sessions.verify({
    token: minted.token,
    documentId: "doc-hub-alpha",
    route: "provider.summary",
  });
  assertEquals(verified.ok, true);
  assertEquals(verified.session.documentId, "doc-hub-alpha");
  assertEquals([...verified.session.scopes], ["providers"]);
  assertEquals(verified.session.expiresAt, minted.expiresAt);
  assert(isRouteWithinSettingsSession(verified.session, "provider.summary"));
  assertFalse(isRouteWithinSettingsSession(verified.session, "mcp.servers.global-redacted"));

  // Replay after close({ documentId }) is refused
  const closed = await sessions.close({ documentId: "doc-hub-alpha" });
  assertEquals(closed.ok, true);
  assertEquals(closed.closed, true);

  const afterClose = await sessions.verify({
    token: minted.token,
    documentId: "doc-hub-alpha",
    route: "provider.summary",
  });
  assertEquals(afterClose.ok, false);
  assertEquals(afterClose.reason, "unknown-token");
});

Deno.test("settings-session pure (m1): verify and requireSettingsSession refuse wrong documentId", async () => {
  const currentNow = 2_000_000;
  const allowedRoutes = { "test.route": ["providers"] };
  const sessions = createSettingsSessions({
    now: () => currentNow,
    allowedRoutes,
  });

  const minted = await sessions.open({
    documentId: "doc-owner-1",
    scopes: ["providers"],
  });
  assertEquals(minted.ok, true);

  const wrongDoc = await sessions.verify({
    token: minted.token,
    documentId: "doc-impostor-2",
    route: "test.route",
  });
  assertEquals(wrongDoc.ok, false, "verify must refuse a token presented from another documentId (m1)");
  assertEquals(wrongDoc.reason, "document-mismatch");

  const rightDoc = await sessions.verify({
    token: minted.token,
    documentId: "doc-owner-1",
    route: "test.route",
  });
  assertEquals(rightDoc.ok, true);

  // Sibling guard must also enforce documentId equality
  assertThrows(
    () =>
      requireSettingsSession(
        {
          principal: "extension",
          documentId: "doc-impostor-2",
          settingsSession: rightDoc.session,
        },
        "test.route",
        { now: () => currentNow, allowedRoutes },
      ),
    Error,
    "Settings surface",
    "requireSettingsSession must reject mismatched documentId (m1)",
  );
});

Deno.test("settings-session pure (m2): verify and requireSettingsSession enforce exact expiry edge", async () => {
  let currentNow = 5_000_000;
  const ttlMs = 60_000;
  const allowedRoutes = { "test.route": ["providers"] };
  const sessions = createSettingsSessions({
    now: () => currentNow,
    ttlMs,
    allowedRoutes,
  });

  const minted = await sessions.open({
    documentId: "doc-exp-1",
    scopes: ["providers"],
  });
  assertEquals(minted.ok, true);
  assertEquals(minted.expiresAt, 5_060_000);

  // 1 ms before expiry: valid
  currentNow = 5_059_999;
  const beforeExpiry = await sessions.verify({
    token: minted.token,
    documentId: "doc-exp-1",
    route: "test.route",
  });
  assertEquals(beforeExpiry.ok, true, "session must be valid 1ms before expiresAt");
  assertEquals(
    requireSettingsSession(
      { principal: "extension", documentId: "doc-exp-1", settingsSession: beforeExpiry.session },
      "test.route",
      { now: () => currentNow, allowedRoutes },
    ),
    undefined,
  );
  assertEquals(
    requireSettingsSurface(
      { principal: "owner-options", documentId: "doc-options" },
      "test.route",
      { now: () => currentNow, allowedRoutes },
    ),
    undefined,
  );

  // Exact expiry timestamp: expired (m2)
  currentNow = 5_060_000;
  assertThrows(
    () =>
      requireSettingsSession(
        { principal: "extension", documentId: "doc-exp-1", settingsSession: beforeExpiry.session },
        "test.route",
        { now: () => currentNow, allowedRoutes },
      ),
    Error,
    "Settings surface",
    "requireSettingsSession must reject at exact expiresAt (m2)",
  );

  const atExpiry = await sessions.verify({
    token: minted.token,
    documentId: "doc-exp-1",
    route: "test.route",
  });
  assertEquals(atExpiry.ok, false, "verify must reject at exact expiresAt (m2)");
  assertEquals(atExpiry.reason, "expired");
});

Deno.test("settings-session pure (m3): scope intersection on open and route-scope enforcement on verify/guard", async () => {
  const currentNow = 3_000_000;
  const allowedRoutes = {
    "route.providers": ["providers"],
    "route.mcp": ["mcp-servers"],
  };
  const sessions = createSettingsSessions({
    now: () => currentNow,
    allowedRoutes,
  });

  // Disjoint requested scopes -> mints nothing
  const emptyMint = await sessions.open({
    documentId: "doc-scope-1",
    scopes: ["nonexistent-panel", ""],
  });
  assertEquals(emptyMint.ok, false);
  assertEquals(emptyMint.reason, "empty-scope");

  // Mint with only "providers" scope
  const minted = await sessions.open({
    documentId: "doc-scope-1",
    scopes: ["providers", "unknown-scope"],
  });
  assertEquals(minted.ok, true);
  assertEquals([...minted.scopes], ["providers"]);

  // Verify against a route requiring "mcp-servers" scope -> refused (m3)
  const wrongScope = await sessions.verify({
    token: minted.token,
    documentId: "doc-scope-1",
    route: "route.mcp",
  });
  assertEquals(wrongScope.ok, false, "verify must reject a route outside the session's scopes (m3)");
  assertEquals(wrongScope.reason, "scope-mismatch");

  // Verify against permitted route -> ok, then check requireSettingsSession against unpermitted route
  const okVerify = await sessions.verify({
    token: minted.token,
    documentId: "doc-scope-1",
    route: "route.providers",
  });
  assertEquals(okVerify.ok, true);

  assertThrows(
    () =>
      requireSettingsSession(
        { principal: "extension", documentId: "doc-scope-1", settingsSession: okVerify.session },
        "route.mcp",
        { now: () => currentNow, allowedRoutes },
      ),
    Error,
    "Settings surface",
    "requireSettingsSession must reject a route not covered by session scopes (m3)",
  );
});

Deno.test("settings-session pure: oldest-first eviction (maxSessions) and restore across simulated SW restart", async () => {
  let currentNow = 4_000_000;
  const sharedStore = new Map();
  const allowedRoutes = { "route.providers": ["providers"] };

  const firstWorker = createSettingsSessions({
    now: () => currentNow,
    store: sharedStore,
    maxSessions: 2,
    allowedRoutes,
  });

  const s1 = await firstWorker.open({ documentId: "doc-1", scopes: ["providers"], tabId: 10 });
  currentNow += 100;
  const s2 = await firstWorker.open({ documentId: "doc-2", scopes: ["providers"], tabId: 20 });
  currentNow += 100;
  const s3 = await firstWorker.open({ documentId: "doc-3", scopes: ["providers"], tabId: 30 });
  assertEquals(s1.ok && s2.ok && s3.ok, true);

  // s1 was evicted when s3 was opened (maxSessions = 2)
  const evictedVerify = await firstWorker.verify({
    token: s1.token,
    documentId: "doc-1",
    route: "route.providers",
  });
  assertEquals(evictedVerify.ok, false);
  assertEquals(evictedVerify.reason, "unknown-token");

  // Simulate SW restart: create a new session manager backed by the same sharedStore
  const restartedWorker = createSettingsSessions({
    now: () => currentNow,
    store: sharedStore,
    maxSessions: 2,
    allowedRoutes,
  });

  const restoredS2 = await restartedWorker.verify({
    token: s2.token,
    documentId: "doc-2",
    route: "route.providers",
  });
  assertEquals(restoredS2.ok, true, "session s2 must survive SW restart via storage.session store");

  const restoredS3 = await restartedWorker.verify({
    token: s3.token,
    documentId: "doc-3",
    route: "route.providers",
  });
  assertEquals(restoredS3.ok, true, "session s3 must survive SW restart via storage.session store");

  // Closing by tabId revokes s2 and persists to store
  const closedByTab = await restartedWorker.close({ tabId: 20 });
  assertEquals(closedByTab.ok, true);
  assertEquals(closedByTab.closed, true);

  const afterTabClose = await restartedWorker.verify({
    token: s2.token,
    documentId: "doc-2",
    route: "route.providers",
  });
  assertEquals(afterTabClose.ok, false);
  assertEquals(afterTabClose.reason, "unknown-token");
});

// ── Acceptance 2 & Mutants (m4)–(m8): Sender predicates & SW listener tests ──

Deno.test("settings-session sender predicates (m4, m5): hub top-frame accepted; subframe, content script, options, sidepanel, query, wrong extId, missing documentId refused", async () => {
  const validHubTopSender = {
    id: EXT_ID,
    url: HUB_URL,
    frameId: 0,
    documentId: "doc-hub-top-1",
    documentLifecycle: "active",
    tab: { id: 1, url: HUB_URL },
  };

  // 1. Hub top frame accepted (plain + hash fragments)
  const topPlain = validateSettingsSessionMintSender(validHubTopSender, {
    extensionId: EXT_ID,
    hubUrl: HUB_URL,
    canonicalOrigin,
  });
  assertEquals(topPlain.ok, true);
  assertEquals(topPlain.documentId, "doc-hub-top-1");

  const topHash = validateSettingsSessionMintSender(
    { ...validHubTopSender, url: `${HUB_URL}#view=options%2Foptions.html` },
    { extensionId: EXT_ID, hubUrl: HUB_URL, canonicalOrigin },
  );
  assertEquals(topHash.ok, true);

  // 2. Hub SUBFRAME refused (m4)
  const subframeSender = { ...validHubTopSender, frameId: 1, documentId: "doc-hub-subframe" };
  const subframeCheck = validateSettingsSessionMintSender(subframeSender, {
    extensionId: EXT_ID,
    hubUrl: HUB_URL,
    canonicalOrigin,
  });
  assertEquals(subframeCheck.ok, false, "hub subframe must be refused (m4)");
  assertEquals(subframeCheck.reason, "subframe-not-allowed");

  const liveSubframeResp = await dispatchLiveSw(
    { type: "settings.session.open", scopes: ["providers"] },
    subframeSender,
  );
  assertEquals(liveSubframeResp.ok, false, "live SW settings.session.open must refuse a hub subframe (m4)");
  assertEquals(liveSubframeResp.reason, "subframe-not-allowed");

  // 3. Content script refused (m5) — both web-tab spoofed hub URL and normal page URL
  const webTabSpoofSender = {
    id: EXT_ID,
    url: HUB_URL,
    frameId: 0,
    documentId: "doc-cs-2",
    documentLifecycle: "active",
    tab: { id: 99, url: "https://attacker.example/index.html" },
  };
  const webTabCheck = validateSettingsSessionMintSender(webTabSpoofSender, {
    extensionId: EXT_ID,
    hubUrl: HUB_URL,
    canonicalOrigin,
  });
  assertEquals(webTabCheck.ok, false, "sender hosted in a web tab must be refused as content-script (m5)");
  assertEquals(webTabCheck.reason, "content-script");

  const contentScriptSender = {
    id: EXT_ID,
    url: "https://attacker.example/index.html",
    frameId: 0,
    documentId: "doc-cs-1",
    documentLifecycle: "active",
    tab: { id: 99, url: "https://attacker.example/index.html" },
  };
  const csCheck = validateSettingsSessionMintSender(contentScriptSender, {
    extensionId: EXT_ID,
    hubUrl: HUB_URL,
    canonicalOrigin,
  });
  assertEquals(csCheck.ok, false, "content script sender must be refused by validateSettingsSessionMintSender (m5)");
  assertEquals(csCheck.reason, "content-script");

  const liveCsResp = await dispatchLiveSw(
    { type: "settings.session.open", scopes: ["providers"] },
    contentScriptSender,
  );
  assertEquals(liveCsResp.ok, false, "live SW must refuse settings.session.open from a content script (m5)");

  // 4. Options page and side panel refused
  const optionsSender = { ...validHubTopSender, url: OPTIONS_URL, documentId: "doc-options-1" };
  const optionsResp = await dispatchLiveSw(
    { type: "settings.session.open", scopes: ["providers"] },
    optionsSender,
  );
  assertEquals(optionsResp.ok, false, "options page must not mint a hub settings session");
  assertEquals(optionsResp.reason, "wrong-sender-url");

  const sidepanelSender = { ...validHubTopSender, url: SIDEPANEL_URL, documentId: "doc-sidepanel-1" };
  const sidepanelResp = await dispatchLiveSw(
    { type: "settings.session.open", scopes: ["providers"] },
    sidepanelSender,
  );
  assertEquals(sidepanelResp.ok, false, "side panel must not mint a hub settings session");
  assertEquals(sidepanelResp.reason, "wrong-sender-url");

  // 5. Query string on hub URL refused
  const querySender = { ...validHubTopSender, url: `${HUB_URL}?embedded=1` };
  const queryResp = await dispatchLiveSw(
    { type: "settings.session.open", scopes: ["providers"] },
    querySender,
  );
  assertEquals(queryResp.ok, false, "hub URL with query string must be refused");
  assertEquals(queryResp.reason, "query-not-allowed");

  // 6. Wrong extension ID refused
  const wrongExtCheck = validateSettingsSessionMintSender(
    { ...validHubTopSender, id: "foreign-extension-id" },
    { extensionId: EXT_ID, hubUrl: HUB_URL, canonicalOrigin },
  );
  assertEquals(wrongExtCheck.ok, false);
  assertEquals(wrongExtCheck.reason, "wrong-extension-id");

  // 7. Missing documentId refused
  const noDocResp = await dispatchLiveSw(
    { type: "settings.session.open", scopes: ["providers"] },
    { ...validHubTopSender, documentId: "" },
  );
  assertEquals(noDocResp.ok, false, "mint without documentId must be refused");
  assertEquals(noDocResp.reason, "missing-document-id");
});

Deno.test("settings-session SW listener (m1, m2, m3, m6, m7, m8): valid session keeps principal 'extension', never upgrades to 'owner-options', scrubs __settingsSession, and never leaks token in logs/errors/responses", async () => {
  let currentNow = 10_000_000;
  const SECRET_TOKEN = "sess-val-889900-never-log";
  const harness = createExtractedSwHarness({
    now: () => currentNow,
    tokenFactory: () => SECRET_TOKEN,
    allowedRoutes: {
      "test.settings.panel": ["providers"],
      "test.settings.mcp": ["mcp-servers"],
    },
  });

  const hubSenderA = {
    id: EXT_ID,
    url: HUB_URL,
    frameId: 0,
    documentId: "doc-hub-A",
    documentLifecycle: "active",
    tab: { id: 10, url: HUB_URL },
  };
  const hubSenderB = {
    id: EXT_ID,
    url: HUB_URL,
    frameId: 0,
    documentId: "doc-hub-B",
    documentLifecycle: "active",
    tab: { id: 11, url: HUB_URL },
  };

  // Mint session for doc-hub-A with scope ["providers"]
  const openRes = await harness.send(
    { type: "settings.session.open", scopes: ["providers"] },
    hubSenderA,
  );
  assertEquals(openRes.ok, true, "hub top-frame sender must mint session when scope is in allowlist");
  assertEquals(openRes.token, SECRET_TOKEN);

  // Valid call with __settingsSession from doc-hub-A
  const validCall = await harness.send(
    {
      type: "test.settings.panel",
      __settingsSession: SECRET_TOKEN,
      payload: "hello",
    },
    hubSenderA,
  );
  assertEquals(validCall.ok, true);
  // (m6) Principal MUST remain "extension" — never upgraded to "owner-options"
  assertEquals(
    validCall.principal,
    "extension",
    "a valid settings session must KEEP principal === 'extension' and never upgrade to 'owner-options' (m6)",
  );
  assertEquals(validCall.hasSettingsSession, true);
  assertEquals(
    validCall.strictSettingsRejected,
    true,
    "requireSettingsSender must still reject a session-authenticated hub caller (m6)",
  );
  assertEquals(
    validCall.mayResolveOwnerOptionsApproval,
    false,
    "mayResolveApproval for an owner-options approval must remain false for a session-authenticated hub caller (m6)",
  );
  // (m8) __settingsSession must be scrubbed before handler sees body
  assertFalse(
    validCall.receivedBodyKeys.includes("__settingsSession"),
    "dispatchRoute must scrub __settingsSession from the handler message body (m8)",
  );
  assertEquals(harness.observedCalls.length, 1);
  assertEquals(
    Object.prototype.hasOwnProperty.call(harness.observedCalls[0].body, "__settingsSession"),
    false,
    "handler safeBody must not contain __settingsSession (m8)",
  );
  assertEquals(harness.observedCalls[0].context.principal, "extension");
  assertEquals(harness.observedCalls[0].context.settingsSession?.documentId, "doc-hub-A");

  // (m1) Replay from another documentId (doc-hub-B) -> refused, principal stays "extension", no settingsSession attached
  const wrongDocCall = await harness.send(
    {
      type: "test.settings.panel",
      __settingsSession: SECRET_TOKEN,
    },
    hubSenderB,
  );
  assertEquals(
    wrongDocCall.ok,
    false,
    "session token replayed from another documentId must be refused (m1)",
  );
  assertEquals(
    harness.observedCalls.at(-1)?.context.settingsSession,
    undefined,
    "listener must not attach settingsSession when documentId mismatches (m1)",
  );

  // (m3) Wrong-scope route ("test.settings.mcp") with "providers"-scoped token -> refused
  const wrongScopeCall = await harness.send(
    {
      type: "test.settings.mcp",
      __settingsSession: SECRET_TOKEN,
    },
    hubSenderA,
  );
  assertEquals(
    wrongScopeCall.ok,
    false,
    "session token used on a route outside its granted scopes must be refused (m3)",
  );
  assertEquals(
    harness.observedCalls.at(-1)?.context.settingsSession,
    undefined,
    "listener must not attach settingsSession when route is outside session scopes (m3)",
  );

  // (m2) Advance clock to expiry -> refused
  currentNow += DEFAULT_SETTINGS_SESSION_TTL_MS;
  const expiredCall = await harness.send(
    {
      type: "test.settings.panel",
      __settingsSession: SECRET_TOKEN,
    },
    hubSenderA,
  );
  assertEquals(
    expiredCall.ok,
    false,
    "expired session token must be refused (m2)",
  );
  assertEquals(
    harness.observedCalls.at(-1)?.context.settingsSession,
    undefined,
    "listener must not attach settingsSession when session is expired (m2)",
  );

  // Re-mint and explicitly close -> refused
  const remint = await harness.send(
    { type: "settings.session.open", scopes: ["providers"] },
    hubSenderA,
  );
  assertEquals(remint.ok, true);
  const closeRes = await harness.send({ type: "settings.session.close" }, hubSenderA);
  assertEquals(closeRes.ok, true);
  assertEquals(closeRes.closed, true);

  const afterCloseCall = await harness.send(
    {
      type: "test.settings.panel",
      __settingsSession: SECRET_TOKEN,
    },
    hubSenderA,
  );
  assertEquals(afterCloseCall.ok, false, "revoked session token must be refused after close");
  assertEquals(
    harness.observedCalls.at(-1)?.context.settingsSession,
    undefined,
    "listener must not attach settingsSession after close",
  );

  // (m7) Verify token NEVER appeared in any securityEvent, error string, or failure response
  assert(harness.securityEvents.length >= 3, "failed verifications must record blocked-action securityEvents");
  for (const ev of harness.securityEvents) {
    assertFalse(
      ev.detail.includes(SECRET_TOKEN),
      `securityEvent must NEVER contain the session token (m7); got: ${ev.detail}`,
    );
  }
  for (const failureResp of [wrongDocCall, wrongScopeCall, expiredCall, afterCloseCall]) {
    const serialized = JSON.stringify(failureResp);
    assertFalse(
      serialized.includes(SECRET_TOKEN),
      `error response must NEVER contain the session token (m7); got: ${serialized}`,
    );
  }
});

Deno.test("settings-session live SW (m7, m8): real service-worker.js scrubs __settingsSession in dispatchRoute and never leaks token in security.state", async () => {
  await dispatchLiveSw({ type: "security.clear" }, {
    url: OPTIONS_URL,
    documentId: "doc-options-clear",
    frameId: 0,
  });
  forwardedRuntimeMessages.length = 0;

  const LIVE_SECRET_TOKEN = "live-sess-val-778899";
  const hubSender = {
    url: HUB_URL,
    frameId: 0,
    documentId: "doc-hub-live-1",
    documentLifecycle: "active",
    tab: { id: 5, url: HUB_URL },
  };

  // Send a message carrying __settingsSession through the REAL service-worker.js listener
  // to a route ("onDeviceText.availability") that forwards its received `message` body via
  // chrome.runtime.sendMessage({ type, ...message }).
  const res = await dispatchLiveSw(
    {
      type: "onDeviceText.availability",
      __settingsSession: LIVE_SECRET_TOKEN,
      probeId: "probe-1",
    },
    hubSender,
  );
  assertEquals(res.ok, true);
  assertEquals(forwardedRuntimeMessages.length, 1, "onDeviceText.availability must forward its body");
  assertEquals(
    Object.prototype.hasOwnProperty.call(forwardedRuntimeMessages[0], "__settingsSession"),
    false,
    "live service-worker.js dispatchRoute must scrub __settingsSession before the handler runs (m8)",
  );
  assertEquals(forwardedRuntimeMessages[0].probeId, "probe-1");

  // Inspect live security.state to prove the invalid token recorded a blocked-action event
  // WITHOUT leaking LIVE_SECRET_TOKEN (m7).
  const secState = await dispatchLiveSw({ type: "security.state" }, hubSender);
  const serializedState = JSON.stringify(secState);
  assert(
    Array.isArray(secState.violations) && secState.violations.length >= 1,
    "failed settingsSession verification on live SW must record a security violation",
  );
  assertFalse(
    serializedState.includes(LIVE_SECRET_TOKEN),
    `live security.state must NEVER contain the session token (m7); got: ${serializedState}`,
  );
});
