// @ts-nocheck
// tests/sidepanel-mention-anchor.test.ts
// Verifies anchoring of @ mention picker, /agent popup, and page empty state layout:
// 1. .page-empty-state has flex: 1 and justify-content: center in sidepanel.html
// 2. agent-composer .popup anchors via position: absolute directly to .composer
//    and does not contain invalid span-x-start or broken CSS anchor references
// 3. placeFloating self-corrects when a containing block shifts fixed coordinates

import { assert, assertEquals } from "jsr:@std/assert";

Deno.test("sidepanel.html: .page-empty-state has flex: 1 to pin composer to bottom when history is empty", async () => {
  const html = await Deno.readTextFile("extension/sidepanel/sidepanel.html");
  // Match .page-empty-state rule
  const match = html.match(/\.page-empty-state\s*\{([^}]+)\}/);
  assert(match, "must have .page-empty-state rule in sidepanel.html");
  const rule = match[1];
  assert(/\bflex:\s*1\b/.test(rule), ".page-empty-state must have flex: 1");
  assert(/justify-content:\s*center/.test(rule), ".page-empty-state must have justify-content: center");
});

Deno.test("components.js: anchor positioning syntax rejects invalid physical span-x/y and enforces valid logical syntax", async () => {
  const src = await Deno.readTextFile("extension/shared/components-conversation.js");
  // Reject invalid non-standard physical syntax (span-x-start, span-y-start, span-x-end, span-y-end)
  assert(!src.includes("span-x-start"), "components must not use invalid span-x-start syntax");
  assert(!src.includes("span-y-start"), "components must not use invalid span-y-start syntax");
  assert(!src.includes("span-x-end"), "components must not use invalid span-x-end syntax");
  assert(!src.includes("span-y-end"), "components must not use invalid span-y-end syntax");

  // Validate that standard logical syntax (span-inline-start / span-inline-end) is used for anchor positioning
  assert(src.includes("span-inline-end"), "components must use standard span-inline-end syntax");
  assert(src.includes("span-inline-start"), "components must use standard span-inline-start syntax");
});

Deno.test("agent-composer: _showPopup anchors suggestion popover according to anchor contract", async () => {
  const registry = new Map();
  class HTMLElementStub {
    attachShadow() { return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], appendChild() {} }; }
    getAttribute() { return null; }
    hasAttribute() { return false; }
    setAttribute() {}
    removeAttribute() {}
    dispatchEvent() { return true; }
    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }
  globalThis.HTMLElement = HTMLElementStub;
  globalThis.customElements = {
    define(name: string, cls: any) { registry.set(name, cls); },
    get(name: string) { return registry.get(name); },
  };
  globalThis.window = globalThis as any;
  (globalThis as any).innerHeight = 640;
  (globalThis as any).innerWidth = 360;
  globalThis.CustomEvent = class CustomEvent {
    type: string;
    detail: any;
    constructor(type: string, init: any = {}) { this.type = type; this.detail = init.detail ?? {}; }
  } as any;
  globalThis.matchMedia = () => ({ matches: false }) as any;
  globalThis.MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  } as any;
  globalThis.chrome = {
    runtime: { lastError: null, sendMessage: (_msg: any, cb: any) => cb?.({ ok: true }) },
    tabs: { query: async () => [] },
  } as any;

  class FakeElement {
    tagName: string;
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    listeners: Record<string, Function[]> = {};
    attributes: Record<string, string> = {};
    dataset: Record<string, string> = {};
    textContent = "";
    className = "";
    id = "";
    hidden = false;
    style: Record<string, string> = {};
    _rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    constructor(tag: string) { this.tagName = tag; }
    setAttribute(n: string, v: string) { this.attributes[n] = String(v); }
    getAttribute(n: string) { return this.attributes[n] ?? null; }
    removeAttribute(n: string) { delete this.attributes[n]; }
    append(...kids: FakeElement[]) { for (const k of kids) { k.parent = this; this.children.push(k); } }
    appendChild(k: FakeElement) { k.parent = this; this.children.push(k); return k; }
    replaceChildren(...kids: FakeElement[]) { this.children = []; for (const k of kids) { k.parent = this; this.children.push(k); } }
    addEventListener(t: string, f: Function) { (this.listeners[t] ??= []).push(f); }
    getBoundingClientRect() { return this._rect; }
    querySelector(sel: string) {
      if (sel === ".composer") return this.children.find((c) => c.className.includes("composer")) ?? null;
      if (sel.startsWith("#")) { const id = sel.slice(1); return this.children.find((c) => c.id === id) ?? null; }
      return null;
    }
  }

  globalThis.document = {
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: () => {},
  } as any;

  await import("../extension/shared/components.js");
  const AgentComposer = registry.get("agent-composer");
  assert(AgentComposer, "agent-composer must be registered");

  const composerInstance = new AgentComposer();
  const root = new FakeElement("div");
  const composerBox = new FakeElement("div");
  composerBox.className = "composer";
  // Simulate composer docked near bottom of Side Panel: top 540, bottom 620, height 80, width 332
  composerBox._rect = { top: 540, bottom: 620, left: 14, right: 346, width: 332, height: 80 };
  const popupEl = new FakeElement("div");
  popupEl.className = "popup slash-menu";
  composerBox.append(popupEl);
  root.append(composerBox);

  composerInstance._root = root;
  composerInstance._popup = popupEl;
  composerInstance._input = new FakeElement("textarea");

  // Case 1: In native CSS anchor positioning supported environment
  globalThis.CSS = {
    supports: (prop: string, _val: string) => prop === "position-area",
  } as any;

  composerInstance._showPopup([{ id: "s1", label: "Skill 1" }], { type: "mention", start: 0, end: 1 });
  assertEquals(popupEl.hidden, false, "popup must be visible");
  assertEquals(popupEl.style.position, "", "native anchor mode leaves position to CSS");
  assertEquals(popupEl.style.top, "", "native anchor mode leaves top to CSS position-area");
  assertEquals(popupEl.style.bottom, "", "native anchor mode leaves bottom to CSS position-area");
  assertEquals(popupEl.style.width, "", "native anchor mode leaves width to CSS anchor-size");

  // Case 2: In fallback environment without CSS anchor positioning support
  globalThis.CSS = {
    supports: () => false,
  } as any;

  // Near bottom: should flip above
  composerBox._rect = { top: 540, bottom: 620, left: 14, right: 346, width: 332, height: 80 };
  composerInstance._showPopup([{ id: "s1", label: "Skill 1" }], { type: "mention", start: 0, end: 1 });
  assertEquals(popupEl.style.position, "fixed", "fallback mode uses position: fixed for top-layer popover");
  assertEquals(popupEl.style.bottom, "106px", "fallback opens above anchor when docked near bottom");
  assertEquals(popupEl.style.top, "auto");
  assertEquals(popupEl.style.left, "14px");
  assertEquals(popupEl.style.width, "332px");

  // Near top: should open below
  composerBox._rect = { top: 40, bottom: 120, left: 14, right: 346, width: 332, height: 80 };
  composerInstance._showPopup([{ id: "s1", label: "Skill 1" }], { type: "mention", start: 0, end: 1 });
  assertEquals(popupEl.style.position, "fixed", "fallback mode uses position: fixed");
  assertEquals(popupEl.style.top, "126px", "fallback opens below when space permits");
  assertEquals(popupEl.style.bottom, "auto");
});

