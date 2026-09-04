// tests/workflows.test.ts — the agent's reusable-workflow store
// (workflows-to-memory, chrome-agent-platform-9ve7): save_workflow /
// workflow_list / workflow_get / workflow_run against a shimmed in-memory store
// (no OPFS), the pure production paths (validation / prompt sanitization incl.
// U+2028/U+2029 / run plans / runWorkflowRoute / runPipelineWorkflow), the
// agent-bound pipeline dispatcher's fail-closed contract, the enrollment + 
// read-only fences, and the system-prompt recall seam (the run-time memory
// digest lists the saved-workflow keys).
//
// FALSIFICATION: none of this existed before the feature — the module import
// fails on the pre-change tree, so every test here is red without it. Within
// the feature, targeted breakage is pinned per test: remove the U+2028/U+2029
// replacement and "sanitizePromptText neutralizes Unicode line separators"
// goes red; drop the permission-pause branch in
// createWorkflowPipelineDispatcher and "fails closed naming tool+requirement"
// goes red; let a pipeline workflow fall through to the sandbox route and
// "runPipelineWorkflow runs steps in order" goes red.
// @ts-nocheck — the in-memory store shim + toolset are intentionally dynamic.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  validateWorkflow,
  buildWorkflowsPrompt,
  sanitizePromptText,
  workflowKey,
  workflowNameFromKey,
  workflowRunPlan,
  runWorkflowRoute,
  runPipelineWorkflow,
  createWorkflowPipelineDispatcher,
  WORKFLOW_KINDS,
} from "../extension/lib/workflows.js";
import { workflowsToolset } from "../extension/lib/agent.js";
import { gatherRuntimeContext } from "../extension/lib/runtime-context.js";

// A tiny in-memory memory store (mirrors the OPFS store's set→version contract).
function makeMemory(seed = {}) {
  const map = new Map(Object.entries(seed));
  let version = 0;
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async has(key) { return map.has(key); },
    async set(key, value) {
      const s = JSON.stringify(value);
      if (s.length > 256 * 1024) throw new Error("value exceeds 256 KiB bound");
      map.set(key, value);
      version += 1;
      return version;
    },
    async keys() { return [...map.keys()]; },
    async delete(key) { map.delete(key); },
    async getVersion(key) { return map.has(key) ? 1 : 0; },
    async compareAndDelete(key, expectedVersion) {
      if (map.has(key) && (expectedVersion == null || expectedVersion >= 1)) map.delete(key);
    },
    _map: map,
  };
}

function tools(mem, overrides = {}) {
  return workflowsToolset({ memory: mem, ...overrides });
}

const SAMPLE_JS = "return { ok: true, from: 'workflow' };";
const SAMPLE_PIPE = JSON.stringify({
  steps: [
    { id: "s1", tool: "memory_get", args: { key: "x" } },
    { id: "s2", tool: "memory_set", args: { key: "y", value: { $ref: "s1", path: "value" } } },
  ],
});
const SAMPLE_INST = "1. Open the hub. 2. Run a task.";

Deno.test("save_workflow: writes a script-js workflow to the origin store and returns ok", async () => {
  const mem = makeMemory();
  const t = tools(mem);
  const r = await t.save_workflow.execute({ name: "demo-summarise", description: "Summarise the page", kind: "script-js", content: SAMPLE_JS });
  assert(r.ok, `save should succeed, got ${JSON.stringify(r)}`);
  const rec = await mem.get(workflowKey("demo-summarise"));
  assertEquals(rec.kind, "script-js");
  assertEquals(rec.name, "demo-summarise");
  assert(Number.isInteger(rec.createdAt));
});

Deno.test("save_workflow: accepts every kind", async () => {
  for (const kind of WORKFLOW_KINDS) {
    const mem = makeMemory();
    const r = await tools(mem).save_workflow.execute({ name: `wf-${kind}`, kind, content: kind === "script-js" ? SAMPLE_JS : kind === "pipeline" ? SAMPLE_PIPE : SAMPLE_INST });
    assert(r.ok, `${kind} should save, got ${JSON.stringify(r)}`);
  }
});

