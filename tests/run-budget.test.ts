// tests/run-budget.test.ts — CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01.
// @ts-nocheck — the agent core is deliberately dynamic.
//
// A run's step budget is FINITE, VISIBLE ("Step N of M") and RECOVERABLE
// (a "Budget reached — Continue" status with one Continue action that runs a
// new turn on the same thread), never a silent finish after four tool actions.
import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createAgent, RUN_BUDGET_DEFAULTS } from "../extension/lib/agent.js";
import {
  BUDGET_CONTINUE_TASK,
  budgetExhaustedTerminal,
  budgetExhaustedVerdict,
  isBudgetTerminal,
  formatBudgetProgress,
  RUN_BUDGET_BOUNDS,
} from "../extension/lib/run-budget.js";
import {
  normalizeConversationRunStatus,
  runStatusActionKind,
  runStatusActionLabel,
} from "../extension/shared/run-status.js";

function __reset() { resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); }
globalThis.chrome ??= { permissions: { contains: async () => false }, storage: undefined };

/** A model that NEVER finishes: every step issues one tool call (search_tools),
 * so the loop can only end when the step budget runs out. */
function toolsForeverModel() {
  let calls = 0;
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "tools-forever",
    supportedUrls: {},
    calls: () => calls,
    async doStream() {
      calls += 1;
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "tool-call", toolCallId: `call_${calls}`, toolName: "search_tools", input: JSON.stringify({ query: "memory_get", limit: 1 }) });
          c.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
          c.close();
        },
      });
      return { stream };
    },
  };
}

/** A model that ANSWERS while still working: every step writes text AND
 * issues one tool call, so the loop only ends when the step budget runs out —
 * but the answer has already landed on the last allowed step. */
function answersWhileWorkingModel(answer = "Digest: FACT-01 on page 1; FACT-02 on page 2.") {
  let calls = 0;
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "answers-while-working",
    supportedUrls: {},
    calls: () => calls,
    async doStream() {
      calls += 1;
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "t" });
          c.enqueue({ type: "text-delta", id: "t", delta: answer });
          c.enqueue({ type: "text-end", id: "t" });
          c.enqueue({ type: "tool-call", toolCallId: `call_${calls}`, toolName: "search_tools", input: JSON.stringify({ query: "memory_get", limit: 1 }) });
          c.enqueue({ type: "finish", usage, finishReason: "tool-calls" });
          c.close();
        },
      });
      return { stream };
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

Deno.test("run budget: the defaults fit a 30-tab loop and every bound stays finite", () => {
  assertEquals(RUN_BUDGET_DEFAULTS.maxIterations, 48, "hub default 12 → 48");
  assertEquals(RUN_BUDGET_DEFAULTS.innerStepLimit(48), 24, "one inner turn holds 24 model steps");
  assertEquals(RUN_BUDGET_DEFAULTS.innerStepLimit(2), 2, "never more inner steps than iterations");
  assertEquals(RUN_BUDGET_DEFAULTS.innerStepLimit(1), 2, "the floor stays 2");
  for (const [name, value] of Object.entries(RUN_BUDGET_BOUNDS)) {
    assert(Number.isFinite(value) && value > 0, `${name} is a finite positive bound`);
  }
  assert(RUN_BUDGET_DEFAULTS.maxIterations <= RUN_BUDGET_BOUNDS.maxIterations, "the default is inside the cap");
});

