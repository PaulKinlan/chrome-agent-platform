// shared/conversation.js — the unified conversational surface, shared by the
// NTP hub + the chat. ONE module → one behavior → no drift (the two surfaces
// transform identically from a task start into a live conversation).
//
// Responsibilities:
//   - a long-lived runtime port that receives LIVE progress events (thinking /
//     tool-call / tool-result / text / done) from the service worker,
//   - rendering the persisted journal as a conversation (task → user bubble,
//     result → agent bubble) so reopening shows the history,
//   - the run flow: append the user turn → update the single lifecycle surface
//     + structured tool cards → append the final result.
//
// The container is an <agent-conversation> element (the Web Component that owns
// the message rendering: markdown, code blocks, tool cards, thinking traces).

import { send } from "../lib/messages.js";
import { summarizeToolResult } from "../lib/tool-summary.js";
import { isAuthoritativeThreadResultProjected } from "./thread-projection-authority.js";

// ── the live progress port ────────────────────────────────────────────────
// A single long-lived port per page. The SW broadcasts progress to every
// connected port; the page's handler renders only what it cares about (the
// master run is serialized, so a page receives events for its own run).
let port = null;
const listeners = new Set();
const runListeners = new Set();
const runRecords = new Map();
let runPolicy = null;

function dispatchRunSnapshot(message) {
  runRecords.clear();
  for (const run of (Array.isArray(message?.runs) ? message.runs : [])) {
    if (run?.executionId && Number.isFinite(run?.revision)) runRecords.set(run.executionId, run);
  }
  runPolicy = message?.policy ?? null;
  const snapshot = { policy: runPolicy, runs: [...runRecords.values()] };
  for (const fn of [...runListeners]) {
    try { fn(snapshot); } catch { /* observer isolation */ }
  }
}

function dispatchRunUpdate(message) {
  const run = message?.run;
  if (!run?.executionId || !Number.isFinite(run?.revision)) return;
  const previous = runRecords.get(run.executionId);
  // Client-side stale-event rejection is the final half of the revisioned
  // register-buffer-snapshot-drain protocol.
  if (previous && run.revision <= previous.revision) return;
  runRecords.set(run.executionId, run);
  const snapshot = { policy: runPolicy, runs: [...runRecords.values()] };
  for (const fn of [...runListeners]) {
    try { fn(snapshot); } catch { /* observer isolation */ }
  }
}

function ensurePort() {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: "agent-progress" });
  } catch {
    return null;
  }
  port.onMessage.addListener((msg) => {
    if (msg?.type === "progress" && msg.event) {
      for (const fn of [...listeners]) {
        try {
          fn(msg.event);
        } catch { /* a listener error must not kill the dispatch */ }
      }
    } else if (msg?.type === "run-snapshot") {
      dispatchRunSnapshot(msg);
    } else if (msg?.type === "run-update") {
      dispatchRunUpdate(msg);
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    // A port DISCONNECT is a terminal signal: the SW's final event can no
    // longer arrive, so every still-subscribed run settles fail-closed (error)
    // + removes its listener + clears its cards — no listener/card leak.
    const fns = [...listeners];
    listeners.clear();
    for (const fn of fns) {
      try { fn({ type: "disconnect" }); } catch { /* a listener error must not kill the dispatch */ }
    }
  });
  return port;
}

/** Subscribe to live progress events. Returns an unsubscribe function. */
export function subscribeProgress(fn) {
  listeners.add(fn);
  ensurePort();
  return () => listeners.delete(fn);
}

/** Subscribe to bounded durable run snapshots. Newer per-run revisions replace
 * older state; stale buffered/live events are rejected. Policy-dependent
 * cancellation/retention/progress/resume states pass through explicitly. */
export function subscribeRunRegistry(fn, { emitCurrent = true } = {}) {
  runListeners.add(fn);
  ensurePort();
  if (emitCurrent && (runRecords.size || runPolicy)) {
    fn({ policy: runPolicy, runs: [...runRecords.values()] });
  }
  return () => runListeners.delete(fn);
}

/** Owner-surface durable controls. Cancel is terminal for this execution ID;
 * retrying always uses the ordinary run flow and therefore gets a fresh ID. */
export async function cancelDurableRun(executionId, reason = "explicit owner cancellation") {
  return await send("run.cancel", { executionId, reason, requestId: crypto.randomUUID?.() ?? String(Date.now()) });
}

export async function resumePermissionPausedRun(executionId, { ownerConfirmed = false } = {}) {
  return await send("run.resume", { executionId, ownerConfirmed });
}

