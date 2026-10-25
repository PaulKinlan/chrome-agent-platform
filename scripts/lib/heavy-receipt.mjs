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
import { STEAL_THRESHOLD_PCT } from "./cpu-steal-sampler.mjs";
import { HEAVY_GATE_FILES, QUARANTINED_HEAVY_FILES } from "../test-partition.mjs";
import { ENVIRONMENTAL_REFUSAL_EXIT } from "./environmental-verdict.mjs";

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

/** Terminal per-suite statuses. Only `passed` certifies, and `quarantined` never counts as coverage. */
export const SUITE_STATUSES = Object.freeze(["passed", "failed", "refused", "killed", "unknown", "quarantined"]);

/** Result classes. Only `pass` may certify; everything else is recorded so the ledger is honest. */
export const RECEIPT_RESULTS = Object.freeze(["pass", "fail", "refusal", "subset", "drift"]);

/**
 * The ONE invocation that can produce a certifying receipt (review finding 957s2, round 2).
 *
 * `command` was recorded but never checked, so a receipt could name `echo not-a-heavy-test` beside a
 * perfect ledger and certify. It is now compared EXACTLY, and both sides build it from this constant
 * (`heavyGateCommand`) so the producer and the validator cannot drift apart. Any argv at all — files
 * or flags — is a non-canonical invocation: `filesFor()` ignores flags, so a flag-only run executes
 * the full set while `args` looked empty, which is why the writer now records the RAW argv.
 */
export const CANONICAL_HEAVY_GATE_COMMAND = "deno run -A scripts/heavy-gate.ts";

/** The exact command string for a run, for the receipt and for the check to compare. */
export function heavyGateCommand(args = []) {
  return [CANONICAL_HEAVY_GATE_COMMAND, ...args].join(" ");
}

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
 * The quarantined subset of the enumerated set (chrome-agent-platform-8tgnt).
 *
 * A quarantined suite is still OWED by the tier — it stays in `expectedHeavyFiles()` so a receipt can never
 * pretend it does not exist — but it is excluded from `covered` and must appear in the ledger as
 * `quarantined` with the reason and bead this table declares. Both directions are enforced: an omitted
 * exclusion refuses (the exclusion must be NAMED) and an invented one refuses (a receipt cannot mint an
 * exclusion for a file the repository does not quarantine).
 */
export function quarantinedHeavyFiles() {
  return Object.entries(QUARANTINED_HEAVY_FILES).map(([file, entry]) => ({
    file,
    status: "quarantined",
    reason: entry.reason,
    bead: entry.bead,
    expiresWith: entry.expiresWith ?? null,
  }));
}

/** Files a certifying receipt must report as `passed` — the enumerated set minus the declared quarantines. */
export function certifyingHeavyFiles() {
  return expectedHeavyFiles().filter((file) => !(file in QUARANTINED_HEAVY_FILES));
}

/**
 * ONE human-readable description of what a receipt actually covers (2udrl).
 *
 * The acceptance line is the single line a person reads before landing, so it must not claim more than the receipt
 * holds: a receipt with a quarantined suite covers 20 of 21 and says which suite and which bead excluded it. Before
 * 8tgnt there was no exclusion, so "every enumerated suite passed" was true; with one, it is a lie even though the
 * gate's LOGIC is right.
 */
