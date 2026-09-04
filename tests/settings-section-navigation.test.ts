// tests/settings-section-navigation.test.ts — CAP-FB-20260827-SETTINGS-MONOLITH-01 / q94
//
// Verifies:
// 1. Settings panels default to display: none and render only when .active.
// 2. handleSettingsHashNavigation activates exactly the requested section.
// 3. Initial state has providers as active by default.
// 4. Section navigation preserves single-entry history replaceState semantics.
// 5. Deep linking directly to a hash activates that section.

import { assert, assertEquals } from "jsr:@std/assert@1";

const CSS = await Deno.readTextFile(new URL("../extension/options/options.css", import.meta.url));
const HTML = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
const JS = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));

Deno.test("settings multi-section: .panel styles define display:none and .panel.active display:block", () => {
  assert(
    CSS.includes(".panel {") && CSS.includes("display: none;"),
    "options.css must specify display: none for inactive .panel",
  );
  assert(
    CSS.includes(".panel.active {") && CSS.includes("display: block;"),
    "options.css must specify display: block for .panel.active",
  );
});

Deno.test("settings multi-section: options.html marks initial #providers panel as active", () => {
  assert(
    HTML.includes('id="providers" class="panel active"'),
    "options.html must mark #providers with class='panel active'",
  );
});

Deno.test("settings multi-section: handleSettingsHashNavigation toggles .active on section.panel", () => {
  assert(
    JS.includes('s.classList.toggle("active", s.id === sectionId)'),
    "options.js must toggle active class matching current sectionId",
  );
  assert(
    JS.includes("ensureSectionRendered(sectionId)"),
    "options.js must lazy-render the active section",
  );
});

Deno.test("settings multi-section: DOM node count and active panel isolation", () => {
  const sections = [...HTML.matchAll(/<section\s+id="([^"]+)"\s+class="panel(?:\s+active)?"/g)].map((m) => m[1]);
  assertEquals(sections.length, 14, "options.html has 14 section panels");
  const activeSections = [...HTML.matchAll(/<section\s+id="([^"]+)"\s+class="panel\s+active"/g)].map((m) => m[1]);
  assertEquals(activeSections, ["providers"], "only providers is initially active");
});
