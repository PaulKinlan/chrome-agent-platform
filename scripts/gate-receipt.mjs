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

import { checkHeavyReceipt, currentTreeHash, expectedHeavyFiles } from "./lib/heavy-receipt.mjs";

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
  console.log(verdict.marker, JSON.stringify(verdict.payload));
  process.exit(2);
}
const receipt = verdict.receipt;
console.log(
  `gate-receipt: heavy tier certified for tree ${tree.slice(0, 12)} ` +
    `(result ${receipt.result}, ${receipt.covered.length}/${receipt.expected.length} enumerated suites all passed, ` +
    `rc ${receipt.exitCode}, finished ${new Date(receipt.finishedAt).toISOString()}, producer ${receipt.producer})`,
);
