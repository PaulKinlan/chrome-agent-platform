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

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALWAYS_ON,
  CORE,
  ROOT,
  SCANNER_EXCLUSIONS,
  SOURCE_INSPECTING_GUARDS,
  buildReverseGraph,
  selectTestFiles,
} from "../scripts/select-tests.mjs";

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
    /readDirSync\(\s*join\(\s*ROOT\b/,
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
  const REPO_ROOT_URL = /new URL\(\s*["']\.\.\/?["']/;
  const TOP_LEVEL_URL = new RegExp(`new URL\\(\\s*["']\\.\\.?\\/(?:${TOP_LEVEL_DIRS})\\/?["']`);
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
    ["walk", "readDir", "readDirSync", "readdir"].flatMap((name) => firstArgs(code, name))
      .filter((arg) => (/^[A-Za-z_$][\w$]*$/.test(arg) ? identifierIsSourceRoot(arg, code, rel) : denotesSourceRoot(arg, rel)));
  for (const { rel, code } of testFiles) {
    if (alwaysOnSet.has(rel)) continue;
    // chrome-agent-platform-kz27: a DECLARED exclusion is classified — it carries a reason and a bead,
    // so the choice is written down rather than being an accidental omission. That is why
    // SCANNER_EXCLUSIONS exists instead of a quietly missing list entry.
    if (Object.hasOwn(SCANNER_EXCLUSIONS, rel)) continue;
    // If it dynamically scans source directories, it must be in ALWAYS_ON. The literal
    // patterns catch the ROOT-rooted shapes; the source-root test catches a walk over an
    // identifier that this file derives from a source root (p1lp), including lowercase ones.
    if (SCANNER_PATTERNS.some((pat) => pat.test(code)) || walkOrReadRoots(code, rel).length > 0) {
      unclassified.push(rel);
    }
  }
  return unclassified;
}

/**
 * The shared test-support roots this audit must scan too (chrome-agent-platform-afpl). The audit used to
 * enumerate tests/*.test.ts ONLY, so a repo walk moved into a HELPER was invisible — and that is the
 * shape a faithful `-static` split encourages, because the shared machinery has to live somewhere. The
 * same blind spot covered the non-test support modules sitting directly under tests/.
 *
 * tests/fixtures/ is deliberately NOT scanned: it is data, and a fixture reader must not be admitted.
 * That half matters as much as the other — widening a scan until it admits every fixture reader is how
 * an over-broad pattern once put a 23s esbuild-spawning file into the always-on set and tripled every
 * subset gate (chrome-agent-platform-fgik, and the reason p1lp replaced names with DEFINITIONS).
 */
const SHARED_SUPPORT_ROOTS = ["tests/helpers"];

/** Every shared test-support source file: the support roots above, plus non-test modules under tests/. */
export function sharedSupportFiles(
  readDir: (dir: string) => { name: string; isDirectory: () => boolean; isFile: () => boolean }[] = (dir) =>
    readdirSync(dir, { withFileTypes: true }),
): { rel: string; code: string }[] {
  const out: { rel: string; code: string }[] = [];
  const collect = (dir: string, rel: string) => {
    let entries: ReturnType<typeof readDir>;
    try { entries = readDir(dir); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) { collect(join(dir, e.name), childRel); continue; }
      if (!/\.(ts|js|mjs)$/.test(e.name) || /\.test\.(ts|js)$/.test(e.name)) continue;
      out.push({ rel: childRel, code: readFileSync(join(dir, e.name), "utf8") });
    }
  };
  for (const root of SHARED_SUPPORT_ROOTS) {
    const abs = join(ROOT, root);
    if (existsSync(abs)) collect(abs, root);
  }
  for (const e of readDir(join(ROOT, "tests"))) {
    if (!e.isFile() || !/\.(ts|js|mjs)$/.test(e.name) || /\.test\.(ts|js)$/.test(e.name)) continue;
    out.push({ rel: `tests/${e.name}`, code: readFileSync(join(ROOT, "tests", e.name), "utf8") });
  }
  return out;
}

/**
 * What to DO about a flagged shared-support module (coord's refinement on afpl): a helper cannot be an
 * ALWAYS_ON member, so naming it without saying so leaves the next splitter a red they cannot act on —
 * the same count-without-a-name failure this cluster has been removing all night, in a new place.
 */
export function supportModuleGuidance(unclassified: string[]): string {
  const support = unclassified.filter((rel) => !/\.test\.(ts|js)$/.test(rel));
  if (support.length === 0) return "";
  return `\n\n${support.length} of these are SHARED TEST-SUPPORT MODULE(S), which can never be an ALWAYS_ON member: ${support.join(", ")}. ` +
    `Move the walk into the test file that needs it, or put the static half in a test file. ` +
    `Do NOT silence this by adding a helper to SOURCE_INSPECTING_GUARDS — the list is for test files, ` +
    `and a helper there would be selected as a guard it is not.`;
}

Deno.test("qcfc: self-checking audit: all dynamic source-scanning test guards are in ALWAYS_ON", () => {
  const testsDir = join(ROOT, "tests");
  const testFiles = readdirSync(testsDir)
    .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.js"))
    .map((f) => ({
      rel: `tests/${f}`,
      code: readFileSync(join(testsDir, f), "utf8"),
    }));

  const alwaysOnSet = new Set(ALWAYS_ON);
  // afpl: TEST FILES AND THE SHARED SUPPORT MODULES, through the SAME classifier. A repo walk in a helper
  // is therefore a NAMED failure rather than an invisible hole, and it fails closed because a helper can
  // never legitimately be classified (it is not a guard and cannot be an ALWAYS_ON member).
  const scanned = [...testFiles, ...sharedSupportFiles()];
  const unclassified = findUnclassifiedSourceScanners(scanned, alwaysOnSet);

  assertEquals(
    unclassified,
    [],
    `Dynamic source-scanning guard(s) found without being in ALWAYS_ON: ${unclassified.join(", ")}. ` +
      `Add them to SOURCE_INSPECTING_GUARDS in scripts/select-tests.mjs.` +
      supportModuleGuidance(unclassified),
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

// chrome-agent-platform-afpl — the augmentation's proof, in BOTH directions and against a REAL file.
// The real tree has no repo-walking helper today (tests/helpers/ does not even exist), so the honest
// evidence is a helper CREATED on disk, asserted, and removed in a finally — a killed run must not leave
// residue (the reaper lesson). Substituting a synthetic string here would prove the parser and not the
// scan: the whole point is that the scan reaches that directory at all.
Deno.test("afpl: a repo-walking HELPER is named and fails the audit closed; a fixture-walking helper is NOT admitted", async () => {
  const dir = join(ROOT, "tests", "helpers");
  const walker = join(dir, "zz-afpl-repo-walk.ts");
  const fixtureReader = join(dir, "zz-afpl-fixture-read.ts");
  const dirWasAbsent = !existsSync(dir);
  try {
    await Deno.mkdir(dir, { recursive: true });
    // (i) A helper that walks a SOURCE root — the shape a -static split's shared machinery could hide.
    await Deno.writeTextFile(
      walker,
      `import { join } from "node:path";\nconst ROOT = "/repo";\n` +
        `export function census() { for (const f of Deno.readDirSync(join(ROOT, "tests"))) void f; }\n`,
    );
    const named = findUnclassifiedSourceScanners(sharedSupportFiles(), new Set());
    assertEquals(
      named.includes("tests/helpers/zz-afpl-repo-walk.ts"),
      true,
      `a repo-walking helper must be SCANNED and NAMED — this is the coverage proof, not a skip: ${JSON.stringify(named)}`,
    );
    // ...and the audit must say WHAT TO DO, because a helper can never be an ALWAYS_ON member.
    const guidance = supportModuleGuidance(named);
    assertStringIncludes(guidance, "zz-afpl-repo-walk.ts", "the guidance must name the module");
    assertStringIncludes(guidance, "Move the walk into the test file", "the guidance must say what to do");
    assertStringIncludes(guidance, "can never be an ALWAYS_ON member", "the guidance must say why not");

    // (ii) A helper that walks ONLY its own fixture directory must NOT be admitted — the over-match half,
    // which is what stops the scan being widened until every fixture reader is a "guard" (p1lp's lesson).
    await Deno.writeTextFile(
      fixtureReader,
      `import { join } from "node:path";\nconst SCRATCH = "/tmp/afpl-fixtures";\n` +
        `export function list() { for (const f of Deno.readDirSync(SCRATCH)) void f; }\n`,
    );
    const after = findUnclassifiedSourceScanners(sharedSupportFiles(), new Set());
    assertEquals(
      after.includes("tests/helpers/zz-afpl-fixture-read.ts"),
      false,
      `a fixture-walking helper must NOT be admitted: ${JSON.stringify(after)}`,
    );
  } finally {
    // No residue, even on a kill: the finally covers an exception, and the names are unmistakable.
    await Deno.remove(walker).catch(() => {});
    await Deno.remove(fixtureReader).catch(() => {});
    if (dirWasAbsent) await Deno.remove(dir).catch(() => {});
  }
});
