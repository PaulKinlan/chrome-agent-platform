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
export const SOURCE_DIGEST_PATH = fileURLToPath(new URL("./lib/test-weights.source.json", import.meta.url));

/**
 * The weights document for one measured log. Pure apart from the injected
 * eligible set, so the arithmetic is unit-testable without a gate log.
 * @param {{ durations: Map<string, number>, eligible: Set<string>, minSecs: number, tree: string, date: string, measuredLog?: string, measuredSteal?: string }} args
 */
export function weightsDocument({ durations, eligible, minSecs, tree, date, measuredLog, measuredSteal }) {
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
      // ubhon: the jw8a6 guard REQUIRES these two keys — a regenerated table
      // without them turns the derivation guard red, so the tool emits them
      // always (never a hand-restore step the printed remedy cannot perform).
      measured_log: String(measuredLog ?? ""),
      measured_steal: String(measuredSteal ?? "steal not recorded at derivation time — re-measure from the source log before trusting absolute numbers"),
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

/**
 * The source digest for one measured log — the COMPLETE parsed durations
 * record plus the run's two identities: the git sha the gate ran
 * (measured_tree) and the log's own tree hash (source_log_tree), which the
 * table's provenance names. rs78b: main() writes this digest in the SAME run
 * as the table, so the pair the freshness guard compares can never drift when
 * produced by the documented remedy — and the remedy is executable as
 * printed. Pure apart from the injected identities.
 * @param {{ durations: Map<string, number>, tree: string, logTree: string, gitSha: string, date: string, logPath: string }} args
 */
export function sourceDigestDocument({ durations, tree, logTree, gitSha, date, logPath }) {
  return {
    _about:
      "The suite_durations digest (parsed by scripts/lib/parallel-durations.mjs — the same parser the derivation tool uses, so tool(log) === tool(digest) by construction) of the gate log that scripts/lib/test-weights.json was derived from (chrome-agent-platform-jw8a6). Committed so the freshness guard can re-derive the table from the COMMITTED record, not from a log path that rots (tests/gate-bookkeeping-freshness.test.ts). " +
      "Regenerated by scripts/update-test-weights.mjs in the SAME run that writes the table (chrome-agent-platform-rs78b) — never hand-edit one without the other. " +
      "source_log_tree is derived from the LOG ARTIFACTS (the fleet check record's filename/sibling JSON), so the guard's table-vs-digest cross-check compares the operator's --tree claim against the log's own identity, never one input to itself (chrome-agent-platform-8w0eg).",
    measured_at: date,
    measured_tree: gitSha,
    source_log: `${logPath} (gate log; log tree ${logTree})`,
    suite_durations: Object.fromEntries(durations),
    source_log_tree: logTree,
  };
}

/**
 * The log's own identity, derived from the LOG ARTIFACTS — never from an
 * operator-typed flag alone (8w0eg): the gate check record sits beside the
 * log as <tree>.fast.json / <tree>.fast.log, so the basename IS the tree hash
 * and the sibling record carries the git sha the gate ran. Returns
 * { logTree, gitSha } with nulls where the artifacts cannot say.
 */
export function logRunIdentity(logPath) {
  const base = String(logPath ?? "").split("/").pop() ?? "";
  const m = /^([0-9a-f]{40})\.(?:fast\.)?log$/.exec(base);
  const logTree = m ? m[1] : null;
  let gitSha = null;
  try {
    const record = JSON.parse(readFileSync(String(logPath).replace(/\.log$/, ".json"), "utf8"));
    if (typeof record?.sha === "string" && record.sha) gitSha = record.sha;
    if (!logTree && typeof record?.tree === "string" && record.tree) {
      return { logTree: record.tree, gitSha };
    }
  } catch { /* no sibling record — the flags carry the identities */ }
  return { logTree, gitSha };
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function main(args = process.argv.slice(2)) {
  const logPath = args.find((a) => !a.startsWith("-"));
  if (!logPath) {
    console.error("usage: node scripts/update-test-weights.mjs <gate-log> [--tree <log-tree-hash>] [--date YYYY-MM-DD] [--min-secs 3] [--git-sha <sha>] [--steal '<measured steal summary>'] [--weights-out <path>] [--digest-out <path>] [--dry-run]");
    return 2;
  }
  const identity = logRunIdentity(logPath);
  const tree = argValue(args, "--tree") ?? identity.logTree ?? execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const date = argValue(args, "--date") ?? new Date().toISOString().slice(0, 10);
  const gitSha = argValue(args, "--git-sha") ?? identity.gitSha ?? execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  const measuredSteal = argValue(args, "--steal");
  const weightsPath = argValue(args, "--weights-out") ?? WEIGHTS_PATH;
  const digestPath = argValue(args, "--digest-out") ?? SOURCE_DIGEST_PATH;
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
  const doc = weightsDocument({ durations, eligible: eligibleParallelFiles(), minSecs, tree, date, measuredLog: logPath, measuredSteal });
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
    console.log("update-test-weights: --dry-run, table and digest not written");
    return 0;
  }
  writeFileSync(weightsPath, `${JSON.stringify(doc, null, 1)}\n`);
  // rs78b: the source digest is written in the SAME run — the printed remedy
  // (re-run against the recorded log, re-commit both) is executable, and the
  // table can never drift from a digest this command did not also produce.
  writeFileSync(digestPath, `${JSON.stringify(sourceDigestDocument({ durations, tree, logTree: identity.logTree ?? tree, gitSha, date, logPath }), null, 1)}\n`);
  console.log(`update-test-weights: wrote ${weightsPath} + ${digestPath}`);
  return 0;
}

if (process.argv[1] && realpathSync(resolvePath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
