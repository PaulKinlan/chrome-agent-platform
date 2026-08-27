// @ts-nocheck
// tests/agent-worker-durability.test.ts — Phase 3 Agent-Worker Durability KATs
// (CAP-FB-20260826-AGENT-WORKERS-01, Phase 3).
//
// Verifies:
//   1. agent-worker.progress: bounded, redacted journal appends + heartbeat updates + principal checking.
//   2. agent-worker.result: terminal result settlement + scheduler completion + principal checking.
//   3. agent-worker.journal-append: bounded OPFS memory journal appends + redaction + principal checking.
//   4. Crash model & recovery coherence with durable-runs authority.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createAgentWorkerRoutes } from "../extension/background/routes/agent-worker.js";
import { createDurableRunRegistry } from "../extension/lib/durable-runs.js";

// In-memory kv store mock
function createMockKv() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? { [k]: map.get(k) } : {}),
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) map.set(k, v); },
    has: async (k) => map.has(k),
    keys: async () => [...map.keys()],
    delete: async (k) => map.delete(k),
  };
}

class FakeStore {
  values = new Map();
  versions = new Map();
  isMaster = true;
  origin = "master";
  async get(key) { return structuredClone(this.values.get(key) ?? null); }
  async has(key) { return this.values.has(key); }
  async getVersion(key) { return this.versions.get(key) ?? 0; }
  async keys() { return [...this.values.keys()].sort(); }
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
  async delete(key) {
    this.values.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
  }
}

function createTestHarness() {
  const store = new FakeStore();
  const journal = [];
  const thread = [];
  const registry = createDurableRunRegistry({
    store,
    bootId: "boot-test",
    now: (() => { let n = 1000; return () => ++n; })(),
    resolveJournalStore: async () => ({ journal }),
    appendJournal: async (target, entry, _guard, executionId) => {
      target.journal.push(structuredClone({ ...entry, executionId }));
    },
    replaceCancellationJournal: async (target, entry) => {
      target.journal.push(structuredClone(entry));
    },
    commitThread: async (threadId, executionId, payload) => {
      thread.push({ threadId, executionId, ...structuredClone(payload) });
    },
    replaceCancellationThread: async (threadId, executionId, payload) => {
      thread.push({ threadId, executionId, ...structuredClone(payload) });
    },
    compensateJournal: async (target, receipt) => {
      target.journal = target.journal.filter((r) => r.id !== receipt?.id);
      return { ok: true };
    },
  });
  return { store, journal, thread, registry };
}

Deno.test("agent-worker.progress: enforces authorized extension principals", async () => {
  const kv = createMockKv();
  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
    kvSet: kv.set,
  });

  const validId = "exec:12345678-1234-4123-8123-123456789abc";

  // Unauthorized principals fail closed
  const pageRes = await routes["agent-worker.progress"](
    { executionId: validId, event: { type: "text", text: "hi" } },
    { principal: "page" },
  );
  assertEquals(pageRes.ok, false);
  assertEquals(pageRes.error, "unauthorized_principal");

  const unauthRes = await routes["agent-worker.progress"](
    { executionId: validId, event: { type: "text", text: "hi" } },
    { principal: "unmatched" },
  );
  assertEquals(unauthRes.ok, false);
  assertEquals(unauthRes.error, "unauthorized_principal");
});

Deno.test("agent-worker.progress: validates executionId and bounds/redacts events", async () => {
  const kv = createMockKv();
  const { registry } = createTestHarness();

  const executionId = "exec:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await registry.start({ executionId, taskPreview: "test task" });

  const broadcastEvents = [];
  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
    kvSet: kv.set,
    durableRegistry: registry,
    broadcastProgress: (ev) => broadcastEvents.push(ev),
  });

  // Invalid executionIds rejected
  const badIdRes = await routes["agent-worker.progress"](
    { executionId: "__proto__", event: { type: "text" } },
    { principal: "extension" },
  );
  assertEquals(badIdRes.ok, false);
  assertEquals(badIdRes.error, "invalid executionId");

  // Valid progress event with sensitive token and long string
  const longText = "Bearer secret-token-12345 api_key=xyz987 " + "x".repeat(3000);
  const progressRes = await routes["agent-worker.progress"](
    {
      executionId,
      agentId: "test-agent",
      event: {
        type: "tool-call",
        toolName: "fetch_data",
        toolArgs: { url: "https://example.com", auth: "Bearer secret-token-12345" },
        text: longText,
        step: 1,
        totalSteps: 3,
      },
      logKey: "tool-call:1",
    },
    { principal: "extension" },
  );
  assertEquals(progressRes.ok, true);
  assertEquals(progressRes.executionId, executionId);

  // Broadcast event received with redacted contents
  assertEquals(broadcastEvents.length, 1);
  const bc = broadcastEvents[0];
  assertEquals(bc.runId, executionId);
  assertEquals(bc.agentId, "test-agent");
  assert(bc.text.includes("Bearer [redacted]"));
  assert(!bc.text.includes("secret-token-12345"));
  assert(!bc.toolArgs.includes("secret-token-12345"));
  assert(bc.text.length <= 2050, "text is bounded");

  // Durable logs reflect the committed progress
  const logs = await registry.listLogs(executionId);
  assert(logs.length >= 2, "accepted + progress logged");
  const toolLog = logs.find((l) => l.idempotencyKey === "tool-call:1");
  assert(toolLog, "progress log key found");
  assert(!JSON.stringify(toolLog).includes("secret-token-12345"), "secret is redacted from durable log");
});

