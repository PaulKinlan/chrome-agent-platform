#!/usr/bin/env node
// Check the committed passive export BEFORE refreshing it from the canonical DB.
// This reports disappearing IDs; it never imports or restores issues.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function command(name, args) {
  const result = spawnSync(name, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${name} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`);
  }
  return result.stdout;
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
  const committed = issueIds(command("git", ["show", "HEAD:.beads/issues.jsonl"]), "HEAD:.beads/issues.jsonl");
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
  const candidate = issueIds(args.length ? readFileSync(args[1], "utf8") : command("bd", ["export", "--all"]), "canonical DB export");
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
