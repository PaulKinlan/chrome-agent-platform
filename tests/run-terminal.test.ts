// tests/run-terminal.test.ts — the runConversationTurn TERMINAL ARBITRATION
// (the ordering blocker): BOTH channel orderings must settle in-flight tool
// cards exactly once, on the AUTHORITATIVE final event. Driven at the REAL
// runConversationTurn boundary with a scripted chrome.runtime mock + a
// recording container + injected grace — deterministic, no wall-clock waits.
// @ts-nocheck — the chrome mock + the container are intentionally dynamic.
import { assert, assertEquals } from "jsr:@std/assert";

function installChromeMock() {
  let portListener = null;
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
        onDisconnect: { addListener() {} },
        postMessage() {},
      }),
    },
  };
  return {
    sent, held,
    emit: (event) => { if (portListener) portListener({ type: "progress", event }); },
    resolveRun(ok, result = "") {
      const h = held.shift();
      if (!h) throw new Error("no held run message");
      h.done(ok ? { ok, result } : { ok, error: "boom" });
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

Deno.test("run-terminal: PORT-before-response — an ok:false tool-result marks the card error; the late response is a no-op", async () => {
  const conv = await import("../extension/shared/conversation.js?t=" + Math.random());
  const prev = conv.RUN_TERMINAL_GRACE_MS;
  conv.setRunTerminalGraceMs(2000);
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
  conv.setRunTerminalGraceMs(prev);
  assert(res?.ok === true);
  assertEquals(container.cards.length, 1, "one card");
  assertEquals(container.cards[0].getAttribute("tool-status"), "error", "the ok:false result wins");
});

Deno.test("run-terminal: RESPONSE-before-port — a delayed done{aborted:true} still settles the cards (error), not success", async () => {
  const conv = await import("../extension/shared/conversation.js?t=" + Math.random());
  const prev = conv.RUN_TERMINAL_GRACE_MS;
  conv.setRunTerminalGraceMs(2000);
  const mock = installChromeMock();
  const container = makeContainer();
  const runP = conv.runConversationTurn(container, { text: "t" });
  await waitFor(() => mock.held.length > 0, "agent.run sent");
  const runId = mock.runId();
  mock.emit({ type: "tool-call", toolName: "memory_get", toolArgs: { key: "x" }, runId });
  mock.resolveRun(true, "ok"); // the response BEATS the port final
  await sleep(30);
  // during the grace the AUTHORITATIVE aborted-done arrives
  mock.emit({ type: "done", aborted: true, runId });
  await sleep(20);
  await runP;
  conv.setRunTerminalGraceMs(prev);
  // the in-flight card was flushed by the arbiter with error (aborted)
  assertEquals(container.cards.length, 1);
  assertEquals(container.cards[0].getAttribute("tool-status"), "error", "aborted done wins over the ok:true response");
});

Deno.test("run-terminal: RESPONSE-before-port — a delayed tool-result ok:false updates the SAME card (never a duplicate)", async () => {
  const conv = await import("../extension/shared/conversation.js?t=" + Math.random());
  const prev = conv.RUN_TERMINAL_GRACE_MS;
  conv.setRunTerminalGraceMs(2000);
  const mock = installChromeMock();
  const container = makeContainer();
  const runP = conv.runConversationTurn(container, { text: "t" });
  await waitFor(() => mock.held.length > 0, "agent.run sent");
  const runId = mock.runId();
  mock.emit({ type: "tool-call", toolName: "memory_set", toolArgs: { key: "x" }, runId });
  mock.resolveRun(true, "ok"); // response first
  await sleep(30);
  mock.emit({ type: "tool-result", toolName: "memory_set", result: "failed: denied", ok: false, durationMs: 12, runId });
  await sleep(10);
  mock.emit({ type: "done", runId });
  await runP;
  conv.setRunTerminalGraceMs(prev);
  assertEquals(container.cards.length, 1, "one card — the delayed result updated the in-flight card, no duplicate");
  assertEquals(container.cards[0].getAttribute("tool-status"), "error");
});

Deno.test("run-terminal: RESPONSE {ok:false} with NO port final — the grace expiry settles as error", async () => {
  const conv = await import("../extension/shared/conversation.js?t=" + Math.random());
  const prev = conv.RUN_TERMINAL_GRACE_MS;
  conv.setRunTerminalGraceMs(60);
  const mock = installChromeMock();
  const container = makeContainer();
  const runP = conv.runConversationTurn(container, { text: "t" });
  await waitFor(() => mock.held.length > 0, "agent.run sent");
  const runId = mock.runId();
  mock.emit({ type: "tool-call", toolName: "memory_set", toolArgs: { key: "x" }, runId });
  mock.resolveRun(false, ""); // {ok:false} and NO port events at all
  const res = await runP;
  assert(res?.ok === false);
  await sleep(120); // grace expires → the arbiter settles
  conv.setRunTerminalGraceMs(prev);
  const errors = container.calls.filter((c) => c[0] === "error");
  assert(errors.length >= 1, "the failure surfaced");
});

Deno.test("run-terminal: the arbiter settles EXACTLY once (both orderings together, idempotent)", async () => {
  const { createRunTerminal } = await import("../extension/shared/conversation.js?t=" + Math.random());
  let settles = 0;
  let fire = null;
  const arb = createRunTerminal({
    graceMs: 1000,
    timers: { setTimeout: (fn) => { fire = fn; return 1; }, clearTimeout: () => {} },
    onSettle: () => { settles += 1; },
  });
  arb.onPortDone(false); // the port final first
  arb.onPortDone(true);
  arb.onPortError();
  arb.onResponse(true); // the late response arms the grace (already settled → no-op)
  assert(settles === 1, "settled exactly once");
  assert(fire === null, "no grace timer armed after settlement");

  const arb2 = createRunTerminal({
    graceMs: 1000,
    timers: { setTimeout: (fn) => { fire = fn; return 2; }, clearTimeout: () => {} },
    onSettle: (st) => { settles += 1; last = st; },
  });
  let last = null;
  arb2.onResponse(true); // response first → arms the grace
  assert(fire !== null, "grace armed");
  // the port's aborted-done arrives DURING the grace → wins
  arb2.onPortDone(true);
  assert(last === "error", "the aborted done wins over the pending response");
  assert(settles === 2, "still exactly once");
  fire && (fire = null);

  const arb3 = createRunTerminal({
    graceMs: 1000,
    timers: { setTimeout: (fn) => { fire = fn; return 3; }, clearTimeout: () => {} },
    onSettle: (st) => { last3 = st; },
  });
  let last3 = null;
  arb3.onResponse(true);
  assert(fire !== null, "grace armed");
  // grace EXPIRES with no port event → the response's ok decides
  const f = fire; fire = null;
  f();
  assert(last3 === "success", "grace expiry settles from the response");
});
