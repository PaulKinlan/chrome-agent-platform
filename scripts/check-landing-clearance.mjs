#!/usr/bin/env node
// scripts/check-landing-clearance.mjs — commit-scoped clearance for a landing range
// (chrome-agent-platform-drhi7).
//
// THE HOLE: review clearance in the fleet is recorded per BEAD at the reviewed TIP
// (fleet-verdict writes `cleared:<tip-short>`), and a delta-scoped PASS necessarily
// covers every commit in the reviewed delta. On a linear branch where commit N is
// review-FAILED and N+1 PASSes, the N+1 verdict vouches for code the reviewer was
// not asked about — the t4uvt landing attempt (2026-10-19) carried two review-failed
// ancestors inside its cleared delta. This checker closes exactly that hole:
//
//   node scripts/check-landing-clearance.mjs <base>..<tip> [--json]
//
// It walks every commit in the landing range, extracts the bead id(s) each commit
// names (repo convention: the bead id in the commit subject; the merger's landing
// commits carry a `BEAD:` body line — both are scanned), resolves each bead's
// clearance state from bd, and REFUSES (exit 1) when any ancestor bead is
// review-failed — so commit N's FAILED can never be cleared by N+1's PASS.
//
// What this rung deliberately does NOT do:
//   - It does not demand per-commit clearance for every ancestor. The tip's
//     delta-scoped PASS is the fleet's review model (the reviewer reads the whole
//     delta); unreviewed-but-not-failed ancestors stay covered by it.
//   - It does not touch fleet tooling. fleet-land-message keeps enforcing the tip's
//     own clearance (CURRENT/STALE/DIVERGED/UNRESOLVED/UNPINNED); this is the
//     repo-side range rung the landing ladder runs before the full gate.
//
// Exit codes (repo convention): 0 range clear · 1 review-failed ancestry (named) ·
// 75 environmental (git/bd unusable — never a silent pass).
//
// The pure logic is exported for tests; the CLI is a thin shell over injectable
// runners, so tests/falsifiers need no real git or bd (see
// tests/check-landing-clearance.test.ts).

import { execFileSync } from "node:child_process";

/** Every bead id named in a commit. Two STRUCTURED locations only — the repo convention puts the
 *  id in the subject, and the merger's landing commits carry a `BEAD:` body line. Free-text body
 *  scanning is deliberately NOT done: commit bodies quote lane names (chrome-agent-platform-imp-rec,
 *  -imp-tier) and sibling bead ids in prose, and every quoted name would mint a phantom bead (caught
 *  live on the first real range: bd answered "chrome-agent-platform-imp not found"). */
export function extractBeadIds(text) {
  const ids = new Set();
  const scan = (line) => {
    for (const match of String(line ?? "").matchAll(/chrome-agent-platform-[0-9a-z]+/gi)) {
      ids.add(match[0].toLowerCase());
    }
  };
  const lines = String(text ?? "").split("\n");
  scan(lines[0] ?? ""); // the subject
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*BEAD:\s*/.test(line)) {
      scan(line); // inline form: "BEAD: chrome-agent-platform-xxx"
    } else if (/^\s*BEAD\s*$/.test(line)) {
      scan(lines[i + 1] ?? ""); // the merger's block form: "BEAD\nchrome-agent-platform-xxx - title"
    }
  }
  return [...ids].sort();
}

/** Parse a canonical fleet-verdict comment's token ("VERDICT: PASS…"). Returns
 *  null for non-verdict comments. */
export function verdictTokenOf(commentText) {
  const match = /^\s*VERDICT:\s*(PASS-with-notes|PASS|FAIL)\b/.exec(String(commentText ?? ""));
  return match ? match[1] : null;
}

