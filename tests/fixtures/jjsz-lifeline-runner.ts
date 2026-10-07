// tests/fixtures/jjsz-lifeline-runner.ts — chrome-agent-platform-jjsz, security review N1 + N2.
//
// A RUNNER shaped like the tail of scripts/security-suite.ts. It starts a long-lived leader through
// `setsidSpawnSpec`, records `isolatedProcessGroup`, attaches the crash-safe lifeline exactly as
// `launchChrome` does (`attachProcessLifeline` with the leader's group and a `user-data-dir=<profile>`
// treeMatch), waits for the test to say go, then ends the way that script's `finally` does: reap the
// leader and `Deno.exit` at once. tests/jjsz-lifeline-runner-exit.test.ts drives it and plays the
// SUPERVISOR (scripts/security-suite-supervisor.mjs): it samples this process's descendants with the
// real `observeDescendants`, and judges what is left after exit with the real `liveObservedResidue`.
//
//   deno run -A --no-check jjsz-lifeline-runner.ts <reap> <watcher> <then> <dir>
//
//   reap     helper | old     `await reapLeaderAndSettle(leader)` (scripts/lib/reap-leader.ts), or the
//                             pre-N1 shape: kill, await status, nothing else
//   watcher  held | real      held: the production watcher script with its `sleep 0.1;` replaced by a
//                             wait for <dir>/release, so the leader-exit sweep is still running as long
//                             as the test wants (the window is ~110 ms on a quiet box and as long as the
//                             box is loaded; holding it makes the overlap deterministic). real: the
//                             unmodified production watcher.
//   then     exit | relaunch  exit: Deno.exit(0) right after the reap. relaunch: start a SECOND process
//                             whose command line carries `--user-data-dir=<profile>` (the journeys'
//                             phase 2 on the same profile), then wait for <dir>/done.
//   dir      scratch directory: <dir>/go starts the reap, <dir>/release ends a held watcher's wait,
//                             <dir>/done lets a relaunch run finish.
//
// stdout protocol: `READY {leader, watcher, group}` once armed, then `TICK <n>` every 50 ms (the heartbeat) and
// `LEADER_EXITED` the moment the leader's exit is observed, `REAPED` once the reap returned, `SECOND {pid}` after
// the relaunch, `FIXTURE_ERROR {..}` (exit 5) when the setup itself is wrong. TICK and LEADER_EXITED exist so the
// test can assert "the runner has NOT done X yet" without a wall-clock sleep; where they are produced says why.
// Everything is bounded: a go file that never arrives, or a held watcher nobody releases, ends by
// itself, so a failed test cannot leave a long-lived process behind.
import {
  attachProcessLifeline,
  isolatedProcessGroup,
  lifelineState,
  type LifelineSpawnSpec,
  type LifelineWatcher,
  setsidSpawnSpec,
} from "../../scripts/lib/process-tree.ts";
import { reapLeaderAndSettle } from "../../scripts/lib/reap-leader.ts";

const [reap, watcherKind, then, dir] = Deno.args;
if (!["helper", "old"].includes(reap) || !["held", "real"].includes(watcherKind) || !["exit", "relaunch"].includes(then) || !dir) {
  console.error("usage: jjsz-lifeline-runner.ts <helper|old> <held|real> <exit|relaunch> <dir>");
  Deno.exit(64);
}

const GO = `${dir}/go`;
const RELEASE = `${dir}/release`;
const DONE = `${dir}/done`;
const PROFILE = `${dir}/profile`;
/** The production watcher's pause between its TERM and its KILL; the held watcher replaces exactly this. */
const NEEDLE = Deno.env.get("JJSZ_RUNNER_NEEDLE") ?? "sleep 0.1; ";
/** At most 400 * ~55 ms: a held watcher nobody releases finishes on its own. */
const HOLD = 'n=0; while [ ! -e "$CAP_JJSZ_RELEASE" ] && [ "$n" -lt 400 ]; do sleep 0.05; n=$((n+1)); done; ';

// A runner that outlives its own deadline is a leak: end it.
Deno.unrefTimer(setTimeout(() => {
  console.error("fixture: overall deadline reached");
  Deno.exit(4);
}, 150_000));

