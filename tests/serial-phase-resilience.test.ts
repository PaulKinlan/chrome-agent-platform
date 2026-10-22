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
import { classifyReadyMarkerTimeout, runSerialFile, serialFileTimeoutMs } from "../scripts/lib/serial-phase.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * How long a nested deno test actually takes to reach its FIRST statement on this box (kzy5x).
 *
 * A ready-marker proof has two numbers and both are bounded by this cost: the marker cannot appear before
 * the child boots, and the grace window must be big enough to cover boot PLUS whatever lateness the case
 * declares. Hard-coding either number is what made `xy6n2 late marker` and the two "fast marker-then-exit"
 * cases red on a loaded fleet box (measured boots of 10-22 s against a 5 s soft / 20 s hard window) while
 * the runner logic was correct. Measured here, once per case, so the relationship holds at any boot cost.
 */
async function measureChildBootMs(dir: string): Promise<number> {
  const probe = `${dir}/zz-boot-probe-${crypto.randomUUID().slice(0, 8)}.test.ts`;
  const marker = `${probe}.marker`;
  await Deno.writeTextFile(
    probe,
    `await Deno.writeTextFile(${JSON.stringify(marker)}, "ready");\n` +
      `Deno.test("boot probe", () => {});\n`,
  );
  const t0 = Date.now();
  const res = runSerialFile(probe, {
    timeoutMs: 5_000,
    readyFile: marker,
    readyTimeoutMs: 120_000, // the probe must never be the thing that reds
    stdio: ["ignore", "ignore", "pipe"],
    cwd: ROOT,
  });
  const elapsed = Date.now() - t0;
  assert(
    res.code === 0,
    `the boot probe must reach its marker on this box: ${res.stderr?.toString()}`,
  );
  return Math.max(1_500, elapsed);
}

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
  try {
    const stat = await Deno.readTextFile("/proc/" + pid + "/stat");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    const out = await new Deno.Command("/bin/ps", {
      args: ["-o", "pgid=", "-p", String(pid)],
      stdout: "piped",
      stderr: "null",
    }).output();
    return Number(new TextDecoder().decode(out.stdout).trim()) || 0;
  }
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

