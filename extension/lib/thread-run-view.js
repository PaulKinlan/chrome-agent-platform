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

// Default view bound: the newest 50 runs of a surface reopen with full visible
// history (CAP-FB-20260901-THREAD-RELOAD-FIDELITY-01), matching RUN_RETENTION_POLICY.perThread.
// Windowed loading keeps open latency bounded (O(1) with history). Older runs
// load on demand via pagination options ({ limit, offset, all }).
export const MAX_VIEW_EXECUTIONS = 50;
export const DEFAULT_VIEW_EXECUTIONS = 50;
// Bounded fan-out across executions (each page read is itself bounded).
// 16 since CAP-FB-20260901-THREAD-RELOAD-FIDELITY-01: the view reads up to 50
// executions (each a lock-shared bounded page read); measured 109 ms for a
// 60-run thread of 300 tool rows at 8.
const VIEW_READ_CONCURRENCY = 16;

// kmpq P1 — legacy truncated rows whose journal can no longer be read must not
// stay dishonest. A pre-kmpq thread row's truncation marker claimed "the
// complete text is in the run log"; hydration replaces that row only when a
// full payload actually exists. When NO payload is available (the run log is
// gone, purged, or unreadable) the old claim is a lie, so the view rewrites the
// marker to say the remainder was lost — never "in the run log" when it
// demonstrably is not.
export function rewriteUnavailablePayloadMarker(content) {
  const s = String(content ?? "");
  // Both the legacy pre-kmpq truncation marker ("the complete text is in the
  // run log") and the kmpq digest marker ("the complete response is in the run
  // log and opens in full") assert the full text is recoverable from the log.
  const claimMarker = /\n\n…\([^)]*(?:the complete text|the complete response) is in the run log[^)]*\)/u;
  if (!claimMarker.test(s)) return s;
  const idx = s.search(claimMarker);
  if (idx <= 0) return s;
  const head = s.slice(0, idx);
  return `${head}\n\n…(response truncated — the complete response could not be recovered from the run log)`;
}

/** The in-line notice for runs OUTSIDE the view bound — what is not shown is
 *  stated, never silently dropped. `turnsKept` says whether the surface still
 *  carries the older runs' turns (a task thread persists them in its body). */
function viewBoundNotice(viewed, total, { turnsKept = false, at = Date.now() } = {}) {
  const older = total - viewed;
  const content = turnsKept
    ? `Tool details are shown for the last ${viewed} of ${total} runs — the ${older} older ${older === 1 ? "run keeps its turn and answer" : "runs keep their turns and answers"}; their tool details stay in the run log (Settings → Data & memory).`
    : `Showing the last ${viewed} of ${total} runs — the ${older} older ${older === 1 ? "run stays" : "runs stay"} in the run log (Settings → Data & memory).`;
  return { role: "system", content, ts: at, derived: true, viewBound: { viewed, total } };
}

/** Read one execution's log for a view (shared by the thread and agent
 *  views): a read failure is captured on the row, never thrown. dptw: no row
 *  bound — every row the store kept is read. */
