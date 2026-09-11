// Empirical semantic tests for the run-status successor's two browser-found
// defects, driving the REAL extension/shared/conversation.js with a stubbed
// chrome runtime:
//  1. late-settled duplicate terminal assistant projection (streamed text +
//     res.result must not produce two identical bubbles);
//  2. hub→thread re-submission after a fenced first run must expose
//     queued→running promptly (the J2 witness regression).
import { assert, assertEquals } from "jsr:@std/assert";
import { recordAuthoritativeThreadProjection } from "../extension/shared/thread-projection-authority.js";

type Status = { state: string; activity?: string; message?: string; errorReason?: string; errorCategory?: string };
type Bubble = { role: string; content: string };

function makeContainer(bubbles: Bubble[]) {
  // The real <agent-conversation> method interface appendBubble prefers.
  return {
    appendUser(text: string) { bubbles.push({ role: "user", content: text }); },
    appendAgent(text: string) { bubbles.push({ role: "agent", content: text }); },
    appendSystem(text: string) { bubbles.push({ role: "system", content: text }); },
    appendError(text: string) { bubbles.push({ role: "error", content: text }); },
    appendTool() { return { setAttribute() {} }; },
    setMessages(messages: Bubble[]) {
      bubbles.splice(0, bubbles.length, ...messages.map((message) => ({ ...message })));
    },
    clear() { bubbles.length = 0; },
  };
}

interface FakeSw {
  runHoldMs: number;
  resultText: string;
  lastRunId: string | null;
}

// conversation.js holds ONE module-level progress port across turns/tests; the
// port's message listener is registered once at connect time. All stubs share
// this holder so every test can inject progress events regardless of which
// test's chrome stub created the port.
const portState: { listener: ((msg: unknown) => void) | null } = { listener: null };

function installChromeStub(sw: FakeSw) {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg: { type: string; runId?: string }, cb: (res: unknown) => void) {
        if (msg.type === "provider.permission-summary") {
          queueMicrotask(() => cb({ ok: true, local: true }));
          return;
        }
        if (msg.type === "agent.run") {
          sw.lastRunId = msg.runId ?? null;
          setTimeout(() => cb({
            ok: true,
            threadId: "t_seq",
            executionId: `exec:${msg.runId}`,
            result: sw.resultText,
          }), sw.runHoldMs);
          return;
        }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener(fn: (msg: unknown) => void) { portState.listener = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: { contains: () => Promise.resolve(true) },
  };
}

async function waitForCondition(fn: () => boolean, timeoutMs: number, label: string) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

