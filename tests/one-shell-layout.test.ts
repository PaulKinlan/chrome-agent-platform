// tests/one-shell-layout.test.ts — CAP-FB-20260830-ONE-SHELL-01.
//
// Verifies:
// 1. Shared content layout tokens (--content-max and --content-gutter) in theme.css.
// 2. All view surfaces (Artifacts, Directory, Settings) adopt the shared token pair.
// 3. Embedded mode support: embedded views self-detect (window.self !== window.top)
//    and hide duplicate headers; the hub boots them at their exact canonical URL.
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

Deno.test("z4gg: inspector is the named Artifacts full-bleed exception, not a browse-mode parity target", async () => {
  const hub = await Deno.readTextFile("extension/ntp/ntp.html");
  assert(
    /\.artifacts-view:has\(\.inspector:not\(\[hidden\]\)\)\s*\{\s*max-inline-size:\s*1680px;/.test(hub),
    "only a visible inspector may expand the browse container to 1680px",
  );
  const probe = await Deno.readTextFile("cap-evidence/z4gg-layout-probe.ts");
  assert(probe.includes("inspect.left !== 40"), "browser probe must assert inspector's full-bleed edge at both widths");
  assert(probe.includes("width === 1024 && browse.left !== inspect.left"), "narrow inspector keeps the browse gutter");
});

Deno.test("wwj5: the real-browser probe asserts Settings parity in parent viewport coordinates", async () => {
  const probe = await Deno.readTextFile(new URL("../cap-evidence/z4gg-layout-probe.ts", import.meta.url));
  assert(probe.includes("settings: settings.screenLeft"), "Settings must be compared in the parent viewport, not child-local coordinates");
  assert(probe.includes("hostWidth: directory.viewHostWidth"), "browse scrollport must be measured while Directory is visible");
  assert(probe.includes("settingsWidth: settings.docWidth"), "Settings iframe scrollport width must enter the parity formula");
  assert(probe.includes("if (!parity.settingsAccounted)"), "the browser probe must fail closed on Settings drift");
});

Deno.test("i8ii: journey parity reads the browse host only while Directory has a layout box", async () => {
  const journey = await Deno.readTextFile("scripts/chrome-journeys.ts");
  assert(journey.includes("hostWidth: directoryMetrics1440?.hostWidth ?? null"), "1440 parity must use the visible Directory width");
  assert(journey.includes("hostWidth: directoryMetrics1024?.hostWidth ?? null"), "1024 parity must use the visible Directory width");
  assert(journey.includes("contentMax: directoryMetrics1440?.contentMax ?? null"), "1440 parity must use the visible Directory token");
  assert(journey.includes("contentMax: directoryMetrics1024?.contentMax ?? null"), "1024 parity must use the visible Directory token");
  for (const width of [1440, 1024]) {
    const directoryStart = journey.indexOf(`const directoryMetrics${width} = await evalIn(cdp, ntpSession,`);
    const directoryEnd = journey.indexOf(`const dirLeft${width} = directoryMetrics${width}?.left ?? null;`, directoryStart);
    assert(directoryStart >= 0 && directoryEnd > directoryStart, `Directory must measure the browse host at ${width}`);
    const directoryMeasure = journey.slice(directoryStart, directoryEnd);
    assert(directoryMeasure.includes("!host.hidden && host.getClientRects().length > 0"), `host must have a visible layout box at ${width}`);
    assert(directoryMeasure.includes("hostWidth: measurable ? host.clientWidth : null"), `the ${width} browse scrollport must fail closed if hidden`);
    const settingsStart = journey.indexOf(`const settingsMetrics${width} = await evalIn(cdp, ntpSession,`);
    const settingsEnd = journey.indexOf(`const settingsLeft${width} =`, settingsStart);
    assert(settingsStart >= 0 && settingsEnd > settingsStart, `Settings must be measured at ${width}`);
    assert(!journey.slice(settingsStart, settingsEnd).includes("view-client-host"), `Settings must not read the hidden host at ${width}`);
    assert(width === 1440 ? directoryEnd < settingsStart : settingsEnd < directoryStart,
      `the ${width} browse width must be measured while Directory, not Settings, is open`);
  }
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

Deno.test("one-shell layout: openView boots panel views at their exact canonical URL (no embedded=1 query)", async () => {
  const ntp = await Deno.readTextFile("extension/ntp/ntp.js");
  // P0 pek9 (2026-09-02): ?embedded=1 used to be appended as an embeddedness
  // marker, but Chrome reports a frame's COMMITTED url (query included) as
  // sender.url on runtime messages — the real Settings document lost its
  // owner-options principal and every owner route refused. Embeddedness
  // self-detects in the child (window.self !== window.top), so openView must
  // boot the frame at the exact canonical URL and strip any legacy marker.
  assert(
    ntp.includes('const frameUrl = chrome.runtime.getURL(String(path ?? ""))'),
    "openView must boot the frame at the canonical path with no query appended",
  );
  assert(!ntp.includes("embeddedQuery"), "openView must not construct an embedded query");
  assert(ntp.includes('p !== "embedded=1"'), "openView must strip legacy embedded=1 markers from stored routes");
});

Deno.test("one-shell layout: chrome-journeys.ts checks current browse routes, not the retired Artifacts/Directory iframe", async () => {
  const journeys = await Deno.readTextFile("scripts/chrome-journeys.ts");
  for (const name of [
    "in-page browse views share one content left edge at 1440",
    "Settings iframe offset matches its scrollport at 1440",
    "in-page browse views share one content left edge at 1024",
    "Settings iframe offset matches its scrollport at 1024",
    "embedded Artifacts view shows its name exactly once",
  ]) {
    assert(journeys.includes(`"${name}"`), `${name} must be in EXPECTED and checked`);
  }

  // Verify probes target rendered content edges, not unpadded wrappers or the
  // obsolete iframe fallback (which hid Stage 2's in-page layout regression).
  assert(journeys.includes("document.querySelector('#artifacts-view .sub, #artifacts-view .grid, #artifacts-view .empty')"), "Artifacts probes in-page content");
  assert(journeys.includes("document.querySelector('#directory-view .sub, #directory-view .site-group, #directory-rows')"), "Directory probes in-page content");
  assert(!journeys.includes('iframe[data-panel-path="artifacts/index.html"]'), "Artifacts must not fall back to the retired iframe");
  assert(!journeys.includes('iframe[data-panel-path="directory/directory.html"]'), "Directory must not fall back to the retired iframe");
  assert(journeys.includes("frame?.contentDocument?.querySelector('.side')"), "Settings probes visible iframe content");
  assert(journeys.includes("frame?.contentDocument?.documentElement.clientWidth"), "Settings measures its own scrollport");

  // Verify title check includes both parent #view-title and iframe headings with rendered visibility
  assert(journeys.includes("document.getElementById('view-title')"), "Title probe checks parent #view-title");
  assert(journeys.includes("isRendered"), "Title probe checks rendered visibility");
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
