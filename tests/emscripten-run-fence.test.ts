// ltkj.4.2 — an offscreen completion is never proof its model run still owns it.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runFencedEmscripten, isEmscriptenModelRunLive, dispatchEmscriptenForRun } from "../extension/lib/emscripten-run-fence.js";
import { createRunControl } from "../extension/lib/run-control.js";
import { createAgent } from "../extension/lib/agent.js";
import { installFakeIdb } from "./fake-idb.js";
import { installFakeLocks } from "./fake-locks.js";

const RUN = `exec:${"a".repeat(8)}-${"a".repeat(4)}-4aaa-8aaa-${"a".repeat(12)}`;

Deno.test("Emscripten run fence: only the exact live model run/agent may start", async () => {
  const active = new Set([RUN]);
  const signal = new AbortController();
  const live = ({ runId, agentId }) => isEmscriptenModelRunLive({
    runId, agentId, signal: signal.signal, active,
    cancelled: new Set(), ended: new Set(), workerRun: { kind: "task", surface: null },
  });
  let called = 0;
  const dispatch = async () => { called++; return { ok: true, phase: "completed", result: "safe" }; };
  for (const context of [
    { runId: "settings-preview-1", agentId: "hub" },
    { runId: "exec:other", agentId: "hub" },
    { runId: RUN, agentId: "" },
    { runId: RUN, agentId: "named:mallory" },
  ]) {
    assertEquals((await runFencedEmscripten({ context, isLive: live, dispatch })).error, "emscripten_run_not_live");
  }
  assertEquals(called, 0, "no native call on an unowned identity");
  const success = await runFencedEmscripten({ context: { runId: RUN, agentId: null }, isLive: live, dispatch });
  assertEquals(success.result, "safe");
  assertEquals(called, 1);
});

Deno.test("Emscripten run fence: cancellation during host response suppresses completion", async () => {
  const active = new Set([RUN]);
  const cancelled = new Set();
  const context = { runId: RUN, agentId: "named:canary" };
  const isLive = ({ runId, agentId }) => isEmscriptenModelRunLive({
    runId, agentId, active, cancelled, ended: new Set(), workerRun: { kind: "agent", surface: "named:canary" },
  });
  let finish;
  const pending = runFencedEmscripten({ context, isLive, dispatch: () => new Promise((resolve) => { finish = resolve; }) });
  assert(typeof finish === "function", "host invoked only after live check");
  cancelled.add(RUN);
  finish({ ok: true, phase: "completed", result: "late secret" });
  assertEquals(await pending, { ok: false, phase: "failed", error: "emscripten_run_not_live" });
});

Deno.test("Emscripten run fence: worker identity must match agent surface; abort/ended fail closed", () => {
  const active = new Set([RUN]);
  const base = { runId: RUN, agentId: "named:alice", active, cancelled: new Set(), ended: new Set() };
  assertEquals(isEmscriptenModelRunLive({ ...base, workerRun: { kind: "worker", surface: "agent-worker:named:bob" } }), false);
  assertEquals(isEmscriptenModelRunLive({ ...base, workerRun: { kind: "worker", surface: "agent-worker:named:alice" } }), true);
  assertEquals(isEmscriptenModelRunLive({ ...base, workerRun: { kind: "agent", surface: "named:alice" } }), true,
    "ordinary SW-owned agent runs have a non-worker runControl record and remain live");
  assertEquals(isEmscriptenModelRunLive({ ...base, workerRun: { kind: "agent", surface: "named:bob" } }), false,
    "a named agent must not publish another agent's completion");
  assertEquals(isEmscriptenModelRunLive({ ...base, workerRun: null }), false,
    "a missing runControl record cannot attest agent identity");
  assertEquals(isEmscriptenModelRunLive({ ...base, workerRun: { kind: "task", surface: null } }), false,
    "a named agent must not borrow a hub run");
  assertEquals(isEmscriptenModelRunLive({ ...base, agentId: null, workerRun: { kind: "task", surface: null } }), true,
    "hub runs have a null agent surface, not the synthetic string 'hub'");
  assertEquals(isEmscriptenModelRunLive({ ...base, ended: new Set([RUN]) }), false);
  const controller = new AbortController(); controller.abort();
  assertEquals(isEmscriptenModelRunLive({ ...base, signal: controller.signal }), false);
  assertEquals(isEmscriptenModelRunLive({ ...base, active: new Set(), workerRun: null }), false);
});

