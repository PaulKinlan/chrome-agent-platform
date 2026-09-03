// @ts-nocheck — deterministic in-memory durable store + OPFS fake harness.
// kmpq (chrome-agent-platform-kmpq): Remove the 256KiB memory-store truncation.
// OPFS/journal is the COMPLETE store. The memory thread row keeps only a
// bounded index/summary + retainedPayloadRef; the reopened thread hydrates the
// COMPLETE response from the run-log terminal payload. Falsification: a 10MiB
// response is stored complete in the journal, the memory row for that thread
// stays under the store bound (digest + ref, never a giant slice), the outbox
// record never approaches 256KiB, reload/cold-start hydrates complete, and a
// legacy truncated row back-fills from the journal. (Realistic heterogeneous
// content: homogeneous runs trip the redactor's URL-userinfo regex
// catastrophically — a pre-existing quirk unrelated to the store contract.)
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createMemoryRunLogHandles } from "../extension/lib/run-log-wal-memory.js";

function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable {
  constructor(n) { this.node = n; this.parts = []; }
  async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
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

const { createThread, getThread, commitThreadTerminal } = await import("../extension/lib/threads.js");
const { createDurableRunRegistry } = await import("../extension/lib/durable-runs.js");
const { buildThreadRunView } = await import("../extension/lib/thread-run-view.js");

class FakeStore {
  values = new Map();
  versions = new Map();
  isMaster = true;
  origin = "master";
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async has(key) { return this.values.has(key); }
  async getVersion(key) { return this.versions.get(key) ?? 0; }
  async setTrusted(key, value) { const v = (this.versions.get(key) ?? 0) + 1; this.values.set(key, structuredClone(value)); this.versions.set(key, v); return v; }
  async compareAndRestore(key, expected, value) { if ((this.versions.get(key) ?? 0) !== expected) return false; await this.setTrusted(key, value); return true; }
  async compareAndDelete(key, expected) { if ((this.versions.get(key) ?? 0) !== expected) return false; this.values.delete(key); this.versions.set(key, expected + 1); return true; }
  async delete(key) { this.values.delete(key); this.versions.set(key, (this.versions.get(key) ?? 0) + 1); }
  async keys() { return [...this.values.keys()].sort(); }
}

const BIG_UNIT = "The quick brown fox jumps over the lazy dog. 0123456789\n";
const BIG_TEXT = BIG_UNIT.repeat(Math.ceil((10 * 1024 * 1024) / BIG_UNIT.length));
const MIGRATE_LEGACY = BIG_UNIT.repeat(Math.ceil((240 * 1024) / BIG_UNIT.length)) + "\n\n…(response truncated to 240 KiB — the complete text is in the run log)";

let bootN = 0;
function makeRegistry(store, commitThread, bootId = `boot-complete-${++bootN}`) {
  return createDurableRunRegistry({
    store,
    logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
    bootId,
    now: (() => { let n = 1_000_000; return () => ++n; })(),
    resolveJournalStore: async () => ({ journal: [] }),
    appendJournal: async () => {},
    replaceCancellationJournal: async () => {},
    commitThread: (threadId, execId, terminal) => commitThread(threadId, execId, terminal),
    replaceCancellationThread: (threadId, execId, terminal) => commitThreadTerminal(threadId, execId, { ...terminal, role: "error", category: "cancelled" }),
  });
}

async function seedHugeRun(registry, executionId, { threadId, result }) {
  await registry.start({
    executionId,
    threadId,
    kind: "task",
    taskPreview: "huge",
    journalTarget: "master",
    resumeRequest: { id: "huge", task: "huge", route: "runTask", routeArgs: {}, idempotencyKey: executionId },
  });
  await registry.appendLog(executionId, { type: "task", id: "huge", task: "huge", executionId }, "task");
  await registry.settle(executionId, { ok: true, result, summary: result.slice(0, 80), logicalId: "huge", at: Date.now() });
}

async function threadView(registry, threadId) {
  return await buildThreadRunView(await getThread(threadId), {
    listThreadExecutions: (id) => registry.listThreadExecutions(id),
    listLogs: (id, limit) => registry.listLogs(id, limit),
    commitTerminal: commitThreadTerminal,
    recordFailure: () => {},
  });
}

Deno.test("complete store: a 10MiB response is stored COMPLETE in the journal and the thread view hydrates it in full", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store, (id, execId, terminal) => commitThreadTerminal(id, execId, terminal));
  const t = await createThread("ten megs");
  await seedHugeRun(registry, "exec_complete_10mib", { threadId: t.id, result: BIG_TEXT });

  // The durable run log holds the complete text (terminal row payload).
  const logs = await registry.listLogs("exec_complete_10mib");
  const terminalRow = logs.find((row) => row.type === "terminal");
  assert(terminalRow, "the terminal log row exists");
  assertEquals(terminalRow.payload.result.length, BIG_TEXT.length, "the retained payload is COMPLETE (10MiB)");

  // The reopened thread view renders the terminal message COMPLETE.
  const view = await threadView(registry, t.id);
  const answers = view.messages.filter((m) => m.role === "assistant");
  assert(answers.length >= 1, "the final answer reopens");
  assertEquals(answers[answers.length - 1].content, BIG_TEXT, "the reopened thread hydrates the complete 10MiB response");
});