/**
 * Resolve ONE bead's clearance state from its bd record (labels + comments).
 * fleet-verdict maintains a clean label invariant — each verdict REMOVES the other
 * side's labels — so `review-failed` on the labels means the latest verdict was a
 * FAIL, and `cleared:<sha>` means the latest verdict was a PASS pinned at that sha.
 * The latest VERDICT comment is cross-read as a belt: a FAIL comment on a bead whose
 * labels were hand-cleaned still refuses (drhi7: the verdict, not the bookkeeping,
 * is the evidence).
 *
 * @param {{ labels?: string[], comments?: { text?: string, created_at?: string }[] }} bead
 * @returns {{ state: "failed"|"cleared"|"unreviewed", clearedSha: string|null, verdict: string|null, reason: string }}
 */
export function resolveBeadClearance(bead) {
  const labels = Array.isArray(bead?.labels) ? bead.labels : [];
  const comments = Array.isArray(bead?.comments) ? bead.comments : [];
  const clearedLabel = labels.find((l) => typeof l === "string" && l.startsWith("cleared:"));
  const clearedSha = clearedLabel ? clearedLabel.slice("cleared:".length) : null;
  const reviewFailedLabel = labels.includes("review-failed");

  // Latest verdict token by comment order (bd returns oldest→newest).
  let verdict = null;
  for (const comment of comments) {
    const token = verdictTokenOf(comment?.text);
    if (token) verdict = token;
  }

  const latestVerdictIsFail = verdict === "FAIL";
  if (reviewFailedLabel || latestVerdictIsFail) {
    return {
      state: "failed",
      clearedSha,
      verdict: verdict ?? (reviewFailedLabel ? "FAIL" : null),
      reason: reviewFailedLabel
        ? "bead carries the review-failed label (fleet-verdict records it on FAIL)"
        : "the bead's latest review verdict is FAIL",
    };
  }
  // The merger consumes the clearance at landing: cleared:/merge-queue come off and `merged` goes on
  // (bead CLOSED). A landed bead is the strongest form of cleared — its code shipped.
  if (labels.includes("merged")) {
    return { state: "cleared", clearedSha: null, verdict, reason: "landed on main (merged label supersedes the landing clearance)" };
  }
  if (clearedSha) {
    return { state: "cleared", clearedSha, verdict, reason: `cleared at ${clearedSha}` };
  }
  return {
    state: "unreviewed",
    clearedSha: null,
    verdict,
    reason: verdict
      ? `latest verdict ${verdict} recorded no clearance label`
      : "no review verdict recorded",
  };
}

/**
 * Resolve a whole landing range. Runners are injectable so tests need no git/bd:
 *   runGit(args) -> stdout string   (e.g. ["log", "--format=...", base..tip])
 *   runBd(args)  -> stdout string   (e.g. ["show", id, "--json"])
 * bd/git failures throw; the CLI translates them to the environmental exit.
 *
 * @param {string} base
 * @param {string} tip
 * @param {{ runGit?: (args: string[]) => string, runBd?: (args: string[]) => string }} [io]
 */
