// scripts/lib/build-tier-inputs.mjs — what the build-behaviour tier's verdict actually depends on,
// and the content-addressed decision that lets a landing skip it (chrome-agent-platform-6gk81).
//
// WHY THIS EXISTS. The FULL (union landing) gate is `build:production && npm test && test:build`.
// Measured on tree e7674fca (2026-10-17T06:39Z, PASS, 341s): build 18s + serial 74s + post-build
// read-only 18s + parallel 139s (704 files, 824.8 suite-seconds) + test:build 92s — so `test:build`
// was 27% of every landing for three files that assert build MECHANICS. On a loaded VM the same tier
// measured 146.6s. docs/TEST-TIERS-PROPOSAL.md (yvvvd) already defines that tier as Tier 3,
// "Selective & Nightly ... Trigger: Runs when build.mjs, packages/bundled, or generators change",
// and the bead that owns this measurement (6gk81) names tree-copy concurrency only as the fallback.
//
// WHY A CONTENT KEY AND NOT A GIT DELTA. scripts/gate-full.mjs implements the same Tier-3 rule from
// `git merge-base origin/main HEAD..HEAD`, and three of its review findings are all the same class
// of bug: a base that is guessed wrongly (or a git failure) reports "no build-infra change" and
// silently skips the tier (chrome-agent-platform-28qd4, -8z367, -6c97h). A content key cannot have
// that bug: it is computed from the bytes of the files the verdict depends on, in the tree being
// gated, with no reference to any ref, remote or merge base.
//
// WHAT IS IN THE KEY — the IMPORT CLOSURE, not a hand-written pattern list. The first version of
// this module keyed a list of path patterns, and review (rev-6gk81, 2026-10-17, finding on
// chrome-agent-platform-1yzg2) showed exactly why a list is the wrong shape: `build.mjs` imports
// scripts/browser-dependencies.mjs, scripts/lib/{bounded-child,pyodide-staging}.mjs,
// scripts/{sync-gallery,sync-changelog,generate-about-page}.mjs and the tier's tests import
// scripts/lib/process-tree.ts and scripts/dist-complete.mjs — none of which the list matched, so
// editing any of them left the key unchanged. A list also cannot tell you when it has drifted.
//
// The key is therefore the TRANSITIVE CLOSURE of the tier's roots — files it IMPORTS and files it
// NAMES BY PATH (a helper invoked as a child process, an esbuild plugin entry, an injected script are
// not imports, and review finding chrome-agent-platform-21iey proved that gap the same way):
//   * build.mjs
//   * scripts/build-gate.ts (the runner itself)
//   * every file in BUILD_GATE_FILES (tests/build-bootstrap.test.ts, -debug-mode, -tool-bundling)
// resolving relative specifiers (`./x`, `../x`, with the `.mjs`/`.ts`/`.js`/`.json` and `/index.*`
// fallbacks this repo uses) to repo files, recursively; and scanning each visited file's text for
// REPO PATH TOKENS (`scripts/build-bundled-tool-packages.mjs`, `scripts/stubs/gateway-stub.mjs`,
// `scripts/mcp-probe-entry.js`, `${ROOT}scripts/...`) that name an existing file, which is how the
// build reaches child processes and bundler entry points. Bare specifiers (`node:`, `npm:`, `jsr:`,
// `jsr:@std/...`) are not repo files and are covered by the lockfiles in the data set below.
//
// PATH TOKENS ARE RESTRICTED TO THE MACHINERY TREES (`scripts/`, `tests/`, `packages/`,
// `wasm-tools/`). `docs/**` and `extension/**` are deliberately NOT token-scanned: in the build they
// are overwhelmingly WRITE targets (`in sync docs/components-core.js`), so keying every such
// reference would make the tier re-run on nearly every product change and the skip would never fire.
// The parts of `extension/**` the machinery actually IMPORTS still enter through the import closure
// (extension/lib/{cap-log,kv,memory,emscripten-module-audit,bundled-inventory-data}.js do today).
// That makes the key track what the tests actually execute: a helper imported or spawned by the
// build, or by a test, is an input automatically, and nobody has to remember to add it.
// Plus the DATA inputs the closure cannot see:
//   * packages/bundled/** and wasm-tools/** — the generator/Wasmer trees the build reads by path
//   * extension/manifest*.json, package.json, package-lock.json, deno.lock, deno.runner.jsonc
//
// RESIDUE, stated so it is not implied away: a specifier assembled at runtime (`"./lib/" + name`, a
// substituting template) is invisible to static import scanning, exactly as it is to every text
// detector in this repo (scripts/test-partition.mjs documents the same residue for its own hazard
// rules). The mitigation is not silence: if the closure exceeds MAX_CLOSURE_FILES the walk reports
// `truncated` and the tier RUNS (fail closed) rather than keying a partial set.
//
// WHAT IS DELIBERATELY OUT OF THE KEY, and what covers it instead (so the skip is not a coverage
// hole — this paragraph is the whole safety argument and a review should hold it to account):
//   * The version counter (package.json / package-lock.json / extension/manifest.json / the bundled
//     inventory `.release`). The landing bump (scripts/bump-version.mjs) rewrites it on EVERY
//     landing, so a key that included it could never match. It is a stamp, not an input: any
//     occurrence of the tree's current version is replaced with VERSION_PLACEHOLDER before hashing,
//     and a test fails if the version appears in an input the bump does not rewrite.
//     Materialisation of that stamp is asserted on every gate by `build:production` itself
//     ("changelog in sync", "About page in sync", "docs/... in sync", "VERIFY OK: ... generated
//     files byte-identical to the committed tree").
//   * CHANGELOG.md, for the same reason (the landing prepends an entry), and because
//     `build:production` asserts the materialised changelog on every gate.
//   * Product sources (extension/**, docs/**), when the build machinery does not import them: the
//     tier's assertions are about HOW the build works, not about what it contains. The product
//     dimensions are asserted on EVERY gate by build:production's generated-file sync, oracle scan,
//     reachability and 52-binary Wasm manifest, plus npm test's build-smoke,
//     dist-complete-source-authority and bundled-tool-packages. (A product file that IS imported by
//     the machinery — e.g. extension/shared/components-core.js through a sync script — is in the
//     closure and therefore in the key.)
//
// FAIL-CLOSED DIRECTION. Every unknown returns "run": no digests, no durable root, no record, a
// record for a different key, an unreadable record, a truncated closure, or an explicit request
// (`npm run test:build tests/x.test.ts`, `CAP_BUILD_TIER=force`) => the tier runs. There is NO
// environment variable that skips it; the selector's only off-switch is "run the tests". The worst a
// broken key can do is make the tier run every time (the pre-6gk81 behaviour, 92-146s), never the
// reverse.
//
// THE EVERYTHING-GATE STILL RUNS IT. `npm run test:all` invokes the tier as
// `CAP_BUILD_TIER=force npm run test:build`, so the aggregate/nightly line — the "Nightly" half of
// the proposal's "Selective & Nightly" — never inherits the skip. tests/build-tier-inputs.test.ts
// pins that.
//
// Plain ESM with node: imports so both runtimes (deno: scripts/build-gate.ts and the tests) share it.

