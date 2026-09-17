// tests/acp-client.test.ts — Unit tests for the core ACP client.
// CAP-FB-20260912-ACP-INTEGRATION-01 (tracking epic chrome-agent-platform-qlho)

import { assert, assertEquals } from "jsr:@std/assert@1";
import { AcpClient, acpAllowOptionId, acpDenyOptionId, type AcpTurnEvent } from "../extension/lib/acp-client.js";

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

/** The ACP options a harness offers, in the order pi-acp sends them. */
const ACP_OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "deny" },
];

/** Drive one inbound permission request and return the optionId answered. */
async function answerPermission(client: AcpClient, options = ACP_OPTIONS) {
  const answered: string[] = [];
  client.customTransport.onSend = (msg: any) => {
    if (msg.id === 77 && msg.result?.outcome) answered.push(msg.result.outcome.optionId);
  };
  await client.handleMessage({
    jsonrpc: "2.0",
    id: 77,
    method: "session/request_permission",
    params: { toolCall: { title: "Run bash: rm -rf ./demo-dir" }, options },
  });
  return answered[0] ?? null;
}

Deno.test("AcpClient: a configured gate answers with the owner's chosen option", async () => {
  const chosen: Array<any> = [];
  const client = new AcpClient({
    transport: new MockTransport(),
    permissionHandler: (req: any) => { chosen.push(req); return Promise.resolve("allow_once"); },
  });
  const answered = await answerPermission(client);
  assertEquals(answered, "allow_once");
  // The gate saw what the owner needs to judge: the tool call + the options.
  assertEquals(chosen.length, 1);
  assertEquals(chosen[0].title, "Run bash: rm -rf ./demo-dir");
  assertEquals(chosen[0].options.length, 3);
});

Deno.test("AcpClient: an unanswered request is DENIED, never silently allowed", async () => {
  const client = new AcpClient({ transport: new MockTransport(), permissionHandler: () => Promise.resolve(null) });
  const answered = await answerPermission(client);
  assertEquals(answered, "deny");
  assert(!/allow/.test(String(answered)), "a request the owner never approved must not be answered with an allow");
});

Deno.test("AcpClient: a gate that THROWS denies (failure is not consent)", async () => {
  const client = new AcpClient({
    transport: new MockTransport(),
    permissionHandler: () => { throw new Error("card exploded"); },
  });
  const answered = await answerPermission(client);
  assertEquals(answered, "deny");
});

Deno.test("AcpClient: a gate that answers with a non-string is treated as no answer (deny)", async () => {
  // The runner's gate resolves a decision OBJECT; only its optionId string may
  // reach the wire (a mutant put "[object Object]" on the wire — the fixture saw
  // it as "permission: [object Object]").
  const client = new AcpClient({
    transport: new MockTransport(),
    permissionHandler: () => Promise.resolve({ optionId: "allow_once", answered: true } as any),
  });
  const answered = await answerPermission(client);
  assertEquals(answered, "deny");
});

Deno.test("AcpClient: with NO gate configured the explicit auto mode still answers an allow", async () => {
  // The auto-grant is now reachable only by NOT configuring a gate — the mode
  // acp-runner.js sets deliberately from kv `acp.permissions = "auto"`.
  const client = new AcpClient({ transport: new MockTransport() });
  const answered = await answerPermission(client);
  assertEquals(answered, "allow_once", "auto mode picks the NARROWEST allow");
});

Deno.test("acpAllowOptionId/acpDenyOptionId: narrowest allow; deny only when offered", () => {
  assertEquals(acpAllowOptionId(ACP_OPTIONS), "allow_once");
  assertEquals(acpAllowOptionId([{ optionId: "allow_always", kind: "allow_always" }]), "allow_always");
  assertEquals(acpAllowOptionId([]), null);
  assertEquals(acpDenyOptionId(ACP_OPTIONS), "deny");
  // A harness that offers no deny option gets NO selection — which ACP reads as
  // "nothing chosen", never as approval.
  assertEquals(acpDenyOptionId([{ optionId: "allow_once", kind: "allow_once" }]), null);
});
