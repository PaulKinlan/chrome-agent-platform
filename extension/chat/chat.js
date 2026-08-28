// chat/chat.js — the conversation surface: messages, screenshot history, run.
// The composer is the shared Web Component (<agent-composer>), and the run flow
// is the SAME shared conversational module as the NTP hub — so the chat + the
// hub transform identically (task → live conversation → nudge), no drift.

import { send } from "../lib/messages.js";
import {
  runConversationTurn,
  appendBubble,
  subscribeProgress,
} from "../shared/conversation.js";
import {
  installPageDiagnostics,
  refreshDiagnostics,
  startDiagnosticPolling,
} from "../shared/diagnostics-client.js";

const body = document.getElementById("body");
const shotsEl = document.getElementById("shots");

// The ACTIVE thread this chat continues (the wider-goal review found the chat
// never kept its threadId and instead mixed the GLOBAL master journal — which
// also holds NTP/scheduled/recipe/hook runs — into the conversation). The chat
// now loads ONE thread and continues it.
let activeThreadId = null;

// Long-lived-surface bounds: the chat is a rolling window, not an unbounded
// growth (Constitution §4). Trim old bubbles + screenshots past a cap.
const MAX_MESSAGES = 50;
const MAX_SHOTS = 20;

function trim() {
  while (body.children.length > MAX_MESSAGES) body.firstElementChild.remove();
}

// The run flow (identical to the hub): append the user turn, stream live
// progress, append the result. The composer stays live throughout — a follow-up
// is a nudge in the same thread. `agent` (the + menu's Choose agent chip / a
// committed /agent: option) is an @MENTION: the task stays the hub's thread
// and the run delegates to the referenced agent, whose result is committed
// back into this thread (CAP-FB-20260824-TASK-AGENT-BOUNDARY-01) — a mentioned
// task no longer vanishes from the task list.
async function runTask(text, attachments = [], agent = null) {
  // Continue the ACTIVE thread (a follow-up is a nudge in the SAME thread),
  // including for a mentioned delegation — the task is always threaded.
  await runConversationTurn(body, {
    text,
    attachments,
    threadId: activeThreadId ?? null,
    mention: agent?.ref ? { kind: agent.kind, id: agent.id, name: agent.name ?? agent.id } : null,
  }).then((res) => {
    if (res?.threadId) activeThreadId = res.threadId;
  });
  trim();
  captureShot(text);
}

async function captureShot(label) {
  const res = await send("capture.tab");
  if (!res?.screenshot) return;
  const s = document.createElement("button");
  s.type = "button";
  s.className = "shot";
  s.style.background = `url(${res.screenshot}) center/cover`;
  s.setAttribute("aria-label", `Open page: ${label}`);
  s.addEventListener("click", () => {
    // Only re-open http(s) SOURCE pages (res.url is the captured tab's URL, not
    // the screenshot data URL — that lives in res.screenshot). Chrome blocks
    // top-level data: / chrome-extension: navigations from window.open, so guard
    // to http(s) and never attempt to open a data: URL (GLM-5.3 O6).
    if (typeof res.url === "string" && /^https?:\/\//i.test(res.url)) {
      window.open(res.url, "_blank", "noopener");
    }
  });
  shotsEl.append(s);
  while (shotsEl.children.length > MAX_SHOTS) shotsEl.firstElementChild.remove();
}

// The shared composer Web Component — identical (mic + attach + input + send)
// to the NTP hub.
const composer = document.getElementById("composer");
composer.addEventListener("send", async (ev) => {
  await runTask(ev.detail.text, ev.detail.attachments, ev.detail.agent ?? null);
});
composer.addEventListener("status", (ev) => {
  if (ev.detail?.text) appendBubble(body, "agent", ev.detail.text);
});
// A registry change (an agent renamed/deleted, a background agent disabled)
// revalidates the composer's selected-agent chip live.
subscribeProgress((ev) => {
  if (ev?.type === "agent-registry-changed") composer.revalidateSelectedAgent?.();
});

// Open the REAL Chrome side panel (the driven-page surface), not a fake in-page
// pane. chrome.sidePanel.open requires the optional `sidePanel` permission; if
// it is not granted, the button degrades to a message instead of throwing.
document.getElementById("open-side-panel").addEventListener("click", async () => {
  try {
    // A window-scoped panel (the manifest declares a default_path side panel).
    await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
  } catch {
    appendBubble(body, "agent", "The side panel permission is not granted — all permissions are granted at install; if Settings → Permissions shows it missing, reload the extension.");
  }
});

// Reopen → show the persisted ACTIVE thread (most recent), so the chat
// continues where it left off. Only THIS thread's messages render — never the
// global journal's unrelated runs.
(async () => {
  let loaded = false;
  try {
    const list = await send("thread.list");
    const threads = Array.isArray(list?.threads) ? list.threads : [];
    const first = threads[0];
    if (first?.id) {
      const got = await send("thread.get", { id: first.id });
      const msgs = Array.isArray(got?.thread?.messages) ? got.thread.messages : [];
      if (msgs.length) {
        activeThreadId = first.id;
        for (const m of msgs) {
          if (m?.role === "user" && m.content) appendBubble(body, "user", m.content);
          else if (m?.role === "assistant" && m.content) appendBubble(body, "agent", m.content);
        }
        trim();
        loaded = true;
      }
    }
  } catch { /* a missing thread is not fatal — fall through to the welcome */ }
  if (!loaded) {
    appendBubble(
      body,
      "agent",
      "Chrome Agent Platform chat. Ask a task, @mention an agent, or attach media. Screenshots of visited pages appear below.",
    );
  }
})();

// Transparency surface: capture the page's own errors/CSP violations + keep the
// shield/console badges live.
installPageDiagnostics();
refreshDiagnostics().catch(() => {});
startDiagnosticPolling();
