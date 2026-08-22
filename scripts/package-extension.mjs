// scripts/package-extension.mjs — freshness-safe production ZIP packaging.
//
//   node scripts/package-extension.mjs [out.zip]
//   node scripts/package-extension.mjs --target=store [out.zip]
//   node scripts/package-extension.mjs --validate-only [--target=store] <zip>
//
// The implementation never copies extension/ wholesale. See
// package-archive.mjs for the exact tracked + generated inventory authority,
// symlink/special-file refusals, fresh same-directory temp ZIP, exact archive
// verification and atomic replacement. Store target checks do not transform
// package bytes or replace that primary SHA authority.

import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  collectPackageInventory,
  packageExtensionArchive,
  verifyPackageArchive,
} from "./package-archive.mjs";
import {
  assertStoreTargetBoundary,
  parsePackageArguments,
  STORE_TARGET,
} from "./store-target-policy.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const parsed = parsePackageArguments(process.argv.slice(2));
const { archivePath, target, validateOnly } = parsed;

const manifest = JSON.parse(
  await readFile(path.join(ROOT, "extension", "manifest.json"), "utf8"),
);
const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim();
const archive = path.resolve(
  archivePath ?? path.join(
    ROOT,
    "dist-archives",
    `cap-${manifest.version}-${sha}${
      target === STORE_TARGET ? "-store" : ""
    }.zip`,
  ),
);

async function inventoryForTarget() {
  const inventory = await collectPackageInventory({
    root: ROOT,
    expectedTarget: target,
  });
  if (target === STORE_TARGET) {
    await assertStoreTargetBoundary({ target, inventory });
  }
  return inventory;
}

if (validateOnly) {
  const inventory = await inventoryForTarget();
  const result = await verifyPackageArchive({
    archive,
    expected: inventory,
    scratchParent: path.dirname(archive),
  });
  console.log(
    `validated${
      target ? ` target=${target}` : ""
    } ${archive} (${result.entries} exact entries; portable; no stale/duplicate/symlink content; sha256 ${result.sha256})`,
  );
} else {
  if (target === STORE_TARGET) await inventoryForTarget();
  const result = await packageExtensionArchive({
    root: ROOT,
    archive,
    expectedTarget: target,
  });
  // Re-evaluate the Store boundary and exact archive after publication. A
  // source mutation between the pre-check and package copy cannot inherit the
  // earlier verdict or SHA.
  if (target === STORE_TARGET) {
    const postInventory = await inventoryForTarget();
    const post = await verifyPackageArchive({
      archive,
      expected: postInventory,
      scratchParent: path.dirname(archive),
    });
    if (post.sha256 !== result.archiveSha256) {
      throw new Error("store target archive SHA changed after atomic publish");
    }
  }
  console.log(
    `packaged${
      target ? ` target=${target}` : ""
    } ${result.archive} (${result.entries} exact tracked+generated entries; atomic fresh ZIP; portable; sha256 ${result.archiveSha256})`,
  );
}
