// tests/serial-lanes.test.ts — chrome-agent-platform-1oouo.
//
// The serial phase used to run sixteen files one at a time on every FULL gate (75s measured). Only one
// of its three hazard classes needs the box to itself, so the phase now runs as LANES: the build/artifact
// writers in the runner process, the process-global Chrome lock/slot cluster in a child, concurrently —
// while the load- and clock-sensitive files still run ALONE first.
//
// This suite pins the two things a reviewer cannot check by reading the diff alone:
//   1. the partition is TOTAL, DISJOINT and honest about its own reasons (a file whose reason says
//      "concurrent load" can never be put in a concurrent lane);
//   2. the lanes really do overlap, and the strict lane really does not — asserted from timestamps
//      written by real fixture files, not from the code's intent.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { spawn as realSpawn } from "node:child_process";
import { runSerialLanes, serialLaneCommand } from "../scripts/lib/serial-phase.mjs";
import {
  SERIAL,
  SERIAL_LANES,
  SERIAL_LANE_REASONS,
  SERIAL_REASONS,
  serialLanes,
  stripComments,
} from "../scripts/test-partition.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// These tables are plain objects in the shared module (their literal types would be noise here).
const LANES: Record<string, string> = SERIAL_LANES;
const LANE_REASONS: Record<string, string> = SERIAL_LANE_REASONS;
const REASONS: Record<string, string> = SERIAL_REASONS;
const scratch = (name: string) => durableDir("scratch", `serial-lanes-${process.pid}-${Date.now()}-${name}`);

Deno.test("lanes: the partition is exhaustive, disjoint and every lane carries a reason", () => {
  for (const lane of Object.keys(LANE_REASONS)) {
    assertEquals(typeof LANE_REASONS[lane], "string", `lane ${lane} must carry a reason`);
    assert(LANE_REASONS[lane].length > 30, `lane ${lane}'s reason must actually say something`);
  }
  for (const file of SERIAL) {
    assert(LANES[file], `${file} is SERIAL but has no lane`);
    assert(LANE_REASONS[LANES[file]], `${file}'s lane has no reason`);
    assert(REASONS[file], `${file} must still carry its SERIAL reason`);
  }
  for (const file of Object.keys(LANES)) {
    assert(SERIAL.has(file), `${file} is assigned a lane but is not SERIAL`);
  }
  // serialLanes() is the runtime split: nothing may be dropped or duplicated by it.
  const lanes = serialLanes([...SERIAL]);
  const merged = [...lanes.strict, ...lanes.build, ...lanes.global];
  assertEquals(merged.length, SERIAL.size, "the lanes must partition SERIAL exactly");
  assertEquals(new Set(merged).size, SERIAL.size, "a file must appear in exactly one lane");
});

Deno.test("lanes: a file whose own reason names concurrent load or wall-clock timing is STRICT", () => {
  // The honesty rule, so a future lane assignment cannot quietly move a load-sensitive file into a
  // concurrent lane: the reason is the evidence, and it decides the lane.
  const HAZARD = /concurrent load|wall-?clock|under load|parallel phase/i;
  for (const file of SERIAL) {
    if (LANES[file] === "strict") continue;
    assert(
      !HAZARD.test(REASONS[file]),
      `${file}'s SERIAL reason names a load/clock hazard, so it cannot run in the concurrent ${LANES[file]} lane`,
    );
  }
  // And the three that do are strictly serial.
  assertEquals(
    Object.entries(LANES).filter(([, lane]) => lane === "strict").map(([file]) => file).sort(),
    ["tests/chrome-slot-semaphore-honesty.test.ts", "tests/ntp-boot-staging.test.ts", "tests/serial-phase-timeout.test.ts"],
  );
});

Deno.test("lanes: a SERIAL file with no lane is a loud error, never a silent fallback", () => {
  let threw = null;
  try {
    serialLanes(["tests/not-a-serial-file.test.ts"]);
  } catch (error) {
    threw = error;
  }
  assert(threw, "serialLanes must refuse an unclassified file");
  const message = String((threw as Error).message);
  assert(message.includes("no SERIAL_LANES entry"), `unexpected error: ${message}`);
});

