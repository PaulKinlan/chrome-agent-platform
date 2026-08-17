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
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>',
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

/** Does this browser support CSS anchor positioning (position-area)? */
function supportsAnchorPositioning() {
  try {
    return typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("position-area", "top span-left");
  } catch {
    return false;
  }
}

/**
 * Position a floating element (a menu / popup) next to an anchor so it never
 * leaves the viewport. Prefers BELOW the anchor, flips ABOVE when there is no
 * room, and clamps horizontally. This is the JS fallback that runs only when
 * native CSS anchor positioning (position-area + position-try-fallbacks) is
 * unavailable; in supporting browsers the CSS wins and this is a no-op.
 */
function placeFloating(anchor, floatEl, { fullWidth = false, minWidth = 0 } = {}) {
  if (!anchor || !floatEl) return;
  const a = anchor.getBoundingClientRect();
  if (!a.width && !a.height) return;
  const margin = 8;
  const w = fullWidth
    ? Math.min(a.width, window.innerWidth - 2 * margin)
    : Math.max(floatEl.offsetWidth || 0, minWidth);
  const h = floatEl.offsetHeight || 160;
  const below = a.bottom + 4;
  const above = a.top - h - 4;
  const fitsBelow = below + h <= window.innerHeight - margin;
  const fitsAbove = above >= margin;
  let top = fitsBelow || !fitsAbove ? below : above;
  top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));
  let left = fullWidth ? a.left : Math.min(a.left, window.innerWidth - w - margin);
  left = Math.max(margin, left);
  floatEl.style.position = "fixed";
  floatEl.style.top = `${top}px`;
  floatEl.style.left = `${left}px`;
  floatEl.style.right = "auto";
  floatEl.style.bottom = "auto";
  if (fullWidth) floatEl.style.width = `${w}px`;
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

/** Does the text look like a standalone HTML document (renderable in an iframe)? */
export function isHtmlDocument(text) {
  const s = String(text ?? "").trim();
  if (!s) return false;
  if (/^<!doctype\s+html/i.test(s)) return true;
  if (/^<html(\s|>)/i.test(s)) return true;
  // A bare fragment of block-level HTML (not inline markdown like a single
  // <b> word). Require a closing tag of a structural element.
  if (s[0] === "<" && /<(div|section|article|main|header|footer|table|ul|ol|form|h1|h2|h3|p)\b/i.test(s) && /<\/(div|section|article|main|header|footer|table|ul|ol|form|h1|h2|h3|p)>/i.test(s)) {
    return true;
  }
  return false;
}

/**
 * The child Content-Security-Policy injected into every rendered-HTML frame.
 * It blocks ALL network egress (connect-src 'none' kills fetch/XHR/beacon/
 * WebSocket/EventSource; default-src 'none' + img-src data: blob: kills remote
 * image/font/object/media/frame loads; form-action + base-uri are closed) while
 * still allowing inline scripts + styles so a generated UI can be interactive.
 * A script inside the frame therefore cannot exfiltrate data over the network
 * or load remote content — the double-iframe sandbox holds.
 */
export const HTML_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; " +
  "object-src 'none'; frame-src 'none'; media-src data: blob:; font-src data:;";

/**
 * A navigation guard injected FIRST (before any attacker content) into a
 * generated-UI frame. The CSP blocks NETWORK loads, but it cannot stop the
 * frame navigating ITSELF (self-location / window.open / link + form
 * navigation) — a sandboxed iframe with allow-scripts can navigate its own
 * browsing context. This guard neutralizes the navigation vectors:
 * window.open, location.assign/replace, link clicks, form submits, and a
 * best-effort location-href shadow. (The location.href setter is not fully
 * overridable — that residual is closed by the parent intercepting the frame's
 * navigation requests; see the security suite.)
 */
export function navigationGuardScript() {
  return `<script data-cap-navguard>${[
    "(function(){",
    "try{window.open=function(){return null;};}catch(e){}",
    "try{if(window.location){window.location.assign=function(){};window.location.replace=function(){};}}catch(e){}",
    // Best-effort: shadow window.location with a non-navigating object.
    "try{var L=window.location;Object.defineProperty(window,'location',{configurable:false,get:function(){return L;},set:function(){}});}catch(e){}",
    "function block(e){e.preventDefault();e.stopPropagation();}",
    "document.addEventListener('click',function(e){var t=e.target;var a=t&&t.closest?t.closest('a[href],area[href]'):null;if(a)block(e);},true);",
    "document.addEventListener('submit',block,true);",
    "})();"].join("")}</script>`;
}

/** Strip the navigation/meta vectors a CSP cannot block (meta-refresh). */
export function stripNavigationMeta(html) {
  return String(html ?? "").replace(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*>/gi, "");
}

/**
 * Inject the CSP <meta> + the navigation guard as early as possible into an
 * untrusted HTML document — PREPENDED before ANY content (never after <head>,
 * so no remote load or navigation can precede them). Returns the guarded HTML.
 */
export function injectCspMeta(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_FRAME_CSP}">`;
  const s = stripNavigationMeta(String(html ?? ""));
  // ALWAYS prepend the guard + the CSP before any content (the prior
  // insert-after-<head> let an <img>/<script> before the <head> load first).
  return navigationGuardScript() + meta + s;
}

/**
 * The preference-percolation down-channel for a rendered-HTML frame. The
 * generated UI is an UNTRUSTED layer: it never reads the user's settings
 * directly; the trusted surface posts a minimal, validated projection (theme +
 * locale only) into the frame over postMessage, gated by a one-time nonce (the
 * canonical schema lives in lib/preference-bridge.js; this is the self-contained
 * browser-side mirror so components.js stays import-free for the showcase).
 */
export const FRAME_PREFERENCE_TYPE = "cap:preference";
export const FRAME_PREFERENCE_READY = "cap:preference-ready";

