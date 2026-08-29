// tests/thread-continuation-multirun.test.ts — Multi-run thread continuation and restore test suite.
// (CAP-FB-20260824-THREAD-CONTINUATION-LOSS-01).
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createThread,
  continueThread,
  commitThreadTerminal,
  getThread,
  listThreads,
  appendThreadMessage,
} from "../extension/lib/threads.js";
import { recordAuthoritativeThreadProjection, isAuthoritativeThreadResultProjected } from "../extension/shared/thread-projection-authority.js";

// ---- in-memory OPFS fake ----
function dirNode() {
  return { kind: "directory", children: new Map() };
}
function fileNode(content) {
  return { kind: "file", content };
}
class FakeWritable {
  constructor(node) {
    this.node = node;
    this.parts = [];
  }
  async write(s) {
    this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s));
  }
  async close() {
    this.node.content = this.parts.join("");
  }
}
class FakeFileHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "file";
  }
  async getFile() {
    const node = this.node;
    return {
      size: (node.content ?? "").length,
      async text() {
        return node.content ?? "";
      },
    };
  }
  async createWritable() {
    return new FakeWritable(this.node);
  }
}
class FakeDirHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "directory";
  }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no dir ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no file ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name, opts = {}) {
    this.node.children.delete(name);
  }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}

const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
  configurable: true,
  writable: true,
});

async function waitFor(fn, label) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

Deno.test("thread continuation: intermediate tool append MUST preserve task preview in index (fails on unfixed base)", async () => {
  // Turn 1: create thread with initial task question
  const taskText = "Summarize the architectural guidelines in README.md";
  const thread = await createThread(taskText, []);
  assert(thread?.id);
  const threadId = thread.id;

  // Immediately after creation, preview is the task question
  let index = await listThreads();
  let row = index.find((r) => r.id === threadId);
  assertEquals(row.preview, taskText);

  // Append an intermediate tool execution message (tool messages carry empty content)
  await appendThreadMessage(threadId, {
    role: "tool",
    toolName: "read_file",
    toolStatus: "success",
    toolArgs: { path: "README.md" },
    toolResult: "file content...",
    toolOk: true,
    toolCallId: "call_t1_1",
  });

  // Critical assertion: preview must NOT be wiped to empty string by the tool append
  // On the unfixed base, row.preview became "" here because it read thread.messages[last].content
  index = await listThreads();
  row = index.find((r) => r.id === threadId);
  assert(row.preview.length > 0, "preview must NOT be wiped by intermediate tool append");
  assertEquals(row.preview, taskText, "preview must retain the last text turn");
});

