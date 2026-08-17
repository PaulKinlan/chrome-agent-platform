// tests/recipes.test.ts — the recipe registry (lib/recipes.js).
// @ts-nocheck — recipes.js is untyped JS; the registry shape is asserted at runtime.
//
// Verifies the 27 prompt-in-a-box recipes are ported + categorized, that each
// background recipe has a schedule + required capabilities, that the sorting
// hat (auto-group-by-domain) is a scheduled background agent, and that the
// mode/helper accessors are consistent. Pure data — no browser globals needed.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  RECIPES,
  INTENTS,
  backgroundRecipes,
  getRecipe,
  intentOf,
  onDemandRecipes,
  recipesByCategory,
  recipesByMode,
} from "../extension/lib/recipes.js";

// The 27 source recipe ids from prompt-in-a-box/examples.
const SOURCE_IDS = [
  "auto-group-by-domain",
  "auto-pin-favorites",
  "auto-reading-list",
  "bookmark-auto-categorize",
  "bookmark-dedupe",
  "clipboard-phrase-via-command",
  "context-menu-save-quote",
  "daily-summary",
  "dead-bookmark-cleaner",
  "dedupe-tabs",
  "download-nightly-summary",
  "download-organizer",
  "focus-mode",
  "idle-close-tabs",
  "meeting-prep",
  "omnibox-ask",
  "page-sentiment-log",
  "reading-time-estimator",
  "right-click-extract-topics",
  "right-click-summarize",
  "right-click-translate-selection",
  "stale-tab-closer",
  "summarize-on-navigate",
  "tab-hygiene",
  "tab-screenshot-diary",
  "weekly-digest",
  "weekly-review-prompt",
];

Deno.test("all 27 prompt-in-a-box recipes are ported", () => {
  const ids = new Set(RECIPES.map((r) => r.id));
  for (const id of SOURCE_IDS) {
    assert(ids.has(id), `missing recipe ${id}`);
  }
});

Deno.test("recipe ids are unique", () => {
  const ids = RECIPES.map((r) => r.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("every recipe has a prompt + a category", () => {
  for (const r of RECIPES) {
    assert(typeof r.prompt === "string" && r.prompt.length > 0, `prompt ${r.id}`);
    assert(typeof r.category === "string" && r.category.length > 0, `category ${r.id}`);
    assert(r.mode === "on-demand" || r.mode === "background", `mode ${r.id}`);
  }
});

Deno.test("every background recipe has a schedule + required capabilities", () => {
  for (const r of backgroundRecipes()) {
    assert(
      r.schedule && Number.isFinite(r.schedule.periodInMinutes) &&
        r.schedule.periodInMinutes > 0,
      `schedule ${r.id}`,
    );
    assert(Array.isArray(r.requiredCapabilities), `capabilities ${r.id}`);
  }
});

Deno.test("the sorting hat is a scheduled background agent", () => {
  const r = getRecipe("auto-group-by-domain");
  assert(r, "sorting hat present");
  assertEquals(r.mode, "background");
  assertEquals(r.name, "Sorting Hat");
  assertEquals(r.schedule.periodInMinutes, 30);
  assertEquals(r.category, "tabs");
});

Deno.test("mode + category accessors are consistent", () => {
  const bg = backgroundRecipes();
  const od = onDemandRecipes();
  assert(bg.length > 0 && od.length > 0);
  assert(bg.every((r) => r.mode === "background"));
  assert(od.every((r) => r.mode === "on-demand"));
  assertEquals(bg.length + od.length, RECIPES.length);
  for (const cat of new Set(RECIPES.map((r) => r.category))) {
    assertEquals(
      recipesByCategory(cat).every((r) => r.category === cat),
      true,
    );
    assertEquals(recipesByMode("background"), bg);
  }
});

Deno.test("every recipe resolves to a valid intent", () => {
  const valid = new Set(INTENTS.map((i) => i.id));
  for (const r of RECIPES) {
    const intent = intentOf(r);
    assert(valid.has(intent), `intent ${intent} invalid for ${r.id}`);
  }
});

Deno.test("each intent has at least one recipe", () => {
  const counts = new Map(INTENTS.map((i) => [i.id, 0]));
  for (const r of RECIPES) counts.set(intentOf(r), (counts.get(intentOf(r)) ?? 0) + 1);
  for (const [id, n] of counts) {
    assert(n > 0, `intent ${id} is empty`);
  }
});

// The wider-goal recipes added on top of the 27 prompt-in-a-box set
// (monitoring, analysis, capture, reading/research utilities).
const NEW_RECIPE_IDS = [
  "price-watcher",
  "page-change-watcher",
  "link-checker",
  "data-extractor",
  "cookie-tracker-auditor",
  "performance-reporter",
  "accessibility-checker",
  "seo-meta-checker",
  "form-filler",
  "screenshot-annotate",
  "reader-mode",
  "multi-tab-researcher",
];

Deno.test("the wider-goal utility recipes are present", () => {
  const ids = new Set(RECIPES.map((r) => r.id));
  for (const id of NEW_RECIPE_IDS) {
    assert(ids.has(id), `missing new recipe ${id}`);
  }
});

Deno.test("new recipes have valid intents + icons", () => {
  const validIntent = new Set(INTENTS.map((i) => i.id));
  for (const id of NEW_RECIPE_IDS) {
    const r = getRecipe(id);
    assert(r, `recipe ${id}`);
    assert(validIntent.has(intentOf(r)), `intent for ${id}`);
    assert(typeof r.icon === "string" && r.icon.length > 0, `icon for ${id}`);
    assert(r.mode === "on-demand" || r.mode === "background", `mode for ${id}`);
  }
});
