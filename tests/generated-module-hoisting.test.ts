// tests/generated-module-hoisting.test.ts — the generated descriptor module
// emits long repeated strings ONCE (chrome-agent-platform-ehsl: the store
// service-worker bundle sat ~10 bytes under its 3 MB budget when written
// (stale; measured 2,998,629 bytes = 1,371 bytes headroom on 2026-09-18, per
// chrome-agent-platform-4ctv's baseline), and per-row
// duplicates of the same caveat prose were several KB of it).
//
// These are PROPERTY pins, not prose pins: they fail if the hoisting stops
// happening (bytes returned to the bundle) or if it corrupts a value.

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { collectSharedStrings, renderHoistedValue } from "../scripts/lib/shared-strings.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
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

  // The file-size guard: original 50,000 ceiling was calibrated for 38 tools
  // (~1,316 B/tool). With 13 new hash-wasm tools admitted (51 total), the
  // proportional budget would be ~67,100 bytes. With string and full structure
  // hoisting (shared S table, capability arrays C*, licences L*, caveats V*), the emitted
  // module is compacted to 55,769 bytes (chrome-agent-platform-3ugl). The ceiling is set to
  // 56,500 bytes (hoisted size + ~1.3% headroom, ~731 B; each tool adds ~1,090 B so new tool
  // admissions ratchet this ceiling deliberately), ensuring dead-defs regressions
  // (56,611 B) and unhoisted structure regressions (58,744 B) fail.
  const bytes = (await Deno.stat(DATA_MODULE)).size;
  assert(bytes < 56_500, `the generated descriptor module should stay compact, was ${bytes} bytes`);

  // 3ugl / F2: Structure hoisting pins
  // Verify that all 3 hoisted structure kinds are actually emitted as definitions AND referenced in the rows
  const capDefs = text.match(/const C\d+ =/g)?.length ?? 0;
  const capRefs = text.match(/"capabilities": C\d+/g)?.length ?? 0;
  assert(capDefs >= 4, `must define at least 4 hoisted capability arrays (got ${capDefs})`);
  assert(capRefs >= 40, `must reference hoisted capability arrays across rows (got ${capRefs})`);

  const licDefs = text.match(/const L\d+ =/g)?.length ?? 0;
  const licRefs = text.match(/"licence": L\d+/g)?.length ?? 0;
  assert(licDefs >= 3, `must define at least 3 hoisted licence objects (got ${licDefs})`);
  assert(licRefs >= 30, `must reference hoisted licences across rows (got ${licRefs})`);

  const cavDefs = text.match(/const V\d+ =/g)?.length ?? 0;
  const cavRefs = text.match(/"caveats": V\d+/g)?.length ?? 0;
  assert(cavDefs >= 2, `must define at least 2 hoisted caveat arrays (got ${cavDefs})`);
  assert(cavRefs >= 15, `must reference hoisted caveats across rows (got ${cavRefs})`);
});

Deno.test("structure hoisting: round-trip re-rendering of BUNDLED_TOOL_PACKAGE_ROWS is deep-equal (3ugl / F4)", async () => {
  const { BUNDLED_TOOL_PACKAGE_ROWS } = await import("../extension/lib/bundled-tool-packages.data.js");
  const reRendered = renderHoistedValue({
    value: BUNDLED_TOOL_PACKAGE_ROWS,
    declaration: "BUNDLED_TOOL_PACKAGE_ROWS",
    sharedStrings: collectSharedStrings(BUNDLED_TOOL_PACKAGE_ROWS, { minLength: 5, minSaving: 1 }),
    tableName: "S",
    hoistStructures: true,
  });
  const mod = await import(`data:text/javascript,${encodeURIComponent(reRendered)}`);
  assertEquals(mod.BUNDLED_TOOL_PACKAGE_ROWS, BUNDLED_TOOL_PACKAGE_ROWS, "re-rendered rows must be strictly deep-equal to committed rows");
});

