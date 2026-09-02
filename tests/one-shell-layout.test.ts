// tests/one-shell-layout.test.ts — CAP-FB-20260830-ONE-SHELL-01.
//
// Verifies:
// 1. Shared content layout tokens (--content-max and --content-gutter) in theme.css.
// 2. All view surfaces (Artifacts, Directory, Settings) adopt the shared token pair.
// 3. Embedded mode support: openView appends embedded=1 and surfaces hide duplicate headers.
// 4. Retired surfaces (chat/chat.html and memory/explorer.html) are permanently deleted.

import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("one-shell layout: shared tokens defined in theme.css", async () => {
  const theme = await Deno.readTextFile("extension/shared/theme.css");
  assert(theme.includes("--content-max: 1040px;"), "theme.css must define --content-max: 1040px");
  assert(
    theme.includes("--content-gutter: clamp(16px, 4vw, 40px);"),
    "theme.css must define --content-gutter: clamp(16px, 4vw, 40px)",
  );
});

Deno.test("one-shell layout: Artifacts view adopts shared layout and embedded rule", async () => {
  const html = await Deno.readTextFile("extension/artifacts/index.html");
  assert(html.includes("max-inline-size: var(--content-max)"), "Artifacts must use --content-max");
  assert(html.includes("padding-inline: var(--content-gutter)"), "Artifacts must use --content-gutter");
  assert(html.includes("[data-embedded] .head"), "Artifacts must hide .head under [data-embedded]");
});

Deno.test("one-shell layout: Directory view adopts shared layout and embedded rule", async () => {
  const html = await Deno.readTextFile("extension/directory/directory.html");
  assert(html.includes("max-inline-size:var(--content-max)"), "Directory must use --content-max");
  assert(html.includes("padding-inline:var(--content-gutter)"), "Directory must use --content-gutter");
  assert(html.includes("[data-embedded] #directory-title"), "Directory must hide title under [data-embedded]");
});

Deno.test("one-shell layout: Settings adopts shared layout and embedded rule", async () => {
  const html = await Deno.readTextFile("extension/options/options.html");
  assert(html.includes('class="options-shell"'), "options.html must have options-shell wrapping side and content");

  const css = await Deno.readTextFile("extension/options/options.css");
  assert(css.includes(".options-shell"), "options.css must style .options-shell");
  assert(css.includes("max-inline-size: var(--content-max);"), "options-shell must use --content-max");
  assert(css.includes("padding-inline: var(--content-gutter);"), "options-shell must use --content-gutter");
  assert(css.includes("[data-embedded] .side .brand"), "Settings must hide .brand under [data-embedded]");
  assert(css.includes("[data-embedded] .head h1"), "Settings must hide h1 under [data-embedded]");
});

Deno.test("one-shell layout: openView in ntp.js passes embedded=1 to panel views", async () => {
  const ntp = await Deno.readTextFile("extension/ntp/ntp.js");
  assert(ntp.includes("embeddedQuery"), "openView must construct embeddedQuery");
  assert(ntp.includes("embedded=1"), "openView must append embedded=1 parameter");
});

Deno.test("one-shell layout: chrome-journeys.ts carries the 3 required journey assertions in EXPECTED", async () => {
  const journeys = await Deno.readTextFile("scripts/chrome-journeys.ts");
  assert(journeys.includes('"embedded views share one content left edge at 1440"'), "1440px check in EXPECTED");
  assert(journeys.includes('"embedded views share one content left edge at 1024"'), "1024px check in EXPECTED");
  assert(journeys.includes('"embedded Artifacts view shows its name exactly once"'), "Artifacts title check in EXPECTED");

  // Verify probes target visible content edges, not unpadded wrappers
  assert(journeys.includes("frame?.contentDocument?.querySelector('.sub, .grid, .empty')"), "Artifacts probes visible content");
  assert(journeys.includes("frame?.contentDocument?.querySelector('.sub, #rows, .site-group')"), "Directory probes visible content");
  assert(journeys.includes("frame?.contentDocument?.querySelector('.side')"), "Settings probes visible content");

  // Verify title check includes both parent #view-title and iframe headings
  assert(journeys.includes("document.getElementById('view-title')"), "Title probe checks parent #view-title");
});

Deno.test("one-shell layout: RETIRED_FILES in check-vocabulary.mjs covers all deleted dead files", async () => {
  const vocab = await Deno.readTextFile("scripts/check-vocabulary.mjs");
  for (const path of [
    "extension/recipes/index.html",
    "extension/chat/chat.html",
    "extension/chat/chat.js",
    "extension/memory/explorer.html",
    "extension/memory/explorer.js",
    "extension/shared/composer.css",
  ]) {
    assert(vocab.includes(`"${path}"`), `check-vocabulary.mjs must list ${path} in RETIRED_FILES`);
  }
});

Deno.test("one-shell layout: retired surfaces do not exist", async () => {
  for (const path of [
    "extension/recipes/index.html",
    "extension/chat/chat.html",
    "extension/chat/chat.js",
    "extension/memory/explorer.html",
    "extension/memory/explorer.js",
    "extension/shared/composer.css",
  ]) {
    let exists = true;
    try {
      await Deno.stat(path);
    } catch {
      exists = false;
    }
    assertEquals(exists, false, `${path} must be deleted`);
  }
});
