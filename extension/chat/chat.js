// chat/chat.js — the conversation surface: messages, screenshot history, run.

import { send } from "../lib/messages.js";

const body = document.getElementById("body");
const input = document.getElementById("input");
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

async function runTask(text) {
  addMessage("user", text);
  // A dedicated status element announces the in-progress + completion state
  // reliably (the log's aria-relevant="additions" does NOT re-announce a text
  // mutation of an existing node). The final result is a NEW addition.
  const status = document.createElement("div");
  status.className = "msg agent";
  status.textContent = "Thinking…";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  body.append(status);
  body.scrollTop = body.scrollHeight;
  let res;
  try {
    res = await send("agent.run", { task: text, id: String(Date.now()) });
  } catch (e) {
    // A rejected send must never leave "Thinking…" stuck (the round-14 medium).
    res = { ok: false, error: String(e?.message ?? e) };
  } finally {
    status.remove();
  }
  addMessage(
    "agent",
    res.ok ? (res.result ?? "(done)") : "Error: " + (res.error ?? "unknown"),
  );
  body.scrollTop = body.scrollHeight;
  // Capture a screenshot of the active tab into the history strip.
  captureShot(text);
}

async function captureShot(label) {
  const res = await send("capture.tab");
  if (!res?.screenshot) return; // no capture (no grant/permission) → no dead button
  const s = document.createElement("button");
  s.type = "button";
  s.className = "shot";
  // A real button (keyboard-operable) with an accessible name, not a clickable
  // <div> with no focus/keyboard semantics or image description. The button
  // re-opens the SOURCE page (the tab that was captured), not the raw data URL.
  s.style.background = `url(${res.screenshot}) center/cover`;
  s.setAttribute("aria-label", `Open page: ${label}`);
  s.addEventListener("click", () => {
    if (res.url) window.open(res.url);
  });
  shotsEl.append(s);
  while (shotsEl.children.length > MAX_SHOTS) shotsEl.firstElementChild.remove();
}

document.getElementById("send").addEventListener("click", () => {
  const t = input.value.trim();
  if (!t) return;
  input.value = "";
  runTask(t);
});
input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); document.getElementById("send").click(); } });

addMessage("agent", "Chrome Agent Platform chat. Ask a task, @mention a site agent, or attach media. Screenshots of visited pages appear below.");
