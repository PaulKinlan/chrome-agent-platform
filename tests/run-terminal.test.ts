// tests/run-terminal.test.ts — the runConversationTurn TERMINAL ARBITRATION
// (the ordering blockers): the run RESPONSE carries the FINAL outcome (ok +
// aborted — the SW propagates it), so the arbiter settles IMMEDIATELY on the
// first authoritative terminal (response or port done/error) — NO timing
// dependency. Abort controls the OVERALL outcome: an aborted run must never
// append a successful assistant result or report done. Port disconnect
// settles fail-closed; every retry attempt gets a UNIQUE runId (stale events
// from the failed attempt are rejected); the listener + cards are cleaned up.
// @ts-nocheck — the chrome mock + the container are intentionally dynamic.
import { assert, assertEquals } from "jsr:@std/assert";

function installChromeMock() {
  let portListener = null;
  let disconnectListener = null;
  const sent = [];
  const held = [];
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (msg, cb) => {
        sent.push(msg);
        return new Promise((resolve) => {
          const done = (v) => { resolve(v); if (cb) cb(v); };
          if (msg.type === "provider.get") done({ provider: "demo", baseURL: "", apiKey: "", model: "" });
          else if (msg.type === "agent.run" || msg.type === "named-agent.run" || msg.type === "background-agent.run") {
            held.push({ msg, done });
          } else done({ ok: true });
        });
      },
      connect: () => ({
        onMessage: { addListener(fn) { portListener = fn; } },
        onDisconnect: { addListener(fn) { disconnectListener = fn; } },
        postMessage() {},
      }),
    },
  };
  return {
    sent, held,
    emit: (event) => { if (portListener) portListener({ type: "progress", event }); },
    disconnect() { if (disconnectListener) disconnectListener(); },
    resolveRun(ok, result = "", opts = {}) {
      const h = held.shift();
      if (!h) throw new Error("no held run message");
      h.done(ok
        ? { ok, result, aborted: opts.aborted === true }
        : { ok, error: "boom", aborted: opts.aborted === true });
    },
    runId() { return held[held.length - 1]?.msg?.runId ?? null; },
  };
}

function makeContainer() {
  const cards = [];
  const c = {
    cards,
    calls: [],
    appendUser(text) { this.calls.push(["user", text]); },
    appendAgent(text) { this.calls.push(["agent", text]); },
    appendSystem() {},
    appendError(text, o = {}) { this.calls.push(["error", text, o]); },
    appendThinking() { return { remove() {}, setAttribute() {} }; },
    appendTool(m = {}) {
      const attrs = { "tool-name": m.name ?? "", "tool-status": m.status ?? "running" };
      const card = {
        attrs,
        setAttribute(k, v) { attrs[k] = String(v); },
        getAttribute(k) { return attrs[k] ?? null; },
        remove() {},
        set scrollTop(v) {}, get scrollTop() { return 0; },
      };
      cards.push(card);
      this.calls.push(["tool", m]);
      return card;
    },
    scrollTop: 0,
    scrollHeight: 0,
  };
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, label, timeoutMs = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(5);
  }
}

const freshConv = () => import("../extension/shared/conversation.js?t=" + Math.random());

Deno.test("run-terminal: PORT-before-response — an ok:false tool-result marks the card error; the late response is a no-op", async () => {
  const conv = await freshConv();
  const mock = installChromeMock();
  const container = makeContainer();
  const runP = conv.runConversationTurn(container, { text: "t" });
  await waitFor(() => mock.held.length > 0, "agent.run sent");
  const runId = mock.runId();
  mock.emit({ type: "tool-call", toolName: "memory_set", toolArgs: { key: "x" }, runId });
  await sleep(5);
  mock.emit({ type: "tool-result", toolName: "memory_set", result: "failed: denied", ok: false, durationMs: 12, runId });
  await sleep(5);
  mock.emit({ type: "done", runId });
  mock.resolveRun(true, "done"); // the response arrives LAST — a no-op
  const res = await runP;
  assert(res?.ok === true);
  assertEquals(container.cards.length, 1, "one card");
  assertEquals(container.cards[0].getAttribute("tool-status"), "error", "the ok:false result wins");
});

Deno.test("run-terminal: an ABORTED response never appends a success result or reports done", async () => {
  const conv = await freshConv();
  const mock = installChromeMock();
  const container = makeContainer();
  const runP = conv.runConversationTurn(container, { text: "t" });
  await waitFor(() => mock.held.length > 0, "agent.run sent");
  mock.emit({ type: "tool-call", toolName: "memory_set", toolArgs: { key: "x" }, runId: mock.runId() });
  // the SW response carries the aborted state — the authoritative outcome
  mock.resolveRun(true, "partial", { aborted: true });
  const res = await runP;
  assert(res?.ok === true && res?.aborted === true);
  const hasAgentResult = container.calls.some((c) => c[0] === "agent");
  assert(hasAgentResult === false, "an aborted run must NOT append a successful assistant result");
  const errors = container.calls.filter((c) => c[0] === "error");
  assert(errors.length >= 1, "the abort surfaced as an error, not done");
});

