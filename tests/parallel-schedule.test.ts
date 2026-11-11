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

// chrome-agent-platform-xhvfg (durable guard out of 5x4j4, coord ruling 2026-11-11): a STATIC
// per-suite weight CEILING over the committed table. 5x4j4 existed because single cases measured
// 90-380s (the pre-ifu81 wasm-sync-workspace monolith) ran BESIDE the browser/supervision suites
// and starved them into gate-only reds; the split + heavy-tier move removed that population (fresh
// full-run measurement: 329s phase wall, longest suite 58s), and the reorder died with it. This
// pin is what survives: if a parallel-phase suite ever regrows past the ceiling — in the table
// that gate-bookkeeping-freshness already pins to its source digest, so it cannot be dodged by
// hand-editing — this test names it, and the fix is the ifu81 shape (split it, or move it to the
// HEAVY tier with a reason), never raising the number to fit the work.
//
// DERIVATION OF THE NUMBER (named here so raising it is a deliberate, reviewed edit): the latest
// re-derived table (jw8a6, source: the 451a50399 FULL run) maxes at 90s
// (tests/serial-phase-resilience.test.ts, itself browser-dependent); the ceiling sits a little
// above that measured maximum at 120s — far enough to absorb run-to-run spread, less than half
// the 378s monolith case that made 5x4j4 necessary, so that population cannot come back silently.
export const PARALLEL_SUITE_WEIGHT_CEILING_S = 120;

/** The suites whose measured weight is over the ceiling (pure; the pin and its self-falsifier
 * share it, so the falsifier exercises the exact check the live table is held to). */
export function suitesOverWeightCeiling(weights: Record<string, number>, ceilingS = PARALLEL_SUITE_WEIGHT_CEILING_S) {
  return Object.entries(weights)
    .filter(([, seconds]) => Number(seconds) > ceilingS)
    .map(([file, seconds]) => `${file} (${seconds}s > ${ceilingS}s)`)
    .sort();
}

Deno.test("gate-speed: no parallel-phase suite's measured weight exceeds the static ceiling (xhvfg)", () => {
  const weights = loadWeights();
  assertEquals(
    suitesOverWeightCeiling(weights),
    [],
    "a suite this heavy belongs in the HEAVY tier (with a reason) or split (the ifu81 shape), " +
      "not beside the browser suites in the parallel phase — see chrome-agent-platform-5x4j4",
  );
});

Deno.test("gate-speed: the ceiling pin reds on a single weight raised above it (self-falsifier, xhvfg acceptance)", () => {
  // The coord-specified acceptance without touching the committed table: raise ONE weight above
  // the ceiling and the same check fails, naming the file and the excess.
  const weights = loadWeights();
  const victim = Object.keys(weights)[0];
  const raised = { ...weights, [victim]: PARALLEL_SUITE_WEIGHT_CEILING_S + 0.1 };
  const over = suitesOverWeightCeiling(raised);
  assertEquals(over.length, 1, "exactly the raised suite is named");
  assert(over[0].startsWith(`${victim} (`), `the offender is named with its weight: ${over[0]}`);
  // At exactly the ceiling it passes (the bound is >, not >=): the measured max must stay legal.
  assertEquals(suitesOverWeightCeiling({ ...weights, [victim]: PARALLEL_SUITE_WEIGHT_CEILING_S }), []);
});
