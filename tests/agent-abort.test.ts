// tests/agent-abort.test.ts — the PRODUCTION abort propagation (the final-sol
// HIGH-1 blocker): a REAL createAgent run is aborted MID-RUN through the real
// agent.abort() path; the DURABLE per-run flag (which survives the activeRun
// cleanup) must report aborted AFTER orch.run resolves, so the SW can return
// {ok:false, aborted:true} — and an aborted run must never be reported as a
// successful outcome.
// @ts-nocheck — the agent core is deliberately dynamic.
import { assert, assertEquals } from "jsr:@std/assert";
import { createAgent } from "../extension/lib/agent.js";
import { createDemoModel } from "../extension/lib/models/demo-model.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A slow model wrapper: the FIRST doStream is delayed, so a REAL mid-run
 * abort lands deterministically inside the model loop. */
function slowModel(delayMs = 500) {
  const demo = createDemoModel();
  let first = true;
  return {
    ...demo,
    doStream: async (opts) => {
      if (first) { first = false; await sleep(delayMs); }
      return demo.doStream(opts);
    },
  };
}

function fakeMemory() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : undefined; },
    async set(k, v) { store.set(k, v); return { ok: true }; },
    async has(k) { return store.has(k); },
    async list() { return [...store.keys()]; },
    async clear() { store.clear(); return { ok: true }; },
  };
}

Deno.test("agent-abort: a REAL mid-run abort is DURABLY observable after orch.run resolves", async () => {
  const events = [];
  const agent = createAgent({
    model: { model: slowModel(600), modelId: "demo-local", providerName: "demo" },
    id: "abort-test",
    name: "abort-test",
    system: "you are a test agent",
    memory: fakeMemory(),
    taskId: "t1",
    onProgress: (ev) => events.push(ev?.type),
  });
  // the slow model keeps the FIRST model step in flight for 600ms; abort
  // DETERMINISTICALLY mid-run — the moment the step starts (inside the delay)
  const runP = agent.run("run @demo-tools please", "", []);
  const t0 = Date.now();
  while (!events.includes("thinking")) {
    if (Date.now() - t0 > 5000) throw new Error("the run never started");
    await sleep(5);
  }
  await sleep(100); // the FIRST model step is still in the 600ms delay
  agent.abort(); // the REAL abort path (controller + agent.abort)
  const result = await runP;
  // the DURABLE flag (read AFTER the run resolves — activeRun is cleared by
  // then) must still report aborted — the SW reads it via orch.isAborted()
  assert(agent.isAborted() === true, `isAborted must be true after a mid-run abort (got ${agent.isAborted()})`);
  // the response shape the SW builds from this: {ok:false, aborted:true}
  const swResponse = agent.isAborted()
    ? { ok: false, aborted: true, error: "run aborted", errorReason: "the run was aborted", errorCategory: "aborted" }
    : { ok: true, result: String(result) };
  assertEquals(swResponse.ok, false);
  assertEquals(swResponse.aborted, true, "the SW propagates aborted:true — never a success");
});

Deno.test("agent-abort: an UN-aborted run reports NOT aborted (no false positive)", async () => {
  const agent = createAgent({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    id: "ok-test",
    name: "ok-test",
    system: "you are a test agent",
    memory: fakeMemory(),
    taskId: "t2",
    onProgress: () => {},
  });
  const result = await agent.run("hello", "", []);
  assert(agent.isAborted() === false, "a normal run is not aborted");
  assert(typeof result === "string" && result.length > 0, "the run produced a result");
});

Deno.test("agent-abort: a PRE-START abort never starts a run + is reported aborted", async () => {
  const agent = createAgent({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    id: "pre-abort",
    name: "pre-abort",
    system: "you are a test agent",
    memory: fakeMemory(),
    taskId: "t3",
    disposable: true,
    onProgress: () => {},
  });
  agent.abort(); // before the run starts
  const result = await agent.run("hello", "", []);
  assert(agent.isAborted() === true);
  assertEquals(String(result?.error ?? result).includes("aborted"), true, "the pre-start abort surfaces");
});
