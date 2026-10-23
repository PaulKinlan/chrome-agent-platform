// Heavy-tier receipt tests (chrome-agent-platform-upqhp).
//
// The gate fails closed without a fresh passing heavy receipt for the exact tree being
// certified, so these tests pin every branch of checkHeavyReceipt plus the two wirings:
// heavy-gate writes a receipt for every outcome, and run-tests invokes the check on the gate
// form only. All file assertions run against a repo-local temp durable root (CAP_DURABLE_ROOT),
// set and restored inside each test — process-global env, but deno --parallel isolates files
// in separate workers, so cross-file interference is not possible (same pattern as
// tests/durable-root.test.ts).

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RECEIPT_MAX_AGE_MS,
  checkHeavyReceipt,
  receiptPath,
  writeHeavyReceipt,
} from "../scripts/lib/heavy-receipt.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

function withDurableRoot(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = join(ROOT, ".cap-test-durable", `heavy-receipt-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    const previous = Deno.env.get("CAP_DURABLE_ROOT");
    Deno.env.set("CAP_DURABLE_ROOT", dir);
    try {
      await fn(dir);
    } finally {
      if (previous === undefined) Deno.env.delete("CAP_DURABLE_ROOT");
      else Deno.env.set("CAP_DURABLE_ROOT", previous);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const TREE = "a".repeat(40);
const NOW = 1_800_000_000_000;

Deno.test("upqhp: a passing receipt for the exact tree certifies it", withDurableRoot(async (dir) => {
  const { path } = writeHeavyReceipt({
    tree: TREE,
    commit: "491316ec6",
    result: "pass",
    command: "deno run -A scripts/heavy-gate.ts",
    exitCode: 0,
    logPath: "/tmp/heavy.log",
    suites: 21,
    producer: "chrome-agent-platform-scale2",
    startedAt: NOW - 1000,
    finishedAt: NOW,
  });
  assertEquals(path, receiptPath(TREE));
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, true);
  const receipt = verdict.receipt as Record<string, unknown>;
  assertEquals(receipt.result, "pass");
  assertEquals(receipt.commit, "491316ec6");
  assertEquals(receipt.producer, "chrome-agent-platform-scale2");
  assertEquals(receipt.suites, 21);
  // coord condition (upqhp): the receipt records the EXACT command and result.
  assertEquals(receipt.command, "deno run -A scripts/heavy-gate.ts");
  assertEquals(receipt.exitCode, 0);
}));

Deno.test("upqhp falsifier: a tree with no receipt is refused, never silently skipped", withDurableRoot(async () => {
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "missing");
  assertEquals(verdict.marker, "HEAVY_RECEIPT_REFUSAL");
  assertStringIncludes(verdict.line, "HEAVY RECEIPT MISSING");
  assertStringIncludes(verdict.line, TREE.slice(0, 12));
}));

Deno.test("upqhp falsifier: a receipt for a DIFFERENT tree does not certify", withDurableRoot(async () => {
  // Content addressing: a receipt for another tree simply does not exist at this tree's path,
  // so the honest refusal is "missing". The tree-mismatch branch guards a hand-mislabeled
  // file — a receipt whose FILENAME claims tree A but whose contents claim tree B.
  writeHeavyReceipt({ tree: "b".repeat(40), commit: "x", result: "pass", finishedAt: NOW });
  const otherTree = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(otherTree.ok, false);
  assertEquals(otherTree.reason, "missing");

  writeHeavyReceipt({ tree: TREE, commit: "x", result: "pass", finishedAt: NOW });
  const path = receiptPath(TREE);
  const mislabeled = JSON.parse(Deno.readTextFileSync(path));
  mislabeled.tree = "c".repeat(40);
  Deno.writeTextFileSync(path, JSON.stringify(mislabeled));
  const mismatch = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(mismatch.ok, false);
  assertEquals(mismatch.reason, "tree-mismatch");
  assertEquals(mismatch.marker, "HEAVY_RECEIPT_REFUSAL");
}));

Deno.test("upqhp falsifier: a refused or failed tier run does not certify", withDurableRoot(async () => {
  for (const result of ["refusal", "fail"] as const) {
    writeHeavyReceipt({ tree: TREE, commit: "x", result, finishedAt: NOW });
    const verdict = checkHeavyReceipt(TREE, { now: NOW });
    assertEquals(verdict.ok, false, `result "${result}" must not certify`);
    assertEquals(verdict.reason, `not-pass:${result}`);
  }
}));

Deno.test("upqhp: a receipt older than the window is refused as stale", withDurableRoot(async () => {
  writeHeavyReceipt({ tree: TREE, commit: "x", result: "pass", finishedAt: NOW - DEFAULT_RECEIPT_MAX_AGE_MS - 1000 });
  const stale = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(stale.ok, false);
  assertEquals(stale.reason, "stale");
  // And inside the window it certifies.
  writeHeavyReceipt({ tree: TREE, commit: "x", result: "pass", finishedAt: NOW - 1000 });
  assertEquals(checkHeavyReceipt(TREE, { now: NOW }).ok, true);
}));

Deno.test("upqhp: a MALFORMED receipt is refused and the message names the expected tree", withDurableRoot(async () => {
  const path = receiptPath(TREE);
  Deno.writeTextFileSync(path, "{not json at all");
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "unreadable");
  assertEquals(verdict.marker, "HEAVY_RECEIPT_REFUSAL");
  assertStringIncludes(verdict.line, TREE.slice(0, 12));
}));

Deno.test("upqhp: an undatable receipt is refused rather than guessed", withDurableRoot(async () => {
  writeHeavyReceipt({ tree: TREE, commit: "x", result: "pass", finishedAt: NOW });
  // Corrupt the timestamp the way a half-written file would lose it.
  const path = receiptPath(TREE);
  const parsed = JSON.parse(Deno.readTextFileSync(path));
  delete parsed.finishedAt;
  Deno.writeTextFileSync(path, JSON.stringify(parsed));
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "no-timestamp");
}));

Deno.test("upqhp: the writer refuses to mint a receipt with an invalid result", withDurableRoot(async () => {
  let threw: unknown = null;
  try {
    writeHeavyReceipt({ tree: TREE, result: "green" as never, finishedAt: NOW });
  } catch (error) {
    threw = error;
  }
  assertEquals(threw !== null, true, "invalid result must throw");
}));

Deno.test("upqhp wiring: the receipt check is a gate-command stage, not an npm-test stage", () => {
  // Learned on 92157a0e5's first fast gate: the fast gate escalates machinery changes (edits to
  // run-tests.mjs) to the FULL suite, so a receipt demand inside npm test turns every machinery
  // change into a 40-minute tier gate. The check therefore lives in scripts/gate-receipt.mjs and
  // is invoked by the gate command directly: `node scripts/gate-receipt.mjs`.
  const runTests = Deno.readTextFileSync(join(ROOT, "scripts", "run-tests.mjs"));
  assertEquals(runTests.includes("checkHeavyReceipt"), false, "run-tests must not demand receipts (fast-gate escalation would multiply tier cost)");
  // NOT an npm script, deliberately (measured on 1b1a8d3's fast gate, 2026-10-23): select-tests
  // FAILS CLOSED on any package.json edit ("release/version JSON belongs to the merger; a lane
  // change here cannot be subset-certified") and escalates the fast tier to the FULL suite, which
  // then dies at the lane's bound with no verdict. A one-line npm alias is not worth making every
  // future receipt change un-certifiable, so the gate command names this file instead.
  const pkg = JSON.parse(Deno.readTextFileSync(join(ROOT, "package.json")));
  assertEquals(pkg.scripts["gate:receipt"], undefined, "the receipt stage is invoked by path, not through an npm alias (a package.json edit cannot be fast-certified)");
  assertEquals(Deno.statSync(join(ROOT, "scripts", "gate-receipt.mjs")).isFile, true);
  const stage = Deno.readTextFileSync(join(ROOT, "scripts", "gate-receipt.mjs"));
  assertStringIncludes(stage, "checkHeavyReceipt(tree)");
  assertStringIncludes(stage, "HEAVY_RECEIPT_REFUSAL");
  assertStringIncludes(stage, "process.exit(2)");
  // The named refusal contract lives in the library the stage consumes.
  const receiptLib = Deno.readTextFileSync(join(ROOT, "scripts", "lib", "heavy-receipt.mjs"));
  assertStringIncludes(receiptLib, "HEAVY_RECEIPT_REFUSAL");
  // The tier run is the producer: every heavy-gate outcome writes its receipt.
  const heavyGate = Deno.readTextFileSync(join(ROOT, "scripts", "heavy-gate.ts"));
  assertStringIncludes(heavyGate, "writeHeavyReceipt({");
  assertStringIncludes(heavyGate, "result: rc === 0 ? \"pass\" : rc === ENVIRONMENTAL_REFUSAL_EXIT ? \"refusal\" : \"fail\"");
  assertStringIncludes(heavyGate, "command: argv.join(\" \")");
  assertStringIncludes(heavyGate, "exitCode: rc");
});
