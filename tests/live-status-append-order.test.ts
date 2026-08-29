// @ts-nocheck — stubs browser globals (HTMLElement/customElements/document)
// with a minimal fake DOM; the REAL AgentConversation append-order logic is
// what runs under test.
// tests/live-status-append-order.test.ts — the live-status row must stay the
// conversation's LAST child no matter what lands mid-run (review P1-a:
// conversation.js updates the status, then appends a tool card AFTER the row;
// error and permission-card paths did likewise). Falsification: the append-
// order tests are RED on 63a1a8b9 (pre-fix), GREEN on the fix.

import { assert, assertEquals } from "jsr:@std/assert";

// ── minimal fake DOM ────────────────────────────────────────────────────────
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = new Map();
    this.className = "";
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    const self = this;
    this.classList = {
      add: (c) => self.classSet.add(c),
      contains: (c) => self.classSet.has(c),
    };
    this.classSet = new Set();
  }
  get isConnected() {
    let p = this;
    while (p.parent) p = p.parent;
    return p.isHost === true;
  }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  appendChild(node) {
    node.parent?.children?.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, ref) {
    node.parent?.children?.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  replaceChildren() { for (const c of this.children) c.parent = null; this.children = []; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  removeAttribute(n) { this.attrs.delete(n); }
  attachShadow() { return { querySelector: () => null, querySelectorAll: () => [] }; }
  addEventListener() {}
  dispatchEvent() { return true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const registry = new Map();
let createdRows = 0;

globalThis.HTMLElement = FakeEl;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init?.detail ?? {}; }
};
globalThis.document = {
  createElement(tag) {
    const el = new FakeEl(tag);
    if (tag === "conversation-run-status") createdRows++;
    return el;
  },
  addEventListener() {},
};

await import("../extension/shared/components.js");
const AgentConversation = registry.get("agent-conversation");
assert(AgentConversation, "agent-conversation registered");

function newConversation() {
  const c = new AgentConversation();
  c.isHost = true; // the conversation is the connected root for isConnected
  return c;
}
const liveRow = (c) => c.children.find((el) => el.classList.contains("live-status")) ?? null;

Deno.test("live row stays LAST: a tool card appended mid-run lands BEFORE the row", () => {
  const c = newConversation();
  c.setLiveStatus({ state: "running", activity: "Thinking…" });
  const row = liveRow(c);
  assert(row, "the live row renders");
  assertEquals(c.lastElementChild, row, "row starts last");
  c.appendTool({ name: "memory_set", status: "running" });
  assertEquals(c.lastElementChild, row, "the row is STILL last after a tool card lands (the run-status surface is the bottom of the flow)");
  assert(c.children.indexOf(row) > 0, "the tool card really inserted before it");
});

Deno.test("live row stays LAST: user/error/thinking appends and permission-style inserts land BEFORE the row", () => {
  const c = newConversation();
  c.setLiveStatus({ state: "running" });
  const row = liveRow(c);
  c.appendUser("hello");
  assertEquals(c.lastElementChild, row, "user bubble before the row");
  c.appendError("boom", { reason: "x" });
  assertEquals(c.lastElementChild, row, "error bubble before the row");
  c.appendThinking("…", {});
  assertEquals(c.lastElementChild, row, "thinking bubble before the row");
  // The permission-card path (conversation.js) calls the public insert API.
  const card = document.createElement("permission-approval-card");
  c.appendTranscript(card);
  assertEquals(c.lastElementChild, row, "permission card before the row");
  c.appendArtifact({ artifact: { id: "a1", name: "n", type: "data" } });
  assertEquals(c.lastElementChild, row, "artifact block before the row");
});

Deno.test("live row stays LAST across a full setMessages rebuild", () => {
  const c = newConversation();
  c.setLiveStatus({ state: "running" });
  const row = liveRow(c);
  c.setMessages([{ role: "user", content: "hi" }, { role: "agent", content: "hello" }]);
  assert(c.children.length >= 3, "messages rendered");
  assertEquals(c.lastElementChild, row, "the SAME row re-appended last after the rebuild");
  assert(row.isConnected, "the row survived the rebuild connected");
});

Deno.test("aria calm: identical status updates never re-create or re-append the row; distinct updates keep exactly ONE row", () => {
  createdRows = 0;
  const c = newConversation();
  c.setLiveStatus({ state: "running", activity: "Thinking…" });
  const row = liveRow(c);
  assertEquals(createdRows, 1);
  for (let i = 0; i < 50; i++) c.setLiveStatus({ state: "running", activity: "Thinking…" });
  assertEquals(createdRows, 1, "no-op updates dedupe — one row, one announcement (no aria storm)");
  assertEquals(liveRow(c), row, "same row instance retained");
  c.setLiveStatus({ state: "running", activity: "Thinking · step 2" });
  assertEquals(createdRows, 1, "a distinct update re-renders in place, never a second row");
  assertEquals(c.children.filter((el) => el.classList.contains("live-status")).length, 1);
  c.clearLiveStatus();
  assertEquals(liveRow(c), null, "the row resolves on clear");
  c.appendTool({ name: "memory_get", status: "success" });
  assertEquals(c.lastElementChild?.attrs.get("tool-name"), "memory_get", "after the row resolves, appends land at the end");
});
