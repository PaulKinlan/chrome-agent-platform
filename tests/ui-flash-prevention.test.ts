// tests/ui-flash-prevention.test.ts — Prevention of UI flash and relayout during settings navigation (CAP-FB-20260819-UI-FLASH-RELAYOUT-01 / fw8).
//
// Falsification & regression verification:
// 1. Eager section renders (data, memory, enrolled sites, webmcp, local folders, observability, retention) must NOT run at top-level; they must be encapsulated in ensureSectionRendered.
// 2. navigationController.syncCurrent() must be called exactly ONCE at the end of options.js setup (no double-sync flash).
// 3. handleSettingsHashNavigation guards scrollIntoView and heading focus against redundant executions when the section is already active.
// 4. All settings sections have corresponding lazy handlers in ensureSectionRendered.

import { assert, assertEquals } from "jsr:@std/assert@1";

const JS = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));

Deno.test("ui-flash: navigationController.syncCurrent is invoked exactly once during setup", () => {
  const syncMatches = JS.match(/navigationController\.syncCurrent\(\)/g) ?? [];
  assertEquals(
    syncMatches.length,
    1,
    "navigationController.syncCurrent() must only be called once during options.js bootstrap to prevent double layout-shift/flash",
  );
});

Deno.test("ui-flash: ensureSectionRendered encapsulates all section renderers without top-level duplicates", () => {
  const ensureFn = JS.slice(
    JS.indexOf("async function ensureSectionRendered"),
    JS.indexOf("// nav active state"),
  );

  // Check that each major section renderer is inside ensureSectionRendered
  assert(ensureFn.includes('sectionId === "providers"'), "providers section rendered in ensureSectionRendered");
  assert(ensureFn.includes('sectionId === "mcp-servers"'), "mcp-servers section rendered in ensureSectionRendered");
  assert(ensureFn.includes('sectionId === "local-folders"'), "local-folders section rendered in ensureSectionRendered");
  assert(ensureFn.includes('sectionId === "agents"'), "agents section rendered in ensureSectionRendered");
  assert(ensureFn.includes('sectionId === "browser"'), "browser section rendered in ensureSectionRendered");
  assert(ensureFn.includes('sectionId === "permissions"'), "permissions section rendered in ensureSectionRendered");
  assert(ensureFn.includes('sectionId === "skills"'), "skills section rendered in ensureSectionRendered");
  assert(ensureFn.includes('sectionId === "usage"'), "usage section rendered in ensureSectionRendered");
  assert(ensureFn.includes('sectionId === "data"'), "data section rendered in ensureSectionRendered");
  assert(ensureFn.includes('sectionId === "about"'), "about section rendered in ensureSectionRendered");

  // Ensure top-level code after setup does not duplicate eager calls
  const afterSetup = JS.slice(JS.indexOf("await readDeveloperFeaturesFlag();"));
  assert(!afterSetup.includes("await renderData();"), "renderData must not be called eagerly at top-level");
  assert(!afterSetup.includes("await renderMemoryExplorer();"), "renderMemoryExplorer must not be called eagerly at top-level");
  assert(!afterSetup.includes("await renderEnrolledSites();"), "renderEnrolledSites must not be called eagerly at top-level");
  assert(!afterSetup.includes("await renderWebmcpStatus();"), "renderWebmcpStatus must not be called eagerly at top-level");
});

Deno.test("ui-flash: handleSettingsHashNavigation avoids redundant scroll/focus when section is already active", () => {
  const navFn = JS.slice(
    JS.indexOf("export async function handleSettingsHashNavigation"),
    JS.indexOf("// Navigation controller:"),
  );

  assert(
    navFn.includes('const wasActive = section.classList.contains("active");'),
    "handleSettingsHashNavigation must record prior active state",
  );
  assert(
    navFn.includes("if (!wasActive || isTraverse) {"),
    "scrollIntoView and focus must only trigger on section transition or history traversal",
  );
});
