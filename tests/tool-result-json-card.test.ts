// @ts-nocheck — the card DOM is built imperatively against a minimal fake DOM.
// tests/tool-result-json-card.test.ts — CAP-FB-20260901-TOOL-RESULT-FULL-JSON-01
// (the card half). The owner: "It is critical we have a nice JSON formatted
// result", "it errors on a tool call and I can't see the error in the UI".
//   - the tree is built from the FULL retained result (detail) — one result
//     block, a leaf that lies beyond byte 300 is present, and the pretty JSON
//     view is syntax-tokenised (theme-token classes, textContent only);
//   - a nested error inside an ok:true lazy envelope, and a bare protocol
//     error, both headline the error in the error colour and flip the status
//     chip to error — never a success-looking card;
//   - a truncated row renders its never-silent note.
// Falsification (recorded in TASKS.md): revert the error-headline rule in
// buildToolCardDom → "a nested error renders as the headline" is RED.
import { assert, assertEquals } from "jsr:@std/assert";

class ElementStub {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.open = false;
    this.dataset = {};
    this.listeners = new Map();
    this.parentNode = null;
  }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  hasAttribute(n) { return this.attrs.has(n); }
  removeAttribute(n) { this.attrs.delete(n); }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  insertBefore(c, ref) {
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  replaceChildren() { this.children = []; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatchEvent(ev) {
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
    if (ev.bubbles && this.parentNode) this.parentNode.dispatchEvent(ev);
    return true;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get isConnected() { return true; }
}
class HTMLElementStub extends ElementStub {
  constructor() { super("stub"); }
  attachShadow() { return new ElementStub("shadow-root"); }
}
const registry = new Map();
globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; this.bubbles = init.bubbles === true; }
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.navigator = {};
globalThis.document = {
  createElement: (tag) => {
    const Cls = registry.get(String(tag));
    if (Cls) {
      const el = new Cls();
      el.tagName = String(tag).toUpperCase();
      return el;
    }
    return new ElementStub(tag);
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  body: new ElementStub("body"),
  documentElement: new ElementStub("html"),
  execCommand: () => false,
  activeElement: null,
};

const components = await import("../extension/shared/components.js");
const { buildToolCardDom } = components;

function allText(el, out = []) {
  if (!el) return out;
  if (el.textContent) out.push(String(el.textContent));
  for (const c of el.children ?? []) allText(c, out);
  return out;
}
function findAll(el, pred, out = []) {
  if (!el) return out;
  if (pred(el)) out.push(el);
  for (const c of el.children ?? []) findAll(c, pred, out);
  return out;
}
const hasClass = (el, cls) => String(el.className ?? "").split(/\s+/).includes(cls);

const FULL = JSON.stringify({
  ok: true,
  selectedTool: "read_page",
  result: {
    title: "Hello world",
    headings: Array.from({ length: 20 }, (_, i) => ({ level: 2, text: `Section ${i + 1}` })),
    text: "z".repeat(3000),
    wordCount: 4321,
    truncated: false,
    tail: "TAIL-MARKER-END",
  },
});
const BOUNDED_300 = FULL.slice(0, 300) + "…";
const NESTED_ERROR = JSON.stringify({ ok: true, selectedTool: "read_page", result: { error: "Cannot access contents of the page. Extension manifest must request permission to access this host." } });
const PROTOCOL_ERROR = JSON.stringify({ ok: false, error: "selection-replayed" });

Deno.test("json card: the tree is built ONCE from the full retained result — a leaf beyond byte 300 renders, with syntax-tokenised pretty JSON", () => {
  const card = buildToolCardDom({
    name: "execute_tool", status: "done", args: '{"url":"https://example.com"}',
    result: BOUNDED_300, detail: FULL, duration: "220", expandedState: new Map(),
  });
  const blocks = findAll(card, (e) => hasClass(e, "tt-block"));
  const labels = blocks.map((b) => findAll(b, (e) => hasClass(e, "tt-block-label"))[0]?.textContent);
  assertEquals(labels.filter((l) => l === "result").length, 1, `exactly one result block, got ${JSON.stringify(labels)}`);
  assert(!labels.includes("detail"), "the bounded stub must not render as a second 'detail' block");
  const texts = allText(card);
  assert(texts.some((t) => t.includes("TAIL-MARKER-END")), "a leaf beyond byte 300 of the result is rendered");
  assert(texts.some((t) => t === "4321" || t.includes("4321")), "a number leaf renders");
  // The pretty JSON view is TOKENISED with theme-token classes (never a plain
  // grey blob): keys, strings, numbers, booleans, punctuation.
  const resultBlock = blocks.find((b) => findAll(b, (e) => hasClass(e, "tt-block-label"))[0]?.textContent === "result");
  const pretty = findAll(resultBlock, (e) => hasClass(e, "tt-raw"))[0];
  assert(pretty, "the pretty JSON view exists on the result block");
  const tokens = findAll(pretty, (e) => /(^|\s)tt-json-/.test(String(e.className ?? "")));
  const kinds = new Set(tokens.map((t) => String(t.className).match(/tt-json-([a-z]+)/)?.[1]));
  for (const k of ["key", "string", "number", "boolean", "punct"]) assert(kinds.has(k), `the pretty view tokenises ${k} (got ${[...kinds].join(",")})`);
  const joined = tokens.map((t) => t.textContent).join("");
  assert(joined.includes("TAIL-MARKER-END"), "the pretty view carries the full text");
  assert(joined.includes("\n  "), "the JSON is pretty-printed (indented), not a single line");
  assert(!/selectedTool|schemaSummary|selectionRef/.test(joined), "the lazy envelope is stripped from the pretty view");
  assertEquals(findAll(card, (e) => hasClass(e, "tool-status"))[0]?.textContent, "done");
});

Deno.test("json card: a nested error inside an ok:true envelope renders as the headline in the error colour and flips the status chip to error (never a success-looking card)", () => {
  // The row reached the card as status "done" (an older row with no ok flag).
  const card = buildToolCardDom({
    name: "execute_tool", status: "done", args: '{"url":"https://example.com"}',
    result: "done", detail: NESTED_ERROR, duration: "12", expandedState: new Map(),
  });
  const lead = findAll(card, (e) => hasClass(e, "tool-lead"))[0];
  assert(lead, "a headline is rendered");
  assert(hasClass(lead, "error"), `the headline carries the error colour class, got ${lead.className}`);
  assert(lead.textContent.startsWith("Cannot access contents of the page"), `the headline is the nested error text, got: ${lead.textContent}`);
  assertEquals(findAll(card, (e) => hasClass(e, "tool-status"))[0]?.textContent, "error");
  assertEquals(card.open, true, "a failed call opens by default");
});

Deno.test("json card: a bare protocol error is explained in the headline, never shown as an opaque code", () => {
  const card = buildToolCardDom({
    name: "execute_tool", status: "error", args: '{"selectionRef":"sel_9","arguments":{"url":"https://example.com"}}',
    result: PROTOCOL_ERROR, detail: null, duration: "3", expandedState: new Map(),
  });
  const lead = findAll(card, (e) => hasClass(e, "tool-lead"))[0];
  assert(lead && hasClass(lead, "error"));
  assert(lead.textContent.startsWith("selection-replayed"), `the code stays first: ${lead.textContent}`);
  assert(/already been used|search_tools/.test(lead.textContent), `the code is explained: ${lead.textContent}`);
});

Deno.test("json card: a truncated result renders its never-silent note", () => {
  const card = buildToolCardDom({
    name: "read_page", status: "done", args: null,
    result: '{"ok":true}', detail: '{"ok":true,"bounded":true,"summary":"tool completed"}',
    detailNote: "Result truncated to 64 KiB for the run log — the tool returned 300 KiB.",
    duration: null, expandedState: new Map(),
  });
  const note = findAll(card, (e) => hasClass(e, "tool-note"))[0];
  assert(note, "the note element is rendered");
  const noteText = allText(note).join(" ");
  assert(noteText.includes("truncated to 64 KiB") && noteText.includes("300 KiB"), noteText);
  // The note is the FIRST thing in the body, before the tree — never buried.
  const body = findAll(card, (e) => hasClass(e, "tool-body"))[0];
  assertEquals(body.children[0], note);
});
