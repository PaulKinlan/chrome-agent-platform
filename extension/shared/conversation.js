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
import { safeJsonStringify } from "./tool-tree.js";
import { artifactIdentityFromPayloads } from "./thread-view.js";
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

/** Wire a conversation surface's REPLAYED grant cards (the `approval` rows a
 * reopened thread derives from persisted denials — CAP-FB-20260827-TOOL-CALL-
 * LEGIBILITY-01 §2b). The card's Allow is the owner's gesture: request the
 * exact permissions, set the exact browser-control grant (the same path the
 * live card takes — approvePermissionRequirement), then resume the run if it
 * is still paused on that requirement; a settled run cannot continue, and the
 * card says so instead of pretending. Every failure is shown on the card.
 * Returns an unsubscribe function. */
export function wireReplayApprovals(container) {
  const c = container;
  if (!c || typeof c.addEventListener !== "function") return () => {};
  const handler = async (ev) => {
    const d = ev?.detail;
    if (!d || !d.requirement || !d.card) return;
    const card = d.card;
    if (d.approve !== true) {
      card.setAttribute?.("state", "denied");
      return;
    }
    const outcome = await approvePermissionRequirement(d.requirement)
      .catch((e) => ({ ok: false, errors: [String(e?.message ?? e)] }));
    if (!outcome?.ok) {
      card.setAttribute?.("state", "error");
      card.setAttribute?.("detail", (outcome?.errors ?? []).join("; ") || "the approval could not be completed");
      return;
    }
    let resumed = false;
    if (typeof d.executionId === "string" && d.executionId) {
      const res = await resumePermissionPausedRun(d.executionId, { ownerConfirmed: true }).catch(() => null);
      resumed = res?.ok === true;
    }
    card.setAttribute?.("detail", resumed ? "Approved — continuing…" : "Approved. Ask again and the agent can use it.");
    card.setAttribute?.("state", "granted");
  };
  c.addEventListener("approval-decision", handler);
  return () => { try { c.removeEventListener("approval-decision", handler); } catch { /* detached */ } };
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

// Streamed assistant text (CAP-FB-20260830-TRANSCRIPT-STREAMING-01): the
// `text-delta` progress events grow ONE interim agent bubble per step (the same
// row the step's final `text` event / the run's `done` then replace with the
// sanitised markdown render — never a second bubble). Deltas are appended as
// text nodes only. A delta with `start:true` after text already streamed for
// the step is a within-run retry: the bubble restarts.
export function createStreamProjector(container) {
  let bubble = null;
  let step = null;
  return {
    /** Append a delta; returns true when this was the first visible text of a step. */
    onDelta(ev) {
      const delta = typeof ev?.delta === "string" ? ev.delta : "";
      if (!delta) return false;
      const evStep = Number.isInteger(ev.step) ? ev.step : 0;
      let first = false;
      if (!bubble || !bubble.isConnected || step !== evStep) {
        bubble = appendBubble(container, "agent", "");
        step = evStep;
        first = true;
      } else if (ev.start === true) {
        bubble.resetStream?.();
      }
      if (typeof bubble.appendText === "function") bubble.appendText(delta);
      else bubble.setAttribute("content", (bubble.getAttribute("content") ?? "") + delta);
      return first;
    },
    /** Replace the streamed body with the final text; returns the bubble, or
     *  null when no bubble streamed for that step (the caller appends). */
    finalize(evStep, text) {
      const s = Number.isInteger(evStep) ? evStep : null;
      if (!bubble || !bubble.isConnected || (s != null && step !== s)) return null;
      const b = bubble;
      bubble = null;
      step = null;
      if (typeof text === "string" && text) b.setAttribute("content", text);
      else if (text === "") b.remove();
      else b.removeAttribute("streaming"); // keep what streamed (an aborted run)
      return b;
    },
    get active() { return Boolean(bubble && bubble.isConnected); },
  };
}

// The visible marker the runtime honesty backstop prepends to every appended
// correction (extension/lib/mutation-claim-check.js). It is compared as TEXT
// only — the correction is rendered by the bubble, never as markup.
const CLAIM_CORRECTION_MARKER = "⚠️ Correction:";

/**
 * Whether `final` is exactly `rendered` with one or more claim corrections
 * appended — i.e. the same turn's reply, corrected. Used to update the already
 * rendered bubble in place rather than painting the answer a second time.
 */
export function isClaimCorrectionOf(final, rendered) {
  if (typeof final !== "string" || typeof rendered !== "string" || !rendered) return false;
  if (final.length <= rendered.length || !final.startsWith(rendered)) return false;
  return final.slice(rendered.length).includes(CLAIM_CORRECTION_MARKER);
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
  const streamer = createStreamProjector(c);
  // Same one-bubble-per-distinct-final-text rule as the task surface.
  let lastAgentText = null;
  let lastAgentBubble = null;
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
        // The invoked tool is not known until the result arrives, but the
        // arguments already carry it nested under `arguments` alongside a
        // selectionRef that means nothing to a reader — unwrap now so the card
        // never shows protocol plumbing, even briefly.
        const callEff = effectiveToolCall(ev.toolName, ev.toolArgs, null);
        // A protocol call renders no card (§9) — a sentinel keeps the FIFO
        // pairing honest so its result never spawns an orphan card either.
        const card = isProtocolTool(ev.toolName)
          ? { protocol: true }
          : typeof c.appendTool === "function"
            ? c.appendTool({ name: callEff.name, args: callEff.args, status: "running" })
            : appendBubble(c, "tool", `→ ${ev.toolName}`);
        toolCards.push(ev.toolName, card);
        break;
      }
      case "tool-result": {
        const card = toolCards.take(ev.toolName);
        if (card?.protocol === true || (!card && isProtocolTool(ev.toolName))) break;
        // The card shows the SELECTED tool's own result — summary and raw —
        // never the lazy envelope around it (§9/§10).
        const inner = lazyInnerResult(ev.result);
        const shown = inner !== undefined ? inner : ev.result;
        const resEff = effectiveToolCall(ev.toolName, ev.toolArgs, ev.result);
        const raw = safeToolResult(shown);
        const summary = shown != null ? summarizeToolResult(resEff.name, shown) : "";
        const status = isToolErrorEvent(ev) ? "error" : "success";
        // Remember id → name from the untruncated live result BEFORE the card
        // re-renders, so the card (and a later update card) can be titled
        // with the artifact's name (CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01).
        if (status === "success" && typeof c.rememberArtifact === "function") {
          const known = artifactIdentityFromPayloads([ev.result]);
          if (known) c.rememberArtifact(known.id, known.name);
        }
        if (card) {
          // The result names the tool that actually ran; correct the header
          // from `execute_tool` to that name now it is known. The event's own
          // `selectedTool` (emitted by the runtime) is authoritative — the
          // summarized result text no longer carries the envelope.
          const corrected = (typeof ev.selectedTool === "string" && ev.selectedTool) ||
            (resEff.lazy && resEff.name !== ev.toolName ? resEff.name : "");
          if ((ev.toolName === "execute_tool" || ev.toolName === "search_tools") && corrected && corrected !== ev.toolName) {
            card.setAttribute?.("tool-name", corrected);
          }
          if (resEff.args != null) {
            try { card.setAttribute?.("tool-args", JSON.stringify(resEff.args)); } catch { /* keep what is there */ }
          }
          card.setAttribute?.("tool-status", status);
          if (ev.durationMs != null) card.setAttribute?.("tool-duration", String(ev.durationMs));
          if (summary) card.setAttribute?.("tool-result", summary);
          if (raw && raw !== summary) card.setAttribute?.("tool-detail", raw);
        } else if (typeof c.appendTool === "function") {
          c.appendTool({ name: ev.toolName, status, result: summary, detail: raw !== summary ? raw : null, durationMs: ev.durationMs });
        }
        break;
      }
      case "text-delta":
        if (streamer.onDelta(ev)) onStatus?.({ state: "running", activity: "Writing the answer…" });
        break;
      case "text":
        if (ev.hidden === true) { streamer.finalize(ev.step, ""); break; }
        if (ev.text && ev.hasToolCalls) {
          const repeat = ev.text === lastAgentText;
          const settled = streamer.finalize(ev.step, ev.text);
          if (settled) lastAgentBubble = settled;
          else if (!repeat) lastAgentBubble = appendBubble(c, "agent", ev.text);
          lastAgentText = ev.text;
        }
        break;
      case "done":
        terminal.onPortDone(ev.aborted === true);
        // The agent view has no other live source for the conclusion — the
        // streamed bubble takes the final text on a NON-aborted settle (an
        // aborted run reports no successful answer), else it is appended. A
        // final text that only adds the honesty correction updates the bubble
        // already rendered rather than repeating the answer.
        if (ev.aborted === true) streamer.finalize(null, undefined);
        else if (ev.text) {
          const settled = streamer.finalize(null, ev.text);
          if (settled) lastAgentBubble = settled;
          else if (lastAgentBubble?.isConnected && isClaimCorrectionOf(ev.text, lastAgentText)) lastAgentBubble.setAttribute("content", ev.text);
          else if (ev.text !== lastAgentText) lastAgentBubble = appendBubble(c, "agent", ev.text);
          lastAgentText = ev.text;
        }
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
    case "search_tools": case "list_tools": return "choosing a tool";
    case "execute_tool": return "running a tool";
    case "create_named_agent": return name ? `creating agent ${name}` : "creating an agent";
    case "update_named_agent": return name ? `updating agent ${name}` : "updating an agent";
    case "delete_named_agent": return name ? `deleting agent ${name}` : "deleting an agent";
    case "list_named_agents": return "listing agents";
    case "schedule_task": return "scheduling a task";
    case "create_agent": return "creating an agent";
    case "list_agents": return "listing agents";
    case "open_tab": case "navigate": return name ? `opening ${name}` : "opening a page";
    case "memory_set": return "writing memory";
    case "memory_get": return "reading memory";
    case "memory_grep": return "searching memory";
    case "list_tabs": return "reading your tabs";
    case "read_page": return name ? `reading ${name}` : "reading the page";
    case "capture_screenshot": return "taking a screenshot";
    case "search_tools": return "choosing a tool";
    case "execute_tool": return "running a tool";
    case "update_asset": return name ? `updating ${name}` : "updating an artifact";
    case "get_asset": return "reading an artifact";
    case "list_assets": return "listing artifacts";
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

/** Normalize a tool result's STRUCTURED permission/grant denial (owner P0
 * CAP-FB-20260826-PERMISSIONS-SIMPLIFY-01). Tools deny with
 * { error, waitingForPermission:true, permissionRequirement:{ reason,
 * permissions[], grantOrigins[], grantGlobal } }; this validates + bounds that
 * shape into a uniform requirement the conversation renders as an IN-CONTEXT
 * owner approval card. A malformed/unbounded requirement is ignored (fail
 * closed to the plain error text, never an approval card for a forged shape).
 * The requirement is only ever a DESCRIPTION — approving it still takes the
 * real owner click on the card. */
const SCRIPT_DETAIL_MAX_SOURCE = 64 * 1024;
const SCRIPT_DETAIL_MAX_HOSTS = 64;
/** Bound a script-approval detail for the card; malformed → undefined. */
export function boundScriptApprovalDetail(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
  if (typeof detail.source !== "string") return undefined;
  const hosts = Array.isArray(detail.hosts)
    ? detail.hosts.filter((h) => typeof h === "string" && h.length > 0 && h.length <= 253).slice(0, SCRIPT_DETAIL_MAX_HOSTS)
    : [];
  return { source: detail.source.slice(0, SCRIPT_DETAIL_MAX_SOURCE), hosts, dynamic: detail.dynamic === true };
}

export function normalizePermissionRequirement(result) {
  if (result?.waitingForPermission !== true) return null;
  const req = result?.permissionRequirement;
  if (!req || typeof req !== "object" || Array.isArray(req)) return null;
  const cleanStrings = (value, max) =>
    (Array.isArray(value) ? value : [])
      .filter((item) => typeof item === "string" && item.length > 0 && item.length <= 240)
      .slice(0, max);
  const permissions = [...new Set(cleanStrings(req.permissions, 8))];
  const grantOrigins = [...new Set(cleanStrings(req.grantOrigins, 50))]
    .filter((origin) => /^https?:\/\//.test(origin));
  const grantGlobal = req.grantGlobal === true;
  // Owner-approval card requirements (schedule mutations et al.): a bounded
  // list of pending-approval ids the owner's Allow resolves — a DESCRIPTION
  // only; the real decision is the owner's card click (P1-3). A malformed
  // entry fails the whole requirement closed (never a card for a forged
  // shape).
  const approvals = Array.isArray(req.approvals)
    ? req.approvals
      .filter((a) => a && typeof a === "object" && !Array.isArray(a)
        && typeof a.approvalId === "string" && a.approvalId.length > 0 && a.approvalId.length <= 160
        && typeof a.action === "string" && a.action.length > 0 && a.action.length <= 80
        && (a.targetRef === undefined || (typeof a.targetRef === "string" && a.targetRef.length <= 200)))
      .slice(0, 4)
      .map((a) => ({
        approvalId: a.approvalId,
        action: a.action,
        ...(a.targetRef === undefined ? {} : { targetRef: a.targetRef }),
        // A script approval carries the bounded source + fetch hosts the
        // owner must see (CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01).
        ...(boundScriptApprovalDetail(a.detail) ? { detail: boundScriptApprovalDetail(a.detail) } : {}),
      }))
    : [];
  if (Array.isArray(req.approvals) && req.approvals.length > 0 && approvals.length === 0) return null;
  if (!permissions.length && !grantOrigins.length && !grantGlobal && !approvals.length) return null;
  const reason = typeof req.reason === "string" && req.reason.trim()
    ? req.reason.trim().slice(0, 240)
    : "perform this action";
  return {
    reason,
    permissions,
    grantOrigins,
    grantGlobal,
    approvals,
    key: approvals.length
      ? "approvals|" + approvals.map((a) => a.approvalId).sort().join(",")
      : [...permissions].sort().join(",") + "|" + (grantGlobal ? "<global>" : [...grantOrigins].sort().join(",")),
  };
}

/** The card title for an approvable action — plain words for the script
 * actions the owner must read carefully, the action id otherwise. */
export function approvalCardTitle(action) {
  switch (action) {
    case "script.create": return "Save this script the agent wrote?";
    case "script.run": return "Run this script now?";
    case "task.schedule-script": return "Run this script on a schedule?";
    default: return `Approve ${action}?`;
  }
}

/** Resolve each pending owner-approval by id through the service worker's
 * authority (the resolver enforces run-bound-only for extension principals).
 * Shared by the approve path (inside approvePermissionRequirement) and the
 * inline-approval deny path. Returns an honest outcome; every failure is
 * surfaced, never swallowed. */
export async function resolveApprovalRequirement(requirement, approve, { sendFn = send } = {}) {
  const out = { ok: true, errors: [] };
  for (const approval of requirement?.approvals ?? []) {
    const res = await sendFn("management.resolve-approval", {
      approvalId: approval.approvalId,
      approve: approve === true,
    }).catch((e) => ({ error: String(e?.message ?? e) }));
    if (res?.ok !== true) {
      out.ok = false;
      out.errors.push(res?.error ?? `approval ${approval.approvalId} could not be resolved`);
    }
  }
  return out;
}

/** Execute an approved permission requirement FROM THE OWNER'S CLICK
 * (OPTIONAL + JIT model, owner directive 2026-08-29): the owner's card click
 * IS the user gesture — the page calls chrome.permissions.request for the
 * exact permissions the requirement names, THEN applies the browser-control
 * policy grant through the service worker (the single grant authority). Scope
 * is exactly what the tool computed: grantOrigins set an origin-scoped grant;
 * grantGlobal (only when the tool's own semantics already required the global
 * grant) sets the global grant; nothing is silently broadened. If storage is
 * among the requested permissions the grant persists; otherwise it is
 * reported session-only. Returns an honest outcome; every failure is
 * surfaced, never swallowed. */
export async function approvePermissionRequirement(requirement, {
  sendFn = send,
  requestPermissions = async (permissions) => {
    try { return (await chrome.permissions.request({ permissions })) === true; }
    catch { return false; }
  },
} = {}) {
  const out = { ok: true, permissionsGranted: true, grantSet: false, storagePersisted: null, errors: [] };
  // Owner-approval card requirements (P1-3): resolve each pending approval by
  // id through the service worker's authority. The resolver surface enforces
  // run-bound-only for extension principals — this call carries the owner's
  // card-click authority, nothing else.
  if (requirement?.approvals?.length) {
    const resolved = await resolveApprovalRequirement(requirement, true, { sendFn });
    out.ok = resolved.ok;
    out.errors.push(...resolved.errors);
    return out;
  }
  if (requirement?.permissions?.length) {
    try {
      out.permissionsGranted = (await requestPermissions([...requirement.permissions])) === true;
    } catch (e) {
      out.permissionsGranted = false;
      out.errors.push(String(e?.message ?? e));
    }
    if (!out.permissionsGranted) {
      out.ok = false;
      if (!out.errors.length) out.errors.push("the owner did not grant the permission");
      return out;
    }
  }
  if (requirement?.grantGlobal === true || requirement?.grantOrigins?.length) {
    // Verify the storage install-grant first — without it the grant would be
    // session-only and the retry would deny again after a worker restart. A
    // failed verify is reported, not hidden.
    try {
      out.storagePersisted = requirement.permissions.includes("storage")
        ? true // granted in the JIT request above
        : (await chrome.permissions.contains({ permissions: ["storage"] })) === true;
    } catch {
      out.storagePersisted = null;
    }
    const body = requirement.grantGlobal === true
      ? { granted: true }
      : { granted: true, origins: [...requirement.grantOrigins] };
    const res = await sendFn("browser-control.set", body).catch((e) => ({ error: String(e?.message ?? e) }));
    if (res?.grant && typeof res.grant === "object" && typeof res.grant.id === "string") {
      out.grantSet = true;
    } else {
      out.ok = false;
      out.errors.push(res?.error ?? "the browser-control grant was not set");
    }
  }
  return out;
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
      // Replay parity with the live card (the tool-call clarity fix): the
      // journaled lazy-protocol envelope is unwrapped so history shows the
      // tool that ACTUALLY ran — the persisted selectedTool (recorded from
      // this fix onward) wins, then the result-envelope unwrap.
      tool: (() => {
        const rawTool = call?.tool ?? result?.tool ?? "tool";
        if (typeof result?.selectedTool === "string" && result.selectedTool) return result.selectedTool;
        const eff = effectiveToolCall(rawTool, call?.args ?? null, result?.result ?? null);
        return eff.lazy && eff.name !== rawTool ? eff.name : rawTool;
      })(),
      status,
      // the ORIGINAL immutable callId (the composite ${run}::${callId} stays
      // the INTERNAL pairing key only — persisting it would re-prefix on every
      // reload)
      callId: call?.callId ?? result?.callId ?? id,
      args: (() => {
        const rawArgs = call?.args ?? result?.args ?? null;
        const rawTool = call?.tool ?? result?.tool ?? "tool";
        const eff = effectiveToolCall(rawTool, rawArgs, result?.result ?? null);
        if (!eff.lazy || eff.args == null) return rawArgs;
        // The unwrapped inner arguments (selectionRef plumbing never shown).
        try { return typeof eff.args === "string" ? eff.args : safeJsonStringify(eff.args); } catch { return rawArgs; }
      })(),
      result: result?.result ?? null,
      ok: result?.ok ?? null,
      // The structured denial persisted on the result row (§2b), when any.
      permissionRequirement: result?.permissionRequirement ?? null,
      permissionDecision: result?.permissionDecision ?? null,
      ts,
      duplicate: byCall.get(id)?.duplicate === true,
    });
  }
  return out;
}