Deno.test("thread projection: real ntp.js projection preserves user attachments in message-bubble (fails on unfixed base)", async () => {
  const threadId = "t_attach_proj";
  const attachments = [{ name: "architecture-diagram.png", type: "image/png", kind: "image" }];
  const currentThreadState = {
    id: threadId,
    name: "Attachment Task",
    messages: [
      { role: "user", content: "Inspect this diagram", attachments, ts: 1000 },
      { role: "assistant", content: "I see the architecture components", executionId: "exec_1", ts: 2000 },
    ],
    status: "done",
  };

  const elements = new Map();
  function getOrCreateElement(id, tagName = "div") {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const attributes = new Map();
    const classList = new Set();
    const children = [];
    const el = {
      id,
      tagName: tagName.toUpperCase(),
      hidden: id === "thread-view" || id === "view" || id === "durable-run-registry",
      textContent: "",
      innerHTML: "",
      style: {},
      classList: {
        add: (c) => classList.add(c),
        remove: (c) => classList.delete(c),
        toggle: (c) => classList.has(c) ? classList.delete(c) : classList.add(c),
        contains: (c) => classList.has(c),
      },
      getAttribute: (k) => attributes.get(k) ?? null,
      setAttribute: (k, v) => attributes.set(k, String(v)),
      removeAttribute: (k) => attributes.delete(k),
      hasAttribute: (k) => attributes.has(k),
      toggleAttribute: (k, force) => {
        const present = force === undefined ? !attributes.has(k) : force;
        if (present) attributes.set(k, ""); else attributes.delete(k);
        return present;
      },
      querySelector: (sel) => (sel === ".dot" ? { style: {} } : null),
      querySelectorAll: () => [],
      addEventListener: (t, fn) => {
        if (!listeners.has(t)) listeners.set(t, []);
        listeners.get(t).push(fn);
      },
      dispatchEvent: (ev) => {
        for (const fn of [...(listeners.get(ev.type) ?? [])]) fn(ev);
        return true;
      },
      append: (...nodes) => children.push(...nodes),
      appendUser: (text, ts, atts) => {
        const b = getOrCreateElement(`bubble_${Math.random().toString(36).slice(2, 8)}`, "message-bubble");
        b.setAttribute("role", "user");
        b.setAttribute("content", text);
        if (atts?.length) b.setAttribute("attachments", JSON.stringify(atts));
        children.push(b);
        return b;
      },
      appendAgent: (text) => {
        const b = getOrCreateElement(`bubble_${Math.random().toString(36).slice(2, 8)}`, "message-bubble");
        b.setAttribute("role", "agent");
        b.setAttribute("content", text);
        children.push(b);
        return b;
      },
      appendChild: (n) => { children.push(n); return n; },
      replaceChildren: (...nodes) => { children.splice(0, children.length, ...nodes); },
      clear: () => { children.length = 0; },
      setMessages: (msgs) => {
        children.splice(0, children.length);
        for (const m of msgs) {
          if (m.role === "user") el.appendUser(m.content, m.ts, m.attachments);
          else el.appendAgent(m.content, m.ts);
        }
      },
      get children() { return children; },
    };
    elements.set(id, el);
    return el;
  }

  const knownIds = [
    "status", "durable-run-registry", "site-agents", "webmcp-hub-status",
    "named-agents", "side-agents", "background-agents", "agent-count",
    "artifacts", "run-log", "hub-usage", "thread-sidebar", "thread-view",
    "thread-title", "thread-conversation", "thread-composer", "edit-agent",
    "composer", "thread-back", "provider-status", "side",
    "side-toggle", "sidebar-durability-hint", "new-task", "new-agent",
    "view", "view-frame", "view-title", "view-back", "open-settings",
    "open-directory", "open-artifacts", "artifact-quick-drawer", "bg-configure", "browse-artifacts",
    "discover-page",
  ];
  for (const id of knownIds) getOrCreateElement(id);

  (globalThis as any).document = {
    getElementById: (id) => getOrCreateElement(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => getOrCreateElement(`dyn_${Math.random().toString(36).slice(2, 8)}`, tag),
    documentElement: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    startViewTransition: (u) => { u(); return { finished: Promise.resolve() }; },
  };
  (globalThis as any).window = globalThis;
  (globalThis as any).matchMedia = () => ({ matches: false });
  (globalThis as any).HTMLElement = class HTMLElement {};
  (globalThis as any).customElements = { define() {} };
  (globalThis as any).location = { hash: "" };
  (globalThis as any).chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(msg, cb) {
        if (msg.type === "provider.permission-summary") { queueMicrotask(() => cb({ ok: true, local: true })); return; }
        if (msg.type === "thread.get") { queueMicrotask(() => cb({ ok: true, thread: currentThreadState })); return; }
        if (msg.type === "thread.list") { queueMicrotask(() => cb({ ok: true, threads: [currentThreadState] })); return; }
        if (msg.type === "named-agent.list") { queueMicrotask(() => cb({ ok: true, agents: [] })); return; }
        if (msg.type === "agent.list") { queueMicrotask(() => cb({ ok: true, origins: [] })); return; }
        if (msg.type === "background-agent.list") { queueMicrotask(() => cb({ ok: true, recipes: [] })); return; }
        if (msg.type === "asset.list") { queueMicrotask(() => cb({ ok: true, assets: [] })); return; }
        if (msg.type === "memory.get") { queueMicrotask(() => cb([])); return; }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener() {} },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: { contains: () => Promise.resolve(true) },
  };

  // Drive real ntp.js module projection through openThread
  await import(`../extension/ntp/ntp.js?exec=${Date.now()}`);

  const sidebar = getOrCreateElement("thread-sidebar");
  const threadConv = getOrCreateElement("thread-conversation");

  await waitFor(() => sidebar.children.some((c) => c.className === "thread-item"), "sidebar task item");
  const taskRow = sidebar.children.find((c) => c.className === "thread-item");
  (taskRow.children.find((c: any) => c.className === "t-open") ?? taskRow.children[0]).dispatchEvent({ type: "click" });
  await waitFor(() => getOrCreateElement("thread-view").hidden === false, "thread view open");

  assertEquals(threadConv.children.length, 2);
  const userBubble = threadConv.children[0];
  assertEquals(userBubble.getAttribute("role"), "user");
  assertEquals(userBubble.getAttribute("content"), "Inspect this diagram");
  const attsAttr = userBubble.getAttribute("attachments");
  // Critical assertion: on unfixed base, renderThreadProjection omitted attachments mapping, so attsAttr is null
  assert(attsAttr !== null, "user bubble must carry attachments attribute from real renderThreadProjection");
  const parsedAtts = JSON.parse(attsAttr);
  assertEquals(parsedAtts[0].name, "architecture-diagram.png");
});

