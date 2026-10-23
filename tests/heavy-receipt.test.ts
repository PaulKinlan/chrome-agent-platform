// Heavy-tier receipt tests (chrome-agent-platform-upqhp).
//
// The gate fails closed without a fresh passing heavy receipt for the exact tree being
// certified, so these tests pin every branch of checkHeavyReceipt plus the two wirings:
// heavy-gate writes a receipt for every outcome, and the gate command invokes the check.
//
// ISOLATION: receipts are content-addressed by git tree hash, so these tests mint their own
// RANDOM 40-hex tree per test and remove the files they wrote in a finally. That keeps every
// test independent (no order, no machine state, no files another lane's concurrent run of this
// same file is touching) without mutating the parent process's durable root at all — a test
// that does that races parallel suites, which is why tests/durable-root.test.ts fails the gate
// on the pattern (bead zuo0i).

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RECEIPT_MAX_AGE_MS,
  checkHeavyReceipt,
  receiptPath,
  writeHeavyReceipt,
} from "../scripts/lib/heavy-receipt.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** A random 40-hex tree id. Unique per test, so two concurrent runs of this file cannot collide
 *  on a receipt path, and no real commit tree is ever named. */
function randomTree(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Each test gets as many tree ids as it needs; every receipt file it writes is removed in the
 *  finally, even when an assertion throws. */
function withReceipts(fn: (nextTree: () => string) => void | Promise<void>) {
  return async () => {
    const minted: string[] = [];
    const nextTree = () => {
      const tree = randomTree();
      minted.push(tree);
      return tree;
    };
    try {
      await fn(nextTree);
    } finally {
      for (const tree of minted) rmSync(receiptPath(tree), { force: true });
    }
  };
}

const NOW = 1_800_000_000_000;

Deno.test("upqhp: a passing receipt for the exact tree certifies it", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  const { path } = writeHeavyReceipt({
    tree: TREE,
    commit: "491316ec6",
    result: "pass",
    command: "deno run -A scripts/heavy-gate.ts",
    exitCode: 0,
    logPath: "cap-evidence/logs/heavy-gate.log",
    suites: 19,
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
  assertEquals(receipt.suites, 19);
  // coord condition (upqhp): the receipt records the EXACT command and result.
  assertEquals(receipt.command, "deno run -A scripts/heavy-gate.ts");
  assertEquals(receipt.exitCode, 0);
}));

Deno.test("upqhp falsifier: a tree with no receipt is refused, never silently skipped", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "missing");
  assertEquals(verdict.marker, "HEAVY_RECEIPT_REFUSAL");
  assertStringIncludes(verdict.line, "HEAVY RECEIPT MISSING");
  assertStringIncludes(verdict.line, TREE.slice(0, 12));
}));

Deno.test("upqhp falsifier: a receipt for a DIFFERENT tree does not certify", withReceipts(async (nextTree) => {
  // Content addressing: a receipt for another tree simply does not exist at this tree's path,
  // so the honest refusal is "missing". The tree-mismatch branch guards a hand-mislabeled
  // file — a receipt whose FILENAME claims tree A but whose contents claim tree B.
  const TREE = nextTree();
  writeHeavyReceipt({ tree: nextTree(), commit: "x", result: "pass", finishedAt: NOW });
  const otherTree = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(otherTree.ok, false);
  assertEquals(otherTree.reason, "missing");

  writeHeavyReceipt({ tree: TREE, commit: "x", result: "pass", finishedAt: NOW });
  const path = receiptPath(TREE);
  const mislabeled = JSON.parse(Deno.readTextFileSync(path));
  mislabeled.tree = nextTree();
  Deno.writeTextFileSync(path, JSON.stringify(mislabeled));
  const mismatch = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(mismatch.ok, false);
  assertEquals(mismatch.reason, "tree-mismatch");
  assertEquals(mismatch.marker, "HEAVY_RECEIPT_REFUSAL");
}));

Deno.test("upqhp falsifier: a refused or failed tier run does not certify", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  for (const result of ["refusal", "fail"] as const) {
    writeHeavyReceipt({ tree: TREE, commit: "x", result, finishedAt: NOW });
    const verdict = checkHeavyReceipt(TREE, { now: NOW });
    assertEquals(verdict.ok, false, `result "${result}" must not certify`);
    assertEquals(verdict.reason, `not-pass:${result}`);
  }
}));

Deno.test("upqhp: a receipt older than the window is refused as stale", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  writeHeavyReceipt({ tree: TREE, commit: "x", result: "pass", finishedAt: NOW - DEFAULT_RECEIPT_MAX_AGE_MS - 1000 });
  const stale = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(stale.ok, false);
  assertEquals(stale.reason, "stale");
  // And inside the window it certifies.
  writeHeavyReceipt({ tree: TREE, commit: "x", result: "pass", finishedAt: NOW - 1000 });
  assertEquals(checkHeavyReceipt(TREE, { now: NOW }).ok, true);
}));

Deno.test("upqhp: a MALFORMED receipt is refused and the message names the expected tree", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  const path = receiptPath(TREE);
  Deno.writeTextFileSync(path, "{not json at all");
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "unreadable");
  assertEquals(verdict.marker, "HEAVY_RECEIPT_REFUSAL");
  assertStringIncludes(verdict.line, TREE.slice(0, 12));
}));

Deno.test("upqhp: an undatable receipt is refused rather than guessed", withReceipts(async (nextTree) => {
  const TREE = nextTree();
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

Deno.test("upqhp: the writer refuses to mint a receipt with an invalid result", withReceipts(async (nextTree) => {
  const TREE = nextTree();
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
