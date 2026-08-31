// mcp-client-core.test.ts — CAP-FB-20260831-MCP-TRANSPORT-SPIKE-01
//
// The falsification gate for per-server MCP resilience. The mount helper must
// isolate a failing server: given one good server and one that fails to
// connect, the good server's tools are still mounted and callable, and the
// failure is reported WITHOUT throwing or tearing down the working server.
//
// Falsify by reverting mountRemoteMcpServers to agent-do's all-or-nothing
// behaviour (rethrow on any server failure): the "isolation" tests go RED.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  mountRemoteMcpServers,
  namespacedToolName,
  formatMcpToolResult,
} from "../extension/lib/mcp-client-core.js";

/** A fake MCP client mirroring the SDK Client surface we depend on. */
function fakeClientFactory() {
  const events: string[] = [];
  const createClient = (config: any) => {
    const behaviour = config.__test;
    return {
      async connect() {
        events.push(`connect:${config.name}`);
        if (behaviour?.connectError) throw new Error(behaviour.connectError);
      },
      async listTools() {
        if (behaviour?.listError) throw new Error(behaviour.listError);
        return { tools: behaviour?.tools ?? [] };
      },
      async callTool({ name, arguments: args }: any) {
        if (behaviour?.callError) throw new Error(behaviour.callError);
        // echo the args back as MCP text content
        return { content: [{ type: "text", text: `ok:${name}:${JSON.stringify(args)}` }] };
      },
      async close() {
        events.push(`close:${config.name}`);
      },
    };
  };
  return { createClient, events };
}

const addTool = { name: "add", description: "adds", inputSchema: { type: "object" } };

Deno.test("mounts a reachable server: tools are namespaced and callable", async () => {
  const { createClient } = fakeClientFactory();
  const mount = await mountRemoteMcpServers(
    [{ name: "calc", transport: { type: "http", url: "http://x" }, __test: { tools: [addTool] } } as any],
    { createClient },
  );
  const toolName = namespacedToolName("calc", "add");
  assert(toolName in mount.tools, "namespaced tool registered");
  assertEquals(mount.toolOrigins[toolName], "calc");
  assertEquals(mount.servers, [{ name: "calc", ok: true, toolCount: 1 }]);
  const out = await mount.tools[toolName].call({ a: 3, b: 5 });
  assertEquals(out, `ok:add:${JSON.stringify({ a: 3, b: 5 })}`);
  await mount.close();
});

Deno.test("per-server isolation: an unreachable server does not kill the working one", async () => {
  const { createClient, events } = fakeClientFactory();
  const mount = await mountRemoteMcpServers(
    [
      { name: "good", transport: { type: "http", url: "http://good" }, __test: { tools: [addTool] } },
      { name: "bad", transport: { type: "http", url: "http://bad" }, __test: { connectError: "ECONNREFUSED" } },
    ] as any,
    { createClient },
  );

  // The whole mount did NOT throw, and the good server is fully usable.
  const good = mount.servers.find((s) => s.name === "good");
  const bad = mount.servers.find((s) => s.name === "bad");
  assertEquals(good, { name: "good", ok: true, toolCount: 1 });
  assert(bad && bad.ok === false, "bad server reported failed");
  assert(bad!.error!.includes("ECONNREFUSED"), "failure carries the error");

  const toolName = namespacedToolName("good", "add");
  assert(toolName in mount.tools, "the working server's tool is still mounted");
  const out = await mount.tools[toolName].call({ a: 1, b: 1 });
  assertEquals(out, `ok:add:${JSON.stringify({ a: 1, b: 1 })}`);

  // The failed server's half-open client was closed; the good one was not.
  assert(events.includes("close:bad"), "failed server was torn down");
  assert(!events.includes("close:good"), "working server was NOT torn down");
  await mount.close();
});

Deno.test("isolation holds when listTools fails after connect", async () => {
  const { createClient } = fakeClientFactory();
  const mount = await mountRemoteMcpServers(
    [
      { name: "good", transport: { type: "http", url: "http://good" }, __test: { tools: [addTool] } },
      { name: "flaky", transport: { type: "http", url: "http://flaky" }, __test: { listError: "list boom" } },
    ] as any,
    { createClient },
  );
  assertEquals(mount.servers.find((s) => s.name === "good")!.ok, true);
  const flaky = mount.servers.find((s) => s.name === "flaky")!;
  assertEquals(flaky.ok, false);
  assert(flaky.error!.includes("list boom"));
  // No tools from the flaky server leaked into the set.
  assert(!Object.keys(mount.tools).some((t) => t.startsWith("mcp__flaky__")));
  await mount.close();
});

Deno.test("close() closes every connected client and is idempotent", async () => {
  const { createClient, events } = fakeClientFactory();
  const mount = await mountRemoteMcpServers(
    [
      { name: "a", transport: { type: "http", url: "http://a" }, __test: { tools: [addTool] } },
      { name: "b", transport: { type: "sse", url: "http://b" }, __test: { tools: [addTool] } },
    ] as any,
    { createClient },
  );
  await mount.close();
  await mount.close(); // idempotent
  const closes = events.filter((e) => e.startsWith("close:"));
  assertEquals(closes.sort(), ["close:a", "close:b"]);
  // A tool called after close resolves to an error string (does not throw).
  const out = await mount.tools[namespacedToolName("a", "add")].call({});
  assert(out.includes("is closed"));
});

Deno.test("malformed / duplicate server names are a caller-contract throw", async () => {
  const { createClient } = fakeClientFactory();
  let threw = false;
  try {
    await mountRemoteMcpServers([{ name: "bad__name", transport: { type: "http", url: "http://x" } } as any], { createClient });
  } catch { threw = true; }
  assert(threw, "a name containing __ is rejected");

  threw = false;
  try {
    await mountRemoteMcpServers(
      [
        { name: "dup", transport: { type: "http", url: "http://x" } },
        { name: "dup", transport: { type: "http", url: "http://y" } },
      ] as any,
      { createClient },
    );
  } catch { threw = true; }
  assert(threw, "duplicate server names are rejected");
});

Deno.test("formatMcpToolResult flattens mixed content", () => {
  assertEquals(
    formatMcpToolResult({ content: [{ type: "text", text: "8" }] }),
    "8",
  );
  assertEquals(
    formatMcpToolResult({ isError: true, content: [{ type: "text", text: "nope" }] }),
    "Tool error: nope",
  );
});
