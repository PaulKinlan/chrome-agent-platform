// shared/components.js — the Chrome Agent Platform design system, as native
// Web Components (customElements.define, MV3-CSP-safe: no eval / new Function,
// static templates + event listeners only).
//
// Every component is:
//   - encapsulated in a Shadow DOM with a scoped <style>,
//   - configurable via attributes/properties and reflected attributes,
//   - event-emitting (CustomEvent) so pages stay backend-agnostic,
//   - accessible (labels, focus, ARIA, reduced-motion aware).
//
// The extension pages AND the docs/ showcase both load this file, so the
// visual/behavioral consistency is structural (one component, everywhere).
// docs/ keeps a synced copy (see build.mjs → copy:docs).

const ARIA_HIDDEN = "aria-hidden";
const TRUE = ""; // boolean-attribute present marker

/* ──────────────────────────────────────────────────────────────────────────
 * Icons (inline SVG, currentColor — no emoji, per project guidance)
 * ────────────────────────────────────────────────────────────────────────── */
export const ICONS = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  record: '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
};

/* ──────────────────────────────────────────────────────────────────────────
 * Shared helpers
 * ────────────────────────────────────────────────────────────────────────── */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

export function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ===
      true;
  } catch {
    return false;
  }
}

export function parseJSONAttr(v, fallback) {
  if (v == null || v === "") return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function fire(el, type, detail = {}) {
  el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

// A shared base that renders a Shadow-DOM template + a scoped <style> once.
class Component extends HTMLElement {
  static shadow() {
    return true;
  }
  constructor() {
    super();
    const useShadow = this.constructor.shadow();
    if (useShadow) {
      this._root = this.attachShadow({ mode: "open" });
    } else {
      this._root = this;
    }
  }
  connectedCallback() {
    if (this._rendered) return;
    this._rendered = true;
    this._render();
    this._wire();
  }
  attributeChangedCallback(name, oldValue, newValue) {
    // An attribute change re-renders the shadow DOM, so we must re-wire the
    // fresh elements too (otherwise the old listeners are lost and stateful
    // components like attach-button / mic-button / the dialog stop responding
    // after their first state change).
    if (this._rendered && oldValue !== newValue) {
      this._render();
      this._wire();
    }
  }
  // Bind a document-level listener exactly once (survives re-render).
  _bindDocument(type, handler) {
    if (!this._docListeners) this._docListeners = [];
    if (this._docListeners.some((l) => l.type === type)) return;
    const wrapped = (e) => handler.call(this, e);
    this._docListeners.push({ type, wrapped });
    document.addEventListener(type, wrapped);
  }
  disconnectedCallback() {
    // Remove any once-only document listeners so re-adding the element to the
    // DOM doesn't leak listeners, and allow a clean re-render on reconnect.
    if (this._docListeners) {
      this._docListeners.forEach(({ type, wrapped }) =>
        document.removeEventListener(type, wrapped));
      this._docListeners = [];
    }
    this._rendered = false;
  }
  // subclasses override _render/_wire
  _render() {}
  _wire() {}
  _emit(type, detail) {
    fire(this, type, detail);
  }
}

// Build the shadow content: style + markup. Safe (no eval).
function mountTemplate(host, style, markup) {
  const useShadow = host.constructor.shadow();
  const root = host._root;
  if (useShadow) {
    root.innerHTML = `<style>${style}</style>${markup}`;
  } else {
    // light-DOM mode: inject a single <style> if not already present, then markup.
    const styleId = `sc-${host.localName}-style`;
    if (!document.getElementById(styleId)) {
      const st = document.createElement("style");
      st.id = styleId;
      st.textContent = style;
      document.head.appendChild(st);
    }
    root.innerHTML = markup;
  }
  return root;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Atomic components
 * ────────────────────────────────────────────────────────────────────────── */

/* <run-task-button label="Run task" loading disabled> */
class RunTaskButton extends Component {
  static get observedAttributes() { return ["label", "loading", "disabled"]; }
  _render() {
    const label = this.getAttribute("label") || "Run task";
    const loading = this.hasAttribute("loading");
    const disabled = this.hasAttribute("disabled");
    const html = `<button part="button" class="run" type="button"${
      disabled ? " disabled" : ""}${loading ? " aria-busy=\"true\"" : ""}>${
      loading ? '<span class="spin" aria-hidden="true"></span>' : ""
    }<span>${escapeHtml(label)}</span></button>`;
    mountTemplate(this, `
      :host { display: inline-flex; }
      .run { display:inline-flex; gap:8px; align-items:center; border:0;
        border-radius:8px; padding:9px 16px; font:inherit; font-weight:600;
        cursor:pointer; background:var(--accent, #4f46e5); color:var(--accent-contrast, #fff); }
      .run:disabled { opacity:.55; cursor:not-allowed; }
      .run:focus-visible { outline:2px solid var(--accent, #4f46e5); outline-offset:2px; }
      .spin { width:14px; height:14px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; animation: sc-spin 1s linear infinite; }
      @keyframes sc-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
    `, html);
  }
  _wire() {
    this._root.querySelector(".run")?.addEventListener("click", () => {
      if (this.hasAttribute("disabled") || this.hasAttribute("loading")) return;
      this._emit("run-task");
    });
  }
}
customElements.define("run-task-button", RunTaskButton);

/* <mic-button listening> — self-contained Web Speech toggle + waveform */
class MicButton extends Component {
  static get observedAttributes() { return ["listening", "label"]; }
  constructor() {
    super();
    this._recognition = null;
    this._listening = false;
  }
  _render() {
    const listening = this.hasAttribute("listening");
    const label = this.getAttribute("label") || "Start listening";
    mountTemplate(this, `
      :host { display:inline-flex; }
      .mic { display:inline-flex; align-items:center; justify-content:center; width:var(--control,36px);
        height:var(--control,36px); background:transparent;
        border:1px solid var(--border, #333); color:var(--text, #eee); border-radius:8px;
        padding:0; cursor:pointer; font:inherit; }
      .mic[data-listening] { color:var(--accent, #4f46e5); border-color:var(--accent, #4f46e5); }
      .mic:focus-visible { outline:2px solid var(--accent, #4f46e5); outline-offset:2px; }
      .wave { display:none; align-items:center; gap:2px; height:16px; }
      .mic[data-listening] .icon { display:none; }
      .mic[data-listening] .wave { display:inline-flex; }
      .wave span { width:3px; background:currentColor; border-radius:2px; animation:sc-wave 1s ease-in-out infinite; }
      .wave span:nth-child(1){height:6px;animation-delay:0s}.wave span:nth-child(2){height:12px;animation-delay:.15s}
      .wave span:nth-child(3){height:16px;animation-delay:.3s}.wave span:nth-child(4){height:10px;animation-delay:.45s}
      .wave span:nth-child(5){height:7px;animation-delay:.6s}
      @keyframes sc-wave { 0%,100%{transform:scaleY(.5)} 50%{transform:scaleY(1)} }
      @media (prefers-reduced-motion: reduce) { .wave span { animation:none; } }
    `, `<button part="button" class="mic" type="button" aria-label="${escapeHtml(label)}"
      aria-pressed="${listening}"><span class="icon">${ICONS.mic}</span><span class="wave" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span></button>`);
    this._button = this._root.querySelector(".mic");
  }
  _wire() {
    this._button?.addEventListener("click", () => this.toggle());
  }
  get listening() { return this._listening; }
  toggle() {
    this._listening ? this.stop() : this.start();
  }
  start() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      this._emit("mic-error", { message: "speech recognition not available" });
      return;
    }
    if (!this._recognition) {
      this._recognition = new SR();
      this._recognition.continuous = true;
      this._recognition.interimResults = true;
      this._recognition.lang = "en-US";
      this._recognition.onresult = (e) => {
        let transcript = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          transcript += e.results[i][0].transcript;
        }
        this._emit("transcript", { text: transcript.trim(), final: e.results[e.results.length - 1].isFinal });
      };
      this._recognition.onerror = (e) => {
        if (e.error === "no-speech" || e.error === "aborted") return;
        this._emit("mic-error", { message: e.error });
      };
      this._recognition.onend = () => {
        if (this._listening) {
          try { this._recognition.start(); } catch { /* ignore */ }
          return;
        }
      };
    }
    this._listening = true;
    this.setAttribute("listening", TRUE);
    this._emit("mic-toggle", { listening: true });
    try { this._recognition.start(); } catch { /* already started */ }
  }
  stop() {
    this._listening = false;
    this.removeAttribute("listening");
    this._emit("mic-toggle", { listening: false });
    if (this._recognition) {
      try { this._recognition.stop(); } catch { /* ignore */ }
    }
  }
}
customElements.define("mic-button", MicButton);

