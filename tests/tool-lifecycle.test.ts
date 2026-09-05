// @ts-nocheck — the queue/cards are deliberately dynamic; the runtime behavior is under test.
// tests/tool-lifecycle.test.ts — the live tool-card lifecycle (the tracker
// item 4 review findings): a FIFO per-tool queue that must never leave a card
// permanently running, error-aware status wiring, and the pure failure
// detection both the SW (tool-summary.isToolResultFailure) and the page
// (conversation.isToolErrorEvent) use.
import { assert, assertEquals } from "jsr:@std/assert";
import { createToolCardQueue, isToolErrorEvent, pairToolJournal } from "../extension/shared/conversation.js";
import { isToolResultFailure } from "../extension/lib/tool-summary.js";

function fakeCard(attrs = {}) {
  const state = { ...attrs };
  return {
    setAttribute(name, value) { state[name] = String(value); },
    get(name) { return state[name]; },
  };
}

Deno.test("tool-lifecycle: the queue matches parallel same-name calls FIFO", () => {
  const q = createToolCardQueue();
  const a = fakeCard(), b = fakeCard(), c = fakeCard();
  q.push("memory_get", a);
  q.push("memory_get", b);
  q.push("memory_set", c);
  assertEquals(q.pendingCount(), 3);
  assert(q.peek("memory_get") === a, "owner metadata can decorate the oldest card without consuming it");
  assertEquals(q.pendingCount(), 3, "peek is non-consuming");
  assert(q.take("memory_get") === a, "oldest first");
  assert(q.take("memory_get") === b, "second in order");
  assert(q.take("memory_set") === c, "different name resolves independently");
  assertEquals(q.take("memory_get"), null, "an empty queue returns null");
  assertEquals(q.pendingCount(), 0);
});

Deno.test("tool-lifecycle: flush resolves every in-flight card (never permanently running)", () => {
  const q = createToolCardQueue();
  const a = fakeCard(), b = fakeCard();
  q.push("a", a);
  q.push("b", b);
  const n = q.flush("error");
  assertEquals(n, 2);
  assertEquals(a.get("tool-status"), "error");
  assertEquals(b.get("tool-status"), "error");
  assertEquals(q.pendingCount(), 0);
});

Deno.test("tool-lifecycle: success/abort lifecycle resolves cards with the right status", () => {
  const q = createToolCardQueue();
  const ok = fakeCard(), aborted = fakeCard();
  q.push("t", ok);
  q.flush("success");
  assertEquals(ok.get("tool-status"), "success");
  q.push("t", aborted);
  q.flush("error"); // an abort / run error
  assertEquals(aborted.get("tool-status"), "error");
});

Deno.test("tool-lifecycle: a FAILED tool result marks the card error, success stays success", () => {
  const q = createToolCardQueue();
  const failed = fakeCard(), ok = fakeCard();
  q.push("memory_set", failed);
  const card = q.take("memory_set");
  const err = isToolErrorEvent({ ok: false, result: "failed: the write was rejected" });
  assert(err === true, "ok:false → error");
  card.setAttribute?.("tool-status", err ? "error" : "success");
  assertEquals(failed.get("tool-status"), "error");

  q.push("memory_get", ok);
  const okCard = q.take("memory_get");
  const okErr = isToolErrorEvent({ ok: true, result: "read 1 key" });
  assert(okErr === false, "ok:true → success");
  okCard.setAttribute?.("tool-status", okErr ? "error" : "success");
  assertEquals(ok.get("tool-status"), "success");
});

