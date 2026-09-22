// extension/lib/harness-mcp-server.js — CAP as an MCP server FOR a harness.
//
// THE ARCHITECTURE THIS SERVES (owner, 2026-09-22). The tools live in the
// client. The harness asks for one. The request routes BACK to the client. The
// client executes it against the tab the owner is looking at. The result
// returns to the harness. No second browser, no external Chrome, no MCP server
// driving a parallel browser — the owner's words for that last one were
// "exactly NOT what I want".
//
// WHY THIS SHAPE AND NOT AN HTTP SERVER. ACP defines an MCP server the CLIENT
// hosts: `{type:"acp", name, serverId}` on `session/new`, after which the
// adapter tunnels MCP JSON-RPC through the ACP methods `mcp/connect`,
// `mcp/message` and `mcp/disconnect` (codex-acp pins exactly this union and
// those three method names). That is the owner's architecture with no port to
// listen on, no bridge to reach, and nothing else to launch — the MVP of "route
// it back to the client" is the channel itself.
//
// WHAT IS NOT HERE. Not every harness can do this, and the difference is
// measured rather than assumed: `codex-acp` implements `mcp/connect`;
// `claude-agent-acp` does NOT (it only fingerprints `mcpServers` and hands them
// to the Claude Agent SDK, so it needs a url or a command); and `pi-acp@0.0.33`
// stores `params.mcpServers` and never reads them at all. Callers must not
// advertise this server to an adapter that cannot use it — that would be a
// server the harness silently ignores, which is worse than none, because it
// looks like capability. `adapterHostsClientMcp()` below is that rule.
//
// This module is deliberately transport-free and side-effect-free: it takes a
// tool provider, speaks JSON-RPC, and returns a response or null (for a
// notification). Everything that touches a browser, an owner card or storage is
// injected, so the protocol contract is testable without a browser and cannot
// quietly grow a chrome.* dependency.

/** The protocol revision this server answers with when a client asks for one we
 * do not know. MCP clients negotiate: the server may reply with a revision it
 * supports, and the client decides whether to continue. */
export const HARNESS_MCP_PROTOCOL_VERSION = "2025-06-18";

/** The `serverId` CAP declares in `mcpServers`. Stable, because the adapter
 * echoes it back on `mcp/connect` and the owner-facing name comes from the
 * `name` field instead. */
export const CAP_MCP_SERVER_ID = "cap-browser";

/** Does this adapter host an MCP server the CLIENT provides?
 *
 * True only for the adapters that implement the ACP `mcp/connect` /
 * `mcp/message` / `mcp/disconnect` pair. Measured against the pinned adapters
 * 2026-09-22: codex-acp@1.12.0 defines `zMcpServerAcp` (`{name, serverId}`) and
 * the three method names; claude-agent-acp@0.78.0 defines none of them; and
 * pi-acp@0.0.33 never reads `mcpServers`. An unknown adapter is NOT guessed at:
 * advertising a server nobody reads makes a session look capable when it is
 * not. */
export function adapterHostsClientMcp(harness) {
  return harness === "codex";
}

/** The `mcpServers` entry CAP declares for an adapter that can host it. */
export function capClientMcpServerEntry() {
  return { type: "acp", name: "CAP browser tools", serverId: CAP_MCP_SERVER_ID };
}

/** JSON-RPC error codes used here. Named so a caller never string-matches a
 * number, and so the two "the client cannot serve you" cases stay distinct:
 * METHOD_NOT_FOUND is a client that does not implement the method at all;
 * INTERNAL_ERROR is one that accepted the call and could not complete it. */
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/** A tool result the model reads. MCP allows a content array; CAP's tool
 * results are JSON, so it is stringified once, here, with the run's own
 * untrusted fencing left to the caller's provider (this module never decides
 * what is trusted). */
function textContent(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { content: [{ type: "text", text }], isError: false };
}

function errorContent(message, { isError = true } = {}) {
  return { content: [{ type: "text", text: String(message ?? "the tool did not run") }], isError };
}

