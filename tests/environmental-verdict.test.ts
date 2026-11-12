// tests/environmental-verdict.test.ts — verification for chrome-agent-platform-9dvae.
// Single-sourced environmental refusal exit and marker constants.

import { assertEquals, assert } from "jsr:@std/assert@1";
import {
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
  classifyPhaseExitFromOutput,
  combinePhaseExitCodes,
} from "../scripts/lib/environmental-verdict.mjs";
import {
  ENVIRONMENTAL_REFUSAL_EXIT as QUIET_WINDOW_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER as QUIET_WINDOW_MARKER,
} from "../scripts/lib/quiet-window.ts";
import {
  ENVIRONMENTAL_REFUSAL_EXIT as BROWSER_PREREQ_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER as BROWSER_PREREQ_MARKER,
} from "../scripts/lib/browser-prerequisite.mjs";
import { areAllFailuresEnvironmental } from "../scripts/run-tests.mjs";

Deno.test("9dvae: environmental-verdict constants are single-sourced and match quiet-window.ts and browser-prerequisite.mjs", () => {
  assertEquals(ENVIRONMENTAL_REFUSAL_EXIT, 75);
  assertEquals(ENVIRONMENTAL_REFUSAL_MARKER, "CAP_ENVIRONMENTAL_REFUSAL");
  assertEquals(QUIET_WINDOW_EXIT, ENVIRONMENTAL_REFUSAL_EXIT, "quiet-window exit must equal environmental-verdict");
  assertEquals(QUIET_WINDOW_MARKER, ENVIRONMENTAL_REFUSAL_MARKER, "quiet-window marker must equal environmental-verdict");
  assertEquals(BROWSER_PREREQ_EXIT, ENVIRONMENTAL_REFUSAL_EXIT, "browser-prerequisite exit must equal environmental-verdict");
  assertEquals(BROWSER_PREREQ_MARKER, ENVIRONMENTAL_REFUSAL_MARKER, "browser-prerequisite marker must equal environmental-verdict");
});

Deno.test("k3a4c / ufpn2: scripts/run-tests.mjs imports ENVIRONMENTAL_REFUSAL_MARKER and uses no bare literals", () => {
  const runTestsContent = Deno.readTextFileSync(new URL("../scripts/run-tests.mjs", import.meta.url));
  assert(
    /import\s*\{[^}]*\bENVIRONMENTAL_REFUSAL_MARKER\b[^}]*\}\s*from\s*["']\.\/lib\/environmental-verdict\.mjs["']/.test(
      runTestsContent,
    ),
    "run-tests.mjs must import ENVIRONMENTAL_REFUSAL_MARKER from ./lib/environmental-verdict.mjs",
  );
  assert(
    !/CAP_ENVIRONMENTAL_REFUSAL/.test(runTestsContent),
    "run-tests.mjs must not contain bare literal or token CAP_ENVIRONMENTAL_REFUSAL",
  );

  const testOutput = `
 ERRORS 

test with environmental marker => ./tests/sample.test.ts:12:1
error: Error: ${ENVIRONMENTAL_REFUSAL_MARKER} {"reason":"prereq-failed"}
  throw new Error("${ENVIRONMENTAL_REFUSAL_MARKER}");
        ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(testOutput), true);
});

Deno.test("56hfm: areAllFailuresEnvironmental recognizes real-browser timeout errors under host load as environmental", () => {
  const swLoadOutput = `
 ERRORS 

waitForServiceWorker stall under host load => ./tests/sample-browser.test.ts:15:6
error: ServiceWorkerTargetTimeoutError: ${ENVIRONMENTAL_REFUSAL_MARKER}: ENVIRONMENT: waitForServiceWorker: Target.getTargets: deadline exceeded (120ms total budget, 30ms per-call budget, 3 attempts) [loaded] live-chrome=7 load1=12.50 load5=8.20 cores=14 load/core=0.89 heavy-builders=2[esbuild,cargo]
    throw new ServiceWorkerTargetTimeoutError(msg, details);
          ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(swLoadOutput), true);

  const cdpLoadOutput = `
 ERRORS 

cdp eval stall under host load => ./tests/sample-browser.test.ts:35:6
error: CdpLoadTimeoutError: ${ENVIRONMENTAL_REFUSAL_MARKER}: ENVIRONMENT: CDP Runtime.evaluate deadline exceeded (30000ms budget) under host load [loaded]: live-chrome=7 load1=12.50 load/core=0.89
    throw new CdpLoadTimeoutError(msg, verdict, budget, liveChrome);
          ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(cdpLoadOutput), true);

  const katEvalLoadOutput = `
 ERRORS 

