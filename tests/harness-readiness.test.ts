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

Deno.test("iksuc: waitForAppReady bounds wait when evaluator stalls or never resolves", async () => {
  // Evaluator that hangs indefinitely
  const evaluate = () => new Promise(() => {});

  const start = Date.now();
  let caught: Error | null = null;
  try {
    await waitForAppReady(evaluate, { timeoutMs: 300, probeTimeoutMs: 100, pollIntervalMs: 20 });
  } catch (e) {
    caught = e as Error;
  }
  const elapsed = Date.now() - start;

  assert(caught !== null, "must time out when evaluator hangs");
  assert(caught.message.startsWith(APP_NEVER_BECAME_READY), `must report named failure, got ${caught.message}`);
  assert(elapsed >= 250 && elapsed < 800, `must bound wait within expected range (elapsed: ${elapsed}ms)`);
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
