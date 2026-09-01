// tests/tool-pipeline.test.ts — CAP-FB-20260831-TOOL-PIPELINES-01.
//
// The declarative pipeline reducer: a step's output feeds the next by an
// explicit binding, resolved with a pure path lookup (no eval). A failing step
// halts the pipeline with a structured error.
//
// Falsification: break the binding — point step 2 at a path that does not exist
// in step 1's result — and "a 3-step pipeline pipes each result forward" must go
// RED (the step halts instead of piping). Removing the earlier-step check in
// validatePipeline makes "a forward reference is rejected" go RED.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  validatePipeline,
  resolveStepArgs,
  runPipeline,
  getPath,
  MAX_PIPELINE_STEPS,
} from "../extension/lib/tool-pipeline.js";

// A fake dispatcher: each tool just transforms its args deterministically, so
// the test exercises the PIPE (binding → next step), not any real tool.
function fakeDispatch(impls: Record<string, (args: any) => any>) {
  return (name: string, args: any) => {
    const fn = impls[name];
    if (!fn) return Promise.resolve({ ok: false, error: `unknown tool ${name}` });
    try { return Promise.resolve({ ok: true, value: fn(args) }); }
    catch (e) { return Promise.resolve({ ok: false, error: String((e as Error)?.message ?? e) }); }
  };
}

Deno.test("getPath: property and array-index access, undefined for a missing path", () => {
  const root = { a: { b: [{ c: 7 }] } };
  assertEquals(getPath(root, "a.b.0.c"), 7);
  assertEquals(getPath(root, "a.b.1.c"), undefined);
  assertEquals(getPath(root, "a.x"), undefined);
  assertEquals(getPath(root, ""), root);
});

Deno.test("resolveStepArgs: replaces a binding with the referenced value (or sub-path)", () => {
  const results = { s1: { files: ["a.ts", "b.ts"], count: 2 } };
  const args = { list: { $ref: "s1", path: "files" }, n: { $ref: "s1", path: "count" }, lit: "x" };
  assertEquals(resolveStepArgs(args, results), { list: ["a.ts", "b.ts"], n: 2, lit: "x" });
});

Deno.test("a 3-step pipeline pipes each result forward", async () => {
  const pipeline = {
    name: "list → filter → count",
    steps: [
      { id: "s1", tool: "list", args: {} },
      { id: "s2", tool: "filter", args: { items: { $ref: "s1", path: "items" }, needle: "TODO" } },
      { id: "s3", tool: "count", args: { items: { $ref: "s2", path: "kept" } } },
    ],
  };
  const dispatch = fakeDispatch({
    list: () => ({ items: ["TODO a", "done b", "TODO c"] }),
    filter: (a) => ({ kept: a.items.filter((s: string) => s.includes(a.needle)) }),
    count: (a) => ({ n: a.items.length }),
  });
  const seen: string[] = [];
  const r: any = await runPipeline(pipeline, { dispatchTool: dispatch, onStep: (e: any) => seen.push(`${e.id}:${e.status}`) });
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  assertEquals(r.final, { n: 2 }); // two TODO lines survived the filter and were counted
  assertEquals(r.steps.map((s: any) => s.id), ["s1", "s2", "s3"]);
  // Each step announced running then ok, in order — the plan strip's data.
  assertEquals(seen, ["s1:running", "s1:ok", "s2:running", "s2:ok", "s3:running", "s3:ok"]);
});

Deno.test("a failing step HALTS the pipeline with a structured error", async () => {
  const pipeline = {
    steps: [
      { id: "s1", tool: "list", args: {} },
      { id: "s2", tool: "boom", args: { x: { $ref: "s1" } } },
      { id: "s3", tool: "never", args: {} },
    ],
  };
  const dispatch = fakeDispatch({
    list: () => ({ items: [1] }),
    boom: () => { throw new Error("kaboom"); },
    never: () => ({ reached: true }),
  });
  const ran: string[] = [];
  const r: any = await runPipeline(pipeline, {
    dispatchTool: (n: string, a: any) => { ran.push(n); return dispatch(n, a); },
    onStep: () => {},
  });
  assertEquals(r.ok, false);
  assertEquals(r.failedStep, "s2");
  assertEquals(r.stepIndex, 1);
  assert(/kaboom/.test(r.error), r.error);
  assertEquals(ran, ["list", "boom"]); // s3 never dispatched — the pipe stopped
});

Deno.test("a broken binding halts fail-closed (the falsification gate)", async () => {
  const pipeline = {
    steps: [
      { id: "s1", tool: "list", args: {} },
      { id: "s2", tool: "use", args: { v: { $ref: "s1", path: "does.not.exist" } } },
    ],
  };
  const dispatch = fakeDispatch({ list: () => ({ items: [1] }), use: (a) => a });
  const r: any = await runPipeline(pipeline, { dispatchTool: dispatch });
  assertEquals(r.ok, false);
  assertEquals(r.failedStep, "s2");
  assert(/binding/.test(r.error), r.error);
});

Deno.test("validatePipeline: a forward/self reference is rejected", () => {
  const forward = validatePipeline({ steps: [
    { id: "s1", tool: "a", args: { v: { $ref: "s2" } } },
    { id: "s2", tool: "b", args: {} },
  ]});
  assertEquals(forward.ok, false);
  assert(/not an earlier step/.test((forward as any).error));

  const self = validatePipeline({ steps: [{ id: "s1", tool: "a", args: { v: { $ref: "s1" } } }] });
  assertEquals(self.ok, false);
});

Deno.test("validatePipeline: duplicate ids, empty, over-limit, unknown tool", () => {
  assertEquals(validatePipeline({ steps: [] }).ok, false);
  assertEquals(validatePipeline({ steps: [{ id: "a", tool: "t" }, { id: "a", tool: "t" }] }).ok, false);
  const tooMany = { steps: Array.from({ length: MAX_PIPELINE_STEPS + 1 }, (_, i) => ({ id: `s${i}`, tool: "t" })) };
  assertEquals(validatePipeline(tooMany).ok, false);
  const unknown = validatePipeline({ steps: [{ id: "s1", tool: "nope", args: {} }] }, { knownTools: ["yes"] });
  assertEquals(unknown.ok, false);
  assert(/unknown tool/.test((unknown as any).error));
});