/** Derive the thread-VIEW tool rows for one execution from its durable run log
 * (CAP log redesign: the per-execution durable log is the SINGLE authoritative
 * event log; the thread renders as a view over it instead of relying on a
 * separately replayed copy that could silently drop rows).
 *
 * Input: the executionId + its durable run-log rows (run-log:<id>:* entries —
 * { type:"tool-call"|"tool-result", callId, tool, args|result, ok, at }).
 * Output: rows in the thread-body tool shape (role:"tool", toolName, …) so
 * the EXISTING projectThreadMessages pairing renders them unchanged. Pure. */
/** ARTIFACT-PRODUCING TOOLS (CAP-FB-20260828-ARTIFACTS-IN-THREAD-01).
 *
 * An artifact is the OUTPUT of the work, so it belongs in the thread that
 * produced it as well as in the library. Before this, a run that made something
 * rendered as `create_asset · done · 12ms` and the thing itself was invisible in
 * the conversation — for a non-HTML artifact there was no trace of it at all.
 *
 * PURE, and deliberately the single source for both paths: the live event
 * stream and the durable-log replay both derive the card from the same tool
 * RESULT, so an artifact cannot appear while a run is streaming and then vanish
 * when the thread is reopened.
 *
 * Returns null for anything that is not an artifact-producing result, so it is
 * safe to call on every tool result. */
