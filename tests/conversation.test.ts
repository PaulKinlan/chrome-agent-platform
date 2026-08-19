// Unit tests for the unified conversational surface's shared module — the
// journal → conversation-history mapping (task/result entries become user/
// assistant turns) that lets a follow-up/nudge run in the SAME persistent
// thread with the prior history.
// @ts-nocheck — the chrome mock is intentionally dynamic (no chrome.* types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { historyFromJournal, friendlyActivityLabel } from "../extension/shared/conversation.js";

// ── fresh-module isolation (no production reset hook) ───────────────────────
// Each test loads a CACHE-BUSTED instance of the REAL production module:
// fresh module state (a fresh lease universe) with identical production
// semantics — the same code production runs, no exported test seam.
let __freshModuleCounter = 0;
async function freshLeaseModule() {
  __freshModuleCounter += 1;
  const spec = `../extension/lib/perm-lease.js?fresh=${__freshModuleCounter}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = new URL(spec, import.meta.url);
  return await import(url.href);
}

Deno.test("historyFromJournal maps task/result entries to user/assistant turns", () => {
  const journal = [
    { type: "task", id: "1", task: "summarise this page" },
    { type: "result", id: "1", result: "[demo] done" },
    { type: "task", id: "2", task: "now make it concise" },
    { type: "result", id: "2", result: "[demo] done again" },
  ];
  assertEquals(historyFromJournal(journal), [
    { role: "user", content: "summarise this page" },
    { role: "assistant", content: "[demo] done" },
    { role: "user", content: "now make it concise" },
    { role: "assistant", content: "[demo] done again" },
  ]);
});

Deno.test("historyFromJournal skips non-task/result and empty entries", () => {
  const journal = [
    { type: "task", task: "" }, // empty task → skipped
    { type: "scheduled", task: "ignored" }, // not a task entry → skipped
    { type: "result", result: "" }, // empty result → skipped
    { type: "task", task: "real task" },
    { type: "result", result: "real result" },
    null, // null row → skipped
    "garbage", // non-object → skipped
  ];
  assertEquals(historyFromJournal(journal), [
    { role: "user", content: "real task" },
    { role: "assistant", content: "real result" },
  ]);
});

Deno.test("historyFromJournal returns [] for a non-array / empty journal", () => {
  assertEquals(historyFromJournal(null), []);
  assertEquals(historyFromJournal(undefined), []);
  assertEquals(historyFromJournal({ not: "an array" }), []);
  assertEquals(historyFromJournal([]), []);
});

Deno.test("friendlyActivityLabel maps tool names to human activity (with a name)", () => {
  assertEquals(friendlyActivityLabel("create_named_agent", { name: "Paul" }), "creating agent Paul");
  assertEquals(friendlyActivityLabel("create_named_agent", {}), "creating an agent");
  assertEquals(friendlyActivityLabel("list_named_agents", {}), "listing agents");
  assertEquals(friendlyActivityLabel("schedule_task", {}), "scheduling a task");
  assertEquals(friendlyActivityLabel("open_tab", { url: "https://paul.kinlan.me" }), "opening https://paul.kinlan.me");
  assertEquals(friendlyActivityLabel("generate_ui", {}), "generating UI");
  assertEquals(friendlyActivityLabel("delegate_task", { agent: "Bob" }), "delegating to Bob");
  // an unknown snake_case tool falls back to the split words
  assertEquals(friendlyActivityLabel("some_unknown_tool", {}), "some unknown tool");
});

// appendBubble passes the entry's timestamp through to the conversation surface
// so the agent run history shows the subtle time-gap divider (item: the agent
// run history was dropping the ts — a task list showed it, an agent run didn't).
Deno.test("appendBubble forwards ts to the rich append methods", async () => {
  const calls = [];
  const container = {
    appendUser(text, ts, attachments) { calls.push(["user", text, ts]); },
    appendAgent(text, ts) { calls.push(["agent", text, ts]); },
    appendSystem(text, ts) { calls.push(["system", text, ts]); },
  };
  const { appendBubble } = await import("../extension/shared/conversation.js");
  const t = 1786971572895;
  appendBubble(container, "user", "hi", undefined, t);
  appendBubble(container, "agent", "result", undefined, t);
  appendBubble(container, "system", "note", undefined, t);
  assertEquals(calls[0], ["user", "hi", t]);
  assertEquals(calls[1], ["agent", "result", t]);
  assertEquals(calls[2], ["system", "note", t]);
});

// ── this review: the ACTUAL conversation consumer (runConversationTurn) under
// hostile stale/newer settlements — drives the real binding path end to end.
Deno.test("runConversationTurn: hostile stale/NEWER settlements never clear the denied state; only the exact issued generation does", async () => {
  // The full conversation module with the real provider-gate wiring: the
  // consumer subscribes via onIssued inside the real request path.
  const lease = await freshLeaseModule();
  const gate = await import("../extension/lib/provider-gate.js");

  // State on the container the consumer mutates.
  const state = { denied: true };
  const container = {
    dataset: {},
    removeAttribute(k) { if (k === "data-provider-denied") state.denied = false; },
    setAttribute() {},
    append() {},
    appendChild() {},
    querySelector() { return null; },
    classList: { add() {}, remove() {} },
  };
  Object.defineProperty(container, "dataset", { value: {}, configurable: true });

  // Broadcast bus the consumer's onPermissionSettled listens on.
  const listeners = [];
  const broadcasts = [];
  const realOnPermissionSettled = gate.onPermissionSettled;

  let promptResolve;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (m) => {
        if (m.type === "perm-lease.acquire") return lease.acquireLease(m.pattern);
        if (m.type === "perm-lease.settle") return lease.settleLease(m.pattern, m);
        if (m.type === "perm-lease.state") return lease.leaseState(m.pattern);
        return {};
      },
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
      },
    },
    permissions: {
      // A HANGING prompt: the request stays pending so we can inject hostiles.
      request: () => new Promise((resolve) => { promptResolve = resolve; globalThis.__promptCalled = (globalThis.__promptCalled ?? 0) + 1; }),
      contains: async () => false,
    },
  };

  // Patch send() (the module's chrome.runtime.sendMessage wrapper) — the module
  // imported it earlier; we instead drive everything through the global chrome.
  const mod = await import("../extension/shared/conversation.js");

  // The consumer path requires a non-local provider + no host access:
  // provider.summary → gemini + a pattern; hasProviderHostAccess → false.
  const origSendMessage = globalThis.chrome.runtime.sendMessage;
  const route = async (m) => {
    if (m?.type === "perm-lease.settle") {
      const r = await lease.settleLease(m.pattern, m);
      if (r?.broadcast) {
        // the real SW broadcasts the settle to every extension page — emulate
        setTimeout(() => { for (const fn of [...listeners]) fn(r.broadcast); }, 0);
      }
      return r;
    }
    if (m?.type === "provider.summary") {
      return { provider: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" };
    }
    if (m?.type === "kv.get" || m?.type === "memory.get" || m?.type === "memory.list") return {};
    if (m?.type === "agent.run" || m?.type === "run-task") return { ok: true, result: "[demo] done" };
    if (m?.type === "thread.create") return { id: "t-test" };
    return origSendMessage(m);
  };
  // Support BOTH the callback form (lib/messages.send) and the promise form.
  globalThis.chrome.runtime.sendMessage = (m, cb) => {
    if (typeof cb === "function") {
      route(m).then((r) => cb(r), (e) => cb({ ok: false, error: String(e?.message ?? e) }));
      return true;
    }
    return route(m);
  };

  // Capture every broadcast the bus sees.
  const busTap = (msg) => broadcasts.push(msg);
  listeners.push(busTap);

  // Drive a turn (it will hang in the permission prompt — exactly what we want).
  const turnP = mod.runConversationTurn(container, {
    text: "test turn",
    onStatus: () => {},
  }).catch((e) => ({ __turnError: e?.message ?? String(e) }));

  // Let the turn reach the prompt (acquire + onIssued happened).
  await new Promise((r) => setTimeout(r, 150));

  // INJECT HOSTILES through the SAME bus the consumer listens on: stale and
  // newer generations for the SAME pattern.
  const pattern = "https://generativelanguage.googleapis.com/*";
  for (const hostile of [
    { type: "provider-host-perm:settled", pattern, generation: "stale-opaque-id-000", granted: true },
    { type: "provider-host-perm:settled", pattern, generation: "newer-opaque-id-999", granted: true },
  ]) {
    for (const fn of [...listeners]) fn(hostile);
  }
  await new Promise((r) => setTimeout(r, 100));
  // The hostile settlements must NOT have cleared the denied state.
  assertEquals(state.denied, true, "hostile stale/newer settlements did not clear the denied state");

  // Resolve the prompt TRUE — the gate settles with the REAL issued generation,
  // which the consumer's exact filter accepts (denied cleared).
  assertEquals(globalThis.__promptCalled ?? 0, 1, 'the permission prompt was reached'); promptResolve(true);
  await turnP; // the turn finishes (permission granted; the run may fail harmlessly after)
  await new Promise((r) => setTimeout(r, 100));
  // The exact-generation settle broadcast reached the bus and the consumer disposed.
  const realSettle = broadcasts.find((b) => b.type === "provider-host-perm:settled" && b.granted === true && b.generation && !/stale|newer/.test(b.generation));
  assert(realSettle, "the REAL settle broadcast occurred");
  assertEquals(state.denied, false, "the EXACT issued generation cleared the denied state");
});
