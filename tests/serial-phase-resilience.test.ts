// tests/serial-phase-resilience.test.ts — chrome-agent-platform-6yrq
//
// Proves the serial gate phase is resilient against indefinite wedges:
//   1. runSerialFile (scripts/lib/serial-phase.mjs) executes serial hazard files
//      with process isolation and per-file timeouts (CAP_SERIAL_TEST_TIMEOUT_MS);
//      a hung child is terminated with SIGKILL and returns exit 124 rather than
//      hanging the runner for hours (xn2q item 3 / 6yrq).
//   2. Behavioural /tmp cleanliness: running the lock tests cleans all temporary
//      lock files and directories, leaving zero leaked locks in /tmp.
//   3. source pin: chrome-launch cancels stderr reader on proc exit, releasing
//      the stream and preventing do_epoll_wait hangs on orphaned grandchild fds.

import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { runSerialFile } from "../scripts/lib/serial-phase.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * iypw instruments. The reference's premise record, a SIGCONT-based liveness instrument that
 * matches the one the assertion uses, and readings that make a failure attributable instead of
 * a bare boolean.
 */
type GrandchildRecord = { sleeper: number; child: number; pgrp: number; childPgrp: number };
/**
 * The probe source both pozs tests write and run (iypw). It leaves an ORPHAN: an intermediate
 * bash backgrounds `sleep 300` and exits, so the sleeper is a grandchild in the child's process
 * group but is NOT a direct child of the Deno runtime — which is the only shape in which the
 * runner's own process-group kill is the thing being measured (Deno removes the children it
 * spawned when it exits normally; measured 2026-09-23).
 *
 * It records its PREMISE, observed rather than assumed: the orphan's pid, the child's own pid,
 * and — read from /proc — the orphan's process group and the child's own process group. Without
 * the orphan's group id a later "no descendant remains" pass is unfalsifiable: an orphan that was
 * never in the child's group could never have been reached by a `-pid` group kill.
 *
 * `hang: true` never finishes (the timeout path); `hang: false` passes immediately (the residual
 * path, where only the runner's tail kill can reach the orphan).
 */
function probeSource(pidFile: string, { hang }: { hang: boolean }): string {
  return `const b = new Deno.Command("bash", {
  args: ["-c", "sleep 300 & echo $! > ${pidFile}.sleep"],
  stdout: "null",
  stderr: "null",
});
b.outputSync();
const sleeper = Number((await Deno.readTextFile("${pidFile}.sleep")).trim());
const pgrpOf = async (pid: number) => {
  const stat = await Deno.readTextFile("/proc/" + pid + "/stat");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
};
await Deno.writeTextFile("${pidFile}", JSON.stringify({
  sleeper,
  child: Deno.pid,
  pgrp: await pgrpOf(sleeper),
  childPgrp: await pgrpOf(Deno.pid),
}));
Deno.test("${hang ? "leaves an orphan and hangs" : "passes leaving an orphan"}", async () => {
${hang ? "  setInterval(() => {}, 1000);\n  await new Promise(() => {});" : "  // returns immediately"}
});
`;
}

/** The premise both pozs tests must observe before any outcome assertion is meaningful (iypw). */
function assertPremise(recorded: GrandchildRecord, who: string): void {
  assert(
    recorded.sleeper > 0 && recorded.child > 0 && recorded.pgrp > 0 && recorded.childPgrp > 0,
    `${who} must have recorded its premise (orphan pid, own pid, both process groups) — if this ` +
      `fires, the CHILD never reached its first action (a boot/module-load failure under load, NOT ` +
      `a surviving descendant): record=${JSON.stringify(recorded)} load1=${load1()}`,
  );
  assert(
    recorded.pgrp === recorded.childPgrp,
    `PREMISE FALSE: the orphan's process group is ${recorded.pgrp} but the child's is ` +
      `${recorded.childPgrp}, so the orphan was NOT in a group that \`kill(-${recorded.child})\` ` +
      `targets — this run cannot show anything about a process-group kill (record=${JSON.stringify(recorded)})`,
  );
}


async function readRecord(pidFile: string): Promise<GrandchildRecord> {
  const text = await Deno.readTextFile(pidFile).catch(() => "");
  try {
    const parsed = JSON.parse(text) as GrandchildRecord;
    return {
      sleeper: Number(parsed.sleeper) || 0,
      child: Number(parsed.child) || 0,
      pgrp: Number(parsed.pgrp) || 0,
      childPgrp: Number(parsed.childPgrp) || 0,
    };
  } catch {
    return { sleeper: 0, child: 0, pgrp: 0, childPgrp: 0 };
  }
}

/**
 * The liveness question is the WRONG one (iypw). SIGCONT succeeds for a zombie as well as for a
 * running process, and a kill that has landed may sit unreaped for a while under load — so an
 * "is it alive?" instrument reports a killed orphan as a survivor and reds a healthy run (observed
 * in the parallel phase: the group kill returned OK, the orphan was a zombie, the assertion failed).
 * What the property needs is the STATE: gone (reaped), zombie (killed, not yet reaped), or alive
 * (survived) — and only "alive" after a bounded wait is a failure.
 */
