// tests/harness-readiness.test.ts — falsification tests for harness app readiness (chrome-agent-platform-iksuc).
//
// Invariant: journey/KAT harnesses must not interact with an unhydrated app page.
// Pre-hydration interactions silently no-op and cause false INCONCLUSIVE exit 1s.
// This test suite proves:
// 1. A pre-hydration click on an unhydrated element silently no-ops (the bug).
// 2. The shared readiness primitive polls until hydration completes and executes safely.
// 3. A delayed-hydration fixture exceeding timeout reports the NAMED failure state:
//    "app never became ready", with zero premature clicks dispatched.
// 4. clickVisibleCreateAgent with { waitForReady: true } refuses unready targets.
// 5. waitForAppReady bounds wait when evaluator stalls or never resolves.
// 6. APP_READY_EXPRESSION accurately detects DOM hydration for NTP, Sidepanel, and Options.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  APP_NEVER_BECAME_READY,
  APP_READY_ATTR,
  APP_READY_EXPRESSION,
  interactWhenReady,
  isTransportOrEvaluateTimeoutError,
  waitForAppReady,
} from "../scripts/lib/app-readiness.ts";
import { isCdpEvaluateTimeout } from "../scripts/lib/quiet-window.ts";
import {
  CdpEvaluateLoadTimeoutError,
  CdpEvaluateIdleTimeoutError,
  type EvaluateTimeoutVerdict,
} from "../scripts/lib/kat-evaluate.ts";
import { clickVisibleCreateAgent } from "../scripts/lib/create-agent-click.ts";

// chrome-agent-platform-2y6fr: the poll loop's timing tests below assert BEHAVIOUR
// ("a hung probe is retried", "the budget is honoured"), and used to assert it against
// real elapsed milliseconds and observed poll counts. On a loaded box one scheduling
// overshoot could swallow the whole timeoutMs budget, so the fixture reported
// "must poll multiple times ... (got 1 calls)" for a product that was correct — a red
// that named the box, not the code. These tests now run the loop on a driven clock
// (AppReadinessOptions.timers): zero real time passes, every timer fires in order, and
// the same assertions become exact rather than racy.
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++seq;
      queue.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle: any) {
      queue.delete(handle as number);
    },
    pending: () => queue.size,
    /** Fire the earliest pending timer, advancing the clock to its due time. */
    fireNextDue(): boolean {
      let nextId: number | null = null;
      let next: { at: number; fn: () => void } | null = null;
      for (const [id, item] of queue) {
        if (next === null || item.at < next.at) {
          nextId = id;
          next = item;
        }
      }
      if (nextId === null || next === null) return false;
      queue.delete(nextId);
      if (next.at > now) now = next.at;
      next.fn();
      return true;
    },
  };
}

type FakeTimers = ReturnType<typeof fakeTimers>;

async function drainMicrotasks(rounds = 24) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Run `work` to completion on the fake clock, firing timers in due order. */
async function onFakeClock<T>(work: () => Promise<T>, timers: FakeTimers, maxSteps = 4096): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let error: any = null;
  work().then(
    (v) => { settled = true; value = v; },
    (e) => { settled = true; error = e; },
  );
  for (let step = 0; step < maxSteps && !settled; step++) {
    await drainMicrotasks();
    if (settled) break;
    timers.fireNextDue();
  }
  await drainMicrotasks();
  if (!settled) throw new Error("fake clock: work did not settle within the step budget");
  if (error) throw error;
  return value as T;
}

Deno.test("iksuc: pre-hydration click silently no-ops on unhydrated fixture (reproducing the gap)", async () => {
  // DOM fixture before hydration: button exists, but event listener is not yet wired
  let dialogOpened = false;
  const button = {
    clicked: 0,
    listeners: [] as Array<() => void>,
    addEventListener(_type: string, fn: () => void) {
      this.listeners.push(fn);
    },
    click() {
      this.clicked++;
      for (const fn of this.listeners) fn();
    },
  };

  // Premature click before hydration listener is added:
  button.click();
  assertEquals(button.clicked, 1, "button received click event");
  assertEquals(dialogOpened, false, "listener was absent, so click silently no-op'd");

  // Hydration occurs later:
  button.addEventListener("click", () => {
    dialogOpened = true;
  });

  // A post-hydration click succeeds:
  button.click();
  assertEquals(button.clicked, 2);
  assertEquals(dialogOpened, true, "click after hydration successfully opens dialog");
});

