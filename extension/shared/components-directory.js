// shared/components-directory.js — Tool directory components.

import { t } from "./i18n.js";
import {
  Component,
  mountTemplate,
  ICONS,
  escapeHtml,
  summarizeInputSchema,
} from "./components-core.js";

const ARIA_HIDDEN = "aria-hidden";
const TRUE = ""; // boolean-attribute present marker

export class ToolDirectoryCard extends Component {
  constructor() {
    super();
    this._tool = {};
    this._titleId = `tool-title-${Math.random().toString(36).slice(2)}`;
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
    const policy = tool.policy === "deny" ? "deny" : "allow";
    const consentState = policy === "deny"
      ? "disabled"
      : tool.consentState === "allowed" || tool.consentState === "denied" || tool.consentState === "ask"
        ? tool.consentState
        : approved ? "allowed" : "ask";
    const statusChip = consentState === "disabled"
      ? { cls: "blocked", text: "Site tools off", label: "Site tools are turned off" }
      : consentState === "denied"
        ? { cls: "blocked", text: "Blocked", label: "Blocked until you allow it in Settings" }
        : consentState === "allowed"
          ? { cls: "approved", text: "Allowed automatically", label: "Allowed automatically" }
          : { cls: "ask", text: "Ask on first use", label: "Ask on first model use" };
    const manage = tool.manage === true && consentState !== "disabled";
    const busy = tool.busy === true;
    const disabled = busy || tool.disabled === true;
    const action = consentState === "allowed" ? "ask" : "allowed";
    const actionLabel = consentState === "allowed"
      ? "Disable automatic use"
      : consentState === "denied" ? "Allow / try again" : "Allow automatically";
    const pageUrl = typeof tool.pageUrl === "string" && tool.pageUrl ? tool.pageUrl : "";
    const titleId = this._titleId;
    const descriptionId = `${titleId}-description`;
    mountTemplate(this, `
      /* inline-size:100% beside container-type — a block container host with
         no explicit inline size resolves to 0 px wide in a column flex parent
         (CAP-FB-20260830-HUB-CHROME-POLISH-01). */
      :host { display:block; inline-size:100%; min-inline-size:0; container-type:inline-size; }
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
      .tool-status.blocked { color:var(--danger,#cf222e); border-color:currentColor; }
      .tool-status.ask { color:var(--warning,#9a6700); border-color:currentColor; }
      .approve { min-block-size:36px; max-inline-size:100%; padding:6px 10px;
        border:0; border-radius:var(--radius-sm,6px); background:var(--accent,#0e6e63);
        color:var(--btn-fg,#fff); cursor:pointer; font:600 var(--text-sm,13px)/1.4 inherit;
        white-space:normal; overflow-wrap:anywhere; }
      .approve:disabled { opacity:.6; cursor:progress; }
      .approve:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .tool-error { margin:0; color:var(--danger,#cf222e); font-size:var(--text-xs,12px); overflow-wrap:anywhere; }
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
        ${pageUrl ? `<div><dt>Page:</dt><dd>${escapeHtml(pageUrl)}</dd></div>` : ""}
        <div><dt>Schema:</dt><dd>${escapeHtml(summarizeInputSchema(tool.inputSchema))}</dd></div>
      </dl>
      <div class="tool-states" aria-label="States for ${escapeHtml(name)}">
        <span class="tool-status source" aria-label="${escapeHtml(name)}: ${sourceLabel}">${sourceLabel}</span>
        <span class="tool-status ${statusChip.cls}" aria-label="${escapeHtml(name)}: ${statusChip.label}">${statusChip.text}</span>
        ${manage ? `<button class="approve" type="button" data-action="${action}"${disabled ? " disabled" : ""}${busy ? " aria-busy=\"true\"" : ""} aria-label="${escapeHtml(actionLabel)} for ${escapeHtml(name)} on ${escapeHtml(origin)}">${busy ? "Saving…" : escapeHtml(actionLabel)}</button>` : ""}
        ${tool.error ? `<p class="tool-error" role="status">${escapeHtml(String(tool.error).slice(0, 240))}</p>` : ""}
      </div>
    </article>`);
  }
  _wire() {
    this._root.querySelector(".approve")?.addEventListener("click", (event) => {
      const state = event.currentTarget?.dataset?.action === "ask" ? "ask" : "allowed";
      const detail = { origin: this._tool.origin, name: this._tool.name, state };
      this._emit("consent-action", detail);
      if (state === "allowed") this._emit("approve", detail);
    });
  }
}
customElements.define("tool-directory-card", ToolDirectoryCard);