const ARTIFACT_TOOLS = new Set(["create_asset", "update_asset", "generate_ui"]);

/** THE LAZY PROTOCOL ENVELOPE (CAP-FB-20260828-TOOL-RESULT-ENVELOPE-01).
 *
 * Every provider run now receives exactly two definitions, `search_tools` and
 * `execute_tool`, so in a real run the tool NAME the UI sees is `execute_tool`
 * and the tool actually invoked is named inside the payload. The transcript was
 * showing the envelope rather than the work: a card headed `execute_tool` whose
 * arguments were `{selectionRef, arguments:{…}}` and whose result was
 * `{modelContent:"{\"selectedTool\":\"create_asset\",…}"}`.
 *
 * These two unwrap it so every consumer — the card header, the summary, the
 * artifact derivation — works on the tool that actually ran. Pure, and
 * tolerant: anything that is not an envelope passes straight through, so the
 * direct (non-lazy) dispatch path is unaffected. */
export function unwrapLazyEnvelope(value) {
  let v = value;
  for (let hop = 0; hop < 4; hop++) { // bounded: envelopes nest at most 2 deep
    if (typeof v === "string") {
      const t = v.trim();
      if (!t.startsWith("{") && !t.startsWith("[")) return v;
      try { v = JSON.parse(t); } catch { return v; }
      continue;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    // agent-do's {modelContent,userSummary} wrapper.
    if (v.userSummary != null) { v = v.userSummary; continue; }
    if (v.modelContent != null) { v = v.modelContent; continue; }
    return v;
  }
  return v;
}

/** The tool that actually ran, and the arguments it actually received. */
export function effectiveToolCall(toolName, args, result) {
  const name = String(toolName ?? "");
  if (name !== "execute_tool" && name !== "search_tools") {
    return { name, args, lazy: false };
  }
  const outer = unwrapLazyEnvelope(result);
  const selected = outer && typeof outer === "object" && typeof outer.selectedTool === "string"
    ? outer.selectedTool
    : null;
  const rawArgs = unwrapLazyEnvelope(args);
  // `execute_tool`'s own arguments carry the invoked tool's arguments nested
  // under `arguments`, alongside a selectionRef that means nothing to a reader.
  const inner = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) &&
      rawArgs.arguments !== undefined
    ? rawArgs.arguments
    : rawArgs;
  return { name: selected ?? name, args: inner, lazy: true };
}

