// tests/jjsz-lifeline-process-table.test.ts — chrome-agent-platform-jjsz, review finding F2.
//
// THE DEFECT. The macOS `/bin/ps` fallbacks FAILED OPEN against the file's own contract
// ("never silently fails open"): `liveGroupMembers` answered `[]` when ps could not spawn
// or exited non-zero, and `processGroup` answered `null` ("exited") for every ps failure.
// `killProcessTree` read `[]` as "the group is empty" and `teardownChrome` then deleted the
// profile while an UNMARKED helper (argv without the profile string) was still running;
// `isolatedProcessGroup` read `null` as "exited before observation" and returned
// `undefined` for a LIVE Chrome, so a launch ran with no group tracking at all.
//
// THE CONTRACT. "Gone" / "no members" ONLY when ps ran and proved it (`ps -p <absent pid>`
// = exit 1 with EMPTY stdout AND stderr). A spawn error, any other exit status, a signal
// kill (incl. the timeout), stderr text or an unparsable listing THROWS, and a launch
// FAILS CLOSED. Every case below drives the macOS branch through the injected
// `ProcessTableDeps` seam, so it runs on Linux CI as well as on a Mac.
import { assert, assertEquals, assertRejects, assertStrictEquals, assertThrows } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  boundedCommandSpec,
  isolatedProcessGroup,
  killProcessTree,
  liveGroupMembers,
  type ProcessTableDeps,
  processGroup,
  type PsOutput,
  runBoundedProbe,
  setsidSpawnSpec,
} from "../scripts/lib/process-tree.ts";
import { type LaunchedChrome, launchChrome, teardownChrome } from "../scripts/lib/chrome-launch.ts";

const SELF = Deno.pid;
const LSTART = "Wed Oct  7 13:30:23 2026";
const PGREP = "/usr/bin/pgrep";

const out = (code: number, stdout = "", stderr = "", signal: string | null = null): PsOutput => ({
  code,
  signal,
  stdout,
  stderr,
});
const row = (pid: number, pgid: number, state: string) => `  ${pid}  ${pgid} ${state}  ${LSTART}\n`;
const mac = (ps: (args: string[]) => PsOutput): ProcessTableDeps => ({ hasProc: false, ps });
const refuses = (message: string): ProcessTableDeps =>
  mac(() => {
    throw new Error(message);
  });
/** A listing that always includes this very process, as a complete ps -ax listing does. */
const listing = (members: Array<[number, number, string]>) =>
  [[SELF, SELF + 1, "S"], ...members].map(([pid, pgid, state]) => `  ${pid}  ${pgid} ${state}\n`).join("");

const FAIL = "process table probe failed";

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

function spawnLeader(binary: string, args: string[]): Deno.ChildProcess {
  const spec = setsidSpawnSpec(binary, args);
  return new Deno.Command(spec.command, { args: spec.args, stdout: "null", stderr: "null", clearEnv: true }).spawn();
}

