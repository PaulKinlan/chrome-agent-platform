// mcp-test-server.ts — a tiny, stateless MCP Streamable-HTTP server for the
// transport spike. CAP-FB-20260831-MCP-TRANSPORT-SPIKE-01
//
// It speaks exactly enough of the MCP Streamable-HTTP transport (spec
// 2025-11-25) for the SDK's StreamableHTTPClientTransport to connect, list
// tools, and call one:
//   - POST <endpoint>  JSON-RPC → single `application/json` JSON-RPC response
//     (stateless: no session id, no SSE stream).
//   - `notifications/initialized` (a notification) → 202 Accepted, no body.
//   - GET <endpoint>   → 405 (no standalone SSE stream) — the client treats
//     405 as "server has no SSE channel" and carries on, which is what we want.
//   - OPTIONS          → CORS preflight (the extension SW fetches cross-origin;
//     the response is CORS-permissive so it works with or without a host grant).
//
// Two tools: `add` (a+b) and `echo` (returns its text). No dependencies beyond
// Deno + the standard library — deliberately hand-rolled so the harness does
// not depend on the SDK's node-http server transport.
//
//   Library use:  const srv = await startMcpTestServer();  // { port, url, close }
//   CLI use:      deno run -A scripts/mcp-test-server.ts [--port N] [--path /mcp]

const LATEST_PROTOCOL_VERSION = "2025-11-25";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS, DELETE",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

const TOOLS = [
  {
    name: "add",
    description: "Add two numbers and return the sum.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
  {
    name: "echo",
    description: "Echo the given text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

function rpcResult(id: unknown, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } });
}

function callTool(name: string, args: Record<string, unknown>) {
  if (name === "add") {
    const sum = Number(args?.a) + Number(args?.b);
    return { content: [{ type: "text", text: String(sum) }] };
  }
  if (name === "echo") {
    return { content: [{ type: "text", text: String(args?.text ?? "") }] };
  }
  return { isError: true, content: [{ type: "text", text: `unknown tool: ${name}` }] };
}

function handleRpc(msg: any): Response {
  const { id, method, params } = msg ?? {};
  // A notification (no id) — the only one we expect is initialized.
  if (id === undefined) {
    return new Response(null, { status: 202, headers: { ...CORS } });
  }
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "cap-mcp-test-server", version: "0.1.0" },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const known = TOOLS.some((t) => t.name === name);
      if (!known) return rpcError(id, -32602, `unknown tool: ${name}`);
      return rpcResult(id, callTool(name, params?.arguments ?? {}));
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

async function handle(req: Request, endpointPath: string): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== endpointPath) {
    return new Response("not found", { status: 404, headers: { ...CORS } });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...CORS } });
  }
  if (req.method === "GET") {
    // No standalone SSE stream in this stateless server.
    return new Response("method not allowed", { status: 405, headers: { ...CORS } });
  }
  if (req.method === "DELETE") {
    // Stateless: nothing to terminate.
    return new Response(null, { status: 200, headers: { ...CORS } });
  }
  if (req.method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return rpcError(null, -32700, "parse error");
    }
    if (Array.isArray(body)) {
      // A batch with any request → respond with the array of responses.
      const responses = body
        .map((m) => m)
        .filter((m) => m && m.id !== undefined)
        .map((m) => ({ jsonrpc: "2.0", id: m.id, ...respondBody(m) }));
      if (responses.length === 0) return new Response(null, { status: 202, headers: { ...CORS } });
      return jsonResponse(responses);
    }
    return handleRpc(body);
  }
  return new Response("method not allowed", { status: 405, headers: { ...CORS } });
}

// Helper used only for the batch path: compute the {result|error} body.
function respondBody(msg: any): { result?: unknown; error?: unknown } {
  const { method, params, id } = msg;
  switch (method) {
    case "initialize":
      return { result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "cap-mcp-test-server", version: "0.1.0" } } };
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: TOOLS } };
    case "tools/call": {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return { error: { code: -32602, message: `unknown tool: ${name}` } };
      return { result: callTool(name, params?.arguments ?? {}) };
    }
    default:
      return { error: { code: -32601, message: `method not found: ${method}` }, id } as any;
  }
}

export interface McpTestServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/** Start the server on a kernel-assigned port (127.0.0.1). */
export function startMcpTestServer(opts: { port?: number; path?: string } = {}): Promise<McpTestServer> {
  const endpointPath = opts.path ?? "/mcp";
  return new Promise((resolve) => {
    const server = Deno.serve(
      { port: opts.port ?? 0, hostname: "127.0.0.1", onListen: ({ port }) => {
        resolve({
          port,
          url: `http://127.0.0.1:${port}${endpointPath}`,
          close: async () => { await server.shutdown(); },
        });
      } },
      (req) => handle(req, endpointPath),
    );
  });
}

// CLI: `deno run -A scripts/mcp-test-server.ts [--port N] [--path /mcp]`
if (import.meta.main) {
  const args = Deno.args;
  const portArg = args.indexOf("--port");
  const pathArg = args.indexOf("--path");
  const srv = await startMcpTestServer({
    port: portArg >= 0 ? Number(args[portArg + 1]) : 0,
    path: pathArg >= 0 ? args[pathArg + 1] : "/mcp",
  });
  console.log(`MCP test server: ${srv.url}`);
}
