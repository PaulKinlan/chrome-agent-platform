// shared/conversation.js — the unified conversational surface, shared by the
// NTP hub + the chat. ONE module → one behavior → no drift (the two surfaces
// transform identically from a task start into a live conversation).
//
// Responsibilities:
//   - a long-lived runtime port that receives LIVE progress events (thinking /
//     tool-call / tool-result / text / done) from the service worker,
//   - rendering the persisted journal as a conversation (task → user bubble,
//     result → agent bubble) so reopening shows the history,
//   - the run flow: append the user turn → show a thinking indicator → render
//     the live progress (structured tool cards + a collapsible thinking trace)
//     → append the final result.
//
// The container is an <agent-conversation> element (the Web Component that owns
// the message rendering: markdown, code blocks, tool cards, thinking traces).

import { send } from "../lib/messages.js";
import { summarizeToolResult } from "../lib/tool-summary.js";
import { requestProviderHostAccess, providerOriginPattern, hasProviderHostAccess, isLocalProvider } from "../lib/provider-gate.js";

// ── the live progress port ────────────────────────────────────────────────
// A single long-lived port per page. The SW broadcasts progress to every
// connected port; the page's handler renders only what it cares about (the
// master run is serialized, so a page receives events for its own run).
let port = null;
const listeners = new Set();

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
    }
  });
  port.onDisconnect.addListener(() => {
    port = null;
  });
  return port;
}

