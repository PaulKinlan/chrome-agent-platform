// scripts/select-tests.mjs — dependency-aware deno test subsetting (9hoc).
//
//   node scripts/select-tests.mjs            run the subset: `deno test -A <files>`
//   node scripts/select-tests.mjs --list     print the selected test files, one per line
//   node scripts/select-tests.mjs --core     run the always-on core only (security/vocabulary)
//   node scripts/select-tests.mjs --always-on   run EXACTLY the always-on set (core + source-inspecting
//                                                guards) — the set a subset gate cannot be trusted to
//                                                cover (chrome-agent-platform-kz27)
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
  "tests/wasm-catalogue-status-truth.test.ts",
  "tests/wasm-manifest-rebuild-ref.test.ts",
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
  "tests/postmessage-wildcard-guard.test.ts",
  // chrome-agent-platform-kz27 — tree-walking guards that were MISSING from this list, which is the
  // third shape of the blind spot that bead names: a guard everyone BELIEVES is always-on, simply not
  // in the set. tests/durable-root.test.ts is the measured case, and the cost was concrete: it sat
  // outside, so test:changed selected it in NONE of the night's gates, and its violation lived on
  // main through three of them while each gate reported green. The others were found by widening the
  // qcfc audit's detector to the shape that actually matters — a walk ROOTED AT THE REPO TREE — rather
  // than "uses a directory API", which a dozen fixture-reading tests do harmlessly.
  // tests/chrome-profile-location.test.ts also matches that shape and is held out BY DECLARATION
  // instead of by omission: see SCANNER_EXCLUSIONS just below, which says why.
  // tests/chrome-profile-location.test.ts is NOT here, and that is a contract decision rather than an
  // omission: its live race test launches a real browser, and docs/CHROME-TEST-CONTRACT.md §2.3 PROMISES
  // that a subset gate launches a browser only when that file or its dependencies changed. Its
  // cross-cutting half — the static scan of scripts/ for repo-resident Chrome profiles, which reads
  // tracked source as data and therefore has no import edges — was SPLIT OUT into
  // tests/chrome-profile-static.test.ts, which IS always-on below. See SCANNER_EXCLUSIONS for the
  // browser-dependent remainder.
  "tests/durable-root.test.ts",
  "tests/dialog-confirm-modernization.test.ts",
  "tests/single-source-helpers.test.ts",
  "tests/chrome-profile-static.test.ts",
  // F3 (delta review of c1a77598): the widened detector then caught these — all real repo-walking
  // guards that read tracked source as data, none needing a browser. Adjudicated individually rather
  // than added wholesale: machine-path-honesty walks tests/ and scripts/; settings-strings-audit walks
  // extension/; quiet-window reads a ROOT-rooted path (node_modules) with no import edge for that read,
  // and inclusion is the conservative and cheap direction for a test that guards gate behaviour.
  "tests/chrome-test-contract.test.ts",
  "tests/code-health.test.ts",
  "tests/machine-path-honesty.test.ts",
  "tests/settings-strings-audit.test.ts",
  // fgik F1: tests/quiet-window.test.ts was here and costs 23s because it spawns REAL esbuild --minify
  // burners — while the other thirty guards together cost ~10-12s, so this one file tripled every
  // subset gate AND injected compiler load onto 2-vCPU lanes DURING other lanes' gates, which is worse
  // than the seconds because our serial red count tracks LOAD. Its TRACKED-SOURCE assertions (the
  // harness registry <-> source consistency, the no-interference pin, the journey harness's exit
  // wiring) were split into tests/quiet-window-static.test.ts — 3 tests, ZERO spawns, measured 32ms —
  // and THAT is always-on below; the burner workload stays in npm test where it belongs.
  "tests/quiet-window-static.test.ts",
];

/**
 * Repo-tree scanners that are DELIBERATELY not always-on, each with a reason and the bead that owns
 * the follow-up (chrome-agent-platform-kz27). An exclusion has to be WRITTEN DOWN and justified rather
 * than being an accidental omission — the same principle as the list itself, and the reason this is a
 * declaration rather than a missing line: with the detector widened, omitting the entry makes the
 * audit FAIL CLOSED, which is the detector working as intended.
 */
export const SCANNER_EXCLUSIONS = Object.freeze({
  "tests/quiet-window.test.ts":
    "its BURNER helper locates the real esbuild binary by reading a ROOT-rooted node_modules path, which the widened detector matches because the pattern accepts any ROOT-rooted read. That read is a fixture lookup, not a scan of tracked source, and it is NOT the reason this file is interesting: its tracked-source assertions (registry <-> source consistency, the no-interference pin, the journey harness's exit wiring) were SPLIT into tests/quiet-window-static.test.ts, which is always-on and spawns nothing. The file itself must stay out of the set because it spawns real esbuild --minify burners and costs 23s, tripling every subset gate and injecting compiler load during other lanes' gates — see chrome-agent-platform-fgik. NOTE FOR p1lp: fixing the detector to match KNOWN SOURCE ROOTS explicitly (rather than any uppercase identifier or ROOT-rooted read) would make this exclusion unnecessary, since the only matched read is node_modules.",
  "tests/chrome-profile-location.test.ts":
    "it still matches the repo-walk detector through its helper reads, but it also holds the LIVE race test that launches a real browser — and docs/CHROME-TEST-CONTRACT.md §2.3 PROMISES that a subset gate launches a browser only when this file or its dependencies changed. Listing it as always-on would break that promise fleet-wide, on every VM without a working browser. Its cross-cutting half (the static scripts/ scan) was SPLIT OUT into tests/chrome-profile-static.test.ts, which is always-on; what remains here is helper semantics plus the live race, and the environmental-refusal path that would let the browser case report honestly is chrome-agent-platform-hlgr.",
});

