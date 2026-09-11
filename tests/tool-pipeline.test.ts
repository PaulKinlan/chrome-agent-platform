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
  PipelineBindingError,
  MAX_PIPELINE_STEPS,
  MAX_BINDING_DEPTH,
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

Deno.test("validatePipeline: depth 64 accepted; depth 65 rejected by structural guard without crash", () => {
  let depth64: any = "val";
  for (let i = 0; i < 64; i++) depth64 = { next: depth64 };
  const valid = validatePipeline({
    steps: [{ id: "s1", tool: "test", args: depth64 }],
  });
  assertEquals(valid.ok, true, "Depth 64 must be accepted by the structural recursion guard");

  let depth65: any = "val";
  for (let i = 0; i < 65; i++) depth65 = { next: depth65 };
  const invalid = validatePipeline({
    steps: [{ id: "s1", tool: "test", args: depth65 }],
  });
  assertEquals(invalid.ok, false);
  assert((invalid as any).error.includes("nest too deeply"), "Depth 65 must fail closed gracefully via guard");
});

Deno.test("resolveStepArgs: depth 64 resolves; depth 65 throws PipelineBindingError", () => {
  let depth64: any = "val";
  for (let i = 0; i < 64; i++) depth64 = { next: depth64 };
  const resolved = resolveStepArgs(depth64, {});
  assertEquals(resolved, depth64);

  let depth65: any = "val";
  for (let i = 0; i < 65; i++) depth65 = { next: depth65 };
  let threw = false;
  try {
    resolveStepArgs(depth65, {});
  } catch (err: any) {
    threw = true;
    assert(err instanceof PipelineBindingError);
    assert(err.message.includes("nest too deeply"));
  }
  assert(threw, "resolveStepArgs must throw PipelineBindingError at depth 65");
});

Deno.test("validatePipeline: descriptive step IDs (>40 chars) are accepted", () => {
  const longId = "generate_weekly_sales_report_configuration_for_team_alpha";
  assert(longId.length > 40);
  const res = validatePipeline({
    steps: [{ id: longId, tool: "test", args: {} }],
  });
  assertEquals(res.ok, true, "Descriptive step IDs >40 chars must be accepted");
});

Deno.test("validatePipeline: large shape-valid args (>32 KiB) plan and run whole (dptw)", async () => {
  const largePayload = "x".repeat(64 * 1024);
  const pipeline = {
    steps: [
      { id: "s1", tool: "write", args: { content: largePayload } },
    ],
  };
  const valid = validatePipeline(pipeline);
  assertEquals(valid.ok, true, "Args >32 KiB must NOT be rejected by artificial size caps");

  const dispatch = fakeDispatch({
    write: (a) => ({ written: a.content.length }),
  });
  const res: any = await runPipeline(pipeline, { dispatchTool: dispatch });
  assertEquals(res.ok, true);
  assertEquals(res.final, { written: 64 * 1024 });
});

Deno.test("validatePipeline: step count limit aligns with platform budget (200 accepted, 201 refused)", () => {
  const atLimit = { steps: Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, tool: "t" })) };
  assertEquals(validatePipeline(atLimit).ok, true, "200 steps must be accepted");

  const overLimit = { steps: Array.from({ length: 201 }, (_, i) => ({ id: `s${i}`, tool: "t" })) };
  const res: any = validatePipeline(overLimit);
  assertEquals(res.ok, false, "201 steps must be refused");
  assert(res.error.includes("too many steps (max 200)"));
});
