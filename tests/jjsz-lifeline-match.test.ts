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
  isolatedProcessGroup,
  lifelineMatchPattern,
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
