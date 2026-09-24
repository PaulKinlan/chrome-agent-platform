// scripts/select-tests.mjs — dependency-aware deno test subsetting (9hoc).
//
//   node scripts/select-tests.mjs            run the subset: `deno test -A <files>`
//   node scripts/select-tests.mjs --list     print the selected test files, one per line
//   node scripts/select-tests.mjs --core     run the always-on core only (security/vocabulary)
//   node scripts/select-tests.mjs --base <ref>   compare against <ref> instead of origin/main
//
// WHY: the full suite (321 files) is the merge gate and stays exactly as it is
// (`npm test`, scripts/run-tests.mjs). This is ADDITIVE tooling so a per-commit gate can run
// in well under a minute: a changed file (git diff vs origin/main) selects the
// test files that transitively import it (static import graph), plus the always-on
// core (security + vocabulary). FAIL CLOSED: a changed code/config file with no
// reachable test (nothing imports it, or it was deleted with no remaining
// importers) cannot be proved covered by a subset — the picker then runs the FULL
// suite instead of a silent core-only green. Nothing is skipped or weakened;
// test:changed is a faster subset of the same assertions.
//
// Subset runs match the gate semantics EXACTLY: the same two-phase partition
// as the full suite (76hu) — serial build-artifact hazards first, the rest
// with --parallel. A subset differs from the gate only in WHICH files run,
// never in how they run: any serial hazard in the subset still runs serially.
// (9hoc first ran subsets fully serial; vj4s's partition — shared via
// scripts/test-partition.mjs and pinned by tests/test-partition-guard.test.ts
// — made parallel subsets safe: an 18-file provider-gate subset dropped from
// 182s to ~40s.)
//
// MOTIVATING LESSON (canon, 2026-09-11; dqc1): subset gates CANNOT see cross-cutting
// guards. A guard that dynamically scans file trees (like test-partition-guard.test.ts)
// without statically importing touched files will not be selected by test:changed.
// npm test is the mandatory pre-push gate. See docs/CHROME-TEST-CONTRACT.md.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { partition } from "./test-partition.mjs";
import { runSerialFiles } from "./lib/serial-phase.mjs";
import { isSelectorInfrastructure, mapUncovered, versionOnlyJsonChange } from "./lib/changed-file-mapping.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- always-on core: security + vocabulary families (76 tests, ~3s) ----
export const CORE = [
  "tests/security.test.ts",
  "tests/secret-redaction.test.ts",
  "tests/security-suite-custody.test.ts",
  "tests/owner-approval-security.test.ts",
  "tests/vocabulary.test.ts",
];

// ---- always-on source-inspecting invariant guards (chrome-agent-platform-qcfc) ----
// Invariant: tests that read tracked source as data (AST census, source scans,
// root-path guards) have no static import edges in the dependency graph.
// They must be in the always-on set so test:changed cannot pass silently green.
export const SOURCE_INSPECTING_GUARDS = [
  "tests/sw-dispatch-authority-census.test.ts",
  "tests/sw-route-modularization.test.ts",
  "tests/file-url-root-guard.test.ts",
  "tests/docs-process-truth.test.ts",
  "tests/main-module-check-guard.test.ts",
  "tests/test-partition-guard.test.ts",
  "tests/package-scripts-exist.test.ts",
  "tests/changelog.test.ts",
  "tests/changelog-shipping.test.ts",
  "tests/acp-fixture-env-guard.test.ts",
  "tests/manifest-permissions.test.ts",
  "tests/harness-registry.test.ts",
  "tests/source-materialization.test.ts",
  "tests/source-inspecting-tests-guard.test.ts",
];

export const ALWAYS_ON = Object.freeze([
  ...CORE,
  ...SOURCE_INSPECTING_GUARDS,
]);

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// chrome-agent-platform-nco2 (mechanism 3): compare against the MERGE-BASE, not
// the tip. `git diff --name-only origin/main` lists every file that differs
// between your tree and the tip — including files ANOTHER LANE landed after you
// branched. Measured live in the canonical checkout at 78dddba6: origin/main had
// advanced to 1a50cf3e and a direct diff attributed 17 foreign files to the
// working tree, one of which (cap-evidence/constrained-width-layout.ts, bead
// cgei's landing) forced a full suite on a lane that had not touched it.
// Falls back to the raw ref when no merge-base exists (a detached or unrelated
// history), because refusing to compute a changed set is worse than a wide one.
export function mergeBaseOf(base, runGit = git) {
  try {
    return runGit(["merge-base", "HEAD", base]).trim() || base;
  } catch {
    return base; // unrelated histories / missing ref: diff against it directly
  }
}

