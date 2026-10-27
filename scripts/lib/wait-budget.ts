// scripts/lib/wait-budget.ts — chrome-agent-platform-9z8xs.
//
// PASS or REFUSE, never a red that reads as a page defect. A fixed wall-clock
// budget in a browser test redded under fleet load while the page was loading
// fine (pvdxe: the page's own bundles still in flight at the deadline, complete
// seconds later; matched interleaved A/B showed no tree difference). The
// contract this module implements for a wall-clock wait in a test:
//
//   1. The budget is the base on a measurably quiet box and MAX_LOAD_SCALE x
//      the base otherwise (the same ceiling the serial phase uses), so a
//      contended box PASSES instead of expiring at the base.
//   2. A deadline that STILL expires is classified by measuring the machine AT
//      THE CATCH (the 9t1p rule: classification by measurement, never
//      assumption) with the canonical quiet-window thresholds. Not quiet, or
//      unmeasurable, is an environmental REFUSAL - a plain Error carrying
//      CAP_ENVIRONMENTAL_REFUSAL, never an AssertionError, so the aggregator
//      (areAllFailuresEnvironmental) classifies the run exit 75, not a product
//      red. Only a measurably quiet box falls through to the caller's assert:
//      a genuine hang on a box keeping up with its work is still a product red.
//
// The pure parts are pinned by tests/wait-budget.test.ts with hand-built
// samples; no manufactured load is needed to prove the discrimination.

import { MAX_LOAD_SCALE } from "./serial-phase.mjs";
import {
  environmentLine,
  quietReasons,
  resolveSpec,
  type LoadSample,
  type ResolvedSpec,
} from "./quiet-window.ts";
import { ENVIRONMENTAL_REFUSAL_MARKER } from "./environmental-verdict.mjs";

/** The canonical quiet thresholds (CAP_QUIET_* env overridable), resolved once per caller. */
export function waitBudgetSpec(spec: Partial<ResolvedSpec> = {}): ResolvedSpec {
  return resolveSpec(spec);
}

/**
 * The wall-clock budget for one wait: `baseMs` when the box is measurably
 * quiet (`loadPerCpu <= spec.maxLoadPerCore`), MAX_LOAD_SCALE x base otherwise.
 * An unmeasurable/unknown load (non-finite, <= 0) reads as NOT quiet: the wait
 * gets the larger budget and the catch decides.
 */
export function phaseBudgetMs(
  baseMs: number,
  loadPerCpu: number,
  spec: ResolvedSpec = resolveSpec(),
): number {
  const quiet = Number.isFinite(loadPerCpu) && loadPerCpu > 0 && loadPerCpu <= spec.maxLoadPerCore;
  return quiet ? baseMs : baseMs * MAX_LOAD_SCALE;
}

export interface DeadlineClassification {
  /** True => the caller must REFUSE (environmental), false => the caller's product-red assert stands. */
  environmental: boolean;
  cause: "loaded" | "unmeasurable" | "quiet";
  /** The compact evidence line (`load1=… compilers=…`), or the measurement error. */
  environment: string;
  /** Why the deadline expiry is environmental; empty when quiet. */
  reasons: string[];
}

/**
 * Classify an expired deadline from a load sample taken AT the catch.
 * Unmeasurable fails CLOSED to environmental (never a load claim, never a
 * product red). Not quiet per the canonical quiet-window rule is environmental.
 * Only a measurably quiet box is "quiet" - the caller's assert then reds.
 */
export function classifyDeadlineExpiry(
  sample: LoadSample | null,
  spec: ResolvedSpec = resolveSpec(),
): DeadlineClassification {
  const environment = environmentLine(sample, spec);
  if (!sample || sample.measurable === false) {
    return {
      environmental: true,
      cause: "unmeasurable",
      environment,
      reasons: [`the box could not be measured (${sample?.error ?? "no sample"})`],
    };
  }
  const reasons = quietReasons(sample, spec);
  if (reasons.length > 0) {
    return { environmental: true, cause: "loaded", environment, reasons };
  }
  return { environmental: false, cause: "quiet", environment, reasons: [] };
}

/**
 * Build the environmental-refusal Error for an expired deadline. The message
 * carries CAP_ENVIRONMENTAL_REFUSAL plus the measured numbers (the 9t1p payload
 * rule) and is a plain Error - never an AssertionError, which the aggregator
 * would read as a test failure.
 */
export function deadlineRefusalError(
  phase: string,
  surface: string,
  budgetMs: number | undefined,
  baseMs: number | undefined,
  verdict: DeadlineClassification,
): Error {
  const budget = typeof budgetMs === "number" && Number.isFinite(budgetMs)
    ? ` deadline (${budgetMs}ms, base ${baseMs}ms)`
    : " timing deadline";
  return new Error(
    `${ENVIRONMENTAL_REFUSAL_MARKER} ${JSON.stringify({
      reason: `${surface} ${phase}${budget} expired and ${
        verdict.cause === "unmeasurable"
          ? "the box could not be measured - failing closed to environmental, NOT a load claim"
          : `the box was not quiet at the deadline (${verdict.reasons.join("; ")}) - resource-load timing under fleet contention, not a page defect`
      }`,
      cause: verdict.cause,
      environment: verdict.environment,
    })}`,
  );
}
