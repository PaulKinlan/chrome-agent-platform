// @ts-nocheck — unit tests for bead chrome-agent-platform-716s.9
// [Side panel Agents view deduplication & distinct harness monograms]
// Acceptance criteria:
// 1. Agents view lists each harness once (DOM count test, RED on main = 2×).
// 2. Picker avatars are distinct per harness (Claude Code vs Codex are not both "C").
// 3. Side panel top strip is hidden when switching to Agents view and restored when switching to Page/Chat.
// 4. Paired vs unpaired harness separation: paired harnesses show live status pill,
//    unpaired harnesses collapse behind "Pair a local CLI agent in Settings →" disclosure.
// 5. Page view has empty state with suggestion chips.

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";

const root = new URL("../", import.meta.url);
const read = (p: string) => Deno.readTextFile(new URL(p, root));

// ---------------------------------------------------------------------------
// 1. Source structural tests (sidepanel.html & sidepanel.js)
// ---------------------------------------------------------------------------

Deno.test("716s.9: sidepanel Agents view does not duplicate harness quick chips in #agents-view", async () => {
  const html = await read("extension/sidepanel/sidepanel.html");
  const js = await read("extension/sidepanel/sidepanel.js");

  // In #agents-view, there must not be an active duplicate #harness-quick container
  // rendering buttons above #agents-picker.
  const agentsViewBlock = html.slice(html.indexOf('id="agents-view"'), html.indexOf('</section>', html.indexOf('id="agents-view"')));
  const hasDuplicateVisibleHarnessQuick = agentsViewBlock.includes('id="harness-quick"') && !agentsViewBlock.includes('id="harness-quick" hidden') && !agentsViewBlock.includes('id="harness-quick" aria-hidden="true"');
  assertEquals(hasDuplicateVisibleHarnessQuick, false, "the Agents view still has duplicate #harness-quick chips above the picker");

  // In sidepanel.js, harnessQuickEls must only target page view or deduplicate
  assert(!js.includes('document.getElementById("harness-quick"),\n  document.getElementById("harness-quick-page")'),
    "harnessQuickEls still targets both #harness-quick and #harness-quick-page simultaneously");
});

Deno.test("716s.9: sidepanel switches hide top agent strip when on Agents tab and restore on Page/Chat", async () => {
  const js = await read("extension/sidepanel/sidepanel.js");

  // switchView must handle hiding the top strip (.agent-strip or #agent-picker or #harness-quick) on agents view
  assert(js.includes(".agent-strip") || js.includes("#agent-picker") || js.includes("topStrip"),
    "switchView must control the top agent strip visibility");
  assert(js.includes("hidden = agents") || js.includes("hidden = !agents") || js.includes("topStrip.hidden"),
    "switchView must toggle strip hidden state based on active view");
});

Deno.test("716s.9: sidepanel Page view has empty state with suggestion chips", async () => {
  const html = await read("extension/sidepanel/sidepanel.html");
  const js = await read("extension/sidepanel/sidepanel.js");

  assert(html.includes('id="page-empty-state"'), "sidepanel.html must define #page-empty-state");
  assert(html.includes("chip-suggestion"), "sidepanel.html must define .chip-suggestion chips");
  assert(js.includes("pageEmptyState"), "sidepanel.js must wire pageEmptyState");
});

// ---------------------------------------------------------------------------
// 2. Behavioral test: distinct harness monograms & picker avatars
// ---------------------------------------------------------------------------

Deno.test("716s.9: harness monograms are distinct for Claude Code, Codex, Gemini CLI, and pi", async () => {
  const { harnessMonogram, HARNESS_MARK } = await import("../extension/shared/harness-marks.js");

  const cc = harnessMonogram("claude-code", "Claude Code");
  const cx = harnessMonogram("codex", "Codex");
  const g = harnessMonogram("gemini-cli", "Gemini CLI");
  const pi = harnessMonogram("pi", "pi");

  assertEquals(cc, "C");
  assertEquals(cx, "X");
  assertEquals(g, "G");
  assertEquals(pi, "π");

  // Distinctness
  assertNotEquals(cc, cx, "Claude Code and Codex share the monogram 'C'");
  assertNotEquals(cc, g);
  assertNotEquals(cx, g);

  // SVG marks also exist for all four
  assert(HARNESS_MARK["claude-code"], "missing mark for claude-code");
  assert(HARNESS_MARK["codex"], "missing mark for codex");
  assert(HARNESS_MARK["gemini-cli"], "missing mark for gemini-cli");
  assert(HARNESS_MARK["pi"], "missing mark for pi");
});

// ---------------------------------------------------------------------------
// 3. Behavioral test: AgentPicker renders distinct avatars & collapses unpaired harnesses
// ---------------------------------------------------------------------------