Deno.test("run budget: the agent emits Step N of M progress and flags exhaustion instead of finishing silently", async () => {
  __reset();
  const model = toolsForeverModel();
  const events = [];
  const agent = createAgent({
    model: { model, modelId: "tools-forever", providerName: "test" },
    id: "budget-test",
    name: "budget-test",
    system: "you are a test agent",
    memory: fakeMemory(),
    taskId: "t-budget",
    maxIterations: 2,
    onProgress: (ev) => events.push(ev),
  });
  const result = await agent.run("read every tab", "", []);
  const budget = events.filter((e) => e?.type === "budget");
  assert(budget.length >= 2, `budget progress events were emitted: ${JSON.stringify(events.map((e) => e.type))}`);
  // total = maxIterations × innerStepLimit = 2 × 2 = 4 model steps.
  assert(budget.every((e) => e.total === 4), `every budget event names the same total, got ${JSON.stringify(budget)}`);
  const steps = budget.map((e) => e.step);
  assert(steps.every((s, i) => i === 0 || s >= steps[i - 1]), "the step counter never goes backwards");
  assert(Math.max(...steps) === 4, `the counter reached the total (${JSON.stringify(steps)})`);
  const last = budget[budget.length - 1];
  assertEquals(last.exhausted, true, "the final budget event says the budget ran out with work still to do");
  assertEquals(last.step, 4);
  assertEquals(last.total, 4);
  assertEquals(model.calls(), 4, "exactly the budgeted number of model calls happened");
  // The done event carries the same truth so a surface that missed the
  // budget event still knows the run did not finish its work.
  const done = events.find((e) => e?.type === "done");
  assertEquals(done?.budget?.exhausted, true);
  assertEquals(typeof result, "string", "the partial text is still returned");
});

// CAP-FB-20260902-BUDGET-VERDICT-ANSWERED-01: "Budget reached" is the verdict
// ONLY when the budget ran out with NO substantive final text. A run that
// wrote its answer on its last allowed step — even while still calling tools —
// answered, and settles as finished.
Deno.test("run budget: exhausted WITH final text settles ok (the answer landed on the last allowed step)", async () => {
  __reset();
  const model = answersWhileWorkingModel();
  const events = [];
  const agent = createAgent({
    model: { model, modelId: "answers-while-working", providerName: "test" },
    id: "budget-answered",
    name: "budget-answered",
    system: "you are a test agent",
    memory: fakeMemory(),
    taskId: "t-budget-answered",
    maxIterations: 2,
    onProgress: (ev) => events.push(ev),
  });
  const result = await agent.run("read every tab", "", []);
  assertEquals(model.calls(), 4, "the budget itself is unchanged: every allowed step ran");
  const budget = events.filter((e) => e?.type === "budget");
  const last = budget[budget.length - 1];
  assertEquals(last.step, 4);
  assertEquals(last.total, 4);
  assert(budget.every((e) => e.exhausted !== true), `a run that answered never claims exhaustion: ${JSON.stringify(budget.map((e) => e.exhausted))}`);
  const done = events.find((e) => e?.type === "done");
  assertEquals(done?.budget?.exhausted, false, "the done event settles ok — the answer landed");
  assertEquals(done?.budget?.used, 4);
  assertStringIncludes(String(done?.text), "FACT-01", "the done text IS the answer");
  assertStringIncludes(String(result), "FACT-02", "the returned result IS the answer");
});

Deno.test("run budget: exhausted WITHOUT final text settles budget (never ok for a run with no substantive text)", async () => {
  __reset();
  // Tool calls every step, no text at all: the honest verdict is a budget stop.
  const model = toolsForeverModel();
  const events = [];
  const agent = createAgent({
    model: { model, modelId: "tools-forever", providerName: "test" },
    id: "budget-silent", name: "budget-silent", system: "x", memory: fakeMemory(), taskId: "t-budget-silent",
    maxIterations: 2, onProgress: (ev) => events.push(ev),
  });
  const result = await agent.run("read every tab", "", []);
  assertEquals(String(result ?? "").trim(), "", "no substantive text was produced");
  const budget = events.filter((e) => e?.type === "budget");
  assertEquals(budget[budget.length - 1]?.exhausted, true);
  assertEquals(events.find((e) => e?.type === "done")?.budget?.exhausted, true);
  // The pure verdict, every branch: exhausted only when the LAST allowed
  // iteration still had tool calls AND no final text landed.
  const base = { aborted: false, lastStepHadTools: true, lastStepIndex: 1, maxIterations: 2 };
  assertEquals(budgetExhaustedVerdict({ ...base, hasFinalText: false }), true, "no text → budget");
  assertEquals(budgetExhaustedVerdict({ ...base, hasFinalText: true }), false, "answered → ok");
  assertEquals(budgetExhaustedVerdict({ ...base, aborted: true, hasFinalText: false }), false, "an abort is not a budget stop");
  assertEquals(budgetExhaustedVerdict({ ...base, lastStepHadTools: false, hasFinalText: false }), false, "the loop finished on its own");
  assertEquals(budgetExhaustedVerdict({ ...base, lastStepIndex: 0, hasFinalText: false }), false, "not the last allowed iteration");
  assertEquals(budgetExhaustedVerdict({}), false, "nothing known → not a budget stop");
});

