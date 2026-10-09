// Deterministic, verifiable authority for extension/dist/dist.complete.
//
// The build lock and version-directory names remain per-invocation custody.
// Those random/temporal values must never enter production package bytes.
// Instead this marker binds one Git commit, the current bytes of every indexed
// source file, and the exact generated bundle bytes.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readlink, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PYTHON_RUNTIME_PIN } from "../extension/lib/python-runtime.js";

const ADMITTED_PYTHON_FILES = new Set(
  Object.keys(PYTHON_RUNTIME_PIN.files).map((f) => `wasm-tools/python/${f}`),
);

export const DIST_COMPLETE_SCHEMA = "cap-dist-complete-v2";
export const LEGACY_DIST_COMPLETE_SCHEMA = "cap-dist-complete-v1";
export const DIST_COMPLETE_TARGETS = Object.freeze([
  "store",
  "developer",
  "enterprise",
]);
// Every generated bundle the build emits, in a fixed order (the marker's
// canonical byte contract depends on it). chrome-agent-platform-9epn.4: the
// marker used to bind only the SW + options; ntp / sidepanel / diff-core / the
// agent worker were shipped unrecorded, so their sizes could not be gated from
// the marker. Now `outputs[i].size` is the number tests/bundle-budget.test.ts
// holds against scripts/bundle-budget.mjs STORE_BUNDLE_BUDGETS (report-only
// since the owner decision of 2026-10-05: sizes are measured and reported,
// not enforced).
export const DIST_COMPLETE_OUTPUTS = Object.freeze([
  "background/service-worker.js",
  "options.bundle.js",
  "ntp.bundle.js",
  "sidepanel.bundle.js",
  "shared/diff-core.bundle.js",
  "workers/agent-worker.js",
  // chrome-agent-platform-o2t3: the six secondary surface bundles are shipped dist
  // artifacts (five page-loaded, one dynamically imported by options/user-wasm-panel.js)
  // and BUNDLE_ARCHIVE_MAP already archives all six, but the marker recorded sizes and
  // hashes for the six primary outputs only — so a secondary bundle's bytes could change
  // with nothing recording it. tests/bundle-budget.test.ts now pins every bundle the store
  // archives into this list, so one cannot silently drop out of the marker again.
  "artifacts.bundle.js",
  "artifact.bundle.js",
  "directory.bundle.js",
  "privacy.bundle.js",
  "offscreen.bundle.js",
  "user-wasm-store-client.bundle.js",
]);
export const INDEXED_SOURCE_EXCLUDED_PATHS = Object.freeze(new Set([
  "docs/diff-core.bundle.js",
]));

export const MAX_CHUNK_COUNT = 10;
export const MAX_CHUNK_FILE_BYTES = 500 * 1024;
export const CHUNK_PATH_RE = /^chunks\/[a-zA-Z0-9._-]+\.js$/u;

const SHA256_RE = /^[0-9a-f]{64}$/u;
const COMMIT_RE = /^[0-9a-f]{40,64}$/u;
const INDEX_MODES = new Set(["100644", "100755", "120000"]);
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_FILES = 10_000;
const MAX_SOURCE_PATH_BYTES = 1_024;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_MARKER_BYTES = 4_096;

/** chrome-agent-platform-1mz2: the marker binds HEAD, every indexed source byte
 * and the generated outputs, so ANY commit invalidates a built tree — including
 * the post-commit hook's own version bump and `git commit --amend`. A lane then
 * meets the staleness as red serial-phase tests, and a verdict that names only
 * the marker costs a re-diagnosis every time. Both staleness verdicts carry the
 * cause and the exact fix; the pinned substrings stay at the front so every
 * existing tamper assertion still reads the same verdict. */
const STALE_REBUILD_GUIDANCE =
  " — dist.complete binds the exact commit, every indexed source byte and the generated " +
  "bundles, so any commit invalidates it (the post-commit hook also bumps the version and " +
  "amends HEAD); rebuild before the gate: npm run build:production";

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

