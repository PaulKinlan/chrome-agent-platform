// ltkj.4.2 — an offscreen completion is never proof its model run still owns it.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runFencedEmscripten, isEmscriptenModelRunLive, dispatchEmscriptenForRun } from "../extension/lib/emscripten-run-fence.js";
import { createRunControl } from "../extension/lib/run-control.js";

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
  assertEquals(source.match(/preview: true/g)?.length, 3,
    "two Settings broker branches and the direct Settings call each require an explicit preview flag");
  assert(source.includes("if (!isLive()) return { ok: false, phase: \"failed\", error: \"emscripten_run_not_live\" };"),
    "native send must be gated again after asynchronous registry and host setup");
});
