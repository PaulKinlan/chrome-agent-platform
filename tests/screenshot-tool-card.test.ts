// @ts-nocheck — the card DOM is built imperatively against a minimal fake DOM.
// tests/screenshot-tool-card.test.ts — CAP-FB-20260830-SCREENSHOT-TO-MODEL-01.
//
// A capture the agent took was invisible to the owner: the PNG went into the
// model message and nowhere the UI could reach. The card now mounts
// <screenshot-thumb> for the saved image. The id arrives at several transport
// depths depending on which path rendered the card — the live event's
// {modelContent} wrapper, agent-do's {modelContent,userSummary} pair (whose
// userSummary is prose, so a naive unwrap walks straight past the object), and
// the run log's already-decoded envelope — so all three are pinned here.

import { assert, assertEquals } from "jsr:@std/assert";

// ── a minimal fake DOM (attributes, children, text) ────────────────────────
class ElementStub {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.className = "";
    this.textContent = "";
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

const { buildToolCardDom, screenshotFromToolPayload } = await import(
  "../extension/shared/components.js"
);

const SCHEMA = JSON.stringify({ oneOf: [{ type: "object" }, { type: "array" }, { type: "string" }] });
const CAPTURE_RESULT = {
  ok: true,
  screenshotId: "shot_1788124326905_zrouey",
  url: "http://127.0.0.1:32847/red.html",
  width: 1400,
  height: 2313,
  bytes: 121_042,
};
const ENVELOPE = {
  ok: true,
  selectedTool: "capture_screenshot",
  result: CAPTURE_RESULT,
  schemaSummary: SCHEMA,
  selectionRef: "sel_48a5b187ad9ab795eecbb289c7f0c5aae400",
  authorizes: false,
  requiresLiveAuthorization: true,
  replay: { safety: "observe-only" },
};
/** The live event's wrapper. */
const LIVE = JSON.stringify({ modelContent: JSON.stringify(ENVELOPE), authorizes: false });
/** agent-do's pair: userSummary is PROSE, so the object is only under modelContent. */
const WITH_SUMMARY = JSON.stringify({
  modelContent: JSON.stringify(ENVELOPE),
  userSummary: "Captured a screenshot of http://127.0.0.1:32847/red.html",
});
/** The run log's already-decoded envelope. */
const LOG = JSON.stringify(ENVELOPE);
/** What the LIVE progress event actually delivers: `summarizeToolResult` bounds
 * the payload with a mid-string slice at 300 characters, so the card receives a
 * TRUNCATED JSON fragment. No parser reaches the id — it has to be read out of
 * the text. (The truncation itself is a pre-existing defect of the live path,
 * noted in the entry's History; this entry does not change it, because doing so
 * changes what every other card renders.) */
const TRUNCATED = (() => {
  const full = JSON.stringify({ modelContent: JSON.stringify(ENVELOPE), authorizes: false });
  return full.slice(0, 300) + "\u2026";
})();

function findAll(el, pred, out = []) {
  if (!el) return out;
  if (pred(el)) out.push(el);
  for (const c of el.children ?? []) findAll(c, pred, out);
  return out;
}
const thumbs = (card) => findAll(card, (e) => e.tagName === "SCREENSHOT-THUMB");

Deno.test("screenshotFromToolPayload: finds the saved id at every transport depth", () => {
  for (const [name, payload] of [["live", LIVE], ["userSummary pair", WITH_SUMMARY], ["run log", LOG], ["truncated live event", TRUNCATED]]) {
    const shot = screenshotFromToolPayload(payload);
    assert(shot, `${name}: the saved screenshot must be found`);
    assertEquals(shot.id, CAPTURE_RESULT.screenshotId, name);
    assertEquals(shot.label, CAPTURE_RESULT.url, name);
    assertEquals(shot.size, "1400×2313", name);
  }
  // Nothing to show is nothing to show — no element, no empty frame.
  assertEquals(screenshotFromToolPayload(""), null);
  assertEquals(screenshotFromToolPayload(null), null);
  assertEquals(screenshotFromToolPayload(JSON.stringify({ ok: true, result: { ok: true } })), null);
  assertEquals(screenshotFromToolPayload(JSON.stringify({ screenshotId: "" })), null);
});

Deno.test("tool card: a capture mounts one <screenshot-thumb> naming the page", () => {
  for (const [name, payload] of [["live", LIVE], ["userSummary pair", WITH_SUMMARY], ["run log", LOG], ["truncated live event", TRUNCATED]]) {
    const card = buildToolCardDom({
      name: "execute_tool",
      status: "done",
      args: JSON.stringify({ selectionRef: "sel_x", arguments: { tabId: 7 } }),
      result: payload,
      detail: "",
      duration: "120",
      expandedState: new Map(),
    });
    const found = thumbs(card);
    assertEquals(found.length, 1, `${name}: exactly one thumbnail`);
    assertEquals(found[0].getAttribute("shot-id"), CAPTURE_RESULT.screenshotId, name);
    assertEquals(found[0].getAttribute("label"), CAPTURE_RESULT.url, name);
    assertEquals(found[0].getAttribute("size"), "1400×2313", name);
    // The bytes are never in the card's payload — they live in the store.
    assertEquals(found[0].getAttribute("src"), null, `${name}: resolved by id, never inlined`);
  }
});

Deno.test("tool card: a tool that captured nothing mounts no thumbnail", () => {
  const card = buildToolCardDom({
    name: "execute_tool",
    status: "done",
    args: JSON.stringify({ selectionRef: "sel_x", arguments: { key: "note" } }),
    result: JSON.stringify({ ok: true, selectedTool: "memory_set", result: { ok: true, key: "note" }, schemaSummary: SCHEMA }),
    detail: "",
    duration: "8",
    expandedState: new Map(),
  });
  assertEquals(thumbs(card).length, 0);
});

