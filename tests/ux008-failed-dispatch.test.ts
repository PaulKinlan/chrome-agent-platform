// UX-008 (CAP-FB-20260828-SILENT-DISPATCH-LOSS-01): a run that fails before
// producing anything must stay VISIBLE and RETRYABLE — never retyped.
//
// These tests pin the two halves of that contract:
//   1. the durable retry authority (durable-runs.getRetryRequest): a terminal
//      failed run exposes its stored prompt + original route; active, aborted,
//      successful, and prompt-less runs refuse honestly.
//   2. the pure projection helpers (lib/run-retry.js): which failed runs the
//      Tasks sidebar offers (bounded, most-recent-first, aborted excluded) and
//      how a stored resume-request maps back onto its dispatch route.

// @ts-nocheck — deterministic in-memory durable-store harness (same pattern as
// tests/durable-runs.test.ts).
import { assertEquals, assert } from "jsr:@std/assert";
import { createDurableRunRegistry } from "../extension/lib/durable-runs.js";
import { buildRetryDispatch, retryRunId, selectFailedRuns } from "../extension/lib/run-retry.js";

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
    bootId: "boot-ux008",
    now: (() => { let n = 1_000; return () => ++n; })(),
    resolveJournalStore: async () => ({ journal: [] }),
    appendJournal: async () => {},
    replaceCancellationJournal: async () => {},
    commitThread: async () => {},
    replaceCancellationThread: async () => {},
    compensateJournal: async () => {},
  });
  return { store, registry };
}

const EXEC = "exec_ux008aaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function seedFailedRun(registry, {
  executionId = EXEC,
  task = "summarize the monthly report",
  route = "named-agent.run",
  routeArgs = { id: "analyst", runId: "named:analyst:123", threadId: null },
} = {}) {
  await registry.start({
    executionId,
    kind: "agent",
    agentId: "named:analyst",
    taskPreview: task,
    journalTarget: "master",
    resumeRequest: { route, routeArgs, task, attachments: [], history: [] },
  });
  await registry.settle(executionId, {
    ok: false,
    error: "the model returned no content",
    errorCategory: "model",
    logicalId: "task-ux008",
  });
}

Deno.test("ux008: a terminal failed run exposes its stored prompt + route to retry", async () => {
  const { registry } = harness();
  await seedFailedRun(registry);
  const r = await registry.getRetryRequest(EXEC);
  assertEquals(r.ok, true);
  assertEquals(r.request.task, "summarize the monthly report");
  assertEquals(r.request.route, "named-agent.run");
  assertEquals(r.request.routeArgs.id, "analyst");
  assertEquals(r.phase, "terminal");
  assert(r.summary.length > 0);
});

Deno.test("ux008: active, successful, aborted, and unknown runs refuse retry honestly", async () => {
  const { registry } = harness();

  // Still running → refused.
  await registry.start({
    executionId: EXEC,
    kind: "task",
    taskPreview: "in flight",
    journalTarget: "master",
    resumeRequest: { route: "agent.run", task: "in flight" },
  });
  assertEquals((await registry.getRetryRequest(EXEC)).error, "run is still active");

  // Settled SUCCESS → refused (nothing to retry).
  await registry.settle(EXEC, { ok: true, result: "done", logicalId: "t" });
  assertEquals((await registry.getRetryRequest(EXEC)).error, "run did not fail");

  // Aborted failure → refused (the owner's own choice is not offered back).
  await registry.start({
    executionId: "exec_ux008bbbbbbbbbbbbbbbbbbbbbbbbbbb",
    kind: "task",
    taskPreview: "aborted work",
    journalTarget: "master",
    resumeRequest: { route: "agent.run", task: "aborted work" },
  });
  await registry.settle("exec_ux008bbbbbbbbbbbbbbbbbbbbbbbbbbb", { ok: false, aborted: true, error: "cancelled", logicalId: "t2" });
  assertEquals((await registry.getRetryRequest("exec_ux008bbbbbbbbbbbbbbbbbbbbbbbbbbb")).error, "an aborted run is not retryable");

  // Unknown execution → refused.
  assertEquals((await registry.getRetryRequest("exec_ux008ccccccccccccccccccccccccccc")).error, "unknown execution");
});

Deno.test("ux008: a failed run with no stored prompt refuses retry", async () => {
  const { registry } = harness();
  await registry.start({
    executionId: EXEC,
    kind: "task",
    taskPreview: "legacy run",
    journalTarget: "master",
    // no resumeRequest at all
  });
  await registry.settle(EXEC, { ok: false, error: "boom", logicalId: "t" });
  assertEquals((await registry.getRetryRequest(EXEC)).error, "no stored prompt");
});

