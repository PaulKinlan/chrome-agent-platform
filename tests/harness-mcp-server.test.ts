// tests/harness-mcp-server.test.ts — the MCP server CAP exposes TO a harness.
//
// This is the client half of the owner's architecture: the tools live in the
// client, the harness asks, the request routes back, the client executes, the
// result returns. The protocol contract is pinned here, without a browser,
// because a transport bug and a browser bug must not be able to hide each
// other. `adapterHostsClientMcp` is pinned too: advertising this server to an
// adapter that cannot read it is worse than advertising nothing, because it
// looks like capability.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  CAP_MCP_SERVER_ID,
  HARNESS_MCP_PROTOCOL_VERSION,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  adapterHostsClientMcp,
  capClientMcpServerEntry,
  createHarnessMcpServer,
} from "../extension/lib/harness-mcp-server.js";

type Any = any;

const server = (over: Any = {}) => createHarnessMcpServer({
  listTools: async () => [{ name: "list_tabs", description: "List open tabs", inputSchema: { type: "object", properties: {} } }],
  callTool: async (name: string, args: Any) => ({ ok: true, tool: name, args }),
  ...over,
});

const req = (id: number, method: string, params?: Any) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

/** Every assertion below reads a JSON-RPC reply, so the shape is narrowed once
 * here rather than at 40 call sites. */
const reply = async (s: Any, message: Any): Promise<Any> => await s.handle(message);

const caught = (fn: () => unknown): string => {
  try { fn(); return ""; } catch (e) { return String((e as Error)?.message ?? e); }
};

Deno.test("initialize negotiates the protocol version and never claims one it does not implement", async () => {
  const s = server();
  const same = await reply(s, req(1, "initialize", { protocolVersion: HARNESS_MCP_PROTOCOL_VERSION }));
  assertEquals(same.result.protocolVersion, HARNESS_MCP_PROTOCOL_VERSION);
  assertEquals(same.result.capabilities.tools !== undefined, true);

  // An unknown revision is answered with OURS, not echoed back as if accepted.
  const other = await reply(s, req(2, "initialize", { protocolVersion: "1999-01-01" }));
  assertEquals(other.result.protocolVersion, HARNESS_MCP_PROTOCOL_VERSION);
  assertEquals(other.result.serverInfo.name.length > 0, true);
});

