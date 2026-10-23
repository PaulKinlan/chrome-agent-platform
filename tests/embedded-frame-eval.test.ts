import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isMissingCdpContext, trackEmbeddedFrameContexts } from "../scripts/lib/embedded-frame-eval.ts";
import { classifyReadyMarkerTimeout, measuredReadyLoad } from "../scripts/lib/serial-phase.mjs";

// chrome-agent-platform-h6ow3: the readiness bound these cases declare is a DEADLINE, and a starved box
// spends it on the poll interval rather than on the tracker's work: `nextChange` sleeps up to 120 ms per
// iteration, so a 500 ms budget is only ~4 iterations when the scheduler is late, and the complete gate
// redded here (f7ff6cca9) with 'unavailable before 500ms (frame=seen, staleRetries=1, probeStale=1,
// observed=null)' — i.e. the deadline expired between two instant fake probes. The readiness cases
// therefore declare the bound the same way every other ready-marker bound in this repo is declared
// (kzy5x/whl7d): base x ABSOLUTE load, x4 cap, measured at the deadline rather than assumed for the box.
const READY_BOUND_BASE_MS = 500;
function readyBoundMs(load?: number): number {
  return classifyReadyMarkerTimeout({
    baseMs: READY_BOUND_BASE_MS,
    loadPerCpu: load ?? measuredReadyLoad(),
  }).hardTimeoutMs;
}

const URL = "chrome-extension://abcdef/options/options.html";
const SESSION = "ntp-page-session";
const CREATED = (id: number) => ({ context: { id, auxData: { frameId: "settings-frame", isDefault: true } } });

function fakeCdp(onEvaluate: (id: number, expression: string) => Promise<any> | any) {
  const handlers = new Map<string, Set<(event: any, session?: string) => void>>();
  const calls: Array<{ method: string; session?: string; contextId?: number; expression?: string }> = [];
  const cdp = {
    calls,
    on(method: string, handler: (event: any, session?: string) => void) {
      if (!handlers.has(method)) handlers.set(method, new Set());
      handlers.get(method)!.add(handler);
      return () => handlers.get(method)!.delete(handler);
    },
    emit(method: string, event: any, session = SESSION) {
      for (const handler of handlers.get(method) ?? []) handler(event, session);
    },
    async send(method: string, params: any, session?: string) {
      calls.push({ method, session, contextId: params?.contextId, expression: params?.expression });
      if (method === "Page.getFrameTree") return {
        result: { frameTree: { childFrames: [{ frame: { id: "settings-frame", url: URL } }] } },
      };
      if (method !== "Runtime.evaluate") throw new Error(`unexpected method: ${method}`);
      return onEvaluate(params.contextId, params.expression);
    },
  };
  return cdp;
}
const ready = { result: { result: { value: { url: URL, ready: "complete" } } } };
const ownerDecision = { result: { result: { value: { ok: true, decision: "denied" } } } };

Deno.test("live-frame tracker skips destroyed/default contexts and scopes lookup to the NTP session", async () => {
  const cdp = fakeCdp(async (id, expr) => expr.includes("document.URL") ? ready : ownerDecision);
  const tracker = trackEmbeddedFrameContexts(cdp, SESSION);
  try {
    cdp.emit("Runtime.executionContextCreated", CREATED(2), "other-tab-session");
    cdp.emit("Runtime.executionContextCreated", CREATED(3));
    cdp.emit("Runtime.executionContextCreated", CREATED(4));
    cdp.emit("Runtime.executionContextDestroyed", { executionContextId: 3 });
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: readyBoundMs() });
    assertEquals(answer.result, ownerDecision);
    assertEquals(answer.staleRetries, 0);
    assertEquals(cdp.calls.filter((call) => call.method === "Runtime.evaluate").map((call) => call.contextId), [4, 4]);
    assert(cdp.calls.every((call) => call.session === SESSION), "never address browser-root or another page");
  } finally { tracker.close(); }
});