export async function loadDurableRunLogs(executionId) {
  return await send("run.logs", { executionId });
}

// ── conversation history (the persistent thread) ───────────────────────────
// The master journal stores `task` + `result` entries in order. Map them to the
// ConversationMessage[] shape agent-do accepts (user/assistant turns) so a
// follow-up / nudge is a NEW turn in the SAME thread, with the prior history.
export function historyFromJournal(journal) {
  const history = [];
  for (const r of (Array.isArray(journal) ? journal : [])) {
    if (r?.type === "task" && typeof r.task === "string" && r.task.trim()) {
      history.push({ role: "user", content: r.task });
    } else if (r?.type === "result" && typeof r.result === "string" && r.result.trim()) {
      history.push({ role: "assistant", content: r.result });
    }
  }
  return history;
}

// ── rendering ──────────────────────────────────────────────────────────────
// appendBubble routes a role to the container's rich methods when it is an
// <agent-conversation>, with a plain <message-bubble> fallback for any other
// element (so callers never need to know which surface they're driving).
export function appendBubble(container, role, text, attachments, ts) {
  const c = container;
  if (role === "user" && typeof c.appendUser === "function") return c.appendUser(text, ts, attachments);
  if (role === "agent" && typeof c.appendAgent === "function") return c.appendAgent(text, ts);
  if (role === "system" && typeof c.appendSystem === "function") return c.appendSystem(text, ts);
  if (role === "error" && typeof c.appendError === "function") return c.appendError(text, { ts });
  if (role === "thinking" && typeof c.appendThinking === "function") return c.appendThinking(text);
  const b = document.createElement("message-bubble");
  b.setAttribute("role", role);
  if (text != null) b.setAttribute("content", String(text));
  c.append(b);
  if (typeof c.scrollTop === "number") c.scrollTop = c.scrollHeight;
  return b;
}

/** Render a persisted journal as a conversation (reopening shows the history). */
export function renderJournal(container, journal) {
  const rows = Array.isArray(journal) ? journal : [];
  if (typeof container.setMessages === "function") {
    container.setMessages(rows
      .filter((r) =>
        (r?.type === "task" && typeof r.task === "string" && r.task.trim()) ||
        (r?.type === "result" && typeof r.result === "string" && r.result.trim()))
      .map((r) => r.type === "task"
        ? { role: "user", content: r.task, attachments: r.attachments }
        : { role: "agent", content: r.result }));
    return;
  }
  container.replaceChildren();
  if (!rows.length) {
    const p = document.createElement("p");
    p.style.color = "var(--muted)";
    p.textContent = "No conversation yet — start one above.";
    container.append(p);
    return;
  }
  for (const r of rows.slice(-20)) {
    if (r?.type === "task" && typeof r.task === "string") {
      appendBubble(container, "user", r.task, r.attachments);
    } else if (r?.type === "result" && typeof r.result === "string") {
      appendBubble(container, "agent", r.result);
    }
  }
  container.scrollTop = container.scrollHeight;
}

/** Read the persisted master journal (the conversation's source of truth). */
export async function loadJournal() {
  const journal = await send("memory.get", { origin: "master", key: "journal" });
  return Array.isArray(journal) ? journal : [];
}

// ── the run transcript projection ────────────────────────────────────────
// The AGENT view's LIVE chat-like transcript (CAP-FB-20260823-AGENT-RUN-VISIBILITY-01):
// a READ-ONLY projection of one run's LIVE progress events, composed into the
// container WITHOUT starting or mutating a run. The RETAINED rows (the completed
// task/tool-call/tool-result) are the history's job (renderAgentHistory in
// ntp.js) — this subscription only streams what is NEW for the run. Never
// touches the provider, the model dispatch, the permissions or the grants.

/** Project ONE durable run into the container as a live, near-real-time
 * transcript: the live progress events tagged with the run's execution id
 * (tool-call / tool-result / text / done / error). Returns an unsubscribe
 * function. Read-only: never mutates the run, the provider, the grants or the
 * model. */
