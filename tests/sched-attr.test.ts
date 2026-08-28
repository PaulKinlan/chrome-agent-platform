// @ts-nocheck
// CAP-FB-20260826 scheduled-run attribution — KATs for the owner report:
// "scheduled tasks via alarms don't appear in the Agents task/conversation".
//
// Root cause: a scheduled fire passed NO threadId/agentRole/agentSurfaceRef
// into runTask, so the durable run record got threadId:null / agentId:null and
// never linked into any agent/thread surface; AND schedule_task never recorded
// the scheduling run's identity in the payload, so the context never survived
// to fire time.
//
// These tests drive the REAL code at every layer:
//  (1) run-context module — set/current/clear + bounding;
//  (2) scheduler.scheduleTask — persists the bounded owner; retry preserves it;
//  (3) the REAL schedule_task tool execute — reads the active run context into
//      the persisted payload;
//  (4) SW-BOOT end-to-end — fire the REAL handleAlarm with an owner payload:
//      the durable run record carries threadId/agentId, the thread's
//      listThreadExecutions links it, thread.get projects its tool cards, and
//      run.logs returns its rows; an interactive agent.run is unaffected.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { freshScheduler } from "./test-hooks.js";

// ────────────────────────────────────────────────────────────────────────────
// Part 1 — run-context module (fresh import; no chrome needed)
// ────────────────────────────────────────────────────────────────────────────
Deno.test("run-context: set/current/clear round-trips a bounded copy; absent fields normalize", async () => {
  const ctx = await import(`../extension/lib/run-context.js?rc=${Date.now()}`);
  assertEquals(ctx.currentRunContext(), null, "no active run → null");
  ctx.setRunContext({ threadId: " t1 ", agentRole: "hub", agentSurfaceRef: null });
  const got = ctx.currentRunContext();
  assertEquals(got, { threadId: "t1", agentRole: "hub", agentSurfaceRef: null });
  got.threadId = "MUTATED";
  assertEquals(ctx.currentRunContext().threadId, "t1", "callers get a copy — the shared context cannot be mutated");
  ctx.setRunContext({ threadId: "x".repeat(500), agentRole: 42, agentSurfaceRef: "  " });
  const bounded = ctx.currentRunContext();
  assertEquals(bounded.threadId.length, 200, "threadId bounded to 200");
  assertEquals(bounded.agentRole, "", "non-string agentRole normalizes to ''");
  assertEquals(bounded.agentSurfaceRef, null, "blank agentSurfaceRef normalizes to null");
  ctx.clearRunContext();
  assertEquals(ctx.currentRunContext(), null, "clear drops the context");
});

// ────────────────────────────────────────────────────────────────────────────
// Part 2 — scheduler owner persistence (chrome storage/alarms mock)
// ────────────────────────────────────────────────────────────────────────────
const kvStore = new Map();
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
function installKvChromeMock() {
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => {
          const out = {};
          for (const k of Array.isArray(key) ? key : [key]) {
            if (kvStore.has(k)) out[k] = clone(kvStore.get(k));
          }
          return out;
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined) kvStore.delete(k);
            else kvStore.set(k, clone(v));
          }
        },
      },
    },
    alarms: {
      create: async () => true,
      clear: async () => true,
      get: async () => undefined,
      getAll: async () => [],
    },
  };
}

