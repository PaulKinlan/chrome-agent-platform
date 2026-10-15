// tests/parallel-schedule.test.ts — gate-speed (2026-10-08): the parallel phase's worker count and
// file ORDER (scripts/lib/parallel-schedule.mjs), retaining Deno's default worker count.
// The coverage property is the one that matters:
// scheduling may reorder the parallel set but must never add, drop or duplicate a file.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { loadWeights, scheduleOrder } from "../scripts/lib/parallel-schedule.mjs";
import { READ_ONLY_DIST } from "../scripts/test-partition.mjs";
import { defaultTestPlan, enumerateRunnerTests } from "../scripts/run-tests.mjs";

Deno.test("gate-speed: scheduleOrder is a permutation — same files, each exactly once", () => {
  const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts"];
  const out = scheduleOrder(files, { "tests/c.test.ts": 9, "tests/a.test.ts": 3, "tests/zzz-absent.test.ts": 99 });
  assertEquals(out.length, files.length, "no file added or dropped (a weight for an absent file adds nothing)");
  assertEquals([...out].sort(), [...files].sort(), "exactly the input files");
  assertEquals(new Set(out).size, out.length, "no duplicates");
});

Deno.test("gate-speed: scheduleOrder is longest-first, unweighted files keep their given order after", () => {
  const files = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.ts", "tests/e.test.ts"];
  const out = scheduleOrder(files, { "tests/d.test.ts": 2, "tests/b.test.ts": 40, "tests/e.test.ts": "NaN-ish" });
  assertEquals(out, ["tests/b.test.ts", "tests/d.test.ts", "tests/a.test.ts", "tests/c.test.ts", "tests/e.test.ts"]);
});

Deno.test("gate-speed: the committed weights table names only real parallel-phase files", () => {
  const weights = loadWeights();
  const names = Object.keys(weights);
  assert(names.length > 0, "the weights table loads (an empty table would silently disable longest-first)");
  const selected = defaultTestPlan(enumerateRunnerTests()).parallel
    .filter((file: string) => !READ_ONLY_DIST.has(file));
  const eligible = new Set(selected);
  const stale = names.filter((n) => !eligible.has(n));
  assertEquals(stale, [], "weights may name only selected parallel-phase files, not build/heavy/serial/read-only files");
  for (const n of names) assert(Number.isFinite(weights[n]) && weights[n] > 0, `${n} has a positive historical weight`);
  const ordered = scheduleOrder(selected, weights);
  assertEquals(ordered.length, selected.length, "scheduling must not add or drop a selected test");
  assertEquals([...ordered].sort(), [...selected].sort(), "the live parallel-phase file multiset is unchanged");
});