Deno.test("tool-lifecycle: ok is AUTHORITATIVE — heuristics only when ok is absent", () => {
  // a valid summary like "failed attempts: 0" with ok:true must NOT error
  assert(isToolErrorEvent({ ok: true, result: "failed: origin re-enrolled" }) === false, "ok:true wins over the text");
  assert(isToolErrorEvent({ ok: true, result: "failed attempts: 0" }) === false);
  assert(isToolErrorEvent({ ok: false, result: "stored 2 items" }) === true, "ok:false wins too");
  // heuristics only when ok is absent
  assert(isToolErrorEvent({ result: "[memory_set] DENIED by hook — quota" }) === true);
  assert(isToolErrorEvent({ result: "failed: origin re-enrolled" }) === true);
  assert(isToolErrorEvent({ result: "stored 2 items" }) === false);
  assert(isToolErrorEvent({ result: "" }) === false);
  assert(isToolErrorEvent({}) === false);
  assert(isToolErrorEvent(null) === false);
});

Deno.test("tool-lifecycle: isToolResultFailure (SW side) detects returned failure shapes", () => {
  assert(isToolResultFailure({ ok: false, error: "memory not written" }) === true);
  assert(isToolResultFailure({ ok: false }) === true);
  assert(isToolResultFailure({ error: "boom" }) === true);
  assert(isToolResultFailure({ blocked: true, reason: "hook-denied" }) === true);
  assert(isToolResultFailure({ userSummary: "[memory_set] DENIED by hook — quota" }) === true);
  assert(isToolResultFailure({ userSummary: "stored 2 items", modelContent: "ok" }) === false);
  assert(isToolResultFailure({ ok: true }) === false);
  assert(isToolResultFailure("just a string") === false);
  assert(isToolResultFailure(null) === false);
});


Deno.test("tool-lifecycle: pairToolJournal pairs a call with its result into ONE terminal card", () => {
  const entries = [
    { type: "tool-call", id: "r1", callId: "r1:memory_set:1", tool: "memory_set", args: "{\"key\":\"x\"}" },
    { type: "tool-result", id: "r1", callId: "r1:memory_set:1", tool: "memory_set", result: "stored", ok: true },
  ];
  const pairs = pairToolJournal(entries);
  assertEquals(pairs.length, 1, "one card per call");
  assertEquals(pairs[0].tool, "memory_set");
  assertEquals(pairs[0].status, "success");
  assert(pairs[0].args.includes("x"));
});

Deno.test("tool-lifecycle: a FAILED (ok:false) persisted result renders an ERROR card", () => {
  const entries = [
    { type: "tool-call", id: "r1", callId: "c1", tool: "memory_set", args: "{}" },
    { type: "tool-result", id: "r1", callId: "c1", tool: "memory_set", result: "failed: denied", ok: false },
  ];
  const [card] = pairToolJournal(entries);
  assertEquals(card.status, "error");
  assertEquals(card.ok, false);
});

Deno.test("tool-lifecycle: parallel same-name calls pair FIFO by callId", () => {
  const entries = [
    { type: "tool-call", callId: "c1", tool: "memory_get", args: "{\"k\":1}" },
    { type: "tool-call", callId: "c2", tool: "memory_get", args: "{\"k\":2}" },
    { type: "tool-result", callId: "c1", tool: "memory_get", result: "one", ok: true },
    { type: "tool-result", callId: "c2", tool: "memory_get", result: "two", ok: true },
  ];
  const pairs = pairToolJournal(entries);
  assertEquals(pairs.length, 2);
  assert(pairs[0].args.includes("1"));
  assert(pairs[1].args.includes("2"));
});

Deno.test("tool-lifecycle: an UNPAIRED tool-call renders a terminal (done) card — never running", () => {
  const [card] = pairToolJournal([{ type: "tool-call", callId: "c1", tool: "memory_set", args: "{}" }]);
  assertEquals(card.status, "done");
  assertEquals(card.result, null);
});

Deno.test("tool-lifecycle: task/result rows pass through untouched", () => {
  const pairs = pairToolJournal([
    { type: "task", id: "t", task: "do it" },
    { type: "tool-call", callId: "c1", tool: "memory_set", args: "{}" },
    { type: "tool-result", callId: "c1", tool: "memory_set", result: "ok", ok: true },
    { type: "result", id: "t", result: "done" },
  ]);
  assertEquals(pairs.length, 1, "only the tool rows pair");
});

