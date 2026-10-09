// shared/components-artifacts.js — Artifact viewer, diff, and drawer components.

import { t } from "./i18n.js";
import { cachedRpc } from "./rpc-cache.js";
import { lineDiffSummary } from "./diff-core.bundle.js";

import {
  Component,
  mountTemplate,
  ICONS,
  escapeHtml,
  renderHtmlFrame,
  isHtmlDocument,
  wireHtmlFrameContent,
  wireHtmlFramePreference,
  currentFramePreference,
  injectFrameGuards,
  parseJSONAttr,
  prefersReducedMotion,
  RUNTIME_SEND,
} from "./components-core.js";

const ARIA_HIDDEN = "aria-hidden";
const TRUE = ""; // boolean-attribute present marker

export function formatArtifactSize(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) {
    const kb = (n / 1024).toFixed(1).replace(/\.0$/, "");
    return `${kb} KB`;
  }
  const mb = (n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "");
  return `${mb} MB`;
}

/** Format artifact type for badge display (HTML, Markdown, JSON, etc.). */
export function formatArtifactType(type) {
  const t = String(type || "").toLowerCase();
  if (t === "html") return "HTML";
  if (t === "markdown" || t === "md") return "Markdown";
  if (t === "json") return "JSON";
  if (t === "csv") return "CSV";
  if (t === "text") return "Text";
  if (t === "image") return "Image";
  if (t === "data") return "Data";
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "Data";
}

/* <artifact-card id name type size origin time> — an artifact card for the
 * gallery: a LIVE preview thumbnail (an html artifact renders in a sandboxed
 * iframe, an image renders inline, text/data renders as a truncated preview),
 * the name + type/size + source origin + time, and actions (open / reuse /
 * delete). The preview CONTENT is set via the `preview` property (not an
 * attribute — content is large); the card renders a placeholder until it is
 * set. Emits open / reuse / delete. */
