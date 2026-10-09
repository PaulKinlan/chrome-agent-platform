// shared/components-hub.js — Hub and dashboard elements.

import { t } from "./i18n.js";
import { cachedRpc } from "./rpc-cache.js";
import { canonicalRef, findAgentByRef } from "./agent-registry.js";
import { harnessMarkKey, harnessMonogram } from "./harness-marks.js";
import { USER_VISIBLE_KINDS as USER_VISIBLE_KINDS_ARR } from "./activity-kinds.js";
import { partiesOf, projectBoard, statusOf } from "./board-view-model.js";
import { nextRunLabel, lastRunLabel, NEXT_RUN_TICK_MS, formatCadenceMinutes } from "./next-run-label.js";
import { countDiagnosticsBadgeErrors, isExcludedDiagnosticBadgeEntry } from "./diagnostics-badge.js";
export { formatCadenceMinutes };
const USER_VISIBLE_KINDS = new Set(USER_VISIBLE_KINDS_ARR);

import { filterTimeline, timelineMatchesFilter, groupTimelineByTopic } from "./hub-timeline.js";
import { redactSecrets } from "./pure.js";
import { SITE_AGENT_COPY, siteOfferHost, siteOfferLabel, siteUsingLabel } from "./site-agent-copy.js";
import { safeParseOnce, buildTree } from "./tool-tree.js";

import {
  Component,
  PanelButton,
  mountTemplate,
  ICONS,
  escapeHtml,
  timeAgo,
  confirmActionDialog,
  backendBounded,
  RUNTIME_SEND,
  parseJSONAttr,
} from "./components-core.js";

const ARIA_HIDDEN = "aria-hidden";
const TRUE = ""; // boolean-attribute present marker

