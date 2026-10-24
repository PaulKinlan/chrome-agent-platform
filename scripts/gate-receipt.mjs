#!/usr/bin/env node
// Heavy-receipt gate check (chrome-agent-platform-upqhp, hardened by chrome-agent-platform-juubk).
//
// The gate command is `npm run build:production && npm test && npm run test:build` — it never
// runs `npm run test:heavy`, so a suite tiered into the heavy tier is otherwise uncertified: a
// clean PASS would not execute it. This stage is that certification, and it is a GATE-COMMAND
// stage rather than part of `npm test` because the fast gate escalates machinery changes (edits
// to run-tests.mjs) to the full suite, so a receipt demand inside npm test would turn every such
// edit into a 40-minute tier gate (learned on 92157a0e5's first fast gate: FAIL, receipt missing).
//
// INVOCATION (this file is NOT an npm alias, deliberately): the gate command appends
// `node scripts/gate-receipt.mjs` to its chain. Adding a `gate:receipt` entry to package.json
// would work, but select-tests FAILS CLOSED on any package.json edit ("release/version JSON
// belongs to the merger; a lane change here cannot be subset-certified"), so a one-line alias
// made the whole change un-certifiable by the fast gate — measured on the first fast gate for
// this work (killed at its bound after escalating to the FULL suite). Name the file instead.
// Put it FIRST in the chain, not last: a refusal costs milliseconds, and there is no reason to
// spend the production build before discovering the heavy tier was never certified.
//
// Fleet gate order (producer rule, coord 2026-10-23): run `npm run test:heavy` with NO arguments
// on the landing tree FIRST — it writes the receipt — then the gate; this stage certifies it.
//
// Refusal contract: named line naming both the expected and the found tree + HEAVY_RECEIPT_REFUSAL
// marker + exit 2, zero suites run.
//
// ACCOUNTING vs TIMING (chrome-agent-platform-gezg6, coord 2026-10-24): since tu8w9 a receipt records
// the CPU steal it ran under, so a functional PASS is no longer automatically a TIMING credential. The
// exit codes are distinguishable on purpose, because "there is no receipt" and "the box was starved" are
// different problems with different fixes:
//
//   exit 0  full credential (steal measured, below threshold)
//   exit 0  accounting-only ACCEPTED, only with --accept-accounting-only: the hub's accounting path
//           (every enumerated suite passed, 0 skips, tracked failures, rc 0) still lands, and the run
//           claims no timing. The marker on stdout says so, so a later reader cannot mistake it.
//   exit 2  structurally refused: missing / mismatched / stale / not a pass / incomplete (get a receipt)
//   exit 3  accounting-only and NOT accepted: starved, unmeasured, or no steal evidence (fix the box)

import { checkHeavyReceipt, currentTreeHash, expectedHeavyFiles } from "./lib/heavy-receipt.mjs";

const args = process.argv.slice(2);
const known = new Set(["--accept-accounting-only", "--help"]);
for (const arg of args) {
  if (!known.has(arg)) {
    console.error(`gate-receipt: unknown argument ${JSON.stringify(arg)} — known: --accept-accounting-only`);
    process.exit(2);
  }
}
if (args.includes("--help")) {
  console.log("gate-receipt [--accept-accounting-only]\n\n  exit 0 full credential; 0 accounting-only when accepted,\n  2 nothing usable (missing/mismatched/incomplete), 3 starved but not accepted.");
  process.exit(0);
}
const acceptAccountingOnly = args.includes("--accept-accounting-only");

let tree;
try {
  tree = currentTreeHash();
} catch (error) {
  console.error(`gate-receipt: cannot resolve the current git tree (${error.message})`);
  process.exit(2);
}
const verdict = checkHeavyReceipt(tree, { expected: expectedHeavyFiles() });
if (!verdict.ok) {
  console.error(`\n${verdict.line}\n`);
  const accountingOnly = verdict.outcome === "accounting-only";
  if (accountingOnly && acceptAccountingOnly) {
    // The hub's accounting path: functional completeness is certified, timing is explicitly not claimed.
    console.log(verdict.marker, JSON.stringify({ ...verdict.payload, accepted: "accounting-only", timingClaim: "none" }));
    console.log(
      `gate-receipt: ACCOUNTING-ONLY accepted for tree ${tree.slice(0, 12)} — every enumerated suite passed and no`,
      `timing is claimed by this run (steal peak ${verdict.payload.maxStealPct ?? "NA"}%).`,
    );
    process.exit(0);
  }
  console.log(verdict.marker, JSON.stringify(verdict.payload));
  // 3 vs 2: "bad box" vs "no receipt". Both fail closed; only one is fixed by re-running on idle iron.
  process.exit(accountingOnly ? 3 : 2);
}
const receipt = verdict.receipt;
console.log(
  `gate-receipt: heavy tier certified for tree ${tree.slice(0, 12)} (timing credential: steal peak ` +
    `${verdict.steal?.maxStealPct === null || verdict.steal?.maxStealPct === undefined ? "NA" : Number(verdict.steal.maxStealPct).toFixed(1)}%, ` +
    `threshold ${verdict.steal?.thresholdPct ?? "NA"}%) ` +
    `(result ${receipt.result}, ${receipt.covered.length}/${receipt.expected.length} enumerated suites all passed, ` +
    `rc ${receipt.exitCode}, finished ${new Date(receipt.finishedAt).toISOString()}, producer ${receipt.producer})`,
);
