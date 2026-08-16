// chat/chat.js — the conversation surface: messages, screenshot history, run.
// The composer is the shared Web Component (<agent-composer>), and the run flow
// is the SAME shared conversational module as the NTP hub — so the chat + the
// hub transform identically (task → live conversation → nudge), no drift.

import { send } from "../lib/messages.js";
import {
  runConversationTurn,
  renderJournal,
  loadJournal,
  historyFromJournal,
  appendBubble,
} from "../shared/conversation.js";

const body = document.getElementById("body");
const shotsEl = document.getElementById("shots");

// Long-lived-surface bounds: the chat is a rolling window, not an unbounded
// growth (Constitution §4). Trim old bubbles + screenshots past a cap.
const MAX_MESSAGES = 50;
const MAX_SHOTS = 20;

function trim() {
  while (body.children.length > MAX_MESSAGES) body.firstElementChild.remove();
}

// The run flow (identical to the hub): append the user turn, stream live
// progress, append the result. The composer stays live throughout — a follow-up
// is a nudge in the same thread.
async function runTask(text, attachments = []) {
  const history = historyFromJournal(await loadJournal());
  await runConversationTurn(body, { text, attachments, history });
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
    if (res.url) window.open(res.url);
  });
  shotsEl.append(s);
  while (shotsEl.children.length > MAX_SHOTS) shotsEl.firstElementChild.remove();
}

// The shared composer Web Component — identical (mic + attach + input + send)
// to the NTP hub.
const composer = document.getElementById("composer");
composer.addEventListener("send", async (ev) => {
  await runTask(ev.detail.text, ev.detail.attachments);
});
composer.addEventListener("status", (ev) => {
  if (ev.detail?.text) appendBubble(body, "agent", ev.detail.text);
});

// Open the REAL Chrome side panel (the driven-page surface), not a fake in-page
// pane. chrome.sidePanel.open requires the optional `sidePanel` permission; if
// it is not granted, the button degrades to a message instead of throwing.
document.getElementById("open-side-panel").addEventListener("click", async () => {
  try {
    // A window-scoped panel (the manifest declares a default_path side panel).
    await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
  } catch {
    appendBubble(body, "agent", "The side panel permission is not granted — enable it in Settings → Permissions.");
  }
});

// Reopen → show the persisted conversation history (the journal is the source of
// truth), so the thread continues where it left off.
(async () => {
  const journal = await loadJournal();
  if (Array.isArray(journal) && journal.length) {
    renderJournal(body, journal);
    trim();
  } else {
    appendBubble(
      body,
      "agent",
      "Chrome Agent Platform chat. Ask a task, @mention a site agent, or attach media. Screenshots of visited pages appear below.",
    );
  }
})();
