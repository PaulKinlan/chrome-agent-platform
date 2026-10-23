#!/usr/bin/env node
// Heavy-receipt gate check (chrome-agent-platform-upqhp).
//
// The gate command is `npm run build:production && npm test && npm run test:build` — it never
// runs `npm run test:heavy`, so after 3hbnd moved the two mega-suites into the heavy tier the
// gate's coverage of them was gone. The fail-closed check lives HERE, as a gate-command stage,
// NOT inside `npm test`: the fast gate escalates machinery changes (run-tests.mjs edits) to the
// full suite, and a receipt demand inside npm test would turn every such change into a
// 40-minute tier gate (learned on 92157a0e5's first fast gate: FAIL, receipt missing).
//
// INVOCATION (this file is NOT an npm alias, deliberately): the gate command appends
// `node scripts/gate-receipt.mjs` to its chain. Adding a `gate:receipt` entry to package.json
// would work, but select-tests FAILS CLOSED on any package.json edit ("release/version JSON
// belongs to the merger; a lane change here cannot be subset-certified"), so a one-line alias
// made the whole change un-certifiable by the fast gate — measured on the first fast gate for
// this work (killed at its bound after escalating to the FULL suite). Name the file instead.
//
// Fleet gate order (producer rule, coord 2026-10-23): run `npm run test:heavy` on the landing
// tree FIRST — it writes the receipt — then the gate; this stage certifies it.
//
// Refusal contract: named line + HEAVY_RECEIPT_REFUSAL marker + exit 2, zero suites run.

import { checkHeavyReceipt, currentTreeHash } from "./lib/heavy-receipt.mjs";

let tree;
try {
  tree = currentTreeHash();
} catch (error) {
  console.error(`gate-receipt: cannot resolve the current git tree (${error.message})`);
  process.exit(2);
}
const verdict = checkHeavyReceipt(tree);
if (!verdict.ok) {
  console.error(`\n${verdict.line}\n`);
  console.log(verdict.marker, JSON.stringify(verdict.payload));
  process.exit(2);
}
console.log(
  `gate-receipt: heavy tier certified for tree ${tree.slice(0, 12)} ` +
    `(result ${verdict.receipt.result}, finished ${new Date(verdict.receipt.finishedAt).toISOString()}, ` +
    `producer ${verdict.receipt.producer})`,
);
