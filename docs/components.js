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
  attach: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  record: '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
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

/** Inject a <style> once (idempotent, id-keyed) — used by light-DOM components. */
function ensureStyle(styleId, css) {
  if (document.getElementById(styleId)) return;
  const st = document.createElement("style");
  st.id = styleId;
  st.textContent = css;
  document.head.appendChild(st);
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

/* ──────────────────────────────────────────────────────────────────────────
 * Safe markdown renderer (no eval / new Function). Escapes everything FIRST,
 * then transforms a small, safe subset: fenced code blocks, inline code,
 * bold/italic, links, headings, and lists. Anything unrecognized stays literal
 * text. Used by the conversation surface to render agent/system output.
 * ────────────────────────────────────────────────────────────────────────── */

function renderInline(text) {
  let s = escapeHtml(text);
  // inline code `...`
  s = s.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
  // links [text](url) — http(s) only, opens in a new tab
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // bold **text**
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  // italic *text* (not part of a bold pair)
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return s;
}

function renderBlockText(text) {
  const lines = String(text ?? "").split("\n");
  let html = "";
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) { html += `<p>${renderInline(para.join(" "))}</p>`; para = []; }
  };
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (ul) {
      flushPara();
      if (list !== "ul") { flushList(); html += "<ul>"; list = "ul"; }
      html += `<li>${renderInline(ul[1])}</li>`;
    } else if (ol) {
      flushPara();
      if (list !== "ol") { flushList(); html += "<ol>"; list = "ol"; }
      html += `<li>${renderInline(ol[1])}</li>`;
    } else if (h) {
      flushPara(); flushList();
      const level = Math.min(h[1].length, 4);
      html += `<h${level}>${renderInline(h[2])}</h${level}>`;
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return html;
}

