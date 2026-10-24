// Heavy-tier receipt tests (chrome-agent-platform-upqhp + juubk).
//
// The gate fails closed without a fresh, COMPLETE, passing heavy receipt for the exact tree being
// certified, so these tests pin every branch of checkHeavyReceipt and every way the writer can be
// tricked into minting a certifying receipt for work that did not happen:
//
//   upqhp — the receipt exists, is keyed to the tree, and the gate refuses without it;
//   juubk — completeness (a subset run can never certify), per-suite terminal statuses, tree
//           fidelity across the run, a dirty worktree, atomic write, immutability of a certifying
//           receipt, and a write failure that cannot read as a pass.
//
// ISOLATION: receipts are content-addressed by git tree hash, so each test mints its own RANDOM
// 40-hex tree id and removes exactly what it wrote in a finally. That keeps every test independent
// (no order, no machine state, and two concurrent runs of this file cannot collide on a path)
// without mutating the parent process's durable root — a test that does that races parallel suites,
// which is why tests/durable-root.test.ts fails the gate on the pattern (bead zuo0i).

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RECEIPT_MAX_AGE_MS,
  RECEIPT_FUTURE_SKEW_MS,
  RECEIPT_VERSION,
  auditSuiteLedger,
  checkHeavyReceipt,
  expectedHeavyFiles,
  isRelevantDirtyPath,
  receiptPath,
  writeHeavyReceipt,
} from "../scripts/lib/heavy-receipt.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** A random 40-hex tree id. Unique per test, so two concurrent runs of this file cannot collide on
 *  a receipt path, and no real commit tree is ever named. */
function randomTree(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The complete, all-green suite ledger for the tree's enumerated heavy set. */
function completeSuites(): { file: string; phase: string; status: string }[] {
  return expectedHeavyFiles().map((file) => ({ file, phase: "parallel", status: "passed" }));
}

/** A receipt body that WOULD certify if the fields were honest. */
function certifyingBody(tree: string, overrides: Record<string, unknown> = {}) {
  return {
    version: RECEIPT_VERSION,
    tree,
    treeEnd: tree,
    commit: "491316ec6",
    result: "pass",
    claimed: "pass",
    complete: true,
    exitCode: 0,
    command: "deno run -A scripts/heavy-gate.ts",
    args: [],
    suites: completeSuites(),
    expected: expectedHeavyFiles(),
    covered: expectedHeavyFiles(),
    missing: [],
    skipped: [],
    producer: "chrome-agent-platform-imp-rec",
    host: "test-host",
    startedAt: NOW - 1000,
    finishedAt: NOW,
    logPath: "cap-evidence/logs/heavy-gate.log",
    ...overrides,
  };
}

/** Each test gets as many tree ids as it needs; every receipt file it wrote is removed in the
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
      for (const tree of minted) {
        rmSync(receiptPath(tree), { force: true, recursive: true });
        // A killed atomic write must not leave a temp sibling behind either.
        for (const entry of safeReaddir(dirname(receiptPath(tree)))) {
          if (entry.startsWith(`${basename(receiptPath(tree))}.`)) rmSync(join(dirname(receiptPath(tree)), entry), { force: true });
        }
      }
    }
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The named refusal line a check returns (`line` is absent on the certifying branch by type). */
function refusalLine(verdict: { line?: string }): string {
  return verdict.line ?? "";
}

const NOW = 1_800_000_000_000;

Deno.test("upqhp: a complete passing receipt for the exact tree certifies it", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  const { path, receipt } = writeHeavyReceipt({
    tree: TREE,
    treeEnd: TREE,
    commit: "491316ec6",
    result: "pass",
    command: "deno run -A scripts/heavy-gate.ts",
    args: [],
    exitCode: 0,
    logPath: "cap-evidence/logs/heavy-gate.log",
    suites: completeSuites(),
    producer: "chrome-agent-platform-imp-rec",
    startedAt: NOW - 1000,
    finishedAt: NOW,
  });
  assertEquals(path, receiptPath(TREE));
  assertEquals(receipt.complete, true);
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, true, refusalLine(verdict));
  const stored = verdict.receipt as Record<string, unknown>;
  // coord condition (upqhp): the receipt records the EXACT command and raw result.
  assertEquals(stored.command, "deno run -A scripts/heavy-gate.ts");
  assertEquals(stored.exitCode, 0);
  assertEquals(stored.version, RECEIPT_VERSION);
  // juubk: the covered set is enumerated, not a count.
  assertEquals((stored.covered as string[]).length, expectedHeavyFiles().length);
}));

