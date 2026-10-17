// tests/jjsz-lifeline-match.test.ts — chrome-agent-platform-jjsz, review finding F4.
//
// THE DEFECT. The watcher ran `pkill -9 -f "$CAP_LIFELINE_MATCH"` with the caller's text
// as an unanchored, unescaped ERE over the whole command line:
//   - prefix over-match: `user-data-dir=/x/p1` also killed `/x/p10`;
//   - `.`, `+` and `|` in a profile path change what matches (`|` makes any cmdline
//     containing the other branch a target);
//   - an unbalanced `(` or `[` made pkill exit 2, which `2>/dev/null || true` swallowed:
//     a SILENT no-op.
// `launchChrome`'s default profile names are safe, but `opts.profile` / `--user-data-dir`
// are unconstrained, and the lifeline is the crash-time trigger.
//
// THE FIX (lifeline only; killProcessTree's own free-form pgrep/pkill is deliberately
// untouched — callers pass free-form markers and it already throws on exit 2):
// `lifelineMatchPattern` escapes every ERE metacharacter and anchors the end with `( |$)`;
// a pkill that still rejects the pattern is REPORTED and never skips the group kill.
//
// SAFETY OF THIS FILE. The behavioural cases run a REAL `pkill -9 -f`, so every pattern here
// is prefixed by a unique scratch directory name: even with the fix reverted, nothing but
// this file's own throwaway processes can match. The `|` / `(` / `[` cases use only the
// non-destructive pure builder and `pgrep`.
import { assert, assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  attachProcessLifeline,
  killProcessTree,
  isolatedProcessGroup,
  lifelineMatchPattern,
  LIFELINE_SCRIPT,
  type LifelineSpawnSpec,
  lifelineState,
  type LifelineWatcher,
  liveGroupMembers,
  processGroup,
  setsidSpawnSpec,
} from "../scripts/lib/process-tree.ts";

const PGREP = "/usr/bin/pgrep";

// ── helpers ─────────────────────────────────────────────────────────────────

async function until(pred: () => boolean, ms = 8000, step = 25): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return pred();
}

async function pgrepPids(pattern: string): Promise<string[]> {
  const res = await new Deno.Command(PGREP, { args: ["-f", pattern], stdout: "piped", stderr: "piped", clearEnv: true })
    .output();
  if (res.code === 1) return [];
  if (res.code !== 0) throw new Error(`pgrep exited ${res.code} for ${JSON.stringify(pattern)}`);
  return new TextDecoder().decode(res.stdout).trim().split("\n").filter(Boolean);
}

/** Poll until at least `n` processes carry `pattern` (a pgrep -f expression). */
async function untilCarriers(pattern: string, n: number, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await pgrepPids(pattern)).length >= n) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return (await pgrepPids(pattern)).length >= n;
}

/** Poll until `pattern` (a pgrep -f expression) matches nothing. */
async function untilGone(pattern: string, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await pgrepPids(pattern)).length === 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return (await pgrepPids(pattern)).length === 0;
}

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

function spawnLeader(binary: string, args: string[]): Deno.ChildProcess {
  const spec = setsidSpawnSpec(binary, args);
  return new Deno.Command(spec.command, { args: spec.args, stdout: "null", stderr: "null", clearEnv: true }).spawn();
}

/** A process whose argv[0] is exactly `argv0` — the way Chrome's children carry --user-data-dir. */
function carrier(argv0: string): Deno.ChildProcess {
  return new Deno.Command("/bin/bash", {
    args: ["-c", 'exec -a "$1" sleep 300', "_", argv0],
    stdout: "null",
    stderr: "null",
    clearEnv: true,
  }).spawn();
}

async function reap(proc: Deno.ChildProcess): Promise<void> {
  try { Deno.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ }
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  await proc.status.catch(() => {});
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

async function afterLeaderExit(proc: Deno.ChildProcess, ms = 8000): Promise<void> {
  await proc.status;
  assert(await until(() => lifelineState(proc)?.state !== "armed", 5000), "the lifeline left 'armed'");
  assert(await settlesWithin(lifelineState(proc)?.settled, ms), `the lifeline's transition did not settle within ${ms} ms`);
}

function scratch(topic: string): string {
  return Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: `jjsz-f4-${topic}-` });
}

/**
 * Run each cleanup step in its OWN try/catch and never throw (jjsz N8). Cleanup in a `finally` must never
 * replace the assertion error that is already propagating, and one failing step must not skip the steps
 * after it. A swallowed failure is still REPORTED (stderr by default), so a leak does not go unseen: it is
 * only barred from becoming the test's verdict. Never use it for the ASSERTING part of a test.
 */