/** THE PROTOCOL CALLS (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 §9).
 * `search_tools` / `list_tools` are how the model finds a tool, not work the
 * owner asked for. They stay in the durable run log (the debugger surface) and
 * are never rendered as transcript cards. */
export const PROTOCOL_TOOLS = new Set(["search_tools", "list_tools"]);
export function isProtocolTool(name) { return PROTOCOL_TOOLS.has(String(name ?? "")); }

/** The selected tool's OWN result from a lazy `execute_tool` envelope
 * ({ok, selectedTool, result|error, schemaSummary, selectionRef, …}), or
 * undefined when the value is not a lazy envelope — so the caller renders the
 * tool's answer (or its own error) and never the transport around it. */
export function lazyInnerResult(result) {
  const outer = unwrapLazyEnvelope(result);
  if (outer && typeof outer === "object" && !Array.isArray(outer) && typeof outer.selectedTool === "string" && outer.selectedTool) {
    if (outer.result !== undefined) return unwrapLazyEnvelope(outer.result);
    if (typeof outer.error === "string") return { ok: false, error: outer.error };
  }
  return undefined;
}

/** The permission requirement a persisted tool result carries, if it is a
 * structured denial (`waitingForPermission` + `permissionRequirement`) — at
 * the tool's own layer or the envelope's. Only PERMISSION/GRANT requirements
 * are replayable (they can be granted at any time); run-bound action
 * approvals (script.run et al.) are not, so they yield null here. */
export function approvalRequirementFromToolResult(result) {
  const inner = lazyInnerResult(result);
  const req = normalizePermissionRequirement(inner) ?? normalizePermissionRequirement(unwrapLazyEnvelope(result));
  if (!req || req.approvals.length) return null;
  return req;
}

export function artifactFromToolResult(toolName, result) {
  const outer = unwrapLazyEnvelope(result);
  // Under the lazy protocol the invoked tool is named in the payload, not in
  // the card header — keying on the header alone meant this never fired in a
  // real run, only in the direct-dispatch tests.
  const selected = outer && typeof outer === "object" && typeof outer.selectedTool === "string"
    ? outer.selectedTool
    : null;
  const effective = selected ?? String(toolName ?? "");
  if (!ARTIFACT_TOOLS.has(effective)) return null;
  if (outer && typeof outer === "object" && outer.ok === false) return null;
  // The invoked tool's own result sits under `result` in the envelope.
  let parsed = outer && typeof outer === "object" && outer.result !== undefined
    ? unwrapLazyEnvelope(outer.result)
    : outer;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.ok === false) return null; // a failed create made nothing
  const asset = parsed.asset && typeof parsed.asset === "object" ? parsed.asset : null;
  const id = typeof asset?.id === "string" && asset.id
    ? asset.id
    : (typeof parsed.id === "string" && parsed.id ? parsed.id : null);
  if (!id) return null;
  return {
    id,
    name: typeof asset?.name === "string" && asset.name ? asset.name : "Untitled",
    type: typeof asset?.type === "string" && asset.type ? asset.type : "data",
    origin: typeof asset?.origin === "string" && asset.origin ? asset.origin : "master",
    size: Number.isFinite(asset?.size) ? asset.size : 0,
  };
}

export function toolRowsFromRunLog(executionId, logs) {
  const rows = (Array.isArray(logs) ? logs : [])
    .filter((r) => r && (r.type === "tool-call" || r.type === "tool-result"))
    .map((r) => ({
      type: r.type,
      id: r.id ?? null,
      executionId,
      run: r.run ?? null,
      callId: r.callId ?? null,
      tool: r.tool ?? "tool",
      args: r.args ?? null,
      result: r.result ?? null,
      ok: r.ok ?? null,
      // The tool that ACTUALLY ran (the SW persists it on the result row) —
      // pairToolJournal prefers it over the envelope unwrap, and without this
      // mapping the replay could never recover it from a summarized result.
      selectedTool: typeof r.selectedTool === "string" && r.selectedTool ? r.selectedTool : null,
      permissionRequirement: r.permissionRequirement && typeof r.permissionRequirement === "object" ? r.permissionRequirement : null,
      permissionDecision: typeof r.permissionDecision === "string" ? r.permissionDecision : null,
      ts: typeof r.at === "number" ? r.at : null,
    }));
  const seenApprovals = new Set();
  return pairToolJournal(rows).flatMap((p) => {
    // Show the tool that RAN, not the lazy protocol's envelope.
    const eff = effectiveToolCall(p.tool, p.args, p.result);
    const toolRow = {
      role: "tool",
      toolName: eff.name,
      toolStatus: p.status === "success" ? "done" : p.status === "error" ? "error" : "done",
      toolArgs: eff.args ?? null,
      toolResult: p.result ?? null,
      toolOk: p.ok ?? null,
      toolDuration: p.durationMs ?? null,
      toolCallId: p.callId ?? null,
      executionId,
      ts: p.ts ?? null,
      derived: true, // a VIEW row — not persisted in the thread body
      // Protocol plumbing stays in the log; the renderer skips the card (§9).
      ...(isProtocolTool(eff.name) ? { protocol: true } : {}),
    };
    const out = [toolRow];
    // A PERSISTED permission denial reopens as the same in-context grant card
    // the live run showed (§2b) — one per distinct requirement — so the owner
    // can grant from the transcript instead of reading the denial as prose.
    // The requirement lives on the row itself when the run paused on it (the
    // model-facing result was rewritten to prose); the envelope is the
    // fallback for a tool that denied without pausing.
    const requirement = (p.permissionRequirement
      ? normalizePermissionRequirement({ waitingForPermission: true, permissionRequirement: p.permissionRequirement })
      : null) ?? approvalRequirementFromToolResult(p.result);
    if (requirement && !requirement.approvals.length && !seenApprovals.has(requirement.key)) {
      seenApprovals.add(requirement.key);
      // The owner's recorded decision is the card's state — approved reopens
      // granted, declined stays declined (deny is sticky: a re-projection must
      // never resurrect a pending Allow the owner already answered), expired
      // says so. Only a denial that never paused the run (no decision on the
      // row) reopens grantable.
      const decision = p.permissionDecision;
      const replayState = decision === "approved"
        ? { state: "granted", detail: "Approved during the run." }
        : decision === "denied"
          ? { state: "denied" }
          : decision === "expired"
            ? { state: "expired", detail: "The request expired. The action was not performed." }
            : {};
      out.push({
        role: "approval",
        requirement,
        toolCallId: p.callId ?? null,
        executionId,
        ts: p.ts ?? null,
        derived: true,
        ...replayState,
      });
    }
    // The artifact this call produced renders straight after it, so reopening
    // a thread shows the deliverable in the context that created it.
    const artifact = p.status === "error" ? null : artifactFromToolResult(p.tool, p.result);
    if (artifact) {
      out.push({
        role: "artifact",
        artifact,
        toolCallId: p.callId ?? null,
        executionId,
        ts: p.ts ?? null,
        derived: true,
      });
    }
    return out;
  });
}

