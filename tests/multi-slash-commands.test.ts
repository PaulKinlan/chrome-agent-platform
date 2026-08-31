// @ts-nocheck — browser globals are stubbed (see the sibling components.test.ts).
// tests/multi-slash-commands.test.ts — CAP-FB-20260831-MULTI-SLASH-COMMANDS-01.
//
// Owner report: "/skill:screenshot-annotate /tabs:<tab>" — the FIRST /command
// works, but after it completes the SECOND /command never opens. Root cause:
// parseSlashCommand only treated "/" at the very START of the input as a
// command (the old round-2 free-text guard), so any later /token was plain
// text. Fix: a slash that begins a fresh whitespace-delimited token AFTER real
// text is a command position too, gated to KNOWN namespaces (URLs, mid-word
// slashes, leading-space tokens and invented namespaces stay text).
//
// This test drives the REAL <agent-composer> popup state machine through the
// sequence Paul described: /skill: resolves → popup closes + token resets →
// typing /tabs: re-opens the popup at the SECOND token's (non-zero) start.

// Stub chrome BEFORE importing components.js so RUNTIME_SEND is wired and the
// tabs loader has a backing API. RUNTIME_SEND is captured at module load.
const registry = new Map();

class HTMLElementStub {
  attachShadow(_init) { return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], appendChild() {} }; }
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

