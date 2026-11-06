// tests/impeccable-strip-param-selector-cache.test.ts — chrome-agent-platform-gx7n2
//
// stripParamSelector recompiled its `[data-p-<id>...]` RegExp on EVERY call —
// one compilation per selector per parameter during a CSS bake. The pattern
// depends only on the parameter id, so it is now memoised per id following the
// sibling segmentPatternCache pattern (context.mjs, wdfe2 family). This file
// is also the module's FIRST behavioural coverage: the semantics pins below
// hold the documented survival rules (steps vs toggle, presence vs valued
// forms, the :global() cleanup) so the memoisation cannot quietly change
// behaviour, and the cache pins hold instance reuse + /g-state safety (the
// shared regex is only ever used with String.replace, which resets lastIndex
// per call by spec — the pin below is the executable form of that argument).
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stripParamSelector, paramAttrPattern } from "../.agents/skills/impeccable/scripts/live/accept-css.mjs";

// --- semantics (unchanged by the memoisation) ---------------------------------

Deno.test("gx7n2 semantics: steps — the chosen branch survives stripped, a non-chosen branch drops", () => {
  assertEquals(stripParamSelector('[data-p-mode="dark"] .card', "mode", "steps", "dark"), ".card");
  assertEquals(stripParamSelector('[data-p-mode="dark"] .card', "mode", "steps", "light"), null);
  assertEquals(stripParamSelector('[data-p-mode] .card', "mode", "steps", "anything"), ".card", "the presence form survives any choice");
  // repeated calls with the SAME id (cache hits) give identical results — the
  // executable form of the /g-safety argument: replace() resets lastIndex
  assertEquals(stripParamSelector('[data-p-mode="dark"] .card', "mode", "steps", "dark"), ".card");
  assertEquals(stripParamSelector('[data-p-mode="dark"] .card', "mode", "steps", "dark"), ".card");
});

Deno.test("gx7n2 semantics: toggle — on keeps presence and 'on' forms, off drops everything, other values are dead regardless", () => {
  assertEquals(stripParamSelector("[data-p-t] .a", "t", "toggle", "on"), ".a");
  assertEquals(stripParamSelector('[data-p-t="on"] .a', "t", "toggle", "true"), ".a");
  assertEquals(stripParamSelector('[data-p-t="false"] .a', "t", "toggle", "on"), null, "a non-'on' valued form never matched at preview time");
  assertEquals(stripParamSelector("[data-p-t] .a", "t", "toggle", "0"), null, "off drops even the presence form");
  assertEquals(stripParamSelector('[data-p-t="on"] .a', "t", "toggle", "off"), null);
});

Deno.test("gx7n2 semantics: emptied :global() wrappers are cleaned up; combinator-leading remnants are trimmed", () => {
  assertEquals(stripParamSelector('.card:global([data-p-mode="dark"])', "mode", "steps", "dark"), ".card");
  assertEquals(stripParamSelector(':global([data-p-mode="dark"])', "mode", "steps", "dark"), null, "a selector that was ONLY the attribute strips to nothing");
  assertEquals(stripParamSelector('[data-p-mode="dark"] > .card', "mode", "steps", "dark"), ".card", "a leading combinator left by the strip is trimmed");
});

Deno.test("gx7n2 semantics: ids are escaped — a dotted id does not match a wildcard-expanded sibling", () => {
  assertEquals(stripParamSelector('[data-p-a.b="x"] .q', "a.b", "steps", "x"), ".q");
  assertEquals(stripParamSelector('[data-p-axb="x"] .q', "a.b", "steps", "x"), '[data-p-axb="x"] .q', "a different id's attribute selector is untouched");
});

// --- the cache itself ----------------------------------------------------------

Deno.test("gx7n2 cache: one compiled RegExp per parameter id, shared across calls, distinct per id", () => {
  const a1 = paramAttrPattern("cacheTestA");
  const a2 = paramAttrPattern("cacheTestA");
  const b1 = paramAttrPattern("cacheTestB");
  assert(a1 === a2, "the same id reuses the SAME compiled instance (the memoisation)");
  assert(a1 !== b1, "different ids compile different patterns");
  assert(a1.global, "the pattern keeps its /g flag (replace-all semantics)");
  assert(a1.source.includes("data-p-cacheTestA"), "the pattern targets the id's attribute");
  // and the shared instance behaves identically on consecutive replaces
  const sel = '[data-p-cacheTestA="1"] .x';
  assertEquals(stripParamSelector(sel, "cacheTestA", "steps", "1"), ".x");
  assertEquals(stripParamSelector(sel, "cacheTestA", "steps", "1"), ".x");
  assertEquals(stripParamSelector(sel, "cacheTestA", "steps", "2"), null);
  assertEquals(stripParamSelector(sel, "cacheTestA", "steps", "1"), ".x", "after a drop decision the shared regex is still clean");
});