Deno.test("live-frame tracker retries ONLY a missing context with a newer default context after navigation", async () => {
  let cdp: ReturnType<typeof fakeCdp>;
  cdp = fakeCdp(async (id, expression) => {
    if (id === 6) {
      cdp.emit("Runtime.executionContextDestroyed", { executionContextId: 6 });
      cdp.emit("Runtime.executionContextCreated", CREATED(7));
      throw new Error("Runtime.evaluate: Cannot find context with specified id");
    }
    return expression.includes("document.URL") ? ready : ownerDecision;
  });
  const tracker = trackEmbeddedFrameContexts(cdp, SESSION);
  try {
    cdp.emit("Runtime.executionContextCreated", CREATED(6));
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: readyBoundMs() });
    assertEquals(answer.staleRetries, 1);
    assertEquals(cdp.calls.filter((call) => call.method === "Runtime.evaluate").map((call) => call.contextId), [6, 7, 7]);
  } finally { tracker.close(); }
});

Deno.test("live-frame tracker retries a missing context at the actual owner operation only after reattaching to the new document", async () => {
  let cdp: ReturnType<typeof fakeCdp>;
  cdp = fakeCdp(async (id, expression) => {
    if (id === 11 && !expression.includes("document.URL")) {
      cdp.emit("Runtime.executionContextDestroyed", { executionContextId: 11 });
      cdp.emit("Runtime.executionContextCreated", CREATED(12));
      throw new Error("Runtime.evaluate: Cannot find context with specified id");
    }
    return expression.includes("document.URL") ? ready : ownerDecision;
  });
  const tracker = trackEmbeddedFrameContexts(cdp, SESSION);
  try {
    cdp.emit("Runtime.executionContextCreated", CREATED(11));
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: readyBoundMs() });
    assertEquals(answer.staleRetries, 1);
    assertEquals(cdp.calls.filter((call) => call.method === "Runtime.evaluate").map((call) => call.contextId), [11, 11, 12, 12]);
    assertEquals(answer.result, ownerDecision);
  } finally { tracker.close(); }
});

Deno.test("live-frame tracker rechecks document URL/readiness before owner operation, then survives contextsCleared", async () => {
  let cdp: ReturnType<typeof fakeCdp>;
  let initialProbe = true;
  cdp = fakeCdp(async (id, expression) => {
    if (expression.includes("document.URL") && initialProbe) {
      initialProbe = false;
      cdp.emit("Runtime.executionContextsCleared", {});
      cdp.emit("Runtime.executionContextCreated", CREATED(9));
      return { result: { result: { value: { url: "about:blank", ready: "loading" } } } };
    }
    return expression.includes("document.URL") ? ready : ownerDecision;
  });
  const tracker = trackEmbeddedFrameContexts(cdp, SESSION);
  try {
    cdp.emit("Runtime.executionContextCreated", CREATED(8));
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: readyBoundMs() });
    assertEquals(answer.staleRetries, 0);
    assertEquals(cdp.calls.filter((call) => call.method === "Runtime.evaluate").map((call) => call.contextId), [8, 9, 9]);
    assertEquals(answer.result, ownerDecision);
  } finally { tracker.close(); }
});

Deno.test("live-frame tracker does NOT replay a mutation after a generic timeout or destroyed-during-operation error", async () => {
  for (const errorText of ["Runtime.evaluate: timed out", "Runtime.evaluate: Execution context was destroyed"]) {
    const cdp = fakeCdp(async (_id, expression) => {
      if (expression.includes("document.URL")) return ready;
      throw new Error(errorText);
    });
    const tracker = trackEmbeddedFrameContexts(cdp, SESSION);
    try {
      cdp.emit("Runtime.executionContextCreated", CREATED(10));
      await assertRejects(() => tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 500 }), Error, errorText);
      assertEquals(cdp.calls.filter((call) => call.expression === "owner-approval-request").length, 1);
    } finally { tracker.close(); }
  }
  assert(isMissingCdpContext(new Error("Runtime.evaluate: Cannot find context with specified id")));
  assert(!isMissingCdpContext(new Error("Runtime.evaluate: Execution context was destroyed")));
});

