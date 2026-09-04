// tests/thread-reload-fidelity.test.ts — CAP-FB-20260901-THREAD-RELOAD-FIDELITY-01
// @ts-nocheck — the OPFS fakes are intentionally dynamic.
//
// The owner's report: reloading the agent view lost most of the transcript
// and the final answer could not be expanded. Measured at d437963d (60 runs
// on one surface, each a real @demo-tools run): the task thread reopened with
// 0 of 180 tool cards (25 of 60 executions read, the rest compacted to a
// summary row after the 10th run per thread); the named-agent surface
// reopened from the journal with 0 tool cards and a 128-char final answer
// (the journal keeps a 240-char preview; the journal's 200-row slice held 53
// of 60 runs).
//
// The properties pinned here, on the REAL registry + view builders:
//   1. the reopened thread renders every tool card of the last 50 runs
//      (retention keeps the visible-history rows for 50 runs per thread; the
//      view reads 50 executions) — falsified by reverting the keep-rule;
//   2. the compacted row states what was folded (tool calls / approvals);
//   3. the reopened AGENT surface is a view over the durable run log: every
//      tool card, every approval card, and the COMPLETE final answer (the
//      retained terminal payload, never the journal's 240-char preview);
//   4. what is not shown is stated — never a silent drop.

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

const { createThread, getThread, continueThread, commitThreadTerminal } = await import("../extension/lib/threads.js");
const { createDurableRunRegistry, RUN_RETENTION_POLICY } = await import("../extension/lib/durable-runs.js");
const { buildThreadRunView, buildAgentRunView, MAX_VIEW_EXECUTIONS } = await import("../extension/lib/thread-run-view.js");

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

let bootN = 0;
function makeRegistry(store, { retention = null } = {}) {
  return createDurableRunRegistry({
    store,
    logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
    bootId: `boot-fidelity-${++bootN}`,
    now: (() => { let n = 1_000_000; return () => ++n; })(),
    resolveJournalStore: async () => ({ journal: [] }),
    appendJournal: async () => {},
    replaceCancellationJournal: async () => {},
    commitThread: (threadId, execId, terminal) => commitThreadTerminal(threadId, execId, terminal),
    replaceCancellationThread: (threadId, execId, terminal) => commitThreadTerminal(threadId, execId, { ...terminal, role: "error", category: "cancelled" }),
    // null → the bounded DEFAULTS (what a fresh profile runs under).
    ...(retention ? { retentionSetting: async () => retention } : {}),
  });
}

const TOOLS_PER_RUN = 2;
async function seedRun(registry, executionId, { threadId = null, agentId = null, task = "task", toolCount = TOOLS_PER_RUN, result = "done", approval = false } = {}) {
  await registry.start({
    executionId,
    threadId,
    agentId,
    kind: agentId ? "agent" : "task",
    taskPreview: task,
    journalTarget: agentId ? `agent:${String(agentId).replace(/^named:/, "")}` : "master",
    resumeRequest: { id: task, task, route: "runTask", routeArgs: {}, idempotencyKey: executionId },
  });
  await registry.appendLog(executionId, { type: "task", id: task, task, executionId }, "task");
  for (let i = 1; i <= toolCount; i++) {
    await registry.appendLog(executionId, { type: "tool-call", id: task, executionId, run: "r1", callId: `c${i}`, tool: `tool${i}`, args: `{"i":${i}}` }, `tool-call:c${i}`);
    const paused = approval && i === 1
      ? { permissionRequirement: { kind: "browser-control", permissions: ["tabs"], reason: "group tabs" }, permissionDecision: "approved" }
      : {};
    await registry.appendLog(executionId, { type: "tool-result", id: task, executionId, run: "r1", callId: `c${i}`, tool: `tool${i}`, result: `ok-${i}`, resultFull: JSON.stringify({ i, full: "x".repeat(400) }), ok: true, ...paused }, `tool-result:c${i}`);
  }
  await registry.settle(executionId, { ok: true, result, summary: result.slice(0, 80), logicalId: task, at: Date.now() });
}

const toolCards = (view) => view.messages.filter((m) => m.role === "tool");
const compactedMarkers = (view) => view.messages.filter((m) => m.role === "system" && m.compacted === true);