kat evaluate stall under host load => ./tests/kat-evaluate-sample.test.ts:40:6
error: CdpEvaluateLoadTimeoutError: ${ENVIRONMENTAL_REFUSAL_MARKER}: ENVIRONMENT: CDP Runtime.evaluate exceeded total budget (25000ms, base 10000ms) under host load [loaded]: load1=12.50 load5=8.20 cores=14 load/core=0.89 (cdp evaluate exceeded the budget and the box WAS loaded)
    throw new CdpEvaluateLoadTimeoutError(method, verdict, baseTimeoutMs, starvationTimeoutMs);
          ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(katEvalLoadOutput), true);
});

Deno.test("56hfm: FALSIFICATION (two-sided) — idle timeouts and genuine product failures stay PRODUCT RED", () => {
  // 1. ServiceWorkerTargetTimeoutError while idle MUST be product red (environmental: false)
  const swIdleOutput = `
 ERRORS 

waitForServiceWorker timeout on idle box => ./tests/sample-browser.test.ts:15:6
error: ServiceWorkerTargetTimeoutError: PRODUCT RED (not environmental): waitForServiceWorker: Target.getTargets: deadline exceeded (80ms total budget, 25ms per-call budget, 2 attempts) [idle-never-settled] live-chrome=1 load1=0.20 load5=0.15 cores=14 load/core=0.01 heavy-builders=0
    throw new ServiceWorkerTargetTimeoutError(msg, details);
          ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(swIdleOutput), false, "idle service worker timeout must stay product red");

  // 2. CdpIdleTimeoutError while idle MUST be product red
  const cdpIdleOutput = `
 ERRORS 

cdp eval stall on idle box => ./tests/sample-browser.test.ts:35:6
error: CdpIdleTimeoutError: PRODUCT RED (not environmental): CDP Runtime.evaluate deadline exceeded (30000ms budget) while the box was measurably IDLE [load1=0.20 load5=0.15 cores=14 load/core=0.01 heavy-builders=0] — cdp evaluate exceeded the budget while the box was measurably IDLE
    throw new CdpIdleTimeoutError(msg, verdict, budget, liveChrome);
          ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(cdpIdleOutput), false, "idle cdp timeout must stay product red");

  // 3. CdpEvaluateIdleTimeoutError while idle MUST be product red
  const katIdleOutput = `
 ERRORS 

kat evaluate stall on idle box => ./tests/kat-evaluate-sample.test.ts:40:6
error: CdpEvaluateIdleTimeoutError: PRODUCT RED (not environmental): CDP Runtime.evaluate exceeded budget (10000ms) while the box was measurably IDLE [load1=0.20 load5=0.15 cores=14 load/core=0.01 heavy-builders=0] — cdp evaluate exceeded the budget while the box was measurably IDLE
    throw new CdpEvaluateIdleTimeoutError(method, verdict, timeoutMs);
          ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(katIdleOutput), false, "idle kat timeout must stay product red");

  // 4. An AssertionError that quotes load evidence or refusal markers MUST still be product red
  const assertionFailureWithLoadQuote = `
 ERRORS 

test failure with load quote => ./tests/wait-for-service-worker-resilience.test.ts:215:6
error: AssertionError: must have polled responsive Chrome multiple times under loaded: live-chrome=7 load1=12.50
    throw new AssertionError(msg);
          ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(assertionFailureWithLoadQuote), false, "AssertionError must never be converted to environmental");

  const assertionFailureEmbeddingRefusal = `
 ERRORS 

test failure embedding real refusal marker => ./tests/sample-failure.test.ts:25:6
error: AssertionError: Expected refusal but got QuietWindowRefusedError: ENVIRONMENT: machine is not quiet enough for this gate
    throw new AssertionError(msg);
          ^

 FAILURES 
`;
  assertEquals(areAllFailuresEnvironmental(assertionFailureEmbeddingRefusal), false, "AssertionError embedding real environmental refusal marker must never be converted to environmental");

  // 5. Finding lckla: Parallel phase load alone (e.g. load/core 0.89) with ZERO named heavy-builder jobs
  // MUST strictly remain PRODUCT RED (exit 1) per MERGER-PLAYBOOK m9g43.
  const swParallelPhaseOnlyLoadOutput = `
 ERRORS 

waitForServiceWorker timeout under suite's own parallel load => ./tests/sample-browser.test.ts:15:6
error: ServiceWorkerTargetTimeoutError: PRODUCT RED (not environmental): waitForServiceWorker: Target.getTargets: deadline exceeded (120ms total budget, 30ms per-call budget, 3 attempts) [idle-never-settled] live-chrome=7 load1=12.50 load5=8.20 cores=14 load/core=0.89 heavy-builders=0 active=0 jobs=0 — cdp operation exceeded the budget with zero concurrent named heavy-builder jobs (unnamed parallel-phase load: load1=12.50 load5=8.20 cores=14 load/core=0.89 heavy-builders=0 active=0 jobs=0) — preserving PRODUCT RED per MERGER-PLAYBOOK m9g43
    throw new ServiceWorkerTargetTimeoutError(msg, details);
          ^

 FAILURES 
`;
  assertEquals(
    areAllFailuresEnvironmental(swParallelPhaseOnlyLoadOutput),
    false,
    "suite parallel-phase load alone with zero named builders must strictly remain product red",
  );
});

