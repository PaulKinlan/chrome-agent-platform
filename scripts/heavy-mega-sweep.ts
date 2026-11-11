#!/usr/bin/env -S deno run -A
// scripts/heavy-mega-sweep.ts — the scheduled sweep for the mega heavy suites (chrome-agent-platform-1lvay (c)).
//
// WHY THIS EXISTS, in the numbers that decided it (measured 2026-11-11 on the fleet VM):
//   The "heavy tier" is three populations with a ~120x cost spread. 18 of its 21 suites cost 19s
//   together, so they now run inside EVERY landing's gate (scripts/run-tests.mjs, per-landing heavy
//   phase) and a red in them is visible within ZERO landings. The other two —
//   tests/python-documents-bundle-3p3e11.test.ts (1416s) and tests/wasm-sync-workspace.test.ts (894s) —
//   cost 2310s together, which is 6.4x the entire full gate. Running those per landing would buy
//   visibility by making every landing slower, and speed is a contract in this repo. So they are swept
//   on a SCHEDULE, and the schedule's job is to make the result IMPOSSIBLE TO MISS:
//     1. write the durable record the landing gate reads, so every receipt says
//        "heavy-mega: NOT RUN at this sha (last green <sha> <age>h)" instead of implying it ran;
//     2. on RED, file a P1 bead automatically — a report someone must read is how main stayed red
//        since lrhyl while every landing certified green.
//
// The bound is the schedule's: run it at least every 24h (see docs/heavy-tier.md), so a mega red
// survives at most one day and is visible as an open P1 bead, not as an absence.
//
//   deno run -A scripts/heavy-mega-sweep.ts            # sweep, record, file P1 on red
//   deno run -A scripts/heavy-mega-sweep.ts --dry-run  # name what would run, touch nothing
//
// Exit: 0 PASS · 1 FAIL (a product red; the P1 is filed) · 75 ENVIRONMENTAL REFUSAL (box too stolen
// to measure — NOT a product red, and the record says so rather than filing a P1 for the box).

import { spawnSync } from "node:child_process";
import { MEGA_HEAVY_FILES } from "./test-partition.mjs";
import { currentCommitSha, writeMegaRecord } from "./lib/heavy-receipt.mjs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENVIRONMENTAL_REFUSAL_EXIT = 75;
const TIMEOUT_MS = Number(Deno.env.get("CAP_HEAVY_MEGA_TIMEOUT_MS") ?? 3_600_000);

function git(args: string[]): string {
  const out = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return (out.stdout ?? "").trim();
}

function runSuite(file: string): { file: string; rc: number; secs: number } {
  const t0 = Date.now();
  const child = spawnSync(
    "deno",
    ["test", "-A", "--config", "deno.runner.jsonc", file],
    { cwd: ROOT, encoding: "utf8", stdio: "inherit", timeout: TIMEOUT_MS, env: { ...Deno.env.toObject(), CAP_TEST_RUNNER: "1" } },
  );
  const secs = Math.round((Date.now() - t0) / 1000);
  // A killed run (ETIMEDOUT) is NOT a pass and NOT a product red: it is an unbounded measurement.
  const rc = child.error ? 124 : (child.status ?? 1);
  return { file, rc, secs };
}

/** One open P1 per tree+verdict, so a nightly red cannot become 30 identical beads. */
function fileP1({ sha, failed }: { sha: string; failed: Array<{ file: string; secs: number }> }) {
  const title = `heavy-mega sweep RED at ${sha.slice(0, 9)}: ${failed.map((f) => f.file).join(", ")}`;
  const existing = spawnSync("bd", ["list", "--label", "heavy-mega-sweep", "--status", "open", "--json"], {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  let open: Array<{ id: string; title?: string }> = [];
  try {
    const parsed = JSON.parse(existing.stdout || "[]");
    open = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    open = [];
  }
  if (open.length) {
    const id = open[0].id;
    spawnSync("bd", ["comment", id, `Re-swept RED at ${sha}: ${failed.map((f) => f.file).join(", ")}`], {
      cwd: ROOT, stdio: "inherit",
    });
    return { created: false, id };
  }
  const body = [
    "Filed automatically by scripts/heavy-mega-sweep.ts (chrome-agent-platform-1lvay (c)).",
    "",
    `The mega heavy suites are NOT part of a landing's gate (2310s measured — 6.4x the full gate), so a`,
    `red in them is only visible through this scheduled sweep. This sweep ran at ${sha} and FAILED:`,
    ...failed.map((f) => `  - ${f.file} (${f.secs}s)`),
    "",
    "WHY IT MATTERS: main was red in a deferred tier since lrhyl and every landing certified green,",
    "because nothing executed the suite. A red here is already merged unless this tree is unlanded.",
    "",
    "NEXT ACTION: run the failing suite by hand on origin/main to confirm it reproduces there, then",
    "either fix it or (if it is machine-dependent) file it against the sweep with the measurement.",
  ].join("\n");
  const created = spawnSync("bd", [
    "create", title, "-t", "bug", "-p", "1", "-l", "heavy-mega-sweep", "-l", "gate-visibility", "-d", body,
  ], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const id = (created.stdout ?? "").match(/chrome-agent-platform-[a-z0-9]+/)?.[0] ?? null;
  return { created: true, id };
}

function main() {
  const dry = Deno.args.includes("--dry-run");
  const sha = currentCommitSha(ROOT) || git(["rev-parse", "HEAD"]);
  if (!sha || sha === "unknown") {
    console.error("heavy-mega-sweep: cannot resolve the commit — refusing to write an unattributable record");
    Deno.exit(2);
  }
  console.log(`heavy-mega-sweep: ${MEGA_HEAVY_FILES.length} suite(s) at ${sha} (bound ${Math.round(TIMEOUT_MS / 1000)}s)`);
  if (dry) {
    for (const f of MEGA_HEAVY_FILES) console.log(`  would run ${f}`);
    return 0;
  }
  const results = MEGA_HEAVY_FILES.map((f) => runSuite(f));
  const failed = results.filter((r) => r.rc !== 0 && r.rc !== ENVIRONMENTAL_REFUSAL_EXIT);
  const envOnly = results.length > 0 && failed.length === 0 && results.some((r) => r.rc === ENVIRONMENTAL_REFUSAL_EXIT);
  // A product red is a red even on a stolen box; only a run that reported nothing usable is environmental.
  const result = failed.length ? "fail" : envOnly ? "environmental" : "pass";
  writeMegaRecord({
    sha,
    result,
    at: Date.now(),
    suites: results.map((r): { file: string; rc: number; secs: number } => ({ file: r.file, rc: r.rc, secs: r.secs })),
    detail: null,
  });
  console.log(`heavy-mega-sweep: ${result.toUpperCase()} (${results.map((r) => `${r.file} rc=${r.rc} ${r.secs}s`).join("; ")})`);
  if (result === "fail") {
    const filed = fileP1({ sha, failed });
    console.log(`heavy-mega-sweep: ${filed.created ? "filed P1" : "commented on existing P1"} ${filed.id ?? "(id unknown)"}`);
    return 1;
  }
  if (result === "environmental") {
    console.error("heavy-mega-sweep: ENVIRONMENTAL REFUSAL — the box could not measure these suites; no P1 filed");
    return ENVIRONMENTAL_REFUSAL_EXIT;
  }
  return 0;
}

if (import.meta.main) Deno.exit(main());