/** Subscribe to live progress events. Returns an unsubscribe function. */
export function subscribeProgress(fn) {
  listeners.add(fn);
  ensurePort();
  return () => listeners.delete(fn);
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

// ── the run flow ───────────────────────────────────────────────────────────
// The ONE place the task-start → live-conversation transition lives. Both the
// hub + the chat drive it, so they transform identically.
//
//   runConversationTurn(container, { text, attachments, history })
//     1. appends the user turn,
//     2. shows a thinking indicator (upgraded to a collapsible trace),
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
function safeToolResult(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    const s = JSON.stringify(value);
    if (typeof s === "string") return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
  } catch { /* fall through */ }
  return String(value);
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

export async function runConversationTurn(container, { text, attachments = [], history = [], threadId = null, onStatus = null, agentId = null, agentKind = null }) {
  const c = container;

  // Proactively ensure the provider host permission BEFORE the run (the Run
  // click is a user gesture, so the permission can be requested right here —
  // the dynamic-permission-on-need principle: ask when needed, not after a
  // failure). A denied request returns early with a clear error instead of
  // running + failing.
  try {
    const cfg = await send("provider.get").catch(() => ({}));
    if (!isLocalProvider(cfg)) {
      const has = await hasProviderHostAccess(cfg);
      if (!has) {
        const r = await requestProviderHostAccess(cfg);
        if (!r.granted) {
          const err = { ok: false, error: "network access to the provider was denied — grant it in Settings (Providers) or click the Grant button", errorCategory: "host-permission", errorReason: "the provider host permission was denied", errorAction: "grant network access in Settings" };
          onStatus?.({ state: "error", message: err.errorReason, errorReason: err.errorReason, errorAction: err.errorAction, errorCategory: err.errorCategory });
          if (typeof c.appendError === "function") c.appendError(err.error, { reason: err.errorReason, action: err.errorAction, category: err.errorCategory });
          else appendBubble(c, "error", err.error);
          return err;
        }
      }
    }
  } catch {
    // A failure to check/request must not block the run — the run itself will
    // surface the actionable error if the permission is still missing.
  }
  // The host-permission provider failure: a DIRECT "Grant network access"
  // action (requests the provider's host permission right here, on the user's
  // click) — the dynamic-permission-on-need principle, not just "Fix in
  // Settings". Renders an inline button; clicking it grants + prompts a retry.
  const appendProviderGrant = (category, retryFn) => {
    if (category !== "host-permission") return;
    const row = document.createElement("div");
    row.className = "provider-grant";
    row.style.cssText = "display:flex;align-items:center;gap:8px;margin:0 0 14px;justify-content:flex-start;";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Grant network access";
    btn.style.cssText = "font:inherit;font-size:12.5px;font-weight:600;color:var(--accent,#0e6e63);background:transparent;border:1px solid var(--accent,#0e6e63);border-radius:6px;padding:4px 10px;cursor:pointer;";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Requesting…";
      try {
        const cfg = await send("provider.get").catch(() => ({}));
        const r = await requestProviderHostAccess(cfg);
        if (r.granted) {
          // The permission is granted ON THIS CLICK (a fresh user gesture) —
          // auto-retry the run so the user doesn't have to re-type the task.
          btn.textContent = "Granted — retrying…";
          if (typeof retryFn === "function") {
            row.remove();
            await retryFn();
          } else {
            btn.textContent = "Granted — run the task again";
          }
        } else {
          btn.textContent = "Denied — grant it in Settings";
          btn.disabled = false;
        }
      } catch {
        btn.textContent = "Grant it in Settings";
        btn.disabled = false;
      }
    });
    row.append(btn);
    c.append(row);
    if (typeof c.scrollTop === "number") c.scrollTop = c.scrollHeight;
  };
  const runId = newRunId();

  // 1. the user's turn appears immediately — the surface becomes a conversation.
  appendBubble(c, "user", text, attachments);

  // The run + result rendering, factored so the host-permission "Grant network
  // access" button can RE-RUN the same turn after the permission is granted
  // (the dynamic-permission-on-need retry).
  const executeTurn = async () => {

  // 2. a thinking indicator (a spinner; upgraded in-place to a collapsible
  //    trace when reasoning arrives).
  let thinking = typeof c.appendThinking === "function"
    ? c.appendThinking("thinking…")
    : appendBubble(c, "thinking", "thinking…");
  onStatus?.({ state: "working", activity: "thinking…" });
  // Per-call tool cards: a FIFO queue per tool NAME so parallel same-name calls
  // are matched in order and a completed card is never duplicated (the
  // wider-goal review's finding that a single `lastTool` left A's card running
  // and created a duplicate completed card when calls interleave).
  const inFlightTools = new Map(); // toolName -> Element[]
  const clearThinking = () => {
    thinking?.remove();
    thinking = null;
  };
  const takeInFlight = (toolName) => {
    const q = inFlightTools.get(toolName);
    if (!q || !q.length) return null;
    return q.shift();
  };

  // 3. subscribe to the live progress for THIS turn. The port broadcast is
  //    global, so we FILTER by runId — events for another thread/page are
  //    ignored (never mis-attributed). We unsubscribe in the finally.
  const unsubscribe = subscribeProgress((ev) => {
    if (!ev || typeof ev !== "object") return;
    // Only render THIS run's events (the SW tags them with runId).
    if (ev.runId != null && ev.runId !== runId) return;
    switch (ev.type) {
      case "thinking": {
        const step = ev.step != null ? ev.step + 1 : null;
        if (thinking) {
          const trace = ev.tokensSoFar ? String(ev.tokensSoFar) : "";
          thinking.setAttribute("step", step ?? "");
          if (ev.totalSteps != null) thinking.setAttribute("total-steps", String(ev.totalSteps));
          if (trace) thinking.setAttribute("content", trace);
        }
        break;
      }
      case "tool-call": {
        clearThinking();
        onStatus?.({ state: "working", activity: friendlyActivityLabel(ev.toolName, ev.toolArgs) });
        const card = typeof c.appendTool === "function"
          ? c.appendTool({ name: ev.toolName, args: ev.toolArgs, status: "running" })
          : appendBubble(c, "tool", `→ ${ev.toolName}`);
        const q = inFlightTools.get(ev.toolName) ?? [];
        q.push(card);
        inFlightTools.set(ev.toolName, q);
        break;
      }
      case "tool-result": {
        // Match the OLDEST in-flight card for this tool name (FIFO — handles
        // parallel same-name calls in order), mark it done; fall back to a fresh
        // done card only when no in-flight card exists.
        const card = takeInFlight(ev.toolName);
        const raw = safeToolResult(ev.result);
        const summary = ev.result != null ? summarizeToolResult(ev.toolName, ev.result) : "";
        if (card) {
          card.setAttribute?.("tool-status", "success");
          if (ev.durationMs != null) card.setAttribute?.("tool-duration", String(ev.durationMs));
          if (summary) card.setAttribute?.("tool-result", summary);
          if (raw && raw !== summary) card.setAttribute?.("tool-detail", raw);
        } else if (typeof c.appendTool === "function") {
          c.appendTool({ name: ev.toolName, status: "success", result: summary, detail: raw !== summary ? raw : null, durationMs: ev.durationMs });
        } else {
          appendBubble(c, "tool", `✓ ${ev.toolName}${summary ? ` — ${summary}` : ""}`);
        }
        break;
      }
      case "text":
        clearThinking();
        if (ev.text && ev.hasToolCalls) appendBubble(c, "agent", ev.text);
        break;
      case "done":
        clearThinking();
        onStatus?.({ state: "done" });
        break;
      case "error":
        clearThinking();
        onStatus?.({
          state: "error",
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
        appendProviderGrant(ev.category ?? null, executeTurn);
        break;
    }
  });

  // 4. run the task (history = the prior turns, so a nudge steers the thread).
  //    A named-agent chat (agentId set, agentKind="named") delegates to that
  //    agent's OWN sandbox; a background-agent chat (agentKind="background")
  //    runs the task in the background agent's own memory.
  let res;
  try {
    if (agentKind === "background") {
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
    unsubscribe();
  }

  // 5. the final result (the journal is the source of truth; append the result
  //    bubble locally so the user sees the outcome without a refresh).
  clearThinking();
  if (res?.ok) {
    onStatus?.({ state: "done" });
    if (typeof res.result === "string" && res.result) {
      appendBubble(c, "agent", res.result);
    }
  } else {
    // A provider/config failure must be CLEAR + ACTIONABLE, not a generic
    // "Error: …" — surface the UNWRAPPED reason + the "what to do" + a
    // "Fix in Settings" button (the category drives the button).
    const reason = res?.errorReason ?? null;
    const action = res?.errorAction ?? null;
    const category = res?.errorCategory ?? null;
    const msg = res?.error ?? "unknown error";
    onStatus?.({
      state: "error",
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
    appendProviderGrant(category, executeTurn);
  }
  return res;
  };

  // 6. run the turn (the grant button re-invokes executeTurn on retry).
  return await executeTurn();
}
