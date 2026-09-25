// scripts/lib/journey-ledger-pairing.mjs — chrome-agent-platform-ccl7
//
// Static pairing guard for journey assertion ledgers.
// Statically verifies that every check() and report() call literal (including
// const-bound names like STEP1_NAME and dual happy/catch sites) matches the
// EXPECTED ledger in both sets and exact execution order, without needing a full
// ~370-check browser run.
//
// Covers:
//   - scripts/chrome-journeys.ts
//   - scripts/agent-access-journeys.ts

import { readFileSync } from "node:fs";

const META_CHECKS = new Set([
  "assertion set exact (no missing/extra checks)",
  "assertion order matches EXPECTED",
  "evidence manifest written + bound to the tested commit",
]);

// Known catch-only tripwires that deliberately sit outside EXPECTED
const TRIPWIRES = new Set([
  "site playbook journey completed without a harness error",
]);

// Known dual happy/catch call sites in chrome-journeys (executed via alternative branches)
const DUAL_SITES = new Set([
  "extension loaded",
  "about: what's new renders a bounded set of user-facing entries (≤5)",
  "about: visible copy is user-facing (no SHAs, no merge:/Tracker:, no gate jargon)",
  "about: 'Show all release notes' disclosure present",
  "about: Full release notes link targets the bundled changelog",
  "about: the About section DOM is bounded (< 600 nodes at load)",
  "about: the full history builds only when the disclosure opens",
  "about: Show all complements the visible five (no duplicated versions)",
  "about: retained a what's-new screenshot",
]);

/**
 * Extract EXPECTED array and executed check calls in execution order.
 * @param {string} source - Source code of the journey script.
 * @param {string} filePath - Path for diagnostics.
 */
export function extractLedgerAndCalls(source, filePath = "unknown") {
  // 1. Extract EXPECTED array
  const expIdx = source.indexOf("const EXPECTED = [");
  if (expIdx === -1) {
    throw new Error(`Could not find "const EXPECTED = [" in ${filePath}`);
  }
  const startBracket = source.indexOf("[", expIdx);
  let depth = 0;
  let endBracket = -1;
  for (let i = startBracket; i < source.length; i++) {
    if (source[i] === "[") depth++;
    else if (source[i] === "]") {
      depth--;
      if (depth === 0) {
        endBracket = i;
        break;
      }
    }
  }
  if (endBracket === -1) {
    throw new Error(`Unmatched bracket in EXPECTED declaration in ${filePath}`);
  }

  const expectedBlock = source.slice(startBracket, endBracket + 1);
  const strRegex = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  const rawExpected = [];
  let sm;
  while ((sm = strRegex.exec(expectedBlock))) {
    const val = sm[1] ?? sm[2] ?? sm[3];
    if (val && val.length > 3) rawExpected.push(val);
  }

  // 2. Extract const identifier mappings (e.g. const STEP1_NAME = "...";)
  const constMap = new Map();
  const constRegex = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  let cm;
  while ((cm = constRegex.exec(source))) {
    const varName = cm[1];
    const strVal = cm[2] ?? cm[3] ?? cm[4];
    constMap.set(varName, strVal);
  }

  // Helper to extract calls in a source segment
  function extractCallsInSegment(segment) {
    const callRegex = /\b(?:check|report)\s*\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`|([A-Za-z0-9_$]+))/g;
    const calls = [];
    let m;
    while ((m = callRegex.exec(segment))) {
      const literal = m[1] ?? m[2] ?? m[3];
      const id = m[4];
      if (literal) calls.push(literal);
      else if (id && constMap.has(id)) calls.push(constMap.get(id));
    }
    return calls;
  }

  // If this is chrome-journeys, order accounts for helper execution flow in main:
  // await demoPathJourney() and await factoryResetJourney() execute before final cleanup.
  let rawCalls = [];
  if (filePath.includes("chrome-journeys")) {
    const demoPathIdx = source.indexOf("async function demoPathJourney()");
    const factoryResetIdx = source.indexOf("async function factoryResetJourney()");

    if (demoPathIdx !== -1 && factoryResetIdx !== -1) {
      const mainSource = source.slice(0, demoPathIdx);
      const demoPathSource = source.slice(demoPathIdx, factoryResetIdx);
      const factoryResetSource = source.slice(factoryResetIdx);

      const demoCalls = extractCallsInSegment(demoPathSource);
      const factoryCalls = extractCallsInSegment(factoryResetSource);

      const callDemoIdx = mainSource.indexOf("await demoPathJourney();");
      const callFactoryIdx = mainSource.indexOf("await factoryResetJourney();");

      if (callDemoIdx !== -1 && callFactoryIdx !== -1) {
        const part1 = mainSource.slice(0, callDemoIdx);
        const part2 = mainSource.slice(callDemoIdx + "await demoPathJourney();".length, callFactoryIdx);
        const part3 = mainSource.slice(callFactoryIdx + "await factoryResetJourney();".length);

        rawCalls = [
          ...extractCallsInSegment(part1),
          ...demoCalls,
          ...extractCallsInSegment(part2),
          ...factoryCalls,
          ...extractCallsInSegment(part3),
        ];
      } else {
        rawCalls = extractCallsInSegment(source);
      }
    } else {
      rawCalls = extractCallsInSegment(source);
    }
  } else {
    rawCalls = extractCallsInSegment(source);
  }

  // Filter meta-checks and tripwires; collapse dual call sites
  const expected = rawExpected.filter((n) => !META_CHECKS.has(n));
  const calls = [];
  for (const name of rawCalls) {
    if (META_CHECKS.has(name) || TRIPWIRES.has(name)) continue;
    if (DUAL_SITES.has(name) && calls.includes(name)) continue;
    calls.push(name);
  }

  return { expected, calls };
}

/**
 * Verify pairing between EXPECTED ledger and actual check calls.
 * @param {string} filePath - File to verify.
 * @param {string} [sourceOverride] - Optional source text override (for testing/mutations).
 */
export function verifyJourneyLedgerPairing(filePath, sourceOverride) {
  const source = sourceOverride ?? readFileSync(filePath, "utf8");
  const { expected, calls } = extractLedgerAndCalls(source, filePath);

  const missing = expected.filter((n) => !calls.includes(n));
  const extra = calls.filter((n) => !expected.includes(n));

  let orderMismatch = null;
  const compareLen = Math.min(expected.length, calls.length);
  for (let i = 0; i < compareLen; i++) {
    if (expected[i] !== calls[i]) {
      orderMismatch = {
        index: i,
        expected: expected[i],
        actual: calls[i],
      };
      break;
    }
  }

  const errors = [];
  if (missing.length > 0) {
    errors.push(`In EXPECTED but never called (${missing.length}):\n  ${missing.map((s) => JSON.stringify(s)).join("\n  ")}`);
  }
  if (extra.length > 0) {
    errors.push(`Called but not in EXPECTED (${extra.length}):\n  ${extra.map((s) => JSON.stringify(s)).join("\n  ")}`);
  }
  if (orderMismatch) {
    errors.push(`Order mismatch at index ${orderMismatch.index}:\n  Expected: ${JSON.stringify(orderMismatch.expected)}\n  Actual:   ${JSON.stringify(orderMismatch.actual)}`);
  }
  if (expected.length !== calls.length && !orderMismatch && missing.length === 0 && extra.length === 0) {
    errors.push(`Length mismatch: expected ${expected.length}, got ${calls.length}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    filePath,
    expectedCount: expected.length,
    actualCount: calls.length,
    missing,
    extra,
    orderMismatch,
  };
}
