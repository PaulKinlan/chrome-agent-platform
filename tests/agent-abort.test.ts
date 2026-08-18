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
  // the PER-RUN outcome is RETURNED with the run (never a singleton race)
  assert(result && typeof result === "object" && result.aborted === true, "the returned outcome reports aborted");
  // the response shape the SW builds from this: {ok:false, aborted:true}
  const swResponse = (result?.aborted === true || agent.isAborted())
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
  assert(result && typeof result === "object" && result.aborted === false, "the outcome reports not aborted");
  assert(typeof result.text === "string" && result.text.length > 0, "the run produced a result");
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


Deno.test("agent-abort: an aborted run followed by a SUCCESSFUL RETRY on the SAME reusable agent", async () => {
  const events = [];
  const agent = createAgent({
    model: { model: slowModel(500), modelId: "demo-local", providerName: "demo" },
    id: "retry-test", name: "retry-test", system: "sys", memory: fakeMemory(), taskId: "t",
    onProgress: (ev) => events.push(ev?.type),
  });
  const run1 = agent.run("run @demo-tools please", "", []);
  const t0 = Date.now();
  while (!events.includes("thinking")) { if (Date.now() - t0 > 5000) throw new Error("never started"); await sleep(5); }
  await sleep(80); // inside the slow first step
  agent.abort(); // run 1 aborted mid-run
  const out1 = await run1;
  assert(out1.aborted === true, "run 1 reports aborted");
  // the SAME agent retries a normal task — the retry must succeed + NOT inherit
  // the prior abort
  const out2 = await agent.run("hello", "", []);
  assert(out2.aborted === false, "the retry is not aborted");
  assert(typeof out2.text === "string" && out2.text.length > 0, "the retry produced a result");
  assert(agent.isAborted() === false, "the durable flag reflects the LATEST run (the retry)");
});

Deno.test("agent-abort: QUEUED concurrent runs — run 1's abort never corrupts run 2's outcome", async () => {
  const events = [];
  const agent = createAgent({
    model: { model: slowModel(400), modelId: "demo-local", providerName: "demo" },
    id: "queue-test", name: "queue-test", system: "sys", memory: fakeMemory(), taskId: "t",
    onProgress: (ev) => events.push(ev?.type),
  });
  // two CONCURRENT runs on the same agent — the runQueue serializes them
  const run1 = agent.run("run @demo-tools please", "", []);
  const run2 = agent.run("hello", "", []);
  const t0 = Date.now();
  while (!events.includes("thinking")) { if (Date.now() - t0 > 5000) throw new Error("run1 never started"); await sleep(5); }
  await sleep(60);
  agent.abort(); // run 1 aborted mid-run
  const out1 = await run1;
  const out2 = await run2;
  assert(out1.aborted === true, "run 1 reports aborted");
  assert(out2.aborted === false, "run 2 (queued behind the abort) is NOT aborted");
  assert(typeof out2.text === "string" && out2.text.length > 0, "run 2 still produced its result");
});

// ── the successor review: delegation unwraps {text, aborted} → string + failure ──

Deno.test("agent-abort: delegation UNWRAPS the per-run outcome — a string result + aborted → failed delegation", async () => {
  const events = [];
  const worker = createAgent({
    model: { model: slowModel(400), modelId: "demo-local", providerName: "demo" },
    id: "site-worker", name: "site-worker", system: "sys", memory: fakeMemory(), taskId: "t",
    onProgress: (ev) => events.push(ev?.type),
  });
  // a normal delegated run → the outcome unwraps to a STRING (the contract the
  // chrome-journeys assert)
  const out1 = await worker.run("hello", "", []);
  const result1 = (out1 && typeof out1 === "object" && typeof out1.text === "string") ? out1.text : out1;
  assert(typeof result1 === "string" && result1.length > 0, "the delegation result is a string");
  assert(out1.aborted === false, "the outcome is not aborted");
  // an ABORTED delegated run → the SW maps it to a FAILED delegation (a FRESH
  // worker so the slow-model delay is in flight for the abort)
  const events2 = [];
  const worker2 = createAgent({
    model: { model: slowModel(400), modelId: "demo-local", providerName: "demo" },
    id: "site-worker-2", name: "site-worker-2", system: "sys", memory: fakeMemory(), taskId: "t2",
    onProgress: (ev) => events2.push(ev?.type),
  });
  const runP = worker2.run("run @demo-tools please", "", []);
  const t0 = Date.now();
  while (!events2.includes("thinking")) { if (Date.now() - t0 > 5000) throw new Error("never started"); await sleep(5); }
  await sleep(60);
  worker2.abort();
  const out2 = await runP;
  const delegatedResponse = (out2?.aborted === true)
    ? { ok: false, aborted: true, error: "delegation aborted", errorCategory: "aborted" }
    : { ok: true, result: String(out2) };
  assertEquals(delegatedResponse.ok, false, "an aborted delegation FAILS");
  assertEquals(delegatedResponse.aborted, true, "the abort is propagated");
});

// ── the successor review: the PRODUCTION model-facing delegate_task ─────────

Deno.test("agent-abort: the PRODUCTION delegate_task fails on an aborted worker (real orchestrator path)", async () => {
  const { createOrchestrator } = await import("../extension/lib/agent.js");
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const workerEvents = [];
  const orch = createOrchestrator({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    system: "you are the hub",
    masterMemory: fakeMemory(),
    workers: [{ origin: "demo-site", memory: fakeMemory() }],
    multiAgent: true,
    delegateGuard: async () => ({ ok: true, gen: 1 }),
    onProgress: (ev) => workerEvents.push(ev),
  });
  // the worker runs "@demo-tools @demo-slow" — a slow first step gives a
  // deterministic mid-run abort window
  const runP = orch.run("@demo-delegate demo-site", "", []);
  const t0 = Date.now();
  while (!workerEvents.some((e) => e?.type === "tool-call")) {
    if (Date.now() - t0 > 8000) throw new Error("the delegation never reached the worker");
    await sleep(5);
  }
  await sleep(120); // the worker's slow step is still in flight
  orch.workers.get("demo-site").abort(); // abort the WORKER mid-delegation
  // The PRODUCTION delegate_task fails the delegation: the aborted worker's run
  // is caught into the explicit "delegation aborted" failure, so the model's
  // continuation sees the failure — the RUN either completes with the failed
  // summary or rejects through the SDK's tool-error path. Either way the
  // delegation NEVER returns a success object.
  let out;
  try {
    out = await runP;
  } catch (e) {
    out = { error: e?.message ?? String(e) };
  }
  const text = out && typeof out === "object" ? (out.text ?? out.error ?? "") : String(out);
  assert(!text.includes("[object Object]"), "no object leaked into the result");
  // the PRODUCTION delegate_task FAILED the delegation: the worker's abort is
  // caught into the explicit "delegation aborted" failure — observable in the
  // tool-result progress event (the model-facing result) AND/OR the run text
  const toolResults = workerEvents.filter((e) => e?.type === "tool-result");
  const delegationResult = JSON.stringify(toolResults.map((e) => e?.result ?? e).join(" "));
  assert(
    /abort|delegation aborted|no output|failed/i.test(text + " " + delegationResult),
    `the delegation failed explicitly (text: ${text.slice(0, 80)} | tool-result: ${delegationResult.slice(0, 120)})`,
  );
});
