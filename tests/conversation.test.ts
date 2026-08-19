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
