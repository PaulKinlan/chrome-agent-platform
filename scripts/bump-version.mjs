#!/usr/bin/env node

// Bump the extension version across the repo (chaos-style semantic versioning).
//
// Usage:
//   node scripts/bump-version.mjs patch   # 0.2.0 -> 0.2.1
//   node scripts/bump-version.mjs minor   # 0.2.0 -> 0.3.0
//   node scripts/bump-version.mjs major   # 0.2.0 -> 1.0.0
//   node scripts/bump-version.mjs 1.2.3   # set an explicit version
//
// Updates package.json + extension/manifest.json and prepends a CHANGELOG.md
// entry (the version header + date). The version is displayed in the Settings
// footer (options.html reads it from the manifest at load).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}
function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function bumpSemver(current, type) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(current));
  if (!m) {
    console.error(`Unparseable version: ${current}`);
    process.exit(1);
  }
  const [, major, minor, patch] = m.map(Number);
  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      if (/^\d+\.\d+\.\d+/.test(type)) return type;
      console.error(`Unknown bump type: ${type}`);
      process.exit(1);
  }
}

const bumpType = process.argv[2];
if (!bumpType) {
  console.error("Usage: node scripts/bump-version.mjs <patch|minor|major|x.y.z>");
  process.exit(1);
}

const pkgPath = join(ROOT, "package.json");
const manifestPath = join(ROOT, "extension", "manifest.json");

const currentVersion = readJson(pkgPath).version || "0.0.0";
const newVersion = bumpSemver(currentVersion, bumpType);
console.log(`Bumping: ${currentVersion} → ${newVersion}`);

// package.json
const pkg = readJson(pkgPath);
pkg.version = newVersion;
writeJson(pkgPath, pkg);
console.log(`  package.json → ${newVersion}`);

// extension/manifest.json
const manifest = readJson(manifestPath);
manifest.version = newVersion;
writeJson(manifestPath, manifest);
console.log(`  extension/manifest.json → ${newVersion}`);

// CHANGELOG.md — prepend a header entry.
const changelogPath = join(ROOT, "CHANGELOG.md");
const date = new Date().toISOString().slice(0, 10);
const header = `## [${newVersion}] — ${date}\n`;
if (existsSync(changelogPath)) {
  const existing = readFileSync(changelogPath, "utf-8");
  // Insert the new header right after the top "## Changelog" intro line, keeping
  // the latest version first.
  const lines = existing.split("\n");
  // The first line is "# Changelog"; insert after it.
  const out = [lines[0], "", header.trimEnd(), ...lines.slice(1)].join("\n");
  writeFileSync(changelogPath, out);
  console.log(`  CHANGELOG.md → prepended [${newVersion}] entry`);
} else {
  writeFileSync(changelogPath, `# Changelog\n\n${header}\n`);
  console.log(`  CHANGELOG.md → created with [${newVersion}] entry`);
}

console.log(`\nDone. Version is now ${newVersion}.`);
console.log(`Run: git add -A && git commit -m "chore: bump version to ${newVersion}"`);
