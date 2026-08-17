#!/usr/bin/env node

// Bump the version across package.json + extension/manifest.json + CHANGELOG.md.
// Chaos-extension-style (adapted from ~/chaos/scripts/bump-version.mjs).
//
// Usage:
//   node scripts/bump-version.mjs patch   # 0.2.0 -> 0.2.1
//   node scripts/bump-version.mjs minor   # 0.2.0 -> 0.3.0
//   node scripts/bump-version.mjs major   # 0.2.0 -> 1.0.0
//   node scripts/bump-version.mjs 1.2.3   # set explicit version

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

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

const type = process.argv[2] || "patch";
const pkgPath = join(ROOT, "package.json");
const manifestPath = join(ROOT, "extension", "manifest.json");
const pkg = readJson(pkgPath);
const manifest = readJson(manifestPath);
const current = manifest.version || pkg.version;
const next = bumpSemver(current, type);

pkg.version = next;
manifest.version = next;
manifest.version_name = next;
writeJson(pkgPath, pkg);
writeJson(manifestPath, manifest);

// Prepend a CHANGELOG entry.
const changelogPath = join(ROOT, "CHANGELOG.md");
if (existsSync(changelogPath)) {
  const date = new Date().toISOString().slice(0, 10);
  const existing = readFileSync(changelogPath, "utf-8");
  const entry = `\n## [${next}] — ${date}\n- (describe the change)\n`;
  const updated = existing.replace(/(#[^\n]*\n)/, `$1${entry}`);
  writeFileSync(changelogPath, updated);
}

console.log(`Bumped ${current} → ${next}`);
