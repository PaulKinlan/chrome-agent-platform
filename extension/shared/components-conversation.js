// shared/components-conversation.js — Conversation and composer elements.

import { t } from "./i18n.js";
import { cachedRpc } from "./rpc-cache.js";
import {
  canonicalRef,
  candidatesFromGroups,
  filterGroups,
  findAgentByRef,
  flattenGroups,
  selectionFromAgentCandidate,
  shouldApplyRegistrySnapshot,
} from "./agent-registry.js";
import { harnessMarkKey, harnessMonogram } from "./harness-marks.js";
import { parseMentionToken, parseSlashCommand } from "./command-parser.js";
import { skillMatchesUrl } from "./match-patterns.js";
import {
  artifactCardTitle,
  artifactIdentityFromPayloads,
  isScrolledToBottom,
  turnTime,
  stripModelAddressedText,
  isToolResultDeclined,
} from "./thread-view.js";
import {
  ATTACH_MENU_ICONS,
  COMMAND_INSERTION_DISCLOSURE,
  COMMAND_NAMESPACES as ALL_COMMAND_NAMESPACES,
  loadComposerCommandItems,
  resolveComposerCommandSelection,
  harnessCommandItems,
} from "./composer-commands.js";
import { normalizeConversationRunStatus } from "./run-status.js";
import { emptyPlan, reducePlan, planSummary, isPlanStepStatus } from "./plan-strip.js";
import {
  safeParseOnce,
  buildTree,
  subtreeJson,
  safeJsonStringify,
  prettyJson,
  tokenizeJson,
  PRETTY_JSON_TOKENISE_MAX_CHARS,
} from "./tool-tree.js";
import { redactSecrets, redactToolArgs } from "../lib/pure.js";
import { describeToolCall, redactToolResult, toolResultErrorText } from "../lib/tool-summary.js";
import { SITE_AGENT_COPY, siteOfferHost, siteOfferLabel, siteUsingLabel } from "./site-agent-copy.js";
import { permissionUserLanguage, siteLabel, humanToolLabel } from "../lib/permission-language.js";
export { humanToolLabel };
import { isTextLikeAttachment, textToDataUrl } from "../lib/attachments.js";
import { readClipboardOnGesture } from "../lib/clipboard-tools.js";

import {
  Component,
  mountTemplate,
  ICONS,
  escapeHtml,
  timeAgo,
  renderMarkdown,
  parseJSONAttr,
  supportsAnchorPositioning,
  placeFloating,
  normalizeSiteActivity,
  currentFramePreference,
  RUNTIME_SEND,
  getRuntimeSend,
  siteActivityAttribute,
  visibleSiteActivityLabel,
  SITE_ACTIVITY_FOCUS_KEY,
  isHtmlDocument,
  renderHtmlFrame,
  renderInline,
  adoptOrInjectStyle,
  toolResultSignalsError,
  prefersReducedMotion,
} from "./components-core.js";

const ARIA_HIDDEN = "aria-hidden";
const TRUE = ""; // boolean-attribute present marker

/* ──────────────────────────────────────────────────────────────────────────
 * Command + mention registry (the / palette + @ mentions in the composer).
 * Self-contained (no imports) so the docs showcase loads the same file.
 * The data-driven sources go through chrome.runtime when present and degrade
 * to empty lists in the plain showcase (no extension backend).
 * ────────────────────────────────────────────────────────────────────────── */
function shortOrigin(o) {
  return String(o).replace(/^https?:\/\//, "").replace(/\/.*/, "");
}

// Local files are progressive enhancement: browsers without
// showDirectoryPicker never offer a command they cannot fulfil.
export function supportsLocalFilesCommand(scope = globalThis) {
  return typeof scope?.showDirectoryPicker === "function";
}
// Sub-items for the / palette come from the DOM-free, dependency-injected
// command module; the live component supplies the extension runtime + Chrome.
async function commandItems(ns, arg = "") {
  const send = getRuntimeSend() ?? RUNTIME_SEND;
  return await loadComposerCommandItems(ns, arg, {
    runtimeSend: send,
    chromeApi: typeof chrome === "undefined" ? undefined : chrome,
  });
}

// @ mention candidates: every CALLABLE agent comes from the same redacted,
// grouped `agent.registry` authority as <agent-picker> and /agent. This keeps
// named/background/site filtering, canonical refs, current-agent exclusion and
// stale-selection behavior identical across all three entry points. Skills and
// recent artifacts remain mentionable, but only agent rows select a run target.
async function mentionCandidates(q = "", currentAgentId = null, currentAgentKind = null) {
  const ql = (q || "").toLowerCase();
  const items = [];
  const hit = (s) => !ql || String(s ?? "").toLowerCase().includes(ql);
  // Origin-bound skills (CAP-FB-20260830-SITE-PLAYBOOKS-01) are offered only
  // when the active tab matches — the same soft filter as the /skill: palette.
  let activeUrl = "";
  try {
    const tabs = await chrome?.tabs?.query?.({ active: true, currentWindow: true }) ?? [];
    activeUrl = String(tabs?.[0]?.url ?? "");
  } catch { activeUrl = ""; }
  if (RUNTIME_SEND) {
    const [registry, skills, assets] = await Promise.all([
      RUNTIME_SEND("agent.registry").catch(() => ({ groups: [] })),
      RUNTIME_SEND("skill.list").catch(() => ({ skills: [] })),
      RUNTIME_SEND("asset.list", { origin: "all" }).catch(() => ({ assets: [] })),
    ]);
    const excludeRef = currentAgentId && currentAgentKind
      ? canonicalRef(currentAgentKind, currentAgentId)
      : null;
    const agents = candidatesFromGroups(registry.groups || [], {
      query: q,
      callableOnly: true,
      excludeRef,
      excludeId: currentAgentId,
    });
    for (const a of agents) {
      items.push({ ...a, id: a.mentionText, name: a.label });
    }
    for (const s of (skills.skills || [])) {
      if (!hit(s.name) && !hit(s.id)) continue;
      if (Array.isArray(s.origins) && s.origins.length > 0 && !skillMatchesUrl(s, activeUrl)) continue;
      items.push({ id: `skill:${s.refId ?? s.id}`, label: s.name, description: s.description || "skill", kind: "skill", group: "Skills" });
    }
    for (const a of assets.assets || []) {
      if (!hit(a.name) && !hit(a.id)) continue;
      items.push({ id: `artifact:${a.id ?? a.name}`, label: a.name, description: a.type || "artifact", kind: "artifact", group: "Artifacts" });
    }
  }
  return items;
}

// A shared base that renders a Shadow-DOM template + a scoped <style> once.

// /files is progressive enhancement — absent where showDirectoryPicker is missing.
export const COMMAND_NAMESPACES = ALL_COMMAND_NAMESPACES.filter(
  (n) => !n.localFiles || supportsLocalFilesCommand(),
);
export class MicButton extends Component {
  static get observedAttributes() { return ["listening", "label"]; }
  constructor() {
    super();
    this._recognition = null;
    this._listening = false;
    this._mediaStream = null;
    this._noSpeech = 0;
    this._audioCtx = null;
    this._analyser = null;
    this._raf = 0;
    this._restartTimes = [];
    this._audioDevices = [];
    this._devices = [];
    this._selectedDeviceId = null;
    this._labelsRequested = false;
    this._deviceMenuOpen = false;
    this._previewStream = null;
    this._previewCtx = null;
    this._previewRaf = 0;
    this._previewTimer = 0;
    this._previewGen = 0;
    this._deviceRows = new Map();
    this._enumeratedAfterGrant = false;
    this._meterRequestGen = 0;
    // Start-generation counter: every start() attempt bumps it; stop() and
    // disconnectedCallback() bump it too. A start whose getUserMedia resolves
    // AFTER its generation was superseded releases the late stream and exits
    // — no recording the owner already cancelled, no orphaned mic tracks.
    this._startGen = 0;
    // KAT/owner-visible honesty: "live" (real level meter) | "fallback" (CSS
    // animation, no mic stream) | null (not recording).
    this.waveformMode = null;
  }
  _render() {
    const listening = this.hasAttribute("listening");
    const idleLabel = this.getAttribute("label") || "Start listening";
    const label = listening ? "Stop listening" : idleLabel;
    mountTemplate(this, `
      :host { position:relative; display:inline-flex; align-items:center; }
      .mic { display:inline-flex; align-items:center; justify-content:center; width:var(--control,36px);
        height:var(--control,36px); background:transparent;
        border:1px solid var(--border, #333); color:var(--text, #eee); border-radius:var(--radius-sm,6px);
        padding:0; cursor:pointer; font:inherit; line-height:1; position:relative; }
      .mic .icon { display:inline-flex; align-items:center; justify-content:center; }
      .mic svg { display:block; }
      .mic[data-listening] { color:var(--accent, #0e6e63); border-color:var(--accent, #0e6e63); }
      .mic:focus-visible { outline:2px solid var(--accent, #0e6e63); outline-offset:2px; }
      .wave { display:none; align-items:center; gap:2px; height:16px; }
      .mic[data-listening] .icon { display:none; }
      .mic[data-listening] .wave { display:inline-flex; }
      .wave span { width:3px; background:currentColor; border-radius:2px; animation:sc-wave 1s ease-in-out infinite;
        transform-origin:center; }
      .wave span:nth-child(1){height:6px;animation-delay:0s}.wave span:nth-child(2){height:12px;animation-delay:.15s}
      .wave span:nth-child(3){height:16px;animation-delay:.3s}.wave span:nth-child(4){height:10px;animation-delay:.45s}
      .wave span:nth-child(5){height:7px;animation-delay:.6s}
      /* live level meter: bars are driven inline by the AnalyserNode — no CSS
         animation (it would fight the per-frame transform). */
      .wave.live span { animation:none; }
      @keyframes sc-wave { 0%,100%{transform:scaleY(.5)} 50%{transform:scaleY(1)} }
      /* hover-while-recording → the wave becomes a STOP affordance */
      .stop-ic { display:none; align-items:center; justify-content:center; }
      .mic[data-listening]:hover .wave { display:none; }
      .mic[data-listening]:hover .stop-ic { display:inline-flex; }
      .device-picker { display:inline-flex; align-items:center; justify-content:center; width:20px; height:var(--control,36px);
        margin-inline-start:2px; padding:0; border:0; border-radius:var(--radius-sm,6px); background:transparent;
        color:var(--muted,#635e56); cursor:pointer; anchor-name:--mic-device-anchor; }
      .device-picker:hover { color:var(--text,#1d1b18); background:var(--bg,#f7f6f3); }
      .device-picker:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .device-menu { position:absolute; inset:auto; margin:0; min-width:min(340px,calc(100vw - 24px)); max-width:380px;
        padding:8px; color:var(--text,#1d1b18); background:var(--panel,#fff); border:1px solid var(--border,#e3e0d9);
        border-radius:var(--radius-md,12px); box-shadow:0 8px 24px rgba(0,0,0,.25); z-index:20;
        position-anchor:--mic-device-anchor; position-area:block-start span-inline-start;
        position-try-fallbacks:flip-block,flip-inline; }
      @supports not (position-area:top) { .device-menu { position:fixed; } }
      .device-menu[hidden] { display:none; }
      .device-title { margin:2px 6px 6px; font-size:13px; font-weight:600; }
      .device-row { padding:2px; border-radius:var(--radius-sm,6px); }
      .device-option { display:flex; align-items:center; gap:8px; width:100%; min-height:40px; padding:7px 8px;
        border:0; border-radius:var(--radius-sm,6px); background:transparent; color:inherit; font:inherit; text-align:start; cursor:pointer; }
      .device-option:hover,.device-option:focus-visible { background:var(--bg,#f7f6f3); outline:none; }
      .device-option[aria-pressed="true"] { color:var(--accent,#0e6e63); font-weight:600; }
      .device-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .device-check { display:inline-flex; width:16px; }
      .device-level { display:block; width:calc(100% - 16px); height:4px; margin:0 8px 4px; accent-color:var(--accent,#0e6e63); }
      .device-level:not([data-active]) { visibility:hidden; }
      .device-status { min-height:16px; margin:0 8px 4px; color:var(--muted,#635e56); font-size:12px; }
      .device-note { margin:8px 6px 2px; max-width:36ch; color:var(--muted,#635e56); font-size:12px; line-height:1.4; }
      @media (prefers-reduced-motion: reduce) { .wave span { animation:none; } }
    `, `<button part="button" class="mic" type="button" aria-label="${escapeHtml(label)}"
      aria-pressed="${listening}"${listening ? " data-listening" : ""}><span class="icon">${ICONS.mic}</span><span class="wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span><span class="stop-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></span></button>`);
    this._button = this._root.querySelector(".mic");
  }
  _wire() {
    this._button?.addEventListener("click", () => this.toggle());
    this._syncDeviceUi();
  }
  get listening() { return this._listening; }
  toggle() {
    this._listening ? this.stop() : this.start();
  }
  _stopIfHidden() {
    if (this._button && this._button.offsetParent === null) {
      // Invalidate UNCONDITIONALLY: while getUserMedia is pending _listening is
      // still false, and stop() alone would leave the start's generation valid
      // — the late stream would be adopted the moment the composer re-shows.
      this._startGen++;
      if (!this._listening) return;
      this._emit("mic-error", { message: "recording stopped — the composer was hidden" });
      this.stop();
    }
  }
  connectedCallback() {
    super.connectedCallback?.();
    // Hidden ≠ disconnected: the NTP switches views by display:none-ing the hub
    // (body.view-open main.content), leaving the composer CONNECTED and a
    // recording mic live in the background (the owner's "it's just a mess"
    // bug). IntersectionObserver covers most visibility transitions BUT does
    // not reliably deliver when an ancestor goes display:none — so a
    // MutationObserver on body attributes (the view-switch mechanism) runs the
    // same check. offsetParent===null distinguishes display:none (stop) from
    // merely scrolled-off (keep dictating).
    this._visObserver = new IntersectionObserver(() => this._stopIfHidden());
    this._visObserver.observe(this);
    this._mutObserver = new MutationObserver(() => this._stopIfHidden());
    this._mutObserver.observe(document.body, {
      attributes: true, attributeFilter: ["class", "hidden", "style"], subtree: true,
    });
    this._onPageHide = () => {
      // Pagehide while getUserMedia is PENDING: _listening is still false, so
      // "stop only when listening" leaves the in-flight start valid and the
      // late stream becomes a background recording after the page hides.
      // Invalidate the generation first, unconditionally.
      this._startGen++;
      if (this._listening) this.stop();
    };
    window.addEventListener("pagehide", this._onPageHide);
    this._onDeviceChange = () => void this._refreshDevices(true);
    navigator.mediaDevices?.addEventListener?.("devicechange", this._onDeviceChange);
    void this._loadDevices();
  }
  async _loadDevices() {
    try {
      const stored = await chrome.storage?.local?.get(MIC_METER_DEVICE_KEY);
      this._selectedDeviceId = stored?.[MIC_METER_DEVICE_KEY] || null;
    } catch { /* storage is optional; selection remains session-only */ }
    await this._refreshDevices(false);
  }
  async _persistSelectedDevice() {
    if (!this._selectedDeviceId) return;
    try {
      await chrome.storage?.local?.set({ [MIC_METER_DEVICE_KEY]: this._selectedDeviceId });
    } catch { /* storage is optional; the current session still uses it */ }
  }
  _deviceName(deviceId) {
    if (!deviceId) return "automatic meter input";
    const device = this._audioDevices.find((d) => d.deviceId === deviceId);
    const index = this._devices.findIndex((d) => d.deviceId === deviceId);
    return device?.label || (index >= 0 ? `Microphone ${index + 1}` : "selected meter microphone");
  }
  _defaultDeviceName() {
    const device = this._audioDevices.find((d) => d.deviceId === "default");
    return device?.label || "OS default microphone";
  }
  _deviceDiagnostic() {
    return `Speech recognition uses ${this._defaultDeviceName()}. The level meter uses ${this._deviceName(this._selectedDeviceId)}. Open macOS System Settings, then Sound → Input to change the default input.`;
  }
  async _refreshDevices(fromDeviceChange = false) {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    let audioDevices;
    try {
      audioDevices = (await md.enumerateDevices()).filter((d) => d.kind === "audioinput");
    } catch {
      return;
    }
    const previous = this._selectedDeviceId;
    this._audioDevices = audioDevices;
    // `default` and `communications` are aliases, not extra physical mics.
    // Excluding them is what keeps the picker off single-mic machines.
    const concrete = audioDevices.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications");
    const seen = new Set();
    this._devices = concrete.filter((d) => {
      const identity = d.groupId || d.deviceId;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
    if (!this._devices.some((d) => d.deviceId === this._selectedDeviceId)) {
      const defaultDevice = audioDevices.find((d) => d.deviceId === "default");
      const matchingDefault = defaultDevice?.groupId && this._devices.find((d) => d.groupId === defaultDevice.groupId);
      this._selectedDeviceId = (matchingDefault || this._devices[0])?.deviceId || null;
      if (this._selectedDeviceId) void this._persistSelectedDevice();
      if (fromDeviceChange && previous) {
        this._stopPreview();
        const next = this._selectedDeviceId ? this._deviceName(this._selectedDeviceId) : "no available microphone";
        this._emit("mic-error", { message: `Selected level-meter microphone disconnected — using ${next}. Speech transcription still follows the OS default input; open macOS System Settings, then Sound → Input.` });
        if (this._listening) {
          this._stopMeter();
          this._startMeter();
          this._requestAndAdoptMeter(this._startGen);
        }
      }
    }
    this._syncDeviceUi();
  }
  _syncDeviceUi() {
    const oldTrigger = this._root.querySelector?.(".device-picker");
    const oldMenu = this._root.querySelector?.(".device-menu");
    oldTrigger?.remove();
    oldMenu?.remove();
    this._deviceRows = new Map();
    if (this._devices.length < 2 || !this._root.append) {
      this._deviceMenuOpen = false;
      return;
    }

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "device-picker";
    trigger.setAttribute("aria-label", "Choose microphone for live level check");
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", String(this._deviceMenuOpen));
    trigger.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';

    const menu = document.createElement("div");
    menu.className = "device-menu";
    menu.setAttribute("popover", "auto");
    menu.setAttribute("role", "dialog");
    menu.setAttribute("aria-label", "Microphone devices");
    menu.hidden = true;
    const title = document.createElement("p");
    title.className = "device-title";
    title.textContent = "Check microphone level";
    menu.append(title);
    this._devices.forEach((device, index) => {
      const row = document.createElement("div");
      row.className = "device-row";
      const option = document.createElement("button");
      option.type = "button";
      option.className = "device-option";
      option.dataset.deviceId = device.deviceId;
      option.setAttribute("aria-pressed", String(device.deviceId === this._selectedDeviceId));
      const name = document.createElement("span");
      name.className = "device-name";
      name.textContent = device.label || `Microphone ${index + 1}`;
      const check = document.createElement("span");
      check.className = "device-check";
      check.setAttribute("aria-hidden", "true");
      if (device.deviceId === this._selectedDeviceId) check.innerHTML = ICONS.check;
      option.append(name, check);
      const level = document.createElement("progress");
      level.className = "device-level";
      level.max = 1;
      level.value = 0;
      level.setAttribute("aria-label", `Live input level for ${name.textContent}`);
      const status = document.createElement("p");
      status.className = "device-status";
      status.setAttribute("role", "status");
      row.append(option, level, status);
      menu.append(row);
      this._deviceRows.set(device.deviceId, { level, status });
    });
    const note = document.createElement("p");
    note.className = "device-note";
    note.textContent = "This selection checks and drives only the live level meter. Speech transcription always uses the OS default input. Change it in macOS System Settings under Sound → Input.";
    menu.append(note);
    this._root.append(trigger, menu);
    this._deviceTrigger = trigger;
    this._deviceMenu = menu;
    trigger.addEventListener("click", () => void this._toggleDeviceMenu(!this._deviceMenuOpen));
    menu.addEventListener("toggle", (event) => {
      this._deviceMenuOpen = event.newState === "open";
      trigger.setAttribute("aria-expanded", String(this._deviceMenuOpen));
      if (!this._deviceMenuOpen && this._deviceMenu === menu) this._stopPreview();
    });
    menu.addEventListener("click", (event) => {
      const option = event.target.closest?.("button[data-device-id]");
      if (option) void this._selectDevice(option.dataset.deviceId);
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void this._toggleDeviceMenu(false);
        trigger.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const options = [...menu.querySelectorAll("button[data-device-id]")];
      const index = options.indexOf(this._root?.activeElement || document.activeElement);
      event.preventDefault();
      options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
    });
    if (this._deviceMenuOpen) queueMicrotask(() => void this._toggleDeviceMenu(true, false));
  }
  async _toggleDeviceMenu(open, requestLabels = true) {
    if (!this._deviceMenu || !this._deviceTrigger) return;
    if (!open) {
      this._stopPreview();
      try { this._deviceMenu.hidePopover?.(); } catch { /* already closed */ }
      this._deviceMenu.hidden = true;
      this._deviceMenuOpen = false;
      this._deviceTrigger.setAttribute("aria-expanded", "false");
      return;
    }
    if (!supportsAnchorPositioning()) placeFloating(this._deviceTrigger, this._deviceMenu, { minWidth: 340 });
    this._deviceMenu.hidden = false;
    try { this._deviceMenu.showPopover?.(); } catch { /* already open */ }
    this._deviceMenuOpen = true;
    this._deviceTrigger.setAttribute("aria-expanded", "true");
    this._deviceMenu.querySelector("button[data-device-id]")?.focus();
    if (requestLabels) await this._grantDeviceLabels();
  }
  async _grantDeviceLabels() {
    if (this._labelsRequested) return;
    this._labelsRequested = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      this._refreshDevicesAfterGrant();
    } catch {
      this._emit("mic-error", { message: "Microphone access was not granted, so device names and live checks may be unavailable. Speech transcription still follows the OS default input." });
    }
  }
  _refreshDevicesAfterGrant() {
    if (this._enumeratedAfterGrant) return;
    this._enumeratedAfterGrant = true;
    this._labelsRequested = true;
    // Before permission Chrome may expose only an unlabeled `default` alias.
    // Re-enumerate exactly once after the first successful capture, when the
    // physical inputs and their labels become available.
    void this._refreshDevices(false);
  }
  async _selectDevice(deviceId) {
    if (!this._devices.some((d) => d.deviceId === deviceId)) return;
    this._selectedDeviceId = deviceId;
    await this._persistSelectedDevice();
    this._syncDeviceUi();
    if (this._listening) {
      this._stopMeter();
      this._startMeter();
      this._requestAndAdoptMeter(this._startGen);
    }
    await this._previewDevice(deviceId);
  }
  _setPreviewStatus(deviceId, message, level = null) {
    const row = this._deviceRows.get(deviceId);
    if (!row) return;
    row.status.textContent = message;
    if (level == null) {
      row.level.removeAttribute("data-active");
      row.level.value = 0;
    } else {
      row.level.setAttribute("data-active", "");
      row.level.value = level;
    }
  }
  _releasePreview() {
    if (this._previewTimer) { clearTimeout(this._previewTimer); this._previewTimer = 0; }
    if (this._previewRaf) { cancelAnimationFrame(this._previewRaf); this._previewRaf = 0; }
    if (this._previewCtx) { try { this._previewCtx.close(); } catch { /* ignore */ } this._previewCtx = null; }
    if (this._previewStream) {
      try { this._previewStream.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
      this._previewStream = null;
    }
  }
  _stopPreview() {
    this._previewGen++;
    this._releasePreview();
  }
  async _previewDevice(deviceId) {
    const gen = ++this._previewGen;
    this._releasePreview();
    const name = this._deviceName(deviceId);
    this._setPreviewStatus(deviceId, `Checking ${name} — speak now`, 0);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    } catch {
      if (gen === this._previewGen) this._setPreviewStatus(deviceId, `No live level from ${name}. Check access, connection, and mute state.`);
      return;
    }
    if (gen !== this._previewGen) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    let ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error("AudioContext unavailable");
      ctx = new AC();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      this._previewStream = stream;
      this._previewCtx = ctx;
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (gen !== this._previewGen) return;
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
        const level = Math.min(1, peak * 2.5);
        this._setPreviewStatus(deviceId, `Live level from ${name}: ${Math.round(level * 100)}%`, level);
        this._previewRaf = requestAnimationFrame(tick);
      };
      this._previewRaf = requestAnimationFrame(tick);
      this._previewTimer = setTimeout(() => {
        if (gen !== this._previewGen) return;
        this._releasePreview();
        this._setPreviewStatus(deviceId, `Live check finished for ${name}`);
      }, 4000);
    } catch {
      try { ctx?.close(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
      if (gen === this._previewGen) this._setPreviewStatus(deviceId, `Live level unavailable for ${name}`);
    }
  }
  _setWaveformMode(mode, description) {
    this.waveformMode = mode;
    if (!this._button) return;
    if (description) {
      this._button.title = description;
      this._button.setAttribute?.("aria-description", description);
    } else {
      this._button.removeAttribute?.("title");
      this._button.removeAttribute?.("aria-description");
    }
  }
  /** Request a stream for the decorative level meter. SpeechRecognition owns
   *  its own audio capture and must never wait for this promise: on macOS the
   *  getUserMedia permission prompt can reject or remain pending indefinitely.
   *  Returns true (no mediaDevices API), false (meter unavailable), or the
   *  MediaStream. The caller captures the selected device identity before this
   *  async request starts, so a later selection cannot rewrite its meaning. */
  async _requestMicStream(deviceId) {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return true; // no API — let SpeechRecognition try
    try {
      // The stream stays OPEN for the recording's lifetime: it doubles as the
      // AnalyserNode source for the live waveform. Tracks are stopped in
      // _stopMeter (called from stop()/disconnectedCallback) — the mic is
      // never left open after the state reverts.
      const audio = deviceId
        ? { deviceId: { exact: deviceId } }
        : true;
      return await md.getUserMedia({ audio });
    } catch {
      return false;
    }
  }
  _requestAndAdoptMeter(startGen) {
    const meterGen = ++this._meterRequestGen;
    const deviceId = this._selectedDeviceId;
    void this._adoptMeterStream(startGen, meterGen, deviceId, this._requestMicStream(deviceId));
  }
  async _adoptMeterStream(startGen, meterGen, deviceId, streamPromise) {
    const stream = await streamPromise;
    const stopTracks = (s) => {
      if (s && s !== true) { try { s.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ } }
    };
    if (startGen !== this._startGen || meterGen !== this._meterRequestGen ||
        deviceId !== this._selectedDeviceId || !this._listening) {
      stopTracks(stream);
      return;
    }
    if (stream === false) {
      this._setWaveformMode("fallback", "Recording. Live microphone level is unavailable; the waveform is a recording-state animation, not a live meter.");
      this._emit("mic-error", { message: "live microphone waveform unavailable — dictation continues with a non-live recording animation" });
      return;
    }
    if (stream === true) {
      this._setWaveformMode("fallback", "Recording. This browser cannot provide a live microphone level; the waveform is a recording-state animation.");
      return;
    }
    // The composer may hide while the meter permission prompt is pending.
    // Recognition has already started, so stop the PRIMARY capture too.
    if (this._button && this._button.offsetParent === null) {
      stopTracks(stream);
      this._emit("mic-error", { message: "recording stopped — the composer was hidden" });
      this.stop();
      return;
    }
    this._refreshDevicesAfterGrant();
    if (this._mediaStream && this._mediaStream !== stream) stopTracks(this._mediaStream);
    this._mediaStream = stream;
    this._startMeter();
  }
  /** Drive the wave bars from the real mic level. Falls back to the CSS
   *  animation (honest "recording", not a fake meter) when AudioContext or
   *  the stream is unavailable, and under prefers-reduced-motion (static bars,
   *  no per-frame visual churn). */
  _startMeter() {
    const wave = this._root.querySelector(".wave");
    const bars = wave ? [...wave.querySelectorAll("span")] : [];
    if (!this._mediaStream || !bars.length) {
      this._setWaveformMode("fallback", "Recording. Waiting for a live microphone level; the waveform is a recording-state animation.");
      return;
    }
    if (prefersReducedMotion()) {
      this._setWaveformMode("fallback", "Recording. The waveform is static because reduced motion is enabled.");
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        this._setWaveformMode("fallback", "Recording. Live microphone level is unavailable; the waveform is a recording-state animation, not a live meter.");
        this._emit("mic-error", { message: "live microphone waveform unavailable — dictation continues with a non-live recording animation" });
        return;
      }
      const ctx = new AC();
      let analyser;
      try {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(this._mediaStream).connect(analyser);
        this._audioCtx = ctx;
        this._analyser = analyser;
      } catch (meterErr) {
        // createAnalyser/createMediaStreamSource can throw AFTER the context
        // exists — close the half-built context or it leaks (the outer catch
        // only sees the fallback selection, never this local).
        try { ctx.close(); } catch { /* ignore */ }
        throw meterErr;
      }
      this._setWaveformMode("live", `Recording. Waveform shows the live level from ${this._deviceName(this._selectedDeviceId)}; speech transcription still uses the OS default input.`);
      wave.classList.add("live");
      const data = new Uint8Array(analyser.fftSize);
      const heights = [6, 12, 16, 10, 7]; // the idle bar geometry
      const tick = () => {
        if (this.waveformMode !== "live") return;
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        const level = Math.min(1, peak * 2.5); // speech peaks sit well under 1
        bars.forEach((b, i) => {
          b.style.transform = `scaleY(${0.3 + level * (heights[i] / 6)})`;
        });
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    } catch {
      this._setWaveformMode("fallback", "Recording. Live microphone level is unavailable; the waveform is a recording-state animation, not a live meter.");
      this._emit("mic-error", { message: "live microphone waveform unavailable — dictation continues with a non-live recording animation" });
    }
  }
  _stopMeter() {
    this._meterRequestGen++; // invalidate every unresolved meter acquisition
    this._setWaveformMode(null, "");
    const wave = this._root.querySelector?.(".wave");
    wave?.classList.remove?.("live");
    wave?.querySelectorAll("span").forEach((bar) => { bar.style.transform = ""; });
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    if (this._audioCtx) {
      try { this._audioCtx.close(); } catch { /* ignore */ }
      this._audioCtx = null;
      this._analyser = null;
    }
    if (this._mediaStream) {
      try { this._mediaStream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      this._mediaStream = null;
    }
  }
  async start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this._emit("mic-error", { message: "speech recognition not available in this browser" });
      return;
    }
    // Never prompt or start capture for a composer that is already hidden.
    if (this._button && this._button.offsetParent === null) {
      this._emit("mic-error", { message: "recording stopped — the composer was hidden" });
      return;
    }
    const gen = ++this._startGen;
    if (!this._recognition) {
      this._recognition = new SR();
      this._recognition.continuous = true;
      this._recognition.interimResults = true;
      this._recognition.lang = "en-US";
      this._recognition.onresult = (e) => {
        this._noSpeech = 0;
        // Accumulate the FULL transcript (committed finals + interim) across the
        // cumulative result list, NOT just the new chunk — otherwise every
        // event overwrites the input with only the latest word.
        let finalText = "";
        let interimText = "";
        for (let i = 0; i < e.results.length; i++) {
          const res = e.results[i];
          if (!res?.[0]) continue;
          if (res.isFinal) {
            // Separate committed utterances with a space — naive `+=` joined
            // "word1"+"word2" into "word1word2" across the recognition gap.
            finalText = finalText ? `${finalText} ${res[0].transcript}` : res[0].transcript;
          } else {
            interimText = interimText ? `${interimText} ${res[0].transcript}` : res[0].transcript;
          }
        }
        const text = (finalText + (finalText && interimText ? " " : "") + interimText).trim();
        this._emit("transcript", { text, final: !interimText });
      };
      this._recognition.onerror = (e) => {
        if (e.error === "aborted") return;
        // "no-speech" means the recognition is running but hearing nothing — the
        // exact "mic opens but no text" symptom. Surface it after a couple of
        // quiet rounds instead of staying silently open forever.
        if (e.error === "no-speech") {
          this._noSpeech += 1;
          if (this._noSpeech >= 3) {
            this._emit("mic-error", { message: `couldn't hear you. ${this._deviceDiagnostic()}` });
            this.stop();
          }
          return;
        }
        const msg =
          e.error === "not-allowed" || e.error === "service-not-allowed"
            ? "microphone permission denied"
            : e.error === "audio-capture"
            ? `Speech recognition could not capture audio. ${this._defaultDeviceName()} may be wrong, disconnected, muted, or dead. The level meter uses ${this._deviceName(this._selectedDeviceId)}. Open macOS System Settings, then Sound → Input to change the default input.`
            : e.error === "network"
            ? "speech service unavailable (network)"
            : "speech error: " + e.error;
        this._emit("mic-error", { message: msg });
        this.stop();
      };
      this._recognition.onend = () => {
        if (this._listening) {
          // Legit continuous dictation ends on silence and must restart — but a
          // start() that throws instantly every time is a STUCK recording state
          // (the wave keeps pulsing, no text ever arrives). Cap the restart
          // STORM: >3 restarts inside 2s means recognition is dead — revert to
          // idle honestly instead of looping forever.
          const now = Date.now();
          this._restartTimes = this._restartTimes.filter((t) => now - t < 2000);
          if (this._restartTimes.length >= 3) {
            this._emit("mic-error", { message: "speech recognition keeps stopping — try again" });
            this.stop();
            return;
          }
          this._restartTimes.push(now);
          try { this._recognition.start(); } catch {
            this._emit("mic-error", { message: "speech recognition stopped unexpectedly" });
            this.stop();
          }
          return;
        }
      };
    }
    this._listening = true;
    this._noSpeech = 0;
    this._restartTimes = [];
    this.setAttribute("listening", TRUE);
    this._emit("mic-toggle", { listening: true });
    // Show the CSS fallback immediately. A late live stream upgrades it to an
    // AnalyserNode meter; failure leaves this honest recording affordance.
    this._startMeter();
    try {
      this._recognition.start();
    } catch (err) {
      this._emit("mic-error", { message: "could not start speech recognition: " + (err?.message || err) });
      this.stop();
      return;
    }
    // Recognition is primary and is already running. Kick the decorative
    // meter request off inside the same click gesture, but never await it.
    this._requestAndAdoptMeter(gen);
  }
  stop() {
    this._startGen++; // invalidate any in-flight start (send-while-pending)
    this._stopMeter();
    this._listening = false;
    this._noSpeech = 0;
    this.removeAttribute("listening");
    this._emit("mic-toggle", { listening: false });
    if (this._recognition) {
      try { this._recognition.stop(); } catch { /* ignore */ }
    }
  }
  disconnectedCallback() {
    // The wider-goal review's finding: the base disconnect handler removed only
    // document listeners, while `onend` restarted recognition whenever
    // `_listening` was true — so removing/re-rendering a listening mic kept the
    // microphone active. Tear down recognition + state on disconnect.
    if (this._visObserver) { this._visObserver.disconnect(); this._visObserver = null; }
    if (this._mutObserver) { this._mutObserver.disconnect(); this._mutObserver = null; }
    if (this._onPageHide) { window.removeEventListener("pagehide", this._onPageHide); this._onPageHide = null; }
    if (this._onDeviceChange) {
      navigator.mediaDevices?.removeEventListener?.("devicechange", this._onDeviceChange);
      this._onDeviceChange = null;
    }
    this._stopPreview();
    this._listening = false;
    this._startGen++; // invalidate any in-flight start (detach-while-pending)
    if (this._recognition) {
      try {
        this._recognition.onresult = null;
        this._recognition.onerror = null;
        this._recognition.onend = null;
        this._recognition.abort?.();
      } catch { /* ignore */ }
      this._recognition = null;
    }
    this._stopMeter();
    super.disconnectedCallback?.();
    // Drop the state attribute LAST: super sets _rendered=false first, so this
    // removal cannot trigger a re-render of the DETACHED element — but it
    // keeps a reattached mic from resurrecting a false recording affordance
    // (data-listening + aria-pressed=true) from the stale attribute while the
    // internal state is idle.
    this.removeAttribute("listening");
  }
}
customElements.define("mic-button", MicButton);


/* <attach-button label="Attach"> — the + button + menu (file / audio / camera) */
export class AttachButton extends Component {
  static get observedAttributes() { return ["label", "open"]; }
  constructor() { super(); this._fileInput = null; }
  _render() {
    const label = this.getAttribute("label") || "Add attachment";
    const open = this.hasAttribute("open");
    mountTemplate(this, `
      :host { position:relative; display:inline-flex; }
      .plus { display:inline-flex; align-items:center; justify-content:center; width:var(--control,36px);
        height:var(--control,36px); background:transparent;
        border:1px solid var(--border,#e3e0d9); color:var(--text,#1d1b18); border-radius:var(--radius-sm,6px);
        padding:0; cursor:pointer; font:inherit; line-height:1; anchor-name:--attach-anchor; }
      .plus svg { display:block; }
      /* CAP-FB-20260830-FOCUS-ORDER-VISIBILITY-01: the + attach button had NO
         focus ring (outline:none) — every focusable must show the shared accent
         ring. The ring check now enumerates shadow roots and caught it. */
      .plus:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      /* Item 52: the menu anchors to the + button and flips above/below it.
         block-start span-inline-end = place it above the button, aligned to the
         button's end edge; flip-block moves it BELOW when there is no room above
         (the + button sits at the bottom of the composer, so "above" is the
         common case, but a thread with a tall conversation must not push it
         off-screen). The popover is top-layer, so opening it never scrolls the
         main frame (the conversation scroll container is untouched). */
      .menu, .attach-menu { position:absolute; inset:auto; margin:0; background:var(--panel,#ffffff);
        border:none; border-radius:var(--radius-md,12px); box-shadow:var(--shadow-md, 0 8px 24px rgba(29,27,24,.08));
        padding:4px; min-width:200px; z-index:20;
        position-anchor:--attach-anchor; position-area:block-start span-inline-end;
        position-try-fallbacks:flip-block, flip-inline; }
      @supports not (position-area: top) {
        .menu, .attach-menu { position:fixed; bottom:auto; left:auto; }
      }
      .menu[hidden], .attach-menu[hidden] { display:none; }
      .menu button, .attach-menu button { display:flex; align-items:center; gap:8px; width:100%; text-align:left; background:transparent; border:0;
        color:var(--text,#1d1b18); padding:8px 12px; border-radius:var(--radius-sm,6px); cursor:pointer; font:inherit; }
      .menu button svg, .attach-menu button svg { flex:0 0 auto; display:block; color:var(--muted,#635e56); }
      .menu button:hover, .menu button:focus-visible, .attach-menu button:hover, .attach-menu button:focus-visible { background:var(--bg,#f7f6f3); outline:none; }
      .note { font-size:var(--text-xs,12px); color:var(--muted,#635e56); margin:6px 0 2px; max-width:220px; }
    `, `<button part="button" class="plus" type="button" aria-haspopup="menu"
        aria-expanded="${open}" aria-label="${escapeHtml(label)}">${ICONS.plus}</button>
      <div class="menu attach-menu" role="menu" aria-label="${escapeHtml(label)}" popover="manual"${open ? "" : " hidden"}>
        <button type="button" role="menuitem" data-kind="file">${ATTACH_MENU_ICONS["file"]}Add file</button>
        <button type="button" role="menuitem" data-kind="paste-clipboard">${ATTACH_MENU_ICONS["paste-clipboard"]}Paste from clipboard</button>
        <button type="button" role="menuitem" data-kind="record-audio">${ATTACH_MENU_ICONS["record-audio"]}Record audio</button>
        <button type="button" role="menuitem" data-kind="capture-camera">${ATTACH_MENU_ICONS["capture-camera"]}Capture camera</button>
        <button type="button" role="menuitem" data-kind="record-screen">${ATTACH_MENU_ICONS["record-screen"]}Record screen</button>
        <button type="button" role="menuitem" data-kind="grab-screenshot">${ATTACH_MENU_ICONS["grab-screenshot"]}Grab screenshot</button>
        <button type="button" role="menuitem" data-kind="capture-page">${ATTACH_MENU_ICONS["capture-page"]}Capture this page</button>
        <button type="button" role="menuitem" data-kind="add-tab">${ATTACH_MENU_ICONS["add-tab"]}Add tab</button>
        <p class="note">Text files are read by the agent. Audio, camera, and image attachments are sent to the model as data.</p>
      </div>`);
    this._btn = this._root.querySelector(".plus");
    this._menu = this._root.querySelector(".menu");
  }
  _wire() {
    this._btn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._toggle(this._menu.hidden);
    });
    this._menu?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); this._toggle(false); this._btn?.focus(); return; }
      const items = [...this._menu.querySelectorAll("button[role=menuitem]")];
      const idx = items.indexOf(this._root?.activeElement || document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        items[(idx + d + items.length) % items.length]?.focus();
      }
    });
    this._menu?.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-kind]");
      if (!b) return;
      this._toggle(false);
      const kind = b.dataset.kind;
      if (kind === "paste-clipboard") {
        this._emit("paste-clipboard");
        return;
      }
      if (kind === "record-audio" || kind === "capture-camera") {
        this._emit("attach-media", { kind });
        return;
      }
      if (kind === "choose-agent") {
        // Route this message to ONE agent (CAP-FB-20260818-AGENT-ACCESS-01):
        // the host composer opens the shared <agent-picker> anchored to the +
        // button; choosing sets a removable agent chip.
        this._emit("choose-agent");
        return;
      }
      if (kind === "record-screen" || kind === "grab-screenshot" ||
          kind === "capture-page" || kind === "add-tab") {
        // Browser-context actions (the + menu's screen-recording / screenshot /
        // capture-page / tab-picker options) — emitted for the host composer/page to wire
        this._emit("attach-context", { kind });
        return;
      }
      const file = await this._pickFile(kind);
      if (!file) return;
      // Honest refusal: an over-ceiling pick or a failed read is reported with
      // the real reason — never attached as a silent empty dataURL.
      if (file.overLimit) {
        const mib = Math.round(file.size / (1024 * 1024));
        this._emit("attach-error", { message: `${file.name} is ${mib} MiB — over the 32 MiB attach ceiling (the bytes travel to the model as base64 in a single message)` });
        return;
      }
      if (file.readError) {
        this._emit("attach-error", { message: `Couldn't read ${file.name}: ${file.readError}` });
        return;
      }
      this._emit("attach", file);
    });
    this._bindDocument("click", (e) => {
      if (this._menu && !this._menu.hidden && !this._menu.contains(e.target) && e.target !== this._btn) {
        this._toggle(false);
      }
    });
  }
  _toggle(open) {
    if (!this._menu) return;
    if (open) {
      if (!supportsAnchorPositioning()) placeFloating(this._btn, this._menu, { minWidth: 200 });
      this._menu.hidden = false;
      if (typeof this._menu.showPopover === "function") {
        try { this._menu.showPopover(); } catch { /* already shown */ }
      }
      // NOTE: do NOT setAttribute("open") — it triggers the base
      // attributeChangedCallback re-render, which destroys the just-shown menu
      // (the popover show is lost). Track the state on an internal property;
      // the popover + hidden handle the display.
      this._isOpen = true;
      this._menu.querySelector("button[role=menuitem]")?.focus();
    } else {
      if (typeof this._menu.hidePopover === "function") {
        try { this._menu.hidePopover(); } catch { /* already hidden */ }
      }
      this._menu.hidden = true;
      this._isOpen = false;
    }
  }
  _pickFile(kind) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      if (kind === "audio") input.accept = "audio/*";
      if (kind === "video") input.accept = "video/*";
      input.onchange = async () => {
        const file = input.files?.[0] ?? null;
        if (!file) return resolve(null);
        // dptw note: the old arbitrary 8 MiB select-time refuse is gone. What
        // remains is a TRANSPORT ceiling, not a size cap: the bytes cross to
        // the service worker as a base64 dataURL inside ONE runtime message —
        // base64 inflates by 4/3 and the practical runtime-messaging envelope
        // is ~64 MiB, so 32 MiB raw (~43 MiB on the wire) is the generous
        // edge with headroom; past it the send itself risks failing, and
        // FileReader would build a 40+ MiB string on the main thread first
        // (tab freeze). Over the ceiling: refuse HONESTLY (attach-error with
        // the real reason), never a silent empty dataURL.
        const MAX_PICK_BYTES = 32 * 1024 * 1024; // 32 MiB raw (~43 MiB base64)
        if (file.size > MAX_PICK_BYTES) {
          resolve({ name: file.name, size: file.size, type: file.type, kind, file, dataURL: "", overLimit: true });
          return;
        }
        // Read the bytes as a dataURL so the service worker can actually send
        // TEXT content to the model (and label media honestly). A read failure
        // is carried as readError and surfaced by the caller — never silent.
        let dataURL = "";
        let readError = null;
        try {
          dataURL = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.onerror = () => rej(fr.error);
            fr.readAsDataURL(file);
          });
        } catch (err) {
          readError = String(err?.message ?? err ?? "the file could not be read");
        }
        resolve({ name: file.name, size: file.size, type: file.type, kind, file, dataURL, readError });
      };
      input.oncancel = () => resolve(null);
      input.click();
      this._fileInput = input;
    });
  }
}
customElements.define("attach-button", AttachButton);

