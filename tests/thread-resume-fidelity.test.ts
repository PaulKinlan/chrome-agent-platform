// tests/thread-resume-fidelity.test.ts — continuation fidelity across a
// DURABLE RESUME of a named-agent run (CAP slice 2026-08-30, review r2 P1).
// @ts-nocheck — the chrome/OPFS fakes are intentionally dynamic.
//
// The fresh @mention dispatch passes thread history + journaled skills into
// named-agent.run; the durable-resume dispatch (run.resume / interruption
// recovery) must re-apply the SAME context when a paused/interrupted run
// restarts. Falsification-gated: on the pre-fix code the resume dispatch drops
// history + journaledSkillIds, so the resumed run's terminal thread row
// carries no skills and the run sees no prior turns — this test goes RED.
//
// The observable: a seeded paused run whose resumeRequest carries
// journaledSkillIds:["page-summary"] + history must, after run.resume, settle with a
// terminal thread row whose `skills` includes "page-summary" (runTask merges journaled
// skills into runSkills, which journal onto the terminal row via the settle
// payload → threadTerminal → commitThreadTerminal).

import { assert, assertEquals } from "jsr:@std/assert@1";

// ---- in-memory chrome stub (Map storage + OPFS fakes + IndexedDB fake),
// ---- mirroring tests/sched-attr.test.ts ----
function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}
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
      if (opts?.create !== true) throw new Error(`no dir ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no file ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name, opts = {}) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}

Deno.test("durable resume of a named-agent run re-applies the thread's journaled skills + history", async () => {
  const swStore = new Map();
  // the marker demo model sits behind the developer flag (KEYLESS-FIRST-RESULT)
  swStore.set("cap:developerFeatures", true);
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
    permissions: {
      contains: async ({ permissions: perms }) =>
        Array.isArray(perms) && perms.length === 1 && perms[0] === "storage",
      onAdded: noopListener,
      onRemoved: noopListener,
    },
    alarms: {
      onAlarm: { addListener: () => {}, hasListener: () => false },
      create: async () => true, clear: async () => true,
      get: async () => undefined, getAll: async () => [],
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
  await import(`../extension/background/service-worker.js?resumefidelity=${Date.now()}`);
  const { durableRuns } = await import("../extension/lib/durable-runs.js");
  assert(onMessageListeners.length >= 1, "the SW registered its message dispatcher");

  const ownerSender = {
    id: "test-extension-id",
    url: "chrome-extension://test-extension-id/options/options.html",
    documentId: "doc-resume-fidelity",
    documentLifecycle: "active",
  };
  const dispatch = (msg, sender = ownerSender) => new Promise((resolve) => {
    for (const fn of [...onMessageListeners]) {
      try { fn(msg, sender, resolve); } catch { /* another listener */ }
    }
  });

  // A REAL named agent, created through the REAL route. "named:alpha"
  // slugifies to "named-alpha" — the resume dispatch must resolve the same.
  const created = await dispatch({ type: "named-agent.create", id: "named-alpha", name: "Alpha" });
  assertEquals(created?.ok, true, `named-agent.create must succeed: ${JSON.stringify(created)?.slice(0, 200)}`);

  const firstRun = await dispatch({ type: "agent.run", id: `t0-${Date.now()}`, task: "hello there", runId: `run-${Date.now()}` });
  assertEquals(firstRun?.ok, true, `the interactive run completes: ${JSON.stringify(firstRun)?.slice(0, 200)}`);
  const threadId = firstRun?.threadId;
  assert(typeof threadId === "string" && threadId.length > 0, "the interactive run created a thread");

  // Seed a PAUSED durable run whose resumeRequest mirrors what a real
  // named-agent @mention admission persists — route, routeArgs, task, history,
  // journaledSkillIds (["page-summary"] is a real built-in recipe id) — then pause it
  // for permission so run.resume is the legal restart path.
  const execId = `exec_resume_fidelity_${Date.now()}`;
  const seeded = await durableRuns.start({
    executionId: execId,
    threadId,
    kind: "agent",
    agentId: "named:alpha",
    journalTarget: "master",
    taskPreview: "alpha's resumed task",
    resumeRequest: {
      id: "named:alpha:resume",
      task: "resume alpha's work",
      history: [{ role: "user", content: "alpha's prior question" }],
      journaledSkillIds: ["page-summary"],
      route: "named-agent.run",
      routeArgs: { id: "named:alpha", runId: `named:alpha:${Date.now()}`, threadId },
      providerBinding: { schemaVersion: 1, provider: "demo", model: "", requestedScope: null, local: true },
      idempotencyKey: execId,
      replaySafety: { classification: "unknown-until-tool-progress", automaticReplayBeforeProgress: true },
      threadId,
      memoryOrigin: "master",
      providerServerAgentId: null,
    },
  });
  assert(seeded, "seeded durable run started");
  const paused = await durableRuns.pauseForPermission(execId, "storage");
  assertEquals(paused?.phase, "paused-permission", `seeded run paused for permission (${paused?.phase})`);

  // Drive the REAL resume dispatch.
  const resumed = await dispatch({ type: "run.resume", executionId: execId });
  assert(
    resumed?.ok !== false || resumed?.paused === true,
    `the resume dispatch reaches the named-agent route: ${JSON.stringify(resumed)?.slice(0, 300)}`,
  );
  if (resumed?.paused === true) {
    // Provider-identity change would be an environment artifact, not the
    // fidelity assertion — re-dispatch with the change allowed.
    const retried = await dispatch({ type: "run.resume", executionId: execId, allowProviderChange: true });
    assert(retried?.ok !== false || retried?.paused !== true, `provider-change resume accepted: ${JSON.stringify(retried)?.slice(0, 300)}`);
  }

  // Wait for the resumed run to settle (the demo model completes; poll the
  // durable registry for a terminal phase).
  let settledRun = null;
  for (let i = 0; i < 50; i++) {
    const snapshot = await durableRuns.list();
    const row = snapshot.runs.find((r) => r.executionId === execId);
    if (row && ["terminal", "settling"].includes(row.phase)) { settledRun = row; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(settledRun, `the resumed run settles (phase=${settledRun?.phase ?? "unknown"})`);

  // THE FIDELITY OBSERVABLE: the resumed run's terminal thread row carries the
  // journaled skill id ("page-summary"). On the pre-fix code the resume dispatch drops
  // journaledSkillIds → runTask merges none → runSkillIds empty → the terminal
  // row has no skills → this assertion is RED.
  const { getThread } = await import("../extension/lib/threads.js");
  const rawThread = await getThread(threadId);
  const messages = rawThread?.messages ?? [];
  const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant");
  assert(lastAssistant, "the thread has an assistant terminal row");
  const skills = Array.isArray(lastAssistant?.skills) ? lastAssistant.skills : [];
  assert(
    skills.includes("page-summary"),
    `the resumed run's terminal row re-applied the journaled skill — got skills=${JSON.stringify(skills)}, expected to include "page-summary"`,
  );
});
