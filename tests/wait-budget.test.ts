// tests/wait-budget.test.ts — pins for chrome-agent-platform-9z8xs.
//
// The discrimination 9z8xs owes (re-review, coord 2026-10-27): budgets NEVER
// scale - below the quiet threshold the product behaviour is asserted with the
// normal budget, above it the suite REFUSES (environmental, exit 75 via the
// aggregator), immediately at the wait or at the catch if load arrived
// mid-wait. Never a red that reads as a page defect, never a green a slow
// product could hide behind.
//
// Every sample below is hand-built: the discrimination is proven without
// manufacturing machine load (the quiet-window rule for pinnable classifiers).

import { assert, assertEquals, assertStringIncludes, AssertionError } from "jsr:@std/assert@1";
import { PageThrowError } from "../scripts/lib/cdp-eval.ts";
import { ServiceWorkerTargetTimeoutError } from "../scripts/lib/chrome-launch.ts";
import {
  classifyDeadlineExpiry,
  deadlineRefusalError,
  isHarnessTimeoutError,
  refuseUnlessMeasurablyQuiet,
  waitBudgetSpec,
} from "../scripts/lib/wait-budget.ts";
import {
  areAllFailuresEnvironmental,
  ENVIRONMENTAL_REFUSAL_MARKER,
} from "../scripts/lib/environmental-verdict.mjs";
import type { LoadSample } from "../scripts/lib/quiet-window.ts";

const SPEC = waitBudgetSpec();

function sample(partial: Partial<LoadSample>): LoadSample {
  return {
    at: 1_000_000,
    load1: 0.5,
    load5: 0.5,
    load15: 0.5,
    cores: 8,
    loadPerCore: 0.06,
    compilers: 0,
    compilerNames: [],
    activeCompilers: 0,
    activeCompilerNames: [],
    activeBuilderJobs: 0,
    measurable: true,
    ...partial,
  };
}

Deno.test("9z8xs contract: there is NO budget scaling - a loaded or unmeasurable box REFUSES before the wait", () => {
  // The re-review P1: an extended budget converts a genuine 7s -> 21s slowdown into a
  // green and a real hang into a refusal. The pre-wait gate is refusal-only:
  const quiet = sample({ loadPerCore: 0.06 });
  assertEquals(
    refuseUnlessMeasurablyQuiet(quiet, SPEC),
    null,
    "a measurably quiet box proceeds with the NORMAL budget",
  );
  const loaded = refuseUnlessMeasurablyQuiet(sample({ load1: 20, loadPerCore: 2.5 }), SPEC);
  assert(loaded !== null && loaded.environmental, "a loaded box refuses BEFORE the wait - never pass, never extend");
  const unknown = refuseUnlessMeasurablyQuiet(null, SPEC);
  assert(unknown !== null && unknown.environmental, "an unmeasurable box refuses before the wait too");
});

Deno.test("9z8xs boundary (P2-b): AT the threshold is quiet, just ABOVE it refuses - for budgeting and classification alike", () => {
  const at = sample({ load1: SPEC.maxLoadPerCore * 8, loadPerCore: SPEC.maxLoadPerCore });
  assertEquals(refuseUnlessMeasurablyQuiet(at, SPEC), null, "AT maxLoadPerCore the box is quiet (the comparison is >)");
  assertEquals(classifyDeadlineExpiry(at, SPEC).environmental, false, "AT the threshold an expired deadline stays a product red");
  const eps = SPEC.maxLoadPerCore + 1e-9;
  const above = sample({ load1: eps * 8, loadPerCore: eps });
  const gate = refuseUnlessMeasurablyQuiet(above, SPEC);
  assert(gate !== null && gate.environmental, "one epsilon ABOVE the threshold refuses before the wait");
  assertEquals(classifyDeadlineExpiry(above, SPEC).environmental, true, "one epsilon above, an expired deadline refuses at the catch");
});

Deno.test("9z8xs classification: a deadline expiry on a LOADED box is an environmental refusal with the numbers", () => {
  const loaded = sample({ load1: 20, load5: 18, load15: 15, loadPerCore: 2.5 });
  const verdict = classifyDeadlineExpiry(loaded, SPEC);
  assertEquals(verdict.environmental, true, "load 15-20 (2.5/core) must classify environmental");
  assertEquals(verdict.cause, "loaded");
  assert(verdict.reasons.length > 0, "the refusal must name WHY (the measured reasons)");

  const err = deadlineRefusalError("readyState", "ntp/ntp.html", 32000, 8000, verdict);
  assertStringIncludes(err.message, ENVIRONMENTAL_REFUSAL_MARKER);
  assertStringIncludes(err.message, "load/core", "the payload carries the measurement, not a bare claim");
  assert(!err.message.includes("AssertionError"), "the refusal is a plain Error, never an AssertionError");

  // The aggregator contract: this exact error shape classifies the run as an
  // environmental refusal (exit 75), not a product red.
  const fakeOutput = `\n ERRORS \n\nreadyState wait => ./tests/chunk-resolution-browser.test.ts:115:6\nerror: ${err.message}\n\n FAILURES \n\nreadyState wait => ./tests/chunk-resolution-browser.test.ts:115:6\n`;
  assertEquals(
    areAllFailuresEnvironmental(fakeOutput),
    true,
    "the aggregator must read this refusal as environmental (exit 75), never a product red",
  );
});

