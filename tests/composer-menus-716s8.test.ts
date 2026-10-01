// @ts-nocheck
// tests/composer-menus-716s8.test.ts — Slash autocomplete & attach menu presentation (chrome-agent-platform-716s.8)

import { assert, assertEquals } from "jsr:@std/assert@1";

// ── Global stubs before importing components ───────────────────────────────
const registry = new Map();

class HTMLElementStub {
  attachShadow(_init) {
    return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], appendChild() {} };
  }
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
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.MutationObserver = class MutationObserver {
  constructor(cb) { this._cb = cb; }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
};

globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => {
      queueMicrotask(() => cb?.({ ok: true, skills: [] }));
    },
  },
  tabs: {
    query: async () => [{ id: 1, title: "Test Tab", url: "https://example.com" }],
  },
};

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
    this.hidden = false;
    this.style = {};
  }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  removeAttribute(n) { delete this.attributes[n]; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  appendChild(k) { k.parent = this; this.children.push(k); return k; }
  replaceChildren(...kids) { this.children = []; for (const k of kids) { k.parent = this; this.children.push(k); } }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  getBoundingClientRect() { return { top: 0, left: 100, width: 912, height: 120, right: 1012, bottom: 120 }; }
  querySelector(sel) {
    if (sel.includes("group-label")) return this.children.find((c) => c.className?.includes("group-label")) ?? null;
    if (sel.includes("menu-footer")) return this.children.find((c) => c.className?.includes("menu-footer")) ?? null;
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      return this.children.find((c) => c.className?.split(/\s+/).includes(cls)) ?? null;
    }
    return null;
  }
  querySelectorAll(sel) {
    if (sel.includes("group-label")) return this.children.filter((c) => c.className?.includes("group-label"));
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      return this.children.filter((c) => c.className?.split(/\s+/).includes(cls));
    }
    if (sel.includes("button[data-kind]")) {
      return this.children.filter((c) => c.dataset?.kind);
    }
    return [];
  }
  scrollIntoView() {}
}

