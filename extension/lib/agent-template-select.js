// lib/agent-template-select.js — agent templates as a NATIVE, searchable
// <select> (owner directive 2026-08-31, CAP-FB-20260831-TEMPLATE-CUSTOM-SELECT-01).
//
// The owner asked for the template catalogue in the new Customizable Select
// elements ("a <select> using the new Customizable select elements… keep the
// current grouping including scheduled"). This module builds ONE picker:
//   - a native <select> with the Customizable Select pattern where supported
//     (first-child <button> select-button, <selectedcontent> mirror,
//     ::picker(select) / ::picker-icon styling, appearance: base-select);
//   - an identical CLASSIC <select> (same options/optgroups, same filtering)
//     where `appearance: base-select` is unsupported — never a broken picker;
//   - a live filter <input> above it (search across template name +
//     description; non-matching options and emptied groups are hidden; an
//     empty state is shown when nothing matches);
//   - grouping preserved exactly as the gallery had it: Starter / Other /
//     Scheduled (a background template is `mode === "background"`).
//
// Filtering PRESERVES the current selection: a template that matches the
// search stays selectable, and a selection that is filtered OUT is retained
// as a hidden option so the native value never silently resets (the button's
// <selectedcontent> keeps showing the honest current choice; the picker shows
// only the matches plus an empty-state note). This keeps the dialog form
// coherent with the select across every re-render.
//
// The customizable picker popup is styled with the same light-dark() tokens
// as the rest of the dialog in BOTH schemes (::picker(select) background and
// option states) — never a white-on-white popup in dark mode.
//
// No DOM in the module head: every function is pure or takes explicit DOM.
// The picker is a native select so screen readers get the semantics free; the
// filter input is labelled.

/** A template is a Starter if it is in the curated starter set. */
export function isStarterTemplate(t) {
  return t?.starter === true;
}

/** A template is Scheduled if it runs in the background. */
export function isScheduledTemplate(t) {
  return t?.mode === "background";
}

/** Group a catalogue exactly as the gallery's filter order did: Starter,
 * then everything else, then Scheduled. Groups with zero items are omitted. */
export function groupTemplates(catalogue) {
  const src = Array.isArray(catalogue) ? catalogue.filter((t) => t && typeof t === "object") : [];
  const groups = [
    { id: "starter", label: "Starter", items: [] },
    { id: "other", label: "Other", items: [] },
    { id: "scheduled", label: "Scheduled", items: [] },
  ];
  for (const t of src) {
    if (isStarterTemplate(t)) groups[0].items.push(t);
    else if (isScheduledTemplate(t)) groups[2].items.push(t);
    else groups[1].items.push(t);
  }
  return groups.filter((g) => g.items.length > 0);
}

/** Case-insensitive search over name + description (+ role). */
export function templateMatchesQuery(t, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const hay = `${t?.name ?? ""} ${t?.description ?? ""} ${t?.role ?? ""}`.toLowerCase();
  return hay.includes(q);
}

/** Filter a grouped catalogue by query, preserving group order. */
export function filterGroupedTemplates(groups, query) {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((t) => templateMatchesQuery(t, query)) }))
    .filter((g) => g.items.length > 0);
}

/** Feature-detect the Customizable Select API (Chrome 135+). */
export function supportsCustomSelect() {
  try {
    return typeof CSS !== "undefined" && CSS.supports("appearance", "base-select");
  } catch {
    return false;
  }
}

/** The option text for a template (also the classic-select fallback text).
 * A blank/"custom" template renders its own label. */
export function optionLabel(t) {
  if (!t) return "";
  const name = String(t.name ?? t.id ?? "Template");
  const desc = String(t.description ?? "").trim();
  return desc ? `${name} — ${desc}` : name;
}

// ── WCAG contrast (pure, shared by the module tests and the journey) ────────

