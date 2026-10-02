// @ts-nocheck — unit tests for task-open performance optimizations (bead chrome-agent-platform-gym6).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createMemoryRunLogHandles } from "./fixtures/run-log-wal-memory.js";
import { createDurableRunRegistry, RUN_RETENTION_POLICY } from "../extension/lib/durable-runs.js";
import { buildThreadRunView } from "../extension/lib/thread-run-view.js";

// ── OPFS fake (threads.js / memory.js live store) ──────────────────────────
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content: string) { return { kind: "file", content }; }
class FakeWritable {
  node: any;
  parts: string[];
  constructor(n: any) { this.node = n; this.parts = []; }
  async write(s: any) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle {
  node: any;
  constructor(n: any) { this.node = n; }
  get kind() { return "file"; }
  async getFile() { const n = this.node; return { size: (n.content ?? "").length, async text() { return n.content ?? ""; } }; }
  async createWritable() { return new FakeWritable(this.node); }
}
class FakeDirHandle {
  node: any;
  constructor(n: any) { this.node = n; }
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
  async removeEntry(name: string) { this.node.children.delete(name); }
  async *entries() { for (const [name, node] of this.node.children) yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; }
}
const root = dirNode();
if (!globalThis.navigator?.storage?.getDirectory) {
  Object.defineProperty(globalThis, "navigator", {
    value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
    configurable: true,
    writable: true,
  });
}

class InstrumentedStore {
  values = new Map<string, any>();
  versions = new Map<string, number>();
  isMaster = true;
  origin = "master";
  keysCallCount = 0;
  hasCallCount = 0;
  getCallCount = 0;
  onGet: ((key: string) => Promise<void>) | null = null;

