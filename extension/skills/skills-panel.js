// skills/skills-panel.js — the Skills manager as a REUSABLE panel module.
// Formerly the standalone recipes/index.html page (the sidebar Skills button
// was folded into Settings — the owner wants skills managed as a Settings
// panel), and formerly under extension/recipes/ — moved by
// CAP-FB-20260828-NOUN-DISCIPLINE-01 so the directory says what the UI says.
// The options page mounts this natively in its #skills section; the
// rendering (intent-grouped capability-rows + collapsed "how it works") is the
// SAME component set the standalone page used — no fork, no iframe.

import { send } from "../lib/messages.js";
import { SKILL_ICON } from "../shared/skill-icons.js";

/** A skill = the shared capability-row (consistent layout) + a collapsed
 * "how it works" details for the documentation. The action is "Use in a task"
 * (a skill is included in a task, not run in isolation). */
function recipeCard(r, onUse) {
  const wrap = document.createElement("div");
  wrap.className = "recipe";

  const needs = (r.requiredCapabilities ?? []).length
    ? `needs ${r.requiredCapabilities.join(", ")}`
    : "no extra permissions";
  const baseDesc = `${r.description ?? ""} · ${needs}`;

  const row = document.createElement("capability-row");
  row.setAttribute("name", r.name);
  row.setAttribute("description", baseDesc);
  row.setAttribute("icon", SKILL_ICON[r.icon] ?? "");
  row.setAttribute("action", "use");
  row.addEventListener("use", () => onUse?.(r));

  const details = document.createElement("details");
  details.className = "how";
  const summary = document.createElement("summary");
  summary.textContent = "How it works";
  const how = document.createElement("p");
  const hint = document.createElement("span");
  hint.className = "hint";
  const fileCount = (r.fileCount ?? 0) > 1 ? ` · ${r.fileCount} files` : "";
  const large = (r.promptBytes ?? 0) > 8192 || (r.prompt ?? "").length > 8192 ? " · large (load on demand)" : "";
  hint.textContent = `/skill:${r.id}${fileCount}${large}`;
  // Imported large skills carry metadata only (the body lives in OPFS); the
  // "how it works" panel must not dump an absent body — show the description
  // and the on-demand loader note instead.
  const bodyText = r.prompt ?? "";
  how.textContent = bodyText
    ? bodyText
    : `${r.description ?? ""}${large ? " — the full body and supporting files load on demand via skill_read during a run." : ""}`.trim() || r.id;
  details.append(summary, how, hint);

  wrap.append(row, details);
  return wrap;
}

/** Render the intent-grouped skill list into `listEl` from the live
 * recipe.list record. Exported for tests (a seeded store, no SW needed).
 *
 * CAP-FB-20260831-SKILL-LIST-SYNC-01: the catalog (skill.list / recipe.list)
 * is the SINGLE filter authority — the panel applies NO private filter (that
 * private `mode === "on-demand"` copy is what let Settings and /skill drift;
 * background recipes are excluded by the catalog, not by this panel). Skills
 * that failed to load surface in the broken-errors line, never silently. */
export async function renderSkillList(listEl, { onUse } = {}) {
  const [res, brokenRes] = await Promise.all([
    send("recipe.list").catch(() => ({ recipes: [] })),
    send("skill.list").catch(() => ({ skills: [], broken: [] })),
  ]);
  const recipes = Array.isArray(res.recipes) ? res.recipes : [];
  const broken = Array.isArray(brokenRes?.broken) ? brokenRes.broken : [];
  listEl.replaceChildren();
  if (broken.length > 0) {
    const brokenEl = document.createElement("div");
    brokenEl.className = "skills-broken";
    brokenEl.setAttribute("role", "note");
    brokenEl.textContent =
      `${broken.length} skill${broken.length === 1 ? "" : "s"} could not be loaded and ${broken.length === 1 ? "is" : "are"} hidden from pickers: ` +
      broken.map((b) => `${b.id} (${b.reason})`).join("; ") +
      ". See the browser console for details.";
    listEl.append(brokenEl);
  }
  if (!recipes.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No skills yet.";
    listEl.append(empty);
    return recipes;
  }
  const byIntent = {};
  for (const r of recipes) (byIntent[r.intent] ??= []).push(r);
  for (const [intent, list] of Object.entries(byIntent)) {
    const group = document.createElement("div");
    group.className = "intent-group";
    const head = document.createElement("div");
    head.className = "intent-head";
    head.textContent = intent;
    group.append(head);
    for (const r of list) group.append(recipeCard(r, onUse));
    listEl.append(group);
  }
  return recipes;
}

/** Use a skill in a task: hand the reference to the hub composer. When the
 * settings panel is hosted by the NTP view overlay (the normal in-context
 * case) the parent NTP receives the postMessage and pre-fills the composer.
 * When Settings is opened as a bare tab (no hub parent), degrade honestly:
 * copy the /skill:<id> reference and confirm inline — never a silent no-op. */
export function useSkill(skill, { statusEl } = {}) {
  const ref = `/skill:${skill.id}`;
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "use-skill", id: skill.id }, "*");
      return;
    }
  } catch {
    // Cross-origin parent — fall through to the copy fallback.
  }
  (async () => {
    try {
      await navigator.clipboard.writeText(ref);
      if (statusEl) statusEl.textContent = `Copied ${ref} — paste it in the hub composer to use it.`;
    } catch {
      if (statusEl) statusEl.textContent = `Copy this reference to use it: ${ref}`;
    }
  })();
}

/** Wire the import form + list inside a container. Idempotent per container:
 * the section re-renders in place (re-imports refresh the list). */
export function mountSkillsSection(sectionEl) {
  if (!sectionEl || sectionEl.dataset.skillsMounted === "1") return;
  sectionEl.dataset.skillsMounted = "1";
  const list = sectionEl.querySelector(".skills-list");
  const status = sectionEl.querySelector(".import-status");
  const urlInput = sectionEl.querySelector(".import-url");
  const importBtn = sectionEl.querySelector(".import-btn");

  const refresh = () => renderSkillList(list, {
    onUse: (r) => useSkill(r, { statusEl: status }),
  });
  sectionEl._refreshSkills = refresh;

  const doImport = async () => {
    const url = urlInput?.value?.trim();
    if (!url) { status.textContent = "Enter a URL first"; return; }
    importBtn.disabled = true;
    status.textContent = "Importing…";
    const out = await send("skill.import", { url }).catch(() => ({ ok: false, error: "import failed" }));
    importBtn.disabled = false;
    if (out?.ok) {
      const fileNote = (out.skill?.fileCount ?? 0) > 1 ? ` (${out.skill.fileCount} files)` : "";
      status.textContent = `Imported "${out.skill.name}"${fileNote} — use /skill:${out.skill.id}`;
      urlInput.value = "";
      await refresh();
    } else {
      status.textContent = out?.error ?? "import failed";
    }
  };
  importBtn?.addEventListener("click", doImport);
  urlInput?.addEventListener("keydown", (e) => { if (e.key === "Enter") doImport(); });

  refresh();
}
