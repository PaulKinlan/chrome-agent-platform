// mcp-client-core.js — transport-agnostic MCP mount/resolve helper.
// CAP-FB-20260831-MCP-TRANSPORT-SPIKE-01
//
// This is the PURE half of the remote-MCP client: it owns the per-server
// mount loop, the `mcp__<server>__<tool>` namespacing, tool-call formatting
// and teardown, but imports NOTHING from `@modelcontextprotocol/sdk` (and
// therefore no `node:` builtins). It is unit-testable in Deno with a fake
// client factory. The real SDK-backed factory lives in `mcp-client.js`,
// which imports ONLY the browser-safe Streamable-HTTP / SSE transports and
// binds it to `mountRemoteMcpServers` here.
//
// Why we do NOT use agent-do's `mountMcpServers`:
//   1. It imports `StdioClientTransport` (node `child_process`) at module
//      top. MV3 has no subprocess; the build shims node builtins, but the
//      whole stdio path is dead weight we never want in the bundle.
//   2. It is ALL-OR-NOTHING: if ANY server's connect()/listTools() throws,
//      it tears every server down and rethrows. The product needs PER-SERVER
//      resilience — one unreachable server must not kill the working ones.
//   See docs/MCP-SUPPORT-DESIGN.md "Transport spike result".

/**
 * A server or tool name segment. `__` is forbidden inside a segment because
 * the flattened name uses it as the separator (agent-do issue #75): allowing
 * it would let distinct (server, tool) pairs collapse to the same key.
 */
export const NAMESPACE_RE = /^(?!.*__)[a-zA-Z0-9_-]+$/;

/** Prefix applied to every MCP-sourced tool name. */
export const MCP_TOOL_PREFIX = "mcp__";

/** Build the namespaced tool name (`mcp__<server>__<tool>`). */
export function namespacedToolName(serverName, toolName) {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

function errMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Flatten an MCP tool result's content array into a single text string. MCP
 * results are mixed content (text / image / resource); we concatenate the
 * text and leave a short descriptor for the rest so the caller at least
 * knows something else came back. Kept deliberately simple for the spike —
 * the untrusted-content fence lives at the integration layer (parent entry).
 */
export function formatMcpToolResult(result) {
  if (!result || typeof result !== "object") {
    return typeof result === "string" ? result : JSON.stringify(result);
  }
  const content = result.content;
  if (!Array.isArray(content)) {
    return JSON.stringify(result);
  }
  const parts = [];
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (part && part.type === "image") {
      parts.push(`[image: ${part.mimeType ?? "unknown"}]`);
    } else if (part && part.type === "resource") {
      parts.push(`[resource: ${part.resource?.uri ?? "unknown"}]`);
    } else {
      parts.push(`[${part?.type ?? "unknown"} part]`);
    }
  }
  const body = parts.join("\n");
  return result.isError ? `Tool error: ${body}` : body;
}

/**
 * Bounds for the MCP egress guard below (chrome-agent-platform-aix7j).
 */
export const MCP_EGRESS_MAX_REDIRECT_HOPS = 5;

/** A refusal from the MCP egress guard. A distinct class so a caller (and a
 * test) can tell "we refused to send this" from "the server failed". */
export class McpEgressRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = "McpEgressRefusedError";
  }
}

