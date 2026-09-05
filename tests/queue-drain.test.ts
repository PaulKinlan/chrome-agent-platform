// tests/queue-drain.test.ts — chrome-agent-platform-afiu, review r5 P1-2.
// @ts-nocheck — the fakes are intentionally dynamic.
//
// Falsification gate: the r4 drain durably removed the FIFO head (shift)
// BEFORE the fired run was durably admitted — an SW stop in the gap, or an
// admission/quota refusal that never created a durable row, permanently lost
// the owner's queued message (the rejection handler only logged). These tests
// drive the REAL two-phase drain (lib/queue-drain.js) over fakes:
//   - a REFUSED continuation releases its claim: the message survives and a
//     later drain re-fires it (crash-refusal simulation, preserve + re-drain);
//   - an OK-settled continuation drops its item at the settle (the drain
//     resolves the claim from the settled row's client correlation id);
//   - a failed/cancelled settle parks the queue (no blind cascade) after
//     dropping the executed item;
//   - a claimed head BLOCKS a second drain (no double-fire);
//   - the WAKE reconcile decides each durable claim from the run registry:
//     never-admitted → released + re-drained; settled-ok → dropped +
//     re-drained; settled-failed → dropped (park); still-running → kept.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createThreadQueue } from "../extension/lib/run-control.js";
import { drainQueuedFollowUp, reconcileQueueClaims } from "../extension/lib/queue-drain.js";

/** A tiny kv fake shared by re-created queue instances (an SW reload). */
function kvFake() {
  const store = new Map();
  return {
    kvGet: async (key) => (key == null ? Object.fromEntries(store) : { [key]: store.get(key) }),
    kvSet: async (obj) => { for (const [k, v] of Object.entries(obj ?? {})) store.set(k, v); },
  };
}

let runSeq = 0;
const newRunId = () => `retry:test:${(++runSeq).toString(36)}`;

/** The settled-run registry fake: rows keyed by durable execution id, each
 * carrying the client correlation id the drain fired with. */
function registryFake() {
  const rows = new Map();
  return {
    rows,
    add(executionId, { clientCorrelationId, phase, ok }) {
      rows.set(executionId, { executionId, clientCorrelationId, phase, terminal: ok == null ? undefined : { ok } });
    },
    row: async (executionId) => rows.get(String(executionId)) ?? null,
    rowForClientRunId: async (clientRunId) => {
      for (const row of rows.values()) if (row.clientCorrelationId === clientRunId) return row;
      return null;
    },
  };
}

/** A tiny wait so fire-and-forget refusal handling settles. */
const tick = () => new Promise((r) => setTimeout(r, 5));

Deno.test("r5 drain: a REFUSED continuation RELEASES the message — preserved and re-drained", async () => {
  const kv = kvFake();
  const queue = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await queue.enqueue("tRefuse", "do not lose me");
  const fired = [];
  const registry = registryFake();

  // First drain fires the head; agent.run REFUSES admission (no durable row,
  // e.g. thread store failure) — the r4 shift-based drain lost the message here.
  const first = await drainQueuedFollowUp({
    queue, threadId: "tRefuse", settledExecutionId: null,
    runRow: registry.row, fireRun: async ({ runId, text }) => {
      fired.push(runId);
      return { ok: false, error: "the task thread could not be persisted — the task was NOT run" };
    },
    report: () => {}, newRunId,
  });
  assert(first.ok && first.drained, "the first drain must fire the head");
  await tick();
  // The refusal released the claim: the message is back, pending, at the head.
  assertEquals((await queue.list("tRefuse")).map((i) => i.text), ["do not lose me"], "refusal must NOT lose the message");
  assert((await queue.scanClaims()).length === 0, "no orphaned claim after the refusal");

  // A later drain (the next settled run on the thread) re-fires it.
  registry.add("exec:ok-1", { clientCorrelationId: "composer-run-1", phase: "terminal", ok: true });
  const second = await drainQueuedFollowUp({
    queue, threadId: "tRefuse", settledExecutionId: "exec:ok-1",
    runRow: registry.row, fireRun: async ({ runId, text }) => {
      fired.push(runId);
      registry.add(`exec:${runId}`, { clientCorrelationId: runId, phase: "terminal", ok: true });
      return { ok: true };
    },
    report: () => {}, newRunId,
  });
  assert(second.ok && second.drained, "the recovered message must re-drain");
  assertEquals(fired.length, 2, "the message fires twice in total: refused once, then re-drained");
});

