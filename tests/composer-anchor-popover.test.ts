// @ts-nocheck
// tests/composer-anchor-popover.test.ts — Popover API & CSS Anchor Positioning for agent-composer & prompt-bar (chrome-agent-platform-2x5ml)

import { assert, assertEquals } from "jsr:@std/assert@1";

// ── Global stubs ─────────────────────────────────────────────────────────────
const registry = new Map();
globalThis.HTMLElement = class {
  attachShadow(_init) { return new FakeNode("shadow-root"); }
  getAttribute() { return null; }
  hasAttribute() { return false; }
  setAttribute() {}
  removeAttribute() {}
  dispatchEvent() { return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
};
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.innerWidth = 1200;
globalThis.innerHeight = 800;
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; } };
globalThis.matchMedia = () => ({ matches: false });
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.attributes = {};
    this.dataset = {};
    this.textContent = "";
    this.className = "";
    this.id = "";
    this.hidden = true;
    this.style = {};
    this.popoverShown = false;
  }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  removeAttribute(n) { delete this.attributes[n]; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  appendChild(k) { k.parent = this; this.children.push(k); return k; }
  replaceChildren(...kids) { this.children = []; for (const k of kids) { k.parent = this; this.children.push(k); } }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  showPopover() { this.popoverShown = true; }
  hidePopover() { this.popoverShown = false; }
  scrollIntoView() {}
  querySelector(sel) {
    if (sel.includes("data-index")) {
      return this.children.find((c) => c.dataset?.index !== undefined) ?? null;
    }
    return null;
  }
}

globalThis.document = {
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  documentElement: new FakeNode("html"),
  createElement: (tag) => new FakeNode(tag),
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
};

let mockAnchorSupport = true;
globalThis.CSS = {
  supports: (prop, val) => mockAnchorSupport,
};

await import("../extension/shared/components.js");

Deno.test("2x5ml: prompt-bar wires anchor tethering and clamps in narrow viewports", () => {
  const PromptBar = registry.get("prompt-bar");
  const bar = new PromptBar();
  const inputListeners = [];
  const modelListeners = [];
  const inputEl = {
    value: "@",
    style: {},
    scrollHeight: 24,
    addEventListener: (evt, handler) => { if (evt === "input") inputListeners.push(handler); },
    getBoundingClientRect: () => ({ top: 80, bottom: 100, left: 10, width: 120 }),
  };
  const popEl = {
    classList: {
      add: () => {},
      remove: () => {},
      toggle: () => true,
    },
    addEventListener: () => {},
    style: {
      setProperty: (k, v) => { popEl.style[k] = v; },
      removeProperty: (k) => { delete popEl.style[k]; },
    },
    showPopover: () => {},
    hidePopover: () => {},
  };
  const modelEl = {
    setAttribute: () => {},
    addEventListener: (evt, handler) => { if (evt === "click") modelListeners.push(handler); },
    getBoundingClientRect: () => ({ top: 80, bottom: 100, left: 50, width: 50 }),
  };
  bar._root = {
    querySelector: (sel) => {
      if (sel === "#pb-input") return inputEl;
      if (sel === "#pb-pop") return popEl;
      if (sel === "#pb-model") return modelEl;
      return null;
    },
    innerHTML: "",
  };

  // 1. Supported path (CSS Anchor Positioning):
  mockAnchorSupport = true;
  bar._wire();

  // Trigger @ from textarea
  inputListeners.forEach((h) => h());
  assertEquals(popEl.style["position-anchor"], "--prompt-input-anchor", "must anchor to textarea");
  assertEquals(popEl.style["position-area"], "block-end span-inline-end");
  assertEquals(popEl.style.maxHeight, "", "supported path must NOT set inline maxHeight");

  // Trigger from model button
  modelListeners.forEach((h) => h());
  assertEquals(popEl.style["position-anchor"], "--prompt-model-anchor", "must anchor to model button");
  assertEquals(popEl.style["position-area"], "block-end span-inline-start");
  assertEquals(popEl.style.maxHeight, "", "supported path must NOT set inline maxHeight");

  // 2. Fallback path (CSS Anchor Positioning unsupported):
  globalThis.innerWidth = 200; // narrow viewport (<220px)
  globalThis.innerHeight = 300;
  mockAnchorSupport = false;

  inputListeners.forEach((h) => h());

  // In a 200px viewport with 16px margins, popup width must clamp <= 184px (not overflow with 220px min)
  const computedW = parseInt(popEl.style.width, 10);
  assert(computedW <= 184, `popup width must be clamped <= 184 in 200px viewport, got ${computedW}`);
  const computedLeft = parseInt(popEl.style.left, 10);
  assert(computedLeft + computedW <= 200 - 8, "popup right edge must not overflow 200px viewport");
});

