// tests/harness-destructive-approval.test.ts — chrome-agent-platform-f3n2
//
// Harness destructive browser-tool calls raise an in-conversation owner approval
// card in the active ACP task container.
//
// Verifies:
//   1. Gated browser tools (close_tab, close_window, wipe_browsing_data, etc.)
//      raise an approval prompt in the container.
//   2. Owner Approve executes the mutation through the SW route and returns the
//      tool result to the harness.
//   3. Owner Deny skips execution and returns { ok: false, error: "denied" }
//      to the harness with error status on the tool card.
//   4. Non-gated tools (list_tabs, group_tabs) execute directly without raising
//      an approval card.
//   5. SW route checks destructiveActionPolicy: policy 'never' blocks even with
//      an approval flag (fail-closed defense).
// @ts-nocheck
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  ACP_GATED_BROWSER_TOOLS,
  formatBrowserToolApproval,
  runAcpTaskTurn,
} from "../extension/lib/acp-runner.js";

const containerStub = {
  appendAgent: () => ({ setAttribute: () => {}, remove: () => {} }),
  appendTool: () => ({ setAttribute: () => {} }),
  appendError: (m: string) => { throw new Error(m); },
  appendSystem: () => {},
};

Deno.test("f3n2: formatBrowserToolApproval produces descriptive cards for destructive actions", () => {
  const closeTab = formatBrowserToolApproval("close_tab", { tabId: 42 });
  assertStringIncludes(closeTab.title, "tab #42");

  const closeWin = formatBrowserToolApproval("close_window", { windowId: 7 });
  assertStringIncludes(closeWin.title, "window #7");

  const wipe = formatBrowserToolApproval("wipe_browsing_data", { dataTypes: ["cookies", "cache"] });
  assertStringIncludes(wipe.title, "cookies, cache");

  const rmBookmark = formatBrowserToolApproval("remove_bookmark", { id: "bm-99" });
  assertStringIncludes(rmBookmark.title, "bookmark #bm-99");
});

Deno.test("f3n2: gated tool raises approval card; owner Approve executes mutation and returns result", async () => {
  const promptedInputs: string[] = [];
  const toolCalls: any[] = [];
  const promptedApprovals: any[] = [];
  const toolCards: Array<{ name: string; status: string; detail?: string }> = [];

  const fakeClient = {
    connected: true,
    async connect() {},
    async initialize() {},
    async cancel() {},
    close() {},
    async newSession() { return { sessionId: "s-f3n2-1" }; },
    async loadSession() {},
    async prompt(_sid: string, text: string) {
      promptedInputs.push(text);
      if (promptedInputs.length === 1) {
        return {
          stopReason: "end_turn",
          text: 'Closing tab now:\n{"jsonrpc":"2.0","id":"c-close","method":"browser/call_tool","params":{"name":"close_tab","args":{"tabId":15}}}',
        };
      }
      return { stopReason: "end_turn", text: "Tab 15 has been closed." };
    },
  };

  const container = {
    appendAgent: (content: string) => ({
      setAttribute: () => {},
      remove: () => {},
    }),
    appendTool: (opts: any) => {
      const rec = { ...opts };
      toolCards.push(rec);
      return {
        setAttribute: (k: string, v: string) => {
          if (k === "tool-status") rec.status = v;
        },
      };
    },
  };

  // Mock permissionPrompter: simulates owner clicking "Approve"
  const permissionPrompter = async (prompt: any) => {
    promptedApprovals.push(prompt);
    return { optionId: "allow_once", answered: true };
  };

  const runtimeSend = async (type: string, body: any) => {
    toolCalls.push({ type, ...body });
    if (type === "browser.callTool" && body?.name === "close_tab" && body?.approved === true) {
      return { ok: true, closed: 15 };
    }
    return { ok: false, error: "not approved" };
  };

  const res = await runAcpTaskTurn({
    container,
    task: "close tab 15",
    isStale: () => false,
    clientFactory: () => fakeClient,
    permissionPrompter,
    runtimeSend,
  });

  assertEquals(res.ok, true);
  // 1. Approval card was shown for close_tab
  assertEquals(promptedApprovals.length, 1);
  assertStringIncludes(promptedApprovals[0].title, "tab #15");

  // 2. browser.callTool was dispatched with approved: true
  assertEquals(toolCalls.length, 1);
  assertEquals(toolCalls[0].name, "close_tab");
  assertEquals(toolCalls[0].approved, true);

  // 3. Harness received the tool success
  assertEquals(promptedInputs.length, 2);
  const secondPrompt = JSON.parse(promptedInputs[1]);
  assertEquals(secondPrompt.result.ok, true);
  assertEquals(secondPrompt.result.closed, 15);

  // 4. Tool card settled to done
  assertEquals(toolCards.length, 1);
  assertEquals(toolCards[0].status, "done");
});

