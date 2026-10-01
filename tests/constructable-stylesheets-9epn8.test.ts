// @ts-nocheck
// tests/constructable-stylesheets-9epn8.test.ts
// Falsification tests for bead chrome-agent-platform-9epn.8:
// Constructable stylesheets (adoptedStyleSheets) for shadow components.

import { assertEquals, assertNotEquals, assertStrictEquals } from "jsr:@std/assert";

const registry = new Map();
class HTMLElementStub {
  constructor() {
    this._attrs = new Map();
    this._root = null;
  }
  attachShadow() {
    this._root = new MockShadowRoot(globalThis.__mockHasAdopted ?? true);
    return this._root;
  }
  getAttribute(n) { return this._attrs.get(n) ?? null; }
  hasAttribute(n) { return this._attrs.has(n); }
  setAttribute(n, v) { this._attrs.set(n, String(v)); }
  removeAttribute(n) { this._attrs.delete(n); }
  dispatchEvent() { return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
};
globalThis.matchMedia = () => ({ matches: false });



// Mock CSSStyleSheet for testing constructable stylesheets in Deno
class MockCSSStyleSheet {
  constructor() {
    this.cssText = "";
  }
  replaceSync(text) {
    this.cssText = text;
  }
}

class MockShadowRoot {
  constructor(hasAdopted = true) {
    if (hasAdopted) {
      this.adoptedStyleSheets = [];
    }
    this._innerHTML = "";
    this.children = [];
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(val) {
    this._innerHTML = val;
  }
  querySelector(sel) {
    if (sel === "style") {
      return this.children.find((c) => c.tagName === "style") || null;
    }
    return null;
  }
  prepend(child) {
    this.children.unshift(child);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

class MockElement {
  static shadow() {
    return true;
  }
  constructor(hasAdopted = true) {
    this._root = new MockShadowRoot(hasAdopted);
    this.localName = "mock-element";
  }
}

Deno.test("9epn.8: getConstructableSheet memoizes one CSSStyleSheet instance per cssText", async () => {
  const prevCSS = globalThis.CSSStyleSheet;
  try {
    globalThis.CSSStyleSheet = MockCSSStyleSheet;
    const mod = await import(`../extension/shared/components.js?v=test-${Date.now()}-1`);
    if (typeof mod.getConstructableSheet !== "function") {
      throw new Error("getConstructableSheet is not exported or not a function");
    }

    const css1 = ":host { display: block; color: teal; }";
    const css2 = ":host { display: flex; color: amber; }";

    const sheet1 = mod.getConstructableSheet(css1);
    const sheet2 = mod.getConstructableSheet(css1);
    const sheet3 = mod.getConstructableSheet(css2);

    assertStrictEquals(sheet1, sheet2, "Same cssText must return the exact same CSSStyleSheet reference");
    assertNotEquals(sheet1, sheet3, "Different cssText must return different CSSStyleSheet instances");
    assertEquals(sheet1.cssText, css1);
    assertEquals(sheet3.cssText, css2);
  } finally {
    if (prevCSS === undefined) delete globalThis.CSSStyleSheet;
    else globalThis.CSSStyleSheet = prevCSS;
  }
});

Deno.test("9epn.8: adoptOrInjectStyle adopts constructable stylesheet when supported without duplication", async () => {
  const prevCSS = globalThis.CSSStyleSheet;
  try {
    globalThis.CSSStyleSheet = MockCSSStyleSheet;
    const mod = await import(`../extension/shared/components.js?v=test-${Date.now()}-2`);
    if (typeof mod.adoptOrInjectStyle !== "function") {
      throw new Error("adoptOrInjectStyle is not exported or not a function");
    }

    const shadow1 = new MockShadowRoot(true);
    const shadow2 = new MockShadowRoot(true);
    const css = ".bubble { padding: 8px; }";

    const adopted1 = mod.adoptOrInjectStyle(shadow1, css);
    const adopted2 = mod.adoptOrInjectStyle(shadow2, css);

    assertEquals(adopted1, true, "Should return true when adoptedStyleSheets is supported");
    assertEquals(adopted2, true, "Should return true when adoptedStyleSheets is supported");
    assertEquals(shadow1.adoptedStyleSheets.length, 1);
    assertEquals(shadow2.adoptedStyleSheets.length, 1);
    assertStrictEquals(shadow1.adoptedStyleSheets[0], shadow2.adoptedStyleSheets[0], "Both shadow roots must share the exact same sheet object");

    // Idempotent: re-adopting the same sheet does not duplicate it
    const reAdopt = mod.adoptOrInjectStyle(shadow1, css);
    assertEquals(reAdopt, true);
    assertEquals(shadow1.adoptedStyleSheets.length, 1, "Must not duplicate stylesheet in adoptedStyleSheets");
  } finally {
    if (prevCSS === undefined) delete globalThis.CSSStyleSheet;
    else globalThis.CSSStyleSheet = prevCSS;
  }
});

Deno.test("9epn.8: adoptOrInjectStyle falls back to style element when adoptedStyleSheets is unsupported", async () => {
  const prevCSS = globalThis.CSSStyleSheet;
  const prevDoc = globalThis.document;
  try {
    delete globalThis.CSSStyleSheet;
    globalThis.document = {
      createElement(tag) {
        return { tagName: tag, textContent: "" };
      },
    };
    const mod = await import(`../extension/shared/components.js?v=test-${Date.now()}-3`);
    if (typeof mod.adoptOrInjectStyle !== "function") {
      throw new Error("adoptOrInjectStyle is not exported or not a function");
    }

    const shadowNoAdopt = new MockShadowRoot(false);
    const css = ".fallback { margin: 4px; }";

    const adopted = mod.adoptOrInjectStyle(shadowNoAdopt, css);
    assertEquals(adopted, false, "Should return false when adoptedStyleSheets is unsupported");
    assertEquals(shadowNoAdopt.children.length, 1, "Should inject a fallback style element");
    assertEquals(shadowNoAdopt.children[0].tagName, "style");
    assertEquals(shadowNoAdopt.children[0].textContent, css);
  } finally {
    if (prevCSS === undefined) delete globalThis.CSSStyleSheet;
    else globalThis.CSSStyleSheet = prevCSS;
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
});

Deno.test("9epn.8: mountTemplate uses adoptedStyleSheets without injecting <style> in markup when supported", async () => {
  const prevCSS = globalThis.CSSStyleSheet;
  try {
    globalThis.CSSStyleSheet = MockCSSStyleSheet;
    const mod = await import(`../extension/shared/components.js?v=test-${Date.now()}-4`);
    if (typeof mod.mountTemplate !== "function") {
      throw new Error("mountTemplate is not exported or not a function");
    }

    const host1 = new MockElement(true);
    const host2 = new MockElement(true);
    const css = ":host { display: flex; }";
    const markup = '<div class="content">Hello</div>';

    mod.mountTemplate(host1, css, markup);
    mod.mountTemplate(host2, css, markup);

    // Both instances share the exact same sheet object
    assertEquals(host1._root.adoptedStyleSheets.length, 1);
    assertEquals(host2._root.adoptedStyleSheets.length, 1);
    assertStrictEquals(host1._root.adoptedStyleSheets[0], host2._root.adoptedStyleSheets[0], "Both component instances share the exact same sheet instance");

    // In constructable stylesheets mode, <style> is NOT in innerHTML (saving DOM nodes!)
    assertEquals(host1._root.innerHTML, markup, "innerHTML should not contain <style> tag when adopted");
    assertEquals(host1._root.innerHTML.includes("<style>"), false, "No style element in shadow DOM");
  } finally {
    if (prevCSS === undefined) delete globalThis.CSSStyleSheet;
    else globalThis.CSSStyleSheet = prevCSS;
  }
});

Deno.test("9epn.8: mountTemplate falls back to <style> tag in innerHTML when adoptedStyleSheets is unsupported", async () => {
  const prevCSS = globalThis.CSSStyleSheet;
  try {
    delete globalThis.CSSStyleSheet;
    const mod = await import(`../extension/shared/components.js?v=test-${Date.now()}-5`);
    if (typeof mod.mountTemplate !== "function") {
      throw new Error("mountTemplate is not exported or not a function");
    }

    const host = new MockElement(false);
    const css = ":host { display: block; }";
    const markup = '<div class="fallback">Test</div>';

    mod.mountTemplate(host, css, markup);

    // Fallback: <style> tag is present in innerHTML for compatibility with test mock DOMs
    assertEquals(host._root.innerHTML, `<style>${css}</style>${markup}`);
  } finally {
    if (prevCSS === undefined) delete globalThis.CSSStyleSheet;
    else globalThis.CSSStyleSheet = prevCSS;
  }
});

Deno.test("9epn.8: high-instance components share a single constructable CSSStyleSheet across instances", async () => {
  const prevCSS = globalThis.CSSStyleSheet;
  try {
    globalThis.CSSStyleSheet = MockCSSStyleSheet;
    globalThis.__mockHasAdopted = true;
    const mod = await import(`../extension/shared/components.js?v=test-${Date.now()}-6`);

    const tagsToTest = [
      "message-bubble",
      "switch-toggle",
      "capability-row",
      "artifact-card",
      "agent-identity",
      "loading-state",
      "conversation-run-status",
      "permission-approval-card",
      "activity-explorer",
      "action-ledger",
      "jobs-board",
    ];

    for (const tag of tagsToTest) {
      const Cls = registry.get(tag);
      if (!Cls) {
        throw new Error(`Component class for ${tag} not registered`);
      }

      const inst1 = new Cls();
      const inst2 = new Cls();

      if (tag === "conversation-run-status") {
        inst1.setAttribute("state", "running");
        inst2.setAttribute("state", "running");
      }

      // Trigger render
      inst1._render();
      inst2._render();

      assertEquals(
        Array.isArray(inst1._root.adoptedStyleSheets),
        true,
        `${tag} inst1 must have adoptedStyleSheets array`
      );
      assertEquals(
        Array.isArray(inst2._root.adoptedStyleSheets),
        true,
        `${tag} inst2 must have adoptedStyleSheets array`
      );
      assertEquals(
        inst1._root.adoptedStyleSheets.length >= 1,
        true,
        `${tag} inst1 must have at least 1 adopted stylesheet`
      );
      assertEquals(
        inst2._root.adoptedStyleSheets.length >= 1,
        true,
        `${tag} inst2 must have at least 1 adopted stylesheet`
      );

      // The key assertion: instances share the exact same stylesheet object in memory
      assertStrictEquals(
        inst1._root.adoptedStyleSheets[0],
        inst2._root.adoptedStyleSheets[0],
        `${tag} instances must share the exact same CSSStyleSheet object reference`
      );

      // DOM node savings: shadow root innerHTML does not contain <style>
      assertEquals(
        inst1._root.innerHTML.includes("<style>"),
        false,
        `${tag} shadow DOM must not contain <style> element when adoptedStyleSheets is used`
      );

      // Theme cascade check: verify that styles use CSS variables (tokens cascade through shadow roots)
      const sheet = inst1._root.adoptedStyleSheets[0];
      assertEquals(
        sheet.cssText.includes("var(--"),
        true,
        `${tag} stylesheet must use CSS custom property variables for theme cascading`
      );
    }
  } finally {
    if (prevCSS === undefined) delete globalThis.CSSStyleSheet;
    else globalThis.CSSStyleSheet = prevCSS;
    delete globalThis.__mockHasAdopted;
  }
});

