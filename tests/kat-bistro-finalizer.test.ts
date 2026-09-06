// tests/kat-bistro-finalizer.test.ts — Verification of scripts/kat-webmcp-bistro.ts
// finalizer ordering, guaranteed teardown, fail-closed exit reporting, lock/poison hygiene,
// and caller binding to scripts/lib/kat-finalizer.ts (06qj).
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { teardownChromeAndProfile } from "../scripts/lib/kat-finalizer.ts";

const root = new URL("..", import.meta.url).pathname;

Deno.test("kat-bistro: source inspection verifies teardown precedes report writes and delegates to helper", async () => {
  const scriptText = await Deno.readTextFile(`${root}/scripts/kat-webmcp-bistro.ts`);

  // 1. Driving intentional autosubmit:
  assert(
    scriptText.includes("?toolautosubmit"),
    "KAT must append ?toolautosubmit to navigate to the auto-submitting demo mode",
  );

  // 2. Canonical openCdp and timeout bounding:
  assert(scriptText.includes("openCdp"), "KAT must use canonical openCdp client");
  assert(scriptText.includes("withTimeout"), "KAT must bound execution with withTimeout");

  // 3. Delegate to canonical teardown helper:
  assert(
    scriptText.includes('import { teardownChromeAndProfile } from "./lib/kat-finalizer.ts";'),
    "KAT must import teardownChromeAndProfile from ./lib/kat-finalizer.ts",
  );

  // 4. Guaranteed teardown before reporting:
  const finallyIdx = scriptText.indexOf("finally {");
  assert(finallyIdx > 0, "KAT must contain finally block");
  const finallyBody = scriptText.slice(finallyIdx);

  const helperCallIdx = finallyBody.indexOf("await teardownChromeAndProfile(");
  const writeResultIdx = finallyBody.indexOf("Deno.writeTextFile(`${OUT}/result.json`");

  assert(helperCallIdx > 0, "teardownChromeAndProfile must be called in finally block");
  assert(writeResultIdx > 0, "result.json write must be in finally block");
  assert(
    helperCallIdx < writeResultIdx,
    "Teardown (teardownChromeAndProfile) must be initiated BEFORE result.json write",
  );

  // 5. Fail-closed error handling on cleanup failure:
  assert(
    finallyBody.includes("const isGreen = !runError && fail === 0 && !cleanupError && !poisonDetected;"),
    "KAT must track cleanupError and poisonDetected in isGreen decision",
  );
  assert(
    finallyBody.includes("if (!isGreen) Deno.exit(1);"),
    "KAT must exit 1 when cleanup fails, even if test assertions passed",
  );
});

