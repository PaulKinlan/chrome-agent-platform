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
// WHAT THIS DRIVES. The refreshed generation (2026-11-08, derived from tree
// 5f7e345d's FULL-suite parallel phase: 772 measured suites, tier:full,
// executed:789, steal mostly 0.8–9.2% with 20% spikes — the quietest complete
// post-split log available). The weights check is a DERIVATION/COVERAGE
// comparison, not a spot list: the guard re-derives the table from the COMMITTED
// source digest (scripts/lib/test-weights.source.json, the log's manifest
// suite_durations) through the same weightsDocument() the tool uses, and
// requires exact equality with the committed weights. Any single-value
// staleness reds regardless of which entry drifts — the reviewer's surviving
// mutant (the heaviest entry zeroed) passed a spot list of ten names and must
// never pass again. The heavy-reason check pins the post-split declaration.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { weightsDocument, eligibleParallelFiles } from "../scripts/update-test-weights.mjs";

const SPLIT_DATE = "2026-10-24"; // ifu81 moved the wasm-sync endurance into sibling files (32b72e03f)

Deno.test("weights bookkeeping (jw8a6): the committed table equals a fresh derivation from the committed source digest — any drifted entry reds", async () => {
  const table = JSON.parse(
    await Deno.readTextFile(new URL("../scripts/lib/test-weights.json", import.meta.url)),
  );
  const source = JSON.parse(
    await Deno.readTextFile(new URL("../scripts/lib/test-weights.source.json", import.meta.url)),
  );
  const prov = table._provenance ?? {};

  // A pre-split measured_at IS the reverted table: the last pre-fix generation
  // was measured_at 2026-10-16 / tree 55876826.
  assert(
    typeof prov.measured_at === "string" && prov.measured_at >= SPLIT_DATE,
    `_provenance.measured_at must post-date the wasm-sync split (${SPLIT_DATE}); got ${JSON.stringify(prov.measured_at)} — the stale generation is back`,
  );

  // The jw8a6 caveat: a re-derivation that does not name its source log and its
  // steal bakes inflation in invisibly (the weekly review's 737385e9 ran under
  // ~71% avg steal and read as "callexport-admission 391s").
  assert(
    typeof prov.measured_log === "string" && prov.measured_log.length > 8,
    "_provenance.measured_log must name the derivation log — an unnamed source cannot be re-checked",
  );
  assert(
    typeof prov.measured_steal === "string" && /steal/i.test(prov.measured_steal),
    "_provenance.measured_steal must record the log's steal; ordering from an unrecorded-steal log is how the inflated 391s callexport figure would return",
  );
  // And the source digest must agree with the provenance about WHAT was measured
  // (a mislabeled phase is the cadence-counter class of defect: the label is the
  // decision input). The digest records both identities of the run: the git sha
  // the gate ran (measured_tree) and the log's tree hash (source_log_tree), which
  // is what the table's provenance names.
  assertEquals(
    prov.measured_tree,
    source.source_log_tree,
    "_provenance.measured_tree must match the committed source digest's logged tree",
  );

  // THE DERIVATION COMPARISON. Same function the tool uses, same eligible set,
  // same threshold — fed from the COMMITTED source digest, so the check is
  // portable and total: one drifted value, one missing entry, or one extra
  // entry anywhere reds, not just the ten names this guard's first draft knew.
  const derived = weightsDocument({
    durations: new Map(Object.entries(source.suite_durations)),
    eligible: eligibleParallelFiles(),
    minSecs: 3,
    tree: String(prov.measured_tree ?? ""),
    date: String(prov.measured_at ?? ""),
  });
  assertEquals(
    table.weights,
    derived.weights,
    "the committed weights are not the derivation of the committed source digest — the table has gone stale (or the digest and table were updated separately): re-run scripts/update-test-weights.mjs against the recorded log and re-commit both",
  );
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
