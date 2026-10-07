// deno-lint-ignore-file no-explicit-any
// tests/jjsz-lifeline-runner-exit.test.ts — chrome-agent-platform-jjsz, security review N1 (Medium) + N2 (Low).
//
// THE FINDING. The lifeline (scripts/lib/process-tree.ts, `attachProcessLifeline`) sweeps when its leader
// exits: the watcher shell runs `kill -TERM -$group; sleep 0.1; kill -KILL -$group; pkill -9 -f
// '<profile>( |$)'`, so it is alive for at least ~110 ms AFTER the leader died. A runner that does
// `proc.kill(...); await proc.status` and then exits or goes on does not wait for it:
//   N1  scripts/security-suite.ts exits within milliseconds. The real supervisor
//       (scripts/security-suite-supervisor.mjs) samples the runner's descendants every 20 ms, takes one more
//       sample after the runner exits and calls `liveObservedResidue` on what it saw: an observed watcher
//       that is still alive is RESIDUE, exit 70 ("descendant-residue"). origin/main's lifeline is DISARMED
//       the moment its leader exits (`proc.status.then(disarm, disarm)`): it never sweeps, so nothing
//       lingers. The leader-exit SWEEP is what this work added, so the regression is the sweep's.
//   N2  scripts/page-actions-journey.ts and scripts/keyless-first-result.ts kill the browser that
//       materialised the profile and open a SECOND browser on the SAME profile 700/800 ms later, and so does
//       scripts/security-injection.ts, with no pause at all (found by the round-3 security review; a count of
//       `launchChrome(` call sites cannot show it, because its one call site sits in a `boot()` the script
//       runs twice). A sweep still running then ends with `pkill -9 -f 'user-data-dir=<profile>( |$)'`, which
//       matches the second browser. Measured on the real script with Chrome for Testing on macOS: the second
//       boot never came up in 3 runs of 3 before the fix (two "Chrome never printed a DevTools endpoint", one
//       EPERM out of the killed launch's own teardown), against 3 of 3 on origin/main (which never sweeps) and 3
//       of 3 with the helper.
// The fix is `reapLeaderAndSettle` (scripts/lib/reap-leader.ts): kill, reap, then wait for the sweep.
//
// WHAT IS PROVEN, AND HOW.
//   * `npm run test:security` cannot run end to end on every box (on macOS the Deno runner's `fstatSync(9)` on
//     the inherited lock fd throws EBADF, so the runner refuses before it launches anything). The behaviour is
//     therefore proven against a fixture RUNNER (tests/fixtures/jjsz-lifeline-runner.ts) shaped like
//     security-suite.ts's tail, with THIS file playing the supervisor and calling the REAL custody functions
//     `observeDescendants` and `liveObservedResidue` (scripts/security-suite-custody.mjs).
//   * The fixture's watcher is HELD: the production script with only its `sleep 0.1;` replaced by a wait for a
//     release file. On a quiet box the real window is ~110 ms, so whether the old shape's failure shows depends
//     on how long `ps` takes (how often, on a quiet box, was not measured); holding the sweep makes the overlap
//     deterministic, and a loaded box produces that overlap anyway. One test uses the unmodified watcher and is
//     labelled a SMOKE test: it cannot tell the two shapes apart reliably, so it pins nothing.
//   * Every behavioural claim has a POSITIVE CONTROL: the same run with the pre-fix shape must show the harm
//     (N1: the real judge reports the watcher; N2: the second browser dies). Without it a green "no residue"
//     proves only that the harness cannot see residue.
//   * The two NEGATIVE windows (N1: "the runner is still blocked in the helper", N2: "no second browser has
//     opened yet") are not wall-clock sleeps. A sleep in this process cannot tell a runner that waited for the
//     sweep from a runner that was starved and has not run yet: a mutant that skips the wait would pass it. The
//     fixture prints a `LEADER_EXITED` marker and a 50 ms `TICK` heartbeat, and the assertion is made only after
//     the RUNNER has printed NEGATIVE_WINDOW_TICKS ticks past the marker (`afterLeaderExit`).
//   * The call-site pins parse the four scripts (esbuild strips the types, acorn parses what is left): an
//     import is not a call site. Each pin is checked against mutants of the REAL source text inside this file
//     (the same checker must reject them), so the net is proven on every run. The converse needs its own pin: a
//     call site is not an import, and with the import deleted the call is an unbound name that throws only when a
//     real run reaches it (a drill of exactly that survived every call-site pin). The binding pin at the end of
//     the file requires `import { reapLeaderAndSettle } from "./lib/reap-leader.ts"`, once, under that name, and
//     that nothing else in the script declares that name or its numbered form (esbuild drops an import whose
//     only use a shadow covers, and renames a shadow when the import stays used; both happen to be caught by
//     other pins, but they are properties of the transform, so the declaration count is its own rule).
//
// THE PINS ARE PER-SITE, NOT A RULE. They prove these four scripts go through the helper. The rule ("a runner
// that kills its leader and then exits or relaunches goes through `reapLeaderAndSettle` or `teardownChrome`")
// is stated in scripts/lib/reap-leader.ts; proving a RULE needs a fresh-instance mutant (a new runner with the
// old shape that the test then has to catch), and this file does not catch one. That is not hypothetical:
// scripts/security-injection.ts was a fresh instance that every earlier pin missed, and it was found by a
// reviewer reading the code, not by a gate (bead 80yqb keeps the structural fix open: make `launchChrome`
// wait for an in-flight sweep on its own profile, which removes the class for every caller). The acceptance
// scripts that still end with a bare `proc.kill(...); await proc.status` and then exit are outside it on
// purpose: no supervisor judges them and nothing relaunches on their profile, so their watcher finishes alone.
// The end-of-script `finally` of the two journeys is the same shape and is left alone for the same reason;
// only the phase-1 to phase-2 boundary, which has a relaunch, is pinned.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import * as acorn from "npm:acorn";
import { stop, transform } from "npm:esbuild@0.25.12";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { liveObservedResidue, observeDescendants, readProcIdentity } from "../scripts/security-suite-custody.mjs";
import { attachProcessLifeline, lifelineState, processGroup, setsidSpawnSpec } from "../scripts/lib/process-tree.ts";
import { reapLeaderAndSettle } from "../scripts/lib/reap-leader.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/jjsz-lifeline-runner.ts", import.meta.url));

// ── shared helpers ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until `pred` holds; a timeout THROWS naming what was awaited (never a silent pass). */
async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, what: string, step = 20): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(step);
  }
  if (await pred()) return;
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

/** `promise`, or a rejection after `ms`; the timer is always cleared (a timer left pending fails the leak sanitizer). */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A live (non-zombie) process. `processGroup` THROWS when the table cannot be read, so a blind probe never reads as gone. */
function alive(pid: number): boolean {
  const row = processGroup(pid);
  return row !== null && row.state !== "Z";
}

function spawnLeader(binary: string, args: string[]): Deno.ChildProcess {
  const spec = setsidSpawnSpec(binary, args);
  return new Deno.Command(spec.command, { args: spec.args, stdout: "null", stderr: "null", clearEnv: true }).spawn();
}

async function reapQuietly(proc: Deno.ChildProcess): Promise<void> {
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
  await proc.status.catch(() => {});
}

const exists = (path: string): boolean => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};

// ── the helper's own contract (no fixture) ──────────────────────────────────

Deno.test("jjsz helper: kills with SIGKILL by default, waits until the leader is reaped, and resolves with no lifeline attached", async () => {
  const leader = spawnLeader("/bin/sleep", ["300"]);
  try {
    assert(alive(leader.pid), "the leader starts alive");
    assertEquals(lifelineState(leader), undefined, "this leader has no lifeline: there is no sweep to wait for");
    assertEquals(
      await within(reapLeaderAndSettle(leader), 15_000, "the helper to kill the leader, reap it and resolve"),
      undefined,
    );
    assertEquals((await leader.status).signal, "SIGKILL", "the default signal is SIGKILL (the old security-suite shape)");
    assertEquals(processGroup(leader.pid), null, "the leader is reaped, not a zombie, by the time the helper resolves");
  } finally {
    await reapQuietly(leader);
  }
});

