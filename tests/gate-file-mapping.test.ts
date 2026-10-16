// The FAST ledger must distinguish graph-reachable suites that ran from
// changed files with no executed inspecting suite, and give the latter a reason.
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { buildReverseGraph, testCandidatesForChanged } from "../scripts/select-tests.mjs";
import { explainChangedFileMapping, formatGateManifest, emitGateLedger, fullTierManifestFields } from "../scripts/lib/gate-manifest.mjs";

Deno.test("sgzyg: independent fleet contract names only guards selected for their actual changed source", () => {
  const contract = JSON.parse(Deno.readTextFileSync(new URL("./coverage-contract.json", import.meta.url)));
  assertEquals(Object.keys(contract).sort(), [
    "extension/background/service-worker.js", "extension/lib/python-documents-bundle.js",
  ]);
  const graph = buildReverseGraph();
  for (const [source, guards] of Object.entries(contract) as Array<[string, string[]]>) {
    const selected = testCandidatesForChanged([source], graph);
    for (const guard of guards) {
      assert(selected.includes(guard), `${source}: ${guard} must execute for fleet coverage contract to claim attribution`);
      assert(guardExists(guard), `${guard} must exist`);
    }
  }
});

function guardExists(file: string) {
  try { return Deno.statSync(new URL(`../${file}`, import.meta.url)).isFile; } catch { return false; }
}

Deno.test("sgzyg: manifest refuses a coverage claim without its executable suite or omission reason", () => {
  for (const row of [
    { file: "extension/lib/no-guard.js", status: "unmapped", executed_suites: [], reason: "" },
    { file: "extension/background/service-worker.js", status: "mapped", executed_suites: [], reason: "guard ran" },
  ]) {
    assertThrows(() => formatGateManifest({ tier: "fast", executed: 0, fileMapping: [row] }), Error, "invalid reasoned changed-file placement");
  }
});

Deno.test("sgzyg: candidate attribution excludes unrelated always-on suites", () => {
  const graph = buildReverseGraph();
  const guard = "tests/thread-export-sw-entry.test.ts";
  assert(testCandidatesForChanged(["extension/background/service-worker.js"], graph).includes(guard));
  assertEquals(testCandidatesForChanged(["extension/not-a-file-sgzyg.js"], graph), []);
});

Deno.test("sgzyg: file ledger names every path, executed guard, and reason for missing coverage", () => {
  const rows = explainChangedFileMapping({
    changed: [
      ".beads/issues.jsonl",
      "extension/background/service-worker.js",
      "extension/no-guard.js",
      "tests/python-runtime.test.ts",
    ],
    candidates: {
      "extension/background/service-worker.js": ["tests/thread-export-sw-entry.test.ts"],
      "tests/python-runtime.test.ts": ["tests/python-runtime.test.ts"],
    },
    executedSuites: ["tests/thread-export-sw-entry.test.ts", "tests/changed-file-mapping.test.ts"],
    omitted: [{ file: "tests/python-runtime.test.ts", reason: "deferred: Pyodide tier only" }],
    unmappable: [{ file: "extension/no-guard.js", mechanism: "no graph importer; full suite fallback" }],
  });
  assertEquals(rows.map((r: { file: string; status: string }) => [r.file, r.status]), [
    [".beads/issues.jsonl", "not-applicable"],
    ["extension/background/service-worker.js", "mapped"],
    ["extension/no-guard.js", "unmapped"],
    ["tests/python-runtime.test.ts", "unmapped"],
  ]);
  assertEquals(rows[1].executed_suites, ["tests/thread-export-sw-entry.test.ts"]);
  assertStringIncludes(rows[2].reason, "no graph importer");
  assertStringIncludes(rows[3].reason, "Pyodide tier only");
  const manifest = JSON.parse(formatGateManifest({
    tier: "fast", executed: 2, executedSuites: ["tests/thread-export-sw-entry.test.ts", "tests/changed-file-mapping.test.ts"],
    fileMapping: rows,
  }).split(": manifest: ")[1]);
  assertEquals(manifest.file_mapping, rows);
  const lines: string[] = [];
  emitGateLedger({ manifest: {
    tier: "fast", executed: 2, executedSuites: ["tests/thread-export-sw-entry.test.ts", "tests/changed-file-mapping.test.ts"],
    fileMapping: rows,
  }, fileMapping: rows, log: (line: string) => lines.push(line) });
  assert(lines.some((line) => line === "fast-gate: unmapped: extension/no-guard.js tests/python-runtime.test.ts"));
  assert(lines.some((line) => line.startsWith("fast-gate: unmapped-reason: ") && line.includes("Pyodide tier only")));
});

Deno.test("sgzyg: executing a selector import does not make its self-chosen subset authoritative", () => {
  const rows = explainChangedFileMapping({
    changed: ["scripts/select-tests.mjs"],
    candidates: { "scripts/select-tests.mjs": ["tests/select-tests.test.ts"] },
    executedSuites: ["tests/select-tests.test.ts"],
    unmappable: [{ file: "scripts/select-tests.mjs", mechanism: "selector OWN machinery requires full-suite fallback" }],
  });
  assertEquals(rows[0].status, "unmapped");
  assertStringIncludes(rows[0].reason, "OWN machinery");
});

Deno.test("sgzyg: fail-closed FULL records changed heavy test as not run, with its tier reason", () => {
  const fields = fullTierManifestFields({
    parallelFiles: ["tests/thread-export-sw-entry.test.ts"], rc: 0,
    deferred: [{ file: "tests/python-runtime.test.ts", reason: "Pyodide >10MB; only test:heavy runs it" }],
    fileMappingContext: {
      changed: ["tests/python-runtime.test.ts", "extension/background/service-worker.js"],
      candidates: {
        "tests/python-runtime.test.ts": ["tests/python-runtime.test.ts"],
        "extension/background/service-worker.js": ["tests/thread-export-sw-entry.test.ts"],
      },
      unmappable: [],
    },
  });
  const rows = (fields as { fileMapping?: Array<{file: string; status: string; reason: string; executed_suites: string[]}> } | null)?.fileMapping ?? [];
  assertEquals(rows.find((row) => row.file === "tests/python-runtime.test.ts")?.status, "unmapped");
  assertStringIncludes(rows.find((row) => row.file === "tests/python-runtime.test.ts")?.reason ?? "", "test:heavy");
  assertEquals(rows.find((row) => row.file === "extension/background/service-worker.js")?.executed_suites, ["tests/thread-export-sw-entry.test.ts"]);
});
