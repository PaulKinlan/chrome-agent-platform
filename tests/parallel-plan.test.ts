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
import { guardSubset, parallelPlan } from "../scripts/lib/parallel-plan.mjs";

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
