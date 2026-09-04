// tests/run-permission-remediation.test.ts — post-error permission
// remediation (CAP-FB-20260819-PERMISSION-REMEDIATION-UX-01, increment 2,
// chrome-agent-platform-4dg). A run that ENDS on a host-permission failure
// must render ONE in-context remediation card (never the old "Open Settings →
// Providers" dead-end): Allow requests exactly the provider origin from the
// owner's genuine click and retries the SAME turn exactly once; Not now ends
// honestly; a second permission terminal never loops a second card.
// Drives the REAL extension/shared/conversation.js with a stubbed
// chrome/DOM at the messaging boundary (same harness family as
// conversation-run-sequence.test.ts).

import { assert, assertEquals } from "jsr:@std/assert@1";

async function waitForCondition(fn: () => boolean, timeoutMs: number, label: string) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

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

interface RemediationOpts {
  origin: string;
  local?: boolean;
  runs: string[];
  requests: Array<string[]>;
  /** which agent.run calls fail with a host-permission terminal (1-based) */
  failingRuns?: Set<number>;
  /** chrome.permissions.request results, consumed in order (default true) */
  requestResults?: boolean[];
}

function installRemediationChrome(opts: RemediationOpts) {
  let runCall = 0;
  let requestCall = 0;
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg: { type: string; task?: string }, cb: (res: unknown) => void) {
        if (msg.type === "provider.permission-summary") {
          queueMicrotask(() => cb({ ok: true, provider: "openai", local: opts.local === true, origin: opts.origin, reason: "" }));
          return;
        }
        if (msg.type === "agent.run") {
          runCall += 1;
          opts.runs.push(msg.task ?? "");
          const fails = opts.failingRuns?.has(runCall) ?? false;
          queueMicrotask(() => cb(fails
            ? {
              ok: false,
              error: "the provider refused the connection",
              errorCategory: "host-permission",
              errorReason: "the provider's origin is not granted",
              errorAction: "grant the provider origin",
            }
            : { ok: true, threadId: "t_remed", executionId: `exec_remed_${runCall}`, result: "[demo] provider answer" }));
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
      // Preflight PASSES (the failure is a mid-run/post-error one, not the
      // pre-run pause that increment 1 covers).
      contains: async () => true,
      request: async (query: { origins?: string[] }) => {
        opts.requests.push([...(query?.origins ?? [])]);
        const results = opts.requestResults;
        if (!results) return true;
        const r = results[requestCall] ?? false;
        requestCall += 1;
        return r;
      },
    },
  };
}

