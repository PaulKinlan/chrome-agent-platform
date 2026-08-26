// @ts-nocheck
// tests/cap-perf.test.ts — KATs for the performance layer (cap-perf.js):
// spans record User-Timing measures, the summary aggregates honestly, the
// measure buffer is bounded with honest truncation, and clear works.
import {
  assert,
  assertEquals,
} from "jsr:@std/assert@1";
import {
  perfClear,
  perfSpan,
  perfSummary,
} from "../extension/lib/cap-perf.js";

function capMeasures() {
  return performance.getEntriesByType("measure").filter((e) => e.name.startsWith("cap:"));
}

Deno.test("cap-perf: a span records a measure with a non-negative duration", async () => {
  perfClear();
  const span = perfSpan("test:unit_span");
  await new Promise((r) => setTimeout(r, 5));
  const elapsed = span.end();
  assert(elapsed >= 0, `elapsed ${elapsed}`);
  const measures = performance.getEntriesByName("cap:test:unit_span");
  assertEquals(measures.length, 1);
  assert(measures[0].duration >= 0);
  // ending twice is idempotent
  assertEquals(span.end(), 0);
  assertEquals(performance.getEntriesByName("cap:test:unit_span").length, 1);
  perfClear();
});

Deno.test("cap-perf: summary aggregates count/total/avg/max/last per stage", () => {
  perfClear();
  for (let i = 0; i < 3; i++) perfSpan("test:agg").end();
  perfSpan("test:other").end();
  const summary = perfSummary();
  const agg = summary.measures.find((m) => m.name === "test:agg");
  const other = summary.measures.find((m) => m.name === "test:other");
  assert(agg, "agg stage present");
  assertEquals(agg.count, 3);
  assert(agg.totalMs >= 0 && agg.maxMs >= 0 && agg.avgMs >= 0);
  assert(other, "other stage present");
  assertEquals(other.count, 1);
  assert(typeof summary.generatedAt === "string");
  perfClear();
});

Deno.test("cap-perf: the measure buffer is bounded with honest truncation", () => {
  perfClear();
  const before = capMeasures().length;
  // 600 uniquely-named spans > MAX_MEASURES (500) forces the bound.
  for (let i = 0; i < 600; i++) perfSpan(`test:bound:${i}`).end();
  const after = capMeasures().length;
  assert(after <= 500, `bounded at 500, got ${after}`);
  const summary = perfSummary();
  assert(summary.truncated > 0, "truncation recorded honestly");
  perfClear();
  assertEquals(capMeasures().length, 0, "clear empties the cap measures");
});

Deno.test("cap-perf: names are sanitised and spans never throw without User Timing", () => {
  perfClear();
  const span = perfSpan("weird name/with\\slashes ✓");
  assertEquals(typeof span.end, "function");
  span.end("ok");
  const names = capMeasures().map((m) => m.name);
  assert(names.every((n) => /^cap:[0-9A-Za-z_:.\-]+$/.test(n)), `sanitised: ${names[0]}`);
  perfClear();
});
