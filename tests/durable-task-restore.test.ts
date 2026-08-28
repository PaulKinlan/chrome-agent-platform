// @ts-nocheck
// CAP-FB-20260823-DURABLE-TASK-RESTORE-01 — leave-and-return restore of the
// live task view. Drives the REAL extension/ntp/ntp.js with the house DOM +
// chrome stub pattern (see conversation-run-sequence.test.ts): a task whose
// run is executing must, on return to the task view, restore the transcript
// (persisted journal replay + live projection re-attach), the status banner,
// and the run controls; completed/failed tasks show terminal state; no
// duplicate or lost runs. Harness elements are per-test; conversation.js
// module state (port, run records) is shared — each test uses distinct
// thread/execution ids and a run-snapshot injection (which clears records).
import { assert, assertEquals } from "jsr:@std/assert@1";

const portState: { listener: ((msg: unknown) => void) | null } = { listener: null };

function makeHarness({ thread, threads, runs }) {
  const elements = new Map<string, any>();
  function getOrCreateElement(id: string, tagName = "div") {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map<string, Array<(ev: any) => void>>();
    const attributes = new Map<string, string>();
    const classList = new Set<string>();
    const children: any[] = [];
    const el = {
      id,
      tagName: tagName.toUpperCase(),
      hidden: id === "thread-view" || id === "view" || id === "durable-run-registry",
      textContent: "",
      innerHTML: "",
      style: {},
      classList: {
        add: (c: string) => classList.add(c),
        remove: (c: string) => classList.delete(c),
        toggle: (c: string, force?: boolean) => {
          if (force === undefined) { if (classList.has(c)) classList.delete(c); else classList.add(c); }
          else if (force) classList.add(c); else classList.delete(c);
        },
        contains: (c: string) => classList.has(c),
      },
      getAttribute: (k: string) => attributes.get(k) ?? null,
      setAttribute: (k: string, v: unknown) => attributes.set(k, String(v)),
      removeAttribute: (k: string) => attributes.delete(k),
      hasAttribute: (k: string) => attributes.has(k),
      toggleAttribute: (k: string, force?: boolean) => {
        const present = force === undefined ? !attributes.has(k) : force;
        if (present) attributes.set(k, ""); else attributes.delete(k);
        return present;
      },
      addEventListener: (t: string, fn: (ev: any) => void) => {
        if (!listeners.has(t)) listeners.set(t, []);
        listeners.get(t)!.push(fn);
      },
      removeEventListener: (t: string, fn: (ev: any) => void) => {
        const arr = listeners.get(t);
        if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
      },
      dispatchEvent: (ev: any) => {
        for (const fn of [...(listeners.get(ev.type) ?? [])]) fn(ev);
        return true;
      },
      append: (...nodes: any[]) => children.push(...nodes),
      appendUser: (text: string) => {
        const b = getOrCreateElement(`bubble_${Math.random().toString(36).slice(2, 8)}`, "message-bubble");
        b.setAttribute("role", "user"); b.setAttribute("content", text); children.push(b); return b;
      },
      appendAgent: (text: string) => {
        const b = getOrCreateElement(`bubble_${Math.random().toString(36).slice(2, 8)}`, "message-bubble");
        b.setAttribute("role", "agent"); b.setAttribute("content", text); children.push(b); return b;
      },
      appendError: (text: string) => {
        const b = getOrCreateElement(`bubble_${Math.random().toString(36).slice(2, 8)}`, "message-bubble");
        b.setAttribute("role", "error"); b.setAttribute("content", text); children.push(b); return b;
      },
      appendChild: (node: any) => { children.push(node); return node; },
      replaceChildren: (...nodes: any[]) => { children.splice(0, children.length, ...nodes); },
      removeChild: (node: any) => { const i = children.indexOf(node); if (i >= 0) children.splice(i, 1); return node; },
      contains: (node: any) => children.includes(node),
      scrollIntoView: () => {},
      querySelector: (sel: string) => (sel === ".dot" ? { style: {} } : null),
      querySelectorAll: () => [],
      focus: () => {},
      clear: () => { children.length = 0; },
      setMessages: (msgs: any[]) => { children.splice(0, children.length, ...msgs); },
      // Mirror agent-conversation's inline live-status contract: live states
      // pin the row; idle/completed/empty resolve it to nothing.
      liveStatus: null as any,
      liveStatusLog: [] as any[],
      setLiveStatus: (s: any) => {
        el.liveStatusLog.push(s);
        const st = typeof s?.state === "string" ? s.state : "";
        el.liveStatus = st && st !== "idle" && st !== "completed" ? s : null;
      },
      clearLiveStatus: () => { el.liveStatus = null; },
      get children() { return children; },
    };
    elements.set(id, el);
    return el;
  }

  (globalThis as Record<string, unknown>).document = {
    getElementById: (id: string) => getOrCreateElement(id),
    querySelector: (sel: string) => (sel === ".composer" ? { classList: { toggle() {} } } : null),
    querySelectorAll: () => [],
    createElement: (tag: string) => getOrCreateElement(`dyn_${Math.random().toString(36).slice(2, 8)}`, tag),
    documentElement: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    startViewTransition: (update: () => void) => { update(); return { finished: Promise.resolve() }; },
  };
  (globalThis as Record<string, unknown>).window = globalThis;
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false });
  (globalThis as Record<string, unknown>).HTMLElement = class HTMLElement {};
  (globalThis as Record<string, unknown>).customElements = { define() {} };
  (globalThis as Record<string, unknown>).CustomEvent = class CustomEvent {
    type: string; detail: any;
    constructor(type: string, init: any = {}) { this.type = type; this.detail = init.detail; }
  };
  (globalThis as Record<string, unknown>).location = { hash: "" };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(msg: any, cb: (res: unknown) => void) {
        if (msg.type === "provider.permission-summary") { queueMicrotask(() => cb({ ok: true, local: true })); return; }
        if (msg.type === "thread.get") { queueMicrotask(() => cb({ ok: true, thread })); return; }
        if (msg.type === "thread.list") { queueMicrotask(() => cb({ ok: true, threads })); return; }
        if (msg.type === "named-agent.list") { queueMicrotask(() => cb({ ok: true, agents: [] })); return; }
        if (msg.type === "agent.list") { queueMicrotask(() => cb({ ok: true, origins: [] })); return; }
        if (msg.type === "background-agent.list") { queueMicrotask(() => cb({ ok: true, recipes: [] })); return; }
        if (msg.type === "asset.list") { queueMicrotask(() => cb({ ok: true, assets: [] })); return; }
        if (msg.type === "memory.get") { queueMicrotask(() => cb([])); return; }
        queueMicrotask(() => cb({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener(fn: (msg: unknown) => void) { portState.listener = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() {},
        };
      },
    },
    permissions: { contains: () => Promise.resolve(true) },
  };
  return { getOrCreateElement, injectSnapshot: () => portState.listener?.({ type: "run-snapshot", policy: null, runs }) };
}

