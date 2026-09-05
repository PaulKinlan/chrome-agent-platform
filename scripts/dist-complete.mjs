// Deterministic, verifiable authority for extension/dist/dist.complete.
//
// The build lock and version-directory names remain per-invocation custody.
// Those random/temporal values must never enter production package bytes.
// Instead this marker binds one Git commit, the current bytes of every indexed
// source file, and the exact generated bundle bytes.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const DIST_COMPLETE_SCHEMA = "cap-dist-complete-v2";
export const LEGACY_DIST_COMPLETE_SCHEMA = "cap-dist-complete-v1";
export const DIST_COMPLETE_TARGETS = Object.freeze([
  "store",
  "developer",
  "enterprise",
]);
export const DIST_COMPLETE_OUTPUTS = Object.freeze([
  "background/service-worker.js",
  "options.bundle.js",
]);
export const INDEXED_SOURCE_EXCLUDED_PATHS = Object.freeze(new Set([
  "docs/diff-core.bundle.js",
]));

const SHA256_RE = /^[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40,64}$/u;
const INDEX_MODES = new Set(["100644", "100755", "120000"]);
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_FILES = 10_000;
const MAX_SOURCE_PATH_BYTES = 1_024;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_MARKER_BYTES = 4_096;

function markerError(message) {
  return new Error(`dist.complete validation failed: ${message}`);
}

function canonicalJson(value) {
  return `${JSON.stringify(value)}\n`;
}

function exactObject(value, keys) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}

function safeRepoPath(value) {
  if (
    typeof value !== "string" || value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_SOURCE_PATH_BYTES ||
    value.startsWith("/") || value.includes("\\")
  ) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return value.split("/").every((part) =>
    part && part !== "." && part !== ".."
  );
}

function hashRecord(hash, label, bytes) {
  const labelBytes = Buffer.from(label, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(labelBytes);
  hash.update(Buffer.from([0]));
  hash.update(length);
  hash.update(bytes);
}

function gitCommit(root) {
  const value = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024,
  }).trim();
  if (!COMMIT_RE.test(value)) throw markerError("invalid Git commit identity");
  return value;
}

function indexedRows(root) {
  const raw = execFileSync(
    "git",
    ["ls-files", "--stage", "-z"],
    { cwd: root, encoding: "buffer", maxBuffer: MAX_INDEX_BYTES },
  );
  const rows = raw.toString("utf8").split("\0").filter(Boolean).map((row) => {
    const match = row.match(/^(\d{6}) ([0-9a-f]{40,64}) (\d)\t(.+)$/u);
    if (!match) throw markerError("malformed Git index inventory");
    const [, mode, , stage, repoPath] = match;
    if (stage !== "0") throw markerError(`unmerged source input: ${repoPath}`);
    if (!INDEX_MODES.has(mode)) {
      throw markerError(`unsupported indexed source mode ${mode}: ${repoPath}`);
    }
    if (!safeRepoPath(repoPath)) {
      throw markerError(`non-portable indexed source path: ${repoPath}`);
    }
    return { mode, repoPath };
  }).filter((row) => !INDEXED_SOURCE_EXCLUDED_PATHS.has(row.repoPath));
  rows.sort((a, b) =>
    Buffer.compare(
      Buffer.from(a.repoPath, "utf8"),
      Buffer.from(b.repoPath, "utf8"),
    )
  );
  if (rows.length === 0 || rows.length > MAX_SOURCE_FILES) {
    throw markerError("indexed source file count is outside bounds");
  }
  return rows;
}

export async function computeIndexedSourceAuthority({ root }) {
  root = path.resolve(root);
  const hash = createHash("sha256");
  let totalBytes = 0;
  const rows = indexedRows(root);
  for (const row of rows) {
    const file = path.join(root, ...row.repoPath.split("/"));
    const info = await lstat(file).catch(() => null);
    if (!info) throw markerError(`indexed source is missing: ${row.repoPath}`);
    let bytes;
    if (row.mode === "120000") {
      if (!info.isSymbolicLink()) {
        throw markerError(`indexed symlink changed type: ${row.repoPath}`);
      }
      bytes = Buffer.from(await readlink(file), "utf8");
    } else {
      if (!info.isFile() || info.isSymbolicLink()) {
        throw markerError(
          `indexed regular source changed type: ${row.repoPath}`,
        );
      }
      if ((info.mode & 0o111) !== (row.mode === "100755" ? 0o111 : 0)) {
        throw markerError(`indexed source mode drift: ${row.repoPath}`);
      }
      if (info.size > MAX_SOURCE_FILE_BYTES) {
        throw markerError(`indexed source exceeds file bound: ${row.repoPath}`);
      }
      bytes = await readFile(file);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
      throw markerError("indexed source bytes exceed aggregate bound");
    }
    hashRecord(hash, `${row.mode}:${row.repoPath}`, bytes);
  }
  return Object.freeze({
    digest: hash.digest("hex"),
    files: rows.length,
  });
}

