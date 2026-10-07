// tests/jjsz-lifeline-leader-exit.test.ts — chrome-agent-platform-jjsz, review findings F1, F3, F5.
//
// F1. The lifeline used to DISARM when the Chrome leader exited, and `killProcessTree`
//     disarmed BEFORE it had killed or verified anything. Two consequences:
//       A. a leader-only kill (`proc.kill("SIGKILL"); await proc.status` — the shape of
//          security-suite.ts and about ten acceptance scripts, none of which call
//          teardownChrome) left the GPU/renderer/network/crashpad helpers with no watcher,
//          so a parent that then exited or died orphaned them;
//       B. a `killProcessTree` that THREW (unsafe group, pkill exit 2, unreadable table,
//          "survived cleanup") had already disarmed, so a parent dying mid-teardown left
//          nothing behind to reap the browser.
//     Now: the leader's exit triggers a ONE-SHOT SWEEP through the watcher's own kill logic,
//     `killProcessTree` disarms only after the group is verified empty, and the three states
//     (armed -> fired | disarmed) sit behind one guard.
// F3. `attachProcessLifeline` validates `group` like `killProcessTree` does and fails closed.
// F5. A watcher that cannot start says so, once, instead of silently running unprotected.
//
// The fake-watcher cases pin ORDER and IDEMPOTENCE deterministically (a real shell makes the
// close-before-kill race unobservable); the real-process cases pin the behaviour end to end.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  attachProcessLifeline,
  isolatedProcessGroup,
  killProcessTree,
  lifelineState,
  type LifelineWatcher,
  liveGroupMembers,
  type ProcessTableDeps,
  processGroup,
  type PsOutput,
  setsidSpawnSpec,
} from "../scripts/lib/process-tree.ts";
import { type LaunchedChrome, launchChrome, teardownChrome } from "../scripts/lib/chrome-launch.ts";

const PGREP = "/usr/bin/pgrep";
const SELF = Deno.pid;
const LSTART = "Wed Oct  7 13:30:23 2026";
const FAIL = "process table probe failed";

// ── helpers ─────────────────────────────────────────────────────────────────

async function until(pred: () => boolean, ms = 8000, step = 25): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return pred();
}

async function survivors(pattern: string): Promise<string[]> {
  const res = await new Deno.Command(PGREP, { args: ["-f", pattern], stdout: "piped", stderr: "piped", clearEnv: true })
    .output();
  if (res.code === 1) return [];
  if (res.code !== 0) throw new Error(`pgrep exited ${res.code}`);
  return new TextDecoder().decode(res.stdout).trim().split("\n").filter(Boolean);
}

async function untilCarriers(pattern: string, n: number, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await survivors(pattern)).length >= n) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return (await survivors(pattern)).length >= n;
}

function spawnLeader(binary: string, args: string[]): Deno.ChildProcess {
  const spec = setsidSpawnSpec(binary, args);
  return new Deno.Command(spec.command, { args: spec.args, stdout: "null", stderr: "null", clearEnv: true }).spawn();
}

async function reap(proc: Deno.ChildProcess): Promise<void> {
  try { Deno.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ }
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  await proc.status.catch(() => {});
}

/** A process whose argv[0] is exactly `argv0` — the way Chrome's helpers carry --user-data-dir. */
function carrier(argv0: string): Deno.ChildProcess {
  return new Deno.Command("/bin/bash", {
    args: ["-c", 'exec -a "$1" sleep 300', "_", argv0],
    stdout: "null",
    stderr: "null",
    clearEnv: true,
  }).spawn();
}

/** The process is proven absent from the process table (a reaped child). */
const pidGone = (pid: number) => processGroup(pid) === null;

