#!/usr/bin/env node
// Check the committed passive export BEFORE refreshing it from the canonical DB.
// This reports disappearing IDs; it never imports or restores issues.
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const COMMAND_TIMEOUT_MS = 30_000;

// No fixed stdout ceiling (chrome-agent-platform-re8v7). This used to be
// `spawnSync(..., { maxBuffer: 16 * 1024 * 1024 })`, so the moment the committed
// export passed 16 MiB (16,827,057 B on 2026-10-17) `git show
// HEAD:.beads/issues.jsonl` died with ENOBUFS and the pre-commit hook refused
// every lane's commit. A bigger constant only moves that date: the export grows
// with every bead, so stdout is collected from the stream and the read is bounded
// by wall clock, not by a number that has to be re-guessed per landing. This file
// stays dependency-free on purpose — scripts/git-hooks/pre-commit's fixture test
// copies it into a scratch repo (tests/beads-precommit-hook.test.ts), where a
// relative import of a scripts/lib helper would not resolve.
function command(name, args) {
  return new Promise((resolve, reject) => {
    const out = [];
    const err = [];
    const child = spawn(name, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      reject(new Error(`${name} ${args.join(" ")} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${name} ${args.join(" ")} failed: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(err).toString("utf8").trim();
        reject(new Error(`${name} ${args.join(" ")} failed: ${stderr || `exit ${code}`}`));
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}

function issueIds(jsonl, label) {
  const ids = new Set();
  for (const [index, line] of jsonl.split("\n").entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error(`${label}:${index + 1}: invalid JSON`); }
    if (row?._type !== "issue") continue;
    if (typeof row.id !== "string" || !row.id || ids.has(row.id)) {
      throw new Error(`${label}:${index + 1}: missing or duplicate issue id`);
    }
    ids.add(row.id);
  }
  if (!ids.size) throw new Error(`${label}: no issue IDs; refusing to compare an empty export`);
  return ids;
}

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--candidate" || !args[1])) {
    throw new Error("usage: check-beads-export-divergence.mjs [--candidate <export.jsonl>]");
  }
  const committed = issueIds(await command("git", ["show", "HEAD:.beads/issues.jsonl"]), "HEAD:.beads/issues.jsonl");
  let onDisk = new Set();
  try {
    const contents = readFileSync(".beads/issues.jsonl", "utf8");
    if (contents.trim()) onDisk = issueIds(contents, ".beads/issues.jsonl");
    else console.error("[beads-export] on-disk export empty; checking committed snapshot before regeneration");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error; // malformed nonempty exports are not safe to overwrite
    console.error("[beads-export] on-disk export missing; checking committed snapshot before regeneration");
  }
  const protectedIds = new Set([...committed, ...onDisk]);
  const candidate = issueIds(args.length ? readFileSync(args[1], "utf8") : await command("bd", ["export", "--all"]), "canonical DB export");
  const missing = [...protectedIds].filter((id) => !candidate.has(id)).sort();
  // A narrowly recorded, single-command exception lets an owner intentionally
  // delete a reviewed record without disabling the hook for every later commit.
  const approved = process.env.CAP_BEADS_EXPORT_APPROVED_REMOVALS ?? "";
  const decision = process.env.CAP_BEADS_EXPORT_DECISION_BEAD ?? "";
  if (approved || decision) {
    const ids = approved.split(",");
    if (!decision || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(decision) ||
        !ids.length || ids.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) ||
        new Set(ids).size !== ids.length || ids.length !== missing.length ||
        ids.some((id) => !missing.includes(id))) {
      throw new Error("reconciliation override must name exactly the missing IDs and a decision bead; see docs/BEADS-EXPORT-DIVERGENCE.md");
    }
    console.error(`[beads-export] explicit reconciliation under ${decision}: ${missing.join(", ")}; verify the owner decision recorded on that bead`);
  } else if (missing.length) {
    console.error(`[beads-export] ${missing.length} committed/on-disk issue ID(s) absent from the canonical DB; refusing to overwrite the export:`);
    for (const id of missing) console.error(`  ${id}`);
    console.error("Investigate deletion vs loss in Beads/Dolt history. Import only individually after owner review; never bulk-restore from the passive export.");
    process.exitCode = 1;
  } else {
    console.log(`[beads-export] OK: all ${protectedIds.size} committed/on-disk issue IDs exist in the canonical DB (${candidate.size} IDs).`);
  }
} catch (error) {
  console.error(`[beads-export] cannot verify committed IDs: ${error?.message ?? error}`);
  process.exitCode = 1;
}
