// scripts/select-tests.mjs — dependency-aware deno test subsetting (9hoc).
//
//   node scripts/select-tests.mjs            run the subset: `deno test -A <files>`
//   node scripts/select-tests.mjs --list     print the selected test files, one per line
//   node scripts/select-tests.mjs --core     run the always-on core only (security/vocabulary)
//   node scripts/select-tests.mjs --base <ref>   compare against <ref> instead of origin/main
//
// WHY: the full suite (321 files) is the merge gate and stays exactly as it is
// (`deno test -A tests/`). This is ADDITIVE tooling so a per-commit gate can run
// in well under a minute: a changed file (git diff vs origin/main) selects the
// test files that transitively import it (static import graph), plus the always-on
// core (security + vocabulary). FAIL CLOSED: a changed code/config file with no
// reachable test (nothing imports it, or it was deleted with no remaining
// importers) cannot be proved covered by a subset — the picker then runs the FULL
// suite instead of a silent core-only green. Nothing is skipped or weakened;
// test:changed is a faster subset of the same assertions.
//
// Subset runs match the gate semantics EXACTLY (serial `deno test -A` on the
// selected files): --parallel was measured and REJECTED because this suite has
// cross-file hazards (tests that regenerate shared build artifacts, spawn the
// Chrome-lock-bound security runner, or materialize /tmp trees race under
// concurrency and produce false reds).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- always-on core: security + vocabulary families (76 tests, ~3s) ----
export const CORE = [
  "tests/security.test.ts",
  "tests/secret-redaction.test.ts",
  "tests/security-suite-custody.test.ts",
  "tests/owner-approval-security.test.ts",
  "tests/vocabulary.test.ts",
];

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function changedFiles(base) {
  const tracked = git(["diff", "--name-only", base]).split("\n").filter(Boolean);
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
  for (const d of ["extension", "scripts", "lib", "packages", "tests"]) {
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

export function selectTestFiles(changed, reverse) {
  const selected = new Set(CORE.filter((c) => existsSync(join(ROOT, c))));
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

function runDeno(files) {
  if (!files.length) {
    console.error("select-tests: no test files selected — nothing to run.");
    process.exit(1);
  }
  console.error(`select-tests: ${files.length} file(s):\n  ${files.map((f) => `  ${f}`).join("\n")}`);
  // Subset runs match the gate semantics EXACTLY (serial `deno test -A` on the
  // selected files, same as the full suite restricted to them): --parallel was
  // measured and REJECTED because this suite has cross-file hazards (tests that
  // regenerate shared build artifacts, spawn the Chrome-lock-bound security
  // runner, or materialize /tmp trees race under concurrency and produce false
  // reds). A subset must differ from the gate only in WHICH files run, never in
  // how they run. The full suite stays `deno test -A tests/`.
  const r = spawnSync("deno", ["test", "-A", ...files], { stdio: "inherit", cwd: ROOT });
  process.exit(r.status ?? 1);
}

function runFullSuite() {
  const r = spawnSync("deno", ["test", "-A", "tests/"], { stdio: "inherit", cwd: ROOT });
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
  if (uncovered.length) {
    console.error(
      `select-tests: FAIL CLOSED — changed file(s) with no reachable test cannot be proved covered by a subset:\n  ${uncovered.join("\n  ")}\nRunning the FULL suite (deno test -A tests/) instead.`,
    );
    if (list) console.log("FULL_SUITE");
    else runFullSuite();
    return;
  }
  const files = selectTestFiles(changed, reverse);
  if (list) console.log(files.join("\n"));
  else runDeno(files);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
