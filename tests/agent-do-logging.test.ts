// @ts-nocheck
// CAP-FB-20260826-AGENT-DO-LIFECYCLE-LOG-01 — the agent-do lifecycle is visible
// in the logs at VERBOSE, silent below it, and leaks NO content (prompts, page
// content, tool args/results) — only indices, durations, names, ok/error, counts.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { capLogReady, setLogVerbosity, clearLogBuffer, dumpLogBuffer } from "../extension/lib/cap-log.js";
import { perfSummary } from "../extension/lib/cap-perf.js";
import { createAgent } from "../extension/lib/agent.js";
import { createDemoModel } from "../extension/lib/models/demo-model.js";
import { installFakeIdb, resetFakeIdb, clearFaults } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";

globalThis.chrome = { permissions: { contains: async () => false }, storage: undefined };
resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); clearFaults();

function captureConsole() {
  const calls = [];
  const orig = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
  const rec = (level) => (...a) => calls.push({ level, text: a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") });
  console.debug = rec("debug"); console.info = rec("info"); console.warn = rec("warn"); console.error = rec("error");
  return { calls, restore: () => Object.assign(console, orig) };
}

const SENTINEL_PROMPT = "unique-prompt-sentinel-xyzzy-42";

async function runOne() {
  const model = { model: createDemoModel(), providerName: "demo", modelId: "demo-local" };
  const agent = createAgent({ model, id: "hub", name: "hub", memory: null });
  await agent.run(SENTINEL_PROMPT, "ctx", []);
}

Deno.test("agent-do lifecycle: a verbose run emits the complete ordered redacted trace", async () => {
  await capLogReady();
  await setLogVerbosity("verbose");
  clearLogBuffer();
  const { calls, restore } = captureConsole();
  try {
    await runOne();
  } finally { restore(); }
  const lines = calls.map((c) => c.text).filter((t) => t.includes("agent-do"));
  const joined = lines.join("\n");
  // Ordered lifecycle: step start → (tool start → tool ok/error)* → step complete → run complete → usage.
  const stepStart = lines.findIndex((t) => /step \d+\//.test(t) && t.includes("start"));
  const complete = lines.findIndex((t) => t.includes("run complete"));
  const usage = lines.findIndex((t) => t.includes("usage:"));
  assert(stepStart !== -1, `step start logged:\n${joined}`);
  assert(complete !== -1, `run complete logged:\n${joined}`);
  assert(usage !== -1, `usage logged:\n${joined}`);
  // onUsage fires per provider attempt DURING the run; onComplete is last.
  assert(stepStart !== -1 && stepStart < complete, `ordered lifecycle:\n${joined}`);
  assert(/run complete: \d+ steps in \d+ms/.test(joined), "complete line carries totals + duration");
  assert(/step \d+ complete in [\d.]+ms/.test(joined), "step complete carries a duration");
  // Tool lifecycle present when the demo model uses a tool (demo writes+reads per the fixed protocol).
  if (lines.some((t) => t.includes("tool "))) {
    assert(/tool \S+ (ok|error) in [\d.?]+ms/.test(joined), "tool completion carries name + durationMs + ok/error");
    assert(!/tool .*\{.*\}/.test(joined.replace(/\{ tokensSoFar[^}]*\}|\{ hasToolCalls[^}]*\}/g, "")), "no arg/result objects in tool lines");
  }
  // REDACTION: the sentinel prompt must appear in NO log line anywhere.
  assert(!calls.some((c) => c.text.includes(SENTINEL_PROMPT)), "prompt content NEVER logged");
  // Ring buffer also holds the trace (inspectable via dumpLogBuffer).
  const ring = dumpLogBuffer().entries.filter((e) => e.ns === "agent-do");
  assert(ring.length > 0, "the agent-do lines are in the ring");
  // perf spans recorded for the model round-trip (step span) — visible in perfSummary.
  const perf = perfSummary();
  assert(JSON.stringify(perf).includes("agent-do"), "perf spans for the agent-do lifecycle are recorded");
  await setLogVerbosity("off");
});

Deno.test("agent-do lifecycle: SILENT below verbose (normal = off, off = off)", async () => {
  await capLogReady();
  for (const level of ["normal", "off"]) {
    await setLogVerbosity(level);
    clearLogBuffer();
    const { calls, restore } = captureConsole();
    try {
      await runOne();
    } finally { restore(); }
    const leaked = calls.filter((c) => c.text.includes("agent-do"));
    assertEquals(leaked.length, 0, `no agent-do lines at ${level}`);
    // The ring is cap-log's by-design diagnostic buffer (it retains gated lines
    // for dumpLogBuffer inspection) — the VERBOSITY GATE is the console surface.
    // Silence = nothing printed; ring retention is intentional, not a leak.
  }
  await setLogVerbosity("off");
});

// ── CAP-FB-20260830-MODEL-CALL-ECONOMY-01 ────────────────────────────────────
// agent-do sends "Continue working on the task…" after ANY outer iteration
// that called tools — even one that already ended in the model's final
// answer, where the extra call can only produce a repeat. The product now
// stops the loop through agent-do's own `onStepStart → {decision:"stop"}`
// hook when the previous iteration answered, and caps consecutive silent
// continuations (tools, then nothing) at three with a visible "stopped" event.
import { resetUsageMigration } from "../extension/lib/usage-store.js";

function economyMemory() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : undefined; },
    async set(k, v) { store.set(k, v); return { ok: true }; },
    async has(k) { return store.has(k); },
    async list() { return [...store.keys()]; },
    async clear() { store.clear(); return { ok: true }; },
  };
}

