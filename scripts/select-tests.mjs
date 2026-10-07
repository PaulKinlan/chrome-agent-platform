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

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenizer } from "acorn";
import { partition } from "./test-partition.mjs";
import { announce, runSerialFiles } from "./lib/serial-phase.mjs";

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

  // chrome-agent-platform-p1lp: tests/chrome-tools-t12.test.ts walks the extension root through a
  // LOWERCASE alias — `const root = new URL("../extension/", import.meta.url)` then `await walk(root)` —
  // which the kz27 widening missed because that pattern demanded an UPPERCASE identifier. That is the
  // original failure mode in a different spelling: a guard that reads tracked source as data with no
  // import edge, invisible to the audit. Its assertion is cross-cutting (no extension source may
  // reference the single-driver lease), and the walk is pure static file reading with NO spawn and no
  // browser, so it is host-independent and costs milliseconds — the three properties an always-on
  // guard must have (the lesson from qepn/3bv7/j3o1). Adjudicated IN as its OWN file, not as the whole
  // 24-test tool-capability KAT: the repo's established remedy for a mixed file is the split
  // (tests/quiet-window-static.test.ts, tests/chrome-profile-static.test.ts), and promoting the whole
  // file would run 23 unrelated KATs in every subset gate for this one invariant (reviewer P2).
  // BUILD BEHAVIOUR, corrected after review: THIS entry has no build precondition — it reads raw .js
  // under extension/ and skips dist/, so it passes on a worktree that has never built. The file it was
  // split from does import built bundles, which is a property of that file, not of this guard. More
  // generally: in `npm test` the serial build phase runs before the parallel phase, while a SUBSET gate
  // runs the serial phase only for its SELECTED files, so a never-built worktree can fail a
  // build-reading guard on a missing module — pre-existing (tests/owner-approval-security.test.ts is in
  // CORE and already imports dist), and worth knowing when adding an entry that does read dist.
  "tests/chrome-tools-t12-static.test.ts",
  // chrome-agent-platform-p1lp: the shape whitelist also caught a pure census guard that reads the
  // shipped pages as data — every one of its five tests is about that census, so it is promoted whole.
  "tests/unbundled-page-census.test.ts",
  // chrome-agent-platform-p1lp: caught by the delta review, not by my own probe. Its detector signal is a
  // LIST OF DIRECTORIES (SCAN_ROOTS = ["scripts", "cap-evidence", "tests"]) and its walks are computed
  // (`${ROOT}${root}`), so it evaded both the SCAN_DIRS pattern and the shape whitelist; the pattern now
  // covers the SCAN_(DIRS|ROOTS|TREES) family. Adjudicated IN: all three of its tests are the same
  // census over tracked source, it spawns nothing (the chrome-journeys mentions are prose in comments),
  // and it reads files, so it is cheap and host-independent.
  "tests/composer-selector-migration.test.ts",
  // chrome-agent-platform-p1lp: the same symmetry caught a real repo-walker that reads the tests
  // directory as data — `const TESTS_DIR = fileURLToPath(new URL("./", import.meta.url))` then a walk of
  // every test file. It asserts a cross-cutting invariant, is a static text walk, and is cheap, so it is
  // adjudicated IN.
  "tests/chrome-lock-fixture-scope.test.ts",
  // chrome-agent-platform-ygxk: promoted WHOLE, with the measurement that justifies not splitting it.
  // It is the repo-walking guard p1lp's widened detector caught (it reads the tests directory as data
  // through `const TESTS = `${ROOT}tests/``), and it was held out only while it was RED — the fix is the
  // documented-expectation update in the same commit, not a loosened comparison.
  // WHY NOT THE SPLIT: coord's pattern (chrome-tools-t12) exists to keep a mixed file's expensive or
  // host-dependent half out of every subset gate. Measured here, the two halves are not like that. The
  // file's cost is the CENSUS — 4.0s on the first test, memoised afterwards — and every invariant test
  // needs it; the resolver unit tests that make the file 'mixed' cost ~4ms in total (4s, 409µs, 148µs,
  // 1ms, 968µs, 1ms, 463µs, 874µs, 90µs, 177µs, 10ms, 3ms, 1ms, 410µs). So promoting the whole file adds
  // the census and essentially nothing else, while extracting the machinery into a helper would put the
  // repo WALK somewhere the detector does not scan (tests/helpers/*.ts) — reopening exactly the hole
  // p1lp closed. It reads tracked source, spawns nothing and needs no browser, so it is host-independent
  // and the cost is disclosed here for the always-on budget: ~4s at low load.
  "tests/substring-pin-honesty.test.ts",
  // chrome-agent-platform-4h47: the READ-SIDE guard for the dead `requiresOwnerGesture`
  // column. It resolves every mention of the name across the tracked tree and asserts the
  // file set is exactly an explicit allowlist-with-reasons, so no future lane can start
  // reading the column as an authority without failing by name. It has no import edge to the
  // files it inspects (git grep + the allowlist), which is precisely the cross-cutting shape
  // AGENTS.md coupling rule 4 (dqc1) says a subset gate cannot see, so it is always-on. Kept
  // as its OWN file rather than folded into the capability KAT: that file is 24 capability
  // tests, and promoting it would run all of them in every subset gate for this one
  // invariant (the p1lp mixed-file split lesson). Cost: one `git grep` spawn over the tracked
  // tree, no browser, no build.
  "tests/requires-owner-gesture-column-allowlist.test.ts",
  // chrome-agent-platform-mzd6: asserts that waitForServiceWorker defaults to SW_MATCH
  // and no script declares private or ad-hoc duplicate service-worker match filters.
  // It reads scripts/ as data without import edges, so it is registered in ALWAYS_ON.
  "tests/kat-service-worker-match.test.ts",
  // chrome-agent-platform-elst: asserts that real-browser tests and KAT harnesses
  // reap their full process tree carrying a profile, not a bare proc.kill().
  // It reads tests/ and scripts/ as data, so it is registered in ALWAYS_ON.
  "tests/real-browser-teardown.test.ts",
];

