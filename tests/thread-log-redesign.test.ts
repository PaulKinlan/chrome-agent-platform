// @ts-nocheck — deterministic in-memory durable store + OPFS fake harness.
// CAP log redesign KATs: the thread is a VIEW over the single authoritative
// per-execution durable run log; turn markers persist in the thread body; NO
// failure path silently drops a row. These tests FAIL on the broken base
// (buildThreadRunView / listThreadExecutions / finalizeUnadmittedThreadRun do
// not exist; the replay drops rows) and PASS on the redesign.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";

// ── OPFS fake (threads.js / memory.js live store) ──────────────────────────
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable {
  constructor(n) { this.node = n; this.parts = []; }
  async write(s) {
    if (globalThis.__failNextWrite) { globalThis.__failNextWrite = false; throw new Error("OPFS write failed (injected)"); }
    this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s));
  }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle { constructor(n) { this.node = n; } get kind() { return "file"; } async getFile() { const n = this.node; return { size: (n.content ?? "").length, async text() { return n.content ?? ""; } }; } async createWritable() { return new FakeWritable(this.node); } }
class FakeDirHandle {
  constructor(n) { this.node = n; } get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no dir ${name}`); this.node.children.set(name, dirNode()); } return new FakeDirHandle(this.node.children.get(name)); }
  async getFileHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no file ${name}`); this.node.children.set(name, fileNode("")); } return new FakeFileHandle(this.node.children.get(name)); }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() { for (const [name, node] of this.node.children) yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", { value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } }, configurable: true, writable: true });

const { createThread, getThread, continueThread, commitThreadTerminal } = await import("../extension/lib/threads.js");
const { createDurableRunRegistry } = await import("../extension/lib/durable-runs.js");
const { buildThreadRunView, finalizeUnadmittedThreadRun } = await import("../extension/lib/thread-run-view.js");
const { projectThreadWithRunLogs } = await import("../extension/shared/conversation.js");

// ── durable-store fake (same shape as tests/durable-runs.test.ts) ──────────
class FakeStore {
  values = new Map();
  versions = new Map();
  isMaster = true;
  origin = "master";
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async has(key) { return this.values.has(key); }
  async getVersion(key) { return this.versions.get(key) ?? 0; }
  async setTrusted(key, value) {
    const version = (this.versions.get(key) ?? 0) + 1;
    this.values.set(key, structuredClone(value));
    this.versions.set(key, version);
    return version;
  }
  async compareAndRestore(key, expected, value) {
    if ((this.versions.get(key) ?? 0) !== expected) return false;
    await this.setTrusted(key, value);
    return true;
  }
  async compareAndDelete(key, expected) {
    if ((this.versions.get(key) ?? 0) !== expected) return false;
    this.values.delete(key);
    this.versions.set(key, expected + 1);
    return true;
  }
  async delete(key) { this.values.delete(key); this.versions.set(key, (this.versions.get(key) ?? 0) + 1); }
  async keys() { return [...this.values.keys()].sort(); }
}

function makeRegistry(store, bootId = "boot-a") {
  return createDurableRunRegistry({
    store,
    bootId,
    now: (() => { let n = 1000; return () => ++n; })(),
    resolveJournalStore: async () => ({ journal: [] }),
    appendJournal: async () => {},
    replaceCancellationJournal: async () => {},
    commitThread: (threadId, execId, terminal) => commitThreadTerminal(threadId, execId, terminal),
    replaceCancellationThread: (threadId, execId, terminal) => commitThreadTerminal(threadId, execId, { ...terminal, role: "error", category: "cancelled" }),
  });
}

async function seedRun(registry, executionId, threadId, toolCount, { settle = true, ok = true, result = "done" } = {}) {
  await registry.start({
    executionId,
    threadId,
    kind: "task",
    taskPreview: "task",
    journalTarget: "master",
    resumeRequest: { id: "task", task: "task", route: "runTask", routeArgs: {}, idempotencyKey: executionId },
  });
  for (let i = 1; i <= toolCount; i++) {
    await registry.appendLog(executionId, { type: "tool-call", id: "task", executionId, run: "r1", callId: `c${i}`, tool: `tool${i}`, args: `{"i":${i}}` }, `tool-call:c${i}`);
    await registry.appendLog(executionId, { type: "tool-result", id: "task", executionId, run: "r1", callId: `c${i}`, tool: `tool${i}`, result: `ok-${i}`, ok: true }, `tool-result:c${i}`);
  }
  if (settle) {
    await registry.settle(executionId, { ok, result, summary: result, logicalId: "task", at: Date.now() });
  }
}

async function viewOf(registry, threadId, failures = []) {
  const thread = await getThread(threadId);
  return await buildThreadRunView(thread, {
    listThreadExecutions: (id) => registry.listThreadExecutions(id),
    listLogs: (id) => registry.listLogs(id),
    commitTerminal: commitThreadTerminal,
    recordFailure: (kind, detail) => failures.push(`${kind}: ${detail}`),
  });
}

const toolCards = (view) => view.messages.filter((m) => m.role === "tool");

Deno.test("KAT 1: a 60-call run re-renders ALL 60 tool cards + the terminal, status done (no slice, no replay)", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const t = await createThread("sixty-call task");
  await seedRun(registry, "exec_k1_00000001", t.id, 60);
  const view = await viewOf(registry, t.id);
  assertEquals(toolCards(view).length, 60, `all 60 calls visible; got ${toolCards(view).length}`);
  const termIdx = view.messages.findIndex((m) => m.role === "assistant");
  assert(termIdx > 0, "terminal assistant row visible");
  assertEquals(view.status, "done");
  const lastCard = view.messages.map((m, i) => [m, i]).filter(([m]) => m.role === "tool").pop()[1];
  assert(lastCard < termIdx, "tool cards precede the terminal");
  // The thread BODY never carried tool rows (no replay) — the view derived them.
  const body = await getThread(t.id);
  assertEquals(body.messages.filter((m) => m.role === "tool").length, 0);
});

