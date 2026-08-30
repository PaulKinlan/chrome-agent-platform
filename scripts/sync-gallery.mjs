// scripts/sync-gallery.mjs — sync the design-system source into the GitHub
// Pages showcase (docs/). The SINGLE source of truth is extension/shared/;
// docs/components.js and docs/theme.css are generated deploy copies so the
// gallery (served from docs/) can never drift from the canonical components.
//
//   node scripts/sync-gallery.mjs          → copy the canonical files (gallery + the bundled changelog)
//   node scripts/sync-gallery.mjs --check  → verify no drift (exit 1 on drift)
//
// Run as a SEPARATE deterministic pre-commit step (npm run sync:gallery) —
// NOT wired into the build. The CHANGELOG has its own gate
// (scripts/sync-changelog.mjs).

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// src (canonical) → dst (generated deploy copy), both relative to the repo root.
const FILES = [
  ["extension/shared/components.js", "docs/components.js"],
  ["extension/shared/theme.css", "docs/theme.css"],
  ["extension/shared/agent-candidates.js", "docs/agent-candidates.js"],
  ["extension/shared/agent-registry.js", "docs/agent-registry.js"],
  ["extension/shared/command-parser.js", "docs/command-parser.js"],
  ["extension/shared/composer-commands.js", "docs/composer-commands.js"],
  ["extension/shared/run-status.js", "docs/run-status.js"],
  // The thread view's pure rules (components.js + run-status.js import it).
  ["extension/shared/thread-view.js", "docs/thread-view.js"],
  ["extension/shared/tool-tree.js", "docs/tool-tree.js"],
  // The canonical secret matcher (tool-tree.js imports it — the gallery must resolve it).
  ["extension/lib/pure.js", "docs/pure.js"],
  // The human tool-summary renderer (components.js imports it).
  ["extension/lib/tool-summary.js", "docs/tool-summary.js"],
  // Attachment classification/encoding used by the composer's /files flow.
  ["extension/lib/attachments.js", "docs/attachments.js"],
];

export async function syncGallery({ check = false } = {}) {
  let drifted = false;
  for (const [src, dst] of FILES) {
    const srcUrl = new URL(`../${src}`, import.meta.url);
    const dstUrl = new URL(`../${dst}`, import.meta.url);
    let expected = await readFile(srcUrl);
    // The gallery sits one directory shallower than extension/shared/, so the
    // tool-tree import must resolve to the synced docs copy. Apply the same
    // deterministic transform in write and check modes so drift checks compare
    // against the generated artifact rather than the untransformed source.
    if (dst === "docs/tool-tree.js") {
      expected = Buffer.from(expected.toString("utf8").replace('../lib/pure.js', './pure.js'));
    }
    if (dst === "docs/components.js") {
      expected = Buffer.from(expected.toString("utf8").replace('../lib/tool-summary.js', './tool-summary.js'));
      expected = Buffer.from(expected.toString("utf8").replace('../lib/attachments.js', './attachments.js'));
      expected = Buffer.from(expected.toString("utf8").replace('../lib/pure.js', './pure.js'));
    }
    if (dst === "docs/tool-summary.js") {
      expected = Buffer.from(expected.toString("utf8").replace('../lib/pure.js', './pure.js'));
    }
    if (check) {
      const actual = await readFile(dstUrl);
      if (expected.length !== actual.length || Buffer.compare(expected, actual) !== 0) {
        drifted = true;
        console.error(
          `DRIFT: ${dst} differs from ${src} — run \`npm run sync:gallery\` (single source of truth is ${src}).`
        );
      }
    } else {
      await writeFile(dstUrl, expected);
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
