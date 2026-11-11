// @ts-nocheck
// tests/provider-approval-card-gating.test.ts — chrome-agent-platform-awaom
// round-4, coord finding (b).
//
// THE DEFECT. The conversation appended an ACTIVE, focusable approval card and
// only THEN fetched the staged detail (augmentApprovalCardWithDiff, fire-and-
// forget, silent on failure). For named-agent.set-provider the staged detail
// is the ONLY place the destination host exists, so an owner could click the
// opaque card before the resolved host and key-carry warning existed — or
// after the fetch failed — i.e. consent to an undisclosed host, the exact P1.
//
// THE FIX UNDER TEST.
//  - ApprovalCard gains a NON-INTERACTIVE "loading" state (no decision
//    buttons; unknown states fall back to "pending", so without the fix the
//    "loading" assertions RED on a rendered Approve button).
//  - conversation.js: a detail-gated card (named-agent.set-provider) starts in
//    "loading" BEFORE it is appended; augmentApprovalCardWithDiff flips it to
//    "pending" only after the detail renders, and to "error" (disabled, honest
//    reason, no approve path) when the detail fails; retry re-fetches the
//    DETAIL rather than exposing the bare decision.
//
// Layer 1 drives the REAL ApprovalCard class with a capturing shadow root.
// Layer 2 drives the REAL runConversationTurn (the module under test) with a
// chrome mock and a fake container, emitting the same progress-port
// "approval-request" event the service worker sends for a live in-run approval.

import { assert, assertEquals } from "jsr:@std/assert@1";

// ---------------------------------------------------------------------------
// Shared stub DOM primitives (pattern: tests/components.test.ts, but the
// shadow root CAPTURES innerHTML so rendered markup is assertable).
// ---------------------------------------------------------------------------

const registry = new Map();

class CapturingRoot {
  constructor() { this._html = ""; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  appendChild() {}
  prepend() {}
}

class StubElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag).toLowerCase();
    this._attrs = new Map();
    this.children = [];
    this.listeners = {};
    this.style = { setProperty() {} };
  }
  attachShadow() { this._root = new CapturingRoot(); return this._root; }
  setAttribute(n, v) {
    const old = this._attrs.get(n) ?? null;
    this._attrs.set(n, String(v));
    if (this._rendered && typeof this.attributeChangedCallback === "function") {
      this.attributeChangedCallback(n, old ?? null, String(v));
    }
  }
  getAttribute(n) { return this._attrs.has(n) ? this._attrs.get(n) : null; }
  hasAttribute(n) { return this._attrs.has(n); }
  removeAttribute(n) { this._attrs.delete(n); }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f); }
  dispatch(t, e = {}) { for (const f of this.listeners[t] ?? []) f(e); }
  dispatchEvent(ev) { for (const f of this.listeners[ev?.type] ?? []) f(ev); return true; }
  appendChild(k) { this.children.push(k); k.connectedCallback?.(); return k; }
  append(...kids) { this.children.push(...kids); for (const k of kids) k.connectedCallback?.(); }
  querySelector(sel) {
    // The augment guard checks for an existing artifact-diff.
    if (sel === "artifact-diff") return this.children.find((k) => k.localName === "artifact-diff") ?? null;
    return null;
  }
  focusApprove() {}
  focusRetry() {}
  focusStatus() {}
  get isConnected() { return true; }
}

globalThis.HTMLElement = StubElement;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? null; }
};

// The DOM document is installed at MODULE SCOPE and never restored: the
// approval-detail fetch resolves asynchronously, AFTER the driving helper has
// returned, so a try/finally restore would make the continuation's
// `typeof document === "undefined"` fail-closed check fire spuriously (that
// exact check is part of the fix under test — keep the harness honest).

const fakeDocument = {
  createElement: (tag) => {
    const name = String(tag).toLowerCase();
    const Cls = registry.get(name);
    const el = Cls ? new Cls() : new StubElement(name);
    // The real DOM stamps the tag onto a customised built-in at upgrade time;
    // the stub must too, or registry-instantiated components have no name.
    el.localName = name;
    el.tagName = name.toUpperCase();
    return el;
  },
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
  head: new StubElement("head"),
  body: new StubElement("body"),
  activeElement: null,
};

