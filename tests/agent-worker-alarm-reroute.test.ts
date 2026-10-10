// tests/agent-worker-alarm-reroute.test.ts — Phase 4 handleAlarm -> worker reroute
// @ts-nocheck
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import * as acorn from "npm:acorn";
import { createAgentWorkerRoutes } from "../extension/background/routes/agent-worker.js";
import { createRunControl } from "../extension/lib/run-control.js";
import { createDurableRunRegistry } from "../extension/lib/durable-runs.js";
import { resolveModelFromConfig, developerFeaturesOn } from "../extension/lib/provider.js";
import { LOCAL_ASSISTANT_MODEL_ID } from "../extension/lib/models/local-assistant.js";

import { createMemoryRunLogHandles } from "./fixtures/run-log-wal-memory.js";

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

function createTestDurableRegistry() {
  const store = new FakeStore();
  return createDurableRunRegistry({
    store,
    logHandleFor: (store.__logHandles ??= createMemoryRunLogHandles()),
    bootId: "boot-test-reroute",
    now: () => Date.now(),
    resolveJournalStore: async () => ({ journal: [] }),
    appendJournal: async () => {},
    replaceCancellationJournal: async () => {},
    commitThread: async () => {},
    replaceCancellationThread: async () => {},
    compensateJournal: async () => {},
  });
}

function walkAst(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walkAst(c, fn);
    } else if (child && typeof child === "object") {
      walkAst(child, fn);
    }
  }
}

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
  let scheduledDoneName = null;
  let scheduledDoneToken = null;
  let runSettledId = null;

  const realDurableRegistry = createTestDurableRegistry();

  const executionId = "exec:33333333-4444-4555-8666-777777777777";
  await realDurableRegistry.start({
    executionId,
    surface: "agent-worker:agent:weather-bot",
    kind: "scheduled",
    scheduleName: "agent:weather-bot",
  });

  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet: kv.get,
    kvSet: kv.set,
    durableRegistry: realDurableRegistry,
    markScheduledDone: async (name, token) => {
      scheduledDoneName = name;
      scheduledDoneToken = token;
      return { ok: true };
    },
    onRunSettled: (id) => { runSettledId = id; },
  });

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
  const listRes = await realDurableRegistry.list();
  const storedRun = listRes?.runs?.find((r) => r.executionId === executionId);
  assertEquals(storedRun?.phase, "terminal");
  assertEquals(storedRun?.terminal?.ok, true);
  assertEquals(storedRun?.terminal?.result, "task complete");
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

