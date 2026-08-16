// Unit tests for the unified conversational surface's shared module — the
// journal → conversation-history mapping (task/result entries become user/
// assistant turns) that lets a follow-up/nudge run in the SAME persistent
// thread with the prior history.
// @ts-nocheck — the chrome mock is intentionally dynamic (no chrome.* types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { historyFromJournal } from "../extension/shared/conversation.js";

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