Deno.test("xj6sb: combinePhaseExitCodes combines exit codes correctly and prioritizes product failures over refusals", () => {
  // All green
  assertEquals(combinePhaseExitCodes(0, 0, 0), 0);
  assertEquals(combinePhaseExitCodes(), 0);

  // Pure environmental refusal
  assertEquals(combinePhaseExitCodes(ENVIRONMENTAL_REFUSAL_EXIT, 0, 0), ENVIRONMENTAL_REFUSAL_EXIT);
  assertEquals(combinePhaseExitCodes(0, ENVIRONMENTAL_REFUSAL_EXIT), ENVIRONMENTAL_REFUSAL_EXIT);
  assertEquals(combinePhaseExitCodes(ENVIRONMENTAL_REFUSAL_EXIT, ENVIRONMENTAL_REFUSAL_EXIT), ENVIRONMENTAL_REFUSAL_EXIT);

  // Product failures strictly outrank environmental refusal
  assertEquals(combinePhaseExitCodes(ENVIRONMENTAL_REFUSAL_EXIT, 0, 1), 1, "product failure exit 1 must outrank refusal");
  assertEquals(combinePhaseExitCodes(1, ENVIRONMENTAL_REFUSAL_EXIT, 0), 1, "product failure exit 1 must outrank refusal");
  assertEquals(combinePhaseExitCodes(ENVIRONMENTAL_REFUSAL_EXIT, 124, 0), 124, "timeout exit 124 must outrank refusal");
  assertEquals(combinePhaseExitCodes(124, ENVIRONMENTAL_REFUSAL_EXIT), 124);
  assertEquals(combinePhaseExitCodes(1, 0, 0), 1);
});


// ── erxkj: the subset parallel phase must classify like the full tier ──────

const REFUSAL_ONLY_OUTPUT = `
 ERRORS 

boot timing under steal => ./tests/fake-quiet.test.ts:10:6
error: QuietWindowRefusedError: ENVIRONMENT: machine is not quiet enough for this gate (load1=11.76 load5=9.21 cores=8 load/core=1.47 heavy-builders=3)
    throw new QuietWindowRefusedError(msg);
          ^

 FAILURES 

boot timing under steal => ./tests/fake-quiet.test.ts:10:6

FAILED | 0 passed | 1 failed (15ms)
`;

const PRODUCT_RED_OUTPUT = `
 ERRORS 

assertion fails => ./tests/fake-product.test.ts:20:6
error: AssertionError: Values are not equal
    throw new AssertionError(msg);
          ^

 FAILURES 

assertion fails => ./tests/fake-product.test.ts:20:6

FAILED | 0 passed | 1 failed (9ms)
`;

Deno.test("erxkj: classifyPhaseExitFromOutput maps an all-environmental failure to 75 — the subset gate must not red on a refusal", () => {
  // The r2l8n incident: a stolen box (steal 36%, load/core 1.47) red-ed the fast gate
  // with rc=1 because the subset path returned the raw deno code.
  const verdict = classifyPhaseExitFromOutput(1, REFUSAL_ONLY_OUTPUT);
  assertEquals(verdict.code, ENVIRONMENTAL_REFUSAL_EXIT);
  assert(verdict.note?.length, "a reclassified exit always says why");
});

