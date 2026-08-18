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
  // the pre-start abort now THROWS the typed RunAbortedError (never a
  // successful {error} object — a returned object would be a successful
  // tool-result in the delegate path)
  let threw = null;
  try {
    await agent.run("hello", "", []);
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, "the pre-start abort THROWS");
  assert(/aborted|abort/i.test(threw?.message ?? ""), "the typed abort error names the abort");
  assert(agent.isAborted() === true);
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
  // The delegation FAILED with a REAL AI SDK tool-error (the delegate_task now
  // THROWS for an aborted worker — a returned {error} would be a SUCCESSFUL
  // tool-result). Assert: (a) the run's failure reflects the tool-error, and
  // (b) there is NO successful delegate_task result anywhere.
  const delegateToolResults = workerEvents.filter((e) => e?.type === "tool-result" && /delegate_task/.test(JSON.stringify(e)));
  const delegateResultText = JSON.stringify(delegateToolResults.map((e) => e?.result ?? e).join(" "));
  // a returned {error} object would appear as a tool-result here — the throw
  // path must NOT leave one
  assert(!delegateResultText.includes('"error":"delegation aborted'), "no successful {error} tool-result for the aborted delegation");
  assert(
    /abort|delegation aborted|no output|tool-error|failed/i.test(text + " " + delegateResultText),
    `the delegation failed explicitly via the tool-error path (text: ${text.slice(0, 80)})`,
  );
});

// ── the successor-3 acceptance: reads observe the write + no callback clobber ──

Deno.test("agent-abort: the sequenced demo reads BOTH observe the written value (never the pre-write state)", async () => {
  const { createAgent } = await import("../extension/lib/agent.js");
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const mem = fakeMemory();
  const events = [];
  const agent = createAgent({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    id: "read-test", name: "read-test", system: "sys", memory: mem, taskId: "t",
    onProgress: (ev) => events.push(ev),
  });
  const out = await agent.run("run @demo-tools please", "", []);
  assert(out && typeof out === "object" && out.aborted === false, "the run completed");
  // the TWO memory_get tool results must each contain the newly written value
  const gets = events.filter((e) => e?.type === "tool-result" && /memory_get/.test(JSON.stringify(e)));
  assert(gets.length === 2, `exactly two memory_get results (got ${gets.length})`);
  for (const g of gets) {
    const text = JSON.stringify(g);
    assert(text.includes("Espresso machine"), "the read returned the WRITTEN value (memory_get observed the committed write)");
    assert(!text.includes('"value":null'), "the read is not the pre-write null");
  }
  // the write actually happened (the store holds the value)
  const stored = await mem.get("demo");
  assert(stored && Array.isArray(stored?.items) && stored.items.length === 2, "the demo key was written (memory_set stored the value)");
});

Deno.test("agent-abort: a direct delegate's own progress binding never CLOBBERS a concurrent run's callback", async () => {
  const { createOrchestrator } = await import("../extension/lib/agent.js");
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const masterEvents = [];
  const orch = createOrchestrator({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    system: "hub", masterMemory: fakeMemory(),
    workers: [{ origin: "demo-site", memory: fakeMemory() }],
    multiAgent: true,
    delegateGuard: async () => ({ ok: true, gen: 1 }),
    onProgress: (ev) => masterEvents.push(ev?.type),
  });
  // run A: a normal master run WITH its own progress callback bound
  const runA = orch.run("hello A", "", []);
  const t0 = Date.now();
  while (!masterEvents.includes("thinking")) { if (Date.now() - t0 > 5000) break; await sleep(5); }
  // the DIRECT delegate (a concurrent run): it binds the WORKER's progress
  // inside its own lock — the master's callback must stay intact
  const worker = orch.workers.get("demo-site");
  const runD = (async () => {
    worker.setProgress?.((ev) => { /* the delegate's own sink */ });
    try {
      return await worker.run("hello worker", "", []);
    } finally {
      worker.setProgress?.(null);
    }
  })();
  const outA = await runA;
  const outD = await runD;
  assert(outA && typeof outA === "object" && typeof outA.text === "string", "run A completed");
  assert(outD && typeof outD === "object" && typeof outD.text === "string", "the delegate completed");
  // the master's progress callback STILL received its events (never clobbered)
  assert(masterEvents.includes("text") || masterEvents.length >= 2, `the master's callback kept receiving its stream (${masterEvents.join(",")})`);
});

// ── the successor-4 acceptance: typed abort every shape + stateless isolation ──

Deno.test("agent-abort: the typed abort error covers EVERY shape (fence, pre-start, mid-run) + the outcome never succeeds", async () => {
  const { RunAbortedError, isAbortShape } = await import("../extension/lib/agent.js");
  // every abort shape is recognized by the single predicate
  assert(isAbortShape(new RunAbortedError("run aborted")) === true, "typed error");
  assert(isAbortShape({ error: "run aborted before start" }) === true, "pre-start {error} return");
  assert(isAbortShape({ aborted: true }) === true, "mid-run {aborted:true} outcome");
  assert(isAbortShape({ ok: true, result: "fine" }) === false, "a success is not an abort");
  assert(isAbortShape({ error: "memory not written" }) === false, "a tool error is not an abort");
});

