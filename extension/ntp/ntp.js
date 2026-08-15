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
  const res = await send("agent.run", { task, id: String(Date.now()), attachments: attachments.splice(0) });
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
  if (kind === "record-audio") { await startAudioCapture(); return; }
  if (kind === "capture-camera") { await startCameraCapture(); return; }
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
    addAttachTag(`📎 ${file.name}`);
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

// ---- media capture (record audio + camera) --------------------------------
// The "+" attach menu's Record audio / Capture camera options. Real MediaRecorder
// + getUserMedia, not file pickers. Captured media attaches to the composer like
// a file; permission denial degrades cleanly (never an unhandled rejection).
const capPanel = document.getElementById("capture-panel");
const capTitle = document.getElementById("cap-title");
const capVideo = document.getElementById("cap-video");
const capAction = document.getElementById("cap-action");
const capTimer = document.getElementById("cap-timer");
const capMeter = document.getElementById("cap-meter");
const capNote = document.getElementById("cap-note");
const capClose = document.getElementById("cap-close");

function addAttachTag(label) {
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = label;
  plusBtn.insertAdjacentElement("afterend", tag);
}

let capStream = null;
let capRecorder = null;
let capChunks = [];
let capMode = null; // "audio" | "camera"
let capRecording = false;
let capTimerId = null;
let capStartedAt = 0;
let capAudioCtx = null;
let capAnalyser = null;
let capRafId = null;

function capShow(mode) {
  capMode = mode;
  capPanel.hidden = false;
  capTitle.textContent = mode === "audio" ? "Record audio" : "Capture camera";
  capAction.textContent = mode === "camera" ? "📷 Capture photo" : "● Record";
  capTimer.textContent = "0:00";
  capNote.textContent = "";
  capVideo.hidden = mode === "audio";
  capPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function capClosePanel() {
  stopCapRecording();
  if (capStream) { capStream.getTracks().forEach((t) => t.stop()); capStream = null; }
  stopMeter();
  capPanel.hidden = true;
  capVideo.srcObject = null;
}

capClose.addEventListener("click", capClosePanel);

function startMeter(stream) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { pulseMeter(); return; }
    capAudioCtx = capAudioCtx || new Ctx();
    if (capAudioCtx.state === "suspended") capAudioCtx.resume();
    const src = capAudioCtx.createMediaStreamSource(stream);
    capAnalyser = capAudioCtx.createAnalyser();
    capAnalyser.fftSize = 256;
    src.connect(capAnalyser);
    const data = new Uint8Array(capAnalyser.frequencyBinCount);
    const bars = [...capMeter.children];
    const draw = () => {
      if (!capAnalyser) return;
      capAnalyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i];
      const level = sum / (data.length / 4) / 255; // 0..1
      bars.forEach((b, i) => {
        const h = 4 + level * 16 * (0.5 + 0.5 * Math.sin(i / 2 + Date.now() / 180));
        b.style.height = Math.max(4, Math.min(20, h)) + "px";
      });
      capRafId = requestAnimationFrame(draw);
    };
    draw();
  } catch {
    pulseMeter();
  }
}

function pulseMeter() {
  // fallback: animate the meter without an AnalyserNode (e.g. no audio API)
  const bars = [...capMeter.children];
  const draw = () => {
    if (!capPanel || capPanel.hidden) return;
    bars.forEach((b, i) => {
      b.style.height = (5 + 12 * Math.abs(Math.sin(Date.now() / 220 + i))) + "px";
    });
    capRafId = requestAnimationFrame(draw);
  };
  draw();
}

function stopMeter() {
  if (capRafId) cancelAnimationFrame(capRafId);
  capRafId = null;
  if (capAnalyser) { capAnalyser = null; }
  if (capAudioCtx) { try { capAudioCtx.close(); } catch { /* ignore */ } capAudioCtx = null; }
}

function capElapsed() {
  const s = Math.floor((Date.now() - capStartedAt) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function startAudioCapture() {
  if (!navigator.mediaDevices?.getUserMedia) { setStatus("audio capture not available here", false); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    handleCaptureError("audio", err);
    return;
  }
  capStream = stream;
  capShow("audio");
  startMeter(stream);
}

async function startCameraCapture() {
  if (!navigator.mediaDevices?.getUserMedia) { setStatus("camera capture not available here", false); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    handleCaptureError("camera", err);
    return;
  }
  capStream = stream;
  capShow("camera");
  capVideo.srcObject = stream;
  startMeter(stream);
}

function handleCaptureError(kind, err) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    setStatus(`${kind} permission denied — that's fine, attach a file instead`, false);
  } else if (name === "NotFoundError") {
    setStatus(`${kind} not found — no ${kind === "audio" ? "microphone" : "camera"} device available`, false);
  } else {
    setStatus(`${kind} capture error: ${String(err?.message ?? err)}`, false);
  }
}

function stopCapRecording() {
  if (capRecorder && capRecorder.state !== "inactive") { try { capRecorder.stop(); } catch { /* ignore */ } }
  capRecorder = null;
  capRecording = false;
  if (capTimerId) clearInterval(capTimerId);
  capTimerId = null;
  capAction.textContent = capMode === "camera" ? "📷 Capture photo" : "● Record";
}

function finishCapture(blob, kind, name) {
  const url = URL.createObjectURL(blob);
  attachments.push({ name, kind, size: blob.size, type: blob.type, blobURL: url, blob });
  addAttachTag(`${kind === "audio" ? "🎙️" : "🎥"} ${name}`);
  setStatus(`attached ${name}`);
  capClosePanel();
}

capAction.addEventListener("click", async () => {
  if (capMode === "camera") {
    // camera: capture a photo frame (or stop an in-progress recording)
    if (capRecording) { stopCapRecording(); return; }
    try {
      const w = capVideo.videoWidth, h = capVideo.videoHeight;
      if (!w || !h) { setStatus("camera not ready yet", false); return; }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(capVideo, 0, 0, w, h);
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.9));
      if (!blob) { setStatus("capture failed", false); return; }
      finishCapture(blob, "image", `photo-${Date.now()}.jpg`);
    } catch (err) {
      setStatus("camera capture error: " + String(err?.message ?? err), false);
    }
    return;
  }

  // audio: toggle record / stop
  if (!capRecording) {
    if (!capStream) return;
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    try {
      capRecorder = new MediaRecorder(capStream, { mimeType: mime });
    } catch {
      capRecorder = new MediaRecorder(capStream);
    }
    capChunks = [];
    capRecorder.ondataavailable = (e) => { if (e.data.size) capChunks.push(e.data); };
    capRecorder.onstop = () => {
      const mime = capRecorder ? (capRecorder.mimeType || "audio/webm") : "audio/webm";
      const blob = new Blob(capChunks, { type: mime });
      finishCapture(blob, "audio", `recording-${Date.now()}.webm`);
    };
    capRecorder.start();
    capRecording = true;
    capStartedAt = Date.now();
    capTimerId = setInterval(() => { capTimer.textContent = capElapsed(); }, 500);
    capAction.textContent = "■ Stop";
    capNote.textContent = "recording…";
  } else {
    stopCapRecording();
    capNote.textContent = "processing…";
  }
});

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
