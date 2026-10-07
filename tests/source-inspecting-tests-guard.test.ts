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
//   6. p4tf: no test or script under tests/ or scripts/ invokes find for file absence or inspection (box hazard).

import { assert, assertEquals } from "jsr:@std/assert@1";
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

Deno.test("qcfc: self-checking audit: all dynamic source-scanning test guards are in ALWAYS_ON", () => {
  const testsDir = join(ROOT, "tests");
  const testFiles = readdirSync(testsDir)
    .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.js"))
    .map((f) => ({
      rel: `tests/${f}`,
      code: readFileSync(join(testsDir, f), "utf8"),
    }));

  const alwaysOnSet = new Set(ALWAYS_ON);
  const unclassified = findUnclassifiedSourceScanners(testFiles, alwaysOnSet);

  assertEquals(
    unclassified,
    [],
    `Dynamic source-scanning test(s) found without being in ALWAYS_ON: ${unclassified.join(", ")}. Add them to SOURCE_INSPECTING_GUARDS in scripts/select-tests.mjs.`,
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