/* ── the structured tool-call renderer (extension/shared/tool-tree.js) ────
 * Recognizes structured tool inputs/results, parses safely (objects + bounded
 * JSON-string decodes — lib/tool-tree.js), and renders an accessible,
 * collapsible, bounded key/value tree. No unsafe innerHTML (the tree is built
 * with createElement/textContent); a readable plain-text fallback when parsing
 * fails; depth/size bounds prevent a huge or deep payload from hanging the UI.
 * The tree is a flat row list inside one <details> per block — keyboard
 * accessible (<button> toggles + copy buttons), no emoji (SVG caret). */
/** Consume a lazy result's bounded selected-tool output contract. Schema
 * metadata is not user output; a matching declared container may decode one
 * JSON-string layer. Legacy/direct results use the generic tree path below. */
function schemaAllowsContainer(schema, value, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 4) return false;
  const kind = Array.isArray(value) ? "array" : "object";
  if (schema.type === kind || (Array.isArray(schema.type) && schema.type.includes(kind))) return true;
  if (schema["x-cap-output-shape"] === "generic-json-value") return true;
  for (const branch of [schema.oneOf, schema.anyOf, schema.allOf]) {
    if (Array.isArray(branch) && branch.some((entry) => schemaAllowsContainer(entry, value, depth + 1))) return true;
  }
  return false;
}

function schemaAwareToolPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.schemaSummary !== "string") return value;
  const schema = safeParseOnce(value.schemaSummary);
  if (schema.kind !== "json" || !schema.value || typeof schema.value !== "object") return value;
  const shown = {};
  for (const [key, field] of Object.entries(value)) {
    if (key !== "schemaSummary") shown[key] = field;
  }
  if (typeof shown.result === "string") {
    const decoded = safeParseOnce(shown.result);
    if (decoded.kind === "json" && schemaAllowsContainer(schema.value, decoded.value)) shown.result = decoded.value;
  }
  return shown;
}

/** Renderer-only metadata the lazy protocol stamps on every `execute_tool`
 *  envelope, and the catalogue keys of a `search_tools` result. Transport, not
 *  the tool's answer — never a tree row, never a raw-view line
 *  (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 §9/§10). */
const LAZY_ENVELOPE_META = new Set([
  "schemaSummary", "selectionRef", "authorizes", "requiresLiveAuthorization", "replay",
  "selectedTool", "catalogGeneration", "stableId",
]);

/** Unwrap EVERY transport layer around a tool payload, bounded, so what is
 *  left is the SELECTED TOOL'S OWN result (or its own error): agent-do's
 *  {modelContent,userSummary} wrapper — whose value is usually a JSON string of
 *  the next layer — then the lazy protocol's {ok, selectedTool, result}
 *  envelope. Anything that is not an envelope passes straight through, so the
 *  direct-dispatch path is unaffected. Returns { value, selectedTool }.
 *  Pure; never throws. */
export function unwrapToolPayload(value) {
  let v = value;
  let selectedTool = null;
  for (let hop = 0; hop < 6; hop++) {
    if (typeof v === "string") {
      const parsed = safeParseOnce(v);
      // A JSON string literal decodes ONCE to its text and stops there: the
      // second encoding layer stays text (the bounded-decode contract).
      if (parsed.kind === "string" && parsed.decoded) { v = parsed.value; break; }
      if (parsed.kind !== "json") break;
      v = parsed.value;
      continue;
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) break;
    if (v.userSummary != null) { v = v.userSummary; continue; }
    if (v.modelContent != null) { v = v.modelContent; continue; }
    if (typeof v.selectedTool === "string" && v.selectedTool) {
      selectedTool = v.selectedTool;
      // The declared output schema may decode one JSON-string layer of the
      // inner result; it is consumed here and never shown.
      const shaped = schemaAwareToolPayload(v);
      if (shaped.result !== undefined) { v = shaped.result; continue; }
      if (typeof shaped.error === "string") { v = { ok: false, error: shaped.error }; break; }
      const rest = {};
      for (const [k, field] of Object.entries(shaped)) if (!LAZY_ENVELOPE_META.has(k)) rest[k] = field;
      v = rest;
      break;
    }
    break;
  }
  return { value: v, selectedTool };
}

/** The saved screenshot a tool result points at, or null. The PNG itself is
 *  never in the payload — the protocol lifts it into an image part for the
 *  model and the store keeps the file — so the card renders it from the id
 *  (CAP-FB-20260830-SCREENSHOT-TO-MODEL-01). */
export function screenshotFromToolPayload(payload) {
  if (payload == null || payload === "") return null;
  // The id can sit at any of several transport depths — agent-do's
  // {modelContent,userSummary} wrapper (whose userSummary is prose, so the
  // ordinary unwrap walks PAST the object), the lazy envelope's `result`, or a
  // bare direct result. So look for it, bounded: at most 400 nodes, 7 levels,
  // one JSON-string decode per string, and only strings that mention the field
  // are decoded at all.
  let budget = 400;
  const seen = new Set();
  const visit = (value, depth) => {
    if (value == null || depth > 7 || budget-- <= 0) return null;
    if (typeof value === "string") {
      if (!value.includes("screenshotId")) return null;
      const parsed = safeParseOnce(value);
      return parsed.kind === "json" ? visit(parsed.value, depth + 1) : null;
    }
    if (typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const id = Object.getOwnPropertyDescriptor(value, "screenshotId")?.value;
    if (typeof id === "string" && id) {
      const width = Number(value.width);
      const height = Number(value.height);
      return {
        id,
        label: typeof value.url === "string" ? value.url : "",
        size: Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
          ? `${width}×${height}`
          : "",
      };
    }
    for (const child of Object.values(value)) {
      const hit = visit(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  try {
    const found = visit(payload, 0);
    if (found) return found;
  } catch { /* fall through to the text read */ }
  // THE LIVE PAYLOAD IS OFTEN NOT PARSEABLE. The progress event that fills this
  // card (and that the run log persists) bounds the result with a mid-string
  // slice at 300 characters, so any envelope larger than that arrives as a
  // truncated JSON fragment — the id is right there in the text and no parser
  // will ever reach it. Read it out of the text instead, from a pattern the
  // product itself minted: `shot_<hex>` (lib/pure.js newId). Bounded (8 KiB scanned,
  // fixed-width captures), read-only, and used for nothing but the id of a file
  // this extension wrote (CAP-FB-20260830-SCREENSHOT-TO-MODEL-01).
  const text = typeof payload === "string" ? payload.slice(0, 8192) : "";
  const id = /\\?"screenshotId\\?"\s*:\s*\\?"(shot_[A-Za-z0-9_]{1,64})/.exec(text)?.[1];
  if (!id) return null;
  const num = (field) =>
    Number(new RegExp(`\\\\?"${field}\\\\?"\\s*:\\s*(\\d{1,6})`).exec(text)?.[1] ?? NaN);
  const width = num("width");
  const height = num("height");
  const url = /\\?"url\\?"\s*:\s*\\?"(https?:[^"\\]{1,300})/.exec(text)?.[1] ?? "";
  return {
    id,
    label: url,
    size: width > 0 && height > 0 ? `${width}×${height}` : "",
  };
}

/** Does a string look like a transport envelope that failed to parse (the
 *  live path once stored a TRUNCATED summary of the envelope in tool-result)?
 *  Such text is never shown: the headline already carries the tool's words. */
function looksLikeBrokenEnvelope(text) {
  const t = String(text ?? "").trimStart();
  if (!t.startsWith("{")) return false;
  return /"(modelContent|userSummary|selectedTool|schemaSummary|selectionRef|catalogGeneration|stableId)"/.test(t);
}

/** Remove the parts of a tool payload the card already communicates, so the tree
 *  shows the ANSWER rather than the envelope around it. `ok` is the status chip;
 *  `summary`/`error` are the collapsed headline; the lazy protocol's transport
 *  layers and metadata are unwrapped/dropped first. Returns undefined when
 *  nothing substantive is left, so the block is skipped entirely rather than
 *  rendering an empty tree. */
function stripToolEnvelope(value, status) {
  value = unwrapToolPayload(value).value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const drop = new Set(["ok", "summary", "error"]);
  const kept = {};
  let keptCount = 0;
  for (const [k, v] of Object.entries(value)) {
    if (drop.has(k) || LAZY_ENVELOPE_META.has(k)) continue;
    kept[k] = v;
    keptCount += 1;
  }
  if (keptCount === 0) return undefined;
  // A single remaining wrapper key adds a level of nesting for nothing. Decode
  // at most one bounded JSON-string layer too, covering modelContent wrappers
  // without turning prose, malformed JSON, or oversized strings into a tree.
  const keys = Object.keys(kept);
  if (keys.length === 1 && keys[0] === "result") {
    const only = kept[keys[0]];
    if (only && typeof only === "object") return only;
    if (typeof only === "string") {
      const decoded = safeParseOnce(only);
      if (decoded.kind === "json") return decoded.value;
    }
  }
  return kept;
}

/** The one line a collapsed tool card shows: for a failure the actual error, for
 *  a success the short summary the caller already computed. Bounded, because
 *  this sits on one line in a transcript. */
export function toolHeadline(status, result, detail) {
  const pick = (v, depth = 0) => {
    if (v == null || v === "" || depth > 4) return "";
    if (typeof v === "string") {
      const t = v.trim();
      if (!t.startsWith("{") && !t.startsWith("[")) return t;
      // A truncated envelope is transport, never a headline (§10).
      if (looksLikeBrokenEnvelope(t)) {
        try { JSON.parse(t); } catch { return ""; }
      }
      try {
        const o = JSON.parse(t);
        if (o && typeof o === "object" && !Array.isArray(o)) {
          if (typeof o.error === "string" && o.error) return o.error;
          if (typeof o.summary === "string" && o.summary) return o.summary;
          // Envelopes double-wrap the payload ({modelContent:"{\"result\":…}"}),
          // so the denial text lives a layer down — descend, bounded.
          return pick(o.modelContent, depth + 1) || pick(o.result, depth + 1);
        }
      } catch { /* not JSON — fall through */ }
      return "";
    }
    if (typeof v === "object" && !Array.isArray(v)) {
      if (typeof v.error === "string" && v.error) return v.error;
      if (typeof v.summary === "string" && v.summary) return v.summary;
      return pick(v.modelContent, depth + 1) || pick(v.result, depth + 1);
    }
    return "";
  };
  // A FAILED call headlines the ERROR, never a bare summary: the live path
  // stores summarizeToolResult(...) in `result` (the owner's denied envelope
  // summarizes to "done") and the raw envelope in `detail`, so on error the
  // detail's extracted error wins; the result stays the fallback when there is
  // no detail (replay rows store the envelope in `result` itself).
  const text = status === "error" ? pick(detail) || pick(result) : pick(result) || pick(detail);
  return clipHeadline(text);
}

/** One line, bounded, for the collapsed card's head (the full text rides the
 * element's title). */
function clipHeadline(text) {
  if (!text) return "";
  const oneLine = String(text).replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine;
}

function formatToolDurationMs(ms) {
  // Only a REAL duration is shown — null/""/0/NaN must never render "0ms"
  // (the phantom-timing finding: Number(null) === 0).
  if (ms == null || ms === "") return "";
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}s`;
}

function toolKindLabel(row) {
  if (!row) return "";
  let label = row.kind;
  if ((row.kind === "array" || row.kind === "object") && row.count != null) {
    label += ` · ${row.count}`;
  }
  if (row.capped) label += " · capped";
  return label;
}

/** The canonical key for a segment address (unambiguous — never a dotted join). */
function segKey(segments) {
  return JSON.stringify(segments);
}

// The block-header control icons: one stroke weight, currentColor, static
// product-authored markup (no data ever reaches these strings).
const TT_ICON_BRACES = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/></svg>';
const TT_ICON_COPY = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const TT_ICON_EXPAND = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="7 8 12 3 17 8"/><polyline points="7 16 12 21 17 16"/></svg>';
const TT_ICON_INFO = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

/** A collapsible tree BLOCK (<details> + bounded flat rows) for a parsed value.
 * The expansion state PERSISTS across re-renders (attribute updates rebuild
 * the bubble): `expandedState` is a Map label → Set of segment-address keys. */
function buildToolTreeBlock(label, value, rowsIn, maxNodes, expandedState) {
  let rows = rowsIn;
  const details = document.createElement("details");
  details.className = "tt-block";
  details.open = true;

  const summary = document.createElement("summary");
  const l = document.createElement("span");
  l.className = "tt-block-label";
  l.textContent = label;
  summary.appendChild(l);
  const meta = document.createElement("span");
  meta.className = "tt-block-meta";
  meta.textContent = rows.length ? toolKindLabel(rows[0]) : "";
  if (rows.length >= maxNodes) meta.textContent += " · truncated";
  if (meta.textContent) summary.appendChild(meta);

  // JSON VIEW + COPY + SHOW ALL (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01;
  // CAP-FB-20260901-TOOL-RESULT-FULL-JSON-01). The owner asked for "the ability
  // to see JSON input and response better" and then, once the full result was
  // retained, for "a nice JSON formatted result": the JSON view is the COMPLETE
  // pretty-printed document, syntax-coloured from the theme tokens (spans built
  // with textContent — never innerHTML); Copy takes that same pretty text; Show
  // all lifts the block's scroll cap so a long result reads as one page. The
  // toggles live in the block header so inputs and result each get their own,
  // and every choice is remembered per block for the session.
  const controls = document.createElement("span");
  controls.className = "tt-block-controls";
  const iconButton = (className, icon, text, title) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.title = title;
    const ic = document.createElement("span");
    ic.className = "tt-btn-ic";
    ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = icon; // a static, product-authored SVG string — never data
    const lbl = document.createElement("span");
    lbl.className = "tt-btn-label";
    lbl.textContent = text;
    btn.appendChild(ic);
    btn.appendChild(lbl);
    return [btn, lbl];
  };
  const [rawBtn] = iconButton("tt-raw-toggle", TT_ICON_BRACES, "JSON", "Show the complete result as pretty-printed JSON");
  rawBtn.setAttribute("aria-pressed", "false");
  const [copyBtn, copyLabel] = iconButton("tt-copy-all", TT_ICON_COPY, "Copy", `Copy the ${label} as pretty-printed JSON`);
  const [allBtn, allLabel] = iconButton("tt-expand-toggle", TT_ICON_EXPAND, "Show all", "Show the whole block without an inner scroll");
  allBtn.setAttribute("aria-pressed", "false");
  controls.appendChild(rawBtn);
  controls.appendChild(copyBtn);
  controls.appendChild(allBtn);
  summary.appendChild(controls);
  details.appendChild(summary);

  // The pretty JSON view. The text is complete; it is TOKENISED into coloured
  // spans eagerly when small, lazily on first reveal when large, and left as
  // plain (still complete) text above PRETTY_JSON_TOKENISE_MAX_CHARS — a
  // bounded DOM for a 64 KiB result, not one span per byte on every card.
  const rawPre = document.createElement("pre");
  rawPre.className = "tt-raw";
  const pretty = prettyJson(value);
  let prettyBuilt = false;
  const buildPretty = () => {
    if (prettyBuilt) return;
    prettyBuilt = true;
    if (pretty.length > PRETTY_JSON_TOKENISE_MAX_CHARS) { rawPre.textContent = pretty; return; }
    rawPre.textContent = "";
    for (const tok of tokenizeJson(pretty)) {
      const span = document.createElement("span");
      span.className = `tt-json-${tok.kind}`;
      span.textContent = tok.text;
      rawPre.appendChild(span);
    }
  };
  if (pretty.length <= 24 * 1024) buildPretty();

  // Which view the owner last chose, remembered per block. It rides in the same
  // Map as the expansion state under a namespaced key that can never collide
  // with a block label, so the choice survives the attribute updates that
  // rebuild the card while a tool is still running — without a second store.
  const rawStateKey = `__raw__:${label}`;
  const allStateKey = `__all__:${label}`;
  const rawWanted = expandedState?.get(rawStateKey) === true;
  const allWanted = expandedState?.get(allStateKey) === true;
  rawPre.hidden = !rawWanted;
  if (rawWanted) buildPretty();

  // A click on a control inside <summary> must not also toggle the <details>.
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  rawBtn.addEventListener("click", (e) => {
    stop(e);
    const showRaw = rawPre.hidden;
    if (showRaw) buildPretty();
    rawPre.hidden = !showRaw;
    rawBtn.setAttribute("aria-pressed", showRaw ? "true" : "false");
    rawBtn.className = showRaw ? "tt-raw-toggle on" : "tt-raw-toggle";
    const treeEl = details.querySelector(".tt-tree");
    if (treeEl) treeEl.hidden = showRaw;
    if (!details.open) details.open = true;
    expandedState?.set(rawStateKey, showRaw);
  });
  const applyAll = (on) => {
    details.className = on ? "tt-block tt-unbounded" : "tt-block";
    allBtn.setAttribute("aria-pressed", on ? "true" : "false");
    allBtn.className = on ? "tt-expand-toggle on" : "tt-expand-toggle";
    allLabel.textContent = on ? "Show less" : "Show all";
  };
  if (allWanted) applyAll(true);
  allBtn.addEventListener("click", (e) => {
    stop(e);
    const on = allBtn.getAttribute("aria-pressed") !== "true";
    applyAll(on);
    if (!details.open) details.open = true;
    expandedState?.set(allStateKey, on);
  });
  copyBtn.addEventListener("click", async (e) => {
    stop(e);
    // The COMPLETE pretty JSON — never the bounded tree or a preview.
    const text = pretty;
    try {
      await navigator.clipboard.writeText(text);
      copyLabel.textContent = "Copied";
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); copyLabel.textContent = "Copied"; } catch { copyLabel.textContent = "Copy"; }
      ta.remove();
    }
    setTimeout(() => { copyLabel.textContent = "Copy"; }, 1600);
  });

  const tree = document.createElement("div");
  tree.className = "tt-tree";
  // Honour the remembered choice on the FIRST paint, not only after a click —
  // otherwise the tree flashes in before being replaced by the raw view.
  tree.hidden = rawWanted;
  if (rawWanted) {
    rawBtn.setAttribute("aria-pressed", "true");
    rawBtn.className = "tt-raw-toggle on";
  }
  details.appendChild(rawPre);

  // Drop the synthetic ROOT container row. It rendered as `{keys} object · N`,
  // which is not a word, adds a level of indentation to everything beneath it,
  // and says only what the block label ("inputs" / "result") plus the meta
  // ("object · N") already say. Its CHILDREN are promoted a level so the tree
  // starts at the data.
  const rootKey = segKey([]);
  const hasSyntheticRoot = rows.length > 0 && rows[0].segments.length === 0 && !rows[0].leaf;
  if (hasSyntheticRoot) rows = rows.slice(1);

  // Initial expansion: the PERSISTED state for this label when present (the
  // card re-renders on tool-status/result/duration attribute updates — the
  // owner's collapsed/expanded choices survive), else containers at depth < 2.
  const saved = expandedState?.get(label);
  const expanded = new Set();
  // The removed root is implicitly expanded — every visible row descends from
  // it, and isVisible() walks every ancestor including the root address.
  if (hasSyntheticRoot) expanded.add(rootKey);
  for (const r of rows) {
    if (!r.leaf) {
      const k = segKey(r.segments);
      if (saved && saved.has(k)) expanded.add(k);
      else if (!saved && r.depth < 2) expanded.add(k);
    }
  }
  const isVisible = (r) => {
    // every ancestor container (including the root []) must be expanded
    for (let i = 0; i < r.segments.length; i++) {
      if (!expanded.has(segKey(r.segments.slice(0, i)))) return false;
    }
    return true;
  };
  const rowEls = [];
  const applyVisibility = () => {
    for (const [r, el] of rowEls) el.hidden = !isVisible(r);
  };
  const persist = () => {
    if (!expandedState) return;
    const next = new Set();
    for (const r of rows) {
      if (!r.leaf && expanded.has(segKey(r.segments))) next.add(segKey(r.segments));
    }
    expandedState.set(label, next);
  };

  for (const r of rows) {
    const row = document.createElement("div");
    row.className = r.leaf ? "tt-row tt-leaf" : "tt-row tt-container";
    row.dataset.path = segKey(r.segments);
    row.dataset.depth = String(r.depth);
    row.dataset.kind = r.kind;
    row.dataset.cyclic = r.cyclic ? "1" : undefined;
    if (r.full) row.title = r.full;

    if (!r.leaf) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "tt-toggle";
      const segs = r.segments;
      const open = expanded.has(segKey(segs));
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${r.key || "root"} (${r.kind})`);
      toggle.innerHTML = `<svg class="tt-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>`;
      toggle.addEventListener("click", () => {
        const k = segKey(segs);
        if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
        toggle.setAttribute("aria-expanded", expanded.has(k) ? "true" : "false");
        toggle.setAttribute("aria-label", `${expanded.has(k) ? "Collapse" : "Expand"} ${r.key || "root"} (${r.kind})`);
        applyVisibility();
        persist();
      });
      row.appendChild(toggle);
      const key = document.createElement("span");
      key.className = "tt-key";
      key.textContent = r.key || (r.kind === "array" ? "[items]" : "{keys}");
      row.appendChild(key);
      // CONTENT before shape (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 §4). An
      // array of ten tabs used to render as ten identical `object · 10` rows,
      // so finding one meant opening all ten. The preview is the row's
      // identity; the type label stays, demoted, because the count is still
      // worth knowing.
      if (r.preview) {
        const prev = document.createElement("span");
        prev.className = "tt-preview";
        prev.textContent = r.preview;
        row.appendChild(prev);
      }
      const kind = document.createElement("span");
      kind.className = r.preview ? "tt-kind muted" : "tt-kind";
      kind.textContent = toolKindLabel(r);
      row.appendChild(kind);
    } else {
      const ic = document.createElement("span");
      ic.className = "tt-ic";
      ic.setAttribute("aria-hidden", "true");
      row.appendChild(ic);
      if (r.key !== "") {
        const key = document.createElement("span");
        key.className = "tt-key";
        key.textContent = r.key;
        row.appendChild(key);
      }
      const val = document.createElement("span");
      val.className = `tt-val tt-val-${r.kind}`;
      val.textContent = r.text ?? "";
      row.appendChild(val);
    }

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "tt-copy";
    copy.dataset.copy = r.leaf ? "value" : "json";
    copy.textContent = r.leaf ? "copy" : "copy json";
    const copyName = r.key || (r.leaf ? "value" : "root");
    copy.setAttribute("aria-label", r.leaf ? `Copy value of ${copyName}` : `Copy JSON for ${copyName}`);
    // Explicit button → row mapping (a delegated closest() lookup against the
    // model array could never match — the k3 blocker: `rows.find(r => r === el)`).
    copy._row = r;
    row.appendChild(copy);
    tree.appendChild(row);
    rowEls.push([r, row]);
  }

  applyVisibility();

  // Delegated copy handling (one listener per block): a leaf copies its scalar
  // value; a container copies its (bounded) subtree JSON. Failures are caught.
  tree.addEventListener("click", (e) => {
    const btn = e.target.closest?.(".tt-copy");
    if (!btn) return;
    e.stopPropagation();
    const isJson = btn.dataset.copy === "json";
    const row = btn._row; // the explicit button → row mapping
    if (!row) return;
    const label = btn.textContent;
    let text;
    try {
      text = isJson
        ? (subtreeJson(value, row.segments) ?? "")
        : (row.full ?? row.text ?? "");
    } catch { text = undefined; }
    // An EMPTY STRING is a valid leaf value and MUST copy; only a genuinely
    // unavailable row (no text at all) refuses.
    if (text === undefined || text === null) {
      btn.textContent = "unavailable";
      setTimeout(() => { btn.textContent = label; }, 1200);
      return;
    }
    const restore = () => setTimeout(() => { btn.textContent = label; }, 1400);
    if (navigator.clipboard?.writeText) {
      // The button says "copied" ONLY on a resolved write — a rejection must
      // NOT claim success (the k3 clipboard finding).
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = "copied";
        restore();
      }).catch(() => {
        btn.textContent = "copy failed";
        restore();
      });
    } else if (document.execCommand) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
      // execCommand returning FALSE must report failure, never success
      btn.textContent = ok ? "copied" : "copy failed";
      restore();
    } else {
      // NEITHER the Clipboard API nor execCommand exists — report failure
      btn.textContent = "copy failed";
      restore();
    }
  });

  details.appendChild(tree);
  return details;
}

/** Build the whole tool card as DOM. args/result/detail become structured,
 * bounded trees when they parse; otherwise a readable plain-text fallback.
 * The card is a per-card <details> COLLAPSED by default (the name summary +
 * status chip); clicking the head expands ONLY this card. `cardExpanded` +
 * `onCardToggle` persist the per-card open state across re-renders. */
export function buildToolCardDom({ name, status: statusIn, args, result, detail, detailNote = null, duration, expandedState, cardExpanded = false, onCardToggle, siteActivity = null }) {
  // THE ERROR RULE (CAP-FB-20260901-TOOL-RESULT-FULL-JSON-01 — owner: "it
  // errors on a tool call and I can't see the error in the UI"). A failed call
  // is a failed call whatever the row said: an error nested inside a lazy
  // `ok:true` envelope, a bare protocol refusal, a plain {ok:false} — if the
  // result carries an error, the card is an ERROR card (open, red chip) and
  // its headline is that error, explained when it is a protocol code. The
  // retained full copy (detail) is read first; the summary is the fallback.
  let status = statusIn;
  const errorText = status === "running" ? "" : (toolResultErrorText(detail) || toolResultErrorText(result));
  if (errorText && status !== "error") status = "error";
  // The card is NOT a live region: re-rendering a 200-row tree would announce
  // the whole card on every attribute update (the a11y finding). The COMPACT
  // status chip is the live region — it carries the compact state text only.
  const card = document.createElement("details");
  card.className = "tool";
  card.open = cardExpanded === true;

  const summary = document.createElement("summary");
  summary.className = "tool-head";
  // THE CARD IS HEADED BY THE TOOL THAT RAN (§9). Under the lazy protocol the
  // call arrives as `execute_tool` and the invoked tool is named inside the
  // payload; the live path corrects the attribute once the result lands, but
  // a replayed or still-running card must never read "execute_tool" either.
  const lazyName = name === "execute_tool" || name === "search_tools"
    ? (unwrapToolPayload(result).selectedTool || unwrapToolPayload(detail).selectedTool || null)
    : null;
  const rawToolName = lazyName || (name === "execute_tool" ? "" : (name || "tool"));
  const shownName = humanToolLabel(rawToolName) || "Action";
  const nameEl = document.createElement("span");
  nameEl.className = "tool-name";
  nameEl.textContent = shownName;
  if (rawToolName) card.setAttribute("data-raw-tool", rawToolName);
  summary.appendChild(nameEl);
  // `execute_tool`'s own arguments nest the invoked tool's arguments under
  // `arguments` beside a selectionRef that means nothing to a reader.
  const shownArgs = (() => {
    const parsed = args != null && args !== "" ? safeParseOnce(args) : null;
    if (parsed && parsed.kind === "json" && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) &&
        parsed.value.arguments !== undefined && "selectionRef" in parsed.value) {
      return parsed.value.arguments;
    }
    return args;
  })();
  const safeShownArgs = redactToolArgs(rawToolName, shownArgs);

  // THE COLLAPSED CARD MUST ANSWER "what happened" WITHOUT A CLICK
  // (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01). It used to show only the tool
  // name, a status chip and a duration — so a successful call said nothing
  // (the one-line summary was already computed and simply not rendered), and a
  // FAILED call showed no error text at all, which is backwards for the one
  // state the owner most needs to read.
  const headline = status === "error" && errorText ? clipHeadline(errorText) : toolHeadline(status, result, detail);
  if (headline) {
    const lead = document.createElement("span");
    lead.className = status === "error" ? "tool-lead error" : "tool-lead";
    lead.textContent = headline;
    // The full text on hover when the line is clipped (the complete error for
    // a failure, never its 140-char clip).
    lead.title = status === "error" && errorText ? errorText : headline;
    summary.appendChild(lead);
  }

  // The human line on the COLLAPSED row (the owner's tool-call clarity
  // finding): "Searching tools for “daily notes”", "Opening https://…" —
  // computed from the tool name + its (already-redacted) arguments. The args
  // attribute is a JSON string when structured; a parse failure just means no
  // argument interpolation, never a broken card.
  let what = "";
  try {
    const parsedArgs = safeShownArgs != null && safeShownArgs !== "" ? safeParseOnce(safeShownArgs) : null;
    what = describeToolCall(lazyName || name, parsedArgs && parsedArgs.kind === "json" ? parsedArgs.value : safeShownArgs);
    if (status === "done" && what.startsWith("Running ")) what = `Completed ${what.slice("Running ".length)}`;
    else if (status === "error" && what.startsWith("Running ")) what = `Failed ${what.slice("Running ".length)}`;
  } catch { what = ""; }
  if (what) {
    const whatEl = document.createElement("span");
    whatEl.className = "tool-what";
    whatEl.textContent = what;
    summary.appendChild(whatEl);
  }
  const statusEl = document.createElement("span");
  statusEl.className = `tool-status ${status}`;
  statusEl.setAttribute("role", "status");
  statusEl.textContent = status === "done" ? "done" : status === "error" ? "error" : "running";
  summary.appendChild(statusEl);
  const unwrapOnDevice = (v) => {
    if (!v) return false;
    if (typeof v === "object") {
      if (v.onDevice === true) return true;
      if (v.result?.onDevice === true) return true;
      if (v.value?.onDevice === true) return true;
    } else if (typeof v === "string") {
      try {
        const parsed = JSON.parse(v);
        if (parsed?.onDevice === true || parsed?.result?.onDevice === true || parsed?.value?.onDevice === true) return true;
      } catch { /* ignore non-JSON string */ }
    }
    return false;
  };
  const isOnDevice = unwrapOnDevice(result) || unwrapOnDevice(detail);
  if (isOnDevice) {
    const onDeviceEl = document.createElement("span");
    onDeviceEl.className = "tool-status on-device";
    onDeviceEl.setAttribute("role", "status");
    onDeviceEl.setAttribute("aria-label", "Executed on-device");
    onDeviceEl.textContent = "On-device";
    summary.appendChild(onDeviceEl);
  }
  const dur = formatToolDurationMs(duration);
  if (dur) {
    const durEl = document.createElement("span");
    durEl.className = "tool-duration";
    durEl.textContent = dur;
    summary.appendChild(durEl);
  }
  card.appendChild(summary);

  // A failure opens by default. Everything else stays closed: the transcript is
  // a conversation, and an expanded call is 400+ pixels of it.
  if (status === "error" && cardExpanded !== true) card.open = true;

  const body = document.createElement("div");
  body.className = "tool-body";

  // The never-silent note: the retained copy hit its 64 KiB cap. Said in the
  // card, in plain words, before the tree — never a silently shorter result.
  if (typeof detailNote === "string" && detailNote.trim()) {
    const note = document.createElement("div");
    note.className = "tool-note";
    const ic = document.createElement("span");
    ic.className = "tool-note-ic";
    ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = TT_ICON_INFO; // static product-authored SVG
    const text = document.createElement("span");
    text.className = "tool-note-text";
    text.textContent = detailNote.trim();
    note.appendChild(ic);
    note.appendChild(text);
    body.appendChild(note);
  }

  // A CAPTURE SHOWS THE PICTURE. The bytes went to the model as an image part
  // and to the screenshots store as a file; the card resolves the file by id so
  // the owner sees exactly what the agent saw
  // (CAP-FB-20260830-SCREENSHOT-TO-MODEL-01).
  const shot = screenshotFromToolPayload(result) ?? screenshotFromToolPayload(detail);
  if (shot) {
    const thumb = document.createElement("screenshot-thumb");
    thumb.setAttribute("shot-id", shot.id);
    if (shot.label) thumb.setAttribute("label", shot.label);
    if (shot.size) thumb.setAttribute("size", shot.size);
    body.appendChild(thumb);
  }

  const activity = normalizeSiteActivity(siteActivity);
  let actions = null;
  if (activity) {
    actions = document.createElement("div");
    actions.className = "tool-actions";
    const openActivity = document.createElement("button");
    openActivity.type = "button";
    openActivity.className = "site-activity";
    openActivity.textContent = "View site activity";
    openActivity.setAttribute("aria-label", `View site activity for ${visibleSiteActivityLabel(activity.tool, 128)} on ${visibleSiteActivityLabel(activity.origin)}`);
    actions.appendChild(openActivity);
    body.appendChild(actions);
  }

  let treePopulated = false;
  const populateTree = () => {
    if (treePopulated) return;
    treePopulated = true;

    const insertBlock = (node) => {
      if (actions && actions.parentNode === body) {
        body.insertBefore(node, actions);
      } else {
        body.appendChild(node);
      }
    };

    const addBlock = (label, raw) => {
      if (raw == null || raw === "") return;
      const parsed = safeParseOnce(raw);
      if (parsed.kind === "json") {
        // Strip the protocol envelope before rendering
        // (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01). `ok:true` is already said by
        // the green status chip, and `summary`/`error` are already the card's
        // headline — rendering them again as tree rows is duplication that costs
        // vertical space in a transcript.
        const shown = stripToolEnvelope(parsed.value, status);
        if (shown === undefined) return;
        if (typeof shown === "string") {
          // The envelope held plain text: show it as text, not a one-leaf tree.
          if (looksLikeBrokenEnvelope(shown)) return;
          const div = document.createElement("div");
          div.className = `tool-plain tool-plain-${label}`;
          div.textContent = shown;
          insertBlock(div);
          return;
        }
        const tree = buildTree(shown);
        if (tree.rows.length >= 1) {
          insertBlock(buildToolTreeBlock(label, shown, tree.rows, tree.maxNodes, expandedState));
          return;
        }
      }
      // A transport envelope that did not parse (a truncated copy) is never
      // painted: the headline already carries the tool's own words (§10).
      if (looksLikeBrokenEnvelope(parsed.value ?? raw)) return;
      const div = document.createElement("div");
      div.className = `tool-plain tool-plain-${label}`;
      div.textContent = String(parsed.value ?? raw ?? "");
      insertBlock(div);
    };

    addBlock("inputs", safeShownArgs);

    const resultParsed = result != null && result !== "" ? safeParseOnce(result) : null;
    const detailParsed = detail != null && detail !== "" ? safeParseOnce(detail) : null;

    // ONE result tree, from the AUTHORITATIVE copy. `detail` is the retained
    // full result (the live event's raw envelope; the durable row's 64 KiB
    // copy) and `result` the bounded list summary of the SAME call — when both
    // are structured, only the full copy renders; the summary is never a second
    // "detail" tree (CAP-FB-20260901-TOOL-RESULT-FULL-JSON-01). Rows persisted
    // before the full copy existed carry the structure in `result` alone.
    const fullParsed = detailParsed && detailParsed.kind === "json"
      ? detailParsed
      : (resultParsed && resultParsed.kind === "json" ? resultParsed : null);
    if (fullParsed) {
      // Strip the envelope here too: this branch bypasses addBlock, which is why
      // an error result still rendered `ok false` and repeated its own message as
      // tree rows under the headline that already said it.
      const shownResult = stripToolEnvelope(fullParsed.value, status);
      const tree = shownResult === undefined || typeof shownResult === "string" ? { rows: [], maxNodes: 0 } : buildTree(shownResult);
      if (tree.rows.length >= 1) {
        insertBlock(buildToolTreeBlock("result", shownResult, tree.rows, tree.maxNodes, expandedState));
      } else if (shownResult === undefined) {
        // Everything the payload carried is already in the head. Render nothing
        // rather than an empty block.
      } else if (!looksLikeBrokenEnvelope(typeof shownResult === "string" ? shownResult : (fullParsed.value ?? ""))) {
        const div = document.createElement("div");
        div.className = "tool-plain tool-plain-result";
        div.textContent = typeof shownResult === "string" ? shownResult : String(fullParsed.value ?? "");
        insertBlock(div);
      }
      // A structured summary with a DIFFERENT, unstructured detail (plain text
      // that is not this result's own copy) still reads as text below it.
      if (fullParsed === resultParsed && detail != null && detail !== "" && detail !== result) {
        addBlock("detail", detail);
      }
    } else {
      // Neither is JSON -> honest plain text fallback
      if (result != null && result !== "") addBlock("result", result);
      if (detail != null && detail !== "" && detail !== result) addBlock("detail", detail);
    }
  };

  if (card.open) {
    populateTree();
  }

  card.addEventListener("toggle", () => {
    if (card.open) {
      populateTree();
    }
    if (typeof onCardToggle === "function") {
      onCardToggle(card.open);
    }
  });

  card.appendChild(body);
  return card;
}

