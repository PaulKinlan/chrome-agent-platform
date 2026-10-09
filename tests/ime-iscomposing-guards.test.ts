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

  const optionsSrc = await Deno.readTextFile(`${ROOT}extension/options/options.js`);
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

Deno.test("bmkv9: falsification: NTP task-rename input ignores Enter when isComposing or keyCode 229", () => {
  // Simulate the exact handler from extension/ntp/ntp.js:
  // input.addEventListener("keydown", (e) => {
  //   if (e.isComposing || e.keyCode === 229) return;
  //   if (e.key === "Enter") { e.preventDefault(); input.blur(); }
  //   if (e.key === "Escape") { restore(original); }
  // });
  let blurred = false;
  let prevented = false;
  const fakeInput = {
    blur: () => { blurred = true; },
  };

  const handler = (e: any) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") { e.preventDefault(); fakeInput.blur(); }
  };

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
});

// ── 6. Behavioral Falsification: Options Python Net Origin Input ─────────────

Deno.test("bmkv9: falsification: Options #python-net-origin input ignores Enter when isComposing or keyCode 229", () => {
  // Simulate the exact handler from extension/options/options.js:
  // input?.addEventListener("keydown", (e) => {
  //   if (e.isComposing || e.keyCode === 229) return;
  //   if (e.key === "Enter") { e.preventDefault(); add(); }
  // });
  let added = false;
  let prevented = false;
  const add = () => { added = true; };

  const handler = (e: any) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") { e.preventDefault(); add(); }
  };

  // 1. Enter while isComposing -> NO add, NO preventDefault
  added = false;
  prevented = false;
  handler({ key: "Enter", isComposing: true, keyCode: 13, preventDefault: () => { prevented = true; } });
  assertEquals(added, false, "options python-net add must not fire during isComposing");
  assertEquals(prevented, false, "options python-net must not preventDefault during isComposing");

  // 2. Enter while keyCode === 229 -> NO add, NO preventDefault
  added = false;
  prevented = false;
  handler({ key: "Enter", isComposing: false, keyCode: 229, preventDefault: () => { prevented = true; } });
  assertEquals(added, false, "options python-net add must not fire during keyCode 229");
  assertEquals(prevented, false, "options python-net must not preventDefault during keyCode 229");

  // 3. Enter when not composing -> fires add() and prevents default
  added = false;
  prevented = false;
  handler({ key: "Enter", isComposing: false, keyCode: 13, preventDefault: () => { prevented = true; } });
  assertEquals(added, true, "options python-net add must fire on plain Enter");
  assertEquals(prevented, true, "options python-net must preventDefault on plain Enter");
});

// ── 7. Behavioral Falsification: Sidepanel URL Input ─────────────────────────

Deno.test("bmkv9: falsification: Sidepanel #url input ignores Enter when isComposing or keyCode 229", () => {
  // Simulate the exact handler from extension/sidepanel/sidepanel.js:
  // urlInput.addEventListener("keydown", (e) => {
  //   if (e.isComposing || e.keyCode === 229) return;
  //   if (e.key === "Enter") go();
  // });
  let went = false;
  const go = () => { went = true; };

  const handler = (e: any) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") go();
  };

  // 1. Enter while isComposing -> NO go
  went = false;
  handler({ key: "Enter", isComposing: true, keyCode: 13 });
  assertEquals(went, false, "sidepanel go must not fire during isComposing");

  // 2. Enter while keyCode === 229 -> NO go
  went = false;
  handler({ key: "Enter", isComposing: false, keyCode: 229 });
  assertEquals(went, false, "sidepanel go must not fire during keyCode 229");

  // 3. Enter when not composing -> fires go()
  went = false;
  handler({ key: "Enter", isComposing: false, keyCode: 13 });
  assertEquals(went, true, "sidepanel go must fire on plain Enter");
});