/**
 * The always-on guard files that exist on disk (chrome-agent-platform-kz27).
 * Exposed because a SUBSET gate cannot see them: they have no static import edges, so a FAIL-CLOSED
 * selector, a focused test:file run, and a serial failure that skips the parallel phase each hide
 * them. Whatever else a gate does, a lane must be able to run exactly this set.
 */
export function alwaysOnGuards() {
  return ALWAYS_ON.filter((f) => existsSync(join(ROOT, f)));
}

/**
 * What a FAIL-CLOSED selection must do (chrome-agent-platform-kz27). Pure and exported so the
 * regression test can prove the always-on guard set is SURFACED rather than asserting the shape of a
 * print statement: a lane told only "FULL_SUITE" has no way to learn which guards it just failed to
 * run, which is exactly how the jfbn and fyvc violations reached main.
 * @returns {{ output: string[], action: "list" | "run" }}
 */
export function failClosedPlan({ uncovered, list }) {
  const guards = alwaysOnGuards();
  return {
    action: list ? "list" : "run",
    output: [
      `select-tests: FAIL CLOSED — changed file(s) with no reachable test cannot be proved covered by a subset:`,
      ...uncovered.map((f) => `  ${f}`),
      `Running the FULL suite (npm test) instead.`,
      `select-tests: THE ALWAYS-ON GUARD SET (${guards.length} files) IS NOT COVERED BY A SUBSET GATE — run these explicitly if you cannot run the full suite:`,
      ...guards.map((f) => `  ${f}`),
      // F2 (delta review, c1a77598): the fail-closed report must say the same thing `--always-on`
      // warns about, in words, so a lane cannot read "I ran the guards and they were green" as "my
      // change is verified".
      `select-tests: NOTE — running that guard set covers the cross-cutting guards, but it does NOT ` +
        `run the tests your changed files select and it does NOT run the full suite, so a green result ` +
        `there DOES NOT VALIDATE YOUR CHANGES.`,
    ],
  };
}

export const ALWAYS_ON = Object.freeze([
  ...CORE,
  ...SOURCE_INSPECTING_GUARDS,
]);

function git(args, cwd = ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Build scratch is not a source change (chrome-agent-platform-nz2r). A killed
// build leaves extension/.dist-stage-<pid>-<ts>/ and the lock files behind,
// untracked; this candidate list used to carry them into the coverage check, so
// `test:changed` fell closed to the FULL suite until a human deleted them — on a
// box where an interrupted build is normal, that is a 30-second gate turning
// into a suite that cannot finish. .gitignore excludes the same family (the
// first defence); this predicate is the SECOND, so the gate stays immune even in
// a worktree whose ignore rules are stale or were bypassed. Family kept in step
// with scripts/evidence-runner.sh's leftover census.
const BUILD_RESIDUE_PREFIXES = [
  "extension/.dist-stage-",
  "extension/.dist-link-",
  "extension/.dist-prev-",
  ".build.lock",
  ".lock-stage-",
  ".lock-quarantine-",
  ".owner.tmp-",
];

/** True for build scratch that must never count as a changed source file. */
export function isBuildResidue(file) {
  const f = String(file).replace(/^\.\//, "");
  return BUILD_RESIDUE_PREFIXES.some((prefix) => f.startsWith(prefix));
}

function changedFiles(base) {
  const tracked = git(["diff", "--name-only", base]).split("\n").filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untracked])]
    .map((f) => normalize(f))
    .filter((f) =>
      !isBuildResidue(f) &&
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

export function selectTestFiles(changed, reverse) {
  const selected = new Set(ALWAYS_ON.filter((c) => existsSync(join(ROOT, c))));
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
  const alwaysOnOnly = args.includes("--always-on");
  const baseIdx = args.indexOf("--base");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : "origin/main";

  if (alwaysOnOnly) {
    // EXACTLY the always-on set (core + source-inspecting guards), runnable on its own
    // (chrome-agent-platform-kz27): a guard result must never depend on a subset gate selecting it.
    //
    // F2 (delta review, c1a77598): this mode exits 0 having verified ONLY the guards. It does not run
    // the tests the changed files select and it does not run the full suite, so a green here DOES NOT
    // VALIDATE YOUR CHANGES — and this branch's own gate used this mode, which is exactly how its two
    // new tests went unexecuted by the gate that cleared it. The warning is printed on stderr in BOTH
    // modes, so a lane that reads the result cannot mistake it for a full verification, and `--list`
    // stays clean on stdout for callers that parse it.
    const files = alwaysOnGuards();
    console.error(
      `select-tests: WARNING — --always-on runs ONLY the always-on set (${files.length} files). It does ` +
        `NOT run the tests your changed files select, and it does NOT run the full suite: a green ` +
        `result here DOES NOT VALIDATE YOUR CHANGES. Use it to cover the guards a subset gate cannot ` +
        `see, never as the whole gate.`,
    );
    if (list) console.log(files.join("\n"));
    else runDeno(files);
    return;
  }
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
    const plan = failClosedPlan({ uncovered, list });
    console.error(plan.output.join("\n"));
    if (plan.action === "list") console.log("FULL_SUITE");
    else runFullSuite();
    return;
  }
  const files = selectTestFiles(changed, reverse);
  if (list) console.log(files.join("\n"));
  else runDeno(files);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