Deno.test("save_workflow: rejects invalid kinds", async () => {
  const r = await tools(makeMemory()).save_workflow.execute({ name: "bad", kind: "binary", content: "x" });
  assert(!r.ok, "invalid kind must be refused");
  assertStringIncludes(String(r.error), "kind");
});

Deno.test("save_workflow: no size ceilings — a 65+ char name and 64 KiB+ content save whole (dptw de-cap)", async () => {
  // FALSIFICATION: on the capped tree every one of these saves was refused
  // ("exceeds 64 chars" / "exceeds 65536 UTF-8 bytes"). Post-dptw the OPFS
  // store and its quota are the only ceiling — shape is validated, size is not.
  const mem = makeMemory();
  const t = tools(mem);
  // name past the old 64-char bound
  const longName = "n".repeat(65);
  const named = await t.save_workflow.execute({ name: longName, kind: "script-js", content: SAMPLE_JS });
  assert(named.ok, "a 65-char name must save, got " + JSON.stringify(named));
  // content past the old 64 KiB bound
  const big = await t.save_workflow.execute({ name: "big", kind: "script-js", content: "x".repeat(64 * 1024 + 1) });
  assert(big.ok, "64 KiB+1 content must save, got " + JSON.stringify(big));
  const stored = await mem.get(workflowKey("big"));
  assertEquals(stored.content.length, 64 * 1024 + 1, "the content is stored WHOLE, not clipped");
  // multibyte content: 40k two-byte chars ≈ 80 KiB of UTF-8 — past the old
  // byte bound; the whole string survives.
  const multi = await t.save_workflow.execute({ name: "multi", kind: "script-js", content: "\u00e9".repeat(40 * 1024) });
  assert(multi.ok, "80 KiB of UTF-8 must save, got " + JSON.stringify(multi));
  const storedMulti = await mem.get(workflowKey("multi"));
  assertEquals(storedMulti.content, "\u00e9".repeat(40 * 1024), "multibyte content stored whole");
});

Deno.test("save_workflow: long names sharing a 64-char prefix are DISTINCT workflows (no silent key truncation)", async () => {
  // The old workflowKey sliced names to 64 chars — two workflows whose names
  // agreed for 64 chars silently shared one key (the second overwrote the
  // first). The full name is the key now.
  const prefix = "shared-prefix-".padEnd(64, "x");
  const mem = makeMemory();
  const t = tools(mem);
  const a = await t.save_workflow.execute({ name: prefix + "-alpha", kind: "script-js", content: "return 1;" });
  const b = await t.save_workflow.execute({ name: prefix + "-beta", kind: "script-js", content: "return 2;" });
  assert(a.ok && b.ok, "both long-prefixed names save");
  const ga = await t.workflow_get.execute({ name: prefix + "-alpha" });
  const gb = await t.workflow_get.execute({ name: prefix + "-beta" });
  assert(ga.ok && gb.ok, "both read back independently");
  assertEquals(ga.workflow.content, "return 1;", "alpha was NOT overwritten by beta");
  assertEquals(gb.workflow.content, "return 2;", "beta kept its own body");
});