async function boot(harness) {
  await import(`../extension/ntp/ntp.js?exec=${Math.random().toString(36).slice(2)}`);
  harness.injectSnapshot();
  // boot loads threads; the sidebar row is the real navigation path in
  const sidebar = harness.getOrCreateElement("thread-sidebar");
  await waitFor(() => sidebar.children.some((c) => c.className === "thread-item"), "sidebar thread row");
  return sidebar.children.find((c) => c.className === "thread-item");
}

// The production click target is the row's explicit .t-open button (the row
// is a non-interactive wrapper — nested-interactive fix).
function openTask(row: any) {
  const btn = row.children.find((c: any) => c.className === "t-open") ?? row.children[0];
  btn.dispatchEvent({ type: "click" });
}

async function waitFor(fn: () => boolean, label: string) {
  const end = Date.now() + 2000;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${label}`);
}

function toolRows(children) {
  return children.filter((c) => c?.role === "tool" || c?.getAttribute?.("role") === "tool");
}

Deno.test("restore RUNNING task: transcript + status + controls restored on leave-and-return, no duplicates", async () => {
  const harness = makeHarness({
    thread: {
      id: "t_run", name: "zip job", messages: [
        { role: "user", content: "zip the logs", ts: 1 },
        { role: "tool", toolCallId: "c1", toolName: "zip", toolStatus: "success", toolResult: "archive.zip", toolOk: true, ts: 2 },
      ],
    },
    threads: [{ id: "t_run", name: "zip job", status: "running" }],
    runs: [{ executionId: "exec_run_1", threadId: "t_run", phase: "running", revision: 3, updatedAt: 100 }],
  });
  const row = await boot(harness);
  const conv = harness.getOrCreateElement("thread-conversation");
  const registry = harness.getOrCreateElement("durable-run-registry");

  openTask(row);
  await waitFor(() => harness.getOrCreateElement("thread-view").hidden === false, "thread view open");
  // persisted journal replayed EXACTLY ONCE
  assertEquals(toolRows(conv.children).length, 1, "one replayed tool card for c1");
  // the inline live-status row + controls restored for the executing run
  assertEquals(conv.liveStatus?.state, "running", "the inline status row shows the live run");
  assertEquals(registry.hidden, false, "run controls restored");

  // live projection attached: a NEW progress event renders
  portState.listener?.({ type: "progress", event: { runId: "exec_run_1", type: "tool-call", toolName: "tar", toolArgs: { f: "x" } } });
  await waitFor(() => toolRows(conv.children).length === 2, "live tool-call rendered after restore");
  assertEquals(toolRows(conv.children).length, 2, "live event appended without duplicating the journal");

  // LEAVE: the subscription tears down (no ghost writes while away)
  harness.getOrCreateElement("thread-back").dispatchEvent({ type: "click" });
  assertEquals(harness.getOrCreateElement("thread-view").hidden, true, "left the task view");
  portState.listener?.({ type: "progress", event: { runId: "exec_run_1", type: "tool-call", toolName: "gzip", toolArgs: {} } });

  // RETURN: re-attached; journal still exactly once; live continuation resumes
  openTask(row);
  await waitFor(() => harness.getOrCreateElement("thread-view").hidden === false, "thread view reopened");
  assertEquals(conv.liveStatus?.state, "running", "the inline status row restored on return");
  assertEquals(toolRows(conv.children).filter((c) => c.name === "zip" || c.getAttribute?.("content")?.includes("zip")).length, 1, "journal replayed exactly once on return");
  portState.listener?.({ type: "progress", event: { runId: "exec_run_1", type: "tool-call", toolName: "xz", toolArgs: {} } });
  await waitFor(() => toolRows(conv.children).some((c) => c.getAttribute?.("content")?.includes("xz")), "live continuation after return");

  // settle: done event renders the conclusion and the banner settles
  portState.listener?.({ type: "progress", event: { runId: "exec_run_1", type: "done", text: "all packed", aborted: false } });
  await waitFor(() => conv.children.some((c) => c.getAttribute?.("content") === "all packed"), "settled conclusion rendered");
});

Deno.test("restore COMPLETED task: terminal state shown, no live controls, no phantom banner", async () => {
  const harness = makeHarness({
    thread: {
      id: "t_done", name: "done job", messages: [
        { role: "user", content: "summarize", ts: 1 },
        { role: "agent", content: "the summary", ts: 2 },
      ],
    },
    threads: [{ id: "t_done", name: "done job" }],
    runs: [{ executionId: "exec_done_1", threadId: "t_done", phase: "completed", revision: 9, updatedAt: 200 }],
  });
  const row = await boot(harness);
  const conv = harness.getOrCreateElement("thread-conversation");
  openTask(row);
  await waitFor(() => harness.getOrCreateElement("thread-view").hidden === false, "thread view open");
  assert(conv.children.some((c) => c.content === "the summary" || c.getAttribute?.("content") === "the summary"), "terminal answer restored");
  assertEquals(conv.liveStatus, null, "no phantom live-status row for a terminal run");
  assertEquals(harness.getOrCreateElement("durable-run-registry").hidden, true, "no live controls for a terminal run");
});

Deno.test("restore FAILED task: terminal error shown; re-open does not duplicate rows", async () => {
  const harness = makeHarness({
    thread: {
      id: "t_fail", name: "fail job", messages: [
        { role: "user", content: "break", ts: 1 },
        { role: "error", content: "provider exploded", ts: 2 },
      ],
    },
    threads: [{ id: "t_fail", name: "fail job", status: "error" }],
    runs: [{ executionId: "exec_fail_1", threadId: "t_fail", phase: "failed", revision: 2, updatedAt: 300 }],
  });
  const row = await boot(harness);
  const conv = harness.getOrCreateElement("thread-conversation");
  openTask(row);
  await waitFor(() => harness.getOrCreateElement("thread-view").hidden === false, "thread view open");
  assert(conv.children.some((c) => c.content === "provider exploded" || c.getAttribute?.("content") === "provider exploded"), "terminal error restored");
  assertEquals(conv.liveStatus, null, "no phantom live-status row for a failed run");
  const before = conv.children.length;
  openTask(row); // re-open the same task
  await waitFor(() => harness.getOrCreateElement("thread-view").hidden === false, "thread view reopened");
  assertEquals(conv.children.length, before, "re-open reproduces the same terminal projection, no growth");
});
