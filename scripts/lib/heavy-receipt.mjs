// Heavy-tier receipts (chrome-agent-platform-upqhp; hardened by chrome-agent-platform-juubk).
//
// The fleet gate command (`npm run build:production && npm test && npm run test:build`) never
// runs `npm run test:heavy`, so once a suite is tiered into the heavy tier the gate's coverage
// of it is gone: a clean PASS would not execute that suite at all. The design coord ruled
// (2026-10-23) closes that hole without re-merging ~2300s of endurance into every landing:
//
//   (a) a heavy-tier run writes a RECEIPT keyed to the exact git TREE it ran on
//       (tree hash + commit + timestamp + result + producer + log path) under the durable root
//       (`~/cap-evidence/heavy-receipts/<tree>.json`) — content-addressed and auditable;
//   (b) a gate-command stage (`node scripts/gate-receipt.mjs`) FAILS CLOSED unless a fresh,
//       COMPLETE, passing receipt exists for the tree being certified — named refusal, exit 2.
//
// PRODUCER RULE (coord, 2026-10-23): whoever holds the merged tip produces the receipt, from the
// worktree that will actually land; a heavy run somewhere else is worthless by construction,
// which is why the receipt is keyed on the tree and records producer and commit.
//
// WHAT A RECEIPT HAS TO PROVE (juubk — the hardening this file carries):
//
//   1. COMPLETENESS. `filesFor()` accepts argv, so `deno run -A scripts/heavy-gate.ts one-file`
//      is a legal invocation, and v1 wrote `result: pass` for it: a ONE-FILE green run could
//      overwrite a previously complete receipt for the tree and certify the other 18+ suites that
//      never ran (measured 2026-10-23: a 1-suite probe on tree c2d157354417 certified it). So a
//      pass is only ever published for a NO-ARGS run, and only when the covered set equals the
//      tree's enumerated HEAVY_GATE_FILES exactly, with no skipped, killed or unknown suite. A
//      subset run is recorded (honest ledger) as `subset` and can never certify.
//   2. IMMUTABILITY. The write is atomic (temp file in the same directory + rename), so a crash or
//      a kill leaves the previous receipt intact rather than a half-written file that parses as
//      something weaker. A certifying receipt already on disk for the same tree is never replaced
//      by a weaker one: a later failing/subset run does not destroy evidence that the tree passed.
//   3. TREE FIDELITY. The tree is captured at the START and at the END of the run; a worktree that
//      mutated mid-run cannot attribute those suites to the tree it happens to hold afterwards, so
//      a drift is recorded as `drift` and never certifies.
//   4. WRITE FAILURE IS NOT A PASS. If the receipt cannot be written the producer exits non-zero;
//      a green tier with no receipt would otherwise look like certification later.
//
// The check only binds the gate command, never the inner loop: `npm run test:file` and `npm test`
// carry no receipt logic (a demand inside npm test would make every selector-machinery edit
// escalate to a 40-minute tier gate — measured on 92157a0e5's first fast gate).

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { durableDir } from "./durable-root.mjs";
import { HEAVY_GATE_FILES } from "../test-partition.mjs";

export const RECEIPT_DIR_NAME = "heavy-receipts";
/** v2 (juubk): versioned payload carrying the covered/expected suite sets and per-suite statuses.
 *  v1 receipts recorded only a suite COUNT, so they cannot certify anything under these rules. */
export const RECEIPT_VERSION = 2;

// A receipt for tree T can never be CONTENT-stale (git trees are immutable — different content is
// a different tree hash), so the age window is operational hygiene, not a correctness guarantee: it
// catches a tier rotting unnoticed, and it bounds how far back a certification can date. 30 days is
// generous against the nightly full line and per-landing runs; override for drills.
export const DEFAULT_RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// A finishedAt in the FUTURE is not a stale receipt, it is an unverifiable clock. Small skew is
// tolerated (NTP corrections, a machine without a battery); anything past that is a refusal.
export const RECEIPT_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Terminal per-suite statuses. Only `passed` may appear on a certifying receipt. */
export const SUITE_STATUSES = Object.freeze(["passed", "failed", "refused", "killed", "unknown"]);

/** Result classes. Only `pass` may certify; everything else is recorded so the ledger is honest. */
export const RECEIPT_RESULTS = Object.freeze(["pass", "fail", "refusal", "subset", "drift"]);