function changedFiles(base) {
  const tracked = git(["diff", "--name-only", mergeBaseOf(base)]).split("\n").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untracked])]
    .map((f) => normalize(f))
    .filter((f) =>
      !f.startsWith(".") && !f.startsWith("docs") && !f.startsWith("dist") &&
      !f.startsWith("test-artifacts") && !f.startsWith("evidence") && !f.startsWith("reports") &&
      !f.includes("CHANGELOG")
    );
}

// ---- static import graph ----
const IMPORT_RE = /\b(?:import|export)\s*(?:\(|\{)?[^'"]*?\bfrom\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']|import\s*\(\s*`([^`${]+)|import\s*\(\s*["']([^"']+)["']\s*\+/g;

function importsOf(absPath) {
  if (!existsSync(absPath)) return [];
  const text = readFileSync(absPath, "utf8");
  const out = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim();
    if (!spec || !spec.startsWith(".")) continue; // only relative repo imports
    const clean = spec.split("?")[0].split("#")[0];
    const resolved = resolve(dirname(absPath), clean);
    const found = resolvePath(resolved);
    if (found) {
      out.push(found);
    } else {
      // The imported module is not on disk right now — it was deleted or
      // renamed on this branch. Record the edge under the literal resolved
      // path (and, for an extensionless spec, each candidate Deno would try)
      // so the reverse graph keeps a key for the missing module. A changed
      // (deleted/renamed) path is then looked up as a graph key and its
      // importers are selected instead of the subset silently passing.
      out.push(resolved);
      if (!/\.[a-zA-Z0-9]+$/.test(clean)) {
        for (const ext of [".js", ".ts", ".mjs"]) out.push(resolved + ext);
      }
    }
  }
  // Also link executable code instruments referenced via new URL(..., import.meta.url) (chrome-agent-platform-1smd)
  for (const m of text.matchAll(/new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) {
    const spec = m[1].trim();
    if (spec.startsWith(".") && /\.(js|ts|mjs)$/.test(spec)) {
      const clean = spec.split("?")[0].split("#")[0];
      const resolved = resolve(dirname(absPath), clean);
      const found = resolvePath(resolved);
      if (found) out.push(found);
    }
  }
  return out;
}

// Deno resolves extensionless to .js/.ts/.mjs; accept the literal then the
// extension candidates the repo uses.
function resolvePath(p) {
  if (existsSync(p) && statSync(p).isFile()) return p;
  for (const ext of [".js", ".ts", ".mjs"]) {
    const q = p + ext;
    if (existsSync(q)) return q;
  }
  return null;
}

// Reverse edges over the whole source tree: file -> files that import it.
export function buildReverseGraph() {
  const reverse = new Map(); // abs path -> Set(abs paths of importers)
  const files = new Set();
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(js|ts|mjs)$/.test(ent.name)) files.add(p);
    }
  };
  for (const d of ["extension", "scripts", "lib", "packages", "tests", "cap-evidence"]) {
    if (existsSync(join(ROOT, d))) walk(join(ROOT, d));
  }
  for (const f of files) {
    for (const imp of importsOf(f)) {
      if (!reverse.has(imp)) reverse.set(imp, new Set());
      reverse.get(imp).add(f);
    }
  }
  return reverse;
}

const isTestRel = (rel) => /^tests[\\/][^\\/]+\.test\.(ts|js)$/.test(rel);
const isChangedTest = (c) => /\.test\.(ts|js)$/.test(c);

// Pure content/docs that no test executes; their edits cannot break the suite
// through the import graph and are not fail-closed targets (the full suite's
// doc-scanning tests, if any, stay the merge gate).
const CONTENT_EXT_RE = /\.(md|markdown|txt|png|jpe?g|gif|svg|webp|ico|woff2?|pdf)$/i;

// Walk the reverse graph from one abs path; true when a test file is reachable.
function reachableTestFrom(startAbs, reverse, isTest) {
  const seen = new Set([startAbs]);
  const queue = [startAbs];
  while (queue.length) {
    const cur = queue.pop();
    for (const imp of reverse.get(cur) ?? []) {
      const rel = relative(ROOT, imp);
      if (isTest(imp)) return true;
      if (!rel.startsWith("..") && !seen.has(imp)) {
        seen.add(imp);
        queue.push(imp);
      }
    }
  }
  return false;
}

/**
 * Every test file's text, for the literal-reference search.
 *
 * nco2/R1: a test can EXECUTE a script through a computed path
 * (`join(ROOT, "scripts", "acp-service.mjs")` + spawn) with no static import
 * edge, so the reverse graph cannot see it — but the basename is still a string
 * literal in the file. Reading the corpus is what lets an uncovered script map
 * to the test that actually runs it instead of to guards that never look at it.
 */
