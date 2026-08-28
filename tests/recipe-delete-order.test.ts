// tests/recipe-delete-order.test.ts — ROUTE-LEVEL (real SW dispatcher) test for
// the REVISE-5 P1: `recipe.delete` used to persist the customRecipes REMOVAL
// BEFORE awaiting the schedule teardown's durable mark, so a marking failure
// returned an honest {ok:false} while the recipe was ALREADY gone. The contract
// under test: a marking failure removes NOTHING — the recipe remains and the
// owner can retry; the removal only persists once the teardown is durably
// underway (marked resolved).
// @ts-nocheck — dynamic chrome/OPFS stubs (no types in Deno).
import { assert, assertEquals } from "jsr:@std/assert@1";

// ---- minimal in-memory OPFS fake (masterMemory lives under memory/master) ----
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
  // memory.js walks directories with dir.entries() — yield [name, handle].
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

Deno.test("recipe.delete ROUTE: a teardown marking failure keeps the recipe (honest {ok:false}, retryable); success removes it", async () => {
  const listeners = [];
  const noopListener = { addListener: () => {} };
  // chrome.storage.local backed by a Map; `failTaskWrites` simulates the
  // durable-mark write failing (kvSet fails closed → cancelScheduledTask
  // Background's `marked` rejects) WITHOUT touching the recipe's own store.
  const localStore = new Map();
  let failTaskWrites = false;
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
          if (failTaskWrites && Object.hasOwn(obj, "cap:scheduledTasks")) {
            throw new Error("simulated durable-mark write failure");
          }
          for (const [k, v] of Object.entries(obj)) localStore.set(k, structuredClone(v));
        },
        remove: async (keys) => {
          for (const k of (Array.isArray(keys) ? keys : [keys])) localStore.delete(k);
        },
      },
      session: { get: async () => ({}), set: async () => {} },
    },
    // "storage" granted so kvSet takes the DURABLE chrome.storage.local path
    // (where the simulated marking failure fires) instead of the session
    // fallback that would bypass the injection entirely.
    permissions: { contains: async (req) => Array.isArray(req?.permissions) && req.permissions.includes("storage"), onAdded: noopListener, onRemoved: noopListener },
    alarms: { onAlarm: noopListener, create: () => {}, clear: () => {} },
    tabs: { onCreated: noopListener, onActivated: noopListener, onUpdated: noopListener, onRemoved: noopListener, onAttached: noopListener, onZoomChange: noopListener, query: async () => [], sendMessage: async () => {}, create: async () => ({ id: 1 }), update: async () => ({}), remove: async () => {} },
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

  // 1. Duplicate a built-in recipe → a custom editable instance in masterMemory.
  const dup = await dispatch({ type: "recipe.duplicate", id: "tab-hygiene" });
  assertEquals(dup?.ok, true, "duplicate succeeds");
  const customId = dup?.recipe?.id;
  assert(typeof customId === "string" && customId, "a custom recipe id exists");

  // 2. Give it a live schedule payload (so the teardown has something to mark).
  const seeded = await dispatch({ type: "kv.set", values: {
    "cap:scheduledTasks": { [`recipe:${customId}`]: { name: `recipe:${customId}`, task: { prompt: "tick" }, at: Date.now() + 60_000 } },
  } });
  assert(seeded !== undefined, "schedule payload seeded");

  // 3. FAIL the durable marking write → recipe.delete must be honest AND keep
  //    the recipe (REVISE-5 P1: the removal must not precede the durable mark).
  failTaskWrites = true;
  const failed = await dispatch({ type: "recipe.delete", id: customId });
  assertEquals(failed?.ok, false, "the route reports the failure honestly");
  assert(
    String(failed?.error ?? "").includes("teardown was durable"),
    `the error names the durable-mark failure (got: ${failed?.error})`,
  );
  const afterFailure = await dispatch({ type: "recipe.custom-list" });
  const stillThere = (afterFailure?.recipes ?? []).some((r) => r.id === customId);
  assertEquals(stillThere, true, "the recipe REMAINS after a marking failure (retryable)");

  // 4. With the storage failure gone, the SAME delete succeeds and removes it.
  failTaskWrites = false;
  const retried = await dispatch({ type: "recipe.delete", id: customId });
  assertEquals(retried?.ok, true, "the retry deletes once the teardown is durable");
  const afterSuccess = await dispatch({ type: "recipe.custom-list" });
  assertEquals(
    (afterSuccess?.recipes ?? []).some((r) => r.id === customId),
    false,
    "the successful delete removes the recipe",
  );
});
