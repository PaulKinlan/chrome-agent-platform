// tests/fixtures/acp-fake-adapter.mjs — deterministic stdio JSON-RPC ACP
// adapter used by tests/acp-end-to-end.test.ts DEFAULT mode. Speaks the same
// newline-delimited JSON-RPC framing as pi-acp over stdin/stdout, so the
// bridge's WebSocket→stdio plumbing is exercised end-to-end WITHOUT a live
// pi harness (no tokens, no machine state, runs anywhere).
//
// The LIVE pi journey is opt-in: `npm run test:acp:live` (CAP_ACP_LIVE=1).

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

// Optional frame log (CAP_ACP_FIXTURE_LOG): every inbound request and outbound
// frame as one JSON line, so a test can assert WHAT the client asked the
// harness for (e.g. session/new on turn 1, session/load on turn 2) instead of
// inferring it from a rendered string.
import { appendFileSync } from "node:fs";
const LOG = process.env.CAP_ACP_FIXTURE_LOG ?? "";
// Hold a prompt whose TEXT contains CAP_ACP_FIXTURE_HOLD_TEXT open until a
// session/cancel arrives (so a test can prove a newer turn really cancels the
// turn already running). Selected by CONTENT, not arrival order: the bridge
// spawns a fresh adapter per connection, so "the first prompt" would hold the
// superseding turn too.
const HOLD_TEXT = process.env.CAP_ACP_FIXTURE_HOLD_TEXT ?? "";
let pendingPermissionId = null;
let pendingPromptId = null;
let lastPermissionAnswer = "none";
let lastSessionId = "";
// With this set, a prompt first asks the CLIENT for permission (the ACP
// session/request_permission flow) and only then completes — carrying the answer
// it received, so a test can assert what the harness was actually told.
const ASK_PERMISSION = process.env.CAP_ACP_FIXTURE_ASK_PERMISSION === "1";
// With this set, a cancel does NOT settle the held prompt, so the socket close
// the successor performs is what rejects it (the error path a superseded turn
// must render NOTHING for).
const IGNORE_CANCEL = process.env.CAP_ACP_FIXTURE_IGNORE_CANCEL === "1";
let heldPromptId = null;
function log(dir, msg) {
  if (!LOG) return;
  try { appendFileSync(LOG, JSON.stringify({ dir, msg }) + "\n"); } catch { /* logging is best-effort */ }
}

function sendAndLog(msg) {
  log("out", msg);
  send(msg);
}

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
  log("in", msg);
  // A response to a permission request WE sent: remember the option and finish
  // the turn that asked for it.
  if (msg.id !== undefined && msg.result !== undefined && pendingPermissionId === msg.id) {
    pendingPermissionId = null;
    const optionId = msg.result?.outcome?.optionId ?? "none";
    lastPermissionAnswer = optionId;
    if (pendingPromptId != null) {
      const id = pendingPromptId;
      pendingPromptId = null;
      sendAndLog({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: lastSessionId, update: { sessionUpdate: "agent_message_chunk", content: { text: `fake reply (permission: ${optionId})` } } },
      });
      sendAndLog({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    }
    return;
  }
  switch (msg.method) {
    case "initialize":
      sendAndLog({
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
      sendAndLog({
        jsonrpc: "2.0",
        id: msg.id,
        result: { sessionId: "ses_fake_1", models: { currentModelId: "fake/model" } },
      });
      // Mirror pi-acp: a fresh session advertises its commands.
      sendAndLog({
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
      sendAndLog({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    case "session/prompt": {
      const sid = msg.params?.sessionId ?? "";
      const promptText = (Array.isArray(msg.params?.prompt) ? msg.params.prompt : [])
        .map((p) => (typeof p?.text === "string" ? p.text : "")).join(" ");
      lastSessionId = sid;
      if (ASK_PERMISSION && pendingPermissionId === null) {
        // ONE permission request per connection, then the prompt completes with
        // whatever the client answered.
        pendingPromptId = msg.id;
        pendingPermissionId = 9000 + (msg.id ?? 0);
        sendAndLog({
          jsonrpc: "2.0",
          id: pendingPermissionId,
          method: "session/request_permission",
          params: {
            sessionId: sid,
            toolCall: { toolCallId: "tc_perm_1", title: "Run bash: rm -rf ./demo-dir" },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
              { optionId: "deny", name: "Deny", kind: "deny" },
            ],
          },
        });
        break;
      }
      if (HOLD_TEXT && promptText.includes(HOLD_TEXT)) {
        heldPromptId = msg.id;
        sendAndLog({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: sid, update: { sessionUpdate: "agent_thought_chunk", content: { text: "Holding the first prompt…" } } },
        });
        break;
      }
      sendAndLog({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: sid, update: { sessionUpdate: "agent_thought_chunk", content: { text: "Fake reasoning…" } } },
      });
      sendAndLog({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "tc_fake_1", title: "fake tool call", status: "in_progress" } },
      });
      sendAndLog({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "tc_fake_1", title: "fake tool call", status: "completed" } },
      });
      sendAndLog({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { text: "fake reply" } } },
      });
      sendAndLog({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      break;
    }
    case "session/cancel":
      // Settle the held prompt so the cancelled turn ends instead of hanging.
      if (heldPromptId != null && !IGNORE_CANCEL) {
        sendAndLog({ jsonrpc: "2.0", id: heldPromptId, result: { stopReason: "cancelled" } });
        heldPromptId = null;
      }
      sendAndLog({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    default:
      // Unknown method (e.g. authenticate): report method-not-found so the
      // client gets a well-formed error rather than hanging.
      sendAndLog({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `${msg.method} not supported by fake adapter` } });
  }
}