/* <attach-button label="Attach"> — the + button + menu (file / audio / camera) */
class AttachButton extends Component {
  static get observedAttributes() { return ["label", "open"]; }
  constructor() { super(); this._fileInput = null; }
  _render() {
    const label = this.getAttribute("label") || "Add attachment";
    const open = this.hasAttribute("open");
    mountTemplate(this, `
      :host { position:relative; display:inline-flex; }
      .plus { display:inline-flex; align-items:center; justify-content:center; width:var(--control,36px);
        height:var(--control,36px); background:transparent;
        border:1px solid var(--border,#333); color:var(--text,#eee); border-radius:8px;
        padding:0; cursor:pointer; font:inherit; }
      .plus:focus-visible { outline:2px solid var(--accent,#4f46e5); outline-offset:2px; }
      .menu { position:absolute; bottom:calc(100% + 6px); left:0; background:var(--panel,#1e1e2e);
        border:1px solid var(--border,#333); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.25);
        padding:4px; min-width:180px; z-index:20; }
      .menu[hidden] { display:none; }
      .menu button { display:block; width:100%; text-align:left; background:transparent; border:0;
        color:var(--text,#eee); padding:8px 10px; border-radius:7px; cursor:pointer; font:inherit; }
      .menu button:hover, .menu button:focus-visible { background:var(--bg,#12121c); outline:none; }
      .note { font-size:11px; color:var(--muted,#888); margin:6px 0 2px; max-width:220px; }
    `, `<button part="button" class="plus" type="button" aria-haspopup="menu"
        aria-expanded="${open}" aria-label="${escapeHtml(label)}">${ICONS.plus}</button>
      <div class="menu" role="menu" aria-label="${escapeHtml(label)}"${open ? "" : " hidden"}>
        <button type="button" role="menuitem" data-kind="file">Add file</button>
        <button type="button" role="menuitem" data-kind="record-audio">Record audio</button>
        <button type="button" role="menuitem" data-kind="capture-camera">Capture camera</button>
        <button type="button" role="menuitem" data-kind="other">Add other file</button>
        <p class="note">Files are attached; text files are read by the agent. Media bytes are not sent to the model yet.</p>
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
      const idx = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        items[(idx + d + items.length) % items.length].focus();
      }
    });
    this._menu?.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-kind]");
      if (!b) return;
      this._toggle(false);
      const kind = b.dataset.kind;
      if (kind === "record-audio" || kind === "capture-camera") {
        this._emit("attach-media", { kind });
        return;
      }
      const file = await this._pickFile(kind);
      if (file) this._emit("attach", { name: file.name, size: file.size, type: file.type, kind, file });
    });
    this._bindDocument("click", (e) => {
      if (this._menu && !this._menu.hidden && !this._menu.contains(e.target) && e.target !== this._btn) {
        this._toggle(false);
      }
    });
  }
  _toggle(open) {
    if (!this._menu) return;
    this._menu.hidden = !open;
    if (open) {
      this.setAttribute("open", TRUE);
      this._menu.querySelector("button[role=menuitem]")?.focus();
    } else {
      this.removeAttribute("open");
    }
  }
  _pickFile(kind) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      if (kind === "audio") input.accept = "audio/*";
      if (kind === "video") input.accept = "video/*";
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.oncancel = () => resolve(null);
      input.click();
      this._fileInput = input;
    });
  }
}
customElements.define("attach-button", AttachButton);

/* <theme-picker theme="sunlit"> — the theme swatches */
export const THEMES = [
  { id: "midnight", label: "Midnight" },
  { id: "sunlit", label: "Sunlit" },
  { id: "neon", label: "Neon" },
  { id: "terminal", label: "Terminal" },
];
class ThemePicker extends Component {
  static get observedAttributes() { return ["theme"]; }
  _render() {
    const current = this.getAttribute("theme") || "sunlit";
    const swatches = THEMES.map((t) =>
      `<button type="button" class="swatch theme-${t.id}" data-theme="${t.id}"
        aria-label="${escapeHtml(t.label)} theme" aria-pressed="${t.id === current}"
        title="${escapeHtml(t.label)}"><span class="label">${escapeHtml(t.label)}</span></button>`
    ).join("");
    mountTemplate(this, `
      :host { display:inline-flex; gap:10px; }
      .swatch { position:relative; width:44px; height:44px; border-radius:10px; border:2px solid transparent; cursor:pointer; }
      .swatch[aria-pressed="true"] { border-color:var(--text,#eee); }
      .swatch:focus-visible { outline:2px solid var(--accent,#4f46e5); outline-offset:2px; }
      .swatch .label { position:absolute; inset:auto 0 2px; font-size:9px; text-align:center; color:inherit; }
      .theme-midnight { background:#12121c; color:#cdd6f4; }
      .theme-sunlit { background:#f4f1e8; color:#2b2b2b; }
      .theme-neon { background:#0a0a14; color:#22d3ee; box-shadow:0 0 10px #22d3ee55; }
      .theme-terminal { background:#0c0c0c; color:#33ff66; }
    `, swatches);
  }
  _wire() {
    this._root.querySelectorAll(".swatch").forEach((s) =>
      s.addEventListener("click", () => this._emit("theme-change", { theme: s.dataset.theme }))
    );
  }
}
customElements.define("theme-picker", ThemePicker);

/* <permission-row capability="tabs" label description granted warned> */
export const PERMISSIONS = [
  { id: "storage", label: "Memory & settings", note: "OPFS memory + settings" },
  { id: "alarms", label: "Scheduled tasks", note: "chrome.alarms" },
  { id: "tabs", label: "Browser control", note: "open/navigate/close tabs (warned)" },
  { id: "activeTab", label: "Screenshots", note: "captureVisibleTab (silent)" },
  { id: "scripting", label: "Site agents", note: "read pages / register scripts" },
  { id: "notifications", label: "Notifications", note: "chrome.notifications" },
  { id: "sidePanel", label: "Side panel", note: "chrome.sidePanel" },
];
class PermissionRow extends Component {
  static get observedAttributes() { return ["capability", "label", "description", "granted", "warned", "disabled"]; }
  _render() {
    const cap = this.getAttribute("capability") || "";
    const label = this.getAttribute("label") || cap;
    const desc = this.getAttribute("description") || "";
    const granted = this.hasAttribute("granted");
    const warned = this.hasAttribute("warned");
    const disabled = this.hasAttribute("disabled");
    mountTemplate(this, `
      :host { display:block; }
      .perm { display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--border,#333); border-radius:10px; background:var(--panel,#1e1e2e); }
      .info { flex:1; min-width:0; }
      .name { font-weight:600; }
      .desc { font-size:12px; color:var(--muted,#888); }
      .state { font-size:11px; text-transform:uppercase; letter-spacing:.03em; color:var(--muted,#888); }
      .state.granted { color:var(--accent2,#34d399); }
      .state.warned { color:var(--warn,#f59e0b); }
      .btn { border:1px solid var(--border,#333); background:transparent; color:var(--text,#eee); border-radius:7px; padding:6px 12px; cursor:pointer; font:inherit; }
      .btn:disabled { opacity:.5; cursor:not-allowed; }
      .btn:focus-visible { outline:2px solid var(--accent,#4f46e5); outline-offset:2px; }
    `, `<div class="perm">
      <div class="info"><div class="name">${escapeHtml(label)}</div><div class="desc">${escapeHtml(desc)}</div></div>
      <span class="state ${granted ? "granted" : ""}${warned ? " warned" : ""}">${granted ? "Granted" : "Not granted"}${warned ? " · warns" : ""}</span>
      <button type="button" class="btn"${disabled ? " disabled" : ""}>${granted ? "Disable" : "Enable"}</button>
    </div>`);
  }
  _wire() {
    this._root.querySelector(".btn")?.addEventListener("click", () => {
      const granted = this.hasAttribute("granted");
      this._emit(granted ? "disable" : "enable", { capability: this.getAttribute("capability") });
    });
  }
}
customElements.define("permission-row", PermissionRow);

/* <site-agent-card origin="https://x" tools="[]"> */
class SiteAgentCard extends Component {
  static get observedAttributes() { return ["origin", "tools", "status"]; }
  _render() {
    const origin = this.getAttribute("origin") || "";
    const tools = parseJSONAttr(this.getAttribute("tools"), []);
    const status = this.getAttribute("status") || "";
    const short = origin.replace(/^https?:\/\//, "").replace(/\/.*/, "");
    mountTemplate(this, `
      :host { display:block; }
      .card { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border,#333); border-radius:10px; background:var(--panel,#1e1e2e); cursor:pointer; }
      .card:hover, .card:focus-visible { border-color:var(--accent,#4f46e5); outline:none; }
      .badge { width:32px; height:32px; border-radius:8px; background:var(--accent,#4f46e5); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-weight:700; }
      .who { flex:1; min-width:0; }
      .name { font-weight:600; }
      .tools { font-size:12px; color:var(--muted,#888); }
      .status { font-size:11px; color:var(--muted,#888); }
    `, `<div class="card" role="button" tabindex="0" aria-label="Use site agent ${escapeHtml(short)}">
      <span class="badge" aria-hidden="true">@</span>
      <span class="who"><span class="name">@${escapeHtml(short)}</span><span class="tools"> · ${tools.length} tools</span></span>
      ${status ? `<span class="status">${escapeHtml(status)}</span>` : ""}
    </div>`);
  }
  _wire() {
    const card = this._root.querySelector(".card");
    card?.addEventListener("click", () => this._emit("select", { origin: this.getAttribute("origin") }));
    card?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._emit("select", { origin: this.getAttribute("origin") }); }
    });
  }
}
customElements.define("site-agent-card", SiteAgentCard);

/* <capability-row name description icon action="run|toggle" enabled last-run>
 * The reusable capability/recipe row. A strict grid — icon (fixed) | label
 * column (name + description STACKED, never run together) | action
 * (right-aligned) — so every capability list is aligned by construction. */
class CapabilityRow extends Component {
  static get observedAttributes() {
    return ["name", "description", "icon", "action", "enabled", "last-run"];
  }
  _render() {
    const name = this.getAttribute("name") || "";
    const description = this.getAttribute("description") || "";
    const icon = this.getAttribute("icon") || "";
    const action = this.getAttribute("action") || "run";
    const enabled = this.hasAttribute("enabled");
    const lastRun = this.getAttribute("last-run") || "";
    const actionHtml = action === "toggle"
      ? `<button part="toggle" class="switch" type="button" role="switch"
          aria-checked="${enabled}" aria-pressed="${enabled}"
          aria-label="${enabled ? "Disable" : "Enable"} ${escapeHtml(name)} in the background"></button>`
      : `<button part="run" class="run" type="button">Run</button>`;
    mountTemplate(this, `
      :host { display:block; }
      .row { display:grid; grid-template-columns:28px 1fr auto; gap:12px; align-items:center;
        padding:12px 14px; border-bottom:1px solid var(--border,#30363d); background:transparent; }
      .row:last-child { border-bottom:0; }
      .icon { display:inline-flex; align-items:center; justify-content:center;
        width:28px; height:28px; color:var(--muted,#8b949e); }
      .icon svg { width:18px; height:18px; display:block; }
      .label { min-width:0; display:flex; flex-direction:column; gap:2px; }
      .name { font-weight:600; font-size:var(--text-sm,13px); color:var(--text,#e6edf3); }
      .desc { font-size:var(--text-xs,12px); color:var(--muted,#8b949e); line-height:1.35; }
      .lastrun { font-size:var(--text-xs,12px); color:var(--muted,#8b949e); }
      .run { justify-self:end; font-size:var(--text-xs,12px); color:var(--muted,#8b949e);
        border:1px solid var(--border,#30363d); border-radius:var(--radius-sm,6px);
        padding:4px 12px; background:transparent; cursor:pointer; font:inherit;
        white-space:nowrap; }
      .run:hover, .run:focus-visible { color:var(--accent,#58a6ff); border-color:var(--accent,#58a6ff); outline:none; }
      .switch { justify-self:end; }
      .meta { display:flex; align-items:center; gap:6px; }
    `, `<div part="row" class="row">
      <span class="icon" aria-hidden="true">${icon}</span>
      <span class="label"><span class="name">${escapeHtml(name)}</span>
        <span class="desc">${escapeHtml(description)}</span>${
          lastRun ? `<span class="lastrun">${escapeHtml(lastRun)}</span>` : ""
        }</span>
      <span class="meta">${actionHtml}</span>
    </div>`);
  }
  _wire() {
    const run = this._root.querySelector(".run");
    run?.addEventListener("click", () => this._emit("run"));
    const toggle = this._root.querySelector(".switch");
    toggle?.addEventListener("click", () => {
      this._emit("toggle", { enabled: !this.hasAttribute("enabled") });
    });
  }
}
customElements.define("capability-row", CapabilityRow);

/* <message-bubble role="user|agent|task|result|error|thinking|tool" label>content</message-bubble> */
class MessageBubble extends Component {
  static get observedAttributes() { return ["role", "label"]; }
  _render() {
    const role = this.getAttribute("role") || "agent";
    const label = this.getAttribute("label") || "";
    const thinking = role === "thinking";
    mountTemplate(this, `
      :host { display:block; }
      .bubble { border-top:1px solid var(--border,#333); padding:10px 0; }
      .bubble:first-child { border-top:0; }
      .label { font-size:12px; color:var(--muted,#888); margin-bottom:4px; font-weight:600; }
      .body { white-space:pre-wrap; overflow-wrap:anywhere; }
      :host([role="error"]) .body { color:var(--danger,#f87171); }
      :host([role="result"]) .body { color:var(--accent2,#34d399); }
      :host([role="user"]) .body { font-weight:500; }
      :host([role="tool"]) .body { color:var(--muted,#888); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
      .think { display:flex; align-items:center; gap:8px; color:var(--muted,#888); }
      .think .spin { width:12px; height:12px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; animation:sc-think 1s linear infinite; }
      @keyframes sc-think { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .think .spin { animation: none; } }
    `, `${label ? `<div class="label">${escapeHtml(label)}</div>` : ""}${
      thinking
        ? `<div class="think" role="status"><span class="spin" aria-hidden="true"></span><div class="body"><slot></slot></div></div>`
        : `<div class="body"><slot></slot></div>`
    }`);
  }
}
customElements.define("message-bubble", MessageBubble);

/* <screenshot-strip shots="[url,label]"> — screenshot history */
class ScreenshotStrip extends Component {
  static get observedAttributes() { return ["shots"]; }
  _render() {
    const shots = parseJSONAttr(this.getAttribute("shots"), []);
    const items = shots.map((s, i) => {
      const src = typeof s === "string" ? s : s?.url;
      const label = typeof s === "object" ? s?.label : "";
      return `<button type="button" class="shot" data-index="${i}" aria-label="Open screenshot ${i + 1}">
        <img src="${escapeHtml(src || "")}" alt="" loading="lazy">
        ${label ? `<span class="lbl">${escapeHtml(label)}</span>` : ""}</button>`;
    }).join("");
    mountTemplate(this, `
      :host { display:block; }
      .strip { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; }
      .shot { position:relative; flex:0 0 auto; width:96px; height:64px; border:1px solid var(--border,#333); border-radius:8px; overflow:hidden; padding:0; cursor:pointer; background:var(--bg,#12121c); }
      .shot img { width:100%; height:100%; object-fit:cover; display:block; }
      .shot:focus-visible { outline:2px solid var(--accent,#4f46e5); outline-offset:2px; }
      .lbl { position:absolute; inset:auto 0 0 0; font-size:9px; background:rgba(0,0,0,.6); color:#fff; padding:1px 3px; }
      .empty { font-size:12px; color:var(--muted,#888); }
    `, shots.length ? `<div class="strip">${items}</div>` : `<span class="empty">No screenshots yet.</span>`);
  }
  _wire() {
    this._root.querySelectorAll(".shot").forEach((s) =>
      s.addEventListener("click", () => this._emit("open", { index: Number(s.dataset.index) }))
    );
  }
}
customElements.define("screenshot-strip", ScreenshotStrip);

/* ──────────────────────────────────────────────────────────────────────────
 * Composite components
 * ────────────────────────────────────────────────────────────────────────── */

/* <agent-composer placeholder label send-label> — mic + attach + input + send.
 * Light DOM (shadow() = false) so the extension's CDP journeys can still
 * target #task-input / #run-task. */
class AgentComposer extends Component {
  static shadow() { return false; }
  static get observedAttributes() { return ["placeholder", "label", "send-label"]; }
  constructor() { super(); this.attachments = []; }
  _render() {
    const placeholder = this.getAttribute("placeholder") || "Ask anything…";
    const label = this.getAttribute("label") || "Message";
    const sendLabel = this.getAttribute("send-label") || "Run task";
    const html = `
      <div class="composer" part="composer">
        <textarea id="task-input" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(label)}" rows="2"></textarea>
        <div class="row">
          <mic-button id="mic"></mic-button>
          <attach-button id="attach"></attach-button>
          <span class="spacer"></span>
          <button id="run-task" class="btn send" type="button">${escapeHtml(sendLabel)}</button>
        </div>
      </div>
      <div class="composer-status" role="status" aria-live="polite"></div>`;
    mountTemplate(this, `
      :host { display:block; }
      .composer { background:var(--panel,#1e1e2e); border:1px solid var(--border,#333); border-radius:12px; padding:16px; }
      .composer:focus-within { border-color:var(--accent,#4f46e5); }
      .composer textarea { width:100%; background:transparent; border:0; color:var(--text,#eee); font:inherit; resize:vertical; min-height:60px; outline:none; }
      .composer .row { display:flex; gap:8px; align-items:center; margin-top:8px; }
      .composer .spacer { flex:1; }
      .composer .send { display:inline-flex; align-items:center; height:var(--control,36px); padding:0 16px;
        background:var(--accent,#4f46e5); color:var(--btn-fg,#fff); border:0; border-radius:8px;
        font:inherit; font-weight:600; cursor:pointer; }
      .composer .send:focus-visible { outline:2px solid var(--accent,#4f46e5); outline-offset:2px; }
      .composer-status { margin-top:8px; font-size:12px; color:var(--muted,#888); }
      .composer-status:empty { display:none; }
    `, html);
    this._input = this._root.querySelector("#task-input");
    this._mic = this._root.querySelector("#mic");
    this._attach = this._root.querySelector("#attach");
    this._run = this._root.querySelector("#run-task");
    this._status = this._root.querySelector(".composer-status");
  }
  _wire() {
    this._run?.addEventListener("click", () => this._send());
    this._input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._send(); }
    });
    this._mic?.addEventListener("transcript", (e) => {
      const { text, final: isFinal } = e.detail;
      this._input.value = text;
      if (isFinal) this._emit("transcript", { text });
    });
    this._attach?.addEventListener("attach", (e) => {
      this.attachments.push(e.detail);
      this._emit("attach", e.detail);
    });
    this._attach?.addEventListener("attach-media", (e) => this._emit("attach-media", e.detail));
    this._mic?.addEventListener("mic-error", (e) => this.setStatus(e.detail?.message || "mic error", false));
  }
  get input() { return this._input; }
  get value() { return this._input?.value ?? ""; }
  set value(v) { if (this._input) this._input.value = v; }
  setStatus(text, ready = true) {
    if (this._status) this._status.textContent = text || "";
    this._emit("status", { text, ready });
  }
  setLoading(loading) {
    if (loading) this._run?.setAttribute("loading", "");
    else this._run?.removeAttribute("loading");
  }
  focus() { this._input?.focus(); }
  _send() {
    const text = this._input?.value.trim();
    if (!text) return;
    if (this._input) this._input.value = "";
    const pending = this.attachments.splice(0);
    this._emit("send", { text, attachments: pending });
  }
}
customElements.define("agent-composer", AgentComposer);

/* <agent-dialog title> — consistent modal dialog (slotted content), built on the
 * native <dialog> element so close (X), light-dismiss (backdrop click), Escape,
 * focus trap, and focus-return are native behaviors. */
class AgentDialog extends Component {
  static get observedAttributes() { return ["title"]; }
  constructor() { super(); this._open = false; }
  _render() {
    const title = this.getAttribute("title") || "";
    mountTemplate(this, `
      :host { display:contents; }
      .dialog { background:var(--panel,#1e1e2e); border:1px solid var(--border,#333); border-radius:14px; padding:20px; min-width:320px; max-width:90vw; max-height:85vh; overflow:auto; box-shadow:0 20px 60px rgba(0,0,0,.4); color:var(--text,#eee); }
      .dialog::backdrop { background:rgba(0,0,0,.5); }
      .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
      .title { font-weight:700; font-size:16px; }
      .x { background:transparent; border:0; color:var(--text,#eee); cursor:pointer; padding:4px; }
      .x:focus-visible { outline:2px solid var(--accent,#4f46e5); outline-offset:2px; }
      .body { color:var(--text,#eee); }
    `, `<dialog part="dialog" class="dialog" aria-label="${escapeHtml(title)}">
        <div class="head"><span class="title">${escapeHtml(title)}</span>
          <button type="button" class="x" aria-label="Close">${ICONS.close}</button></div>
        <div class="body"><slot></slot></div>
      </dialog>`);
    this._dialog = this._root.querySelector(".dialog");
  }
  _wire() {
    this._root.querySelector(".x")?.addEventListener("click", () => this.close());
    // Light dismiss: with showModal(), a click outside the content lands on the
    // <dialog> element itself (the backdrop).
    this._dialog?.addEventListener("click", (e) => {
      if (e.target === this._dialog) this.close();
    });
    // Native close (Escape, the X button, or dialog.close()) → emit our event.
    this._dialog?.addEventListener("close", () => {
      if (this._open) { this._open = false; this._emit("close"); }
    });
  }
  get open() { return this._dialog?.open ?? false; }
  show() {
    if (!this._dialog || this._dialog.open) return;
    this._open = true;
    this._dialog.showModal();
    this._emit("open");
  }
  open() { this.show(); }
  close() { this._dialog?.close(); }
}
customElements.define("agent-dialog", AgentDialog);

/* <agent-picker agents="[{origin,tools}]" selected> — a list of agents */
class AgentPicker extends Component {
  static get observedAttributes() { return ["agents", "selected"]; }
  _render() {
    const agents = parseJSONAttr(this.getAttribute("agents"), []);
    const selected = this.getAttribute("selected") || "";
    const items = agents.map((a) => {
      const origin = a.origin || a.id || "";
      const short = origin.replace(/^https?:\/\//, "").replace(/\/.*/, "");
      return `<button type="button" class="agent" data-origin="${escapeHtml(origin)}"
        aria-pressed="${origin === selected}">
        <span class="badge" aria-hidden="true">@</span>
        <span class="who"><span class="name">@${escapeHtml(short)}</span>
        <span class="tools">${a.tools?.length ?? 0} tools</span></span></button>`;
    }).join("");
    mountTemplate(this, `
      :host { display:block; }
      .list { display:flex; flex-direction:column; gap:8px; }
      .agent { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border,#333); border-radius:10px; background:var(--panel,#1e1e2e); cursor:pointer; font:inherit; color:var(--text,#eee); text-align:left; }
      .agent[aria-pressed="true"] { border-color:var(--accent,#4f46e5); }
      .agent:focus-visible { outline:2px solid var(--accent,#4f46e5); outline-offset:2px; }
      .badge { width:28px; height:28px; border-radius:7px; background:var(--accent,#4f46e5); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-weight:700; }
      .name { font-weight:600; }
      .tools { display:block; font-size:12px; color:var(--muted,#888); }
      .empty { color:var(--muted,#888); font-size:13px; }
    `, agents.length ? `<div class="list">${items}</div>` : `<span class="empty">No agents.</span>`);
  }
  _wire() {
    this._root.querySelectorAll(".agent").forEach((b) =>
      b.addEventListener("click", () => this._emit("select", { origin: b.dataset.origin }))
    );
  }
}
customElements.define("agent-picker", AgentPicker);

/* <agent-config-form agent="{...}"> — a generic labeled-field form */
class AgentConfigForm extends Component {
  static get observedAttributes() { return ["agent"]; }
  _render() {
    const agent = parseJSONAttr(this.getAttribute("agent"), {});
    const name = agent.name || "";
    const instructions = agent.instructions || "";
    const skills = (agent.skills || []).join(", ");
    mountTemplate(this, `
      :host { display:block; }
      .form { display:flex; flex-direction:column; gap:12px; }
      label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--muted,#888); }
      input, textarea { background:var(--bg,#12121c); border:1px solid var(--border,#333); color:var(--text,#eee); border-radius:7px; padding:8px 10px; font:inherit; }
      input:focus-visible, textarea:focus-visible { outline:2px solid var(--accent,#4f46e5); outline-offset:1px; }
      .save { align-self:flex-start; border:0; border-radius:8px; padding:8px 16px; background:var(--accent,#4f46e5); color:var(--accent-contrast,#fff); cursor:pointer; font:inherit; font-weight:600; }
      .save:focus-visible { outline:2px solid var(--accent,#4f46e5); outline-offset:2px; }
    `, `<div class="form">
      <label>Name<input id="f-name" value="${escapeHtml(name)}"></label>
      <label>Instructions<textarea id="f-instr" rows="4">${escapeHtml(instructions)}</textarea></label>
      <label>Skills (comma-separated)<input id="f-skills" value="${escapeHtml(skills)}"></label>
      <button type="button" class="save">Save agent</button>
    </div>`);
  }
  _wire() {
    this._root.querySelector(".save")?.addEventListener("click", () => {
      this._emit("save", {
        name: this._root.querySelector("#f-name").value,
        instructions: this._root.querySelector("#f-instr").value,
        skills: this._root.querySelector("#f-skills").value.split(",").map((s) => s.trim()).filter(Boolean),
      });
    });
  }
}
customElements.define("agent-config-form", AgentConfigForm);

/* ──────────────────────────────────────────────────────────────────────────
 * Views — navigation between the hub/chat/directory/settings surfaces
 * ────────────────────────────────────────────────────────────────────────── */
export const VIEWS = [
  { id: "hub", label: "Hub" },
  { id: "chat", label: "Chat" },
  { id: "directory", label: "Directory" },
  { id: "settings", label: "Settings" },
];
class AgentNav extends Component {
  static get observedAttributes() { return ["active"]; }
  _render() {
    const active = this.getAttribute("active") || "hub";
    const tabs = VIEWS.map((v) =>
      `<button type="button" class="tab" data-view="${v.id}" role="tab"
        aria-selected="${v.id === active}">${escapeHtml(v.label)}</button>`
    ).join("");
    mountTemplate(this, `
      :host { display:inline-flex; gap:4px; border:1px solid var(--border,#333); border-radius:10px; padding:4px; background:var(--panel,#1e1e2e); }
      .tab { border:0; background:transparent; color:var(--text,#eee); border-radius:7px; padding:7px 14px; cursor:pointer; font:inherit; }
      .tab[aria-selected="true"] { background:var(--accent,#4f46e5); color:var(--accent-contrast,#fff); }
      .tab:focus-visible { outline:2px solid var(--accent,#4f46e5); outline-offset:1px; }
    `, tabs);
  }
  _wire() {
    this._root.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => this._emit("navigate", { view: t.dataset.view }))
    );
  }
}
customElements.define("agent-nav", AgentNav);

/* ──────────────────────────────────────────────────────────────────────────
 * One call registers everything (idempotent). Extension pages + the docs
 * showcase both call this.
 * ────────────────────────────────────────────────────────────────────────── */
export function registerComponents() {
  // All components are defined at module load via customElements.define above.
  // This function exists as the single, idempotent entry point for clarity and
  // for the showcase page to call explicitly.
  return true;
}
