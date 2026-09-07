// tests/steer-concurrent-run.test.ts — chrome-agent-platform-ugj9, falsification.
// @ts-nocheck — the agent core is deliberately dynamic.
//
// jj7e made runs on DIFFERENT threads concurrent (withRunLock per threadId),
// but the cached shared orchestrator carries ONE mutable steer-source cell,
// and the model seam consulted it with NO run id. The production sequence:
//   run A binds the steer source -> A's first model call starts (in flight)
//   -> run B's SW body re-binds the SAME cell (B queues behind A at the agent)
//   -> the owner steers A (runControl.steer key exec-A)
//   -> A's NEXT model call must carry the steer text between steps.
// The seam's argument-less binder call resolved the LAST binder's fallback
// key (exec-B) instead of the RUNNING run's id — the steer never rode any of
// A's calls (the demo-crisis drop). The binder is STATELESS: whichever
// instance sits in the cell answers correctly for the right key, so the seam
// must pass the RUNNING run's identity (activeRun.identity.runId — the exact
// discriminator the provider-tool latch already uses at the same site).
import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
function __reset() { resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); }
import { assert, assertStringIncludes } from "jsr:@std/assert@1";
import { createAgent } from "../extension/lib/agent.js";
import { createRunControl } from "../extension/lib/run-control.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeMemory() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : undefined; },
    async set(k, v) { store.set(k, v); return { ok: true }; },
    async has(k) { return store.has(k) ? store.get(k) : undefined; },
    async list() { return [...store.keys()]; },
    async clear() { store.clear(); },
  };
}

Deno.test("steer: a steer recorded for the RUNNING run rides its later model calls even after a concurrent run re-binds the shared steer source", async () => {
  __reset();
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");

  // The prompts every model call really saw.
  const prompts = [];
  // Gate: hold call 1 in flight until the test has re-bound the steer source
  // and steered run A (the owner typing mid-call).
  let releaseCall1;
  const call1InFlight = new Promise((resolve) => { releaseCall1 = resolve; });
  let call1Started = Promise.resolve();
  let call = 0;
  const demo = createDemoModel();
  const gatedDemo = new Proxy(demo, {
    get(t, p, r) {
      if (p === "doStream") {
        return async (options) => {
          call += 1;
          prompts.push((options?.prompt ?? []).map((m) =>
            typeof m?.content === "string" ? m.content
              : Array.isArray(m?.content) ? m.content.map((part) => part?.text ?? "").join("") : "").join("\n"));
          if (call === 1) {
            call1Started = Promise.resolve();
            await call1InFlight; // the owner's steer lands while this call is live
          }
          return t[p](options);
        };
      }
      return Reflect.get(t, p, r);
    },
  });

  const runControl = createRunControl();
  const agent = createAgent({
    model: { model: gatedDemo, modelId: "demo-local", providerName: "demo" },
    id: "hub", name: "hub", system: "test agent", memory: fakeMemory(), taskId: "ugj9",
  });

  // The EXACT production binder (service-worker.js runBody): a stateless
  // reader keyed by the run id the seam supplies, falling back to the
  // binder's own execution id when the seam passes none (the pre-fix bug).
  const bind = (execId) => agent.setSteerSource((runId) => {
    const key = String(runId ?? execId ?? "");
    return {
      pending: runControl.pending(key),
      ack: (ids) => runControl.markInjected(key, ids),
    };
  });

  // Production: runControl.register({executionId, threadId, kind}) runs in
  // runBody before the steer source binds — the registry IS the live authority.
  runControl.register({ executionId: "exec-A", threadId: "thread-A", kind: "task" });
  bind("exec-A");
  const runA = agent.run("run @demo-tools please store a note", "", [], null, null, { runId: "exec-A", taskId: "tA" });

  // Wait until run A's FIRST model call is genuinely in flight.
  const t0 = Date.now();
  while (prompts.length < 1) {
    if (Date.now() - t0 > 15000) throw new Error("run A never reached its first model call");
    await sleep(5);
  }

  // Run B's SW body re-binds the shared cell while A is mid-call (jj7e made
  // this sequence real: different threads, one cached orchestrator).
  runControl.register({ executionId: "exec-B", threadId: "thread-B", kind: "task" });
  bind("exec-B");
  // The owner steers the task they are WATCHING (run A).
  const steered = runControl.steer({ executionId: "exec-A", mode: "inject", text: "UGJ9 STEER MARKER: prefer the short answer" });
  assert(steered?.ok === true, `the steer was accepted into the live registry (got ${JSON.stringify(steered)})`);
  releaseCall1();

  const outcome = await runA;
  assert(typeof outcome === "string" && outcome.length > 0, "run A resolved normally");

  // THE GATE: at least one of run A's LATER model calls must have CARRIED the
  // owner's steer text (between-step delivery). Pre-fix, the seam consulted
  // the re-bound binder with no id, resolved pending("exec-B") = [], and the
  // text rode NO call — the demo-crisis drop.
  const carried = prompts.slice(1).some((text) => text.includes("UGJ9 STEER MARKER"));
  assert(carried, `the steer text must ride a later model call of the steered run (calls recorded: ${prompts.length}; later prompts carried it: ${carried})`);

  // And the registry must show the record as SPENT (acknowledged by a real
  // model call) — not silently undelivered.
  const spent = runControl.pending("exec-A").every((s) => s.injectedOnce === true);
  assert(spent, "the steer record is acknowledged (injectedOnce) after the run carried it");
});