/** True when `proc` exits within `ms`; the timer is always cleared. */
async function exitsWithin(proc: Deno.ChildProcess, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.status.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** True when `p` settles within `ms` (the timer is always cleared): a hung transition must FAIL, not stall. */
async function settlesWithin(p: Promise<unknown> | null | undefined, ms: number): Promise<boolean> {
  if (!p) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The lifeline's transition out of `armed` has finished (bounded: a sweep that never ends fails here). */
async function transitionSettled(proc: Deno.ChildProcess, ms = 8000): Promise<void> {
  assert(await settlesWithin(lifelineState(proc)?.settled, ms), `the lifeline's transition did not settle within ${ms} ms`);
}

/** After the leader exits, wait until the lifeline has left `armed` and its transition settled. */
async function afterLeaderExit(proc: Deno.ChildProcess, ms = 8000): Promise<void> {
  await proc.status;
  assert(await until(() => lifelineState(proc)?.state !== "armed", 5000), "the lifeline left 'armed'");
  await transitionSettled(proc, ms);
}

/** A watcher that records exactly what the lifeline does to it, in order. */
function fakeWatcher(
  calls: string[],
  opts: { exitCode?: number; hangs?: boolean; onKill?: () => void; onClose?: () => Promise<void> } = {},
): LifelineWatcher {
  let settle!: (status: { code: number; signal: string | null }) => void;
  const status = new Promise<{ code: number; signal: string | null }>((resolve) => {
    settle = resolve;
  });
  return {
    pid: 424_242,
    status,
    stdin: {
      close() {
        calls.push("stdin.close");
        if (!opts.hangs) settle({ code: opts.exitCode ?? 0, signal: null });
        return opts.onClose?.() ?? Promise.resolve();
      },
    },
    kill(signo = "SIGTERM") {
      calls.push(`kill:${signo}`);
      opts.onKill?.();
      settle({ code: 137, signal: signo });
    },
  };
}

const out = (code: number, stdout = "", stderr = "", signal: string | null = null): PsOutput => ({
  code,
  signal,
  stdout,
  stderr,
});
const row = (pid: number, pgid: number, state: string) => `  ${pid}  ${pgid} ${state}  ${LSTART}\n`;
const listing = (members: Array<[number, number, string]>) =>
  [[SELF, SELF + 1, "S"], ...members].map(([pid, pgid, state]) => `  ${pid}  ${pgid} ${state}\n`).join("");
/** ps seam for killProcessTree: this process is in an unrelated group, the leader is "gone"
 *  (so no group kill is attempted), and the `-axo` listing is whatever `listingRun` says. */
function tableWith(listingRun: () => PsOutput): ProcessTableDeps {
  return {
    hasProc: false,
    ps: (args) => {
      if (args[0] === "-axo") return listingRun();
      return Number(args[args.length - 1]) === SELF ? out(0, row(SELF, SELF + 1, "S")) : out(1);
    },
  };
}
const unreadable = () => tableWith(() => {
  throw new Error("spawn EAGAIN");
});

// A fake browser: a leader plus two helpers, one carrying the whole argv (so the profile) and
// one whose argv does NOT — a profile-only pkill misses it; only the group reaches it.
const FAKE_BROWSER = [
  "#!/bin/bash",
  "echo 'DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc' >&2",
  '( exec -a "helper $*" sleep 300 ) &',
  "sleep 300 &",
  "wait",
  "",
].join("\n");

// A browser one of whose helpers setsid'd itself OUT of the browser's group (Chrome's crashpad
// handler and some utility processes do) yet still carries `--user-data-dir=<profile>`: no group
// kill reaches it — only a pkill on the profile, which is what `launchChrome` hands the lifeline.
const DETACHED_HELPER_BROWSER = [
  "#!/bin/bash",
  "echo 'DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc' >&2",
  `/usr/bin/perl -MPOSIX -e 'POSIX::setsid() >= 0 or die; exec { "/bin/sleep" } "detached $ARGV[0]", "300"' -- "$*" &`,
  "sleep 300 &",
  "wait",
  "",
].join("\n");

function fixture(topic: string, script: string = FAKE_BROWSER) {
  const root = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: `jjsz-${topic}-` });
  const fake = `${root}/fake-browser`;
  Deno.writeTextFileSync(fake, script);
  Deno.chmodSync(fake, 0o755);
  return { root, fake, profile: `${root}/profile`, lockPath: `${root}/scope` };
}

/** A real leader with an UNMARKED helper in its group (only bash carries the marker). */
async function leaderWithHelper(marker: string) {
  const proc = spawnLeader("/bin/bash", ["-c", "sleep 300 & wait", `user-data-dir=${marker}`]);
  const group = await isolatedProcessGroup(proc);
  assert(group !== undefined, "fixture leader must enter its isolated group");
  assert(await until(() => liveGroupMembers(group).length >= 2), "the unmarked helper is running");
  return { proc, group };
}

// ── F1: the leader's exit sweeps the group ──────────────────────────────────

