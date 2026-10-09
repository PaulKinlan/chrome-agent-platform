// shared/components-core.js — Base infrastructure and shared primitives
// for Chrome Agent Platform Web Components.

import { t } from "./i18n.js";
import { cachedRpc } from "./rpc-cache.js";
import { escapeHtml, timeAgo, sleep } from "../lib/pure.js";
import { permissionUserLanguage } from "../lib/permission-language.js";
export { escapeHtml, timeAgo, sleep } from "../lib/pure.js";

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
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  cap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><path d="M2.5 14.5c0-5 3.8-9 8.5-9 4.2 0 7 2.5 7.5 6.5l3.8 1.5c.8.3.8 1.2 0 1.5-2.2.8-5.8 1-7.8 1-2 0-8.5 0-12-1.5z"/><path d="M11 5.5v9"/><path d="M11 5.5c-2.8 1.2-5 4-5.5 9"/><path d="M10 4.5c.5-.7 1.5-.7 2 0"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
};


/* ──────────────────────────────────────────────────────────────────────────
 * Shared helpers
 * ────────────────────────────────────────────────────────────────────────── */
// escapeHtml is SINGLE-SOURCED in lib/pure.js (the strict one — it escapes the
// single quote). Re-exported at top from pure.js.

export function prefersReducedMotion() {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ===
      true;
  } catch {
    return false;
  }
}

/** Does this browser support CSS anchor positioning (position-area)? */
export function supportsAnchorPositioning() {
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
export function placeFloating(
  anchor,
  floatEl,
  { fullWidth = false, minWidth = 0, maxWidth = 0, offsetInline = 0 } = {},
) {
  if (!anchor || !floatEl) return;
  const a = anchor.getBoundingClientRect();
  if (!a.width && !a.height) return;
  const margin = 8;
  const targetW = maxWidth
    ? Math.min(maxWidth, Math.max(minWidth, a.width - offsetInline * 2))
    : fullWidth
    ? Math.min(a.width, window.innerWidth - 2 * margin)
    : Math.max(floatEl.offsetWidth || 0, minWidth);
  const w = Math.min(targetW, window.innerWidth - 2 * margin);
  const h = floatEl.offsetHeight || 160;
  const below = a.bottom + 4;
  const above = a.top - h - 4;
  const fitsBelow = below + h <= window.innerHeight - margin;
  const fitsAbove = above >= margin;
  let top = fitsBelow || !fitsAbove ? below : above;
  top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));
  let left = a.left + offsetInline;
  left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
  floatEl.style.position = "fixed";
  floatEl.style.top = `${top}px`;
  floatEl.style.left = `${left}px`;
  floatEl.style.right = "auto";
  floatEl.style.bottom = "auto";
  if (fullWidth || maxWidth) floatEl.style.width = `${w}px`;
  if (maxWidth) floatEl.style.maxWidth = `${maxWidth}px`;
  const actual = floatEl.getBoundingClientRect();
  if ((actual.width || actual.height) && (Math.abs(actual.top - top) > 1 || Math.abs(actual.left - left) > 1)) {
    floatEl.style.top = `${top - (actual.top - top)}px`;
    floatEl.style.left = `${left - (actual.left - left)}px`;
  }
}

/** Inject a <style> once (idempotent, id-keyed) — used by light-DOM components. */
export function ensureStyle(styleId, css) {
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

export const SITE_ACTIVITY_FOCUS_KEY = "cap:siteActivityFocus";

/** Exact, data-only audit pointer. Malformed or expanded shapes fail closed. */
export function normalizeSiteActivity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let keys;
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    keys = Reflect.ownKeys(value);
  } catch { return null; }
  if (keys.length !== 2 || !keys.includes("origin") || !keys.includes("tool")) return null;
  const originDescriptor = Object.getOwnPropertyDescriptor(value, "origin");
  const toolDescriptor = Object.getOwnPropertyDescriptor(value, "tool");
  if (!originDescriptor?.enumerable || !("value" in originDescriptor) || !toolDescriptor?.enumerable || !("value" in toolDescriptor)) return null;
  const origin = originDescriptor.value;
  const toolName = toolDescriptor.value;
  if (typeof origin !== "string" || origin.length > 240 || typeof toolName !== "string" || !toolName || toolName.length > 128 || visibleSiteActivityLabel(toolName, 128) !== toolName) return null;
  try {
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) return null;
  } catch { return null; }
  return { origin, tool: toolName };
}

export function siteActivityAttribute(value) {
  if (typeof value !== "string" || !value) return null;
  try { return normalizeSiteActivity(JSON.parse(value)); } catch { return null; }
}

export function visibleSiteActivityLabel(value, max = 240) {
  try {
    const label = String(value ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, (char) =>
      `\\u{${char.codePointAt(0).toString(16).toUpperCase()}}`
    );
    if (label.length <= max) return label;
    let clipped = "";
    for (const char of label) {
      if (clipped.length + char.length > max - 1) break;
      clipped += char;
    }
    return `${clipped}…`;
  } catch { return "site tool"; }
}


/* ──────────────────────────────────────────────────────────────────────────
 * Safe markdown renderer (no eval / new Function). Escapes everything FIRST,
 * then transforms a small, safe subset: fenced code blocks, inline code,
 * bold/italic, links, headings, and lists. Anything unrecognized stays literal
 * text. Used by the conversation surface to render agent/system output.
 * ────────────────────────────────────────────────────────────────────────── */

