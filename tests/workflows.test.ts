// workflows.test.ts — the agent's reusable-workflow store
// (CAP-FB-20260831-WORKFLOWS-TO-MEMORY-01): save_workflow / workflow_list /
// workflow_get / workflow_run against a shimmed in-memory store (no OPFS) +
// the prompt layer (buildWorkflowsPrompt) + bounds + origin-keyed isolation.
// @ts-nocheck — the in-memory store shim is intentionally dynamic.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { validateWorkflow, buildWorkflowsPrompt, workflowKey, WORKFLOW_KINDS } from "../extension/lib/workflows.js";
import { workflowsToolset } from "../extension/lib/agent.js";

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
    _map: map,
  };
}

function tools(mem, runRoute = null) {
  return workflowsToolset({ memory: mem, runRoute });
}

const SAMPLE_JS = "return { ok: true, from: 'workflow' };";
const SAMPLE_PY = "print('hello')";
const SAMPLE_PIPE = 'steps: [{"tool":"memory_get","args":{"key":"x"}}]';
const SAMPLE_INST = "1. Open the hub. 2. Run a task.";

Deno.test("save_workflow: writes a script-js workflow and returns ok", async () => {
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
    const r = await tools(mem).save_workflow.execute({ name: `wf-${kind}`, kind, content: kind === "script-js" ? SAMPLE_JS : kind === "script-python" ? SAMPLE_PY : kind === "pipeline" ? SAMPLE_PIPE : SAMPLE_INST });
    assert(r.ok, `${kind} should save, got ${JSON.stringify(r)}`);
  }
});

Deno.test("save_workflow: rejects invalid kinds", async () => {
  const mem = makeMemory();
  const r = await tools(mem).save_workflow.execute({ name: "bad", kind: "binary", content: "x" });
  assert(!r.ok, "invalid kind must be refused");
  assertStringIncludes(String(r.error), "kind");
});

Deno.test("save_workflow: enforces name/description/content bounds", async () => {
  const mem = makeMemory();
  // name too long
  const longName = await tools(mem).save_workflow.execute({ name: "n".repeat(65), kind: "script-js", content: SAMPLE_JS });
  assert(!longName.ok, "over-long name must be refused");
  // content too big (>64 KiB)
  const big = await tools(mem).save_workflow.execute({ name: "big", kind: "script-js", content: "x".repeat(64 * 1024 + 1) });
  assert(!big.ok, "over-big content must be refused");
  // exactly 64 KiB passes
  const ok = await tools(mem).save_workflow.execute({ name: "ok", kind: "script-js", content: "x".repeat(64 * 1024) });
  assert(ok.ok, "64 KiB content should save");
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

Deno.test("workflow_run: dispatches kind+source to the route and returns its result", async () => {
  const mem = makeMemory();
  const t = tools(mem);
  await t.save_workflow.execute({ name: "runme", kind: "script-js", content: SAMPLE_JS });
  let dispatched = null;
  const t2 = workflowsToolset({ memory: mem, runRoute: async (args) => { dispatched = args; return { ok: true, result: { from: "route" } }; } });
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
  const r = await tools(makeMemory(), async () => ({ ok: true })).workflow_run.execute({ name: "nope" });
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

Deno.test("validateWorkflow: normalizes and bounds", () => {
  const ok = validateWorkflow({ name: " x ", description: " d ", kind: "script-js", content: "y" });
  assert(ok.ok);
  assertEquals(ok.record.name, "x");
  assertEquals(ok.record.description, "d");
  const bad = validateWorkflow({ name: "", kind: "script-js", content: "y" });
  assert(!bad.ok);
});

Deno.test("buildWorkflowsPrompt: lists name+kind+description, empty → empty string", () => {
  assertEquals(buildWorkflowsPrompt([]), "");
  assertEquals(buildWorkflowsPrompt(null), "");
  const p = buildWorkflowsPrompt([{ name: "summ", kind: "script-js", description: "Summarise" }]);
  assertStringIncludes(p, "## Saved workflows");
  assertStringIncludes(p, "summ (script-js: Summarise)");
  assert(!p.includes("function body"), "prompt never carries the body");
});
