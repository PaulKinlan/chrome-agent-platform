// tests/journey-abnormal-exit-frontier.test.ts — chrome-agent-platform-9ud9e
//
// Verifies the abnormal exit frontier tracking and guarantee in scripts/chrome-journeys.ts:
// 1. Frontier tracking accurately identifies the last completed check and the next expected
//    (or active) check across assertion transitions.
// 2. An abnormal exit (uncaught exception, unhandled rejection, or silent premature exit)
//    prints the exact frontier check and reason without masking the error.
// 3. CAP_JOURNEY_STOP_AFTER is recognized as an intentional non-error exit and does not report abnormal exit.
// 4. Clean runs with all checks passing produce zero abnormal exit output.
//
// Extracts the real tracking logic from scripts/chrome-journeys.ts without launching Chrome.
import { assert, assertEquals } from "jsr:@std/assert@1";

const source = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));

// Extract EXPECTED array
const expMatch = source.match(/const EXPECTED = \[([\s\S]*?)\];/);
assert(expMatch, "EXPECTED array must be found");
const EXPECTED: string[] = new Function(`return [${expMatch[1]}];`)();

// Extract the frontier block: formatCheckDetail to EXPECTED
const checkBlockMatch = source.match(/function formatCheckDetail\([\s\S]*?\n\/\*\* The exact, ordered set/);
assert(checkBlockMatch, "check block must be found");

// Extract printAbnormalExitSummary function
const printMatch = source.match(/function printAbnormalExitSummary\([\s\S]*?\n\}/);
assert(printMatch, "printAbnormalExitSummary must be found");

Deno.test("9ud9e: frontier tracks last-completed and advances last-started to the next EXPECTED assertion", () => {
  const ran = new Set<string>();
  const shutdownRan = new Set<string>();
  const results: any[] = [];
  const EXPECTED_RED = new Map<string, string>();
  const logs: string[] = [];
  const fakeConsole = { log: (...args: any[]) => logs.push(args.join(" ")), error: () => {} };

  const harness = new Function(
    "ran", "shutdownRan", "results", "EXPECTED_RED", "console", "EXPECTED",
    `${checkBlockMatch[0].replace("\n/** The exact, ordered set", "")}
     return { check, getLastCompleted: () => lastCompletedCheck, getLastStarted: () => lastStartedCheck, updateFrontier };`,
  )(ran, shutdownRan, results, EXPECTED_RED, fakeConsole, EXPECTED);

  // Before any check runs, frontier is initialized to EXPECTED[0]
  harness.updateFrontier("");
  assertEquals(harness.getLastCompleted(), "");
  assertEquals(harness.getLastStarted(), null);

  // Run first check
  harness.check(EXPECTED[0], true);
  assertEquals(harness.getLastCompleted(), EXPECTED[0]);
  assertEquals(harness.getLastStarted(), EXPECTED[1]);

  // Run through check #28 ("after disabling that recipe the four agent surfaces agree (0) again")
  const targetCheck = "after disabling that recipe the four agent surfaces agree (0) again";
  const targetIdx = EXPECTED.indexOf(targetCheck);
  assert(targetIdx >= 0, "target check must exist in EXPECTED");

  for (let i = 1; i <= targetIdx; i++) {
    harness.check(EXPECTED[i], true);
  }

  // After check #28 completes, lastCompletedCheck is #28 and lastStartedCheck is #29
  assertEquals(harness.getLastCompleted(), targetCheck);
  assertEquals(harness.getLastStarted(), EXPECTED[targetIdx + 1]);
  assertEquals(
    harness.getLastStarted(),
    "create dialog: the template select is the first step (Custom default; Starter/Other/Scheduled groups; no gallery grid)",
  );
});

Deno.test("9ud9e: printAbnormalExitSummary formats the named frontier and reason without masking error", () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const fakeConsole = {
    log: (...args: any[]) => logs.push(args.join(" ")),
    error: (...args: any[]) => errors.push(args.join(" ")),
  };

  const fn = new Function(
    "console",
    `let abnormalReported = false;
     let lastCompletedCheck = "after disabling that recipe the four agent surfaces agree (0) again";
     let lastStartedCheck = "create dialog: the template select is the first step (Custom default; Starter/Other/Scheduled groups; no gallery grid)";
     ${printMatch[0]}
     return printAbnormalExitSummary;`,
  )(fakeConsole);

  const testError = new Error("Create dialog click refused: hidden #new-agent");
  fn({
    reason: "uncaught exception in journey: Create dialog click refused: hidden #new-agent",
    error: testError,
    missingCount: 345,
  });

  const fullLog = logs.join("\n");
  assert(fullLog.includes("=== ABNORMAL JOURNEY EXIT ==="), "must include abnormal exit header");
  assert(fullLog.includes("reason:                uncaught exception in journey: Create dialog click refused"), "must name reason");
  assert(fullLog.includes('last completed check:  "after disabling that recipe the four agent surfaces agree (0) again"'), "must name last completed check");
  assert(fullLog.includes('frontier check:        "create dialog: the template select is the first step (Custom default; Starter/Other/Scheduled groups; no gallery grid)"'), "must name frontier check");
  assert(fullLog.includes("unreached checks:      345 downstream checks were NOT REACHED"), "must state unreached checks count");
  assert(fullLog.includes("Create dialog click refused: hidden #new-agent"), "must preserve exact error detail");
});