Deno.test("KAT 2: a continued ('try again') run shows BOTH turns' rows in order", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const t = await createThread("turn one");
  await seedRun(registry, "exec_k2a_0000001", t.id, 3, { result: "answer one" });
  const cont = await continueThread(t.id, "try again");
  assert(cont.thread, "continueThread persisted the second turn");
  await seedRun(registry, "exec_k2b_0000001", t.id, 2, { result: "answer two" });
  const view = await viewOf(registry, t.id);
  assertEquals(toolCards(view).length, 5, `both turns' cards visible; got ${toolCards(view).length}`);
  const roles = view.messages.map((m) => m.role);
  // turn order: user1, [3 cards], assistant1, user2, [2 cards], assistant2
  assertEquals(roles[0], "user");
  const a1 = view.messages.findIndex((m) => m.role === "assistant" && m.executionId === "exec_k2a_0000001");
  const u2 = view.messages.findIndex((m) => m.role === "user" && m.content === "try again");
  const a2 = view.messages.findIndex((m) => m.role === "assistant" && m.executionId === "exec_k2b_0000001");
  assert(a1 > 0 && u2 > a1 && a2 > u2, "turns render in order");
  const k2aCards = view.messages.filter((m) => m.role === "tool" && m.executionId === "exec_k2a_0000001");
  const k2bCards = view.messages.filter((m) => m.role === "tool" && m.executionId === "exec_k2b_0000001");
  assertEquals(k2aCards.length, 3);
  assertEquals(k2bCards.length, 2);
  assert(view.messages.indexOf(k2aCards[2]) < a1, "turn-1 cards before turn-1 terminal");
  assert(view.messages.indexOf(k2bCards[1]) < a2, "turn-2 cards before turn-2 terminal");
  assertEquals(view.status, "done");
});

Deno.test("KAT 3: a pre-admission failure commits an error terminal — never stuck running (finalizeUnadmittedThreadRun)", async () => {
  const t = await createThread("will fail early");
  const cont = await continueThread(t.id, "try again");
  assertEquals(cont.thread.status, "running");
  const failures = [];
  const committed = await finalizeUnadmittedThreadRun({
    threadId: t.id,
    result: { ok: false, executionId: null, error: "tab connection failed", errorCategory: "connection" },
    commitTerminal: commitThreadTerminal,
    recordFailure: (k, d) => failures.push(`${k}: ${d}`),
  });
  assertEquals(committed, true);
  const thread = await getThread(t.id);
  assertEquals(thread.status, "error", "terminal committed — not stuck running");
  assert(thread.messages.some((m) => m.role === "error" && /tab connection failed/.test(m.content)));
  // A result WITH an executionId belongs to the durable outbox — no double commit.
  const committed2 = await finalizeUnadmittedThreadRun({
    threadId: t.id,
    result: { ok: false, executionId: "exec_owned_000001", error: "owned by the outbox" },
    commitTerminal: commitThreadTerminal,
  });
  assertEquals(committed2, false);
  // A commit failure is recorded, never swallowed.
  const failures2 = [];
  const committed3 = await finalizeUnadmittedThreadRun({
    threadId: t.id,
    result: { ok: false, executionId: null, error: "x" },
    commitTerminal: async () => { throw new Error("OPFS down"); },
    recordFailure: (k, d) => failures2.push(`${k}: ${d}`),
  });
  assertEquals(committed3, false);
  assertEquals(failures2.length, 1, "the commit failure was recorded");
});

