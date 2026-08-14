// ntp/ntp.js — the hub page wiring.

import { send } from "../lib/messages.js";

const statusEl = document.getElementById("status");
const taskInput = document.getElementById("task-input");
const runBtn = document.getElementById("run-task");
const tasksEl = document.getElementById("tasks");
const agentsEl = document.getElementById("site-agents");

function setStatus(text, ready = true) {
  statusEl.textContent = text;
  statusEl.closest(".chip").querySelector(".dot").style.background = ready ? "var(--accent2)" : "var(--danger)";
}

async function refreshAgents() {
  const origins = await send("tools.allOrigins");
  const list = Array.isArray(origins) ? origins : [];
  agentsEl.replaceChildren();
  if (!list.length) {
    agentsEl.append(Object.assign(document.createElement("span"), { textContent: "No sites enrolled yet — browse the web to discover them.", style: "color:var(--muted)" }));
    return;
  }
  for (const origin of list) {
    const tools = await send("tools.list", { origin });
    const chip = document.createElement("div");
    chip.className = "agent";
    chip.innerHTML = `<span class="name">@${origin.replace(/^https?:\/\//, "").replace(/\/.*/, "")}</span><span class="tools">${(Array.isArray(tools) ? tools.length : 0)} tools</span>`;
    chip.onclick = () => { taskInput.value = `@${origin} `; taskInput.focus(); };
    agentsEl.append(chip);
  }
}

async function refreshTasks() {
  const mem = await send("memory.list", { origin: "master" });
  // Render the journal as a task list.
  const journal = await send("memory.get", { origin: "master", key: "journal" });
  const rows = Array.isArray(journal) ? journal : [];
  tasksEl.replaceChildren();
  if (!rows.length) {
    tasksEl.append(Object.assign(document.createElement("p"), { textContent: "No tasks yet — start one above.", style: "color:var(--muted)" }));
    return;
  }
  for (const r of rows.slice(-10).reverse()) {
    const div = document.createElement("div");
    div.className = "task";
    const text = typeof r === "object" && r.task ? r.task : String(r).slice(0, 80);
    div.innerHTML = `<div class="t">${escapeHtml(text)}</div><div class="meta">${r.scheduled ? "scheduled" : "done"}</div>`;
    tasksEl.append(div);
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

runBtn.addEventListener("click", async () => {
  const task = taskInput.value.trim();
  if (!task) return;
  setStatus("running task…", false);
  const res = await send("agent.run", { task, id: String(Date.now()) });
  if (res.ok) {
    setStatus("agent ready");
    await refreshTasks();
  } else {
    setStatus("error: " + (res.error ?? "unknown"), false);
  }
});

document.getElementById("save-provider").addEventListener("click", async () => {
  const model = document.getElementById("model-select").value;
  const apiKey = document.getElementById("api-key").value;
  await send("provider.set", { config: { model: model === "glm" ? "glm-5.3" : "deepseek-chat", provider: model, apiKey: apiKey || undefined } });
  setStatus("provider saved");
});

document.getElementById("open-memory").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("open-directory").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("directory/directory.html") }));

(async () => {
  const cfg = await send("provider.get");
  if (cfg && cfg.provider === "glm") document.getElementById("model-select").value = "glm";
  refreshAgents();
  refreshTasks();
  setStatus("agent ready");
})();