Deno.test("lifeline: a leader-only SIGKILL with the parent ALIVE sweeps the whole helper group — no teardownChrome (jjsz F1)", async () => {
  const { root, fake, profile, lockPath } = fixture("f1-leader-only");
  let launched: LaunchedChrome | undefined;
  try {
    launched = await launchChrome({ binary: fake, profile, lockPath, timeoutMs: 8000 });
    const { proc } = launched;
    const group = launched.processGroup;
    assert(group !== undefined, "the fixture launched into an isolated group");
    assert(await until(() => liveGroupMembers(group).length >= 3), "the leader and both helpers are running");
    const armed = lifelineState(proc);
    assertEquals(armed?.state, "armed");
    const watcherPid = armed?.watcherPid;
    assert(typeof watcherPid === "number" && !pidGone(watcherPid), "a live watcher is attached");

    // The shape of security-suite.ts and about ten other acceptance scripts: kill the
    // leader, reap it, and never call teardownChrome.
    proc.kill("SIGKILL");
    await proc.status;

    // This process stays alive throughout, so ONLY the leader-exit sweep can reap the helpers.
    assert(
      await until(() => liveGroupMembers(group).length === 0, 8000),
      `the sweep must reap the helpers; still alive: ${liveGroupMembers(group)}`,
    );
    const fired = lifelineState(proc);
    assertEquals(fired?.state, "fired");
    // The watcher's own pkill carries the pattern in ITS argv, so profile carriers are judged only
    // once the sweep has settled (watcher and its pkill exited).
    await transitionSettled(proc);
    assertEquals(await survivors(`user-data-dir=${profile}`), [], "the profile-carrying helper is gone too");
    assert(pidGone(watcherPid), "the spent watcher is gone — no stray shell");

    // A later, ordinary teardown over a fired lifeline neither throws nor hangs.
    await teardownChrome(launched);
    assertEquals(lifelineState(proc)?.state, "fired", "a fired lifeline stays fired");
  } finally {
    if (launched) {
      try { Deno.kill(-launched.proc.pid, "SIGKILL"); } catch { /* gone */ }
    }
    await teardownChrome(null, profile);
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("lifeline: launchChrome hands the sweep the PROFILE marker — a helper that left the browser's group is reaped when the leader dies (jjsz F1/F4)", async () => {
  const { root, fake, profile, lockPath } = fixture("f1-detached", DETACHED_HELPER_BROWSER);
  const detached = `^detached .*user-data-dir=${profile}`;
  let launched: LaunchedChrome | undefined;
  try {
    launched = await launchChrome({ binary: fake, profile, lockPath, timeoutMs: 8000 });
    const { proc } = launched;
    const group = launched.processGroup;
    assert(group !== undefined, "the fixture launched into an isolated group");
    assert(await untilCarriers(detached, 1), "the detached helper is running");
    const helperPid = Number((await survivors(detached))[0]);
    assert(helperPid > 1, `the detached helper has a pid (got ${helperPid})`);
    assertEquals(processGroup(helperPid)?.group, helperPid, "the helper leads a group of its own");
    assert(!liveGroupMembers(group).includes(helperPid), "so the browser's group kill cannot reach it — only the profile marker can");

    // A leader-only kill with this process alive: the sweep is the only thing that can run.
    proc.kill("SIGKILL");
    await afterLeaderExit(proc);
    assertEquals(lifelineState(proc)?.state, "fired");
    const reaped = () => {
      const seen = processGroup(helperPid);
      return seen === null || seen.state === "Z";
    };
    assert(await until(reaped, 8000), "the sweep's profile pkill reaped the helper that sits outside the group");
    assertEquals(await survivors(`user-data-dir=${profile}`), [], "nothing carries the profile any more");
  } finally {
    if (launched) {
      try { Deno.kill(-launched.proc.pid, "SIGKILL"); } catch { /* gone */ }
    }
    await teardownChrome(null, profile);
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("lifeline: a normal teardownChrome ends with an empty group, no error, a DISARMED lifeline and no stray watcher (jjsz F1c)", async () => {
  const { root, fake, profile, lockPath } = fixture("f1-normal");
  let launched: LaunchedChrome | undefined;
  try {
    launched = await launchChrome({ binary: fake, profile, lockPath, timeoutMs: 8000 });
    const { proc } = launched;
    const group = launched.processGroup;
    assert(group !== undefined, "the fixture launched into an isolated group");
    assert(await until(() => liveGroupMembers(group).length >= 3), "the leader and both helpers are running");
    const watcherPid = lifelineState(proc)?.watcherPid;
    assert(typeof watcherPid === "number" && !pidGone(watcherPid), "a live watcher is attached");

    await teardownChrome(launched);

    assertEquals(liveGroupMembers(group), [], "an empty group");
    const after = lifelineState(proc);
    assertEquals(after?.state, "disarmed", "a normal teardown disarms; it never fires");
    await transitionSettled(proc);
    assert(pidGone(watcherPid), "no stray watcher shell survives a normal teardown");
  } finally {
    if (launched) {
      try { Deno.kill(-launched.proc.pid, "SIGKILL"); } catch { /* gone */ }
    }
    await teardownChrome(null, profile);
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("lifeline: the disarm of a verified teardown never runs the watcher's kill — a bystander carrying only the lifeline's pattern survives (jjsz F1c)", async () => {
  const marker = `jjsz-f1-leader-${crypto.randomUUID()}`;
  const bystanderMarker = `jjsz-f1-bystander-${crypto.randomUUID()}`;
  const bystander = new Deno.Command("/bin/bash", {
    args: ["-c", 'exec -a "$1" sleep 300', "_", bystanderMarker],
    stdout: "null",
    stderr: "null",
    clearEnv: true,
  }).spawn();
  const { proc, group } = await leaderWithHelper(marker);
  try {
    // The bystander is outside the leader's group; ONLY the watcher's pkill (the lifeline's own
    // treeMatch) could reach it. killProcessTree below uses a DIFFERENT marker.
    assert(await untilCarriers(bystanderMarker, 1), "the bystander is running with its marker");
    attachProcessLifeline(proc, { group, treeMatch: bystanderMarker });
    const watcherPid = lifelineState(proc)?.watcherPid;
    assert(typeof watcherPid === "number" && !pidGone(watcherPid), "a real watcher is attached");

    await killProcessTree(proc, `user-data-dir=${marker}`, { group });

    assertEquals(liveGroupMembers(group), []);
    const after = lifelineState(proc);
    assertEquals(after?.state, "disarmed");
    assert(pidGone(watcherPid), "the disarmed watcher is reaped — no stray shell");
    assertEquals(
      (await survivors(bystanderMarker)).length,
      1,
      "the watcher's pkill must NOT have run: a disarm may never fire the kill on its way out",
    );
  } finally {
    await reap(proc);
    await reap(bystander);
  }
});

// ── F1: killProcessTree that THROWS leaves the lifeline ARMED ───────────────

Deno.test("killProcessTree refusing an unsafe group leaves the lifeline ARMED (jjsz F1a)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const calls: string[] = [];
    attachProcessLifeline(proc, { group: proc.pid }, { spawn: () => fakeWatcher(calls) });
    await assertRejects(
      () => killProcessTree(proc, `jjsz-f1-unsafe-${crypto.randomUUID()}`, { group: proc.pid + 1 }),
      Error,
      "refusing unsafe process group",
    );
    assertEquals(lifelineState(proc)?.state, "armed", "a refused teardown must not have disarmed");
    assertEquals(calls, [], "the watcher was neither killed nor closed");
  } finally {
    await reap(proc);
  }
});

Deno.test("killProcessTree failing on an unreadable table AFTER the leader died leaves the lifeline ARMED and does not sweep (jjsz F1a)", async () => {
  const marker = `jjsz-f1-throw-${crypto.randomUUID()}`;
  const { proc, group } = await leaderWithHelper(marker);
  try {
    const calls: string[] = [];
    attachProcessLifeline(proc, { group, treeMatch: `user-data-dir=${marker}` }, { spawn: () => fakeWatcher(calls) });
    await assertRejects(
      () => killProcessTree(proc, `user-data-dir=${marker}`, { group, attempts: 2, intervalMs: 10, deps: unreadable() }),
      Error,
      FAIL,
    );
    assertEquals(await exitsWithin(proc, 2000), true, "the leader really did exit during the failed teardown");
    assertEquals(lifelineState(proc)?.state, "armed", "a failed teardown leaves the watchdog armed");
    assertEquals(calls, [], "the leader's exit during a running teardown is the teardown's to handle: no sweep, no disarm");
    assert(liveGroupMembers(group).length >= 1, "the unmarked helper is exactly what a parent death would orphan");
  } finally {
    await reap(proc);
  }
});

Deno.test("killProcessTree whose pkill is rejected (exit 2) leaves the lifeline ARMED (jjsz F1a)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const calls: string[] = [];
    attachProcessLifeline(proc, { group: proc.pid }, { spawn: () => fakeWatcher(calls) });
    await assertRejects(
      () => killProcessTree(proc, `jjsz-f1-(unbalanced-${crypto.randomUUID()}`),
      Error,
      "pkill exited",
    );
    assertEquals(lifelineState(proc)?.state, "armed");
    assertEquals(calls, []);
  } finally {
    await reap(proc);
  }
});

Deno.test("killProcessTree that reports 'survived cleanup' leaves the lifeline ARMED (jjsz F1a)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const group = await isolatedProcessGroup(proc);
    assert(group !== undefined);
    const calls: string[] = [];
    attachProcessLifeline(proc, { group }, { spawn: () => fakeWatcher(calls) });
    const deps = tableWith(() => out(0, listing([[999_999, group, "S"]])));
    await assertRejects(
      () =>
        killProcessTree(proc, `jjsz-f1-survive-${crypto.randomUUID()}`, { group, attempts: 2, intervalMs: 5, deps }),
      Error,
      "process tree survived cleanup",
    );
    assertEquals(lifelineState(proc)?.state, "armed");
    assertEquals(calls, []);
  } finally {
    await reap(proc);
  }
});

Deno.test("lifeline: a parent that dies in the middle of a FAILED teardown still gets its browser reaped (jjsz F1 falsification B, real processes)", async () => {
  const { root, fake, profile, lockPath } = fixture("f1-midteardown");
  const childScript = `${root}/launcher-child.ts`;
  const launchUrl = new URL("../scripts/lib/chrome-launch.ts", import.meta.url).href;
  const treeUrl = new URL("../scripts/lib/process-tree.ts", import.meta.url).href;
  // The child launches the fake browser, then runs a killProcessTree whose process table is
  // unreadable: it kills the leader and the profile-carrying helper, cannot verify the group,
  // and THROWS — the unmarked helper is still alive. It then waits to be killed.
  Deno.writeTextFileSync(
    childScript,
    `
    import { launchChrome } from ${JSON.stringify(launchUrl)};
    import { killProcessTree, lifelineState } from ${JSON.stringify(treeUrl)};
    const SELF = Deno.pid;
    const launched = await launchChrome({
      binary: ${JSON.stringify(fake)},
      profile: ${JSON.stringify(profile)},
      lockPath: ${JSON.stringify(lockPath)},
      timeoutMs: 8000,
    });
    const group = launched.processGroup;
    await new Promise((r) => setTimeout(r, 400));
    const deps = {
      hasProc: false,
      ps: (args) => {
        if (args[0] === "-axo") throw new Error("spawn EAGAIN");
        const pid = Number(args[args.length - 1]);
        return pid === SELF
          ? { code: 0, signal: null, stdout: SELF + " " + (SELF + 1) + " S  Wed Oct  7 13:30:23 2026\\n", stderr: "" }
          : { code: 1, signal: null, stdout: "", stderr: "" };
      },
    };
    let message = "";
    try {
      await killProcessTree(launched.proc, "user-data-dir=" + ${JSON.stringify(profile)}, { group, deps });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    console.log("TEARDOWN_THREW " + JSON.stringify({ message, state: lifelineState(launched.proc)?.state ?? null, group, watcher: lifelineState(launched.proc)?.watcherPid ?? null }));
    await new Promise(() => {});
  `,
  );
  const spec = setsidSpawnSpec(Deno.execPath(), ["run", "-A", "--no-check", childScript]);
  const child = new Deno.Command(spec.command, { args: spec.args, stdout: "piped", stderr: "piped" }).spawn();
  let group = 0;
  let watcherPid = 0;
  try {
    const reader = child.stdout.getReader();
    const dec = new TextDecoder();
    let seen = "";
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !seen.includes("TEARDOWN_THREW")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value, { stream: true });
    }
    reader.releaseLock();
    const line = seen.split("\n").find((l) => l.startsWith("TEARDOWN_THREW "));
    assert(line !== undefined, `the child must report its failed teardown (got: ${seen})`);
    const report = JSON.parse(line.slice("TEARDOWN_THREW ".length)) as {
      message: string;
      state: string | null;
      group: number;
      watcher: number | null;
    };
    group = report.group;
    assert(report.message.includes(FAIL), `the teardown must have failed on the unreadable table: ${report.message}`);
    assertEquals(report.state, "armed", "the failed teardown left the lifeline armed");
    assert(liveGroupMembers(group).length >= 1, "the unmarked helper survived the failed teardown");
    // The watcher must be in its own session before the parent's GROUP is killed, or that kill takes
    // it along (see the note on attachProcessLifeline): the guarantee under test starts once it is.
    const watcher = report.watcher;
    assert(watcher !== null, "the lifeline has a watcher to wait for");
    watcherPid = watcher;
    assert(
      await until(() => processGroup(watcher)?.group === watcher),
      "the watcher shell is in its own session before its parent dies",
    );

    // The parent dies mid-failure. Only the still-armed watcher can reap what is left.
    try { Deno.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    await child.status;
    assert(
      await until(() => liveGroupMembers(group).length === 0, 8000),
      `the watcher must reap the group when the parent dies after a failed teardown; alive: ${liveGroupMembers(group)}`,
    );
  } finally {
    if (group > 1) {
      try { Deno.kill(-group, "SIGKILL"); } catch { /* gone */ }
    }
    try { Deno.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    await child.status.catch(() => {});
    // The watcher's sweep ends with `pkill -9 -f '<profile>( |$)'`, which also matches the argv of the
    // profile-pattern pkill/pgrep that teardownChrome(null, ...) runs next: wait for the watcher to finish
    // so the two never overlap (each would SIGKILL the other: "pkill exited 137").
    if (watcherPid > 1) {
      await until(() => {
        const row = processGroup(watcherPid);
        return row === null || row.state === "Z";
      }, 8000);
    }
    await teardownChrome(null, profile);
    Deno.removeSync(root, { recursive: true });
  }
});

// ── F1: success path order, and the single guard (fake watcher) ─────────────

Deno.test("killProcessTree success: the watchdog is disarmed only AFTER the group is verified empty, shell killed BEFORE stdin closes (jjsz F1a/c)", async () => {
  const marker = `jjsz-f1-order-${crypto.randomUUID()}`;
  const { proc, group } = await leaderWithHelper(marker);
  try {
    const calls: string[] = [];
    let membersAtDisarm = -1;
    attachProcessLifeline(proc, { group, treeMatch: `user-data-dir=${marker}` }, {
      spawn: () =>
        fakeWatcher(calls, {
          onKill: () => {
            membersAtDisarm = liveGroupMembers(group).length;
          },
        }),
    });
    await killProcessTree(proc, `user-data-dir=${marker}`, { group });
    assertEquals(
      calls,
      ["kill:SIGKILL", "stdin.close"],
      "disarm = SIGKILL the shell, THEN close its stdin; the leader's exit mid-teardown fired nothing",
    );
    assertEquals(membersAtDisarm, 0, "the watchdog may be disarmed only once the group is verified empty");
    assertEquals(lifelineState(proc)?.state, "disarmed");
  } finally {
    await reap(proc);
  }
});

Deno.test("lifeline: the leader's exit fires the sweep exactly once — stdin closed, shell NOT killed; a later disarm is a no-op (jjsz F1b)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const calls: string[] = [];
    const disarm = attachProcessLifeline(proc, { group: proc.pid }, { spawn: () => fakeWatcher(calls) });
    proc.kill("SIGKILL");
    await afterLeaderExit(proc);
    assertEquals(calls, ["stdin.close"], "the sweep is the watcher's own kill logic: close stdin, never kill the shell");
    assertEquals(lifelineState(proc)?.state, "fired");
    await disarm();
    await disarm();
    assertEquals(calls, ["stdin.close"], "a disarm after the sweep is a no-op: nothing fires twice");
    assertEquals(lifelineState(proc)?.state, "fired");
  } finally {
    await reap(proc);
  }
});

Deno.test("lifeline: a disarm makes the leader's later exit a no-op, and a second disarm is not a second disarm (jjsz F1c)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const calls: string[] = [];
    const disarm = attachProcessLifeline(proc, { group: proc.pid }, { spawn: () => fakeWatcher(calls) });
    await disarm();
    assertEquals(calls, ["kill:SIGKILL", "stdin.close"]);
    await disarm();
    assertEquals(calls, ["kill:SIGKILL", "stdin.close"], "disarm is idempotent");
    proc.kill("SIGKILL");
    await proc.status;
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(calls, ["kill:SIGKILL", "stdin.close"], "an exit AFTER a disarm must not fire");
    assertEquals(lifelineState(proc)?.state, "disarmed");
  } finally {
    await reap(proc);
  }
});