Deno.test("r5 drain: an OK-settled continuation DROPS its item at the settle, then the next item drains", async () => {
  const kv = kvFake();
  const queue = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await queue.enqueue("tOk", "first");
  await queue.enqueue("tOk", "second");
  const registry = registryFake();
  const fired = [];

  const fireOk = async ({ runId, text }) => {
    fired.push({ runId, text });
    // The fired run becomes a durable row carrying the client id, then settles ok.
    registry.add(`exec:${runId}`, { clientCorrelationId: runId, phase: "terminal", ok: true });
    return { ok: true };
  };

  // Drain from the settle of a DIRECT owner run (no claim of its own).
  registry.add("exec:owner", { clientCorrelationId: null, phase: "terminal", ok: true });
  const first = await drainQueuedFollowUp({
    queue, threadId: "tOk", settledExecutionId: "exec:owner",
    runRow: registry.row, fireRun: fireOk, report: () => {}, newRunId,
  });
  assert(first.drained);
  const claimRunId = fired[0].runId;
  // While the fired run is live, the item is claimed (not an actionable chip)
  // and a second drain cannot double-fire it.
  assertEquals((await queue.list("tOk")).map((i) => i.text), ["second"], "the in-flight first item is not a chip");
  assertEquals(await queue.claimHead("tOk", newRunId()), { ok: false, blocked: true, runId: claimRunId });

  // The fired run settles ok → its settle-drain drops its claim and drains the next.
  const settleDrain = await drainQueuedFollowUp({
    queue, threadId: "tOk", settledExecutionId: `exec:${claimRunId}`,
    runRow: registry.row, fireRun: fireOk, report: () => {}, newRunId,
  });
  assert(settleDrain.drained, "after the ok settle the next item fires");
  assertEquals(fired.map((f) => f.text), ["first", "second"], "exactly the two queued messages run, in order");
});

Deno.test("r5 drain: a FAILED settle parks the queue after dropping the executed item (no blind cascade)", async () => {
  const kv = kvFake();
  const queue = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await queue.enqueue("tFail", "will fail");
  await queue.enqueue("tFail", "must NOT auto-fire");
  const registry = registryFake();
  const fired = [];

  const fire = async ({ runId, text }) => {
    fired.push(text);
    return { ok: false, error: "budget exhausted", executionId: `exec:${runId}` };
  };
  // First drain fires the head.
  registry.add("exec:owner", { clientCorrelationId: null, phase: "terminal", ok: true });
  await drainQueuedFollowUp({
    queue, threadId: "tFail", settledExecutionId: "exec:owner",
    runRow: registry.row, fireRun: fire, report: () => {}, newRunId,
  });
  await tick();
  // Refusal → released: the failed item is back pending... this drain treats a
  // refuse as unadmitted. Now simulate that the run WAS admitted and settled
  // FAILED (its claim dropped, queue parked).
  const claim = await queue.claimHead("tFail", "retry:test:settled-fail");
  assert(claim.ok);
  registry.add("exec:retry:test:settled-fail", { clientCorrelationId: "retry:test:settled-fail", phase: "terminal", ok: false });
  const park = await drainQueuedFollowUp({
    queue, threadId: "tFail", settledExecutionId: "exec:retry:test:settled-fail",
    runRow: registry.row, fireRun: fire, report: () => {}, newRunId,
  });
  assertEquals(park.drained, false, "a failed settle parks the queue");
  assertEquals(park.reason, "failed settle — queue parks");
  assertEquals((await queue.list("tFail")).map((i) => i.text), ["must NOT auto-fire"], "the remaining item waits for the owner, never a silent cascade");
});

