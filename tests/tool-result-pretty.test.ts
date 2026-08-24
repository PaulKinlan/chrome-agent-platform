// @ts-nocheck — minimal DOM fake for testing tool result JSON vs HTML rendering.
import { assert, assertEquals } from "jsr:@std/assert@1";

function fakeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: "",
    dataset: {},
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
    hasAttribute(name) { return this.attributes.has(name); },
    matches(sel) {
      if (sel.startsWith(".")) return this.className.split(" ").includes(sel.slice(1));
      return sel === this.tagName.toLowerCase();
    },
    querySelector(sel) {
      for (const c of this.children) {
        if (c.matches?.(sel)) return c;
        const found = c.querySelector?.(sel);
        if (found) return found;
      }
      return null;
    },
    querySelectorAll(sel) {
      const res = [];
      for (const c of this.children) {
        if (c.matches?.(sel)) res.push(c);
        if (c.querySelectorAll) res.push(...c.querySelectorAll(sel));
      }
      return res;
    },
  };
  return el;
}

class HTMLElementStub {
  constructor() {
    this.attributes = new Map();
    this.shadowRoot = { innerHTML: "" };
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  attachShadow() { return this.shadowRoot; }
}

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

let cachedComponents = null;
async function loadComponents() {
  if (cachedComponents) return cachedComponents;
  cachedComponents = await import("../extension/shared/components.js");
  return cachedComponents;
}

Deno.test("tool-result-pretty: JSON result renders as a formatted JSON tree", async () => {
  const { buildToolCardDom } = await loadComponents();
  const card = buildToolCardDom({
    name: "list_items",
    status: "done",
    args: JSON.stringify({ category: "books", limit: 5 }),
    result: JSON.stringify({ items: [{ id: 1, title: "Book A" }, { id: 2, title: "Book B" }], total: 2 }),
    detail: null,
    duration: 120,
    expandedState: new Map(),
    cardExpanded: true,
  });

  const body = card.children.find((c) => c.className === "tool-body");
  assert(body, "tool card must have tool-body");

  // Both inputs and result should have tt-block (JSON trees)
  const blocks = body.children.filter((c) => c.className === "tt-block");
  assertEquals(blocks.length, 2, "both inputs and result must render as tt-block JSON trees");

  const inputBlock = blocks.find((b) => b.querySelector(".tt-block-label")?.textContent === "inputs");
  const resultBlock = blocks.find((b) => b.querySelector(".tt-block-label")?.textContent === "result");
  assert(inputBlock, "must have inputs JSON tree block");
  assert(resultBlock, "must have result JSON tree block");
});

Deno.test("tool-result-pretty: summary result + JSON detail renders summary text AND pretty JSON result tree", async () => {
  const { buildToolCardDom } = await loadComponents();
  const card = buildToolCardDom({
    name: "search_hotels",
    status: "done",
    args: JSON.stringify({ city: "Paris" }),
    result: "found 2 hotels in Paris",
    detail: JSON.stringify([{ name: "Hotel Ritz", stars: 5 }, { name: "Hotel Lutetia", stars: 5 }]),
    duration: 250,
    expandedState: new Map(),
    cardExpanded: true,
  });

  const body = card.children.find((c) => c.className === "tool-body");
  assert(body, "tool card must have tool-body");

  // Should have summary text
  const summaryDiv = body.children.find((c) => c.className?.includes("tool-plain-summary"));
  assert(summaryDiv, "must have tool-plain-summary text");
  assertEquals(summaryDiv.textContent, "found 2 hotels in Paris");

  // Should render detail payload as "result" JSON tree block
  const resultBlock = body.children.find((c) => c.className === "tt-block" && c.querySelector(".tt-block-label")?.textContent === "result");
  assert(resultBlock, "must render raw JSON payload as 'result' tree block");
});

Deno.test("tool-result-pretty: HTML output renders as live sandboxed HTML frame, NOT JSON", async () => {
  await loadComponents();
  const MessageBubbleClass = registry.get("message-bubble");
  assert(MessageBubbleClass, "message-bubble custom element must be registered");

  const bubble = new MessageBubbleClass();
  bubble.setAttribute("role", "tool");
  bubble.setAttribute("tool-name", "view_chart");
  bubble.setAttribute("tool-args", JSON.stringify({ title: "Performance" }));
  bubble.setAttribute(
    "tool-result",
    "<!DOCTYPE html><html><head><title>Chart</title></head><body><h1>Chart View</h1></body></html>",
  );

  bubble._render();

  const shadowHtml = bubble.shadowRoot?.innerHTML || "";
  assert(shadowHtml.includes('class="genui"'), "must render .genui container for HTML output");
  assert(shadowHtml.includes('class="html-frame"'), "must render .html-frame iframe container");
  assert(shadowHtml.includes('sandbox="allow-scripts"'), "must enforce sandboxed iframe");
  assert(!shadowHtml.includes('class="tt-block"'), "must NOT render JSON tree for HTML output");
});

Deno.test("tool-result-pretty: plain text result degrades honestly as plain text", async () => {
  const { buildToolCardDom } = await loadComponents();
  const card = buildToolCardDom({
    name: "simple_ping",
    status: "done",
    args: null,
    result: "pong from server",
    detail: null,
    duration: 15,
    expandedState: new Map(),
    cardExpanded: true,
  });

  const body = card.children.find((c) => c.className === "tool-body");
  assert(body, "tool card must have tool-body");

  const resultDiv = body.children.find((c) => c.className?.includes("tool-plain-result"));
  assert(resultDiv, "must have tool-plain-result div");
  assertEquals(resultDiv.textContent, "pong from server");

  const ttBlocks = body.children.filter((c) => c.className === "tt-block");
  assertEquals(ttBlocks.length, 0, "plain text result must not create JSON tree blocks");
});
