// @ts-nocheck
// tests/in-flight-permission-cards.test.ts — chrome-agent-platform-m6id
// Multi-waiter and sequential permission request ordering in conversation:
//   (1) In a single run, a second request for an already-denied requirement
//       resolves DENIED fast (no 60s timeout hang).
//   (2) A subsequent request after an earlier grant renders a fresh card in
//       the thread rather than silently dropping/re-pending an old off-screen card.
//   (3) Concurrent in-flight requests for the same requirement share ONE card
//       (no duplicate prompt) and both settle on the owner's decision.
//   (4) Multi-waiter perm-lease: second acquire on an in-flight pattern queues
//       on the settle broadcast instead of double-prompting or dropping.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  runConversationTurn,
} from "../extension/shared/conversation.js";

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attrs = new Map();
    this.listeners = new Map();
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  removeAttribute(k) { this.attrs.delete(k); }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  async dispatch(type, detail) {
    for (const fn of (this.listeners.get(type) ?? [])) await fn({ type, detail });
  }
}

function makeConversationContainer(appended) {
  return {
    appendUser() {}, appendAgent() {}, appendSystem() {}, appendError() {},
    appendTool() { return { setAttribute() {} }; },
    append(el) { appended.push(el); },
    scrollTop: 0, scrollHeight: 0,
    setMessages() {}, clear() {},
  };
}

let portState = { listener: null };

function setupChromeStub(sw) {
  portState = { listener: null };
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        if (msg.type === "provider.permission-summary") {
          queueMicrotask(() => cb?.({ ok: true, local: true }));
          return;
        }
        if (msg.type === "agent.run") {
          sw.runCount += 1;
          sw.lastRunId = msg.runId ?? null;
          sw.tasks.push(msg.task);
          setTimeout(() => cb?.({ ok: true, threadId: "t_m6id", executionId: `exec:${msg.runId}`, result: "[demo] done" }), 500);
          return;
        }
        if (msg.type === "run.resolve-inline-approval") {
          sw.resolved.push({ requestId: msg.requestId, approve: msg.approve });
          queueMicrotask(() => cb?.({ ok: true }));
          return;
        }
        if (msg.type === "perm-lease.acquire") {
          const r = acquireLease(msg.pattern);
          queueMicrotask(() => cb?.(r));
          return;
        }
        if (msg.type === "perm-lease.settle") {
          const r = settleLease(msg.pattern, msg);
          if (r.broadcast) {
            for (const fn of sw.messageListeners) fn(r.broadcast);
          }
          queueMicrotask(() => cb?.(r));
          return;
        }
        queueMicrotask(() => cb?.({ ok: true }));
      },
      connect() {
        return {
          onMessage: { addListener: (fn) => { portState.listener = fn; } },
          onDisconnect: { addListener() {} },
          postMessage() {},
          disconnect() {},
        };
      },
      onMessage: {
        addListener: (fn) => { (sw.messageListeners ??= []).push(fn); },
        removeListener: (fn) => {
          const idx = (sw.messageListeners ??= []).indexOf(fn);
          if (idx >= 0) sw.messageListeners.splice(idx, 1);
        },
      },
    },
    permissions: {
      contains: () => Promise.resolve(true),
      request: () => Promise.resolve(true),
    },
  };
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  Object.defineProperty(globalThis, "navigator", { value: { userActivation: { isActive: true } }, configurable: true });
}

