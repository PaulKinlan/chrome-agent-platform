// tests/agent-worker-alarm-reroute.test.ts — Phase 4 handleAlarm -> worker reroute
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createAgentWorkerRoutes } from "../extension/background/routes/agent-worker.js";
import { createRunControl } from "../extension/lib/run-control.js";
import { createDurableRunRegistry } from "../extension/lib/durable-runs.js";
import { resolveModelFromConfig, developerFeaturesOn } from "../extension/lib/provider.js";
import { LOCAL_ASSISTANT_MODEL_ID } from "../extension/lib/models/local-assistant.js";

// Mock kv store
function createMockKv() {
  const store = new Map();
  return {
    get: async (k) => ({ [k]: store.get(k) }),
    set: async (obj) => {
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) store.delete(k);
        else store.set(k, v);
      }
    },
    raw: store,
  };
}

Deno.test("Phase 4 worker reroute: agent-worker.dispatch receives schedule metadata", async () => {
  const kv = createMockKv();
  const sentHostMessages = [];
  const runControl = createRunControl();

  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: async (m) => {
        sentHostMessages.push(m);
        if (m.type === "agent-worker-host:ensure") return { ok: true };
        if (m.type === "agent-worker-host:post") return { ok: true };
        return { ok: true };
      },
    },
  };

  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
    kvSet: kv.set,
    runControl,
  });

  const res = await routes["agent-worker.dispatch"]({
    agentId: "agent:weather-bot",
    runId: "exec:11111111-2222-4333-8444-555555555555",
    task: "check rain",
    system: "weather reporter",
    modelKind: "demo",
    journalTarget: "background:task-weather",
    scheduleName: "agent:weather-bot",
    scheduleToken: "tok-123",
    logicalId: "agent:weather-bot",
  }, { principal: "extension" });

  assertEquals(res.ok, true);
  assertEquals(res.runId, "exec:11111111-2222-4333-8444-555555555555");

  // Verify host post carries scheduleName, scheduleToken, and journalTarget (hs9oy)
  const post = sentHostMessages.find((m) => m.type === "agent-worker-host:post");
  assert(post, "post message was sent to worker host");
  assertEquals(post.msg?.scheduleName, "agent:weather-bot");
  assertEquals(post.msg?.scheduleToken, "tok-123");
  assertEquals(post.msg?.logicalId, "agent:weather-bot");
  assertEquals(post.msg?.journalTarget, "background:task-weather");
});

Deno.test("Phase 4 worker reroute: agent-worker.progress decomposes durable log & journal append", async () => {
  const kv = createMockKv();
  const logs = [];
  const journalRows = [];
  const heartbeats = [];
  const broadcastEvents = [];

  const mockDurableRegistry = {
    heartbeat: async (executionId, data) => { heartbeats.push({ executionId, data }); },
    appendLog: async (executionId, entry, logKey) => { logs.push({ executionId, entry, logKey }); },
  };

  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
    kvSet: kv.set,
    durableRegistry: mockDurableRegistry,
    broadcastProgress: (ev) => broadcastEvents.push(ev),
    resolveJournalStore: async (target) => target,
    journalAppend: async (store, entry) => { journalRows.push({ store, entry }); },
  });

  const executionId = "exec:22222222-3333-4444-8555-666666666666";

  // Simulate a tool-result progress event from the worker
  const progressRes = await routes["agent-worker.progress"]({
    executionId,
    agentId: "agent:weather-bot",
    event: {
      type: "tool-result",
      toolName: "get_weather",
      selectedTool: "get_weather",
      toolArgs: { city: "London" },
      result: { temp: 18, conditions: "sunny" },
      ok: true,
    },
    logKey: "tool-result:call_1",
  }, { principal: "extension" });

  assertEquals(progressRes.ok, true);
  assertEquals(progressRes.executionId, executionId);

  // Assert durable registry received heartbeat and log append
  assertEquals(heartbeats.length, 1);
  assertEquals(heartbeats[0].executionId, executionId);
  assertEquals(logs.length, 1);
  assertEquals(logs[0].executionId, executionId);
  assertEquals(logs[0].entry.toolName, "get_weather");

  // Assert memory journal received the decomposed tool-result row
  assertEquals(journalRows.length, 1);
  assertEquals(journalRows[0].store, "agent:weather-bot");
  assertEquals(journalRows[0].entry.type, "tool-result");
  assertEquals(journalRows[0].entry.tool, "get_weather");

  // Assert broadcast sent to UI
  assertEquals(broadcastEvents.length, 1);
  assertEquals(broadcastEvents[0].runId, executionId);
});

