// tests/parallel-plan.test.ts — chrome-agent-platform-kz27.
//
// THE DEFECT: run-tests.mjs ran the parallel phase only when the serial phase was green
// (`if (rc === 0) rc = runParallel(parallel)`), so ONE serial failure skipped ~500 parallel files —
// and the always-on guards live in the parallel set. Measured: two guard violations reached main from
// one landing while its full-suite gate reported the guards green, because they never ran.
//
// THE RULE THIS PINS: a guard result must never be conditional on an unrelated phase passing. A
// serial failure still runs the always-on subset, and the run says how much it skipped — because a
// gate that cannot tell you what it ran is the other half of this bead's family.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { guardSubset, parallelPlan, computeParallelPhaseTimeout, DEFAULT_PARALLEL_TIMEOUT_MS } from "../scripts/lib/parallel-plan.mjs";

const PARALLEL = ["tests/a.test.ts", "tests/b.test.ts", "tests/durable-root.test.ts", "tests/c.test.ts"];
const ALWAYS_ON = ["tests/durable-root.test.ts", "tests/core.test.ts"];

Deno.test("kz27: a GREEN serial phase runs the whole parallel phase and announces nothing", () => {
  const plan = parallelPlan({ serialRc: 0, parallel: PARALLEL, alwaysOn: ALWAYS_ON });
  assertEquals(plan.files, PARALLEL, "a green serial phase must not narrow the parallel set");
  assertEquals(plan.skipped, 0);
  assertEquals(plan.announce, null, "nothing was skipped, so there is nothing to announce");
});

Deno.test("kz27: a FAILED serial phase still runs the always-on guard set, and says what it skipped", () => {
  const plan = parallelPlan({ serialRc: 1, parallel: PARALLEL, alwaysOn: ALWAYS_ON });
  // The guards RUN even though an unrelated phase failed.
  assertEquals(plan.files, ["tests/durable-root.test.ts"]);
  assertEquals(plan.skipped, 3);
  assert(plan.announce !== null, "skipping files must be announced, never silent");
  assert(plan.announce.includes("SKIPPED"), plan.announce);
  assert(plan.announce.includes("ALWAYS-ON GUARD SET"), plan.announce);
  assert(
    plan.announce.includes("3 of 4"),
    `the announcement must say how much was skipped: ${plan.announce}`,
  );
});

Deno.test("kz27: the plan is not a blanket 'run everything' — the failure state narrows the set", () => {
  // FALSIFICATION: if the old behaviour returned (run all files after a serial failure) this fails;
  // if a lazy 'run nothing' fix were used, the guard subset assertion above fails. Both directions
  // are pinned, so the test cannot be satisfied by either shortcut.
  const failed = parallelPlan({ serialRc: 1, parallel: PARALLEL, alwaysOn: ALWAYS_ON });
  assert(
    failed.files.length < PARALLEL.length,
    "a failed serial phase must NOT run the full parallel set (the old behaviour was the defect)",
  );
  assertEquals(guardSubset(PARALLEL, ALWAYS_ON), ["tests/durable-root.test.ts"]);
  // An always-on file that is not in this run's parallel set is simply not run here (it belongs to
  // another phase) — the subset is an intersection, not an assumption.
  assertEquals(guardSubset(PARALLEL, ["tests/not-in-this-run.test.ts"]), []);
});

Deno.test("877x1: computeParallelPhaseTimeout adapts dynamically to CPU concurrency and file count", () => {
  // On a 2-vCPU machine with 800 files, timeout scales beyond the 1800s floor (neutralize fleet full-gate env pin)
  const scaled2Cpu = computeParallelPhaseTimeout(800, { cpus: 2, minMs: 0, ignoreEnv: true });
  // 120s + (800 * 5s) / 2 = 120s + 2000s = 2120s = 2,120,000 ms
  assertEquals(scaled2Cpu, 2_120_000);

  // On an 8-vCPU machine with 800 files, timeout scales down proportionally
  const scaled8Cpu = computeParallelPhaseTimeout(800, { cpus: 8, minMs: 0, ignoreEnv: true });
  // 120s + (800 * 5s) / 8 = 120s + 500s = 620s = 620,000 ms
  assertEquals(scaled8Cpu, 620_000);

  // Standard minMs floor preserves DEFAULT_PARALLEL_TIMEOUT_MS (1800s) for smaller counts
  const smallSuite = computeParallelPhaseTimeout(10, { cpus: 2, ignoreEnv: true });
  assertEquals(smallSuite, DEFAULT_PARALLEL_TIMEOUT_MS);

  // Production option-less call: for current suite size (~687 files), respects DEFAULT_PARALLEL_TIMEOUT_MS floor (882rr)
  const optionless = computeParallelPhaseTimeout(687);
  assert(optionless >= DEFAULT_PARALLEL_TIMEOUT_MS, "option-less call must respect at least the default floor");

  // On 2 CPUs with real suite size (687 files), scales above the 1800s floor (882rr)
  const scaledRealSuite2Cpu = computeParallelPhaseTimeout(687, { cpus: 2, ignoreEnv: true });
  assertEquals(scaledRealSuite2Cpu, 1_837_500);

  // Massive suite scales option-less above 1800s floor even on multi-core host
  const massiveSuite = computeParallelPhaseTimeout(5000, { cpus: 8, ignoreEnv: true });
  assertEquals(massiveSuite, 3_245_000);

  // Explicit positive envTimeout override is honored
  const overridden = computeParallelPhaseTimeout(800, { envTimeout: "999000", cpus: 2 });
  assertEquals(overridden, 999_000);

  // bzk6g: Explicit 0 or negative envTimeout disables the timeout (returns 0)
  const disabledZero = computeParallelPhaseTimeout(800, { envTimeout: "0", cpus: 2 });
  assertEquals(disabledZero, 0, "envTimeout 0 must return 0 to disable kill timer");
  const disabledNegative = computeParallelPhaseTimeout(800, { envTimeout: "-1", cpus: 2 });
  assertEquals(disabledNegative, 0, "negative envTimeout must return 0 to disable kill timer");
});
