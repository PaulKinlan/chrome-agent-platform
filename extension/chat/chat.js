// chat/chat.js — the conversation surface: messages, screenshot history, run.
// The composer is the shared Web Component (<agent-composer>), identical to
// the NTP hub (mic + attach + input + send).

import { send } from "../lib/messages.js";

const body = document.getElementById("body");
const shotsEl = document.getElementById("shots");

// Long-lived-surface bounds: the chat is a rolling window, not an unbounded
// growth (Constitution §4). Trim old messages + screenshots past a cap.
const MAX_MESSAGES = 50;
const MAX_SHOTS = 20;

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  body.append(div);
  while (body.children.length > MAX_MESSAGES) body.firstElementChild.remove();
  body.scrollTop = body.scrollHeight;
  return div;
}

async function runTask(text, attachments = []) {
  addMessage("user", text);
  const status = document.createElement("div");
  status.className = "msg agent";
  status.textContent = "Thinking…";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  body.append(status);
  body.scrollTop = body.scrollHeight;
  let res;
  try {
    res = await send("agent.run", { task: text, id: String(Date.now()), attachments });
  } catch (e) {
    res = { ok: false, error: String(e?.message ?? e) };
  } finally {
    status.remove();
  }
  addMessage(
    "agent",
    res.ok ? (res.result ?? "(done)") : "Error: " + (res.error ?? "unknown"),
  );
  body.scrollTop = body.scrollHeight;
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
  if (ev.detail?.text) addMessage("agent", ev.detail.text);
});

// Open the REAL Chrome side panel (the driven-page surface), not a fake in-page
// pane. chrome.sidePanel.open requires the optional `sidePanel` permission; if
// it is not granted, the button degrades to a message instead of throwing.
document.getElementById("open-side-panel").addEventListener("click", async () => {
  try {
    // A window-scoped panel (the manifest declares a default_path side panel).
    await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
  } catch {
    addMessage("agent", "The side panel permission is not granted — enable it in Settings → Permissions.");
  }
});

addMessage("agent", "Chrome Agent Platform chat. Ask a task, @mention a site agent, or attach media. Screenshots of visited pages appear below.");