// ── the sol-review replay fixes: legacy pairing, ok-heuristics, run isolation ──

Deno.test("tool-lifecycle: LEGACY rows (no callId) pair by (id, tool, occurrence)", () => {
  const entries = [
    { type: "tool-call", id: "r1", tool: "memory_set", args: "{}" },
    { type: "tool-result", id: "r1", tool: "memory_set", result: "stored", ok: true },
  ];
  const pairs = pairToolJournal(entries);
  assertEquals(pairs.length, 1, "the legacy call + result PAIR into one card");
  assertEquals(pairs[0].status, "success");
});

Deno.test("tool-lifecycle: legacy absent-ok uses the TEXT heuristic (failed restores as error)", () => {
  const [failed] = pairToolJournal([
    { type: "tool-result", id: "r1", tool: "memory_get", result: "failed: origin re-enrolled" },
  ]);
  assertEquals(failed.status, "error", "legacy failed text → error, not a blanket success");
  const [ok] = pairToolJournal([
    { type: "tool-result", id: "r1", tool: "memory_get", result: "read 1 key" },
  ]);
  assertEquals(ok.status, "success");
  const [denied] = pairToolJournal([
    { type: "tool-result", id: "r1", tool: "memory_set", result: "[memory_set] DENIED by hook — quota" },
  ]);
  assertEquals(denied.status, "error");
});

Deno.test("tool-lifecycle: RUN-INSTANCE scoped callIds isolate repeated scheduled runs", () => {
  // two runs of the SAME taskId (a scheduled alarm.name) with distinct run
  // instances — each renders its own terminal card, never collapsed
  const entries = [
    { type: "tool-call", id: "schedule", run: "a1", callId: "schedule:a1:memory_set:1", tool: "memory_set", args: "{\"k\":1}" },
    { type: "tool-result", id: "schedule", run: "a1", callId: "schedule:a1:memory_set:1", tool: "memory_set", result: "one", ok: true },
    { type: "tool-call", id: "schedule", run: "b2", callId: "schedule:b2:memory_set:1", tool: "memory_set", args: "{\"k\":2}" },
    { type: "tool-result", id: "schedule", run: "b2", callId: "schedule:b2:memory_set:1", tool: "memory_set", result: "two", ok: true },
  ];
  const pairs = pairToolJournal(entries);
  assertEquals(pairs.length, 2, "two runs → two cards");
  assert(pairs[0].args.includes("1") || pairs[0].args.includes("2"));
});

Deno.test("tool-lifecycle: an UNMATCHED result gets a unique id (no repeated :1 collapse)", () => {
  const pairs = pairToolJournal([
    { type: "tool-result", id: "r1", tool: "memory_get", result: "one", ok: true },
    { type: "tool-result", id: "r1", tool: "memory_get", result: "two", ok: false },
  ]);
  assertEquals(pairs.length, 2, "two unmatched results → two distinct cards");
  assertEquals(pairs[0].status, "success");
  assertEquals(pairs[1].status, "error");
});

// ── the final-sol acceptance: same-name isolation + duplicate semantics ─────

Deno.test("tool-lifecycle: TWO same-name calls keep DISTINCT cards (original callIds preserved)", () => {
  const rows = [
    { type: "tool-call", id: "r1", run: "a", callId: "r1:a:memory_get:1", tool: "memory_get", args: "{\"k\":1}" },
    { type: "tool-result", id: "r1", run: "a", callId: "r1:a:memory_get:1", tool: "memory_get", result: "one", ok: true },
    { type: "tool-call", id: "r1", run: "a", callId: "r1:a:memory_get:2", tool: "memory_get", args: "{\"k\":2}" },
    { type: "tool-result", id: "r1", run: "a", callId: "r1:a:memory_get:2", tool: "memory_get", result: "two", ok: true },
  ];
  const pairs = pairToolJournal(rows);
  assertEquals(pairs.length, 2, "two cards, never collapsed");
  assert(pairs[0].callId !== pairs[1].callId, "distinct original callIds survive");
  assert(pairs[0].args.includes("1") && pairs[1].args.includes("2"), "each card keeps its own args");
});