Deno.test("scheduler: scheduleTask persists the bounded owner; absent/empty owner is dropped", async () => {
  installKvChromeMock();
  const { scheduleTask, listScheduledTasks } = await freshScheduler();
  kvStore.delete("cap:scheduledTasks");

  await scheduleTask({
    name: "attr-owned",
    task: "check the thing",
    delayMs: 60_000,
    owner: { threadId: " thread-9 ", agentRole: "hub", agentSurfaceRef: null },
  });
  const persisted = kvStore.get("cap:scheduledTasks")?.["attr-owned"];
  assertEquals(persisted?.owner, { threadId: "thread-9", agentRole: "hub" },
    "the owner survives into the payload, trimmed");

  // No owner → no owner key at all (legacy shape preserved byte-for-byte).
  await scheduleTask({ name: "attr-plain", task: "plain", delayMs: 60_000 });
  const plain = kvStore.get("cap:scheduledTasks")?.["attr-plain"];
  assertEquals("owner" in plain, false, "an owner-less schedule persists no owner field");

  // An owner object with NO usable fields is dropped entirely.
  await scheduleTask({ name: "attr-empty", task: "empty", delayMs: 60_000, owner: { threadId: 7, agentRole: " " } });
  const empty = kvStore.get("cap:scheduledTasks")?.["attr-empty"];
  assertEquals("owner" in empty, false, "an all-invalid owner is not persisted");

  // Bounding: a hostile over-long value cannot grow the payload unbounded.
  await scheduleTask({
    name: "attr-long",
    task: "long",
    delayMs: 60_000,
    owner: { threadId: "y".repeat(1000), agentSurfaceRef: "named:probe" },
  });
  const long = kvStore.get("cap:scheduledTasks")?.["attr-long"];
  assertEquals(long?.owner?.threadId?.length, 200, "owner.threadId bounded to 200");
  assertEquals(long?.owner?.agentSurfaceRef, "named:probe");

  // The owner is visible in the owner-facing task list.
  const listed = (await listScheduledTasks()).find((t) => t.name === "attr-owned");
  assertEquals(listed?.owner, { threadId: "thread-9", agentRole: "hub" });
});

Deno.test("scheduler: retryScheduledTask re-arms WITH the owner preserved", async () => {
  installKvChromeMock();
  const { scheduleTask, retryScheduledTask, blockScheduledTaskForStorage } = await freshScheduler();
  kvStore.delete("cap:scheduledTasks");
  await scheduleTask({
    name: "attr-retry",
    task: "retry me",
    delayMs: 60_000,
    periodInMinutes: 15,
    owner: { agentRole: "background:cleaner", agentSurfaceRef: "background:cleaner" },
  });
  // Force the storage-blocked state so retry is legal, then retry.
  await blockScheduledTaskForStorage("attr-retry", new Error("quota"));
  const retried = await retryScheduledTask("attr-retry");
  assertEquals(retried?.ok, true, `retry succeeds: ${JSON.stringify(retried)}`);
  const persisted = kvStore.get("cap:scheduledTasks")?.["attr-retry"];
  assertEquals(persisted?.owner, { agentRole: "background:cleaner", agentSurfaceRef: "background:cleaner" },
    "the retried schedule keeps its agent attribution");
});

// ────────────────────────────────────────────────────────────────────────────
// Part 3 — the REAL schedule_task tool reads the active run context
// ────────────────────────────────────────────────────────────────────────────
Deno.test("schedule_task tool: persists the active run's surface as the payload owner", async () => {
  installKvChromeMock();
  kvStore.delete("cap:scheduledTasks");
  const { setRunContext, clearRunContext } = await import("../extension/lib/run-context.js");
  const { browserToolset } = await import("../extension/lib/browser-tools.js");
  const tools = browserToolset(false);
  const scheduleTaskTool = tools.schedule_task;
  assert(typeof scheduleTaskTool?.execute === "function", "the real schedule_task tool is present");

  // Inside a run attributed to a named agent in a thread.
  setRunContext({ threadId: "thread-abc", agentRole: "researcher", agentSurfaceRef: "named:probe" });
  const r1 = await scheduleTaskTool.execute({ task: "owned schedule", delayMs: 60_000 }, { toolCallId: "t1", messages: [] });
  assertEquals(r1?.ok, true, `schedule succeeds: ${JSON.stringify(r1)}`);
  const owned = kvStore.get("cap:scheduledTasks")?.[r1.name];
  assertEquals(owned?.owner, { threadId: "thread-abc", agentRole: "researcher", agentSurfaceRef: "named:probe" },
    "the tool captured the active run's surface into the payload");

  // Outside any run (owner-facing register path): no owner is persisted.
  clearRunContext();
  const r2 = await scheduleTaskTool.execute({ task: "anonymous schedule", delayMs: 60_000 }, { toolCallId: "t2", messages: [] });
  assertEquals(r2?.ok, true);
  const anon = kvStore.get("cap:scheduledTasks")?.[r2.name];
  assertEquals("owner" in anon, false, "no active run → no owner (legacy shape)");
});