const fakeDocument = {
  head: new FakeNode("head"),
  body: new FakeNode("body"),
  documentElement: new FakeNode("html"),
  createElement: (tag) => new FakeNode(tag),
  getElementById: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = fakeDocument;

await import("../extension/shared/components.js");
const { COMMAND_NAMESPACES } = await import("../extension/shared/composer-commands.js");
const AgentComposer = registry.get("agent-composer");
const AttachButton = registry.get("attach-button");

Deno.test("716s.8: COMMAND_NAMESPACES entries declare group metadata", () => {
  const attachContext = ["tabs", "artifacts", "bookmarks", "history", "files", "folder"];
  const runSwitch = ["skill", "command", "agent"];
  const session = ["remember"];

  for (const id of attachContext) {
    const entry = COMMAND_NAMESPACES.find((item) => item.id === id);
    assertEquals(entry?.group, "Attach context", `${id} must belong to "Attach context" group`);
  }
  for (const id of runSwitch) {
    const entry = COMMAND_NAMESPACES.find((item) => item.id === id);
    assertEquals(entry?.group, "Run & switch", `${id} must belong to "Run & switch" group`);
  }
  for (const id of session) {
    const entry = COMMAND_NAMESPACES.find((item) => item.id === id);
    assertEquals(entry?.group, "Session", `${id} must belong to "Session" group`);
  }
});

Deno.test("716s.8: slash autocomplete displays category headers and keyboard footer", async () => {
  const composer = new AgentComposer();
  const input = new FakeNode("textarea");
  input.value = "/";
  input.selectionStart = 1;
  input.selectionEnd = 1;
  const popup = new FakeNode("div");
  popup.id = "popup-test";
  composer._input = input;
  composer._popup = popup;
  composer._root = { querySelector: () => new FakeNode("div") };

  await composer._onComposerInput();

  assertEquals(popup.hidden, false, "popup should be visible");
  const groupLabels = popup.querySelectorAll(".group-label").map((el) => el.textContent);
  assert(groupLabels.length >= 3, `Expected at least 3 group labels, got: ${JSON.stringify(groupLabels)}`);
  assert(groupLabels.includes("Attach context"), `Group labels must include "Attach context", got: ${JSON.stringify(groupLabels)}`);
  assert(groupLabels.includes("Run & switch"), `Group labels must include "Run & switch", got: ${JSON.stringify(groupLabels)}`);
  assert(groupLabels.includes("Session"), `Group labels must include "Session", got: ${JSON.stringify(groupLabels)}`);

  const footer = popup.querySelector(".menu-footer");
  assert(footer, "Menu footer must be present in popup");
  assertEquals(footer.textContent, "↑↓ Navigate · ↵ Select · Esc Dismiss");
});

Deno.test("716s.8: category headers suppress when only a single group matches", async () => {
  const composer = new AgentComposer();
  const input = new FakeNode("textarea");
  input.value = "/sk";
  input.selectionStart = 3;
  input.selectionEnd = 3;
  const popup = new FakeNode("div");
  popup.id = "popup-test-single";
  composer._input = input;
  composer._popup = popup;
  composer._root = { querySelector: () => new FakeNode("div") };

  await composer._onComposerInput();

  assertEquals(popup.hidden, false, "popup should be visible");
  const groupLabels = popup.querySelectorAll(".group-label");
  assertEquals(groupLabels.length, 0, "Single-group matches must suppress group headers");
});

Deno.test("716s.8: slash autocomplete CSS constrains width <= 480px, anchors to inline-start, and description is adjacent", async () => {
  const src = await Deno.readTextFile("extension/shared/components.js");
  
  // Constrain width and anchor to inline-start
  assert(
    src.includes("width:min(440px, calc(100% - 24px))") ||
    src.includes("width: min(440px, calc(100% - 24px))") ||
    src.includes("max-width:480px") ||
    src.includes("max-width: 480px"),
    "agent-composer popup CSS must constrain width with max-width: 480px",
  );
  assert(
    src.includes("inset-inline-start:12px") ||
    src.includes("inset-inline-start: 12px"),
    "agent-composer popup CSS must anchor to inset-inline-start: 12px",
  );

  // Description adjacent on one line, not pushed flush-right with flex:1 + text-align:right
  assert(
    !src.includes(".popup .item .dsc { flex:1; text-align:right;"),
    "popup description must not be pushed to the far right with flex:1 and text-align:right",
  );
});

Deno.test("716s.8: attach menu drops Choose agent, removes border, and uses var(--shadow-md)", async () => {
  const btn = new AttachButton();
  btn._root = new FakeNode("div");
  btn._render();
  const html = btn._root.innerHTML || "";

  // DOM check: Choose agent must be absent
  assert(!html.includes('data-kind="choose-agent"'), "attach menu must not contain 'choose-agent'");
  assert(!html.includes("Choose agent"), "attach menu must not contain 'Choose agent' label");

  // Plain-English note: no multimodal technical jargon
  assert(!html.includes("multimodal where the provider supports it"), "attach menu note must not contain multimodal technical jargon");

  // Source test: no hardcoded rgba(0,0,0,.25) in attach menu
  const src = await Deno.readTextFile("extension/shared/components.js");
  const attachMenuSlice = src.slice(src.indexOf("class AttachButton"), src.indexOf("class AttachButton") + 2500);
  assert(!attachMenuSlice.includes("rgba(0,0,0,.25)"), "AttachButton styles must not contain hardcoded rgba(0,0,0,.25)");
  assert(!attachMenuSlice.includes("rgba(0, 0, 0, 0.45)"), "AttachButton styles must not contain hardcoded rgba(0, 0, 0, 0.45)");
  assert(attachMenuSlice.includes("var(--shadow-md"), "AttachButton styles must use var(--shadow-md)");
  assert(attachMenuSlice.includes("border:none") || attachMenuSlice.includes("border: 0") || attachMenuSlice.includes("border:0"), "AttachButton menu must drop the border");
});

Deno.test("716s.8: theme.css defines --shadow-md for light and dark schemes", async () => {
  const theme = await Deno.readTextFile("extension/shared/theme.css");
  assert(theme.includes("--shadow-md:"), "theme.css must declare --shadow-md");
  assert(theme.includes("0 8px 24px rgba(29, 27, 24, 0.08)"), "theme.css must declare light mode shadow token 0 8px 24px rgba(29, 27, 24, 0.08)");
  assert(theme.includes("light-dark(rgba(29, 27, 24, 0.08), rgba(0, 0, 0, 0.45))"), "theme.css must declare light-dark token for --shadow-md");
});
