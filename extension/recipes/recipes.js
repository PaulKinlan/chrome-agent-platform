// recipes/recipes.js — the documented on-demand recipe page. Each recipe is a
// card: what it does (name + description), how it works (a short summary), the
// optional capabilities it needs, and a Run button. Grouped by intent.

import { send } from "../lib/messages.js";
import { RECIPE_ICON } from "../shared/recipe-icons.js";

const root = document.getElementById("recipes");

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
  );
}

function setRunLabel(btn, text) {
  btn.textContent = text;
}

async function runRecipe(r, btn) {
  setRunLabel(btn, "Running…");
  btn.disabled = true;
  const out = await send("recipe.run", { id: r.id });
  btn.disabled = false;
  setRunLabel(btn, out?.ok ? "Done ✓" : "Retry");
  setTimeout(() => setRunLabel(btn, "Run"), 1800);
}

function recipeCard(r) {
  const card = document.createElement("div");
  card.className = "card";

  const head = document.createElement("div");
  head.className = "card-head";
  head.innerHTML =
    `<span class="card-icon" aria-hidden="true">${RECIPE_ICON[r.icon] ?? ""}</span>` +
    `<span class="card-title"><span class="card-name">${escapeHtml(r.name)}</span>` +
    `<span class="card-desc">${escapeHtml(r.description ?? "")}</span></span>`;

  const body = document.createElement("div");
  body.className = "card-body";
  const how = document.createElement("div");
  how.className = "how";
  how.textContent = r.prompt?.split(".")[0]?.trim() + "." ?? "";
  body.append(how);

  const meta = document.createElement("div");
  meta.className = "card-meta";
  for (const c of r.requiredCapabilities ?? []) {
    const n = document.createElement("span");
    n.className = "need";
    n.textContent = c;
    meta.append(n);
  }
  body.append(meta);

  const foot = document.createElement("div");
  foot.className = "card-foot";
  const hint = document.createElement("span");
  hint.className = "need";
  hint.textContent = `/task:${r.id}`;
  const run = document.createElement("button");
  run.type = "button";
  run.className = "run";
  run.textContent = "Run";
  run.addEventListener("click", () => runRecipe(r, run));
  foot.append(hint, run);

  card.append(head, body, foot);
  return card;
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

document.getElementById("back")?.addEventListener("click", () => {
  history.length > 1 ? history.back() : (location.href = "../ntp/ntp.html");
});

render();
