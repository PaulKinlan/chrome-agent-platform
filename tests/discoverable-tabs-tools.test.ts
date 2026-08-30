// deno-fmt-ignore-file
// tests/discoverable-tabs-tools.test.ts — ROUTE-LEVEL (real SW dispatcher)
// coverage for passive WebMCP detection: every picker surface lists only open
// pages whose sender-attested origin has reported at least one site tool.
// @ts-nocheck — dynamic chrome/OPFS stubs (no types in Deno).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  pruneWebmcpRegistry,
  WEBMCP_REGISTRY_MAX,
  WEBMCP_REGISTRY_STALE_MS,
} from "../extension/lib/webmcp-detection-registry.js";

// ---- minimal in-memory OPFS fake (siteMemory lives under memory/site-*) ----
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; }
  async write(s) { this.parts.push(String(s)); }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() {
    const n = this.node;
    return { size: (n.content ?? "").length, async text() { return n.content ?? ""; } };
  }
  async createWritable() { return new FakeWritable(this.node); }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw notFound(name);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw notFound(name);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async *entries() {
    for (const [name, child] of this.node.children) {
      yield [name, child.kind === "directory" ? new FakeDirHandle(child) : new FakeFileHandle(child)];
    }
  }
  async removeEntry(name) { this.node.children.delete(name); }
}
const notFound = (name) => Object.assign(new Error(`not found: ${name}`), { name: "NotFoundError" });
const root = dirNode();
Object.defineProperty(globalThis.navigator, "storage", {
  value: { async getDirectory() { return new FakeDirHandle(root); } },
  configurable: true,
});

Deno.test("known-WebMCP registry is LRU-bounded and drops stale/zero signals", () => {
  const now = 2_000_000_000_000;
  const raw = Array.from({ length: WEBMCP_REGISTRY_MAX + 5 }, (_, i) => ({
    origin: `https://site-${i}.example`,
    documents: [{
      tabId: i,
      documentId: `doc-${i}`,
      url: `https://site-${i}.example/tools`,
      toolCount: i === 0 ? 0 : 1,
      lastSeen: now - i,
    }],
  }));
  raw.push({
    origin: "https://stale.example",
    documents: [{
      tabId: 999,
      documentId: "doc-stale",
      url: "https://stale.example/tools",
      toolCount: 3,
      lastSeen: now - WEBMCP_REGISTRY_STALE_MS - 1,
    }],
  });
  const entries = pruneWebmcpRegistry(raw, now);
  assertEquals(entries.length, WEBMCP_REGISTRY_MAX);
  assertEquals(entries.some((entry) => entry.origin === "https://site-0.example"), false);
  assertEquals(entries.some((entry) => entry.origin === "https://stale.example"), false);
  assert(entries.every((entry, i) => i === 0 || entries[i - 1].lastSeen >= entry.lastSeen));
});