export function renderRunTranscript(container, executionId, { onStatus = null } = {}) {
  const c = container;
  if (!c || !executionId) return () => {};
  const toolCards = createToolCardQueue();
  let unsub = () => {};
  let unsubscribed = false;
  const terminal = createRunTerminal({
    onSettle: (status) => {
      toolCards.flush(status);
      unsubscribe();
    },
  });
  const unsubscribe = () => {
    if (unsubscribed) return;
    unsubscribed = true;
    unsub();
  };

  // The live progress for THIS run (near-real time).
  unsub = subscribeProgress((ev) => {
    if (!ev || typeof ev !== "object") return;
    if (ev.type === "disconnect") { terminal.onPortError(); return; }
    if (ev.runId !== executionId) return;
    switch (ev.type) {
      case "tool-call": {
        onStatus?.({ state: "running", activity: friendlyActivityLabel(ev.toolName, ev.toolArgs) });
        const card = typeof c.appendTool === "function"
          ? c.appendTool({ name: ev.toolName, args: ev.toolArgs, status: "running" })
          : appendBubble(c, "tool", `→ ${ev.toolName}`);
        toolCards.push(ev.toolName, card);
        break;
      }
      case "tool-result": {
        const card = toolCards.take(ev.toolName);
        const raw = safeToolResult(ev.result);
        const summary = ev.result != null ? summarizeToolResult(ev.toolName, ev.result) : "";
        const status = isToolErrorEvent(ev) ? "error" : "success";
        if (card) {
          card.setAttribute?.("tool-status", status);
          if (ev.durationMs != null) card.setAttribute?.("tool-duration", String(ev.durationMs));
          if (summary) card.setAttribute?.("tool-result", summary);
          if (raw && raw !== summary) card.setAttribute?.("tool-detail", raw);
        } else if (typeof c.appendTool === "function") {
          c.appendTool({ name: ev.toolName, status, result: summary, detail: raw !== summary ? raw : null, durationMs: ev.durationMs });
        }
        break;
      }
      case "text":
        if (ev.text && ev.hasToolCalls) appendBubble(c, "agent", ev.text);
        break;
      case "done":
        terminal.onPortDone(ev.aborted === true);
        // The agent view has no other live source for the conclusion — append
        // the streamed text on a NON-aborted settle (an aborted run reports no
        // successful answer).
        if (ev.aborted !== true && ev.text) appendBubble(c, "agent", ev.text);
        break;
      case "error":
        terminal.onPortError();
        onStatus?.({ state: "failed", message: ev.reason ?? ev.message ?? "error" });
        break;
      default:
        break;
    }
  });

  return unsubscribe;
}

// ── the run flow ───────────────────────────────────────────────────────────
// The ONE place the task-start → live-conversation transition lives. Both the
// hub + the chat drive it, so they transform identically.
//
//   runConversationTurn(container, { text, attachments, history })
//     1. appends the user turn,
//     2. owns queued/running/retrying state through one lifecycle callback,
//     3. streams live progress (structured tool cards below it),
//     4. returns the final { ok, result } and appends the result bubble.
//
// A mid-run nudge is simply ANOTHER turn: the composer stays live, and a
// follow-up message appends to the same conversation + runs after the current
// turn (the SW serializes master runs), carrying the prior history.
/** Format a tool result for the LIVE progress card without ever producing
 * "[object Object]" (the wider-goal review's finding): objects/arrays become
 * bounded JSON; strings pass through; anything else is String()'d. Bounded to
 * keep a huge result from blowing up the DOM. */
export function safeToolResult(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  // Route hostile/cyclic objects through the BOUNDED safe serializer — never
  // a raw String(object) "[object Object]" in a live tool result.
  try {
    return safeJsonStringify(value, { maxBytes: 2000, maxNodes: 50, maxString: 400 });
  } catch {
    return '"[unserializable value]"';
  }
}

/** A per-run client id so the live progress listener renders ONLY its own run
 * (the SW tags events with it; the global port otherwise leaks other threads'
 * tool data). */
