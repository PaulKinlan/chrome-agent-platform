// scripts/select-tests.mjs — dependency-aware deno test subsetting (9hoc).
//
//   node scripts/select-tests.mjs            run the subset: `deno test -A --parallel <files>`
//   node scripts/select-tests.mjs --list     print the selected test files, one per line
//   node scripts/select-tests.mjs --core     run the always-on core only (security/vocabulary)
//   node scripts/select-tests.mjs --base <ref>   compare against <ref> instead of origin/main
//
// WHY: the full suite (321 files) is the merge gate and stays exactly as it is
// (`deno test -A tests/`). This is ADDITIVE tooling so a per-commit gate can run
// in well under a minute: a changed file (git diff vs origin/main) selects the
// test files that transitively import it (static import graph), plus the always-on
// core (security + vocabulary). Tests that READ a file without importing it are a
// stated blind spot by design — the full suite covers them. Nothing is skipped or
// weakened; test:changed is a faster subset of the same assertions.

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
const IMPORT_RE = /\b(?:import|export)\s*(?:\(|\{)?[^'"]*?\bfrom\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']|import\s*\(\s*`([^`${]+)/g;

function importsOf(absPath) {
  if (!existsSync(absPath)) return [];
  const text = readFileSync(absPath, "utf8");
  const out = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (!spec || !spec.startsWith(".")) continue; // only relative repo imports
    const clean = spec.split("?")[0].split("#")[0];
    const resolved = resolve(dirname(absPath), clean);
    const found = resolvePath(resolved);
    if (found) out.push(found);
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

export function selectTestFiles(changed, reverse) {
  const selected = new Set(CORE.filter((c) => existsSync(join(ROOT, c))));
  const changedAbs = [];
  for (const c of changed) {
    const abs = resolve(ROOT, c);
    if (!existsSync(abs)) continue;
    if (/\.test\.(ts|js)$/.test(c)) selected.add(normalize(c)); // changed test files always run
    changedAbs.push(abs);
  }
  if (!changedAbs.length || !reverse) return [...selected].sort();

  const seen = new Set(changedAbs);
  const queue = [...changedAbs];
  const isTest = (p) => /^tests[\\/][^\\/]+\.test\.(ts|js)$/.test(relative(ROOT, p));
  while (queue.length) {
    const cur = queue.pop();
    for (const imp of reverse.get(cur) ?? []) {
      const rel = relative(ROOT, imp);
      if (isTest(imp)) {
        if (!rel.startsWith("..")) selected.add(rel);
      } else if (!seen.has(imp)) {
        seen.add(imp);
        queue.push(imp);
      }
    }
  }
  return [...selected].sort();
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
  const files = selectTestFiles(changed, reverse);
  if (list) console.log(files.join("\n"));
  else runDeno(files);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
