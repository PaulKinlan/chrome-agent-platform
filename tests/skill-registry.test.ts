// tests/skill-registry.test.ts — the built-in skill registry (lib/skill-registry.js).
// @ts-nocheck — skill-registry.js is untyped JS; the registry shape is asserted at runtime.
//
// Verifies the 27 prompt-in-a-box skills are ported + categorized, that each
// background skill has a schedule + required capabilities, that the sorting
// hat (auto-group-by-domain) is a scheduled background agent, and that the
// mode/helper accessors are consistent. Pure data — no browser globals needed.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  SKILLS,
  INTENTS,
  backgroundSkills,
  getSkill,
  intentOf,
  invalidSkillOrigins,
  onDemandSkills,
  skillsByCategory,
  skillsByMode,
  skillsForOrigin,
} from "../extension/lib/skill-registry.js";

// The 27 source skill ids from prompt-in-a-box/examples.
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

Deno.test("all 27 prompt-in-a-box skills are ported", () => {
  const ids = new Set(SKILLS.map((r) => r.id));
  for (const id of SOURCE_IDS) {
    assert(ids.has(id), `missing skill ${id}`);
  }
});

Deno.test("skill ids are unique", () => {
  const ids = SKILLS.map((r) => r.id);
  assertEquals(new Set(ids).size, ids.length);
});

Deno.test("every skill has a prompt + a category", () => {
  for (const r of SKILLS) {
    assert(typeof r.prompt === "string" && r.prompt.length > 0, `prompt ${r.id}`);
    assert(typeof r.category === "string" && r.category.length > 0, `category ${r.id}`);
    assert(r.mode === "on-demand" || r.mode === "background", `mode ${r.id}`);
  }
});

Deno.test("every background skill has a schedule + required capabilities", () => {
  for (const r of backgroundSkills()) {
    assert(
      r.schedule && Number.isFinite(r.schedule.periodInMinutes) &&
        r.schedule.periodInMinutes > 0,
      `schedule ${r.id}`,
    );
    assert(Array.isArray(r.requiredCapabilities), `capabilities ${r.id}`);
  }
});

Deno.test("the sorting hat is a scheduled background agent", () => {
  const r = getSkill("auto-group-by-domain");
  assert(r, "sorting hat present");
  assertEquals(r.mode, "background");
  assertEquals(r.name, "Sorting Hat");
  assertEquals(r.schedule.periodInMinutes, 30);
  assertEquals(r.category, "tabs");
});

Deno.test("mode + category accessors are consistent", () => {
  const bg = backgroundSkills();
  const od = onDemandSkills();
  assert(bg.length > 0 && od.length > 0);
  assert(bg.every((r) => r.mode === "background"));
  assert(od.every((r) => r.mode === "on-demand"));
  assertEquals(bg.length + od.length, SKILLS.length);
  for (const cat of new Set(SKILLS.map((r) => r.category))) {
    assertEquals(
      skillsByCategory(cat).every((r) => r.category === cat),
      true,
    );
    assertEquals(skillsByMode("background"), bg);
  }
});

Deno.test("origins on a skill are valid match patterns and bounded to 8", () => {
  // CAP-FB-20260830-SITE-PLAYBOOKS-01: the registry's origin bindings are
  // validated match patterns, bounded — an invalid declaration fails CLOSED
  // (the skill never composes) rather than silently becoming global.
  assertEquals(invalidSkillOrigins(), []);
});

Deno.test("the fixture-triage skill is bound to the loopback fixture origin (any port)", () => {
  const r = getSkill("fixture-triage");
  assert(r, "fixture-triage present");
  assertEquals(r.origins, ["http://127.0.0.1/*"]);
  // It is offered on the fixture origin and nowhere else.
  const onFixture = skillsForOrigin("http://127.0.0.1:8934/shop");
  assert(onFixture.some((x) => x.id === "fixture-triage"), "offered on the fixture origin");
  const elsewhere = skillsForOrigin("https://example.com/");
  assert(!elsewhere.some((x) => x.id === "fixture-triage"), "absent on example.com");
  // Global skills remain offered on both.
  assert(onFixture.some((x) => x.id === "tab-hygiene"));
  assert(elsewhere.some((x) => x.id === "tab-hygiene"));
});

Deno.test("every skill resolves to a valid intent", () => {
  const valid = new Set(INTENTS.map((i) => i.id));
  for (const r of SKILLS) {
    const intent = intentOf(r);
    assert(valid.has(intent), `intent ${intent} invalid for ${r.id}`);
  }
});

Deno.test("each intent has at least one skill", () => {
  const counts = new Map(INTENTS.map((i) => [i.id, 0]));
  for (const r of SKILLS) counts.set(intentOf(r), (counts.get(intentOf(r)) ?? 0) + 1);
  for (const [id, n] of counts) {
    assert(n > 0, `intent ${id} is empty`);
  }
});

// The wider-goal skills added on top of the 27 prompt-in-a-box set
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

Deno.test("the wider-goal utility skills are present", () => {
  const ids = new Set(SKILLS.map((r) => r.id));
  for (const id of NEW_RECIPE_IDS) {
    assert(ids.has(id), `missing new skill ${id}`);
  }
});

Deno.test("new skills have valid intents + icons", () => {
  const validIntent = new Set(INTENTS.map((i) => i.id));
  for (const id of NEW_RECIPE_IDS) {
    const r = getSkill(id);
    assert(r, `skill ${id}`);
    assert(validIntent.has(intentOf(r)), `intent for ${id}`);
    assert(typeof r.icon === "string" && r.icon.length > 0, `icon for ${id}`);
    assert(r.mode === "on-demand" || r.mode === "background", `mode for ${id}`);
  }
});