Deno.test("f3n2: gated tool raises approval card; owner Deny skips execution and returns denied to harness", async () => {
  const promptedInputs: string[] = [];
  const toolCalls: any[] = [];
  const toolCards: Array<{ name: string; status: string; detail?: string }> = [];

  const fakeClient = {
    connected: true,
    async connect() {},
    async initialize() {},
    async cancel() {},
    close() {},
    async newSession() { return { sessionId: "s-f3n2-2" }; },
    async loadSession() {},
    async prompt(_sid: string, text: string) {
      promptedInputs.push(text);
      if (promptedInputs.length === 1) {
        return {
          stopReason: "end_turn",
          text: 'Wiping data:\n{"jsonrpc":"2.0","id":"c-wipe","method":"browser/call_tool","params":{"name":"wipe_browsing_data","args":{"dataTypes":["history"]}}}',
        };
      }
      return { stopReason: "end_turn", text: "Understood, I will not wipe history." };
    },
  };

  const container = {
    appendAgent: () => ({ setAttribute: () => {}, remove: () => {} }),
    appendTool: (opts: any) => {
      const rec = { ...opts };
      toolCards.push(rec);
      return {
        setAttribute: (k: string, v: string) => {
          if (k === "tool-status") rec.status = v;
        },
      };
    },
  };

  // Mock permissionPrompter: simulates owner clicking "Deny"
  const permissionPrompter = async () => {
    return { optionId: "deny", answered: true };
  };

  const runtimeSend = async (type: string, body: any) => {
    toolCalls.push({ type, ...body });
    return { ok: true };
  };

  const res = await runAcpTaskTurn({
    container,
    task: "wipe history",
    isStale: () => false,
    clientFactory: () => fakeClient,
    permissionPrompter,
    runtimeSend,
  });

  assertEquals(res.ok, true);

  // 1. Tool execution in SW was NEVER called!
  assertEquals(toolCalls.length, 0, "destructive tool must not be called when denied");

  // 2. Harness received { ok: false, error: 'denied' }
  assertEquals(promptedInputs.length, 2);
  const secondPrompt = JSON.parse(promptedInputs[1]);
  assertEquals(secondPrompt.result.ok, false);
  assertEquals(secondPrompt.result.error, "denied");

  // 3. Tool card settled to error
  assertEquals(toolCards.length, 1);
  assertEquals(toolCards[0].status, "error");
});

Deno.test("f3n2: non-gated tools execute directly without raising approval card", async () => {
  const promptedApprovals: any[] = [];
  const toolCalls: any[] = [];

  let promptedCount = 0;
  const fakeClient = {
    connected: true,
    async connect() {},
    async initialize() {},
    async cancel() {},
    close() {},
    async newSession() { return { sessionId: "s-f3n2-3" }; },
    async loadSession() {},
    async prompt(_sid: string, text: string) {
      promptedCount++;
      if (promptedCount === 1) {
        return {
          stopReason: "end_turn",
          text: 'Listing tabs:\n{"jsonrpc":"2.0","id":"c-list","method":"browser/call_tool","params":{"name":"list_tabs","args":{}}}',
        };
      }
      return { stopReason: "end_turn", text: "done" };
    },
  };

  const permissionPrompter = async (prompt: any) => {
    promptedApprovals.push(prompt);
    return { optionId: "allow_once", answered: true };
  };

  const runtimeSend = async (type: string, body: any) => {
    toolCalls.push({ type, ...body });
    return { count: 2, tabs: [{ id: 1 }, { id: 2 }] };
  };

  const res = await runAcpTaskTurn({
    container: containerStub,
    task: "list tabs",
    isStale: () => false,
    clientFactory: () => fakeClient,
    permissionPrompter,
    runtimeSend,
  });

  assertEquals(res.ok, true);
  assertEquals(promptedApprovals.length, 0, "non-gated tool must not trigger permissionPrompter");
  assertEquals(toolCalls.length, 1);
  assertEquals(toolCalls[0].name, "list_tabs");
  assertEquals(toolCalls[0].approved, undefined);
});
