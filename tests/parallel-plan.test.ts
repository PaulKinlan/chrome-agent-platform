// tests/parallel-plan.test.ts — chrome-agent-platform-kz27.
//
// THE DEFECT: run-tests.mjs ran the parallel phase only when the serial phase was green
// (`if (rc === 0) rc = runParallel(parallel)`), so ONE serial failure skipped ~500 parallel files —
// and the always-on guards live in the parallel set. Measured: two guard violations reached main from
// one landing while its full-suite gate reported the guards green, because they never ran.
//
// THE RULE THIS PINS: a guard result must never be conditional on an unrelated phase passing.
// 0o0um/5xg1w UPGRADE: a failed serial phase now STILL RUNS the parallel phase IN FULL — the old
// guard-subset compromise skipped ~711 of 759 files and turned one serial death into an
// unadjudicable record filed as a permanent FAIL against a content-addressed tree.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  certificationGaps,
  computeParallelPhaseTimeout,
  DEFAULT_PARALLEL_TIMEOUT_MS,
  guardSubset,
  parallelPlan,
} from "../scripts/lib/parallel-plan.mjs";
import { ENVIRONMENTAL_REFUSAL_EXIT } from "../scripts/lib/environmental-verdict.mjs";

const PARALLEL = ["tests/a.test.ts", "tests/b.test.ts", "tests/durable-root.test.ts", "tests/c.test.ts"];
const ALWAYS_ON = ["tests/durable-root.test.ts", "tests/core.test.ts"];

Deno.test("kz27: a GREEN serial phase runs the whole parallel phase and announces nothing", () => {
  const plan = parallelPlan({ serialRc: 0, parallel: PARALLEL, alwaysOn: ALWAYS_ON });
  assertEquals(plan.files, PARALLEL, "a green serial phase must not narrow the parallel set");
  assertEquals(plan.skipped, 0);
  assertEquals(plan.announce, null, "nothing was skipped, so there is nothing to announce");
});

Deno.test("kz27→0o0um: a FAILED serial phase STILL RUNS the full parallel set, and says so", () => {
  const plan = parallelPlan({ serialRc: 1, parallel: PARALLEL, alwaysOn: ALWAYS_ON });
  // A serial death is a finding about ONE file, not a licence to skip the others.
  assertEquals(plan.files, PARALLEL, "a failed serial phase must not narrow the parallel set");
  assertEquals(plan.skipped, 0, "nothing is skipped, so the run stays a COMPLETED verdict");
  assert(plan.incomplete === undefined, "a completed red is a verdict on the tree, not an INCOMPLETE abort");
  assert(plan.announce !== null, "the serial failure and the full parallel run must be announced");
  assert(plan.announce.includes("serial file(s) failed"), plan.announce);
  assert(plan.announce.includes("STILL RUNS in full"), plan.announce);
  assert(plan.announce.includes("COMPLETED verdict"), plan.announce);
  // The old skip wording must never come back on this route: nothing was skipped, and a log that says
  // SKIPPED while the cache files a plain FAIL is the exact defect this bead exists to kill.
  assert(!plan.announce.includes("SKIPPED"), `nothing was skipped: ${plan.announce}`);
  assert(!plan.announce.includes("GUARD SET"), `the guard-subset compromise is retired: ${plan.announce}`);
});

Deno.test("0o0um: the failure plan never narrows to the guard subset (that WAS the defect)", () => {
  // FALSIFICATION, both directions: a regression to the kz27 guard subset narrows `files`; a
  // regression to "run nothing" empties it. Only "run everything" passes.
  const failed = parallelPlan({ serialRc: 1, parallel: PARALLEL, alwaysOn: ALWAYS_ON });
  assertEquals(failed.files.length, PARALLEL.length);
  // The intersection primitive stays available (select-tests and the refusal wording use it) — the
  // plan simply no longer narrows to it on a serial failure.
  assertEquals(guardSubset(PARALLEL, ALWAYS_ON), ["tests/durable-root.test.ts"]);
  // An always-on file that is not in this run's parallel set is simply not run here (it belongs to
  // another phase) — the subset is an intersection, not an assumption.
  assertEquals(guardSubset(PARALLEL, ["tests/not-in-this-run.test.ts"]), []);
  assert(
    failed.files.length > guardSubset(PARALLEL, ALWAYS_ON).length,
    "the guard-subset narrowing is what made the gate record unadjudicable; it must never return",
  );
});

