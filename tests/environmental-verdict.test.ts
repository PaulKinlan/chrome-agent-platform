// tests/environmental-verdict.test.ts — verification for chrome-agent-platform-9dvae.
// Single-sourced environmental refusal exit and marker constants.

import { assertEquals, assert } from "jsr:@std/assert@1";
import {
  ENVIRONMENTAL_REFUSAL_EXIT,
  ENVIRONMENTAL_REFUSAL_MARKER,
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

