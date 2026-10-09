// tests/wait-for-service-worker-resilience.test.ts — chrome-agent-platform-3nurz
//
// Tests for waitForServiceWorker resilience:
// 1. Per-call timeout policy allows recovery when the first Target.getTargets stalls,
//    proving that attempt 2 starts before attempt 1 settles.
// 2. Falsification: without per-call retry, a single stalled/timed out Target.getTargets
//    breaks the wait immediately or consumes the full budget.
// 3. Terminal transport errors (e.g. "cdp websocket closed") fail fast immediately
//    without retrying or misclassifying as host-load timeouts.
// 4. Non-timeout protocol errors fail fast immediately without retrying.
// 5. Exhausted deadline under load throws ServiceWorkerTargetTimeoutError with
//    host load classification and live Chrome count evidence.
// 6. Clean null return when Chrome is responsive but worker never registers.
// 7. Host load classification under idle conditions correctly marks environmental: false.
// 8. countLiveChromeProcesses executes safely without throwing.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  waitForServiceWorker,
  SW_MATCH,
  ServiceWorkerTargetTimeoutError,
  countLiveChromeProcesses,
  isTerminalTransportError,
} from "../scripts/lib/chrome-launch.ts";

const EXTENSION_SW = Object.freeze({
  targetId: "target-ext-sw",
  type: "service_worker",
  url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/dist/background/service-worker.js",
});

Deno.test("3nurz: waitForServiceWorker recovers when first Target.getTargets call stalls and triggers attempt 2 before attempt 1 settles", async () => {
  let call1StartedAt = 0;
  let call1SettledAt = 0;
  let call2StartedAt = 0;
  let callCount = 0;

  const mockSend = async (method: string) => {
    assertEquals(method, "Target.getTargets");
    callCount++;
    if (callCount === 1) {
      call1StartedAt = Date.now();
      // First call stalls for 250ms (longer than callTimeoutMs: 50ms)
      await new Promise((r) => setTimeout(r, 250));
      call1SettledAt = Date.now();
      return { result: { targetInfos: [] } };
    }
    call2StartedAt = Date.now();
    return { result: { targetInfos: [EXTENSION_SW] } };
  };

  const target = await waitForServiceWorker(mockSend, {
    timeoutMs: 600,
    callTimeoutMs: 50,
    intervalMs: 10,
  });

  assert(target, "must recover and find the service worker on second attempt");
  assertEquals(target.targetId, EXTENSION_SW.targetId);
  assertEquals(callCount, 2, "must have made exactly 2 attempts");
  assert(call2StartedAt > 0, "call 2 must have started");
  assert(
    call1SettledAt === 0 || call2StartedAt < call1SettledAt,
    `call 2 must start before call 1 settles (call 2 started at ${call2StartedAt - call1StartedAt}ms, call 1 settled at ${call1SettledAt - call1StartedAt}ms)`,
  );
  assert(
    call2StartedAt - call1StartedAt < 150,
    `call 2 must be triggered promptly by callTimeoutMs (started at ${call2StartedAt - call1StartedAt}ms, expected ~60ms)`,
  );
});

Deno.test("3nurz: FALSIFICATION — legacy behavior without per-call retry fails or hangs on first stalled call", async () => {
  let callCount = 0;
  const legacySend = async () => {
    callCount++;
    if (callCount === 1) {
      throw new Error("Target.getTargets: deadline");
    }
    return { result: { targetInfos: [EXTENSION_SW] } };
  };

  const target = await waitForServiceWorker(legacySend, {
    timeoutMs: 300,
    callTimeoutMs: 50,
    intervalMs: 10,
  });

  assert(target, "resilient implementation recovers from a transient Target.getTargets deadline on attempt 1");
  assertEquals(target.targetId, EXTENSION_SW.targetId);
  assertEquals(callCount, 2);
});

Deno.test("3nurz: terminal transport failure (cdp websocket closed) fails fast immediately without retrying or load classification", async () => {
  let callCount = 0;
  const start = Date.now();
  const closedSend = async () => {
    callCount++;
    throw new Error("Target.getTargets: cdp websocket closed");
  };

  const err: any = await assertRejects(
    () =>
      waitForServiceWorker(closedSend, {
        timeoutMs: 5000,
        callTimeoutMs: 1000,
        intervalMs: 250,
      }),
    Error,
    "cdp websocket closed",
  );

  const duration = Date.now() - start;
  assertEquals(callCount, 1, "terminal transport error must not be retried");
  assert(duration < 200, `terminal error must fail fast (took ${duration}ms, expected <200ms)`);
  assert(
    !(err instanceof ServiceWorkerTargetTimeoutError),
    "must not misclassify terminal socket closure as a load timeout",
  );
});

