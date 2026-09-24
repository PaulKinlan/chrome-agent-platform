// tests/acp-browser-tool-loop.test.ts — in-turn browser tool execution loop
//
// Follow-up for chrome-agent-platform-2amt (Paul live reproduction):
// Models outputting {"jsonrpc":"2.0",...,"method":"browser/call_tool",...}
// in their text stream must be intercepted, have their tool calls executed
// via the browser.callTool service worker route, display clean text in the chat
// bubble, render tool cards, and feed the tool result back to the harness.
// @ts-nocheck
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { extractBrowserToolCalls, runAcpTaskTurn } from "../extension/lib/acp-runner.js";

// ── 1. extractBrowserToolCalls: parsing and text cleaning ────────────────────

Deno.test("2amt loop: extracts bare single-line tool call and cleans display text", () => {
  const raw = 'I will list your open browser tabs now.\n\n{"jsonrpc":"2.0","id":"list-1","method":"browser/call_tool","params":{"name":"list_tabs","args":{}}}';
  const { calls, cleanText } = extractBrowserToolCalls(raw);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].id, "list-1");
  assertEquals(calls[0].name, "list_tabs");
  assertEquals(calls[0].args, {});
  assertEquals(cleanText, "I will list your open browser tabs now.");
});

Deno.test("2amt loop: extracts markdown-fenced tool call and cleans display text", () => {
  const raw = 'I will group your tabs:\n```json\n{\n  "jsonrpc": "2.0",\n  "id": "grp-1",\n  "method": "browser/call_tool",\n  "params": {\n    "name": "group_tabs",\n    "args": { "tabIds": [1, 2], "title": "Research" }\n  }\n}\n```\nDone.';
  const { calls, cleanText } = extractBrowserToolCalls(raw);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].id, "grp-1");
  assertEquals(calls[0].name, "group_tabs");
  assertEquals(calls[0].args, { tabIds: [1, 2], title: "Research" });
  assertEquals(cleanText, "I will group your tabs:\n\nDone.");
});

Deno.test("2amt loop: returns unchanged text and empty calls when no tool call exists", () => {
  const text = "Hello! I am ready to help you organize your browser.";
  const { calls, cleanText } = extractBrowserToolCalls(text);
  assertEquals(calls.length, 0);
  assertEquals(cleanText, text);
});

// ── 2. in-turn execution loop through runAcpTaskTurn ─────────────────────────

Deno.test("2amt loop: intercepts tool call, displays clean text, renders tool card, and returns result to harness", async () => {
  const promptedInputs: string[] = [];
  const toolExecutions: Array<{ type: string; name: string; args: any }> = [];
  const appendedTools: Array<{ name: string; status: string; detail?: string }> = [];
  let agentBubbleContent = "";

  const fakeClient = {
    connected: true,
    async connect() {},
    async initialize() {},
    async cancel() {},
    close() {},
    async newSession() { return { sessionId: "sess-loop-1" }; },
    async loadSession() {},
    async prompt(_sid: string, text: string) {
      promptedInputs.push(text);
      if (promptedInputs.length === 1) {
        // Hop 1: model outputs text + tool call JSON
        return {
          stopReason: "end_turn",
          text: 'I will list your open tabs now.\n\n{"jsonrpc":"2.0","id":"c-1","method":"browser/call_tool","params":{"name":"list_tabs","args":{}}}',
        };
      }
      if (promptedInputs.length === 2) {
        // Hop 2: model receives tool result and outputs final message
        return {
          stopReason: "end_turn",
          text: "You have 3 tabs open.",
        };
      }
      return { stopReason: "end_turn", text: "" };
    },
  };

  const container = {
    appendAgent: (content: string) => {
      agentBubbleContent = content;
      return {
        setAttribute: (_k: string, v: string) => { agentBubbleContent = v; },
      };
    },
    appendTool: (opts: any) => {
      const toolRecord = { ...opts };
      appendedTools.push(toolRecord);
      return {
        setAttribute: (k: string, v: string) => {
          if (k === "tool-status") toolRecord.status = v;
        },
      };
    },
    appendError: (m: string) => { throw new Error(m); },
  };

  const runtimeSend = async (type: string, body: any) => {
    toolExecutions.push({ type, name: body?.name, args: body?.args });
    if (type === "browser.callTool" && body?.name === "list_tabs") {
      return { count: 3, tabs: [{ id: 10 }, { id: 11 }, { id: 12 }] };
    }
    return { ok: true };
  };

  const res = await runAcpTaskTurn({
    container,
    task: "group my tabs",
    harnessId: "claude",
    isStale: () => false,
    clientFactory: () => fakeClient,
    runtimeSend,
    onStatus: () => {},
    onRunRegistered: () => {},
  });

  assertEquals(res.ok, true, JSON.stringify(res));
  assertEquals(promptedInputs.length, 2, "must loop and prompt harness twice");
  assertStringIncludes(promptedInputs[0], "group my tabs", "first prompt is the task");

  // Second prompt must be the JSON-RPC result frame sent back to harness
  const secondPromptParsed = JSON.parse(promptedInputs[1]);
  assertEquals(secondPromptParsed.jsonrpc, "2.0");
  assertEquals(secondPromptParsed.id, "c-1");
  assertEquals(secondPromptParsed.result.count, 3);

  // Tool execution verified
  assertEquals(toolExecutions.length, 1);
  assertEquals(toolExecutions[0].name, "list_tabs");

  // Tool card status transitioned to done
  assertEquals(appendedTools.length, 1);
  assertEquals(appendedTools[0].status, "done");

  // Chat bubble showed clean text without raw JSON
  assertEquals(agentBubbleContent, "You have 3 tabs open.");
  assertEquals(res.result, "You have 3 tabs open.");
});

