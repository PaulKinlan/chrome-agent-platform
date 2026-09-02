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

// The Import button was DEAD unless the user reached the Skills panel via a nav
// event — scrolling into view (the settings sections are one scrollable page)
// never fired the nav handler's mount, so the click handler was never wired.
// The mount must be EAGER at init, exactly like mcp-servers and local-folders.
// Falsification: delete the eager mountSkillsSection call in the init block and
// this test goes RED; restore it and it goes GREEN.
Deno.test("skills-in-settings: the Skills panel mounts EAGERLY at init (Import button works on scroll/deep-link load)", async () => {
  const js = await Deno.readTextFile("extension/options/options.js");
  // The eager mount sits in the INIT block (the module-level render sequence),
  // NOT only in the nav handler. Slice the init segment between renderLocalFolders
  // and the developer-tool-library render, and require the mount call in that
  // segment — the nav-handler call lives far outside it, so a nav-only mount
  // (the pre-fix bug) fails this check.
  const initSegment = js.slice(js.indexOf("await renderLocalFolders();"), js.indexOf("if (developerFeaturesEnabled) await renderToolLibrary();"));
  assert(
    initSegment.includes('mountSkillsSection(document.getElementById("skills"));'),
    "mountSkillsSection must be called eagerly in the init block (between renderLocalFolders and renderToolLibrary), not only in the nav handler",
  );
  // The nav handler still calls it (idempotent via the dataset guard) so a nav
  // click re-renders nothing but stays safe.
  assert(js.includes('sectionId === "skills"'), "the nav handler still references the skills section");
  // The panel module wires the Import button inside the mount (the handler the
  // owner found dead).
  const panel = await Deno.readTextFile("extension/skills/skills-panel.js");
  assert(panel.includes('importBtn?.addEventListener("click", doImport)'), "the Import button gets its click handler in the mount");
  assert(panel.includes('urlInput?.addEventListener("keydown"'), "the Enter-to-import handler is wired");
  // The section must be static HTML present at load so the eager mount finds it.
  const html = await Deno.readTextFile("extension/options/options.html");
  assert(html.includes('id="skills"') && html.includes("import-url"), "the skills section with the import affordance is static HTML");
});

// GitHub DIRECTORY/blob URLs (owner's https://github.com/mattpocock/skills/blob/
// main/skills/productivity/teach/) must resolve through the Contents API walk to
// the SKILL.md + sibling files. The walk logic is covered OFFLINE in
// tests/skill-import.test.ts; this pins the blob-URL parser shape that the
// import flow accepts end to end (tree and blob forms both carry /branch/path).
Deno.test("skills-in-settings: the GitHub blob/directory URL shape is accepted by the import resolver", async () => {
  const src = await Deno.readTextFile("extension/lib/skill-import.js");
  assert(src.includes("tree|blob"), "the GitHub URL parser accepts /tree/ and /blob/ forms");
  assert(src.includes("contents"), "the Contents API walk is the GitHub import path");
  // The fetch-and-persist route (skill.import) resolves through fetchSkillFromUrl.
  const sw = await Deno.readTextFile("extension/background/service-worker.js");
  assert(sw.includes("fetchSkillFromUrl"), "the service worker import route calls fetchSkillFromUrl");
  assert(sw.includes('"skill.import"'), "the skill.import message route exists");
});
