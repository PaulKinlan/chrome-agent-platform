// tests/options-lazy-sections-9epn9.test.ts
// Falsification tests for chrome-agent-platform-9epn.9:
// content-visibility: auto + staged progressive hydration for Settings panels and heavy lists.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { SETTINGS_SECTIONS } from "../extension/lib/pure.js";

const CSS = await Deno.readTextFile(new URL("../extension/options/options.css", import.meta.url));
const HTML = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
const JS = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));

Deno.test("9epn.9 CSS: below-the-fold panels declare content-visibility: auto and contain-intrinsic-size", () => {
  assert(
    CSS.includes("content-visibility: auto;") && CSS.includes("contain-intrinsic-size: auto 480px;"),
    "options.css must specify content-visibility: auto and contain-intrinsic-size: auto 480px for below-the-fold panels",
  );
  assert(
    CSS.includes("section:target") &&
      CSS.includes("section:focus-within") &&
      CSS.includes('section[data-active="true"]'),
    "options.css must override content-visibility for :target, :focus-within, and [data-active='true']",
  );
  assert(
    CSS.includes("content-visibility: visible;"),
    "options.css override must set content-visibility: visible for active/focused/targeted sections",
  );
});

Deno.test("9epn.9 HTML: initial #providers section declares data-active='true'", () => {
  assert(
    HTML.includes('id="providers" class="panel active" data-active="true"'),
    "options.html must declare data-active='true' on the initial active #providers section",
  );
});

Deno.test("9epn.9 deep-linking: handleSettingsHashNavigation normalizes #section-*, #section=*, and #provider variants", () => {
  assert(
    JS.includes('cleanId.startsWith("section-")') && JS.includes('cleanId.startsWith("section=")'),
    "options.js must normalize section- and section= deep-link prefixes",
  );
  assert(
    JS.includes('cleanId === "provider"'),
    "options.js must map singular #provider deep link to providers",
  );
});

Deno.test("9epn.9 hydration: options.js stages active section hydration and yields with sleep(0) before deferred lists", () => {
  assert(
    JS.includes("await navigationController.syncCurrent();"),
    "options.js must sync active section on boot",
  );
  assert(
    JS.includes("await sleep(0);"),
    "options.js must yield via await sleep(0) after active section sync before deferred hydration",
  );
  assert(
    JS.includes("s.dataset.active = s.id === sectionId ? \"true\" : \"false\""),
    "options.js handleSettingsHashNavigation must sync dataset.active to match CSS selector",
  );
  assert(
    JS.includes("hydrateBelowFoldHeavyLists"),
    "options.js must define deferred below-the-fold hydration for heavy lists",
  );
});

Deno.test("9epn.9 section rendering: renderSection covers all 15 settings sections including data and board-permissions", () => {
  const ensureBlock = JS.slice(JS.indexOf("async function ensureSectionRendered"), JS.indexOf("// nav active state"));
  for (const section of SETTINGS_SECTIONS) {
    assertStringIncludes(
      ensureBlock,
      'sectionId === "' + section + '"',
      "ensureSectionRendered must have a dedicated branch for section " + section,
    );
  }
});

Deno.test("9epn.9 DOM node queryability: all 15 section panels and critical child containers exist in options.html", () => {
  for (const sectionId of SETTINGS_SECTIONS) {
    const sectionMatch = new RegExp('<section\\s+id="' + sectionId + '"\\s+class="panel', "i").test(HTML);
    assert(sectionMatch, "options.html must contain <section id=" + sectionId + " class='panel...");
  }
  // Check heavy list containers remain queryable in DOM
  const heavyContainers = [
    "user-wasm-manager",
    "unified-agent-list",
    "background-agent-add",
    "enrolled-sites",
    "webmcp-consent-manager",
    "webmcp-status-body",
    "origin-list",
    "memory-explorer",
  ];
  for (const containerId of heavyContainers) {
    assertStringIncludes(HTML, 'id="' + containerId + '"', "DOM container #" + containerId + " must exist in options.html");
  }
});