function newRunId() {
  try { return crypto.randomUUID(); } catch { return `r_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }
}

/** A human activity label for a tool call, so the live status reads "Working…
 * creating agent Paul" rather than "Working… create_named_agent". The arg
 * object is inspected for a name/url/agent so the label is concrete. */
export function friendlyActivityLabel(toolName, args) {
  const a = args && typeof args === "object" ? args : {};
  const name = a.name || a.agent || a.origin || a.url || a.title || "";
  const parts = String(toolName || "tool").split("_");
  const verb = parts.length > 1 ? parts.join(" ") : toolName;
  switch (toolName) {
    case "create_named_agent": return name ? `creating agent ${name}` : "creating an agent";
    case "update_named_agent": return name ? `updating agent ${name}` : "updating an agent";
    case "delete_named_agent": return name ? `deleting agent ${name}` : "deleting an agent";
    case "list_named_agents": return "listing agents";
    case "schedule_task": return "scheduling a task";
    case "create_agent": return "creating an agent";
    case "list_agents": return "listing agents";
    case "open_tab": case "navigate": return name ? `opening ${name}` : "opening a page";
    case "memory_set": return "writing memory";
    case "memory_grep": return "searching memory";
    case "generate_ui": return "generating UI";
    case "create_asset": return name ? `creating ${name}` : "creating an artifact";
    case "delegate_task": return name ? `delegating to ${name}` : "delegating a task";
    default: return verb;
  }
}

// ── the tool-card lifecycle (pure, unit-testable) ───────────────────────────
// The live progress path keeps a FIFO queue of in-flight tool cards per tool
// NAME (parallel same-name calls resolve in order); the run lifecycle MUST
// resolve every queued card (done / error / abort) so no card stays
// permanently "running".

/** A per-tool-name FIFO queue of tool-card elements. */
export function createToolCardQueue() {
  const map = new Map();
  return {
    push(name, card) {
      const q = map.get(name) ?? [];
      q.push(card);
      map.set(name, q);
    },
    take(name) {
      const q = map.get(name);
      if (!q || !q.length) return null;
      return q.shift();
    },
    pendingCount() {
      let n = 0;
      for (const q of map.values()) n += q.length;
      return n;
    },
    /** Resolve every still-in-flight card (never left permanently running). */
    flush(status) {
      let n = 0;
      for (const q of map.values()) {
        for (const card of q) {
          card?.setAttribute?.("tool-status", status);
          n += 1;
        }
      }
      map.clear();
      return n;
    },
  };
}

/** Whether a live tool-result event signals FAILURE. The SW's `ok` flag is
 * AUTHORITATIVE — text heuristics apply ONLY when `ok` is absent (older
 * producers / journal replay), so a valid summary like "failed attempts: 0"
 * with ok:true never misclassifies as an error. */
export function isToolErrorEvent(ev) {
  if (ev?.ok === true) return false;
  if (ev?.ok === false) return true;
  const s = String(ev?.result ?? "");
  return /^\s*failed\b/i.test(s) || /^\s*\[[^\]]+\]\s*DENIED/i.test(s);
}

/** The run TERMINAL arbiter: settles the in-flight tool-card queue exactly
 * once, on the AUTHORITATIVE final event, whichever channel arrives last.
 *
 * Both orderings must be correct:
 *   - port-before-response: the port's done/error settles immediately; the
 *     later request response is a no-op.
 *   - response-before-port: the response arms a GRACE window; a delayed
 *     tool-result {ok:false} or done {aborted:true} still wins (it settles
 *     the queue with the true status), and only when the grace expires does
 *     the response's own ok decide. The listener stays subscribed through the
 *     grace so late current-run events are never dropped.
 * Deterministic: `timers` (setTimeout/clearTimeout) can be injected for tests.
 */
export function createRunTerminal({ onSettle = null } = {}) {
  // NO timing dependency: the terminal settles IMMEDIATELY on the first
  // AUTHORITATIVE event — the port's done/error, or the run RESPONSE (which
  // now carries the final outcome, including aborted). Either channel alone is
  // sufficient; the other is an idempotent no-op. Settling unsubscribes the
  // listener, so a late event is never misapplied.
  let settled = false;
  let status = null;
  const settle = (st) => {
    if (settled) return;
    settled = true;
    status = st;
    onSettle?.(st);
  };
  return {
    get settled() { return settled; },
    get status() { return status; },
    /** the port's final event is authoritative */
    onPortDone(aborted) { settle(aborted ? "error" : "success"); },
    onPortError() { settle("error"); },
    /** the request response carries the FINAL run outcome (ok + aborted) */
    onResponse(ok, aborted = false) { settle(ok && !aborted ? "success" : "error"); },
    /** force-settle now (tests / a hard abort) */
    force(status) { settle(status); },
  };
}

/** Pair persisted journal tool rows into ONE terminal card per tool call.
 * The SW persists a per-call `callId` (run-instance scoped) on BOTH rows; a
 * replay must render ONE card with the call's args + a TERMINAL status:
 *   - ok:false → "error" (failed/blocked)
 *   - ok:true  → "success"
 *   - ok ABSENT (legacy rows) → the result TEXT heuristic (a "failed"/"DENIED"
 *     result restores as error, not a blanket success)
 *   - no result at all → "done" (terminal — the component maps done → done,
 *     never running)
 * LEGACY rows without a callId pair by (id, tool, occurrence index) — the Nth
 * call pairs with the Nth result of the same (id, tool), independent of the
 * row order bookkeeping (the old `order.length` fallback gave different ids to
 * a call and its result). Pure — unit-tested; used by the agent-history
 * surfaces (ntp.js). */
export function pairToolJournal(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const byCall = new Map(); // callId -> { call, result, ts }
  const order = [];
  // Legacy (no callId) pairing: the Nth CALL of an (id, tool) pairs with the
  // Nth RESULT of the same (id, tool) — separate counters, shared indexes (the
  // old single counter gave a call and its result DIFFERENT indexes).
  const legacyCallSeq = new Map();
  const legacyResultSeq = new Map();
  const legacyId = (r) => {
    const k = `${r.id ?? ""}::${r.tool ?? ""}`;
    if (r.type === "tool-call") {
      const n = legacyCallSeq.get(k) ?? 0;
      legacyCallSeq.set(k, n + 1);
      return `legacy:${k}:${n}`;
    }
    const n = legacyResultSeq.get(k) ?? 0;
    legacyResultSeq.set(k, n + 1);
    return `legacy:${k}:${n}`;
  };
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    if (r.type === "tool-call" || r.type === "tool-result") {
      // The pairing key includes the persisted RUN instance — a corrupt or
      // duplicate row from ANOTHER run (or a replayed schedule) can never
      // collapse into this run's cards.
      const id = typeof r.callId === "string" && r.callId
        ? `${r.run ?? ""}::${r.callId}`
        : legacyId(r);
      const entry = byCall.get(id);
      if (!entry) {
        byCall.set(id, { call: null, result: null, ts: typeof r.ts === "number" ? r.ts : null, duplicate: false });
        order.push(id);
      }
      // The expected complementary pair (a call + its result) is NOT a
      // duplicate — only a SECOND same-type row (two calls or two results for
      // the same key) flags the card; the duplicate is never silently dropped.
      if (r.type === "tool-call") {
        if (!byCall.get(id).call) byCall.get(id).call = r;
        else byCall.get(id).duplicate = true;
      } else {
        if (!byCall.get(id).result) byCall.get(id).result = r;
        else byCall.get(id).duplicate = true;
      }
    }
  }
  const out = [];
  for (const id of order) {
    const { call, result, ts } = byCall.get(id);
    const tool = call?.tool ?? result?.tool ?? "tool";
    const ok = result?.ok;
    let status;
    if (!result) status = "done";
    else if (ok === false) status = "error";
    else if (ok === true) status = "success";
    else {
      // legacy: ok absent → the text heuristic (failed/DENIED restores as error)
      const s = String(result.result ?? "");
      status = /^\s*failed\b/i.test(s) || /^\s*\[[^\]]+\]\s*DENIED/i.test(s) ? "error" : "success";
    }
    out.push({
      type: "tool",
      tool,
      status,
      // the ORIGINAL immutable callId (the composite ${run}::${callId} stays
      // the INTERNAL pairing key only — persisting it would re-prefix on every
      // reload)
      callId: call?.callId ?? result?.callId ?? id,
      args: call?.args ?? result?.args ?? null,
      result: result?.result ?? null,
      ok: result?.ok ?? null,
      ts,
      duplicate: byCall.get(id)?.duplicate === true,
    });
  }
  return out;
}

/** The REOPEN projection for a persisted task thread (CAP-FB-20260824-THREAD-REOPEN-RENDER-01):
 * the pure transform behind ntp.js's renderThreadProjection. EVERY persisted
 * non-tool row (user + assistant + error + system) is kept with its role/
 * content/ts, and the tool rows replay as ONE terminal card per call via the
 * pairToolJournal pairing — the merged list is ts-ordered. A reopened task
 * must show the owner's request bubbles AND the assistant's replies exactly
 * as persisted; dropping a non-tool role here hides it from the owner. Pure —
 * unit-tested against the real <agent-conversation> setMessages. */
export function projectThreadMessages(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const toolRows = pairToolJournal(
    messages
      .filter((m) => m.role === "tool")
      .map((m) => ({
        type: m.toolStatus === "running" ? "tool-call" : "tool-result",
        callId: m.toolCallId ?? null,
        run: null,
        tool: m.toolName ?? "tool",
        args: m.toolArgs ?? null,
        result: m.toolResult ?? null,
        ok: m.toolOk ?? null,
        ts: typeof m.ts === "number" ? m.ts : null,
      })),
  );
  const toolCards = toolRows.map((t) => ({
    role: "tool",
    name: t.tool,
    status: t.status,
    args: t.args ?? null,
    result: t.result ?? null,
    ts: t.ts ?? null,
  }));
  return [
    ...messages
      .filter((m) => m.role !== "tool")
      .map((m) => ({
        role: m.role,
        content: m.content,
        ts: m.ts ?? null,
        reason: m.reason ?? null,
        action: m.action ?? null,
        attachments: Array.isArray(m.attachments) ? m.attachments : (m.attachments ? [m.attachments] : null),
      })),
    ...toolCards,
  ].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

export async function runConversationTurn(container, { text, attachments = [], history = [], threadId = null, onStatus = null, agentId = null, agentKind = null, isStale = null, projectionOwner = null }) {
  const c = container;
  // The RUN-LIFECYCLE FENCE: the caller passes isStale() returning true once
  // this turn no longer owns the surface (a newer turn started, or the user
  // left mid-flight). A stale turn keeps executing in the SW (its result is
  // journaled — nothing is lost) but stops RENDERING: no status flips, no
  // progress cards, no result/error bubble into a surface it no longer owns.
  const stale = () => {
    try { return typeof isStale === "function" && !!isStale(); }
    catch { return false; }
  };
  const status = (s) => { if (!stale()) onStatus?.(s); };
  // Surface the accepted turn immediately, including while provider capability
  // checks are pending. This is the sole queued signal for the conversation.
  status({ state: "queued" });

  // Do not treat the original Run click as a live gesture after an asynchronous
  // provider lookup: calling permissions.request after that round-trip is
  // rejected by Chrome and creates a misleading retry loop. This redacted
  // preflight keeps provider secrets out of the page and pauses before any
  // model execution. The complete owner-button orchestration remains OPEN; for
  // now Settings is the only genuine permission-request surface.
  try {
    const summary = await send("provider.permission-summary");
    if (!summary?.local) {
      if (!summary?.origin) throw new Error("configured provider origin is invalid");
      const granted = await chrome.permissions.contains({ origins: [summary.origin] }).catch(() => false);
      if (!granted) {
        const err = {
          ok: false,
          waitingForPermission: true,
          error: `network access to ${summary.origin} is not granted — open Settings → Providers and approve that exact origin`,
          errorCategory: "host-permission",
          errorReason: "the configured provider's exact origin is not granted",
          errorAction: "grant the exact provider origin in Settings, then run this task again",
        };
        if (stale()) return { ok: false, superseded: true, error: "the surface was replaced before the run started" };
        status({ state: "waiting-for-permission", message: err.errorReason, errorReason: err.errorReason, errorAction: err.errorAction, errorCategory: err.errorCategory });
        if (typeof c.appendError === "function") c.appendError(err.error, { reason: err.errorReason, action: err.errorAction, category: err.errorCategory });
        else appendBubble(c, "error", err.error);
        return err;
      }
    }
  } catch (e) {
    const err = {
      ok: false,
      waitingForPermission: true,
      error: `provider permission preflight failed closed: ${e?.message ?? e}`,
      errorCategory: "host-permission",
    };
    if (stale()) return { ok: false, superseded: true, error: "the surface was replaced before the run started" };
    status({ state: "waiting-for-permission", message: err.error, errorCategory: err.errorCategory });
    if (typeof c.appendError === "function") c.appendError(err.error, { category: err.errorCategory });
    else appendBubble(c, "error", err.error);
    return err;
  }
  const appendProviderGrant = (category) => {
    if (category !== "host-permission") return;
    appendBubble(c, "system", "Provider access is missing or was revoked. Open Settings → Providers to approve the exact origin, then run the task again.");
  };
  // 1. the user's turn appears immediately — the surface becomes a conversation.
  if (stale()) return { ok: false, superseded: true, error: "the surface was replaced before the run started" };
  appendBubble(c, "user", text, attachments);
  // The lifecycle surface is the sole owner of queued/working feedback. Do not
  // append a second thinking bubble/spinner to the conversation log.

  // Keep run + result rendering in one attempt-scoped function. Every attempt
  // owns its runId, queue, arbiter, and listener, so stale events from another
  // page or attempt are never accepted.
  let attempt = 0;
  const executeTurn = async () => {
  // A grant-retry re-enters here after its own permission awaits — re-check.
  if (stale()) return { ok: false, superseded: true, error: "the surface was replaced before the run started" };
  const runId = newRunId();
  attempt += 1;
  status({ state: attempt > 1 ? "retrying" : "running", activity: attempt > 1 ? "Retrying…" : "Thinking…" });
  // Per-call tool cards: a FIFO queue per tool NAME so parallel same-name calls
  // are matched in order and a completed card is never duplicated (the
  // wider-goal review's finding that a single `lastTool` left A's card running
  // and created a duplicate completed card when calls interleave).
  const toolCards = createToolCardQueue();
  // The live `text` progress event already projects the assistant's final
  // words when tool calls ran; the completion handler would otherwise append
  // the IDENTICAL res.result as a second terminal bubble (the late-settled
  // duplicate-projection defect). Remember what was streamed; the completion
  // append fires only when the authoritative result differs.
  let streamedAgentText = null;
  // The terminal arbiter: settles the queue + unsubscribes EXACTLY ONCE on the
  // first authoritative terminal (the port's done/error or the run response —
  // which carries the final outcome incl. aborted). No timing dependency.
  const terminal = createRunTerminal({
    onSettle: (status) => {
      toolCards.flush(status);
      unsubscribe();
    },
  });

  // 3. subscribe to the live progress for THIS attempt. The port broadcast is
  //    global, so we FILTER by runId — events for another thread/page/attempt
  //    are ignored (never mis-attributed). We unsubscribe at settle.
  const unsubscribe = subscribeProgress((ev) => {
    if (!ev || typeof ev !== "object") return;
    // a port DISCONNECT settles fail-closed (the terminal can no longer arrive)
    if (ev.type === "disconnect") {
      terminal.onPortError();
      // The lifecycle surface must not stick on running when the port dies.
      status({ state: "failed", message: "lost connection to the agent runtime", errorReason: "the progress connection dropped", errorAction: "the result is journaled — reopen the thread to check", errorCategory: "network" });
      return;
    }
    // Only render THIS attempt's events — FAIL-CLOSED on the exact runId.
    if (ev.runId !== runId) return;
    // The fence: this turn no longer owns the surface — render nothing more
    // (the arbiter still settles the queue + unsubscribes via the terminal).
    if (stale()) {
      if (ev.type === "done") terminal.onPortDone(ev.aborted === true);
      else if (ev.type === "error") terminal.onPortError();
      return;
    }
    switch (ev.type) {
      case "thinking": {
        const step = ev.step != null ? ev.step + 1 : null;
        const total = ev.totalSteps != null ? ` of ${ev.totalSteps}` : "";
        status({
          state: attempt > 1 ? "retrying" : "running",
          activity: step != null ? `Thinking · step ${step}${total}` : "Thinking…",
        });
        break;
      }
      case "tool-call": {
        status({ state: attempt > 1 ? "retrying" : "running", activity: friendlyActivityLabel(ev.toolName, ev.toolArgs) });
        const card = typeof c.appendTool === "function"
          ? c.appendTool({ name: ev.toolName, args: ev.toolArgs, status: "running" })
          : appendBubble(c, "tool", `→ ${ev.toolName}`);
        toolCards.push(ev.toolName, card);
        break;
      }
      case "tool-result": {
        // Match the OLDEST in-flight card for this tool name (FIFO — handles
        // parallel same-name calls in order); mark it done on success, error on
        // a FAILED result (the SW tags `ok:false` — never a blanket success).
        const card = toolCards.take(ev.toolName);
        const raw = safeToolResult(ev.result);
        const summary = ev.result != null ? summarizeToolResult(ev.toolName, ev.result) : "";
        const err = isToolErrorEvent(ev);
        const status = err ? "error" : "success";
        if (card) {
          card.setAttribute?.("tool-status", status);
          if (ev.durationMs != null) card.setAttribute?.("tool-duration", String(ev.durationMs));
          if (summary) card.setAttribute?.("tool-result", summary);
          if (raw && raw !== summary) card.setAttribute?.("tool-detail", raw);
        } else if (typeof c.appendTool === "function") {
          c.appendTool({ name: ev.toolName, status, result: summary, detail: raw !== summary ? raw : null, durationMs: ev.durationMs });
        } else {
          appendBubble(c, "tool", `✓ ${ev.toolName}${summary ? ` — ${summary}` : ""}`);
        }
        break;
      }
      case "text":
        if (ev.text && ev.hasToolCalls) {
          appendBubble(c, "agent", ev.text);
          streamedAgentText = ev.text;
        }
        break;
      case "done":
        // The port's done is AUTHORITATIVE (aborted → error): settles the
        // queue once; a later response is a no-op. An ABORTED run must never
        // report a successful "done" status.
        terminal.onPortDone(ev.aborted === true);
        if (ev.aborted === true) {
          status({ state: "cancelled", message: "run aborted", errorReason: "the run was aborted", errorAction: "the run stopped before completing", errorCategory: "aborted" });
        }
        break;
      case "error":
        terminal.onPortError();
        status({
          state: "failed",
          message: ev.reason ?? ev.message ?? "error",
          errorReason: ev.reason ?? null,
          errorAction: ev.action ?? null,
          errorCategory: ev.category ?? null,
        });
        if (typeof c.appendError === "function") {
          c.appendError(ev.message ?? "error", { reason: ev.reason ?? null, action: ev.action ?? null, category: ev.category ?? null });
        } else {
          appendBubble(c, "error", ev.message ?? "error");
        }
        appendProviderGrant(ev.category ?? null);
        break;
    }
  });

  // 4. run the task (history = the prior turns, so a nudge steers the thread).
  //    A named-agent chat (agentId set, agentKind="named") delegates to that
  //    agent's OWN sandbox; a background-agent chat (agentKind="background")
  //    runs the task in the background agent's own memory.
  let res;
  try {
    if (agentKind === "site") {
      // A Site Agent: direct delegation to the enrolled origin's worker agent
      // (agent.delegate — generation-fenced, journaled to the site's OWN OPFS
      // store). Site delegation carries the task TEXT only (no attachments yet,
      // no live per-run progress) — say so honestly when attachments exist.
      if (attachments.length && typeof c.appendSystem === "function") {
        c.appendSystem("Attachments aren't delivered to Site Agents yet — the text was sent.");
      }
      res = await send("agent.delegate", {
        origin: agentId,
        task: text,
      });
    } else if (agentKind === "background") {
      res = await send("background-agent.run", {
        id: agentId,
        task: text,
        runId,
        attachments,
      });
    } else if (agentId) {
      res = await send("named-agent.run", {
        id: agentId,
        task: text,
        runId,
        attachments,
      });
    } else {
      res = await send("agent.run", {
        task: text,
        id: String(Date.now()),
        runId,
        attachments,
        history,
        threadId,
      });
    }
  } catch (e) {
    res = { ok: false, error: String(e?.message ?? e) };
  } finally {
    // The response IS the terminal handshake: it carries the FINAL run outcome
    // (ok + aborted — the SW propagates the aborted/cancelled state), so the
    // arbiter settles immediately — NO timing dependency, and an aborted run
    // can never be mislabelled by a later port event (which is now a no-op).
    terminal.onResponse(res?.ok === true, res?.aborted === true);
  }

  // 5. the final result (the journal is the source of truth; append the result
  //    bubble locally so the user sees the outcome without a refresh). The
  //    TERMINAL outcome is authoritative: an aborted/failed run must NEVER
  //    append a successful assistant result or report a done status — the
  //    abort controls the OVERALL run outcome, not just the card colours.
  // The fence: a stale turn appends NOTHING — its result lives in the journal.
  if (stale()) return res;
  const outcome = terminal.status ?? (res?.ok === true ? "success" : "error");
  if (outcome === "success" && res?.ok) {
    const projectedThreadId = res?.threadId ?? threadId;
    const authoritativeAlreadyProjected = isAuthoritativeThreadResultProjected(c, {
      threadId: projectedThreadId,
      executionId: res?.executionId,
      owner: projectionOwner,
      content: res?.result,
    });
    if (
      typeof res.result === "string" &&
      res.result &&
      res.result !== streamedAgentText &&
      !authoritativeAlreadyProjected
    ) {
      appendBubble(c, "agent", res.result);
    }
    status({ state: "completed" });
  } else {
    // A provider/config failure must be CLEAR + ACTIONABLE, not a generic
    // "Error: …" — surface the UNWRAPPED reason + the "what to do" + a
    // "Fix in Settings" button (the category drives the button).
    const reason = res?.errorReason ?? (res?.aborted ? "the run was aborted" : null);
    const action = res?.errorAction ?? (res?.aborted ? "the run stopped before completing" : null);
    const category = res?.errorCategory ?? (res?.aborted ? "aborted" : null);
    const msg = res?.error ?? (res?.aborted ? "run aborted" : "unknown error");
    status({
      state: res?.aborted ? "cancelled" : "failed",
      message: reason ?? msg,
      errorReason: reason,
      errorAction: action,
      errorCategory: category,
    });
    if (typeof c.appendError === "function") {
      c.appendError(msg, { reason, action, category });
    } else {
      appendBubble(c, "error", "Error: " + msg);
    }
    appendProviderGrant(category);
  }
  return res;
  };

  // 6. Run this turn once. Permission failures require a new owner-initiated
  // attempt after Settings changes; this page never loops or auto-retries.
  return await executeTurn();
}