Deno.test("iksuc: delayed-hydration fixture succeeds when readiness is polled within bound", async () => {
  let probeCount = 0;
  let hydrated = false;

  // Simulate delayed hydration settling after ~120ms
  setTimeout(() => {
    hydrated = true;
  }, 120);

  const evaluate = async (_expr: string) => {
    probeCount++;
    if (hydrated) {
      return { ready: true, signal: "ntp-hydrated" };
    }
    return { ready: false, readyState: "loading" };
  };

  let clicked = false;
  const result = await interactWhenReady(
    evaluate,
    async () => {
      clicked = true;
      return "dialog_open";
    },
    { timeoutMs: 1500, pollIntervalMs: 40, surfaceName: "NTP Hub" },
  );

  assertEquals(result, "dialog_open");
  assertEquals(clicked, true, "interaction only executes after hydration");
  assert(probeCount >= 2, `polled multiple times before settling (got ${probeCount})`);
});

Deno.test("iksuc: falsification — delayed-hydration fixture exceeding timeout reports NAMED failure state rather than silent no-op", async () => {
  let clickCount = 0;
  let probeCount = 0;

  // Fixture that never hydrates / hydration delayed beyond bound
  const evaluate = async (_expr: string) => {
    probeCount++;
    return { ready: false, readyState: "interactive", reason: "staged boot unfinished" };
  };

  let caughtError: Error | null = null;
  try {
    await interactWhenReady(
      evaluate,
      async () => {
        clickCount++;
      },
      { timeoutMs: 300, pollIntervalMs: 50, surfaceName: "NTP Create Dialog" },
    );
  } catch (e) {
    caughtError = e as Error;
  }

  assert(caughtError !== null, "must throw when app never becomes ready");
  assert(
    caughtError.message.startsWith(APP_NEVER_BECAME_READY),
    `error must start with named failure '${APP_NEVER_BECAME_READY}', got: '${caughtError.message}'`,
  );
  assert(
    caughtError.message.includes("NTP Create Dialog"),
    `error must name the unready surface, got: '${caughtError.message}'`,
  );
  assertEquals(clickCount, 0, "must NOT execute premature click when readiness times out");
  assert(probeCount > 0, "probed readiness multiple times before timing out");
});

Deno.test("iksuc: waitForAppReady handles evaluator exceptions gracefully during polling", async () => {
  let attempts = 0;
  const evaluate = async (_expr: string) => {
    attempts++;
    if (attempts === 1) throw new Error("CDP context destroyed during navigation");
    if (attempts === 2) return null;
    return { ready: true, signal: "ntp-hydrated" };
  };

  const res = await waitForAppReady(evaluate, { timeoutMs: 1000, pollIntervalMs: 30 });
  assertEquals(res.ready, true);
  assertEquals(res.signal, "ntp-hydrated");
});

Deno.test("iksuc: clickVisibleCreateAgent with { waitForReady: true } refuses unready target with named failure", async () => {
  const sent: any[] = [];
  const cdp = {
    send: async (method: string, params: any, session: string) => {
      sent.push({ method, params, session });
    },
  };

  // Evaluator reports unready page
  const evaluate = async (expr: string) => {
    if (expr.includes("jobs-board") || expr.includes("APP_READY_ATTR")) {
      return { ready: false, readyState: "loading" };
    }
    return { ok: true, x: 50, y: 50 };
  };

  await assertRejects(
    () => clickVisibleCreateAgent(cdp, "test-session", evaluate, { waitForReady: true, timeoutMs: 250 }),
    Error,
    APP_NEVER_BECAME_READY,
  );

  assertEquals(sent.length, 0, "zero mouse clicks dispatched when readiness check fails");
});

Deno.test("iksuc / pew31 / w7mv6: waitForAppReady bounds wait and fails closed when evaluator stalls or never resolves", async () => {
  // Evaluator that hangs indefinitely
  const evaluate = () => new Promise(() => {});
  const timers = fakeTimers();
  let caught: Error | null = null;
  const startedAt = timers.now();
  try {
    await onFakeClock(
      () => waitForAppReady(evaluate, { timeoutMs: 300, probeTimeoutMs: 100, pollIntervalMs: 20, timers }),
      timers,
    );
  } catch (e) {
    caught = e as Error;
  }
  const elapsed = timers.now() - startedAt;

  assert(caught !== null, "must time out when evaluator hangs");
  assert(
    isTransportOrEvaluateTimeoutError(caught),
    `must match isTransportOrEvaluateTimeoutError to fail fast, got: ${caught.message}`,
  );
  // w7mv6: probe timeout must NOT match isCdpEvaluateTimeout so caller does not exit 75 environmental
  assertEquals(
    isCdpEvaluateTimeout(caught.message),
    false,
    "probe timeout must NOT match isCdpEvaluateTimeout (must preserve distinct probe provenance)",
  );
  assert(
    !caught.message.startsWith(APP_NEVER_BECAME_READY),
    `must NOT launder into app never became ready, got: ${caught.message}`,
  );
  assert(
    /probe evaluation timed out after \d+ms/.test(caught.message),
    `must report distinct probe timeout message, got: ${caught.message}`,
  );
  assert(elapsed >= 250 && elapsed < 550, `must wait across timeoutMs budget (elapsed: ${elapsed}ms)`);
});