Deno.test("Emscripten run fence: every canonical execution id shape is live only with its own registry record", () => {
  for (const runId of [
    "exec:aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa", "exec_abcdefgh", "acp:pi:session:xyz123",
  ]) {
    const active = new Set([runId]);
    const base = { runId, agentId: null, active, cancelled: new Set(), ended: new Set(), workerRun: { kind: "task", surface: null } };
    assertEquals(isEmscriptenModelRunLive(base), true, `${runId} is a valid live execution id`);
    assertEquals(isEmscriptenModelRunLive({ ...base, active: new Set() }), false);
  }
  assertEquals(isEmscriptenModelRunLive({ runId: "settings-preview-1", agentId: null, active: new Set(["settings-preview-1"]), workerRun: { kind: "task", surface: null } }), false);
});

Deno.test("Emscripten run fence: Settings preview bypasses model liveness, but model completions cannot", async () => {
  let sent = 0;
  const dispatch = async (isLive) => { sent++; return { ok: isLive(), result: "scalar" }; };
  const context = { runId: "settings-preview-1", agentId: null };
  assertEquals(await dispatchEmscriptenForRun({ preview: true, context, isLive: () => false, dispatch }), { ok: true, result: "scalar" });
  assertEquals(sent, 1);
  assertEquals((await dispatchEmscriptenForRun({ preview: false, context, isLive: () => false, dispatch })).error, "emscripten_run_not_live");
  assertEquals(sent, 1, "refused model work never reaches the host");
});

Deno.test("Emscripten run fence: actual SW runControl records bind hub/named identity through dispatch", async () => {
  const runControl = createRunControl();
  const active = new Set([RUN]);
  const cancelled = new Set();
  runControl.register({ executionId: RUN, surface: "named:alice", kind: "agent" });
  const dispatch = async (isLive) => ({ ok: isLive(), result: "scalar" });
  const call = (runSurfaceRef) => {
    // createAgent's id is ALWAYS "hub" even for named/background runs. The
    // immutable SW run identity supplies a distinct surface to the broker.
    const toolContext = { runId: RUN, agentId: "hub", runSurfaceRef };
    const context = { runId: toolContext.runId, agentId: toolContext.runSurfaceRef };
    const isLive = () => isEmscriptenModelRunLive({
      ...context, active, cancelled, ended: new Set(), workerRun: runControl.get(RUN),
    });
    return dispatchEmscriptenForRun({ context, isLive, dispatch });
  };
  assertEquals(await call("named:alice"), { ok: true, result: "scalar" });
  assertEquals((await call("named:bob")).error, "emscripten_run_not_live");
  runControl.unregister(RUN);
  runControl.register({ executionId: RUN, surface: null, kind: "task" });
  assertEquals(await call(null), { ok: true, result: "scalar" }, "hub is the null surface in the actual registry");
  cancelled.add(RUN);
  assertEquals((await call(null)).error, "emscripten_run_not_live");
});

