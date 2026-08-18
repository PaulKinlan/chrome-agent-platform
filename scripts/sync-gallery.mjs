// scripts/sync-gallery.mjs — sync the design-system source into the GitHub
// Pages showcase (docs/). The SINGLE source of truth is extension/shared/;
// docs/components.js and docs/theme.css are generated deploy copies so the
// gallery (served from docs/) can never drift from the canonical components.
//
//   node scripts/sync-gallery.mjs          → copy the canonical files into docs/
//   node scripts/sync-gallery.mjs --check  → verify no drift (exit 1 on drift)
//
// Wired into `npm run build` (build.mjs) so every build re-syncs, and into
// `npm run check:gallery` + the component-gallery smoke test as a drift guard.

import { readFile, copyFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// src (canonical) → dst (generated deploy copy), both relative to the repo root.
const FILES = [
  ["extension/shared/components.js", "docs/components.js"],
  ["extension/shared/theme.css", "docs/theme.css"],
  ["extension/shared/agent-candidates.js", "docs/agent-candidates.js"],
  ["extension/shared/tool-tree.js", "docs/tool-tree.js"],
];

export async function syncGallery({ check = false } = {}) {
  let drifted = false;
  for (const [src, dst] of FILES) {
    const srcUrl = new URL(`../${src}`, import.meta.url);
    const dstUrl = new URL(`../${dst}`, import.meta.url);
    if (check) {
      const [a, b] = await Promise.all([readFile(srcUrl), readFile(dstUrl)]);
      if (a.length !== b.length || Buffer.compare(a, b) !== 0) {
        drifted = true;
        console.error(
          `DRIFT: ${dst} differs from ${src} — run \`npm run sync:gallery\` (single source of truth is ${src}).`
        );
      }
    } else {
      await copyFile(srcUrl, dstUrl);
      console.log(`synced ${dst} ← ${src}`);
    }
  }
  return !drifted;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const check = process.argv.includes("--check");
  const ok = await syncGallery({ check });
  process.exit(ok ? 0 : 1);
}