export function receiptDir() {
  // durableDir mkdir -p's its arguments, so the FILENAME is joined here, never passed in.
  return durableDir(RECEIPT_DIR_NAME);
}

export function receiptPath(tree) {
  return join(receiptDir(), `${tree}.json`);
}

/** `git rev-parse HEAD^{tree}` — the content identity of the checked-out tree. */
export function currentTreeHash(cwd) {
  return execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function currentCommitSha(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Tracked paths with uncommitted content (juubk: "reject drift/dirty relevant tracked changes").
 *
 * A receipt certifies TREE CONTENT, and a dirty worktree is not that tree: the suites ran against
 * bytes that are not in the hash the gate checks. Untracked files are excluded — they are not part
 * of any tree either way, and the repo's own gate witness treats tracked content as the object.
 */
export function dirtyTrackedPaths(cwd) {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .filter(isRelevantDirtyPath);
  } catch {
    return [];
  }
}

/**
 * Is this modified tracked path one a heavy receipt should refuse over?
 *
 * `.beads/` is excluded ON PURPOSE, and this is the difference between a check people trust and one
 * they learn to bypass: the beads export is a passive task ledger that no suite reads, and every bd
 * write in this fleet dirties it — including the very comment that records the heavy run. Counting it
 * would make a CORRECT receipt refuse with a name that has nothing to do with the suites, which is how
 * a fail-closed check teaches operators to work around it. Everything else (source, tests, extension
 * bundle, dist markers, scripts) DOES affect what the suites measure and still refuses.
 */
export function isRelevantDirtyPath(path) {
  return !path.startsWith(".beads/");
}

/** The enumerated heavy set for the tree being certified — read from the same table the tier uses. */
export function expectedHeavyFiles() {
  return [...HEAVY_GATE_FILES];
}

/**
 * Classify one phase's exit code into a per-suite terminal status.
 *
 * The parallel batch reports one code for the whole phase, so its files share the phase's verdict:
 * a batch that failed names EVERY file in it as `failed` rather than inventing per-file attribution
 * it does not have. That is deliberately conservative — only an all-green batch certifies, and a
 * refusal (75) or a bound kill is recorded as itself, never as a pass.
 */
export function phaseStatusFor(exitCode) {
  if (exitCode === 0) return "passed";
  if (exitCode === 75) return "refused";
  if (exitCode === 124 || exitCode === 137 || exitCode === 143) return "killed";
  if (Number.isFinite(exitCode) && exitCode > 0) return "failed";
  return "unknown";
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** True when this receipt certifies (complete, green, no skips) — the only shape worth preserving. */
function certifies(receipt) {
  return Boolean(receipt) && receipt.version === RECEIPT_VERSION && receipt.result === "pass" && receipt.complete === true;
}

/**
 * Audit a suite ledger against the tree's enumerated set (juubk + review finding 957s2).
 *
 * The ledger is the ONLY evidence that suites ran, so it is checked by content and not by the
 * `complete` flag beside it: a receipt that claims completion while its ledger is empty, short,
 * duplicated or non-passing is refused. Writer and checker share this one function, so a producer
 * cannot mint a shape the checker would not recompute for itself.
 *
 * @param {{ file?: string, status?: string }[]} suites
 * @param {string[]} expected
 * @returns {{ ok: boolean, missing: string[], extra: string[], duplicate: string[], bad: { file: string, status: string }[] }}
 */
export function auditSuiteLedger(suites, expected) {
  const entries = Array.isArray(suites) ? suites : [];
  const files = entries.map((entry) => (typeof entry?.file === "string" ? entry.file : ""));
  const counts = new Map();
  for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1);
  const missing = expected.filter((file) => !counts.has(file));
  const extra = [...counts.keys()].filter((file) => !expected.includes(file));
  const duplicate = [...counts.entries()].filter(([, count]) => count > 1).map(([file]) => file);
  const bad = entries
    .filter((entry) => entry?.status !== "passed")
    .map((entry) => ({ file: String(entry?.file ?? "unknown"), status: String(entry?.status ?? "unknown") }));
  return { ok: missing.length === 0 && extra.length === 0 && duplicate.length === 0 && bad.length === 0, missing, extra, duplicate, bad };
}

/**
 * Write a receipt atomically. Called for EVERY outcome — a refusal, a failure, a subset or a drift
 * is recorded too (honest ledger) — but only a complete no-args green run may carry `result: pass`,
 * and a certifying receipt already on disk is never replaced by a weaker one.
 *
 * Write failure THROWS: the producer must not exit 0 when it could not record what it ran, or the
 * gate would later refuse a tree that looked certified to the operator.
 *
 * @param {{ tree: string, treeEnd?: string, commit?: string, result: "pass"|"fail"|"refusal"|"subset"|"drift",
 *   command?: string, args?: string[], exitCode?: number | null, logPath?: string | null,
 *   suites?: { file: string, phase: string, status: string }[], expected?: string[], dirty?: string[], producer?: string,
 *   startedAt?: number | null, finishedAt?: number }} args
 */
export function writeHeavyReceipt({
  tree,
  treeEnd = tree,
  commit = "unknown",
  result,
  command = "unknown",
  args = [],
  exitCode = null,
  logPath = null,
  suites = [],
  expected = expectedHeavyFiles(),
  dirty = [],
  producer = process.env.FLEET_LANE ?? "unknown",
  startedAt = null,
  finishedAt = Date.now(),
}) {
  if (!RECEIPT_RESULTS.includes(result)) {
    throw new Error(`heavy-receipt: invalid result "${result}" (${RECEIPT_RESULTS.join("|")})`);
  }
  if (!tree) throw new Error("heavy-receipt: a receipt must name the tree it ran on");

  const covered = suites.map((s) => s.file);
  const ledger = auditSuiteLedger(suites, expected);
  const missing = ledger.missing;
  const skipped = ledger.bad.map((entry) => entry.file);
  const complete =
    result === "pass" &&
    ledger.ok &&
    args.length === 0 &&
    tree === treeEnd &&
    dirty.length === 0;

  // A pass claim that the run cannot support is a defect in the producer, not something to record
  // quietly as a pass: downgrade it here so nothing downstream can be tempted to trust the flag.
  const claimed = result;
  if (result === "pass" && !complete) {
    result = tree !== treeEnd ? "drift" : args.length > 0 || missing.length > 0 ? "subset" : "fail";
  }

  const receipt = {
    version: RECEIPT_VERSION,
    tree,
    treeEnd,
    commit,
    result,
    claimed,
    complete,
    exitCode,
    command,
    args,
    suites,
    expected,
    covered,
    missing,
    skipped,
    dirty,
    producer,
    host: process.env.HOSTNAME ?? "unknown",
    startedAt,
    finishedAt,
    logPath,
  };

  mkdirSync(receiptDir(), { recursive: true });
  const path = receiptPath(tree);
  const previous = readJsonIfPresent(path);
  const preserved = certifies(previous) && !certifies(receipt);
  if (!preserved) {
    // Atomic: a temp file in the SAME directory then rename, so a kill mid-write leaves the
    // previous receipt intact instead of a truncated file that could parse as something weaker.
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, `${JSON.stringify(receipt, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, path);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
  return { path, receipt, preserved };
}

/**
 * @typedef {Object} HeavyReceiptVerdict
 * @property {boolean} ok
 * @property {string} reason
 * @property {string} [line]    the named refusal an operator reads
 * @property {string} [marker]  HEAVY_RECEIPT_REFUSAL, for log scrapers
 * @property {Record<string, any>} [payload] machine-readable refusal detail
 * @property {Record<string, any>} [receipt] the certifying receipt
 * @property {string} [path]
 */

/**
 * The gate-side check (upqhp + juubk): a fresh, COMPLETE, passing receipt must exist for exactly
 * the tree being certified, and its covered set must equal this tree's enumerated heavy set.
 * Anything else — missing, corrupt, wrong version, different tree, subset, drift, non-pass, a
 * future or stale timestamp, a skipped/killed suite — is a named refusal, never a silent skip.
 *
 * @param {string} tree
 * @param {{ now?: number, maxAgeMs?: number, expected?: string[] }} [options]
 * @returns {HeavyReceiptVerdict}
 */
export function checkHeavyReceipt(tree, { now = Date.now(), maxAgeMs = DEFAULT_RECEIPT_MAX_AGE_MS, expected = expectedHeavyFiles() } = {}) {
  const path = receiptPath(tree);
  const refuse = (reason, line, payload = {}) => ({
    ok: false,
    reason,
    line,
    marker: "HEAVY_RECEIPT_REFUSAL",
    payload: { tree, expectedTree: tree, reason, ...payload },
  });

  if (!existsSync(path)) {
    return refuse(
      "missing",
      `gate-receipt: HEAVY RECEIPT MISSING for tree ${tree.slice(0, 12)} — the gate does not run the heavy tier, ` +
        `so no fresh passing receipt means the heavy suites are simply not covered (upqhp). ` +
        `Run \`npm run test:heavy\` (NO arguments) on THIS tree from the worktree that will land, then re-run the gate.`,
    );
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return refuse(
      "unreadable",
      `gate-receipt: HEAVY RECEIPT MALFORMED at ${path} — found receipt for tree ` +
        `${String(receipt === null ? "an unparseable file" : "unknown")} but certifying ${tree.slice(0, 12)} (${error.message}); ` +
        `refusing rather than guessing (upqhp/juubk).`,
    );
  }
  if (receipt.version !== RECEIPT_VERSION) {
    return refuse(
      "wrong-version",
      `gate-receipt: HEAVY RECEIPT VERSION ${String(receipt.version)} for tree ${String(receipt.tree).slice(0, 12)} ` +
        `cannot certify tree ${tree.slice(0, 12)} — this check requires v${RECEIPT_VERSION}, which records the covered ` +
        `suite set rather than a count (juubk). Re-run \`npm run test:heavy\` on THIS tree.`,
      { receiptVersion: receipt.version, receiptTree: receipt.tree },
    );
  }
  if (receipt.tree !== tree) {
    return refuse(
      "tree-mismatch",
      `gate-receipt: HEAVY RECEIPT TREE MISMATCH — receipt is for ${String(receipt.tree).slice(0, 12)}, ` +
        `certifying ${tree.slice(0, 12)}. A receipt certifies its exact tree only (upqhp).`,
      { receiptTree: receipt.tree },
    );
  }
  if (receipt.result !== "pass") {
    return refuse(
      `not-pass:${receipt.result ?? "unknown"}`,
      `gate-receipt: HEAVY RECEIPT IS NOT A PASS (result "${receipt.result}"` +
        `${receipt.claimed && receipt.claimed !== receipt.result ? `, claimed "${receipt.claimed}"` : ""}) for tree ` +
        `${tree.slice(0, 12)} — a refused, failed, subset or drifted tier run does not certify anything (upqhp/juubk). ` +
        `Fix the tier run, then re-run \`npm run test:heavy\` with no arguments.`,
      { result: receipt.result, claimed: receipt.claimed },
    );
  }
  // review finding 957s2: the check RECOMPUTES everything the receipt asserts. `complete`, `covered`
  // and `suites` are producer-written fields, and a receipt is exactly the kind of evidence an
  // operator trusts without re-deriving — so an empty ledger beside claimed completion, a subset
  // invocation, or a run whose tree moved must each be refused on their own terms.
  if (!Array.isArray(receipt.args) || receipt.args.length > 0) {
    return refuse(
      "subset-invocation",
      `gate-receipt: HEAVY RECEIPT RECORDS A SUBSET INVOCATION for tree ${tree.slice(0, 12)} — ` +
        `args ${JSON.stringify(receipt.args ?? null)}. Only a no-argument run of the full enumerated set ` +
        `certifies (juubk). Re-run \`npm run test:heavy\` with no arguments.`,
      { args: receipt.args ?? null },
    );
  }
  if (receipt.treeEnd !== tree) {
    return refuse(
      "drift",
      `gate-receipt: HEAVY RECEIPT'S RUN ENDED ON A DIFFERENT TREE — started ${String(receipt.tree).slice(0, 12)}, ` +
        `ended ${String(receipt.treeEnd ?? "unknown").slice(0, 12)}, certifying ${tree.slice(0, 12)}. The suites did ` +
        `not all run against this tree (juubk).`,
      { treeEnd: receipt.treeEnd ?? null },
    );
  }
  // The ledger must match THIS tree's enumerated set exactly, suite by suite — not a count, and not
  // the `covered` list beside it.
  const ledger = auditSuiteLedger(receipt.suites, expected);
  if (ledger.missing.length > 0 || ledger.extra.length > 0) {
    return refuse(
      "coverage-mismatch",
      `gate-receipt: HEAVY RECEIPT COVERS A DIFFERENT SUITE SET for tree ${tree.slice(0, 12)} — ` +
        `missing ${ledger.missing.length ? ledger.missing.join(", ") : "none"}; ` +
        `unexpected ${ledger.extra.length ? ledger.extra.join(", ") : "none"} (juubk). ` +
        `Re-run \`npm run test:heavy\` on THIS tree.`,
      { missing: ledger.missing, extra: ledger.extra },
    );
  }
  if (ledger.duplicate.length > 0) {
    return refuse(
      "ledger-duplicate",
      `gate-receipt: HEAVY RECEIPT LEDGER NAMES A SUITE MORE THAN ONCE for tree ${tree.slice(0, 12)} — ` +
        `${ledger.duplicate.join(", ")}; a ledger is one terminal status per suite (juubk).`,
      { duplicate: ledger.duplicate },
    );
  }
  if (ledger.bad.length > 0) {
    return refuse(
      "incomplete-suites",
      `gate-receipt: HEAVY RECEIPT HAS NON-PASSING SUITES for tree ${tree.slice(0, 12)} — ` +
        `${ledger.bad.map((entry) => `${entry.file} (${entry.status})`).join(", ")}. A receipt certifies only when ` +
        `every enumerated suite reached "passed" (juubk).`,
      { badSuites: ledger.bad },
    );
  }
  if (receipt.complete !== true) {
    return refuse(
      "incomplete",
      `gate-receipt: HEAVY RECEIPT IS NOT COMPLETE for tree ${tree.slice(0, 12)} — only a no-argument, clean, ` +
        `all-green run of the full enumerated set certifies (juubk).`,
      { covered: receipt.covered, expected: receipt.expected, dirty: receipt.dirty ?? null },
    );
  }
  const dirty = Array.isArray(receipt.dirty) ? receipt.dirty : [];
  if (dirty.length > 0) {
    return refuse(
      "dirty",
      `gate-receipt: HEAVY RECEIPT CAME FROM A DIRTY WORKTREE for tree ${tree.slice(0, 12)} — ` +
        `${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ` (+${dirty.length - 5} more)` : ""} had uncommitted ` +
        `content while the suites ran, so they did not measure this tree (juubk). Commit, then re-run ` +
        `\`npm run test:heavy\` with no arguments.`,
      { dirty },
    );
  }
  if (receipt.exitCode !== 0) {
    return refuse(
      "raw-rc",
      `gate-receipt: HEAVY RECEIPT RAN WITH rc ${String(receipt.exitCode)} for tree ${tree.slice(0, 12)} — ` +
        `a certifying receipt must record the raw zero exit of the tier run (juubk).`,
      { exitCode: receipt.exitCode },
    );
  }
  const finishedAt = Number(receipt.finishedAt ?? 0);
  if (!Number.isFinite(finishedAt) || finishedAt <= 0) {
    return refuse(
      "no-timestamp",
      `gate-receipt: HEAVY RECEIPT has no finishedAt timestamp — refusing an undatable receipt (upqhp).`,
    );
  }
  if (finishedAt - now > RECEIPT_FUTURE_SKEW_MS) {
    return refuse(
      "future",
      `gate-receipt: HEAVY RECEIPT IS DATED IN THE FUTURE (finished ${new Date(finishedAt).toISOString()}, ` +
        `now ${new Date(now).toISOString()}) for tree ${tree.slice(0, 12)} — an unverifiable clock is not a ` +
        `freshness proof (juubk).`,
      { finishedAt, now },
    );
  }
  const ageMs = now - finishedAt;
  if (ageMs > maxAgeMs) {
    return refuse(
      "stale",
      `gate-receipt: HEAVY RECEIPT STALE — finished ${Math.round(ageMs / 86400000)}d ago (window ` +
        `${Math.round(maxAgeMs / 86400000)}d) for tree ${tree.slice(0, 12)}. Re-run \`npm run test:heavy\` on this tree (upqhp).`,
      { ageMs, maxAgeMs },
    );
  }
  return { ok: true, reason: "certified", receipt, path };
}