export async function resolveRange(base, tip, io = {}) {
  const runGit = io.runGit ?? ((args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const runBd = io.runBd ?? ((args) => execFileSync("bd", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

  const raw = runGit([
    "log",
    "--format=%H%x1f%s%x1f%b%x1e",
    `${base}..${tip}`,
  ]);
  const commits = raw
    .split("\x1e")
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      // Body is everything after the SECOND separator — a multi-line body may itself contain
      // almost anything, so the first two fields are bounded by indexOf, not split.
      const i1 = record.indexOf("\x1f");
      const i2 = record.indexOf("\x1f", i1 + 1);
      const sha = i1 === -1 ? record : record.slice(0, i1);
      const subject = i1 === -1 || i2 === -1 ? "" : record.slice(i1 + 1, i2);
      const body = i2 === -1 ? "" : record.slice(i2 + 1);
      return { sha, subject, body, beads: [] };
    });

  const beadIds = new Map(); // id -> { state, clearedSha, verdict, reason, commits: [] }
  for (const commit of commits) {
    for (const id of extractBeadIds(`${commit.subject}\n${commit.body}`)) {
      commit.beads.push(id);
      if (!beadIds.has(id)) beadIds.set(id, { id, commits: [] });
      beadIds.get(id).commits.push(commit.sha);
    }
  }

  const refusals = [];
  for (const bead of beadIds.values()) {
    let labels = [];
    try {
      labels = JSON.parse(runBd(["show", bead.id, "--json"]))[0]?.labels ?? [];
    } catch (error) {
      // bd answers "Issue ... not found" (nonzero) for an id that names no bead — commit bodies and
      // merge subjects can legitimately name things that are not beads (caught live, drhi7). That is
      // a definitive answer, not an environment failure: skip the id, say so in the report. Any OTHER
      // bd failure (lock contention without an answer, missing binary) stays environmental.
      const message = String(error?.stderr ?? error?.message ?? error);
      if (!/Issue\s+\S+\s+not found/i.test(message)) throw error;
      bead.state = "not-a-bead";
      bead.reason = "bd has no such issue — the id names something other than a bead";
      continue;
    }
    let comments = [];
    try {
      comments = JSON.parse(runBd(["comments", bead.id, "--json"]));
    } catch {
      comments = []; // comments are the belt, labels are the spine — a comments failure must not flip the verdict
    }
    const resolved = resolveBeadClearance({ labels, comments });
    bead.state = resolved.state;
    bead.clearedSha = resolved.clearedSha;
    bead.verdict = resolved.verdict;
    bead.reason = resolved.reason;
    if (resolved.state === "failed") {
      refusals.push({
        bead: bead.id,
        reason: resolved.reason,
        verdict: resolved.verdict,
        commits: bead.commits,
      });
    }
  }

  return {
    base,
    tip,
    commitCount: commits.length,
    commits: commits.map(({ sha, subject, beads }) => ({ sha, subject, beads })),
    beads: [...beadIds.values()].map(({ id, state, clearedSha, verdict, reason, commits: beadCommits }) => ({
      id, state, clearedSha, verdict, reason, commits: beadCommits,
    })),
    refusals,
    clear: refusals.length === 0,
  };
}

async function main(argv) {
  const args = argv.filter((a) => a !== "--json");
  const asJson = argv.includes("--json");
  if (args.length !== 1 || !args[0].includes("..")) {
    console.error("usage: node scripts/check-landing-clearance.mjs <base>..<tip> [--json]");
    process.exit(2);
  }
  const [base, tip] = args[0].split("..", 2);
  let report;
  try {
    report = await resolveRange(base, tip);
  } catch (error) {
    console.error(`CAP_ENVIRONMENTAL_REFUSAL {"reason":"landing-clearance: git/bd unavailable: ${String(error?.message ?? error).replace(/"/g, "'")}"}`);
    console.error(`check-landing-clearance: cannot resolve the range ${base}..${tip} — refusing environmentally (exit 75), never a silent pass (drhi7).`);
    process.exit(75);
  }

  if (asJson) {
    console.log(JSON.stringify(report));
  }
  if (report.refusals.length > 0) {
    for (const refusal of report.refusals) {
      const commitShorts = refusal.commits.map((sha) => sha.slice(0, 11)).join(", ");
      console.error(
        `check-landing-clearance: REFUSING range ${base}..${tip}: bead ${refusal.bead} is review-failed ` +
          `(${refusal.reason}; verdict ${refusal.verdict ?? "n/a"}) and its commit(s) ${commitShorts} are INSIDE the ` +
          `landing range — the tip's PASS does not clear a failed ancestor (drhi7).`,
      );
    }
    console.error(
      `check-landing-clearance: ${report.refusals.length} review-failed bead(s) in range; ` +
        `${report.commitCount} commit(s) scanned. Fix or re-review the failed bead(s), or land a range that excludes them.`,
    );
    process.exit(1);
  }
  if (!asJson) {
    console.log(
      `check-landing-clearance: range ${base}..${tip} clear — ${report.commitCount} commit(s), ` +
        `${report.beads.length} bead(s) named, none review-failed (drhi7).`,
    );
  }
  process.exit(0);
}

// Deno test harness imports this module for the pure functions; only run the CLI under node.
if (typeof Deno === "undefined") {
  main(process.argv.slice(2));
}
