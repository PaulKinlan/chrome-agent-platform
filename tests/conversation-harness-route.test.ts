// tests/conversation-harness-route.test.ts — chrome-agent-platform-i8fn
//
// The route a SELECTED ACP harness takes when it is not an @mention: the turn
// must reach the durable harness backend (`agent.run` carrying `harnessId`),
// never the named-agent route (`named-agent.run` with the harness id used as an
// agent id — there is no agent by that name, and a same-named agent would be
// silently substituted).
//
// EXECUTING: this drives the REAL extension/shared/conversation.js with a
// stubbed chrome runtime and asserts the message that actually went out. It is
// driven RED by the mutant that removes `&& !harnessId` from the named branch
// (arm 1 then calls named-agent.run), and GREEN restored.
// @ts-nocheck — the chrome mock is intentionally dynamic (no chrome.* types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";

type Sent = { type: string; [k: string]: unknown };

function makeContainer() {
  return {
    appendUser() {}, appendAgent() {}, appendSystem() {}, appendError() {},
    appendTool() { return { setAttribute() {} }; },
    setMessages() {}, clear() {}, resetPlan() {},
  };
}

function installChrome(sent: Sent[], { threadHarnessId = null } = {}) {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg: Sent, cb: (res: unknown) => void) {
        sent.push({ ...msg });
        if (msg.type === "provider.permission-summary") {
          queueMicrotask(() => cb({ ok: true, local: true }));
          return;
        }
        if (msg.type === "thread.get") {
          queueMicrotask(() => cb({ ok: true, thread: threadHarnessId ? { harnessId: threadHarnessId } : null }));
          return;
        }
        queueMicrotask(() => cb({ ok: true, threadId: "t_i8fn", executionId: "exec:i8fn", result: "done" }));
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
}

const routes = (sent: Sent[]) => sent.map((m) => m.type).join(", ");

Deno.test("i8fn: a selected ACP harness without an @mention routes to agent.run with harnessId, never named-agent.run", async () => {
  const sent: Sent[] = [];
  installChrome(sent);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  await runConversationTurn(makeContainer(), { text: "hello", agentId: "claude-code", agentKind: "acp" });
  const run = sent.find((m) => m.type === "agent.run");
  assert(run, `the turn must dispatch agent.run (sent: ${routes(sent)})`);
  assertEquals(run.harnessId, "claude-code", "the selected harness rides the durable harness backend");
  assertEquals(
    sent.some((m) => m.type === "named-agent.run"),
    false,
    `a harness id must never take the named-agent route (sent: ${routes(sent)})`,
  );
});

Deno.test("i8fn: an ACP @mention keeps its harnessId on agent.run and never reaches the named route", async () => {
  const sent: Sent[] = [];
  installChrome(sent);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  await runConversationTurn(makeContainer(), { text: "hello", mention: { kind: "acp", id: "codex" } });
  const run = sent.find((m) => m.type === "agent.run");
  assert(run, `the mention turn must dispatch agent.run (sent: ${routes(sent)})`);
  assertEquals(run.harnessId, "codex", "the mentioned harness travels as harnessId");
  assertEquals(sent.some((m) => m.type === "named-agent.run"), false, `never the named route (sent: ${routes(sent)})`);
});

Deno.test("i8fn: a resumed thread carries its saved harnessId into agent.run", async () => {
  const sent: Sent[] = [];
  installChrome(sent, { threadHarnessId: "claude-code" });
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  await runConversationTurn(makeContainer(), { text: "again", threadId: "t_saved" });
  const run = sent.find((m) => m.type === "agent.run");
  assert(run, `the resumed turn must dispatch agent.run (sent: ${routes(sent)})`);
  assertEquals(run.harnessId, "claude-code", "the thread's persisted harness selection is restored");
  assertEquals(sent.some((m) => m.type === "named-agent.run"), false, `never the named route (sent: ${routes(sent)})`);
});