function makeContainer() {
  const bubbles: Array<{ role: string; content: string }> = [];
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

const ORIGIN = "https://api.provider.example";

Deno.test("run remediation: a host-permission terminal renders ONE in-context card — Allow grants the exact origin and retries the same turn once", async () => {
  const runs: string[] = [];
  const requests: Array<string[]> = [];
  installRemediationChrome({ origin: ORIGIN, runs, requests, failingRuns: new Set([1]) });
  const dom = installCardDocument();
  try {
    const { runConversationTurn } = await import("../extension/shared/conversation.js");
    const { bubbles, container } = makeContainer();
    const turn = runConversationTurn(container as never, { text: "do the thing" } as never);
    await waitForCondition(() => dom.cards.length === 1, 2000, "the remediation card renders");
    // The dead-end Settings-redirect bubble is GONE.
    assert(bubbles.every((b) => !/open settings → providers/i.test(b.content)),
      "no Settings-redirect bubble for a permission a card can grant");
    const card = dom.cards[0];
    assert(String(card.getAttribute("reason") ?? "").includes("api.provider.example"), "the card names the provider host");
    assertEquals(card.getAttribute("host-origins"), JSON.stringify([ORIGIN]), "the card carries the exact origin");
    assertEquals(runs.length, 1, "the first attempt ran and failed before the card");
    card.dispatchEvent({ type: "approve", detail: { sourceEvent: { isTrusted: true } } });
    const res = await turn;
    assertEquals(requests.length, 1, "one permission request from the genuine click");
    assertEquals(requests[0], [`${ORIGIN}/*`], "the request is exactly the provider's origin pattern");
    assertEquals(runs.length, 2, "the SAME turn is retried exactly once after the grant");
    assertEquals(runs[1], "do the thing", "the retry carries the same task text");
    assertEquals(res.ok, true, "the retried run completes");
    assertEquals(card.getAttribute("state"), "granted");
  } finally {
    dom.restore();
  }
});

Deno.test("run remediation: Not now — honest declined line, no retry, nothing requested", async () => {
  const runs: string[] = [];
  const requests: Array<string[]> = [];
  installRemediationChrome({ origin: ORIGIN, runs, requests, failingRuns: new Set([1]) });
  const dom = installCardDocument();
  try {
    const { runConversationTurn } = await import("../extension/shared/conversation.js");
    const { bubbles, container } = makeContainer();
    const turn = runConversationTurn(container as never, { text: "do the thing" } as never);
    await waitForCondition(() => dom.cards.length === 1, 2000, "the remediation card renders");
    dom.cards[0].dispatchEvent({ type: "deny", detail: { sourceEvent: { isTrusted: true } } });
    const res = await turn;
    assertEquals(res.ok, false, "the turn stays failed after a decline");
    assertEquals(runs.length, 1, "the run is never re-dispatched after Not now");
    assertEquals(requests.length, 0, "nothing is requested on a decline");
    assert(bubbles.some((b) => b.role === "system" && /you declined/.test(b.content)),
      "an honest declined line names the outcome");
    assertEquals(dom.cards.length, 1, "exactly one card ever renders");
  } finally {
    dom.restore();
  }
});

Deno.test("run remediation: a second permission terminal never loops a second card", async () => {
  const runs: string[] = [];
  const requests: Array<string[]> = [];
  // BOTH attempts fail on host-permission: the owner grants, the retry still
  // fails — the conversation must end on an honest line, not a second card.
  installRemediationChrome({ origin: ORIGIN, runs, requests, failingRuns: new Set([1, 2]) });
  const dom = installCardDocument();
  try {
    const { runConversationTurn } = await import("../extension/shared/conversation.js");
    const { bubbles, container } = makeContainer();
    const turn = runConversationTurn(container as never, { text: "do the thing" } as never);
    await waitForCondition(() => dom.cards.length === 1, 2000, "the first remediation card renders");
    dom.cards[0].dispatchEvent({ type: "approve", detail: { sourceEvent: { isTrusted: true } } });
    const res = await turn;
    assertEquals(res.ok, false, "the turn ends failed after the failed retry");
    assertEquals(runs.length, 2, "exactly one retry — no further attempts");
    assertEquals(dom.cards.length, 1, "no second card is ever rendered");
    assert(bubbles.some((b) => b.role === "system" && /still not granted/.test(b.content)),
      "the second failure gets an honest terminal line");
  } finally {
    dom.restore();
  }
});

Deno.test("run remediation: Chrome-refused Allow leaves the card actionable — a later Allow grants and retries", async () => {
  const runs: string[] = [];
  const requests: Array<string[]> = [];
  installRemediationChrome({ origin: ORIGIN, runs, requests, failingRuns: new Set([1]), requestResults: [false, true] });
  const dom = installCardDocument();
  try {
    const { runConversationTurn } = await import("../extension/shared/conversation.js");
    const { bubbles, container } = makeContainer();
    const turn = runConversationTurn(container as never, { text: "do the thing" } as never);
    await waitForCondition(() => dom.cards.length === 1, 2000, "the remediation card renders");
    const card = dom.cards[0];
    card.dispatchEvent({ type: "approve", detail: { sourceEvent: { isTrusted: true } } });
    await waitForCondition(() => requests.length === 1, 2000, "the refused request is recorded");
    assertEquals(runs.length, 1, "a refused request never starts the retry");
    // The refusal surfaces as the card's error state — visible, actionable,
    // never marked granted. Wait for it (the owner re-clicks from that state).
    await waitForCondition(() => card.getAttribute("state") === "error", 2000, "the refusal surfaces as the card error state");
    assert(String(card.getAttribute("detail") ?? "").length > 0, "the error state carries an honest detail line");
    // The card stays actionable: a second genuine Allow succeeds.
    card.dispatchEvent({ type: "approve", detail: { sourceEvent: { isTrusted: true } } });
    const res = await turn;
    assertEquals(requests.length, 2, "the second Allow requests again");
    assertEquals(res.ok, true, "the granted retry completes the turn");
    assertEquals(runs.length, 2, "exactly one retry after the successful grant");
  } finally {
    dom.restore();
  }
});

Deno.test("run remediation: a local provider terminal keeps the honest Settings line — no card to grant", async () => {
  const runs: string[] = [];
  const requests: Array<string[]> = [];
  installRemediationChrome({ origin: ORIGIN, local: true, runs, requests, failingRuns: new Set([1]) });
  const dom = installCardDocument();
  try {
    const { runConversationTurn } = await import("../extension/shared/conversation.js");
    const { bubbles, container } = makeContainer();
    const turn = runConversationTurn(container as never, { text: "do the thing" } as never);
    const res = await turn;
    assertEquals(res.ok, false);
    assertEquals(dom.cards.length, 0, "no card renders when there is nothing a card can grant");
    assertEquals(requests.length, 0, "nothing is requested");
    assert(bubbles.some((b) => b.role === "system" && /settings → providers/i.test(b.content)),
      "the honest line points at Settings when the ask is not a host grant");
  } finally {
    dom.restore();
  }
});
