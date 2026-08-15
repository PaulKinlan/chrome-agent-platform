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
  // the "thinking" glow — toggle the halo on the composer while the agent runs
  document.querySelector(".composer")?.classList.toggle("glow", !ready);
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

async function refreshRecipes() {
  const recipesEl = document.getElementById("recipes");
  if (!recipesEl) return;
  const res = await send("recipe.list");
  const list = Array.isArray(res.recipes) ? res.recipes : [];
  recipesEl.replaceChildren();
  for (const r of list) {
    const chip = document.createElement("button");
    chip.className = "chip";
    chip.style.cursor = "pointer";
    chip.innerHTML = `<span>${r.icon ?? ""}</span><span>${escapeHtml(r.name)}</span>`;
    chip.onclick = async () => {
      setStatus(`running recipe: ${r.name}`, false);
      const out = await send("recipe.run", { id: r.id });
      if (out.ok) { setStatus("agent ready"); await refreshTasks(); }
      else setStatus("error: " + (out.error ?? "unknown"), false);
    };
    recipesEl.append(chip);
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

refreshRecipes();
refreshAgents();
refreshTasks();

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

const modelSelect = document.getElementById("model-select");
const baseUrlInput = document.getElementById("base-url");
const apiKeyInput = document.getElementById("api-key");
function syncProviderInputs() {
  const isOpenAI = modelSelect.value === "openai";
  baseUrlInput.style.display = isOpenAI ? "" : "none";
  apiKeyInput.style.display = isOpenAI ? "" : "none";
}
modelSelect.addEventListener("change", syncProviderInputs);

document.getElementById("save-provider").addEventListener("click", async () => {
  const provider = modelSelect.value;
  const config = { provider };
  if (provider === "openai") {
    config.baseURL = baseUrlInput.value.trim();
    config.apiKey = apiKeyInput.value.trim();
    config.model = document.getElementById("model-name")?.value?.trim() || "gpt-4o-mini";
  }
  await send("provider.set", { config });
  setStatus("provider saved");
});

document.getElementById("open-memory").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("open-directory").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("directory/directory.html") }));

(async () => {
  const cfg = await send("provider.get");
  if (cfg && cfg.provider) {
    modelSelect.value = cfg.provider;
    if (cfg.baseURL) baseUrlInput.value = cfg.baseURL;
    if (cfg.apiKey) apiKeyInput.value = cfg.apiKey;
    syncProviderInputs();
  }
  refreshAgents();
  refreshTasks();
  setStatus("agent ready");
})();
