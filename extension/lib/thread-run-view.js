// lib/thread-run-view.js — the thread-as-VIEW assembler (CAP log redesign).
//
// REDESIGN INVARIANT: there is exactly ONE authoritative event log per task —
// the per-execution durable run log (run-log:<executionId>:*, written
// idempotently by the run's progress path BEFORE any external effect). The
// thread body persists only the small authoritative TURN markers (user turns,
// terminal assistant/error rows). Tool cards are NEVER copied into the thread
// body anymore; the view derives them from the durable logs at read time.
// Nothing is silently dropped: every failure is recorded (diagnostics + a
// repair flag on the returned view), and a reconciliation pass back-fills any
// missing terminal marker from the run's durable terminal authority.

import { projectThreadWithRunLogs } from "../shared/conversation.js";
import { perfSpan } from "./cap-perf.js";

// Bounded replay (owner P0 thread-open perf): the thread is a VIEW over the
// per-execution run log, but re-reading EVERY execution's ENTIRE log made a
// task open take ~10s (it scales with history). Render only the most-recent
// executions + their most-recent log rows; totals are reported honestly so the
// surface can say "showing N of M". Full history stays available on demand.
/** Bounded-concurrency map that preserves input order. A per-execution read
 *  failure is already captured as `logFailed` on that execution's own row, so a
 *  worker never rejects and one bad execution cannot take the view with it. */
async function mapBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const MAX_VIEW_EXECUTIONS = 25;
// Bounded fan-out across executions (each page read is itself bounded).
const VIEW_READ_CONCURRENCY = 8;
const MAX_VIEW_LOG_ROWS = 250;

/** Build the render-ready thread view.
 * deps:
 *  - listThreadExecutions(threadId) → [{ executionId, at, record }]
 *  - listLogs(executionId) → durable log rows
 *  - commitTerminal(threadId, executionId, terminal) → persisted repair
 *  - recordFailure(kind, detail) → diagnostics sink (never swallowed)
 * Never throws for log/reconciliation failures — the returned view carries
 * honest markers + `repairFailed` flags instead.
 */