Deno.test("thread continuation: multi-run persistence preserves all turns across leave and return", async () => {
  // Turn 1: Create thread and commit terminal assistant result
  const thread = await createThread("First user question", []);
  assert(thread?.id);
  const threadId = thread.id;

  await commitThreadTerminal(threadId, "exec_turn_1", {
    role: "assistant",
    content: "First assistant answer",
  });

  const afterTurn1 = await getThread(threadId);
  assertEquals(afterTurn1?.messages?.length, 2);
  assertEquals(afterTurn1?.messages?.[0].content, "First user question");
  assertEquals(afterTurn1?.messages?.[1].content, "First assistant answer");

  // Turn 2: Continue thread with second question and commit terminal result
  const contRes = await continueThread(threadId, "Second follow-up question", []);
  assertEquals(contRes.thread?.id, threadId);
  assertEquals(contRes.history?.length, 2, "history passed to model must include prior 2 turns");

  // Simulate tool calls during Turn 2
  await appendThreadMessage(threadId, {
    role: "tool",
    toolName: "fetch_data",
    toolStatus: "success",
    toolResult: "dataset_v1",
    toolOk: true,
    toolCallId: "call_turn2_1",
  });

  await commitThreadTerminal(threadId, "exec_turn_2", {
    role: "assistant",
    content: "Second assistant answer with data",
  });

  // Turn 3: Continue thread with third question (e.g. from elsewhere)
  const contRes3 = await continueThread(threadId, "Third follow-up question", []);
  assertEquals(contRes3.history?.length, 4, "history passed to model must include prior user + assistant turns");

  await commitThreadTerminal(threadId, "exec_turn_3", {
    role: "assistant",
    content: "Third assistant answer",
  });

  // Simulated return: getThread must contain ALL 6 message turns + tool cards
  const finalThread = await getThread(threadId);
  assert(finalThread);
  assertEquals(finalThread.status, "done");

  const nonToolMessages = finalThread.messages.filter((m) => m.role !== "tool");
  assertEquals(nonToolMessages.length, 6, "must have 3 user turns and 3 assistant turns");

  assertEquals(nonToolMessages[0].role, "user");
  assertEquals(nonToolMessages[0].content, "First user question");

  assertEquals(nonToolMessages[1].role, "assistant");
  assertEquals(nonToolMessages[1].content, "First assistant answer");

  assertEquals(nonToolMessages[2].role, "user");
  assertEquals(nonToolMessages[2].content, "Second follow-up question");

  assertEquals(nonToolMessages[3].role, "assistant");
  assertEquals(nonToolMessages[3].content, "Second assistant answer with data");

  assertEquals(nonToolMessages[4].role, "user");
  assertEquals(nonToolMessages[4].content, "Third follow-up question");

  assertEquals(nonToolMessages[5].role, "assistant");
  assertEquals(nonToolMessages[5].content, "Third assistant answer");

  const toolMessages = finalThread.messages.filter((m) => m.role === "tool");
  assertEquals(toolMessages.length, 1);
  assertEquals(toolMessages[0].toolName, "fetch_data");

  // Thread index reflects updated preview, status, and message count
  const index = await listThreads();
  const indexRow = index.find((r) => r.id === threadId);
  assert(indexRow);
  assertEquals(indexRow.count, 7); // 6 text + 1 tool
  assertEquals(indexRow.status, "done");
  assert(indexRow.preview.includes("Third assistant answer"));
});

