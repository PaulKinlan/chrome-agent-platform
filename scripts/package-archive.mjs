// Exact-inventory, freshness-safe extension archive builder.
//
// Authority is deliberately narrow:
//   1. Git's tracked extension/ index inventory (regular 100644/100755 only),
//   2. the current generated dist tree (the canonical dist pointer is the only
//      input symlink which may be dereferenced), and
//   3. the ignored generated extension/CHANGELOG.md after byte equality with
//      the tracked root CHANGELOG.md.
//
// Nothing else under extension/ is enumerated or copied. In particular,
// ignored/untracked local bundles can never enter the archive.

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  utimes,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { validateDistCompleteMarker } from "./dist-complete.mjs";

const execFileAsync = promisify(execFile);
const TRACKED_MODES = new Set(["100644", "100755"]);
const GENERATED_CHANGELOG = "CHANGELOG.md";
const GENERATED_DIST = "dist";
const RESERVED_GENERATED = new Set([
  GENERATED_CHANGELOG,
  GENERATED_DIST,
  "dist-versions",
]);

function packageError(message) {
  return new Error(`packaging validation failed: ${message}`);
}

function archivePathSafe(value) {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 1024 ||
    value.startsWith("/") || value.startsWith("-") || value.includes("\\") ||
    /[\0-\x1f\x7f]/u.test(value)
  ) return false;
  const parts = value.split("/");
  return parts.every((part) => part && part !== "." && part !== "..");
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function sha256File(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function trackedExtensionIndex(root) {
  const raw = execFileSync(
    "git",
    ["ls-files", "--stage", "-z", "--", "extension"],
    { cwd: root, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  const rows = raw.toString("utf8").split("\0").filter(Boolean);
  return rows.map((row) => {
    const match = row.match(/^(\d{6}) ([0-9a-f]{40,64}) (\d)\t(.+)$/u);
    if (!match) throw packageError("malformed git extension inventory");
    const [, mode, objectId, stage, repoPath] = match;
    if (stage !== "0") throw packageError(`unmerged index entry: ${repoPath}`);
    if (!repoPath.startsWith("extension/")) {
      throw packageError(`inventory escaped extension/: ${repoPath}`);
    }
    const archivePath = repoPath.slice("extension/".length);
    if (!archivePathSafe(archivePath)) {
      throw packageError(`non-portable tracked path: ${repoPath}`);
    }
    if (!TRACKED_MODES.has(mode)) {
      throw packageError(`tracked symlink/special mode ${mode}: ${repoPath}`);
    }
    if (RESERVED_GENERATED.has(archivePath.split("/")[0])) {
      throw packageError(
        `tracked file collides with generated authority: ${repoPath}`,
      );
    }
    return { mode, objectId, repoPath, archivePath };
  });
}

async function assertRegularInput(file, label) {
  const info = await lstat(file).catch(() => null);
  if (!info) throw packageError(`${label} is missing`);
  if (info.isSymbolicLink()) throw packageError(`${label} is a symlink`);
  if (!info.isFile()) throw packageError(`${label} is not a regular file`);
  return info;
}

async function walkRegularFiles(root, prefix = "", output = []) {
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!archivePathSafe(relative)) {
      throw packageError(`non-portable generated path: ${relative}`);
    }
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      throw packageError(`generated symlink rejected: ${relative}`);
    }
    if (info.isDirectory()) await walkRegularFiles(file, relative, output);
    else if (info.isFile()) {
      output.push({
        sourcePath: file,
        archivePath: relative,
        mode: info.mode & 0o777,
      });
    } else throw packageError(`generated special file rejected: ${relative}`);
  }
  return output;
}

async function resolveDist(extDir) {
  const distPath = path.join(extDir, GENERATED_DIST);
  const info = await lstat(distPath).catch(() => null);
  if (!info) {
    throw packageError(
      "generated dist is missing; run the production build first",
    );
  }
  if (info.isDirectory()) return distPath;
  if (!info.isSymbolicLink()) {
    throw packageError(
      "generated dist is not a directory or canonical pointer",
    );
  }
  const resolved = await realpath(distPath);
  const versions = path.join(extDir, "dist-versions");
  const versionsInfo = await lstat(versions).catch(() => null);
  if (!versionsInfo?.isDirectory() || versionsInfo.isSymbolicLink()) {
    throw packageError("dist pointer has no regular dist-versions authority");
  }
  const versionsReal = await realpath(versions);
  if (!inside(versionsReal, resolved) || resolved === versionsReal) {
    throw packageError("dist pointer escapes dist-versions authority");
  }
  const resolvedInfo = await lstat(resolved);
  if (!resolvedInfo.isDirectory() || resolvedInfo.isSymbolicLink()) {
    throw packageError("dist pointer target is not a regular directory");
  }
  return resolved;
}