export class FirstRunGuide extends Component {
  static get observedAttributes() {
    return ["storage-ready", "provider-ready", "browser-ready", "browser-choice", "headline", "body", "action-label", "dismiss-label"];
  }
  get _generic() { return !!String(this.getAttribute("action-label") ?? "").trim(); }
  _render() {
    const providerReady = this.hasAttribute("provider-ready");
    const generic = this._generic;
    const headline = escapeHtml(String(this.getAttribute("headline") ?? "").trim());
    const body = escapeHtml(String(this.getAttribute("body") ?? "").trim());
    const actionLabel = escapeHtml(String(this.getAttribute("action-label") ?? "").trim());
    const dismissLabel = escapeHtml(String(this.getAttribute("dismiss-label") ?? "").trim() || "Dismiss suggestion");
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
      button.primary, button.onboarding-cta { border:1px solid var(--accent,#0e6e63); background:var(--accent,#0e6e63); color:var(--btn-fg,#fff); }
      button:hover { filter:brightness(1.08); }
      button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .dismiss { width:36px; padding:0; display:inline-flex; align-items:center; justify-content:center;
        border-color:transparent; background:transparent; color:var(--muted,#635e56); }
      .dismiss:hover { filter:none; color:var(--text,#1d1b18); border-color:var(--border,#e3e0d9); }
      .dismiss svg { width:16px; height:16px; }
      @media (max-width:640px) { .banner { grid-template-columns:minmax(0,1fr) auto; }
        .banner > p { grid-column:1 / -1; } }
    `, !generic ? (providerReady ? "" : `<section class="banner onboarding-card" id="onboarding" aria-labelledby="first-run-title">
      <p id="first-run-title"><strong>No model connected yet.</strong> Tab tasks already work — connect a model for everything else.</p>
      <button class="primary connect-model" type="button">Connect a model</button>
      <button class="dismiss" type="button" aria-label="Dismiss first-run setup">${ICONS.close}</button>
    </section>`) : `<section class="banner" aria-labelledby="first-run-title">
      <p id="first-run-title">${headline ? `<strong>${headline}</strong> ` : ""}${body}</p>
      <button class="primary action" type="button">${actionLabel}</button>
      <button class="dismiss" type="button" aria-label="${dismissLabel}">${ICONS.close}</button>
    </section>`);
  }
  _wire() {
    const btn = this._root.querySelector(".connect-model");
    if (btn) {
      btn.id = "onboarding-settings";
      btn.classList.add("onboarding-cta");
    }
    btn?.addEventListener("click", (sourceEvent) =>
      this._emit("open-settings", { sourceEvent }));
    this._root.querySelector(".action")?.addEventListener("click", (sourceEvent) =>
      this._emit("action", { sourceEvent }));
    this._root.querySelector(".dismiss")?.addEventListener("click", (sourceEvent) =>
      this._emit("dismiss-guide", { sourceEvent }));
  }
  focusNextAction() {
    this._root.querySelector(".connect-model")?.focus();
    this._root.querySelector(".action")?.focus();
  }
}
customElements.define("first-run-guide", FirstRunGuide);

/* <example-chips label="Try one of these" chips="Group my tabs by topic|Summarise this page|Watch this price">
 * Three example tasks under the hub composer (CAP-FB-20260827-HUB-FIRST-RUN-01).
 * A click emits `pick` with the chip's text; the host puts it in the composer
 * and focuses it — a chip never runs anything. Chip text is static markup
 * authored here, but it is rendered with textContent all the same. */

export class ExampleChips extends Component {
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


export class SiteAgentCard extends Component {
  static get observedAttributes() { return ["origin", "tools", "tool-count", "status", "offer", "using", "check", "tab-id"]; }
  _toolCount() {
    const direct = Number(this.getAttribute("tool-count"));
    if (this.hasAttribute("tool-count") && Number.isFinite(direct)) return Math.max(0, Math.floor(direct));
    return parseJSONAttr(this.getAttribute("tools"), []).length;
  }
  _render() {
    const origin = this.getAttribute("origin") || "";
    const count = this._toolCount();
    const status = this.getAttribute("status") || "";
    const short = siteOfferHost(origin);
    const offer = this.hasAttribute("offer");
    const using = this.hasAttribute("using");
    const check = this.hasAttribute("check");
    const style = `
      :host { display:block; }
      :host([hidden]) { display:none; }
      .card { display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border,#e3e0d9); border-radius:10px; background:var(--panel,#ffffff); cursor:pointer; }
      .card:hover, .card:focus-visible { border-color:var(--accent,#0e6e63); outline:none; }
      .card[aria-busy="true"] { cursor:progress; opacity:.7; }
      :host([using]) .card { cursor:default; border-color:var(--accent,#0e6e63); }
      .badge { width:32px; height:32px; border-radius:8px; background:var(--accent,#0e6e63); color:var(--btn-fg,#fff); display:inline-flex; align-items:center; justify-content:center; font-weight:700; flex:none; }
      .who { flex:1; min-width:0; }
      .name { font-weight:600; }
      .tools { font-size:12px; color:var(--muted,#635e56); }
      .status { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); }
      .offer-text { font-weight:500; overflow-wrap:anywhere; }
      .offer-cta { font-size:12px; color:var(--accent,#0e6e63); font-weight:600; white-space:nowrap; }
    `;
    if (check) {
      mountTemplate(this, style, `<div class="card" role="button" tabindex="0" aria-label="${escapeHtml(SITE_AGENT_COPY.checkOpenPagesName)}">
        <span class="badge" aria-hidden="true">@</span>
        <span class="who"><span class="offer-text">${escapeHtml(SITE_AGENT_COPY.checkOpenPages)}</span></span>
        <span class="offer-cta" aria-hidden="true">Check</span>
      </div>`);
      return;
    }
    if (offer || using) {
      const label = using
        ? siteUsingLabel({ origin, toolCount: count })
        : siteOfferLabel({ origin, toolCount: count });
      const name = using
        ? `Using the ${count} ${count === 1 ? "tool" : "tools"} ${short} offers`
        : `Use the ${count} ${count === 1 ? "tool" : "tools"} ${short} offers — adds ${short} as a Site Agent`;
      mountTemplate(this, style, using
        ? `<div class="card" aria-label="${escapeHtml(name)}">
        <span class="badge" aria-hidden="true">@</span>
        <span class="who"><span class="offer-text">${escapeHtml(label)}</span></span>
      </div>`
        : `<div class="card" role="button" tabindex="0" aria-label="${escapeHtml(name)}">
        <span class="badge" aria-hidden="true">@</span>
        <span class="who"><span class="offer-text">${escapeHtml(label)}</span></span>
        <span class="offer-cta" aria-hidden="true">Use them</span>
      </div>`);
      return;
    }
    mountTemplate(this, style, `<div class="card" role="button" tabindex="0" aria-label="Use Site Agent ${escapeHtml(short)}">
      <span class="badge" aria-hidden="true">@</span>
      <span class="who"><span class="name">@${escapeHtml(short)}</span><span class="tools"> · ${count} tools</span></span>
      ${status ? `<span class="status">${escapeHtml(status)}</span>` : ""}
    </div>`);
  }
  _detail() {
    if (this.hasAttribute("check")) return { check: true };
    const tabId = Number(this.getAttribute("tab-id"));
    return {
      origin: this.getAttribute("origin"),
      ...(this.hasAttribute("tab-id") && Number.isInteger(tabId) ? { tabId } : {}),
    };
  }
  _wire() {
    if (this.hasAttribute("using")) return;
    const card = this._root.querySelector(".card");
    card?.addEventListener("click", () => this._emit("select", this._detail()));
    card?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this._emit("select", this._detail()); }
    });
  }
}
customElements.define("site-agent-card", SiteAgentCard);


export class HarnessAgentButton extends Component {
  static get observedAttributes() { return ["name", "current"]; }
  _render() {
    const name = this.getAttribute("name") || "Harness";
    mountTemplate(this, `
      :host { display:block; min-inline-size:0; }
      button { box-sizing:border-box; display:flex; align-items:center; gap:8px;
        inline-size:100%; min-block-size:44px; padding:8px; border:1px solid transparent;
        border-radius:var(--radius-sm,6px); background:transparent; color:var(--text,#1d1b18);
        font:inherit; font-size:13px; font-weight:500; text-align:start; cursor:pointer; }
      .mark { display:grid; place-items:center; flex:0 0 20px; color:var(--muted,#6e6a62); }
      .name { flex:1; min-inline-size:0; overflow-wrap:anywhere; }
      .open { flex:0 0 16px; color:var(--muted,#6e6a62); }
      button:hover { background:var(--panel-2,#efede8); }
      button:active { background:var(--border,#e3e0d9); }
      button[aria-current="true"] { background:var(--panel-2,#efede8); border-color:var(--accent,#0e6e63); font-weight:600; }
      button[aria-current="true"] .mark { color:var(--accent,#0e6e63); }
      button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:-2px; }
      @media (forced-colors:active) { button[aria-current="true"] { border-color:Highlight; } }
    `, `<button type="button" part="button" title="${escapeHtml(name)}" aria-label="${escapeHtml(`Open the ${name} harness conversation`)}"${this.hasAttribute("current") ? ' aria-current="true"' : ""}>
      <span class="mark" aria-hidden="true">${ICONS.terminal}</span>
      <span class="name" part="name">${escapeHtml(name)}</span>
      <svg class="open" part="open" aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
    </button>`);
  }
}
customElements.define("harness-agent-button", HarnessAgentButton);


export class NextRun extends Component {
  static get observedAttributes() { return ["at", "period", "last", "label"]; }
  _tick = null;
  _num(attr) {
    const v = Number(this.getAttribute(attr));
    return Number.isFinite(v) && this.getAttribute(attr) != null && this.getAttribute(attr) !== "" ? v : null;
  }
  _render() {
    const at = this._num("at");
    const period = this._num("period");
    const last = this._num("last");
    const fallback = this.getAttribute("label") || "";
    const next = nextRunLabel(at);
    const lastR = lastRunLabel(last);
    // The clock/alarm glyph — inline SVG, currentColor (no emoji icons).
    const clock = `<svg class="ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;
    const repeat = `<svg class="ic" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
    let body;
    if (next) {
      // The relative countdown is the emphasized part; the absolute time is the
      // quiet, exact confirmation beside it (title carries the full label for
      // hover + assistive tech).
      body = `<span class="line" title="${escapeHtml(next.label)}">${clock}<span class="rel${next.due ? " due" : ""}">${escapeHtml(next.relative === "due now" ? "Next run due now" : `Next run ${next.relative}`)}</span>${next.absolute ? `<span class="sep" aria-hidden="true">·</span><span class="abs">${escapeHtml(next.absolute)}</span>` : ""}${period ? `<span class="rep" title="Repeats every ${escapeHtml(String(period))} min">${repeat}</span>` : ""}</span>`;
    } else if (fallback) {
      body = `<span class="line muted" title="${escapeHtml(fallback)}">${clock}<span class="rel">${escapeHtml(fallback)}</span></span>`;
    } else {
      body = "";
    }
    const lastLine = lastR ? `<span class="line last" title="${escapeHtml(lastR.label)}">${escapeHtml(lastR.label)}</span>` : "";
    mountTemplate(this, `
      :host { display:block; }
      .line { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--muted,#635e56); max-width:100%; }
      .ic { flex:0 0 auto; opacity:.8; }
      .rel { color:var(--ink,#1d1b18); font-weight:600; white-space:nowrap; }
      .rel.due { color:var(--accent,#0e6e63); }
      .sep { color:var(--muted,#635e56); flex:0 0 auto; }
      .abs { color:var(--muted,#635e56); font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .rep { display:inline-flex; color:var(--accent,#0e6e63); }
      .line.muted .rel { color:var(--muted,#635e56); font-weight:500; }
      .last { display:block; margin-top:2px; font-size:var(--text-xs, 12px); color:var(--muted,#635e56); }
    `, `${body}${lastLine}`);
  }
  _wire() {
    // Re-compute the countdown as the fire approaches. A future alarm keeps the
    // relative label honest without a full page refresh; once it is due (or
    // there is no armed fire) the ticking stops until the attribute changes.
    this._stopTick();
    const at = this._num("at");
    if (at == null) return;
    const label = nextRunLabel(at);
    if (!label || label.due) return;
    this._tick = setInterval(() => {
      // Re-render only; a fresh nextRunLabel() reads the current time.
      this._render();
      // If the render just crossed into "due", _wire (called by _render's
      // re-entry path is NOT automatic here) — so re-arm/stop explicitly.
      const still = nextRunLabel(this._num("at"));
      if (!still || still.due) this._stopTick();
    }, NEXT_RUN_TICK_MS);
  }
  _stopTick() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
  }
  disconnectedCallback() {
    this._stopTick();
    super.disconnectedCallback();
  }
}
customElements.define("next-run", NextRun);


export class SecurityShield extends PanelButton {
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


export class DiagnosticsPanel extends PanelButton {
  get triggerIcon() { return ICONS.activity; }
  _panelMarkup() {
    return `
      <div class="phead">
        <span class="t">Diagnostics</span>
        <button type="button" data-refresh title="Refresh">Refresh</button>
        <button type="button" data-copy-all title="Copy summary">Copy summary</button>
        <button type="button" data-clear title="Clear errors">Clear errors</button>
        <button type="button" data-close aria-label="Close">${ICONS.close}</button>
      </div>
      <div class="pbody diag-body">
        <div class="diag-metrics">
          <div class="diag-card">
            <span class="diag-card-num" id="diag-metric-running">0</span>
            <span class="diag-card-label">Agents running</span>
          </div>
          <div class="diag-card">
            <span class="diag-card-num" id="diag-metric-completed">0</span>
            <span class="diag-card-label">Tasks completed</span>
          </div>
          <div class="diag-card">
            <span class="diag-card-num" id="diag-metric-errors">0</span>
            <span class="diag-card-label">Errors captured</span>
          </div>
          <div class="diag-card">
            <span class="diag-card-num" id="diag-metric-tools">0</span>
            <span class="diag-card-label">Tool calls</span>
          </div>
        </div>
        <div class="sect" id="diag-active-sect" hidden>
          <div class="sect-h">Active runs</div>
          <ul class="diag-active-list"></ul>
        </div>
        <div class="sect">
          <div class="sect-h">Tool usage</div>
          <div class="diag-tools-list"></div>
        </div>
        <div class="sect">
          <div class="sect-h">Errors & warnings</div>
          <div class="diag-errors-list"></div>
        </div>
      </div>`;
  }
  async _refreshPanel() {
    const body = this._panel.querySelector(".diag-body");
    if (!body) return;

    let runs = this._demoRuns ?? null;
    let entries = this._demoEntries ?? null;
    let tools = this._demoTools ?? null;
    let totals = this._demoTotals ?? null;

    if (!runs) {
      try {
        const res = await backendBounded("run.list", {}, 6000);
        if (Array.isArray(res?.runs)) runs = res.runs;
      } catch { runs = []; }
    }
    if (!entries) {
      try {
        const res = await backendBounded("diagnostics.list", {}, 6000);
        if (Array.isArray(res?.entries)) entries = res.entries;
      } catch { entries = []; }
    }
    if (!tools || !totals) {
      try {
        const res = await backendBounded("usage.get", {}, 6000);
        if (Array.isArray(res?.tools)) tools = res.tools;
        if (res?.totals) totals = res.totals;
      } catch { tools = tools || []; totals = totals || { calls: 0 }; }
    }

    runs = runs || [];
    entries = entries || [];
    tools = tools || [];
    totals = totals || { calls: 0 };

    this._entries = entries;
    this._runs = runs;
    this._tools = tools;
    this._totals = totals;

    const runningRuns = runs.filter((r) => ["running", "settling", "active"].includes(r.phase));
    const completedRuns = runs.filter((r) => ["completed", "done"].includes(r.phase));
    const errorCount = countDiagnosticsBadgeErrors(entries);
    const toolCallCount = tools.reduce((sum, t) => sum + (Number(t.calls) || 0), 0) || Number(totals.calls) || 0;

    const runningEl = this._panel.querySelector("#diag-metric-running");
    const completedEl = this._panel.querySelector("#diag-metric-completed");
    const errorsEl = this._panel.querySelector("#diag-metric-errors");
    const toolsEl = this._panel.querySelector("#diag-metric-tools");

    if (runningEl) {
      runningEl.textContent = String(runningRuns.length);
      runningEl.classList.toggle("has-running", runningRuns.length > 0);
    }
    if (completedEl) completedEl.textContent = String(completedRuns.length);
    if (errorsEl) {
      errorsEl.textContent = String(errorCount);
      errorsEl.classList.toggle("has-error", errorCount > 0);
    }
    if (toolsEl) toolsEl.textContent = String(toolCallCount);

    this.setAttribute("count", String(errorCount));
    if (errorCount > 0) this.setAttribute("attention", "true");
    else this.removeAttribute("attention");

    const activeSect = this._panel.querySelector("#diag-active-sect");
    const activeList = this._panel.querySelector(".diag-active-list");
    if (activeSect && activeList) {
      if (runningRuns.length > 0) {
        activeSect.hidden = false;
        activeList.innerHTML = runningRuns.slice(0, 5).map((r) => `
          <li class="diag-active-item">
            <span class="diag-active-badge">${escapeHtml(r.kind || "run")}</span>
            <span class="diag-active-preview">${escapeHtml(r.taskPreview || r.executionId || "active task")}</span>
          </li>
        `).join("");
      } else {
        activeSect.hidden = true;
        activeList.innerHTML = "";
      }
    }

    const toolsList = this._panel.querySelector(".diag-tools-list");
    if (toolsList) {
      if (tools.length > 0) {
        toolsList.innerHTML = tools.slice(0, 10).map((t) => `
          <span class="diag-tool-chip">${escapeHtml(t.tool || "tool")}<span class="count">${escapeHtml(String(t.calls || 0))}</span></span>
        `).join("");
      } else {
        toolsList.innerHTML = `<div class="empty">No tool calls recorded yet.</div>`;
      }
    }

    const errorsList = this._panel.querySelector(".diag-errors-list");
    if (errorsList) {
      if (entries.length > 0) {
        errorsList.innerHTML = entries.slice(0, 10).map((e) => {
          const isExcluded = isExcludedDiagnosticBadgeEntry(e);
          const displayLevel = isExcluded ? "info" : (e.level || "info");
          return `
          <div class="diag-error-row lvl-${escapeHtml(displayLevel)}">
            <span class="diag-error-time">${escapeHtml(fmtTime(e.ts))}</span>
            <span class="diag-error-level">${escapeHtml(displayLevel)}</span>
            <span class="diag-error-msg">${escapeHtml(e.message || "")}</span>
          </div>
        `;
        }).join("");
      } else {
        errorsList.innerHTML = `<div class="empty">No errors or warnings captured.</div>`;
      }
    }
  }

  async _clear() {
    await backend("diagnostics.clear");
    this._entries = [];
    this._demoEntries = [];
    await this._refreshPanel();
    this._emit("cleared");
  }

  async _copyAll() {
    const running = this._runs ? this._runs.filter((r) => ["running", "settling", "active"].includes(r.phase)).length : 0;
    const completed = this._runs ? this._runs.filter((r) => ["completed", "done"].includes(r.phase)).length : 0;
    const errors = countDiagnosticsBadgeErrors(this._entries);
    const toolCalls = this._tools ? this._tools.reduce((sum, t) => sum + (Number(t.calls) || 0), 0) : (this._totals?.calls ?? 0);

    const lines = [
      "Chrome Agent Platform — Diagnostics Summary",
      `Agents running: ${running}`,
      `Tasks completed: ${completed}`,
      `Errors captured: ${errors}`,
      `Tool calls: ${toolCalls}`,
    ];

    if (this._tools && this._tools.length > 0) {
      lines.push("", "Top Tools:");
      for (const t of this._tools.slice(0, 10)) {
        lines.push(`  - ${t.tool}: ${t.calls} calls`);
      }
    }

    if (this._entries && this._entries.length > 0) {
      lines.push("", "Recent Errors:");
      for (const e of this._entries.slice(0, 10)) {
        lines.push(`  [${fmtTime(e.ts)}] ${e.level}${e.source ? ` (${e.source})` : ""}: ${e.message}`);
      }
    }

    const text = lines.join("\n");
    const btn = this._panel?.querySelector("[data-copy-all]");
    if (await this._writeClipboard(text)) {
      if (btn) { btn.textContent = "Copied"; setTimeout(() => { btn.textContent = "Copy summary"; }, 1400); }
    }
  }

  async refresh() {
    return await this._refreshPanel();
  }

  set demoData(data) {
    if (data?.runs !== undefined) this._demoRuns = data.runs;
    if (data?.entries !== undefined) this._demoEntries = data.entries;
    if (data?.tools !== undefined) this._demoTools = data.tools;
    if (data?.totals !== undefined) this._demoTotals = data.totals;
    this._refreshPanel();
  }
}
customElements.define("diagnostics-panel", DiagnosticsPanel);
/* vocab:advanced:end */

/* ──────────────────────────────────────────────────────────────────────────
 * <activity-explorer agent? limit?> — the browsable/searchable activity log
 * (the agent run log ACROSS the system: master + named + background + site
 * agents). Queries activity.list; each row shows the agent (which agent did
 * it), the entry type, the readable text, and the time. Search box + an agent
 * filter; a per-agent view when the `agent` attribute is set. The gallery can
 * seed it with demo entries (no extension backend) via the `entries` property.
 * ────────────────────────────────────────────────────────────────────────── */

// timeAgo is imported from lib/pure.js (single source; the hub uses the same one).

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
    more.textContent = `show more (${(text.length - AEX_PLAIN_DETAIL_INLINE).toLocaleString()} more characters)`;
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

export class ActivityExplorer extends Component {
  static get observedAttributes() {
    return ["agent", "limit"];
  }
  _render() {
    mountTemplate(this, `
        :host { display:block; }
        .aex { display:flex; flex-direction:column; gap:8px; }
        .aex-toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
        .aex-search { flex:1; min-width:140px; padding:8px 12px; font:inherit; font-size:13px;
          color:var(--text,#1d1b18); background:var(--bg,#f7f6f3); border:1px solid var(--border,#e3e0d9);
          border-radius:var(--radius-sm,8px); }
        .aex-search:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
        select.aex-agent { max-width:200px; padding:8px 10px; font:inherit; font-size:13px;
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
        span.aex-agent { font-size:var(--text-xs, 12px); font-weight:600; color:var(--accent,#0e6e63); white-space:nowrap;
          max-width:150px; overflow:hidden; text-overflow:ellipsis; background:transparent; border:0; padding:0; }
        .aex-main { min-width:0; min-inline-size:0; }
        .aex-kind { font-size:12px; font-weight:600;
          color:var(--muted,#635e56); margin-right:6px; white-space:nowrap; }
        .aex-kind.task, .aex-kind.started { color:var(--accent,#0e6e63); }
        .aex-kind.finished { color:var(--accent,#0e6e63); }
        .aex-kind.failed, .aex-kind.error { color:var(--danger,#b3261e); }
        .aex-kind.tool-call, .aex-kind.tool-result { color:var(--accent2,#7a5c1d); }
        .aex-text { font-size:13px; line-height:1.45; color:var(--text,#1d1b18); min-inline-size:0;
          overflow-wrap:anywhere; }
        .aex-ts { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); white-space:nowrap; }
        .aex-detail { margin:0; padding:0 12px 10px 12px; font-size:12px; line-height:1.5;
          color:var(--muted,#635e56); white-space:pre-wrap; overflow-wrap:anywhere;
          font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
        .aex-empty { padding:12px 10px; font-size:13px; color:var(--muted,#635e56); }
        .aex-retry { margin-left:8px; padding:3px 10px; font:inherit; font-size:12px; cursor:pointer;
          color:var(--accent,#0e6e63); background:var(--bg,#f7f6f3); border:1px solid var(--border,#e3e0d9);
          border-radius:var(--radius-sm,8px); }
        .aex-count { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); }
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
        .aex-blocks .tt-block-controls { margin-inline-start:auto; display:inline-flex; gap:4px; }
        .aex-blocks .tt-block-controls button { font:inherit; font-size:var(--text-xs, 12px); line-height:1; display:inline-flex; align-items:center; gap:4px;
          padding:3px 7px; border:1px solid var(--border,#e3e0d9); border-radius:999px;
          background:var(--panel,#ffffff); color:var(--muted,#635e56); cursor:pointer; }
        .aex-blocks .tt-block-controls button:hover { border-color:var(--accent,#0e6e63); color:var(--ink,#1d1b18); }
        .aex-blocks .tt-block-controls button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
        .aex-blocks .tt-block-controls button.on { background:var(--accent,#0e6e63); border-color:transparent; color:var(--btn-fg,#ffffff); }
        .aex-blocks .tt-btn-ic { display:inline-flex; flex:0 0 auto; }
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
        .aex-blocks .tt-raw { margin:0; padding:10px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
          font-size:var(--text-xs, 12px); line-height:1.45; color:var(--ink,#1d1b18); background:var(--panel-2,#efede8);
          white-space:pre-wrap; word-break:break-word; overflow:auto; max-height:360px; tab-size:2; }
        .aex-blocks .tt-raw .tt-json-key { color:var(--accent,#0e6e63); font-weight:600; }
        .aex-blocks .tt-raw .tt-json-string { color:var(--ink,#1d1b18); }
        .aex-blocks .tt-raw .tt-json-number, .aex-blocks .tt-raw .tt-json-boolean { color:var(--accent,#0e6e63); }
        .aex-blocks .tt-raw .tt-json-null { color:var(--muted,#635e56); font-style:italic; }
        .aex-blocks .tt-raw .tt-json-punct { color:var(--muted,#635e56); }
        .aex-blocks .tt-raw::selection, .aex-blocks .tt-raw *::selection { background:var(--accent,#0e6e63); color:var(--btn-fg,#ffffff); }
        .aex-blocks .tt-key { color:var(--accent,#0e6e63); font-weight:600; white-space:nowrap; }
        .aex-blocks .tt-val { color:var(--ink,#1d1b18); overflow-wrap:anywhere; min-width:0; }
        .aex-blocks .tt-val-number, .aex-blocks .tt-val-boolean { color:var(--accent,#0e6e63); }
        .aex-blocks .tt-val-null { color:var(--muted,#635e56); font-style:italic; }
        .aex-blocks .tt-kind { color:var(--muted,#635e56); font-size:var(--text-xs, 12px); margin-left:2px; }
        .aex-blocks .tt-copy { margin-left:auto; flex:0 0 auto; font:inherit; font-size:var(--text-xs, 12px); color:var(--muted,#635e56); background:transparent; border:1px solid var(--border,#e3e0d9); border-radius:5px; padding:1px 7px; cursor:pointer; opacity:0; transition:opacity .12s ease; }
        .aex-blocks .tt-row:hover .tt-copy, .aex-blocks .tt-copy:focus-visible { opacity:1; }
        .aex-blocks .tt-copy:hover { color:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); }
        .aex-plain { border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,8px); }
        .aex-plain-head { display:flex; align-items:baseline; gap:8px; padding:6px 10px 0; }
        .aex-plain-label { font-size:12px; font-weight:600; color:var(--ink,#1d1b18); }
        .aex-plain-copy, .aex-plain-more { margin-left:auto; font:inherit; font-size:var(--text-xs, 12px); color:var(--muted,#635e56);
          background:transparent; border:1px solid var(--border,#e3e0d9); border-radius:5px; padding:1px 7px; cursor:pointer;
          /* CAP-FB-20260830-FOCUS-ORDER-VISIBILITY-01: 39x21 was under the 24px
             minimum target — keep the compact look, grow the hit box. */
          min-block-size:24px; min-inline-size:24px; display:inline-flex; align-items:center; justify-content:center; box-sizing:border-box; }
        .aex-plain-copy:hover, .aex-plain-more:hover { color:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); }
        .aex-plain-copy:focus-visible, .aex-plain-more:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:0; }
        .aex-plain .aex-detail { padding:4px 10px 8px; }
        @media (prefers-reduced-motion: reduce) { .aex-blocks .tt-toggle .tt-caret { transition:none; } .aex-blocks .tt-copy { transition:none; } }
    `, `
      <div class="aex">
        <div class="aex-toolbar">
          <input class="aex-search" type="search" placeholder="Search activity…" aria-label="Search activity">
          <select class="aex-agent" aria-label="Filter by agent"><option value="">All agents</option></select>
        </div>
        <div class="aex-list" role="log" aria-live="polite"></div>
      </div>`);
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
      case "tool-call": addBlock("inputs", redactToolArgs(e.tool ?? "", e.args)); break;
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


export class ActionLedger extends Component {
  static get observedAttributes() {
    return ["limit"];
  }
  _render() {
    mountTemplate(this, `
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
        .al-meta { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); display:flex; gap:8px; align-items:baseline; }
        .al-ts { white-space:nowrap; }
        .al-note { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); white-space:nowrap; font-style:italic; }
        .al-undo { display:inline-flex; align-items:center; gap:5px; padding:4px 10px; font:inherit; font-size:12px;
          cursor:pointer; color:var(--accent,#0e6e63); background:transparent; min-height:32px;
          border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,8px);
          transition:border-color .15s ease, color .15s ease, background .15s ease; white-space:nowrap; }
        .al-undo:hover { border-color:var(--accent,#0e6e63); background:var(--panel-2,#efede8); }
        .al-undo:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
        .al-undo:disabled { cursor:default; color:var(--muted,#635e56); opacity:.7; }
        .al-undo svg { width:13px; height:13px; flex:0 0 auto; }
        .al-done { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); white-space:nowrap; }
        .al-empty { padding:12px 2px; font-size:13px; color:var(--muted,#635e56); }
        .al-error { padding:12px 2px; font-size:13px; color:var(--danger,#b3261e); display:flex; gap:8px; align-items:baseline; }
        .al-retry { padding:3px 10px; font:inherit; font-size:12px; cursor:pointer; color:var(--accent,#0e6e63); min-height:32px;
          background:transparent; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,8px); }
        @media (prefers-reduced-motion: reduce) { .al-undo { transition:none; } }
    `, `
      <div class="al" role="list" aria-label="Recent actions"></div>
    `);
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


const TIMELINE_STATUS_WORD = {
  running: "Running",
  paused: "Waiting",
  failed: "Failed",
  done: "Done",
};
function renderTimelineRow(e) {
  const status = ["running", "paused", "failed", "done"].includes(e.status) ? e.status : "idle";
  const word = TIMELINE_STATUS_WORD[status] || "";
  const agent = e.agent ? `<span class="tl-agent">${escapeHtml(e.agent)}</span>` : "";
  const outcome = e.outcome ? `<span class="tl-outcome">${escapeHtml(e.outcome)}</span>` : "";
  const sep = agent && outcome ? `<span class="tl-sep" aria-hidden="true">·</span>` : "";
  const t = Number(e.time) || 0;
  const iso = t ? new Date(t).toISOString() : "";
  const full = t ? new Date(t).toLocaleString() : "";
  const visibleOutcome = e.outcome || (agent ? "" : word);
  const alreadyHasWord = word && visibleOutcome.toLowerCase().includes(word.toLowerCase());
  const srWord = (!alreadyHasWord && word) ? `<span class="tl-sr">${escapeHtml(word)}</span>` : "";
  return `<li class="tl-item">
    <button type="button" class="tl-row" data-id="${escapeHtml(String(e.id ?? ""))}" aria-label="Open ${escapeHtml(String(e.title ?? "item"))}">
      <span class="tl-dot ${status}" aria-hidden="true"></span>
      <span class="tl-body">
        <span class="tl-title">${escapeHtml(String(e.title ?? "Task"))}</span>
        <span class="tl-meta">${agent}${sep}${outcome || (agent ? "" : `<span class="tl-outcome">${escapeHtml(word)}</span>`)}${srWord}</span>
      </span>
      <time class="tl-time" datetime="${escapeHtml(iso)}" title="${escapeHtml(full)}">${escapeHtml(timeAgo(t))}</time>
      <span class="tl-chev" aria-hidden="true">${ICONS.chevron}</span>
    </button>
  </li>`;
}

export class AgentTimeline extends Component {
  static get observedAttributes() {
    return ["limit", "filter", "page", "page-size", "query", "group-by"];
  }
  constructor() {
    super();
    this._entries = [];
    this._filter = "All";
    this._page = 1;
    this._pageSize = 10;
    this._query = "";
    this._groupBy = "none";
  }
  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (name === "filter") {
      this._filter = newVal || "All";
      this._page = 1;
    } else if (name === "query") {
      this._query = newVal || "";
      this._page = 1;
    } else if (name === "page") {
      const n = Number.parseInt(newVal, 10);
      this._page = Number.isFinite(n) && n >= 1 ? n : 1;
    } else if (name === "page-size") {
      const n = Number.parseInt(newVal, 10);
      this._pageSize = Number.isFinite(n) && n >= 1 ? n : 10;
    } else if (name === "group-by") {
      this._groupBy = newVal || "none";
    }
    if (this._rendered) {
      this._render();
      this._wire();
    }
  }
  set entries(value) {
    this._entries = Array.isArray(value) ? value : [];
    if (this._rendered) { this._render(); this._wire(); }
    this._emit("entries-change", { count: this._entries.length });
  }
  get entries() { return this._entries; }
  set filter(val) {
    const next = String(val || "All").trim();
    if (this._filter === next) return;
    this._filter = next;
    this._page = 1;
    if (this._rendered) { this._render(); this._wire(); }
  }
  get filter() {
    return this.getAttribute("filter") || this._filter || "All";
  }
  set query(val) {
    const next = String(val ?? "").trim();
    if (this._query === next) return;
    this._query = next;
    this._page = 1;
    if (this._rendered) { this._render(); this._wire(); }
  }
  get query() {
    return this.getAttribute("query") ?? this._query ?? "";
  }
  set groupBy(val) {
    const next = String(val ?? "none").trim().toLowerCase();
    if (this._groupBy === next) return;
    this._groupBy = next;
    if (this._rendered) { this._render(); this._wire(); }
  }
  get groupBy() {
    return this.getAttribute("group-by") ?? this._groupBy ?? "none";
  }
  set page(val) {
    const n = Number.parseInt(String(val), 10);
    const next = Number.isFinite(n) && n >= 1 ? n : 1;
    if (this._page === next) return;
    this._page = next;
    if (this._rendered) { this._render(); this._wire(); }
  }
  get page() {
    const attr = Number.parseInt(this.getAttribute("page") ?? "", 10);
    if (Number.isFinite(attr) && attr >= 1) return attr;
    return this._page || 1;
  }
  set pageSize(val) {
    const n = Number.parseInt(String(val), 10);
    const next = Number.isFinite(n) && n >= 1 ? n : 10;
    if (this._pageSize === next) return;
    this._pageSize = next;
    if (this._rendered) { this._render(); this._wire(); }
  }
  get pageSize() {
    const attr = Number.parseInt(this.getAttribute("page-size") ?? "", 10);
    if (Number.isFinite(attr) && attr >= 1) return attr;
    return this._pageSize || 10;
  }
  _limit() {
    const n = Number.parseInt(this.getAttribute("limit") ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : 200;
  }
  _render() {
    const bounded = this._entries.slice(0, this._limit());
    const filter = this.filter;
    const query = this.query;
    const filtered = filterTimeline(bounded, filter, { query });
    const totalCount = filtered.length;
    const pageSize = Math.max(1, this.pageSize);
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    let currentPage = Math.min(Math.max(1, this.page), totalPages);
    this._page = currentPage;

    let body = "";
    let paginationHtml = "";

    if (totalCount === 0) {
      let emptyText = "Nothing yet. Your tasks and your agents’ runs will appear here.";
      if (bounded.length > 0) {
        if (query) {
          emptyText = `No timeline items matching "${query}".`;
        } else {
          const f = filter.toLowerCase();
          if (f === "waiting") {
            emptyText = "Nothing waiting on you.";
          } else if (f === "running") {
            emptyText = "No running tasks.";
          } else if (f === "completed") {
            emptyText = "No completed tasks.";
          } else if (f === "failed") {
            emptyText = "No failed tasks.";
          } else if (f === "scheduled") {
            emptyText = "No scheduled runs yet.";
          } else if (f === "runs") {
            emptyText = "No runs yet.";
          } else if (f === "made") {
            emptyText = "Nothing made yet.";
          } else {
            emptyText = "No matching tasks.";
          }
        }
      }
      body = `<p class="tl-empty">${escapeHtml(emptyText)}</p>`;
    } else if (this.groupBy === "topic") {
      const groups = groupTimelineByTopic(filtered);
      const groupsHtml = groups.map((g) => {
        const items = g.entries.map(renderTimelineRow).join("");
        return `<details class="tl-topic-group" open>
          <summary class="tl-topic-head">
            <span class="tl-topic-name">${escapeHtml(g.topic)}</span>
            <span class="tl-topic-count">${g.count}</span>
          </summary>
          <ol class="tl" role="list">${items}</ol>
        </details>`;
      }).join("");
      body = `<div class="tl-groups">${groupsHtml}</div>`;
    } else {
      const startIdx = (currentPage - 1) * pageSize;
      const endIdx = Math.min(startIdx + pageSize, totalCount);
      const pageRows = filtered.slice(startIdx, endIdx);
      const items = pageRows.map(renderTimelineRow).join("");
      body = `<ol class="tl" role="list">${items}</ol>`;

      if (totalCount > pageSize) {
        const startNum = startIdx + 1;
        const endNum = endIdx;
        const rangeText = `${startNum}–${endNum} of ${totalCount}`;
        const pageText = `Page ${currentPage} of ${totalPages}`;
        const prevDisabled = currentPage <= 1 ? " disabled" : "";
        const nextDisabled = currentPage >= totalPages ? " disabled" : "";
        paginationHtml = `
          <nav class="tl-pagination" aria-label="Timeline pagination">
            <span class="tl-page-range">${rangeText}</span>
            <div class="tl-page-actions">
              <button type="button" class="tl-page-btn" data-page="prev"${prevDisabled} aria-label="Previous page">Previous</button>
              <span class="tl-page-num">${pageText}</span>
              <button type="button" class="tl-page-btn" data-page="next"${nextDisabled} aria-label="Next page">Next</button>
            </div>
          </nav>`;
      }
    }

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
      .tl-groups { display:flex; flex-direction:column; }
      .tl-topic-group { border-bottom:1px solid var(--border,#e3e0d9); }
      .tl-topic-group:last-child { border-bottom:0; }
      .tl-topic-head { display:flex; align-items:center; justify-content:space-between; padding:8px 14px;
        background:var(--panel-2,#efede8); font-size:12px; font-weight:600; color:var(--muted,#635e56);
        cursor:pointer; list-style:none; user-select:none; }
      .tl-topic-head::-webkit-details-marker { display:none; }
      .tl-topic-name { font-weight:600; }
      .tl-topic-count { background:var(--panel,#fff); border:1px solid var(--border,#e3e0d9);
        border-radius:10px; padding:0 6px; font-size:var(--text-xs, 12px); font-weight:600; min-inline-size:18px; text-align:center; }
      .tl-pagination { display:flex; align-items:center; justify-content:space-between; padding:10px 14px;
        border-top:1px solid var(--border,#e3e0d9); font-size:12px; color:var(--muted,#635e56); }
      .tl-page-actions { display:flex; align-items:center; gap:8px; }
      .tl-page-btn { appearance:none; border:1px solid var(--border,#e3e0d9); background:var(--panel-2,#efede8);
        color:var(--text,#1d1b18); font:inherit; font-size:12px; font-weight:550; padding:4px 10px;
        border-radius:6px; cursor:pointer; }
      .tl-page-btn:hover:not(:disabled) { background:var(--bg,#f7f6f3); color:var(--accent,#0e6e63); }
      .tl-page-btn:disabled { opacity:0.4; cursor:not-allowed; }
      .tl-page-range, .tl-page-num { font-variant-numeric:tabular-nums; }
    `, `${body}${paginationHtml}`);
  }
  _wire() {
    for (const row of this._root?.querySelectorAll?.(".tl-row") ?? []) {
      row.addEventListener?.("click", () => this._emit("open", { id: row.dataset?.id }));
    }
    const prevBtn = this._root?.querySelector?.('[data-page="prev"]');
    if (prevBtn) {
      prevBtn.addEventListener?.("click", () => {
        if (this.page > 1) {
          this.page = this.page - 1;
          this._emit("page-change", { page: this.page });
        }
      });
    }
    const nextBtn = this._root?.querySelector?.('[data-page="next"]');
    if (nextBtn) {
      nextBtn.addEventListener?.("click", () => {
        this.page = this.page + 1;
        this._emit("page-change", { page: this.page });
      });
    }
  }
}
customElements.define("agent-timeline", AgentTimeline);


export class JobsBoard extends Component {
  _render() {
    mountTemplate(this, `
        :host { display:block; }
        .jb { display:flex; flex-direction:column; gap:14px; }
        /* Empty group containers collapse so the flex gap never stacks up as
           blank space (a fresh board is just the empty line, no dead air). */
        .jb-open:empty, .jb-claimed:empty, .jb-blocked:empty, .jb-settled:empty, .jb-msgs:empty { display:none; }
        .jb-group { display:flex; flex-direction:column; }
        .jb-head { font-size:12px; font-weight:600;
          color:var(--muted,#635e56); padding:0 2px 5px; display:flex; align-items:baseline; gap:6px; }
        .jb-head .jb-n { font-weight:600; color:var(--muted,#635e56); }
        .jb-row { display:flex; flex-direction:column; gap:3px; padding:8px 0;
          border-bottom:1px solid var(--border,#e3e0d9); }
        .jb-row:last-child { border-bottom:0; }
        .jb-desc { font-size:13px; line-height:1.4; color:var(--text,#1d1b18);
          overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
          overflow-wrap:anywhere; }
        .jb-meta { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); display:flex; gap:6px 8px; align-items:baseline;
          flex-wrap:wrap; }
        /* The status word is a text badge — never colour alone. A left border in
           the tone accent carries the state with a sentence-case label. */
        .jb-badge { font-size:12px; font-weight:600;
          padding:1px 6px; border-radius:999px; border:1px solid var(--border,#e3e0d9);
          color:var(--muted,#635e56); background:var(--panel-2); flex:0 0 auto;
          display:inline-flex; align-items:center; gap:5px; }
        .jb-badge::before { content:""; width:6px; height:6px; border-radius:50%;
          background:var(--muted,#635e56); flex:0 0 auto; }
        .jb-badge.open::before { background:var(--accent,#0e6e63); }
        .jb-badge.claimed::before { background:var(--accent2,#7a5c1d); }
        .jb-badge.blocked::before { background:var(--danger,#b3261e); }
        .jb-badge.done::before { background:var(--accent,#0e6e63); }
        .jb-badge.fail::before { background:var(--danger,#b3261e); }
        /* One unbroken line by design, but bounded so it cannot hold the board's column
           open or overflow the row now that the column is allowed to be narrow. */
        .jb-party { white-space:nowrap; min-width:0; overflow:hidden; text-overflow:ellipsis; }
        .jb-outcome { font-size:12px; font-weight:600; }
        .jb-outcome.completed { color:var(--accent,#0e6e63); }
        .jb-outcome.failed { color:var(--danger,#b3261e); }
        /* Settled row is a real button that expands its result in place. The
           wrapper drops its own padding/border so the button carries them. */
        .jb-row--settled { padding:0; border-bottom:0; }
        .jb-settled-btn { display:flex; flex-direction:column; gap:3px; width:100%; text-align:left;
          font:inherit; color:inherit; background:transparent; border:0; padding:8px 0; cursor:pointer;
          border-bottom:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,6px); }
        .jb-row--settled:last-child .jb-settled-btn { border-bottom:0; }
        .jb-settled-btn:hover { background:var(--hover,rgba(0,0,0,.04)); }
        .jb-settled-btn:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
        .jb-settled-btn[disabled] { cursor:default; opacity:.85; }
        .jb-excerpt { font-size:12px; color:var(--muted,#635e56); overflow:hidden;
          text-overflow:ellipsis; white-space:nowrap; min-width:0; max-width:100%; }
        .jb-full { font-size:12.5px; line-height:1.5; color:var(--text,#1d1b18); white-space:pre-wrap;
          word-break:break-word; margin:4px 0 2px; max-height:40vh; overflow:auto;
          background:var(--panel-2); border-radius:var(--radius-sm,6px); padding:8px 10px; }
        .jb-caret { font-size:var(--text-xs, 12px); color:var(--muted,#635e56); }
        .jb-msg { font-size:12.5px; line-height:1.45; color:var(--text,#1d1b18); overflow:hidden;
          display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow-wrap:anywhere; }
        .jb-empty { font-size:13px; color:var(--muted,#635e56); padding:6px 0; line-height:1.5; }
    `, `
      <div class="jb">
        <div class="jb-open" role="list" aria-label="Open jobs" aria-live="polite"></div>
        <div class="jb-claimed" role="list" aria-label="Claimed jobs"></div>
        <div class="jb-blocked" role="list" aria-label="Blocked jobs"></div>
        <div class="jb-settled" role="list" aria-label="Recently settled jobs"></div>
        <div class="jb-msgs" role="list" aria-label="Board messages"></div>
        <div class="jb-empty" hidden></div>
      </div>`);
  }
  _wire() {
    this._openEl = this._root.querySelector(".jb-open");
    this._claimedEl = this._root.querySelector(".jb-claimed");
    this._blockedEl = this._root.querySelector(".jb-blocked");
    this._settledEl = this._root.querySelector(".jb-settled");
    this._msgsEl = this._root.querySelector(".jb-msgs");
    this._emptyEl = this._root.querySelector(".jb-empty");
    if (!this._seeded) this.refresh();
    else this._paint();
  }
  // Gallery/demo seeding (the showcase has no extension backend).
  set jobs(v) { this._jobs = Array.isArray(v) ? v : []; this._seeded = true; if (this._rendered) this._paint(); }
  set messages(v) { this._messages = Array.isArray(v) ? v : []; this._seeded = true; if (this._rendered) this._paint(); }
  /** "N open" for the panel-head hint — every UNSETTLED job the owner is
   *  waiting on (open + claimed + blocked). Empty string when nothing is open. */
  get summary() {
    const active = projectBoard(this._jobs ?? []).counts.active;
    return active > 0 ? `${active} open` : "";
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
      jobs.map((j) => [j?.id, j?.status, j?.claimantId, j?.blocked, j?.blockedByOpen, j?.settledAt]),
      messages.map((m) => m?.id),
    ]);
    if (signature === this._lastSignature) return;
    this._lastSignature = signature;

    // ONE projection authority (extension/lib/board-view-model.js): open /
    // claimed / blocked / settled, so the owner sees the state of every job.
    const vm = projectBoard(jobs);
    const open = vm.open.slice(0, 10);
    const claimed = vm.claimed.slice(0, 10);
    const blocked = vm.blocked.slice(0, 10);
    const settled = vm.settled.slice(0, 5);

    this._openEl.replaceChildren();
    this._claimedEl.replaceChildren();
    this._blockedEl.replaceChildren();
    this._settledEl.replaceChildren();
    this._msgsEl.replaceChildren();

    this._group(this._openEl, "Open", open, (j) => this._jobRow(j));
    this._group(this._claimedEl, "Claimed", claimed, (j) => this._jobRow(j));
    this._group(this._blockedEl, "Blocked", blocked, (j) => this._jobRow(j));
    this._group(this._settledEl, "Settled", settled, (j) => this._settledRow(j));
    this._group(this._msgsEl, "Messages", messages.slice(0, 5), (m) => this._messageRow(m));

    const isEmpty = !open.length && !claimed.length && !blocked.length && !settled.length && !messages.length;
    this._emptyEl.hidden = !isEmpty;
    if (typeof this.toggleAttribute === "function") this.toggleAttribute("data-empty", isEmpty); else if (isEmpty) this.setAttribute("data-empty", ""); else this.removeAttribute("data-empty");
    if (this.parentElement) this.parentElement.setAttribute("data-empty", String(isEmpty));
    const sec = typeof this.closest === "function" ? this.closest("section") : null;
    if (sec) sec.setAttribute("data-empty", String(isEmpty));
    if (isEmpty) {
      // An unreadable board is an HONEST error, never a false "empty".
      this._emptyEl.textContent = this._loadError
        ? `The board could not be read (${this._loadError}) — try reloading the page.`
        : "No shared jobs yet — agents post work here for each other.";
    }
  }
  // A titled group with a count in its head; skipped entirely when empty.
  _group(container, title, items, build) {
    if (!items.length) return;
    const head = document.createElement("div");
    head.className = "jb-head";
    const label = document.createElement("span");
    label.textContent = title;
    const n = document.createElement("span");
    n.className = "jb-n";
    n.textContent = String(items.length);
    head.append(label, n);
    container.append(head);
    for (const item of items) container.append(build(item));
  }
  // An ACTIVE job row (open / claimed / blocked): description, the status WORD
  // as a text badge (colour is never the only signal), the poster, and the
  // claimant (or "unclaimed"). A blocked row also says what it waits on.
  _jobRow(job) {
    const row = document.createElement("div");
    row.className = "jb-row";
    row.setAttribute("role", "listitem");
    const desc = document.createElement("span");
    desc.className = "jb-desc";
    desc.textContent = job.description ?? "";
    const meta = document.createElement("span");
    meta.className = "jb-meta";
    const { key, label } = statusOf(job);
    const { poster, claimant, unclaimed } = partiesOf(job);
    const badge = document.createElement("span");
    badge.className = `jb-badge ${key}`;
    badge.textContent = label;
    const who = document.createElement("span");
    who.className = "jb-party";
    who.textContent = unclaimed
      ? `posted by ${poster} · unclaimed`
      : `${claimant} is on it · posted by ${poster}`;
    meta.append(badge, who);
    if (key === "blocked") {
      const blk = document.createElement("span");
      blk.className = "jb-party";
      const n = Number(job.blockedByOpen ?? job.blockedBy?.length ?? 1);
      blk.textContent = `waiting on ${n} job${n === 1 ? "" : "s"}`;
      meta.append(blk);
    }
    const when = document.createElement("span");
    when.className = "jb-party";
    when.textContent = key === "claimed" && job.claimedAt ? timeAgo(job.claimedAt) : timeAgo(job.createdAt);
    meta.append(when);
    if (job.targetName) {
      const tgt = document.createElement("span");
      tgt.className = "jb-party";
      tgt.textContent = `for ${job.targetName}`;
      meta.append(tgt);
    }
    row.append(desc, meta);
    row.title = desc.textContent;
    return row;
  }
  // A SETTLED job row: a real button that expands the full result in place
  // (openable without leaving the board), plus the outcome word + claimant.
  _settledRow(job) {
    const row = document.createElement("div");
    row.className = "jb-row jb-row--settled";
    row.setAttribute("role", "listitem");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "jb-settled-btn";
    const result = typeof job.result === "string" ? job.result.trim() : "";
    const hasResult = result.length > 0;
    const desc = document.createElement("span");
    desc.className = "jb-desc";
    desc.textContent = job.description ?? "";
    const meta = document.createElement("span");
    meta.className = "jb-meta";
    const outcome = document.createElement("span");
    outcome.className = `jb-outcome ${job.status === "failed" ? "failed" : "completed"}`;
    outcome.textContent = job.status === "failed" ? "Failed" : "Completed";
    const who = document.createElement("span");
    who.className = "jb-party";
    who.textContent = `by ${job.claimantName ?? job.claimantId ?? "an agent"} · ${timeAgo(job.settledAt)}`;
    meta.append(outcome, who);
    if (hasResult) {
      const caret = document.createElement("span");
      caret.className = "jb-caret";
      caret.textContent = "▸";
      meta.append(caret);
    }
    // Collapsed one-line excerpt; expands to the full result on click.
    const excerpt = document.createElement("span");
    excerpt.className = "jb-excerpt";
    excerpt.textContent = hasResult ? _short(result, 120) : "No result recorded.";
    const full = document.createElement("pre");
    full.className = "jb-full";
    full.textContent = result;
    full.hidden = true;
    btn.append(desc, meta, excerpt);
    btn.title = desc.textContent;
    if (hasResult) {
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-label", `${job.description ?? "Job"} — ${outcome.textContent} by ${job.claimantName ?? job.claimantId ?? "an agent"}. Open the result.`);
      btn.addEventListener("click", () => {
        const nowHidden = !full.hidden;
        full.hidden = nowHidden;
        excerpt.hidden = !nowHidden;
        btn.setAttribute("aria-expanded", String(!nowHidden));
        const c = btn.querySelector(".jb-caret");
        if (c) c.textContent = nowHidden ? "▸" : "▾";
      });
    } else {
      btn.disabled = true;
    }
    row.append(btn, full);
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

export class DurableRunRegistry extends Component {
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
          ${this._cancellable(run.phase) ? `<button type="button" data-action="cancel"${reason ? ` aria-describedby="${descriptionId}"` : ""} ${pending ? "disabled" : ""}>Cancel</button>` : ""}
          ${this._resumable(run.phase) ? `<button type="button" data-action="resume"${reason ? ` aria-describedby="${descriptionId}"` : ""} ${pending ? "disabled" : ""}>${run.phase === "paused-side-effect-uncertain" ? "Retry" : "Resume"}</button>` : ""}
          <button type="button" data-action="logs"${reason ? ` aria-describedby="${descriptionId}"` : ""} ${pending ? "disabled" : ""}>View log</button>
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