Deno.test("KAT 4: a dropped terminal commit is back-filled by reconciliation on reopen", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const t = await createThread("lost terminal");
  await seedRun(registry, "exec_k4_00000001", t.id, 2, { ok: false, result: "tab connection failed" });
  // Simulate the pre-redesign loss: the terminal marker never reached the body
  // (the outbox's commitThread call was dropped). Corrupt the body: remove the
  // terminal + reset status to running — as if the commit never happened.
  const body = await getThread(t.id);
  body.messages = body.messages.filter((m) => !(m.role === "error" && m.executionId === "exec_k4_00000001"));
  body.status = "running";
  const { masterMemory } = await import("../extension/lib/memory.js");
  await masterMemory().setTrusted(`thread:${t.id}`, body);
  // Reopen: the view reconciles from the durable terminal authority.
  const view = await viewOf(registry, t.id);
  assertNotEquals(view.status, "running", "status recovered");
  assertEquals(view.status, "error");
  assert(view.messages.some((m) => (m.role === "error") && /tab connection failed/.test(m.content ?? "")), "terminal row restored");
  assertEquals(toolCards(view).length, 2, "tool cards still visible");
  // The repair PERSISTED (the next read sees the real marker):
  const after = await getThread(t.id);
  assertEquals(after.status, "error");
});

Deno.test("KAT 5: a crash mid-run reopens honestly — cards + an interruption marker, never a fake success", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const t = await createThread("crashy task");
  await seedRun(registry, "exec_k5_00000001", t.id, 4, { settle: false }); // crash before settle
  // New worker boot over the same store → interruption recovery.
  const registry2 = makeRegistry(store, "boot-b");
  const recovery = await registry2.recover();
  assertEquals(recovery.interrupted.length, 1, "the crashed run is durably paused");
  const view = await viewOf(registry2, t.id);
  assertEquals(toolCards(view).length, 4, "the crashed run's completed calls are visible");
  assert(view.messages.some((m) => m.role === "system" && /interrupted|resumes automatically/i.test(m.content ?? "")), "honest interruption marker");
  assertEquals(view.status, "running", "durably resumable — the honest state (auto-resume pending)");
  // No fake terminal was invented:
  assert(!view.messages.some((m) => m.role === "assistant"), "no assistant row for a run that never produced one");
});

Deno.test("KAT 6: a run-log read failure surfaces a marker + is recorded (no silent gap)", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const t = await createThread("degraded logs");
  await seedRun(registry, "exec_k6_00000001", t.id, 2);
  const failures = [];
  const thread = await getThread(t.id);
  const view = await buildThreadRunView(thread, {
    listThreadExecutions: (id) => registry.listThreadExecutions(id),
    listLogs: async () => { throw new Error("log store corrupt"); },
    commitTerminal: commitThreadTerminal,
    recordFailure: (k, d) => failures.push(`${k}: ${d}`),
  });
  assert(view.viewDegraded === true, "the view declares its degradation");
  assert(view.messages.some((m) => m.role === "system" && /could not be read/i.test(m.content ?? "")), "honest gap marker");
  assert(failures.some((f) => f.startsWith("thread-view-logs")), "the failure was recorded");
});

Deno.test("KAT 7: a LEGACY thread (admitted before the reverse index) self-migrates on open", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const t = await createThread("legacy stuck thread");
  await seedRun(registry, "exec_k7_00000001", t.id, 5);
  // Simulate pre-redesign admission: remove the reverse-index entry so only the
  // run record's threadId survives (the owner's stuck thread t_1787… is this).
  await store.delete(`thread-runs:${t.id}`);
  // Also simulate the lost terminal + lost replay rows: body keeps only turns.
  const body = await getThread(t.id);
  body.messages = body.messages.filter((m) => m.role === "user");
  body.status = "running";
  const { masterMemory } = await import("../extension/lib/memory.js");
  await masterMemory().setTrusted(`thread:${t.id}`, body);
  // Open → self-migration via registry scan + full projection + terminal repair.
  const view = await viewOf(registry, t.id);
  assertEquals(toolCards(view).length, 5, "all legacy run cards recovered from the durable log");
  assertEquals(view.status, "done", "terminal back-filled");
  // The migration persisted the reverse index:
  assertEquals(await store.get(`thread-runs:${t.id}`), ["exec_k7_00000001"]);
});

Deno.test("KAT 8: legacy body-persisted tool rows are NOT duplicated by the view", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const t = await createThread("already replayed");
  await seedRun(registry, "exec_k8_00000001", t.id, 2);
  // Simulate a pre-redesign body that ALSO carries replayed tool rows:
  const { appendThreadMessage } = await import("../extension/lib/threads.js");
  await appendThreadMessage(t.id, { role: "tool", toolName: "tool1", toolStatus: "done", toolArgs: "{}", toolResult: "ok-1", toolOk: true, toolCallId: "c1", executionId: "exec_k8_00000001" });
  const view = await viewOf(registry, t.id);
  const c1Cards = toolCards(view).filter((m) => m.toolCallId === "c1");
  assertEquals(c1Cards.length, 1, "the legacy row wins; the log is not re-injected for that execution");
});

