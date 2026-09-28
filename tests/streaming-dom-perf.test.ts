// @ts-nocheck — unit tests for streaming DOM performance optimizations
// tests/streaming-dom-perf.test.ts — verifies:
// 1. MessageBubble preserves the exact same <style> DOM node reference across
//    multiple setAttribute("content", ...) updates during streaming.
// 2. buildToolCardDom defers building .tt-row elements while closed
//    (card.open === false) and builds them when opened (card.open = true + toggle event),
//    while error cards (status: "error") build immediately.
// 3. AgentConversation stylesheet includes content-visibility: auto and
//    contain-intrinsic-size for .run-group.

import { assert, assertEquals } from "jsr:@std/assert";

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.className = "";
    this.id = "";
    this.open = false;
    this.textContent = "";
    this._innerHTML = "";
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
  }

  attachShadow(_init) {
    this.shadowRoot = new FakeShadowRoot(this);
    return this.shadowRoot;
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore(child, ref) {
    const idx = this.children.indexOf(ref);
    if (idx === -1) {
      this.children.push(child);
    } else {
      this.children.splice(idx, 0, child);
    }
    child.parentNode = this;
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  replaceChildren(...kids) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    for (const k of kids) this.appendChild(k);
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(val) {
    this._innerHTML = String(val);
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }

  setAttribute(name, value) {
    const old = this.attributes.get(name) ?? null;
    this.attributes.set(name, String(value));
    if (this._rendered && typeof this.attributeChangedCallback === "function") {
      const observed = this.constructor?.observedAttributes ?? [];
      if (observed.includes(name)) {
        this.attributeChangedCallback(name, old, String(value));
      }
    }
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    const old = this.attributes.get(name) ?? null;
    this.attributes.delete(name);
    if (this._rendered && typeof this.attributeChangedCallback === "function") {
      const observed = this.constructor?.observedAttributes ?? [];
      if (observed.includes(name)) {
        this.attributeChangedCallback(name, old, null);
      }
    }
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx !== -1) list.splice(idx, 1);
  }

  dispatchEvent(ev) {
    ev.target ??= this;
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
    return true;
  }

  querySelector(sel) {
    return walk(this, makeSelectorPredicate(sel));
  }

  querySelectorAll(sel) {
    return walkAll(this, makeSelectorPredicate(sel));
  }

  scrollIntoView() {}
  focus() {}
}

class FakeShadowRoot extends FakeElement {
  constructor(host) {
    super("#shadow-root");
    this.nodeType = 11;
    this.host = host;
  }
}

function makeSelectorPredicate(sel) {
  if (sel.startsWith(".")) {
    const cls = sel.slice(1);
    return (node) => (node.className || "").split(/\s+/).includes(cls);
  }
  if (sel.startsWith("#")) {
    const id = sel.slice(1);
    return (node) => node.id === id;
  }
  if (sel === "style") {
    return (node) => node.tagName === "STYLE";
  }
  return (node) => node.tagName === sel.toUpperCase();
}

function walk(el, predicate) {
  for (const child of el.children || []) {
    if (predicate(child)) return child;
    const hit = walk(child, predicate);
    if (hit) return hit;
  }
  return null;
}

function walkAll(el, predicate, acc = []) {
  for (const child of el.children || []) {
    if (predicate(child)) acc.push(child);
    walkAll(child, predicate, acc);
  }
  return acc;
}

function descendants(el) {
  return [el, ...(el.children ?? []).flatMap(descendants)];
}

const registry = new Map();
globalThis.HTMLElement = FakeElement;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail ?? {};
  }
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.navigator = { clipboard: { writeText: () => Promise.resolve() } };
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: new FakeElement("body"),
  documentElement: new FakeElement("html"),
  addEventListener: () => {},
  removeEventListener: () => {},
  execCommand: () => false,
};

let componentsModule = null;
async function getComponents() {
  if (!componentsModule) {
    componentsModule = await import("../extension/shared/components.js");
  }
  return componentsModule;
}