Deno.test("jm34x: probe-stage vs owner-stage stale retries are named separately, with the verified document", async () => {
  // Case 1: the default context never became addressable — the READINESS
  // probe keeps getting 'Cannot find context'.
  const probeFail = fakeCdp(async () => { throw new Error("Runtime.evaluate: Cannot find context with specified id"); });
  {
    const tracker = trackEmbeddedFrameContexts(probeFail, SESSION);
    try {
      probeFail.emit("Runtime.executionContextCreated", CREATED(50));
      const error = await assertRejects(
        () => tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 400 }),
        Error, "unavailable");
      assert(error.message.includes("probeStale="), "probe-stage retries must be named");
      assert(!error.message.includes("probeStale=0"), "case 1 has probe-stage retries");
      assert(error.message.includes("ownerStale=0"), "case 1 never reached the owner operation");
      assert(error.message.includes("verified=null"), "case 1 never verified the document");
      assertEquals(probeFail.calls.filter((c) => c.expression === "owner-approval-request").length, 0);
    } finally { tracker.close(); }
  }
  // Case 2: readiness PASSES (document verified correct) and only the OWNER
  // operation keeps losing its context.
  const ownerFail = fakeCdp(async (_id, expression) => {
    if (expression.includes("document.URL")) return ready;
    throw new Error("Runtime.evaluate: Cannot find context with specified id");
  });
  {
    const tracker = trackEmbeddedFrameContexts(ownerFail, SESSION);
    try {
      ownerFail.emit("Runtime.executionContextCreated", CREATED(51));
      const error = await assertRejects(
        () => tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 400 }),
        Error, "unavailable");
      assert(error.message.includes("probeStale=0"), "case 2's probe always succeeded");
      assert(!error.message.includes("ownerStale=0"), "case 2 has owner-stage retries");
      assert(error.message.includes(`verified="${URL}"`), "case 2 DID verify the document");
    } finally { tracker.close(); }
  }
});

Deno.test("m7vb5: the deadline error names the observed document URL and the expected URL", async () => {
  // A readiness mismatch used to read identically to 'no context ever
  // arrived' (frame=seen, staleRetries=0), which sent lanes down the wrong
  // hypothesis for hours (utfug). The terminal error must carry what the
  // probe actually saw versus what it wanted.
  const cdp = fakeCdp(async (_id, expression) => {
    if (expression.includes("document.URL")) {
      return { result: { result: { value: { url: "chrome-extension://abcdef/options/other.html", ready: "complete" } } } };
    }
    return ownerDecision;
  });
  const tracker = trackEmbeddedFrameContexts(cdp, SESSION);
  try {
    cdp.emit("Runtime.executionContextCreated", CREATED(40));
    const error = await assertRejects(
      () => tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 400 }),
      Error,
      "unavailable",
    );
    assert(error.message.includes('"chrome-extension://abcdef/options/other.html"'), "observed URL missing from the deadline error");
    assert(error.message.includes('"chrome-extension://abcdef/options/options.html"'), "expected URL missing from the deadline error");
    assert(error.message.includes('"complete"'), "observed readyState missing from the deadline error");
    assertEquals(cdp.calls.filter((call) => call.expression === "owner-approval-request").length, 0,
      "the owner operation must never run in the wrong document");
  } finally { tracker.close(); }
});

