// extension/background/routes/mcp.js — the GLOBAL MCP server config routes.
//
// CAP-FB-20260831-MCP-CONFIG-STORE-01. Settings reads/writes the global remote
// MCP server list through these routes. Credentials (the per-server auth token)
// are handled EXACTLY like the provider key: the raw token NEVER crosses into a
// page — `mcp.servers.get` returns the REDACTED list (headerName + a hasToken
// presence bit), and `mcp.servers.set` returns the redacted saved list. The
// per-agent list is mutated through the named-agent route (named-agent.set-mcp-
// servers); connecting/injecting tools is a separate lane (MCP-TOOL-INJECTION).

import {
  getGlobalMcpServers,
  getGlobalMcpServersRedacted,
  normalizeMcpServer,
  preserveExistingMcpTokens,
  setGlobalMcpServers,
} from "../../lib/mcp-config.js";
import { MCP_TOOL_PREFIX } from "../../lib/mcp-client-core.js";
import { requireSettingsSender } from "./auth.js";

/**
 * @param {{ mountRemoteMcpServers?: (configs: Array<object>) => Promise<{
 *   tools: Record<string, {name:string}>,
 *   servers: Array<{name:string, ok:boolean, error?:string, toolCount?:number}>,
 *   close: () => Promise<void>,
 * }> }} [deps]  `mountRemoteMcpServers` is the SDK-backed remote mount from
 *   lib/mcp-client.js. It is INJECTED (not imported here) so routes/mcp.js stays
 *   free of the `@modelcontextprotocol/sdk` import tree and remains
 *   Deno-unit-testable; the service worker binds the real mount.
 */
export function createMcpRoutes(deps = {}) {
  const mountRemoteMcpServers = deps?.mountRemoteMcpServers;
  return Object.freeze({
    async "mcp.servers.get"(_m, context) {
      requireSettingsSender(context);
      // REDACTED: the raw token never crosses into a page — not even Settings.
      // hasToken lets the UI show "credential set — leave blank to keep".
      return { servers: await getGlobalMcpServersRedacted() };
    },

    // The REDACTED global list for an owner surface that needs to show what an
    // agent INHERITS — the per-agent MCP section in the agent create/edit dialog
    // (CAP-FB-20260831-MCP-AGENT-UI-01), which runs as the "extension" principal
    // (the hub), not "owner-options" (Settings). This is a read-only, token-free
    // view: the raw token NEVER crosses (redacted, hasToken bit only), so the
    // owner's own hub may read it. Writes/tests stay Settings-only above.
    async "mcp.servers.global-redacted"(_m, context) {
      if (context?.principal !== "owner-options" && context?.principal !== "extension") {
        throw new Error("the global MCP list is available only to the owner surfaces");
      }
      return { servers: await getGlobalMcpServersRedacted() };
    },

    async "mcp.servers.set"(m, context) {
      requireSettingsSender(context);
      // Blank token on the SAME server id (+ header) preserves the stored one
      // (mcp-config.setGlobalMcpServers) — a page never has to resend a secret.
      // The response is the REDACTED saved list.
      const servers = await setGlobalMcpServers(m?.servers ?? []);
      return { ok: true, servers };
    },

    // "Test connection": connect to ONE remote server (per-server resilient via
    // the injected mcp-client mount), list its tools, and return an honest
    // {ok, toolCount, toolNames} / {ok:false, error}. The token is handled like
    // the provider key — a BLANK token on a stored id reuses the STORED
    // credential (the page never resends a secret to test it), and the token
    // NEVER crosses back out in the response. Invalid servers (stdio/command,
    // non-http(s) URL) are rejected BEFORE any network is touched.
    async "mcp.servers.test"(m, context) {
      requireSettingsSender(context);
      if (typeof mountRemoteMcpServers !== "function") {
        return { ok: false, error: "MCP client is unavailable in this build." };
      }
      const incoming = normalizeMcpServer(m?.server);
      if (!incoming) {
        return {
          ok: false,
          error: "Enter a valid remote MCP server — an http/sse transport and an http(s) URL.",
        };
      }
      // Reuse the stored token when the field was left blank (redacted UI).
      const [server] = preserveExistingMcpTokens([incoming], await getGlobalMcpServers());
      const headers = server.auth?.token
        ? { [server.auth.headerName]: server.auth.token }
        : undefined;
      const config = {
        name: server.id,
        transport: { type: server.transport, url: server.url, headers },
      };

      let mounted;
      try {
        mounted = await mountRemoteMcpServers([config]);
      } catch (e) {
        // A caller-contract throw (never for a server-level failure, which the
        // mount records) — still report it honestly, never leak a stack.
        return { ok: false, error: String(e?.message ?? e) };
      }
      try {
        const status = mounted.servers?.[0];
        if (!status || !status.ok) {
          return { ok: false, error: status?.error || "The server could not be reached." };
        }
        const prefix = `${MCP_TOOL_PREFIX}${server.id}__`;
        const toolNames = Object.keys(mounted.tools ?? {})
          .map((n) => (n.startsWith(prefix) ? n.slice(prefix.length) : n))
          .sort();
        return { ok: true, toolCount: status.toolCount ?? toolNames.length, toolNames };
      } finally {
        try {
          await mounted.close?.();
        } catch { /* teardown best-effort — the SW worker is ephemeral anyway */ }
      }
    },
  });
}
