// @ts-nocheck — unit tests for UI contrast and accessibility fixes (chrome-agent-platform-d885.4)
// tests/ui-contrast-a11y.test.ts verifies:
// 1. MicButton and AttachButton ArrowDown/ArrowUp move focus across menu items inside Shadow DOM.
// 2. durable-run-registry omits aria-describedby when reason is empty, and includes it when present.
// 3. <table-preview> contains no ⚠️ emoji and uses inline SVG.
// 4. Undefined token fallbacks (--surface-2, --accent-fg, --text-muted, --border-subtle) are gone from components.js, options.css, and artifacts/index.html.

import { assert, assertEquals, assertThrows } from "jsr:@std/assert";

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

Deno.test("ui-contrast-a11y: artifacts search input preserves keyboard focus-visible ring (chrome-agent-platform-mlf1)", async () => {
  const artifactsHtml = await Deno.readTextFile(new URL("../extension/artifacts/index.html", import.meta.url));
  assert(!/\.search-input\s*\{[^}]*outline:\s*none/s.test(artifactsHtml), ".search-input must not unconditionally suppress outline");
  assert(/\.search-input:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/s.test(artifactsHtml), ".search-input:focus-visible must preserve 2px accent outline ring");
  assert(/\.search-input:focus:not\(:focus-visible\)\s*\{[^}]*outline:\s*none/s.test(artifactsHtml), ".search-input:focus:not(:focus-visible) must restrict outline:none to non-visible focus states");
});

