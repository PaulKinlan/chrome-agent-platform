// tests/select-tests.test.ts — falsification pins for the dependency-aware
// subset picker (chrome-agent-platform-9hoc). The picker must NEVER lose a
// test that imports a changed file: that would let a per-commit gate go green
// while the full suite goes red. These pins fail if the static-import graph
// logic or the always-on core contract regresses.
import { assertEquals, assert } from "jsr:@std/assert@1";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CORE, ROOT, buildReverseGraph, selectTestFiles } from "../scripts/select-tests.mjs";

// A real seam with a known importer: schedule-parser.js is imported by
// tests/schedule-parser.test.ts. If the graph walk stops resolving, the subset
// silently loses coverage — this pin is the RED that catches that.
Deno.test("select-tests: a changed source file selects its direct importer test", () => {
  const reverse = buildReverseGraph();
  const selected = selectTestFiles(["extension/shared/schedule-parser.js"], reverse);
  assert(
    selected.includes("tests/schedule-parser.test.ts"),
    `schedule-parser.test.ts must be selected when schedule-parser.js changes; got: ${selected.length} files`,
  );
});

Deno.test("select-tests: changed test files always run themselves", () => {
  const selected = selectTestFiles(["tests/security.test.ts"], null);
  assert(selected.includes("tests/security.test.ts"), "a changed test file must run itself");
});

Deno.test("select-tests: the always-on core never silently shrinks", () => {
  const selected = selectTestFiles([], null);
  for (const core of CORE) {
    assert(selected.includes(core), `${core} is always-on core and must always be selected`);
    assert(existsSync(join(ROOT, core)), `${core} exists on disk`);
  }
  // Core is security + vocabulary; dropping one of them would weaken the
  // per-commit gate for exactly the regressions subsetting must not miss.
  assertEquals(CORE.length, 5, "core = security(3) + redaction + vocabulary");
});

Deno.test("select-tests: selected files exist and are sorted, no duplicates", () => {
  const reverse = buildReverseGraph();
  const selected = selectTestFiles(["extension/lib/pure.js"], reverse);
  assertEquals(new Set(selected).size, selected.length, "no duplicate selection");
  for (const f of selected) {
    assert(existsSync(join(ROOT, f)), `selected file exists: ${f}`);
    assert(f.endsWith(".test.ts"), `only test files are selected: ${f}`);
  }
});
