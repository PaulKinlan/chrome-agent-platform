// @ts-nocheck — the module under test is untyped .js; the runtime behavior is
// what these assertions pin.
// tests/plan-strip.test.ts — the pure plan-strip reducer
// (CAP-FB-20260830-PLAN-STRIP-CHECKPOINTS-01). A running multi-step task turns
// its own step events (the tool calls streaming through the progress port) into
// a compact checklist: the current step active, completed ones checked, and a
// collapsed "N steps" summary once the run settles.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  emptyPlan,
  isPlanStepStatus,
  planFromEvents,
  planSummary,
  reducePlan,
} from "../extension/shared/plan-strip.js";

Deno.test("plan-strip: a tool call starts an active step; its result checks it", () => {
  let plan = emptyPlan();
  assertEquals(plan, { steps: [], state: "idle" });
  plan = reducePlan(plan, { type: "step-start", label: "Reading the page" });
  assertEquals(plan, { steps: [{ label: "Reading the page", status: "active" }], state: "running" });
  plan = reducePlan(plan, { type: "step-end", status: "done" });
  assertEquals(plan, { steps: [{ label: "Reading the page", status: "done" }], state: "running" });
});

Deno.test("plan-strip: results resolve the OLDEST active step (FIFO), and a corrected label wins", () => {
  // The lazy protocol calls `execute_tool` and only names the real tool at
  // result time; the strip adopts the corrected label then.
  const plan = planFromEvents([
    { type: "step-start", label: "Running a tool" },
    { type: "step-start", label: "Running a tool" },
    { type: "step-end", status: "done", label: "Writing memory" },
    { type: "step-end", status: "done", label: "Reading memory" },
  ]);
  assertEquals(plan.steps, [
    { label: "Writing memory", status: "done" },
    { label: "Reading memory", status: "done" },
  ]);
});

Deno.test("plan-strip: a three-step run settles into a collapsed summary; active step drives aria-live", () => {
  // Three tool steps advance one at a time — the demo @demo-tools shape
  // (memory_set, memory_get, memory_get).
  let plan = planFromEvents([
    { type: "step-start", label: "Writing memory" },
    { type: "step-end", status: "done", label: "Writing memory" },
    { type: "step-start", label: "Reading memory" },
    { type: "step-end", status: "done", label: "Reading memory" },
    { type: "step-start", label: "Reading memory" },
  ]);
  // Mid-run: two done, one in flight — the summary announces the current one.
  let sum = planSummary(plan);
  assertEquals(sum.total, 3);
  assertEquals(sum.resolved, 2);
  assertEquals(sum.current, 3);
  assertEquals(sum.activeLabel, "Reading memory");
  assertEquals(sum.errored, false);
  assertEquals(plan.state, "running");

  // The run's `done` event settles the strip; the trailing active step checks.
  plan = reducePlan(plan, { type: "settle" });
  assertEquals(plan.state, "settled");
  assert(plan.steps.every((s) => s.status === "done"), "every step is checked once settled");
  sum = planSummary(plan);
  assertEquals(sum.total, 3);
  assertEquals(sum.resolved, 3);
  assertEquals(sum.activeLabel, null);
});

Deno.test("plan-strip: an error result marks its step, and a run-level failure settles the rest as errors", () => {
  const stepErr = planFromEvents([
    { type: "step-start", label: "Taking a screenshot" },
    { type: "step-end", status: "error" },
  ]);
  assertEquals(stepErr.steps, [{ label: "Taking a screenshot", status: "error" }]);
  assertEquals(planSummary(stepErr).errored, true);

  const runFail = planFromEvents([
    { type: "step-start", label: "Opening a page" },
    { type: "fail" },
  ]);
  assertEquals(runFail.steps, [{ label: "Opening a page", status: "error" }]);
  assertEquals(runFail.state, "settled");
});

Deno.test("plan-strip: reducePlan never mutates its input and ignores unknown events", () => {
  const before = { steps: [{ label: "A", status: "active" as const }], state: "running" as const };
  const snapshot = JSON.stringify(before);
  const after = reducePlan(before, { type: "step-end", status: "done" });
  assertEquals(JSON.stringify(before), snapshot, "the input plan is untouched");
  assertEquals(after.steps[0].status, "done");
  assertEquals(reducePlan(before, { type: "noop" }), before, "an unknown event returns the plan unchanged");
});

Deno.test("plan-strip: status guard accepts only the three known statuses", () => {
  assert(isPlanStepStatus("active"));
  assert(isPlanStepStatus("done"));
  assert(isPlanStepStatus("error"));
  assert(!isPlanStepStatus("pending"));
  assert(!isPlanStepStatus(""));
});
