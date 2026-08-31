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

import {
  canonicalRef,
  candidatesFromGroups,
  filterGroups,
  findAgentByRef,
  flattenGroups,
  selectionFromAgentCandidate,
  shouldApplyRegistrySnapshot,
} from "./agent-registry.js";
import { parseMentionToken, parseSlashCommand } from "./command-parser.js";
// The hub's activity allowlist — the SERVER (routes/activity.js) is the single
// authority; the explorer imports the same frozen array so client + server can
// never drift (CAP-FB-20260830-RECENT-ACTIVITY-USER-EVENTS-01).
import { USER_VISIBLE_KINDS as USER_VISIBLE_KINDS_ARR } from "../lib/activity-kinds.js";
// Local Set view (the explorer filters in-memory against it; the server also
// enforces the same list, default-deny).
const USER_VISIBLE_KINDS = new Set(USER_VISIBLE_KINDS_ARR);
import { artifactCardTitle, artifactIdentityFromPayloads, isScrolledToBottom, turnTime } from "./thread-view.js";
// The bundled diff core (jsdiff via ./diff-core.js → dist; the gallery sync
// rewrites this to ./diff-core.bundle.js). Only <artifact-diff> uses it.
import { lineDiffSummary } from "../dist/shared/diff-core.bundle.js";
import {
  COMMAND_NAMESPACES as ALL_COMMAND_NAMESPACES,
  loadComposerCommandItems,
  resolveComposerCommandSelection,
} from "./composer-commands.js";
// /files is progressive enhancement — absent where showDirectoryPicker is missing.
export const COMMAND_NAMESPACES = ALL_COMMAND_NAMESPACES.filter(
  (n) => !n.localFiles || supportsLocalFilesCommand(),
);
import { normalizeConversationRunStatus } from "./run-status.js";
import { emptyPlan, reducePlan, planSummary, isPlanStepStatus } from "./plan-strip.js";
import { safeParseOnce, buildTree, subtreeJson, safeJsonStringify } from "./tool-tree.js";
// The CANONICAL secret redactor (lib/pure.js — one semantic, shared with the
// SW write path): activity journals may predate write-path redaction, so the
// explorer redacts again at render AND the tree/copy paths only ever see the
// redacted value.
import { redactSecrets } from "../lib/pure.js";
import { describeToolCall, redactToolResult } from "../lib/tool-summary.js";
import {
  isTextLikeAttachment,
  MAX_LOCAL_TEXT_BYTES,
  textToDataUrl,
} from "../lib/attachments.js";

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
    "function apply(p){if(!p)return;",
    // Closes BOTH the if and apply() — the message listener + ready post
    // below must sit at IIFE level, not inside apply (a dangling open brace
    // made every generated frame throw SyntaxError: Unexpected token ')').
    "if(p.locale){try{document.documentElement.setAttribute('lang',p.locale);}catch(e){}}}",
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
 */
// The rendered-HTML frame contents are held OUT of the privileged DOM. A
// direct srcdoc child inherits extension_pages script-src 'self' (blocking the
// inline guard/bootstrap and generated scripts), so the string renderer points
// at the manifest-sandboxed stable host. That host creates the disposable
// nested srcdoc frame under the sandbox CSP. The guarded HTML is staged here
// (never serialized into the privileged DOM) and flushed over a nonce-matched
// postMessage by wireHtmlFrameContent after mount.
const frameContents = new Map(); // nonce → guarded HTML string

export function renderHtmlFrame(html, { nonce } = {}) {
  const n = nonce ?? generateNonce();
  const previewUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("sandbox/artifact-preview.html")
    : null;
  if (!previewUrl) {
    // Non-extension showcase (no sandbox host + no extension_pages CSP): the
    // srcdoc path has no parent CSP to inherit, so the guarded inline scripts
    // run. The extension never reaches this branch.
    return `<div class="html-frame" data-frame-nonce="${n}"><iframe title="Rendered HTML output" sandbox="allow-scripts" srcdoc="${escapeHtml(injectFrameGuards(html, n))}"></iframe></div>`;
  }
  frameContents.set(n, injectFrameGuards(html, n));
  return `<div class="html-frame" data-frame-nonce="${n}"><iframe title="Rendered HTML output" sandbox="allow-scripts" src="${escapeHtml(previewUrl)}"></iframe></div>`;
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

/* ──────────────────────────────────────────────────────────────────────────
 * Command + mention registry (the / palette + @ mentions in the composer).
 * Self-contained (no imports) so the docs showcase loads the same file.
 * The data-driven sources go through chrome.runtime when present and degrade
 * to empty lists in the plain showcase (no extension backend).
 * ────────────────────────────────────────────────────────────────────────── */
const RUNTIME_SEND = (() => {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      return (type, payload = {}, timeoutMs = 12000) => new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        // A killed/suspended worker leaves the callback NEVER fired — settle
        // with an honest {ok:false, error} instead of hanging the surface (the
        // real-profile "everything broken" class).
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
    }
  } catch { /* no chrome */ }
  return null;
})();

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
  return await loadComposerCommandItems(ns, arg, {
    runtimeSend: RUNTIME_SEND,
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
      items.push({ id: `skill:${s.id}`, label: s.name, description: s.description || "skill", kind: "skill", group: "Skills" });
    }
    for (const a of assets.assets || []) {
      if (!hit(a.name) && !hit(a.id)) continue;
      items.push({ id: `artifact:${a.id ?? a.name}`, label: a.name, description: a.type || "artifact", kind: "artifact", group: "Artifacts" });
    }
  }
  return items;
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

/* <first-run-guide storage-ready provider-ready browser-ready browser-choice>
 * The first-run BANNER (CAP-FB-20260827-HUB-FIRST-RUN-01): one sentence and ONE
 * action. A fresh profile can already run tab tasks without a model (the local
 * assistant), so the only thing worth asking for is a model — everything else
 * (browser control, storage, examples) is asked for in context at the moment a
 * task needs it. It never runs a task or requests a permission itself: the
 * owner actions are emitted for the hub to wire (`open-settings`,
 * `dismiss-guide`). With a provider connected it renders nothing.
 * The dismiss control is LAST in the tab order — the action comes first. */
class FirstRunGuide extends Component {
  static get observedAttributes() { return ["storage-ready", "provider-ready", "browser-ready", "browser-choice"]; }
  _render() {
    const providerReady = this.hasAttribute("provider-ready");
    mountTemplate(this, `
      :host { display:block; margin-block-end:16px; color:var(--text,#1d1b18); }
      :host([hidden]) { display:none; }
      .banner { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:12px; align-items:center;
        padding:10px 10px 10px 14px; border:1px solid var(--border,#e3e0d9);
        border-radius:var(--radius-md,12px); background:var(--panel,#fff); }
      p { margin:0; font-size:13px; line-height:1.45; color:var(--muted,#635e56); text-wrap:pretty; }
      p strong { color:var(--text,#1d1b18); font-weight:600; }
      button { min-height:var(--control,36px); border-radius:var(--radius-sm,6px); padding:0 14px;
        border:1px solid var(--accent,#0e6e63); background:var(--accent,#0e6e63); color:var(--btn-fg,#fff);
        font:inherit; font-weight:600; cursor:pointer; white-space:nowrap; }
      button:hover { filter:brightness(1.08); }
      button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .dismiss { width:36px; padding:0; display:inline-flex; align-items:center; justify-content:center;
        border-color:transparent; background:transparent; color:var(--muted,#635e56); }
      .dismiss:hover { filter:none; color:var(--text,#1d1b18); border-color:var(--border,#e3e0d9); }
      .dismiss svg { width:16px; height:16px; }
      @media (max-width:640px) { .banner { grid-template-columns:minmax(0,1fr) auto; }
        .banner > p { grid-column:1 / -1; } }
    `, providerReady ? "" : `<section class="banner" aria-labelledby="first-run-title">
      <p id="first-run-title"><strong>No model connected yet.</strong> Tab tasks already work — connect a model for everything else.</p>
      <button class="primary connect-model" type="button">Connect a model</button>
      <button class="dismiss" type="button" aria-label="Dismiss first-run setup">${ICONS.close}</button>
    </section>`);
  }
  _wire() {
    this._root.querySelector(".connect-model")?.addEventListener("click", (sourceEvent) =>
      this._emit("open-settings", { sourceEvent }));
    this._root.querySelector(".dismiss")?.addEventListener("click", (sourceEvent) =>
      this._emit("dismiss-guide", { sourceEvent }));
  }
  focusNextAction() {
    this._root.querySelector(".connect-model")?.focus();
  }
}
customElements.define("first-run-guide", FirstRunGuide);

/* <example-chips label="Try one of these" chips="Group my tabs by topic|Summarise this page|Watch this price">
 * Three example tasks under the hub composer (CAP-FB-20260827-HUB-FIRST-RUN-01).
 * A click emits `pick` with the chip's text; the host puts it in the composer
 * and focuses it — a chip never runs anything. Chip text is static markup
 * authored here, but it is rendered with textContent all the same. */
class ExampleChips extends Component {
  static get observedAttributes() { return ["label", "chips"]; }
  get chips() {
    return String(this.getAttribute("chips") ?? "").split("|").map((c) => c.trim()).filter(Boolean);
  }
  _render() {
    const label = this.getAttribute("label") || "Try one of these";
    mountTemplate(this, `
      :host { display:block; margin-block-end:32px; }
      :host([hidden]) { display:none; }
      .row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
      .label { font-size:12px; color:var(--muted,#635e56); margin-inline-end:2px; }
      button { min-height:32px; padding:0 12px; border-radius:999px; border:1px solid var(--border,#e3e0d9);
        background:var(--panel,#fff); color:var(--text,#1d1b18); font:inherit; font-size:13px; cursor:pointer;
        transition:border-color .15s ease, color .15s ease, background .15s ease; }
      button:hover { border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @media (prefers-reduced-motion: reduce) { button { transition:none; } }
    `, `<div class="row" role="group" aria-label="${escapeHtml(label)}"><span class="label" aria-hidden="true">${escapeHtml(label)}</span></div>`);
    const row = this._root.querySelector(".row");
    for (const text of this.chips) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = text;
      row.append(b);
    }
  }
  _wire() {
    for (const b of this._root.querySelectorAll("button.chip")) {
      b.addEventListener("click", (sourceEvent) => this._emit("pick", { text: b.textContent, sourceEvent }));
    }
  }
}
customElements.define("example-chips", ExampleChips);

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

const MIC_METER_DEVICE_KEY = "mic-meter-device-id";

/* <mic-button listening> — self-contained Web Speech toggle + live waveform.
 * Recording state is signalled THREE ways: the `listening` attribute on the
 * host (state authority), `data-listening` on the inner button (visual state —
 * the original bug: the CSS keyed on data-listening but the attribute was
 * never rendered, so recording looked identical to idle), and aria-pressed.
 * While recording the wave bars are driven by the REAL mic level
 * (getUserMedia + AnalyserNode); if the stream/AudioContext is unavailable the
 * bars fall back to the CSS animation (honest "recording" indicator, not a
 * fake level meter). Hover-while-recording swaps the wave for a STOP icon. */