export async function collectPackageInventory({
  root,
  expectedTarget = "store",
}) {
  root = path.resolve(root);
  const extDir = path.join(root, "extension");
  const extInfo = await lstat(extDir).catch(() => null);
  if (!extInfo?.isDirectory() || extInfo.isSymbolicLink()) {
    throw packageError("extension root is not a regular directory");
  }

  const entries = [];
  for (const tracked of trackedExtensionIndex(root)) {
    const sourcePath = path.join(root, tracked.repoPath);
    await assertRegularInput(sourcePath, tracked.repoPath);
    entries.push({
      sourcePath,
      archivePath: tracked.archivePath,
      mode: tracked.mode === "100755" ? 0o755 : 0o644,
      source: "tracked",
      sha256: await sha256File(sourcePath),
    });
  }

  const canonicalChangelog = path.join(root, "CHANGELOG.md");
  const shippedChangelog = path.join(extDir, GENERATED_CHANGELOG);
  await assertRegularInput(canonicalChangelog, "canonical CHANGELOG.md");
  await assertRegularInput(
    shippedChangelog,
    "generated extension/CHANGELOG.md",
  );
  const [canonicalBytes, shippedBytes] = await Promise.all([
    readFile(canonicalChangelog),
    readFile(shippedChangelog),
  ]);
  if (!canonicalBytes.equals(shippedBytes)) {
    throw packageError("generated extension/CHANGELOG.md is missing or stale");
  }
  entries.push({
    sourcePath: shippedChangelog,
    archivePath: GENERATED_CHANGELOG,
    mode: 0o644,
    source: "generated-changelog",
    sha256: createHash("sha256").update(shippedBytes).digest("hex"),
  });

  const distRoot = await resolveDist(extDir);
  // The marker is executable authority, not a presence bit: it must bind the
  // current commit, indexed source bytes and both generated bundle hashes.
  // Legacy owner/timestamp markers and stale copied markers fail closed.
  const marker = await validateDistCompleteMarker({
    root,
    distRoot,
    expectedTarget,
  });
  for (const generated of await walkRegularFiles(distRoot)) {
    const archivePath = `${GENERATED_DIST}/${generated.archivePath}`;
    entries.push({
      ...generated,
      archivePath,
      source: "generated-dist",
      sha256: await sha256File(generated.sourcePath),
    });
  }

  const byPath = new Map();
  for (const entry of entries) {
    if (byPath.has(entry.archivePath)) {
      throw packageError(`duplicate inventory path: ${entry.archivePath}`);
    }
    byPath.set(entry.archivePath, entry);
  }
  for (const output of marker.outputs) {
    const entry = byPath.get(`${GENERATED_DIST}/${output.path}`);
    if (!entry || entry.sha256 !== output.sha256) {
      throw packageError(
        `dist.complete output binding mismatch: ${output.path}`,
      );
    }
  }
  // Revalidate after inventory hashing. copyInventoryToStage subsequently
  // compares every copied byte with this inventory, closing the remaining
  // read/copy race without weakening fresh-archive atomicity.
  await validateDistCompleteMarker({ root, distRoot, expectedTarget });

  const manifestEntry = byPath.get("manifest.json");
  if (!manifestEntry) {
    throw packageError("required package file missing: manifest.json");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestEntry.sourcePath, "utf8"));
  } catch {
    throw packageError("manifest.json is not valid JSON");
  }
  const serviceWorker = manifest?.background?.service_worker;
  if (
    manifest?.manifest_version !== 3 || !archivePathSafe(serviceWorker) ||
    !serviceWorker.startsWith("dist/")
  ) {
    throw packageError(
      "manifest service-worker route is not a safe generated dist path",
    );
  }
  for (
    const required of [
      serviceWorker,
      "dist/options.bundle.js",
      "dist/dist.complete",
      GENERATED_CHANGELOG,
    ]
  ) {
    if (!byPath.has(required)) {
      throw packageError(`required package file missing: ${required}`);
    }
  }
  return [...byPath.values()].sort((a, b) =>
    a.archivePath.localeCompare(b.archivePath, "en")
  );
}

async function inventoryDirectory(root) {
  const rows = await walkRegularFiles(root);
  return await Promise.all(rows.map(async (row) => ({
    ...row,
    sha256: await sha256File(row.sourcePath),
  })));
}

function compareInventory(actual, expected, label) {
  const actualMap = new Map(actual.map((entry) => [entry.archivePath, entry]));
  if (actualMap.size !== actual.length) {
    throw packageError(`${label} contains duplicate paths`);
  }
  if (actual.length !== expected.length) {
    throw packageError(
      `${label} inventory count ${actual.length} != expected ${expected.length}`,
    );
  }
  for (const wanted of expected) {
    const found = actualMap.get(wanted.archivePath);
    if (!found) throw packageError(`${label} missing ${wanted.archivePath}`);
    if (found.sha256 !== wanted.sha256) {
      throw packageError(
        `${label} content hash mismatch: ${wanted.archivePath}`,
      );
    }
  }
}

