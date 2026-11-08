// tests/gate-bookkeeping-freshness.test.ts — chrome-agent-platform-jw8a6 + finua
//
// THE DEFECT CLASS. Measurement bookkeeping recorded ONCE and never re-derived:
// scripts/lib/test-weights.json sat on its 2026-10-16/55876826 generation while
// 224 eligible >=3s files carried no weight and started late as "light" (jw8a6),
// and scripts/test-partition.mjs's HEAVY_GATE_REASONS cited the pre-split
// 894s/a849a9b3e endurance measurement thirteen days after the split had moved
// that endurance into five weighted sibling files (finua). Both numbers were not
// WRONG when written — they went stale, and nothing failed when they did.
//
// WHAT THIS DRIVES. The refreshed generation (2026-11-08, tree 5f7e345d, the
// quietest COMPLETE post-split log available — impl-a lane fast gate for
// 451a50399, PASS, 772 measured suites, steal mostly 0.8–9.2%): the weights
// table covers every eligible >=3s file its derivation log measured, names the
// log, and records the log's steal (the jw8a6 caveat made steal-free provenance
// a defect); the heavy reason describes the POST-split file and names why the
// placement is kept. These pins are the falsifier: revert the table to the old
// generation or restore the pre-split citation and they go RED.

import { assert } from "jsr:@std/assert@1";

const SPLIT_DATE = "2026-10-24"; // ifu81 moved the wasm-sync endurance into sibling files (32b72e03f)

// Files whose absence from the weights table was the recorded defect (jw8a6's
// weekly-review offenders) plus the five post-split siblings (ifu81's split).
const MUST_BE_WEIGHTED = [
  "tests/callexport-admission.test.ts",
  "tests/select-tests.test.ts",
  "tests/durable-root.test.ts",
  "tests/kat-embedded-settings-canary.test.ts",
  "tests/build-tier-inputs.test.ts",
  "tests/wasm-sync-workspace-seed-file-limit.test.ts",
  "tests/wasm-sync-workspace-seed-maxima.test.ts",
  "tests/wasm-sync-workspace-seed-total-limit.test.ts",
  "tests/wasm-sync-workspace-transaction-growth.test.ts",
  "tests/wasm-sync-workspace-validator-walk.test.ts",
];

Deno.test("weights bookkeeping (jw8a6): the table is a post-split re-derivation that names its log and covers the files whose absence was the defect", async () => {
  const table = JSON.parse(
    await Deno.readTextFile(new URL("../scripts/lib/test-weights.json", import.meta.url)),
  );
  const prov = table._provenance ?? {};

  // A pre-split measured_at IS the reverted table: the last pre-fix generation
  // was measured_at 2026-10-16 / tree 55876826.
  assert(
    typeof prov.measured_at === "string" && prov.measured_at >= SPLIT_DATE,
    `_provenance.measured_at must post-date the wasm-sync split (${SPLIT_DATE}); got ${JSON.stringify(prov.measured_at)} — the stale generation is back`,
  );

  // The jw8a6 caveat: a re-derivation that does not name its source log and its
  // steal bakes inflation in invisibly (737385e9 measured under ~71% avg steal).
  assert(
    typeof prov.measured_log === "string" && prov.measured_log.length > 8,
    "_provenance.measured_log must name the derivation log — an unnamed source cannot be re-checked",
  );
  assert(
    typeof prov.measured_steal === "string" && /steal/i.test(prov.measured_steal),
    "_provenance.measured_steal must record the log's steal; ordering from an unrecorded-steal log is how the inflated 391s callexport figure would return",
  );

  // The defect itself: eligible >=3s files with NO weight start late as "light".
  // Each named file must carry a measured weight of at least the 3s threshold —
  // reverting to the 80-entry table (or losing the re-derivation) reds here.
  const weights = table.weights ?? {};
  for (const file of MUST_BE_WEIGHTED) {
    assert(
      typeof weights[file] === "number" && weights[file] >= 3,
      `${file} must carry a weight >= 3; got ${JSON.stringify(weights[file])} — an eligible file without a weight starts late as "light" (the jw8a6 defect)`,
    );
  }
});

Deno.test("heavy bookkeeping (finua): the wasm-sync-workspace heavy reason describes the POST-split file, never the pre-split citation", async () => {
  const src = await Deno.readTextFile(
    new URL("../scripts/test-partition.mjs", import.meta.url),
  );
  const reason =
    src.match(/"tests\/wasm-sync-workspace\.test\.ts":\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? "";
  assert(reason.length > 0, "wasm-sync-workspace.test.ts must keep its HEAVY_GATE_REASONS entry");

  // The pre-split endurance citation is the exact stale claim finua recorded:
  // 894s was measured on a849a9b3e, where the sibling files do not exist. A
  // reader comparing the reason against the current tree must find no stale
  // claim — restoring either the figure or the tree id reds here.
  assert(
    !/894\s*s|a849a9b3e/i.test(reason),
    "the pre-split endurance citation (894s / tree a849a9b3e) returned — the split removed that measurement's subject",
  );
  // The declaration must carry the post-split truth: the measured shell size or
  // an explicit kept-in-tier basis, so the next tier/quarantine decision reads
  // what the file IS, not what it was.
  assert(
    /post-split|~?10\s*s|kept in the heavy tier/i.test(reason),
    "the reason must cite the post-split measurement or name the kept-in-tier basis explicitly",
  );
});
