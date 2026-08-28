// tests/usage-viz.test.ts — the Usage panel's pure SVG/aggregation builders
// (lib/usage-viz.js) and the bounded per-tool call counters (lib/usage.js).
// The panel must render honest, bounded, escape-safe charts from aggregated
// usage data; these tests pin the shapes without a browser.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  USAGE_RANGES,
  dayBuckets,
  escapeSvgText,
  filterRowsByRange,
  formatCost,
  formatTokens,
  shareBars,
  svgDailyBars,
  svgShareBars,
  topTools,
} from "../extension/lib/usage-viz.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");

Deno.test("usage-viz: formatTokens uses compact units", () => {
  assertEquals(formatTokens(0), "0");
  assertEquals(formatTokens(999), "999");
  assertEquals(formatTokens(1500), "1.5K");
  assertEquals(formatTokens(2_300_000), "2.3M");
});

Deno.test("usage-viz: formatCost labels sub-cent as <$0.01", () => {
  assertEquals(formatCost(0), "$0.00");
  assertEquals(formatCost(0.004), "<$0.01");
  assertEquals(formatCost(1.256), "$1.26");
});

Deno.test("usage-viz: range filter is inclusive of the window only", () => {
  const rows = [
    { timestamp: "2026-08-28T11:00:00Z", inputTokens: 10 },
    { timestamp: "2026-08-21T12:00:00Z", inputTokens: 20 }, // exactly the 7d cutoff → included
    { timestamp: "2026-08-20T11:00:00Z", inputTokens: 30 }, // outside
    { timestamp: "not-a-date", inputTokens: 40 }, // unparsable → dropped
  ];
  const in7d = filterRowsByRange(rows, "7d", NOW);
  assertEquals(in7d.length, 2);
  const in24h = filterRowsByRange(rows, "24h", NOW);
  assertEquals(in24h.length, 1);
});

Deno.test("usage-viz: dayBuckets zero-fills missing days (continuous x-axis)", () => {
  const rows = [{ timestamp: "2026-08-28T10:00:00Z", inputTokens: 100, outputTokens: 50, estimatedCost: 0.5 }];
  const buckets = dayBuckets(rows, "7d", NOW);
  assertEquals(buckets.length, 7);
  const nonEmpty = buckets.filter((b) => b.inputTokens > 0);
  assertEquals(nonEmpty.length, 1);
  assertEquals(nonEmpty[0].day, "2026-08-28");
  assertEquals(nonEmpty[0].inputTokens, 100);
  assertEquals(nonEmpty[0].outputTokens, 50);
});

Deno.test("usage-viz: dayBuckets accepts pre-aggregated byDay entries", () => {
  const buckets = dayBuckets([{ day: "2026-08-28", inputTokens: 5, outputTokens: 6, calls: 2, estimatedCost: 1 }], "7d", NOW);
  assertEquals(buckets.length, 7);
  const hit = buckets.find((b) => b.day === "2026-08-28");
  assertEquals(hit.calls, 2);
});

Deno.test("usage-viz: shareBars normalize shares and cap to top N", () => {
  const models = [
    { model: "gpt-x", totalTokens: 600, calls: 6 },
    { model: "claude-y", totalTokens: 300, calls: 3 },
    { model: "nano-z", totalTokens: 100, calls: 1 },
    { model: "zero", totalTokens: 0, calls: 0 }, // filtered out
  ];
  const bars = shareBars(models, "totalTokens", 2) as unknown as Array<{ label: string, share: number }>;
  assertEquals(bars.length, 2);
  assertEquals(bars[0].label, "gpt-x");
  assertEquals(bars[0].share, 67); // 600/900
  assertEquals(bars[1].share, 33);
});

Deno.test("usage-viz: topTools sorts by calls and truncates", () => {
  const tools = [
    { tool: "tabs.create", calls: 3 },
    { tool: "browser_control", calls: 9 },
    { tool: "screenshot", calls: 0 },
    { tool: "jq", calls: 5 },
  ];
  const top = topTools(tools, 2) as unknown as Array<{ label: string }>;
  assertEquals(top.map((t) => t.label), ["browser_control", "jq"]);
});

Deno.test("usage-viz: SVG output escapes hostile labels (no injection)", () => {
  assertEquals(escapeSvgText(`<img src=x onerror="a">`), "&lt;img src=x onerror=&quot;a&quot;&gt;");
  const hostile = [{ label: `<script>alert(1)</script>`, value: 5, calls: 1, share: 100 }];
  const svg = svgShareBars(hostile, { kind: "models" });
  assert(!svg.includes("<script>"), "hostile label must be escaped");
  assertStringIncludes(svg, "&lt;script&gt;");
});

Deno.test("usage-viz: daily bars are theme-token SVG with titles, not inline styles", () => {
  const buckets = dayBuckets([{ timestamp: "2026-08-28T10:00:00Z", inputTokens: 100, outputTokens: 40 }], "7d", NOW);
  const svg = svgDailyBars(buckets);
  assertStringIncludes(svg, `role="img"`);
  assertStringIncludes(svg, `class="usage-bar-in"`);
  assertStringIncludes(svg, `class="usage-bar-out"`);
  assert(!svg.includes("style=\"fill"), "colors must come from CSS tokens, not inline styles");
  assert(!svg.includes("#0e6e63"), "no hardcoded colors in chart output");
});

Deno.test("usage-viz: empty data renders the honest empty state", () => {
  const svg = svgDailyBars(dayBuckets([], "7d", NOW));
  assertStringIncludes(svg, "No usage recorded yet");
  const share = svgShareBars([], { kind: "tools" });
  assertStringIncludes(share, "No usage recorded yet");
});

Deno.test("usage-viz: ranges expose only what the ledger can honestly serve", () => {
  assertEquals(Object.keys(USAGE_RANGES), ["24h", "7d"]);
});