Deno.test("lifeline: a second attach on the same proc spawns nothing and returns the same disarm (jjsz F1 idempotence)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const calls: string[] = [];
    let spawned = 0;
    const spawn = () => {
      spawned++;
      return fakeWatcher(calls);
    };
    const first = attachProcessLifeline(proc, { group: proc.pid }, { spawn });
    const second = attachProcessLifeline(proc, { group: proc.pid, treeMatch: "user-data-dir=/elsewhere" }, { spawn });
    assertEquals(spawned, 1, "one proc, one watcher");
    assert(first === second, "the same disarm comes back");
    await first();
    assertEquals(calls, ["kill:SIGKILL", "stdin.close"], "exactly one disarm ran");
  } finally {
    await reap(proc);
  }
});

Deno.test("lifeline: a leader exit that lands WHILE a disarm is still running does not fire — the state flips before any await (jjsz F1c)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const calls: string[] = [];
    const disarm = attachProcessLifeline(proc, { group: proc.pid }, {
      // The fake's stdin.close() does not return until the leader's exit has been DELIVERED, so the
      // disarm is provably still in flight when the lifeline's exit handler runs.
      spawn: () =>
        fakeWatcher(calls, {
          onClose: async () => {
            proc.kill("SIGKILL");
            await proc.status;
          },
        }),
    });
    await disarm();
    assertEquals(calls, ["kill:SIGKILL", "stdin.close"], "the exit that landed mid-disarm fired nothing");
    assertEquals(lifelineState(proc)?.state, "disarmed", "a disarm in flight is already a disarm, not an armed lifeline");
  } finally {
    await reap(proc);
  }
});

