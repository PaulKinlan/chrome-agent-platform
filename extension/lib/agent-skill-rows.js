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

import { skillRowChecked, templateSkillMatches } from "./recipes.js";

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
export function buildAgentSkillRows({ available, savedIds, countEl = null, onCount = null }) {
  const list = Array.isArray(available) ? available : [];
  const saved = Array.isArray(savedIds) ? savedIds : [];
  const rows = [];
  const updateCount = () => {
    const n = rows.filter((r) => r.checkbox.checked).length;
    if (countEl) countEl.textContent = n > 0 ? `${n} selected` : `${list.length} available`;
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
  updateCount();
  return {
    rows,
    count: () => rows.filter((r) => r.checkbox.checked).length,
    checkTemplate(ids) {
      const t = Array.isArray(ids) ? ids : [];
      for (const r of rows) {
        if (templateSkillMatches(list, t, r.skill)) r.checkbox.checked = true;
      }
      updateCount();
    },
    uncheckTemplate(ids) {
      const t = Array.isArray(ids) ? ids : [];
      for (const r of rows) {
        if (templateSkillMatches(list, t, r.skill)) r.checkbox.checked = false;
      }
      updateCount();
    },
    collectChecked() {
      return rows.filter((r) => r.checkbox.checked).map((r) => ({
        id: r.skill?.refId ?? r.skill?.id ?? r.skill?.name ?? r.id,
        name: r.skill?.name ?? r.id,
        description: r.skill?.description ?? "",
      }));
    },
  };
}
