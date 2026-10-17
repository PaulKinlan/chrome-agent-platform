// tests/parallel-durations.test.ts — chrome-agent-platform-6gk81: the
// per-file duration parser behind the gate manifest's suite_durations and
// scripts/update-test-weights.mjs. Fixtures are verbatim line shapes from the
// 2026-10-16 FULL gate log (tree 55876826), ANSI included.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  parseDenoDuration,
  parseSuiteDurations,
  slowestSuites,
  suiteDurationsObject,
} from "../scripts/lib/parallel-durations.mjs";

Deno.test("parallel-durations: every observed deno duration spelling parses to seconds", () => {
  assertEquals(parseDenoDuration("330µs"), 0.00033);
  assertEquals(parseDenoDuration("3ms"), 0.003);
  assertEquals(parseDenoDuration("12s"), 12);
  assertEquals(parseDenoDuration("3m56s"), 236);
  assertEquals(parseDenoDuration("2m"), 120);
  assertEquals(parseDenoDuration("0ms"), 0);
  assertEquals(parseDenoDuration("1.5s"), 1.5);
});

Deno.test("parallel-durations: unparseable durations are null, never a guess", () => {
  assertEquals(parseDenoDuration(""), null);
  assertEquals(parseDenoDuration("soon"), null);
  assertEquals(parseDenoDuration("12"), null);
  assertEquals(parseDenoDuration("-3s"), null);
  assertEquals(parseDenoDuration("3h2s"), null);
});

Deno.test("parallel-durations: per-test lines sum per file; steps are not double-counted", () => {
  // Verbatim shapes: a plain pass, a µs pass, a step line (two ` ... ` — its
  // 3ms is already inside the parent's 9s), an ignored test, a post-test
  // output interleave (no verdict), and a Check line.
  const output = [
    "\x1b[0m\x1b[32mCheck\x1b[0m tests/wasm-sync-workspace.test.ts",
    "\x1b[0m\x1b[38;5;245m./tests/wasm-sync-workspace.test.ts => \x1b[0mS1 seed: valid scratch ... \x1b[0m\x1b[32mok\x1b[0m \x1b[0m\x1b[38;5;245m(12s)\x1b[0m",
    "./tests/wasm-sync-workspace.test.ts => dense() bytes agree ... ok (330µs)",
    "./tests/durable-runs.test.ts => fault matrix ... after-outbox ... ok (3ms)",
    "./tests/durable-runs.test.ts => fault matrix ... ok (9s)",
    "./tests/acp-end-to-end.test.ts => ACP End-to-End (LIVE pi) ... ignored (0ms)",
    "./tests/quiet-window.test.ts => mkax: the quiet must be SUSTAINED ...----- post-test output end -----",
    "./tests/quiet-window.test.ts => mkax: the quiet must be SUSTAINED ... ok (2s)",
    "./tests/broken.test.ts => a failing case ... FAILED (1m2s)",
  ].join("\n");
  const totals = parseSuiteDurations(output);
  assertEquals(totals.get("tests/wasm-sync-workspace.test.ts"), 12.00033);
  assertEquals(totals.get("tests/durable-runs.test.ts"), 9, "step seconds counted once, via the parent");
  assertEquals(totals.get("tests/acp-end-to-end.test.ts"), 0);
  assertEquals(totals.get("tests/quiet-window.test.ts"), 2, "the interleave line adds nothing");
  assertEquals(totals.get("tests/broken.test.ts"), 62, "FAILED lines still carry their measured seconds");
  assertEquals(totals.size, 5);
});

Deno.test("parallel-durations: garbage input yields an empty map, never a throw", () => {
  assertEquals(parseSuiteDurations("").size, 0);
  assertEquals(parseSuiteDurations("not deno output\n\x1b[31mred\x1b[0m").size, 0);
  // @ts-expect-error: deliberately wrong type — the ledger must survive it
  assertEquals(parseSuiteDurations(null).size, 0);
});

Deno.test("parallel-durations: slowestSuites orders heaviest-first with deterministic ties", () => {
  const durations = new Map([
    ["tests/b.test.ts", 5.04],
    ["tests/a.test.ts", 5.02],
    ["tests/c.test.ts", 95],
  ]);
  assertEquals(slowestSuites(durations, 2), [
    { file: "tests/c.test.ts", secs: 95 },
    { file: "tests/a.test.ts", secs: 5 },
  ]);
});

Deno.test("parallel-durations: suiteDurationsObject sorts keys, rounds, and drops bad entries", () => {
  const out = suiteDurationsObject(new Map<string, number>([
    ["tests/z.test.ts", 1.26],
    ["tests/a.test.ts", 2],
    ["scripts/not-a-suite.mjs", 5],
    ["tests/nan.test.ts", Number.NaN],
    ["tests/neg.test.ts", -1],
  ]));
  assertEquals(Object.keys(out), ["tests/a.test.ts", "tests/z.test.ts"]);
  assertEquals(out["tests/z.test.ts"], 1.3);
  assert(!("tests/nan.test.ts" in out) && !("tests/neg.test.ts" in out), "unusable measurements are omitted, not emitted");
});