Deno.test("r5 wake reconcile: crash before durable admission RELEASES the claim and re-drains; settled rows are dropped", async () => {
  const kv = kvFake();
  const queue = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await queue.enqueue("tWake", "survivor");
  // The SW died mid-flight: the item is claimed but the fired run was NEVER
  // durably admitted (no row anywhere).
  const claim = await queue.claimHead("tWake", "retry:test:crashed");
  assert(claim.ok);
  const registry = registryFake(); // empty — the crash beat registration
  const fired = [];

  const outcome = await reconcileQueueClaims({
    queue,
    rowForClientRunId: registry.rowForClientRunId,
    report: () => {},
  });
  assertEquals(outcome.released, 1, "the never-admitted claim must be released on wake");
  assertEquals(outcome.kept, 0);
  assert(outcome.threadsToRedrain.includes("tWake"), "the recovered thread must be re-drained");
  assertEquals((await queue.list("tWake")).map((i) => i.text), ["survivor"], "the message survived the crash");

  // Wake re-drain fires the recovered message.
  let wakeFiredRunId = null;
  const re = await drainQueuedFollowUp({
    queue, threadId: "tWake", settledExecutionId: null,
    runRow: registry.row, fireRun: async ({ runId, text }) => { wakeFiredRunId = runId; fired.push(text); registry.add(`exec:${runId}`, { clientCorrelationId: runId, phase: "terminal", ok: true }); return { ok: true }; },
    report: () => {}, newRunId,
  });
  assert(re.drained, "the wake re-drain must fire the survivor");
  assertEquals(fired, ["survivor"]);
  // The wake-fired run settles ok — its settle-drain drops its claim.
  const settle = await drainQueuedFollowUp({
    queue, threadId: "tWake", settledExecutionId: `exec:${wakeFiredRunId}`,
    runRow: registry.row, fireRun: async () => { throw new Error("must not fire"); },
    report: () => {}, newRunId,
  });
  assertEquals(settle.drained, false, "nothing is left to drain after the survivor's settle");
  assert((await queue.scanClaims()).length === 0, "the survivor's claim is dropped at its settle");

  // A claim whose run settled WHILE the SW was down: reconcile drops it
  // (terminal-ok → re-drain the NEXT item; terminal-fail → park).
  await queue.enqueue("tWake", "ran-while-down");
  await queue.enqueue("tWake", "drains after ok");
  const claim2 = await queue.claimHead("tWake", "retry:test:settled-while-down");
  assert(claim2.ok);
  assertEquals(claim2.item.text, "ran-while-down");
  registry.add("exec:settled-ok", { clientCorrelationId: "retry:test:settled-while-down", phase: "terminal", ok: true });
  const outcome2 = await reconcileQueueClaims({
    queue,
    rowForClientRunId: registry.rowForClientRunId,
    report: () => {},
  });
  assertEquals(outcome2.dropped, 1, "a claim whose run settled while the SW was down is dropped");
  assert(outcome2.threadsToRedrain.includes("tWake"), "a terminal-ok settle drains the next item");
  assertEquals((await queue.list("tWake")).map((i) => i.text), ["drains after ok"], "the executed item is gone; the next waits for the re-drain");

  // Still-running rows are KEPT (their settle owns the claim).
  const claim3 = await queue.claimHead("tWake", "retry:test:still-live");
  assert(claim3.ok);
  registry.add("exec:live", { clientCorrelationId: "retry:test:still-live", phase: "running", ok: undefined });
  const outcome3 = await reconcileQueueClaims({
    queue,
    rowForClientRunId: registry.rowForClientRunId,
    report: () => {},
  });
  assertEquals(outcome3.kept, 1, "a live/resuming run keeps its claim");
  assertEquals(outcome3.released + outcome3.dropped, 0);
});

// ── review r6 P1-3 falsification gates (gpt-5.6-sol:high, r5) ────────────────
// On the r5 tree reconcileQueueClaims treated a registry lookup EXCEPTION as
// absence (it released a claim whose run may be live — double-fire risk) and
// DROPPED every phase other than running/settling, including RECOVERABLE
// nonterminal phases (paused-interruption, paused-permission, cancel-requested
// …): the item was removed while its run was merely paused for resume — either
// lost entirely or run a second time after the resume. r6: only a GENUINELY
// absent row releases; unreadable and recoverable rows keep the claim.

Deno.test("r6 wake reconcile: an UNREADABLE registry KEEPS the claim (never reads as absence)", async () => {
  const kv = kvFake();
  const queue = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await queue.enqueue("tUnreadable", "hold me");
  const claim = await queue.claimHead("tUnreadable", "retry:test:unreadable");
  assert(claim.ok);
  const registry = registryFake();
  registry.add("exec:live-1", { clientCorrelationId: "retry:test:unreadable", phase: "running", ok: undefined });

  // The lookup THROWS (registry mid-recovery / transient fault): r5 released
  // the claim — potentially double-firing a LIVE run's message.
  const reports = [];
  const outcome = await reconcileQueueClaims({
    queue,
    rowForClientRunId: async () => { throw new Error("registry not ready"); },
    report: (level, msg) => reports.push({ level, msg }),
  });
  assertEquals(outcome.released, 0, "an unreadable registry must NOT release the claim");
  assertEquals(outcome.dropped, 0, "an unreadable registry must NOT drop the claim");
  assertEquals(outcome.kept, 1, "the claim waits while the registry is unreadable");
  assertEquals((await queue.scanClaims()).length, 1, "the durable claim survives the unreadable reconcile");
  assert(reports.length >= 1, "the reconcile must surface the unreadable-keep decision");
});

