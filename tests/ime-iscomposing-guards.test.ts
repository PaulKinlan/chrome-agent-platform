// @ts-nocheck
// tests/ime-iscomposing-guards.test.ts — verifies that editable-text Enter/navigation handlers
// guard against mid-composition submissions (CJK/IME e.isComposing || e.keyCode === 229)
// across all six audited surfaces (chrome-agent-platform-bmkv9).
//
// Surfaces:
// 1. [HIGH] extension/ntp/ntp.js: task-rename inline editor input keydown
// 2. [HIGH] extension/options/options.js: #python-net-origin input keydown
// 3. [HIGH] extension/sidepanel/sidepanel.js: #url input keydown
// 4. [HIGH] extension/skills/skills-panel.js: .import-url input keydown
// 5. [MEDIUM] extension/shared/components-conversation.js: <prompt-bar> #pb-input keydown
// 6. [LOW] extension/shared/components-conversation.js: <agent-picker> #ap-search keydown

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ── 1. Static AST / Source Guards Verification ─────────────────────────────

Deno.test("bmkv9: static check: all 6 audited surfaces carry e.isComposing || e.keyCode === 229", async () => {
  const ntpSrc = await Deno.readTextFile(`${ROOT}extension/ntp/ntp.js`);
  assert(
    ntpSrc.includes('input.addEventListener("keydown", (e) => {\n    if (e.isComposing || e.keyCode === 229) return;') ||
    ntpSrc.includes('input.addEventListener("keydown", (e) => { if (e.isComposing || e.keyCode === 229) return;'),
    "ntp.js task rename input keydown must guard on e.isComposing || e.keyCode === 229",
  );

  const optionsSrc = await Deno.readTextFile(`${ROOT}extension/options/panels/permissions.js`);
  assert(
    optionsSrc.includes('input?.addEventListener("keydown", (e) => {\n      if (e.isComposing || e.keyCode === 229) return;') ||
    optionsSrc.includes('input?.addEventListener("keydown", (e) => { if (e.isComposing || e.keyCode === 229) return;'),
    "options.js python-net input keydown must guard on e.isComposing || e.keyCode === 229",
  );

  const sidepanelSrc = await Deno.readTextFile(`${ROOT}extension/sidepanel/sidepanel.js`);
  assert(
    sidepanelSrc.includes('urlInput.addEventListener("keydown", (e) => {\n  if (e.isComposing || e.keyCode === 229) return;'),
    "sidepanel.js url input keydown must guard on e.isComposing || e.keyCode === 229",
  );

  const skillsSrc = await Deno.readTextFile(`${ROOT}extension/skills/skills-panel.js`);
  assert(
    skillsSrc.includes('urlInput?.addEventListener("keydown", (e) => {\n    if (e.isComposing || e.keyCode === 229) return;'),
    "skills-panel.js import url keydown must guard on e.isComposing || e.keyCode === 229",
  );

  const convSrc = await Deno.readTextFile(`${ROOT}extension/shared/components-conversation.js`);
  // PromptBar #pb-input keydown: guard must be first statement, above Escape/popover branch
  const pbMatch = convSrc.match(/ta\?\.addEventListener\("keydown",\s*\(e\)\s*=>\s*\{([\s\S]*?)\}\);/);
  assert(pbMatch, "PromptBar textarea keydown listener must exist");
  assert(
    pbMatch[1].trim().startsWith("if (e.isComposing || e.keyCode === 229) return;"),
    "PromptBar textarea keydown handler must start with e.isComposing || e.keyCode === 229 guard",
  );

  // AgentPicker #ap-search keydown: guard must be first statement, above navigation
  const apMatch = convSrc.match(/this\._search\?\.addEventListener\("keydown",\s*\(e\)\s*=>\s*\{([\s\S]*?)\}\);/);
  assert(apMatch, "AgentPicker search keydown listener must exist");
  assert(
    apMatch[1].trim().startsWith("if (e.isComposing || e.keyCode === 229) return;"),
    "AgentPicker search keydown handler must start with e.isComposing || e.keyCode === 229 guard",
  );

  // Gallery copy in docs/ must carry the same isComposing guard
  const docsConvSrc = await Deno.readTextFile(`${ROOT}docs/components-conversation.js`);
  assert(
    docsConvSrc.includes("if (e.isComposing || e.keyCode === 229) return;"),
    "docs/components-conversation.js must carry the isComposing guard in sync",
  );

  // Surface 7 (kital): <model-picker> combobox keydown in extension/shared/components-settings.js
  const settingsSrc = await Deno.readTextFile(`${ROOT}extension/shared/components-settings.js`);
  const mpMatch = settingsSrc.match(/_onKey\(e\)\s*\{([\s\S]*?)\}/);
  assert(mpMatch, "ModelPicker._onKey handler must exist");
  assert(
    mpMatch[1].trim().startsWith("if (e.isComposing || e.keyCode === 229) return;"),
    "ModelPicker._onKey handler must start with e.isComposing || e.keyCode === 229 guard",
  );

  const docsSettingsSrc = await Deno.readTextFile(`${ROOT}docs/components-settings.js`);
  const docsMpMatch = docsSettingsSrc.match(/_onKey\(e\)\s*\{([\s\S]*?)\}/);
  assert(docsMpMatch, "docs/components-settings.js ModelPicker._onKey handler must exist");
  assert(
    docsMpMatch[1].trim().startsWith("if (e.isComposing || e.keyCode === 229) return;"),
    "docs/components-settings.js ModelPicker._onKey handler must start with e.isComposing || e.keyCode === 229 guard",
  );
});

