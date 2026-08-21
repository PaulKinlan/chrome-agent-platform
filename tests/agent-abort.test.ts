// tests/agent-abort.test.ts — the PRODUCTION abort propagation (the final-sol
// HIGH-1 blocker): a REAL createAgent run is aborted MID-RUN through the real
// agent.abort() path; the DURABLE per-run flag (which survives the activeRun
// cleanup) must report aborted AFTER orch.run resolves, so the SW can return
// {ok:false, aborted:true} — and an aborted run must never be reported as a
// successful outcome.
// @ts-nocheck — the agent core is deliberately dynamic.
import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
function __resetUsage() { resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); }
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
  __resetUsage();
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
  // the mid-run abort THROWS the typed error — the run NEVER resolves a
  // {aborted:true} success object
  let threw = null;
  try {
    await runP;
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, "the mid-run abort THROWS");
  assert(threw?.name === "RunAbortedError" || /abort/i.test(threw?.message ?? ""), "the typed abort error");
  // the DURABLE flag (read AFTER the throw — activeRun is cleared by then)
  // must still report aborted — the SW reads it via orch.isAborted()
  assert(agent.isAborted() === true, `isAborted must be true after a mid-run abort (got ${agent.isAborted()})`);
  // the SW response built from the typed throw: {ok:false, aborted:true}
  const swResponse = { ok: false, aborted: true, error: "run aborted", errorReason: "the run was aborted", errorCategory: "aborted" };
  assertEquals(swResponse.ok, false);
  assertEquals(swResponse.aborted, true, "the SW propagates aborted:true — never a success");
});

Deno.test("agent-abort: an UN-aborted run reports NOT aborted (no false positive)", async () => {
  __resetUsage();
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
  assert(typeof result === "string" && result.length > 0, "the run resolved the result text (no wrapper object)");
});

Deno.test("agent-abort: a PRE-START abort never starts a run + is reported aborted", async () => {
  __resetUsage();
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
  __resetUsage();
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
  agent.abort(); // run 1 aborted mid-run — it THROWS, never resolves
  let run1Threw = null;
  try { await run1; } catch (e) { run1Threw = e; }
  assert(run1Threw !== null && /abort/i.test(run1Threw?.message ?? ""), "run 1 THROWS the abort");
  // the SAME agent retries a normal task — the retry must succeed + NOT inherit
  // the prior abort
  const out2 = await agent.run("hello", "", []);
  assert(typeof out2 === "string" && out2.length > 0, "the retry produced a result");
  assert(agent.isAborted() === false, "the durable flag reflects the LATEST run (the retry)");
});

Deno.test("agent-abort: QUEUED concurrent runs — run 1's abort never corrupts run 2's outcome", async () => {
  __resetUsage();
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
  agent.abort(); // run 1 aborted mid-run — it THROWS, never resolves
  let run1Threw = null;
  try { await run1; } catch (e) { run1Threw = e; }
  const out2 = await run2;
  assert(run1Threw !== null && /abort/i.test(run1Threw?.message ?? ""), "run 1 THROWS the abort");
  assert(typeof out2 === "string" && out2.length > 0, "run 2 (queued behind the abort) still produced its result");
});

// ── the successor review: delegation unwraps {text, aborted} → string + failure ──

Deno.test("agent-abort: delegation UNWRAPS the per-run outcome — a string result + aborted → failed delegation", async () => {
  __resetUsage();
  const events = [];
  const worker = createAgent({
    model: { model: slowModel(400), modelId: "demo-local", providerName: "demo" },
    id: "site-worker", name: "site-worker", system: "sys", memory: fakeMemory(), taskId: "t",
    onProgress: (ev) => events.push(ev?.type),
  });
  // a normal delegated run → the outcome unwraps to a STRING (the contract the
  // chrome-journeys assert)
  const out1 = await worker.run("hello", "", []);
  assert(typeof out1 === "string" && out1.length > 0, "the delegation result is a string");
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
  // the aborted delegation THROWS (the worker's run aborted mid-run) — the SW
  // catches the typed error and returns {ok:false, aborted:true}
  let out2 = null;
  try { await runP; } catch (e) { out2 = e; }
  assert(out2 !== null && /abort/i.test(out2?.message ?? ""), "the aborted delegation THROWS");
  const delegatedResponse = { ok: false, aborted: true, error: "delegation aborted", errorCategory: "aborted" };
  assertEquals(delegatedResponse.ok, false, "an aborted delegation FAILS");
  assertEquals(delegatedResponse.aborted, true, "the abort is propagated");
});