async function cleanupSteps(
  steps: Array<() => unknown>,
  report: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      report(`cleanup step failed (ignored so it cannot mask the test's own result): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * How long a sibling that must SURVIVE the lifeline's pkill is watched. It is only ever read AFTER the sweep
 * has settled and the targeted carrier's exit has been observed, so a wrongly-targeted sibling dies in the
 * same pkill pass and is seen within a few milliseconds; the window is the slack for a starved box, and it
 * is one concurrent window per test, so it costs one second, not one per sibling.
 */
const SURVIVAL_WINDOW_MS = 1000;

function fakeWatcher(): LifelineWatcher {
  let settle!: (status: { code: number; signal: string | null }) => void;
  const status = new Promise<{ code: number; signal: string | null }>((resolve) => {
    settle = resolve;
  });
  return {
    pid: 424_242,
    status,
    stdin: {
      close() {
        settle({ code: 0, signal: null });
        return Promise.resolve();
      },
    },
    kill(signo = "SIGTERM") {
      settle({ code: 137, signal: signo });
    },
  };
}

const SPECIALS = String.raw`\^$.*+?()[]{}|`;

// ── the pure builder ────────────────────────────────────────────────────────

Deno.test("lifelineMatchPattern: every ERE metacharacter is escaped and the end is anchored (jjsz F4)", () => {
  assertEquals(lifelineMatchPattern("user-data-dir=/x/p1"), "user-data-dir=/x/p1( |$)");
  assertEquals(
    lifelineMatchPattern(String.raw`a.b+c|d(e)[f]{g}*h?i^j$k\l`),
    String.raw`a\.b\+c\|d\(e\)\[f\]\{g\}\*h\?i\^j\$k\\l( |$)`,
    "each of . + | ( ) [ ] { } * ? ^ $ \\ is escaped",
  );
  assertEquals(
    lifelineMatchPattern("user-data-dir=/My Profile/é"),
    "user-data-dir=/My Profile/é( |$)",
    "spaces and non-ASCII are not metacharacters",
  );
});

Deno.test("lifelineMatchPattern: no safe pattern exists for an empty, option-looking or NUL-bearing match", () => {
  for (const unusable of [undefined, "", "-", "-x", "--user-data-dir=/x", "user-data-dir=/x\0y"]) {
    assertEquals(lifelineMatchPattern(unusable), "", `${JSON.stringify(unusable)}`);
  }
});

Deno.test("lifelineMatchPattern: the REAL pgrep accepts the pattern for every metacharacter, and it matches the literal text only (jjsz F4)", async () => {
  const id = crypto.randomUUID();
  const targets = new Map<string, Deno.ChildProcess>();
  try {
    for (const ch of SPECIALS) targets.set(ch, carrier(`jjsz-f4-${id}-${ch}-end`));
    assert(
      // A bare literal prefix (no metacharacter): all fourteen carriers are visible to it.
      await untilCarriers(`jjsz-f4-${id}-`, SPECIALS.length),
      "every carrier is running",
    );
    for (const ch of SPECIALS) {
      const pattern = lifelineMatchPattern(`jjsz-f4-${id}-${ch}-end`);
      const found = await pgrepPids(pattern); // throws if pgrep rejects the pattern (exit 2)
      assertEquals(
        found,
        [String(targets.get(ch)!.pid)],
        `${JSON.stringify(ch)}: the pattern ${pattern} matches exactly its own literal carrier`,
      );
    }
  } finally {
    for (const proc of targets.values()) await reap(proc);
  }
});

// ── the pattern reaches the watcher, built ──────────────────────────────────

Deno.test("attachProcessLifeline hands the watcher the BUILT pattern, never the raw treeMatch (jjsz F4)", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  const other = spawnLeader("/bin/sleep", ["300"]);
  try {
    const specs: LifelineSpawnSpec[] = [];
    const lines: string[] = [];
    const spawn = (spec: LifelineSpawnSpec) => {
      specs.push(spec);
      return fakeWatcher();
    };
    attachProcessLifeline(proc, { group: proc.pid, treeMatch: String.raw`user-data-dir=/x/a.b+c` }, {
      spawn,
      warn: (line) => lines.push(line),
    });
    assertEquals(specs[0].env, {
      CAP_LIFELINE_TARGET: String(proc.pid),
      CAP_LIFELINE_MATCH: String.raw`user-data-dir=/x/a\.b\+c( |$)`,
      // lsk1p: no start time was recorded for this group (isolatedProcessGroup never ran), so
      // the watcher is told "" and keeps its old "signal the old group, or nothing" behaviour.
      CAP_LIFELINE_START: "",
    });
    assertEquals(lines, [], "a usable match is not reported");

    attachProcessLifeline(other, { group: other.pid, treeMatch: "--user-data-dir=/x" }, {
      spawn,
      warn: (line) => lines.push(line),
    });
    assertEquals(specs[1].env.CAP_LIFELINE_MATCH, "", "pkill would parse a leading '-' as an option: no pattern");
    assertEquals(specs[1].env.CAP_LIFELINE_TARGET, String(other.pid), "the group kill is independent of the pattern");
    assertEquals(lines.length, 1, "dropping the pattern is reported, once");
    assert(lines[0].includes("cannot use treeMatch"), lines[0]);
    await lifelineState(proc)?.settled;
  } finally {
    await reap(proc);
    await reap(other);
  }
});

// ── behaviour: a REAL watcher fires for p1 and touches only p1 ──────────────

Deno.test("lifeline: firing for .../p1 kills ONLY p1 — not p10, not p1-extra (prefix over-match, jjsz F4)", async () => {
  const root = scratch("prefix");
  const p1 = carrier(`--user-data-dir=${root}/p1`);
  const p10 = carrier(`--user-data-dir=${root}/p10`);
  const extra = carrier(`--user-data-dir=${root}/p1-extra`);
  const leader = spawnLeader("/bin/sleep", ["300"]);
  try {
    // The raw prefix really does see all three: that is the over-match the fix must not act on.
    assert(
      await untilCarriers(`user-data-dir=${root}/p1`, 3),
      "all three carriers are running and share the prefix",
    );
    attachProcessLifeline(leader, { group: leader.pid, treeMatch: `user-data-dir=${root}/p1` });
    leader.kill("SIGKILL");
    await afterLeaderExit(leader); // the real watcher (and its pkill) has finished
    assertEquals(await exitsWithin(p1, 5000), true, "p1 is the lifeline's target: it is killed");
    const [p10Exited, extraExited] = await Promise.all([
      exitsWithin(p10, SURVIVAL_WINDOW_MS),
      exitsWithin(extra, SURVIVAL_WINDOW_MS),
    ]);
    assertEquals(p10Exited, false, "p10 only shares a prefix: it must survive");
    assertEquals(extraExited, false, "p1-extra only shares a prefix: it must survive");
  } finally {
    for (const proc of [p1, p10, extra, leader]) await reap(proc);
    await cleanupSteps([() => Deno.removeSync(root, { recursive: true })]);
  }
});

Deno.test("lifeline: a '.' and '+' in the profile path match literally — the lookalikes survive (jjsz F4)", async () => {
  const root = scratch("meta");
  const target = carrier(`--user-data-dir=${root}/q.1+x`);
  // The unescaped regex q.1+x matches this lookalike (any char, then 1s, then x) but NOT the target itself.
  const lookalike = carrier(`--user-data-dir=${root}/qZ11x`);
  const longer = carrier(`--user-data-dir=${root}/q.1+x-more`);
  const leader = spawnLeader("/bin/sleep", ["300"]);
  try {
    assert(await untilCarriers(`user-data-dir=${root}/q`, 3), "all three carriers are running");
    attachProcessLifeline(leader, { group: leader.pid, treeMatch: `user-data-dir=${root}/q.1+x` });
    leader.kill("SIGKILL");
    await afterLeaderExit(leader);
    assertEquals(await exitsWithin(target, 5000), true, "the literal path is the target: killed");
    const [lookalikeExited, longerExited] = await Promise.all([
      exitsWithin(lookalike, SURVIVAL_WINDOW_MS),
      exitsWithin(longer, SURVIVAL_WINDOW_MS),
    ]);
    assertEquals(lookalikeExited, false, "the regex lookalike must survive");
    assertEquals(longerExited, false, "a longer path with the same prefix must survive");
  } finally {
    for (const proc of [target, lookalike, longer, leader]) await reap(proc);
    await cleanupSteps([() => Deno.removeSync(root, { recursive: true })]);
  }
});

Deno.test("lifeline: a parent KILLED outright fires the watcher for p1 and still touches only p1 (jjsz F4, the crash-time trigger)", async () => {
  const root = scratch("crash");
  const p1 = carrier(`--user-data-dir=${root}/p1`);
  const p10 = carrier(`--user-data-dir=${root}/p10`);
  const childScript = `${root}/launcher-child.ts`;
  const treeUrl = new URL("../scripts/lib/process-tree.ts", import.meta.url).href;
  Deno.writeTextFileSync(
    childScript,
    `
    import { attachProcessLifeline, lifelineState, setsidSpawnSpec } from ${JSON.stringify(treeUrl)};
    const spec = setsidSpawnSpec("/bin/sleep", ["300"]);
    const leader = new Deno.Command(spec.command, { args: spec.args, stdout: "null", stderr: "null", clearEnv: true }).spawn();
    console.log("LEADER " + leader.pid);
    attachProcessLifeline(leader, { group: leader.pid, treeMatch: "user-data-dir=" + ${JSON.stringify(root)} + "/p1" });
    console.log("READY " + leader.pid + " " + lifelineState(leader)?.watcherPid);
    await new Promise(() => {});
  `,
  );
  const spec = setsidSpawnSpec(Deno.execPath(), ["run", "-A", "--no-check", childScript]);
  const child = new Deno.Command(spec.command, { args: spec.args, stdout: "piped", stderr: "piped" }).spawn();
  let leaderPid = 0;
  let seen = "";
  try {
    const reader = child.stdout.getReader();
    const dec = new TextDecoder();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !/READY \d+ \d+/.test(seen)) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value, { stream: true });
    }
    reader.releaseLock();
    const m = /READY (\d+) (\d+)/.exec(seen);
    assert(m !== null, `the child must attach a lifeline and report READY (got: ${seen})`);
    leaderPid = Number(m[1]);
    const watcherPid = Number(m[2]);
    assert(processGroup(leaderPid) !== null, "the child's leader is running");
    // The watcher's perl wrapper must have run setsid before the parent's GROUP is killed: until
    // then the watcher still shares that group and the kill takes it along (measured: 7 of 20
    // immediate kills orphaned the target). The lifeline's guarantee starts once it is isolated.
    assert(
      await until(() => processGroup(watcherPid)?.group === watcherPid),
      "the watcher shell is in its own session before its parent dies (a kill of the parent's GROUP cannot take it along)",
    );

    // The parent dies without any teardown: only the kernel closing the pipe can fire the watcher.
    try { Deno.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    await child.status;

    assertEquals(await exitsWithin(p1, 8000), true, "p1 is the lifeline's target: the crash-time watcher kills it");
    assertEquals(await exitsWithin(p10, SURVIVAL_WINDOW_MS), false, "p10 only shares a prefix: it must survive");
    assert(await until(() => processGroup(leaderPid) === null, 5000), "and the leader's group was reaped too");
  } finally {
    // An assertion that fired before READY was parsed must not strand the leader the child announced.
    if (leaderPid <= 1) leaderPid = Number(/LEADER (\d+)/.exec(seen)?.[1] ?? 0);
    if (leaderPid > 1) {
      try { Deno.kill(-leaderPid, "SIGKILL"); } catch { /* gone */ }
    }
    try { Deno.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    await child.status.catch(() => {});
    await reap(p1);
    await reap(p10);
    await cleanupSteps([() => Deno.removeSync(root, { recursive: true })]);
  }
});

// ── a pattern pkill still rejects is REPORTED, and the group kill is independent ──

Deno.test("lifeline: a pattern pkill rejects (exit 2) is reported once and the group kill still ran (jjsz F4)", async () => {
  const unique = `jjsz-f4-reject-${crypto.randomUUID()}`;
  // Only bash carries a marker; its sleep child is reachable ONLY through the group kill.
  const leader = spawnLeader("/bin/bash", ["-c", "sleep 300 & wait", unique]);
  try {
    const group = await isolatedProcessGroup(leader);
    assert(group !== undefined, "fixture leader must enter its isolated group");
    assert(await until(() => liveGroupMembers(group).length >= 2), "the helper is running");
    const lines: string[] = [];
    attachProcessLifeline(leader, { group, treeMatch: `user-data-dir=${unique}` }, {
      // An unbalanced "(" is a syntax error for any ERE; the unique suffix keeps even a lenient
      // pkill from matching anything but this fixture.
      matchPattern: () => `(${unique}`,
      warn: (line) => lines.push(line),
    });
    leader.kill("SIGKILL");
    await afterLeaderExit(leader);
    assertEquals(liveGroupMembers(group), [], "the group kill is independent of the pattern: the helper is gone");
    assertEquals(lines.length, 1, `exactly one report: ${JSON.stringify(lines)}`);
    assert(lines[0].includes("pkill rejected"), lines[0]);
  } finally {
    await reap(leader);
  }
});

// ── jjsz N8: cleanup in a `finally` must never replace the real assertion error ─────────────────
//
// The helper is exercised with INJECTED failing steps (a real teardown failure cannot be produced on
// demand). Drill: make the helper rethrow, or stop at the first failing step, and this test goes RED.

Deno.test("jjsz N8: the cleanup helper never throws, runs every later step after a failing one, reports the failure, and cannot replace the error already propagating", async () => {
  const ran: string[] = [];
  const reported: string[] = [];
  await cleanupSteps([
    () => {
      ran.push("synchronous step that throws");
      throw new Error("injected synchronous failure");
    },
    async () => {
      ran.push("asynchronous step that rejects");
      await Promise.resolve();
      throw new Error("injected asynchronous failure");
    },
    () => {
      ran.push("step after the failures");
    },
  ], (line) => reported.push(line));
  assertEquals(
    ran,
    ["synchronous step that throws", "asynchronous step that rejects", "step after the failures"],
    "every step ran, in order, although the ones before it failed",
  );
  assertEquals(reported.length, 2, "each swallowed failure is reported once, never silent");
  assert(reported[0].includes("injected synchronous failure"), reported[0]);
  assert(reported[1].includes("injected asynchronous failure"), reported[1]);

  // End to end through a `finally`, the shape of every site: the test's OWN error is what surfaces.
  const own = new Error("the assertion that actually failed");
  const surfaced = await assertRejects(async () => {
    try {
      throw own;
    } finally {
      await cleanupSteps([() => {
        throw new Error("injected cleanup failure");
      }], () => {});
    }
  });
  assertStrictEquals(surfaced, own, "a failing cleanup must not replace the error that was already propagating");
});

// ── the teardown path uses the SAME escaped, end-anchored pattern (chrome-agent-platform-i6lgk) ──
// killProcessTree's pkill/pgrep used the caller's treeMatch RAW while the lifeline sweep escaped and
// anchored it, so a teardown for `<profile>/p1` also signalled `<profile>/p10`. These cases run REAL
// processes and a REAL pkill, and every pattern is prefixed by a unique scratch directory, so even
// with the fix reverted nothing but this file's own throwaway carriers can match (the file's rule).

Deno.test("i6lgk: a teardown for <profile>/p1 does not signal the PREFIX-related <profile>/p10", async () => {
  const root = scratch("teardown");
  const wanted = `${root}/p1`;
  const prefixSibling = `${root}/p10`;
  const first = carrier(wanted);
  const second = carrier(prefixSibling);
  try {
    assert(await untilCarriers(wanted, 1), "the /p1 carrier is running");
    assert(await untilCarriers(lifelineMatchPattern(prefixSibling), 1), "the /p10 carrier is running");
    assertEquals(
      (await pgrepPids(wanted)).length,
      2,
      "the RAW prefix matches both carriers - this over-match is the defect under test",
    );

    await killProcessTree(null, wanted);

    assert(await untilGone(lifelineMatchPattern(wanted)), "the requested profile is gone");
    assertEquals(
      await pgrepPids(lifelineMatchPattern(prefixSibling)),
      [String(second.pid)],
      "the end anchor keeps a prefix-related profile alive: /p10 must not be signalled for /p1",
    );
  } finally {
    await reap(first);
    await reap(second);
  }
});

Deno.test("i6lgk: an unusable pattern is refused BEFORE any signal, and a live carrier is untouched", async () => {
  const marker = `${scratch("refuse")}/p1`;
  const live = carrier(marker);
  try {
    assert(await untilCarriers(lifelineMatchPattern(marker), 1), "the carrier is running");
    // NUL-bearing rather than EMPTY, deliberately: if this refusal were ever removed, an empty
    // pattern would make `pkill -9 -f ''` match every process on the host, so the empty case is
    // asserted only through the pure builder above. A NUL cannot reach pkill intact.
    await assertRejects(
      () => killProcessTree(null, `${marker}\u0000x`),
      Error,
      "cannot use treeMatch",
    );
    assertEquals(
      await pgrepPids(lifelineMatchPattern(marker)),
      [String(live.pid)],
      "the refused teardown signalled nothing",
    );
  } finally {
    await reap(live);
  }
});

// ── lsk1p: the watcher re-checks the LEADER'S IDENTITY before signalling the group ─────
//
// THE DEFECT. The watcher signals the group by NUMBER: `kill -TERM -"$T" "$T"`. If the
// leader is reaped, its pid group is empty and the pid can be handed to an unrelated
// process group (another lane's setsid child) in the window before the sweep: the watcher
// would then signal that lane's tree. The pid's start time is the kernel's identity for it,
// so the watcher now compares the recorded start against the live one and skips the group
// signal only when a process with that pid EXISTS WITH A DIFFERENT START. A pid that is
// simply absent, an unreadable /proc entry, or no record at all still means "the old group,
// or nothing" - the signal must go out, because skipping it would orphan a real browser.

/** Run the REAL watcher script (not a fake) with `start` as the recorded leader identity,
 *  close its stdin, and return its exit code: exactly what the kernel does to it when the
 *  parent dies. */
async function fireWatcher(target: number | string, start: string): Promise<number> {
  const spec = setsidSpawnSpec("/bin/sh", ["-c", LIFELINE_SCRIPT]);
  const watcher = new Deno.Command(spec.command, {
    args: spec.args,
    stdin: "piped",
    stdout: "null",
    stderr: "null",
    clearEnv: true,
    env: { CAP_LIFELINE_TARGET: String(target), CAP_LIFELINE_MATCH: "", CAP_LIFELINE_START: start },
  }).spawn();
  await watcher.stdin.close();
  const status = await watcher.status;
  return status.code;
}

/** A single process that leads its OWN group and carries `marker` as argv[0] - so the group
 *  signal `-<pid>` has exactly one visible victim and its death is the observable. */
function leaderWithMarker(marker: string): Deno.ChildProcess {
  return spawnLeader("/bin/bash", ["-c", 'exec -a "$1" sleep 300', "_", marker]);
}

// Deterministic version of the wrapper that /usr/bin/setsid sometimes creates:
// the Deno child exits while its fork becomes the session leader. This runs on
// Linux and macOS (both have /usr/bin/perl with POSIX), without relying on the
// host's incidental decision about whether setsid needs to fork.
function forcedForkedLeader(marker: string): Deno.ChildProcess {
  return new Deno.Command("/usr/bin/perl", {
    args: ["-MPOSIX", "-e",
      'my $child = fork(); defined($child) or die $!; if ($child) { POSIX::_exit(0) }; POSIX::setsid() >= 0 or die $!; exec { "/bin/bash" } "/bin/bash", "-c", \'exec -a "$1" sleep 300\', "_", $ARGV[0]; die $!',
      "--", marker],
    stdout: "null", stderr: "null", clearEnv: true,
  }).spawn();
}

Deno.test("6pao0: a forked setsid wrapper is NOT evidence that its session leader was signalled", async () => {
  const marker = `6pao0-fork-${crypto.randomUUID()}`;
  const wrapper = forcedForkedLeader(marker);
  try {
    assert(await untilCarriers(marker, 1), "the detached leader carries the unique marker");
    const pid = await requireGroupLeader(marker);
    assert(pid !== wrapper.pid, "the fixture MUST expose a forked wrapper, not accidentally test an in-place setsid");
    assert(await stillAlive(pid, 100), "the actual session leader is alive before its group is signalled");
    const start = processGroup(pid)?.startTicks;
    assert(start, "a verified group leader must have a readable identity");
    assertEquals(await fireWatcher(pid, start), 0);
    assert(await until(() => !liveProcess(pid)), "the actual leader, not the wrapper, must be reaped");
  } finally {
    await reapMarkerLeader(marker, wrapper);
  }
});

Deno.test("lsk1p: the watcher does NOT signal a group whose pid has been reused (different start)", async () => {
  const marker = `lsk1p-reused-leader-${crypto.randomUUID()}`;
  const wrapper = leaderWithMarker(marker);
  try {
    const pid = await requireGroupLeader(marker);
    const start = processGroup(pid)?.startTicks;
    assert(start, "the real group leader's identity is readable before the watcher fires");
    const bogus = start === "0" ? "1" : "0";
    const code = await fireWatcher(pid, bogus);
    assertEquals(code, 0, "a skipped group signal is a normal exit, not a failure");
    assert(await stillAlive(pid, 250), "the REAL session leader must survive a different recorded identity");
  } finally {
    await reapMarkerLeader(marker, wrapper);
  }
});

Deno.test("lsk1p: the same watcher DOES signal the group when the recorded start matches", async () => {
  const marker = `lsk1p-same-leader-${crypto.randomUUID()}`;
  const wrapper = leaderWithMarker(marker);
  try {
    const pid = await requireGroupLeader(marker);
    assert(await stillAlive(pid, 100), "the real session leader was alive before the watcher fired");
    const start = processGroup(pid)?.startTicks;
    assert(start, "the real group leader's identity is readable before the watcher fires");
    const code = await fireWatcher(pid, start);
    assertEquals(code, 0, "a fired group signal is a normal exit");
    assert(await until(() => !liveProcess(pid), 4000), "the matching identity must signal the REAL session leader");
  } finally {
    await reapMarkerLeader(marker, wrapper);
  }
});

Deno.test("lsk1p: no recorded start (legacy) still signals the group, and an absent leader exits cleanly", async () => {
  const marker = `lsk1p-no-record-${crypto.randomUUID()}`;
  const wrapper = leaderWithMarker(marker);
  try {
    const pid = await requireGroupLeader(marker);
    assert(await stillAlive(pid, 100), "the real session leader was alive before the watcher fired");
    assertEquals(await fireWatcher(pid, ""), 0, "no record = the old behaviour, a normal exit");
    assert(await until(() => !liveProcess(pid), 4000), "an empty CAP_LIFELINE_START must signal the REAL group");
  } finally {
    await reapMarkerLeader(marker, wrapper);
  }

  const goneMarker = `lsk1p-absent-${crypto.randomUUID()}`;
  const gone = leaderWithMarker(goneMarker);
  try {
    const gonePid = await requireGroupLeader(goneMarker);
    await reapMarkerLeader(goneMarker, gone);
    assert(await until(() => !liveProcess(gonePid)), "the absent fixture leader must really be gone");
    assertEquals(await fireWatcher(gonePid, "123456"), 0, "an absent leader is a clean exit, never a crash");
  } finally {
    await reapMarkerLeader(goneMarker, gone);
  }
});

Deno.test("lsk1p: attachProcessLifeline hands the watcher the leader's recorded start time", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const group = await isolatedProcessGroup(proc);
    assertEquals(group, proc.pid, "the stand-in leads its own group");
    const specs: LifelineSpawnSpec[] = [];
    attachProcessLifeline(proc, { group, treeMatch: undefined }, {
      spawn: (spec) => {
        specs.push(spec);
        return fakeWatcher();
      },
    });
    assertEquals(
      specs[0].env.CAP_LIFELINE_START,
      processGroup(proc.pid)?.startTicks,
      "the watcher is given the identity it must re-check before signalling by number",
    );
    await lifelineState(proc)?.settled;
  } finally {
    await reap(proc);
  }
});

// ── ymnpg (jjsz N3): the group signal is GROUP-ONLY, and only ever for a VERIFIED group ─────
//
// THE DEFECT (two halves, one mechanism). (1) The watcher signalled `-T T`: the second operand is the
// BARE leader pid, which is in `-T`'s group already whenever T is a verified setsid group, so it added
// nothing - except a way to signal whatever process had been handed that pid, notably in the ~100 ms
// between the TERM and the KILL once the group's leader was gone. (2) The arming rule invented a group
// from the leader's pid (`target = group ?? proc.pid`) when the launcher had confirmed NOTHING, so the
// signal path could run for a pid nobody had verified led a group. The group signal is now the group
// alone, and it is armed only when the caller passes the group `isolatedProcessGroup` recorded; with no
// verified group the sweep arms the profile pattern and WARNS, exactly as it does for an unusable
// treeMatch - the tree is never silently uncovered.

Deno.test("ymnpg: no verified group means the group-signal path is NOT armed, and it says so", async () => {
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const specs: LifelineSpawnSpec[] = [];
    const lines: string[] = [];
    const spawn = (spec: LifelineSpawnSpec) => {
      specs.push(spec);
      return fakeWatcher();
    };
    attachProcessLifeline(proc, { treeMatch: "user-data-dir=/x/ymnpg" }, { spawn, warn: (line) => lines.push(line) });
    assertEquals(
      specs[0].env.CAP_LIFELINE_TARGET,
      "",
      "without a verified group the watcher must not be handed a group to signal",
    );
    assertEquals(specs[0].env.CAP_LIFELINE_MATCH, "user-data-dir=/x/ymnpg( |$)", "the profile pattern still covers the tree");
    assertEquals(lines.length, 1, "the unarmed group path is reported, once");
    assert(lines[0].includes("no verified process group"), lines[0]);
    await lifelineState(proc)?.settled;
  } finally {
    await reap(proc);
  }
});

Deno.test("ymnpg: the sweep signals the GROUP only - a non-leader holding the target pid survives", async () => {
  // The bare operand's whole effect: a stand-in that carries the target pid but leads NO group. Its
  // start matches the recorded one, so same_leader passes and the old script reached it with the bare
  // operand while `-<pid>` matched no group at all.
  const victim = carrier("ymnpg-non-leader-victim");
  try {
    const start = processGroup(victim.pid)?.startTicks;
    assert(start !== undefined && start !== "", "the stand-in's identity is readable");
    assert(
      processGroup(victim.pid)?.group !== victim.pid,
      "the stand-in must NOT lead its own group - that is the case the bare operand reached",
    );
    assertEquals(await fireWatcher(victim.pid, start), 0, "a group signal that matches no group is not an error");
    assert(
      !(await exitsWithin(victim, 400)),
      "a non-leader holding the target pid must SURVIVE the sweep: the bare-pid operand is gone",
    );
  } finally {
    await reap(victim);
  }
});

// `setsid` may FORK: when it does, `proc.pid` is a wrapper that exits immediately and the REAL
// session leader is a child with a DIFFERENT pid. Any group-signal assertion that trusts `proc.pid`
// can therefore pass because the wrapper exited on its own (measured 2026-10-17 on this VM: 5 of 6
// spawns were observed in the parent's group at the FIRST probe (possibly still before setsid ran).
// A forced-fork fixture below proves the distinct wrapper case deterministically; either way,
// discover the live leader by a unique argv marker instead of assuming the pid handed back.
async function discoveredLeader(marker: string, ms = 4000): Promise<number | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const raw of await pgrepPids(marker)) {
      const pid = Number(raw);
      const info = processGroup(pid);
      if (info && info.group === pid && info.state !== "Z" && info.state !== "X") return pid;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null; // never return a wrapper as a candidate for a group-signal assertion
}

const liveProcess = (pid: number): boolean => {
  const info = processGroup(pid);
  return info !== null && info.state !== "Z" && info.state !== "X";
};

/** A group-signal assertion must name an actual, LIVE session leader, never the setsid wrapper. */
async function requireGroupLeader(marker: string): Promise<number> {
  const pid = await discoveredLeader(marker);
  const info = pid === null ? null : processGroup(pid);
  assert(
    pid !== null && info?.group === pid && liveProcess(pid),
    `fixture ${marker}: expected a live session leader with pid === pgid, got pid ${pid}, pgid ${info?.group}, state ${info?.state}`,
  );
  return pid;
}

/** Clean up the discovered group even when the Deno child was only a short-lived setsid wrapper. */
async function reapMarkerLeader(marker: string, wrapper: Deno.ChildProcess): Promise<void> {
  try {
    for (const raw of await pgrepPids(marker)) {
      const pid = Number(raw);
      const info = processGroup(pid);
      if (info?.group === pid && info.state !== "Z" && info.state !== "X") {
        try { Deno.kill(-pid, "SIGKILL"); } catch { /* exited */ }
      }
    }
  } finally {
    await reap(wrapper);
  }
}

/** True while `pid` is a live, non-zombie process at the END of `ms`. */
async function stillAlive(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  let sawAlive = false;
  while (Date.now() < deadline) {
    const info = processGroup(pid);
    if (!info || info.state === "Z" || info.state === "X") return false;
    sawAlive = true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return sawAlive;
}

Deno.test("ymnpg: an empty target skips the group path, while an armed verified group still reaps", async () => {
  const noGroup = leaderWithMarker("ymnpg-nogroup-leader");
  const verified = leaderWithMarker("ymnpg-verified-leader");
  const discovered: number[] = [];
  try {
    const noGroupPid = await requireGroupLeader("ymnpg-nogroup-leader");
    const verifiedPid = await requireGroupLeader("ymnpg-verified-leader");
    discovered.push(noGroupPid, verifiedPid);
    assertEquals(processGroup(verifiedPid)?.group, verifiedPid, "the discovered leader must really lead its own group");

    const noGroupStart = processGroup(noGroupPid)?.startTicks;
    const verifiedStart = processGroup(verifiedPid)?.startTicks;
    assert(noGroupStart, "the unarmed leader's identity is readable");
    assert(verifiedStart, "the armed leader's identity is readable");

    assertEquals(await fireWatcher("", noGroupStart!), 0, "an empty target is not a failure: there is simply no group to signal");
    assert(
      await stillAlive(noGroupPid, 600),
      "an unverified group must not reach the signal path, even against a real group leader",
    );

    assertEquals(await fireWatcher(verifiedPid, verifiedStart!), 0);
    assert(
      await until(() => !liveProcess(verifiedPid), 4000),
      "a verified group with a matching start is still signalled and reaped",
    );
  } finally {
    for (const pid of discovered) {
      try {
        Deno.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    await reap(noGroup);
    await reap(verified);
  }
});

// ── umuyk (round-2 review of ymnpg): a lifeline with NOTHING to sweep must say so ───────────
//
// Arming a watcher with no verified group AND no usable pattern gives it target="" and match="", so the
// real LIFELINE_SCRIPT skips BOTH signal paths - while the arming warnings claimed the profile pattern
// covered the tree. That is a coverage claim the module cannot keep, so this case is reported the same
// way a watcher that could not be started is: no watcher, state "unprotected", one warning naming the
// consequence. `launchChrome` reaches it when no profile was resolved (treeMatch undefined) and
// `isolatedProcessGroup` returned nothing; any rejected treeMatch reaches it too.

Deno.test("umuyk: no verified group AND no usable pattern reports UNPROTECTED, never an inert watcher", async () => {
  // The module signals a group only when the CALLER verified one (ymnpg/N3): a leader that happens to
  // lead its own group is still not signalled if the caller passed nothing, so these fixtures are the
  // shapes `launchChrome` uses when `isolatedProcessGroup` confirmed nothing - `{}` (which is also
  // what a caller with no profile treeMatch passes) and a rejected treeMatch.
  const noProfile = spawnLeader("/bin/sleep", ["300"]);
  const badMatch = spawnLeader("/bin/sleep", ["300"]);
  try {
    const lines: string[] = [];
    const specs: LifelineSpawnSpec[] = [];
    const spawn = (spec: LifelineSpawnSpec) => {
      specs.push(spec);
      return fakeWatcher();
    };

    const disarmA = attachProcessLifeline(noProfile, {}, { spawn, warn: (line) => lines.push(line) });
    assertEquals(specs.length, 0, "neither a group nor a pattern: a watcher could not reap anything, so none is started");
    assertEquals(lifelineState(noProfile)?.state, "unprotected", "the lifeline must report the case it cannot cover");
    assertEquals(lifelineState(noProfile)?.settled, null, "nothing was armed, so there is nothing to settle");
    assertEquals(lines.length, 1, "exactly one warning, and it must name the real consequence");
    assert(lines[0].includes("NOT protected"), lines[0]);
    assert(!lines[0].includes("arms the profile pattern only"), "it must not claim pattern coverage it does not have");
    await disarmA();

    const disarmB = attachProcessLifeline(badMatch, { treeMatch: "--user-data-dir=/x" }, { spawn, warn: (line) => lines.push(line) });
    assertEquals(specs.length, 0, "a rejected pattern plus no verified group is the same unprotected case");
    assertEquals(lifelineState(badMatch)?.state, "unprotected");
    assertEquals(lines.length, 2);
    assert(lines[1].includes("was rejected"), lines[1]);
    assert(lines[1].includes("NOT protected"), lines[1]);
    await disarmB();
  } finally {
    await reap(noProfile);
    await reap(badMatch);
  }
});