// ── 2. Behavioral Falsification: PromptBar (#pb-input) ──────────────────────

Deno.test("bmkv9: falsification: <prompt-bar> ignores Enter when isComposing or keyCode 229, sends when not composing", async () => {
  // Extract PromptBar class by importing components-conversation with minimal DOM stub
  const registry = new Map();
  const prevCustomElements = (globalThis as any).customElements;
  const prevHTMLElement = (globalThis as any).HTMLElement;

  try {
    (globalThis as any).HTMLElement = class {
      attachShadow() { return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [] }; }
      getAttribute() { return null; }
      setAttribute() {}
      dispatchEvent() { return true; }
    };
    (globalThis as any).customElements = {
      define(name: string, cls: any) { registry.set(name, cls); },
      get(name: string) { return registry.get(name); },
    };

    const { PromptBar } = await import(`${ROOT}extension/shared/components-conversation.js`);
    const bar = new PromptBar();

    let sendEvents: any[] = [];
    bar._emit = (name: string, detail: any) => {
      if (name === "send") sendEvents.push(detail);
    };

    let taKeydown: ((e: any) => void) | null = null;
    const fakeTa = {
      value: "hello world",
      style: { height: "auto" },
      scrollHeight: 40,
      addEventListener(type: string, fn: any) {
        if (type === "keydown") taKeydown = fn;
      },
    };

    bar._root = {
      querySelector(sel: string) {
        if (sel === "#pb-input") return fakeTa;
        return null;
      },
    };

    bar._wire();
    assert(taKeydown !== null, "PromptBar textarea keydown must be registered");

    // 1. Falsification: Enter with isComposing: true -> NO send, text preserved
    let prevented = false;
    taKeydown!({
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      keyCode: 13,
      preventDefault: () => { prevented = true; },
    });
    assertEquals(sendEvents.length, 0, "Enter during isComposing must NOT emit send");
    assertEquals(fakeTa.value, "hello world", "value must remain intact during composition");

    // 2. Falsification: Enter with keyCode: 229 -> NO send, text preserved
    taKeydown!({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 229,
      preventDefault: () => { prevented = true; },
    });
    assertEquals(sendEvents.length, 0, "Enter with keyCode 229 must NOT emit send");
    assertEquals(fakeTa.value, "hello world", "value must remain intact");

    // 3. Falsification: Enter with isComposing: false -> EXACTLY ONE send, value cleared
    taKeydown!({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
      preventDefault: () => { prevented = true; },
    });
    assertEquals(sendEvents.length, 1, "Enter when not composing must emit exactly one send");
    assertEquals(sendEvents[0], { text: "hello world" }, "send event must carry input text");
    assertEquals(fakeTa.value, "", "textarea value must be cleared after send");
    assertEquals(prevented, true, "preventDefault must be called for plain Enter submit");
  } finally {
    (globalThis as any).customElements = prevCustomElements;
    (globalThis as any).HTMLElement = prevHTMLElement;
  }
});