Deno.test("erxkj: classifyPhaseExitFromOutput NEVER softens a product red (two-sided pin)", () => {
  assertEquals(classifyPhaseExitFromOutput(1, PRODUCT_RED_OUTPUT).code, 1, "an AssertionError block is a product stop, refusal marker or not");
  const mixed = REFUSAL_ONLY_OUTPUT.replace("FAILURES", "X") + PRODUCT_RED_OUTPUT; // two blocks, one product
  assertEquals(classifyPhaseExitFromOutput(1, mixed).code, 1, "one product failure beside a refusal stays 1");
  assertEquals(classifyPhaseExitFromOutput(1, "no markers here at all\nFAILED | 0 passed | 1 failed").code, 1, "no marker → raw code");
  const noSummary = REFUSAL_ONLY_OUTPUT.replace(/FAILED \| 0 passed \| 1 failed \(15ms\)/, "");
  assertEquals(classifyPhaseExitFromOutput(1, noSummary).code, 1, "a refusal marker without a FAILED summary keeps the raw code");
  assertEquals(classifyPhaseExitFromOutput(0, REFUSAL_ONLY_OUTPUT).code, 0, "green is untouched");
  assertEquals(classifyPhaseExitFromOutput(124, "timed out").code, 124, "a bound kill is untouched");

// ── chrome-agent-platform-0i477 (2026-11-12): n3t01 made a FAILED BATCH consult
// areAllFailuresEnvironmental, so an all-environmental batch returns refusal 75 where it
// returned exit 1. That is defensible — a box that could not measure should refuse rather
// than fail — but the BOUNDARY is "every failure in the batch is environmental", and a
// boundary that softens is how a defect gets retried instead of investigated. These legs
// pin the whole mapping, including the case that was silently wrong.
Deno.test("0i477: the verdict mapping — all-environmental refuses, MIXED and product failures stay exit 1", () => {
  const REFUSAL = `\n\nntp-boot-staging: boots ntp.html => ./tests/ntp-boot-staging-timing.test.ts:41:6\n` +
    `error: QuietWindowRefusedError: ENVIRONMENT: machine is not quiet enough for this gate (waited 181351 ms)\n`;
  const PRODUCT = `\n\nproduct-suite: asserts something => ./tests/product.test.ts:12:3\n` +
    `error: AssertionError: Expected 0 long tasks, got 3\n`;
  // all-environmental -> refusal
  assertEquals(areAllFailuresEnvironmental(` ERRORS ${REFUSAL}\n FAILURES \n`), true, "all-environmental");
  // MIXED, both orders -> NOT a refusal (this is where softening would hide a defect)
  assertEquals(areAllFailuresEnvironmental(` ERRORS ${PRODUCT}${REFUSAL}\n FAILURES \n`), false, "mixed: product then refusal");
  assertEquals(areAllFailuresEnvironmental(` ERRORS ${REFUSAL}${PRODUCT}\n FAILURES \n`), false, "mixed: refusal then product");
  // product failure alone -> NOT a refusal
  assertEquals(areAllFailuresEnvironmental(` ERRORS ${PRODUCT}\n FAILURES \n`), false, "product alone");
});

Deno.test("0i477: a failure the block splitter does not recognise keeps the batch a FAILURE, even beside a refusal", () => {
  // The splitter starts a new block only at a `name => path` line, so anything printed
  // BEFORE the first such line used to be dropped by slice(1) — and a module-load death
  // (`error: Module not found …`, no arrow) ahead of an environmental refusal therefore
  // classified as ALL-environmental. Measured before the fix: this returned true, i.e.
  // classifyPhaseExit turned a tree that could not even LOAD a module into refusal 75,
  // which an operator requeues instead of investigating. That is the hjuis limitation
  // (module-load death is 'unknown', not a named failure) meeting the all-environmental
  // boundary, and the only safe answer is fail closed.
  const REFUSAL = `\n\nntp-boot-staging: boots ntp.html => ./tests/ntp-boot-staging-timing.test.ts:41:6\n` +
    `error: QuietWindowRefusedError: ENVIRONMENT: machine is not quiet enough for this gate (waited 181351 ms)\n`;
  const LOAD_DEATH = `\n\nerror: Module not found "file:///nope.js".\n`;
  assertEquals(
    areAllFailuresEnvironmental(` ERRORS ${LOAD_DEATH}${REFUSAL}\n FAILURES \n`),
    false,
    "an unrecognised error line ahead of a refusal must NOT be softened into a refusal",
  );
  assertEquals(areAllFailuresEnvironmental(` ERRORS ${LOAD_DEATH}\n FAILURES \n`), false, "a load death alone is a failure");
});
