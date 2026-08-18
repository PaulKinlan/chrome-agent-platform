#!/usr/bin/env node

// Bump the version across package.json + extension/manifest.json + CHANGELOG.md.
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

// Keep package-lock.json in sync (the root version + the "" packages entry),
// otherwise every bump drifts the lockfile from the manifest (the round-
// repeated version-drift review finding).
const lockPath = join(ROOT, "package-lock.json");
if (existsSync(lockPath)) {
  const lock = readJson(lockPath);
  lock.version = next;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = next;
  writeJson(lockPath, lock);
}

// Prepend a CHANGELOG entry ONLY when we have a message (the commit message).
const changelogPath = join(ROOT, "CHANGELOG.md");
if (existsSync(changelogPath) && message) {
  const date = new Date().toISOString().slice(0, 10);
  const existing = readFileSync(changelogPath, "utf-8");
  const clean = message.replace(/^\[[^\]]*\]\s*/, "").trim();
  const entry = `\n## [${next}] — ${date}\n- ${clean}\n`;
  const updated = existing.replace(/(#[^\n]*\n)/, `$1${entry}`);
  writeFileSync(changelogPath, updated);
}

console.log(`Bumped ${current} → ${next}${message ? ` (changelog: ${message.slice(0, 60)})` : ""}`);