// ────────────────────────────────────────────────────────────────────────────
// Part 4 — SW BOOT: fire the REAL handleAlarm with an owner payload
// ────────────────────────────────────────────────────────────────────────────

// ---- minimal in-memory IndexedDB (usage-store.js is the run path's ledger;
// real IDB transactions: get/put/add/delete/openCursor + tx complete/abort) ----
function installFakeIndexedDB() {
  const stores = () => ({
    authority: { keyPath: "id", autoIncrement: false, data: new Map(), nextKey: 1 },
    meta: { keyPath: "id", autoIncrement: false, data: new Map(), nextKey: 1 },
    quarantine: { keyPath: null, autoIncrement: true, data: new Map(), nextKey: 1 },
  });
  function makeDb() {
    const byName = stores();
    return {
      objectStoreNames: { contains: (n) => n in byName },
      createObjectStore: () => ({}),
      transaction(names, _mode) {
        const list = Array.isArray(names) ? names : [names];
        const tx = {
          pending: 0, finished: false, aborted: false, error: null,
          oncomplete: null, onerror: null, onabort: null,
          objectStore: (n) => makeStore(tx, byName[n]),
          abort() {
            if (tx.finished) return;
            tx.finished = true; tx.aborted = true;
            queueMicrotask(() => tx.onabort?.());
          },
          __settled() {
            if (tx.finished || tx.aborted) return;
            if (tx.pending === 0) {
              queueMicrotask(() => {
                if (!tx.finished && !tx.aborted && tx.pending === 0) {
                  tx.finished = true;
                  tx.oncomplete?.();
                }
              });
            }
          },
        };
        return tx;
      },
    };
  }
  function makeStore(tx, bucket) {
    const run = (fn) => {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      tx.pending++;
      queueMicrotask(() => {
        if (tx.aborted) {
          tx.pending--;
          req.error = new Error("aborted");
          queueMicrotask(() => req.onerror?.());
          return;
        }
        try { req.result = fn(); } catch (e) { req.error = e; }
        queueMicrotask(() => {
          tx.pending--;
          if (req.error) {
            tx.error ??= req.error;
            try { req.onerror?.(); } finally { tx.abort(); }
            return;
          }
          try { req.onsuccess?.(); } catch (e) { tx.error ??= e; tx.abort(); return; }
          tx.__settled();
        });
      });
      return req;
    };
    return {
      get: (key) => run(() => bucket.data.has(key) ? bucket.data.get(key) : undefined),
      put: (row) => run(() => { bucket.data.set(row[bucket.keyPath] ?? bucket.nextKey++, row); return row[bucket.keyPath]; }),
      add: (row) => run(() => { const k = bucket.autoIncrement ? bucket.nextKey++ : row[bucket.keyPath]; bucket.data.set(k, row); return k; }),
      delete: (key) => run(() => { bucket.data.delete(key); }),
      openCursor: () => {
        const keys = [...bucket.data.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        let idx = 0;
        const req = { result: null, error: null, onsuccess: null, onerror: null };
        tx.pending++;
        const fire = () => {
          queueMicrotask(() => {
            if (tx.aborted) { tx.pending--; return; }
            if (idx < keys.length) {
              const key = keys[idx++];
              req.result = {
                primaryKey: key,
                value: bucket.data.get(key),
                continue: () => fire(),
              };
            } else {
              req.result = null;
            }
            queueMicrotask(() => {
              if (req.result === null) tx.pending--;
              try { req.onsuccess?.(); } catch (e) { tx.error ??= e; tx.abort(); return; }
              if (req.result === null) tx.__settled();
            });
          });
        };
        fire();
        return req;
      },
    };
  }
  globalThis.indexedDB = {
    open: () => {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      const db = makeDb();
      req.result = db;
      queueMicrotask(() => { req.onupgradeneeded?.(); queueMicrotask(() => req.onsuccess?.()); });
      return req;
    },
  };
}

// ---- full in-memory OPFS fake (memory.js needs entries/removeEntry) ----
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; }
  async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() {
    const node = this.node;
    return { size: (node.content ?? "").length, async text() { return node.content ?? ""; } };
  }
  async createWritable() { return new FakeWritable(this.node); }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}