/** A leader that traps SIGTERM and exits 42, and says so with a marker file once the trap is installed. */
function trappingLeader(marker: string): Deno.ChildProcess {
  return new Deno.Command("/bin/sh", {
    args: ["-c", 'trap "exit 42" TERM; : > "$1"; while :; do /bin/sleep 0.1; done', "_", marker],
    stdout: "null",
    stderr: "null",
    clearEnv: true,
  }).spawn();
}

Deno.test("jjsz helper: an explicit signal is honoured (the journeys send SIGTERM so Chrome can flush its profile); the default is SIGKILL", async () => {
  const scratch = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "jjsz-reap-signal-" });
  const spawned: Deno.ChildProcess[] = [];
  try {
    const termed = trappingLeader(`${scratch}/termed`);
    spawned.push(termed);
    await waitFor(() => exists(`${scratch}/termed`), 10_000, "the first leader to install its SIGTERM trap");
    await within(reapLeaderAndSettle(termed, "SIGTERM"), 15_000, "the helper to deliver SIGTERM, reap the leader and resolve");
    const termedStatus = await termed.status;
    assertEquals(
      [termedStatus.code, termedStatus.signal],
      [42, null],
      "SIGTERM must reach the leader (which trapped it and exited 42), not be replaced by SIGKILL",
    );

    const killed = trappingLeader(`${scratch}/killed`);
    spawned.push(killed);
    await waitFor(() => exists(`${scratch}/killed`), 10_000, "the second leader to install its SIGTERM trap");
    await within(reapLeaderAndSettle(killed), 15_000, "the helper to kill the second leader, reap it and resolve");
    assertEquals(
      (await killed.status).signal,
      "SIGKILL",
      "with no signal argument the leader dies of SIGKILL: its trap never runs",
    );
  } finally {
    for (const proc of spawned) await reapQuietly(proc);
    Deno.removeSync(scratch, { recursive: true });
  }
});

Deno.test("jjsz helper: a leader that is already dead, a kill that throws and a status that rejects are all swallowed", async () => {
  const dead = new Deno.Command("/bin/sh", { args: ["-c", "exit 0"], stdout: "null", stderr: "null", clearEnv: true }).spawn();
  await dead.status;
  assertEquals(await reapLeaderAndSettle(dead), undefined, "a leader that is already reaped is fine");
  assertEquals(await reapLeaderAndSettle(dead, "SIGTERM"), undefined);

  const throwingKill = {
    kill() {
      throw new Error("kill failed");
    },
    get status() {
      return Promise.resolve({ code: 0, signal: null, success: true });
    },
  };
  assertEquals(await reapLeaderAndSettle(throwingKill as unknown as Deno.ChildProcess), undefined, "a throwing kill is swallowed");

  const rejectingStatus = {
    kill() {},
    get status() {
      return Promise.reject(new Error("wait failed"));
    },
  };
  assertEquals(
    await reapLeaderAndSettle(rejectingStatus as unknown as Deno.ChildProcess),
    undefined,
    "a rejecting status is swallowed",
  );
});

/** A watcher whose `status` the TEST ends, the way a real one ends when its kill logic completes. */
function heldFakeWatcher(events: string[]) {
  let end!: () => void;
  const status = new Promise<{ code: number; signal: string | null }>((resolve) => {
    end = () => resolve({ code: 0, signal: null });
  });
  return {
    end,
    watcher: {
      pid: 0,
      status,
      stdin: {
        close: () => {
          events.push("stdin.close");
          return Promise.resolve();
        },
      },
      kill: (signal?: Deno.Signal) => {
        events.push(`kill:${signal ?? "SIGTERM"}`);
      },
    },
  };
}

Deno.test("jjsz helper: waits for the lifeline's leader-exit sweep (a held watcher) and resolves only once it has finished", async () => {
  const leader = spawnLeader("/bin/sleep", ["300"]);
  const events: string[] = [];
  const { watcher, end } = heldFakeWatcher(events);
  try {
    attachProcessLifeline(leader, { group: leader.pid }, { spawn: () => watcher, sweepTimeoutMs: 60_000 });
    let resolved = false;
    const reaped = reapLeaderAndSettle(leader).then(() => {
      resolved = true;
    });
    await waitFor(() => events.includes("stdin.close"), 10_000, "the leader's exit to start the sweep (the watcher's stdin is closed)");
    assertEquals(lifelineState(leader)?.state, "fired", "the leader's exit fired the sweep");
    await sleep(300);
    assertEquals(resolved, false, "the helper must still be waiting: the sweep has not finished (its watcher is still running)");
    assertEquals(events, ["stdin.close"], "the sweep is the watcher's own kill logic: nothing killed the shell");
    end();
    await within(reaped, 10_000, "the helper to resolve once the sweep has finished");
    assertEquals(resolved, true, "the helper resolves once the sweep has finished");
  } finally {
    end();
    await lifelineState(leader)?.settled;
    await reapQuietly(leader);
  }
});

Deno.test("jjsz helper: when the lifeline never began a sweep (it was disarmed first) there is nothing to wait for", async () => {
  const leader = spawnLeader("/bin/sleep", ["300"]);
  const events: string[] = [];
  const { watcher, end } = heldFakeWatcher(events);
  try {
    const disarm = attachProcessLifeline(leader, { group: leader.pid }, { spawn: () => watcher, sweepTimeoutMs: 60_000 });
    // The disarm SIGKILLs the shell and then closes its stdin; the fake ends when it is killed.
    const disarmed = disarm();
    end();
    await disarmed;
    assertEquals(lifelineState(leader)?.state, "disarmed");
    await within(reapLeaderAndSettle(leader), 10_000, "the helper not to wait on a lifeline that has nothing left to do");
    assertEquals(lifelineState(leader)?.state, "disarmed", "a disarmed lifeline stays disarmed: no sweep ran");
    assertEquals(events, ["kill:SIGKILL", "stdin.close"], "only the disarm touched the watcher: shell killed BEFORE its stdin closed, and no sweep after it");
  } finally {
    end();
    await reapQuietly(leader);
  }
});

// ── the supervisor-analog harness ───────────────────────────────────────────

type Reap = "helper" | "old";
type WatcherKind = "held" | "real";
type Then = "exit" | "relaunch";

interface Runner {
  child: Deno.ChildProcess;
  dir: string;
  /** Every complete stdout line so far, except the `TICK` heartbeat (counted in `ticks`, so diagnostics stay readable). */
  lines: string[];
  /** The `TICK` lines the runner has printed so far (the heartbeat that proves it is still running). */
  ticks: number;
  /**
   * `ticks` at the moment the runner's `LEADER_EXITED` line was read; null until then. Stdout is read in order, so
   * the ticks counted past this value were printed AFTER the runner observed its leader's exit.
   */
  ticksAtLeaderExit: number | null;
  /** The supervisor's own bookkeeping: every descendant of the runner seen so far. */
  observed: Map<number, any>;
  /** Set once the runner has exited. */
  exit: { code: number } | null;
  pump: Promise<void>;
  /** Set once stdout reached end of file: an exit can be seen before the last line was read. */
  pumped: boolean;
  sampler: { stop(): Promise<void> };
}

/**
 * The supervisor's sampling loop (scripts/security-suite-supervisor.mjs): `observeDescendants` of the runner
 * every 20 ms behind a `sampling` guard, a failed sample is a missed sample, and the stop waits for the sample
 * in flight.
 */
function startSampler(rootPid: number, observed: Map<number, any>): { stop(): Promise<void> } {
  let sampling = false;
  const timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      await observeDescendants(rootPid, observed);
    } catch {
      // A missed sample; the next tick samples again.
    } finally {
      sampling = false;
    }
  }, 20);
  return {
    async stop() {
      clearInterval(timer);
      while (sampling) await sleep(5);
    },
  };
}

