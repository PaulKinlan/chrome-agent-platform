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

import { STEAL_THRESHOLD_PCT } from "./cpu-steal-sampler.mjs";
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

// ── 63o3v: the budget/steal RULE, as a manifest ──────────────────────────────
//
// THE RULE (stated, then enforced): a wall-clock budget must declare the host
// envelope it is DEFINED at - { maxLoadPerCore, maxStealPct }. A measurement
// taken ABOVE the declared envelope is not evidence: the suite REFUSES
// environmentally, never fails with a red that reads as a product regression.
// Only a measurement inside the envelope may produce a product verdict. The
// steal axis is the one the load-only quiet window cannot see: the 63o3v suite
// failed at 36-48% steal while load/core read 0.14 - quiet by load, meaningless
// by wall clock. 20% is the repo's standing evidence ceiling (ADR rxayt/tu8w9,
// cpu-steal-sampler.mjs STEAL_THRESHOLD_PCT): at or above it a duration is not
// evidence.

export interface DeclaredEnvelope {
  /** The load1/core the budget is defined at (the repo quiet bound, 0.35). */
  maxLoadPerCore: number;
  /** The CPU-steal percentage at/above which a duration is not evidence (20). */
  maxStealPct: number;
}

export interface WallClockBudget {
  /** The budget inside the declared envelope, milliseconds. */
  baseMs: number;
  definedAt: DeclaredEnvelope;
  /** The bead that owns the declaration. */
  bead: string;
}

/**
 * THE REGISTRY IS THE MANIFEST (63o3v ask 3): every wall-clock budget in the
 * tree is declared here with the envelope it is defined at, and
 * tests/wall-clock-budget-registry.test.ts rejects a suite that declares a raw
 * deadline without a row here. Keyed `<suite file>#<phase>`.
 */
export const WALL_CLOCK_BUDGETS: Readonly<Record<string, WallClockBudget>> = Object.freeze({
  "tests/chunk-resolution-browser.test.ts#readyState": Object.freeze({
    baseMs: 8000,
    definedAt: Object.freeze({ maxLoadPerCore: 0.35, maxStealPct: STEAL_THRESHOLD_PCT }),
    bead: "chrome-agent-platform-9z8xs",
  }),
  "tests/chunk-resolution-browser.test.ts#settle": Object.freeze({
    baseMs: 10000,
    definedAt: Object.freeze({ maxLoadPerCore: 0.35, maxStealPct: STEAL_THRESHOLD_PCT }),
    bead: "chrome-agent-platform-9z8xs",
  }),
  "tests/ntp-boot-staging-timing.test.ts#composer-ready": Object.freeze({
    baseMs: 150,
    definedAt: Object.freeze({ maxLoadPerCore: 0.35, maxStealPct: STEAL_THRESHOLD_PCT }),
    bead: "chrome-agent-platform-63o3v",
  }),
  "tests/ntp-boot-staging-timing.test.ts#thread-list-hydrated": Object.freeze({
    baseMs: 250,
    definedAt: Object.freeze({ maxLoadPerCore: 0.35, maxStealPct: STEAL_THRESHOLD_PCT }),
    bead: "chrome-agent-platform-63o3v",
  }),
  "tests/ntp-boot-staging-timing.test.ts#median-long-tasks": Object.freeze({
    baseMs: 0,
    definedAt: Object.freeze({ maxLoadPerCore: 0.35, maxStealPct: STEAL_THRESHOLD_PCT }),
    bead: "chrome-agent-platform-63o3v",
  }),
});

/** Look up a declared budget; throws (fails closed) when the key was never declared. */
export function wallClockBudget(key: string): WallClockBudget {
  const entry = WALL_CLOCK_BUDGETS[key];
  if (!entry) {
    throw new Error(`wallClockBudget: ${key} is not declared in WALL_CLOCK_BUDGETS - declare it with the envelope it is defined at (63o3v)`);
  }
  return entry;
}

/**
 * The steal percentage between two /proc/stat texts (e.g. read at a run's
 * start and end). Null when unmeasurable - parse failure, stalled or
 * backwards counters - never a guess. Pure; the 63o3v pins feed it fixtures.
 */
export function stealPctBetweenStats(statA: string | null, statB: string | null): number | null {
  const parse = (text: string | null) => {
    if (text == null) return null;
    const line = String(text).split("\n", 1)[0] ?? "";
    if (!line.startsWith("cpu ")) return null;
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 8 || fields.some((n) => !Number.isFinite(n))) return null;
    return { steal: fields[7], total: fields.slice(0, 8).reduce((a, b) => a + b, 0) };
  };
  const a = parse(statA);
  const b = parse(statB);
  if (!a || !b) return null;
  const dTotal = b.total - a.total;
  const dSteal = b.steal - a.steal;
  if (!Number.isFinite(dTotal) || !Number.isFinite(dSteal) || dTotal <= 0 || dSteal < 0) return null;
  return Math.min(100 * (dSteal / dTotal), 100);
}