Deno.test("ux008: buildRetryDispatch maps each stored route back onto its dispatch shape", () => {
  const named = buildRetryDispatch({
    route: "named-agent.run",
    task: "do the thing",
    attachments: [{ name: "a.txt" }],
    routeArgs: { id: "analyst", runId: "old", threadId: "thread-9" },
  }, { runId: "retry:x" });
  assertEquals(named, {
    route: "named-agent.run",
    args: { id: "analyst", task: "do the thing", attachments: [{ name: "a.txt" }], runId: "retry:x", threadId: "thread-9" },
  });

  const background = buildRetryDispatch({ route: "background-agent.run", task: "b", routeArgs: { id: "nightly" } }, { runId: "retry:y" });
  assertEquals(background, { route: "background-agent.run", args: { id: "nightly", task: "b", runId: "retry:y", attachments: [] } });

  // The hub path records the runTask default — it maps onto agent.run.
  const hub = buildRetryDispatch({ route: "runTask", task: "h", history: [{ role: "user", content: "h" }], threadId: "thread-1" }, { runId: "retry:z" });
  assertEquals(hub.route, "agent.run");
  assertEquals(hub.args.threadId, "thread-1");
  assertEquals(hub.args.history.length, 1);

  // Non-retryable routes and empty prompts refuse (fail closed, never dispatch).
  assertEquals(buildRetryDispatch({ route: "agent.delegate", task: "x" }), null);
  assertEquals(buildRetryDispatch({ route: "named-agent.run", task: "   " }), null);
  assertEquals(buildRetryDispatch(null), null);
});

Deno.test("ux008: selectFailedRuns projects terminal failures, newest first, capped, aborted excluded", () => {
  const rows = [
    { executionId: "exec_1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", phase: "terminal", resumeAvailable: true, terminal: { ok: false, at: 100, summary: "old failure" }, taskPreview: "old", kind: "agent" },
    { executionId: "exec_2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", phase: "terminal", resumeAvailable: true, terminal: { ok: false, aborted: true, at: 200 }, taskPreview: "aborted by owner" },
    { executionId: "exec_3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", phase: "terminal", resumeAvailable: true, terminal: { ok: false, at: 300, summary: "new failure" }, taskPreview: "new", kind: "agent", agentId: "named:analyst" },
    { executionId: "exec_4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", phase: "running", resumeAvailable: true, terminal: { ok: false, at: 400 }, taskPreview: "still running" },
    { executionId: "exec_5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", phase: "terminal", resumeAvailable: false, terminal: { ok: false, at: 500 }, taskPreview: "no prompt kept" },
    { executionId: "exec_6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", phase: "terminal", resumeAvailable: true, terminal: { ok: true, at: 600 }, taskPreview: "success" },
  ];
  const out = selectFailedRuns(rows, { limit: 2 });
  assertEquals(out.map((r) => r.executionId), ["exec_3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "exec_1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  assertEquals(out[0].taskPreview, "new");
  assertEquals(out[0].agentId, "named:analyst");
});

Deno.test("ux008: retryRunId is collision-safe and names its origin", () => {
  const a = retryRunId(() => 1_000);
  const b = retryRunId(() => 1_000);
  assert(a.startsWith("retry:"));
  assert(a !== b); // the random suffix separates same-ms retries
});

Deno.test("ux008: the SW route + sidebar wiring exist (source pins)", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  // The route is owner-gated, uses the durable retry authority + the pure
  // dispatch builder, and re-dispatches through the ORIGINAL route handler.
  assert(/async "run\.retry"\(m, context\) \{[\s\S]{0,600}owner_extension_required/.test(sw), "run.retry is owner-gated");
  assert(/async "run\.retry"[\s\S]{0,1200}durableRuns\.getRetryRequest\(executionId\)/.test(sw), "run.retry reads the stored prompt via the registry");
  assert(/async "run\.retry"[\s\S]{0,1200}buildRetryDispatch\(retryable\.request/.test(sw), "run.retry maps the stored request onto its dispatch");
  assert(/async "run\.retry"[\s\S]{0,1600}handlers\[dispatch\.route\]/.test(sw), "run.retry re-dispatches through the original route");
  assert(sw.includes('import { buildRetryDispatch, retryRunId } from "../lib/run-retry.js";'), "the SW imports the run-retry helpers");

  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assert(ntp.includes('send("run.retry", { executionId: fr.executionId })'), "the sidebar Retry action calls run.retry");
  assert(/selectFailedRuns\(runs \?\? \[\], \{[\s\S]{0,200}dismissedIds/.test(ntp), "the sidebar projects failed runs through the pure helper (with lifecycle opts)");
  assert(ntp.includes('send("run.dismissFailed"'), "the sidebar persists dismissals through the durable tombstone route");
  assert(ntp.includes("refreshFailedRuns();"), "every task render refreshes the failed-runs section");
  const html = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));
  assert(html.includes('id="failed-runs"'), "the sidebar hosts the failed-runs section");
});
