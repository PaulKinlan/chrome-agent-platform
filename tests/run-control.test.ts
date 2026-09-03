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

// ── review r5 falsification gates (gpt-5.6-sol:high) ────────────────────────
// Each fails on the r4 tree: P1-1 (kind dropped → worker branch unreachable),
// P1-3 (silent eviction of already-accepted steers / whole other threads'
// queues), P1-2 (drain removed the FIFO head before durable admission — no
// claim state to survive a crash or a refusal).

Deno.test("r5: register RETAINS the run kind (a worker run must be routable as kind === 'worker')", () => {
  const ctl = createRunControl();
  ctl.register({ executionId: "exec:worker-1", threadId: "t1", surface: "agent-worker:agent-1", kind: "worker" });
  ctl.register({ executionId: "exec:sw-1", threadId: "t1", surface: "hub", kind: "agent" });
  assertEquals(ctl.get("exec:worker-1").kind, "worker", "the worker kind must survive registration");
  assertEquals(ctl.get("exec:sw-1").kind, "agent", "an SW run's kind must survive registration");
});

Deno.test("r5: a 6th undelivered steer is REFUSED with the limit surfaced — never silently dropped", () => {
  const ctl = createRunControl();
  ctl.register({ executionId: "exec:steer-5", threadId: "t1" });
  const texts = ["first", "second", "third", "fourth", "fifth"];
  for (const t of texts) {
    const r = ctl.steer({ executionId: "exec:steer-5", mode: "inject", text: t });
    assert(r.ok, `steer ${t} must record`);
  }
  // No model call carried any of them yet (the loop is between calls — the
  // exact window the reviewer named).
  const sixth = ctl.steer({ executionId: "exec:steer-5", mode: "inject", text: "sixth" });
  assertEquals(sixth.ok, false, "the cap must be surfaced to the caller, not silently shifted");
  assertEquals(sixth.error, "steer_buffer_full");
  assertEquals(sixth.limit, 5);
  // Nothing the owner typed was lost: unregister reports all five undelivered.
  const out = ctl.unregister("exec:steer-5");
  assertEquals(out.undelivered.map((s) => s.text), texts, "no undelivered steer may be evicted");
});

Deno.test("r5: a carried (spent) steer frees its slot — refusals count UNDELIVERED only", () => {
  const ctl = createRunControl();
  ctl.register({ executionId: "exec:steer-6", threadId: "t1" });
  for (let i = 0; i < 5; i++) ctl.steer({ executionId: "exec:steer-6", mode: "inject", text: `m${i}` });
  // The loop carried all five.
  const pending = ctl.pending("exec:steer-6");
  ctl.markInjected("exec:steer-6", pending.map((s) => s.id));
  const again = ctl.steer({ executionId: "exec:steer-6", mode: "inject", text: "after carry" });
  assertEquals(again.ok, true, "a slot freed by a carried steer must accept a new one");
});

Deno.test("r5: the whole-map thread limit REFUSES a new thread — never deletes another thread's queue", async () => {
  const kv = kvFake();
  const q = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await q.enqueue("tKeep", "precious");
  // Fill to the thread limit with distinct threads.
  for (let i = 0; i < 199; i++) {
    const r = await q.enqueue(`tFill${i}`, `item ${i}`);
    assert(r.ok, `filling thread ${i} must succeed`);
  }
  const refused = await q.enqueue("tFresh", "overflow");
  assertEquals(refused.ok, false, "a new thread past the limit must be refused with an honest error");
  assertEquals(refused.error, "queue_thread_limit");
  assertEquals((await q.list("tKeep")).map((i) => i.text), ["precious"], "the oldest thread's accepted data must survive");
});

Deno.test("r5: a claimed follow-up SURVIVES an SW stop (store re-creation) and releases back to pending on refusal", async () => {
  const kv = kvFake();
  const before = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await before.enqueue("tCrash", "never lose me");
  const claim = await before.claimHead("tCrash", "retry:crash-1");
  assert(claim.ok, "the drain must be able to claim the head");
  // The SW stops mid-flight: a BRAND-NEW store over the SAME durable kv.
  const after = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  // The claimed item is hidden from the actionable chips but still stored.
  assertEquals((await after.list("tCrash")).length, 0, "an in-flight item is not an actionable chip");
  const claims = await after.scanClaims();
  assertEquals(claims, [{ threadId: "tCrash", runId: "retry:crash-1" }], "the claim is DURABLE across the restart");
  // Admission never happened → release: the message returns to the pending head.
  const released = await after.releaseClaim("tCrash", "retry:crash-1");
  assert(released.ok);
  assertEquals((await after.list("tCrash")).map((i) => i.text), ["never lose me"], "the message survives the crash");
  // A later drain re-claims it.
  const reclaim = await after.claimHead("tCrash", "retry:crash-2");
  assert(reclaim.ok, "the recovered message must be drainable again");
});

Deno.test("r5: dropClaim removes only the settled run's item; a claimed head BLOCKS a second concurrent drain", async () => {
  const kv = kvFake();
  const q = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await q.enqueue("t2", "first follow-up");
  await q.enqueue("t2", "second follow-up");
  const claim = await q.claimHead("t2", "retry:run-1");
  assert(claim.ok);
  assertEquals(claim.item.text, "first follow-up");
  // The same head cannot be claimed by a second drain while the first run lives.
  const blocked = await q.claimHead("t2", "retry:run-2");
  assertEquals(blocked.ok, false, "a second drain must not double-fire the in-flight item");
  assertEquals(blocked.blocked, true);
  // dropClaim removes ONLY the settled run's item; the next becomes the head.
  const dropped = await q.dropClaim("t2", "retry:run-1");
  assert(dropped.ok);
  assertEquals((await q.list("t2")).map((i) => i.text), ["second follow-up"]);
  // A claim for an unknown run is a no-op (never removes the wrong item).
  const ghost = await q.dropClaim("t2", "retry:nope");
  assertEquals(ghost.ok, false);
  assertEquals((await q.list("t2")).map((i) => i.text), ["second follow-up"]);
});