Deno.test("p2aki: transient probe timeout retries within caller timeoutMs budget and succeeds when subsequent probe settles", async () => {
  let probeCalls = 0;
  // Evaluator where call 1 times out (takes 100ms with probeTimeoutMs=40), but call 2 settles in 10ms with {ready: true}
  const timers = fakeTimers();
  const evaluate = (_expr: string) => {
    probeCalls++;
    if (probeCalls === 1) {
      return new Promise((resolve) => {
        timers.setTimeout(() => resolve({ ready: false }), 120);
      });
    }
    return new Promise((resolve) => {
      timers.setTimeout(() => resolve({ ready: true, signal: "ntp-hydrated" }), 10);
    });
  };

  const startedAt = timers.now();
  const res = await onFakeClock(
    () => waitForAppReady(evaluate, {
      timeoutMs: 600,
      probeTimeoutMs: 40,
      pollIntervalMs: 15,
      surfaceName: "NTP main",
      timers,
    }),
    timers,
  );
  const elapsed = timers.now() - startedAt;

  assertEquals(res.ready, true);
  assertEquals(res.signal, "ntp-hydrated");
  assertEquals(probeCalls, 2, "must retry on second probe after first probe timed out");
  assert(elapsed >= 40 && elapsed < 400, `must succeed promptly once second probe settles (elapsed: ${elapsed}ms)`);
});

Deno.test("p2aki / pew31 / w7mv6: persistent hung probe exhausts timeoutMs budget and throws distinct probe timeout provenance", async () => {
  let probeCalls = 0;

  // Evaluator that hangs on every call
  const timers = fakeTimers();
  const evaluate = (_expr: string) => {
    probeCalls++;
    return new Promise((_, reject) => {
      timers.setTimeout(() => {
        reject(new Error("cdp timeout: Runtime.evaluate (requestId=99, targetId=page-1)"));
      }, 150);
    });
  };

  let caught: any = null;
  const startedAt = timers.now();
  try {
    await onFakeClock(
      () => waitForAppReady(evaluate, {
        timeoutMs: 180,
        probeTimeoutMs: 50,
        pollIntervalMs: 15,
        surfaceName: "NTP main",
        timers,
      }),
      timers,
    );
  } catch (e) {
    caught = e;
  }
  const elapsed = timers.now() - startedAt;

  assert(caught !== null, "must throw when evaluator hangs");
  // 2y6fr: on a driven clock this is exact — with timeoutMs 180, probeTimeoutMs 50 and
  // pollIntervalMs 15 the loop probes at t=0, 65 and 130, so fewer probes would mean the
  // retry path was skipped, which is the regression this pins.
  assertEquals(probeCalls, 3, `must poll on every iteration within timeoutMs budget (got ${probeCalls} calls)`);
  assert(elapsed >= 180 && elapsed < 350, `must exhaust the timeoutMs budget (took ${elapsed}ms)`);
  assert(
    isTransportOrEvaluateTimeoutError(caught),
    `must match isTransportOrEvaluateTimeoutError, got: ${caught.message}`,
  );
  // w7mv6: probe evaluation timed out must NOT match isCdpEvaluateTimeout so a hung SW is a product red (exit 1)
  // and cannot exit 75 (environmental refusal) even if the box measures loaded.
  assertEquals(
    isCdpEvaluateTimeout(caught.message),
    false,
    "must NOT match isCdpEvaluateTimeout so caller's environmental branch does not trigger",
  );
  assert(
    !caught.message.startsWith(APP_NEVER_BECAME_READY),
    `must NOT launder into app never became ready, got: ${caught.message}`,
  );
  assert(
    /^probe evaluation timed out after \d+ms for NTP main$/.test(caught.message),
    `must preserve distinct probe timeout provenance without forging cdp timeout: Runtime.evaluate, got: ${caught.message}`,
  );
});

