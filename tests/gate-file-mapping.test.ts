// The FAST ledger must distinguish graph-reachable suites that ran from
// changed files with no executed inspecting suite, and give the latter a reason.
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { buildReverseGraph, changedWithoutCoverage, testCandidatesForChanged } from "../scripts/select-tests.mjs";
import { explainChangedFileMapping, formatGateManifest, emitGateLedger, fullTierManifestFields } from "../scripts/lib/gate-manifest.mjs";
import { isSelectorInfrastructure } from "../scripts/lib/changed-file-mapping.mjs";

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

Deno.test("z06au: gif/pdf content is not falsely marked unmapped by the ledger", () => {
  assertEquals(isSelectorInfrastructure("scripts/lib/content-exemptions.mjs"), true, "the selector must not subset-certify edits to its own content policy");
  const passive = ["extension/icons/a.gif", "docs/reference.pdf", "extension/icons/b.png"];
  assertEquals(changedWithoutCoverage(passive, new Map()), []);
  const rows = explainChangedFileMapping({ changed: passive, executedSuites: [] });
  assertEquals(rows.map((row: {status: string}) => row.status), passive.map(() => "not-applicable"));
  const lines: string[] = [];
  emitGateLedger({ fileMapping: rows, log: (line: string) => lines.push(line) });
  assertEquals(lines.some((line) => line.startsWith("fast-gate: unmapped:")), false);
});

Deno.test("z06au: direct docs HTML classification stays executable for selector and ledger", () => {
  const executable = "docs/index.html";
  assertEquals(changedWithoutCoverage([executable], new Map()), [executable]);
  const rows = explainChangedFileMapping({ changed: [executable], executedSuites: [] });
  assertEquals(rows[0].status, "unmapped");
  const lines: string[] = [];
  emitGateLedger({ fileMapping: rows, log: (line: string) => lines.push(line) });
  assertEquals(lines.filter((line) => line.startsWith("fast-gate: unmapped:")), ["fast-gate: unmapped: docs/index.html"]);
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

// chrome-agent-platform-ea2qv: a FAILED run must not accuse the SELECTOR. select-tests.mjs zeroes the
// executed suite list when rc != 0 (w6kc0: a failed run certifies nothing, and that must stay), and the
// ledger used to translate that empty list into "not run: ... heavy tier owns the verdict" / "reachable
// suite(s) not executed" — a selection omission that never happened. On 2026-10-23 that text sent coord
// to commission a selector fix and made me file a P3 against the selector (4ml4b, withdrawn) while the
// gate's own log showed the suite had run and passed 37 tests inside that very run.
Deno.test("ea2qv: a failed run reports the FAILURE, not a selection omission, for a file whose suites were selected", () => {
  const changed = ["scripts/lib/quiet-window.ts"];
  const candidates = { "scripts/lib/quiet-window.ts": ["tests/quiet-window.test.ts"] };
  const [failed] = explainChangedFileMapping({
    changed,
    candidates,
    executedSuites: [], // exactly what select-tests.mjs passes when rc != 0
    omitted: [], // the suite was NOT omitted — it ran
    runExitCode: 1,
  });
  assertEquals(failed.status, "unmapped");
  assertEquals(failed.executed_suites, []);
  assertStringIncludes(failed.reason, "run failed, rc=1");
  assertStringIncludes(failed.reason, "no selection omission is claimed");
  assert(
    !failed.reason.includes("quiet box") && !failed.reason.includes("not executed") && !failed.reason.includes("unselected"),
    `a failed run must not name a selection omission: ${failed.reason}`,
  );
});

Deno.test("ea2qv: a green run's rows are byte-identical to today's, and a real omission keeps its own reason", () => {
  const base = {
    changed: ["scripts/lib/quiet-window.ts", "tests/python-runtime.test.ts"],
    candidates: {
      "scripts/lib/quiet-window.ts": ["tests/quiet-window.test.ts"],
      "tests/python-runtime.test.ts": ["tests/python-runtime.test.ts"],
    },
    executedSuites: ["tests/quiet-window.test.ts"],
    omitted: [{ file: "tests/python-runtime.test.ts", reason: "deferred: Pyodide tier only" }],
  };
  const implicit = explainChangedFileMapping(base as never);
  const explicitGreen = explainChangedFileMapping({ ...base, runExitCode: 0 } as never);
  assertEquals(JSON.stringify(explicitGreen), JSON.stringify(implicit), "rc=0 must not change one byte of the ledger");
  assertEquals(implicit[0].status, "mapped", "the file whose suite ran is still mapped on a green run");

  // rc != 0, but this file's suite was GENUINELY omitted: the omission is true whatever the run did, so
  // it must keep its own reason instead of being relabelled as a failure.
  const failed = explainChangedFileMapping({ ...base, executedSuites: [], runExitCode: 7 } as never);
  assertStringIncludes(failed[1].reason, "Pyodide tier only");
  assertStringIncludes(failed[0].reason, "run failed, rc=7");
});

// ea2qv review finding 7w5k1: the FULL tier has the same hole as the fast tier. A selector-infrastructure
// change fail-closes to FULL, FULL zeroes executed_suites on rc != 0 (w6kc0), and the ledger used to
// report that as "reachable suite(s) not executed" — the same false accusation, one tier up — which is
// precisely the path this bead's own branch takes. The full tier must name the failure, and a file whose
// suite genuinely deferred to another tier must keep its own tier reason.
Deno.test("7w5k1: a failed FULL run names the failure, and a deferred suite keeps its tier reason", () => {
  const fields = fullTierManifestFields({
    parallelFiles: ["tests/thread-export-sw-entry.test.ts"],
    rc: 1,
    deferred: [{ file: "tests/python-runtime.test.ts", reason: "Pyodide >10MB; only test:heavy runs it" }],
    fileMappingContext: {
      changed: ["tests/python-runtime.test.ts", "extension/background/service-worker.js"],
      candidates: {
        "tests/python-runtime.test.ts": ["tests/python-runtime.test.ts"],
        "extension/background/service-worker.js": ["tests/thread-export-sw-entry.test.ts"],
      },
      unmappable: [],
    },
  }) as { fileMapping?: Array<{ file: string, status: string, reason: string, executed_suites: string[] }> } | null;
  const rows = fields?.fileMapping ?? [];
  const sw = rows.find((row) => row.file === "extension/background/service-worker.js");
  assertEquals(sw?.status, "unmapped");
  assertStringIncludes(sw?.reason ?? "", "run failed, rc=1");
  assert(
    !(sw?.reason ?? "").includes("not executed"),
    `the full tier must not accuse the selector of an omission: ${sw?.reason}`,
  );
  const py = rows.find((row) => row.file === "tests/python-runtime.test.ts");
  assertStringIncludes(py?.reason ?? "", "test:heavy", "a genuinely deferred suite keeps its own tier reason");
});

Deno.test("7w5k1: a FAILED full run names failure, not a selection omission, in fileMapping reasons", () => {
  // The bead's verbatim repro: fullTierManifestFields zeroes executedSuites on rc!=0
  // (a failed run certifies nothing) but used to leave the explainer blind to WHY, so
  // every reachable suite read "not executed" — a selection-omission claim.
  const fields = fullTierManifestFields({
    serialFiles: ["tests/quiet-window.test.ts"], parallelFiles: [], rc: 1,
    fileMappingContext: {
      changed: ["scripts/lib/quiet-window.ts"],
      candidates: { "scripts/lib/quiet-window.ts": ["tests/quiet-window.test.ts"] },
      unmappable: [],
    },
  });
  const rows = (fields as { fileMapping?: Array<{file: string; status: string; reason: string}> } | null)?.fileMapping ?? [];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].status, "unmapped");
  assertStringIncludes(rows[0].reason, "executed suites not attributable (run failed, rc=1)");
  assert(!rows[0].reason.includes("not executed"), "a failed run must not read as a selection omission");
});

