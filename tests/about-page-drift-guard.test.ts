// tests/about-page-drift-guard.test.ts — drift guard for the generated About page.
//
// Invariant guarded (Paul's permanent licence policy 2026-10-06):
// Every bundled library and tool in BUNDLED_INVENTORY must be present on the
// generated About page (extension/about/about.html) with its exact tool name,
// version, SPDX licence, upstream source URL, and emitted licence/notice text.
// Adding a tool to the bundled inventory without regenerating the About page MUST fail.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "node:path";
import { BUNDLED_INVENTORY } from "../extension/lib/bundled-inventory-data.js";
import {
  extractAboutData,
  syncAboutPage,
  UPSTREAM_MAP,
} from "../scripts/generate-about-page.mjs";

const ROOT = join(import.meta.dirname ?? ".", "..");

Deno.test("about-page drift guard: inventory contains valid manifests and metadata", async () => {
  const inventoryManifests = BUNDLED_INVENTORY.manifests;
  assert(inventoryManifests.length > 0, "Inventory must contain at least 1 manifest");

  const { metadata, entries } = await extractAboutData({ root: ROOT });

  assertEquals(
    metadata.toolCount,
    inventoryManifests.length,
    `metadata.toolCount (${metadata.toolCount}) must match BUNDLED_INVENTORY manifests count (${inventoryManifests.length})`,
  );

  assertEquals(
    entries.length,
    inventoryManifests.length,
    `extracted entries length (${entries.length}) must match BUNDLED_INVENTORY manifests (${inventoryManifests.length})`,
  );

  const entryPackageIds = new Set(entries.map((e) => e.packageId));
  for (const m of inventoryManifests) {
    assert(
      entryPackageIds.has(m.pkg),
      `Bundled tool '${m.pkg}' present in BUNDLED_INVENTORY is missing from extracted about entries`,
    );
  }
});

Deno.test("about-page drift guard: every inventory tool is rendered in about.html with metadata, license, and notices", async () => {
  const htmlPath = join(ROOT, "extension/about/about.html");
  const html = await Deno.readTextFile(htmlPath);

  assert(html.includes("<!doctype html>"), "about.html must be valid HTML");
  assert(html.includes("About &amp; Third-Party Software Notices"), "about.html must carry the About heading");

  const { entries } = await extractAboutData({ root: ROOT });

  for (const entry of entries) {
    // 1. Tool card container must exist with data attributes
    assert(
      html.includes(`data-package-id="${entry.packageId}"`),
      `about.html must render card for package '${entry.packageId}'`,
    );
    assert(
      html.includes(`data-tool-id="${entry.toolId}"`),
      `about.html must render data-tool-id for '${entry.toolId}'`,
    );

    // 2. Tool version must be displayed
    assert(
      html.includes(`v${entry.version}`),
      `about.html must display version v${entry.version} for tool '${entry.toolId}'`,
    );

    // 3. SPDX license expression must be present
    assert(
      html.includes(entry.spdx),
      `about.html must display SPDX license '${entry.spdx}' for tool '${entry.toolId}'`,
    );

    // 4. Upstream source URL must be linked
    assert(
      html.includes(`href="${entry.upstreamUrl}"`),
      `about.html must link to upstream source URL '${entry.upstreamUrl}' for tool '${entry.toolId}'`,
    );

    // 5. Emitted license text must be included
    assert(entry.licenseText.length > 50, `License text for '${entry.packageId}' must not be empty`);
    const firstLicLine = entry.licenseText.trim().split("\n")[0].trim();
    assert(
      html.includes(firstLicLine.slice(0, 30)),
      `about.html must include emitted license text for '${entry.packageId}'`,
    );

    // 6. Notices text must be included if the tool has a notices file
    if (entry.noticesText) {
      assert(entry.noticesText.length > 20, `Notices text for '${entry.packageId}' must not be empty`);
      const firstNoticeLine = entry.noticesText.trim().split("\n")[0].trim();
      assert(
        html.includes(firstNoticeLine.slice(0, 30)),
        `about.html must include emitted notices text for '${entry.packageId}'`,
      );
    }
  }
});

Deno.test("about-page drift guard: syncAboutPage({ check: true }) confirms zero drift against disk", async () => {
  const inSync = await syncAboutPage({ root: ROOT, check: true });
  assertEquals(inSync, true, "About page on disk must match generator output exactly");
});

