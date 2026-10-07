// tests/source-inspecting-tests-guard.test.ts — bead chrome-agent-platform-qcfc.
//
// Invariant: tests that read tracked source as data (AST census, source scans,
// whole-tree property guards) have no static import edges in the dependency
// graph, so a per-commit changed-set gate (test:changed) would never select them.
// They MUST be in SOURCE_INSPECTING_GUARDS (part of ALWAYS_ON in select-tests.mjs).
//
// This guard audits all test files to ensure:
//   1. Every declared source-inspecting guard exists on disk.
//   2. selectTestFiles always includes every always-on guard.
//   3. Changing service-worker.js selects the authority census and modularization tests.
//   4. Self-checking audit: any test performing dynamic repository tree scans or AST
//      census of tracked files without being in ALWAYS_ON fails RED.
//   5. Falsification: an unlisted source-inspecting test fails the audit closed.
//   6. 2irv: repo-walking modules outside tests/ reachable from tests have an ALWAYS_ON consumer.
//   7. p4tf: no test or script under tests/ or scripts/ invokes find for file absence or inspection (box hazard).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  ALWAYS_ON,
  CORE,
  ROOT,
  SCANNER_EXCLUSIONS,
  SOURCE_INSPECTING_GUARDS,
  buildReverseGraph,
  changedWithoutCoverage,
  codeUrlInstrumentSpecs,
  selectTestFiles,
} from "../scripts/select-tests.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { enumerateRunnerTests } from "../scripts/run-tests.mjs";

/** Test-looking modules are terminal graph nodes, even if the runner never executes them. */
export const IS_TEST_RE = /\.test\.(ts|js)$/;

/** Fixtures are data; only runner-enumerated *.test.ts files outside fixtures can supply audit credit. */
export function isCreditableRunnerTest(rel: string): boolean {
  return rel.startsWith("tests/") && rel.endsWith(".test.ts") &&
    !/(?:^|\/)(?:fixtures|node_modules)\//.test(rel);
}

// NEW-3: Exact paths of real-tree falsification fixtures that could be left by SIGKILL.
export const AFPL_REAL_TREE_FIXTURES: Record<string, string> = {
  "tests/helpers/zz-afpl-depth2-walk.ts":
    `// Real depth-2 helper walking repo root via ../../\nconst root = new URL("../../", import.meta.url);\nexport function census() { for (const f of Deno.readDirSync(root)) void f; }\n`,
  "tests/helpers/zz-afpl-prose-only.ts":
    `// Shared helper. Deliberately does NOT shell out to git ls-files; it reads two files.\n// See SCAN_DIRS and GUARD_ROOTS for context.\nexport function add(a: number, b: number): number { return a + b; }\n`,
  "tests/helpers/zz-afpl-fixture-read.ts":
    `import { join } from "node:path";\nconst ROOT = "/repo";\nexport function list() { for (const f of Deno.readDirSync(join(ROOT, "tests", "fixtures"))) void f; }\n`,
  "tests/helpers/zz-afpl-preexisting-sibling.ts":
    "// Pre-existing sibling helper\nexport const ok = true;\n",
};
export const AFPL_REAL_TREE_RESIDUE = [
  "tests/helpers/zz-afpl-depth2-walk.ts",
  "tests/helpers/zz-afpl-prose-only.ts",
  "tests/helpers/zz-afpl-fixture-read.ts",
  "tests/helpers/zz-afpl-preexisting-sibling.ts",
];

export function reconcileAfplRealTreeResidue(): void {
  for (const rel of AFPL_REAL_TREE_RESIDUE) {
    try {
      Deno.removeSync(join(ROOT, rel));
    } catch {
      /* absent — fine */
    }
  }
}
// Run reconciliation at module evaluation so any residue from a killed run is swept
// BEFORE any Deno.test (including qcfc: self-checking audit) evaluates.
reconcileAfplRealTreeResidue();

Deno.test("afpl: SIGKILL residue is reconciled before the audit scans the tree", () => {
  const helpersDir = join(ROOT, "tests", "helpers");
  const hadHelpers = existsSync(helpersDir);
  if (!hadHelpers) {
    Deno.mkdirSync(helpersDir, { recursive: true });
  }
  assertEquals(Object.keys(AFPL_REAL_TREE_FIXTURES).sort(), [...AFPL_REAL_TREE_RESIDUE].sort());
  for (const [rel, body] of Object.entries(AFPL_REAL_TREE_FIXTURES)) {
    Deno.writeTextFileSync(join(ROOT, rel), body);
  }
  reconcileAfplRealTreeResidue();
  for (const rel of AFPL_REAL_TREE_RESIDUE) {
    assertEquals(existsSync(join(ROOT, rel)), false, `residue ${rel} must be reconciled`);
  }
  if (!hadHelpers) {
    try {
      Deno.removeSync(helpersDir);
    } catch {
      /* ignore */
    }
  }
});

Deno.test("qcfc: every declared source-inspecting guard exists on disk", () => {
  for (const file of SOURCE_INSPECTING_GUARDS) {
    assert(existsSync(join(ROOT, file)), `guard ${file} must exist on disk`);
  }
  assert(SOURCE_INSPECTING_GUARDS.length >= 10, "guards set must be populated");
});

Deno.test("qcfc: selectTestFiles always selects the full ALWAYS_ON set (core + source-inspecting)", () => {
  const selected = selectTestFiles([], null);
  for (const file of ALWAYS_ON) {
    if (existsSync(join(ROOT, file))) {
      assert(selected.includes(file), `${file} must be selected by selectTestFiles`);
    }
  }
});

Deno.test("qcfc: changing service-worker.js selects sw-dispatch-authority-census and sw-route-modularization", () => {
  const reverse = buildReverseGraph();
  const selected = selectTestFiles(["extension/background/service-worker.js"], reverse);
  assert(
    selected.includes("tests/sw-dispatch-authority-census.test.ts"),
    "sw-dispatch-authority-census.test.ts must be selected when service-worker.js changes",
  );
  assert(
    selected.includes("tests/sw-route-modularization.test.ts"),
    "sw-route-modularization.test.ts must be selected when service-worker.js changes",
  );
});

