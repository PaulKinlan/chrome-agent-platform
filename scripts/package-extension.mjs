// scripts/package-extension.mjs — freshness-safe production ZIP packaging.
//
//   node scripts/package-extension.mjs [out.zip]
//   node scripts/package-extension.mjs --validate-only <zip>
//
// The implementation never copies extension/ wholesale. See
// package-archive.mjs for the exact tracked + generated inventory authority,
// symlink/special-file refusals, fresh same-directory temp ZIP, exact archive
// verification and atomic replacement.

import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  collectPackageInventory,
  packageExtensionArchive,
  verifyPackageArchive,
} from "./package-archive.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const validateOnly = args[0] === "--validate-only";
if (validateOnly && (!args[1] || args.length !== 2)) {
  throw new Error(
    "usage: node scripts/package-extension.mjs --validate-only <zip>",
  );
}
if (!validateOnly && args.length > 1) {
  throw new Error("usage: node scripts/package-extension.mjs [out.zip]");
}

const manifest = JSON.parse(
  await readFile(path.join(ROOT, "extension", "manifest.json"), "utf8"),
);
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();
const archive = path.resolve(
  validateOnly ? args[1] : args[0] ??
    path.join(ROOT, "dist-archives", `cap-${manifest.version}-${sha}.zip`),
);

if (validateOnly) {
  const inventory = await collectPackageInventory({ root: ROOT });
  const result = await verifyPackageArchive({
    archive,
    expected: inventory,
    scratchParent: path.dirname(archive),
  });
  console.log(
    `validated ${archive} (${result.entries} exact entries; portable; no stale/duplicate/symlink content; sha256 ${result.sha256})`,
  );
} else {
  const result = await packageExtensionArchive({ root: ROOT, archive });
  console.log(
    `packaged ${result.archive} (${result.entries} exact tracked+generated entries; atomic fresh ZIP; portable; sha256 ${result.archiveSha256})`,
  );
}