async function copyInventoryToStage(entries, stage, epochSeconds) {
  for (const entry of entries) {
    const destination = path.join(stage, ...entry.archivePath.split("/"));
    if (!inside(stage, destination)) {
      throw packageError(`stage path escape: ${entry.archivePath}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(
      entry.sourcePath,
      destination,
      fsConstants.COPYFILE_EXCL,
    );
    await chmod(destination, entry.mode);
    const time = new Date(epochSeconds * 1000);
    await utimes(destination, time, time);
  }
  compareInventory(await inventoryDirectory(stage), entries, "staging tree");
}

async function runZipToFile(
  {
    stage,
    entries,
    tempArchive,
    zipCommand = "zip",
    onTempCreated = () => {},
  },
) {
  const handle = await open(tempArchive, "wx", 0o644);
  // The caller may clean only a temp it knows this invocation created. If the
  // O_EXCL open above collided, this callback never runs and the pre-existing
  // path is never removed.
  onTempCreated();
  let stderr = "";
  try {
    const child = spawn(zipCommand, ["-q", "-X", "-@", "-"], {
      cwd: stage,
      stdio: ["pipe", handle.fd, "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TZ: "UTC" },
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let stdinError = null;
    // A failed zipper can close stdin before the bounded inventory is written.
    // Capture EPIPE as part of that child failure instead of leaving a dangling
    // unhandled stream event after the caller's cleanup has completed.
    child.stdin.on("error", (error) => {
      stdinError = error;
    });
    child.stdin.end(
      `${entries.map((entry) => entry.archivePath).join("\n")}\n`,
    );
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) throw packageError(`zip exited ${code}: ${stderr.trim()}`);
    if (stdinError) {
      throw packageError(`zip stdin failed: ${stdinError.message}`);
    }
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function verifyPackageArchive(
  { archive, expected, scratchParent },
) {
  const archiveInfo = await lstat(archive).catch(() => null);
  if (!archiveInfo?.isFile() || archiveInfo.isSymbolicLink()) {
    throw packageError("ZIP is missing, special, or a symlink");
  }
  const { stdout } = await execFileAsync("unzip", ["-Z1", archive], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const names = stdout.split(/\r?\n/u).filter(Boolean);
  if (new Set(names).size !== names.length) {
    throw packageError("ZIP contains duplicate entries");
  }
  if (names.some((name) => !archivePathSafe(name))) {
    throw packageError("ZIP contains a non-portable entry");
  }
  const expectedNames = expected.map((entry) => entry.archivePath);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw packageError("ZIP inventory differs from exact staged inventory");
  }

  const extract = await mkdtemp(
    path.join(scratchParent, ".cap-package-verify-"),
  );
  try {
    await execFileAsync("unzip", ["-q", archive, "-d", extract], {
      maxBuffer: 16 * 1024 * 1024,
    });
    compareInventory(
      await inventoryDirectory(extract),
      expected,
      "extracted ZIP",
    );
  } finally {
    await rm(extract, { recursive: true, force: true });
  }
  return { entries: names.length, sha256: await sha256File(archive) };
}

async function commitEpoch(root) {
  const value = execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw packageError("invalid Git commit timestamp");
  }
  return parsed;
}

export async function packageExtensionArchive(
  { root, archive, zipCommand = "zip", expectedTarget = "store" },
) {
  root = path.resolve(root);
  archive = path.resolve(archive);
  const outputDir = path.dirname(archive);
  await mkdir(outputDir, { recursive: true });
  const outputDirInfo = await lstat(outputDir);
  if (!outputDirInfo.isDirectory() || outputDirInfo.isSymbolicLink()) {
    throw packageError("archive output parent is not a regular directory");
  }
  const existing = await lstat(archive).catch(() => null);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw packageError("existing final archive is special or a symlink");
  }

  const inventory = await collectPackageInventory({ root, expectedTarget });
  const stage = await mkdtemp(path.join(outputDir, ".cap-package-stage-"));
  const tempArchive = path.join(
    outputDir,
    `.${path.basename(archive)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let published = false;
  let tempOwned = false;
  try {
    await copyInventoryToStage(inventory, stage, await commitEpoch(root));
    await runZipToFile({
      stage,
      entries: inventory,
      tempArchive,
      zipCommand,
      onTempCreated: () => {
        tempOwned = true;
      },
    });
    const verified = await verifyPackageArchive({
      archive: tempArchive,
      expected: inventory,
      scratchParent: outputDir,
    });
    await rename(tempArchive, archive); // atomic replacement on the same filesystem
    published = true;
    const finalHash = await sha256File(archive);
    if (finalHash !== verified.sha256) {
      throw packageError("archive hash changed during atomic publish");
    }
    const directory = await open(outputDir, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return {
      archive,
      archiveSha256: finalHash,
      entries: inventory.length,
      inventory: inventory.map(({ archivePath, sha256, source }) => ({
        archivePath,
        sha256,
        source,
      })),
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (!published && tempOwned) await rm(tempArchive, { force: true });
  }
}
