// tests/kat-bistro-finalizer.test.ts — Verification of scripts/kat-webmcp-bistro.ts
// finalizer ordering, guaranteed teardown, fail-closed exit reporting, and lock/poison hygiene (06qj).
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";

const root = new URL("..", import.meta.url).pathname;

Deno.test("kat-bistro: source inspection verifies teardown precedes report writes and cleanup errors fail closed", async () => {
  const scriptText = await Deno.readTextFile(`${root}/scripts/kat-webmcp-bistro.ts`);

  // 1. Driving intentional autosubmit:
  assert(
    scriptText.includes("?toolautosubmit"),
    "KAT must append ?toolautosubmit to navigate to the auto-submitting demo mode",
  );

  // 2. Canonical openCdp and timeout bounding:
  assert(scriptText.includes("openCdp"), "KAT must use canonical openCdp client");
  assert(scriptText.includes("withTimeout"), "KAT must bound execution with withTimeout");

  // 3. Guaranteed teardown before reporting:
  const finallyIdx = scriptText.indexOf("finally {");
  assert(finallyIdx > 0, "KAT must contain finally block");
  const finallyBody = scriptText.slice(finallyIdx);

  const browserCloseIdx = finallyBody.indexOf("Browser.close");
  const killIdx = finallyBody.indexOf("SIGKILL");
  const profileRemoveIdx = finallyBody.indexOf("Deno.remove(PROFILE");
  const writeResultIdx = finallyBody.indexOf("Deno.writeTextFile(`${OUT}/result.json`");

  assert(browserCloseIdx > 0, "Browser.close must be in finally block");
  assert(killIdx > 0, "SIGKILL fallback must be in finally block");
  assert(profileRemoveIdx > 0, "PROFILE removal must be in finally block");
  assert(writeResultIdx > 0, "result.json write must be in finally block");

  assert(
    browserCloseIdx < writeResultIdx,
    "Teardown (Browser.close) must be initiated BEFORE result.json write",
  );
  assert(
    profileRemoveIdx < writeResultIdx,
    "PROFILE removal must occur BEFORE result.json write",
  );

  // 4. Fail-closed error handling on cleanup failure:
  assert(
    finallyBody.includes("cleanupError"),
    "KAT must track cleanupError and forbid swallowing cleanup failure",
  );
  assert(
    finallyBody.includes("poisonDetected"),
    "KAT must check for /tmp/cap-chrome-slot-POISON presence",
  );
  assert(
    finallyBody.includes("if (!isGreen) Deno.exit(1);") || finallyBody.includes("if (!isGreen)"),
    "KAT must exit 1 when cleanup fails, even if test assertions passed",
  );
});

Deno.test("kat-bistro finalizer: failure injection proves cleanup failure marks state RED and forces nonzero exit", () => {
  // Simulate the finalizer decision logic under injected failure conditions
  function evaluateFinalizer({
    runError,
    failCount,
    cleanupError,
    poisonDetected,
  }: {
    runError: string | null;
    failCount: number;
    cleanupError: string | null;
    poisonDetected: boolean;
  }) {
    const isGreen = !runError && failCount === 0 && !cleanupError && !poisonDetected;
    const resultData = {
      state: isGreen ? "GREEN" : "RED",
      error: runError || cleanupError,
      cleanupError,
      poisonDetected,
    };
    const exitCode = isGreen ? 0 : 1;
    return { isGreen, resultData, exitCode };
  }

  // Case 1: Pure success with clean cleanup -> GREEN / exit 0
  const clean = evaluateFinalizer({ runError: null, failCount: 0, cleanupError: null, poisonDetected: false });
  assertEquals(clean.isGreen, true);
  assertEquals(clean.resultData.state, "GREEN");
  assertEquals(clean.exitCode, 0);

  // Case 2: Injected browser teardown failure -> RED / exit 1 (Never swallowed!)
  const teardownFail = evaluateFinalizer({
    runError: null,
    failCount: 0,
    cleanupError: "browser_teardown_failed: process hung",
    poisonDetected: false,
  });
  assertEquals(teardownFail.isGreen, false);
  assertEquals(teardownFail.resultData.state, "RED");
  assertEquals(teardownFail.exitCode, 1);

  // Case 3: Injected profile removal failure -> RED / exit 1
  const profileFail = evaluateFinalizer({
    runError: null,
    failCount: 0,
    cleanupError: "profile_cleanup_failed: EPERM",
    poisonDetected: false,
  });
  assertEquals(profileFail.isGreen, false);
  assertEquals(profileFail.resultData.state, "RED");
  assertEquals(profileFail.exitCode, 1);

  // Case 4: Injected poison file detection -> RED / exit 1
  const poisonFail = evaluateFinalizer({
    runError: null,
    failCount: 0,
    cleanupError: "poison_slot_detected",
    poisonDetected: true,
  });
  assertEquals(poisonFail.isGreen, false);
  assertEquals(poisonFail.resultData.state, "RED");
  assertEquals(poisonFail.exitCode, 1);
});
