// tests/heavy-gate-static.test.ts — static structural tests for scripts/heavy-gate.ts (chrome-agent-platform-o29c0).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { DEFAULT_HEAVY_GATE_TIMEOUT_MS, filesFor, main, partitionByPhase } from "../scripts/heavy-gate.ts";
import {
  BUILD_GATE,
  HEAVY_GATE,
  HEAVY_GATE_FILES,
  HEAVY_GATE_REASONS,
  SERIAL,
  WALL_CLOCK_HEAVY_FILES,
} from "../scripts/test-partition.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

Deno.test("heavy-gate static: exports main and filesFor, matching HEAVY_GATE_FILES exactly", () => {
  assertEquals(typeof main, "function");
  assertEquals(typeof filesFor, "function");
  assertEquals(filesFor([]), [...HEAVY_GATE_FILES]);
  assertEquals(filesFor(["tests/foo.test.ts", "--flag"]), ["tests/foo.test.ts"]);
  assertEquals(HEAVY_GATE_FILES.length, 20);
  assertEquals(DEFAULT_HEAVY_GATE_TIMEOUT_MS, 1200_000);
});

Deno.test("rvht7: wall-clock suites are split OUT of the parallel batch and keep their order", () => {
  const { parallel, wallClock } = partitionByPhase([...HEAVY_GATE_FILES]);
  // The whole point: a wall-clock budget must never share a batch with the RAM/CPU-saturating suites.
  assertEquals(wallClock, [...WALL_CLOCK_HEAVY_FILES]);
  for (const file of WALL_CLOCK_HEAVY_FILES) {
    assert(!parallel.includes(file), `${file} must not run in the parallel batch`);
    assert(HEAVY_GATE.has(file), `${file} must still belong to the heavy tier, so npm test never picks it up`);
  }
  // The rest of the tier is untouched, in declaration order.
  assertEquals(parallel, [...HEAVY_GATE_FILES].filter((f) => !WALL_CLOCK_HEAVY_FILES.includes(f)));
  // A CLI subset that names only wall-clock files yields an empty parallel phase rather than a stray batch.
  assertEquals(partitionByPhase([WALL_CLOCK_HEAVY_FILES[0]]), { parallel: [], wallClock: [WALL_CLOCK_HEAVY_FILES[0]] });
});

Deno.test("rvht7: the wall-clock suite ACQUIRES a quiet window before it measures anything", async () => {
  // A source pin, and deliberately so: the acquisition has to happen before Chrome launches and before the
  // first sample, and the ordering is the contract. Behaviour is covered by tests/heavy-quiet-acquire.test.ts
  // (refusal path, bounded wait, marker) — what cannot be driven here is a real 5-run browser measurement.
  const src = await Deno.readTextFile(new URL("../tests/ntp-boot-staging-timing.test.ts", import.meta.url));
  const acquire = src.indexOf("acquireQuietWindowForHeavyRun(");
  const launch = src.indexOf("launchChrome(");
  assert(acquire > 0, "the suite must call the quiet-window acquire helper");
  assert(launch > 0, "the suite must still launch Chrome");
  assert(acquire < launch, "the quiet window must be acquired BEFORE Chrome launches and timing starts");
});

Deno.test("heavy-gate: tyyl0 skip filter pin ensures default npm test partition contains zero HEAVY_GATE files", async () => {
  const { defaultTestPlan, enumerateRunnerTests } = await import("../scripts/run-tests.mjs");
  const all = enumerateRunnerTests();
  const plan = defaultTestPlan(all);
  const heavyInDefault = [...plan.serialFiles, ...plan.parallel].filter((f) => HEAVY_GATE.has(f));
  assertEquals(
    heavyInDefault,
    [],
    `default npm test partition must contain zero HEAVY_GATE files, but contained: ${heavyInDefault.join(", ")}`,
  );
});

Deno.test("heavy-gate: every HEAVY_GATE file is enumerated, has a reason, and exists on disk", () => {
  const reasons = HEAVY_GATE_REASONS as Record<string, string>;
  for (const file of HEAVY_GATE_FILES) {
    assert(typeof reasons[file] === "string" && reasons[file].length > 0, `${file} must have a non-empty reason in HEAVY_GATE_REASONS`);
    assert(Deno.statSync(`${ROOT}${file}`).isFile, `${file} must exist on disk`);
  }
});

Deno.test("heavy-gate: no HEAVY_GATE file collides with BUILD_GATE or SERIAL", () => {
  for (const file of HEAVY_GATE_FILES) {
    assert(!BUILD_GATE.has(file), `${file} in HEAVY_GATE must not be in BUILD_GATE`);
    assert(!SERIAL.has(file), `${file} in HEAVY_GATE must not be in SERIAL`);
  }
});
