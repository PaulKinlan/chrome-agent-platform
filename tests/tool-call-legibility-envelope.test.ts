// @ts-nocheck — the card DOM is built imperatively against a minimal fake DOM.
// tests/tool-call-legibility-envelope.test.ts —
// CAP-FB-20260827-TOOL-CALL-LEGIBILITY-01 items 2b, 9 and 10.
//
// The lazy tool protocol wraps every real call: `execute_tool` returns
// {modelContent:"{\"ok\":true,\"selectedTool\":…,\"result\":…,\"schemaSummary\":…}"}
// and `search_tools` returns a catalogue with `catalogGeneration` + `stableId`.
// None of that is the owner's business. These tests pin:
//   (9)  the card renders the TOOL'S OWN result — tree, raw JSON view, error
//        block and head — never the envelope; protocol cards are not rendered;
//   (10) the transport vocabulary is absent from every piece of card text;
//   (2b) a persisted permission denial reopens as the in-context grant card.
// Each assertion was observed RED on origin/main@18b9799f before the fix.
import { assert, assertEquals } from "jsr:@std/assert";

// ── a minimal fake DOM (attributes, children, text, listeners) ─────────────
class ElementStub {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.hidden = false;
    this.open = false;
    this.dataset = {};
    this.listeners = new Map();
    this.parentNode = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  hasAttribute(n) { return this.attrs.has(n); }
  removeAttribute(n) { this.attrs.delete(n); }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  insertBefore(c, ref) {
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    c.parentNode = this;
    return c;
  }
  replaceChildren() { this.children = []; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatchEvent(ev) {
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
    if (ev.bubbles && this.parentNode) this.parentNode.dispatchEvent(ev);
    return true;
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  get isConnected() { return true; }
}
class HTMLElementStub extends ElementStub {
  constructor() { super("stub"); }
  attachShadow() { return new ElementStub("shadow-root"); }
}
const registry = new Map();
globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; this.bubbles = init.bubbles === true; }
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.navigator = {};
globalThis.document = {
  createElement: (tag) => {
    const Cls = registry.get(String(tag));
    if (Cls) {
      const el = new Cls();
      el.tagName = String(tag).toUpperCase();
      return el;
    }
    return new ElementStub(tag);
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  body: new ElementStub("body"),
  documentElement: new ElementStub("html"),
  execCommand: () => false,
  activeElement: null,
};

const components = await import("../extension/shared/components.js");
const conversation = await import("../extension/shared/conversation.js");
const { buildToolCardDom } = components;
const { toolRowsFromRunLog, projectThreadMessages } = conversation;

/** Every string the card can show — text nodes, titles, raw <pre> views. */
function allText(el, out = []) {
  if (!el) return out;
  if (el.textContent) out.push(String(el.textContent));
  if (el.title) out.push(String(el.title));
  for (const c of el.children ?? []) allText(c, out);
  return out;
}
function findAll(el, pred, out = []) {
  if (!el) return out;
  if (pred(el)) out.push(el);
  for (const c of el.children ?? []) findAll(c, pred, out);
  return out;
}
const LEAK = ["modelContent", "catalogGeneration", "stableId", "schemaSummary", "search_tools", "execute_tool", "selectionRef", "requiresLiveAuthorization"];
const leaksIn = (texts) => LEAK.filter((s) => texts.some((t) => t.includes(s)));

// ── fixtures: the envelopes exactly as the runtime emits them ──────────────
const SCHEMA = JSON.stringify({ oneOf: [{ type: "object" }, { type: "array" }, { type: "string" }] });
/** A successful execute_tool → memory_set, as the live event carries it. */
const LIVE_SUCCESS = JSON.stringify({
  modelContent: JSON.stringify({
    ok: true,
    selectedTool: "memory_set",
    result: { ok: true, key: "demo", bytes: 12 },
    schemaSummary: SCHEMA,
    selectionRef: "sel_48a5b187ad9ab795eecbb289c7f0c5aae400",
    authorizes: false,
    requiresLiveAuthorization: true,
    replay: { safety: "idempotent" },
  }),
  authorizes: false,
  requiresLiveAuthorization: true,
});
/** The same call as the run log persists it (modelContent already decoded). */
const LOG_SUCCESS = JSON.stringify({
  ok: true,
  selectedTool: "memory_set",
  result: { ok: true, key: "demo", bytes: 12 },
  schemaSummary: SCHEMA,
  selectionRef: "sel_48a5b187ad9ab795eecbb289c7f0c5aae400",
  authorizes: false,
  requiresLiveAuthorization: true,
  replay: { safety: "idempotent" },
});
/** A failed delegate_task, as the tools lane screenshot showed it. */
const LIVE_ERROR = JSON.stringify({
  modelContent: JSON.stringify({
    ok: true,
    selectedTool: "delegate_task",
    result: { error: "no agent for demo-site" },
    schemaSummary: SCHEMA,
    selectionRef: "sel_1",
    authorizes: false,
    requiresLiveAuthorization: true,
  }),
});
/** The truncated summary string the live path stored in tool-result. */
const TRUNCATED_SUMMARY = LIVE_ERROR.slice(0, 120) + "…";
/** A search_tools catalogue result. */
const SEARCH_RESULT = JSON.stringify({
  ok: true,
  catalogGeneration: "92f3a1b2c3d4",
  results: [{ stableId: "tool:v1:memory_set", name: "memory_set", selectionRef: "sel_2", schemaSummary: SCHEMA }],
});
/** A structured permission denial, wrapped by the lazy protocol as persisted. */
const DENIAL_INNER = {
  ok: false,
  error: "tabs permission not granted — allow it in the approval card here, or in Settings → Permissions",
  waitingForPermission: true,
  permissionRequirement: { reason: "list your open tabs", permissions: ["tabs"], grantOrigins: [], grantGlobal: false },
};
const LOG_DENIAL = JSON.stringify({ ok: true, selectedTool: "list_tabs", result: DENIAL_INNER, schemaSummary: SCHEMA, selectionRef: "sel_3" });

// ── (9)/(10): the renderer ──────────────────────────────────────────────────
Deno.test("legibility: a live error card shows the tool's own error, never the envelope (tree, raw, plain)", () => {
  const card = buildToolCardDom({
    name: "delegate_task", status: "error", args: '{"agentId":"demo-site"}',
    result: TRUNCATED_SUMMARY, detail: LIVE_ERROR, duration: "1100", expandedState: new Map(),
  });
  const texts = allText(card);
  assertEquals(leaksIn(texts), [], `leaked: ${leaksIn(texts).join(",")}\n${texts.join("\n")}`);
  assert(texts.some((t) => t.includes("no agent for demo-site")), "the tool's own error text must be shown");
});

Deno.test("legibility: a live success card renders the selected tool's result — tree AND raw JSON view unwrapped", () => {
  const card = buildToolCardDom({
    name: "memory_set", status: "done", args: '{"key":"demo","value":"x"}',
    result: "done", detail: LIVE_SUCCESS, duration: "12", expandedState: new Map(),
  });
  const texts = allText(card);
  assertEquals(leaksIn(texts), [], `leaked: ${leaksIn(texts).join(",")}`);
  const raws = findAll(card, (e) => e.className === "tt-raw");
  assert(raws.length >= 1, "a raw JSON view exists for the result block");
  for (const pre of raws) {
    assert(!/selectedTool|schemaSummary|selectionRef|replay|authorizes/.test(pre.textContent), `raw view leaks the envelope: ${pre.textContent}`);
  }
  assert(texts.some((t) => t === "bytes" || t.includes("bytes")), "the inner result's own field is rendered");
});

Deno.test("legibility: a reopened (run-log) card with the decoded envelope is unwrapped the same way, and execute_tool is headed by the selected tool", () => {
  const card = buildToolCardDom({
    name: "execute_tool", status: "done", args: '{"key":"demo"}',
    result: LOG_SUCCESS, detail: null, duration: null, expandedState: new Map(),
  });
  const texts = allText(card);
  assertEquals(leaksIn(texts), [], `leaked: ${leaksIn(texts).join(",")}`);
  const head = findAll(card, (e) => e.className === "tool-name")[0];
  assertEquals(head?.textContent, "memory_set");
});

Deno.test("legibility: a still-running execute_tool card never shows the protocol name", () => {
  const card = buildToolCardDom({ name: "execute_tool", status: "running", args: '{"selectionRef":"sel_9","arguments":{"key":"demo"}}', result: null, detail: null, expandedState: new Map() });
  const texts = allText(card);
  assertEquals(leaksIn(texts), [], `leaked: ${leaksIn(texts).join(",")}`);
});

// ── (9): protocol cards are not work ────────────────────────────────────────
const LOGS = [
  { type: "tool-call", callId: "c1", tool: "search_tools", args: '{"query":"memory_set","limit":1}', at: 1000 },
  { type: "tool-result", callId: "c1", tool: "search_tools", result: SEARCH_RESULT, ok: true, at: 1100 },
  { type: "tool-call", callId: "c2", tool: "execute_tool", args: '{"selectionRef":"sel_2","arguments":{"key":"demo","value":"x"}}', at: 1200 },
  { type: "tool-result", callId: "c2", tool: "execute_tool", result: LOG_SUCCESS, ok: true, selectedTool: "memory_set", at: 1300 },
  { type: "tool-call", callId: "c3", tool: "execute_tool", args: '{"selectionRef":"sel_3","arguments":{}}', at: 1400 },
  { type: "tool-result", callId: "c3", tool: "execute_tool", result: LOG_DENIAL, ok: false, selectedTool: "list_tabs", at: 1500 },
  { type: "tool-call", callId: "c4", tool: "execute_tool", args: '{"selectionRef":"sel_3","arguments":{}}', at: 1600 },
  { type: "tool-result", callId: "c4", tool: "execute_tool", result: LOG_DENIAL, ok: false, selectedTool: "list_tabs", at: 1700 },
];
/** The shape the run ACTUALLY persists after the owner's inline decision: the
 * model-facing result was rewritten to prose ("Owner denied…"), and the
 * structured requirement rides on the row itself. */
const PAUSED_LOGS = [
  { type: "tool-call", callId: "p1", tool: "execute_tool", args: '{"selectionRef":"sel_3","arguments":{}}', at: 1000 },
  { type: "tool-result", callId: "p1", tool: "execute_tool", result: "[list_tabs] DENIED by owner", ok: false, selectedTool: "list_tabs", at: 1100,
    permissionRequirement: { reason: "list your open tabs", permissions: ["tabs"], grantOrigins: [], grantGlobal: false }, permissionDecision: "denied" },
  { type: "tool-call", callId: "p2", tool: "execute_tool", args: '{"selectionRef":"sel_4","arguments":{"url":"https://a.com/"}}', at: 1200 },
  { type: "tool-result", callId: "p2", tool: "execute_tool", result: "[open_tab] BLOCKED — approved; retry required", ok: false, selectedTool: "open_tab", at: 1300,
    permissionRequirement: { reason: "open https://a.com/ in a new tab", permissions: [], grantOrigins: ["https://a.com"], grantGlobal: false }, permissionDecision: "approved" },
];

Deno.test("legibility: the requirement persisted on a paused row derives the card — declined stays declined (sticky), approved reopens granted", () => {
  const rows = toolRowsFromRunLog("exec_2", PAUSED_LOGS);
  const approvals = rows.filter((r) => r.role === "approval");
  assertEquals(approvals.length, 2);
  assertEquals(approvals[0].requirement.permissions, ["tabs"]);
  assertEquals(approvals[0].state, "denied", "a declined decision never reopens as a pending Allow (deny is sticky)");
  assertEquals(approvals[1].requirement.grantOrigins, ["https://a.com"]);
  assertEquals(approvals[1].state, "granted");
  const out = projectThreadMessages({ id: "t2", messages: [
    { role: "user", content: "open a.com", ts: 900, executionId: "exec_2" }, ...rows,
    { role: "assistant", content: "done", ts: 2000, executionId: "exec_2" },
  ] });
  assertEquals(out.filter((m) => m.role === "approval").map((m) => m.state ?? null), ["denied", "granted"]);
  // A denial that never paused the run (no decision recorded) is still grantable.
  const undecided = toolRowsFromRunLog("exec_3", LOGS).filter((r) => r.role === "approval");
  assertEquals(undecided.length, 1);
  assertEquals(undecided[0].state, undefined);
});

Deno.test("legibility: toolRowsFromRunLog marks search_tools rows as protocol", () => {
  const rows = toolRowsFromRunLog("exec_1", LOGS);
  const search = rows.find((r) => r.role === "tool" && r.toolName === "search_tools");
  assert(search, "the run log still lists the protocol call");
  assertEquals(search.protocol, true);
  const work = rows.find((r) => r.role === "tool" && r.toolName === "memory_set");
  assert(work && work.protocol !== true, "a real tool row is not protocol");
});

// ── (2b): the persisted half of the grant card ──────────────────────────────
Deno.test("legibility: a persisted denial derives ONE approval row (per requirement) right after its tool row", () => {
  const rows = toolRowsFromRunLog("exec_1", LOGS);
  const approvals = rows.filter((r) => r.role === "approval");
  assertEquals(approvals.length, 1, `two identical denials must collapse to one card, got ${approvals.length}`);
  const a = approvals[0];
  assertEquals(a.requirement.permissions, ["tabs"]);
  assertEquals(a.requirement.reason, "list your open tabs");
  assertEquals(a.executionId, "exec_1");
  assertEquals(a.toolCallId, "c3");
  const idx = rows.indexOf(a);
  assertEquals(rows[idx - 1]?.role, "tool");
  assertEquals(rows[idx - 1]?.toolName, "list_tabs");
});

Deno.test("legibility: projectThreadMessages keeps approval rows in their turn and drops protocol tool rows", () => {
  const thread = {
    id: "t1",
    messages: [
      { role: "user", content: "list my tabs", ts: 900, executionId: "exec_1" },
      ...toolRowsFromRunLog("exec_1", LOGS),
      { role: "assistant", content: "I could not list your tabs: the tabs permission was not granted.", ts: 2000, executionId: "exec_1" },
    ],
  };
  const out = projectThreadMessages(thread);
  const roles = out.map((m) => m.role);
  assert(!out.some((m) => m.role === "tool" && m.name === "search_tools"), `protocol card projected: ${JSON.stringify(roles)}`);
  const approvalIdx = out.findIndex((m) => m.role === "approval");
  assert(approvalIdx > 0, `no approval row projected: ${JSON.stringify(roles)}`);
  assertEquals(out[out.length - 1].role, "assistant", "the turn still ends on its terminal");
  assert(out.slice(0, approvalIdx).some((m) => m.role === "tool" && m.name === "list_tabs"), "the approval follows the denied call");
});

Deno.test("legibility: <agent-conversation> renders an approval row as ONE grant card that emits approval-decision on Allow", () => {
  const Conv = registry.get("agent-conversation");
  assert(Conv, "agent-conversation is registered");
  const conv = new Conv();
  conv.tagName = "AGENT-CONVERSATION";
  const requirement = { reason: "list your open tabs", permissions: ["tabs"], grantOrigins: [], grantGlobal: false, approvals: [], key: "tabs|" };
  conv.setMessages([
    { role: "user", content: "list my tabs", ts: 900 },
    { role: "tool", name: "search_tools", status: "success", args: null, result: SEARCH_RESULT, ts: 1000, protocol: true },
    { role: "tool", name: "list_tabs", status: "error", args: "{}", result: LOG_DENIAL, ts: 1500 },
    { role: "approval", requirement, executionId: "exec_1", toolCallId: "c3", ts: 1500 },
    { role: "approval", requirement, executionId: "exec_1", toolCallId: "c4", ts: 1700 },
    { role: "assistant", content: "done", ts: 2000 },
  ]);
  const bubbles = conv.children.filter((c) => c.tagName === "MESSAGE-BUBBLE");
  const toolBubbles = bubbles.filter((b) => b.getAttribute("role") === "tool");
  assertEquals(toolBubbles.length, 1, "the protocol row renders no bubble");
  assertEquals(toolBubbles[0].getAttribute("tool-name"), "list_tabs");
  const cards = conv.children.filter((c) => c.tagName === "PERMISSION-APPROVAL-CARD");
  assertEquals(cards.length, 1, "one card per distinct requirement");
  assertEquals(cards[0].getAttribute("permissions"), JSON.stringify(["tabs"]));
  assertEquals(cards[0].getAttribute("reason"), "list your open tabs");
  let decision = null;
  conv.addEventListener("approval-decision", (ev) => { decision = ev.detail; });
  cards[0].dispatchEvent(new CustomEvent("approve", { detail: { sourceEvent: { isTrusted: true } } }));
  assert(decision, "Allow on the card reaches the surface that can grant");
  assertEquals(decision.approve, true);
  assertEquals(decision.requirement.permissions, ["tabs"]);
  assertEquals(decision.executionId, "exec_1");
  assertEquals(decision.card, cards[0]);
});
