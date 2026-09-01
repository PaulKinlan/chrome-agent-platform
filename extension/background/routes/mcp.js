// extension/background/routes/mcp.js — the GLOBAL MCP server config routes.
//
// CAP-FB-20260831-MCP-CONFIG-STORE-01. Settings reads/writes the global remote
// MCP server list through these routes. Credentials (the per-server auth token)
// are handled EXACTLY like the provider key: the raw token NEVER crosses into a
// page — `mcp.servers.get` returns the REDACTED list (headerName + a hasToken
// presence bit), and `mcp.servers.set` returns the redacted saved list. The
// per-agent list is mutated through the named-agent route (named-agent.set-mcp-
// servers); connecting/injecting tools is a separate lane (MCP-TOOL-INJECTION).

import { getGlobalMcpServersRedacted, setGlobalMcpServers } from "../../lib/mcp-config.js";
import { requireSettingsSender } from "./auth.js";

export function createMcpRoutes() {
  return Object.freeze({
    async "mcp.servers.get"(_m, context) {
      requireSettingsSender(context);
      // REDACTED: the raw token never crosses into a page — not even Settings.
      // hasToken lets the UI show "credential set — leave blank to keep".
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
  });
}
