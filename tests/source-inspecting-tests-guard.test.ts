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
    /SCAN_DIRS/i,
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
  ];

  for (const { rel, code } of testFiles) {
    if (alwaysOnSet.has(rel)) continue;
    // chrome-agent-platform-kz27: a DECLARED exclusion is classified — it carries a reason and a bead,
    // so the choice is written down rather than being an accidental omission. That is why
    // SCANNER_EXCLUSIONS exists instead of a quietly missing list entry.
    if (Object.hasOwn(SCANNER_EXCLUSIONS, rel)) continue;
    // If it dynamically scans source directories, it must be in ALWAYS_ON
    if (SCANNER_PATTERNS.some((pat) => pat.test(code))) {
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