async function waitForFile(path: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      Deno.statSync(path);
      return true;
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** Spawn the watcher exactly like the default `spawnLifelineWatcher`, with the hold in place of the pause. */
let spawnError = null as Error | null;
function heldWatcher(spec: LifelineSpawnSpec): LifelineWatcher {
  try {
    const script = spec.args[spec.args.length - 1];
    if (script.split(NEEDLE).length !== 2) {
      throw new Error(
        `the lifeline watcher script must contain ${JSON.stringify(NEEDLE)} exactly once: ` +
          `without it the held-watcher replacement is a no-op and this fixture would prove nothing`,
      );
    }
    const held = script.replace(NEEDLE, () => HOLD);
    if (held === script) throw new Error("the held-watcher replacement did not change the watcher script");
    return new Deno.Command(spec.command, {
      args: [...spec.args.slice(0, -1), held],
      stdin: "piped",
      stdout: "null",
      stderr: "null",
      clearEnv: true,
      env: { ...spec.env, CAP_JJSZ_RELEASE: RELEASE },
    }).spawn();
  } catch (e) {
    // `attachProcessLifeline` turns a throwing spawn into a warning and an `unprotected` lifeline;
    // remember the cause so the setup check below can refuse loudly instead.
    spawnError = e as Error;
    throw e;
  }
}

const leaderSpec = setsidSpawnSpec("/bin/sleep", ["300"]);
const leader = new Deno.Command(leaderSpec.command, {
  args: leaderSpec.args,
  stdout: "null",
  stderr: "null",
  clearEnv: true,
}).spawn();

function fixtureError(message: string): never {
  console.log(`FIXTURE_ERROR ${JSON.stringify({ leader: leader.pid, message })}`);
  try { leader.kill("SIGKILL"); } catch { /* already dead */ }
  Deno.exit(5);
}

const group = await isolatedProcessGroup(leader);
if (group === undefined) fixtureError("the leader exited before it was observed");
attachProcessLifeline(
  leader,
  { group, treeMatch: `user-data-dir=${PROFILE}` },
  watcherKind === "held"
    ? { spawn: heldWatcher, sweepTimeoutMs: 30_000, warn: (line) => console.error(`fixture: ${line}`) }
    : {},
);
const lifeline = lifelineState(leader);
if (spawnError) fixtureError(spawnError.message);
if (lifeline?.state !== "armed" || lifeline.watcherPid === null) {
  fixtureError(`the lifeline is not armed: ${JSON.stringify(lifeline?.state)}`);
}

// The runner's own proof of life, for the test's NEGATIVE assertions ("the runner has not reaped yet", "no second
// browser has opened yet"). A sleep in the test cannot tell a runner that is waiting for the sweep from one that is
// starved and has not run at all, and a mutant that skips the wait would pass that sleep for the wrong reason. A
// line the RUNNER printed can tell them apart:
//   * `LEADER_EXITED` comes from a reaction on the leader's `status` registered HERE, before the reap below awaits
//     that same promise. Reactions on one promise run in registration order inside ONE microtask checkpoint, and no
//     timer callback can run inside a checkpoint, so whatever a helper that skips the wait does next (REAPED, the
//     second browser's SECOND, Deno.exit) happens before the first TICK that follows this marker in stdout.
//   * `TICK <n>` comes from a timer, every 50 ms from READY on (unref'd: it never keeps the runner alive, and it is
//     cleared before the exit). The test counts the ticks that arrive AFTER the marker, in stream order.
leader.status.then(() => console.log("LEADER_EXITED"), () => { /* a rejected status announces nothing */ });
let ticks = 0;
const heartbeat = setInterval(() => console.log(`TICK ${++ticks}`), 50);
Deno.unrefTimer(heartbeat);
console.log(`READY ${JSON.stringify({ leader: leader.pid, watcher: lifeline.watcherPid, group })}`);

try {
  if (!(await waitForFile(GO, 45_000))) console.error("fixture: the go file never arrived");
} finally {
  // The shape of scripts/security-suite.ts's `finally`: `cdp.close()`, then this, then the server
  // closes and `Deno.exit`.
  if (reap === "helper") {
    await reapLeaderAndSettle(leader);
  } else {
    try { leader.kill("SIGKILL"); } catch { /* already dead */ }
    try { await leader.status; } catch { /* reaped */ }
  }
}
console.log("REAPED");

if (then === "relaunch") {
  // Phase 2 of a journey: a second browser on the SAME profile. `exec -a` puts the profile in the
  // process's own command line, the way Chrome's flags are, so the sweep's `pkill -f` can see it.
  const second = new Deno.Command("/bin/bash", {
    args: ["-c", 'exec -a "$1" /bin/sleep 300', "_", `jjsz-second-browser --user-data-dir=${PROFILE}`],
    stdout: "null",
    stderr: "null",
    clearEnv: true,
  }).spawn();
  console.log(`SECOND ${JSON.stringify({ pid: second.pid })}`);
  await waitForFile(DONE, 45_000);
  try { second.kill("SIGKILL"); } catch { /* already gone (the sweep killed it) */ }
  try { await second.status; } catch { /* reaped */ }
}
clearInterval(heartbeat);
Deno.exit(0);
