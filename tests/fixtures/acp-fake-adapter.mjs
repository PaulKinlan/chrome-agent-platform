// tests/fixtures/acp-fake-adapter.mjs — deterministic stdio JSON-RPC ACP
// adapter used by tests/acp-end-to-end.test.ts DEFAULT mode. Speaks the same
// newline-delimited JSON-RPC framing as pi-acp over stdin/stdout, so the
// bridge's WebSocket→stdio plumbing is exercised end-to-end WITHOUT a live
// pi harness (no tokens, no machine state, runs anywhere).
//
// The LIVE pi journey is opt-in: `npm run test:acp:live` (CAP_ACP_LIVE=1).

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-acp-adapter", title: "Deterministic ACP test adapter", version: "0.0.1" },
          authMethods: [],
          agentCapabilities: { loadSession: true },
        },
      });
      break;
    case "session/new":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { sessionId: "ses_fake_1", models: { currentModelId: "fake/model" } },
      });
      // Mirror pi-acp: a fresh session advertises its commands.
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses_fake_1",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "skill:beads", description: "bd task tracking skill" },
              { name: "skill:fake", description: "fixture skill" },
            ],
          },
        },
      });
      break;
    case "session/load":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    case "session/prompt": {
      const sid = msg.params?.sessionId ?? "";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: sid, update: { sessionUpdate: "agent_thought_chunk", content: { text: "Fake reasoning…" } } },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: sid, update: { sessionUpdate: "tool_call", title: "fake tool call" } },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { text: "fake reply" } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      break;
    }
    case "session/cancel":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    default:
      // Unknown method (e.g. authenticate): report method-not-found so the
      // client gets a well-formed error rather than hanging.
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `${msg.method} not supported by fake adapter` } });
  }
}