export function describeReceiptCoverage(receipt) {
  const covered = Array.isArray(receipt?.covered) ? receipt.covered.length : 0;
  const expected = Array.isArray(receipt?.expected) ? receipt.expected.length : 0;
  const declared = Array.isArray(receipt?.quarantined) ? receipt.quarantined : [];
  const rows = declared.length
    ? declared
    : (Array.isArray(receipt?.suites) ? receipt.suites : [])
      .filter((row) => row?.status === "quarantined")
      .map((row) => ({ file: row.file, bead: row.bead ?? QUARANTINED_HEAVY_FILES[String(row.file)]?.bead ?? "unstated-bead" }));
  const skipped = Array.isArray(receipt?.skipped) ? receipt.skipped.length : 0;
  const parts = [`${covered}/${expected} covered`];
  if (rows.length > 0) {
    parts.push(`${rows.length} quarantined: ${rows.map((row) => `${row.file} (${row.bead})`).join(", ")}`);
  }
  parts.push(`${skipped} skips`);
  return parts.join(", ");
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
 * @param {{ file?: string, status?: string, bead?: string, reason?: string }[]} suites
 * @param {string[]} expected
 * @returns {{ ok: boolean, missing: string[], extra: string[], duplicate: string[], bad: { file: string, status: string }[], covered: string[], quarantined: string[], undeclaredQuarantine: string[] }}
 */
export function auditSuiteLedger(suites, expected, { quarantined = QUARANTINED_HEAVY_FILES } = {}) {
  const entries = Array.isArray(suites) ? suites : [];
  const files = entries.map((entry) => (typeof entry?.file === "string" ? entry.file : ""));
  const counts = new Map();
  for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1);
  const missing = expected.filter((file) => !counts.has(file));
  const extra = [...counts.keys()].filter((file) => !expected.includes(file));
  const duplicate = [...counts.entries()].filter(([, count]) => count > 1).map(([file]) => file);
  // 8tgnt: a `quarantined` row is only legitimate when THIS tree declares that exact file with the same bead, and
  // the row carries a reason. Anything else — an undeclared quarantine, a mismatched bead, no stated reason — is a
  // non-passing suite like any other, so a receipt cannot invent coverage relief for itself.
  const quarantinedRows = [];
  const undeclaredQuarantine = [];
  const bad = [];
  for (const entry of entries) {
    const file = String(entry?.file ?? "unknown");
    const status = String(entry?.status ?? "unknown");
    if (status === "quarantined") {
      const declared = quarantined[file];
      if (declared && String(entry?.bead ?? "") === declared.bead && String(entry?.reason ?? "").trim().length > 0) {
        quarantinedRows.push(file);
        continue;
      }
      // A row for a file this tree does NOT quarantine, or one that skips the bead/reason, is a non-passing suite.
      if (!declared) undeclaredQuarantine.push(file);
      bad.push({ file, status });
      continue;
    }
    if (status !== "passed") bad.push({ file, status });
  }
  // A declared quarantine that the ledger does not NAME is a missing row, not silent relief — but only when the
  // caller's expected set actually contains that suite (a narrow expected set, as every unit test uses, says
  // nothing about the quarantined file).
  for (const file of Object.keys(quarantined)) {
    if (expected.includes(file) && !counts.has(file) && !missing.includes(file)) missing.push(file);
  }
  const covered = files.filter((file) => !quarantinedRows.includes(file));
  return {
    ok: missing.length === 0 && extra.length === 0 && duplicate.length === 0 && bad.length === 0,
    missing,
    extra,
    duplicate,
    bad,
    covered,
    quarantined: quarantinedRows,
    undeclaredQuarantine,
  };
}

