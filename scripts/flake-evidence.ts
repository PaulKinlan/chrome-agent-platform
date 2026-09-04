// scripts/flake-evidence.ts — chrome-journeys parity evidence (the final
// review's MEDIUM): runs the FULL chrome-journeys suite N times per side
// (this branch + the pristine base via a detached worktree), capturing the
// complete log, commit hash, exact command, and timestamp of every run into
// test-artifacts/flake-evidence/ + an index.json. Retained in-repo so the
// 117/119 parity claim is auditable without trusting prose.
//
//   deno run -A scripts/flake-evidence.ts [runsPerSide=4]
// @ts-nocheck — orchestration script (dynamic types).

import { ensureDir } from "https://deno.land/std@0.224.0/fs/ensure_dir.ts";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const RUNS = Number(Deno.args[0] ?? 4);
const OUT = `${ROOT}test-artifacts/flake-evidence`;
await ensureDir(OUT);

const run = (cmd, args, opts = {}) =>
  new Deno.Command(cmd, { args, cwd: ROOT, stdout: "piped", stderr: "piped", ...opts }).output();

const gitOut = async (args) =>
  new TextDecoder().decode((await run("git", args)).stdout).trim();

const branchCommit = await gitOut(["rev-parse", "HEAD"]);
const branchName = await gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
const baseCommit = await gitOut(["merge-base", "HEAD", "origin/main"]);

// A detached worktree at the BASE for clean-base runs. DURABLE scratch (disk,
// bead chp): a full worktree + npm install on RAM-backed /tmp is exactly the
// inode/space pressure this bead removes.
const scratchBase = durableDir("scratch");
const baseDir = await Deno.makeTempDir({ dir: scratchBase, prefix: "cap-flake-base-" });
await run("git", ["worktree", "add", "--detach", baseDir, baseCommit]);
// The base worktree has no built artifacts (dist/ + bundles are gitignored) —
// build it once so its runs are equivalent to the branch's.
console.log("building the BASE worktree (it has no dist)…");
const baseBuildEnv = { PATH: Deno.env.get("PATH") ?? "", HOME: Deno.env.get("HOME") ?? "" };
const npmInstall = await new Deno.Command("npm", { args: ["install", "--no-fund", "--no-audit"], cwd: baseDir, env: baseBuildEnv, stdout: "piped", stderr: "piped" }).output();
if (!npmInstall.success) throw new Error("base npm install failed: " + new TextDecoder().decode(npmInstall.stderr).slice(0, 300));
const baseBuild = await new Deno.Command("npm", { args: ["run", "build"], cwd: baseDir, env: baseBuildEnv, stdout: "piped", stderr: "piped" }).output();
if (!baseBuild.success) throw new Error("base build failed: " + new TextDecoder().decode(baseBuild.stderr).slice(0, 300));

const index = {
  generatedAt: new Date().toISOString(),
  branch: { name: branchName, commit: branchCommit },
  base: { commit: baseCommit, detachedWorktree: baseDir },
  command: "deno run -A scripts/chrome-journeys.ts",
  runsPerSide: RUNS,
  runs: [],
};

async function oneRun(side: "branch" | "base", n: number) {
  const cwd = side === "branch" ? ROOT : baseDir;
  const commit = side === "branch" ? branchCommit : baseCommit;
  const startedAt = new Date().toISOString();
  console.log(`[${side} ${n}/${RUNS}] running chrome-journeys…`);
  const t0 = Date.now();
  const res = await new Deno.Command("deno", {
    args: ["run", "-A", "scripts/chrome-journeys.ts"],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const durationMs = Date.now() - t0;
  const log = new TextDecoder().decode(res.stdout) + "\n--- stderr ---\n" + new TextDecoder().decode(res.stderr);
  const pass = /passed/.exec(log)?.[0] ?? "?";
  const fails = [...log.matchAll(/^FAIL: (.+)$/gm)].map((m) => m[1]);
  const file = `${OUT}/${side}-${n}.log`;
  const header = `# side: ${side}\n# commit: ${commit}\n# command: deno run -A scripts/chrome-journeys.ts\n# startedAt: ${startedAt}\n# durationMs: ${durationMs}\n# cwd: ${cwd}\n\n`;
  await Deno.writeTextFile(file, header + log);
  const entry = { side, run: n, commit, startedAt, durationMs, result: /(\d+)\/(\d+) passed/.exec(log)?.[0] ?? "unknown", failures: fails, log: file };
  index.runs.push(entry);
  console.log(`[${side} ${n}/${RUNS}] ${entry.result} failures=[${fails.join(", ")}]`);
  return entry;
}

try {
  for (let i = 1; i <= RUNS; i++) await oneRun("branch", i);
  for (let i = 1; i <= RUNS; i++) await oneRun("base", i);
} finally {
  await Deno.writeTextFile(`${OUT}/index.json`, JSON.stringify(index, null, 2));
  await run("git", ["worktree", "remove", "--force", baseDir]);
}

const branchFails = index.runs.filter((r) => r.side === "branch").map((r) => r.failures.join("|"));
const baseFails = index.runs.filter((r) => r.side === "base").map((r) => r.failures.join("|"));
const identical = JSON.stringify(branchFails) === JSON.stringify(baseFails) && branchFails.length > 0;
const summary = { identicalFailuresOnBothSides: identical, branch: branchFails, base: baseFails };
await Deno.writeTextFile(`${OUT}/summary.json`, JSON.stringify({ ...summary, index: `${OUT}/index.json` }, null, 2));
console.log("\nsummary:", JSON.stringify(summary, null, 2));
// A real exit code (CAP-FB-20260830-SUITE-HONESTY-01): 0 only when the branch
// introduced no failure — every branch run was clean, or the branch's failure
// set is identical to the base's (a pre-existing flake, which is what this
// tool exists to prove). Anything else — a branch-only failure, or no runs —
// is 1. It used to exit 0 unconditionally.
const branchClean = branchFails.length > 0 && branchFails.every((f) => f === "");
Deno.exit(branchClean || identical ? 0 : 1);