Deno.test("pew31 / w7mv6: actual CDP Runtime.evaluate timeout propagates with full CDP evaluate provenance", async () => {
  // Evaluator rejects with actual CDP evaluate timeout (e.g. 15s Cdp.send budget)
  const actualCdpTimeout = new Error("cdp timeout: Runtime.evaluate (requestId=99, targetId=page-1, sessionId=sess-1)");
  let probeCalls = 0;
  const evaluate = (_expr: string) => {
    probeCalls++;
    return Promise.reject(actualCdpTimeout);
  };

  let caught: any = null;
  try {
    await waitForAppReady(evaluate, { timeoutMs: 1000, probeTimeoutMs: 500, surfaceName: "NTP main" });
  } catch (e) {
    caught = e;
  }

  assert(caught !== null, "must throw when evaluator rejects");
  assertEquals(probeCalls, 1);
  assertEquals(caught, actualCdpTimeout, "must rethrow exact actual CDP timeout without wrapping");
  assert(
    isTransportOrEvaluateTimeoutError(caught),
    "actual CDP timeout must match isTransportOrEvaluateTimeoutError",
  );
  assertEquals(
    isCdpEvaluateTimeout(caught.message),
    true,
    "actual CDP timeout MUST match isCdpEvaluateTimeout so caller's environmental branch can measure the box",
  );
});

Deno.test("iksuc: APP_READY_EXPRESSION evaluates NTP DOM readiness accurately", () => {
  // Mock document and location environment
  const runExpression = (mockWindow: any) => {
    const fn = new Function("window", "document", "location", "customElements", `return ${APP_READY_EXPRESSION}`);
    return fn(mockWindow, mockWindow.document, mockWindow.location, mockWindow.customElements);
  };

  // Unhydrated NTP (stage2B jobs-board not mounted yet)
  const unhydratedNtp = {
    location: { pathname: "/ntp/ntp.html" },
    document: {
      readyState: "interactive",
      documentElement: {},
      querySelector: (sel: string) => {
        if (sel === "#named-agents") return { children: [] };
        return null;
      },
      getElementById: () => null,
    },
  };
  const unreadyRes = runExpression(unhydratedNtp);
  assertEquals(unreadyRes.ready, false);
  assertEquals(unreadyRes.reason, "ntp hydration pending");

  // Hydrated NTP (jobs-board mounted in stage2B and named-agents has children)
  const hydratedNtp = {
    location: { pathname: "/ntp/ntp.html" },
    document: {
      readyState: "complete",
      documentElement: {},
      querySelector: (sel: string) => {
        if (sel === "#jobs-board-host jobs-board") return {};
        if (sel === "#named-agents") return { children: [{ id: "add-starter-agents" }] };
        return null;
      },
      getElementById: () => null,
    },
  };
  const readyRes = runExpression(hydratedNtp);
  assertEquals(readyRes.ready, true);
  assertEquals(readyRes.signal, "ntp-hydrated");
});

Deno.test("iksuc: APP_READY_EXPRESSION evaluates Sidepanel DOM readiness accurately", () => {
  const runExpression = (mockWindow: any) => {
    const fn = new Function("window", "document", "location", "customElements", `return ${APP_READY_EXPRESSION}`);
    return fn(mockWindow, mockWindow.document, mockWindow.location, mockWindow.customElements);
  };

  // Unhydrated Sidepanel (customElements not defined or elements missing)
  const unhydratedSidepanel = {
    location: { pathname: "/sidepanel/sidepanel.html" },
    document: {
      readyState: "interactive",
      documentElement: {},
      getElementById: () => null,
      querySelector: () => null,
    },
    customElements: {
      get: () => null,
    },
  };
  const unreadyRes = runExpression(unhydratedSidepanel);
  assertEquals(unreadyRes.ready, false);
  assertEquals(unreadyRes.reason, "sidepanel hydration pending");

  // Hydrated Sidepanel with real composer ID (#page-composer) and custom elements
  const hydratedSidepanel = {
    location: { pathname: "/sidepanel/sidepanel.html" },
    document: {
      readyState: "complete",
      documentElement: {},
      getElementById: (id: string) => {
        if (id === "page-composer") return { tagName: "AGENT-COMPOSER" };
        if (id === "tab-agents") return { tagName: "BUTTON" };
        return null;
      },
      querySelector: (sel: string) => (sel === "agent-composer" ? { id: "page-composer" } : null),
    },
    customElements: {
      get: (tag: string) => (tag === "agent-composer" || tag === "agent-picker" ? {} : null),
    },
  };
  const res = runExpression(hydratedSidepanel);
  assertEquals(res.ready, true);
  assertEquals(res.signal, "sidepanel-hydrated");
});