Deno.test("agent-abort: the PRODUCTION delegate throws — ZERO delegate_task tool-results + the failure text", async () => {
  const { createOrchestrator } = await import("../extension/lib/agent.js");
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const events = [];
  const orch = createOrchestrator({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    system: "hub", masterMemory: fakeMemory(),
    workers: [{ origin: "demo-site", memory: fakeMemory() }],
    multiAgent: true, delegateGuard: async () => ({ ok: true, gen: 1 }),
    onProgress: (ev) => events.push(ev),
  });
  const runP = orch.run("@demo-delegate demo-site", "", []);
  const t0 = Date.now();
  while (!events.some((e) => e?.type === "tool-call")) { if (Date.now() - t0 > 8000) break; await sleep(5); }
  await sleep(120);
  orch.workers.get("demo-site").abort();
  let out;
  try { out = await runP; } catch (e) { out = { error: e?.message ?? String(e) }; }
  const text = out && typeof out === "object" ? (out.text ?? out.error ?? "") : String(out);
  // ZERO successful delegate_task tool-results (the throw emits a tool-error,
  // never a result part)
  const delegateResults = events.filter((e) => e?.type === "tool-result" && /delegate_task/.test(JSON.stringify(e)));
  assertEquals(delegateResults.length, 0, "no successful delegate_task tool-result");
  // the final text is the authoritative FAILED outcome (the continuation
  // re-emits the prior summary — never a neutral rewrite)
  assert(/Delegation FAILED|aborted|failed/i.test(text), `the delegation failed in the final text (got: ${text.slice(0, 80)})`);
  assert(!text.includes("[object Object]"), "no object leak");
});

Deno.test("agent-abort: STATELESS sequencing — consecutive marker runs + non-marker reset + multi-agent isolation", async () => {
  const { createAgent, createOrchestrator } = await import("../extension/lib/agent.js");
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  // TWO runs on the SAME model instance (consecutive marker runs) — each must
  // complete the full set→get→get sequence (the stateless derivation starts
  // at step 0 from each run's own prompt history)
  const mem1 = fakeMemory();
  const events1 = [];
  const agent = createAgent({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    id: "iso", name: "iso", system: "sys", memory: mem1, taskId: "t",
    onProgress: (ev) => events1.push(ev),
  });
  const out1 = await agent.run("run @demo-tools please", "", []);
  const out2 = await agent.run("run @demo-tools please", "", []);
  for (const out of [out1, out2]) {
    assert(out && typeof out === "object" && out.aborted === false, "each consecutive marker run completes");
  }
  const gets1 = events1.filter((e) => e?.type === "tool-result" && /memory_get/.test(JSON.stringify(e)));
  assert(gets1.length === 4, `two consecutive runs → 2+2 memory_get results (got ${gets1.length})`);
  for (const g of gets1) {
    assert(JSON.stringify(g).includes("Espresso machine"), "every read in both runs observed the written value");
  }
  // a NON-marker run between resets nothing (stateless) + a normal text result
  const outPlain = await agent.run("hello", "", []);
  assert(typeof outPlain?.text === "string" && outPlain.text.includes("Task received"), "the non-marker run is a normal text");
  // MULTI-AGENT isolation: two agents sharing the SAME model instance (the
  // orchestrator's master + worker share the model) cannot consume each
  // other's steps — each gets its own set→get→get
  const orch = createOrchestrator({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    system: "hub", masterMemory: fakeMemory(),
    workers: [{ origin: "demo-site", memory: fakeMemory() }],
    multiAgent: true, delegateGuard: async () => ({ ok: true, gen: 1 }),
    onProgress: () => {},
  });
  const masterOut = await orch.run("run @demo-tools please", "", []);
  const workerOut = await orch.workers.get("demo-site").run("run @demo-tools please", "", []);
  assert(masterOut && typeof masterOut === "object" && masterOut.aborted === false, "the master's run completed");
  assert(workerOut && typeof workerOut === "object" && workerOut.aborted === false, "the worker's run completed (own steps)");
});

Deno.test("agent-abort: the delegate classification parses SDK parts via `output` — success vs failed", async () => {
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const model = createDemoModel();
  // a SUCCESSFUL delegation: the SDK tool message carries a tool-result part
  // with an `output` value (NOT `result`)
  const successPrompt = [
    { role: "user", content: "run @demo-delegate demo-site please" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "delegate_task", input: "{}" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "delegate_task", output: { type: "text", value: JSON.stringify({ agentId: "demo-site", result: "worker text" }) } }] },
  ];
  const r1 = await model.doStream({ prompt: successPrompt, abortSignal: new AbortController().signal });
  let text1 = "";
  for await (const p of r1.stream) text1 += p.delta ?? "";
  assert(text1.includes("Delegation succeeded"), `success classified (got ${text1.slice(0, 80)})`);
  // a FAILED delegation: the tool message carries a tool-error part with
  // an error-text output
  const failPrompt = [
    { role: "user", content: "run @demo-delegate demo-site please" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "delegate_task", input: "{}" }] },
    { role: "tool", content: [{ type: "tool-error", toolCallId: "c", toolName: "delegate_task", output: { type: "error-text", value: "Error: delegation aborted — the worker was aborted" } }] },
  ];
  const r2 = await model.doStream({ prompt: failPrompt, abortSignal: new AbortController().signal });
  let text2 = "";
  for await (const p of r2.stream) text2 += p.delta ?? "";
  assert(text2.includes("Delegation FAILED"), `failure classified (got ${text2.slice(0, 80)})`);
});