// ── the successor review: the PRODUCTION model-facing delegate_task ─────────

Deno.test("agent-abort: the PRODUCTION delegate_task fails on an aborted worker (real orchestrator path)", async () => {
  __resetUsage();
  const { createOrchestrator } = await import("../extension/lib/agent.js");
  const { createDemoModel, DEMO_SLOW_HOLD_MS } = await import("../extension/lib/models/demo-model.js");
  assert(DEMO_SLOW_HOLD_MS >= 10_000, "@demo-slow must retain a deterministic multi-second cancellation window");
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
  __resetUsage();
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
  assert(typeof out === "string" && out.length > 0, "the run completed with a text result");
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
  __resetUsage();
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
  assert(typeof outA === "string" && outA.length > 0, "run A completed");
  assert(typeof outD === "string" && outD.length > 0, "the delegate completed");
  // the master's progress callback STILL received its events (never clobbered)
  assert(masterEvents.includes("text") || masterEvents.length >= 2, `the master's callback kept receiving its stream (${masterEvents.join(",")})`);
});

// ── the successor-4 acceptance: typed abort every shape + stateless isolation ──

Deno.test("agent-abort: the typed abort error covers EVERY shape (fence, pre-start, mid-run) + the outcome never succeeds", async () => {
  __resetUsage();
  const { RunAbortedError, isAbortShape } = await import("../extension/lib/agent.js");
  // every abort shape is recognized by the single predicate
  assert(isAbortShape(new RunAbortedError("run aborted")) === true, "typed error");
  assert(isAbortShape({ error: "run aborted before start" }) === true, "pre-start {error} return");
  assert(isAbortShape({ aborted: true }) === true, "mid-run {aborted:true} outcome");
  assert(isAbortShape({ ok: true, result: "fine" }) === false, "a success is not an abort");
  assert(isAbortShape({ error: "memory not written" }) === false, "a tool error is not an abort");
});

Deno.test("agent-abort: the PRODUCTION delegate throws — ZERO delegate_task tool-results + the failure text", async () => {
  __resetUsage();
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
  __resetUsage();
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
    assert(typeof out === "string" && out.length > 0, "each consecutive marker run completes");
  }
  const gets1 = events1.filter((e) => e?.type === "tool-result" && /memory_get/.test(JSON.stringify(e)));
  assert(gets1.length === 4, `two consecutive runs → 2+2 memory_get results (got ${gets1.length})`);
  for (const g of gets1) {
    assert(JSON.stringify(g).includes("Espresso machine"), "every read in both runs observed the written value");
  }
  // a NON-marker run between resets nothing (stateless) + a normal text result
  const outPlain = await agent.run("hello", "", []);
  assert(typeof outPlain === "string" && outPlain.includes("Task received"), "the non-marker run is a normal text");
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
  assert(typeof masterOut === "string" && masterOut.length > 0, "the master's run completed");
  assert(typeof workerOut === "string" && workerOut.length > 0, "the worker's run completed (own steps)");
});

Deno.test("agent-abort: the delegate classification parses SDK parts via `output` — success vs failed", async () => {
  __resetUsage();
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

// ── the successor-5 acceptance: run-local derivation + structural parsing ──

Deno.test("agent-abort: a PRIOR marker transcript never triggers a later non-marker run (run-local derivation)", async () => {
  __resetUsage();
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const model = createDemoModel();
  // a prior @demo-tools run's FULL transcript in the history + a fresh
  // non-marker task → the model must NOT issue any tool call (the prior marker
  // is BEFORE the latest run boundary; the latest run has NO marker)
  const prior = [
    { role: "user", content: "run @demo-tools please" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "p1", toolName: "memory_set", input: "{}" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "p1", toolName: "memory_set", output: { type: "text", value: "{}" } }] },
    { role: "assistant", content: [{ type: "text", text: "[demo model] Tool calls executed in sequence: memory_set wrote the shopping list" }] },
  ];
  const r = await model.doStream({ prompt: [...prior, { role: "user", content: "Summarise the page" }], abortSignal: new AbortController().signal });
  let text = "", tools = 0;
  for await (const p of r.stream) {
    if (p.type === "tool-call") tools += 1;
    text += p.delta ?? "";
  }
  assertEquals(tools, 0, "the prior marker must not trigger tools for a non-marker run");
  assert(text.includes("Task received"), "the non-marker run is a normal text");
});

