// @ts-nocheck — browser globals stubbed for the component import.
// tests/thread-reopen-render.test.ts — CAP-FB-20260824-THREAD-REOPEN-RENDER-01:
// PROVES the reopen projection renders every persisted user + assistant row.
// Drives the REAL projectThreadMessages transform (the exact code ntp.js's
// renderThreadProjection runs) into the REAL <agent-conversation> setMessages
// and asserts the owner's request bubbles and the assistant's reply bubbles
// are emitted, in ts order.

const registry = new Map();

class ElementStub {
  constructor(tag) {
    this.tagName = tag;
    this.attrs = new Map();
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  hasAttribute(n) { return this.attrs.has(n); }
  removeAttribute(n) { this.attrs.delete(n); }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.children.push(c); }
  replaceChildren() { this.children = []; }
  addEventListener() {}
  dispatchEvent() { return true; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
class HTMLElementStub extends ElementStub {
  constructor() { super("stub"); }
  attachShadow() { return new ElementStub("shadow-root"); }
}

globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.document = {
  createElement: (tag) => new ElementStub(tag),
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init?.detail ?? {}; }
};
globalThis.matchMedia = () => ({ matches: false });

import { assert, assertEquals } from "jsr:@std/assert@1";
import { projectThreadMessages } from "../extension/shared/conversation.js";

// A reopened two-turn task: user → tool pair → assistant, then user → assistant.
// Persisted rows carry executionId on the assistant terminals (as the durable
// outbox writes them).
const THREAD = {
  id: "t-reopen-1",
  name: "Book a table",
  messages: [
    { role: "user", content: "Book a table at Le Petit Bistro", ts: 1000, executionId: "exec_1" },
    { role: "tool", toolName: "book_table", toolStatus: "running", toolCallId: "c1", ts: 2000 },
    { role: "tool", toolName: "book_table", toolStatus: "success", toolCallId: "c1", toolResult: "confirmed", toolOk: true, ts: 3000 },
    { role: "assistant", content: "Booked for 2 at 7pm.", ts: 4000, executionId: "exec_1" },
    { role: "user", content: "Make it 3 people instead", ts: 5000, executionId: "exec_2" },
    { role: "assistant", content: "Updated to 3 people.", ts: 6000, executionId: "exec_2" },
  ],
};

Deno.test("reopen projection: every persisted user + assistant row survives the transform, ts-ordered", () => {
  const rendered = projectThreadMessages(THREAD);
  const nonTool = rendered.filter((m) => m.role !== "tool");
  assertEquals(nonTool.length, 4, "all 4 user/assistant rows survive");
  assertEquals(nonTool.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assertEquals(nonTool.map((m) => m.content), [
    "Book a table at Le Petit Bistro",
    "Booked for 2 at 7pm.",
    "Make it 3 people instead",
    "Updated to 3 people.",
  ]);
  // ts-ordered across the merge with tool cards
  const tsSeq = rendered.map((m) => m.ts ?? 0);
  assertEquals([...tsSeq].sort((a, b) => a - b), tsSeq, "rendered list is ts-ordered");
  // the tool pair replays as exactly ONE card
  assertEquals(rendered.filter((m) => m.role === "tool").length, 1);
});

Deno.test("reopen render: the REAL <agent-conversation> setMessages emits user + assistant bubbles in order", async () => {
  await import("../extension/shared/components.js");
  const Klass = registry.get("agent-conversation");
  assert(Klass, "agent-conversation registered");
  const conv = new Klass();
  conv.setMessages(projectThreadMessages(THREAD));

  const bubbles = conv.children.filter((c) => c.tagName === "message-bubble");
  const roles = bubbles.map((b) => b.getAttribute("role"));
  const contents = bubbles.map((b) => b.getAttribute("content"));

  // The owner's requests AND the assistant's replies are all emitted...
  assert(roles.includes("user"), "user bubbles emitted");
  assertEquals(contents.filter((c) => c === "Book a table at Le Petit Bistro").length, 1, "request 1 visible");
  assertEquals(contents.filter((c) => c === "Make it 3 people instead").length, 1, "request 2 visible");
  assertEquals(contents.filter((c) => c === "Booked for 2 at 7pm.").length, 1, "reply 1 visible");
  assertEquals(contents.filter((c) => c === "Updated to 3 people.").length, 1, "reply 2 visible");
  // ...as user bubbles for the owner rows (assistant rows render as agent bubbles)...
  assertEquals(bubbles[0].getAttribute("role"), "user");
  assertEquals(bubbles[0].getAttribute("content"), "Book a table at Le Petit Bistro");
  // ...in ts order: user → tool → reply → user → reply.
  assertEquals(roles, ["user", "tool", "agent", "user", "agent"]);
});

Deno.test("reopen render: ntp.js renderThreadProjection runs the SAME transform (source pin)", async () => {
  const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  assert(ntp.includes("threadConversation.setMessages?.(projectThreadMessages(thread))"), "renderThreadProjection drives projectThreadMessages into setMessages");
  assert(ntp.includes("recordAuthoritativeThreadProjection(threadConversation"), "the authoritative-projection fence is recorded after the render");
});