function testCorpus() {
  const dir = join(ROOT, "tests");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !/\.(test\.ts|test\.js|mjs|ts)$/.test(ent.name)) continue;
    try {
      out.push({ rel: `tests/${ent.name}`, text: readFileSync(join(dir, ent.name), "utf8") });
    } catch { /* unreadable file: not a reference */ }
  }
  return out;
}

/** Read a path at `ref` and at the working tree, and ask whether the difference
 *  is confined to version fields. Any git failure is `false` (fail closed). */
export function versionOnlyAgainst(ref, rel) {
  try {
    const before = git(["show", `${ref}:${rel}`]);
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return false;
    // R2b: the predicate is FILE-SPECIFIC — package.json's bump writes `version`,
    // the lock's also writes packages[""].version, the manifest's also writes
    // version_name, and none of them writes `release`. Pass the path.
    return versionOnlyJsonChange(before, readFileSync(abs, "utf8"), rel);
  } catch {
    return false; // new file, unreadable ref, anything unexpected: fail closed
  }
}

export function selectTestFiles(changed, reverse, mapped = []) {
  const selected = new Set(ALWAYS_ON.filter((c) => existsSync(join(ROOT, c))));
  // nco2: the guards that cover an import-unreachable changed file. Added before
  // the graph walk so they survive it, and existence-checked like the core.
  for (const m of mapped) {
    for (const t of m.tests) if (existsSync(join(ROOT, t))) selected.add(t);
  }
  const changedAbs = [];
  for (const c of changed) {
    const abs = resolve(ROOT, c);
    // Changed test files always run themselves — but only if they still exist
    // (a deleted test file cannot run; nothing else references it).
    if (isChangedTest(c) && existsSync(abs)) selected.add(normalize(c));
    // Retain EVERY changed path as a graph key, including paths absent from
    // the current tree: deleting/renaming a module must still select the tests
    // that import it (they now import a missing file and must fail loudly,
    // never silently green).
    changedAbs.push(abs);
  }
  if (!changedAbs.length || !reverse) return [...selected].sort();

  const seen = new Set(changedAbs);
  const queue = [...changedAbs];
  while (queue.length) {
    const cur = queue.pop();
    for (const imp of reverse.get(cur) ?? []) {
      const rel = relative(ROOT, imp);
      if (isTestRel(rel)) {
        if (!rel.startsWith("..")) selected.add(rel);
      } else if (!seen.has(imp)) {
        seen.add(imp);
        queue.push(imp);
      }
    }
  }
  return [...selected].sort();
}

// Changed code/config files with NO reachable test. A subset cannot prove
// coverage of these (nothing imports them), so callers must FAIL CLOSED to the
// full suite rather than run a silent core-only green. Files absent from the
// current tree (deleted/renamed) are NOT fail-closed candidates: retention in
// selectTestFiles selects their remaining importers, whose imports now fail
// loudly — the honest red. Pure content/docs can break nothing through the
// import graph and stay core-only.
export function changedWithoutCoverage(changed, reverse) {
  const uncovered = [];
  const reverseMap = reverse ?? new Map();
  for (const c of changed) {
    if (isChangedTest(c)) continue; // runs itself (or was deleted = nothing to do)
    if (CONTENT_EXT_RE.test(c)) continue; // docs/assets: no executable effect
    const abs = resolve(ROOT, c);
    if (!existsSync(abs)) continue; // deleted/renamed: retention selects importers, if any
    if (reachableTestFrom(abs, reverseMap, (p) => isTestRel(relative(ROOT, p)))) continue;
    uncovered.push(c);
  }
  return uncovered;
}

const PARALLEL_PHASE_TIMEOUT_MS = Number(process.env.CAP_PARALLEL_TEST_TIMEOUT_MS ?? 600_000);