Deno.test("ui-contrast-a11y: permission status and notes adhere to min 12px design scale step (chrome-agent-platform-upwb)", async () => {
  const sidepanelHtml = await Deno.readTextFile(new URL("../extension/sidepanel/sidepanel.html", import.meta.url));
  const optionsCss = await Deno.readTextFile(new URL("../extension/options/options.css", import.meta.url));
  const ntpHtml = await Deno.readTextFile(new URL("../extension/ntp/ntp.html", import.meta.url));

  // sidepanel.html: .agent-permissions-status must be >= 12px (var(--text-xs)) and not have opacity: .75
  assert(!/\.agent-permissions-status\s*\{[^}]*font-size:\s*11px/s.test(sidepanelHtml), ".agent-permissions-status must not use 11px font");
  assert(!/\.agent-permissions-status\s*\{[^}]*opacity:\s*\.?75/s.test(sidepanelHtml), ".agent-permissions-status must not reduce opacity");
  assert(/\.agent-permissions-status\s*\{[^}]*font-size:\s*var\(--text-xs/s.test(sidepanelHtml), ".agent-permissions-status must use var(--text-xs)");

  // options.css: .usage-cost-note must be >= 12px
  assert(!/\.usage-cost-note\s*\{[^}]*font-size:\s*11px/s.test(optionsCss), ".usage-cost-note must not use 11px font");
  assert(/\.usage-cost-note\s*\{[^}]*font-size:\s*var\(--text-xs/s.test(optionsCss), ".usage-cost-note must use var(--text-xs)");

  // ntp.html: .side-count must be >= 12px
  assert(!/\.side-count\s*\{[^}]*font-size:\s*11px/s.test(ntpHtml), ".side-count must not use 11px font");
  assert(/\.side-count\s*\{[^}]*font-size:\s*var\(--text-xs/s.test(ntpHtml), ".side-count must use var(--text-xs)");
});

Deno.test("ui-contrast-a11y: artifact preview host adapts to dark mode and styles retry button with focus-visible (chrome-agent-platform-1rjv)", async () => {
  const previewHtml = await Deno.readTextFile(new URL("../extension/sandbox/artifact-preview.html", import.meta.url));
  const previewCss = await Deno.readTextFile(new URL("../extension/sandbox/artifact-preview.css", import.meta.url));

  assert(previewHtml.includes('<meta name="color-scheme" content="light dark">'), "artifact-preview.html must declare color-scheme: light dark");
  assert(previewHtml.includes('href="../shared/theme.css"'), "artifact-preview.html must link shared theme.css");

  assert(previewCss.includes("color-scheme: light dark"), "artifact-preview.css must declare color-scheme: light dark");
  assert(previewCss.includes("var(--border"), "artifact-preview.css must use semantic --border token");
  assert(previewCss.includes("var(--panel"), "artifact-preview.css must use semantic --panel token");
  assert(previewCss.includes("var(--text"), "artifact-preview.css must use semantic --text token");
  assert(/#preview-retry:focus-visible\s*\{[^}]*outline:\s*2px solid/s.test(previewCss), "#preview-retry must declare 2px focus-visible outline ring");
  assert(/#preview-retry:active\s*\{/s.test(previewCss), "#preview-retry must style :active state");
  assert(/#preview-retry:disabled\s*\{/s.test(previewCss), "#preview-retry must style :disabled state");
});

// ============================================================================
// chrome-agent-platform-wjcba: the theme-literal guard.
//
// The guard above bans UNDEFINED TOKENS; this section bans the harder form of
// the same defect - a hard-coded colour literal that replaces a token (the
// reverify of zxo4i showed `background: var(--bg-subtle)` -> rgba(...) left
// this suite green). The surface properties where a literal means the surface
// ignores the theme are background, background-color, color and border-color.
// Rules:
//   1. A BARE literal in a surface property outside the token definition file
//      (theme.css) is a violation.
//   2. A literal inside a var() FALLBACK is only allowed when the token is
//      actually defined in theme.css (the fallback then never renders and is
//      inert); on an undefined token the literal IS the render path - the
//      exact class the "undefined token fallbacks" test bans for four named
//      tokens - so it violates.
//   3. theme.css is the token definition file: literals there define the
//      theme, so they are exempt by construction.
//   4. currentColor, transparent, inherit, initial, unset are theme-safe
//      keywords, not literals.
//   5. THEME_LITERAL_ALLOWLIST exempts measured sites; every entry REQUIRES a
//      reason string - validateThemeLiteralAllowlist() throws on a reason-less
//      entry, so the allowlist cannot quietly grow.
// ============================================================================

const THEME_CSS_PATH = "extension/shared/theme.css";
const SURFACE_PROPERTY_RE =
  /(?:^|[;{\n])\s*(background|background-color|color|border-color)\s*:\s*([^;{}]+)/g;
const THEME_SAFE_KEYWORDS = new Set([
  "transparent", "currentColor", "inherit", "initial", "unset", "none",
]);
const CSS_NAMED_COLOURS = new Set(
  ("aliceblue,antiquewhite,aqua,aquamarine,azure,beige,bisque,black,blanchedalmond,blue,blueviolet,brown,burlywood,cadetblue,chartreuse,chocolate,coral,cornflowerblue,crimson,cyan,darkblue,darkcyan,darkgoldenrod,darkgray,darkgreen,darkgrey,darkkhaki,darkmagenta,darkolivegreen,darkorange,darkorchid,darkred,darksalmon,darkseagreen,darkslateblue,darkslategray,darkslategrey,darkturquoise,darkviolet,deeppink,deepskyblue,dimgray,dimgrey,dodgerblue,firebrick,floralwhite,forestgreen,fuchsia,gainsboro,ghostwhite,gold,goldenrod,gray,grey,green,greenyellow,honeydew,hotpink,indianred,indigo,ivory,khaki,lavender,lavenderblush,lawngreen,lemonchiffon,lightblue,lightcoral,lightcyan,lightgoldenrodyellow,lightgray,lightgreen,lightgrey,lightpink,lightsalmon,lightseagreen,lightskyblue,lightslategray,lightslategrey,lightsteelblue,lightyellow,lime,limegreen,linen,magenta,maroon,mediumaquamarine,mediumblue,mediumorchid,mediumpurple,mediumseagreen,mediumslateblue,mediumspringgreen,mediumturquoise,mediumvioletred,midnightblue,mintcream,mistyrose,moccasin,navajowhite,navy,oldlace,olive,olivedrab,orange,orangered,orchid,palegoldenrod,palegreen,paleturquoise,palevioletred,papayawhip,peachpuff,peru,pink,plum,powderblue,purple,rebeccapurple,red,rosybrown,royalblue,saddlebrown,salmon,sandybrown,seagreen,seashell,sienna,silver,skyblue,slateblue,slategray,slategrey,snow,springgreen,steelblue,tan,teal,thistle,tomato,turquoise,violet,wheat,white,whitesmoke,yellow,yellowgreen").split(","),
);

function stripCssComments(css) {
  // Replace comment CONTENT with spaces so computed line numbers stay true.
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

// A balanced span finder: returns [start, end] offsets of the first occurrence
// of `open` whose parens balance, or null.
function balancedSpan(text, startIdx) {
  const open = text.indexOf("(", startIdx);
  if (open === -1) return null;
  let depth = 1;
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return [startIdx, i + 1]; // end-exclusive, slice()-compatible
    }
  }
  return null;
}

// Collect the var() spans of a value: [{start, end, token, fallbackStart}].
function varSpans(value) {
  const spans = [];
  let idx = 0;
  while (true) {
    const at = value.indexOf("var(", idx);
    if (at === -1) break;
    const span = balancedSpan(value, at);
    if (!span) break;
    const inner = value.slice(at + 4, span[1]);
    const commaAt = inner.indexOf(",");
    const token = value.slice(at + 4, commaAt === -1 ? span[1] : commaAt + at + 4).trim();
    spans.push({
      start: at,
      end: span[1],
      token,
      fallbackStart: commaAt === -1 ? -1 : commaAt + at + 4,
    });
    idx = span[1];
  }
  return spans;
}

// Literal colour occurrences in a chunk: hex, rgb()/rgba()/hsl()/hsla()
// functions, or a bare named colour word. Returns [{start, end}].
function literalSpans(chunk) {
  const spans = [];
  for (const m of chunk.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  for (const m of chunk.matchAll(/\b(?:rgba?|hsla?)\s*\(/g)) {
    const span = balancedSpan(chunk, m.index);
    if (span) spans.push(span);
  }
  for (const w of chunk.matchAll(/[a-zA-Z][a-zA-Z-]*/g)) {
    const word = w[0];
    if (CSS_NAMED_COLOURS.has(word.toLowerCase()) && word[0] !== "-") {
      spans.push([w.index, w.index + word.length]);
    }
  }
  return spans;
}

// Scan one CSS file's text. `definedTokens` is the set of --names defined in
// theme.css; a var() fallback literal on a defined token is inert (never
// renders), on anything else it is the render path and violates.
export function findThemeLiteralViolations(entry) {
  const { path, css, definedTokens = new Set() } = entry;
  if (path === THEME_CSS_PATH) return []; // token definitions live here by design
  const clean = stripCssComments(css);
  const violations = [];
  for (const m of clean.matchAll(SURFACE_PROPERTY_RE)) {
    const property = m[1];
    const value = m[2].trim();
    const line = clean.slice(0, m.index + m[0].indexOf(property)).split("\n").length;
    const vSpans = varSpans(value);
    const bare = [];
    const undefinedFallbacks = [];
    for (const [s, e] of literalSpans(value)) {
      const enclosing = vSpans.find((v) => s > v.start && e <= v.end);
      if (!enclosing) {
        bare.push(value.slice(s, e));
      } else if (enclosing.fallbackStart !== -1 && s >= enclosing.fallbackStart && !definedTokens.has(enclosing.token)) {
        undefinedFallbacks.push(value.slice(s, e));
      }
    }
    if (bare.length || undefinedFallbacks.length) {
      violations.push({
        path,
        line,
        property,
        value,
        bare,
        undefinedFallbacks,
      });
    }
  }
  return violations;
}

// Exemptions for measured, genuinely-accepted literal sites. A reason is
// mandatory; validateThemeLiteralAllowlist() throws without one.
const normalize = (s) => s.replace(/\s+/g, "").toLowerCase();
const THEME_LITERAL_ALLOWLIST = [
  {
    path: "extension/options/options.css",
    value: "rgba(46, 125, 50, 0.12)",
    reason:
      "success-tint surface on .vault rows/cards; the theme has no --success-tint token yet, the literal is a low-alpha overlay that stays legible on both light and dark panels; tokenisation tracked in the wjcba follow-up bead",
  },
  {
    path: "extension/options/options.css",
    value: "rgba(128, 128, 128, 0.1)",
    reason:
      "neutral grey tint on the vault ledger section; deliberately theme-neutral, contrast comes from the token text colours layered on top",
  },
  {
    path: "extension/options/options.css",
    value: "rgba(179, 38, 30, 0.12)",
    reason:
      "danger-tint surface on the vault ledger warning row; the theme has no --danger-tint token yet, tokenisation tracked in the wjcba follow-up bead",
  },
  {
    path: "extension/options/options.css",
    value: "color-mix(in srgb, var(--danger) 85%, #000)",
    reason:
      "pressed state of the danger button: mixes the --danger token with black to darken it; a pressed-darken token does not exist yet",
  },
  {
    path: "extension/privacy/privacy.css",
    value: "color-mix(in srgb, var(--danger) 85%, #000)",
    reason:
      "pressed state of the privacy danger button: mixes the --danger token with black to darken it; a pressed-darken token does not exist yet",
  },
  {
    path: "extension/options/options.css",
    value: "var(--primary, #0066cc)",
    reason:
      "token --primary is NOT defined in theme.css so the fallback renders; pending decision whether to map to --accent or define --primary (wjcba follow-up bead) - allowlisted so the guard reports new literals, not the debt",
  },
  {
    path: "extension/options/options.css",
    value: "var(--surface, #fff)",
    reason:
      "token --surface is NOT defined in theme.css so the fallback renders; pending mapping decision to --panel (wjcba follow-up bead)",
  },
  {
    path: "extension/options/options.css",
    value: "var(--surface-subtle, rgba(128, 128, 128, 0.05))",
    reason:
      "token --surface-subtle is NOT defined in theme.css so the fallback renders; pending mapping decision (wjcba follow-up bead)",
  },
  {
    path: "extension/options/options.css",
    value: "var(--surface-subtle, rgba(128, 128, 128, 0.1))",
    reason:
      "token --surface-subtle is NOT defined in theme.css so the fallback renders; pending mapping decision (wjcba follow-up bead)",
  },
];

export function validateThemeLiteralAllowlist(list = THEME_LITERAL_ALLOWLIST) {
  const problems = [];
  for (const entry of list) {
    if (!entry.path || typeof entry.path !== "string") problems.push("entry missing path");
    if (!entry.value || typeof entry.value !== "string") problems.push("entry missing value");
    if (!entry.reason || typeof entry.reason !== "string" || !entry.reason.trim()) {
      problems.push(`allowlist entry ${entry.path ?? "?"} (${entry.value ?? "?"}) has no reason string - allowlist entries cannot be extended without a reason`);
    }
  }
  if (problems.length) throw new Error("THEME_LITERAL_ALLOWLIST invalid: " + problems.join("; "));
}

export function themeLiteralAllowed(violation, list = THEME_LITERAL_ALLOWLIST) {
  const nv = normalize(violation.value);
  return list.some(
    (entry) => entry.path === violation.path && nv.includes(normalize(entry.value)),
  );
}

// Enumerate the extension CSS the guard governs: every .css under extension/
// except dist builds and theme.css itself. Structural on purpose: a new CSS
// file is covered the moment it exists, no list to forget.
async function collectGovernedCss() {
  const files = [];
  async function walk(dir) {
    for await (const entry of Deno.readDir(dir)) {
      const p = dir + "/" + entry.name;
      if (entry.isDirectory) {
        if (entry.name === "dist" || entry.name === "dist-versions" || entry.name === "node_modules") continue;
        await walk(p);
      } else if (entry.name.endsWith(".css") && p !== THEME_CSS_PATH) {
        files.push(p);
      }
    }
  }
  await walk("extension");
  return files.sort();
}

async function themeDefinedTokens() {
  const css = stripCssComments(await Deno.readTextFile(THEME_CSS_PATH));
  const tokens = new Set();
  for (const m of css.matchAll(/(^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g)) tokens.add(m[2]);
  return tokens;
}

Deno.test("ui-contrast-a11y: no hard-coded colour literal in a surface property outside theme.css without an allowlist reason (chrome-agent-platform-wjcba)", async () => {
  validateThemeLiteralAllowlist(); // a reason-less entry is itself a failure
  const definedTokens = await themeDefinedTokens();
  const paths = await collectGovernedCss();
  assert(paths.includes("extension/options/options.css"), "the governed set must include options.css");
  assert(!paths.includes(THEME_CSS_PATH), "theme.css is the token definition file and is governed by construction, not by this scan");
  const problems = [];
  for (const p of paths) {
    const css = await Deno.readTextFile(p);
    for (const v of findThemeLiteralViolations({ path: p, css, definedTokens })) {
      if (!themeLiteralAllowed(v)) {
        problems.push(
          `${v.path}:${v.line}: ${v.property}: ${v.value.slice(0, 80)} — hard-coded colour ${[...v.bare, ...v.undefinedFallbacks].join(", ")} bypasses the theme tokens; use a var() token or add a REASONED THEME_LITERAL_ALLOWLIST entry`,
        );
      }
    }
  }
  assertEquals(problems.length, 0, `theme-blind colour literals found:\n${problems.join("\n")}`);
});

Deno.test("ui-contrast-a11y: theme-literal falsifier — a bare literal in a surface property reds naming file and line (chrome-agent-platform-wjcba)", () => {
  // The exact mutation the zxo4i reverify used: token usage -> literal.
  const mutated =
    ".vault-protection { margin: 0; background: rgba(255, 255, 255, 0.03); color: var(--text); }\n" +
    ".next-rule { border-color: #ff0000; }";
  const v = findThemeLiteralViolations({ path: "extension/options/options.css", css: mutated, definedTokens: new Set(["--text"]) });
  assert(v.length === 2, `the falsifier must flag both mutated declarations, got ${JSON.stringify(v)}`);
  assertEquals(v[0].path, "extension/options/options.css");
  assertEquals(v[0].line, 1);
  assertEquals(v[0].property, "background");
  assert(v[0].bare.some((s) => s.startsWith("rgba(")), "the rgba literal must be reported as bare");
  assertEquals(v[1].line, 2);
  assertEquals(v[1].property, "border-color");
  // Every other spelling of the illegal form: hex and named colours.
  const hexAndNamed = findThemeLiteralViolations({
    path: "extension/ntp/ntp.css",
    css: ".a { color: #123456; } .b { color: white; } .c { color: hsl(0, 0%, 0%); }",
  });
  assert(hexAndNamed.length === 3, `hex/named/hsl literals must each violate, got ${JSON.stringify(hexAndNamed)}`);
});

Deno.test("ui-contrast-a11y: theme-literal falsifier — fallback literals: inert on a defined token, a render path on an undefined token (chrome-agent-platform-wjcba)", () => {
  const definedTokens = new Set(["--text", "--panel"]);
  const inert = findThemeLiteralViolations({
    path: "extension/options/options.css",
    css: ".x { color: var(--text, #1d1b18); background: var(--panel, #ffffff); }",
    definedTokens,
  });
  assertEquals(inert.length, 0, "a fallback literal on a theme.css-defined token never renders and must not violate");
  const live = findThemeLiteralViolations({
    path: "extension/options/options.css",
    css: ".y { color: var(--surface, #fff); }",
    definedTokens,
  });
  assert(live.length === 1, "a fallback literal on an undefined token IS the render path and must violate");
  assertEquals(live[0].undefinedFallbacks.length, 1);
});

Deno.test("ui-contrast-a11y: theme-literal falsifier — theme.css literals do not red, theme-safe keywords are not literals, allowlist cannot grow without a reason (chrome-agent-platform-wjcba)", () => {
  // Literals inside the token definition file define the theme: exempt.
  const theme = findThemeLiteralViolations({
    path: THEME_CSS_PATH,
    css: ":root { --panel: light-dark(#efede8, #2b2823); --danger: #b3261e; }",
    definedTokens: new Set(),
  });
  assertEquals(theme.length, 0, "theme.css literals are token definitions by construction");
  // Theme-safe keywords are not literals.
  const safe = findThemeLiteralViolations({
    path: "extension/options/options.css",
    css: ".k { color: currentColor; background: transparent; border-color: inherit; }",
  });
  assertEquals(safe.length, 0);
  // The allowlist cannot be extended without a reason string.
  assertThrows(() => validateThemeLiteralAllowlist([{ path: "x.css", value: "#fff" }]));
  assertThrows(() => validateThemeLiteralAllowlist([{ path: "x.css", value: "#fff", reason: "   " }]));
  validateThemeLiteralAllowlist([{ path: "x.css", value: "#fff", reason: "real reason" }]); // must not throw
});

// ============================================================================
// chrome-agent-platform-8mw5l: the STATIC docs pages are user surfaces too.
//
// The guard above reads the extension's surfaces. The docs pages under docs/
// are what a reader actually lands on, and they had drifted in the two ways
// this file exists to catch: six information-bearing labels rendered at 11px
// (0.6875rem) — below the constitution's 12px readability floor, and bypassing
// the page's own --step--1 scale token (13px) — and index.html re-declared the
// theme with light-dark() colour literals instead of the token scale that
// docs/theme.css already defines for it. A literal in a docs page is a second,
// silently drifting definition of the theme, i.e. the same defect wjcba's
// section bans for extension/.
//
// Rules: no px/rem font-size below 12px on a docs page, and no colour literal
// in a surface property on a docs page (theme.css is the definition file and
// is exempt).
// ============================================================================

const DOCS_PAGES = ["index.html", "components.html", "review-2026-08-21.html"];

Deno.test("8mw5l: static docs pages honour the 12px readability floor", async () => {
  for (const page of DOCS_PAGES) {
    const html = await Deno.readTextFile(new URL(`../docs/${page}`, import.meta.url));
    for (const m of html.matchAll(/font-size\s*:\s*([0-9.]+)(px|rem)/g)) {
      const px = m[2] === "px" ? Number(m[1]) : Number(m[1]) * 16;
      assert(
        px >= 12,
        `docs/${page} renders text at ${m[1]}${m[2]} (${px}px), below the 12px floor — use the page's --step--1 token`,
      );
    }
  }
});

// The colour half is pinned on index.html, which is what 8mw5l names: it is the
// only docs page that REDECLARED the whole theme (body background/colour plus a
// card), so the drift was invisible to every other guard. components.html's
// off-token gallery header is a separate (smaller) finding, filed rather than
// folded in here so this pin asserts exactly what was fixed.
const DOCS_TOKEN_COLOUR_PAGES = ["index.html"];

Deno.test("8mw5l: static docs pages take their colours from docs/theme.css, never from literals", async () => {
  for (const page of DOCS_TOKEN_COLOUR_PAGES) {
    const html = await Deno.readTextFile(new URL(`../docs/${page}`, import.meta.url));
    // Only the inline <style> can drift from the token scale; an external sheet
    // is theme.css itself.
    for (const style of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
      assert(
        !/light-dark\(/.test(style[1]),
        `docs/${page} hard-codes a light-dark() colour literal; route it through a docs/theme.css token`,
      );
      assert(
        !/#[0-9a-f]{3,8}\b/i.test(style[1]) && !/\brgba?\(/i.test(style[1]),
        `docs/${page} hard-codes a colour literal; route it through a docs/theme.css token`,
      );
    }
  }
});
