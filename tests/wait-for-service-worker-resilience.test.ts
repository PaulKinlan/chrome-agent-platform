// tests/wait-for-service-worker-resilience.test.ts — chrome-agent-platform-3nurz, chrome-agent-platform-ilhra
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
//
// ilhra: every timing-sensitive case below runs on the INJECTED VIRTUAL CLOCK (opts.clock),
// not wall time. The previous version widened real-sleep margins (5x-15x), which cleared load
// 10-14 but kept four absolute wall-clock tripwires: (1) a 250ms stall vs a 50ms per-call
// budget — a >200ms scheduler slip settled call1 before call2 started and inverted the ORDER
// assertion; (2) a 300ms deadline vs a 50ms call timeout — slips >240ms broke attempts>=2;
// (3) a 300ms deadline vs 10ms intervals — slips >280ms broke callCount>=3; (4) a
// duration<2500ms fail-fast rail. Comparing wall sleeps against each other can never be made
// starvation-proof by margins, so the loop now runs on virtual time: ordering, attempt counts
// and budget consumption are EXACT and deterministic under any host load, and the suite no
// longer pays real seconds for its stalls. The falsifiers survive the rewrite: a genuinely
// unavailable context still reds, terminal/non-timeout errors still fail fast consuming zero
// budget, and attempt 2 still provably starts before attempt 1 settles.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { ENVIRONMENTAL_REFUSAL_MARKER } from "../scripts/lib/environmental-verdict.mjs";
import {
  waitForServiceWorker,
  withTimeoutViaSleep,
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

// ---------------------------------------------------------------------------
// Virtual clock harness (ilhra). Timers fire in exact virtual-time order; the
// drain loop runs the loop-under-test to settlement without any wall-clock
// deadline of its own. Real setTimeout(0) yields only pump microtask/macrotask
// interleaving — a starved scheduler can slow those yields but can never
// reorder virtual time or change an assertion outcome.
// ---------------------------------------------------------------------------
function virtualClock() {
  let time = 0;
  let seq = 0;
  const timers: Array<{ at: number; seq: number; resolve: () => void; cancelled: boolean }> = [];
  const yieldReal = () => new Promise<void>((r) => setTimeout(r, 0));
  const schedule = (ms: number) => {
    const entry = { at: time + ms, seq: seq++, resolve: () => {}, cancelled: false };
    const promise = new Promise<void>((resolve) => { entry.resolve = resolve; });
    timers.push(entry);
    return { promise, entry };
  };
  const live = () => timers.filter((t) => !t.cancelled);
  return {
    now: () => time,
    sleep(ms: number): Promise<void> {
      if (!(ms > 0)) return Promise.resolve();
      return schedule(ms).promise;
    },
    timer(ms: number): { promise: Promise<void>; cancel(): void } {
      if (!(ms > 0)) return { promise: Promise.resolve(), cancel: () => {} };
      const { promise, entry } = schedule(ms);
      return { promise, cancel: () => { entry.cancelled = true; } };
    },
    pending: () => live().length,
    async runNext(): Promise<void> {
      // Real event-loop semantics: the microtask queue fully drains BEFORE any timer callback
      // runs. Without this yield the first pick could fire a race timer that the loop-under-test
      // has already settled-and-cancelled in a microtask that has not run yet.
      await yieldReal();
      const queue = live();
      if (!queue.length) return;
      let idx = 0;
      for (let i = 1; i < queue.length; i++) {
        if (queue[i].at < queue[idx].at || (queue[i].at === queue[idx].at && queue[i].seq < queue[idx].seq)) idx = i;
      }
      const timer = queue[idx];
      timers.splice(timers.indexOf(timer), 1);
      time = timer.at;
      timer.resolve();
      // Let the loop under test reach its next suspension point.
      for (let i = 0; i < 4; i++) await yieldReal();
    },
  };
}
type VirtualClock = ReturnType<typeof virtualClock>;

/**
 * Run every virtual timer (in time order) until `p` settles AND no timer is left pending — for
 * cases whose assertions need dangling mock stalls to resolve (e.g. the ordering test's call1).
 */
async function drainClock<T>(clock: VirtualClock, p: Promise<T>, maxTimers = 100000): Promise<T> {
  let settled = false;
  p.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  let guard = 0;
  while ((!settled || clock.pending() > 0) && guard++ < maxTimers) {
    if (clock.pending() > 0) await clock.runNext();
    else await new Promise<void>((r) => setTimeout(r, 0));
  }
  assert(guard < maxTimers, "drainClock hit its cap — the loop under test never suspended on a virtual timer (deadlock?)");
  return await p; // rethrows for assertRejects callers; returns the value otherwise
}

/**
 * Drain ONLY until `p` settles, firing no timer afterwards — for fail-fast cases, where the
 * invariant is "settled before ANY timer fired" (clock.now() must still read 0). An immediate
 * real-timer yield lets a synchronous-ish rejection land before the first timer check.
 */
async function drainSettled<T>(clock: VirtualClock, p: Promise<T>, maxTimers = 100000): Promise<T> {
  let settled = false;
  p.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  await new Promise<void>((r) => setTimeout(r, 0));
  let guard = 0;
  while (!settled && guard++ < maxTimers) {
    if (clock.pending() > 0) await clock.runNext();
    else await new Promise<void>((r) => setTimeout(r, 0));
  }
  assert(guard < maxTimers, "drainSettled hit its cap — the loop under test never settled (deadlock?)");
  return await p;
}

Deno.test("3nurz+ilhra: per-call timeout policy allows recovery — attempt 2 starts before a stalled attempt 1 settles, in exact virtual time", async () => {
  const clock = virtualClock();
  let callCount = 0;
  let call1SettledAt = -1;
  let call2StartedAt = -1;
  const mockSend = async () => {
    callCount++;
    if (callCount === 1) {
      // Stall past the 50ms per-call budget — in VIRTUAL time.
      await clock.sleep(250);
      call1SettledAt = clock.now();
      return { result: { targetInfos: [] } };
    }
    call2StartedAt = clock.now();
    return { result: { targetInfos: [EXTENSION_SW] } };
  };

  const target = await drainClock(clock, waitForServiceWorker(mockSend, {
    timeoutMs: 600,
    callTimeoutMs: 50,
    intervalMs: 10,
    clock,
  }));

  assert(target, "must recover and find the service worker on second attempt");
  assertEquals(target.targetId, EXTENSION_SW.targetId);
  assertEquals(callCount, 2, "must have made exactly 2 attempts");
  // Deterministic virtual timeline: the per-call budget fires at t=50, the 10ms interval lands
  // attempt 2 at t=60, and call 1's stall settles at t=250. ilhra tripwire (1) is gone: no
  // scheduler slip can reorder these, because they are not wall events any more. The contract
  // under test is unchanged — ORDER (attempt 2 triggered by callTimeoutMs before attempt 1's
  // stall settles) plus exactly two attempts (owhbi's ORDER-not-latency pin, now exact).
  assertEquals(call2StartedAt, 60, "attempt 2 starts at the per-call timeout + interval, exactly");
  assertEquals(call1SettledAt, 250, "attempt 1's stall settles at its own virtual deadline");
  assert(call2StartedAt < call1SettledAt, "call 2 must start before call 1 settles");
});

Deno.test("3nurz+ilhra: FALSIFICATION — legacy behavior without per-call retry fails or hangs on first stalled call", async () => {
  const clock = virtualClock();
  let callCount = 0;
  const legacySend = async () => {
    callCount++;
    if (callCount === 1) {
      throw new Error("Target.getTargets: deadline");
    }
    return { result: { targetInfos: [EXTENSION_SW] } };
  };

  const target = await drainClock(clock, waitForServiceWorker(legacySend, {
    timeoutMs: 300,
    callTimeoutMs: 50,
    intervalMs: 10,
    clock,
  }));

  assert(target, "resilient implementation recovers from a transient Target.getTargets deadline on attempt 1");
  assertEquals(target.targetId, EXTENSION_SW.targetId);
  assertEquals(callCount, 2);
});

Deno.test("3nurz+ilhra: terminal transport failure (cdp websocket closed) fails fast consuming ZERO of the budget, without retrying or load classification", async () => {
  const clock = virtualClock();
  let callCount = 0;
  const closedSend = async () => {
    callCount++;
    throw new Error("Target.getTargets: cdp websocket closed");
  };

  const err: any = await assertRejects(
    () =>
      drainSettled(clock, waitForServiceWorker(closedSend, {
        timeoutMs: 5000,
        callTimeoutMs: 1000,
        intervalMs: 250,
        clock,
      })),
    Error,
    "cdp websocket closed",
  );

  assertEquals(callCount, 1, "terminal transport error must not be retried");
  // ilhra tripwire (4) is gone: the old `duration < 2500ms` rail compared wall clocks. The
  // honest invariant is BUDGET CONSUMPTION, and on the virtual clock it is exactly zero — the
  // rejection settles before any timer fires (the race timer is cancelled on settle). Waiting
  // the deadline out would consume virtual milliseconds and red here, under any host load.
  assertEquals(clock.now(), 0, "terminal error must fail without consuming any of the 5000ms budget");
  assert(
    !(err instanceof ServiceWorkerTargetTimeoutError),
    "must not misclassify terminal socket closure as a load timeout",
  );
});

Deno.test("3nurz: non-timeout protocol error fails fast immediately", async () => {
  const clock = virtualClock();
  let callCount = 0;
  const failSend = async () => {
    callCount++;
    throw new Error("Target.getTargets: Invalid parameter 'foo'");
  };

  await assertRejects(
    () =>
      drainSettled(clock, waitForServiceWorker(failSend, {
        timeoutMs: 2000,
        callTimeoutMs: 500,
        intervalMs: 100,
        clock,
      })),
    Error,
    "Invalid parameter 'foo'",
  );

  assertEquals(callCount, 1, "non-timeout error must not be retried");
  assertEquals(clock.now(), 0, "non-timeout error must not consume budget either");
});

Deno.test("3nurz+ilhra: waitForServiceWorker throws ServiceWorkerTargetTimeoutError naming budget and load when all calls stall under host load — with a DETERMINISTIC attempt count", async () => {
  const clock = virtualClock();
  let callCount = 0;
  const mockSend = async () => {
    callCount++;
    // Stalls indefinitely past the per-call budget — in virtual time.
    await clock.sleep(300);
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
      drainClock(clock, waitForServiceWorker(mockSend, {
        timeoutMs: 300,
        callTimeoutMs: 50,
        intervalMs: 10,
        clock,
        measureVerdict: async () => mockVerdict,
        countLiveChrome: () => 7,
      })),
    ServiceWorkerTargetTimeoutError,
  );

  assert(err instanceof ServiceWorkerTargetTimeoutError, "must be instance of ServiceWorkerTargetTimeoutError");
  assertEquals(err.totalTimeoutMs, 300);
  assertEquals(err.callTimeoutMs, 50);
  assertEquals(err.liveChrome, 7);
  assertEquals(err.verdict.cause, "loaded");
  // ilhra tripwire (2) is gone: the exact virtual timeline is attempts at t=0,60,120,180,240
  // (each per-call budget fires 50ms later, then the 10ms interval), and the loop breaks at
  // t=300 having entered a 6th iteration. attempts>=2 can no longer flake under gate load,
  // and the exact counts pin the retry cadence itself against regressions.
  assertEquals(err.attempts, 6, "retry cadence is exact on the virtual clock");
  assertEquals(err.timedOutCalls, 5, "every stalled call is counted, exactly");
  assertEquals(callCount, 5);
  assertEquals(err.message.includes("Target.getTargets: deadline exceeded"), true, "message must identify Target.getTargets deadline");
  assert(err.message.includes("[loaded]"), "message must name load classification");
  assert(err.message.includes("live-chrome=7"), "message must include live Chrome process count");
  assert(err.message.includes("load/core=0.89"), "message must include host load info");
  assert(err.message.includes(ENVIRONMENTAL_REFUSAL_MARKER), "message must carry refusal marker under load");
  assert(err.message.includes("ENVIRONMENT:"), "message must carry ENVIRONMENT prefix under load");
});

Deno.test("3nurz+ilhra: waitForServiceWorker classifies timeout under idle conditions as idle-never-settled", async () => {
  const clock = virtualClock();
  const mockSend = async () => {
    await clock.sleep(200);
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
      drainClock(clock, waitForServiceWorker(mockSend, {
        timeoutMs: 80,
        callTimeoutMs: 25,
        intervalMs: 10,
        clock,
        measureVerdict: async () => mockIdleVerdict,
        countLiveChrome: () => 1,
      })),
    ServiceWorkerTargetTimeoutError,
  );

  assertEquals(err.verdict.cause, "idle-never-settled");
  assertEquals(err.verdict.environmental, false);
  // Virtual timeline: attempts at t=0,35,70; the third per-call budget is clamped to the
  // remaining 10ms and fires at t=80 = deadline. Exact, not margin-derived.
  assertEquals(err.attempts, 3);
  assertEquals(err.timedOutCalls, 3);
  assert(err.message.includes("[idle-never-settled]"));
  assert(!err.message.includes(ENVIRONMENTAL_REFUSAL_MARKER), "idle message must NOT carry refusal marker");
  assert(err.message.includes("PRODUCT RED (not environmental):"), "idle message must carry product red prefix");
});

Deno.test("3nurz+ilhra: waitForServiceWorker returns null when Chrome is responsive but worker never registers", async () => {
  const clock = virtualClock();
  let callCount = 0;
  const mockSend = async () => {
    callCount++;
    return { result: { targetInfos: [] } };
  };

  const target = await drainClock(clock, waitForServiceWorker(mockSend, {
    timeoutMs: 300,
    callTimeoutMs: 25,
    intervalMs: 10,
    clock,
  }));

  assertEquals(target, null, "must return null when no worker registers within deadline without errors");
  // ilhra tripwire (3) is gone: the poll cadence is exact virtual time — an instant call plus
  // a 10ms interval at t=0,10,...,290, then the deadline check breaks at t=300. (The per-call
  // race timers are cancelled the instant each call settles, so they cannot drag the cadence.)
  // The old callCount>=3-under-300ms-wall pin could flake when slips ate the interval; this
  // cannot.
  assertEquals(callCount, 30, "keeps polling responsive Chrome at the exact interval until the deadline");
  assertEquals(clock.now(), 300, "the loop stops exactly at the deadline");
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

Deno.test("3nurz: SW_MATCH still identifies the loaded extension's service worker target", () => {
  assert(SW_MATCH(EXTENSION_SW), "the loaded extension SW target must match");
});

// ---------------------------------------------------------------------------
// Mutation-drill pin (ilhra). This pin was born from an EXECUTED drill, not an
// assumed one: removing `.finally(() => t.cancel())` from withTimeoutViaSleep
// left the original ten-case suite GREEN — nothing observed the dangling
// losing timer, yet on a virtual clock it fires later and drags time forward
// between polls (exactly what the seam's docblock warns about). The assertion
// below kills that mutant: with the cancel removed, pending() is 1 here.
// ---------------------------------------------------------------------------
Deno.test("ilhra mutation drill: withTimeoutViaSleep cancels its race timer the moment the wrapped call settles — zero pending virtual timers afterwards", async () => {
  const clock = virtualClock();
  const result = await withTimeoutViaSleep(Promise.resolve(EXTENSION_SW), 250, clock);
  assertEquals(result, EXTENSION_SW, "the settled value passes through");
  assertEquals(
    clock.pending(),
    0,
    "the losing 250ms race timer must be cancelled at settlement — a dangling timer would fire later and drag virtual time between polls",
  );
});