Deno.test("lifeline: a disarm that arrives while the sweep is still running waits for it and adds no kill of its own (jjsz F1c)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const calls: string[] = [];
    const disarm = attachProcessLifeline(proc, { group: proc.pid }, {
      spawn: () => fakeWatcher(calls, { hangs: true }),
      warn: () => {},
      sweepTimeoutMs: 250,
    });
    proc.kill("SIGKILL");
    await proc.status;
    assert(await until(() => lifelineState(proc)?.state === "fired", 5000), "the exit fired the sweep");
    let resolved = false;
    const pending = disarm().then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 60));
    assertEquals(resolved, false, "the disarm must wait for the sweep it found in flight (a teardown would otherwise leave a stray watcher)");
    assertEquals(calls, ["stdin.close"], "and must not kill the watcher out from under the sweep");
    assert(
      await settlesWithin(pending, 8000),
      "the disarm settles once the sweep's own overrun bound (250 ms) has fired — a sweep with no bound would hang it",
    );
    assertEquals(calls, ["stdin.close", "kill:SIGKILL"], "only the sweep's own overrun bound killed the watcher");
    assertEquals(lifelineState(proc)?.state, "fired", "the disarm did not rewrite a spent lifeline");
  } finally {
    await reap(proc);
  }
});

Deno.test("killProcessTree started while the leader-exit sweep is in flight WAITS for it — the sweep's pkill would SIGKILL the teardown's own pkill/pgrep (jjsz F1b)", async () => {
  const marker = `jjsz-f1-await-${crypto.randomUUID()}`;
  // Carries the teardown's pattern in its argv: the teardown's pkill kills it the moment that pkill runs.
  const bystander = carrier(`--user-data-dir=${marker}`);
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const held: { watcher?: LifelineWatcher } = {};
    attachProcessLifeline(proc, { group: proc.pid }, {
      spawn: () => (held.watcher = fakeWatcher([], { hangs: true })),
      warn: () => {},
      sweepTimeoutMs: 30_000,
    });
    assert(await untilCarriers(`user-data-dir=${marker}`, 1), "the bystander is running");
    proc.kill("SIGKILL");
    await proc.status;
    assert(await until(() => lifelineState(proc)?.state === "fired", 5000), "the leader's exit fired the sweep");

    // The caller proceeds to a teardown of the same browser while the sweep is still running.
    const teardown = killProcessTree(proc, `user-data-dir=${marker}`);
    assertEquals(
      await exitsWithin(bystander, 300),
      false,
      "the teardown must not run its pkill while the sweep is in flight (its pkill/pgrep would be killed by the sweep's, or kill the sweep's)",
    );
    held.watcher!.kill("SIGKILL"); // the fake's kill() settles its status: the sweep ends
    assert(await settlesWithin(teardown, 8000), "the teardown proceeds once the sweep has settled");
    await teardown;
    assertEquals(await exitsWithin(bystander, 5000), true, "and then it runs: the profile carrier is killed");
  } finally {
    await reap(proc);
    await reap(bystander);
  }
});