Deno.test("thread projection authority: deduplicates already projected terminal results without hiding subsequent turns", () => {
  const container = {};
  const ownerToken = 42;
  const threadId = "t_dedupe_test";

  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world", executionId: "exec_1" },
  ];

  recordAuthoritativeThreadProjection(container, {
    threadId,
    owner: ownerToken,
    generation: 1,
    messages,
  });

  // Exactly matching result from exec_1 is flagged as already projected
  assertEquals(
    isAuthoritativeThreadResultProjected(container, {
      threadId,
      executionId: "exec_1",
      owner: ownerToken,
      content: "world",
    }),
    true,
  );

  // Different executionId (Turn 2) is NOT flagged as already projected
  assertEquals(
    isAuthoritativeThreadResultProjected(container, {
      threadId,
      executionId: "exec_2",
      owner: ownerToken,
      content: "world",
    }),
    false,
  );

  // Different content on Turn 1 is NOT suppressed
  assertEquals(
    isAuthoritativeThreadResultProjected(container, {
      threadId,
      executionId: "exec_1",
      owner: ownerToken,
      content: "world revised",
    }),
    false,
  );
});

Deno.test("multi-run leave-and-return in ntp: leaves task view, runs turn 2, returns and renders ALL turns", async () => {
  const threadId = "t_multirun_ntp";
  const messages = [
    { role: "user", content: "Run 1 user query", ts: 1000 },
    { role: "assistant", content: "Run 1 assistant result", executionId: "exec_1", ts: 2000 },
  ];
  let currentThreadState = {
    id: threadId,
    name: "Multi-run Task",
    messages: [...messages],
    status: "done",
  };

  const elements = new Map();
  function getOrCreateElement(id, tagName = "div") {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const attributes = new Map();
    const classList = new Set();
    const children = [];
    const el = {
      id,
      tagName: tagName.toUpperCase(),
      hidden: id === "thread-view" || id === "view" || id === "durable-run-registry",
      textContent: "",
      innerHTML: "",
      style: {},
      classList: {
        add: (c) => classList.add(c),
        remove: (c) => classList.delete(c),
        toggle: (c) => classList.has(c) ? classList.delete(c) : classList.add(c),
        contains: (c) => classList.has(c),
      },
      getAttribute: (k) => attributes.get(k) ?? null,
      setAttribute: (k, v) => attributes.set(k, String(v)),
      removeAttribute: (k) => attributes.delete(k),
      hasAttribute: (k) => attributes.has(k),
      toggleAttribute: (k, force) => {
        const present = force === undefined ? !attributes.has(k) : force;
        if (present) attributes.set(k, ""); else attributes.delete(k);
        return present;
      },
      querySelector: (sel) => (sel === ".dot" ? { style: {} } : null),
      querySelectorAll: () => [],
      addEventListener: (t, fn) => {
        if (!listeners.has(t)) listeners.set(t, []);
        listeners.get(t).push(fn);
      },
      dispatchEvent: (ev) => {
        for (const fn of [...(listeners.get(ev.type) ?? [])]) fn(ev);
        return true;
      },
      append: (...nodes) => children.push(...nodes),
      appendChild: (n) => { children.push(n); return n; },
      replaceChildren: (...nodes) => { children.splice(0, children.length, ...nodes); },
      clear: () => { children.length = 0; },
      setMessages: (msgs) => { children.splice(0, children.length, ...msgs); },
      get children() { return children; },
    };
    elements.set(id, el);
    return el;
  }

  const knownIds = [
    "status", "durable-run-registry", "site-agents", "webmcp-hub-status",
    "named-agents", "side-agents", "background-agents", "agent-count",
    "artifacts", "run-log", "hub-usage", "thread-sidebar", "thread-view",
    "thread-title", "thread-conversation", "thread-composer", "edit-agent",
    "composer", "thread-back", "provider-status", "side",
    "side-toggle", "sidebar-durability-hint", "new-task", "new-agent",
    "view", "view-frame", "view-title", "view-back", "open-settings",
    "open-directory", "open-artifacts", "artifact-quick-drawer", "bg-configure", "browse-artifacts",
    "discover-page",
  ];
  for (const id of knownIds) getOrCreateElement(id);

  let portListener = null;
  (globalThis as any).document = {
    getElementById: (id) => getOrCreateElement(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => getOrCreateElement(`dyn_${Math.random().toString(36).slice(2, 8)}`, tag),
    documentElement: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    startViewTransition: (u) => { u(); return { finished: Promise.resolve() }; },
  };
  (globalThis as any).window = globalThis;
  (globalThis as any).matchMedia = () => ({ matches: false });
  (globalThis as any).HTMLElement = class HTMLElement {};
  (globalThis as any).customElements = { define() {} };
  (globalThis as any).location = { hash: "" };
  (globalThis as any).chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(msg, cb) {
        if (msg.type === "provider.permission-summary") { queueMicrotask(() => cb({ ok: true, local: true })); return; }
        if (msg.type === "thread.get") { queueMicrotask(() => cb({ ok: true, thread: currentThreadState })); return; }
        if (msg.type === "thread.list") { queueMicrotask(() => cb({ ok: true, threads: [currentThreadState] })); return; }
        if (msg.type === "named-agent.list") { queueMicrotask(() => cb({ ok: true, agents: [] })); return; }
        if (msg.type === "agent.list") { queueMicrotask(() => cb({ ok: true, origins: [] })); return; }
        if (msg.type === "background-agent.list") { queueMicrotask(() => cb({ ok: true, recipes: [] })); return; }
        if (msg.type === "asset.list") { queueMicrotask(() => cb({ ok: true, assets: [] })); return; }
        if (msg.type === "memory.get") { queueMicrotask(() => cb([])); return; }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener(fn) { portListener = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: { contains: () => Promise.resolve(true) },
  };

  await import(`../extension/ntp/ntp.js?exec=${Date.now()}`);

  const sidebar = getOrCreateElement("thread-sidebar");
  const threadView = getOrCreateElement("thread-view");
  const threadBack = getOrCreateElement("thread-back");
  const threadConv = getOrCreateElement("thread-conversation");

  // 1. Initial open of Thread 1 (after Run 1)
  await waitFor(() => sidebar.children.some((c) => c.className === "thread-item"), "sidebar task item");
  const taskRow = sidebar.children.find((c) => c.className === "thread-item");
  (taskRow.children.find((c: any) => c.className === "t-open") ?? taskRow.children[0]).dispatchEvent({ type: "click" });
  await waitFor(() => threadView.hidden === false, "thread view open");

  assertEquals(threadConv.children.length, 2, "Turn 1 user + agent bubbles rendered");
  assertEquals(threadConv.children[0].content, "Run 1 user query");
  assertEquals(threadConv.children[1].content, "Run 1 assistant result");

  // 2. User LEAVES task view (clicks back)
  threadBack.dispatchEvent({ type: "click" });
  assertEquals(threadView.hidden, true, "thread view is closed");
  assertEquals(threadConv.children.length, 0, "conversation DOM cleared on leaving view");

  // 3. While away: Turn 2 executes and commits to thread storage
  currentThreadState = {
    ...currentThreadState,
    messages: [
      ...messages,
      { role: "user", content: "Run 2 follow-up query", ts: 3000 },
      { role: "assistant", content: "Run 2 assistant result", executionId: "exec_2", ts: 4000 },
    ],
  };

  // 4. User RETURNS to task view (clicks task row in sidebar again)
  (taskRow.children.find((c: any) => c.className === "t-open") ?? taskRow.children[0]).dispatchEvent({ type: "click" });
  await waitFor(() => threadView.hidden === false, "thread view reopened");

  assertEquals(threadConv.children.length, 4, "BOTH Turn 1 and Turn 2 are fully rendered on return");
  assertEquals(threadConv.children[0].content, "Run 1 user query");
  assertEquals(threadConv.children[1].content, "Run 1 assistant result");
  assertEquals(threadConv.children[2].content, "Run 2 follow-up query");
  assertEquals(threadConv.children[3].content, "Run 2 assistant result");
});

Deno.test("reload parity at #thread: boot route restore renders all conversation turns from thread authority", async () => {
  const threadId = "t_reload_parity";
  const currentThreadState = {
    id: threadId,
    name: "Reload Parity Task",
    messages: [
      { role: "user", content: "Original prompt", ts: 1000 },
      { role: "assistant", content: "Original answer", executionId: "exec_r1", ts: 2000 },
      { role: "user", content: "Follow-up question", ts: 3000 },
      { role: "assistant", content: "Follow-up answer", executionId: "exec_r2", ts: 4000 },
    ],
    status: "done",
  };

  const elements = new Map();
  function getOrCreateElement(id, tagName = "div") {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const attributes = new Map();
    const classList = new Set();
    const children = [];
    const el = {
      id,
      tagName: tagName.toUpperCase(),
      hidden: id === "thread-view" || id === "view" || id === "durable-run-registry",
      textContent: "",
      innerHTML: "",
      style: {},
      classList: {
        add: (c) => classList.add(c),
        remove: (c) => classList.delete(c),
        toggle: (c) => classList.has(c) ? classList.delete(c) : classList.add(c),
        contains: (c) => classList.has(c),
      },
      getAttribute: (k) => attributes.get(k) ?? null,
      setAttribute: (k, v) => attributes.set(k, String(v)),
      removeAttribute: (k) => attributes.delete(k),
      hasAttribute: (k) => attributes.has(k),
      toggleAttribute: (k, force) => {
        const present = force === undefined ? !attributes.has(k) : force;
        if (present) attributes.set(k, ""); else attributes.delete(k);
        return present;
      },
      querySelector: (sel) => (sel === ".dot" ? { style: {} } : null),
      querySelectorAll: () => [],
      addEventListener: (t, fn) => {
        if (!listeners.has(t)) listeners.set(t, []);
        listeners.get(t).push(fn);
      },
      dispatchEvent: (ev) => {
        for (const fn of [...(listeners.get(ev.type) ?? [])]) fn(ev);
        return true;
      },
      append: (...nodes) => children.push(...nodes),
      appendChild: (n) => { children.push(n); return n; },
      replaceChildren: (...nodes) => { children.splice(0, children.length, ...nodes); },
      clear: () => { children.length = 0; },
      setMessages: (msgs) => { children.splice(0, children.length, ...msgs); },
      get children() { return children; },
    };
    elements.set(id, el);
    return el;
  }

  const knownIds = [
    "status", "durable-run-registry", "site-agents", "webmcp-hub-status",
    "named-agents", "side-agents", "background-agents", "agent-count",
    "artifacts", "run-log", "hub-usage", "thread-sidebar", "thread-view",
    "thread-title", "thread-conversation", "thread-composer", "edit-agent",
    "composer", "thread-back", "provider-status", "side",
    "side-toggle", "sidebar-durability-hint", "new-task", "new-agent",
    "view", "view-frame", "view-title", "view-back", "open-settings",
    "open-directory", "open-artifacts", "artifact-quick-drawer", "bg-configure", "browse-artifacts",
    "discover-page",
  ];
  for (const id of knownIds) getOrCreateElement(id);

  // Set location.hash to simulate browser reload on #thread=t_reload_parity
  (globalThis as any).location = { hash: `#thread=${threadId}` };
  (globalThis as any).history = { state: { route: "thread", id: threadId } };

  (globalThis as any).document = {
    getElementById: (id) => getOrCreateElement(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => getOrCreateElement(`dyn_${Math.random().toString(36).slice(2, 8)}`, tag),
    documentElement: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    startViewTransition: (u) => { u(); return { finished: Promise.resolve() }; },
  };

  (globalThis as any).chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(msg, cb) {
        if (msg.type === "provider.permission-summary") { queueMicrotask(() => cb({ ok: true, local: true })); return; }
        if (msg.type === "thread.get") { queueMicrotask(() => cb({ ok: true, thread: currentThreadState })); return; }
        if (msg.type === "thread.list") { queueMicrotask(() => cb({ ok: true, threads: [currentThreadState] })); return; }
        if (msg.type === "named-agent.list") { queueMicrotask(() => cb({ ok: true, agents: [] })); return; }
        if (msg.type === "agent.list") { queueMicrotask(() => cb({ ok: true, origins: [] })); return; }
        if (msg.type === "background-agent.list") { queueMicrotask(() => cb({ ok: true, recipes: [] })); return; }
        if (msg.type === "asset.list") { queueMicrotask(() => cb({ ok: true, assets: [] })); return; }
        if (msg.type === "memory.get") { queueMicrotask(() => cb([])); return; }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener() {} },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: { contains: () => Promise.resolve(true) },
  };

  // Boot NTP with hash route active
  await import(`../extension/ntp/ntp.js?exec=${Date.now()}`);

  const threadView = getOrCreateElement("thread-view");
  const threadTitle = getOrCreateElement("thread-title");
  const threadConv = getOrCreateElement("thread-conversation");

  await waitFor(() => threadView.hidden === false, "thread view open on reload");

  assertEquals(threadTitle.textContent, "Reload Parity Task", "task title restored on reload");
  assertEquals(threadConv.children.length, 4, "all 4 turns restored on reload");
  assertEquals(threadConv.children[0].content, "Original prompt");
  assertEquals(threadConv.children[1].content, "Original answer");
  assertEquals(threadConv.children[2].content, "Follow-up question");
  assertEquals(threadConv.children[3].content, "Follow-up answer");
});