Deno.test("upqhp falsifier: a tree with no receipt is refused, never silently skipped", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "missing");
  assertEquals(verdict.marker, "HEAVY_RECEIPT_REFUSAL");
  assertStringIncludes(refusalLine(verdict), "HEAVY RECEIPT MISSING");
  assertStringIncludes(refusalLine(verdict), TREE.slice(0, 12));
}));

Deno.test("upqhp falsifier: a receipt for a DIFFERENT tree does not certify", withReceipts(async (nextTree) => {
  // Content addressing: a receipt for another tree simply does not exist at this tree's path, so
  // the honest refusal is "missing". The tree-mismatch branch guards a hand-mislabeled file — a
  // receipt whose FILENAME claims tree A but whose contents claim tree B.
  const TREE = nextTree();
  writeHeavyReceipt({ tree: nextTree(), result: "pass", suites: completeSuites(), finishedAt: NOW });
  const otherTree = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(otherTree.ok, false);
  assertEquals(otherTree.reason, "missing");

  writeFileSync(receiptPath(TREE), JSON.stringify(certifyingBody(TREE, { tree: nextTree() })));
  const mismatch = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(mismatch.ok, false);
  assertEquals(mismatch.reason, "tree-mismatch");
  assertEquals(mismatch.marker, "HEAVY_RECEIPT_REFUSAL");
}));

Deno.test("upqhp falsifier: a refused or failed tier run does not certify", withReceipts(async (nextTree) => {
  for (const result of ["refusal", "fail"] as const) {
    const TREE = nextTree();
    writeHeavyReceipt({ tree: TREE, result, suites: completeSuites(), finishedAt: NOW });
    const verdict = checkHeavyReceipt(TREE, { now: NOW });
    assertEquals(verdict.ok, false, `result "${result}" must not certify`);
    assertEquals(verdict.reason, `not-pass:${result}`);
  }
}));

Deno.test("upqhp: a receipt older than the window is refused as stale", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  writeHeavyReceipt({ tree: TREE, result: "pass", args: [], exitCode: 0, suites: completeSuites(), finishedAt: NOW - DEFAULT_RECEIPT_MAX_AGE_MS - 1000 });
  const stale = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(stale.ok, false);
  assertEquals(stale.reason, "stale");
  // And inside the window it certifies.
  writeHeavyReceipt({ tree: TREE, result: "pass", args: [], exitCode: 0, suites: completeSuites(), finishedAt: NOW - 1000 });
  assertEquals(checkHeavyReceipt(TREE, { now: NOW }).ok, true);
}));

Deno.test("upqhp: a MALFORMED receipt is refused and the message names the expected tree", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  writeFileSync(receiptPath(TREE), "{not json at all");
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "unreadable");
  assertEquals(verdict.marker, "HEAVY_RECEIPT_REFUSAL");
  assertStringIncludes(refusalLine(verdict), TREE.slice(0, 12));
}));

Deno.test("upqhp: an undatable receipt is refused rather than guessed", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  const body = certifyingBody(TREE);
  delete (body as Record<string, unknown>).finishedAt;
  writeFileSync(receiptPath(TREE), JSON.stringify(body));
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "no-timestamp");
}));

Deno.test("juubk falsifier: a ONE-FILE subset run can never certify, even when it passed", withReceipts(async (nextTree) => {
  // The measured hole this bead closes: `filesFor()` accepts argv, so a single-file run is legal,
  // and v1 wrote result:pass for it — a probe could then certify the other enumerated suites.
  const TREE = nextTree();
  const probe = expectedHeavyFiles()[0];
  const { receipt } = writeHeavyReceipt({
    tree: TREE,
    result: "pass",
    args: [probe],
    exitCode: 0,
    suites: [{ file: probe, phase: "parallel", status: "passed" }],
    finishedAt: NOW,
  });
  assertEquals(receipt.result, "subset", "a subset run must be recorded as subset, never pass");
  assertEquals(receipt.complete, false);
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "not-pass:subset");
}));

Deno.test("juubk falsifier: a pass claim with an unrun suite is downgraded and refused", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  const short = completeSuites().slice(0, -1); // one enumerated suite never ran
  const { receipt } = writeHeavyReceipt({ tree: TREE, result: "pass", args: [], exitCode: 0, suites: short, finishedAt: NOW });
  assertEquals(receipt.complete, false);
  assertEquals(receipt.missing, [expectedHeavyFiles().at(-1)]);
  assertEquals(checkHeavyReceipt(TREE, { now: NOW }).ok, false);

  // And a receipt that CLAIMS completion while a suite is unrun is refused at the gate too,
  // because the gate recomputes the set from the tree's taxonomy rather than trusting the flag.
  writeFileSync(
    receiptPath(TREE),
    JSON.stringify(certifyingBody(TREE, { covered: short, suites: short })),
  );
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "coverage-mismatch");
  assertStringIncludes(refusalLine(verdict), expectedHeavyFiles().at(-1) as string);
}));

