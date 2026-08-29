// tests/orphan-cleanup-fail-closed.test.ts — ROUTE-LEVEL (real SW dispatcher)
// test for the review P1-a: schedule.cancelOrphans used to convert a
// getCustomRecipes() failure into [] → every custom recipe's schedule was
// classified orphaned and CANCELLED (fail OPEN on the destructive path), and
// a thrown cancel (caught to null) was counted as success.
// Contract: an unreadable registry refuses to cancel ANYTHING; only a
// confirmed {ok:true, cancelled:true} result is reported as cancelled.
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
// failMasterReads simulates a registry-read failure (OPFS error) — the moment
// the custom-recipe registry cannot be read, a live custom recipe is
// INDISTINGUISHABLE from an orphan.
let failMasterReads = false;
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
    if (failMasterReads) throw new Error("simulated OPFS read failure");
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

Deno.test("schedule.cancelOrphans ROUTE: an unreadable recipe registry refuses to cancel anything (fail closed); a healthy registry cancels only true orphans", async () => {
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
    alarms: {
      onAlarm: noopListener,
      create: () => {},
      clear: async () => true,
      get: async () => null, // confirm-absent: the alarm is gone after clear
    },
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

  // 1. Seed one LIVE custom recipe + two schedules: its own (must survive) and
  //    one whose recipe id matches nothing (a true orphan).
  const { masterMemory } = await import("../extension/lib/memory.js");
  await masterMemory().set("customRecipes", [{ id: "keepme", name: "Keep Me", mode: "background" }]);
  const seeded = await dispatch({ type: "kv.set", values: {
    "cap:scheduledTasks": {
      "recipe:keepme": { name: "recipe:keepme", task: { prompt: "tick" }, at: Date.now() + 60_000 },
      "recipe:ghost": { name: "recipe:ghost", task: { prompt: "tick" }, at: Date.now() + 60_000 },
      "recipe:ghost2": { name: "recipe:ghost2", task: { prompt: "tick" }, at: Date.now() + 60_000 },
    },
  } });
  assertEquals(seeded?.ok, true, "the schedule store seeded");

  // 2. Healthy registry: only the true orphans are cancelled, each CONFIRMED.
  const clean = await dispatch({ type: "schedule.cancelOrphans" });
  assertEquals(clean?.ok, true);
  assertEquals([...(clean?.cancelled ?? [])].sort(), ["recipe:ghost", "recipe:ghost2"],
    "only schedules whose recipe exists nowhere are cancelled");
  const afterClean = await dispatch({ type: "kv.get", keys: ["cap:scheduledTasks"] });
  const remaining = Object.keys(afterClean?.["cap:scheduledTasks"] ?? {});
  assertEquals(remaining, ["recipe:keepme"], "the live recipe's schedule survives");

  // 3. Registry-read failure: REFUSE — cancel nothing, report ok:false. The
  //    fail-open predecessor converted the failure to [] and would have
  //    cancelled the LIVE recipe:keepme schedule here.
  await dispatch({ type: "kv.set", values: {
    "cap:scheduledTasks": {
      "recipe:keepme": { name: "recipe:keepme", task: { prompt: "tick" }, at: Date.now() + 60_000 },
      "recipe:ghost3": { name: "recipe:ghost3", task: { prompt: "tick" }, at: Date.now() + 60_000 },
    },
  } });
  failMasterReads = true;
  const refused = await dispatch({ type: "schedule.cancelOrphans" });
  failMasterReads = false;
  assertEquals(refused?.ok, false, "an unreadable registry is an honest refusal, never a cleanup");
  assertEquals(refused?.count, 0);
  assert(String(refused?.error ?? "").length > 0, "the refusal carries a reason");
  const afterRefusal = await dispatch({ type: "kv.get", keys: ["cap:scheduledTasks"] });
  const survived = Object.keys(afterRefusal?.["cap:scheduledTasks"] ?? {}).sort();
  assertEquals(survived, ["recipe:ghost3", "recipe:keepme"],
    "NOTHING was cancelled while the registry was unreadable — the live recipe's schedule survives");
});
