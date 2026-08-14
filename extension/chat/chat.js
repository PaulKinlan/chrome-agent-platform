// chat/chat.js — the conversation surface: messages, screenshot history, run.

import { send } from "../lib/messages.js";

const body = document.getElementById("body");
const input = document.getElementById("input");
const shotsEl = document.getElementById("shots");

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  body.append(div);
  body.scrollTop = body.scrollHeight;
}

async function runTask(text) {
  addMessage("user", text);
  addMessage("agent", "Thinking…");
  const res = await send("agent.run", { task: text, id: String(Date.now()) });
  const last = body.lastElementChild;
  if (res.ok) last.textContent = res.result ?? "(done)";
  else last.textContent = "Error: " + (res.error ?? "unknown");
  body.scrollTop = body.scrollHeight;
  // Capture a screenshot of the active tab into the history strip.
  captureShot(text);
}

async function captureShot(label) {
  const res = await send("capture.tab");
  if (res.screenshot) {
    const s = document.createElement("div");
    s.className = "shot";
    s.title = label;
    s.style.background = `url(${res.screenshot}) center/cover`;
    s.onclick = () => window.open(res.screenshot);
    shotsEl.append(s);
  } else {
    const s = document.createElement("div");
    s.className = "shot";
    s.textContent = "MHTML";
    s.title = "MHTML save (seam: chrome.pageCapture)";
    shotsEl.append(s);
  }
}

document.getElementById("send").addEventListener("click", () => {
  const t = input.value.trim();
  if (!t) return;
  input.value = "";
  runTask(t);
});
input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); document.getElementById("send").click(); } });

addMessage("agent", "Chrome Agent Platform chat. Ask a task, @mention a site agent, or attach media. Screenshots of visited pages appear below.");