Deno.test("killProcessTree that THROWS before touching the leader does not strand the leader-exit sweep (jjsz F1b)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const calls: string[] = [];
    attachProcessLifeline(proc, { group: proc.pid }, { spawn: () => fakeWatcher(calls) });
    await assertRejects(
      () => killProcessTree(proc, `jjsz-f1-strand-${crypto.randomUUID()}`, { group: proc.pid + 1 }),
      Error,
      "refusing unsafe process group",
    );
    assertEquals(lifelineState(proc)?.state, "armed");
    assertEquals(calls, []);
    // The refusal touched nothing, so the leader is alive. The teardown that owned its exit is over:
    // when the leader now exits for any other reason, the sweep must run again.
    proc.kill("SIGKILL");
    await afterLeaderExit(proc);
    assertEquals(calls, ["stdin.close"], "a finished (failed) teardown no longer suppresses the leader-exit sweep");
    assertEquals(lifelineState(proc)?.state, "fired");
  } finally {
    await reap(proc);
  }
});

Deno.test("lifeline: a sweep that overruns is bounded — the watcher is SIGKILLed once and the overrun is reported (jjsz F1b)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const calls: string[] = [];
    const lines: string[] = [];
    attachProcessLifeline(proc, { group: proc.pid }, {
      spawn: () => fakeWatcher(calls, { hangs: true }),
      warn: (line) => lines.push(line),
      sweepTimeoutMs: 40,
    });
    proc.kill("SIGKILL");
    await afterLeaderExit(proc);
    assertEquals(calls, ["stdin.close", "kill:SIGKILL"], "stdin first (the trigger), the kill only on overrun");
    assertEquals(lines.length, 1);
    assert(lines[0].includes("did not finish"), lines[0]);
  } finally {
    await reap(proc);
  }
});

