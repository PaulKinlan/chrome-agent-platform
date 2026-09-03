// tests/refresh-model-prices.test.ts — pins the refresh merge logic WITHOUT
// network (review P2-1, beads chrome-agent-platform-pf0k): a refresh must
// never clobber audited cache fields the pricing source does not publish.
// llm-prices rows carry NO cache-write field at all (checked 2026-09-02:
// field union across current-v1.json is id/input/input_cached/name/output/
// vendor), so cacheWrite — and any cacheRead the source omits — survives only
// by carry-forward from the committed table.
// Falsification: delete the carry-forward loop in rebuildPricingTable and the
// first and third tests go RED.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  rebuildPricingTable,
  renderPricingModule,
} from "../scripts/refresh-model-prices.mjs";

Deno.test("refresh preserves audited cacheWrite the source never publishes", () => {
  const table = rebuildPricingTable({
    sourceRows: [{ id: "claude-fable-5-1", input: 10, output: 50, input_cached: 0.25 }],
    defaultPricing: {},
    existing: {
      "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    },
  });
  assertEquals(table["claude-fable-5-1"], {
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
  });
});

Deno.test("a source-published cacheRead wins over the carried-forward value", () => {
  const table = rebuildPricingTable({
    sourceRows: [{ id: "claude-sonnet-5", input: 2, output: 10, input_cached: 0.5 }],
    defaultPricing: {},
    existing: { "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  });
  assertEquals(table["claude-sonnet-5"], { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 2.5 });
});

Deno.test("refresh keeps audited cache fields on rows seeded only by agent-do defaults (gemini-3.1-pro)", () => {
  const table = rebuildPricingTable({
    sourceRows: [],
    defaultPricing: { "gemini-3.1-pro": { input: 2, output: 12 } },
    existing: { "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2 } },
  });
  assertEquals(table["gemini-3.1-pro"], { input: 2, output: 12, cacheRead: 0.2 });
});

Deno.test("rebuild never mutates the agent-do default rows (no aliasing)", () => {
  const defaults = { "gemini-3.1-pro": { input: 2, output: 12 } };
  rebuildPricingTable({
    sourceRows: [],
    defaultPricing: defaults,
    existing: { "gemini-3.1-pro": { input: 2, output: 12, cacheRead: 0.2 } },
  });
  assertEquals(defaults["gemini-3.1-pro"], { input: 2, output: 12 });
});

Deno.test("MANUAL_ROWS survive a refresh when no source lists them", () => {
  const table = rebuildPricingTable({ sourceRows: [], defaultPricing: {}, existing: {} });
  assertEquals(table["claude-opus-5"], { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
  assert(table["gemini-nano"]?.input === 0, "free on-device rows must stay zero-cost");
});

Deno.test("the rendered module serializes carried cache fields", () => {
  const out = renderPricingModule({ x: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 } });
  assert(out.includes('"x": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 },'));
});
