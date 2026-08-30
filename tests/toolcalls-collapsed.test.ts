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
    dataset: {},
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

let cachedComponents = null;
async function loadComponents() {
  if (!cachedComponents) cachedComponents = await import("../extension/shared/components.js");
  return cachedComponents;
}
async function loadBuildToolCardDom() {
  return (await loadComponents()).buildToolCardDom;
}

function descendants(el) {
  return [el, ...(el.children ?? []).flatMap(descendants)];
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

Deno.test("toolcalls-collapsed: a JSON-string result uses the structured tree", async () => {
  const buildToolCardDom = await loadBuildToolCardDom();
  const card = buildToolCardDom({ name: "list_tabs", status: "done", args: null, result: '{"tabs":[{"title":"Docs"}]}', detail: null, duration: null, expandedState: new Map() });
  const body = card.children[1];
  assert(body.children.some((c) => c.className === "tt-block"), "JSON-looking string renders through the tree viewer");
  assert(descendants(body).some((c) => c.className === "tt-key" && c.textContent === "title"), "decoded JSON keys are rows, not escaped text");
});

Deno.test("toolcalls-collapsed: prose and invalid JSON stay readable plain text", async () => {
  const buildToolCardDom = await loadBuildToolCardDom();
  for (const result of ["completed normally", '{"broken":']) {
    const card = buildToolCardDom({ name: "note", status: "done", args: null, result, detail: null, duration: null, expandedState: new Map() });
    const plain = card.children[1].children.find((c) => c.className === "tool-plain tool-plain-result");
    assertEquals(plain?.textContent, result);
  }
});

Deno.test("toolcalls-collapsed: an object result survives the attribute boundary and uses the tree", async () => {
  const { buildToolCardDom, toolPayloadAttribute } = await loadComponents();
  const result = toolPayloadAttribute({ tabs: [{ title: "Docs" }] });
  assertEquals(result, '{"tabs":[{"title":"Docs"}]}', "object is serialized once, never String(object)");
  const card = buildToolCardDom({ name: "list_tabs", status: "done", args: null, result, detail: null, duration: null, expandedState: new Map() });
  assert(card.children[1].children.some((c) => c.className === "tt-block"), "serialized object renders through the tree viewer");
});

Deno.test("toolcalls-collapsed: an oversized JSON probe safely falls back to text", async () => {
  const buildToolCardDom = await loadBuildToolCardDom();
  const result = JSON.stringify(["x".repeat(64 * 1024)]);
  const card = buildToolCardDom({ name: "large", status: "done", args: null, result, detail: null, duration: null, expandedState: new Map() });
  const plain = card.children[1].children.find((c) => c.className === "tool-plain tool-plain-result");
  assertEquals(plain?.textContent, result, "oversized JSON is not parsed but remains readable");
});

Deno.test("toolcalls-collapsed: one modelContent JSON-string layer unwraps into tree rows", async () => {
  const buildToolCardDom = await loadBuildToolCardDom();
  const result = JSON.stringify({ modelContent: JSON.stringify({ ok: true, tabs: [{ title: "Docs" }] }) });
  const card = buildToolCardDom({ name: "list_tabs", status: "done", args: null, result, detail: null, duration: null, expandedState: new Map() });
  const body = card.children[1];
  assert(body.children.some((c) => c.className === "tt-block"));
  assert(descendants(body).some((c) => c.className === "tt-key" && c.textContent === "title"));
  assert(!descendants(body).some((c) => c.className === "tt-key" && c.textContent === "modelContent"));
});

Deno.test("toolcalls-collapsed: a normal double-wrapped result stays text", async () => {
  const buildToolCardDom = await loadBuildToolCardDom();
  const result = JSON.stringify(JSON.stringify({ a: 1 }));
  const card = buildToolCardDom({ name: "wrapped", status: "done", args: null, result, detail: null, duration: null, expandedState: new Map() });
  const body = card.children[1];
  assert(!body.children.some((c) => c.className === "tt-block"));
  const plain = body.children.find((c) => c.className === "tool-plain tool-plain-result");
  assertEquals(plain?.textContent, JSON.stringify({ a: 1 }), "only the outer encoding layer is decoded");
});

Deno.test("toolcalls-collapsed: a second modelContent encoding layer stays text", async () => {
  // The bound holds — the second encoding layer is NOT decoded into a tree —
  // and (CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 §10) the transport key
  // `modelContent` is never a visible row: the once-decoded string is the
  // content, shown as plain text.
  const buildToolCardDom = await loadBuildToolCardDom();
  const result = JSON.stringify({ modelContent: JSON.stringify(JSON.stringify({ a: 1 })) });
  const card = buildToolCardDom({ name: "wrapped", status: "done", args: null, result, detail: null, duration: null, expandedState: new Map() });
  const body = card.children[1];
  assert(!descendants(body).some((c) => c.className === "tt-key" && c.textContent === "modelContent"), "the envelope key is transport, never a row");
  const plain = body.children.find((c) => c.className === "tool-plain tool-plain-result");
  assertEquals(plain?.textContent, JSON.stringify({ a: 1 }), "the second encoded layer remains text");
  assert(!descendants(body).some((c) => c.className === "tt-key" && c.textContent === "a"));
});

Deno.test("toolcalls-collapsed: a second schema-wrapped result encoding layer stays text", async () => {
  const buildToolCardDom = await loadBuildToolCardDom();
  const detail = JSON.stringify({
    ok: true,
    selectedTool: "list_assets",
    result: JSON.stringify(JSON.stringify({ a: 1 })),
    schemaSummary: JSON.stringify({ type: "object" }),
  });
  const card = buildToolCardDom({ name: "execute_tool", status: "done", args: null, result: "done", detail, duration: null, expandedState: new Map() });
  const body = card.children[1];
  // The envelope's `result` wrapper is unwrapped (§9) — the selected tool's
  // once-decoded string is the content, as plain text; the second layer is
  // never decoded into a tree.
  assert(!descendants(body).some((c) => c.className === "tt-key" && (c.textContent === "result" || c.textContent === "selectedTool")), "envelope keys are never rows");
  const plain = body.children.find((c) => c.className === "tool-plain tool-plain-result");
  assertEquals(plain?.textContent, JSON.stringify({ a: 1 }), "the second encoded layer remains text");
  assert(!descendants(body).some((c) => c.className === "tt-key" && c.textContent === "a"));
});

Deno.test("toolcalls-collapsed: live execute detail consumes its output schema and decodes the selected result", async () => {
  const buildToolCardDom = await loadBuildToolCardDom();
  const detail = JSON.stringify({
    ok: true,
    selectedTool: "list_assets",
    result: JSON.stringify({ assets: [{ id: "asset-1", name: "Notes" }] }),
    schemaSummary: JSON.stringify({ type: "object" }),
  });
  const card = buildToolCardDom({ name: "execute_tool", status: "done", args: null, result: "Found 1 artifact", detail, duration: null, expandedState: new Map() });
  const body = card.children[1];
  assert(descendants(body).some((c) => c.className === "tt-key" && c.textContent === "assets"));
  assert(!descendants(body).some((c) => c.className === "tt-key" && c.textContent === "schemaSummary"));
});

Deno.test("toolcalls-collapsed: Gemini and Anthropic server-search events remain JSON tool results", async () => {
  await loadComponents();
  const Conversation = customElements.get("agent-conversation");
  const calls = [];
  const conversation = Object.create(Conversation.prototype);
  conversation.appendTool = (value) => calls.push(value);
  conversation.appendServerToolRows({ serverToolEvents: [
    { kind: "google_search", query: "current Chrome release" },
    { kind: "web_search", query: "Anthropic release notes" },
  ] });
  assertEquals(calls.map((call) => call.name), ["provider:google_search", "provider:web_search"]);
  assertEquals(calls.map((call) => call.result), [
    { kind: "google_search", query: "current Chrome release" },
    { kind: "web_search", query: "Anthropic release notes" },
  ]);
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