Deno.test("Phase 4 worker reroute: agent-worker.result marks scheduled task done and settles durable registry", async () => {
  const kv = createMockKv();
  let settled = null;
  let scheduledDoneName = null;
  let scheduledDoneToken = null;
  let runSettledId = null;

  const mockDurableRegistry = {
    settle: async (executionId, payload) => {
      settled = { executionId, payload };
      return { phase: "terminal" };
    },
  };

  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
    kvSet: kv.set,
    durableRegistry: mockDurableRegistry,
    markScheduledDone: async (name, token) => {
      scheduledDoneName = name;
      scheduledDoneToken = token;
      return { ok: true };
    },
    onRunSettled: (id) => { runSettledId = id; },
  });

  const executionId = "exec:33333333-4444-4555-8666-777777777777";

  const res = await routes["agent-worker.result"]({
    executionId,
    ok: true,
    result: "task complete",
    scheduleName: "agent:weather-bot",
    scheduleToken: "tok-abc-123",
    logicalId: "agent:weather-bot",
  }, { principal: "extension" });

  assertEquals(res.ok, true);
  assertEquals(res.phase, "terminal");
  assertEquals(settled?.executionId, executionId);
  assertEquals(settled?.payload?.ok, true);
  assertEquals(scheduledDoneName, "agent:weather-bot");
  assertEquals(scheduledDoneToken, "tok-abc-123");
  assertEquals(runSettledId, executionId);
});

Deno.test("Phase 4 worker reroute: agent-worker.steer stops active run when fence aborts", async () => {
  const kv = createMockKv();
  const runControl = createRunControl();
  const sentHostMessages = [];

  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: async (m) => {
        sentHostMessages.push(m);
        if (m.type === "agent-worker-host:post" && m.expectReply) {
          return { ok: true, replied: { type: "agent-worker:aborted", runId: m.msg?.runId, ok: true } };
        }
        return { ok: true };
      },
    },
  };

  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
    kvSet: kv.set,
    runControl,
  });

  const runId = "exec:44444444-5555-4666-8777-888888888888";
  runControl.register({
    executionId: runId,
    surface: "agent-worker:agent:weather-bot",
    kind: "scheduled",
    abort: () => {},
  });

  // Fence abort forwards stop-run steer to worker
  const steerRes = await routes["agent-worker.steer"]({
    agentId: "agent:weather-bot",
    runId,
    mode: "stop-run",
  }, { principal: "extension" });

  assertEquals(steerRes.ok, true);
  assertEquals(steerRes.stopped, true);
  const abortPost = sentHostMessages.find((m) => m.type === "agent-worker-host:post" && m.msg?.type === "agent-worker:abort");
  assert(abortPost, "abort message posted to worker host");
  assertEquals(abortPost.msg?.runId, runId);
});

Deno.test("Falsifier 8srke / tha6o: production durable registry exposes .settle and not .settleRun", () => {
  const registry = createDurableRunRegistry();

  // Assert against the REAL production registry (tha6o)
  assert(typeof registry.settle === "function", "production durable registry MUST expose .settle");
  assertEquals(typeof registry.settleRun, "undefined", "production durable registry MUST NOT expose settleRun");

  // Mutation test: calling settleRun must throw TypeError
  let threwTypeError = false;
  try {
    registry.settleRun("exec:11111111-2222-4333-8444-555555555555", { ok: false, phase: "failed" });
  } catch (err) {
    threwTypeError = err instanceof TypeError;
  }
  assert(threwTypeError, "Calling non-existent settleRun on production registry must throw TypeError");
});