Deno.test("Falsifier 8srke / tha6o: production service worker and routes call durableRuns.settle and not settleRun", async () => {
  const swSrc = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const swAst = acorn.parse(swSrc, { ecmaVersion: "latest", sourceType: "module" });

  const routesSrc = await Deno.readTextFile(new URL("../extension/background/routes/agent-worker.js", import.meta.url));
  const routesAst = acorn.parse(routesSrc, { ecmaVersion: "latest", sourceType: "module" });

  // 1. Assert ZERO settleRun member expressions exist across production files
  const settleRunInSw = [];
  walkAst(swAst, (n) => {
    if (n.type === "MemberExpression" && (n.property?.name === "settleRun" || n.property?.value === "settleRun")) {
      settleRunInSw.push(n);
    }
  });
  assertEquals(settleRunInSw.length, 0, "No settleRun property access may exist in service-worker.js (8srke)");

  const settleRunInRoutes = [];
  walkAst(routesAst, (n) => {
    if (n.type === "MemberExpression" && (n.property?.name === "settleRun" || n.property?.value === "settleRun")) {
      settleRunInRoutes.push(n);
    }
  });
  assertEquals(settleRunInRoutes.length, 0, "No settleRun property access may exist in agent-worker.js (8srke)");

  // 2. Real product-path AST inspection: dispatchScheduledWorkerTask !dispatchRes?.ok branch
  let dispatchFn = null;
  walkAst(swAst, (n) => {
    if (n.type === "FunctionDeclaration" && n.id?.name === "dispatchScheduledWorkerTask") {
      dispatchFn = n;
    }
  });
  assert(dispatchFn, "dispatchScheduledWorkerTask function must exist in service-worker.js");

  let kickRefusalIf = null;
  walkAst(dispatchFn, (n) => {
    if (n.type === "IfStatement") {
      const t = n.test;
      if (t.type === "UnaryExpression" && t.operator === "!" && t.argument.type === "ChainExpression") {
        const expr = t.argument.expression;
        if (expr.type === "MemberExpression" && expr.object?.name === "dispatchRes" && expr.property?.name === "ok") {
          kickRefusalIf = n;
        }
      }
    }
  });
  assert(kickRefusalIf, "kick refusal if (!dispatchRes?.ok) block must exist in dispatchScheduledWorkerTask");

  let durableSettleMethod = null;
  walkAst(kickRefusalIf, (n) => {
    if (n.type === "CallExpression") {
      const callee = n.callee;
      if (callee.type === "MemberExpression" && callee.object?.name === "durableRuns") {
        durableSettleMethod = callee.property?.name;
      }
    }
  });
  assertEquals(durableSettleMethod, "settle", "dispatchScheduledWorkerTask kick refusal MUST call durableRuns.settle (8srke)");

  // 3. Mutation test: verify planted settleRun violation in kick refusal branch turns RED
  function findDurableCallInBranch(astNode) {
    let call = null;
    walkAst(astNode, (n) => {
      if (n.type === "CallExpression" && n.callee?.type === "MemberExpression" && n.callee.object?.name === "durableRuns") {
        call = n.callee.property?.name;
      }
    });
    return call;
  }
  const mutatedKickRefusalSrc = swSrc.replace(
    "await durableRuns.settle(executionId,",
    "await durableRuns.settleRun(executionId,"
  );
  const mutatedAst = acorn.parse(mutatedKickRefusalSrc, { ecmaVersion: "latest", sourceType: "module" });
  let mutatedDispatchFn = null;
  walkAst(mutatedAst, (n) => {
    if (n.type === "FunctionDeclaration" && n.id?.name === "dispatchScheduledWorkerTask") {
      mutatedDispatchFn = n;
    }
  });
  let mutatedKickRefusalIf = null;
  walkAst(mutatedDispatchFn, (n) => {
    if (n.type === "IfStatement" && n.test?.type === "UnaryExpression" && n.test.argument?.expression?.property?.name === "ok") {
      mutatedKickRefusalIf = n;
    }
  });
  const mutatedCall = findDurableCallInBranch(mutatedKickRefusalIf);
  assertEquals(mutatedCall, "settleRun", "Planted mutation correctly swaps method to settleRun");
  let mutationDetected = false;
  try {
    assertEquals(mutatedCall, "settle");
  } catch {
    mutationDetected = true;
  }
  assert(mutationDetected, "Validator MUST reject planted settleRun mutation");

  // 4. Runtime contract verification on real production createDurableRunRegistry
  const registry = createTestDurableRegistry();
  assert(typeof registry.settle === "function", "production durable registry MUST expose .settle");
  assertEquals(typeof registry.settleRun, "undefined", "production durable registry MUST NOT expose settleRun");

  const execId = "exec:11111111-2222-4333-8444-555555555555";
  await registry.start({ executionId: execId, surface: "agent-worker:default", kind: "scheduled" });
  const settled = await registry.settle(execId, {
    ok: false,
    phase: "failed",
    error: "worker_dispatch_failed",
  });
  assertEquals(settled.phase, "terminal");
  const listRes = await registry.list();
  const record = listRes?.runs?.find((r) => r.executionId === execId);
  assertEquals(record.phase, "terminal");
  assertEquals(record.terminal?.ok, false);
  assertEquals(record.terminal?.result, "worker_dispatch_failed");

  let threwTypeError = false;
  try {
    registry.settleRun(execId, { ok: false, phase: "failed" });
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

Deno.test("Falsifier w87od / xcjvk (fence.abort): production fence in service-worker.js exposes abort(reason) triggering lock.controller", async () => {
  const swSrc = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const swAst = acorn.parse(swSrc, { ecmaVersion: "latest", sourceType: "module" });

  const inspectFenceAbortReceiver = (ast: any): { foundFence: boolean; hasAbort: boolean; callsLockController: boolean } => {
    let fenceObj: any = null;
    walkAst(ast, (n) => {
      if (n.type === "VariableDeclarator" && n.id?.name === "fence" && n.init?.type === "ObjectExpression") {
        fenceObj = n.init;
      }
    });
    if (!fenceObj) return { foundFence: false, hasAbort: false, callsLockController: false };

    const abortProp = fenceObj.properties.find((p: any) => p.key?.name === "abort");
    if (!abortProp) return { foundFence: true, hasAbort: false, callsLockController: false };

    let callsLockController = false;
    walkAst(abortProp, (n) => {
      if (n.type === "CallExpression") {
        const callee = n.callee;
        // Verify receiver is specifically lock.controller (or lock.controller?.abort) (xcjvk)
        if (
          callee.type === "MemberExpression" &&
          callee.property?.name === "abort" &&
          callee.object?.type === "MemberExpression" &&
          callee.object.object?.name === "lock" &&
          callee.object.property?.name === "controller"
        ) {
          callsLockController = true;
        }
      }
    });
    return { foundFence: true, hasAbort: true, callsLockController };
  };

  const prodResult = inspectFenceAbortReceiver(swAst);
  assert(prodResult.foundFence, "production fence object expression must exist in service-worker.js");
  assert(prodResult.hasAbort, "fence MUST declare an abort method (w87od)");
  assert(prodResult.callsLockController, "fence.abort MUST invoke lock.controller.abort (w87od, xcjvk)");

  // Mutation-sensitivity verification: swapping the receiver off lock.controller MUST fail the assertion (xcjvk)
  assert(swSrc.includes("lock.controller?.abort"), "production service-worker.js must contain lock.controller?.abort target");
  const mutatedSwSrc = swSrc.replace("lock.controller?.abort(reason);", "lock.other?.abort(reason);");
  assert(mutatedSwSrc !== swSrc, "mutation must successfully substitute target receiver");
  const mutatedAst = acorn.parse(mutatedSwSrc, { ecmaVersion: "latest", sourceType: "module" });
  const mutantResult = inspectFenceAbortReceiver(mutatedAst);
  assertEquals(mutantResult.callsLockController, false, "mutated receiver (lock.other) must NOT satisfy callsLockController");

  // Prove assertion fails closed (RED) on mutant:
  assertThrows(
    () => {
      assert(mutantResult.callsLockController, "fence.abort MUST invoke lock.controller.abort (w87od, xcjvk)");
    },
    Error,
    "fence.abort MUST invoke lock.controller.abort (w87od, xcjvk)",
  );
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

Deno.test("Falsifier gj6kn: production completion latch in service-worker.js handles early arrivals without timeout", async () => {
  const swSrc = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const swAst = acorn.parse(swSrc, { ecmaVersion: "latest", sourceType: "module" });

  let regFn = null;
  let resolveFn = null;
  walkAst(swAst, (n) => {
    if (n.type === "FunctionDeclaration") {
      if (n.id?.name === "registerPendingWorkerRun") regFn = n;
      if (n.id?.name === "resolvePendingWorkerRun") resolveFn = n;
    }
  });
  assert(regFn, "registerPendingWorkerRun must exist in service-worker.js");
  assert(resolveFn, "resolvePendingWorkerRun must exist in service-worker.js");

  let checksSettled = false;
  let returnsPromiseResolve = false;
  walkAst(regFn, (n) => {
    if (n.type === "MemberExpression" && n.property?.name === "settled") checksSettled = true;
    if (n.type === "MemberExpression" && n.object?.name === "Promise" && n.property?.name === "resolve") returnsPromiseResolve = true;
  });
  assert(checksSettled, "registerPendingWorkerRun must check existing.settled (gj6kn)");
  assert(returnsPromiseResolve, "registerPendingWorkerRun must return Promise.resolve(existing.result) for early results (gj6kn)");

  let setsSettled = false;
  let setsResult = false;
  walkAst(resolveFn, (n) => {
    if (n.type === "AssignmentExpression" && n.left?.property?.name === "settled") setsSettled = true;
    if (n.type === "AssignmentExpression" && n.left?.property?.name === "result") setsResult = true;
  });
  assert(setsSettled, "resolvePendingWorkerRun must set entry.settled = true (gj6kn)");
  assert(setsResult, "resolvePendingWorkerRun must store result on entry (gj6kn)");
});

Deno.test("Falsifier f3zyj: restore fence check and durable run admission precede worker dispatch in service-worker.js", async () => {
  const swSrc = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const swAst = acorn.parse(swSrc, { ecmaVersion: "latest", sourceType: "module" });

  let dispatchFn = null;
  walkAst(swAst, (n) => {
    if (n.type === "FunctionDeclaration" && n.id?.name === "dispatchScheduledWorkerTask") {
      dispatchFn = n;
    }
  });
  assert(dispatchFn, "dispatchScheduledWorkerTask must exist in service-worker.js");

  let restoreFencePos = -1;
  let admitPos = -1;
  let dispatchCallPos = -1;

  for (let i = 0; i < dispatchFn.body.body.length; i++) {
    const stmt = dispatchFn.body.body[i];
    walkAst(stmt, (n) => {
      if (n.type === "Literal" && n.value === "cap:restoreFence" && restoreFencePos === -1) restoreFencePos = i;
      if (n.type === "CallExpression" && n.callee?.name === "admitDurableRun" && admitPos === -1) admitPos = i;
      if (n.type === "CallExpression" && n.callee?.name === "dispatchRoute" && n.arguments[0]?.value === "agent-worker.dispatch" && dispatchCallPos === -1) {
        dispatchCallPos = i;
      }
    });
  }

  assert(restoreFencePos !== -1, "cap:restoreFence pre-check must exist");
  assert(admitPos !== -1, "admitDurableRun must exist");
  assert(dispatchCallPos !== -1, "dispatchRoute(agent-worker.dispatch) must exist");

  assert(restoreFencePos < dispatchCallPos, "restore fence check must precede dispatch (f3zyj)");
  assert(admitPos < dispatchCallPos, "admitDurableRun must precede dispatch (f3zyj/gj6kn)");
});