Deno.test("Emscripten run fence: service worker uses a model fence and an explicit Settings preview", async () => {
  const source = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(source.includes("dispatchEmscriptenForRun({ preview, context: fencedContext, isLive, dispatch })"),
    "model and Settings branches must share the tested dispatch seam");
  assert(source.includes("agentId: context?.runSurfaceRef"), "model fence must use the SW-issued surface, not createAgent's static hub id");
  assert(source.includes("runSurfaceRef: agentSurfaceRef ?? null"), "the SW must place the exact registered surface into the immutable run identity");
  const agent = await Deno.readTextFile(new URL("../extension/lib/agent.js", import.meta.url));
  assert(agent.includes('runSurfaceRef: ownData(identityInput, "runSurfaceRef")'), "agent run identity must retain the SW surface");
  assert(agent.includes('runSurfaceRef: ownData(activeRun.identity, "runSurfaceRef")'), "agent lazy context must project the immutable surface");

  // Assert the three distinct Settings preview execution sites individually, rather than
  // an exact global occurrence count across the entire service worker (y7khr).
  const toolPackageRun = source.slice(source.indexOf('"tool.package.run"('), source.indexOf('"tool.preview.run"('));

  const graphDigestBranch = toolPackageRun.slice(
    toolPackageRun.indexOf('if (typeof graphDigest === "string")'),
    toolPackageRun.indexOf('return await record.dispatch'),
  );
  assert(/dispatchEmscriptenRun\([\s\S]*?preview:\s*true/.test(graphDigestBranch),
    "tool.package.run custom graphDigest dispatch requires preview: true");

  const recordDispatchCall = toolPackageRun.slice(
    toolPackageRun.indexOf('return await record.dispatch'),
    toolPackageRun.indexOf('// Call Path 1'),
  );
  assert(/record\.dispatch\([\s\S]*?preview:\s*true/.test(recordDispatchCall),
    "tool.package.run broker record dispatch requires preview: true");

  const callPath1 = toolPackageRun.slice(
    toolPackageRun.indexOf('// Call Path 1: Settings direct run to broker dispatch'),
  );
  assert(/dispatchEmscriptenRun\([\s\S]*?preview:\s*true/.test(callPath1),
    "tool.package.run Call Path 1 direct Settings run requires preview: true");

  assert(source.includes("if (!isLive()) return { ok: false, phase: \"failed\", error: \"emscripten_run_not_live\" };"),
    "native send must be gated again after asynchronous registry and host setup");
});

Deno.test("Emscripten run fence: createAgent model run projects runSurfaceRef into lazy tool dispatch context (y7khr)", async () => {
  installFakeIdb();
  installFakeLocks();

  const prevChrome = globalThis.chrome;
  globalThis.chrome = {
    ...prevChrome,
    runtime: {
      ...prevChrome?.runtime,
      getURL: (p) => "chrome-extension://fake/" + p,
    },
  };

  try {
    let observedContext = null;
    const observerToolRecord = {
      descriptorInput: {
        name: "observe_surface_tool",
        toolId: "observe_surface_tool",
        description: "Observes surface ref in lazy dispatch context",
        sourceKind: "extension-builtin",
        packageId: "cap.test-tools",
        version: "1.0.0",
        digest: "d1",
        packageDigest: "pd1",
        capabilityDigest: "cd1",
        permissionDigest: "none",
        grantDigest: "none",
        capabilities: ["test"],
        scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
        sourceGeneration: "gen-1",
        availability: "ready",
        dispatcherKind: "builtin",
      },
      validateArguments: async (args) => ({ ok: true, data: args }),
      authorize: async () => ({ ok: true, permissionDigest: "none", grantDigest: "none" }),
      dispatch: async (args, ctx) => {
        observedContext = ctx;
        return { ok: true, result: "observed" };
      },
    };

    let step = 0;
    const modelOutputs = [];
    const scriptedModel = {
      specificationVersion: "v2",
      provider: "test",
      modelId: "test-fence-model",
      supportedUrls: {},
      async doStream(options) {
        step += 1;
        for (const m of options.prompt ?? []) {
          if (m?.role !== "tool") continue;
          for (const part of m.content ?? []) modelOutputs.push(JSON.stringify(part.output ?? part));
        }
        if (step === 1) {
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: "stream-start", warnings: [] });
                c.enqueue({
                  type: "tool-call",
                  toolCallId: "call_search",
                  toolName: "search_tools",
                  input: JSON.stringify({ query: "observe_surface_tool", limit: 1 }),
                });
                c.enqueue({ type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: "tool-calls" });
                c.close();
              },
            }),
          };
        }
        if (step === 2) {
          const blob = modelOutputs.join("\n");
          const match = blob.match(/selectionRef\\+":\\+"(sel_[0-9a-f]+)/);
          assert(match, `search_tools must return selectionRef for observe_surface_tool, got: ${blob}`);
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: "stream-start", warnings: [] });
                c.enqueue({
                  type: "tool-call",
                  toolCallId: "call_exec",
                  toolName: "execute_tool",
                  input: JSON.stringify({ selectionRef: match[1], arguments: {} }),
                });
                c.enqueue({ type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: "tool-calls" });
                c.close();
              },
            }),
          };
        }
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "stream-start", warnings: [] });
              c.enqueue({ type: "text-start", id: "t" });
              c.enqueue({ type: "text-delta", id: "t", delta: "Done" });
              c.enqueue({ type: "text-end", id: "t" });
              c.enqueue({ type: "finish", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: "stop" });
              c.close();
            },
          }),
        };
      },
    };

    const memoryStore = new Map();
    const agent = createAgent({
      model: { model: scriptedModel, modelId: "test-fence-model", providerName: "test" },
      id: "hub",
      name: "hub",
      system: "test",
      memory: {
        async get(k) { return memoryStore.get(k); },
        async set(k, v) { memoryStore.set(k, v); return { ok: true }; },
        async has(k) { return memoryStore.has(k); },
        async list() { return [...memoryStore.keys()]; },
        async clear() { memoryStore.clear(); return { ok: true }; },
      },
      readLazySources: async () => [observerToolRecord],
    });

    const executionId = `exec:test-${crypto.randomUUID()}`;
    await agent.run("run tool", "", [], null, null, {
      runId: executionId,
      taskId: "task-test-surface",
      runSurfaceRef: "named:alice",
    });

    assert(observedContext, "lazy tool dispatch must be invoked during model run");
    assertEquals(observedContext.runSurfaceRef, "named:alice", "runSurfaceRef must project through agent run into dispatch context");
    assertEquals(observedContext.agentId, "hub", "agentId must remain master hub id");
    assertEquals(observedContext.runId, executionId, "runId must match the active run execution id");
  } finally {
    globalThis.chrome = prevChrome;
  }
});