Deno.test("utfug: a section fragment on document.URL (#providers) is NOT a different document", async () => {
  // The NTP's openView appends the section hash to the pooled Settings frame
  // (options/options.html#providers); Page.getFrameTree reports it separately
  // as urlFragment, but page-side document.URL carries it. Readiness must
  // compare the DOCUMENT identity (origin+path), fragment stripped — a naive
  // === spins to the deadline with frame=seen, staleRetries=0 (the live KAT
  // failure this pins). A wrong PATH must still refuse.
  const cdp = fakeCdp(async (_id, expression) => {
    if (expression.includes("document.URL")) {
      return { result: { result: { value: { url: URL + "#providers", ready: "complete" } } } };
    }
    return ownerDecision;
  });
  const tracker = trackEmbeddedFrameContexts(cdp, SESSION);
  try {
    cdp.emit("Runtime.executionContextCreated", CREATED(20));
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: readyBoundMs() });
    assertEquals(answer.result, ownerDecision);
    assertEquals(answer.staleRetries, 0);
  } finally { tracker.close(); }
});

Deno.test("q6ad9: a tracker seeded from buffered history evaluates in a context created BEFORE subscription", async () => {
  // The journey's exact defect: the pooled Settings frame booted at an earlier
  // leg; the tracker subscribes later and NO live created event fires on
  // reopen. Without a seed this spins to the deadline (frame=seen,
  // staleRetries=0). With the transport's buffered events replayed at
  // construction, the pre-existing context is found and used.
  const cdp = fakeCdp(async (_id, expression) =>
    expression.includes("document.URL") ? ready : ownerDecision);
  const tracker = trackEmbeddedFrameContexts(cdp, SESSION, { seedEvents: [
    { sessionId: SESSION, kind: "created", id: 30, frameId: "settings-frame", isDefault: true },
  ] });
  try {
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: readyBoundMs() });
    assertEquals(answer.result, ownerDecision);
    assertEquals(answer.staleRetries, 0);
    // NO live events were emitted — the seed alone carried the context.
  } finally { tracker.close(); }
});

// h6ow3 falsifier: a box whose probes are SLOW (the scheduler is late, so each Runtime.evaluate round trip
// costs 150 ms) must not turn "the frame became ready" into a deadline red. The first arm declares the
// old flat 500 ms and reds — that is the gate failure, reproduced deterministically, without loading the
// box. The second arm declares the load-derived bound (x4 at load 8) and completes. If the derivation is
// ever flattened back to the base, the second arm reds exactly like the first.
Deno.test("h6ow3: a slow box reds a FLAT 500ms readiness bound but not the load-derived one", async () => {
  const slowCdp = () => {
    let probes = 0;
    return fakeCdp(async (_id, expression) => {
      if (!expression.includes("document.URL")) return ownerDecision;
      // The pooled frame's first realm is replaced while it navigates: the tracker must survive it.
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      // THREE slow not-ready probes: ~(150 + 120) x 2 + 150 = 690 ms of unavoidable wall time, which a
      // flat 500 ms bound cannot survive and a x4 bound can. Deterministic, and not a loading of the box.
      // "loading" is the only state the tracker refuses (interactive already counts as ready), so this
      // keeps it polling until the third probe.
      return probes >= 3
        ? ready
        : { result: { result: { value: { url: URL, ready: "loading" } } } };
    });
  };

  const flat = slowCdp();
  const flatTracker = trackEmbeddedFrameContexts(flat, SESSION);
  try {
    flat.emit("Runtime.executionContextCreated", CREATED(40));
    await assertRejects(
      () => flatTracker.evaluate({
        extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request",
        timeoutMs: READY_BOUND_BASE_MS,
      }),
      Error,
      "was unavailable before",
      "the flat bound must red on a slow box — this is the gate failure, not a flake",
    );
  } finally { flatTracker.close(); }

  const derived = slowCdp();
  const derivedTracker = trackEmbeddedFrameContexts(derived, SESSION);
  try {
    derived.emit("Runtime.executionContextCreated", CREATED(41));
    const answer = await derivedTracker.evaluate({
      extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request",
      timeoutMs: readyBoundMs(8),
    });
    assertEquals(answer.result, ownerDecision);
    assertEquals(answer.staleRetries, 0);
  } finally { derivedTracker.close(); }
});
