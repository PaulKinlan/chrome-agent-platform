// tests/acp-client.test.ts — Unit tests for the core ACP client.
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { AcpClient, type AcpTurnEvent } from "../extension/lib/acp-client.js";

/** Mock transport simulating bidirectional JSON-RPC frames */
class MockTransport {
  public sent: string[] = [];
  public onSend: ((msg: any) => void) | null = null;
  public permissionAnswer: string | null = null;

  send(data: string) {
    this.sent.push(data);
    this.onSend?.(JSON.parse(data));
  }
}

Deno.test("AcpClient: performs initialize handshake and records agent capabilities", async () => {
  const transport = new MockTransport();
  const client = new AcpClient({ transport });

  transport.onSend = (msg: any) => {
    if (msg.method === "initialize") {
      client.handleMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "pi-acp", title: "pi ACP adapter", version: "0.0.33" },
          authMethods: [],
        },
      });
    }
  };

  await client.connect();
  const init = await client.initialize();

  assertEquals(init.protocolVersion, 1);
  assertEquals(client.agentInfo?.name, "pi-acp");
  assertEquals(transport.sent.length, 1);
  const sentMsg = JSON.parse(transport.sent[0]);
  assertEquals(sentMsg.method, "initialize");
  assertEquals(sentMsg.params.protocolVersion, 1);
});

Deno.test("AcpClient: creates a new session and tracks session ID", async () => {
  const transport = new MockTransport();
  const client = new AcpClient({ transport, defaultCwd: "/test/dir" });

  transport.onSend = (msg: any) => {
    if (msg.method === "session/new") {
      client.handleMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          sessionId: "ses_abc123",
          models: { currentModelId: "deepseek/deepseek-v4-pro" },
        },
      });
    }
  };

  await client.connect();
  const session = await client.newSession({ cwd: "/test/custom" });

  assertEquals(session.sessionId, "ses_abc123");
  assertEquals(client.activeSessionId, "ses_abc123");
  const sentMsg = JSON.parse(transport.sent[0]);
  assertEquals(sentMsg.method, "session/new");
  assertEquals(sentMsg.params.cwd, "/test/custom");
});

Deno.test("AcpClient: loads and resumes an existing session", async () => {
  const transport = new MockTransport();
  const client = new AcpClient({ transport });

  transport.onSend = (msg: any) => {
    if (msg.method === "session/load") {
      client.handleMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: {},
      });
    }
  };

  await client.connect();
  const res = await client.loadSession({ sessionId: "ses_prev_456" });

  assertEquals(res.sessionId, "ses_prev_456");
  assertEquals(res.resumed, true);
  assertEquals(client.activeSessionId, "ses_prev_456");
});

Deno.test("AcpClient: dispatches prompt and streams thoughts, chunks, and tool updates", async () => {
  const transport = new MockTransport();
  const client = new AcpClient({ transport });
  const events: AcpTurnEvent[] = [];

  transport.onSend = (msg: any) => {
    if (msg.method === "session/prompt") {
      // Stream thought
      client.handleMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { text: "Analyzing task..." } },
        },
      });
      // Stream tool call
      client.handleMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: "tool_call", title: "Running bash: ls" },
        },
      });
      // Stream message chunk
      client.handleMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: msg.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { text: "Task completed successfully." } },
        },
      });
      // Turn end
      client.handleMessage({
        jsonrpc: "2.0",
        id: msg.id,
        result: { stopReason: "end_turn" },
      });
    }
  };

  await client.connect();
  const turn = await client.prompt("ses_abc", "Run command", (ev) => events.push(ev));

  assertEquals(turn.stopReason, "end_turn");
  assertEquals(turn.text, "Task completed successfully.");
  assertEquals(events.length, 3);
  assertEquals(events[0].kind, "thought");
  assertEquals(events[0].text, "Analyzing task...");
  assertEquals(events[1].kind, "tool");
  assertEquals(events[1].detail, "Running bash: ls");
  assertEquals(events[2].kind, "chunk");
  assertEquals(events[2].text, "Task completed successfully.");
});

Deno.test("AcpClient: answers session/request_permission with auto-allow option", async () => {
  const transport = new MockTransport();
  const client = new AcpClient({ transport });
  const events: AcpTurnEvent[] = [];

  transport.onSend = (msg: any) => {
    if (msg.id === 99 && msg.result?.outcome?.optionId) {
      transport.permissionAnswer = msg.result.outcome.optionId;
    }
  };

  await client.connect();
  client.activeTurnListener = (ev) => events.push(ev);

  // Simulate inbound agent request
  await client.handleMessage({
    jsonrpc: "2.0",
    id: 99,
    method: "session/request_permission",
    params: {
      toolCall: { title: "Execute git commit" },
      options: [
        { optionId: "opt_allow", name: "Allow execution", kind: "allow" },
        { optionId: "opt_deny", name: "Deny", kind: "deny" },
      ],
    },
  });

  assertEquals(transport.permissionAnswer, "opt_allow");
  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "permission");
  assert(events[0].detail?.includes("Execute git commit → opt_allow"));
});