/** Read /proc/stat, or null on any failure (non-Linux, unreadable). */
export async function readProcStat(): Promise<string | null> {
  try {
    return await Deno.readTextFile("/proc/stat");
  } catch {
    return null;
  }
}

/**
 * The current CPU-steal percentage, measured over `sampleMs` of host time.
 * Null when unmeasurable (non-Linux, unreadable /proc/stat, stalled counters):
 * unmeasurable fails CLOSED - a wall-clock budget is exactly what steal
 * invalidates, so an unknown steal never reads as inside the envelope.
 */
export async function measureStealPctNow(sampleMs = 400): Promise<number | null> {
  try {
    const read = async () => {
      const text = await Deno.readTextFile("/proc/stat");
      const line = text.split("\n", 1)[0] ?? "";
      if (!line.startsWith("cpu ")) return null;
      const fields = line.trim().split(/\s+/).slice(1).map(Number);
      if (fields.length < 8 || fields.some((n) => !Number.isFinite(n))) return null;
      return { steal: fields[7], total: fields.slice(0, 8).reduce((a, b) => a + b, 0) };
    };
    const a = await read();
    await new Promise((r) => setTimeout(r, sampleMs));
    const b = await read();
    if (!a || !b) return null;
    const dTotal = b.total - a.total;
    const dSteal = b.steal - a.steal;
    if (!Number.isFinite(dTotal) || !Number.isFinite(dSteal) || dTotal <= 0 || dSteal < 0) return null;
    return Math.min(100 * (dSteal / dTotal), 100);
  } catch {
    return null;
  }
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
  steal?: StealReading & { definedAt: DeclaredEnvelope },
): DeadlineClassification | null {
  const verdict = classifyDeadlineExpiry(sample, spec, steal);
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

/** A steal reading for the envelope check: null = unmeasurable (fails closed). */
export interface StealReading {
  stealPct: number | null;
}

/**
 * THE RULE AS A PURE FUNCTION (63o3v): is a measurement taken at
 * { loadPerCore, stealPct } INSIDE the envelope the budget is defined at?
 * Above either axis the measurement is not evidence. stealPct null (could not
 * be measured) is OUTSIDE the envelope: a wall-clock budget is exactly what
 * steal invalidates, so unknown steal never reads as quiet.
 */
export function withinDeclaredEnvelope(
  measured: { loadPerCore: number | null; stealPct: number | null },
  definedAt: DeclaredEnvelope,
): { within: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (measured.loadPerCore == null) {
    reasons.push("load unmeasurable");
  } else if (measured.loadPerCore > definedAt.maxLoadPerCore) {
    reasons.push(`load/core ${measured.loadPerCore.toFixed(2)} > declared envelope ${definedAt.maxLoadPerCore}`);
  }
  if (measured.stealPct == null) {
    reasons.push("steal unmeasurable");
  } else if (measured.stealPct >= definedAt.maxStealPct) {
    reasons.push(`steal ${measured.stealPct.toFixed(1)}% >= declared envelope ${definedAt.maxStealPct}%`);
  }
  return { within: reasons.length === 0, reasons };
}

/**
 * Classify an expired deadline from a load sample taken AT the catch, plus an
 * optional steal reading against the budget's declared envelope (63o3v). Omit
 * `steal` and the classification is the 9z8xs load-only one, unchanged.
 * Unmeasurable fails CLOSED to environmental (never a load claim, never a
 * product red). Outside the envelope per the canonical quiet-window rule OR
 * the declared steal ceiling is environmental. Only a measurably quiet box
 * inside the envelope is "quiet" - the caller's assert then reds.
 */
export function classifyDeadlineExpiry(
  sample: LoadSample | null,
  spec: ResolvedSpec = resolveSpec(),
  steal?: StealReading & { definedAt: DeclaredEnvelope },
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
  if (steal) {
    // The steal axis: the load-only quiet window cannot see a starved hypervisor.
    if (steal.stealPct == null) {
      reasons.push("steal unmeasurable");
    } else if (steal.stealPct >= steal.definedAt.maxStealPct) {
      reasons.push(`steal ${steal.stealPct.toFixed(1)}% >= declared envelope ${steal.definedAt.maxStealPct}%`);
    }
  }
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