// ── 3. Behavioral Falsification: AgentPicker (#ap-search) ────────────────────

Deno.test("bmkv9: falsification: <agent-picker> suppresses Enter/Tab and navigation when isComposing or keyCode 229", async () => {
  const { AgentPicker } = await import(`${ROOT}extension/shared/components-conversation.js`);
  const picker = new AgentPicker();

  let committedIndex = -1;
  picker._commit = (idx: number) => { committedIndex = idx; };
  picker._active = 0;
  picker._flat = [{ id: "test-agent", name: "Test Agent", kind: "agent" }];

  let searchKeydown: ((e: any) => void) | null = null;
  const fakeSearch = {
    value: "test",
    addEventListener(type: string, fn: any) {
      if (type === "keydown") searchKeydown = fn;
    },
  };
  picker._search = fakeSearch;
  picker._wire();
  assert(searchKeydown !== null, "AgentPicker search keydown must be registered");

  // 1. Falsification: Enter with isComposing: true -> NO commit
  searchKeydown!({
    key: "Enter",
    isComposing: true,
    keyCode: 13,
    preventDefault: () => {},
  });
  assertEquals(committedIndex, -1, "Enter during isComposing must NOT commit selection");

  // 2. Falsification: Tab with isComposing: true -> NO commit
  searchKeydown!({
    key: "Tab",
    isComposing: true,
    keyCode: 9,
    preventDefault: () => {},
  });
  assertEquals(committedIndex, -1, "Tab during isComposing must NOT commit selection");

  // 3. Falsification: ArrowDown with keyCode: 229 -> active index unchanged
  searchKeydown!({
    key: "ArrowDown",
    isComposing: false,
    keyCode: 229,
    preventDefault: () => {},
  });
  assertEquals(picker._active, 0, "navigation keys with keyCode 229 must not change active index");

  // 4. Normal Enter with isComposing: false -> commits selection
  searchKeydown!({
    key: "Enter",
    isComposing: false,
    keyCode: 13,
    preventDefault: () => {},
  });
  assertEquals(committedIndex, 0, "Enter when not composing must commit selection");
});

// ── 4. Behavioral Falsification: Skills Panel (.import-url) ──────────────────

Deno.test("bmkv9: falsification: skills-panel .import-url ignores Enter when isComposing or keyCode 229", async () => {
  // Setup minimal DOM for mountSkillsSection
  class MockEl {
    tag: string;
    children: any[] = [];
    listeners = new Map<string, any[]>();
    attrs = new Map<string, string>();
    dataset: Record<string, string> = {};
    value = "";
    className = "";
    textContent = "";
    hidden = false;
    disabled = false;
    constructor(tag: string) { this.tag = tag; }
    append(...kids: any[]) { for (const k of kids) this.children.push(k); }
    addEventListener(type: string, fn: any) {
      const list = this.listeners.get(type) ?? [];
      list.push(fn);
      this.listeners.set(type, list);
    }
    setAttribute(name: string, v: string) { this.attrs.set(name, String(v)); }
    getAttribute(name: string) { return this.attrs.get(name) ?? null; }
    removeAttribute(_n: string) {}
    replaceChildren(...kids: any[]) { this.children = kids; }
    querySelector(sel: string): any {
      if ((this as any).__sel === sel) return this;
      for (const c of this.children) {
        if (c.__sel === sel) return c;
        const hit = c.querySelector?.(sel);
        if (hit) return hit;
      }
      return null;
    }
  }

  const prevDoc = (globalThis as any).document;
  try {
    (globalThis as any).document = {
      createElement(tag: string) { return new MockEl(tag); },
    };

    const { mountSkillsSection } = await import(`${ROOT}extension/skills/skills-panel.js`);

    const section = new MockEl("section");
    const mk = (sel: string, tag = "div") => {
      const el = new MockEl(tag);
      (el as any).__sel = sel;
      return el;
    };
    section.append(
      mk(".skills-list"),
      mk(".import-status", "span"),
      mk(".import-url", "input"),
      mk(".import-btn", "button"),
      mk(".discover-btn", "button"),
      mk(".discovery-card"),
      mk(".discovery-summary"),
      mk(".discovery-list"),
      mk(".commands-list"),
    );

    let sentTypes: string[] = [];
    const mockSend = async (type: string, payload?: any) => {
      sentTypes.push(type);
      if (type === "skill.list") return { ok: true, skills: [] };
      if (type === "command.list") return { ok: true, commands: [] };
      if (type === "skill.import") return { ok: true, skill: { name: "test-skill", id: "test" } };
      return { ok: true };
    };

    mountSkillsSection(section as any, { send: mockSend });

    const urlInput = section.querySelector(".import-url");
    urlInput.value = "https://example.com/skill.json";
    const keydownListeners = urlInput.listeners.get("keydown") ?? [];
    assert(keydownListeners.length > 0, "urlInput keydown listener must be attached");
    const onKeydown = keydownListeners[0];

    sentTypes = [];

    // Falsification: Enter with isComposing: true -> no skill.import
    await onKeydown({ key: "Enter", isComposing: true, keyCode: 13 });
    assertEquals(sentTypes.includes("skill.import"), false, "isComposing Enter must not trigger skill.import");

    // Falsification: Enter with keyCode: 229 -> no skill.import
    await onKeydown({ key: "Enter", isComposing: false, keyCode: 229 });
    assertEquals(sentTypes.includes("skill.import"), false, "keyCode 229 Enter must not trigger skill.import");

    // Enter when not composing -> triggers skill.import
    await onKeydown({ key: "Enter", isComposing: false, keyCode: 13 });
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(sentTypes.includes("skill.import"), true, "plain Enter must trigger skill.import");
  } finally {
    await new Promise((r) => setTimeout(r, 50));
    (globalThis as any).document = prevDoc;
  }
});

