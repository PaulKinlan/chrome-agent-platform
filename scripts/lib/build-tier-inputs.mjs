// scripts/lib/build-tier-inputs.mjs — what the build-behaviour tier's verdict actually depends on,
// and the content-addressed decision that lets a landing skip it (chrome-agent-platform-6gk81).
//
// WHY THIS EXISTS. The FULL (union landing) gate is `build:production && npm test && test:build`.
// Measured on tree e7674fca (2026-10-17T06:39Z, PASS, 341s): build 18s + serial 74s + post-build
// read-only 18s + parallel 139s (704 files, 824.8 suite-seconds) + test:build 92s. So `test:build`
// is 27% of every landing for three files that assert build MECHANICS. docs/TEST-TIERS-PROPOSAL.md
// (yvvvd) already defines that as Tier 3, "Selective & Nightly ... Trigger: Runs when build.mjs,
// packages/bundled, or generators change", and the bead that owns this measurement (6gk81) names
// tree-copy concurrency only as the fallback if the cheaper cut is insufficient.
//
// WHY A CONTENT KEY AND NOT A GIT DELTA. scripts/gate-full.mjs implements the same Tier-3 rule from
// `git merge-base origin/main HEAD..HEAD`, and three of its review findings are all the same class
// of bug: a base that is guessed wrongly (or a git failure) reports "no build-infra change" and
// silently skips the tier (chrome-agent-platform-28qd4, -8z367, -6c97h). A content key cannot have
// that bug: it is computed from the bytes of the files the verdict depends on, in the tree being
// gated, with no reference to any ref, remote or merge base. A tree whose build machinery is
// byte-identical to a tree that already passed this tier has the same build machinery; a tree with
// one changed byte in it runs the tier.
//
// WHAT IS IN THE KEY. Everything the three build-behaviour tests' assertions depend on: the build
// entry point (build.mjs), the build/package/dist/wasm machinery it drives, the tier's own tests and
// fixtures, the inputs the generator tiers read (packages/bundled/**, wasm-tools/**), the extension
// manifest and the dependency/runner pinning. Editing any of these runs the tier — including editing
// a build test, which is the point: a tier cannot certify the tests that define it.
//
// WHAT IS DELIBERATELY OUT OF THE KEY, and what covers it instead (so the skip is not a coverage
// hole — this paragraph is the whole safety argument and a review should hold it to account):
//   * The version counter (package.json / package-lock.json / extension/manifest.json / the bundled
//     inventory `.release`). The landing bump (scripts/bump-version.mjs) rewrites it on EVERY
//     landing, so a key that included it could never match. It is a stamp, not an input: any
//     occurrence of the tree's current version is replaced with VERSION_PLACEHOLDER before hashing.
//     Materialisation of that stamp is asserted on every gate by `build:production` itself
//     ("changelog in sync", "About page in sync", "docs/... in sync", "VERIFY OK: ... generated
//     files byte-identical to the committed tree").
//   * CHANGELOG.md, for the same reason (the landing prepends an entry), and because
//     `build:production` asserts the materialised changelog on every gate.
//   * Product sources (extension/**, docs/**): the tier's assertions are about HOW the build works,
//     not about what it contains. The product-content dimensions are already asserted on EVERY gate:
//     build:production's generated-file sync, oracle scan, reachability and 52-binary manifest; plus
//     tests/build-smoke.test.ts (serial), tests/dist-complete-source-authority.test.ts and
//     tests/bundled-tool-packages.test.ts (post-build read-only) inside `npm test`.
//
// THE EVERYTHING-GATE STILL RUNS IT. `npm run test:all` invokes the tier as
// `CAP_BUILD_TIER=force npm run test:build`, so the aggregate/nightly line — the "Nightly" half of the
// proposal's "Selective & Nightly" — never inherits the skip. tests/build-tier-inputs.test.ts pins that.
//
// FAIL-CLOSED DIRECTION. Every unknown returns "run": no digests, no durable root, no record, a
// record for a different key, an unreadable record, or an explicit request (`npm run test:build
// tests/x.test.ts`, `CAP_BUILD_TIER=force`) => the tier runs. There is NO environment variable that
// skips the tier; the selector's only off-switch is "run the tests". The worst a broken key can do
// is make the tier run every time (the pre-6gk81 behaviour, 92s), never the reverse.
//
// Plain ESM with node: imports so both runtimes (deno: scripts/build-gate.ts and the tests) share it.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { durableRoot } from "./durable-root.mjs";