Deno.test("2x5ml: agent-composer _showPopup and _hidePopup invoke popover methods and preserve combobox contract", () => {
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;
  const AgentComposer = registry.get("agent-composer");
  const composer = new AgentComposer();

  const input = new FakeNode("textarea");
  const popup = new FakeNode("div");
  popup.id = "popup-uid-1";

  composer._input = input;
  composer._popup = popup;
  composer._uid = "uid-1";

  // 1. Show popup with CSS Anchor Positioning supported
  mockAnchorSupport = true;
  const itemNode = new FakeNode("div");
  itemNode.id = "opt-0";
  popup.appendChild(itemNode);

  composer._showPopup([{ id: "s1", label: "Skill 1" }], { type: "command" });

  assertEquals(popup.hidden, false, "popup must be visible");
  assertEquals(popup.popoverShown, true, "showPopover must be called");
  assertEquals(input.getAttribute("aria-expanded"), "true", "combobox aria-expanded must be true");
  assertEquals(input.getAttribute("aria-controls"), "popup-uid-1", "combobox aria-controls must point to popup");
  assertEquals(input.getAttribute("aria-activedescendant"), "cmp-uid-1-opt-0", "combobox aria-activedescendant must be set");
  // When anchor positioning is supported, inline rect math styles are empty
  assertEquals(popup.style.position, "", "position should not be set inline when anchor positioning is supported");
  assertEquals(popup.style.maxHeight, "", "maxHeight should not be set inline when anchor positioning is supported");
  assertEquals(popup.style.top, "", "top should not be set inline when anchor positioning is supported");
  assertEquals(popup.style.left, "", "left should not be set inline when anchor positioning is supported");

  // 2. Hide popup
  composer._hidePopup();
  assertEquals(popup.hidden, true, "popup must be hidden");
  assertEquals(popup.popoverShown, false, "hidePopover must be called");
  assertEquals(input.getAttribute("aria-expanded"), "false", "combobox aria-expanded must be false");
  assertEquals(input.getAttribute("aria-activedescendant"), null, "activedescendant must be removed");

  // 3. Fallback path when CSS Anchor Positioning is NOT supported
  mockAnchorSupport = false;
  composer._root = {
    querySelector: (sel) => {
      if (sel === ".composer") {
        return {
          getBoundingClientRect: () => ({ top: 100, bottom: 200, left: 50, width: 400 }),
        };
      }
      return null;
    },
  };

  composer._showPopup([{ id: "s1", label: "Skill 1" }], { type: "command" });
  assertEquals(popup.hidden, false);
  assertEquals(popup.style.position, "fixed", "fallback must set position: fixed inline for top layer");
  assertEquals(popup.style.width, "400px", "fallback must calculate width from getBoundingClientRect");
  assert(popup.style.maxHeight !== "", "fallback must constrain maxHeight based on available space");

  // 4. Fallback clamping in constrained viewports: width=300, rect.left=600 in 800px viewport
  globalThis.innerWidth = 800;
  globalThis.innerHeight = 200;
  composer._root = {
    querySelector: (sel) => {
      if (sel === ".composer") {
        return {
          // Centered vertically in 200px viewport (spaceAbove = 73px, spaceBelow = 73px)
          getBoundingClientRect: () => ({ top: 85, bottom: 115, left: 600, width: 300 }),
        };
      }
      return null;
    },
  };
  composer._showPopup([{ id: "s1", label: "Skill 1" }], { type: "command" });
  // widthVal = 300. In 800px viewport, leftVal = Math.min(600, 800 - 300 - 8) = 492px
  assertEquals(popup.style.left, "492px", "left must be clamped so popup right edge stays within viewport with 8px margin");
  // available height should clamp to <= 73px without a 120px hard floor
  const clampedHeight = parseInt(popup.style.maxHeight, 10);
  assert(clampedHeight <= 73, `clampedHeight must be <= 73 in 200px viewport, got ${clampedHeight}`);
});