/* <message-bubble role="user|agent|system|thinking|tool|error" content="…">
 * A single conversation turn. The ROLE is carried by the bubble's styling
 * (alignment + surface), never by a literal text label:
 *   - user: right-aligned, tinted surface
 *   - agent/system: left, hairline card, content rendered as markdown
 *     (code blocks → <code-block>, inline code, bold, lists, links, headings)
 *   - thinking: a collapsible, muted reasoning trace (a <details>)
 *   - tool: a structured card (name + status + args + result)
 *   - error: a left card with a danger border
 * Content comes from the `content` attribute (or the light-DOM text as a
 * fallback), so the gallery can populate it declaratively. */
/* <harness-agent-button name="pi" current>
 * The launcher row for an external CLI harness (pi, Claude Code, Codex).
 * Carries a neutral terminal glyph (never vendor logos), left-aligned name,
 * and an opening chevron. */

export class AgentIdentity extends Component {
  static get observedAttributes() { return ["name", "avatar", "time"]; }
  _render() {
    const rawName = (this.getAttribute("name") || "").trim();
    const name = (!rawName || rawName === "Agent") ? "Assistant" : rawName;
    const avatar = String(this.getAttribute("avatar") || "");
    // Only an image data URL or https is ever set as a src (no javascript:).
    const avatarOk = /^(data:image\/|https:\/\/)/iu.test(avatar);
    const initial = ([...name][0] || "A").toUpperCase();
    const t = turnTime(this.getAttribute("time"));
    const avatarMarkup = avatarOk
      ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="" width="24" height="24">`
      : `<svg class="avatar" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="var(--panel,#fff)" stroke="currentColor" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor" font-family="system-ui,sans-serif">${escapeHtml(initial)}</text></svg>`;
    mountTemplate(this, `
      :host { display:inline-flex; align-items:center; gap:8px; min-width:0; color:var(--accent,#0e6e63); line-height:1; }
      .avatar { width:24px; height:24px; border-radius:50%; flex:0 0 auto; display:block; object-fit:cover; }
      .name { font-size:12.5px; font-weight:600; color:var(--ink,#1d1b18); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
      time { font-size:12px; color:var(--muted,#635e56); font-variant-numeric:tabular-nums; white-space:nowrap; }
    `, `${avatarMarkup}<span class="name">${escapeHtml(name)}</span>${t ? `<time datetime="${escapeHtml(t.iso)}" title="${escapeHtml(t.full)}">${escapeHtml(t.label)}</time>` : ""}`);
  }
}
customElements.define("agent-identity", AgentIdentity);


const MESSAGE_BUBBLE_STYLE = `
  :host { display:flex; margin:0 0 14px; justify-content:flex-start; }
  :host(:last-child) { margin-bottom:0; }
  :host([role="user"]) { justify-content:flex-end; }
  :host([role="steer"]) { justify-content:flex-end; }
  .bubble-wrap { display:contents; }
  .msg { max-width:78%; border-radius:12px; padding:10px 14px; overflow-wrap:anywhere; }
  /* An assistant turn: the identity header (avatar · name · time) above the bubble. */
  .turn { display:flex; flex-direction:column; gap:6px; max-width:78%; min-width:0; }
  .turn .msg { max-width:100%; }
  .turn agent-identity { padding-inline-start:2px; }
  .body { font-size:14px; line-height:1.55; color:var(--ink,#1d1b18); }
  .body .cite-ref a { color:var(--accent,#0e6e63); text-decoration:none; font-size:0.75em; margin-left:1px; }
  :host([role="user"]) .msg { background:var(--secondary-layer,#efede8); }
  :host([role="steer"]) .msg { background:var(--panel,#ffffff); border:1px solid var(--accent,#0e6e63); }
  :host([role="steer"]) .steer-label { display:block; font-size:12px; font-weight:600; color:var(--accent,#0e6e63); margin:0 0 4px; }
  :host([role="agent"]) .msg, :host([role="system"]) .msg { background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); }
  :host([role="error"]) .msg { background:var(--panel,#ffffff); border:1px solid var(--danger,#b3261e); }
  :host([role="error"]) .body { color:var(--danger,#b3261e); }
  .err-reason { font-weight:600; margin:0 0 4px; }
  .err-action { color:var(--ink,#1d1b18); margin:0 0 8px; }
  .err-fix-row { display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap; }
  .err-retry { font:inherit; font-size:12.5px; font-weight:600; color:var(--btn-fg,#fff); background:var(--accent,#0e6e63); border:1px solid var(--accent,#0e6e63); border-radius:6px; padding:4px 12px; cursor:pointer; }
  .err-retry:hover { filter:brightness(1.08); }
  .err-retry:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
  .err-fix { font:inherit; font-size:12.5px; font-weight:600; color:var(--accent,#0e6e63); background:transparent; border:1px solid var(--accent,#0e6e63); border-radius:6px; padding:4px 10px; cursor:pointer; }
  .err-fix:hover { background:var(--accent,#0e6e63); color:var(--btn-fg,#fff); }
  .err-fix:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
  .msg-copy-btn { font:inherit; font-size:var(--text-xs, 12px); font-weight:600; color:var(--muted,#635e56); background:transparent; border:1px solid var(--border,#e3e0d9); border-radius:6px; padding:2px 8px; cursor:pointer; align-self:flex-start; margin-top:6px; display:inline-flex; align-items:center; gap:4px; }
  .msg-copy-btn:hover { border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
  .msg-copy-btn:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
  .msg .attach { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 8px; }
  .msg .attach img { max-width:100%; max-height:260px; border-radius:8px; border:1px solid var(--border,#e3e0d9); display:block; }
  .msg .attach .file-chip { font-size:12.5px; color:var(--muted,#635e56); background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9); border-radius:6px; padding:4px 8px; display:inline-flex; align-items:center; gap:6px; }
  /* markdown content inside agent/system */
  .body p { margin:0 0 8px; }
  .body p:last-child { margin-bottom:0; }
  .body ul, .body ol { margin:0 0 8px; padding-left:20px; }
  .body li { margin:2px 0; }
  .body h1, .body h2, .body h3, .body h4 { margin:12px 0 6px; font-size:1.05em; font-weight:600; line-height:1.3; }
  .body h1:first-child, .body h2:first-child { margin-top:0; }
  .body a { color:var(--accent,#0e6e63); text-decoration:underline; text-underline-offset:2px; }
  .body code.inline-code, .body :not(pre) > code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:0.9em; background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9); border-radius:4px; padding:1px 5px; }
  .body strong { font-weight:600; }
  .body em { font-style:italic; }
  /* long-response collapse (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01) */
  .long-response { width:100%; }
  .long-response .body { max-height:260px; overflow:hidden; position:relative; }
  .long-response .body::after { content:""; position:absolute; left:0; right:0; bottom:0; height:48px; pointer-events:none; background:linear-gradient(transparent, var(--panel,#ffffff)); }
  .long-response[data-open="1"] .body { max-height:none; overflow:visible; }
  .long-response[data-open="1"] .body::after { display:none; }
  .long-actions { display:flex; gap:8px; margin-top:6px; }
  .long-toggle, .long-copy { font:inherit; font-size:12px; font-weight:600; color:var(--accent,#0e6e63); background:transparent; border:1px solid var(--border,#e3e0d9); border-radius:6px; padding:3px 10px; cursor:pointer; }
  .long-toggle:hover, .long-copy:hover { border-color:var(--accent,#0e6e63); }
  .long-toggle:focus-visible, .long-copy:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
  /* rendered HTML output — the sandboxed iframe */
  .html-frame { margin-top:4px; width:100%; display:flex; flex-direction:column; }
  .html-frame iframe { width:100%; min-height:360px; height:480px; max-height:80vh; border:1px solid var(--border,#e3e0d9); border-radius:8px; background:#fff; resize:vertical; display:block; }
  .genui { width:100%; max-width:840px; }
  .genui-head { font-size:12px; font-weight:600; color:var(--muted,#635e56); margin:0 0 6px; }
  .genui .html-frame iframe { width:100%; min-height:360px; height:520px; max-height:80vh; }
  .genui-raw { margin-top:8px; width:100%; }
  .genui-raw summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:6px; color:var(--muted,#635e56); font-size:var(--text-xs, 12px); padding:4px 0; user-select:none; }
  .genui-raw summary::-webkit-details-marker { display:none; }
  .genui-raw summary:hover { color:var(--text,#1d1b18); }
  .genui-raw .tool-detail-raw { margin-top:4px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:var(--text-xs, 12px); color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; max-height:180px; overflow:auto; background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9); border-radius:6px; padding:6px 8px; }
  /* thinking trace — collapsible, muted, clearly not a wall of text */
  .think { width:100%; }
  .think summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:8px; color:var(--muted,#635e56); font-size:13px; padding:2px 0; user-select:none; }
  .think summary::-webkit-details-marker { display:none; }
  .think summary:hover { color:var(--text,#1d1b18); }
  .think .spin { width:12px; height:12px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; animation:sc-think 1s linear infinite; flex:0 0 auto; }
  .think .caret { transition:transform .15s ease; flex:0 0 auto; }
  .think[open] .caret { transform:rotate(90deg); }
  .think .trace { margin-top:8px; padding:8px 12px; border-left:2px solid var(--border,#e3e0d9); color:var(--muted,#635e56); font-size:12.5px; white-space:pre-wrap; overflow-wrap:anywhere; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; line-height:1.5; }
  @keyframes sc-think { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .think .spin { animation: none; } .think .caret { transition: none; } }
  /* tool card (a per-card <details>: COLLAPSED by default) */
  .tool { display:flex; flex-direction:column; width:100%; max-width:640px; border:1px solid var(--border,#e3e0d9); border-radius:10px; background:var(--panel,#ffffff); overflow:hidden; }
  .tool summary.tool-head { list-style:none; cursor:pointer; user-select:none; }
  .tool summary.tool-head::-webkit-details-marker { display:none; }
  .tool .tool-head { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid var(--border,#e3e0d9); background:var(--panel-2,#efede8); }
  .tool:not([open]) .tool-head { border-bottom:0; }
  .tool .tool-body { display:flex; flex-direction:column; }
  .tool .tool-name { font-family:inherit; font-size:12.5px; font-weight:600; color:var(--ink,#1d1b18); white-space:nowrap; }
  .skipped-line { font-size:13px; color:var(--muted,#635e56); font-style:normal; line-height:1.4; padding:2px 0; margin:0; }
  /* the collapsed row's human line (what the tool is DOING, not just its id) */
  .tool .tool-what { font-size:12.5px; color:var(--muted,#635e56); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1 1 auto; }
  .tool .tool-status { margin-left:auto; display:inline-flex; align-items:center; gap:5px; font-size:var(--text-xs, 12px); font-weight:600; padding:1px 8px; border-radius:999px; }
  .tool .tool-status::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
  .tool .tool-status.running { color:var(--muted,#635e56); background:var(--panel,#ffffff); }
  .tool .tool-status.done { color:var(--success,#1a7f37); background:var(--panel,#ffffff); }
  .tool .tool-status.error { color:var(--danger,#b3261e); background:var(--panel,#ffffff); }
  .tool .tool-status.on-device { color:var(--accent,#0e6e63); background:var(--panel,#ffffff); }
  .tool .tool-args { padding:6px 10px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; }
  .tool .tool-result { padding:6px 10px; font-size:12.5px; color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; border-top:1px solid var(--border,#e3e0d9); }
  .tool .tool-detail { padding:0 10px 6px; border-top:1px solid var(--border,#e3e0d9); }
  .tool .tool-detail summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:6px; color:var(--muted,#635e56); font-size:var(--text-xs, 12px); padding:4px 0 0; user-select:none; }
  .tool .tool-detail summary::-webkit-details-marker { display:none; }
  .tool .tool-detail summary:hover { color:var(--text,#1d1b18); }
  .tool .tool-detail .tool-detail-raw { margin-top:4px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:var(--text-xs, 12px); color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; max-height:180px; overflow:auto; background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9); border-radius:6px; padding:6px 8px; }
  /* the structured tool-call tree (tracker item 4) */
  .tool .tool-duration { margin-left:auto; font-size:var(--text-xs, 12px); color:var(--muted,#635e56); font-variant-numeric:tabular-nums; }
  .tool .tool-status + .tool-duration { margin-left:8px; }
  .tool .tt-block { border-top:1px solid var(--border,#e3e0d9); }
  .tool .tt-block summary { list-style:none; cursor:pointer; display:flex; align-items:baseline; gap:8px; padding:4px 10px; color:var(--muted,#635e56); font-size:12px; user-select:none; }
  .tool .tt-block summary::-webkit-details-marker { display:none; }
  .tool .tt-block summary:hover { color:var(--text,#1d1b18); }
  .tool .tt-block-label { font-weight:600; color:var(--ink,#1d1b18); }
  .tool .tt-block-meta { color:var(--muted,#635e56); }
  /* The tree scrolls internally so ONE tool call can never flood the
     transcript (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 §7). At the row
     density below this cap holds ~9 rows — the same number the old, looser
     260px cap held, in 60px less. */
  .tool .tt-tree { padding:2px 6px 6px; max-height:360px; overflow:auto; }
  /* Show all lifts the inner scroll: a long result reads as one page
     (CAP-FB-20260901-TOOL-RESULT-FULL-JSON-01). */
  .tool .tt-block.tt-unbounded .tt-tree, .tool .tt-block.tt-unbounded .tt-raw { max-height:none; }
  /* The never-silent truncation note: the retained copy hit its cap. */
  .tool .tool-note { display:flex; align-items:flex-start; gap:8px; padding:8px 10px; border-top:1px solid var(--border,#e3e0d9);
    font-size:12px; line-height:1.45; color:var(--muted,#635e56); background:var(--panel-2,#efede8); }
  .tool .tool-note-ic { flex:0 0 auto; display:inline-flex; margin-top:1px; color:var(--accent,#0e6e63); }
  .tool .tool-note-text { min-width:0; overflow-wrap:anywhere; }
  .tool .tt-row { display:flex; align-items:center; gap:6px; padding:0 4px; border-radius:6px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.35; min-height:20px; }
  .tool .tt-row:hover { background:var(--panel-2,#efede8); }
  .tool .tt-row[hidden] { display:none; }
  .tool .tt-toggle { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; padding:0; border:0; background:transparent; color:var(--muted,#635e56); cursor:pointer; border-radius:4px; flex:0 0 auto; }
  .tool .tt-toggle:hover { color:var(--ink,#1d1b18); background:var(--panel-2,#efede8); }
  .tool .tt-toggle:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:0; }
  .tool .tt-toggle .tt-caret { transition:transform .15s ease; }
  .tool .tt-toggle[aria-expanded="true"] .tt-caret { transform:rotate(90deg); }
  .tool .tt-ic { width:18px; height:18px; flex:0 0 auto; }
  /* The collapsed head reads as a sentence: name, then what happened. */
  .tool .tool-head { display:flex; align-items:baseline; gap:8px; }
  .tool .tool-lead { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis;
    white-space:nowrap; color:var(--muted,#635e56); font-size:12.5px; }
  .tool .tool-lead.error { color:var(--danger,#b3261e); }
  .tool .tt-block-controls { margin-inline-start:auto; display:inline-flex; gap:4px; }
  .tool .tt-block-controls button { font:inherit; font-size:var(--text-xs, 12px); line-height:1; display:inline-flex; align-items:center; gap:4px;
    padding:3px 7px; border:1px solid var(--border,#e3e0d9); border-radius:999px;
    background:var(--panel,#ffffff); color:var(--muted,#635e56); cursor:pointer; }
  .tool .tt-block-controls button:hover { border-color:var(--accent,#0e6e63); color:var(--ink,#1d1b18); }
  .tool .tt-block-controls button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
  .tool .tt-block-controls button.on { background:var(--accent,#0e6e63); border-color:transparent; color:var(--btn-fg,#ffffff); }
  .tool .tt-btn-ic { display:inline-flex; flex:0 0 auto; }
  /* The complete pretty-printed JSON, coloured from the theme tokens: keys
     in the accent, strings in ink, numbers/booleans in the accent, null
     muted — the same vocabulary the tree rows use. */
  .tool .tt-raw { margin:0; padding:10px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    font-size:var(--text-xs, 12px); line-height:1.45; color:var(--ink,#1d1b18); background:var(--panel-2,#efede8);
    white-space:pre-wrap; word-break:break-word; overflow:auto; max-height:360px; tab-size:2; }
  .tool .tt-raw .tt-json-key { color:var(--accent,#0e6e63); font-weight:600; }
  .tool .tt-raw .tt-json-string { color:var(--ink,#1d1b18); }
  .tool .tt-raw .tt-json-number, .tool .tt-raw .tt-json-boolean { color:var(--accent,#0e6e63); }
  .tool .tt-raw .tt-json-null { color:var(--muted,#635e56); font-style:italic; }
  .tool .tt-raw .tt-json-punct { color:var(--muted,#635e56); }
  .tool .tt-raw::selection, .tool .tt-raw *::selection { background:var(--accent,#0e6e63); color:var(--btn-fg,#ffffff); }
  .tool .tt-key { color:var(--accent,#0e6e63); font-weight:600; white-space:nowrap; }
  .tool .tt-val { color:var(--ink,#1d1b18); overflow-wrap:anywhere; min-width:0; }
  .tool .tt-val-string { color:var(--ink,#1d1b18); }
  .tool .tt-val-number, .tool .tt-val-boolean { color:var(--accent,#0e6e63); }
  .tool .tt-val-null { color:var(--muted,#635e56); font-style:italic; }
  .tool .tt-kind { color:var(--muted,#635e56); font-size:var(--text-xs, 12px); margin-left:2px; }
  /* The row's identity. It takes the width so the type label is what gets
     squeezed on a narrow card, not the content. */
  .tool .tt-preview { color:var(--fg,#1c1a17); font-size:var(--text-xs, 12px); margin-left:6px;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1 1 auto; }
  .tool .tt-kind.muted { opacity:.6; flex:0 0 auto; }
  .tool .tt-copy { margin-left:auto; flex:0 0 auto; font:inherit; font-size:var(--text-xs, 12px); color:var(--muted,#635e56); background:transparent; border:1px solid var(--border,#e3e0d9); border-radius:5px; padding:1px 7px; cursor:pointer; opacity:0; transition:opacity .12s ease; }
  .tool .tt-row:hover .tt-copy, .tool .tt-copy:focus-visible { opacity:1; }
  .tool .tt-copy:hover { color:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); }
  .tool .tt-copy:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:0; }
  .tool .tool-plain { padding:6px 10px; font-size:12.5px; color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; border-top:1px solid var(--border,#e3e0d9); }
  .tool .tool-actions { display:flex; justify-content:flex-end; padding:7px 10px; border-top:1px solid var(--border,#e3e0d9); }
  .tool .site-activity { min-block-size:32px; max-inline-size:100%; padding:4px 9px; border:1px solid var(--border,#e3e0d9); border-radius:6px; background:transparent; color:var(--accent,#0e6e63); cursor:pointer; font:inherit; font-size:12px; font-weight:600; white-space:normal; overflow-wrap:anywhere; }
  .tool .site-activity:hover { border-color:var(--accent,#0e6e63); }
  .tool .site-activity:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
  .tool .site-activity:disabled { cursor:wait; opacity:.6; }
  @media (prefers-reduced-motion: reduce) { .tool .tt-toggle .tt-caret { transition:none; } .tool .tt-copy { transition:none; } }
`;

export class MessageBubble extends Component {
  static get observedAttributes() {
    return ["role", "content", "attachments", "streaming", "tool-name", "tool-status", "tool-args", "tool-result", "tool-detail", "tool-detail-note", "tool-duration", "site-activity", "step", "total-steps", "error-reason", "error-action", "error-category", "author", "author-avatar", "ts"];
  }
  // A long agent/system response is COLLAPSED to a preview with a
  // Show-full toggle (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01: the owner
  // wants to read the full response like a resource — the store now holds the
  // complete text; this makes a long one comfortable to read + copy).
  static get LONG_PREVIEW_CHARS() { return 4000; }
  static get LONG_COLLAPSED_PX() { return 260; }
  _longResponse(content) {
    return (this.getAttribute("role") === "agent" || this.getAttribute("role") === "system" || this.getAttribute("role") === "assistant") &&
      typeof content === "string" && content.length > MessageBubble.LONG_PREVIEW_CHARS;
  }
  _attachments() {
    const raw = this.getAttribute("attachments");
    if (!raw) return [];
    try {
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  }
  _content() {
    return this.hasAttribute("content") ? (this.getAttribute("content") ?? "") : (this.textContent ?? "");
  }
  /** Wire the long-response expander + copy. Extracted from _wire so the copy
   * source (the FULL stored content, never the DOM text) is unit-testable
   * (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01 r1 B4). */
  _wireLongResponse(long) {
    const toggle = long.querySelector(".long-toggle");
    const copy = long.querySelector(".long-copy");
    toggle?.addEventListener("click", () => {
      const open = long.getAttribute("data-open") === "1";
      long.setAttribute("data-open", open ? "0" : "1");
      toggle.setAttribute("aria-expanded", open ? "false" : "true");
      toggle.textContent = open ? "Show full response" : "Show less";
    });
    copy?.addEventListener("click", async () => {
      // Copy the COMPLETE stored response (the content attribute), never the
      // rendered DOM text (a preview/truncated slice would leak an incomplete
      // response to the clipboard).
      const text = this._content();
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch { /* clipboard unavailable */ }
        ta.remove();
      }
      if (copy) {
        const orig = copy.textContent;
        copy.textContent = "Copied";
        setTimeout(() => {
          if (copy.isConnected) copy.textContent = orig || "Copy full response";
        }, 1500);
      }
      if (typeof this.dispatchEvent === "function") {
        this.dispatchEvent(new CustomEvent("copy-message", {
          bubbles: true,
          composed: true,
          detail: { text, role: this.getAttribute("role") || "agent" },
        }));
      }
    });
  }
  /** Grow an agent bubble with streamed model text (CAP-FB-20260830-TRANSCRIPT-STREAMING-01).
   *  The deltas land in a hosted <streaming-text streaming> (text nodes only —
   *  untrusted model output never meets innerHTML mid-stream); the final
   *  sanitised markdown render happens when `content` is set, which replaces
   *  the streamed body in one paint. `aria-live` is deliberately NOT set on
   *  the growing text — the completed answer is announced once through the
   *  conversation log. Returns the accumulated streamed text. */
  appendText(delta) {
    if (!this._rendered) { this._rendered = true; this._render(); this._wire(); }
    let host = this._streamEl;
    if (!host || !host.isConnected) {
      const body = this._root.querySelector(".body");
      if (!body) return "";
      body.textContent = "";
      host = document.createElement("streaming-text");
      host.setAttribute("streaming", "");
      body.appendChild(host);
      this._streamEl = host;
      this.setAttribute("streaming", "");
    }
    return host.appendText(delta);
  }
  /** The text streamed into this bubble so far ("" when none). */
  get streamedText() { return this._streamEl?.streamedText ?? ""; }
  /** Reset the streamed body (a within-run retry restarts the answer). */
  resetStream() {
    if (this._streamEl) { this._streamEl.remove(); this._streamEl = null; }
    const body = this._root.querySelector(".body");
    if (body) body.textContent = "";
  }
  _render() {
    // A full render (a `content` change, or any observed attribute) drops the
    // streamed body: the final text replaces it.
    this._streamEl = null;
    const isStreaming = this.hasAttribute("streaming");
    if (!isStreaming && typeof this.removeAttribute === "function") this.removeAttribute("streaming");
    const role = this.getAttribute("role") || "agent";
    const content = this._content();
    let markup = "";
    if (role === "tool") {
      const name = this.getAttribute("tool-name") || "tool";
      const statusRaw = this.getAttribute("tool-status") || "running";
      const args = this.getAttribute("tool-args");
      const result = this.getAttribute("tool-result");
      const detail = this.getAttribute("tool-detail");
      const isSkipped = this.hasAttribute("skipped") || statusRaw === "skipped" ||
        isToolResultDeclined(result) || isToolResultDeclined(detail);
      if (isSkipped) {
        const text = `You skipped ${humanToolLabel(name).toLowerCase()}.`;
        markup = `<p class="skipped-line" role="status">${escapeHtml(text)}</p>`;
        mountTemplate(this, MESSAGE_BUBBLE_STYLE, markup);
        return;
      }
      // "done" (an unpaired replay card), "success" and "error" are terminal —
      // anything else (running/absent) renders the running state. A missing
      // result must never re-open a card as running (the replay blocker).
      const status = statusRaw === "done" || statusRaw === "success"
        ? "done"
        : statusRaw === "error" ? "error" : "running";
      // A FAILED tool call must never render the generated-UI preview: the
      // args alone carry the HTML (e.g. update_asset's content), so a denied
      // or errored call used to mount the sandbox frame and sit forever on
      // "Preparing restricted preview…" — a success-looking skeleton over a
      // result that says the opposite. Detect the failure (status attribute,
      // or the envelope's ok:false / error string, unwrapping the nested
      // modelContent/result layers) and fall through to the structured card,
      // which renders the error headline and opens itself.
      // The retained full copy (detail) is checked too: a nested error inside a
      // lazy ok:true envelope lives there (CAP-FB-20260901-TOOL-RESULT-FULL-JSON-01).
      const resultFailed = toolResultSignalsError(status, result) || toolResultSignalsError(status, detail);
      // The generative-UI tools (generate_ui / create_asset with type html)
      // or ANY tool outputting an HTML document render their HTML LIVE in the
      // sandboxed double-iframe, inline.
      let genHtml = null, genName = null;
      const checkCandidate = (cand) => {
        if (cand == null) return;
        try {
          const parsed = typeof cand === "string" ? JSON.parse(cand) : cand;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            if (typeof parsed.name === "string" && !genName) genName = parsed.name;
            if (typeof parsed.html === "string") genHtml = parsed.html;
            else if (parsed.type === "html" && typeof parsed.content === "string") genHtml = parsed.content;
            else if (parsed.asset && typeof parsed.asset === "object") {
              if (typeof parsed.asset.name === "string" && !genName) genName = parsed.asset.name;
              if (typeof parsed.asset.content === "string") genHtml = parsed.asset.content;
            } else if (typeof parsed.content === "string" && isHtmlDocument(parsed.content)) {
              genHtml = parsed.content;
            } else if (typeof parsed.result === "string" && isHtmlDocument(parsed.result)) {
              genHtml = parsed.result;
            }
          }
        } catch { /* may be raw HTML */ }
        if (genHtml == null && isHtmlDocument(cand)) genHtml = cand;
      };

      if (name === "generate_ui") {
        // generate_ui's HTML IS its result — it is not stored as an asset, so
        // the inline frame is the only place it renders.
        if (args != null) checkCandidate(args);
        if (genHtml == null && result != null) checkCandidate(result);
        if (genHtml == null && detail != null) checkCandidate(detail);
      } else if (name === "create_asset" || name === "update_asset") {
        // CAP-FB-20260830-THREAD-ARTIFACT-CARD-01: NEVER mount a frame for an
        // asset tool. The attribute strings are display-bounded (they end in an
        // ellipsis mid-document), so the frame painted a blank cream rectangle.
        // The real page renders in the <artifact-card> that follows this card,
        // whose preview is loaded FROM THE STORE (appendArtifact). Leave
        // genHtml null so this falls through to the structured tool card.
      } else {
        if (result != null) checkCandidate(result);
        if (genHtml == null && detail != null) checkCandidate(detail);
        if (genHtml == null && args != null) checkCandidate(args);
      }
      if (!resultFailed && genHtml != null && (isHtmlDocument(genHtml) || name === "generate_ui")) {
        const rawPayload = [
          args ? `Arguments:\n${args}` : "",
          result ? `Result:\n${result}` : "",
          detail ? `Detail:\n${detail}` : "",
        ].filter(Boolean).join("\n\n");

        // The card is titled with the ARTIFACT'S NAME: the args (create), the
        // returned asset (update), or the name the conversation already knows
        // for that id — never a meaningless generic head.
        const conversation = typeof this.closest === "function" ? this.closest("agent-conversation") : null;
        const cardTitle = genName || artifactCardTitle({
          toolName: name, args, result, detail,
          lookup: (id) => conversation?.artifactName?.(id) ?? null,
        });
        // Remember id → name from whatever this card knows (the create card's
        // raw result names the asset) so a later update card — and the durable
        // re-projection, whose persisted result is only a summary — can be titled.
        const identity = artifactIdentityFromPayloads([detail, result, args]);
        if (identity) conversation?.rememberArtifact?.(identity.id, identity.name);
        markup = `<div class="genui" role="status">
          <div class="genui-head">${escapeHtml(cardTitle)}</div>
          ${renderHtmlFrame(genHtml)}
          ${rawPayload ? `<details class="genui-raw"><summary>Raw payload</summary><pre class="tool-detail-raw">${escapeHtml(rawPayload)}</pre></details>` : ""}
        </div>`;
      } else {
        // The structured tool-call renderer: args/result/detail become a
        // bounded, collapsible tree when they parse; readable plain text
        // otherwise. Built as DOM (textContent — never unsafe innerHTML).
        markup = "";
        if (!this._ttExpanded) this._ttExpanded = new Map();
        this._cardDom = buildToolCardDom({
          name,
          // A done/success status with a FAILED result envelope must render as
          // the error card (open, error chip) — not a collapsed green "done".
          status: resultFailed ? "error" : status,
          args,
          result,
          detail,
          detailNote: this.getAttribute("tool-detail-note"),
          duration: this.getAttribute("tool-duration"),
          expandedState: this._ttExpanded,
          cardExpanded: this._toolCardExpanded === true,
          onCardToggle: (open) => { this._toolCardExpanded = open === true; },
          siteActivity: siteActivityAttribute(this.getAttribute("site-activity")),
        });
      }
    } else if (role === "thinking") {
      const step = this.getAttribute("step");
      const total = this.getAttribute("total-steps");
      const hasTrace = content && !/^thinking\.\.\.$/i.test(content.trim()) && !/^thinking…$/i.test(content.trim());
      const label = step != null ? `thinking · step ${step}${total ? ` of ${total}` : ""}` : "thinking";
      if (!hasTrace) {
        markup = `<div class="think" role="status"><div class="think-status" style="display:flex;align-items:center;gap:8px;color:var(--muted,#635e56);font-size:13px;padding:2px 0;"><span class="spin" aria-hidden="true"></span><span>${escapeHtml(label)}</span></div></div>`;
      } else {
        markup = `<details class="think"><summary><svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg><span>${escapeHtml(label)}</span></summary><div class="trace">${escapeHtml(content)}</div></details>`;
      }
    } else if (role === "error") {
      // The comprehensive error: the category + the UNDERLYING reason (danger,
      // prominent) + the actionable "what to do" (plain ink) — never a raw
      // "No output generated. Check the stream for errors". A provider/config
      // failure gets a "Fix in Settings" button (the actionable path: the
      // provider pane's Test/Use button grants the host permission + tests the
      // key).
      const reason = this.getAttribute("error-reason") || content;
      const action = this.getAttribute("error-action") || "";
      const category = this.getAttribute("error-category") || "";
      const fixable = /host-permission|provider-auth|provider-config|model-config|network/i.test(category);
      const isStreaming = this.hasAttribute("streaming");
      markup = `<div class="msg error"><div class="body">
        <p class="err-reason">${escapeHtml(reason)}</p>
        ${action ? `<p class="err-action">${escapeHtml(action)}</p>` : ""}
        <div class="err-fix-row">
          ${!isStreaming ? `<button type="button" class="err-retry" part="retry">Retry</button>` : ""}
          ${fixable ? `<button type="button" class="err-fix" part="fix">Fix in Settings</button>` : ""}
        </div>
      </div></div>`;
    } else {
      let body;
      const cleanContent = (role === "agent" || role === "system" || role === "assistant")
        ? stripModelAddressedText(content)
        : content;
      if ((role === "agent" || role === "system" || role === "assistant") && isHtmlDocument(cleanContent)) {
        body = renderHtmlFrame(cleanContent);
      } else {
        body = (role === "agent" || role === "system" || role === "user" || role === "assistant") ? renderMarkdown(cleanContent) : `<span class="plain">${renderInline(cleanContent)}</span>`;
      }
      // Inline attachments: image attachments render as a thumbnail so the user
      // can SEE what they attached; other media render as a file chip.
      const atts = this._attachments();
      let attachHtml = "";
      if (atts.length) {
        const pieces = atts.map((a) => {
          const type = String(a?.type ?? "").toLowerCase();
          const url = String(a?.dataURL ?? "");
          const name = String(a?.name ?? "attachment");
          if (url.startsWith("data:image/") || type.startsWith("image/")) {
            return `<img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy">`;
          }
          return `<span class="file-chip">${escapeHtml(name)}</span>`;
        });
        attachHtml = `<div class="attach">${pieces.join("")}</div>`;
      }
      const isAgentRole = role === "agent" || role === "assistant";
      const copyBtn = (!isStreaming && isAgentRole && !this._longResponse(content))
        ? `<button type="button" class="msg-copy-btn" part="copy-btn" aria-label="Copy response" title="Copy response">Copy</button>`
        : "";
      const bubble = `<div class="msg ${role}">${attachHtml}<div class="body">${body}</div>${copyBtn}</div>`;
      let bubbleOut = bubble;
      if (this._longResponse(content)) {
        bubbleOut = `<div class="long-response" data-open="0"><div class="body">${body}</div>`
          + `<div class="long-actions"><button type="button" class="long-toggle" part="long-toggle" aria-expanded="false">Show full response</button>`
          + `<button type="button" class="long-copy" part="long-copy">Copy full response</button></div></div>`;
      }
      if (role === "agent" || role === "assistant") {
        const rawAuthor = this.getAttribute("author");
        const author = (!rawAuthor || rawAuthor === "Agent") ? "Assistant" : rawAuthor;
        const avatar = this.getAttribute("author-avatar") || "";
        const ts = this.getAttribute("ts") || "";
        markup = `<div class="turn"><agent-identity name="${escapeHtml(author)}"${avatar ? ` avatar="${escapeHtml(avatar)}"` : ""}${ts ? ` time="${escapeHtml(ts)}"` : ""}></agent-identity>${bubbleOut}</div>`;
      } else {
        markup = bubbleOut;
      }
    }
    if (typeof this._root.appendChild === "function" && (this._root.nodeType !== undefined || this._root._children !== undefined || this._root.children !== undefined)) {
      if (!this._bodyWrap || this._bodyWrap.parentNode !== this._root) {
        this._root.innerHTML = "";
        adoptOrInjectStyle(this._root, MESSAGE_BUBBLE_STYLE);
        this._styleEl = typeof this._root.querySelector === "function" ? this._root.querySelector("style") : null;
        const doc = this._root.ownerDocument || (typeof document !== "undefined" ? document : null);
        if (doc && typeof doc.createElement === "function") {
          this._bodyWrap = doc.createElement("div");
          this._bodyWrap.className = "bubble-wrap";
          if (this._bodyWrap.style) this._bodyWrap.style.display = "contents";
          this._root.appendChild(this._bodyWrap);
        }
      }
      if (this._bodyWrap) {
        this._bodyWrap.innerHTML = markup;
        if (this._cardDom) {
          this._bodyWrap.appendChild(this._cardDom);
          this._cardDom = null;
        }
      } else {
        this._root.innerHTML = markup;
      }
    } else {
      mountTemplate(this, MESSAGE_BUBBLE_STYLE, markup);
      if (this._cardDom) {
        if (typeof this._root.appendChild === "function") this._root.appendChild(this._cardDom);
        this._cardDom = null;
      }
    }
  }
  _wire() {
    // Long-response toggle: reveal the FULL text (the store holds it complete)
    // and offer a copy of the whole response (CAP-FB-20260831-TASK-VIEW-FULL-RESPONSE-01).
    const long = this._root.querySelector(".long-response");
    if (long) this._wireLongResponse(long);
    const copyBtn = this._root.querySelector(".msg-copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        const text = this._content();
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); } catch { /* ignore */ }
          ta.remove();
        }
        const orig = copyBtn.textContent;
        copyBtn.textContent = "Copied";
        setTimeout(() => {
          if (copyBtn.isConnected) copyBtn.textContent = orig || "Copy";
        }, 1500);
        if (typeof this.dispatchEvent === "function") {
          this.dispatchEvent(new CustomEvent("copy-message", {
            bubbles: true,
            composed: true,
            detail: { text, role: this.getAttribute("role") || "agent" },
          }));
        }
      });
    }
    this._root.querySelector(".err-retry")?.addEventListener("click", () => {
      if (typeof this.dispatchEvent === "function") {
        this.dispatchEvent(new CustomEvent("retry-turn", {
          bubbles: true,
          composed: true,
          detail: {
            errorReason: this.getAttribute("error-reason") || this._content(),
            errorAction: this.getAttribute("error-action") || "",
            errorCategory: this.getAttribute("error-category") || "",
          },
        }));
      }
    });
    // The "Fix in Settings" button on a provider/config error: open the options
    // page (the provider pane's Test/Use button grants the host permission +
    // tests the key — the actionable path for a provider failure).
    this._root.querySelector(".err-fix")?.addEventListener("click", () => {
      const fixHref = "options/options.html#provider";
      const ev = new CustomEvent("fix-settings", {
        bubbles: true,
        composed: true,
        cancelable: true,
        detail: { href: fixHref },
      });
      if (typeof this.dispatchEvent === "function") {
        this.dispatchEvent(ev);
      }
      if (!ev.defaultPrevented && typeof chrome !== "undefined" && chrome.runtime?.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      }
    });
    this._root.querySelector(".site-activity")?.addEventListener("click", async (event) => {
      const activity = siteActivityAttribute(this.getAttribute("site-activity"));
      const button = event.currentTarget;
      if (!activity || typeof chrome === "undefined" || !chrome.storage?.session?.set || !chrome.runtime?.openOptionsPage) return;
      button.disabled = true;
      try {
        await chrome.storage.session.set({
          [SITE_ACTIVITY_FOCUS_KEY]: { ...activity, at: Date.now() },
        });
        await chrome.runtime.openOptionsPage();
      } catch {
        button.textContent = "Could not open activity";
      } finally {
        button.disabled = false;
      }
    });
    // Percolate the current theme/locale into any rendered-HTML frame (the
    // co-do generative-UI): wire the validated postMessage down-channel when a
    // message renders a generated UI document.
    if (this._frameCleanups) {
      this._frameCleanups.forEach((c) => { try { c(); } catch { /* noop */ } });
    }
    this._frameCleanups = [];
    const pref = currentFramePreference();
    this._root.querySelectorAll?.(".html-frame").forEach((frame) => {
      const nonce = frame.dataset?.frameNonce;
      if (nonce) this._frameCleanups.push(wireHtmlFramePreference(frame, { nonce, ...pref }));
      // Deliver the staged guarded HTML to the sandbox-host iframe (the string
      // renderer cannot postMessage — wire it here after the markup mounted).
      this._frameCleanups.push(wireHtmlFrameContent(frame));
    });
  }
  disconnectedCallback() {
    if (this._frameCleanups) {
      this._frameCleanups.forEach((c) => { try { c(); } catch { /* noop */ } });
      this._frameCleanups = [];
    }
    super.disconnectedCallback();
  }
}
customElements.define("message-bubble", MessageBubble);

