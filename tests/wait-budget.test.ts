// tests/wait-budget.test.ts — pins for chrome-agent-platform-9z8xs.
//
// The discrimination 9z8xs owes: at fleet load the wait must PASS (scaled
// budget) or REFUSE (environmental, exit 75 via the aggregator) - never a red
// that reads as a page defect. And the other direction: a measurably QUIET box
// keeps the base budget and a deadline expiry there stays a product red.
//
// Every sample below is hand-built: the discrimination is proven without
// manufacturing machine load (the quiet-window rule for pinnable classifiers).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  classifyDeadlineExpiry,
  deadlineRefusalError,
  phaseBudgetMs,
  waitBudgetSpec,
} from "../scripts/lib/wait-budget.ts";
import { MAX_LOAD_SCALE } from "../scripts/lib/serial-phase.mjs";
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

Deno.test("9z8xs budget: quiet box keeps the base; loaded or unmeasurable box gets MAX_LOAD_SCALE x base", () => {
  assertEquals(phaseBudgetMs(8000, 0.06, SPEC), 8000, "an idle box waits exactly the base, as before the fix");
  assertEquals(phaseBudgetMs(8000, SPEC.maxLoadPerCore, SPEC), 8000, "AT the quiet threshold the base still holds");
  assertEquals(
    phaseBudgetMs(8000, 2.5, SPEC),
    8000 * MAX_LOAD_SCALE,
    "load 20 on 8 cores (2.5/core, the pvdxe window) gets the scaled budget so the page can PASS",
  );
  assertEquals(phaseBudgetMs(8000, Number.NaN, SPEC), 8000 * MAX_LOAD_SCALE, "an unmeasurable load never shrinks the budget");
  assertEquals(phaseBudgetMs(10000, 1.0, SPEC), 10000 * MAX_LOAD_SCALE, "the settle wait scales the same way");
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
  assertEquals(phaseBudgetMs(8000, quiet.loadPerCore, SPEC), 8000, "and it waits only the base 8s");

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
