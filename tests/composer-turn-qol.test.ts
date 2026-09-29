// @ts-nocheck
// tests/composer-turn-qol.test.ts — verifies bead chrome-agent-platform-d885.5:
// 1. Pasting or dropping an image/file onto <agent-composer> adds an attachment chip via addAttachment.
// 2. Selecting a kind === "capability" item in <agent-composer> calls chrome.permissions.request in-place and re-queries on grant.
// 3. Selecting a kind === "files-action" item in <agent-composer> invokes folderActions or emits grant-folder.
// 4. Pressing ArrowUp/ArrowDown in an empty <agent-composer> cycles through previously sent prompts.
// 5. <agent-composer> tab-picker supports Escape to close/refocus and ArrowDown/ArrowUp navigation.
// 6. <permission-approval-card state="expired"> renders an enabled .btn.allow ("Allow & retry") dispatching approval-decision { decision: "allow" }.
// 7. <message-bubble role="agent"> renders a copy button with "Copied" confirmation, and <message-bubble role="error"> dispatches retry-turn and fix-settings events.

import { assert, assertEquals } from "jsr:@std/assert@1";

class FakeTextNode {
  constructor(text) {
    this.nodeType = 3;
    this.nodeValue = text;
    this.textContent = text;
    this.parentNode = null;
  }
}