function economyReset() { resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); clearFaults(); resetUsageMigration(); }

/** A v2 stream for one model call: `parts` are the content parts (text and/or
 * tool-call); `finishReason` closes it. */
function streamOf(parts, finishReason) {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  return new ReadableStream({
    start(c) {
      c.enqueue({ type: "stream-start", warnings: [] });
      for (const p of parts) {
        if (p.text != null) {
          c.enqueue({ type: "text-start", id: "t" });
          c.enqueue({ type: "text-delta", id: "t", delta: p.text });
          c.enqueue({ type: "text-end", id: "t" });
        }
        if (p.tool) {
          c.enqueue({ type: "tool-call", toolCallId: p.id, toolName: p.tool, input: JSON.stringify(p.args ?? {}) });
        }
      }
      c.enqueue({ type: "finish", usage, finishReason });
      c.close();
    },
  });
}

/** A model that calls one tool, then writes its final answer on the very next
 * call (finish "stop"). Any call after that is a continuation the product
 * should never have made — it answers with a tell-tale text. */
function answersAfterToolsModel() {
  let calls = 0;
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "answers-after-tools",
    supportedUrls: {},
    calls: () => calls,
    async doStream() {
      calls += 1;
      if (calls === 1) return { stream: streamOf([{ tool: "search_tools", id: "call_1", args: { query: "memory_get", limit: 1 } }], "tool-calls") };
      if (calls === 2) return { stream: streamOf([{ text: "Done: memory_get is available." }], "stop") };
      return { stream: streamOf([{ text: "CONTINUATION REPLY — this call should not exist." }], "stop") };
    },
  };
}

/** A model that answers every continuation with a tool call and then goes
 * silent: odd calls issue a tool call, even calls end with no text at all
 * (finish "stop"). Left alone, agent-do nudges it until maxIterations. */
function toolThenSilentModel() {
  let calls = 0;
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "tool-then-silent",
    supportedUrls: {},
    calls: () => calls,
    async doStream() {
      calls += 1;
      if (calls % 2 === 1) return { stream: streamOf([{ tool: "search_tools", id: `call_${calls}`, args: { query: "memory_get", limit: 1 } }], "tool-calls") };
      return { stream: streamOf([], "stop") };
    },
  };
}

Deno.test("model-call economy: no continuation after a step that produced final text", async () => {
  economyReset();
  const model = answersAfterToolsModel();
  const events = [];
  const agent = createAgent({
    model: { model, modelId: "answers-after-tools", providerName: "test" },
    id: "economy", name: "economy", system: "you are a test agent", memory: economyMemory(), taskId: "t-economy",
    maxIterations: 4,
    onProgress: (ev) => events.push(ev),
  });
  const result = await agent.run("is memory_get available?", "", []);
  assertEquals(model.calls(), 2, "search + answer: exactly two model calls, no continuation call");
  assertEquals(String(result), "Done: memory_get is available.", "the answer is the run's result");
  assert(!events.some((e) => e.type === "text" && /CONTINUATION REPLY/.test(String(e.text ?? ""))), "no continuation reply was ever produced");
  assert(!events.some((e) => e.type === "text" && e.hidden === true), "nothing had to be hidden — there was no nudge reply");
  const done = events.find((e) => e.type === "done");
  assertEquals(done?.budget?.exhausted, false);
  assertEquals(done?.budget?.stopped, undefined, "an answered run is not a stopped run");
  assertEquals(done?.text, "Done: memory_get is available.");
});