/** The recorded-PASS directory under the durable root; one `<key>.json` per passing input key. */
export const BUILD_TIER_RECORD_DIR_NAME = "build-tier-pass";

/** Substituted for the tree's own version string so the landing bump cannot invalidate a key. */
export const VERSION_PLACEHOLDER = "<VERSION>";

/**
 * Repo-relative POSIX paths whose BYTES the build tier's verdict depends on. Membership is a claim
 * about the tier, so it is pinned by tests/build-tier-inputs.test.ts: a path that changes what a
 * build-behaviour assertion can see belongs here, and a product path does not.
 */
export const BUILD_TIER_INPUT_PATTERNS = Object.freeze([
  /^build\.mjs$/,
  /^scripts\/build-[^/]+\.(?:mjs|ts|js)$/, // build-gate.ts, build-if-needed.mjs, build-bundled-tool-packages.mjs, ...
  /^scripts\/package-[^/]+\.mjs$/, // package-archive.mjs, package-extension.mjs
  /^scripts\/bump-version\.mjs$/, // the landing stamp's writer (its surfaces are keyed version-neutrally)
  /^scripts\/changelog-delta\.mjs$/, // gates the build-once record the serial build tests read
  /^scripts\/test-partition\.mjs$/, // BUILD_GATE_CHILD_BUILDS / the tier's per-file windows
  /^scripts\/lib\/(?:build|dist|copy-built-tree|wasm|emscripten)[^/]*\.(?:mjs|ts)$/,
  /^tests\/build-[^/]+\.test\.ts$/, // the tier's own tests, including build-smoke
  /^tests\/fixtures\/build-once\.mjs$/,
  /^packages\/bundled\//, // bundled-tool generator inputs (incl. the inventory the release stamp lives in)
  /^wasm-tools\//, // the Wasm binaries the build bundles and the archive hashes
  /^extension\/manifest[^/]*\.json$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^deno\.lock$/,
  /^deno\.runner\.jsonc$/,
]);

/** Repo-root files considered directly (all filtered through BUILD_TIER_INPUT_PATTERNS). */
const ROOT_FILES = Object.freeze([
  "build.mjs",
  "package.json",
  "package-lock.json",
  "deno.lock",
  "deno.runner.jsonc",
]);

/** Directories walked one level deep (the pattern list decides what survives). */
const FLAT_DIRS = Object.freeze(["scripts", "scripts/lib", "tests", "tests/fixtures", "extension"]);

/** Directories walked recursively: whole input trees, not source files. */
const TREE_DIRS = Object.freeze(["packages/bundled", "wasm-tools"]);

/** True when a repo-relative POSIX path is a build-tier input. */
export function isBuildTierInput(repoPath) {
  if (typeof repoPath !== "string" || repoPath === "") return false;
  return BUILD_TIER_INPUT_PATTERNS.some((pattern) => pattern.test(repoPath));
}

/**
 * The tier's selection mode. `force` always runs the tier; every other value (including unset, and
 * including an attempt to spell "skip") is the default selective mode. The selector has no skip
 * switch on purpose: a build gate's own tier must not be switchable off from the environment.
 * @param {Record<string, string | undefined>} [env]
 * @returns {"force" | "selective"}
 */
export function buildTierMode(env = {}) {
  const raw = String(env.CAP_BUILD_TIER ?? "").trim().toLowerCase();
  return raw === "force" || raw === "1" || raw === "true" || raw === "always" ? "force" : "selective";
}

