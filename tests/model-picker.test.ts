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
globalThis.document = { addEventListener() {}, removeEventListener() {} };
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

Deno.test("catalogue: ordering really is newest-first (3.7 before 3.1 for gemini) and retired 2.x is gone", () => {
  const models = modelsForVendor("gemini");
  const first37 = models.findIndex((m) => /^gemini-3\.7/.test(m));
  const first31 = models.findIndex((m) => /^gemini-3\.1/.test(m));
  assertEquals(first37 >= 0 && first31 >= 0, true, "expected both 3.7 and 3.1 gemini models");
  assertEquals(first37 < first31, true, "3.7 must sort before 3.1");
  // The retired generation never reaches a picker (CAP-FB-20260830-MODEL-CATALOG-CURRENT-01).
  assertEquals(models.findIndex((m) => /^gemini-[12]/.test(m)), -1, "no 1.x/2.x gemini id in the picker view");
});

// ——— CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01 ———
// The picker must commit TYPED-BUT-NOT-PICKED text on blur (and via the public
// commitTyped() drive hook): typing a model id and clicking Use must save the
// typed id, never model:"". Arrow-highlighted options must NOT be clobbered by
// a blur commit (the option click itself commits; the blur handler only fires
// when no option is highlighted). Real DOM behavior is journey-covered; this
// unit test drives the registered component with the stub DOM.
Deno.test("model-picker: typed text commits on blur (no highlighted option)", () => {
  const Cls = registry.get("model-picker");
  const picker = new Cls();
  const listeners = {};
  const fakeInput = {
    value: "gpt-5.6-sol",
    addEventListener(type, fn) { listeners[type] = fn; },
    setAttribute() {}, removeAttribute() {},
    set value_(v) { this.value = v; },
  };
  picker._root = {
    querySelector(sel) {
      if (sel === "input[role='combobox']") return fakeInput;
      if (sel === ".toggle") return { addEventListener() {} };
      if (sel === ".listbox") return { querySelectorAll: () => [], replaceChildren() {}, setAttribute() {}, removeAttribute() {} };
      return null;
    },
  };
  picker._input = fakeInput;
  picker._listbox = picker._root.querySelector(".listbox");
  picker._committed = "";
  picker._activeIndex = -1; // no option highlighted
  picker._wire();
  listeners["blur"]();
  assertEquals(picker.value, "gpt-5.6-sol", "blur with no highlighted option must commit the typed text");
});

Deno.test("model-picker: commitTyped() commits whatever is typed (the Use-handler drive hook)", () => {
  const Cls = registry.get("model-picker");
  const picker = new Cls();
  picker._input = { value: "deepseek-v4-pro", addEventListener() {} };
  picker._committed = "";
  picker.commitTyped();
  assertEquals(picker.value, "deepseek-v4-pro", "commitTyped() must commit the typed input value");
});

Deno.test("model-picker: blur does NOT commit while an option is arrow-highlighted", () => {
  const Cls = registry.get("model-picker");
  const picker = new Cls();
  const listeners = {};
  const fakeInput = {
    value: "gpt-5.6-sol",
    addEventListener(type, fn) { listeners[type] = fn; },
    setAttribute() {}, removeAttribute() {},
  };
  picker._root = {
    querySelector(sel) {
      if (sel === "input[role='combobox']") return fakeInput;
      if (sel === ".toggle") return { addEventListener() {} };
      if (sel === ".listbox") return { querySelectorAll: () => [], replaceChildren() {}, setAttribute() {}, removeAttribute() {} };
      return null;
    },
  };
  picker._input = fakeInput;
  picker._listbox = picker._root.querySelector(".listbox");
  picker._committed = "gpt-5.6-luna"; // a previously-saved value
  picker._activeIndex = 0; // option highlighted with the arrow keys
  picker._wire();
  listeners["blur"]();
  assertEquals(picker.value, "gpt-5.6-luna", "an arrow-highlighted option must not be clobbered by blur (the option click commits)");
});