Deno.test("workflow_run: a past-bound (65 KiB+) script-js workflow RUNS end-to-end — gate and sandbox receive the full body", async () => {
  // FALSIFICATION: pre-decap the plan refused any content past 64 KiB before
  // the approval card ("content exceeds … — corrupt or forged"). Now a large
  // shape-valid record runs like any other.
  const bigSource = "// " + "x".repeat(65 * 1024) + "\nreturn 42;";
  const mem = makeMemory();
  await tools(mem).save_workflow.execute({ name: "big-run", kind: "script-js", content: bigSource });
  let gateSource = null;
  let sandboxSource = null;
  const t = workflowsToolset({
    memory: mem,
    runRoute: async (args) => {
      gateSource = args.source;
      return runWorkflowRoute({
        ...args,
        gate: async () => ({ ok: true }),
        runSandboxed: async (src) => { sandboxSource = src; return { ok: true, result: 42, logs: [] }; },
      });
    },
  });
  const r = await t.workflow_run.execute({ name: "big-run" });
  assert(r.ok, "a 65 KiB+ workflow must run, got " + JSON.stringify(r));
  assertEquals(gateSource, bigSource, "the approval path received the WHOLE source");
  assertEquals(sandboxSource, bigSource, "the sandbox received the WHOLE source");
  assertEquals(r.result, 42);
});

Deno.test("runWorkflowRoute: a past-bound sandbox RESULT returns whole (no 256 KiB clip)", async () => {
  const bigResult = { data: "y".repeat(300 * 1024) };
  const res = await runWorkflowRoute({
    name: "big-result",
    kind: "script-js",
    source: "return 1",
    gate: async () => ({ ok: true }),
    runSandboxed: async () => ({ ok: true, result: bigResult, logs: [] }),
  });
  assert(res.ok);
  assertEquals(res.result, bigResult, "the result is returned whole — a clipped result is a wrong answer");
});

Deno.test("workflow_list: returns name/kind/description only", async () => {
  const mem = makeMemory();
  const t = tools(mem);
  await t.save_workflow.execute({ name: "a", kind: "script-js", description: "desc a", content: SAMPLE_JS });
  await t.save_workflow.execute({ name: "b", kind: "instructions", description: "desc b", content: SAMPLE_INST });
  const r = await t.workflow_list.execute({});
  assert(r.ok);
  assertEquals(r.workflows.length, 2);
  const names = r.workflows.map((w) => w.name).sort();
  assertEquals(names, ["a", "b"]);
  for (const w of r.workflows) {
    assert(w.kind, "kind present");
    assert(w.description !== undefined, "description present");
    assert(!("content" in w), "content never in the list");
  }
});

Deno.test("workflow_list: empty store returns an empty list", async () => {
  const r = await tools(makeMemory()).workflow_list.execute({});
  assert(r.ok);
  assertEquals(r.workflows, []);
});

Deno.test("workflow_get: reads the full record including content", async () => {
  const mem = makeMemory();
  const t = tools(mem);
  await t.save_workflow.execute({ name: "full", kind: "script-js", description: "d", content: SAMPLE_JS });
  const r = await t.workflow_get.execute({ name: "full" });
  assert(r.ok);
  assertEquals(r.workflow.content, SAMPLE_JS);
  assertEquals(r.workflow.kind, "script-js");
});

Deno.test("workflow_get: absent workflow returns a clear error", async () => {
  const r = await tools(makeMemory()).workflow_get.execute({ name: "nope" });
  assert(!r.ok);
  assertStringIncludes(String(r.error), "not found");
});

Deno.test("workflow_run: dispatches script-js to the run route and returns its result", async () => {
  const mem = makeMemory();
  const t = tools(mem);
  await t.save_workflow.execute({ name: "runme", kind: "script-js", content: SAMPLE_JS });
  let dispatched = null;
  const t2 = workflowsToolset({
    memory: mem,
    runRoute: async (args) => { dispatched = args; return { ok: true, result: { from: "route" } }; },
  });
  const r = await t2.workflow_run.execute({ name: "runme" });
  assert(r.ok);
  assertEquals(dispatched.name, "runme");
  assertEquals(dispatched.kind, "script-js");
  assertEquals(dispatched.source, SAMPLE_JS);
  assertEquals(r.result.from, "route");
});

Deno.test("workflow_run: absent route fails closed", async () => {
  const mem = makeMemory();
  await tools(mem).save_workflow.execute({ name: "runme", kind: "script-js", content: SAMPLE_JS });
  const r = await tools(mem).workflow_run.execute({ name: "runme" });
  assert(!r.ok);
  assertStringIncludes(String(r.error), "not available");
});