Deno.test("juubk falsifier: a killed, refused, failed or unknown suite blocks certification", withReceipts(async (nextTree) => {
  for (const status of ["killed", "refused", "failed", "unknown"]) {
    const TREE = nextTree();
    const suites = completeSuites();
    suites[0] = { ...suites[0], status };
    writeFileSync(receiptPath(TREE), JSON.stringify(certifyingBody(TREE, { suites })));
    const verdict = checkHeavyReceipt(TREE, { now: NOW });
    assertEquals(verdict.ok, false, `a "${status}" suite must not certify`);
    assertEquals(verdict.reason, "incomplete-suites");
    assertStringIncludes(refusalLine(verdict), `${suites[0].file} (${status})`);
  }
}));

Deno.test("juubk falsifier: a worktree that mutated mid-run is recorded as drift, never a pass", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  const { receipt } = writeHeavyReceipt({
    tree: TREE,
    treeEnd: nextTree(), // the tree changed while the suites ran
    result: "pass",
    args: [],
    exitCode: 0,
    suites: completeSuites(),
    finishedAt: NOW,
  });
  assertEquals(receipt.result, "drift");
  assertEquals(receipt.complete, false);
  assertEquals(checkHeavyReceipt(TREE, { now: NOW }).reason, "not-pass:drift");
}));

Deno.test("juubk falsifier: a certifying receipt is never replaced by a weaker run", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  writeHeavyReceipt({ tree: TREE, result: "pass", args: [], exitCode: 0, suites: completeSuites(), finishedAt: NOW });
  assertEquals(checkHeavyReceipt(TREE, { now: NOW }).ok, true);

  const second = writeHeavyReceipt({ tree: TREE, result: "fail", exitCode: 1, suites: completeSuites(), finishedAt: NOW + 1 });
  assertEquals(second.preserved, true, "the weaker run must not overwrite the certifying receipt");
  const verdict = checkHeavyReceipt(TREE, { now: NOW + 2 });
  assertEquals(verdict.ok, true);
  assertEquals((verdict.receipt as Record<string, unknown>).result, "pass");
}));

Deno.test("juubk falsifier: an unwritable receipt throws and leaves no temp file behind", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  // A DIRECTORY at the receipt path makes the atomic rename fail, which is how a full disk or a
  // permission change surfaces here. The write must throw (the producer then exits non-zero) and
  // must not leave a half-written temp sibling that a later reader could parse.
  mkdirSync(receiptPath(TREE), { recursive: true });
  let threw: unknown = null;
  try {
    writeHeavyReceipt({ tree: TREE, result: "pass", args: [], exitCode: 0, suites: completeSuites(), finishedAt: NOW });
  } catch (error) {
    threw = error;
  }
  assertEquals(threw !== null, true, "an unwritable receipt must throw, not silently succeed");
  const leftovers = safeReaddir(dirname(receiptPath(TREE))).filter((entry) => entry.startsWith(`${basename(receiptPath(TREE))}.`));
  assertEquals(leftovers, [], `atomic write left temp file(s) behind: ${leftovers.join(", ")}`);
  // And the gate refuses this tree rather than reading the directory as a receipt.
  assertEquals(checkHeavyReceipt(TREE, { now: NOW }).ok, false);
}));

Deno.test("juubk falsifier: a run from a DIRTY worktree never certifies", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  // The suites ran against bytes that are not in the tree hash the gate checks.
  const { receipt } = writeHeavyReceipt({
    tree: TREE,
    result: "pass",
    args: [],
    exitCode: 0,
    suites: completeSuites(),
    dirty: ["scripts/heavy-gate.ts"],
    finishedAt: NOW,
  });
  assertEquals(receipt.complete, false);
  assertEquals(receipt.result, "fail");
  assertEquals(checkHeavyReceipt(TREE, { now: NOW }).ok, false);

  // And a receipt that claims completion while recording uncommitted content is refused by name.
  writeFileSync(receiptPath(TREE), JSON.stringify(certifyingBody(TREE, { dirty: ["scripts/lib/heavy-receipt.mjs"] })));
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "dirty");
  assertStringIncludes(refusalLine(verdict), "scripts/lib/heavy-receipt.mjs");
}));