function runPhase(files, flags, label, timeoutMs = 300_000) {
  const t0 = Date.now();
  const r = spawnSync("deno", ["test", "-A", "--config", "deno.runner.jsonc", ...flags, ...files], {
    stdio: "inherit",
    cwd: ROOT,
    // The marker tests/00-use-npm-test_test.ts checks for.
    env: { ...process.env, CAP_TEST_RUNNER: "1" },
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (r.error && r.error.code === "ETIMEDOUT") {
    console.error(`select-tests: ${label} TIMED OUT after ${timeoutMs / 1000}s`);
    return 124;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.error(`select-tests: ${label} ${r.status === 0 ? "GREEN" : "FAILED"} in ${secs}s`);
  return r.status ?? 1;
}

// The shared two-phase partition (scripts/test-partition.mjs): serial hazards
// first (never parallel), the rest with --parallel — same shape as the gate.
// Exported so the 76hu before/after measurement can drive it directly.
export function runPartitioned(files) {
  const { serial, parallel } = partition(files);
  console.error(
    `select-tests: ${files.length} file(s) — partition: ${serial.length} serial hazard(s)${serial.length ? ` [${serial.join(", ")}]` : ""}, ${parallel.length} parallel`,
  );
  let rc = 0;
  if (serial.length) rc = runSerialFiles(serial, { cwd: ROOT });
  if (rc === 0 && parallel.length) rc = runPhase(parallel, ["--parallel"], "parallel phase", PARALLEL_PHASE_TIMEOUT_MS);
  return rc;
}

function runDeno(files) {
  if (!files.length) {
    console.error("select-tests: no test files selected — nothing to run.");
    process.exit(1);
  }
  console.error(`select-tests: ${files.length} file(s):\n  ${files.map((f) => `  ${f}`).join("\n")}`);
  process.exit(runPartitioned(files));
}

function runFullSuite() {
  // The full suite is the two-phase runner (npm test), never a bare sweep.
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/run-tests.mjs")], { stdio: "inherit", cwd: ROOT });
  process.exit(r.status ?? 1);
}

function main() {
  const args = process.argv.slice(2);
  const list = args.includes("--list");
  const coreOnly = args.includes("--core");
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : "origin/main";

  if (coreOnly) {
    const files = CORE.filter((c) => existsSync(join(ROOT, c)));
    if (list) console.log(files.join("\n"));
    else runDeno(files);
    return;
  }
  const changed = changedFiles(base);
  if (!changed.length) console.error(`select-tests: no files changed vs ${base} — running always-on core.`);
  const reverse = changed.length ? buildReverseGraph() : null;
  const uncovered = changed.length ? changedWithoutCoverage(changed, reverse) : [];

  // nco2: an uncovered file is not automatically unmappable. Two classes have no
  // import edges by construction and are covered by tests that read them as DATA;
  // map those to their guards. Everything else still fails closed — and now the
  // message names WHICH file and WHICH mechanism forced the full suite, because
  // "no reachable test" read identically for a harness nobody imports, a version
  // bump, and another lane's landing.
  const { mapped, unmappable } = uncovered.length
    ? mapUncovered(uncovered, (rel) => versionOnlyAgainst(mergeBaseOf(base), rel), testCorpus())
    : { mapped: [], unmappable: [] };

  // nco2/R1b: the selector's OWN machinery always runs the FULL suite, and this
  // check is over the CHANGED set rather than the uncovered set on purpose.
  //
  // Measured on the real graph: of the five infrastructure files, only
  // run-tests.mjs is import-unreachable. select-tests.mjs is imported by two
  // tests and the other three are reached transitively through it, so the graph
  // calls them COVERED and they never reach classifyUncovered at all. A check
  // that lived only in the mapping would therefore miss four of five.
  //
  // Why at all (cap-astra's re-review of 014177de): a subset chosen BY the thing
  // under test cannot validate that thing. Pointing run-tests.mjs's readdir at a
  // missing directory kills `npm test` instantly with ENOENT while
  // `npm run test:changed` stayed green over a 21-file subset — the selector
  // cheerfully certified a suite runner that cannot run.
  const selfChanged = changed.filter((f) => isSelectorInfrastructure(f));
  if (selfChanged.length) {
    console.error(
      `select-tests: FAIL CLOSED — this change edits the test selector's own machinery ` +
        `(${selfChanged.join(", ")}), so a subset it chooses cannot validate it.\n` +
        `Running the FULL suite (npm test) instead.`,
    );
    if (list) console.log("FULL_SUITE");
    else runFullSuite();
    return;
  }

  if (unmappable.length) {
    const why = unmappable.map((u) => `  ${u.file}\n      → ${u.mechanism}`).join("\n");
    console.error(
      `select-tests: FAIL CLOSED — changed file(s) with no reachable test cannot be proved covered by a subset:\n${why}\nRunning the FULL suite (npm test) instead.`,
    );
    if (list) console.log("FULL_SUITE");
    else runFullSuite();
    return;
  }
  for (const m of mapped) {
    console.error(`select-tests: ${m.file} has no importer — ${m.mechanism}; selecting its ${m.tests.length} inspecting guard(s).`);
  }
  const files = selectTestFiles(changed, reverse, mapped);
  if (list) console.log(files.join("\n"));
  else runDeno(files);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