/** The derived marker for a run whose log was compacted to its summary row. */
function compactedMarker(executionId, logs) {
  const row = (Array.isArray(logs) ? logs : []).find((r) => r && r.type === "compacted");
  if (!row) return null;
  const dropped = Number.isFinite(row.rowsDropped) ? row.rowsDropped : 0;
  const status = row.status === "ok" ? "completed" : row.status === "cancelled" ? "was cancelled" : "failed";
  return {
    role: "system",
    content: `Run log compacted: this run ${status}; ${dropped} log ${dropped === 1 ? "row" : "rows"} of tool detail were folded into its summary to bound storage (Settings → Data & memory).`,
    ts: typeof row.compactedAt === "number" ? row.compactedAt : (typeof row.at === "number" ? row.at : Date.now()),
    derived: true,
    compacted: true,
    executionId,
  };
}

/** Merge a thread's persisted turn markers (user/terminal rows — the small
 * authoritative state the thread body still owns) with the tool rows derived
 * from the per-execution durable run logs.
 *
 * Placement rule (deterministic): an execution's derived cards render
 * immediately BEFORE its persisted terminal marker (they share executionId);
 * an execution with no terminal marker (crash/interruption) renders its cards
 * at the END followed by an honest read-only system marker describing the
 * run's durable phase. Executions whose tool rows are already persisted in the
 * body (legacy pre-redesign replay) are NOT duplicated.
 *
 * Returns { messages, missingTerminals } — missingTerminals lists executions
 * in a terminal phase whose terminal marker is absent from the body, so the
 * caller can RECONCILE (back-fill) the terminal into the thread body.
 * Pure — unit-tested in Deno. */
export function projectThreadWithRunLogs(thread, executions = []) {
  const body = Array.isArray(thread?.messages) ? thread.messages : [];
  const execs = (Array.isArray(executions) ? executions : []).filter((e) => e && e.executionId);
  if (!execs.length) return { messages: body.slice(), missingTerminals: [] };

  // Which executions already have body-persisted tool rows (legacy replay) or
  // a persisted terminal marker? Legacy rows written before executionId was
  // persisted on tool rows are matched by their pairing callId instead.
  const bodyToolExecs = new Set();
  const bodyToolCallIds = new Set();
  const terminalExecs = new Set();
  for (const m of body) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "tool") {
      if (m.executionId) bodyToolExecs.add(m.executionId);
      if (m.toolCallId) bodyToolCallIds.add(m.toolCallId);
    }
    // An interim (per-step) assistant row carries a step index; only the
    // step-less assistant/error row is the execution's terminal marker.
    if ((m.role === "assistant" || m.role === "error") && m.executionId && !Number.isInteger(m.step)) terminalExecs.add(m.executionId);
  }

  const cardsByExec = new Map();
  const missingTerminals = [];
  for (const e of execs) {
    if (!bodyToolExecs.has(e.executionId)) {
      // Skip cards the legacy body already carries (callId match) — never
      // render the same call twice.
      const cards = toolRowsFromRunLog(e.executionId, e.logs)
        .filter((card) => !card.toolCallId || !bodyToolCallIds.has(card.toolCallId));
      // A COMPACTED log (CAP-FB-20260830-RUN-LOG-COMPACTION-01) is one honest
      // summary row in place of the run's tool detail: render it as a
      // read-only marker where the cards would have been, so the thread says
      // what happened to them instead of silently showing nothing.
      const compacted = compactedMarker(e.executionId, e.logs);
      cardsByExec.set(e.executionId, compacted ? [compacted, ...cards] : cards);
    }
    const terminalPhase = e.phase === "terminal" || e.phase === "cancelled";
    if (terminalPhase && e.terminal && !terminalExecs.has(e.executionId)) {
      missingTerminals.push({
        executionId: e.executionId,
        terminal: e.terminal,
      });
    }
  }

  // Walk the body; before each execution's FIRST text row (an interim
  // per-step row or the terminal marker), splice its execution's cards.
  const out = [];
  const placed = new Set();
  for (const m of body) {
    const execId = m?.executionId;
    if (
      execId && (m?.role === "assistant" || m?.role === "error") &&
      cardsByExec.has(execId) && !placed.has(execId)
    ) {
      out.push(...cardsByExec.get(execId));
      placed.add(execId);
    }
    out.push(m);
  }
  // Executions without a persisted terminal marker (running / interrupted /
  // paused): cards + an honest phase marker, chronological, at the end.
  for (const e of execs) {
    if (placed.has(e.executionId) || bodyToolExecs.has(e.executionId)) continue;
    const cards = cardsByExec.get(e.executionId) ?? [];
    out.push(...cards);
    placed.add(e.executionId);
    if (e.phase && e.phase !== "terminal" && e.phase !== "cancelled") {
      const paused = String(e.phase).startsWith("paused");
      out.push({
        role: "system",
        content: paused
          ? (e.pause?.requiresOwnerDecision
            ? "Run paused: the outcome of a side effect is uncertain — it needs the owner's decision in the runs panel."
            : "Run interrupted (the worker ended) — it resumes automatically.")
          : "Run in progress…",
        ts: Date.now(),
        derived: true,
        executionId: e.executionId,
      });
    }
  }
  return { messages: out, missingTerminals };
}

/** The REOPEN projection for a persisted task thread (CAP-FB-20260824-THREAD-REOPEN-RENDER-01,
 * with pre-0.2.237 load-time repair): the pure transform behind ntp.js's
 * renderThreadProjection. EVERY persisted non-tool row (user + assistant +
 * error + system) is kept with its role/content/ts, and tool rows replay as
 * ONE terminal card per call via pairToolJournal.
 *
 * Load-time ordering repair: in pre-0.2.237 stored threads, an execution's
 * post-run tool rows could be appended after its terminal assistant/error row.
 * This projection groups turns and places tool cards BEFORE their turn's
 * terminal row, so the terminal renders LAST. Applying this to an already-
 * correct (post-fix) thread is IDEMPOTENT. Pure — unit-tested against the
 * real <agent-conversation> setMessages. */