// Stage 1 of the parallel source walk (chrome-agent-platform-jjsz): validate the on-disk
// shape of one indexed row from lstat alone, holding no file bytes.
async function statIndexedRow(root, row) {
  const file = path.join(root, ...row.repoPath.split("/"));
  const info = await lstat(file).catch(() => null);
  if (!info) throw markerError(`indexed source is missing: ${row.repoPath}`);
  if (row.mode === "120000") {
    if (!info.isSymbolicLink()) {
      throw markerError(`indexed symlink changed type: ${row.repoPath}`);
    }
    return { row, file, size: 0 };
  }
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
  return { row, file, size: info.size };
}

// Stage 2: read the bytes of a row stage 1 already validated.
async function readIndexedRow({ row, file }) {
  const bytes = row.mode === "120000"
    ? Buffer.from(await readlink(file), "utf8")
    : await readFile(file);
  return { row, bytes };
}

export const SOURCE_STAT_BATCH = 64;
export const SOURCE_READ_BATCH_ROWS = 64;
// The old walk held one file (<= MAX_SOURCE_FILE_BYTES) at a time. A parallel read batch is
// capped by lstat size so resident file bytes stay within the same order, not 64 x the
// per-file cap before the aggregate bound is checked.
export const SOURCE_READ_BATCH_BYTES = 32 * 1024 * 1024;

/**
 * Greedy read batches over the lstat sizes of the indexed rows, in index order. A batch always
 * holds at least one row (so a file larger than the budget is read alone), then grows until it
 * reaches `maxRows` or adding the next row would pass `maxBytes`. Returns `[start, end)` index
 * pairs that cover every row exactly once. Pure, so the memory bound is testable on its own.
 *
 * @param {number[]} sizes
 * @param {number} [maxRows]
 * @param {number} [maxBytes]
 * @returns {Array<[number, number]>}
 */
export function planSourceReadBatches(sizes, maxRows = SOURCE_READ_BATCH_ROWS, maxBytes = SOURCE_READ_BATCH_BYTES) {
  const plan = [];
  for (let start = 0; start < sizes.length;) {
    let end = start;
    let budget = 0;
    while (
      end < sizes.length &&
      end - start < maxRows &&
      (end === start || budget + sizes[end] <= maxBytes)
    ) {
      budget += sizes[end];
      end++;
    }
    plan.push([start, end]);
    start = end;
  }
  return plan;
}

/**
 * @param {{
 *   root: string,
 *   observe?: ((event: { phase: "stat" | "read", start: number, end: number, bytes?: number }) => void) | null,
 * }} args `observe` is for tests and diagnostics: it is told about every stat batch and every read
 *   batch ([start, end) over the index-ordered rows; read batches also carry the lstat byte total)
 *   just before that batch runs. It receives plain numbers, never changes the digest, and exists so
 *   the memory bound can be pinned at the CALL SITE — every batching yields the same digest, so the
 *   result alone can never show that the bound is honoured.
 */
export async function computeIndexedSourceAuthority({ root, observe = null }) {
  root = path.resolve(root);
  const hash = createHash("sha256");
  let totalBytes = 0;
  const rows = indexedRows(root);
  const statted = [];
  for (let start = 0; start < rows.length; start += SOURCE_STAT_BATCH) {
    const end = Math.min(start + SOURCE_STAT_BATCH, rows.length);
    observe?.({ phase: "stat", start, end });
    statted.push(
      ...await Promise.all(
        rows.slice(start, end).map((row) => statIndexedRow(root, row)),
      ),
    );
  }
  for (const [start, end] of planSourceReadBatches(statted.map((s) => s.size))) {
    if (observe) {
      let planned = 0;
      for (let i = start; i < end; i++) planned += statted[i].size;
      observe({ phase: "read", start, end, bytes: planned });
    }
    const batch = await Promise.all(statted.slice(start, end).map(readIndexedRow));
    // Hash strictly in index order: the digest is order-sensitive and the byte contract is
    // unchanged from the sequential walk.
    for (const { row, bytes } of batch) {
      totalBytes += bytes.length;
      if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
        throw markerError("indexed source bytes exceed aggregate bound");
      }
      hashRecord(hash, `${row.mode}:${row.repoPath}`, bytes);
    }
  }
  return Object.freeze({
    digest: hash.digest("hex"),
    files: rows.length,
  });
}