async function startRunner(reap: Reap, watcher: WatcherKind, then: Then, env: Record<string, string> = {}): Promise<Runner> {
  const dir = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "jjsz-runner-exit-" });
  const spec = setsidSpawnSpec(Deno.execPath(), ["run", "-A", "--no-check", FIXTURE, reap, watcher, then, dir]);
  const child = new Deno.Command(spec.command, {
    args: spec.args,
    stdout: "piped",
    stderr: "inherit",
    env: { NO_COLOR: "1", ...env },
  }).spawn();
  const runner: Runner = {
    child,
    dir,
    lines: [],
    ticks: 0,
    ticksAtLeaderExit: null,
    observed: new Map(),
    exit: null,
    pump: Promise.resolve(),
    pumped: false,
    sampler: { stop: () => Promise.resolve() },
  };
  child.status.then((status) => {
    runner.exit = { code: status.code };
  });
  runner.pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("TICK ")) {
          runner.ticks += 1;
          continue;
        }
        runner.lines.push(line);
        // Synchronous with the line above and with the tick count: the stamp is exact, whatever the read chunking.
        if (line === "LEADER_EXITED") runner.ticksAtLeaderExit = runner.ticks;
      }
    }
    runner.pumped = true;
  })();
  await observeDescendants(child.pid, runner.observed).catch(() => {});
  runner.sampler = startSampler(child.pid, runner.observed);
  return runner;
}

async function lineOf(runner: Runner, prefix: string, ms = 20_000): Promise<string> {
  await waitFor(
    () => runner.lines.some((line) => line.startsWith(prefix)) || (runner.exit !== null && runner.pumped),
    ms,
    `the runner's "${prefix.trim()}" line (stdout so far: ${JSON.stringify(runner.lines)})`,
  );
  const line = runner.lines.find((candidate) => candidate.startsWith(prefix));
  assert(line !== undefined, `the runner exited ${JSON.stringify(runner.exit)} without printing "${prefix.trim()}"; stdout: ${JSON.stringify(runner.lines)}`);
  return line;
}

async function ready(runner: Runner): Promise<{ leader: number; watcher: number; group: number }> {
  const line = await lineOf(runner, "READY ");
  return JSON.parse(line.slice("READY ".length));
}

/** The supervisor's order of events: it has OBSERVED the watcher before the runner is allowed to end. */
async function observedWatcher(runner: Runner, watcher: number): Promise<void> {
  await waitFor(() => runner.observed.has(watcher), 15_000, `the supervisor-analog to observe the watcher ${watcher}`);
}

/**
 * Ticks the runner must print after it observed its leader's exit before a "has not yet" assertion is believed. At
 * 50 ms each, 11 ticks are at least 500 ms of the RUNNER's own time: no shorter than the 400/500 ms sleeps this
 * replaces, but a starved runner cannot use the window up.
 */
const NEGATIVE_WINDOW_TICKS = 11;

/**
 * A NEGATIVE window ("the runner has NOT done X yet") that no scheduler can shrink.
 *
 * A fixed `sleep` in this process measures MY clock, not the runner's. A runner starved for longer than the sleep
 * has not run at all, so a mutant that skips the wait has not had its first turn to act, and the "has not yet"
 * assertion passes for the wrong reason: the test is insensitive, not flaky, and nothing reports it.
 *
 * The fixture closes that with two stdout markers. It prints `LEADER_EXITED` from a reaction on the leader's
 * `status` registered BEFORE the reap helper awaits that same promise; reactions on one promise run in
 * registration order inside one microtask checkpoint, and no timer callback runs inside a checkpoint. So whatever a
 * wait-skipping helper does next (REAPED, the second browser's SECOND, Deno.exit) happens before the first `TICK`
 * that follows the marker. The pump keeps stdout in order, so NEGATIVE_WINDOW_TICKS ticks counted past the marker
 * were all printed after the point where such a mutant would already have acted: the window is the runner's time.
 *
 * `answered` ends the wait early once the runner has done what must not happen (reaped, opened a second browser,
 * exited), so that mutant fails on its intended assertion and not on this wait. The wait is bounded and THROWS: a
 * runner whose heartbeat or marker is missing is a broken fixture, never a runner that "merely kept waiting".
 */
async function afterLeaderExit(runner: Runner, answered: () => boolean, ms = 15_000): Promise<void> {
  try {
    await waitFor(
      () =>
        answered() ||
        (runner.ticksAtLeaderExit !== null && runner.ticks >= runner.ticksAtLeaderExit + NEGATIVE_WINDOW_TICKS),
      ms,
      `the runner to print LEADER_EXITED and then ${NEGATIVE_WINDOW_TICKS} TICK lines (its own proof that it kept running after its leader died)`,
    );
  } catch (error) {
    const stamp = runner.ticksAtLeaderExit;
    throw new Error(
      `${(error as Error).message}; LEADER_EXITED ${stamp === null ? "was never printed" : `was read after tick ${stamp}`}, ` +
        `${runner.ticks} ticks so far, runner exit ${JSON.stringify(runner.exit)}, stdout: ${JSON.stringify(runner.lines)}`,
    );
  }
}

function flag(runner: Runner, name: "go" | "release" | "done"): void {
  Deno.writeTextFileSync(`${runner.dir}/${name}`, "x");
}

async function mustExit(runner: Runner, ms = 20_000): Promise<void> {
  await waitFor(() => runner.exit !== null, ms, `the runner (pid ${runner.child.pid}) to exit (stdout so far: ${JSON.stringify(runner.lines)})`);
  // The exit can be seen before the last stdout line was read; the only writer is gone, so EOF follows at once.
  await within(runner.pump, 5_000, "the runner's stdout to reach end of file after its exit");
}

/** The supervisor's closing steps, in its order: one more sample after the runner exited, stop sampling, then judge. */
async function judge(runner: Runner): Promise<any[]> {
  await observeDescendants(runner.child.pid, runner.observed).catch(() => {});
  await runner.sampler.stop();
  return await liveObservedResidue(runner.observed);
}

