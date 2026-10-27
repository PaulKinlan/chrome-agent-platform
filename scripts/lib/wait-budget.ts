// scripts/lib/wait-budget.ts — chrome-agent-platform-9z8xs.
//
// PASS or REFUSE, never a red that reads as a page defect - and NEVER AN EXTENDED
// BUDGET. The first design scaled the budget x MAX_LOAD_SCALE under load; the 9z8xs
// review (P1, coord 2026-10-27) killed it: a genuine 7s -> 21s product slowdown would
// PASS inside a 32s scaled budget, and a real hang would REFUSE - masking in both
// directions. Load alone cannot attribute a slowdown to the host, so the contract is
// refusal-only:
//
//   1. The budget is ALWAYS the base. There is no scaling helper in this module, by
//      design: a wall-clock budget does not grow with load.
//   2. BEFORE the wait the box is measured with the canonical quiet-window
//      thresholds; above the threshold the suite REFUSES immediately
//      (CAP_ENVIRONMENTAL_REFUSAL, exit 75) - never pass, never extend, so a
//      high-load run can never report green and a slow product cannot hide.
//   3. A deadline that expires anyway (load arrived mid-wait) is classified by
//      measuring the machine AT THE CATCH (the 9t1 rule: classification by
//      measurement, never assumption). Not quiet, or unmeasurable, is an
//      environmental REFUSAL - a plain Error carrying CAP_ENVIRONMENTAL_REFUSAL,
//      never an AssertionError, so the aggregator (areAllFailuresEnvironmental)
//      classifies the run exit 75, not a product red. Only a measurably quiet box
//      falls through to the caller's assert: a genuine hang on a box keeping up
//      with its work is still a product red.
//
// The pure parts are pinned by tests/wait-budget.test.ts with hand-built
// samples; no manufactured load is needed to prove the discrimination.

import {
  environmentLine,
  quietReasons,
  resolveSpec,
  type LoadSample,
  type ResolvedSpec,
} from "./quiet-window.ts";
import { AssertionError } from "jsr:@std/assert@1";
import { ENVIRONMENTAL_REFUSAL_MARKER } from "./environmental-verdict.mjs";
import { PageThrowError } from "./cdp-eval.ts";

/**
 * The catch-side discriminator of the refusal contract, extracted so it is pinnable
 * (9z8xs re-review P2-c, second round): TRUE only for the ONE untyped harness timeout
 * spelling that escapes classification - withTimeout's bare Error("deadline")
 * (chrome-launch.ts:1764). Every TYPED harness timeout self-classifies at its source:
 * ServiceWorkerTargetTimeoutError and the Cdp*TimeoutError classes carry either the
 * refusal marker or a "PRODUCT RED" prefix, and both must propagate untouched - a
 * catch that re-measures them would override the machinery's own verdict. A
 * page-origin PageThrowError whose text reads "deadline exceeded" is a product
 * failure; generic timeout TEXT never matches. Nothing else may be laundered.
 */
export function isHarnessTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Class BEFORE text: an in-page `throw new Error("deadline")` arrives as a PageThrowError
  // with exactly the harness spelling (pinned by the P2-c test) - page origin, never a harness
  // timeout. An AssertionError is a test verdict - never reclassifiable, whatever its text.
  if (error instanceof PageThrowError) return false;
  if (error instanceof AssertionError) return false;
  if (error.message.includes(ENVIRONMENTAL_REFUSAL_MARKER)) return false;
  if (error.message.startsWith("PRODUCT RED")) return false;
  return error.message === "deadline";
}

/** The canonical quiet thresholds (CAP_QUIET_* env overridable), resolved once per caller. */
export function waitBudgetSpec(spec: Partial<ResolvedSpec> = {}): ResolvedSpec {
  return resolveSpec(spec);
}

/**
 * The pre-wait gate of the refusal-only contract: measure NOW, and when the box is
 * not measurably quiet return the classification the caller must refuse with. Returns
 * null when the box is measurably quiet - the caller then runs the wait with the
 * NORMAL (unscaled) budget. This function never returns a bigger budget: there is
 * nothing to scale (9z8xs review P1).
 */
export function refuseUnlessMeasurablyQuiet(
  sample: LoadSample | null,
  spec: ResolvedSpec = resolveSpec(),
): DeadlineClassification | null {
  const verdict = classifyDeadlineExpiry(sample, spec);
  return verdict.environmental ? verdict : null;
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