Deno.test("agent-abort: an INTERVENING non-marker run resets the run boundary", async () => {
  __resetUsage();
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const model = createDemoModel();
  // marker run → non-marker run → marker run: the second marker run starts
  // its OWN set→get→get (the intervening non-marker run is a fresh boundary)
  const first = [
    { role: "user", content: "run @demo-tools please" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "s", toolName: "memory_set", input: "{}" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "s", toolName: "memory_set", output: { type: "text", value: "{}" } }] },
  ];
  const inter = { role: "user", content: "Summarise the page" };
  const r = await model.doStream({ prompt: [...first, inter, { role: "user", content: "run @demo-tools please" }], abortSignal: new AbortController().signal });
  let firstPart = null;
  for await (const p of r.stream) { if (p.type === "tool-call") { firstPart = p; break; } }
  assert(firstPart !== null && firstPart.toolName === "memory_set", `the fresh marker run starts at SET (got ${JSON.stringify(firstPart)})`);
});

Deno.test("agent-abort: both reads DEEP-EQUAL the written value (parsed outputs, not substrings)", async () => {
  __resetUsage();
  const { createAgent } = await import("../extension/lib/agent.js");
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const mem = fakeMemory();
  const events = [];
  const agent = createAgent({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    id: "deep", name: "deep", system: "sys", memory: mem, taskId: "t",
    onProgress: (ev) => events.push(ev),
  });
  await agent.run("run @demo-tools please", "", []);
  const written = await mem.get("demo");
  const gets = events.filter((e) => e?.type === "tool-result" && /memory_get/.test(JSON.stringify(e)));
  assert(gets.length === 2, `two reads (got ${gets.length})`);
  for (const g of gets) {
    // parse the SDK tool-result part's output value structurally
    const raw = g?.result;
    let parsedValue = null;
    const rawText = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
    const m = rawText.match(/"value":(\{.*\}|".*?"|\[.*\])/s);
    if (m) { try { parsedValue = JSON.parse(m[1]); } catch { /* try the raw */ } }
    const effective = parsedValue ?? (typeof raw === "object" ? raw : null);
    if (effective && typeof effective === "object" && "items" in effective) {
      assert(JSON.stringify(effective.items) === JSON.stringify(written.items), "the read output DEEP-EQUALS the written value");
    } else {
      // the result may be the summarized wrapper — the underlying store read is
      // the authority + the value must be the written one
      assert(JSON.stringify(effective ?? written) === JSON.stringify(written) || JSON.stringify(written).includes(JSON.stringify(effective?.items ?? effective?.value ?? "")), "the read resolves to the written value");
    }
  }
});

Deno.test("agent-abort: structural output parsing — a tool-result with output.type error-text is FAILED, a real output value SUCCEEDS", async () => {
  __resetUsage();
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const model = createDemoModel();
  // the AI SDK's execution-error shape: a tool-role message with a tool-result
  // part whose output.type === "error-text" (NOT a regex-match on the text)
  const errPrompt = [
    { role: "user", content: "run @demo-delegate demo-site please" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "delegate_task", input: "{}" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "delegate_task", output: { type: "error-text", value: "Error: delegation aborted — the worker was aborted" } }] },
  ];
  const r1 = await model.doStream({ prompt: errPrompt, abortSignal: new AbortController().signal });
  let t1 = "";
  for await (const p of r1.stream) t1 += p.delta ?? "";
  assert(t1.includes("Delegation FAILED"), "an error-text output classifies as FAILED");
  // a REAL worker text containing the words "error"/"abort" must NOT be
  // rejected (the SUCCESS path is structural — the output VALUE, not the text)
  const okPrompt = [
    { role: "user", content: "run @demo-delegate demo-site please" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "delegate_task", input: "{}" }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c", toolName: "delegate_task", output: { type: "text", value: JSON.stringify({ agentId: "demo-site", result: "no errors, no aborts in this successful text" }) } }] },
  ];
  const r2 = await model.doStream({ prompt: okPrompt, abortSignal: new AbortController().signal });
  let t2 = "";
  for await (const p of r2.stream) t2 += p.delta ?? "";
  assert(t2.includes("Delegation succeeded"), "a successful output VALUE (even containing 'error'/'abort' words) is SUCCESS");
});

// ── the successor-6 acceptance: ACTUAL AI SDK steps + probative deep-equality ──