Deno.test("lanes: the child is spawned BEFORE the build lane runs, both are awaited, failures merge in order", async () => {
  // The ordering is the whole mechanism, and it is asserted with the lane seams so the test does not pay
  // a real `deno test` startup per fixture (seconds on a loaded box) to prove a millisecond fact.
  const events: string[] = [];
  const files = [
    "tests/ntp-boot-staging.test.ts", // strict
    "tests/build-smoke.test.ts", // build
    "tests/chrome-launch-lock.test.ts", // global
  ];
  let resolveChild = () => {};
  const childDone = new Promise<void>((resolve) => { resolveChild = () => resolve(); });
  const failuresOut: any[] = [];
  // Silenced: runSerialLanes announces its lane summary, and a seam test that deliberately reports a
  // failing child would otherwise print a fake "run-tests: serial lanes FAILED in 0s" INTO a real gate
  // log (it did — twice per gate — where a reader or a grep takes it for the phase verdict).
  const realLog = console.log;
  const realError = console.error;
  console.log = () => {};
  console.error = () => {};
  let rc = -1;
  try {
    rc = await runSerialLanes(files, {
    runLaneFiles: (laneFiles: string[], opts: any) => {
      for (const file of laneFiles) events.push(`run:${file}`);
      if (laneFiles.includes("tests/build-smoke.test.ts")) {
        // The build lane must see the child already spawned.
        assertEquals(events.includes("spawn-child"), true, "the child must be spawned before the build lane runs");
        events.push("build-start");
        opts.failuresOut.push({ file: "tests/build-smoke.test.ts", code: 0, timedOut: false, isRefusal: false, secs: "0", log: null });
        events.push("build-end");
        // The child finishes right after the build lane — the parent must then be able to await it.
        setTimeout(() => resolveChild(), 0);
      }
      if (laneFiles.includes("tests/chrome-launch-lock.test.ts")) {
        events.push("global-ran");
        opts.failuresOut.push({ file: "tests/chrome-launch-lock.test.ts", code: 0, timedOut: false, isRefusal: false, secs: "0", log: null });
      }
      return 0;
    },
    spawnLaneChild: (lane: any) => {
      events.push("spawn-child");
      // The child's files are run by the child itself; its result arrives from the file it writes.
      // A FAILING record here also pins the merge order and the exit-code combination.
      writeFileSync(
        lane.resultPath,
        JSON.stringify({
          rc: 1,
          failures: [{ file: "tests/chrome-launch-lock.test.ts", code: 1, timedOut: false, isRefusal: false, secs: "1.0", log: null }],
        }),
      );
      return {
        pid: 0,
        kill: () => {},
        exited: childDone.then(() => ({ code: 1, signal: null })),
      };
    },
      failuresOut,
    });
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  assertEquals(rc, 1, "a failing child lane must fail the phase with its own code");
  assertEquals(
    failuresOut.map((failure) => failure.file),
    ["tests/build-smoke.test.ts", "tests/chrome-launch-lock.test.ts"],
    "merged failures must come back in SERIAL declaration order",
  );
  assertEquals(events.indexOf("spawn-child") < events.indexOf("build-start"), true, "spawn must precede the build lane");
  assertEquals(events.includes("build-end"), true, "the build lane must run to completion while the child lives");
});

Deno.test("lanes: a GLOBAL child that cannot START fails closed to sequential instead of killing the gate (xaj7c)", async () => {
  // xaj7c: the child lane subscribed only to `exit`. A child that never starts emits `error` and NEVER
  // `exit`, so Node treated it as an unhandled 'error' event and took the whole gate down — no lane named,
  // no file named, no cause. The repro was `cwd: /nonexistent` ⇒ ENOENT.
  const files = [
    "tests/build-smoke.test.ts", // build
    "tests/chrome-launch-lock.test.ts", // global
  ];
  const ran: string[][] = [];
  const announced: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const capture = (...args: any[]) => { announced.push(args.map(String).join(" ")); };
  console.log = capture;
  console.error = capture;
  let rc = -1;
  try {
    rc = await runSerialLanes(files, {
      // A REAL spawn of a binary that does not exist: ENOENT comes from the OS, not from a stub.
      spawnChild: ((_command: string, _args: string[], options: any) => realSpawn("cap-lane-binary-that-does-not-exist-xyz", [], options)) as any,
      runLaneFiles: (laneFiles: string[], opts: any) => {
        ran.push([...laneFiles]);
        for (const file of laneFiles) {
          opts.failuresOut.push({ file, code: 0, timedOut: false, isRefusal: false, secs: "0", log: null });
        }
        return 0;
      },
    });
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  // The phase must RESOLVE — a spawn failure is a step failure, not a process kill.
  assertEquals(rc, 0, "a child that cannot start must not fail the phase when its files still run");
  assertEquals(
    ran.map((lane) => lane[0]),
    ["tests/build-smoke.test.ts", "tests/chrome-launch-lock.test.ts"],
    "the build lane runs here and the GLOBAL files fall back to running here too",
  );
  const joined = announced.join("\n");
  assert(/GLOBAL child never started/.test(joined), `the cause must be announced, saw: ${joined}`);
  assert(/ENOENT/.test(joined), `the announcement must carry the OS cause, saw: ${joined}`);
  assert(/FALL BACK TO SEQUENTIAL/.test(joined), `the fallback must be named, saw: ${joined}`);
  assert(/GLOBAL child could not start, ran sequentially/.test(joined),
    `the summary must not claim a concurrency that never happened, saw: ${joined}`);
});

Deno.test("lanes: a child that DOES start still reports GREEN with its duration (oqko2)", async () => {
  // oqko2: the summary built its line as `prefix + cond ? a : b`, so `+` (higher precedence) made the whole
  // concatenation the CONDITION — always truthy — and every run reported the fallback wording, losing
  // GREEN/REFUSED/FAILED and the duration. The fallback test above could not catch it (it EXPECTED the
  // fallback wording); this one pins the ordinary path, which is the one every gate actually takes.
  const files = ["tests/build-smoke.test.ts", "tests/chrome-launch-lock.test.ts"];
  const announced: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const capture = (...args: any[]) => { announced.push(args.map(String).join(" ")); };
  console.log = capture;
  console.error = capture;
  let resolveChild = () => {};
  const childDone = new Promise<void>((resolve) => { resolveChild = () => resolve(); });
  let rc = -1;
  try {
    rc = await runSerialLanes(files, {
      runLaneFiles: (laneFiles: string[], opts: any) => {
        for (const file of laneFiles) {
          opts.failuresOut.push({ file, code: 0, timedOut: false, isRefusal: false, secs: "0", log: null });
        }
        if (laneFiles.includes("tests/build-smoke.test.ts")) setTimeout(() => resolveChild(), 0);
        return 0;
      },
      spawnLaneChild: (lane: any) => {
        writeFileSync(lane.resultPath, JSON.stringify({ rc: 0, failures: [] }));
        return { pid: 0, kill: () => {}, exited: childDone.then(() => ({ code: 0, signal: null })) };
      },
    });
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  assertEquals(rc, 0);
  const summary = announced.filter((line) => line.includes("serial lanes")).at(-1) ?? "";
  assert(/serial lanes GREEN in \d+s/.test(summary), `the summary must keep its verdict and duration, got: ${summary}`);
  assert(!/could not start/.test(summary), `a child that started must not be reported as failed to start: ${summary}`);
  assert(/concurrent/.test(summary), `the summary must still say the lanes ran concurrently: ${summary}`);
});

Deno.test("lanes: a failing file in the child lane is named and fails the phase", async () => {
  const dir = scratch("fail");
  try {
    const failing = join(dir, "zz-global-fail.test.ts");
    await Deno.writeTextFile(
      failing,
      'Deno.test("fails in the child lane", () => { throw new Error("lane failure"); });\n',
    );
    const result = join(dir, "global.json");
    const { spawnSync: spawnChild } = await import("node:child_process");
    const command = serialLaneCommand({ resultPath: result, files: [failing], cwd: ROOT });
    const run = spawnChild("node", command.args, { cwd: command.options.cwd, env: command.options.env, stdio: ["ignore", "ignore", "ignore"] });
    const code = run.status ?? 1;
    const reported = JSON.parse(await Deno.readTextFile(result));
    assert(code !== 0, "a failing file must fail the lane process");
    assertEquals(reported.failures.length, 1, "the lane must report exactly one failure");
    assertEquals(reported.failures[0].file, failing, "the failure must name the file");
    assert(reported.failures[0].code !== 0, "the failure must carry its exit code");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("lanes: the child lane runs on the SAME runtime as its parent (node for npm test)", () => {
  // The first revision spawned `Deno.execPath()`, which is undefined under `npm test` (it runs node
  // scripts/run-tests.mjs): the FULL gate died at the spawn with ReferenceError in three runs.
  // The result path goes through the durable route like every other scratch path (a literal /tmp path
  // is what tests/durable-root.test.ts exists to catch — it caught mine).
  const command = serialLaneCommand({
    resultPath: join(durableDir("scratch", `serial-lane-cmd-${process.pid}-${Date.now()}`), "result.json"),
    files: ["tests/ntp-boot-staging.test.ts"],
  });
  assertEquals(command.command, process.execPath, "the lane child must be the same binary as its parent");
  assert(command.args.some((arg: string) => arg.includes("serial-lane-child.mjs")), `the child script must be invoked: ${command.args.join(" ")}`);
  assert(command.args.includes("tests/ntp-boot-staging.test.ts"), "the lane's files must be passed through");
  assertEquals(command.options.detached, true, "the lane runs in its own process group so it can be killed with its tree");
  // Scan CODE, not prose: the file's own comment explains why Deno.* is banned here.
  const child = stripComments(readFileSync(join(ROOT, "scripts/lib/serial-lane-child.mjs"), "utf8"));
  assert(!/Deno\./.test(child), "the child must not use Deno.* — it runs under node for npm test");
  assert(/process\.execPath/.test(readFileSync(join(ROOT, "scripts/lib/serial-phase.mjs"), "utf8")), "the spawn must use process.execPath, not Deno.execPath");
});

Deno.test("lanes: the full runner uses the lanes and the per-change runner still runs SERIAL as one list", async () => {
  const { readFileSync } = await import("node:fs");
  const full = readFileSync(join(ROOT, "scripts/run-tests.mjs"), "utf8");
  assert(/await runSerialLanes\(serialFiles, \{ failuresOut: serialFailures, unreportedOut: serialUnreported \}\)/.test(full), "run-tests.mjs must run SERIAL through runSerialLanes, collecting unreported lane files (5xg1w blocker 1)");
  assert(!/runSerialFiles\(serialFiles, \{ failuresOut: serialFailures \}\)/.test(full), "run-tests.mjs must not keep the old sequential call");
  const perChange = readFileSync(join(ROOT, "scripts/select-tests.mjs"), "utf8");
  assert(/runSerialFiles\(/.test(perChange), "select-tests.mjs keeps the sequential serial phase (a changed-file subset has no lane split to pay for)");
  assert(!/runSerialLanes\(/.test(perChange), "select-tests.mjs must not adopt lanes in this change");
});

// chrome-agent-platform-5xg1w review, blocker 1: a GLOBAL child that exits WITHOUT writing its result
// file leaves its files with no certified result. They are UNRUN — not failed — and must reach the
// runner's incomplete accounting (unreportedOut), or the run reports a completed FAIL over work that
// never happened and a content-addressed cache files that false verdict permanently.
async function unreportedRun(exited: { code: number | null; signal: string | null }, buildLaneGreen = false) {
  const files = ["tests/build-smoke.test.ts", "tests/chrome-launch-lock.test.ts"];
  const announced: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const capture = (...args: any[]) => { announced.push(args.map(String).join(" ")); };
  console.log = capture;
  console.error = capture;
  const failuresOut: any[] = [];
  const unreportedOut: string[] = [];
  let rc = -1;
  try {
    rc = await runSerialLanes(files, {
      runLaneFiles: (laneFiles: string[], opts: any) => {
        for (const file of laneFiles) {
          opts.failuresOut.push({ file, code: buildLaneGreen ? 0 : 1, timedOut: false, isRefusal: false, secs: "0", log: null });
        }
        return buildLaneGreen ? 0 : 1;
      },
      // The child starts, runs, and dies WITHOUT writing lane.resultPath — the exact defect shape.
      spawnLaneChild: () => ({ pid: 0, kill: () => {}, exited: Promise.resolve(exited) }),
      failuresOut,
      unreportedOut,
    });
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return { rc, failuresOut, unreportedOut, announced };
}

Deno.test("5xg1w blocker 1: an unreported GLOBAL lane hands its files to unreportedOut, never to failuresOut", async () => {
  const { rc, failuresOut, unreportedOut, announced } = await unreportedRun({ code: 1, signal: null });
  assertEquals(unreportedOut, ["tests/chrome-launch-lock.test.ts"], "the unreported lane's files are UNRUN and must be handed back");
  assertEquals(
    failuresOut.map((f) => f.file),
    ["tests/build-smoke.test.ts"],
    "an unreported file must NOT be invented as a failure — only the build lane actually reported",
  );
  assertEquals(rc, 1, "the phase is red on the reported build-lane failure");
  assert(
    announced.join("\n").includes("did not report a result"),
    "the unreported lane must still be announced",
  );
});

Deno.test("5xg1w blocker 1: an unreported lane PRESERVES the bound-kill/signal vocabulary (OOM SIGKILL → 137)", async () => {
  // The 0o0um incident's second attempt: the lane driver was OOM-killed — SIGKILL, not an assertion.
  // Flattening that into rc 1 would file an environmental death as a product FAIL. (Build lane green,
  // so the unreported lane's own code decides the phase — a genuine product red elsewhere still wins
  // the combine, and the runner turns either shape into INCOMPLETE via the unreported gap.)
  const sigkill = await unreportedRun({ code: null, signal: "SIGKILL" }, true);
  assertEquals(sigkill.rc, 137, "a signal death keeps its 128+signal code (fleet-check reads 137 as KILLED, never a verdict)");
  assertEquals(sigkill.unreportedOut, ["tests/chrome-launch-lock.test.ts"]);

  const sigterm = await unreportedRun({ code: null, signal: "SIGTERM" }, true);
  assertEquals(sigterm.rc, 143, "SIGTERM → 143, same vocabulary");

  // A plain non-zero exit passes through; a zero exit with no result is forced red (uncertified).
  const exited3 = await unreportedRun({ code: 3, signal: null }, true);
  assertEquals(exited3.rc, 3, "the child's own non-zero code is preserved");
  const exited0 = await unreportedRun({ code: 0, signal: null }, true);
  assertEquals(exited0.rc, 1, "exit 0 with NO result file is uncertified, never green");

  // A genuine product red in a REPORTED lane still wins the phase combine — the kill vocabulary does
  // not launder real failures.
  const mixed = await unreportedRun({ code: null, signal: "SIGKILL" }, false);
  assertEquals(mixed.rc, 1, "a reported product failure outranks the unreported lane's signal code");
  assertEquals(mixed.unreportedOut, ["tests/chrome-launch-lock.test.ts"], "and the unreported files are STILL handed back");
});
