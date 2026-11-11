// tests/update-test-weights.test.ts — chrome-agent-platform-rs78b (+ review
// findings ubhon and 8w0eg on the first fix).
//
// THE DEFECT (rs78b). The jw8a6 freshness guard's remedy says: re-run
// scripts/update-test-weights.mjs against the recorded log and re-commit BOTH
// scripts/lib/test-weights.json and scripts/lib/test-weights.source.json. But
// the tool only ever WROTE the table — no writer existed for the source
// digest — so following the printed remedy left the digest stale and turned
// the derivation check red immediately.
//
// THE ROUND-2 DEFECTS (the reviewer's FAIL on the first fix):
//  - ubhon: the tool-written table omitted _provenance.measured_log and
//    measured_steal, which the SAME guard requires — so the remedy still
//    redded the guard it printed. The tool now always emits both.
//  - 8w0eg: the digest's source_log_tree echoed the --tree flag, so the
//    guard's table-vs-digest identity cross-check compared one operator input
//    to itself. The identities now derive from the LOG ARTIFACTS (the fleet
//    check record's filename is the tree hash; the sibling <tree>.fast.json
//    carries the git sha), and --tree remains only as the table's claim.
//
// RED on the pre-fix tree: sourceDigestDocument does not exist, main() writes
// only the table, and the produced table carries no measured_log.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  eligibleParallelFiles,
  main,
  sourceDigestDocument,
  weightsDocument,
} from "../scripts/update-test-weights.mjs";

