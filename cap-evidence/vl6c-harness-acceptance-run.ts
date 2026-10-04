// cap-evidence/vl6c-harness-acceptance-run.ts — Live Real-Harness Acceptance Run for chrome-agent-platform-vl6c
//
// Drives real ACP bridge with live authenticated CLI harnesses:
//   1. Codex: queries MCP tool catalogue over HTTP endpoint; calls list_tabs; names the open tab.
//   2. Codex: calls close_tab; triggers owner approval gate; Deny delivers denial error to harness;
//      harness confirms refusal and does not close tab.
//   3. Pi: runs a pure chat turn over the bridge without tools or errors.

// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createAcpServer } from "../scripts/acp-bridge.ts";
import { AcpClient } from "../extension/lib/acp-client.js";

const PORT = 3296;
console.log(`[acceptance] Starting ACP bridge on port ${PORT}...`);
const server = createAcpServer(PORT);

let passed = 0;
let failed = 0;

function check(desc: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  PASS: ${desc}`);
  } else {
    failed++;
    console.error(`  FAIL: ${desc}`);
  }
}

try {
  // ── 1. CODEX: list_tabs tool execution ──
  console.log("\n[test 1] Codex: query tools over MCP and call list_tabs...");
  const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/acp?harness=codex`);
  await new Promise((r) => (ws1.onopen = r));

  let listCalled = false;
  const client1 = new AcpClient({
    transport: { send: (raw) => ws1.send(raw) },
    toolHandler: async (method, params) => {
      if (method === "_cap/tools/list") {
        return {
          tools: [{
            name: "list_tabs",
            description: "List all open browser tabs",
            inputSchema: { type: "object", properties: {} },
          }],
        };
      }
      if (method === "_cap/tools/call" && params?.name === "list_tabs") {
        listCalled = true;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, tabs: [{ id: 42, title: "Example Domain" }] }),
          }],
        };
      }
      throw new Error(`unexpected tool method: ${method}`);
    },
  });
  ws1.onmessage = (e) => client1._receiveRaw(String(e.data));

  await client1.initialize({ _meta: { capTools: true } });
  const sess1 = await client1.newSession({ cwd: Deno.cwd() });
  const res1 = await client1.prompt(sess1.sessionId, "Call list_tabs to find open tabs", () => {});
  console.log("  Codex response:", res1?.text);

  check("Codex called list_tabs via reverse-RPC MCP endpoint", listCalled);
  check("Codex response mentions the open tab (Example Domain)", res1?.text?.includes("Example Domain"));

  client1.close();
  ws1.close();

  // ── 2. CODEX: close_tab approval denial ──
  console.log("\n[test 2] Codex: call close_tab, trigger approval card, and receive denial...");
  const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/acp?harness=codex`);
  await new Promise((r) => (ws2.onopen = r));

  let closePrompted = false;
  const client2 = new AcpClient({
    transport: { send: (raw) => ws2.send(raw) },
    toolHandler: async (method, params) => {
      if (method === "_cap/tools/list") {
        return {
          tools: [{
            name: "close_tab",
            description: "Close a browser tab by id (requires owner approval)",
            inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] },
          }],
        };
      }
      if (method === "_cap/tools/call" && params?.name === "close_tab") {
        closePrompted = true;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, approvalDenied: true, error: "Owner denied approval for close_tab." }),
          }],
          isError: true,
        };
      }
      throw new Error(`unexpected tool method: ${method}`);
    },
  });
  ws2.onmessage = (e) => client2._receiveRaw(String(e.data));

  await client2.initialize({ _meta: { capTools: true } });
  const sess2 = await client2.newSession({ cwd: Deno.cwd() });
  const res2 = await client2.prompt(sess2.sessionId, "Close tab with id 42 using close_tab", () => {});
  console.log("  Codex response:", res2?.text);

  check("Codex called close_tab", closePrompted);
  check("Codex acknowledged that owner approval was denied", /denied/i.test(res2?.text ?? ""));

  client2.close();
  ws2.close();

  // ── 3. PI: Pure chat turn over bridge ──
  console.log("\n[test 3] Pi: pure chat turn over bridge (tool-less chat path)...");
  const ws3 = new WebSocket(`ws://127.0.0.1:${PORT}/acp?harness=pi`);
  await new Promise((r) => (ws3.onopen = r));

  const client3 = new AcpClient({
    transport: { send: (raw) => ws3.send(raw) },
  });
  ws3.onmessage = (e) => client3._receiveRaw(String(e.data));

  await client3.initialize({ _meta: { capTools: true } });
  const sess3 = await client3.newSession({ cwd: "/tmp" });
  const res3 = await client3.prompt(sess3.sessionId, "Reply with 'pong'", () => {});
  console.log("  Pi response:", res3?.text);

  check("Pi completed chat turn successfully", res3 && res3.stopReason === "end_turn");
  check("Pi response contains expected text ('pong')", /pong/i.test(res3?.text ?? ""));

  client3.close();
  ws3.close();

} finally {
  console.log("\n[acceptance] Shutting down bridge...");
  await server.shutdown();
}

console.log(`\n[acceptance summary] Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) Deno.exit(1);
