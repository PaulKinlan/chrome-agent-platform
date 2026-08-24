// @ts-nocheck — CAP-FB-20260824-THREAD-REOPEN-REPAIR-01:
// Load-time ordering repair for pre-0.2.237 stored threads.
// Asserts that pre-fix threads where post-run tool rows were persisted AFTER
// the terminal assistant row re-render with tool rows BEFORE the terminal,
// ending on the terminal assistant/error row.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { projectThreadMessages } from "../extension/shared/conversation.js";

// A pre-0.2.237 broken thread: the durable outbox wrote the assistant row FIRST (ts: 2000),
// and post-run tool replay appended tool rows AFTER (ts: 3000, 3100).
// In storage, the thread ends on a tool row.
const PRE_FIX_THREAD = {
  id: "t-prefix-broken",
  name: "Book a table",
  messages: [
    { role: "user", content: "Book a table at Le Petit Bistro", ts: 1000, executionId: "exec_1" },
    { role: "assistant", content: "Booked for 2 at 7pm.", ts: 2000, executionId: "exec_1" },
    { role: "tool", toolName: "book_table", toolStatus: "running", toolCallId: "c1", ts: 3000, executionId: "exec_1" },
    { role: "tool", toolName: "book_table", toolStatus: "success", toolCallId: "c1", toolResult: "confirmed", toolOk: true, ts: 3100, executionId: "exec_1" },
  ],
};

// A multi-turn pre-0.2.237 broken thread: both turns end on trailing tool rows.
const MULTI_TURN_PRE_FIX = {
  id: "t-prefix-multi",
  name: "Two-turn task",
  messages: [
    // Turn 1 (broken order: user -> assistant -> tool)
    { role: "user", content: "Search flights to Paris", ts: 1000, executionId: "exec_1" },
    { role: "assistant", content: "Found 3 flights.", ts: 2000, executionId: "exec_1" },
    { role: "tool", toolName: "search_flights", toolStatus: "success", toolCallId: "c1", toolResult: "3 flights", toolOk: true, ts: 2500, executionId: "exec_1" },
    // Turn 2 (broken order: user -> assistant -> tool)
    { role: "user", content: "Book flight AF123", ts: 3000, executionId: "exec_2" },
    { role: "assistant", content: "Flight AF123 booked.", ts: 4000, executionId: "exec_2" },
    { role: "tool", toolName: "book_flight", toolStatus: "success", toolCallId: "c2", toolResult: "ticket issued", toolOk: true, ts: 4500, executionId: "exec_2" },
  ],
};

// A post-0.2.237 already correct thread: tools were inserted BEFORE the terminal.
const POST_FIX_THREAD = {
  id: "t-postfix-correct",
  name: "Correct thread",
  messages: [
    { role: "user", content: "Check weather", ts: 1000, executionId: "exec_1" },
    { role: "tool", toolName: "get_weather", toolStatus: "success", toolCallId: "c1", toolResult: "22C sunny", toolOk: true, ts: 2000, executionId: "exec_1" },
    { role: "assistant", content: "It is 22C and sunny.", ts: 3000, executionId: "exec_1" },
  ],
};

Deno.test("reopen repair: pre-fix single-turn thread is repaired with terminal assistant row LAST", () => {
  const projected = projectThreadMessages(PRE_FIX_THREAD);
  const roles = projected.map((m) => m.role);

  // The thread must NOT end on a tool row:
  assertEquals(roles[roles.length - 1], "assistant", "terminal assistant row must be last");
  assertEquals(projected[projected.length - 1].content, "Booked for 2 at 7pm.");

  // Sequence must be: user -> tool -> assistant
  assertEquals(roles, ["user", "tool", "assistant"]);
  assertEquals(projected[0].content, "Book a table at Le Petit Bistro");
  assertEquals(projected[1].name, "book_table");
});