Deno.test("lifeline: a finished sweep leaves no timer behind — a script that kills its leader exits at once, not after the sweep's bound (jjsz F1b)", async () => {
  const root = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "jjsz-f1-timer-" });
  const childScript = `${root}/sweeper-child.ts`;
  const treeUrl = new URL("../scripts/lib/process-tree.ts", import.meta.url).href;
  // A REAL watcher and an overrun bound far beyond this test's patience: a sweep timer that is never
  // cleared holds the script's event loop open for the whole minute (the test sanitizer cannot see it).
  Deno.writeTextFileSync(
    childScript,
    `
    import { attachProcessLifeline, lifelineState, setsidSpawnSpec } from ${JSON.stringify(treeUrl)};
    const spec = setsidSpawnSpec("/bin/sleep", ["300"]);
    const leader = new Deno.Command(spec.command, { args: spec.args, stdout: "null", stderr: "null", clearEnv: true }).spawn();
    console.log("LEADER " + leader.pid);
    attachProcessLifeline(leader, { group: leader.pid }, { sweepTimeoutMs: 60_000 });
    leader.kill("SIGKILL");
    await leader.status;
    await lifelineState(leader)?.settled;
    console.log("SETTLED " + lifelineState(leader)?.state);
  `,
  );
  const spec = setsidSpawnSpec(Deno.execPath(), ["run", "-A", "--no-check", childScript]);
  const child = new Deno.Command(spec.command, { args: spec.args, stdout: "piped", stderr: "piped" }).spawn();
  let seen = "";
  try {
    const reader = child.stdout.getReader();
    const dec = new TextDecoder();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !/SETTLED \w+/.test(seen)) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value, { stream: true });
    }
    reader.releaseLock();
    assert(/SETTLED fired/.test(seen), `the leader's exit fires the sweep and the sweep settles (got: ${JSON.stringify(seen)})`);
    assertEquals(
      await exitsWithin(child, 10_000),
      true,
      "the script exits promptly once the sweep has settled — a sweep timer that is never cleared would hold it for the 60 s bound",
    );
  } finally {
    const leader = Number(/LEADER (\d+)/.exec(seen)?.[1] ?? 0);
    if (leader > 1) {
      try { Deno.kill(-leader, "SIGKILL"); } catch { /* gone */ }
    }
    try { Deno.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    await child.status.catch(() => {});
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("lifeline: a sweep whose watcher reports a pkill rejection (exit 3) says so exactly once; a clean one is silent (jjsz F4)", async () => {
  for (const [exitCode, expected] of [[3, 1], [0, 0]] as const) {
    const proc = spawnLeader("/bin/sleep", ["300"]);
    try {
      const lines: string[] = [];
      attachProcessLifeline(proc, { group: proc.pid }, {
        spawn: () => fakeWatcher([], { exitCode }),
        warn: (line) => lines.push(line),
      });
      proc.kill("SIGKILL");
      await afterLeaderExit(proc);
      assertEquals(lines.length, expected, `exit ${exitCode}: ${JSON.stringify(lines)}`);
      if (expected === 1) assert(lines[0].includes("pkill rejected"), lines[0]);
    } finally {
      await reap(proc);
    }
  }
});

// ── F3: group validation ────────────────────────────────────────────────────

Deno.test("attachProcessLifeline: refuses an unsafe group — fail closed, nothing spawned, nothing registered (jjsz F3)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  const other = spawnLeader("/bin/sleep", ["300"]);
  try {
    let spawned = 0;
    const deps = {
      spawn: () => {
        spawned++;
        return fakeWatcher([]);
      },
      warn: () => {},
    };
    const bad: Array<[string, number, string]> = [
      ["zero", 0, "greater than 1"],
      ["one (kill -TERM -1 signals everything the caller may signal)", 1, "greater than 1"],
      ["negative", -1, "greater than 1"],
      ["this process's own pid", Deno.pid, "this process's own pid"],
      ["fractional", 1.5, "not a safe integer"],
      ["NaN", NaN, "not a safe integer"],
      ["Infinity", Infinity, "not a safe integer"],
      ["beyond the safe integers", Number.MAX_SAFE_INTEGER + 2, "not a safe integer"],
      ["another process's pid (not the leader's own)", proc.pid + 1, "not the leader's own pid"],
    ];
    for (const [name, group, reason] of bad) {
      // Each check is pinned by ITS reason: a value two checks would both refuse must not let one
      // of them be deleted unnoticed.
      const err = assertThrows(() => attachProcessLifeline(proc, { group }, deps), Error, "refusing unsafe process group", name);
      assert(err.message.includes(reason), `${name}: refused for the right reason (${reason}): ${err.message}`);
    }
    assertEquals(spawned, 0, "no watcher is ever started for an unsafe group");
    assertEquals(lifelineState(proc), undefined, "and nothing is registered for the proc");

    // The legitimate shapes are still accepted: the leader's own pid, and the default.
    attachProcessLifeline(proc, { group: proc.pid }, deps);
    attachProcessLifeline(other, {}, deps);
    assertEquals(spawned, 2);
    assertEquals(lifelineState(proc)?.state, "armed");
    assertEquals(lifelineState(other)?.state, "armed");
  } finally {
    await reap(proc);
    await reap(other);
  }
});

// ── F5: a watcher that cannot start says so ─────────────────────────────────

Deno.test("attachProcessLifeline: a watcher that cannot start says so ONCE — this browser is NOT protected — and returns a no-op (jjsz F5)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const lines: string[] = [];
    const failing = () => {
      throw new Error("spawn EAGAIN: resource temporarily unavailable");
    };
    const disarm = attachProcessLifeline(proc, { group: proc.pid }, { spawn: failing, warn: (line) => lines.push(line) });
    assertEquals(lines.length, 1, "exactly one diagnostic line");
    assert(lines[0].includes("NOT protected"), lines[0]);
    assert(lines[0].includes("EAGAIN"), `the cause is named: ${lines[0]}`);
    assert(lines[0].includes(String(proc.pid)), "the browser is named");
    assert(!lines[0].includes("\n"), "it is one line");
    assertEquals(lifelineState(proc)?.state, "unprotected");
    await disarm(); // a no-op that never throws
    const again = attachProcessLifeline(proc, { group: proc.pid }, { spawn: failing, warn: (line) => lines.push(line) });
    assert(again === disarm, "a second attach returns the same no-op");
    assertEquals(lines.length, 1, "and does not warn again");
    // An unprotected browser still tears down normally.
    await killProcessTree(proc, `jjsz-f5-${crypto.randomUUID()}`);
  } finally {
    await reap(proc);
  }
});

Deno.test("attachProcessLifeline: the default sink for the unprotected-browser line is stderr (console.error) (jjsz F5)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    attachProcessLifeline(proc, { group: proc.pid }, {
      spawn: () => {
        throw new Error("ENOENT: perl not found");
      },
    });
  } finally {
    console.error = original;
    await reap(proc);
  }
  assertEquals(lines.length, 1, JSON.stringify(lines));
  assert(lines[0].includes("NOT protected") && lines[0].includes("ENOENT"), lines[0]);
});