export class ArtifactCard extends Component {
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
        previewHtml = renderHtmlFrame(this._preview, { thumbnail: true });
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
        overflow:hidden; }
      .preview { height:188px; position:relative; background:var(--panel-2,#efede8);
        overflow:hidden; border-bottom:1px solid var(--border,#e3e0d9); cursor:pointer; }
      .preview .html-frame { width:100%; height:100%; overflow:hidden; position:relative; }
      .preview .html-frame iframe { width:250%; height:250%; border:0; pointer-events:none;
        transform:scale(0.4); transform-origin:top left; overflow:hidden; }
      .img { width:100%; height:100%; object-fit:cover; display:block; }
      .text { margin:0; padding:14px 16px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
        font-size:var(--text-xs, 12px); line-height:1.5; color:var(--text,#1d1b18);
        background:linear-gradient(180deg, var(--panel,#fff) 0%, var(--panel-2,#efede8) 100%);
        height:100%; box-sizing:border-box; white-space:pre-wrap;
        word-break:break-word; overflow:hidden; }
      .type-badge { position:absolute; top:8px; right:8px; padding:2px 8px; border-radius:999px;
        font-size:var(--text-xs, 12px); font-weight:600; background:color-mix(in srgb, var(--panel,#fff) 88%, transparent);
        border:1px solid var(--border,#e3e0d9); color:var(--muted,#635e56); backdrop-filter:blur(4px);
        pointer-events:none; z-index:2; }
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
      .actions { display:flex; align-items:center; gap:6px; padding:0 12px 12px; flex-wrap:nowrap; }
      .actions button { flex:1 1 0; min-width:0; white-space:nowrap; display:inline-flex;
        align-items:center; justify-content:center; gap:4px; font:inherit; font-size:12px;
        font-weight:500; padding:6px 8px; min-height:32px; border:1px solid var(--border,#e3e0d9);
        border-radius:var(--radius-sm,6px); background:transparent; color:var(--text,#1d1b18);
        cursor:pointer; }
      .actions button:hover { border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      .actions button.danger:hover { border-color:var(--danger,#b3261e); color:var(--danger,#b3261e); }
      .actions button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
      .actions button svg { width:14px; height:14px; flex-shrink:0; }
    `, `<div class="card">
      <div class="preview" part="preview" role="button" tabindex="0" aria-label="Open ${escapeHtml(name)}">${previewHtml}<span class="type-badge">${escapeHtml(formatArtifactType(type))}</span></div>
      <div class="body">
        <span class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="meta">${escapeHtml(type)} · ${escapeHtml(formatArtifactSize(size))} · ${escapeHtml(origin)}${t ? " · " + escapeHtml(t) : ""}</span>
      </div>
      <div class="actions">
        ${act("open-tab", `<button type="button" data-act="open-tab" title="Open in new tab">${ICONS.external}<span>New tab</span></button>`)}
        ${act("reuse", `<button type="button" data-act="reuse">${ICONS.attach}<span>Reuse</span></button>`)}
        ${act("save", `<button type="button" data-act="save" title="Save to disk" aria-label="Save ${escapeHtml(name)} to disk">${ICONS.download}<span>Save</span></button>`)}
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
    this._root.querySelector('[data-act="save"]')?.addEventListener("click", () => this._emit("save", detail()));
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
 * outer HTML parser. Rendering shows the COMPLETE stored content at any size
 * (a truncated source view read as data loss even when Copy was exact — p45y;
 * no size-based refusal — r5) while Copy preserves exact content. */

export class ArtifactInspector extends Component {
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
    const isTable = type === "table" || type === "cap.table/1" || a.meta?.schema === "cap.table/1" || String(a.name ?? "").endsWith(".csv");
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
    `, `<div class="bar"><span class="meta"></span><button type="button" class="copy">Copy exact content</button>${type === "html" || isTable ? '<button type="button" class="primary play">Preview / Play</button>' : ""}</div><pre tabindex="0"><code></code></pre><p class="note" hidden></p><p class="status" role="status" aria-live="polite"></p><div class="preview" hidden></div>`);
    const isFileBacked = a.meta?.fileBacked === true || a.meta?.isStreamBacked === true;
    const isIncomplete = a.meta?.contentIncomplete === true || a.meta?.contentComplete === false;
    const rawBytes = new TextEncoder().encode(content).byteLength;
    const totalBytes = a.meta?.streamBytes ?? a.size ?? rawBytes;
    const metaSuffix = (isFileBacked && isIncomplete) ? ` · ${totalBytes} B (file-backed stream)` : ` · ${totalBytes} B`;
    this._root.querySelector(".meta").textContent = `${type}${metaSuffix} · ${a.origin ?? "master"}`;
    const code = this._root.querySelector("code");
    const lang = this.language;
    // The COMPLETE stored body renders — never a slice and never size-refused
    // (chrome-agent-platform-p45y: the source view once showed only the first
    // 64 KiB, and r4's 4 MiB mount refusal could hide an append-grown body;
    // owner 2026-09-03: no size caps on rendering — whatever the stored or
    // staged body is, the source view shows all of it, byte for byte).
    // textContent mounts the multi-MB case as one text node, so there is no
    // DOM or tokenize cost that needs a size refusal.
    // Highlighting is the ONLY bounded step, and only because the tokenizer
    // runs synchronously: a body above the single-call artifact limit renders
    // as exact plain text instead (tokenizing a multi-MB body would freeze).
    const MAX_ARTIFACT_HIGHLIGHT_BYTES = 256 * 1024; // the single-call content cap (tool-argument-contract)
    if (lang && lang !== "text" && rawBytes <= MAX_ARTIFACT_HIGHLIGHT_BYTES) code.replaceChildren(highlightSource(content, lang, document));
    else code.textContent = content;
    const copyBtn = this._root.querySelector(".copy");
    const note = this._root.querySelector(".note");
    if (isFileBacked && isIncomplete) {
      if (copyBtn) copyBtn.textContent = t("components_copy_preview_content");
      note.hidden = false;
      note.textContent = t("components_preview_initial_note", String(totalBytes));
    } else {
      if (copyBtn) copyBtn.textContent = t("components_copy_exact_content");
      note.hidden = true;
    }
  }
  _wire() {
    this._root.querySelector(".copy")?.addEventListener("click", async () => {
      const status = this._root.querySelector(".status");
      const a = this._asset ?? {};
      const isFileBacked = a.meta?.fileBacked === true || a.meta?.isStreamBacked === true;
      const isIncomplete = a.meta?.contentIncomplete === true || a.meta?.contentComplete === false;
      const successMsg = (isFileBacked && isIncomplete)
        ? t("components_copied_preview")
        : t("components_copied_exact");
      try { await navigator.clipboard.writeText(String(this._asset?.content ?? "")); status.textContent = successMsg; }
      catch { status.textContent = t("components_copy_failed_manual"); }
    });
    this._root.querySelector(".play")?.addEventListener("click", () => this.startPreview());
  }
  startPreview() {
    const host = this._root.querySelector(".preview");
    const a = this._asset ?? {};
    const isTable = a.type === "table" || a.type === "cap.table/1" || a.meta?.schema === "cap.table/1" || String(a.name ?? "").endsWith(".csv");
    if (!host || (a.type !== "html" && !isTable)) return;
    this.stopPreview();
    if (isTable) {
      const tbl = document.createElement("table-preview");
      tbl.table = a.content;
      tbl.setAttribute("name", a.name ?? "Table");
      host.replaceChildren(tbl);
      host.hidden = false;
      this._root.querySelector(".status").textContent = t("components_table_preview_opened");
      return;
    }
    const frame = createHtmlFrame(this._asset.content ?? "", { title:`Interactive preview of ${this._asset.name ?? "HTML artifact"}` });
    host.replaceChildren(frame.wrapper);
    host.hidden = false;
    this._frameCleanup = wireHtmlFramePreference(frame.wrapper, { nonce:frame.nonce, ...currentFramePreference() });
    this._frameDispose = frame.dispose;
    frame.iframe.focus();
    this._root.querySelector(".status").textContent = t("components_sandbox_preview_opened");
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

export class ArtifactDiff extends Component {
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
      .hh { padding:2px 12px; color:var(--muted,#635e56); background:var(--panel-2,#efede8); font-size:var(--text-xs, 12px); user-select:none; }
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
 * <table-preview page="1" page-size="50" max-cols="20">
 * Bounded owner-local preview for canonical cap.table/1 and tabular artifacts
 * (CAP-FB-20260822-SPREADSHEET-TOOLKIT-01 / chrome-agent-platform-def.5).
 *
 * Invariants:
 *   - Maximum 50 rows × 20 cols = at most 1,000 mounted cells per view.
 *   - Scalar-safe cell rendering truncated to <= 512 UTF-8 display bytes.
 *   - Explicit omitted row and column counters in caption and headers.
 *   - Native <table> with <caption>, <thead>, and <th scope="col">.
 *   - Keyboard-operable paging with native buttons and aria-live status.
 *   - Detects formula injection characters (=, +, -, @, |, \t, \r) and
 *     surfaces formula/export safety warnings.
 *   - Zero unsafe innerHTML for cell or header values.
 * ────────────────────────────────────────────────────────────────────────── */
export const TABLE_PREVIEW_LIMITS = Object.freeze({
  maxRows: 50,
  maxCols: 20,
  maxCells: 1000,
  maxCellBytes: 512,
  defaultPageSize: 50,
});

/**
 * Neutralize dangerous formula characters and truncate safely to maxBytes.
 */
function formatCellPreview(val, maxBytes = TABLE_PREVIEW_LIMITS.maxCellBytes) {
  if (val === null || val === undefined) {
    return { display: "", raw: val, isFormula: false, truncated: false };
  }
  let str;
  if (typeof val === "object") {
    try { str = JSON.stringify(val); } catch { str = String(val); }
  } else {
    str = String(val);
  }

  // Formula check: dangerous spreadsheet triggers
  const isFormula = /^\s*[=+\-@|]/.test(str) || /^[\t\r\n]/.test(str);

  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  if (bytes.byteLength <= maxBytes) {
    return { display: str, raw: val, isFormula, truncated: false };
  }

  // Surrogate-safe truncation: iterate characters
  let truncatedStr = "";
  let byteCount = 0;
  for (const ch of str) {
    const chBytes = encoder.encode(ch).byteLength;
    if (byteCount + chBytes > maxBytes - 3) break;
    truncatedStr += ch;
    byteCount += chBytes;
  }
  return {
    display: `${truncatedStr}…`,
    raw: val,
    isFormula,
    truncated: true,
  };
}

function parseSimpleCsv(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = [];
    let cell = "";
    let inQuotes = false;
    const delimiter = line.includes("\t") && !line.includes(",") ? "\t" : ",";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        row.push(cell.trim());
        cell = "";
      } else {
        cell += ch;
      }
    }
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

function normalizeTableInput(input) {
  if (!input) return { columns: [], rows: [] };

  let parsed = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { parsed = JSON.parse(trimmed); } catch { parsed = input; }
    }
  }

  // 1. cap.table/1 object or { columns, rows }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
      const columns = parsed.columns.map((c, idx) => {
        if (typeof c === "string") return { id: `c${idx + 1}`, name: c, type: "string" };
        let typeStr = "string";
        if (c.type && typeof c.type === "object") {
          typeStr = c.type.kind === "decimal" && typeof c.type.scale === "number"
            ? `decimal(${c.type.scale})`
            : String(c.type.kind ?? "string");
        } else if (c.type != null) {
          typeStr = String(c.type);
        }
        return {
          id: c.id ?? `c${idx + 1}`,
          name: String(c.header ?? c.name ?? c.id ?? `col_${idx + 1}`),
          type: typeStr,
        };
      });
      return { columns, rows: parsed.rows };
    }
  }

  // 2. Array of objects: [{ a: 1, b: 2 }, ...]
  if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object" && !Array.isArray(parsed[0])) {
    const keys = Object.keys(parsed[0]);
    const columns = keys.map((k, idx) => ({ id: `c${idx + 1}`, name: k, type: typeof parsed[0][k] }));
    const rows = parsed.map((obj) => keys.map((k) => obj[k] ?? null));
    return { columns, rows };
  }

  // 3. 2D array: [[h1, h2], [v1, v2], ...]
  if (Array.isArray(parsed) && parsed.length > 0 && Array.isArray(parsed[0])) {
    const headers = parsed[0].map((h, idx) => ({ id: `c${idx + 1}`, name: String(h), type: "string" }));
    return { columns: headers, rows: parsed.slice(1) };
  }

  // 4. CSV/TSV text
  if (typeof input === "string") {
    const csvRows = parseSimpleCsv(input);
    if (csvRows.length > 0) {
      const columns = csvRows[0].map((h, idx) => ({ id: `c${idx + 1}`, name: h || `col_${idx + 1}`, type: "string" }));
      return { columns, rows: csvRows.slice(1) };
    }
  }

  return { columns: [], rows: [] };
}

/**
 * Pure render model for <table-preview>.
 * Produces bounded rows, columns, counts, and accessibility text without a DOM.
 */
export function buildTablePreviewModel(input, {
  page = 1,
  pageSize = TABLE_PREVIEW_LIMITS.defaultPageSize,
  maxCols = TABLE_PREVIEW_LIMITS.maxCols,
  maxCellBytes = TABLE_PREVIEW_LIMITS.maxCellBytes,
  tableName = "Table",
} = {}) {
  const norm = normalizeTableInput(input);
  const totalRows = norm.rows.length;
  const totalCols = norm.columns.length;

  const effPageSize = Math.min(Math.max(1, Math.floor(Number(pageSize)) || TABLE_PREVIEW_LIMITS.defaultPageSize), TABLE_PREVIEW_LIMITS.maxRows);
  const effMaxCols = Math.min(Math.max(1, Math.floor(Number(maxCols)) || TABLE_PREVIEW_LIMITS.maxCols), TABLE_PREVIEW_LIMITS.maxCols);

  const totalPages = Math.max(1, Math.ceil(totalRows / effPageSize));
  const currentPage = Math.max(1, Math.min(totalPages, Math.floor(Number(page)) || 1));

  const startRowIdx = (currentPage - 1) * effPageSize;
  const endRowIdx = Math.min(totalRows, startRowIdx + effPageSize);
  const pageRawRows = norm.rows.slice(startRowIdx, endRowIdx);

  const visibleCols = norm.columns.slice(0, effMaxCols);
  const omittedCols = Math.max(0, totalCols - effMaxCols);
  const omittedRows = Math.max(0, totalRows - pageRawRows.length);

  let formulaCellCount = 0;
  const renderedRows = pageRawRows.map((row) => {
    return visibleCols.map((col, cIdx) => {
      const rawVal = Array.isArray(row) ? row[cIdx] : row[col.id ?? col.name];
      const cell = formatCellPreview(rawVal, maxCellBytes);
      if (cell.isFormula) formulaCellCount++;
      return cell;
    });
  });

  const mountedCells = renderedRows.length * visibleCols.length;

  const rowRange = totalRows === 0
    ? "0 rows"
    : `rows ${(startRowIdx + 1).toLocaleString()}–${endRowIdx.toLocaleString()} of ${totalRows.toLocaleString()}`;
  const colInfo = omittedCols > 0
    ? `${visibleCols.length} of ${totalCols.toLocaleString()} columns (${omittedCols.toLocaleString()} columns omitted)`
    : `${totalCols.toLocaleString()} columns`;
  const caption = `${tableName}: ${rowRange}, ${colInfo}`;
  const pageStatus = `Page ${currentPage} of ${totalPages} (${totalRows.toLocaleString()} total rows)`;

  return {
    columns: visibleCols,
    omittedCols,
    omittedRows,
    totalRows,
    totalColumns: totalCols,
    rows: renderedRows,
    page: currentPage,
    totalPages,
    pageSize: effPageSize,
    startRow: totalRows === 0 ? 0 : startRowIdx + 1,
    endRow: endRowIdx,
    mountedCells,
    formulaCellCount,
    caption,
    pageStatus,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
  };
}

export class TablePreview extends Component {
  static get observedAttributes() {
    return ["page", "page-size", "max-cols", "name"];
  }
  constructor() {
    super();
    this._data = null;
    this._page = 1;
  }
  set table(v) { this._data = v; this._rerender(); }
  get table() { return this._data; }
  set data(v) { this._data = v; this._rerender(); }
  get data() { return this._data; }
  set page(v) {
    const num = Math.max(1, Math.floor(Number(v)) || 1);
    if (this._page !== num) {
      this._page = num;
      this.setAttribute("page", String(num));
      this._rerender();
    }
  }
  get page() { return this._page; }

  _rerender() {
    if (this._rendered) { this._render(); this._wire(); }
  }

  _render() {
    const model = buildTablePreviewModel(this._data, {
      page: this.getAttribute("page") ?? this._page,
      pageSize: this.getAttribute("page-size") ?? TABLE_PREVIEW_LIMITS.defaultPageSize,
      maxCols: this.getAttribute("max-cols") ?? TABLE_PREVIEW_LIMITS.maxCols,
      tableName: this.getAttribute("name") || "Table",
    });
    this._model = model;
    this._page = model.page;

    const warnHtml = model.formulaCellCount > 0
      ? `<div class="formula-warning" role="note"><span class="warn-icon" aria-hidden="true">${ICONS.alert || ""}</span> <span>Export notice: ${model.formulaCellCount} cell(s) contain spreadsheet formula characters (=, +, -, @, |). They will be protected with leading apostrophes on CSV export.</span></div>`
      : "";

    mountTemplate(this, `
      :host { display:block; inline-size:100%; font-family:var(--font,system-ui,sans-serif); color:var(--text,#1d1b18); }
      .wrapper { border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-md,8px); background:var(--panel,#fff); overflow:hidden; display:flex; flex-direction:column; }
      .formula-warning { display:flex; align-items:center; gap:8px; padding:8px 12px; background:color-mix(in oklab, var(--warning,#b26200) 10%, var(--panel,#fff)); border-block-end:1px solid var(--border,#e3e0d9); font-size:var(--text-xs,12px); }
      .warn-icon { display:inline-flex; align-items:center; width:16px; height:16px; flex:0 0 auto; color:var(--warning,#b26200); }
      .warn-icon svg { width:16px; height:16px; }
      .scroller { max-block-size:var(--table-preview-max-height,55vh); overflow:auto; -webkit-overflow-scrolling:touch; outline:none; }
      .scroller:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:-2px; }
      table { inline-size:100%; border-collapse:collapse; font-size:var(--text-xs,12px); font-variant-numeric:tabular-nums; text-align:start; }
      caption { text-align:start; padding:8px 12px; font-weight:600; color:var(--muted,#635e56); background:var(--panel-2,#efede8); border-block-end:1px solid var(--border,#e3e0d9); }
      thead { background:var(--panel-2,#efede8); position:sticky; top:0; z-index:1; }
      th { padding:8px 12px; font-weight:600; text-align:start; border-block-end:1px solid var(--border,#e3e0d9); border-inline-end:1px solid color-mix(in oklab, var(--border,#e3e0d9) 50%, transparent); white-space:nowrap; }
      th:last-child { border-inline-end:0; }
      .col-type { font-weight:normal; color:var(--muted,#635e56); font-size:var(--text-xs, 12px); margin-inline-start:4px; }
      .omitted-col-th { color:var(--muted,#635e56); font-style:italic; }
      tbody tr { border-block-end:1px solid color-mix(in oklab, var(--border,#e3e0d9) 40%, transparent); }
      tbody tr:last-child { border-block-end:0; }
      tbody tr:hover { background:color-mix(in oklab, var(--panel-2,#efede8) 50%, transparent); }
      td { padding:6px 12px; border-inline-end:1px solid color-mix(in oklab, var(--border,#e3e0d9) 40%, transparent); font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace); white-space:nowrap; max-inline-size:260px; overflow:hidden; text-overflow:ellipsis; }
      td:last-child { border-inline-end:0; }
      td.formula-cell { color:var(--accent,#0e6e63); font-weight:500; }
      .omitted-td { color:var(--muted,#635e56); font-style:italic; }
      .pagination { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; padding:8px 12px; border-block-start:1px solid var(--border,#e3e0d9); background:var(--panel-2,#efede8); font-size:var(--text-xs,12px); }
      .page-status { color:var(--muted,#635e56); font-weight:500; }
      .controls { display:inline-flex; align-items:center; gap:6px; }
      .btn-p { min-block-size:28px; padding:3px 8px; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,4px); background:var(--panel,#fff); color:var(--text,#1d1b18); cursor:pointer; font:inherit; font-size:12px; }
      .btn-p:hover:not(:disabled) { border-color:var(--accent,#0e6e63); color:var(--accent,#0e6e63); }
      .btn-p:disabled { opacity:0.4; cursor:not-allowed; }
      .btn-p:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
      .empty-notice { padding:24px; text-align:center; color:var(--muted,#635e56); font-style:italic; }
    `, `<div class="wrapper">
      ${warnHtml}
      <div class="scroller" tabindex="0" role="region" aria-label="${escapeHtml(model.caption)}">
        <table>
          <caption>${escapeHtml(model.caption)}</caption>
          <thead>
            <tr>
              ${model.columns.map((col) => `<th scope="col" title="${escapeHtml(col.name)}">${escapeHtml(col.name)}${col.type ? `<span class="col-type">(${escapeHtml(col.type)})</span>` : ""}</th>`).join("")}
              ${model.omittedCols > 0 ? `<th scope="col" class="omitted-col-th">+${model.omittedCols} cols…</th>` : ""}
            </tr>
          </thead>
          <tbody>
            ${model.rows.length === 0
              ? `<tr><td colspan="${Math.max(1, model.columns.length + (model.omittedCols > 0 ? 1 : 0))}" class="empty-notice">No rows to display</td></tr>`
              : model.rows.map((row) => `<tr>
                  ${row.map((cell) => `<td class="${cell.isFormula ? "formula-cell" : ""}" title="${escapeHtml(cell.display)}">${escapeHtml(cell.display)}</td>`).join("")}
                  ${model.omittedCols > 0 ? `<td class="omitted-td">…</td>` : ""}
                </tr>`).join("")}
          </tbody>
        </table>
      </div>
      <nav class="pagination" aria-label="Table pagination">
        <span class="page-status" role="status" aria-live="polite">${escapeHtml(model.pageStatus)}</span>
        <div class="controls">
          <button type="button" class="btn-p first" aria-label="First page" ${!model.hasPrev ? "disabled" : ""}>« First</button>
          <button type="button" class="btn-p prev" aria-label="Previous page" ${!model.hasPrev ? "disabled" : ""}>‹ Prev</button>
          <span class="page-indicator">${model.page} / ${model.totalPages}</span>
          <button type="button" class="btn-p next" aria-label="Next page" ${!model.hasNext ? "disabled" : ""}>Next ›</button>
          <button type="button" class="btn-p last" aria-label="Last page" ${!model.hasNext ? "disabled" : ""}>Last »</button>
        </div>
      </nav>
    </div>`);
  }

  _wire() {
    const scroller = this._root.querySelector(".scroller");
    const m = this._model;
    if (!m) return;

    const gotoPage = (p) => {
      const next = Math.max(1, Math.min(m.totalPages, p));
      if (next !== this._page) {
        this.page = next;
        this._emit("page-change", {
          page: next,
          totalPages: m.totalPages,
          startRow: this._model?.startRow,
          endRow: this._model?.endRow,
        });
      }
    };

    this._root.querySelector(".btn-p.first")?.addEventListener("click", () => gotoPage(1));
    this._root.querySelector(".btn-p.prev")?.addEventListener("click", () => gotoPage(this._page - 1));
    this._root.querySelector(".btn-p.next")?.addEventListener("click", () => gotoPage(this._page + 1));
    this._root.querySelector(".btn-p.last")?.addEventListener("click", () => gotoPage(m.totalPages));

    // Keyboard navigation in table scroller
    scroller?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" && (e.altKey || e.ctrlKey)) {
        e.preventDefault(); gotoPage(this._page + 1);
      } else if (e.key === "ArrowLeft" && (e.altKey || e.ctrlKey)) {
        e.preventDefault(); gotoPage(this._page - 1);
      } else if (e.key === "PageDown") {
        e.preventDefault(); gotoPage(this._page + 1);
      } else if (e.key === "PageUp") {
        e.preventDefault(); gotoPage(this._page - 1);
      } else if (e.key === "Home" && (e.altKey || e.ctrlKey)) {
        e.preventDefault(); gotoPage(1);
      } else if (e.key === "End" && (e.altKey || e.ctrlKey)) {
        e.preventDefault(); gotoPage(m.totalPages);
      }
    });
  }
}
customElements.define("table-preview", TablePreview);


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

export class ArtifactQuickDrawer extends Component {
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
        border:1px solid transparent; border-radius:var(--radius-sm,6px); padding:0;
        background:transparent; color:var(--muted,#635e56); cursor:pointer;
        transition: background .15s ease, color .15s ease, border-color .15s ease; }
      .trigger:hover { border-color:var(--border,#e3e0d9); background:var(--panel-2,#efede8); color:var(--text,#1d1b18); }
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
      label { display:flex; flex-direction:column; gap:4px; min-inline-size:0; font-size:12px; font-weight:600; color:var(--muted,#635e56); }
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
        padding:1px 7px; color:var(--muted,#635e56); font-size:12px; font-weight:600; }
      dl { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px 10px; margin:7px 0 8px; }
      dl div { min-inline-size:0; }
      dt { color:var(--muted,#635e56); font-size:var(--text-xs, 12px); }
      dd { margin:0; color:var(--text,#1d1b18); font-size:var(--text-xs, 12px); overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
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
    `, `<button part="trigger" class="trigger" id="drawer-toggle" type="button" aria-label="${escapeHtml(label)}"
        title="${escapeHtml(label)}" aria-expanded="false" aria-controls="artifact-quick-panel">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg></button>
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
export class CodeBlock extends Component {
  static get observedAttributes() { return ["lang"]; }
  _render() {
    const lang = this.getAttribute("lang") || "";
    const code = (this.textContent || "").replace(/\n$/, "");
    mountTemplate(this, `
      :host { display:block; margin:10px 0; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,6px); background:var(--panel-2,#efede8); overflow:hidden; }
      .head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:4px 10px; background:var(--panel,#ffffff); border-bottom:1px solid var(--border,#e3e0d9); }
      .lang { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:var(--text-xs, 12px); letter-spacing:.02em; color:var(--muted,#635e56); }
      .copy { border:0; background:transparent; color:var(--muted,#635e56); font-size:var(--text-xs, 12px); cursor:pointer; padding:2px 6px; border-radius:4px; }
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