/** Let every flag-driven wait end, stop sampling, reap whatever is left by IDENTITY, remove the scratch directory. */
async function teardown(runner: Runner): Promise<string[]> {
  const problems: string[] = [];
  for (const name of ["go", "release", "done"] as const) {
    try { flag(runner, name); } catch { /* the directory is gone */ }
  }
  await runner.sampler.stop();
  try {
    await mustExit(runner, 10_000);
  } catch {
    problems.push("the runner did not exit by itself once every flag was set");
    try { runner.child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  await runner.child.status.catch(() => {});
  await within(runner.pump, 5_000, "the runner's stdout to reach end of file").catch((e) => problems.push(String(e.message)));
  const remaining = async () => (await liveObservedResidue(runner.observed)).length === 0;
  try {
    await waitFor(remaining, 8_000, "every observed process to be gone");
  } catch (error) {
    // `liveObservedResidue` compares start time and uid, so a recycled pid is never signalled.
    for (const row of await liveObservedResidue(runner.observed)) {
      problems.push(`${(error as Error).message}; killing ${JSON.stringify(row)}`);
      try { Deno.kill(row.pid, "SIGKILL"); } catch { /* gone */ }
    }
    await waitFor(remaining, 5_000, "the killed processes to be gone").catch((e) => problems.push(String(e.message)));
  }
  Deno.removeSync(runner.dir, { recursive: true });
  return problems;
}

async function withRunner(
  reap: Reap,
  watcher: WatcherKind,
  then: Then,
  body: (runner: Runner) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const runner = await startRunner(reap, watcher, then, env);
  let failed = false;
  try {
    await body(runner);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const problems = await teardown(runner);
    if (problems.length > 0) {
      if (failed) console.error(`teardown after a failed test: ${problems.join("; ")}`);
      else throw new Error(`teardown: ${problems.join("; ")}`);
    }
  }
}

// ── N1: the supervisor's residue judgement ──────────────────────────────────

Deno.test("jjsz N1 positive control: the OLD finally shape (kill, await status, exit) leaves the watcher running and the REAL liveObservedResidue reports it", async () => {
  await withRunner("old", "held", "exit", async (runner) => {
    const { leader, watcher } = await ready(runner);
    await observedWatcher(runner, watcher);
    flag(runner, "go");
    await mustExit(runner);
    assertEquals(runner.exit?.code, 0, "the old shape exits at once, with the sweep still running");
    const residue = await judge(runner);
    const row = residue.find((candidate) => candidate.pid === watcher);
    assert(
      row !== undefined,
      `the harness must be able to SEE the regression: the watcher ${watcher} is alive and observed, so liveObservedResidue must report it; got ${JSON.stringify(residue)}`,
    );
    assert(row.unverified !== true, `the row must be a verified live process, not an unreadable one: ${JSON.stringify(row)}`);
    assertNotEquals(row.state, "Z", "residue is a live process, not a zombie");
    assert(!residue.some((candidate) => candidate.pid === leader), "the leader itself was reaped: only the lingering watcher is residue");
    console.log(`N1 positive control: liveObservedResidue reported ${JSON.stringify(row)} (watcher pid ${watcher}, leader pid ${leader})`);
    // End the hold and prove the control leaves nothing behind (bounded, loud).
    flag(runner, "release");
    await waitFor(
      async () => (await liveObservedResidue(runner.observed)).length === 0,
      5_000,
      "the released watcher and every other observed process to be gone",
    );
  });
});

Deno.test("jjsz N1: reapLeaderAndSettle keeps the runner alive until the sweep has finished, and the REAL liveObservedResidue then reports nothing", async () => {
  await withRunner("helper", "held", "exit", async (runner) => {
    const { leader, watcher } = await ready(runner);
    await observedWatcher(runner, watcher);
    flag(runner, "go");
    await waitFor(() => !alive(leader), 10_000, `the leader ${leader} to be killed and reaped`);
    await afterLeaderExit(runner, () => runner.exit !== null || runner.lines.includes("REAPED"));
    assertEquals(runner.exit, null, "the runner must still be blocked in reapLeaderAndSettle: the sweep is held, so it has not finished");
    assert(!runner.lines.includes("REAPED"), `the helper must not have returned yet; stdout: ${JSON.stringify(runner.lines)}`);
    assert(alive(watcher), `the held watcher ${watcher} is still running, which is exactly what the helper has to wait for`);
    flag(runner, "release");
    await mustExit(runner);
    assertEquals(runner.exit?.code, 0);
    assert(runner.lines.includes("REAPED"), `the helper returned once the sweep finished; stdout: ${JSON.stringify(runner.lines)}`);
    const residue = await judge(runner);
    assertEquals(
      residue,
      [],
      `after the helper the supervisor's own judgement finds no live observed process (the watcher was ${watcher}); got ${JSON.stringify(residue)}`,
    );
  });
});

Deno.test("jjsz N1 smoke (not a pin): with the product's unmodified watcher the helper leaves nothing for liveObservedResidue", async () => {
  // The real window is ~110 ms, so this run cannot tell the two shapes apart reliably: it only shows the
  // helper works with the production watcher end to end. The held-watcher tests above are the pin.
  await withRunner("helper", "real", "exit", async (runner) => {
    const { watcher } = await ready(runner);
    await observedWatcher(runner, watcher);
    flag(runner, "go");
    await mustExit(runner);
    assertEquals(runner.exit?.code, 0);
    assert(runner.lines.includes("REAPED"), `stdout: ${JSON.stringify(runner.lines)}`);
    assertEquals(await judge(runner), [], "the production watcher has finished by the time the runner exits");
  });
});

Deno.test("jjsz fixture tripwire: when the production watcher script no longer holds the pause the held watcher replaces, the fixture refuses instead of proving nothing", async () => {
  await withRunner("helper", "held", "exit", async (runner) => {
    const line = await lineOf(runner, "FIXTURE_ERROR ");
    const report = JSON.parse(line.slice("FIXTURE_ERROR ".length));
    assert(
      String(report.message).includes("exactly once"),
      `the fixture must say the replacement would be a no-op: ${JSON.stringify(report)}`,
    );
    await mustExit(runner);
    assertEquals(runner.exit?.code, 5, "a fixture whose slowdown would be a no-op must fail, not run");
    assert(!runner.lines.some((candidate) => candidate.startsWith("READY ")), "it never reached the point of being driven");
    await waitFor(() => !alive(report.leader), 10_000, `the fixture's leader ${report.leader} to be killed on the refusal`);
  }, { JJSZ_RUNNER_NEEDLE: "sleep 9.9; " });
});

// ── N2: a same-profile relaunch ─────────────────────────────────────────────

async function secondBrowser(runner: Runner): Promise<number> {
  const line = await lineOf(runner, "SECOND ");
  const { pid } = JSON.parse(line.slice("SECOND ".length));
  // The sampler sees it too; recording its identity here makes the roster certain.
  runner.observed.set(pid, await readProcIdentity(pid));
  return pid;
}

Deno.test("jjsz N2 positive control: with the OLD shape a sweep still running when the second browser opens the same profile kills it", async () => {
  await withRunner("old", "held", "relaunch", async (runner) => {
    const { watcher } = await ready(runner);
    await observedWatcher(runner, watcher);
    flag(runner, "go");
    const second = await secondBrowser(runner);
    assert(alive(second), "the second browser is up while the first browser's sweep is still running");
    assert(alive(watcher), `the first browser's sweep (watcher ${watcher}) is still running`);
    flag(runner, "release");
    await waitFor(
      () => !alive(second),
      10_000,
      `the still-running sweep's profile pkill to kill the second browser ${second} (this IS the N2 hazard)`,
    );
    flag(runner, "done");
    await mustExit(runner);
  });
});

Deno.test("jjsz N2: with reapLeaderAndSettle the second browser opens only after the first browser's sweep finished, and survives", async () => {
  await withRunner("helper", "held", "relaunch", async (runner) => {
    const { leader, watcher } = await ready(runner);
    await observedWatcher(runner, watcher);
    flag(runner, "go");
    await waitFor(() => !alive(leader), 10_000, `the first browser's leader ${leader} to be killed and reaped`);
    await afterLeaderExit(
      runner,
      () => runner.exit !== null || runner.lines.includes("REAPED") || runner.lines.some((line) => line.startsWith("SECOND ")),
    );
    assert(
      !runner.lines.some((line) => line.startsWith("SECOND ")),
      `no second browser may open while the first browser's sweep is running; stdout: ${JSON.stringify(runner.lines)}`,
    );
    assert(
      !runner.lines.includes("REAPED"),
      `the helper must not have returned yet, so nothing may follow it; stdout: ${JSON.stringify(runner.lines)}`,
    );
    assert(alive(watcher), `the first browser's sweep (watcher ${watcher}) is still running`);
    flag(runner, "release");
    const second = await secondBrowser(runner);
    assert(!alive(watcher), `the sweep (watcher ${watcher}) must have finished before the second browser opened`);
    // Longer than the journeys' own 700/800 ms pause: nothing is left that could pkill the profile.
    await sleep(900);
    assert(alive(second), `the second browser ${second} must survive: its profile has no sweep left to match it`);
    flag(runner, "done");
    await mustExit(runner);
    assertEquals(runner.exit?.code, 0);
  });
});

// ── the call-site pins ──────────────────────────────────────────────────────

type Ast = { type: string; [key: string]: any };

const isAst = (value: unknown): value is Ast =>
  typeof value === "object" && value !== null && typeof (value as Ast).type === "string";

/** Pre-order over every AST node under `node`, whatever holds it (statement lists, arguments, finalizers). */
function descend(node: Ast, visit: (node: Ast) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "type") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isAst(child)) descend(child, visit);
    }
  }
}