Deno.test("957s2 falsifier: claimed completion over an EMPTY ledger does not certify", withReceipts(async (nextTree) => {
  // The reviewer's exact reproduction (rev-juubk1, 2026-10-23): a v2 receipt whose covered list names
  // all suites, whose suites ledger is EMPTY, whose treeEnd is wrong and whose args name a subset was
  // accepted, because the check trusted the producer's own flags. Every one of those is now
  // recomputed from the ledger, so each is refused on its own term.
  const TREE = nextTree();
  writeFileSync(
    receiptPath(TREE),
    JSON.stringify(certifyingBody(TREE, {
      suites: [],
      covered: expectedHeavyFiles(),
      treeEnd: nextTree(),
      args: [expectedHeavyFiles()[0]],
      command: "deno run -A scripts/heavy-gate.ts tests/python-runtime.test.ts",
    })),
  );
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false, "an empty ledger beside a claimed completion must never certify");
  assertEquals(verdict.reason, "subset-invocation");
}));

Deno.test("957s2 falsifier: each forged field is refused on its own terms", withReceipts(async (nextTree) => {
  const cases: { name: string; body: Record<string, unknown>; reason: string }[] = [
    { name: "empty ledger", body: { suites: [] }, reason: "coverage-mismatch" },
    { name: "subset args", body: { args: ["tests/python-runtime.test.ts"] }, reason: "subset-invocation" },
    { name: "tree moved mid-run", body: { treeEnd: nextTree() }, reason: "drift" },
    { name: "duplicated suite", body: { suites: [...completeSuites(), completeSuites()[0]] }, reason: "ledger-duplicate" },
    { name: "extra suite", body: { suites: [...completeSuites(), { file: "tests/not-heavy.test.ts", phase: "parallel", status: "passed" }] }, reason: "coverage-mismatch" },
    { name: "complete flag false", body: { complete: false }, reason: "incomplete" },
  ];
  for (const { name, body, reason } of cases) {
    const TREE = nextTree();
    writeFileSync(receiptPath(TREE), JSON.stringify(certifyingBody(TREE, body)));
    const verdict = checkHeavyReceipt(TREE, { now: NOW });
    assertEquals(verdict.ok, false, `${name} must not certify`);
    assertEquals(verdict.reason, reason, `${name} must be refused as ${reason}, got ${verdict.reason}`);
  }
}));

Deno.test("957s2: the ledger audit is one function, shared by producer and checker", () => {
  const expected = ["a.test.ts", "b.test.ts"];
  assertEquals(auditSuiteLedger([{ file: "a.test.ts", status: "passed" }, { file: "b.test.ts", status: "passed" }], expected).ok, true);
  const empty = auditSuiteLedger([], expected);
  assertEquals([empty.ok, empty.missing], [false, ["a.test.ts", "b.test.ts"]]);
  assertEquals(auditSuiteLedger([{ file: "a.test.ts", status: "passed" }, { file: "a.test.ts", status: "passed" }], expected).duplicate, ["a.test.ts"]);
  assertEquals(auditSuiteLedger([{ file: "a.test.ts", status: "killed" }, { file: "b.test.ts", status: "passed" }], expected).bad, [{ file: "a.test.ts", status: "killed" }]);
  // The writer and the checker must not be able to disagree: the producer's completeness flag is
  // computed by THIS function, and the checker re-derives it.
  const lib = readFileSync(join(ROOT, "scripts", "lib", "heavy-receipt.mjs"), "utf8");
  assertEquals((lib.match(/auditSuiteLedger\(/g) ?? []).length >= 3, true, "writer and checker must both call the shared audit");
});

Deno.test("juubk: the dirty-worktree rule ignores the passive beads ledger, nothing else", () => {
  // The trap this avoids: every bd write in this fleet dirties .beads/issues.jsonl, including the
  // comment recording the heavy run. Refusing over a file no suite reads would make a CORRECT
  // receipt fail with a name unrelated to the suites — a fail-closed check people learn to bypass.
  for (const path of [".beads/issues.jsonl", ".beads/config.yaml"]) {
    assertEquals(isRelevantDirtyPath(path), false, `${path} must not block a receipt`);
  }
  // Any other tracked path blocks by default — the rule is an allowlist of ONE prefix, not a list of
  // files to remember. These are the shapes a landing actually dirties.
  for (const path of ["scripts/heavy-gate.ts", "tests/heavy-receipt.test.ts", "package.json", "scripts/test-partition.mjs"]) {
    assertEquals(isRelevantDirtyPath(path), true, `${path} changes what the suites measure`);
  }
});

Deno.test("juubk falsifier: a legacy v1 receipt (a suite COUNT, no set) cannot certify", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  writeFileSync(
    receiptPath(TREE),
    JSON.stringify({ version: 1, tree: TREE, commit: "x", result: "pass", exitCode: 0, suites: 19, finishedAt: NOW }),
  );
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "wrong-version");
  assertStringIncludes(refusalLine(verdict), TREE.slice(0, 12));
}));