import { createHash } from "node:crypto";
import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { durableRoot } from "./durable-root.mjs";
import { BUILD_GATE_FILES, stripComments } from "../test-partition.mjs";

/** The recorded-PASS directory under the durable root; one `<key>.json` per passing input key. */
export const BUILD_TIER_RECORD_DIR_NAME = "build-tier-pass";

/** Substituted for the tree's own version string so the landing bump cannot invalidate a key. */
export const VERSION_PLACEHOLDER = "<VERSION>";

/**
 * The roots whose transitive static imports define the key. The tier's own tests come from
 * BUILD_GATE_FILES so adding a build test cannot leave it out of its own key.
 */
export const BUILD_TIER_ROOTS = Object.freeze([
  "build.mjs",
  "scripts/build-gate.ts",
  ...BUILD_GATE_FILES,
]);

/** The closure is bounded: beyond this the walk reports `truncated` and the tier runs (fail closed). */
export const MAX_CLOSURE_FILES = 500;

/** Data inputs the closure cannot see (read by path, not imported). */
export const BUILD_TIER_DATA_PATTERNS = Object.freeze([
  /^extension\/manifest[^/]*\.json$/,
  /^extension\/lib\/bundled-inventory-data\.js$/, // the generator's `release` surface (a landing stamp)
  /^package\.json$/,
  /^package-lock\.json$/,
  /^deno\.lock$/,
  /^deno\.runner\.jsonc$/,
]);

