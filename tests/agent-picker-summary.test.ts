// @ts-nocheck — stubs browser globals (HTMLElement/customElements/document)
// that Deno's type-checker doesn't know about; the runtime behavior is what is
// under test.
// tests/agent-picker-summary.test.ts — the <agent-picker> SUMMARY presentation
// and its per-row Delete (CAP-FB-20260825-AGENT-PICKER-HUB-ROWS-01).
//
// The hub's Named / Background / Site agent lists are rendered by the SHARED
// picker instead of a hand-rolled row, so the two capabilities that list needs
// are pinned here by DRIVING the component: a summary has no search combobox
// and its rows are plain buttons (a role=option outside a listbox is the
// invalid half of the pair); `deletable` puts a Delete on exactly the named
// kinds, emits delete, and NEVER selects the row it deletes; a row click still
// emits the same agent-select the hub's open behaviour listens for.

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
  /** Fire every listener for `type` with a synthetic event; returns them. */
  fire(type, event = {}) {
    const e = { type, stopPropagation() { this._stopped = true; }, ...event };
    for (const fn of this.listeners.get(type) ?? []) fn(e);
    return e;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  /** Every descendant (shadow trees excluded — the picker rows are light DOM). */
  all() {
    const out = [];
    const walk = (n) => { for (const c of n.children ?? []) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  /** Elements carrying `name` as one of their class tokens (a summary row's
   * summary line is "sub clamped", its combobox twin a bare "sub"). */
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

const GROUPS = [
  {
    id: "agents",
    label: "",
    agents: [
      { ref: "named:reader", id: "reader", kind: "named", name: "Reader", summary: "reads articles" },
      {
        ref: "background:sorting-hat",
        id: "sorting-hat",
        kind: "background",
        name: "Sorting Hat",
        summary: "groups related tabs",
        status: "every 15 min",
      },
    ],
  },
];

/** A mounted picker whose list is a real stub node (the shadow root is not a
 * DOM), so _renderList's own element building is what the assertions read. */
function mount(attrs = {}) {
  const picker = new AgentPicker();
  for (const [k, v] of Object.entries(attrs)) picker.setAttribute(k, v);
  picker._rendered = true;
  picker._render(); // writes the markup into the stub shadow root
  picker._list = new StubElement("div");
  picker._renderList();
  return picker;
}

Deno.test("agent-picker summary: no search combobox, rows are plain buttons", async () => {
  const summary = mount({ summary: "", agents: JSON.stringify(GROUPS) });
  assert(!/role="combobox"/u.test(summary.shadowRoot.innerHTML), "the summary has no search combobox to own the list");
  assert(!/ap-search/u.test(summary.shadowRoot.innerHTML), "no search input is rendered");
  assert(!/role="listbox"/u.test(summary.shadowRoot.innerHTML), "no empty listbox wrapper");
  const rows = summary._list.byClass("opt");
  assert(rows.length === 2, `both rows render (saw ${rows.length})`);
  for (const row of rows) {
    assert(row.getAttribute("role") === null, "a summary row is a plain button, not an orphan role=option");
    assert(row.getAttribute("aria-selected") === null, "no listbox selection state without a listbox");
  }
  // The rows are still the SAME identity the host renders (name + summary).
  assert(rows[0].byClass("name")[0].textContent === "Reader");
  assert(rows[1].byClass("sub")[0].textContent.includes("groups related tabs"));
  // …and a click still emits agent-select — the hub's open behaviour.
  const seen = [];
  summary._emit = (type, detail) => seen.push({ type, detail });
  rows[0].fire("click");
  assertEquals(seen.map((e) => e.type), ["agent-select"]);
  assertEquals(seen[0].detail.ref, "named:reader");
  // The row's status is the hub's schedule chip ("every 15 min") — its own
  // element, never folded into the summary line.
  const status = rows[1].byClass("status");
  assertEquals(status.length, 1, "a row with a status renders the chip");
  assertEquals(status[0].textContent, "every 15 min");
  assertEquals(rows[0].byClass("status").length, 0, "a row without a status renders no chip");
  // Clamped, never truncated: the summary line keeps two lines' worth of room
  // and the FULL text in the DOM (the hub's narrow panels keep the role they
  // already rendered), so the clamp class and its hover title are part of the
  // summary row contract.
  assertEquals(rows[0].byClass("sub")[0].className, "sub clamped");
  assertEquals(rows[0].byClass("sub")[0].getAttribute("title"), "reads articles");
  // The combobox presentation keeps its single-line ellipsis.
  const comboSub = mount({ agents: JSON.stringify(GROUPS) })._list.byClass("opt")[0].byClass("sub")[0];
  assertEquals(comboSub.className, "sub");
  assertEquals(comboSub.getAttribute("title"), null);
});

Deno.test("agent-picker combobox is unchanged: the search row + listbox roles are still there", async () => {
  const combo = mount({ agents: JSON.stringify(GROUPS) });
  assert(/role="combobox"/u.test(combo.shadowRoot.innerHTML), "the combobox is untouched");
  assert(/role="listbox"/u.test(combo.shadowRoot.innerHTML), "the listbox is untouched");
  const row = combo._list.byClass("opt")[0];
  assertEquals(row.getAttribute("role"), "option");
  assertEquals(row.getAttribute("aria-selected"), "false");
});

Deno.test("agent-picker summary: an unlabelled group renders no heading, a labelled one does", async () => {
  const unlabelled = mount({ summary: "", agents: JSON.stringify(GROUPS) });
  assertEquals(unlabelled._list.byClass("group-h").length, 0, "the hub's single list carries no group heading");
  const labelled = mount({
    summary: "",
    agents: JSON.stringify([{ ...GROUPS[0], id: "named", label: "Named agents" }]),
  });
  assertEquals(labelled._list.byClass("group-h").length, 1);
  assertEquals(labelled._list.byClass("group-h")[0].textContent, "Named agents");
});

Deno.test("agent-picker deletable: only the named kinds get a Delete, and deleting never selects", async () => {
  const picker = mount({ summary: "", deletable: "background", agents: JSON.stringify(GROUPS) });
  const wrappers = picker._list.byClass("optwrap");
  assertEquals(wrappers.length, 1, "only the background row is wrapped with its Delete");
  assertEquals(wrappers[0].byClass("opt").length, 1, "the row is a SIBLING of its Delete, never its parent");
  const dels = wrappers[0].byClass("rowdel");
  assertEquals(dels.length, 1, "the background row carries its Delete");
  assertEquals(picker._list.byClass("rowdel").length, 1, "a named agent row has no Delete");

  const seen = [];
  picker._emit = (type, detail) => seen.push({ type, detail });
  let stopped = false;
  dels[0].fire("click", { stopPropagation: () => { stopped = true; } });
  assertEquals(stopped, true, "the Delete click must not bubble into the row's open handler");
  assertEquals(seen.map((e) => e.type), ["delete"], "the row is deleted, never selected");
  assertEquals(seen[0].detail.ref, "background:sorting-hat");
  assertEquals(seen[0].detail.agent.id, "sorting-hat");
  // The row itself still opens the agent (the Delete is the ONLY new control).
  wrappers[0].byClass("opt")[0].fire("click");
  assertEquals(seen.map((e) => e.type), ["delete", "agent-select"]);
});

Deno.test("agent-picker deletable: a bare attribute covers every kind, no attribute covers none", async () => {
  const every = mount({ summary: "", deletable: "", agents: JSON.stringify(GROUPS) });
  assertEquals(every._list.byClass("rowdel").length, 2, "a bare deletable puts Delete on every row");
  const none = mount({ summary: "", agents: JSON.stringify(GROUPS) });
  assertEquals(none._list.byClass("rowdel").length, 0, "no deletable attribute, no Delete");
  // The destructive control is a SUMMARY affordance: a combobox row is a
  // role=option inside a listbox and gains nothing from a second control.
  const combo = mount({ deletable: "", agents: JSON.stringify(GROUPS) });
  assertEquals(combo._list.byClass("rowdel").length, 0, "a combobox row carries no Delete");
});