Deno.test("workflow_run: absent workflow is a clear error", async () => {
  const r = await tools(makeMemory(), { runRoute: async () => ({ ok: true }) }).workflow_run.execute({ name: "nope" });
  assert(!r.ok);
  assertStringIncludes(String(r.error), "not found");
});

Deno.test("origin isolation: two stores never see each other's workflows", async () => {
  const memA = makeMemory();
  const memB = makeMemory();
  await tools(memA).save_workflow.execute({ name: "mine", kind: "script-js", content: SAMPLE_JS });
  const listB = await tools(memB).workflow_list.execute({});
  assertEquals(listB.workflows, [], "agent B must not see agent A's workflow");
  const getB = await tools(memB).workflow_get.execute({ name: "mine" });
  assert(!getB.ok, "agent B must not read agent A's workflow");
});

Deno.test("validateWorkflow: normalizes and shape-validates (no size bounds, dptw)", () => {
  const ok = validateWorkflow({ name: " x ", description: " d ", kind: "script-js", content: "y" });
  assert(ok.ok);
  assertEquals(ok.record.name, "x");
  assertEquals(ok.record.description, "d");
  const bad = validateWorkflow({ name: "", kind: "script-js", content: "y" });
  assert(!bad.ok, "an empty name is still refused (shape, not size)");
  // Past every old bound: accepted.
  const huge = validateWorkflow({ name: "n".repeat(500), description: "d".repeat(1000), kind: "script-js", content: "x".repeat(100 * 1024) });
  assert(huge.ok, "size is never a refusal reason — only shape is");
});

Deno.test("buildWorkflowsPrompt: lists name+kind+description, empty → empty string", () => {
  assertEquals(buildWorkflowsPrompt([]), "");
  assertEquals(buildWorkflowsPrompt(null), "");
  const p = buildWorkflowsPrompt([{ name: "summ", kind: "script-js", description: "Summarise" }]);
  assertStringIncludes(p, "## Saved workflows");
  assertStringIncludes(p, "summ (script-js: Summarise)");
  assert(!p.includes("function body"), "prompt never carries the body");
});

Deno.test("sanitizePromptText: newline/control chars cannot inject prompt lines", () => {
  assertEquals(sanitizePromptText("clean name"), "clean name");
  assertEquals(sanitizePromptText("line1\nline2"), "line1 line2");
  assertEquals(sanitizePromptText("a\r\nb"), "a b");
  assertEquals(sanitizePromptText("tab\there"), "tab here");
  assertEquals(sanitizePromptText("\u0000ctrl\u001f"), "ctrl");
  // The prompt layer itself must be injection-free end to end.
  const p = buildWorkflowsPrompt([{ name: "evil\n## Injected", kind: "script-js", description: "desc\n- sneaky" }]);
  assert(!p.includes("\n## Injected"), "a newline-bearing name must not open a new prompt section");
  assert(!p.includes("\n- sneaky"), "a newline-bearing description must not add a bullet");
  assertStringIncludes(p, "evil ## Injected (script-js: desc - sneaky)");
});

Deno.test("sanitizePromptText: Unicode line separators (U+2028/U+2029) are neutralized alongside \\n/\\r", () => {
  assertEquals(sanitizePromptText("a\u2028b"), "a b", "U+2028 must collapse like a newline");
  assertEquals(sanitizePromptText("a\u2029b"), "a b", "U+2029 must collapse like a newline");
  const p = buildWorkflowsPrompt([{ name: "evil\u2028## Injected", kind: "script-js", description: "desc\u2029- sneaky" }]);
  assert(!p.includes("\u2028## Injected"), "a U+2028-bearing name must not open a prompt line");
  assert(!p.includes("\u2029- sneaky"), "a U+2029-bearing description must not add a bullet");
  assertStringIncludes(p, "evil ## Injected (script-js: desc - sneaky)");
});

