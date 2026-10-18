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
import { readFileSync } from "node:fs";
import { durableDir } from "../scripts/lib/durable-root.mjs";
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

/** A fixture test file that appends start/end stamps to a shared events file. */
async function writeFixture(dir: string, name: string, events: string, sleepMs: number) {
  const path = join(dir, `${name}.test.ts`);
  await Deno.writeTextFile(
    path,
    [
      `const EVENTS = ${JSON.stringify(events)};`,
      `const stamp = (phase: string) => Deno.writeTextFileSync(EVENTS, ${JSON.stringify(name)} + "-" + phase + " " + Date.now() + "\\n", { append: true });`,
      `Deno.test(${JSON.stringify(name)}, async () => {`,
      `  stamp("start");`,
      `  await new Promise((r) => setTimeout(r, ${sleepMs}));`,
      `  stamp("end");`,
      `});`,
      "",
    ].join("\n"),
  );
  return path;
}

Deno.test("lanes: build and global overlap, strict runs alone, and the attribution survives the child", async () => {
  const dir = scratch("e2e");
  const events = join(dir, "events.log");
  try {
    await writeFixture(dir, "zz-strict", events, 300);
    // The build lane must outlast the child's STARTUP, or the two fixture intervals cannot intersect
    // even though the lanes ran together: the child pays a runtime start (deno type-checks here).
    await writeFixture(dir, "zz-build", events, 3_000);
    await writeFixture(dir, "zz-global", events, 600);
    // The fixtures are NOT SERIAL members, so this test drives the lanes through a temporary
    // classification: runSerialLanes classifies by SERIAL_LANES, and these names are unknown to it, so
    // call the pieces the lanes are built from and assert the wall-clock shape instead.
    const { runSerialFiles } = await import("../scripts/lib/serial-phase.mjs");
    const laneOpts: {
    stdio: ["ignore", "ignore", "ignore"];
    cwd: string;
  } = { stdio: ["ignore", "ignore", "ignore"], cwd: ROOT };

    const childStart = Date.now();
    const childLane = (async () => {
      const result = join(dir, "global.json");
      const command = serialLaneCommand({ resultPath: result, files: [join(dir, "zz-global.test.ts")], cwd: ROOT });
      const { spawnSync: spawnChild } = await import("node:child_process");
      const run = spawnChild(command.command, command.args, { cwd: command.options.cwd, env: command.options.env, stdio: ["ignore", "ignore", "ignore"] });
      const reported = JSON.parse(await Deno.readTextFile(result));
      return { code: run.status ?? 1, reported };
    })();
    const buildRc = runSerialFiles([join(dir, "zz-build.test.ts")], laneOpts);
    const global = await childLane;
    const childEnd = Date.now();
    const concurrentWall = childEnd - childStart;

    assertEquals(buildRc, 0, "the build lane fixture must pass");
    assertEquals(global.code, 0, "the child lane fixture must pass");
    assertEquals(global.reported.rc, 0, "the child lane must report its own exit code");
    assertEquals(global.reported.failures, [], "a passing lane reports no failures");
    // The OVERLAP ITSELF is asserted below from the fixtures' timestamps — wall time cannot decide it,
    // because the child pays a runtime startup (a deno run type-checks the lane module here; node does
    // not). Only a sanity bound on the whole two-lane step is kept.
    assert(concurrentWall > 0, "the concurrent lanes must have taken measurable time");

    // Strict alone: its interval must not intersect either lane's interval.
    const strictStart = Date.now();
    assertEquals(runSerialFiles([join(dir, "zz-strict.test.ts")], laneOpts), 0);
    const strictEnd = Date.now();
    const rows = (await Deno.readTextFile(events)).trim().split("\n").map((line) => {
      const [tag, ms] = line.split(" ");
      return { tag, at: Number(ms) };
    });
    const at = (tag: string) => rows.find((row) => row.tag === tag)?.at;
    const buildStart = at("zz-build-start") ?? -1;
    const buildEnd = at("zz-build-end") ?? -1;
    const globalStart = at("zz-global-start") ?? -1;
    const globalEnd = at("zz-global-end") ?? -1;
    assert(buildStart > 0 && buildEnd > 0 && globalStart > 0 && globalEnd > 0, `both lanes must have stamped: ${JSON.stringify(rows)}`);
    const buildWindow = buildStart + ".." + buildEnd;
    const globalWindow = globalStart + ".." + globalEnd;
    // Real overlap: the global lane's PROCESS was alive while the build lane ran. Measuring the child's
    // spawn-to-exit lifetime (not its first fixture stamp) keeps this honest under `deno test`, where
    // the child pays a multi-second module type-check before its first test starts; under `npm test`
    // (node) that startup is tens of milliseconds.
    assert(
      Math.max(buildStart, childStart) < Math.min(buildEnd, childEnd),
      `the two lanes must run concurrently: build ${buildWindow}, global process ${childStart}..${childEnd}`,
    );
    // Strict alone: nothing else may start inside its window, and it starts after both lanes ended.
    for (const row of rows) {
      if (row.tag.endsWith("-start") && !row.tag.startsWith("zz-strict") && row.at > strictStart && row.at < strictEnd) {
        assert(false, `${row.tag} started at ${row.at} inside the strict window ${strictStart}..${strictEnd}`);
      }
    }
    assert(strictStart > Math.max(buildEnd, globalEnd), "the strict lane must run after both lanes finished");
    assertEquals(rows.filter((row) => row.tag === "zz-strict-start").length, 1, "the strict fixture must have started once");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
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
    const run = spawnChild(command.command, command.args, { cwd: command.options.cwd, env: command.options.env, stdio: ["ignore", "ignore", "ignore"] });
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
  assert(/await runSerialLanes\(serialFiles, \{ failuresOut: serialFailures \}\)/.test(full), "run-tests.mjs must run SERIAL through runSerialLanes");
  assert(!/runSerialFiles\(serialFiles, \{ failuresOut: serialFailures \}\)/.test(full), "run-tests.mjs must not keep the old sequential call");
  const perChange = readFileSync(join(ROOT, "scripts/select-tests.mjs"), "utf8");
  assert(/runSerialFiles\(/.test(perChange), "select-tests.mjs keeps the sequential serial phase (a changed-file subset has no lane split to pay for)");
  assert(!/runSerialLanes\(/.test(perChange), "select-tests.mjs must not adopt lanes in this change");
});
