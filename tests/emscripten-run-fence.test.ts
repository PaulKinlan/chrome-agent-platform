// ltkj.4.2 — an offscreen completion is never proof its model run still owns it.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runFencedEmscripten, isEmscriptenModelRunLive } from "../extension/lib/emscripten-run-fence.js";

const RUN = `exec:${"a".repeat(8)}-${"a".repeat(4)}-4aaa-8aaa-${"a".repeat(12)}`;

Deno.test("Emscripten run fence: only the exact live model run/agent may start", async () => {
  const active = new Set([RUN]);
  const signal = new AbortController();
  const live = ({ runId, agentId }) => isEmscriptenModelRunLive({
    runId, agentId, signal: signal.signal, active,
    cancelled: new Set(), ended: new Set(), workerRun: null,
  });
  let called = 0;
  const dispatch = async () => { called++; return { ok: true, phase: "completed", result: "safe" }; };
  for (const context of [
    { runId: "settings-preview-1", agentId: "hub" },
    { runId: "exec:other", agentId: "hub" },
    { runId: RUN, agentId: "" },
  ]) {
    assertEquals((await runFencedEmscripten({ context, isLive: live, dispatch })).error, "emscripten_run_not_live");
  }
  assertEquals(called, 0, "no native call on an unowned identity");
  const success = await runFencedEmscripten({ context: { runId: RUN, agentId: "hub" }, isLive: live, dispatch });
  assertEquals(success.result, "safe");
  assertEquals(called, 1);
});

Deno.test("Emscripten run fence: cancellation during host response suppresses completion", async () => {
  const active = new Set([RUN]);
  const cancelled = new Set();
  const context = { runId: RUN, agentId: "named:canary" };
  const isLive = ({ runId, agentId }) => isEmscriptenModelRunLive({
    runId, agentId, active, cancelled, ended: new Set(), workerRun: null,
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
  assertEquals(isEmscriptenModelRunLive({ ...base, ended: new Set([RUN]) }), false);
  const controller = new AbortController(); controller.abort();
  assertEquals(isEmscriptenModelRunLive({ ...base, signal: controller.signal }), false);
  assertEquals(isEmscriptenModelRunLive({ ...base, active: new Set(), workerRun: null }), false);
});

Deno.test("Emscripten run fence: service worker uses a model fence and an explicit Settings preview", async () => {
  const source = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(source.includes("runFencedEmscripten({ context, isLive, dispatch:"), "model dispatch must use the live fence");
  assert(source.includes("preview: true"), "Settings preview must be an explicit SW-only parameter");
  assert(source.includes("if (!isLive()) return { ok: false, phase: \"failed\", error: \"emscripten_run_not_live\" };"),
    "native send must be gated again after asynchronous registry and host setup");
});
