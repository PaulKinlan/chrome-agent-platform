// @ts-nocheck — stubs browser globals (HTMLElement/customElements/document)
// that Deno's type-checker doesn't know about; the runtime behavior is what is
// under test.
// tests/agent-picker-exclude-kinds.test.ts — the <agent-picker> exclude-kinds
// attribute (chrome-agent-platform-h97m): the side panel's agents list
// projects the ONE created-agents set (named + enabled background) that the
// hub sidebar, hub panel and Settings share. ACP harness agents are NOT agent
// rows — the side panel offers them through its harness-quick affordance —
// so its picker sets exclude-kinds="acp". These tests drive the REAL
// component: without the attribute the acp rows pass callable-only (the +3
// the four-surfaces journey measured); with it they are gone, the acp group
// is dropped, and a fresh profile renders the SAME "No agents yet." empty
// state the other three surfaces show.

import { assert, assertEquals } from "jsr:@std/assert@1";

const registry = new Map();

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
}

globalThis.HTMLElement = StubElement;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
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
const AgentPicker = registry.get("agent-picker");

// The registry as service-worker.js's agent.registry route emits it on a
// FRESH profile: no named agents, the built-in background templates all
// disabled, and three acp harness rows with NO enabled field (so isCallable's
// acp arm keeps them, unconditionally — the +3 the journey measured).
const FRESH_GROUPS = [
  { id: "named", label: "Named agents", agents: [] },
  {
    id: "background",
    label: "Background agents",
    agents: [
      { ref: "background:auto-group-by-domain", id: "auto-group-by-domain", kind: "background", name: "Sorting Hat", summary: "groups tabs", status: "disabled", enabled: false },
    ],
  },
  { id: "site", label: "Site Agents", agents: [] },
  {
    id: "acp",
    label: "Harnesses (ACP)",
    agents: [
      { id: "pi", kind: "acp", name: "pi" },
      { id: "claude-code", kind: "acp", name: "Claude Code" },
      { id: "codex", kind: "acp", name: "Codex" },
    ],
  },
];

function mount(attrs = {}) {
  const picker = new AgentPicker();
  picker.setAttribute("agents", JSON.stringify(FRESH_GROUPS));
  for (const [k, v] of Object.entries(attrs)) picker.setAttribute(k, v);
  picker._rendered = true;
  picker._render();
  picker._list = new StubElement("div");
  picker._renderList();
  return picker;
}

Deno.test("h97m: callable-only alone keeps the three acp rows (the measured +3, pinned as the control)", () => {
  const picker = mount({ "callable-only": "" });
  const rows = picker._visibleGroups().flatMap((g) => g.agents);
  assertEquals(rows.length, 3);
  assertEquals(rows.every((a) => a.kind === "acp"), true);
});

Deno.test("h97m: exclude-kinds=acp projects ZERO rows on a fresh profile — and the picker's empty state agrees with the other surfaces", () => {
  const picker = mount({ "callable-only": "", "exclude-kinds": "acp" });
  assertEquals(picker._visibleGroups(), [], "no visible groups at all");
  // The rendered empty state is the SAME sentence the hub sidebar shows.
  const stateRow = picker._list.byClass("state")[0] ?? null;
  assert(stateRow, "the empty state renders");
  assert(/No agents yet/.test(stateRow.textContent), stateRow.textContent);
});

Deno.test("h97m: exclude-kinds drops the acp GROUP entirely once an enabled background agent exists", () => {
  const picker = new AgentPicker();
  const groups = JSON.parse(JSON.stringify(FRESH_GROUPS));
  groups[1].agents[0].enabled = true; // one enabled background agent
  picker.setAttribute("agents", JSON.stringify(groups));
  picker.setAttribute("callable-only", "");
  picker.setAttribute("exclude-kinds", "acp");
  const visible = picker._visibleGroups();
  assertEquals(visible.map((g) => g.id), ["background"]);
  assertEquals(visible[0].agents.map((a) => a.id), ["auto-group-by-domain"]);
});

Deno.test("h97m: the attribute parses a space-separated kind list (and an absent attribute excludes nothing)", () => {
  const picker = mount({ "exclude-kinds": "acp site" });
  assertEquals(picker._excludeKinds, ["acp", "site"]);
  const plain = new AgentPicker();
  assertEquals(plain._excludeKinds, []);
});