Deno.test("u7p0b: waitForAppReady propagates cdp evaluate timeout without laundering into app-never-became-ready", async () => {
  // Evaluator rejects with standard CDP evaluate timeout
  const timeoutError = new Error("cdp timeout: Runtime.evaluate exceeded 30000ms");
  const evaluate = async (_expr: string) => {
    throw timeoutError;
  };

  let caught: any = null;
  try {
    await waitForAppReady(evaluate, { timeoutMs: 1000, pollIntervalMs: 20 });
  } catch (e) {
    caught = e;
  }

  assert(caught !== null, "must throw when evaluator fails");
  assertEquals(caught, timeoutError, "must rethrow the exact evaluate timeout error without laundering");
  assert(
    isCdpEvaluateTimeout(caught.message),
    "the escaped error must be classified by isCdpEvaluateTimeout in the journey catch",
  );
  assert(
    !caught.message.startsWith(APP_NEVER_BECAME_READY),
    "must NOT replace CDP timeout with app-never-became-ready",
  );
});

Deno.test("u7p0b: waitForAppReady propagates CdpEvaluateLoadTimeoutError and CdpEvaluateIdleTimeoutError with verdict preserved", async () => {
  const dummyVerdict: EvaluateTimeoutVerdict = {
    cause: "loaded",
    environmental: true,
    reason: "heavy rustc compilation under test",
    environment: "load/core 3.5, activeCompilers 2",
    sample: null,
  };

  const loadError = new CdpEvaluateLoadTimeoutError("Runtime.evaluate", dummyVerdict, 1000, 3000);
  const evaluateLoad = async (_expr: string) => {
    throw loadError;
  };

  let caughtLoad: any = null;
  try {
    await waitForAppReady(evaluateLoad, { timeoutMs: 1000, pollIntervalMs: 20 });
  } catch (e) {
    caughtLoad = e;
  }

  assert(caughtLoad instanceof CdpEvaluateLoadTimeoutError, "must propagate CdpEvaluateLoadTimeoutError");
  assertEquals(caughtLoad.verdict.cause, "loaded");
  assertEquals(caughtLoad.totalTimeoutMs, 3000);

  const idleVerdict: EvaluateTimeoutVerdict = {
    cause: "idle-never-settled",
    environmental: false,
    reason: "service worker deadlocked while box idle",
    environment: "load/core 0.1, activeCompilers 0",
    sample: null,
  };
  const idleError = new CdpEvaluateIdleTimeoutError("Runtime.evaluate", idleVerdict, 1000);
  const evaluateIdle = async (_expr: string) => {
    throw idleError;
  };

  let caughtIdle: any = null;
  try {
    await waitForAppReady(evaluateIdle, { timeoutMs: 1000, pollIntervalMs: 20 });
  } catch (e) {
    caughtIdle = e;
  }

  assert(caughtIdle instanceof CdpEvaluateIdleTimeoutError, "must propagate CdpEvaluateIdleTimeoutError");
  assertEquals(caughtIdle.verdict.cause, "idle-never-settled");
});

Deno.test("u7p0b: waitForAppReady propagates CDP transport disconnect errors immediately", async () => {
  const disconnectError = new Error("Protocol error: Target closed");
  let callCount = 0;
  const evaluate = async (_expr: string) => {
    callCount++;
    throw disconnectError;
  };

  let caught: any = null;
  const start = Date.now();
  try {
    await waitForAppReady(evaluate, { timeoutMs: 5000, pollIntervalMs: 50 });
  } catch (e) {
    caught = e;
  }
  const elapsed = Date.now() - start;

  assertEquals(caught, disconnectError, "must rethrow transport disconnect immediately");
  assertEquals(callCount, 1, "must NOT retry across a closed target/session");
  assert(elapsed < 500, `must fail fast on disconnect (took ${elapsed}ms)`);
});