Deno.test("tool-lifecycle: a NORMAL call+result pair is NOT flagged duplicate; a second same-type row IS", () => {
  const normal = pairToolJournal([
    { type: "tool-call", callId: "c1", tool: "memory_set", args: "{}" },
    { type: "tool-result", callId: "c1", tool: "memory_set", result: "ok", ok: true },
  ]);
  assertEquals(normal.length, 1);
  assertEquals(normal[0].duplicate, false, "the complementary result is NOT a duplicate");
  const dupCall = pairToolJournal([
    { type: "tool-call", callId: "c1", tool: "memory_set", args: "{}" },
    { type: "tool-call", callId: "c1", tool: "memory_set", args: "{}" }, // a SECOND call
    { type: "tool-result", callId: "c1", tool: "memory_set", result: "ok", ok: true },
  ]);
  assertEquals(dupCall.length, 1);
  assertEquals(dupCall[0].duplicate, true, "a second same-type call IS flagged");
  const dupResult = pairToolJournal([
    { type: "tool-result", callId: "c1", tool: "memory_set", result: "a", ok: true },
    { type: "tool-result", callId: "c1", tool: "memory_set", result: "b", ok: true }, // a SECOND result
  ]);
  assertEquals(dupResult.length, 1);
  assertEquals(dupResult[0].duplicate, true, "a second same-type result IS flagged");
});

Deno.test("tool-lifecycle: a persisted terminal row (with its own args) restores the args on replay", () => {
  const [card] = pairToolJournal([
    { type: "tool-result", callId: "replay:run:memory_set", tool: "memory_set", args: '{"key":"shopping"}', result: "stored", ok: true },
  ]);
  assertEquals(card.status, "success");
  assert(card.args !== null && card.args.includes("shopping"), "the terminal row's own args restore on replay");
});

// ── the frozen-tip acceptance: the ORIGINAL immutable callId survives ───────

Deno.test("tool-lifecycle: the pair outputs the ORIGINAL immutable callId (never the composite run::callId key)", () => {
  const rows = [
    { type: "tool-call", id: "r1", run: "runX", callId: "r1:runX:memory_get:1", tool: "memory_get", args: "{}" },
    { type: "tool-result", id: "r1", run: "runX", callId: "r1:runX:memory_get:1", tool: "memory_get", result: "ok", ok: true },
  ];
  const [pair] = pairToolJournal(rows);
  assertEquals(pair.callId, "r1:runX:memory_get:1", "the ORIGINAL callId is preserved verbatim");
  // a reload re-pairs the persisted callId — it must NOT grow another prefix
  const [round2] = pairToolJournal([
    { type: "tool-result", id: "r1", run: null, callId: pair.callId, tool: "memory_get", args: "{}", result: "ok", ok: true },
  ]);
  assertEquals(round2.callId, pair.callId, "the id is IMMUTABLE across a reload round-trip");
});

// ── the successor review: hostile tool results never become [object Object] ──

Deno.test("tool-lifecycle: a CYCLIC/hostile tool result never renders [object Object]", async () => {
  const { safeToolResult } = await import("../extension/shared/conversation.js?t=" + Math.random());
  const cyclic = { n: 1 };
  cyclic.self = cyclic;
  const out = safeToolResult(cyclic);
  assert(!out.includes("[object Object]"), "no [object Object] fallback");
  assert(typeof out === "string" && out.length > 0, "a readable bounded serialization");
  const hostile = { get toJSON() { throw new Error("x"); } };
  const out2 = safeToolResult(hostile);
  assert(!out2.includes("[object Object]"), "no [object Object] for a hostile object");
});