// ---------------------------------------------------------------------------
// Layer 1 — the ApprovalCard component itself: gated states render no buttons.
// ---------------------------------------------------------------------------

await import("../extension/shared/components-conversation.js");
const ApprovalCard = registry.get("approval-card");
assert(ApprovalCard, "the real approval-card component must be registered");

function renderCard(attrs = {}) {
  const card = new ApprovalCard();
  for (const [name, value] of Object.entries(attrs)) card.setAttribute(name, value);
  card.connectedCallback();
  return card._root.innerHTML;
}

Deno.test("awaom round-4: the 'loading' state renders NO decision buttons (non-interactive while the detail loads)", () => {
  const markup = renderCard({ state: "loading", title: "Change Probe's provider?" });
  assert(!markup.includes('class="approve"'), "loading must not render an approve button");
  assert(!markup.includes('class="deny"'), "loading must not render a deny button");
  assert(markup.includes("Loading the exact change"), "loading says what is happening");
});

Deno.test("awaom round-4: the 'error' state keeps no approve path (retry re-fetches the detail, never the bare decision)", () => {
  const markup = renderCard({ state: "error", detail: "could not be loaded" });
  assert(!markup.includes('class="approve"'), "error must not render an approve button");
  assert(markup.includes('class="retry"'), "retry remains available");
});

Deno.test("awaom round-4: the 'pending' state renders both buttons (regression anchor for every other approval)", () => {
  const markup = renderCard({ title: "Approve this action?" });
  assert(markup.includes('class="approve"'), "pending renders approve");
  assert(markup.includes('class="deny"'), "pending renders deny");
});

// ---------------------------------------------------------------------------
// Layer 2 — the conversation wiring: a set-provider card is never actionable
// before its detail resolves, and disables itself when the detail fails.
// ---------------------------------------------------------------------------

function installTurnChromeMock({ detailBehavior }) {
  // detailBehavior: "pending-then-resolve" | "fail"
  let portListener = null;
  const sent = [];
  let runCb = null;
  let detailCb = null;
  let detailCalls = 0;
  const detail = {
    kind: "named-agent.set-provider",
    name: "Probe",
    oldContent: "provider: deepseek\nbaseURL: https://api.deepseek.com/v1\n",
    newContent: "provider: deepseek\nbaseURL: https://evil.example/v1\n",
    added: 1,
    removed: 1,
    oldLabel: "Probe provider (current)",
    newLabel: "Probe provider (proposed)",
  };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      // lib/messages.js rawSend uses the CALLBACK form — a response is only
      // ever observed via cb, so the pending cases hold the callback, never a
      // returned promise.
      sendMessage: (msg, cb) => {
        sent.push(msg);
        const respond = (value) => { if (typeof cb === "function") cb(value); return true; };
        if (msg?.type === "agent.run" || msg?.type === "named-agent.run") {
          runCb = cb;
          return true;
        }
        if (msg?.type === "approval.detail") {
          detailCalls += 1;
          if (detailBehavior === "fail") return respond({ ok: false, error: "detail missing" });
          detailCb = cb;
          return true;
        }
        if (msg?.type === "provider.permission-summary") {
          // A local provider: the preflight passes with no host-permission ask.
          return respond({ ok: true, local: true, origin: "http://localhost:11434/*", host: "localhost:11434" });
        }
        return respond({ ok: true });
      },
      connect: () => ({
        onMessage: { addListener(fn) { portListener = fn; } },
        onDisconnect: { addListener() {} },
        postMessage() {},
      }),
    },
  };
  return {
    sent,
    emit: (event) => portListener?.({ type: "progress", event }),
    runPayload: () => sent.find((m) => m?.type === "agent.run" || m?.type === "named-agent.run"),
    settleRun: () => runCb?.({ ok: true, result: "done", executionId: "exec-gating" }),
    resolveDetail: () => detailCb?.({ ok: true, detail }),
    detailCallCount: () => detailCalls,
  };
}