Deno.test("p2aki: compound transport error mentioning probe timeout still fails fast by reference identity", async () => {
  const compoundTransportError = new Error("Protocol error: Target closed (probe evaluation timed out during evaluate)");
  let callCount = 0;
  const evaluate = async (_expr: string) => {
    callCount++;
    throw compoundTransportError;
  };

  let caught: any = null;
  const start = Date.now();
  try {
    await waitForAppReady(evaluate, { timeoutMs: 3000, probeTimeoutMs: 100, pollIntervalMs: 20 });
  } catch (e) {
    caught = e;
  }
  const elapsed = Date.now() - start;

  assertEquals(caught, compoundTransportError, "must rethrow compound transport error immediately");
  assertEquals(callCount, 1, "must NOT retry across a closed transport despite compound message");
  assert(elapsed < 200, `must fail fast on transport error (took ${elapsed}ms)`);
});

Deno.test("u7p0b: waitForAppReady still reports named app-never-became-ready on genuine DOM unreadiness", async () => {
  // Evaluator returns unready DOM response
  const evaluate = async (_expr: string) => ({ ready: false, reason: "still mounting stage2B" });

  let caught: any = null;
  try {
    await waitForAppReady(evaluate, { timeoutMs: 200, pollIntervalMs: 30, surfaceName: "Test Page" });
  } catch (e) {
    caught = e;
  }

  assert(caught !== null);
  assert(
    caught.message.startsWith(APP_NEVER_BECAME_READY),
    `must report named failure '${APP_NEVER_BECAME_READY}', got: '${caught.message}'`,
  );
  assert(caught.message.includes("Test Page"));
  assert(caught.message.includes("still mounting stage2B"));
});

Deno.test("z4tzw: APP_READY_EXPRESSION refuses static unhydrated Options DOM (reproducing the gap)", () => {
  const runExpression = (mockWindow: any) => {
    const fn = new Function("window", "document", "location", "customElements", `return ${APP_READY_EXPRESSION}`);
    return fn(mockWindow, mockWindow.document, mockWindow.location, mockWindow.customElements);
  };

  // Reproduction from bead z4tzw:
  // Static options.html has loaded (readyState: complete) and has static sidebar nav header buttons.
  // Neither settings-form nor board-deny-agent has been hydrated yet.
  const staticUnhydratedOptions = {
    location: { pathname: "/options/options.html", hash: "#board-permissions" },
    document: {
      readyState: "complete",
      documentElement: {},
      getElementById: (id: string) => null,
      querySelector: (sel: string) => {
        if (sel === "input, select, button") {
          // Static nav header button in options.html <aside class="side">
          return { tagName: "BUTTON", className: "nav-group-header" };
        }
        return null;
      },
      querySelectorAll: () => [],
    },
  };

  const unreadyRes = runExpression(staticUnhydratedOptions);
  assertEquals(unreadyRes.ready, false, "must NOT certify unhydrated Options DOM ready just because static buttons exist");
  assertEquals(unreadyRes.reason, "options board permissions hydration pending");
  assertEquals(unreadyRes.agentSelect, false);
  assertEquals(unreadyRes.addBtn, false);
});