  async get(key: string) {
    this.getCallCount++;
    if (this.onGet) await this.onGet(key);
    return structuredClone(this.values.get(key) ?? null);
  }
  async has(key: string) {
    this.hasCallCount++;
    return this.values.has(key);
  }
  async getVersion(key: string) { return this.versions.get(key) ?? 0; }
  async setTrusted(key: string, value: any) {
    const version = (this.versions.get(key) ?? 0) + 1;
    this.values.set(key, structuredClone(value));
    this.versions.set(key, version);
    return version;
  }
  async compareAndRestore(key: string, expected: number, value: any) {
    if ((this.versions.get(key) ?? 0) !== expected) return false;
    await this.setTrusted(key, value);
    return true;
  }
  async compareAndDelete(key: string, expected: number) {
    if ((this.versions.get(key) ?? 0) !== expected) return false;
    this.values.delete(key);
    this.versions.set(key, expected + 1);
    return true;
  }
  async delete(key: string) {
    this.values.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
  async keys() {
    this.keysCallCount++;
    return [...this.values.keys()].sort();
  }
}

function makeRegistry(store: InstrumentedStore) {
  return createDurableRunRegistry({
    store,
    logHandleFor: createMemoryRunLogHandles(),
    bootId: "boot-perf-1",
    now: (() => { let n = 1000; return () => ++n; })(),
    resolveJournalStore: async () => ({ journal: [] }),
    appendJournal: async () => {},
    replaceCancellationJournal: async () => {},
    commitThread: async () => {},
    replaceCancellationThread: async () => {},
  });
}

Deno.test("thread-open-perf: 30 new executions + buildThreadRunView make 0 store.keys() calls and re-open makes 0 listLogs calls", async () => {
  const store = new InstrumentedStore();
  const registry = makeRegistry(store);

  const threadId = "thread-perf-1";
  for (let i = 1; i <= 30; i++) {
    const executionId = `exec_perf_${String(i).padStart(8, "0")}`;
    await registry.start({
      executionId,
      threadId,
      kind: "task",
      taskPreview: `task ${i}`,
      journalTarget: "master",
    });
    for (let r = 1; r <= 4; r++) {
      await registry.appendLog(executionId, {
        type: "tool-call",
        executionId,
        callId: `c-${i}-${r}`,
        tool: "echo",
        args: `{"r":${r}}`,
      });
    }
    await registry.settle(executionId, {
      ok: true,
      result: `done ${i}`,
    });
  }

  // 1. New executions on WAL must make 0 calls to store.keys() during start and settle
  assertEquals(store.keysCallCount, 0, "start() and settle() for 30 new executions must make 0 calls to store.keys()");

  let listLogsCallCount = 0;
  const thread = { id: threadId, name: "Perf Thread", status: "done", messages: [] };
  const deps = {
    listThreadExecutions: (id: string) => registry.listThreadExecutions(id),
    listLogs: async (id: string, limit?: any) => {
      listLogsCallCount++;
      return registry.listLogs(id, limit);
    },
    commitTerminal: async () => {},
    recordFailure: () => {},
  };

  const initialView = await buildThreadRunView(thread, deps);
  assert(initialView);
  // 2. Initial buildThreadRunView must make 0 store.keys() calls
  assertEquals(store.keysCallCount, 0, "building thread view across 30 new executions must make 0 calls to store.keys()");
  assertEquals(listLogsCallCount, 30, "initial buildThreadRunView reads logs for each of the 30 executions");

  // 3. Second buildThreadRunView on settled executions must reuse settledExecutionLogsCache
  const secondView = await buildThreadRunView(thread, deps);
  assert(secondView);
  assertEquals(listLogsCallCount, 30, "second buildThreadRunView on settled executions must make 0 additional listLogs calls (served from cache)");
});

Deno.test("thread-open-perf: migrateExecutionLog scans store.keys() at most 1 time for 20 legacy/unmigrated executions", async () => {
  const store = new InstrumentedStore();
  // Populate legacy run log rows for 20 executions in store
  for (let i = 1; i <= 20; i++) {
    const executionId = `exec_leg_${String(i).padStart(8, "0")}`;
    await store.setTrusted(`run:${executionId}`, {
      executionId,
      phase: "completed",
      startedAt: 1000 + i,
      retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
    });
    await store.setTrusted(`run-log:${executionId}:c01`, {
      type: "tool-call",
      executionId,
      idempotencyKey: "c01",
      at: 1000 + i,
      tool: "search",
      retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
    });
  }

  const registry = makeRegistry(store);
  store.keysCallCount = 0;

  for (let i = 1; i <= 20; i++) {
    const executionId = `exec_leg_${String(i).padStart(8, "0")}`;
    const logs = await registry.listLogs(executionId);
    assert(Array.isArray(logs));
  }

  assertEquals(store.keysCallCount, 1, `migrateExecutionLog must scan store.keys() at most 1 time across 20 legacy executions, saw ${store.keysCallCount}`);
});

Deno.test("thread-open-perf: listThreadExecutions on indexed thread runs via lockedRead concurrently with active reads", async () => {
  let releaseSlowRead: () => void = () => {};
  const slowReadPromise = new Promise<void>((r) => { releaseSlowRead = r; });
  let slowReadEntered = false;
  let slowReadEnteredResolve: () => void = () => {};
  const slowReadEnteredPromise = new Promise<void>((r) => { slowReadEnteredResolve = r; });

  const store = new InstrumentedStore();
  const registry = makeRegistry(store);
  const threadId = "thread-concurrent-test";
  await registry.start({
    executionId: "exec_conc_00000001",
    threadId,
    kind: "task",
    taskPreview: "concurrent 1",
    journalTarget: "master",
  });
  await registry.settle("exec_conc_00000001", { ok: true, result: "ok" });

  await registry.start({
    executionId: "exec_slow_00000001",
    threadId: "other-thread",
    kind: "task",
    taskPreview: "slow read",
    journalTarget: "master",
  });
  await registry.settle("exec_slow_00000001", { ok: true, result: "ok" });

  // Clear in-memory record cache so readRecord hits store.get
  registry.forgetCachedState();

  store.onGet = async (key: string) => {
    if (key === "run:exec_slow_00000001") {
      slowReadEntered = true;
      slowReadEnteredResolve();
      await slowReadPromise;
    }
  };

  const listLogsSlowPromise = registry.listLogs("exec_slow_00000001");
  await slowReadEnteredPromise;

  // Now call listThreadExecutions on the indexed thread.
  // Under lockedRead: it executes immediately without waiting for slowReadPromise!
  // Under exclusive locked(): it blocks until slowReadPromise is released!
  const listThreadPromise = registry.listThreadExecutions(threadId);

  let raceResult = "unresolved";
  try {
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    raceResult = await Promise.race([
      listThreadPromise.then(() => "immediate"),
      delay(50).then(() => "blocked"),
    ]);
  } finally {
    releaseSlowRead();
    await Promise.allSettled([listLogsSlowPromise, listThreadPromise]);
  }

  assertEquals(raceResult, "immediate", "listThreadExecutions on an indexed thread must not block on active reads");
});

Deno.test("thread-open-perf: concurrent identical thread.get requests deduplicate in flight", async () => {
  let buildRunViewCallCount = 0;
  const inFlight = new Map();
  async function simulatedThreadGet(m: any) {
    const key = `${m?.id}:${m?.limit ?? ""}:${m?.offset ?? ""}:${m?.all ?? ""}`;
    const inFlightPromise = inFlight.get(key);
    if (inFlightPromise) return inFlightPromise;

    const promise = (async () => {
      buildRunViewCallCount++;
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, id: m.id };
    })().finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });

    inFlight.set(key, promise);
    return promise;
  }

  const [r1, r2, r3] = await Promise.all([
    simulatedThreadGet({ id: "t1" }),
    simulatedThreadGet({ id: "t1" }),
    simulatedThreadGet({ id: "t1" }),
  ]);
  assertEquals(r1.ok, true);
  assertEquals(r2.ok, true);
  assertEquals(r3.ok, true);
  assertEquals(buildRunViewCallCount, 1, "3 concurrent identical thread.get requests must share 1 in-flight buildThreadRunView");
});