export function projectThreadMessages(thread) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  if (!messages.length) return [];

  // Pair raw tool rows into unified tool cards (one card per callId). The
  // protocol's own calls (search_tools/list_tools) are dropped here — they
  // are plumbing, never a card (§9); the durable run log still lists them.
  const rawTools = messages.filter((m) => m && m.role === "tool" && m.protocol !== true && !isProtocolTool(m.toolName));
  const pairedTools = pairToolJournal(
    rawTools.map((m) => ({
      type: m.toolStatus === "running" ? "tool-call" : "tool-result",
      callId: m.toolCallId ?? null,
      run: null,
      tool: m.toolName ?? "tool",
      selectedTool: m.selectedTool ?? null,
      args: m.toolArgs ?? null,
      result: m.toolResult ?? null,
      ok: m.toolOk ?? null,
      ts: typeof m.ts === "number" ? m.ts : null,
      executionId: m.executionId ?? null,
    })),
  );

  const toolCards = pairedTools.map((t) => {
    const orig = rawTools.find((m) =>
      (t.callId && m.toolCallId === t.callId) ||
      (m.toolName === t.tool && (m.toolResult === t.result || m.toolArgs === t.args))
    );
    return {
      role: "tool",
      name: t.tool,
      status: t.status,
      args: t.args ?? null,
      result: t.result ?? null,
      ts: t.ts ?? null,
      executionId: t.executionId ?? orig?.executionId ?? null,
      callId: t.callId,
    };
  });

  const emittedTools = new Set();
  const seenApprovalKeys = new Set();
  const turns = [];
  let currentTurn = { user: null, systems: [], tools: [], approvals: [], terminals: [], execId: null };

  const flushTurn = () => {
    if (currentTurn.user || currentTurn.systems.length || currentTurn.tools.length || currentTurn.approvals.length || currentTurn.terminals.length) {
      turns.push(currentTurn);
    }
    currentTurn = { user: null, systems: [], tools: [], approvals: [], terminals: [], execId: null };
  };

  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;

    if (role === "user") {
      if (currentTurn.user || currentTurn.terminals.length || currentTurn.tools.length) {
        flushTurn();
      }
      currentTurn.user = {
        role: "user",
        content: m.content,
        ts: m.ts ?? null,
        attachments: Array.isArray(m.attachments) ? m.attachments : (m.attachments ? [m.attachments] : null),
        executionId: m.executionId ?? null,
      };
      if (m.executionId) currentTurn.execId = m.executionId;
    } else if (role === "system" || role === "thinking") {
      currentTurn.systems.push({
        role,
        content: m.content,
        ts: m.ts ?? null,
      });
    } else if (role === "assistant" || role === "error" || role === "agent") {
      if (currentTurn.terminals.length && m.executionId && currentTurn.execId && m.executionId !== currentTurn.execId) {
        flushTurn();
      }
      currentTurn.terminals.push({
        role,
        content: m.content,
        ts: m.ts ?? null,
        reason: m.reason ?? null,
        action: m.action ?? null,
        executionId: m.executionId ?? null,
      });
      if (m.executionId && !currentTurn.execId) currentTurn.execId = m.executionId;
    } else if (role === "approval") {
      // The derived grant card for a persisted denial (§2b): one per distinct
      // requirement across the thread, rendered with its turn's tool cards.
      const req = m.requirement;
      const key = typeof req?.key === "string" && req.key ? req.key : null;
      if (req && typeof req === "object" && (!key || !seenApprovalKeys.has(key))) {
        if (key) seenApprovalKeys.add(key);
        currentTurn.approvals.push({
          role: "approval",
          requirement: req,
          executionId: m.executionId ?? null,
          toolCallId: m.toolCallId ?? null,
          ts: m.ts ?? null,
          ...(typeof m.state === "string" && m.state ? { state: m.state } : {}),
          ...(typeof m.detail === "string" && m.detail ? { detail: m.detail } : {}),
        });
        if (m.executionId && !currentTurn.execId) currentTurn.execId = m.executionId;
      }
    } else if (role === "tool") {
      if (m.protocol === true || isProtocolTool(m.toolName)) continue;
      const callId = m.toolCallId;
      const idx = toolCards.findIndex((tc, i) =>
        !emittedTools.has(i) && (
          (callId && tc.callId === callId) ||
          (m.executionId && tc.executionId === m.executionId && tc.name === m.toolName) ||
          (tc.name === m.toolName)
        )
      );
      if (idx >= 0 && !emittedTools.has(idx)) {
        currentTurn.tools.push(toolCards[idx]);
        emittedTools.add(idx);
        if (toolCards[idx].executionId && !currentTurn.execId) {
          currentTurn.execId = toolCards[idx].executionId;
        }
      }
    }
  }
  flushTurn();

  for (let i = 0; i < toolCards.length; i++) {
    if (emittedTools.has(i)) continue;
    const tc = toolCards[i];
    if (tc.executionId) {
      const matchTurn = turns.find((t) => t.execId === tc.executionId);
      if (matchTurn) {
        matchTurn.tools.push(tc);
        emittedTools.add(i);
      }
    }
  }

  const remainingTools = [];
  for (let i = 0; i < toolCards.length; i++) {
    if (!emittedTools.has(i)) {
      remainingTools.push(toolCards[i]);
      emittedTools.add(i);
    }
  }

  const output = [];
  for (const turn of turns) {
    if (turn.systems.length) output.push(...turn.systems);
    if (turn.user) output.push(turn.user);
    if (turn.tools.length) {
      turn.tools.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      output.push(...turn.tools);
    }
    if (turn.approvals.length) {
      turn.approvals.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      output.push(...turn.approvals);
    }
    if (turn.terminals.length) {
      turn.terminals.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      output.push(...turn.terminals);
    }
  }

  if (remainingTools.length) {
    remainingTools.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    output.push(...remainingTools);
  }

  return output;
}