/**
 * Replace every occurrence of the tree's own version with VERSION_PLACEHOLDER. Binary (non-UTF-8)
 * content is returned unchanged: a version string inside a compiled blob is not a stamp we can
 * locate, and hashing the raw bytes is the honest answer.
 * @param {Uint8Array} bytes
 * @param {string | null | undefined} version
 * @returns {Uint8Array}
 */
export function versionNeutralBytes(bytes, version) {
  if (!version || typeof version !== "string" || !bytes || bytes.length === 0) return bytes;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes;
  }
  if (!text.includes(version)) return bytes;
  return new TextEncoder().encode(text.split(version).join(VERSION_PLACEHOLDER));
}

/**
 * List files under `<root>/<relDir>` as repo-relative POSIX paths. A missing/unreadable directory
 * contributes nothing (a tree that lacks one of these trees simply has fewer inputs).
 */
async function listDirAt(root, relDir, recursive) {
  let entries;
  try {
    entries = await readdir(join(root, relDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (recursive) out.push(...(await listDirAt(root, rel, true)));
      continue;
    }
    out.push(rel); // regular file or symlink: its CONTENT is the input
  }
  return out;
}

/** Every candidate build-tier input path in the tree, sorted (deterministic, no duplicates). */
/**
 * @param {{ root: string, listDir?: (root: string, relDir: string, recursive: boolean) => Promise<string[]> }} args
 * @returns {Promise<string[]>}
 */
export async function collectBuildTierInputPaths({ root, listDir = listDirAt }) {
  if (!root) throw new Error("collectBuildTierInputPaths: root is required");
  const found = new Set();
  for (const file of ROOT_FILES) if (isBuildTierInput(file)) found.add(file);
  for (const dir of FLAT_DIRS) {
    for (const rel of await listDir(root, dir, false)) if (isBuildTierInput(rel)) found.add(rel);
  }
  for (const dir of TREE_DIRS) {
    for (const rel of await listDir(root, dir, true)) if (isBuildTierInput(rel)) found.add(rel);
  }
  return [...found].sort();
}

/**
 * Digest every build-tier input. `read` is injectable so the decision can be exercised without a
 * checkout; a path that cannot be read is skipped, which changes the key (the tier then runs).
 * @param {{ root?: string, version?: string | null, read?: (absPath: string) => Promise<Uint8Array>, paths?: string[] | null }} [args]
 * @returns {Promise<Array<{path: string, sha256: string, bytes: number}>>}
 */
export async function collectBuildTierInputs({ root, version, read = readFile, paths = null } = {}) {
  const files = paths ?? (await collectBuildTierInputPaths({ root }));
  const entries = [];
  for (const rel of files) {
    let bytes;
    try {
      bytes = await read(join(root, rel));
    } catch {
      continue;
    }
    entries.push({
      path: rel,
      sha256: createHash("sha256").update(versionNeutralBytes(bytes, version)).digest("hex"),
      bytes: bytes.length,
    });
  }
  return entries;
}

/** The key for a set of digests: order-independent, and null when nothing could be digested. */
/**
 * @param {Array<{path: string, sha256: string}>} [entries]
 * @returns {string | null}
 */
export function buildTierKey(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const ordered = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of ordered) hash.update(`${entry.path}\u0000${entry.sha256}\n`, "utf8");
  return hash.digest("hex");
}

/**
 * The decision itself, pure. `record` is a previously recorded PASS for `record.key`; only an exact
 * key match may skip, and only in selective mode.
 * @param {{ entries?: Array<{path: string, sha256: string}>, record?: {key?: string, at?: string} | null, mode?: string }} [args]
 * @returns {{ run: boolean, key: string|null, inputs: number, reason: string }}
 */
