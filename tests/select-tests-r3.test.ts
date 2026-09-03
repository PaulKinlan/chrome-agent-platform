// tests/select-tests-r3.test.ts — r3 review falsification pins
// (chrome-agent-platform-9hoc). Each test is RED on the r1 candidate
// (9e85a2ff) and GREEN with the r3 fixes:
//   1. a deleted/renamed module retains its importers (fail-open guard),
//   2. concatenated dynamic imports (import("...js?n=" + n)) are recognized,
//   3. deletion through a re-export barrel keeps the barrel's consumer test,
//   4. deletion through a multi-hop chain keeps the far test,
//   5. changed code/config with no reachable test FAILS CLOSED (full suite).
// Namespace import so a pre-fix module (missing the new export) fails per-test
// at call time instead of at module load.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "node:path";
import * as picker from "../scripts/select-tests.mjs";

const { ROOT, buildReverseGraph, selectTestFiles } = picker;

// The changed path does not exist on disk (module deleted) but its importer
// test still references it. r1 dropped absent changed paths before the graph
// lookup, so only core ran while the importer's import failed in the full
// suite. r3 retains the path as a graph key and must select the importer.
Deno.test("r3: a deleted module keeps its direct importer test selected", () => {
  const reverse = buildReverseGraph();
  const missing = "extension/lib/9hoc-deleted-direct.js"; // never exists
  reverse.set(join(ROOT, missing), new Set([join(ROOT, "tests/schedule-parser.test.ts")]));
  const selected = selectTestFiles([missing], reverse);
  assert(
    selected.includes("tests/schedule-parser.test.ts"),
    `deleted module must select its importer test; got ${selected.length} files`,
  );
});

// tests/agent-worker-host.test.ts:104 imports the host module ONLY through a
// concatenated dynamic import (`import("../extension/lib/agent-worker-host.js?n="
// + Date.now())`). r1's regex required the closing paren immediately after the
// quoted specifier, so the seam had no graph edge and its behavioral test was
// never selected when the host changed.
Deno.test("r3: a concatenated dynamic import selects its seam test", () => {
  const reverse = buildReverseGraph();
  const selected = selectTestFiles(["extension/lib/agent-worker-host.js"], reverse);
  assert(
    selected.includes("tests/agent-worker-host.test.ts"),
    `host change must select the concat-importing test; got ${selected.length} files`,
  );
});

// Deletion through a barrel: tests import the barrel, the barrel re-exports the
// (deleted) leaf. The reverse chain leaf -> barrel -> test must survive when the
// leaf path is absent from the tree.
Deno.test("r3: a deleted re-exported module keeps the barrel consumer test selected", () => {
  const reverse = buildReverseGraph();
  const missing = "extension/lib/9hoc-deleted-reexport.js"; // never exists
  const barrel = "extension/lib/9hoc-reexport-barrel.js"; // non-test intermediate (mirrors `export * from "./9hoc-deleted-reexport.js"`)
  const testPath = join(ROOT, "tests/agent-worker-host.test.ts");
  reverse.set(join(ROOT, missing), new Set([join(ROOT, barrel)]));
  reverse.set(join(ROOT, barrel), new Set([testPath]));
  const selected = selectTestFiles([missing], reverse);
  assert(
    selected.includes("tests/agent-worker-host.test.ts"),
    `deleted re-exported leaf must keep the barrel consumer; got ${selected.length} files`,
  );
});

// Multi-hop deletion: leaf -> lib A -> lib B -> test. Only the leaf changed
// (deleted); the chain of non-test intermediates must still resolve to the test.
Deno.test("r3: a deleted leaf keeps the multi-hop test selected", () => {
  const reverse = buildReverseGraph();
  const missing = "extension/lib/9hoc-deleted-leaf.js"; // never exists
  const midA = "extension/lib/9hoc-mid-a.js"; // non-test intermediate
  const midB = "extension/lib/9hoc-mid-b.js"; // non-test intermediate
  const testPath = join(ROOT, "tests/schedule-parser.test.ts");
  reverse.set(join(ROOT, missing), new Set([join(ROOT, midA)]));
  reverse.set(join(ROOT, midA), new Set([join(ROOT, midB)]));
  reverse.set(join(ROOT, midB), new Set([testPath]));
  const selected = selectTestFiles([missing], reverse);
  assert(
    selected.includes("tests/schedule-parser.test.ts"),
    `deleted leaf must reach the multi-hop test; got ${selected.length} files`,
  );
});

// FAIL CLOSED: a changed code/config file with no reachable test must force the
// full suite. Real seams: package.json has no importer; schedule-parser.js has
// its own test and is covered.
Deno.test("r3: a changed config file with no reachable test fails closed", () => {
  const changedWithoutCoverage = picker.changedWithoutCoverage;
  const reverse = buildReverseGraph();
  const uncovered = changedWithoutCoverage(["package.json"], reverse);
  assert(uncovered.includes("package.json"), "package.json has no importer and must fail closed");
});

Deno.test("r3: covered source and changed tests never fail closed", () => {
  const changedWithoutCoverage = picker.changedWithoutCoverage;
  const reverse = buildReverseGraph();
  assertEquals(changedWithoutCoverage(["extension/shared/schedule-parser.js"], reverse), [], "schedule-parser.js is import-covered");
  assertEquals(changedWithoutCoverage(["tests/security.test.ts"], reverse), [], "a changed test file runs itself");
  // A deleted module with a remaining importer is covered through retention,
  // not fail-closed.
  const missing = "extension/lib/9hoc-deleted-cover.js";
  const withImporter = new Map(reverse);
  withImporter.set(join(ROOT, missing), new Set([join(ROOT, "tests/schedule-parser.test.ts")]));
  assertEquals(changedWithoutCoverage([missing], withImporter), [], "deleted module with importer is retention-covered");
  // Pure content/docs cannot break the suite through code and must not fail closed.
  assertEquals(changedWithoutCoverage(["AGENTS.md"], withImporter), [], "md content never fails closed");
});

// The r1 pins must survive: covered seams still select, core is intact.
Deno.test("r3: existing r1 pins still hold on the fixed picker", () => {
  const reverse = buildReverseGraph();
  const selected = selectTestFiles(["extension/shared/schedule-parser.js"], reverse);
  assert(selected.includes("tests/schedule-parser.test.ts"), "schedule-parser pin survives");
  const core = selectTestFiles([], null);
  for (const c of picker.CORE) assert(core.includes(c), `${c} remains always-on core`);
});