Deno.test("2amt loop: multi-hop chaining (list_tabs -> group_tabs -> final message)", async () => {
  const promptedInputs: string[] = [];
  const toolExecutions: string[] = [];

  const fakeClient = {
    connected: true,
    async connect() {},
    async initialize() {},
    async cancel() {},
    close() {},
    async newSession() { return { sessionId: "sess-loop-2" }; },
    async loadSession() {},
    async prompt(_sid: string, text: string) {
      promptedInputs.push(text);
      if (promptedInputs.length === 1) {
        return {
          stopReason: "end_turn",
          text: '{"jsonrpc":"2.0","id":"call-1","method":"browser/call_tool","params":{"name":"list_tabs","args":{}}}',
        };
      }
      if (promptedInputs.length === 2) {
        return {
          stopReason: "end_turn",
          text: 'Found tabs. Grouping:\n{"jsonrpc":"2.0","id":"call-2","method":"browser/call_tool","params":{"name":"group_tabs","args":{"tabIds":[1,2],"title":"Work"}}}',
        };
      }
      return {
        stopReason: "end_turn",
        text: "Tabs have been grouped into Work.",
      };
    },
  };

  const container = {
    appendAgent: (content: string) => ({
      setAttribute: () => {},
      remove: () => {},
    }),
    appendTool: () => ({
      setAttribute: () => {},
    }),
  };

  const runtimeSend = async (type: string, body: any) => {
    toolExecutions.push(body?.name);
    if (body?.name === "list_tabs") return { count: 2, tabs: [{ id: 1 }, { id: 2 }] };
    if (body?.name === "group_tabs") return { ok: true, groupId: 77 };
    return { ok: true };
  };

  const res = await runAcpTaskTurn({
    container,
    task: "group my tabs",
    harnessId: "pi",
    isStale: () => false,
    clientFactory: () => fakeClient,
    runtimeSend,
    onStatus: () => {},
    onRunRegistered: () => {},
  });

  assertEquals(res.ok, true);
  assertEquals(promptedInputs.length, 3, "must execute 3 prompt hops (initial, list_tabs result, group_tabs result)");
  assertEquals(toolExecutions, ["list_tabs", "group_tabs"]);
  assertEquals(res.result, "Tabs have been grouped into Work.");
});

Deno.test("2amt loop: bounds infinite tool loop to 5 hops maximum", async () => {
  let hopCount = 0;
  const fakeClient = {
    connected: true,
    async connect() {},
    async initialize() {},
    async cancel() {},
    close() {},
    async newSession() { return { sessionId: "sess-loop-3" }; },
    async loadSession() {},
    async prompt() {
      hopCount++;
      // Endless tool calls
      return {
        stopReason: "end_turn",
        text: `{"jsonrpc":"2.0","id":"hop-${hopCount}","method":"browser/call_tool","params":{"name":"list_tabs","args":{}}}`,
      };
    },
  };

  const container = {
    appendAgent: () => ({ setAttribute: () => {}, remove: () => {} }),
    appendTool: () => ({ setAttribute: () => {} }),
  };

  const res = await runAcpTaskTurn({
    container,
    task: "loop endlessly",
    isStale: () => false,
    clientFactory: () => fakeClient,
    runtimeSend: async () => ({ count: 1, tabs: [{ id: 1 }] }),
  });

  assertEquals(res.ok, true);
  assertEquals(hopCount, 5, "must bound loop to exactly 5 hops");
});