// Inline citation superscripts: locate each citation's citedText in the agent
// bubble's rendered body and append a superscript link after the match. The
// body is markdown-rendered HTML inside the bubble's shadow root; matching is
// text-node based (never innerHTML mutation — no HTML-injection sink), and a
// miss is silent (the sources list still carries the attribution).
function applyInlineCitations(bubble, citations) {
  try {
    const root = bubble?._root ?? bubble?.shadowRoot;
    const body = root?.querySelector?.(".body");
    if (!body) return;
    const withText = (Array.isArray(citations) ? citations : [])
      .map((c, i) => ({ c, n: i + 1 }))
      .filter(({ c }) => typeof c?.citedText === "string" && c.citedText.length >= 8 && /^https:\/\//u.test(String(c?.url ?? "")));
    if (withText.length === 0) return;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    for (const { c, n } of withText.slice(0, 16)) {
      const needle = c.citedText;
      for (const textNode of nodes) {
        const idx = textNode.nodeValue?.indexOf(needle) ?? -1;
        if (idx < 0) continue;
        const sup = document.createElement("sup");
        const a = document.createElement("a");
        a.href = String(c.url);
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "cite-ref";
        a.textContent = `[${n}]`;
        a.title = String(c.title ?? c.url).slice(0, 200);
        sup.appendChild(a);
        const after = textNode.splitText(idx + needle.length);
        textNode.parentNode.insertBefore(sup, after);
        break;
      }
    }
  } catch { /* rendering must never break the conversation */ }
}

/* <agent-conversation messages='[{role,content,…}]'>
 * The unified conversational surface (the "Now" section + the chat). A
 * light-DOM flex column that hosts <message-bubble> children. Imperative API:
 *   appendUser(text) / appendAgent(text) / appendSystem(text)
 *   appendThinking(text, {step,totalSteps}) / appendTool({name,args,status,result})
 *   appendError(text) / clear() / setMessages(messages)
 * The `messages` attribute populates it declaratively for the showcase. */
// A subtle-timestamp helper (item: the task view shows a timestamp only at
// significant time gaps, not on every message). A gap >= 5 minutes marks a
// meaningful boundary (the task started, then a gap, then it finished); the
// rapid thinking/tool messages in between stay unmarked.
export const TS_GAP_MS = 5 * 60 * 1000;

/** Preserve prose while carrying structured tool payloads through DOM attributes. */
export function toolPayloadAttribute(value) {
  if (value == null) return null;
  return typeof value === "string" ? value : safeJsonStringify(value);
}

export function formatTsLabel(ts) {
  if (!Number.isFinite(ts)) return "";
  const d = new Date(ts);
  const delta = Date.now() - ts;
  if (delta < 60 * 1000) return "just now";
  if (delta < 60 * 60 * 1000) return `${Math.max(1, Math.round(delta / 60000))}m ago`;
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export class AgentConversation extends Component {
  static shadow() { return false; }
  static get observedAttributes() { return ["messages", "agent-name", "agent-avatar"]; }
  /** The identity assistant turns carry (avatar + name); the page sets it for
   *  the agent the thread belongs to. */
  setIdentity({ name, avatar } = {}) {
    if (typeof name === "string" && name.trim()) this.setAttribute("agent-name", name.trim());
    else this.removeAttribute("agent-name");
    if (typeof avatar === "string" && avatar) this.setAttribute("agent-avatar", avatar);
    else this.removeAttribute("agent-avatar");
  }
  _identityAttrs(ts) {
    const rawName = this.getAttribute("agent-name");
    const author = (!rawName || rawName === "Agent") ? "Assistant" : rawName;
    return {
      author,
      "author-avatar": this.getAttribute("agent-avatar") || null,
      ts: String(typeof ts === "number" && ts > 0 ? ts : Date.now()),
    };
  }
  /** id → name registry so a later card (update_asset carries only the id)
   *  can be titled with the artifact's name. Bounded. */
  rememberArtifact(id, name) {
    if (typeof id !== "string" || !id || typeof name !== "string" || !name.trim()) return;
    if (!this._artifactNames) this._artifactNames = new Map();
    if (this._artifactNames.size >= 200 && !this._artifactNames.has(id)) {
      this._artifactNames.delete(this._artifactNames.keys().next().value);
    }
    this._artifactNames.set(id, name.trim());
  }
  artifactName(id) { return this._artifactNames?.get(id) ?? null; }
  // ── stick-to-bottom scrolling ─────────────────────────────────────────
  // The conversation is content-height; the SCROLL CONTAINER is whichever
  // ancestor scrolls (the thread body on the hub, the panel itself in the side
  // panel, or this element when it is styled to scroll). Every append scrolls
  // to the newest content unless the owner has scrolled up to read (the
  // latch, isScrolledToBottom with a 24px slack); the owner's own send always
  // re-sticks. Content that grows AFTER its append (a streaming bubble, a
  // rendered frame, a tool result) keeps the view pinned through a
  // ResizeObserver on this element's box.
  _scroller() {
    if (this._scrollHost?.isConnected) return this._scrollHost;
    let el = this;
    while (el && el !== document.documentElement) {
      let overflow = "";
      try { overflow = getComputedStyle(el).overflowY; } catch { overflow = ""; }
      if (overflow === "auto" || overflow === "scroll") break;
      el = el.parentElement;
    }
    const host = el && el !== document.documentElement ? el : (document.scrollingElement ?? this);
    if (host !== this._scrollHost) {
      this._scrollCleanup?.();
      this._scrollHost = host;
      this._stuck = true;
      const onScroll = () => { this._stuck = isScrolledToBottom(host); };
      host.addEventListener("scroll", onScroll, { passive: true });
      // A viewport resize shrinks the scroll container: stay pinned to the
      // newest turn rather than leaving it under the docked composer.
      if (host !== this && this._growth && host instanceof Element) this._growth.observe(host);
      this._scrollCleanup = () => {
        host.removeEventListener("scroll", onScroll);
        if (host !== this && host instanceof Element) this._growth?.unobserve?.(host);
      };
    }
    return host;
  }
  _scrollToBottom(force = false) {
    const host = this._scroller();
    if (!host) return;
    if (force) this._stuck = true;
    if (!this._stuck) return;
    host.scrollTop = host.scrollHeight;
  }
  _observeGrowth() {
    if (this._growth || typeof ResizeObserver === "undefined") return;
    this._growth = new ResizeObserver(() => { if (this._stuck) this._scrollToBottom(); });
    this._growth.observe(this);
  }
  connectedCallback() {
    super.connectedCallback();
    this._observeGrowth();
  }
  disconnectedCallback() {
    this._growth?.disconnect();
    this._growth = null;
    this._scrollCleanup?.();
    this._scrollCleanup = null;
    this._scrollHost = null;
    super.disconnectedCallback();
  }
  _render() {
    ensureStyle("sc-agent-conversation-style", `
      agent-conversation { display:flex; flex-direction:column; min-height:0; }
      agent-conversation .empty { color:var(--muted,#635e56); font-size:var(--text-sm,13px); padding:2px 0; }
      agent-conversation .run-group { content-visibility: auto; contain-intrinsic-size: auto 64px; }
      agent-conversation .ts-gap { align-self:center; margin:10px 0 4px; font-size:var(--text-xs,12px); color:var(--muted,#635e56); letter-spacing:.02em; user-select:none; }
      agent-conversation .citation-sources { display:flex; flex-wrap:wrap; gap:4px 10px; align-items:baseline; margin:2px 0 6px 8px; font-size:var(--text-xs,12px); }
      agent-conversation .citation-sources-label { color:var(--muted,#635e56); font-weight:600; margin-right:2px; }
      agent-conversation .citation-link { color:var(--accent,#0e6e63); text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:32ch; display:inline-block; vertical-align:bottom; }
      agent-conversation .citation-link:hover { text-decoration:underline; }
      message-bubble .cite-ref a, .cite-ref a { color:var(--accent,#0e6e63); text-decoration:none; font-size:0.75em; }
      /* An artifact is a deliverable, not a chat line: it gets its own block on
         the 8px grid rather than being squeezed into the bubble column. */
      agent-conversation .msg-artifact { margin:var(--space-2,8px) 0; max-width:min(560px, 100%); }
      /* The generated-image strip is a row of deliverables, not a chat line. */
      agent-conversation .msg-images { margin:var(--space-2,8px) 0; max-width:min(560px, 100%); }
      /* The edit affordance under an updated artifact: what changed, and a way
         to see it. Quiet by default — one accent, actions only (PRODUCT.md). */
      agent-conversation .artifact-change { display:flex; align-items:center; gap:var(--space-2,8px);
        margin:var(--space-1,4px) 0 0; font-size:var(--text-xs,12px); color:var(--muted,#635e56); }
      agent-conversation .artifact-change .change-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      agent-conversation .artifact-change .delta { font-variant-numeric:tabular-nums; }
      agent-conversation .artifact-change .delta .add { color:var(--success,#1f7a4d); }
      agent-conversation .artifact-change .delta .del { color:var(--danger,#b3261e); }
      agent-conversation .artifact-change .view-diff { flex:0 0 auto; font:inherit; font-size:var(--text-xs,12px);
        padding:2px 8px; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,6px);
        background:transparent; color:var(--text,#1d1b18); cursor:pointer; }
      agent-conversation .artifact-change .view-diff:hover { border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      agent-conversation .artifact-change .view-diff:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
      /* The ONE live run-status surface: an inline row pinned (sticky) at the
         bottom of the conversation viewport while a run is live — always
         visible, part of the conversation flow (owner 2026-08-28: the label
         belongs inline at the bottom of the chat, not as a separate banner
         duplicating the running entry beneath it). */
      agent-conversation .live-status { position: sticky; bottom: var(--conversation-dock, 0px); z-index: 2; margin-block-start: 8px; flex: 0 0 auto; }
      /* The live thinking trace (chrome-agent-platform-h0iy): a collapsible
         region under the live-status row, present only while a provider is
         streaming thinking tokens. Muted, monospace-free, bounded height. */
      agent-conversation .thinking-trace { flex: 0 0 auto; margin-block-start: 4px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-subtle, #f6f5f2); overflow: hidden; }
      agent-conversation .thinking-trace-toggle { display: flex; align-items: center; gap: 6px; width: 100%; border: 0; background: none; padding: 6px 10px; font: inherit; font-size: 12px; color: var(--muted); cursor: pointer; text-align: left; }
      agent-conversation .thinking-trace-toggle:hover { color: var(--text, #24231f); }
      agent-conversation .thinking-trace-toggle:focus-visible { outline: 2px solid var(--accent, #0e6e63); outline-offset: -2px; }
      agent-conversation .thinking-trace-body { padding: 0 10px 8px; max-height: 160px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.45; color: var(--muted); }
      agent-conversation .thinking-trace[data-open="false"] .thinking-trace-body { display: none; }
      agent-conversation .thinking-trace[data-open="false"] .thinking-trace-caret { display: inline-block; transform: rotate(0deg); }
      agent-conversation .thinking-trace[data-open="true"] .thinking-trace-caret { display: inline-block; transform: rotate(90deg); }
    `);
    const msgs = this.getAttribute("messages");
    if (msgs != null) this.setMessages(parseJSONAttr(msgs, []));
  }
  attributeChangedCallback(name, ov, nv) {
    if (name === "messages" && ov !== nv && this._rendered) {
      this.setMessages(parseJSONAttr(nv, []));
    }
  }
  // Every transcript append goes through here: while the live-status row is
  // connected, new content inserts BEFORE it so the row stays the LAST child
  // (the pinned bottom-of-flow invariant) no matter what lands mid-run —
  // tool cards, error bubbles, permission cards, artifact blocks (review
  // P1-a: appends used to land AFTER the row, leaving it mid-transcript).
  appendTranscript(node, { force = false } = {}) {
    const row = this._liveStatusRow;
    if (row && row.isConnected) this.insertBefore(node, row);
    else this.appendChild(node);
    this._scrollToBottom(force);
    return node;
  }
  _bubble(role, content, extra) {
    const b = document.createElement("message-bubble");
    b.setAttribute("role", role);
    if (content != null) b.setAttribute("content", String(content));
    if (extra) for (const [k, v] of Object.entries(extra)) {
      if (v == null) continue;
      if (v === "") b.setAttribute(k, "");
      else b.setAttribute(k, String(v));
    }
    // The owner's own message always re-sticks the view to the bottom.
    return this.appendTranscript(b, { force: role === "user" });
  }
  // A subtle timestamp divider, inserted ONLY when there is a SIGNIFICANT time
  // gap between consecutive persisted messages (or at the first message — the
  // "task started" boundary). Rapid messages (the thinking loop) get no marker.
  _maybeTsGap(ts) {
    if (!ts || typeof ts !== "number") return;
    const last = this._lastTs;
    // First message of the conversation always gets a marker; after that only
    // a gap larger than TS_GAP_MS warrants one.
    const significant = last == null || ts - last >= TS_GAP_MS;
    this._lastTs = ts;
    if (!significant) return;
    const d = document.createElement("div");
    d.className = "ts-gap";
    d.textContent = formatTsLabel(ts);
    this.appendTranscript(d);
  }
  appendUser(text, ts, attachments) { if (ts) this._maybeTsGap(ts); return this._bubble("user", text, attachments?.length ? { attachments: JSON.stringify(attachments) } : null); }
  appendAgent(text, ts) { if (ts) this._maybeTsGap(ts); return this._bubble("agent", text, this._identityAttrs(ts)); }
  /** Render-only provider-server rows for a message: the collapsed tool-step
   *  card per executed provider-side query ("🔎 Searched: …" — NEVER routed
   *  back through the agent loop) + a bounded sources list with clickable
   *  citation links. Where a citation carries a citedText range, the agent
   *  bubble's rendered body gets an inline superscript link at the first
   *  matching text occurrence (best-effort; the sources list is the
   *  always-present attribution). */
  appendServerToolRows(m = {}) {
    const events = Array.isArray(m.serverToolEvents) ? m.serverToolEvents.slice(0, 16) : [];
    const citations = Array.isArray(m.citations) ? m.citations.slice(0, 32) : [];
    if (events.length === 0 && citations.length === 0) return;
    // Capture the answer bubble BEFORE appending any cards — the inline
    // citation superscripts splice into ITS rendered body.
    const answerBubble = this.lastElementChild?.tagName === "MESSAGE-BUBBLE" &&
      this.lastElementChild.getAttribute("role") === "agent"
      ? this.lastElementChild : null;
    for (const ev of events) {
      const query = String(ev?.query ?? "").slice(0, 512);
      if (!query) continue;
      this.appendTool({
        name: `provider:${ev?.kind ?? "server-tool"}`,
        status: "done",
        args: { query },
        // Provider-executed Gemini google_search and Anthropic web_search rows
        // use the same JSON tree as client tools; source links remain below.
        result: ev,
      });
    }
    if (citations.length > 0) {
      if (answerBubble) applyInlineCitations(answerBubble, citations);
      const wrap = document.createElement("div");
      wrap.className = "citation-sources";
      const label = document.createElement("span");
      label.className = "citation-sources-label";
      label.textContent = "Sources";
      wrap.appendChild(label);
      citations.forEach((c, i) => {
        const url = String(c?.url ?? "");
        if (!/^https:\/\//u.test(url)) return; // https only — never javascript:
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.className = "citation-link";
        a.textContent = `[${i + 1}] ${String(c?.title ?? url).slice(0, 120)}`;
        wrap.appendChild(a);
      });
      this.appendChild(wrap);
      this._scrollToBottom();
    }
  }
  appendSystem(text, ts) { if (ts) this._maybeTsGap(ts); return this._bubble("system", text); }
  /** chrome-agent-platform-afiu: an OWNER INTERRUPTION — the message the owner
   *  steered into a running agent. Rendered as its own right-aligned bubble
   *  (the "You steered" treatment) so a steer reads as guidance the agent is
   *  now following, never as an assistant or tool row. */
  appendSteer(text, ts) {
    if (ts) this._maybeTsGap(ts);
    const bubble = this._bubble("steer", String(text ?? ""));
    const label = document.createElement("span");
    label.className = "steer-label";
    label.textContent = "You steered";
    bubble._root?.querySelector(".msg")?.prepend(label);
    return bubble;
  }
  appendError(text, { reason, action, category, ts } = {}) {
    if (ts) this._maybeTsGap(ts);
    return this._bubble("error", text, { "error-reason": reason ?? null, "error-action": action ?? null, "error-category": category ?? null });
  }
  appendThinking(text, { step, totalSteps } = {}) {
    return this._bubble("thinking", text, { step, "total-steps": totalSteps });
  }
  /** An artifact produced by this run, rendered in the thread that made it
   *  (CAP-FB-20260828-ARTIFACTS-IN-THREAD-01). Reuses the SAME <artifact-card>
   *  the library uses — a second, thread-only rendering of an artifact is
   *  exactly the hand-rolled duplication that produced the toggle and menu
   *  bugs. Events bubble, so the host page wires open / open-tab / reuse once
   *  and both surfaces behave identically. */
  appendArtifact(m = {}) {
    const a = m.artifact ?? m;
    if (!a || typeof a !== "object" || !a.id) return null;
    if (typeof m.ts === "number") this._maybeTsGap(m.ts);
    const origin = String(a.origin ?? "master");
    const id = String(a.id);
    // An update_asset card's descriptor can arrive thin ("Untitled") because the
    // bounded result dropped the asset object — resolve the name from the id→name
    // registry the create card populated, and let the store fetch below fill the
    // rest. The store is the source of truth; the descriptor is a hint.
    const descName = typeof a.name === "string" && a.name && a.name !== "Untitled" ? a.name : null;
    const name = descName ?? this.artifactName(id) ?? "Untitled";
    const wrap = document.createElement("div");
    wrap.className = "msg-artifact";
    const card = document.createElement("artifact-card");
    card.setAttribute("id", id);
    card.setAttribute("name", name);
    card.setAttribute("type", String(a.type ?? "data"));
    card.setAttribute("size", String(a.size ?? 0));
    card.setAttribute("origin", origin);
    if (a.at != null) card.setAttribute("time", String(a.at));
    // Only what the thread actually handles.
    card.setAttribute("actions", "open-tab reuse save");
    wrap.appendChild(card);
    // THE PREVIEW COMES FROM THE STORE, never from the tool-result text
    // (CAP-FB-20260830-THREAD-ARTIFACT-CARD-01 / the TOOL-RESULT-ENVELOPE rule):
    // the args string is display-bounded and paints a blank frame. Same read
    // the library does (artifacts/index.js) so both surfaces show the page.
    this._loadArtifactPreview(card, origin, id);
    // An UPDATE (version > 1) says what changed and offers the diff. A fresh
    // create has no prior version to compare.
    const version = Number.isSafeInteger(a.version) ? a.version : null;
    if ((a.updated === true || (version != null && version > 1)) && version != null && version > 1) {
      wrap.appendChild(this._artifactChangeRow(origin, id, name, version));
    }
    this.rememberArtifact(id, typeof a.name === "string" ? a.name : "");
    this.appendTranscript(wrap);
    return card;
  }
  /** Load an artifact-card's live preview AND authoritative name/type/size from
   *  the asset store — the store is the source of truth, the tool result only a
   *  hint (a bounded update result carries no name/type at all). Bounded and
   *  best-effort: a slow or absent worker leaves the card's type placeholder.
   *
   *  DEFERRED: a reopened long thread mounts dozens of artifact cards at once,
   *  and an eager load fires every asset.get RPC synchronously — flooding the
   *  worker with offscreen reads. The card's preview load waits until the card
   *  is actually visible (IntersectionObserver); when the observer API is
   *  absent (unit-test harnesses, very old browsers) the load is immediate,
   *  preserving the eager contract everywhere else. */
  _loadArtifactPreview(card, origin, id) {
    if (!RUNTIME_SEND) return;
    if (typeof IntersectionObserver === "undefined") {
      this._previewNow(card, origin, id);
      return;
    }
    const obs = this._previewObserver ?? (this._previewObserver = new IntersectionObserver((entries) => {
      // Visible → load; disconnected → drop its pending job. A connected,
      // not-yet-visible card keeps waiting (that is the deferral). The job
      // rides on the card itself; ONE observer serves the whole conversation.
      for (const entry of entries) {
        const target = entry.target;
        const job = target._pendingPreview;
        if (!job) continue;
        if (entry.isIntersecting || !target.isConnected) {
          target._pendingPreview = null;
          obs.unobserve(target);
          if (entry.isIntersecting && target.isConnected) this._previewNow(target, job[0], job[1]);
        }
      }
    }));
    card._pendingPreview = [origin, id];
    obs.observe(card);
  }
  /** The eager read itself — invoked on first visibility (or immediately when
   *  no IntersectionObserver exists). RUNTIME_SEND is checked by the only
   *  caller; it is a module const and cannot change across the deferral. */
  _previewNow(card, origin, id) {
    RUNTIME_SEND("asset.get", { origin, id }).then((full) => {
      if (!full?.ok || !full.asset || !card.isConnected) return;
      const asset = full.asset;
      // Type first (the card picks the preview surface from it), then name/size,
      // then the preview content — one set of attribute writes, one re-render.
      if (typeof asset.type === "string" && asset.type) card.setAttribute("type", asset.type);
      if (typeof asset.name === "string" && asset.name) {
        card.setAttribute("name", asset.name);
        this.rememberArtifact(id, asset.name);
      }
      if (Number.isFinite(asset.size)) card.setAttribute("size", String(asset.size));
      card.preview = typeof asset.content === "string" ? asset.content : "";
    }).catch(() => { /* the placeholder stays — no blank frame */ });
  }
  /** The "Updated <name> (+n −m) [View diff]" row under an edited artifact.
   *  The delta is computed from the versions store (never the tool text); the
   *  button emits `view-diff` with the version range for the host to open. */
  _artifactChangeRow(origin, id, name, toVersion) {
    const row = document.createElement("div");
    row.className = "artifact-change";
    const label = document.createElement("span");
    label.className = "change-label";
    label.textContent = `Updated ${name} `;
    const delta = document.createElement("span");
    delta.className = "delta";
    label.appendChild(delta);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "view-diff";
    btn.textContent = "View diff";
    btn.setAttribute("aria-label", `View what changed in ${name}`);
    const fromVersion = toVersion - 1;
    btn.addEventListener("click", () => this._emit("view-diff", { id, origin, name, fromVersion, toVersion }));
    row.append(label, btn);
    // Fill "+n −m" from the two version bodies; keep it silent on failure so
    // the row still offers the diff.
    if (RUNTIME_SEND) {
      Promise.all([
        RUNTIME_SEND("asset.version-get", { origin, id, n: fromVersion }),
        RUNTIME_SEND("asset.version-get", { origin, id, n: toVersion }),
      ]).then(([before, after]) => {
        if (!row.isConnected) return;
        const b = before?.ok ? String(before.content ?? "") : null;
        const c = after?.ok ? String(after.content ?? "") : null;
        if (b == null || c == null) return;
        const { added, removed } = lineDiffSummary(b, c);
        delta.replaceChildren();
        const add = document.createElement("span");
        add.className = "add";
        add.textContent = `+${added}`;
        const del = document.createElement("span");
        del.className = "del";
        del.textContent = `−${removed}`;
        delta.append("(", add, " ", del, ")");
      }).catch(() => { /* no delta — the View diff button is still there */ });
    }
    return row;
  }

  /** The generated-image strip under a turn (CAP-FB-20260830-GENERATED-IMAGE-
   *  STRIP-01): every screenshot the run captured and every image asset it
   *  produced, as a `<screenshot-strip>` whose thumbnails are resolved from the
   *  stores by id (screenshots.get / asset.get) — image bytes never come from
   *  the tool result. Clicking a thumbnail bubbles `open-image` for the host to
   *  open the viewer. Reuses the shared component — never a second strip. */
  appendImages(m = {}) {
    const items = Array.isArray(m.items) ? m.items.filter((it) => it && typeof it.id === "string" && it.id) : [];
    if (!items.length) return null;
    if (typeof m.ts === "number") this._maybeTsGap(m.ts);
    const wrap = document.createElement("div");
    wrap.className = "msg-images";
    const strip = document.createElement("screenshot-strip");
    if (m.max != null) strip.setAttribute("max", String(m.max));
    wrap.appendChild(strip);
    // Resolve each id to a data URL from its store; keep the item order.
    const resolve = async () => {
      const shots = await Promise.all(items.map(async (it) => {
        let url = "";
        try {
          if (it.kind === "image") {
            const res = await RUNTIME_SEND?.("asset.get", { origin: it.origin ?? "master", id: it.id });
            url = res?.ok && typeof res.asset?.content === "string" ? res.asset.content : "";
          } else {
            const res = await RUNTIME_SEND?.("screenshots.get", { id: it.id });
            url = typeof res?.dataURL === "string" ? res.dataURL : "";
          }
        } catch { url = ""; }
        return { url, label: typeof it.label === "string" ? it.label : "", kind: it.kind === "image" ? "image" : "screenshot" };
      }));
      if (strip.isConnected) strip.setAttribute("shots", JSON.stringify(shots.filter((s) => s.url)));
    };
    if (RUNTIME_SEND) resolve();
    // Clicking a thumbnail: map the index back to the item and ask the host to
    // open it (image → artifact viewer, screenshot → its own viewer).
    strip.addEventListener("open", (ev) => {
      const idx = Number(ev?.detail?.index);
      const it = items[idx] ?? items[0];
      if (it) this._emit("open-image", { id: it.id, kind: it.kind === "image" ? "image" : "screenshot", origin: it.origin ?? "master", overflow: ev?.detail?.overflow === true });
    });
    return this.appendTranscript(wrap);
  }

  appendTool(m = {}) {
    // Accept both the imperative {name,args,status,result,detail} and the
    // message object {tool-name,tool-status,tool-args,tool-result,tool-detail}
    // conventions. Strings stay strings so prose remains prose; structured
    // values become valid JSON attributes for the shared tree renderer.
    // `ts` (optional) participates in the subtle timestamp-gap divider.
    const name = m.name ?? m["tool-name"];
    const status = m.status ?? m["tool-status"];
    const args = m.args ?? m["tool-args"];
    const result = m.result ?? m["tool-result"];
    const detail = m.detail ?? m["tool-detail"];
    const detailNote = m.detailNote ?? m["tool-detail-note"];
    const durationMs = m.durationMs ?? m["tool-duration"];
    const siteActivity = normalizeSiteActivity(m.siteActivity ?? m["site-activity"]);
    const isSkipped = m.skipped === true || status === "skipped" ||
      isToolResultDeclined(result) || isToolResultDeclined(detail);
    if (typeof m.ts === "number") this._maybeTsGap(m.ts);
    const extra = {
      "tool-name": name,
      "tool-status": isSkipped ? "skipped" : (status || "running"),
      "tool-args": toolPayloadAttribute(args),
      "tool-result": toolPayloadAttribute(result),
      "tool-detail": toolPayloadAttribute(detail),
      "tool-detail-note": typeof detailNote === "string" && detailNote ? detailNote : null,
      "tool-duration": durationMs != null ? String(durationMs) : null,
      "site-activity": siteActivity ? JSON.stringify(siteActivity) : null,
    };
    if (isSkipped) extra.skipped = "";
    return this._bubble("tool", isSkipped ? `You skipped ${humanToolLabel(name).toLowerCase()}.` : null, extra);
  }
  /** The IN-CONTEXT grant card for a PERSISTED permission denial
   *  (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 §2b, the reopened-thread half of
   *  CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01). The live run renders the same
   *  <permission-approval-card>; here it is derived from the durable run log,
   *  so the owner can still grant from the transcript. ONE card per distinct
   *  requirement (`requirement.key`). This element grants NOTHING: Allow/Not
   *  now bubble up as an `approval-decision` event carrying the requirement,
   *  the card and the owner's real click, and the surface that owns the
   *  service-worker channel performs the grant. */
  appendApproval(m = {}) {
    const req = m.requirement;
    if (!req || typeof req !== "object" || Array.isArray(req)) return null;
    const key = typeof req.key === "string" && req.key
      ? req.key
      : JSON.stringify([req.permissions ?? [], req.grantOrigins ?? [], req.grantGlobal === true, req.hostOrigins ?? []]);
    if (!this._approvalKeys) this._approvalKeys = new Map();
    // ONE card per requirement — but a card a re-projection detached (the
    // thread was rebuilt from the store while the run still waits) is dead;
    // the next mount renders a live one (chrome-agent-platform-716s.1).
    const existing = this._approvalKeys.get(key);
    if (existing && existing.isConnected !== false) return existing;
    // An owner-approval ACTION (a script to save/run, a site tool) is the same
    // <approval-card> the live run shows — its title/body/labels/detail come
    // from the caller (shared/conversation.js approvalCardSpecFromRequest), so
    // a card re-mounted in another tab says exactly what the first tab's did.
    const actionApproval = Array.isArray(req.approvals) && req.approvals.length > 0;
    const card = document.createElement(actionApproval ? "approval-card" : "permission-approval-card");
    if (actionApproval) {
      const app = req.approvals[0];
      const siteTool = app?.action === "webmcp.use-tool" && app?.detail?.kind === "webmcp-tool";
      const derivedTitle = siteTool
        ? `Use ${app.detail.origin}’s ${app.detail.tool}?`
        : `Approve ${app?.action ?? "this action"}?`;
      card.setAttribute("title", String(m.title ?? derivedTitle).slice(0, 240));
      const derivedBody = siteTool
        ? `Site: ${app.detail.origin}\nTool: ${app.detail.tool}\nAllow saves automatic use for this exact site tool in this browser profile. Deny blocks this exact tool on this site until you choose Allow / try again in Settings.`
        : (app ? `Action: ${app.action}\nTarget reference: ${app.targetRef || req.reason?.split(": ").slice(1).join(": ") || ""}` : "");
      const body = m.body ?? derivedBody;
      if (typeof body === "string" && body) card.setAttribute("body", body.slice(0, 4000));
      const approveLabel = m.approveLabel ?? (siteTool ? "Allow automatically" : "");
      if (typeof approveLabel === "string" && approveLabel) card.setAttribute("approve-label", approveLabel.slice(0, 60));
      const denyLabel = m.denyLabel ?? (siteTool ? "Deny" : "");
      if (typeof denyLabel === "string" && denyLabel) card.setAttribute("deny-label", denyLabel.slice(0, 60));
      // The script source + hosts or registration details are a PROPERTY (rendered
      // with textContent inside the card), never an attribute.
      if (m.cardDetail && typeof m.cardDetail === "object") card.detail = m.cardDetail;
      else if (!siteTool && app?.detail) card.detail = app.detail;
    } else {
      const toolName = m.tool || req.tool || req.toolName || m.toolName;
      if (toolName) card.setAttribute("tool", toolName);
      card.setAttribute("reason", String(req.reason ?? "perform this action").slice(0, 240));
      if (Array.isArray(req.permissions) && req.permissions.length) card.setAttribute("permissions", JSON.stringify(req.permissions.slice(0, 8)));
      if (Array.isArray(req.grantOrigins) && req.grantOrigins.length) card.setAttribute("origins", JSON.stringify(req.grantOrigins.slice(0, 50)));
      if (Array.isArray(req.hostOrigins) && req.hostOrigins.length) card.setAttribute("host-origins", JSON.stringify(req.hostOrigins.slice(0, 50)));
      if (req.grantGlobal === true) card.setAttribute("global", "true");
    }
    if (typeof m.state === "string" && m.state) card.setAttribute("state", m.state);
    if (typeof m.detail === "string" && m.detail) card.setAttribute("detail", m.detail);
    const emit = (approve, ev) => this.dispatchEvent(new CustomEvent("approval-decision", {
      bubbles: true,
      detail: {
        approve,
        requirement: req,
        executionId: m.executionId ?? null,
        requestId: m.requestId ?? null,
        approvalId: m.approvalId ?? null,
        toolCallId: m.toolCallId ?? null,
        card,
        sourceEvent: ev?.detail?.sourceEvent ?? null,
      },
    }));
    card.addEventListener("approve", (ev) => emit(true, ev));
    card.addEventListener("deny", (ev) => emit(false, ev));
    if (typeof m.ts === "number") this._maybeTsGap(m.ts);
    this._approvalKeys.set(key, card);
    const appended = this.appendTranscript(card);
    const active = document.activeElement;
    const midEdit = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT") &&
      typeof active.value === "string" && active.value.length > 0;
    if (!midEdit && (!m.state || m.state === "pending")) {
      const focusAllow = () => (typeof card.focusApprove === "function" ? card.focusApprove() : card.shadowRoot?.querySelector?.("button")?.focus?.());
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusAllow);
      else focusAllow();
    }
    return appended;
  }
  clear() { this._clearLiveStatusRow(); this.replaceChildren(); this._lastTs = null; this._approvalKeys = new Map(); }

  /* ── the inline live-status row (owner 2026-08-28) ──────────────────────
   * ONE live-status surface per conversation, rendered as the LAST child and
   * pinned (sticky) to the bottom of the scroll viewport while a run is live.
   * Idle / completed remove the row — the final conversation entry IS the
   * resolution; no orphan chrome. Failed / cancelled / waiting-for-permission
   * persist because they carry the honest terminal state + recovery action.
   * Re-renders are deduped on the normalized key so the aria-live region
   * announces progress without spamming on no-op updates. */
  setLiveStatus(status) {
    const state = typeof status?.state === "string" ? status.state : "";
    // Idle / completed / empty resolve the row: nothing renders.
    if (!state || state === "idle" || state === "completed") {
      this._clearLiveStatusRow();
      return;
    }
    const next = {
      state,
      activity: typeof status?.activity === "string" && status.activity.trim() ? status.activity.trim() : null,
      message: typeof status?.message === "string" && status.message.trim() ? status.message.trim() : null,
      errorReason: typeof status?.errorReason === "string" && status.errorReason.trim() ? status.errorReason.trim() : null,
      actionLabel: typeof status?.actionLabel === "string" && status.actionLabel.trim() ? status.actionLabel.trim() : null,
      actionKind: typeof status?.actionKind === "string" && status.actionKind.trim() ? status.actionKind.trim() : null,
      errorCategory: typeof status?.errorCategory === "string" && status.errorCategory.trim() ? status.errorCategory.trim() : null,
      executionId: Object.hasOwn(status ?? {}, "executionId")
        ? (typeof status.executionId === "string" && status.executionId.trim() ? status.executionId.trim() : null)
        : (this._liveStatusRow?.getAttribute("execution-id") || null),
    };
    const key = JSON.stringify(next);
    if (key === this._liveStatusKey && this._liveStatusRow?.isConnected) return;
    this._liveStatusKey = key;
    let row = this._liveStatusRow;
    if (!row || !row.isConnected) {
      row = document.createElement("conversation-run-status");
      row.classList.add("live-status");
      this._liveStatusRow = row;
    }
    row.removeAttribute("hidden");
    row.setAttribute("state", next.state);
    for (const [name, value] of [["activity", next.activity], ["message", next.message], ["error-reason", next.errorReason], ["error-category", next.errorCategory], ["action-label", next.actionLabel], ["action-kind", next.actionKind], ["execution-id", next.executionId]]) {
      if (value) row.setAttribute(name, value);
      else row.removeAttribute(name);
    }
    // Append LAST so the row is the newest thing in the flow; the sticky
    // bottom pin keeps it visible even when the owner scrolls up.
    this.appendChild(row);
    // The thinking trace belongs DIRECTLY under the row: the row re-appends
    // itself on every status change, so re-pin the trace after it.
    if (this._thinkingTrace?.isConnected) this.appendChild(this._thinkingTrace);
    // A terminal/paused state ends thinking — the trace is a live-only
    // surface and never outlives it.
    if (!["running", "retrying", "queued"].includes(next.state)) this.clearThinkingTrace();
    this._scrollToBottom();
  }
  bindLiveStatusExecution(executionId) {
    const row = this._liveStatusRow;
    if (!row?.isConnected) return;
    const id = typeof executionId === "string" ? executionId.trim() : "";
    if (id) row.setAttribute("execution-id", id);
    else row.removeAttribute("execution-id");
    this._liveStatusKey = null;
  }
  clearLiveStatus() { this._clearLiveStatusRow(); }
  _clearLiveStatusRow() {
    this._liveStatusKey = null;
    this._liveStatusRow?.remove();
    this._liveStatusRow = null;
  }

  /* ── the live thinking trace (chrome-agent-platform-h0iy) ──────────────
   * When the provider streams thinking tokens, they appear in a collapsible
   * region directly under the live-status row: collapsed by default with a
   * live character count, expanding streams the trace (auto-scroll pinned to
   * the bottom until the owner scrolls up). The trace exists ONLY while its
   * run is live — it is never persisted and is dropped at settle. */
  thinkingDelta({ delta, start } = {}) {
    if (typeof delta !== "string" || !delta) return;
    if (start === true) {
      this._thinkingText = "";
      this._thinkingUserScrolled = false;
      if (this._thinkingTraceBody) this._thinkingTraceBody.textContent = "";
    }
    let trace = this._thinkingTrace;
    if (!trace || !trace.isConnected) {
      trace = document.createElement("div");
      trace.className = "thinking-trace";
      trace.dataset.open = "false";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "thinking-trace-toggle";
      toggle.setAttribute("aria-expanded", "false");
      const caret = document.createElement("span");
      caret.className = "thinking-trace-caret";
      caret.textContent = "▸";
      caret.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "thinking-trace-label";
      toggle.append(caret, label);
      const body = document.createElement("div");
      body.className = "thinking-trace-body";
      body.addEventListener("scroll", () => {
        // Unpin when the owner scrolls up; re-pin at the bottom edge.
        this._thinkingUserScrolled = body.scrollHeight - body.scrollTop - body.clientHeight > 24;
      });
      toggle.addEventListener("click", () => {
        const open = trace.dataset.open !== "true";
        trace.dataset.open = open ? "true" : "false";
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
        if (open) body.scrollTop = body.scrollHeight;
      });
      trace.append(toggle, body);
      this._thinkingTrace = trace;
      this._thinkingTraceBody = body;
      this._thinkingTraceLabel = label;
      this._thinkingText = "";
      this._thinkingUserScrolled = false;
    }
    this._thinkingText += delta;
    if (this._thinkingTraceBody) {
      this._thinkingTraceBody.textContent = this._thinkingText;
      if (trace.dataset.open === "true" && !this._thinkingUserScrolled) {
        this._thinkingTraceBody.scrollTop = this._thinkingTraceBody.scrollHeight;
      }
    }
    if (this._thinkingTraceLabel) {
      this._thinkingTraceLabel.textContent = `Thinking · ${this._thinkingText.length} characters`;
    }
    // Mount directly under the live-status row (which re-appends itself on
    // every status change, so append AFTER it here too).
    this.appendChild(trace);
  }
  collapseThinkingTrace() {
    const trace = this._thinkingTrace;
    if (!trace) return;
    trace.dataset.open = "false";
    trace.querySelector(".thinking-trace-toggle")?.setAttribute("aria-expanded", "false");
  }
  clearThinkingTrace() {
    this._thinkingTrace?.remove();
    this._thinkingTrace = null;
    this._thinkingTraceBody = null;
    this._thinkingTraceLabel = null;
    this._thinkingText = "";
    this._thinkingUserScrolled = false;
  }

  // ── the plan strip ────────────────────────────────────────────────────
  // A running multi-step task shows a compact plan at the TOP of the thread —
  // its tool calls as a checklist, the current one active, completed ones
  // checked — built from the run's own step events fed through the progress
  // port (CAP-FB-20260830-PLAN-STRIP-CHECKPOINTS-01). resetPlan() clears it at
  // the start of a new turn or on a thread switch; planEvent() folds one
  // normalized step event in and re-renders; on `done`/`fail` it settles into a
  // collapsed "N steps" summary that persists (unlike the live-status row).
  resetPlan() {
    this._plan = emptyPlan();
    this._planStrip?.remove();
    this._planStrip = null;
    this._planKey = null;
  }
  planEvent(ev) {
    this._plan = reducePlan(this._plan ?? emptyPlan(), ev);
    this._renderPlanStrip();
  }
  _renderPlanStrip() {
    const plan = this._plan ?? emptyPlan();
    if (!plan.steps.length) { this._planStrip?.remove(); this._planStrip = null; this._planKey = null; return; }
    const stepsAttr = JSON.stringify(plan.steps);
    const stateAttr = plan.state === "settled" ? "settled" : "running";
    const key = `${stateAttr}|${stepsAttr}`;
    let strip = this._planStrip;
    if (!strip || !strip.isConnected) {
      strip = document.createElement("plan-strip");
      strip.classList.add("run-plan");
      this._planStrip = strip;
      this._planKey = null;
    }
    // The strip pins to the TOP of the conversation flow — insert it FIRST so
    // it stays above the transcript that streams below it.
    if (this.firstChild !== strip) this.insertBefore(strip, this.firstChild);
    if (key === this._planKey) return; // deduped: no attribute churn, no re-announce
    this._planKey = key;
    strip.setAttribute("steps", stepsAttr);
    strip.setAttribute("state", stateAttr);
  }

  setMessages(messages) {
    // Keep the live-status row across the rebuild: replaceChildren detaches
    // it, so re-append it LAST afterwards (review P1-a). The plan strip is
    // likewise preserved (re-inserted FIRST below) so a terminal re-projection
    // from the durable log does not wipe the just-settled "N steps" summary.
    const liveRow = this._liveStatusRow;
    const planStrip = this._planStrip?.isConnected ? this._planStrip : null;
    // The live thinking trace (h0iy) survives a MID-RUN re-projection exactly
    // like the live row — a thread reconcile can land while the provider is
    // still streaming. At settle the trace is already cleared, so nothing
    // live-only is ever restored into a persisted view.
    const thinkingTrace = this._thinkingTrace?.isConnected ? this._thinkingTrace : null;
    this.replaceChildren();
    this._lastTs = null;
    this._approvalKeys = new Map();
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No conversation yet — start one above.";
      this.appendChild(p);
    } else {
      for (const m of list) {
        if (!m || typeof m !== "object") continue;
        const ts = typeof m.ts === "number" ? m.ts : null;
        switch (m.role) {
          case "user": this.appendUser(m.content, ts, m.attachments); break;
          case "agent": {
            this.appendAgent(m.content, ts);
            // Provider-server grounding rows render UNDER their answer.
            if (m.serverToolEvents || m.citations) this.appendServerToolRows(m);
            break;
          }
          case "system": this.appendSystem(m.content, ts); break;
          case "thinking": this.appendThinking(m.content, m); break;
          // A protocol call (search_tools/list_tools) is plumbing, not work:
          // it stays in the run log and renders no card (§9).
          case "tool": if (m.protocol !== true) this.appendTool(m); break;
          case "artifact": this.appendArtifact(m); break;
          case "images": this.appendImages(m); break;
          case "approval": this.appendApproval(m); break;
          case "error": this.appendError(m.content, { reason: m.reason ?? null, action: m.action ?? null, category: m.category ?? null }); break;
          default: this.appendAgent(m.content, ts); break;
        }
      }
    }
    if (liveRow) this.appendChild(liveRow);
    // Directly under the live-status row, as in the live flow.
    if (thinkingTrace) this.appendChild(thinkingTrace);
    // The plan strip pins to the TOP — re-insert it as the first child so it
    // survives the rebuild in place.
    if (planStrip) this.insertBefore(planStrip, this.firstChild);
    // A (re)projection is a fresh read of the thread: land on the newest turn.
    this._scrollToBottom(true);
  }
}
customElements.define("agent-conversation", AgentConversation);

/* <screenshot-strip shots="[{url,label,kind}]" max="6"> — a horizontal strip of
 * the images a run produced: screenshots it captured and image assets it made
 * (CAP-FB-20260830-GENERATED-IMAGE-STRIP-01). `kind` ("screenshot" | "image")
 * only steers the accessible label; `max` caps the visible thumbnails and shows
 * a "+N" overflow button. Emits `open` with { index }, or { index, overflow } on

 * the +N button. Escapes every src/label — a data URL is untrusted content. */
export class ScreenshotStrip extends Component {
  static get observedAttributes() { return ["shots", "max"]; }
  _render() {
    const shots = parseJSONAttr(this.getAttribute("shots"), []);
    const total = shots.length;
    const maxAttr = Number(this.getAttribute("max"));
    const max = Number.isFinite(maxAttr) && maxAttr > 0 ? Math.floor(maxAttr) : total;
    const visible = shots.slice(0, max);
    const overflow = total - visible.length;
    const items = visible.map((s, i) => {
      const src = typeof s === "string" ? s : s?.url;
      const label = typeof s === "object" ? (s?.label ?? "") : "";
      const kind = typeof s === "object" && (s?.kind === "image" || s?.kind === "screenshot") ? s.kind : "screenshot";
      // The label NAMES the picture and its place in the set, so a screen-reader
      // user hears "Open image 2 of 3", not a bare "Open screenshot".
      const aria = `Open ${kind} ${i + 1} of ${total}${label ? `: ${label}` : ""}`;
      return `<button type="button" class="shot" data-index="${i}" aria-label="${escapeHtml(aria)}">
        <img src="${escapeHtml(src || "")}" alt="" decoding="async">
        ${label ? `<span class="lbl">${escapeHtml(String(label))}</span>` : ""}</button>`;
    }).join("");
    const overflowBtn = overflow > 0
      ? `<button type="button" class="shot more" data-index="${visible.length}" data-overflow="1" aria-label="Show ${overflow} more image${overflow === 1 ? "" : "s"}">+${overflow}</button>`
      : "";
    mountTemplate(this, `
      :host { display:block; }
      .strip { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; }
      .shot { position:relative; flex:0 0 auto; width:96px; height:64px; border:1px solid var(--border,#e3e0d9); border-radius:8px; overflow:hidden; padding:0; cursor:pointer; background:var(--bg,#f7f6f3); }
      .shot.more { display:inline-flex; align-items:center; justify-content:center; font:600 var(--text-sm,13px)/1 var(--sans,system-ui); color:var(--muted,#635e56); font-variant-numeric:tabular-nums; }
      .shot.more:hover { border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      .shot img { width:100%; height:100%; object-fit:cover; display:block; }
      .shot:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .lbl { position:absolute; inset:auto 0 0 0; font-size:var(--text-xs, 12px); background:rgba(0,0,0,.6); color:#fff; padding:1px 3px; }
      .empty { font-size:12px; color:var(--muted,#635e56); }
    `, shots.length ? `<div class="strip">${items}</div>` : `<span class="empty">No screenshots yet.</span>`);
  }
  _wire() {
    this._root.querySelectorAll(".shot").forEach((s) =>
      s.addEventListener("click", () => this._emit("open", { index: Number(s.dataset.index) }))
    );
  }
}
customElements.define("screenshot-strip", ScreenshotStrip);

/* <screenshot-thumb shot-id="shot_…" label="Example Domain" size="1280×720">
 * ONE saved screenshot, resolved from the screenshots store by its id.
 *
 * A capture the agent took used to be invisible: the bytes went into the model
 * message and nowhere else, so there was nothing for the owner to look at
 * (CAP-FB-20260830-SCREENSHOT-TO-MODEL-01). The tool card mounts this, and the
 * PNG the model saw is the PNG on screen.
 *
 * The blob URL is revoked on disconnect and before every re-resolve, so a long
 * transcript never holds a megabyte per scrolled-past card. `src` short-
 * circuits the store lookup — that is how the gallery shows a specimen with no
 * extension backend. */
export class ScreenshotThumb extends Component {
  static get observedAttributes() { return ["shot-id", "label", "size", "src"]; }
  _render() {
    const label = this.getAttribute("label") || "";
    const size = this.getAttribute("size") || "";
    // The alt text NAMES what the picture is of. "Screenshot" alone tells a
    // screen-reader user nothing they could not guess from the tool name.
    // NOT `loading="lazy"`: a tool card is a collapsed <details>, so a lazy
    // image inside it is never in a viewport and never decodes — the card
    // would hold an <img> that stays 0x0 until the owner expands it. The source
    // is a local blob URL, so there is nothing to defer anyway.
    const alt = label ? `Screenshot of ${label}` : "Screenshot of the captured page";
    mountTemplate(this, `
      :host { display:block; margin:8px 0; }
      figure { display:inline-flex; flex-direction:column; gap:4px; max-width:100%; margin:0; }
      img { display:block; width:auto; height:auto; max-width:240px; max-height:160px;
        border:1px solid var(--border,#e3e0d9); border-radius:8px; background:var(--bg,#f7f6f3); }
      figcaption { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); overflow-wrap:anywhere; }
      figure.pending img { min-width:96px; min-height:64px; }
    `, `<figure class="shot-thumb pending">
      <img alt="${escapeHtml(alt)}" decoding="async">
      ${size || label ? `<figcaption>${escapeHtml([label, size].filter(Boolean).join(" · "))}</figcaption>` : ""}
    </figure>`);
  }
  _wire() {
    this._resolve();
  }
  _releaseObjectUrl() {
    if (this._objectUrl) {
      try { URL.revokeObjectURL(this._objectUrl); } catch { /* already gone */ }
      this._objectUrl = null;
    }
  }
  async _resolve() {
    this._releaseObjectUrl();
    const img = this._root.querySelector("img");
    if (!img) return;
    const direct = this.getAttribute("src");
    const dataURL = direct || await this._fetchDataURL();
    if (!dataURL || !this.isConnected) return;
    const objectUrl = dataUrlToObjectURL(dataURL);
    // A browser that refuses the decode still gets the picture — the data URL
    // itself is a valid source, it just is not revocable.
    this._objectUrl = objectUrl;
    img.src = objectUrl || dataURL;
    this._root.querySelector(".shot-thumb")?.classList.remove("pending");
  }
  async _fetchDataURL() {
    const id = this.getAttribute("shot-id");
    if (!id || !RUNTIME_SEND) return "";
    const res = await RUNTIME_SEND("screenshots.get", { id });
    return typeof res?.dataURL === "string" ? res.dataURL : "";
  }
  disconnectedCallback() {
    this._releaseObjectUrl();
    super.disconnectedCallback();
  }
}
customElements.define("screenshot-thumb", ScreenshotThumb);


/** Decode a base64 data URL into a revocable object URL WITHOUT fetch() — an
 * extension page's connect-src does not cover `data:`, and a multi-megabyte
 * PNG should not be re-parsed by the network stack anyway. Returns "" when the
 * string is not a base64 data URL or the decode fails. */
export function dataUrlToObjectURL(dataURL) {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataURL ?? ""));
  if (!match || typeof URL?.createObjectURL !== "function") return "";
  try {
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: match[1].toLowerCase() }));
  } catch {
    return "";
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Composite components
 * ────────────────────────────────────────────────────────────────────────── */

// A per-instance id seed so the composer popup's aria-controls / option ids are
// unique when several composers share a page (the hub + the thread composer).
let agentComposerUid = 0;

/* <agent-composer placeholder label send-label> — mic + attach + input + send.
 * Light DOM (shadow() = false) so the extension's CDP journeys can still
 * target #task-input / #run-task. */

export class AgentComposer extends Component {
  /** Focus the task input. Public so a route (the keyboard "new task" command
   * lands on "#compose") can put the caret in the composer without reaching
   * into the shadow root from outside. Safe before connect: no-ops. */
  focusInput() {
    const el = this._input ?? this.querySelector("[data-composer-input]");
    el?.focus?.();
    return !!el;
  }

  static shadow() { return false; }
  static get observedAttributes() { return ["placeholder", "label", "description", "send-label", "agent-id", "agent-kind", "thread-id"]; }
  constructor() {
    super();
    this.attachments = [];
    this._uid = ++agentComposerUid;
    // The ONE canonical selected agent (CAP-FB-20260818-AGENT-ACCESS-01):
    // { ref: "named:<id>"|"background:<id>"|"site:<origin>", kind, id, name }.
    // Set by the + menu's Choose agent / a committed /agent: option; rendered
    // as a removable chip; flows into the send detail so the run is routed by
    // ID, never by a name.
    this._selectedAgent = null;
    this._agentChip = null;
    this._apObserver = null; // mirrors the slash-picker highlight onto the textarea
  }
  // The agent this composer is scoped to (null for the hub/thread): agent-id =
  // the agent's slug/id, agent-kind = "named" | "background". Used to EXCLUDE the
  // current agent from the /agent + @ mention lists (you can't call the agent
  // you're talking to).
  get _currentAgentId() { return this.getAttribute("agent-id") || null; }
  get _currentAgentKind() { return this.getAttribute("agent-kind") || null; }
  get _harnessId() {
    if (this._selectedAgent) return this._selectedAgent.kind === "acp" ? this._selectedAgent.id : null;
    return this._currentAgentKind === "acp" ? this._currentAgentId : null;
  }
  _resetHarnessCommands() {
    this._harnessRequest = (this._harnessRequest || 0) + 1;
    this._harnessCatalogue = null;
    this._harnessLoading = false;
    this._hidePopup();
    const button = this.querySelector(".harness-commands");
    if (button) button.hidden = !this._harnessId;
  }
  _render() {
    const placeholder = this.getAttribute("placeholder") || "Ask anything, or @mention an agent…";
    const label = this.getAttribute("label") || "Message";
    const description = this.getAttribute("description") || "Type @ to mention any named, background, or Site Agent.";
    const sendLabel = this.getAttribute("send-label") || "Run task";
    const currentAgent = this._currentAgentId;
    const html = `
      <div class="composer" part="composer">
        <span class="sr-only" id="composer-description-${this._uid}">${escapeHtml(description)}</span>
        <textarea data-composer-input id="${this.id ? `${this.id}-input` : `cmp-input-${this._uid}`}" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(label)}"
          aria-describedby="composer-description-${this._uid}" aria-haspopup="listbox" aria-expanded="false"
          aria-controls="popup-${this._uid}" aria-multiline="true" rows="2"></textarea>
        <div class="popup slash-menu" id="popup-${this._uid}" role="listbox" aria-label="Agent and resource mentions" popover="manual" hidden></div>
        <div class="chips"></div>
        <div class="row">
          <mic-button id="${this.id ? `${this.id}-mic` : `mic-${this._uid}`}"></mic-button>
          <attach-button id="${this.id ? `${this.id}-attach` : `attach-${this._uid}`}"></attach-button>
          <button class="harness-commands btn" type="button" aria-label="Browse harness commands and skills" ${this._harnessId ? "" : "hidden"}>Harness commands</button>
          <span class="spacer"></span>
          <button id="${this.id ? `${this.id}-send` : `cmp-send-${this._uid}`}" class="btn send composer-send" data-composer-send type="button" disabled>${escapeHtml(sendLabel)}</button>
        </div>
        <div class="agent-pop" popover="manual" hidden>
          <agent-picker callable-only label="Run with agent"
            ${currentAgent ? `current-agent-id="${escapeHtml(currentAgent)}" exclude-current` : ""}></agent-picker>
        </div>
      </div>
      <div class="composer-status" role="status" aria-live="polite"></div>`;
    mountTemplate(this, `
      :host { display:block; }
      /* Scoped to the host tag (light DOM, shadow()=false): the bare class
         selectors would be document-scope CSS — the same collision mechanism
         as the blank-toggle bug. Tag-scoping keeps the controls in the LIGHT
         DOM (the CDP journeys hit #task-input/#run-task) while the styles only
         apply within THIS component's subtree. */
      agent-composer .composer { position:relative; anchor-name: --composer-anchor; background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:12px; padding:14px; }
      agent-composer .composer:focus-within { border-color:var(--accent,#0e6e63); }
      agent-composer .composer.drag-over { outline:2px dashed var(--accent,#0e6e63); background:var(--accent-soft,rgba(14,110,99,0.06)); }
      agent-composer .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
        clip:rect(0,0,0,0); white-space:nowrap; border:0; }
      agent-composer .popup, agent-composer .slash-menu { position:absolute; inset:auto; margin:0; box-sizing:border-box;
        position-anchor:--composer-anchor; position-area:block-start span-inline-end;
        position-try-fallbacks:flip-block;
        width:min(440px, anchor-size(width)); max-width:min(480px, calc(100vw - 16px)); background:var(--panel,#ffffff);
        border:1px solid var(--border,#e3e0d9); border-radius:10px; box-shadow:var(--shadow-md, 0 8px 24px rgba(29,27,24,.08));
        max-height:min(320px, calc(100% - 16px)); overflow-y:auto; padding:4px; z-index:40; }
      @supports not (position-area: top) {
        agent-composer .popup, agent-composer .slash-menu { position:fixed; inset-inline-start:12px; inset-inline-end:auto; left:12px; right:auto; width:min(440px, calc(100% - 24px)); }
      }
      agent-composer .popup[hidden], agent-composer .slash-menu[hidden] { display:none; }
      agent-composer .popup .item { display:flex; align-items:baseline; gap:8px; padding:6px 10px; border-radius:6px; cursor:pointer; }
      agent-composer .popup .item:hover, agent-composer .popup .item[data-active="true"] { background:var(--panel-2,#efede8); }
      agent-composer .popup .item .lbl { font-weight:600; font-size:13px; color:var(--text,#1d1b18); white-space:nowrap; flex-shrink:0; }
      agent-composer .popup .item .dsc { font-size:12px; color:var(--muted,#635e56); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:left; }
      agent-composer .harness-commands { min-height:36px; background:transparent; color:var(--text,#1d1b18); border:1px solid var(--border,#e3e0d9); border-radius:8px; padding:6px 10px; cursor:pointer; }
      agent-composer .harness-commands[hidden] { display:none; }
      agent-composer .harness-commands:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      agent-composer[agent-kind="acp"] .popup .item { min-height:44px; box-sizing:border-box; align-items:center; }
      agent-composer[agent-kind="acp"] .popup .lbl { white-space:normal; overflow-wrap:anywhere; flex:1; }
      agent-composer[agent-kind="acp"] .popup .dsc { white-space:normal; text-align:left; overflow-wrap:anywhere; }
      agent-composer .popup .item[aria-disabled="true"] { cursor:default; }
      agent-composer .popup .empty { padding:8px 10px; font-size:12px; color:var(--muted,#635e56); }
      agent-composer .popup .group-label { padding:6px 10px 2px; font-size:12px; font-weight:600;
        color:var(--muted,#635e56); user-select:none; }
      agent-composer .popup .menu-footer {
        padding:6px 10px; margin-top:4px; border-top:1px solid var(--border,#e3e0d9);
        font-size:var(--text-xs, 12px); color:var(--muted,#635e56); background:var(--panel,#ffffff);
        display:flex; align-items:center; justify-content:center; gap:6px;
        user-select:none; position:sticky; bottom:-4px;
      }
      agent-composer .composer textarea { width:100%; background:transparent; border:0; color:var(--text,#1d1b18); font:inherit; resize:none; overflow-y:hidden; field-sizing:content; min-height:24px; max-height:180px; outline:none; line-height:1.45; }
      agent-composer .composer .row { display:flex; gap:8px; align-items:center; margin-top:8px; }
      agent-composer .composer .spacer { flex:1; }
      agent-composer .composer .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      agent-composer .composer .chips:empty { display:none; }
      agent-composer .composer .chips .chip { display:inline-flex; align-items:center; gap:6px; font-size:12px;
        color:var(--text,#1d1b18); background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9);
        border-radius:999px; padding:3px 10px; min-height:32px; box-sizing:border-box; }
      agent-composer .composer .chips .chip button { border:0; background:transparent; color:var(--muted,#635e56);
        cursor:pointer; padding:0; font:inherit; line-height:1; min-height:32px; min-width:32px; display:inline-flex; align-items:center; justify-content:center; }
      agent-composer .composer .chips .chip button:hover { color:var(--text,#1d1b18); }
      agent-composer .composer .send { display:inline-flex; align-items:center; height:var(--control,36px); padding:0 16px;
        background:var(--accent,#0e6e63); color:var(--btn-fg,#fff); border:0; border-radius:8px;
        font:inherit; font-weight:600; cursor:pointer; }
      agent-composer .composer .send:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      agent-composer .composer .send:disabled,
      agent-composer .composer .send.composer-send:disabled {
        background: var(--surface-hover, var(--panel-2, #efede8)) !important;
        color: var(--muted, #635e56) !important;
        border: 1px solid var(--border, #d9d4c9) !important;
        cursor: not-allowed;
      }
      agent-composer > .composer-status { margin-top:8px; font-size:12px; color:var(--muted,#635e56); }
      agent-composer > .composer-status:empty { display:none; }
      /* the recording chip (record-screen / record-audio) — a visible start/stop */
      agent-composer .composer .chips .chip.recording { align-items:center; gap:8px; border-color:var(--accent,#0e6e63); }
      agent-composer .composer .chips .chip.recording .rec-dot { width:8px; height:8px; border-radius:50%; background:var(--accent,#0e6e63); animation:cap-pulse 1.2s ease-in-out infinite; }
      agent-composer .composer .chips .chip.recording button { font-weight:600; color:var(--accent,#0e6e63); }
      @keyframes cap-pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }
      @media (prefers-reduced-motion: reduce) { agent-composer .composer .chips .chip.recording .rec-dot { animation:none; } }
      /* the agent chip (the + menu's Choose agent / a committed /agent: option):
         the ONE canonical selected agent, removable before send. */
      agent-composer .composer .chips .chip.agent-chip { border-color:var(--accent,#0e6e63);
        color:var(--accent,#0e6e63); font-weight:600; }
      agent-composer .composer .chips .chip.agent-chip .agent-initial { width:18px; height:18px;
        border-radius:50%; border:1px solid var(--accent,#0e6e63); display:inline-flex; align-items:center;
        justify-content:center; font-size:var(--text-xs, 12px); font-weight:700; }
      agent-composer .composer .chips .chip.agent-chip button { color:var(--accent,#0e6e63); min-width:32px; min-height:32px; }
      /* the + menu's Choose agent popover: the shared <agent-picker> in the top
         layer, anchored to the composer/attach button via placeFloating. */
      agent-composer .agent-pop { position:fixed; inset:auto; margin:0; padding:10px;
        width:min(380px, calc(100vw - 24px)); background:var(--panel,#ffffff);
        border:1px solid var(--border,#e3e0d9); border-radius:12px;
        box-shadow:var(--shadow-2, 0 12px 32px rgba(29,27,24,.12)); z-index:60; }
      agent-composer .agent-pop[hidden] { display:none; }
      /* the tab picker (add-tab / grab-screenshot) — a floating list, in-bounds */
      .tab-picker { position:fixed; z-index:60; background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9);
        border-radius:10px; box-shadow:var(--shadow-2, 0 12px 32px rgba(29,27,24,.12)); padding:4px; min-width:300px; max-width:420px; }
      .tab-picker .tp-list { max-height:260px; overflow-y:auto; }
      .tab-picker .tp-row { display:flex; flex-direction:column; gap:2px; width:100%; text-align:left; background:transparent;
        border:0; border-radius:7px; padding:7px 10px; cursor:pointer; font:inherit; color:var(--text,#1d1b18); }
      .tab-picker .tp-row:hover, .tab-picker .tp-row:focus-visible { background:var(--panel-2,#efede8); outline:none; }
      .tab-picker .tp-title { font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .tab-picker .tp-url { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .tab-picker .tp-empty { padding:8px 10px; font-size:12px; color:var(--muted,#635e56); }
      /* narrow: let the fixed mic/attach/send controls wrap instead of forcing
         the whole column wide (CAP-FB-20260821-HUB-360-OVERFLOW-01). The send
         button rides the end of its own line; the textarea drops its intrinsic
         20-col min-width so the column can shrink below it. */
      @media (max-width: 600px) {
        agent-composer .composer .row { flex-wrap: wrap; }
        agent-composer .composer .send { margin-inline-start: auto; }
        agent-composer .composer textarea { min-width: 0; }
      }
    `, html);
    this._harnessRequest = (this._harnessRequest || 0) + 1;
    this._harnessCatalogue = null;
    this._harnessLoading = false;
    this._input = this.querySelector("[data-composer-input]");
    this._mic = this.querySelector("mic-button");
    this._attach = this.querySelector("attach-button");
    this._run = this.querySelector("[data-composer-send]");
    this._status = this.querySelector(".composer-status");
    this._popup = this.querySelector(".popup");
    this._chips = this.querySelector(".chips");
    this._agentPop = this.querySelector(".agent-pop");
    this._agentPick = this.querySelector("agent-picker");
    this._popupItems = [];
    this._popupActive = -1;
    this._popupToken = null;
    this._slashAgentToken = null; // { start, end } while /agent: drives the picker
    this._composerEl = this.querySelector(".composer");
    this._sentHistory = [];
    this._historyIndex = -1;
    this._historyDraft = "";
    // Resolved command-reference spans in the current input: a second /command
    // typed immediately after one of these opens its picker (CAP-FB-20260831-
    // MULTI-SLASH-COMMANDS-01). Each is { start, end, text } — `text` lets the
    // composer drop spans that no longer match the live input after edits.
    this._resolvedSpans = [];
    // Auto-grow needs a post-layout pass for programmatically prefilled values
    // (e.g. the first-run prompt) — scrollHeight is 0 before the first style.
    requestAnimationFrame(() => this._autoGrow());
  }
  // The composer GROWS with its text up to ~10 lines, then scrolls internally
  // (owner bug 2026-08-28: after 1–2 lines the textarea auto-scrolled and the
  // text being typed left the viewport). The cap derives from the COMPUTED
  // line-height so font/theme changes keep the line-count contract; resize is
  // `none` because auto-grow owns the height now.
  _autoGrow() {
    const input = this._input;
    if (!input || !input.isConnected) return;
    // A HIDDEN composer (the thread composer before its task view opens) has
    // scrollHeight 0 — skip, or we would pin height:0px until the first input.
    if (!input.scrollHeight) return;
    const style = getComputedStyle(input);
    const lineHeight = parseFloat(style.lineHeight) || 22;
    const padV = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const cap = lineHeight * 10 + padV;
    // height:auto first so deletions SHRINK the box (scrollHeight then
    // reflects content, not the previously forced height). Read the natural
    // height EXACTLY ONCE after that write — a second post-write scrollHeight
    // read forces ANOTHER synchronous layout per keystroke (review P1:
    // layout thrash on every input event). The cached value drives the
    // height, the overflow mode, and nothing else reads layout afterwards.
    input.style.height = "auto";
    const natural = input.scrollHeight;
    input.style.height = `${Math.min(natural, cap)}px`;
    input.style.overflowY = natural > cap ? "auto" : "hidden";
  }
  _wire() {
    this.querySelector(".harness-commands")?.addEventListener("click", () => {
      this._harnessCatalogue = null;
      this._openHarnessCommands(true);
    });
    const hasText = !!this._input?.value?.trim();
    if (this._run) {
      this._run.disabled = !hasText;
      this._run.classList.toggle("has-input", hasText);
    }
    this._run?.addEventListener("click", () => this._send());
    this._input?.addEventListener("input", () => {
      this._historyIndex = -1;
      this._historyDraft = "";
      this._onComposerInput();
    });

    const handlePaste = async (e) => {
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        e.preventDefault();
        for (const file of files) {
          await this._ingestFile(file);
        }
      }
    };
    this._input?.addEventListener("paste", handlePaste);
    this._composerEl?.addEventListener("paste", handlePaste);

    this._composerEl?.addEventListener("dragover", (e) => {
      e.preventDefault();
      this._composerEl?.classList.add("drag-over");
    });
    this._composerEl?.addEventListener("dragleave", (e) => {
      if (!this._composerEl?.contains(e.relatedTarget)) {
        this._composerEl?.classList.remove("drag-over");
      }
    });
    this._composerEl?.addEventListener("drop", async (e) => {
      e.preventDefault();
      this._composerEl?.classList.remove("drag-over");
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        for (const file of files) {
          await this._ingestFile(file);
        }
      }
    });

    this._input?.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      // The /agent slash picker: the composer text is the query source, so the
      // navigation keys are FORWARDED to the shared <agent-picker> (its one
      // keyboard contract) while ordinary typing flows through the input event.
      if (this._slashAgentToken) {
        if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Tab", "Escape"].includes(e.key)) {
          e.preventDefault();
          this._agentPick?.navigate?.(e.key);
        }
        return;
      }
      if (this._popupOpen) {
        if (e.key === "ArrowDown") { e.preventDefault(); this._moveSelection(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); this._moveSelection(-1); return; }
        if (e.key === "Home") { e.preventDefault(); this._setSelectionIndex(0); return; }
        if (e.key === "End") { e.preventDefault(); this._setSelectionIndex(this._popupItems.length - 1); return; }
        if (e.key === "Enter") { e.preventDefault(); this._selectActive(); return; }
        if (e.key === "Tab") {
          if (this._popupItems[this._popupActive]?.disabled) this._hidePopup();
          else { e.preventDefault(); this._selectActive(); }
          return;
        }
        if (e.key === "Escape") { e.preventDefault(); this._hidePopup(); return; }
        return;
      }
      if (!this._popupOpen && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const history = this._sentHistory || [];
        if (history.length > 0) {
          if (e.key === "ArrowUp" && (this._historyIndex !== -1 || this._input.value === "")) {
            e.preventDefault();
            if (this._historyIndex === -1) {
              this._historyDraft = this._input.value;
              this._historyIndex = history.length - 1;
            } else if (this._historyIndex > 0) {
              this._historyIndex--;
            }
            this._input.value = history[this._historyIndex];
            this._autoGrow();
            return;
          }
          if (e.key === "ArrowDown" && this._historyIndex !== -1) {
            e.preventDefault();
            if (this._historyIndex < history.length - 1) {
              this._historyIndex++;
              this._input.value = history[this._historyIndex];
            } else {
              this._historyIndex = -1;
              this._input.value = this._historyDraft ?? "";
            }
            this._autoGrow();
            return;
          }
        }
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._send(); }
    });
    this._mic?.addEventListener("transcript", (e) => {
      const { text, final: isFinal } = e.detail;
      this._input.value = text;
      this._autoGrow();
      if (isFinal) this._emit("transcript", { text });
    });
    this._attach?.addEventListener("attach", (e) => {
      const detail = e.detail ?? {};
      this.attachments.push(detail);
      this._addChip(detail);
      this._emit("attach", detail);
    });
    this._attach?.addEventListener("attach-media", (e) => this._captureMedia(e.detail?.kind));
    this._attach?.addEventListener("attach-context", (e) => this._contextAction(e.detail?.kind));
    this._attach?.addEventListener("paste-clipboard", () => this._pasteFromClipboard());
    this._attach?.addEventListener("attach-error", (e) => this.setStatus(e.detail?.message || "attachment rejected", false));
    this._mic?.addEventListener("mic-error", (e) => this.setStatus(e.detail?.message || "mic error", false));
    // the + menu's "Choose agent" → the shared <agent-picker> in a top-layer
    // popover anchored to the + button.
    this._attach?.addEventListener("choose-agent", () => this._openAgentPicker());
    this._agentPick?.addEventListener("agent-select", (e) => this._onAgentSelect(e));
    this._agentPick?.addEventListener("agent-cancel", () => {
      // Escape: close + revert — the typed text stays, nothing commits; focus
      // returns to the input in slash mode, to the + trigger otherwise.
      this._closeAgentPicker(this._slashAgentToken ? "input" : true);
    });
  }

  /** The shared <agent-picker> selected an agent: in slash mode, replace the
   * /agent:… token with the CANONICAL textual reference (/agent:named:<id> —
   * never the ambiguous bare-id form) and record the resolved boundary so a
   * SECOND /command right after it opens its picker too (CAP-FB-20260831-
   * MULTI-SLASH-COMMANDS-01, r2 P1). */
  _onAgentSelect(e) {
    const detail = e?.detail ?? {};
    const token = this._slashAgentToken;
    this._closeAgentPicker(token ? "input" : false);
    if (token && this._input && detail.ref) {
      const ref = `/agent:${detail.ref}`;
      this._input.setRangeText(ref, token.start, token.end, "end");
      this._recordResolvedSpan(token.start, token.start + ref.length, ref);
      this._autoGrow();
    }
    this._setSelectedAgent(detail);
    this._input?.focus();
  }

  // ── the agent selection (the + menu's Choose agent + a committed /agent:
  //    option). ONE canonical agent (ref = named:<id>/background:<id>/
  //    site:<origin>) is selected at a time; the removable chip is the clear
  //    pre-send indication; the ref flows into the send detail so routing is
  //    by ID, never by a (possibly duplicated) name.
  get selectedAgent() { return this._selectedAgent; }

  _setSelectedAgent(detail) {
    const selection = selectionFromAgentCandidate({
      ref: detail?.ref,
      kind: detail?.kind,
      agentId: detail?.id ?? detail?.agentId,
      name: detail?.name ?? detail?.label,
    });
    if (!selection) return;
    this._selectedAgent = selection;
    this._resetHarnessCommands();
    this._renderAgentChip();
    this._emit("agent-change", { agent: { ...this._selectedAgent } });
  }

  /** Clear the selected agent (the chip's X, a stale registry entry, or the
   * host). Emits agent-change { agent: null, reason }. */
  clearSelectedAgent(reason = "") {
    if (!this._selectedAgent) return;
    this._selectedAgent = null;
    this._resetHarnessCommands();
    this._agentChip?.remove();
    this._agentChip = null;
    this._emit("agent-change", { agent: null, reason });
  }

  _renderAgentChip() {
    if (!this._chips || !this._selectedAgent) return;
    this._agentChip?.remove();
    const a = this._selectedAgent;
    const chip = document.createElement("span");
    chip.className = "chip agent-chip";
    const av = document.createElement("span");
    av.className = "agent-initial";
    av.setAttribute("aria-hidden", "true");
    av.textContent = (String(a.name || "?").trim()[0] || "?").toUpperCase();
    const label = document.createElement("span");
    label.textContent = a.name;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove agent ${a.name}`);
    rm.textContent = "✕";
    rm.addEventListener("click", () => {
      this.clearSelectedAgent("removed");
      this._input?.focus();
    });
    chip.append(av, label, rm);
    this._chips.prepend(chip);
    this._agentChip = chip;
  }

  /** Revalidate the selected agent against the LIVE registry (a renamed agent
   * keeps its id; a deleted/disabled one is REJECTED — the chip is cleared and
   * the caller must not route to it). Returns true when the selection is still
   * valid (or there is none). A registry FETCH failure never blocks the run. */
  async revalidateSelectedAgent() {
    if (!this._selectedAgent) return true;
    if (!RUNTIME_SEND) return true;
    let res = null;
    try {
      res = await RUNTIME_SEND("agent.registry");
    } catch {
      return true; // a transport failure must not block the send
    }
    if (!res || res.ok === false || !Array.isArray(res.groups)) return true;
    const found = findAgentByRef(res.groups, this._selectedAgent.ref);
    // A disabled background agent is no longer callable → treat as stale.
    if (!found || (found.kind === "background" && found.enabled !== true)) {
      const name = this._selectedAgent.name;
      this.clearSelectedAgent("stale");
      this.setStatus(
        `Agent "${name}" is no longer available — the selection was cleared.`,
        false,
      );
      return false;
    }
    if (found.name && found.name !== this._selectedAgent.name) {
      this._selectedAgent.name = found.name; // a rename updates the chip live
      this._renderAgentChip();
    }
    return true;
  }

  // ── the Choose agent popover (manual popover, top layer; anchored to the +
  //    button via CSS anchor positioning with the placeFloating JS fallback) ──
  //    ONE popover + ONE <agent-picker> instance serves both entry points:
  //    the + menu's "Choose agent" (chip only) and the /agent: slash command
  //    (chip + the canonical textual reference inserted). `this._slashAgentToken`
  //    is null in + menu mode and { start, end } in slash mode.
  _openAgentPicker() {
    this._slashAgentToken = null; // the + menu flow never rewrites the text
    this._presentAgentPopover();
    this._agentPick?.focusSearch?.();
  }

  /** /agent[:query] — the SAME shared picker + popover as the + menu, driven
   * by the composer text: the typed arg is synced into the picker's query on
   * every keystroke; the navigation keys are forwarded (the keydown handler);
   * the text stays put until a commit replaces the token with the canonical
   * /agent:<kind>:<id> reference (Escape reverts, nothing commits). */
  _openSlashAgentPicker(token) {
    const reopen = !this._slashAgentToken;
    this._slashAgentToken = { start: token.start, end: token.end };
    if (reopen) this._presentAgentPopover();
    // The typed arg filters the picker; the composer input KEEPS focus so the
    // user can keep typing the reference (or a space to end the token).
    this._agentPick?.setQuery?.(token.arg || "");
    const anchor = this._root?.querySelector?.(".composer") || this._attach;
    placeFloating(anchor, this._agentPop, { minWidth: 260, maxWidth: 380 });
  }

  _presentAgentPopover() {
    if (!this._agentPop || !this._agentPick) return;
    // Textbox-with-popup contract for the slash picker: the composer input
    // owns the popup — controls points at the picker's listbox (ap-list) and
    // the active descendant tracks the picker's highlighted option (ap-opt-<i>).
    this._input?.setAttribute("aria-expanded", "true");
    this._input?.setAttribute("aria-controls", "ap-list");
    if (this._selectedAgent) this._agentPick.setAttribute("selected", this._selectedAgent.ref);
    else this._agentPick.removeAttribute("selected");
    this._agentPop.hidden = false;
    if (typeof this._agentPop.showPopover === "function") {
      try { this._agentPop.showPopover(); } catch { /* already shown */ }
    }
    const anchor = this._root?.querySelector?.(".composer") || this._attach;
    placeFloating(anchor, this._agentPop, { minWidth: 260, maxWidth: 380 });
    // Live data on every open (the SW registry is the authority).
    this._agentPick.refresh?.();
    // Mirror the picker's highlight onto the focused composer textarea: the
    // picker toggles data-active on its options as the highlight moves (its
    // own search input is not the focused element — the composer textarea is),
    // so observe the list and keep aria-activedescendant in sync. childList +
    // subtree are required because the picker REPLACES its list children on
    // every render (a new query, a zero-result state, a filter change) — an
    // attributes-only observer would miss those transitions and leave a stale
    // active-descendant on the textarea.
    this._apObserver?.disconnect();
    const pickRoot = this._agentPick?.shadowRoot || this._agentPick?._root || this._agentPick;
    this._apObserver = new MutationObserver(() => {
      const active = pickRoot?.querySelector?.('#ap-list [data-active="true"]');
      if (active?.id) this._input?.setAttribute("aria-activedescendant", active.id);
      else this._input?.removeAttribute("aria-activedescendant");
    });
    const apList = pickRoot?.querySelector?.("#ap-list");
    if (apList) {
      this._apObserver.observe(apList, { attributes: true, attributeFilter: ["data-active"], childList: true, subtree: true });
      // Initial sync: the picker may already have an active option.
      const active = apList.querySelector('[data-active="true"]');
      if (active?.id) this._input?.setAttribute("aria-activedescendant", active.id);
    }
    this._agentDocClose = (e) => {
      if (!this._agentPop.contains(e.target) && !this._attach?.contains(e.target)) {
        this._closeAgentPicker(false);
      }
    };
    document.addEventListener("pointerdown", this._agentDocClose);
  }

  /** Tear down the slash-picker mirror: the MutationObserver and the
   *  document-level pointerdown close listener. Called on picker close AND on
   *  component disconnect so nothing leaks when the composer is removed from
   *  the DOM while the picker is open. */
  _teardownPicker() {
    this._apObserver?.disconnect();
    this._apObserver = null;
    if (this._agentDocClose) {
      document.removeEventListener("pointerdown", this._agentDocClose);
      this._agentDocClose = null;
    }
  }

  /** Close the picker popover. `returnFocus`: "input" refocuses the composer
   *  (the slash flow), true refocuses the + trigger, false moves no focus. */
  _closeAgentPicker(returnFocus) {
    this._slashAgentToken = null;
    // Textbox-with-popup contract: closing the picker popover restores the
    // default expanded=false state, points controls back at the items popup,
    // clears the mirror observer and the active descendant.
    this._teardownPicker();
    this._input?.setAttribute("aria-expanded", "false");
    this._input?.setAttribute("aria-controls", `popup-${this._uid}`);
    this._input?.removeAttribute("aria-activedescendant");
    if (!this._agentPop) return;
    if (typeof this._agentPop.hidePopover === "function") {
      try { this._agentPop.hidePopover(); } catch { /* already hidden */ }
    }
    this._agentPop.hidden = true;
    // The slash picker's aria-expanded is owned here (the items popup manages
    // its own via _showPopup/_hidePopup).
        if (returnFocus === "input") {
      this._input?.focus();
    } else if (returnFocus) {
      // Focus returns to the + button (the trigger), falling back to the input.
      const plus = this._attach?.shadowRoot?.querySelector?.(".plus");
      (plus ?? this._input)?.focus?.();
    }
  }

  // ── the + menu's browser-context actions (record-screen / grab-screenshot /
  // add-tab) — each requests the OPTIONAL browser permission in the SAME user
  // gesture (the menu click) then acts. A missing/denied permission surfaces a
  // clear status (never a silent no-op).

  /** Verify install-granted permissions. Every API permission + host access is
   *  granted at install (manifest permissions + host_permissions <all_urls>),
   *  so there is no runtime request left — this VERIFIES with contains() and
   *  fails CLOSED: a contains() error is treated as NOT granted. Supports both
   *  API permissions (perms) and scoped host origins (origins). */
  async _verifyPermission(perms, origins) {
    if (!chrome?.permissions?.contains) return true; // no API → treat as available
    const req = {};
    if (perms?.length) req.permissions = perms;
    if (origins?.length) req.origins = origins;
    try { return (await chrome.permissions.contains(req)) === true; }
    catch { return false; }
  }

  /** A floating tab picker. Resolves with the chosen tab or null (cancelled). */
  _pickTab(tabs) {
    return new Promise((resolve) => {
      this._closeTabPicker();
      const picker = document.createElement("div");
      picker.className = "tab-picker";
      picker.setAttribute("role", "listbox");
      picker.setAttribute("aria-label", "Pick a tab");
      const list = document.createElement("div");
      list.className = "tp-list";
      for (const t of tabs) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "tp-row tab-picker-item";
        row.setAttribute("role", "option");
        const title = document.createElement("span");
        title.className = "tp-title";
        title.textContent = t.title || "(untitled)";
        const url = document.createElement("span");
        url.className = "tp-url";
        url.textContent = t.url || "";
        row.append(title, url);
        row.addEventListener("click", () => { this._closeTabPicker(); resolve(t); });
        list.append(row);
      }
      const empty = document.createElement("div");
      empty.className = "tp-empty";
      empty.textContent = "No tabs.";
      picker.append(list, empty);
      picker.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          this._closeTabPicker();
          this._input?.focus();
          resolve(null);
          return;
        }
        const buttons = [...list.querySelectorAll("button")];
        if (!buttons.length) return;
        const idx = buttons.indexOf(document.activeElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const d = e.key === "ArrowDown" ? 1 : -1;
          const next = idx < 0 ? (d === 1 ? 0 : buttons.length - 1) : (idx + d + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      });
      document.body.append(picker); // fixed positioning, never clipped by the composer
      this._tabPicker = picker;
      placeFloating(this._input, picker, { minWidth: 300 });
      const outsideClick = (e) => {
        if (this._tabPicker && !this._tabPicker.contains(e.target)) {
          this._closeTabPicker();
          resolve(null);
        }
      };
      this._tabPickerOutsideClick = outsideClick;
      document.addEventListener("pointerdown", outsideClick);
      list.querySelector("button")?.focus();
    });
  }
  _closeTabPicker() {
    if (this._tabPickerOutsideClick) {
      document.removeEventListener("pointerdown", this._tabPickerOutsideClick);
      this._tabPickerOutsideClick = null;
    }
    if (this._tabPicker) {
      this._tabPicker.remove();
      this._tabPicker = null;
    }
  }

  /** A "Recording… ▸ Stop" chip so record-screen / record-audio have a visible
   *  start/stop control (not an invisible OS-share-ended flow). */
  _showRecordingUI(stopCb) {
    this._clearRecordingUI();
    const chip = document.createElement("span");
    chip.className = "chip recording";
    const dot = document.createElement("span");
    dot.className = "rec-dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = "Recording…";
    const stop = document.createElement("button");
    stop.type = "button";
    stop.textContent = "Stop";
    stop.addEventListener("click", () => stopCb());
    chip.append(dot, label, stop);
    this._chips?.append(chip);
    this._recordingChip = chip;
  }
  _clearRecordingUI() {
    this._recordingChip?.remove();
    this._recordingChip = null;
  }

  async _contextAction(kind) {
    try {
      if (kind === "add-tab" || kind === "grab-screenshot") {
        // Both pick a tab. add-tab attaches the tab as a reference (title+url);
        // grab-screenshot activates + captures the chosen tab. Listing the tabs
        // needs `tabs`; capturing a SPECIFIC tab needs host access to THAT
        // origin (activeTab is transient + tied to the tab active at grant
        // time, so it does not authorize a later-activated pick). Both are
        // install-granted — verified here (fail closed), never a runtime ask.
        const tabsGranted = await this._verifyPermission(["tabs"]);
        if (!tabsGranted) { this.setStatus("tab listing unavailable — enable the Tabs permission in Settings → Permissions, or from the chat when prompted.", false); return; }
        const tabs = await chrome.tabs.query({}).catch(() => []);
        if (!tabs.length) { this.setStatus("no open tabs to pick from."); return; }
        const tab = await this._pickTab(tabs);
        if (!tab) return; // cancelled
        if (kind === "add-tab") {
          this._attachMedia({ name: tab.title || tab.url || "tab", url: tab.url || "", type: "tab", size: 0, kind: "tab", tabId: tab.id, windowId: tab.windowId });
          this.setStatus(`attached tab: ${tab.title || tab.url}`);
          return;
        }
        // Capture the picked tab: verify host access to that origin (install-granted).
        let origin = "";
        try { origin = new URL(tab.url || "").origin; } catch { /* keep empty */ }
        if (origin && origin !== "null") {
          const granted = await this._verifyPermission(null, [`${origin}/*`]);
          if (!granted) { this.setStatus(`screenshot blocked — grant access to ${origin} in the permission prompt.`, false); return; }
        }
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
        const dataURL = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        this._attachMedia({ name: `screenshot-${Date.now()}.png`, type: "image/png", size: Math.round((dataURL.length * 3) / 4), dataURL, kind: "image" });
        this.setStatus("attached a screenshot of " + (tab.title || "the tab"));
        return;
      }
      if (kind === "capture-page") {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
        const targetTab = tabs[0];
        if (!targetTab?.id) { this.setStatus("no active tab to capture.", false); return; }
        this.setStatus("Capturing page as readable note...");
        let res;
        if (typeof globalThis.chrome?.runtime?.sendMessage === "function") {
          res = await globalThis.chrome.runtime.sendMessage({
            type: "page.capture",
            tabId: targetTab.id,
            asArtifact: true,
          }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));
        }
        if (res && res.ok !== false && (res.artifactId || res.markdown)) {
          this.setStatus(`Captured “${res.title || targetTab.title || 'page'}” as readable artifact`);
          this._emit("command", {
            namespace: "capture",
            item: {
              id: res.artifactId ? `artifact:${res.artifactId}` : "captured-page",
              label: res.title || "Captured page",
              kind: "artifact",
              artifactId: res.artifactId,
            },
          });
        } else {
          this.setStatus(`Could not capture page: ${res?.error || "unknown error"}`, false);
        }
        return;
      }
      if (kind === "record-screen") {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("screen recording not available");
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const mime = MediaRecorder.isTypeSupported?.("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";
        const rec = new MediaRecorder(stream, { mimeType: mime });
        const chunks = [];
        rec.ondataavailable = (ev) => { if (ev.data?.size) chunks.push(ev.data); };
        rec.onstop = () => {
          this._clearRecordingUI();
          const blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
          stream.getTracks().forEach((t) => t.stop());
          const fr = new FileReader();
          fr.onload = () => {
            this._attachMedia({ name: `screen-${Date.now()}.webm`, type: blob.type || "video/webm", size: blob.size, dataURL: String(fr.result), kind: "video" });
            this.setStatus("screen recording attached.");
          };
          fr.readAsDataURL(blob);
        };
        stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (rec.state !== "inactive") rec.stop(); });
        rec.start();
        this._showRecordingUI(() => { if (rec.state !== "inactive") rec.stop(); });
        return;
      }
    } catch (e) {
      const msg = e?.name === "NotAllowedError"
        ? "screen capture permission denied"
        : "couldn't " + kind + ": " + (e?.message ?? e);
      this.setStatus(msg, false);
    }
  }

  async _pasteFromClipboard() {
    try {
      const res = await readClipboardOnGesture({
        hasUserGesture: true,
        readTextFn: () => (navigator.clipboard?.readText ? navigator.clipboard.readText() : Promise.resolve("")),
      });
      if (res.ok && res.rawText) {
        this._attachMedia({
          name: "clipboard.txt",
          type: "text/plain",
          size: new TextEncoder().encode(res.rawText).byteLength,
          kind: "text",
          text: res.text,
          untrusted: true,
          source: "clipboard",
        });
        this.setStatus("Attached clipboard text.");
      } else {
        this.setStatus(res.error || "Clipboard is empty.", false);
      }
    } catch (e) {
      this.setStatus(`Couldn't read clipboard: ${e?.message ?? e}`, false);
    }
  }

  // ── media capture (record-audio / capture-camera) ──────────────────────
  // A short audio recording / a camera frame becomes a dataURL attachment (the
  // SW bounds it + sends it to the model like any file).
  //
  // PLATFORM NOTE (owner report 2026-08-29): the audioCapture/videoCapture
  // MANIFEST permissions gate only the ChromeOS-only chrome.audioCapture /
  // chrome.videoCapture APIs. On Linux/macOS/Windows those namespaces do not
  // exist, so a contains() gate would dead-end every capture with a
  // "permission denied" that no reload can fix. Plain getUserMedia from this
  // page needs NO manifest permission — the browser shows its own device
  // prompt. So: when the permission is not granted, check whether it is even
  // AVAILABLE here; only on a platform where the API exists does the gate
  // apply (ChromeOS enterprise policy), and elsewhere we skip straight to
  // getUserMedia, which self-prompts.
  async _captureMedia(kind) {
    try {
      const perm = kind === "record-audio" ? "audioCapture" : "videoCapture";
      const granted = await this._verifyPermission([perm]);
      if (!granted) {
        const api = perm === "audioCapture" ? chrome.audioCapture : chrome.videoCapture;
        if (typeof api === "undefined") {
          // Platform-absent API: the manifest permission can never be granted
          // here. getUserMedia self-prompts — no dead-end gate.
          this.setStatus(`Using the browser's own ${kind === "record-audio" ? "microphone" : "camera"} prompt.`, true);
        } else {
          this.setStatus(`${perm} permission denied — enable it to capture.`, false);
          return;
        }
      }
      if (kind === "record-audio") {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = MediaRecorder.isTypeSupported?.("audio/webm") ? "audio/webm" : "";
        const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const chunks = [];
        rec.ondataavailable = (ev) => { if (ev.data?.size) chunks.push(ev.data); };
        rec.onstop = () => {
          this._clearRecordingUI();
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          const fr = new FileReader();
          fr.onload = () => {
            this._attachMedia({ name: "recording.webm", type: blob.type || "audio/webm", size: blob.size, dataURL: String(fr.result), kind: "audio" });
            this.setStatus("Audio attached.");
          };
          fr.readAsDataURL(blob);
        };
        rec.start();
        this._showRecordingUI(() => { if (rec.state !== "inactive") rec.stop(); });
        return;
      }
      if (kind === "capture-camera") {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        try {
          const video = document.createElement("video");
          video.srcObject = stream;
          video.muted = true;
          video.playsInline = true;
          await video.play();
          await sleep(400); // let the frame settle
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 480;
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataURL = canvas.toDataURL("image/png");
          this._attachMedia({ name: "camera.png", type: "image/png", size: dataURL.length, dataURL, kind: "image" });
          this.setStatus("Photo attached.");
        } finally {
          stream.getTracks().forEach((t) => t.stop());
        }
        return;
      }
    } catch (e) {
      const msg = e?.name === "NotAllowedError"
        ? "media permission denied"
        : "media capture failed: " + (e?.message ?? e);
      this.setStatus(msg, false);
    }
  }
  _attachMedia(detail) {
    this.attachments.push(detail);
    this._addChip(detail);
    this._emit("attach", detail);
  }
  get input() { return this._input; }
  get value() { return this._input?.value ?? ""; }
  set value(v) {
    if (this._input) {
      this._input.value = v;
      this._autoGrow();
      const hasText = !!String(v ?? "").trim();
      if (this._run) {
        this._run.disabled = !hasText;
        this._run.classList.toggle("has-input", hasText);
      }
    }
  }
  async _ingestFile(file) {
    if (!file) return null;
    const isImage = file.type?.startsWith("image/");
    const name = file.name || (isImage ? "pasted-image.png" : "file");
    const mediaType = file.type || (isImage ? "image/png" : "application/octet-stream");
    let dataUrl = "";
    let text = "";
    if (isImage) {
      try {
        dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(file);
        });
      } catch { /* read error */ }
    } else if (isTextLikeAttachment({ name, type: mediaType }) || (typeof file.text === "function" && /^(text\/|application\/(json|xml|javascript))/i.test(mediaType))) {
      if (typeof file.text === "function") {
        try {
          text = await file.text();
          dataUrl = textToDataUrl(text, mediaType);
        } catch { /* fallback */ }
      }
      if (!dataUrl) {
        try {
          dataUrl = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result));
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(file);
          });
        } catch { /* read error */ }
      }
    } else {
      try {
        dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(file);
        });
      } catch { /* read error */ }
    }
    return this.addAttachment({
      kind: isImage ? "image" : "file",
      name,
      type: mediaType,
      mediaType,
      size: file.size ?? 0,
      dataUrl,
      dataURL: dataUrl,
      text,
      content: text,
    });
  }

  /** Public: attach something (a reused artifact, an external reference) to the
   * composer — pushes it onto the pending attachments + renders a removable
   * chip, exactly like the + menu does. Returns the stored detail. */
  addAttachment(detail) {
    if (!detail) return null;
    const d = {
      name: detail.name ?? "attachment",
      type: detail.type ?? detail.mediaType,
      size: detail.size,
      dataURL: detail.dataURL ?? detail.dataUrl,
      content: detail.content ?? detail.text,
      kind: detail.kind ?? "file",
      // local-folder references carry their grant identity through to the
      // run: sanitize + attachmentContext both preserve these (CAP-FB-20260831-FOLDER-COMMAND-01).
      grantId: typeof detail.grantId === "string" ? detail.grantId : undefined,
      folderName: typeof detail.folderName === "string" ? detail.folderName : undefined,
      // Page-derived attachments (the "Ask agent" right-click / shortcut
      // prefill, lib/ask-agent-entry.js) carry the untrusted tag + their
      // reference so the run fences them and the model sees what was picked.
      ...(detail.untrusted === true ? { untrusted: true } : {}),
      ...(typeof detail.url === "string" && detail.url ? { url: detail.url } : {}),
      ...(typeof detail.srcUrl === "string" && detail.srcUrl ? { srcUrl: detail.srcUrl } : {}),
      ...(Number.isInteger(detail.tabId) ? { tabId: detail.tabId } : {}),
    };
    this.attachments.push(d);
    this._addChip(d);
    this._emit("attach", d);
    return d;
  }
  setStatus(text, ready = true) {
    if (this._status) this._status.textContent = text || "";
    this._emit("status", { text, ready });
  }
  setLoading(loading) {
    if (loading) this._run?.setAttribute("loading", "");
    else this._run?.removeAttribute("loading");
  }
  focus() { this._input?.focus(); }

  async _openLocalFoldersSettings(recovery = "Open Settings → Local folders to grant or re-grant access.") {
    const api = globalThis.chrome;
    try {
      if (api?.tabs?.create && api?.runtime?.getURL) {
        await api.tabs.create({ url: api.runtime.getURL("options/options.html#local-folders") });
      } else {
        await api?.runtime?.openOptionsPage?.();
      }
      this.setStatus(recovery);
    } catch (err) {
      this.setStatus(`Couldn't open Settings: ${err?.message ?? err}. Open Settings → Local folders manually.`, false);
    }
  }

  async _attachLocalFile(file) {
    if (!file?.grantId || !file?.relativePath) {
      this.setStatus("That local file reference is incomplete — search again with /files.", false);
      return;
    }
    const textLike = isTextLikeAttachment(file);
    // dptw: text files attach as text at ANY size — no 1 MiB gate. If the read
    // fails (permissions, transport), the honest status below says why.
    let attachAsText = textLike;
    let dataURL = "";
    let type = String(file.type || (textLike ? "text/plain" : "application/octet-stream"));
    if (attachAsText) {
      const read = RUNTIME_SEND
        ? await RUNTIME_SEND("fs-grant.read-file", {
          grantId: file.grantId,
          relativePath: file.relativePath,
          asText: true,
        }).catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
        : { ok: false, error: "extension runtime unavailable" };
      if (read?.error === "fs_file_not_text") {
        attachAsText = false;
      } else if (!read?.ok || typeof read.content !== "string") {
        const recovery = read?.error === "fs_permission_lapsed"
          ? read.status === "denied"
            ? `${file.folderName} access was denied. Open Settings → Local folders, forget it, then add it again.`
            : `${file.folderName} needs access again. Open Settings → Local folders and choose Re-grant access.`
          : `Couldn't read ${file.name}: ${read?.error || "unknown error"}.`;
        this.setStatus(recovery, false);
        return;
      } else {
        dataURL = textToDataUrl(read.content, type);
      }
    }
    this.addAttachment({
      name: file.name,
      type,
      size: Number(file.size) || 0,
      dataURL,
      kind: "local-file",
    });
    this.setStatus(attachAsText
      ? `Attached ${file.name} from ${file.folderName} as text context.`
      : `Attached ${file.name} as a reference (binary; contents weren't read).`);
  }

  // /folder — a granted FOLDER attaches as a REFERENCE ONLY: never read or
  // inline its contents (unlike /files, which reads text files ≤ 1 MiB). The
  // grantId survives sanitization so the model-facing local-file tools
  // (CAP-FB-20260830-LOCAL-FILE-EDIT-TOOLS-01) can resolve it once they land.
  async _attachLocalFolder(folder) {
    if (!folder?.grantId) {
      this.setStatus("That local folder reference is incomplete — search again with /folder.", false);
      return;
    }
    const name = String(folder.folderName || folder.label || "folder");
    this.addAttachment({
      name,
      type: "text/uri-list",
      size: 0,
      kind: "local-folder",
      grantId: String(folder.grantId),
      folderName: name,
    });
    this.setStatus(`Attached folder ${name} as a reference (grant ${String(folder.grantId).slice(0, 8)}…).`);
  }

  // ── / command + @ mention popup ─────────────────────────────────────────
  get _popupOpen() { return !!(this._popup && !this._popup.hidden); }

  async _onComposerInput() {
    const input = this._input;
    if (!input) return;
    this._autoGrow();
    const hasText = !!input.value?.trim();
    if (this._run) {
      this._run.disabled = !hasText;
      this._run.classList.toggle("has-input", hasText);
    }
    const text = input.value;
    const caret = input.selectionStart ?? text.length;

    if (this._harnessId) {
      // Harness command position belongs to the harness, never CAP /skill.
      if (/^[/$][^\s]*$/u.test(text.slice(0, caret))) {
        this._openHarnessCommands();
        return;
      }
      this._hidePopup();
      return;
    }
    // / command — command position (shared/command-parser.js): a slash at the
    // start of the input, OR a slash typed immediately after a RESOLVED
    // COMMAND REFERENCE the composer inserted earlier (CAP-FB-20260831-MULTI-
    // SLASH-COMMANDS-01: multiple /commands in one input). Mid-prose slashes,
    // URLs, mid-word slashes and leading-space tokens never open the UI.
    // The token ends at the first space, so the task text after a command is
    // plain text again.
    const resolvedSpans = (this._resolvedSpans || []).filter((s) => {
      if (!s || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end > text.length || s.end <= s.start) return false;
      return text.slice(s.start, s.end) === s.text;
    });
    this._resolvedSpans = resolvedSpans;
    const resolvedEnds = new Set(resolvedSpans.map((s) => s.end));
    const slash = parseSlashCommand(text, caret, resolvedEnds);
    if (slash?.ns === "agent") {
      // /agent or /agent:query — the ONE shared <agent-picker> (the same
      // renderer + a11y contract as the + menu's Choose agent). Exact /agent
      // opens immediately; a colon adds a live search query.
      this._hidePopup();
      this._openSlashAgentPicker({ start: slash.start, end: slash.end, arg: slash.arg });
      return;
    }
    // Any non-/agent parse result closes the slash picker if it was open (e.g.
    // the user backspaced over the ":" or typed a space after the token).
    if (this._slashAgentToken) this._closeAgentPicker(false);
    if (slash) {
      const slashPos = slash.start;
      const ns = slash.ns;
      const arg = slash.arg.trim();
      // `/files` is itself the browse command; the colon form remains useful
      // for a name substring (`/files:report`).
      if (!slash.hasColon && ns === "files" && supportsLocalFilesCommand()) {
        const items = await commandItems("files", "", this._currentAgentId, this._currentAgentKind);
        this._showPopup(items, { type: "command", start: slashPos, end: caret, ns: "files", arg: "" });
        return;
      }
      // `/folder` behaves like `/files`: bare `/folder` lists granted folders
      // immediately; `/folder:query` filters by name substring.
      if (!slash.hasColon && ns === "folder" && supportsLocalFilesCommand()) {
        const items = await commandItems("folder", "", this._currentAgentId, this._currentAgentKind);
        this._showPopup(items, { type: "command", start: slashPos, end: caret, ns: "folder", arg: "" });
        return;
      }
      // `/command` or `/cmd` opens the imported commands picker directly.
      if (!slash.hasColon && (ns === "command" || ns === "cmd")) {
        let items;
        try { items = await commandItems("command", ""); }
        catch (error) {
          this._hidePopup();
          this.setStatus(`couldn't list commands: ${error?.message ?? error}`, false);
          return;
        }
        if (input.value !== text || (input.selectionStart ?? input.value.length) !== caret) return;
        this._showPopup(items.map((item) => ({ ...item, ns: "command" })), {
          type: "command", start: slashPos, end: caret, ns: "command", arg: "",
        });
        return;
      }
      if (!slash.hasColon) {
        // Chrome-deep commands open their picker as soon as their full name is
        // typed (/tabs); adding a colon turns the remainder into the search.
        const direct = COMMAND_NAMESPACES.find((item) => item.direct && item.id === ns);
        if (direct) {
          let items;
          try { items = await commandItems(ns, ""); }
          catch (error) {
            this._hidePopup();
            this.setStatus(`couldn't list ${ns}: ${error?.message ?? error}`, false);
            return;
          }
          // Ignore a slow API response after the owner has edited the token.
          if (input.value !== text || (input.selectionStart ?? input.value.length) !== caret) return;
          this._showPopup(items.map((item) => ({ ...item, ns })), {
            type: "command", start: slashPos, end: caret, ns, arg: "",
          });
          return;
        }
        // No colon typed yet — FILTER the namespace list by the typed prefix
        // (/ → all, /s → schedule + skill, /sk → skill).
        const groupOrder = ["Attach context", "Run & switch", "Session"];
        const items = COMMAND_NAMESPACES
          .filter((n) => !ns || n.id.startsWith(ns) || n.label.startsWith(ns) || (n.id === "command" && "cmd".startsWith(ns)))
          .map((n) => ({ id: `cmd:${n.id}`, label: `/${n.label}`, description: n.description, kind: n.kind, ns: n.id, group: n.group }))
          .sort((a, b) => {
            const ga = groupOrder.indexOf(a.group);
            const gb = groupOrder.indexOf(b.group);
            return (ga === -1 ? 99 : ga) - (gb === -1 ? 99 : gb);
          });
        this._showPopup(items, { type: "command", start: slashPos, end: caret, ns: "", arg: "", query: ns });
        return;
      }
      if (!ns) {
        // A colon with no namespace (e.g. "/:") — show all namespaces.
        const groupOrder = ["Attach context", "Run & switch", "Session"];
        const items = COMMAND_NAMESPACES.map((n) => ({
          id: `cmd:${n.id}`, label: `/${n.label}`, description: n.description, kind: n.kind, ns: n.id, group: n.group,
        })).sort((a, b) => {
          const ga = groupOrder.indexOf(a.group);
          const gb = groupOrder.indexOf(b.group);
          return (ga === -1 ? 99 : ga) - (gb === -1 ? 99 : gb);
        });
        this._showPopup(items, { type: "command", start: slashPos, end: caret, ns: "", arg: "", query: "" });
        return;
      }
      let items;
      try { items = await commandItems(ns, arg); }
      catch (error) {
        this._hidePopup();
        this.setStatus(`couldn't search ${ns}: ${error?.message ?? error}`, false);
        return;
      }
      // API-backed searches can resolve out of order while the owner types.
      if (input.value !== text || (input.selectionStart ?? input.value.length) !== caret) return;
      if (!items.length && ns === "remember") {
        this._showPopup([{ id: "free:remember", label: "/remember ", description: "write to memory", kind: "free", ns: "remember", free: true }],
          { type: "command", start: slashPos, end: caret, ns, arg });
        return;
      }
      this._showPopup(items.map((i) => ({ ...i, ns })), { type: "command", start: slashPos, end: caret, ns, arg });
      return;
    }

    // @ mention — legal anywhere a fresh token begins (a /agent-targeted task
    // can still mention agents inline); parseMentionToken is the ONE tokenizer.
    const at = parseMentionToken(text, caret);
    if (at) {
      const items = await mentionCandidates(at.query, this._currentAgentId, this._currentAgentKind);
      this._showPopup(items, { type: "mention", start: at.start, end: at.end });
      return;
    }

    this._hidePopup();
  }

  async _openHarnessCommands(browse = false) {
    const input = this._input;
    if (!input || !this._harnessId) return;
    const harnessId = this._harnessId;
    const caret = input.selectionStart ?? input.value.length;
    const prefix = /^[/$][^\s]*$/u.test(input.value.slice(0, caret)) ? input.value.slice(0, caret) : "";
    if (!browse && !prefix) return;
    const token = { type: "harness", start: prefix ? 0 : caret, end: caret };
    const show = () => {
      const catalogue = this._harnessCatalogue;
      const items = harnessCommandItems(catalogue?.commands, prefix);
      const message = this._harnessLoading ? "Loading harness commands…"
        : catalogue?.error || (!catalogue?.received ? "No command catalogue arrived. Use Harness commands to try again."
          : !catalogue.commands?.length ? "This harness advertised no commands."
          : "No matching harness commands.");
      this._showPopup(items.length ? items : [{ label: message, disabled: true }], token);
      this._popup?.setAttribute("aria-label", `${harnessId} advertised commands — insert text only`);
    };
    show();
    input.focus();
    if (this._harnessCatalogue || this._harnessLoading) return;
    const request = ++this._harnessRequest;
    this._harnessLoading = true;
    show();
    let catalogue;
    try {
      catalogue = await RUNTIME_SEND?.("acp.commands", { harnessId, threadId: this.getAttribute("thread-id") || null }, 22000);
      if (!catalogue?.ok) catalogue = { error: catalogue?.error || "Cannot load harness commands. Check the bridge and try again." };
    } catch { catalogue = { error: "Cannot load harness commands. Check the bridge and try again." }; }
    if (request !== this._harnessRequest || !this.isConnected || this._harnessId !== harnessId || this._input !== input) return;
    this._harnessLoading = false;
    this._harnessCatalogue = catalogue;
    // Escape dismisses even while the connection is pending. A late reply may
    // update this scope's snapshot, but never reopen a dismissed popup.
    if (this._popupOpen && this._popupToken?.type === "harness") this._openHarnessCommands(browse);
  }

  _showPopup(items, token) {
    this._popupItems = items || [];
    this._popupToken = token || null;
    this._popupActive = this._popupItems.length ? 0 : -1;
    if (!this._popupItems.length) { this._hidePopup(); return; }
    this._renderPopupItems();
    if (this._popup) {
      this._popup.hidden = false;
      if (typeof this._popup.showPopover === "function") {
        try { this._popup.showPopover(); } catch { /* already shown */ }
      }
      // Combobox contract (CAP-FB-20260830-SLASH-PALETTE-COMBOBOX-01): the
      // textarea owns the popup listbox while it is open — expanded true,
      // controls the popup, activedescendant the highlighted option.
      this._input?.setAttribute("aria-expanded", "true");
      this._input?.setAttribute("aria-controls", `popup-${this._uid}`);
      const active = this._popup.querySelector(`[data-index="${this._popupActive}"]`);
      if (active?.id) this._input?.setAttribute("aria-activedescendant", active.id);

      if (!supportsAnchorPositioning()) {
        // TODO(baseline/anchor-positioning): Remove position:fixed fallback and getBoundingClientRect viewport math.
        // Fallback for browsers without CSS anchor positioning:
        // Position relative to viewport since popover is in the top layer.
        const composerEl = this._root?.querySelector?.(".composer");
        if (composerEl) {
          const rect = composerEl.getBoundingClientRect();
          const viewportH = (typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 800;
          const viewportW = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 1200;
          const spaceBelow = viewportH - rect.bottom - 12;
          const spaceAbove = rect.top - 12;
          const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;
          const availableHeight = openAbove ? spaceAbove : spaceBelow;
          const minW = Math.min(260, Math.max(0, viewportW - 16));
          const widthVal = rect.width ? Math.min(440, Math.max(minW, Math.floor(rect.width))) : Math.min(360, Math.max(minW, 360));
          const leftVal = Math.max(8, Math.min(rect.left, Math.max(8, viewportW - widthVal - 8)));
          this._popup.style.position = "fixed";
          if (openAbove) {
            this._popup.style.bottom = `${Math.max(8, viewportH - rect.top + 6)}px`;
            this._popup.style.top = "auto";
          } else {
            this._popup.style.top = `${rect.bottom + 6}px`;
            this._popup.style.bottom = "auto";
          }
          this._popup.style.left = `${leftVal}px`;
          this._popup.style.right = "auto";
          this._popup.style.width = `${widthVal}px`;
          this._popup.style.maxWidth = `${viewportW - 16}px`;
          this._popup.style.maxHeight = `${Math.min(320, Math.max(0, Math.floor(availableHeight)))}px`;
        }
      } else {
        // In native anchor positioning, CSS handles position-area, position-try-fallbacks,
        // sizing, and max-height natively. Clear all inline styles.
        this._popup.style.position = "";
        this._popup.style.top = "";
        this._popup.style.bottom = "";
        this._popup.style.left = "";
        this._popup.style.right = "";
        this._popup.style.width = "";
        this._popup.style.maxWidth = "";
        this._popup.style.maxHeight = "";
      }
    }
  }

  _renderPopupItems() {
    if (!this._popup) return;
    this._popup.replaceChildren();
    this._popup.removeAttribute("aria-describedby");
    if (this._popupToken?.type === "harness") {
      const note = document.createElement("div");
      note.className = "empty";
      note.id = `cmp-${this._uid}-harness-note`;
      note.textContent = "Inserts text only. CAP cannot run these as harness commands yet. This list comes from a separate connection.";
      if (this._harnessId === "pi") note.textContent += " Pi cannot run CAP tools yet; choose Claude Code or Codex to run.";
      this._popup.appendChild(note);
      this._popup.setAttribute("aria-describedby", note.id);
    } else if (this._popupToken?.type === "command") {
      // chrome-agent-platform-fwf6: composer commands (/skill:x, /x) are
      // insertion-only too — selecting one puts text in the message, it is not
      // dispatched as a bare command. Shown at the point of choice and hung off
      // the listbox as its accessible description, from the ONE constant the
      // registry exports (COMMAND_INSERTION_DISCLOSURE).
      const note = document.createElement("div");
      note.className = "empty";
      note.id = `cmp-${this._uid}-insertion-note`;
      note.textContent = COMMAND_INSERTION_DISCLOSURE;
      this._popup.appendChild(note);
      this._popup.setAttribute("aria-describedby", note.id);
      this._popup.setAttribute("aria-label", "Composer commands");
    } else this._popup.setAttribute("aria-label", "Agent and resource mentions");
    const groups = new Set(this._popupItems.map((it) => it.group).filter(Boolean));
    const isFiltered = Boolean(this._popupToken?.query || this._popupToken?.arg);
    const showGroups = !isFiltered || groups.size > 1;
    let lastGroup = null;
    this._popupItems.forEach((it, i) => {
      // Group headers (the /agent list is grouped Named / Background / Site —
      // the same grouping as the shared <agent-picker>). Group names are
      // owner-controlled (agent kinds), so they go through textContent.
      if (showGroups && it.group && it.group !== lastGroup) {
        const gh = document.createElement("div");
        gh.className = "group-label";
        gh.setAttribute("role", "presentation");
        gh.textContent = String(it.group);
        this._popup.appendChild(gh);
        lastGroup = it.group;
      }
      const item = document.createElement("div");
      item.className = "item";
      item.setAttribute("role", "option");
      item.id = `cmp-${this._uid}-opt-${i}`;
      item.dataset.index = String(i);
      item.dataset.active = String(i === this._popupActive);
      item.setAttribute("aria-selected", String(i === this._popupActive));
      if (it.disabled) item.setAttribute("aria-disabled", "true");
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = String(it.label);
      item.appendChild(lbl);
      if (it.description) {
        const dsc = document.createElement("span");
        dsc.className = "dsc";
        dsc.textContent = String(it.description);
        item.appendChild(dsc);
      }
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._select(Number(item.dataset.index));
      });
      this._popup.appendChild(item);
    });

    if (this._popupItems.length > 0) {
      const footer = document.createElement("div");
      footer.className = "menu-footer";
      footer.setAttribute("role", "presentation");
      footer.setAttribute("aria-hidden", "true");
      footer.textContent = "↑↓ Navigate · ↵ Select · Esc Dismiss";
      this._popup.appendChild(footer);
    }
    // The textarea's activedescendant is kept in lockstep with the highlight
    // (textbox-with-popup: aria-expanded + aria-controls + activedescendant).
    const active = this._popup.querySelector(`[data-index="${this._popupActive}"]`);
    if (active?.id) this._input?.setAttribute("aria-activedescendant", active.id);
    active?.scrollIntoView({ block: "nearest" });
  }

  _setSelectionIndex(i) {
    if (!this._popupItems.length) return;
    const n = this._popupItems.length;
    this._popupActive = ((i % n) + n) % n;
    this._renderPopupItems();
    const active = this._popup?.querySelector(`[data-index="${this._popupActive}"]`);
    // Keep the textarea's activedescendant in lockstep with the highlight.
    if (active?.id) this._input?.setAttribute("aria-activedescendant", active.id);
    active?.scrollIntoView({ block: "nearest" });
  }

  _moveSelection(delta) {
    this._setSelectionIndex(this._popupActive + delta);
  }

  _selectActive() { this._select(this._popupActive); }

  async _select(index) {
    const item = this._popupItems[index];
    const token = this._popupToken;
    const input = this._input;
    if (!item || !token || !input) { this._hidePopup(); return; }

    if (item.disabled) return;
    if (token.type === "harness") {
      input.setRangeText(`${item.id} `, token.start, token.end, "end");
      this._hidePopup();
      this._autoGrow();
      input.focus();
      return;
    }
    if (token.type === "command") {
      if (item.kind === "files-action") {
        input.setRangeText("", token.start, token.end, "end");
        this._hidePopup();
        if (typeof this.folderActions?.grant === "function" || typeof this.folderActions?.regrant === "function") {
          try {
            const action = item.action === "regrant" ? (this.folderActions.regrant || this.folderActions.grant) : (this.folderActions.grant || this.folderActions.regrant);
            await action(item);
            input.focus();
            return;
          } catch { /* fall back */ }
        }
        const grantEv = new CustomEvent("grant-folder", {
          bubbles: true,
          composed: true,
          cancelable: true,
          detail: { item, recovery: item.recovery },
        });
        this.dispatchEvent(grantEv);
        if (grantEv.defaultPrevented) {
          input.focus();
          return;
        }
        this._openLocalFoldersSettings(item.recovery);
        input.focus();
        return;
      }
      if (item.kind === "local-file") {
        input.setRangeText("", token.start, token.end, "end");
        this._hidePopup();
        this._attachLocalFile(item);
        input.focus();
        return;
      }
      if (item.kind === "local-folder") {
        input.setRangeText("", token.start, token.end, "end");
        this._hidePopup();
        this._attachLocalFolder(item);
        input.focus();
        return;
      }
      if (item.kind === "paste") {
        input.setRangeText("", token.start, token.end, "end");
        this._hidePopup();
        await this._pasteFromClipboard();
        input.focus();
        return;
      }
      if (item.free) {
        input.setRangeText(`/${item.ns} `, token.start, token.end, "end");
        this._hidePopup();
        this._emit("command", { namespace: item.ns, item });
        input.focus();
        return;
      }
      if (!token.ns) {
        // A namespace was picked → insert the prefix + reopen with its sub-items.
        input.setRangeText(`/${item.ns}:`, token.start, token.end, "end");
        this._hidePopup();
        this._onComposerInput();
        input.focus();
        return;
      }
      if (item.kind === "command") {
        const textToInsert = item.insertText || item.prompt || `/${item.id}`;
        input.setRangeText(textToInsert, token.start, token.end, "end");
        this._hidePopup();
        this._recordResolvedSpan(token.start, token.start + textToInsert.length, textToInsert);
        this._emit("command", { namespace: item.ns || "command", item });
        this._autoGrow();
        input.focus();
        return;
      }
      if (item.kind === "capability") {
        const perm = item.capability || token.ns || item.ns;
        const chromeApi = globalThis.chrome;
        if (perm && chromeApi?.permissions?.request) {
          try {
            const granted = await chromeApi.permissions.request({ permissions: [perm] });
            if (granted) {
              this.setStatus(`Granted ${perm} permission.`);
              await this._onComposerInput();
              input.focus();
              return;
            }
          } catch {
            // fall through to settings
          }
        }
        this._hidePopup();
        this.setStatus(`${item.label} — ${item.description}`, false);
        globalThis.chrome?.runtime?.openOptionsPage?.();
        input.focus();
        return;
      }
      // A concrete item resolves to its textual reference and, for Chrome-deep
      // commands, the pending context attachment the agent actually receives.
      const fallbackText = `/${item.id}`;
      input.setRangeText(fallbackText, token.start, token.end, "end");
      this._hidePopup();
      Promise.resolve(resolveComposerCommandSelection(item, { runtimeSend: RUNTIME_SEND }))
        .then((selection) => {
          if (!selection) return;
          const finalText = selection.text !== fallbackText ? selection.text : fallbackText;
          if (selection.text !== fallbackText) {
            input.setRangeText(selection.text, token.start, token.start + fallbackText.length, "end");
          }
          // Record the resolved-reference boundary so a SECOND /command typed
          // right after it opens its picker (CAP-FB-20260831-MULTI-SLASH-
          // COMMANDS-01): the composer tracks the spans the parser gates on.
          this._recordResolvedSpan(token.start, token.start + finalText.length, finalText);
          if (selection.attachment) this._attachMedia(selection.attachment);
          if (selection.notice) this.setStatus(selection.notice, false);
          this._autoGrow();
        })
        .catch((error) => this.setStatus(`couldn't attach ${item.kind}: ${error?.message ?? error}`, false));
      // NOTE: /agent items never reach this path — /agent opens the shared
      // <agent-picker>, whose agent-select handler inserts the canonical ref.
      this._emit("command", { namespace: item.ns, item });
      input.focus();
      return;
    }

    // Mention completion inserts human-readable text. When the row is an agent,
    // it ALSO selects the same canonical routing chip as /agent and the + menu;
    // send() therefore routes named/background/site mentions by ref, never by
    // the potentially duplicated display name. Skills/assets stay text-only.
    input.setRangeText(item.id, token.start, token.end, "end");
    this._hidePopup();
    if (item.ref) {
      this._setSelectedAgent({
        ref: item.ref,
        kind: item.kind,
        id: item.agentId,
        name: item.label,
      });
    }
    this._emit("mention", { item, agent: this._selectedAgent ? { ...this._selectedAgent } : null });
    input.focus();
  }

  /** Record a resolved command reference's span so a second /command typed
   * immediately after it opens its picker (CAP-FB-20260831-MULTI-SLASH-
   * COMMANDS-01). `text` is the inserted reference; the span is validated
   * against the live input on every parse and dropped when it no longer
   * matches (e.g. after edits before it). */
  _recordResolvedSpan(start, end, text) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || typeof text !== "string" || !text) return;
    (this._resolvedSpans ??= []).push({ start, end, text });
  }

  _hidePopup() {
    if (this._popup) {
      if (typeof this._popup.hidePopover === "function") {
        try { this._popup.hidePopover(); } catch { /* already closed */ }
      }
      this._popup.hidden = true;
      if (this._popup.style) this._popup.style.maxHeight = "";
      // Hidden means EMPTY: no-match, Escape, selection and parser-reset paths
      // all converge here, so stale role=option nodes cannot survive in the DOM
      // or Accessibility tree after a prior result set.
      this._popup.replaceChildren();
    }
    // Combobox contract: closed popup ⇒ expanded false, no active descendant.
    this._input?.setAttribute("aria-expanded", "false");
    this._input?.setAttribute("aria-controls", `popup-${this._uid}`);
    this._input?.removeAttribute("aria-activedescendant");
    this._popupItems = [];
    this._popupActive = -1;
    this._popupToken = null;
  }

  _addChip(detail) {
    if (!this._chips) return;
    const name = detail?.name || "attachment";
    const chip = document.createElement("span");
    chip.className = "chip";
    const label = document.createElement("span");
    label.textContent = name;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove ${name}`);
    rm.textContent = "✕";
    rm.addEventListener("click", () => {
      const idx = this.attachments.indexOf(detail);
      if (idx >= 0) this.attachments.splice(idx, 1);
      chip.remove();
    });
    chip.append(label, rm);
    this._chips.append(chip);
  }

  _clearChips() {
    if (this._chips) this._chips.replaceChildren();
  }

  async _send() {
    const text = this._input?.value.trim();
    if (!text) return;
    if (!this._sentHistory) this._sentHistory = [];
    this._sentHistory.push(text);
    if (this._sentHistory.length > 30) this._sentHistory.shift();
    this._historyIndex = -1;
    this._historyDraft = "";
    // A selected agent is revalidated against the LIVE registry before the run:
    // a stale/deleted (or freshly-disabled) selection is REJECTED — the text
    // stays put, the chip clears, and nothing is routed to a ghost agent.
    if (this._selectedAgent) {
      const stillValid = await this.revalidateSelectedAgent();
      if (!stillValid) return;
    }
    // Accepted send ⇒ the mic must STOP (owner bug: sent a task while
    // dictating, recognition kept listening in the background). Composer-level
    // rejections (empty text, stale agent above) keep BOTH the draft and the
    // recording; only the accepted path tears the mic down.
    (this._mic ?? this.querySelector("mic-button"))?.stop?.();
    if (this._input) { this._input.value = ""; this._autoGrow(); }
    if (this._run) {
      this._run.disabled = true;
      this._run.classList.remove("has-input");
    }
    this._resolvedSpans = []; // the input is cleared — the recorded boundaries are gone
    const pending = this.attachments.splice(0);
    this._clearChips();
    const agent = this._selectedAgent ? { ...this._selectedAgent } : null;
    this._selectedAgent = null;
    this._agentChip = null;
    this._resetHarnessCommands();
    this._emit("send", { text, attachments: pending, agent });
  }

  disconnectedCallback() {
    this._harnessRequest = (this._harnessRequest || 0) + 1;
    // No leak while the slash picker is open: the MutationObserver and the
    // document-level pointerdown listener must die with the element (the base
    // class clears _docListeners only — this element's picker mirror is tracked
    // separately).
    this._teardownPicker();
    this._closeTabPicker();
    super.disconnectedCallback?.();
  }
}
customElements.define("agent-composer", AgentComposer);


export class ConversationRunStatus extends Component {
  static get observedAttributes() {
    return ["state", "activity", "message", "error-reason", "error-category", "action-label", "action-kind", "execution-id"];
  }
  _render() {
    const status = normalizeConversationRunStatus({
      state: this.getAttribute("state"),
      activity: this.getAttribute("activity"),
      message: this.getAttribute("message"),
      errorReason: this.getAttribute("error-reason"),
      errorCategory: this.getAttribute("error-category"),
    });
    if (!status) {
      mountTemplate(this, ":host { display:none; }", "");
      return;
    }
    const actionLabel = this.getAttribute("action-label")?.trim() || "";
    const executionId = this.getAttribute("execution-id")?.trim() || "";
    // The loader is the shared <loading-state> (label-less: this row's own
    // .label is the announced text; the elapsed seconds tick while active).
    this._startedAt = status.active ? (this._startedAt ?? Date.now()) : null;
    const elapsed = this._startedAt ? Math.floor((Date.now() - this._startedAt) / 1000) : 0;
    mountTemplate(this, `
      :host { display:block; min-width:0; }
      .surface { display:flex; align-items:center; gap:12px; min-height:44px; padding:8px 12px; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-md,12px); background:var(--panel,#fff); color:var(--text,#1d1b18); }
      loading-state { flex:0 0 auto; color:var(--muted,#635e56); }
      .surface[data-tone="accent"] loading-state { color:var(--accent,#0e6e63); }
      .surface[data-tone="success"] loading-state { color:var(--success,#1a7f37); }
      .surface[data-tone="danger"] loading-state { color:var(--danger,#b3261e); }
      .label { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; font-size:13px; line-height:1.4; }
      .action, .stop { flex:0 0 auto; min-height:36px; padding:6px 10px; border-radius:var(--radius-sm,8px); background:transparent; font:inherit; font-size:12px; font-weight:650; cursor:pointer; }
      .action { border:1px solid var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      .action:hover { background:var(--accent,#0e6e63); color:var(--on-accent,#fff); }
      .stop { border:1px solid var(--danger,#b3261e); color:var(--danger,#b3261e); }
      .stop:hover { background:var(--danger,#b3261e); color:var(--on-accent,#fff); }
      .action:focus-visible, .stop:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @media (max-width:480px) { .surface { align-items:flex-start; flex-wrap:wrap; } .action, .stop { margin-inline-start:30px; } }
    `, `<div class="surface" data-state="${status.state}" data-tone="${status.tone}" data-active="${status.active}" role="status" aria-live="polite" aria-atomic="true">
      <loading-state label=""${status.active ? " active" : ""}${elapsed > 0 ? ` elapsed="${elapsed}"` : ""} aria-hidden="true"></loading-state>
      <span class="label">${escapeHtml(status.label)}</span>
      ${status.stoppable && executionId ? `<button class="stop" type="button">Stop</button>` : ""}
      ${actionLabel ? `<button class="action" type="button">${escapeHtml(actionLabel)}</button>` : ""}
    </div>`);
  }
  _wire() {
    const executionId = this.getAttribute("execution-id")?.trim() || "";
    this._root.querySelector(".stop")?.addEventListener("click", (sourceEvent) =>
      this._emit("stop", { sourceEvent, executionId }));
    this._root.querySelector(".action")?.addEventListener("click", () =>
      this._emit("action", { kind: this.getAttribute("action-kind") || "settings", executionId }));
    // The elapsed readout ticks once a second while the run is active — it
    // updates the loader's attribute only (no re-render of the live region,
    // so the announcement is never repeated).
    clearInterval(this._tick);
    this._tick = null;
    if (this._startedAt) {
      this._tick = setInterval(() => {
        const loader = this._root.querySelector("loading-state");
        if (!loader || !this._startedAt || !this.isConnected) { clearInterval(this._tick); this._tick = null; return; }
        loader.setAttribute("elapsed", String(Math.floor((Date.now() - this._startedAt) / 1000)));
      }, 1000);
    }
  }
  disconnectedCallback() {
    clearInterval(this._tick);
    this._tick = null;
    this._startedAt = null;
    super.disconnectedCallback();
  }
}
customElements.define("conversation-run-status", ConversationRunStatus);

const ICON_STEP_ACTIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" class="spin"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
const ICON_STEP_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_STEP_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
const ICON_STEP_SKIPPED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
const ICON_PLAN_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

export class PlanStrip extends Component {
  static get observedAttributes() { return ["steps", "state"]; }
  _render() {
    const steps = parseJSONAttr(this.getAttribute("steps"), [])
      .filter((s) => s && typeof s === "object")
      .map((s) => ({
        label: typeof s.label === "string" ? s.label : "",
        status: isPlanStepStatus(s.status) ? s.status : "active",
      }));
    if (!steps.length) { mountTemplate(this, ":host{display:none;}", ""); return; }
    const settled = this.getAttribute("state") === "settled";
    const sum = planSummary({ steps, state: settled ? "settled" : "running" });
    const isPlanSkipped = settled && (sum.allSkipped || (steps.length === 1 && steps[0].status === "skipped"));
    // The summary line: while running, the step in flight; once settled, the
    // count (with an honest note when a step failed, or Skipped when skipped).
    const summaryText = settled
      ? (isPlanSkipped ? "Skipped" : `${sum.total} ${sum.total === 1 ? "step" : "steps"}${sum.errored ? " · 1 or more failed" : ""}`)
      : sum.activeLabel
        ? `Step ${sum.current} of ${sum.total} · ${sum.activeLabel}`
        : `Step ${sum.current} of ${sum.total}`;
    // aria-live text: the active step (running) or the outcome (settled).
    const liveText = settled
      ? (isPlanSkipped ? "Plan skipped" : `Plan complete — ${sum.total} ${sum.total === 1 ? "step" : "steps"}${sum.errored ? ", with an error" : ""}`)
      : sum.activeLabel ? `Now: ${sum.activeLabel}` : "";
    const rows = steps.map((s) => {
      const icon = s.status === "done" ? ICON_STEP_DONE
        : s.status === "error" ? ICON_STEP_ERROR
        : s.status === "skipped" ? ICON_STEP_SKIPPED
        : ICON_STEP_ACTIVE;
      return `<li data-status="${s.status}"><span class="ic" aria-hidden="true">${icon}</span><span class="tx">${escapeHtml(s.label)}</span></li>`;
    }).join("");
    mountTemplate(this, `
      :host { display:block; position:sticky; top:0; z-index:4; margin:0 0 12px; min-width:0; }
      :host([hidden]) { display:none; }
      .plan { border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-md,12px); background:var(--panel,#fff); color:var(--text,#1d1b18); overflow:clip; }
      details > summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:10px; min-height:44px; padding:10px 12px; font-size:13px; font-weight:650; color:var(--text,#1d1b18); }
      summary::-webkit-details-marker { display:none; }
      summary:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:-2px; border-radius:var(--radius-md,12px); }
      .lead { flex:0 0 auto; width:16px; height:16px; display:inline-flex; color:var(--accent,#0e6e63); }
      .lead.done { color:var(--success,#1a7f37); }
      .lead.err { color:var(--danger,#b3261e); }
      .lead.skipped { color:var(--muted,#635e56); }
      .sumtx { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .chev { flex:0 0 auto; width:16px; height:16px; display:inline-flex; color:var(--muted,#635e56); transition:transform .18s ease; }
      details[open] .chev { transform:rotate(180deg); }
      ol { margin:0; padding:2px 12px 12px; list-style:none; display:flex; flex-direction:column; gap:8px; }
      li { display:flex; align-items:center; gap:9px; font-size:12px; line-height:1.4; color:var(--muted,#635e56); min-width:0; }
      li[data-status="active"] { color:var(--text,#1d1b18); font-weight:600; }
      li[data-status="error"] { color:var(--danger,#b3261e); }
      li[data-status="skipped"] { color:var(--muted,#635e56); }
      li .ic { flex:0 0 auto; width:15px; height:15px; display:inline-flex; }
      li[data-status="done"] .ic { color:var(--success,#1a7f37); }
      li[data-status="active"] .ic { color:var(--accent,#0e6e63); }
      li[data-status="error"] .ic { color:var(--danger,#b3261e); }
      li[data-status="skipped"] .ic { color:var(--muted,#635e56); }
      li .tx { min-width:0; overflow-wrap:anywhere; }
      .lead svg, .chev svg, li .ic svg { width:100%; height:100%; display:block; }
      .spin { transform-origin:center; animation:plan-spin .9s linear infinite; }
      @media (prefers-reduced-motion: reduce) { .spin { animation:none; } .chev { transition:none; } }
      @keyframes plan-spin { to { transform:rotate(360deg); } }
      .sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
    `, `<div class="plan">
      <details${!settled && steps.length > 1 ? " open" : ""}>
        <summary>
          <span class="lead${settled && !sum.errored && !isPlanSkipped ? " done" : ""}${settled && sum.errored ? " err" : ""}${isPlanSkipped ? " skipped" : ""}" aria-hidden="true">${settled ? (sum.errored ? ICON_STEP_ERROR : (isPlanSkipped ? ICON_STEP_SKIPPED : ICON_PLAN_DONE)) : ICON_STEP_ACTIVE}</span>
          <span class="sumtx">${escapeHtml(summaryText)}</span>
          <span class="chev" aria-hidden="true">${ICON_CHEVRON}</span>
        </summary>
        <ol aria-label="Run steps">${rows}</ol>
      </details>
      <span class="sr" role="status" aria-live="polite">${escapeHtml(liveText)}</span>
    </div>`);
  }
}
customElements.define("plan-strip", PlanStrip);


export function approvalLine(text) {
  const t = String(text ?? "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

class PermissionApprovalCard extends Component {
  static get observedAttributes() {
    return ["reason", "permissions", "origins", "host-origins", "global", "state", "detail", "tool"];
  }
  _jsonList(name) {
    const raw = this.getAttribute(name);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 50) : [];
    } catch { return []; }
  }
  _render() {
    const tool = (this.getAttribute("tool") ?? "").trim();
    const reason = (this.getAttribute("reason") ?? "perform this action").slice(0, 240);
    const actionLabel = tool ? humanToolLabel(tool).toLowerCase() : (reason || "this action");
    const permissions = this._jsonList("permissions");
    const origins = this._jsonList("origins");
    const hostOrigins = this._jsonList("host-origins");
    const isGlobal = this.getAttribute("global") === "true";
    const state = ["granted", "denied", "expired", "error"].includes(this.getAttribute("state")) ? this.getAttribute("state") : "pending";
    const detail = (this.getAttribute("detail") ?? "").slice(0, 240);

    if (state === "denied") {
      mountTemplate(this, `
        :host { display:block; margin:0 0 10px; }
        .skipped-line { margin:0; font-size:12.5px; color:var(--muted,#635e56); font-style:normal; line-height:1.45; }
      `, `<p class="skipped-line" role="status"${tool ? ` data-raw-tool="${escapeHtml(tool)}"` : ""}>You skipped ${escapeHtml(actionLabel)}.</p>`);
      return;
    }

    // ONE card lists EVERYTHING the click allows, each in the owner's words
    // (what the agent will be able to do — never a Chrome permission token):
    // "See your open tabs", "Group tabs", "Control the browser on this site".
    // Chrome batches the permissions + site access of one request into ONE
    // native prompt, and the card says so once (ONE-CARD-PER-STEP-01).
    const needs = [];
    for (const permission of permissions) {
      needs.push(`<li>${escapeHtml(approvalLine(permissionUserLanguage(permission)))}</li>`);
    }
    const sites = (list) => list.slice(0, 6).map((origin) => `<code>${escapeHtml(siteLabel(origin))}</code>`).join(", ") + (list.length > 6 ? ` and ${list.length - 6} more` : "");
    if (hostOrigins.length) {
      // Chrome site access — part of the same native prompt on Allow.
      needs.push(`<li>Access ${hostOrigins.length === 1 ? "this site" : "these sites"}: ${sites(hostOrigins)}</li>`);
    }
    if (isGlobal) {
      needs.push(`<li>Control the browser on <strong>all sites</strong> (one of the tabs has no single site)</li>`);
    } else if (origins.length) {
      needs.push(`<li>Control the browser on ${origins.length === 1 ? "this site" : "these sites"}: ${sites(origins)}</li>`);
    }
    const chromeNote = state === "pending" && (permissions.length || hostOrigins.length)
      ? "Chrome will ask you to confirm in one prompt."
      : "";
    const stateText = state === "granted"
      ? (detail || "Approved — continuing…")
      : state === "expired"
        ? (detail || "The request expired. The action was not performed.")
      : state === "error"
        ? (detail || "The approval could not be completed — try again.")
        : "";
    const headerTitle = tool ? humanToolLabel(tool) : "Permission request";
    mountTemplate(this, `
      :host { display:flex; margin:0 0 14px; justify-content:flex-start; }
      .card { max-width:88%; border-radius:12px; padding:12px 14px; background:var(--panel,#fff); border:1px solid var(--accent,#0e6e63); }
      .title { font-size:13px; font-weight:700; color:var(--ink,#1d1b18); margin:0 0 4px; font-family:inherit; }
      .reason { font-size:13.5px; color:var(--ink,#1d1b18); margin:0 0 6px; line-height:1.45; }
      .needs-title { margin:0 0 2px; font-size:12.5px; font-weight:600; color:var(--muted,#635e56); }
      .needs { margin:0 0 8px; padding-left:18px; font-size:12.5px; color:var(--ink,#1d1b18); line-height:1.5; }
      .note { margin:0 0 10px; font-size:12px; color:var(--muted,#635e56); }
      .needs code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:0.92em; background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9); border-radius:4px; padding:0 4px; }
      .controls { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .btn { font:inherit; font-size:12.5px; font-weight:650; border-radius:8px; padding:6px 14px; cursor:pointer; min-height:34px; }
      .allow { background:var(--accent,#0e6e63); color:var(--on-accent,#fff); border:1px solid var(--accent,#0e6e63); }
      .allow:hover { filter:brightness(1.06); }
      .deny { background:transparent; color:var(--muted,#635e56); border:1px solid var(--border,#e3e0d9); }
      .deny:hover { color:var(--ink,#1d1b18); border-color:var(--muted,#635e56); }
      .btn:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
      .state { font-size:12.5px; font-weight:600; }
      .state.granted { color:var(--success,#1a7f37); }
      .state.denied { color:var(--muted,#635e56); }
      .state.error, .state.expired { color:var(--danger,#b3261e); }
      .source-label { display:block; font-size:12px; font-weight:600; color:var(--muted,#635e56); margin:0 0 4px; }
      .source { margin:0 0 10px; max-height:220px; overflow:auto; padding:8px 10px; border:1px solid var(--border,#e3e0d9); border-radius:8px; background:var(--panel-2,#f6f4f0); font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--ink,#1d1b18); white-space:pre-wrap; overflow-wrap:anywhere; }
      .source:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .hosts { margin:0 0 12px; padding:0; list-style:none; font-size:12.5px; color:var(--ink,#1d1b18); }
      .hosts li { overflow-wrap:anywhere; }
      .hosts .none { color:var(--muted,#635e56); }
      .dynamic { margin:0 0 12px; font-size:12.5px; font-weight:600; color:var(--danger,#b3261e); }
      :host([state="granted"]) .card { border-color:var(--border,#e3e0d9); opacity:.85; }
      :host([state="expired"]) .card { border-color:var(--border,#e3e0d9); }
    `, `<div class="card" role="group" aria-label="${escapeHtml(headerTitle)}"${tool ? ` data-raw-tool="${escapeHtml(tool)}"` : ""}>
      <p class="title"${tool ? ` data-raw-tool="${escapeHtml(tool)}"` : ""}>${escapeHtml(headerTitle)}</p>
      <p class="reason">The agent wants to ${escapeHtml(reason)}.</p>
      ${needs.length ? `<p class="needs-title">Allowing this lets the agent:</p><ul class="needs">${needs.join("")}</ul>` : ""}
      ${chromeNote ? `<p class="note">${escapeHtml(chromeNote)}</p>` : ""}
      ${state === "pending"
        ? `<div class="controls"><button type="button" class="btn allow">Allow</button><button type="button" class="btn deny">Not now</button></div>`
        : state === "expired"
          ? `<div class="controls"><button type="button" class="btn allow retry-expired">Allow &amp; retry</button><span class="state expired">${escapeHtml(stateText)}</span></div>`
          : `<p class="state ${state}">${escapeHtml(stateText)}</p>`}
    </div>`);
  }
  _wire() {
    this._root.querySelector(".allow")?.addEventListener("click", (event) => {
      this._emit("approve", { decision: "allow", sourceEvent: event });
      this._emit("approval-decision", { decision: "allow", sourceEvent: event });
    });
    this._root.querySelector(".deny")?.addEventListener("click", (event) => {
      this._emit("deny", { decision: "deny", sourceEvent: event });
      this._emit("approval-decision", { decision: "deny", sourceEvent: event });
    });
  }
}
customElements.define("permission-approval-card", PermissionApprovalCard);


export class ToolReceipt extends Component {
  static get observedAttributes() {
    return ["tool", "status", "args", "result", "detail", "skipped"];
  }
  _render() {
    const tool = (this.getAttribute("tool") || "").trim();
    const status = this.getAttribute("status") || "done";
    const skipped = this.getAttribute("skipped") === "true" || this.hasAttribute("skipped");
    const rawResult = this.getAttribute("result") || "";
    const detail = this.getAttribute("detail") || "";
    const label = humanToolLabel(tool);

    if (skipped || isToolResultDeclined(rawResult) || isToolResultDeclined(detail)) {
      mountTemplate(this, `
        :host { display:block; margin:2px 0; }
        .skipped-line { font-size:13px; color:var(--muted,#635e56); font-style:normal; line-height:1.4; padding:2px 0; margin:0; }
      `, `<p class="skipped-line" role="status"${tool ? ` data-raw-tool="${escapeHtml(tool)}"` : ""}>You skipped ${escapeHtml(label.toLowerCase())}.</p>`);
      return;
    }

    const cleanResult = stripModelAddressedText(rawResult);
    mountTemplate(this, `
      :host { display:block; margin:6px 0; }
      .receipt { font-family:inherit; border:1px solid var(--border,#e3e0d9); border-radius:8px; padding:8px 12px; background:var(--panel,#ffffff); }
      .header { display:flex; align-items:center; justify-content:space-between; font-size:12.5px; font-weight:600; }
      .title { font-family:inherit; }
      .raw { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:var(--text-xs, 12px); color:var(--muted,#635e56); margin-top:4px; }
      .result { font-size:12px; color:var(--muted,#635e56); margin-top:4px; white-space:pre-wrap; }
    `, `<div class="receipt"${tool ? ` data-raw-tool="${escapeHtml(tool)}"` : ""}>
      <div class="header">
        <span class="title">${escapeHtml(label)}</span>
        <span class="status ${escapeHtml(status)}">${escapeHtml(status)}</span>
      </div>
      <details>
        <summary class="raw">${escapeHtml(tool || "tool")}</summary>
        ${cleanResult ? `<div class="result">${escapeHtml(cleanResult)}</div>` : ""}
      </details>
    </div>`);
  }
}
customElements.define("tool-receipt", ToolReceipt);


export class ThinkingTrace extends Component {
  static get observedAttributes() { return ["label", "open", "steps"]; }
  _render() {
    const label = this.getAttribute("label") || "reasoning";
    const open = this.hasAttribute("open");
    const steps = parseJSONAttr(this.getAttribute("steps"), []);
    let body;
    if (Array.isArray(steps) && steps.length) {
      body = `<ol class="steps">${steps.map((s) => {
        const l = typeof s === "object" ? (s.label ?? s.text ?? "") : String(s ?? "");
        const t = typeof s === "object" ? (s.text ?? "") : "";
        return `<li><span class="s-label">${escapeHtml(l)}</span>${t ? `<span class="s-text">${escapeHtml(t)}</span>` : ""}</li>`;
      }).join("")}</ol>`;
    } else {
      body = `<div class="trace"><slot></slot></div>`;
    }
    mountTemplate(this, `
      :host { display:block; width:100%; }
      details { width:100%; }
      summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:8px; color:var(--muted,#635e56); font-size:13px; padding:2px 0; user-select:none; }
      summary::-webkit-details-marker { display:none; }
      summary:hover { color:var(--ink,#1d1b18); }
      .caret { transition:transform .15s ease; flex:0 0 auto; display:inline-flex; }
      details[open] .caret { transform:rotate(90deg); }
      .steps { list-style:none; margin:8px 0 0; padding:8px 12px; border-left:2px solid var(--border,#e3e0d9); display:flex; flex-direction:column; gap:6px; }
      .steps li { display:flex; flex-direction:column; gap:2px; }
      .s-label { font-size:12.5px; font-weight:600; color:var(--ink,#1d1b18); }
      .s-text { font-size:12.5px; color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; }
      .trace { margin-top:8px; padding:8px 12px; border-left:2px solid var(--border,#e3e0d9); color:var(--muted,#635e56); font-size:12.5px; white-space:pre-wrap; overflow-wrap:anywhere; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; line-height:1.5; }
      @media (prefers-reduced-motion: reduce) { .caret { transition:none; } }
    `, `<details${open ? " open" : ""}><summary><span class="caret" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg></span><span>${escapeHtml(label)}</span></summary>${body}</details>`);
  }
  _wire() {
    const d = this._root.querySelector("details");
    d?.addEventListener("toggle", () => this._emit("toggle", { open: d.open }));
  }
}
customElements.define("thinking-trace", ThinkingTrace);


export class ToolChips extends Component {
  static get observedAttributes() { return ["tools"]; }
  _render() {
    const tools = parseJSONAttr(this.getAttribute("tools"), []);
    const chips = (Array.isArray(tools) ? tools : []).map((t, i) => {
      const name = typeof t === "object" ? (t.name ?? "tool") : String(t ?? "tool");
      const status = typeof t === "object" ? (t.status ?? "done") : "done";
      const cls = status === "running" ? "running" : status === "error" ? "error" : "done";
      return `<button type="button" class="chip" data-index="${i}" aria-label="${escapeHtml(name)} — ${escapeHtml(cls)}">
        <span class="dot ${cls}" aria-hidden="true"></span><span class="name">${escapeHtml(name)}</span></button>`;
    }).join("");
    mountTemplate(this, `
      :host { display:flex; flex-wrap:wrap; gap:6px; }
      .chip { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border:1px solid var(--border,#e3e0d9); border-radius:999px; background:var(--panel,#ffffff); font:inherit; font-size:12.5px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:var(--ink,#1d1b18); cursor:pointer; }
      .chip:hover { border-color:var(--accent,#0e6e63); }
      .chip:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .dot { width:6px; height:6px; border-radius:50%; flex:0 0 auto; }
      .dot.done { background:var(--success,#1a7f37); }
      .dot.running { background:var(--muted,#635e56); animation:cap-blink 1.2s ease-in-out infinite; }
      .dot.error { background:var(--danger,#b3261e); }
      @keyframes cap-blink { 0%,100%{opacity:.3;} 50%{opacity:1;} }
      @media (prefers-reduced-motion: reduce) { .dot.running { animation:none; opacity:.7; } }
    `, chips || `<span class="empty">No tool calls.</span>`);
  }
  _wire() {
    this._root.querySelectorAll(".chip").forEach((c) =>
      c.addEventListener("click", () => this._emit("select", { index: Number(c.dataset.index) }))
    );
  }
}
customElements.define("tool-chips", ToolChips);


export class TaskRow extends Component {
  static get observedAttributes() { return ["name", "status", "time", "active", "retryable", "paused", "pausable", "stoppable", "execution-id"]; }
  _render() {
    const name = this.getAttribute("name") || "Task";
    const status = this.getAttribute("status") || "completed";
    const time = this.getAttribute("time") || "";
    const active = this.hasAttribute("active");
    const retryable = this.hasAttribute("retryable");
    const paused = this.hasAttribute("paused");
    const pausable = this.hasAttribute("pausable");
    const stoppable = this.hasAttribute("stoppable");
    const indicator = paused
      ? `<span class="ind pausedd" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg></span>`
      : status === "running"
      ? `<span class="ind running" aria-hidden="true"><span class="spin"></span></span>`
      : status === "stopped"
        ? `<span class="ind stopped" aria-hidden="true"><svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><rect x="1" y="1" width="8" height="8" rx="1"/></svg></span>`
      : status === "failed"
        ? `<span class="ind failed" aria-hidden="true">${ICONS.close}</span>`
        : `<span class="ind done" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>`;
    mountTemplate(this, `
      :host { display:block; }
      .row { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid transparent; border-radius:10px; }
      /* Nested-interactive fix: the row is a non-interactive wrapper; the
         explicit open button carries activation and is a sibling of
         Retry/Delete, so child buttons never also open the row. */
      .row-open { flex:1; min-width:0; display:flex; align-items:center; gap:10px; border:0; background:transparent; padding:0; font:inherit; color:inherit; text-align:left; cursor:pointer; border-radius:10px; }
      .row-open:hover { background:var(--panel-2,#efede8); }
      .row-open:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      :host([active]) .row { border-color:var(--accent,#0e6e63); background:var(--panel,#ffffff); }
      .ind { width:18px; height:18px; border-radius:999px; display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; }
      .ind.done { color:var(--success,#1a7f37); }
      .ind.pausedd, .ind.stopped { color:var(--muted,#635e56); }
      .ind.failed { color:var(--danger,#b3261e); }
      .ind.running { color:var(--muted,#635e56); }
      .spin { width:12px; height:12px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; animation:cap-spin 1s linear infinite; display:inline-block; }
      .name { flex:1; min-width:0; font-size:14px; color:var(--ink,#1d1b18); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .time { flex:0 0 auto; font-size:12px; color:var(--muted,#635e56); font-variant-numeric:tabular-nums; }
      .retry, .psep, .stop, .del { flex:0 0 auto; border:0; background:transparent; color:var(--muted,#635e56); cursor:pointer; padding:2px 4px; font:inherit; line-height:1; border-radius:6px; }
      .retry, .psep, .stop { font-size:12px; font-weight:650; }
      .retry, .psep { color:var(--accent,#0e6e63); }
      .stop { min-height:32px; padding-inline:8px; border:1px solid var(--danger,#b3261e); color:var(--danger,#b3261e); }
      .del { font-size:15px; }
      .retry:hover, .psep:hover, .del:hover { background:var(--panel-2,#efede8); }
      .stop:hover { background:var(--danger,#b3261e); color:var(--on-accent,#fff); }
      .del:hover { color:var(--danger,#b3261e); }
      .retry:focus-visible, .psep:focus-visible, .stop:focus-visible, .del:focus-visible, .row-open:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @keyframes cap-spin { to { transform:rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spin { animation:none; } }
    `, `<div class="row" aria-current="${active ? "true" : "false"}">
        <button type="button" class="row-open">${indicator}<span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>${time ? `<span class="time">${escapeHtml(time)}</span>` : ""}</button>${stoppable ? `<button type="button" class="stop" aria-label="Stop ${escapeHtml(name)}">Stop</button>` : ""}${pausable ? `<button type="button" class="psep" aria-label="${paused ? "Resume" : "Pause"} ${escapeHtml(name)}">${paused ? "Resume" : "Pause"}</button>` : ""}${retryable ? `<button type="button" class="retry" aria-label="Retry ${escapeHtml(name)}">Retry</button>` : ""}<button type="button" class="del" aria-label="Delete ${escapeHtml(name)}">×</button></div>`);
  }
  _wire() {
    this._root.querySelector(".row-open")?.addEventListener("click", () => this._emit("open"));
    const executionId = this.getAttribute("execution-id")?.trim() || "";
    this._root.querySelector(".stop")?.addEventListener("click", (sourceEvent) =>
      this._emit("stop", { sourceEvent, executionId }));
    this._root.querySelector(".psep")?.addEventListener("click", () => {
      this._emit("toggle-pause");
    });
    this._root.querySelector(".retry")?.addEventListener("click", () => {
      this._emit("retry");
    });
    this._root.querySelector(".del")?.addEventListener("click", () => {
      this._emit("delete");
    });
  }
}
customElements.define("task-row", TaskRow);


export class StreamingText extends Component {
  static get observedAttributes() { return ["content", "sources", "actions", "streaming"]; }
  _render() {
    const content = this.getAttribute("content") ?? "";
    const streaming = this.hasAttribute("streaming");
    const sources = parseJSONAttr(this.getAttribute("sources"), []);
    const actions = parseJSONAttr(this.getAttribute("actions"), []);
    const sourceChips = (Array.isArray(sources) ? sources : []).map((s, i) =>
      `<span class="src" data-index="${i}">${escapeHtml(typeof s === "object" ? (s.label ?? s.url ?? "source") : String(s))}</span>`
    ).join("");
    const actionBtns = (Array.isArray(actions) ? actions : []).map((a, i) =>
      `<button type="button" class="act" data-index="${i}">${escapeHtml(typeof a === "object" ? (a.label ?? a.text ?? "action") : String(a))}</button>`
    ).join("");
    mountTemplate(this, `
      :host { display:block; }
      .body { font-size:14px; line-height:1.55; color:var(--ink,#1d1b18); white-space:pre-wrap; overflow-wrap:anywhere; }
      :host([streaming]) .body::after { content:""; display:inline-block; width:6px; height:14px; margin-left:2px; background:var(--accent,#0e6e63); vertical-align:-2px; animation:cap-caret 1s steps(1) infinite; }
      .srcs { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .src { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); border:1px solid var(--border,#e3e0d9); border-radius:999px; padding:2px 8px; }
      .acts { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .act { border:1px solid var(--border,#e3e0d9); background:var(--panel,#ffffff); color:var(--accent,#0e6e63); border-radius:999px; padding:4px 12px; font:inherit; font-size:12.5px; font-weight:600; cursor:pointer; }
      .act:hover { border-color:var(--accent,#0e6e63); }
      .act:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @keyframes cap-caret { 0%,100%{opacity:1;} 50%{opacity:0;} }
      @media (prefers-reduced-motion: reduce) { :host([streaming]) .body::after { animation:none; opacity:.6; } }
    `, `<div class="body">${renderMarkdown(content)}</div>${sourceChips ? `<div class="srcs">${sourceChips}</div>` : ""}${actionBtns ? `<div class="acts">${actionBtns}</div>` : ""}`);
    // Text appended while streaming is UNTRUSTED model output: it is written
    // as text nodes only (never through the markdown renderer) and survives a
    // re-render. Setting `content` ends the streamed mode.
    if (this._streamText != null && !this.hasAttribute("content")) {
      const body = this._root.querySelector(".body");
      if (body) body.textContent = this._streamText;
    }
  }
  /** Append a streamed delta as a text node (CAP-FB-20260830-TRANSCRIPT-STREAMING-01).
   *  Returns the accumulated streamed text. */
  appendText(delta) {
    const text = typeof delta === "string" ? delta : "";
    if (this._streamText == null) this._streamText = "";
    this._streamText += text;
    if (!this._rendered) { this._rendered = true; this._render(); this._wire(); }
    const body = this._root.querySelector(".body");
    if (body && text) body.appendChild(document.createTextNode(text));
    return this._streamText;
  }
  /** The text streamed so far ("" when nothing has streamed). */
  get streamedText() { return this._streamText ?? ""; }
  _wire() {
    this._root.querySelectorAll(".act").forEach((b) =>
      b.addEventListener("click", () => this._emit("action", { index: Number(b.dataset.index) }))
    );
    this._root.querySelectorAll(".src").forEach((s) =>
      s.addEventListener("click", () => this._emit("source", { index: Number(s.dataset.index) }))
    );
  }
}
customElements.define("streaming-text", StreamingText);


export class ApprovalCard extends Component {
  static get observedAttributes() { return ["title", "body", "approve-label", "deny-label", "state", "detail"]; }
  /** Script approvals (CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01): the exact
   * source the owner is approving + the hosts it fetches. A PROPERTY (never
   * an attribute) rendered with textContent — the source is untrusted text. */
  get detail() { return this._detail ?? null; }
  set detail(value) {
    if (value && typeof value === "object") {
      if (value.kind === "script-registration" && typeof value.digest === "string") {
        this._detail = {
          kind: "script-registration",
          scriptKind: value.scriptKind === "content_script" ? "content_script" : "user_script",
          id: typeof value.id === "string" ? value.id.slice(0, 64) : "",
          digest: value.digest,
          matches: Array.isArray(value.matches) ? value.matches.filter((m) => typeof m === "string") : [],
          jsBytes: typeof value.jsBytes === "number" ? value.jsBytes : 0,
          runAt: typeof value.runAt === "string" ? value.runAt : null,
          world: typeof value.world === "string" ? value.world : null,
        };
      } else if (typeof value.source === "string") {
        this._detail = {
          source: value.source,
          hosts: Array.isArray(value.hosts) ? value.hosts.filter((h) => typeof h === "string") : [],
          dynamic: value.dynamic === true,
          truncated: value.truncated === true,
          totalSourceChars: typeof value.totalSourceChars === "number" ? value.totalSourceChars : value.source.length,
          sourceDigest: typeof value.sourceDigest === "string" ? value.sourceDigest : null,
        };
      } else {
        this._detail = null;
      }
    } else {
      this._detail = null;
    }
    if (this._rendered) { this._render(); this._wire(); }
  }
  _render() {
    const title = this.getAttribute("title") || "Approve this action?";
    const body = this.getAttribute("body") || "";
    const approveLabel = this.getAttribute("approve-label") || "Approve";
    const denyLabel = this.getAttribute("deny-label") || "Deny";
    const state = ["busy", "granted", "denied", "expired", "cancelled", "error"].includes(this.getAttribute("state")) ? this.getAttribute("state") : "pending";
    const detail = (this.getAttribute("detail") || "").slice(0, 240);
    const stateText = state === "busy"
      ? "Saving your decision…"
      : state === "granted"
        ? "Approved. The action resumed."
        : state === "denied"
          ? "Denied. The action was not performed."
          : state === "expired"
            ? (detail || "Expired. The action was not performed.")
            : state === "cancelled"
              ? (detail || "The run was cancelled. The action was not performed.")
              : (detail || "The decision could not be recorded.");
    mountTemplate(this, `
      :host { display:block; margin-block-end:14px; }
      .card { border:1px solid var(--accent,#0e6e63); border-radius:12px; background:var(--panel,#ffffff); padding:14px 16px; max-width:min(680px, 100%); }
      .title { font-size:14px; font-weight:600; color:var(--ink,#1d1b18); margin:0 0 4px; overflow-wrap:anywhere; }
      .body { font-size:13px; color:var(--muted,#635e56); margin:0 0 12px; white-space:pre-wrap; overflow-wrap:anywhere; }
      .source-notice { margin:0 0 8px; font-size:12px; color:var(--muted,#635e56); background:var(--panel-2,#f5f3ef); border:1px solid var(--border,#e3e0d9); border-radius:6px; padding:6px 10px; line-height:1.4; }
      .source-notice strong { color:var(--ink,#1d1b18); }
      /* An optional slotted region (e.g. an <artifact-diff> on an edit
         approval) between the body and the decision buttons. The slot has no
         box unless something is assigned to it. */
      slot[name="extra"] { display:block; margin-block-end:12px; }
      slot[name="extra"]::slotted(*) { display:block; }
      .actions { display:flex; flex-wrap:wrap; gap:8px; }
      .approve { border:0; border-radius:8px; padding:7px 16px; min-height:34px; background:var(--accent,#0e6e63); color:var(--accent-contrast,#fff); cursor:pointer; font:inherit; font-weight:600; }
      .deny, .retry { border:1px solid var(--border,#e3e0d9); border-radius:8px; padding:7px 16px; min-height:34px; background:var(--panel,#ffffff); color:var(--ink,#1d1b18); cursor:pointer; font:inherit; }
      .approve:focus-visible, .deny:focus-visible, .retry:focus-visible, .state:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .state { margin:0; font-size:12.5px; font-weight:600; color:var(--muted,#635e56); }
      .state.granted { color:var(--success,#1a7f37); }
      .state.error, .state.expired, .state.cancelled { color:var(--danger,#b3261e); }
      :host([state="busy"]) .card, :host([state="granted"]) .card, :host([state="denied"]) .card, :host([state="expired"]) .card, :host([state="cancelled"]) .card, :host([state="error"]) .card { border-color:var(--border,#e3e0d9); }
    `, `<div class="card" role="group" aria-label="Approval request">
        <p class="title">${escapeHtml(title)}</p>
        ${body ? `<p class="body">${escapeHtml(body)}</p>` : ""}
        ${this._detail?.kind === "script-registration"
          ? `<dl class="registration-detail" style="display:grid;grid-template-columns:auto 1fr;gap:4px 8px;font-size:12px;margin:8px 0;">
              <dt style="font-weight:600;">Script ID:</dt><dd style="margin:0;"><code>${escapeHtml(this._detail.id)}</code> (${escapeHtml(this._detail.scriptKind)})</dd>
              <dt style="font-weight:600;">SHA-256:</dt><dd style="margin:0;"><code class="digest">${escapeHtml(this._detail.digest)}</code></dd>
              <dt style="font-weight:600;">Size:</dt><dd style="margin:0;">${Number(this._detail.jsBytes).toLocaleString()} bytes</dd>
              ${this._detail.runAt ? `<dt style="font-weight:600;">Run at:</dt><dd style="margin:0;">${escapeHtml(this._detail.runAt)}</dd>` : ""}
              ${this._detail.world ? `<dt style="font-weight:600;">World:</dt><dd style="margin:0;">${escapeHtml(this._detail.world)}</dd>` : ""}
              <dt style="font-weight:600;">Matches:</dt><dd style="margin:0;"><ul style="margin:0;padding-left:16px;">${this._detail.matches.map((m) => `<li><code>${escapeHtml(m)}</code></li>`).join("")}</ul></dd>
            </dl>`
          : this._detail?.source !== undefined
            ? `<span class="source-label" id="source-label">Script source</span>` +
              (this._detail.truncated
                ? `<p class="source-notice" role="note"><strong>Preview:</strong> Showing the first 64 KB (${this._detail.source.length.toLocaleString()} characters) of ${this._detail.totalSourceChars.toLocaleString()} total characters. ${this._detail.sourceDigest ? `Full source SHA-256: <code>${escapeHtml(this._detail.sourceDigest.slice(0, 16))}…</code>. ` : ""}The complete script will run if approved.</p>`
                : "") +
              `<pre class="source" tabindex="0" role="region" aria-labelledby="source-label"></pre><span class="source-label">Sites it fetches</span><ul class="hosts" aria-label="Sites this script fetches">${this._detail.hosts.length ? this._detail.hosts.map((h) => `<li>${escapeHtml(h)}</li>`).join("") : `<li class="none">none — the script makes no fetch to a listed site</li>`}</ul>${this._detail.dynamic ? `<p class="dynamic" role="note">Builds a URL at run time (unknown hosts) — only the sites listed above will be reachable; localhost and private addresses are always refused.</p>` : ""}`
            : ""}
        <slot name="extra"></slot>
        ${state === "pending"
          ? `<div class="actions"><button type="button" class="approve">${escapeHtml(approveLabel)}</button><button type="button" class="deny">${escapeHtml(denyLabel)}</button></div>`
          : state === "error"
            ? `<div class="actions"><p class="state error" role="status" tabindex="-1">${escapeHtml(stateText)}</p><button type="button" class="retry">Try again</button></div>`
            : `<p class="state ${state}" role="status" tabindex="-1">${escapeHtml(stateText)}</p>`}
      </div>`);
  }
  _wire() {
    // The source is untrusted text: textContent, never markup.
    const pre = this._root.querySelector(".source");
    if (pre && this._detail) {
      if (this._detail.truncated) {
        const remaining = this._detail.totalSourceChars - this._detail.source.length;
        pre.textContent = this._detail.source + `\n\n/* … [${remaining.toLocaleString()} characters truncated from preview — full script (${this._detail.totalSourceChars.toLocaleString()} chars) runs on approval] … */`;
      } else {
        pre.textContent = this._detail.source;
      }
    }
    this._root.querySelector(".approve")?.addEventListener("click", (event) => this._emit("approve", { sourceEvent: event }));
    this._root.querySelector(".deny")?.addEventListener("click", (event) => this._emit("deny", { sourceEvent: event }));
    this._root.querySelector(".retry")?.addEventListener("click", () => this._emit("retry"));
  }
  focusApprove() { queueMicrotask(() => this._root.querySelector(".approve")?.focus()); }
  focusRetry() { queueMicrotask(() => this._root.querySelector(".retry")?.focus()); }
  focusStatus() { queueMicrotask(() => this._root.querySelector(".state")?.focus()); }
}
customElements.define("approval-card", ApprovalCard);


export class PromptBar extends Component {
  static get observedAttributes() { return ["placeholder", "model"]; }
  _render() {
    const placeholder = this.getAttribute("placeholder") || "Ask anything, or @mention an agent…";
    const model = this.getAttribute("model") || "demo";
    mountTemplate(this, `
      :host { display:block; }
      .bar { display:flex; align-items:flex-end; gap:8px; border:1px solid var(--border,#e3e0d9); border-radius:14px; background:var(--panel,#ffffff); padding:8px 10px; position:relative; }
      .bar:focus-within { border-color:var(--accent,#0e6e63); }
      textarea { flex:1; border:0; background:transparent; resize:none; font:inherit; font-size:14px; line-height:1.5; color:var(--ink,#1d1b18); padding:6px 2px; field-sizing:content; min-height:24px; max-height:180px; outline:none; anchor-name:--prompt-input-anchor; }
      textarea::placeholder { color:var(--muted,#635e56); }
      .tools { display:flex; align-items:center; gap:4px; flex:0 0 auto; }
      .model { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--border,#e3e0d9); border-radius:999px; padding:4px 12px; font:inherit; font-size:12px; font-weight:600; color:var(--accent,#0e6e63); cursor:pointer; background:var(--panel,#ffffff); anchor-name:--prompt-model-anchor; }
      .model:hover { border-color:var(--accent,#0e6e63); }
      .model:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .pop { display:none; position:absolute; inset:auto; margin:0; box-sizing:border-box; z-index:20; background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:10px; box-shadow:0 12px 32px rgba(0,0,0,.15);
        position-anchor:--prompt-input-anchor; position-area:block-end span-inline-start; position-try-fallbacks:flip-block;
        width:min(440px, anchor-size(width)); min-width:min(220px, calc(100vw - 16px)); max-width:calc(100vw - 16px); max-height:min(260px, calc(100% - 16px)); overflow:auto; padding:6px; }
      .pop.open { display:block; }
      @supports not (position-area: top) {
        .pop { position:fixed; }
      }
      .pop button { display:block; width:100%; text-align:left; background:transparent; border:0; border-radius:7px; padding:7px 10px; font:inherit; font-size:13px; color:var(--ink,#1d1b18); cursor:pointer; }
      .pop button:hover, .pop button[aria-selected="true"] { background:var(--panel-2,#efede8); }
      .pop .head { font-size:12px; font-weight:600; text-transform:none; color:var(--muted,#635e56); padding:4px 10px 6px; }
    `, `<div class="bar">
        <textarea id="pb-input" rows="1" placeholder="${escapeHtml(placeholder)}" aria-label="Prompt"
          aria-description="Type @ to mention any named, background, or Site Agent."></textarea>
        <div class="tools">
          <button type="button" class="model" id="pb-model" aria-haspopup="listbox" aria-expanded="false">${escapeHtml(model)} ▾</button>
          <mic-button label="Dictate" aria-label="Dictate"></mic-button>
          <attach-button label="Attach" aria-label="Attach"></attach-button>
        </div>
        <div class="pop" id="pb-pop" role="listbox" aria-label="Suggestions" popover="manual"></div>
      </div>`);
  }
  _wire() {
    const ta = this._root.querySelector("#pb-input");
    const pop = this._root.querySelector("#pb-pop");
    const modelBtn = this._root.querySelector("#pb-model");
    // Auto-grow the textarea.
    ta?.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; });
    ta?.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && pop?.classList.contains("open")) {
        e.preventDefault();
        pop.classList.remove("open");
        if (typeof pop.hidePopover === "function") {
          try { pop.hidePopover(); } catch { /* already closed */ }
        }
        if (pop.style) pop.style.maxHeight = "";
        modelBtn?.setAttribute("aria-expanded", "false");
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._emit("send", { text: ta.value }); ta.value = ""; ta.style.height = "auto"; }
    });
    pop?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        pop.classList.remove("open");
        if (typeof pop.hidePopover === "function") {
          try { pop.hidePopover(); } catch { /* already closed */ }
        }
        if (pop.style) pop.style.maxHeight = "";
        modelBtn?.setAttribute("aria-expanded", "false");
        ta?.focus();
      }
    });
    // @ sources + / commands: show a small suggestion popup (anchor-positioned,
    // in-bounds). The host wires the real mention/command data; here we surface
    // the events so the extension can populate them.
    ta?.addEventListener("input", () => {
      const v = ta.value;
      const m = v.match(/(?:^|\s)([@/])([\w-]*)$/);
      if (!m) {
        pop.classList.remove("open");
        if (typeof pop.hidePopover === "function") {
          try { pop.hidePopover(); } catch { /* already closed */ }
        }
        if (pop.style) pop.style.maxHeight = "";
        modelBtn.setAttribute("aria-expanded", "false");
        return;
      }
      const trigger = m[1];
      this._emit(trigger === "@" ? "mention" : "command", { query: m[2] });
      pop.classList.add("open");
      if (typeof pop.showPopover === "function") {
        try { pop.showPopover(); } catch { /* already shown */ }
      }
      modelBtn.setAttribute("aria-expanded", "true");
      if (!supportsAnchorPositioning()) {
        // TODO(baseline/anchor-positioning): Remove position:fixed fallback and getBoundingClientRect viewport math.
        const anchor = ta.getBoundingClientRect();
        const viewportH = (typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 800;
        const viewportW = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 1200;
        const spaceBelow = viewportH - anchor.bottom - 12;
        const spaceAbove = anchor.top - 12;
        const openAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
        const availableHeight = openAbove ? spaceAbove : spaceBelow;
        const minW = Math.min(220, Math.max(0, viewportW - 16));
        const popW = Math.min(440, Math.max(minW, Math.floor(anchor.width || 220)));
        const leftVal = Math.max(8, Math.min(anchor.left, Math.max(8, viewportW - popW - 8)));
        pop.style.position = "fixed";
        if (openAbove) {
          pop.style.bottom = `${Math.max(8, viewportH - anchor.top + 6)}px`;
          pop.style.top = "auto";
        } else {
          pop.style.top = `${anchor.bottom + 6}px`;
          pop.style.bottom = "auto";
        }
        pop.style.left = `${leftVal}px`;
        pop.style.right = "auto";
        pop.style.width = `${popW}px`;
        pop.style.maxHeight = `${Math.min(260, Math.max(0, Math.floor(availableHeight)))}px`;
      } else {
        pop.style.position = "";
        pop.style.left = "";
        pop.style.right = "";
        pop.style.top = "";
        pop.style.bottom = "";
        pop.style.width = "";
        pop.style.maxHeight = "";
        pop.style.setProperty("position-anchor", "--prompt-input-anchor");
        pop.style.setProperty("position-area", "block-end span-inline-start");
      }
      pop.innerHTML = `<div class="head">${trigger === "@" ? "Mention an agent" : "Commands"}</div>`;
    });
    modelBtn?.addEventListener("click", () => {
      const open = pop.classList.toggle("open");
      if (open) {
        if (typeof pop.showPopover === "function") {
          try { pop.showPopover(); } catch { /* already shown */ }
        }
        if (!supportsAnchorPositioning()) {
          // TODO(baseline/anchor-positioning): Remove position:fixed fallback and getBoundingClientRect viewport math.
          const anchor = modelBtn.getBoundingClientRect();
          const viewportH = (typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 800;
          const viewportW = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 1200;
          const spaceBelow = viewportH - anchor.bottom - 12;
          const spaceAbove = anchor.top - 12;
          const openAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
          const availableHeight = openAbove ? spaceAbove : spaceBelow;
          const minW = Math.min(180, Math.max(0, viewportW - 16));
          const popW = Math.min(280, Math.max(minW, Math.floor(anchor.width || 180)));
          const leftVal = Math.max(8, Math.min(anchor.left, Math.max(8, viewportW - popW - 8)));
          pop.style.position = "fixed";
          if (openAbove) {
            pop.style.bottom = `${Math.max(8, viewportH - anchor.top + 6)}px`;
            pop.style.top = "auto";
          } else {
            pop.style.top = `${anchor.bottom + 6}px`;
            pop.style.bottom = "auto";
          }
          pop.style.left = `${leftVal}px`;
          pop.style.right = "auto";
          pop.style.width = `${popW}px`;
          pop.style.maxHeight = `${Math.min(260, Math.max(0, Math.floor(availableHeight)))}px`;
        } else {
          pop.style.position = "";
          pop.style.left = "";
          pop.style.right = "";
          pop.style.top = "";
          pop.style.bottom = "";
          pop.style.width = "max-content";
          pop.style.maxHeight = "";
          pop.style.setProperty("position-anchor", "--prompt-model-anchor");
          pop.style.setProperty("position-area", "block-end span-inline-start");
        }
      } else {
        if (typeof pop.hidePopover === "function") {
          try { pop.hidePopover(); } catch { /* already closed */ }
        }
        if (pop.style) pop.style.maxHeight = "";
      }
      modelBtn.setAttribute("aria-expanded", String(open));
      pop.innerHTML = `<div class="head">Model</div>`;
    });
    // Dictation + attachments (composed from the atomic components).
    this._root.querySelector("mic-button")?.addEventListener("transcript", (e) => {
      ta.value = e.detail?.text ?? "";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    });
    this._root.querySelector("attach-button")?.addEventListener("attach", (e) =>
      this._emit("attach", e.detail)
    );
    this._root.querySelector("attach-button")?.addEventListener("attach-media", (e) =>
      this._emit("attach-media", e.detail)
    );
  }
}
customElements.define("prompt-bar", PromptBar);


export class AgentPicker extends Component {
  static get observedAttributes() {
    return ["agents", "selected", "current-agent-id", "exclude-current", "callable-only", "exclude-kinds", "label", "state", "error", "summary", "deletable"];
  }
  constructor() {
    super();
    this._query = "";
    this._groups = null; // null = not loaded yet (auto mode shows loading)
    this._fetchState = "ready"; // ready | loading | error
    this._fetchError = "";
    this._active = -1; // the active option's flat index
    this._flat = []; // the currently-rendered flat option list
    this._countTimer = null;
    this._fetchSeq = 0; // last-request-wins fence (out-of-order responses)
    this._appliedRevision = null; // last APPLIED registry revision (staleness fence)
  }
  get _auto() { return !this.hasAttribute("agents") && !!RUNTIME_SEND; }
  /** LIST presentation (no search row, no combobox/listbox roles). */
  get _summary() { return this.hasAttribute("summary"); }
  /** The kinds whose rows carry a Delete control (null = none). The destructive
   * control exists for the SUMMARY presentation: a row that IS a button may not
   * contain one, so the two are siblings in `.optwrap`. */
  get _deletableKinds() {
    if (!this.hasAttribute("deletable") || !this._summary) return null;
    const raw = (this.getAttribute("deletable") || "").trim();
    return new Set(raw ? raw.split(/\s+/) : ["*"]);
  }
  _canDelete(kind) {
    const kinds = this._deletableKinds;
    return !!kinds && (kinds.has("*") || kinds.has(String(kind ?? "")));
  }
  get _callableOnly() { return this.hasAttribute("callable-only"); }
  get _excludeKinds() {
    return (this.getAttribute("exclude-kinds") ?? "")
      .split(/\s+/)
      .map((k) => k.trim())
      .filter(Boolean);
  }
  get _excludeCurrent() { return this.hasAttribute("exclude-current"); }
  get _currentAgentId() { return this.getAttribute("current-agent-id") || ""; }

  connectedCallback() {
    super.connectedCallback();
    if (this._auto && this._groups == null) this.refresh();
  }

  /** Re-fetch the live registry (auto mode). Safe to call on every open +
   * on the agent-registry-changed broadcast. FENCED twice so a rapid mutation
   * burst can never regress the UI to an older snapshot: (1) only the LATEST
   * request's response is applied (out-of-order completion is discarded),
   * (2) a response whose registry `revision` is OLDER than the last applied
   * one is discarded (a slow stale read never overwrites a fresher one). */
  async refresh() {
    if (!this._auto) { this._renderList(); return; }
    const seq = ++this._fetchSeq;
    // Keep an already-applied snapshot visible during a live refresh; only the
    // first load needs the blocking loading state. This also means a rejected
    // lower-revision response cannot strand a fresher list behind "Loading…".
    if (this._groups == null) this._fetchState = "loading";
    this._renderList();
    try {
      const res = await RUNTIME_SEND("agent.registry").catch(() => null);
      if (!res || res.ok === false || !Array.isArray(res.groups)) {
        throw new Error(res?.error || "registry unavailable");
      }
      const rev = Number(res.revision);
      if (!shouldApplyRegistrySnapshot(seq, this._fetchSeq, rev, this._appliedRevision)) {
        return; // superseded request or stale revision — keep the fresher snapshot
      }
      this._groups = res.groups;
      if (Number.isFinite(rev)) this._appliedRevision = rev;
      this._fetchState = "ready";
      this._fetchError = "";
    } catch (e) {
      if (seq !== this._fetchSeq) return; // superseded while failing — discard
      this._fetchState = "error";
      this._fetchError = String(e?.message ?? e);
    }
    this._renderList();
  }

  /** The attribute/legacy data normalized to the grouped shape. */
  _attrGroups() {
    const raw = parseJSONAttr(this.getAttribute("agents"), []);
    if (!Array.isArray(raw) || !raw.length) return [];
    if (raw[0] && Array.isArray(raw[0].agents)) return raw; // already grouped
    // Legacy flat site-agent shape: [{ origin, tools }].
    return [{
      id: "site",
      label: "Site Agents",
      agents: raw.map((a) => {
        const origin = a.origin || a.id || "";
        const short = String(origin).replace(/^https?:\/\//, "").replace(/\/.*/, "");
        return {
          ref: canonicalRef("site", origin),
          id: origin,
          kind: "site",
          name: `@${short}`,
          summary: `${a.tools?.length ?? a.toolCount ?? 0} tools · Site Agent`,
          status: "enrolled",
          enabled: true,
        };
      }),
    }];
  }

  _visibleGroups() {
    const groups = this._auto ? (this._groups ?? []) : this._attrGroups();
    return filterGroups(groups, this._query, {
      callableOnly: this._callableOnly,
      excludeId: this._excludeCurrent ? this._currentAgentId : null,
      excludeKinds: this._excludeKinds,
    });
  }

  _render() {
    const label = this.getAttribute("label") || "Choose an agent";
    mountTemplate(this, `
      :host { display:block; }
      .picker { display:flex; flex-direction:column; gap:8px; min-width:0; }
      .lbl { font-size:12px; font-weight:600; color:var(--muted,#635e56); }
      .search-row { display:flex; align-items:center; gap:8px; background:var(--bg,#f7f6f3);
        border:1px solid var(--border,#e3e0d9); border-radius:8px; padding:0 10px; }
      .search-row svg { flex:0 0 auto; color:var(--muted,#635e56); }
      .search { flex:1; min-width:0; min-height:44px; background:transparent; border:0; color:var(--text,#1d1b18);
        font:inherit; outline:none; }
      .list { display:flex; flex-direction:column; gap:2px; max-height:320px; overflow-y:auto; }
      .group-h { font-size:12px; font-weight:600; color:var(--muted,#635e56);
        padding:8px 10px 2px; }
      .opt { display:flex; align-items:center; gap:10px; min-height:44px; padding:6px 10px; border-radius:8px;
        border:1px solid transparent; cursor:pointer; text-align:start; background:transparent; font:inherit;
        color:var(--text,#1d1b18); width:100%; }
      /* A summary row that carries its own destructive control: the two are
         SIBLINGS — a button may not contain a button. */
      .optwrap { display:flex; align-items:center; gap:6px; }
      .optwrap > .opt { flex:1 1 auto; width:auto; min-width:0; }
      .opt:hover, .opt[data-active="true"] { background:var(--panel-2,#efede8); }
      .opt[aria-selected="true"] { border-color:var(--accent,#0e6e63); }
      .opt:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .avatar { flex:0 0 auto; width:28px; height:28px; border-radius:50%; overflow:hidden;
        display:inline-flex; align-items:center; justify-content:center;
        border:1px solid var(--accent,#0e6e63); color:var(--accent,#0e6e63); font-weight:700; font-size:13px;
        background:var(--panel,#ffffff); }
      .avatar img { width:100%; height:100%; object-fit:cover; display:block; }
      .who { flex:1; min-width:0; display:flex; flex-direction:column; }
      .name { font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .sub { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      /* The summary presentation keeps the hub's CLAMPED role line: a narrow
         panel truncates a one-line ellipsis far too early, so the role gets two
         lines and the FULL text stays in the DOM (the title reveals it on
         hover) — the same rule capability-row's .desc enforces. */
      .sub.clamped { white-space:normal; display:-webkit-box; -webkit-box-orient:vertical;
        -webkit-line-clamp:2; line-clamp:2; overflow:hidden; overflow-wrap:anywhere; }
      .meta { flex:0 0 auto; display:inline-flex; align-items:center; gap:6px; font-size:var(--text-xs, 12px); color:var(--muted,#635e56); }
      .current-badge { border:1px solid var(--accent,#0e6e63); color:var(--accent,#0e6e63); border-radius:999px;
        padding:1px 8px; font-size:var(--text-xs, 12px); font-weight:700; }
      .sel { color:var(--accent,#0e6e63); display:inline-flex; }
      .status.paired {
        background: var(--success-bg, rgba(27, 135, 63, 0.1));
        color: var(--success, #1b873f);
        border: 1px solid var(--success, #1b873f);
        border-radius: 999px;
        padding: 1px 7px;
        font-weight: 600;
        font-size: var(--text-xs, 12px);
      }
      .unpaired-harnesses { margin: 6px 4px 4px; font-size: 12px; }
      .unpaired-summary {
        cursor: pointer; color: var(--accent, #0e6e63); font-weight: 500;
        padding: 6px 8px; border-radius: 6px; user-select: none;
        list-style: none; display: flex; align-items: center; gap: 6px;
      }
      .unpaired-summary::-webkit-details-marker { display: none; }
      .unpaired-summary::before {
        content: ""; display: inline-block; width: 0; height: 0;
        border-top: 4px solid transparent; border-bottom: 4px solid transparent;
        border-left: 5px solid currentColor; transition: transform 0.15s ease;
      }
      .unpaired-harnesses[open] > .unpaired-summary::before {
        transform: rotate(90deg);
      }
      .unpaired-summary:hover { background: var(--panel-2, #efede8); }
      .unpaired-summary:focus-visible { outline: 2px solid var(--accent, #0e6e63); outline-offset: 1px; }
      .unpaired-list { margin-top: 4px; padding-left: 4px; }
      @media (prefers-reduced-motion: reduce) { .unpaired-summary::before { transition: none; } }
      .state { padding:12px 10px; font-size:12.5px; color:var(--muted,#635e56); display:flex; align-items:center; gap:8px; }
      .state.error { color:var(--danger,#b3261e); }
      .retry { border:1px solid var(--border,#e3e0d9); background:transparent; color:var(--text,#1d1b18);
        border-radius:6px; padding:4px 10px; font:inherit; font-size:12px; cursor:pointer; min-height:32px; }
      .retry:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .rowdel { flex:0 0 auto; border:1px solid var(--border,#e3e0d9); background:transparent;
        color:var(--danger,#b3261e); border-radius:6px; padding:4px 10px; font:inherit; font-size:12px;
        cursor:pointer; min-height:32px; min-width:32px; }
      .rowdel:hover { border-color:var(--danger,#b3261e); }
      .rowdel:focus-visible { outline:2px solid var(--danger,#b3261e); outline-offset:2px; }
      .spin { width:14px; height:14px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%;
        animation: ap-spin 1s linear infinite; }
      @keyframes ap-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
      @media (forced-colors: active) {
        .opt[aria-selected="true"] { outline:2px solid Highlight; }
        .opt:hover, .opt[data-active="true"] { outline:1px solid Highlight; }
      }
      .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
        clip:rect(0 0 0 0); white-space:nowrap; border:0; }
    `, `<div class="picker">${
        this._summary ? "" : `
        <label class="lbl" for="ap-search">${escapeHtml(label)}</label>
        <div class="search-row">${ICONS.search}
          <input id="ap-search" class="search" type="text" role="combobox" aria-expanded="true"
            aria-controls="ap-list" aria-autocomplete="list" autocomplete="off"
            placeholder="Search agents…" value="${escapeHtml(this._query)}">
        </div>`
      }
        <div class="list" id="ap-list"${
          this._summary ? "" : ` role="listbox" aria-label="${escapeHtml(label)}"`
        }></div>
        <div class="sr-only" role="status" aria-live="polite" id="ap-count"></div>
      </div>`);
    this._search = this._root.querySelector(".search");
    this._list = this._root.querySelector(".list");
    this._count = this._root.querySelector("#ap-count");
    this._renderList();
  }

  _state_() {
    const attr = this.getAttribute("state");
    if (attr) return { state: attr, message: this.getAttribute("error") || "" };
    return { state: this._fetchState, message: this._fetchError };
  }

  _renderList() {
    if (!this._list) return;
    const { state, message } = this._state_();
    if (state === "loading") {
      this._flat = [];
      const row = document.createElement("div");
      row.className = "state";
      row.setAttribute("role", "presentation");
      const spin = document.createElement("span");
      spin.className = "spin";
      spin.setAttribute("aria-hidden", "true");
      row.append(spin, document.createTextNode("Loading agents…"));
      this._list.replaceChildren(row);
      this._announce("Loading agents");
      return;
    }
    if (state === "error") {
      this._flat = [];
      const row = document.createElement("div");
      row.className = "state error";
      row.appendChild(document.createTextNode(`Couldn't load the agents — ${String(message || "unknown error")}`));
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => this.refresh());
      row.appendChild(retry);
      this._list.replaceChildren(row);
      this._announce("Couldn't load the agents");
      return;
    }
    const groups = this._visibleGroups();
    const selected = this.getAttribute("selected") || "";
    const currentId = this._currentAgentId;
    this._flat = flattenGroups(groups);
    if (!this._flat.length) {
      const emptyText = this._query
        ? `No agents match “${this._query}”.`
        : "No agents yet.";
      const row = document.createElement("div");
      row.className = "state";
      row.textContent = emptyText;
      this._list.replaceChildren(row);
      this._announce(emptyText);
      return;
    }
    if (this._active >= this._flat.length) this._active = this._flat.length - 1;
    this._list.replaceChildren();
    let idx = 0;
    for (const g of groups) {
      const group = document.createElement("div");
      group.className = "group";
      // A group with NO label is one un-headed list (the hub's panels): there is
      // no heading to point role=group at, so it stays a plain container.
      const groupLabel = String(g.label ?? g.id ?? "");
      if (groupLabel) {
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", groupLabel);
        const gHead = document.createElement("div");
        gHead.className = "group-h";
        gHead.id = `ap-gh-${String(g.id)}`;
        gHead.textContent = groupLabel;
        group.appendChild(gHead);
      }
      const renderAgentOpt = (a, parent) => {
        const ref = a.ref ?? canonicalRef(a.kind, a.id);
        const isSelected = !!selected && ref === selected;
        const isCurrent = !!currentId && String(a.id).toLowerCase() === currentId.toLowerCase();
        const isHarness = a.kind === "acp" || !!harnessMarkKey(a.id);
        const monogram = isHarness
          ? harnessMonogram(a.id, a.name)
          : (String(a.name || a.id || "?").trim()[0] || "?").toUpperCase();
        const skills = Array.isArray(a.skills) && a.skills.length
          ? ` · ${a.skills.slice(0, 3).join(", ")}${a.skills.length > 3 ? "…" : ""}`
          : "";
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "opt";
        opt.dataset.index = String(idx);
        // The row's canonical ref, so a host that re-renders the list can find
        // its successor row after a delete (no positional guessing).
        opt.dataset.ref = String(ref);
        if (isHarness) opt.dataset.harness = String(a.id);
        // Combobox mode is a listbox of options; the summary presentation has no
        // search input to own them, so the rows stay plain buttons (a role=option
        // outside a listbox is the invalid half of the pair).
        if (!this._summary) {
          opt.setAttribute("role", "option");
          opt.id = `ap-opt-${idx}`;
          opt.dataset.active = String(idx === this._active);
          opt.setAttribute("aria-selected", String(isSelected));
        }
        // Avatar (owner-controlled URL → img.src property, never innerHTML).
        const avatar = document.createElement("span");
        avatar.className = "avatar";
        avatar.setAttribute("aria-hidden", "true");
        if (a.avatar) {
          const img = document.createElement("img");
          img.src = String(a.avatar);
          img.alt = "";
          avatar.appendChild(img);
        } else {
          avatar.textContent = monogram;
        }
        opt.appendChild(avatar);
        const who = document.createElement("span");
        who.className = "who";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = String(a.name || a.id);
        const sub = document.createElement("span");
        sub.className = this._summary ? "sub clamped" : "sub";
        const subText = `${String(a.summary || "")}${skills}`;
        sub.textContent = subText;
        if (this._summary && subText) sub.setAttribute("title", subText);
        who.append(name, sub);
        opt.appendChild(who);
        const meta = document.createElement("span");
        meta.className = "meta";
        const isPaired = a.paired === true || (a.status && ["paired", "connected", "ready", "online"].includes(String(a.status).toLowerCase().trim()));
        if (a.status) {
          const status = document.createElement("span");
          status.className = isPaired ? "status paired" : "status";
          status.textContent = String(a.status);
          meta.appendChild(status);
        } else if (isHarness && isPaired) {
          const status = document.createElement("span");
          status.className = "status paired";
          status.textContent = "Paired";
          meta.appendChild(status);
        }
        if (isCurrent) {
          const badge = document.createElement("span");
          badge.className = "current-badge";
          badge.textContent = "Current";
          meta.appendChild(badge);
        }
        if (isSelected && !this._summary) {
          const sel = document.createElement("span");
          sel.className = "sel";
          sel.setAttribute("aria-hidden", "true");
          sel.innerHTML = ICONS.check; // trusted static icon (never owner data)
          meta.appendChild(sel);
        }
        opt.appendChild(meta);
        opt.addEventListener("click", () => this._commit(Number(opt.dataset.index)));
        // The row's destructive action lives NEXT TO the row (a host that
        // summarises agents in place has no detail pane to delete from). It
        // must never read as a selection: the click is stopped here.
        if (this._canDelete(a.kind)) {
          const del = document.createElement("button");
          del.type = "button";
          del.className = "rowdel";
          del.textContent = "Delete";
          del.setAttribute("aria-label", `Delete ${String(a.name || a.id)}`);
          del.addEventListener("click", (e) => {
            e.stopPropagation();
            this._emit("delete", { ref, kind: a.kind, id: a.id, name: a.name || a.id, agent: a });
          });
          const wrap = document.createElement("div");
          wrap.className = "optwrap";
          wrap.append(opt, del);
          parent.appendChild(wrap);
        } else {
          parent.appendChild(opt);
        }
        idx++;
      };

      if (g.id === "acp") {
        const paired = [];
        const unpaired = [];
        for (const a of g.agents) {
          const isPaired = a.paired === true || (a.status && ["paired", "connected", "ready", "online"].includes(String(a.status).toLowerCase().trim()));
          if (isPaired) paired.push(a);
          else unpaired.push(a);
        }
        for (const a of paired) {
          renderAgentOpt(a, group);
        }
        if (unpaired.length > 0) {
          const disc = document.createElement("details");
          disc.className = "unpaired-harnesses";
          if (this._query) disc.open = true;
          const summ = document.createElement("summary");
          summ.className = "unpaired-summary";
          const linkText = document.createElement("span");
          linkText.className = "unpaired-link-text";
          linkText.textContent = "Pair a local CLI agent in Settings \u2192";
          linkText.title = "Open Settings to pair a local agent harness";
          linkText.addEventListener("click", (e) => {
            if (typeof chrome !== "undefined" && chrome.runtime?.openOptionsPage) {
              chrome.runtime.openOptionsPage();
            }
          });
          summ.appendChild(linkText);
          disc.appendChild(summ);

          const list = document.createElement("div");
          list.className = "unpaired-list";
          for (const a of unpaired) {
            renderAgentOpt(a, list);
          }
          disc.appendChild(list);
          group.appendChild(disc);
        }
      } else {
        for (const a of g.agents) {
          renderAgentOpt(a, group);
        }
      }
      this._list.appendChild(group);
    }
    const n = this._flat.length;
    this._announce(`${n} agent${n === 1 ? "" : "s"}`);
  }

  /** Debounced screen-reader result count (typing must not spam the live region). */
  _announce(text) {
    if (!this._count) return;
    clearTimeout(this._countTimer);
    this._countTimer = setTimeout(() => {
      if (this._count) this._count.textContent = text;
    }, 250);
  }

  _setActive(i, { scroll = true } = {}) {
    if (!this._flat.length) return;
    const n = this._flat.length;
    this._active = ((i % n) + n) % n;
    this._list?.querySelectorAll(".opt").forEach((el) => {
      el.dataset.active = String(Number(el.dataset.index) === this._active);
    });
    const opt = this._list?.querySelector(`#ap-opt-${this._active}`);
    if (opt && this._search) this._search.setAttribute("aria-activedescendant", opt.id);
    if (scroll) opt?.scrollIntoView({ block: "nearest" });
  }

  _commit(index) {
    const a = this._flat[index];
    if (!a) return;
    const ref = a.ref ?? canonicalRef(a.kind, a.id);
    this.setAttribute("selected", ref);
    this._emit("agent-select", { ref, kind: a.kind, id: a.id, name: a.name || a.id, agent: a });
    // Legacy compatibility: the old picker emitted select { origin } for sites.
    if (a.kind === "site") this._emit("select", { origin: a.id });
  }

  _wire() {
    this._search?.addEventListener("input", () => {
      this._query = this._search.value;
      this._active = this._flat.length ? 0 : -1;
      this._renderList();
    });
    this._search?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); this._setActive(this._active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); this._setActive(this._active - 1); }
      else if (e.key === "Home") { e.preventDefault(); this._setActive(0); }
      else if (e.key === "End") { e.preventDefault(); this._setActive(this._flat.length - 1); }
      else if (e.key === "Enter" || e.key === "Tab") {
        if (this._active >= 0 && this._flat[this._active]) {
          e.preventDefault();
          this._commit(this._active);
        } else if (e.key === "Enter" && this._flat.length === 1) {
          e.preventDefault();
          this._commit(0);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        this._emit("agent-cancel");
      }
    });
  }

  /** Public: focus the search combobox (the host's open flow). */
  focusSearch() { this._search?.focus(); }
  /** Public: the canonical ref of the current selection ("" when none). */
  get value() { return this.getAttribute("selected") || ""; }

  /** Public: set the filter query EXTERNALLY (the /agent slash command drives
   * the picker from the composer text). The search row mirrors the query; the
   * first option becomes active so Enter/Tab commits immediately. */
  setQuery(q) {
    this._query = String(q ?? "");
    if (this._search) this._search.value = this._query;
    this._active = -1;
    this._renderList();
    if (this._flat.length) this._setActive(0, { scroll: false });
  }

  /** Public: handle a navigation key forwarded by a host that KEEPS focus
   * elsewhere (the /agent slash command forwards the composer keydown). The
   * same contract as the search input's own keydown: ArrowUp/Down/Home/End
   * move the active option, Enter/Tab commit, Escape cancels. Returns true
   * when the key was consumed. */
  navigate(key) {
    if (key === "ArrowDown") { this._setActive(this._active + 1); return true; }
    if (key === "ArrowUp") { this._setActive(this._active - 1); return true; }
    if (key === "Home") { this._setActive(0); return true; }
    if (key === "End") { this._setActive(this._flat.length - 1); return true; }
    if (key === "Enter" || key === "Tab") {
      if (this._active >= 0 && this._flat[this._active]) { this._commit(this._active); return true; }
      if (key === "Enter" && this._flat.length === 1) { this._commit(0); return true; }
      return true; // nothing to commit — still consumed (never a send)
    }
    if (key === "Escape") { this._emit("agent-cancel"); return true; }
    return false;
  }
}
customElements.define("agent-picker", AgentPicker);