export async function buildThreadRunView(thread, deps) {
  const {
    listThreadExecutions,
    listLogs,
    commitTerminal = null,
    recordFailure = () => {},
  } = deps ?? {};
  if (!thread?.id || typeof listThreadExecutions !== "function" || typeof listLogs !== "function") {
    return thread;
  }
  let executions = [];
  try {
    executions = await listThreadExecutions(thread.id);
  } catch (e) {
    recordFailure("thread-view-executions", `could not list executions for ${thread.id}: ${String(e?.message ?? e).slice(0, 200)}`);
    return { ...thread, viewDegraded: true };
  }
  // Bound the replay: listThreadExecutions is already chronological (ascending
  // by startedAt) — only the most-recent executions are read for logs.
  const totalExecutions = executions.length;
  const viewedExecutions = executions.slice(-MAX_VIEW_EXECUTIONS);
  const truncatedExecutions = totalExecutions - viewedExecutions.length;
  // Executions are read CONCURRENTLY with a bounded pool
  // (CAP-FB-20260827-THREAD-OPEN-SEQUENTIAL-READS-01). Measured: 97% of
  // task-open time was these reads, and they were serialised only because the
  // loop awaited each one — nothing about an execution's log depends on
  // another's. Bounded rather than unbounded so a 25-execution thread does not
  // fan out 25 simultaneous page reads (each of which is itself a bounded
  // fan-out). Order is restored by index: `withLogs` must stay in execution
  // order, because the projection places each execution's cards relative to its
  // own terminal marker.
  const withLogs = await mapBounded(viewedExecutions, VIEW_READ_CONCURRENCY, async (e) => {
    let logs = [];
    let logFailed = false;
    let truncatedLogs = false;
    const logSpan = perfSpan(`thread-view:logs:${e.executionId}`);
    try {
      logs = await listLogs(e.executionId, MAX_VIEW_LOG_ROWS);
      // listLogs returns the most-recent `limit` rows (ascending by at); hitting
      // the cap means there may be older rows omitted — flag it honestly.
      truncatedLogs = logs.length >= MAX_VIEW_LOG_ROWS;
    } catch (err) {
      logFailed = true;
      recordFailure("thread-view-logs", `could not read run log for ${e.executionId}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
    logSpan.end(logFailed ? "error" : "ok");
    return {
      executionId: e.executionId,
      logs,
      logFailed,
      truncatedLogs,
      phase: e.record?.phase ?? null,
      pause: e.record?.pause ?? null,
      terminal: e.record?.terminal ?? null,
    };
  });
  const projectSpan = perfSpan("thread-view:project");
  const { messages, missingTerminals } = projectThreadWithRunLogs(thread, withLogs);
  projectSpan.end("ok");

  // RECONCILIATION: a terminal-phase execution whose terminal marker never
  // reached the body (the pre-redesign lossy path, or a crash between outbox
  // steps) is back-filled NOW — idempotently, through the same authority as
  // the outbox (commitThreadTerminal). A failed repair is recorded AND the
  // derived terminal marker still renders (read-only), so the reopened thread
  // is honest even when the repair write itself fails.
  let status = thread.status;
  let repairFailed = false;
  for (const missing of missingTerminals) {
    const terminal = missing.terminal;
    const role = terminal?.ok === true ? "assistant" : "error";
    // The full result wins over the 240-char summary preview: the back-fill
    // COMMITS this string as the thread's terminal message, so a preview here
    // would clip the answer permanently (CAP-FB-20260830-TRANSCRIPT-FULL-ANSWER-01).
    const content = terminal?.result ?? terminal?.summary ?? terminal?.reason ?? (role === "assistant" ? "" : "run failed");
    const derivedMarker = {
      role,
      content: String(content ?? ""),
      executionId: missing.executionId,
      ts: terminal?.at ?? Date.now(),
      derived: true,
      ...(role === "error" ? { category: "error", reason: "terminal recovered from the durable run record" } : {}),
    };
    let repaired = false;
    if (typeof commitTerminal === "function") {
      try {
        const repairedThread = await commitTerminal(thread.id, missing.executionId, {
          role,
          content: derivedMarker.content,
          category: terminal?.cancelled ? "cancelled" : "error",
          reason: terminal?.reason ?? undefined,
        });
        repaired = Boolean(repairedThread);
      } catch (e) {
        repairFailed = true;
        recordFailure("thread-view-reconcile", `terminal back-fill failed for ${missing.executionId}: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    if (!repaired) {
      repairFailed = true;
    }
    // Render the terminal marker in THIS view regardless of whether the repair
    // write landed (the in-memory body is pre-repair). Appended in execution
    // order; on the next read the persisted marker takes its correct position.
    messages.push(derivedMarker);
    // Only repair a STUCK status — never regress a later turn's terminal.
    if (thread.status === "running") {
      status = terminal?.ok === true ? "done" : terminal?.cancelled ? "cancelled" : "error";
    }
  }

  // A log that could not be read gets an honest placeholder marker rather than
  // a silent gap.
  for (const e of withLogs) {
    if (e.logFailed) {
      messages.push({
        role: "system",
        content: "Some run logs could not be read — the visible history may be incomplete.",
        ts: Date.now(),
        derived: true,
        executionId: e.executionId,
      });
    }
  }

  return {
    ...thread,
    messages,
    status,
    totalExecutions,
    truncatedExecutions,
    ...(withLogs.some((e) => e.truncatedLogs) ? { truncatedLogs: true } : {}),
    ...(repairFailed ? { repairFailed: true } : {}),
    ...(withLogs.some((e) => e.logFailed) ? { viewDegraded: true } : {}),
  };
}

/** The loud failure finalizer for runs that never reached durable admission
 * (unknown agent, invalid args, provider gate throw pre-settle, thread-store
 * failure): WITHOUT an executionId there is no outbox, so nothing else will
 * ever commit the thread terminal — commit an error terminal directly so the
 * task is NEVER stuck "running". A commit failure is recorded, never
 * swallowed. Returns true when a terminal was committed. */
export async function finalizeUnadmittedThreadRun({ threadId, result, commitTerminal, recordFailure = () => {} }) {
  if (!threadId || !result || result.ok !== false || result.executionId) return false;
  if (typeof commitTerminal !== "function") return false;
  const syntheticId = `run-refusal:${threadId}:${Date.now().toString(36)}`;
  try {
    const committed = await commitTerminal(threadId, syntheticId, {
      role: "error",
      content: result.error ?? "run failed before it could be started durably",
      category: result.errorCategory ?? "error",
      reason: result.errorReason ?? undefined,
      action: result.errorAction ?? undefined,
    });
    if (!committed) recordFailure("thread-terminal", `terminal commit returned null for ${threadId}`);
    return Boolean(committed);
  } catch (e) {
    recordFailure("thread-terminal", `terminal commit failed for ${threadId}: ${String(e?.message ?? e).slice(0, 200)}`);
    return false;
  }
}