async function threadView(registry, threadId) {
  return await buildThreadRunView(await getThread(threadId), {
    listThreadExecutions: (id) => registry.listThreadExecutions(id),
    listLogs: (id, limit) => registry.listLogs(id, limit),
    commitTerminal: commitThreadTerminal,
    recordFailure: () => {},
  });
}

async function agentView(registry, agentId) {
  return await buildAgentRunView({ agentId }, {
    listRuns: async () => (await registry.list()).runs,
    listLogs: (id, limit) => registry.listLogs(id, limit),
    recordFailure: () => {},
  });
}

// ── 1. the thread keeps the last 50 runs' cards ──────────────────────────────
Deno.test("reload fidelity: the reopened thread renders every tool card of the last 50 runs (default retention)", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store); // the bounded DEFAULTS
  const t = await createThread("fifty runs");
  const N = 50;
  for (let i = 1; i <= N; i++) {
    if (i > 1) await continueThread(t.id, `turn ${i}`);
    await seedRun(registry, `exec_fid_thread_${String(i).padStart(3, "0")}`, { threadId: t.id, task: `turn ${i}`, result: `answer ${i}` });
  }
  const view = await threadView(registry, t.id);
  assertEquals(view.totalExecutions, N);
  assertEquals(view.truncatedExecutions, 0, "every run of the thread is in the view");
  assertEquals(compactedMarkers(view).length, 0, "no run of the last 50 was compacted");
  assertEquals(toolCards(view).length, N * TOOLS_PER_RUN, "every tool card of every run reopens");
  // The cards keep their retained full results (the card's expandable detail).
  assert(toolCards(view).every((c) => typeof c.toolDetail === "string" && c.toolDetail.length > 300), "each card carries the retained full result");
  assertEquals(view.messages.filter((m) => m.role === "assistant").length, N, "every final answer reopens");
  // The two bounds that make it so, pinned together (the retention keep-rule
  // and the view's read bound).
  assert(RUN_RETENTION_POLICY.perThread >= N, `retention keeps the visible history of ${N} runs per thread (perThread=${RUN_RETENTION_POLICY.perThread})`);
  assert(MAX_VIEW_EXECUTIONS >= N, `the view reads ${N} executions (MAX_VIEW_EXECUTIONS=${MAX_VIEW_EXECUTIONS})`);
});

// ── 2. the compacted row states what was folded ──────────────────────────────
Deno.test("reload fidelity: the compacted row states what was folded (tool calls + approvals), and the marker says so", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store, { retention: { mode: "bounded", perThread: 1 } });
  const t = await createThread("compacted");
  await seedRun(registry, "exec_fid_fold_001", { threadId: t.id, task: "first", toolCount: 3, approval: true, result: "first answer" });
  await continueThread(t.id, "again");
  await seedRun(registry, "exec_fid_fold_002", { threadId: t.id, task: "again", toolCount: 1, result: "second answer" });
  const rows = await registry.listLogs("exec_fid_fold_001");
  assertEquals(rows.length, 1, "the older run is one summary row");
  assertEquals(rows[0].type, "compacted");
  assertEquals(rows[0].folded?.toolCalls, 3, "the row lists how many tool calls were folded");
  assertEquals(rows[0].folded?.approvals, 1, "the row lists how many approval decisions were folded");
  const view = await threadView(registry, t.id);
  const markers = compactedMarkers(view);
  assertEquals(markers.length, 1);
  assert(/3 tool calls/.test(markers[0].content) && /1 approval/.test(markers[0].content), `the marker states what was folded: ${markers[0].content}`);
  assert(/Older tool details were compacted/.test(markers[0].content), markers[0].content);
  // Never silent: the compacted run's answer is still there, in place.
  assert(view.messages.some((m) => m.role === "assistant" && m.content === "first answer"));
  assertEquals(toolCards(view).length, 1, "the newest run keeps its card");
});

