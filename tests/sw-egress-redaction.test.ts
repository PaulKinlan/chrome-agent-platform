// Real-path verification of secret redaction at the service worker progress seam.
// Verifies that execute_tool invocations carrying secret argument keys (e.g. "key")
// have their secrets redacted to "[REDACTED]" in:
// 1. Live broadcast messages (chrome.runtime.sendMessage)
// 2. The task journal (journalAppend)
// 3. The durable run log (durableRuns.appendLog)

import { assert, assertEquals } from "jsr:@std/assert@1";

function clone(v: any) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function installFakeIndexedDB() {
  const stores = () => ({
    authority: { keyPath: "id", autoIncrement: false, data: new Map(), nextKey: 1 },
    meta: { keyPath: "id", autoIncrement: false, data: new Map(), nextKey: 1 },
    quarantine: { keyPath: null, autoIncrement: true, data: new Map(), nextKey: 1 },
  });
  function makeDb() {
    const byName: any = stores();
    return {
      objectStoreNames: { contains: (n: string) => n in byName },
      createObjectStore: () => ({}),
      transaction(names: any, _mode: any) {
        const list = Array.isArray(names) ? names : [names];
        const tx: any = {
          pending: 0, finished: false, aborted: false, error: null,
          oncomplete: null, onerror: null, onabort: null,
          objectStore: (n: string) => makeStore(tx, byName[n]),
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
  function makeStore(tx: any, bucket: any) {
    const run = (fn: any) => {
      const req: any = { result: undefined, error: null, onsuccess: null, onerror: null };
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
      get: (key: any) => run(() => bucket.data.has(key) ? bucket.data.get(key) : undefined),
      put: (row: any) => run(() => { bucket.data.set(row[bucket.keyPath] ?? bucket.nextKey++, row); return row[bucket.keyPath]; }),
      add: (row: any) => run(() => { const k = bucket.autoIncrement ? bucket.nextKey++ : row[bucket.keyPath]; bucket.data.set(k, row); return k; }),
      delete: (key: any) => { bucket.data.delete(key); },
      openCursor: () => {
        const keys = [...bucket.data.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        let idx = 0;
        const req: any = { result: null, error: null, onsuccess: null, onerror: null };
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
  (globalThis as any).indexedDB = {
    open: () => {
      const req: any = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      const db = makeDb();
      req.result = db;
      queueMicrotask(() => { req.onupgradeneeded?.(); queueMicrotask(() => req.onsuccess?.()); });
      return req;
    },
  };
}

function dirNode(): any { return { kind: "directory", children: new Map() }; }
function fileNode(content: string): any { return { kind: "file", content }; }
class FakeWritable {
  node: any;
  parts: string[];
  constructor(node: any) { this.node = node; this.parts = []; }
  async write(s: any) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle {
  node: any;
  constructor(node: any) { this.node = node; }
  get kind() { return "file"; }
  async getFile() {
    const node = this.node;
    return { size: (node.content ?? "").length, async text() { return node.content ?? ""; } };
  }
  async createWritable() { return new FakeWritable(this.node); }
}
class FakeDirHandle {
  node: any;
  constructor(node: any) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name: string, opts: any = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no dir ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name: string, opts: any = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no file ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name: string, _opts: any = {}) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}

Deno.test("real-path SW progress seam: execute_tool secret redaction across broadcast, journal, and durable log (c8ee / P1)", async () => {
  const swStore = new Map();
  swStore.set("cap:developerFeatures", true);
  const noopListener = { addListener: () => {} };
  const broadcastMessages: any[] = [];

  const onConnectListeners: any[] = [];
  const progressPortMessages: any[] = [];
  const fakePort = {
    name: "agent-progress",
    sender: { url: "chrome-extension://test-extension-id/ntp/ntp.html" },
    postMessage: (m: any) => progressPortMessages.push(clone(m)),
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} },
  };

  (globalThis as any).chrome = {
    runtime: {
      id: "test-extension-id",
      getURL: (p: string) => `chrome-extension://test-extension-id/${p}`,
      getManifest: () => ({ version: "0.0.0-test" }),
      onMessage: { addListener: () => {} },
      onConnect: {
        addListener: (fn: any) => {
          onConnectListeners.push(fn);
        },
      },
      onInstalled: noopListener,
      sendMessage: async (msg: any) => {
        broadcastMessages.push(clone(msg));
      },
    },
    storage: {
      local: {
        get: async (key: any) => {
          const out: any = {};
          for (const k of Array.isArray(key) ? key : [key]) {
            if (swStore.has(k)) out[k] = clone(swStore.get(k));
          }
          return out;
        },
        set: async (obj: any) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined) swStore.delete(k);
            else swStore.set(k, clone(v));
          }
        },
      },
      session: { get: async () => ({}), set: async () => {} },
    },
    permissions: {
      contains: async ({ permissions: perms }: any) =>
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
      locks: (realNavigator as any)?.locks,
      userAgent: realNavigator?.userAgent ?? "deno-test",
      storage: { async getDirectory() { return new FakeDirHandle(opfsRoot); } },
    },
    configurable: true,
  });

  const onMessageListeners: any[] = [];
  (globalThis as any).chrome.runtime.onMessage.addListener = (fn: any) => onMessageListeners.push(fn);
  await import(`../extension/background/service-worker.js?swegressredact=${Date.now()}`);
  const { durableRuns } = await import("../extension/lib/durable-runs.js");

  // Connect the agent-progress port so broadcastProgress events flow to fakePort
  for (const fn of onConnectListeners) fn(fakePort);

  const ownerSender = {
    id: "test-extension-id",
    url: "chrome-extension://test-extension-id/options/options.html",
    documentId: "doc-sw-egress-redact",
    documentLifecycle: "active",
  };
  const dispatch = (msg: any, sender = ownerSender) => new Promise<any>((resolve) => {
    for (const fn of [...onMessageListeners]) {
      try { fn(msg, sender, resolve); } catch { /* another listener */ }
    }
  });

  // Run a task using the demo model with @demo-tools, which triggers execute_tool
  // with arguments: { key: "demo", value: ... }
  const runRes = await dispatch({
    type: "agent.run",
    id: `task-redact-${Date.now()}`,
    task: "demonstrate tools @demo-tools",
    runId: `run-redact-${Date.now()}`,
  });
  assertEquals(runRes?.ok, true, `agent.run must succeed: ${JSON.stringify(runRes)}`);

  // 1. Inspect broadcast messages sent via chrome.runtime.sendMessage
  // 1. Inspect broadcast messages sent via agent-progress port
  const toolCallBroadcasts = progressPortMessages.filter(
    (m) => m?.type === "progress" && m?.event?.type === "tool-call" && m?.event?.toolName === "execute_tool",
  );
  assert(toolCallBroadcasts.length >= 1, `at least one execute_tool broadcast progress event emitted, got: ${JSON.stringify(progressPortMessages.map(m => m?.event?.type))}`);
  for (const b of toolCallBroadcasts) {
    const args = b.event.toolArgs;
    assert(args != null, "broadcast toolArgs present");
    // "key" in execute_tool arguments must be redacted
    if (args.arguments && typeof args.arguments === "object") {
      assertEquals(args.arguments.key, "[REDACTED]", "broadcast execute_tool arguments.key must be [REDACTED]");
    }
    const rawJson = JSON.stringify(b);
    assert(!rawJson.includes('"key":"demo"'), "broadcast message must NOT contain unredacted key 'demo'");
    assert(rawJson.includes("[REDACTED]"), "broadcast message must contain [REDACTED]");
  }

  // 2. Inspect durable run logs
  const logs = await durableRuns.listLogs(runRes.executionId);
  const toolCallLogs = logs.filter((l: any) => l.type === "tool-call" && l.tool === "execute_tool");
  assert(toolCallLogs.length >= 1, "at least one execute_tool durable run log exists");
  for (const l of toolCallLogs) {
    assert(typeof l.args === "string", "durable log args is serialized JSON string");
    const parsedArgs = JSON.parse(l.args);
    if (parsedArgs.arguments && typeof parsedArgs.arguments === "object") {
      assertEquals(parsedArgs.arguments.key, "[REDACTED]", "durable log execute_tool arguments.key must be [REDACTED]");
    }
    assert(!l.args.includes('"key":"demo"'), "durable log args must NOT contain unredacted key 'demo'");
    assert(l.args.includes("[REDACTED]"), "durable log args must contain [REDACTED]");
  }

  // 3. Inspect master memory journal
  const { masterMemory } = await import("../extension/lib/memory.js");
  const mem = await masterMemory();
  const journal = await mem.get("journal");
  assert(journal != null, "journal exists in master memory");
  const journalStr = typeof journal === "string" ? journal : JSON.stringify(journal);
  assert(!journalStr.includes('"key":"demo"'), "journal must NOT contain unredacted key 'demo'");
  assert(journalStr.includes("[REDACTED]"), "journal must contain [REDACTED]");
});
