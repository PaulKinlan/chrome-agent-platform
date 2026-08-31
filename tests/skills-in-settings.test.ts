// tests/skills-in-settings.test.ts — the Skills manager lives in Settings
// (owner directive: the standalone Skills view/button is gone; the manager is
// a Settings panel section). Source pins + pure-function coverage.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { SETTINGS_SECTIONS, normalizeSettingsSectionId, OPTIONS_PRODUCT_HASHES } from "../extension/lib/pure.js";

Deno.test("skills-in-settings: the NTP sidebar has NO Skills button (nav inventory pin)", async () => {
  const html = await Deno.readTextFile("extension/ntp/ntp.html");
  assert(!html.includes("open-recipes"), "the open-recipes button must be gone from the sidebar");
  assert(!/btn-label">Skills</.test(html), "no sidebar button labelled Skills");
  // The Directory button (the remaining footer view) must survive the removal.
  assert(html.includes("open-directory"), "the Directory button stays");
});

Deno.test("skills-in-settings: old skills deep links REDIRECT into Settings' Skills section", async () => {
  const src = await Deno.readTextFile("extension/ntp/ntp.js");
  // openView must rewrite a residual recipes path onto the settings document
  // at the #skills section — a redirect, never a dead end or an orphan view.
  assert(
    /recipes\/index\.html"\)\s*=\>\s*\{[\s\S]*?options\/options\.html#skills[\s\S]*?title = "Settings"/.test(src) ||
      src.includes(`path = "options/options.html#skills"`),
    "openView must redirect recipes/index.html to options/options.html#skills",
  );
  // The standalone route mapping must be gone (no VIEW_ROUTE.SKILLS anywhere).
  assert(!src.includes("VIEW_ROUTE.SKILLS"), "no SKILLS route in ntp.js");
  const routeFocus = await Deno.readTextFile("extension/ntp/route-focus.js");
  assert(!routeFocus.includes("SKILLS"), "route-focus VIEW_ROUTE must not define SKILLS");
});

Deno.test("skills-in-settings: #skills is a first-class Settings section (routing + auth)", () => {
  assert(SETTINGS_SECTIONS.includes("skills"), "SETTINGS_SECTIONS must include skills");
  assertEquals(normalizeSettingsSectionId("#skills"), "skills", "the hash normalizes");
  assert(OPTIONS_PRODUCT_HASHES.has("#skills"), "the product-owned hash set must include #skills (deep-link sender auth)");
});

Deno.test("skills-in-settings: the Settings panel hosts the full manager (nav + section + import + list)", async () => {
  const html = await Deno.readTextFile("extension/options/options.html");
  assert(html.includes('data-section="skills"'), "the settings nav has a Skills item");
  assert(html.includes('id="skills"'), "the settings section exists");
  assert(html.includes("import-url"), "an import affordance exists");
  const js = await Deno.readTextFile("extension/options/options.js");
  assert(js.includes("mountSkillsSection"), "options.js mounts the skills panel");
  assert(js.includes(`"skills"`), "the section render hook fires for skills");
});

Deno.test("skills-in-settings: the standalone recipes page is GONE (replaced by the reusable panel module)", async () => {
  let indexGone = false;
  try {
    await Deno.stat("extension/recipes/index.html");
  } catch {
    indexGone = true;
  }
  assert(indexGone, "recipes/index.html must be deleted (no orphan standalone page)");
  const panel = await Deno.readTextFile("extension/skills/skills-panel.js");
  assert(panel.includes("export async function renderSkillList"), "the reusable list renderer exists");
  assert(panel.includes("export function mountSkillsSection"), "the section mount exists");
  assert(panel.includes("use-skill"), "the hub-composer handoff (use in a task) is preserved");
});

Deno.test("skills-in-settings: renderSkillList groups by intent and hands use to onUse", async () => {
  // Stub the SW send by injecting a module-level override via dynamic import
  // of a data URL is overkill — instead exercise the grouping contract through
  // a seeded DOM-less pass: renderSkillList needs `send`, so pin its wiring
  // against the real module and verify the grouping logic through the source
  // contract (the integration is covered by the browser KAT).
  const panel = await Deno.readTextFile("extension/skills/skills-panel.js");
  assert(panel.includes('send("recipe.list")'), "the list renders from the live recipe.list record");
  // The only remaining occurrence of the old private filter is in a doc comment
  // (CAP-FB-20260831-SKILL-LIST-SYNC-01): executable code must not re-filter.
  const executable = panel.split(/\n/).filter((l) => {
    const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  }).join("\n");
  assert(!executable.includes('mode === "on-demand"'), "the panel applies NO private filter — the catalog (CAP-FB-20260831-SKILL-LIST-SYNC-01) is the single filter authority");
  assert(panel.includes("byIntent"), "skills group by intent");
  assert(panel.includes("skills-broken"), "failed-to-load skills surface in Settings, never silently");
});