function decodeHtml(html) {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseHTML(html, parent) {
  const VOID_TAGS = new Set(["IMG", "INPUT", "BR", "HR", "META", "LINK"]);
  const tagRegex = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z0-9\-]+)([^>]*)>|([^<]+)/g;
  const attrRegex = /([a-zA-Z0-9\-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

  let stack = [parent];
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    if (match[0].startsWith("<!--")) continue;
    const [, isClosing, tagName, rawAttrs, text] = match;
    const current = stack[stack.length - 1];

    if (text) {
      const decoded = decodeHtml(text);
      if (decoded) {
        current.appendChild(new FakeTextNode(decoded));
        if (current.tagName === "TEXTAREA" || current.tagName === "STYLE") {
          current.value = (current.value || "") + decoded;
        }
      }
      continue;
    }

    const upper = tagName.toUpperCase();
    if (isClosing) {
      if (stack.length > 1 && stack[stack.length - 1].tagName === upper) {
        stack.pop();
      }
      continue;
    }

    const el = new FakeElement(tagName.toLowerCase());
    if (rawAttrs) {
      let attrMatch;
      attrRegex.lastIndex = 0;
      while ((attrMatch = attrRegex.exec(rawAttrs)) !== null) {
        const attrName = attrMatch[1];
        const attrVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
        if (attrName === "class") {
          el.className = attrVal;
        } else if (attrName === "id") {
          el.id = attrVal;
        } else {
          el.setAttribute(attrName, decodeHtml(attrVal));
        }
      }
    }

    current.appendChild(el);
    if (!VOID_TAGS.has(upper) && !rawAttrs.trim().endsWith("/")) {
      stack.push(el);
    }
  }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.className = "";
    this.id = "";
    this.open = false;
    this._textContent = "";
    this._innerHTML = "";
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.value = "";
    this.selectionStart = 0;
    this.selectionEnd = 0;
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
    if (idx === -1) this.children.push(child);
    else this.children.splice(idx, 0, child);
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

  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }

  replaceChildren(...kids) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    for (const k of kids) this.appendChild(k);
  }

  append(...kids) {
    for (const k of kids) this.appendChild(k);
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent || "";
    return this.children.map((c) => c.textContent || "").join("");
  }

  set textContent(val) {
    this._textContent = String(val);
    for (const c of this.children) c.parentNode = null;
    this.children = [];
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

  get classList() {
    const self = this;
    return {
      add(cls) {
        const set = new Set((self.className || "").split(/\s+/).filter(Boolean));
        set.add(cls);
        self.className = [...set].join(" ");
      },
      remove(cls) {
        const set = new Set((self.className || "").split(/\s+/).filter(Boolean));
        set.delete(cls);
        self.className = [...set].join(" ");
      },
      contains(cls) {
        return (self.className || "").split(/\s+/).includes(cls);
      },
      toggle(cls, force) {
        const set = new Set((self.className || "").split(/\s+/).filter(Boolean));
        const has = set.has(cls);
        const next = force !== undefined ? force : !has;
        if (next) set.add(cls); else set.delete(cls);
        self.className = [...set].join(" ");
        return next;
      },
    };
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
    return !ev.defaultPrevented;
  }

  querySelector(sel) {
    return walk(this, makeSelectorPredicate(sel));
  }

  querySelectorAll(sel) {
    return walkAll(this, makeSelectorPredicate(sel));
  }

  closest(sel) {
    let curr = this;
    const pred = makeSelectorPredicate(sel);
    while (curr) {
      if (pred(curr)) return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    for (const c of this.children) {
      if (c.contains(node)) return true;
    }
    return false;
  }

  setRangeText(replacement, start, end, selectMode) {
    const v = this.value;
    this.value = v.slice(0, start) + replacement + v.slice(end);
    this.selectionStart = start + replacement.length;
    this.selectionEnd = start + replacement.length;
  }

  scrollIntoView() {}
  focus() {
    if (globalThis.document) globalThis.document.activeElement = this;
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
  get hidden() {
    return this.hasAttribute("hidden");
  }
  set hidden(val) {
    if (val) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
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
    const classes = sel.slice(1).split(".");
    return (node) => {
      const list = (node.className || "").split(/\s+/);
      return classes.every((cls) => list.includes(cls));
    };
  }
  if (sel.startsWith("#")) {
    const id = sel.slice(1);
    return (node) => node.id === id;
  }
  if (sel.startsWith("[") && sel.endsWith("]")) {
    const attr = sel.slice(1, -1);
    if (attr.includes("=")) {
      const [k, v] = attr.split("=");
      const val = v.replace(/^["']|["']$/g, "");
      return (node) => node.getAttribute?.(k) === val;
    }
    return (node) => node.hasAttribute?.(attr);
  }
  if (sel === "style") return (node) => node.tagName === "STYLE";
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
    this.bubbles = init.bubbles ?? false;
    this.composed = init.composed ?? false;
    this.cancelable = init.cancelable ?? false;
    this.defaultPrevented = false;
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.navigator = { clipboard: { writeText: () => Promise.resolve() } };

const docListeners = new Map();
const headEl = new FakeElement("head");
const bodyEl = new FakeElement("body");
globalThis.document = {
  head: headEl,
  body: bodyEl,
  activeElement: null,
  createElement: (tag) => new FakeElement(tag),
  getElementById: (id) => {
    return walk(headEl, (n) => n.id === id) || walk(bodyEl, (n) => n.id === id) || null;
  },
  querySelector: (sel) => {
    return headEl.querySelector(sel) || bodyEl.querySelector(sel) || null;
  },
  querySelectorAll: (sel) => {
    return [...headEl.querySelectorAll(sel), ...bodyEl.querySelectorAll(sel)];
  },
  addEventListener: (type, fn, opts) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
  removeEventListener: (type, fn) => {
    const list = docListeners.get(type);
    if (list) {
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    }
  },
};

globalThis.requestAnimationFrame = (cb) => { setTimeout(cb, 0); return 1; };
globalThis.getComputedStyle = () => ({ lineHeight: "22px", paddingTop: "0px", paddingBottom: "0px" });

// Load components
await import("../extension/shared/components.js");

Deno.test("composer: paste and drop attachments add chips via addAttachment", async () => {
  const ComposerClass = registry.get("agent-composer");
  assert(ComposerClass, "agent-composer must be registered");
  const composer = new ComposerClass();
  composer._render();
  composer._wire();

  const compEl = composer._composerEl || composer.querySelector(".composer");
  const input = composer._input || composer.querySelector("[data-composer-input]");

  assertEquals(composer.attachments.length, 0);

  // 1. Simulate paste with an image
  const fakeImageFile = {
    name: "screenshot.png",
    type: "image/png",
    size: 1024,
  };
  globalThis.FileReader = class {
    readAsDataURL(file) {
      setTimeout(() => {
        this.result = "data:image/png;base64,mockpngdata";
        this.onload?.();
      }, 0);
    }
  };

  const pasteEv = {
    type: "paste",
    clipboardData: { files: [fakeImageFile] },
    preventDefault() {},
  };
  for (const fn of input.listeners.get("paste") ?? []) {
    await fn(pasteEv);
  }

  // Wait for async file reader and ingestion
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(composer.attachments.length, 1);
  assertEquals(composer.attachments[0].name, "screenshot.png");
  assertEquals(composer.attachments[0].kind, "image");
  assertEquals(composer.attachments[0].dataURL, "data:image/png;base64,mockpngdata");

  // 2. Simulate dragover, dragleave, drop
  const dragoverEv = { type: "dragover", preventDefault() {} };
  for (const fn of compEl.listeners.get("dragover") ?? []) fn(dragoverEv);
  assert(compEl.classList.contains("drag-over"), "dragover must add drag-over class");

  const dragleaveEv = { type: "dragleave", relatedTarget: null };
  for (const fn of compEl.listeners.get("dragleave") ?? []) fn(dragleaveEv);
  assert(!compEl.classList.contains("drag-over"), "dragleave must remove drag-over class");

  // Re-add and drop
  for (const fn of compEl.listeners.get("dragover") ?? []) fn(dragoverEv);
  const fakeTextFile = {
    name: "notes.txt",
    type: "text/plain",
    size: 200,
    text: async () => "Hello world notes",
  };
  const dropEv = {
    type: "drop",
    dataTransfer: { files: [fakeTextFile] },
    preventDefault() {},
  };
  for (const fn of compEl.listeners.get("drop") ?? []) await fn(dropEv);

  await new Promise((r) => setTimeout(r, 50));
  assert(!compEl.classList.contains("drag-over"), "drop must remove drag-over class");
  assertEquals(composer.attachments.length, 2);
  assertEquals(composer.attachments[1].name, "notes.txt");
  assertEquals(composer.attachments[1].kind, "file");
  assertEquals(composer.attachments[1].content, "Hello world notes");
});

Deno.test("composer: in-place capability grant calls chrome.permissions.request and refreshes in-place", async () => {
  const ComposerClass = registry.get("agent-composer");
  const composer = new ComposerClass();
  composer._render();
  composer._wire();

  let requestedPerms = null;
  let recomputedCount = 0;
  globalThis.chrome = {
    permissions: {
      request: async ({ permissions }) => {
        requestedPerms = permissions;
        return true;
      },
    },
    runtime: {
      openOptionsPage: () => {},
    },
  };

  composer._onComposerInput = async () => {
    recomputedCount++;
  };

  composer._popupToken = { type: "command", start: 0, end: 10, ns: "bookmarks" };
  composer._popupItems = [{
    id: "capability:bookmarks",
    label: "Bookmarks unavailable",
    description: "Grant Bookmarks in Settings",
    kind: "capability",
    capability: "bookmarks",
    ns: "bookmarks",
  }];

  await composer._select(0);

  assertEquals(requestedPerms, ["bookmarks"], "chrome.permissions.request must be called with requested capability");
  assertEquals(recomputedCount, 1, "_onComposerInput must be refreshed in-place upon grant");
  assert(composer.querySelector(".composer-status")?.textContent?.includes("Granted bookmarks"), "status must reflect in-place grant");
});

Deno.test("composer: files-action invokes folderActions or emits grant-folder", async () => {
  const ComposerClass = registry.get("agent-composer");
  const composer = new ComposerClass();
  composer._render();
  composer._wire();

  let grantedFolderItem = null;
  composer.folderActions = {
    grant: async (item) => {
      grantedFolderItem = item;
    },
  };

  composer._popupToken = { type: "command", start: 0, end: 6, ns: "folder" };
  const actionItem = {
    id: "action:grant",
    label: "Grant a folder",
    kind: "files-action",
    action: "grant",
    recovery: "Grant folder",
  };
  composer._popupItems = [actionItem];

  await composer._select(0);

  assertEquals(grantedFolderItem, actionItem, "folderActions.grant must be invoked for files-action in-place");
});

Deno.test("composer: ArrowUp and ArrowDown cycle through sent prompt history in an empty composer", async () => {
  const ComposerClass = registry.get("agent-composer");
  const composer = new ComposerClass();
  composer._render();
  composer._wire();
  const input = composer._input || composer.querySelector("[data-composer-input]");

  // Send three prompts
  input.value = "Prompt 1";
  await composer._send();
  input.value = "Prompt 2";
  await composer._send();
  input.value = "Prompt 3";
  await composer._send();

  assertEquals(composer._sentHistory, ["Prompt 1", "Prompt 2", "Prompt 3"]);
  assertEquals(input.value, "");

  const keydownHandlers = input.listeners.get("keydown") ?? [];
  const dispatchKey = (key) => {
    const ev = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of keydownHandlers) fn(ev);
    return ev;
  };

  // ArrowUp from empty input should recall last prompt
  dispatchKey("ArrowUp");
  assertEquals(input.value, "Prompt 3");

  // ArrowUp again recalls second prompt
  dispatchKey("ArrowUp");
  assertEquals(input.value, "Prompt 2");

  // ArrowUp again recalls first prompt
  dispatchKey("ArrowUp");
  assertEquals(input.value, "Prompt 1");

  // ArrowUp at top stays at first prompt
  dispatchKey("ArrowUp");
  assertEquals(input.value, "Prompt 1");

  // ArrowDown goes forward
  dispatchKey("ArrowDown");
  assertEquals(input.value, "Prompt 2");

  dispatchKey("ArrowDown");
  assertEquals(input.value, "Prompt 3");

  // ArrowDown past end restores empty draft
  dispatchKey("ArrowDown");
  assertEquals(input.value, "");
});

Deno.test("composer: tab-picker supports Escape to close/refocus and ArrowDown/ArrowUp navigation", async () => {
  const ComposerClass = registry.get("agent-composer");
  const composer = new ComposerClass();
  composer._render();
  composer._wire();
  const input = composer._input || composer.querySelector("[data-composer-input]");

  let focused = null;
  input.focus = () => { focused = input; };

  const tabs = [
    { title: "Tab 1", url: "https://example.com/1" },
    { title: "Tab 2", url: "https://example.com/2" },
  ];

  const pickPromise = composer._pickTab(tabs);
  const picker = composer._tabPicker;
  assert(picker, "tab picker element must be created");

  const rows = picker.querySelectorAll(".tab-picker-item");
  assertEquals(rows.length, 2, "must render rows with .tab-picker-item class");

  let focusedButton = null;
  for (const row of rows) {
    const origFocus = row.focus.bind(row);
    row.focus = () => {
      origFocus();
      focusedButton = row;
    };
  }

  // ArrowDown navigation
  const pickerKeydownHandlers = picker.listeners.get("keydown") ?? [];
  const dispatchPickerKey = (key) => {
    const ev = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of pickerKeydownHandlers) fn(ev);
    return ev;
  };

  assertEquals(document.activeElement, rows[0], "first button should be focused on open");

  dispatchPickerKey("ArrowDown");
  assertEquals(focusedButton, rows[1], "ArrowDown should focus second button");

  dispatchPickerKey("ArrowUp");
  assertEquals(focusedButton, rows[0], "ArrowUp should navigate back to first button");

  // Escape closes and refocuses input
  dispatchPickerKey("Escape");
  const result = await pickPromise;
  assertEquals(result, null, "Escape should cancel tab picker");
  assertEquals(composer._tabPicker, null, "picker must be cleared on close");
  assertEquals(focused, input, "Escape must refocus composer input");
});

Deno.test("permission-approval-card: state='expired' renders enabled 'Allow & retry' button that emits approval-decision", async () => {
  const CardClass = registry.get("permission-approval-card");
  assert(CardClass, "permission-approval-card must be registered");
  const card = new CardClass();
  card.setAttribute("state", "expired");
  card.setAttribute("reason", "manage bookmarks");
  card.setAttribute("permissions", JSON.stringify(["bookmarks"]));
  card._render();
  card._wire();

  const allowBtn = card._root.querySelector(".allow");
  assert(allowBtn, ".allow button must be rendered in expired state");
  assert(allowBtn.className.includes("retry-expired"), "button must have retry-expired class");
  assertEquals(allowBtn.textContent, "Allow & retry");

  let approvalDecision = null;
  card.addEventListener("approval-decision", (ev) => {
    approvalDecision = ev.detail;
  });

  const clickEv = { target: allowBtn, defaultPrevented: false };
  for (const fn of allowBtn.listeners.get("click") ?? []) fn(clickEv);

  assert(approvalDecision !== null, "approval-decision event must be dispatched");
  assertEquals(approvalDecision.decision, "allow");
});

Deno.test("message-bubble: role='agent' renders copy button with 'Copied' confirmation and emits copy-message", async () => {
  const BubbleClass = registry.get("message-bubble");
  assert(BubbleClass, "message-bubble must be registered");
  const bubble = new BubbleClass();
  bubble.setAttribute("role", "agent");
  bubble.setAttribute("content", "This is an agent response under 4000 characters.");
  bubble._render();
  bubble._wire();

  const copyBtn = bubble._root.querySelector(".msg-copy-btn");
  assert(copyBtn, "copy button must be rendered on normal agent response");
  assertEquals(copyBtn.getAttribute("aria-label"), "Copy response");

  let copiedText = "";
  globalThis.navigator.clipboard = {
    writeText: async (t) => { copiedText = t; },
  };

  let copyEventDetail = null;
  bubble.addEventListener("copy-message", (ev) => {
    copyEventDetail = ev.detail;
  });

  for (const fn of copyBtn.listeners.get("click") ?? []) await fn({});

  assertEquals(copiedText, "This is an agent response under 4000 characters.");
  assertEquals(copyBtn.textContent, "Copied");
  assert(copyEventDetail !== null, "copy-message event must be dispatched");
  assertEquals(copyEventDetail.text, "This is an agent response under 4000 characters.");

  // When streaming attribute is present, copy button must NOT be rendered
  const streamingBubble = new BubbleClass();
  streamingBubble.setAttribute("role", "agent");
  streamingBubble.setAttribute("streaming", "");
  streamingBubble.setAttribute("content", "Still streaming...");
  streamingBubble._render();
  const noCopyBtn = streamingBubble._root.querySelector(".msg-copy-btn");
  assertEquals(noCopyBtn, null, "copy button must not be present while streaming");
});

Deno.test("message-bubble: role='error' renders Retry button emitting retry-turn and Fix in Settings emitting fix-settings", async () => {
  const BubbleClass = registry.get("message-bubble");
  const bubble = new BubbleClass();
  bubble.setAttribute("role", "error");
  bubble.setAttribute("error-reason", "Rate limit exceeded on provider");
  bubble.setAttribute("error-action", "Wait a minute or check API key");
  bubble.setAttribute("error-category", "provider-auth");
  bubble._render();
  bubble._wire();

  const retryBtn = bubble._root.querySelector(".err-retry");
  const fixBtn = bubble._root.querySelector(".err-fix");
  assert(retryBtn, "retry button must be rendered on error bubbles");
  assert(fixBtn, "fix button must be rendered on fixable error bubbles");

  let retryEvent = null;
  bubble.addEventListener("retry-turn", (ev) => {
    retryEvent = ev.detail;
  });

  for (const fn of retryBtn.listeners.get("click") ?? []) fn({});
  assert(retryEvent !== null, "retry-turn event must be dispatched");
  assertEquals(retryEvent.errorReason, "Rate limit exceeded on provider");

  let fixEvent = null;
  let optionsOpened = false;
  globalThis.chrome = {
    runtime: {
      openOptionsPage: () => { optionsOpened = true; },
    },
  };

  bubble.addEventListener("fix-settings", (ev) => {
    fixEvent = ev.detail;
  });

  for (const fn of fixBtn.listeners.get("click") ?? []) fn({});
  assert(fixEvent !== null, "fix-settings event must be dispatched");
  assertEquals(fixEvent.href, "options/options.html#provider");
  assert(optionsOpened, "chrome.runtime.openOptionsPage must be called");
});
