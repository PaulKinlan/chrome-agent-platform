#!/usr/bin/env node
// scripts/gate.mjs — the FULL landing gate in one command (gate-speed, 2026-10-08/09). `npm run gate` runs
// exactly what the sequential command runs:
//
//   npm run build:production && npm test && npm run test:build
//   (= node build.mjs --target=store; node scripts/run-tests.mjs; deno run -A scripts/build-gate.ts)
//
// — the same three commands, no arguments added or removed, so the same files and the same assertions
// (gateSteps() below is the single list of commands; tests/gate.test.ts pins that both modes run exactly
// it). The one difference is WHERE test:build runs:
//
// OVERLAPPED mode (the default): after build:production, test:build runs in a throwaway sibling
// worktree of the SAME commit, concurrently with npm test in this tree. test:build rewrites
// extension/dist in place, so it can never share npm test's tree, but in its own checkout it can run
// beside it. Measured on the 2-vCPU fleet hub (2026-10-08, branch fleet/gate-speed at fe8a7d74, nice
// 10, hub otherwise lightly loaded): 443 s overlapped vs ~500 s for the sequential command on the same
// commit (496/501/521 s in three runs). Under heavy ambient load (2026-10-09, load 9-14 from fleet
// syncs) the overlap still won (640 s vs 802 s) but test:build itself slowed to ~490 s.
//
// SEQUENTIAL mode (the fallback, announced, never silent): the exact && chain above, in this tree.
// Used when the tree has uncommitted changes to tracked files (a sibling of HEAD would test other
// bytes), when the sibling cannot be created (git worktree add or the node_modules copy fails — disk,
// permissions, anything), or when CAP_GATE_SEQUENTIAL=1. A gate can therefore never pass with the build
// gate skipped: either the sibling ran it, or this tree does.
//
// CLEANUP: the sibling (<durable>/gate-build/<sha12>-<pid>, ~270 MB with its node_modules COPY — never
// a link: a linked node_modules measurably moved a bundle size and would let the sibling's build write
// through into this tree) is removed in a finally, on SIGTERM/SIGINT/SIGHUP (after killing both child
// process groups), and — for the one case no handler can catch, SIGKILL — by the NEXT gate, which
// sweeps every sibling whose owning gate process is gone before it starts (sweepStaleSiblings).
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { durableDir } from "./lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The three commands of the full gate, in order. Both modes run exactly these, with these arguments. */
export function gateSteps() {
  return [
    { name: "build:production", cmd: "node", args: ["build.mjs", "--target=store"] },
    { name: "npm test", cmd: "node", args: ["scripts/run-tests.mjs"] },
    { name: "test:build", cmd: "deno", args: ["run", "-A", "scripts/build-gate.ts"] },
  ];
}

/** Why this run is SEQUENTIAL, or null for the overlapped mode (pure; pinned by tests/gate.test.ts). */
export function sequentialReason({ dirty, env }) {
  if (env.CAP_GATE_SEQUENTIAL === "1") return "CAP_GATE_SEQUENTIAL=1";
  if (dirty) return "the tree has uncommitted changes to tracked files (a sibling of HEAD would test other bytes)";
  return null;
}

/** The gate pid a sibling directory name records, or null for a name this gate did not create. */
export function siblingOwnerPid(name) {
  const m = /^[0-9a-f]{12}-(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** Is `pid` a live process whose command line names `needle` (pid reuse cannot fake an owner)? */
export function pidRuns(pid, needle) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle);
  } catch {
    // No /proc (macOS) or no such process. Without /proc fall back to signal-0 liveness.
    if (existsSync("/proc/self")) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
}

function git(args, cwd = ROOT) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.status === 0 ? r.stdout : (r.stderr || r.stdout || String(r.error ?? ""))).trim() };
}

export function removeSibling(dir) {
  git(["worktree", "remove", "--force", dir]);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  git(["worktree", "prune"]);
}

/** Remove siblings left by gates that no longer exist (a SIGKILLed gate cannot clean up after itself). */
export function sweepStaleSiblings(parent, { isLive = (pid) => pidRuns(pid, "gate.mjs"), remove = removeSibling } = {}) {
  const swept = [];
  for (const name of existsSync(parent) ? readdirSync(parent) : []) {
    const pid = siblingOwnerPid(name.replace(/\.log$/, ""));
    if (pid === null || pid === process.pid || isLive(pid)) continue;
    const path = join(parent, name);
    if (name.endsWith(".log")) rmSync(path, { force: true });
    else remove(path);
    swept.push(name);
  }
  return swept;
}

