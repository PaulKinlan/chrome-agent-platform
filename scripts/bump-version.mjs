#!/usr/bin/env node

// Bump the version across package.json + package-lock.json + extension/manifest.json + CHANGELOG.md.
// Chaos-extension-style (adapted from ~/chaos/scripts/bump-version.mjs).
//
// Usage:
//   node scripts/bump-version.mjs patch                   # 0.2.0 -> 0.2.1
//   node scripts/bump-version.mjs minor                   # 0.2.0 -> 0.3.0
//   node scripts/bump-version.mjs major                   # 0.2.0 -> 1.0.0
//   node scripts/bump-version.mjs 1.2.3                   # set explicit version
//   node scripts/bump-version.mjs patch --message "..."   # use the commit message as the changelog entry
//
// The changelog entry is derived from --message (the commit message). No message
// → no placeholder entry is written (the version is still bumped).

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = new URL("..", import.meta.url).pathname;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}
function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}
function bumpSemver(current, type) {
  const [major, minor, patch] = current.split(".").map(Number);
  switch (type) {
    case "major": return `${major + 1}.0.0`;
    case "minor": return `${major}.${minor + 1}.0`;
    case "patch": return `${major}.${minor}.${patch + 1}`;
    default:
      if (/^\d+\.\d+\.\d+/.test(type)) return type;
      console.error(`Unknown bump type: ${type}`);
      process.exit(1);
  }
}

// Parse argv: the bump type is the first non-flag arg; --message/-m takes the next value.
const argv = process.argv.slice(2);
const type = argv.find((a) => !a.startsWith("-")) || "patch";
const mi = argv.findIndex((a) => a === "--message" || a === "-m");
const message = mi >= 0 ? argv[mi + 1] : null;
const uni = argv.findIndex((a) => a === "--user-note" || a === "--note");
const userNote = uni >= 0 ? argv[uni + 1] : null;
const finalNote = userNote ? userNote.trim() : (message ? message.replace(/^\[[^\]]*\]\s*/, "").trim() : null);

const pkgPath = join(ROOT, "package.json");
const lockPath = join(ROOT, "package-lock.json");
const manifestPath = join(ROOT, "extension", "manifest.json");
const pkg = readJson(pkgPath);
const lock = existsSync(lockPath) ? readJson(lockPath) : null;
const manifest = readJson(manifestPath);
const current = manifest.version || pkg.version;
const next = bumpSemver(current, type);

pkg.version = next;
if (lock) {
  lock.version = next;
  if (lock.packages?.[""]) lock.packages[""].version = next;
}
manifest.version = next;
manifest.version_name = next;
writeJson(pkgPath, pkg);
if (lock) writeJson(lockPath, lock);
writeJson(manifestPath, manifest);

// Keep package-lock.json in lockstep (the final review's MEDIUM): the root
// version + the root packages[""].version entry must match, or release
// metadata is inconsistent. (Single lockPath declaration — the static review's
// finding 3; the earlier lock object already syncs, this block stamps version.)
if (lock) {
  lock.version = next;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = next;
  writeJson(lockPath, lock);
}

// Prepend a CHANGELOG entry ONLY when we have a user note or commit message.
const changelogPath = join(ROOT, "CHANGELOG.md");
if (existsSync(changelogPath) && finalNote) {
  const date = new Date().toISOString().slice(0, 10);
  const existing = readFileSync(changelogPath, "utf-8");
  // Release notes are for the person using the extension, not the VCS: strip
  // conventional-commit prefixes, bare SHAs and CAP-FB tracker ids so the
  // automated plain-language check (tests/changelog.test.ts) keeps passing no
  // matter what the commit subject said (CAP-FB-20260830-SETTINGS-WHATS-NEW-COPY-01 follow-through).
  const sanitizeEntry = (note) => String(note)
    .replace(/^(merge|chore|fix(?:\([^)]*\))?|test|ci|docs|tasks|feat|refactor)\s*:\s*/i, "")
    .replace(/\(\s*[0-9a-f]{7,40}\s*\)/gi, "")
    .replace(/\bCAP-FB-\d{8}-[A-Z0-9-]+\b/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const cleanNote = sanitizeEntry(finalNote) || "Maintenance and fixes.";
  const entry = `\n## [${next}] — ${date}\n- ${cleanNote}\n`;
  const updated = existing.replace(/(#[^\n]*\n)/, `$1${entry}`);
  writeFileSync(changelogPath, updated);
}

// Keep the bundled-tool inventory's top-level `release` field in lockstep with the
// version (CAP-FB-20260825-INVENTORY-DRIFT-01). The generator derives `release` from
// package.json (scripts/build-bundled-tool-packages.mjs) and
// tests/bundled-tool-packages.test.ts asserts inventory.release === manifest.version.
// Without this, every post-commit version bump drifts the committed inventory and
// `npm run build` fails closed on the bundled-tool verify gate. The top-level
// `"release"` key is unique (per-package manifests use "version", SBOM refs use "rel"),
// so a targeted patch is byte-equivalent to a full regeneration for a version-only bump.
const inventoryPath = join(ROOT, "extension", "lib", "bundled-inventory-data.js");
if (existsSync(inventoryPath)) {
  const inv = readFileSync(inventoryPath, "utf-8");
  const updatedInv = inv.replace(/^(\s*)"release": "[^"]*",/m, `$1"release": "${next}",`);
  if (updatedInv !== inv) {
    writeFileSync(inventoryPath, updatedInv);
    // Stage it so the post-commit hook's `git commit --amend` bundles the resynced
    // inventory (the hook's explicit `git add` list does not include it). Best-effort.
    try {
      execSync("git add extension/lib/bundled-inventory-data.js", { cwd: ROOT, stdio: "ignore" });
    } catch { /* not a git repo / git unavailable — the file is still written */ }
  }
}

// Keep the bundled changelog in lockstep + VERIFY (the review's MEDIUM: the
// bump must not leave the bundle stale).
const { syncChangelog } = await import("./sync-changelog.mjs");
await syncChangelog({ check: false });
await syncChangelog({ check: true }); // verify — throws (nonzero) on drift

console.log(`Bumped ${current} → ${next}${message ? ` (changelog: ${message.slice(0, 60)})` : ""}`);