/**
 * Write a receipt atomically. Called for EVERY outcome — a refusal, a failure, a subset or a drift
 * is recorded too (honest ledger) — but only a complete no-args green run may carry `result: pass`,
 * and a certifying receipt already on disk is never replaced by a weaker one.
 *
 * Write failure THROWS: the producer must not exit 0 when it could not record what it ran, or the
 * gate would later refuse a tree that looked certified to the operator.
 *
 * @param {{ tree: string, treeEnd?: string, commit?: string, result: "pass"|"fail"|"refusal"|"subset"|"drift", conditions?: any,
 *   command?: string, args?: string[], exitCode?: number | null, logPath?: string | null,
 *   suites?: { file: string, phase: string, status: string, bead?: string, reason?: string }[], expected?: string[], dirty?: string[], producer?: string,
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
  conditions = null,
  producer = process.env.FLEET_LANE ?? "unknown",
  startedAt = null,
  finishedAt = Date.now(),
}) {
  if (!RECEIPT_RESULTS.includes(result)) {
    throw new Error(`heavy-receipt: invalid result "${result}" (${RECEIPT_RESULTS.join("|")})`);
  }
  if (!tree) throw new Error("heavy-receipt: a receipt must name the tree it ran on");

  const ledger = auditSuiteLedger(suites, expected);
  const missing = ledger.missing;
  // 8tgnt: `covered` is what the receipt CLAIMS ran. A quarantined row is not coverage, so it is excluded here by
  // construction (auditSuiteLedger returns covered without them), and the quarantine rows are recorded separately so
  // a reader can see exactly which suites this receipt does NOT cover and why.
  const covered = ledger.covered ?? suites.map((s) => s.file);
  const quarantinedRows = (ledger.quarantined ?? []).map((file) => ({
    file,
    reason: QUARANTINED_HEAVY_FILES[file]?.reason ?? null,
    bead: QUARANTINED_HEAVY_FILES[file]?.bead ?? null,
    expiresWith: QUARANTINED_HEAVY_FILES[file]?.expiresWith ?? null,
  }));
  const skipped = ledger.bad.map((entry) => entry.file);
  const complete =
    result === "pass" &&
    ledger.ok &&
    args.length === 0 &&
    command === CANONICAL_HEAVY_GATE_COMMAND &&
    tree === treeEnd &&
    dirty.length === 0;

  // A pass claim that the run cannot support is a defect in the producer, not something to record
  // quietly as a pass: downgrade it here so nothing downstream can be tempted to trust the flag.
  const claimed = result;
  if (result === "pass" && !complete) {
    // Name the CAUSE: a genuine coverage shortfall is a subset, a moved tree is drift, and anything
    // else (non-canonical invocation, dirty worktree, a non-passing suite) is a plain fail. The check
    // refuses all of them, but the recorded reason has to be true.
    result = tree !== treeEnd ? "drift" : missing.length > 0 ? "subset" : "fail";
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
    quarantined: quarantinedRows,
    // tu8w9: the CONDITIONS OF ITS OWN PRODUCTION. A receipt that records only a verdict cannot be
    // audited later for whether the box was starved while the durations were measured, which is the
    // one thing a reader most needs to know before trusting a timing assertion.
    conditions,
    timing: conditions?.steal?.timing ?? "UNKNOWN",
    accountingOnly: conditions?.steal?.timing === "UNMEASURED" && result === "pass",
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
/**
 * What a receipt's OWN steal numbers allow it to certify (chrome-agent-platform-gezg6).
 *
 * tu8w9 made the receipt record the conditions it was produced under. This is the half that consumes
 * them: a functional PASS says the suites ran and passed, and says NOTHING about whether the box was
 * starved while their durations were measured. Measured on this VM on 2026-10-23: average 58.6% steal,
 * peak 87%, 689/698 intervals at or above 20%, while 744/744 parallel files still completed. So:
 *
 *   full            — steal was measured and stayed under the threshold: a timing credential.
 *   accounting-only — the run was marked accounting-only, or its numbers say the box was starved
 *                     (>= threshold sampled), or it carries no usable steal evidence at all.
 *                     Functional completeness is still certified; DURATIONS are not evidence.
 *
 * There is deliberately no third "probably fine" state, and no way to reach `full` without a MEASURED
 * verdict from a run that recorded the numbers: missing data cannot authorise a timing claim, which is
 * the same rule the producer applies (UNKNOWN is never an exception).
 */
export function evaluateStealConditions(receipt) {
  const conditions = receipt?.conditions?.steal ?? null;
  if (!conditions) {
    return {
      outcome: "accounting-only",
      reason: "no-steal-evidence",
      payload: { accountingReason: "no-steal-evidence", timing: null },
    };
  }
  const thresholdPct = Number.isFinite(Number(conditions.thresholdPct)) ? Number(conditions.thresholdPct) : STEAL_THRESHOLD_PCT;
  const maxStealPct = Number.isFinite(Number(conditions.maxStealPct)) ? Number(conditions.maxStealPct) : null;
  const avgStealPct = Number.isFinite(Number(conditions.avgStealPct)) ? Number(conditions.avgStealPct) : null;
  const payload = {
    accountingReason: null,
    timing: conditions.timing ?? null,
    samples: conditions.samples ?? null,
    validSamples: conditions.validSamples ?? null,
    maxStealPct,
    avgStealPct,
    thresholdPct,
    thresholdSource: conditions.thresholdSource ?? null,
  };
  const starved =
    receipt.accountingOnly === true ||
    conditions.timing === "UNMEASURED" ||
    (maxStealPct !== null && maxStealPct >= thresholdPct);
  if (starved) {
    return { outcome: "accounting-only", reason: "starved", payload: { ...payload, accountingReason: "starved" } };
  }
  if (conditions.timing !== "MEASURED" || maxStealPct === null) {
    // UNKNOWN, a missing verdict, or numbers that were never completed: no timing claim either way.
    return { outcome: "accounting-only", reason: "steal-unmeasured", payload: { ...payload, accountingReason: "steal-unmeasured" } };
  }
  return { outcome: "full", reason: "measured", payload };
}