/** `a.b.c` for a non-computed member chain rooted at an identifier (optional chains included); null for anything else. */
function dotted(node: Ast | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "ChainExpression") return dotted(node.expression);
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property?.type === "Identifier") {
    const base = dotted(node.object);
    return base === null ? null : `${base}.${node.property.name}`;
  }
  return null;
}

/** `await <callee>(...)` as a whole statement: the CallExpression, or null. Dropping the `await` returns null. */
function awaitedCall(statement: Ast, callee: string): Ast | null {
  if (statement.type !== "ExpressionStatement" || statement.expression.type !== "AwaitExpression") return null;
  const call = statement.expression.argument;
  return call?.type === "CallExpression" && dotted(call.callee) === callee ? call : null;
}

/** `<callee>(...)` as a whole statement, not awaited. */
function plainCall(statement: Ast, callee: string): boolean {
  return statement.type === "ExpressionStatement" && statement.expression.type === "CallExpression" &&
    dotted(statement.expression.callee) === callee;
}

const parsed = new Map<string, Ast>();

/** The program of a TypeScript source: esbuild strips the types, acorn parses what is left. */
async function parseTs(source: string): Promise<Ast> {
  const known = parsed.get(source);
  if (known) return known;
  try {
    const { code } = await transform(source, { loader: "ts", format: "esm", target: "esnext" });
    const program = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module" }) as unknown as Ast;
    parsed.set(source, program);
    return program;
  } finally {
    await stop();
  }
}

const sourceOf = (rel: string): string => Deno.readTextFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)));

/** `from` -> `to` EXACTLY once, or the mutant is not the mutant it claims to be. */
function mutate(source: string, from: string, to: string): string {
  const parts = source.split(from);
  assertEquals(parts.length, 2, `the mutant anchor must occur exactly once: ${JSON.stringify(from)}`);
  return parts.join(to);
}

interface Violations {
  /** The helper call exists, is an awaited statement, and takes the right arguments. */
  call: string[];
  /** The helper call sits where the old two lines sat. */
  order: string[];
  /** The old bare kill/status shape is not back. */
  bare: string[];
}

const everything = (message: string): Violations => ({ call: [message], order: [message], bare: [message] });

// scripts/security-suite.ts: `main()` launches Chrome, then runs a try/catch/finally whose finally is
// `cdp.close(); <reap>; await provider.close(); await attacker.close(); await docs.close();`.
function securitySuiteViolations(program: Ast): Violations {
  const main = program.body.find((s: Ast) => s.type === "FunctionDeclaration" && s.id?.name === "main");
  if (!main) return everything("no `function main` in scripts/security-suite.ts: update this pin");
  const body: Ast[] = main.body.body;
  const launch = body.findIndex((s) =>
    s.type === "VariableDeclaration" &&
    s.declarations.some((d: Ast) =>
      d.id?.name === "chrome" && d.init?.type === "AwaitExpression" && dotted(d.init.argument?.callee) === "launchChrome"
    )
  );
  if (launch < 0) return everything("no `const chrome = await launchChrome(...)` in main(): update this pin");
  const tryStatement = body.slice(launch + 1).find((s) => s.type === "TryStatement");
  if (!tryStatement?.finalizer) return everything("no try/finally after the launch in main(): update this pin");
  const finalizer: Ast[] = tryStatement.finalizer.body;

  const violations: Violations = { call: [], order: [], bare: [] };
  const reaps = finalizer.flatMap((s, index) => (awaitedCall(s, "reapLeaderAndSettle") ? [index] : []));
  if (reaps.length !== 1) {
    violations.call.push(`the finally must hold exactly one \`await reapLeaderAndSettle(...)\` statement; it holds ${reaps.length}`);
    violations.order.push("there is no single reap statement to order");
  } else {
    const call = awaitedCall(finalizer[reaps[0]], "reapLeaderAndSettle")!;
    if (call.arguments.length !== 1 || dotted(call.arguments[0]) !== "chrome.proc") {
      violations.call.push("it must reap the launch handle with the default signal: `reapLeaderAndSettle(chrome.proc)`");
    }
    const cdpClose = finalizer.findIndex((s) => plainCall(s, "cdp.close"));
    if (cdpClose < 0 || cdpClose > reaps[0]) violations.order.push("`cdp.close()` must come first, before the reap");
    for (const server of ["provider.close", "attacker.close", "docs.close"]) {
      const at = finalizer.findIndex((s) => awaitedCall(s, server) !== null);
      if (at < reaps[0]) violations.order.push(`\`await ${server}()\` must come after the reap (found at ${at}, reap at ${reaps[0]})`);
    }
  }
  for (const statement of finalizer) {
    descend(statement, (node) => {
      if (node.type === "CallExpression" && dotted(node.callee) === "chrome.proc.kill") {
        violations.bare.push("a bare `chrome.proc.kill(...)` is in the finally");
      }
      if (node.type === "AwaitExpression" && dotted(node.argument) === "chrome.proc.status") {
        violations.bare.push("a bare `await chrome.proc.status` is in the finally");
      }
    });
  }
  return violations;
}

// The journeys: the top-level try holds `launched = await launchChrome(...)` twice. Between the two launches
// the first browser is reaped with SIGTERM (so Chrome flushes its profile), `launched = null`, a pause.
function journeyViolations(program: Ast): Violations {
  const launchAssignment = (s: Ast) =>
    s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" &&
    dotted(s.expression.left) === "launched" && s.expression.right.type === "AwaitExpression" &&
    dotted(s.expression.right.argument?.callee) === "launchChrome";
  const tryStatement = program.body.find((s: Ast) => s.type === "TryStatement" && s.block.body.filter(launchAssignment).length >= 2);
  if (!tryStatement) return everything("no top-level try holding two `launched = await launchChrome(...)` statements: update this pin");
  const sequence: Ast[] = tryStatement.block.body;
  const launches = sequence.flatMap((s, index) => (launchAssignment(s) ? [index] : []));
  const between = sequence.slice(launches[0] + 1, launches[1]);

  const violations: Violations = { call: [], order: [], bare: [] };
  const reaps = between.flatMap((s, index) => (awaitedCall(s, "reapLeaderAndSettle") ? [index] : []));
  if (reaps.length !== 1) {
    violations.call.push(`between the two launches there must be exactly one \`await reapLeaderAndSettle(...)\` statement; there are ${reaps.length}`);
    violations.order.push("there is no single reap statement to order");
  } else {
    const call = awaitedCall(between[reaps[0]], "reapLeaderAndSettle")!;
    const [handle, signal] = call.arguments;
    if (call.arguments.length !== 2 || dotted(handle) !== "launched.proc" || signal?.type !== "Literal" || signal.value !== "SIGTERM") {
      violations.call.push('it must be `reapLeaderAndSettle(launched.proc, "SIGTERM")`: SIGTERM lets Chrome flush its profile before the relaunch');
    }
    const reset = between.findIndex((s) =>
      s.type === "ExpressionStatement" && s.expression.type === "AssignmentExpression" &&
      dotted(s.expression.left) === "launched" && s.expression.right.type === "Literal" && s.expression.right.value === null
    );
    if (reset < reaps[0]) violations.order.push("`launched = null` must come after the reap (the reap needs the handle), before the second launch");
  }
  for (const statement of between) {
    descend(statement, (node) => {
      if (node.type === "CallExpression" && dotted(node.callee) === "launched.proc.kill") {
        violations.bare.push("a bare `launched.proc.kill(...)` is between the two launches");
      }
      if (node.type === "AwaitExpression" && dotted(node.argument) === "launched.proc.status") {
        violations.bare.push("a bare `await launched.proc.status` is between the two launches");
      }
    });
  }
  return violations;
}

