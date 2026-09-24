// scripts/fixtures/fake-acp-harness-2amt.mjs — a minimal ACP adapter for the browser-tool drive.
//
// chrome-agent-platform-2amt. NOT a harness (no registry entry needed: the registry guard looks at
// scripts/*.ts): this is a fixture the drive points `acp-bridge --adapter` at, so the END-TO-END
// drive can keep the real bridge, the real extension client and real Chrome while substituting only
// the model. What it does is what a model would do:
//   1. on the first prompt, CHECK it was told about the browser tools (the declaration the bridge
//      injects) — a harness that is not told cannot call anything;
//   2. call list_tabs over browser/call_tool;
//   3. choose the two most recent tabs FROM THAT RESULT, not from outside;
//   4. call group_tabs with a title and colour, and record the answer;
//   5. answer the prompt.
//
// NODE APIs ONLY, deliberately: the bridge spawns adapters with node (an earlier version of this
// fixture used Deno.stdin/stdout and died instantly with "adapter for harness \"pi\" exited").
import { writeFileSync } from "node:fs";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
// The drive passes the path through the bridge's environment (the bridge spawns `node <adapter>`,
// so there is no argv slot for it).
const reportPath = process.env.CAP_2AMT_REPORT || process.argv[2] || "./fake-acp-harness-2amt.report.json";
const report = { sawDeclaration: false, listTabs: null, groupTabs: null, events: [] };
const pending = new Map(); // id -> resolve
let promptId = null;
let sessionId = null;
let buffer = "";

process.stdin.on("data", async (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      // RESOLVE WITH THE RESULT, not the envelope: a JSON-RPC response is {jsonrpc, id, result} and
      // reading `.tabs` off the whole message yields undefined for both the payload and the error,
      // so list_tabs looked like a success with no tabs (measured while building this drive).
      resolve(msg.result !== undefined ? msg.result : { error: msg.error ?? "no result in the response" });
      continue;
    }

    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: 1, agentInfo: { name: "fake-harness-2amt", version: "0.0.1" }, agentCapabilities: {} },
      });
    } else if (msg.method === "session/new" || msg.method === "session/load") {
      sessionId = "s-2amt-fake";
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
    } else if (msg.method === "session/prompt") {
      promptId = msg.id;
      const text = (msg.params?.prompt ?? []).map((b) => (b && b.text) || "").join("\n");
      report.sawDeclaration = /browser\/call_tool/.test(text) && /list_tabs/.test(text) && /group_tabs/.test(text);
      const callTool = (name, args) =>
        new Promise((resolve) => {
          const id = "tool-" + name + "-" + Math.random().toString(16).slice(2);
          pending.set(id, resolve);
          send({ jsonrpc: "2.0", id, method: "browser/call_tool", params: { name, args } });
        });

      const listed = await callTool("list_tabs", {});
      report.listTabs = {
        count: listed && listed.count,
        ids: Array.isArray(listed && listed.tabs) ? listed.tabs.map((t) => t.id) : null,
        error: (listed && listed.error) || null,
      };
      const ids = (report.listTabs.ids || []).slice(-2);
      const grouped = await callTool("group_tabs", { tabIds: ids, title: "2amt drive", color: "blue" });
      report.groupTabs = { requested: ids, result: grouped || null };
      try {
        writeFileSync(reportPath, JSON.stringify(report, null, 2));
      } catch {
        /* the drive will report a missing report */
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "grouped " + ids.length + " tabs" } },
        },
      });
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
      promptId = null;
    } else if (msg.method === "session/cancel") {
      if (promptId !== null) {
        send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
        promptId = null;
      }
    }
  }
});
