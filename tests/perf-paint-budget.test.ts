// chrome-agent-platform-9epn.12: the paint budget must be decided from MEASURED paint entries.
//
// The contract in scripts/perf-leak-trace.ts claimed a render budget ("< 1s to first meaningful
// paint") while asserting only `navigate -> load + 300ms settle` wall clock. That wall clock is
// still checked (it is a real budget), but on its own it cannot see a slow first paint behind a
// fast load, and it passes for a page that never painted.
//
// The RED-BEFORE arm below is the falsifier: it feeds this decider exactly what the pre-change
// harness produced (a load duration and no paint fields), and the decider refuses to call that a
// pass. If someone reverts the collector to the old shape, that arm is what fails.
import { assertEquals } from "jsr:@std/assert@1";
import {
  classifyPaintMetrics,
  DEFAULT_PAINT_BUDGETS,
  type PaintMetrics,
} from "../scripts/lib/perf-paint-budget.ts";

Deno.test("9epn.12 paint budget: measured and in budget is a PASS", () => {
  const d = classifyPaintMetrics({ fcpMs: 180, lcpMs: 420 });
  assertEquals(d.verdict, "PASS");
  // The numbers the verdict came from are printed, not just the word PASS.
  assertEquals(/fcp 180ms/.test(d.reasons.join(" ")), true);
  assertEquals(/lcp 420ms/.test(d.reasons.join(" ")), true);
});

Deno.test("9epn.12 paint budget: measured and over budget is a FAIL, naming which metric", () => {
  const slowFcp = classifyPaintMetrics({ fcpMs: 1300, lcpMs: 1400 });
  assertEquals(slowFcp.verdict, "FAIL");
  assertEquals(/fcp 1300ms > 1000ms/.test(slowFcp.reasons.join(" ")), true);

  const slowLcp = classifyPaintMetrics({ fcpMs: 120, lcpMs: 1500 });
  assertEquals(slowLcp.verdict, "FAIL");
  assertEquals(/lcp 1500ms > 1000ms/.test(slowLcp.reasons.join(" ")), true);
});

Deno.test("9epn.12 paint budget: an unmeasured paint is UNMEASURED, never a pass", () => {
  for (const metrics of [
    { fcpMs: null, lcpMs: null },
    { fcpMs: null, lcpMs: 300 },
    { fcpMs: 200, lcpMs: null },
    { fcpMs: Number.NaN, lcpMs: 300 },
    { fcpMs: -1, lcpMs: 300 },
    {},
    null,
    undefined,
  ] as Array<PaintMetrics | null | undefined>) {
    const d = classifyPaintMetrics(metrics);
    assertEquals(d.verdict, "UNMEASURED", `expected UNMEASURED for ${JSON.stringify(metrics)}`);
    // The reason must name what was missing, so an operator can act on it.
    assertEquals(/no usable paint entry/.test(d.reasons.join(" ")), true);
  }
});

Deno.test("9epn.12 RED-BEFORE: the pre-change collector output cannot satisfy a paint budget", () => {
  // This is the shape the harness produced BEFORE the fix: it returned only a load duration
  // (`pageLoad` -> { ms }) and never read performance paint entries. Reverting the collector to
  // that shape must red this test rather than silently pass the render budget.
  const preFixCollectorOutput = { ms: 320 } as unknown as PaintMetrics;
  const d = classifyPaintMetrics(preFixCollectorOutput);
  assertEquals(d.verdict, "UNMEASURED");
  assertEquals(/no usable paint entry/.test(d.reasons.join(" ")), true);

  // And the budget-rejection falsifier the harness already uses (--test-budget-rejection sets
  // every budget to 0) must red a fully measured, otherwise-passing surface.
  const zeroBudgets = { fcpMs: 0, lcpMs: 0 };
  assertEquals(classifyPaintMetrics({ fcpMs: 180, lcpMs: 420 }, zeroBudgets).verdict, "FAIL");
  assertEquals(classifyPaintMetrics({ fcpMs: 0, lcpMs: 0 }, zeroBudgets).verdict, "PASS");
});

Deno.test("9epn.12 paint budget: tonight's MEASURED hub passes the EXISTING render budget", () => {
  // These are the numbers the browser arms actually measured on the hub (2026-10-15T04:57Z): FCP
  // 594.8ms, LCP 802.8ms. They breached a 500ms FCP bound that an earlier revision of this file
  // invented by carrying the SW REGISTER budget into the paint bound - which is what turned a
  // measured page into a false failure. Against the repo's existing "< 1s to first meaningful paint"
  // they pass, and that is the point: measuring a claim must not smuggle in a new contract.
  const measured = classifyPaintMetrics({ fcpMs: 594.7649999856949, lcpMs: 802.7750000357628 });
  assertEquals(measured.verdict, "PASS");
  // Assert the measured VALUE, not my own rounding of it.
  assertEquals(/fcp 594\.8/.test(measured.reasons.join(" ")), true);
});

Deno.test("9epn.12 paint budget: the declared budgets are the ones named in the report", () => {
  // The repo's existing render budget is "< 1s to first meaningful paint"; 500ms is the SW register
  // budget and must not be carried into the paint bound (chrome-agent-platform-9epn.12).
  assertEquals(DEFAULT_PAINT_BUDGETS.fcpMs, 1000);
  assertEquals(DEFAULT_PAINT_BUDGETS.lcpMs, 1000);
  assertEquals(Object.isFrozen(DEFAULT_PAINT_BUDGETS), true);
});