async function outputAuthority(distRoot) {
  const outputs = [];
  for (const outputPath of DIST_COMPLETE_OUTPUTS) {
    const file = path.join(distRoot, ...outputPath.split("/"));
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw markerError(
        `generated output is missing or special: ${outputPath}`,
      );
    }
    if (info.size <= 0 || info.size > MAX_SOURCE_FILE_BYTES) {
      throw markerError(
        `generated output size is outside bounds: ${outputPath}`,
      );
    }
    const bytes = await readFile(file);
    outputs.push(Object.freeze({
      path: outputPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    }));
  }
  return Object.freeze(outputs);
}

function validTarget(value) {
  return DIST_COMPLETE_TARGETS.includes(value);
}

export async function createDistCompleteMarker({ root, distRoot, target }) {
  if (!validTarget(target)) throw markerError("marker target is invalid");
  const source = await computeIndexedSourceAuthority({ root });
  // The key order is part of the canonical v2 byte contract. `target` is an
  // intent/mismatch declaration, not independent proof of output content; the
  // Store scanner must still inspect the actual package bytes.
  const marker = {
    commit: gitCommit(root),
    outputs: await outputAuthority(distRoot),
    schema: DIST_COMPLETE_SCHEMA,
    source: { digest: source.digest, files: source.files },
    target,
  };
  return Object.freeze({
    ...marker,
    source: Object.freeze(marker.source),
  });
}

export async function writeDistCompleteMarker({ root, distRoot, target }) {
  const marker = await createDistCompleteMarker({ root, distRoot, target });
  await writeFile(path.join(distRoot, "dist.complete"), canonicalJson(marker), {
    flag: "wx",
    mode: 0o644,
  });
  return marker;
}

export async function validateDistCompleteMarker({
  root,
  distRoot,
  expectedTarget,
}) {
  const markerPath = path.join(distRoot, "dist.complete");
  const info = await lstat(markerPath).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw markerError("marker is missing or special");
  }
  if (info.size <= 0 || info.size > MAX_MARKER_BYTES) {
    throw markerError("marker byte length is outside bounds");
  }
  const bytes = await readFile(markerPath);
  let marker;
  try {
    marker = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw markerError("marker is not valid JSON");
  }
  if (marker?.schema === LEGACY_DIST_COMPLETE_SCHEMA) {
    throw markerError(
      "legacy schema cap-dist-complete-v1 is rejected; run node build.mjs --target=store",
    );
  }
  if (
    !exactObject(marker, ["commit", "outputs", "schema", "source", "target"])
  ) {
    throw markerError("marker top-level schema is not exact");
  }
  if (
    marker.schema !== DIST_COMPLETE_SCHEMA || !COMMIT_RE.test(marker.commit)
  ) {
    throw markerError("marker identity is invalid");
  }
  if (!validTarget(marker.target)) {
    throw markerError("marker target is invalid");
  }
  if (!validTarget(expectedTarget)) {
    throw markerError("expected build target is invalid");
  }
  if (marker.target !== expectedTarget) {
    throw markerError(
      `build target mismatch: expected ${expectedTarget}, got ${marker.target}`,
    );
  }
  if (
    !exactObject(marker.source, ["digest", "files"]) ||
    !SHA256_RE.test(marker.source.digest) ||
    !Number.isSafeInteger(marker.source.files) || marker.source.files <= 0 ||
    marker.source.files > MAX_SOURCE_FILES
  ) throw markerError("marker source authority is invalid");
  if (
    !Array.isArray(marker.outputs) ||
    marker.outputs.length !== DIST_COMPLETE_OUTPUTS.length
  ) throw markerError("marker output inventory is invalid");
  for (let index = 0; index < marker.outputs.length; index++) {
    const output = marker.outputs[index];
    if (
      !exactObject(output, ["path", "sha256", "size"]) ||
      output.path !== DIST_COMPLETE_OUTPUTS[index] ||
      !SHA256_RE.test(output.sha256) || !Number.isSafeInteger(output.size) ||
      output.size <= 0 || output.size > MAX_SOURCE_FILE_BYTES
    ) throw markerError("marker output authority is invalid");
  }
  if (!bytes.equals(Buffer.from(canonicalJson(marker), "utf8"))) {
    throw markerError("marker JSON is not canonical");
  }

  const [source, outputs] = await Promise.all([
    computeIndexedSourceAuthority({ root }),
    outputAuthority(distRoot),
  ]);
  if (marker.commit !== gitCommit(root)) {
    throw markerError("marker commit is stale");
  }
  if (
    marker.source.digest !== source.digest ||
    marker.source.files !== source.files
  ) throw markerError("marker indexed source authority is stale");
  for (let index = 0; index < outputs.length; index++) {
    if (
      marker.outputs[index].path !== outputs[index].path ||
      marker.outputs[index].sha256 !== outputs[index].sha256 ||
      marker.outputs[index].size !== outputs[index].size
    ) throw markerError(`marker output is stale: ${outputs[index].path}`);
  }
  return Object.freeze({
    commit: marker.commit,
    outputs: Object.freeze(
      marker.outputs.map((row) => Object.freeze({ ...row })),
    ),
    schema: marker.schema,
    source: Object.freeze({ ...marker.source }),
    target: marker.target,
  });
}
