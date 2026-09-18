// extension/lib/acp-thread-journal.js — the CAP-side RECORD of an ACP turn.
//
// An ACP turn's loop runs in the external harness, not in CAP, so nothing was
// writing it down: the conversation lived only in the live surface and the hub's
// task list never showed it (bead chrome-agent-platform-hg03). This module
// journals it into the SAME thread/task store a browser run uses — one store,
// reusing createThread / continueThread / appendThreadMessage /
// commitThreadTerminal — so the task appears in the list and reopens with its
// transcript.
//
// The store helpers are INJECTED (the service worker passes the real ones) so
// the composition is unit-testable without a service worker, which is where the
// ordering and idempotence rules actually live.
//
// NOT in scope here: registering a durable RUN for the turn. The harness owns
// the run, and the run registry/Stop path for ACP turns is tracked separately
// (chrome-agent-platform-c6gq, which depends on this bead). The execution id
// minted below is what settles the THREAD; it is deliberately not a durable run
// id, and nothing pretends it is.

/**
 * @param {any} value
 * @param {string} [fallback]
 * @returns {string}
 */
const slug = (v, f = "unknown") => String(v ?? "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48) || f;

let counter = 0;

export function acpExecutionId(harnessId, sessionId, now = Date.now()) {
  counter = (counter + 1) % 1_000_000;
  return `acp:${slug(harnessId, "pi")}:${slug(sessionId, "session")}:${now.toString(36)}-${counter.toString(36)}`;
}

export function acpToolRows(events = [], executionId = "") {
  const byCall = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.kind !== "tool" || !ev.detail) continue;
    const callId = ev.toolCallId || ev.detail;
    byCall.set(callId, {
      role: "tool",
      toolName: String(ev.name || ev.toolName || ev.detail || "harness tool"),
      toolStatus: ev.status || "running",
      toolDetail: ev.detail,
      toolCallId: callId,
      ...(executionId ? { executionId } : {}),
    });
  }
  return [...byCall.values()];
}

/**
 * @param {{task?: string, attachments?: any[], threadId?: string|null, harnessId?: string|null, sessionId?: string|null}} [params]
 * @param {any} [deps]
 */
export async function openAcpTurn({ task = "", attachments = [], threadId = null, harnessId = "pi", sessionId = null } = {}, deps = {}) {
  const { createThread, continueThread, nameThread } = deps;
  const executionId = acpExecutionId(harnessId, sessionId);
  try {
    if (threadId) {
      if (!continueThread) return { ok: false, error: "continueThread unavailable", executionId };
      const cont = await continueThread(threadId, task, attachments);
      if (!cont?.thread) return { ok: false, error: "continue failed", executionId };
      return { ok: true, threadId: cont.thread.id, history: cont.history ?? [], executionId, created: false };
    }
    if (!createThread) return { ok: false, error: "createThread unavailable", executionId };
    const thread = await createThread(task, attachments);
    if (!thread?.id) return { ok: false, error: "create failed", executionId };
    try { nameThread?.(thread.id, task); } catch {}
    return { ok: true, threadId: thread.id, history: [], executionId, created: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), executionId };
  }
}

/**
 * @param {{threadId?: string|null, executionId?: string, text?: string, ok?: boolean, error?: string, tools?: any[]}} [params]
 * @param {any} [deps]
 */
export async function recordAcpTurn({ threadId = null, executionId = "", text = "", ok = true, error = "", tools = [] } = {}, deps = {}) {
  const { appendThreadMessage, commitThreadTerminal } = deps;
  if (!threadId || !executionId) return { ok: false, error: "missing id" };
  try {
    if (!commitThreadTerminal) return { ok: false, error: "commit unavailable" };
    const committed = await commitThreadTerminal(threadId, executionId, {
      role: ok ? "assistant" : "error",
      content: String(ok ? (text ?? "") : (error || text || "turn failed")),
      ...(ok ? {} : { category: "harness-error", reason: String(error || "unknown"), action: "Retry the message." }),
    });
    if (!committed) return { ok: false, error: "thread missing" };
    for (const row of acpToolRows(tools, executionId)) {
      if (appendThreadMessage) await appendThreadMessage(threadId, row);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
