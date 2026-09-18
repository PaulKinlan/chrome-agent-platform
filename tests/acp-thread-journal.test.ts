// tests/acp-thread-journal.test.ts — the CAP-side record of an ACP turn
// (chrome-agent-platform-hg03): the turn must appear in the task list and
// reopen with its transcript, in the SAME thread store a browser run uses.
//
// The store helpers are injected, so these tests pin the composition — which
// helper is called, with what, in what order, and what a failure does — without
// a service worker.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  acpExecutionId,
  acpToolRows,
  openAcpTurn,
  recordAcpTurn,
} from "../extension/lib/acp-thread-journal.js";

/** A fake thread store that records every call, in order. */
function fakeStore() {
  const calls: Array<{ fn: string, args: any[] }> = [];
  const state = { threadId: "thread-9", threads: new Map<string, any>() };
  return {
    calls,
    state,
    deps: {
      createThread: (task: string, attachments: any[]) => {
        calls.push({ fn: "createThread", args: [task, attachments] });
        state.threads.set(state.threadId, { id: state.threadId, status: "running" });
        return Promise.resolve({ id: state.threadId });
      },
      continueThread: (id: string, task: string, attachments: any[]) => {
        calls.push({ fn: "continueThread", args: [id, task, attachments] });
        if (!state.threads.has(id)) return Promise.resolve(null);
        return Promise.resolve({ thread: { id }, history: [{ role: "user", content: task }] });
      },
      nameThread: (id: string, task: string) => { calls.push({ fn: "nameThread", args: [id, task] }); },
      appendThreadMessage: (id: string, message: any) => {
        calls.push({ fn: "appendThreadMessage", args: [id, message] });
        return Promise.resolve(true);
      },
      commitThreadTerminal: (id: string, executionId: string, terminal: any) => {
        calls.push({ fn: "commitThreadTerminal", args: [id, executionId, terminal] });
        const thread = state.threads.get(id);
        if (!thread) return Promise.resolve(null);
        thread.status = terminal?.role === "assistant" ? "done" : "error";
        return Promise.resolve({ id, status: thread.status });
      },
    },
  };
}

Deno.test("openAcpTurn: a first turn creates the task; a follow-up CONTINUES it", async () => {
  const { calls, deps, state } = fakeStore();

  const first = await openAcpTurn({ task: "summarise the page", attachments: [], threadId: null, harnessId: "pi", sessionId: "ses-1" }, deps);
  assertEquals(first.ok, true, String(first.error));
  assertEquals(first.threadId, state.threadId);
  assertEquals(first.created, true);
  assertEquals(calls.map((c) => c.fn), ["createThread", "nameThread"], "a new turn creates + names the task");
  assertEquals(calls[0].args[0], "summarise the page");
  assert(typeof first.executionId === "string" && first.executionId.startsWith("acp:pi:ses-1"), first.executionId);

  const second = await openAcpTurn({ task: "and now the comments", attachments: [], threadId: state.threadId, harnessId: "pi", sessionId: "ses-1" }, deps);
  assertEquals(second.ok, true, String(second.error));
  assertEquals(second.created, false);
  assertEquals(second.threadId, state.threadId, "the follow-up lands in the SAME task");
  assertEquals(calls.at(-1)?.fn, "continueThread", "a follow-up continues, it does not fork a second task");
  assertEquals(second.history?.length, 1, "the thread's history comes back for the harness/session");
});

Deno.test("openAcpTurn: a store failure is REPORTED, never thrown (the turn still runs)", async () => {
  const failing = {
    createThread: () => Promise.reject(new Error("thread store write failed")),
    continueThread: () => Promise.resolve(null),
    nameThread: () => {},
  };
  const res = await openAcpTurn({ task: "x", threadId: null }, failing);
  assertEquals(res.ok, false);
  assert(String(res.error).includes("thread store write failed"), String(res.error));
  // A continuation whose thread vanished is a failure too, not a silent fork.
  const gone = await openAcpTurn({ task: "x", threadId: "thread-missing" }, failing);
  assertEquals(gone.ok, false);
});

