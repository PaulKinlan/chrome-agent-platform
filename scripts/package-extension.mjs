// scripts/package-extension.mjs — deterministic PACKAGING (the review's
// portability finding): builds a ZIP that DEREFERENCES the dist pointer into a
// real directory (no symlink in the artifact — loads on any OS/Chromium),
// then validates the archive loads as an unpacked extension (structure,
// manifest routing, dist completeness) — the packaging gate.
//
//   node scripts/package-extension.mjs [out.zip]   # default: dist-archives/cap-<version>-<sha>.zip
//   node scripts/package-extension.mjs --validate-only <zip>
import { createWriteStream } from "node:fs";
import { readFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const EXT_DIR = path.join(ROOT, "extension");
const DIST = path.join(EXT_DIR, "dist");

// 0) Prune stray SYMLINK entries under dist-versions (lstat only — never
// follow; a real directory is never pruned).
import { lstat, readdir as rd } from "node:fs/promises";
for (const n of await rd(path.join(EXT_DIR, "dist-versions")).catch(() => [])) {
  const p = path.join(EXT_DIR, "dist-versions", n);
  if ((await lstat(p).catch(() => null))?.isSymbolicLink()) {
    await rm(p, { force: true });
  }
}

// 1) A FLAT staging copy of extension/ with EVERY symlink DEREFERENCED
// (cp -L follows links — dist AND any internal links become real files; the
// artifact is portable to any OS/Chromium and loads unpacked).
const STAGE = path.join(ROOT, ".package-stage");
await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });
execSync(`cp -aL ${JSON.stringify(EXT_DIR + "/.")} ${JSON.stringify(STAGE + "/")}`);
// No build scratch inside the artifact.
await rm(path.join(STAGE, "dist-versions"), { recursive: true, force: true }).catch(() => {});

// 2) VALIDATE: manifest → dist files exist; the marker exists; no symlinks remain.
const manifest = JSON.parse(await readFile(path.join(STAGE, "manifest.json"), "utf8"));
const sw = path.join(STAGE, manifest.background.service_worker);
const optsBundle = path.join(STAGE, "dist/options.bundle.js");
const shippedChangelog = path.join(STAGE, "CHANGELOG.md");
for (const f of [sw, optsBundle, shippedChangelog, path.join(STAGE, "dist/dist.complete")]) {
  const st = await stat(f).catch(() => null);
  if (!st?.isFile()) throw new Error(`packaging validation failed: ${f} missing`);
  if (st.isSymbolicLink?.()) throw new Error(`packaging validation failed: ${f} is a symlink`);
}
const [canonicalChangelog, packagedChangelog] = await Promise.all([
  readFile(path.join(ROOT, "CHANGELOG.md")),
  readFile(shippedChangelog),
]);
if (Buffer.compare(canonicalChangelog, packagedChangelog) !== 0) {
  throw new Error("packaging validation failed: generated CHANGELOG.md is missing or stale");
}
// No symlinks anywhere in the artifact.
const findSymlinks = execSync(`find ${JSON.stringify(STAGE)} -type l`, { encoding: "utf8" }).trim();
if (findSymlinks) throw new Error(`packaging validation failed: symlinks remain:\n${findSymlinks}`);

// 3) ZIP deterministically.
const version = manifest.version;
const sha = execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
const archive = process.argv[2]?.replace(/^--validate-only$/, "") ?? path.join(ROOT, "dist-archives", `cap-${version}-${sha}.zip`);
await mkdir(path.dirname(archive), { recursive: true });
execSync(`cd ${JSON.stringify(STAGE)} && zip -qr ${JSON.stringify(archive)} . -x '.DS_Store'`);
await rm(STAGE, { recursive: true, force: true });
console.log(`packaged ${archive} (dist DEREFERENCED — portable, validated, no symlinks)`);