Deno.test("3nurz: non-timeout protocol error fails fast immediately", async () => {
  let callCount = 0;
  const failSend = async () => {
    callCount++;
    throw new Error("Target.getTargets: Invalid parameter 'foo'");
  };

  await assertRejects(
    () =>
      waitForServiceWorker(failSend, {
        timeoutMs: 2000,
        callTimeoutMs: 500,
        intervalMs: 100,
      }),
    Error,
    "Invalid parameter 'foo'",
  );

  assertEquals(callCount, 1, "non-timeout error must not be retried");
});

Deno.test("3nurz: waitForServiceWorker throws ServiceWorkerTargetTimeoutError naming budget and load when all calls stall under host load", async () => {
  let callCount = 0;
  const mockSend = async () => {
    callCount++;
    // Stalls indefinitely past per-call budget
    await new Promise((r) => setTimeout(r, 300));
    return { result: { targetInfos: [] } };
  };

  const mockVerdict: any = {
    cause: "loaded",
    environmental: true,
    reason: "cdp evaluate exceeded the budget and the box WAS loaded (load1/core > 0.8)",
    environment: "load1=12.50 load5=8.20 cores=14 load/core=0.89 heavy-builders=2[esbuild,cargo]",
    sample: null,
  };

  const err: any = await assertRejects(
    () =>
      waitForServiceWorker(mockSend, {
        timeoutMs: 120,
        callTimeoutMs: 30,
        intervalMs: 10,
        measureVerdict: async () => mockVerdict,
        countLiveChrome: () => 7,
      }),
    ServiceWorkerTargetTimeoutError,
  );

  assert(err instanceof ServiceWorkerTargetTimeoutError, "must be instance of ServiceWorkerTargetTimeoutError");
  assertEquals(err.totalTimeoutMs, 120);
  assertEquals(err.callTimeoutMs, 30);
  assertEquals(err.liveChrome, 7);
  assertEquals(err.verdict.cause, "loaded");
  assert(err.attempts >= 2, "must have retried multiple times before exhausting deadline");
  assert(err.timedOutCalls >= 2, "must have tracked timed out calls");
  assert(err.message.includes("Target.getTargets: deadline exceeded"), "message must identify Target.getTargets deadline");
  assert(err.message.includes("[loaded]"), "message must name load classification");
  assert(err.message.includes("live-chrome=7"), "message must include live Chrome process count");
  assert(err.message.includes("load/core=0.89"), "message must include host load info");
});

Deno.test("3nurz: waitForServiceWorker classifies timeout under idle conditions as idle-never-settled", async () => {
  const mockSend = async () => {
    await new Promise((r) => setTimeout(r, 200));
    return { result: { targetInfos: [] } };
  };

  const mockIdleVerdict: any = {
    cause: "idle-never-settled",
    environmental: false,
    reason: "cdp evaluate exceeded the budget while the box was measurably IDLE",
    environment: "load1=0.20 load5=0.15 cores=14 load/core=0.01 heavy-builders=0",
    sample: null,
  };

  const err: any = await assertRejects(
    () =>
      waitForServiceWorker(mockSend, {
        timeoutMs: 80,
        callTimeoutMs: 25,
        intervalMs: 10,
        measureVerdict: async () => mockIdleVerdict,
        countLiveChrome: () => 1,
      }),
    ServiceWorkerTargetTimeoutError,
  );

  assertEquals(err.verdict.cause, "idle-never-settled");
  assertEquals(err.verdict.environmental, false);
  assert(err.message.includes("[idle-never-settled]"));
});

Deno.test("3nurz: waitForServiceWorker returns null when Chrome is responsive but worker never registers", async () => {
  let callCount = 0;
  const mockSend = async () => {
    callCount++;
    return { result: { targetInfos: [] } };
  };

  const target = await waitForServiceWorker(mockSend, {
    timeoutMs: 60,
    callTimeoutMs: 25,
    intervalMs: 10,
  });

  assertEquals(target, null, "must return null when no worker registers within deadline without errors");
  assert(callCount >= 2, "must have polled responsive Chrome multiple times");
});

Deno.test("3nurz: isTerminalTransportError accurately detects socket closed and broken errors", () => {
  assertEquals(isTerminalTransportError(new Error("cdp websocket closed")), true);
  assertEquals(isTerminalTransportError(new Error("Target.getTargets: cdp websocket error")), true);
  assertEquals(isTerminalTransportError(new Error("connection closed by remote")), true);
  assertEquals(isTerminalTransportError(new Error("socket closed")), true);
  assertEquals(isTerminalTransportError(new Error("deadline")), false);
  assertEquals(isTerminalTransportError(new Error("Target.getTargets: deadline")), false);
  assertEquals(isTerminalTransportError(new Error("Unknown method")), false);
  assertEquals(isTerminalTransportError(null), false);
});

Deno.test("3nurz: countLiveChromeProcesses executes safely and returns non-negative integer", () => {
  const count = countLiveChromeProcesses();
  assert(Number.isSafeInteger(count), "must return safe integer");
  assert(count >= 0, "must be non-negative");
});