Deno.test("about-page drift guard: falsification — syncAboutPage({ check: true }) fails on drifted HTML with missing tool card", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "cap-about-drift-" });
  try {
    await Deno.mkdir(join(tmp, "extension/about"), { recursive: true });
    await Deno.symlink(join(ROOT, "extension/lib"), join(tmp, "extension/lib"));
    await Deno.symlink(join(ROOT, "extension/wasm"), join(tmp, "extension/wasm"));

    // Case 1: empty about.html must fail check
    await Deno.writeTextFile(join(tmp, "extension/about/about.html"), "");
    const emptyCheck = await syncAboutPage({ root: tmp, check: true });
    assertEquals(emptyCheck, false, "Empty about.html must fail drift check");

    // Case 2: about.html with a tool card removed must fail check
    const realHtml = await Deno.readTextFile(join(ROOT, "extension/about/about.html"));
    const mutatedHtml = realHtml.replace(
      /<article class="tool-card"[^>]*data-package-id="cap\.bundled\.jq"[\s\S]*?<\/article>/,
      "",
    );
    assert(mutatedHtml !== realHtml, "Failed to remove cap.bundled.jq card in test setup");
    await Deno.writeTextFile(join(tmp, "extension/about/about.html"), mutatedHtml);

    const driftedCheck = await syncAboutPage({ root: tmp, check: true });
    assertEquals(driftedCheck, false, "about.html missing cap.bundled.jq must fail syncAboutPage check");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("about-page drift guard: falsification — card-presence verification fails when tool card is missing from HTML", async () => {
  const htmlPath = join(ROOT, "extension/about/about.html");
  const html = await Deno.readTextFile(htmlPath);
  const pkgId = "cap.bundled.sqlite3.query.bounded";

  // Strip a tool card from the real HTML
  const strippedHtml = html.replace(
    new RegExp(`<article class="tool-card"[^>]*data-package-id="${pkgId.replaceAll(".", "\\.")}"[\\s\\S]*?</article>`),
    "",
  );
  assert(strippedHtml !== html, `Failed to strip card for ${pkgId}`);

  // The drift verification loop must detect that the card is missing
  let detected = false;
  try {
    assert(
      strippedHtml.includes(`data-package-id="${pkgId}"`),
      `about.html must render card for package '${pkgId}'`,
    );
  } catch (_e) {
    detected = true;
  }
  assertEquals(detected, true, `Verification loop must throw when package '${pkgId}' card is removed`);
});

Deno.test("about-page drift guard: all inventory manifests have explicit UPSTREAM_MAP entries and fail-closed on unknown", async () => {
  const inventoryManifests = BUNDLED_INVENTORY.manifests;
  for (const m of inventoryManifests) {
    const entry = (UPSTREAM_MAP as Record<string, { upstreamName: string; upstreamUrl: string }>)[m.pkg];
    assert(
      entry !== undefined,
      `Manifest package '${m.pkg}' must have an explicit entry in UPSTREAM_MAP`,
    );
    assert(
      entry.upstreamName && entry.upstreamName.length > 0,
      `Package '${m.pkg}' must have non-empty upstreamName`,
    );
    assert(
      entry.upstreamUrl && entry.upstreamUrl.startsWith("http"),
      `Package '${m.pkg}' must have valid upstreamUrl (got '${entry.upstreamUrl}')`,
    );
  }

  // Falsification: extractAboutData must throw (fail closed) on unknown package
  const tmp = await Deno.makeTempDir({ prefix: "cap-about-upstream-" });
  try {
    await Deno.mkdir(join(tmp, "extension/lib"), { recursive: true });
    await Deno.mkdir(join(tmp, "extension/wasm/manifests"), { recursive: true });
    await Deno.symlink(join(ROOT, "extension/wasm/licenses"), join(tmp, "extension/wasm/licenses"));
    await Deno.copyFile(
      join(ROOT, "extension/lib/bundled-tool-packages.data.js"),
      join(tmp, "extension/lib/bundled-tool-packages.data.js"),
    );

    // Create a valid manifest for a fake package that is not in UPSTREAM_MAP
    await Deno.writeTextFile(
      join(tmp, "extension/wasm/manifests/cap.bundled.fake.tool-1.0.0.manifest.json"),
      JSON.stringify({
        package: { id: "cap.bundled.fake.tool", version: "1.0.0" },
        license: { file: "extension/wasm/licenses/MIT.txt", spdx: "MIT" },
      }),
    );

    // Inventory listing the fake tool
    const fakeInv = `export const BUNDLED_INVENTORY = Object.freeze(${JSON.stringify({
      schemaVersion: 1,
      release: "0.0.0",
      manifests: [{ pkg: "cap.bundled.fake.tool", version: "1.0.0" }],
    })});\n`;
    await Deno.writeTextFile(join(tmp, "extension/lib/bundled-inventory-data.js"), fakeInv);

    let threw = false;
    try {
      await extractAboutData({ root: tmp });
    } catch (err) {
      threw = true;
      assert(String(err).includes("Missing UPSTREAM_MAP entry"), `Error message must name UPSTREAM_MAP: ${err}`);
    }
    assertEquals(threw, true, "extractAboutData must throw on package missing from UPSTREAM_MAP");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