async function readProcessState(pid: number): Promise<string | null> {
  try {
    const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]; // field 3 of /proc/pid/stat
  } catch {
    if (Deno.build.os === "darwin") {
      try {
        const out = await new Deno.Command("/bin/ps", {
          args: ["-o", "state=", "-p", String(pid)],
          stdout: "piped",
          stderr: "null",
        }).output();
        const s = new TextDecoder().decode(out.stdout).trim();
        return s ? s[0] : null;
      } catch {
        return null;
      }
    }
    return null;
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
    const state = await readProcessState(pid);
    if (state === null) return "gone";
    if (state === "Z" || state === "X") return "zombie";
    if (Date.now() > deadline) return "alive";
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The instrument's reading, for a failure message: state plus the SIGCONT result. */
async function outcomeReading(pid: number): Promise<string> {
  const state = (await readProcessState(pid)) ?? "gone";
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
    try {
      return String(Deno.loadavg()[0]);
    } catch {
      return "?";
    }
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

// ── yepno: contention-proofness, and a failure that names its own cause ──────
//
// NO HOLD OF A REAL LOCK HAPPENS HERE, deliberately: tests/chrome-lock-fixture-scope.test.ts (bead
// 1qr3) forbids a unit test from holding, spawning flock on, or pointing CAP_CHROME_LOCK_PATH at the
// machine's real Chrome coordination files, because that gate belongs to real browsers. An earlier
// version of this change held the real canonical path to prove the child immune to a foreign holder;
// the guard fired and it was RIGHT, so the hold is gone rather than the rule bent. The foreign-holder
// property lives in the CHILD, on the shape the guard prescribes - a Deno.makeTempFile path with
// CAP_CHROME_LOCK_PATH pointed at it: tests/chrome-launch-lock.test.ts already holds its own temp lock
// and pins both the queue and the NAMED refusal ("could not take the serialized-Chrome lock"). The
// child also chooses its lock path before chrome-launch is imported, which is why the parent cannot
// substitute one for it.
//
// The second, independent defect this fixes is ATTRIBUTION. The merger's 0.3.716 union red here as
// `values are not equal: chrome-launch-lock must pass cleanly` / `1 !== 0` with the child's output
// discarded - not one line of it reached the gate log, so nobody could say WHY it exited 1 and the
// /tmp mtime of a foreign lock was read as the cause. A non-zero exit now carries the child's own
// output, and lock contention is NAMED rather than left to look like a delta's fault.

/** Why the child exited the way it did, from the child's own output. */
const LOCK_CONTENTION_RE = /could not take the serialized-Chrome lock|is held by another lane's browser/;

/** Why the child exited the way it did, from the child's own output. */
function childDiagnosis(res: { code: number; timedOut?: boolean; stdout?: Uint8Array | null; stderr?: Uint8Array | null }): string {
  const text = `${res.stdout ? new TextDecoder().decode(res.stdout) : ""}${res.stderr ? new TextDecoder().decode(res.stderr) : ""}`;
  const lines = text.trim().split("\n").filter((l) => l.trim());
  // Bounded, but the line the message is ABOUT is quoted verbatim rather than hoped into a window:
  // a tail-only excerpt drops a cause stated near the start, and a head-only one drops the summary.
  const excerpt = lines.length <= 12
    ? lines.join(" | ")
    : `${lines.slice(0, 4).join(" | ")} … ${lines.slice(-8).join(" | ")}`;
  const contended = lines.filter((l) => LOCK_CONTENTION_RE.test(l)).slice(0, 2).map((l) => l.trim()).join(" | ");
  return `exit ${res.code}${res.timedOut ? " (timedOut)" : ""}` +
    (contended
      ? ` — NAMED CONTENTION on the serialized-Chrome lock. Quoted from the child: ${contended}. ` +
        "A foreign holder of that lock path is normal fleet state, so classify this rather than blaming the delta"
      : "") +
    ` — child output: ${excerpt || "<the child produced no output at all>"}`;
}

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
  assertEquals(res.code, 0, `chrome-launch-lock must pass cleanly: ${childDiagnosis(res)}`);

  const out = new TextDecoder().decode(res.stdout ?? new Uint8Array());
  const fixtures = [...out.matchAll(/^CAP_LOCK_FIXTURE:(\S+)$/gm)].map((m) => m[1]);
  assertEquals(fixtures.length, 3, "each of the three lock tests must report its own fixture path");
  assertEquals(new Set(fixtures).size, fixtures.length, "lock tests must not share one process-global lock path");
  const leaked = [];
  for (const fixture of fixtures) {
    let gone = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        await Deno.lstat(fixture);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        gone = true;
        break;
      }
    }
    if (!gone) leaked.push(fixture);
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
      // 5nhz: readyFile handshake guarantees the 10s timeout starts only after the probe
      // has initialized, spawned the sleeper and written the premise to pidFile.
      timeoutMs: 10_000,
      readyFile: pidFile,
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

Deno.test("pozs/5nhz: timed-out serial file with cold-boot delay awaits ready marker before starting timer", async () => {
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-grandchild-delayed-" });
  const pidFile = `${tempDir}/grandchild.pid`;
  const tempTest = `${tempDir}/grandchild-delayed-hang.test.ts`;

  // Delayed probe: sleeps 2.5s before recording premise and hanging.
  // Delay (2500ms) exceeds execution timeout (1500ms), proving the timeout starts only after readiness.
  const delayedSource = `
await new Promise((r) => setTimeout(r, 2500));
${probeSource(pidFile, { hang: true })}
`;
  await Deno.writeTextFile(tempTest, delayedSource);

  let grandchildPid = 0;
  try {
    const res = runSerialFile(tempTest, {
      timeoutMs: 1_500,
      readyFile: pidFile,
      readyTimeoutMs: 15_000,
      stdio: "pipe",
      cwd: ROOT,
    });
    assertEquals(res.code, 124, `timed out child must return exit 124; got ${res.code}`);
    assertEquals(res.timedOut, true, "runner must report timedOut: true");

    const recorded = await readRecord(pidFile);
    grandchildPid = recorded.sleeper;
    assertPremise(recorded, "the delayed timed-out child");
    const outcome = await outcomeFor(grandchildPid);
    assert(
      outcome !== "alive",
      `orphan PID ${grandchildPid} must not survive the runner's timeout`,
    );
  } finally {
    if (grandchildPid > 0) {
      try { Deno.kill(grandchildPid, "SIGKILL"); } catch { /* gone */ }
    }
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("pozs/5nhz: runSerialFile fails closed with diagnostic if ready marker never appears", async () => {
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-unready-serial-" });
  const missingReadyFile = `${tempDir}/nonexistent.pid`;
  const tempTest = `${tempDir}/hangs-never-ready.test.ts`;

  await Deno.writeTextFile(tempTest, `
Deno.test("hangs without writing marker", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`);

  try {
    const res = runSerialFile(tempTest, {
      timeoutMs: 5_000,
      readyFile: missingReadyFile,
      readyTimeoutMs: 500,
      stdio: "pipe",
      cwd: ROOT,
    });
    assertEquals(res.code, 124, "unready serial file must return exit 124");
    assertEquals(res.timedOut, true, "unready serial file must report timedOut: true");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("pozs/5nhz: runSerialFile fails closed if child exits 0 without writing ready marker", async () => {
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-exit-unready-" });
  const missingReadyFile = `${tempDir}/unwritten.marker`;
  const tempTest = `${tempDir}/exits-without-marker.test.ts`;

  // Fixture returns 0 immediately without writing marker
  await Deno.writeTextFile(tempTest, `
Deno.test("passes immediately without marker", () => {
  // returns 0
});
`);

  try {
    const res = runSerialFile(tempTest, {
      timeoutMs: 5_000,
      readyFile: missingReadyFile,
      readyTimeoutMs: 5_000,
      stdio: "pipe",
      cwd: ROOT,
    });
    assertEquals(res.code, 124, "exiting without ready marker must fail closed with exit 124");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("xy6n2: a marker after the 5s soft deadline succeeds only when load is named and bounded", async () => {
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-late-ready-" });
  const readyFile = `${tempDir}/late.marker`;
  const tempTest = `${tempDir}/late-ready.test.ts`;
  // kzy5x: the marker must arrive AFTER the soft deadline and BEFORE the hard one, and on this box the
  // CHILD'S OWN COLD BOOT dominates both numbers (measured 10-22s at fleet load ~5, in a serial lane that
  // runs alone). With a fixed soft=5000 / hard=20000 the marker's own 6s delay sat on top of a boot that
  // alone could exceed 20s, so the run was killed by the hard bound and the case redded on the box rather
  // than on the code. Both numbers are now derived from a MEASURED boot, so the property under test — a
  // late marker survives the soft bound via the named, bounded grace — holds at any boot cost.
  const bootMs = await measureChildBootMs(tempDir);
  const softMs = bootMs + 500; // the marker (which cannot precede boot) is guaranteed to arrive AFTER this
  const lateDelayMs = 6_000; // ...and comfortably before the derived hard bound (soft x up-to-4)
  assert(
    bootMs + lateDelayMs < softMs * 4,
    `the declared late delay must land inside the derived hard bound: boot ${bootMs}ms + ${lateDelayMs}ms ` +
      `vs hard ${softMs * 4}ms`,
  );
  await Deno.writeTextFile(tempTest, `
await new Promise((resolve) => setTimeout(resolve, ${lateDelayMs}));
await Deno.writeTextFile(${JSON.stringify(readyFile)}, "ready");
Deno.test("passes after late marker", () => {});
`);
  try {
    const res = runSerialFile(tempTest, {
      timeoutMs: 2_000,
      readyFile,
      readyTimeoutMs: softMs,
      readyLoadPerCpu: 4, // deterministic injected reading, never manufacture system load
      stdio: "pipe",
      cwd: ROOT,
    } as Parameters<typeof runSerialFile>[1]);
    assertEquals(
      res.code,
      0,
      `late marker must not be killed by the soft bound (boot ${bootMs}ms, soft ${softMs}ms, late ` +
        `${lateDelayMs}ms): ${res.stderr?.toString()}`,
    );
    assertEquals(res.timedOut, false);
    assert((res.stderr?.toString() ?? "").includes("READY_MARKER_LOADED_GRACE"),
      `the extension must name its measured/injected load and hard bound: ${res.stderr?.toString()}`);
    assertEquals(await Deno.readTextFile(readyFile), "ready", "fixture must write the marker event");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("xy6n2 falsifier: the DERIVED late-marker window is still a BOUND — an unmarked child dies at it", async () => {
  // coord's requirement before landing kzy5x: "a boot-derived number that can only grow is the same trap in a
  // new place". So the derivation is tested from the other side: the SAME boot-derived soft deadline, with the
  // load injection that grants NO grace, must still KILL a child that never writes its marker and must name
  // which bound refused it. If a future edit turns the derived number into something that can only grow, this
  // case reds (no 124, or no named timeout). The probe inside measureChildBootMs can also fail on its own
  // terms: its 120 s window is an ASSERTION (`the boot probe must reach its marker on this box`), so a boot
  // that never completes reds by name instead of quietly inflating the numbers.
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-derived-bound-" });
  const readyFile = `${tempDir}/never.marker`;
  const tempTest = `${tempDir}/never-ready.test.ts`;
  await Deno.writeTextFile(
    tempTest,
    'Deno.test("hangs without a marker", async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });\n',
  );
  const bootMs = await measureChildBootMs(tempDir);
  const softMs = bootMs + 500;
  try {
    const res = runSerialFile(tempTest, {
      timeoutMs: 2_000,
      readyFile,
      readyTimeoutMs: softMs,
      readyLoadPerCpu: 1, // idle: the derived number gets NO grace, so the derivation itself is the bound
      stdio: ["ignore", "ignore", "pipe"],
      cwd: ROOT,
    } as Parameters<typeof runSerialFile>[1]);
    assertEquals(
      res.code,
      124,
      `a child that never marks must still be killed at the derived bound (soft ${softMs}ms): ` +
        `${res.stderr?.toString()}`,
    );
    assertEquals(res.timedOut, true);
    assert(
      (res.stderr?.toString() ?? "").includes("READY_MARKER_TIMEOUT_IDLE_NEVER_SETTLED"),
      `the derived bound must still refuse BY NAME: ${res.stderr?.toString()}`,
    );
    assertEquals(
      await Deno.stat(readyFile).then(() => true).catch(() => false),
      false,
      "the unmarked child never produces the marker",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("xy6n2: ready timeout classification has an idle bound, measured x4 load cap, and unmeasurable refusal", () => {
  assertEquals(classifyReadyMarkerTimeout({ baseMs: 5_000, loadPerCpu: 1 }),
    { cause: "idle-never-settled", loadPerCpu: 1, hardTimeoutMs: 5_000 });
  assertEquals(classifyReadyMarkerTimeout({ baseMs: 5_000, loadPerCpu: 2.5 }),
    { cause: "loaded", loadPerCpu: 2.5, hardTimeoutMs: 12_500 });
  assertEquals(classifyReadyMarkerTimeout({ baseMs: 5_000, loadPerCpu: 99 }),
    { cause: "loaded", loadPerCpu: 99, hardTimeoutMs: 20_000 });
  assertEquals(classifyReadyMarkerTimeout({ baseMs: 5_000, loadPerCpu: null }),
    { cause: "unmeasurable", loadPerCpu: null, hardTimeoutMs: 5_000 });
});

Deno.test("xy6n2: loaded grace still refuses a genuinely absent marker by a named hard bound", async () => {
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-loaded-no-marker-" });
  const readyFile = `${tempDir}/missing.marker`;
  const tempTest = `${tempDir}/hangs-without-marker.test.ts`;
  // Keep the child alive beyond the hard ready bound. Deno treats an unresolved
  // test promise as a failed test and exits early, which would exercise the
  // separate child-exit refusal rather than the hard-deadline classifier.
  await Deno.writeTextFile(tempTest, `
await new Promise((resolve) => setTimeout(resolve, 60_000));
Deno.test("never writes marker", () => {});
`);
  try {
    const res = runSerialFile(tempTest, {
      timeoutMs: 1_000,
      readyFile,
      readyTimeoutMs: 500,
      readyLoadPerCpu: 4,
      stdio: "pipe",
      cwd: ROOT,
    });
    assertEquals(res.code, 124, "loaded grace must not turn an absent marker into a pass");
    assertEquals(res.timedOut, true);
    const reason = res.stderr?.toString() ?? "";
    assert(reason.includes("READY_MARKER_LOADED_GRACE"), `missing load attribution: ${reason}`);
    assert(reason.includes("READY_MARKER_TIMEOUT_LOADED"), `missing hard-bound classification: ${reason}`);
    assertEquals(await Deno.stat(readyFile).then(() => true).catch(() => false), false);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("pozs/5nhz: runSerialFile succeeds when child writes ready marker and exits immediately", async () => {
  const tempDir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-fast-ready-serial-" });
  const readyFile = `${tempDir}/fast.marker`;
  const tempTest = `${tempDir}/fast-ready.test.ts`;

  // Fixture writes marker and exits 0 immediately without hanging
  await Deno.writeTextFile(tempTest, `
await Deno.writeTextFile("${readyFile}", "ready");
Deno.test("passes immediately after marker", () => {});
`);

  try {
    // This positive fixture boots another Deno runtime in the parallel gate.
    // A flat 5s boot deadline falsely returned 124 in gate 051b972d5. The
    // parallel twin (tests/parallel-phase-resilience.test.ts) already pins a
    // load-scaled 15s floor; use that floor and cap this 5s scaler at 20s.
    // xy6n2's measured-load grace is already live on main: after this 15–20s
    // SOFT deadline it can extend to a 60–80s HARD deadline under measured
    // load, then refuses an absent marker. The missing-marker fixtures above
    // retain their separate short fail-closed bounds.
    // kzy5x/whl7d: the boot budget is keyed on ABSOLUTE load, not load per CPU. On this 8-core VM the gates
    // that redded these readiness cases ran at absolute load 11-14, so load/cpus was ~1.4-1.75 and this
    // budget sat on its 15s floor while the deno cold boot it waits for took longer (coord P1 on whl7d found
    // the same arithmetic in the custody TERM window). The x4 ceiling above still bounds it at 20s, and the
    // measured-load HARD grace after this soft deadline is unchanged.
    const bootBudgetMs = Math.max(15_000, serialFileTimeoutMs({
      base: 5_000,
      loadPerCpu: Deno.loadavg()[0],
    }));
    assert(bootBudgetMs >= 15_000 && bootBudgetMs <= 20_000,
      `positive marker soft boot budget must stay in 15–20s, got ${bootBudgetMs}ms`);
    assertEquals(serialFileTimeoutMs({ base: 5_000, loadPerCpu: 99 }), 20_000,
      "the load scaler must cap this positive fixture at 20s even under extreme load");
    const res = runSerialFile(tempTest, {
      timeoutMs: bootBudgetMs,
      readyFile,
      readyTimeoutMs: bootBudgetMs,
      stdio: "pipe",
      cwd: ROOT,
    });
    assertEquals(res.code, 0, "fast marker-then-exit must succeed with code 0");
    assertEquals(res.timedOut, false);
  } finally {
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

// yepno, condition (2): two lanes gating at once is the fleet's normal state, so the child is run
// TWICE CONCURRENTLY here and both runs must be green - which holds by construction only because the
// child takes its own per-run `cap-chrome-lock-test-*` fixture (this asserts both runs report a
// DIFFERENT fixture path, which is what makes them independent rather than racing on one lock).
Deno.test("yepno: two concurrent lock-child runs are independent, each on its own fixture path", async () => {
  const spawnChild = () =>
    new Deno.Command("npm", {
      args: ["run", "test:file", "--", "tests/chrome-launch-lock.test.ts"],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  const [a, b] = [spawnChild(), spawnChild()];
  const [ra, rb] = await Promise.all([a.output(), b.output()]);
  const textOf = (r: Deno.CommandOutput) => `${new TextDecoder().decode(r.stdout)}${new TextDecoder().decode(r.stderr)}`;
  const fixturesOf = (text: string) => [...text.matchAll(/^CAP_LOCK_FIXTURE:(\S+)$/gm)].map((m) => m[1]);
  const [fa, fb] = [fixturesOf(textOf(ra)), fixturesOf(textOf(rb))];
  assertEquals(ra.code, 0, `concurrent run A must pass: exit ${ra.code} — ${childDiagnosis({ code: ra.code, stdout: ra.stdout, stderr: ra.stderr })}`);
  assertEquals(rb.code, 0, `concurrent run B must pass: exit ${rb.code} — ${childDiagnosis({ code: rb.code, stdout: rb.stdout, stderr: rb.stderr })}`);
  assert(fa.length > 0 && fb.length > 0, "both runs must report their fixture paths");
  assert(fa[0] !== fb[0], `the two runs must not share a lock fixture (${fa[0]} vs ${fb[0]})`);
});

// The attribution fix needs its own falsifier: a child that exits non-zero must be reported with ITS
// OWN output, and lock contention must be NAMED. The fixture is a throwaway serial file whose failure
// is exactly the product's contention sentence, so this asserts the diagnosis rather than the outcome
// of a real lane's browser.
Deno.test("yepno: a non-zero child exit is reported with the child's output, and lock contention is NAMED", async () => {
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-yepno-diagnosis-" });
  const failing = `${dir}/failing.test.ts`;
  const contentionLine = "launchChrome: could not take the serialized-Chrome lock within 800 ms (/tmp/cap-serialized-chrome-acceptance.lock is held by another lane's browser).";
  await Deno.writeTextFile(
    failing,
    `import { assertEquals } from "jsr:@std/assert@1";
Deno.test("a child that cannot take the lock", () => {
  console.log(${JSON.stringify(contentionLine)});
  assertEquals(1, 0, "stand-in for the lock refusal");
});
`,
  );
  try {
    const res = runSerialFile(failing, { stdio: "pipe", cwd: ROOT });
    assert(res.code !== 0, "the fixture child must fail");
    const message = childDiagnosis(res);
    assert(message.includes("could not take the serialized-Chrome lock"), `the child's own line must survive into the message: ${message}`);
    assert(message.includes("NAMED CONTENTION"), `lock contention must be named, not left to look like a delta: ${message}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("v3p4s: serial-runner maps child SIGKILL to 137 and SIGTERM to 143", async () => {
  const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-v3p4s-sig-" });
  const killFile = `${dir}/kill.test.ts`;
  const termFile = `${dir}/term.test.ts`;
  await Deno.writeTextFile(killFile, `Deno.test("k", () => { Deno.kill(Deno.pid, "SIGKILL"); });\n`);
  await Deno.writeTextFile(termFile, `Deno.test("t", () => { Deno.kill(Deno.pid, "SIGTERM"); });\n`);
  try {
    const rKill = new Deno.Command("node", {
      args: ["scripts/lib/serial-runner.mjs", killFile, "", "30000", ""],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assertEquals(rKill.code, 137, `serial-runner must map SIGKILL to exit 137, got ${rKill.code}`);

    const rTerm = new Deno.Command("node", {
      args: ["scripts/lib/serial-runner.mjs", termFile, "", "30000", ""],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    assertEquals(rTerm.code, 143, `serial-runner must map SIGTERM to exit 143, got ${rTerm.code}`);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