Deno.test("SW fire: an owner-attributed schedule links its run into the owning thread + surfaces its logs", async () => {
  // ---- chrome stub: Map-backed storage, working alarms, captured listeners ----
  const swStore = new Map();
  const alarmListeners = [];
  const alarms = new Map();
  const noopListener = { addListener: () => {} };
  globalThis.chrome = {
    runtime: {
      id: "test-extension-id",
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
      getManifest: () => ({ version: "0.0.0-test" }),
      onMessage: { addListener: () => {} },
      onConnect: noopListener,
      onInstalled: noopListener,
      sendMessage: async () => {},
    },
    storage: {
      local: {
        get: async (key) => {
          const out = {};
          for (const k of Array.isArray(key) ? key : [key]) {
            if (swStore.has(k)) out[k] = clone(swStore.get(k));
          }
          return out;
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined) swStore.delete(k);
            else swStore.set(k, clone(v));
          }
        },
      },
      session: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    // "storage" granted → kv uses the Map-backed chrome.storage.local below
    // (otherwise kv silently degrades to its in-memory session Map and the
    // direct seeding in these tests is never read). Everything else denied.
    permissions: {
      contains: async ({ permissions: perms }) =>
        Array.isArray(perms) && perms.length === 1 && perms[0] === "storage",
      onAdded: noopListener,
      onRemoved: noopListener,
    },
    alarms: {
      onAlarm: { addListener: (fn) => alarmListeners.push(fn), hasListener: (fn) => alarmListeners.includes(fn) },
      create: async (name, info) => { alarms.set(name, info); return true; },
      clear: async (name) => { const had = alarms.has(name); alarms.delete(name); return had; },
      get: async (name) => alarms.get(name),
      getAll: async () => [...alarms.entries()].map(([name, info]) => ({ name, ...info })),
    },
    tabs: { onCreated: noopListener, onActivated: noopListener, onUpdated: noopListener, onRemoved: noopListener, onAttached: noopListener, onZoomChange: noopListener, query: async () => [], sendMessage: async () => {}, create: async () => ({ id: 1 }), update: async () => ({}), remove: async () => {} },
    windows: { onCreated: noopListener, onRemoved: noopListener, onFocusChanged: noopListener },
    scripting: { executeScript: async () => [], getRegisteredContentScripts: async () => [], registerContentScripts: async () => {} },
    offscreen: { closeDocument: async () => {}, getContexts: async () => [] },
    contextMenus: { onClicked: noopListener },
    webNavigation: {},
    notifications: {},
  };
  const opfsRoot = dirNode();
  installFakeIndexedDB();
  // IMPORTANT: preserve the REAL navigator.locks (Deno's Web Locks) — the
  // usage ledger's mirror lock uses it; clobbering it forces the module-mutex
  // fallback, which deadlocks against migrateLegacy's held mutex.
  const realNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: {
      locks: realNavigator?.locks,
      userAgent: realNavigator?.userAgent ?? "deno-test",
      storage: { async getDirectory() { return new FakeDirHandle(opfsRoot); } },
    },
    configurable: true,
  });

  // Boot the REAL service worker (its module graph shares the lib instances
  // with this test — the chrome stub above is their backend).
  const onMessageListeners = [];
  globalThis.chrome.runtime.onMessage.addListener = (fn) => onMessageListeners.push(fn);
  await import(`../extension/background/service-worker.js?schedattr=${Date.now()}`);
  assert(alarmListeners.length >= 1, "the SW registered its alarm listener");
  assert(onMessageListeners.length >= 1, "the SW registered its message dispatcher");

  const ownerSender = {
    id: "test-extension-id",
    url: "chrome-extension://test-extension-id/options/options.html",
    documentId: "doc-1",
    documentLifecycle: "active",
  };
  const dispatch = (msg, sender = ownerSender) => new Promise((resolve) => {
    for (const fn of [...onMessageListeners]) {
      try { fn(msg, sender, resolve); } catch { /* another listener */ }
    }
  });

  // (e) INTERACTIVE REGRESSION + thread setup: a plain hub run (demo provider
  // is the local default) creates the owning thread end-to-end.
  const run = await dispatch({ type: "agent.run", id: `interactive-${Date.now()}`, task: "hello there", runId: `run-${Date.now()}` });
  assertEquals(run?.ok, true, `interactive run completes: ${JSON.stringify(run)?.slice(0, 300)}`);
  const threadId = run.threadId;
  assert(typeof threadId === "string" && threadId.length > 0, "the interactive run created a thread");

  // (a)+(b) Seed an owner-attributed one-shot schedule for THAT thread, arm
  // its alarm, and fire the REAL handler.
  const schedName = "task_schedattr_kat";
  swStore.set("cap:scheduledTasks", {
    [schedName]: {
      name: schedName,
      task: "run @demo-tools please",
      at: Date.now() - 1000,
      owner: { threadId, agentRole: "hub" },
    },
  });
  alarms.set(schedName, { when: Date.now() - 1000 });
  await Promise.all(alarmListeners.map((fn) => fn({ name: schedName })));

  // (b) The fired run's durable record carries the owner attribution.
  const runs = await dispatch({ type: "run.list" });
  const fired = (runs?.runs ?? []).find((r) => r.scheduleName === schedName);
  assert(fired, `the scheduled run is registered (runs: ${(runs?.runs ?? []).map((r) => r.scheduleName).join(",")})`);
  assertEquals(fired.threadId, threadId, "the fired run is attributed to the scheduling thread");
  assertEquals(fired.kind, "scheduled");
  assertEquals(fired.phase, "terminal", `the demo run settles (phase=${fired.phase}, terminal=${JSON.stringify(fired.terminal)?.slice(0, 200)})`);
  const firedExecutionId = fired.executionId;

  // (b2) The thread → executions reverse index links the fired run.
  const threadView = await dispatch({ type: "thread.get", id: threadId });
  assertEquals(threadView?.ok, true, `thread.get succeeds: ${JSON.stringify(threadView)?.slice(0, 200)}`);
  const viewMessages = threadView?.thread?.messages ?? [];
  // (c) The scheduled run's tool cards (demo @demo-tools → real memory_set /
  // memory_get rows) project into the thread's conversation view, carrying the
  // fired execution's id — the owner can SEE what the scheduled run did.
  const projectedCards = viewMessages.filter((m) => m?.role === "tool" && m?.executionId === firedExecutionId);
  assert(projectedCards.length >= 1,
    `the fired run's tool cards project into the thread view (messages: ${viewMessages.map((m) => `${m?.role}:${m?.executionId ?? "-"}`).join(", ")})`);

  // (d) The fired run's per-execution log is retrievable (the per-run log the
  // owner asked for: "I need to see the logs for each agent").
  const logs = await dispatch({ type: "run.logs", executionId: firedExecutionId });
  assertEquals(logs?.ok, true);
  const rows = logs?.logs ?? [];
  assert(rows.some((r) => r?.type === "task" && typeof r?.task === "string" && r.task.includes("@demo-tools")),
    "the run log carries the scheduled task row");
  assert(rows.some((r) => r?.type === "tool-result" || r?.type === "tool-call"),
    "the run log carries the scheduled run's tool rows");

  // The one-shot schedule completed: its payload + alarm are gone (no orphan).
  assertEquals(swStore.get("cap:scheduledTasks")?.[schedName], undefined, "one-shot payload consumed");
});