/** Whole trees the build reads by path. */
const TREE_DIRS = Object.freeze(["packages/bundled", "wasm-tools"]);

/** True when a repo-relative POSIX path is a build-tier DATA input (closure membership is separate). */
export function isBuildTierDataInput(repoPath) {
  if (typeof repoPath !== "string" || repoPath === "") return false;
  return BUILD_TIER_DATA_PATTERNS.some((pattern) => pattern.test(repoPath));
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

const SPECIFIER_RES = [
  /\bfrom\s*["']([^"']+)["']/g, // import … from "x" / export … from "x"
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import with a literal specifier
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // CJS
  /\bimport\s+["']([^"']+)["']/g, // side-effect import
];

/**
 * Every literal module specifier in a source text. This is a text scan, not a parser: it also matches
 * specifier-shaped text inside a string (a generator emitting source) or a comment. Two consequences,
 * both harmless: an unresolved entry is REPORTED rather than silently dropped, and placeholders that
 * cannot be module specifiers (`"..."`, a glob, anything with whitespace) are filtered out so the
 * report only names paths the scan genuinely could not follow.
 */
export function moduleSpecifiers(text) {
  const out = new Set();
  for (const re of SPECIFIER_RES) for (const m of String(text).matchAll(re)) out.add(m[1]);
  return [...out].filter((specifier) => specifier !== "" && !specifier.includes("...") && !specifier.includes("*") && !/\s/.test(specifier));
}

/**
 * Repo path tokens in a source text: an existing-file reference under one of the MACHINERY trees,
 * matched anywhere a quoted or template literal (or a bare token) names it. Comments and prose match
 * too, which is harmless — a candidate only enters the key if the file exists, and a wider key is the
 * safe direction (it re-runs the tier, it never skips one).
 */
export const PATH_TOKEN_RE = /(?:^|[^\w.\/-])((?:scripts|tests|packages|wasm-tools)\/[A-Za-z0-9._\/-]+\.(?:mjs|ts|js|cjs|mts|cts))/g;
const NOT_A_PATH_TOKEN = /(?:^|\/)\.\.(?:\/|$)/;

/**
 * What the closure may CONTAIN: the machinery and the tests. A resolved import or path token outside
 * these prefixes is product content (`extension/**`, `docs/**`, a root config) and is NOT added — the
 * existing policy, made mechanical so a helper that imports a product file cannot drag ~100 product
 * sources into the key and re-run the tier on every product landing. `extension/manifest*.json` and
 * the bundled inventory's release surface are keyed explicitly as DATA inputs instead.
 */
const CLOSURE_PREFIXES = ["scripts/", "tests/"];

/**
 * Tokens that are added to the key but NOT walked, and prefix checks for the reason:
 *   * `packages/bundled/` and `wasm-tools/` are already keyed WHOLESALE as data trees (every file),
 *     so walking them again only costs time and can only re-discover the same bytes.
 *   * a path token into `tests/` is a fixture reference, not something the build executes; the tests
 *     the tier runs are its ROOTS, and `tests/fixtures/**` arrives through the import closure.
 * Dropping these is what keeps the closure ~50 files instead of tripping MAX_CLOSURE_FILES.
 */
const LEAF_TREES = ["packages/bundled/", "wasm-tools/"];
const NOT_WALKED_TOKENS = ["tests/"];

/** Every repo path token in a text, de-duplicated and filtered to things that can be a path. */
export function pathReferences(text) {
  const out = new Set();
  for (const match of String(text).matchAll(PATH_TOKEN_RE)) {
    const token = match[1];
    if (NOT_A_PATH_TOKEN.test(token)) continue;
    out.add(token);
  }
  return [...out];
}

/** True when a resolved path may be part of the closure (machinery or tests). */
export function inClosureScope(repoPath) {
  return CLOSURE_PREFIXES.some((prefix) => String(repoPath).startsWith(prefix));
}

/** Normalise a repo-relative POSIX path, resolving `.` and `..` segments. */
export function normalizeRepoPath(path) {
  const parts = [];
  for (const segment of String(path).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/**
 * The repo file a relative specifier points at, or null. Tries the literal path, then the extension
 * swaps this repo uses (tests import `../scripts/x.mjs` for TypeScript sources elsewhere, so both
 * directions are needed), then an `/index.*` file. Bare specifiers (`node:`, `npm:`, `jsr:`) are not
 * repo files — the lockfiles in the data set cover them.
 */
export async function resolveSpecifier(fromRel, specifier, exists = fileExists) {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return null;
  const base = normalizeRepoPath(join(dirname(fromRel), specifier));
  if (base === "" || base.startsWith("..")) return null; // escapes the repo
  const swap = base.match(/^(.*)\.(mjs|ts|js|json|cjs)$/);
  const candidates = [base];
  if (swap) {
    const stem = swap[1];
    for (const ext of ["mjs", "ts", "js", "json", "cjs"]) if (`${stem}.${ext}` !== base) candidates.push(`${stem}.${ext}`);
  } else {
    for (const ext of ["mjs", "ts", "js", "json"]) candidates.push(`${base}.${ext}`);
  }
  for (const ext of ["mjs", "ts", "js"]) candidates.push(`${base}/index.${ext}`);
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function fileExists(relPath) {
  try {
    return (await stat(relPath)).isFile();
  } catch {
    return false;
  }
}

/**
 * The transitive static import closure of BUILD_TIER_ROOTS, as sorted repo-relative paths.
 * `truncated` is true when the walk hit MAX_CLOSURE_FILES — the caller must then RUN the tier.
 * @param {{ root: string, maxFiles?: number, exists?: (rel: string) => Promise<boolean>, read?: (abs: string) => Promise<Uint8Array> }} args
 * @returns {Promise<{ paths: string[], truncated: boolean, unresolved: string[] }>}
 */
export async function collectBuildTierClosure({
  root,
  maxFiles = MAX_CLOSURE_FILES,
  exists = (rel) => fileExists(join(root, rel)),
  read = (abs) => readFile(abs),
} = {}) {
  if (!root) throw new Error("collectBuildTierClosure: root is required");
  const seen = new Set();
  const unresolved = new Set();
  const queue = [...BUILD_TIER_ROOTS];
  let truncated = false;
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    if (seen.size >= maxFiles) {
      truncated = true;
      break;
    }
    seen.add(rel);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(await read(join(root, rel)));
    } catch {
      continue; // binary (a .wasm import target) or unreadable: nothing to scan, the file is still in the key
    }
    // Scan CODE, not prose (the o4m2 lesson the partition guard already learned): a comment that
    // mentions scripts/run-tests.mjs or a fixture path is not a read or an execution, and following it
    // would widen the key with files the tier never touches.
    const code = stripComments(text);
    for (const specifier of moduleSpecifiers(code)) {
      const resolved = await resolveSpecifier(rel, specifier, exists);
      if (resolved) {
        if (inClosureScope(resolved) && !seen.has(resolved)) queue.push(resolved);
      } else if (specifier.startsWith(".")) {
        unresolved.add(`${rel} -> ${specifier}`); // a RELATIVE import that does not resolve: residue, reported
      }
    }
    // Executed-by-path entry points (chrome-agent-platform-21iey): the build spawns a generator, points
    // esbuild at stub modules and injects a probe script — none of which is an import.
    for (const token of pathReferences(code)) {
      if (seen.has(token) || LEAF_TREES.some((prefix) => token.startsWith(prefix))) continue;
      if (NOT_WALKED_TOKENS.some((prefix) => token.startsWith(prefix))) continue;
      if (!inClosureScope(token)) continue;
      if (await exists(token)) queue.push(token);
    }
  }
  return { paths: [...seen].sort(), truncated, unresolved: [...unresolved].sort() };
}

/** List files under `<root>/<relDir>` as repo-relative POSIX paths (missing directory => nothing). */
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

/**
 * Every build-tier input path in the tree: the import closure, the data inputs, and the path-read
 * trees. Sorted and de-duplicated, so two identical trees always produce the same list.
 * @param {{ root: string, listDir?: Function, closure?: Function }} [args]
 * @returns {Promise<{ paths: string[], truncated: boolean, unresolved: string[] }>}
 */
export async function collectBuildTierInputPaths({ root, listDir = listDirAt, closure = collectBuildTierClosure } = {}) {
  if (!root) throw new Error("collectBuildTierInputPaths: root is required");
  const walked = await closure({ root });
  const found = new Set(walked.paths);
  for (const rel of ["package.json", "package-lock.json", "deno.lock", "deno.runner.jsonc"]) {
    if (isBuildTierDataInput(rel)) found.add(rel);
  }
  for (const rel of await listDir(root, "extension", false)) {
    if (isBuildTierDataInput(rel)) found.add(rel);
  }
  for (const dir of TREE_DIRS) {
    for (const rel of await listDir(root, dir, true)) found.add(rel);
  }
  return { paths: [...found].sort(), truncated: walked.truncated, unresolved: walked.unresolved };
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
 * Digest every build-tier input. `read` is injectable so the decision can be exercised without a
 * checkout; a path that cannot be read is skipped, which changes the key (the tier then runs).
 * @param {{ root?: string, version?: string | null, read?: (absPath: string) => Promise<Uint8Array>, paths?: string[] | null }} [args]
 * @returns {Promise<Array<{path: string, sha256: string, bytes: number}>>}
 */
export async function collectBuildTierInputs({ root, version, read = readFile, paths = null } = {}) {
  const files = paths ?? (await collectBuildTierInputPaths({ root })).paths;
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
 * key match may skip, only in selective mode, and never when the closure was truncated.
 * @param {{ entries?: Array<{path: string, sha256: string}>, record?: {key?: string, at?: string} | null, mode?: string, truncated?: boolean }} [args]
 * @returns {{ run: boolean, key: string|null, inputs: number, reason: string }}
 */
export function buildTierDecision({ entries = [], record = null, mode = "selective", truncated = false } = {}) {
  const key = buildTierKey(entries);
  const inputs = Array.isArray(entries) ? entries.length : 0;
  if (mode === "force") {
    return { run: true, key, inputs, reason: "CAP_BUILD_TIER=force (a forced run, not a selection)" };
  }
  if (truncated) {
    return { run: true, key, inputs, reason: `import closure exceeded ${MAX_CLOSURE_FILES} files (fail closed: a partial key must not certify)` };
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

/** The recorded-PASS directory, or null when the durable root is unavailable (=> fail closed). */
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
 * Resolve the tier's run/skip decision for a tree: collect the inputs, read the record for that key,
 * and decide. The only entry point scripts/build-gate.ts uses.
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
  const collectPaths = collectBuildTierInputPaths;
  const walked = await collectPaths({ root });
  const entries = await collect({ root, version, paths: walked.paths });
  const key = buildTierKey(entries);
  const record = key ? await readRecord({ key, dir: recordDir }) : null;
  return { ...buildTierDecision({ entries, record, mode, truncated: walked.truncated }), record, closure: walked };
}