/** A fresh, unguessable one-time token for the frame handshake. */
export function generateNonce() {
  const b = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** The bootstrapping script injected into a generated document. It (a) announces
 * readiness to the parent, and (b) applies a parent-validated theme/locale. It
 * re-checks the nonce + the source (parent only) so a sibling frame cannot forge
 * a preference. It has no network access (the CSP) + no parent-DOM access (the
 * sandbox), so it is a confined, one-way receiver.
 */
export function preferenceBootstrapScript(nonce) {
  const n = JSON.stringify(String(nonce ?? ""));
  return `<script data-cap-bootstrap>${[
    "(function(){var nonce=" + n + ";",
    "function apply(p){if(!p)return;",
    "if(p.theme){try{document.documentElement.setAttribute('data-theme',p.theme);}catch(e){}}",
    "if(p.locale){try{document.documentElement.setAttribute('lang',p.locale);}catch(e){}}",
    "try{document.documentElement.setAttribute('data-cap-themed','1');}catch(e){}",
    "try{document.dispatchEvent(new CustomEvent('cap:themed',{detail:p}));}catch(e){}}",
    "window.addEventListener('message',function(e){if(e.source!==window.parent)return;",
    "var d=e.data;if(d&&d.type==='cap:preference'&&d.nonce===nonce)apply(d.preference);});",
    "try{window.parent.postMessage({type:'cap:preference-ready',nonce:nonce},'*');}catch(e){}",
    "})();"].join("")}</script>`;
}

/**
 * Inject the CSP <meta> + the preference bootstrap as early as possible.
 */
export function injectFrameGuards(html, nonce) {
  // injectCspMeta already PREPENDS the navigation guard + the CSP before any
  // content. Prepend the preference bootstrap too (after the guard/CSP, before
  // the attacker content) — never after a <head>.
  const guarded = injectCspMeta(html);
  const s = String(guarded ?? "");
  // The nav guard + CSP are at the very start; insert the bootstrap after them
  // (still before the attacker content).
  const navGuard = navigationGuardScript();
  if (s.startsWith(navGuard)) {
    const rest = s.slice(navGuard.length);
    const m = rest.match(/^<meta[^>]*Content-Security-Policy[^>]*>/i);
    if (m) return navGuard + m[0] + preferenceBootstrapScript(nonce) + rest.slice(m[0].length);
  }
  return preferenceBootstrapScript(nonce) + s;
}

/**
 * Render untrusted HTML output in a SANDBOXED iframe (the co-do double-iframe
 * pattern: this trusted extension surface is the OUTER frame; the model's HTML
 * runs in an INNER opaque-sandbox iframe with no access to the extension origin
 * and no top-navigation/forms/popups).
 *
 * sandbox="allow-scripts" keeps the frame an opaque origin: it cannot read
 * parent.document, navigate top, or open popups. The injected CSP (above) then
 * closes the network egress that a prompt-injected script would otherwise use
 * to exfiltrate. Scripts may run (the UI can be interactive) but they are
 * confined to the frame + cannot reach the network or the extension.
 *
 * The generated UI is also THEMED via the preference-percolation: the frame
 * carries a one-time nonce + a bootstrap that applies the parent's theme/locale.
 */
export function renderHtmlFrame(html, { nonce } = {}) {
  const n = nonce ?? generateNonce();
  return `<div class="html-frame" data-frame-nonce="${n}"><iframe title="Rendered HTML output" sandbox="allow-scripts" srcdoc="${escapeHtml(injectFrameGuards(html, n))}"></iframe></div>`;
}

/**
 * Wire the preference-percolation DOWN-channel into a rendered-HTML frame.
 * When the frame announces readiness (or on its load event), the trusted
 * surface posts the minimal { theme, locale } projection with the nonce. Returns
 * a cleanup function. Pure + dependency-free.
 */
export function wireHtmlFramePreference(container, { nonce, theme, locale } = {}) {
  const iframe = (container && (container.matches?.("iframe") ? container : container.querySelector?.("iframe"))) || null;
  if (!iframe) return () => {};
  const n = nonce ?? (container?.closest?.(".html-frame")?.dataset?.frameNonce) ?? (iframe.closest?.(".html-frame")?.dataset?.frameNonce) ?? "";
  if (!n) return () => {};
  const pref = { ...(typeof theme === "string" && theme ? { theme } : {}), ...(typeof locale === "string" && locale ? { locale } : {}) };
  let done = false;
  const post = () => {
    if (done) return;
    try { iframe.contentWindow?.postMessage({ type: FRAME_PREFERENCE_TYPE, nonce: n, preference: pref }, "*"); } catch { /* frame may not be ready */ }
  };
  const onMsg = (e) => {
    const d = e.data;
    if (d && d.type === FRAME_PREFERENCE_READY && d.nonce === n && e.source === iframe.contentWindow) {
      done = true;
      post();
    }
  };
  const onLoad = () => { post(); };
  window.addEventListener("message", onMsg);
  iframe.addEventListener("load", onLoad);
  // The frame may already be loaded (srcdoc resolves fast) — try once now.
  setTimeout(post, 0);
  return () => {
    window.removeEventListener("message", onMsg);
    iframe.removeEventListener("load", onLoad);
  };
}

/** The current theme + locale to percolate into a generated UI (host-document
 * state, set by apply-theme.js). */
export function currentFramePreference() {
  return {
    theme: document.documentElement?.dataset?.theme || "sunlit",
    locale: document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : undefined) || "",
  };
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
        border:1px solid var(--border, #333); color:var(--text, #eee); border-radius:var(--radius-sm,6px);
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
  disconnectedCallback() {
    // The wider-goal review's finding: the base disconnect handler removed only
    // document listeners, while `onend` restarted recognition whenever
    // `_listening` was true — so removing/re-rendering a listening mic kept the
    // microphone active. Tear down recognition + state on disconnect.
    this._listening = false;
    if (this._recognition) {
      try {
        this._recognition.onresult = null;
        this._recognition.onerror = null;
        this._recognition.onend = null;
        this._recognition.abort?.();
      } catch { /* ignore */ }
      this._recognition = null;
    }
    super.disconnectedCallback?.();
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
        border:1px solid var(--border,#e3e0d9); color:var(--text,#1d1b18); border-radius:var(--radius-sm,6px);
        padding:0; cursor:pointer; font:inherit; line-height:1; anchor-name:--attach-anchor; }
      .plus svg { display:block; }
      .plus:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      /* Item 52: the menu anchors to the + button and flips above/below it.
         block-start span-inline-end = place it above the button, aligned to the
         button's end edge; flip-block moves it BELOW when there is no room above
         (the + button sits at the bottom of the composer, so "above" is the
         common case, but a thread with a tall conversation must not push it
         off-screen). The popover is top-layer, so opening it never scrolls the
         main frame (the conversation scroll container is untouched). */
      .menu { position:absolute; inset:auto; margin:0; background:var(--panel,#ffffff);
        border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-md,12px); box-shadow:0 8px 24px rgba(0,0,0,.25);
        padding:4px; min-width:200px; z-index:20;
        position-anchor:--attach-anchor; position-area:block-start span-inline-end;
        position-try-fallbacks:flip-block, flip-inline; }
      @supports not (position-area: top) {
        .menu { position:fixed; bottom:auto; left:auto; }
      }
      .menu[hidden] { display:none; }
      .menu button { display:block; width:100%; text-align:left; background:transparent; border:0;
        color:var(--text,#1d1b18); padding:8px 12px; border-radius:var(--radius-sm,6px); cursor:pointer; font:inherit; }
      .menu button:hover, .menu button:focus-visible { background:var(--bg,#12121c); outline:none; }
      .note { font-size:var(--text-xs,12px); color:var(--muted,#635e56); margin:6px 0 2px; max-width:220px; }
    `, `<button part="button" class="plus" type="button" aria-haspopup="menu"
        aria-expanded="${open}" aria-label="${escapeHtml(label)}">${ICONS.plus}</button>
      <div class="menu" role="menu" aria-label="${escapeHtml(label)}" popover="manual"${open ? "" : " hidden"}>
        <button type="button" role="menuitem" data-kind="file">Add file</button>
        <button type="button" role="menuitem" data-kind="record-audio">Record audio</button>
        <button type="button" role="menuitem" data-kind="capture-camera">Capture camera</button>
        <button type="button" role="menuitem" data-kind="record-screen">Record screen</button>
        <button type="button" role="menuitem" data-kind="grab-screenshot">Grab screenshot</button>
        <button type="button" role="menuitem" data-kind="add-tab">Add tab</button>
        <p class="note">Text files are read by the agent. Audio, camera, and image attachments are sent to the model as data (multimodal where the provider supports it).</p>
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
      if (kind === "record-screen" || kind === "grab-screenshot" ||
          kind === "add-tab") {
        // Browser-context actions (the + menu's screen-recording / screenshot /
        // tab-picker options) — emitted for the host composer/page to wire (they
        // need the OPTIONAL browser permissions, which the page requests/handles
        // with a graceful error).
        this._emit("attach-context", { kind });
        return;
      }
      const file = await this._pickFile(kind);
      if (!file) return;
      if (file.overLimit) {
        // Rejected at select time (the client-side bound): surface a clear
        // status instead of attaching an over-budget file.
        this._emit("attach-error", { message: `${file.name} is over the 8 MiB limit` });
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
        // CLIENT-SIDE bound BEFORE the eager FileReader read (the wider-goal
        // review's transport finding: the dataURL crossed runtime messaging
        // before the SW bound could protect anything, so a large selected file
        // could allocate + base64 + exceed the message limit first). Reject an
        // over-budget file at select time — never materialize it.
        const MAX_RAW_BYTES = 8 * 1024 * 1024; // 8 MiB raw (~10.7 MiB dataURL)
        if (file.size > MAX_RAW_BYTES) {
          resolve({ name: file.name, size: file.size, type: file.type, kind, file, dataURL: "", overLimit: true });
          return;
        }
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

/* <switch-toggle checked label> — the ONE canonical switch (track + knob).
 * Every toggle across the app (capability rows, settings multi-agent /
 * browser-control / background-agents / hooks) uses THIS component so the
 * geometry + behavior are identical by construction. Self-managing: a click
 * toggles its own `checked` attribute + emits `toggle { checked }`; a parent
 * can still drive it by setting/removing `checked`. */
class SwitchToggle extends Component {
  static get observedAttributes() { return ["checked", "label"]; }
  _render() {
    const checked = this.hasAttribute("checked");
    const label = this.getAttribute("label") || "Toggle";
    mountTemplate(this, `
      :host { display:inline-flex; flex:0 0 auto; }
      .sw { position:relative; width:36px; height:20px; border-radius:999px;
        border:1px solid var(--border,#e3e0d9); background:var(--panel,#ffffff); cursor:pointer;
        padding:0; flex:0 0 auto; transition:background 150ms ease, border-color 150ms ease; }
      .sw::after { content:""; position:absolute; top:2px; left:2px; width:14px; height:14px;
        border-radius:50%; background:var(--muted,#635e56); transition:transform 150ms ease, background 150ms ease; }
      .sw[aria-pressed="true"] { background:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); }
      .sw[aria-pressed="true"]::after { transform:translateX(16px); background:var(--btn-fg,#ffffff); }
      .sw:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @media (prefers-reduced-motion: reduce) { .sw, .sw::after { transition:none; } }
    `, `<button part="switch" class="sw" type="button" role="switch"
        aria-checked="${checked}" aria-pressed="${checked}" aria-label="${escapeHtml(label)}"></button>`);
    this._btn = this._root.querySelector(".sw");
  }
  _wire() {
    this._btn?.addEventListener("click", () => {
      this.toggleAttribute("checked");
      this._emit("toggle", { checked: this.hasAttribute("checked") });
    });
  }
  get checked() { return this.hasAttribute("checked"); }
  set checked(v) { v ? this.setAttribute("checked", "") : this.removeAttribute("checked"); }
}
customElements.define("switch-toggle", SwitchToggle);

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
    // "open" = the WHOLE row is clickable (an agent → open its chat/view) with a
    // chevron affordance instead of a "Run" button; "toggle" = an enable/disable
    // switch; "open-toggle" = BOTH (a chevron to open the agent's view AND a
    // switch to enable/disable) — for background agents (item 61: they are
    // independent, clickable AND enableable); "run" = a small Run button.
    const actionHtml = action === "toggle"
      ? `<switch-toggle part="toggle"${enabled ? " checked" : ""}
          label="${enabled ? "Disable" : "Enable"} ${escapeHtml(name)} in the background"></switch-toggle>`
      : action === "open"
        ? `<button part="open" class="open" type="button" aria-label="Open ${escapeHtml(name)}">${ICONS.chevron}</button>`
        : action === "open-toggle"
          ? `<button part="open" class="open" type="button" aria-label="Open ${escapeHtml(name)}">${ICONS.chevron}</button>
             <switch-toggle part="toggle"${enabled ? " checked" : ""}
              label="${enabled ? "Disable" : "Enable"} ${escapeHtml(name)}"></switch-toggle>`
          : action === "use"
            ? `<button part="use" class="run" type="button">Use</button>`
            : `<button part="run" class="run" type="button">Run</button>`;
    const rowAttrs = action === "open"
      ? ` part="row" class="row clickable" role="button" tabindex="0" aria-label="Open ${escapeHtml(name)}"`
      : ` part="row" class="row"`;
    mountTemplate(this, `
      :host { display:block; }
      .row { display:grid; grid-template-columns:28px 1fr auto; gap:12px; align-items:center;
        padding:12px 14px; border-bottom:1px solid var(--border,#30363d); background:transparent; }
      .row:last-child { border-bottom:0; }
      .row.clickable { cursor:pointer; border-radius:8px; }
      .row.clickable:hover { background:var(--bg,#12121c); }
      .row.clickable:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
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
      .open { justify-self:end; display:inline-flex; align-items:center; justify-content:center;
        width:28px; height:28px; border:0; background:transparent; color:var(--muted,#8b949e);
        cursor:pointer; border-radius:6px; }
      .open:hover, .open:focus-visible { color:var(--accent,#0e6e63); outline:none; }
      .open svg { width:16px; height:16px; display:block; }
      .meta { display:flex; align-items:center; gap:6px; }
    `, `<div${rowAttrs}>
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
    const use = this._root.querySelector("[part=use]");
    use?.addEventListener("click", () => this._emit("use"));
    const open = this._root.querySelector(".open");
    open?.addEventListener("click", (e) => { e.stopPropagation(); this._emit("open"); });
    // The whole row is clickable for the "open" action (an agent → open its
    // chat), matching the keyboard affordance (role=button + tabindex).
    const row = this._root.querySelector(".row.clickable");
    if (row) {
      row.addEventListener("click", () => this._emit("open"));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._emit("open"); }
      });
    }
    this._root.querySelector("switch-toggle")?.addEventListener("toggle", (e) => {
      this._emit("toggle", { enabled: e.detail.checked });
    });
  }
}
customElements.define("capability-row", CapabilityRow);

/* <artifact-card id name type size origin time> — an artifact card for the
 * gallery: a LIVE preview thumbnail (an html artifact renders in a sandboxed
 * iframe, an image renders inline, text/data renders as a truncated preview),
 * the name + type/size + source origin + time, and actions (open / reuse /
 * delete). The preview CONTENT is set via the `preview` property (not an
 * attribute — content is large); the card renders a placeholder until it is
 * set. Emits open / reuse / delete. */
class ArtifactCard extends Component {
  static get observedAttributes() {
    return ["id", "name", "type", "size", "origin", "time"];
  }
  set preview(v) {
    this._preview = v ?? "";
    if (this._rendered) this._render();
  }
  get preview() { return this._preview ?? ""; }
  _render() {
    const id = this.getAttribute("id") || "";
    const name = this.getAttribute("name") || "Untitled";
    const type = this.getAttribute("type") || "data";
    const size = this.getAttribute("size") || "0";
    const origin = this.getAttribute("origin") || "master";
    const time = this.getAttribute("time") || "";
    const hasPreview = this._preview != null && this._preview !== "";
    let previewHtml = "";
    if (hasPreview) {
      if (type === "html") {
        previewHtml = renderHtmlFrame(this._preview);
      } else if (type === "image") {
        previewHtml = `<img class="img" src="${escapeHtml(this._preview)}" alt="">`;
      } else {
        const text = String(this._preview ?? "").slice(0, 400);
        previewHtml = `<pre class="text">${escapeHtml(text)}</pre>`;
      }
    } else {
      previewHtml = `<div class="placeholder"><span class="picon">${ICONS.image}</span><span>${escapeHtml(type)}</span></div>`;
    }
    const t = time ? new Date(Number(time) || time).toLocaleString() : "";
    mountTemplate(this, `
      :host { display:block; }
      .card { display:flex; flex-direction:column; background:var(--panel,#ffffff);
        border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-md,12px);
        overflow:hidden; box-shadow:var(--shadow-1, 0 1px 2px rgba(29,27,24,.05)); }
      .preview { position:relative; height:132px; background:var(--panel-2,#efede8);
        overflow:hidden; border-bottom:1px solid var(--border,#e3e0d9); cursor:pointer; }
      .preview .html-frame, .preview .html-frame iframe { width:100%; height:100%; }
      .preview .html-frame iframe { border:0; pointer-events:none; transform:scale(1); transform-origin:top left; }
      .img { width:100%; height:100%; object-fit:cover; display:block; }
      .text { margin:0; padding:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
        font-size:11px; line-height:1.4; color:var(--muted,#635e56); white-space:pre-wrap;
        word-break:break-word; overflow:hidden; }
      .placeholder { height:100%; display:flex; flex-direction:column; gap:6px;
        align-items:center; justify-content:center; color:var(--muted,#635e56);
        font-size:12px; text-transform:capitalize; }
      .placeholder .picon { display:inline-flex; color:var(--accent,#0e6e63); }
      .placeholder .picon svg { width:24px; height:24px; }
      .body { padding:10px 12px; display:flex; flex-direction:column; gap:2px; min-width:0; }
      .name { font-weight:600; font-size:var(--text-sm,13px); color:var(--text,#1d1b18);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .meta { font-size:var(--text-xs,12px); color:var(--muted,#635e56);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .actions { display:flex; gap:6px; padding:0 12px 10px; }
      .actions button { flex:1; display:inline-flex; align-items:center; justify-content:center;
        gap:5px; font:inherit; font-size:var(--text-xs,12px); padding:5px 6px;
        border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,6px);
        background:transparent; color:var(--text,#1d1b18); cursor:pointer; }
      .actions button:hover { border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      .actions button.danger:hover { border-color:var(--danger,#b3261e); color:var(--danger,#b3261e); }
      .actions button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
      .actions button svg { width:14px; height:14px; }
    `, `<div class="card">
      <div class="preview" part="preview" role="button" tabindex="0" aria-label="Open ${escapeHtml(name)}">${previewHtml}</div>
      <div class="body">
        <span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="meta">${escapeHtml(type)} · ${escapeHtml(size)} B · ${escapeHtml(origin)}${t ? " · " + escapeHtml(t) : ""}</span>
      </div>
      <div class="actions">
        <button type="button" data-act="reuse">${ICONS.attach}<span>Reuse</span></button>
        <button type="button" data-act="delete" class="danger">${ICONS.close}<span>Delete</span></button>
      </div>
    </div>`);
  }
  _wire() {
    const detail = () => ({
      id: this.getAttribute("id") || "",
      name: this.getAttribute("name") || "Untitled",
      type: this.getAttribute("type") || "data",
      origin: this.getAttribute("origin") || "master",
    });
    this._root.querySelector(".preview")?.addEventListener("click", () => this._emit("open", detail()));
    this._root.querySelector(".preview")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._emit("open", detail()); }
    });
    this._root.querySelector('[data-act="reuse"]')?.addEventListener("click", () => this._emit("reuse", detail()));
    this._root.querySelector('[data-act="delete"]')?.addEventListener("click", () => this._emit("delete", detail()));
  }
}
customElements.define("artifact-card", ArtifactCard);

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
    return ["role", "content", "tool-name", "tool-status", "tool-args", "tool-result", "tool-detail", "step", "total-steps", "error-reason", "error-action"];
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
      .err-reason { font-weight:600; margin:0 0 4px; }
      .err-action { color:var(--ink,#1d1b18); margin:0; }
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
      /* rendered HTML output — the sandboxed iframe */
      .html-frame { margin-top:4px; }
      .html-frame iframe { width:100%; min-height:220px; max-height:480px; border:1px solid var(--border,#e3e0d9); border-radius:8px; background:#fff; resize:vertical; display:block; }
      .genui { width:100%; }
      .genui-head { font-size:12px; font-weight:600; color:var(--muted,#635e56); margin:0 0 6px; }
      .genui .html-frame iframe { max-height:520px; }
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
      .tool .tool-detail { padding:0 10px 6px; border-top:1px solid var(--border,#e3e0d9); }
      .tool .tool-detail summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:6px; color:var(--muted,#635e56); font-size:11.5px; padding:4px 0 0; user-select:none; }
      .tool .tool-detail summary::-webkit-details-marker { display:none; }
      .tool .tool-detail summary:hover { color:var(--text,#1d1b18); }
      .tool .tool-detail .tool-detail-raw { margin-top:4px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11.5px; color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; max-height:180px; overflow:auto; background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9); border-radius:6px; padding:6px 8px; }
    `;
    let markup;
    if (role === "tool") {
      const name = this.getAttribute("tool-name") || "tool";
      const statusRaw = this.getAttribute("tool-status") || "running";
      const status = statusRaw === "success" ? "done" : statusRaw === "error" ? "error" : "running";
      const args = this.getAttribute("tool-args");
      const result = this.getAttribute("tool-result");
      const detail = this.getAttribute("tool-detail");
      // The generative-UI tools (generate_ui / create_asset with type html)
      // render their HTML LIVE in the sandboxed double-iframe, inline.
      let genHtml = null, genName = null;
      if ((name === "generate_ui" || name === "create_asset" || name === "update_asset") && args != null) {
        try {
          const parsed = JSON.parse(args);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            genName = typeof parsed.name === "string" ? parsed.name : null;
            if (typeof parsed.html === "string") genHtml = parsed.html;
            else if (parsed.type === "html" && typeof parsed.content === "string") genHtml = parsed.content;
          }
        } catch { /* args may be a raw HTML string, handled below */ }
        if (genHtml == null && isHtmlDocument(args)) genHtml = args;
      }
      if (genHtml != null && isHtmlDocument(genHtml)) {
        markup = `<div class="genui" role="status">
          <div class="genui-head">${escapeHtml(genName || "Generated UI")}</div>
          ${renderHtmlFrame(genHtml)}
        </div>`;
      } else {
        markup = `<div class="tool" role="status">
          <div class="tool-head"><span class="tool-name">${escapeHtml(name)}</span><span class="tool-status ${status}">${status === "done" ? "done" : status === "error" ? "error" : "running"}</span></div>
          ${args != null ? `<div class="tool-args">${escapeHtml(args)}</div>` : ""}
          ${result != null ? `<div class="tool-result">${escapeHtml(result)}</div>` : ""}
          ${detail != null ? `<details class="tool-detail"><summary>details</summary><div class="tool-detail-raw">${escapeHtml(detail)}</div></details>` : ""}
        </div>`;
      }
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
    } else if (role === "error") {
      // The comprehensive error: the category + the UNDERLYING reason (danger,
      // prominent) + the actionable "what to do" (plain ink) — never a raw
      // "No output generated. Check the stream for errors".
      const reason = this.getAttribute("error-reason") || content;
      const action = this.getAttribute("error-action") || "";
      markup = `<div class="msg error"><div class="body">
        <p class="err-reason">${escapeHtml(reason)}</p>
        ${action ? `<p class="err-action">${escapeHtml(action)}</p>` : ""}
      </div></div>`;
    } else {
      let body;
      if ((role === "agent" || role === "system") && isHtmlDocument(content)) {
        body = renderHtmlFrame(content);
      } else {
        body = (role === "agent" || role === "system" || role === "user") ? renderMarkdown(content) : `<span class="plain">${renderInline(content)}</span>`;
      }
      markup = `<div class="msg ${role}"><div class="body">${body}</div></div>`;
    }
    mountTemplate(this, style, markup);
  }
  _wire() {
    // Percolate the current theme/locale into any rendered-HTML frame (the
    // co-do generative-UI): wire the validated postMessage down-channel when a
    // message renders a generated UI document.
    if (this._frameCleanups) {
      this._frameCleanups.forEach((c) => { try { c(); } catch { /* noop */ } });
    }
    this._frameCleanups = [];
    const pref = currentFramePreference();
    this.querySelectorAll?.(".html-frame").forEach((frame) => {
      const nonce = frame.dataset?.frameNonce;
      if (nonce) this._frameCleanups.push(wireHtmlFramePreference(frame, { nonce, ...pref }));
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
class AgentConversation extends Component {
  static shadow() { return false; }
  static get observedAttributes() { return ["messages"]; }
  _render() {
    ensureStyle("sc-agent-conversation-style", `
      agent-conversation { display:flex; flex-direction:column; min-height:0; }
      agent-conversation .empty { color:var(--muted,#635e56); font-size:var(--text-sm,13px); padding:2px 0; }
      agent-conversation .ts-gap { align-self:center; margin:10px 0 4px; font-size:var(--text-xs,12px); color:var(--muted,#635e56); letter-spacing:.02em; user-select:none; }
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
    this.appendChild(d);
  }
  appendUser(text, ts) { if (ts) this._maybeTsGap(ts); return this._bubble("user", text); }
  appendAgent(text, ts) { if (ts) this._maybeTsGap(ts); return this._bubble("agent", text); }
  appendSystem(text, ts) { if (ts) this._maybeTsGap(ts); return this._bubble("system", text); }
  appendError(text, { reason, action, ts } = {}) {
    if (ts) this._maybeTsGap(ts);
    return this._bubble("error", text, { "error-reason": reason ?? null, "error-action": action ?? null });
  }
  appendThinking(text, { step, totalSteps } = {}) {
    return this._bubble("thinking", text, { step, "total-steps": totalSteps });
  }
  appendTool(m = {}) {
    // Accept both the imperative {name,args,status,result,detail} and the
    // message object {tool-name,tool-status,tool-args,tool-result,tool-detail}
    // conventions. The CALLER is responsible for passing a readable `result`
    // summary (see lib/tool-summary.js) + the raw `detail` (shown on expand).
    const name = m.name ?? m["tool-name"];
    const status = m.status ?? m["tool-status"];
    const args = m.args ?? m["tool-args"];
    const result = m.result ?? m["tool-result"];
    const detail = m.detail ?? m["tool-detail"];
    return this._bubble("tool", null, {
      "tool-name": name,
      "tool-status": status || "running",
      "tool-args": args != null ? (typeof args === "string" ? args : JSON.stringify(args)) : null,
      "tool-result": result != null ? String(result) : null,
      "tool-detail": detail != null ? String(detail) : null,
    });
  }
  clear() { this.replaceChildren(); this._lastTs = null; }
  setMessages(messages) {
    this.replaceChildren();
    this._lastTs = null;
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
      const ts = typeof m.ts === "number" ? m.ts : null;
      switch (m.role) {
        case "user": this.appendUser(m.content, ts); break;
        case "agent": this.appendAgent(m.content, ts); break;
        case "system": this.appendSystem(m.content, ts); break;
        case "thinking": this.appendThinking(m.content, m); break;
        case "tool": this.appendTool(m); break;
        case "error": this.appendError(m.content, { reason: m.reason ?? null, action: m.action ?? null }); break;
        default: this.appendAgent(m.content, ts); break;
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
      /* Scoped to the host tag (light DOM, shadow()=false): the bare class
         selectors would be document-scope CSS — the same collision mechanism
         as the blank-toggle bug. Tag-scoping keeps the controls in the LIGHT
         DOM (the CDP journeys hit #task-input/#run-task) while the styles only
         apply within THIS component's subtree. */
      agent-composer .composer { position:relative; background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:12px; padding:14px; anchor-name:--composer-anchor; }
      agent-composer .composer:focus-within { border-color:var(--accent,#0e6e63); }
      agent-composer .popup { position:absolute; inset:auto; margin:0; left:0; right:0; background:var(--panel,#ffffff);
        border:1px solid var(--border,#e3e0d9); border-radius:10px; box-shadow:var(--shadow-2, 0 12px 32px rgba(29,27,24,.08));
        max-height:260px; overflow-y:auto; padding:4px; z-index:40;
        position-anchor:--composer-anchor; position-area:bottom span-x-start span-x-end;
        position-try-fallbacks:flip-block; }
      @supports not (position-area: top) {
        agent-composer .popup { position:absolute; top:calc(100% + 4px); left:0; right:0; }
      }
      agent-composer .popup[hidden] { display:none; }
      agent-composer .popup .item { display:flex; align-items:baseline; gap:10px; padding:7px 10px; border-radius:7px; cursor:pointer; }
      agent-composer .popup .item:hover, agent-composer .popup .item[data-active="true"] { background:var(--panel-2,#efede8); }
      agent-composer .popup .item .lbl { font-weight:600; font-size:13px; color:var(--text,#1d1b18); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      agent-composer .popup .item .dsc { flex:1; text-align:right; font-size:11px; color:var(--muted,#635e56); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      agent-composer .popup .empty { padding:8px 10px; font-size:12px; color:var(--muted,#635e56); }
      agent-composer .composer textarea { width:100%; background:transparent; border:0; color:var(--text,#1d1b18); font:inherit; resize:vertical; min-height:44px; outline:none; line-height:1.45; }
      agent-composer .composer .row { display:flex; gap:8px; align-items:center; margin-top:8px; }
      agent-composer .composer .spacer { flex:1; }
      agent-composer .composer .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      agent-composer .composer .chips:empty { display:none; }
      agent-composer .composer .chips .chip { display:inline-flex; align-items:center; gap:6px; font-size:12px;
        color:var(--text,#1d1b18); background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9);
        border-radius:999px; padding:3px 10px; }
      agent-composer .composer .chips .chip button { border:0; background:transparent; color:var(--muted,#635e56);
        cursor:pointer; padding:0; font:inherit; line-height:1; }
      agent-composer .composer .chips .chip button:hover { color:var(--text,#1d1b18); }
      agent-composer .composer .send { display:inline-flex; align-items:center; height:var(--control,36px); padding:0 16px;
        background:var(--accent,#0e6e63); color:var(--btn-fg,#fff); border:0; border-radius:8px;
        font:inherit; font-weight:600; cursor:pointer; }
      agent-composer .composer .send:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      agent-composer > .composer-status { margin-top:8px; font-size:12px; color:var(--muted,#635e56); }
      agent-composer > .composer-status:empty { display:none; }
      /* the recording chip (record-screen / record-audio) — a visible start/stop */
      agent-composer .composer .chips .chip.recording { align-items:center; gap:8px; border-color:var(--accent,#0e6e63); }
      agent-composer .composer .chips .chip.recording .rec-dot { width:8px; height:8px; border-radius:50%; background:var(--accent,#0e6e63); animation:cap-pulse 1.2s ease-in-out infinite; }
      agent-composer .composer .chips .chip.recording button { font-weight:600; color:var(--accent,#0e6e63); }
      @keyframes cap-pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }
      @media (prefers-reduced-motion: reduce) { agent-composer .composer .chips .chip.recording .rec-dot { animation:none; } }
      /* the tab picker (add-tab / grab-screenshot) — a floating list, in-bounds */
      .tab-picker { position:fixed; z-index:60; background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9);
        border-radius:10px; box-shadow:var(--shadow-2, 0 12px 32px rgba(29,27,24,.12)); padding:4px; min-width:300px; max-width:420px; }
      .tab-picker .tp-list { max-height:260px; overflow-y:auto; }
      .tab-picker .tp-row { display:flex; flex-direction:column; gap:2px; width:100%; text-align:left; background:transparent;
        border:0; border-radius:7px; padding:7px 10px; cursor:pointer; font:inherit; color:var(--text,#1d1b18); }
      .tab-picker .tp-row:hover, .tab-picker .tp-row:focus-visible { background:var(--panel-2,#efede8); outline:none; }
      .tab-picker .tp-title { font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .tab-picker .tp-url { font-size:11px; color:var(--muted,#635e56); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .tab-picker .tp-empty { padding:8px 10px; font-size:12px; color:var(--muted,#635e56); }
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
    this._attach?.addEventListener("attach-media", (e) => this._captureMedia(e.detail?.kind));
    this._attach?.addEventListener("attach-context", (e) => this._contextAction(e.detail?.kind));
    this._attach?.addEventListener("attach-error", (e) => this.setStatus(e.detail?.message || "attachment rejected", false));
    this._mic?.addEventListener("mic-error", (e) => this.setStatus(e.detail?.message || "mic error", false));
  }

  // ── the + menu's browser-context actions (record-screen / grab-screenshot /
  // add-tab) — each requests the OPTIONAL browser permission in the SAME user
  // gesture (the menu click) then acts. A missing/denied permission surfaces a
  // clear status (never a silent no-op).

  /** Request optional permissions. MUST be the first await in the action so it
   *  runs inside the menu-click user gesture (a preceding await breaks the
   *  gesture and Chrome auto-denies). */
  async _requestPermission(perms) {
    if (!chrome?.permissions?.request) return true; // no API → treat as available
    try { return (await chrome.permissions.request({ permissions: perms })) === true; }
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
        row.className = "tp-row";
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
      document.body.append(picker); // fixed positioning, never clipped by the composer
      this._tabPicker = picker;
      placeFloating(this._input, picker, { minWidth: 300 });
      document.addEventListener("pointerdown", (e) => {
        if (!picker.contains(e.target)) { this._closeTabPicker(); resolve(null); }
      }, { once: true });
      list.querySelector("button")?.focus();
    });
  }
  _closeTabPicker() {
    if (this._tabPicker) { this._tabPicker.remove(); this._tabPicker = null; }
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
        // grab-screenshot activates + captures the chosen tab. `tabs` grants
        // titles/urls; `activeTab` grants captureVisibleTab for the active tab.
        const perms = kind === "grab-screenshot" ? ["activeTab", "tabs"] : ["tabs"];
        const ok = await this._requestPermission(perms);
        if (!ok) { this.setStatus("tab access not granted — enable the Tabs permission in Settings.", false); return; }
        const tabs = await chrome.tabs.query({}).catch(() => []);
        if (!tabs.length) { this.setStatus("no open tabs to pick from."); return; }
        const tab = await this._pickTab(tabs);
        if (!tab) return; // cancelled
        if (kind === "add-tab") {
          this._attachMedia({ name: tab.title || tab.url || "tab", url: tab.url || "", type: "tab", size: 0, kind: "tab", tabId: tab.id, windowId: tab.windowId });
          this.setStatus(`attached tab: ${tab.title || tab.url}`);
          return;
        }
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
        const dataURL = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        this._attachMedia({ name: `screenshot-${Date.now()}.png`, type: "image/png", size: Math.round((dataURL.length * 3) / 4), dataURL, kind: "image" });
        this.setStatus("attached a screenshot of " + (tab.title || "the tab"));
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

  // ── media capture (record-audio / capture-camera) ──────────────────────
  // A short audio recording / a camera frame becomes a dataURL attachment (the
  // SW bounds it + sends it to the model like any file). The audioCapture /
  // videoCapture permission is requested in the SAME gesture before getUserMedia.
  async _captureMedia(kind) {
    try {
      const perm = kind === "record-audio" ? "audioCapture" : "videoCapture";
      const ok = await this._requestPermission([perm]);
      if (!ok) { this.setStatus(`${perm} permission denied — enable it to capture.`, false); return; }
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
          await new Promise((resolve) => setTimeout(resolve, 400)); // let the frame settle
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
  set value(v) { if (this._input) this._input.value = v; }
  /** Public: attach something (a reused artifact, an external reference) to the
   * composer — pushes it onto the pending attachments + renders a removable
   * chip, exactly like the + menu does. Returns the stored detail. */
  addAttachment(detail) {
    if (!detail) return null;
    const d = {
      name: detail.name ?? "attachment",
      type: detail.type,
      size: detail.size,
      dataURL: detail.dataURL,
      content: detail.content,
      kind: detail.kind ?? "file",
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
    if (this._popup) {
      this._popup.hidden = false;
      if (!supportsAnchorPositioning()) {
        placeFloating(this._root.querySelector(".composer"), this._popup, { fullWidth: true });
      }
    }
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

/* ──────────────────────────────────────────────────────────────────────────
 * BeautifulUI-inspired AI-native primitives
 * Re-implementations of the beautifului.dev patterns (loading state, thinking,
 * streaming text, approval card, tool chips, task rows, chat/prompt bar) as
 * native Web Components — MV3-CSP-safe, matching the DESIGN.md tokens.
 * ────────────────────────────────────────────────────────────────────────── */

/* <loading-state label="Working…" elapsed="3" active> — a pixel-grid loader +
 * elapsed time, the BeautifulUI "Loading State" primitive. A calm, restrained
 * working indicator (not a generic spinner). `active` animates the grid; when
 * absent it shows the static (settled) state. `elapsed` seconds, if present,
 * render as a subtle time readout. */
class LoadingState extends Component {
  static get observedAttributes() { return ["label", "elapsed", "active"]; }
  _render() {
    const label = this.getAttribute("label") || "Working";
    const elapsed = Number(this.getAttribute("elapsed") || 0);
    const active = this.hasAttribute("active");
    // A 3×3 pixel grid; the cells pulse in a reading order (the BeautifulUI
    // pixel-grid loader, calmed to the paper/teal system).
    const cells = Array.from({ length: 9 }, (_, i) =>
      `<span class="px" style="animation-delay:${(i * 60)}ms" aria-hidden="true"></span>`
    ).join("");
    mountTemplate(this, `
      :host { display:inline-flex; align-items:center; gap:10px; }
      .grid { display:grid; grid-template-columns:repeat(3,4px); gap:3px; width:18px; height:18px; }
      .px { width:4px; height:4px; border-radius:1px; background:var(--accent,#0e6e63); }
      :host([active]) .px { animation:cap-px 1.4s ease-in-out infinite; }
      .label { font-size:13px; color:var(--muted,#635e56); }
      .time { font-size:12px; color:var(--muted,#635e56); font-variant-numeric:tabular-nums; opacity:.85; }
      .settled { color:var(--success,#1a7f37); font-weight:600; }
      @keyframes cap-px { 0%,100%{opacity:.25;} 50%{opacity:1;} }
      @media (prefers-reduced-motion: reduce) { :host([active]) .px { animation:none; opacity:.6; } }
    `, `<span class="grid" role="status" aria-label="${escapeHtml(label)}">${cells}</span>
      <span class="label">${escapeHtml(label)}</span>
      ${elapsed > 0 ? `<span class="time">${escapeHtml(String(elapsed))}s</span>` : ""}`);
  }
}
customElements.define("loading-state", LoadingState);

/* <thinking-trace label="reasoning" open steps='[{"label","text"}]'> — an
 * expandable reasoning trace (the BeautifulUI "Thinking" primitive). A muted,
 * collapsible <details> of the agent's steps; slotted content or the `steps`
 * JSON list renders as a clean trace (never a wall of text). */
class ThinkingTrace extends Component {
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

/* <tool-chips tools='[{"name","status"}]'> — the tool calls as compact chips
 * (the BeautifulUI "Tool Chips" primitive). Each chip: the tool name + a status
 * dot (running/done/error). A clean row instead of a full-width card. */
class ToolChips extends Component {
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

/* <task-row name status time> — a live agent-task row (the BeautifulUI "Task
 * Rows" primitive). A status indicator (running spinner / done check / failed
 * cross) + the task name + a time. Emits `open` on activate + `delete` on the
 * affordance. */
class TaskRow extends Component {
  static get observedAttributes() { return ["name", "status", "time", "active"]; }
  _render() {
    const name = this.getAttribute("name") || "Task";
    const status = this.getAttribute("status") || "completed";
    const time = this.getAttribute("time") || "";
    const active = this.hasAttribute("active");
    const indicator = status === "running"
      ? `<span class="ind running" aria-hidden="true"><span class="spin"></span></span>`
      : status === "failed"
        ? `<span class="ind failed" aria-hidden="true">${ICONS.close}</span>`
        : `<span class="ind done" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>`;
    mountTemplate(this, `
      :host { display:block; }
      .row { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid transparent; border-radius:10px; cursor:pointer; }
      .row:hover { background:var(--panel-2,#efede8); }
      :host([active]) .row { border-color:var(--accent,#0e6e63); background:var(--panel,#ffffff); }
      .ind { width:18px; height:18px; border-radius:999px; display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; }
      .ind.done { color:var(--success,#1a7f37); }
      .ind.failed { color:var(--danger,#b3261e); }
      .ind.running { color:var(--muted,#635e56); }
      .spin { width:12px; height:12px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; animation:cap-spin 1s linear infinite; display:inline-block; }
      .name { flex:1; min-width:0; font-size:14px; color:var(--ink,#1d1b18); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .time { flex:0 0 auto; font-size:12px; color:var(--muted,#635e56); font-variant-numeric:tabular-nums; }
      .del { flex:0 0 auto; border:0; background:transparent; color:var(--muted,#635e56); cursor:pointer; padding:2px 4px; font:inherit; font-size:15px; line-height:1; border-radius:6px; }
      .del:hover { color:var(--danger,#b3261e); background:var(--panel-2,#efede8); }
      .del:focus-visible, .row:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @keyframes cap-spin { to { transform:rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spin { animation:none; } }
    `, `<div class="row" role="button" tabindex="0" aria-current="${active ? "true" : "false"}">
        ${indicator}<span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>${time ? `<span class="time">${escapeHtml(time)}</span>` : ""}<button type="button" class="del" aria-label="Delete ${escapeHtml(name)}">×</button></div>`);
  }
  _wire() {
    this._root.querySelector(".row")?.addEventListener("click", () => this._emit("open"));
    this._root.querySelector(".row")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._emit("open"); }
    });
    this._root.querySelector(".del")?.addEventListener("click", (e) => {
      e.stopPropagation(); this._emit("delete");
    });
  }
}
customElements.define("task-row", TaskRow);

/* <streaming-text content sources='[]' actions='[]' streaming> — a streamed answer
 * with inline source chips + follow-up actions (the BeautifulUI "Streaming Text"
 * primitive). A live caret shows while `streaming`; sources + actions are the
 * trusted inline affordances. */
class StreamingText extends Component {
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
      .src { font-size:11px; color:var(--muted,#635e56); border:1px solid var(--border,#e3e0d9); border-radius:999px; padding:2px 8px; }
      .acts { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      .act { border:1px solid var(--border,#e3e0d9); background:var(--panel,#ffffff); color:var(--accent,#0e6e63); border-radius:999px; padding:4px 12px; font:inherit; font-size:12.5px; font-weight:600; cursor:pointer; }
      .act:hover { border-color:var(--accent,#0e6e63); }
      .act:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @keyframes cap-caret { 0%,100%{opacity:1;} 50%{opacity:0;} }
      @media (prefers-reduced-motion: reduce) { :host([streaming]) .body::after { animation:none; opacity:.6; } }
    `, `<div class="body">${renderMarkdown(content)}</div>${sourceChips ? `<div class="srcs">${sourceChips}</div>` : ""}${actionBtns ? `<div class="acts">${actionBtns}</div>` : ""}`);
  }
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

/* <approval-card title body> — a human-in-the-loop approval (the BeautifulUI
 * "Approval Card" primitive). The agent asks before acting; the owner Approves
 * or Denies. Emits `approve` / `deny`. */
class ApprovalCard extends Component {
  static get observedAttributes() { return ["title", "body", "approve-label", "deny-label"]; }
  _render() {
    const title = this.getAttribute("title") || "Approve this action?";
    const body = this.getAttribute("body") || "";
    const approveLabel = this.getAttribute("approve-label") || "Approve";
    const denyLabel = this.getAttribute("deny-label") || "Deny";
    mountTemplate(this, `
      :host { display:block; }
      .card { border:1px solid var(--border,#e3e0d9); border-radius:12px; background:var(--panel,#ffffff); padding:14px 16px; max-width:440px; }
      .title { font-size:14px; font-weight:600; color:var(--ink,#1d1b18); margin:0 0 4px; }
      .body { font-size:13px; color:var(--muted,#635e56); margin:0 0 12px; white-space:pre-wrap; overflow-wrap:anywhere; }
      .actions { display:flex; gap:8px; }
      .approve { border:0; border-radius:8px; padding:7px 16px; background:var(--accent,#0e6e63); color:var(--accent-contrast,#fff); cursor:pointer; font:inherit; font-weight:600; }
      .deny { border:1px solid var(--border,#e3e0d9); border-radius:8px; padding:7px 16px; background:var(--panel,#ffffff); color:var(--ink,#1d1b18); cursor:pointer; font:inherit; }
      .approve:focus-visible, .deny:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
    `, `<div class="card" role="group" aria-label="Approval request">
        <p class="title">${escapeHtml(title)}</p>
        ${body ? `<p class="body">${escapeHtml(body)}</p>` : ""}
        <div class="actions"><button type="button" class="approve">${escapeHtml(approveLabel)}</button><button type="button" class="deny">${escapeHtml(denyLabel)}</button></div>
      </div>`);
  }
  _wire() {
    this._root.querySelector(".approve")?.addEventListener("click", () => this._emit("approve"));
    this._root.querySelector(".deny")?.addEventListener("click", () => this._emit("deny"));
  }
}
customElements.define("approval-card", ApprovalCard);

/* <prompt-bar placeholder model> — the BeautifulUI "Prompt Bar" primitive: a
 * composer with @ sources, / commands, a model picker, and dictation. Composes
 * the atomic mic-button + attach-button + a model picker + the mention/command
 * popups (anchor-positioned, in-bounds). Emits `send`, `model-change`,
 * `mention`, `command`. */
class PromptBar extends Component {
  static get observedAttributes() { return ["placeholder", "model"]; }
  _render() {
    const placeholder = this.getAttribute("placeholder") || "Ask anything, or @mention a site agent…";
    const model = this.getAttribute("model") || "demo";
    mountTemplate(this, `
      :host { display:block; }
      .bar { display:flex; align-items:flex-end; gap:8px; border:1px solid var(--border,#e3e0d9); border-radius:14px; background:var(--panel,#ffffff); padding:8px 10px; }
      .bar:focus-within { border-color:var(--accent,#0e6e63); }
      textarea { flex:1; border:0; background:transparent; resize:none; font:inherit; font-size:14px; line-height:1.5; color:var(--ink,#1d1b18); padding:6px 2px; min-height:24px; max-height:160px; outline:none; }
      textarea::placeholder { color:var(--muted,#635e56); }
      .tools { display:flex; align-items:center; gap:4px; flex:0 0 auto; }
      .model { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--border,#e3e0d9); border-radius:999px; padding:4px 12px; font:inherit; font-size:12px; font-weight:600; color:var(--accent,#0e6e63); cursor:pointer; background:var(--panel,#ffffff); }
      .model:hover { border-color:var(--accent,#0e6e63); }
      .model:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .pop { display:none; position:absolute; z-index:20; background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:10px; box-shadow:0 12px 32px rgba(0,0,0,.15); min-width:220px; max-height:260px; overflow:auto; padding:6px; }
      .pop.open { display:block; }
      .pop button { display:block; width:100%; text-align:left; background:transparent; border:0; border-radius:7px; padding:7px 10px; font:inherit; font-size:13px; color:var(--ink,#1d1b18); cursor:pointer; }
      .pop button:hover, .pop button[aria-selected="true"] { background:var(--panel-2,#efede8); }
      .pop .head { font-size:11px; font-weight:600; text-transform:none; color:var(--muted,#635e56); padding:4px 10px 6px; }
    `, `<div class="bar">
        <textarea id="pb-input" rows="1" placeholder="${escapeHtml(placeholder)}" aria-label="Prompt"></textarea>
        <div class="tools">
          <button type="button" class="model" id="pb-model" aria-haspopup="listbox" aria-expanded="false">${escapeHtml(model)} ▾</button>
          <mic-button label="Dictate" aria-label="Dictate"></mic-button>
          <attach-button label="Attach" aria-label="Attach"></attach-button>
        </div>
        <div class="pop" id="pb-pop" role="listbox" aria-label="Suggestions"></div>
      </div>`);
  }
  _wire() {
    const ta = this._root.querySelector("#pb-input");
    const pop = this._root.querySelector("#pb-pop");
    const modelBtn = this._root.querySelector("#pb-model");
    // Auto-grow the textarea.
    ta?.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; });
    ta?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this._emit("send", { text: ta.value }); ta.value = ""; ta.style.height = "auto"; }
    });
    // @ sources + / commands: show a small suggestion popup (anchor-positioned,
    // in-bounds). The host wires the real mention/command data; here we surface
    // the events so the extension can populate them.
    ta?.addEventListener("input", () => {
      const v = ta.value;
      const m = v.match(/(?:^|\s)([@/])([\w-]*)$/);
      if (!m) { pop.classList.remove("open"); modelBtn.setAttribute("aria-expanded", "false"); return; }
      const trigger = m[1];
      this._emit(trigger === "@" ? "mention" : "command", { query: m[2] });
      pop.classList.add("open");
      modelBtn.setAttribute("aria-expanded", "true");
      const anchor = ta.getBoundingClientRect();
      pop.style.position = "fixed";
      pop.style.left = Math.max(8, Math.min(anchor.left, window.innerWidth - 228)) + "px";
      pop.style.top = (anchor.top - 8) + "px";
      pop.innerHTML = `<div class="head">${trigger === "@" ? "Mention an agent" : "Commands"}</div>`;
    });
    modelBtn?.addEventListener("click", () => {
      const open = pop.classList.toggle("open");
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
  // (the open() method was removed — it duplicated the get open() getter; use show())
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
// Only ONE panel is open at a time (the error-console + security-shield are
// sibling floating overlays — two open panels stack/overlap the page, so opening
// one closes the others).
const openPanels = new Set();
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
      if (this._open) {
        // The re-render re-mounts the panel with `hidden` (the template default),
        // so re-show it + re-anchor it, or the panel visually closes while
        // _open is still true (the "Clear closes the console" bug — clear() sets
        // the count attribute, which re-renders).
        this._panel.hidden = false;
        this._position();
        this._refreshPanel();
      }
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
        background:transparent; color:var(--muted,#635e56); cursor:pointer; padding:0; anchor-name:--panel-anchor; }
      .trigger:hover { color:var(--text,#1d1b18); border-color:var(--accent,#0e6e63); }
      .trigger[data-attention="true"] { color:${attention ? "var(--warning,#9a6700)" : "var(--muted,#635e56)"}; border-color:${attention ? "var(--warning,#9a6700)" : "var(--border,#e3e0d9)"}; }
      .trigger:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .badge { position:absolute; top:-6px; right:-6px; min-width:17px; height:17px; padding:0 4px;
        border-radius:999px; background:var(--danger,#b3261e); color:#fff; font-size:10px; font-weight:700;
        display:inline-flex; align-items:center; justify-content:center; line-height:1; }
      .panel { position:fixed; z-index:200; width:min(560px, calc(100vw - 24px));
        background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:12px;
        box-shadow:var(--shadow-2, 0 12px 32px rgba(29,27,24,.08)); overflow:hidden; }
      /* Item 28: the transparency panels are anchored to their trigger buttons
         (CSS anchor positioning) so they scroll WITH the button + stay in-bounds
         (position-area + position-try-fallbacks), like every other popover. */
      @supports (position-area: top) {
        .panel { position:absolute; inset:auto; position-anchor:--panel-anchor;
          position-area:bottom span-right; position-try-fallbacks:flip-block, flip-inline; }
      }
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
      .console .lvl-error .msg { color:var(--danger,#b3261e); }
      .console .lvl-warn { border-left-color:var(--warning,#9a6700); } .console .lvl-warn .lv { color:var(--warning,#9a6700); }
      .console .src { flex:0 0 auto; color:var(--muted,#635e56); font-size:10px; opacity:.8; }
      .console .msg { flex:1; word-break:break-word; white-space:pre-wrap; }
      .console .line-copy { flex:0 0 auto; border:0; background:transparent; color:var(--muted,#635e56); cursor:pointer; font-size:11px; padding:0 4px; border-radius:4px; opacity:0; }
      .console .line:hover .line-copy, .console .line-copy:focus-visible { opacity:1; }
      .console .line-copy:hover { color:var(--text,#1d1b18); background:var(--panel-2,#efede8); }
      .shield-body .sect { padding:12px 14px; border-bottom:1px solid var(--border,#e3e0d9); }
      .shield-body .sect:last-child { border-bottom:0; }
      .shield-body .sect-h { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--muted,#635e56); margin-bottom:8px; }
      .shield-body .chips { display:flex; flex-wrap:wrap; gap:6px; }
      .shield-body .chip { font-size:12px; padding:3px 9px; border-radius:999px; border:1px solid var(--border,#e3e0d9); }
      .shield-body .chip.ok { background:var(--on-accent-muted,#d7f0ea); border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); display:inline-flex; align-items:center; gap:6px; }
      .shield-body .chip .chip-revoke { border:0; background:transparent; color:inherit; cursor:pointer; padding:0; display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:50%; }
      .shield-body .chip .chip-revoke:hover { background:rgba(14,110,99,.16); }
      .shield-body .chip .chip-revoke:disabled { opacity:.5; cursor:default; }
      .shield-body .chip .chip-revoke svg { width:11px; height:11px; }
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
    this._panel?.querySelector("[data-copy-all]")?.addEventListener("click", () => this._copyAll());
    // Close on Escape + outside click (light-dismiss, like a native dialog).
    this._bindDocument("keydown", (e) => { if (e.key === "Escape") this._close(); });
    this._bindDocument("pointerdown", (e) => {
      // NOTE: use composedPath().includes(this) — host.contains() does NOT
      // traverse the shadow root, so `this.contains(e.composedPath()[0])` was
      // false for every click INSIDE the panel (the buttons live in the shadow
      // DOM). That made any panel-button click (copy / copy-all / clear)
      // register as an outside click + close the panel instead of acting.
      if (this._open && !e.composedPath().includes(this)) this._close();
    });
  }
  _toggle() { this._open ? this._close() : this._openPanel(); }
  async _openPanel() {
    // Close every other open panel first (one floating panel at a time — the
    // close-others logic the vision review requested).
    for (const p of [...openPanels]) {
      if (p !== this) p._close();
    }
    this._open = true;
    openPanels.add(this);
    this._panel.hidden = false;
    this._position();
    this._trigger?.setAttribute("aria-expanded", "true");
    await this._refreshPanel();
  }
  _close() {
    this._open = false;
    openPanels.delete(this);
    this._panel.hidden = true;
    this._trigger?.setAttribute("aria-expanded", "false");
  }
  _position() {
    const r = this._trigger?.getBoundingClientRect?.();
    if (!r) return;
    const panel = this._panel;
    // Always clamp into the viewport (belt-and-suspenders over the native
    // position-area anchor positioning, which does NOT reliably keep a wide
    // panel on-screen when the trigger is near the right edge — item 28's
    // flip-inline fallback missed it and the console popped off-screen). A
    // fixed position + clamped top/left means the panel can never fall outside
    // the viewport, regardless of anchor-positioning support.
    const w = panel.offsetWidth || 560;
    panel.style.position = "fixed";
    panel.style.positionAnchor = "auto";
    panel.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 360)}px`;
    panel.style.left = `${Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12))}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }
  // Subclasses:
  get triggerIcon() { return ""; }
  _panelMarkup() { return ""; }
  async _refreshPanel() {}
  async _clear() {}
  async _copyAll() {}

  /** Copy text to the clipboard with a fallback (headless/file:// safe). */
  async _writeClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to the execCommand path */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand?.("copy");
      ta.remove();
      return ok === true;
    } catch {
      return false;
    }
  }
}
class ErrorConsole extends PanelButton {
  get triggerIcon() { return ICONS.terminal; }
  _panelMarkup() {
    return `
      <div class="phead">
        <span class="t">Console</span>
        <button type="button" data-copy-all>Copy all</button>
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
    this._entries = entries;
    if (!entries.length) {
      body.innerHTML = `<div class="empty">No errors captured. The console shows extension errors, warnings, and unhandled rejections as they happen.</div>`;
      return;
    }
    // Surface ERRORS first (they matter more than the warning noise), newest
    // first within each level, so the real failure text is prominent.
    const rank = { error: 0, warn: 1, info: 2 };
    const ordered = entries.slice().sort((a, b) => {
      const ra = rank[a.level] ?? 3;
      const rb = rank[b.level] ?? 3;
      return ra !== rb ? ra - rb : (b.ts - a.ts);
    });
    body.innerHTML = ordered.map((e) =>
      `<div class="line lvl-${escapeHtml(e.level)}">` +
      `<span class="ts">${escapeHtml(fmtTime(e.ts))}</span>` +
      `<span class="lv">${escapeHtml(e.level)}</span>` +
      `<span class="msg">${escapeHtml(e.message)}</span>` +
      (e.source ? `<span class="src">${escapeHtml(e.source)}</span>` : "") +
      `<button type="button" class="line-copy" data-copy aria-label="Copy this line">Copy</button></div>`
    ).join("");
    body.scrollTop = 0;
    // Delegate the per-line copy (the list is re-rendered on refresh).
    body.onclick = async (ev) => {
      const btn = ev.target.closest?.("[data-copy]");
      if (!btn) return;
      const line = btn.closest(".line");
      const msg = line?.querySelector(".msg")?.textContent || "";
      const lv = line?.querySelector(".lv")?.textContent || "";
      if (await this._writeClipboard(msg)) {
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = "Copy"; }, 1400);
      }
    };
  }
  async _clear() {
    await backend("diagnostics.clear");
    this.setAttribute("count", "0");
    this._entries = [];
    await this._refreshPanel();
    this._emit("cleared");
  }
  async _copyAll() {
    const entries = this._entries || [];
    const text = entries.map((e) =>
      `[${fmtTime(e.ts)}] ${e.level}${e.source ? ` (${e.source})` : ""}: ${e.message}`
    ).join("\n");
    const btn = this._panel?.querySelector("[data-copy-all]");
    if (await this._writeClipboard(text || "")) {
      if (btn) { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy all"; }, 1400); }
    }
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
    // Item 41: each granted permission is REMOVABLE from the panel (not a
    // read-only chip). The remove button calls capability.revoke (the SW's
    // authoritative route, which also does the dependent cleanup) from the
    // click gesture, then re-refreshes.
    const permRows = granted.length
      ? granted.map((p) =>
        `<span class="chip ok" title="granted">${escapeHtml(p)}` +
        `<button type="button" class="chip-revoke" data-revoke="${escapeHtml(p)}" aria-label="Revoke ${escapeHtml(p)}">${ICONS.close}</button></span>`
      ).join("")
      : `<span class="chip muted">none — running with zero permissions</span>`;
    const viol = violations.length
      ? `<ul class="viol">${violations.map((v) =>
        `<li><span class="vkind">${escapeHtml(v.kind)}</span><span class="vmsg">${escapeHtml(v.message)}</span><span class="vts">${escapeHtml(fmtTime(v.ts))}</span></li>`
      ).join("")}</ul>`
      : `<div class="empty">No security violations. Content-Security-Policy violations, denied hooks, blocked actions, and cross-origin attempts would appear here.</div>`;
    body.innerHTML = `
      <div class="sect"><div class="sect-h">Granted permissions</div><div class="chips">${permRows}</div></div>
      <div class="sect"><div class="sect-h">Security events</div>${viol}</div>`;
    // Delegate the revoke (the chips are re-rendered on every refresh).
    body.onclick = async (ev) => {
      const btn = ev.target.closest?.("[data-revoke]");
      if (!btn) return;
      const id = btn.getAttribute("data-revoke");
      btn.disabled = true;
      const res = await backend("capability.revoke", { id });
      if (res?.ok === false && res?.error) {
        this._emit("revoke-error", { id, error: res.error });
      }
      await this._refreshPanel();
    };
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
 * <activity-explorer agent? limit?> — the browsable/searchable activity log
 * (the agent run log ACROSS the system: master + named + background + site
 * agents). Queries activity.list; each row shows the agent (which agent did
 * it), the entry type, the readable text, and the time. Search box + an agent
 * filter; a per-agent view when the `agent` attribute is set. The gallery can
 * seed it with demo entries (no extension backend) via the `entries` property.
 * ────────────────────────────────────────────────────────────────────────── */

function timeAgo(ts) {
  const d = Date.now() - (ts ?? 0);
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Turn a raw tool result into a short readable one-liner (mirrors the SW's
// tool-summary: prefer the {userSummary, modelContent} envelope, then compact).
function activityToolSummary(raw) {
  let v = raw;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        const o = JSON.parse(s);
        if (o && typeof o === "object" && !Array.isArray(o)) {
          if (o.userSummary != null) v = o.userSummary;
          else if (o.modelContent != null) v = o.modelContent;
          else v = o;
        } else {
          v = o;
        }
      } catch {
        v = s;
      }
    } else {
      v = s;
    }
  }
  if (v && typeof v === "object") {
    if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    const agents = Array.isArray(v.agents) ? v.agents : null;
    if (agents) return `${agents.length} agent${agents.length === 1 ? "" : "s"}`;
    return keys.slice(0, 3).map((k) => `${k}: ${shortText(v[k])}`).join(", ");
  }
  return shortText(v);
}
function shortText(v, n = 80) {
  const s = String(v ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// The readable one-liner for a journal entry.
function activityText(e) {
  switch (e?.type) {
    case "task": return e.task || "";
    case "result": return e.result || "";
    case "tool-call": return (e.tool || "tool") + (e.args ? ` ${shortText(e.args, 60)}` : "");
    case "tool-result": return (e.tool || "tool") + " → " + activityToolSummary(e.result);
    case "screenshot": return e.url || "screenshot";
    case "error": return e.error || e.message || "error";
    default: return e?.type || "";
  }
}

class ActivityExplorer extends Component {
  static get observedAttributes() {
    return ["agent", "limit"];
  }
  _render() {
    this._root.innerHTML = `
      <style>
        :host { display:block; }
        .aex { display:flex; flex-direction:column; gap:8px; }
        .aex-toolbar { display:flex; gap:8px; flex-wrap:wrap; }
        .aex-search { flex:1; min-width:140px; padding:7px 10px; font:inherit; font-size:13px;
          color:var(--text,#1d1b18); background:var(--bg,#f7f6f3); border:1px solid var(--border,#e3e0d9);
          border-radius:8px; }
        .aex-agent { max-width:200px; padding:7px 8px; font:inherit; font-size:13px;
          color:var(--text,#1d1b18); background:var(--bg,#f7f6f3); border:1px solid var(--border,#e3e0d9);
          border-radius:8px; appearance:base-select; }
        .aex-list { display:flex; flex-direction:column; max-height:420px; overflow:auto; }
        .aex-row { display:grid; grid-template-columns:auto 1fr auto; gap:8px; align-items:baseline;
          padding:7px 10px; border-bottom:1px solid var(--border,#e3e0d9); }
        .aex-row:last-child { border-bottom:0; }
        .aex-row:hover { background:var(--panel,#ffffff); }
        .aex-agent { font-size:11.5px; font-weight:600; color:var(--accent,#0e6e63); white-space:nowrap;
          max-width:150px; overflow:hidden; text-overflow:ellipsis; }
        .aex-main { min-width:0; }
        .aex-kind { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em;
          color:var(--muted,#635e56); margin-right:6px; }
        .aex-kind.task { color:var(--accent,#0e6e63); }
        .aex-kind.tool-call, .aex-kind.tool-result { color:var(--accent2,#7a5c1d); }
        .aex-kind.error { color:var(--danger,#b3261e); }
        .aex-text { font-size:13px; color:var(--text,#1d1b18); overflow:hidden; text-overflow:ellipsis;
          white-space:nowrap; }
        .aex-ts { font-size:11px; color:var(--muted,#635e56); white-space:nowrap; }
        .aex-empty { padding:12px 10px; font-size:13px; color:var(--muted,#635e56); }
        .aex-count { font-size:11px; color:var(--muted,#635e56); }
      </style>
      <div class="aex">
        <div class="aex-toolbar">
          <input class="aex-search" type="search" placeholder="Search activity…" aria-label="Search activity">
          <select class="aex-agent" aria-label="Filter by agent"></select>
        </div>
        <div class="aex-list" role="log" aria-live="polite"></div>
      </div>`;
  }
  _wire() {
    this._search = this._root.querySelector(".aex-search");
    this._agent = this._root.querySelector(".aex-agent");
    this._list = this._root.querySelector(".aex-list");
    this._entries = this._entries || [];
    this._search.addEventListener("input", () => this._refresh());
    this._agent.addEventListener("change", () => this._refresh());
    this._load();
  }
  // Set demo entries directly (the gallery has no extension backend).
  set entries(v) {
    this._entries = Array.isArray(v) ? v : [];
    this._seeded = true;
    if (this._rendered) this._refresh();
  }
  get entries() {
    return this._entries;
  }
  async _load() {
    // If entries were seeded synchronously (the gallery), never clobber them
    // with the empty backend result (the _load await would race the setter).
    if (!this._seeded) {
      const res = await backend("activity.list", {
        agent: this.getAttribute("agent") || undefined,
        limit: Number(this.getAttribute("limit")) || 200,
      });
      if (!this._seeded) {
        this._entries = Array.isArray(res.entries) ? res.entries : [];
      }
    }
    const seen = new Map();
    for (const e of this._entries) {
      if (!seen.has(e.source)) seen.set(e.source, e.agentLabel || e.source);
    }
    const cur = this._agent.value;
    this._agent.innerHTML = `<option value="">All agents</option>` +
      [...seen].map(([s, label]) => `<option value="${escapeHtml(s)}">${escapeHtml(label)}</option>`).join("");
    if (cur) this._agent.value = cur;
    this._refresh();
  }
  _refresh() {
    if (!this._list) return;
    const q = (this._search?.value || "").trim().toLowerCase();
    const agent = this._agent?.value || "";
    const fixed = this.getAttribute("agent");
    const filtered = (this._entries || []).filter((e) => {
      if (fixed && e.source !== fixed) return false;
      if (agent && e.source !== agent) return false;
      if (q) {
        const hay = [e.agentLabel, e.type, e.task, e.result, e.tool, e.args, e.url, e.source, e.id]
          .map((v) => (v == null ? "" : String(v))).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    this._list.replaceChildren();
    if (!filtered.length) {
      const d = document.createElement("div");
      d.className = "aex-empty";
      d.textContent = "No activity matches.";
      this._list.append(d);
      return;
    }
    for (const e of filtered) {
      const row = document.createElement("div");
      row.className = "aex-row";
      row.title = activityText(e);
      const who = document.createElement("span");
      who.className = "aex-agent";
      who.textContent = e.agentLabel || e.source || "hub";
      const main = document.createElement("span");
      main.className = "aex-main";
      const kind = document.createElement("span");
      kind.className = "aex-kind " + (e.type || "");
      kind.textContent = e.type || "";
      const text = document.createElement("span");
      text.className = "aex-text";
      text.textContent = activityText(e);
      main.append(kind, text);
      const ts = document.createElement("span");
      ts.className = "aex-ts";
      ts.textContent = timeAgo(e.ts);
      row.append(who, main, ts);
      this._list.append(row);
    }
  }
}
customElements.define("activity-explorer", ActivityExplorer);

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
