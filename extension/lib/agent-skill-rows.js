// lib/agent-skill-rows.js — THE real agent-config dialog skills-section render
// path (CAP-FB-20260831-SKILL-LIST-SYNC-01 r4). buildAgentConfigDialog
// (extension/ntp/ntp.js) calls this to build, restore, count and collect the
// skill checkboxes — it is the ONLY render path, so tests that drive it are
// DIALOG-LEVEL proofs, not helper-level ones.
//
// Collision rules (r3): every checkbox is keyed by the source-qualified refId
// (builtin:<id> / imported:<id>); a legacy raw saved id resolves to EXACTLY
// ONE row (the unique owner, or the built-in on collision — resolveRecipe's
// raw order). Template suggestions toggle exactly one row of a colliding pair.
// The summary count always reflects what is actually checked.
//
// No chrome.* — DOM-only, so Deno tests can drive it with a fake document.

import { skillRowChecked, templateSkillMatches } from "./skill-registry.js";

/**
 * Build the skills-section rows for the agent-config dialog.
 *
 * @param {object} opts
 * @param {object[]} opts.available   the catalog rows ({ id, refId, source, name, description })
 * @param {string[]} opts.savedIds    the agent's saved skill ids (refIds and/or legacy raw ids)
 * @param {Element|null} opts.countEl the ".skill-count" element to update (may be null)
 * @param {(n: number) => void=} opts.onCount optional count callback
 * @returns {{
 *   rows: Array<{ id: string, skill: object, checkbox: HTMLInputElement, row: HTMLLabelElement }>,
 *   count: () => number,
 *   checkTemplate: (ids: string[]) => void,
 *   uncheckTemplate: (ids: string[]) => void,
 *   collectChecked: () => Array<{ id: string, name: string, description: string }>
 * }}
 */
export function buildAgentSkillRows({ available, savedIds, countEl = null, onCount = null, unavailableHost = null }) {
  const list = Array.isArray(available) ? available : [];
  const saved = Array.isArray(savedIds) ? savedIds : [];
  const rows = [];
  // chrome-agent-platform-xiln: a template may SUGGEST an id that has no row in
  // this profile (the curated templates name background recipes that are not
  // skills in the catalog). Those used to vanish silently — the owner saw a
  // template suggest five skills and two get checked, with nothing saying why.
  // They are DISCLOSED here instead. This does NOT fix the underlying data
  // question (whether a template should name background recipes as skills at
  // all); it makes the gap visible rather than passing for agreement.
  let unavailable = [];
  const renderUnavailable = () => {
    if (!unavailableHost) return;
    unavailableHost.replaceChildren();
    if (!unavailable.length) {
      unavailableHost.hidden = true;
      return;
    }
    unavailableHost.hidden = false;
    const lead = document.createElement("span");
    lead.className = "unavailable-label";
    lead.textContent = "Suggested by this template, not available in this profile:";
    unavailableHost.append(lead);
    for (const id of unavailable) {
      const item = document.createElement("span");
      item.className = "unavailable-skill";
      item.textContent = String(id);
      unavailableHost.append(item);
    }
  };
  // ONE source for the count copy. A caller that formats its own string will
  // overwrite the disclosure suffix (the dialog did exactly that, and the
  // browser-driven check caught it while the unit test passed) — so the label is
  // exposed as well as applied.
  const countLabel = () => {
    const n = rows.filter((r) => r.checkbox.checked).length;
    return (n > 0 ? `${n} selected` : `${list.length} available`) +
      (unavailable.length ? ` \u00b7 ${unavailable.length} suggested but unavailable` : "");
  };
  const updateCount = () => {
    const n = rows.filter((r) => r.checkbox.checked).length;
    if (countEl) countEl.textContent = countLabel();
    onCount?.(n);
  };
  for (const s of list) {
    const id = s?.refId ?? s?.id ?? s?.name ?? String(s);
    const row = document.createElement("label");
    row.className = "skill-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = skillRowChecked(list, saved, s);
    cb.addEventListener("change", updateCount);
    const text = document.createElement("span");
    text.textContent = `${s.name ?? id} — ${s.description ?? ""}`.replace(/\s+—\s*$/, "");
    row.append(cb, text);
    rows.push({ id, skill: s, checkbox: cb, row });
  }
  // Establish the host's initial state here rather than trusting the caller to
  // hide it: the LIBRARY owns the disclosure, so a host that forgot would
  // otherwise render an empty status line from the start.
  renderUnavailable();
  updateCount();
  return {
    rows,
    count: () => rows.filter((r) => r.checkbox.checked).length,
    checkTemplate(ids) {
      const t = Array.isArray(ids) ? ids : [];
      for (const r of rows) {
        if (templateSkillMatches(list, t, r.skill)) r.checkbox.checked = true;
      }
      // Which of the template's suggestions has NO row here? Computed with the
      // same matcher the checking uses, so the disclosure and the checkboxes can
      // never disagree about what exists.
      unavailable = t.filter((id) => !rows.some((r) => templateSkillMatches(list, [id], r.skill)));
      renderUnavailable();
      updateCount();
    },
    uncheckTemplate(ids) {
      const t = Array.isArray(ids) ? ids : [];
      for (const r of rows) {
        if (templateSkillMatches(list, t, r.skill)) r.checkbox.checked = false;
      }
      unavailable = [];
      renderUnavailable();
      updateCount();
    },
    /** The suggested ids with no row in this profile (evidence for the caller). */
    unavailableSuggestions: () => [...unavailable],
    /** The honest count label, including the disclosure suffix. Use THIS rather
     *  than formatting a count in the caller (see the comment on countLabel). */
    countLabel,
    collectChecked() {
      return rows.filter((r) => r.checkbox.checked).map((r) => ({
        id: r.skill?.refId ?? r.skill?.id ?? r.skill?.name ?? r.id,
        name: r.skill?.name ?? r.id,
        description: r.skill?.description ?? "",
      }));
    },
  };
}
