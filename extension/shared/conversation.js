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
//     the live progress → append the final result.

import { send } from "../lib/messages.js";

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
export function appendBubble(container, role, text, label = "") {
  const bubble = document.createElement("message-bubble");
  bubble.setAttribute("role", role);
  if (label) bubble.setAttribute("label", label);
  bubble.textContent = text;
  container.append(bubble);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

/** Render a persisted journal as a conversation (reopening shows the history). */
export function renderJournal(container, journal) {
  container.replaceChildren();
  const rows = Array.isArray(journal) ? journal : [];
  if (!rows.length) {
    const p = document.createElement("p");
    p.style.color = "var(--muted)";
    p.textContent = "No conversation yet — start one above.";
    container.append(p);
    return;
  }
  for (const r of rows.slice(-20)) {
    if (r?.type === "task" && typeof r.task === "string") {
      appendBubble(container, "user", r.task, "task");
    } else if (r?.type === "result" && typeof r.result === "string") {
      appendBubble(container, "agent", r.result, "result");
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
//     2. shows a thinking indicator,
//     3. streams live progress (tool calls / step text) below it,
//     4. returns the final { ok, result } and appends the result bubble.
//
// A mid-run nudge is simply ANOTHER turn: the composer stays live, and a
// follow-up message appends to the same conversation + runs after the current
// turn (the SW serializes master runs), carrying the prior history.
export async function runConversationTurn(container, { text, attachments = [], history = [] }) {
  // 1. the user's turn appears immediately — the surface becomes a conversation.
  appendBubble(container, "user", text, "task");

  // 2. a thinking indicator (replaced/removed as live progress arrives).
  let thinking = appendBubble(container, "thinking", "Thinking…", "thinking");
  const clearThinking = () => {
    thinking?.remove();
    thinking = null;
  };

  // 3. subscribe to the live progress for THIS turn. Because the port broadcast
  //    is global + master runs are serialized, the events that arrive while this
  //    await is pending belong to this turn. We unsubscribe in the finally.
  const unsubscribe = subscribeProgress((ev) => {
    if (!ev || typeof ev !== "object") return;
    switch (ev.type) {
      case "thinking":
        if (!thinking) thinking = appendBubble(container, "thinking", "Thinking…", "thinking");
        thinking.textContent = `Thinking… (step ${
          (ev.step ?? 0) + 1
        }${ev.totalSteps ? ` of ${ev.totalSteps}` : ""})`;
        break;
      case "tool-call":
        clearThinking();
        appendBubble(container, "tool", `→ ${ev.toolName}`, "tool");
        break;
      case "tool-result":
        appendBubble(
          container,
          "tool",
          `✓ ${ev.toolName}${ev.result ? ` — ${ev.result}` : ""}`,
          "tool",
        );
        break;
      case "text":
        // A completed step's text. Only render INTERMEDIATE step text (a step
        // that made tool calls and will continue) — the FINAL text (hasToolCalls
        // false) is the run's result, rendered once by `done`/the final result
        // below, so a single-step run never double-renders.
        clearThinking();
        if (ev.text && ev.hasToolCalls) appendBubble(container, "agent", ev.text, "agent");
        break;
      case "done":
        clearThinking();
        break;
      case "error":
        clearThinking();
        appendBubble(container, "error", ev.message ?? "error", "error");
        break;
    }
  });

  // 4. run the task (history = the prior turns, so a nudge steers the thread).
  let res;
  try {
    res = await send("agent.run", {
      task: text,
      id: String(Date.now()),
      attachments,
      history,
    });
  } catch (e) {
    res = { ok: false, error: String(e?.message ?? e) };
  } finally {
    unsubscribe();
  }

  // 5. the final result (the journal is the source of truth; append the result
  //    bubble locally so the user sees the outcome without a refresh).
  clearThinking();
  if (res?.ok) {
    if (typeof res.result === "string" && res.result) {
      appendBubble(container, "agent", res.result, "result");
    }
  } else {
    appendBubble(container, "error", "Error: " + (res?.error ?? "unknown"), "error");
  }
  return res;
}