/**
 * Repo-tree scanners that are DELIBERATELY not always-on, each with a reason and the bead that owns
 * the follow-up (chrome-agent-platform-kz27). An exclusion has to be WRITTEN DOWN and justified rather
 * than being an accidental omission — the same principle as the list itself, and the reason this is a
 * declaration rather than a missing line: with the detector widened, omitting the entry makes the
 * audit FAIL CLOSED, which is the detector working as intended.
 */
export const SCANNER_EXCLUSIONS = Object.freeze({
  // chrome-agent-platform-p1lp: a genuine repo-walker (`const TESTS = `${ROOT}tests/``, then a walk of
  // every test file to catch vacuous .includes() pins) — and NOT promoted while it is RED. It fails
  // "the attributed population and its documented exclusions" on current main, adjudicated by running it
  // with main's versions of this bead's files swapped in, so the failure is not caused here. An
  // always-on guard that is red on main makes EVERY subset gate red, which is worse than the gap it
  // closes; promotion is owed the moment that red is fixed, and the red itself needs its own bead.
  // chrome-agent-platform-p1lp: caught by the widened detector, and DELIBERATELY not always-on for the
  // reason the architecture demands — this file is 16 tests of manifest/schema/import policy over
  // fixtures, and only ONE of them walks the extension tree. Promoting it would run fifteen unit tests
  // in every subset gate to cover one static invariant, which is the mixed-file mistake the split
  // pattern exists to avoid. The invariant is real and should be split into its own -static file the way
  // tests/chrome-tools-t12 was here; until that happens this entry is the written-down decision rather
  // than a silent hole. Follow-up owed by chrome-agent-platform-p1lp.
  "tests/wasm-package-authority.test.ts":
    "one of its 16 tests walks extension/ (walk(fileURLToPath(new URL('../extension', import.meta.url)))) while the other fifteen are manifest/schema policy unit tests over fixtures, so promoting the file would run fifteen unit tests in every subset gate for one static invariant. The established remedy is the split (tests/quiet-window-static.test.ts, tests/chrome-profile-static.test.ts, and tests/chrome-tools-t12-static.test.ts from this same bead). Follow-up owed by chrome-agent-platform-p1lp.",
  // chrome-agent-platform-p1lp: it walks `${ROOT}scripts` to find load-sensitive harnesses, so it IS a
  // repo-walker — but the file is a 15-test harness for the heavy-gate slot that SPAWNS processes to
  // take and hold the slot, so it fails the host-independent and cost-budgeted criteria an always-on
  // entry must meet. Its static half belongs in its own file, as above.
  "tests/heavy-gate-slot.test.ts":
    "it walks ${ROOT}scripts to find load-sensitive harnesses, but the file is a 15-test harness for the heavy-gate slot itself and spawns processes to take and hold that slot, so it fails the host-independent and cost-budgeted criteria for an always-on entry (the qepn/3bv7/j3o1 lesson). Its static census belongs in its own -static file; that split is owed by chrome-agent-platform-p1lp.",
  "tests/quiet-window.test.ts":
    "its BURNER helper locates the real esbuild binary by reading a ROOT-rooted node_modules path, which the widened detector matches because the pattern accepts any ROOT-rooted read. That read is a fixture lookup, not a scan of tracked source, and it is NOT the reason this file is interesting: its tracked-source assertions (registry <-> source consistency, the no-interference pin, the journey harness's exit wiring) were SPLIT into tests/quiet-window-static.test.ts, which is always-on and spawns nothing. The file itself must stay out of the set because it spawns real esbuild --minify burners and costs 23s, tripling every subset gate and injecting compiler load during other lanes' gates — see chrome-agent-platform-fgik. p1lp RESULT: the exclusion is STILL NECESSARY, and that is a residual detection limit rather than an oversight. Narrowing the walk pattern moved the match to the ROOT-rooted read instead: `Deno.readDir(`${ROOT}node_modules/@esbuild`)` matches /Deno\.readDir\(\s*`\$\{ROOT\}/, so the detector still sees a ROOT-rooted directory read. Distinguishing 'reads node_modules' from 'walks tracked source' needs the TARGET PATH, not the root, and no pattern-based detector here has that — so the decision stays written down in this list, where a reader can find it.",
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
const URL_INSTRUMENT_RE = /new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;

// A fixture that QUOTES `new URL(...)` is not a module importer. Acorn's
// tokenizer locates inert strings, template text, regexps and comments without
// executing the file; template ${...} expressions remain live code. A future
// unsupported syntax cannot quietly hide an edge: on lexer failure retain it.
function inertRanges(text) {
  const ranges = [];
  try {
    const tokens = tokenizer(text, {
      ecmaVersion: "latest", sourceType: "module", allowHashBang: true,
      onComment: (_block, _comment, start, end) => ranges.push([start, end]),
    });
    for (;;) {
      const token = tokens.getToken();
      if (token.type.label === "eof") break;
      if (["string", "template", "regexp", "`"].includes(token.type.label)) ranges.push([token.start, token.end]);
    }
  } catch {
    return null;
  }
  return ranges;
}

export function codeUrlInstrumentSpecs(text) {
  const matches = [...text.matchAll(URL_INSTRUMENT_RE)];
  const inert = matches.length ? inertRanges(text) : [];
  return matches.filter((m) => !inert?.some(([start, end]) => m.index >= start && m.index < end))
    .map((m) => m[1].trim());
}

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
  // Link real code instruments via new URL(..., import.meta.url) (1smd),
  // but not identical text quoted inside test fixtures (i0rf N1).
  for (const spec of codeUrlInstrumentSpecs(text)) {
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

export const DEFAULT_PARALLEL_TIMEOUT_MS = 1800_000;
const PARALLEL_PHASE_TIMEOUT_MS = Number(process.env.CAP_PARALLEL_TEST_TIMEOUT_MS ?? DEFAULT_PARALLEL_TIMEOUT_MS);

function runPhase(files, flags, label, timeoutMs = 300_000) {
  // Deno schedules parallel files independently; print candidate names first
  // so a mid-phase kill retains attribution without falsely naming a culprit.
  announce(`select-tests: ${label} candidates (${files.length} file(s)):\n${files.map((file) => `  - ${file}`).join("\n")}`);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn("deno", ["test", "-A", "--config", "deno.runner.jsonc", ...flags, ...files], {
      stdio: "inherit",
      cwd: ROOT,
      // The marker tests/00-use-npm-test_test.ts checks for.
      env: { ...process.env, CAP_TEST_RUNNER: "1" },
      detached: true,
    });

    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
        }
      }, timeoutMs);
    }

    const onSig = (sig) => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
      }
      process.removeListener("SIGTERM", onSigTerm);
      process.removeListener("SIGINT", onSigInt);
      process.kill(process.pid, sig);
    };
    const onSigTerm = () => onSig("SIGTERM");
    const onSigInt = () => onSig("SIGINT");
    process.on("SIGTERM", onSigTerm);
    process.on("SIGINT", onSigInt);

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      process.removeListener("SIGTERM", onSigTerm);
      process.removeListener("SIGINT", onSigInt);
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* clean */ }
      }
    };

    child.on("close", (code, signal) => {
      cleanup();
      if (timedOut) {
        announce(`select-tests: ${label} TIMED OUT after ${timeoutMs / 1000}s`);
        announce(`select-tests: TIMED-OUT ${label.toUpperCase()} CANDIDATE FILE(S) (culprit unconfirmed):`);
        for (const file of files) announce(`  - ${file} (${label} timed out; individual culprit unknown)`);
        resolve(124);
        return;
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.error(`select-tests: ${label} ${code === 0 ? "GREEN" : "FAILED"} in ${secs}s`);
      resolve(code ?? (signal ? 128 + 15 : 1));
    });

    child.on("error", (err) => {
      cleanup();
      console.error(`select-tests: ${label} spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

// The shared two-phase partition (scripts/test-partition.mjs): serial hazards
// first (never parallel), the rest with --parallel — same shape as the gate.
// Exported so the 76hu before/after measurement can drive it directly.
export async function runPartitioned(files) {
  const { serial, parallel } = partition(files);
  console.error(
    `select-tests: ${files.length} file(s) — partition: ${serial.length} serial hazard(s)${serial.length ? ` [${serial.join(", ")}]` : ""}, ${parallel.length} parallel`,
  );
  let rc = 0;
  if (serial.length) rc = runSerialFiles(serial, { cwd: ROOT });
  if (rc === 0 && parallel.length) rc = await runPhase(parallel, ["--parallel"], "parallel phase", PARALLEL_PHASE_TIMEOUT_MS);
  return rc;
}

async function runDeno(files) {
  if (!files.length) {
    console.error("select-tests: no test files selected — nothing to run.");
    process.exit(1);
  }
  console.error(`select-tests: ${files.length} file(s):\n  ${files.map((f) => `  ${f}`).join("\n")}`);
  process.exit(await runPartitioned(files));
}

function runFullSuite() {
  // The full suite is the two-phase runner (npm test), never a bare sweep.
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/run-tests.mjs")], { stdio: "inherit", cwd: ROOT });
  process.exit(r.status ?? 1);
}

async function main() {
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
    else await runDeno(files);
    return;
  }
  if (coreOnly) {
    const files = CORE.filter((c) => existsSync(join(ROOT, c)));
    if (list) console.log(files.join("\n"));
    else await runDeno(files);
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
  else await runDeno(files);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