Deno.test("agent.discoverable-tabs ROUTE: only passively detected WebMCP origins are listed", async () => {
  const listeners = [];
  const noopListener = { addListener: () => {} };
  const localStore = new Map();
  const openTabs = [
    { id: 1, url: "https://same.example/tools", title: "Tools", active: true, lastAccessed: 100 },
    { id: 2, url: "https://same.example/plain", title: "Plain", active: false, lastAccessed: 200 },
  ];
  const frameDocuments = new Map([[1, "doc-1"], [2, "doc-2"]]);
  // Optional-permission state the route consults before reattestation.
  const grantedPermissions = new Set(["scripting"]);
  let executeScriptCalls = 0;
  const permissionsOnAdded = [];
  const tabMessages = [];
  globalThis.chrome = {
    runtime: {
      id: "test-extension-id",
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onConnect: noopListener,
      onInstalled: noopListener,
      sendMessage: async () => {},
    },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : [keys])) {
            if (localStore.has(k)) out[k] = structuredClone(localStore.get(k));
          }
          return out;
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) localStore.set(k, structuredClone(v));
        },
        remove: async (keys) => {
          for (const k of (Array.isArray(keys) ? keys : [keys])) localStore.delete(k);
        },
      },
      session: { get: async () => ({}), set: async () => {} },
    },
    permissions: {
      contains: async ({ permissions = [] } = {}) =>
        permissions.every((p) => grantedPermissions.has(p)),
      onAdded: { addListener: (fn) => permissionsOnAdded.push(fn) },
      onRemoved: noopListener,
    },
    alarms: { onAlarm: noopListener, create: () => {}, clear: async () => true, get: async () => null },
    tabs: {
      onCreated: noopListener, onActivated: noopListener, onUpdated: noopListener, onRemoved: noopListener,
      onAttached: noopListener, onZoomChange: noopListener,
      query: async () => structuredClone(openTabs),
      get: async (id) => structuredClone(openTabs.find((tab) => tab.id === id)),
      sendMessage: async (id, message) => { tabMessages.push([id, message]); },
      create: async () => ({ id: 1 }), update: async () => ({}), remove: async () => {},
    },
    windows: { onCreated: noopListener, onRemoved: noopListener, onFocusChanged: noopListener },
    scripting: {
      executeScript: async ({ target }) => {
        executeScriptCalls++;
        return [{ documentId: frameDocuments.get(target.tabId), frameId: 0, result: true }];
      },
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
    },
    offscreen: { closeDocument: async () => {}, getContexts: async () => [] },
    contextMenus: { onClicked: noopListener },
    notifications: {},
  };
  await import("../extension/background/service-worker.js");

  const ownerSender = {
    id: "test-extension-id",
    url: "chrome-extension://test-extension-id/options/options.html",
    documentId: "doc-options-1",
    documentLifecycle: "active",
  };
  const dispatch = (msg, sender = ownerSender) => new Promise((resolve) => {
    for (const fn of [...listeners]) { try { fn(msg, sender, resolve); } catch { /* another listener's throw */ } }
  });

  const contentSender = (id, url) => ({
    id: "test-extension-id",
    url,
    origin: new URL(url).origin,
    frameId: 0,
    documentId: `doc-${id}`,
    documentLifecycle: "active",
    tab: { id, url },
  });

  // A plain page reports zero and never becomes eligible.
  const plain = await dispatch(
    { type: "webmcp.detected", origin: "https://same.example", url: "https://same.example/plain", toolCount: 0 },
    contentSender(2, "https://same.example/plain"),
  );
  assertEquals(plain?.ok, true);
  let picker = await dispatch({ type: "agent.discoverable-tabs" });
  assertEquals(picker?.tabs?.length, 0, "zero-tool pages are excluded from the picker");

  // A positive report admits only its exact browser-attested tab/document.
  const detected = await dispatch(
    { type: "webmcp.detected", origin: "https://same.example", url: "https://same.example/tools", toolCount: 2 },
    contentSender(1, "https://same.example/tools"),
  );
  assertEquals(detected?.ok, true);

  picker = await dispatch({ type: "agent.discoverable-tabs" });
  assertEquals(picker?.ok !== false, true, "the route answers");
  assertEquals(picker.tabs?.length, 1, "only the reporting document is listed");
  assertEquals(picker.tabs?.[0]?.origin, "https://same.example");
  assertEquals(picker.tabs?.[0]?.id, 1, "the same-origin plain tab cannot borrow the tools report");
  assertEquals(picker.tabs?.[0]?.toolCount, 2, "the passive capability count rides along");

  const proactive = await dispatch({ type: "agent.discoverable-tabs", toolsOnly: true });
  assertEquals(proactive?.tabs, picker.tabs, "toolsOnly no longer changes picker eligibility");
  assert((picker.tabs ?? []).every((t) => t.id !== 2));

  // Never trust a payload that claims a different origin than Chrome's sender.
  const spoof = await dispatch(
    { type: "webmcp.detected", origin: "https://victim.example", url: "https://victim.example/", toolCount: 9 },
    contentSender(2, "https://same.example/plain"),
  );
  assertEquals(spoof?.ok, false);
  picker = await dispatch({ type: "agent.discoverable-tabs" });
  assertEquals(picker.tabs?.some((t) => t.origin === "https://victim.example"), false);

  // Browser-attested navigation changes the document identity immediately;
  // the old /tools report cannot keep the new /plain document listed.
  openTabs[0].url = "https://same.example/plain";
  frameDocuments.set(1, "doc-1-navigation");
  picker = await dispatch({ type: "agent.discoverable-tabs" });
  assertEquals(picker.tabs?.length, 0, "navigating the reporting tab removes its picker row");

  // A later zero snapshot removes the reporting tab's persisted document too.
  await dispatch(
    { type: "webmcp.detected", origin: "https://same.example", url: "https://same.example/plain", toolCount: 0 },
    contentSender(1, "https://same.example/plain"),
  );
  picker = await dispatch({ type: "agent.discoverable-tabs" });
  assertEquals(picker.tabs?.length, 0, "a zero snapshot keeps the stale capability removed");

  // Fresh-profile JIT precondition: without the optional `scripting`
  // permission the route must refuse HONESTLY (needScripting) instead of
  // silently dropping every detected tab behind a failed reattestation — the
  // deadlock where the picker could never open.
  openTabs[0].url = "https://same.example/tools";
  frameDocuments.set(1, "doc-1");
  await dispatch(
    { type: "webmcp.detected", origin: "https://same.example", url: "https://same.example/tools", toolCount: 2 },
    contentSender(1, "https://same.example/tools"),
  );
  grantedPermissions.delete("scripting");
  const callsBefore = executeScriptCalls;
  const refused = await dispatch({ type: "agent.discoverable-tabs" });
  assertEquals(refused?.ok, false, "no scripting grant → the route refuses");
  assertEquals(refused?.needScripting, true, "the refusal names the missing capability");
  assertEquals(executeScriptCalls, callsBefore, "no reattestation runs without the scripting grant");

  // The gesture-time grant (hub requests scripting JIT) unblocks the listing.
  grantedPermissions.add("scripting");
  picker = await dispatch({ type: "agent.discoverable-tabs" });
  assertEquals(picker?.tabs?.length, 1, "granting scripting restores the detected tab's picker row");
  assertEquals(picker.tabs?.[0]?.id, 1);

  // The JIT grant must RE-ARM the passive detectors in already-open pages:
  // their relays bootstrapped a nonce, but the MAIN-world arm needs
  // chrome.scripting, which was absent at page load. The SW listens for the
  // scripting grant and nudges every open tab to retry — otherwise pages open
  // before the grant stay invisible to the picker until a reload.
  assert(permissionsOnAdded.length > 0, "the SW listens for permission grants");
  tabMessages.length = 0;
  for (const fn of permissionsOnAdded) fn({ permissions: ["bookmarks"] });
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(tabMessages.length, 0, "an unrelated grant triggers no detector re-arm");
  for (const fn of permissionsOnAdded) fn({ permissions: ["scripting"] });
  await new Promise((r) => setTimeout(r, 50));
  const rearmTabs = tabMessages.filter(([, m]) => m?.type === "webmcp.detect.rearm").map(([id]) => id);
  assertEquals(rearmTabs.sort(), [1, 2], "a scripting grant nudges every open tab to re-arm its detector");
});