function headerValue(res, name) {
  try {
    return res?.headers?.get?.(name) ?? res?.headers?.get?.(String(name).toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/**
 * The MCP egress guard: the ONE fetch the remote MCP transports may use.
 *
 * WHY (chrome-agent-platform-aix7j, GHSA-6prh-2h8m-c8cw). `createRemoteTransport`
 * hands the owner-configured `headers` (which carry the owner's Authorization
 * token) to `StreamableHTTPClientTransport` / `SSEClientTransport`. With no
 * fetch override the SDK's own fetch FOLLOWS a 3xx and re-sends those headers —
 * and the request body — to whatever origin the server names. Every other
 * network surface in the repo already refuses this (`lib/site-docs-fallback.js`,
 * `lib/ask-agent-entry.js`, `lib/skill-import.js`, `lib/python-network.js`: an
 * owner grants an ORIGIN, never "whatever this origin points at next"), and the
 * MCP client was the one fetch path that skipped the rule. A compromised MCP
 * server could therefore 302 the extension into handing a token reused for a
 * second service to an attacker-chosen host.
 *
 * The policy — "same origin" means the EXACT configured origin, scheme and port
 * included, so `https://host` and `http://host` are DIFFERENT origins and a
 * scheme upgrade is NOT a same-origin hop (chrome-agent-platform-fd586):
 *   1. `redirect: "manual"` on EVERY attempt — the platform never follows a hop
 *      for us, so we always see the 3xx before any header is re-sent.
 *   2. A 3xx WITH a Location (the Deno/Node shape) is followed ONLY when the
 *      next hop is the SAME ORIGIN as the owner-configured server (a
 *      `/mcp` → `/mcp/v2` endpoint move, a trailing-slash fix). Anything else,
 *      including a scheme upgrade or a subdomain move, is refused.
 *   3. An `opaqueredirect` (the BROWSER shape: status 0, no readable Location)
 *      is resolved WITHOUT credentials rather than guessed at
 *      (chrome-agent-platform-q7ti9): the guard issues a header-free, GET,
 *      `redirect: "follow"` probe of the same URL, reads the probe's final
 *      `url`, and re-issues the ORIGINAL request to that URL only if its origin
 *      is unchanged. The probe carries no Authorization header and no body, so a
 *      cross-origin hop learns nothing; if the probe lands off-origin, or cannot
 *      be resolved at all, the call is refused.
 *   4. A request whose URL is not the configured origin is refused before it is
 *      issued, so a server-supplied URL can never become the request target.
 *   5. Hops are bounded (MCP_EGRESS_MAX_REDIRECT_HOPS), probes included.
 *
 * Refusals throw `McpEgressRefusedError`; the mount helper records them per
 * server like any other connection failure, so the other servers still mount.
 * An operator whose server answers on a different scheme/host must point the
 * server config at the FINAL url: this guard follows one origin, never a move.
 *
 * @param {{origin:string, fetchImpl?:typeof fetch, maxHops?:number}} options
 * @returns {(url: string|URL, init?: RequestInit) => Promise<Response>}
 */
export function createGuardedMcpFetch({ origin, fetchImpl = globalThis.fetch, maxHops = MCP_EGRESS_MAX_REDIRECT_HOPS } = {}) {
  if (typeof origin !== "string" || !origin) {
    throw new TypeError("createGuardedMcpFetch requires the configured server origin");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createGuardedMcpFetch requires a fetch implementation");
  }
  const refuse = (why) => new McpEgressRefusedError(`MCP request refused: ${why}`);
  let base;
  try {
    base = new URL(origin);
  } catch {
    throw new TypeError(`createGuardedMcpFetch: invalid origin "${origin}"`);
  }

  /** True when a response is a redirect the platform did not follow for us. */
  const isRedirectLike = (res) => {
    if (res?.type === "opaqueredirect") return true;
    const status = Number(res?.status ?? 0);
    return status >= 300 && status < 400;
  };

  /**
   * Resolve an OPAQUE redirect (a browser service worker gives status 0 and no
   * Location) without spending a credential on it: a header-free GET that is
   * allowed to follow, whose final `url` is the only thing we keep. Returns the
   * resolved URL when it is still the configured origin, else null.
   */
  const resolveOpaqueRedirect = async (current) => {
    let probe;
    try {
      probe = await fetchImpl(current.href, {
        method: "GET",
        credentials: "omit",
        redirect: "follow",
      });
    } catch {
      return null; // CORS/network refusal: nothing to learn, refuse the call.
    }
    const finalUrl = typeof probe?.url === "string" && probe.url ? probe.url : "";
    if (!finalUrl) return null;
    try {
      const resolved = new URL(finalUrl);
      if (resolved.origin !== base.origin) return null;
      if (resolved.href === current.href) return null; // the probe did not move: no hop to take
      return resolved;
    } catch {
      return null;
    }
  };

  return async function guardedMcpFetch(url, init) {
    let current;
    try {
      current = new URL(String(url && typeof url === "object" && "href" in url ? url.href : url), base.href);
    } catch {
      throw refuse(`invalid request URL "${String(url)}"`);
    }
    if (current.origin !== base.origin) {
      throw refuse(`${current.href} is not the configured MCP origin ${base.origin}`);
    }
    for (let hop = 0; hop <= maxHops; hop++) {
      // Always overwrite the caller's redirect policy: this is the guard.
      const res = await fetchImpl(current.href, { ...(init ?? {}), redirect: "manual" });
      if (res?.type === "opaqueredirect") {
        const resolved = await resolveOpaqueRedirect(current);
        if (!resolved) {
          throw refuse(
            `${current.href} answered an opaque redirect (this service worker cannot read its Location): ` +
              `point this MCP server's config at the final url — only a hop inside ${base.origin} is followed`,
          );
        }
        if (hop === maxHops) {
          throw refuse(`more than ${maxHops} redirects from ${base.origin}`);
        }
        current = resolved;
        continue;
      }
      const status = Number(res?.status ?? 0);
      if (!(status >= 300 && status < 400)) return res;
      const location = headerValue(res, "location");
      if (!location) throw refuse(`${current.href} answered ${status} without an inspectable Location`);
      let next;
      try {
        next = new URL(String(location), current.href);
      } catch {
        throw refuse(`${current.href} answered ${status} with an invalid Location`);
      }
      if (next.origin !== base.origin) {
        throw refuse(`redirect to ${next.origin} is not the configured MCP origin ${base.origin}`);
      }
      if (hop === maxHops) {
        throw refuse(`more than ${maxHops} redirects from ${base.origin}`);
      }
      current = next;
    }
    throw refuse(`more than ${maxHops} redirects from ${base.origin}`);
  };
}

/**
 * Mount a set of remote MCP servers with PER-SERVER resilience.
 *
 * @param {Array<{name:string, transport:object, allowedTools?:string[]}>} configs
 * @param {{ createClient: (config) => {
 *   connect: () => Promise<void>,
 *   listTools: () => Promise<{tools: Array<{name,description?,inputSchema?}>}>,
 *   callTool: (args: {name:string, arguments:object}) => Promise<any>,
 *   close: () => Promise<void>,
 * } }} deps  `createClient` builds the transport-backed client for one server.
 *
 * @returns {Promise<{
 *   tools: Record<string, {name,description,inputSchema,origin,call:(args)=>Promise<string>}>,
 *   toolOrigins: Record<string,string>,
 *   servers: Array<{name:string, ok:boolean, error?:string, toolCount?:number}>,
 *   close: () => Promise<void>,
 * }>}
 *
 * Contract:
 *   - A server whose connect()/listTools() throws is recorded
 *     `{ok:false, error}` and its (possibly half-open) client is closed —
 *     the OTHER servers are unaffected. This helper NEVER throws for a
 *     server-level failure (it only throws for a caller contract error:
 *     a malformed/duplicate name, or a missing `createClient`).
 *   - The returned `close()` is idempotent and closes every client that
 *     connected, in reverse mount order.
 *   - A tool invoked after close() resolves to an error string.
 */
export async function mountRemoteMcpServers(configs, deps) {
  const createClient = deps?.createClient;
  if (typeof createClient !== "function") {
    throw new TypeError("mountRemoteMcpServers requires deps.createClient");
  }

  // Validate names up front (deterministic caller-contract failure).
  const seen = new Set();
  for (const config of configs) {
    if (!config || !NAMESPACE_RE.test(config.name)) {
      throw new TypeError(
        `MCP server name "${config?.name}" must match ${NAMESPACE_RE}`,
      );
    }
    if (seen.has(config.name)) {
      throw new TypeError(`Duplicate MCP server name "${config.name}"`);
    }
    seen.add(config.name);
  }

  const connected = []; // clients that connected OK — closed on teardown
  const tools = {};
  const toolOrigins = {};
  const servers = [];
  let closed = false;

  const closeAll = async () => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(
      [...connected].reverse().map((c) => Promise.resolve().then(() => c.close()).catch(() => {})),
    );
  };

  for (const config of configs) {
    let client;
    try {
      client = createClient(config);
      await client.connect();
      const listed = await client.listTools();
      const mcpTools = listed?.tools ?? [];

      // Build this server's tools in a local map first, then commit the whole
      // set only if the loop completes — a mid-loop failure leaves no partial
      // tools pointing at a client we are about to close.
      const localTools = {};
      const localOrigins = {};
      for (const mcpTool of mcpTools) {
        if (config.allowedTools && !config.allowedTools.includes(mcpTool.name)) {
          continue;
        }
        if (!NAMESPACE_RE.test(mcpTool.name)) {
          throw new TypeError(
            `MCP server "${config.name}" exposes tool "${mcpTool.name}" which does not match ${NAMESPACE_RE}.`,
          );
        }
        const toolName = namespacedToolName(config.name, mcpTool.name);
        if (toolName in tools || toolName in localTools) {
          throw new TypeError(`MCP tool name collision for "${toolName}".`);
        }
        localOrigins[toolName] = config.name;
        const boundClient = client;
        const rawName = mcpTool.name;
        localTools[toolName] = {
          name: toolName,
          description: mcpTool.description ??
            `MCP tool "${rawName}" from server "${config.name}".`,
          inputSchema: mcpTool.inputSchema ?? { type: "object", properties: {} },
          origin: config.name,
          async call(args) {
            if (closed) return `Error: MCP server "${config.name}" is closed.`;
            try {
              const result = await boundClient.callTool({
                name: rawName,
                arguments: args ?? {},
              });
              return formatMcpToolResult(result);
            } catch (error) {
              return `Error calling ${toolName}: ${errMessage(error)}`;
            }
          },
        };
      }

      // Commit atomically: the server connected and listed cleanly.
      Object.assign(tools, localTools);
      Object.assign(toolOrigins, localOrigins);
      connected.push(client);
      servers.push({ name: config.name, ok: true, toolCount: Object.keys(localTools).length });
    } catch (error) {
      // Per-server isolation: record and move on. Close the half-open client.
      if (client) {
        await Promise.resolve().then(() => client.close()).catch(() => {});
      }
      servers.push({ name: config.name, ok: false, error: errMessage(error) });
    }
  }

  return { tools, toolOrigins, servers, close: closeAll };
}
