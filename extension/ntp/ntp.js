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

// ---- attach menu: a single "+" opens Add file / audio / video / other ----
const plusBtn = document.getElementById("plus-btn");
const attachMenu = document.getElementById("attach-menu");
const attachments = []; // { name, kind, size, dataURL? } attached to the next run
plusBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  attachMenu.hidden = !attachMenu.hidden;
});
document.addEventListener("click", (e) => {
  if (!attachMenu.contains(e.target) && e.target !== plusBtn) attachMenu.hidden = true;
});
attachMenu.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-kind]");
  if (!btn) return;
  attachMenu.hidden = true;
  const kind = btn.dataset.kind;
  try {
    const [file] = await new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = kind === "audio" ? "audio/*" : kind === "video" ? "video/*" : "";
      input.onchange = () => resolve(input.files ?? []);
      input.oncancel = () => resolve([]);
      input.click();
    });
    if (!file) return;
    attachments.push({ name: file.name, kind, size: file.size, type: file.type });
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = `📎 ${file.name}`;
    plusBtn.insertAdjacentElement("afterend", tag);
  } catch (err) {
    setStatus("attach error: " + String(err?.message ?? err), false);
  }
});

// ---- microphone: Web Speech Recognition + waveform + real-time text (no dup) ----
const micBtn = document.getElementById("mic-btn");
const waveEl = document.getElementById("wave");
let recognition = null;
let listening = false;
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = "en-US";
  return r;
}
micBtn.addEventListener("click", () => {
  if (!listening) startListening();
  else stopListening();
});
function startListening() {
  if (!recognition) recognition = initRecognition();
  if (!recognition) { setStatus("speech recognition not available", false); return; }
  // the composer text before this listening session — final results append to it
  // once, using the interim span for live preview so nothing is duplicated.
  const baseText = taskInput.value;
  let interimSpan = null;
  let committed = baseText;
  const appendInterim = (text) => {
    if (!interimSpan) {
      taskInput.value = committed + (committed && text ? " " : "") + text;
    } else {
      taskInput.value = committed + (committed && text ? " " : "") + text;
    }
    interimSpan = text;
  };
  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        // final: commit ONCE (replace any trailing interim, append the transcript)
        const transcript = res[0].transcript.trim();
        if (transcript) {
          committed = committed ? committed + " " + transcript : transcript;
        }
        interim = "";
      } else {
        interim += res[0].transcript;
      }
    }
    taskInput.value = (committed + (committed && interim ? " " : "") + interim).trim();
    interimSpan = interim;
  };
  recognition.onend = () => {
    // if the engine stops unexpectedly while we still want to listen, restart once
    if (listening) { try { recognition.start(); } catch { /* ignore */ } return; }
    stopListening();
  };
  recognition.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    setStatus("speech error: " + event.error, false);
    stopListening();
  };
  listening = true;
  micBtn.classList.add("listening");
  micBtn.setAttribute("aria-label", "Stop listening");
  waveEl.hidden = false;
  try { recognition.start(); } catch { /* already started */ }
}
function stopListening() {
  listening = false;
  micBtn.classList.remove("listening");
  micBtn.setAttribute("aria-label", "Start listening");
  waveEl.hidden = true;
  if (recognition) { try { recognition.stop(); } catch { /* ignore */ } }
}

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
