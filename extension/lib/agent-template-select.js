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
  const custom = supportsCustomSelect();

  const wrap = document.createElement("div");
  wrap.className = "agent-template-picker";
  wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;min-width:0;";

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
    // Preserve the current value across a filter re-render (a filtered-out
    // selection stays selected — the owner can clear the search to see it).
    const keep = select.value;
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
    select.value = keep || "";
    const hasMatch = shown.length > 0 || (query.trim() === "" );
    empty.hidden = hasMatch;
    empty.textContent = query.trim() ? "No templates match your search." : "";
    if (select.value === "" && !query.trim()) select.value = String(selected ?? "");
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