Deno.test("9z8xs classification: an UNMEASURABLE box fails closed to environmental, never a load claim", () => {
  const verdict = classifyDeadlineExpiry(null, SPEC);
  assertEquals(verdict.environmental, true);
  assertEquals(verdict.cause, "unmeasurable");
  const err = deadlineRefusalError("settle", "options/options.html", 40000, 10000, verdict);
  assertStringIncludes(err.message, ENVIRONMENTAL_REFUSAL_MARKER);
  assertStringIncludes(err.message, "NOT a load claim");

  const unreadable = sample({ measurable: false, error: "proc scan truncated" });
  const v2 = classifyDeadlineExpiry(unreadable, SPEC);
  assertEquals(v2.environmental, true);
  assertEquals(v2.cause, "unmeasurable");
});

Deno.test("9z8xs classification: a measurably QUIET box keeps the product red (no refusal, base budget)", () => {
  const quiet = sample({ load1: 0.4, loadPerCore: 0.05, compilers: 0, activeBuilderJobs: 0 });
  const verdict = classifyDeadlineExpiry(quiet, SPEC);
  assertEquals(verdict.environmental, false, "a quiet box must NOT earn a refusal");
  assertEquals(verdict.cause, "quiet");

  // A single active builder job is within the quiet spec (maxCompilers 1) and
  // alone does not earn a refusal - the suite's own cohort must not mask a
  // genuine hang either.
  const oneBuilder = sample({ compilers: 3, compilerNames: ["esbuild"], activeCompilers: 3, activeBuilderJobs: 1 });
  assertEquals(
    classifyDeadlineExpiry(oneBuilder, SPEC).environmental,
    false,
    "one builder job within spec stays a product red - only BEYOND the spec refuses",
  );
  const twoJobs = sample({ compilers: 4, compilerNames: ["esbuild", "rustc"], activeCompilers: 4, activeBuilderJobs: 2 });
  assertEquals(classifyDeadlineExpiry(twoJobs, SPEC).environmental, true, "two builder jobs exceed the spec and refuse");
});

Deno.test("9z8xs P2-c (second round): isHarnessTimeoutError matches ONLY the untyped withTimeout spelling", () => {
  // The laundering case the review caught: a page-origin throw whose text reads
  // "deadline exceeded" must NOT reclassify into an environmental refusal.
  assertEquals(
    isHarnessTimeoutError(new PageThrowError("Runtime.evaluate deadline exceeded (20000ms budget)")),
    false,
    "a page-origin throw is a product failure even when its text matches a harness timeout",
  );
  assertEquals(isHarnessTimeoutError(new PageThrowError("deadline")), false, "a page throw is never a harness error, text be damned");
  // The typed harness timeouts SELF-CLASSIFY at their source (marker or PRODUCT RED
  // prefix) - the catch must not re-measure them, so they never match here.
  const swErr = new ServiceWorkerTargetTimeoutError(
    "PRODUCT RED (not environmental): waitForServiceWorker: Target.getTargets: deadline exceeded",
    { totalTimeoutMs: 1, callTimeoutMs: 1, attempts: 1, timedOutCalls: 1, liveChrome: 0, verdict: {}, lastError: null } as never,
  );
  assertEquals(isHarnessTimeoutError(swErr), false, "a self-classified typed timeout propagates, never reclassified");
  // The one legitimate target: withTimeout's untyped bare deadline (chrome-launch.ts:1764).
  assertEquals(isHarnessTimeoutError(new Error("deadline")), true, "the untyped withTimeout spelling is the catch's whole job");
  // Exclusions: assertions, marker carriers, generic timeout text, non-errors.
  assertEquals(isHarnessTimeoutError(new AssertionError("deadline")), false);
  assertEquals(isHarnessTimeoutError(new Error(`${ENVIRONMENTAL_REFUSAL_MARKER} {...}`)), false);
  assertEquals(isHarnessTimeoutError(new Error("operation timed out")), false, "generic timeout text never matches");
  assertEquals(isHarnessTimeoutError("deadline"), false, "a non-Error never matches");
});