Deno.test("xj6sb: an ENVIRONMENTAL REFUSAL (exit 75) in serial phase runs the full parallel phase (0 skipped) with refusal stated", () => {
  const plan = parallelPlan({ serialRc: ENVIRONMENTAL_REFUSAL_EXIT, parallel: PARALLEL, alwaysOn: ALWAYS_ON });
  assertEquals(plan.files, PARALLEL, "environmental refusal must run the entire parallel suite to verify the tree");
  assertEquals(plan.skipped, 0, "environmental refusal must not skip any parallel file");
  assert(plan.announce !== null, "refusal announcement must be stated");
  assert(plan.announce.includes("REFUSED"), plan.announce);
  assert(plan.announce.includes("exit 75"), plan.announce);
  assert(plan.announce.includes("running the full parallel phase"), plan.announce);
  assert(plan.announce.includes("never quietly skipping files"), plan.announce);
});

Deno.test("xj6sb: a FAILED serial phase names failing files in announcement", () => {
  const plan = parallelPlan({
    serialRc: 1,
    parallel: PARALLEL,
    alwaysOn: ALWAYS_ON,
    failingFiles: ["tests/ntp-boot-staging.test.ts"],
  });
  assertEquals(plan.files, PARALLEL, "0o0um: the named failure does not narrow the parallel set");
  assertEquals(plan.skipped, 0);
  assert(plan.announce !== null);
  assert(plan.announce.includes("serial file(s) failed [tests/ntp-boot-staging.test.ts]"), plan.announce);
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

// chrome-agent-platform-w6kc0, updated by 0o0um/5xg1w: the plan itself no longer skips on a serial
// failure (it runs everything, so it is a COMPLETED red with no gap). The gap machinery survives for
// the routes that genuinely cannot continue — a seam that declined a phase reports its unrun files as
// unrun, and certificationGaps still names cause and count for them.
Deno.test("w6kc0→0o0um: a failed serial phase yields NO plan gap (it runs everything); a declined phase still does", () => {
  const plan = parallelPlan({ serialRc: 1, parallel: PARALLEL, alwaysOn: ["tests/a.test.ts"], failingFiles: ["tests/serial-x.test.ts"] });
  assertEquals(plan.skipped, 0, "the failure plan runs the full parallel set — nothing is skipped");
  assertEquals(plan.incomplete, undefined, "a completed red is a verdict, not an INCOMPLETE abort");
  const announce = String(plan.announce ?? "");
  assert(announce.length > 0, "the serial failure and the full parallel run must be announced");
  assert(announce.includes("serial file(s) failed [tests/serial-x.test.ts]"), announce);
  assert(announce.includes("STILL RUNS in full"), announce);
  assertEquals(certificationGaps(plan), [], "a plan that skips nothing has no certification gap");

  // The seam route (CAP_RUN_TESTS_STOP_AFTER_SERIAL) reports every parallel file as unrun; the gap
  // must still carry the cause and the exact count — this is what makes the run INCOMPLETE (exit 76).
  const declined = certificationGaps({ skipped: 3 });
  assertEquals(declined.length, 1, "exactly one gap, named");
  assert(declined[0].includes("3 file(s) unrun"), `the gap must carry the count: ${declined[0]}`);
  assert(declined[0].includes("serial"), `the gap must carry the cause: ${declined[0]}`);
});

Deno.test("w6kc0: a complete run certifies — the guard cannot false-alarm", () => {
  const plan = parallelPlan({ serialRc: 0, parallel: PARALLEL, alwaysOn: [] });
  assertEquals(plan.skipped, 0, "a green serial phase runs everything");
  assertEquals(plan.incomplete, undefined, "nothing was skipped, so nothing is incomplete");
  assertEquals(certificationGaps(plan), [], "a complete run has no gap and must stay certifiable");
  // And a refusal (exit 75) runs the whole parallel phase: skipping files on environmental contention is
  // never allowed, so it is not a gap either.
  const refused = parallelPlan({ serialRc: 75, parallel: PARALLEL, alwaysOn: [] });
  assertEquals(refused.skipped, 0, "an environmental refusal must not skip files");
  assertEquals(certificationGaps(refused), [], "a refusal is not a skip");
});
