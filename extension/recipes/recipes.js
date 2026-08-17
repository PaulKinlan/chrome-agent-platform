// recipes/recipes.js — the documented on-demand recipe page. Each recipe is a
// <capability-row> (the SAME shared row component as the hub's site agents,
// artifacts, and the settings' permission/hook lists — icon | name+description
// STACKED | right-aligned action) + a collapsed "how it works" <details> for
// the documentation. Grouped by intent.

import { send } from "../lib/messages.js";
import { RECIPE_ICON } from "../shared/recipe-icons.js";

const root = document.getElementById("recipes");

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
  );
}

/** A skill = the shared capability-row (consistent layout) + a collapsed
 * "how it works" details for the documentation. The action is "Use in a task"
 * (a skill is included in a task, not run in isolation). */
function recipeCard(r) {
  const wrap = document.createElement("div");
  wrap.className = "recipe";

  const needs = (r.requiredCapabilities ?? []).length
    ? `needs ${r.requiredCapabilities.join(", ")}`
    : "no extra permissions";
  const baseDesc = `${r.description ?? ""} · ${needs}`;

  const row = document.createElement("capability-row");
  row.setAttribute("name", r.name);
  row.setAttribute("description", baseDesc);
  row.setAttribute("icon", RECIPE_ICON[r.icon] ?? "");
  row.setAttribute("action", "use");
  row.addEventListener("use", async () => {
    // Use the skill in a task: hand the reference to the hub composer (the
    // hub's openView overlay closes + the composer is pre-filled with the
    // /skill:<id> reference — the skill is INCLUDED, not run in isolation).
    window.parent?.postMessage({ type: "use-skill", id: r.id }, "*");
  });

  const details = document.createElement("details");
  details.className = "how";
  const summary = document.createElement("summary");
  summary.textContent = "How it works";
  const how = document.createElement("p");
  how.textContent = r.prompt ?? "";
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = `/skill:${r.id}`;
  details.append(summary, how, hint);

  wrap.append(row, details);
  return wrap;
}

async function render() {
  const res = await send("recipe.list").catch(() => ({ recipes: [] }));
  const recipes = (Array.isArray(res.recipes) ? res.recipes : []).filter(
    (r) => r.mode === "on-demand",
  );
  root.replaceChildren();
  if (!recipes.length) {
    root.innerHTML = `<div class="empty">No skills yet.</div>`;
    return;
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
    for (const r of list) group.append(recipeCard(r));
    root.append(group);
  }
}

// ── skill import (the chaos skill-loader pattern) ────────────────────────
const importUrl = document.getElementById("import-url");
const importBtn = document.getElementById("import-btn");
const importStatus = document.getElementById("import-status");
async function doImport() {
  const url = importUrl?.value?.trim();
  if (!url) { importStatus.textContent = "Enter a URL first"; return; }
  importBtn.disabled = true;
  importStatus.textContent = "Importing…";
  const out = await send("skill.import", { url }).catch(() => ({ ok: false, error: "import failed" }));
  importBtn.disabled = false;
  if (out?.ok) {
    importStatus.textContent = `Imported "${out.skill.name}" — use /skill:${out.skill.id}`;
    importUrl.value = "";
    await render();
  } else {
    importStatus.textContent = out?.error ?? "import failed";
  }
}
importBtn?.addEventListener("click", doImport);
importUrl?.addEventListener("keydown", (e) => { if (e.key === "Enter") doImport(); });

render();