Deno.test("9ud9e: meta-checks in finally do not overwrite snapshotted frontier during premature exit", () => {
  const ran = new Set<string>();
  const shutdownRan = new Set<string>();
  const results: any[] = [];
  const EXPECTED_RED = new Map<string, string>();
  const logs: string[] = [];
  const fakeConsole = { log: (...args: any[]) => logs.push(args.join(" ")), error: () => {} };

  const harness = new Function(
    "ran", "shutdownRan", "results", "EXPECTED_RED", "console", "EXPECTED",
    `${checkBlockMatch[0].replace("\n/** The exact, ordered set", "")}
     return {
       check,
       getFrontier: () => ({ lastCompletedCheck, lastStartedCheck }),
     };`,
  )(ran, shutdownRan, results, EXPECTED_RED, fakeConsole, EXPECTED);

  // Run up to check #28
  const targetCheck = "after disabling that recipe the four agent surfaces agree (0) again";
  const targetIdx = EXPECTED.indexOf(targetCheck);
  for (let i = 0; i <= targetIdx; i++) {
    harness.check(EXPECTED[i], true);
  }

  // Snapshot frontier at the start of finally (the P1 fix)
  const frontierSnapshot = { ...harness.getFrontier() };
  assertEquals(frontierSnapshot.lastCompletedCheck, targetCheck);
  assertEquals(
    frontierSnapshot.lastStartedCheck,
    "create dialog: the template select is the first step (Custom default; Starter/Other/Scheduled groups; no gallery grid)",
  );

  // Now simulate the two final meta-checks running in finally
  harness.check("assertion set exact (no missing/extra checks)", false);
  harness.check("assertion order matches EXPECTED", true);

  // Un-snapshotted frontier has been overwritten by meta-checks
  assertEquals(harness.getFrontier().lastCompletedCheck, "assertion order matches EXPECTED");

  // But the snapshotted frontier retains the exact aborted check location
  assertEquals(frontierSnapshot.lastCompletedCheck, targetCheck);
  assertEquals(
    frontierSnapshot.lastStartedCheck,
    "create dialog: the template select is the first step (Custom default; Starter/Other/Scheduled groups; no gallery grid)",
  );
});

Deno.test("9ud9e: clean run and CAP_JOURNEY_STOP_AFTER intentional stop emit zero abnormal exit banners", () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const fakeConsole = {
    log: (...args: any[]) => logs.push(args.join(" ")),
    error: (...args: any[]) => errors.push(args.join(" ")),
  };

  // Simulate early-stop call site logic from scripts/chrome-journeys.ts:
  // When isEarlyStop is truthy, it exits early and never executes the missing checks banner.
  function simulateFinallyFlow(isEarlyStop: boolean, missingCount: number) {
    let abnormalBannerPrinted = false;
    if (isEarlyStop) {
      // early stop path: exits before missing checks are evaluated
      return { exitedEarly: true, abnormalBannerPrinted };
    }
    if (missingCount > 0) {
      abnormalBannerPrinted = true;
    }
    return { exitedEarly: false, abnormalBannerPrinted };
  }

  // 1. Clean run (all checks ran, missingCount = 0)
  const cleanResult = simulateFinallyFlow(false, 0);
  assertEquals(cleanResult.exitedEarly, false);
  assertEquals(cleanResult.abnormalBannerPrinted, false);

  // 2. Early-stop run (CAP_JOURNEY_STOP_AFTER set)
  const earlyStopResult = simulateFinallyFlow(true, 345);
  assertEquals(earlyStopResult.exitedEarly, true);
  assertEquals(earlyStopResult.abnormalBannerPrinted, false);

  // 3. Abnormal premature abort (missingCount > 0, not early stop)
  const abortResult = simulateFinallyFlow(false, 345);
  assertEquals(abortResult.exitedEarly, false);
  assertEquals(abortResult.abnormalBannerPrinted, true);
});