Deno.test("a notification is never answered, because answering one desynchronises a real client", async () => {
  const s = server();
  // `initialized` is a notification: no id, so no response. A response here is
  // the classic way a server makes a client hang waiting for the next reply.
  assertEquals(await reply(s, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assertEquals(await reply(s, { jsonrpc: "2.0", method: "initialized" }), null);
  // An unknown NOTIFICATION is still a notification: dropped, not errored.
  assertEquals(await reply(s, { jsonrpc: "2.0", method: "some/notification" }), null);
});

Deno.test("tools/list maps the provider's tools and never returns an undefined schema", async () => {
  const s = server({
    listTools: async () => [
      { name: "list_tabs", description: "List open tabs", inputSchema: { type: "object", properties: { x: { type: "string" } } } },
      { name: "no_schema", description: "takes nothing" },
      { name: "", description: "nameless is dropped" },
    ],
  });
  const res = await reply(s, req(1, "tools/list"));
  assertEquals(res.result.tools.length, 2, "a nameless tool is dropped rather than exposed as an uncallable name");
  assertEquals(res.result.tools[0].inputSchema.properties.x.type, "string", "a real schema passes through untouched");
  assertEquals(res.result.tools[1].inputSchema, { type: "object", properties: {} }, "MCP requires a schema; absent becomes empty, never undefined");
});

Deno.test("tools/call runs the tool and returns a text content block", async () => {
  const s = server();
  const res = await reply(s, req(7, "tools/call", { name: "list_tabs", arguments: { verbose: true } }));
  assertEquals(res.id, 7);
  assertEquals(res.result.isError, false);
  assertEquals(res.result.content[0].type, "text");
  assertEquals(JSON.parse(res.result.content[0].text), { ok: true, tool: "list_tabs", args: { verbose: true } });
});

Deno.test("tools/call: an owner refusal is a NAMED result the model can read, not a transport error", async () => {
  // The distinction is load-bearing. `{ok:false}` means the call ran and the
  // answer is no (the owner denied it); a thrown error means the tool crashed.
  // Collapsing them would hide a denial inside a stack trace.
  const s = server({ callTool: async () => ({ ok: false, error: "Owner denied the requested capability." }) });
  const res = await reply(s, req(1, "tools/call", { name: "list_tabs", arguments: {} }));
  assertEquals(res.error, undefined, "a refusal is not a JSON-RPC error");
  assertEquals(res.result.isError, true);
  assert(res.result.content[0].text.includes("Owner denied"), res.result.content[0].text);

  // A throw IS a protocol-level failure and stays distinguishable.
  const boom = server({ callTool: async () => { throw new Error("tab closed"); } });
  const thrown = await reply(boom, req(2, "tools/call", { name: "list_tabs", arguments: {} }));
  assertEquals(thrown.error.code, RPC_INTERNAL_ERROR);
  assert(thrown.error.message.includes("tab closed"), thrown.error.message);

  // A tool the provider does not have is the provider's answer to give.
  const missing = server({ callTool: async () => { throw new Error("no such tool"); } });
  const unknown = await reply(missing, req(3, "tools/call", { name: "nope", arguments: {} }));
  assertEquals(unknown.error.code, RPC_INTERNAL_ERROR);
});

Deno.test("tools/call requires a name; a nameless call is INVALID_PARAMS, not a crash", async () => {
  const s = server();
  const noName = await reply(s, req(1, "tools/call", { arguments: {} }));
  assertEquals(noName.error.code, RPC_INVALID_PARAMS);
  const emptyName = await reply(s, req(2, "tools/call", { name: "", arguments: {} }));
  assertEquals(emptyName.error.code, RPC_INVALID_PARAMS);

  // Arguments default to {} rather than crashing on a missing object.
  const bare = await reply(s, req(3, "tools/call", { name: "list_tabs" }));
  assertEquals(bare.result.isError, false);
});

Deno.test("an unsupported method names itself; malformed input is dropped rather than thrown", async () => {
  const s = server();
  const unknown = await reply(s, req(1, "resources/list"));
  assertEquals(unknown.error.code, RPC_METHOD_NOT_FOUND);
  assert(unknown.error.message.includes("resources/list"), "the refusal must name the method");

  // A RESPONSE-shaped message is neither a request nor a notification: it is
  // dropped, never answered, or two peers ping-pong responses forever.
  assertEquals(await reply(s, { jsonrpc: "2.0", id: 9, result: {} }), null);
  assertEquals(await reply(s, { jsonrpc: "2.0", id: 9, error: { code: -1, message: "x" } }), null);
  assertEquals(await reply(s, null), null);
  assertEquals(await reply(s, "not an object"), null);
  assertEquals(await reply(s, []), null);
  assertEquals(await reply(s, { jsonrpc: "2.0", method: "" }), null);
});

Deno.test("ping answers when asked and stays silent when it is a notification", async () => {
  const s = server();
  assertEquals((await reply(s, req(1, "ping"))).result, {});
  assertEquals(await reply(s, { jsonrpc: "2.0", method: "ping" }), null);
});

Deno.test("a provider that cannot list tools fails the REQUEST, not the connection", async () => {
  const s = server({ listTools: async () => { throw new Error("storage unavailable"); } });
  const res = await reply(s, req(1, "tools/list"));
  assertEquals(res.error.code, RPC_INTERNAL_ERROR);
  assert(res.error.message.includes("storage unavailable"), res.error.message);
  // The server still answers the next request: one bad call is not a dead server.
  assertEquals((await reply(s, req(2, "ping"))).result, {});
});

Deno.test("adapterHostsClientMcp: NO pinned adapter implements the client-hosted type, and a wrong true is the defect", () => {
  // The protocol supports `{type:"acp"}` + mcp/connect, mcp/message,
  // mcp/disconnect. Support in the SPEC is not support in the ADAPTER, and each
  // pinned adapter was read rather than assumed:
  //   pi-acp@0.0.33            stores params.mcpServers, never reads them
  //   claude-agent-acp@0.78.0  threads mcpServers to the SDK (stdio/http/sse),
  //                            but defines none of the mcp/* methods
  //   codex-acp@1.12.0         declares zMcpServerAcp and the method-name
  //                            constants, yet connectionId/serverId occur ONLY
  //                            in those schemas, never in executing code
  //
  // So every one is false, and this test would rather assert an inconvenient
  // false than a comfortable true: an advertised server the adapter ignores
  // makes the session LOOK capable while the harness reaches for its own
  // browser tooling — the exact failure this change exists to fix.
  assertEquals(adapterHostsClientMcp("pi"), false);
  assertEquals(adapterHostsClientMcp("claude-code"), false);
  assertEquals(adapterHostsClientMcp("codex"), false,
    "codex-acp declares the schema but implements nothing; declaring it supported would advertise a server it silently ignores");
  // Unknown adapters are not guessed at either — same reason, one import away.
  assertEquals(adapterHostsClientMcp("some-new-harness"), false);
  assertEquals(adapterHostsClientMcp(""), false);
  assertEquals(adapterHostsClientMcp(undefined), false);
});

Deno.test("capClientMcpServerEntry: the declared entry is the ACP-hosted shape, never a url or a command", () => {
  const entry: Any = capClientMcpServerEntry();
  assertEquals(entry.type, "acp");
  assertEquals(entry.serverId, CAP_MCP_SERVER_ID);
  // A url or a command would mean a second endpoint or a second process, which
  // is the thing the owner rejected. Assert their ABSENCE, not just the type.
  assertEquals("url" in entry, false);
  assertEquals("command" in entry, false);
  assertEquals("args" in entry, false);
});

Deno.test("the server refuses to be built without both providers", () => {
  const missingList = caught(() => createHarnessMcpServer({ callTool: async () => ({}) } as Any));
  assert(missingList.includes("listTools"), missingList);

  const missingCall = caught(() => createHarnessMcpServer({ listTools: async () => [] } as Any));
  assert(missingCall.includes("callTool"), missingCall);
});
