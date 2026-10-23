// Heavy-tier receipts (chrome-agent-platform-upqhp).
//
// The fleet gate command (`npm run build:production && npm test && npm run test:build`) never
// runs `npm run test:heavy`, so once 3hbnd moved the two mega-suites into the heavy tier the
// gate's coverage of them was gone: a clean PASS on main would not execute either suite. The
// design coord ruled (2026-10-23) closes that hole without re-merging ~2300s of endurance into
// every landing:
//
//   (a) every heavy-gate run writes a RECEIPT keyed to the exact git TREE it ran on
//       (tree hash + commit sha + timestamp + result + producer + log path) under the durable
//       root (`~/cap-evidence/heavy-receipts/<tree>.json`) — content-addressed, auditable;
//   (b) the main gate (`npm test`, no CLI files) FAILS CLOSED unless a fresh passing receipt
//       exists for the tree being certified — named refusal, ledger entry, exit 2.
//
// PRODUCER RULE (coord, 2026-10-23, recorded on the bead): whoever holds the merged tip
// produces the receipt, from the worktree that will actually land; a heavy run somewhere else
// is worthless by construction. The receipt records producer and commit so provenance is
// auditable, and the check keys on the tree hash, which is what `npm test` certifies.
//
// The check only binds the GATE form of run-tests (no CLI files), exactly like the coverage
// ledger and the browser prerequisite: inner-loop runs (`npm run test:file -- <file>`) are not
// landings and need no receipt.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { durableDir } from "./durable-root.mjs";

export const RECEIPT_DIR_NAME = "heavy-receipts";
export const RECEIPT_VERSION = 1;

// A receipt for tree T can never be CONTENT-stale (git trees are immutable — a different
// content is a different tree hash), so the age window is operational hygiene, not a
// correctness guarantee: it catches a tier rotting unnoticed while landings somehow reuse
// old receipt files, and it bounds how far back a certification can date. 30 days is
// generous against the nightly full line and per-landing runs; override for drills.
export const DEFAULT_RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function receiptDir() {
  // durableDir mkdir -p's its arguments, so the FILENAME is joined here, never passed in.
  return durableDir(RECEIPT_DIR_NAME);
}

export function receiptPath(tree) {
  return join(receiptDir(), `${tree}.json`);
}

// `git rev-parse HEAD^{tree}` — the content identity of the checked-out tree.
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
 * Write a receipt for a completed heavy-gate run. Called for EVERY outcome: a refusal or a
 * failure is recorded too (honest ledger), but only `result: "pass"` ever certifies — the
 * gate check below requires it.
 * @param {{ tree: string, commit?: string, result: "pass" | "fail" | "refusal", logPath?: string | null, suites?: number | null, producer?: string, startedAt?: number | null, finishedAt?: number }} args
 */
export function writeHeavyReceipt({ tree, commit = "unknown", result, logPath = null, suites = null, producer = process.env.FLEET_LANE ?? "unknown", startedAt = null, finishedAt = Date.now() }) {
  if (result !== "pass" && result !== "fail" && result !== "refusal") {
    throw new Error(`heavy-receipt: invalid result "${result}" (pass|fail|refusal)`);
  }
  const receipt = {
    version: RECEIPT_VERSION,
    tree,
    commit,
    result,
    suites,
    producer,
    host: process.env.HOSTNAME ?? "unknown",
    startedAt,
    finishedAt,
    logPath,
  };
  mkdirSync(receiptDir(), { recursive: true });
  const path = receiptPath(tree);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return { path, receipt };
}

/**
 * The gate-side check (chrome-agent-platform-upqhp): a fresh passing receipt must exist for
 * exactly the tree being certified. Anything else — missing, different tree (key mismatch),
 * non-pass outcome, or older than the window — is a named refusal, never a silent skip.
 * @param {string} tree
 * @param {{ now?: number, maxAgeMs?: number }} [options]
 * @returns {{ ok: boolean, reason: string, line: string, marker?: string, payload?: object, receipt?: object, path?: string }}
 */
export function checkHeavyReceipt(tree, { now = Date.now(), maxAgeMs = DEFAULT_RECEIPT_MAX_AGE_MS } = {}) {
  const path = receiptPath(tree);
  if (!existsSync(path)) {
    return {
      ok: false,
      reason: "missing",
      line:
        `run-tests: HEAVY RECEIPT MISSING for tree ${tree.slice(0, 12)} — the gate does not run the heavy tier, ` +
        `so no fresh passing receipt means the mega-suites are simply not covered (upqhp). ` +
        `Run \`npm run test:heavy\` on THIS tree from the worktree that will land, then re-run the gate.`,
      marker: "HEAVY_RECEIPT_REFUSAL",
      payload: { tree, reason: "missing" },
    };
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: "unreadable",
      line: `run-tests: HEAVY RECEIPT UNREADABLE at ${path} (${error.message}) — refusing rather than guessing.`,
      marker: "HEAVY_RECEIPT_REFUSAL",
      payload: { tree, reason: "unreadable" },
    };
  }
  if (receipt.tree !== tree) {
    return {
      ok: false,
      reason: "tree-mismatch",
      line:
        `run-tests: HEAVY RECEIPT TREE MISMATCH — receipt is for ${String(receipt.tree).slice(0, 12)}, ` +
        `certifying ${tree.slice(0, 12)}. A receipt certifies its exact tree only (upqhp).`,
      marker: "HEAVY_RECEIPT_REFUSAL",
      payload: { tree, receiptTree: receipt.tree, reason: "tree-mismatch" },
    };
  }
  if (receipt.result !== "pass") {
    return {
      ok: false,
      reason: `not-pass:${receipt.result ?? "unknown"}`,
      line:
        `run-tests: HEAVY RECEIPT IS NOT A PASS (result "${receipt.result}") for tree ${tree.slice(0, 12)} — ` +
        `a refused or failed tier does not certify anything. Fix the tier run, then re-run the gate.`,
      marker: "HEAVY_RECEIPT_REFUSAL",
      payload: { tree, result: receipt.result, reason: "not-pass" },
    };
  }
  const finishedAt = Number(receipt.finishedAt ?? 0);
  if (!Number.isFinite(finishedAt) || finishedAt <= 0) {
    return {
      ok: false,
      reason: "no-timestamp",
      line: `run-tests: HEAVY RECEIPT has no finishedAt timestamp — refusing an undatable receipt (upqhp).`,
      marker: "HEAVY_RECEIPT_REFUSAL",
      payload: { tree, reason: "no-timestamp" },
    };
  }
  const ageMs = now - finishedAt;
  if (ageMs > maxAgeMs) {
    return {
      ok: false,
      reason: "stale",
      line:
        `run-tests: HEAVY RECEIPT STALE — finished ${Math.round(ageMs / 86400000)}d ago (window ` +
        `${Math.round(maxAgeMs / 86400000)}d). Re-run \`npm run test:heavy\` on this tree (upqhp).`,
      marker: "HEAVY_RECEIPT_REFUSAL",
      payload: { tree, ageMs, maxAgeMs, reason: "stale" },
    };
  }
  return { ok: true, reason: "certified", receipt, path };
}