/**
 * The directory stale siblings live in, or the reason the overlapped mode cannot use one. A durable root
 * that cannot be created (disk full, permissions) is an UNAVAILABLE sibling — the announced sequential
 * fallback — never a crash and never a gate that skips test:build. Pure enough to test directly, so the
 * fallback does not need a "plan only, run nothing" knob that could weaken the gate.
 * @returns {{ parent: string|null, reason: string|null }}
 */
export function resolveSiblingRoot({ name = "gate-build", mk = durableDir, sweep = sweepStaleSiblings, report = (line) => say(line) } = {}) {
  let parent;
  try {
    parent = mk(name);
  } catch (e) {
    return { parent: null, reason: `the ${name} sibling root could not be created (${e?.message ?? e})` };
  }
  try {
    const swept = sweep(parent);
    if (swept.length) report(`gate: removed ${swept.length} sibling(s) left by gate(s) that no longer run: ${swept.join(", ")}`);
  } catch (e) {
    return { parent: null, reason: `stale siblings could not be swept (${e?.message ?? e})` };
  }
  return { parent, reason: null };
}

function say(line) {
  console.log(line);
  console.error(line);
}

// Children to kill if the gate itself is signalled (a killed gate must not orphan a build or a suite).
const children = new Set();

/** Run a command in its own process group, stdio inherited (or to a log); resolves its exit code. */
function run(step, { cwd = ROOT, env = process.env, log = null } = {}) {
  return new Promise((resolve) => {
    const out = log ? createWriteStream(log) : null;
    const child = spawn(step.cmd, step.args, { cwd, env, stdio: log ? ["ignore", "pipe", "pipe"] : "inherit", detached: true });
    children.add(child);
    if (out) {
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
    }
    let settled = false;
    const finish = (rc) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      if (out) out.end();
      resolve(rc);
    };
    child.on("error", (e) => { say(`gate: ${step.name} failed to start: ${e.message}`); finish(1); });
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 + 15 : 1)));
  });
}

/**
 * The QUIET HEAD files this tree's partition declares.
 *
 * A DIRECT import, not a child process: an earlier version asked `node -e "import(...)"` and passed the
 * separator as an escaped newline, which node parsed as a broken one-liner — the listing came back empty
 * and the phase was SKIPPED in silence, which is exactly the defect class this repo bans (a gate that
 * cannot tell you what it did not run). The import cannot fail softly: if scripts/test-partition.mjs is
 * unreadable the gate dies before any step runs.
 */
export async function quietHeadFiles() {
  const { QUIET_HEAD } = await import("./test-partition.mjs");
  return [...QUIET_HEAD];
}

/** Run the quiet-head phase for this tree (0 when there is nothing to run). Refuses (75) if it cannot
 *  get a quiet window; a refusal is the repo's third verdict, never a pass and never a product red. */
async function runQuietHeadPhase() {
  const files = await quietHeadFiles();
  // Say it even when there is nothing to run: a phase that silently does nothing is how the listing
  // bug above went unnoticed through two full gates.
  console.log(`gate: QUIET HEAD — ${files.length} file(s) to measure first: ${files.length ? files.join(", ") : "(none declared)"}`);
  if (!files.length) return 0;
  return await run({ name: "quiet head", cmd: "deno", args: ["run", "-A", "scripts/lib/quiet-head.ts", ...files] });
}

/** Run steps in order, stopping at the first failure (the && chain). */
async function chain(steps, opts) {
  for (const step of steps) {
    const rc = await run(step, opts);
    if (rc !== 0) return { rc, failed: step.name };
  }
  return { rc: 0, failed: null };
}