Deno.test("SW fire: a legacy recipe:<id> payload with NO owner still attributes to its background agent", async () => {
  // Same SW boot as the previous test (the module is cached — the SW is
  // already registered). Reuse its captured state via a FRESH boot is not
  // possible without cache-busting; instead this test drives the SAME boot:
  // the listeners registered above are still live.
  // NOTE: chrome + navigator stubs from the previous test remain installed.
  const alarmListeners = [];
  // Re-capture: the SW's listener is already registered on the CURRENT chrome
  // stub's alarms.onAlarm — re-point the stub's capture list at ours.
  // (The previous test's stub replaced globalThis.chrome; here we rebuild a
  // stub with a fresh capture + re-import with a cache-bust for isolation.)
  const swStore = new Map();
  const alarms = new Map();
  const noopListener = { addListener: () => {} };
  globalThis.chrome = {
    runtime: {
      id: "test-extension-id",
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
      getManifest: () => ({ version: "0.0.0-test" }),
      onMessage: { addListener: () => {} },
      onConnect: noopListener,
      onInstalled: noopListener,
      sendMessage: async () => {},
    },
    storage: {
      local: {
        get: async (key) => {
          const out = {};
          for (const k of Array.isArray(key) ? key : [key]) {
            if (swStore.has(k)) out[k] = clone(swStore.get(k));
          }
          return out;
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined) swStore.delete(k);
            else swStore.set(k, clone(v));
          }
        },
      },
      session: { get: async () => ({}), set: async () => {} },
    },
    // "storage" granted → kv uses the Map-backed chrome.storage.local below
    // (otherwise kv silently degrades to its in-memory session Map and the
    // direct seeding in these tests is never read). Everything else denied.
    permissions: {
      contains: async ({ permissions: perms }) =>
        Array.isArray(perms) && perms.length === 1 && perms[0] === "storage",
      onAdded: noopListener,
      onRemoved: noopListener,
    },
    alarms: {
      onAlarm: { addListener: (fn) => alarmListeners.push(fn), hasListener: (fn) => alarmListeners.includes(fn) },
      create: async (name, info) => { alarms.set(name, info); return true; },
      clear: async (name) => { const had = alarms.has(name); alarms.delete(name); return had; },
      get: async (name) => alarms.get(name),
      getAll: async () => [...alarms.entries()].map(([name, info]) => ({ name, ...info })),
    },
    tabs: { onCreated: noopListener, onActivated: noopListener, onUpdated: noopListener, onRemoved: noopListener, onAttached: noopListener, onZoomChange: noopListener, query: async () => [], sendMessage: async () => {}, create: async () => ({ id: 1 }), update: async () => ({}), remove: async () => {} },
    windows: { onCreated: noopListener, onRemoved: noopListener, onFocusChanged: noopListener },
    scripting: { executeScript: async () => [], getRegisteredContentScripts: async () => [], registerContentScripts: async () => {} },
    offscreen: { closeDocument: async () => {}, getContexts: async () => [] },
    contextMenus: { onClicked: noopListener },
    webNavigation: {},
    notifications: {},
  };
  const opfsRoot = dirNode();
  installFakeIndexedDB();
  // IMPORTANT: preserve the REAL navigator.locks (Deno's Web Locks) — the
  // usage ledger's mirror lock uses it; clobbering it forces the module-mutex
  // fallback, which deadlocks against migrateLegacy's held mutex.
  const realNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: {
      locks: realNavigator?.locks,
      userAgent: realNavigator?.userAgent ?? "deno-test",
      storage: { async getDirectory() { return new FakeDirHandle(opfsRoot); } },
    },
    configurable: true,
  });
  const onMessageListeners = [];
  globalThis.chrome.runtime.onMessage.addListener = (fn) => onMessageListeners.push(fn);
  await import(`../extension/background/service-worker.js?schedattr2=${Date.now()}`);
  const dispatch = (msg) => new Promise((resolve) => {
    for (const fn of [...onMessageListeners]) {
      try { fn(msg, { id: "test-extension-id", url: "chrome-extension://test-extension-id/options/options.html", documentId: "doc-1", documentLifecycle: "active" }, resolve); } catch { /* another listener */ }
    }
  });

  // A LEGACY payload: persisted before owner capture — no `owner` key — but
  // named recipe:<id>, which only background-agent.set mints.
  const schedName = "recipe:legacy-cleaner";
  swStore.set("cap:scheduledTasks", {
    [schedName]: { name: schedName, task: "tidy up", at: Date.now() - 1000 },
  });
  alarms.set(schedName, { when: Date.now() - 1000 });
  await Promise.all(alarmListeners.map((fn) => fn({ name: schedName })));

  const runs = await dispatch({ type: "run.list" });
  const fired = (runs?.runs ?? []).find((r) => r.scheduleName === schedName);
  assert(fired, "the legacy recipe run is registered");
  assertEquals(fired.agentId, "background:legacy-cleaner",
    "the legacy recipe alarm attributes to its background agent (agentId = agentSurfaceRef)");
  assertEquals(fired.phase, "terminal", `the legacy run settles (phase=${fired.phase})`);
});