Deno.test("workflowNameFromKey: only the workflows: namespace decodes", () => {
  assertEquals(workflowNameFromKey("workflows:summ"), "summ");
  assertEquals(workflowNameFromKey("workflows:a:b"), "a:b");
  assertEquals(workflowNameFromKey("notes:summ"), null);
  assertEquals(workflowNameFromKey(workflowKey("x")), "x");
});

Deno.test("workflowRunPlan: decides kinds exactly like production", () => {
  const js = workflowRunPlan({ name: "x", kind: "script-js", content: "return 1" });
  assert(js.ok && js.mode === "script-js");
  assertEquals(js.source, "return 1");
  assert(!workflowRunPlan({ name: "p", kind: "script-python", content: "print(1)" }).ok, "script-python fails closed (runtime not admitted)");
  assert(!workflowRunPlan({ name: "i", kind: "instructions", content: "do x" }).ok, "instructions kind is never executed");
  const err = workflowRunPlan({ name: "n", kind: "bogus", content: "" });
  assert(!err.ok && String(err.error).includes("bogus"), "unknown kind names the kind");
  // A valid pipeline body parses + validates into a runnable pipeline.
  const pipe = workflowRunPlan({ name: "p", kind: "pipeline", content: SAMPLE_PIPE });
  assert(pipe.ok && pipe.mode === "pipeline", `valid pipeline should plan, got ${JSON.stringify(pipe)}`);
  assertEquals(pipe.pipeline.steps.length, 2);
  // A broken pipeline body fails closed with the reason.
  const broken = workflowRunPlan({ name: "p", kind: "pipeline", content: "{\"steps\":[{\"id\":\"s1\",\"tool\":\"memory_get\",\"args\":{\"key\":\"x\",\"bad\":\"not-referenced\"}},{\"id\":\"s1\",\"tool\":\"x\"}]}" });
  assert(!broken.ok, "a pipeline binding an unknown earlier ref must not plan");
  const notJson = workflowRunPlan({ name: "p", kind: "pipeline", content: "not json" });
  assert(!notJson.ok && String(notJson.error).includes("JSON"), "non-JSON pipeline body fails closed");
});

Deno.test("runWorkflowRoute: drives the production path through an approval gate + sandbox", async () => {
  let gateCalled = 0;
  let sandboxCalled = 0;
  const res = await runWorkflowRoute({
    name: "runme",
    kind: "script-js",
    source: "return 42",
    description: "d",
    gate: async ({ name, description }) => {
      gateCalled += 1;
      assert(name === "runme" && description === "d", "gate receives the workflow identity");
      return { ok: true, approvalId: "ap-1" };
    },
    runSandboxed: async (src) => {
      sandboxCalled += 1;
      assertEquals(src, "return 42", "sandbox receives the workflow body");
      return { ok: true, result: 42, logs: [] };
    },
  });
  assert(res.ok && res.result === 42);
  assertEquals(gateCalled, 1, "the approval gate is invoked (approvable action)");
  assertEquals(sandboxCalled, 1, "the sandbox executes the body");
});

Deno.test("runWorkflowRoute: a DENIED approval never reaches the sandbox (fail closed)", async () => {
  let sandboxCalled = 0;
  const res = await runWorkflowRoute({
    name: "denied",
    kind: "script-js",
    source: "return 1",
    gate: async () => ({ ok: false, error: "operation is not approvable" }),
    runSandboxed: async () => { sandboxCalled += 1; return { ok: true, result: 1 }; },
  });
  assert(!res.ok);
  assertStringIncludes(String(res.error), "not approvable");
  assertEquals(sandboxCalled, 0, "the sandbox must never run after a denied gate");
});

Deno.test("runWorkflowRoute: refuses non-script-js kinds at the route", async () => {
  const res = await runWorkflowRoute({
    name: "pipe",
    kind: "pipeline",
    source: SAMPLE_PIPE,
    gate: async () => ({ ok: true }),
    runSandboxed: async () => ({ ok: true, result: 1 }),
  });
  assert(!res.ok, "a pipeline must never reach the sandbox host route");
  assertStringIncludes(String(res.error), "script-js");
});