Deno.test("KAT 9: pure projection ordering + pause marker semantics (projectThreadWithRunLogs)", () => {
  const thread = {
    id: "t",
    messages: [
      { role: "user", content: "u1", ts: 1 },
      { role: "assistant", content: "a1", ts: 2, executionId: "e1" },
      { role: "user", content: "u2", ts: 3 },
    ],
  };
  const executions = [
    { executionId: "e1", phase: "terminal", logs: [{ type: "tool-call", callId: "c1", tool: "search", at: 10 }, { type: "tool-result", callId: "c1", tool: "search", result: "r", ok: true, at: 11 }] },
    { executionId: "e2", phase: "paused-interruption", pause: { recoverable: true }, logs: [{ type: "tool-call", callId: "c9", tool: "book", at: 12 }] },
  ];
  const { messages, missingTerminals } = projectThreadWithRunLogs(thread, executions);
  const roles = messages.map((m) => m.role);
  assertEquals(roles, ["user", "tool", "assistant", "user", "tool", "system"]);
  assertEquals(messages[1].toolName, "search");
  assertEquals(messages[4].toolName, "book");
  assert(/interrupted/i.test(messages[5].content));
  assertEquals(missingTerminals.length, 0, "both executions' terminals are accounted for (e2 is not terminal)");
});

// ──────────────────────────────────────────────────────────────────────────
// Bounded replay (owner P0 thread-open perf): a task with MANY executions must
// NOT re-read every execution's full log on open. The view reads only the most
// recent MAX_VIEW_EXECUTIONS, reports totals honestly, and the recent cards +
// terminal self-heal still work.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("bounded replay: a 30-run thread reads only the 25 recent executions, totals honest", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const t = await createThread("many-run task");
  let listLogsCalls = 0;
  const spyListLogs = async (id, limit) => { listLogsCalls += 1; return await registry.listLogs(id, limit); };

  for (let i = 1; i <= 30; i++) {
    await seedRun(registry, `exec_bounded_${String(i).padStart(4, "0")}`, t.id, 1, { result: `answer ${i}` });
  }

  const thread = await getThread(t.id);
  const view = await buildThreadRunView(thread, {
    listThreadExecutions: (id) => registry.listThreadExecutions(id),
    listLogs: spyListLogs,
    commitTerminal: commitThreadTerminal,
    recordFailure: () => {},
  });

  assertEquals(view.totalExecutions, 30, "total executions reported honestly");
  assertEquals(view.truncatedExecutions, 5, "the 5 oldest executions are omitted (30 - 25)");
  assertEquals(listLogsCalls, 25, "listLogs is called only for the bounded recent executions, not all 30");
  // The MOST RECENT execution's tool card is present; the OLDEST (run 1) is not.
  const hasRecent = toolCards(view).some((m) => m.executionId === "exec_bounded_0030");
  const hasOldest = toolCards(view).some((m) => m.executionId === "exec_bounded_0001");
  assert(hasRecent, "the most recent execution's card is rendered");
  assert(!hasOldest, "the oldest execution (beyond the bound) is not re-read/rendered");
  assertEquals(view.status, "done", "terminal self-heal still holds on the bounded slice");
});

Deno.test("bounded replay: a single run with >250 log rows still shows the recent cards (log row cap)", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const t = await createThread("long run");
  await seedRun(registry, "exec_bounded_rows_0001", t.id, 200, { result: "done" }); // 200 calls = 400 log rows
  let logLimitSeen = null;
  const thread = await getThread(t.id);
  const view = await buildThreadRunView(thread, {
    listThreadExecutions: (id) => registry.listThreadExecutions(id),
    listLogs: async (id, limit) => { logLimitSeen = limit; return await registry.listLogs(id, limit); },
    commitTerminal: commitThreadTerminal,
    recordFailure: () => {},
  });
  assert(logLimitSeen === 250, "listLogs is asked for the bounded 250-row slice");
  // 200 calls = 400 log rows; capped to the most-recent 250 rows = 125 tool-call
  // cards (each call contributes one tool-call + one tool-result row). The bound
  // drops the OLDEST calls, not the recent ones.
  assertEquals(toolCards(view).length, 125, "the 250-row cap yields the 125 most-recent cards");
  assert(view.truncatedLogs === true, "the row-level truncation is flagged honestly");
  assertEquals(view.status, "done");
});