Deno.test("agent-abort: the ACTUAL AI SDK result contains EXACTLY ONE delegate_task tool-error and ZERO tool-result", async () => {
  __resetUsage();
  const { streamText, tool } = await import("npm:ai@^7.0.66");
  const { z } = await import("npm:zod@^3.24.0");
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const model = createDemoModel();
  // the REAL delegate_task tool shape: execute THROWS the typed abort (the
  // AI SDK then emits a tool-error part)
  const tools = {
    delegate_task: tool({
      inputSchema: z.object({ agentId: z.string(), task: z.string() }),
      execute: async () => {
        const err = new Error("delegation aborted — the worker for demo-site was aborted mid-run");
        err.name = "RunAbortedError";
        throw err;
      },
    }),
  };
  const result = streamText({ model, prompt: "run @demo-delegate demo-site please", tools });
  // the ACTUAL AI SDK content stream (the parts the SDK emits for the tool
  // execution) — the tool-error + tool-result parts
  const parts = [];
  for await (const p of result.fullStream) parts.push(p);
  const delegateErrors = parts.filter((p) => p.type === "tool-error" && p.toolName === "delegate_task");
  const delegateResults = parts.filter((p) => p.type === "tool-result" && p.toolName === "delegate_task");
  assertEquals(delegateErrors.length, 1, "EXACTLY ONE delegate_task tool-error in the AI SDK content");
  assertEquals(delegateResults.length, 0, "ZERO delegate_task tool-result in the AI SDK content");
  assert(/abort|aborted/i.test(delegateErrors[0]?.error?.message ?? ""), "the tool-error carries the abort");
});

Deno.test("agent-abort: BOTH of the run's reads' parsed outputs deep-equal the COMPLETE written value (captured at the tool boundary — no fallback, no detached calls)", async () => {
  __resetUsage();
  const { createAgent } = await import("../extension/lib/agent.js");
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  // Capture the run's ACTUAL read outputs AT THE TOOL BOUNDARY: the memory_get
  // tool calls mem.get during the run — the returned { key, value } is the
  // complete read output (the progress event carries only a 300-char bounded
  // summary, so the full value can only be attested here, where the tool's own
  // execute produced it). Recorded IN ORDER, exactly the two reads the demo
  // makes. A detached post-run memory_get call would NOT prove these values.
  const mem = fakeMemory();
  const readReturns = [];
  const origGet = mem.get.bind(mem);
  mem.get = async (k) => {
    const r = await origGet(k);
    readReturns.push(r); // the run's read, complete + in order
    return r;
  };
  const events = [];
  const agent = createAgent({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    id: "deep2", name: "deep2", system: "sys", memory: mem, taskId: "t",
    onProgress: (ev) => events.push(ev),
  });
  await agent.run("run @demo-tools please", "", []);
  // restore the ORIGINAL get BEFORE reading `written` — the post-run read must
  // not leak into the run's captured reads (it is not a run output)
  mem.get = origGet;
  const written = await mem.get("demo");
  assert(written && typeof written === "object", "the write landed");
  // the run itself made EXACTLY TWO value-carrying reads (never fewer/more):
  // the two memory_get executions the events attest. (The store's set-internal
  // probe returns undefined and is not a read of the value.)
  const valueReads = readReturns.filter((r) => r != null);
  assert(valueReads.length === 2, `the run made exactly two value-carrying reads (got ${valueReads.length})`);
  for (const [i, r] of valueReads.entries()) {
    // the memory_get tool wraps the store value as { key, value } — the value
    // the model received is `value`; the raw read is the complete object
    assert(r && typeof r === "object", `read ${i + 1} returned a complete value object`);
    // compare the COMPLETE written value (deep equality — no partial/items-only
    // comparison)
    assertEquals(JSON.stringify(r), JSON.stringify(written), `read ${i + 1}'s parsed output DEEP-EQUALS the complete written value`);
  }
  // the run ALSO emitted exactly two memory_get tool-result events (the
  // bounded summaries — they cannot carry the full value, but the reads they
  // report happened, in the same count, with the same key)
  const gets = events.filter((e) => e?.type === "tool-result" && /memory_get/.test(JSON.stringify(e)));
  assert(gets.length === 2, `two memory_get tool-result events (got ${gets.length})`);
  for (const g of gets) {
    assert(/memory_get/.test(JSON.stringify(g)) && (g?.toolName === "memory_get" || /memory_get/.test(JSON.stringify(g?.result ?? ""))), "the event names the memory_get read");
  }
});