Deno.test("r6 wake reconcile: RECOVERABLE nonterminal phases KEEP their claim (paused / resuming / cancel-requested)", async () => {
  const kv = kvFake();
  const queue = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await queue.enqueue("tRecover", "resume me later");
  const claim = await queue.claimHead("tRecover", "retry:test:paused-run");
  assert(claim.ok);
  const registry = registryFake();
  registry.add("exec:paused", { clientCorrelationId: "retry:test:paused-run", phase: "paused-interruption", ok: undefined });
  registry.add("exec:paused-2", { clientCorrelationId: "retry:test:paused-run-2", phase: "paused-permission", ok: undefined });

  // The claim for the paused run must be kept — the boot sweep resumes it and
  // its settle resolves the claim. (r5 dropped every non-running phase: the
  // item was removed while its run was only paused for resume.)
  let out = await reconcileQueueClaims({ queue, rowForClientRunId: registry.rowForClientRunId, report: () => {} });
  assertEquals(out.kept, 1, "a paused-interruption run's claim waits for its resume/settle");
  assertEquals(out.dropped, 0);
  assertEquals(out.released, 0);
  // Clean the kept claim so the per-phase loop below starts with an open head.
  await queue.dropClaim("tRecover", "retry:test:paused-run");

  // Each recoverable phase classification, driven one claim at a time:
  // paused-interruption / paused-permission / paused-provider-change /
  // paused-side-effect-uncertain / resume-dispatching / cancel-requested all
  // WAIT — none is dropped or released.
  const recoverable = [
    "paused-interruption",
    "paused-permission",
    "paused-provider-change",
    "paused-side-effect-uncertain",
    "resume-dispatching",
    "cancel-requested",
  ];
  for (const phase of recoverable) {
    await queue.enqueue("tRecover", `msg:${phase}`);
    const claimed = await queue.claimHead("tRecover", `retry:test:${phase}`);
    assert(claimed.ok, `claim for ${phase} must succeed`);
    registry.rows.clear();
    registry.add(`exec:${phase}`, { clientCorrelationId: `retry:test:${phase}`, phase, ok: undefined });
    const one = await reconcileQueueClaims({ queue, rowForClientRunId: registry.rowForClientRunId, report: () => {} });
    assertEquals(one.kept, 1, `${phase} is recoverable — its claim must be KEPT`);
    assertEquals(one.dropped, 0, `${phase} must not be dropped`);
    assertEquals(one.released, 0, `${phase} must not be released`);
    assertEquals((await queue.scanClaims()).length, 1, `${phase}: the claim is still durable after the reconcile`);
    await queue.dropClaim("tRecover", `retry:test:${phase}`); // clean up for the next phase
  }
});

Deno.test("r6 wake reconcile: only a GENUINELY absent run releases; terminal-ok still drops + re-drains", async () => {
  const kv = kvFake();
  const queue = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await queue.enqueue("tAbsent", "never admitted");
  await queue.enqueue("tSettled", "settled while down");
  await queue.enqueue("tSettled", "survivor");
  const registry = registryFake();

  // Absent → release (the only classification that releases).
  assert((await queue.claimHead("tAbsent", "retry:test:absent-1")).ok);
  // Settled-ok while down → drop + re-drain.
  assert((await queue.claimHead("tSettled", "retry:test:settled-ok-1")).ok);
  registry.add("exec:settled-ok", { clientCorrelationId: "retry:test:settled-ok-1", phase: "terminal", ok: true });

  const out = await reconcileQueueClaims({ queue, rowForClientRunId: registry.rowForClientRunId, report: () => {} });
  assertEquals(out.released, 1, "the never-admitted claim is released");
  assertEquals(out.dropped, 1, "the settled-while-down claim is dropped");
  assertEquals(out.kept, 0);
  assert(out.threadsToRedrain.includes("tAbsent") && out.threadsToRedrain.includes("tSettled"), "released + terminal-ok both re-drain their threads");
  assertEquals((await queue.list("tAbsent")).map((i) => i.text), ["never admitted"], "the released message is back on the queue for the wake re-drain");
  assertEquals((await queue.list("tSettled")).map((i) => i.text), ["survivor"], "the executed item is gone; the survivor waits for the re-drain");
});

Deno.test("queue drain: a durable follow-up fires with its originating resolver document", async () => {
  const kv = kvFake();
  const queue = createThreadQueue({ kvGet: kv.kvGet, kvSet: kv.kvSet });
  await queue.enqueue("tResolver", "continue", { resolverDocumentId: "conversation-document-9" });
  const registry = registryFake();
  registry.add("exec:owner", { clientCorrelationId: null, phase: "terminal", ok: true });
  let fired = null;
  const result = await drainQueuedFollowUp({
    queue,
    threadId: "tResolver",
    settledExecutionId: "exec:owner",
    runRow: registry.row,
    fireRun: async (request) => {
      fired = request;
      return { ok: false, error: "test refusal" };
    },
    report: () => {},
    newRunId,
  });
  assert(result.ok && result.drained);
  assertEquals(fired.resolverDocumentId, "conversation-document-9");
});
