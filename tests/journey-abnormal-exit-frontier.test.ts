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

// Extract evaluateJourneyFinalization function directly from production source
const evalFinalizationMatch = source.match(/function evaluateJourneyFinalization\([\s\S]*?\n\}\)\s*\{[\s\S]*?\n\}/);
assert(evalFinalizationMatch, "evaluateJourneyFinalization must be found");

// Extract JourneyEarlyStopError class and isIntentionalEarlyStop function
const earlyStopClassMatch = source.match(/class JourneyEarlyStopError[\s\S]*?\n\}/);
assert(earlyStopClassMatch, "JourneyEarlyStopError must be found");
const isEarlyStopMatch = source.match(/function isIntentionalEarlyStop\([\s\S]*?\n\}/);
assert(isEarlyStopMatch, "isIntentionalEarlyStop must be found");

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

Deno.test("9ud9e: evaluateJourneyFinalization handles clean pass, intentional early stop, and abnormal exit", () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const fakeConsole = {
    log: (...args: any[]) => logs.push(args.join(" ")),
    error: (...args: any[]) => errors.push(args.join(" ")),
  };

  const harness = new Function(
    "console",
    `let abnormalReported = false;
     let lastCompletedCheck = null;
     let lastStartedCheck = null;
     ${printMatch[0]}
     ${evalFinalizationMatch[0]}
     return { evaluateJourneyFinalization, isAbnormalReported: () => abnormalReported };`,
  )(fakeConsole);

  // 1. Clean run (missing = [], intentionalEarlyStop = false)
  const cleanOutcome = harness.evaluateJourneyFinalization({
    intentionalEarlyStop: false,
    results: [{ name: "c1", pass: true }],
    missing: [],
    frontierSnapshot: { lastCompletedCheck: "c1", lastStartedCheck: null },
  });
  assertEquals(cleanOutcome.status, "clean_pass");
  assertEquals(harness.isAbnormalReported(), false);
  assertEquals(logs.length, 0);

  // 2. Intentional early stop (intentionalEarlyStop = true)
  let exitCodeCalled: number | null = null;
  const earlyStopOutcome = harness.evaluateJourneyFinalization({
    intentionalEarlyStop: true,
    results: [{ name: "c1", pass: true }],
    missing: ["c2", "c3"],
    frontierSnapshot: { lastCompletedCheck: "c1", lastStartedCheck: "c2" },
    exitFn: (code: number) => { exitCodeCalled = code; },
  });
  assertEquals(earlyStopOutcome.status, "early_stop");
  assertEquals(earlyStopOutcome.exitCode, 0);
  assertEquals(exitCodeCalled, 0);
  assertEquals(harness.isAbnormalReported(), false);

  // 3. Finding P1 regression test:
  // If an abnormal error occurred before reaching the stop target, intentionalEarlyStop is FALSE.
  // It must report abnormal_exit with the exact frontier check, NOT take early stop.
  const abortOutcome = harness.evaluateJourneyFinalization({
    intentionalEarlyStop: false,
    results: [{ name: "c1", pass: true }],
    missing: ["c2", "c3"],
    mainException: new Error("CDP error on click"),
    frontierSnapshot: { lastCompletedCheck: "c1", lastStartedCheck: "c2" },
  });
  assertEquals(abortOutcome.status, "abnormal_exit");
  assertEquals(abortOutcome.missingCount, 2);
  assertEquals(harness.isAbnormalReported(), true);
  const logText = logs.join("\n");
  assert(logText.includes("=== ABNORMAL JOURNEY EXIT ==="));
  assert(logText.includes('last completed check:  "c1"'));
  assert(logText.includes('frontier check:        "c2"'));
  assert(logText.includes("unreached checks:      2 downstream checks were NOT REACHED"));
  assert(logText.includes("CDP error on click"));
});

