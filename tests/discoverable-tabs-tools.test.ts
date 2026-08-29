// deno-fmt-ignore-file
// tests/discoverable-tabs-tools.test.ts — ROUTE-LEVEL (real SW dispatcher)
// coverage for both discovery modes: the explicit picker includes un-enrolled
// pages so they can be injected, while proactive discovery excludes origins
// that have not reported any tools.
// @ts-nocheck — dynamic chrome/OPFS stubs (no types in Deno).
import { assert, assertEquals } from "jsr:@std/assert@1";

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

Deno.test("agent.discoverable-tabs ROUTE: picker includes unknown pages while proactive mode requires tools", async () => {
  const listeners = [];
  const noopListener = { addListener: () => {} };
  const localStore = new Map();
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
    permissions: { contains: async () => true, onAdded: noopListener, onRemoved: noopListener },
    alarms: { onAlarm: noopListener, create: () => {}, clear: async () => true, get: async () => null },
    tabs: {
      onCreated: noopListener, onActivated: noopListener, onUpdated: noopListener, onRemoved: noopListener,
      onAttached: noopListener, onZoomChange: noopListener,
      query: async () => [
        { id: 1, url: "https://tooled.example/page", title: "Tooled", active: true, lastAccessed: 100 },
        { id: 2, url: "https://plain.example/page", title: "Plain", active: false, lastAccessed: 200 },
      ],
      sendMessage: async () => {}, create: async () => ({ id: 1 }), update: async () => ({}), remove: async () => {},
    },
    windows: { onCreated: noopListener, onRemoved: noopListener, onFocusChanged: noopListener },
    scripting: { executeScript: async () => [], getRegisteredContentScripts: async () => [], registerContentScripts: async () => {} },
    offscreen: { closeDocument: async () => {}, getContexts: async () => [] },
    contextMenus: { onClicked: noopListener },
    webNavigation: {},
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

  // Register TWO real WebMCP tools for tooled.example through the REAL tools
  // lib (same registry the route reads via listTools); plain.example gets none.
  const { upsertTools } = await import("../extension/lib/tools.js");
  await upsertTools("https://tooled.example", [
    { name: "search", description: "Search the site" },
    { name: "add_to_cart", description: "Add an item to the cart" },
  ]);

  const picker = await dispatch({ type: "agent.discoverable-tabs" });
  assertEquals(picker?.ok !== false, true, "the route answers");
  assertEquals(picker.tabs?.length, 2, "the picker includes pages before their tools can be injected");
  assertEquals(picker.tabs?.find((t) => t.origin === "https://plain.example")?.toolCount, 0);

  const proactive = await dispatch({ type: "agent.discoverable-tabs", toolsOnly: true });
  const tabs = proactive?.tabs ?? [];
  assertEquals(tabs.length, 1, "proactive discovery excludes zero-tool pages");
  assertEquals(tabs[0]?.origin, "https://tooled.example");
  assertEquals(tabs[0]?.toolCount, 2, "the registered-tool count rides along");
  assert(tabs.every((t) => t.origin !== "https://plain.example"));
});