// ── 5. Behavioral Falsification: NTP Task Rename Input ──────────────────────

Deno.test("bmkv9: real module: NTP task-rename input ignores Enter when isComposing or keyCode 229", async () => {
  const prevCustomElements = (globalThis as any).customElements;
  const prevHTMLElement = (globalThis as any).HTMLElement;
  const prevDocument = (globalThis as any).document;
  const prevWindow = (globalThis as any).window;
  const prevChrome = (globalThis as any).chrome;
  const prevLocation = (globalThis as any).location;
  const prevHistory = (globalThis as any).history;

  try {
    class MockEl {
      id = "";
      tagName = "";
      listeners = new Map<string, any[]>();
      value = "";
      children: any[] = [];
      dataset: Record<string, any> = {};
      style: Record<string, any> = {};
      textContent = "";
      hidden = false;
      constructor(id = "", tag = "div") {
        this.id = id;
        this.tagName = tag.toUpperCase();
      }
      addEventListener(type: string, fn: any) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type)!.push(fn);
      }
      querySelector(sel: string) {
        for (const c of this.children) {
          if (c.tagName?.toLowerCase() === sel || (c.id && `#${c.id}` === sel) || (c.className && sel === `.${c.className}`)) return c;
          const found = c.querySelector?.(sel);
          if (found) return found;
        }
        return null;
      }
      querySelectorAll() { return []; }
      replaceChildren(...kids: any[]) { this.children = kids; }
      appendChild(c: any) { this.children.push(c); return c; }
      append(...c: any[]) { this.children.push(...c); }
      setAttribute() {}
      removeAttribute() {}
      focus() {}
      select() {}
      blur() {
        const blurFns = this.listeners.get("blur") ?? [];
        for (const fn of blurFns) fn();
      }
      classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
    }

    const elements = new Map<string, MockEl>();
    function getEl(id: string) {
      if (!elements.has(id)) elements.set(id, new MockEl(id));
      return elements.get(id)!;
    }

    (globalThis as any).HTMLElement = class {};
    (globalThis as any).customElements = { define() {}, get() {} };
    (globalThis as any).document = {
      getElementById(id: string) { return getEl(id); },
      querySelector(sel: string) { return getEl(sel.replace(/^[#.]/, "")); },
      querySelectorAll() { return []; },
      createElement(tag: string) { return new MockEl("", tag); },
      createTextNode(text: string) { return { textContent: text }; },
      addEventListener() {},
    };
    (globalThis as any).window = {
      addEventListener() {},
      location: { search: "", hash: "#omnibox=thread:test-task", pathname: "" },
      history: { replaceState() {} },
    };
    (globalThis as any).location = (globalThis as any).window.location;
    (globalThis as any).history = (globalThis as any).window.history;

    (globalThis as any).chrome = {
      runtime: {
        sendMessage(_msg: any, cb: any) { if (cb) cb({ ok: true }); return Promise.resolve({ ok: true }); },
        onMessage: { addListener() {} },
        connect() { return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; },
        getManifest() { return {}; },
        getURL(p: string) { return p; },
      },
      tabs: {
        query(_q: any, cb: any) { if (cb) cb([]); return Promise.resolve([]); },
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
      },
      windows: {
        onFocusChanged: { addListener() {} },
      },
      storage: {
        local: { get(_k: any, cb: any) { if (cb) cb({}); return Promise.resolve({}); }, set(_v: any, cb: any) { if (cb) cb(); return Promise.resolve(); } },
      },
    };

    const ntp = await import(`${ROOT}extension/ntp/ntp.js?cacheBust=${Date.now()}`);
    await ntp.bootPipelinePromise?.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    const threadTitle = getEl("thread-title");
    const clickHandler = threadTitle.listeners.get("click")?.[0];
    assert(clickHandler, "threadTitle must have a click listener to start title edit");
    clickHandler();

    const input = threadTitle.children.find((c: any) => c.tagName === "INPUT");
    assert(input, "startTitleEdit must replace threadTitle with an input element");
    const handler = input.listeners.get("keydown")?.[0];
    assert(handler, "task rename input must have a keydown listener");

    let blurred = false;
    let prevented = false;
    input.blur = () => { blurred = true; };

    // 1. Enter while isComposing -> NO blur, NO preventDefault
    blurred = false;
    prevented = false;
    handler({ key: "Enter", isComposing: true, keyCode: 13, preventDefault: () => { prevented = true; } });
    assertEquals(blurred, false, "NTP task rename must not blur during isComposing");
    assertEquals(prevented, false, "NTP task rename must not preventDefault during isComposing");

    // 2. Enter while keyCode === 229 -> NO blur, NO preventDefault
    blurred = false;
    prevented = false;
    handler({ key: "Enter", isComposing: false, keyCode: 229, preventDefault: () => { prevented = true; } });
    assertEquals(blurred, false, "NTP task rename must not blur during keyCode 229");
    assertEquals(prevented, false, "NTP task rename must not preventDefault during keyCode 229");

    // 3. Enter when not composing -> blurs and prevents default
    blurred = false;
    prevented = false;
    handler({ key: "Enter", isComposing: false, keyCode: 13, preventDefault: () => { prevented = true; } });
    assertEquals(blurred, true, "NTP task rename must blur on plain Enter");
    assertEquals(prevented, true, "NTP task rename must preventDefault on plain Enter");
  } finally {
    (globalThis as any).customElements = prevCustomElements;
    (globalThis as any).HTMLElement = prevHTMLElement;
    (globalThis as any).document = prevDocument;
    (globalThis as any).window = prevWindow;
    (globalThis as any).chrome = prevChrome;
    (globalThis as any).location = prevLocation;
    (globalThis as any).history = prevHistory;
  }
});

// ── 6. Behavioral Falsification: Options Python Net Origin Input ─────────────

Deno.test("bmkv9: real module: Options #python-net-origin input ignores Enter when isComposing or keyCode 229", async () => {
  const prevCustomElements = (globalThis as any).customElements;
  const prevHTMLElement = (globalThis as any).HTMLElement;
  const prevDocument = (globalThis as any).document;

  try {
    class MockEl {
      id = "";
      tagName = "";
      listeners = new Map<string, any[]>();
      value = "";
      children: any[] = [];
      textContent = "";
      constructor(id = "", tag = "div") {
        this.id = id;
        this.tagName = tag.toUpperCase();
      }
      addEventListener(type: string, fn: any) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type)!.push(fn);
      }
      querySelector(sel: string) {
        if (this.id && sel === `#${this.id}`) return this;
        for (const c of this.children) {
          const found = c.querySelector?.(sel);
          if (found) return found;
        }
        return null;
      }
      querySelectorAll() { return []; }
      replaceChildren(...kids: any[]) { this.children = kids; }
      appendChild(c: any) { this.children.push(c); return c; }
      setAttribute() {}
      classList = { toggle() {} };
    }

    (globalThis as any).HTMLElement = class {};
    (globalThis as any).customElements = { define() {}, get() {} };
    (globalThis as any).document = {
      createElement(tag: string) { return new MockEl("", tag); },
    };

    const { createPanelContext } = await import(`${ROOT}extension/options/panel-context.js`);
    const { mount } = await import(`${ROOT}extension/options/panels/permissions.js`);

    const root = new MockEl("permissions-panel", "div");
    const mk = (id: string, tag = "div") => {
      const el = new MockEl(id, tag);
      return el;
    };
    const list = mk("python-net-list");
    const input = mk("python-net-origin", "input");
    const addBtn = mk("python-net-add", "button");
    const status = mk("python-net-status", "div");
    root.children.push(list, input, addBtn, status);

    let sent: any[] = [];
    const mockSend = async (typeOrMsg: any, payload?: any) => {
      const msg = typeof typeOrMsg === "object" ? typeOrMsg : { type: typeOrMsg, ...payload };
      sent.push(msg);
      if (msg.type === "python.network.grants") return { ok: true, grants: [] };
      if (msg.type === "python.network.grant") return { ok: true, origin: msg.origin, added: true };
      return { ok: true };
    };

    const ctx = createPanelContext({ root, send: mockSend });
    const handle = await mount(root, ctx);

    const keydownListeners = input.listeners.get("keydown") ?? [];
    assert(keydownListeners.length > 0, "options python-net-origin input must have keydown listener attached");
    const handler = keydownListeners[0];

    input.value = "https://api.example.com";

    // 1. Enter while isComposing -> NO add, NO preventDefault
    sent = [];
    let prevented = false;
    handler({ key: "Enter", isComposing: true, keyCode: 13, preventDefault: () => { prevented = true; } });
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(sent.filter((s) => s.type === "python.network.grant").length, 0, "options python-net add must not fire during isComposing");
    assertEquals(prevented, false, "options python-net must not preventDefault during isComposing");

    // 2. Enter while keyCode === 229 -> NO add, NO preventDefault
    sent = [];
    prevented = false;
    handler({ key: "Enter", isComposing: false, keyCode: 229, preventDefault: () => { prevented = true; } });
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(sent.filter((s) => s.type === "python.network.grant").length, 0, "options python-net add must not fire during keyCode 229");
    assertEquals(prevented, false, "options python-net must not preventDefault during keyCode 229");

    // 3. Enter when not composing -> fires add() and prevents default
    sent = [];
    prevented = false;
    handler({ key: "Enter", isComposing: false, keyCode: 13, preventDefault: () => { prevented = true; } });
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(sent.filter((s) => s.type === "python.network.grant").length, 1, "options python-net add must fire on plain Enter");
    assertEquals(prevented, true, "options python-net must preventDefault on plain Enter");

    handle?.unmount?.();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    (globalThis as any).customElements = prevCustomElements;
    (globalThis as any).HTMLElement = prevHTMLElement;
    (globalThis as any).document = prevDocument;
  }
});