Deno.test("recordAcpTurn: the terminal row is committed BEFORE the tool rows (the tool row is not the terminal)", async () => {
  // The store's `commitThreadTerminal` identifies the terminal row as "this
  // executionId, no step" — and a tool row is exactly that shape. Appending the
  // tools first made the STORE mistake the tool row for the terminal: the answer
  // was never written and the thread settled as an error with empty content
  // (caught live in cap-evidence/acp-journal-acceptance.ts). The call ORDER is
  // therefore the contract this test pins.
  const { calls, deps, state } = fakeStore();
  await openAcpTurn({ task: "order", threadId: null }, deps);
  const executionId = acpExecutionId("pi", "ses-order");
  await recordAcpTurn({
    threadId: state.threadId,
    executionId,
    text: "the answer",
    ok: true,
    tools: [{ kind: "tool", toolCallId: "tc9", detail: "bash: ls", status: "done" }],
  }, deps);
  const order = calls.filter((c) => c.fn === "commitThreadTerminal" || c.fn === "appendThreadMessage").map((c) => c.fn);
  assertEquals(order, ["commitThreadTerminal", "appendThreadMessage"], `terminal first, tools after: ${JSON.stringify(order)}`);
  assertEquals(calls.find((c) => c.fn === "commitThreadTerminal")?.args[2]?.content, "the answer");
});

Deno.test("recordAcpTurn: tool rows land BEFORE the terminal answer, one row per call", async () => {
  const { calls, deps, state } = fakeStore();
  await openAcpTurn({ task: "run it", threadId: null, harnessId: "pi" }, deps);
  const opened = { executionId: acpExecutionId("pi", "ses-2") };

  const res = await recordAcpTurn({
    threadId: state.threadId,
    executionId: opened.executionId,
    text: "done: 3 files changed",
    ok: true,
    tools: [
      { kind: "tool", toolCallId: "tc1", detail: "bash: ls", status: "in_progress" },
      { kind: "tool", toolCallId: "tc1", detail: "bash: ls", status: "done" },
      { kind: "thought", text: "ignored" },
      { kind: "tool", toolCallId: "tc2", detail: "read: app.js", status: "done" },
    ],
  }, deps);

  assertEquals(res.ok, true, String(res.error));
  const appended = calls.filter((c) => c.fn === "appendThreadMessage");
  assertEquals(appended.length, 2, `one row per distinct call, got ${JSON.stringify(appended.map((a) => a.args[1]?.toolCallId))}`);
  assertEquals(appended[0].args[1].toolCallId, "tc1");
  assertEquals(appended[0].args[1].toolStatus, "done", "the row carries the call's LAST status");
  assertEquals(appended[0].args[1].executionId, opened.executionId, "tool rows carry the execution id");
  assertEquals(appended[1].args[1].toolCallId, "tc2");

  const terminal = calls.find((c) => c.fn === "commitThreadTerminal");
  assertEquals(terminal?.args[2]?.role, "assistant");
  assertEquals(terminal?.args[2]?.content, "done: 3 files changed");
  assertEquals(state.threads.get(state.threadId).status, "done", "the task settles");
});

Deno.test("recordAcpTurn: a failed turn is recorded as an ERROR row, never a fake success", async () => {
  const { calls, deps, state } = fakeStore();
  await openAcpTurn({ task: "will fail", threadId: null }, deps);
  const executionId = acpExecutionId("pi", "ses-3");

  const res = await recordAcpTurn({
    threadId: state.threadId,
    executionId,
    text: "",
    ok: false,
    error: "harness connection closed (code 1011)",
  }, deps);

  assertEquals(res.ok, true, String(res.error));
  const terminal = calls.find((c) => c.fn === "commitThreadTerminal");
  assertEquals(terminal?.args[2]?.role, "error");
  assert(String(terminal?.args[2]?.content).includes("1011"), String(terminal?.args[2]?.content));
  assertEquals(state.threads.get(state.threadId).status, "error", "the task does not claim success");
});

Deno.test("acpExecutionId: UNIQUE per turn (a reused id would swallow every later answer)", () => {
  const a = acpExecutionId("pi", "ses-4");
  const b = acpExecutionId("pi", "ses-4");
  assert(a !== b, `two turns of ONE session must not share an execution id (got ${a})`);
  assert(a.includes("pi") && a.includes("ses-4"), `the id carries harness + session for provenance: ${a}`);
  // Distinct harnesses/sessions never collide, and odd input cannot inject.
  assert(acpExecutionId("claude code", "s") !== acpExecutionId("claude/code", "s"));
  assert(!acpExecutionId("a b", "c d").includes(" "));
});

Deno.test("acpToolRows: only tool events become rows, and each call keeps its id", () => {
  const rows = acpToolRows([
    { kind: "chunk", text: "hello" },
    { kind: "tool", toolCallId: "x", detail: "d1", status: "running" },
    { kind: "permission", detail: "allowed" },
  ], "exec-1");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].role, "tool");
  assertEquals(rows[0].toolCallId, "x");
  assertEquals(rows[0].executionId, "exec-1");
});