// Self-checking audit: identifies test files that perform dynamic tree-wide source scans
// or AST parsing of repo source files as data.
export function findUnclassifiedSourceScanners(
  testFiles: { rel: string; code: string }[],
  alwaysOnSet: Set<string>,
): string[] {
  const unclassified: string[] = [];
  const SCANNER_PATTERNS = [
    // A test that declares a LIST OF DIRECTORIES to scan is the audit's target shape whatever the
    // constant is called. `SCAN_DIRS` alone missed tests/composer-selector-migration.test.ts, whose
    // list is named SCAN_ROOTS and whose walks are computed (`${ROOT}${root}`), so both the name pattern
    // and the shape whitelist stepped over a real repo-scanning guard (delta review P2).
    /SCAN_(?:DIRS|ROOTS|TREES)/i,
    /filesUnder\s*\(/i,
    /extractAllRegisteredRoutes/i,
    /git\s+ls-files/i,
    // chrome-agent-platform-kz27: the four patterns above missed a whole SHAPE of guard — one that
    // WALKS the repository tree to read tracked source as data. That is how tests/durable-root.test.ts
    // sat outside ALWAYS_ON while three separate gates failed to select it, and a violation lived on
    // main through all three. "Uses a directory API" is deliberately NOT the signal: a dozen tests
    // read their own temp fixtures that way and belong in neither set. The signal is a walk rooted at
    // the repo tree, which a fixture reader does not do.
    /walk\(\s*`\$\{ROOT\}/,
    /walk\(\s*ROOT\b/,
    /readDirSync\(\s*ROOT\b/,
    /GUARD_ROOTS/,
    // F3 (delta review of c1a77598): the patterns above only matched literal ROOT / GUARD_ROOTS, so two
    // real repo-walking guards were invisible to the audit — tests/chrome-test-contract.test.ts
    // (async Deno.readDir(`${ROOT}tests`)) and tests/code-health.test.ts (walk(EXTENSION_DIR)). Widened
    // to the ASYNC ROOT-rooted read and to a walk rooted at any module-level ROOT-derived const, which
    // is the shape a sub-tree census takes. Both were then adjudicated into ALWAYS_ON, and so were the
    // three further guards this caught.
    /Deno\.readDir\(\s*`\$\{ROOT\}/,
    /readDir\(\s*`\$\{ROOT\}/,
  ];

  // chrome-agent-platform-p1lp — SYMMETRY, not just coverage. The kz27 widening used
  // /walk\(\s*[A-Z][A-Z0-9_]*\b/, which failed in BOTH directions:
  //   UNDER-MATCH: it demanded an uppercase identifier, so tests/chrome-tools-t12.test.ts's
  //     `await walk(root)`, where `const root = new URL("../extension/", import.meta.url)`,
  //     escaped the audit entirely — the original failure mode in a different spelling.
  //   OVER-MATCH: it matched ANY uppercase identifier, so a file that merely walked a fixture
  //     directory looked like a scanner.
  // A bare name list cannot fix this, because `walk(root)` is ALSO how a dozen tests traverse a
  // DOM tree (tests/agent-permissions-panel.test.ts passes an Element). The identifier's SHAPE
  // carries no information; its DEFINITION does. So a walk/read counts as a scanner only when the
  // thing being walked is a repo source root, established two ways:
  //   (1) a KNOWN source-root constant (the uppercase set below), or
  //   (2) an identifier THIS FILE defines from a source-root path ("../extension/", ROOT, ...).
  // Anything else — a fixture dir, a temp dir, a DOM node, a parsed tree — is not a scanner
  // signal, which is what keeps a non-scanner out of the always-on set.
  const KNOWN_SOURCE_ROOTS = /^(?:ROOT|EXT|EXTENSION_DIR|TESTS|TESTS_DIR|SCRIPTS|SCRIPTS_DIR|ROOT_DIR|GUARD_ROOTS)$/;
  const TOP_LEVEL_DIRS = "extension|scripts|tests|lib|packages";
  // What counts is a walk ROOTED AT THE REPO TREE, or at a TOP-LEVEL source dir, because that is the
  // shape that reads the repository as data. A walk of a SUB-root (extension/wasm/cas,
  // extension/wasm/manifests, scripts/git-hooks, a probe dir inside extension/) is a data or fixture
  // read, and admitting that class is how a 23s esbuild-spawning file entered the always-on set
  // (chrome-agent-platform-fgik).
  //
  // The expression is judged by the SHAPES that genuinely denote such a root, listed explicitly, rather
  // than by loosely matching a dir name anywhere in the text. Loose matching was tried first and it
  // flagged `const probe = `${extension}/_emscripten_abi_probe`` (a temp probe dir INSIDE extension)
  // and `path.join(..., "scripts", "git-hooks")` (a subdir) — both false positives of exactly the
  // over-match class this bead exists to prevent.
  const REPO_ROOT_URL = /new URL\(\s*["']\.\.(?:\/\.\.)*\/?["']/;
  const TOP_LEVEL_URL = new RegExp(`new URL\\(\\s*["']\\.\\.(?:\\/\\.\\.)*\\/(?:${TOP_LEVEL_DIRS})\\/?["']`);
  // path.join(..., "extension") — the LAST literal is a top-level dir and closes the call.
  const JOIN_ENDS_AT_TOP_LEVEL = new RegExp(
    `(?:ROOT|\\$\\{[^}]*\\}|["'][^"']*\\.\\.\\/(?:${TOP_LEVEL_DIRS})[^"']*["'])[^)]*["'](?:${TOP_LEVEL_DIRS})\\/?["']\\s*\\)`,
  );
  // `${ROOT}tests/` — an interpolation, then a top-level dir, then the end of the template.
  const TEMPLATE_ENDS_AT_TOP_LEVEL = new RegExp("\\$\\{[^}]*\\}\\/?(?:" + TOP_LEVEL_DIRS + ")\\/?[`\"']?$");
  const flatten = (src: string) => src.replace(/\s+/g, " ").trim();
  const isTestsDirUrl = (flat: string, rel: string) =>
    /new URL\(\s*["']\.\/["']/.test(flat) && /^tests\//.test(rel);
  const denotesSourceRoot = (text: string, rel: string) => {
    const flat = flatten(text);
    if (REPO_ROOT_URL.test(flat)) return true;
    if (TOP_LEVEL_URL.test(flat)) return true;
    if (JOIN_ENDS_AT_TOP_LEVEL.test(flat)) return true;
    if (TEMPLATE_ENDS_AT_TOP_LEVEL.test(flat)) return true;
    return isTestsDirUrl(flat, rel);
  };
  const identifierIsSourceRoot = (id: string, code: string, rel: string) => {
    if (KNOWN_SOURCE_ROOTS.test(id)) return true;
    // Capture the RHS ACROSS newlines: `[^;\n]+` stopped at the first newline, so a formatted
    // multi-line `const root = new URL(\n "../extension/",\n import.meta.url,\n)` evaded the rule
    // entirely (reviewer P1).
    const m = new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*=\\s*([^;]+)`).exec(code);
    return m ? denotesSourceRoot(m[1], rel) : false;
  };
  /** The FIRST ARGUMENT of every call to `name(`, as source text. */
  const firstArgs = (code: string, name: string): string[] => {
    const out: string[] = [];
    for (const m of code.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
      let depth = 0;
      let buf = "";
      for (let i = m.index + m[0].length; i < code.length; i++) {
        const c = code[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
          if (depth === 0) break;
          depth--;
        } else if (c === "," && depth === 0) break;
        buf += c;
      }
      out.push(flatten(buf));
    }
    return out;
  };
  // The argument counts when it is an identifier defined from a root, or an INLINE EXPRESSION naming
  // one — two real guards walk `walk(path.join(ROOT, "extension"))` and
  // `walk(fileURLToPath(new URL("../extension", import.meta.url)))`, and an identifier-only rule misses
  // both. Argument extraction does not demand a closing paren either: `walk(root, opts)` and
  // `walk(abs, rel)` are ordinary calls (reviewer P1/P2).
  const walkOrReadRoots = (code: string, rel: string) =>
    ["walk", "readDir", "readDirSync", "readdir", "readdirSync", "opendir", "opendirSync"].flatMap((name) => firstArgs(code, name))
      .filter((arg) => (/^[A-Za-z_$][\w$]*$/.test(arg) ? identifierIsSourceRoot(arg, code, rel) : denotesSourceRoot(arg, rel)));
  for (const { rel, code } of testFiles) {
    const isTest = IS_TEST_RE.test(rel);
    // Non-test support modules INSIDE tests/** cannot be silenced by ALWAYS_ON or
    // SCANNER_EXCLUSIONS. Imported modules outside tests/ get the separate 2irv
    // reverse-graph consumer check below, not this direct unclassified verdict.
    if (isTest && alwaysOnSet.has(rel)) continue;
    // chrome-agent-platform-kz27: a DECLARED exclusion is classified — it carries a reason and a bead,
    // so the choice is written down rather than being an accidental omission. That is why
    // SCANNER_EXCLUSIONS exists instead of a quietly missing list entry.
    if (isTest && Object.hasOwn(SCANNER_EXCLUSIONS, rel)) continue;
    // If it dynamically scans source directories, it must be in ALWAYS_ON. The literal
    // patterns catch the ROOT-rooted shapes; the source-root test catches a walk over an
    // identifier that this file derives from a source root (p1lp), including lowercase ones.
    // For non-test support modules/helpers, only definition-based walks (walkOrReadRoots) apply:
    // prose patterns (SCAN_DIRS, git ls-files, GUARD_ROOTS) cannot match support modules because
    // helpers have no exemption path and comment mentions must not cause unactionable reds (afpl Finding 2).
    const matchesScanner = isTest
      ? (SCANNER_PATTERNS.some((pat) => pat.test(code)) || walkOrReadRoots(code, rel).length > 0)
      : (walkOrReadRoots(code, rel).length > 0);
    if (matchesScanner) {
      unclassified.push(rel);
    }
  }
  return unclassified;
}

/**
 * The shared test-support files this audit must scan too (chrome-agent-platform-afpl). The audit used to
 * enumerate tests/*.test.ts ONLY, so a repo walk moved into a HELPER was invisible — and that is the
 * shape a faithful `-static` split encourages, because the shared machinery has to live somewhere. The
 * same blind spot covered the non-test support modules sitting directly under tests/.
 *
 * All subdirectories under tests/ (such as tests/helpers/, tests/support/, tests/utils/) are dynamically
 * scanned, EXCEPT tests/fixtures/ which is deliberately NOT scanned: it is data, and a fixture reader
 * must not be admitted. That half matters as much as the other — widening a scan until it admits every
 * fixture reader is how an over-broad pattern once put a 23s esbuild-spawning file into the always-on
 * set and tripled every subset gate (chrome-agent-platform-fgik, and the reason p1lp replaced names
 * with DEFINITIONS).
 *
 * Scope note (afpl Finding 3, closed by 2irv): shared modules outside tests/**
 * (e.g. scripts/lib/harness-registry.ts) are checked separately against the
 * reverse import graph below: a repo-walking helper must have an ALWAYS_ON
 * test consumer. Helpers themselves can never be ALWAYS_ON entries.
 */

/** Every shared test-support source file: subdirectories under tests/ (except fixtures/), plus non-test modules directly under tests/. */
export function sharedSupportFiles(testsDir = join(ROOT, "tests")): { rel: string; code: string }[] {
  const out: { rel: string; code: string }[] = [];
  let realTestsDir: string;
  try {
    realTestsDir = realpathSync(testsDir);
  } catch {
    return out;
  }
  const visited = new Set<string>();

  const collect = (dir: string, rel: string) => {
    let realDir: string;
    try {
      realDir = realpathSync(dir);
    } catch {
      return;
    }
    if (realDir !== realTestsDir && !realDir.startsWith(realTestsDir + sep)) return; // symlink confinement to testsDir
    if (visited.has(realDir)) return; // loop prevention
    visited.add(realDir);

    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "fixtures") continue;
      const childRel = `${rel}/${e.name}`;
      const childAbs = join(dir, e.name);
      let isDir = false;
      let isFile = false;
      try {
        const st = statSync(childAbs);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        isDir = e.isDirectory();
        isFile = e.isFile();
      }
      if (isDir) {
        collect(childAbs, childRel);
        continue;
      }
      if (isFile && /\.(ts|js|mjs)$/.test(e.name) && !IS_TEST_RE.test(e.name)) {
        out.push({ rel: childRel, code: readFileSync(childAbs, "utf8") });
      }
    }
  };

  visited.add(realTestsDir);
  let topEntries: Dirent[];
  try {
    topEntries = readdirSync(testsDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const e of topEntries) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "fixtures") continue;
    const rel = `tests/${e.name}`;
    const abs = join(testsDir, e.name);
    let isDir = false;
    let isFile = false;
    try {
      const st = statSync(abs);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      isDir = e.isDirectory();
      isFile = e.isFile();
    }
    if (isDir) {
      collect(abs, rel);
    } else if (isFile && /\.(ts|js|mjs)$/.test(e.name) && !IS_TEST_RE.test(e.name)) {
      out.push({ rel, code: readFileSync(abs, "utf8") });
    }
  }
  return out;
}

/**
 * Format guidance for unclassified files (coord's refinement on afpl):
 * Test files should be added to SOURCE_INSPECTING_GUARDS.
 * Support modules / helpers can NEVER be in ALWAYS_ON; the message explains what to do instead of
 * giving contradictory advice or leaving the next splitter a red they cannot act on.
 */
export function formatUnclassifiedScannersMessage(unclassified: string[]): string {
  const tests = unclassified.filter((rel) => IS_TEST_RE.test(rel));
  const support = unclassified.filter((rel) => !IS_TEST_RE.test(rel));

  const parts: string[] = [];
  if (tests.length > 0) {
    parts.push(
      `Dynamic source-scanning test guard(s) found without being in ALWAYS_ON: ${tests.join(", ")}. ` +
        `Add them to SOURCE_INSPECTING_GUARDS in scripts/select-tests.mjs.`,
    );
  }
  if (support.length > 0) {
    parts.push(
      `${support.length} dynamic source-scanning SHARED TEST-SUPPORT MODULE(S) found: ${support.join(", ")}. ` +
        `Shared support modules can never be an ALWAYS_ON member. ` +
        `Move the walk into the test file that needs it, or put the static half in a test file. ` +
        `Do NOT silence this by adding a helper to SOURCE_INSPECTING_GUARDS — that list is for test files, ` +
        `and a helper there would be selected as a guard it is not.`,
    );
  }
  return parts.join("\n\n");
}

/** Enumerate all test files recursively under testsDir (excluding fixtures). */
export function enumerateTestFiles(testsDir = join(ROOT, "tests")): { rel: string; code: string }[] {
  return readdirSync(testsDir, { recursive: true })
    .map(String)
    .filter((f) => isCreditableRunnerTest(`tests/${f}`))
    .map((f) => ({
      rel: `tests/${f}`,
      code: readFileSync(join(testsDir, f), "utf8"),
    }));
}

// 2irv: afpl audited tests/**, but a repo-walking helper in scripts/lib/ or
// another imported source root was invisible there. The selector's reverse
// import graph includes executable imports AND direct source-text reads, so a
// test node must be terminal: reading a test's text cannot execute its imports.
function testConsumerReachable(start: string, reverse: Map<string, Set<string>>, predicate: (rel: string) => boolean): boolean {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const importer of reverse.get(queue.pop()!) ?? []) {
      const rel = relative(ROOT, importer).replaceAll("\\", "/");
      if (rel === ".." || rel.startsWith("../") || seen.has(importer)) continue;
      if (IS_TEST_RE.test(rel)) {
        // Only tests that the runner enumerates can supply coverage. Even an
        // unlisted test is terminal: traversing through its imports would let
        // a DIFFERENT always-on test that reads it as TEXT fake execution.
        if (isCreditableRunnerTest(rel) && predicate(rel)) return true;
        continue;
      }
      seen.add(importer);
      queue.push(importer);
    }
  }
  return false;
}

/** Repo-walking modules outside tests/ without a transitive ALWAYS_ON consumer. */
export function uncoveredExternalRepoWalks(
  reverse: Map<string, Set<string>>,
  alwaysOn: Set<string>,
  sourceFor: (abs: string) => string | null = (abs) => existsSync(abs) ? readFileSync(abs, "utf8") : null,
): string[] {
  const candidates: { rel: string; code: string }[] = [];
  for (const abs of reverse.keys()) {
    const rel = relative(ROOT, abs).replaceAll("\\", "/");
    // tests/** support is checked by afpl, but test-imported executable
    // fixtures under tests/fixtures/** are excluded THERE as data. Admit only
    // non-test JS/TS fixture modules here, through real graph importers;
    // JSON/HTML/data and fixture *.test.ts files never become candidates.
    if (rel === ".." || rel.startsWith("../") ||
        (rel.startsWith("tests/") && (!rel.startsWith("tests/fixtures/") || IS_TEST_RE.test(rel))) ||
        rel.startsWith(["extension", "dist"].join("/") + "/") || !/\.(?:js|ts|mjs)$/.test(rel)) continue;
    if (!testConsumerReachable(abs, reverse, (testRel) => true)) continue;
    const code = sourceFor(abs);
    if (code !== null) candidates.push({ rel, code });
  }
  const walkers = findUnclassifiedSourceScanners(candidates, new Set());
  return walkers.filter((rel) => !testConsumerReachable(join(ROOT, rel), reverse, (testRel) => alwaysOn.has(testRel))).sort();
}

Deno.test("2irv: every tested repo-walking helper outside tests/ has an ALWAYS_ON consumer", () => {
  const reverse = buildReverseGraph();
  const gaps = uncoveredExternalRepoWalks(reverse, new Set(ALWAYS_ON));
  assertEquals(gaps, [], `Repo-walking helper(s) outside tests/ lack an ALWAYS_ON consumer: ${gaps.join(", ")}. ` +
    "Add the consuming TEST to SOURCE_INSPECTING_GUARDS; never list a helper as a guard.");
});

Deno.test("2irv: REAL-TREE falsification exposes unguarded repo walks in root and shared helpers", () => {
  const reverse = buildReverseGraph();
  const original = new Set(ALWAYS_ON);
  assertEquals(uncoveredExternalRepoWalks(reverse, original), []);

  // Both files below are actual repo walkers outside tests/**. Removing their
  // real consumers from ALWAYS_ON must name each gap, not fail on synthetic
  // parse text, a missing file, or an unrelated fixture.
  const withoutBuildConsumer = new Set(original);
  withoutBuildConsumer.delete("tests/changelog-shipping.test.ts");
  assert(
    uncoveredExternalRepoWalks(reverse, withoutBuildConsumer).includes(["build", ".mjs"].join("")),
    "the repo-root build script walk must RED when its test is no longer always-on",
  );
  const withoutHarnessConsumers = new Set(original);
  withoutHarnessConsumers.delete("tests/harness-registry.test.ts");
  withoutHarnessConsumers.delete("tests/quiet-window-static.test.ts");
  assert(
    uncoveredExternalRepoWalks(reverse, withoutHarnessConsumers).includes("scripts/lib/harness-registry.ts"),
    "a shared-helper repo walk must RED when its two executing tests are no longer always-on",
  );
});

Deno.test("2irv: a NEW unguarded shared-helper walk is caught without mutating the parallel test tree", () => {
  const helper = "scripts/lib/zz-2irv-repo-walk.ts";
  const consumer = "tests/zz-2irv-consumer.test.ts";
  const code = 'const root = new URL("../../", import.meta.url);\n' +
    'export function census() { for (const entry of Deno.readDirSync(root)) void entry; }\n';
  assertEquals(findUnclassifiedSourceScanners([{ rel: helper, code }], new Set()), [helper],
    "the shared-helper scanner must classify a fresh repo-root walk");
  // A newly imported helper is absent from the old tests/** audit. Inject its
  // source and import edge IN MEMORY so parallel whole-suite guards cannot see
  // a transient extra test file (or leave a dirty worktree after SIGKILL).
  const oldAudit = findUnclassifiedSourceScanners([...enumerateTestFiles(), ...sharedSupportFiles()], new Set(ALWAYS_ON));
  assertEquals(oldAudit, [], "the existing tests-only audit would miss the outside-root helper");
  const reverse = new Map([[join(ROOT, helper), new Set([join(ROOT, consumer)])]]);
  assertEquals(uncoveredExternalRepoWalks(reverse, new Set(ALWAYS_ON),
    (abs) => abs === join(ROOT, helper) ? code : null), [helper]);
});

Deno.test("i0rf N1: a synthetic source-text URL cannot supply an ALWAYS_ON importer", () => {
  const reverse = buildReverseGraph();
  const allegedImporter = join(ROOT, "tests/substring-pin-honesty.test.ts");
  assert(
    !(reverse.get(join(ROOT, "scripts/kat-runner.ts"))?.has(allegedImporter) ?? false),
    "the real substring-pin test has a URL only inside a synthetic template fixture; it does not load kat-runner",
  );
  // A real read of another test's text is still an edge for changed-test
  // selection, but the consumer walk must stop at that test (not traverse it).
  assert(reverse.get(join(ROOT, "tests/quiet-window-static.test.ts"))?.has(allegedImporter));
});

Deno.test("i0rf N1: URL instrument lexing distinguishes inert text from live template interpolation", () => {
  const url = '../scripts/kat-runner.ts';
  const code = [
    '// new URL("../scripts/kat-runner.ts", import.meta.url)',
    'const sample = `new URL("../scripts/kat-runner.ts", import.meta.url)`;',
    'const live = new URL("../scripts/kat-runner.ts", import.meta.url);',
    'const interpolated = `${new URL("../scripts/kat-runner.ts", import.meta.url).href}`;',
  ].join("\n");
  assertEquals(codeUrlInstrumentSpecs(code), [url, url]);
  // If a newer TS syntax cannot be lexed, retain the edge rather than hide it.
  assertEquals(codeUrlInstrumentSpecs('new URL("../scripts/kat-runner.ts", import.meta.url);\n¤'), [url]);
});

Deno.test("57uw: an unlexable source reports its URL lexer failure while retaining edges for selection", () => {
  const source = 'const sample = `new URL("../scripts/lib/harness-registry.ts", import.meta.url)`;\n¤';
  const failures: string[] = [];
  assertEquals(codeUrlInstrumentSpecs(source, (error) => failures.push(String(error))), ["../scripts/lib/harness-registry.ts"],
    "selection must conservatively retain a quoted edge when the lexer cannot classify it");
  assertEquals(failures.length, 1, "the lexer failure must be surfaced to the audit rather than silently crediting the edge");
});

Deno.test("57uw: the full source graph names every URL lexer failure for an audit decision", () => {
  const failures: string[] = [];
  buildReverseGraph((abs) => failures.push(relative(ROOT, abs).replaceAll("\\", "/")));
  assertEquals(failures.sort(), ["scripts/perf-gallery-previews.ts"],
    `URL lexer failures must be named and audited; observed: ${JSON.stringify(failures)}`);
  assertEquals(codeUrlInstrumentSpecs(readFileSync(join(ROOT, failures[0]), "utf8")), [".."],
    "the one known TS lexer failure only retains a directory spec, not an executable import");
});

Deno.test("i0rf N2: an actual test-imported fixture with an injected repo walk is detected", () => {
  const rel = "tests/fixtures/build-once.mjs";
  const abs = join(ROOT, rel);
  const reverse = buildReverseGraph();
  assert(reverse.get(abs)?.has(join(ROOT, "tests/store-doc-denial.test.ts")), "the fixture is imported by a REAL test");
  const code = 'const root = new URL("../../", import.meta.url);\n' +
    'export function census() { for (const entry of Deno.readDirSync(root)) void entry; }\n';
  assertEquals(findUnclassifiedSourceScanners([{ rel, code }], new Set()), [rel], "the walker itself is classifiable");
  assertEquals(uncoveredExternalRepoWalks(reverse, new Set(ALWAYS_ON),
    (candidate) => candidate === abs ? code : null), [rel],
    "an executable fixture with real non-ALWAYS_ON importers must not be hidden by the tests/** exclusion");
});

Deno.test("i0rf N2: data fixtures and ordinary fixture-local reads do not become source scanners", () => {
  const rel = "tests/fixtures/run-log-wal-memory.js";
  const abs = join(ROOT, rel);
  const reverse = buildReverseGraph();
  assert(reverse.get(abs)?.has(join(ROOT, "tests/memory.test.ts")), "REAL fixture module is imported by a test");
  assertEquals(findUnclassifiedSourceScanners([{ rel, code: readFileSync(abs, "utf8") }], new Set()), [],
    "a fixture-local memory walker is not a repo-source walk");
  assertEquals(uncoveredExternalRepoWalks(reverse, new Set(ALWAYS_ON)), [], "no current imported fixture walks a repo source root");

  const data = "tests/fixtures/pm-skills-tree.json";
  const fakeGraph = new Map([[join(ROOT, data), new Set([join(ROOT, "tests/skill-discovery.test.ts")])]]);
  assertEquals(uncoveredExternalRepoWalks(fakeGraph, new Set(), () =>
    'const root = new URL("../../", import.meta.url); Deno.readDirSync(root);'), [],
    "even a synthetic graph link cannot classify JSON data as an executable helper");
});

Deno.test("57uw: fixture tests cannot supply always-on credit to an external repo walker", () => {
  const fixtureTest = "tests/fixtures/zz-57uw-consumer.test.ts";
  const helper = "scripts/lib/zz-57uw-repo-walk.ts";
  const code = 'const root = new URL("../../", import.meta.url);\n' +
    'export function census() { for (const entry of Deno.readDirSync(root)) void entry; }\n';
  const abs = join(ROOT, helper);
  const reverse = new Map([[abs, new Set([join(ROOT, "tests/zz-57uw-ordinary.test.ts"), join(ROOT, fixtureTest)])]]);
  assertEquals(uncoveredExternalRepoWalks(reverse, new Set([fixtureTest]), (source) => source === abs ? code : null), [helper],
    "a fixture *.test.ts is runner-enumerated but cannot claim ALWAYS_ON coverage of a repo walk");
});

Deno.test("57uw: runner enumeration cannot silently add tests outside the audit's credit policy", () => {
  const runnable = enumerateRunnerTests(join(ROOT, "tests"));
  assertEquals(runnable.filter((rel) => !isCreditableRunnerTest(rel)), [],
    "npm test would execute fixture/node_modules *.test.ts files that the source-walk audit does not credit; decide their policy before adding them");
  const synthetic = enumerateRunnerTests("unused", ["fixtures/nested/zz-57uw.test.ts", "nested/executed.test.ts", "not-run.test.js"]);
  assertEquals(synthetic, ["tests/fixtures/nested/zz-57uw.test.ts", "tests/nested/executed.test.ts"],
    "the runner discovers nested fixture *.test.ts but does not execute *.test.js");
  assertEquals(synthetic.map(isCreditableRunnerTest), [false, true],
    "fixture tests are visible but cannot supply source-walk credit; nested ordinary tests can");
  assertEquals(isCreditableRunnerTest("tests/not-run.test.js"), false, "a *.test.js file cannot credit an audit while npm test ignores it");
});

Deno.test("i0rf N3: a bundle-only shipped source is outside the static graph but changed-file gating fails closed", () => {
  const source = "extension/privacy/privacy.js";
  const reverse = buildReverseGraph();
  assertEquals(reverse.has(join(ROOT, source)), false, "the real built entry is not a relative-import target");
  assertEquals(changedWithoutCoverage([source], reverse), [source], "an edit must fail closed to the full suite");
});

Deno.test("qcfc: self-checking audit: all dynamic source-scanning test guards are in ALWAYS_ON", () => {
  // Recursive enumeration: matches run-tests.mjs so nested tests/**/ files cannot evade the audit.
  const testFiles = enumerateTestFiles();

  const alwaysOnSet = new Set(ALWAYS_ON);
  // afpl: TEST FILES AND THE SHARED SUPPORT MODULES, through the SAME classifier. A repo walk in a helper
  // is therefore a NAMED failure rather than an invisible hole, and it fails closed because a helper can
  // never legitimately be classified (it is not a guard and cannot be an ALWAYS_ON member).
  const scanned = [...testFiles, ...sharedSupportFiles()];
  const unclassified = findUnclassifiedSourceScanners(scanned, alwaysOnSet);

  assertEquals(
    unclassified,
    [],
    formatUnclassifiedScannersMessage(unclassified),
  );
});

Deno.test("qcfc: every declared exclusion is JUSTIFIED (a reason and a bead, never a silent hole)", () => {
  // kz27: an exclusion is allowed, but it must say WHY and who owns the follow-up. Without this an
  // entry could be added merely to silence the audit, which is the failure mode the audit exists to
  // prevent.
  const entries = Object.entries(SCANNER_EXCLUSIONS);
  assert(entries.length > 0, "the exclusion list must be populated if it is referenced");
  for (const [file, reason] of entries) {
    assert(existsSync(join(ROOT, file)), `excluded scanner ${file} must exist on disk`);
    assert(reason.trim().length > 80, `exclusion ${file} must carry a real reason, not a placeholder`);
    assert(
      /chrome-agent-platform-[a-z0-9]{4}/.test(reason),
      `exclusion ${file} must name the bead that owns the follow-up`,
    );
    assert(
      !ALWAYS_ON.includes(file),
      `${file} cannot be both always-on and excluded — that contradiction would hide the decision`,
    );
  }
});

Deno.test("qcfc: REAL-TREE falsification — an actual repo-walking guard is flagged when unlisted", () => {
  // F3: the synthetic fixtures prove the PARSER; a real file proves the DETECTOR against the tree we
  // actually ship. If the patterns stop catching real repo-walking code, this fails on main rather than
  // silently certifying a classifier that no longer classifies anything.
  const rel = "tests/settings-strings-audit.test.ts";
  const code = readFileSync(join(ROOT, rel), "utf8");
  const unclassified = findUnclassifiedSourceScanners([{ rel, code }], new Set());
  assertEquals(
    unclassified,
    [rel],
    "a REAL repo-walking guard must be flagged when it is neither always-on nor declared excluded",
  );
});

Deno.test("p1lp: REAL-TREE symmetry — a lowercase-alias source-root walk is flagged, a DOM walk is not", () => {
  // chrome-agent-platform-p1lp. The kz27 detector demanded an UPPERCASE identifier, which failed in
  // BOTH directions against files this repo actually ships:
  //   MET   — tests/chrome-tools-t12-static.test.ts walks the extension root through a LOWERCASE alias
  //           (`const root = new URL("../extension/", import.meta.url)`), so it escaped entirely.
  //   MISSED— a file that walks a DOM tree also calls `walk(root)`, and a name list cannot tell the
  //           two apart: the identifier's SHAPE carries no information, its DEFINITION does. Getting
  //           this wrong upward is not hypothetical — an over-match is how a 23s esbuild-spawning file
  //           entered the always-on set and tripled every subset gate (chrome-agent-platform-fgik).
  // Real files rather than synthetic strings, because the synthetic fixtures prove the PARSER while
  // this proves the CLASSIFIER against the tree we ship.
  const read = (rel: string) => ({ rel, code: readFileSync(join(ROOT, rel), "utf8") });
  const unlisted = new Set(["tests/security.test.ts"]);

  assertEquals(
    findUnclassifiedSourceScanners([read("tests/chrome-tools-t12-static.test.ts")], unlisted),
    ["tests/chrome-tools-t12-static.test.ts"],
    "a walk over a LOWERCASE alias of a source root must be flagged when it is unlisted",
  );

  assertEquals(
    findUnclassifiedSourceScanners([read("tests/agent-permissions-panel.test.ts")], unlisted),
    [],
    "a walk over a NON-source identifier (a DOM node) must NOT be flagged — admitting it is the over-match that cost 23s a gate",
  );
});

Deno.test("qcfc: falsification: unclassified source scanner fails the audit closed", () => {
  const fakeTests = [
    {
      rel: "tests/fake-unclassified-scanner.test.ts",
      code: `const SCAN_DIRS = ["scripts", "tests"];\nasync function filesUnder() {}`,
    },
    {
      // kz27: the REPO-WALK shape specifically — a walk rooted at ROOT. This is the shape that shipped
      // OUTSIDE ALWAYS_ON (tests/durable-root.test.ts), so the audit must catch it and not only the
      // SCAN_DIRS/filesUnder family above.
      rel: "tests/fake-unlisted-walk-scanner.test.ts",
      code: `const ROOT = fileURLToPath(new URL("..", import.meta.url));\nfor (const e of Deno.readDirSync(ROOT)) { if (e.isDirectory) walk(ROOT); }`,
    },
  ];
  const alwaysOnSet = new Set(["tests/security.test.ts"]);
  const unclassified = findUnclassifiedSourceScanners(fakeTests, alwaysOnSet);
  assertEquals(
    unclassified,
    ["tests/fake-unclassified-scanner.test.ts", "tests/fake-unlisted-walk-scanner.test.ts"],
    "Audit must catch unclassified source scanners, including a REPO-WALK scanner (kz27)",
  );
});

const UBF = ["/usr", "bin", "find"].join("/");
const FIND_CMD_REGEX = new RegExp(
  `(?:\\bexec(?:Sync|File|FileSync)?\\s*\\(\\s*["'\`]|spawn(?:Sync)?\\s*\\(\\s*["'\`]|Command\\s*\\(\\s*["'\`]|\\bsh\\s+-c\\s+["'\`]|\\bbash\\s+-c\\s+["'\`])[^"'\`]*\\b(?:fi` +
    `nd|${UBF})\\b`,
);
const SHELL_FIND_REGEX = new RegExp(
  `(?:^\\s*|[;&|()]\\s*|(?:then|do|else|elif)\\s+|\\$\\(\\s*)(?:fi` + `nd|${UBF})\\s`,
  "m",
);

export function findFindInvocations(files: { rel: string; code: string }[]): string[] {
  const offenders: string[] = [];
  for (const { rel, code } of files) {
    const stripped = rel.endsWith(".sh")
      ? code.replace(/^\s*#.*/gm, "")
      : code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/(?![/*]).*/g, "");

    if (stripped.includes(UBF)) {
      offenders.push(rel);
      continue;
    }
    if (rel.endsWith(".sh")) {
      if (SHELL_FIND_REGEX.test(stripped)) offenders.push(rel);
    } else {
      if (FIND_CMD_REGEX.test(stripped)) offenders.push(rel);
    }
  }
  return offenders;
}

Deno.test("p4tf: no test or script under tests/ or scripts/ invokes find for file absence or inspection (box hazard)", () => {
  // chrome-agent-platform-p4tf: /usr/bin/find on fleet machines silently filters gitignored
  // paths, making absence checks vacuous. Test suites and scripts must not invoke find or
  // /usr/bin/find as a file absence or inventory oracle (use python os.walk, node fs, or rg --hidden --no-ignore).
  const dirs = ["tests", "scripts"];
  const collected: { rel: string; code: string }[] = [];
  for (const dir of dirs) {
    const dirPath = join(ROOT, dir);
    assert(existsSync(dirPath), `scanned directory ${dirPath} must exist`);
    for (const entry of readdirSync(dirPath, { recursive: true })) {
      const entryStr = String(entry);
      if (!entryStr.endsWith(".ts") && !entryStr.endsWith(".js") && !entryStr.endsWith(".mjs") && !entryStr.endsWith(".sh")) continue;
      const rel = join(dir, entryStr);
      const fullPath = join(dirPath, entryStr);
      collected.push({ rel, code: readFileSync(fullPath, "utf8") });
    }
  }
  // A floor: if the scan silently found nothing, this guard would pass while measuring nothing
  assert(collected.length >= 400, `scanned file floor not met: expected >= 400, got ${collected.length}`);
  assert(collected.some((f) => f.rel.split(/[/\\]/).length > 2), "nested paths must be in scope");
  const offenders = findFindInvocations(collected);
  assertEquals(offenders, [], "test or script invokes find executable (box hazard: silently filters gitignored paths; use python os.walk or rg --hidden --no-ignore)");
});

Deno.test("p4tf: falsification: a script or test invoking find is flagged", () => {
  const f = "fi" + "nd";
  const fakeClean = [
    { rel: "tests/clean-example.test.ts", code: "const x = [1, 2].find((n) => n === 1);" },
    { rel: "scripts/clean-example.sh", code: "echo 'searching files with python'\npython3 -c 'import os; os.walk(...)'" },
    { rel: "tests/clean-url.test.ts", code: "const u = 'https://example.com/find?q=1';" },
  ];
  assertEquals(findFindInvocations(fakeClean), [], "clean files must not be flagged");

  const fakeOffenders = [
    { rel: "tests/fake-exec.test.ts", code: `const res = execSync("${f} . -name '*.map'");` },
    { rel: "tests/fake-spawn.test.ts", code: `spawn("${f}", [".", "-name", "*.map"]);` },
    { rel: "tests/fake-bash.test.ts", code: `await run("bash -c '${f} /tmp -name test'");` },
    { rel: "tests/fake-url-then-exec.test.ts", code: `const base = "https://example.com"; execSync("${f} . -name '*.map'");` },
    { rel: "scripts/fake-shell.sh", code: `#!/usr/bin/env bash\n${f} . -name "*.js"` },
    { rel: "scripts/fake-indented.sh", code: `#!/usr/bin/env bash\nif true; then\n  ${f} . -type f\nfi` },
    { rel: "scripts/fake-one-line.sh", code: `if true; then ${f} . -type f; fi` },
    { rel: "scripts/fake-direct.sh", code: `#!/usr/bin/env bash\n/usr/bin/${f} . -name "*.js"` },
  ];
  assertEquals(
    findFindInvocations(fakeOffenders),
    fakeOffenders.map((x) => x.rel),
    "all find-invoking scripts and tests must be flagged by findFindInvocations",
  );
});

Deno.test("afpl: every ALWAYS_ON and SCANNER_EXCLUSIONS entry is a runner-executed test, never a helper", () => {
  for (const f of ALWAYS_ON) {
    assert(isCreditableRunnerTest(f), `ALWAYS_ON entry ${f} must be an executable *.test.ts outside fixtures, never a helper`);
  }
  for (const f of Object.keys(SCANNER_EXCLUSIONS)) {
    assert(isCreditableRunnerTest(f), `SCANNER_EXCLUSIONS entry ${f} must be an executable *.test.ts outside fixtures, never a helper`);
  }
});

// chrome-agent-platform-afpl — REAL-TREE falsification: places a depth-2 repo-walking helper
// in tests/helpers/ in the actual repository tree, proves the audit discovers and NAMES it,
// proves prose-only helpers are not falsely flagged, and cleans up the tree in a finally block.
Deno.test("afpl: REAL-TREE falsification — a depth-2 repo-walking helper is NAMED and fails closed; prose helper is NOT flagged", async () => {
  const realHelpersDir = join(ROOT, "tests", "helpers");
  const depth2Walker = join(realHelpersDir, "zz-afpl-depth2-walk.ts");
  const proseHelper = join(realHelpersDir, "zz-afpl-prose-only.ts");
  const fixtureReader = join(realHelpersDir, "zz-afpl-fixture-read.ts");
  const siblingFile = join(realHelpersDir, "zz-afpl-preexisting-sibling.ts");
  const testFiles = [depth2Walker, proseHelper, fixtureReader];

  // NEW-1: Record whether tests/helpers existed prior to this test
  const helpersDirPreexisted = existsSync(realHelpersDir);
  if (!helpersDirPreexisted) {
    await Deno.mkdir(realHelpersDir, { recursive: true });
  }

  // NEW-1: Plant a pre-existing sibling to prove cleanup preserves un-owned files
  assertEquals(Object.keys(AFPL_REAL_TREE_FIXTURES).sort(), [...AFPL_REAL_TREE_RESIDUE].sort());
  const fixtureBody = (rel: string): string => {
    assert(Object.hasOwn(AFPL_REAL_TREE_FIXTURES, rel), `missing real-tree fixture ${rel}`);
    return AFPL_REAL_TREE_FIXTURES[rel];
  };
  const siblingBody = fixtureBody("tests/helpers/zz-afpl-preexisting-sibling.ts");
  await Deno.writeTextFile(siblingFile, siblingBody);

  try {
    try {
    // 1. (F1) Depth-2 helper walking root via "../../" (the repo's own depth-2 idiom).
    await Deno.writeTextFile(
      depth2Walker,
      fixtureBody("tests/helpers/zz-afpl-depth2-walk.ts"),
    );

    // 2. (F2) Prose-only helper mentioning SCAN_DIRS and git ls-files in comments.
    await Deno.writeTextFile(
      proseHelper,
      fixtureBody("tests/helpers/zz-afpl-prose-only.ts"),
    );

    // 3. Over-match negative: fixture-reading helper.
    await Deno.writeTextFile(
      fixtureReader,
      fixtureBody("tests/helpers/zz-afpl-fixture-read.ts"),
    );

    const scanned = sharedSupportFiles();
    const named = findUnclassifiedSourceScanners(scanned, new Set());

    // (F1) Depth-2 helper MUST be named by the real-tree scan:
    assertEquals(
      named.includes("tests/helpers/zz-afpl-depth2-walk.ts"),
      true,
      `REAL-TREE: a depth-2 repo-walking helper must be SCANNED and NAMED: ${JSON.stringify(named)}`,
    );

    // ...and the audit must provide actionable guidance:
    const guidance = formatUnclassifiedScannersMessage(named);
    assertStringIncludes(guidance, "zz-afpl-depth2-walk.ts", "the guidance must name the module");
    assertStringIncludes(guidance, "Move the walk into the test file", "the guidance must say what to do");
    assertStringIncludes(guidance, "can never be an ALWAYS_ON member", "the guidance must say why not");

    // (F2) Prose-only helper MUST NOT be flagged as unclassified:
    assertEquals(
      named.includes("tests/helpers/zz-afpl-prose-only.ts"),
      false,
      `REAL-TREE: a support module with prose mentioning SCAN_DIRS/git ls-files must NOT be flagged: ${JSON.stringify(named)}`,
    );

    // Fixture reader MUST NOT be admitted:
    assertEquals(
      named.includes("tests/helpers/zz-afpl-fixture-read.ts"),
      false,
      `REAL-TREE: a fixture-walking helper must NOT be admitted: ${JSON.stringify(named)}`,
    );

  } finally {
    // NEW-1: Idempotent cleanup of owned test files, never wiping existing/tracked files in tests/helpers
    for (const f of testFiles) {
      try { await Deno.remove(f); } catch { /* ignore */ }
    }
    }
    assert(
      existsSync(siblingFile),
      "NEW-1: pre-existing sibling in tests/helpers must survive cleanup byte-identically",
    );
    assertEquals(
      await Deno.readTextFile(siblingFile),
      siblingBody,
      "NEW-1: pre-existing sibling in tests/helpers must survive cleanup byte-identically",
    );
  } finally {
    await Deno.remove(siblingFile).catch(() => {});
    if (!helpersDirPreexisted) await Deno.remove(realHelpersDir).catch(() => {});
  }
});

// chrome-agent-platform-afpl — scratch-tree coverage proof, in BOTH directions and against a REAL file.
// Uses an isolated scratch tree in durableDir("scratch") so the test never writes untracked files into
// the tracked repository (preventing concurrent test race conditions and SIGKILL residue).
Deno.test("afpl: a repo-walking HELPER is named and fails the audit closed; a fixture-walking helper is NOT admitted", async () => {
  const scratch = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-afpl-census-" });
  const helpersDir = join(scratch, "helpers");
  await Deno.mkdir(helpersDir, { recursive: true });

  const walker = join(helpersDir, "zz-afpl-repo-walk.ts");
  const depth2Walker = join(helpersDir, "zz-afpl-depth2-walk.ts");
  const proseHelper = join(helpersDir, "zz-afpl-prose-only.ts");
  const fixtureReader = join(helpersDir, "zz-afpl-fixture-read.ts");
  const nestedTest = join(helpersDir, "zz-nested.test.ts");

  try {
    // (i) A helper that walks a SOURCE root — the shape a -static split's shared machinery could hide.
    await Deno.writeTextFile(
      walker,
      `import { join } from "node:path";\nconst ROOT = "/repo";\n` +
        `export function census() { for (const f of Deno.readDirSync(join(ROOT, "tests"))) void f; }\n`,
    );
    // (i-b) A depth-2 helper with lowercase-alias repo-root URL (Finding 1 mutant).
    await Deno.writeTextFile(
      depth2Walker,
      `const root = new URL("../../", import.meta.url);\n` +
        `export function census() { for (const f of Deno.readDirSync(root)) void f; }\n`,
    );
    const named = findUnclassifiedSourceScanners(sharedSupportFiles(scratch), new Set());
    assertEquals(
      named.includes("tests/helpers/zz-afpl-repo-walk.ts"),
      true,
      `a repo-walking helper must be SCANNED and NAMED — this is the coverage proof, not a skip: ${JSON.stringify(named)}`,
    );
    assertEquals(
      named.includes("tests/helpers/zz-afpl-depth2-walk.ts"),
      true,
      `a depth-2 lowercase-alias repo-walking helper must be SCANNED and NAMED: ${JSON.stringify(named)}`,
    );
    // ...and the audit must say WHAT TO DO, because a helper can never be an ALWAYS_ON member.
    const guidance = formatUnclassifiedScannersMessage(named);
    assertStringIncludes(guidance, "zz-afpl-repo-walk.ts", "the guidance must name the module");
    assertStringIncludes(guidance, "Move the walk into the test file", "the guidance must say what to do");
    assertStringIncludes(guidance, "can never be an ALWAYS_ON member", "the guidance must say why not");

    // (ii) A helper with prose comments mentioning SCAN_DIRS, git ls-files, or GUARD_ROOTS must NOT
    // trigger a false-positive red (Finding 2).
    await Deno.writeTextFile(
      proseHelper,
      `// Shared helper. Deliberately does NOT shell out to git ls-files; it reads two files.\n` +
        `// See SCAN_DIRS and GUARD_ROOTS for context.\n` +
        `export function add(a: number, b: number): number { return a + b; }\n`,
    );
    const afterProse = findUnclassifiedSourceScanners(sharedSupportFiles(scratch), new Set());
    assertEquals(
      afterProse.includes("tests/helpers/zz-afpl-prose-only.ts"),
      false,
      `a support module with prose mentioning SCAN_DIRS/git ls-files must NOT be flagged: ${JSON.stringify(afterProse)}`,
    );

    // (iii) A helper that walks ONLY its own fixture directory must NOT be admitted — the over-match half.
    // Tests join(ROOT, "tests", "fixtures") to ensure definition-aware matching does not over-flag
    // fixture directories, and avoids /tmp string literals (durable-root rule).
    await Deno.writeTextFile(
      fixtureReader,
      `import { join } from "node:path";\nconst ROOT = "/repo";\n` +
        `export function list() { for (const f of Deno.readDirSync(join(ROOT, "tests", "fixtures"))) void f; }\n`,
    );
    const after = findUnclassifiedSourceScanners(sharedSupportFiles(scratch), new Set());
    assertEquals(
      after.includes("tests/helpers/zz-afpl-fixture-read.ts"),
      false,
      `a fixture-walking helper must NOT be admitted: ${JSON.stringify(after)}`,
    );

    // (iv) Evasion resistance: adding a helper to alwaysOnSet or SCANNER_EXCLUSIONS must NOT exempt it.
    const evasionAttempt = findUnclassifiedSourceScanners(
      sharedSupportFiles(scratch),
      new Set(["tests/helpers/zz-afpl-repo-walk.ts"]),
    );
    assertEquals(
      evasionAttempt.includes("tests/helpers/zz-afpl-repo-walk.ts"),
      true,
      "a helper cannot be exempted by alwaysOnSet: support modules must fail closed",
    );

    // (iv) A nested test file under a subdirectory is identified by enumerateTestFiles as a test guard, NOT a helper module.
    await Deno.writeTextFile(
      nestedTest,
      `import { join } from "node:path";\nconst ROOT = "/repo";\n` +
        `export function testRepo() { for (const f of Deno.readDirSync(join(ROOT, "scripts"))) void f; }\n`,
    );
    const enumerated = enumerateTestFiles(scratch);
    assertEquals(
      enumerated.map((e) => e.rel).includes("tests/helpers/zz-nested.test.ts"),
      true,
      "nested test files must be discovered on disk by enumerateTestFiles",
    );
    const nestedNamed = findUnclassifiedSourceScanners(
      enumerated,
      new Set(),
    );
    assertEquals(
      nestedNamed.includes("tests/helpers/zz-nested.test.ts"),
      true,
      "nested test files must be detected as test guards",
    );

    // (v) N1: NEW-2 exclusion pin — top-level and nested node_modules are excluded by enumerateTestFiles.
    const nmTopDir = join(scratch, "node_modules");
    const nmNestedDir = join(scratch, "helpers", "node_modules");
    await Deno.mkdir(nmTopDir, { recursive: true });
    await Deno.mkdir(nmNestedDir, { recursive: true });
    await Deno.writeTextFile(join(nmTopDir, "zz-nm.test.ts"), "// mock node_modules test\n");
    await Deno.writeTextFile(join(nmNestedDir, "zz-nm-nested.test.ts"), "// mock nested node_modules test\n");
    const enumeratedWithNm = enumerateTestFiles(scratch).map((e) => e.rel);
    assert(
      enumeratedWithNm.includes("tests/helpers/zz-nested.test.ts"),
      "enumeration must still return a real test alongside excluded node_modules files",
    );
    assertEquals(
      enumeratedWithNm.some((f) => f.includes("node_modules")),
      false,
      `enumerateTestFiles must exclude top-level and nested node_modules: ${JSON.stringify(enumeratedWithNm)}`,
    );
    const nestedGuidance = formatUnclassifiedScannersMessage(nestedNamed);
    assertStringIncludes(
      nestedGuidance,
      "Add them to SOURCE_INSPECTING_GUARDS",
      "test files must be directed to SOURCE_INSPECTING_GUARDS",
    );
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});

// Only synthetic `code: ` template fixtures are excluded. Never rewrite the source:
// slash/quote heuristics can mistake a regex character class for a string boundary
// and silently erase live removals in the rest of a file.
export function guardFixtureRanges(code: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of code.matchAll(/(?:^|[\n{,])[ \t]*code:[ \t]*`/g)) {
    const start = match.index + match[0].length;
    let end = start;
    while (end < code.length) {
      if (code[end] === "\\") { end += 2; continue; }
      if (code[end] === "`") break;
      end++;
    }
    if (end < code.length) ranges.push({ start, end });
  }
  return ranges;
}

const REMOVAL_FUNCTIONS = ["Deno.remove", "Deno.removeSync", "rm", "rmSync", "fsp.rm", "fsp2.rm"];
export function removalCallSites(code: string): { raw: number[]; considered: number[]; fixture: number[] } {
  const ranges = guardFixtureRanges(code);
  const raw: number[] = [];
  const considered: number[] = [];
  const fixture: number[] = [];
  for (const fn of REMOVAL_FUNCTIONS) {
    for (const match of code.matchAll(new RegExp(`\\b${fn.replace(/\./g, "\\.")}\\s*\\(`, "g"))) {
      raw.push(match.index);
      (ranges.some(({ start, end }) => match.index >= start && match.index < end) ? fixture : considered).push(match.index);
    }
  }
  return { raw, considered, fixture };
}

/**
 * Detects calls to recursive directory removal (Deno.remove, Deno.removeSync, rm, rmSync, fsp.rm)
 * where the target denotes a shared directory in the repository (e.g. tests/helpers, tests, scripts)
 * rather than an isolated per-run temp/scratch directory.
 */
export function findRecursiveRemovalsOfSharedPaths(
  files: Array<{ rel: string; code: string }>,
): string[] {
  const violations: string[] = [];
  const SHARED_PATH_PATTERN = /(?:tests\/helpers|tests(?!\/node_modules)|\bscripts\b|\bextension\/(?:lib|background|options|ntp|sidepanel)\b)/i;

  for (const { rel, code } of files) {
    const consideredSites = new Set(removalCallSites(code).considered);
    for (const fn of REMOVAL_FUNCTIONS) {
      const escaped = fn.replace(/\./g, "\\.");
      for (const m of code.matchAll(new RegExp(`\\b${escaped}\\s*\\(`, "g"))) {
        if (!consideredSites.has(m.index)) continue;
        let depth = 0;
        let buf = "";
        const args: string[] = [];
        let i = m.index! + m[0].length;
        for (; i < code.length; i++) {
          const c = code[i];
          if (c === "(" || c === "[" || c === "{") depth++;
          else if (c === ")" || c === "]" || c === "}") {
            if (depth === 0) {
              if (buf.trim()) args.push(buf.replace(/\s+/g, " ").trim());
              break;
            }
            depth--;
          } else if (c === "," && depth === 0) {
            args.push(buf.replace(/\s+/g, " ").trim());
            buf = "";
            continue;
          }
          buf += c;
        }

        if (args.length >= 2 && /recursive:\s*true/.test(args[1])) {
          const target = args[0];
          // Resolve aliases by their declarations, never by their names. In particular `scratch` can
          // denote join(ROOT, "tests", "helpers"), while `realHelpersDir` can denote makeTempDir().
          const seen = new Set<string>();
          const definitions: string[] = [];
          const resolve = (expression: string): void => {
            definitions.push(expression);
            // Follow only path-bearing expressions: an identifier, the base of join(), or a
            // template interpolation. Do not treat every word in a declaration as an alias
            // (a diagnostic string mentioning `scripts` is not a path definition).
            const base = /^(?:await\s+)?(?:join|resolve)\(\s*([A-Za-z_$][\w$]*)\s*,/.exec(expression);
            const ids = /^[A-Za-z_$][\w$]*$/.test(expression)
              ? [expression]
              : [...(base ? [base[1]] : []), ...[...expression.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)].map((match) => match[1])];
            for (const id of ids) {
              if (seen.has(id)) continue;
              seen.add(id);
              const declarations = [...code.slice(0, m.index).matchAll(
                new RegExp(`\\b(?:const|let|var)\\s+${id}\\s*=\\s*([^;]+);`, "g"),
              )];
              const declaration = declarations.at(-1);
              if (declaration) resolve(declaration[1].trim());
            }
          };
          resolve(target);
          const combined = definitions.join(" ");
          // An isolated root must be proven by the expression's definition. durableDir alone is
          // persistent and does not make a path per-run; a makeTempDir result does.
          const isolatedRoot = definitions.slice(1).some((definition) =>
            /^(?:await\s+)?(?:Deno\.)?makeTempDir(?:Sync)?\s*\(/.test(definition)
          ) || /^(?:await\s+)?(?:Deno\.)?makeTempDir(?:Sync)?\s*\(/.test(target) ||
            /^(?:join|resolve)\(\s*(?:await\s+)?(?:Deno\.)?makeTempDir(?:Sync)?\s*\(/.test(target);
          if (SHARED_PATH_PATTERN.test(combined) && !isolatedRoot) {
            violations.push(`${rel}: ${fn}(${target}, ${args[1]}) denotes shared path: "${combined}"`);
          }
        }
      }
    }
  }
  return violations;
}

Deno.test("afpl: no test in tests/ recursively removes shared repository directories (e.g. tests/helpers)", () => {
  const testFiles = enumerateTestFiles();
  const violations = findRecursiveRemovalsOfSharedPaths(testFiles);
  assertEquals(
    violations,
    [],
    `Tests must never recursively remove shared repository directories:\n${violations.join("\n")}`,
  );
});

Deno.test("afpl: repo-wide removal-call differential excludes only fixture ranges, never live calls", () => {
  const files = enumerateTestFiles();
  let raw = 0;
  let considered = 0;
  let fixtures = 0;
  for (const { rel, code } of files) {
    const sites = removalCallSites(code);
    raw += sites.raw.length;
    considered += sites.considered.length;
    fixtures += sites.fixture.length;
    // The independent raw scan and byte offsets must account for every dropped match.
    const independent = REMOVAL_FUNCTIONS.flatMap((fn) => [...code.matchAll(
      new RegExp(`\\b${fn.replace(/\./g, "\\.")}\\s*\\(`, "g"),
    )].map((m) => m.index));
    const ranges = guardFixtureRanges(code);
    const legitimate = independent.filter((index) => ranges.some(({ start, end }) => index >= start && index < end));
    assertEquals(sites.considered.slice().sort((a, b) => a - b),
      independent.filter((index) => !legitimate.includes(index)).sort((a, b) => a - b),
      `${rel}: no non-fixture call may be dropped`);
    assertEquals(sites.fixture.length, legitimate.length, `${rel}: only code: fixture calls may be skipped`);
  }
  assert(raw > 200 && considered > 190, `repo-wide differential must inspect live calls: ${raw} raw, ${considered} considered`);
  assertEquals(raw - considered - fixtures, 0, "illegitimate removal-call drops must be zero");
  const evidence = files.find(({ rel }) => rel === "tests/evidence-durable.test.ts");
  assert(evidence, "evidence-durable test must be scanned");
  const live = removalCallSites(evidence.code).considered;
  assert(live.some((index) => evidence.code.slice(index).startsWith("Deno.removeSync(required)")), "required cleanup must be considered");
  assert(live.some((index) => evidence.code.slice(index).startsWith("Deno.removeSync(tmp,")), "tmp cleanup must be considered");
});

Deno.test("afpl: real regex and literal slashes cannot hide a planted live shared-path removal", () => {
  for (const rel of ["tests/evidence-durable.test.ts", "tests/package-scripts-exist.test.ts"]) {
    const code = readFileSync(join(ROOT, rel), "utf8") +
      '\nconst afplLiveShared = join(ROOT, "tests", "helpers");\nawait Deno.remove(afplLiveShared, { recursive: true });\n';
    const violations = findRecursiveRemovalsOfSharedPaths([{ rel, code }]);
    assertEquals(violations.length, 1, `${rel}: live removal after regex trigger must RED`);
  }
  const source = '// unrelated ` comment\nconst scratch = join(ROOT, "tests", "helpers");\n' +
    'await Deno.remove(scratch, { recursive: true });\n' +
    'const mock = {\n code: `await Deno.' + 'remove("tests/helpers", { recursive: true });` };';
  assertEquals(findRecursiveRemovalsOfSharedPaths([{ rel: "tests/zz-live.test.ts", code: source }]).length, 1,
    "live removal must be caught; fixture-body call must be ignored");
});

Deno.test("afpl: falsification — recursive removal of tests/helpers or a shared root is flagged and temp dirs are admitted", () => {
  const badSamples = [
    {
      rel: "tests/zz-bad1.test.ts",
      code: `const realHelpersDir = join(ROOT, "tests", "helpers");\nawait Deno.remove(realHelpersDir, { recursive: true });`,
    },
    {
      rel: "tests/zz-bad2.test.ts",
      code: `await Deno.remove(join(ROOT, "tests", "helpers"), { recursive: true });`,
    },
    {
      rel: "tests/zz-bad3.test.ts",
      code: `Deno.removeSync("tests/helpers", { recursive: true });`,
    },
    {
      rel: "tests/zz-bad4.test.ts",
      code: `await rm(join(ROOT, "tests"), { recursive: true });`,
    },
  ];
  for (const sample of badSamples) {
    const violations = findRecursiveRemovalsOfSharedPaths([sample]);
    assert(
      violations.length > 0,
      `falsification drill must flag recursive removal of shared directory in ${sample.rel}`,
    );
  }

  // Over-match negative: per-run makeTempDir and durableDir scratch dirs must NOT be flagged
  const goodSamples = [
    {
      rel: "tests/zz-good1.test.ts",
      code: `const scratch = await Deno.makeTempDir({ dir: durableDir("scratch") });\nawait Deno.remove(scratch, { recursive: true });`,
    },
    {
      rel: "tests/zz-good2.test.ts",
      code: `const tempDir = await Deno.makeTempDir({ dir: durableDir("test") });\nconst output = join(tempDir, "dir");\nawait Deno.remove(output, { recursive: true }).catch(() => {});`,
    },
    {
      rel: "tests/zz-good3.test.ts",
      code: `const profile = await Deno.makeTempDir({ dir: durableDir("scratch") });\nawait rm(profile, { recursive: true, force: true });`,
    },
  ];
  badSamples.push(
    { rel: "tests/zz-bad-alias.test.ts", code: `const scratch = join(ROOT, "tests", "helpers");\nawait Deno.remove(scratch, { recursive: true });` },
    { rel: "tests/zz-bad-template.test.ts", code: `const parent = join(ROOT, "tests", "helpers");\nawait Deno.remove(\`\${parent}/nested\`, { recursive: true });` },
    { rel: "tests/zz-bad-false-temp.test.ts", code: `await Deno.remove(join(ROOT, "tests", "helpers", Deno.makeTempDirSync({ dir: durableDir("scratch") })), { recursive: true });` },
  );
  for (const sample of badSamples.slice(-3)) {
    assert(
      findRecursiveRemovalsOfSharedPaths([sample]).length > 0,
      `a shared path must be flagged regardless of the alias name in ${sample.rel}`,
    );
  }
  goodSamples.push({
    rel: "tests/zz-good-alias.test.ts",
    code: `const realHelpersDir = await Deno.makeTempDir({ dir: durableDir("scratch") });\nawait Deno.remove(realHelpersDir, { recursive: true });`,
  });
  const falsePositives = findRecursiveRemovalsOfSharedPaths(goodSamples);
  assertEquals(falsePositives, [], `scratch/temp directory removals must NOT be flagged: ${falsePositives.join(", ")}`);
});