// ── 7. Behavioral Falsification: Sidepanel URL Input ─────────────────────────

Deno.test("bmkv9: real module: Sidepanel #url input ignores Enter when isComposing or keyCode 229", async () => {
  const prevCustomElements = (globalThis as any).customElements;
  const prevHTMLElement = (globalThis as any).HTMLElement;
  const prevDocument = (globalThis as any).document;
  const prevWindow = (globalThis as any).window;
  const prevChrome = (globalThis as any).chrome;

  try {
    class MockEl {
      id = "";
      tagName = "";
      listeners = new Map<string, any[]>();
      value = "";
      children: any[] = [];
      textContent = "";
      constructor(id = "", tag = "div") {
        this.id = id;
        this.tagName = tag.toUpperCase();
      }
      addEventListener(type: string, fn: any) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type)!.push(fn);
      }
      querySelector() { return null; }
      querySelectorAll() { return []; }
      replaceChildren() {}
      appendChild(c: any) { return c; }
      append(...c: any[]) { this.children.push(...c); }
      setAttribute() {}
      removeAttribute() {}
      classList = { toggle() {}, add() {}, remove() {}, contains() { return false; } };
    }

    const elements = new Map<string, MockEl>();
    function getEl(id: string) {
      if (id === "agents-tasks") return null;
      if (!elements.has(id)) elements.set(id, new MockEl(id));
      return elements.get(id)!;
    }

    (globalThis as any).HTMLElement = class {};
    (globalThis as any).customElements = { define() {}, get() {} };
    (globalThis as any).document = {
      getElementById(id: string) { return getEl(id); },
      createElement(tag: string) { return new MockEl("", tag); },
      addEventListener() {},
    };
    (globalThis as any).window = {
      addEventListener() {},
    };

    let sent: any[] = [];
    (globalThis as any).chrome = {
      runtime: {
        sendMessage(msg: any, cb: any) {
          sent.push(msg);
          if (cb) cb({ ok: true });
          return Promise.resolve({ ok: true });
        },
        connect() { return { onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; },
        getManifest() { return {}; },
        getURL(p: string) { return p; },
      },
      tabs: {
        query(_q: any, cb: any) { if (cb) cb([]); return Promise.resolve([]); },
        onActivated: { addListener() {} },
        onUpdated: { addListener() {} },
      },
      windows: {
        onFocusChanged: { addListener() {} },
      },
      storage: {
        local: { get(_k: any, cb: any) { if (cb) cb({}); return Promise.resolve({}); }, set(_v: any, cb: any) { if (cb) cb(); return Promise.resolve(); } },
      },
    };

    await import(`${ROOT}extension/sidepanel/sidepanel.js?cacheBust=${Date.now()}`);

    const urlInput = getEl("url");
    const keydownListeners = urlInput.listeners.get("keydown") ?? [];
    assert(keydownListeners.length > 0, "sidepanel #url input must have keydown listener attached");
    const handler = keydownListeners[0];

    urlInput.value = "https://example.com";

    // 1. Enter while isComposing -> NO go
    sent = [];
    handler({ key: "Enter", isComposing: true, keyCode: 13 });
    assertEquals(sent.filter((s) => s.type === "sidepanel.openPage").length, 0, "sidepanel go must not fire during isComposing");

    // 2. Enter while keyCode === 229 -> NO go
    sent = [];
    handler({ key: "Enter", isComposing: false, keyCode: 229 });
    assertEquals(sent.filter((s) => s.type === "sidepanel.openPage").length, 0, "sidepanel go must not fire during keyCode 229");

    // 3. Enter when not composing -> fires go()
    sent = [];
    handler({ key: "Enter", isComposing: false, keyCode: 13 });
    assertEquals(sent.filter((s) => s.type === "sidepanel.openPage").length, 1, "sidepanel go must fire on plain Enter");

    await new Promise((r) => setTimeout(r, 50));
  } finally {
    (globalThis as any).customElements = prevCustomElements;
    (globalThis as any).HTMLElement = prevHTMLElement;
    (globalThis as any).document = prevDocument;
    (globalThis as any).window = prevWindow;
    (globalThis as any).chrome = prevChrome;
  }
});