Deno.test("z4tzw: APP_READY_EXPRESSION certifies Options board-permissions once controls and providers hydrate", () => {
  const runExpression = (mockWindow: any) => {
    const fn = new Function("window", "document", "location", "customElements", `return ${APP_READY_EXPRESSION}`);
    return fn(mockWindow, mockWindow.document, mockWindow.location, mockWindow.customElements);
  };

  // 1. Controls present with real <provider-select> default (providers: []) before populateBoardDenyAgents runs
  const unpopulatedBoard = {
    location: { pathname: "/options/options.html", hash: "#board-permissions" },
    document: {
      readyState: "complete",
      documentElement: {},
      getElementById: (id: string) => {
        if (id === "board-permissions") return { classList: { contains: (c: string) => c === "active" }, dataset: { active: "true" } };
        // Real <provider-select>.providers getter returns [] when unpopulated (kki80)
        if (id === "board-deny-agent") return { tagName: "PROVIDER-SELECT", id: "board-deny-agent", providers: [] };
        if (id === "board-deny-add-btn") return { tagName: "BUTTON", id: "board-deny-add-btn" };
        return null;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    },
  };
  const unpopRes = runExpression(unpopulatedBoard);
  assertEquals(unpopRes.ready, false);
  assertEquals(unpopRes.reason, "options board permissions hydration pending");
  assertEquals(unpopRes.providersHydrated, false);

  // 2. Fully hydrated board-permissions (panel active, controls present, providers array populated)
  const hydratedBoard = {
    location: { pathname: "/options/options.html", hash: "#board-permissions" },
    document: {
      readyState: "complete",
      documentElement: {},
      getElementById: (id: string) => {
        if (id === "board-permissions") return { classList: { contains: (c: string) => c === "active" }, dataset: { active: "true" } };
        if (id === "board-deny-agent") return {
          tagName: "PROVIDER-SELECT",
          id: "board-deny-agent",
          providers: [{ id: "hub", name: "Hub", icon: "terminal" }],
        };
        if (id === "board-deny-add-btn") return { tagName: "BUTTON", id: "board-deny-add-btn" };
        return null;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    },
  };
  const readyRes = runExpression(hydratedBoard);
  assertEquals(readyRes.ready, true);
  assertEquals(readyRes.signal, "options-hydrated");
});

Deno.test("z4tzw: APP_READY_EXPRESSION tests default providers section hydration against rendered cards", () => {
  const runExpression = (mockWindow: any) => {
    const fn = new Function("window", "document", "location", "customElements", `return ${APP_READY_EXPRESSION}`);
    return fn(mockWindow, mockWindow.document, mockWindow.location, mockWindow.customElements);
  };

  // Unhydrated providers (static divs empty)
  const unhydratedProviders = {
    location: { pathname: "/options/options.html", hash: "" },
    document: {
      readyState: "complete",
      documentElement: {},
      getElementById: (id: string) => {
        if (id === "providers") return { classList: { contains: (c: string) => c === "active" }, dataset: { active: "true" } };
        return null;
      },
      querySelector: (sel: string) => {
        if (sel === "#provider-panels") return { children: [] };
        return null;
      },
      querySelectorAll: () => [],
    },
  };
  const unreadyRes = runExpression(unhydratedProviders);
  assertEquals(unreadyRes.ready, false);
  assertEquals(unreadyRes.reason, "options providers hydration pending");

  // Error/retry state: provider-panels has retry button, no .provider-card (97qd6)
  const errorProviders = {
    location: { pathname: "/options/options.html", hash: "#providers" },
    document: {
      readyState: "complete",
      documentElement: {},
      getElementById: (id: string) => {
        if (id === "providers") return { classList: { contains: (c: string) => c === "active" }, dataset: { active: "true" } };
        return null;
      },
      querySelector: (sel: string) => {
        if (sel === "#provider-panels") return { children: [{ id: "retry-providers" }] };
        return null;
      },
      querySelectorAll: (sel: string) => {
        // No .provider-card elements rendered in error state
        return [];
      },
    },
  };
  const errorRes = runExpression(errorProviders);
  assertEquals(errorRes.ready, false, "error/retry state must NOT certify readiness as cards");
  assertEquals(errorRes.reason, "options providers hydration pending");

  // Hydrated providers (rendered cards in provider-panels)
  const hydratedProviders = {
    location: { pathname: "/options/options.html", hash: "#providers" },
    document: {
      readyState: "complete",
      documentElement: {},
      getElementById: (id: string) => {
        if (id === "providers") return { classList: { contains: (c: string) => c === "active" }, dataset: { active: "true" } };
        return null;
      },
      querySelector: (sel: string) => {
        if (sel === "#provider-panels") return { children: [{ id: "panel-gemini" }] };
        return null;
      },
      querySelectorAll: (sel: string) => {
        if (sel.includes(".provider-card")) return [{ id: "gemini-card" }];
        return [];
      },
    },
  };
  const readyRes = runExpression(hydratedProviders);
  assertEquals(readyRes.ready, true);
  assertEquals(readyRes.signal, "options-hydrated");
});

// ---------------------------------------------------------------------------
// dnqyt: the readiness budget is a NO-PROGRESS bound, not a stopwatch on the whole wait.
//
// Measured on this VM with the real extension (scratch probe, not committed): NTP hydration
// reports `jobsBoard` at ~3.8s and `namedHydrated` at ~7.2s on an idle box; with six competing
// busy loops the same two steps land at ~6.2s and ~12.3s. A fixed 10s budget therefore reds a
// page that is hydrating perfectly well, and that is exactly the w51r:397 full-gate red. These
// tests replay the LOADED trace on a driven clock, so they are the same measurement every run.
// ---------------------------------------------------------------------------
const LOADED_NTP_TRACE = (nowMs: number) => {
  if (nowMs >= 12300) return { ready: true, signal: "ntp-hydrated" };
  if (nowMs >= 6200) {
    return { ready: false, reason: "ntp hydration pending", jobsBoard: true, namedHydrated: false };
  }
  return { ready: false, reason: "ntp hydration pending", jobsBoard: false, namedHydrated: false };
};

Deno.test("dnqyt: a slow-but-hydrating NTP page passes past the old fixed 10s stopwatch (loaded trace)", async () => {
  const timers = fakeTimers();
  const startedAt = timers.now();
  const res = await onFakeClock(
    () => waitForAppReady(() => Promise.resolve(LOADED_NTP_TRACE(timers.now())), {
      timeoutMs: 10000,
      pollIntervalMs: 100,
      surfaceName: "NTP Hub",
      timers,
    }),
    timers,
  );
  const elapsed = timers.now() - startedAt;

  assertEquals(res.ready, true);
  assertEquals(res.signal, "ntp-hydrated");
  assert(elapsed >= 12300, `the hydrated-in-12.3s trace must not fail at 10000ms (took ${elapsed}ms)`);
  assert(elapsed < 12600, `must proceed as soon as hydration is observed (took ${elapsed}ms)`);
});

Deno.test("dnqyt: a never-hydrating page still fails closed after ONE no-progress window, not the cap", async () => {
  const timers = fakeTimers();
  // The falsifier that must survive: a page whose readiness state never advances is NOT
  // excused by the progress rule — it reds after a single no-progress window.
  const evaluate = () =>
    Promise.resolve({ ready: false, reason: "ntp hydration pending", jobsBoard: true, namedHydrated: false });

  let caught: any = null;
  const startedAt = timers.now();
  try {
    await onFakeClock(
      () => waitForAppReady(evaluate, { timeoutMs: 8000, maxTotalMs: 100000, pollIntervalMs: 200, surfaceName: "NTP Hub", timers }),
      timers,
    );
  } catch (e) {
    caught = e;
  }
  const elapsed = timers.now() - startedAt;

  assert(caught !== null, "must fail closed when readiness never advances");
  assert(caught.message.startsWith(APP_NEVER_BECAME_READY), `named failure expected, got: ${caught.message}`);
  assert(caught.message.includes("NTP Hub"), `must name the surface, got: ${caught.message}`);
  assert(elapsed >= 8000 && elapsed < 8600, `must stop after one 8000ms window, not the 100000ms cap (took ${elapsed}ms)`);
});

Deno.test("dnqyt: a page that flaps between two unready states terminates at the hard cap", async () => {
  const timers = fakeTimers();
  // Progress that never becomes readiness must not buy an unbounded wait.
  let probe = 0;
  const evaluate = () =>
    Promise.resolve({ ready: false, reason: "ntp hydration pending", jobsBoard: (probe++ % 2) === 0, namedHydrated: false });

  let caught: any = null;
  const startedAt = timers.now();
  try {
    await onFakeClock(
      () => waitForAppReady(evaluate, { timeoutMs: 5000, maxTotalMs: 20000, pollIntervalMs: 100, surfaceName: "NTP Hub", timers }),
      timers,
    );
  } catch (e) {
    caught = e;
  }
  const elapsed = timers.now() - startedAt;

  assert(caught !== null, "must fail closed rather than wait forever");
  assert(caught.message.startsWith(APP_NEVER_BECAME_READY), `named failure expected, got: ${caught.message}`);
  assert(elapsed >= 20000 && elapsed < 20500, `must stop at the 20000ms cap (took ${elapsed}ms)`);
});

Deno.test("dnqyt: the probe trace records each observation and which ones advanced", async () => {
  const timers = fakeTimers();
  const events: Array<{ atMs: number; advanced: boolean; probe: any }> = [];
  await onFakeClock(
    () => waitForAppReady(() => Promise.resolve(LOADED_NTP_TRACE(timers.now())), {
      timeoutMs: 10000,
      pollIntervalMs: 100,
      surfaceName: "NTP Hub",
      timers,
      onProbe: (e) => events.push({ atMs: e.atMs, advanced: e.advanced, probe: e.probe }),
    }),
    timers,
  );

  assert(events.length >= 3, `every observation must be traced (got ${events.length})`);
  assertEquals(events[0].advanced, false, "the first probe is the baseline, not progress");
  const advances = events.filter((e) => e.advanced);
  assertEquals(advances.length, 2, `exactly the two hydration steps count as progress (got ${advances.length})`);
  assert(advances[0].atMs >= 6200, `first advance is observed at the jobsBoard step (got ${advances[0].atMs}ms)`);
  assert(advances[1].atMs >= 12300, `second advance is the ready step (got ${advances[1].atMs}ms)`);
  assertEquals(events[events.length - 1].probe.ready, true, "the trace ends on the ready observation");
});