Deno.test("run budget: a run that finishes early is NOT flagged exhausted", async () => {
  __reset();
  let calls = 0;
  const model = {
    specificationVersion: "v2", provider: "test", modelId: "one-and-done", supportedUrls: {},
    async doStream() {
      calls += 1;
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      return { stream: new ReadableStream({ start(c) {
        c.enqueue({ type: "stream-start", warnings: [] });
        c.enqueue({ type: "text-start", id: "t" });
        c.enqueue({ type: "text-delta", id: "t", delta: "done" });
        c.enqueue({ type: "text-end", id: "t" });
        c.enqueue({ type: "finish", usage, finishReason: "stop" });
        c.close();
      } }) };
    },
  };
  const events = [];
  const agent = createAgent({
    model: { model, modelId: "one-and-done", providerName: "test" },
    id: "budget-early", name: "budget-early", system: "x", memory: fakeMemory(), taskId: "t2",
    maxIterations: 2, onProgress: (ev) => events.push(ev),
  });
  await agent.run("say done", "", []);
  const budget = events.filter((e) => e?.type === "budget");
  assert(budget.length >= 1);
  assert(budget.every((e) => e.exhausted !== true), "a finished run never claims exhaustion");
  assertEquals(events.find((e) => e?.type === "done")?.budget?.exhausted, false);
  assertEquals(calls, 1);
});

/** The keyless every-item loop: 12 listed tabs are read through the REAL lazy
 * protocol with ONE read_page search — the SAME selectionRef for every read —
 * and a tab that cannot be read is named, not skipped silently. */
Deno.test("run budget: @demo-every-tab reads every listed tab with one search and reports the unreadable one", async () => {
  __reset();
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const { tool } = await import("ai");
  const { z } = await import("zod");
  const N = 12;
  const events = [];
  const reads = [];
  const agent = createAgent({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    id: "hub", name: "hub", system: "test", memory: fakeMemory(), taskId: "t-every",
    tools: {
      list_tabs: tool({ description: "List EVERY open tab", inputSchema: z.object({}), execute: async () => ({ count: N + 2, windows: 1, tabs: [
        { id: 1, url: "chrome-extension://x/ntp.html", title: "hub" },
        ...Array.from({ length: N }, (_, i) => ({ id: 100 + i, url: `http://127.0.0.1:1/tab/${i + 1}`, title: `tab ${i + 1}` })),
        { id: 2, url: "http://127.0.0.1:1/red.html", title: "red" },
      ] }) }),
      read_page: tool({ description: "Read the page", inputSchema: z.object({ tabId: z.number() }), execute: async ({ tabId }) => {
        reads.push(tabId);
        if (tabId === 105) return { error: "Cannot access contents of the page." };
        return { untrusted: true, title: `t${tabId}`, url: `http://127.0.0.1:1/tab/${tabId - 99}`, text: `page ${tabId}` };
      } }),
    },
    onProgress: (ev) => events.push(ev),
  });
  const result = await agent.run("@demo-every-tab match=/tab/", "", []);
  const calls = events.filter((e) => e.type === "tool-call");
  assertEquals(calls.filter((e) => e.toolName === "search_tools").length, 2, "one search for list_tabs, one for read_page");
  assertEquals(calls.filter((e) => e.toolName === "execute_tool").length, N + 1, "one list + one read per tab");
  const refs = new Set(calls.filter((e) => e.toolName === "execute_tool" && e.toolArgs?.arguments?.tabId != null).map((e) => e.toolArgs?.selectionRef));
  assertEquals(refs.size, 1, "every read used the SAME selectionRef");
  assertEquals(new Set(reads).size, N, "every listed tab was read exactly once");
  assertStringIncludes(String(result), `Every tab: listed ${N}, read ${N - 1} of ${N}`);
  assertStringIncludes(String(result), "could not read 1: 105 (Cannot access contents of the page.)");
  assertEquals(events.find((e) => e.type === "done")?.budget?.exhausted, false);
});