Deno.test("9ud9e: isIntentionalEarlyStop accurately distinguishes matching sentinel from substring errors", () => {
  const harness = new Function(
    `${earlyStopClassMatch[0]}
     ${isEarlyStopMatch[0]}
     return { JourneyEarlyStopError, isIntentionalEarlyStop };`,
  )();

  const target = "create dialog: template select";

  // 1. Genuine sentinel matching configured target
  const sentinelErr = new harness.JourneyEarlyStopError(target);
  assertEquals(harness.isIntentionalEarlyStop(sentinelErr, target), true);

  // 2. Sentinel with wrong target
  const wrongTargetErr = new harness.JourneyEarlyStopError("other check");
  assertEquals(harness.isIntentionalEarlyStop(wrongTargetErr, target), false);

  // 3. Exact matching string message
  const exactMsgErr = new Error(`CAP_JOURNEY_STOP_AFTER: ${target}`);
  assertEquals(harness.isIntentionalEarlyStop(exactMsgErr, target), true);

  // 4. Substring containing error (the P1 vulnerability)
  const substringErr = new Error(`Unexpected syntax error near CAP_JOURNEY_STOP_AFTER: ${target} in parser`);
  assertEquals(harness.isIntentionalEarlyStop(substringErr, target), false);

  // 5. Configured target is missing / null
  assertEquals(harness.isIntentionalEarlyStop(sentinelErr, null), false);
  assertEquals(harness.isIntentionalEarlyStop(exactMsgErr, undefined), false);
});

Deno.test("9ud9e: startup failures before any checks execute report EXPECTED[0] as frontier check", () => {
  const logs: string[] = [];
  const fakeConsole = {
    log: (...args: any[]) => logs.push(args.join(" ")),
    error: () => {},
  };

  const harness = new Function(
    "console", "EXPECTED",
    `let abnormalReported = false;
     let lastCompletedCheck = null;
     let lastStartedCheck = EXPECTED[0];
     ${printMatch[0]}
     ${evalFinalizationMatch[0]}
     return { evaluateJourneyFinalization, isAbnormalReported: () => abnormalReported };`,
  )(fakeConsole, EXPECTED);

  // Simulate Deno.serve() or launchJourneyChrome() failing during startup:
  // Zero checks have run. missing = all EXPECTED checks.
  const startupOutcome = harness.evaluateJourneyFinalization({
    intentionalEarlyStop: false,
    results: [],
    missing: [...EXPECTED],
    mainException: new Error("Deno.serve failed: address already in use"),
    frontierSnapshot: { lastCompletedCheck: null, lastStartedCheck: EXPECTED[0] },
  });

  assertEquals(startupOutcome.status, "abnormal_exit");
  assertEquals(startupOutcome.missingCount, EXPECTED.length);
  assertEquals(harness.isAbnormalReported(), true);

  const logText = logs.join("\n");
  assert(logText.includes("=== ABNORMAL JOURNEY EXIT ==="));
  assert(logText.includes("last completed check:  (none)"));
  assert(logText.includes(`frontier check:        "${EXPECTED[0]}"`));
  assert(logText.includes(`unreached checks:      ${EXPECTED.length} downstream checks were NOT REACHED`));
  assert(logText.includes("Deno.serve failed: address already in use"));
});

Deno.test("9ud9e: homeCacheProfile throws error on missing or relative HOME to allow guarded diagnosis", () => {
  const homeCacheMatch = source.match(/function homeCacheProfile\([\s\S]*?\n\}/);
  assert(homeCacheMatch, "homeCacheProfile must be found");

  const fn = new Function(
    "Deno",
    `${homeCacheMatch[0]}
     return homeCacheProfile;`,
  );

  // Missing HOME
  const fakeDenoMissing = { env: { get: () => undefined } };
  let threw = false;
  try {
    fn(fakeDenoMissing)("test");
  } catch (err: any) {
    threw = true;
    assert(err.message.includes("HOME must be an absolute path"));
  }
  assertEquals(threw, true, "must throw on missing HOME");

  // Relative HOME
  const fakeDenoRelative = { env: { get: () => "relative/path" } };
  threw = false;
  try {
    fn(fakeDenoRelative)("test");
  } catch (err: any) {
    threw = true;
    assert(err.message.includes("HOME must be an absolute path"));
  }
  assertEquals(threw, true, "must throw on relative HOME");

  // Valid HOME
  const fakeDenoValid = { env: { get: () => "/home/user" } };
  const profile = fn(fakeDenoValid)("test-profile");
  assertEquals(profile, "/home/user/.cache/cap-review/test-profile");
});
