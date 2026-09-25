#!/usr/bin/env node
// scripts/check-journey-ledgers.mjs — chrome-agent-platform-ccl7
//
// Fast static pairing guard for journey assertion ledgers.
// Ensures every check() and report() call literal matches the EXPECTED ledger
// in both set parity and exact execution order for:
//   - scripts/chrome-journeys.ts
//   - scripts/agent-access-journeys.ts
//   - scripts/run-status-lifecycle.ts

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyJourneyLedgerPairing } from "./lib/journey-ledger-pairing.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  "scripts/chrome-journeys.ts",
  "scripts/agent-access-journeys.ts",
  "scripts/run-status-lifecycle.ts",
];

let failed = false;

for (const relPath of FILES) {
  const fullPath = join(ROOT, relPath);
  const result = verifyJourneyLedgerPairing(fullPath);
  if (result.ok) {
    console.log(`[PASS] ${relPath}: ${result.expectedCount} assertions match EXPECTED in set and order`);
  } else {
    failed = true;
    console.error(`[FAIL] ${relPath}: assertion ledger mismatch`);
    for (const err of result.errors) {
      console.error(err);
    }
  }
}

if (failed) {
  process.exit(1);
} else {
  console.log("All journey ledgers verified in sync.");
}