Deno.test("streaming-dom-perf: MessageBubble reuses the exact same <style> element across streaming updates", async () => {
  await getComponents();
  const MessageBubble = customElements.get("message-bubble");
  assert(MessageBubble, "message-bubble must be registered in customElements");
  const bubble = new MessageBubble();
  bubble.setAttribute("role", "agent");
  bubble.setAttribute("content", "Token 1");
  bubble.connectedCallback();

  const shadowRoot = bubble.shadowRoot;
  assert(shadowRoot, "Shadow root must be created");

  const styleElInitial = shadowRoot.querySelector("style");
  assert(styleElInitial, "Initial <style> element must exist in shadow root");
  assertEquals(styleElInitial.tagName, "STYLE");

  // Simulate incoming streaming chunks via repeated setAttribute("content", ...)
  const chunks = [
    "Token 1 Token 2",
    "Token 1 Token 2 Token 3",
    "Token 1 Token 2 Token 3 \n\nMarkdown list:\n- item 1\n- item 2",
    "Final completed response.",
  ];

  for (const chunk of chunks) {
    bubble.setAttribute("content", chunk);
    const styleElCurrent = shadowRoot.querySelector("style");
    assert(styleElCurrent, "Style element must persist after streaming chunk update");
    assertEquals(
      styleElCurrent,
      styleElInitial,
      "The exact same <style> DOM reference must be preserved across updates without tearing down the stylesheet",
    );
  }

  // Ensure there is only one style element in the shadow root
  const allStyles = shadowRoot.querySelectorAll("style");
  assertEquals(allStyles.length, 1, "Only one <style> element should be present in shadow root");
});

Deno.test("streaming-dom-perf: buildToolCardDom defers .tt-row construction when closed and expands on toggle", async () => {
  const { buildToolCardDom } = await getComponents();
  const card = buildToolCardDom({
    name: "test_tool",
    status: "done",
    args: JSON.stringify({ query: "SELECT * FROM users", limit: 10 }),
    result: JSON.stringify({ count: 10, items: ["alice", "bob"] }),
    expandedState: new Map(),
  });

  assertEquals(card.tagName, "DETAILS");
  assertEquals(card.open, false, "Card must be collapsed by default for successful non-error calls");

  // Verify that .tt-row elements are NOT constructed while the card is closed
  const hasRowBefore = descendants(card).some((c) => (c.className || "").split(/\s+/).includes("tt-row"));
  assertEquals(hasRowBefore, false, "Heavy .tt-row elements must NOT be built while the card is collapsed");

  // Simulate user opening the card
  card.open = true;
  card.dispatchEvent(new CustomEvent("toggle"));

  // Verify that .tt-row elements ARE constructed once opened
  const rowsAfter = descendants(card).filter((c) => (c.className || "").split(/\s+/).includes("tt-row"));
  assert(rowsAfter.length > 0, "Heavy .tt-row elements must be built once the card is opened");

  // Verify subsequent toggle does not duplicate rows
  const rowCountFirstOpen = rowsAfter.length;
  card.open = false;
  card.dispatchEvent(new CustomEvent("toggle"));
  card.open = true;
  card.dispatchEvent(new CustomEvent("toggle"));
  const rowsAfterRetoggle = descendants(card).filter((c) => (c.className || "").split(/\s+/).includes("tt-row"));
  assertEquals(rowsAfterRetoggle.length, rowCountFirstOpen, "Subsequent toggle must not duplicate .tt-row elements");
});

Deno.test("streaming-dom-perf: buildToolCardDom builds .tt-row elements immediately for error cards", async () => {
  const { buildToolCardDom } = await getComponents();
  const errorCard = buildToolCardDom({
    name: "failing_tool",
    status: "error",
    args: JSON.stringify({ action: "delete_all" }),
    result: JSON.stringify({ error: "Permission denied", code: 403 }),
    expandedState: new Map(),
  });

  assertEquals(errorCard.open, true, "Error card must be open by default");

  // Verify that .tt-row elements are built immediately
  const errorRows = descendants(errorCard).filter((c) => (c.className || "").split(/\s+/).includes("tt-row"));
  assert(errorRows.length > 0, "Error card must construct heavy .tt-row elements immediately");
});

Deno.test("streaming-dom-perf: AgentConversation stylesheet contains content-visibility: auto for .run-group", async () => {
  // Read components.js source or inspect stylesheet constant to verify rule is present
  const componentsText = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  assert(
    componentsText.includes("content-visibility: auto") && componentsText.includes("contain-intrinsic-size: auto 64px"),
    "AgentConversation style must include content-visibility: auto and contain-intrinsic-size: auto 64px for .run-group",
  );
});