function fakeConversationContainer() {
  const c = new StubElement("agent-conversation");
  // Appending connects the node: the real DOM fires connectedCallback on
  // insertion, which is what makes a component render.
  const connect = (node) => { c.append(node); node.connectedCallback?.(); return node; };
  c.appendTranscript = (node) => connect(node);
  c.appendUser = () => connect(new StubElement("message-bubble"));
  c.appendAgent = () => {};
  c.appendSystem = () => {};
  c.appendError = () => {};
  return c;
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function driveSetProviderApproval(detailBehavior) {
  globalThis.document = fakeDocument;
  const chromeMock = installTurnChromeMock({ detailBehavior });
  const conv = await import(`../extension/shared/conversation.js?t=${Math.random()}`);
  const container = fakeConversationContainer();
  const turn = conv.runConversationTurn(container, { text: "go" });
  await flush();
  const run = chromeMock.runPayload();
  assert(run?.runId, "the turn registered its runId");
  chromeMock.emit({
    type: "approval-request",
    runId: run.runId,
    requestId: "req-1",
    result: {
      waitingForPermission: true,
      permissionRequirement: {
        approvals: [{ approvalId: "ap-1", action: "named-agent.set-provider", targetRef: "opaque-ref" }],
      },
    },
  });
  await flush();
  const card = container.children.find((k) => k.localName === "approval-card");
  assert(card, "the approval card was rendered");
  return { card, chromeMock, turn };
}

Deno.test("awaom round-4 (finding b): the set-provider card is NON-INTERACTIVE until the detail resolves, then actionable with the diff", async () => {
  const { card, chromeMock, turn } = await driveSetProviderApproval("pending-then-resolve");
  const states = [];
  const origSet = card.setAttribute.bind(card);
  card.setAttribute = (n, v) => { if (n === "state") states.push(String(v)); return origSet(n, v); };
  assertEquals(card.getAttribute("state"), "loading", "the card starts non-interactive, before any detail");
  assertEquals(String(card._root?.innerHTML ?? "").includes('class="approve"'), false, "no approve button while loading");
  assertEquals(chromeMock.detailCallCount(), 1, "exactly one detail fetch");

  chromeMock.resolveDetail();
  await flush();
  assertEquals(card.getAttribute("state"), "pending", "the card becomes actionable only WITH its detail");
  assert(card.querySelector("artifact-diff"), "the rendered diff is the consent surface");
  assert(String(card._root?.innerHTML ?? "").includes('class="approve"'), "the approve button exists only once the detail is shown");

  chromeMock.settleRun();
  await turn.catch(() => null);
});

Deno.test("awaom round-4 (finding b): a detail failure DISABLES the card — never actionable, and retry re-fetches the DETAIL", async () => {
  const { card, chromeMock, turn } = await driveSetProviderApproval("fail");
  const states = [];
  const origSet = card.setAttribute.bind(card);
  card.setAttribute = (n, v) => { if (n === "state") states.push(String(v)); return origSet(n, v); };
  assertEquals(card.getAttribute("state"), "error", "a failed detail disables the card");
  assert(
    String(card.getAttribute("detail") ?? "").includes("cannot be granted"),
    "the card states honestly why it cannot be used",
  );
  assertEquals(chromeMock.detailCallCount(), 1, "the detail fetch ran once");
  // Retry re-fetches the DETAIL (state returns to the non-interactive loading
  // state synchronously, the fetch goes out, and on this still-failing detail
  // the card settles back to disabled) — it NEVER exposes the bare decision.
  card.dispatch("retry");
  assertEquals(card.getAttribute("state"), "loading", "retry returns to the non-interactive loading state");
  assertEquals(chromeMock.detailCallCount(), 2, "retry re-fetched the detail");
  await flush();
  assertEquals(card.getAttribute("state"), "error", "the still-failing detail leaves the card disabled");
  assert(!states.includes("pending"), "the card was actionable at NO point — pending never appears");
  chromeMock.settleRun();
  await turn.catch(() => null);
});

// ---------------------------------------------------------------------------
// Layer 3 — rrnwp: the REPLAY path (reopen thread / second hub tab / a
// projection that attached late). Round-4 gated only runConversationTurn's
// live card; the replayed card rebuilt from the cached approval-request event
// mounted pending and clickable with no destination anywhere — and
// wireReplayApprovals resolved it with no evidence the detail was ever shown.
// ---------------------------------------------------------------------------

Deno.test("rrnwp: the replayed-card spec for a detail-gated action mounts in 'loading', other actions unchanged", async () => {
  const conv = await import(`../extension/shared/conversation.js?t=${Math.random()}`);
  const spec = conv.approvalCardSpecFromRequest({
    type: "approval-request",
    approvalId: "ap-1",
    result: {
      waitingForPermission: true,
      permissionRequirement: { approvals: [{ approvalId: "ap-1", action: "named-agent.set-provider", targetRef: "provider:9f1c2ab7" }] },
    },
  });
  assertEquals(spec.state, "loading", "the gated replay spec mounts non-interactive");
  const editSpec = conv.approvalCardSpecFromRequest({
    type: "approval-request",
    approvalId: "ap-2",
    result: {
      waitingForPermission: true,
      permissionRequirement: { approvals: [{ approvalId: "ap-2", action: "asset.update", targetRef: "asset:x" }] },
    },
  });
  assertEquals(editSpec.state, undefined, "edit approvals keep the default (opaque fallback by design)");
});

async function driveReplayedApproval(detailBehavior) {
  globalThis.document = fakeDocument;
  const chromeMock = installTurnChromeMock({ detailBehavior });
  const conv = await import(`../extension/shared/conversation.js?t=${Math.random()}`);
  conv.subscribeProgress(() => {}, { replayPending: false });
  chromeMock.emit({
    type: "approval-request",
    threadId: "t-1",
    runId: "run-1",
    executionId: "exec-1",
    approvalId: "ap-replay",
    requestId: "req-replay",
    result: {
      waitingForPermission: true,
      permissionRequirement: { approvals: [{ approvalId: "ap-replay", action: "named-agent.set-provider", targetRef: "provider:9f1c2ab7" }] },
    },
  });
  const container = fakeDocument.createElement("agent-conversation");
  const unwire = conv.wireReplayApprovals(container);
  const mounted = conv.replayPendingApprovalsForThread(container, "t-1");
  assertEquals(mounted.length, 1, "the replayed approval mounted one card");
  const card = mounted[0];
  return { card, chromeMock, container, unwire };
}

Deno.test("rrnwp: the REPLAYED provider-approval card is non-interactive until its detail resolves, then approves through the normal route", async () => {
  const { card, chromeMock, unwire } = await driveReplayedApproval("pending-then-resolve");
  assertEquals(card.getAttribute("state"), "loading", "the replayed card mounts non-interactive");
  assertEquals(String(card._root?.innerHTML ?? "").includes('class="approve"'), false, "no approve button on the replayed card while loading");
  assertEquals(chromeMock.detailCallCount(), 1, "the replay path fetched the detail");

  chromeMock.resolveDetail();
  await flush();
  assertEquals(card.getAttribute("state"), "pending", "the replayed card becomes actionable only WITH its detail");
  assert(String(card._root?.innerHTML ?? "").includes('class="approve"'), "the approve button exists with the detail shown");
  assert(card.querySelector("artifact-diff"), "the diff (with the destination) is the consent surface");

  // The owner's decision flows through the normal replay resolution.
  card.dispatch("approve");
  await flush();
  assert(
    chromeMock.sent.some((m) => m?.type === "management.resolve-approval" && m.approvalId === "ap-replay" && m.approve === true),
    "a shown-detail approve resolves the pending row",
  );
  unwire();
});

Deno.test("rrnwp: a replayed card whose detail fails is NEVER resolvable — even by a synthetic approve event", async () => {
  const { card, chromeMock, unwire } = await driveReplayedApproval("fail");
  assertEquals(card.getAttribute("state"), "error", "the failed detail disables the replayed card");
  card.dispatch("approve");
  await flush();
  assertEquals(
    chromeMock.sent.filter((m) => m?.type === "management.resolve-approval").length,
    0,
    "no resolve message leaves the surface for a card that never showed its detail",
  );
  assertEquals(card.getAttribute("state"), "error", "the card stays disabled");
  assert(
    String(card.getAttribute("detail") ?? "").includes("must be shown before it can be approved")
      || String(card.getAttribute("detail") ?? "").includes("cannot be granted"),
    "the card states honestly why it cannot be used",
  );
  unwire();
});
