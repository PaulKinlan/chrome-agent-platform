// perf-paint-budget.ts — decide a surface's paint budget from MEASURED paint metrics.
//
// WHY THIS EXISTS (chrome-agent-platform-9epn.12): scripts/perf-leak-trace.ts advertised a
// "render budget (< 1s to first meaningful paint)" but asserted it from
// `navigate -> load + 300ms settle` wall clock, and never read a paint entry at all. A
// load-only number is satisfied by a page that has not painted, so the claim and the check were
// different things. These decisions are made from real paint entries instead.
//
// THREE VERDICTS, and only three (the repo's rule, scripts/lib/quiet-window.ts):
//   PASS       — FCP and LCP were both measured and both are within budget.
//   FAIL       — measured, and over budget. A product red.
//   UNMEASURED — no usable paint entry for at least one metric. NEVER a pass: an unmeasurable
//                paint is not evidence of a fast one, and the harness counts it separately from
//                a pass so a bare "RESULT: n passed" can never hide it.

export interface PaintMetrics {
  /** First Contentful Paint, ms from navigation start; null when no paint entry was observed. */
  fcpMs: number | null;
  /** Largest Contentful Paint, ms from navigation start; null when no LCP entry was observed. */
  lcpMs: number | null;
}

export interface PaintBudgets {
  fcpMs: number;
  lcpMs: number;
}

// Provenance, checked against origin/main rather than assumed: the render budget this file
// enforces is the one the harness already claimed — "< 1s to first meaningful paint"
// (scripts/perf-leak-trace.ts header, the Constitution §4 render budget) — applied to the
// measured paint metrics instead of to a load-settle settle time. It is deliberately NOT 500ms:
// the 500ms in that file is the SW REGISTER budget, and an earlier revision of this constant
// carried it into the FCP bound, which tightened the render contract by stealth and made a
// 594ms hub read as a failure against a budget nobody had agreed (chrome-agent-platform-9epn.12).
export const DEFAULT_PAINT_BUDGETS: PaintBudgets = Object.freeze({ fcpMs: 1000, lcpMs: 1000 });

export type PaintVerdict = "PASS" | "FAIL" | "UNMEASURED";

export interface PaintDecision {
  verdict: PaintVerdict;
  /** The numbers the decision came from, or the names of the entries that were missing. */
  reasons: string[];
}

/** A measurement is usable only if it is a real, finite, non-negative number of milliseconds. */
function usable(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function classifyPaintMetrics(
  metrics: PaintMetrics | null | undefined,
  budgets: PaintBudgets = DEFAULT_PAINT_BUDGETS,
): PaintDecision {
  const fcp = metrics?.fcpMs ?? null;
  const lcp = metrics?.lcpMs ?? null;

  // Early return so the compiler (and a reader) can see that everything below is measured.
  if (!usable(fcp) || !usable(lcp)) {
    const missing: string[] = [];
    if (!usable(fcp)) missing.push("first-contentful-paint");
    if (!usable(lcp)) missing.push("largest-contentful-paint");
    return {
      verdict: "UNMEASURED",
      reasons: [`no usable paint entry for: ${missing.join(", ")} — unmeasured is never a pass`],
    };
  }

  const over: string[] = [];
  if (fcp > budgets.fcpMs) over.push(`fcp ${Number(fcp.toFixed(1))}ms > ${budgets.fcpMs}ms`);
  if (lcp > budgets.lcpMs) over.push(`lcp ${Number(lcp.toFixed(1))}ms > ${budgets.lcpMs}ms`);
  if (over.length > 0) return { verdict: "FAIL", reasons: [over.join("; ")] };

  return {
    verdict: "PASS",
    reasons: [`fcp ${Number(fcp.toFixed(1))}ms <= ${budgets.fcpMs}ms and lcp ${Number(lcp.toFixed(1))}ms <= ${budgets.lcpMs}ms`],
  };
}
