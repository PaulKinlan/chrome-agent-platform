// shared/composer.js — the single composer component.
//
// Renders mic + attach(+) + input + send, with the same behavior everywhere:
//   - Web Speech mic (continuous + interim, dedup'd live transcript)
//   - the "+" attach menu (file / record audio / capture camera / other)
//   - media capture panel (MediaRecorder audio + camera photo)
//   - Enter to send, Shift+Enter for a newline
//
// Mount with:
//   import { mountComposer } from "../shared/composer.js";
//   const composer = mountComposer(container, {
//     placeholder: "…",
//     label: "Start a task",          // optional; omit for no label
//     sendLabel: "Run task",          // default "Run task"
//     onSend: async (text, attachments) => { … },
//     onStatus: (text, ready) => { … } // optional; also updates the inline line
//   });
//
// The returned handle exposes `.input`, `.send`, `.setStatus(text, ready)`, and
// `.attachments` (the pending attachments, consumed by onSend).

const ICONS = {
  mic:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  plus:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  attach:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  camera:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  audio:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  record:
    '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>',
};

export function mountComposer(container, opts = {}) {
  const {
    placeholder = "Ask anything…",
    label = "",
    sendLabel = "Run task",
    onSend = async () => {},
    onStatus = () => {},
  } = opts;

  // ── DOM ────────────────────────────────────────────────────────────────
  const root = document.createElement("div");
  root.className = "composer";

  const input = document.createElement("textarea");
  input.id = "task-input";
  input.placeholder = placeholder;
  input.setAttribute("aria-label", label || "Message");
  input.rows = 2;

  const labelEl = document.createElement("label");
  labelEl.className = "tag";
  labelEl.setAttribute("for", "task-input");
  labelEl.textContent = label || "";

  const row = document.createElement("div");
  row.className = "row";

  // mic button
  const micBtn = document.createElement("button");
  micBtn.type = "button";
  micBtn.id = "mic-btn";
  micBtn.className = "btn ghost icon-btn mic";
  micBtn.title = "Speak";
  micBtn.setAttribute("aria-label", "Start listening");
  micBtn.innerHTML =
    '<span class="mic-icon">' + ICONS.mic + "</span>" +
    '<span class="mic-wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span>';

  // attach (+) button
  const plusBtn = document.createElement("button");
  plusBtn.type = "button";
  plusBtn.id = "plus-btn";
  plusBtn.className = "btn ghost icon-btn plus";
  plusBtn.title = "Attach";
  plusBtn.setAttribute("aria-label", "Add attachment");
  plusBtn.setAttribute("aria-haspopup", "menu");
  plusBtn.setAttribute("aria-expanded", "false");
  plusBtn.setAttribute("aria-controls", "attach-menu");
  plusBtn.innerHTML = ICONS.plus;

  const spacer = document.createElement("div");
  spacer.className = "spacer";

  const send = document.createElement("button");
  send.type = "button";
  send.id = "run-task";
  send.className = "btn";
  send.textContent = sendLabel;

  const attachMenu = document.createElement("div");
  attachMenu.id = "attach-menu";
  attachMenu.className = "attach-menu";
  attachMenu.setAttribute("role", "menu");
  attachMenu.setAttribute("aria-label", "Attach");
  attachMenu.hidden = true;
  attachMenu.innerHTML =
    '<button type="button" role="menuitem" data-kind="file">Add file</button>' +
    '<button type="button" role="menuitem" data-kind="record-audio">Record audio</button>' +
    '<button type="button" role="menuitem" data-kind="capture-camera">Capture camera</button>' +
    '<button type="button" role="menuitem" data-kind="record-screen">Record screen</button>' +
    '<button type="button" role="menuitem" data-kind="grab-screenshot">Grab screenshot</button>' +
    '<button type="button" role="menuitem" data-kind="add-tab">Add tab</button>' +
    '<button type="button" role="menuitem" data-kind="add-window">Add window</button>' +
    '<p class="attach-note">Text files are read by the agent. Audio/video/image ' +
    'are attached but NOT read by the model yet (multimodal is coming) — ' +
    'their bytes are not sent to the model or stored with the message.</p>';

  row.append(micBtn, plusBtn, spacer, send, attachMenu);
  if (label) root.append(labelEl);
  root.append(input, row);

  const statusLine = document.createElement("div");
  statusLine.className = "composer-status";
  statusLine.setAttribute("role", "status");
  statusLine.setAttribute("aria-live", "polite");

  // media capture panel (rendered as a sibling of the composer, in `container`)
  const capture = document.createElement("div");
  capture.className = "capture";
  capture.id = "capture-panel";
  capture.hidden = true;
  capture.innerHTML =
    '<div class="cap-head"><span id="cap-title">Record audio</span>' +
    '<button type="button" class="btn ghost" id="cap-close" aria-label="Close">✕</button></div>' +
    '<video id="cap-video" autoplay muted playsinline hidden></video>' +
    '<div class="cap-controls">' +
    '<button type="button" class="btn" id="cap-action">' +
    ICONS.record + " Record</button>" +
    '<span class="cap-timer" id="cap-timer">0:00</span>' +
    '<div class="cap-meter" id="cap-meter"><span></span><span></span><span></span><span></span><span></span></div>' +
    '</div>' +
    '<p class="cap-note" id="cap-note" style="color:var(--muted);font-size:12px"></p>';

  container.append(root, statusLine, capture);

  // ── state ──────────────────────────────────────────────────────────────
  const attachments = []; // { name, kind, size, type, dataURL? }
  const api = { input, send, attachments, setStatus, focus };

  function setStatus(text, ready = true) {
    statusLine.textContent = text || "";
    try {
      onStatus(text, ready);
    } catch { /* ignore */ }
  }

  function focus() {
    input.focus();
  }

  // ── attach menu ────────────────────────────────────────────────────────
  function openAttachMenu() {
    attachMenu.hidden = false;
    plusBtn.setAttribute("aria-expanded", "true");
    const first = attachMenu.querySelector("button[role='menuitem']");
    first?.focus();
  }
  function closeAttachMenu(returnFocus = true) {
    if (attachMenu.hidden) return;
    attachMenu.hidden = true;
    plusBtn.setAttribute("aria-expanded", "false");
    if (returnFocus) plusBtn.focus();
  }
  plusBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (attachMenu.hidden) openAttachMenu();
    else closeAttachMenu();
  });
  attachMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeAttachMenu(true);
      return;
    }
    const items = [...attachMenu.querySelectorAll("button[role='menuitem']")];
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      items[(idx + delta + items.length) % items.length].focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1].focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!attachMenu.contains(e.target) && e.target !== plusBtn) {
      closeAttachMenu(false);
    }
  });

  function addAttachTag(labelText, iconKey) {
    const tag = document.createElement("span");
    tag.className = "tag";
    if (iconKey && ICONS[iconKey]) {
      const icon = document.createElement("span");
      icon.className = "tag-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = ICONS[iconKey];
      tag.appendChild(icon);
    }
    tag.appendChild(document.createTextNode(labelText));
    plusBtn.insertAdjacentElement("afterend", tag);
  }
  function clearAttachTags() {
    root.querySelectorAll(".tag").forEach((t) => t.remove());
  }

  attachMenu.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-kind]");
    if (!btn) return;
    closeAttachMenu(false);
    const kind = btn.dataset.kind;
    if (kind === "record-audio") {
      await startAudioCapture();
      return;
    }
    if (kind === "capture-camera") {
      await startCameraCapture();
      return;
    }
    if (kind === "record-screen") {
      await startScreenCapture();
      return;
    }
    if (kind === "grab-screenshot") {
      await grabScreenshot();
      return;
    }
    if (kind === "add-tab") {
      await addTab();
      return;
    }
    if (kind === "add-window") {
      await addWindow();
      return;
    }
    try {
      const [file] = await new Promise((resolve) => {
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = kind === "audio"
          ? "audio/*"
          : kind === "video"
          ? "video/*"
          : "";
        fileInput.onchange = () => resolve(fileInput.files ?? []);
        fileInput.oncancel = () => resolve([]);
        fileInput.click();
      });
      if (!file) {
        plusBtn.focus();
        return;
      }
      let dataURL = "";
      try {
        dataURL = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(file);
        });
      } catch { /* non-fatal */ }
      attachments.push({
        name: file.name,
        kind,
        size: file.size,
        type: file.type,
        dataURL,
      });
      addAttachTag(file.name, "attach");
      plusBtn.focus();
    } catch (err) {
      setStatus("attach error: " + String(err?.message ?? err), false);
      plusBtn.focus();
    }
  });

  // ── mic ────────────────────────────────────────────────────────────────
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
    if (!recognition) {
      setStatus("speech recognition not available", false);
      return;
    }
    const baseText = input.value;
    let committed = baseText;
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          const transcript = res[0].transcript.trim();
          if (transcript) {
            committed = committed ? committed + " " + transcript : transcript;
          }
          interim = "";
        } else {
          interim += res[0].transcript;
        }
      }
      input.value = (committed + (committed && interim ? " " : "") + interim)
        .trim();
    };
    recognition.onend = () => {
      if (listening) {
        try {
          recognition.start();
        } catch { /* ignore */ }
        return;
      }
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
    try {
      recognition.start();
    } catch { /* already started */ }
  }
  function stopListening() {
    listening = false;
    micBtn.classList.remove("listening");
    micBtn.setAttribute("aria-label", "Start listening");
    if (recognition) {
      try {
        recognition.stop();
      } catch { /* ignore */ }
    }
  }

  // ── media capture ──────────────────────────────────────────────────────
  const capTitle = capture.querySelector("#cap-title");
  const capVideo = capture.querySelector("#cap-video");
  const capAction = capture.querySelector("#cap-action");
  const capTimer = capture.querySelector("#cap-timer");
  const capMeter = capture.querySelector("#cap-meter");
  const capNote = capture.querySelector("#cap-note");
  const capClose = capture.querySelector("#cap-close");

  let capStream = null;
  let capRecorder = null;
  let capChunks = [];
  let capMode = null;
  let capRecording = false;
  let capTimerId = null;
  let capStartedAt = 0;
  let capAudioCtx = null;
  let capAnalyser = null;
  let capRafId = null;

  function setActionIcon(el, key, labelText) {
    el.innerHTML = (ICONS[key] || "") + " " + labelText;
  }

  function capShow(mode) {
    capMode = mode;
    capture.hidden = false;
    capTitle.textContent = mode === "audio" ? "Record audio" : "Capture camera";
    setActionIcon(
      capAction,
      mode === "camera" ? "camera" : "record",
      mode === "camera" ? "Capture photo" : "Record",
    );
    capTimer.textContent = "0:00";
    capNote.textContent = "";
    capVideo.hidden = mode === "audio";
    capture.scrollIntoView({ behavior: "smooth", block: "nearest" });
    capAction.focus();
  }

  function reducedMotion() {
    try {
      return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ===
        true;
    } catch {
      return false;
    }
  }
  function staticMeter() {
    [...capMeter.children].forEach((b) => {
      b.style.height = "8px";
    });
  }
  function startMeter(stream) {
    if (reducedMotion()) {
      staticMeter();
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        pulseMeter();
        return;
      }
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
        const level = sum / (data.length / 4) / 255;
        bars.forEach((b, i) => {
          const h = 4 +
            level * 16 * (0.5 + 0.5 * Math.sin(i / 2 + Date.now() / 180));
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
    if (reducedMotion()) {
      staticMeter();
      return;
    }
    const bars = [...capMeter.children];
    const draw = () => {
      if (!capture || capture.hidden) return;
      bars.forEach((b, i) => {
        b.style.height = (5 + 12 * Math.abs(Math.sin(Date.now() / 220 + i))) +
          "px";
      });
      capRafId = requestAnimationFrame(draw);
    };
    draw();
  }
  function stopMeter() {
    if (capRafId) cancelAnimationFrame(capRafId);
    capRafId = null;
    if (capAnalyser) capAnalyser = null;
    if (capAudioCtx) {
      try {
        capAudioCtx.close();
      } catch { /* ignore */ }
      capAudioCtx = null;
    }
  }
  function capElapsed() {
    const s = Math.floor((Date.now() - capStartedAt) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  async function startAudioCapture() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("audio capture not available here", false);
      return;
    }
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
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("camera capture not available here", false);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
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
    if (
      name === "NotAllowedError" || name === "PermissionDeniedError" ||
      name === "SecurityError"
    ) {
      setStatus(
        `${kind} permission denied — that's fine, attach a file instead`,
        false,
      );
    } else if (name === "NotFoundError") {
      setStatus(
        `${kind} not found — no ${
          kind === "audio" ? "microphone" : "camera"
        } device available`,
        false,
      );
    } else {
      setStatus(`${kind} capture error: ${String(err?.message ?? err)}`, false);
    }
    plusBtn.focus();
  }

  // ── the + menu: add tab / add window / screenshot / screen recording ────
  // (items 18 + 19). These use the OPTIONAL browser capabilities; a missing
  // permission surfaces a clear status instead of a silent no-op.
  async function addTab() {
    try {
      if (!chrome.tabs?.create) throw new Error("tabs API unavailable");
      await chrome.tabs.create({});
      setStatus("opened a new tab");
    } catch (err) {
      setStatus("couldn't open a tab: " + String(err?.message ?? err), false);
    }
  }
  async function addWindow() {
    try {
      if (!chrome.windows?.create) throw new Error("windows API unavailable");
      await chrome.windows.create({});
      setStatus("opened a new window");
    } catch (err) {
      setStatus("couldn't open a window: " + String(err?.message ?? err), false);
    }
  }
  async function grabScreenshot() {
    try {
      if (!chrome.tabs?.captureVisibleTab) throw new Error("captureVisibleTab unavailable");
      const dataURL = await chrome.tabs.captureVisibleTab(null, { format: "png" });
      attachments.push({
        name: `screenshot-${Date.now()}.png`,
        kind: "image",
        size: Math.round((dataURL.length * 3) / 4),
        type: "image/png",
        dataURL,
      });
      addAttachTag("Screenshot", "camera");
      setStatus("attached a screenshot");
      plusBtn.focus();
    } catch (err) {
      setStatus("couldn't grab a screenshot: " + String(err?.message ?? err), false);
      plusBtn.focus();
    }
  }
  async function startScreenCapture() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setStatus("screen recording not available here", false);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
    } catch (err) {
      handleCaptureError("screen", err);
      return;
    }
    // Record the screen to a webm video and attach it on stop.
    const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
      stream.getTracks().forEach((t) => t.stop());
      finishCapture(blob, "video", `screen-${Date.now()}.webm`);
    };
    // The browser's share UI shows a "Stop sharing" control; the recorder stops
    // when the user ends the share (the track ends).
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (recorder.state !== "inactive") recorder.stop();
    });
    recorder.start();
    setStatus("recording screen — end the share to attach the video");
  }
  function stopCapRecording() {
    if (capRecorder && capRecorder.state !== "inactive") {
      try {
        capRecorder.stop();
      } catch { /* ignore */ }
    }
    capRecorder = null;
    capRecording = false;
    if (capTimerId) clearInterval(capTimerId);
    capTimerId = null;
    setActionIcon(
      capAction,
      capMode === "camera" ? "camera" : "record",
      capMode === "camera" ? "Capture photo" : "Record",
    );
  }
  async function finishCapture(blob, kind, name) {
    let dataURL = "";
    try {
      dataURL = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      });
    } catch { /* non-fatal */ }
    attachments.push({ name, kind, size: blob.size, type: blob.type, dataURL });
    addAttachTag(name, kind === "audio" ? "audio" : "camera");
    setStatus(`attached ${name}`);
    capClosePanel();
  }
  function capClosePanel() {
    stopCapRecording();
    if (capStream) {
      capStream.getTracks().forEach((t) => t.stop());
      capStream = null;
    }
    stopMeter();
    capture.hidden = true;
    capVideo.srcObject = null;
    plusBtn.focus();
  }
  capClose.addEventListener("click", capClosePanel);

  capAction.addEventListener("click", async () => {
    if (capMode === "camera") {
      if (capRecording) {
        stopCapRecording();
        return;
      }
      try {
        const w = capVideo.videoWidth, h = capVideo.videoHeight;
        if (!w || !h) {
          setStatus("camera not ready yet", false);
          return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(capVideo, 0, 0, w, h);
        const blob = await new Promise((res) =>
          canvas.toBlob(res, "image/jpeg", 0.9)
        );
        if (!blob) {
          setStatus("capture failed", false);
          return;
        }
        finishCapture(blob, "image", `photo-${Date.now()}.jpg`);
      } catch (err) {
        setStatus("camera capture error: " + String(err?.message ?? err), false);
      }
      return;
    }
    if (!capRecording) {
      if (!capStream) return;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      try {
        capRecorder = new MediaRecorder(capStream, { mimeType: mime });
      } catch {
        capRecorder = new MediaRecorder(capStream);
      }
      capChunks = [];
      capRecorder.ondataavailable = (e) => {
        if (e.data.size) capChunks.push(e.data);
      };
      capRecorder.onstop = () => {
        const mime = capRecorder
          ? (capRecorder.mimeType || "audio/webm")
          : "audio/webm";
        const blob = new Blob(capChunks, { type: mime });
        finishCapture(blob, "audio", `recording-${Date.now()}.webm`);
      };
      capRecorder.start();
      capRecording = true;
      capStartedAt = Date.now();
      capTimerId = setInterval(() => {
        capTimer.textContent = capElapsed();
      }, 500);
      capAction.textContent = "■ Stop";
      capNote.textContent = "recording…";
    } else {
      stopCapRecording();
      capNote.textContent = "processing…";
    }
  });

  // ── send ───────────────────────────────────────────────────────────────
  function doSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    const pending = attachments.splice(0);
    clearAttachTags();
    Promise.resolve(onSend(text, pending)).catch((err) => {
      setStatus("error: " + String(err?.message ?? err), false);
    });
  }
  send.addEventListener("click", doSend);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  });

  return api;
}