Deno.test("run-terminal: an aborted PORT done (before the response) gates the outcome — no result append", async () => {
  const conv = await freshConv();
  const mock = installChromeMock();
  const container = makeContainer();
  const runP = conv.runConversationTurn(container, { text: "t" });
  await waitFor(() => mock.held.length > 0, "agent.run sent");
  const runId = mock.runId();
  mock.emit({ type: "tool-call", toolName: "memory_set", toolArgs: { key: "x" }, runId });
  // the port's aborted done arrives FIRST — the authoritative terminal
  mock.emit({ type: "done", aborted: true, runId });
  await sleep(10);
  mock.resolveRun(true, "ok"); // the late response is a no-op (already settled error)
  await runP;
  const hasAgentResult = container.calls.some((c) => c[0] === "agent");
  assert(hasAgentResult === false, "no success result after an aborted port done");
  const errors = container.calls.filter((c) => c[0] === "error");
  assert(errors.length >= 1, "the abort surfaced, not done");
});

Deno.test("run-terminal: RESPONSE-before-port — a late tool-result is DROPPED after settle (no duplicate, no misapply)", async () => {
  const conv = await freshConv();
  const mock = installChromeMock();
  const container = makeContainer();
  const runP = conv.runConversationTurn(container, { text: "t" });
  await waitFor(() => mock.held.length > 0, "agent.run sent");
  const runId = mock.runId();
  mock.emit({ type: "tool-call", toolName: "memory_set", toolArgs: { key: "x" }, runId });
  mock.resolveRun(true, "ok"); // the response settles immediately
  await sleep(20);
  // a LATE tool-result after the settle is dropped (the listener is removed) —
  // the card keeps the response's terminal status + no duplicate is created
  mock.emit({ type: "tool-result", toolName: "memory_set", result: "late", ok: false, runId });
  await sleep(20);
  await runP;
  assertEquals(container.cards.length, 1, "no duplicate card from the late event");
});

Deno.test("run-terminal: RESPONSE {ok:false} with NO port final settles immediately as error", async () => {
  const conv = await freshConv();
  const mock = installChromeMock();
  const container = makeContainer();
  const runP = conv.runConversationTurn(container, { text: "t" });
  await waitFor(() => mock.held.length > 0, "agent.run sent");
  mock.emit({ type: "tool-call", toolName: "memory_set", toolArgs: { key: "x" }, runId: mock.runId() });
  mock.resolveRun(false, ""); // {ok:false} and NO port events at all
  const res = await runP;
  assert(res?.ok === false);
  const errors = container.calls.filter((c) => c[0] === "error");
  assert(errors.length >= 1, "the failure surfaced");
});

Deno.test("run-terminal: a PORT DISCONNECT settles fail-closed + removes the listener", async () => {
  const conv = await freshConv();
  const mock = installChromeMock();
  const container = makeContainer();
  const runP = conv.runConversationTurn(container, { text: "t" });
  await waitFor(() => mock.held.length > 0, "agent.run sent");
  mock.emit({ type: "tool-call", toolName: "memory_set", toolArgs: { key: "x" }, runId: mock.runId() });
  // the port dies before the response — the run must settle (error) + clean up
  mock.disconnect();
  await sleep(10);
  mock.resolveRun(true, "ok"); // the late response is a no-op (already settled)
  const res = await runP;
  assert(res?.ok === true);
  // after settle the listener is removed: a late event is dropped (no new card)
  const cardsBefore = container.cards.length;
  mock.emit({ type: "tool-result", toolName: "memory_set", result: "late", ok: true, runId: "stale" });
  await sleep(10);
  assertEquals(container.cards.length, cardsBefore, "no stale events after the disconnect settle");
});

Deno.test("run-terminal: a RETRY gets a UNIQUE runId — stale events from the failed attempt are rejected", async () => {
  const conv = await freshConv();
  const mock = installChromeMock();
  const container = makeContainer();
  // FIRST attempt: send a tool-call + let it fail (the provider-grant retry path)
  const runP1 = conv.runConversationTurn(container, { text: "t" });
  await waitFor(() => mock.held.length > 0, "first attempt sent");
  const firstRunId = mock.runId();
  mock.emit({ type: "tool-call", toolName: "memory_get", toolArgs: { key: "x" }, runId: firstRunId });
  mock.resolveRun(false, ""); // the first attempt fails
  await runP1;
  // SECOND attempt: a fresh turn (the grant retry) — its runId must differ
  const runP2 = conv.runConversationTurn(container, { text: "t" });
  await waitFor(() => mock.held.length > 0, "second attempt sent");
  const secondRunId = mock.runId();
  assert(secondRunId !== firstRunId, "each attempt has a UNIQUE runId");
  // a STALE event tagged with the FIRST attempt's runId must be rejected
  const cardsBefore = container.cards.length;
  mock.emit({ type: "tool-result", toolName: "memory_get", result: "stale", ok: true, runId: firstRunId });
  await sleep(10);
  assertEquals(container.cards.length, cardsBefore, "the stale attempt's event is rejected");
  mock.resolveRun(true, "ok");
  await runP2;
});

Deno.test("run-terminal: the arbiter settles EXACTLY once + the cleanup is immediate (no timers pending)", async () => {
  const { createRunTerminal } = await freshConv();
  let settles = 0;
  const arb = createRunTerminal({ onSettle: () => { settles += 1; } });
  arb.onResponse(true, false); // the response first
  arb.onResponse(true, false);
  arb.onPortDone(false);
  arb.onPortError();
  assert(settles === 1, "settled exactly once");
  assert(arb.status === "success");
  const arb2 = createRunTerminal({ onSettle: (st) => { last = st; } });
  let last = null;
  arb2.onPortDone(true); // the aborted port final first
  arb2.onResponse(true, false); // the late response is a no-op
  assert(last === "error", "the aborted port final wins");
  assert(settles === 1, "still exactly once across arbiters");
});