export async function runConversationTurn(container, { text, attachments = [], history = [], threadId = null, onStatus = null, agentId = null, agentKind = null, isStale = null, projectionOwner = null, mention = null, onRunRegistered = null }) {
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
    // A preflight refusal is TERMINAL for this turn, not a pause: nothing will
    // resume it, so it must read as a failed run with the Settings recovery
    // action — never sit in "Waiting for permission" (CAP-FB-20260830-
    // PROVIDER-ERROR-TRUTH-01). An invalid/missing endpoint is a provider
    // configuration problem, not a host-permission one.
    const detail = String(e?.message ?? e ?? "unknown");
    const configProblem = /origin is invalid/i.test(detail);
    const err = {
      ok: false,
      failed: true,
      error: configProblem
        ? "the provider endpoint is not configured — the run did not start"
        : `provider permission preflight failed closed: ${detail}`,
      errorCategory: configProblem ? "provider-config" : "host-permission",
      errorReason: configProblem
        ? "the configured provider has no valid https:// endpoint"
        : detail,
      errorAction: configProblem
        ? "Set the provider endpoint in Settings → Providers (choose a preset or enter a valid base URL), then run the task again."
        : "grant the exact provider origin in Settings, then run this task again",
    };
    if (stale()) return { ok: false, superseded: true, error: "the surface was replaced before the run started" };
    status({ state: "failed", message: err.errorReason, errorReason: err.errorReason, errorAction: err.errorAction, errorCategory: err.errorCategory });
    if (typeof c.appendError === "function") c.appendError(err.error, { reason: err.errorReason, action: err.errorAction, category: err.errorCategory });
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

  // ── in-context permission approval (owner P0 CAP-FB-20260826-
  // PERMISSIONS-SIMPLIFY-01) ───────────────────────────────────────────────
  // A tool's STRUCTURED denial (waitingForPermission + permissionRequirement)
  // renders as an approval card right in the conversation instead of a
  // dead-end "go to Settings" error. Allow is a genuine owner click: it runs
  // the exact Chrome permission request + sets the exactly-scoped browser-
  // control grant, then retries the turn once so the task proceeds. Deny
  // dismisses; nothing is granted. One card per distinct requirement.
  const pendingApprovals = new Map(); // key -> { requirement, status, card, blocking }
  const approvalById = new Map();
  let approvalRetryRequested = false;
  // P1-A approval-retry binding: the approval ids the owner just resolved with
  // the Allow click. The retry turn's run start carries them so the service
  // worker's one-shot bridge re-keys the approved tuples onto the fresh
  // execution — otherwise the retried call could never consume its approval
  // (every attempt runs under a NEW executionId) and would re-request forever.
  let approvalBindingForRetry = null;
  let attemptSettled = false;
  const handleApprovalDecision = async (requirement, card, sourceEvent, approve) => {
    const entry = pendingApprovals.get(requirement.key);
    if (!entry || entry.status !== "pending") return;
    // A genuine owner gesture only: a scripted/model-forged click can never
    // resolve a pending run capability.
    const liveActivation = typeof navigator === "undefined" || !navigator.userActivation
      ? true
      : navigator.userActivation.isActive === true;
    if (sourceEvent?.isTrusted !== true || !liveActivation) return;
    entry.status = approve ? "granting" : "denying";
    const outcome = approve
      ? await approvePermissionRequirement(requirement)
      : await resolveApprovalRequirement(requirement, false);
    if (outcome.ok && entry.requestId) {
      const resolved = await send("run.resolve-inline-approval", {
        requestId: entry.requestId,
        approve: approve === true,
      }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (resolved?.ok !== true) {
        outcome.ok = false;
        outcome.errors.push(resolved?.error ?? "the paused tool request could not be resolved");
      }
    }
    if (outcome.ok) {
      entry.status = approve ? "granted" : "denied";
      card?.setAttribute("state", entry.status);
      // A blocking request remains inside the original tool invocation: the SW
      // wakes that exact promise. Legacy browser-grant denials still retry the
      // turn because those tools currently report only after returning.
      if (!entry.blocking && approve) {
        approvalRetryRequested = true;
        approvalBindingForRetry = (requirement.approvals ?? [])
          .map((a) => a.approvalId)
          .filter((id) => typeof id === "string" && id.length > 0);
        if (attemptSettled && !stale()) {
          approvalRetryRequested = false;
          Promise.resolve().then(() => executeTurn()).catch(() => {});
        }
      }
    } else {
      entry.status = "pending";
      card?.setAttribute("state", "error");
      card?.setAttribute("detail", outcome.errors.join("; ") || "the approval could not be completed");
    }
  };
  const maybeRenderApproval = (result, { blocking = false, requestId = null } = {}) => {
    const requirement = normalizePermissionRequirement(result);
    if (!requirement) return;
    const existing = pendingApprovals.get(requirement.key);
    if (existing) {
      // The SAME requirement denied AGAIN after a grant (the grant did not
      // take effect — e.g. it was set session-only and the worker restarted,
      // or a narrower scope than the tool needs) — re-open the SAME card for
      // another owner decision instead of leaving a silent dead-end. A
      // "denied" decision stays sticky (no nagging after an explicit decline).
      if (existing.status === "granted") {
        existing.status = "pending";
        existing.card?.setAttribute("state", "pending");
      }
      return;
    }
    let card = null;
    if (typeof document !== "undefined" && typeof c.append === "function") {
      const actionApproval = requirement.approvals.length > 0;
      card = document.createElement(actionApproval ? "approval-card" : "permission-approval-card");
      if (actionApproval) {
        const approval = requirement.approvals[0];
        card.setAttribute("title", approvalCardTitle(approval.action));
        card.setAttribute("body", `Action: ${approval.action}\nTarget reference: ${approval.targetRef || requirement.reason.split(": ").slice(1).join(": ")}`);
        // The script source + hosts are a PROPERTY (rendered with textContent
        // inside the card), never an attribute.
        if (approval.detail) card.detail = approval.detail;
      } else {
        card.setAttribute("reason", requirement.reason);
        if (requirement.permissions.length) card.setAttribute("permissions", JSON.stringify(requirement.permissions));
        if (requirement.grantOrigins.length) card.setAttribute("origins", JSON.stringify(requirement.grantOrigins));
        if (requirement.grantGlobal) card.setAttribute("global", "true");
      }
      card.addEventListener("approve", (ev) => handleApprovalDecision(requirement, card, ev?.detail?.sourceEvent, true));
      card.addEventListener("deny", (ev) => handleApprovalDecision(requirement, card, ev?.detail?.sourceEvent, false));
      // Insert BEFORE the connected live-status row so the row stays the
      // conversation's last child (review P1-a); plain append() would land
      // the card after it.
      if (typeof c.appendTranscript === "function") c.appendTranscript(card);
      else {
        c.append(card);
        if (typeof c.scrollTop === "number") c.scrollTop = c.scrollHeight;
      }
      // The run is paused on this decision: move keyboard focus to the card's
      // Allow button (a real <button>; the conversation's aria-live region
      // announces the card). Never steal focus from a field the owner is
      // mid-edit in (CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01).
      const active = document.activeElement;
      const midEdit = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT") &&
        typeof active.value === "string" && active.value.length > 0;
      if (!midEdit) {
        const focusAllow = () => card.shadowRoot?.querySelector?.("button")?.focus?.();
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusAllow);
        else focusAllow();
      }
    }
    const entry = { requirement, status: "pending", card, blocking, requestId };
    pendingApprovals.set(requirement.key, entry);
    for (const approval of requirement.approvals) approvalById.set(approval.approvalId, entry);
    if (requestId) approvalById.set(requestId, entry);
    status({
      state: "waiting-for-permission",
      message: `approval needed: ${requirement.reason}`,
      errorReason: `the agent needs approval to ${requirement.reason}`,
      errorAction: "use the approval card in the conversation to allow it",
      errorCategory: "permission",
    });
  };

  const executeTurn = async () => {
  // A grant-retry re-enters here after its own permission awaits — re-check.
  if (stale()) return { ok: false, superseded: true, error: "the surface was replaced before the run started" };
  const runId = newRunId();
  // The registry's terminal reconciliation keys on this exact per-attempt id
  // (projected onto the durable record as clientCorrelationId) — the caller
  // tracks it so ONLY this run's own settled record can resolve its live row.
  onRunRegistered?.(runId);
  // Consume the P1-A binding once: only the attempt started BECAUSE of the
  // owner's Allow carries the resolved approval ids (null on every other turn).
  const approvalBinding = approvalBindingForRetry;
  approvalBindingForRetry = null;
  attempt += 1;
  status({ state: attempt > 1 ? "retrying" : "running", activity: attempt > 1 ? "Retrying…" : "Thinking…" });
  // Per-call tool cards: a FIFO queue per tool NAME so parallel same-name calls
  // are matched in order and a completed card is never duplicated (the
  // wider-goal review's finding that a single `lastTool` left A's card running
  // and created a duplicate completed card when calls interleave).
  const toolCards = createToolCardQueue();
  const streamer = createStreamProjector(c);
  // The live `text` progress event already projects the assistant's final
  // words when tool calls ran; the completion handler would otherwise append
  // the IDENTICAL res.result as a second terminal bubble (the late-settled
  // duplicate-projection defect). Remember what was streamed; the completion
  // append fires only when the authoritative result differs.
  let streamedAgentText = null;
  // The bubble currently holding that text. agent-do re-emits the SAME final
  // text on each continuation step, which appended an identical bubble every
  // time (seven for one delegation — CAP-FB-20260830-CLAIM-CHECK-BROWSER-
  // TOOLS-01); and the authoritative result is that same text with the claim-
  // check correction appended, which belongs IN the bubble, not beside it.
  let streamedAgentBubble = null;
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
        // Unwrap the lazy envelope immediately (the selectionRef plumbing is
        // never shown); the header corrects to the real tool at result time.
        const callEff = effectiveToolCall(ev.toolName, ev.toolArgs, null);
        // A protocol call renders no card (§9) — a sentinel keeps the FIFO
        // pairing honest so its result never spawns an orphan card either.
        const card = isProtocolTool(ev.toolName)
          ? { protocol: true }
          : typeof c.appendTool === "function"
            ? c.appendTool({ name: callEff.name, args: callEff.args, status: "running" })
            : appendBubble(c, "tool", `→ ${ev.toolName}`);
        toolCards.push(ev.toolName, card);
        break;
      }
      case "approval-request": {
        // The tool invocation is still pending in the worker. Render the card
        // on this exact runId-filtered conversation; its decision wakes that
        // same invocation rather than launching a second run.
        maybeRenderApproval(ev.result, { blocking: true, requestId: ev.requestId ?? null });
        break;
      }
      case "approval-settled": {
        const entry = approvalById.get(String(ev.approvalId ?? ev.requestId ?? ""));
        if (entry && ["granted", "denied", "expired"].includes(ev.state)) {
          entry.status = ev.state;
          entry.card?.setAttribute("state", ev.state);
          if (ev.state === "expired") {
            entry.card?.setAttribute("detail", "The request expired after 60 seconds. The action was not performed.");
          }
        }
        break;
      }
      case "tool-result": {
        // Match the OLDEST in-flight card for this tool name (FIFO — handles
        // parallel same-name calls in order); mark it done on success, error on
        // a FAILED result (the SW tags `ok:false` — never a blanket success).
        const card = toolCards.take(ev.toolName);
        if (card?.protocol === true || (!card && isProtocolTool(ev.toolName))) break;
        // The card shows the SELECTED tool's own result — summary and raw —
        // never the lazy envelope around it (§9/§10).
        const inner = lazyInnerResult(ev.result);
        const shown = inner !== undefined ? inner : ev.result;
        const resEff = effectiveToolCall(ev.toolName, ev.toolArgs, ev.result);
        const raw = safeToolResult(shown);
        const summary = shown != null ? summarizeToolResult(resEff.name, shown) : "";
        const err = isToolErrorEvent(ev);
        const status = err ? "error" : "success";
        if (card) {
          // The result names the tool that actually ran (the lazy envelope):
          // correct the header + unwrap the arguments now the real tool is
          // known (the event's selectedTool is authoritative; the result
          // envelope's is the fallback).
          const corrected = (typeof ev.selectedTool === "string" && ev.selectedTool) ||
            (resEff.lazy && resEff.name !== ev.toolName ? resEff.name : "");
          if ((ev.toolName === "execute_tool" || ev.toolName === "search_tools") && corrected && corrected !== ev.toolName) {
            card.setAttribute?.("tool-name", corrected);
          }
          if (resEff.lazy && resEff.args != null) {
            try { card.setAttribute?.("tool-args", JSON.stringify(resEff.args)); } catch { /* keep the existing args */ }
          }
          card.setAttribute?.("tool-status", status);
          if (ev.durationMs != null) card.setAttribute?.("tool-duration", String(ev.durationMs));
          if (summary) card.setAttribute?.("tool-result", summary);
          if (raw && raw !== summary) card.setAttribute?.("tool-detail", raw);
        } else if (typeof c.appendTool === "function") {
          c.appendTool({ name: ev.toolName, status, result: summary, detail: raw !== summary ? raw : null, durationMs: ev.durationMs });
        } else {
          appendBubble(c, "tool", `✓ ${ev.toolName}${summary ? ` — ${summary}` : ""}`);
        }
        // The artifact this call produced, rendered in the thread that made it
        // (the same derivation the durable-log replay uses, so the live view
        // and the reopened view cannot disagree).
        if (!err && typeof c.appendArtifact === "function") {
          const artifact = artifactFromToolResult(ev.toolName, ev.result);
          if (artifact) c.appendArtifact({ artifact });
        }
        // The conversation remembers id → name from the UNTRUNCATED live result
        // (the card's own attributes are bounded, and the persisted summary is
        // just "done"), so an update card can be titled with the artifact's
        // name (CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01).
        if (!err && typeof c.rememberArtifact === "function") {
          const known = artifactIdentityFromPayloads([ev.result]);
          if (known) c.rememberArtifact(known.id, known.name);
        }
        // A structured permission/grant denial surfaces an IN-CONTEXT approval
        // card (one per distinct requirement) instead of only an error card.
        maybeRenderApproval(ev.result);
        break;
      }
      case "text-delta":
        // The first visible token replaces "Thinking…" in the live-status row;
        // later deltas only grow the bubble (no per-delta announcement).
        if (streamer.onDelta(ev)) status({ state: attempt > 1 ? "retrying" : "running", activity: "Writing the answer…" });
        break;
      case "text":
        if (ev.hidden === true) { streamer.finalize(ev.step, ""); break; }
        if (ev.text && (ev.hasToolCalls || streamer.active)) {
          // ONE bubble per distinct final text: a step that repeats the text
          // already rendered still settles any streaming row, but never adds a
          // duplicate.
          const repeat = ev.text === streamedAgentText;
          const settled = streamer.finalize(ev.step, ev.text);
          if (settled) streamedAgentBubble = settled;
          else if (!repeat) streamedAgentBubble = appendBubble(c, "agent", ev.text);
          streamedAgentText = ev.text;
        }
        break;
      case "done":
        // The port's done is AUTHORITATIVE (aborted → error): settles the
        // queue once; a later response is a no-op. An ABORTED run must never
        // report a successful "done" status.
        terminal.onPortDone(ev.aborted === true);
        // A bubble still streaming at settle takes the run's final text (the
        // claim-checked result) in place; an aborted run keeps what streamed.
        if (streamer.active) {
          if (ev.aborted === true) streamer.finalize(null, undefined);
          else if (ev.text) {
            streamedAgentBubble = streamer.finalize(null, ev.text) ?? streamedAgentBubble;
            streamedAgentText = ev.text;
          }
        }
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
    if (mention?.id) {
      // An @mention on a TASK (CAP-FB-20260824-TASK-AGENT-BOUNDARY-01): the
      // task stays the HUB's task — it persists to the task list as its own
      // thread — and the mention is a delegation directive the SW routes
      // deterministically to the referenced agent (its own sandbox), whose
      // result is committed back into THIS task thread. This is NOT the
      // agent-chat surface (which still routes directly via agentId/agentKind).
      if (mention.kind === "site" && attachments.length && typeof c.appendSystem === "function") {
        c.appendSystem("Attachments aren't delivered to Site Agents yet — the text was sent.");
      }
      res = await send("agent.run", {
        approvalBinding: approvalBinding ?? null,
        task: text,
        id: String(Date.now()),
        runId,
        attachments,
        history,
        threadId,
        mention: { kind: mention.kind ?? null, id: mention.id, name: mention.name ?? mention.id },
      });
    } else if (agentKind === "site") {
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
        approvalBinding: approvalBinding ?? null,
        id: agentId,
        task: text,
        runId,
        attachments,
      });
    } else if (agentId) {
      res = await send("named-agent.run", {
        approvalBinding: approvalBinding ?? null,
        id: agentId,
        task: text,
        runId,
        attachments,
      });
    } else {
      res = await send("agent.run", {
        approvalBinding: approvalBinding ?? null,
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
      // The authoritative result is often the rendered text with the honesty
      // correction appended (extension/lib/mutation-claim-check.js). That is
      // the SAME turn's reply — correct the bubble in place instead of
      // painting the answer twice.
      if (streamedAgentBubble?.isConnected && isClaimCorrectionOf(res.result, streamedAgentText)) {
        streamedAgentBubble.setAttribute("content", res.result);
        streamedAgentText = res.result;
      } else {
        streamedAgentBubble = appendBubble(c, "agent", res.result);
        streamedAgentText = res.result;
      }
    }
    // Provider-server grounding (Gemini google_search): the run response
    // carries the render-only citation rows (the reopened thread renders the
    // same rows from the persisted terminal message).
    if ((res.serverToolEvents || res.citations) && typeof c.appendServerToolRows === "function") {
      c.appendServerToolRows(res);
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
  // An approval granted DURING this attempt makes one owner-initiated retry:
  // the capability the agent just asked for is now in place, so the same task
  // runs again and can actually proceed (the owner's Allow IS the initiation —
  // this page still never loops or auto-retries on its own).
  attemptSettled = true;
  if (approvalRetryRequested && !stale()) {
    approvalRetryRequested = false;
    attemptSettled = false;
    return await executeTurn();
  }
  return res;
  };

  // 6. Run this turn once. Permission failures require a new owner-initiated
  // attempt after Settings changes; this page never loops or auto-retries.
  return await executeTurn();
}
