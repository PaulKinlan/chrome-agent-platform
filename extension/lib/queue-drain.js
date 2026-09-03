// extension/lib/queue-drain.js — the durable per-thread follow-up drain
// (chrome-agent-platform-afiu, review r5 P1-2).
//
// The drain fires ONE queued follow-up per settled run as a continuation turn
// of the same thread. The OLD drain removed the FIFO head (shift) BEFORE the
// fired run was durably admitted — an SW stop in that gap, or an admission /
// quota refusal that never created a durable row, permanently lost the
// owner's message (the rejection handlers only logged).
//
// This module makes the drain two-phase over the queue's CLAIM state:
//   1. claim the head (the item STAYS durably stored, marked in-flight with
//      the fired run's client id);
//   2. fire the continuation run;
//   3. when that run SETTLES (ok or not), its item is dropped — the message
//      was executed as that turn; a non-ok settle parks the queue (no
//      cascade) exactly as before;
//   4. when the run was REFUSED or threw before any durable admission, the
//      claim is RELEASED — the message returns to the pending head and a
//      later drain (or the wake reconcile) re-fires it;
//   5. an SW stop mid-flight leaves the claim DURABLE; the wake reconcile
//      decides each claim from the durable run registry (released when never
//      admitted, dropped when the run settled while the SW was down, kept
//      while the run is live/resuming) and re-drains the recovered threads.
//
// The module holds NO chrome.* authority — the SW injects the durable row
// lookups, the run fire, and diagnostics, so unit tests drive the REAL drain
// over fakes.

/**
 * Fire the next queued follow-up for a thread whose previous turn settled.
 *
 * @param {object} deps
 * @param {object} deps.queue          a createThreadQueue instance
 * @param {string} deps.threadId       the thread whose queue drains
 * @param {string|null} deps.settledExecutionId  the run that just settled
 *   (null for a wake kick — no settle gate)
 * @param {(executionId: string) => Promise<object|null>} deps.runRow  durable
 *   registry row for a settled EXECUTION id, or null when absent/unreadable
 * @param {({ runId: string, text: string }) => Promise<object>} deps.fireRun
 *   starts the continuation turn (the SW's agent.run); resolves with its
 *   result ({ok:true} once the turn settles, {ok:false} when refused)
 * @param {(level: string, message: string) => void} [deps.report]
 * @param {() => string} deps.newRunId  fresh client run id for the fired turn
 * @returns {Promise<object>} { ok, drained, reason? }
 */
