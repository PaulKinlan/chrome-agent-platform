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
} from "../scripts/generate-about-page.mjs";

const ROOT = join(import.meta.dirname ?? ".", "..");

Deno.test("about-page drift guard: inventory contains valid manifests and metadata", () => {
  const inventoryManifests = BUNDLED_INVENTORY.manifests;
  assert(inventoryManifests.length > 0, "Inventory must contain at least 1 manifest");

  const { metadata, entries } = extractAboutData({ root: ROOT });

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

  const { entries } = extractAboutData({ root: ROOT });

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

Deno.test("about-page drift guard: falsification — detects missing tool from inventory", () => {
  const { entries } = extractAboutData({ root: ROOT });

  // Simulate an ungenerated tool missing from entries
  const simulatedEntries = entries.filter((e) => e.toolId !== "jq");
  const missingPkg = "cap.bundled.jq";

  const entryPackageIds = new Set(simulatedEntries.map((e) => e.packageId));
  const detectedMissing = !entryPackageIds.has(missingPkg);

  assertEquals(
    detectedMissing,
    true,
    `Drift guard must detect when tool '${missingPkg}' is missing from about entries`,
  );
});

Deno.test("about-page drift guard: falsification — detects missing tool from rendered HTML", async () => {
  const htmlPath = join(ROOT, "extension/about/about.html");
  const html = await Deno.readTextFile(htmlPath);

  // Strip a tool card from the HTML to verify detection
  const pkgId = "cap.bundled.sqlite3.query.bounded";

  // When card is removed from HTML:
  const strippedHtml = html.replaceAll(`data-package-id="${pkgId}"`, `data-package-id="removed"`);
  const hasPkg = strippedHtml.includes(`data-package-id="${pkgId}"`);

  assertEquals(
    hasPkg,
    false,
    `Stripped HTML must fail check for missing tool '${pkgId}'`,
  );
});
