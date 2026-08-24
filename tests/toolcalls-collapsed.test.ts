// @ts-nocheck — the tool-card DOM is built imperatively; the runtime shape is under test.
// tests/toolcalls-collapsed.test.ts — CAP-FB-20260824-TOOLCALLS-COLLAPSED-01:
// tool-call cards render COLLAPSED by default (the name + status summary),
// clicking one expands ONLY that card, and the per-card expansion state
// survives a re-render. No Chrome; the DOM is a minimal fake.
import { assert, assertEquals } from "jsr:@std/assert";

// A minimal fake element + document for the DOM-building card constructor.
function fakeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: "",
    open: false,
    textContent: "",
    children: [],
    attributes: new Map(),
    listeners: new Map(),
    parentNode: null,
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    dispatchEvent(ev) {
      for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
      return true;
    },
  };
  return el;
}

let doc = null;
// The components module load needs the web-component globals (HTMLElement/
// customElements) + the document for the DOM-building card constructor.
class HTMLElementStub { attachShadow() { return {}; } }
const registry = new Map();
globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; } };
globalThis.matchMedia = () => ({ matches: false });
globalThis.navigator = {};
globalThis.document = {
  createElement: (tag) => fakeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: fakeElement("body"),
  documentElement: fakeElement("html"),
  execCommand: () => false,
};

let cachedBuildToolCardDom = null;
async function loadBuildToolCardDom() {
  if (cachedBuildToolCardDom) return cachedBuildToolCardDom;
  const mod = await import("../extension/shared/components.js");
  cachedBuildToolCardDom = mod.buildToolCardDom;
  return cachedBuildToolCardDom;
}

Deno.test("toolcalls-collapsed: the tool card renders COLLAPSED by default — name + status summary only", async () => {
  const buildToolCardDom = await loadBuildToolCardDom();
  const card = buildToolCardDom({ name: "memory_read", status: "done", args: null, result: null, detail: null, duration: null, expandedState: new Map() });
  assertEquals(card.tagName, "DETAILS");
  assertEquals(card.open, false, "collapsed by default (the name summary is enough)");
  const summary = card.children[0];
  assertEquals(summary.tagName, "SUMMARY");
  assertEquals(summary.className, "tool-head");
  const name = summary.children.find((c) => c.className === "tool-name");
  assertEquals(name.textContent, "memory_read", "the collapsed summary names the tool");
  const status = summary.children.find((c) => (c.className || "").includes("tool-status"));
  assertEquals(status.textContent, "done", "the collapsed summary shows the status");
  const body = card.children[1];
  assertEquals(body.className, "tool-body");
  assertEquals(body.children.length, 0, "the empty card has no body content");
});

Deno.test("toolcalls-collapsed: the args/result live in the body, NOT the summary", async () => {
  const buildToolCardDom = await loadBuildToolCardDom();
  const card = buildToolCardDom({ name: "memory_set", status: "done", args: null, result: "stored", detail: null, duration: null, expandedState: new Map() });
  assertEquals(card.open, false);
  const summary = card.children[0];
  assertEquals(summary.children.some((c) => (c.className || "").includes("tool-plain")), false, "the summary carries no body text");
  const body = card.children[1];
  assertEquals(body.className, "tool-body");
  assert(body.children.length >= 1, "the result block is in the body");
});

Deno.test("toolcalls-collapsed: cardExpanded:true renders open; the toggle reports the per-card open state", async () => {
  const buildToolCardDom = await loadBuildToolCardDom();
  let toggled = null;
  const card = buildToolCardDom({ name: "memory_read", status: "done", args: null, result: null, detail: null, duration: null, expandedState: new Map(), cardExpanded: true, onCardToggle: (open) => { toggled = open; } });
  assertEquals(card.open, true, "cardExpanded:true renders the card open");
  card.open = false;
  card.dispatchEvent({ type: "toggle" });
  assertEquals(toggled, false, "the toggle event carries the per-card open state");
});

Deno.test("toolcalls-collapsed: the expansion state survives a re-render (the persisted cardExpanded flag)", async () => {
  const buildToolCardDom = await loadBuildToolCardDom();
  let persisted = false;
  const build = () => buildToolCardDom({ name: "memory_read", status: "done", args: null, result: null, detail: null, duration: null, expandedState: new Map(), cardExpanded: persisted, onCardToggle: (open) => { persisted = open; } });
  const first = build();
  assertEquals(first.open, false);
  // the user expands the card → the flag flips.
  first.open = true;
  first.dispatchEvent({ type: "toggle" });
  assertEquals(persisted, true);
  // a re-render (the attribute update) rebuilds with the persisted flag.
  const second = build();
  assertEquals(second.open, true, "the re-render restores the expanded state");
});