Deno.test("rs78b+ubhon+8w0eg: the tool writes table AND digest in one run — a guard-satisfying pair with the log's OWN identities", async () => {
  const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-rs78b-pair-" });
  try {
    // Real, parallel-eligible file names so the weights filter keeps them; the
    // phantom file proves the digest keeps the COMPLETE measured record while
    // the table applies eligibility. The log is named like a real fleet check
    // artifact so the tool derives the run identities from it (8w0eg).
    const logTree = "0123456789abcdef0123456789abcdef01234567";
    const logPath = `${tmp}/${logTree}.fast.log`;
    await Deno.writeTextFile(
      logPath,
      [
        "./tests/parallel-schedule.test.ts => some test ... ok (12s)",
        "./tests/gate-bookkeeping-freshness.test.ts => some test ... ok (4s)",
        "./tests/phantom-not-in-the-plan.test.ts => some test ... ok (9s)",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(`${tmp}/${logTree}.fast.json`, JSON.stringify({ tree: logTree, sha: "abc123def" }));
    const weightsPath = `${tmp}/test-weights.json`;
    const digestPath = `${tmp}/test-weights.source.json`;
    const rc = main([
      logPath,
      "--date", "2026-11-11",
      "--steal", "steal mostly 0.8-9.2%, spikes 20%",
      "--weights-out", weightsPath,
      "--digest-out", digestPath,
    ]);
    assertEquals(rc, 0, "the run succeeds");

    const table = JSON.parse(await Deno.readTextFile(weightsPath));
    const digest = JSON.parse(await Deno.readTextFile(digestPath));

    // The digest carries the COMPLETE measured record; the table carries only
    // the eligible, over-threshold ordering subset.
    assert("tests/phantom-not-in-the-plan.test.ts" in digest.suite_durations, "the digest records every measured suite");
    assert(!("tests/phantom-not-in-the-plan.test.ts" in table.weights), "the table applies the eligibility filter");
    assert("tests/parallel-schedule.test.ts" in table.weights, "a real eligible suite is weighted");

    // ubhon: the produced table satisfies the jw8a6 provenance assertions with
    // NO hand-restore step — measured_log names the derivation log and
    // measured_steal records the steal note (the exact assertions at
    // tests/gate-bookkeeping-freshness.test.ts:47-54).
    const prov = table._provenance ?? {};
    assert(typeof prov.measured_log === "string" && prov.measured_log.length > 8, "measured_log names the derivation log");
    assert(prov.measured_log.endsWith(`${logTree}.fast.log`), "measured_log is the actual source log path");
    assert(typeof prov.measured_steal === "string" && /steal/i.test(prov.measured_steal), "measured_steal records the steal summary");
    assertEquals(prov.measured_steal, "steal mostly 0.8-9.2%, spikes 20%");

    // 8w0eg: the identities come from the LOG ARTIFACTS, not from flags —
    // source_log_tree is the log's own tree hash, measured_tree the sibling
    // record's git sha.
    assertEquals(digest.source_log_tree, logTree, "the log identity derives from the artifact filename");
    assertEquals(digest.measured_tree, "abc123def", "the git sha derives from the sibling check record");
    assertEquals(table._provenance.measured_tree, digest.source_log_tree, "the guard's cross-check holds for the produced pair");
    assertEquals(digest.measured_at, "2026-11-11");

    // The rs78b acceptance: the pair the tool writes satisfies the jw8a6
    // derivation comparison BY CONSTRUCTION.
    const derived = weightsDocument({
      durations: new Map(Object.entries(digest.suite_durations)),
      eligible: eligibleParallelFiles(),
      minSecs: 3,
      tree: logTree,
      date: "2026-11-11",
    });
    assertEquals(table.weights, derived.weights, "table === weightsDocument(digest) for the freshly written pair");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("8w0eg: the cross-check is not tautological — an operator --tree that contradicts the log artifact diverges", async () => {
  const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-8w0eg-" });
  try {
    const logTree = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
    const logPath = `${tmp}/${logTree}.fast.log`;
    await Deno.writeTextFile(logPath, "./tests/parallel-schedule.test.ts => t ... ok (5s)\n");
    const weightsPath = `${tmp}/w.json`;
    const digestPath = `${tmp}/d.json`;
    const rc = main([logPath, "--tree", "operator-claimed-tree", "--git-sha", "g1", "--date", "2026-11-11", "--weights-out", weightsPath, "--digest-out", digestPath]);
    assertEquals(rc, 0);
    const table = JSON.parse(await Deno.readTextFile(weightsPath));
    const digest = JSON.parse(await Deno.readTextFile(digestPath));
    assertEquals(table._provenance.measured_tree, "operator-claimed-tree", "the flag still drives the table's claim");
    assertEquals(digest.source_log_tree, logTree, "the digest records the log's OWN identity — the guard compares claim vs fact");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("ubhon: weightsDocument always emits the guard-required provenance keys, with an honest unmeasured-steal default", () => {
  const doc = weightsDocument({
    durations: new Map([["tests/parallel-schedule.test.ts", 5]]),
    eligible: eligibleParallelFiles(),
    minSecs: 3,
    tree: "t1",
    date: "2026-11-11",
    measuredLog: "/some/gate.fast.log",
  });
  assertEquals(doc._provenance.measured_log, "/some/gate.fast.log");
  assert(/steal/i.test(doc._provenance.measured_steal), "the default steal note still names steal honestly (unrecorded, not fabricated)");
  assert(/not recorded/.test(doc._provenance.measured_steal), "no steal figure is invented when the operator did not measure one");
});

Deno.test("rs78b: --dry-run writes neither artifact", async () => {
  const tmp = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-rs78b-dry-" });
  try {
    const logPath = `${tmp}/gate.log`;
    await Deno.writeTextFile(logPath, "./tests/parallel-schedule.test.ts => t ... ok (5s)\n");
    const weightsPath = `${tmp}/w.json`;
    const digestPath = `${tmp}/d.json`;
    const rc = main([logPath, "--tree", "t1", "--git-sha", "g1", "--date", "2026-11-11", "--dry-run", "--weights-out", weightsPath, "--digest-out", digestPath]);
    assertEquals(rc, 0);
    for (const p of [weightsPath, digestPath]) {
      let exists = true;
      try { await Deno.stat(p); } catch { exists = false; }
      assertEquals(exists, false, `${p} must not be written on --dry-run`);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