// scripts/security-injection.ts: a top-level `async function kill()` and a top-level try whose body boots the
// browser (`let extId = await boot()`), kills it, seeds the profile and boots it AGAIN (`extId = await boot()`).
// Both boots run on ONE profile, so the kill between them has to wait for the sweep, and the file's only other
// process handling, the finally, has to as well (the profile is removed after it).
function injectionViolations(program: Ast): Violations {
  const killFunction = program.body.find((s: Ast) => s.type === "FunctionDeclaration" && s.id?.name === "kill");
  if (!killFunction) return everything("no `function kill` in scripts/security-injection.ts: update this pin");
  const tryStatement = program.body.find((s: Ast) => s.type === "TryStatement" && s.finalizer);
  if (!tryStatement) return everything("no top-level try/finally in scripts/security-injection.ts: update this pin");
  const sequence: Ast[] = tryStatement.block.body;
  const awaitsBoot = (statement: Ast): boolean => {
    let found = false;
    descend(statement, (node) => {
      if (node.type === "AwaitExpression" && node.argument?.type === "CallExpression" && dotted(node.argument.callee) === "boot") found = true;
    });
    return found;
  };
  const boots = sequence.flatMap((s, index) => (awaitsBoot(s) ? [index] : []));
  if (boots.length !== 2) return everything(`the try body must boot the browser exactly twice (\`await boot()\`); it does ${boots.length}: update this pin`);

  const violations: Violations = { call: [], order: [], bare: [] };
  // call: kill() holds exactly one `await reapLeaderAndSettle(proc)` statement, directly or as the body of `if (proc)`.
  const killStatements: Ast[] = killFunction.body.body.flatMap((s: Ast) =>
    s.type === "IfStatement" && !s.alternate && dotted(s.test) === "proc"
      ? (s.consequent.type === "BlockStatement" ? s.consequent.body : [s.consequent])
      : [s]
  );
  const reaps = killStatements.filter((s) => awaitedCall(s, "reapLeaderAndSettle") !== null);
  if (reaps.length !== 1) {
    violations.call.push(`kill() must hold exactly one \`await reapLeaderAndSettle(...)\` statement; it holds ${reaps.length}`);
  } else {
    const call = awaitedCall(reaps[0], "reapLeaderAndSettle")!;
    if (call.arguments.length !== 1 || dotted(call.arguments[0]) !== "proc") {
      violations.call.push("it must reap the launch handle with the default signal: `reapLeaderAndSettle(proc)`");
    }
  }
  // order: an awaited kill() sits between the two boots, and the finally awaits kill() as well.
  if (!sequence.slice(boots[0] + 1, boots[1]).some((s) => awaitedCall(s, "kill") !== null)) {
    violations.order.push("an `await kill()` statement must sit between the two `await boot()` statements: the second boot opens the same profile");
  }
  if (!tryStatement.finalizer.body.some((s: Ast) => awaitedCall(s, "kill") !== null)) {
    violations.order.push("the finally must `await kill()`: the profile is removed after the browser and its sweep are gone");
  }
  // bare: nothing in the script kills or waits for the browser by hand (the optional chains are read through).
  descend(program, (node) => {
    if (node.type === "CallExpression" && dotted(node.callee) === "proc.kill") violations.bare.push("a bare `proc.kill(...)` is in the script");
    if (node.type === "AwaitExpression" && dotted(node.argument) === "proc.status") violations.bare.push("a bare `await proc.status` is in the script");
  });
  return violations;
}

const SECURITY_SUITE = "scripts/security-suite.ts";
const JOURNEYS = ["scripts/page-actions-journey.ts", "scripts/keyless-first-result.ts"];
const SECURITY_INJECTION = "scripts/security-injection.ts";

Deno.test("jjsz pin: scripts/security-suite.ts finally awaits reapLeaderAndSettle(chrome.proc) as a statement (kills: delete the call, drop the await, the old two-line shape)", async () => {
  assertEquals(securitySuiteViolations(await parseTs(sourceOf(SECURITY_SUITE))).call, []);
});

Deno.test("jjsz pin: scripts/security-suite.ts finally runs cdp.close() first and the reap before the three server closes (kills: move the call before cdp.close(), into the try body)", async () => {
  assertEquals(securitySuiteViolations(await parseTs(sourceOf(SECURITY_SUITE))).order, []);
});

Deno.test("jjsz pin: scripts/security-suite.ts finally holds no bare chrome.proc.kill / await chrome.proc.status (kills: the old shape added back next to the helper)", async () => {
  assertEquals(securitySuiteViolations(await parseTs(sourceOf(SECURITY_SUITE))).bare, []);
});

for (const journey of JOURNEYS) {
  const name = journey.replace("scripts/", "");
  Deno.test(`jjsz pin: ${name} reaps the first browser with await reapLeaderAndSettle(launched.proc, "SIGTERM") before the second launch (kills: delete the call, drop the await, another signal)`, async () => {
    assertEquals(journeyViolations(await parseTs(sourceOf(journey))).call, []);
  });
  Deno.test(`jjsz pin: ${name} resets launched only after the reap (kills: swap the two statements)`, async () => {
    assertEquals(journeyViolations(await parseTs(sourceOf(journey))).order, []);
  });
  Deno.test(`jjsz pin: ${name} holds no bare launched.proc.kill / await launched.proc.status between the two launches (kills: the old shape added back)`, async () => {
    assertEquals(journeyViolations(await parseTs(sourceOf(journey))).bare, []);
  });
}

Deno.test("jjsz pin: scripts/security-injection.ts kill() awaits reapLeaderAndSettle(proc) as a statement (kills: delete the call, drop the await, another signal, the old two-line shape)", async () => {
  assertEquals(injectionViolations(await parseTs(sourceOf(SECURITY_INJECTION))).call, []);
});

Deno.test("jjsz pin: scripts/security-injection.ts awaits kill() between its two boots and in its finally (kills: drop the await, delete the call)", async () => {
  assertEquals(injectionViolations(await parseTs(sourceOf(SECURITY_INJECTION))).order, []);
});

Deno.test("jjsz pin: scripts/security-injection.ts holds no bare proc.kill / await proc.status (kills: the old shape added back)", async () => {
  assertEquals(injectionViolations(await parseTs(sourceOf(SECURITY_INJECTION))).bare, []);
});

// ── the pins are themselves checked against mutants of the real sources ─────

const REAP_LINE = "    await reapLeaderAndSettle(chrome.proc);\n";
const CDP_LINE = "    cdp.close();\n";
const OLD_SHAPE = '    try { chrome.proc.kill("SIGKILL"); } catch { /* already dead */ }\n' +
  "    try { await chrome.proc.status; } catch { /* reaped */ }\n";
const CATCH_HEAD = '  } catch (e) {\n    check("suite: ran to completion"';

/** Name -> [mutant source, properties that must now be violated]; every other property must stay clean. */
function securitySuiteMutants(source: string): Array<[string, string, Array<keyof Violations>]> {
  return [
    ["delete the call (the import stays)", mutate(source, REAP_LINE, ""), ["call", "order"]],
    ["drop the await", mutate(source, REAP_LINE, "    reapLeaderAndSettle(chrome.proc);\n"), ["call", "order"]],
    ["move the call before cdp.close()", mutate(source, CDP_LINE + REAP_LINE, REAP_LINE + CDP_LINE), ["order"]],
    [
      "move the call into the try body",
      mutate(mutate(source, REAP_LINE, ""), CATCH_HEAD, `    await reapLeaderAndSettle(chrome.proc);\n${CATCH_HEAD}`),
      ["call", "order"],
    ],
    ["replace the call with the old two-line shape", mutate(source, REAP_LINE, OLD_SHAPE), ["call", "order", "bare"]],
    ["add the old two-line shape back next to the helper", mutate(source, REAP_LINE, REAP_LINE + OLD_SHAPE), ["bare"]],
    [
      "reap with another signal",
      mutate(source, "reapLeaderAndSettle(chrome.proc)", 'reapLeaderAndSettle(chrome.proc, "SIGTERM")'),
      ["call"],
    ],
  ];
}