Deno.test("7w5k1: a GREEN full run keeps the selection-omission wording for genuinely unexecuted suites", () => {
  const fields = fullTierManifestFields({
    serialFiles: [], parallelFiles: [], rc: 0,
    fileMappingContext: {
      changed: ["scripts/lib/quiet-window.ts"],
      candidates: { "scripts/lib/quiet-window.ts": ["tests/quiet-window.test.ts"] },
      unmappable: [],
    },
  });
  const rows = (fields as { fileMapping?: Array<{file: string; reason: string}> } | null)?.fileMapping ?? [];
  assertStringIncludes(rows[0].reason, "reachable suite(s) not executed");
});

Deno.test("7w5k1: explainChangedFileMapping defaults to the old wording (runExitCode unset) and a real omission still wins on a failed run", () => {
  const defaultRows = explainChangedFileMapping({
    changed: ["a.ts"], candidates: { "a.ts": ["tests/a.test.ts"] }, executedSuites: [],
  });
  assertStringIncludes(defaultRows[0].reason, "reachable suite(s) not executed");
  // A suite with its own omission reason keeps it even when the run failed: the
  // specific truth (why it did not run) beats the general one (the run failed).
  const omittedRows = explainChangedFileMapping({
    changed: ["a.ts"], candidates: { "a.ts": ["tests/a.test.ts"] }, executedSuites: [],
    omitted: [{ file: "tests/a.test.ts", reason: "heavy tier owns the verdict" }],
    runExitCode: 1,
  });
  assertStringIncludes(omittedRows[0].reason, "reachable suite not run: heavy tier owns the verdict");
});