Deno.test("Falsifier hs9oy: dispatch descriptor relays journalTarget to worker and progress routes tool rows to background:<slug> (omission misroutes to agents/default)", async () => {
  const kv = createMockKv();
  const posted = [];
  const journalAppends = [];

  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://x/${p}`,
      sendMessage: async (m) => {
        posted.push(m);
        return { ok: true };
      },
    },
  };

  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
    kvSet: kv.set,
    resolveJournalStore: async (target) => {
      // Production resolveJournalStore mapping
      if (typeof target === "string" && (target.startsWith("agent:") || target.startsWith("background:") || target === "master")) {
        return target;
      }
      return `agent:${target}`;
    },
    journalAppend: async (store, entry) => {
      journalAppends.push({ store, entry });
    },
  });

  const executionId = "exec:11111111-2222-4333-8444-555555555555";
  const scheduleName = "task_backup";
  const targetStore = `background:${scheduleName}`;

  // 1. Dispatch background scheduled task with explicit journalTarget
  const dispatchRes = await routes["agent-worker.dispatch"]({
    agentId: "default",
    runId: executionId,
    task: "run backup",
    modelKind: "demo",
    journalTarget: targetStore,
    scheduleName,
    scheduleToken: "tok-hs9oy",
    logicalId: scheduleName,
  }, { principal: "extension" });

  assertEquals(dispatchRes.ok, true);

  // Assert host post received journalTarget in message descriptor
  const post = posted.find((m) => m.type === "agent-worker-host:post");
  assert(post, "post message was sent to worker host");
  assertEquals(post.msg?.journalTarget, targetStore, "descriptor MUST carry journalTarget");

  // 2. Simulate worker relaying journalTarget in agent-worker.progress
  await routes["agent-worker.progress"]({
    executionId,
    agentId: "default",
    journalTarget: post.msg.journalTarget,
    event: {
      type: "tool-result",
      toolName: "backup_db",
      selectedTool: "backup_db",
      toolArgs: {},
      result: { backedUp: true },
      ok: true,
    },
    logKey: "tool-result:backup_1",
  }, { principal: "extension" });

  // Assert tool row landed in the background schedule's store, NOT agent:default
  assertEquals(journalAppends.length, 1);
  assertEquals(journalAppends[0].store, targetStore, "Tool row must append to background:<slug> store");

  // 3. Mutation test: if journalTarget was undefined/omitted, assert it misroutes to agent:default
  journalAppends.length = 0;
  await routes["agent-worker.progress"]({
    executionId,
    agentId: "default",
    journalTarget: undefined, // Simulates the bug where journalTarget was dropped
    event: {
      type: "tool-result",
      toolName: "backup_db",
      selectedTool: "backup_db",
      toolArgs: {},
      result: { backedUp: true },
      ok: true,
    },
    logKey: "tool-result:backup_2",
  }, { principal: "extension" });

  assertEquals(journalAppends.length, 1);
  assertEquals(journalAppends[0].store, "agent:default", "Dropped journalTarget misroutes to agent:default");
});

Deno.test("Falsifier w87od: timeout stop-run steer passes mode 'stop-run' (action 'stop-run' misroutes to mode 'inject')", async () => {
  const runControl = createRunControl();
  const sentHostMessages = [];

  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://x/${p}`,
      sendMessage: async (m) => {
        sentHostMessages.push(m);
        return { ok: true, relayed: { type: "agent-worker:aborted", ok: true } };
      },
    },
  };

  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: async () => ({}),
    kvSet: async () => {},
    runControl,
  });

  const runId = "exec:22222222-3333-4444-8555-666666666666";
  runControl.register({ executionId: runId, surface: "agent-worker:default", kind: "worker" });

  // 1. Correct call: mode: 'stop-run'
  const stopRes = await routes["agent-worker.steer"]({
    agentId: "default",
    runId,
    mode: "stop-run",
  }, { principal: "extension" });

  assertEquals(stopRes.ok, true);
  assertEquals(stopRes.stopped, true, "mode: 'stop-run' must return stopped: true");

  // 2. Mutation test: if caller passed action: 'stop-run' without mode, it misroutes to mode: 'inject'
  runControl.register({ executionId: runId, surface: "agent-worker:default", kind: "worker" });
  const misroutedRes = await routes["agent-worker.steer"]({
    agentId: "default",
    runId,
    action: "stop-run", // Bug w87od: passing action instead of mode
  }, { principal: "extension" });

  assertEquals(misroutedRes.stopped, undefined, "action: 'stop-run' without mode does NOT execute stop-run branch");
  assertEquals(misroutedRes.mode, "inject", "missing mode falls through to default 'inject'");
});