// ── 3. the agent surface is a view over the durable run log ──────────────────
Deno.test("reload fidelity: the reopened agent surface renders every tool card, every approval card and the COMPLETE final answer of the last 50 runs", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const agentId = "named:fixture";
  const N = 50;
  const LONG = "L".repeat(5000); // > the bubble's 4000-char expander threshold, > the 240-char journal preview
  for (let i = 1; i <= N; i++) {
    await seedRun(registry, `exec_fid_agent_${String(i).padStart(3, "0")}`, { agentId, task: `agent turn ${i}`, result: `${LONG} answer ${i}`, approval: i === N });
  }
  // Another agent's runs never leak into this surface.
  await seedRun(registry, "exec_fid_agent_other", { agentId: "named:other", task: "other", result: "other answer" });
  const view = await agentView(registry, agentId);
  assertEquals(view.totalExecutions, N);
  assertEquals(view.truncatedExecutions, 0);
  assertEquals(view.messages.filter((m) => m.role === "user").length, N, "every user turn reopens");
  assertEquals(toolCards(view).length, N * TOOLS_PER_RUN, "every tool card of every run reopens");
  const answers = view.messages.filter((m) => m.role === "assistant");
  assertEquals(answers.length, N, "every final answer reopens");
  assert(answers.every((m) => m.content.length > 5000), "each answer is the COMPLETE retained text, never the 240-char preview");
  assertEquals(answers[N - 1].content, `${LONG} answer ${N}`);
  assertEquals(view.messages.filter((m) => m.role === "approval").length, 1, "the decided approval card reopens");
  assertEquals(view.messages.filter((m) => m.role === "approval")[0].state, "granted", "an approved decision reopens as the granted card");
  assert(!view.messages.some((m) => m.content === "other answer"), "another agent's runs are not in this view");
  // Chronological: user turn → its cards → its answer, per run.
  const roles = view.messages.slice(0, 2 + TOOLS_PER_RUN).map((m) => m.role);
  assertEquals(roles, ["user", "tool", "tool", "assistant"]);
  assertEquals(view.messages[0].content, "agent turn 1");
});

// ── 4. what is not shown is stated ───────────────────────────────────────────
Deno.test("reload fidelity (dptw): all 52 runs are in the agent view — no 50-run view bound", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store);
  const agentId = "named:many";
  const N = 52;
  for (let i = 1; i <= N; i++) {
    await seedRun(registry, `exec_fid_many_${String(i).padStart(3, "0")}`, { agentId, task: `t${i}`, result: `a${i}`, toolCount: 1 });
  }
  const view = await agentView(registry, agentId);
  assertEquals(view.totalExecutions, N);
  assertEquals(view.truncatedExecutions, 0, "dptw: no view bound — nothing omitted");
  assertEquals(toolCards(view).length, N, "every run's card renders, past the old 50 cap");
  assert(view.messages.some((m) => m.content === "a1"), "the oldest run is in the view");
  assert(!view.messages.some((m) => m.role === "system" && m.viewBound), "no view-bound notice — there is no bound");
});

// ── dptw (R7): the view has no 50-execution / 250-row bounds ───────────────
Deno.test("reload fidelity (dptw): the reopened thread renders runs past the old 50-execution view bound", async () => {
  const store = new FakeStore();
  // Retention keeps 60 runs per thread so only the VIEW bound can truncate.
  const registry = makeRegistry(store, { retention: { mode: "bounded", perThread: 60 } });
  const t = await createThread("fifty-five runs");
  const N = 55;
  for (let i = 1; i <= N; i++) {
    if (i > 1) await continueThread(t.id, `turn ${i}`);
    await seedRun(registry, `exec_dptw_view_${String(i).padStart(3, "0")}`, { threadId: t.id, task: `turn ${i}`, result: `answer ${i}` });
  }
  const view = await threadView(registry, t.id);
  assertEquals(view.totalExecutions, N);
  assertEquals(view.truncatedExecutions, 0, "all 55 runs are in the view — past the old 50 cap");
  assertEquals(toolCards(view).length, N * TOOLS_PER_RUN, "every tool card of all 55 runs reopens");
});

Deno.test("reload fidelity (dptw): a run with more than 250 log rows reopens every row", async () => {
  const store = new FakeStore();
  const registry = makeRegistry(store, { retention: { mode: "bounded", perThread: 5 } });
  const t = await createThread("many rows");
  await seedRun(registry, "exec_dptw_rows_001", { threadId: t.id, task: "row heavy", toolCount: 130, result: "done" });
  const view = await threadView(registry, t.id);
  assertEquals(toolCards(view).length, 130, "all 130 tool cards render (260+ rows, past the old 250-row read bound)");
  const truncNotices = view.messages.filter((m) => m.role === "system" && /omitted|truncated/i.test(String(m.content ?? "")));
  assertEquals(truncNotices.length, 0, "no truncation notice — nothing was omitted");
});