Deno.test("run budget: @demo-every-tab tabs=… reads the given tabs with one search and no list_tabs", async () => {
  __reset();
  const { createDemoModel } = await import("../extension/lib/models/demo-model.js");
  const { tool } = await import("ai");
  const { z } = await import("zod");
  const events = [];
  const reads = [];
  const agent = createAgent({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    id: "hub", name: "hub", system: "test", memory: fakeMemory(), taskId: "t-every-ids",
    tools: {
      list_tabs: tool({ description: "List EVERY open tab", inputSchema: z.object({}), execute: async () => { throw new Error("must not be called"); } }),
      read_page: tool({ description: "Read the page", inputSchema: z.object({ tabId: z.number() }), execute: async ({ tabId }) => { reads.push(tabId); return { untrusted: true, title: `t${tabId}`, text: "x" }; } }),
    },
    onProgress: (ev) => events.push(ev),
  });
  const result = await agent.run("@demo-every-tab tabs=7,8,9,10", "", []);
  const calls = events.filter((e) => e.type === "tool-call");
  assertEquals(calls.filter((e) => e.toolName === "search_tools").length, 1);
  assertEquals(calls.filter((e) => e.toolName === "execute_tool").length, 4);
  assertEquals(reads, [7, 8, 9, 10]);
  assertStringIncludes(String(result), "Every tab: listed 4, read 4 of 4.");
});

Deno.test("run budget: the terminal shape is a plain-English budget stop with one Continue action", () => {
  const terminal = budgetExhaustedTerminal({ used: 48, total: 48 });
  assertEquals(terminal.ok, false);
  assertEquals(terminal.errorCategory, "budget");
  assertEquals(terminal.errorAction, "Continue");
  assertStringIncludes(terminal.error, "48 of 48");
  assertStringIncludes(terminal.errorReason, "48");
  assert(!/\bmaxIterations|innerStepLimit\b/.test(JSON.stringify(terminal)), "no code vocabulary reaches the owner");
  assertEquals(terminal.budget, { used: 48, total: 48, exhausted: true });
  assertEquals(isBudgetTerminal(terminal), true);
  assertEquals(isBudgetTerminal({ errorCategory: "provider-auth" }), false);
  assertEquals(isBudgetTerminal(null), false);
  assertStringIncludes(BUDGET_CONTINUE_TASK, "Continue");
  assert(BUDGET_CONTINUE_TASK.length < 400, "the continuation turn stays short");
  assertEquals(formatBudgetProgress({ step: 34, total: 80 }), "Step 34 of 80");
  assertEquals(formatBudgetProgress(null), "");
});

Deno.test("run budget: the status row offers Continue (not Fix in Settings) for a budget stop", () => {
  assertEquals(runStatusActionLabel({ state: "failed", errorCategory: "budget" }), "Continue");
  assertEquals(runStatusActionKind({ state: "failed", errorCategory: "budget" }), "continue");
  assertEquals(runStatusActionKind({ state: "failed", errorCategory: "provider-auth" }), "settings");
  assertEquals(runStatusActionKind({ state: "completed", errorCategory: "budget" }), null, "a finished run has no action");
  assertEquals(runStatusActionKind({ state: "running", errorCategory: "budget" }), null);
  const status = normalizeConversationRunStatus({
    state: "failed",
    errorCategory: "budget",
    errorReason: "the run used all 48 of its 48 steps and still had work to do",
  });
  assertEquals(status.state, "failed");
  assertStringIncludes(status.label, "Budget reached");
  assert(!/^Failed/.test(status.label), "a budget stop is not presented as a failure");
  assertEquals(status.tone, "accent");
  assertEquals(status.active, false);
});