async function reap(proc: Deno.ChildProcess): Promise<void> {
  try { Deno.kill(-proc.pid, "SIGKILL"); } catch { /* gone */ }
  try { proc.kill("SIGKILL"); } catch { /* gone */ }
  await proc.status.catch(() => {});
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

// ── processGroup ────────────────────────────────────────────────────────────

Deno.test("processGroup: every ps failure THROWS — only exit 1 with empty stdout+stderr proves 'gone' (jjsz F2)", () => {
  const cases: Array<[string, ProcessTableDeps]> = [
    ["ps cannot spawn (EAGAIN under process pressure)", refuses("spawn EAGAIN")],
    ["ps exits 2", mac(() => out(2))],
    ["ps exits 127 (binary missing behind the wrapper)", mac(() => out(127))],
    ["exit 1 with stderr text (a bad argument also exits 1)", mac(() => out(1, "", "ps: illegal option -- Q"))],
    ["exit 1 with unexpected stdout", mac(() => out(1, "garbage"))],
    ["timed out (SIGALRM, as the bounded wrapper reports it)", mac(() => out(142, "", "", "SIGALRM"))],
    ["killed by SIGKILL", mac(() => out(137, "", "", "SIGKILL"))],
    ["a signal behind an otherwise plausible 'gone' status", mac(() => out(1, "", "", "SIGALRM"))],
    ["a signal behind an otherwise plausible success", mac(() => out(0, row(4242, 4242, "S"), "", "SIGTERM"))],
    ["exit 0 with nothing printed", mac(() => out(0))],
    ["exit 0 with an unparsable row", mac(() => out(0, "abc def ghi jkl\n"))],
    ["exit 0 with a row too short to hold lstart", mac(() => out(0, "4242 4242 S\n"))],
    ["exit 0 with a row for ANOTHER pid", mac(() => out(0, row(4243, 4243, "S")))],
    ["exit 0 with the right pid but a non-numeric pgid", mac(() => out(0, `  4242  xx S  ${LSTART}\n`))],
    ["exit 0 with two rows for one pid", mac(() => out(0, row(4242, 4242, "S") + row(4242, 4242, "S")))],
    ["exit 0 with a valid row but stderr text", mac(() => out(0, row(4242, 4242, "S"), "ps: warning"))],
  ];
  for (const [name, deps] of cases) {
    assertThrows(() => processGroup(4242, deps), Error, FAIL, `case: ${name}`);
  }
});

Deno.test("processGroup: the ps spawn error is named in the failure (the operator can see WHY)", () => {
  const err = assertThrows(() => processGroup(4242, refuses("spawn EAGAIN: resource temporarily unavailable")), Error);
  assert(err.message.includes("EAGAIN"), `the cause must survive: ${err.message}`);
  assert(err.message.includes("cannot confirm process state"), err.message);
  const timeout = assertThrows(() => processGroup(4242, mac(() => out(142, "", "", "SIGALRM"))), Error);
  assert(timeout.message.includes("timed out"), `a timeout says so: ${timeout.message}`);
});

Deno.test("processGroup: exit 1 with EMPTY stdout and stderr is the one proof of 'gone'", () => {
  assertEquals(processGroup(4242, mac(() => out(1))), null);
  assertEquals(processGroup(4242, mac(() => out(1, "  \n", "  \n"))), null, "whitespace is empty");
});

Deno.test("processGroup: parses a live row and a zombie row; asks ps for exactly this pid", () => {
  const seen: string[][] = [];
  const live = processGroup(
    4242,
    mac((args) => {
      seen.push(args);
      return out(0, row(4242, 4000, "Ss+"));
    }),
  );
  assertEquals(live, { state: "S", group: 4000, startTicks: LSTART.replace(/\s+/g, " ") });
  assertEquals(seen, [["-o", "pid=,pgid=,state=,lstart=", "-p", "4242"]]);
  assertEquals(processGroup(4242, mac(() => out(0, row(4242, 4000, "Z+"))))?.state, "Z");
});

// ── liveGroupMembers ────────────────────────────────────────────────────────

Deno.test("liveGroupMembers: a listing that cannot be read THROWS instead of reporting an empty group (jjsz F2)", () => {
  const cases: Array<[string, ProcessTableDeps]> = [
    ["ps cannot spawn", refuses("spawn EAGAIN")],
    ["ps exits 1", mac(() => out(1))],
    ["ps exits 1 although it printed a WHOLE listing (the exit status, not the content, says ps finished)", mac(() => out(1, listing([[7, 7, "S"]])))],
    ["ps exits 2", mac(() => out(2, listing([[7, 7, "S"]])))],
    ["stderr text on an otherwise good listing", mac(() => out(0, listing([[7, 7, "S"]]), "ps: warning"))],
    ["timed out", mac(() => out(142, "", "", "SIGALRM"))],
    ["a signal behind exit 0", mac(() => out(0, listing([[7, 7, "S"]]), "", "SIGTERM"))],
    ["an unparsable row", mac(() => out(0, listing([[7, 7, "S"]]) + "not a process row at all\n"))],
    ["a row with a non-numeric pgid", mac(() => out(0, listing([[7, 7, "S"]]) + "8 xx S\n"))],
    ["empty output", mac(() => out(0))],
    ["a listing without this very process (it is never absent from a whole listing)", mac(() => out(0, "  7  7 S\n  8  7 S\n"))],
  ];
  for (const [name, deps] of cases) {
    assertThrows(() => liveGroupMembers(7, deps), Error, FAIL, `case: ${name}`);
  }
});

Deno.test("liveGroupMembers: an empty group is [] ONLY from a whole, parsed listing; zombies and other groups are not members", () => {
  const seen: string[][] = [];
  const deps = mac((args) => {
    seen.push(args);
    return out(0, listing([[100, 77, "S"], [101, 77, "Z"], [102, 77, "X"], [103, 78, "S"], [104, 77, "R+"]]));
  });
  assertEquals(liveGroupMembers(77, deps), [100, 104]);
  assertEquals(liveGroupMembers(999, deps), [], "a whole listing with no member is genuinely empty");
  assertEquals(seen[0], ["-axo", "pid=,pgid=,state="]);
});

// ── the real default runner (ps behind the bounded wrapper) ─────────────────

Deno.test("the default ps runner, forced onto the fallback path, agrees with this host about this very process", () => {
  const viaPs = processGroup(SELF, { hasProc: false });
  const direct = processGroup(SELF);
  assert(viaPs !== null && direct !== null, "this process is alive");
  assertEquals(viaPs.group, direct.group, "ps and the host's own reader report the same process group");
  assert(liveGroupMembers(viaPs.group, { hasProc: false }).includes(SELF), "the real ps listing contains this process");
});

Deno.test("boundedCommandSpec: a wedged probe is ended by the kernel at the bound; a finishing one is untouched", () => {
  const wedged = boundedCommandSpec(1, "/bin/sleep", ["3"]);
  const t0 = performance.now();
  const killed = new Deno.Command(wedged.command, { args: wedged.args, stdout: "null", stderr: "null", clearEnv: true })
    .outputSync();
  const ms = performance.now() - t0;
  // The signal is the race-free proof that the KERNEL's alarm ended it: perl arms the alarm BEFORE the exec and a
  // pending alarm survives it, so the alarm always fires before a sleep that has not started yet, whatever the
  // scheduling. The 3 s sleep is the proof's ceiling: an alarm armed for 3 s or more would lose the race to the
  // sleep and end it with exit 0, so this one assertion also holds the bound below 3 s with NO wall-clock
  // threshold. The upper wall-clock bound below is only a hang guard sized for a starved box (15x the alarm).
  assertEquals(killed.signal, "SIGALRM", "the alarm, not the sleep, ended it");
  assert(ms >= 800 && ms < 15_000, `bounded at about one second, took ${Math.round(ms)} ms`);
  // `alarm 0` means NO alarm: a sub-second bound must clamp to one second, never become unbounded.
  const sub = boundedCommandSpec(0.2, "/bin/sleep", ["3"]);
  const t1 = performance.now();
  const subRun = new Deno.Command(sub.command, { args: sub.args, stdout: "null", stderr: "null", clearEnv: true })
    .outputSync();
  const subMs = performance.now() - t1;
  assertEquals(subRun.signal, "SIGALRM", "a sub-second bound is still a bound (it clamps to one second)");
  assert(subMs >= 800 && subMs < 15_000, `clamped to about one second, took ${Math.round(subMs)} ms`);
  const echo = boundedCommandSpec(5, "/bin/echo", ["hello world", "x"]);
  const fine = new Deno.Command(echo.command, { args: echo.args, stdout: "piped", stderr: "null", clearEnv: true })
    .outputSync();
  assertEquals(fine.code, 0);
  assertEquals(new TextDecoder().decode(fine.stdout), "hello world x\n", "arguments pass through intact");
  const missing = boundedCommandSpec(5, `/nonexistent/jjsz-${crypto.randomUUID()}`, []);
  const gone = new Deno.Command(missing.command, { args: missing.args, stdout: "null", stderr: "null", clearEnv: true })
    .outputSync();
  assertEquals(gone.code, 127, "a missing binary is a non-zero exit, never a silent success");
});

Deno.test("runBoundedProbe: the REAL default runner is kernel-bounded, runs under a CLEARED environment, and reports both streams, the exit status and the signal (jjsz F2)", () => {
  const t0 = performance.now();
  const wedged = runBoundedProbe("/bin/sleep", ["3"], 1);
  const ms = performance.now() - t0;
  assertEquals(wedged.signal, "SIGALRM", "a wedged probe ends as SIGALRM at the bound — it can never hang a teardown");
  // As above: the signal proves the kernel alarm ended a probe that was still sleeping (an alarm of 3 s or more would
  // lose the race to the sleep); the wall-clock bound is only the hang guard.
  assert(ms >= 800 && ms < 15_000, `bounded at about one second, took ${Math.round(ms)} ms`);
  // clearEnv: the probe inherits NOTHING (a C locale parses lstart the same everywhere; no PATH/LD_*
  // tricks reach a cleanup path). A planted variable is the witness; a perl shim that adds its own
  // variables on an older macOS cannot make this lie.
  Deno.env.set("JJSZ_PROBE_LEAK", "leaked");
  try {
    const env = runBoundedProbe("/usr/bin/env", [], 5);
    assertEquals(env.code, 0);
    assert(!env.stdout.includes("JJSZ_PROBE_LEAK"), `a planted variable must not reach the probe: ${env.stdout}`);
    assert(!/^(PATH|HOME|LANG|LC_[A-Z]+)=/m.test(env.stdout), `no inherited variable reaches the probe: ${env.stdout}`);
  } finally {
    Deno.env.delete("JJSZ_PROBE_LEAK");
  }
  const both = runBoundedProbe("/bin/sh", ["-c", "echo to-out; echo to-err >&2; exit 3"], 5);
  assertEquals(both, { code: 3, signal: null, stdout: "to-out\n", stderr: "to-err\n" });
});

// ── isolatedProcessGroup ────────────────────────────────────────────────────

Deno.test("isolatedProcessGroup: an unreadable process table REJECTS — it used to return undefined for a LIVE Chrome (jjsz F2)", async () => {
  const proc = spawnLeader("/bin/sleep", ["30"]);
  try {
    await assertRejects(() => isolatedProcessGroup(proc, refuses("spawn EAGAIN")), Error, FAIL);
    await assertRejects(() => isolatedProcessGroup(proc, mac(() => out(2))), Error, FAIL);
    await assertRejects(() => isolatedProcessGroup(proc, mac(() => out(1, "", "ps: bad argument"))), Error, FAIL);
  } finally {
    await reap(proc);
  }
});

Deno.test("isolatedProcessGroup: PROVEN gone or zombie is 'exited before observation'; a leader of its own group is returned", async () => {
  const proc = spawnLeader("/bin/sleep", ["30"]);
  try {
    assertEquals(await isolatedProcessGroup(proc, mac(() => out(1))), undefined, "ps proved it absent");
    assertEquals(
      await isolatedProcessGroup(proc, mac(() => out(0, row(proc.pid, SELF + 1, "Z")))),
      undefined,
      "a zombie that never reached its own group has exited before observation",
    );
    assertEquals(
      await isolatedProcessGroup(proc, mac(() => out(0, row(proc.pid, proc.pid, "S")))),
      proc.pid,
      "the leader of its own group is the isolated group",
    );
  } finally {
    await reap(proc);
  }
});

// ── killProcessTree ─────────────────────────────────────────────────────────

/** ps seam for killProcessTree: this process is in an unrelated group, the leader is
 *  "gone" (so no group kill is attempted), and the `-axo` listing is `listingRun`. */
function tableWith(listingRun: () => PsOutput): ProcessTableDeps {
  return mac((args) => {
    if (args[0] === "-axo") return listingRun();
    return Number(args[args.length - 1]) === SELF ? out(0, row(SELF, SELF + 1, "S")) : out(1);
  });
}

Deno.test("killProcessTree: an unreadable listing with a live UNMARKED group member REJECTS — it used to report clean (jjsz F2)", async () => {
  const marker = `jjsz-f2-${crypto.randomUUID()}`;
  // Only bash carries the marker; its `sleep` child does not, so pkill/pgrep by profile cannot see it.
  const proc = spawnLeader("/bin/bash", ["-c", "sleep 300 & wait", `user-data-dir=${marker}`]);
  try {
    const group = await isolatedProcessGroup(proc);
    assert(group !== undefined, "fixture leader must enter its isolated group");
    assert(await until(() => liveGroupMembers(group).length >= 2), "the unmarked child is running");
    await assertRejects(
      () =>
        killProcessTree(proc, `user-data-dir=${marker}`, {
          group,
          attempts: 2,
          intervalMs: 10,
          deps: tableWith(() => {
            throw new Error("spawn EAGAIN");
          }),
        }),
      Error,
      FAIL,
    );
    // The point: the old code answered "clean" here while this member was alive.
    assert(liveGroupMembers(group).length >= 1, "the unmarked member really is still running");
  } finally {
    await reap(proc);
  }
});

Deno.test("killProcessTree: the 'survived cleanup' verdict is never replaced by an unreadable-table error", async () => {
  const marker = `jjsz-f2-verdict-${crypto.randomUUID()}`;
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const group = await isolatedProcessGroup(proc);
    assert(group !== undefined);
    let listings = 0;
    const deps = tableWith(() => {
      // attempts: 2 reads the table twice in the loop; the third read (the verdict's) fails.
      if (++listings > 2) throw new Error("spawn EAGAIN");
      return out(0, listing([[999_999, group, "S"]]));
    });
    const err = await assertRejects(
      () => killProcessTree(proc, `user-data-dir=${marker}`, { group, attempts: 2, intervalMs: 5, deps }),
      Error,
      "process tree survived cleanup",
    );
    assert(err.message.includes("unreadable"), `the verdict says the table was unreadable: ${err.message}`);
    assertEquals(listings, 3);
  } finally {
    await reap(proc);
  }
});