Deno.test("agent-worker.result: terminal result settlement and scheduler completion", async () => {
  const kv = createMockKv();
  const { registry } = createTestHarness();

  const executionId = "exec:11111111-2222-4333-8444-555555555555";
  await registry.start({ executionId, taskPreview: "scheduled job", scheduleName: "nightly-audit" });

  let scheduledDoneName = null;
  let scheduledDoneToken = null;

  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
    kvSet: kv.set,
    durableRegistry: registry,
    markScheduledDone: async (name, token) => {
      scheduledDoneName = name;
      scheduledDoneToken = token;
    },
  });

  // Unauthorized caller fails closed
  const unauthRes = await routes["agent-worker.result"](
    { executionId, ok: true, result: "done" },
    { principal: "page" },
  );
  assertEquals(unauthRes.ok, false);
  assertEquals(unauthRes.error, "unauthorized_principal");

  // Successful terminal result
  const res = await routes["agent-worker.result"](
    {
      executionId,
      ok: true,
      result: "audit completed successfully with api_key=secret-value",
      scheduleName: "nightly-audit",
      scheduleToken: "tok-123",
      logicalId: "nightly-audit",
    },
    { principal: "extension" },
  );
  assertEquals(res.ok, true);
  assertEquals(res.executionId, executionId);
  assertEquals(res.phase, "terminal");
  assertEquals(res.cancelled, false);

  // markScheduledDone was called
  assertEquals(scheduledDoneName, "nightly-audit");
  assertEquals(scheduledDoneToken, "tok-123");

  // Durable record phase updated to terminal
  const snapshot = await registry.list();
  const record = snapshot.runs.find((r) => r.executionId === executionId);
  assertEquals(record.phase, "terminal");
  assertEquals(record.terminal.ok, true);
  assert(!record.taskPreview.includes("secret-value"));
});

Deno.test("agent-worker.journal-append: appends bounded/redacted entries to target memory", async () => {
  const kv = createMockKv();
  const { registry } = createTestHarness();

  const executionId = "exec:22222222-3333-4444-8555-666666666666";
  await registry.start({ executionId, taskPreview: "journal task" });

  const targetMemory = new Map();
  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
    kvSet: kv.set,
    durableRegistry: registry,
    resolveJournalStore: async (target) => ({
      target,
      append: async (entry) => {
        const list = targetMemory.get(target) ?? [];
        list.push(entry);
        targetMemory.set(target, list);
        return { ok: true, id: entry.id };
      },
    }),
    journalAppend: async (memStore, entry) => await memStore.append(entry),
  });

  // Unauthorized caller fails closed
  const unauthRes = await routes["agent-worker.journal-append"](
    { target: "agent:coder", entry: { type: "task", task: "hello" } },
    { principal: "page" },
  );
  assertEquals(unauthRes.ok, false);

  // Valid append with secrets and executionId link
  const res = await routes["agent-worker.journal-append"](
    {
      target: "agent:coder",
      executionId,
      entry: {
        id: "entry-1",
        type: "tool-result",
        tool: "read_file",
        result: "file content with Bearer secret-auth-token and password=mysecret",
      },
      logKey: "entry-1",
    },
    { principal: "extension" },
  );
  assertEquals(res.ok, true);
  assertEquals(res.id, "entry-1");

  // Target memory has the appended entry with redacted tokens
  const entries = targetMemory.get("agent:coder");
  assertEquals(entries.length, 1);
  assert(entries[0].result.includes("Bearer [redacted]"));
  assert(entries[0].result.includes("password=[redacted]"));
  assert(!entries[0].result.includes("secret-auth-token"));

  // Durable log has the execution-linked log
  const logs = await registry.listLogs(executionId);
  const entryLog = logs.find((l) => l.idempotencyKey === "entry-1");
  assert(entryLog, "journal entry logged to durable log");
});

Deno.test("cancellation: cancelled execution rejects late worker commits and settles as cancelled", async () => {
  const kv = createMockKv();
  const { registry } = createTestHarness();

  const executionId = "exec:33333333-4444-4555-8666-777777777777";
  await registry.start({ executionId, taskPreview: "cancellable task" });

  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
    kvSet: kv.set,
    durableRegistry: registry,
  });

  // Owner cancels the run (tombstone-first in SW authority)
  await registry.cancel(executionId, { reason: "owner stopped task" });

  // Late worker result commit settles as cancelled
  const res = await routes["agent-worker.result"](
    { executionId, ok: true, result: "late worker output" },
    { principal: "extension" },
  );
  assertEquals(res.ok, true);
  assertEquals(res.phase, "cancelled");
  assertEquals(res.cancelled, true);
});

Deno.test("reconcile-on-wake: restores durable alive-set on service-worker boot", async () => {
  const kv = createMockKv();
  await kv.set({ "cap:agent-workers:alive": ["agent-1", "agent-2", "background-watcher"] });

  const ensuredIds = [];
  const { reconcileAgentWorkers } = await import("../extension/background/routes/agent-worker.js");

  // Mock chrome runtime message for offscreen host
  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === "agent-worker-host:ensure") {
          ensuredIds.push(msg.agentId);
          return { ok: true, created: true };
        }
        return { ok: false };
      },
    },
  };

  const outcome = await reconcileAgentWorkers({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
  });

  assertEquals(outcome.ok, true);
  assertEquals(outcome.reconciled, 3);
  assertEquals(outcome.total, 3);
  assertEquals(ensuredIds, ["agent-1", "agent-2", "background-watcher"]);
});
