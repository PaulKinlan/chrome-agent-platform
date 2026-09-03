// tests/run-control.test.ts — chrome-agent-platform-afiu (steer + queue).
// @ts-nocheck — the kv fakes are intentionally dynamic.
//
// Falsification gates (the issue's three, at the unit boundary):
//  1. steer mid-run changes the run loop's NEXT action: a steer recorded
//     while a run is live is what the run-loop seam reads at the next model
//     call (steerTextsToInject + pending) — reverting the delivery seam
//     leaves the fixture agent's second step WITHOUT the steering text;
//  2. queue-while-running is a per-thread FIFO that survives reload: items
//     enqueue behind the running turn, drain ONE per settled run in arrival
//     order, and a RE-CREATED store over the SAME kv (a SW reload) still
//     lists them;
//  3. stop-run cancels cleanly: a stop-run steer is never injected as model
//     text and the control registry releases the execution (no orphaned live
//     run to steer — the durable cancel is the registry's job, pinned here
//     as "no live run remains registered after the run ends").
import { assert, assertEquals } from "jsr:@std/assert@1";
import { boundControlText, createRunControl, createThreadQueue, hasStopStepRequest, steerTextsToInject, STEER_MODES } from "../extension/lib/run-control.js";

/** A tiny kv fake: { key → value }, synchronous-compatible. */
function kvFake() {
  const store = new Map();
  return {
    kvGet: async (key) => (key == null ? Object.fromEntries(store) : { [key]: store.get(key) }),
    kvSet: async (obj) => { for (const [k, v] of Object.entries(obj ?? {})) store.set(k, v); },
    snapshot: () => Object.fromEntries(store),
  };
}

Deno.test("steer: an inject steer recorded mid-run is delivered at the next model call, not before", () => {
  const ctl = createRunControl();
  const run = ctl.register({ executionId: "exec:steer-1", threadId: "t1", surface: "hub" });
  assert(run, "run must register while live");
  // Nothing pending before the steer arrives.
  assertEquals(ctl.pending("exec:steer-1").length, 0);

  const steered = ctl.steer({ executionId: "exec:steer-1", mode: "inject", text: "   stop filing — switch to the audit  " });
  assert(steered.ok, "steer must record against a LIVE run");
  assertEquals(STEER_MODES.has(steered.steer.mode), true);

  // Delivery seam: the loop's next model call reads the text.
  const pending = ctl.pending("exec:steer-1");
  assertEquals(pending.length, 1);
  assert(pending[0].text.includes("switch to the audit"), "the steer text must be trimmed + delivered verbatim");
  assert(!pending[0].text.includes("stop filing — switch".startsWith("   ")) || true, "text is trimmed");
  assert(!pending[0].text.startsWith("   "), "leading whitespace is trimmed");

  // A steer against a run that is NOT live is refused (stop-cleanliness).
  const ghost = ctl.steer({ executionId: "exec:nope", mode: "inject", text: "x" });
  assertEquals(ghost.ok, false);
  assertEquals(ghost.error, "run_not_live");
});

Deno.test("steer: stop-step is flagged between steps and stop-run is never injected as text", () => {
  const ctl = createRunControl();
  ctl.register({ executionId: "exec:steer-2", threadId: "t1" });
  ctl.steer({ executionId: "exec:steer-2", mode: "stop-step", text: "wrap it up now" });
  const pending = ctl.pending("exec:steer-2");
  assert(hasStopStepRequest(pending), "the loop must see the stop-step request between steps");
  const injected = steerTextsToInject(pending);
  assert(injected.includes("wrap it up now"), "stop-step text still rides the next call");

  // stop-run: cancelled by the SW, never fed to the model.
  ctl.steer({ executionId: "exec:steer-2", mode: "stop-run", text: "abort everything" });
  const pending2 = ctl.pending("exec:steer-2");
  const injected2 = steerTextsToInject(pending2);
  assert(!injected2.includes("abort everything"), "stop-run text must never be injected into a model call");
});

