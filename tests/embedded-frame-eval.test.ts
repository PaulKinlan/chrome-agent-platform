import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isMissingCdpContext, trackEmbeddedFrameContexts } from "../scripts/lib/embedded-frame-eval.ts";

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
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 500 });
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
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 500 });
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
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 500 });
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
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 500 });
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

Deno.test("q6ad9: a tracker seeded from buffered history evaluates in a context created BEFORE subscription", async () => {
  // The journey's exact defect: the pooled Settings frame booted at an earlier
  // leg; the tracker subscribes later and NO live created event fires on
  // reopen. Without a seed this spins to the deadline (frame=seen,
  // staleRetries=0). With the transport's buffered events replayed at
  // construction, the pre-existing context is found and used.
  const cdp = fakeCdp(async (_id, expression) =>
    expression.includes("document.URL") ? ready : ownerDecision);
  const seedEvents = [
    { sessionId: SESSION, kind: "created", id: 30, frameId: "settings-frame", isDefault: true },
  ];
  const tracker = trackEmbeddedFrameContexts(cdp, SESSION, { seedEvents });
  try {
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 500 });
    assertEquals(answer.result, ownerDecision);
    assertEquals(answer.staleRetries, 0);
    // NO live events were emitted — the seed alone carried the context.
  } finally { tracker.close(); }
});

Deno.test("q6ad9: a seed the buffer itself marks DESTROYED is weeded, never evaluated in", async () => {
  const cdp = fakeCdp(async (_id, expression) =>
    expression.includes("document.URL") ? ready : ownerDecision);
  const seedEvents = [
    { sessionId: SESSION, kind: "created", id: 31, frameId: "settings-frame", isDefault: true },
    { sessionId: SESSION, kind: "destroyed", id: 31 },
    { sessionId: SESSION, kind: "created", id: 32, frameId: "settings-frame", isDefault: true },
  ];
  const tracker = trackEmbeddedFrameContexts(cdp, SESSION, { seedEvents });
  try {
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 500 });
    assertEquals(answer.result, ownerDecision);
    assertEquals(cdp.calls.filter((call) => call.contextId === 31).length, 0,
      "a destroyed seed must never be evaluated in");
  } finally { tracker.close(); }
});

Deno.test("q6ad9: a seeded cleared event wipes earlier created seeds for the session", async () => {
  const cdp = fakeCdp(async (_id, expression) =>
    expression.includes("document.URL") ? ready : ownerDecision);
  const seedEvents = [
    { sessionId: SESSION, kind: "created", id: 33, frameId: "settings-frame", isDefault: true },
    { sessionId: SESSION, kind: "cleared" },
    { sessionId: SESSION, kind: "created", id: 34, frameId: "settings-frame", isDefault: true },
  ];
  const tracker = trackEmbeddedFrameContexts(cdp, SESSION, { seedEvents });
  try {
    const answer = await tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 500 });
    assertEquals(answer.result, ownerDecision);
    assert(cdp.calls.every((call) => call.contextId !== 33), "the pre-clear context is stale navigation history");
  } finally { tracker.close(); }
});

Deno.test("q6ad9: without a seed, a pre-existing context is NOT invented (fail-loud preserved)", async () => {
  // The seeded path must not weaken the unseeded one: a tracker with no seed
  // and no live events still times out honestly instead of guessing.
  const cdp = fakeCdp(async (_id, expression) =>
    expression.includes("document.URL") ? ready : ownerDecision);
  const tracker = trackEmbeddedFrameContexts(cdp, SESSION);
  try {
    await assertRejects(
      () => tracker.evaluate({ extensionId: "abcdef", path: "/options/options.html", expression: "owner-approval-request", timeoutMs: 400 }),
      Error,
      "unavailable",
    );
    assertEquals(cdp.calls.filter((call) => call.expression === "owner-approval-request").length, 0);
  } finally { tracker.close(); }
});
