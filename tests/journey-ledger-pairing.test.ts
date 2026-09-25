// tests/journey-ledger-pairing.test.ts — chrome-agent-platform-ccl7
//
// Static pairing guard for journey assertion ledgers.
// Asserts that every check() and report() call literal in chrome-journeys.ts,
// agent-access-journeys.ts, and run-status-lifecycle.ts matches its EXPECTED
// ledger in set parity and order.
// Falsified by planted pair faults (mutant check name, mutant expected entry, order swap).
// @ts-nocheck
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { verifyJourneyLedgerPairing } from "../scripts/lib/journey-ledger-pairing.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

Deno.test("journey-ledger-pairing: chrome-journeys.ts matches EXPECTED ledger in set and order", () => {
  const file = `${ROOT}scripts/chrome-journeys.ts`;
  const result = verifyJourneyLedgerPairing(file);
  assertEquals(result.ok, true, `chrome-journeys ledger must be clean: ${result.errors.join("; ")}`);
  assertEquals(result.expectedCount, 368, "clean chrome-journeys carries 368 non-meta checks");
  assertEquals(result.actualCount, 368);
  assertEquals(result.missing.length, 0);
  assertEquals(result.extra.length, 0);
  assertEquals(result.orderMismatch, null);
});

Deno.test("journey-ledger-pairing: agent-access-journeys.ts matches EXPECTED ledger in set and order", () => {
  const file = `${ROOT}scripts/agent-access-journeys.ts`;
  const result = verifyJourneyLedgerPairing(file);
  assertEquals(result.ok, true, `agent-access-journeys ledger must be clean: ${result.errors.join("; ")}`);
  assertEquals(result.expectedCount, 85, "clean agent-access-journeys carries 85 non-meta checks");
  assertEquals(result.actualCount, 85);
  assertEquals(result.missing.length, 0);
  assertEquals(result.extra.length, 0);
  assertEquals(result.orderMismatch, null);
});

Deno.test("journey-ledger-pairing: run-status-lifecycle.ts matches EXPECTED ledger in set and order", () => {
  const file = `${ROOT}scripts/run-status-lifecycle.ts`;
  const result = verifyJourneyLedgerPairing(file);
  assertEquals(result.ok, true, `run-status-lifecycle ledger must be clean: ${result.errors.join("; ")}`);
  assertEquals(result.expectedCount, 31, "clean run-status-lifecycle carries 31 non-meta checks");
  assertEquals(result.actualCount, 31);
  assertEquals(result.missing.length, 0);
  assertEquals(result.extra.length, 0);
  assertEquals(result.orderMismatch, null);
});

Deno.test("journey-ledger-pairing: comments are stripped so commented-out check() calls never register (F1)", async () => {
  const file = `${ROOT}scripts/agent-access-journeys.ts`;
  const originalSource = await Deno.readTextFile(file);

  // Plant a commented check inside a line comment and a block comment
  const plantedComments = originalSource + "\n// check(\"commented check not in ledger\");\n/* check(\"block commented check\"); */\n";

  const result = verifyJourneyLedgerPairing(file, plantedComments);
  assertEquals(result.ok, true, "commented check calls must not fail pairing guard");
  assertEquals(result.extra.length, 0, "commented checks must not appear in extra calls");
});

Deno.test("journey-ledger-pairing: falsification — we0m fault (renamed EXPECTED entry) fails fast", async () => {
  const file = `${ROOT}scripts/chrome-journeys.ts`;
  const originalSource = await Deno.readTextFile(file);

  // The we0m fault: EXPECTED carries a name that doesn't match the check() call site
  const mutatedExpected = originalSource.replace(
    '"create dialog: the keyboard pick of Research Analyst fills Name and checks its skills"',
    '"create dialog: the keyboard pick of Research Analyst recipe fills Name and checks its skills"',
  );

  const result = verifyJourneyLedgerPairing(file, mutatedExpected);
  assertEquals(result.ok, false, "mutated expected entry must fail pairing guard");
  assert(
    result.missing.some((m) => m.includes("recipe fills Name")),
    "must report the mutated expected name as missing from executed calls",
  );
  assert(
    result.extra.some((e) => e.includes("Research Analyst fills Name")),
    "must report the executed call name as extra (not in EXPECTED)",
  );
  assert(result.orderMismatch !== null, "must detect order mismatch at the mutated position");
});

Deno.test("journey-ledger-pairing: falsification — renamed check() call site fails fast", async () => {
  const file = `${ROOT}scripts/agent-access-journeys.ts`;
  const originalSource = await Deno.readTextFile(file);

  // Rename a check() call site without updating EXPECTED
  const mutatedCall = originalSource.replace(
    'check("plus menu: opens via a real click"',
    'check("plus menu: opens via an altered click"',
  );

  const result = verifyJourneyLedgerPairing(file, mutatedCall);
  assertEquals(result.ok, false, "mutated call site must fail pairing guard");
  assert(
    result.missing.includes("plus menu: opens via a real click"),
    "must report uncalled expected entry as missing",
  );
  assert(
    result.extra.includes("plus menu: opens via an altered click"),
    "must report undeclared call site as extra",
  );
});

Deno.test("journey-ledger-pairing: falsification — swapped assertion order fails fast", async () => {
  const file = `${ROOT}scripts/agent-access-journeys.ts`;
  const originalSource = await Deno.readTextFile(file);

  // Swap two consecutive EXPECTED entries
  const mutatedOrder = originalSource.replace(
    '  "seed: named agents created",\n  "seed: a background agent enabled",',
    '  "seed: a background agent enabled",\n  "seed: named agents created",',
  );

  const result = verifyJourneyLedgerPairing(file, mutatedOrder);
  assertEquals(result.ok, false, "order swap must fail pairing guard");
  assertEquals(result.missing.length, 0, "set membership remains unchanged on swap");
  assertEquals(result.extra.length, 0);
  assert(result.orderMismatch !== null, "must detect order mismatch");
  assertEquals(result.orderMismatch.expected, "seed: a background agent enabled");
  assertEquals(result.orderMismatch.actual, "seed: named agents created");
});
