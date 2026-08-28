// failed-runs lifecycle (owner 2026-08-28): the UX-008 failed-runs section is
// not write-only. Three contracts on top of the retry authority:
//   1. CASCADE — deleting an agent purges its terminal failed records from the
//      durable registry (record, index admission, stored prompt payload, logs),
//      and the sidebar projection defensively filters failures whose owning
//      agent no longer exists.
//   2. DISMISS — the owner can dismiss a failed row (×); the tombstone is
//      durable (survives restarts), id-only (never carries prompt text), and
//      bounded (LRU cap).
//   3. The projection honours both: dismissed rows and orphaned-agent rows
//      never render; hub runs (no agentId) are unaffected; retry still works
//      for anything actually shown.

// @ts-nocheck — deterministic in-memory durable-store harness (same pattern as
// tests/ux008-failed-dispatch.test.ts).
import { assertEquals, assert } from "jsr:@std/assert";
import { createMemoryRunLogHandles } from "../extension/lib/run-log-wal-memory.js";
import { createDurableRunRegistry } from "../extension/lib/durable-runs.js";
import { selectFailedRuns } from "../extension/lib/run-retry.js";

class FakeStore {
  values = new Map();
  versions = new Map();
  isMaster = true;
  origin = "master";
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async has(key) { return this.values.has(key); }
  async getVersion(key) { return this.versions.get(key) ?? 0; }
  async snapshot(key) {
    return { exists: this.values.has(key), value: this.values.has(key) ? structuredClone(this.values.get(key)) : null, version: this.versions.get(key) ?? 0 };
  }
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

function harness() {
  const store = new FakeStore();
  const registry = createDurableRunRegistry({
    store,
    logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
    bootId: "boot-failed-runs-lifecycle",
    now: (() => { let n = 1_000; return () => ++n; })(),
    resolveJournalStore: async () => ({ journal: [] }),
    appendJournal: async () => {},
    replaceCancellationJournal: async () => {},
    commitThread: async () => {},
    replaceCancellationThread: async () => {},
  });
  return { store, registry };
}

let seq = 0;
const nextExec = () => `exec_fr${String(++seq).padStart(26, "0")}`;

async function seedFailedRun(registry, {
  agentId = null,
  task = "summarize the monthly report",
  aborted = false,
} = {}) {
  const executionId = nextExec();
  await registry.start({
    executionId,
    kind: agentId ? "agent" : "task",
    agentId,
    taskPreview: task,
    journalTarget: "master",
    resumeRequest: { route: "named-agent.run", routeArgs: { id: "analyst" }, task, attachments: [], history: [] },
  });
  await registry.settle(executionId, aborted
    ? { ok: false, aborted: true, error: "cancelled", logicalId: "t" }
    : { ok: false, error: "the model returned no content", errorCategory: "model", logicalId: "t" });
  return executionId;
}

function runsFrom(registry) {
  return (async () => (await registry.list()).runs)();
}

Deno.test("lifecycle: purgeFailedForAgent removes the agent's terminal failed records — payload, logs, index, record — and nothing else", async () => {
  const { store, registry } = harness();
  const namedA = await seedFailedRun(registry, { agentId: "named:alpha" });
  const bgA = await seedFailedRun(registry, { agentId: "background:alpha" });
  const abortedA = await seedFailedRun(registry, { agentId: "named:alpha", aborted: true });
  const namedB = await seedFailedRun(registry, { agentId: "named:beta" });
  const hub = await seedFailedRun(registry, { agentId: null });

  const r = await registry.purgeFailedForAgent(["named:alpha", "background:alpha"]);
  assertEquals(r.ok, true);
  assertEquals(r.purged, 3); // named:alpha + background:alpha + its aborted record

  // The purged executions are GONE — record, resume payload (the prompt), logs.
  for (const id of [namedA, bgA, abortedA]) {
    assertEquals(await store.has(`run:${id}`), false, `record ${id} must be gone`);
    assertEquals((await store.keys()).some((k) => k.includes(id)), false, `no auxiliary keys for ${id}`);
    assertEquals((await registry.getRetryRequest(id)).error, "unknown execution");
  }
  // Everyone else survives intact.
  assertEquals((await registry.getRetryRequest(namedB)).ok, true);
  assertEquals((await registry.getRetryRequest(hub)).ok, true);
  const index = await store.get("run-registry");
  const ids = Array.isArray(index) ? index : [];
  assertEquals(ids.includes(namedA), false);
  assertEquals(ids.includes(namedB), true);
  assertEquals(ids.includes(hub), true);
});

Deno.test("lifecycle: purge is idempotent and refuses empty refs", async () => {
  const { registry } = harness();
  await seedFailedRun(registry, { agentId: "named:alpha" });
  assertEquals((await registry.purgeFailedForAgent(["named:alpha"])).purged, 1);
  assertEquals((await registry.purgeFailedForAgent(["named:alpha"])).purged, 0);
  assertEquals((await registry.purgeFailedForAgent([])).ok, false);
});

Deno.test("lifecycle: never touches running or paused records of the deleted agent", async () => {
  const { registry } = harness();
  const runningId = nextExec();
  await registry.start({
    executionId: runningId,
    kind: "agent",
    agentId: "named:alpha",
    taskPreview: "still running",
    journalTarget: "master",
    resumeRequest: { route: "agent.run", task: "still running" },
  });
  const pausedId = nextExec();
  await registry.start({
    executionId: pausedId,
    kind: "agent",
    agentId: "named:alpha",
    taskPreview: "paused for permission",
    journalTarget: "master",
    resumeRequest: { route: "agent.run", task: "paused for permission" },
  });
  await registry.pauseForPermission(pausedId, { code: "permission_required", reason: "test" });

  await registry.purgeFailedForAgent(["named:alpha"]);
  assertEquals(await registry.getRetryRequest(runningId).then((r) => r.error ?? r.ok), "run is still active");
  assertEquals((await registry.list()).runs.some((r) => r.executionId === pausedId), true);
});

Deno.test("lifecycle: dismiss tombstones are durable, id-only, and LRU-bounded", async () => {
  const { store, registry } = harness();
  const a = await seedFailedRun(registry, { agentId: "named:alpha", task: "secret prompt text alpha" });

  const r = await registry.dismissFailedRuns([a]);
  assertEquals(r.ok, true);
  assertEquals((await registry.dismissedFailedRuns()).includes(a), true);

  // Id-only: the tombstone record carries NO prompt text.
  const tombstone = JSON.stringify(await store.get("run-dismissed-failed"));
  assert(!tombstone.includes("secret prompt text alpha"), "tombstones must not carry prompt text");

  // Durable across a fresh registry on the same store (a SW restart).
  const reopened = createDurableRunRegistry({
    store,
    logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
    bootId: "boot-after-restart",
    now: () => 9_999,
    resolveJournalStore: async () => ({ journal: [] }),
    appendJournal: async () => {},
    replaceCancellationJournal: async () => {},
    commitThread: async () => {},
    replaceCancellationThread: async () => {},
  });
  assertEquals((await reopened.dismissedFailedRuns()).includes(a), true);

  // LRU cap: 520 ids → the oldest fall off, 512 remain.
  const many = Array.from({ length: 520 }, () => nextExec());
  await registry.dismissFailedRuns(many);
  const tracked = await registry.dismissedFailedRuns();
  assertEquals(tracked.length, 512);
  assertEquals(tracked.includes(many[0]), false);
  assertEquals(tracked.includes(many[519]), true);
});

Deno.test("lifecycle: the projection honours dismissed ids and orphaned agents", () => {
  const runs = [
    { executionId: "exec_dismissed0000000000000000001", phase: "terminal", resumeAvailable: true, terminal: { ok: false, at: 10, summary: "s" }, taskPreview: "dismissed one", agentId: "named:alpha" },
    { executionId: "exec_orphan00000000000000000000001", phase: "terminal", resumeAvailable: true, terminal: { ok: false, at: 20, summary: "s" }, taskPreview: "orphaned agent failure", agentId: "named:gone" },
    { executionId: "exec_keptagent000000000000000000001", phase: "terminal", resumeAvailable: true, terminal: { ok: false, at: 30, summary: "s" }, taskPreview: "kept", agentId: "named:alpha" },
    { executionId: "exec_hubrow00000000000000000000001", phase: "terminal", resumeAvailable: true, terminal: { ok: false, at: 40, summary: "s" }, taskPreview: "hub failure", agentId: null },
  ];
  // No lifecycle opts → the ux008 contract, unchanged.
  assertEquals(selectFailedRuns(runs).length, 4);
  // Dismissed + orphan filtering together; hub runs always stay.
  const out = selectFailedRuns(runs, {
    dismissedIds: new Set(["exec_dismissed0000000000000000001"]),
    knownAgentIds: new Set(["named:alpha", "background:alpha"]),
  });
  assertEquals(out.map((r) => r.executionId), [
    "exec_hubrow00000000000000000000001",
    "exec_keptagent000000000000000000001",
  ]);
  // A known-agents set that knows NOTHING drops every agent-owned failure…
  assertEquals(selectFailedRuns(runs, { knownAgentIds: new Set() }).length, 1);
  // …but when the caller cannot know (no set passed) nothing is hidden.
  assertEquals(selectFailedRuns(runs, {}).length, 4);
});

Deno.test("lifecycle: end-to-end — purge then projection with the surviving agents", async () => {
  const { registry } = harness();
  const alpha1 = await seedFailedRun(registry, { agentId: "named:alpha" });
  const alpha2 = await seedFailedRun(registry, { agentId: "named:alpha" });
  await seedFailedRun(registry, { agentId: "named:beta" });

  await registry.purgeFailedForAgent(["named:alpha"]);

  // After the delete, the sidebar knows only beta exists.
  const out = selectFailedRuns(await runsFrom(registry), {
    knownAgentIds: new Set(["named:beta", "background:beta"]),
  });
  assertEquals(out.every((r) => r.agentId !== "named:alpha"), true);
  assertEquals(out.some((r) => r.executionId === alpha1), false);
  assertEquals(out.some((r) => r.executionId === alpha2), false);
  assertEquals(out.length, 1);
});