// The SW message surface + the tabs API the composer's command loaders use.
globalThis.chrome = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => {
      let res = { ok: true };
      if (msg?.type === "skill.list") {
        res = { skills: [{ id: "screenshot-annotate", name: "screenshot-annotate", description: "annotate a screenshot" }] };
      } else if (msg?.type === "agent.registry") {
        res = { groups: [] };
      } else if (msg?.type === "asset.list") {
        res = { assets: [] };
      }
      queueMicrotask(() => cb?.(res));
    },
  },
  tabs: {
    query: async () => [{ id: 7, title: "Journey target tab", url: "https://example.com/target", windowId: 1 }],
  },
};

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.parent = null; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.textContent = ""; this.className = ""; this.id = ""; this.hidden = false; this.type = ""; }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  removeAttribute(n) { delete this.attributes[n]; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  appendChild(k) { k.parent = this; this.children.push(k); return k; }
  replaceChildren(...kids) { this.children = []; for (const k of kids) { k.parent = this; this.children.push(k); } }
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  dispatch(t, e = {}) { e.target ??= this; e.preventDefault ??= () => {}; for (const f of this.listeners[t] ?? []) f(e); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; }
  querySelector(sel) {
    const m = sel.match(/data-index="?(\d+)/);
    if (m) return this.children.find((c) => String(c.dataset.index) === String(Number(m[1]))) ?? null;
    if (sel.startsWith("#")) { const id = sel.slice(1); return this.children.find((c) => c.id === id) ?? null; }
    return null;
  }
  querySelectorAll() { return []; }
  scrollIntoView() {}
}

await import("../extension/shared/components.js");
const AgentComposer = registry.get("agent-composer");
const composer = new AgentComposer();

// The popup renderer builds options with document.createElement + textContent.
const docListeners = {};
const fakeDocument = {
  head: new FakeNode("head"), body: new FakeNode("body"), documentElement: new FakeNode("html"),
  createElement: (tag) => new FakeNode(tag),
  getElementById: () => null,
  addEventListener: (type, fn) => { (docListeners[type] ??= []).push(fn); },
  removeEventListener(type, fn) {
    const arr = docListeners[type] ?? [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  },
  _listeners: docListeners,
};
const prevDocument = globalThis.document;
globalThis.document = fakeDocument;

function makeInput() {
  const input = new FakeNode("textarea");
  input.value = "";
  input.selectionStart = 0;
  input.selectionEnd = 0;
  input.focus = () => {};
  input.setRangeText = function (replacement, start, end, mode = "preserve") {
    const cur = this.value;
    const before = cur.slice(0, start);
    const after = cur.slice(end);
    this.value = before + replacement + after;
    if (mode === "end") this.selectionStart = this.selectionEnd = before.length + replacement.length;
    else this.selectionStart = this.selectionEnd = before.length + (this.selectionStart - start);
  };
  input.addEventListener("input", (ev) => input._onInput?.(ev));
  return input;
}

function setup() {
  composer._uid = "u-multi";
  const input = makeInput();
  const popup = new FakeNode("div");
  popup.id = `popup-u-multi`;
  composer._input = input;
  composer._popup = popup;
  composer._popupItems = [];
  composer._popupActive = -1;
  composer._popupToken = null;
  composer._slashAgentToken = null;
  composer._resolvedSpans = [];
  input._onInput = () => composer._onComposerInput();
  return { composer, input, popup };
}

Deno.test("multi-slash: after /skill resolves, typing /tabs: opens the tabs popup at the second token (CAP-FB-20260831-MULTI-SLASH-COMMANDS-01)", async () => {
  const { composer, input, popup } = setup();

  // Phase 1 — the FIRST command: type "/skill:screenshot-annotate".
  input.value = "/skill:screenshot-annotate";
  input.selectionStart = input.selectionEnd = input.value.length;
  await composer._onComposerInput();
  if (popup.hidden !== false) throw new Error("phase 1: the /skill popup must be open");
  if (composer._popupItems.length !== 1) throw new Error(`phase 1: expected the one seeded skill row, got ${composer._popupItems.length}`);
  if (composer._popupToken?.start !== 0) throw new Error(`phase 1: first-command token must start at 0, got ${composer._popupToken?.start}`);

  // Phase 2 — resolve the skill row (Enter/select path): token replaced, popup
  // closes, popup state resets (the "second command" bug was stale state here),
  // and the resolved-reference boundary is recorded for the next command.
  composer._select(0);
  await new Promise((r) => setTimeout(r, 0)); // the resolution .then() runs async
  await new Promise((r) => setTimeout(r, 0));
  if (popup.hidden !== true) throw new Error("phase 2: the popup must close after a pick");
  if (composer._popupToken !== null) throw new Error("phase 2: _popupToken must reset after a pick (stale token breaks the next command)");
  if (composer._popupItems.length !== 0) throw new Error("phase 2: _popupItems must reset after a pick");
  if (!/\/skill:screenshot-annotate/.test(input.value)) throw new Error(`phase 2: the skill reference must be inserted, got "${input.value}"`);
  const span = (composer._resolvedSpans || [])[0];
  if (!span || span.start !== 0 || span.end !== input.value.length || span.text !== input.value) {
    throw new Error(`phase 2: the resolved-reference span must be recorded (${JSON.stringify(span)} vs value "${input.value}")`);
  }
  const spanEnd = span.end;

  // Phase 3 — the SECOND command: type a space then "/tabs:". This only opens
  // because the slash sits immediately after the RECORDED resolved boundary.
  input.value = input.value.replace(/\/skill:screenshot-annotate$/, "/skill:screenshot-annotate /tabs:");
  input.selectionStart = input.selectionEnd = input.value.length;
  await composer._onComposerInput();
  if (popup.hidden !== false) throw new Error("phase 3: the /tabs popup must open (second command after a resolved reference)");
  const secondToken = composer._popupToken;
  if (!secondToken || secondToken.ns !== "tabs") throw new Error(`phase 3: the second token must be the tabs command, got ${JSON.stringify(secondToken)}`);
  if (secondToken.start !== spanEnd + 1) {
    throw new Error(`phase 3: the second token must start right after the resolved boundary + space (${spanEnd + 1}), got ${secondToken.start}`);
  }
  if (secondToken.end !== input.value.length) throw new Error(`phase 3: the second token must end at the caret (${input.value.length}), got ${secondToken.end}`);

  // Phase 4 — resolve the tab row: the tab attachment lands in the attachments
  // list and the input holds BOTH references.
  const tabItem = composer._popupItems[0];
  if (!tabItem || tabItem.kind !== "tab") throw new Error(`phase 4: the tabs popup must list the real tab, got ${JSON.stringify(tabItem)}`);
  composer._select(0);
  await new Promise((r) => setTimeout(r, 0)); // resolveComposerCommandSelection is async
  await new Promise((r) => setTimeout(r, 0));
  const attached = (composer.attachments || []).find((a) => a.kind === "tab" && a.tabId === 7);
  if (!attached) throw new Error("phase 4: the picked tab must attach as a tab reference");
  if (!/\/skill:screenshot-annotate/.test(input.value) || !/\/tabs:/.test(input.value)) {
    throw new Error(`phase 4: the final input must hold BOTH references, got "${input.value}"`);
  }
  if (popup.hidden !== true) throw new Error("phase 4: the popup must close after the second pick");
});

Deno.test("multi-slash: a mid-prose slash NOT after the resolved boundary stays text (r1 blocker)", async () => {
  const { composer, input, popup } = setup();

  // Resolve /skill:screenshot → the reference "/skill:screenshot-annotate" is
  // recorded as the boundary [0, 27].
  input.value = "/skill:screenshot";
  input.selectionStart = input.selectionEnd = input.value.length;
  await composer._onComposerInput();
  if (popup.hidden === true) throw new Error("the /skill popup must open for the matching query");
  composer._select(0);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const spanEnd = (composer._resolvedSpans || [])[0]?.end;
  if (spanEnd !== 26) throw new Error(`expected the resolved span to end at 26, got ${spanEnd}`);

  // Ordinary prose then a slash-command-looking token: the slash is NOT
  // immediately after the recorded boundary, so it must stay text — the
  // free-text guard the r1 review required.
  input.value = "/skill:screenshot-annotate please inspect /tabs:y";
  input.selectionStart = input.selectionEnd = input.value.length;
  await composer._onComposerInput();
  if (popup.hidden !== true) {
    throw new Error("mid-prose /tabs: must NOT open the popup (no boundary directly before it)");
  }
  if (composer._popupToken !== null) throw new Error("mid-prose slash must not set a popup token");

  // Even a leading-space slash with the boundary present elsewhere stays text.
  input.value = " /tabs:y";
  input.selectionStart = input.selectionEnd = input.value.length;
  await composer._onComposerInput();
  if (popup.hidden !== true) throw new Error("leading-space /tabs: must NOT open the popup");
});
