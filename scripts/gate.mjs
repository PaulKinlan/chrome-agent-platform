#!/usr/bin/env node
// scripts/gate.mjs — the FULL landing gate in one command, with the build-behaviour gate OVERLAPPED
// (gate-speed, 2026-10-08). `npm run gate` runs exactly what
//   npm run build:production && npm test && npm run test:build
// runs — the same files, the same runners, nothing skipped — but test:build runs in a throwaway
// sibling worktree of the SAME commit, concurrently with npm test, instead of after it.
//
// WHY: test:build is 3 files of real in-place production builds (~120 s) and each build uses about
// ONE core; npm test's phases cannot share a tree with it (it rewrites extension/dist in place). In
// its own checkout of HEAD it can run beside npm test, so the gate's wall time is roughly
// max(npm test, test:build) on a box that was otherwise leaving a core idle during the builds.
//
// HOW (each step fails the gate loudly; nothing is retried):
//   1. node build.mjs --target=store in THIS tree (the npm test serial phase requires a current
//      store dist) — exactly `npm run build:production`.
//   2. git worktree add --detach <durable>/gate-build/<sha>-<pid> HEAD; node_modules is COPIED
//      (cp -a, ~110 MB — never symlinked or hard-linked: a symlinked node_modules measurably moved a
//      bundle size, and a hard link would let the sibling's build write through into this tree).
//   3. Concurrently: `node scripts/run-tests.mjs` here, and in the sibling
//      `node build.mjs --target=store && deno run -A scripts/build-gate.ts` (the same steady state
//      test:build finds after npm test today: a store dist built from HEAD).
//   4. Both are awaited; the gate exits non-zero if either failed, naming which. The sibling's whole
//      output is replayed (and kept in a durable log) so its attribution is not lost.
//   5. The sibling worktree is removed (git worktree remove --force) in a finally.
// A DIRTY tree is refused up front: the sibling can only test committed bytes, so a gate over a
// dirty tree would test two different trees.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function git(args, cwd = ROOT) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// Children to kill if the gate itself is signalled (a killed gate must not orphan a build or a suite).
const children = new Set();

function say(line) {
  console.log(line);
  console.error(line);
}

/** Run a command, inheriting stdio; resolves its exit code. */
function run(cmd, args, { cwd = ROOT, env = process.env, stdio = "inherit" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio, detached: true });
    children.add(child);
    child.on("close", () => children.delete(child));
    child.on("error", (e) => { say(`gate: ${cmd} failed to start: ${e.message}`); resolve(1); });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 + 15 : 1)));
  });
}

/** The sibling's build gate, output captured to a durable log (replayed at the end). */
function runSibling(dir, log) {
  return new Promise((resolve) => {
    const out = createWriteStream(log);
    const script = "node build.mjs --target=store && deno run -A scripts/build-gate.ts";
    const child = spawn("bash", ["-c", script], { cwd: dir, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    children.add(child);
    child.on("close", () => children.delete(child));
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("error", (e) => { out.end(`\ngate: sibling failed to start: ${e.message}\n`); resolve(1); });
    child.on("close", (code, signal) => { out.end(); resolve(code ?? (signal ? 128 + 15 : 1)); });
  });
}

export async function main() {
  const t0 = Date.now();
  const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) {
    say(`gate: REFUSED — the tree has uncommitted changes to tracked files; the overlapped build gate can only test COMMITTED bytes:\n${dirty}`);
    return 2;
  }
  const sha = git(["rev-parse", "HEAD"]);
  say(`gate: ${sha} — build:production, then npm test here BESIDE test:build in a sibling worktree of the same commit`);

  const buildRc = await run("node", ["build.mjs", "--target=store"]);
  if (buildRc !== 0) {
    say(`gate: FAILED — build:production exit ${buildRc} (${secs()})`);
    return buildRc;
  }
  say(`gate: build:production GREEN (${secs()})`);

  const parent = durableDir("gate-build");
  const sibling = join(parent, `${sha.slice(0, 12)}-${process.pid}`);
  // A signalled gate kills both process GROUPS (the suite and the sibling build each lead their own),
  // removes the sibling worktree, and dies of the same signal.
  const onSignal = (sig) => {
    for (const child of children) {
      // SIGTERM, not SIGKILL: run-tests.mjs handles SIGTERM by killing its own detached parallel phase.
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
    }
    spawnSync("git", ["worktree", "remove", "--force", sibling], { cwd: ROOT });
    spawnSync("git", ["worktree", "prune"], { cwd: ROOT });
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    process.kill(process.pid, sig);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const log = `${sibling}.log`;
  let siblingRc = 1;
  let testRc = 1;
  try {
    git(["worktree", "add", "--detach", "--quiet", sibling, sha]);
    const cp = spawnSync("cp", ["-a", join(ROOT, "node_modules"), join(sibling, "node_modules")], { encoding: "utf8" });
    if (cp.status !== 0) throw new Error(`copying node_modules into the sibling failed: ${cp.stderr}`);
    say(`gate: test:build runs in ${sibling} (log: ${log})`);
    const siblingDone = runSibling(sibling, log).then((rc) => {
      say(`gate: test:build (sibling) ${rc === 0 ? "GREEN" : `FAILED exit ${rc}`} at ${secs()}`);
      return rc;
    });
    testRc = await run("node", ["scripts/run-tests.mjs"]);
    say(`gate: npm test ${testRc === 0 ? "GREEN" : `FAILED exit ${testRc}`} at ${secs()}`);
    siblingRc = await siblingDone;
    say(`\ngate: ---- test:build output (sibling worktree, ${log}) ----`);
    if (existsSync(log)) process.stdout.write(readFileSync(log, "utf8"));
    say(`gate: ---- end of test:build output ----`);
  } catch (e) {
    say(`gate: FAILED to set up the sibling worktree: ${e?.message ?? e}`);
    siblingRc = siblingRc || 1;
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", sibling], { cwd: ROOT });
    spawnSync("git", ["worktree", "prune"], { cwd: ROOT });
  }
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGINT", onSignal);
  const rc = testRc !== 0 ? testRc : siblingRc;
  say(`gate: ${rc === 0 ? "GREEN" : "FAILED"} — npm test exit ${testRc}, test:build exit ${siblingRc}, wall ${secs()}`);
  return rc;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exit(await main());