function srgbChannel(c) {
  const v = Number(c) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of an sRGB triplet [0-255]. */
export function relativeLuminance(rgb) {
  const [r, g, b] = rgb;
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

/** WCAG contrast ratio between two sRGB triplets (1..21). */
export function wcagContrast(fg, bg) {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Parse a CSS color string into [r,g,b]: rgb()/rgba(), space-separated
 * `rgb(r g b / a)`, hex, or color(srgb r g b). Alpha composited onto a
 * backdrop when present. Returns null on anything unexpected. */
export function parseRgb(cssColor, backdrop = [255, 255, 255]) {
  const s = String(cssColor ?? "").trim();
  const m = s.match(/rgba?\(\s*([\d.]+)(?:[,\s]+([\d.]+))?(?:[,\s]+([\d.]+))?(?:[,\s/]+([\d.]+))?\s*\)/i);
  const hex = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  const srgb = s.match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/i);
  let r, g, b, a = 1;
  if (m) {
    const nums = [m[1], m[2], m[3]].map((x) => x === undefined ? undefined : Number(x));
    if (nums.some((n) => n !== undefined && !Number.isFinite(n))) return null;
    r = nums[0]; g = nums[1] ?? nums[0]; b = nums[2] ?? nums[0];
    a = m[4] === undefined ? 1 : Number(m[4]);
  } else if (hex) {
    r = parseInt(hex[1], 16); g = parseInt(hex[2], 16); b = parseInt(hex[3], 16);
  } else if (srgb) {
    r = Math.round(Number(srgb[1]) * 255); g = Math.round(Number(srgb[2]) * 255); b = Math.round(Number(srgb[3]) * 255);
    a = srgb[4] === undefined ? 1 : Number(srgb[4]);
  } else {
    return null;
  }
  if ([r, g, b, a].some((n) => n === undefined || !Number.isFinite(n))) return null;
  if (a >= 1) return [Math.round(r), Math.round(g), Math.round(b)];
  const [br, bgc, bb] = backdrop;
  return [Math.round(r * a + br * (1 - a)), Math.round(g * a + bgc * (1 - a)), Math.round(b * a + bb * (1 - a))];
}

/** Human text is ≥4.5; large text/UI components ≥3 (WCAG 1.4.3/1.4.11). */
export const CONTRAST_AA_TEXT = 4.5;
export const CONTRAST_AA_LARGE = 3.0;

/**
 * Build the template picker (a native select + filter input) into `host`.
 *
 * @param {object} opts
 * @param {Element}  opts.host        container to render into (cleared first)
 * @param {Array}    opts.catalogue   template records (from agent-templates)
 * @param {string}   opts.blankLabel  text for the "Custom agent" option
 * @param {string}   opts.selected    initially-selected template id ("" = blank)
 * @param {(id: string) => void} opts.onChange  called with the chosen id
 * @param {string=}  opts.filterLabel aria-label for the filter input
 * @returns {{select: HTMLSelectElement, filter: HTMLInputElement,
 *            refresh: () => void}}
 */
export function buildTemplateSelect({ host, catalogue, blankLabel = "Custom agent", selected = "", onChange, filterLabel = "Search templates" }) {
  const groups = groupTemplates(catalogue);
  const allById = new Map(groups.flatMap((g) => g.items).map((t) => [String(t.id), t]));
  const custom = supportsCustomSelect();

  const wrap = document.createElement("div");
  wrap.className = "agent-template-picker";
  wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;min-width:0;";

  // Customizable-select styling: the popup (::picker) and its option states use
  // the SAME light-dark() tokens as the dialog so dark mode is charcoal-on-
  // light-text, never a white popup with white rows. Classic selects keep the
  // browser's native (already dark-capable via color-scheme: light dark) popup.
  if (custom) {
    const style = document.createElement("style");
    style.textContent = `
      .agent-template-select { appearance: base-select; }
      .agent-template-select::picker(select) {
        background: light-dark(#ffffff, #23211d);
        color: light-dark(#1d1b18, #eae6de);
        border: 1px solid light-dark(#e3e0d9, #6b6355);
        border-radius: 8px;
        font-size: 13px;
        color-scheme: light dark;
      }
      .agent-template-select::picker(select) optgroup {
        background: light-dark(#ffffff, #23211d);
        color: light-dark(#1d1b18, #eae6de);
      }
      .agent-template-select::picker(select) option {
        background: light-dark(#ffffff, #23211d);
        color: light-dark(#1d1b18, #eae6de);
      }
      .agent-template-select::picker(select) option:hover {
        background: light-dark(#efede8, #2b2823);
        color: light-dark(#1d1b18, #eae6de);
      }
      .agent-template-select::picker(select) option:checked {
        background: light-dark(#d7f0ea, #0f2f2a);
        color: light-dark(#0a5c53, #67c7b9);
      }
      .agent-template-select::picker(select) option:focus-visible,
      .agent-template-select::picker(select) option:focus {
        outline: 2px solid light-dark(#0e6e63, #53b8a9);
        outline-offset: -2px;
      }
      .agent-template-select:open .agent-template-picker-icon { color: light-dark(#0e6e63, #53b8a9); }
      .agent-template-select .agent-template-picker-icon { color: light-dark(#635e56, #a8a195); }
    `;
    wrap.append(style);
  }

  const filter = document.createElement("input");
  filter.type = "search";
  filter.className = "agent-template-filter";
  filter.setAttribute("aria-label", filterLabel);
  filter.placeholder = filterLabel;
  filter.autocomplete = "off";
  filter.style.cssText = "box-sizing:border-box;width:100%;min-height:32px;padding:4px 10px;font:inherit;font-size:13px;border:1px solid var(--border,#e3e0d9);border-radius:6px;background:var(--panel,#ffffff);color:var(--text,#1d1b18);";
  wrap.append(filter);

  const select = document.createElement("select");
  select.id = "agent-template-select";
  select.className = "agent-template-select";
  select.setAttribute("aria-label", "Agent template");
  if (custom) {
    select.style.appearance = "base-select";
    select.style.cssText += "width:100%;min-height:40px;font-size:13px;color:var(--text,#1d1b18);";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-template-select-button";
    button.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:6px 10px;font:inherit;color:inherit;background:transparent;border:0;cursor:pointer;";
    const mirror = document.createElement("selectedcontent");
    mirror.className = "agent-template-selectedcontent";
    const icon = document.createElement("span");
    icon.className = "agent-template-picker-icon";
    icon.textContent = "▾";
    button.append(mirror, icon);
    select.append(button);
  } else {
    select.style.cssText += "box-sizing:border-box;width:100%;min-height:36px;padding:4px 8px;font:inherit;font-size:13px;border:1px solid var(--border,#e3e0d9);border-radius:6px;background:var(--panel,#ffffff);color:var(--text,#1d1b18);";
  }

  const empty = document.createElement("p");
  empty.className = "agent-template-empty";
  empty.style.cssText = "margin:0;padding:6px 0;font-size:12px;color:var(--muted,#635e56);";
  empty.hidden = true;
  wrap.append(select, empty);

  const refresh = () => {
    const query = filter.value;
    const shown = filterGroupedTemplates(groups, query);
    // Preserve the current native value across re-renders. If the selection is
    // filtered OUT it is retained as a HIDDEN option, so select.value never
    // silently resets and the button's <selectedcontent> keeps showing the
    // honest current choice while the picker lists only the matches.
    const keep = select.value;
    const keepTemplate = keep !== "" ? allById.get(keep) : null;
    select.replaceChildren();
    if (custom) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agent-template-select-button";
      button.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:6px 10px;font:inherit;color:inherit;background:transparent;border:0;cursor:pointer;";
      const mirror = document.createElement("selectedcontent");
      mirror.className = "agent-template-selectedcontent";
      const icon = document.createElement("span");
      icon.className = "agent-template-picker-icon";
      icon.textContent = "▾";
      button.append(mirror, icon);
      select.append(button);
    }
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = String(blankLabel);
    select.append(blank);
    const keepShown = keepTemplate && shown.some((g) => g.items.some((t) => String(t.id) === keep));
    for (const g of shown) {
      const og = document.createElement("optgroup");
      og.label = g.label;
      for (const t of g.items) {
        const opt = document.createElement("option");
        opt.value = String(t.id);
        opt.textContent = optionLabel(t);
        og.append(opt);
      }
      select.append(og);
    }
    // Retain the filtered-out selection as a hidden option so the native value
    // stays valid and coherent with the form (button shows the current choice;
    // the picker does not list it while the filter excludes it).
    if (keepTemplate && !keepShown) {
      const retained = document.createElement("option");
      retained.value = keep;
      retained.textContent = optionLabel(keepTemplate);
      retained.hidden = true;
      select.append(retained);
    }
    select.value = keep || "";
    if (select.value === "" && !query.trim()) select.value = String(selected ?? "");
    // Honest filtered state: with a query and no matches the empty note shows
    // (even when a selection is retained as a hidden option — the button still
    // shows the honest current choice); clearing the filter restores all.
    const matches = shown.some((g) => g.items.length > 0);
    empty.hidden = !(query.trim() !== "" && !matches);
    empty.textContent = query.trim() !== "" && !matches ? "No templates match your search." : "";
  };

  filter.addEventListener("input", refresh);
  select.addEventListener("change", () => {
    const id = select.value;
    onChange?.(String(id ?? ""));
  });

  host.replaceChildren(wrap);
  refresh();

  return { select, filter, refresh };
}