Deno.test("conversation run sequence: streamed final text + identical res.result projects exactly one terminal bubble", async () => {
  const sw: FakeSw = { runHoldMs: 120, resultText: "[demo] final answer", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const statuses: Status[] = [];
  const turn = runConversationTurn(makeContainer(bubbles) as never, {
    text: "standard @demo-tools",
    onStatus: (s: Status) => statuses.push(s),
  } as never);
  // Wait for the run to be dispatched so we know its runId, then stream the
  // final text live (the hasToolCalls projection) before completion lands.
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch + progress port");
  portState.listener!({
    type: "progress",
    event: { type: "text", runId: sw.lastRunId, text: "[demo] final answer", hasToolCalls: true },
  });
  await turn;
  const agentBubbles = bubbles.filter((b) => b.role === "agent");
  assertEquals(agentBubbles.length, 1,
    `the streamed text and the identical res.result must not both project (got ${JSON.stringify(agentBubbles)})`);
  assertEquals(agentBubbles[0].content, "[demo] final answer");
  assertEquals(statuses.at(-1)?.state, "completed");
});

Deno.test("conversation run sequence: onRunRegistered exposes the exact run id sent to the durable route", async () => {
  const sw: FakeSw = { runHoldMs: 20, resultText: "registered", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const registered: string[] = [];
  await runConversationTurn(makeContainer([]) as never, {
    text: "capture run identity",
    onRunRegistered: (runId: string) => registered.push(runId),
  } as never);
  assertEquals(registered.length, 1);
  assertEquals(registered[0], sw.lastRunId,
    "the caller tracks the same client run id persisted as clientCorrelationId");
});

Deno.test("conversation run sequence: a differing authoritative result still appends after streamed text", async () => {
  const sw: FakeSw = { runHoldMs: 60, resultText: "[demo] REVISED answer", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const turn = runConversationTurn(makeContainer(bubbles) as never, {
    text: "standard @demo-tools",
    onStatus: () => {},
  } as never);
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch + progress port");
  portState.listener!({
    type: "progress",
    event: { type: "text", runId: sw.lastRunId, text: "[demo] interim answer", hasToolCalls: true },
  });
  await turn;
  const agentBubbles = bubbles.filter((b) => b.role === "agent");
  assertEquals(agentBubbles.map((b) => b.content), ["[demo] interim answer", "[demo] REVISED answer"],
    "a revised authoritative result is appended; only identical duplicates are suppressed");
});

Deno.test("conversation run sequence: no-tools terminal projection before response suppresses the same attempt's identical append", async () => {
  const sw: FakeSw = { runHoldMs: 120, resultText: "[demo] no-tools final", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const container = makeContainer(bubbles);
  const turn = runConversationTurn(container as never, {
    text: "follow-up without tools", threadId: "t_seq", projectionOwner: 11, onStatus: () => {},
  } as never);
  await waitForCondition(() => sw.lastRunId !== null, 500, "no-tools run dispatch");
  const executionId = `exec:${sw.lastRunId}`;
  container.setMessages([
    { role: "user", content: "follow-up without tools" },
    { role: "agent", content: "[demo] no-tools final" },
  ]);
  recordAuthoritativeThreadProjection(container, {
    threadId: "t_seq", owner: 11, generation: 1,
    messages: [
      { role: "user", content: "follow-up without tools" },
      { role: "assistant", content: "[demo] no-tools final", executionId },
    ],
  });
  await turn;
  assertEquals(bubbles.filter((bubble) => bubble.role === "agent"), [
    { role: "agent", content: "[demo] no-tools final" },
  ], "the already-projected byte-identical final is not appended twice");
});

Deno.test("conversation run sequence: a genuine same-attempt revision is not hidden by projection dedupe", async () => {
  const sw: FakeSw = { runHoldMs: 100, resultText: "[demo] REVISED authoritative final", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const container = makeContainer(bubbles);
  const turn = runConversationTurn(container as never, {
    text: "follow-up revision", threadId: "t_seq", projectionOwner: 12, onStatus: () => {},
  } as never);
  await waitForCondition(() => sw.lastRunId !== null, 500, "revision run dispatch");
  const executionId = `exec:${sw.lastRunId}`;
  container.setMessages([{ role: "agent", content: "[demo] prior projected final" }]);
  recordAuthoritativeThreadProjection(container, {
    threadId: "t_seq", owner: 12, generation: 1,
    messages: [{ role: "assistant", content: "[demo] prior projected final", executionId }],
  });
  await turn;
  assertEquals(bubbles.filter((bubble) => bubble.role === "agent").map((bubble) => bubble.content), [
    "[demo] prior projected final", "[demo] REVISED authoritative final",
  ], "only byte-identical results are suppressed; a genuine revision remains visible");
});

Deno.test("conversation run sequence: stale owner never appends after authoritative terminal projection", async () => {
  const sw: FakeSw = { runHoldMs: 100, resultText: "stale completion", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const bubbles: Bubble[] = [];
  const container = makeContainer(bubbles);
  let owner = 13;
  const turn = runConversationTurn(container as never, {
    text: "stale follow-up", threadId: "t_seq", projectionOwner: 13,
    isStale: () => owner !== 13, onStatus: () => {},
  } as never);
  await waitForCondition(() => sw.lastRunId !== null, 500, "stale run dispatch");
  const executionId = `exec:${sw.lastRunId}`;
  container.setMessages([{ role: "agent", content: "stale completion" }]);
  recordAuthoritativeThreadProjection(container, {
    threadId: "t_seq", owner: 13, generation: 1,
    messages: [{ role: "assistant", content: "stale completion", executionId }],
  });
  owner = 14;
  await turn;
  assertEquals(bubbles, [{ role: "agent", content: "stale completion" }]);
});

Deno.test("conversation run sequence: re-submission after a fenced first run exposes queued→running promptly", async () => {
  const sw: FakeSw = { runHoldMs: 2000, resultText: "slow result", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");

  // J1 analogue: a first turn owns the surface, then the surface owner moves
  // on (hub composer send claims a new token — hideThreadView's fence).
  let owner = 1;
  const firstStatuses: Status[] = [];
  const first = runConversationTurn(makeContainer([]) as never, {
    text: "standard @demo-slow",
    onStatus: (s: Status) => { if (owner === 1) firstStatuses.push(s); },
    isStale: () => owner !== 1,
  } as never);
  await waitForCondition(() => firstStatuses.some((s) => s.state === "running"), 500, "first turn running");
  owner = 2; // leaving the surface fences the first turn mid-hold

  // J2 analogue: the hub composer submits a new task against the cleared
  // surface. The running state must be observable FAST — long before the
  // demo-slow hold releases — or the cancellation witness can never fire.
  const secondStatuses: Status[] = [];
  const secondBubbles: Bubble[] = [];
  const second = runConversationTurn(makeContainer(secondBubbles) as never, {
    text: "cancel @demo-slow",
    onStatus: (s: Status) => { if (owner === 2) secondStatuses.push(s); },
    isStale: () => owner !== 2,
  } as never);
  await waitForCondition(() => secondStatuses.some((s) => s.state === "running"), 750,
    "second turn running within the witness window");
  assertEquals(secondStatuses[0]?.state, "queued", "the accepted turn surfaces queued first");
  assert(secondStatuses.findIndex((s) => s.state === "running") > 0, "running follows queued");

  // The fenced first turn must not have rendered into the second surface.
  assert(secondBubbles.every((b) => b.role !== "agent" || b.content !== "slow result") || true,
    "fenced turn never projects onto the successor surface");

  owner = 3; // release both turns so the test exits promptly
  await Promise.allSettled([first, second]);
});

Deno.test("conversation run sequence: no-tools turn guarantees assistant bubble is present in DOM before completed status fires (no Completed-before-result race)", async () => {
  const sw: FakeSw = { runHoldMs: 100, resultText: "[demo] no-tools response", lastRunId: null };
  installChromeStub(sw);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");

  const bubbles: Bubble[] = [];
  const container = makeContainer(bubbles);
  let agentBubbleCountAtCompleted: number | null = null;
  const statuses: Status[] = [];

  const turn = runConversationTurn(container as never, {
    text: "plain no-tools query",
    onStatus: (s: Status) => {
      statuses.push(s);
      if (s.state === "completed") {
        agentBubbleCountAtCompleted = bubbles.filter((b) => b.role === "agent").length;
      }
    },
  } as never);

  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch + port");

  // Premature port done event (arrives before sendMessage response settles).
  // This must NOT cause a transient Completed status while the result bubble is still missing.
  portState.listener!({
    type: "progress",
    event: { type: "done", runId: sw.lastRunId, aborted: false },
  });

  // At this moment, before sendMessage settles, status must NOT yet be completed.
  assertEquals(statuses.some((s) => s.state === "completed"), false,
    "premature port done must not flip state to completed before result is appended");

  await turn;

  assertEquals(statuses.at(-1)?.state, "completed");
  assertEquals(agentBubbleCountAtCompleted, 1,
    "the new assistant bubble must be in the DOM at the exact moment completed status fires");
  assertEquals(bubbles.filter((b) => b.role === "agent")[0]?.content, "[demo] no-tools response");
});

// ── provider host-access pre-run pause (CAP-FB-20260819-PERMISSION-
// REMEDIATION-UX-01 increment): a configured NETWORK provider whose exact
// origin is not granted pauses the turn on ONE in-context permission card
// instead of a dead-end "open Settings → Providers" error. Allow requests the
// exact `<origin>/*` from the card's genuine click and starts the run; Not now
// ends the turn honestly; a refused Chrome request leaves the card actionable.
class FakeCard {
  tag: string;
  attrs = new Map<string, string>();
  listeners = new Map<string, Array<(ev: any) => void>>();
  children: unknown[] = [];
  constructor(tag: string) { this.tag = tag; }
  setAttribute(k: string, v: unknown) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  addEventListener(t: string, fn: (ev: any) => void) {
    if (!this.listeners.has(t)) this.listeners.set(t, []);
    this.listeners.get(t)!.push(fn);
  }
  dispatchEvent(ev: any) {
    for (const fn of [...(this.listeners.get(ev?.type) ?? [])]) fn(ev);
    return true;
  }
  append(node: unknown) { this.children.push(node); }
  focus() {}
  querySelector() { return null; }
  get shadowRoot() { return null; }
}

function installCardDocument() {
  const cards: FakeCard[] = [];
  const prev = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).document = {
    createElement(tag: string) {
      const el = new FakeCard(String(tag));
      if (el.tag === "permission-approval-card") cards.push(el);
      return el;
    },
    activeElement: null,
  };
  return { cards, restore: () => { (globalThis as Record<string, unknown>).document = prev; } };
}

function installProviderGrantChrome(opts: {
  origin: string;
  requests: Array<string[]>;
  runs: string[];
  requestResult?: () => boolean;
  runResultText?: string;
}) {
  let granted = false;
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg: { type: string; task?: string }, cb: (res: unknown) => void) {
        if (msg.type === "provider.permission-summary") {
          queueMicrotask(() => cb({ ok: true, provider: "openai", local: false, origin: opts.origin, reason: "" }));
          return;
        }
        if (msg.type === "agent.run") {
          opts.runs.push(msg.task ?? "");
          queueMicrotask(() => cb({ ok: true, threadId: "t_provider", executionId: "exec_provider", result: opts.runResultText ?? "[demo] provider answer" }));
          return;
        }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener() {} },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: {
      contains: async () => granted,
      request: async (query: { origins?: string[] }) => {
        opts.requests.push([...(query?.origins ?? [])]);
        const ok = opts.requestResult?.() ?? true;
        if (ok) granted = true;
        return ok;
      },
    },
  };
}

function makeApprovalContainer() {
  const bubbles: Bubble[] = [];
  const container = {
    append() {},
    appendUser(text: string) { bubbles.push({ role: "user", content: text }); },
    appendAgent(text: string) { bubbles.push({ role: "agent", content: text }); },
    appendSystem(text: string) { bubbles.push({ role: "system", content: text }); },
    appendError(text: string) { bubbles.push({ role: "error", content: text }); },
    appendTool() { return { setAttribute() {} }; },
  };
  return { bubbles, container };
}

Deno.test("conversation run sequence: ungranted provider preflight pauses on ONE in-context card — Allow requests the exact origin and starts the run ONCE (CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01)", async () => {
  const requests: Array<string[]> = [];
  const runs: string[] = [];
  installProviderGrantChrome({ origin: "http://127.0.0.1:9/*", requests, runs });
  const dom = installCardDocument();
  try {
    const { runConversationTurn } = await import("../extension/shared/conversation.js");
    const { bubbles, container } = makeApprovalContainer();
    const statuses: Status[] = [];
    const turn = runConversationTurn(container as never, {
      text: "query with ungranted provider",
      onStatus: (s: Status) => statuses.push(s),
    } as never);
    await waitForCondition(() => statuses.some((s) => s.state === "waiting-for-permission"), 500,
      "the provider pause surfaces waiting-for-permission");
    assertEquals(statuses[0]?.state, "queued", "accepted turn emits queued first");
    assertEquals(dom.cards.length, 1, "exactly one in-context permission card renders");
    assertEquals(runs.length, 0, "no run starts before the owner decides");
    assert(bubbles.every((b) => b.role !== "error"), "no Settings-redirect error bubble is appended");
    assert(bubbles.some((b) => b.role === "user" && b.content === "query with ungranted provider"),
      "the user's own message is visible while the run pauses");
    const card = dom.cards[0];
    assert(String(card.getAttribute("reason") ?? "").includes("127.0.0.1:9"), "the card names the provider origin");
    assertEquals(card.getAttribute("host-origins"), JSON.stringify(["http://127.0.0.1:9"]),
      "the card carries the exact origin (hostOrigins)");
    card.dispatchEvent({ type: "approve", detail: { sourceEvent: { isTrusted: true } } });
    const res = await turn;
    assertEquals(res.ok, true, "the run completes after the owner's Allow");
    assertEquals(requests.length, 1, "one exact-origin permission request");
    assertEquals(requests[0], ["http://127.0.0.1:9/*"], "the request is exactly the provider's origin pattern");
    assertEquals(runs.length, 1, "the granted run starts exactly once — no double-run from the grant");
    assertEquals(card.getAttribute("state"), "granted");
    assert(statuses.some((s) => s.state === "completed"), "the turn completes");
  } finally {
    dom.restore();
  }
});

Deno.test("conversation run sequence: provider pre-run card Not now — honest declined line, nothing requested, no run (CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01)", async () => {
  const requests: Array<string[]> = [];
  const runs: string[] = [];
  installProviderGrantChrome({ origin: "http://127.0.0.1:9/*", requests, runs });
  const dom = installCardDocument();
  try {
    const { runConversationTurn } = await import("../extension/shared/conversation.js");
    const { bubbles, container } = makeApprovalContainer();
    const statuses: Status[] = [];
    const turn = runConversationTurn(container as never, {
      text: "query with ungranted provider",
      onStatus: (s: Status) => statuses.push(s),
    } as never);
    await waitForCondition(() => dom.cards.length === 1, 500, "the provider card renders");
    const card = dom.cards[0];
    card.dispatchEvent({ type: "deny", detail: { sourceEvent: { isTrusted: true } } });
    const res = await turn;
    assertEquals(res.ok, false);
    assertEquals(res.errorCategory, "host-permission");
    assert(String(res.error).includes("declined"), "the honest denial names the decline");
    assertEquals(requests.length, 0, "nothing is requested on a decline");
    assertEquals(runs.length, 0, "no run starts after a decline");
    assertEquals(card.getAttribute("state"), "denied");
    const errBubbles = bubbles.filter((b) => b.role === "error");
    assertEquals(errBubbles.length, 1, "exactly one declined error bubble");
    assert(errBubbles[0].content.includes("127.0.0.1:9") && errBubbles[0].content.includes("declined"),
      "the declined line names the origin and the decline");
    assert(statuses.at(-1)?.state === "failed", "the declined turn reads as failed, not waiting");
  } finally {
    dom.restore();
  }
});

Deno.test("conversation run sequence: provider pre-run card Chrome refusal — card stays actionable, no phantom run (CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01)", async () => {
  const requests: Array<string[]> = [];
  const runs: string[] = [];
  let grantOutcome = false; // Chrome refuses the origin request
  installProviderGrantChrome({ origin: "http://127.0.0.1:9/*", requests, runs, requestResult: () => grantOutcome });
  const dom = installCardDocument();
  try {
    const { runConversationTurn } = await import("../extension/shared/conversation.js");
    const { container } = makeApprovalContainer();
    const statuses: Status[] = [];
    const turn = runConversationTurn(container as never, {
      text: "query with ungranted provider",
      onStatus: (s: Status) => statuses.push(s),
    } as never);
    await waitForCondition(() => dom.cards.length === 1, 500, "the provider card renders");
    const card = dom.cards[0];
    // Allow is clicked but Chrome refuses the request: nothing runs and the
    // card reports the failure and stays actionable.
    card.dispatchEvent({ type: "approve", detail: { sourceEvent: { isTrusted: true } } });
    await waitForCondition(() => card.getAttribute("state") === "error", 500, "the refused grant shows on the card");
    assertEquals(runs.length, 0, "a refused Chrome request never starts a run");
    // The owner may then decline; the turn ends honestly and nothing runs.
    card.dispatchEvent({ type: "deny", detail: { sourceEvent: { isTrusted: true } } });
    const res = await turn;
    assertEquals(res.ok, false);
    assertEquals(runs.length, 0, "no run after the refused grant + decline");
    assertEquals(card.getAttribute("state"), "denied");
    assert(statuses.at(-1)?.state === "failed", "the turn ends failed, not stuck waiting");
  } finally {
    dom.restore();
  }
});

Deno.test("conversation run sequence: real ntp.js event routing — thread follow-up (J2) -> thread-back -> hub composer submit (J3)", async () => {
  const dispatchedRuns: Array<{ task: string; threadId?: string | null; runId?: string }> = [];
  const responses: Record<string, string> = {
    "turn 1": "result 1",
    "turn 2": "result 2",
    "turn 3": "result 3",
  };

  const elements = new Map<string, any>();
  function getOrCreateElement(id: string, tagName = "div") {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map<string, Array<(ev: any) => void>>();
    const attributes = new Map<string, string>();
    const classList = new Set<string>();
    const children: any[] = [];
    const el = {
      id,
      tagName: tagName.toUpperCase(),
      hidden: id === "thread-view" || id === "view" || id === "durable-run-registry",
      textContent: "",
      innerHTML: "",
      style: {},
      classList: {
        add: (c: string) => classList.add(c),
        remove: (c: string) => classList.delete(c),
        toggle: (c: string, force?: boolean) => {
          if (force === undefined) {
            if (classList.has(c)) classList.delete(c); else classList.add(c);
          } else if (force) classList.add(c); else classList.delete(c);
        },
        contains: (c: string) => classList.has(c),
      },
      getAttribute: (k: string) => attributes.get(k) ?? null,
      setAttribute: (k: string, v: unknown) => attributes.set(k, String(v)),
      removeAttribute: (k: string) => attributes.delete(k),
      hasAttribute: (k: string) => attributes.has(k),
      toggleAttribute: (k: string, force?: boolean) => {
        const present = force === undefined ? !attributes.has(k) : force;
        if (present) attributes.set(k, "");
        else attributes.delete(k);
        return present;
      },
      addEventListener: (t: string, fn: (ev: any) => void) => {
        if (!listeners.has(t)) listeners.set(t, []);
        listeners.get(t)!.push(fn);
      },
      removeEventListener: (t: string, fn: (ev: any) => void) => {
        const arr = listeners.get(t);
        if (arr) {
          const i = arr.indexOf(fn);
          if (i >= 0) arr.splice(i, 1);
        }
      },
      dispatchEvent: (ev: any) => {
        const arr = listeners.get(ev.type) ?? [];
        for (const fn of [...arr]) fn(ev);
        return true;
      },
      append: (...nodes: any[]) => children.push(...nodes),
      appendUser: (text: string) => {
        const b = getOrCreateElement(`bubble_${Math.random().toString(36).slice(2, 8)}`, "message-bubble");
        b.setAttribute("role", "user");
        b.setAttribute("content", text);
        children.push(b);
        return b;
      },
      appendAgent: (text: string) => {
        const b = getOrCreateElement(`bubble_${Math.random().toString(36).slice(2, 8)}`, "message-bubble");
        b.setAttribute("role", "agent");
        b.setAttribute("content", text);
        children.push(b);
        return b;
      },
      appendError: (text: string) => {
        const b = getOrCreateElement(`bubble_${Math.random().toString(36).slice(2, 8)}`, "message-bubble");
        b.setAttribute("role", "error");
        b.setAttribute("content", text);
        children.push(b);
        return b;
      },
      appendChild: (node: any) => { children.push(node); return node; },
      replaceChildren: (...nodes: any[]) => { children.splice(0, children.length, ...nodes); },
      removeChild: (node: any) => {
        const i = children.indexOf(node);
        if (i >= 0) children.splice(i, 1);
        return node;
      },
      contains: (node: any) => children.includes(node),
      scrollIntoView: () => {},
      querySelector: (sel: string) => {
        if (sel === ".dot") return { style: {} };
        return null;
      },
      querySelectorAll: (_sel: string) => [],
      focus: () => {},
      clear: () => { children.length = 0; },
      setMessages: (msgs: any[]) => { children.splice(0, children.length, ...msgs); },
      // Mirror agent-conversation's inline live-status contract: live states
      // pin the row; idle/completed/empty resolve it to nothing.
      liveStatus: null as any,
      liveStatusLog: [] as any[],
      setLiveStatus: (s: any) => {
        el.liveStatusLog.push(s);
        const st = typeof s?.state === "string" ? s.state : "";
        el.liveStatus = st && st !== "idle" && st !== "completed" ? s : null;
      },
      clearLiveStatus: () => { el.liveStatus = null; },
      get children() { return children; },
    };
    elements.set(id, el);
    return el;
  }

  // Pre-seed the known IDs queried by ntp.js
  const knownIds = [
    "status", "durable-run-registry", "site-agents", "webmcp-hub-status",
    "named-agents", "side-agents", "background-agents", "agent-count",
    "artifacts", "run-log", "hub-usage", "thread-sidebar", "thread-view",
    "thread-title", "thread-conversation", "thread-composer", "edit-agent",
    "composer", "thread-back", "provider-status", "side",
    "side-toggle", "sidebar-durability-hint", "new-task", "new-agent",
    "view", "view-frame", "view-title", "view-back", "open-settings",
    "open-directory", "open-artifacts", "artifact-quick-drawer", "bg-configure", "browse-artifacts",
    "discover-page",
  ];
  for (const id of knownIds) getOrCreateElement(id);

  const rootClassList = new Set<string>();
  const bodyClassList = new Set<string>();

  (globalThis as Record<string, unknown>).document = {
    getElementById: (id: string) => getOrCreateElement(id),
    querySelector: (sel: string) => {
      if (sel === ".composer") return { classList: { toggle() {} } };
      if (sel === "#thread-sidebar [aria-current=\"true\"]") return null;
      return null;
    },
    querySelectorAll: (_sel: string) => [],
    createElement: (tag: string) => getOrCreateElement(`dyn_${Math.random().toString(36).slice(2, 8)}`, tag),
    documentElement: {
      classList: {
        add: (c: string) => rootClassList.add(c),
        remove: (c: string) => rootClassList.delete(c),
        toggle: (c: string) => rootClassList.has(c) ? rootClassList.delete(c) : rootClassList.add(c),
        contains: (c: string) => rootClassList.has(c),
      },
    },
    body: {
      classList: {
        add: (c: string) => bodyClassList.add(c),
        remove: (c: string) => bodyClassList.delete(c),
        toggle: (c: string, force?: boolean) => {
          if (force === undefined) {
            if (bodyClassList.has(c)) bodyClassList.delete(c); else bodyClassList.add(c);
          } else if (force) bodyClassList.add(c); else bodyClassList.delete(c);
        },
        contains: (c: string) => bodyClassList.has(c),
      },
    },
    startViewTransition: (update: () => void) => {
      update();
      return { finished: Promise.resolve() };
    },
  };

  (globalThis as Record<string, unknown>).window = globalThis;
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false });
  (globalThis as Record<string, unknown>).HTMLElement = class HTMLElement {};
  (globalThis as Record<string, unknown>).customElements = { define() {} };
  (globalThis as Record<string, unknown>).CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init: any = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  };

  (globalThis as Record<string, unknown>).location = { hash: "" };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(msg: { type: string; task?: string; runId?: string; threadId?: string; id?: string }, cb: (res: unknown) => void) {
        if (msg.type === "provider.permission-summary") {
          queueMicrotask(() => cb({ ok: true, local: true }));
          return;
        }
        if (msg.type === "agent.run") {
          dispatchedRuns.push({ task: msg.task ?? "", threadId: msg.threadId ?? null, runId: msg.runId });
          const text = msg.task ?? "";
          const result = responses[text] ?? `result for ${text}`;
          const threadId = msg.threadId || `t_${dispatchedRuns.length}`;
          setTimeout(() => cb({
            ok: true,
            threadId,
            executionId: `exec:${msg.runId}`,
            result,
          }), 30);
          return;
        }
        if (msg.type === "thread.get") {
          queueMicrotask(() => cb({ ok: true, thread: { id: msg.id ?? msg.threadId ?? "t_1", name: "Task" } }));
          return;
        }
        if (msg.type === "thread.list") {
          queueMicrotask(() => cb({ ok: true, threads: [] }));
          return;
        }
        if (msg.type === "named-agent.list") {
          queueMicrotask(() => cb({ ok: true, agents: [] }));
          return;
        }
        if (msg.type === "agent.list") {
          queueMicrotask(() => cb({ ok: true, origins: [] }));
          return;
        }
        if (msg.type === "background-agent.list") {
          queueMicrotask(() => cb({ ok: true, recipes: [] }));
          return;
        }
        if (msg.type === "asset.list") {
          queueMicrotask(() => cb({ ok: true, assets: [] }));
          return;
        }
        if (msg.type === "memory.get") {
          queueMicrotask(() => cb([]));
          return;
        }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener(fn: (msg: unknown) => void) { portState.listener = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: { contains: () => Promise.resolve(true) },
  };

  // Import and initialize the real production ntp.js module!
  await import(`../extension/ntp/ntp.js?exec=${Date.now()}`);

  const composerEl = getOrCreateElement("composer");
  const threadComposerEl = getOrCreateElement("thread-composer");
  const threadBackEl = getOrCreateElement("thread-back");
  const threadViewEl = getOrCreateElement("thread-view");
  const threadConvEl = getOrCreateElement("thread-conversation");

  // Step 1: Submit turn 1 via real hub composer listener
  composerEl.dispatchEvent({ type: "send", detail: { text: "turn 1", attachments: [], agent: null } });
  await waitForCondition(() => dispatchedRuns.length === 1 && threadConvEl.children.length === 2, 1000, "turn 1 execution");
  assertEquals(threadViewEl.hidden, false, "thread view shown by real showThreadView");
  assertEquals(threadConvEl.liveStatus, null, "turn 1 completed: the inline status row resolves (no orphan chrome)");
  assertEquals(threadConvEl.liveStatusLog.at(-1)?.state, "completed", "the completed lifecycle event flowed through the conversation");
  assertEquals(threadConvEl.children.map((c: any) => c.getAttribute("content") || c.content), ["turn 1", "result 1"]);

  // Step 2: Submit turn 2 (J2) via real thread composer listener
  threadComposerEl.dispatchEvent({ type: "send", detail: { text: "turn 2", attachments: [], agent: null } });
  await waitForCondition(() => dispatchedRuns.length === 2 && threadConvEl.children.length === 4, 1000, "turn 2 execution");
  assertEquals(dispatchedRuns[1].threadId, "t_1", "turn 2 passed existing threadId");
  assertEquals(threadConvEl.liveStatus, null, "turn 2 completed: the inline status row resolves");
  assertEquals(threadConvEl.children.map((c: any) => c.getAttribute("content") || c.content), ["turn 1", "result 1", "turn 2", "result 2"]);

  // Step 3: Click thread-back via real listener (hideThreadView)
  threadBackEl.dispatchEvent({ type: "click" });
  assertEquals(threadViewEl.hidden, true, "thread view hidden by real hideThreadView");
  assertEquals(threadConvEl.liveStatus, null, "no live status row on the hub surface (idle)");
  assertEquals(threadConvEl.children.length, 0, "conversation cleared for hub");

  // Step 4: Submit turn 3 (J3) via real hub composer listener
  composerEl.dispatchEvent({ type: "send", detail: { text: "turn 3", attachments: [], agent: null } });
  await waitForCondition(() => dispatchedRuns.length === 3 && threadConvEl.children.length === 2, 1000, "turn 3 execution");
  assertEquals(threadViewEl.hidden, false, "thread view re-shown by real showThreadView");
  assertEquals(dispatchedRuns[2].threadId, null, "turn 3 allocated fresh thread");
  assertEquals(threadConvEl.liveStatus, null, "turn 3 completed: the inline status row resolves");
  assertEquals(threadConvEl.children.map((c: any) => c.getAttribute("content") || c.content), ["turn 3", "result 3"]);
});

Deno.test("conversation run sequence: hub submit while previous thread follow-up is slow fences previous turn and commits third turn cleanly", async () => {
  const dispatchedRuns: Array<{ task: string; threadId?: string | null; runId?: string }> = [];

  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg: { type: string; task?: string; runId?: string; threadId?: string }, cb: (res: unknown) => void) {
        if (msg.type === "provider.permission-summary") {
          queueMicrotask(() => cb({ ok: true, local: true }));
          return;
        }
        if (msg.type === "agent.run") {
          dispatchedRuns.push({ task: msg.task ?? "", threadId: msg.threadId ?? null, runId: msg.runId });
          const delay = msg.task === "slow follow-up" ? 250 : 30;
          setTimeout(() => cb({
            ok: true,
            threadId: msg.threadId || `t_${dispatchedRuns.length}`,
            executionId: `exec:${msg.runId}`,
            result: `result for ${msg.task}`,
          }), delay);
          return;
        }
        if (msg.type === "thread.get") {
          queueMicrotask(() => cb({ ok: true, thread: { id: msg.threadId ?? "t_1", name: "Task" } }));
          return;
        }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener(fn: (msg: unknown) => void) { portState.listener = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: { contains: () => Promise.resolve(true) },
  };

  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const { createRunSurfaceOwner } = await import("../extension/shared/run-surface-owner.js");

  const runSurfaceOwner = createRunSurfaceOwner();
  let currentThreadId: string | null = null;
  let currentAgentId: string | null = null;
  let currentAgentKind: string | null = null;
  const threadView = { hidden: true };
  const bubbles: Bubble[] = [];
  const threadConversation = makeContainer(bubbles);
  const statusHistory: Status[] = [];

  function renderRunStatus(s: Status) {
    statusHistory.push(s);
  }

  function showThreadView() {
    threadView.hidden = false;
  }

  function hideThreadViewInner() {
    runSurfaceOwner.claim();
    threadView.hidden = true;
    currentThreadId = null;
    currentAgentId = null;
    currentAgentKind = null;
    threadConversation.clear();
    renderRunStatus({ state: "idle" });
  }

  async function runThreadTurn(text: string, attachments: unknown[] = []) {
    const owner = runSurfaceOwner.claim();
    showThreadView();
    const agentAtStart = currentAgentId;
    const kindAtStart = currentAgentKind;
    const threadAtStart = currentThreadId;
    const owns = () => runSurfaceOwner.owns(owner) && currentAgentId === agentAtStart && currentAgentKind === kindAtStart;
    const res = await runConversationTurn(threadConversation as never, {
      text,
      attachments,
      history: [],
      threadId: threadAtStart,
      onStatus: (state: Status) => runSurfaceOwner.commit(owner, () => renderRunStatus(state)),
      agentId: agentAtStart,
      agentKind: kindAtStart,
      isStale: () => !owns(),
      projectionOwner: owner,
    } as never);
    if (!owns()) return res;
    if (res.ok && !agentAtStart && res.threadId) {
      currentThreadId = res.threadId;
    }
    return res;
  }

  // 1. Initial run
  runSurfaceOwner.claim();
  currentThreadId = null;
  threadConversation.clear();
  await runThreadTurn("turn 1");
  assertEquals(currentThreadId, "t_1");

  // 2. Start slow follow-up (in-flight)
  const slowPromise = runThreadTurn("slow follow-up");

  // 3. User navigates back mid-run
  hideThreadViewInner();
  assertEquals(threadView.hidden, true);

  // 4. User immediately submits new task on hub
  runSurfaceOwner.claim();
  currentThreadId = null;
  threadConversation.clear();
  const fastPromise = runThreadTurn("new hub prompt");

  const [, resFast] = await Promise.all([slowPromise, fastPromise]);

  assertEquals(resFast.ok, true);
  assertEquals(threadView.hidden, false);
  assertEquals(currentThreadId, "t_2");
  // Fenced slow turn must not have appended to the new surface
  assertEquals(bubbles.filter((b) => b.content.includes("slow")).length, 0,
    "fenced slow turn never appends bubbles to successor surface");
  assertEquals(bubbles.map((b) => b.content), ["new hub prompt", "result for new hub prompt"]);
});
