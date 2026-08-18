// @ts-nocheck — the queue/cards are deliberately dynamic; the runtime behavior is under test.
// tests/tool-lifecycle.test.ts — the live tool-card lifecycle (the tracker
// item 4 review findings): a FIFO per-tool queue that must never leave a card
// permanently running, error-aware status wiring, and the pure failure
// detection both the SW (tool-summary.isToolResultFailure) and the page
// (conversation.isToolErrorEvent) use.
import { assert, assertEquals } from "jsr:@std/assert";
import { createToolCardQueue, isToolErrorEvent } from "../extension/shared/conversation.js";
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

Deno.test("tool-lifecycle: isToolErrorEvent falls back to the summarized text markers", () => {
  assert(isToolErrorEvent({ ok: true, result: "failed: origin re-enrolled" }) === true);
  assert(isToolErrorEvent({ result: "[memory_set] DENIED by hook — quota" }) === true);
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