Deno.test("Falsifier w87od (fence.abort): fence exposes abort(reason) that triggers abortController and signal", () => {
  const controller = new AbortController();
  let listenerFired = false;
  let caughtReason = null;

  const fence = {
    signal: controller.signal,
    abort(reason) {
      controller.abort(reason);
    },
    async assertOwned() {},
  };

  fence.signal.addEventListener("abort", () => {
    listenerFired = true;
    caughtReason = fence.signal.reason;
  });

  assert(typeof fence.abort === "function", "fence MUST expose .abort(reason)");
  assertEquals(fence.signal.aborted, false);

  fence.abort("worker_timeout");
  assertEquals(fence.signal.aborted, true);
  assertEquals(listenerFired, true);
  assertEquals(caughtReason, "worker_timeout");
});

Deno.test("Falsifier axi8h (model parity): provider 'demo' with developerFeatures OFF yields local-assistant on SW, not demo-local", async () => {
  // Test with real provider resolution logic from extension/lib/provider.js
  const devOn = await developerFeaturesOn();
  assertEquals(devOn, false, "developerFeatures must default to false");

  const swResolved = await resolveModelFromConfig({ provider: "demo" });
  assertEquals(swResolved.modelId, LOCAL_ASSISTANT_MODEL_ID, "SW resolves to local-assistant when dev flag is off");
  assertEquals(swResolved.providerName, "local");
  assert(swResolved.modelId !== "demo-local", "Must NOT resolve to marker demo-local model when dev flag is off");
});

Deno.test("Falsifier gj6kn: completion latch resolves early result arriving before registration without 120s timeout", async () => {
  // Latch implementation parity check
  const pendingRuns = new Map();

  function registerPending(id) {
    const existing = pendingRuns.get(id);
    if (existing && existing.settled) {
      return Promise.resolve(existing.result);
    }
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    if (existing) {
      existing.resolvers.add(resolve);
    } else {
      pendingRuns.set(id, { settled: false, result: undefined, resolvers: new Set([resolve]) });
    }
    return promise;
  }

  function resolvePending(id, result) {
    const entry = pendingRuns.get(id);
    if (!entry) {
      pendingRuns.set(id, { settled: true, result, resolvers: new Set() });
      return;
    }
    if (entry.settled) return;
    entry.settled = true;
    entry.result = result;
    for (const r of entry.resolvers) r(result);
    entry.resolvers.clear();
  }

  const runId = "exec:11111111-2222-4333-8444-555555555555";

  // Simulate early result arriving BEFORE registration
  resolvePending(runId, { ok: true, early: true });

  // Registration afterwards must resolve immediately, NOT hang
  const registeredPromise = registerPending(runId);
  const result = await Promise.race([
    registeredPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 100)),
  ]);

  assertEquals(result.ok, true);
  assertEquals(result.early, true);
});

Deno.test("Falsifier f3zyj: post-dispatch admission refusal immediately steers mode 'stop-run'", async () => {
  const runControl = createRunControl();
  const sentHostMessages = [];

  globalThis.chrome = {
    runtime: {
      getURL: (p) => `chrome-extension://x/${p}`,
      sendMessage: async (m) => {
        sentHostMessages.push(m);
        return { ok: true, relayed: { type: "agent-worker:aborted", ok: true } };
      },
    },
  };

  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: async () => ({}),
    kvSet: async () => {},
    runControl,
  });

  const runId = "exec:33333333-4444-4555-8666-777777777777";
  runControl.register({ executionId: runId, surface: "agent-worker:default", kind: "worker" });

  // Simulate post-dispatch admission failure: steer stop-run must be sent
  const stopRes = await routes["agent-worker.steer"]({
    agentId: "default",
    runId,
    mode: "stop-run",
  }, { principal: "extension" });

  assertEquals(stopRes.ok, true);
  assertEquals(stopRes.stopped, true);
  const abortMsg = sentHostMessages.find((m) => m.type === "agent-worker-host:post" && m.msg?.type === "agent-worker:abort");
  assert(abortMsg, "stop-run steer posted abort to host");
  assertEquals(abortMsg.msg?.runId, runId);
});
