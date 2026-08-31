// mcp-client.js — remote MCP client for the MV3 service worker / agent worker.
// CAP-FB-20260831-MCP-TRANSPORT-SPIKE-01
//
// Binds the pure mount/resolve helper (mcp-client-core.js) to REAL
// `@modelcontextprotocol/sdk` clients over the two BROWSER-SAFE transports:
//   - StreamableHTTPClientTransport (the current transport; 2025-11-25 spec)
//   - SSEClientTransport            (legacy HTTP+SSE)
//
// It NEVER imports `.../client/stdio.js` — stdio needs a subprocess
// (node `child_process`), which does not exist in MV3. Keeping the stdio path
// out of this import tree is the whole point: the bundle carries only fetch /
// EventSource transports. See docs/MCP-SUPPORT-DESIGN.md "Transport spike
// result" for the decision and rationale.
//
// This module is bundled by esbuild for the SW/worker (the SDK lives in
// node_modules and pulls a few `node:` specifiers on paths we never take —
// build.mjs aliases those to browser-shim-node.js exactly as it already does
// for the agent-worker bundle).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { mountRemoteMcpServers as mountCore, namespacedToolName, formatMcpToolResult } from "./mcp-client-core.js";

export { namespacedToolName, formatMcpToolResult };

/** The client identity the MCP server sees in the handshake. */
const CLIENT_INFO = { name: "chrome-agent-platform", version: "0.1.0" };

/**
 * Build a browser-safe transport for one server config.
 * @param {{type:'http'|'sse', url:string, headers?:Record<string,string>}} transport
 */
export function createRemoteTransport(transport) {
  const url = new URL(transport.url);
  const requestInit = transport.headers ? { headers: transport.headers } : undefined;
  switch (transport.type) {
    case "http":
      return new StreamableHTTPClientTransport(url, { requestInit });
    case "sse":
      return new SSEClientTransport(url, { requestInit });
    default:
      throw new TypeError(
        `Unsupported MCP transport "${transport?.type}". MV3 supports only remote transports: "http" (Streamable HTTP) or "sse".`,
      );
  }
}

/**
 * The real SDK-backed client factory: one `Client` per server over its
 * transport. Exposes exactly the thin surface mcp-client-core.js depends on.
 */
export function createRealMcpClient(config) {
  const client = new Client({ ...CLIENT_INFO });
  const transport = createRemoteTransport(config.transport);
  return {
    async connect() {
      await client.connect(transport);
    },
    async listTools() {
      return await client.listTools();
    },
    async callTool(args) {
      return await client.callTool(args);
    },
    async close() {
      await client.close();
    },
  };
}

/**
 * Mount a set of REMOTE MCP servers with per-server resilience (a second,
 * unreachable server does not kill the working one). See mcp-client-core.js
 * for the full contract.
 *
 * @param {Array<{name:string, transport:{type:'http'|'sse', url:string, headers?:object}, allowedTools?:string[]}>} configs
 */
export function mountRemoteMcpServers(configs) {
  return mountCore(configs, { createClient: createRealMcpClient });
}
