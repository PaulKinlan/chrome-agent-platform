// tests/generated-module-hoisting.test.ts — the generated descriptor module
// emits long repeated strings ONCE (chrome-agent-platform-ehsl: the store
// service-worker bundle sat ~10 bytes under its 3 MB budget, and per-row
// duplicates of the same caveat prose were several KB of it).
//
// These are PROPERTY pins, not prose pins: they fail if the hoisting stops
// happening (bytes returned to the bundle) or if it corrupts a value.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { collectSharedStrings, renderHoistedValue } from "../scripts/lib/shared-strings.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const DATA_MODULE = `${ROOT}extension/lib/bundled-tool-packages.data.js`;

Deno.test("shared-string hoisting: repeats are hoisted, one-offs are not, order is stable", () => {
  const repeated = "x".repeat(60);
  const unique = "y".repeat(60);
  const short = "z".repeat(10);
  const value: Record<string, unknown> = {
    a: [repeated, repeated],
    b: repeated,
    c: unique,
    d: [short, short, short, short],
    e: { nested: repeated },
  };
  const shared = collectSharedStrings(value, { minLength: 40, minCount: 3 });
  assertEquals(shared, [repeated], "only strings repeated >= 3 times and >= 40 chars hoist");
  // Deterministic output: the same input yields the same table order.
  assertEquals(collectSharedStrings(value, { minLength: 40, minCount: 3 }), shared);
});

Deno.test("shared-string hoisting: values survive the round trip (including escapes)", () => {
  const tricky = 'quote " backslash \\ newline \n tab \t null \u0000 end — with enough length to hoist';
  const value: unknown[] = [tricky, tricky, tricky, { deep: [tricky] }];
  const text = renderHoistedValue({ value, declaration: "ROWS", sharedStrings: collectSharedStrings(value) });
  return import(`data:text/javascript,${encodeURIComponent(text)}`).then((mod) => {
    assertEquals(JSON.stringify(mod.ROWS), JSON.stringify(value), "the exported value is unchanged");
  });
});

Deno.test("shared-string hoisting: a value with no repeats renders exactly as plain JSON", () => {
  const value: unknown[] = [{ a: "one-off string that is long enough to matter but never repeats" }];
  const plain = `export const ROWS = Object.freeze(${JSON.stringify(value, null, 1)});\n`;
  const rendered = renderHoistedValue({ value, declaration: "ROWS", sharedStrings: collectSharedStrings(value) });
  assertEquals(rendered, plain, "no repeats must mean no churn in the generated file");
});

Deno.test("the generated descriptor module keeps every value AND pays for the repeated prose once", async () => {
  const { BUNDLED_TOOL_PACKAGE_ROWS } = await import("../extension/lib/bundled-tool-packages.data.js");
  const text = await Deno.readTextFile(DATA_MODULE);

  // The repeated caveat prose appears as a VALUE (proving nothing was dropped)…
  const values = new Set();
  const visit = (v: unknown): void => {
    if (typeof v === "string") { values.add(v); return; }
    if (Array.isArray(v)) { for (const i of v) visit(i); return; }
    if (v && typeof v === "object") { for (const k of Object.keys(v)) visit((v as Record<string, unknown>)[k]); }
  };
  visit(BUNDLED_TOOL_PACKAGE_ROWS);
  const repeatedInValues = collectSharedStrings(BUNDLED_TOOL_PACKAGE_ROWS);
  assert(repeatedInValues.length >= 1, "the rows still contain repeated long prose worth hoisting");

  // …and ONCE in the file (this is the byte reclaim: a regression puts N copies back).
  for (const shared of repeatedInValues) {
    // Count the QUOTED literal: a hoisted string may legitimately be a substring
    // of a longer one (a raw substring count then reports copies that are not
    // copies at all).
    const occurrences = text.split(JSON.stringify(shared)).length - 1;
    assertEquals(
      occurrences,
      1,
      `a hoisted string must appear exactly once in the generated module, saw ${occurrences}: ${shared.slice(0, 60)}…`,
    );
  }

  // The file-size guard: hoisting reclaimed ~3.5 KB (52,275 -> 48,712 at the time
  // of writing). A generous ceiling, so ordinary row growth is fine but losing
  // the hoisting is not.
  const bytes = (await Deno.stat(DATA_MODULE)).size;
  assert(bytes < 50_000, `the generated descriptor module should stay compact, was ${bytes} bytes`);
});