Deno.test("killProcessTree: refusing a group THIS process belongs to is judged by the INJECTED table, like every other probe — and before any signal (jjsz F2 seam)", async () => {
  const marker = `jjsz-f2-self-${crypto.randomUUID()}`;
  const proc = spawnLeader("/bin/sleep", ["300"]);
  try {
    const group = await isolatedProcessGroup(proc);
    assert(group !== undefined, "fixture leader must enter its isolated group");
    // In THIS table the current process sits in the target group. That is impossible on a healthy
    // host, which is the point: the guard must read the table it was handed, not a second real one.
    const deps = mac((args) => (Number(args[args.length - 1]) === SELF ? out(0, row(SELF, group, "S")) : out(1)));
    await assertRejects(
      () => killProcessTree(proc, `user-data-dir=${marker}`, { group, attempts: 1, intervalMs: 5, deps }),
      Error,
      "refusing unsafe process group",
    );
    assert(processGroup(proc.pid) !== null, "the refusal came before any signal: the leader is untouched");
  } finally {
    await reap(proc);
  }
});

// ── launchChrome fails CLOSED ───────────────────────────────────────────────

Deno.test("launchChrome: an unreadable process table fails the LAUNCH closed — torn down, lock released, nothing left (jjsz F2)", async () => {
  const root = Deno.makeTempDirSync({ dir: durableDir("scratch"), prefix: "jjsz-f2-launch-" });
  const fake = `${root}/fake-browser`;
  const profile = `${root}/profile`;
  const lockPath = `${root}/scope`;
  // The helper carries the whole argv (so the profile), like Chrome's children do.
  Deno.writeTextFileSync(
    fake,
    [
      "#!/bin/bash",
      "echo 'DevTools listening on ws://127.0.0.1:31337/devtools/browser/abc' >&2",
      '( exec -a "helper $*" sleep 300 ) &',
      "wait",
      "",
    ].join("\n"),
  );
  Deno.chmodSync(fake, 0o755);
  let launched: LaunchedChrome | undefined;
  try {
    await assertRejects(
      async () => {
        launched = await launchChrome({
          binary: fake,
          profile,
          lockPath,
          timeoutMs: 5000,
          processTable: refuses("spawn EAGAIN: resource temporarily unavailable"),
        });
      },
      Error,
      FAIL,
    );
    assertEquals(launched, undefined, "no browser may come back from a launch that could not read the process table");
    assertEquals(
      await survivors(`user-data-dir=${profile}`),
      [],
      "nothing carrying the profile survives the failed launch (its teardown verified that before rejecting)",
    );
    // The exclusive scope was released: its flock holder (argv carries the lock path) is gone.
    let holders = await survivors(lockPath);
    for (let i = 0; i < 80 && holders.length > 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      holders = await survivors(lockPath);
    }
    assertEquals(holders, [], "the failed launch must release its lock");
  } finally {
    // Only reached with a live browser when the launch wrongly succeeded.
    await cleanupSteps([
      () => launched && teardownChrome(launched),
      () => teardownChrome(null, profile),
      () => Deno.removeSync(root, { recursive: true }),
    ]);
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
