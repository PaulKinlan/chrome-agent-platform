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

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";

type Sent = { type: string; [k: string]: unknown };

function makeContainer(errors: Array<{ text: string; meta?: unknown }> = []) {
  return {
    appendUser() {}, appendAgent() {}, appendSystem() {},
    appendError(text: string, meta?: unknown) { errors.push({ text, meta }); },
    appendTool() { return { setAttribute() {} }; },
    setMessages() {}, clear() {}, resetPlan() {},
  };
}

function installChrome(sent: Sent[], { threadHarnessId = null, permissionSummaryHandler = null } = {}) {
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg: Sent, cb: (res: unknown) => void) {
        sent.push({ ...msg });
        if (msg.type === "provider.permission-summary") {
          if (permissionSummaryHandler) {
            permissionSummaryHandler(msg, cb);
            return;
          }
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

Deno.test("w48gp: mentioning @pi in composer reports honest tool mount failure, never invalid provider origin", async () => {
  const sent: Sent[] = [];
  const errors: Array<{ text: string; meta?: unknown }> = [];
  const piErrMsg = "pi-acp 0.0.33 does not mount CAP tools. Use Claude Code or Codex until Pi tool registration is available.";
  installChrome(sent, {
    permissionSummaryHandler: (msg, cb) => {
      assertEquals(msg.harnessId, "pi");
      queueMicrotask(() => cb({
        ok: false,
        error: piErrMsg,
        reason: piErrMsg,
        errorCategory: "harness-config",
        errorAction: "Use Claude Code or Codex until Pi tool registration is available.",
      }));
    },
  });
  const container = makeContainer(errors);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const res = await runConversationTurn(container, { text: "search tabs", mention: { kind: "acp", id: "pi" } });

  // 1. Preflight checked provider.permission-summary with harnessId: "pi".
  const summaryMsg = sent.find((m) => m.type === "provider.permission-summary");
  assert(summaryMsg, "permission summary was sent");
  assertEquals(summaryMsg.harnessId, "pi");

  // 2. agent.run was not dispatched because preflight failed.
  assertEquals(sent.some((m) => m.type === "agent.run"), false, "agent.run must not be dispatched when preflight fails");

  // 3. Returned result is honest and contains the real ACP error message.
  assertEquals(res.ok, false);
  assertEquals(res.failed, true);
  assertEquals(res.error, piErrMsg);
  assertEquals(res.errorCategory, "harness-config");
  assertEquals(res.errorAction, "Use Claude Code or Codex until Pi tool registration is available.");
  assertEquals(res.errorReason, piErrMsg);

  // 4. Must NOT claim the provider endpoint is not configured or origin is invalid.
  assert(!res.error.includes("provider endpoint is not configured"), "must not blame provider endpoint");
  assert(!res.error.includes("configured provider origin is invalid"), "must not claim origin is invalid");
  assert(!String(res.errorAction).includes("Settings → Providers"), "must not redirect to Settings -> Providers");

  // 5. Container received honest error bubble.
  assertEquals(errors.length, 1);
  assertEquals(errors[0].text, piErrMsg);
  assertEquals(errors[0].meta, {
    reason: piErrMsg,
    action: "Use Claude Code or Codex until Pi tool registration is available.",
    category: "harness-config",
  });
});

Deno.test("w48gp: selected Pi harness without mention reports honest tool mount failure, never invalid provider origin", async () => {
  const sent: Sent[] = [];
  const errors: Array<{ text: string; meta?: unknown }> = [];
  const piErrMsg = "pi-acp 0.0.33 does not mount CAP tools. Use Claude Code or Codex until Pi tool registration is available.";
  installChrome(sent, {
    permissionSummaryHandler: (msg, cb) => {
      assertEquals(msg.harnessId, "pi");
      queueMicrotask(() => cb({
        ok: false,
        error: piErrMsg,
        reason: piErrMsg,
        errorCategory: "harness-config",
        errorAction: "Use Claude Code or Codex until Pi tool registration is available.",
      }));
    },
  });
  const container = makeContainer(errors);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const res = await runConversationTurn(container, { text: "search tabs", agentId: "pi", agentKind: "acp" });

  assertEquals(res.ok, false);
  assertEquals(res.failed, true);
  assertEquals(res.error, piErrMsg);
  assertEquals(res.errorCategory, "harness-config");
  assertEquals(res.errorAction, "Use Claude Code or Codex until Pi tool registration is available.");
  assert(!res.error.includes("provider endpoint is not configured"));
  assert(!res.error.includes("configured provider origin is invalid"));
});

Deno.test("w48gp: worker timeout on ordinary provider does NOT report harness problem (P1)", async () => {
  const sent: Sent[] = [];
  const errors: Array<{ text: string; meta?: unknown }> = [];
  const timeoutMsg = "the agent worker didn't answer — it may be busy (retry)";
  installChrome(sent, {
    permissionSummaryHandler: (msg, cb) => {
      // Ordinary provider run without harnessId
      assertEquals(msg.harnessId, undefined);
      queueMicrotask(() => cb({
        ok: false,
        error: timeoutMsg,
      }));
    },
  });
  const container = makeContainer(errors);
  const { runConversationTurn } = await import("../extension/shared/conversation.js");
  const res = await runConversationTurn(container, { text: "hello ordinary task" });

  assertEquals(res.ok, false);
  assertEquals(res.failed, true);
  assertEquals(res.errorCategory, "timeout");
  assertEquals(res.errorAction, "Wait a moment and run this task again.");
  assert(!res.error.includes("does not mount CAP tools"));
  assert(!String(res.errorAction).includes("Pi tool registration"));
  assertNotEquals(res.errorCategory, "harness-config");
});