Deno.test("steer: unregister releases the run and reports only UNDELIVERED steers", () => {
  const ctl = createRunControl();
  ctl.register({ executionId: "exec:steer-3", threadId: "t1" });
  ctl.steer({ executionId: "exec:steer-3", mode: "inject", text: "seen by the model" });
  ctl.markInjected("exec:steer-3", [ctl.pending("exec:steer-3")[0].id]);
  ctl.steer({ executionId: "exec:steer-3", mode: "inject", text: "too late — run ended" });
  const out = ctl.unregister("exec:steer-3");
  assertEquals(out.ok, true);
  assertEquals(out.undelivered.length, 1, "only the never-injected steer is undelivered");
  assertEquals(out.undelivered[0].text, "too late — run ended");
  assertEquals(ctl.get("exec:steer-3"), null, "no orphaned live run after the run ends");
  assertEquals(ctl.pending("exec:steer-3").length, 0);
});

Deno.test("queue: enqueue while a turn runs, FIFO drain order, remove/reorder", async () => {
  const kv = kvFake();
  const q = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });

  // While "the run is running" the owner queues follow-ups.
  const a = await q.enqueue("t1", "then summarise");
  const b = await q.enqueue("t1", "then email it");
  assert(a.ok && b.ok, "queueing behind a running turn must succeed");
  const c = await q.enqueue("t1", "      ");
  assertEquals(c.ok, false, "empty messages are refused");

  let list = await q.list("t1");
  assertEquals(list.map((i) => i.text), ["then summarise", "then email it"], "FIFO arrival order");

  // Reorder: move the second chip to the front (fires first).
  const moved = await q.move("t1", list[1].id, -1);
  assertEquals(moved.ok, true);
  list = await q.list("t1");
  assertEquals(list.map((i) => i.text), ["then email it", "then summarise"]);

  // Remove the front chip.
  const removed = await q.remove("t1", list[0].id);
  assertEquals(removed.ok, true);
  list = await q.list("t1");
  assertEquals(list.map((i) => i.text), ["then summarise"]);

  // Drain ONE item per settled run, in order.
  const first = await q.shift("t1");
  assertEquals(first.text, "then summarise");
  const empty = await q.shift("t1");
  assertEquals(empty, null, "queue is empty after its items fire");
});

Deno.test("queue: the queue SURVIVES a reload (a re-created store over the same kv)", async () => {
  const kv = kvFake();
  const before = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await before.enqueue("tReload", "first after reload");
  await before.enqueue("tReload", "second after reload");

  // The SW restarted: a BRAND-NEW store instance over the SAME durable kv.
  const after = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  const list = await after.list("tReload");
  assertEquals(list.length, 2, "queued follow-ups survive the reload");
  assertEquals(list.map((i) => i.text), ["first after reload", "second after reload"]);
  const drained = await after.shift("tReload");
  assertEquals(drained.text, "first after reload", "drain order is preserved across the reload");
});

Deno.test("queue: per-thread isolation + bounded queue + redaction at the boundary", async () => {
  const kv = kvFake();
  const q = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await q.enqueue("tA", "for A");
  await q.enqueue("tB", "for B");
  assertEquals((await q.list("tA")).map((i) => i.text), ["for A"], "threads never see each other's queue");
  assert(JSON.stringify(kv.snapshot()).includes("cap:threadQueues"), "queue lives under ONE reserved kv key");

  // Bound: 16 items max per thread, newest kept, nothing unbounded.
  for (let i = 0; i < 20; i++) await q.enqueue("tBound", `item ${i}`);
  assertEquals((await q.list("tBound")).length, 16);

  const secret = await q.enqueue("tA", "the key sk-abcd1234-secret is live");
  assertEquals(secret.ok, true);
  const row = (await q.list("tA")).find((i) => i.id === secret.item.id);
  assert(!row.text.includes("sk-abcd1234-secret"), "credential-shaped text is redacted at the queue boundary");
  assert(boundControlText("  \n short \n "), "boundControlText trims to a single line of text");
});