/**
 * Build the MCP server a harness talks to.
 *
 * @param {{
 *   listTools: () => Promise<Array<{name: string, description?: string, inputSchema?: object}>>,
 *   callTool: (name: string, args: object, meta?: object) => Promise<unknown>,
 *   serverName?: string,
 *   serverVersion?: string,
 * }} provider
 * @returns {{ handle: (message: unknown) => Promise<object|null>, initialized: () => boolean }}
 */
export function createHarnessMcpServer({ listTools, callTool, serverName = "cap-browser-tools", serverVersion = "1" } = {}) {
  if (typeof listTools !== "function") throw new TypeError("harness MCP server needs a listTools provider");
  if (typeof callTool !== "function") throw new TypeError("harness MCP server needs a callTool provider");

  let initialised = false;

  const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  return {
    initialized: () => initialised,

    /**
     * One inbound MCP message in, one response out — or null when the message
     * is a NOTIFICATION, which by JSON-RPC must never be answered. A response
     * to a notification desynchronises a real MCP client, so this returns null
     * rather than an empty result.
     */
    async handle(message) {
      const msg = message;
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;

      const hasId = msg.id !== undefined && msg.id !== null;
      const method = typeof msg.method === "string" ? msg.method : "";

      // A response (not a request) carries result/error and no method. The
      // harness does not send us these, but answering one would be a protocol
      // error, so it is dropped rather than treated as an unknown method.
      if (!method && (msg.result !== undefined || msg.error !== undefined)) return null;

      if (!method) return hasId ? fail(msg.id, RPC_METHOD_NOT_FOUND, "missing method") : null;

      switch (method) {
        case "initialize": {
          initialised = true;
          // Echo the client's requested revision when we support it, otherwise
          // answer with ours and let the client decide — never claim a revision
          // we do not implement.
          const requested = msg.params?.protocolVersion;
          return ok(msg.id, {
            protocolVersion: requested === HARNESS_MCP_PROTOCOL_VERSION ? requested : HARNESS_MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: serverName, version: serverVersion },
          });
        }

        case "notifications/initialized":
        case "initialized":
          initialised = true;
          return null; // notification: no response, ever

        case "ping":
          return hasId ? ok(msg.id, {}) : null;

        case "tools/list": {
          let tools;
          try {
            tools = await listTools();
          } catch (err) {
            return fail(msg.id, RPC_INTERNAL_ERROR, `could not list tools: ${String(err?.message ?? err)}`);
          }
          const mapped = (Array.isArray(tools) ? tools : []).map((toolItem) => ({
            name: String(toolItem?.name ?? ""),
            description: String(toolItem?.description ?? ""),
            inputSchema: toolItem?.inputSchema && typeof toolItem.inputSchema === "object"
              ? toolItem.inputSchema
              // MCP requires a schema; an empty object schema is honest for a
              // tool that takes no arguments, and never undefined.
              : { type: "object", properties: {} },
          })).filter((toolItem) => toolItem.name);
          return ok(msg.id, { tools: mapped });
        }

        case "tools/call": {
          const name = msg.params?.name;
          if (typeof name !== "string" || !name) {
            return fail(msg.id, RPC_INVALID_PARAMS, "tools/call requires a tool name");
          }
          const args = msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {};
          try {
            const result = await callTool(name, args, msg.params?._meta);
            // A provider that ran the call but wants the harness to see a
            // failure returns { ok:false, error }. That is a NAMED refusal, not
            // a protocol error: the call happened, the answer is no. Surfacing
            // it as isError keeps the refusal visible to the model instead of
            // turning it into a thrown transport error it cannot read.
            if (result && typeof result === "object" && result.ok === false) {
              return ok(msg.id, errorContent(result.error ?? "the tool was not run"));
            }
            return ok(msg.id, textContent(result));
          } catch (err) {
            // A thrown error is the tool crashing, not the owner refusing.
            // Still isError (the model must see it) but reported as internal so
            // the two causes stay distinguishable in the transcript.
            return fail(msg.id, RPC_INTERNAL_ERROR, String(err?.message ?? err));
          }
        }

        default:
          return hasId ? fail(msg.id, RPC_METHOD_NOT_FOUND, `unsupported method: ${method}`) : null;
      }
    },
  };
}