Deno.test("model-call economy: a tool-on-every-nudge model stops at 3 silent continuations with a stopped event", async () => {
  economyReset();
  const model = toolThenSilentModel();
  const events = [];
  const agent = createAgent({
    model: { model, modelId: "tool-then-silent", providerName: "test" },
    id: "economy-cap", name: "economy-cap", system: "you are a test agent", memory: economyMemory(), taskId: "t-economy-cap",
    maxIterations: 10,
    onProgress: (ev) => events.push(ev),
  });
  await agent.run("keep going", "", []);
  // Three outer iterations of (tool call, silence) — six model calls — then
  // the loop stops instead of sending a fourth continuation.
  assertEquals(model.calls(), 6, "three iterations × two calls; the fourth continuation is never sent");
  const stopped = events.find((e) => e.type === "stopped");
  assert(stopped, `a stopped event was emitted: ${JSON.stringify(events.map((e) => e.type))}`);
  assertEquals(stopped.reason, "iteration-cap");
  assertEquals(stopped.iterations, 3, "three nudged iterations went silent");
  assertEquals(stopped.steps, 6, "the marker counts model steps, the unit the status row already shows");
  const done = events.find((e) => e.type === "done");
  assertEquals(done?.budget?.stopped?.reason, "iteration-cap", "the done event carries the stop so the terminal can state it");
  assertEquals(done?.budget?.stopped?.steps, 6);
  assertEquals(done?.budget?.exhausted, false, "a continuation-cap stop is not budget exhaustion");
});

/** A model that answers at once (no tools); records the options each call saw. */
function recordingTextModel(provider) {
  const seen = [];
  return {
    seen,
    model: {
      specificationVersion: "v2",
      provider,
      modelId: "recording",
      supportedUrls: {},
      async doStream(options) {
        seen.push(options);
        return { stream: streamOf([{ text: "Hello." }], "stop") };
      },
    },
  };
}

Deno.test("model-call economy: the Anthropic lane marks the system prompt as a prompt-cache breakpoint; other lanes are untouched", async () => {
  for (const [providerName, expectMarked] of [["anthropic", true], ["openai", false], ["gemini", false]]) {
    economyReset();
    const { model, seen } = recordingTextModel(providerName);
    const agent = createAgent({
      model: { model, modelId: "recording", providerName },
      id: "economy-cache", name: "economy-cache", system: "you are a test agent", memory: economyMemory(), taskId: "t-economy-cache",
      maxIterations: 2,
    });
    await agent.run("hi", "", []);
    assertEquals(seen.length, 1, `${providerName}: one model call`);
    const system = seen[0].prompt.find((m) => m.role === "system");
    assert(system, `${providerName}: the call carries a system message`);
    const marked = system.providerOptions?.anthropic?.cacheControl?.type === "ephemeral";
    assertEquals(marked, expectMarked, `${providerName}: cache breakpoint ${expectMarked ? "set" : "absent"}`);
    // The system TEXT is untouched either way (the attestation's prefixMatch
    // reads it byte-for-byte).
    assert(String(typeof system.content === "string" ? system.content : "").includes("you are a test agent"), `${providerName}: the composed text is intact`);
  }
});

/** A model that ANSWERS while still working: every call writes text AND calls a
 * tool (finish "tool-calls"), so only the step budget can end the run. */
function answersWhileWorkingModel() {
  let calls = 0;
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "answers-while-working",
    supportedUrls: {},
    calls: () => calls,
    async doStream() {
      calls += 1;
      return { stream: streamOf([{ text: "Digest: FACT-01 on page 1." }, { tool: "search_tools", id: `call_${calls}`, args: { query: "memory_get", limit: 1 } }], "tool-calls") };
    },
  };
}

Deno.test("model-call economy: an iteration cut off by the INNER STEP LIMIT still continues — the boundary is counted, not inferred from a raced finish reason", async () => {
  // The real-HTTP journey (budget verdict) caught this: the iteration ended on
  // the inner cap with text on its last step, the tee'd finish reason had not
  // drained yet, and the loop read it as "answered" and stopped a step early.
  // The call count inside the iteration is synchronous and settles it.
  economyReset();
  const model = answersWhileWorkingModel();
  const events = [];
  const agent = createAgent({
    model: { model, modelId: "answers-while-working", providerName: "test" },
    id: "economy-boundary", name: "economy-boundary", system: "you are a test agent", memory: economyMemory(), taskId: "t-economy-boundary",
    maxIterations: 2, // innerStepLimit 2 → 4 model steps of budget
    onProgress: (ev) => events.push(ev),
  });
  const result = await agent.run("read every tab", "", []);
  assertEquals(model.calls(), 4, "every allowed step ran — the inner-cap boundary is never mistaken for an answer");
  assertStringIncludes(String(result), "FACT-01", "the answer is still the run's result");
  const done = events.find((e) => e.type === "done");
  assertEquals(done?.budget?.exhausted, false, "a run that answered settles ok");
  assertEquals(done?.budget?.stopped, undefined, "the continuation cap never fired");
  assert(!events.some((e) => e.type === "text" && e.hidden === true), "the answer after a boundary is never hidden");
});