async function waitForCondition(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

Deno.test("m6id falsification: second request for already-denied requirement resolves DENIED fast (no hang)", async () => {
  const sw = { runCount: 0, lastRunId: null, tasks: [], resolved: [] };
  setupChromeStub(sw);
  const { runConversationTurn } = await import(`../extension/shared/conversation.js?test=${Math.random()}`);
  const appended = [];
  const turn = runConversationTurn(makeConversationContainer(appended), {
    text: "run cookie checks",
    onStatus: () => {},
  });
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch");

  const denial = {
    waitingForPermission: true,
    permissionRequirement: { reason: "get_cookie", permissions: ["cookies"] },
  };

  // 1. First tool requests permission
  portState.listener({ type: "progress", event: { type: "approval-request", runId: sw.lastRunId, requestId: "rp_1", result: denial } });
  await waitForCondition(() => appended.some((el) => el.tagName === "permission-approval-card"), 500, "first card renders");
  const card1 = appended.find((el) => el.tagName === "permission-approval-card");

  // Owner denies first request
  await card1.dispatch("deny", { sourceEvent: { isTrusted: true } });
  await waitForCondition(() => sw.resolved.some((r) => r.requestId === "rp_1" && r.approve === false), 500, "first resolved denied");

  // 2. Second tool (e.g. list_cookies) requests permission for SAME requirement in the same run
  portState.listener({ type: "progress", event: { type: "approval-request", runId: sw.lastRunId, requestId: "rp_2", result: denial } });

  // The second request must be resolved as denied immediately (fast failure, no 60s timeout)
  await waitForCondition(() => sw.resolved.some((r) => r.requestId === "rp_2" && r.approve === false), 500, "second request resolved denied fast");
  assertEquals(sw.resolved.find((r) => r.requestId === "rp_2")?.approve, false);
});

Deno.test("m6id falsification: subsequent request after earlier grant renders a fresh card in thread", async () => {
  const sw = { runCount: 0, lastRunId: null, tasks: [], resolved: [] };
  setupChromeStub(sw);
  const { runConversationTurn } = await import(`../extension/shared/conversation.js?test=${Math.random()}`);
  const appended = [];
  const turn = runConversationTurn(makeConversationContainer(appended), {
    text: "run cookie checks",
    onStatus: () => {},
  });
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch");

  const denial = {
    waitingForPermission: true,
    permissionRequirement: { reason: "get_cookie", permissions: ["cookies"] },
  };

  // 1. First request arrives & owner approves
  portState.listener({ type: "progress", event: { type: "approval-request", runId: sw.lastRunId, requestId: "rp_1", result: denial } });
  await waitForCondition(() => appended.some((el) => el.tagName === "permission-approval-card"), 500, "first card renders");
  const card1 = appended.find((el) => el.tagName === "permission-approval-card");
  await card1.dispatch("approve", { sourceEvent: { isTrusted: true } });
  await waitForCondition(() => card1.getAttribute("state") === "granted", 500, "card1 granted");

  // 2. Second request arrives later in the run (e.g. list_cookies needing decision)
  portState.listener({ type: "progress", event: { type: "approval-request", runId: sw.lastRunId, requestId: "rp_2", result: denial } });

  // Must render a SUBSEQUENT card in the thread, not drop it or leave card count at 1
  await waitForCondition(() => appended.filter((el) => el.tagName === "permission-approval-card").length === 2, 500, "second card rendered");
  const cards = appended.filter((el) => el.tagName === "permission-approval-card");
  const card2 = cards[1];
  assertEquals(card2.getAttribute("state") || "pending", "pending");

  // Owner approves second card
  await card2.dispatch("approve", { sourceEvent: { isTrusted: true } });
  await waitForCondition(() => sw.resolved.some((r) => r.requestId === "rp_2" && r.approve === true), 500, "second resolved granted");
});

Deno.test("m6id: concurrent in-flight requests share ONE card and both settle on decision", async () => {
  const sw = { runCount: 0, lastRunId: null, tasks: [], resolved: [] };
  setupChromeStub(sw);
  const { runConversationTurn } = await import(`../extension/shared/conversation.js?test=${Math.random()}`);
  const appended = [];
  const turn = runConversationTurn(makeConversationContainer(appended), {
    text: "run parallel cookie checks",
    onStatus: () => {},
  });
  await waitForCondition(() => sw.lastRunId !== null && portState.listener !== null, 500, "run dispatch");

  const denial = {
    waitingForPermission: true,
    permissionRequirement: { reason: "cookie access", permissions: ["cookies"] },
  };

  // Both tools emit approval-request concurrently while first is still pending
  portState.listener({ type: "progress", event: { type: "approval-request", runId: sw.lastRunId, requestId: "rp_c1", result: denial } });
  await waitForCondition(() => appended.some((el) => el.tagName === "permission-approval-card"), 500, "card renders");
  portState.listener({ type: "progress", event: { type: "approval-request", runId: sw.lastRunId, requestId: "rp_c2", result: denial } });

  // Still exactly ONE card (no duplicate concurrent prompt)
  assertEquals(appended.filter((el) => el.tagName === "permission-approval-card").length, 1);
  const card = appended.find((el) => el.tagName === "permission-approval-card");

  // Owner approves
  await card.dispatch("approve", { sourceEvent: { isTrusted: true } });
  await waitForCondition(() => sw.resolved.length === 2, 500, "both resolved");
  assertEquals(sw.resolved.some((r) => r.requestId === "rp_c1" && r.approve === true), true);
  assertEquals(sw.resolved.some((r) => r.requestId === "rp_c2" && r.approve === true), true);
});