/**
 * @returns {Record<string, any>} verdict: {ok, outcome: "full"|"accounting-only"|"refused", reason, line?, marker?, payload, receipt?, path?, steal?}
 */
export function checkHeavyReceipt(tree, { now = Date.now(), maxAgeMs = DEFAULT_RECEIPT_MAX_AGE_MS, expected = expectedHeavyFiles() } = {}) {
  const path = receiptPath(tree);
  const refuse = (reason, line, payload = {}) => ({
    ok: false,
    outcome: "refused",
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
  // chrome-agent-platform-gutt3: a producer "refusal" receipt is rc 75 BY CONSTRUCTION — the producer
  // maps only ENVIRONMENTAL_REFUSAL_EXIT to result "refusal" — but the classification EARNs it from
  // recorded evidence, not the label: the receipt must itself record rc 75. A receipt labelled
  // "refusal" with any other rc is corrupt or mislabelled and stays a structural refusal (exit 2),
  // which is what keeps a hostile or buggy writer from minting an accounting pass out of a name.
  const environmentalRefusal =
    receipt.result === "refusal" && receipt.exitCode === ENVIRONMENTAL_REFUSAL_EXIT;
  if (receipt.result !== "pass" && !environmentalRefusal) {
    return refuse(
      `not-pass:${receipt.result ?? "unknown"}`,
      `gate-receipt: HEAVY RECEIPT IS NOT A PASS (result "${receipt.result}"` +
        `${receipt.claimed && receipt.claimed !== receipt.result ? `, claimed "${receipt.claimed}"` : ""}) for tree ` +
        `${tree.slice(0, 12)} — a refused, failed, subset or drifted tier run does not certify anything (upqhp/juubk). ` +
        `Fix the tier run, then re-run \`npm run test:heavy\` with no arguments.` +
        `${receipt.result === "refusal" ? " A refusal classifies as accounting-only ONLY when the receipt itself records rc 75 (gutt3); this one does not." : ""}`,
      { result: receipt.result, claimed: receipt.claimed, exitCode: receipt.exitCode },
    );
  }
  // review finding 957s2: the check RECOMPUTES everything the receipt asserts. `complete`, `covered`
  // and `suites` are producer-written fields, and a receipt is exactly the kind of evidence an
  // operator trusts without re-deriving — so an empty ledger beside claimed completion, a subset
  // invocation, or a run whose tree moved must each be refused on their own terms.
  if (receipt.command !== CANONICAL_HEAVY_GATE_COMMAND) {
    return refuse(
      "noncanonical-command",
      `gate-receipt: HEAVY RECEIPT RECORDS A NON-CANONICAL COMMAND for tree ${tree.slice(0, 12)} — ` +
        `found ${JSON.stringify(String(receipt.command))}, expected ${JSON.stringify(CANONICAL_HEAVY_GATE_COMMAND)}. ` +
        `Only that exact no-argument tier invocation certifies (juubk/957s2).`,
      { command: receipt.command ?? null, expectedCommand: CANONICAL_HEAVY_GATE_COMMAND },
    );
  }
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
  // 8tgnt: the quarantine table is CODE in this tree, and the receipt has to agree with it in BOTH directions.
  // (i) A declared quarantine must be ACCOUNTED FOR in the ledger: either as a named `quarantined` row carrying the
  // bead and a reason (the tier skipped it and says so), or as `passed` (a run that did execute it — an older
  // receipt, or a deliberate run of that file — which is more coverage, not less, and must not be retro-invalidated).
  // A row that is present but neither is a non-passing suite and refuses through `bad`. A declared quarantine with NO
  // row at all refuses through `missing` above, so a silent omission cannot read as coverage.
  // (ii) A receipt cannot quarantine a file this tree's table does not name, or a producer could relieve itself
  // of the suites it finds inconvenient.
  if (ledger.undeclaredQuarantine.length > 0) {
    return refuse(
      "undeclared-quarantine",
      `gate-receipt: HEAVY RECEIPT QUARANTINES AN UNDECLARED SUITE for tree ${tree.slice(0, 12)} — ` +
        `${ledger.undeclaredQuarantine.join(", ")}; only QUARANTINED_HEAVY_FILES in scripts/test-partition.mjs ` +
        `can exclude a suite, with the matching bead and a stated reason (8tgnt).`,
      { undeclaredQuarantine: ledger.undeclaredQuarantine },
    );
  }
  // chrome-agent-platform-mv1jw: the receipt's OWN coverage claim has to be internally possible, and the printed
  // numbers must come from THIS recomputation rather than from the receipt's fields. Round 2 of the 8tgnt review
  // proved the gap: a crafted receipt could list the quarantined file in BOTH `covered` and `quarantined`, pass every
  // structural gate, classify accounting-only, and print "21/21 covered, 1 quarantined" — an impossible claim that
  // certified a landing. So: a set cannot be both covered and quarantined, the two sets must partition the
  // enumerated set exactly, and the claimed sets must equal the ones the ledger recomputes.
  const claimedCovered = Array.isArray(receipt.covered) ? receipt.covered.map(String) : [];
  const claimedQuarantined = (Array.isArray(receipt.quarantined) ? receipt.quarantined : [])
    .map((row) => String(row?.file ?? row));
  const overlap = claimedCovered.filter((file) => claimedQuarantined.includes(file));
  if (overlap.length > 0) {
    return refuse(
      "coverage-overlap",
      `gate-receipt: HEAVY RECEIPT CLAIMS A SUITE IS BOTH COVERED AND QUARANTINED for tree ${tree.slice(0, 12)} — ` +
        `${overlap.join(", ")}. A suite either ran or it was excluded; a receipt cannot hold both, and the ` +
        `contradiction makes its coverage numbers meaningless (mv1jw).`,
      { overlap, covered: claimedCovered, quarantined: claimedQuarantined },
    );
  }
  const union = new Set([...ledger.covered, ...ledger.quarantined]);
  const unaccounted = expected.filter((file) => !union.has(file));
  if (union.size !== expected.length || unaccounted.length > 0) {
    return refuse(
      "coverage-incomplete",
      `gate-receipt: HEAVY RECEIPT'S COVERAGE DOES NOT ACCOUNT FOR THE ENUMERATED SET for tree ${tree.slice(0, 12)} — ` +
        `covered ${ledger.covered.length} + quarantined ${ledger.quarantined.length} accounts for ${union.size} of ` +
        `${expected.length}${unaccounted.length ? `; unaccounted: ${unaccounted.join(", ")}` : ""} (mv1jw).`,
      { covered: ledger.covered, quarantined: ledger.quarantined, unaccounted },
    );
  }
  const sameSet = (a, b) => a.length === b.length && a.every((file) => b.includes(file));
  // A receipt written before a field existed makes no claim in it, so the cross-check applies only to claims that
  // are present. Omitting a field cannot gain coverage: the ledger is what certifies and what gets printed.
  const claimsCovered = Array.isArray(receipt.covered);
  const claimsQuarantined = Array.isArray(receipt.quarantined);
  const coverageContradicts =
    (claimsCovered && !sameSet(claimedCovered, ledger.covered)) ||
    (claimsQuarantined && !sameSet(claimedQuarantined, ledger.quarantined));
  if (coverageContradicts) {
    return refuse(
      "contradictory-coverage",
      `gate-receipt: HEAVY RECEIPT'S COVERAGE CONTRADICTS ITS OWN LEDGER for tree ${tree.slice(0, 12)} — ` +
        `it claims covered [${claimedCovered.join(", ")}] / quarantined [${claimedQuarantined.join(", ")}] but the ` +
        `ledger's terminal statuses recompute to covered [${ledger.covered.join(", ")}] / quarantined ` +
        `[${ledger.quarantined.join(", ")}] (mv1jw).`,
      { claimedCovered, claimedQuarantined, ledgerCovered: ledger.covered, ledgerQuarantined: ledger.quarantined },
    );
  }
  // The numbers every human-facing message prints come from HERE, never from the receipt's own fields.
  const coverage = {
    covered: [...ledger.covered],
    quarantined: ledger.quarantined.map((file) => ({ file, bead: QUARANTINED_HEAVY_FILES[file]?.bead ?? "unstated-bead" })),
    expected: [...expected],
    skipped: ledger.bad.map((entry) => entry.file),
  };

  // gutt3: on the environmental-refusal path a wall-clock suite's terminal status IS "refused"
  // (rc 75 by construction), so it is accounted; failed/killed/unknown suites still refuse — a
  // failed suite is a product red no box condition can account for.
  const badSuites = environmentalRefusal
    ? ledger.bad.filter((entry) => entry.status !== "refused")
    : ledger.bad;
  if (badSuites.length > 0) {
    return refuse(
      "incomplete-suites",
      `gate-receipt: HEAVY RECEIPT HAS NON-PASSING SUITES for tree ${tree.slice(0, 12)} — ` +
        `${badSuites.map((entry) => `${entry.file} (${entry.status})`).join(", ")}. A receipt certifies only when ` +
        `every enumerated suite reached "passed" (juubk).`,
      { badSuites },
    );
  }
  // gutt3: the writer sets complete only for certifying passes BY CONSTRUCTION (it is derived from
  // result === "pass"), so on the environmental-refusal path demanding it would be demanding the
  // impossible. The recomputed ledger gates above are the completeness witness there (957s2).
  if (!environmentalRefusal && receipt.complete !== true) {
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
  // gutt3: the environmental path's honest raw rc IS 75 — it is demanded by the classification
  // condition above, so the raw-rc gate only guards the certifying path.
  if (!environmentalRefusal && receipt.exitCode !== 0) {
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
  // chrome-agent-platform-gutt3: an environmental refusal is the BOX, not the CODE. The tier ran,
  // the ledger is complete and terminal (checked above), and rc 75 means a wall-clock suite could
  // not measure — on this VM steal bursts 11-53% during a boot even at load 0.18, so the tier
  // legitimately refuses and classifying that as exit 2 ("nothing usable") would red every gate
  // after the CHECK_CMD flip for a reason no author can fix. Functional completeness is certified
  // (every enumerated suite reached a terminal status, none failed); TIMING is not claimed. A
  // structural problem never reaches this branch: version, tree, treeEnd, canonical command,
  // no-args invocation, exact-set ledger, no failed/killed/unknown suite, clean worktree, rc 75
  // recorded, and a fresh timestamp were each demanded on the way here.
  if (environmentalRefusal) {
    const steal = evaluateStealConditions(receipt);
    const refusedSuites = (Array.isArray(receipt.suites) ? receipt.suites : [])
      .filter((entry) => entry?.status === "refused")
      .map((entry) => String(entry.file));
    const pct = (value) =>
      Number.isFinite(Number(value)) && value !== null ? `${Number(Number(value).toFixed(1))}%` : "not recorded";
    const headline =
      `ACCOUNTING-ONLY: the heavy tier refused environmentally (rc ${ENVIRONMENTAL_REFUSAL_EXIT}` +
      `${refusedSuites.length ? `; refused: ${refusedSuites.join(", ")}` : ""}) on tree ${tree.slice(0, 12)} — receipt claims no timing.`;
    return {
      ok: false,
      outcome: "accounting-only",
      reason: "accounting-only:environmental-refusal",
      headline,
      line:
        `${headline}\n` +
        `  Why: the tier recorded an environmental refusal (rc ${ENVIRONMENTAL_REFUSAL_EXIT}) — a BOX verdict, never a product red (gutt3).\n` +
        `  Steal on the run: avg ${pct(steal.payload.avgStealPct)}, peak ${pct(steal.payload.maxStealPct)}, threshold ${pct(steal.payload.thresholdPct)} (${steal.payload.thresholdSource ?? "source not recorded"}), ` +
        `${steal.payload.validSamples ?? "?"}/${steal.payload.samples ?? "?"} valid sample(s), timing ${steal.payload.timing ?? "not recorded"}.\n` +
        `  Fix the BOX: re-run \`npm run test:heavy\` with no arguments on an idle host for a timing credential.\n` +
        `  Or accept it for ACCOUNTING only: node scripts/gate-receipt.mjs --accept-accounting-only`,
      marker: "HEAVY_RECEIPT_ACCOUNTING_ONLY",
      payload: {
        tree,
        expectedTree: tree,
        outcome: "accounting-only",
        ...steal.payload,
        accountingReason: "environmental-refusal",
        refusedSuites,
        exitCode: receipt.exitCode,
      },
      receipt,
      path,
      coverage,
    };
  }
  // gezg6: structure is not the whole credential. The receipt's own conditions decide whether this is a
  // TIMING credential or only good enough for accounting, and the refusal names the numbers so an
  // operator can tell "no receipt" (exit 2, missing) from "bad box" (exit 3, starved).
  const steal = evaluateStealConditions(receipt);
  if (steal.outcome !== "full") {
    // Numbers, or an honest "not recorded" — never NaN% or undefined%, which read as measurements.
    const pct = (value) =>
      Number.isFinite(Number(value)) && value !== null ? `${String(Number(Number(value).toFixed(1)))}%` : "not recorded";
    const numbers =
      `avg ${pct(steal.payload.avgStealPct)}, peak ${pct(steal.payload.maxStealPct)}, ` +
      `threshold ${pct(steal.payload.thresholdPct)} (${steal.payload.thresholdSource ?? "source not recorded"}), ` +
      `${steal.payload.validSamples ?? "?"}/${steal.payload.samples ?? "?"} valid sample(s), timing ${steal.payload.timing ?? "not recorded"}`;
    const why =
      steal.reason === "starved"
        ? `the receipt's own steal numbers say the box was STARVED`
        : steal.reason === "no-steal-evidence"
          ? `the receipt carries NO steal evidence (produced before tu8w9, or outside the gate)`
          : `the receipt's steal evidence is not a completed measurement (timing ${steal.payload.timing ?? "not recorded"})`;
    // The FIRST line is the verdict a human reads off a red gate, and it must answer the only question
    // that matters at that moment: is this the CODE or the BOX? (coord, 2026-10-24: "the whole value of a
    // distinct code is that a human reading a red gate knows instantly whether to look at the code or the
    // box".) So it is one greppable line: `ACCOUNTING-ONLY: <what the numbers say> on tree <sha> — receipt
    // claims no timing.` The detail follows on its own lines for whoever needs the remedy.
    const headline =
      steal.reason === "starved"
        ? `ACCOUNTING-ONLY: sampled steal ${pct(steal.payload.maxStealPct)} >= ${pct(steal.payload.thresholdPct)} on tree ${tree.slice(0, 12)} — receipt claims no timing.`
        : steal.reason === "no-steal-evidence"
          ? `ACCOUNTING-ONLY: no steal samples recorded on tree ${tree.slice(0, 12)} — receipt claims no timing.`
          : `ACCOUNTING-ONLY: steal unmeasured (${steal.payload.timing ?? "no verdict"}) on tree ${tree.slice(0, 12)} — receipt claims no timing.`;
    return {
      ok: false,
      outcome: "accounting-only",
      reason: `accounting-only:${steal.reason}`,
      headline,
      line:
        `${headline}\n` +
        `  ${why}: ${numbers}.\n` +
        `  Functional completeness (${describeReceiptCoverage(receipt)}) is certified; the DURATIONS from ` +
        `this run are not evidence (tu8w9/gezg6).\n` +
        `  Fix the BOX: re-run \`npm run test:heavy\` with no arguments on an idle host for a timing credential.\n` +
        `  Or accept it for ACCOUNTING only: node scripts/gate-receipt.mjs --accept-accounting-only`,

      marker: "HEAVY_RECEIPT_ACCOUNTING_ONLY",
      payload: { tree, expectedTree: tree, outcome: "accounting-only", ...steal.payload },
      receipt,
      path,
    };
  }
  return { ok: true, outcome: "full", reason: "certified", receipt, path, steal: steal.payload, coverage };
}