Deno.test("jjsz pin check: every mutant of scripts/security-suite.ts is rejected by exactly the properties it breaks", async () => {
  const source = sourceOf(SECURITY_SUITE);
  const clean = securitySuiteViolations(await parseTs(source));
  assertEquals(clean, { call: [], order: [], bare: [] }, "the real source satisfies every property");
  for (const [name, mutant, broken] of securitySuiteMutants(source)) {
    const found = securitySuiteViolations(await parseTs(mutant));
    for (const property of ["call", "order", "bare"] as const) {
      assertEquals(
        found[property].length > 0,
        broken.includes(property),
        `mutant "${name}": property "${property}" ${broken.includes(property) ? "must be violated" : "must stay clean"}; got ${JSON.stringify(found)}`,
      );
    }
  }
});

const JOURNEY_REAP = '  await reapLeaderAndSettle(launched.proc, "SIGTERM");\n';
const JOURNEY_OLD_SHAPE = '  launched.proc.kill("SIGTERM");\n  await launched.proc.status;\n';

function journeyMutants(source: string): Array<[string, string, Array<keyof Violations>]> {
  return [
    ["delete the call (the import stays)", mutate(source, JOURNEY_REAP, ""), ["call", "order"]],
    ["drop the await", mutate(source, JOURNEY_REAP, '  reapLeaderAndSettle(launched.proc, "SIGTERM");\n'), ["call", "order"]],
    ["reap with the default SIGKILL", mutate(source, JOURNEY_REAP, "  await reapLeaderAndSettle(launched.proc);\n"), ["call"]],
    ["replace the call with the old two-line shape", mutate(source, JOURNEY_REAP, JOURNEY_OLD_SHAPE), ["call", "order", "bare"]],
    ["add the old two-line shape back next to the helper", mutate(source, JOURNEY_REAP, JOURNEY_REAP + JOURNEY_OLD_SHAPE), ["bare"]],
    [
      "reset launched before the reap",
      mutate(source, `${JOURNEY_REAP}  launched = null;\n`, `  launched = null;\n${JOURNEY_REAP}`),
      ["order"],
    ],
  ];
}

for (const journey of JOURNEYS) {
  Deno.test(`jjsz pin check: every mutant of ${journey.replace("scripts/", "")} is rejected by exactly the properties it breaks`, async () => {
    const source = sourceOf(journey);
    assertEquals(journeyViolations(await parseTs(source)), { call: [], order: [], bare: [] }, "the real source satisfies every property");
    for (const [name, mutant, broken] of journeyMutants(source)) {
      const found = journeyViolations(await parseTs(mutant));
      for (const property of ["call", "order", "bare"] as const) {
        assertEquals(
          found[property].length > 0,
          broken.includes(property),
          `mutant "${name}": property "${property}" ${broken.includes(property) ? "must be violated" : "must stay clean"}; got ${JSON.stringify(found)}`,
        );
      }
    }
  });
}

const INJECTION_REAP = "  if (proc) await reapLeaderAndSettle(proc);\n";
const INJECTION_OLD_SHAPE = '  try { proc?.kill("SIGKILL"); } catch { /* gone */ }\n  try { await proc?.status; } catch { /* reaped */ }\n';
const INJECTION_FIRST_KILL = "  await kill();\n  const prefPath";
const INJECTION_LAST_KILL = "  await kill();\n  // Chrome's helpers release";

function injectionMutants(source: string): Array<[string, string, Array<keyof Violations>]> {
  return [
    ["delete the reap statement (the import stays)", mutate(source, INJECTION_REAP, ""), ["call"]],
    ["drop the await", mutate(source, INJECTION_REAP, "  if (proc) reapLeaderAndSettle(proc);\n"), ["call"]],
    ["reap with another signal", mutate(source, "reapLeaderAndSettle(proc)", 'reapLeaderAndSettle(proc, "SIGTERM")'), ["call"]],
    ["replace the call with the old two-line shape", mutate(source, INJECTION_REAP, INJECTION_OLD_SHAPE), ["call", "bare"]],
    ["add the old two-line shape back next to the helper", mutate(source, INJECTION_REAP, INJECTION_REAP + INJECTION_OLD_SHAPE), ["bare"]],
    ["relaunch without awaiting the kill", mutate(source, INJECTION_FIRST_KILL, "  kill();\n  const prefPath"), ["order"]],
    ["delete the kill between the two boots", mutate(source, INJECTION_FIRST_KILL, "  const prefPath"), ["order"]],
    ["the finally stops awaiting kill()", mutate(source, INJECTION_LAST_KILL, "  kill();\n  // Chrome's helpers release"), ["order"]],
  ];
}

Deno.test("jjsz pin check: every mutant of scripts/security-injection.ts is rejected by exactly the properties it breaks", async () => {
  const source = sourceOf(SECURITY_INJECTION);
  assertEquals(injectionViolations(await parseTs(source)), { call: [], order: [], bare: [] }, "the real source satisfies every property");
  for (const [name, mutant, broken] of injectionMutants(source)) {
    const found = injectionViolations(await parseTs(mutant));
    for (const property of ["call", "order", "bare"] as const) {
      assertEquals(
        found[property].length > 0,
        broken.includes(property),
        `mutant "${name}": property "${property}" ${broken.includes(property) ? "must be violated" : "must stay clean"}; got ${JSON.stringify(found)}`,
      );
    }
  }
});

// ── the binding pin ─────────────────────────────────────────────────────────
//
// An import is not a call site, and a call site is not an import. Every pin above reads the CALL; with the
// import deleted the call stays and is an unbound name, which throws a ReferenceError only when a real run
// reaches the `finally` (or the phase-1 to phase-2 boundary). A drilled mutant of exactly that (delete the import
// line of scripts/security-suite.ts) survived every pin above, and no gate on this box runs the real security
// suite (bead 8bp69) to notice. A local re-implementation, or some other export aliased to the same local name,
// would equally satisfy the call-site pins, so the import must name the helper, under its own name, from the
// one module.
//
// A binding is also not a name. Declaring `reapLeaderAndSettle` again where the call runs (a `const` in the
// finally, a parameter, a catch binding) binds the call to something that is not the helper while a call-site pin
// that only compared names would still see an awaited call by that name. What the transform does with that shadow
// was drilled (esbuild 0.25.12, shadow in the finally block): when the shadow covers the import's only use,
// esbuild drops the now-unused import and the import rule above rejects the file; when the import stays
// referenced elsewhere, esbuild renames the shadow to `reapLeaderAndSettle2`, so the call no longer names the
// helper and the call-site pins reject it as a missing call. Both are properties of how a TypeScript transform
// treats names, not of these pins, so the declaration count is its own rule: it counts the name and the
// renamer's numbered variants, so it rejects the shadow whether or not the transform renames it. The shadow
// mutant below keeps the import alive with a stray reference and is rejected by the count on its own.

const REAP_NAME = "reapLeaderAndSettle";
const REAP_MODULE = "./lib/reap-leader.ts";
const REAP_IMPORT = `import { ${REAP_NAME} } from "${REAP_MODULE}";\n`;

/**
 * Every binding the program declares for `name`: imports, function names and parameters, classes, variables, catch
 * parameters. The parser here sees the program AFTER esbuild's transform, and esbuild renames a nested declaration
 * that collides with a live outer binding (`const reapLeaderAndSettle` in a block becomes `reapLeaderAndSettle2`), so
 * `name` followed by digits is that same declaration and is counted with it. Counting only the exact name would
 * never see a shadow that the transform had already renamed.
 */
