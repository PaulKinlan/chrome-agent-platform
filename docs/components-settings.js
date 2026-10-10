// shared/components-settings.js — Settings, options, and model configuration elements.

import { t } from "./i18n.js";
import { cachedRpc } from "./rpc-cache.js";
import { canonicalRef, findAgentByRef } from "./agent-registry.js";
import { permissionUserLanguage, siteLabel } from "./permission-language.js";

import {
  Component,
  PanelButton,
  backend,
  fmtTime,
  mountTemplate,
  ICONS,
  escapeHtml,
  timeAgo,
  parseJSONAttr,
  summarizeInputSchema,
  placeFloating,
  normalizeSiteActivity,
  visibleSiteActivityLabel,
  SITE_ACTIVITY_FOCUS_KEY,
} from "./components-core.js";

const ARIA_HIDDEN = "aria-hidden";
const TRUE = ""; // boolean-attribute present marker


/* <theme-picker theme="sunlit"> — the theme swatches.
 * Gallery-only by owner decision (REVIEW-2026-08-30 §9 “Retain for future use … No component
 * is deleted”): this is not dead code to delete — re-verify that decision before removing it. */
export const THEMES = [
  { id: "midnight", label: "Midnight" },
  { id: "sunlit", label: "Sunlit" },
  { id: "neon", label: "Neon" },
  { id: "terminal", label: "Terminal" },
];
export class ThemePicker extends Component {
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
      .swatch .label { position:absolute; inset:auto 0 2px; font-size:var(--text-xs, 12px); text-align:center; color:inherit; }
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


export const PERMISSIONS = [
  { id: "storage", label: "Memory & settings", note: "OPFS memory + settings" },
  { id: "alarms", label: "Scheduled tasks", note: "chrome.alarms" },
  { id: "tabs", label: "Browser control", note: "open/navigate/close tabs (warned)" },
  { id: "activeTab", label: "Screenshots", note: "enables Chrome's transient owner-invoked capture only — never a background grant" },
  { id: "scripting", label: "Site Agents", note: "read pages / register scripts" },
  { id: "notifications", label: "Notifications", note: "chrome.notifications" },
  { id: "sidePanel", label: "Side panel", note: "chrome.sidePanel" },
];
export class PermissionRow extends Component {
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
      .state { font-size:12px; font-weight:600; color:var(--muted,#635e56); }
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

/* <origin-grant-row origin="https://github.com" expires-in-ms="540000">
 * One row of Settings → Browser control's allowed-origins list
 * (CAP-FB-20260902-ORIGIN-GRANT-UNION-01): the origin, how long its OWN grant
 * lasts ("until you turn it off" when persistent), and a Turn off button that
 * emits `revoke` with `{ origin }` — the page routes it through the service
 * worker; this row never touches storage. The origin is text, never markup. */
export class OriginGrantRow extends Component {
  static get observedAttributes() { return ["origin", "expires-in-ms", "disabled"]; }
  static expiryLabel(expiresInMs) {
    if (expiresInMs === null || expiresInMs === undefined || expiresInMs === "") {
      return "Allowed until you turn it off";
    }
    const ms = Number(expiresInMs);
    if (!Number.isFinite(ms) || ms <= 0) return "Expired";
    const minutes = Math.ceil(ms / 60_000);
    if (minutes < 1) return "Expires in under a minute";
    if (minutes === 1) return "Expires in 1 minute";
    if (minutes < 60) return `Expires in ${minutes} minutes`;
    const hours = Math.round(minutes / 60);
    return `Expires in ${hours === 1 ? "1 hour" : `${hours} hours`}`;
  }
  _render() {
    const origin = this.getAttribute("origin") || "";
    const expiry = OriginGrantRow.expiryLabel(this.getAttribute("expires-in-ms"));
    const disabled = this.hasAttribute("disabled");
    mountTemplate(this, `
      :host { display:block; }
      .row { display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--border,#e3e0d9); border-radius:10px; background:var(--panel,#ffffff); }
      .info { flex:1; min-width:0; }
      .origin { font-weight:600; overflow-wrap:anywhere; }
      .expiry { font-size:12px; color:var(--muted,#635e56); }
      .btn { border:1px solid var(--border,#e3e0d9); background:transparent; color:var(--text,#1d1b18); border-radius:7px; padding:6px 12px; cursor:pointer; font:inherit; white-space:nowrap; }
      .btn:disabled { opacity:.5; cursor:not-allowed; }
      .btn:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
    `, `<div part="row" class="row">
      <div class="info"><div class="origin">${escapeHtml(origin)}</div><div class="expiry">${escapeHtml(expiry)}</div></div>
      <button part="revoke" type="button" class="btn"${disabled ? " disabled" : ""} aria-label="Turn off browser control for ${escapeHtml(origin)}">Turn off</button>
    </div>`);
  }
  _wire() {
    this._root.querySelector(".btn")?.addEventListener("click", () => {
      this._emit("revoke", { origin: this.getAttribute("origin") || "" });
    });
  }
}
customElements.define("origin-grant-row", OriginGrantRow);


export class AgentTemplateCard extends Component {
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
      ? formatCadenceMinutes(minutes)
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
        border-radius:999px; color:var(--accent,#0e6e63); font-size:var(--text-xs, 12px); font-weight:700; line-height:1.4; }
      .persona { display:-webkit-box; margin:0; color:var(--muted,#635e56); font-size:var(--text-xs,12px);
        line-height:1.4; max-block-size:2.8em; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; overflow-wrap:anywhere; }
      .skills { display:flex; flex-wrap:wrap; align-items:center; gap:5px; min-inline-size:0; min-block-size:1.5em; }
      .skill, .overflow, .cadence { display:inline-flex; align-items:center; gap:4px; max-inline-size:100%; padding:2px 7px; border-radius:999px;
        background:var(--panel-2,#efede8); color:var(--muted,#635e56); font-size:var(--text-xs, 12px); line-height:1.5;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .cadence { background:transparent; border:1px solid var(--border,#e3e0d9); font-variant-numeric:tabular-nums; }
      .cadence svg { inline-size:12px; block-size:12px; }
      .overflow { border:1px solid var(--border,#e3e0d9); background:transparent; font-weight:700; }
      .use { display:inline-flex; align-items:center; gap:6px; justify-self:start; min-block-size:36px; padding:0 14px; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,6px);
        background:transparent; color:var(--text,#1d1b18); cursor:pointer; font:600 var(--text-sm,13px)/1 inherit;
        transition:background-color 150ms ease-out, border-color 150ms ease-out; }
      .use:hover { background:var(--panel-2,#efede8); border-color:var(--muted,#635e56); }
      .use[aria-pressed="true"] { background:transparent; color:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); box-shadow:inset 0 0 0 1px var(--accent,#0e6e63); }
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


export class AgentTemplateGallery extends Component {
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

export class WebmcpConsentManager extends Component {
  constructor() {
    super();
    this._data = { loading: true, error: "", sites: [], audit: null, status: "Loading site tool permissions…", busyKey: "" };
    this._activityFocus = null;
  }
  set data(value) {
    this._data = value && typeof value === "object" ? value : this._data;
    if (this._rendered) { this._render(); this._wire(); }
  }
  get data() { return this._data; }
  focusSiteActivity(value) {
    const activity = normalizeSiteActivity(value);
    if (!activity) return false;
    this._activityFocus = activity;
    if (this._rendered) {
      this._render();
      this._wire();
      queueMicrotask(() => {
        const target = this._root.querySelector(".audit-target") ?? this._root.querySelector("#webmcp-audit-title");
        target?.setAttribute?.("tabindex", "-1");
        target?.scrollIntoView?.({ block: "center" });
        target?.focus?.({ preventScroll: true });
      });
    }
    return true;
  }
  _render() {
    const data = this._data;
    const sites = Array.isArray(data.sites) ? data.sites : [];
    const audit = data.audit && typeof data.audit === "object" ? data.audit : null;
    const allRecords = Array.isArray(audit?.records) ? audit.records : [];
    const activityFocus = normalizeSiteActivity(this._activityFocus);
    const displayedSites = sites
      .map((site, siteIndex) => ({ site, siteIndex }))
      .filter(({ site }) => !activityFocus || site?.origin === activityFocus.origin);
    const records = activityFocus
      ? allRecords.filter((row) => row?.origin === activityFocus.origin)
      : allRecords;
    const anyBusy = Boolean(data.busyKey) || data.loading === true || Boolean(data.error);
    const eventLabel = (row) => {
      switch (row?.event) {
        case "consent-requested": return "Asked for first-use consent";
        case "consent-decided": return row.outcome === "allowed"
          ? "Allowed automatic use"
          : row.outcome === "denied"
            ? "Denied use"
            : row.outcome === "expired"
              ? "First-use request expired"
              : "First-use approval unavailable";
        case "consent-invalidated": return row.reason === "site-deleted"
          ? "Removed the Site Agent’s tool authority"
          : row.reason === "scripting-disabled"
            ? "Removed tool authority when browser access was disabled"
            : row.reason === "descriptor-changed"
              ? "Required consent again after the tool changed"
              : "Withheld work after authority changed";
        case "invocation-started": return "Sent a call to the site";
        case "invocation-finished": return row.outcome === "succeeded" ? "Received a successful result" : row.outcome === "revoked" ? "Withheld a result after revocation" : "Received a failed result";
        case "invocation-blocked": return "Blocked a site-tool call";
        case "consent-reset": return row.outcome === "disabled" ? "Turned site tools off" : "Reset the consent decision";
        default: return "Site-tool event";
      }
    };
    const outcomeLabel = (row) => {
      const outcome = String(row?.outcome ?? "unknown");
      if (outcome !== "pending") return outcome;
      if (row?.event === "consent-requested") return "requested";
      if (row?.event === "invocation-started") return "started";
      return "recorded";
    };
    const siteMarkup = displayedSites.length
      ? displayedSites.map(({ site, siteIndex }) => {
          const tools = Array.isArray(site.tools) ? site.tools : [];
          const siteBusy = String(data.busyKey ?? "").startsWith(`site:${siteIndex}:`);
          return `<section class="site" aria-labelledby="consent-site-${siteIndex}">
            <div class="site-head">
              <h4 id="consent-site-${siteIndex}">${escapeHtml(String(site.origin ?? "Unknown site"))}</h4>
              <span class="site-state ${site.policy === "deny" ? "off" : "on"}">${site.policy === "deny" ? "Tools off" : "Tools on"}</span>
            </div>
            <div class="site-actions" aria-label="Controls for ${escapeHtml(String(site.origin ?? "site"))}">
              <button type="button" data-site-index="${siteIndex}" data-policy="${site.policy === "deny" ? "allow" : "deny"}"${anyBusy ? " disabled" : ""}${siteBusy ? " aria-busy=\"true\"" : ""}>${site.policy === "deny" ? "Turn on site tools" : "Turn off site tools"}</button>
              <button type="button" data-site-index="${siteIndex}" data-reset="automatic"${anyBusy || site.policy === "deny" ? " disabled" : ""}>Disable automatic use</button>
              <button type="button" data-site-index="${siteIndex}" data-reset="all"${anyBusy ? " disabled" : ""}>Reset decisions</button>
            </div>
            ${tools.length
              ? `<ul class="tools" aria-label="Tools from ${escapeHtml(String(site.origin ?? "site"))}">${tools.map((_tool, toolIndex) => `<li><tool-directory-card data-site-index="${siteIndex}" data-tool-index="${toolIndex}"></tool-directory-card></li>`).join("")}</ul>`
              : `<p class="empty">No tools have been reported by this site yet.</p>`}
          </section>`;
        }).join("")
      : data.error
        ? `<p class="empty">Site tool permissions are unavailable. Try again.</p>`
        : activityFocus
          ? `<p class="empty">This site is no longer enrolled. Its retained activity remains below.</p>`
          : `<p class="empty">No Site Agents are enrolled. Add one above to review its tools here.</p>`;
    const auditMarkup = records.length
      ? `<ol class="audit-list">${records.map((row) => {
          const at = Number.isSafeInteger(row?.at) ? new Date(row.at) : null;
          const target = activityFocus && visibleSiteActivityLabel(row?.tool, 128) === activityFocus.tool ? " class=\"audit-target\"" : "";
          return `<li${target}>
            <div class="audit-main"><strong>${escapeHtml(eventLabel(row))}</strong><span class="audit-outcome">${escapeHtml(outcomeLabel(row))}</span></div>
            <div class="audit-tool">${escapeHtml(String(row?.origin ?? "Unknown site"))} · <code>${escapeHtml(String(row?.tool ?? "Unknown tool"))}</code></div>
            <div class="audit-meta">${at ? `<time datetime="${escapeHtml(at.toISOString())}">${escapeHtml(at.toLocaleString())}</time> · ` : ""}${escapeHtml(String(row?.actor ?? "system"))} · ${escapeHtml(String(row?.direction ?? ""))}</div>
          </li>`;
        }).join("")}</ol>`
      : data.error
        ? `<p class="empty">Audit history is unavailable. Try again.</p>`
        : activityFocus
          ? `<p class="empty">No activity for this site appears on this page. Use Older to continue through retained history.</p>`
          : `<p class="empty">No site-tool consent or invocation events yet.</p>`;
    mountTemplate(this, `
      :host { display:block; min-inline-size:0; }
      .root { display:grid; gap:18px; min-inline-size:0; }
      .site, .audit { min-inline-size:0; border:1px solid var(--border,#e3e0d9); border-radius:12px; padding:14px; background:var(--bg,#f7f6f3); }
      .site-head, .audit-head, .audit-main { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 12px; }
      h4 { margin:0; min-inline-size:0; font-size:14px; overflow-wrap:anywhere; }
      .site-state, .audit-outcome { display:inline-flex; padding:2px 8px; border:1px solid currentColor; border-radius:999px; color:var(--muted,#635e56); font-size:12px; font-weight:600; }
      .site-state.on { color:var(--success,#1a7f37); }
      .site-state.off { color:var(--danger,#cf222e); }
      .site-actions, .pager { display:flex; flex-wrap:wrap; gap:8px; margin-block-start:10px; }
      button { min-block-size:36px; max-inline-size:100%; padding:6px 10px; border:1px solid var(--border,#e3e0d9); border-radius:7px; background:var(--panel,#fff); color:var(--text,#1d1b18); cursor:pointer; font:inherit; white-space:normal; overflow-wrap:anywhere; }
      button:disabled { opacity:.55; cursor:not-allowed; }
      button:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      .tools, .audit-list { display:grid; gap:10px; margin:12px 0 0; padding:0; list-style:none; min-inline-size:0; }
      .audit { background:var(--panel,#fff); }
      .audit h4 { font-size:15px; }
      .audit-list li { min-inline-size:0; padding:10px 0; border-block-end:1px solid var(--border,#e3e0d9); }
      .audit-list li:last-child { border-block-end:0; }
      .audit-list li.audit-target { border-inline-start:3px solid var(--accent,#0e6e63); padding-inline-start:9px; }
      .audit-filter { margin:8px 0 0; color:var(--muted,#635e56); font-size:12px; overflow-wrap:anywhere; }
      .audit-main strong, .audit-tool, .audit-meta { overflow-wrap:anywhere; }
      .audit-tool { margin-block-start:3px; font-size:13px; }
      .audit-meta, .retention, .empty { color:var(--muted,#635e56); font-size:12px; }
      .retention { margin:8px 0 0; }
      .status { min-block-size:1.4em; margin:0; color:var(--muted,#635e56); font-size:13px; }
      .error { color:var(--danger,#cf222e); }
      @media (forced-colors:active) { .site, .audit, button, .site-state, .audit-outcome { border-color:CanvasText; } }
    `, `<div class="root" aria-busy="${data.loading === true ? "true" : "false"}">
      <p class="status${data.error ? " error" : ""}" role="status" aria-live="polite" aria-atomic="true">${escapeHtml(String(data.error || data.status || ""))}</p>
      <button type="button" class="refresh"${Boolean(data.busyKey) || data.loading === true ? " disabled" : ""}>${data.error ? "Try again" : "Refresh"}</button>
      ${data.loading === true && !sites.length ? `<p class="empty">Loading site tool permissions…</p>` : siteMarkup}
      <section class="audit" aria-labelledby="webmcp-audit-title">
        <div class="audit-head"><h4 id="webmcp-audit-title">Recent consent and use</h4>${activityFocus ? `<button type="button" class="audit-clear"${anyBusy ? " disabled" : ""}>Show all activity</button>` : ""}</div>
        ${activityFocus ? `<p class="audit-filter">Showing ${escapeHtml(visibleSiteActivityLabel(activityFocus.origin))}; highlighting ${escapeHtml(visibleSiteActivityLabel(activityFocus.tool, 128))}.</p>` : ""}
        ${auditMarkup}
        ${audit?.historyTruncated ? `<p class="retention">Older events were removed by the visible retention policy. The oldest retained sequence is ${escapeHtml(String(audit.firstRetainedSequence ?? "unknown"))}.</p>` : ""}
        <div class="pager" aria-label="Audit pages">
          <button type="button" data-audit-cursor="${escapeHtml(String(audit?.olderCursor ?? ""))}"${audit?.olderCursor && !anyBusy ? "" : " disabled"}>Older</button>
          <button type="button" data-audit-cursor="${escapeHtml(String(audit?.newerCursor ?? ""))}"${audit?.newerCursor && !anyBusy ? "" : " disabled"}>Newer</button>
        </div>
      </section>
    </div>`);
  }
  _wire() {
    const sites = Array.isArray(this._data.sites) ? this._data.sites : [];
    for (const card of this._root.querySelectorAll("tool-directory-card")) {
      const siteIndex = Number(card.dataset.siteIndex);
      const toolIndex = Number(card.dataset.toolIndex);
      const site = sites[siteIndex];
      const tool = site?.tools?.[toolIndex];
      if (!site || !tool) continue;
      card.tool = {
        ...tool,
        origin: site.origin,
        policy: site.policy,
        consentState: tool.state,
        manage: true,
        busy: this._data.busyKey === `tool:${siteIndex}:${toolIndex}`,
        disabled: Boolean(this._data.busyKey) || this._data.loading === true || Boolean(this._data.error),
        error: this._data.toolErrors?.[`${siteIndex}:${toolIndex}`] ?? "",
      };
      card.addEventListener("consent-action", (event) => {
        this._restoreFocus = `tool:${siteIndex}:${toolIndex}`;
        this._emit("tool-consent", { siteIndex, toolIndex, state: event.detail?.state });
      });
    }
    for (const button of this._root.querySelectorAll("[data-policy]")) {
      button.addEventListener("click", () => {
        this._restoreFocus = `policy:${button.dataset.siteIndex}`;
        this._emit("site-policy", {
          siteIndex: Number(button.dataset.siteIndex),
          policy: button.dataset.policy,
        });
      });
    }
    for (const button of this._root.querySelectorAll("[data-reset]")) {
      button.addEventListener("click", () => {
        this._restoreFocus = `reset:${button.dataset.siteIndex}:${button.dataset.reset}`;
        this._emit("site-reset", {
          siteIndex: Number(button.dataset.siteIndex),
          mode: button.dataset.reset,
        });
      });
    }
    for (const button of this._root.querySelectorAll("[data-audit-cursor]")) {
      button.addEventListener("click", () => {
        if (button.dataset.auditCursor) this._emit("audit-page", { cursor: button.dataset.auditCursor });
      });
    }
    this._root.querySelector(".refresh")?.addEventListener("click", () => {
      this._restoreFocus = "refresh";
      this._emit("refresh");
    });
    this._root.querySelector(".audit-clear")?.addEventListener("click", () => {
      this._activityFocus = null;
      this._render();
      this._wire();
      queueMicrotask(() => {
        const heading = this._root.querySelector("#webmcp-audit-title");
        heading?.setAttribute?.("tabindex", "-1");
        heading?.focus?.();
      });
    });
    if (!this._data.busyKey && this._data.loading !== true && this._restoreFocus) {
      let target = null;
      const [kind, siteIndex, detail] = this._restoreFocus.split(":");
      if (kind === "tool") {
        target = this._root.querySelector(`tool-directory-card[data-site-index="${siteIndex}"][data-tool-index="${detail}"]`)?.shadowRoot?.querySelector(".approve");
      } else if (kind === "policy") {
        target = this._root.querySelector(`[data-policy][data-site-index="${siteIndex}"]`);
      } else if (kind === "reset") {
        target = this._root.querySelector(`[data-reset="${detail}"][data-site-index="${siteIndex}"]`);
      } else if (kind === "refresh") {
        target = this._root.querySelector(".refresh");
      }
      if ((!target || target.disabled) && this._data.error) target = this._root.querySelector(".refresh");
      if (target && !target.disabled) queueMicrotask(() => target.focus());
      this._restoreFocus = "";
    }
  }
}
customElements.define("webmcp-consent-manager", WebmcpConsentManager);


export class AgentConfigForm extends Component {
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
    min-height: 36px;
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
export class ProviderSelect extends Component {
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
export class ModelPicker extends Component {
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
      .group { padding: 6px 10px 2px; font-size: 12px; font-weight: 600; color: var(--muted, #635e56); }
      .group + .group, .opt + .group { margin-top: 4px; border-top: 1px solid var(--border, #e3e0d9); padding-top: 8px; }
      .empty { padding: 8px 10px; font-size: 12px; color: var(--muted, #635e56); }
      .custom-hint { font-size: 12px; color: var(--accent2); }
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
    // A typed-but-not-picked model id must not be silently dropped when the
    // field loses focus (the owner types a model id and clicks Use — the saved
    // config would otherwise carry model:""). Commit the typed text unless an
    // option is highlighted (arrow keys); an option CLICK commits the option
    // itself and runs after this, so the click's value always wins.
    this._input.addEventListener("blur", () => {
      if (this._activeIndex < 0 && this._input.value !== this._committed) {
        this._commitInput();
      }
    });
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
    if (e.isComposing || e.keyCode === 229) return;
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
  /** Public drive hook: the Use handler commits typed-but-not-picked text
   * BEFORE reading the committed value (CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01). */
  commitTyped() { this._commitInput(); }
  _syncInput() { if (this._input && (this._root?.activeElement ?? document.activeElement) !== this._input) this._input.value = this._committed; }
  _syncCustomHint() {
    if (this._customHint) this._customHint.hidden = !(this.isCustom && this.models.length);
  }
}
customElements.define("model-picker", ModelPicker);


export const VIEWS = [
  { id: "hub", label: "Hub" },
  { id: "chat", label: "Chat" },
  { id: "directory", label: "Directory" },
  { id: "settings", label: "Settings" },
];
export class AgentNav extends Component {
  static get observedAttributes() { return ["active"]; }
  _render() {
    const active = this.getAttribute("active") || "hub";
    const tabs = VIEWS.map((v) =>
      `<button type="button" class="tab" data-view="${v.id}" role="tab"
        aria-selected="${v.id === active ? "true" : "false"}" tabindex="${v.id === active ? "0" : "-1"}">${escapeHtml(v.label)}</button>`
    ).join("");
    const markup = `<div class="tabs" role="tablist">${tabs}</div>`;
    mountTemplate(this, `
      :host { display:inline-flex; border:1px solid var(--border,#e3e0d9); border-radius:10px; padding:4px; background:var(--panel,#ffffff); }
      .tabs { display:inline-flex; gap:4px; }
      .tab { border:0; background:transparent; color:var(--text,#1d1b18); border-radius:7px; padding:7px 14px; cursor:pointer; font:inherit; }
      .tab[aria-selected="true"] { background:var(--accent,#0e6e63); color:var(--accent-contrast,#fff); }
      .tab:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:1px; }
    `, markup);
  }
  _wire() {
    const tabs = [...this._root.querySelectorAll(".tab")];
    tabs.forEach((t, i) => {
      t.addEventListener("click", () => this._emit("navigate", { view: t.dataset.view }));
      t.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const d = e.key === "ArrowRight" ? 1 : -1;
          const next = tabs[(i + d + tabs.length) % tabs.length];
          next?.focus();
          next?.click();
        }
      });
    });
  }
}
customElements.define("agent-nav", AgentNav);


export class ErrorConsole extends PanelButton {
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


export class SystemPromptEditor extends Component {
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
      .spe-badge { font-size:var(--text-xs, 12px); font-weight:600; padding:2px 8px;
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
      .spe-meta code { font-size:var(--text-xs, 12px); background:var(--bg,#f7f6f3);
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
/* vocab:advanced:end */

/* ──────────────────────────────────────────────────────────────────────────
 * <tool-library> — READ-ONLY owner diagnostics for the tool catalog contract
 * (CAP-FB-20260822-TOOL-LIBRARY-UI-01, panel-1 first slice).
 *
 * HARD BOUNDARY: the ONLY action surfaces are explicit-owner-click buttons —
 * the Settings preview Run button (emits tool-preview-request; the options
 * surface wires the single tool.preview.run route over the static allowlist)
 * and the package-validate button (emits tool-package-validate-request for
 * the EXACTLY-ONE listed package only — the ltkj.2 Settings validation
 * surface; validation never enables execution).
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

/* vocab:advanced:start — <tool-library> renders ONLY inside the developer-only
 * Tool library section (options.html#tool-library, data-developer), so it may
 * use the system's words (scripts/check-vocabulary.mjs, docs/COPY.md). */
export class ToolLibrary extends Component {
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
        ? `binary output · ${Number.isSafeInteger(value.stdoutBytes) ? value.stdoutBytes : 0} bytes · canonical base64\n${String(value.stdoutBase64 ?? "")}`
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
  get validationPackages() {
    return this._validationPackages ?? [];
  }
  set validationPackages(value) {
    this._validationPackages = Array.isArray(value) ? value : [];
    this._renderValidationPackages();
  }
  get validationResult() {
    return this._validationResult ?? null;
  }
  set validationResult(value) {
    this._validationResult = value && typeof value === "object" ? value : null;
    const statusEl = this._root.querySelector(".validation-status");
    if (!statusEl) return;
    if (value && typeof value === "object") {
      if (value.ok === true) {
        statusEl.classList.remove("error");
        statusEl.textContent = "Package validated. Execution is not enabled.";
      } else {
        statusEl.classList.add("error");
        const where = value.path ? ` (at ${value.path})` : "";
        statusEl.textContent = `Validation failed: ${value.error ?? "unknown refusal"}${where}.`;
      }
    } else {
      statusEl.classList.remove("error");
      statusEl.textContent = "";
    }
  }
  get validationBusy() {
    return this._validationBusy === true;
  }
  set validationBusy(value) {
    this._validationBusy = value === true;
    // Every validate affordance (section button + per-row buttons) tracks the
    // busy state — the section button was previously the only one toggled.
    for (const btn of this._root.querySelectorAll(".package-validate-btn")) {
      btn.disabled = value === true;
    }
    const statusEl = this._root.querySelector(".validation-status");
    if (statusEl && value === true) {
      statusEl.textContent = "Validating package…";
    }
  }
  _renderValidationPackages() {
    const container = this._root.querySelector(".validation-packages");
    const btn = this._root.querySelector(".package-validate-btn");
    if (!container) return;
    container.replaceChildren();
    const pkgs = this._validationPackages ?? [];
    if (pkgs.length === 0) {
      if (btn) btn.hidden = true;
      const p = document.createElement("p");
      p.className = "validation-empty meta";
      p.textContent = "No Emscripten packages are available for validation in this build.";
      container.append(p);
      return;
    }
    if (btn) btn.hidden = pkgs.length !== 1; // the section button serves the single-package case only
    const list = document.createElement("div");
    list.className = "validation-list";
    for (const pkg of pkgs) {
      const row = document.createElement("div");
      row.className = "validation-row";
      const info = document.createElement("span");
      info.className = "validation-pkg-info";
      info.textContent = `${pkg.packageId} (v${pkg.version})`;
      row.append(info);
      list.append(row);
    }
    container.append(list);
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
    this._root.querySelector(".package-validate-btn")?.addEventListener("click", (sourceEvent) => {
      if (this._validationBusy) return;
      // STRICT single-package binding: the section button exists (unhidden)
      // only when exactly one package is listed, and it validates exactly
      // that package — an implicit [0] selection over a multi-package list is
      // never possible (round-2 review finding 2; multi-package selection UI
      // is future reviewed work).
      if (this._validationPackages?.length !== 1) return;
      const pkg = this._validationPackages[0];
      this._emit("tool-package-validate-request", {
        packageId: pkg.packageId,
        version: pkg.version,
        expectedVersion: pkg.expectedVersion ?? null,
        sourceEvent,
      });
    });
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
      .purpose-family { display:grid; gap:6px; margin:0 0 14px; }
      .purpose-family-label { margin:0; font-size:15px; }
      .purpose-family-line { margin:2px 0 4px; font-size:12px; color:var(--muted, #625d57); }
      .groups .purpose-label { font-weight:600; }
      .groups .purpose-line { flex:1 1 100%; order:3; font-size:12px; font-weight:400;
        color:var(--muted, #625d57); overflow-wrap:anywhere; }
      .source-tool-head .src { font-size:var(--text-xs, 12px); padding:1px 8px; border:1px solid var(--border, #ddd8d2);
        border-radius:999px; color:var(--muted, #625d57); white-space:nowrap; }
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
      .source-tool-head { display:grid; grid-template-columns:minmax(0, 1fr) auto auto; gap:8px; align-items:start; }
      .source-tool-head strong { font-size:13px; overflow-wrap:anywhere; min-inline-size:0; }
      .source-tool-head .avail { font-size:var(--text-xs, 12px); padding:1px 8px; border:1px solid var(--border, #ddd8d2);
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
      .chip { font-size:var(--text-xs, 12px); padding:2px 8px; border:1px solid var(--border, #ddd8d2);
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
      .packages .package-validate-btn { margin-top:10px; padding:6px 14px; border:1px solid var(--border, #ddd8d2);
        border-radius:999px; background:var(--accent, #0e6e63); color:var(--btn-fg,#fff); font:inherit; font-size:13px;
        cursor:pointer; }
      .packages .package-validate-btn:focus-visible { outline:2px solid var(--accent, #0e6e63); outline-offset:2px; }
      .packages .package-validate-btn[disabled] { opacity:.55; cursor:default; }
      .packages .validation-status { min-block-size:1.25rem; margin:10px 0 0; font-size:13px; color:var(--muted, #625d57); }
      .packages .validation-status.error { color:var(--danger, #b3261e); }
      .packages .validation-pkg-info { font-size:13px; font-weight:600; }
      .preview { margin-top:20px; border-block-start:1px solid var(--border, #ddd8d2); padding-block-start:16px; }
      .preview h3 { margin:0 0 4px; font-size:15px; }
      .preview label { display:block; margin:8px 0 0; font-size:13px; color:var(--muted, #625d57); }
      .preview select { display:block; width:100%; box-sizing:border-box; margin-top:4px;
        border:1px solid var(--border, #ddd8d2); border-radius:var(--radius-md, 8px);
        font:inherit; font-size:13px; padding:6px 8px; background:var(--panel, #fff); color:var(--text, #24211f); }
      .preview-help { margin:8px 0 0; font-size:12px; color:var(--muted, #625d57); overflow-wrap:anywhere; }
      .preview-gzip-controls { margin-block-start:8px; }
      .preview-truncate-controls { margin-block-start:8px; }
      .preview-truncate-note { display:block; margin:4px 0 0; font-size:var(--text-xs, 12px); color:var(--muted, #625d57); }
      .preview-truncate-no-create-label { display:flex; align-items:center; gap:6px; margin:8px 0 0;
        font-size:13px; color:var(--text, #24211f); }
      .preview-truncate-no-create-label input { width:auto; margin:0; }
      .preview-touch-controls { margin-block-start:8px; }
      .preview-touch-note { display:block; margin:4px 0 0; font-size:var(--text-xs, 12px); color:var(--muted, #625d57); }
      .preview-touch-no-create-label { display:flex; align-items:center; gap:6px; margin:8px 0 0;
        font-size:13px; color:var(--text, #24211f); }
      .preview-touch-no-create-label input { width:auto; margin:0; }
      .preview-sqlite-controls { margin-block-start:8px; }
      .preview-sqlite-sql-label, .preview-sqlite-params-label { display:block; margin:8px 0 0;
        font-size:13px; color:var(--muted, #625d57); }
      .preview-sqlite-note { display:block; margin:4px 0 0; font-size:var(--text-xs, 12px); color:var(--muted, #625d57); }
      .preview-two-doc { margin-top:10px; }
      .preview-doc-label { display:block; margin:8px 0 0; font-size:13px; color:var(--muted, #625d57); }
      .preview-doc { display:block; width:100%; box-sizing:border-box; margin-top:4px;
        border:1px solid var(--border, #ddd8d2); border-radius:var(--radius-md, 8px);
        font:inherit; font-size:13px; padding:6px 8px; background:var(--panel, #fff); color:var(--text, #24211f);
        font-family:ui-monospace, monospace; resize:vertical; }
      .preview-doc:focus-visible { outline:2px solid var(--accent, #0e6e63); outline-offset:2px; }
      .preview-doc-count { margin:2px 0 0; font-size:var(--text-xs, 12px); color:var(--muted, #625d57);
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
        <div class="validation-packages">
          <p class="validation-empty meta">No Emscripten packages are available for validation in this build.</p>
        </div>
        <button class="package-validate-btn" type="button" hidden>Validate package</button>
        <p class="validation-status" role="status" aria-live="polite" aria-atomic="true"></p>
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
        ? ` · tool list version ${s.catalogGeneration.slice(0, 12)}` : "";
      total.textContent = `${s.descriptorCount ?? 0} tools available${gen}`;
      host.append(total);

      const packagesMeta = this._root.querySelector(".packages .meta");
      const bundledCount = s.bySource?.["bundled-package"] ?? 0;
      if (packagesMeta) {
        packagesMeta.textContent = bundledCount > 0
          ? `${bundledCount} immutable bundled WebAssembly tool packages are admitted in this build.`
          : "No bundled Wasm packages are admitted in this build. If a future reviewed package host lands, admitted bundles and their pins will be listed here.";
      }

      // CAP-FB-20260828-TOOL-LIBRARY-GROUPING-01: group by PURPOSE (the two
      // families + task-shaped groups from docs/TOOL-PURPOSE-GROUPS.md), not
      // by which Chrome API implements the tool. The source axis survives
      // demoted: each row still names its source, and the diagnostics detail
      // keeps the by-source counts.
      const rowsBySource = s.toolsBySource ?? {};
      const allRows = [];
      for (const kind of Object.keys(TOOL_LIBRARY_SOURCE_LABELS)) {
        // Bounded at 256 rows per source to match
        // TOOL_LIBRARY_SUMMARY_LIMITS.maxRowsPerSource (the full registry).
        const rows = Array.isArray(rowsBySource[kind]) ? rowsBySource[kind].slice(0, 256) : [];
        for (const row of rows) allRows.push(row);
      }
      // The taxonomy arrives IN the payload (one source of truth, SW-side).
      // A legacy/corrupt summary without it renders every row as Ungrouped —
      // honest, never a silent drop.
      const payloadGroups = s.purposeGroups && typeof s.purposeGroups === "object" ? s.purposeGroups : {};
      const payloadFamilies = Array.isArray(s.purposeFamilies) ? s.purposeFamilies : [];
      const rowsByGroup = new Map();
      const ungroupedRows = [];
      for (const row of allRows) {
        const gid = row && typeof row.purpose === "string" &&
            Object.prototype.hasOwnProperty.call(payloadGroups, row.purpose)
          ? row.purpose
          : null;
        if (gid) {
          if (!rowsByGroup.has(gid)) rowsByGroup.set(gid, []);
          rowsByGroup.get(gid).push(row);
        } else {
          // Never silently drop a row: an unclassified tool renders under an
          // honest "Ungrouped" section so the count and the rows still agree.
          ungroupedRows.push(row);
        }
      }
      const groups = document.createElement("section");
      groups.className = "groups";
      groups.setAttribute("aria-label", "Tools by purpose");
      const renderGroupDetails = (gid, label, line, rows) => {
        const details = document.createElement("details");
        details.className = "source-group";
        details.setAttribute("data-purpose", gid);
        const summaryEl = document.createElement("summary");
        const name = document.createElement("span");
        name.className = "purpose-label";
        name.textContent = label;
        const purposeLine = document.createElement("span");
        purposeLine.className = "purpose-line";
        purposeLine.textContent = line;
        const n = document.createElement("span");
        n.className = "count";
        n.textContent = String(rows.length);
        summaryEl.append(name, purposeLine, n);
        details.append(summaryEl);
        // ONE bounded per-tool summary list per group (name, source label,
        // version/availability, one-line description). Read-only — no action,
        // grant or verify surface is ever rendered here.
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
            const src = document.createElement("span");
            src.className = "src";
            src.textContent = String(row.sourceLabel ?? "");
            const avail = document.createElement("span");
            avail.className = `avail${row.available === true ? "" : " unavailable"}`;
            avail.textContent = typeof row.version === "string" && row.version
              ? `v${row.version}`
              : (row.available === true ? "available" : "unavailable");
            head.append(title, src, avail);
            const desc = document.createElement("p");
            desc.className = "source-tool-desc";
            desc.textContent = String(row.description ?? "");
            li.append(head, desc);
            list.append(li);
          }
          details.append(list);
        }
        return details;
      };
      for (const family of payloadFamilies) {
        if (!family || typeof family.id !== "string") continue;
        const famSection = document.createElement("section");
        famSection.className = "purpose-family";
        famSection.setAttribute("data-family", family.id);
        const famHead = document.createElement("h3");
        famHead.className = "purpose-family-label";
        famHead.textContent = String(family.label ?? family.id);
        const famLine = document.createElement("p");
        famLine.className = "purpose-family-line";
        famLine.textContent = String(family.line ?? "");
        famSection.append(famHead, famLine);
        for (const [gid, meta] of Object.entries(payloadGroups)) {
          if (!meta || meta.family !== family.id) continue;
          famSection.append(renderGroupDetails(gid, String(meta.label ?? gid), String(meta.line ?? ""), rowsByGroup.get(gid) ?? []));
        }
        groups.append(famSection);
      }
      if (ungroupedRows.length) {
        groups.append(renderGroupDetails(
          "ungrouped",
          "Ungrouped",
          "Tools the purpose taxonomy has not classified yet — shown so the count and the rows still agree.",
          ungroupedRows,
        ));
      }
      host.append(groups);

      const diag = s.catalogDiagnostics ?? {};
      const sel = s.selectionDiagnostics ?? {};
      const lines = [];
      // The demoted source axis: per-source counts live in diagnostics now.
      const sourceCounts = Object.entries(TOOL_LIBRARY_SOURCE_LABELS)
        .map(([kind, label]) => `${label} ${Number(s.bySource?.[kind] ?? 0)}`)
        .join(" · ");
      lines.push(`Tools by source: ${sourceCounts}.`);
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
/* vocab:advanced:end */

export class UserWasmManager extends Component {
  constructor() {
    super();
    this._records = [];
    this._busy = false;
  }
  set records(value) {
    this._records = Array.isArray(value) ? value : [];
    if (this._rendered) this._renderList();
  }
  get records() { return this._records; }
  set busy(value) {
    this._busy = Boolean(value);
    if (!this._rendered) return;
    this._root.querySelector("fieldset").disabled = this._busy;
    this._root.querySelectorAll("button").forEach((button) => { button.disabled = this._busy; });
    this._root.querySelector("#files").setAttribute("aria-busy", String(this._busy));
  }
  get busy() { return this._busy; }
  setStatus(message, error = false) {
    const status = this._root.querySelector("#status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", error);
    status.setAttribute("role", error ? "alert" : "status");
  }
  clearForm() { this._root.querySelector("form")?.reset(); }
  focusAfterRemove() {
    (this._root.querySelector("[data-remove]") ?? this._root.querySelector("#file"))?.focus();
  }
  _render() {
    mountTemplate(this, `${CONTROL_CSS}
      :host { color:var(--text,#1d1b18); font:inherit; line-height:1.5; }
      form, fieldset { margin:0; padding:0; border:0; min-width:0; }
      fieldset { display:grid; gap:16px; }
      legend { font-weight:650; font-size:var(--text-base,15px); margin-block-end:16px; }
      .field-label { color:var(--text,#1d1b18); font-size:var(--text-sm,13px); font-weight:600; }
      .hint, .meta, #empty { color:var(--muted,#635e56); font-size:var(--text-sm,13px); }
      .hint { margin:0; max-width:70ch; }
      input[type=file] { height:auto; padding:8px; }
      input::file-selector-button, button { font:inherit; color:var(--text,#1d1b18); background:var(--panel,#fff); border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,7px); padding:7px 12px; min-height:36px; cursor:pointer; }
      input::file-selector-button { margin-inline-end:12px; }
      textarea.control { min-height:100px; padding:10px 12px; resize:vertical; }
      button { width:fit-content; }
      button.primary { background:var(--accent,#0e6e63); border-color:var(--accent,#0e6e63); color:var(--btn-fg,#fff); }
      button:hover:not(:disabled), input::file-selector-button:hover { border-color:var(--accent,#0e6e63); }
      button:focus-visible, summary:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; }
      button:disabled { opacity:.55; cursor:wait; }
      #status { min-height:1.5em; overflow-wrap:anywhere; margin:16px 0 24px; font-size:var(--text-sm,13px); }
      #status.error { color:var(--danger,#b91c1c); }
      .list-head { display:flex; justify-content:space-between; align-items:center; gap:16px; }
      h3 { font-size:var(--text-base,15px); margin:0; }
      ul { list-style:none; padding:0; margin:8px 0 0; }
      li { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:16px; align-items:start; border-block-start:1px solid var(--border,#e3e0d9); padding:16px 0; }
      .name, .description, code { overflow-wrap:anywhere; }
      .description { white-space:pre-wrap; margin:6px 0; }
      .meta { font-variant-numeric:tabular-nums; margin:6px 0; }
      summary { cursor:pointer; font-size:var(--text-sm,13px); }
      code { display:block; margin-block-start:6px; font-size:var(--text-xs,12px); user-select:all; }
      @media(max-width:480px) { li { grid-template-columns:1fr; gap:8px; } }
    `, `
      <form aria-label="Add a WebAssembly file">
        <fieldset>
          <legend>Add a file</legend>
          <label class="field" for="file"><span class="field-label">WebAssembly file</span>
            <input class="control" id="file" name="file" type="file" accept=".wasm,application/wasm" required>
          </label>
          <label class="field" for="name"><span class="field-label">Name</span>
            <input class="control" id="name" name="name" type="text" required placeholder="For example, Image converter">
          </label>
          <label class="field" for="description"><span class="field-label">Description for the agent</span>
            <textarea class="control" id="description" name="description" rows="3" required aria-describedby="description-hint"></textarea>
            <span class="hint" id="description-hint">Agents will read this description to decide when to call the tool. Explain what it does and what input it expects. Calling uploaded files is not connected yet.</span>
          </label>
          <p class="hint">Identical file contents update the existing name and description. Different files can share a name; their full digests identify them separately.</p>
          <button type="submit" class="primary">Add file</button>
        </fieldset>
      </form>
      <p id="status" role="status"></p>
      <div class="list-head"><h3>Saved files</h3><button id="refresh" type="button">Refresh list</button></div>
      <p id="empty">No files saved yet.</p>
      <ul id="files" aria-label="Saved WebAssembly files"></ul>
    `);
    this._renderList();
    this.busy = this._busy;
  }
  _renderList() {
    const list = this._root.querySelector("#files");
    list.replaceChildren();
    this._root.querySelector("#empty").hidden = this._records.length > 0;
    for (const record of this._records) {
      const row = document.createElement("li");
      row.dataset.digest = record.digest;
      const content = document.createElement("div");
      const name = document.createElement("strong");
      name.className = "name";
      name.textContent = record.name;
      const description = document.createElement("p");
      description.className = "description";
      description.textContent = record.description;
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = `${Number(record.size).toLocaleString()} bytes · Added ${new Date(record.addedAt).toLocaleString()}`;
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "File digest (SHA-256)";
      const digest = document.createElement("code");
      digest.textContent = record.digest;
      details.append(summary, digest);
      content.append(name, description, meta, details);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.remove = record.digest;
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${record.name}`);
      remove.disabled = this._busy;
      remove.addEventListener("click", () => this._emit("user-wasm-remove", { digest: record.digest, name: record.name }));
      row.append(content, remove);
      list.append(row);
    }
  }
  _wire() {
    this._root.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (this._busy || !event.target.reportValidity()) return;
      this._emit("user-wasm-upload", {
        file: this._root.querySelector("#file").files[0],
        name: this._root.querySelector("#name").value,
        description: this._root.querySelector("#description").value,
      });
    });
    this._root.querySelector("#refresh").addEventListener("click", () => this._emit("user-wasm-refresh"));
  }
}
customElements.define("user-wasm-manager", UserWasmManager);