async function walkDistFiles(root, prefix = "", output = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return output;
    throw err;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      throw markerError(`generated symlink rejected: ${relative}`);
    }
    if (info.isDirectory()) {
      await walkDistFiles(file, relative, output);
    } else if (info.isFile()) {
      output.push({ file, relative, size: info.size });
    } else {
      throw markerError(`generated special file rejected: ${relative}`);
    }
  }
  return output;
}

async function outputAuthority(distRoot, target = null) {
  const staticOutputs = await Promise.all(DIST_COMPLETE_OUTPUTS.map(async (outputPath) => {
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
    return Object.freeze({
      path: outputPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
  }));

  const chunksDir = path.join(distRoot, "chunks");
  const chunksDirExists = await lstat(chunksDir).then((s) => s.isDirectory()).catch(() => false);
  const chunkOutputs = [];
  if (chunksDirExists) {
    const chunkFiles = (await readdir(chunksDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && !e.isSymbolicLink() && e.name.endsWith(".js"))
      .map((e) => `chunks/${e.name}`)
      .sort();

    if (chunkFiles.length > MAX_CHUNK_COUNT) {
      throw markerError(`chunk count exceeds bound: ${chunkFiles.length} > ${MAX_CHUNK_COUNT}`);
    }

    for (const chunkPath of chunkFiles) {
      if (!CHUNK_PATH_RE.test(chunkPath)) {
        throw markerError(`invalid chunk path format: ${chunkPath}`);
      }
      const file = path.join(distRoot, ...chunkPath.split("/"));
      const info = await lstat(file).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) {
        throw markerError(`chunk file missing or special: ${chunkPath}`);
      }
      if (info.size <= 0 || info.size > MAX_CHUNK_FILE_BYTES) {
        throw markerError(`chunk size exceeds bound: ${chunkPath} (${info.size} > ${MAX_CHUNK_FILE_BYTES})`);
      }
      const bytes = await readFile(file);
      chunkOutputs.push(Object.freeze({
        path: chunkPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
      }));
    }
  }

  const allOutputs = Object.freeze([...staticOutputs, ...chunkOutputs]);

  const allDistFiles = await walkDistFiles(distRoot);
  const expectedPaths = new Set(allOutputs.map((o) => o.path));
  for (const { relative } of allDistFiles) {
    if (relative === "dist.complete") continue;
    // 1. Case-insensitive sourcemap rule applied BEFORE ANY exemption:
    // Matches .map, .MAP, .map.gz, etc. (case-insensitive)
    if (/\.map(?:\..*)?$/iu.test(relative)) {
      if (target === "store") {
        throw markerError(`unmanifested sourcemap file in store dist: ${relative}`);
      }
      // Developer builds emit sourcemaps for in-place debugging
      continue;
    }
    // 2. Python runtime members: admit ONLY pinned Python-runtime members
    if (relative.startsWith("wasm-tools/python/")) {
      if (!ADMITTED_PYTHON_FILES.has(relative)) {
        throw markerError(`unexpected member in python runtime dist: ${relative}`);
      }
      continue;
    }
    if (!expectedPaths.has(relative)) {
      throw markerError(`unmanifested file in dist/: ${relative}`);
    }
  }

  return allOutputs;
}

function validTarget(value) {
  return DIST_COMPLETE_TARGETS.includes(value);
}

/**
 * @param {{
 *   root: string,
 *   distRoot: string,
 *   target: string,
 *   source?: { digest: string, files: number } | null,
 * }} args `source` is an authority the caller ALREADY computed for the same tree (build.mjs's
 *   mixed-generation check) so it is not hashed twice. It is a speed shortcut, never a trust
 *   input: `validateDistCompleteMarker` recomputes from disk, so a stale `source` is refused.
 */
export async function createDistCompleteMarker({ root, distRoot, target, source: precomputedSource = null }) {
  if (!validTarget(target)) throw markerError("marker target is invalid");
  const [source, outputs] = await Promise.all([
    precomputedSource ?? computeIndexedSourceAuthority({ root }),
    outputAuthority(distRoot, target),
  ]);
  // The key order is part of the canonical v2 byte contract. `target` is an
  // intent/mismatch declaration, not independent proof of output content; the
  // Store scanner must still inspect the actual package bytes.
  const marker = {
    commit: gitCommit(root),
    outputs,
    schema: DIST_COMPLETE_SCHEMA,
    source: { digest: source.digest, files: source.files },
    target,
  };
  return Object.freeze({
    ...marker,
    source: Object.freeze(marker.source),
  });
}

/**
 * @param {{
 *   root: string,
 *   distRoot: string,
 *   target: string,
 *   source?: { digest: string, files: number } | null,
 * }} args see createDistCompleteMarker for what `source` is and is not.
 */
export async function writeDistCompleteMarker({ root, distRoot, target, source = null }) {
  const marker = await createDistCompleteMarker({ root, distRoot, target, source });
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
    marker.outputs.length < DIST_COMPLETE_OUTPUTS.length
  ) throw markerError("marker output inventory is invalid");
  for (let index = 0; index < DIST_COMPLETE_OUTPUTS.length; index++) {
    const output = marker.outputs[index];
    if (
      !exactObject(output, ["path", "sha256", "size"]) ||
      output.path !== DIST_COMPLETE_OUTPUTS[index] ||
      !SHA256_RE.test(output.sha256) || !Number.isSafeInteger(output.size) ||
      output.size <= 0 || output.size > MAX_SOURCE_FILE_BYTES
    ) throw markerError("marker output authority is invalid");
  }
  const chunkOutputs = marker.outputs.slice(DIST_COMPLETE_OUTPUTS.length);
  if (chunkOutputs.length > MAX_CHUNK_COUNT) {
    throw markerError(`chunk count exceeds bound: ${chunkOutputs.length} > ${MAX_CHUNK_COUNT}`);
  }
  for (const chunk of chunkOutputs) {
    if (
      !exactObject(chunk, ["path", "sha256", "size"]) ||
      !CHUNK_PATH_RE.test(chunk.path) ||
      !SHA256_RE.test(chunk.sha256) || !Number.isSafeInteger(chunk.size) ||
      chunk.size <= 0 || chunk.size > MAX_CHUNK_FILE_BYTES
    ) throw markerError("marker chunk output authority is invalid");
  }
  if (!bytes.equals(Buffer.from(canonicalJson(marker), "utf8"))) {
    throw markerError("marker JSON is not canonical");
  }

  const [source, outputs] = await Promise.all([
    computeIndexedSourceAuthority({ root }),
    outputAuthority(distRoot, expectedTarget ?? marker.target),
  ]);
  if (marker.commit !== gitCommit(root)) {
    throw markerError(`marker commit is stale${STALE_REBUILD_GUIDANCE}`);
  }
  if (
    marker.source.digest !== source.digest ||
    marker.source.files !== source.files
  ) throw markerError(`marker indexed source authority is stale${STALE_REBUILD_GUIDANCE}`);
  if (marker.outputs.length !== outputs.length) {
    throw markerError(`marker output count mismatch: expected ${outputs.length}, got ${marker.outputs.length}`);
  }
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