Deno.test("placeFloating: self-corrects coordinate shift when containing block is offset", async () => {
  // Read placeFloating definition from components-core.js to evaluate it directly
  const src = await Deno.readTextFile("extension/shared/components-core.js");
  const fnMatch = src.match(/function placeFloating\([\s\S]*?\n\}/);
  assert(fnMatch, "placeFloating function must exist");

  // Create a placeFloating fn by evaluating with controlled window and elements
  const placeFloating = new Function("anchor", "floatEl", "options", `
    const window = { innerWidth: 360, innerHeight: 640 };
    ${fnMatch[0]}
    return placeFloating(anchor, floatEl, options);
  `);

  const anchor = {
    getBoundingClientRect: () => ({ top: 550, bottom: 610, left: 14, right: 346, width: 332, height: 60 }),
  };

  // Simulate floatEl in a containing block shifted by container-type at y=53
  const containingBlockShift = 53;
  let topApplied = 0;
  let leftApplied = 0;
  const floatEl = {
    offsetWidth: 320,
    offsetHeight: 200,
    style: {
      position: "",
      top: "",
      left: "",
      right: "",
      bottom: "",
      width: "",
      maxWidth: "",
    },
    getBoundingClientRect() {
      // If style.top has been set, the rendered coordinate in the viewport is
      // topApplied + containingBlockShift!
      const topVal = parseFloat(this.style.top) || 0;
      const leftVal = parseFloat(this.style.left) || 0;
      return {
        top: topVal + containingBlockShift,
        left: leftVal,
        width: 320,
        height: 200,
        right: leftVal + 320,
        bottom: topVal + containingBlockShift + 200,
      };
    },
  };

  placeFloating(anchor, floatEl, { minWidth: 260, maxWidth: 380 });
  
  // The expected viewport top for anchor.top (550) - h (200) - 4 = 346.
  // With containing block shift of 53, style.top should be 346 - 53 = 293px.
  // So floatEl.getBoundingClientRect().top becomes 293 + 53 = 346px!
  const finalRect = floatEl.getBoundingClientRect();
  assertEquals(Math.round(finalRect.top), 346, "floatEl viewport top must match expected top without shift");
});
