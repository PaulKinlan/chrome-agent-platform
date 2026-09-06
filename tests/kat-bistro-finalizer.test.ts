// tests/kat-bistro-finalizer.test.ts — Verification of scripts/kat-webmcp-bistro.ts
// finalizer ordering, guaranteed teardown, fail-closed exit reporting, and lock/poison hygiene (06qj).
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { teardownChromeAndProfile } from "../scripts/lib/kat-finalizer.ts";

const root = new URL("..", import.meta.url).pathname;

Deno.test("kat-bistro: source inspection verifies teardown precedes report writes and unswallowed status timeout", async () => {
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

  // 4. Critical: status:4000 after SIGKILL must NOT be swallowed with .catch(() => {})
  assert(
    !finallyBody.includes("status, 4_000).catch("),
    "KAT must NOT swallow post-SIGKILL status timeout; unconfirmed exit must fail closed",
  );

  // 5. Fail-closed error handling on cleanup failure:
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