export function renderInline(text) {
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

/**
 * Does a tool RESULT signal failure? The tool card's status attribute is the
 * primary signal; the result envelope is the backup for rows whose status was
 * never propagated (older journal rows, replay). The envelope is double-wrapped
 * ({modelContent:"{\"ok\":true,\"result\":{\"ok\":false,\"error\":…}}"}) — unwrap
 * modelContent/result layers, bounded, and treat ok:false or a non-empty error
 * string at ANY layer as failure. Pure; never throws.
 */
export function toolResultSignalsError(status, result) {
  if (status === "error") return true;
  let cur = result;
  for (let depth = 0; cur != null && depth < 4; depth++) {
    let obj = cur;
    if (typeof cur === "string") {
      const t = cur.trim();
      if (!t.startsWith("{")) return false;
      try { obj = JSON.parse(t); } catch { return false; }
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    if (obj.ok === false) return true;
    if (typeof obj.error === "string" && obj.error !== "") return true;
    // authorizes:false + requiresLiveAuthorization:true is NORMAL metadata on a
    // SUCCESSFUL lazy-tool envelope (lazy-tool-protocol stamps it on every ok:true
    // projection) — it only signals failure when this layer is not ok:true.
    if (obj.requiresLiveAuthorization === true && obj.authorizes === false && obj.ok !== true) return true;
    cur = typeof obj.modelContent === "string" ? obj.modelContent
      : (obj.result && typeof obj.result === "object") ? obj.result
      : (typeof obj.result === "string" ? obj.result : null);
  }
  return false;
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
 * A navigation guard injected FIRST (before any attacker content) into the
 * disposable generated-document frame. It blocks popups and ordinary link /
 * form activation and uses the Navigation API when available. Window.location
 * is intentionally untouched: it is an unforgeable platform object, so trying
 * to redefine it throws and creates a false security boundary. Direct
 * location/self navigation is instead confined to the nested opaque frame by
 * the stable manifest-sandbox host (`sandbox/artifact-preview.html`).
 */
export function navigationGuardScript() {
  return `<script data-cap-navguard>${[
    "(function(){",
    "try{window.open=function(){return null;};}catch(e){}",
    "try{if(window.navigation&&window.navigation.addEventListener){window.navigation.addEventListener('navigate',function(e){if(e.cancelable)e.preventDefault();});}}catch(e){}",
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
 * chrome-agent-platform-np64 (2026-09-03): the runtime teaching guard injected
 * into every generated-document frame. The artifact runs in an origin-opaque
 * allow-scripts-only frame, so the storage/persistence APIs a normal page
 * takes for granted THROW raw SecurityErrors there ('The document is sandboxed
 * and lacks the 'allow-same-origin' flag' — owner report: generated UIs break
 * at runtime and the agent never learns why). This guard redefines the
 * known-broken surfaces so the thrown error TEACHES what to do instead — the
 * exact moment of failure is the teaching moment. Surfaces wrapped (verified
 * against a real allow-scripts frame): window.localStorage / sessionStorage,
 * document.cookie writes, indexedDB, caches, OPFS (navigator.storage.
 * getDirectory), and fetch (the frame CSP connect-src 'none' makes every
 * fetch fail with an opaque 'Failed to fetch'). Permission-gated APIs are not
 * enumerable and stay guidance-only (the constraint text + tool schemas);
 * XHR/EventSource/WebSocket fail under the same CSP and are left to the
 * native TypeError for now (ponytail: add teaching wrappers if artifacts keep
 * using them).
 */
export function sandboxApiGuardScript() {
  return `<script data-cap-sandboxguard>${[
    "(function(){",
    "var fix='keep state in a variable, or store it with the platform\\'s asset/memory tools';",
    "function teach(api,msg){return new Error(api+' is unavailable inside sandboxed artifacts - '+msg);}",
    "function denyStore(host,prop){try{Object.defineProperty(host,prop,{configurable:true,get:function(){throw teach(prop,fix);}});}catch(e){}}",
    "function denyApi(host,prop,methods){try{Object.defineProperty(host,prop,{configurable:true,get:function(){var o={};for(var i=0;i<methods.length;i++){(function(m){o[m]=function(){throw teach(prop+'.'+m,'the frame has no origin-keyed storage - '+fix);};})(methods[i]);}return o;}});}catch(e){}}",
    "denyStore(window,'localStorage');",
    "denyStore(window,'sessionStorage');",
    "denyApi(window,'indexedDB',['open','deleteDatabase']);",
    "denyApi(window,'caches',['open','keys','delete','match','has']);",
    "try{Object.defineProperty(document,'cookie',{configurable:true,get:function(){return '';},set:function(){throw teach('document.cookie','cookies are blocked - '+fix);}});}catch(e){}",
    "try{if(navigator.storage&&navigator.storage.getDirectory){navigator.storage.getDirectory=function(){return Promise.reject(teach('navigator.storage.getDirectory (OPFS)','the frame has no origin-keyed storage - '+fix));};}}catch(e){}",
    "try{window.fetch=function(){return Promise.reject(new Error('fetch is unavailable inside sandboxed artifacts - the frame CSP allows no network egress; ask the agent to fetch the data and embed it in the artifact instead'));};}catch(e){}",
    "})();",
  ].join("")}</script>`;
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
 * readiness to the parent, and (b) applies a parent-validated locale. It
 * re-checks the nonce + the source (parent only) so a sibling frame cannot forge
 * a preference. It has no network access (the CSP) + no parent-DOM access (the
 * sandbox), so it is a confined, one-way receiver.
 */
export function preferenceBootstrapScript(nonce) {
  const n = JSON.stringify(String(nonce ?? ""));
  return `<script data-cap-bootstrap>${[
    "(function(){var nonce=" + n + ";",
    "function apply(p){if(!p)return;var el=document.documentElement,s=el.style;",
    "if(p.locale){try{el.setAttribute('lang',p.locale);}catch(e){}}",
    "if(p.colorScheme){try{el.setAttribute('data-color-scheme',p.colorScheme);if(s)s.colorScheme=p.colorScheme==='system'||p.colorScheme==='no-preference'?'light dark':p.colorScheme;}catch(e){}}",
    "if(typeof p.reduceMotion==='boolean'){try{el.setAttribute('data-reduce-motion',p.reduceMotion?'reduce':'no-preference');}catch(e){}}}",
    "window.addEventListener('message',function(e){if(e.source!==window.parent)return;",
    "var d=e.data;if(d&&d.type==='cap:preference'&&d.nonce===nonce)apply(d.preference);});",
    "try{window.parent.postMessage({type:'cap:preference-ready',nonce:nonce},'*');}catch(e){}",
    "})();"].join("")}</script>`;
}

/**
 * Inject the CSP <meta> + the preference bootstrap as early as possible.
 * @param {string} html
 * @param {string} [nonce]
 * @param {{ thumbnail?: boolean }} [options]
 */
export function injectFrameGuards(html, nonce, { thumbnail = false } = {}) {
  // injectCspMeta already PREPENDS the navigation guard + the CSP before any
  // content. Prepend the preference bootstrap too (after the guard/CSP, before
  // the attacker content) — never after a <head>. The sandbox-constraints
  // guard rides after the bootstrap and before ANY generated code, so every
  // script in the artifact frame throws teaching errors on the unavailable
  // storage/network APIs instead of raw SecurityErrors.
  const guarded = injectCspMeta(html);
  const s = String(guarded ?? "");
  const thumbStyle = thumbnail
    ? '<style data-cap-thumb="1">html,body{overflow:hidden!important;scrollbar-width:none!important;-ms-overflow-style:none!important}::-webkit-scrollbar{display:none!important}</style>'
    : '';
  // The nav guard + CSP are at the very start; insert the bootstrap after them
  // (still before the attacker content).
  const navGuard = navigationGuardScript();
  if (s.startsWith(navGuard)) {
    const rest = s.slice(navGuard.length);
    const m = rest.match(/^<meta[^>]*Content-Security-Policy[^>]*>/i);
    if (m) {
      return navGuard + m[0] + preferenceBootstrapScript(nonce) + thumbStyle + sandboxApiGuardScript() + rest.slice(m[0].length);
    }
  }
  return preferenceBootstrapScript(nonce) + thumbStyle + sandboxApiGuardScript() + s;
}

/**
 * Render untrusted HTML output behind a stable manifest-sandbox host. The
 * trusted extension surface mounts that opaque host; the host then mounts the
 * model's HTML in a second allow-scripts-only opaque iframe with no access to
 * the extension origin and no top-navigation/forms/popups. Direct self/
 * location navigation can replace only that disposable inner document, never
 * the host URL, message relay, or lifecycle boundary.
 *
 * sandbox="allow-scripts" keeps the frame an opaque origin: it cannot read
 * parent.document, navigate top, or open popups. The injected CSP (above) then
 * closes the network egress that a prompt-injected script would otherwise use
 * to exfiltrate. Scripts may run (the UI can be interactive) but they are
 * confined to the frame + cannot reach the network or the extension.
 *
 * The generated UI is also THEMED via the preference-percolation: the frame
 * carries a one-time nonce + a bootstrap that applies the parent's theme/locale.
 * @param {string} html
 * @param {{ nonce?: string, thumbnail?: boolean }} [options]
 */
// The rendered-HTML frame contents are held OUT of the privileged DOM. A
// direct srcdoc child inherits extension_pages script-src 'self' (blocking the
// inline guard/bootstrap and generated scripts), so the string renderer points
// at the manifest-sandboxed stable host. That host creates the disposable
// nested srcdoc frame under the sandbox CSP. The guarded HTML is staged here
// (never serialized into the privileged DOM) and flushed over a nonce-matched
// postMessage by wireHtmlFrameContent after mount.
const frameContents = new Map(); // nonce → guarded HTML string

export function renderHtmlFrame(html, { nonce = "", thumbnail = false } = {}) {
  const n = nonce || generateNonce();
  const previewUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("sandbox/artifact-preview.html")
    : null;
  const extraAttr = thumbnail ? ' scrolling="no"' : '';
  if (!previewUrl) {
    // Non-extension showcase (no sandbox host + no extension_pages CSP): the
    // srcdoc path has no parent CSP to inherit, so the guarded inline scripts
    // run. The extension never reaches this branch.
    return `<div class="html-frame" data-frame-nonce="${n}"><iframe title="Rendered HTML output" sandbox="allow-scripts"${extraAttr} srcdoc="${escapeHtml(injectFrameGuards(html, n, { thumbnail }))}"></iframe></div>`;
  }
  frameContents.set(n, injectFrameGuards(html, n, { thumbnail }));
  return `<div class="html-frame" data-frame-nonce="${n}"><iframe title="Rendered HTML output" sandbox="allow-scripts"${extraAttr} src="${escapeHtml(previewUrl)}"></iframe></div>`;
}

/** Deliver the staged guarded HTML to a rendered frame (post-mount wiring — a
 * string renderer cannot postMessage). Returns a cleanup function. */
export function wireHtmlFrameContent(container, { nonce } = {}) {
  const frame = container?.matches?.(".html-frame") ? container : container?.querySelector?.(".html-frame");
  const iframe = frame?.matches?.("iframe") ? frame : frame?.querySelector?.("iframe");
  const n = nonce ?? frame?.dataset?.frameNonce ?? "";
  const guarded = n ? frameContents.get(n) : null;
  if (!iframe || guarded == null) return () => {};
  let open = true;
  const post = () => {
    if (!open) return;
    try { iframe.contentWindow?.postMessage({ type: "cap:artifact-preview-open", nonce: n, html: guarded }, "*"); } catch { /* frame not ready */ }
  };
  iframe.addEventListener("load", post);
  // The frame may already be loaded (the sandbox host resolves fast) — try once now.
  setTimeout(post, 0);
  return () => {
    open = false;
    iframe.removeEventListener("load", post);
    frameContents.delete(n);
  };
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
  // `done` guards RE-delivery, never the first delivery (r3 review P1): the
  // load/timeout fallbacks below fire while the sandbox host is still inactive
  // and their messages are dropped, so the genuine-ready message is the only
  // reliable delivery point. The guard lives at the CALL SITES (not inside
  // post()): the ready handler sets done and delivers in one step, so the
  // first genuine ready always sends exactly one payload; a second ready or a
  // later load/timeout is suppressed. The fallbacks must never set done —
  // their early messages are dropped by the inactive host, and setting done
  // there would suppress the ready delivery (the original bug, one step later).
  let done = false;
  const post = () => {
    try { iframe.contentWindow?.postMessage({ type: FRAME_PREFERENCE_TYPE, nonce: n, preference: pref }, "*"); } catch { /* frame may not be ready */ }
  };
  const onMsg = (e) => {
    const d = e.data;
    if (d && d.type === FRAME_PREFERENCE_READY && d.nonce === n && e.source === iframe.contentWindow) {
      // Observability for the frame-bootstrap gate (CAP-FB-20260830-GENERATED-UI-
      // BOOTSTRAP-SYNTAX-01): the frame only announces readiness when its injected
      // bootstrap script parsed, so this attribute proves the preference channel
      // is live end to end (the journey asserts it).
      try { container?.setAttribute?.("data-cap-preference", "ready"); } catch { /* best-effort */ }
      if (!done) {
        done = true;
        post();
      }
    }
  };
  const onLoad = () => { if (!done) post(); };
  window.addEventListener("message", onMsg);
  iframe.addEventListener("load", onLoad);
  // The frame may already be loaded (srcdoc resolves fast) — try once now.
  setTimeout(() => { if (!done) post(); }, 0);
  return () => {
    window.removeEventListener("message", onMsg);
    iframe.removeEventListener("load", onLoad);
  };
}

/** The current locale to percolate into a generated UI (host-document state).
 * (Theme switching was removed — the single design system in theme.css stands.) */
export function currentFramePreference() {
  return {
    locale: document.documentElement?.lang || (typeof navigator !== "undefined" ? navigator.language : undefined) || "",
  };
}


export class Component extends HTMLElement {
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
    this._upgradeOwnProperties();
    if (this._rendered) return;
    this._rendered = true;
    this._render();
    this._wire();
  }
  _upgradeOwnProperties() {
    let proto = Object.getPrototypeOf(this);
    while (proto && proto !== Component.prototype && proto !== HTMLElement.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if ((desc?.get || desc?.set) && Object.prototype.hasOwnProperty.call(this, key)) {
          const val = this[key];
          delete this[key];
          if (desc.set) this[key] = val;
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
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

const sheetCache = new Map();

/**
 * Returns a cached constructable CSSStyleSheet for the given cssText,
 * or null if constructable stylesheets are not supported in this runtime.
 */
export function getConstructableSheet(cssText) {
  if (typeof CSSStyleSheet === "undefined" || !("replaceSync" in CSSStyleSheet.prototype)) {
    return null;
  }
  let sheet = sheetCache.get(cssText);
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    sheetCache.set(cssText, sheet);
  }
  return sheet;
}

/**
 * Adopts a constructable stylesheet if supported; otherwise falls back to injecting
 * a <style> element into the shadow root.
 * Returns true if adopted via adoptedStyleSheets, false if fallback path taken.
 */
export function adoptOrInjectStyle(shadowRoot, cssText) {
  if (!shadowRoot || !cssText) return false;
  const sheet = getConstructableSheet(cssText);
  if (sheet && Array.isArray(shadowRoot.adoptedStyleSheets)) {
    if (!shadowRoot.adoptedStyleSheets.includes(sheet)) {
      shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
    }
    return true;
  }
  // Fallback when adoptedStyleSheets is not supported:
  // Inject a <style> element if one isn't already present in this shadow root.
  try {
    const existing = typeof shadowRoot.querySelector === "function" ? shadowRoot.querySelector("style") : null;
    if (!existing) {
      const doc = shadowRoot.ownerDocument || (typeof document !== "undefined" ? document : null);
      if (doc && typeof doc.createElement === "function") {
        const styleEl = doc.createElement("style");
        styleEl.textContent = cssText;
        if (typeof shadowRoot.prepend === "function") {
          shadowRoot.prepend(styleEl);
        } else if (typeof shadowRoot.appendChild === "function") {
          shadowRoot.appendChild(styleEl);
        }
      }
    }
  } catch {
    // Graceful fallback for minimal stubs
  }
  return false;
}

/** Clear the constructable stylesheet cache (for test harnesses). */
export function clearSheetCache() {
  sheetCache.clear();
}

// Build the shadow content: style + markup. Safe (no eval).
export function mountTemplate(host, style, markup) {
  const useShadow = host.constructor.shadow();
  const root = host._root;
  if (useShadow) {
    if (adoptOrInjectStyle(root, style)) {
      root.innerHTML = markup;
    } else {
      // Fallback: when adoptedStyleSheets is not supported, ensure the style is
      // in innerHTML so environments inspecting root.innerHTML or querySelector("style")
      // see the style element reliably.
      root.innerHTML = `<style>${style}</style>${markup}`;
    }
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

// Deferred custom element registration on NTP to eliminate boot long tasks
// (CONSTITUTION §4, bead 9epn.2).
export const NON_HUB_ELEMENTS = new Set([
  "tool-library",
  "system-prompt-editor",
  "activity-explorer",
  "model-picker",
  "webmcp-consent-manager",
  "user-wasm-manager",
  "agent-picker",
  "agent-config-form",
  "agent-template-gallery",
  "agent-template-card",
  "tool-directory-card",
  "artifact-inspector",
  "artifact-diff",
  "table-preview",
  "code-block",
  "agent-dialog",
  "provider-select",
  "agent-nav",
  "error-console",
  "privacy-statement",
  "permission-row",
  "origin-grant-row",
  "capability-row",
  "artifact-card",
  "switch-toggle",
  "prompt-bar",
  "skill-builder",
  "cron-builder",
  "persona-editor",
  "workspace-usage-meter",
  "approval-card",
  "permission-approval-card",
  "plan-strip",
  "screenshot-strip",
  "screenshot-thumb",
  "theme-picker",
  "thinking-trace",
  "tool-chips",
  "loading-state",
  "message-bubble",
  "conversation-run-status",
  "attach-button",
  "mic-button",
  "agent-identity",
  "run-task-button",
]);

export const isNtpPage = typeof location !== "undefined" && typeof location.pathname === "string" && (location.pathname.endsWith("ntp.html") || location.pathname.includes("/ntp/"));
export const deferredComponentRegistry = new Map();
let _rawCustomElementsDefine = null;

if (typeof customElements !== "undefined" && typeof customElements.define === "function" && isNtpPage) {
  _rawCustomElementsDefine = customElements.define.bind(customElements);
  customElements.define = function (tag, constructor, options) {
    if (NON_HUB_ELEMENTS.has(tag)) {
      deferredComponentRegistry.set(tag, { constructor, options });
      return;
    }
    return _rawCustomElementsDefine(tag, constructor, options);
  };

  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const _rawCreateElement = document.createElement.bind(document);
    document.createElement = function (tagName, options) {
      if (typeof tagName === "string") {
        const lower = tagName.toLowerCase();
        if (deferredComponentRegistry.has(lower)) {
          const entry = deferredComponentRegistry.get(lower);
          deferredComponentRegistry.delete(lower);
          const alreadyDefined = typeof customElements?.get === "function" && customElements.get(lower);
          if (!alreadyDefined && _rawCustomElementsDefine) {
            _rawCustomElementsDefine(lower, entry.constructor, entry.options);
          }
        }
      }
      return _rawCreateElement(tagName, options);
    };
  }

  const scheduleDeferredFlush = () => {
    const defineBatch = (deadline) => {
      let count = 0;
      for (const [tag, entry] of Array.from(deferredComponentRegistry.entries())) {
        if ((deadline && typeof deadline.timeRemaining === "function" && deadline.timeRemaining() < 10) || count >= 5) {
          if (typeof requestIdleCallback !== "undefined") {
            requestIdleCallback(defineBatch, { timeout: 3000 });
          } else {
            setTimeout(defineBatch, 50);
          }
          return;
        }
        deferredComponentRegistry.delete(tag);
        if (!customElements.get(tag)) {
          _rawCustomElementsDefine(tag, entry.constructor, entry.options);
        }
        count++;
      }
    };
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(defineBatch, { timeout: 3000 });
    } else {
      setTimeout(defineBatch, 50);
    }
  };

  if (document.readyState === "complete") {
    scheduleDeferredFlush();
  } else {
    window.addEventListener("load", scheduleDeferredFlush, { once: true });
  }
}

export function flushDeferredComponents() {
  const defineFn = _rawCustomElementsDefine || (typeof customElements !== "undefined" ? customElements.define.bind(customElements) : null);
  if (!defineFn) return;
  for (const [tag, entry] of Array.from(deferredComponentRegistry.entries())) {
    deferredComponentRegistry.delete(tag);
    if (!customElements.get(tag)) {
      defineFn(tag, entry.constructor, entry.options);
    }
  }
}


/* <run-task-button label="Run task" loading disabled> */
export class RunTaskButton extends Component {
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


/* <cap-logo size="20"> — the Chrome Agent Platform line-art Cap logo mark. */
export class CapLogo extends Component {
  static get observedAttributes() { return ["size"]; }
  _render() {
    const size = Number(this.getAttribute("size")) || 20;
    mountTemplate(this, `
      :host { display: inline-flex; align-items: center; justify-content: center; line-height: 0; color: var(--accent, #0e6e63); flex-shrink: 0; }
      svg { width: ${size}px; height: ${size}px; display: block; }
    `, `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}" aria-hidden="true"><path d="M2.5 14.5c0-5 3.8-9 8.5-9 4.2 0 7 2.5 7.5 6.5l3.8 1.5c.8.3.8 1.2 0 1.5-2.2.8-5.8 1-7.8 1-2 0-8.5 0-12-1.5z"/><path d="M11 5.5v9"/><path d="M11 5.5c-2.8 1.2-5 4-5.5 9"/><path d="M10 4.5c.5-.7 1.5-.7 2 0"/></svg>`);
  }
}
customElements.define("cap-logo", CapLogo);


/* <empty-state title="Nothing here yet" description="…" action-label="…" action-href="…">
 * The canonical empty state (chrome-agent-platform-716s.7): calm, framed or centered card,
 * owner voice (what can be done next), bounded copy width (~46ch), and an optional primary
 * action button or link. Emits "action" on button click if action-href is not specified. */
export class EmptyState extends Component {
  static get observedAttributes() {
    return ["title", "description", "action-label", "action-href", "action-target"];
  }
  _render() {
    const title = this.getAttribute("title") || "";
    const description = this.getAttribute("description") || "";
    const actionLabel = this.getAttribute("action-label") || "";
    const actionHref = this.getAttribute("action-href") || "";
    const actionTarget = this.getAttribute("action-target") || "";

    mountTemplate(this, `
      :host { display: block; margin: 24px auto; max-width: 48ch; width: 100%; box-sizing: border-box; }
      :host([hidden]) { display: none; }
      .card {
        display: flex; flex-direction: column; align-items: center; text-align: center;
        padding: 32px 24px; border: 1px solid var(--border, #e3e0d9);
        border-radius: var(--radius-md, 12px); background: var(--panel, #fff);
        box-sizing: border-box;
      }
      .title { margin: 0 0 8px; font-size: var(--text-lg, 16px); font-weight: 600; color: var(--text, #1d1b18); }
      .description { margin: 0; font-size: var(--text-sm, 13px); line-height: 1.5; color: var(--muted, #635e56); text-wrap: pretty; }
      .action-row { margin-top: 20px; display: flex; justify-content: center; }
      .btn {
        display: inline-flex; align-items: center; justify-content: center;
        min-height: var(--control, 36px); padding: 0 16px; border-radius: var(--radius-sm, 6px);
        border: 1px solid var(--accent, #0e6e63); background: var(--accent, #0e6e63);
        color: var(--btn-fg, #fff); font: inherit; font-size: var(--text-sm, 13px);
        font-weight: 600; text-decoration: none; cursor: pointer;
        transition: background 150ms ease, border-color 150ms ease;
      }
      .btn:hover { background: var(--accent-hover, #0a564d); border-color: var(--accent-hover, #0a564d); text-decoration: none; }
      .btn:focus-visible { outline: 2px solid var(--accent, #0e6e63); outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
      @media (forced-colors: active) {
        .card, .btn { border: 1px solid CanvasText; forced-color-adjust: auto; }
      }
    `, `<div class="card" role="region" aria-label="${escapeHtml(title || "Empty state")}">
      ${title ? `<h2 class="title">${escapeHtml(title)}</h2>` : ""}
      ${description ? `<p class="description">${escapeHtml(description)}</p>` : ""}
      ${actionLabel ? `
        <div class="action-row">
          ${actionHref
            ? `<a class="btn" href="${escapeHtml(actionHref)}"${actionTarget ? ` target="${escapeHtml(actionTarget)}"` : ""}>${escapeHtml(actionLabel)}</a>`
            : `<button class="btn action-btn" type="button">${escapeHtml(actionLabel)}</button>`
          }
        </div>` : ""
      }
    </div>`);
  }
  _wire() {
    this._root.querySelector("button.action-btn")?.addEventListener("click", (sourceEvent) => {
      this._emit("action", { sourceEvent });
    });
  }
}
customElements.define("empty-state", EmptyState);


/* <switch-toggle checked label> — the ONE canonical switch (track + knob).
 * Every toggle across the app (capability rows, settings multi-agent /
 * browser-control / background-agents / hooks) uses THIS component so the
 * geometry + behavior are identical by construction. Self-managing: a click
 * toggles its own `checked` attribute + emits `toggle { checked }`; a parent
 * can still drive it by setting/removing `checked`. */
export class SwitchToggle extends Component {
  static get observedAttributes() { return ["checked", "label"]; }
  _render() {
    const checked = this.hasAttribute("checked");
    const label = this.getAttribute("label") || "Toggle";
    mountTemplate(this, `
      :host { display:inline-flex; flex:0 0 auto; }
      .sw { position:relative; width:40px; height:24px; min-height:24px; border-radius:999px;
        border:1px solid var(--border,#e3e0d9); background:var(--panel,#ffffff); cursor:pointer;
        padding:0; flex:0 0 auto; transition:background 150ms ease, border-color 150ms ease; }
      .sw::after { content:""; position:absolute; top:2px; left:2px; width:18px; height:18px;
        border-radius:50%; background:var(--muted,#635e56); transition:transform 150ms ease, background 150ms ease; }
      .sw[aria-checked="true"] { background:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); }
      .sw[aria-checked="true"]::after { transform:translateX(16px); background:var(--btn-fg,#ffffff); }
      .sw:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @media (prefers-reduced-motion: reduce) { .sw, .sw::after { transition:none; } }
    `, `<button part="switch" class="sw" type="button" role="switch"
        aria-checked="${checked}" aria-label="${escapeHtml(label)}"></button>`);
    this._btn = this._root.querySelector(".sw");
  }
  _wire() {
    const handle = () => {
      this.toggleAttribute("checked");
      this._emit("toggle", { checked: this.hasAttribute("checked") });
    };
    this._btn?.addEventListener("click", handle);
    this.addEventListener("click", (e) => {
      if (e.target === this) handle();
    });
  }
  get checked() { return this.hasAttribute("checked"); }
  set checked(v) { v ? this.setAttribute("checked", "") : this.removeAttribute("checked"); }
}
customElements.define("switch-toggle", SwitchToggle);


export function summarizeInputSchema(schema) {
  if (!schema || typeof schema !== "object") return "Input schema unavailable";
  const properties = schema.properties && typeof schema.properties === "object"
    ? Object.keys(schema.properties)
    : [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  if (!properties.length) {
    return schema.type === "object" ? "No inputs" : `${String(schema.type || "unknown")} input`;
  }
  const shown = properties.slice(0, 6).map((name) => `${name}${required.has(name) ? " (required)" : ""}`);
  const remainder = properties.length - shown.length;
  return `Inputs: ${shown.join(", ")}${remainder > 0 ? `, +${remainder} more` : ""}`;
}


/* <capability-row name description icon action="run|open|open-delete|use|state" action-state="on" detail detail-label last-run>
 * The reusable capability/skill row. A strict grid — icon (fixed) | label
 * column (name + description STACKED, never run together) | action
 * (right-aligned) — so every capability list is aligned by construction.
 *
 * Settings → Permissions (CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01)
 * uses three further shapes: `action-state="on"` puts the shared <switch-toggle>
 * (checked, labelled with the name) in the action column and re-emits its
 * `toggle { checked }`; `action="state"` shows `action-label` as plain text with
 * NO control ("Always on", "Not available on this platform"); `detail` puts a
 * sentence behind a <details> disclosure under the description (`detail-label`
 * is the summary, default "Details"). */
export class CapabilityRow extends Component {
  static get observedAttributes() {
    return ["name", "description", "icon", "action", "action-label", "action-state", "detail", "detail-label", "last-run"];
  }
  _render() {
    const name = this.getAttribute("name") || "";
    const description = this.getAttribute("description") || "";
    const icon = this.getAttribute("icon") || "";
    const action = this.getAttribute("action") || "run";
    const actionLabel = this.getAttribute("action-label") || "Run";
    const actionState = this.getAttribute("action-state") || "";
    const detail = this.getAttribute("detail") || "";
    const detailLabel = this.getAttribute("detail-label") || "Details";
    const lastRun = this.getAttribute("last-run") || "";
    // "open" = the WHOLE row is clickable (an agent → open its chat/view) with a
    // chevron affordance instead of a "Run" button; "open-delete" = a chevron to
    // open the agent's view AND a destructive Delete button — for background
    // agents (an enabled background agent exists and runs; the owner removes it
    // with Delete, not an enable/disable switch); "run" = a small Run button;
    // action-state="on" = the switch (a granted, revocable capability);
    // "state" = text only (nothing the owner can change from this row).
    const actionHtml = actionState === "on"
      ? `<switch-toggle part="switch" checked label="${escapeHtml(name)}"></switch-toggle>`
      : action === "state"
        ? `<span part="state" class="state">${escapeHtml(actionLabel)}</span>`
        : action === "open-delete"
      ? `<button part="open" class="open" type="button" aria-label="Open ${escapeHtml(name)}">${ICONS.chevron}</button>
         <button part="delete" class="delete" type="button" aria-label="Delete ${escapeHtml(name)}">Delete</button>`
        : action === "use-delete"
      ? `<button part="use" class="run" type="button">Use</button>
         <button part="delete" class="delete" type="button" aria-label="Delete ${escapeHtml(name)}">Delete</button>`
        : action === "run-delete"
      ? `<button part="run" class="run" type="button" aria-label="${escapeHtml(actionLabel)} ${escapeHtml(name)}">${escapeHtml(actionLabel)}</button>
         <button part="delete" class="delete" type="button" aria-label="Delete ${escapeHtml(name)}">Delete</button>`
      : action === "open"
        ? `<button part="open" class="open" type="button" aria-label="Open ${escapeHtml(name)}">${ICONS.chevron}</button>`
        : action === "use"
            ? `<button part="use" class="run" type="button">Use</button>`
            : `<button part="run" class="run" type="button" aria-label="${escapeHtml(actionLabel)} ${escapeHtml(name)}">${escapeHtml(actionLabel)}</button>`;
    const detailHtml = detail
      ? `<details part="detail" class="detail"><summary>${escapeHtml(detailLabel)}</summary><p>${escapeHtml(detail)}</p></details>`
      : "";
    const rowAttrs = action === "open"
      ? ` part="row" class="row clickable" role="button" tabindex="0" aria-label="Open ${escapeHtml(name)}"`
      : ` part="row" class="row"`;
    mountTemplate(this, `
      :host { display:block; }
      .row { display:grid; grid-template-columns:28px 1fr auto; gap:12px; align-items:center;
        padding:12px 14px; border-bottom:1px solid var(--border,#30363d); background:transparent; }
      .row:last-child { border-bottom:0; }
      .row.clickable { cursor:pointer; border-radius:8px; }
      .row.clickable:hover { background:var(--bg,#f7f6f3); }
      .row.clickable:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .icon { display:inline-flex; align-items:center; justify-content:center;
        width:28px; height:28px; color:var(--muted,#8b949e); }
      .icon svg { width:18px; height:18px; display:block; }
      .label { min-width:0; display:flex; flex-direction:column; gap:2px; }
      .name { font-weight:600; font-size:var(--text-sm,13px); color:var(--text,#e6edf3); }
      /* A row is a scannable list line, not a place to print a paragraph. An
         agent role can be hundreds of characters; unclamped it grew the row to
         five lines and wrecked the list. Clamp to two lines and keep the FULL
         text in the DOM — screen readers still get all of it, and the title
         below reveals it on hover — rather than truncating the string, which
         would throw the rest away. */
      .desc { font-size:var(--text-xs,12px); color:var(--muted,#8b949e); line-height:1.35;
        display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2;
        overflow:hidden; overflow-wrap:anywhere; }
      .lastrun { font-size:var(--text-xs,12px); color:var(--muted,#8b949e); }
      .run { justify-self:end; font-size:var(--text-xs,12px); color:var(--muted,#8b949e);
        border:1px solid var(--border,#30363d); border-radius:var(--radius-sm,6px);
        padding:4px 12px; background:transparent; cursor:pointer; font:inherit;
        white-space:nowrap; min-height:32px; }
      .run:hover, .run:focus-visible { color:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); outline:none; }
      .open { justify-self:end; display:inline-flex; align-items:center; justify-content:center;
        width:32px; height:32px; min-width:32px; min-height:32px; border:0; background:transparent; color:var(--muted,#8b949e);
        cursor:pointer; border-radius:6px; }
      .open:hover, .open:focus-visible { color:var(--accent,#0e6e63); outline:none; }
      .open svg { width:16px; height:16px; display:block; }
      .delete { justify-self:end; font-size:var(--text-xs,12px); color:var(--danger,#b3261e);
        border:1px solid var(--border,#30363d); border-radius:var(--radius-sm,6px);
        padding:4px 12px; background:transparent; cursor:pointer; font:inherit;
        white-space:nowrap; min-height:32px; }
      .delete:hover, .delete:focus-visible { border-color:var(--danger,#b3261e); outline:none; }
      .meta { display:flex; align-items:center; gap:6px; }
      .state { font-size:var(--text-xs,12px); color:var(--muted,#8b949e); white-space:nowrap; }
      /* The disclosure is a text-sized control in the label column: the
         summary reads as a quiet link, the body as one muted sentence. */
      .detail { margin-top:2px; font-size:var(--text-xs,12px); color:var(--muted,#8b949e); }
      .detail summary { display:inline-flex; align-items:center; gap:4px; cursor:pointer;
        color:var(--muted,#8b949e); min-height:24px; list-style:none; }
      .detail summary::-webkit-details-marker { display:none; }
      .detail summary::before { content:""; width:6px; height:6px; border-right:1.5px solid currentColor;
        border-bottom:1.5px solid currentColor; transform:rotate(-45deg); transition:transform 150ms ease; }
      .detail[open] summary::before { transform:rotate(45deg); }
      .detail summary:hover, .detail summary:focus-visible { color:var(--accent,#0e6e63); outline:none; }
      .detail summary:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; border-radius:4px; }
      .detail p { margin:4px 0 0; line-height:1.4; overflow-wrap:anywhere; }
      @media (prefers-reduced-motion: reduce) { .detail summary::before { transition:none; } }
    `, `<div${rowAttrs}>
      <span class="icon" aria-hidden="true">${icon}</span>
      <span class="label"><span class="name">${escapeHtml(name)}</span>
        <span class="desc"${description ? ` title="${escapeHtml(description)}"` : ""}>${escapeHtml(description)}</span>${
          lastRun ? `<span class="lastrun">${escapeHtml(lastRun)}</span>` : ""
        }${detailHtml}</span>
      <span class="meta">${actionHtml}</span>
    </div>`);
  }
  _wire() {
    const run = this._root.querySelector("[part=run]");
    run?.addEventListener("click", () => this._emit("run"));
    // The switch manages its own checked attribute; the row re-emits so a page
    // listens on the row it built, never inside the shadow tree.
    this._root.querySelector("switch-toggle")?.addEventListener("toggle", (e) => {
      e.stopPropagation();
      this._emit("toggle", { checked: Boolean(e.detail?.checked) });
    });
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
    this._root.querySelector("[part=delete]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._emit("delete");
    });
  }
}
customElements.define("capability-row", CapabilityRow);


/* ──────────────────────────────────────────────────────────────────────────
 * <segmented-control items="Preview,Source,Diff" value="Preview" label="View">
 * A quiet WAI-ARIA tablist (CAP-FB-20260830-ARTIFACT-VIEWER-SOURCE-DIFF-01):
 * role="tablist" with role="tab" buttons, roving tabindex, and automatic
 * activation — ArrowLeft/Right (and Up/Down) move AND select, Home/End jump to
 * the ends, all wrapping. Selecting emits `change {value}` (never for a no-op
 * re-select). The host owns the matching tabpanels and shows/hides them on the
 * event. Styling reuses the Usage range-tab look with the selected tab in the
 * accent ink. Every label enters via textContent — never an HTML string.
 * ────────────────────────────────────────────────────────────────────────── */
export class SegmentedControl extends Component {
  static get observedAttributes() { return ["items", "value", "label", "controls-prefix"]; }
  constructor() { super(); this._value = ""; }
  _items() {
    return String(this.getAttribute("items") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
  }
  get value() {
    const items = this._items();
    if (this._value === null) return "";
    if (this._value && items.includes(this._value)) return this._value;
    const attr = this.getAttribute("value");
    if (attr && items.includes(attr)) return attr;
    return items[0] ?? "";
  }
  set value(v) {
    if (Object.prototype.hasOwnProperty.call(this, "value")) delete this.value;
    const str = String(v ?? "").trim();
    if (!str || !this._items().includes(str)) {
      this._value = null;
      this._sync();
      return;
    }
    this._select(str, { silent: true });
  }
  _render() {
    const items = this._items();
    const value = this.value;
    // controls-prefix (CAP-FB-20260902-PROVIDERS-TABBED-UI-01): when set, each
    // tab gains a stable id + aria-controls pointing at the host's tabpanel of
    // the same slug (the host owns the panels). Slug rule must match
    // familyTabSlug() in lib/providers-view.js (label lowercase, non-alnum
    // runs to dashes) — the providers tabs KAT asserts the pair resolves.
    const prefix = String(this.getAttribute("controls-prefix") ?? "").trim();
    mountTemplate(this, `
      :host { display:inline-block; }
      .tabs { display:inline-flex; gap:2px; padding:3px; border:1px solid var(--border,#e3e0d9);
        border-radius:var(--radius-sm,8px); background:var(--panel-2,#efede8); }
      button { appearance:none; border:0; background:transparent; color:var(--muted,#635e56);
        font:inherit; font-size:13px; font-weight:550; line-height:1; min-block-size:var(--control, 36px); padding:0 14px;
        border-radius:6px; cursor:pointer; white-space:nowrap; transition:color .15s ease, background .15s ease; }
      button:hover { color:var(--text,#1d1b18); }
      button[aria-selected="true"], button[aria-pressed="true"] { background:var(--panel,#fff); color:var(--accent,#0e6e63);
        box-shadow:var(--shadow-1,0 1px 2px rgba(29,27,24,.06)); }
      button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @media (prefers-reduced-motion: reduce) { button { transition:none; } }
    `, `<div class="tabs" role="tablist"></div>`);
    const list = this._root.querySelector(".tabs");
    const roleAttr = this.getAttribute?.("role");
    if (roleAttr) list.setAttribute("role", roleAttr);
    const label = this.getAttribute?.("label");
    if (label) list.setAttribute("aria-label", label);
    for (const item of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.dataset.val = item;
      if (prefix) {
        const slug = item.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        b.id = `${prefix}-tab-${slug}`;
        b.setAttribute("aria-controls", `${prefix}-panel-${slug}`);
      }
      const selected = item === value;
      b.setAttribute("aria-selected", selected ? "true" : "false");
      b.setAttribute("aria-pressed", selected ? "true" : "false");
      b.tabIndex = selected ? 0 : -1;
      b.textContent = item;
      list.appendChild(b);
    }
    // chrome-agent-platform-diay: the attribute-driven selection (connect-time
    // `value`, post-connect attribute changes) never passes through _select,
    // so it must scroll here — this was the reported bug's load-state path.
    // RESTORED (chrome-agent-platform-muc's landing dropped diay's change when
    // union-resolving this file; the tests that pin it were left red on main).
    this._scrollSelectedIntoView();
  }
  _wire() {
    const list = this._root.querySelector(".tabs");
    if (!list) return;
    list.addEventListener("click", (e) => {
      const b = e.target?.closest?.('[role="tab"]');
      if (b?.dataset?.val != null) this._select(b.dataset.val, { focus: true });
    });
    list.addEventListener("keydown", (e) => this._onKey(e));
  }
  _onKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (e.key in move) { e.preventDefault(); this._move(move[e.key]); }
    else if (e.key === "Home") { e.preventDefault(); this._select(this._items()[0], { focus: true }); }
    else if (e.key === "End") { const it = this._items(); e.preventDefault(); this._select(it[it.length - 1], { focus: true }); }
  }
  _move(delta) {
    const items = this._items();
    if (!items.length) return;
    const cur = Math.max(0, items.indexOf(this.value));
    const next = (cur + delta + items.length) % items.length;
    this._select(items[next], { focus: true });
  }
  _select(value, { focus = false, silent = false } = {}) {
    if (Object.prototype.hasOwnProperty.call(this, "value")) delete this.value;
    const items = this._items();
    if (!items.includes(value)) return;
    const changed = value !== this.value;
    this._value = value;
    this._sync();
    if (focus) this._focusSelected();
    this._scrollSelectedIntoView();
    if (changed && !silent) this._emit("change", { value });
  }
  _scrollSelectedIntoView() {
    // chrome-agent-platform-diay: the host strip scrolls horizontally on
    // narrow widths (Settings Providers at 360px) and the active tab can sit
    // outside the viewport. Keep it visible on every activation — click,
    // arrow/Home/End, and the host's programmatic initial selection.
    // "nearest" on both axes never scrolls an already-visible tab.
    const value = this.value;
    for (const b of this._root?.querySelectorAll?.('[role="tab"]') ?? []) {
      if (b.dataset.val === value) { b.scrollIntoView?.({ block: "nearest", inline: "nearest" }); break; }
    }
  }
  _sync() {
    const value = this.value;
    for (const b of this._root?.querySelectorAll?.('[role="tab"]') ?? []) {
      const selected = b.dataset.val === value;
      b.setAttribute("aria-selected", selected ? "true" : "false");
      b.setAttribute("aria-pressed", selected ? "true" : "false");
      b.tabIndex = selected ? 0 : -1;
    }
  }
  _focusSelected() {
    // chrome-agent-platform-ypz0: reveal is component-owned — _select() calls
    // _scrollSelectedIntoView() right after this with "nearest" minimal
    // alignment. A bare focus() let Chrome's native focus scroll do (and hide)
    // that work: it dragged the PAGE on emulated mobile (measured 2026-09-22,
    // sy 0 -> ~493) and made the keyboard-reveal KAT check non-discriminating
    // — it passed on trees with the component reveal removed (and again on
    // 2026-09-25 when a git-checkout cleanup silently reverted this very line
    // before the first commit — reviewer e1m0 caught it; the mutation below
    // only goes RED with this line present). preventScroll keeps focus where
    // the component's own scroll can see it; same convention as the
    // drawer/hunk focus in this file.
    const value = this.value;
    for (const b of this._root?.querySelectorAll?.('[role="tab"]') ?? []) {
      if (b.dataset.val === value) { b.focus?.({ preventScroll: true }); break; }
    }
  }
}
customElements.define("segmented-control", SegmentedControl);


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
export class LoadingState extends Component {
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
    // The grid is decorative: the host that needs an announcement (the
    // conversation's run-status row) owns the ONE live region; this element
    // never nests a second one. The grid takes currentColor so the host's
    // tone (accent / success / danger / muted) colours it.
    const hasLabel = this.hasAttribute("label") ? Boolean(this.getAttribute("label")) : true;
    mountTemplate(this, `
      :host { display:inline-flex; align-items:center; gap:10px; color:var(--accent,#0e6e63); }
      .grid { display:grid; grid-template-columns:repeat(3,4px); gap:3px; width:18px; height:18px; flex:0 0 auto; }
      .px { width:4px; height:4px; border-radius:1px; background:currentColor; opacity:.65; }
      :host([active]) .px { animation:cap-px 1.4s ease-in-out infinite; }
      .label { font-size:13px; color:var(--muted,#635e56); }
      .time { font-size:12px; color:var(--muted,#635e56); font-variant-numeric:tabular-nums; }
      @keyframes cap-px { 0%,100%{opacity:.25;} 50%{opacity:1;} }
      @media (prefers-reduced-motion: reduce) { :host([active]) .px { animation:none; opacity:.7; } }
    `, `<span class="grid" aria-hidden="true">${cells}</span>
      ${hasLabel ? `<span class="label">${escapeHtml(label)}</span>` : ""}
      ${elapsed > 0 ? `<span class="time">${escapeHtml(String(elapsed))}s</span>` : ""}`);
  }
}
customElements.define("loading-state", LoadingState);


/* <agent-dialog title> — consistent modal dialog (slotted content), built on the
 * native <dialog> element so close (X), light-dismiss (backdrop click), Escape,
 * focus trap, and focus-return are native behaviors. */
export class AgentDialog extends Component {
  static get observedAttributes() { return ["title"]; }
  constructor() { super(); this._open = false; }
  _render() {
    const title = this.getAttribute("title") || "";
    mountTemplate(this, `
      :host { display:contents; }
      .dialog { background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:14px; padding:20px; min-width:320px; max-width:90vw; max-height:85vh; overflow:hidden; overscroll-behavior:contain; box-shadow:0 20px 60px rgba(0,0,0,.4); color:var(--text,#1d1b18); display:flex; flex-direction:column; }
      .dialog::backdrop { background:rgba(0,0,0,.5); }
      .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; flex:0 0 auto; }
      .title { font-weight:700; font-size:16px; }
      .x { background:transparent; border:0; color:var(--text,#1d1b18); cursor:pointer; padding:4px; border-radius:4px; }
      .x:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .body { color:var(--text,#1d1b18); flex:1 1 auto; min-height:0; display:flex; flex-direction:column; overflow-y:auto; overflow-x:hidden; }
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


/* confirmActionDialog({ title, body, confirmLabel, destructive, note,
 * requireGenuineGesture, returnFocusTo }) — the ONE
 * promise-based replacement for window.confirm/window.alert/window.prompt in
 * extension pages (CAP-FB-20260823-DIALOG-CONFIRM-MODERNIZATION-01). Built on a
 * native <dialog> shown with showModal() so the focus trap, Escape (cancel),
 * and focus-return are native browser behaviors. Resolves true ONLY from the
 * explicit confirm control; the Cancel button, Escape, and backdrop
 * light-dismiss all resolve false and mutate nothing. Caller text is assigned
 * via textContent (never innerHTML). House theme vars, logical layout, and
 * max-width:90vw keep it theme/RTL/narrow-safe; destructive dialogs name the
 * exact object in the caller-provided body and focus Cancel by default.
 *
 * `requireGenuineGesture` (DEFAULT true since CAP-FB-20260830-UNTRUSTED-CONTENT-
 * FENCING-01) refuses to resolve true unless the click is `isTrusted` AND
 * `navigator.userActivation.isActive` — a script-driven click can still
 * DISMISS the dialog, but can never mint an approval. This was
 * the one property that justified a hand-rolled copy in options.js for the
 * per-agent provider mutation; it belongs in the shared vocabulary instead
 * (CAP-FB-20260827-DIALOG-CONSOLIDATION-01), so any future approval gets it by
 * construction rather than by remembering to re-implement it.
 *
 * `returnFocusTo` restores focus to the element that opened the dialog. The
 * native <dialog> returns focus on its own in most cases; an opener that is
 * re-rendered while the dialog is up is the case that needs this, so the
 * element is checked for `isConnected` first.
 *
 * `note` renders a muted secondary line under the body — used to state the
 * exact scope of what a single approval covers. */
let confirmDialogStyleMounted = false;
function mountConfirmDialogStyle(doc) {
  if (confirmDialogStyleMounted || doc.getElementById("cap-confirm-dialog-style")) {
    confirmDialogStyleMounted = true;
    return;
  }
  const style = doc.createElement("style");
  style.id = "cap-confirm-dialog-style";
  style.textContent = `
.cap-confirm-dialog { background:var(--panel,#ffffff); color:var(--text,#1d1b18); border:1px solid var(--border,#e3e0d9); border-radius:14px; padding:20px; min-width:300px; max-width:90vw; box-shadow:0 20px 60px rgba(0,0,0,.4); }
.cap-confirm-dialog::backdrop { background:rgba(0,0,0,.5); }
.cap-confirm-title { margin:0 0 10px; font-size:16px; font-weight:700; }
.cap-confirm-body { margin:0 0 12px; font-size:14px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }
.cap-confirm-note { margin:0 0 18px; font-size:12.5px; line-height:1.45; color:var(--muted,#635e56); }
.cap-confirm-dialog:not(:has(.cap-confirm-note)) .cap-confirm-body { margin-bottom:18px; }
.cap-confirm-actions { display:flex; justify-content:flex-end; gap:10px; }
.cap-confirm-actions button { border-radius:10px; padding:8px 14px; font-size:13px; cursor:pointer; border:1px solid var(--border,#e3e0d9); background:var(--panel,#ffffff); color:var(--text,#1d1b18); }
.cap-confirm-actions button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
.cap-confirm-accept { background:var(--accent,#0e6e63); border-color:transparent; color:var(--btn-fg,#ffffff); }
.cap-confirm-accept:hover { background:var(--accent-hover,#0a5c53); }
.cap-confirm-accept.destructive, .cap-confirm-accept.destructive:hover { background:var(--danger,#b3261e); }
`;
  (doc.head ?? doc.documentElement).append(style);
  confirmDialogStyleMounted = true;
}
// `requireGenuineGesture` DEFAULTS TO TRUE (CAP-FB-20260830-UNTRUSTED-CONTENT-
// FENCING-01): a scripted `.click()` — from injected page content, a hostile
// extension page script, or a model-driven surface — can dismiss a confirm but
// never mint an approval. A real click or Enter on the focused button is a
// genuine gesture (isTrusted + a live user activation), so keyboard users are
// unaffected. Pass `requireGenuineGesture: false` ONLY for a confirm whose
// acceptance has no side effect worth protecting.
export function confirmActionDialog({ title = "Confirm", body = "", confirmLabel = "Confirm", destructive = false, note = "", requireGenuineGesture = true, returnFocusTo = null } = {}) {
  return new Promise((resolve) => {
    mountConfirmDialogStyle(document);
    const dialog = document.createElement("dialog");
    dialog.className = "cap-confirm-dialog";
    dialog.setAttribute("aria-label", String(title));
    const heading = document.createElement("h2");
    heading.className = "cap-confirm-title";
    heading.textContent = String(title);
    const message = document.createElement("p");
    message.className = "cap-confirm-body";
    message.textContent = String(body);
    const noteEl = note ? document.createElement("p") : null;
    if (noteEl) {
      noteEl.className = "cap-confirm-note";
      noteEl.textContent = String(note);
    }
    const actions = document.createElement("div");
    actions.className = "cap-confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cap-confirm-cancel";
    cancel.textContent = "Cancel";
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = destructive ? "cap-confirm-accept destructive" : "cap-confirm-accept";
    accept.textContent = String(confirmLabel);
    actions.append(cancel, accept);
    if (noteEl) dialog.append(heading, message, noteEl, actions);
    else dialog.append(heading, message, actions);
    let settled = false;
    const settle = (ok) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      // Focus return for an opener that was re-rendered while the dialog was
      // up — the native <dialog> cannot restore focus to a detached element.
      if (returnFocusTo?.isConnected) { try { returnFocusTo.focus(); } catch { /* not focusable */ } }
      resolve(ok);
    };
    cancel.addEventListener("click", () => settle(false));
    accept.addEventListener("click", (event) => {
      // A script-triggered click may dismiss, but must never mint an approval.
      if (requireGenuineGesture &&
          (!event.isTrusted || navigator.userActivation?.isActive !== true)) {
        if (noteEl) noteEl.textContent = "Use a real click to approve this.";
        return;
      }
      settle(true);
    });
    // Escape fires cancel; preventDefault keeps the close path single-owned by settle().
    dialog.addEventListener("cancel", (e) => { e.preventDefault(); settle(false); });
    // Light dismiss: with showModal() a click outside the content lands on the
    // <dialog> element itself (the backdrop).
    dialog.addEventListener("click", (e) => { if (e.target === dialog) settle(false); });
    (document.body ?? document.documentElement).append(dialog);
    dialog.showModal();
    (destructive ? cancel : accept).focus();
  });
}

/** ONE delete-agent confirmation for every surface (the hub, Settings, the
 * side panel) — CAP-FB-20260830-USER-VOICE-COPY-01. Three call sites used to
 * hand-roll three bodies in the system's words ("registry entry", "system
 * prompt override", "recurring alarm"). The body says what the person loses,
 * in their words, and is destructive + genuine-gesture-only like every other
 * delete. `kind` is the agent kind ("named" | "background" | "site"/"origin").
 * Resolves true only on a real click on Delete. */
export const DELETE_AGENT_COPY = Object.freeze({
  named: "Its memory and history are removed. Artifacts it made are kept.",
  background: "Its schedule stops and its history is removed.",
  site: "It stops working on this site and its page tools are removed. Artifacts it made are kept.",
});
export function deleteAgentDialog({ name = "", kind = "named", returnFocusTo = null } = {}) {
  const body = kind === "background"
    ? DELETE_AGENT_COPY.background
    : kind === "site" || kind === "origin"
      ? DELETE_AGENT_COPY.site
      : DELETE_AGENT_COPY.named;
  return confirmActionDialog({
    title: `Delete ${String(name || "this agent")}?`,
    body,
    confirmLabel: "Delete",
    destructive: true,
    requireGenuineGesture: true,
    returnFocusTo,
  });
}

/* <agent-picker> — THE ONE unified agent picker (CAP-FB-20260818-AGENT-ACCESS-01).
 * Every agent-choosing surface uses THIS component: the side panel's Agents
 * view, every composer's + menu "Choose agent" action, AND the /agent slash
 * command (the composer drives this same picker via setQuery + navigate, so
 * the slash UI shares the one renderer + a11y contract — no parallel popup).
 *
 * Data: consumes the REDACTED live registry. With no `agents` attribute and an
 * extension runtime present, it fetches `agent.registry` itself (the SW is the
 * single authority — no duplicated registry state); call refresh() when the
 * `agent-registry-changed` broadcast fires. With an `agents` attribute it takes
 * grouped data ([{ id, label, agents: [...] }]) — or the LEGACY flat site-agent
 * shape ([{ origin, tools }]) for backward compatibility. In the docs showcase
 * (no runtime) it renders the attribute data / the empty state.
 *
 * Attributes:
 *   agents           — grouped (or legacy flat) JSON data (skips the live fetch)
 *   selected         — the canonical selected ref (named:<id>/background:<id>/site:<origin>)
 *   current-agent-id — the bare id of the agent being talked to (a "Current" badge)
 *   exclude-current  — hide the current agent from the list
 *   callable-only    — list only callable agents (a disabled background agent is hidden)
 *   exclude-kinds    — space-separated kinds to hide entirely (e.g.
 *                      exclude-kinds="acp site"): the side panel's picker
 *                      projects the ONE created-agents set (named +
 *                      background) that options/ntp/hub project — acp lives
 *                      in the harness affordance, and an enrolled Site Agent
 *                      (callable by design) would otherwise be the +1 row the
 *                      other three surfaces never count
 *                      (chrome-agent-platform-v15y, following h97m: the
 *                      harness agents live in the harness-quick affordance,
 *                      not the agent rows).
 *   label            — the visible label for the search combobox
 *   state / error    — "loading" | "error" (+ error message) overrides
 *   summary          — LIST presentation: the SAME grouped rows, no search row
 *                      and no combobox/listbox roles, so a host that summarises
 *                      agents in place (the hub's Agents + Site Agents panels)
 *                      renders the shared rows instead of hand-rolling its own
 *   deletable        — summary rows of these kinds get a sibling Delete
 *                      control (bare = every kind, else a space-separated kind
 *                      list, e.g. deletable="background"); emits delete { ref,
 *                      kind, id, name, agent } and never selects the row
 *
 * Events: agent-select { ref, kind, id, name, agent } · agent-cancel (Escape) ·
 * delete { ref, kind, id, name, agent } (deletable rows) ·
 * the LEGACY select { origin } for site entries (backward compatibility).
 *
 * A11y contract: the search input is a combobox controlling a listbox
 * (aria-expanded/controls/activedescendant); options are role=option grouped by
 * role=group; ArrowUp/Down/Home/End move the active option, Enter/Tab commit,
 * Escape cancels (the host returns focus); a debounced visually-hidden live
 * region announces the result count; rows are ≥44px; light/dark/high-contrast/
 * reduced-motion via the shared tokens. No emoji — inline currentColor SVG. */

/* ──────────────────────────────────────────────────────────────────────────
 * Transparency surfaces: <error-console> + <security-shield>
 * ────────────────────────────────────────────────────────────────────────── */

// Fetch from the extension backend when present; degrade to empty in the docs
// showcase (no extension). Mirrors RUNTIME_SEND above.
export function getRuntimeSend() {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      const rawSend = (type, payload = {}, timeoutMs = 12000) => new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const timer = setTimeout(() => {
          finish({ ok: false, error: "the agent worker didn't answer — it may be busy (retry)" });
        }, timeoutMs);
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            finish({ ok: false, error: chrome.runtime.lastError.message });
          } else finish(res ?? { ok: true });
        });
      });
      return (type, payload = {}, timeoutMs = 12000) => cachedRpc(type, payload, { timeoutMs, send: rawSend });
    }
  } catch { /* no chrome */ }
  return null;
}

export const RUNTIME_SEND = getRuntimeSend();

export function backend(type, payload = {}) {
  const send = getRuntimeSend() ?? RUNTIME_SEND;
  return send ? send(type, payload) : Promise.resolve({});
}

// A bounded await: if the worker never answers (e.g. it was killed mid-route,
// which leaves sendMessage's callback NEVER fired), the caller must still
// settle — an unbounded await here was the activity-explorer's dead-controls
// failure (the load promise hung, so the agent select stayed empty and the
// search box filtered nothing).
export function backendBounded(type, payload = {}, timeoutMs = 12000) {
  return Promise.race([
    backend(type, payload),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
}

export function fmtTime(ts) {
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
export class PanelButton extends Component {
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
        border-radius:999px; background:var(--danger,#b3261e); color:var(--btn-fg,#fff); font-size:var(--text-xs, 12px); font-weight:700;
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
      .console .lv { flex:0 0 auto; width:44px; font-size:12px; font-weight:600; }
      .console .lvl-error { border-left-color:var(--danger,#b3261e); } .console .lvl-error .lv { color:var(--danger,#b3261e); }
      .console .lvl-error .msg { color:var(--danger,#b3261e); }
      .console .lvl-warn { border-left-color:var(--warning,#9a6700); } .console .lvl-warn .lv { color:var(--warning,#9a6700); }
      .console .src { flex:0 0 auto; color:var(--muted,#635e56); font-size:var(--text-xs, 12px); opacity:.8; }
      .console .msg { flex:1; word-break:break-word; white-space:pre-wrap; }
      .console .line-copy { flex:0 0 auto; border:0; background:transparent; color:var(--muted,#635e56); cursor:pointer; font-size:var(--text-xs, 12px); padding:0 4px; border-radius:4px; opacity:0; }
      .console .line:hover .line-copy, .console .line-copy:focus-visible { opacity:1; }
      .console .line-copy:hover { color:var(--text,#1d1b18); background:var(--panel-2,#efede8); }
      .shield-body .sect { padding:12px 14px; border-bottom:1px solid var(--border,#e3e0d9); }
      .shield-body .sect:last-child { border-bottom:0; }
      .shield-body .sect-h { font-size:12px; font-weight:600; color:var(--muted,#635e56); margin-bottom:8px; }
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
      .shield-body .vkind { flex:0 0 auto; font-size:12px; font-weight:600; color:var(--warning,#9a6700); }
      .shield-body .vmsg { flex:1; word-break:break-word; }
      .shield-body .vts { flex:0 0 auto; color:var(--muted,#635e56); }
      .diag-body .sect { padding:10px 14px; border-bottom:1px solid var(--border,#e3e0d9); }
      .diag-body .sect:last-child { border-bottom:0; }
      .diag-body .sect-h { font-size:12px; font-weight:600; color:var(--muted,#635e56); margin-bottom:6px; }
      .diag-metrics { display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; padding:12px 14px; border-bottom:1px solid var(--border,#e3e0d9); }
      @media (max-width: 480px) { .diag-metrics { grid-template-columns:repeat(2, 1fr); } }
      .diag-card { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:8px 6px; background:var(--bg,#f7f6f3); border:1px solid var(--border,#e3e0d9); border-radius:8px; text-align:center; }
      .diag-card-num { font-size:18px; font-weight:700; color:var(--text,#1d1b18); }
      .diag-card-num.has-error { color:var(--danger,#b3261e); }
      .diag-card-num.has-running { color:var(--accent,#0e6e63); }
      .diag-card-label { font-size:12px; color:var(--muted,#635e56); margin-top:2px; }
      .diag-tools-list { display:flex; flex-wrap:wrap; gap:6px; }
      .diag-tool-chip { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--border,#e3e0d9); background:var(--panel,#ffffff); color:var(--text,#1d1b18); }
      .diag-tool-chip .count { font-weight:600; color:var(--accent,#0e6e63); margin-left:4px; }
      .diag-errors-list { display:flex; flex-direction:column; gap:4px; }
      .diag-error-row { display:flex; gap:8px; font-size:12px; align-items:baseline; padding:2px 0; }
      .diag-error-time { flex:0 0 auto; color:var(--muted,#635e56); font-size:var(--text-xs, 12px); }
      .diag-error-level { flex:0 0 auto; font-size:12px; font-weight:600; }
      .lvl-error .diag-error-level { color:var(--danger,#b3261e); }
      .lvl-warn .diag-error-level { color:var(--warning,#9a6700); }
      .diag-error-msg { flex:1; word-break:break-word; }
      .diag-active-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }
      .diag-active-item { display:flex; gap:8px; align-items:center; font-size:12px; }
      .diag-active-badge { font-size:12px; font-weight:600; padding:1px 6px; border-radius:4px; background:var(--on-accent-muted,#d7f0ea); color:var(--accent,#0e6e63); }
      .diag-active-preview { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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
    this._panel?.querySelector("[data-refresh]")?.addEventListener("click", () => this._refreshPanel());
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

/* ──────────────────────────────────────────────────────────────────────────
 * One call registers everything (idempotent). Extension pages + the docs
 * showcase both call this.
 * ────────────────────────────────────────────────────────────────────────── */
/**
 * The agent-view permissions panel (CAP-FB-20260819-PERMISSION-REMEDIATION-
 * UX-01, increment 2): in-context grant management where the owner already
 * is — the agent detail. Chrome permissions are extension-global (the honest
 * label says so); the panel shows the posture the agent operates under:
 *   - Site Agent: that site's host-access state with Grant/Revoke buttons.
 *   - NAMED/BACKGROUND agent: every granted host origin (each revocable) plus
 *     the extension's optional-permission states (read-only here).
 * Every Chrome mutation happens from the owner's genuine click through the
 * injected `chromePermissions` seam (the real chrome.permissions by default);
 * failures surface inline and honestly — never silent, never a redirect.
 */
export async function renderAgentPermissionsPanel(host, {
  kind = "",
  id = "",
  chromePermissions = (typeof chrome !== "undefined" && chrome?.permissions) || null,
  // Staleness fence: a rapid A→B agent switch must never let A's slow
  // permission read paint into B's slot. Checked after every await.
  isCurrent = () => true,
} = {}) {
  if (!host) return;
  host.textContent = "";
  // FOLDED by default: the extension-wide permission list runs to ~30 rows plus
  // a row per host origin, and as an open block it pushed the conversation out
  // of the pane (owner report). The summary carries the counts, so the state is
  // still visible at a glance; the revoke controls stay one click away.
  const section = document.createElement("details");
  section.className = "agent-permissions";
  const heading = document.createElement("summary");
  heading.textContent = "Permissions";
  section.append(heading);

  const line = (text, className) => {
    const p = document.createElement("p");
    p.className = className ?? "agent-permissions-note";
    p.textContent = text;
    return p;
  };

  /** Keep the summary informative: N extension permissions · M sites. */
  const summarize = (granted = [], origins = []) => {
    const parts = [];
    if (granted.length) parts.push(`${granted.length} extension permission${granted.length === 1 ? "" : "s"}`);
    if (origins.length) parts.push(`${origins.length} site${origins.length === 1 ? "" : "s"}`);
    heading.textContent = parts.length ? `Permissions — ${parts.join(" · ")}` : "Permissions";
  };

  if (!chromePermissions || typeof chromePermissions.getAll !== "function") {
    section.append(line("Permission management is unavailable in this context."));
    host.append(section);
    return;
  }

  let state = null;
  try {
    state = await chromePermissions.getAll();
  } catch {
    state = null;
  }
  if (!isCurrent()) return; // the owner switched agents mid-read
  if (!state || typeof state !== "object") {
    section.append(line("The permission state could not be read."));
    host.append(section);
    return;
  }
  const origins = Array.isArray(state.origins) ? state.origins.filter((o) => typeof o === "string") : [];
  const permissions = Array.isArray(state.permissions) ? state.permissions.filter((p) => typeof p === "string") : [];
  summarize(permissions, origins);

  if (kind === "site") {
    const origin = String(id).replace(/\/$/, "");
    const pattern = `${origin}/*`;
    const granted = origins.some((o) => o === pattern || o.startsWith(`${origin}/`));
    const row = document.createElement("div");
    row.className = "agent-permissions-row";
    const label = document.createElement("span");
    label.className = "agent-permissions-origin";
    label.textContent = origin;
    const status = document.createElement("span");
    status.className = granted ? "agent-permissions-status granted" : "agent-permissions-status missing";
    status.textContent = granted ? "Site access granted" : "Site access not granted";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-permissions-action";
    button.textContent = granted ? "Revoke access" : "Grant access…";
    const errorLine = line("", "agent-permissions-error");
    errorLine.hidden = true;
    button.addEventListener("click", async () => {
      button.disabled = true;
      errorLine.hidden = true;
      try {
        if (granted) {
          const ok = await chromePermissions.remove({ origins: [pattern] });
          if (ok !== true) throw new Error("the browser refused the revocation");
        } else {
          const ok = await chromePermissions.request({ origins: [pattern] });
          if (ok !== true) {
            errorLine.textContent = "The browser did not grant site access — you can try again from this button.";
            errorLine.hidden = false;
            button.disabled = false;
            return;
          }
        }
        if (!isCurrent()) return;
        await renderAgentPermissionsPanel(host, { kind, id, chromePermissions, isCurrent });
      } catch (err) {
        errorLine.textContent = err?.message ? String(err.message) : "the permission change failed";
        errorLine.hidden = false;
        button.disabled = false;
      }
    });
    row.append(label, status, button);
    section.append(row, errorLine);
    section.append(line("Site access lets this site's agent read and act on pages of this site. Chrome permissions belong to the whole extension; this agent uses them."));
    host.append(section);
    return;
  }

  // Named / background agents: the extension-wide posture, honestly labelled.
  section.append(line("These permissions belong to the extension; this agent uses them."));
  if (permissions.length) {
    const list = document.createElement("ul");
    list.className = "agent-permissions-list";
    for (const p of permissions) {
      const item = document.createElement("li");
      item.className = "agent-permissions-item";
      item.textContent = `${permissionUserLanguage(p) || p} — granted to the extension`;
      list.append(item);
    }
    section.append(list);
  }
  if (origins.length) {
    for (const o of origins) {
      const row = document.createElement("div");
      row.className = "agent-permissions-row";
      const label = document.createElement("span");
      label.className = "agent-permissions-origin";
      label.textContent = o;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agent-permissions-action";
      button.textContent = "Revoke";
      const errorLine = line("", "agent-permissions-error");
      errorLine.hidden = true;
      button.addEventListener("click", async () => {
        button.disabled = true;
        errorLine.hidden = true;
        try {
          const ok = await chromePermissions.remove({ origins: [o] });
          if (ok !== true) throw new Error("the browser refused the revocation");
          if (!isCurrent()) return;
          await renderAgentPermissionsPanel(host, { kind, id, chromePermissions, isCurrent });
        } catch (err) {
          errorLine.textContent = err?.message ? String(err.message) : "the revocation failed";
          errorLine.hidden = false;
          button.disabled = false;
        }
      });
      row.append(label, button);
      section.append(row, errorLine);
    }
  } else {
    section.append(line("No site access is granted to the extension."));
  }
  host.append(section);
}


export function registerComponents() {
  flushDeferredComponents();
  // All components are defined at module load via customElements.define above (or deferred on NTP).
  // This function exists as the single, idempotent entry point for clarity and
  // for the showcase page to call explicitly.
  return true;
}

