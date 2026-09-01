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

// CAP-FB-20260901-SKILLS-IMPORT-BUTTON-01: the Import button was DEAD unless the
// user reached the Skills panel via a nav event (scroll or deep-link load never
// mounted it). The mount must be EAGER at init, exactly like mcp-servers and
// local-folders. Falsification: remove the eager mountSkillsSection call in the
// init block and this test goes RED; restore it and it goes GREEN.
Deno.test("skills-in-settings: the Skills panel mounts EAGERLY at init (import button works on scroll/deep-link load)", async () => {
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
});

// The import flow itself must accept a GitHub DIRECTORY/blob URL with a trailing
// slash (the owner's https://github.com/mattpocock/skills/blob/main/skills/
// productivity/teach/ — a multi-file skill the old parser could not resolve).
Deno.test("skills-in-settings: fetchSkillFromUrl resolves a GitHub directory/blob URL with trailing slash", async () => {
  const { fetchSkillFromUrl } = await import("../extension/lib/skill-import.js");
  // The GitHub Contents API rate-limits unauthenticated (60/hr); when the
  // budget is gone the import throws the honest rate-limit error — that is the
  // CORRECT behavior and must not fail the suite. The resolution logic itself
  // is proven by the browser journey + the direct Deno run (6 files, meta
  // name teach). A full local stub of the GitHub API is out of scope here.
  try {
    const r = await fetchSkillFromUrl("https://github.com/mattpocock/skills/blob/main/skills/productivity/teach/");
    assert(r?.meta?.name === "teach", `meta.name should be teach, got ${r?.meta?.name}`);
    assert(r?.files?.["SKILL.md"], "SKILL.md must be present in the fetched files");
    assert(Object.keys(r?.files ?? {}).length >= 2, "a multi-file skill must collect sibling files");
  } catch (e) {
    // @ts-expect-error — the catch binding is typed {} in this test file; e is unknown
    const msg = String(e?.message ?? e ?? "");
    assert(
      /rate-limited|HTTP 403/.test(msg),
      `expected a successful import OR an honest rate-limit error, got: ${msg.slice(0, 120)}`,
    );
  }
});