export async function main(env = process.env) {
  const t0 = Date.now();
  const secs = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
  const [build, test, buildGate] = gateSteps();
  const sha = git(["rev-parse", "HEAD"]).out;
  const status = git(["status", "--porcelain", "--untracked-files=no"]);
  let reason = status.ok ? sequentialReason({ dirty: status.out, env }) : `git status failed: ${status.out}`;

  const root = resolveSiblingRoot();
  const parent = root.parent;
  if (root.reason) reason ??= root.reason;

  const sibling = parent ? join(parent, `${sha.slice(0, 12)}-${process.pid}`) : "";
  const log = `${sibling}.log`;
  let siblingCreated = false;
  const cleanup = () => {
    if (siblingCreated) {
      removeSibling(sibling);
      siblingCreated = false;
    }
  };
  const onSignal = (sig) => {
    for (const child of children) {
      // SIGTERM first: run-tests.mjs handles it by killing its own detached parallel phase.
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && [...children].some((c) => { try { process.kill(-c.pid, 0); return true; } catch { return false; } })) {
      spawnSync("sleep", ["0.1"]);
    }
    for (const child of children) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    }
    cleanup();
    for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeAllListeners(s);
    process.kill(process.pid, sig);
  };
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, onSignal);
  process.on("exit", cleanup);

  try {
    say(`gate: ${sha} — ${gateSteps().map((s) => s.name).join(" + ")}`);
    const buildRc = await run(build);
    if (buildRc !== 0) {
      say(`gate: FAILED — build:production exit ${buildRc} (${secs()})`);
      return buildRc;
    }
    say(`gate: build:production GREEN (${secs()})`);

    if (!reason) {
      const add = git(["worktree", "add", "--detach", "--quiet", sibling, sha]);
      siblingCreated = add.ok || existsSync(sibling);
      if (!add.ok) {
        reason = `the sibling worktree could not be created (${add.out})`;
      } else {
        const cp = spawnSync("cp", ["-a", join(ROOT, "node_modules"), join(sibling, "node_modules")], { encoding: "utf8" });
        if (cp.status !== 0) reason = `node_modules could not be copied into the sibling (${(cp.stderr || String(cp.error ?? "")).trim()})`;
      }
      if (reason) cleanup();
    }

    if (reason) {
      say(`gate: SEQUENTIAL mode — ${reason}. Running npm test then test:build in this tree.`);
      const r = await chain([test, buildGate]);
      say(`gate: ${r.rc === 0 ? "GREEN" : `FAILED at ${r.failed} (exit ${r.rc})`} — sequential, wall ${secs()}`);
      return r.rc;
    }

    // gate-speed: the QUIET HEAD (files whose assertion is a timing contract of the PRODUCT — e.g. 0 long
    // tasks while the built extension boots) runs HERE, before the sibling's build starts, because this is
    // the only moment in an overlapped gate when the box is otherwise idle. npm test is told it is done
    // (CAP_QUIET_HEAD_DONE=1) so the file never runs twice. A refusal (75) is the repo's third verdict:
    // the gate stops and reports it, rather than measuring a saturated box.
    const quietHeadRc = await runQuietHeadPhase();
    if (quietHeadRc !== 0) {
      say(`gate: ${quietHeadRc === 75 ? "ENVIRONMENTAL REFUSAL (exit 75) — the quiet-window measurement could not run on a saturated box; re-run" : `FAILED at quiet head (exit ${quietHeadRc})`} — wall ${secs()}`);
      return quietHeadRc;
    }

    say(`gate: OVERLAPPED mode — test:build runs in ${sibling} (log ${log}) beside npm test here`);
    // The sibling reproduces this tree's state before test:build (a store build of the same commit), then
    // runs test:build ONE tree at a time: it already runs beside npm test, and a second sibling would
    // only add contention on a 2-vCPU box.
    const siblingDone = chain([build, buildGate], { cwd: sibling, env: { ...env, CAP_BUILD_GATE_ONE_TREE: "1" }, log })
      .then((r) => {
        say(`gate: test:build (sibling) ${r.rc === 0 ? "GREEN" : `FAILED at ${r.failed} (exit ${r.rc})`} at ${secs()}`);
        return r.rc;
      });
    const testRc = await run(test, { env: { ...env, CAP_QUIET_HEAD_DONE: "1" } });
    say(`gate: npm test ${testRc === 0 ? "GREEN" : `FAILED (exit ${testRc})`} at ${secs()}`);
    const siblingRc = await siblingDone;
    say(`\ngate: ---- test:build output (sibling worktree; log ${log}) ----`);
    if (existsSync(log)) process.stdout.write(readFileSync(log, "utf8"));
    say("gate: ---- end of test:build output ----");
    const rc = testRc !== 0 ? testRc : siblingRc;
    say(`gate: ${rc === 0 ? "GREEN" : "FAILED"} — npm test exit ${testRc}, test:build exit ${siblingRc}, overlapped, wall ${secs()}`);
    return rc;
  } finally {
    cleanup();
    process.removeListener("exit", cleanup);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exit(await main());
}
