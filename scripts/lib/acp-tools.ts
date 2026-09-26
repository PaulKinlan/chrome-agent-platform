// Transport plumbing only: the catalogue and execution stay in the CAP run.
import { Server } from "npm:@modelcontextprotocol/sdk@1.30.0/server";
// @ts-ignore SDK wildcard exports append .d.ts to .js during Deno type resolution (runtime tested).
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.30.0/server/webStandardStreamableHttp.js";
// @ts-ignore Same SDK wildcard export mismatch.
import { CallToolRequestSchema, ListToolsRequestSchema } from "npm:@modelcontextprotocol/sdk@1.30.0/types.js";

export async function createAcpTools(call: (method: string, params: unknown) => Promise<any>) {
  const token = crypto.randomUUID();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true,
  });
  const server = new Server({ name: "CAP", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => call("_cap/tools/list", {}));
  server.setRequestHandler(CallToolRequestSchema, (request: any) => call("_cap/tools/call", request.params));
  await server.connect(transport);
  let closed = false;
  return {
    config(url: string) {
      return { type: "http", name: "CAP", url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] };
    },
    handle(request: Request) {
      // No web-page access, even if a page learns the endpoint. No CORS grants.
      if (closed || request.headers.get("authorization") !== `Bearer ${token}` || request.headers.has("origin")) {
        return new Response("CAP tools unavailable", { status: 403 });
      }
      return transport.handleRequest(request);
    },
    async close() { closed = true; await server.close(); },
  };
}

/** A private, connection-scoped reverse RPC channel; never forward replies to the adapter. */
export function acpToolChannel(send: (raw: string) => void) {
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let closed = false;
  return {
    call(method: string, params: unknown): Promise<any> {
      if (closed) return Promise.reject(new Error("CAP run disconnected"));
      return new Promise((resolve, reject) => {
        const id = `cap-tools:${crypto.randomUUID()}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("CAP tool request timed out"));
        }, 120_000);
        pending.set(id, { resolve, reject, timer });
        try { send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    receive(msg: any) {
      if (typeof msg?.id !== "string" || !msg.id.startsWith("cap-tools:")) return false;
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || "CAP tool request failed"));
        else p.resolve(msg.result);
      }
      return true;
    },
    close() {
      closed = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error("CAP run disconnected")); }
      pending.clear();
    },
  };
}
