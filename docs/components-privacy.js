// shared/components-privacy.js — Privacy statement components.

import { t } from "./i18n.js";
import {
  Component,
  mountTemplate,
  ICONS,
  escapeHtml,
} from "./components-core.js";

const ARIA_HIDDEN = "aria-hidden";
const TRUE = ""; // boolean-attribute present marker

export class PrivacyStatement extends Component {
  set statement(v) {
    this._statement = v && typeof v === "object" ? v : null;
    if (this._rendered) { this._render(); this._wire(); }
  }
  get statement() { return this._statement ?? null; }
  _render() {
    mountTemplate(this, `
      :host { display:block; color:var(--text,#1d1b18); font-size:14px; line-height:1.55; }
      section { margin:0 0 28px; }
      h2 { font-size:16px; font-weight:600; margin:0 0 10px; letter-spacing:-0.01em; }
      ul { margin:0; padding:0; list-style:none; display:grid; gap:10px; }
      li { position:relative; padding-left:20px; }
      li::before { content:""; position:absolute; left:4px; top:0.62em; width:6px; height:6px; border-radius:50%;
        background:var(--accent,#0e6e63); }
      p.host { margin:0; padding:12px 14px; border:1px solid var(--border,#e3e0d9); border-radius:var(--radius-sm,8px);
        background:var(--panel,#ffffff); }
      details { margin-top:12px; color:var(--muted,#635e56); font-size:13px; }
      summary { cursor:pointer; }
      summary:focus-visible { outline:2px solid var(--accent,#0e6e63); outline-offset:2px; border-radius:4px; }
      code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; }
      .empty { color:var(--muted,#635e56); margin:0; }
    `, `<div class="statement"></div>`);
    const root = this._root.querySelector(".statement");
    const s = this._statement;
    if (!s) {
      const p = document.createElement("p");
      p.className = "empty";
      p.textContent = "Loading what this extension sends and stores…";
      root.append(p);
      return;
    }
    const list = (heading, rows, id) => {
      const section = document.createElement("section");
      section.id = id;
      section.setAttribute("aria-labelledby", `${id}-heading`);
      const h = document.createElement("h2");
      h.id = `${id}-heading`;
      h.textContent = heading;
      const ul = document.createElement("ul");
      for (const row of rows ?? []) {
        const li = document.createElement("li");
        li.dataset.row = String(row?.id ?? "");
        li.textContent = String(row?.text ?? "");
        ul.append(li);
      }
      section.append(h, ul);
      return section;
    };
    root.append(list("What leaves this computer", s.sent, "sent"));

    const host = document.createElement("section");
    host.id = "host-access";
    host.setAttribute("aria-labelledby", "host-access-heading");
    const hostH = document.createElement("h2");
    hostH.id = "host-access-heading";
    hostH.textContent = "What it can read";
    const hostP = document.createElement("p");
    hostP.className = "host";
    hostP.textContent = String(s.hostAccess ?? "");
    host.append(hostH, hostP);
    root.append(host);

    const stored = list("What stays on this computer", s.stored, "stored");
    if (Array.isArray(s.stored) && s.stored.length) {
      const details = document.createElement("details");
      details.setAttribute("data-vocab", "advanced");
      const summary = document.createElement("summary");
      summary.textContent = "The storage names, for the technically minded";
      const ul = document.createElement("ul");
      for (const row of s.stored) {
        const li = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = String(row?.id ?? "");
        li.append(code);
        ul.append(li);
      }
      details.append(summary, ul);
      stored.append(details);
    }
    root.append(stored);
    root.append(list("How your key is handled", s.keyHandling, "key-handling"));
    root.append(list("How to remove it", s.wipe, "wipe"));
  }
  _wire() {}
}
customElements.define("privacy-statement", PrivacyStatement);