// ── 8. Behavioral Falsification: ModelPicker Combobox (kital) ────────────────

Deno.test("kital: real module: <model-picker> _onKey ignores Enter, ArrowDown, ArrowUp when isComposing or keyCode 229; plain Enter commits once", async () => {
  const prevCustomElements = (globalThis as any).customElements;
  const prevHTMLElement = (globalThis as any).HTMLElement;
  const prevDocument = (globalThis as any).document;
  const prevWindow = (globalThis as any).window;

  try {
    (globalThis as any).HTMLElement = class {
      attachShadow() { return { innerHTML: "", querySelector: () => null, querySelectorAll: () => [], appendChild() {}, addEventListener() {} }; }
      getAttribute() { return null; }
      setAttribute() {}
      hasAttribute() { return false; }
      dispatchEvent() { return true; }
      addEventListener() {}
    };
    (globalThis as any).customElements = { define() {}, get() { return undefined; } };
    (globalThis as any).document = { addEventListener: () => {}, createElement: () => ({ style: {}, setAttribute() {} }) };
    (globalThis as any).window = { addEventListener: () => {} };

    const { ModelPicker } = await import(`${ROOT}extension/shared/components-settings.js`);
    const picker: any = new ModelPicker();
    picker._visibleOptions = [{ id: "m1" }, { id: "m2" }, { id: "m3" }];
    picker._open = true;
    picker._activeIndex = 0;
    picker._input = { value: "custom-model" };
    picker._root = { querySelector: () => null };
    picker._setOpen = (val: boolean) => { picker._open = val; };
    picker._renderList = () => {};
    picker._moveActive = (delta: number) => { picker._activeIndex += delta; };

    let commits = 0;
    let committedValue = "";
    picker._commitInput = () => { commits++; committedValue = picker._input.value; };
    picker._commit = (o: any) => { commits++; committedValue = String(o?.id ?? o); };

    let prevented = false;
    const ev = (key: string, isComposing: boolean, keyCode: number) => ({
      key,
      isComposing,
      keyCode,
      preventDefault: () => { prevented = true; },
    });

    // 1. Enter while isComposing: true -> NO commit, list stays open, no preventDefault
    prevented = false;
    picker._onKey(ev("Enter", true, 13));
    assertEquals(commits, 0, "Enter during isComposing must NOT commit");
    assertEquals(picker._open, true, "list must remain open during composition");
    assertEquals(prevented, false, "composing Enter must not prevent default");

    // 2. Enter with keyCode 229 (Safari confirming keydown) -> NO commit
    prevented = false;
    picker._onKey(ev("Enter", false, 229));
    assertEquals(commits, 0, "Enter with keyCode 229 must NOT commit");
    assertEquals(picker._open, true, "list must remain open during keyCode 229");
    assertEquals(prevented, false, "keyCode 229 must not prevent default");

    // 3. ArrowDown while isComposing: true -> activeIndex unchanged (0)
    prevented = false;
    picker._onKey(ev("ArrowDown", true, 40));
    assertEquals(picker._activeIndex, 0, "ArrowDown during composition must NOT move active index");
    assertEquals(prevented, false, "composing ArrowDown must not prevent default");

    // 4. ArrowDown with keyCode 229 -> activeIndex unchanged (0)
    prevented = false;
    picker._onKey(ev("ArrowDown", false, 229));
    assertEquals(picker._activeIndex, 0, "ArrowDown with keyCode 229 must NOT move active index");
    assertEquals(prevented, false, "keyCode 229 ArrowDown must not prevent default");

    // 5. ArrowUp while isComposing: true -> activeIndex unchanged (0)
    prevented = false;
    picker._onKey(ev("ArrowUp", true, 38));
    assertEquals(picker._activeIndex, 0, "ArrowUp during composition must NOT move active index");
    assertEquals(prevented, false, "composing ArrowUp must not prevent default");

    // 6. ArrowUp with keyCode 229 -> activeIndex unchanged (0)
    prevented = false;
    picker._onKey(ev("ArrowUp", false, 229));
    assertEquals(picker._activeIndex, 0, "ArrowUp with keyCode 229 must NOT move active index");
    assertEquals(prevented, false, "keyCode 229 ArrowUp must not prevent default");

    // 7. Non-composing ArrowDown -> moves activeIndex from 0 to 1 and calls preventDefault
    prevented = false;
    picker._onKey(ev("ArrowDown", false, 40));
    assertEquals(picker._activeIndex, 1, "non-composing ArrowDown must move active index");
    assertEquals(prevented, true, "non-composing ArrowDown must prevent default");

    // 8. Non-composing Enter -> commits active option ("m2"), closes list, calls preventDefault
    prevented = false;
    picker._onKey(ev("Enter", false, 13));
    assertEquals(commits, 1, "non-composing Enter must commit exactly once");
    assertEquals(committedValue, "m2", "committed value must match active option");
    assertEquals(picker._open, false, "list must close after commit");
    assertEquals(prevented, true, "non-composing Enter must prevent default");
  } finally {
    (globalThis as any).customElements = prevCustomElements;
    (globalThis as any).HTMLElement = prevHTMLElement;
    (globalThis as any).document = prevDocument;
    (globalThis as any).window = prevWindow;
  }
});