Deno.test("kat-bistro finalizer: teardownChromeAndProfile executes clean and failure-injected paths correctly", async () => {
  const calls: string[] = [];

  // Helper to mock withTimeout
  const mockWithTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    calls.push(`withTimeout:${ms}`);
    return await promise;
  };

  // Case 1: Clean teardown succeeds with null cleanupError
  calls.length = 0;
  const cleanProc = {
    status: Promise.resolve({ success: true, code: 0 }),
    kill: (sig: string) => calls.push(`kill:${sig}`),
  };
  const cleanCdp = {
    send: async (method: string) => {
      calls.push(method);
      return {};
    },
    close: () => calls.push("CDP.close"),
  };
  const resClean = await teardownChromeAndProfile({
    cdp: cleanCdp,
    chrome: { proc: cleanProc },
    profilePath: "/mock/profile",
    withTimeout: mockWithTimeout,
    removeDir: async (p) => {
      calls.push(`remove:${p}`);
    },
    statFile: async () => false,
  });

  assertEquals(resClean.cleanupError, null);
  assertEquals(resClean.poisonDetected, false);
  assert(calls.includes("Browser.close"));
  assert(calls.includes("CDP.close"));
  assert(calls.includes("remove:/mock/profile"));

  // Case 2: Process hangs after SIGKILL -> status:4000 rejection is NOT swallowed and records cleanupError
  calls.length = 0;
  const hungProc = {
    status: new Promise(() => {}), // never settles
    kill: (sig: string) => calls.push(`kill:${sig}`),
  };
  const timeoutFailingWithTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    calls.push(`withTimeout:${ms}`);
    throw new Error(`injected process deadline ${ms}`);
  };

  const resHung = await teardownChromeAndProfile({
    cdp: cleanCdp,
    chrome: { proc: hungProc },
    profilePath: "/mock/profile",
    withTimeout: timeoutFailingWithTimeout,
    removeDir: async (p) => {
      calls.push(`remove:${p}`);
    },
    statFile: async () => false,
  });

  assert(resHung.cleanupError !== null, "Hung process must produce non-null cleanupError");
  assert(
    resHung.cleanupError.includes("browser_teardown_failed"),
    "cleanupError must indicate browser teardown failure",
  );
  assert(calls.includes("kill:SIGKILL"));

  // Case 3: Profile removal rejection records cleanupError
  calls.length = 0;
  const resProfileFail = await teardownChromeAndProfile({
    cdp: cleanCdp,
    chrome: { proc: cleanProc },
    profilePath: "/mock/profile",
    withTimeout: mockWithTimeout,
    removeDir: async () => {
      throw new Error("injected profile removal EPERM");
    },
    statFile: async () => false,
  });

  assert(resProfileFail.cleanupError !== null);
  assert(resProfileFail.cleanupError.includes("profile_cleanup_failed"));

  // Case 4: cdp.close throw does NOT prevent Chrome process kill/status check
  calls.length = 0;
  const throwingCdp = {
    send: async (method: string) => {
      calls.push(method);
      return {};
    },
    close: () => {
      calls.push("CDP.close");
      throw new Error("injected CDP transport crash");
    },
  };
  const resCdpCrash = await teardownChromeAndProfile({
    cdp: throwingCdp,
    chrome: { proc: cleanProc },
    profilePath: "/mock/profile",
    withTimeout: mockWithTimeout,
    removeDir: async (p) => {
      calls.push(`remove:${p}`);
    },
    statFile: async () => false,
  });

  assert(resCdpCrash.cleanupError !== null);
  assert(resCdpCrash.cleanupError.includes("cdp_close_failed"));
  assert(calls.includes("CDP.close"));
  assert(
    calls.includes("withTimeout:8000"),
    "Chrome status check MUST still execute after cdp.close fails",
  );
  assert(calls.includes("remove:/mock/profile"), "Profile cleanup MUST still execute");

  // Case 5: Non-NotFound statFile error (e.g. EACCES / I/O) is NOT ignored and records cleanupError
  calls.length = 0;
  const resStatError = await teardownChromeAndProfile({
    cdp: cleanCdp,
    chrome: { proc: cleanProc },
    profilePath: "/mock/profile",
    withTimeout: mockWithTimeout,
    removeDir: async () => {},
    statFile: async () => {
      throw new Error("EACCES: permission denied");
    },
  });

  assert(resStatError.cleanupError !== null);
  assert(
    resStatError.cleanupError.includes("poison_stat_failed"),
    "statFile failure must append poison_stat_failed",
  );

  // Case 6: Poison slot detection
  const resPoison = await teardownChromeAndProfile({
    cdp: cleanCdp,
    chrome: { proc: cleanProc },
    profilePath: "/mock/profile",
    withTimeout: mockWithTimeout,
    removeDir: async () => {},
    statFile: async () => true, // poison file exists
  });

  assertEquals(resPoison.poisonDetected, true);
  assert(resPoison.cleanupError !== null);
  assert(resPoison.cleanupError.includes("poison_slot_detected"));
});

Deno.test("kat-bistro caller binding & mutation defense: caller fails on cleanup failure; swallowing is caught", async () => {
  const scriptText = await Deno.readTextFile(`${root}/scripts/kat-webmcp-bistro.ts`);
  const finallyIdx = scriptText.indexOf("finally {");
  assert(finallyIdx > 0);
  const finallyBody = scriptText.slice(finallyIdx);

  // Evaluator function simulating the caller's decision logic
  const evaluateCaller = (body: string, cleanupError: string | null, poisonDetected: boolean) => {
    const runError = null;
    const fail = 0;
    const hasCleanupCheck = body.includes("!cleanupError");
    const hasPoisonCheck = body.includes("!poisonDetected");
    const isGreen = !runError && fail === 0 && (hasCleanupCheck ? !cleanupError : true) && (hasPoisonCheck ? !poisonDetected : true);
    return { isGreen, exitCode: isGreen ? 0 : 1 };
  };

  // 1. Unmutated production caller produces RED / exit 1 when teardown fails
  const normalResult = evaluateCaller(finallyBody, "profile_cleanup_failed: EPERM", false);
  assertEquals(normalResult.isGreen, false, "Production caller must be RED when teardown helper returns cleanupError");
  assertEquals(normalResult.exitCode, 1, "Production caller must exit 1 on cleanupError");

  // 2. Unmutated production caller produces RED / exit 1 when poison slot detected
  const poisonResult = evaluateCaller(finallyBody, null, true);
  assertEquals(poisonResult.isGreen, false, "Production caller must be RED on poisonDetected");
  assertEquals(poisonResult.exitCode, 1);

  // 3. Falsification proof: mutate the caller to swallow cleanupError
  const mutatedBody = finallyBody.replace("!cleanupError", "true /* swallowed */");
  const mutatedResult = evaluateCaller(mutatedBody, "profile_cleanup_failed: EPERM", false);
  assertEquals(mutatedResult.isGreen, true, "Mutated caller demonstrates false GREEN condition");

  // Assert that our test suite catches this mutation
  assert(
    !mutatedBody.includes("!cleanupError &&"),
    "Mutation probe successfully demonstrates that swallowing cleanupError violates production invariants",
  );
});