async function readExecutionLogs(e, listLogs, recordFailure) {
  let logs = [];
  let logFailed = false;
  const logSpan = perfSpan(`thread-view:logs:${e.executionId}`);
  try {
    logs = await listLogs(e.executionId);
  } catch (err) {
    logFailed = true;
    recordFailure("thread-view-logs", `could not read run log for ${e.executionId}: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  logSpan.end(logFailed ? "error" : "ok");
  return {
    executionId: e.executionId,
    logs,
    logFailed,
    truncatedLogs: false,
    phase: e.record?.phase ?? null,
    pause: e.record?.pause ?? null,
    terminal: e.record?.terminal ?? null,
  };
}

/** Build the render-ready thread view.
 * deps:
 *  - listThreadExecutions(threadId) → [{ executionId, at, record }]
 *  - listLogs(executionId) → durable log rows
 *  - commitTerminal(threadId, executionId, terminal) → persisted repair
 *  - recordFailure(kind, detail) → diagnostics sink (never swallowed)
 * Never throws for log/reconciliation failures — the returned view carries
 * honest markers + `repairFailed` flags instead.
 */
export async function buildThreadRunView(thread, deps, options = {}) {
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
  // by startedAt) — only the most-recent executions are read for logs by default.
  // Windowed loading / pagination: supports limit, offset, and all on demand.
  const totalExecutions = executions.length;
  const opts = typeof options === "object" && options !== null ? options : {};
  const all = opts.all === true || deps?.all === true;
  const rawLimit = opts.limit ?? deps?.limit;
  const bound = all ? Infinity : (Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : (rawLimit === Infinity ? Infinity : MAX_VIEW_EXECUTIONS));
  const offset = Math.max(0, Number.isInteger(opts.offset ?? deps?.offset) ? (opts.offset ?? deps?.offset) : 0);

  let viewedExecutions;
  let start = 0;
  if (!Number.isFinite(bound)) {
    viewedExecutions = executions;
  } else {
    const end = Math.max(0, totalExecutions - offset);
    start = Math.max(0, end - bound);
    viewedExecutions = executions.slice(start, end);
  }
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
  const withLogs = await mapBounded(viewedExecutions, VIEW_READ_CONCURRENCY, (e) => readExecutionLogs(e, listLogs, recordFailure));
  const projectSpan = perfSpan("thread-view:project");
  const { messages, missingTerminals } = projectThreadWithRunLogs(thread, withLogs);
  projectSpan.end("ok");
  // Runs outside the view bound are stated in-line (never a silent drop).
  if (truncatedExecutions > 0) {
    messages.unshift(viewBoundNotice(viewedExecutions.length, totalExecutions, { turnsKept: true, at: viewedExecutions[0]?.at ?? Date.now() }));
  }

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
    // kmpq: prefer the run-log terminal payload (already hydrated into
    // withLogs) so a recovered huge answer is never clipped to the preview;
    // the memory row keeps only a bounded digest + ref (commitThreadTerminal).
    const execLogs = withLogs.find((e) => e.executionId === missing.executionId)?.logs ?? [];
    const terminalRow = execLogs
      .filter((r) => r && (r.type === "terminal" || r.type === "compacted") && r.payload && typeof r.payload.result === "string")
      .at(-1);
    const fullResult = terminalRow?.payload?.result ?? null;
    const content = typeof fullResult === "string" && fullResult.length > 0
      ? fullResult
      : (terminal?.result ?? terminal?.summary ?? terminal?.reason ?? (role === "assistant" ? "" : "run failed"));
    const ref = typeof terminal?.retainedPayloadRef === "string" ? terminal.retainedPayloadRef : undefined;
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
          ...(ref ? { retainedPayloadRef: ref } : {}),
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

  // kmpq redesign — the memory row keeps a bounded index/summary + ref; the
  // COMPLETE response hydrates from the run-log terminal payload at open. The
  // listLogs reads above already hydrate each viewed execution's terminal
  // payload (row.payload.result), so replacing a digest/marker'd terminal row
  // with the full text costs no extra I/O. Rows whose content already equals
  // the payload (byte-complete ≤ the per-row bound) are untouched. Runs this
  // pass at the END so reconciliation-derived markers (back-filled terminals)
  // hydrate too.
  const payloadByExec = new Map();
  for (const e of withLogs) {
    const terminalRow = (Array.isArray(e.logs) ? e.logs : [])
      .filter((r) => r && (r.type === "terminal" || r.type === "compacted") && r.payload && typeof r.payload.result === "string")
      .at(-1);
    const full = terminalRow?.payload?.result ?? null;
    if (typeof full === "string" && full.length > 0) payloadByExec.set(e.executionId, full);
  }
  // Executions READ this pass whose log could not supply the terminal payload
  // (logFailed, or the log rows carry no retained payload). Only those may
  // have their legacy/digest marker rewritten — an execution OUTSIDE the read
  // window still has its payload in the log; claiming loss there would lie the
  // other way.
  const readWithoutPayload = new Set(
    withLogs.filter((e) => !payloadByExec.has(e.executionId)).map((e) => e.executionId),
  );
  const hydrateTerminals = (list) => {
    const out = [];
    for (const m of list) {
      if (!m || typeof m !== "object") { out.push(m); continue; }
      // A terminal assistant/error row carries executionId and no step index;
      // interim per-step rows keep their own content.
      if (
        (m.role === "assistant" || m.role === "error") &&
        typeof m.executionId === "string" &&
        !Number.isInteger(m.step) &&
        typeof m.content === "string"
      ) {
        const full = payloadByExec.get(m.executionId);
        if (typeof full === "string" && full.length > m.content.length) {
          out.push({ ...m, content: full });
          continue;
        }
        // kmpq P1: this execution WAS read and no payload is available (the
        // run log is gone or unreadable). A legacy/digest marker that still
        // claims the complete text is in the run log is a lie — say the
        // remainder was lost instead of promising content that cannot be
        // recovered. Rows whose content already admits the loss (the kmpq
        // boundText "remainder was not retained" marker) are untouched.
        if (readWithoutPayload.has(m.executionId)) {
          const honest = rewriteUnavailablePayloadMarker(m.content);
          if (honest !== m.content) {
            out.push({ ...m, content: honest });
            continue;
          }
        }
      }
      out.push(m);
    }
    return out;
  };
  messages.splice(0, messages.length, ...hydrateTerminals(messages));

  return {
    ...thread,
    messages,
    status,
    totalExecutions,
    truncatedExecutions,
    viewedExecutions: viewedExecutions.length,
    hasMore: start > 0,
    ...(withLogs.some((e) => e.truncatedLogs) ? { truncatedLogs: true } : {}),
    ...(repairFailed ? { repairFailed: true } : {}),
    ...(withLogs.some((e) => e.logFailed) ? { viewDegraded: true } : {}),
  };
}

/** The AGENT surface's view (CAP-FB-20260901-THREAD-RELOAD-FIDELITY-01): a
 * named/background agent's reopened conversation is a VIEW over the SAME
 * authoritative per-execution durable run logs as a task thread — never the
 * per-agent journal (a 200 KiB list surface holding 300-char tool summaries
 * and a 240-char answer preview, which is what lost the owner's transcript).
 * Per execution, the run log yields the user turn (its `task` row), every
 * tool card + approval card (its tool rows, projected by the same
 * projectThreadWithRunLogs the thread uses) and the COMPLETE final answer
 * (the terminal row's retained payload). The most recent `limit` executions
 * of the agent are read; older ones are stated in-line.
 * deps:
 *  - listRuns() → the registry's public run records (agentId, startedAt, phase, terminal)
 *  - listLogs(executionId, limit) → durable log rows (payloads hydrated)
 *  - recordFailure(kind, detail) → diagnostics sink (never swallowed)
 * Never throws: a failed read degrades to an honest marker.
 */
export async function buildAgentRunView({ agentId, limit = MAX_VIEW_EXECUTIONS, offset = 0, all = false } = {}, deps) {
  const { listRuns, listLogs, recordFailure = () => {} } = deps ?? {};
  const empty = { id: agentId ?? null, messages: [], totalExecutions: 0, truncatedExecutions: 0, viewedExecutions: 0, hasMore: false };
  if (!agentId || typeof listRuns !== "function" || typeof listLogs !== "function") return empty;
  let runs = [];
  try {
    runs = await listRuns();
  } catch (e) {
    recordFailure("agent-view-runs", `could not list runs for ${agentId}: ${String(e?.message ?? e).slice(0, 200)}`);
    return { ...empty, viewDegraded: true };
  }
  const mine = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && typeof r.executionId === "string" && r.agentId === agentId)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.executionId.localeCompare(b.executionId));
  const totalExecutions = mine.length;
  const isAll = all === true || limit === Infinity;
  const bound = isAll ? Infinity : (Number.isFinite(limit) && limit > 0 ? limit : MAX_VIEW_EXECUTIONS);
  const effOffset = Math.max(0, Number.isInteger(offset) ? offset : 0);

  let viewed;
  let start = 0;
  if (!Number.isFinite(bound)) {
    viewed = mine;
  } else {
    const end = Math.max(0, totalExecutions - effOffset);
    start = Math.max(0, end - bound);
    viewed = mine.slice(start, end);
  }
  const truncatedExecutions = totalExecutions - viewed.length;
  const withLogs = await mapBounded(
    viewed.map((record) => ({ executionId: record.executionId, record })),
    VIEW_READ_CONCURRENCY,
    (e) => readExecutionLogs(e, listLogs, recordFailure),
  );
  // The body: one user turn + one terminal marker per execution, both from
  // the durable log (the record is the fallback when a row is missing).
  const body = [];
  for (let i = 0; i < withLogs.length; i++) {
    const e = withLogs[i];
    const record = viewed[i];
    const taskRow = e.logs.find((r) => r?.type === "task");
    const task = typeof taskRow?.task === "string" && taskRow.task.trim() ? taskRow.task : String(record.taskPreview ?? "");
    const attachments = Array.isArray(taskRow?.attachments) && taskRow.attachments.length
      ? taskRow.attachments.map((a) => ({ name: a?.name ?? "attachment", type: a?.type ?? "", size: a?.size ?? 0, kind: a?.kind ?? "file", dataURL: typeof a?.dataURL === "string" ? a.dataURL : "" }))
      : undefined;
    body.push({
      role: "user",
      content: task,
      ts: typeof taskRow?.at === "number" ? taskRow.at : (record.startedAt ?? null),
      executionId: e.executionId,
      ...(attachments ? { attachments } : {}),
    });
    const terminalRow = [...e.logs].reverse().find((r) => r && (r.type === "terminal" || r.type === "cancelled" || r.type === "compacted")) ?? null;
    const terminal = terminalRow?.terminal ?? record.terminal ?? null;
    const terminalPhase = record.phase === "terminal" || record.phase === "cancelled";
    if (terminal && terminalPhase) {
      // The retained payload is the ONE authoritative full copy of the answer;
      // the row's `result` is the 240-char list preview
      // (CAP-FB-20260830-RUN-LOG-COMPACTION-01) — the view must never show
      // the preview as the answer.
      const payload = terminalRow?.payload && typeof terminalRow.payload === "object" ? terminalRow.payload : null;
      const full = typeof payload?.result === "string" && payload.result ? payload.result : null;
      const cancelled = terminal.cancelled === true || record.phase === "cancelled";
      const ok = terminal.ok === true && !cancelled;
      const content = full ?? terminal.result ?? terminal.summary ?? terminal.reason ?? (ok ? "" : "run failed");
      body.push({
        role: ok ? "assistant" : "error",
        content: String(content ?? ""),
        ts: typeof terminal.at === "number" ? terminal.at : (typeof terminalRow?.at === "number" ? terminalRow.at : null),
        executionId: e.executionId,
        ...(ok ? {} : { category: cancelled ? "cancelled" : (payload?.errorCategory ?? "error"), reason: payload?.errorReason ?? terminal.reason ?? undefined }),
      });
    }
  }
  const projectSpan = perfSpan("agent-view:project");
  const { messages } = projectThreadWithRunLogs({ id: agentId, messages: body }, withLogs);
  projectSpan.end("ok");
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
  if (truncatedExecutions > 0) {
    messages.unshift(viewBoundNotice(viewed.length, totalExecutions, { turnsKept: false, at: viewed[0]?.startedAt ?? Date.now() }));
  }
  return {
    id: agentId,
    messages,
    totalExecutions,
    truncatedExecutions,
    viewedExecutions: viewed.length,
    hasMore: start > 0,
    ...(withLogs.some((e) => e.truncatedLogs) ? { truncatedLogs: true } : {}),
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
