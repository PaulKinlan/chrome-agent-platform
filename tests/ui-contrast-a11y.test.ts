// @ts-nocheck — unit tests for UI contrast and accessibility fixes (chrome-agent-platform-d885.4)
// tests/ui-contrast-a11y.test.ts verifies:
// 1. MicButton and AttachButton ArrowDown/ArrowUp move focus across menu items inside Shadow DOM.
// 2. durable-run-registry omits aria-describedby when reason is empty, and includes it when present.
// 3. <table-preview> contains no ⚠️ emoji and uses inline SVG.
// 4. Undefined token fallbacks (--surface-2, --accent-fg, --text-muted, --border-subtle) are gone from components.js, options.css, and artifacts/index.html.

import { assert, assertEquals } from "jsr:@std/assert";

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.className = "";
    this.id = "";
    this.open = false;
    this.hidden = false;
    this._textContent = "";
    this._innerHTML = "";
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    const self = this;
    this.dataset = new Proxy({}, {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        const attr = "data-" + prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
        return self.attributes.get(attr);
      },
      set(_target, prop, val) {
        if (typeof prop !== "string") return false;
        const attr = "data-" + prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
        self.setAttribute(attr, val);
        return true;
      },
    });
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

  append(...kids) {
    for (const k of kids) {
      if (k) this.appendChild(k);
    }
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
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
    parseHTML(this._innerHTML, this);
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent || "";
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(v) {
    this._textContent = String(v);
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
    ev.preventDefault ??= () => {};
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
    return true;
  }

  focus() {
    let p = this.parentNode;
    while (p) {
      if (p instanceof FakeShadowRoot) {
        p.activeElement = this;
        break;
      }
      p = p.parentNode;
    }
    if (globalThis.document) globalThis.document.activeElement = this;
  }

  querySelector(sel) {
    return walk(this, makeSelectorPredicate(sel));
  }

  querySelectorAll(sel) {
    return walkAll(this, makeSelectorPredicate(sel));
  }

  closest(sel) {
    let cur = this;
    const pred = makeSelectorPredicate(sel);
    while (cur && cur.nodeType === 1) {
      if (pred(cur)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
}

class FakeShadowRoot extends FakeElement {
  constructor(host) {
    super("#shadow-root");
    this.nodeType = 11;
    this.host = host;
    this.activeElement = null;
  }
}

function parseHTML(html, parent) {
  const cleanHtml = String(html).replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const tagRe = /<(?:(?:\/([a-zA-Z0-9_-]+))|([a-zA-Z0-9_-]+)([^>]*?)(\/?))>|([^<]+)/g;
  const attrRe = /([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^>\s]+)))?/g;
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

  const stack = [parent];
  let match;
  while ((match = tagRe.exec(cleanHtml)) !== null) {
    const [, closeTag, openTag, attrStr, selfClose, text] = match;
    const current = stack[stack.length - 1];
    if (text) {
      if (current) current._textContent = (current._textContent || "") + text;
      continue;
    }
    if (closeTag) {
      const lower = closeTag.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === lower) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (openTag) {
      const el = new FakeElement(openTag.toLowerCase());
      if (attrStr) {
        let aMatch;
        attrRe.lastIndex = 0;
        while ((aMatch = attrRe.exec(attrStr)) !== null) {
          const aName = aMatch[1];
          const aVal = aMatch[2] ?? aMatch[3] ?? aMatch[4] ?? "";
          el.setAttribute(aName, aVal);
          if (aName === "class") el.className = aVal;
          if (aName === "id") el.id = aVal;
        }
      }
      current.appendChild(el);
      if (!selfClose && !voidTags.has(openTag.toLowerCase())) {
        stack.push(el);
      }
    }
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
  if (sel.includes("[") && sel.includes("]")) {
    const match = sel.match(/^([a-zA-Z0-9_-]*)\[([a-zA-Z0-9_-]+)(?:=([^\]]+))?\]$/);
    if (match) {
      const [, tag, attr, val] = match;
      return (node) => {
        if (tag && node.tagName !== tag.toUpperCase()) return false;
        if (!node.attributes.has(attr)) return false;
        if (val !== undefined) {
          const cleanVal = val.replace(/^["']|["']$/g, "");
          return String(node.attributes.get(attr)) === cleanVal;
        }
        return true;
      };
    }
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
globalThis.KeyboardEvent = globalThis.KeyboardEvent || class KeyboardEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.key = init.key ?? "";
    this.code = init.code ?? "";
  }
};
globalThis.IntersectionObserver = class IntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.MutationObserver = class MutationObserver {
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
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
  activeElement: null,
};

let componentsModule = null;
async function getComponents() {
  if (!componentsModule) {
    componentsModule = await import("../extension/shared/components.js");
  }
  return componentsModule;
}

Deno.test("ui-contrast-a11y: MicButton ArrowDown and ArrowUp navigate across Shadow DOM menu items", async () => {
  await getComponents();
  const MicButton = customElements.get("mic-button");
  assert(MicButton, "mic-button must be registered");

  const btn = new MicButton();
  btn.connectedCallback();

  const root = btn._root;
  assert(root, "MicButton must have a shadow root");

  // Supply at least 2 devices to trigger device menu creation in _syncDeviceUi
  btn._devices = [
    { deviceId: "dev-1", label: "Mic 1" },
    { deviceId: "dev-2", label: "Mic 2" },
    { deviceId: "dev-3", label: "Mic 3" },
  ];
  btn._syncDeviceUi();

  const menu = btn._deviceMenu;
  assert(menu, "MicButton device menu must be created");

  const options = [...menu.querySelectorAll("button[data-device-id]")];
  assertEquals(options.length, 3, "Must have 3 device options");

  // Focus opt1 inside shadow root
  options[0].focus();
  assertEquals(root.activeElement, options[0], "Initial activeElement in shadow root is opt1");

  // ArrowDown moves to opt2
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  assertEquals(root.activeElement, options[1], "ArrowDown moves shadow root focus to opt2");

  // ArrowDown moves to opt3
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  assertEquals(root.activeElement, options[2], "ArrowDown moves shadow root focus to opt3");

  // ArrowDown wraps to opt1
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  assertEquals(root.activeElement, options[0], "ArrowDown wraps shadow root focus back to opt1");

  // ArrowUp moves to opt3
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
  assertEquals(root.activeElement, options[2], "ArrowUp moves shadow root focus to opt3");
});

Deno.test("ui-contrast-a11y: AttachButton ArrowDown and ArrowUp navigate across Shadow DOM menu items", async () => {
  await getComponents();
  const AttachButton = customElements.get("attach-button");
  assert(AttachButton, "attach-button must be registered");

  const btn = new AttachButton();
  btn.connectedCallback();

  const root = btn._root;
  assert(root, "AttachButton must have a shadow root");

  const menu = root.querySelector(".menu");
  assert(menu, "AttachButton must have a menu in shadow root");

  const items = [...menu.querySelectorAll("button[role=menuitem]")];
  assert(items.length >= 2, "Menu must have at least 2 items");

  // Focus first menuitem inside shadow root
  items[0].focus();
  assertEquals(root.activeElement, items[0], "First menuitem is focused in shadow root");

  // ArrowDown moves to items[1]
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  assertEquals(root.activeElement, items[1], "ArrowDown moves shadow root focus to items[1]");

  // ArrowUp moves back to items[0]
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
  assertEquals(root.activeElement, items[0], "ArrowUp moves shadow root focus back to items[0]");
});

Deno.test("ui-contrast-a11y: durable-run-registry omits aria-describedby when reason is empty", async () => {
  await getComponents();
  const DurableRunRegistry = customElements.get("durable-run-registry");
  assert(DurableRunRegistry, "durable-run-registry must be registered");

  const reg = new DurableRunRegistry();
  // Provide run with NO reason
  reg.runs = [
    {
      executionId: "run-empty-reason",
      taskText: "Do something",
      phase: "running",
      createdAt: Date.now(),
      statusReason: "",
      errorReason: "",
    },
  ];
  reg.connectedCallback();

  const root = reg._root;
  const descEl = root.querySelector(".description");
  assertEquals(descEl, null, "No description paragraph should be rendered when reason is empty");

  const buttons = root.querySelectorAll("button");
  for (const b of buttons) {
    if (b.getAttribute("data-action")) {
      assertEquals(
        b.getAttribute("aria-describedby"),
        null,
        `Button [data-action="${b.getAttribute("data-action")}"] must NOT have aria-describedby when reason is empty`,
      );
    }
  }

  // Now test with a non-empty reason
  reg.runs = [
    {
      executionId: "run-with-reason",
      taskText: "Do something else",
      phase: "running",
      createdAt: Date.now(),
      pause: { reason: "Awaiting user input" },
    },
  ];
  reg._render();
  reg._wire();

  const descElWithReason = root.querySelector(".description");
  assert(descElWithReason, "Description paragraph must exist when reason is non-empty");
  const expectedId = descElWithReason.id;
  assert(expectedId, "Description element must have an id");

  const actionButtons = root.querySelectorAll("button").filter((b) => b.getAttribute("data-action"));
  assert(actionButtons.length > 0, "Action buttons should exist");
  for (const b of actionButtons) {
    assertEquals(
      b.getAttribute("aria-describedby"),
      expectedId,
      `Button [data-action="${b.getAttribute("data-action")}"] must have aria-describedby pointing to ${expectedId}`,
    );
  }
});

Deno.test("ui-contrast-a11y: <table-preview> contains no ⚠️ emoji and uses inline SVG", async () => {
  await getComponents();
  const TablePreview = customElements.get("table-preview");
  assert(TablePreview, "table-preview must be registered");

  const preview = new TablePreview();
  preview.data = {
    columns: ["name", "formula"],
    rows: [
      ["item 1", "=SUM(A1:A10)"],
    ],
  };
  preview.connectedCallback();

  const root = preview._root;
  const warn = root.querySelector(".formula-warning");
  assert(warn, "Formula warning must be rendered when formula characters exist");

  const allNodes = descendants(warn);
  const hasEmoji = allNodes.some((n) => (n.textContent || "").includes("⚠️"));
  assertEquals(hasEmoji, false, "Formula warning must not contain the literal ⚠️ emoji");

  const iconEl = warn.querySelector(".warn-icon");
  assert(iconEl, ".warn-icon must exist");
  const svgEl = iconEl.querySelector("svg");
  assert(svgEl, ".warn-icon must contain an inline <svg>");
});

Deno.test("ui-contrast-a11y: undefined token fallbacks are gone from components.js, options.css, and artifacts/index.html", async () => {
  const components = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
  const optionsCss = await Deno.readTextFile(new URL("../extension/options/options.css", import.meta.url));
  const artifactsHtml = await Deno.readTextFile(new URL("../extension/artifacts/index.html", import.meta.url));

  const forbidden = ["--surface-2", "--accent-fg", "--text-muted", "--border-subtle"];

  for (const token of forbidden) {
    assert(
      !components.includes(token),
      `components.js must not contain deprecated/undefined token ${token}`,
    );
    assert(
      !optionsCss.includes(token),
      `options.css must not contain deprecated/undefined token ${token}`,
    );
    assert(
      !artifactsHtml.includes(token),
      `artifacts/index.html must not contain deprecated/undefined token ${token}`,
    );
  }
});