export async function drainQueuedFollowUp({
  queue,
  threadId,
  settledExecutionId = null,
  runRow,
  fireRun,
  report = () => {},
  newRunId,
}) {
  const id = String(threadId ?? "");
  if (!id) return { ok: true, drained: false, reason: "no thread id" };

  // Fast path (pre-fix parity): a thread with NO queue items and NO in-flight
  // claim needs no registry read — the common settle costs nothing extra.
  const status = await queue.status(id).catch(() => ({ pending: 0, claimedRunId: null }));
  if (status.pending === 0 && !status.claimedRunId) {
    return { ok: true, drained: false, reason: "queue empty" };
  }

  if (settledExecutionId) {
    let row = null;
    try {
      row = await runRow(String(settledExecutionId));
    } catch {
      row = null;
    }
    if (!row) return { ok: true, drained: false, reason: "settle record gone — never guess" };
    const phase = String(row.phase ?? "");
    if (phase === "running" || phase === "settling") {
      return { ok: true, drained: false, reason: "settled run still live" };
    }
    // The settled run may itself be a queue-fired continuation: whatever its
    // outcome, its claim resolves here (the item was executed as that turn).
    if (row.clientCorrelationId) {
      try { await queue.dropClaim(id, row.clientCorrelationId); } catch { /* best-effort */ }
    }
    if (phase === "cancelled" || phase === "cancel-requested") {
      return { ok: true, drained: false, reason: "settle cancelled — queue parks" };
    }
    if (phase !== "terminal") return { ok: true, drained: false, reason: "settle not terminal" };
    if (row.terminal?.ok !== true) {
      return { ok: true, drained: false, reason: "failed settle — queue parks" };
    }
  }

  const claimRunId = String(newRunId?.() ?? "").slice(0, 200);
  if (!claimRunId) return { ok: false, error: "no claim run id" };
  const claim = await queue.claimHead(id, claimRunId).catch(() => ({ ok: false }));
  if (!claim?.ok || !claim.item) {
    return {
      ok: true,
      drained: false,
      reason: claim?.blocked ? "an in-flight claim owns the head" : "queue empty",
    };
  }
  const text = String(claim.item.text ?? "");
  try {
    const runPromise = fireRun({ runId: claimRunId, text });
    void Promise.resolve(runPromise).then((result) => {
      if (result?.ok !== true) {
        // Admission refused / failed before a durable run: the message never
        // ran — return it to the queue so a later drain re-fires it.
        queue.releaseClaim(id, claimRunId).catch(() => {});
        report("error", `[thread] queued follow-up could not run: ${String(result?.error ?? "unknown").slice(0, 160)}`);
      }
      // ok:true — the fired turn settled; its own settle-drain (this same
      // function with settledExecutionId = its execution id) drops the claim
      // and drains the next item.
    }).catch((e) => {
      queue.releaseClaim(id, claimRunId).catch(() => {});
      report("error", `[thread] queued follow-up failed: ${String(e?.message ?? e).slice(0, 160)}`);
    });
    return { ok: true, drained: true, itemId: claim.item.id };
  } catch (e) {
    await queue.releaseClaim(id, claimRunId).catch(() => {});
    report("error", `[thread] queued follow-up dispatch failed: ${String(e?.message ?? e).slice(0, 160)}`);
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * Wake reconcile for durable in-flight claims (an SW stop must never orphan
 * one). Each claim is decided from the durable run registry:
 *   - no row for the claimed client run id  → RELEASE (never admitted: the
 *     crash hit before the run became durable — the message returns to the
 *     queue and the thread is re-drained);
 *   - registry lookup THREW (unreadable) → KEEP (review r6 P1-3: an
 *     unreadable registry may hide a live/resumable run — releasing could
 *     double-fire its message, dropping could lose it; only a genuinely
 *     absent row releases);
 *   - row terminal (ok or not)             → DROP (the run settled while the
 *     SW was down; a terminal-ok run also re-drains the next item);
 *   - row running/settling                 → KEEP (the run is live or being
 *     resumed; its own settle-drain resolves the claim);
 *   - any other NONTERMINAL phase (paused-interruption, paused-permission,
 *     paused-provider-change, paused-side-effect-uncertain,
 *     resume-dispatching, cancel-requested) → KEEP (review r6 P1-3: these
 *     are RECOVERABLE — the boot sweep / resume path may still settle the
 *     run, and its settle resolves the claim. Dropping them fired the item
 *     only for the run to be resumed and run it AGAIN, or lost it if the
 *     resume never ran).
 *
 * @param {object} deps
 * @param {object} deps.queue
 * @param {(clientRunId: string) => Promise<object|null>} deps.rowForClientRunId
 * @param {(level: string, message: string) => void} [deps.report]
 * @returns {Promise<{reconciled:number, released:number, dropped:number,
 *   kept:number, threadsToRedrain:string[]}>}
 */
export async function reconcileQueueClaims({ queue, rowForClientRunId, report = () => {} }) {
  const claims = await queue.scanClaims().catch(() => []);
  if (claims.length === 0) {
    return { reconciled: 0, released: 0, dropped: 0, kept: 0, threadsToRedrain: [] };
  }
  // The durable registry's terminal phases (mirrors durable-runs.js).
  const TERMINAL_PHASES = new Set(["terminal", "cancelled"]);
  const LIVE_PHASES = new Set(["running", "settling"]);
  let released = 0;
  let dropped = 0;
  let kept = 0;
  const threadsToRedrain = new Set();
  for (const { threadId, runId } of claims) {
    let row = null;
    let unreadable = false;
    try {
      row = await rowForClientRunId(String(runId));
    } catch {
      unreadable = true;
    }
    if (unreadable) {
      // Registry unreadable ≠ absent (review r6 P1-3): the row may belong to
      // a live or recoverable run — keep the claim and wait.
      kept += 1;
      report("warn", `[thread] queue claim ${runId} kept — durable registry unreadable`);
      continue;
    }
    if (!row) {
      // Genuinely absent — never durably admitted: the crash beat the run's
      // registration. Release so a later drain re-fires the message.
      await queue.releaseClaim(String(threadId), String(runId)).catch(() => {});
      released += 1;
      threadsToRedrain.add(String(threadId));
      continue;
    }
    const phase = String(row.phase ?? "");
    if (LIVE_PHASES.has(phase)) {
      kept += 1; // live / being resumed — its settle resolves the claim
      continue;
    }
    if (TERMINAL_PHASES.has(phase)) {
      // Settled while the SW was down (its finally never ran): drop the item —
      // the message was executed as that run's turn.
      await queue.dropClaim(String(threadId), String(runId)).catch(() => {});
      dropped += 1;
      if (phase === "terminal" && row.terminal?.ok === true) {
        threadsToRedrain.add(String(threadId)); // a succeeded turn drains the next
      }
      continue;
    }
    // Recoverable nonterminal phase (review r6 P1-3): the run is NOT over —
    // the boot sweep may resume it, the cancel may finalize it, and its
    // settle resolves the claim. Never release or drop while it can settle.
    kept += 1;
  }
  return {
    reconciled: claims.length,
    released,
    dropped,
    kept,
    threadsToRedrain: [...threadsToRedrain],
  };
}