class StubShadowRoot {
  _html = "";
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

class StubElement {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.id = "";
    this.type = "";
    this.textContent = "";
    this.listeners = new Map();
  }
  attachShadow() { return (this.shadowRoot ??= new StubShadowRoot()); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  hasAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attributes, n); }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  removeAttribute(n) { delete this.attributes[n]; }
  appendChild(k) { this.children.push(k); return k; }
  append(...kids) { for (const k of kids) this.children.push(k); }
  replaceChildren(...kids) { this.children = [...kids]; }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, []);
    this.listeners.get(t).push(fn);
  }
  dispatchEvent() { return true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  all() {
    const out = [];
    const walk = (n) => { for (const c of n.children ?? []) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  byClass(name) { return this.all().filter((n) => String(n.className).split(/\s+/).includes(name)); }
  byTag(name) { return this.all().filter((n) => n.tagName === String(name).toUpperCase()); }
}

const componentRegistry = new Map();
globalThis.HTMLElement = StubElement;
globalThis.customElements = {
  define(name, cls) { componentRegistry.set(name, cls); },
  get(name) { return componentRegistry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.document = {
  createElement: (tag) => new StubElement(tag),
  createTextNode: (text) => Object.assign(new StubElement("#text"), { textContent: String(text) }),
};

await import("../extension/shared/components.js");
const AgentPicker = componentRegistry.get("agent-picker");

function mountPicker(attrs = {}) {
  const picker = new AgentPicker();
  for (const [k, v] of Object.entries(attrs)) picker.setAttribute(k, v);
  picker._rendered = true;
  picker._render();
  picker._list = new StubElement("div");
  picker._renderList();
  return picker;
}

Deno.test("716s.9: AgentPicker renders distinct avatars for Claude Code and Codex (not both 'C')", () => {
  const groups = [
    {
      id: "acp",
      label: "Harnesses (ACP)",
      agents: [
        { id: "claude-code", kind: "acp", name: "Claude Code", paired: true },
        { id: "codex", kind: "acp", name: "Codex", paired: true },
        { id: "gemini-cli", kind: "acp", name: "Gemini CLI", paired: true },
        { id: "pi", kind: "acp", name: "pi", paired: true },
      ],
    },
  ];

  const picker = mountPicker({ agents: JSON.stringify(groups) });
  const opts = picker._list.byClass("opt");
  assertEquals(opts.length, 4, `expected 4 options, got ${opts.length}`);

  const avatars = picker._list.byClass("avatar").map((av) => av.textContent.trim());
  const [ccAvatar, cxAvatar, gAvatar, piAvatar] = avatars;

  assertEquals(ccAvatar, "C", "Claude Code avatar must be 'C'");
  assertEquals(cxAvatar, "X", "Codex avatar must be 'X'");
  assertEquals(gAvatar, "G", "Gemini CLI avatar must be 'G'");
  assertEquals(piAvatar, "π", "pi avatar must be 'π'");
  assertNotEquals(ccAvatar, cxAvatar, "Claude Code and Codex must not have identical avatar text");
});

Deno.test("716s.9: AgentPicker collapses unpaired harnesses behind disclosure", () => {
  const groups = [
    {
      id: "acp",
      label: "Harnesses (ACP)",
      agents: [
        { id: "claude-code", kind: "acp", name: "Claude Code", paired: false },
        { id: "codex", kind: "acp", name: "Codex", paired: false },
        { id: "gemini-cli", kind: "acp", name: "Gemini CLI", paired: false },
      ],
    },
  ];

  const picker = mountPicker({ agents: JSON.stringify(groups) });

  // Unpaired harnesses must be inside details.unpaired-harnesses
  const details = picker._list.byTag("details");
  assertEquals(details.length, 1, "expected 1 details element for unpaired harnesses");
  assertEquals(details[0].className, "unpaired-harnesses");

  const summary = picker._list.byTag("summary")[0];
  assert(summary, "missing summary element");
  assert(summary.all().some((el) => el.textContent.includes("Pair a local CLI agent in Settings")),
    "summary text must include 'Pair a local CLI agent in Settings'");
});

Deno.test("716s.9: AgentPicker renders paired harness with live status pill outside disclosure", () => {
  const groups = [
    {
      id: "acp",
      label: "Harnesses (ACP)",
      agents: [
        { id: "claude-code", kind: "acp", name: "Claude Code", paired: true, status: "Paired" },
        { id: "codex", kind: "acp", name: "Codex", paired: false },
      ],
    },
  ];

  const picker = mountPicker({ agents: JSON.stringify(groups) });

  // Paired harness must have status.paired
  const pairedStatus = picker._list.byClass("status").find((st) => st.className.includes("paired"));
  assert(pairedStatus, "missing .status.paired element for paired harness");
  assertEquals(pairedStatus.textContent, "Paired");

  // Unpaired is in details
  const details = picker._list.byTag("details");
  assertEquals(details.length, 1, "unpaired harness must still be in details");
});
