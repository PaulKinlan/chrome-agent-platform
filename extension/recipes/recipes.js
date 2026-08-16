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

/** A recipe = the shared capability-row (consistent layout) + a collapsed
 * "how it works" details for the documentation. */
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
  row.setAttribute("action", "run");
  row.addEventListener("run", async () => {
    row.setAttribute("description", "Running…");
    const out = await send("recipe.run", { id: r.id });
    row.setAttribute(
      "description",
      out?.ok ? "Done — ran the recipe." : "Failed — try again.",
    );
    setTimeout(() => row.setAttribute("description", baseDesc), 2000);
  });

  const details = document.createElement("details");
  details.className = "how";
  const summary = document.createElement("summary");
  summary.textContent = "How it works";
  const how = document.createElement("p");
  how.textContent = r.prompt ?? "";
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = `/task:${r.id}`;
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
    root.innerHTML = `<div class="empty">No recipes yet.</div>`;
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

render();