export function buildTierDecision({ entries = [], record = null, mode = "selective" } = {}) {
  const key = buildTierKey(entries);
  const inputs = Array.isArray(entries) ? entries.length : 0;
  if (mode === "force") {
    return { run: true, key, inputs, reason: "CAP_BUILD_TIER=force (a forced run, not a selection)" };
  }
  if (!key) {
    return { run: true, key: null, inputs, reason: "no build-tier input could be digested (fail closed)" };
  }
  if (!record) {
    return { run: true, key, inputs, reason: `no recorded PASS for input key ${key.slice(0, 12)}` };
  }
  if (record.key !== key) {
    return {
      run: true,
      key,
      inputs,
      reason: `build-tier inputs changed: recorded PASS is for key ${String(record.key).slice(0, 12)}, this tree is ${key.slice(0, 12)}`,
    };
  }
  return {
    run: false,
    key,
    inputs,
    reason: `build-tier inputs are byte-identical to the tree that passed this tier at ${record.at} (key ${key.slice(0, 12)})`,
  };
}

/**
 * The recorded-PASS directory, or null when the durable root is unavailable (=> fail closed).
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function buildTierRecordDir(env = process.env) {
  try {
    const explicit = env.CAP_BUILD_TIER_RECORD_DIR;
    if (typeof explicit === "string" && explicit.trim() !== "") return explicit;
    return join(durableRoot(), BUILD_TIER_RECORD_DIR_NAME);
  } catch {
    return null; // RAM-backed / no durable root: run the tier rather than guess
  }
}

const KEY_SHAPE = /^[0-9a-f]{64}$/;

/**
 * A recorded PASS for this exact key, or null (absent, unreadable, malformed, mismatched).
 * @param {{ key?: string | null, dir?: string | null, read?: ((file: string) => Promise<string>) | null }} [args]
 * @returns {Promise<{key: string, at: string, suites?: string[]} | null>}
 */
export async function readBuildTierRecord({ key, dir = buildTierRecordDir(), read = null } = {}) {
  if (!KEY_SHAPE.test(String(key ?? ""))) return null;
  if (!dir) return null;
  try {
    const body = JSON.parse(read ? await read(join(dir, `${key}.json`)) : await readFile(join(dir, `${key}.json`), "utf8"));
    if (body?.key !== key) return null;
    if (typeof body.at !== "string" || body.at === "") return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * Record a PASS for `key`. Called ONLY from the runner's success path (exitCode === 0); a non-zero
 * exit records nothing, so a FAILED tier can never license a skip. A write failure is non-fatal: a
 * record we cannot write only costs a later run.
 * @param {{ key?: string | null, suites?: string[], exitCode?: number, dir?: string | null, now?: () => Date }} [args]
 * @returns {Promise<{written: boolean, reason: string}>}
 */
export async function recordBuildTierPass({
  key,
  suites = [],
  exitCode,
  dir = buildTierRecordDir(),
  now = () => new Date(),
} = {}) {
  if (exitCode !== 0) return { written: false, reason: "tier-did-not-exit-0" };
  if (!KEY_SHAPE.test(String(key ?? ""))) return { written: false, reason: "invalid-key" };
  if (!Array.isArray(suites) || suites.length === 0) return { written: false, reason: "no-suites" };
  if (!dir) return { written: false, reason: "no-record-dir" };
  try {
    const body = JSON.stringify({ key, at: now().toISOString(), suites: [...suites] }) + "\n";
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${key}.json`), body);
    return { written: true, reason: "written" };
  } catch {
    return { written: false, reason: "write-failed" };
  }
}

/**
 * Resolve the tier's run/skip decision for a tree: collect the digests, read the record for that
 * key, and decide. The only entry point scripts/build-gate.ts uses.
 * @param {{
 *   root?: string,
 *   version?: string | null,
 *   mode?: string,
 *   recordDir?: string | null,
 *   collect?: Function,
 *   readRecord?: Function,
 * }} args
 * @returns {Promise<{run: boolean, key: string|null, inputs: number, reason: string, record: any}>}
 */
export async function resolveBuildTier({
  root,
  version,
  mode = buildTierMode(process.env),
  recordDir = buildTierRecordDir(),
  collect = collectBuildTierInputs,
  readRecord = readBuildTierRecord,
}) {
  const entries = await collect({ root, version });
  const key = buildTierKey(entries);
  const record = key ? await readRecord({ key, dir: recordDir }) : null;
  return { ...buildTierDecision({ entries, record, mode }), record };
}
