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

  // The summary MOVED from the body into the collapsed head
  // (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01): it is the one line that answers
  // "what happened" without expanding the card, and repeating it in the body
  // printed the same sentence twice. The property — the owner can read the
  // summary — is asserted in its new place, not dropped.
  const head = card.children.find((c) => c.className === "tool-head");
  assert(head, "tool card must have a head");
  const lead = head.children.find((c) => c.className?.includes("tool-lead"));
  assert(lead, "the collapsed head must carry the summary line");
  assertEquals(lead.textContent, "found 2 hotels in Paris");
  assert(
    !body.children.some((c) => c.className?.includes("tool-plain-summary")),
    "and must NOT also repeat it in the body",
  );

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

// ── CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 ────────────────────────────────
// The owner's report: "the tool calling bubbles don't help as much, I'd expect
// some better info, then formatted and ability to see JSON input and response
// better." Measured before this change: a collapsed card showed only the tool
// name, a status chip and a duration — and a FAILED call showed no error text
// at all, which is backwards for the one state most worth reading.

Deno.test("tool card: the COLLAPSED head carries the summary", async () => {
  const { buildToolCardDom } = await loadComponents();
  const card = buildToolCardDom({
    name: "list_tabs", status: "done",
    args: JSON.stringify({ windowId: 3 }),
    result: "8 tabs", detail: null, duration: 184,
    expandedState: new Map(), cardExpanded: false,
  });
  const head = card.children.find((c) => c.className === "tool-head");
  const lead = head.children.find((c) => c.className?.includes("tool-lead"));
  assert(lead, "a collapsed card must say what happened without being opened");
  assertEquals(lead.textContent, "8 tabs");
  assertEquals(card.open, false, "a successful call stays closed — a transcript is a conversation");
});

Deno.test("tool card: a FAILURE shows its error collapsed, and opens itself", async () => {
  const { buildToolCardDom } = await loadComponents();
  const msg = "Tab grouping needs the tab-management permission — allow it to continue";
  const card = buildToolCardDom({
    name: "group_tabs", status: "error",
    args: JSON.stringify({ tabIds: [1, 2] }),
    result: JSON.stringify({ ok: false, error: msg }),
    detail: null, duration: 9,
    expandedState: new Map(), cardExpanded: false,
  });
  const head = card.children.find((c) => c.className === "tool-head");
  const lead = head.children.find((c) => c.className?.includes("tool-lead"));
  assert(lead, "the error text must be visible WITHOUT expanding the card");
  assertEquals(lead.textContent, msg);
  assert(lead.className.includes("error"), "and must read as an error");
  assertEquals(card.open, true, "a failure opens itself — it is the state worth reading");
});

Deno.test("tool card: the envelope is not repeated as tree rows", async () => {
  const { buildToolCardDom } = await loadComponents();
  const card = buildToolCardDom({
    name: "group_tabs", status: "error",
    args: JSON.stringify({ tabIds: [1] }),
    result: JSON.stringify({ ok: false, error: "denied" }),
    detail: null, duration: 9,
    expandedState: new Map(), cardExpanded: true,
  });
  const body = card.children.find((c) => c.className === "tool-body");
  const resultBlock = body.children.find((c) =>
    c.className === "tt-block" && c.querySelector(".tt-block-label")?.textContent === "result");
  // `ok` is the status chip and `error` is the headline; a result carrying only
  // those renders NO block rather than saying the same thing a third time.
  assert(!resultBlock, "a result of only {ok,error} adds no block");
});

Deno.test("tool card: every JSON block offers a raw JSON view and a copy button", async () => {
  const { buildToolCardDom } = await loadComponents();
  const card = buildToolCardDom({
    name: "list_tabs", status: "done",
    args: JSON.stringify({ windowId: 3 }),
    result: JSON.stringify({ tabs: [{ id: 1, title: "A" }] }),
    detail: null, duration: 120,
    expandedState: new Map(), cardExpanded: true,
  });
  const body = card.children.find((c) => c.className === "tool-body");
  const blocks = body.children.filter((c) => c.className === "tt-block");
  assert(blocks.length >= 1, "at least one JSON block");
  for (const b of blocks) {
    assert(b.querySelector(".tt-raw-toggle"), "each block has a raw JSON toggle");
    assert(b.querySelector(".tt-copy-all"), "each block has a copy button");
    const raw = b.querySelector(".tt-raw");
    assert(raw, "each block carries the raw JSON");
    assertEquals(raw.hidden, true, "raw starts hidden — the tree is the default view");
    assert(raw.textContent.length > 0, "and the raw text is actually the payload");
  }
});

Deno.test("tool card: the synthetic {keys} root row is gone", async () => {
  const { buildToolCardDom } = await loadComponents();
  const card = buildToolCardDom({
    name: "list_tabs", status: "done",
    args: JSON.stringify({ windowId: 3, active: true }),
    result: null, detail: null, duration: 120,
    expandedState: new Map(), cardExpanded: true,
  });
  const body = card.children.find((c) => c.className === "tool-body");
  const block = body.children.find((c) => c.className === "tt-block");
  const keys = [...(block.querySelectorAll?.(".tt-key") ?? [])].map((e) => e.textContent);
  assert(!keys.includes("{keys}"), "'{keys}' is not a word and says nothing the block label does not");
  assert(keys.includes("windowId"), "the tree starts at the data itself");
});

Deno.test("tool card: the raw-JSON choice is remembered per block", async () => {
  const { buildToolCardDom } = await loadComponents();
  const state = new Map();
  const build = () => buildToolCardDom({
    name: "list_tabs", status: "done",
    args: JSON.stringify({ windowId: 3 }),
    result: JSON.stringify({ tabs: [{ id: 1, title: "A" }] }),
    detail: null, duration: 120, expandedState: state, cardExpanded: true,
  });
  const blockOf = (card, label) => card.children
    .find((c) => c.className === "tool-body").children
    .find((c) => c.className === "tt-block" && c.querySelector(".tt-block-label")?.textContent === label);

  const first = build();
  const inputs = blockOf(first, "inputs");
  assertEquals(inputs.querySelector(".tt-raw").hidden, true, "the tree is the default view");
  const toggle = inputs.querySelector(".tt-raw-toggle");
  for (const fn of toggle.listeners.get("click") ?? []) {
    fn({ type: "click", target: toggle, preventDefault() {}, stopPropagation() {} });
  }

  // A re-render (the card rebuilds on every tool-status/duration update) must
  // not throw the choice away — that was the whole point of persisting it.
  const second = build();
  const inputs2 = blockOf(second, "inputs");
  assertEquals(inputs2.querySelector(".tt-raw").hidden, false, "raw view survives a rebuild");
  assertEquals(inputs2.querySelector(".tt-tree").hidden, true, "and the tree is the one hidden");
  // The preference is PER BLOCK — turning raw on for inputs must not turn it on
  // for the result, which is a different payload the owner did not ask about.
  assertEquals(blockOf(second, "result").querySelector(".tt-raw").hidden, true);
});
