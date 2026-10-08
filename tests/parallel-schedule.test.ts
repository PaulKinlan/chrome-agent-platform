// tests/parallel-schedule.test.ts — gate-speed (2026-10-08): the parallel phase's worker count and
// file ORDER (scripts/lib/parallel-schedule.mjs). The coverage property is the one that matters:
// scheduling may reorder the parallel set but must never add, drop or duplicate a file.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { loadWeights, parallelJobs, scheduleOrder } from "../scripts/lib/parallel-schedule.mjs";
import { partition } from "../scripts/test-partition.mjs";

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
  const all: string[] = [];
  for (const e of Deno.readDirSync(new URL("./", import.meta.url))) {
    if (e.isFile && e.name.endsWith(".test.ts")) all.push(`tests/${e.name}`);
  }
  const parallel = new Set(partition(all).parallel);
  const stale = names.filter((n) => !parallel.has(n));
  assertEquals(stale, [], "a weight for a renamed/removed/serial file is stale: re-measure and update test-weights.json");
  for (const n of names) assert(Number.isFinite(weights[n]) && weights[n] > 0, `${n} has a positive measured weight`);
});

Deno.test("gate-speed: parallelJobs — CAP_TEST_JOBS wins; default is 2 per CPU within [4, 16]", () => {
  assertEquals(parallelJobs({ env: { CAP_TEST_JOBS: "7" }, cpus: 2 }), 7);
  assertEquals(parallelJobs({ env: { CAP_TEST_JOBS: "0" }, cpus: 2 }), 4, "a non-positive override is ignored");
  assertEquals(parallelJobs({ env: { CAP_TEST_JOBS: "x" }, cpus: 3 }), 6);
  assertEquals(parallelJobs({ env: {}, cpus: 1 }), 4);
  assertEquals(parallelJobs({ env: {}, cpus: 2 }), 4);
  assertEquals(parallelJobs({ env: {}, cpus: 4 }), 8);
  assertEquals(parallelJobs({ env: {}, cpus: 32 }), 16);
});