/** Render a small, safe markdown subset to HTML (fenced blocks → <code-block>). */
export function renderMarkdown(text) {
  const src = String(text ?? "");
  const out = [];
  const fence = /^```([^\n`]*)\n?([\s\S]*?)(?:^```\s*$)/gm;
  let last = 0;
  let m;
  while ((m = fence.exec(src))) {
    if (m.index > last) out.push(renderBlockText(src.slice(last, m.index)));
    const lang = (m[1] || "").trim();
    out.push(`<code-block lang="${escapeHtml(lang)}">${escapeHtml(m[2])}</code-block>`);
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(renderBlockText(src.slice(last)));
  return out.join("");
}

/* ──────────────────────────────────────────────────────────────────────────
 * Command + mention registry (the / palette + @ mentions in the composer).
 * Self-contained (no imports) so the docs showcase loads the same file.
 * The data-driven sources go through chrome.runtime when present and degrade
 * to empty lists in the plain showcase (no extension backend).
 * ────────────────────────────────────────────────────────────────────────── */
const RUNTIME_SEND = (() => {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      return (type, payload = {}) => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else resolve(res ?? { ok: true });
        });
      });
    }
  } catch { /* no chrome */ }
  return null;
})();

function shortOrigin(o) {
  return String(o).replace(/^https?:\/\//, "").replace(/\/.*/, "");
}

// Command namespaces (the / palette). Selecting one either opens its sub-items
// or inserts the prefix for free-text commands (remember).
export const COMMAND_NAMESPACES = [
  { id: "task", label: "task", description: "run a recipe", kind: "recipe" },
  { id: "schedule", label: "schedule", description: "run a recipe in the background", kind: "background" },
  { id: "agent", label: "agent", description: "direct the message to a site agent", kind: "agent" },
  { id: "skill", label: "skill", description: "invoke a skill", kind: "skill" },
  { id: "model", label: "model", description: "switch the provider/model", kind: "model" },
  { id: "theme", label: "theme", description: "switch the theme", kind: "theme" },
  { id: "remember", label: "remember", description: "write something to memory", kind: "free" },
  { id: "focus", label: "focus", description: "protect attention", kind: "recipe" },
];

// Sub-items for a selected command namespace, filtered by the typed argument.
async function commandItems(ns, arg = "") {
  const q = (arg || "").toLowerCase();
  const matches = (s) => !q || s.toLowerCase().includes(q);
  switch (ns) {
    case "task": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("recipe.list").catch(() => ({})) : {};
      return (res.recipes || [])
        .filter((r) => r.mode !== "background")
        .filter((r) => matches(r.name) || matches(r.id))
        .map((r) => ({ id: `task:${r.id}`, label: r.name, description: r.description || "", kind: "recipe" }));
    }
    case "schedule": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("recipe.list").catch(() => ({})) : {};
      return (res.recipes || [])
        .filter((r) => r.mode === "background")
        .filter((r) => matches(r.name) || matches(r.id))
        .map((r) => ({ id: `schedule:${r.id}`, label: r.name, description: r.description || "", kind: "background" }));
    }
    case "agent": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("agent.directory").catch(() => ({})) : {};
      return (res.agents || [])
        .filter((a) => a.enrolled)
        .filter((a) => matches(a.origin) || matches(a.name || ""))
        .map((a) => ({ id: `agent:${a.origin}`, label: `@${shortOrigin(a.origin)}`, description: `${a.toolCount ?? 0} tools`, kind: "agent" }));
    }
    case "skill": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("skills.all").catch(() => ({})) : {};
      const out = [];
      for (const [origin, skills] of Object.entries(res || {})) {
        for (const s of skills) {
          if (matches(s) || matches(shortOrigin(origin))) {
            out.push({ id: `skill:${origin}:${s}`, label: s, description: shortOrigin(origin), kind: "skill" });
          }
        }
      }
      return out;
    }
    case "model": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("provider.models").catch(() => ({})) : {};
      return (res.choices || [])
        .filter((c) => matches(c.label || "") || matches(c.id || ""))
        .map((c) => ({ id: `model:${c.id}`, label: c.label || c.id, description: "", kind: "model" }));
    }
    case "theme":
      return THEMES.filter((t) => matches(t.label) || matches(t.id))
        .map((t) => ({ id: `theme:${t.id}`, label: t.label, description: "theme", kind: "theme" }));
    case "focus": {
      const res = RUNTIME_SEND ? await RUNTIME_SEND("recipe.list").catch(() => ({})) : {};
      return (res.recipes || [])
        .filter((r) => r.mode === "background" && (r.category === "focus" || (r.id || "").includes("focus")))
        .filter((r) => matches(r.name) || matches(r.id))
        .map((r) => ({ id: `task:${r.id}`, label: r.name, description: r.description || "", kind: "recipe" }));
    }
    default:
      return [];
  }
}

// @ mention candidates: site agents, recipes, recent artifacts.
async function mentionCandidates(q = "") {
  const ql = (q || "").toLowerCase();
  const items = [];
  if (RUNTIME_SEND) {
    const [agents, recipes, assets] = await Promise.all([
      RUNTIME_SEND("agent.directory").catch(() => ({ agents: [] })),
      RUNTIME_SEND("recipe.list").catch(() => ({ recipes: [] })),
      RUNTIME_SEND("asset.list", { origin: "master" }).catch(() => ({ assets: [] })),
    ]);
    for (const a of (agents.agents || []).filter((x) => x.enrolled)) {
      items.push({ id: `agent:${a.origin}`, label: `@${shortOrigin(a.origin)}`, description: `${a.toolCount ?? 0} tools · site agent`, kind: "agent" });
    }
    for (const r of recipes.recipes || []) {
      items.push({ id: `recipe:${r.id}`, label: r.name, description: r.description || "", kind: "recipe" });
    }
    for (const a of assets.assets || []) {
      items.push({ id: `asset:${a.id ?? a.name}`, label: a.name, description: a.type || "artifact", kind: "artifact" });
    }
  }
  return items.filter((i) => (i.label || "").toLowerCase().includes(ql) || (i.id || "").toLowerCase().includes(ql));
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
        cursor:pointer; background:var(--accent, #0e6e63); color:var(--accent-contrast, #fff); }
      .run:disabled { opacity:.55; cursor:not-allowed; }
      .run:focus-visible { outline:2px solid var(--accent, #0e6e63); outline-offset:2px; }
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
        padding:0; cursor:pointer; font:inherit; line-height:1; }
      .mic .icon { display:inline-flex; align-items:center; justify-content:center; }
      .mic svg { display:block; }
      .mic[data-listening] { color:var(--accent, #0e6e63); border-color:var(--accent, #0e6e63); }
      .mic:focus-visible { outline:2px solid var(--accent, #0e6e63); outline-offset:2px; }
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
      this._emit("mic-error", { message: "speech recognition not available in this browser" });
      return;
    }
    if (!this._recognition) {
      this._recognition = new SR();
      this._recognition.continuous = true;
      this._recognition.interimResults = true;
      this._recognition.lang = "en-US";
      this._recognition.onresult = (e) => {
        // Accumulate the FULL transcript (committed finals + interim) across the
        // cumulative result list, NOT just the new chunk — otherwise every
        // event overwrites the input with only the latest word.
        let finalText = "";
        let interimText = "";
        for (let i = 0; i < e.results.length; i++) {
          const res = e.results[i];
          if (!res?.[0]) continue;
          if (res.isFinal) finalText += res[0].transcript;
          else interimText += res[0].transcript;
        }
        const text = (finalText + (finalText && interimText ? " " : "") + interimText).trim();
        this._emit("transcript", { text, final: !interimText });
      };
      this._recognition.onerror = (e) => {
        if (e.error === "no-speech" || e.error === "aborted") return;
        const msg =
          e.error === "not-allowed" || e.error === "service-not-allowed"
            ? "microphone permission denied"
            : e.error === "network"
            ? "speech service unavailable (network)"
            : "speech error: " + e.error;
        this._emit("mic-error", { message: msg });
        this.stop();
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
        border:1px solid var(--border,#e3e0d9); color:var(--text,#1d1b18); border-radius:8px;
        padding:0; cursor:pointer; font:inherit; line-height:1; }
      .plus svg { display:block; }
      .plus:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .menu { position:absolute; bottom:calc(100% + 6px); left:0; background:var(--panel,#ffffff);
        border:1px solid var(--border,#e3e0d9); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.25);
        padding:4px; min-width:180px; z-index:20; }
      .menu[hidden] { display:none; }
      .menu button { display:block; width:100%; text-align:left; background:transparent; border:0;
        color:var(--text,#1d1b18); padding:8px 10px; border-radius:7px; cursor:pointer; font:inherit; }
      .menu button:hover, .menu button:focus-visible { background:var(--bg,#12121c); outline:none; }
      .note { font-size:11px; color:var(--muted,#635e56); margin:6px 0 2px; max-width:220px; }
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
      if (file) this._emit("attach", file);
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
      input.onchange = async () => {
        const file = input.files?.[0] ?? null;
        if (!file) return resolve(null);
        // Read the bytes as a dataURL so the service worker can actually send
        // TEXT content to the model (and label media honestly). The SW bounds
        // the payload; we only pass the decoded data through.
        let dataURL = "";
        try {
          dataURL = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.onerror = () => rej(fr.error);
            fr.readAsDataURL(file);
          });
        } catch { /* non-fatal — the SW still labels the attachment */ }
        resolve({ name: file.name, size: file.size, type: file.type, kind, file, dataURL });
      };
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
      .swatch[aria-pressed="true"] { border-color:var(--text,#1d1b18); }
      .swatch:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
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
      .perm { display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--border,#e3e0d9); border-radius:10px; background:var(--panel,#ffffff); }
      .info { flex:1; min-width:0; }
      .name { font-weight:600; }
      .desc { font-size:12px; color:var(--muted,#635e56); }
      .state { font-size:11px; text-transform:uppercase; letter-spacing:.03em; color:var(--muted,#635e56); }
      .state.granted { color:var(--accent2,#34d399); }
      .state.warned { color:var(--warn,#f59e0b); }
      .btn { border:1px solid var(--border,#e3e0d9); background:transparent; color:var(--text,#1d1b18); border-radius:7px; padding:6px 12px; cursor:pointer; font:inherit; }
      .btn:disabled { opacity:.5; cursor:not-allowed; }
      .btn:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
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
      .card { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border,#e3e0d9); border-radius:10px; background:var(--panel,#ffffff); cursor:pointer; }
      .card:hover, .card:focus-visible { border-color:var(--accent,#0e6e63); outline:none; }
      .badge { width:32px; height:32px; border-radius:8px; background:var(--accent,#0e6e63); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-weight:700; }
      .who { flex:1; min-width:0; }
      .name { font-weight:600; }
      .tools { font-size:12px; color:var(--muted,#635e56); }
      .status { font-size:11px; color:var(--muted,#635e56); }
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
      .run:hover, .run:focus-visible { color:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); outline:none; }
      .switch { justify-self:end; position:relative; width:36px; height:20px; border-radius:999px;
        border:1px solid var(--border,#e3e0d9); background:var(--panel,#ffffff); cursor:pointer;
        padding:0; flex:0 0 auto; transition:background 150ms ease, border-color 150ms ease; }
      .switch::after { content:""; position:absolute; top:2px; left:2px; width:14px; height:14px;
        border-radius:50%; background:var(--muted,#635e56); transition:transform 150ms ease, background 150ms ease; }
      .switch[aria-pressed="true"] { background:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); }
      .switch[aria-pressed="true"]::after { transform:translateX(16px); background:var(--btn-fg,#ffffff); }
      .switch:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
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

/* <code-block lang="python">code text</code-block>
 * A fenced code block: monospace, a subtle panel surface, a language label,
 * horizontal scroll + a copy button. Content is its light-DOM text (already
 * HTML-escaped by the markdown renderer). */
class CodeBlock extends Component {
  static get observedAttributes() { return ["lang"]; }
  _render() {
    const lang = this.getAttribute("lang") || "";
    const code = (this.textContent || "").replace(/\n$/, "");
    mountTemplate(this, `
      :host { display:block; margin:10px 0; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,6px); background:var(--panel-2,#efede8); overflow:hidden; }
      .head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 10px; background:var(--panel,#ffffff); border-bottom:1px solid var(--border,#e3e0d9); }
      .lang { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; letter-spacing:.02em; color:var(--muted,#635e56); }
      .copy { border:0; background:transparent; color:var(--muted,#635e56); font-size:11px; cursor:pointer; padding:2px 6px; border-radius:4px; }
      .copy:hover { background:var(--panel-2,#efede8); color:var(--text,#1d1b18); }
      .copy:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
      pre { margin:0; padding:10px 12px; overflow-x:auto; }
      code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; line-height:1.5; white-space:pre; color:var(--text,#1d1b18); }
    `, `<div class="head"><span class="lang">${escapeHtml(lang) || "code"}</span><button type="button" class="copy">Copy</button></div><pre><code>${escapeHtml(code)}</code></pre>`);
  }
  _wire() {
    const btn = this._root.querySelector(".copy");
    btn?.addEventListener("click", async () => {
      const code = this.textContent || "";
      try {
        await navigator.clipboard?.writeText(code);
        btn.textContent = "Copied";
      } catch {
        // clipboard unavailable (e.g. file:// showcase) — still give feedback.
        const ta = document.createElement("textarea");
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); btn.textContent = "Copied"; } catch { btn.textContent = "Copy"; }
        ta.remove();
      }
      setTimeout(() => { btn.textContent = "Copy"; }, 1600);
    });
  }
}
customElements.define("code-block", CodeBlock);

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
class MessageBubble extends Component {
  static get observedAttributes() {
    return ["role", "content", "tool-name", "tool-status", "tool-args", "tool-result", "step", "total-steps"];
  }
  _content() {
    return this.hasAttribute("content") ? (this.getAttribute("content") ?? "") : (this.textContent ?? "");
  }
  _render() {
    const role = this.getAttribute("role") || "agent";
    const content = this._content();
    const style = `
      :host { display:flex; margin:0 0 14px; justify-content:flex-start; }
      :host(:last-child) { margin-bottom:0; }
      :host([role="user"]) { justify-content:flex-end; }
      .msg { max-width:78%; border-radius:12px; padding:10px 14px; overflow-wrap:anywhere; }
      .body { font-size:14px; line-height:1.55; color:var(--ink,#1d1b18); }
      :host([role="user"]) .msg { background:var(--secondary-layer,#efede8); }
      :host([role="agent"]) .msg, :host([role="system"]) .msg { background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); }
      :host([role="error"]) .msg { background:var(--panel,#ffffff); border:1px solid var(--danger,#b3261e); }
      :host([role="error"]) .body { color:var(--danger,#b3261e); }
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
      /* tool card */
      .tool { display:flex; flex-direction:column; width:100%; max-width:640px; border:1px solid var(--border,#e3e0d9); border-radius:10px; background:var(--panel,#ffffff); overflow:hidden; }
      .tool .tool-head { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid var(--border,#e3e0d9); background:var(--panel-2,#efede8); }
      .tool .tool-name { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; font-weight:600; color:var(--ink,#1d1b18); }
      .tool .tool-status { margin-left:auto; display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:600; padding:1px 8px; border-radius:999px; }
      .tool .tool-status::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
      .tool .tool-status.running { color:var(--muted,#635e56); background:var(--panel,#ffffff); }
      .tool .tool-status.done { color:var(--success,#1a7f37); background:var(--panel,#ffffff); }
      .tool .tool-status.error { color:var(--danger,#b3261e); background:var(--panel,#ffffff); }
      .tool .tool-args { padding:6px 10px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; }
      .tool .tool-result { padding:6px 10px; font-size:12.5px; color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; border-top:1px solid var(--border,#e3e0d9); }
    `;
    let markup;
    if (role === "tool") {
      const name = this.getAttribute("tool-name") || "tool";
      const statusRaw = this.getAttribute("tool-status") || "running";
      const status = statusRaw === "success" ? "done" : statusRaw === "error" ? "error" : "running";
      const args = this.getAttribute("tool-args");
      const result = this.getAttribute("tool-result");
      markup = `<div class="tool" role="status">
        <div class="tool-head"><span class="tool-name">${escapeHtml(name)}</span><span class="tool-status ${status}">${status === "done" ? "done" : status === "error" ? "error" : "running"}</span></div>
        ${args != null ? `<div class="tool-args">${escapeHtml(args)}</div>` : ""}
        ${result != null ? `<div class="tool-result">${escapeHtml(result)}</div>` : ""}
      </div>`;
    } else if (role === "thinking") {
      const step = this.getAttribute("step");
      const total = this.getAttribute("total-steps");
      const hasTrace = content && !/^thinking\.\.\.$/i.test(content.trim()) && !/^thinking…$/i.test(content.trim());
      const label = step != null ? `thinking · step ${step}${total ? ` of ${total}` : ""}` : "thinking";
      if (!hasTrace) {
        markup = `<div class="think" role="status"><summary style="list-style:none;display:flex;align-items:center;gap:8px;color:var(--muted,#635e56);font-size:13px;padding:2px 0;"><span class="spin" aria-hidden="true"></span><span>${escapeHtml(label)}</span></summary></div>`;
      } else {
        markup = `<details class="think"><summary><svg class="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg><span>${escapeHtml(label)}</span></summary><div class="trace">${escapeHtml(content)}</div></details>`;
      }
    } else {
      const body = (role === "agent" || role === "system" || role === "user") ? renderMarkdown(content) : `<span class="plain">${renderInline(content)}</span>`;
      markup = `<div class="msg ${role}"><div class="body">${body}</div></div>`;
    }
    mountTemplate(this, style, markup);
  }
}
customElements.define("message-bubble", MessageBubble);

/* <agent-conversation messages='[{role,content,…}]'>
 * The unified conversational surface (the "Now" section + the chat). A
 * light-DOM flex column that hosts <message-bubble> children. Imperative API:
 *   appendUser(text) / appendAgent(text) / appendSystem(text)
 *   appendThinking(text, {step,totalSteps}) / appendTool({name,args,status,result})
 *   appendError(text) / clear() / setMessages(messages)
 * The `messages` attribute populates it declaratively for the showcase. */
class AgentConversation extends Component {
  static shadow() { return false; }
  static get observedAttributes() { return ["messages"]; }
  _render() {
    ensureStyle("sc-agent-conversation-style", `
      agent-conversation { display:flex; flex-direction:column; min-height:0; }
      agent-conversation .empty { color:var(--muted,#635e56); font-size:var(--text-sm,13px); padding:2px 0; }
    `);
    const msgs = this.getAttribute("messages");
    if (msgs != null) this.setMessages(parseJSONAttr(msgs, []));
  }
  attributeChangedCallback(name, ov, nv) {
    if (name === "messages" && ov !== nv && this._rendered) {
      this.setMessages(parseJSONAttr(nv, []));
    }
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
    this.appendChild(b);
    this.scrollTop = this.scrollHeight;
    return b;
  }
  appendUser(text) { return this._bubble("user", text); }
  appendAgent(text) { return this._bubble("agent", text); }
  appendSystem(text) { return this._bubble("system", text); }
  appendError(text) { return this._bubble("error", text); }
  appendThinking(text, { step, totalSteps } = {}) {
    return this._bubble("thinking", text, { step, "total-steps": totalSteps });
  }
  appendTool(m = {}) {
    // Accept both the imperative {name,args,status,result} and the message
    // object {tool-name,tool-status,tool-args,tool-result} conventions.
    const name = m.name ?? m["tool-name"];
    const status = m.status ?? m["tool-status"];
    const args = m.args ?? m["tool-args"];
    const result = m.result ?? m["tool-result"];
    return this._bubble("tool", null, {
      "tool-name": name,
      "tool-status": status || "running",
      "tool-args": args != null ? (typeof args === "string" ? args : JSON.stringify(args)) : null,
      "tool-result": result != null ? String(result) : null,
    });
  }
  clear() { this.replaceChildren(); }
  setMessages(messages) {
    this.replaceChildren();
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "No conversation yet — start one above.";
      this.appendChild(p);
      return;
    }
    for (const m of list) {
      if (!m || typeof m !== "object") continue;
      switch (m.role) {
        case "user": this.appendUser(m.content); break;
        case "agent": this.appendAgent(m.content); break;
        case "system": this.appendSystem(m.content); break;
        case "thinking": this.appendThinking(m.content, m); break;
        case "tool": this.appendTool(m); break;
        case "error": this.appendError(m.content); break;
        default: this.appendAgent(m.content); break;
      }
    }
    this.scrollTop = this.scrollHeight;
  }
}
customElements.define("agent-conversation", AgentConversation);

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
      .shot { position:relative; flex:0 0 auto; width:96px; height:64px; border:1px solid var(--border,#e3e0d9); border-radius:8px; overflow:hidden; padding:0; cursor:pointer; background:var(--bg,#12121c); }
      .shot img { width:100%; height:100%; object-fit:cover; display:block; }
      .shot:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .lbl { position:absolute; inset:auto 0 0 0; font-size:9px; background:rgba(0,0,0,.6); color:#fff; padding:1px 3px; }
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
        <div class="popup" id="popup" role="listbox" aria-label="Suggestions" hidden></div>
        <div class="chips" id="chips"></div>
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
      .composer { position:relative; background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:12px; padding:14px; }
      .composer:focus-within { border-color:var(--accent,#0e6e63); }
      .popup { position:absolute; top:calc(100% + 4px); left:0; right:0; background:var(--panel,#ffffff);
        border:1px solid var(--border,#e3e0d9); border-radius:10px; box-shadow:var(--shadow-2, 0 12px 32px rgba(29,27,24,.08));
        max-height:260px; overflow-y:auto; padding:4px; z-index:40; }
      .popup[hidden] { display:none; }
      .popup .item { display:flex; align-items:baseline; gap:10px; padding:7px 10px; border-radius:7px; cursor:pointer; }
      .popup .item:hover, .popup .item[data-active="true"] { background:var(--panel-2,#efede8); }
      .popup .item .lbl { font-weight:600; font-size:13px; color:var(--text,#1d1b18); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .popup .item .dsc { flex:1; text-align:right; font-size:11px; color:var(--muted,#635e56); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .popup .empty { padding:8px 10px; font-size:12px; color:var(--muted,#635e56); }
      .composer textarea { width:100%; background:transparent; border:0; color:var(--text,#1d1b18); font:inherit; resize:vertical; min-height:44px; outline:none; line-height:1.45; }
      .composer .row { display:flex; gap:8px; align-items:center; margin-top:8px; }
      .composer .spacer { flex:1; }
      .composer .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .composer .chips:empty { display:none; }
      .composer .chips .chip { display:inline-flex; align-items:center; gap:6px; font-size:12px;
        color:var(--text,#1d1b18); background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9);
        border-radius:999px; padding:3px 10px; }
      .composer .chips .chip button { border:0; background:transparent; color:var(--muted,#635e56);
        cursor:pointer; padding:0; font:inherit; line-height:1; }
      .composer .chips .chip button:hover { color:var(--text,#1d1b18); }
      .composer .send { display:inline-flex; align-items:center; height:var(--control,36px); padding:0 16px;
        background:var(--accent,#0e6e63); color:var(--btn-fg,#fff); border:0; border-radius:8px;
        font:inherit; font-weight:600; cursor:pointer; }
      .composer .send:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .composer-status { margin-top:8px; font-size:12px; color:var(--muted,#635e56); }
      .composer-status:empty { display:none; }
    `, html);
    this._input = this._root.querySelector("#task-input");
    this._mic = this._root.querySelector("#mic");
    this._attach = this._root.querySelector("#attach");
    this._run = this._root.querySelector("#run-task");
    this._status = this._root.querySelector(".composer-status");
    this._popup = this._root.querySelector("#popup");
    this._chips = this._root.querySelector("#chips");
    this._popupItems = [];
    this._popupActive = -1;
    this._popupToken = null;
  }
  _wire() {
    this._run?.addEventListener("click", () => this._send());
    this._input?.addEventListener("input", () => this._onComposerInput());
    this._input?.addEventListener("keydown", (e) => {
      if (this._popupOpen) {
        if (e.key === "ArrowDown") { e.preventDefault(); this._moveSelection(1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); this._moveSelection(-1); return; }
        if (e.key === "Enter") { e.preventDefault(); this._selectActive(); return; }
        if (e.key === "Tab") { e.preventDefault(); this._selectActive(); return; }
        if (e.key === "Escape") { e.preventDefault(); this._hidePopup(); return; }
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._send(); }
    });
    this._mic?.addEventListener("transcript", (e) => {
      const { text, final: isFinal } = e.detail;
      this._input.value = text;
      if (isFinal) this._emit("transcript", { text });
    });
    this._attach?.addEventListener("attach", (e) => {
      const detail = e.detail ?? {};
      this.attachments.push(detail);
      this._addChip(detail);
      this._emit("attach", detail);
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

  // ── / command + @ mention popup ─────────────────────────────────────────
  get _popupOpen() { return !!(this._popup && !this._popup.hidden); }

  async _onComposerInput() {
    const input = this._input;
    if (!input) return;
    const text = input.value;
    const caret = input.selectionStart ?? text.length;
    const before = text.slice(0, caret);

    // / command — a slash beginning the current token.
    const slash = before.match(/(?:^|\s)\/([a-z]*)(?::([a-z0-9._ -]*))?$/i);
    if (slash) {
      const slashPos = text[slash.index] === "/" ? slash.index : slash.index + 1;
      const ns = (slash[1] || "").toLowerCase();
      const arg = (slash[2] || "").trim();
      if (!ns) {
        const items = COMMAND_NAMESPACES.map((n) => ({
          id: `cmd:${n.id}`, label: `/${n.label}`, description: n.description, kind: n.kind, ns: n.id,
        }));
        this._showPopup(items, { type: "command", start: slashPos, end: caret, ns: "", arg: "" });
        return;
      }
      const items = await commandItems(ns, arg);
      if (!items.length && ns === "remember") {
        this._showPopup([{ id: "free:remember", label: "/remember ", description: "write to memory", kind: "free", ns: "remember", free: true }],
          { type: "command", start: slashPos, end: caret, ns, arg });
        return;
      }
      this._showPopup(items.map((i) => ({ ...i, ns })), { type: "command", start: slashPos, end: caret, ns, arg });
      return;
    }

    // @ mention.
    const at = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (at) {
      const atPos = text[at.index] === "@" ? at.index : at.index + 1;
      const items = await mentionCandidates(at[1] || "");
      this._showPopup(items, { type: "mention", start: atPos, end: caret });
      return;
    }

    this._hidePopup();
  }

  _showPopup(items, token) {
    this._popupItems = items || [];
    this._popupToken = token || null;
    this._popupActive = this._popupItems.length ? 0 : -1;
    if (!this._popupItems.length) { this._hidePopup(); return; }
    this._renderPopupItems();
    if (this._popup) this._popup.hidden = false;
  }

  _renderPopupItems() {
    if (!this._popup) return;
    const html = this._popupItems.map((it, i) =>
      `<div class="item" role="option" data-index="${i}" data-active="${i === this._popupActive}" aria-selected="${i === this._popupActive}">
        <span class="lbl">${escapeHtml(it.label)}</span>${
          it.description ? `<span class="dsc">${escapeHtml(it.description)}</span>` : ""
        }</div>`
    ).join("");
    this._popup.innerHTML = html;
    this._popup.querySelectorAll(".item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._select(Number(el.dataset.index));
      });
    });
  }

  _moveSelection(delta) {
    if (!this._popupItems.length) return;
    this._popupActive = (this._popupActive + delta + this._popupItems.length) % this._popupItems.length;
    this._renderPopupItems();
    this._popup.querySelector(`[data-index="${this._popupActive}"]`)?.scrollIntoView({ block: "nearest" });
  }

  _selectActive() { this._select(this._popupActive); }

  _select(index) {
    const item = this._popupItems[index];
    const token = this._popupToken;
    const input = this._input;
    if (!item || !token || !input) { this._hidePopup(); return; }

    if (token.type === "command") {
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
      // A concrete command item → insert its full reference.
      input.setRangeText(item.id, token.start, token.end, "end");
      this._hidePopup();
      this._emit("command", { namespace: item.ns, item });
      input.focus();
      return;
    }

    // mention
    input.setRangeText(item.id, token.start, token.end, "end");
    this._hidePopup();
    this._emit("mention", { item });
    input.focus();
  }

  _hidePopup() {
    if (this._popup) this._popup.hidden = true;
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

  _send() {
    const text = this._input?.value.trim();
    if (!text) return;
    if (this._input) this._input.value = "";
    const pending = this.attachments.splice(0);
    this._clearChips();
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
      .dialog { background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:14px; padding:20px; min-width:320px; max-width:90vw; max-height:85vh; overflow:auto; box-shadow:0 20px 60px rgba(0,0,0,.4); color:var(--text,#1d1b18); }
      .dialog::backdrop { background:rgba(0,0,0,.5); }
      .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
      .title { font-weight:700; font-size:16px; }
      .x { background:transparent; border:0; color:var(--text,#1d1b18); cursor:pointer; padding:4px; }
      .x:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .body { color:var(--text,#1d1b18); }
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
      .agent { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border,#e3e0d9); border-radius:10px; background:var(--panel,#ffffff); cursor:pointer; font:inherit; color:var(--text,#1d1b18); text-align:left; }
      .agent[aria-pressed="true"] { border-color:var(--accent,#0e6e63); }
      .agent:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .badge { width:28px; height:28px; border-radius:7px; background:var(--accent,#0e6e63); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-weight:700; }
      .name { font-weight:600; }
      .tools { display:block; font-size:12px; color:var(--muted,#635e56); }
      .empty { color:var(--muted,#635e56); font-size:13px; }
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
      label { display:flex; flex-direction:column; gap:4px; font-size:13px; color:var(--muted,#635e56); }
      input, textarea { background:var(--bg,#12121c); border:1px solid var(--border,#e3e0d9); color:var(--text,#1d1b18); border-radius:7px; padding:8px 10px; font:inherit; }
      input:focus-visible, textarea:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
      .save { align-self:flex-start; border:0; border-radius:8px; padding:8px 16px; background:var(--accent,#0e6e63); color:var(--accent-contrast,#fff); cursor:pointer; font:inherit; font-weight:600; }
      .save:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
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
      :host { display:inline-flex; gap:4px; border:1px solid var(--border,#e3e0d9); border-radius:10px; padding:4px; background:var(--panel,#ffffff); }
      .tab { border:0; background:transparent; color:var(--text,#1d1b18); border-radius:7px; padding:7px 14px; cursor:pointer; font:inherit; }
      .tab[aria-selected="true"] { background:var(--accent,#0e6e63); color:var(--accent-contrast,#fff); }
      .tab:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
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
 * Transparency surfaces: <error-console> + <security-shield>
 * ────────────────────────────────────────────────────────────────────────── */

// Fetch from the extension backend when present; degrade to empty in the docs
// showcase (no extension). Mirrors RUNTIME_SEND above.
function backend(type, payload = {}) {
  return RUNTIME_SEND ? RUNTIME_SEND(type, payload) : Promise.resolve({});
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour12: false });
  } catch {
    return "";
  }
}

// A shared floating-panel base: a trigger button (icon + badge) that toggles a
// fixed-position panel. Subclasses set this.triggerIcon / this.triggerLabel +
// override _panelMarkup() + _refreshPanel().
class PanelButton extends Component {
  static get observedAttributes() { return ["count", "label", "attention"]; }
  constructor() {
    super();
    this._open = false;
  }
  attributeChangedCallback(name, oldV, newV) {
    if (this._rendered && oldV !== newV) {
      this._render();
      this._wire();
      if (this._open) this._refreshPanel();
    }
  }
  _render() {
    const count = Number(this.getAttribute("count") || 0);
    const label = this.getAttribute("label") || "";
    const attention = this.hasAttribute("attention");
    const badge = count > 0
      ? `<span class="badge" aria-hidden="true">${count > 99 ? "99+" : count}</span>`
      : "";
    mountTemplate(this, `
      :host { display:inline-flex; position:relative; }
      .trigger { position:relative; display:inline-flex; align-items:center; justify-content:center;
        width:36px; height:36px; border:1px solid var(--border,#e3e0d9); border-radius:8px;
        background:transparent; color:var(--muted,#635e56); cursor:pointer; padding:0; }
      .trigger:hover { color:var(--text,#1d1b18); border-color:var(--accent,#0e6e63); }
      .trigger[data-attention="true"] { color:${attention ? "var(--warning,#9a6700)" : "var(--muted,#635e56)"}; border-color:${attention ? "var(--warning,#9a6700)" : "var(--border,#e3e0d9)"}; }
      .trigger:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .badge { position:absolute; top:-6px; right:-6px; min-width:17px; height:17px; padding:0 4px;
        border-radius:999px; background:var(--danger,#b3261e); color:#fff; font-size:10px; font-weight:700;
        display:inline-flex; align-items:center; justify-content:center; line-height:1; }
      .panel { position:fixed; z-index:200; width:min(560px, calc(100vw - 24px));
        background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:12px;
        box-shadow:var(--shadow-2, 0 12px 32px rgba(29,27,24,.08)); overflow:hidden; }
      .panel[hidden] { display:none; }
      .phead { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--border,#e3e0d9); }
      .phead .t { font-weight:600; font-size:13px; margin:0; flex:1; }
      .phead button { display:inline-flex; align-items:center; gap:4px; background:transparent; border:0;
        color:var(--muted,#635e56); cursor:pointer; font-size:12px; padding:4px 6px; border-radius:6px; }
      .phead button:hover { background:var(--panel-2,#efede8); color:var(--text,#1d1b18); }
      .pbody { max-height:340px; overflow:auto; }
      .console { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; padding:4px 0; }
      .console .empty, .shield-body .empty { padding:16px 14px; color:var(--muted,#635e56); font-size:12px; }
      .console .line { display:flex; gap:8px; padding:3px 14px; align-items:baseline; border-left:2px solid transparent; }
      .console .line:hover { background:var(--panel-2,#efede8); }
      .console .ts { flex:0 0 auto; color:var(--muted,#635e56); }
      .console .lv { flex:0 0 auto; width:44px; text-transform:uppercase; font-size:10px; font-weight:700; letter-spacing:.04em; }
      .console .lvl-error { border-left-color:var(--danger,#b3261e); } .console .lvl-error .lv { color:var(--danger,#b3261e); }
      .console .lvl-warn { border-left-color:var(--warning,#9a6700); } .console .lvl-warn .lv { color:var(--warning,#9a6700); }
      .console .msg { flex:1; word-break:break-word; white-space:pre-wrap; }
      .shield-body .sect { padding:12px 14px; border-bottom:1px solid var(--border,#e3e0d9); }
      .shield-body .sect:last-child { border-bottom:0; }
      .shield-body .sect-h { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--muted,#635e56); margin-bottom:8px; }
      .shield-body .chips { display:flex; flex-wrap:wrap; gap:6px; }
      .shield-body .chip { font-size:12px; padding:3px 9px; border-radius:999px; border:1px solid var(--border,#e3e0d9); }
      .shield-body .chip.ok { background:var(--on-accent-muted,#d7f0ea); border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      .shield-body .chip.muted { color:var(--muted,#635e56); }
      .shield-body .viol { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
      .shield-body .viol li { display:flex; gap:8px; align-items:baseline; font-size:12px; }
      .shield-body .vkind { flex:0 0 auto; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; color:var(--warning,#9a6700); }
      .shield-body .vmsg { flex:1; word-break:break-word; }
      .shield-body .vts { flex:0 0 auto; color:var(--muted,#635e56); }
      @media (prefers-reduced-motion: reduce) { .panel { transition:none; } }
    `, `
      <button class="trigger" type="button" aria-label="${escapeHtml(label)}" data-attention="${attention}" aria-expanded="${this._open}">${this.triggerIcon}${badge}</button>
      <div class="panel" role="dialog" aria-label="${escapeHtml(label)}" hidden>${this._panelMarkup()}</div>
    `);
  }
  _wire() {
    this._trigger = this._root.querySelector(".trigger");
    this._panel = this._root.querySelector(".panel");
    this._trigger?.addEventListener("click", () => this._toggle());
    this._panel?.querySelector("[data-close]")?.addEventListener("click", () => this._close());
    this._panel?.querySelector("[data-clear]")?.addEventListener("click", () => this._clear());
    // Close on Escape + outside click (light-dismiss, like a native dialog).
    this._bindDocument("keydown", (e) => { if (e.key === "Escape") this._close(); });
    this._bindDocument("pointerdown", (e) => {
      if (this._open && !this.contains(e.composedPath()[0])) this._close();
    });
  }
  _toggle() { this._open ? this._close() : this._openPanel(); }
  async _openPanel() {
    this._open = true;
    this._panel.hidden = false;
    this._position();
    this._trigger?.setAttribute("aria-expanded", "true");
    await this._refreshPanel();
  }
  _close() {
    this._open = false;
    this._panel.hidden = true;
    this._trigger?.setAttribute("aria-expanded", "false");
  }
  _position() {
    const r = this._trigger?.getBoundingClientRect?.();
    if (!r) return;
    const panel = this._panel;
    panel.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 360)}px`;
    // Right-align the panel to the trigger; clamp into the viewport.
    const w = panel.offsetWidth || 560;
    panel.style.left = `${Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12))}px`;
  }
  // Subclasses:
  get triggerIcon() { return ""; }
  _panelMarkup() { return ""; }
  async _refreshPanel() {}
  async _clear() {}
}
class ErrorConsole extends PanelButton {
  get triggerIcon() { return ICONS.terminal; }
  _panelMarkup() {
    return `
      <div class="phead">
        <span class="t">Console</span>
        <button type="button" data-clear>Clear</button>
        <button type="button" data-close aria-label="Close">${ICONS.close}</button>
      </div>
      <div class="pbody console" role="log" aria-live="polite"></div>`;
  }
  async _refreshPanel() {
    const body = this._panel.querySelector(".console");
    if (!body) return;
    const res = await backend("diagnostics.list");
    const entries = res.entries || [];
    if (!entries.length) {
      body.innerHTML = `<div class="empty">No errors captured. The console shows extension errors, warnings, and unhandled rejections as they happen.</div>`;
      return;
    }
    body.innerHTML = entries.map((e) =>
      `<div class="line lvl-${escapeHtml(e.level)}">` +
      `<span class="ts">${escapeHtml(fmtTime(e.ts))}</span>` +
      `<span class="lv">${escapeHtml(e.level)}</span>` +
      `<span class="msg">${escapeHtml(e.message)}</span></div>`
    ).join("");
    body.scrollTop = 0;
  }
  async _clear() {
    await backend("diagnostics.clear");
    this.setAttribute("count", "0");
    await this._refreshPanel();
    this._emit("cleared");
  }
}
customElements.define("error-console", ErrorConsole);

/* <security-shield count label> — the transparency surface: CSP/security
 * violations + the granted optional permissions (the user SEES the authority). */
class SecurityShield extends PanelButton {
  get triggerIcon() { return ICONS.shield; }
  _panelMarkup() {
    return `
      <div class="phead">
        <span class="t">Security</span>
        <button type="button" data-clear>Clear</button>
        <button type="button" data-close aria-label="Close">${ICONS.close}</button>
      </div>
      <div class="pbody shield-body"></div>`;
  }
  async _refreshPanel() {
    const body = this._panel.querySelector(".shield-body");
    if (!body) return;
    const res = await backend("security.state");
    const granted = res.granted || [];
    const violations = res.violations || [];
    const permRows = granted.length
      ? granted.map((p) => `<span class="chip ok" title="granted">${escapeHtml(p)}</span>`).join("")
      : `<span class="chip muted">none — running with zero permissions</span>`;
    const viol = violations.length
      ? `<ul class="viol">${violations.map((v) =>
        `<li><span class="vkind">${escapeHtml(v.kind)}</span><span class="vmsg">${escapeHtml(v.message)}</span><span class="vts">${escapeHtml(fmtTime(v.ts))}</span></li>`
      ).join("")}</ul>`
      : `<div class="empty">No security violations. Content-Security-Policy violations, denied hooks, blocked actions, and cross-origin attempts would appear here.</div>`;
    body.innerHTML = `
      <div class="sect"><div class="sect-h">Granted permissions</div><div class="chips">${permRows}</div></div>
      <div class="sect"><div class="sect-h">Security events</div>${viol}</div>`;
  }
  async _clear() {
    await backend("security.clear");
    this.setAttribute("count", "0");
    this.removeAttribute("attention");
    await this._refreshPanel();
    this._emit("cleared");
  }
}
customElements.define("security-shield", SecurityShield);

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