function declarationsOf(program: Ast, name: string): string[] {
  const found: string[] = [];
  const renamed = new RegExp(`^${name}[0-9]+$`);
  const pattern = (node: Ast | null | undefined, what: string): void => {
    if (!node) return;
    switch (node.type) {
      case "Identifier":
        if (node.name === name || renamed.test(node.name)) found.push(what);
        break;
      case "ObjectPattern":
        for (const property of node.properties) pattern(property.type === "RestElement" ? property.argument : property.value, what);
        break;
      case "ArrayPattern":
        for (const element of node.elements) pattern(element, what);
        break;
      case "AssignmentPattern":
        pattern(node.left, what);
        break;
      case "RestElement":
        pattern(node.argument, what);
        break;
    }
  };
  descend(program, (node) => {
    switch (node.type) {
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
        pattern(node.local, "an import");
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
        pattern(node.id, "a function name");
        for (const parameter of node.params) pattern(parameter, "a parameter");
        break;
      case "ArrowFunctionExpression":
        for (const parameter of node.params) pattern(parameter, "a parameter");
        break;
      case "ClassDeclaration":
      case "ClassExpression":
        pattern(node.id, "a class name");
        break;
      case "VariableDeclarator":
        pattern(node.id, "a variable");
        break;
      case "CatchClause":
        pattern(node.param, "a catch parameter");
        break;
    }
  });
  return found;
}

/** The import: exactly one, `{ reapLeaderAndSettle }` from the one module, under its own name. */
function reapImportViolations(program: Ast): string[] {
  const imports = program.body.filter((s: Ast) => s.type === "ImportDeclaration" && s.source?.value === REAP_MODULE);
  if (imports.length !== 1) return [`the script must import from ${REAP_MODULE} exactly once; it does ${imports.length} times`];
  const bound = imports[0].specifiers.some((s: Ast) =>
    s.type === "ImportSpecifier" && (s.imported?.name ?? s.imported?.value) === REAP_NAME &&
    s.local?.name === REAP_NAME
  );
  return bound ? [] : [`${REAP_MODULE} must be imported as { ${REAP_NAME} }, under that same local name`];
}

/** Nothing else in the script declares the name: a shadow binds the call to something that is not the helper. */
function reapShadowViolations(program: Ast): string[] {
  const declared = declarationsOf(program, REAP_NAME);
  return declared.length === 1
    ? []
    : [`${REAP_NAME} must be declared exactly once, by the import; it is declared ${declared.length} times (${declared.join(", ")})`];
}

function reapBindingViolations(program: Ast): string[] {
  const imported = reapImportViolations(program);
  return imported.length > 0 ? imported : reapShadowViolations(program);
}

function reapBindingMutants(source: string): Array<[string, string]> {
  return [
    ["delete the import (the call stays)", mutate(source, REAP_IMPORT, "")],
    ["alias another export to the name", mutate(source, REAP_IMPORT, `import { teardownChrome as ${REAP_NAME} } from "${REAP_MODULE}";\n`)],
    ["import it from another module", mutate(source, REAP_IMPORT, `import { ${REAP_NAME} } from "./lib/process-tree.ts";\n`)],
    [
      "define it locally",
      mutate(
        source,
        REAP_IMPORT,
        `async function ${REAP_NAME}(proc: Deno.ChildProcess): Promise<void> {\n  try { proc.kill("SIGKILL"); } catch { /* gone */ }\n  await proc.status;\n}\n`,
      ),
    ],
  ];
}

/**
 * The name is declared again right where the real call runs, in the same block, and a stray top-level reference keeps
 * the import alive. The import rule sees one correct import; only the declaration count sees the second binding.
 */
function reapShadowMutant(source: string, reapStatement: string): string {
  const indent = reapStatement.match(/^ */)![0];
  const shadow = `${indent}const ${REAP_NAME} = async (_proc: Deno.ChildProcess, _signal?: Deno.Signal) => {};\n`;
  return mutate(source, reapStatement, shadow + reapStatement) + `\nvoid ${REAP_NAME};\n`;
}

const REAP_STATEMENT_OF: Record<string, string> = {
  [SECURITY_SUITE]: REAP_LINE,
  [JOURNEYS[0]]: JOURNEY_REAP,
  [JOURNEYS[1]]: JOURNEY_REAP,
  [SECURITY_INJECTION]: INJECTION_REAP,
};

for (const script of [SECURITY_SUITE, ...JOURNEYS, SECURITY_INJECTION]) {
  const name = script.replace("scripts/", "");
  Deno.test(`jjsz pin: ${name} imports reapLeaderAndSettle from ./lib/reap-leader.ts under its own name and declares it nowhere else (kills: delete the import and keep the call, alias another export to the name, import it from elsewhere, define it locally, declare the name again where the call runs)`, async () => {
    assertEquals(reapBindingViolations(await parseTs(sourceOf(script))), []);
  });
  Deno.test(`jjsz pin check: every binding mutant of ${name} is rejected`, async () => {
    const source = sourceOf(script);
    assertEquals(reapBindingViolations(await parseTs(source)), [], "the real source binds the helper");
    for (const [mutantName, mutant] of reapBindingMutants(source)) {
      assertNotEquals(reapBindingViolations(await parseTs(mutant)), [], `mutant "${mutantName}" must be rejected`);
    }
    const shadowed = await parseTs(reapShadowMutant(source, REAP_STATEMENT_OF[script]));
    assertEquals(reapImportViolations(shadowed), [], "the shadow mutant keeps a correct, used import: the import rule alone cannot see it");
    assertNotEquals(reapShadowViolations(shadowed), [], "the declaration count must reject a shadow of the helper's name");
    assertNotEquals(reapBindingViolations(shadowed), [], "the binding pin must reject the shadow mutant");
  });
}

Deno.test("jjsz pin check: declarationsOf finds every form that could shadow the helper and nothing that merely mentions it", async () => {
  const table: Array<[string, string, number]> = [
    ["an import", `import { ${REAP_NAME} } from "${REAP_MODULE}";\nawait ${REAP_NAME}(1 as any);`, 1],
    ["a variable in a block", `{ const ${REAP_NAME} = 1; }`, 1],
    ["a destructured variable", `{ const { a: ${REAP_NAME} } = { a: 1 }; }`, 1],
    ["a shorthand destructured variable", `{ const { ${REAP_NAME} } = { ${REAP_NAME}: 1 }; }`, 1],
    ["an array-pattern variable", `{ const [${REAP_NAME}] = [1]; }`, 1],
    ["a function declaration in a block", `{ function ${REAP_NAME}() {} }`, 1],
    ["a function parameter", `function f(${REAP_NAME}: number) { return ${REAP_NAME}; }`, 1],
    ["a defaulted parameter", `function f(${REAP_NAME} = 1) { return ${REAP_NAME}; }`, 1],
    ["a rest parameter", `function f(...${REAP_NAME}: number[]) { return ${REAP_NAME}; }`, 1],
    ["an arrow parameter", `const g = (${REAP_NAME}: number) => ${REAP_NAME};`, 1],
    ["a catch parameter", `try { 1; } catch (${REAP_NAME}) { 1; }`, 1],
    ["a named function expression", `const h = function ${REAP_NAME}() {};`, 1],
    ["a class", `{ class ${REAP_NAME} {} }`, 1],
    ["a property key is not a declaration", `const o = { ${REAP_NAME}: 1 };`, 0],
    ["a member access is not a declaration", `const o: any = {}; o.${REAP_NAME}(1);`, 0],
    ["a call is not a declaration", `async function main() { await ${REAP_NAME}(1 as any); }`, 0],
    [
      "a nested redeclaration esbuild renames next to a live import is counted with the import",
      `import { ${REAP_NAME} } from "${REAP_MODULE}";\n{ const ${REAP_NAME} = 1; void ${REAP_NAME}; }\nvoid ${REAP_NAME};`,
      2,
    ],
    ["the renamer's numbered form is a declaration of the same name", `const ${REAP_NAME}2 = 1;`, 1],
    ["a look-alike that merely starts with the name is not a declaration", `const ${REAP_NAME}Later = 1; const ${REAP_NAME}2x = 1;`, 0],
  ];
  // The pinned scripts are modules. A fragment with no import or export is parsed as a sloppy script, and esbuild
  // lowers a block-level function in a script into a block-scoped binding plus a hoisted `var` copy under a numbered
  // name (two bindings, drilled), so each fragment is made a module the way the real scripts are.
  for (const [what, source, expected] of table) {
    assertEquals(declarationsOf(await parseTs(`export {};\n${source}`), REAP_NAME).length, expected, `${what}: ${source}`);
  }
});