class MicButton extends Component {
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
      const index = options.indexOf(document.activeElement);
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
      .menu button:hover, .menu button:focus-visible { background:var(--bg,#f7f6f3); outline:none; }
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
        <button type="button" role="menuitem" data-kind="choose-agent">Choose agent</button>
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
      if (kind === "choose-agent") {
        // Route this message to ONE agent (CAP-FB-20260818-AGENT-ACCESS-01):
        // the host composer opens the shared <agent-picker> anchored to the +
        // button; choosing sets a removable agent chip.
        this._emit("choose-agent");
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
      .theme-midnight { background:#181614; color:#3ec3b0; }
      .theme-sunlit { background:#f7f6f3; color:#0e6e63; }
      .theme-neon { background:#0e0e14; color:#7c5cff; }
      .theme-terminal { background:#0b0f0d; color:#4ade80; }
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
      .sw[aria-checked="true"] { background:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); }
      .sw[aria-checked="true"]::after { transform:translateX(16px); background:var(--btn-fg,#ffffff); }
      .sw:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @media (prefers-reduced-motion: reduce) { .sw, .sw::after { transition:none; } }
    `, `<button part="switch" class="sw" type="button" role="switch"
        aria-checked="${checked}" aria-label="${escapeHtml(label)}"></button>`);
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
  { id: "activeTab", label: "Screenshots", note: "enables Chrome's transient owner-invoked capture only — never a background grant" },
  { id: "scripting", label: "Site Agents", note: "read pages / register scripts" },
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
      .badge { width:32px; height:32px; border-radius:8px; background:var(--accent,#0e6e63); color:var(--btn-fg,#fff); display:inline-flex; align-items:center; justify-content:center; font-weight:700; }
      .who { flex:1; min-width:0; }
      .name { font-weight:600; }
      .tools { font-size:12px; color:var(--muted,#635e56); }
      .status { font-size:11px; color:var(--muted,#635e56); }
    `, `<div class="card" role="button" tabindex="0" aria-label="Use Site Agent ${escapeHtml(short)}">
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

/* <agent-template-card> — one reusable, bounded template choice. The template
 * record is assigned through the property (large persona text never crosses an
 * HTML attribute); the component emits `use` with the canonical template id.
 *
 * States (CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01):
 *   starter   — the curated pill ("Starter").
 *   selected  — the card the form currently reflects: the accent ring and the
 *               Use button pressed (`aria-pressed="true"`, label "Selected").
 *   blank     — the "Custom agent" start-from-scratch card (no skills row).
 * The whole card activates the Use button (click, Enter, Space); the native
 * button stays the ONE focusable and carries the accessible name, so a grid of
 * cards is one tab stop per card and `tabbable` lets a gallery rove it.
 * Skill chips show the registry's display names when `skillNames` (a Map or
 * object id → name) is set, and fall back to the id otherwise. */
class AgentTemplateCard extends Component {
  static get observedAttributes() { return ["starter", "selected", "blank"]; }
  constructor() {
    super();
    this._template = {};
    this._skillNames = null;
    this._tabbable = true;
  }
  set template(value) {
    this._template = value && typeof value === "object" ? value : {};
    if (this._rendered) { this._render(); this._wire(); }
  }
  get template() { return this._template; }
  set skillNames(value) {
    this._skillNames = value instanceof Map
      ? value
      : value && typeof value === "object"
      ? new Map(Object.entries(value))
      : null;
    if (this._rendered) { this._render(); this._wire(); }
  }
  get skillNames() { return this._skillNames; }
  /** Roving tabindex support: the Use button is the single tab stop. */
  set tabbable(value) {
    this._tabbable = value !== false;
    const btn = this._root?.querySelector(".use");
    if (btn) btn.tabIndex = this._tabbable ? 0 : -1;
  }
  get tabbable() { return this._tabbable; }
  focus() { this._root?.querySelector(".use")?.focus(); }
  get selected() { return this.hasAttribute("selected"); }
  set selected(value) { this.toggleAttribute("selected", value === true); }
  attributeChangedCallback(name, oldValue, newValue) {
    // A state change re-renders the shadow tree; keep keyboard focus on the
    // Use button across it (selecting a card with Enter must not drop focus).
    const hadFocus = this._root?.activeElement?.classList?.contains("use") === true;
    super.attributeChangedCallback(name, oldValue, newValue);
    if (hadFocus) this.focus();
  }
  _skillName(id) {
    const name = this._skillNames?.get(id);
    return typeof name === "string" && name ? name : id.replace(/[-_]+/g, " ");
  }
  _render() {
    const template = this._template;
    const blank = this.hasAttribute("blank");
    const selected = this.hasAttribute("selected");
    const starter = !blank && this.hasAttribute("starter");
    const name = blank ? String(template.name || "Custom agent") : String(template.name || "Unnamed template");
    const persona = blank
      ? String(template.description || "Start from scratch: describe what it does and pick its skills yourself.")
      : (String(template.description || "").trim() || "No persona summary provided.");
    const skills = !blank && Array.isArray(template.skills) ? template.skills.map(String) : [];
    const shownSkills = skills.slice(0, 3);
    const overflow = skills.length - shownSkills.length;
    const minutes = Number(template.schedule?.periodInMinutes);
    const cadence = !blank && template.mode === "background" && Number.isFinite(minutes) && minutes > 0
      ? `every ${minutes} min`
      : "";
    const titleId = `template-title-${Math.random().toString(36).slice(2)}`;
    const personaId = `${titleId}-persona`;
    const chips = shownSkills.length || cadence
      ? `<div class="skills" aria-label="${escapeHtml(skills.length ? `Skills: ${skills.map((id) => this._skillName(id)).join(", ")}` : `Runs ${cadence}`)}">
        ${cadence ? `<span class="cadence">${ICONS.clock ?? ""}${escapeHtml(cadence)}</span>` : ""}
        ${shownSkills.map((skill) => `<span class="skill" title="${escapeHtml(this._skillName(skill))}">${escapeHtml(this._skillName(skill))}</span>`).join("")}
        ${overflow > 0 ? `<span class="overflow" aria-label="${overflow} more skills">+${overflow}</span>` : ""}
      </div>`
      : `<div class="skills skills-empty" aria-hidden="true"></div>`;
    mountTemplate(this, `
      :host { display:block; min-inline-size:0; }
      article { display:grid; grid-template-rows:auto minmax(2.8em,auto) auto auto; gap:10px;
        box-sizing:border-box; block-size:100%; min-block-size:154px; min-inline-size:0; padding:14px; border:1px solid var(--border,#e3e0d9);
        border-radius:var(--radius-md,12px); background:var(--panel,#fff); color:var(--text,#1d1b18); cursor:pointer;
        transition:border-color 150ms ease-out, box-shadow 150ms ease-out; }
      article:hover { border-color:var(--muted,#635e56); }
      :host([selected]) article { border-color:var(--accent,#0e6e63); box-shadow:inset 0 0 0 1px var(--accent,#0e6e63); }
      :host([blank]) article { background:var(--panel-2,#efede8); }
      header { display:flex; align-items:flex-start; gap:8px; min-inline-size:0; }
      .name { margin:0; flex:1; min-inline-size:0; font-size:var(--text-base,14px); line-height:1.35;
        font-weight:700; overflow-wrap:anywhere; }
      .starter { flex:0 0 auto; padding:2px 7px; border:1px solid var(--accent,#0e6e63);
        border-radius:999px; color:var(--accent,#0e6e63); font-size:10px; font-weight:700; line-height:1.4; }
      .persona { display:-webkit-box; margin:0; color:var(--muted,#635e56); font-size:var(--text-xs,12px);
        line-height:1.4; max-block-size:2.8em; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; overflow-wrap:anywhere; }
      .skills { display:flex; flex-wrap:wrap; align-items:center; gap:5px; min-inline-size:0; min-block-size:1.5em; }
      .skill, .overflow, .cadence { display:inline-flex; align-items:center; gap:4px; max-inline-size:100%; padding:2px 7px; border-radius:999px;
        background:var(--panel-2,#efede8); color:var(--muted,#635e56); font-size:10px; line-height:1.5;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .cadence { background:transparent; border:1px solid var(--border,#e3e0d9); font-variant-numeric:tabular-nums; }
      .cadence svg { inline-size:12px; block-size:12px; }
      .overflow { border:1px solid var(--border,#e3e0d9); background:transparent; font-weight:700; }
      .use { display:inline-flex; align-items:center; gap:6px; justify-self:start; min-block-size:36px; padding:0 14px; border:0; border-radius:var(--radius-sm,6px);
        background:var(--accent,#0e6e63); color:var(--btn-fg,#fff); cursor:pointer; font:600 var(--text-sm,13px)/1 inherit;
        transition:background-color 150ms ease-out; }
      .use:hover { background:var(--accent-hover,#0a5c53); }
      .use[aria-pressed="true"] { background:transparent; color:var(--accent,#0e6e63); box-shadow:inset 0 0 0 1px var(--accent,#0e6e63); }
      .use svg { inline-size:14px; block-size:14px; }
      .use:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @media (prefers-reduced-motion:reduce) { article, .use { transition:none; } }
      @media (forced-colors:active) { article, .starter, .overflow, .cadence, .use { border:1px solid CanvasText; }
        :host([selected]) article { border-width:2px; } .use[aria-pressed="true"] { border:2px solid Highlight; } }
    `, `<article aria-labelledby="${titleId}" aria-describedby="${personaId}">
      <header><h3 class="name" id="${titleId}">${escapeHtml(name)}</h3>${starter ? '<span class="starter">Starter</span>' : ""}</header>
      <p class="persona" id="${personaId}">${escapeHtml(persona)}</p>
      ${chips}
      <button class="use" type="button" aria-pressed="${selected ? "true" : "false"}" tabindex="${this._tabbable ? 0 : -1}" aria-label="${escapeHtml(blank ? `Use ${name}` : `Use ${name} template`)}">${selected ? `${ICONS.check ?? ""}Selected` : "Use"}</button>
    </article>`);
  }
  _wire() {
    const article = this._root.querySelector("article");
    const use = this._root.querySelector(".use");
    const activate = () => {
      const template = this._template;
      this._emit("use", { id: this.hasAttribute("blank") ? "" : String(template?.id ?? ""), template });
    };
    use?.addEventListener("click", (e) => { e.stopPropagation(); activate(); });
    // Whole-card activation: a click anywhere on the card is the Use button's
    // click (the button keeps the accessible name and the focus ring).
    article?.addEventListener("click", (e) => {
      if (e.target === use || use?.contains(e.target)) return;
      use?.focus();
      activate();
    });
  }
}
customElements.define("agent-template-card", AgentTemplateCard);

/* <agent-template-gallery blank filter="starter" filters="starter,all,scheduled" selected="">
 * The template catalogue as a grid of <agent-template-card>s with a segmented
 * filter (Starter / All / Scheduled). One component for the create dialog and
 * Settings, so both surfaces offer the same catalogue the same way.
 *   templates   — property: template records (`starter: true` marks the pill;
 *                 `mode: "background"` puts a template under Scheduled).
 *   skillNames  — property: Map/object of skill id → display name (chips).
 *   blank       — attribute: prepend the "Custom agent" card (id "").
 *   selected    — property/attribute: the id the form currently reflects.
 *   filters     — attribute: the filters to offer; a single filter hides the row.
 * Keyboard: the grid is ONE tab stop (roving tabindex across the cards' Use
 * buttons; arrows, Home and End move; Enter/Space activate). Emits `use`
 * ({id, template}) and `filter-change` ({filter}). */
class AgentTemplateGallery extends Component {
  static get observedAttributes() { return ["filter", "filters", "blank", "selected"]; }
  constructor() {
    super();
    this._templates = [];
    this._skillNames = null;
  }
  set templates(value) {
    this._templates = Array.isArray(value) ? value.filter((t) => t && typeof t === "object" && t.id) : [];
    if (this._rendered) { this._render(); this._wire(); }
  }
  get templates() { return this._templates; }
  set skillNames(value) {
    this._skillNames = value;
    if (this._rendered) { this._render(); this._wire(); }
  }
  get skillNames() { return this._skillNames; }
  get filter() {
    const f = String(this.getAttribute("filter") || "").toLowerCase();
    const allowed = this.filters;
    return allowed.includes(f) ? f : allowed[0];
  }
  set filter(value) { this.setAttribute("filter", String(value)); }
  get filters() {
    const raw = String(this.getAttribute("filters") || "starter,all,scheduled")
      .split(",").map((s) => s.trim().toLowerCase()).filter((s) => ["starter", "all", "scheduled"].includes(s));
    return raw.length ? raw : ["all"];
  }
  get selected() { return this.hasAttribute("selected") ? String(this.getAttribute("selected")) : null; }
  set selected(value) {
    if (value == null) { this.removeAttribute("selected"); return; }
    const id = String(value);
    if (this.getAttribute("selected") === id) return;
    // Update the cards in place — a full re-render would drop keyboard focus.
    this._suppressRender = true;
    this.setAttribute("selected", id);
    this._suppressRender = false;
    this._applySelection();
  }
  attributeChangedCallback(name, oldValue, newValue) {
    if (this._suppressRender) return;
    // A filter change re-renders the grid; keep focus where it was — on the
    // filter button that was pressed, or back on the grid's tab stop when a
    // card had it (the cards are new elements after the render).
    const active = this._root?.activeElement;
    const focusedFilter = active?.dataset?.filter;
    const focusedCard = active?.localName === "agent-template-card";
    super.attributeChangedCallback(name, oldValue, newValue);
    if (focusedFilter) this._root.querySelector(`.filter[data-filter="${focusedFilter}"]`)?.focus();
    else if (focusedCard) this.focus();
  }
  focus() {
    const cards = this._cards();
    (cards.find((c) => c.tabbable) ?? cards[0])?.focus();
  }
  _cards() { return [...(this._root?.querySelectorAll("agent-template-card") ?? [])]; }
  _matches(t, filter) {
    if (filter === "starter") return t.starter === true;
    if (filter === "scheduled") return t.mode === "background";
    return true;
  }
  _count(filter) { return this._templates.filter((t) => this._matches(t, filter)).length; }
  _applySelection() {
    const selected = this.selected;
    const cards = this._cards();
    let tabStop = null;
    for (const card of cards) {
      const id = card.hasAttribute("blank") ? "" : String(card.template?.id ?? "");
      const on = selected != null && id === selected;
      card.selected = on;
      if (on) tabStop = card;
    }
    const stop = tabStop ?? cards[0] ?? null;
    for (const card of cards) card.tabbable = card === stop;
  }
  _render() {
    const filters = this.filters;
    const filter = this.filter;
    const labels = { starter: "Starter", all: "All", scheduled: "Scheduled" };
    const showFilters = filters.length > 1;
    const rows = this._templates.filter((t) => this._matches(t, filter));
    const blank = this.hasAttribute("blank");
    mountTemplate(this, `
      :host { display:block; min-inline-size:0; }
      .filters { display:inline-flex; gap:0; margin-block-end:12px; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,6px); padding:2px; background:var(--panel-2,#efede8); }
      .filter { display:inline-flex; align-items:center; gap:6px; min-block-size:30px; padding:0 12px; border:0; border-radius:4px; background:transparent;
        color:var(--muted,#635e56); cursor:pointer; font:600 var(--text-sm,13px)/1 inherit; transition:background-color 150ms ease-out, color 150ms ease-out; }
      .filter[aria-pressed="true"] { background:var(--panel,#fff); color:var(--text,#1d1b18); box-shadow:0 1px 2px rgba(0,0,0,.08); }
      .filter:hover { color:var(--text,#1d1b18); }
      .filter:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
      .count { font-weight:500; font-variant-numeric:tabular-nums; color:var(--muted,#635e56); }
      .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:10px; min-inline-size:0; }
      .empty { margin:0; padding:20px 0; color:var(--muted,#635e56); font-size:var(--text-sm,13px); text-align:center; }
      @media (prefers-reduced-motion:reduce) { .filter { transition:none; } }
      @media (forced-colors:active) { .filters { border:1px solid CanvasText; } .filter[aria-pressed="true"] { border:2px solid Highlight; } }
    `, `${showFilters ? `<div class="filters" role="group" aria-label="Show templates">
        ${filters.map((f) => `<button type="button" class="filter" data-filter="${f}" aria-pressed="${f === filter ? "true" : "false"}">${labels[f]} <span class="count">${this._count(f)}</span></button>`).join("")}
      </div>` : ""}
      <div class="grid" role="group" aria-label="Templates"></div>
      ${!rows.length && !blank ? `<p class="empty">No templates match.</p>` : ""}`);
    const grid = this._root.querySelector(".grid");
    if (blank) {
      const card = document.createElement("agent-template-card");
      card.setAttribute("blank", "");
      card.template = { id: "", name: "Custom agent" };
      grid.append(card);
    }
    for (const t of rows) {
      const card = document.createElement("agent-template-card");
      if (t.starter === true) card.setAttribute("starter", "");
      card.template = t;
      if (this._skillNames) card.skillNames = this._skillNames;
      grid.append(card);
    }
    this._applySelection();
  }
  _wire() {
    for (const btn of this._root.querySelectorAll(".filter")) {
      btn.addEventListener("click", () => {
        const f = btn.dataset.filter;
        if (f === this.filter) return;
        this.filter = f;
        this._emit("filter-change", { filter: f });
      });
    }
    const grid = this._root.querySelector(".grid");
    grid?.addEventListener("use", (e) => {
      e.stopPropagation();
      const id = String(e.detail?.id ?? "");
      this.selected = id;
      this._emit("use", { id, template: e.detail?.template ?? null });
    });
    // Roving tabindex across the cards (one tab stop for the grid).
    grid?.addEventListener("keydown", (e) => {
      const cards = this._cards();
      if (!cards.length) return;
      const current = cards.findIndex((c) => c.contains(e.target) || c === e.target);
      if (current < 0) return;
      const columns = this._columns(cards);
      let next = -1;
      switch (e.key) {
        case "ArrowRight": next = Math.min(cards.length - 1, current + 1); break;
        case "ArrowLeft": next = Math.max(0, current - 1); break;
        case "ArrowDown": next = Math.min(cards.length - 1, current + columns); break;
        case "ArrowUp": next = Math.max(0, current - columns); break;
        case "Home": next = 0; break;
        case "End": next = cards.length - 1; break;
        default: return;
      }
      e.preventDefault();
      if (next === current) return;
      for (const card of cards) card.tabbable = false;
      cards[next].tabbable = true;
      cards[next].focus();
    });
  }
  _columns(cards) {
    const top = cards[0]?.getBoundingClientRect().top;
    let n = 0;
    for (const card of cards) {
      if (Math.abs(card.getBoundingClientRect().top - top) < 1) n++;
      else break;
    }
    return Math.max(1, n);
  }
}
customElements.define("agent-template-gallery", AgentTemplateGallery);

/* <tool-directory-card> — one production-registry function in semantic order:
 * name → bounded registry description/schema metadata → per-function states.
 * The component owns its responsive geometry so Directory embeds cannot detach
 * a source/approval badge from the function it describes. */
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

class ToolDirectoryCard extends Component {
  constructor() {
    super();
    this._tool = {};
  }
  set tool(value) {
    this._tool = value && typeof value === "object" ? value : {};
    if (this._rendered) { this._render(); this._wire(); }
  }
  get tool() { return this._tool; }
  _render() {
    const tool = this._tool;
    const name = String(tool.name || "Unnamed function");
    const origin = String(tool.origin || "Unknown site");
    const description = String(tool.description || "").trim() || "No description provided";
    const source = String(tool.source || "inferred");
    const sourceLabel = source === "declared" ? "Declared" : source === "linked" ? "Linked" : "Inferred";
    const approved = tool.approved === true;
    const titleId = `tool-title-${Math.random().toString(36).slice(2)}`;
    const descriptionId = `${titleId}-description`;
    mountTemplate(this, `
      :host { display:block; min-inline-size:0; container-type:inline-size; }
      article { display:grid; grid-template-columns:minmax(0,1fr); gap:8px;
        min-inline-size:0; padding:14px 16px; border:1px solid var(--border,#e3e0d9);
        border-radius:var(--radius-md,12px); background:var(--panel,#fff); }
      .tool-name { margin:0; min-inline-size:0; color:var(--text,#1d1b18);
        font:600 var(--text-base,14px)/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
        overflow-wrap:anywhere; word-break:break-word; }
      .tool-description { margin:0; min-inline-size:0; color:var(--text,#1d1b18);
        max-inline-size:72ch; overflow-wrap:anywhere; }
      .tool-metadata { display:flex; flex-wrap:wrap; gap:4px 12px; margin:0;
        min-inline-size:0; color:var(--muted,#635e56); font-size:var(--text-xs,12px); }
      .tool-metadata div { display:flex; flex-wrap:wrap; min-inline-size:0; gap:4px; }
      .tool-metadata dt { font-weight:600; }
      .tool-metadata dd { margin:0; min-inline-size:0; overflow-wrap:anywhere; }
      .tool-states { display:flex; flex-wrap:wrap; align-items:safe center; gap:8px;
        min-inline-size:0; }
      .tool-status { display:inline-flex; align-items:center; min-inline-size:0;
        max-inline-size:100%; padding:3px 8px; border:1px solid var(--border,#e3e0d9);
        border-radius:999px; color:var(--muted,#635e56); background:var(--bg,#f7f6f3);
        font-size:var(--text-xs,12px); font-weight:600; line-height:1.4; overflow-wrap:anywhere; }
      .tool-status.source { color:var(--accent,#0e6e63); border-color:currentColor; }
      .tool-status.approved { color:var(--success,#1a7f37); border-color:currentColor; }
      .tool-status.pending { color:var(--warning,#9a6700); border-color:currentColor; }
      .approve { min-block-size:36px; max-inline-size:100%; padding:6px 10px;
        border:0; border-radius:var(--radius-sm,6px); background:var(--accent,#0e6e63);
        color:var(--btn-fg,#fff); cursor:pointer; font:600 var(--text-sm,13px)/1.4 inherit;
        white-space:normal; overflow-wrap:anywhere; }
      .approve:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @container (min-inline-size:520px) {
        article { grid-template-columns:minmax(0,1fr) fit-content(260px); column-gap:20px; }
        .tool-name, .tool-description, .tool-metadata { grid-column:1; }
        .tool-states { grid-column:2; grid-row:1 / span 3; align-self:start; justify-content:flex-end; }
      }
      @media (forced-colors:active) {
        article, .tool-status, .approve { border:1px solid CanvasText; forced-color-adjust:auto; }
      }
    `, `<article class="tool-card" aria-labelledby="${titleId}" aria-describedby="${descriptionId}">
      <h3 class="tool-name" id="${titleId}">${escapeHtml(name)}</h3>
      <p class="tool-description" id="${descriptionId}">${escapeHtml(description)}</p>
      <dl class="tool-metadata">
        <div><dt>Site:</dt><dd>${escapeHtml(origin)}</dd></div>
        <div><dt>Schema:</dt><dd>${escapeHtml(summarizeInputSchema(tool.inputSchema))}</dd></div>
      </dl>
      <div class="tool-states" aria-label="States for ${escapeHtml(name)}">
        <span class="tool-status source" role="status" aria-label="${escapeHtml(name)}: ${sourceLabel}">${sourceLabel}</span>
        <span class="tool-status ${approved ? "approved" : "pending"}" role="status" aria-label="${escapeHtml(name)}: ${approved ? "Approved" : "Approval required"}">${approved ? "Approved" : "Approval required"}</span>
        ${approved ? "" : `<button class="approve" type="button" aria-label="Approve ${escapeHtml(name)} for ${escapeHtml(origin)}">Approve</button>`}
      </div>
    </article>`);
  }
  _wire() {
    this._root.querySelector(".approve")?.addEventListener("click", () => {
      this._emit("approve", { origin: this._tool.origin, name: this._tool.name });
    });
  }
}
customElements.define("tool-directory-card", ToolDirectoryCard);

/* <capability-row name description icon action="run|open|open-delete|use" last-run>
 * The reusable capability/recipe row. A strict grid — icon (fixed) | label
 * column (name + description STACKED, never run together) | action
 * (right-aligned) — so every capability list is aligned by construction. */
class CapabilityRow extends Component {
  static get observedAttributes() {
    return ["name", "description", "icon", "action", "action-label", "last-run"];
  }
  _render() {
    const name = this.getAttribute("name") || "";
    const description = this.getAttribute("description") || "";
    const icon = this.getAttribute("icon") || "";
    const action = this.getAttribute("action") || "run";
    const actionLabel = this.getAttribute("action-label") || "Run";
    const lastRun = this.getAttribute("last-run") || "";
    // "open" = the WHOLE row is clickable (an agent → open its chat/view) with a
    // chevron affordance instead of a "Run" button; "open-delete" = a chevron to
    // open the agent's view AND a destructive Delete button — for background
    // agents (an enabled background agent exists and runs; the owner removes it
    // with Delete, not an enable/disable switch); "run" = a small Run button.
    const actionHtml = action === "open-delete"
      ? `<button part="open" class="open" type="button" aria-label="Open ${escapeHtml(name)}">${ICONS.chevron}</button>
         <button part="delete" class="delete" type="button" aria-label="Delete ${escapeHtml(name)}">Delete</button>`
      : action === "open"
        ? `<button part="open" class="open" type="button" aria-label="Open ${escapeHtml(name)}">${ICONS.chevron}</button>`
        : action === "use"
            ? `<button part="use" class="run" type="button">Use</button>`
            : `<button part="run" class="run" type="button" aria-label="${escapeHtml(actionLabel)} ${escapeHtml(name)}">${escapeHtml(actionLabel)}</button>`;
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
        white-space:nowrap; }
      .run:hover, .run:focus-visible { color:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); outline:none; }
      .open { justify-self:end; display:inline-flex; align-items:center; justify-content:center;
        width:28px; height:28px; border:0; background:transparent; color:var(--muted,#8b949e);
        cursor:pointer; border-radius:6px; }
      .open:hover, .open:focus-visible { color:var(--accent,#0e6e63); outline:none; }
      .open svg { width:16px; height:16px; display:block; }
      .delete { justify-self:end; font-size:var(--text-xs,12px); color:var(--danger,#b3261e);
        border:1px solid var(--border,#30363d); border-radius:var(--radius-sm,6px);
        padding:4px 12px; background:transparent; cursor:pointer; font:inherit;
        white-space:nowrap; }
      .delete:hover, .delete:focus-visible { border-color:var(--danger,#b3261e); outline:none; }
      .meta { display:flex; align-items:center; gap:6px; }
    `, `<div${rowAttrs}>
      <span class="icon" aria-hidden="true">${icon}</span>
      <span class="label"><span class="name">${escapeHtml(name)}</span>
        <span class="desc"${description ? ` title="${escapeHtml(description)}"` : ""}>${escapeHtml(description)}</span>${
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
    this._root.querySelector("[part=delete]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this._emit("delete");
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
    return ["id", "name", "type", "size", "origin", "time", "actions"];
  }
  set preview(v) {
    this._preview = v ?? "";
    if (this._rendered) { this._render(); this._wire(); }
    // An async preview set after the mount re-renders the shadow (the old
    // listeners are destroyed) AND re-wires the fresh elements + re-stages the
    // guarded HTML (wireHtmlFrameContent) — the browser review's defect.
    // Idempotence: the re-render replaced the old nodes, so the re-wire adds
    // exactly one set of listeners + the prior frame cleanup ran first.
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
    // `actions` is an optional space-separated allowlist. Omitted keeps every
    // action, so the library is unchanged. A surface that cannot HANDLE an
    // action must not render its button: a control that does nothing is the
    // same defect as one that claims success it never checked. The thread, for
    // instance, offers New tab and Reuse but not Delete — an artifact is not
    // deleted from the transcript that records making it.
    const allow = (this.getAttribute("actions") ?? "").trim();
    const allowed = allow ? new Set(allow.split(/\s+/)) : null;
    const act = (nameOfAct, html) => (allowed && !allowed.has(nameOfAct) ? "" : html);
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
        ${act("open-tab", `<button type="button" data-act="open-tab" title="Open in new tab">${ICONS.external}<span>New tab</span></button>`)}
        ${act("reuse", `<button type="button" data-act="reuse">${ICONS.attach}<span>Reuse</span></button>`)}
        ${act("delete", `<button type="button" data-act="delete" class="danger">${ICONS.close}<span>Delete</span></button>`)}
      </div>
    </div>`);
  }
  _wire() {
    // Deliver the staged guarded HTML to the sandbox-host iframe (the string
    // renderer cannot postMessage — wire it here after the markup mounted) and
    // retain the cleanup so a re-render or disconnect never leaks frameContents.
    this._previewCleanup?.();
    const previewFrame = this._root.querySelector(".preview .html-frame");
    if (previewFrame) this._previewCleanup = wireHtmlFrameContent(previewFrame);
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
    this._root.querySelector('[data-act="open-tab"]')?.addEventListener("click", () => this._emit("open-tab", detail()));
    this._root.querySelector('[data-act="reuse"]')?.addEventListener("click", () => this._emit("reuse", detail()));
    this._root.querySelector('[data-act="delete"]')?.addEventListener("click", () => this._emit("delete", detail()));
  }
  disconnectedCallback() {
    this._previewCleanup?.();
    this._previewCleanup = undefined;
    super.disconnectedCallback?.();
  }

}
customElements.define("artifact-card", ArtifactCard);

/* ──────────────────────────────────────────────────────────────────────────
 * Source highlighting — a tiny, bounded, dependency-free tokenizer
 * (CAP-FB-20260830-ARTIFACT-VIEWER-SOURCE-DIFF-01). No highlight.js, no regex
 * `new Function` — MV3 CSP forbids it. `tokenizeSource` is a PURE, loss-free
 * scanner: the concatenation of every token's text equals the input exactly,
 * so nothing is ever dropped or reordered. `highlightSource` turns those tokens
 * into `<span class="tok-…">` nodes built with createElement + textContent —
 * NEVER an HTML string — so untrusted artifact bodies can never inject markup.
 * ────────────────────────────────────────────────────────────────────────── */
const SOURCE_LANGUAGES = new Set(["html", "css", "js", "json", "md", "text"]);
// Sticky (`y`) rules, tried in order at each cursor position; the first that
// matches AT the cursor wins. Every regex is anchored to lastIndex, so a
// keyword only tokenizes on a real word boundary (never inside an identifier).
const SOURCE_RULES = {
  js: [
    ["com", /\/\/[^\n]*/y],
    ["com", /\/\*[\s\S]*?\*\//y],
    ["str", /"(?:[^"\\\n]|\\.)*"/y],
    ["str", /'(?:[^'\\\n]|\\.)*'/y],
    ["str", /`(?:[^`\\]|\\.)*`/y],
    ["kw", /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|import|export|from|as|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|delete|yield|null|true|false|undefined)\b/y],
    ["num", /\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
    ["punct", /[{}()\[\];,.:?=+\-*/%<>!&|^~]/y],
  ],
  json: [
    ["str", /"(?:[^"\\]|\\.)*"/y],
    ["kw", /\b(?:true|false|null)\b/y],
    ["num", /-?\b\d[\d]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
    ["punct", /[{}\[\]:,]/y],
  ],
  css: [
    ["com", /\/\*[\s\S]*?\*\//y],
    ["str", /"(?:[^"\\\n]|\\.)*"/y],
    ["str", /'(?:[^'\\\n]|\\.)*'/y],
    ["kw", /@[a-zA-Z-]+/y],
    ["num", /-?\b\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch|ex|pt)?\b/y],
    ["punct", /[{}();:,]/y],
  ],
  html: [
    ["com", /<!--[\s\S]*?-->/y],
    ["tag", /<\/?[a-zA-Z!][^>]*>/y],
  ],
  md: [
    ["str", /`[^`\n]*`/y],
    ["kw", /\*\*[^*\n]+\*\*/y],
    ["tag", /^#{1,6}[^\n]*/my],
  ],
};

/** Split `text` into `{text, cls}` tokens for `language`. Loss-free and bounded
 * — the concatenation of the token texts always equals the input. `cls` is ""
 * for a plain run, otherwise one of kw/str/com/num/tag/punct. */
export function tokenizeSource(text, language) {
  const src = String(text ?? "");
  const lang = SOURCE_LANGUAGES.has(String(language)) ? String(language) : "text";
  const rules = SOURCE_RULES[lang];
  if (!rules) return src ? [{ text: src, cls: "" }] : [];
  const out = [];
  let i = 0;
  let plainStart = 0;
  const pushPlain = (end) => { if (end > plainStart) out.push({ text: src.slice(plainStart, end), cls: "" }); };
  const n = src.length;
  while (i < n) {
    let hit = null;
    let cls = "";
    for (const [c, re] of rules) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (m && m.index === i && m[0].length > 0) { hit = m[0]; cls = c; break; }
    }
    if (hit) {
      pushPlain(i);
      out.push({ text: hit, cls });
      i += hit.length;
      plainStart = i;
    } else {
      i++; // no rule at this position — fold into the surrounding plain run
    }
  }
  pushPlain(n);
  return out;
}

/** A DocumentFragment of highlighted source: `<span class="tok-…">` for each
 * classified token, a text node for each plain run. Built with the DOM API and
 * textContent only — never an HTML string. */
export function highlightSource(text, language, doc = (typeof document !== "undefined" ? document : globalThis.document)) {
  const d = doc;
  const frag = d.createDocumentFragment();
  for (const { text: t, cls } of tokenizeSource(text, language)) {
    if (cls) {
      const span = d.createElement("span");
      span.className = `tok-${cls}`;
      span.textContent = t;
      frag.appendChild(span);
    } else {
      frag.appendChild(d.createTextNode(t));
    }
  }
  return frag;
}

/** Infer a highlight language from an artifact's type and name. */
export function inferSourceLanguage(asset) {
  const type = String(asset?.type ?? "");
  if (type === "html") return "html";
  if (type === "json") return "json";
  const name = String(asset?.name ?? "").toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  if (ext === "js" || ext === "mjs" || ext === "ts") return "js";
  if (ext === "css") return "css";
  if (ext === "json") return "json";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "md";
  const content = String(asset?.content ?? "");
  if (type === "text" && /^\s*[<]/.test(content) && /<\/?[a-z]/i.test(content)) return "html";
  return "text";
}

// Shared token palette for highlighted source (calm, AA-legible in both themes;
// colour never carries meaning alone — it rides on the token text). Reused by
// <artifact-inspector> and the artifact viewer's Source panel.
const SOURCE_TOKEN_STYLE = `
  .tok-kw { color: var(--accent,#0e6e63); font-weight: 600; }
  .tok-str { color: var(--success,#1a7f37); }
  .tok-com { color: var(--muted,#635e56); font-style: italic; }
  .tok-num { color: var(--danger,#b3261e); }
  .tok-tag { color: var(--accent,#0e6e63); }
  .tok-punct { color: var(--muted,#635e56); }
`;

/* <artifact-inspector> — source/hex inspection and explicit confined HTML play.
 * Content is property-only and enters the DOM via textContent/srcdoc, never an
 * outer HTML parser. Rendering is bounded while Copy preserves exact content. */
class ArtifactInspector extends Component {
  constructor() { super(); this._asset = null; this._language = ""; this._frameCleanup = null; this._frameDispose = null; }
  set asset(value) { this._asset = value && typeof value === "object" ? value : null; if (this._rendered) this._render(); }
  get asset() { return this._asset; }
  // Optional syntax highlighting. "" (default) or "text" → plain textContent;
  // any recognised language tokenises the bounded source into tok-* spans.
  set language(value) { this._language = SOURCE_LANGUAGES.has(String(value)) ? String(value) : ""; if (this._rendered) this._render(); }
  get language() { return this._language || (this._asset ? inferSourceLanguage(this._asset) : ""); }
  disconnectedCallback() { this.stopPreview(); }
  _render() {
    const a = this._asset ?? {};
    const type = String(a.type ?? "data");
    const content = String(a.content ?? "");
    const limit = 65536;
    const truncated = content.length > limit;
    mountTemplate(this, `
      :host { display:block; min-inline-size:min(76vw,920px); max-inline-size:920px; }
      .bar { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-block-end:10px; }
      .meta { color:var(--muted,#635e56); font-size:12px; margin-inline-end:auto; }
      button { min-block-size:36px; border:1px solid var(--border,#e3e0d9); border-radius:6px; background:var(--panel,#fff); color:var(--text,#1d1b18); padding:6px 10px; cursor:pointer; font:inherit; }
      button.primary { background:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); color:var(--accent-ink,#fff); }
      button:focus-visible, pre:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      pre { max-block-size:52vh; overflow:auto; margin:0; padding:12px; border:1px solid var(--border,#e3e0d9); border-radius:8px; background:var(--panel-2,#efede8); color:var(--text,#1d1b18); font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
      .note,.status { font-size:12px; color:var(--muted,#635e56); margin-block:8px 0; }
      .status { min-block-size:1.4em; }
      .preview[hidden] { display:none; }
      .preview { margin-block-start:12px; border:1px solid var(--border,#e3e0d9); border-radius:8px; overflow:hidden; background:var(--panel,#fff); }
      .preview iframe { display:block; inline-size:100%; block-size:min(56vh,520px); border:0; }
      ${SOURCE_TOKEN_STYLE}
    `, `<div class="bar"><span class="meta"></span><button type="button" class="copy">Copy exact content</button>${type === "html" ? '<button type="button" class="primary play">Preview / Play</button>' : ""}</div><pre tabindex="0"><code></code></pre><p class="note" hidden></p><p class="status" role="status" aria-live="polite"></p><div class="preview" hidden></div>`);
    this._root.querySelector(".meta").textContent = `${type} · ${a.size ?? new TextEncoder().encode(content).byteLength} B · ${a.origin ?? "master"}`;
    const code = this._root.querySelector("code");
    const shown = content.slice(0, limit);
    const lang = this.language;
    // Highlight when a recognised language is known; otherwise the exact source
    // as one text node. Both paths are markup-free (textContent / createTextNode).
    if (lang && lang !== "text") code.replaceChildren(highlightSource(shown, lang, document));
    else code.textContent = shown;
    const note = this._root.querySelector(".note");
    note.hidden = !truncated;
    if (truncated) note.textContent = `Inspection is bounded to the first ${limit.toLocaleString()} characters. Copy includes the complete artifact.`;
  }
  _wire() {
    this._root.querySelector(".copy")?.addEventListener("click", async () => {
      const status = this._root.querySelector(".status");
      try { await navigator.clipboard.writeText(String(this._asset?.content ?? "")); status.textContent = "Copied exact artifact content."; }
      catch { status.textContent = "Copy failed. Select the source and copy it manually."; }
    });
    this._root.querySelector(".play")?.addEventListener("click", () => this.startPreview());
  }
  startPreview() {
    const host = this._root.querySelector(".preview");
    if (!host || this._asset?.type !== "html") return;
    this.stopPreview();
    const frame = createHtmlFrame(this._asset.content ?? "", { title:`Interactive preview of ${this._asset.name ?? "HTML artifact"}` });
    host.replaceChildren(frame.wrapper);
    host.hidden = false;
    this._frameCleanup = wireHtmlFramePreference(frame.wrapper, { nonce:frame.nonce, ...currentFramePreference() });
    this._frameDispose = frame.dispose;
    frame.iframe.focus();
    this._root.querySelector(".status").textContent = "Interactive preview opened in a restricted sandbox.";
  }
  stopPreview() {
    this._frameCleanup?.();
    this._frameCleanup = null;
    this._frameDispose?.();
    this._frameDispose = null;
    const host = this._root?.querySelector?.(".preview");
    const iframe = host?.querySelector?.("iframe");
    if (iframe) iframe.src = "about:blank";
    host?.replaceChildren?.();
    if (host) host.hidden = true;
  }
}
customElements.define("artifact-inspector", ArtifactInspector);

/* ──────────────────────────────────────────────────────────────────────────
 * <artifact-diff mode="unified|split" context="3" max-lines="2000">
 * A line diff of two strings (CAP-FB-20260830-ARTIFACT-DIFF-COMPONENT-01).
 * Properties: `before` / `after` (the two bodies), `beforeLabel` /
 * `afterLabel`, `language` (informational; no highlighter here). The diff
 * itself comes from the bundled diff core (jsdiff) — this element only
 * renders it. Every diff line is UNTRUSTED model output: rows are DOM-built
 * and their text is set with textContent after neutralise + truncate; the one
 * markup mount is the static header. Keyboard: n / ] next change, p / [
 * previous; focus moves to the hunk and a polite live region says
 * "Change N of M". Events: `navigate` {index,total}, `truncated` {lines,total}.
 * Rendering is bounded to `max-lines` rows with an honest final note.
 * ────────────────────────────────────────────────────────────────────────── */
const ARTIFACT_DIFF_DEFAULT_MAX_LINES = 2000;
const ARTIFACT_DIFF_DEFAULT_CONTEXT = 3;

function pluralize(n, one, many) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * The pure render model for <artifact-diff>: the diff core's hunks, bounded to
 * `maxLines` rows, plus the exact header/label strings the element shows.
 * Exported so the numbers can be tested without a DOM.
 */
export function buildArtifactDiffModel(before, after, { context = ARTIFACT_DIFF_DEFAULT_CONTEXT, maxLines = ARTIFACT_DIFF_DEFAULT_MAX_LINES, beforeLabel = "", afterLabel = "" } = {}) {
  const ctx = Number.isFinite(Number(context)) ? Math.max(0, Math.floor(Number(context))) : ARTIFACT_DIFF_DEFAULT_CONTEXT;
  const cap = Number.isFinite(Number(maxLines)) ? Math.max(1, Math.floor(Number(maxLines))) : ARTIFACT_DIFF_DEFAULT_MAX_LINES;
  const summary = lineDiffSummary(before, after, { context: ctx, oldName: beforeLabel, newName: afterLabel });
  const totalChanged = summary.added + summary.removed;
  let rendered = 0;
  let renderedChanged = 0;
  let truncated = false;
  const hunks = [];
  for (const hunk of summary.hunks) {
    if (rendered >= cap) { truncated = true; break; }
    const room = cap - rendered;
    const rows = hunk.rows.length > room ? hunk.rows.slice(0, room) : hunk.rows;
    if (rows.length < hunk.rows.length) truncated = true;
    rendered += rows.length;
    for (const row of rows) if (row.kind !== "context") renderedChanged++;
    hunks.push({ ...hunk, rows });
  }
  const changes = summary.hunks.length;
  const summaryText = changes === 0
    ? "No changes"
    : `+${summary.added.toLocaleString()} -${summary.removed.toLocaleString()} · ${pluralize(changes, "change", "changes")}`;
  const regionLabel = changes === 0
    ? "Diff, no changes"
    : `Diff, ${pluralize(summary.added, "addition", "additions")}, ${pluralize(summary.removed, "deletion", "deletions")}, ${pluralize(changes, "change", "changes")}`;
  const truncationNote = truncated
    ? `Showing ${renderedChanged.toLocaleString()} of ${totalChanged.toLocaleString()} changed lines — open the artifact to see everything`
    : "";
  return {
    added: summary.added,
    removed: summary.removed,
    changes,
    hunks,
    summary: summaryText,
    regionLabel,
    truncated,
    truncationNote,
    renderedLines: rendered,
    totalLines: summary.hunks.reduce((n, h) => n + h.rows.length, 0),
  };
}

class ArtifactDiff extends Component {
  static get observedAttributes() {
    return ["mode", "context", "max-lines", "before-label", "after-label"];
  }
  constructor() {
    super();
    this._before = "";
    this._after = "";
    this._language = "text";
    this._index = -1;
    this._hunkCount = 0;
  }
  set before(v) { this._before = String(v ?? ""); this._rerender(); }
  get before() { return this._before; }
  set after(v) { this._after = String(v ?? ""); this._rerender(); }
  get after() { return this._after; }
  set beforeLabel(v) { if (v == null || v === "") this.removeAttribute("before-label"); else this.setAttribute("before-label", String(v)); }
  get beforeLabel() { return this.getAttribute("before-label") || ""; }
  set afterLabel(v) { if (v == null || v === "") this.removeAttribute("after-label"); else this.setAttribute("after-label", String(v)); }
  get afterLabel() { return this.getAttribute("after-label") || ""; }
  set language(v) { this._language = /^(html|css|js|json|md|text)$/.test(String(v)) ? String(v) : "text"; }
  get language() { return this._language; }
  get mode() { return this.getAttribute("mode") === "split" ? "split" : "unified"; }
  set mode(v) { this.setAttribute("mode", v === "split" ? "split" : "unified"); }
  /** The current change (0-based) and the number of changes. */
  get currentChange() { return { index: this._index, total: this._hunkCount }; }
  _rerender() {
    if (this._rendered) { this._render(); this._wire(); }
  }
  _render() {
    const mode = this.mode;
    const model = buildArtifactDiffModel(this._before, this._after, {
      context: this.getAttribute("context") ?? ARTIFACT_DIFF_DEFAULT_CONTEXT,
      maxLines: this.getAttribute("max-lines") ?? ARTIFACT_DIFF_DEFAULT_MAX_LINES,
      beforeLabel: this.beforeLabel,
      afterLabel: this.afterLabel,
    });
    this._model = model;
    this._hunkCount = model.hunks.length;
    this._index = -1;
    const noNav = model.hunks.length < 2;
    mountTemplate(this, `
      :host { display:block; container-type:inline-size; inline-size:100%; min-inline-size:0;
        --ad-add-bg: color-mix(in oklab, var(--success,#1a7f37) 12%, var(--panel,#fff));
        --ad-del-bg: color-mix(in oklab, var(--danger,#b3261e) 12%, var(--panel,#fff));
        --ad-add-no: color-mix(in oklab, var(--success,#1a7f37) 22%, var(--panel,#fff));
        --ad-del-no: color-mix(in oklab, var(--danger,#b3261e) 22%, var(--panel,#fff)); }
      .frame { border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-md,12px); background:var(--panel,#fff);
        color:var(--text,#1d1b18); overflow:hidden; }
      .head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; padding:8px 12px;
        border-block-end:1px solid var(--border,#e3e0d9); background:var(--panel-2,#efede8);
        font-size:var(--text-xs,12px); font-variant-numeric:tabular-nums; }
      .counts { display:inline-flex; gap:8px; font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace); font-weight:600; }
      /* Counts and markers stay in --text ink: the semantic hues sit under
         AA at 12px on the paper palette, so colour is carried by the row tint
         and the +/- marker, never by the ink alone. */
      .changes { color:var(--muted,#635e56); }
      .labels { display:inline-flex; gap:8px; min-inline-size:0; color:var(--muted,#635e56); overflow:hidden; }
      .labels span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .labels span + span::before { content:"→"; margin-inline-end:8px; }
      .labels:empty { display:none; }
      .nav { margin-inline-start:auto; display:inline-flex; gap:4px; }
      .nav button { inline-size:28px; block-size:28px; display:inline-flex; align-items:center; justify-content:center;
        border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,6px); background:var(--panel,#fff);
        color:var(--text,#1d1b18); cursor:pointer; padding:0; }
      .nav button svg { inline-size:16px; block-size:16px; }
      .nav button[data-act="prev"] svg { transform:rotate(-90deg); }
      .nav button[data-act="next"] svg { transform:rotate(90deg); }
      .nav button:hover:not(:disabled) { border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      .nav button:disabled { opacity:.45; cursor:default; }
      .nav button:focus-visible, .hunk:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:-2px; }
      .body { max-block-size:var(--artifact-diff-max-block-size, 60vh); overflow:auto; overscroll-behavior:contain;
        font:12.5px/1.6 var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace); font-variant-numeric:tabular-nums; }
      .body::selection, .body *::selection { background:color-mix(in oklab, var(--accent,#0e6e63) 24%, transparent); }
      .hunk { display:block; border-block-end:1px solid var(--border,#e3e0d9); }
      .hunk:last-of-type { border-block-end:0; }
      .hunk[data-current] { box-shadow:inset 0 0 0 1px var(--accent,#0e6e63); }
      .hh { padding:2px 12px; color:var(--muted,#635e56); background:var(--panel-2,#efede8); font-size:11.5px; user-select:none; }
      .ln, .pair { display:grid; align-items:stretch; min-inline-size:0; }
      .ln { grid-template-columns:4ch 4ch minmax(0,1fr); }
      .pair { grid-template-columns:4ch minmax(0,1fr) 4ch minmax(0,1fr); }
      .no { padding:0 6px; text-align:end; color:var(--muted,#635e56); user-select:none; background:var(--panel-2,#efede8); }
      .tx { padding:0 12px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; min-inline-size:0; position:relative;
        padding-inline-start:22px; }
      .tx::before { position:absolute; inset-inline-start:8px; content:" "; color:var(--muted,#635e56); user-select:none; }
      [data-kind="add"].tx { background:var(--ad-add-bg); }
      [data-kind="add"].tx::before { content:"+"; color:var(--text,#1d1b18); }
      [data-kind="del"].tx { background:var(--ad-del-bg); }
      [data-kind="del"].tx::before { content:"-"; color:var(--text,#1d1b18); }
      [data-kind="add"].no { background:var(--ad-add-no); color:var(--text,#1d1b18); }
      [data-kind="del"].no { background:var(--ad-del-no); color:var(--text,#1d1b18); }
      [data-kind="empty"] { background:var(--panel-2,#efede8); }
      .pair .l.tx { border-inline-end:1px solid var(--border,#e3e0d9); }
      .more, .none { padding:10px 12px; color:var(--muted,#635e56); font:var(--text-xs,12px)/1.5 system-ui,sans-serif; }
      .status { position:absolute; inline-size:1px; block-size:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; margin:0; }
      @container (max-width: 720px) {
        .pair { grid-template-columns:4ch minmax(0,1fr); }
        .pair [data-kind="empty"], .pair .r[data-kind="ctx"] { display:none; }
        .pair .l.tx { border-inline-end:0; }
      }
      @media (prefers-reduced-motion: no-preference) {
        .nav button { transition:border-color 150ms ease-out, color 150ms ease-out; }
      }
    `, `<div class="frame">
      <div class="head">
        <span class="counts"><span class="add"></span><span class="del"></span></span>
        <span class="changes"></span>
        <span class="labels"></span>
        <span class="nav">
          <button type="button" data-act="prev" aria-label="Previous change" aria-keyshortcuts="[" title="Previous change ([ or p)"${noNav ? " disabled" : ""}>${ICONS.chevron}</button>
          <button type="button" data-act="next" aria-label="Next change" aria-keyshortcuts="]" title="Next change (] or n)"${noNav ? " disabled" : ""}>${ICONS.chevron}</button>
        </span>
      </div>
      <div class="body" role="region" data-mode="${mode}"></div>
      <p class="status" role="status" aria-live="polite" aria-atomic="true"></p>
    </div>`);
    const root = this._root;
    const changesEl = root.querySelector(".changes");
    if (model.changes === 0) {
      changesEl.textContent = model.summary;
    } else {
      root.querySelector(".counts .add").textContent = `+${model.added.toLocaleString()}`;
      root.querySelector(".counts .del").textContent = `-${model.removed.toLocaleString()}`;
      changesEl.textContent = pluralize(model.changes, "change", "changes");
    }
    const labels = root.querySelector(".labels");
    for (const label of [this.beforeLabel, this.afterLabel]) {
      if (!label) continue;
      const span = document.createElement("span");
      span.textContent = label;
      labels.appendChild(span);
    }
    const body = root.querySelector(".body");
    body.setAttribute("aria-label", model.regionLabel);
    body.dataset.language = this._language;
    if (model.hunks.length === 0) {
      const none = document.createElement("p");
      none.className = "none";
      none.textContent = "The two versions are identical.";
      body.appendChild(none);
    }
    model.hunks.forEach((hunk, i) => {
      const section = document.createElement("section");
      section.className = "hunk";
      section.tabIndex = 0;
      section.setAttribute("aria-label", `Change ${i + 1} of ${model.hunks.length}`);
      section.dataset.index = String(i);
      const header = document.createElement("div");
      header.className = "hh";
      header.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
      section.appendChild(header);
      if (mode === "split") this._buildSplitRows(section, hunk);
      else this._buildUnifiedRows(section, hunk);
      body.appendChild(section);
    });
    if (model.truncated) {
      const more = document.createElement("p");
      more.className = "more";
      more.setAttribute("role", "note");
      more.textContent = model.truncationNote;
      body.appendChild(more);
    }
  }
  _cell(className, kind, text) {
    const cell = document.createElement("span");
    cell.className = className;
    cell.dataset.kind = kind;
    cell.textContent = text;
    return cell;
  }
  _buildUnifiedRows(section, hunk) {
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    for (const row of hunk.rows) {
      const kind = row.kind === "add" ? "add" : row.kind === "remove" ? "del" : "ctx";
      const line = document.createElement("div");
      line.className = "ln";
      line.dataset.kind = kind;
      line.appendChild(this._cell("no old", kind, kind === "add" ? "" : String(oldNo++)));
      line.appendChild(this._cell("no new", kind, kind === "del" ? "" : String(newNo++)));
      line.appendChild(this._cell("tx", kind, row.text));
      section.appendChild(line);
    }
  }
  _buildSplitRows(section, hunk) {
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    const rows = hunk.rows;
    let i = 0;
    const pair = (left, right) => {
      const line = document.createElement("div");
      line.className = "pair";
      const lk = left ? "del" : "empty";
      const rk = right ? "add" : "empty";
      line.appendChild(this._cell("no l", lk, left ? String(oldNo++) : ""));
      line.appendChild(this._cell("tx l", lk, left ? left.text : ""));
      line.appendChild(this._cell("no r", rk, right ? String(newNo++) : ""));
      line.appendChild(this._cell("tx r", rk, right ? right.text : ""));
      section.appendChild(line);
    };
    while (i < rows.length) {
      const row = rows[i];
      if (row.kind === "context") {
        const line = document.createElement("div");
        line.className = "pair";
        line.appendChild(this._cell("no l", "ctx", String(oldNo++)));
        line.appendChild(this._cell("tx l", "ctx", row.text));
        line.appendChild(this._cell("no r", "ctx", String(newNo++)));
        line.appendChild(this._cell("tx r", "ctx", row.text));
        section.appendChild(line);
        i++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < rows.length && rows[i].kind === "remove") dels.push(rows[i++]);
      while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) pair(dels[k] ?? null, adds[k] ?? null);
    }
  }
  _wire() {
    const root = this._root;
    root.querySelector('[data-act="prev"]')?.addEventListener("click", () => this._go(-1));
    root.querySelector('[data-act="next"]')?.addEventListener("click", () => this._go(1));
    // The shadow root survives re-renders, so the key handler binds once.
    if (!this._keysBound) {
      this._keysBound = true;
      root.addEventListener("keydown", (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === "n" || e.key === "]") { e.preventDefault(); this._go(1); }
        else if (e.key === "p" || e.key === "[") { e.preventDefault(); this._go(-1); }
      });
      root.addEventListener("focusin", (e) => {
        const hunk = e.target?.closest?.(".hunk");
        if (hunk && hunk.dataset.index != null) this._mark(Number(hunk.dataset.index));
      });
    }
    const model = this._model;
    if (model?.truncated) this._emit("truncated", { lines: model.renderedLines, total: model.totalLines });
  }
  _mark(index) {
    const hunks = this._root.querySelectorAll(".hunk");
    hunks.forEach((h, i) => { if (i === index) h.setAttribute("data-current", ""); else h.removeAttribute("data-current"); });
    this._index = index;
  }
  /** Move to the next (+1) / previous (-1) change; clamps at the ends. */
  _go(delta) {
    const total = this._hunkCount;
    if (total === 0) return;
    const next = Math.min(total - 1, Math.max(0, (this._index < 0 ? (delta > 0 ? -1 : total) : this._index) + delta));
    if (next === this._index) return;
    this._mark(next);
    const hunk = this._root.querySelectorAll(".hunk")[next];
    hunk?.focus?.({ preventScroll: true });
    hunk?.scrollIntoView?.({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    const status = this._root.querySelector(".status");
    if (status) status.textContent = `Change ${next + 1} of ${total}`;
    this._emit("navigate", { index: next, total });
  }
}
customElements.define("artifact-diff", ArtifactDiff);

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
class SegmentedControl extends Component {
  static get observedAttributes() { return ["items", "value", "label"]; }
  constructor() { super(); this._value = ""; }
  _items() {
    return String(this.getAttribute("items") ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean);
  }
  get value() {
    const items = this._items();
    if (this._value && items.includes(this._value)) return this._value;
    const attr = this.getAttribute("value");
    if (attr && items.includes(attr)) return attr;
    return items[0] ?? "";
  }
  set value(v) { this._select(String(v ?? ""), { silent: true }); }
  _render() {
    const items = this._items();
    const value = this.value;
    mountTemplate(this, `
      :host { display:inline-block; }
      .tabs { display:inline-flex; gap:2px; padding:3px; border:1px solid var(--border,#e3e0d9);
        border-radius:var(--radius-sm,8px); background:var(--panel-2,#efede8); }
      button { appearance:none; border:0; background:transparent; color:var(--muted,#635e56);
        font:inherit; font-size:13px; font-weight:550; line-height:1; min-block-size:30px; padding:0 14px;
        border-radius:6px; cursor:pointer; white-space:nowrap; transition:color .15s ease, background .15s ease; }
      button:hover { color:var(--text,#1d1b18); }
      button[aria-selected="true"] { background:var(--panel,#fff); color:var(--accent,#0e6e63);
        box-shadow:var(--shadow-1,0 1px 2px rgba(29,27,24,.06)); }
      button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      @media (prefers-reduced-motion: reduce) { button { transition:none; } }
    `, `<div class="tabs" role="tablist"></div>`);
    const list = this._root.querySelector(".tabs");
    const label = this.getAttribute("label");
    if (label) list.setAttribute("aria-label", label);
    for (const item of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.dataset.val = item;
      const selected = item === value;
      b.setAttribute("aria-selected", selected ? "true" : "false");
      b.tabIndex = selected ? 0 : -1;
      b.textContent = item;
      list.appendChild(b);
    }
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
    const items = this._items();
    if (!items.includes(value)) return;
    const changed = value !== this.value;
    this._value = value;
    this._sync();
    if (focus) this._focusSelected();
    if (changed && !silent) this._emit("change", { value });
  }
  _sync() {
    const value = this.value;
    for (const b of this._root?.querySelectorAll?.('[role="tab"]') ?? []) {
      const selected = b.dataset.val === value;
      b.setAttribute("aria-selected", selected ? "true" : "false");
      b.tabIndex = selected ? 0 : -1;
    }
  }
  _focusSelected() {
    const value = this.value;
    for (const b of this._root?.querySelectorAll?.('[role="tab"]') ?? []) {
      if (b.dataset.val === value) { b.focus?.(); break; }
    }
  }
}
customElements.define("segmented-control", SegmentedControl);

/* ──────────────────────────────────────────────────────────────────────────
 * <artifact-quick-drawer> — bounded recent/search/filter access to artifact
 * metadata. The component never reads artifact bodies: hosts own Open/Reuse
 * authority and receive metadata-only events. Dynamic artifact values are
 * written with DOM textContent, never interpolated into HTML.
 * CAP-FB-20260828-NOUN-DISCIPLINE-01: the element, its labels and its events
 * all say "artifact". The `asset.list` runtime ROUTE keeps its wire name — the
 * route family is a persisted security boundary, renamed separately.
 * ────────────────────────────────────────────────────────────────────────── */
export const ARTIFACT_QUICK_LIMITS = Object.freeze({
  maxSource: 200,
  recent: 8,
  results: 40,
  maxQuery: 200,
});

const QUICK_ARTIFACT_TYPES = new Set(["html", "text", "json", "image", "data"]);

function boundedArtifactField(value, max, fallback = "") {
  const text = String(value ?? fallback).trim();
  return text.length > max ? text.slice(0, max) : text;
}

function quickArtifactTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeQuickArtifact(value) {
  if (!value || typeof value !== "object") return null;
  const id = boundedArtifactField(value.id, 256);
  if (!id) return null;
  const rawType = boundedArtifactField(value.type, 40, "data").toLowerCase();
  const type = QUICK_ARTIFACT_TYPES.has(rawType) ? rawType : "unknown";
  const sizeValue = Number(value.size);
  return {
    id,
    name: boundedArtifactField(value.name, 200, "Untitled") || "Untitled",
    type,
    origin: boundedArtifactField(value.origin, 256, "master") || "master",
    size: Number.isFinite(sizeValue) && sizeValue >= 0 ? Math.floor(sizeValue) : 0,
    at: quickArtifactTimestamp(value.at ?? value.updatedAt ?? value.createdAt),
  };
}

/** A truthful owner label: hub-owned master entries, otherwise the canonical
 * origin when parseable (and the bounded stored owner string when not). */
export function quickArtifactOwner(origin) {
  const stored = boundedArtifactField(origin, 256, "master") || "master";
  if (stored === "master") return "Hub";
  try { return new URL(stored).origin; } catch { return stored; }
}

export function formatQuickArtifactSize(value) {
  const bytes = Number.isFinite(Number(value)) && Number(value) >= 0
    ? Math.floor(Number(value))
    : 0;
  if (bytes < 1024) return `${bytes.toLocaleString()} ${bytes === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB"];
  let amount = bytes;
  let unit = -1;
  do { amount /= 1024; unit++; } while (amount >= 1024 && unit < units.length - 1);
  const compact = amount >= 10 ? amount.toFixed(0) : amount.toFixed(1);
  return `${compact} ${units[unit]} (${bytes.toLocaleString()} bytes)`;
}

export function formatQuickArtifactTime(value) {
  const timestamp = quickArtifactTimestamp(value);
  if (!timestamp) return { label: "Time unavailable", datetime: "" };
  const date = new Date(timestamp);
  try {
    return {
      label: new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date),
      datetime: date.toISOString(),
    };
  } catch {
    return { label: date.toISOString(), datetime: date.toISOString() };
  }
}

/** Select the visible metadata rows without unbounded work or DOM growth.
 * Storage contract: one origin owns at most 200 artifacts. A malformed oversized
 * response is read from its newest end and explicitly reported as truncated. */
export function selectQuickArtifacts(raw, { query = "", type = "all" } = {}) {
  const source = Array.isArray(raw) ? raw : [];
  const start = Math.max(0, source.length - ARTIFACT_QUICK_LIMITS.maxSource);
  const normalized = [];
  for (let i = start; i < source.length; i++) {
    const artifact = normalizeQuickArtifact(source[i]);
    if (artifact) normalized.push(artifact);
  }
  normalized.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  const q = String(query ?? "").trim().slice(0, ARTIFACT_QUICK_LIMITS.maxQuery).toLocaleLowerCase();
  const selectedType = QUICK_ARTIFACT_TYPES.has(type) ? type : "all";
  const matches = [];
  for (const artifact of normalized) {
    if (selectedType !== "all" && artifact.type !== selectedType) continue;
    if (q) {
      const haystack = `${artifact.name}\n${artifact.type}\n${artifact.origin}\n${quickArtifactOwner(artifact.origin)}`.toLocaleLowerCase();
      if (!haystack.includes(q)) continue;
    }
    matches.push(artifact);
  }
  const activeFilter = !!q || selectedType !== "all";
  const limit = activeFilter ? ARTIFACT_QUICK_LIMITS.results : ARTIFACT_QUICK_LIMITS.recent;
  return {
    items: matches.slice(0, limit),
    total: matches.length,
    sourceTotal: source.length,
    sourceTruncated: source.length > ARTIFACT_QUICK_LIMITS.maxSource,
    limited: matches.length > limit,
  };
}

class ArtifactQuickDrawer extends Component {
  constructor() {
    super();
    this._artifacts = [];
    this._state = "idle";
    this._error = "";
    this._query = "";
    this._type = "all";
    this._open = false;
    this._requestSeq = 0;
    this._announceTimer = null;
    this._resizeHandler = null;
    this._returnFocus = true;
  }

  set artifacts(value) {
    this._artifacts = Array.isArray(value) ? value : [];
    this._state = "ready";
    this._error = "";
    if (this._rendered) this._renderList();
  }
  get artifacts() { return this._artifacts; }

  connectedCallback() {
    if (!this._artifacts.length && this.hasAttribute("artifacts")) {
      this._artifacts = parseJSONAttr(this.getAttribute("artifacts"), []);
      this._state = "ready";
    }
    super.connectedCallback();
  }

  disconnectedCallback() {
    if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
    this._resizeHandler = null;
    clearTimeout(this._announceTimer);
    super.disconnectedCallback();
  }

  _render() {
    const label = this.getAttribute("label") || "Quick access artifacts";
    mountTemplate(this, `
      :host { display:inline-flex; min-inline-size:0; }
      .trigger { inline-size:36px; block-size:36px; display:inline-flex; align-items:center; justify-content:center;
        border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,6px); padding:0;
        background:transparent; color:var(--muted,#635e56); cursor:pointer; }
      .trigger:hover { border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      .trigger:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .trigger svg { inline-size:16px; block-size:16px; display:block; }
      :host-context([dir="rtl"]) .trigger svg { transform:scaleX(-1); }
      .drawer { position:fixed; z-index:220; margin:0; padding:0;
        inline-size:min(380px, calc(100vw - 24px)); max-block-size:min(620px, calc(100vh - 24px));
        color:var(--text,#1d1b18); background:var(--panel,#fff); border:1px solid var(--border,#e3e0d9);
        border-radius:var(--radius-md,12px); box-shadow:var(--shadow-2,0 12px 32px rgba(29,27,24,.08));
        overflow:hidden; }
      .drawer[hidden] { display:none; }
      .shell { display:flex; flex-direction:column; max-block-size:min(620px, calc(100vh - 24px)); }
      .head { display:flex; align-items:center; gap:8px; padding:12px 14px; border-block-end:1px solid var(--border,#e3e0d9); }
      h2 { flex:1; min-inline-size:0; margin:0; font-size:14px; font-weight:650; letter-spacing:-.01em; }
      .close { inline-size:36px; block-size:36px; display:inline-flex; align-items:center; justify-content:center;
        border:0; border-radius:var(--radius-sm,6px); background:transparent; color:var(--muted,#635e56); cursor:pointer; }
      .close:hover { color:var(--text,#1d1b18); background:var(--panel-2,#efede8); }
      .close:focus-visible, .action:focus-visible, .browse:focus-visible, .retry:focus-visible,
      input:focus-visible, select:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .controls { display:grid; grid-template-columns:minmax(0,1fr) 112px; gap:8px; padding:12px 14px; }
      label { display:flex; flex-direction:column; gap:4px; min-inline-size:0; font-size:11px; font-weight:600; color:var(--muted,#635e56); }
      input, select { min-inline-size:0; min-block-size:40px; border:1px solid var(--border,#e3e0d9);
        border-radius:var(--radius-sm,6px); background:var(--bg,#f7f6f3); color:var(--text,#1d1b18);
        font:inherit; font-size:13px; padding:0 10px; }
      .summary { margin:0; padding:0 14px 8px; color:var(--muted,#635e56); font-size:12px; }
      .list { flex:1 1 auto; min-block-size:0; list-style:none; margin:0; padding:0 8px 8px; overflow-y:auto; overscroll-behavior:contain; }
      .item { padding:10px 6px; border-block-start:1px solid var(--border,#e3e0d9); }
      .item:first-child { border-block-start:0; }
      .item-head { display:flex; align-items:flex-start; gap:8px; }
      .name { flex:1; min-inline-size:0; font-weight:650; font-size:13px; line-height:1.35;
        overflow-wrap:anywhere; }
      .type { flex:0 0 auto; border:1px solid var(--border,#e3e0d9); border-radius:999px;
        padding:1px 7px; color:var(--muted,#635e56); font-size:10px; text-transform:uppercase; }
      dl { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px 10px; margin:7px 0 8px; }
      dl div { min-inline-size:0; }
      dt { color:var(--muted,#635e56); font-size:10px; }
      dd { margin:0; color:var(--text,#1d1b18); font-size:11px; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
      .actions { display:flex; gap:6px; }
      .action, .browse, .retry { min-block-size:36px; border:1px solid var(--border,#e3e0d9);
        border-radius:var(--radius-sm,6px); background:transparent; color:var(--text,#1d1b18);
        font:inherit; font-size:12px; font-weight:600; cursor:pointer; padding:0 12px; }
      .action:hover, .browse:hover, .retry:hover { border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      .state { padding:16px 14px; color:var(--muted,#635e56); font-size:12px; }
      .state.error { color:var(--danger,#b3261e); }
      .state .retry { display:block; margin-block-start:10px; color:inherit; }
      .foot { display:flex; align-items:center; gap:8px; padding:10px 14px; border-block-start:1px solid var(--border,#e3e0d9); }
      .browse { inline-size:100%; min-block-size:40px; }
      .sr-only { position:absolute; inline-size:1px; block-size:1px; padding:0; margin:-1px; overflow:hidden;
        clip-path:inset(50%); white-space:nowrap; border:0; }
      @media (max-width:420px) {
        .controls { grid-template-columns:1fr; }
        .drawer { inline-size:calc(100vw - 16px); }
        dl { grid-template-columns:1fr; }
      }
      @media (prefers-reduced-motion:reduce) { * { scroll-behavior:auto !important; } }
      @media (forced-colors:active) { .type { border:1px solid CanvasText; } }
    `, `<button part="trigger" class="trigger" type="button" aria-label="${escapeHtml(label)}"
        title="${escapeHtml(label)}" aria-expanded="false" aria-controls="artifact-quick-panel">
        ${ICONS.chevron}</button>
      <section class="drawer" id="artifact-quick-panel" popover="auto" hidden aria-labelledby="artifact-quick-title">
        <div class="shell">
          <header class="head"><h2 id="artifact-quick-title">Recent artifacts</h2>
            <button class="close" type="button" aria-label="Close quick access artifacts">${ICONS.close}</button></header>
          <div class="controls">
            <label for="artifact-quick-search">Search artifacts
              <input id="artifact-quick-search" type="search" autocomplete="off" placeholder="Name or owner">
            </label>
            <label for="artifact-quick-type">Filter by type
              <select id="artifact-quick-type">
                <option value="all">All types</option><option value="html">HTML</option>
                <option value="text">Text</option><option value="json">JSON</option>
                <option value="image">Image</option><option value="data">Data</option>
              </select>
            </label>
          </div>
          <p class="summary" id="artifact-quick-summary"></p>
          <ul class="list" id="artifact-quick-list" aria-label="Artifacts"></ul>
          <div class="foot"><button type="button" class="browse">Browse all artifacts</button></div>
          <span class="sr-only" id="artifact-quick-live" role="status" aria-live="polite"></span>
        </div>
      </section>`);
    this._trigger = this._root.querySelector(".trigger");
    this._drawer = this._root.querySelector(".drawer");
    this._search = this._root.querySelector("input[type=search]");
    this._select = this._root.querySelector("select");
    this._list = this._root.querySelector(".list");
    this._summary = this._root.querySelector(".summary");
    this._live = this._root.querySelector("#artifact-quick-live");
    this._renderList();
  }

  _wire() {
    this._trigger?.addEventListener("click", () => this.toggleDrawer());
    this._root.querySelector(".close")?.addEventListener("click", () => this.close());
    this._root.querySelector(".browse")?.addEventListener("click", () => {
      this.close({ returnFocus: false });
      this._emit("browse-artifacts");
    });
    this._search?.addEventListener("input", () => {
      this._query = this._search.value.slice(0, ARTIFACT_QUICK_LIMITS.maxQuery);
      if (this._search.value !== this._query) this._search.value = this._query;
      this._renderList();
    });
    this._select?.addEventListener("change", () => {
      this._type = this._select.value;
      this._renderList();
    });
    this._drawer?.addEventListener("toggle", (event) => {
      if (event.newState === "closed") this._finishClose();
    });
    // Native auto-popover supplies Escape + light-dismiss. These listeners are
    // the equivalent fallback and also make the focus-return contract explicit.
    this._bindDocument("keydown", (event) => {
      if (event.key === "Escape" && this._open) {
        event.preventDefault();
        this.close();
      }
    });
    this._bindDocument("pointerdown", (event) => {
      // A pointer destination owns focus. Light-dismiss without returning focus
      // to the trigger, or the queued trigger focus would steal it after click.
      if (this._open && !event.composedPath().includes(this)) {
        this.close({ returnFocus: false });
      }
    });
    if (!this._resizeHandler) {
      this._resizeHandler = () => { if (this._open) this._position(); };
      window.addEventListener("resize", this._resizeHandler);
    }
  }

  toggleDrawer() { this._open ? this.close() : this.open(); }
  focusTrigger() { this._trigger?.focus(); }

  async open() {
    if (this._open || !this._drawer) return;
    this._open = true;
    this._trigger?.setAttribute("aria-expanded", "true");
    this._drawer.hidden = false;
    if (typeof this._drawer.showPopover === "function") {
      try { this._drawer.showPopover(); }
      catch { this._drawer.removeAttribute("popover"); /* use the visible fixed fallback */ }
    }
    this._position();
    this._search?.focus();
    this._emit("drawer-toggle", { open: true });
    if (this.hasAttribute("auto")) await this.refresh();
  }

  close({ returnFocus = true } = {}) {
    if (!this._open) return;
    this._returnFocus = returnFocus;
    if (typeof this._drawer?.hidePopover === "function") {
      try { this._drawer.hidePopover(); } catch { /* already closed */ }
    }
    this._finishClose();
  }

  _finishClose() {
    if (!this._open) return;
    const returnFocus = this._returnFocus;
    this._returnFocus = true;
    this._open = false;
    if (this._drawer) this._drawer.hidden = true;
    this._trigger?.setAttribute("aria-expanded", "false");
    this._emit("drawer-toggle", { open: false });
    if (returnFocus) setTimeout(() => this._trigger?.focus(), 0);
  }

  _position() {
    const rect = this._trigger?.getBoundingClientRect?.();
    const drawer = this._drawer;
    if (!rect || !drawer) return;
    const margin = 12;
    const gap = 8;
    const width = drawer.offsetWidth || Math.min(380, window.innerWidth - margin * 2);
    const height = drawer.offsetHeight || Math.min(620, window.innerHeight - margin * 2);
    const rtl = (getComputedStyle(this).direction || document.documentElement?.dir) === "rtl";
    const outward = rtl ? rect.left - width - gap : rect.right + gap;
    const opposite = rtl ? rect.right + gap : rect.left - width - gap;
    const preferredFits = outward >= margin && outward + width <= window.innerWidth - margin;
    let left = preferredFits ? outward : opposite;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    let top = rect.bottom - height;
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    drawer.style.inset = "auto";
    drawer.style.left = `${left}px`;
    drawer.style.top = `${top}px`;
  }

  async refresh() {
    if (!RUNTIME_SEND) return;
    const seq = ++this._requestSeq;
    this._state = "loading";
    this._renderList();
    try {
      const res = await RUNTIME_SEND("asset.list", {
        origin: this.getAttribute("origin") || "master",
      });
      if (seq !== this._requestSeq) return;
      if (!res || res.ok === false || !Array.isArray(res.assets)) {
        throw new Error(res?.error || "asset list unavailable");
      }
      this._artifacts = res.assets;
      this._state = "ready";
      this._error = "";
    } catch (error) {
      if (seq !== this._requestSeq) return;
      this._state = "error";
      this._error = String(error?.message ?? error);
    }
    this._renderList();
  }

  _announce(text) {
    clearTimeout(this._announceTimer);
    this._announceTimer = setTimeout(() => {
      if (this._live) this._live.textContent = text;
    }, 200);
  }

  _renderList() {
    if (!this._list || !this._summary) return;
    this._list.replaceChildren();
    // Loading, filtering and fetched results all change block size. Re-clamp
    // after layout so the final drawer (not its initial loading shell) stays
    // inside the viewport with every action reachable.
    if (this._open) {
      setTimeout(() => { if (this._open) this._position(); }, 0);
    }
    if (this._state === "loading") {
      this._summary.textContent = "Loading artifacts…";
      this._announce("Loading artifacts");
      return;
    }
    if (this._state === "error") {
      this._summary.textContent = "";
      const row = document.createElement("li");
      row.className = "state error";
      const message = document.createElement("span");
      message.textContent = `Couldn't load artifacts — ${this._error || "unknown error"}.`;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => this.refresh());
      row.append(message, retry);
      this._list.append(row);
      this._announce("Couldn't load artifacts");
      return;
    }

    const selected = selectQuickArtifacts(this._artifacts, { query: this._query, type: this._type });
    const suffix = selected.limited ? ` Showing the first ${selected.items.length}.` : "";
    const truncation = selected.sourceTruncated
      ? ` The artifact index exceeded ${ARTIFACT_QUICK_LIMITS.maxSource}; only its newest ${ARTIFACT_QUICK_LIMITS.maxSource} entries were searched.`
      : "";
    this._summary.textContent = `${selected.total} ${selected.total === 1 ? "artifact" : "artifacts"}.${suffix}${truncation}`;
    this._announce(`${selected.total} ${selected.total === 1 ? "artifact" : "artifacts"}`);

    if (!selected.items.length) {
      const row = document.createElement("li");
      row.className = "state";
      row.textContent = this._query || this._type !== "all"
        ? "No artifacts match this search and filter."
        : "No artifacts yet. Ask an agent to make something.";
      this._list.append(row);
      return;
    }

    for (const artifact of selected.items) {
      const row = document.createElement("li");
      row.className = "item";
      const head = document.createElement("div");
      head.className = "item-head";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = artifact.name;
      const type = document.createElement("span");
      type.className = "type";
      type.textContent = artifact.type;
      head.append(name, type);

      const meta = document.createElement("dl");
      const time = formatQuickArtifactTime(artifact.at);
      const facts = [
        ["Owner", quickArtifactOwner(artifact.origin), null],
        ["Type", artifact.type, null],
        ["Size", formatQuickArtifactSize(artifact.size), null],
        ["Created", time.label, time.datetime],
      ];
      for (const [term, value, datetime] of facts) {
        const pair = document.createElement("div");
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        if (datetime) {
          const timeEl = document.createElement("time");
          timeEl.dateTime = datetime;
          timeEl.textContent = value;
          dd.append(timeEl);
        } else dd.textContent = value;
        pair.append(dt, dd);
        meta.append(pair);
      }

      const actions = document.createElement("div");
      actions.className = "actions";
      for (const [action, visible] of [["artifact-open", "Open"], ["artifact-reuse", "Reuse"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "action";
        const label = document.createElement("span");
        label.textContent = visible;
        const context = document.createElement("span");
        context.className = "sr-only";
        context.textContent = ` ${artifact.name}`;
        button.append(label, context);
        button.addEventListener("click", () => {
          this.close({ returnFocus: false });
          this._emit(action, { artifact: { ...artifact } });
        });
        actions.append(button);
      }
      row.append(head, meta, actions);
      this._list.append(row);
    }
  }
}
customElements.define("artifact-quick-drawer", ArtifactQuickDrawer);
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

/* ── the structured tool-call renderer (UI-FIXES-TRACKER item 4) ─────────
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
  // product itself minted: `shot_<digits>_<base36>`. Bounded (8 KiB scanned,
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
  if (!text) return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
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

  // RAW JSON + COPY (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01). The owner asked
  // for "the ability to see JSON input and response better" — before this there
  // was no raw view and no copy button anywhere on the normal tool path, only
  // the structured tree. The toggle lives in the block header so both inputs
  // and result get one, and the choice is remembered per block for the session.
  const controls = document.createElement("span");
  controls.className = "tt-block-controls";
  const rawBtn = document.createElement("button");
  rawBtn.type = "button";
  rawBtn.className = "tt-raw-toggle";
  rawBtn.textContent = "JSON";
  rawBtn.title = "Show the raw JSON";
  rawBtn.setAttribute("aria-pressed", "false");
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "tt-copy-all";
  copyBtn.textContent = "Copy";
  copyBtn.title = `Copy the ${label} as JSON`;
  controls.appendChild(rawBtn);
  controls.appendChild(copyBtn);
  summary.appendChild(controls);
  details.appendChild(summary);

  const rawPre = document.createElement("pre");
  rawPre.className = "tt-raw";
  rawPre.textContent = safeJsonStringify(value);

  // Which view the owner last chose, remembered per block. It rides in the same
  // Map as the expansion state under a namespaced key that can never collide
  // with a block label, so the choice survives the attribute updates that
  // rebuild the card while a tool is still running — without a second store.
  const rawStateKey = `__raw__:${label}`;
  const rawWanted = expandedState?.get(rawStateKey) === true;
  rawPre.hidden = !rawWanted;

  // A click on a control inside <summary> must not also toggle the <details>.
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  rawBtn.addEventListener("click", (e) => {
    stop(e);
    const showRaw = rawPre.hidden;
    rawPre.hidden = !showRaw;
    rawBtn.setAttribute("aria-pressed", showRaw ? "true" : "false");
    rawBtn.className = showRaw ? "tt-raw-toggle on" : "tt-raw-toggle";
    const treeEl = details.querySelector(".tt-tree");
    if (treeEl) treeEl.hidden = showRaw;
    if (!details.open) details.open = true;
    expandedState?.set(rawStateKey, showRaw);
  });
  copyBtn.addEventListener("click", async (e) => {
    stop(e);
    const text = safeJsonStringify(value);
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied";
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); copyBtn.textContent = "Copied"; } catch { copyBtn.textContent = "Copy"; }
      ta.remove();
    }
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1600);
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
export function buildToolCardDom({ name, status, args, result, detail, duration, expandedState, cardExpanded = false, onCardToggle }) {
  // The card is NOT a live region: re-rendering a 200-row tree would announce
  // the whole card on every attribute update (the a11y finding). The COMPACT
  // status chip is the live region — it carries the compact state text only.
  const card = document.createElement("details");
  card.className = "tool";
  card.open = cardExpanded === true;
  if (typeof onCardToggle === "function") {
    card.addEventListener("toggle", () => onCardToggle(card.open));
  }

  const summary = document.createElement("summary");
  summary.className = "tool-head";
  // THE CARD IS HEADED BY THE TOOL THAT RAN (§9). Under the lazy protocol the
  // call arrives as `execute_tool` and the invoked tool is named inside the
  // payload; the live path corrects the attribute once the result lands, but
  // a replayed or still-running card must never read "execute_tool" either.
  const lazyName = name === "execute_tool" || name === "search_tools"
    ? (unwrapToolPayload(result).selectedTool || unwrapToolPayload(detail).selectedTool || null)
    : null;
  const shownName = lazyName || (name === "execute_tool" ? "tool call" : (name || "tool"));
  const nameEl = document.createElement("span");
  nameEl.className = "tool-name";
  nameEl.textContent = shownName;
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

  // THE COLLAPSED CARD MUST ANSWER "what happened" WITHOUT A CLICK
  // (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01). It used to show only the tool
  // name, a status chip and a duration — so a successful call said nothing
  // (the one-line summary was already computed and simply not rendered), and a
  // FAILED call showed no error text at all, which is backwards for the one
  // state the owner most needs to read.
  const headline = toolHeadline(status, result, detail);
  if (headline) {
    const lead = document.createElement("span");
    lead.className = status === "error" ? "tool-lead error" : "tool-lead";
    lead.textContent = headline;
    lead.title = headline; // the full text on hover when the line is clipped
    summary.appendChild(lead);
  }

  // The human line on the COLLAPSED row (the owner's tool-call clarity
  // finding): "Searching tools for “daily notes”", "Opening https://…" —
  // computed from the tool name + its (already-redacted) arguments. The args
  // attribute is a JSON string when structured; a parse failure just means no
  // argument interpolation, never a broken card.
  let what = "";
  try {
    const parsedArgs = shownArgs != null && shownArgs !== "" ? safeParseOnce(shownArgs) : null;
    what = describeToolCall(lazyName || name, parsedArgs && parsedArgs.kind === "json" ? parsedArgs.value : shownArgs);
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
        body.appendChild(div);
        return;
      }
      const tree = buildTree(shown);
      if (tree.rows.length >= 1) {
        body.appendChild(buildToolTreeBlock(label, shown, tree.rows, tree.maxNodes, expandedState));
        return;
      }
    }
    // A transport envelope that did not parse (a truncated copy) is never
    // painted: the headline already carries the tool's own words (§10).
    if (looksLikeBrokenEnvelope(parsed.value ?? raw)) return;
    const div = document.createElement("div");
    div.className = `tool-plain tool-plain-${label}`;
    div.textContent = String(parsed.value ?? raw ?? "");
    body.appendChild(div);
  };

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

  addBlock("inputs", shownArgs);

  const resultParsed = result != null && result !== "" ? safeParseOnce(result) : null;
  const detailParsed = detail != null && detail !== "" ? safeParseOnce(detail) : null;

  if (resultParsed && resultParsed.kind === "json") {
    // result itself is structured JSON -> render as "result" tree block.
    // Strip the envelope here too: this branch bypasses addBlock, which is why
    // an error result still rendered `ok false` and repeated its own message as
    // tree rows under the headline that already said it.
    const shownResult = stripToolEnvelope(resultParsed.value, status);
    const tree = shownResult === undefined || typeof shownResult === "string" ? { rows: [], maxNodes: 0 } : buildTree(shownResult);
    if (tree.rows.length >= 1) {
      body.appendChild(buildToolTreeBlock("result", shownResult, tree.rows, tree.maxNodes, expandedState));
    } else if (shownResult === undefined) {
      // Everything the payload carried is already in the head. Render nothing
      // rather than an empty block.
    } else if (!looksLikeBrokenEnvelope(typeof shownResult === "string" ? shownResult : (resultParsed.value ?? result))) {
      const div = document.createElement("div");
      div.className = "tool-plain tool-plain-result";
      div.textContent = typeof shownResult === "string" ? shownResult : String(resultParsed.value ?? result ?? "");
      body.appendChild(div);
    }
    if (detail != null && detail !== "" && detail !== result) {
      addBlock("detail", detail);
    }
  } else if (detailParsed && detailParsed.kind === "json") {
    // The live event path stores the raw lazy envelope in detail, so consume
    // its selected output schema exactly as the direct/replay branch does.
    const shownDetail = stripToolEnvelope(detailParsed.value, status);
    const tree = shownDetail === undefined || typeof shownDetail === "string" ? { rows: [], maxNodes: 0 } : buildTree(shownDetail);
    if (tree.rows.length >= 1) {
      body.appendChild(buildToolTreeBlock("result", shownDetail, tree.rows, tree.maxNodes, expandedState));
    } else if (shownDetail !== undefined && !looksLikeBrokenEnvelope(shownDetail)) {
      const div = document.createElement("div");
      div.className = "tool-plain tool-plain-result";
      div.textContent = typeof shownDetail === "string" ? shownDetail : String(detailParsed.value ?? detail ?? "");
      body.appendChild(div);
    }
  } else {
    // Neither is JSON -> honest plain text fallback
    if (result != null && result !== "") addBlock("result", result);
    if (detail != null && detail !== "" && detail !== result) addBlock("detail", detail);
  }
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
/* <agent-identity name="Researcher" avatar="data:image/svg+xml…" time="1756550400000">
 * The one identity header for a conversation turn: a 24px avatar (the agent's
 * generated avatar image when it has one, otherwise an inline-SVG initial in
 * the accent — never an emoji), the name, and a <time datetime> stamp
 * (CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01). Used by <message-bubble> on
 * assistant turns; reuse it anywhere a turn needs a "who + when". */
class AgentIdentity extends Component {
  static get observedAttributes() { return ["name", "avatar", "time"]; }
  _render() {
    const name = (this.getAttribute("name") || "Agent").trim() || "Agent";
    const avatar = String(this.getAttribute("avatar") || "");
    // Only an image data URL or https is ever set as a src (no javascript:).
    const avatarOk = /^(data:image\/|https:\/\/)/iu.test(avatar);
    const initial = ([...name][0] || "A").toUpperCase();
    const t = turnTime(this.getAttribute("time"));
    const avatarMarkup = avatarOk
      ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="" width="24" height="24">`
      : `<svg class="avatar" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="var(--panel,#fff)" stroke="currentColor" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor" font-family="system-ui,sans-serif">${escapeHtml(initial)}</text></svg>`;
    mountTemplate(this, `
      :host { display:inline-flex; align-items:center; gap:8px; min-width:0; color:var(--accent,#0e6e63); line-height:1; }
      .avatar { width:24px; height:24px; border-radius:50%; flex:0 0 auto; display:block; object-fit:cover; }
      .name { font-size:12.5px; font-weight:600; color:var(--ink,#1d1b18); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
      time { font-size:12px; color:var(--muted,#635e56); font-variant-numeric:tabular-nums; white-space:nowrap; }
    `, `${avatarMarkup}<span class="name">${escapeHtml(name)}</span>${t ? `<time datetime="${escapeHtml(t.iso)}" title="${escapeHtml(t.full)}">${escapeHtml(t.label)}</time>` : ""}`);
  }
}
customElements.define("agent-identity", AgentIdentity);

class MessageBubble extends Component {
  static get observedAttributes() {
    return ["role", "content", "attachments", "tool-name", "tool-status", "tool-args", "tool-result", "tool-detail", "tool-duration", "step", "total-steps", "error-reason", "error-action", "error-category", "author", "author-avatar", "ts"];
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
    if (typeof this.removeAttribute === "function") this.removeAttribute("streaming");
    const role = this.getAttribute("role") || "agent";
    const content = this._content();
    const style = `
      :host { display:flex; margin:0 0 14px; justify-content:flex-start; }
      :host(:last-child) { margin-bottom:0; }
      :host([role="user"]) { justify-content:flex-end; }
      .msg { max-width:78%; border-radius:12px; padding:10px 14px; overflow-wrap:anywhere; }
      /* An assistant turn: the identity header (avatar · name · time) above the bubble. */
      .turn { display:flex; flex-direction:column; gap:6px; max-width:78%; min-width:0; }
      .turn .msg { max-width:100%; }
      .turn agent-identity { padding-inline-start:2px; }
      .body { font-size:14px; line-height:1.55; color:var(--ink,#1d1b18); }
      .body .cite-ref a { color:var(--accent,#0e6e63); text-decoration:none; font-size:0.75em; margin-left:1px; }
      :host([role="user"]) .msg { background:var(--secondary-layer,#efede8); }
      :host([role="agent"]) .msg, :host([role="system"]) .msg { background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); }
      :host([role="error"]) .msg { background:var(--panel,#ffffff); border:1px solid var(--danger,#b3261e); }
      :host([role="error"]) .body { color:var(--danger,#b3261e); }
      .err-reason { font-weight:600; margin:0 0 4px; }
      .err-action { color:var(--ink,#1d1b18); margin:0 0 8px; }
      .err-fix { font:inherit; font-size:12.5px; font-weight:600; color:var(--accent,#0e6e63); background:transparent; border:1px solid var(--accent,#0e6e63); border-radius:6px; padding:4px 10px; cursor:pointer; }
      .err-fix:hover { background:var(--accent,#0e6e63); color:var(--btn-fg,#fff); }
      .err-fix:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
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
      /* rendered HTML output — the sandboxed iframe */
      .html-frame { margin-top:4px; width:100%; display:flex; flex-direction:column; }
      .html-frame iframe { width:100%; min-height:360px; height:480px; max-height:80vh; border:1px solid var(--border,#e3e0d9); border-radius:8px; background:#fff; resize:vertical; display:block; }
      .genui { width:100%; max-width:840px; }
      .genui-head { font-size:12px; font-weight:600; color:var(--muted,#635e56); margin:0 0 6px; }
      .genui .html-frame iframe { width:100%; min-height:360px; height:520px; max-height:80vh; }
      .genui-raw { margin-top:8px; width:100%; }
      .genui-raw summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:6px; color:var(--muted,#635e56); font-size:11.5px; padding:4px 0; user-select:none; }
      .genui-raw summary::-webkit-details-marker { display:none; }
      .genui-raw summary:hover { color:var(--text,#1d1b18); }
      .genui-raw .tool-detail-raw { margin-top:4px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11.5px; color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; max-height:180px; overflow:auto; background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9); border-radius:6px; padding:6px 8px; }
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
      .tool .tool-name { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; font-weight:600; color:var(--ink,#1d1b18); white-space:nowrap; }
      /* the collapsed row's human line (what the tool is DOING, not just its id) */
      .tool .tool-what { font-size:12.5px; color:var(--muted,#635e56); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1 1 auto; }
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
      /* the structured tool-call tree (tracker item 4) */
      .tool .tool-duration { margin-left:auto; font-size:11px; color:var(--muted,#635e56); font-variant-numeric:tabular-nums; }
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
      .tool .tt-tree { padding:2px 6px 6px; max-height:200px; overflow:auto; }
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
      .tool .tt-block-controls button { font:inherit; font-size:11px; line-height:1;
        padding:3px 7px; border:1px solid var(--border,#e3e0d9); border-radius:999px;
        background:var(--panel,#ffffff); color:var(--muted,#635e56); cursor:pointer; }
      .tool .tt-block-controls button:hover { border-color:var(--accent,#0e6e63); color:var(--ink,#1d1b18); }
      .tool .tt-block-controls button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .tool .tt-block-controls button.on { background:var(--accent,#0e6e63); border-color:transparent; color:var(--btn-fg,#ffffff); }
      .tool .tt-raw { margin:0; padding:10px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        font-size:11.5px; line-height:1.45; color:var(--ink,#1d1b18); background:var(--panel-2,#efede8);
        white-space:pre-wrap; word-break:break-word; overflow-x:auto; max-height:320px; }
      .tool .tt-key { color:var(--accent,#0e6e63); font-weight:600; white-space:nowrap; }
      .tool .tt-val { color:var(--ink,#1d1b18); overflow-wrap:anywhere; min-width:0; }
      .tool .tt-val-string { color:var(--ink,#1d1b18); }
      .tool .tt-val-number, .tool .tt-val-boolean { color:var(--accent,#0e6e63); }
      .tool .tt-val-null { color:var(--muted,#635e56); font-style:italic; }
      .tool .tt-kind { color:var(--muted,#635e56); font-size:11px; margin-left:2px; }
      /* The row's identity. It takes the width so the type label is what gets
         squeezed on a narrow card, not the content. */
      .tool .tt-preview { color:var(--fg,#1c1a17); font-size:11px; margin-left:6px;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1 1 auto; }
      .tool .tt-kind.muted { opacity:.6; flex:0 0 auto; }
      .tool .tt-copy { margin-left:auto; flex:0 0 auto; font:inherit; font-size:11px; color:var(--muted,#635e56); background:transparent; border:1px solid var(--border,#e3e0d9); border-radius:5px; padding:1px 7px; cursor:pointer; opacity:0; transition:opacity .12s ease; }
      .tool .tt-row:hover .tt-copy, .tool .tt-copy:focus-visible { opacity:1; }
      .tool .tt-copy:hover { color:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); }
      .tool .tt-copy:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:0; }
      .tool .tool-plain { padding:6px 10px; font-size:12.5px; color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere; border-top:1px solid var(--border,#e3e0d9); }
      @media (prefers-reduced-motion: reduce) { .tool .tt-toggle .tt-caret { transition:none; } .tool .tt-copy { transition:none; } }
    `;
    let markup;
    if (role === "tool") {
      const name = this.getAttribute("tool-name") || "tool";
      const statusRaw = this.getAttribute("tool-status") || "running";
      // "done" (an unpaired replay card), "success" and "error" are terminal —
      // anything else (running/absent) renders the running state. A missing
      // result must never re-open a card as running (the replay blocker).
      const status = statusRaw === "done" || statusRaw === "success"
        ? "done"
        : statusRaw === "error" ? "error" : "running";
      const args = this.getAttribute("tool-args");
      const result = this.getAttribute("tool-result");
      const detail = this.getAttribute("tool-detail");
      // A FAILED tool call must never render the generated-UI preview: the
      // args alone carry the HTML (e.g. update_asset's content), so a denied
      // or errored call used to mount the sandbox frame and sit forever on
      // "Preparing restricted preview…" — a success-looking skeleton over a
      // result that says the opposite. Detect the failure (status attribute,
      // or the envelope's ok:false / error string, unwrapping the nested
      // modelContent/result layers) and fall through to the structured card,
      // which renders the error headline and opens itself.
      const resultFailed = toolResultSignalsError(status, result);
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
          duration: this.getAttribute("tool-duration"),
          expandedState: this._ttExpanded,
          cardExpanded: this._toolCardExpanded === true,
          onCardToggle: (open) => { this._toolCardExpanded = open === true; },
        });
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
      // "No output generated. Check the stream for errors". A provider/config
      // failure gets a "Fix in Settings" button (the actionable path: the
      // provider pane's Test/Use button grants the host permission + tests the
      // key).
      const reason = this.getAttribute("error-reason") || content;
      const action = this.getAttribute("error-action") || "";
      const category = this.getAttribute("error-category") || "";
      const fixable = /host-permission|provider-auth|provider-config|model-config|network/i.test(category);
      markup = `<div class="msg error"><div class="body">
        <p class="err-reason">${escapeHtml(reason)}</p>
        ${action ? `<p class="err-action">${escapeHtml(action)}</p>` : ""}
        ${fixable ? `<button type="button" class="err-fix" part="fix">Fix in Settings</button>` : ""}
      </div></div>`;
    } else {
      let body;
      if ((role === "agent" || role === "system") && isHtmlDocument(content)) {
        body = renderHtmlFrame(content);
      } else {
        body = (role === "agent" || role === "system" || role === "user") ? renderMarkdown(content) : `<span class="plain">${renderInline(content)}</span>`;
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
      const bubble = `<div class="msg ${role}">${attachHtml}<div class="body">${body}</div></div>`;
      if (role === "agent") {
        const author = this.getAttribute("author") || "Agent";
        const avatar = this.getAttribute("author-avatar") || "";
        const ts = this.getAttribute("ts") || "";
        markup = `<div class="turn"><agent-identity name="${escapeHtml(author)}"${avatar ? ` avatar="${escapeHtml(avatar)}"` : ""}${ts ? ` time="${escapeHtml(ts)}"` : ""}></agent-identity>${bubble}</div>`;
      } else {
        markup = bubble;
      }
    }
    mountTemplate(this, style, markup);
    if (this._cardDom) {
      this._root.appendChild(this._cardDom);
      this._cardDom = null;
    }
  }
  _wire() {
    // The "Fix in Settings" button on a provider/config error: open the options
    // page (the provider pane's Test/Use button grants the host permission +
    // tests the key — the actionable path for a provider failure).
    this._root.querySelector(".err-fix")?.addEventListener("click", () => {
      if (typeof chrome !== "undefined" && chrome.runtime?.openOptionsPage) {
        chrome.runtime.openOptionsPage();
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
class AgentConversation extends Component {
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
    return {
      author: this.getAttribute("agent-name") || null,
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
    card.setAttribute("actions", "open-tab reuse");
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
   *  best-effort: a slow or absent worker leaves the card's type placeholder. */
  _loadArtifactPreview(card, origin, id) {
    if (!RUNTIME_SEND) return;
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
    const durationMs = m.durationMs ?? m["tool-duration"];
    if (typeof m.ts === "number") this._maybeTsGap(m.ts);
    return this._bubble("tool", null, {
      "tool-name": name,
      "tool-status": status || "running",
      "tool-args": toolPayloadAttribute(args),
      "tool-result": toolPayloadAttribute(result),
      "tool-detail": toolPayloadAttribute(detail),
      "tool-duration": durationMs != null ? String(durationMs) : null,
    });
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
      : JSON.stringify([req.permissions ?? [], req.grantOrigins ?? [], req.grantGlobal === true]);
    if (!this._approvalKeys) this._approvalKeys = new Map();
    if (this._approvalKeys.has(key)) return this._approvalKeys.get(key);
    const card = document.createElement("permission-approval-card");
    card.setAttribute("reason", String(req.reason ?? "perform this action").slice(0, 240));
    if (Array.isArray(req.permissions) && req.permissions.length) card.setAttribute("permissions", JSON.stringify(req.permissions.slice(0, 8)));
    if (Array.isArray(req.grantOrigins) && req.grantOrigins.length) card.setAttribute("origins", JSON.stringify(req.grantOrigins.slice(0, 50)));
    if (req.grantGlobal === true) card.setAttribute("global", "true");
    if (typeof m.state === "string" && m.state) card.setAttribute("state", m.state);
    if (typeof m.detail === "string" && m.detail) card.setAttribute("detail", m.detail);
    const emit = (approve, ev) => this.dispatchEvent(new CustomEvent("approval-decision", {
      bubbles: true,
      detail: {
        approve,
        requirement: req,
        executionId: m.executionId ?? null,
        toolCallId: m.toolCallId ?? null,
        card,
        sourceEvent: ev?.detail?.sourceEvent ?? null,
      },
    }));
    card.addEventListener("approve", (ev) => emit(true, ev));
    card.addEventListener("deny", (ev) => emit(false, ev));
    if (typeof m.ts === "number") this._maybeTsGap(m.ts);
    this._approvalKeys.set(key, card);
    return this.appendTranscript(card);
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
    for (const [name, value] of [["activity", next.activity], ["message", next.message], ["error-reason", next.errorReason], ["action-label", next.actionLabel], ["execution-id", next.executionId]]) {
      if (value) row.setAttribute(name, value);
      else row.removeAttribute(name);
    }
    // Append LAST so the row is the newest thing in the flow; the sticky
    // bottom pin keeps it visible even when the owner scrolls up.
    this.appendChild(row);
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
class ScreenshotStrip extends Component {
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
        <img src="${escapeHtml(src || "")}" alt="" loading="lazy">
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
class ScreenshotThumb extends Component {
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
      figcaption { font-size:11px; color:var(--muted,#635e56); overflow-wrap:anywhere; }
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
class AgentComposer extends Component {
  /** Focus the task input. Public so a route (the keyboard "new task" command
   * lands on "#compose") can put the caret in the composer without reaching
   * into the shadow root from outside. Safe before connect: no-ops. */
  focusInput() {
    const el = this._input ?? this._root?.querySelector("#task-input");
    el?.focus?.();
    return !!el;
  }

  static shadow() { return false; }
  static get observedAttributes() { return ["placeholder", "label", "description", "send-label", "agent-id", "agent-kind"]; }
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
  _render() {
    const placeholder = this.getAttribute("placeholder") || "Ask anything, or @mention an agent…";
    const label = this.getAttribute("label") || "Message";
    const description = this.getAttribute("description") || "Type @ to mention any named, background, or Site Agent.";
    const sendLabel = this.getAttribute("send-label") || "Run task";
    const currentAgent = this._currentAgentId;
    const html = `
      <div class="composer" part="composer">
        <span class="sr-only" id="composer-description-${this._uid}">${escapeHtml(description)}</span>
        <textarea id="task-input" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(label)}"
          aria-describedby="composer-description-${this._uid}" aria-haspopup="listbox" aria-expanded="false"
          aria-controls="popup-${this._uid}" aria-multiline="true" rows="2"></textarea>
        <div class="popup" id="popup-${this._uid}" role="listbox" aria-label="Agent and resource mentions" hidden></div>
        <div class="chips" id="chips"></div>
        <div class="row">
          <mic-button id="mic"></mic-button>
          <attach-button id="attach"></attach-button>
          <span class="spacer"></span>
          <button id="run-task" class="btn send" type="button">${escapeHtml(sendLabel)}</button>
        </div>
        <div class="agent-pop" id="agent-pop" popover="manual" hidden>
          <agent-picker id="agent-pick" callable-only label="Run with agent"
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
      agent-composer .composer { position:relative; background:var(--panel,#ffffff); border:1px solid var(--border,#e3e0d9); border-radius:12px; padding:14px; anchor-name:--composer-anchor; }
      agent-composer .composer:focus-within { border-color:var(--accent,#0e6e63); }
      agent-composer .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
        clip:rect(0,0,0,0); white-space:nowrap; border:0; }
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
      agent-composer .popup .group-label { padding:6px 10px 2px; font-size:11px; font-weight:700;
        color:var(--muted,#635e56); letter-spacing:.01em; }
      agent-composer .composer textarea { width:100%; background:transparent; border:0; color:var(--text,#1d1b18); font:inherit; resize:none; overflow-y:hidden; min-height:44px; outline:none; line-height:1.45; }
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
      /* the agent chip (the + menu's Choose agent / a committed /agent: option):
         the ONE canonical selected agent, removable before send. */
      agent-composer .composer .chips .chip.agent-chip { border-color:var(--accent,#0e6e63);
        color:var(--accent,#0e6e63); font-weight:600; }
      agent-composer .composer .chips .chip.agent-chip .agent-initial { width:18px; height:18px;
        border-radius:50%; border:1px solid var(--accent,#0e6e63); display:inline-flex; align-items:center;
        justify-content:center; font-size:10px; font-weight:700; }
      agent-composer .composer .chips .chip.agent-chip button { color:var(--accent,#0e6e63); min-width:24px; min-height:24px; }
      /* the + menu's Choose agent popover: the shared <agent-picker> in the top
         layer, anchored to the + button (logical anchor positioning + edge
         flipping; a JS fallback where anchor positioning is unsupported). */
      agent-composer attach-button { anchor-name:--composer-attach; }
      agent-composer .agent-pop { position:absolute; inset:auto; margin:0; padding:10px;
        width:min(380px, calc(100vw - 24px)); background:var(--panel,#ffffff);
        border:1px solid var(--border,#e3e0d9); border-radius:12px;
        box-shadow:var(--shadow-2, 0 12px 32px rgba(29,27,24,.12)); z-index:60;
        position-anchor:--composer-attach; position-area:block-start span-inline-end;
        position-try-fallbacks:flip-block, flip-inline; }
      @supports not (position-area: top) {
        agent-composer .agent-pop { position:fixed; }
      }
      agent-composer .agent-pop[hidden] { display:none; }
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
    this._input = this._root.querySelector("#task-input");
    this._mic = this._root.querySelector("#mic");
    this._attach = this._root.querySelector("#attach");
    this._run = this._root.querySelector("#run-task");
    this._status = this._root.querySelector(".composer-status");
    this._popup = this._root.querySelector(".popup");
    this._chips = this._root.querySelector("#chips");
    this._agentPop = this._root.querySelector("#agent-pop");
    this._agentPick = this._root.querySelector("#agent-pick");
    this._popupItems = [];
    this._popupActive = -1;
    this._popupToken = null;
    this._slashAgentToken = null; // { start, end } while /agent: drives the picker
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
    this._run?.addEventListener("click", () => this._send());
    this._input?.addEventListener("input", () => this._onComposerInput());
    this._input?.addEventListener("keydown", (e) => {
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
        if (e.key === "Tab") { e.preventDefault(); this._selectActive(); return; }
        if (e.key === "Escape") { e.preventDefault(); this._hidePopup(); return; }
        return;
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
    this._attach?.addEventListener("attach-error", (e) => this.setStatus(e.detail?.message || "attachment rejected", false));
    this._mic?.addEventListener("mic-error", (e) => this.setStatus(e.detail?.message || "mic error", false));
    // the + menu's "Choose agent" → the shared <agent-picker> in a top-layer
    // popover anchored to the + button.
    this._attach?.addEventListener("choose-agent", () => this._openAgentPicker());
    this._agentPick?.addEventListener("agent-select", (e) => {
      const detail = e.detail ?? {};
      // Slash mode: replace the /agent:… token with the CANONICAL textual
      // reference (/agent:named:<id> — never the ambiguous bare-id form).
      const token = this._slashAgentToken;
      this._closeAgentPicker(token ? "input" : false);
      if (token && this._input && detail.ref) {
        this._input.setRangeText(`/agent:${detail.ref}`, token.start, token.end, "end");
        this._autoGrow();
      }
      this._setSelectedAgent(detail);
      this._input?.focus();
    });
    this._agentPick?.addEventListener("agent-cancel", () => {
      // Escape: close + revert — the typed text stays, nothing commits; focus
      // returns to the input in slash mode, to the + trigger otherwise.
      this._closeAgentPicker(this._slashAgentToken ? "input" : true);
    });
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
    this._renderAgentChip();
    this._emit("agent-change", { agent: { ...this._selectedAgent } });
  }

  /** Clear the selected agent (the chip's X, a stale registry entry, or the
   * host). Emits agent-change { agent: null, reason }. */
  clearSelectedAgent(reason = "") {
    if (!this._selectedAgent) return;
    this._selectedAgent = null;
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
    if (!supportsAnchorPositioning()) {
      placeFloating(this._attach, this._agentPop, { minWidth: 320 });
    }
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
    this._apObserver = new MutationObserver(() => {
      const active = this._agentPick?.querySelector?.('#ap-list [data-active="true"]');
      if (active?.id) this._input?.setAttribute("aria-activedescendant", active.id);
      else this._input?.removeAttribute("aria-activedescendant");
    });
    const apList = this._agentPick?.querySelector?.("#ap-list");
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
  set value(v) { if (this._input) { this._input.value = v; this._autoGrow(); } }
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
    let attachAsText = textLike && Number(file.size) <= MAX_LOCAL_TEXT_BYTES;
    let dataURL = "";
    let type = String(file.type || (textLike ? "text/plain" : "application/octet-stream"));
    if (attachAsText) {
      const read = RUNTIME_SEND
        ? await RUNTIME_SEND("fs-grant.read-file", {
          grantId: file.grantId,
          relativePath: file.relativePath,
          asText: true,
          maxBytes: MAX_LOCAL_TEXT_BYTES,
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
      : `Attached ${file.name} as a reference (${textLike && Number(file.size) > MAX_LOCAL_TEXT_BYTES ? "over 1 MiB" : "binary"}; contents weren't read).`);
  }

  // ── / command + @ mention popup ─────────────────────────────────────────
  get _popupOpen() { return !!(this._popup && !this._popup.hidden); }

  async _onComposerInput() {
    const input = this._input;
    if (!input) return;
    this._autoGrow();
    const text = input.value;
    const caret = input.selectionStart ?? text.length;

    // / command — STRICT command position only (shared/command-parser.js): the
    // "/" must be the FIRST character of the input and the token up to the
    // caret must be whitespace-free. Ordinary prose ("please inspect
    // /agent:pr"), URLs ("https://example.com/agent:foo"), and a leading-space
    // " /agent" NEVER open the command UI (the review's free-text false
    // positive); the token ends at the first space, so the task text after
    // "/agent:<ref> " is plain text again.
    const slash = parseSlashCommand(text, caret);
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
        const items = COMMAND_NAMESPACES
          .filter((n) => !ns || n.id.startsWith(ns) || n.label.startsWith(ns))
          .map((n) => ({ id: `cmd:${n.id}`, label: `/${n.label}`, description: n.description, kind: n.kind, ns: n.id }));
        this._showPopup(items, { type: "command", start: slashPos, end: caret, ns: "", arg: "" });
        return;
      }
      if (!ns) {
        // A colon with no namespace (e.g. "/:") — show all namespaces.
        const items = COMMAND_NAMESPACES.map((n) => ({
          id: `cmd:${n.id}`, label: `/${n.label}`, description: n.description, kind: n.kind, ns: n.id,
        }));
        this._showPopup(items, { type: "command", start: slashPos, end: caret, ns: "", arg: "" });
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

  _showPopup(items, token) {
    this._popupItems = items || [];
    this._popupToken = token || null;
    this._popupActive = this._popupItems.length ? 0 : -1;
    if (!this._popupItems.length) { this._hidePopup(); return; }
    this._renderPopupItems();
    if (this._popup) {
      this._popup.hidden = false;
      // Combobox contract (CAP-FB-20260830-SLASH-PALETTE-COMBOBOX-01): the
      // textarea owns the popup listbox while it is open — expanded true,
      // controls the popup, activedescendant the highlighted option.
      this._input?.setAttribute("aria-expanded", "true");
      this._input?.setAttribute("aria-controls", `popup-${this._uid}`);
      const active = this._popup.querySelector(`[data-index="${this._popupActive}"]`);
      if (active?.id) this._input?.setAttribute("aria-activedescendant", active.id);
            // Always position via the JS fallback (flips above/below + clamps). The
      // native CSS anchor positioning (position-area) proved unreliable for the
      // bottom-anchored composer (the popup fell off-screen), so the JS path
      // wins: it sets position:fixed + the correct top/left, overriding the CSS.
      placeFloating(this._root.querySelector(".composer"), this._popup, { fullWidth: true });
    }
  }

  _renderPopupItems() {
    if (!this._popup) return;
    this._popup.replaceChildren();
    let lastGroup = null;
    this._popupItems.forEach((it, i) => {
      // Group headers (the /agent list is grouped Named / Background / Site —
      // the same grouping as the shared <agent-picker>). Group names are
      // owner-controlled (agent kinds), so they go through textContent.
      if (it.group && it.group !== lastGroup) {
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

  _select(index) {
    const item = this._popupItems[index];
    const token = this._popupToken;
    const input = this._input;
    if (!item || !token || !input) { this._hidePopup(); return; }

    if (token.type === "command") {
      if (item.kind === "files-action") {
        input.setRangeText("", token.start, token.end, "end");
        this._hidePopup();
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
      if (item.kind === "capability") {
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
          if (selection.text !== fallbackText) {
            input.setRangeText(selection.text, token.start, token.start + fallbackText.length, "end");
          }
          if (selection.attachment) this._attachMedia(selection.attachment);
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

  _hidePopup() {
    if (this._popup) {
      this._popup.hidden = true;
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
    this._root.querySelector("#mic")?.stop?.();
    if (this._input) { this._input.value = ""; this._autoGrow(); }
    const pending = this.attachments.splice(0);
    this._clearChips();
    const agent = this._selectedAgent ? { ...this._selectedAgent } : null;
    this._selectedAgent = null;
    this._agentChip = null;
    this._emit("send", { text, attachments: pending, agent });
  }

  disconnectedCallback() {
    // No leak while the slash picker is open: the MutationObserver and the
    // document-level pointerdown listener must die with the element (the base
    // class clears _docListeners only — this element's picker mirror is tracked
    // separately).
    this._teardownPicker();
    super.disconnectedCallback?.();
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

/* <conversation-run-status state="queued|running|retrying|waiting-for-permission|completed|failed|cancelled">
 * is the ONE lifecycle surface in every task/agent conversation. It uses the
 * preferred pixel grid for every state (animated only while active), one atomic
 * live region, and an optional recovery action. No nested spinner/live region. */
class ConversationRunStatus extends Component {
  static get observedAttributes() {
    return ["state", "activity", "message", "error-reason", "action-label", "execution-id"];
  }
  _render() {
    const status = normalizeConversationRunStatus({
      state: this.getAttribute("state"),
      activity: this.getAttribute("activity"),
      message: this.getAttribute("message"),
      errorReason: this.getAttribute("error-reason"),
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
      .surface { display:flex; align-items:center; gap:12px; min-height:44px; padding:8px 12px; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-md,12px); background:var(--panel,#fff); color:var(--text,#1d1b18); box-shadow:0 4px 16px rgb(0 0 0 / .06); }
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
    this._root.querySelector(".action")?.addEventListener("click", () => this._emit("action"));
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

// Plan-strip line icons — one stroke weight, currentColor, drawn (never emoji).
const ICON_STEP_ACTIVE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" class="spin"><path d="M12 3a9 9 0 1 0 9 9"/></svg>';
const ICON_STEP_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_STEP_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
const ICON_PLAN_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
const ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

/* <plan-strip steps='[{"label":"Reading the page","status":"done"},…]' state="running|settled">
 * — the compact plan of a running multi-step task
 * (CAP-FB-20260830-PLAN-STRIP-CHECKPOINTS-01). The steps the run declared —
 * its tool calls, streamed through the progress port — render as a checklist:
 * the current step active, completed ones checked. It pins to the top of the
 * thread while the run is live and, on `done`, settles into a collapsed
 * "N steps" summary the owner can re-open. Built on a native <details> so the
 * summary is keyboard-toggleable for free; a single visually-hidden aria-live
 * region announces the step in flight without the checklist itself shouting.
 * Every label is escaped — a tool argument is untrusted content. */
class PlanStrip extends Component {
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
    // The summary line: while running, the step in flight; once settled, the
    // count (with an honest note when a step failed).
    const summaryText = settled
      ? `${sum.total} ${sum.total === 1 ? "step" : "steps"}${sum.errored ? " · 1 or more failed" : ""}`
      : sum.activeLabel
        ? `Step ${sum.current} of ${sum.total} · ${sum.activeLabel}`
        : `Step ${sum.current} of ${sum.total}`;
    // aria-live text: the active step (running) or the outcome (settled).
    const liveText = settled
      ? `Plan complete — ${sum.total} ${sum.total === 1 ? "step" : "steps"}${sum.errored ? ", with an error" : ""}`
      : sum.activeLabel ? `Now: ${sum.activeLabel}` : "";
    const rows = steps.map((s) => {
      const icon = s.status === "done" ? ICON_STEP_DONE
        : s.status === "error" ? ICON_STEP_ERROR
        : ICON_STEP_ACTIVE;
      return `<li data-status="${s.status}"><span class="ic" aria-hidden="true">${icon}</span><span class="tx">${escapeHtml(s.label)}</span></li>`;
    }).join("");
    mountTemplate(this, `
      :host { display:block; position:sticky; top:0; z-index:4; margin:0 0 12px; min-width:0; }
      :host([hidden]) { display:none; }
      .plan { border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-md,12px); background:var(--panel,#fff); color:var(--text,#1d1b18); box-shadow:0 4px 16px rgb(0 0 0 / .06); overflow:clip; }
      details > summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:10px; min-height:44px; padding:10px 12px; font-size:13px; font-weight:650; color:var(--text,#1d1b18); }
      summary::-webkit-details-marker { display:none; }
      summary:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:-2px; border-radius:var(--radius-md,12px); }
      .lead { flex:0 0 auto; width:16px; height:16px; display:inline-flex; color:var(--accent,#0e6e63); }
      .lead.done { color:var(--success,#1a7f37); }
      .lead.err { color:var(--danger,#b3261e); }
      .sumtx { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .chev { flex:0 0 auto; width:16px; height:16px; display:inline-flex; color:var(--muted,#635e56); transition:transform .18s ease; }
      details[open] .chev { transform:rotate(180deg); }
      ol { margin:0; padding:2px 12px 12px; list-style:none; display:flex; flex-direction:column; gap:8px; }
      li { display:flex; align-items:center; gap:9px; font-size:12px; line-height:1.4; color:var(--muted,#635e56); min-width:0; }
      li[data-status="active"] { color:var(--text,#1d1b18); font-weight:600; }
      li[data-status="error"] { color:var(--danger,#b3261e); }
      li .ic { flex:0 0 auto; width:15px; height:15px; display:inline-flex; }
      li[data-status="done"] .ic { color:var(--success,#1a7f37); }
      li[data-status="active"] .ic { color:var(--accent,#0e6e63); }
      li[data-status="error"] .ic { color:var(--danger,#b3261e); }
      li .tx { min-width:0; overflow-wrap:anywhere; }
      .lead svg, .chev svg, li .ic svg { width:100%; height:100%; display:block; }
      .spin { transform-origin:center; animation:plan-spin .9s linear infinite; }
      @media (prefers-reduced-motion: reduce) { .spin { animation:none; } .chev { transition:none; } }
      @keyframes plan-spin { to { transform:rotate(360deg); } }
      .sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
    `, `<div class="plan">
      <details${settled ? "" : " open"}>
        <summary>
          <span class="lead${settled && !sum.errored ? " done" : ""}${settled && sum.errored ? " err" : ""}" aria-hidden="true">${settled ? (sum.errored ? ICON_STEP_ERROR : ICON_PLAN_DONE) : ICON_STEP_ACTIVE}</span>
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

/* <permission-approval-card reason="…" permissions='["tabs"]' origins='["https://a.com"]'
 * global="true" state="pending|granted|denied|error" detail="…"> — the IN-CONTEXT
 * owner approval for a tool's permission/grant denial (owner P0
 * CAP-FB-20260826-PERMISSIONS-SIMPLIFY-01). It DESCRIBES exactly what a click
 * approves (plain-English reason + the exact permissions + the exact sites, or
 * "all sites" only when the tool genuinely needs the global grant) and emits
 * "approve" / "deny" with the real click event — granting happens in the
 * conversation's click handler (a genuine owner gesture), never here.
 * Security: this element grants NOTHING itself; it is a labelled choice. */
const PERMISSION_APPROVAL_LABELS = Object.freeze({
  tabs: "Browser control (tabs)",
  tabGroups: "Tab groups",
  storage: "Memory & settings",
  activeTab: "Screenshots",
  scripting: "Site Agents",
  downloads: "Downloads",
  notifications: "Notifications",
  alarms: "Scheduled tasks",
  cookies: "Cookies",
  browsingData: "Browsing data",
  contentSettings: "Content settings",
  bookmarks: "Bookmarks",
  history: "History",
  sidePanel: "Side panel",
  management: "Extension management",
  userScripts: "User scripts",
  declarativeNetRequest: "Network rules",
  webNavigation: "Navigation frames",
  webRequest: "Request observation",
});

class PermissionApprovalCard extends Component {
  static get observedAttributes() {
    return ["reason", "permissions", "origins", "global", "state", "detail"];
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
    const reason = (this.getAttribute("reason") ?? "perform this action").slice(0, 240);
    const permissions = this._jsonList("permissions");
    const origins = this._jsonList("origins");
    const isGlobal = this.getAttribute("global") === "true";
    const state = ["granted", "denied", "expired", "error"].includes(this.getAttribute("state")) ? this.getAttribute("state") : "pending";
    const detail = (this.getAttribute("detail") ?? "").slice(0, 240);
    const needs = [];
    for (const permission of permissions) {
      needs.push(`<li>${escapeHtml(PERMISSION_APPROVAL_LABELS[permission] ?? permission)} permission</li>`);
    }
    if (isGlobal) {
      needs.push(`<li>Browser control of <strong>all sites</strong> (one of the tabs has no single site)</li>`);
    } else if (origins.length) {
      const shown = origins.slice(0, 6).map((origin) => `<code>${escapeHtml(origin)}</code>`).join(", ");
      needs.push(`<li>Browser control of ${origins.length === 1 ? "this site" : "these sites"}: ${shown}${origins.length > 6 ? ` and ${origins.length - 6} more` : ""}</li>`);
    }
    const stateText = state === "granted"
      ? (detail || "Approved — continuing…")
      : state === "denied"
        ? "Declined. The action was not performed."
        : state === "expired"
          ? (detail || "The request expired. The action was not performed.")
        : state === "error"
          ? (detail || "The approval could not be completed — try again.")
          : "";
    mountTemplate(this, `
      :host { display:flex; margin:0 0 14px; justify-content:flex-start; }
      .card { max-width:88%; border-radius:12px; padding:12px 14px; background:var(--panel,#fff); border:1px solid var(--accent,#0e6e63); box-shadow:0 1px 2px rgba(0,0,0,.05); }
      .title { font-size:13px; font-weight:700; color:var(--ink,#1d1b18); margin:0 0 4px; }
      .reason { font-size:13.5px; color:var(--ink,#1d1b18); margin:0 0 6px; line-height:1.45; }
      .needs { margin:0 0 10px; padding-left:18px; font-size:12.5px; color:var(--muted,#635e56); line-height:1.5; }
      .needs code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:0.92em; background:var(--panel-2,#efede8); border:1px solid var(--border,#e3e0d9); border-radius:4px; padding:0 4px; }
      .controls { display:flex; gap:8px; }
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
      :host([state="granted"]) .card, :host([state="denied"]) .card, :host([state="expired"]) .card { border-color:var(--border,#e3e0d9); opacity:.85; }
    `, `<div class="card" role="group" aria-label="Permission request">
      <p class="title">Permission request</p>
      <p class="reason">The agent wants to ${escapeHtml(reason)}.</p>
      ${needs.length ? `<ul class="needs">${needs.join("")}</ul>` : ""}
      ${state === "pending"
        ? `<div class="controls"><button type="button" class="btn allow">Allow</button><button type="button" class="btn deny">Not now</button></div>`
        : `<p class="state ${state}">${escapeHtml(stateText)}</p>`}
    </div>`);
  }
  _wire() {
    this._root.querySelector(".allow")?.addEventListener("click", (event) => this._emit("approve", { sourceEvent: event }));
    this._root.querySelector(".deny")?.addEventListener("click", (event) => this._emit("deny", { sourceEvent: event }));
  }
}
customElements.define("permission-approval-card", PermissionApprovalCard);

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
 * cross) + the task name + a time. Emits `open` from the explicit Open button
 * (the row is a non-interactive wrapper — nested-interactive), `retry` and
 * `delete` from their affordances. */
class TaskRow extends Component {
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

/* <approval-card title body> — a human-in-the-loop approval (the BeautifulUI
 * "Approval Card" primitive). The agent asks before acting; the owner Approves
 * or Denies. Emits `approve` / `deny`. */
class ApprovalCard extends Component {
  static get observedAttributes() { return ["title", "body", "approve-label", "deny-label", "state", "detail"]; }
  /** Script approvals (CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01): the exact
   * source the owner is approving + the hosts it fetches. A PROPERTY (never
   * an attribute) rendered with textContent — the source is untrusted text. */
  get detail() { return this._detail ?? null; }
  set detail(value) {
    this._detail = value && typeof value === "object" && typeof value.source === "string"
      ? { source: value.source, hosts: Array.isArray(value.hosts) ? value.hosts.filter((h) => typeof h === "string") : [], dynamic: value.dynamic === true }
      : null;
    if (this._rendered) { this._render(); this._wire(); }
  }
  _render() {
    const title = this.getAttribute("title") || "Approve this action?";
    const body = this.getAttribute("body") || "";
    const approveLabel = this.getAttribute("approve-label") || "Approve";
    const denyLabel = this.getAttribute("deny-label") || "Deny";
    const state = ["granted", "denied", "expired", "error"].includes(this.getAttribute("state")) ? this.getAttribute("state") : "pending";
    const detail = (this.getAttribute("detail") || "").slice(0, 240);
    const stateText = state === "granted"
      ? "Approved — continuing the paused action."
      : state === "denied"
        ? "Denied. The action was not performed."
        : state === "expired"
          ? (detail || "Expired. The action was not performed.")
          : (detail || "The decision could not be recorded — try again.");
    mountTemplate(this, `
      :host { display:block; margin-block-end:14px; }
      .card { border:1px solid var(--accent,#0e6e63); border-radius:12px; background:var(--panel,#ffffff); padding:14px 16px; max-width:min(680px, 100%); }
      .title { font-size:14px; font-weight:600; color:var(--ink,#1d1b18); margin:0 0 4px; overflow-wrap:anywhere; }
      .body { font-size:13px; color:var(--muted,#635e56); margin:0 0 12px; white-space:pre-wrap; overflow-wrap:anywhere; }
      /* An optional slotted region (e.g. an <artifact-diff> on an edit
         approval) between the body and the decision buttons. The slot has no
         box unless something is assigned to it. */
      slot[name="extra"] { display:block; margin-block-end:12px; }
      slot[name="extra"]::slotted(*) { display:block; }
      .actions { display:flex; flex-wrap:wrap; gap:8px; }
      .approve { border:0; border-radius:8px; padding:7px 16px; min-height:34px; background:var(--accent,#0e6e63); color:var(--accent-contrast,#fff); cursor:pointer; font:inherit; font-weight:600; }
      .deny { border:1px solid var(--border,#e3e0d9); border-radius:8px; padding:7px 16px; min-height:34px; background:var(--panel,#ffffff); color:var(--ink,#1d1b18); cursor:pointer; font:inherit; }
      .approve:focus-visible, .deny:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .state { margin:0; font-size:12.5px; font-weight:600; color:var(--muted,#635e56); }
      .state.granted { color:var(--success,#1a7f37); }
      .state.error, .state.expired { color:var(--danger,#b3261e); }
      :host([state="granted"]) .card, :host([state="denied"]) .card, :host([state="expired"]) .card, :host([state="error"]) .card { border-color:var(--border,#e3e0d9); }
    `, `<div class="card" role="group" aria-label="Approval request">
        <p class="title">${escapeHtml(title)}</p>
        ${body ? `<p class="body">${escapeHtml(body)}</p>` : ""}
        ${this._detail ? `<span class="source-label" id="source-label">Script source</span><pre class="source" tabindex="0" role="region" aria-labelledby="source-label"></pre><span class="source-label">Sites it fetches</span><ul class="hosts" aria-label="Sites this script fetches">${this._detail.hosts.length ? this._detail.hosts.map((h) => `<li>${escapeHtml(h)}</li>`).join("") : `<li class="none">none — the script makes no fetch to a listed site</li>`}</ul>${this._detail.dynamic ? `<p class="dynamic" role="note">Builds a URL at run time (unknown hosts) — only the sites listed above will be reachable; localhost and private addresses are always refused.</p>` : ""}` : ""}
        <slot name="extra"></slot>
        ${state === "pending"
          ? `<div class="actions"><button type="button" class="approve">${escapeHtml(approveLabel)}</button><button type="button" class="deny">${escapeHtml(denyLabel)}</button></div>`
          : `<p class="state ${state}" role="status">${escapeHtml(stateText)}</p>`}
      </div>`);
  }
  _wire() {
    // The source is untrusted text: textContent, never markup.
    const pre = this._root.querySelector(".source");
    if (pre && this._detail) pre.textContent = this._detail.source;
    this._root.querySelector(".approve")?.addEventListener("click", (event) => this._emit("approve", { sourceEvent: event }));
    this._root.querySelector(".deny")?.addEventListener("click", (event) => this._emit("deny", { sourceEvent: event }));
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
    const placeholder = this.getAttribute("placeholder") || "Ask anything, or @mention an agent…";
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
        <textarea id="pb-input" rows="1" placeholder="${escapeHtml(placeholder)}" aria-label="Prompt"
          aria-description="Type @ to mention any named, background, or Site Agent."></textarea>
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
 *   label            — the visible label for the search combobox
 *   state / error    — "loading" | "error" (+ error message) overrides
 *
 * Events: agent-select { ref, kind, id, name, agent } · agent-cancel (Escape) ·
 * the LEGACY select { origin } for site entries (backward compatibility).
 *
 * A11y contract: the search input is a combobox controlling a listbox
 * (aria-expanded/controls/activedescendant); options are role=option grouped by
 * role=group; ArrowUp/Down/Home/End move the active option, Enter/Tab commit,
 * Escape cancels (the host returns focus); a debounced visually-hidden live
 * region announces the result count; rows are ≥44px; light/dark/high-contrast/
 * reduced-motion via the shared tokens. No emoji — inline currentColor SVG. */
class AgentPicker extends Component {
  static get observedAttributes() {
    return ["agents", "selected", "current-agent-id", "exclude-current", "callable-only", "label", "state", "error"];
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
  get _callableOnly() { return this.hasAttribute("callable-only"); }
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
      .group-h { font-size:11px; font-weight:700; letter-spacing:.01em; color:var(--muted,#635e56);
        padding:8px 10px 2px; }
      .opt { display:flex; align-items:center; gap:10px; min-height:44px; padding:6px 10px; border-radius:8px;
        border:1px solid transparent; cursor:pointer; text-align:start; background:transparent; font:inherit;
        color:var(--text,#1d1b18); width:100%; }
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
      .sub { font-size:11px; color:var(--muted,#635e56); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .meta { flex:0 0 auto; display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--muted,#635e56); }
      .current-badge { border:1px solid var(--accent,#0e6e63); color:var(--accent,#0e6e63); border-radius:999px;
        padding:1px 8px; font-size:10px; font-weight:700; }
      .sel { color:var(--accent,#0e6e63); display:inline-flex; }
      .state { padding:12px 10px; font-size:12.5px; color:var(--muted,#635e56); display:flex; align-items:center; gap:8px; }
      .state.error { color:var(--danger,#b3261e); }
      .retry { border:1px solid var(--border,#e3e0d9); background:transparent; color:var(--text,#1d1b18);
        border-radius:6px; padding:4px 10px; font:inherit; font-size:12px; cursor:pointer; min-height:28px; }
      .retry:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
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
    `, `<div class="picker">
        <label class="lbl" for="ap-search">${escapeHtml(label)}</label>
        <div class="search-row">${ICONS.search}
          <input id="ap-search" class="search" type="text" role="combobox" aria-expanded="true"
            aria-controls="ap-list" aria-autocomplete="list" autocomplete="off"
            placeholder="Search agents…" value="${escapeHtml(this._query)}">
        </div>
        <div class="list" id="ap-list" role="listbox" aria-label="${escapeHtml(label)}"></div>
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
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", String(g.label ?? g.id));
      const gHead = document.createElement("div");
      gHead.className = "group-h";
      gHead.id = `ap-gh-${String(g.id)}`;
      gHead.textContent = String(g.label ?? g.id);
      group.appendChild(gHead);
      for (const a of g.agents) {
        const ref = a.ref ?? canonicalRef(a.kind, a.id);
        const isSelected = !!selected && ref === selected;
        const isCurrent = !!currentId && String(a.id).toLowerCase() === currentId.toLowerCase();
        const initial = (String(a.name || a.id || "?").trim()[0] || "?").toUpperCase();
        const skills = Array.isArray(a.skills) && a.skills.length
          ? ` · ${a.skills.slice(0, 3).join(", ")}${a.skills.length > 3 ? "…" : ""}`
          : "";
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "opt";
        opt.setAttribute("role", "option");
        opt.id = `ap-opt-${idx}`;
        opt.dataset.index = String(idx);
        opt.dataset.active = String(idx === this._active);
        opt.setAttribute("aria-selected", String(isSelected));
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
          avatar.textContent = initial;
        }
        opt.appendChild(avatar);
        const who = document.createElement("span");
        who.className = "who";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = String(a.name || a.id);
        const sub = document.createElement("span");
        sub.className = "sub";
        sub.textContent = `${String(a.summary || "")}${skills}`;
        who.append(name, sub);
        opt.appendChild(who);
        const meta = document.createElement("span");
        meta.className = "meta";
        if (a.status) {
          const status = document.createElement("span");
          status.className = "status";
          status.textContent = String(a.status);
          meta.appendChild(status);
        }
        if (isCurrent) {
          const badge = document.createElement("span");
          badge.className = "current-badge";
          badge.textContent = "Current";
          meta.appendChild(badge);
        }
        if (isSelected) {
          const sel = document.createElement("span");
          sel.className = "sel";
          sel.setAttribute("aria-hidden", "true");
          sel.innerHTML = ICONS.check; // trusted static icon (never owner data)
          meta.appendChild(sel);
        }
        opt.appendChild(meta);
        opt.addEventListener("click", () => this._commit(Number(opt.dataset.index)));
        group.appendChild(opt);
        idx++;
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
      input, textarea { background:var(--bg,#f7f6f3); border:1px solid var(--border,#e3e0d9); color:var(--text,#1d1b18); border-radius:7px; padding:8px 10px; font:inherit; }
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
 * Provider / model configuration controls (single source for BOTH the main
 * Providers section and the per-agent overrides — Settings → Agents). Both are
 * labeled controls with an exact --input-h control height so every cell in a
 * configuration row aligns (the 2026-08-18 mismatched-heights finding).
 * ────────────────────────────────────────────────────────────────────────── */

/** Pure: filter a model catalogue for the combobox (case-insensitive substring
 * on the id; caps the visible list so a huge catalogue stays cheap). Exported
 * for unit tests. */
export function filterModels(models, query, { cap = 60 } = {}) {
  const list = Array.isArray(models) ? models.filter((m) => typeof m === "string") : [];
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return list.slice(0, cap);
  return list.filter((m) => m.toLowerCase().includes(q)).slice(0, cap);
}

const CONTROL_CSS = `
  :host { display: block; min-width: 0; }
  .field { display: grid; gap: 4px; }
  .field-label { font-size: var(--text-xs, 12px); color: var(--muted, #635e56); }
  .control {
    box-sizing: border-box;
    height: var(--input-h, 36px);
    width: 100%;
    background: var(--bg, #f7f6f3);
    border: 1px solid var(--border, #e3e0d9);
    color: var(--text, #1d1b18);
    border-radius: var(--radius-sm, 7px);
    padding: 0 12px;
    font: inherit;
  }
  .control:focus-visible { outline: 2px solid var(--accent, #0e6e63); outline-offset: 1px; }
  :host([disabled]) .control { opacity: 0.5; cursor: not-allowed; }
`;

/* <provider-select> — the shared provider picker. A styled NATIVE select
 * (appearance: base-select where supported; fully keyboard-accessible by
 * construction — never a hand-rolled listbox). Attributes: label (visible
 * field label), placeholder (the empty option's text — e.g. "Use the global
 * provider"), providers (JSON [{id,name}]), value, disabled. Property
 * `providers`/`value` mirror the attributes. Fires `change` {value}. */
class ProviderSelect extends Component {
  static get observedAttributes() { return ["label", "placeholder", "providers", "value", "disabled"]; }
  attributeChangedCallback(name, oldValue, newValue) {
    // SELF-INFLICTED value changes (our own change handler / the property
    // setter) must NOT re-render — a re-render destroys the focused select, so
    // arrowing through a closed native select broke after one step (k3
    // MEDIUM-3). External attribute changes still re-render as usual.
    if (this._selfUpdate) return;
    super.attributeChangedCallback(name, oldValue, newValue);
  }
  get value() { return this._select?.value ?? this.getAttribute("value") ?? ""; }
  set value(v) {
    this._selfUpdate = true;
    try {
      this.setAttribute("value", String(v ?? ""));
      if (this._select) this._select.value = String(v ?? "");
    } finally { this._selfUpdate = false; }
  }
  get providers() { return parseJSONAttr(this.getAttribute("providers"), []); }
  set providers(list) { this.setAttribute("providers", JSON.stringify(list ?? [])); }
  _render() {
    const label = this.getAttribute("label") || "Provider";
    const placeholder = this.getAttribute("placeholder") || "Use the global provider";
    const value = this.getAttribute("value") ?? "";
    const providers = this.providers;
    const options = [
      `<option value=""><span class="option-text">${escapeHtml(placeholder)}</span></option>`,
      ...providers.map((p) => {
        const icon = ICONS[p.icon] ?? ICONS.user;
        return `<option value="${escapeHtml(p.id ?? "")}"${String(value) === String(p.id) ? " selected" : ""}><span class="option-icon">${icon}</span><span class="option-text">${escapeHtml(p.name ?? p.id ?? "")}</span></option>`;
      }),
    ].join("");
    mountTemplate(this, `${CONTROL_CSS}
      select.control, select.control::picker(select) { appearance: base-select; }
      select.control { min-width: 0; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      select.control > button { min-width: 0; padding: 0; color: inherit; background: transparent; border: 0; font: inherit; text-align: left; }
      select.control selectedcontent { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      select.control::picker-icon { color: var(--muted, #635e56); transition: rotate 150ms ease; }
      select.control:open::picker-icon { rotate: 180deg; }
      select.control::picker(select) { max-width: min(440px, 90vw); padding: 6px; color: var(--text, #1d1b18); background: var(--panel, #fff); border: 1px solid var(--border, #e3e0d9); border-radius: var(--radius-sm, 7px); box-shadow: 0 12px 28px rgba(0,0,0,.3); }
      select.control option { display: flex; align-items: center; gap: 9px; padding: 8px; border-radius: 6px; }
      select.control option::checkmark { display: none; }
      select.control option:checked { color: var(--btn-fg, #fff); background: var(--accent, #0e6e63); }
      .option-icon { display: inline-flex; flex: 0 0 18px; color: currentColor; }
      .option-icon svg { width: 18px; height: 18px; }
      .option-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `, `
      <div class="field">
        <span class="field-label">${escapeHtml(label)}</span>
        <select class="control" aria-label="${escapeHtml(label)}" ${this.hasAttribute("disabled") ? "disabled" : ""}><button type="button"><selectedcontent></selectedcontent></button>${options}</select>
      </div>`);
    this._select = this._root.querySelector("select");
    if (this._select && this.getAttribute("value") != null) this._select.value = this.getAttribute("value");
  }
  _wire() {
    this._select?.addEventListener("change", (e) => {
      // The NATIVE change event is composed and would ALSO cross the shadow
      // boundary, so host listeners would see it AND our CustomEvent — double
      // handling (k3 LOW). Stop the native one here; the CustomEvent below is
      // the single, canonical `change` the host receives.
      e.stopPropagation();
      this._selfUpdate = true;
      try { this.setAttribute("value", this._select.value); } finally { this._selfUpdate = false; }
      this._emit("change", { value: this._select.value });
    });
  }
}
customElements.define("provider-select", ProviderSelect);

/* <model-picker> — the shared, searchable model-id combobox over the SAME
 * maintained catalogue the Providers section uses (modelsForVendor → llm-prices,
 * newest-first). ARIA combobox semantics: input[role=combobox] + filtered
 * role=listbox + aria-activedescendant; full keyboard (arrows/Enter/Escape/Tab);
 * an unknown typed id commits as a CUSTOM value (first-class path, not an
 * error); empty catalogue (Ollama / OpenAI-compatible) = free-text mode.
 * Attributes: label, placeholder, value, disabled, loading, models (JSON),
 * recommended (JSON — the catalogue head, rendered under a "Recommended"
 * group header; the remaining models go under "More models"). Group headers
 * are role=presentation, so arrow navigation skips them.
 * Fires `change` {value}. Getters: value, isCustom, open. */
class ModelPicker extends Component {
  static get observedAttributes() { return ["label", "placeholder", "value", "disabled", "loading", "models", "recommended"]; }
  attributeChangedCallback(name, oldValue, newValue) {
    // SELF-INFLICTED value changes (a commit from typing/keyboard/option click)
    // must NOT re-render — a re-render destroys the focused input mid-keyboard
    // use (k3 MEDIUM-3). The shadow input is synced by _syncInput instead.
    // External attribute/property changes (a page restoring a saved value)
    // still re-render as usual.
    if (this._selfUpdate) return;
    super.attributeChangedCallback(name, oldValue, newValue);
  }
  constructor() {
    super();
    this._open = false;
    this._activeIndex = -1;
    this._committed = "";
    this._scrollBound = null;
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    // The window resize + document scroll listeners are per-instance — remove
    // them so a removed picker leaks nothing (k3 LOW).
    if (this._resizeBound && typeof window?.removeEventListener === "function") {
      window.removeEventListener("resize", this._resizeBound);
      this._resizeBound = null;
    }
    if (this._scrollBound && typeof document?.removeEventListener === "function") {
      document.removeEventListener("scroll", this._scrollBound, true);
      this._scrollBound = null;
    }
  }
  get value() { return this._committed; }
  set value(v) {
    this._committed = String(v ?? "");
    this._selfUpdate = true;
    try { this.setAttribute("value", this._committed); } finally { this._selfUpdate = false; }
    this._syncInput();
  }
  get models() { return parseJSONAttr(this.getAttribute("models"), []); }
  set models(list) { this.setAttribute("models", JSON.stringify(Array.isArray(list) ? list : [])); }
  get recommended() { return parseJSONAttr(this.getAttribute("recommended"), []); }
  set recommended(list) { this.setAttribute("recommended", JSON.stringify(Array.isArray(list) ? list : [])); }
  get isCustom() {
    const models = this.models;
    return this._committed !== "" && !models.includes(this._committed);
  }
  get open() { return this._open; }
  /** Test/drive hook: set the open state programmatically. */
  _setOpen(v) { this._open = Boolean(v); this._applyOpen(); }

  _render() {
    const label = this.getAttribute("label") || "Model";
    const placeholder = this.getAttribute("placeholder") || "Search or type a model id…";
    const disabled = this.hasAttribute("disabled");
    const loading = this.hasAttribute("loading");
    const value = this.getAttribute("value") ?? "";
    this._committed = String(value);
    const listId = `model-picker-list-${Math.random().toString(36).slice(2, 9)}`;
    this._listId = listId;
    mountTemplate(this, `${CONTROL_CSS}
      .row { position: relative; display: flex; }
      input.control { flex: 1; min-width: 0; }
      input.control[role="combobox"] { cursor: text; }
      .toggle {
        box-sizing: border-box; height: var(--input-h, 36px); width: 34px;
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--bg, #f7f6f3); border: 1px solid var(--border, #e3e0d9);
        border-left: 0; border-radius: 0 var(--radius-sm, 7px) var(--radius-sm, 7px) 0;
        color: var(--muted, #635e56); cursor: pointer; padding: 0;
      }
      .toggle:focus-visible { outline: 2px solid var(--accent, #0e6e63); outline-offset: 1px; }
      .toggle svg { transition: rotate 150ms ease; }
      :host([data-open]) .toggle svg { rotate: 180deg; }
      .listbox {
        position: fixed; z-index: 2147483647;
        min-width: 220px; max-width: 420px; max-height: 260px; overflow: auto;
        background: var(--panel, #ffffff); color: var(--text, #1d1b18);
        border: 1px solid var(--border, #e3e0d9); border-radius: var(--radius-md, 10px);
        box-shadow: 0 8px 24px rgba(0,0,0,.12);
        padding: 4px; margin: 0;
      }
      .listbox[hidden] { display: none; }
      .opt {
        display: block; width: 100%; text-align: left; background: transparent;
        border: 0; padding: 8px 10px; border-radius: 6px; cursor: pointer;
        font: inherit; font-size: 13px; color: inherit; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .opt:hover { background: color-mix(in oklab, var(--accent, #0e6e63) 8%, transparent); }
      .opt[aria-selected="true"] { background: color-mix(in oklab, var(--accent, #0e6e63) 14%, transparent); font-weight: 600; }
      .group { padding: 6px 10px 2px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted, #635e56); }
      .group + .group, .opt + .group { margin-top: 4px; border-top: 1px solid var(--border, #e3e0d9); padding-top: 8px; }
      .empty { padding: 8px 10px; font-size: 12px; color: var(--muted, #635e56); }
      .custom-hint { font-size: 12px; color: var(--secondary, #b45309); }
      .loading-hint { font-size: 12px; color: var(--muted, #635e56); }
    `, `
      <div class="field">
        <span class="field-label">${escapeHtml(label)}</span>
        <div class="row">
          <input class="control" role="combobox" type="text" autocomplete="off" spellcheck="false"
            aria-expanded="false" aria-controls="${listId}" aria-autocomplete="list"
            aria-label="${escapeHtml(label)}" placeholder="${escapeHtml(placeholder)}"
            value="${escapeHtml(this._committed)}" ${disabled ? "disabled" : ""} ${loading ? 'aria-busy="true"' : ""}>
          <button type="button" class="toggle" aria-label="Browse models" aria-haspopup="listbox" tabindex="-1">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>'}</button>
        </div>
        ${this.models.length ? `<span class="custom-hint" data-part="custom" hidden>Custom model id — used as-is.</span>` : ""}
        ${loading ? `<span class="loading-hint" data-part="loading">Loading models…</span>` : ""}
        <div class="listbox" id="${listId}" role="listbox" aria-label="${escapeHtml(label)} options" hidden></div>
      </div>`);
    this._input = this._root.querySelector("input[role='combobox']");
    this._listbox = this._root.querySelector(".listbox");
    this._customHint = this._root.querySelector("[data-part='custom']");
    this._syncInput();
    this._syncCustomHint();
  }
  _wire() {
    if (!this._input) return;
    this._input.addEventListener("input", () => {
      this._renderList(this._input.value);
      if (!this._open) this._setOpen(true);
    });
    this._input.addEventListener("focus", () => {
      // Populate BEFORE opening so an expanded combobox never sits over an
      // empty listbox (k3 MEDIUM-4).
      if (!this._open && this.models.length) { this._renderList(this._input.value); this._setOpen(true); }
    });
    this._input.addEventListener("keydown", (e) => this._onKey(e));
    this._root.querySelector(".toggle")?.addEventListener("click", () => {
      this._setOpen(!this._open);
      if (this._open) { this._renderList(this._input.value); this._input.focus(); }
    });
    this._bindDocument("mousedown", (e) => {
      if (!this._open) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (!path.includes(this)) this._setOpen(false);
    });
    // Reposition the fixed listbox when the page scrolls under it (k3 LOW) —
    // capture phase so ancestor containers scrolling also reposition it.
    // _wire() re-runs on external attribute changes; add these exactly once.
    if (!this._scrollBound) {
      this._scrollBound = () => { if (this._open) this._position(); };
      document.addEventListener?.("scroll", this._scrollBound, true);
    }
    if (!this._resizeBound) {
      this._resizeBound = () => this._position();
      window.addEventListener?.("resize", this._resizeBound);
    }
  }
  _onKey(e) {
    const options = this._visibleOptions ?? [];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!this._open) { this._setOpen(true); this._renderList(this._input.value); }
        this._moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        this._moveActive(-1);
        break;
      case "Enter":
        e.preventDefault();
        if (this._open && this._activeIndex >= 0 && options[this._activeIndex]) {
          this._commit(options[this._activeIndex]);
        } else {
          this._commitInput();
        }
        this._setOpen(false);
        break;
      case "Escape":
        e.preventDefault();
        this._setOpen(false);
        // Escape REVERTS the visible text to the committed value (the gallery
        // caption promises this; _syncInput alone skips while focused, so set
        // the input text directly — k3 LOW).
        if (this._input) this._input.value = this._committed;
        break;
      case "Tab":
        this._commitInput();
        this._setOpen(false);
        break;
    }
  }
  _moveActive(delta) {
    const options = this._visibleOptions ?? [];
    if (!options.length) return;
    this._activeIndex = Math.min(options.length - 1, Math.max(0, this._activeIndex + delta));
    const nodes = [...this._listbox.querySelectorAll("[role='option']")];
    nodes.forEach((n, i) => n.setAttribute("aria-selected", String(i === this._activeIndex)));
    const active = nodes[this._activeIndex];
    if (active?.id) this._input.setAttribute("aria-activedescendant", active.id);
    active?.scrollIntoView({ block: "nearest" });
  }
  _renderList(query) {
    if (!this._listbox) return;
    const matched = filterModels(this.models, query);
    // The catalogue head ("Recommended") first, then everything else ("More
    // models" — the provider's live list). Ids can come from a provider's
    // /models response, so every row is built with textContent, never markup.
    const rec = new Set(this.recommended);
    const head = rec.size ? matched.filter((m) => rec.has(m)) : [];
    const rest = rec.size ? matched.filter((m) => !rec.has(m)) : matched;
    const visible = [...head, ...rest];
    this._visibleOptions = visible;
    this._activeIndex = -1;
    this._input.removeAttribute("aria-activedescendant");
    this._listbox.replaceChildren();
    const doc = this._listbox.ownerDocument ?? document;
    const groupHeader = (text) => {
      const g = doc.createElement("div");
      g.className = "group";
      g.setAttribute("role", "presentation");
      g.textContent = text;
      return g;
    };
    const option = (m, i) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "opt";
      b.setAttribute("role", "option");
      b.id = `${this._listId}-opt-${i}`;
      b.setAttribute("aria-selected", "false");
      b.dataset.value = m;
      b.textContent = m;
      b.addEventListener("click", () => { this._commit(m); this._setOpen(false); this._input.focus(); });
      return b;
    };
    if (!visible.length) {
      const empty = doc.createElement("div");
      empty.className = "empty";
      empty.textContent = `No matches — Enter keeps “${String(query ?? "").slice(0, 40)}” as a custom id.`;
      this._listbox.appendChild(empty);
    } else {
      let i = 0;
      if (head.length) {
        this._listbox.appendChild(groupHeader("Recommended"));
        for (const m of head) this._listbox.appendChild(option(m, i++));
      }
      if (rest.length) {
        if (head.length) this._listbox.appendChild(groupHeader("More models"));
        for (const m of rest) this._listbox.appendChild(option(m, i++));
      }
    }
    this._position();
  }
  _applyOpen() {
    if (!this._input) return;
    this._input.setAttribute("aria-expanded", String(this._open));
    if (this._listbox) this._listbox.hidden = !this._open;
    if (this._open) this.setAttribute("data-open", ""); else this.removeAttribute("data-open");
    if (this._open) this._position();
  }
  _position() {
    if (!this._open || !this._listbox || !this._input) return;
    placeFloating(this._input, this._listbox, { fullWidth: false, minWidth: 200 });
  }
  _commit(v) {
    this._committed = String(v ?? "").trim();
    this._selfUpdate = true;
    try { this.setAttribute("value", this._committed); } finally { this._selfUpdate = false; }
    this._syncInput();
    this._syncCustomHint();
    this._emit("change", { value: this._committed });
  }
  /** Test/drive hook: commit whatever is currently typed. */
  _commitInput() { this._commit(this._input?.value ?? ""); }
  _syncInput() { if (this._input && (this._root?.activeElement ?? document.activeElement) !== this._input) this._input.value = this._committed; }
  _syncCustomHint() {
    if (this._customHint) this._customHint.hidden = !(this.isCustom && this.models.length);
  }
}
customElements.define("model-picker", ModelPicker);

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

// A bounded await: if the worker never answers (e.g. it was killed mid-route,
// which leaves sendMessage's callback NEVER fired), the caller must still
// settle — an unbounded await here was the activity-explorer's dead-controls
// failure (the load promise hung, so the agent select stayed empty and the
// search box filtered nothing).
function backendBounded(type, payload = {}, timeoutMs = 12000) {
  return Promise.race([
    backend(type, payload),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
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
        border-radius:999px; background:var(--danger,#b3261e); color:var(--btn-fg,#fff); font-size:10px; font-weight:700;
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

// Turn a raw tool result into a short readable one-liner. Decode + redaction
// go through lib/tool-summary.js's redactToolResult — the canonical seam
// shared with the detail tree/copy path and the SW journal persistence — so a
// wrapped (modelContent/userSummary double-encoded) or historical unredacted
// result can never paint a secret into the collapsed row. Render per-tool,
// never a raw escaped JSON blob.
function _short(v, n = 72) {
  const s = String(v ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function activityToolSummary(name, raw) {
  const d = redactToolResult(raw);
  if (d && typeof d === "object" && !Array.isArray(d) && Array.isArray(d.agents)) {
    const items = d.agents.map((a) => {
      const label = a?.name || a?.origin || a?.id || "agent";
      const role = a?.role;
      const mem = a?.memoryKeyCount != null ? `${a.memoryKeyCount} memory key${a.memoryKeyCount === 1 ? "" : "s"}` : null;
      const tools = a?.toolCount != null && a?.toolCount > 0 ? `${a.toolCount} tools` : (a?.toolCount === 0 ? "no tools" : null);
      return role ? `${label} — ${_short(role)}` : [label, mem, tools].filter(Boolean).join(" · ");
    });
    return `${d.agents.length} ${/named/i.test(name || "") ? "named agent" : "agent"}${d.agents.length === 1 ? "" : "s"}: ${items.join("; ")}`;
  }
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const a = d.agent || d.created || d.updated;
    if (a && typeof a === "object" && (a.name || a.id)) {
      const verb = /delete/i.test(name || "") ? "deleted" : /update/i.test(name || "") ? "updated" : "created";
      return `${verb} ${a.name || a.id}${a.role ? ` (${_short(a.role, 60)})` : ""}`;
    }
    if (/schedule/i.test(name || "") && (d.id || d.task || d.name)) return `scheduled: ${_short(d.name || d.task || d.id)}`;
    if (d.ok === true) return "done";
    if (d.ok === false) return `failed: ${_short(d.error ?? d.reason ?? "")}`;
    if (/memory/i.test(name || "")) {
      if (d.keys && Array.isArray(d.keys)) return `${d.keys.length} key${d.keys.length === 1 ? "" : "s"}: ${d.keys.map(String).join(", ")}`;
      if (d.value != null) return _short(String(d.value));
      if (d.matches != null) return `${Array.isArray(d.matches) ? d.matches.length : 0} match${Array.isArray(d.matches) && d.matches.length === 1 ? "" : "es"}`;
    }
    if (/navigate|open_?tab|goto|url/i.test(name || "") && d.url) return `opened ${_short(d.url)}`;
    const entries = Object.entries(d).filter(([, val]) => val != null);
    if (entries.length && entries.length <= 4) {
      return entries.map(([k, val]) => `${k}: ${_short(typeof val === "object" ? JSON.stringify(val) : val, 40)}`).join(" · ");
    }
  }
  if (typeof d === "string") return _short(d, 120);
  if (Array.isArray(d)) return `${d.length} item${d.length === 1 ? "" : "s"}`;
  if (d == null) return "done";
  return _short(JSON.stringify(d), 120);
}
function shortText(v, n = 80) {
  const s = String(v ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// The row-kind pill in USER words: "Started" not "task", "Failed" not
// "result with ok:false". The class stays the raw kind so existing CSS color
// hooks keep working; the visible text is the word.
export function userKindLabel(e) {
  switch (e?.type) {
    case "task": return "Started";
    case "result": return e?.ok === false ? "Failed" : "Finished";
    case "artifact": return "Made";
    case "approval-requested": return "Needs approval";
    case "approval-granted": return "Approved";
    case "approval-denied": return "Denied";
    case "schedule-ran": return "Schedule ran";
    default: return "";
  }
}

// The readable one-liner for a journal entry.
export function activityText(e) {
  switch (e?.type) {
    // A task row is the user's own task title — bounded to a human sentence
    // like every other kind (a pathological giant title must never dump raw
    // text into the collapsed row).
    case "task": return summarizeTask(e);
    // A result row's one-liner is a DERIVED HUMAN SUMMARY, never the raw
    // model/provider dump (a multi-thousand-char reply or a {modelContent,…}
    // envelope). We unwrap the transport layers, pull the human-readable
    // core, and only THEN bound to 140 — a raw dump is never rendered even
    // truncated (CAP-FB-20260830-RECENT-ACTIVITY-USER-EVENTS-01 r2 B2).
    case "result": return summarizeResult(e);
    case "artifact": return summarizeArtifact(e);
    case "approval-requested": return summarizeApproval(e, "needs approval");
    case "approval-granted": return summarizeApproval(e, "approved");
    case "approval-denied": return summarizeApproval(e, "denied");
    case "schedule-ran": return summarizeSchedule(e);
    case "tool-call": {
      // The args preview in the summary line goes through safeJsonStringify —
      // which redacts secret-like KEYS before serialization — so a historical
      // (pre-write-redaction) journal row can never paint a credential into
      // the collapsed row either.
      const preview = (() => {
        if (!e.args) return "";
        const p = safeParseOnce(e.args);
        if (p.kind !== "json") return e.args;
        try { return safeJsonStringify(redactSecrets(p.value), { maxBytes: 256, maxNodes: 24 }); }
        catch { return ""; }
      })();
      return (e.tool || "tool") + (preview ? ` ${shortText(preview, 60)}` : "");
    }
    case "tool-result": return (e.tool || "tool") + " → " + activityToolSummary(e.tool, e.result);
    case "screenshot": return e.url || "screenshot";
    case "error": return e.error || e.message || "error";
    default: return e?.type || "";
  }
}

// ── per-kind HUMAN summaries (CAP-FB-20260830-RECENT-ACTIVITY-USER-EVENTS-01
// r2 B2 / r3 P1): each row's one-liner is derived from the meaningful content
// and then bounded to a HARD 140 chars — a raw journal payload is never
// rendered, even truncated, and every kind's output is a bounded human
// sentence. The unwrap walks transport envelopes ({modelContent,…},
// {userSummary,…} JSON-string layers) so the model's actual answer is what
// gets summarized.
const AEX_ONELINER_MAX = 140;

// A bounded human sentence from a raw text blob: collapse whitespace; take
// the first sentence when sentence punctuation exists; take the whole text
// when it is short and readable without punctuation (names, titles); and
// refuse (return "") ONLY when the text is longer than the budget AND has no
// sentence boundary — that shape is a raw dump, and the caller emits a short
// fixed form instead of a truncated raw fragment.
function firstHumanSentence(raw, budget) {
  const clean = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const first = clean.match(/^.*?[.!?](?:\s|$)/);
  if (first) {
    const s = first[0].replace(/\s+$/g, "").trim();
    return s.length <= budget ? s : "";
  }
  return clean.length <= budget ? clean : "";
}

function summarizeResult(e) {
  const raw = String(e?.result ?? "");
  const verdict = e?.ok === false ? "Failed" : "Finished";
  if (!raw) return verdict;
  const unwrapped = (() => {
    try { return unwrapToolPayload(raw).value; } catch { return raw; }
  })();
  // Track whether the result actually CARRIES content. A JSON object with no
  // usable scalar core must take the genuine refusal path — never a silent
  // drop (r4 P1: the scalar shortcut used to consume the object and return
  // the bare verdict, which made the giant-JSON test a false positive).
  let core = "";
  let hadContent = false;
  if (typeof unwrapped === "string") {
    core = unwrapped.replace(/^\[[^\]]*\]\s*/, "").trim();
    hadContent = core.length > 0;
  } else if (unwrapped && typeof unwrapped === "object") {
    hadContent = Object.keys(unwrapped).length > 0;
    const scalar = (() => {
      for (const k of ["summary", "text", "message", "result", "error"]) {
        const v = unwrapped[k];
        if (typeof v === "string") return v;
        if (typeof v === "number" || typeof v === "boolean") return String(v);
      }
      return "";
    })();
    core = scalar.replace(/^\[[^\]]*\]\s*/, "").trim();
  } else if (typeof unwrapped === "number" || typeof unwrapped === "boolean") {
    core = String(unwrapped);
    hadContent = true;
  }
  const sentence = firstHumanSentence(core, AEX_ONELINER_MAX - verdict.length - 2);
  if (sentence) return `${verdict}: ${sentence}`;
  // No readable sentence. If the result DID carry content, be honest about it
  // — a fixed refusal phrase (the payload exists but is not renderable as a
  // human sentence); never silently drop it. Only a truly empty result gets
  // the bare verdict.
  if (hadContent) return `${verdict} — see the run log for the full result`;
  return verdict;
}

function summarizeArtifact(e) {
  // The artifact NAME is the human summary (Made <name>); never the body.
  const name = String(e?.artifact?.name ?? e?.name ?? e?.task ?? "an artifact");
  const s = firstHumanSentence(name, AEX_ONELINER_MAX - 5);
  return `Made ${s || "an artifact"}`;
}

function summarizeApproval(e, verb) {
  // The approval SUBJECT (what the owner is being asked to approve), bounded
  // so the WHOLE line (subject + " — " + verb) never exceeds 140.
  const subject = String(e?.task ?? e?.description ?? e?.artifact?.name ?? "an action");
  const budget = AEX_ONELINER_MAX - verb.length - 3;
  const s = firstHumanSentence(subject, Math.max(8, budget));
  return `${s || "an action"} — ${verb}`;
}

function summarizeSchedule(e) {
  // The scheduled task's sentence.
  const what = String(e?.task ?? e?.result ?? "scheduled task");
  const s = firstHumanSentence(what, AEX_ONELINER_MAX - 4);
  return `Ran ${s || "a scheduled task"}`;
}

function summarizeTask(e) {
  // The user's task title, bounded like every other kind. If there is no
  // readable sentence boundary (a giant unbroken token), fall back to a
  // fixed phrase — never a truncated raw fragment.
  const title = String(e?.task ?? "");
  const s = firstHumanSentence(title, AEX_ONELINER_MAX);
  return s || "a task";
}

// Plain-text details are bounded inline; longer payloads truncate with a
// "show more" reveal (the SW already caps journaled args/results at 2 KiB —
// this bound is the defensive ceiling for every other source, e.g. error
// stacks). The copy button copies the FULL text, never the truncated view.
const AEX_PLAIN_DETAIL_INLINE = 2048;
function plainDetailBlock(label, text) {
  const wrap = document.createElement("div");
  wrap.className = "aex-plain";
  const head = document.createElement("div");
  head.className = "aex-plain-head";
  const l = document.createElement("span");
  l.className = "aex-plain-label";
  l.textContent = label;
  head.appendChild(l);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "aex-plain-copy";
  copy.textContent = "copy";
  copy.setAttribute("aria-label", `Copy ${label}`);
  copy.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const restore = () => setTimeout(() => { copy.textContent = "copy"; }, 1400);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => { copy.textContent = "copied"; restore(); })
        .catch(() => { copy.textContent = "copy failed"; restore(); });
    } else { copy.textContent = "copy failed"; restore(); }
  });
  head.appendChild(copy);
  wrap.appendChild(head);
  const pre = document.createElement("pre");
  pre.className = "aex-detail";
  if (text.length > AEX_PLAIN_DETAIL_INLINE) {
    pre.textContent = text.slice(0, AEX_PLAIN_DETAIL_INLINE) + "\n…";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "aex-plain-more";
    more.textContent = `show more (${(text.length - AEX_PLAIN_DETAIL_INLINE).toLocaleString()} more chars)`;
    more.addEventListener("click", (ev) => {
      ev.stopPropagation();
      pre.textContent = text;
      more.remove();
    });
    head.appendChild(more);
    // keep copy last in the head for a stable layout
    head.appendChild(copy);
  }
  wrap.appendChild(pre);
  return wrap;
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
        .aex-toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
        .aex-search { flex:1; min-width:140px; padding:8px 12px; font:inherit; font-size:13px;
          color:var(--text,#1d1b18); background:var(--bg,#f7f6f3); border:1px solid var(--border,#e3e0d9);
          border-radius:var(--radius-sm,8px); }
        .aex-search:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
        .aex-agent { max-width:200px; padding:8px 10px; font:inherit; font-size:13px;
          color:var(--text,#1d1b18); background:var(--bg,#f7f6f3); border:1px solid var(--border,#e3e0d9);
          border-radius:var(--radius-sm,8px); appearance:base-select; }
        .aex-list { display:flex; flex-direction:column; max-height:420px; overflow-y:auto; overflow-x:hidden; }
        .aex-entry { border-bottom:1px solid var(--border,#e3e0d9); }
        .aex-entry:last-child { border-bottom:0; }
        .aex-entry:hover { background:var(--panel,#ffffff); }
        .aex-entry summary { list-style:none; cursor:pointer; display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:10px;
          align-items:baseline; padding:9px 12px; }
        .aex-entry summary::-webkit-details-marker { display:none; }
        .aex-entry summary:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:-2px; }
        .aex-agent { font-size:11.5px; font-weight:600; color:var(--accent,#0e6e63); white-space:nowrap;
          max-width:150px; overflow:hidden; text-overflow:ellipsis; }
        .aex-main { min-width:0; min-inline-size:0; }
        .aex-kind { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em;
          color:var(--muted,#635e56); margin-right:6px; white-space:nowrap; }
        .aex-kind.task, .aex-kind.started { color:var(--accent,#0e6e63); }
        .aex-kind.finished { color:var(--accent,#0e6e63); }
        .aex-kind.failed, .aex-kind.error { color:var(--danger,#b3261e); }
        .aex-kind.tool-call, .aex-kind.tool-result { color:var(--accent2,#7a5c1d); }
        .aex-text { font-size:13px; line-height:1.45; color:var(--text,#1d1b18); min-inline-size:0;
          overflow-wrap:anywhere; }
        .aex-ts { font-size:11px; color:var(--muted,#635e56); white-space:nowrap; }
        .aex-detail { margin:0; padding:0 12px 10px 12px; font-size:12px; line-height:1.5;
          color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere;
          font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
        .aex-empty { padding:12px 10px; font-size:13px; color:var(--muted,#635e56); }
        .aex-retry { margin-left:8px; padding:3px 10px; font:inherit; font-size:12px; cursor:pointer;
          color:var(--accent,#0e6e63); background:var(--bg,#f7f6f3); border:1px solid var(--border,#e3e0d9);
          border-radius:var(--radius-sm,8px); }
        .aex-count { font-size:11px; color:var(--muted,#635e56); }
        /* Structured detail blocks (the same bounded tool-tree renderer the
           conversation cards use — styles duplicated per shadow-root
           isolation, scoped under .aex-blocks). */
        .aex-blocks { padding:0 12px 10px 12px; display:flex; flex-direction:column; gap:6px; }
        .aex-blocks .tt-block { border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,8px); }
        .aex-blocks .tt-block summary { list-style:none; cursor:pointer; display:flex; align-items:baseline; gap:8px; padding:6px 10px; color:var(--muted,#635e56); font-size:12px; user-select:none; }
        .aex-blocks .tt-block summary::-webkit-details-marker { display:none; }
        .aex-blocks .tt-block summary:hover { color:var(--text,#1d1b18); }
        .aex-blocks .tt-block summary:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:-2px; }
        .aex-blocks .tt-block-label { font-weight:600; color:var(--ink,#1d1b18); }
        .aex-blocks .tt-block-meta { color:var(--muted,#635e56); }
        .aex-blocks .tt-tree { padding:2px 6px 8px; max-height:260px; overflow:auto; }
        .aex-blocks .tt-row { display:flex; align-items:center; gap:6px; padding:2px 4px; border-radius:6px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.5; min-height:22px; }
        .aex-blocks .tt-row:hover { background:var(--panel-2,#efede8); }
        .aex-blocks .tt-row[hidden] { display:none; }
        .aex-blocks .tt-toggle { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; padding:0; border:0; background:transparent; color:var(--muted,#635e56); cursor:pointer; border-radius:4px; flex:0 0 auto; }
        .aex-blocks .tt-toggle:hover { color:var(--ink,#1d1b18); background:var(--panel-2,#efede8); }
        .aex-blocks .tt-toggle:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:0; }
        .aex-blocks .tt-toggle .tt-caret { transition:transform .15s ease; }
        .aex-blocks .tt-toggle[aria-expanded="true"] .tt-caret { transform:rotate(90deg); }
        .aex-blocks .tt-ic { width:18px; height:18px; flex:0 0 auto; }
        .aex-blocks .tt-key { color:var(--accent,#0e6e63); font-weight:600; white-space:nowrap; }
        .aex-blocks .tt-val { color:var(--ink,#1d1b18); overflow-wrap:anywhere; min-width:0; }
        .aex-blocks .tt-val-number, .aex-blocks .tt-val-boolean { color:var(--accent,#0e6e63); }
        .aex-blocks .tt-val-null { color:var(--muted,#635e56); font-style:italic; }
        .aex-blocks .tt-kind { color:var(--muted,#635e56); font-size:11px; margin-left:2px; }
        .aex-blocks .tt-copy { margin-left:auto; flex:0 0 auto; font:inherit; font-size:11px; color:var(--muted,#635e56); background:transparent; border:1px solid var(--border,#e3e0d9); border-radius:5px; padding:1px 7px; cursor:pointer; opacity:0; transition:opacity .12s ease; }
        .aex-blocks .tt-row:hover .tt-copy, .aex-blocks .tt-copy:focus-visible { opacity:1; }
        .aex-blocks .tt-copy:hover { color:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); }
        .aex-plain { border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,8px); }
        .aex-plain-head { display:flex; align-items:baseline; gap:8px; padding:6px 10px 0; }
        .aex-plain-label { font-size:12px; font-weight:600; color:var(--ink,#1d1b18); }
        .aex-plain-copy, .aex-plain-more { margin-left:auto; font:inherit; font-size:11px; color:var(--muted,#635e56);
          background:transparent; border:1px solid var(--border,#e3e0d9); border-radius:5px; padding:1px 7px; cursor:pointer; }
        .aex-plain-copy:hover, .aex-plain-more:hover { color:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); }
        .aex-plain-copy:focus-visible, .aex-plain-more:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:0; }
        .aex-plain .aex-detail { padding:4px 10px 8px; }
        @media (prefers-reduced-motion: reduce) { .aex-blocks .tt-toggle .tt-caret { transition:none; } .aex-blocks .tt-copy { transition:none; } }
      </style>
      <div class="aex">
        <div class="aex-toolbar">
          <input class="aex-search" type="search" placeholder="Search activity…" aria-label="Search activity">
          <select class="aex-agent" aria-label="Filter by agent"><option value="">All agents</option></select>
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
    this.refresh();
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
  // Re-query the backend NOW (live activity: the NTP calls this,
  // trailing-debounced, when run progress events land — the section used to
  // freeze at whatever it showed when the page opened). At most ONE request
  // is ever in flight plus ONE pending trailing refresh: bursts coalesce
  // instead of overlapping, and a stale response can never overwrite newer
  // data (only the in-flight request applies; the trailing one re-queries).
  refresh() {
    if (this._seeded) return Promise.resolve(); // gallery demos own their data
    if (this._loadInFlight) {
      this._trailingRefresh = true;
      return this._loadInFlight;
    }
    const p = this._load();
    this._loadInFlight = p;
    const settle = () => {
      if (this._loadInFlight === p) this._loadInFlight = null;
      if (this._trailingRefresh) {
        this._trailingRefresh = false;
        this.refresh();
      }
    };
    p.then(settle, settle);
    return p;
  }
  // A cheap change signature: skip the re-render entirely when the fetched
  // entries are identical (protects aria-live from spam + keeps open rows
  // from collapsing on a no-op refresh). The signature must cover EVERY
  // rendered identity/label/content field + the load error — the old
  // count+first-row form suppressed renames (agentLabel) and empty-success ↔
  // empty-error transitions. FNV-1a-style double hash over the fields (cheap,
  // no large allocation).
  _signature() {
    const es = this._entries || [];
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    const mix = (v) => {
      const str = String(v ?? "");
      for (let i = 0; i < str.length; i++) {
        h1 = Math.imul(h1 ^ str.charCodeAt(i), 0x01000193) >>> 0;
        h2 = (Math.imul(h2, 31) + str.charCodeAt(i)) >>> 0;
      }
      h1 = Math.imul(h1 ^ 0xff, 0x01000193) >>> 0;
      h2 = (Math.imul(h2, 31) + 0xff) >>> 0;
    };
    mix(this._loadError ?? "");
    for (const e of es) {
      mix(e.ts); mix(e.type); mix(e.id); mix(e.callId); mix(e.source);
      mix(e.agentLabel); mix(e.tool); mix(e.task); mix(e.args); mix(e.result);
      mix(e.error); mix(e.message); mix(e.stack); mix(e.detail); mix(e.url);
      mix(e.ok);
    }
    return `${es.length}:${h1.toString(16)}:${h2.toString(16)}`;
  }
  async _load() {
    // Sequence guard: a response applies ONLY if no newer request was issued
    // meanwhile (stale responses never overwrite newer data).
    const seq = (this._loadSeq = (this._loadSeq ?? 0) + 1);
    // If entries were seeded synchronously (the gallery), never clobber them
    // with the empty backend result (the _load await would race the setter).
    if (!this._seeded) {
      this._loadError = null;
      try {
        // BOUNDED: a worker that never answers must not leave the controls
        // dead — settle with an honest error + retry instead.
        // The hub's Recent activity shows USER-VISIBLE kinds only; the route
        // filters server-side AND the client re-filters (seeded gallery rows
        // and any future caller never bypass the allowlist).
        const res = await backendBounded("activity.list", {
          agent: this.getAttribute("agent") || undefined,
          limit: Number(this.getAttribute("limit")) || 200,
          kinds: [...USER_VISIBLE_KINDS],
        });
        if (seq !== this._loadSeq) return; // superseded mid-flight
        if (!this._seeded) {
          this._entries = Array.isArray(res?.entries)
            ? res.entries.filter((e) => USER_VISIBLE_KINDS.has(e.type))
            : [];
          this._loadError = Array.isArray(res?.entries)
            ? null
            : (res?.error || "couldn't load the activity log");
        }
      } catch {
        if (seq !== this._loadSeq) return; // superseded mid-flight
        if (!this._seeded) {
          this._entries = [];
          this._loadError = "the activity log didn't answer — the agent worker may be busy";
        }
      }
      const sig = this._signature();
      if (sig === this._lastSignature && this._rendered) return; // nothing new — leave the DOM (and open rows) alone
      this._lastSignature = sig;
    }
    const seen = new Map();
    for (const e of this._entries) {
      if (!seen.has(e.source)) seen.set(e.source, e.agentLabel || e.source);
    }
    const cur = this._agent.value;
    // Journal-derived option strings (agent labels/sources) are built with
    // createElement + textContent — NEVER innerHTML (CAP-FB-20260830-
    // RECENT-ACTIVITY-USER-EVENTS-01 r2 B3).
    this._agent.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All agents";
    this._agent.append(all);
    for (const [s, label] of seen) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = label;
      this._agent.append(opt);
    }
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
    // Rows that are open BEFORE the rebuild stay open after it (a live
    // refresh must not collapse what the owner is reading).
    const openBefore = new Set();
    for (const d of this._list.querySelectorAll("details.aex-entry[open]")) {
      if (d.dataset.ekey) openBefore.add(d.dataset.ekey);
    }
    this._list.replaceChildren();
    // The hub hides the Recent activity section until the log has ever had
    // an entry (a never-used store shows no empty copy at all).
    this._emit("entries-change", { count: (this._entries || []).length, shown: filtered.length });
    if (!filtered.length) {
      const d = document.createElement("div");
      d.className = "aex-empty";
      // A load failure is surfaced HONESTLY with a retry (never the silent
      // empty select + dead search box the unbounded load produced).
      // The zero state and the filtered-empty state say different things: a
      // never-used log is "nothing yet", a filter that hides rows says so
      // (CAP-FB-20260827-HUB-FIRST-RUN-01).
      d.textContent = this._loadError ||
        (q || agent ? "No activity matches this filter." : "Nothing has happened yet.");
      if (this._loadError) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "aex-retry";
        retry.textContent = "Retry";
        retry.addEventListener("click", () => this.refresh());
        d.append(retry);
      }
      this._list.append(d);
      return;
    }
    for (const e of filtered) {
      const entry = document.createElement("details");
      entry.className = "aex-entry";
      const summary = document.createElement("summary");
      const who = document.createElement("span");
      who.className = "aex-agent";
      who.textContent = e.agentLabel || e.source || "hub";
      const main = document.createElement("span");
      main.className = "aex-main";
      const kind = document.createElement("span");
      kind.className = "aex-kind " + (e.type || "");
      kind.textContent = userKindLabel(e) || e.type || "";
      const text = document.createElement("span");
      text.className = "aex-text";
      text.textContent = activityText(e);
      main.append(kind, text);
      const ts = document.createElement("span");
      ts.className = "aex-ts";
      ts.textContent = timeAgo(e.ts);
      summary.append(who, main, ts);
      entry.append(summary);
      // The expanded detail — STRUCTURED for tool calls/results (the same
      // bounded tree renderer the conversation tool cards use), plain text
      // with truncation + copy for everything else. Never raw JSON blobs.
      const body = this._detailBody(e);
      if (body) entry.append(body);
      const ekey = this._detailKey(e);
      entry.dataset.ekey = ekey;
      if (openBefore.has(ekey)) entry.open = true;
      this._list.append(entry);
    }
  }
  _detailKey(e) {
    return `${e.type}:${e.id ?? ""}:${e.callId ?? ""}:${e.ts ?? ""}`;
  }
  // Build the expanded detail body for an entry: tool-call inputs and
  // tool-result output become collapsible, syntax-aware tree blocks
  // (buildToolTreeBlock over safeParse/buildTree — the conversation card's
  // renderer, reused per the no-parallel-renderers rule). Each entry gets a
  // persistent expansion-state map so the owner's collapse/expand choices
  // survive re-renders.
  _detailBody(e) {
    const key = this._detailKey(e);
    if (!this._blockStates) this._blockStates = new Map();
    let st = this._blockStates.get(key);
    if (!st) { st = new Map(); this._blockStates.set(key, st); }
    // Bound the state maps with the entry volume (they die with the entries).
    if (this._blockStates.size > 400) this._blockStates.clear();
    const wrap = document.createElement("div");
    wrap.className = "aex-blocks";
    let any = false;
    const addBlock = (label, raw) => {
      if (raw == null || raw === "") return;
      any = true;
      const parsed = safeParseOnce(raw);
      if (parsed.kind === "json") {
        // Historical journal rows may predate write-path redaction — redact
        // AGAIN at render with the canonical redactor so a secret never
        // paints, and the tree's COPY path (subtreeJson over this same value)
        // can only ever copy the redacted form.
        const safeValue = redactSecrets(parsed.value);
        const tree = buildTree(safeValue);
        if (tree.rows.length >= 1) {
          wrap.appendChild(buildToolTreeBlock(label, safeValue, tree.rows, tree.maxNodes, st));
          return;
        }
      }
      wrap.appendChild(plainDetailBlock(label, String(parsed.value ?? raw ?? "")));
    };
    switch (e?.type) {
      case "tool-call": addBlock("inputs", e.args); break;
      // Normalize + redact ONCE (redactToolResult): the collapsed-row summary,
      // this detail tree, and its copy path all render the same redacted
      // decoded view — wrapped modelContent JSON strings included.
      case "tool-result": addBlock("result", redactToolResult(e.result)); break;
      case "error": addBlock("error", [e.error, e.message, e.stack].filter(Boolean).join("\n") || "error"); break;
      case "task": addBlock("task", e.task); break;
      // The EXPANDED result row shows the same bounded human summary as the
      // collapsed row — never the raw provider/model payload. The full output
      // lives in Run logs (CAP-FB-20260830-RECENT-ACTIVITY-USER-EVENTS-01 r3
      // P1): an expansion must not turn a glanceable surface into a dump.
      case "result": addBlock("result", activityText(e)); break;
      default: addBlock("detail", e?.detail || e?.url || "");
    }
    return any ? wrap : null;
  }
}
customElements.define("activity-explorer", ActivityExplorer);

/* ──────────────────────────────────────────────────────────────────────────
 * <action-ledger> — the "what I did" surface (CAP-FB-20260830-ACTIVITY-LEDGER-UNDO-01).
 * A quiet, most-recent-first list of the mutating actions the agents took, each
 * a plain-language sentence with an Undo control when the action is reversible.
 * Reversible rows carry the reversing tool call; irreversible mutations say so
 * plainly rather than offering a dead button. Data comes from actions.list; Undo
 * calls actions.undo (which re-runs the inverse through the SAME grant/approval
 * checks the original went through). Seed `entries`/`rows` for the gallery.
 * ────────────────────────────────────────────────────────────────────────── */
class ActionLedger extends Component {
  static get observedAttributes() {
    return ["limit"];
  }
  _render() {
    this._root.innerHTML = `
      <style>
        :host { display:block; }
        .al { display:flex; flex-direction:column; }
        .al-row { display:grid; grid-template-columns:1fr auto; align-items:baseline; gap:12px;
          padding:9px 2px; border-bottom:1px solid var(--border,#e3e0d9); }
        .al-row:last-child { border-bottom:0; }
        .al-main { min-width:0; display:flex; flex-direction:column; gap:2px; }
        .al-sentence { font-size:13px; line-height:1.4; color:var(--text,#1d1b18);
          overflow:hidden; text-overflow:ellipsis; }
        .al-row.undone .al-sentence { color:var(--muted,#635e56); text-decoration:line-through;
          text-decoration-thickness:1px; }
        .al-meta { font-size:11px; color:var(--muted,#635e56); display:flex; gap:8px; align-items:baseline; }
        .al-ts { white-space:nowrap; }
        .al-note { font-size:11px; color:var(--muted,#635e56); white-space:nowrap; font-style:italic; }
        .al-undo { display:inline-flex; align-items:center; gap:5px; padding:4px 10px; font:inherit; font-size:12px;
          cursor:pointer; color:var(--accent,#0e6e63); background:transparent;
          border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,8px);
          transition:border-color .15s ease, color .15s ease, background .15s ease; white-space:nowrap; }
        .al-undo:hover { border-color:var(--accent,#0e6e63); background:var(--panel-2,#efede8); }
        .al-undo:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
        .al-undo:disabled { cursor:default; color:var(--muted,#635e56); opacity:.7; }
        .al-undo svg { width:13px; height:13px; flex:0 0 auto; }
        .al-done { font-size:11px; color:var(--muted,#635e56); white-space:nowrap; }
        .al-empty { padding:12px 2px; font-size:13px; color:var(--muted,#635e56); }
        .al-error { padding:12px 2px; font-size:13px; color:var(--danger,#b3261e); display:flex; gap:8px; align-items:baseline; }
        .al-retry { padding:3px 10px; font:inherit; font-size:12px; cursor:pointer; color:var(--accent,#0e6e63);
          background:transparent; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,8px); }
        @media (prefers-reduced-motion: reduce) { .al-undo { transition:none; } }
      </style>
      <div class="al" role="list" aria-label="Recent actions"></div>
    `;
    this._list = this._root.querySelector(".al");
    this._paint();
  }
  attributeChangedCallback(name, oldV, newV) {
    if (this._rendered && oldV !== newV) { this._render(); this.refresh(); }
  }
  connectedCallback() {
    super.connectedCallback();
    if (!this._seeded) this.refresh();
  }
  set entries(v) {
    this._rows = Array.isArray(v) ? v : [];
    this._seeded = true;
    this._loadError = null;
    if (this._rendered) this._paint();
  }
  get entries() { return this._rows ?? []; }
  // Alias — the store/route speak "rows"; the gallery may seed either name.
  set rows(v) { this.entries = v; }
  get rows() { return this._rows ?? []; }
  async refresh() {
    if (this._seeded) return; // seeded demos own their data
    const seq = (this._loadSeq = (this._loadSeq ?? 0) + 1);
    this._loadError = null;
    try {
      const res = await backendBounded("actions.list", {
        limit: Number(this.getAttribute("limit")) || 20,
      });
      if (seq !== this._loadSeq) return; // superseded
      this._rows = Array.isArray(res?.rows) ? res.rows : [];
    } catch {
      if (seq !== this._loadSeq) return;
      this._loadError = "Couldn't load recent actions.";
    }
    this._paint();
  }
  _undoIcon() {
    // A single-stroke "undo" arc-with-arrowhead, currentColor.
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const p1 = document.createElementNS(ns, "path");
    p1.setAttribute("d", "M9 14 4 9l5-5");
    const p2 = document.createElementNS(ns, "path");
    p2.setAttribute("d", "M4 9h11a5 5 0 0 1 0 10h-4");
    svg.append(p1, p2);
    return svg;
  }
  _paint() {
    if (!this._list) return;
    // Let a host (the hub sidebar) show/hide its Activity section on the count.
    this._emit("entries-change", { count: (this._rows ?? []).length, error: !!this._loadError });
    this._list.textContent = "";
    if (this._loadError) {
      const e = document.createElement("div");
      e.className = "al-error";
      e.textContent = this._loadError;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "al-retry";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => { this._loadError = null; this.refresh(); });
      e.append(retry);
      this._list.append(e);
      return;
    }
    const rows = this._rows ?? [];
    if (rows.length === 0) {
      const d = document.createElement("div");
      d.className = "al-empty";
      d.textContent = "Nothing to undo yet.";
      this._list.append(d);
      return;
    }
    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "al-row" + (row.undone ? " undone" : "");
      el.setAttribute("role", "listitem");

      const main = document.createElement("div");
      main.className = "al-main";
      const sentence = document.createElement("span");
      sentence.className = "al-sentence";
      // The sentence embeds untrusted content (a tab title, a bookmark name) —
      // textContent only, never innerHTML.
      sentence.textContent = row.sentence || "Did something";
      const meta = document.createElement("span");
      meta.className = "al-meta";
      const ts = document.createElement("span");
      ts.className = "al-ts";
      ts.textContent = timeAgo(row.ts);
      meta.append(ts);
      main.append(sentence, meta);

      const trailing = document.createElement("span");
      if (row.undone) {
        trailing.className = "al-done";
        trailing.textContent = "Undone";
      } else if (row.inverse && row.inverse.tool) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "al-undo";
        // Accessible name names the specific action, not just "Undo".
        btn.setAttribute("aria-label", `Undo: ${row.sentence || "this action"}`);
        btn.append(this._undoIcon(), document.createTextNode("Undo"));
        btn.addEventListener("click", () => this._undo(row, btn));
        trailing.append(btn);
      } else {
        trailing.className = "al-note";
        trailing.textContent = "Can't be undone";
      }

      el.append(main, trailing);
      this._list.append(el);
    }
  }
  async _undo(row, btn) {
    if (this._seeded) { this._emit("action-undo", { id: row.id, seeded: true }); return; }
    btn.disabled = true;
    btn.textContent = "Undoing…";
    try {
      const res = await backendBounded("actions.undo", { id: row.id });
      if (res && res.ok) {
        this._emit("action-undo", { id: row.id, tool: res.tool });
      } else {
        this._emit("action-undo-error", { id: row.id, error: res?.error ?? "undo failed" });
      }
    } catch {
      this._emit("action-undo-error", { id: row.id, error: "undo timed out" });
    }
    await this.refresh();
  }
}
customElements.define("action-ledger", ActionLedger);

/* ──────────────────────────────────────────────────────────────────────────
 * <agent-timeline limit?> — the hub's spine (CAP-FB-20260828-HUB-AS-TIMELINE-01).
 * ONE reverse-chronological stream of what happened: the tasks the owner
 * started and the runs their agents finished, replacing the three object
 * catalogs (Agents / Recent artifacts / Recent activity). Data is set through
 * `.entries` (the pure `buildTimeline` projection from lib/hub-timeline.js), so
 * the component is backend-free and the gallery seeds it directly. Each row is
 * a single Open target that emits `open` with the entry `id`; the host maps a
 * `thread` row to its conversation and a `run:` row to its agent surface.
 *
 * A row is a scan line, not a card: a leading status dot (colour AND a status
 * word, so colour is never the only signal), the title, the agent + outcome,
 * and the time — hairline-separated, the same list vocabulary as the sidebar
 * task rows. It emits `entries-change` { count } so the host can reveal or hide
 * the section (a fresh profile shows nothing here).
 * ────────────────────────────────────────────────────────────────────────── */
const TIMELINE_STATUS_WORD = {
  running: "Running",
  paused: "Waiting",
  failed: "Failed",
  done: "Done",
};
class AgentTimeline extends Component {
  static get observedAttributes() { return ["limit"]; }
  constructor() {
    super();
    this._entries = [];
  }
  set entries(value) {
    this._entries = Array.isArray(value) ? value : [];
    if (this._rendered) { this._render(); this._wire(); }
    this._emit("entries-change", { count: this._entries.length });
  }
  get entries() { return this._entries; }
  _limit() {
    const n = Number.parseInt(this.getAttribute("limit") ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : 40;
  }
  _render() {
    const rows = this._entries.slice(0, this._limit());
    const items = rows.map((e) => {
      const status = ["running", "paused", "failed", "done"].includes(e.status) ? e.status : "idle";
      const word = TIMELINE_STATUS_WORD[status] || "";
      const agent = e.agent ? `<span class="tl-agent">${escapeHtml(e.agent)}</span>` : "";
      const outcome = e.outcome ? `<span class="tl-outcome">${escapeHtml(e.outcome)}</span>` : "";
      const sep = agent && outcome ? `<span class="tl-sep" aria-hidden="true">·</span>` : "";
      const t = Number(e.time) || 0;
      const iso = t ? new Date(t).toISOString() : "";
      const full = t ? new Date(t).toLocaleString() : "";
      return `<li class="tl-item">
        <button type="button" class="tl-row" data-id="${escapeHtml(String(e.id ?? ""))}" aria-label="Open ${escapeHtml(String(e.title ?? "item"))}">
          <span class="tl-dot ${status}" aria-hidden="true"></span>
          <span class="tl-body">
            <span class="tl-title">${escapeHtml(String(e.title ?? "Task"))}</span>
            <span class="tl-meta">${agent}${sep}${outcome || (agent ? "" : `<span class="tl-outcome">${escapeHtml(word)}</span>`)}<span class="tl-sr">${escapeHtml(word)}</span></span>
          </span>
          <time class="tl-time" datetime="${escapeHtml(iso)}" title="${escapeHtml(full)}">${escapeHtml(timeAgo(t))}</time>
          <span class="tl-chev" aria-hidden="true">${ICONS.chevron}</span>
        </button>
      </li>`;
    }).join("");
    const body = rows.length
      ? `<ol class="tl" role="list">${items}</ol>`
      : `<p class="tl-empty">Nothing yet. Your tasks and your agents’ runs will appear here.</p>`;
    mountTemplate(this, `
      :host { display:block; }
      :host([hidden]) { display:none; }
      .tl { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; }
      .tl-item { min-inline-size:0; }
      .tl-row { display:grid; grid-template-columns:10px minmax(0,1fr) auto 20px; gap:12px; align-items:center;
        width:100%; text-align:start; padding:11px 14px; background:transparent; border:0;
        border-bottom:1px solid var(--border,#e3e0d9); color:inherit; font:inherit; cursor:pointer; }
      .tl-item:last-child .tl-row { border-bottom:0; }
      .tl-row:hover { background:var(--bg,#f7f6f3); }
      .tl-row:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:-2px; border-radius:8px; }
      .tl-dot { inline-size:8px; block-size:8px; border-radius:50%; justify-self:center;
        background:var(--muted,#8b949e); flex:0 0 auto; }
      .tl-dot.done { background:var(--accent,#0e6e63); }
      .tl-dot.failed { background:var(--danger,#b3261e); }
      .tl-dot.paused { background:var(--accent2,#7a5c1d); }
      .tl-dot.running { background:var(--accent,#0e6e63); box-shadow:0 0 0 3px color-mix(in srgb, var(--accent,#0e6e63) 22%, transparent); }
      .tl-body { min-inline-size:0; display:flex; flex-direction:column; gap:2px; }
      .tl-title { font-weight:600; font-size:var(--text-sm,13px); color:var(--text,#1d1b18);
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .tl-meta { display:flex; align-items:baseline; gap:6px; min-inline-size:0; font-size:var(--text-xs,12px);
        color:var(--muted,#635e56); overflow:hidden; }
      .tl-agent { color:var(--accent,#0e6e63); font-weight:600; white-space:nowrap;
        max-inline-size:180px; overflow:hidden; text-overflow:ellipsis; }
      .tl-outcome { min-inline-size:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .tl-sep { color:var(--border,#d8d4cc); flex:0 0 auto; }
      .tl-sr { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
        clip:rect(0 0 0 0); white-space:nowrap; border:0; }
      .tl-time { font-size:var(--text-xs,12px); color:var(--muted,#635e56); white-space:nowrap;
        font-variant-numeric:tabular-nums; }
      .tl-chev { display:inline-flex; align-items:center; justify-content:center; color:var(--muted,#8b949e); }
      .tl-chev svg { width:16px; height:16px; display:block; }
      .tl-row:hover .tl-chev, .tl-row:focus-visible .tl-chev { color:var(--accent,#0e6e63); }
      .tl-empty { margin:0; padding:12px 14px; font-size:13px; color:var(--muted,#635e56); }
    `, body);
  }
  _wire() {
    for (const row of this._root.querySelectorAll(".tl-row")) {
      row.addEventListener("click", () => this._emit("open", { id: row.dataset.id }));
    }
  }
}
customElements.define("agent-timeline", AgentTimeline);

/* ──────────────────────────────────────────────────────────────────────────
 * <jobs-board> — the shared jobs board (agent-to-agent work): open jobs with
 * poster/claimant + recency, recently settled jobs with outcome and a bounded
 * result excerpt, and the latest board messages. Queries board.list +
 * board.messages through the runtime; the gallery seeds `jobs`/`messages`
 * properties directly (no extension backend). refresh() re-queries NOW — the
 * NTP calls it on board-* progress events; an in-flight request coalesces
 * trailing refreshes and a stale response never overwrites newer data.
 * All agent-authored content renders with textContent only.
 * ────────────────────────────────────────────────────────────────────────── */
class JobsBoard extends Component {
  _render() {
    this._root.innerHTML = `
      <style>
        :host { display:block; }
        .jb { display:flex; flex-direction:column; gap:12px; }
        .jb-group { display:flex; flex-direction:column; }
        .jb-head { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em;
          color:var(--muted,#635e56); padding:0 2px 4px; }
        .jb-row { display:flex; flex-direction:column; gap:1px; padding:7px 2px;
          border-bottom:1px solid var(--border,#e3e0d9); }
        .jb-row:last-child { border-bottom:0; }
        .jb-desc { font-size:13px; line-height:1.4; color:var(--text,#1d1b18);
          overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
        .jb-meta { font-size:11.5px; color:var(--muted,#635e56); display:flex; gap:6px; align-items:baseline;
          flex-wrap:wrap; }
        .jb-dot { display:inline-block; width:7px; height:7px; border-radius:50%;
          background:var(--accent,#0e6e63); flex:0 0 auto; }
        .jb-dot.claimed { background:var(--accent2,#7a5c1d); }
        .jb-outcome { font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
        .jb-outcome.completed { color:var(--accent,#0e6e63); }
        .jb-outcome.failed { color:var(--danger,#b3261e); }
        .jb-result { font-size:12px; color:var(--muted,#635e56); overflow:hidden;
          text-overflow:ellipsis; white-space:nowrap; }
        .jb-msg { font-size:12.5px; line-height:1.45; color:var(--text,#1d1b18); overflow:hidden;
          display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
        .jb-empty { font-size:13px; color:var(--muted,#635e56); padding:6px 2px; line-height:1.5; }
      </style>
      <div class="jb">
        <div class="jb-open" role="list" aria-label="Open jobs" aria-live="polite"></div>
        <div class="jb-settled" role="list" aria-label="Recently settled jobs"></div>
        <div class="jb-msgs" role="list" aria-label="Board messages"></div>
        <div class="jb-empty" hidden></div>
      </div>`;
  }
  _wire() {
    this._openEl = this._root.querySelector(".jb-open");
    this._settledEl = this._root.querySelector(".jb-settled");
    this._msgsEl = this._root.querySelector(".jb-msgs");
    this._emptyEl = this._root.querySelector(".jb-empty");
    if (!this._seeded) this.refresh();
    else this._paint();
  }
  // Gallery/demo seeding (the showcase has no extension backend).
  set jobs(v) { this._jobs = Array.isArray(v) ? v : []; this._seeded = true; if (this._rendered) this._paint(); }
  set messages(v) { this._messages = Array.isArray(v) ? v : []; this._seeded = true; if (this._rendered) this._paint(); }
  /** "N open" for the panel-head hint (empty string when nothing is open). */
  get summary() {
    const open = (this._jobs ?? []).filter((j) => j && (j.status === "pending" || j.status === "claimed")).length;
    return open > 0 ? `${open} open` : "";
  }
  refresh() {
    if (this._seeded) return Promise.resolve(); // gallery demos own their data
    if (this._loadInFlight) { this._trailingRefresh = true; return this._loadInFlight; }
    const p = this._load();
    this._loadInFlight = p;
    const settle = () => {
      if (this._loadInFlight === p) this._loadInFlight = null;
      if (this._trailingRefresh) { this._trailingRefresh = false; this.refresh(); }
    };
    p.then(settle, settle);
    return p;
  }
  async _load() {
    const seq = (this._loadSeq = (this._loadSeq ?? 0) + 1);
    try {
      const [jobsRes, msgsRes] = await Promise.all([
        backendBounded("board.list"),
        backendBounded("board.messages", { limit: 5 }).catch(() => null),
      ]);
      if (seq !== this._loadSeq) return; // superseded mid-flight
      // A structured {ok:false} is an HONEST backend failure (board-store-error,
      // worker timeout, …) — surface the error copy, never render it as an
      // empty board. (The messages catch→null fallback stays tolerated: a
      // THROWN/never-answering messages query just omits the feed.)
      const failed = [jobsRes, msgsRes].find((r) => r && r.ok === false);
      if (failed) {
        this._loadError = String(failed.error ?? failed.code ?? "unavailable").slice(0, 160);
        this._jobs = [];
        this._messages = [];
      } else {
        this._loadError = null;
        this._jobs = Array.isArray(jobsRes?.jobs) ? jobsRes.jobs : [];
        this._messages = (msgsRes?.ok && Array.isArray(msgsRes?.messages)) ? msgsRes.messages : [];
      }
    } catch (e) {
      if (seq !== this._loadSeq) return;
      this._loadError = String(e?.error ?? e?.message ?? e ?? "unavailable").slice(0, 160);
    }
    this._paint();
    // The hub hides the Jobs section until the board has ever had anything.
    this._emit("jobs-change", { count: (this._jobs ?? []).length + (this._messages ?? []).length });
  }
  _paint() {
    const jobs = this._jobs ?? [];
    const messages = this._messages ?? [];
    // Skip a no-op re-render (protects the live region from spam and keeps
    // the paint cheap when a burst of board events settles identically).
    const signature = JSON.stringify([
      this._loadError,
      jobs.map((j) => [j?.id, j?.status, j?.claimantId, j?.settledAt]),
      messages.map((m) => m?.id),
    ]);
    if (signature === this._lastSignature) return;
    this._lastSignature = signature;

    const open = jobs.filter((j) => j && (j.status === "pending" || j.status === "claimed")).slice(0, 10);
    const settled = jobs.filter((j) => j && (j.status === "completed" || j.status === "failed")).slice(0, 5);

    this._openEl.replaceChildren();
    this._settledEl.replaceChildren();
    this._msgsEl.replaceChildren();

    if (open.length) {
      const head = document.createElement("div");
      head.className = "jb-head";
      head.textContent = "Open";
      this._openEl.append(head);
      for (const job of open) this._openEl.append(this._jobRow(job));
    }
    if (settled.length) {
      const head = document.createElement("div");
      head.className = "jb-head";
      head.textContent = "Settled";
      this._settledEl.append(head);
      for (const job of settled) this._settledEl.append(this._settledRow(job));
    }
    if (messages.length) {
      const head = document.createElement("div");
      head.className = "jb-head";
      head.textContent = "Messages";
      this._msgsEl.append(head);
      for (const m of messages.slice(0, 5)) this._msgsEl.append(this._messageRow(m));
    }

    const isEmpty = !open.length && !settled.length && !messages.length;
    this._emptyEl.hidden = !isEmpty;
    if (isEmpty) {
      // An unreadable board is an HONEST error, never a false "empty".
      this._emptyEl.textContent = this._loadError
        ? `The board could not be read (${this._loadError}) — try reloading the page.`
        : "No shared jobs yet — when agents hand work to each other, it shows up here.";
    }
  }
  _jobRow(job) {
    const row = document.createElement("div");
    row.className = "jb-row";
    row.setAttribute("role", "listitem");
    const desc = document.createElement("span");
    desc.className = "jb-desc";
    desc.textContent = job.description ?? "";
    const meta = document.createElement("span");
    meta.className = "jb-meta";
    const dot = document.createElement("span");
    dot.className = "jb-dot" + (job.status === "claimed" ? " claimed" : "");
    const state = document.createElement("span");
    const poster = job.posterName ?? job.posterId ?? "an agent";
    state.textContent = job.status === "claimed"
      ? `claimed by ${job.claimantName ?? job.claimantId ?? "an agent"} · ${timeAgo(job.claimedAt)} · posted by ${poster}`
      : `posted by ${poster} · ${timeAgo(job.createdAt)}${job.targetName ? ` · for ${job.targetName}` : ""}`;
    meta.append(dot, state);
    row.append(desc, meta);
    row.title = desc.textContent;
    return row;
  }
  _settledRow(job) {
    const row = document.createElement("div");
    row.className = "jb-row";
    row.setAttribute("role", "listitem");
    const desc = document.createElement("span");
    desc.className = "jb-desc";
    desc.textContent = job.description ?? "";
    const meta = document.createElement("span");
    meta.className = "jb-meta";
    const outcome = document.createElement("span");
    outcome.className = `jb-outcome ${job.status === "failed" ? "failed" : "completed"}`;
    outcome.textContent = job.status === "failed" ? "Failed" : "Completed";
    const who = document.createElement("span");
    who.textContent = `by ${job.claimantName ?? job.claimantId ?? "an agent"} · ${timeAgo(job.settledAt)}`;
    meta.append(outcome, who);
    row.append(desc, meta);
    // Bounded one-line result excerpt (never the full result — the board's own
    // size authority already caps it, and the row shows the shape, not the dump).
    if (typeof job.result === "string" && job.result.trim()) {
      const result = document.createElement("span");
      result.className = "jb-result";
      result.textContent = _short(job.result.trim(), 120);
      row.append(result);
    }
    row.title = desc.textContent;
    return row;
  }
  _messageRow(m) {
    const row = document.createElement("div");
    row.className = "jb-row";
    row.setAttribute("role", "listitem");
    const text = document.createElement("span");
    text.className = "jb-msg";
    text.textContent = `${m.fromName ?? m.fromId ?? "someone"} → ${m.toName ?? m.toId ?? "everyone"}: ${m.body ?? ""}`;
    const meta = document.createElement("span");
    meta.className = "jb-meta";
    meta.textContent = timeAgo(m.ts);
    row.append(text, meta);
    return row;
  }
}
customElements.define("jobs-board", JobsBoard);


/* <system-prompt-editor> — the layered system-prompt viewer + owner-override
 * editor (Settings → Advanced). ONE reusable component: the read-only built-in
 * viewer (id + version + hash), the persistent override editor (append /
 * prepend / replace modes, dirty/saved/error states, UTF-8 byte bound,
 * session-only durability badge, save/cancel/reset), the built-in-changed
 * release banner with an old-vs-new diff + keep/reset (acting on the EFFECTIVE
 * override — the inherited hub record when this scope inherits), and the
 * effective composed preview with every layer labelled (source + version +
 * hash). Untrusted/user text is rendered with textContent only. All dynamic
 * state arrives via the `data` property (the SW prompt.describe payload);
 * mutations leave via CustomEvents (prompt-save / prompt-reset / prompt-keep)
 * so the page stays the backend bridge.
 *
 *   const ed = document.createElement("system-prompt-editor");
 *   ed.data = await sendMessage({ type: "prompt.describe", scope: "hub" });
 *   ed.addEventListener("prompt-save", (e) => …);
 */
class SystemPromptEditor extends Component {
  static get observedAttributes() { return ["scope-label", "busy"]; }
  constructor() {
    super();
    this._data = null;
    this._tab = "custom"; // "builtin" | "custom" | "effective"
    this._draftText = null; // null = not editing yet (follow data)
    this._draftMode = null;
    this._diffOpen = false;
    this._dataRev = 0;      // bumped on each set data — drafts re-seed on change
    this._draftRev = -1;
  }
  set data(v) {
    this._data = v && typeof v === "object" ? v : null;
    this._dataRev++;
    if (this._rendered) { this._render(); this._wire(); }
  }
  get data() { return this._data; }
  /** Public: are there unsaved draft edits? (The page confirms before a
   * scope switch discards them.) */
  get dirty() { return this._rendered ? this._dirty() : false; }

  /* ── draft state (survives re-renders; re-seeds when fresh data lands) ── */
  _draft() {
    const d = this._data;
    if (this._draftRev !== this._dataRev) {
      this._draftRev = this._dataRev;
      this._draftText = d?.override?.text ?? "";
      this._draftMode = d?.override?.mode ?? "append";
      this._diffOpen = false;
    }
    return {
      text: this._draftText ?? d?.override?.text ?? "",
      mode: this._draftMode ?? d?.override?.mode ?? "append",
    };
  }
  _dirty() {
    const d = this._data;
    const draft = this._draft();
    const savedText = d?.override?.text ?? "";
    const savedMode = d?.override?.mode ?? "append";
    return draft.text !== savedText || draft.mode !== savedMode;
  }
  _maxBytes() {
    return this._data?.limits?.maxOverrideBytes ?? 16384;
  }
  _draftBytes() {
    return new TextEncoder().encode(this._draft().text).byteLength;
  }
  _valid() {
    const t = this._draft().text.trim();
    return t.length > 0 && this._draftBytes() <= this._maxBytes();
  }

  _render() {
    const d = this._data;
    const scopeLabel = this.getAttribute("scope-label") || "Hub";
    const busy = this.hasAttribute("busy");
    const css = `
      :host { display:block; }
      .spe { border:1px solid var(--border,#e3e0d9); border-radius:12px;
        background:var(--panel,#fff); overflow:hidden; }
      .spe-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
        padding:12px 16px; border-bottom:1px solid var(--border,#e3e0d9); }
      .spe-scope { font-weight:600; font-size:14px; }
      .spe-badge { font-size:11px; font-weight:600; padding:2px 8px;
        border-radius:999px; border:1px solid var(--border,#e3e0d9);
        color:var(--muted,#6e6a62); background:var(--bg,#f7f6f3); }
      .spe-badge.custom { color:var(--accent,#0e6e63);
        border-color:var(--accent,#0e6e63); }
      .spe-badge.update { color:var(--warning,#9a6700);
        border-color:var(--warning,#9a6700); }
      .spe-status { margin-left:auto; font-size:12px; color:var(--muted,#6e6a62); }
      .spe-status.dirty { color:var(--warning,#9a6700); }
      .spe-banner { padding:12px 16px; border-bottom:1px solid var(--border,#e3e0d9);
        background:var(--bg,#f7f6f3); }
      .spe-banner p { margin:0 0 8px; font-size:13px; }
      .spe-banner .spe-row { display:flex; gap:8px; flex-wrap:wrap; }
      .spe-tabs { display:flex; gap:2px; padding:8px 16px 0;
        border-bottom:1px solid var(--border,#e3e0d9); }
      .spe-tab { border:0; background:none; font:inherit; font-size:13px;
        padding:8px 12px; cursor:pointer; color:var(--muted,#6e6a62);
        border-bottom:2px solid transparent; }
      .spe-tab[aria-selected="true"] { color:var(--text,#1d1b18);
        border-bottom-color:var(--accent,#0e6e63); font-weight:600; }
      .spe-tab:focus-visible { outline:2px solid var(--accent,#0e6e63);
        outline-offset:-2px; }
      .spe-panel { padding:16px; }
      .spe-meta { display:flex; gap:12px; flex-wrap:wrap; align-items:center;
        font-size:12px; color:var(--muted,#6e6a62); margin-bottom:8px; }
      .spe-meta code { font-size:11px; background:var(--bg,#f7f6f3);
        border:1px solid var(--border,#e3e0d9); border-radius:6px;
        padding:1px 6px; }
      .spe-pre { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
        white-space:pre-wrap; word-break:break-word; margin:0;
        background:var(--bg,#f7f6f3); border:1px solid var(--border,#e3e0d9);
        border-radius:8px; padding:12px; max-height:320px; overflow:auto; }
      .spe-layer { border:1px solid var(--border,#e3e0d9); border-radius:8px;
        margin-bottom:8px; overflow:hidden; }
      .spe-layer-head { display:flex; gap:8px; align-items:center;
        flex-wrap:wrap; padding:8px 12px; background:var(--bg,#f7f6f3);
        border-bottom:1px solid var(--border,#e3e0d9); font-size:12px; }
      .spe-layer-head .name { font-weight:600; }
      .spe-layer .spe-pre { border:0; border-radius:0; max-height:240px; }
      .spe-layer.omitted .spe-pre { color:var(--muted,#6e6a62); }
      .spe-field { display:block; margin-bottom:12px; }
      .spe-label { display:block; font-size:13px; font-weight:600;
        margin-bottom:6px; }
      .spe-modes { display:flex; flex-direction:column; gap:6px; margin:0 0 12px;
        padding:0; border:0; }
      .spe-mode { display:flex; gap:8px; align-items:flex-start; font-size:13px;
        cursor:pointer; }
      .spe-mode input { margin-top:3px; accent-color:var(--accent,#0e6e63); }
      .spe-mode .muted { display:block; font-size:12px; }
      textarea.spe-text { width:100%; box-sizing:border-box; font:13px/1.5
        ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--text,#1d1b18);
        background:var(--bg,#f7f6f3); border:1px solid var(--border,#e3e0d9);
        border-radius:8px; padding:10px 12px; resize:vertical; min-height:140px; }
      textarea.spe-text:focus-visible { outline:2px solid
        var(--accent,#0e6e63); outline-offset:1px; }
      .spe-count { font-size:12px; color:var(--muted,#6e6a62); text-align:right;
        margin-top:4px; }
      .spe-count.over { color:var(--danger,#b3261e); font-weight:600; }
      .spe-error { color:var(--danger,#b3261e); font-size:13px; margin:8px 0 0; }
      .spe-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
      .spe-btn { font:inherit; font-size:13px; font-weight:600; border-radius:8px;
        padding:8px 14px; cursor:pointer; border:1px solid transparent;
        background:var(--accent,#0e6e63); color:var(--accent-contrast,#fff); }
      .spe-btn:disabled { opacity:.55; cursor:not-allowed; }
      .spe-btn.ghost { background:transparent; color:var(--text,#1d1b18);
        border-color:var(--border,#e3e0d9); }
      .spe-btn.danger { background:transparent; color:var(--danger,#b3261e);
        border-color:var(--danger,#b3261e); }
      .spe-btn:focus-visible { outline:2px solid var(--accent,#0e6e63);
        outline-offset:2px; }
      .spe-note { font-size:12px; color:var(--muted,#6e6a62); margin:8px 0 0; }
      .spe-diff { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
        max-height:280px; overflow:auto; border:1px solid var(--border,#e3e0d9);
        border-radius:8px; margin-top:8px; }
      .spe-diff .row { padding:0 10px; white-space:pre-wrap;
        word-break:break-word; }
      .spe-diff .add { background:color-mix(in srgb, var(--success,#1a7f37) 12%, transparent);
        color:var(--success,#1a7f37); }
      .spe-diff .del { background:color-mix(in srgb, var(--danger,#b3261e) 10%, transparent);
        color:var(--danger,#b3261e); }
      .muted { color:var(--muted,#6e6a62); }
      [hidden] { display:none !important; }
    `;

    if (!d) {
      mountTemplate(this, css, `<div class="spe"><div class="spe-panel">
        <p class="muted" role="status">Loading the system prompt…</p>
      </div></div>`);
      return;
    }
    if (d.ok === false) {
      mountTemplate(this, css, `<div class="spe"><div class="spe-panel">
        <p class="spe-error" role="alert">${escapeHtml(d.error ?? "The prompt could not be loaded.")}</p>
      </div></div>`);
      return;
    }

    const draft = this._draft();
    const dirty = this._dirty();
    const hasOverride = Boolean(d.override);
    const changed = Boolean(d.builtinChanged && d.override);
    const max = this._maxBytes();
    const sessionOnly = d.durable === false;
    const stateBadge = changed
      ? `<span class="spe-badge update">Built-in updated</span>`
      : hasOverride
        ? `<span class="spe-badge custom">Customized${d.inherited ? " (inherited)" : ""}</span>`
        : `<span class="spe-badge">Default</span>`;
    const durableBadge = sessionOnly
      ? `<span class="spe-badge update">Session-only</span>`
      : "";
    const statusText = busy ? "Saving…"
      : dirty ? "Unsaved changes"
      : hasOverride ? "Saved" : "";

    const tabs = [
      ["builtin", "Built-in default"],
      ["custom", "Your customization"],
      ["effective", "Effective prompt"],
    ].map(([id, label]) =>
      `<button class="spe-tab" type="button" role="tab" data-tab="${id}"
        id="spe-tab-${id}" aria-controls="spe-panel-${id}"
        aria-selected="${this._tab === id}" tabindex="${this._tab === id ? "0" : "-1"}">${label}</button>`
    ).join("");

    const banner = changed ? `
      <div class="spe-banner" role="alert">
        <p><strong>The built-in prompt changed since your customization</strong>
        (v${escapeHtml(d.override.baseVersion ?? "?")} → v${escapeHtml(d.base?.version ?? "?")}).
        Your ${escapeHtml(d.override.mode)} customization still applies — nothing was overwritten.
        ${d.override.mode === "replace"
          ? "You replace the built-in prompt, so review the changes and edit your text to merge anything new you want."
          : "Review what changed, then keep your customization (it will apply to the new built-in) or reset to the new default."}</p>
        <div class="spe-row">
          <button class="spe-btn ghost spe-diff-toggle" type="button" aria-expanded="${this._diffOpen}">${this._diffOpen ? "Hide changes" : "View changes"}</button>
          <button class="spe-btn spe-keep" type="button" ${busy ? "disabled" : ""}>Keep my customization</button>
          <button class="spe-btn danger spe-reset" type="button" ${busy ? "disabled" : ""}>Reset to the new default</button>
        </div>
        <div class="spe-diff" ${this._diffOpen ? "" : "hidden"}></div>
      </div>` : "";

    const builtinMeta = d.base ? `
      <div class="spe-meta">
        <code>${escapeHtml(d.base.id)}</code>
        <span>v${escapeHtml(d.base.version)}</span>
        <span>release ${escapeHtml(d.base.release ?? "—")}</span>
        <span>hash <code>${escapeHtml(d.base.hash)}</code></span>
        <button class="spe-btn ghost spe-copy-builtin" type="button">Copy</button>
      </div>` : "";

    const panelBuiltin = `
      <div class="spe-panel" role="tabpanel" id="spe-panel-builtin"
        aria-labelledby="spe-tab-builtin" ${this._tab === "builtin" ? "" : "hidden"}>
        ${builtinMeta}
        <pre class="spe-pre spe-builtin-text" tabindex="0"></pre>
        <p class="spe-note">Read-only. This is the product-authored built-in prompt for this scope —
        exactly what ships in this release. The protected safety constraints (below in the
        Effective prompt tab) always apply and are never editable.</p>
      </div>`;

    const inheritedNote = d.inherited
      ? `<p class="spe-note">This agent currently inherits the hub's customization.
        Saving here creates an agent-specific override; Reset removes it and returns to inheriting.</p>`
      : "";
    const panelCustom = `
      <div class="spe-panel" role="tabpanel" id="spe-panel-custom"
        aria-labelledby="spe-tab-custom" ${this._tab === "custom" ? "" : "hidden"}>
        ${inheritedNote}
        ${sessionOnly ? `<p class="spe-note" role="status"><strong>Session-only:</strong> the storage grant could not be verified (it is granted at install — reload the extension if this persists), so customizations may last only until the browser restarts.</p>` : ""}
        <fieldset class="spe-modes">
          <legend class="spe-label">Composition mode</legend>
          <label class="spe-mode"><input type="radio" name="spe-mode" value="append" aria-label="Append" ${draft.mode === "append" ? "checked" : ""}>
            <span>Append<span class="muted">Your instructions are added after the built-in prompt (recommended).</span></span></label>
          <label class="spe-mode"><input type="radio" name="spe-mode" value="prepend" aria-label="Prepend" ${draft.mode === "prepend" ? "checked" : ""}>
            <span>Prepend<span class="muted">Your instructions are added before the built-in prompt.</span></span></label>
          <label class="spe-mode"><input type="radio" name="spe-mode" value="replace" aria-label="Replace" ${draft.mode === "replace" ? "checked" : ""}>
            <span>Replace<span class="muted">Your instructions replace the built-in prompt. The protected safety constraints still apply and can never be removed.</span></span></label>
        </fieldset>
        <label class="spe-field">
          <span class="spe-label">Custom instructions</span>
          <textarea class="spe-text" rows="9"
            aria-describedby="spe-count spe-status"
            placeholder="e.g. Always answer in British English. Prefer tables for comparisons."></textarea>
        </label>
        <div class="spe-count" id="spe-count"></div>
        <p class="spe-note">Never paste API keys, passwords, or other secrets — these instructions are sent to your configured provider with every run.</p>
        <p class="spe-error" role="alert" hidden></p>
        <div class="spe-actions">
          <button class="spe-btn spe-save" type="button" ${busy || !dirty || !this._valid() ? "disabled" : ""}>Save</button>
          <button class="spe-btn ghost spe-cancel" type="button" ${busy || !dirty ? "disabled" : ""}>Cancel</button>
          ${hasOverride && !d.inherited
            ? `<button class="spe-btn danger spe-reset" type="button" ${busy ? "disabled" : ""}>Reset to default</button>`
            : ""}
        </div>
      </div>`;

    const effHash = d.effective?.hash ?? "";
    const effBytes = new TextEncoder().encode(d.effective?.text ?? "").byteLength;
    const panelEffective = `
      <div class="spe-panel" role="tabpanel" id="spe-panel-effective"
        aria-labelledby="spe-tab-effective" ${this._tab === "effective" ? "" : "hidden"}>
        <div class="spe-meta">
          <span>Effective digest <code>${escapeHtml(effHash)}</code></span>
          <span>${effBytes.toLocaleString()} bytes (UTF-8)</span>
          <button class="spe-btn ghost spe-copy-effective" type="button">Copy effective prompt</button>
          <button class="spe-btn ghost spe-export" type="button">Export (.md)</button>
        </div>
        <div class="spe-layers"></div>
        <p class="spe-note">This is the platform composition sent for this scope — every layer
        labelled with its source + version. Layers marked “not sent” are replaced by your
        customization. The protected runtime policy always composes LAST, after skills.
        The runtime adds its fixed agent-loop instructions after this composition; a run's
        exact provider-bound message is proven by the run-bound attestation journaled with
        the run (digest + bytes, never content).</p>
        ${d.context?.note ? `<p class="spe-note">${escapeHtml(d.context.note)}</p>` : ""}
      </div>`;

    mountTemplate(this, css, `
      <div class="spe">
        <div class="spe-head">
          <span class="spe-scope">${escapeHtml(scopeLabel)}</span>
          ${stateBadge}
          ${durableBadge}
          <span class="spe-status ${dirty ? "dirty" : ""}" id="spe-status" role="status" aria-live="polite">${escapeHtml(statusText)}</span>
        </div>
        ${banner}
        <div class="spe-tabs" role="tablist" aria-label="System prompt views">${tabs}</div>
        ${panelBuiltin}${panelCustom}${panelEffective}
      </div>`);

    // Untrusted/long text is filled with textContent (never innerHTML).
    const builtinPre = this._root.querySelector(".spe-builtin-text");
    if (builtinPre) builtinPre.textContent = d.base?.content ?? "";
    const ta = this._root.querySelector("textarea.spe-text");
    if (ta) ta.value = draft.text;
    this._updateCount();

    // The layered effective preview.
    const layersHost = this._root.querySelector(".spe-layers");
    if (layersHost) {
      for (const layer of d.effective?.layers ?? []) {
        const box = document.createElement("div");
        box.className = "spe-layer" + (layer.omitted ? " omitted" : "");
        const head = document.createElement("div");
        head.className = "spe-layer-head";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = layer.label ?? layer.id;
        head.append(name);
        const src = document.createElement("span");
        src.className = "spe-badge" + (layer.source === "protected" ? " update" : layer.source === "owner" ? " custom" : "");
        src.textContent = layer.source === "protected" ? "protected — always applied"
          : layer.source === "owner" ? "your customization"
          : layer.source === "agent" ? "agent role"
          : layer.source === "skills" ? "skills"
          : layer.source === "runtime" ? "run-time context"
          : "built-in";
        head.append(src);
        if (layer.version) {
          const v = document.createElement("span");
          v.className = "muted";
          v.textContent = `v${layer.version}`;
          head.append(v);
        }
        if (layer.hash) {
          const h = document.createElement("code");
          h.textContent = String(layer.hash).slice(0, 12);
          head.append(h);
        }
        if (layer.omitted) {
          const om = document.createElement("span");
          om.className = "muted";
          om.textContent = "not sent (replaced)";
          head.append(om);
        }
        box.append(head);
        if (!layer.omitted) {
          const pre = document.createElement("pre");
          pre.className = "spe-pre";
          pre.tabIndex = 0;
          pre.textContent = layer.text ?? "";
          box.append(pre);
        }
        layersHost.append(box);
      }
    }

    // The release-update diff (lazy — only when open).
    if (changed && this._diffOpen) this._fillDiff();
  }

  _fillDiff() {
    const host = this._root.querySelector(".spe-diff");
    const d = this._data;
    if (!host || !d?.override) return;
    host.replaceChildren();
    // The diff rows arrive IN the describe payload (computed by the single
    // composition authority in the SW) — override snapshot vs the current base.
    const rows = Array.isArray(d.diff) ? d.diff : [];
    if (!rows.length) {
      const p = document.createElement("div");
      p.className = "row muted";
      p.textContent = "(no line-level changes to show)";
      host.append(p);
      return;
    }
    for (const r of rows.slice(0, 800)) {
      const row = document.createElement("div");
      row.className = "row " + (r.type === "add" ? "add" : r.type === "del" ? "del" : "same");
      row.textContent = (r.type === "add" ? "+ " : r.type === "del" ? "− " : "  ") + r.text;
      host.append(row);
    }
  }

  _updateCount() {
    const max = this._maxBytes();
    const count = this._root.querySelector(".spe-count");
    const bytes = this._draftBytes();
    if (count) {
      count.textContent = `${bytes.toLocaleString()} / ${max.toLocaleString()} bytes`;
      count.classList.toggle("over", bytes > max);
    }
  }

  _refreshButtons() {
    const busy = this.hasAttribute("busy");
    const dirty = this._dirty();
    const valid = this._valid();
    const save = this._root.querySelector(".spe-save");
    const cancel = this._root.querySelector(".spe-cancel");
    const status = this._root.querySelector(".spe-status");
    if (save) save.disabled = busy || !dirty || !valid;
    if (cancel) cancel.disabled = busy || !dirty;
    if (status) {
      status.textContent = busy ? "Saving…" : dirty ? "Unsaved changes"
        : this._data?.override ? "Saved" : "";
      status.classList.toggle("dirty", dirty && !busy);
    }
    const err = this._root.querySelector(".spe-error");
    if (err) {
      const over = this._draftBytes() > this._maxBytes();
      err.hidden = !over;
      err.textContent = over ? "Custom instructions are too long — trim below the byte limit to save." : "";
    }
  }

  _switchTab(id) {
    if (this._tab === id) return;
    this._tab = id;
    this._render();
    this._wire();
    // Keep focus on the newly-selected tab (keyboard continuity).
    this._root.querySelector(`.spe-tab[data-tab="${id}"]`)?.focus();
  }

  async _copy(text, btn) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Fallback: a hidden textarea + execCommand (older/non-secure contexts).
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.append(ta);
        ta.select();
        ok = document.execCommand?.("copy") === true;
        ta.remove();
      } catch { ok = false; }
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = ok ? "Copied" : "Copy failed";
      setTimeout(() => { btn.textContent = old; }, 1500);
    }
  }

  _export() {
    const d = this._data;
    if (!d) return;
    const lines = [
      `# System prompt — ${this.getAttribute("scope-label") || d.scope}`,
      ``,
      `Scope: ${d.scope}`,
      `Effective hash: ${d.effective?.hash ?? ""}`,
      ``,
    ];
    for (const l of d.effective?.layers ?? []) {
      lines.push(`## ${l.label}${l.omitted ? " (not sent — replaced)" : ""}`);
      if (l.version) lines.push(`(${l.id} v${l.version}${l.hash ? ", hash " + l.hash : ""})`);
      lines.push("", l.omitted ? "" : (l.text ?? ""), "");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `system-prompt-${String(d.scope).replace(/[^a-z0-9]+/gi, "-")}.md`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  _wire() {
    const $ = (sel) => this._root.querySelector(sel);
    // Tabs (click + arrow-key tablist behaviour).
    const tabs = [...this._root.querySelectorAll(".spe-tab")];
    for (const t of tabs) {
      t.addEventListener("click", () => this._switchTab(t.dataset.tab));
      t.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const ids = tabs.map((x) => x.dataset.tab);
        const i = ids.indexOf(this._tab);
        const next = ids[(i + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
        this._switchTab(next);
      });
    }
    // The editor draft.
    const ta = $("textarea.spe-text");
    ta?.addEventListener("input", () => {
      this._draftText = ta.value;
      this._updateCount();
      this._refreshButtons();
    });
    for (const radio of this._root.querySelectorAll('input[name="spe-mode"]')) {
      radio.addEventListener("change", () => {
        this._draftMode = radio.value;
        this._refreshButtons();
      });
    }
    $(".spe-save")?.addEventListener("click", () => {
      if (!this._valid() || !this._dirty()) return;
      const draft = this._draft();
      this._emit("prompt-save", { mode: draft.mode, text: draft.text.trim() });
    });
    $(".spe-cancel")?.addEventListener("click", () => {
      this._draftRev = -1; // re-seed from the saved data
      this._render();
      this._wire();
    });
    for (const btn of this._root.querySelectorAll(".spe-reset")) {
      // The banner reset targets the EFFECTIVE override (the inherited hub
      // record when this scope inherits); the editor-tab reset is exact-scope.
      const effective = btn.closest(".spe-banner") != null;
      btn.addEventListener("click", () => this._emit("prompt-reset", { effective }));
    }
    $(".spe-keep")?.addEventListener("click", () => this._emit("prompt-keep", {}));
    $(".spe-diff-toggle")?.addEventListener("click", () => {
      this._diffOpen = !this._diffOpen;
      this._render();
      this._wire();
    });
    $(".spe-copy-builtin")?.addEventListener("click", (e) =>
      this._copy(this._data?.base?.content ?? "", e.currentTarget));
    $(".spe-copy-effective")?.addEventListener("click", (e) =>
      this._copy(this._data?.effective?.text ?? "", e.currentTarget));
    $(".spe-export")?.addEventListener("click", () => this._export());
  }
}
customElements.define("system-prompt-editor", SystemPromptEditor);

export function durableRunActionsForPhase(phase) {
  return {
    cancel: ["running", "settling", "paused-permission", "paused-interruption", "paused-side-effect-uncertain", "paused-provider-change", "resume-dispatching"].includes(phase),
    resume: ["paused-permission", "paused-provider-change", "paused-side-effect-uncertain"].includes(phase),
    logs: true,
  };
}

export function durableCancelConfirmationText(run) {
  const context = String(run?.taskPreview || run?.agentId || run?.kind || "run").slice(0, 120);
  return `Cancel ${context}? This is terminal: the run will not restart automatically. Retained logs will remain available.`;
}

/* <durable-run-registry> — owner-visible retained run controls. Data is set
 * through `.runs`; actions are native buttons and emit exact-ID events with a
 * completion callback so pending/error/live state remains inside the component. */
class DurableRunRegistry extends Component {
  constructor() {
    super();
    this._runs = [];
    this._pending = new Set();
    this._logs = new Map();
    this._logTruncated = new Set();
    this._page = 0;
    this._message = "";
    this._error = "";
  }
  set runs(value) {
    this._runs = Array.isArray(value) ? structuredClone(value) : [];
    this._page = Math.min(this._page, Math.max(0, Math.ceil(this._runs.length / 10) - 1));
    this._render(); this._wire();
  }
  get runs() { return structuredClone(this._runs); }
  setLogs(executionId, logs) { this._logs.set(executionId, Array.isArray(logs) ? structuredClone(logs) : []); this._render(); this._wire(); }
  _context(run) { return String(run.taskPreview || run.agentId || run.kind || "run").slice(0, 120); }
  // Human-facing phase labels (the internal phases are machinery, not prose —
  // the owner said the raw strings push everything off screen; keep them subtle).
  _phaseLabel(phase) {
    return ({
      running: "Running", settling: "Finishing", "paused-permission": "Paused — needs permission",
      "paused-interruption": "Paused", "paused-side-effect-uncertain": "Paused — outcome uncertain",
      "paused-provider-change": "Paused — provider changed", "resume-dispatching": "Resuming…",
      done: "Done", failed: "Failed", cancelled: "Cancelled",
    })[phase] || String(phase || "unknown");
  }
  // A one-line, human reason: the raw internal detail stays in the logs/title,
  // never as visible prose.
  _reasonLine(run) {
    const raw = run.pause?.reason || run.terminal?.summary || "";
    if (!raw) return "";
    const text = String(raw).replace(/\s+/g, " ").slice(0, 90);
    return text.length >= String(raw).length ? text : `${text}…`;
  }
  // Truncate the task preview to a subtle one-liner (the full text stays in
  // the title attribute + logs).
  _shortContext(run) {
    const ctx = this._context(run);
    return ctx.length > 64 ? `${ctx.slice(0, 64)}…` : ctx;
  }
  _cancellable(phase) { return durableRunActionsForPhase(phase).cancel; }
  _resumable(phase) { return durableRunActionsForPhase(phase).resume; }
  async _confirmCancel(run) {
    // Native-modal confirm (never window.confirm): cancel/Escape/backdrop
    // resolve false and mutate nothing; the body names the exact run.
    return await confirmActionDialog({
      title: "Cancel run",
      body: durableCancelConfirmationText(run),
      confirmLabel: "Cancel run",
      destructive: true,
    });
  }
  _complete(executionId, action, result) {
    this._pending.delete(executionId);
    const ok = result?.ok === true || result?.cancelled === true;
    this._message = ok ? `${action} succeeded for ${this._context(this._runs.find((run) => run.executionId === executionId) || {})}.` : "";
    this._error = ok ? "" : String(result?.error || `${action} failed`);
    if ((action === "View log" || action === "View logs") && ok) {
      this._logs.set(executionId, result.logs || []);
      if (result.truncated === true) this._logTruncated.add(executionId);
      else this._logTruncated.delete(executionId);
    }
    this._render(); this._wire();
  }
  _emitAction(type, run, action) {
    if (this._pending.has(run.executionId)) return;
    this._pending.add(run.executionId);
    this._message = `${action} pending for ${this._context(run)}.`;
    this._error = "";
    this._render(); this._wire();
    this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail: {
      executionId: run.executionId,
      ownerConfirmed: type === "run-resume" && ["paused-side-effect-uncertain", "paused-provider-change"].includes(run.phase),
      complete: (result) => this._complete(run.executionId, action, result),
    } }));
  }
  _render() {
    // Keep the DOM bounded while making EVERY retained run reachable. The old
    // three-row cap turned older logs into a dead end; page instead of growing.
    const PAGE_SIZE = 10;
    const all = this._runs;
    const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const shown = all.slice(this._page * PAGE_SIZE, (this._page + 1) * PAGE_SIZE);
    const items = shown.map((run, index) => {
      const context = this._context(run);
      const short = this._shortContext(run);
      const phaseLabel = this._phaseLabel(run.phase);
      const reason = this._reasonLine(run);
      const descriptionId = `durable-run-${index}-description`;
      const pending = this._pending.has(run.executionId);
      const logs = this._logs.get(run.executionId);
      return `<li class="run" data-execution-id="${escapeHtml(run.executionId)}" title="${escapeHtml(context)}" ${pending ? 'aria-busy="true"' : ""}>
        <div class="summary"><strong>${escapeHtml(short)}</strong><span class="phase">${escapeHtml(phaseLabel)}</span></div>
        ${reason ? `<p class="description" id="${descriptionId}">${escapeHtml(reason)}</p>` : ""}
        <div class="actions">
          ${this._cancellable(run.phase) ? `<button type="button" data-action="cancel" aria-describedby="${descriptionId}" ${pending ? "disabled" : ""}>Cancel</button>` : ""}
          ${this._resumable(run.phase) ? `<button type="button" data-action="resume" aria-describedby="${descriptionId}" ${pending ? "disabled" : ""}>${run.phase === "paused-side-effect-uncertain" ? "Retry" : "Resume"}</button>` : ""}
          <button type="button" data-action="logs" aria-describedby="${descriptionId}" ${pending ? "disabled" : ""}>View log</button>
        </div>
        ${logs ? `${this._logTruncated.has(run.executionId) ? '<p class="log-note">Showing the latest 200 log entries.</p>' : ""}<pre class="logs" tabindex="0" aria-label="Retained logs for ${escapeHtml(context)}">${escapeHtml(JSON.stringify(logs, null, 2))}</pre>` : ""}
      </li>`;
    }).join("");
    const pager = pageCount > 1
      ? `<nav class="pager" aria-label="Run log pages"><button type="button" data-page="newer" ${this._page === 0 ? "disabled" : ""}>Newer</button><span>Page ${this._page + 1} of ${pageCount}</span><button type="button" data-page="earlier" ${this._page >= pageCount - 1 ? "disabled" : ""}>Earlier</button></nav>`
      : "";
    mountTemplate(this, `
      :host { display:block; min-inline-size:0; }
      :host([hidden]) { display:none; }
      .heading { margin:0 0 .5rem; font-size:1rem; color:var(--ink,#1d1b18); }
      ul { list-style:none; margin:0; padding:0; display:grid; gap:.625rem; }
      .run { min-inline-size:0; padding:.75rem; border:1px solid var(--border,#e3e0d9); border-radius:.75rem; background:var(--panel,#fff); }
      .summary { display:flex; flex-wrap:wrap; align-items:baseline; gap:.375rem .75rem; min-inline-size:0; }
      strong { overflow-wrap:anywhere; }
      .phase { color:var(--muted,#635e56); font-size:.8125rem; }
      .description { margin:.375rem 0; color:var(--muted,#635e56); font-size:.8125rem; overflow-wrap:anywhere; }
      .actions { display:flex; flex-wrap:wrap; gap:.5rem; }
      button { min-block-size:2.25rem; max-inline-size:100%; padding:.4rem .75rem; border:1px solid var(--border,#e3e0d9); border-radius:.5rem; background:var(--panel,#fff); color:var(--ink,#1d1b18); font:inherit; cursor:pointer; overflow-wrap:anywhere; }
      button[data-action="cancel"] { color:var(--danger,#b3261e); }
      button:hover:not(:disabled) { border-color:var(--accent,#0e6e63); }
      button:focus-visible, .logs:focus-visible { outline:.1875rem solid var(--accent,#0e6e63); outline-offset:.125rem; }
      button:disabled { cursor:wait; opacity:.6; }
      .logs { max-block-size:14rem; overflow:auto; margin:.375rem 0 0; padding:.625rem; border-radius:.5rem; background:var(--panel-2,#efede8); white-space:pre-wrap; overflow-wrap:anywhere; font-size:.75rem; }
      .log-note { margin:.625rem 0 0; color:var(--muted,#635e56); font-size:.75rem; }
      .pager { display:flex; align-items:center; justify-content:flex-end; gap:.625rem; margin-block-start:.625rem; color:var(--muted,#635e56); font-size:.8125rem; }
      .status { min-block-size:1.25rem; margin:.5rem 0 0; color:var(--muted,#635e56); }
      .error { color:var(--danger,#b3261e); }
    `, `<section aria-label="Conversation run logs"><h2 class="heading">Run logs</h2><ul role="list">${items}</ul>${pager}<p class="status ${this._error ? "error" : ""}" role="status" aria-live="polite">${escapeHtml(this._error || this._message)}</p></section>`);
  }
  _wire() {
    for (const button of this._root.querySelectorAll("button[data-page]")) {
      button.addEventListener("click", () => {
        this._page += button.dataset.page === "earlier" ? 1 : -1;
        this._render(); this._wire();
      });
    }
    for (const button of this._root.querySelectorAll("button[data-action]")) {
      button.addEventListener("click", async () => {
        const row = button.closest(".run");
        const run = this._runs.find((item) => item.executionId === row?.dataset.executionId);
        if (!run) return;
        const action = button.dataset.action;
        if (action === "cancel") {
          if (!await this._confirmCancel(run)) return;
          this._emitAction("run-cancel", run, "Cancel");
        } else if (action === "resume") {
          if (run.phase === "paused-side-effect-uncertain" && await confirmActionDialog({
            title: "Retry run?",
            body: `Retry ${this._context(run)}? A previous side effect may have completed, so retrying can repeat it.`,
            confirmLabel: "Retry",
            destructive: true,
          }) !== true) return;
          if (run.phase === "paused-provider-change" && await confirmActionDialog({
            title: "Resume run?",
            body: `Resume ${this._context(run)} with the newly selected provider? The original provider identity is no longer active.`,
            confirmLabel: "Resume",
          }) !== true) return;
          this._emitAction("run-resume", run, "Resume");
        } else this._emitAction("run-logs", run, "View log");
      });
    }
  }
}
customElements.define("durable-run-registry", DurableRunRegistry);

/* ──────────────────────────────────────────────────────────────────────────
 * <tool-library> — READ-ONLY owner diagnostics for the tool catalog contract
 * (CAP-FB-20260822-TOOL-LIBRARY-UI-01, panel-1 first slice).
 *
 * HARD BOUNDARY: the ONLY action surface is the Settings preview Run
 * button (an EXPLICIT owner click that emits tool-preview-request; the options
 * surface wires the single tool.preview.run route over the static allowlist).
 * No install/update/revoke/grant/execute/verify/copy, no catalog/provider
 * selection authority.
 * It renders bounded metadata from the Settings-principal tool-catalog.shadow
 * diagnostics route only (summary in production; rows when a future reviewed
 * slice supplies bounded search results — the gallery exercises that path).
 * It never imports the package authority, never queries the network, and never
 * makes a signer-verification claim (there is no verification path in this
 * build, so no claim can be truthful).
 * ────────────────────────────────────────────────────────────────────────── */
const TOOL_LIBRARY_SOURCE_LABELS = Object.freeze({
  "extension-builtin": "Built-in",
  "chrome-api": "Browser",
  "management": "Management",
  "webmcp-declared": "Site tools (declared)",
  "webmcp-inferred": "Site tools (inferred)",
  "bundled-package": "Bundled packages",
});
const TOOL_LIBRARY_AVAILABILITY = Object.freeze({
  ready: "Ready",
  "owner-action-required": "Owner action required",
  stale: "Stale",
  disabled: "Disabled",
});

class ToolLibrary extends Component {
  constructor() {
    super();
    this._state = "loading"; // loading | ready | error | unavailable
    this._summary = null;
    this._results = null;
    this._error = "";
    this._announcedState = ""; // live-region-once: announce each state once
  }
  set state(value) {
    this._state = ["loading", "ready", "error", "unavailable"].includes(value) ? value : "error";
    if (this._rendered) this._render();
  }
  set summary(value) {
    this._summary = value && typeof value === "object" ? value : null;
    if (this._rendered) this._render();
  }
  set results(value) {
    this._results = Array.isArray(value) ? value : null;
    if (this._rendered) this._render();
  }
  set error(value) {
    this._error = typeof value === "string" ? value.slice(0, 240) : "";
    if (this._rendered) this._render();
  }
  set previewResult(value) {
    // Bounded preview output: the SW already bound the result to the immutable
    // tool encoding. Render only inert text; raw bytes never reach the DOM.
    const out = this._root.querySelector(".preview-output");
    if (!out) return;
    this._previewResult = value && typeof value === "object" ? value : null;
    if (value && typeof value === "object") {
      out.classList.toggle("error", value.ok !== true);
      const text = value.ok === true && value.stdoutEncoding === "base64"
        ? `gzip output · ${Number.isSafeInteger(value.stdoutBytes) ? value.stdoutBytes : 0} bytes · canonical base64\n${String(value.stdoutBase64 ?? "")}`
        : value.ok === true
        ? String(value.stdout ?? "")
        : String(value.error ?? "preview failed");
      out.textContent = text.slice(0, 256 * 1024);
    } else {
      out.classList.remove("error");
      out.textContent = "";
    }
  }
  set previewBusy(value) {
    this._previewBusy = value === true;
    const button = this._root.querySelector(".preview-run");
    const out = this._root.querySelector(".preview-output");
    if (button) button.disabled = value === true;
    if (out) out.textContent = value === true ? "Running…" : out.textContent;
  }
  // Per-tool example/help copy (static, bounded — the tool selector shows it).
  _previewHelp(toolId, gzipMode = "compress") {
    switch (toolId) {
      case "gzip":
        return gzipMode === "decompress"
          ? "Decompress canonical standard base64 only (≤2,048 characters / 1,536 decoded bytes); output stays canonical base64."
          : "Compress bounded UTF-8 text (≤2,048 bytes); output is the complete canonical-base64 gzip member.";
      case "uuid":
        return 'Example: args "-n 2" + empty stdin → two RFC 4122 v4 UUIDs (one per line).';
      case "head":
        return 'Example: args "-n 2" + stdin "a\nb\nc" → "a\nb" (first two lines).';
      case "tail":
        return 'Example: args "-n 2" + stdin "a\nb\nc" → "b\nc" (last two lines).';
      case "cut":
        return 'Example: args "-d , -f 2" + stdin "a,b,c" → "b" (the second field).';
      case "base64":
        return 'Example: (no args) + stdin "hello" → "aGVsbG8=\n".';
      case "md5sum":
        return 'LEGACY — NOT for security. Example: (no args) + stdin "hello" → "5d41402abc4b2a76b9719d911017c592\n".';
      case "sha256sum":
        return 'Example: (no args) + stdin "hello" → "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\n".';
      case "sha512sum":
        return 'Example: (no args) + stdin "hello" → "9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043\n".';
      case "wc":
        return 'Example: (no args) + stdin "one two\nthree\n" → "2 3 14\n" (lines, words, bytes).';
      case "xxd":
        return 'Example: args "-p" + stdin "Hi" → "4869\n" (plain hex).';
      case "sort":
        return 'Example: (no args) + stdin "b\na\n" → "a\nb\n" (sorted lines).';
      case "uniq":
        return 'Example: (no args) + stdin "a\na\nb\n" → "a\nb\n" (adjacent duplicates removed).';
      case "tr":
        return 'Example: args "a-z" "A-Z" + stdin "Hi\n" → "HI\n" (translate).';
      case "grep":
        return 'Example: args "-n" "foo" + stdin "foo\nbar\nfood\n" → "1:foo\n3:food\n". Invalid regexes fail closed with no output.';
      case "toml2json":
        return 'Example: (no args) + stdin "title = \"x\"\n[n]\na = 1\n" → "{\"title\":\"x\",\"n\":{\"a\":1}}\n".';
      case "markdown":
        return 'Example: (no args) + stdin "# Hi" → "<h1>Hi</h1>\n" (safe HTML — raw HTML and javascript: URLs omitted; --unsafe is disabled).';
      case "diff":
        return 'Two documents (≤1 KiB each): Document A "a\nb\n" + Document B "a\nc\n" → the unified hunk (exit 1 is a normal result).';
      case "patch":
        return 'Two documents (≤1 KiB each): Document A the original + Document B a unified diff → the patched text (exact-position only).';
      case "stat":
        return 'Example: args "/job/inputs/f.bin" → "path=/job/inputs/f.bin\\ntype=regular file\\nsize=2\\nmtime=0.000000000\\n" (read-only immutable job seed).';
      case "du":
        return 'Example: leave args empty for the immutable "/job" default → "1\\t/job/inputs\\n1\\t/job\\n" (read-only deterministic inputs/f.bin seed).';
      case "tree":
        return 'Example: leave args empty for the immutable "/job/inputs" default → a sorted Unicode tree with f.bin and sub/g.txt (read-only nested seed).';
      case "truncate":
        return 'Resizes the spec-owned /job/scratch/touched fixture: -s accepts integer bytes or one K/M/G/T suffix (optional +/-, 0..10 MiB) and -c skips the create. Empty stdout — the size change is read back after the run.';
      case "touch":
        return 'Sets the timestamp on the spec-owned /job/scratch/touched fixture: -t is a decimal Unix epoch (0..4102444800 s, 1970–2100); -a/-m select atime/mtime (default both); -c skips the create. Empty stdout — the timestamp change is read back after the run.';
      case "sqlite3_query_bounded":
        return 'Runs a read-only SQL query over the spec-owned scratch/test.db fixture: type SQL below and optional JSON params (≤8); readOnly is forced. Output is the exact JSON row set (≤64 KiB).';
      default:
        return 'Example: (no args) + stdin "a,b\n1,2\n3,4" → re-emits the CSV rows.';
    }
  }
  _isTwoDocument(toolId) {
    return toolId === "diff" || toolId === "patch";
  }
  _updateDocCounts() {
    const root = this._root;
    const enc = new TextEncoder();
    const a = root.querySelector(".preview-doc-a");
    const b = root.querySelector(".preview-doc-b");
    const ca = root.querySelector("#preview-doc-a-count");
    const cb = root.querySelector("#preview-doc-b-count");
    if (a && ca) ca.textContent = `${enc.encode(String(a.value ?? "")).byteLength} bytes`;
    if (b && cb) cb.textContent = `${enc.encode(String(b.value ?? "")).byteLength} bytes`;
  }
  _wire() {
    // The ONLY interactive paths: the explicit owner click that runs the
    // selected tool's Settings preview + the tool selector (help refresh +
    // the two-document mode toggle) + the per-document byte counters. No other
    // control exists in this component.
    this._root.querySelector(".preview-run")?.addEventListener("click", (sourceEvent) => {
      if (this._previewBusy) return;
      const toolSelect = this._root.querySelector(".preview-tool");
      const argsInput = this._root.querySelector(".preview-args");
      const stdinInput = this._root.querySelector(".preview-stdin");
      const toolId = String(toolSelect?.value ?? "csvtool");
      if (toolId === "gzip") {
        const mode = String(this._root.querySelector(".preview-gzip-mode")?.value ?? "compress");
        const args = mode === "decompress" ? ["-d"] : [];
        const stdin = String(stdinInput?.value ?? "");
        this._emit("tool-preview-request", { toolId, args, stdin, sourceEvent });
      } else if (toolId === "truncate") {
        const size = String(this._root.querySelector(".preview-truncate-size")?.value ?? "0").trim() || "0";
        const noCreate = this._root.querySelector(".preview-truncate-no-create")?.checked === true;
        const args = noCreate
          ? ["-c", "-s", size, "/job/scratch/touched"]
          : ["-s", size, "/job/scratch/touched"];
        this._emit("tool-preview-request", { toolId, args, stdin: "", sourceEvent });
      } else if (toolId === "touch") {
        const epoch = String(this._root.querySelector(".preview-touch-epoch")?.value ?? "0").trim() || "0";
        const side = String(this._root.querySelector(".preview-touch-side")?.value ?? "both");
        const noCreate = this._root.querySelector(".preview-touch-no-create")?.checked === true;
        const args = [
          "-t", epoch,
          ...(side === "atime" ? ["-a"] : side === "mtime" ? ["-m"] : []),
          ...(noCreate ? ["-c"] : []),
          "/job/scratch/touched",
        ];
        this._emit("tool-preview-request", { toolId, args, stdin: "", sourceEvent });
      } else if (toolId === "sqlite3_query_bounded") {
        const sql = String(this._root.querySelector(".preview-sqlite-sql")?.value ?? "");
        const paramsText = String(this._root.querySelector(".preview-sqlite-params")?.value ?? "").trim() || "[]";
        let params;
        try { params = JSON.parse(paramsText); } catch { params = []; }
        const stdin = JSON.stringify({ sql, params, database: "test.db", readOnly: true });
        this._emit("tool-preview-request", { toolId, args: [], stdin, sourceEvent });
      } else if (this._isTwoDocument(toolId)) {
        const docA = String(this._root.querySelector(".preview-doc-a")?.value ?? "");
        const docB = String(this._root.querySelector(".preview-doc-b")?.value ?? "");
        // The two documents ride args[1..2] (the current binaries' argv
        // contract); stdin stays empty; NUL/BOM rejected by validation.
        this._emit("tool-preview-request", { toolId, args: [docA, docB], stdin: "", sourceEvent });
      } else {
        const args = String(argsInput?.value ?? "").trim() === ""
          ? []
          : String(argsInput?.value ?? "").split(/\s+/);
        const stdin = String(stdinInput?.value ?? "");
        this._emit("tool-preview-request", { toolId, args, stdin, sourceEvent });
      }
    });
    this._root.querySelector(".preview-tool")?.addEventListener("change", (event) => {
      const toolId = String(event?.target?.value ?? "csvtool");
      const help = this._root.querySelector(".preview-help");
      const twoDoc = this._root.querySelector(".preview-two-doc");
      const stdinLabel = this._root.querySelector(".preview-stdin-label");
      const stdinInput = this._root.querySelector(".preview-stdin");
      const argsLabel = this._root.querySelector(".preview-args-label");
      const gzipControls = this._root.querySelector(".preview-gzip-controls");
      const gzipModeSelect = this._root.querySelector(".preview-gzip-mode");
      const truncateControls = this._root.querySelector(".preview-truncate-controls");
      const touchControls = this._root.querySelector(".preview-touch-controls");
      const sqliteControls = this._root.querySelector(".preview-sqlite-controls");
      const stdinLabelText = this._root.querySelector(".preview-stdin-label-text");
      const twoDocMode = this._isTwoDocument(toolId);
      const gzipMode = toolId === "gzip";
      const truncateMode = toolId === "truncate";
      const touchMode = toolId === "touch";
      const sqliteMode = toolId === "sqlite3_query_bounded";
      if (help) help.textContent = this._previewHelp(toolId, String(gzipModeSelect?.value ?? "compress"));
      if (twoDoc) twoDoc.hidden = !twoDocMode;
      if (gzipControls) gzipControls.hidden = !gzipMode;
      if (truncateControls) truncateControls.hidden = !truncateMode;
      if (touchControls) touchControls.hidden = !touchMode;
      if (sqliteControls) sqliteControls.hidden = !sqliteMode;
      // Two-document mode hides both generic controls. gzip keeps stdin but
      // replaces free-form argv with its exact native mode select. truncate/
      // touch/sqlite replace both with their spec-owned fixture controls.
      if (stdinLabel) stdinLabel.hidden = twoDocMode || truncateMode || touchMode || sqliteMode;
      if (stdinInput) {
        stdinInput.hidden = twoDocMode || truncateMode || touchMode || sqliteMode;
        stdinInput.placeholder = gzipMode
          ? (gzipModeSelect?.value === "decompress" ? "H4sI…" : "Enter bounded UTF-8 text")
          : "a,b\n1,2\n3,4";
      }
      if (argsLabel) argsLabel.hidden = twoDocMode || gzipMode || truncateMode || touchMode || sqliteMode;
      if (stdinLabelText) stdinLabelText.textContent = gzipMode
        ? (gzipModeSelect?.value === "decompress" ? "Canonical base64 gzip input" : "UTF-8 text input")
        : "Stdin (bounded)";
      this.previewResult = null;
      this._updateDocCounts();
    });
    this._root.querySelector(".preview-gzip-mode")?.addEventListener("change", (event) => {
      const mode = String(event?.target?.value ?? "compress");
      const help = this._root.querySelector(".preview-help");
      const label = this._root.querySelector(".preview-stdin-label-text");
      const stdin = this._root.querySelector(".preview-stdin");
      if (help) help.textContent = this._previewHelp("gzip", mode);
      if (label) label.textContent = mode === "decompress"
        ? "Canonical base64 gzip input"
        : "UTF-8 text input";
      if (stdin) {
        stdin.value = "";
        stdin.placeholder = mode === "decompress" ? "H4sI…" : "Enter bounded UTF-8 text";
      }
      this.previewResult = null;
    });
    this._root.querySelector(".preview-doc-a")?.addEventListener("input", () => this._updateDocCounts());
    this._root.querySelector(".preview-doc-b")?.addEventListener("input", () => this._updateDocCounts());
  }
  _render() {
    // Mount ONCE: the live region must be a STABLE node so a polite
    // announcement fires exactly once per state transition. Re-renders update
    // only .catalog — rebuilding the status-line node would either lose the
    // announcement or re-announce the same text.
    if (!this._root.querySelector(".status-line")) {
      mountTemplate(this, `
      :host { display:block; color:var(--text, #24211f); }
      .framing { margin:0 0 12px; padding:10px 12px; border-radius:var(--radius-md,10px);
        background:var(--bg, #f7f6f3); color:var(--muted, #625d57); font-size:13px; }
      .groups { margin:0 0 16px; padding:0; display:grid; gap:6px; }
      .groups details { border:1px solid var(--border, #ddd8d2); border-radius:var(--radius-md,10px);
        background:var(--panel, #fff); }
      .groups summary { display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; cursor:pointer;
        padding:9px 12px; font-size:13px; min-inline-size:0; list-style-position:outside; }
      .groups summary::-webkit-details-marker { display:inline-block; }
      .groups summary:focus-visible { outline:2px solid var(--accent, #0e6e63); outline-offset:2px; }
      .groups .count { margin-inline-start:auto; font-variant-numeric:tabular-nums; font-weight:700; }
      .groups .source-tools { margin:0; padding:0 12px 10px; list-style:none; display:grid; gap:8px; }
      .source-tool { min-inline-size:0; }
      .source-tool + .source-tool { border-block-start:1px solid var(--border, #ddd8d2); padding-block-start:8px; }
      .source-tool-head { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:8px; align-items:start; }
      .source-tool-head strong { font-size:13px; overflow-wrap:anywhere; min-inline-size:0; }
      .source-tool-head .avail { font-size:11px; padding:1px 8px; border:1px solid var(--border, #ddd8d2);
        border-radius:999px; color:var(--muted, #625d57); white-space:nowrap; }
      .source-tool-head .avail.unavailable { border-color:var(--warning, #9a6b00); color:var(--warning, #9a6b00); }
      .source-tool-desc { margin:4px 0 0; font-size:12px; color:var(--muted, #625d57);
        overflow-wrap:anywhere; min-inline-size:0; }
      @media (max-width:560px) { .source-tool-head { grid-template-columns:1fr; } }
      .rows { margin:12px 0 0; padding:0; list-style:none; display:grid; gap:10px; }
      .tool { border-block-start:1px solid var(--border, #ddd8d2); padding-block-start:12px; min-inline-size:0; }
      .tool:first-child { border-block-start:0; padding-block-start:0; }
      .tool-head { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:8px; align-items:start; }
      h4 { margin:0; font-size:14px; overflow-wrap:anywhere; }
      .meta, .digest, .scope { color:var(--muted, #625d57); font-size:12px; overflow-wrap:anywhere;
        min-inline-size:0; }
      .digest { font-family:ui-monospace,monospace; word-break:break-all; }
      .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; min-inline-size:0; }
      .chip { font-size:11px; padding:2px 8px; border:1px solid var(--border, #ddd8d2);
        border-radius:999px; color:var(--muted, #625d57); max-inline-size:100%; overflow-wrap:anywhere; }
      .chip.avail-owner-action-required { border-color:var(--warning, #9a6b00); color:var(--warning, #9a6b00); }
      .chip.avail-stale { border-color:var(--muted, #625d57); }
      .chip.avail-disabled { border-color:var(--danger, #b3261e); color:var(--danger, #b3261e); }
      .diag { margin-top:12px; }
      .diag summary { cursor:pointer; font-size:13px; font-weight:600; }
      .diag ul { margin:8px 0 0; padding:0; list-style:none; display:grid; gap:4px;
        font-size:12px; color:var(--muted, #625d57); }
      .packages { margin-top:20px; border-block-start:1px solid var(--border, #ddd8d2); padding-block-start:16px; }
      .packages h3 { margin:0 0 4px; font-size:15px; }
      .preview { margin-top:20px; border-block-start:1px solid var(--border, #ddd8d2); padding-block-start:16px; }
      .preview h3 { margin:0 0 4px; font-size:15px; }
      .preview label { display:block; margin:8px 0 0; font-size:13px; color:var(--muted, #625d57); }
      .preview select { display:block; width:100%; box-sizing:border-box; margin-top:4px;
        border:1px solid var(--border, #ddd8d2); border-radius:var(--radius-md, 8px);
        font:inherit; font-size:13px; padding:6px 8px; background:var(--panel, #fff); color:var(--text, #24211f); }
      .preview-help { margin:8px 0 0; font-size:12px; color:var(--muted, #625d57); overflow-wrap:anywhere; }
      .preview-gzip-controls { margin-block-start:8px; }
      .preview-truncate-controls { margin-block-start:8px; }
      .preview-truncate-note { display:block; margin:4px 0 0; font-size:11px; color:var(--muted, #625d57); }
      .preview-truncate-no-create-label { display:flex; align-items:center; gap:6px; margin:8px 0 0;
        font-size:13px; color:var(--text, #24211f); }
      .preview-truncate-no-create-label input { width:auto; margin:0; }
      .preview-touch-controls { margin-block-start:8px; }
      .preview-touch-note { display:block; margin:4px 0 0; font-size:11px; color:var(--muted, #625d57); }
      .preview-touch-no-create-label { display:flex; align-items:center; gap:6px; margin:8px 0 0;
        font-size:13px; color:var(--text, #24211f); }
      .preview-touch-no-create-label input { width:auto; margin:0; }
      .preview-sqlite-controls { margin-block-start:8px; }
      .preview-sqlite-sql-label, .preview-sqlite-params-label { display:block; margin:8px 0 0;
        font-size:13px; color:var(--muted, #625d57); }
      .preview-sqlite-note { display:block; margin:4px 0 0; font-size:11px; color:var(--muted, #625d57); }
      .preview-two-doc { margin-top:10px; }
      .preview-doc-label { display:block; margin:8px 0 0; font-size:13px; color:var(--muted, #625d57); }
      .preview-doc { display:block; width:100%; box-sizing:border-box; margin-top:4px;
        border:1px solid var(--border, #ddd8d2); border-radius:var(--radius-md, 8px);
        font:inherit; font-size:13px; padding:6px 8px; background:var(--panel, #fff); color:var(--text, #24211f);
        font-family:ui-monospace, monospace; resize:vertical; }
      .preview-doc:focus-visible { outline:2px solid var(--accent, #0e6e63); outline-offset:2px; }
      .preview-doc-count { margin:2px 0 0; font-size:11px; color:var(--muted, #625d57);
        font-variant-numeric:tabular-nums; }
      .preview input, .preview textarea { display:block; width:100%; box-sizing:border-box; margin-top:4px;
        border:1px solid var(--border, #ddd8d2); border-radius:var(--radius-md, 8px);
        font:inherit; font-size:13px; padding:6px 8px; background:var(--panel, #fff); color:var(--text, #24211f); }
      .preview textarea { resize:vertical; font-family:ui-monospace, monospace; }
      .preview [hidden] { display:none; }
      .preview .preview-run { margin-top:10px; padding:6px 14px; border:1px solid var(--border, #ddd8d2);
        border-radius:999px; background:var(--accent, #0e6e63); color:var(--btn-fg,#fff); font:inherit; font-size:13px;
        cursor:pointer; }
      .preview .preview-run:focus-visible { outline:2px solid var(--accent, #0e6e63); outline-offset:2px; }
      .preview .preview-run[disabled] { opacity:.55; cursor:default; }
      .preview-output { min-block-size:2rem; max-block-size:240px; overflow:auto; margin:10px 0 0;
        padding:8px 10px; border:1px solid var(--border, #ddd8d2); border-radius:var(--radius-md, 8px);
        background:var(--bg, #f7f6f3); color:var(--text, #24211f); font:12px/1.45 ui-monospace, monospace;
        white-space:pre-wrap; overflow-wrap:anywhere; }
      .preview-output.error { color:var(--danger, #b3261e); }
      .status-line { min-block-size:1.25rem; margin:10px 0 0; font-size:13px; color:var(--muted, #625d57); }
      .status-line.error { color:var(--danger, #b3261e); }
      @media (max-width:560px) { .tool-head { grid-template-columns:1fr; } .groups .count { margin-inline-start:0; } }
    `, `
      <p class="framing">This is a read-only diagnostic view of the tools the platform can see.
        It cannot run, install, grant, update, or remove anything.</p>
      <div class="catalog"></div>
      <div class="packages">
        <h3>Bundled tool packages</h3>
        <p class="meta">Admitted bundled WebAssembly tool packages will be listed here when loaded.</p>
      </div>
      <div class="preview" hidden>
        <h3>Bundled tool previews</h3>
        <p class="meta">The selector below lists the technically admitted Settings previews. Runs
          ONLY on your explicit click; there is no catalog or provider selection authority.</p>
        <label class="preview-tool-label">Tool
          <select class="preview-tool" autocomplete="off">
            <option value="csvtool">csvtool — parse, transform, and edit RFC 4180 CSV spreadsheet table data</option>
            <option value="uuid">uuid — generate random UUID v4 unique identifier strings</option>
            <option value="head">head — extract first lines from a text stream</option>
            <option value="tail">tail — extract last lines from a text stream</option>
            <option value="cut">cut — extract columns or delimiter-separated fields</option>
            <option value="base64">base64 — encode or decode base64 text and binary data</option>
            <option value="md5sum">md5sum — compute legacy 128-bit MD5 hash checksum values</option>
            <option value="sha256sum">sha256sum — compute cryptographic 256-bit SHA-256 hash digests</option>
            <option value="sha512sum">sha512sum — compute cryptographic 512-bit SHA-512 hash digests</option>
            <option value="wc">wc — count lines, words, characters, and bytes</option>
            <option value="xxd">xxd — convert binary data to hex dumps and reconstruct it</option>
            <option value="sort">sort — sort lines of text in C locale</option>
            <option value="uniq">uniq — remove adjacent duplicate lines from sorted text</option>
            <option value="tr">tr — translate, replace, delete, or squeeze characters</option>
            <option value="grep">grep — search and find matching lines using regex</option>
            <option value="toml2json">toml2json — convert TOML configuration text to JSON</option>
            <option value="markdown">markdown — convert Markdown formatted text to safe HTML</option>
            <option value="diff">diff — compare text documents and calculate diff changes</option>
            <option value="patch">patch — apply unified diff changes to source text</option>
            <option value="stat">stat — inspect file and directory metadata</option>
            <option value="du">du — measure disk usage across directory folders</option>
            <option value="tree">tree — display directory file structures as visual trees</option>
            <option value="gzip">gzip — compress or decompress data streams</option>
            <option value="truncate">truncate — resize a file to a target size (shrink or extend)</option>
            <option value="touch">touch — create empty files or update file timestamps</option>
            <option value="sqlite3_query_bounded">sqlite3_query_bounded — execute SQL queries to read and filter SQLite database tables</option>
          </select>
        </label>
        <p class="preview-help" aria-live="polite">Example: (no args) + stdin "a,b&#10;1,2&#10;3,4" → re-emits the CSV rows.</p>
        <label class="preview-gzip-controls" hidden>Mode
          <select class="preview-gzip-mode" autocomplete="off">
            <option value="compress">Compress text</option>
            <option value="decompress">Decompress base64</option>
          </select>
        </label>
        <label class="preview-truncate-controls" hidden>Size (-s)
          <input class="preview-truncate-size" type="text" autocomplete="off"
            placeholder="0" maxlength="16" />
          <span class="preview-truncate-note">integer bytes or one K/M/G/T suffix, optional +/− (0..10 MiB)</span>
          <label class="preview-truncate-no-create-label">
            <input class="preview-truncate-no-create" type="checkbox" /> -c (no-create)
          </label>
        </label>
        <label class="preview-touch-controls" hidden>Timestamp (-t)
          <input class="preview-touch-epoch" type="text" autocomplete="off"
            placeholder="0" maxlength="16" />
          <span class="preview-touch-note">decimal Unix epoch seconds (0..4102444800, 1970–2100)</span>
          <select class="preview-touch-side" autocomplete="off">
            <option value="both">Both atime + mtime</option>
            <option value="atime">Atime only (-a)</option>
            <option value="mtime">Mtime only (-m)</option>
          </select>
          <label class="preview-touch-no-create-label">
            <input class="preview-touch-no-create" type="checkbox" /> -c (no-create)
          </label>
        </label>
        <div class="preview-sqlite-controls" hidden>
          <label class="preview-sqlite-sql-label" for="preview-sqlite-sql">SQL query</label>
          <textarea class="preview-sqlite-sql" id="preview-sqlite-sql" rows="4"
            placeholder="SELECT * FROM items" spellcheck="false"></textarea>
          <label class="preview-sqlite-params-label" for="preview-sqlite-params">Params (JSON array, ≤8)</label>
          <input class="preview-sqlite-params" id="preview-sqlite-params" type="text" autocomplete="off"
            placeholder="[]" maxlength="512" />
          <span class="preview-sqlite-note">readOnly is forced; the spec-owned scratch/test.db fixture (no user DB)</span>
        </div>
        <label class="preview-args-label">Arguments
          <input class="preview-args" type="text" autocomplete="off"
            placeholder="(none) — e.g. -n 2" maxlength="128" />
        </label>
        <label class="preview-stdin-label" for="preview-stdin"><span class="preview-stdin-label-text">Stdin (bounded)</span></label>
        <textarea class="preview-stdin" id="preview-stdin" rows="4" maxlength="2048"
          placeholder="a,b&#10;1,2&#10;3,4"></textarea>
        <div class="preview-two-doc" hidden>
          <label class="preview-doc-label" for="preview-doc-a">Document A</label>
          <textarea class="preview-doc preview-doc-a" id="preview-doc-a" rows="4"
            aria-describedby="preview-doc-a-count" spellcheck="false"></textarea>
          <p class="preview-doc-count" id="preview-doc-a-count">0 bytes</p>
          <label class="preview-doc-label" for="preview-doc-b">Document B</label>
          <textarea class="preview-doc preview-doc-b" id="preview-doc-b" rows="4"
            aria-describedby="preview-doc-b-count" spellcheck="false"></textarea>
          <p class="preview-doc-count" id="preview-doc-b-count">0 bytes</p>
        </div>
        <button class="preview-run" type="button">Run preview</button>
        <pre class="preview-output" aria-live="polite"></pre>
      </div>
      <p class="status-line" role="status" aria-live="polite" aria-atomic="true"></p>
    `);
    }

    const host = this._root.querySelector(".catalog");
    const statusLine = this._root.querySelector(".status-line");

    // Live-region-once: the status line only changes when the STATE changes, so
    // a polite announcement fires exactly once per transition, never on re-render.
    const stateCopy = {
      loading: "Loading tool diagnostics…",
      ready: "Tool diagnostics loaded.",
      error: `Tool diagnostics unavailable${this._error ? ` — ${this._error}` : "."}`,
      unavailable: "Tool diagnostics need a newer background worker. Reload the extension.",
    };
    if (this._announcedState !== this._state) {
      this._announcedState = this._state;
      statusLine.textContent = stateCopy[this._state] ?? "";
    }
    statusLine.classList.toggle("error", this._state === "error");
    host.replaceChildren();

    if (this._state === "loading" || this._state === "unavailable" || this._state === "error") return;

    const s = this._summary;
    const preview = this._root.querySelector(".preview");
    if (
      preview && Array.isArray(s?.settingsPreviewTools) &&
      s.settingsPreviewTools.includes("csvtool")
    ) preview.hidden = false;
    if (s) {
      const total = document.createElement("p");
      total.className = "meta";
      const gen = typeof s.catalogGeneration === "string" && s.catalogGeneration
        ? ` · catalog generation ${s.catalogGeneration.slice(0, 12)}` : "";
      total.textContent = `${s.descriptorCount ?? 0} tools visible to diagnostics${gen}`;
      host.append(total);

      const packagesMeta = this._root.querySelector(".packages .meta");
      const bundledCount = s.bySource?.["bundled-package"] ?? 0;
      if (packagesMeta) {
        packagesMeta.textContent = bundledCount > 0
          ? `${bundledCount} immutable bundled WebAssembly tool packages are admitted in this build.`
          : "No bundled Wasm packages are admitted in this build. If a future reviewed package host lands, admitted bundles and their pins will be listed here.";
      }

      const groups = document.createElement("section");
      groups.className = "groups";
      groups.setAttribute("aria-label", "Tools by source");
      const rowsBySource = s.toolsBySource ?? {};
      for (const [kind, label] of Object.entries(TOOL_LIBRARY_SOURCE_LABELS)) {
        const count = s.bySource?.[kind] ?? 0;
        const details = document.createElement("details");
        details.className = "source-group";
        details.setAttribute("data-source", kind);
        const summaryEl = document.createElement("summary");
        const name = document.createElement("span");
        name.textContent = label;
        const n = document.createElement("span");
        n.className = "count";
        n.textContent = String(count);
        summaryEl.append(name, n);
        details.append(summaryEl);
        // ONE bounded per-tool summary list per category (name, source label,
        // version/availability, one-line description). Read-only — no action,
        // grant or verify surface is ever rendered here. Bounded at 256 rows to
        // match TOOL_LIBRARY_SUMMARY_LIMITS.maxRowsPerSource (the full registry).
        const rows = Array.isArray(rowsBySource[kind]) ? rowsBySource[kind].slice(0, 256) : [];
        if (rows.length) {
          const list = document.createElement("ul");
          list.className = "source-tools";
          list.setAttribute("role", "list");
          for (const row of rows) {
            const li = document.createElement("li");
            li.className = "source-tool";
            const head = document.createElement("div");
            head.className = "source-tool-head";
            const title = document.createElement("strong");
            title.textContent = String(row.name ?? row.toolId ?? "");
            const avail = document.createElement("span");
            avail.className = `avail${row.available === true ? "" : " unavailable"}`;
            avail.textContent = typeof row.version === "string" && row.version
              ? `v${row.version}`
              : (row.available === true ? "available" : "unavailable");
            head.append(title, avail);
            const desc = document.createElement("p");
            desc.className = "source-tool-desc";
            desc.textContent = String(row.description ?? "");
            li.append(head, desc);
            list.append(li);
          }
          details.append(list);
        }
        groups.append(details);
      }
      host.append(groups);

      const diag = s.catalogDiagnostics ?? {};
      const sel = s.selectionDiagnostics ?? {};
      const lines = [];
      if ((diag.rejected ?? 0) > 0) lines.push(`${diag.rejected} descriptors rejected by validation (fail-closed).`);
      if ((diag.collisions ?? 0) > 0) lines.push(`${diag.collisions} tool name${diag.collisions === 1 ? "" : "s"} claimed by more than one source — all excluded.`);
      if ((diag.duplicateStableIds ?? 0) > 0) lines.push(`${diag.duplicateStableIds} duplicate identities ignored.`);
      if ((diag.truncated ?? 0) > 0) lines.push("Inspection input was truncated at its bound; some sources may be under-counted.");
      lines.push(`Active diagnostic selections: ${sel.activeSelections ?? 0} across ${sel.activeRuns ?? 0} runs.`);
      lines.push(`Grants created: ${sel.grantsCreated ?? 0} · Executable routes created: ${sel.executableRoutesCreated ?? 0}.`);
      const details = document.createElement("details");
      details.className = "diag";
      const summaryEl = document.createElement("summary");
      summaryEl.textContent = "Diagnostics detail";
      const ul = document.createElement("ul");
      ul.setAttribute("role", "list");
      for (const line of lines) {
        const li = document.createElement("li");
        li.textContent = line;
        ul.append(li);
      }
      details.append(summaryEl, ul);
      host.append(details);
    }

    // Bounded diagnostic rows — present only when a caller supplies results
    // (gallery specimens in this slice; production wiring passes none yet).
    const rows = Array.isArray(this._results) ? this._results.slice(0, 64) : [];
    if (rows.length) {
      const list = document.createElement("ul");
      list.className = "rows";
      list.setAttribute("role", "list");
      list.setAttribute("aria-label", "Tool diagnostics results");
      for (const row of rows) {
        const item = document.createElement("li");
        item.className = "tool";
        const head = document.createElement("div");
        head.className = "tool-head";
        const title = document.createElement("h4");
        title.textContent = String(row?.name ?? "(unnamed tool)");
        const avail = String(row?.availability ?? "ready");
        const chip = document.createElement("span");
        chip.className = `chip avail-${avail}`;
        chip.textContent = TOOL_LIBRARY_AVAILABILITY[avail] ?? avail;
        head.append(title, chip);
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = `${TOOL_LIBRARY_SOURCE_LABELS[row?.sourceKind] ?? String(row?.sourceKind ?? "unknown source")} · version ${String(row?.version ?? "unknown")} · replay ${String(row?.trustedReplaySafety ?? "unknown")}`;
        const digest = document.createElement("div");
        digest.className = "digest";
        const full = String(row?.digest ?? "");
        digest.textContent = `digest ${full.slice(0, 12)}${full.length > 12 ? "…" : ""}`;
        if (full) digest.title = full;
        item.append(head, meta, digest);
        const caps = Array.isArray(row?.capabilities) ? row.capabilities.slice(0, 24) : [];
        if (caps.length) {
          const chips = document.createElement("div");
          chips.className = "chips";
          for (const cap of caps) {
            const c = document.createElement("span");
            c.className = "chip";
            c.textContent = String(cap);
            chips.append(c);
          }
          item.append(chips);
        }
        list.append(item);
      }
      host.append(list);
    }
  }
  // Deliberately NO _wire(): there is nothing to listen to — no events, no
  // buttons, no actions. The native <details> disclosure works without script.
}
customElements.define("tool-library", ToolLibrary);

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