Deno.test("runPipelineWorkflow: runs pipeline steps in order through the dispatcher (bindings resolve)", async () => {
  const calls = [];
  const dispatchStep = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "memory_get") return { ok: true, value: { value: "hello" } };
    return { ok: true, value: "written" };
  };
  const res = await runPipelineWorkflow({ name: "p", kind: "pipeline", content: SAMPLE_PIPE, dispatchStep });
  assert(res.ok, `pipeline should run, got ${JSON.stringify(res)}`);
  assertEquals(calls.length, 2, "both steps dispatch in order");
  assertEquals(calls[0].tool, "memory_get");
  // The binding $ref resolved: step 2's args carry step 1's RESULT value.
  assertEquals(calls[1].args.value, "hello", "the $ref binding must be resolved before dispatch");
  assertEquals(res.steps.length, 2);
});

Deno.test("runPipelineWorkflow: a past-bound (65 KiB+) pipeline body runs (size is not a refusal reason)", async () => {
  // FALSIFICATION: pre-decap the plan refused any content past 64 KiB. The
  // padding comment rides INSIDE the JSON so the body is both valid and huge.
  const bigPipe = JSON.stringify({
    steps: [{ id: "s1", tool: "memory_get", args: { key: "x" } }],
    comment: "z".repeat(65 * 1024),
  });
  const calls = [];
  const res = await runPipelineWorkflow({
    name: "big-pipe",
    kind: "pipeline",
    content: bigPipe,
    dispatchStep: async (tool) => { calls.push(tool); return { ok: true, value: "v" }; },
  });
  assert(res.ok, "a 65 KiB+ pipeline body must run, got " + JSON.stringify(res).slice(0, 200));
  assertEquals(calls, ["memory_get"]);
});

Deno.test("runPipelineWorkflow: a failing step halts the pipeline with the error", async () => {
  const res = await runPipelineWorkflow({
    name: "p",
    kind: "pipeline",
    content: SAMPLE_PIPE,
    dispatchStep: async (tool) => tool === "memory_get"
      ? { ok: false, error: "key is reserved" }
      : { ok: true, value: 1 },
  });
  assert(!res.ok);
  assertStringIncludes(String(res.error), "key is reserved");
  assert(res.completed.length === 0 || res.completed.length < 2, "the pipeline halts at the failing step");
});

Deno.test("createWorkflowPipelineDispatcher: resolves ONLY an exact tool-name match", async () => {
  const searches = [];
  const search = async (request) => {
    searches.push(request.query);
    // The catalog returns a CLOSE BUT NOT EXACT name — it must never run.
    return { ok: true, results: [{ name: "memory_get_extra", selectionRef: "sel_000000000000000000000000000000000000" }] };
  };
  const execute = async () => { throw new Error("must not execute a fuzzy match"); };
  const dispatcher = createWorkflowPipelineDispatcher({
    search,
    execute,
    settle: async () => {},
    context: async () => ({ signal: null, runId: "r1" }),
  });
  const r = await dispatcher("memory_get", { key: "x" }, 1);
  assert(!r.ok, "a fuzzy match must fail closed");
  assertStringIncludes(String(r.error), "not a runnable tool");
  assertEquals(searches[0], "memory_get");
});

Deno.test("createWorkflowPipelineDispatcher: executes the exact match and normalizes the envelope", async () => {
  const dispatcher = createWorkflowPipelineDispatcher({
    search: async () => ({ ok: true, results: [{ name: "memory_get", selectionRef: "sel_ref_1" }] }),
    execute: async (request) => {
      assertEquals(request.selectionRef, "sel_ref_1");
      assertEquals(request.arguments.key, "x");
      return { ok: true, selectedTool: "memory_get", result: { value: 7 } };
    },
    settle: async () => { throw new Error("no pause → settle must not be called"); },
    context: async () => ({ signal: null, runId: "r1" }),
  });
  const r = await dispatcher("memory_get", { key: "x" }, 1);
  assert(r.ok);
  assertEquals(r.value.value, 7);
});