Deno.test("structure hoisting: survives regex-special characters and hoists repeated structures (3ugl / F2, F3)", async () => {
  const trickyCap1 = "tool:read(v1.0)+fast? [beta]";
  const trickyCap2 = "tool:write^$*\\complex";
  const trickyLic = { spdx: "MIT-0 (Custom+Ref)", file: "LICENCE.v1+2.txt", notices: null };
  const trickyCav = ["Note: item (a) + item (b) must be >= 100%", "Regex check: ^[a-z]+$"];

  const value = [
    { name: "tool-a", capabilities: [trickyCap1, trickyCap2], licence: trickyLic, caveats: trickyCav },
    { name: "tool-b", capabilities: [trickyCap1, trickyCap2], licence: trickyLic, caveats: trickyCav },
    { name: "tool-c", capabilities: [trickyCap1, trickyCap2], licence: trickyLic, caveats: trickyCav },
    { name: "tool-d", capabilities: [trickyCap1, trickyCap2], licence: trickyLic, caveats: trickyCav },
    { name: "tool-e", capabilities: [trickyCap1, trickyCap2], licence: trickyLic, caveats: trickyCav },
  ];

  const sharedStrings = collectSharedStrings(value, { minLength: 5, minSaving: 0 });
  const rendered = renderHoistedValue({
    value,
    declaration: "ROWS",
    sharedStrings,
    tableName: "TABLE",
    hoistStructures: true,
  });

  // Verify structure definitions and references exist
  assert(rendered.includes("const C0 = Object.freeze("), "capabilities must be hoisted into C0");
  assert(rendered.includes("const L0 = Object.freeze("), "licence must be hoisted into L0");
  assert(rendered.includes("const V0 = Object.freeze("), "caveats must be hoisted into V0");
  assert(rendered.includes('"capabilities": C0'), "capabilities C0 must be referenced");
  assert(rendered.includes('"licence": L0'), "licence L0 must be referenced");
  assert(rendered.includes('"caveats": V0'), "caveats V0 must be referenced");

  // Verify value survives round-trip deep-equal
  const mod = await import(`data:text/javascript,${encodeURIComponent(rendered)}`);
  assertEquals(mod.ROWS, value, "round-trip value with regex characters must be deep-equal");
});

Deno.test("structure hoisting: escapeRegex is load-bearing for unhoisted literals with regex metacharacters (3ugl / P1)", async () => {
  // By passing sharedStrings: [], every string inside capabilities/licence/caveats
  // remains a literal (never TABLE[n]), forcing elemPattern to take the escapeRegex(JSON.stringify(s)) branch.
  const row = {
    capabilities: ["a.b*c", "d+e?f", "x[y]z"],
    licence: { spdx: "MIT-0 (Custom+Ref)", file: "LICENCE.v1+2.txt", notices: null },
    caveats: ["Note: item (a) + item (b) must be >= 100%"],
  };
  const value = [row, row, row, row, row];
  const rendered = renderHoistedValue({
    value,
    declaration: "ROWS",
    sharedStrings: [],
    tableName: "TABLE",
    hoistStructures: true,
  });
  assert(rendered.includes('"capabilities": C0'), "capabilities with unhoisted regex metacharacters must be substituted");
  assert(rendered.includes('"licence": L0'), "licence with unhoisted regex metacharacters must be substituted");
  assert(rendered.includes('"caveats": V0'), "caveats with unhoisted regex metacharacters must be substituted");
  const mod = await import(`data:text/javascript,${encodeURIComponent(rendered)}`);
  assertEquals(mod.ROWS, value, "round-trip value with unhoisted regex metacharacters must be deep-equal");
});

Deno.test("structure hoisting: replacement count mismatch throws fail-closed (3ugl / P2)", () => {
  // A nested 'capabilities' array inside meta causes matchCount (4) to exceed expectedCount (3)
  const value = [
    { capabilities: ["x", "y"], meta: { capabilities: ["x", "y"] } },
    { capabilities: ["x", "y"] },
    { capabilities: ["x", "y"] },
  ];
  assertThrows(
    () => renderHoistedValue({ value, declaration: "ROWS", sharedStrings: [], hoistStructures: true }),
    Error,
    "replacement count mismatch",
  );
});