Deno.test("juubk falsifier: a receipt dated in the FUTURE is refused (unverifiable clock)", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  writeFileSync(receiptPath(TREE), JSON.stringify(certifyingBody(TREE, { finishedAt: NOW + RECEIPT_FUTURE_SKEW_MS + 1000 })));
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "future");
}));

Deno.test("juubk falsifier: a certifying receipt must record a raw zero exit", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  writeFileSync(receiptPath(TREE), JSON.stringify(certifyingBody(TREE, { exitCode: 1 })));
  const verdict = checkHeavyReceipt(TREE, { now: NOW });
  assertEquals(verdict.ok, false);
  assertEquals(verdict.reason, "raw-rc");
}));

Deno.test("juubk: the writer refuses to mint a receipt with an invalid result", withReceipts(async (nextTree) => {
  const TREE = nextTree();
  let threw: unknown = null;
  try {
    writeHeavyReceipt({ tree: TREE, result: "green" as never, finishedAt: NOW });
  } catch (error) {
    threw = error;
  }
  assertEquals(threw !== null, true, "invalid result must throw");
}));

Deno.test("upqhp/juubk wiring: the receipt stays out of npm test, and the producer owns completeness", () => {
  // Learned on 92157a0e5's first fast gate: the fast gate escalates machinery changes (edits to
  // run-tests.mjs) to the FULL suite, so a receipt demand inside npm test turns every machinery
  // change into a 40-minute tier gate. The check therefore lives in scripts/gate-receipt.mjs and
  // is invoked by the gate command directly: `node scripts/gate-receipt.mjs`.
  const runTests = readFileSync(join(ROOT, "scripts", "run-tests.mjs"), "utf8");
  assertEquals(runTests.includes("checkHeavyReceipt"), false, "run-tests must not demand receipts (fast-gate escalation would multiply tier cost)");
  // NOT an npm script, deliberately: select-tests FAILS CLOSED on any package.json edit
  // ("release/version JSON belongs to the merger; a lane change here cannot be subset-certified")
  // and escalates the fast tier to the FULL suite, which then dies at the lane's bound with no
  // verdict. A one-line npm alias is not worth making every future receipt change un-certifiable.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assertEquals(pkg.scripts["gate:receipt"], undefined, "the receipt stage is invoked by path, not through an npm alias (a package.json edit cannot be fast-certified)");
  const stage = readFileSync(join(ROOT, "scripts", "gate-receipt.mjs"), "utf8");
  assertStringIncludes(stage, "checkHeavyReceipt(tree");
  assertStringIncludes(stage, "HEAVY_RECEIPT_REFUSAL");
  assertStringIncludes(stage, "process.exit(2)");
  assertStringIncludes(stage, "expectedHeavyFiles()");
  // The named refusal contract lives in the library the stage consumes.
  const receiptLib = readFileSync(join(ROOT, "scripts", "lib", "heavy-receipt.mjs"), "utf8");
  assertStringIncludes(receiptLib, "HEAVY_RECEIPT_REFUSAL");
  assertStringIncludes(receiptLib, "renameSync", "the receipt write must be atomic (juubk)");
  // The tier run is the producer: every outcome is recorded, the tree is captured at BOTH ends,
  // and the per-suite ledger comes from the phases that actually ran.
  const heavyGate = readFileSync(join(ROOT, "scripts", "heavy-gate.ts"), "utf8");
  assertStringIncludes(heavyGate, "writeHeavyReceipt({");
  assertStringIncludes(heavyGate, "result: rc === 0 ? \"pass\" : rc === ENVIRONMENTAL_REFUSAL_EXIT ? \"refusal\" : \"fail\"");
  assertStringIncludes(heavyGate, "command: argv.join(\" \")");
  assertStringIncludes(heavyGate, "exitCode: rc");
  assertStringIncludes(heavyGate, "treeEnd: mod.currentTreeHash()");
  assertStringIncludes(heavyGate, "args: cliArgs");
  assertStringIncludes(heavyGate, "suites,");
  assertStringIncludes(heavyGate, "dirty: mod.dirtyTrackedPaths()");
  assertStringIncludes(heavyGate, "if (rc === 0) rc = 1;", "an unwritable receipt must not leave a successful producer exit (juubk)");
});
