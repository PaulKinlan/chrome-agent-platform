#!/usr/bin/env node
// scripts/update-test-weights.mjs — re-derive scripts/lib/test-weights.json
// from a FULL gate log (chrome-agent-platform-6gk81).
//
// The weights table orders the parallel phase longest-first
// (scripts/lib/parallel-schedule.mjs). Until now NOTHING re-measured it: the
// 2026-10-08 numbers (isolated runs on a 2-vCPU VM) survived a names-only
// refresh on 2026-10-15, and by 2026-10-16 the heaviest file in the suite
// (tests/python-documents-bundle-3p3e11.test.ts, 95 test-seconds) had no
// weight at all and finished last. A gate log already contains every
// per-test duration; this script is the committed re-derivation the table's
// own provenance asked for.
//
//   node scripts/update-test-weights.mjs <gate-log> --tree <sha> [--date YYYY-MM-DD]
//                                        [--min-secs 3] [--dry-run]
//
// Only files eligible for weighting are emitted: the selected parallel set
// minus the read-only-dist batch (tests/parallel-schedule.test.ts fails the
// suite if the table names anything else). Weights are summed TEST-seconds
// under parallel load, not isolated wall seconds — the right relative input
// for ordering, and the provenance block says exactly that.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { parseSuiteDurations, slowestSuites } from "./lib/parallel-durations.mjs";
import { READ_ONLY_DIST } from "./test-partition.mjs";
import { defaultTestPlan, enumerateRunnerTests } from "./run-tests.mjs";

export const WEIGHTS_PATH = fileURLToPath(new URL("./lib/test-weights.json", import.meta.url));

/**
 * The weights document for one measured log. Pure apart from the injected
 * eligible set, so the arithmetic is unit-testable without a gate log.
 * @param {{ durations: Map<string, number>, eligible: Set<string>, minSecs: number, tree: string, date: string }} args
 */
export function weightsDocument({ durations, eligible, minSecs, tree, date }) {
  const kept = new Map();
  for (const [file, secs] of durations) {
    if (!eligible.has(file)) continue;
    if (!(secs >= minSecs)) continue;
    kept.set(file, secs);
  }
  const weights = {};
  for (const { file, secs } of slowestSuites(kept, Number.POSITIVE_INFINITY)) {
    weights[file] = secs;
  }
  return {
    _about:
      `Per-file test-seconds summed from the FULL gate log's parallel reporter lines at ${tree} (${date}); ` +
      "ordering estimates, NOT isolated wall timings. Re-derived by scripts/update-test-weights.mjs from a " +
      "gate log (chrome-agent-platform-6gk81), replacing the 2026-10-08 isolated measurements that had gone " +
      "stale (the heaviest file in the suite carried no weight and finished last). Used ONLY to order selected " +
      "files; never decides which files run (see _provenance, and docs/TEST-COUPLING-INVENTORY.md entry 23). " +
      "tests/parallel-schedule.test.ts rejects non-parallel, deferred, missing, or read-only-dist names.",
    _provenance: {
      measured_at: date,
      measured_tree: tree,
      measured_host: "the fleet VM that produced the source gate log (8 vCPU)",
      measured_method:
        "summed per-test durations from one FULL gate log's `deno test --parallel` reporter lines " +
        "(scripts/lib/parallel-durations.mjs; step lines excluded so parent totals are not double-counted). " +
        "Test-seconds under parallel load, not isolated wall seconds: the right RELATIVE input for " +
        "longest-first ordering, not a per-file time budget.",
      rederivation:
        "node scripts/update-test-weights.mjs <full-gate-log> --tree <sha-of-logged-tree> — the log's own " +
        "manifest suite_durations carries the same numbers; either source re-derives this table.",
      refreshed_on: date,
      refreshed_scope: `durations recalibrated from the ${tree} FULL log; files under ${minSecs}s carry no weight and keep their given order`,
      guarantee:
        "ordering only: the table may reorder the parallel set but can never add, drop or deselect a file (tests/parallel-schedule.test.ts pins the permutation against the live selection)",
      off_switch: "CAP_PARALLEL_SCHEDULE=0 disables this ordering entirely (scripts/run-tests.mjs); documented in docs/CHROME-TEST-CONTRACT.md",
    },
    weights,
  };
}

export function eligibleParallelFiles() {
  return new Set(
    defaultTestPlan(enumerateRunnerTests()).parallel.filter((f) => !READ_ONLY_DIST.has(f)),
  );
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function main(args = process.argv.slice(2)) {
  const logPath = args.find((a) => !a.startsWith("-"));
  if (!logPath) {
    console.error("usage: node scripts/update-test-weights.mjs <gate-log> --tree <sha> [--date YYYY-MM-DD] [--min-secs 3] [--dry-run]");
    return 2;
  }
  const tree = argValue(args, "--tree") ?? execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const date = argValue(args, "--date") ?? new Date().toISOString().slice(0, 10);
  const minSecs = Number(argValue(args, "--min-secs") ?? 3);
  if (!Number.isFinite(minSecs) || minSecs < 0) {
    console.error(`update-test-weights: --min-secs must be a non-negative number, got ${argValue(args, "--min-secs")}`);
    return 2;
  }
  const durations = parseSuiteDurations(readFileSync(logPath, "utf8"));
  if (durations.size === 0) {
    console.error(`update-test-weights: no parallel reporter durations found in ${logPath} — refusing to empty the table`);
    return 1;
  }
  const doc = weightsDocument({ durations, eligible: eligibleParallelFiles(), minSecs, tree, date });
  const names = Object.keys(doc.weights);
  if (names.length === 0) {
    console.error("update-test-weights: no eligible file met the threshold — refusing to empty the table");
    return 1;
  }
  console.log(`update-test-weights: ${names.length} weights from ${durations.size} measured suites (min ${minSecs}s, tree ${tree})`);
  for (const { file, secs } of slowestSuites(new Map(Object.entries(doc.weights)), 10)) {
    console.log(`  ${secs}s ${file}`);
  }
  if (args.includes("--dry-run")) {
    console.log("update-test-weights: --dry-run, table not written");
    return 0;
  }
  writeFileSync(WEIGHTS_PATH, `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`update-test-weights: wrote ${WEIGHTS_PATH}`);
  return 0;
}

if (process.argv[1] && realpathSync(resolvePath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