Deno.test("createWorkflowPipelineDispatcher: an owner-approval pause FAILS CLOSED naming tool + requirement", async () => {
  let settled = 0;
  const dispatcher = createWorkflowPipelineDispatcher({
    search: async () => ({ ok: true, results: [{ name: "capture_visible_tab", selectionRef: "sel_ref_9" }] }),
    execute: async () => ({
      ok: true,
      selectedTool: "capture_visible_tab",
      result: { waitingForPermission: true, permissionRequirement: { reason: "capture this tab" } },
    }),
    settle: async () => { settled += 1; },
    context: async () => ({ signal: null, runId: "r1" }),
  });
  const r = await dispatcher("capture_visible_tab", {}, 2);
  assert(!r.ok, "a permission pause must never look like success");
  assertStringIncludes(String(r.error), "step 2");
  assertStringIncludes(String(r.error), "capture_visible_tab");
  assertStringIncludes(String(r.error), "capture this tab");
  assertEquals(settled, 1, "the paused call must be settled so it cannot dangle or be resumed later");
});

Deno.test("save_workflow: refused in read-only (SCOPED hook) contexts", async () => {
  const mem = makeMemory();
  const t = workflowsToolset({ memory: mem, readOnly: true });
  const r = await t.save_workflow.execute({ name: "x", kind: "script-js", content: "y" });
  assert(!r.ok, "readOnly contexts cannot persist workflows");
  assertStringIncludes(String(r.error), "not available");
  assertEquals(mem._map.size, 0, "nothing was written");
});

Deno.test("save_workflow: enrollment-generation fence rejects a stale run", async () => {
  const mem = makeMemory();
  let gen = 1;
  const t = workflowsToolset({
    memory: mem,
    enrollmentGuard: async () => ({ ok: true, gen }),
    getRunGen: () => 1, // the run STARTED at gen 1
  });
  gen = 2; // origin re-enrolled mid-run (the ABA case)
  const r = await t.save_workflow.execute({ name: "x", kind: "script-js", content: "y" });
  assert(!r.ok);
  assertStringIncludes(String(r.error), "re-enrolled");
  assertEquals(mem._map.size, 0, "the stale run's write must not land");
  // And a matching generation writes fine.
  const mem2 = makeMemory();
  const t2 = workflowsToolset({ memory: mem2, enrollmentGuard: async () => ({ ok: true, gen: 5 }), getRunGen: () => 5 });
  const ok2 = await t2.save_workflow.execute({ name: "x", kind: "script-js", content: "y" });
  assert(ok2.ok);
});

Deno.test("system-prompt recall: the run-time memory digest lists saved workflow keys", async () => {
  // The workflows live in the agent's OWN origin-keyed store, so the same
  // recall seam the memory notes use (the run-time context digest rendered
  // into every fresh run's system prompt) must list them — the agent knows its
  // workflows exist without a prior thread.
  const mem = makeMemory();
  await workflowsToolset({ memory: mem }).save_workflow.execute({ name: "summ", kind: "script-js", description: "Summarise pages", content: SAMPLE_JS });
  const { text } = await gatherRuntimeContext({ scope: "hub", agentLabel: "hub", memory: mem, now: new Date(0) });
  assertStringIncludes(text, "workflows:summ", "the digest must surface the saved workflow's key");
  // A fresh store (no workflows saved yet) simply has nothing to list.
  const empty = await gatherRuntimeContext({ scope: "hub", agentLabel: "hub", memory: makeMemory(), now: new Date(0) });
  assert(!empty.text.includes("workflows:"), "no workflows saved → no workflows keys in the prompt");
});