Deno.test("complete store: the memory thread row stays under the store bound — a bounded digest + retainedPayloadRef, never a giant slice", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store, (id, execId, terminal) => commitThreadTerminal(id, execId, terminal));
  const t = await createThread("bounded row");
  await seedHugeRun(registry, "exec_complete_bound", { threadId: t.id, result: BIG_TEXT });

  const stored = await getThread(t.id);
  const serialized = new TextEncoder().encode(JSON.stringify(stored.messages)).byteLength;
  assert(serialized < 256 * 1024, `thread messages must stay under the store bound (${serialized} bytes)`);
  const last = stored.messages.at(-1);
  assertEquals(last.role, "assistant");
  // The row keeps the index/summary + the ref — the response text itself is
  // NOT a truncated slice of the payload.
  assert(last.content.length < 64 * 1024, `the row holds a bounded summary, not the payload (${last.content.length} chars)`);
  assert(typeof last.retainedPayloadRef === "string" && last.retainedPayloadRef.length > 0, "the row carries the retainedPayloadRef");
});

Deno.test("complete store: the outbox record never approaches the store bound for a 10MiB response (payloads by reference)", async () => {
  const store = new FakeStore();
  const captured = {};
  const origSet = store.setTrusted.bind(store);
  store.setTrusted = async (key, value) => {
    if (String(key).startsWith("run-outbox:")) captured[key] = structuredClone(value);
    return origSet(key, value);
  };
  const registry = makeRegistry(store, (id, execId, terminal) => commitThreadTerminal(id, execId, terminal));
  const t = await createThread("outbox small");
  await seedHugeRun(registry, "exec_complete_outbox", { threadId: t.id, result: BIG_TEXT });
  const outbox = captured[`run-outbox:exec_complete_outbox`];
  assert(outbox, "outbox persisted");
  const serialized = new TextEncoder().encode(JSON.stringify(outbox)).byteLength;
  assert(serialized < 64 * 1024, `the 10MiB outbox stays small by design (${serialized} bytes)`);
  assert(typeof outbox.retainedPayloadRef === "string", "the outbox references the payload");
});

Deno.test("complete store: reload/cold-start hydrates complete (a fresh registry over the same store)", async () => {
  const store = new FakeStore();
  const first = makeRegistry(store, (id, execId, terminal) => commitThreadTerminal(id, execId, terminal), "boot-cold-a");
  const t = await createThread("cold start");
  await seedHugeRun(first, "exec_complete_cold", { threadId: t.id, result: BIG_TEXT });

  // A new worker boot (new registry) reads the same durable store.
  const restarted = makeRegistry(store, (id, execId, terminal) => commitThreadTerminal(id, execId, terminal), "boot-cold-b");
  const view = await threadView(restarted, t.id);
  const answers = view.messages.filter((m) => m.role === "assistant");
  assertEquals(answers.at(-1).content, BIG_TEXT, "cold-start hydrates the complete response from OPFS/journal");
});

Deno.test("complete store: migration — a legacy truncated terminal row back-fills from the journal where the complete text exists", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store, (id, execId, terminal) => commitThreadTerminal(id, execId, terminal));
  const t = await createThread("migration");
  await seedHugeRun(registry, "exec_complete_migrate", { threadId: t.id, result: BIG_TEXT });

  // Simulate a PRE-kmpq thread: the durable run exists with the full payload,
  // but the body row holds a legacy truncated marker (no retainedPayloadRef).
  const legacyThread = await getThread(t.id);
  const legacyRowIndex = legacyThread.messages.findIndex(
    (m) => m.role === "assistant" && m.executionId === "exec_complete_migrate" && !Number.isInteger(m.step));
  legacyThread.messages[legacyRowIndex] = {
    ...legacyThread.messages[legacyRowIndex],
    content: MIGRATE_LEGACY,
    retainedPayloadRef: undefined,
  };
  const { masterMemory } = await import("../extension/lib/memory.js");
  await masterMemory().setTrusted(`thread:${t.id}`, legacyThread);

  // Reopen: the view must back-fill the COMPLETE text from the journal.
  const view = await threadView(registry, t.id);
  const answers = view.messages.filter((m) => m.role === "assistant");
  assertEquals(answers.at(-1).content, BIG_TEXT, "the legacy truncated row is back-filled with the complete journal text");
});