Deno.test("reopen repair: pre-fix multi-turn thread repairs each turn so assistant rows are terminal", () => {
  const projected = projectThreadMessages(MULTI_TURN_PRE_FIX);
  const roles = projected.map((m) => m.role);

  // Expected sequence: user1 -> tool1 -> assistant1 -> user2 -> tool2 -> assistant2
  assertEquals(roles, ["user", "tool", "assistant", "user", "tool", "assistant"]);
  assertEquals(projected[0].content, "Search flights to Paris");
  assertEquals(projected[1].name, "search_flights");
  assertEquals(projected[2].content, "Found 3 flights.");
  assertEquals(projected[3].content, "Book flight AF123");
  assertEquals(projected[4].name, "book_flight");
  assertEquals(projected[5].content, "Flight AF123 booked.");
  assertEquals(roles[roles.length - 1], "assistant");
});

Deno.test("reopen repair: post-fix thread is unchanged (idempotent transform)", () => {
  const projected = projectThreadMessages(POST_FIX_THREAD);
  const roles = projected.map((m) => m.role);

  assertEquals(roles, ["user", "tool", "assistant"]);
  assertEquals(projected[0].content, "Check weather");
  assertEquals(projected[1].name, "get_weather");
  assertEquals(projected[2].content, "It is 22C and sunny.");
});

Deno.test("reopen repair: error terminal rows are also positioned as turn terminals", () => {
  const errorThread = {
    id: "t-error-terminal",
    messages: [
      { role: "user", content: "Query DB", ts: 1000, executionId: "exec_1" },
      { role: "error", content: "DB timeout", ts: 2000, executionId: "exec_1" },
      { role: "tool", toolName: "db_query", toolStatus: "error", toolCallId: "c1", toolResult: "timeout", toolOk: false, ts: 3000, executionId: "exec_1" },
    ],
  };

  const projected = projectThreadMessages(errorThread);
  const roles = projected.map((m) => m.role);

  assertEquals(roles, ["user", "tool", "error"]);
  assertEquals(projected[0].content, "Query DB");
  assertEquals(projected[1].name, "db_query");
  assertEquals(projected[2].content, "DB timeout");
});

Deno.test("reopen repair (B1-a): same-execution assistant-then-error keeps BOTH rows in ts order", () => {
  const threadWithBoth = {
    id: "t-both-terminals",
    messages: [
      { role: "user", content: "Complex task", ts: 1000, executionId: "e1" },
      { role: "assistant", content: "Partial answer before network dropped", ts: 2000, executionId: "e1" },
      { role: "error", content: "Network connection lost", ts: 2100, executionId: "e1" },
      { role: "tool", toolName: "fetch_data", toolStatus: "error", toolCallId: "c1", toolResult: "err", toolOk: false, ts: 3000, executionId: "e1" },
    ],
  };

  const projected = projectThreadMessages(threadWithBoth);
  const roles = projected.map((m) => m.role);
  const contents = projected.map((m) => m.content);

  // Both assistant and error must survive and render in order
  assertEquals(roles, ["user", "tool", "assistant", "error"]);
  assertEquals(contents[0], "Complex task");
  assertEquals(projected[1].name, "fetch_data");
  assertEquals(contents[2], "Partial answer before network dropped");
  assertEquals(contents[3], "Network connection lost");
});

Deno.test("reopen repair (B1-b): legacy no-executionId turn with two assistant rows keeps BOTH in order", () => {
  const legacyMultiAssistant = {
    id: "t-legacy-multi-assistant",
    messages: [
      { role: "user", content: "Tell me a story", ts: 1000 },
      { role: "assistant", content: "Part one of the story.", ts: 2000 },
      { role: "assistant", content: "Part two of the story.", ts: 2500 },
      { role: "tool", toolName: "story_generator", toolStatus: "success", toolCallId: "c1", toolResult: "ok", toolOk: true, ts: 3000 },
    ],
  };

  const projected = projectThreadMessages(legacyMultiAssistant);
  const roles = projected.map((m) => m.role);
  const contents = projected.map((m) => m.content);

  // Both assistant rows must survive and render in order
  assertEquals(roles, ["user", "tool", "assistant", "assistant"]);
  assertEquals(contents[0], "Tell me a story");
  assertEquals(projected[1].name, "story_generator");
  assertEquals(contents[2], "Part one of the story.");
  assertEquals(contents[3], "Part two of the story.");
});
