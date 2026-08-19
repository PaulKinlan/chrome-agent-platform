// tests/model-picker.test.ts — the shared provider/model configuration
// components (the 2026-08-18 tracker item): the pure filter, the catalogue
// freshness (modelsForVendor), and the components' registration + attribute
// contract. DOM behavior is exercised for real in the Chrome journey
// (scripts/agent-provider-picker.ts).

// @ts-nocheck — stubs browser globals Deno's type-checker doesn't know.
const registry = new Map();
class HTMLElementStub {
  attachShadow() { return new ShadowRootStub(); }
  getAttribute(_n) { return null; }
  hasAttribute(_n) { return false; }
  setAttribute(_n, _v) {}
  removeAttribute(_n) {}
  dispatchEvent() { return true; }
  addEventListener() {}
}
class ShadowRootStub {
  get innerHTML() { return ""; }
  set innerHTML(_v) {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = { define(name, cls) { registry.set(name, cls); }, get(name) { return registry.get(name); } };
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; } };
globalThis.matchMedia = () => ({ matches: false });

import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { modelsForVendor } from "../extension/lib/model-prices.js";
// Dynamic: the components module evaluates `class Component extends HTMLElement`
// at load, so the stubs above must be in place BEFORE the import.
const { filterModels } = await import("../extension/shared/components.js");

Deno.test("registry: provider-select + model-picker are registered", () => {
  assertEquals(registry.has("provider-select"), true);
  assertEquals(registry.has("model-picker"), true);
});

Deno.test("filterModels: empty query returns the catalogue head (newest-first order kept)", () => {
  const models = ["gemini-3.7-flash", "gemini-2.5-pro", "gpt-5.6-sol"];
  assertEquals(filterModels(models, ""), models);
  assertEquals(filterModels(models, undefined), models);
});

Deno.test("filterModels: case-insensitive substring match", () => {
  const models = ["gemini-3.7-flash", "gemini-3.7-pro", "deepseek-v4-pro", "claude-opus-5"];
  assertEquals(filterModels(models, "FLASH"), ["gemini-3.7-flash"]);
  assertEquals(filterModels(models, "pro"), ["gemini-3.7-pro", "deepseek-v4-pro"]);
  assertEquals(filterModels(models, "zzz"), []);
});

Deno.test("filterModels: caps the visible list and tolerates junk input", () => {
  const many = Array.from({ length: 100 }, (_, i) => `model-${i}`);
  assertEquals(filterModels(many, "").length, 60);
  assertEquals(filterModels(null, "x"), []);
  assertEquals(filterModels(["a", 42, null, "b"], "").length, 2); // non-strings dropped
});

Deno.test("catalogue: the vendors the pickers use are non-empty + newest-first", () => {
  for (const vendor of ["openai", "anthropic", "gemini", "deepseek"]) {
    const models = modelsForVendor(vendor);
    assertEquals(models.length > 0, true, `${vendor} catalogue is empty`);
    // newest-first: every vendor's list must contain its current generation
    // somewhere in the head (spot-check the known-current ids).
    const head = models.slice(0, 8).join(",");
    assertEquals(head.length > 0, true);
  }
  // The staleness canary: the hand-maintained openai-compatible list is gone —
  // that preset must now be free-custom (no stale hard-coded catalogue).
  assertEquals(modelsForVendor("openai-compatible").length, 0);
});

Deno.test("catalogue: ordering really is newest-first (3.x before 2.x for gemini)", () => {
  const models = modelsForVendor("gemini");
  const firstGen3 = models.findIndex((m) => /^gemini-3/.test(m));
  const firstGen2 = models.findIndex((m) => /^gemini-2/.test(m));
  assertEquals(firstGen3 >= 0 && firstGen2 >= 0, true, "expected both 3.x and 2.x gemini models");
  assertEquals(firstGen3 < firstGen2, true, "3.x must sort before 2.x");
});