async function outcomeFor(pid: number, budgetMs = 3_000): Promise<"gone" | "zombie" | "alive"> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    let state = "";
    try {
      const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
      state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]; // field 3 of /proc/pid/stat
    } catch {
      return "gone";
    }
    if (state === "Z" || state === "X") return "zombie";
    if (Date.now() > deadline) return "alive";
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The instrument's reading, for a failure message: state plus the SIGCONT result. */
async function outcomeReading(pid: number): Promise<string> {
  let state = "?";
  try {
    const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
    state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
  } catch {
    state = "gone";
  }
  return `state=${state} /procExists=${existsProc(pid)} killResult=${killReading(pid)}`;
}

function existsProc(pid: number): boolean {
  try {
    Deno.statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

function killReading(pid: number): string {
  try {
    Deno.kill(pid, "SIGCONT");
    return "SIGCONT succeeded => alive";
  } catch (e) {
    return `SIGCONT threw => ${(e as Error).name}`;
  }
}

function load1(): string {
  try {
    return Deno.readTextFileSync("/proc/loadavg").split(" ")[0];
  } catch {
    return "?";
  }
}

Deno.test("6yrq: runSerialFile times out a hanging test boundedly and returns exit 124", async () => {
  // Spawn a real test script that hangs indefinitely via an unresolving promise.
  // runSerialFile must enforce timeoutMs, kill the child with SIGKILL, and return code 124.
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-hang-probe-" });
  const tempTest = `${tempDir}/hang.test.ts`;
  await Deno.writeTextFile(
    tempTest,
    `// Hanging probe for 6yrq
Deno.test("hangs indefinitely", async () => {
  await new Promise((r) => setTimeout(r, 60000));
});
`,
  );

  try {
    const res = runSerialFile(tempTest, {
      timeoutMs: 1500,
      stdio: "pipe",
      cwd: ROOT,
    });
    assertEquals(res.code, 124, `hanging child must be terminated with exit 124; got ${res.code}`);
    assertEquals(res.timedOut, true, "runner must report timedOut: true");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("6yrq: lock tests clean up temporary lock files and leave /tmp clean", async () => {
  // Attribution, not a shared-prefix scan (chrome-agent-platform-p15i): with
  // ~8 lanes sharing /tmp, a scan for `cap-chrome-lock-test-*` also matches a
  // CONCURRENT lane's fixtures, and a foreign file was flagged as our leak — a
  // false red that tempts retry-until-green. The child reports its own fixture
  // path(s) as CAP_LOCK_FIXTURE:<path> lines; we assert exactly those are gone.
  // A killed child still attributes correctly: the marker is printed at start,
  // and the residue is then genuinely ours.
  const res = runSerialFile("tests/chrome-launch-lock.test.ts", {
    stdio: "pipe",
    cwd: ROOT,
  });
  assertEquals(res.code, 0, "chrome-launch-lock must pass cleanly");

  const out = new TextDecoder().decode(res.stdout ?? new Uint8Array());
  const fixtures = [...out.matchAll(/^CAP_LOCK_FIXTURE:(\S+)$/gm)].map((m) => m[1]);
  assert(fixtures.length > 0, "the child must report its fixture paths (marker protocol broken — never pass vacuously)");
  const leaked = [];
  for (const fixture of fixtures) {
    try {
      await Deno.lstat(fixture);
      leaked.push(fixture);
    } catch { /* gone, as required */ }
  }
  assertEquals(leaked, [], `lock tests must not leak their own temporary lock files: ${leaked.join(", ")}`);
});

// iypw — WHAT THESE TESTS CAN AND CANNOT FALSIFY (all measured 2026-09-23, ~/cap-evidence/iypw/):
//
// The property "a timed-out serial file leaves no descendant behind" is delivered TWICE on the
// timeout path, and this test cannot tell the two mechanisms apart:
//   1. spawnSync's own `timeout` + `killSignal: "SIGKILL"` — measured GROUP-WIDE in this runtime:
//      a bash that backgrounds `sleep 300` and then execs a long sleep leaves the background
//      sleeper GONE after spawnSync's timeout with no explicit group kill anywhere. Control:
//      killing ONLY the direct child pid by hand leaves that same sleeper SURVIVED.
//   2. the explicit `process.kill(-r.pid, "SIGKILL")` in the ETIMEDOUT branch.
// CONSEQUENCE: deleting mechanism 2 does NOT red this test (6/6 runs passed with it removed).
// That was this bead's "flap" — the property still holds via mechanism 1, so nothing was lost;
// the historic 2-of-4 reds were most plausibly htl8's pid-file race firing the OTHER assertion.
// So this test asserts the PROPERTY (with its premise observed, below), NOT the explicit kill.
//
// The explicit kill HAS a unique, falsifiable contract on the residual path, and it is the test
// beneath this one. Why the fixture there must leave an ORPHAN rather than a direct child:
// a Deno process kills the children IT spawned when it exits normally (measured: a `deno run`
// and a `deno test` that spawn `sleep` and exit leave it gone; plain bash and a plain
// spawnSync normal return leave it alive), so a direct child cannot show what the runner's group
// kill does. An orphan made by an intermediate that exits is never registered with Deno and
// SURVIVES its parent's normal exit — measured — which makes the residual kill the only thing
// that can remove it.
Deno.test("pozs: timed-out serial file leaves no descendant processes behind (property, not one mechanism)", async () => {
  // Spawn a real test script that launches a long-lived background grandchild process and then
  // hangs. runSerialFile must enforce timeoutMs and ensure no descendant survives as an orphan
  // holding fds/locks.
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-grandchild-probe-" });
  const pidFile = `${tempDir}/grandchild.pid`;
  const tempTest = `${tempDir}/grandchild-hang.test.ts`;
  await Deno.writeTextFile(tempTest, probeSource(pidFile, { hang: true }));

  let grandchildPid = 0;
  try {
    const res = runSerialFile(tempTest, {
      // The property is "a TIMED-OUT serial file leaves no descendant behind", so the bound only
      // has to sit far below the orphan's 300 s sleep: 10 s leaves a loaded box room to boot Deno
      // and stays 30x smaller than the sleeper. Deliberately NOT a boot-time assertion (htl8).
      timeoutMs: 10_000,
      stdio: "pipe",
      cwd: ROOT,
    });
    assertEquals(res.code, 124, `timed out child must return exit 124; got ${res.code}`);
    assertEquals(res.timedOut, true, "runner must report timedOut: true");

    const recorded = await readRecord(pidFile);
    grandchildPid = recorded.sleeper;
    assertPremise(recorded, "the timed-out child");
    const outcome = await outcomeFor(grandchildPid);
    assert(
      outcome !== "alive",
      `orphan PID ${grandchildPid} must not survive the runner's timeout — instrument readings: ` +
        `${await outcomeReading(grandchildPid)} record=${JSON.stringify(recorded)}`,
    );
  } finally {
    if (grandchildPid > 0) {
      try { Deno.kill(grandchildPid, "SIGKILL"); } catch { /* gone */ }
    }
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

// The falsifiable contract of the EXPLICIT process-group kill (iypw): the child EXITS NORMALLY
// (exit 0, timedOut false) while an orphan lives on, so no timeout kill happens and the orphan is
// not one of Deno's own children — the only mechanism that can reach it is the residual
// `process.kill(-r.pid, "SIGKILL")`.
// MUTANT THAT MUST RED THIS: delete the second `process.kill(-r.pid, "SIGKILL")` in
// scripts/lib/serial-phase.mjs. Measured before writing this test: with that line removed, the
// orphan SURVIVED this exact scenario (spawnSync detached, child exit 0, no timeout).
Deno.test("pozs: a serial file that EXITS while its orphan lives leaves no descendant (residual group kill)", async () => {
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-residual-probe-" });
  const pidFile = `${tempDir}/grandchild.pid`;
  const tempTest = `${tempDir}/exits-with-orphan.test.ts`;
  await Deno.writeTextFile(tempTest, probeSource(pidFile, { hang: false }));

  let grandchildPid = 0;
  try {
    const res = runSerialFile(tempTest, { timeoutMs: 30_000, stdio: "pipe", cwd: ROOT });
    assertEquals(res.code, 0, `this probe must EXIT NORMALLY (no timeout kill may help): got ${res.code}`);
    assertEquals(res.timedOut, false, "this probe must not be a timeout, or it tests the other path");

    const recorded = await readRecord(pidFile);
    grandchildPid = recorded.sleeper;
    assertPremise(recorded, "the normally-exiting child");
    const outcome = await outcomeFor(grandchildPid);
    assert(
      outcome !== "alive",
      `orphan PID ${grandchildPid} must not survive a NORMAL exit of the serial file — nothing ` +
        `else can remove it, so this failing means the residual process-group kill did not run. ` +
        `Instrument readings: ${await outcomeReading(grandchildPid)} record=${JSON.stringify(recorded)}`,
    );
  } finally {
    if (grandchildPid > 0) {
      try { Deno.kill(grandchildPid, "SIGKILL"); } catch { /* gone */ }
    }
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("source pin: serial-phase spawns detached and kills process group on timeout", async () => {
  const src = await Deno.readTextFile(`${ROOT}scripts/lib/serial-phase.mjs`);
  assert(
    src.includes("detached: true"),
    "scripts/lib/serial-phase.mjs must spawn tests detached to establish a process group",
  );
  assert(
    src.includes("process.kill(-r.pid, \"SIGKILL\")"),
    "scripts/lib/serial-phase.mjs must kill the process group (-r.pid) on timeout",
  );
});

Deno.test("source pin: chrome-launch cancels stderr reader on proc exit", async () => {
  const src = await Deno.readTextFile(`${ROOT}scripts/lib/chrome-launch.ts`);
  assert(
    src.includes("reader.cancel()"),
    "scripts/lib/chrome-launch.ts must cancel the stderr reader when proc exits",
  );
});
