// tests/mcp-tool-injection.test.ts — the run-time MCP tool injection
// (CAP-FB-20260831-MCP-TOOL-INJECTION-01).
//
// The falsification gate (the entry's Unit gate): a mounted server's tool is
// namespaced `mcp__<server>__<tool>` and its RESULT is fenced untrusted; the
// model-facing catalog descriptor carries the honest `mcp` source kind (so the
// lazy projection treats its output as external content). Falsify by removing
// the fence tag in mcp-run-tools.js: the "result is fenced untrusted" assertions
// go RED.
// @ts-nocheck — the fake mount is intentionally dynamic (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildMcpRunTools, isMcpErrorResult } from "../extension/lib/mcp-run-tools.js";
import { adaptMcpTools, canonicalToolDescriptor, TOOL_SOURCE_KINDS } from "../extension/lib/tool-catalog.js";
import { executableMcpToolRecords } from "../extension/lib/lazy-tool-protocol.js";

// A fake mounted set shaped exactly like mountRemoteMcpServers' output: the keys
// are already namespaced (the mount does the `mcp__<server>__<tool>` flattening).
function fakeMount(calls = []) {
  return {
    tools: {
      "mcp__calc__add": {
        name: "mcp__calc__add",
        description: "Add two numbers.",
        inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
        origin: "calc",
        async call(args) {
          calls.push({ name: "mcp__calc__add", args });
          return String((args?.a ?? 0) + (args?.b ?? 0));
        },
      },
    },
  };
}

Deno.test("a mounted MCP tool keeps its mcp__<server>__<tool> namespace", () => {
  const map = buildMcpRunTools(fakeMount());
  assert("mcp__calc__add" in map, "the namespaced tool name is preserved");
  assert(typeof map["mcp__calc__add"].execute === "function");
  assert(typeof map["mcp__calc__add"].inputSchema?.safeParse === "function", "the JSON schema compiled to a zod schema for the lazy validator");
});

Deno.test("an MCP tool RESULT is fenced untrusted (the falsification gate)", async () => {
  const map = buildMcpRunTools(fakeMount());
  const result = await map["mcp__calc__add"].execute({ a: 3, b: 5 });
  // This is the property the fence protects. tagUntrusted wraps a string result
  // as { untrusted:true, value }. Removing the fence in mcp-run-tools.js makes
  // execute return the bare "8" and BOTH assertions below fail.
  assertEquals(result?.untrusted, true, "the MCP result is tagged untrusted so the projection fences it");
  assertEquals(result?.value, "8", "the real MCP output is carried inside the fence");
});

Deno.test("the catalog descriptor carries the honest `mcp` source kind", () => {
  assert(TOOL_SOURCE_KINDS.includes("mcp"), "mcp is a registered tool source kind");
  const map = buildMcpRunTools(fakeMount());
  const [input] = adaptMcpTools(map, {
    version: "run",
    sourceGeneration: "mcp:test",
    packageDigest: "d".repeat(64),
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
  });
  assertEquals(input.sourceKind, "mcp");
  assertEquals(input.toolId, "mcp__calc__add");
  const descriptor = canonicalToolDescriptor(input);
  // External tools are never trusted read-only/idempotent — replay-unknown.
  assertEquals(descriptor.trustedReplaySafety, "unknown");
});

Deno.test("executableMcpToolRecords produces a dispatchable, fenced record", async () => {
  const map = buildMcpRunTools(fakeMount());
  const records = executableMcpToolRecords(map, {
    version: "run",
    sourceGeneration: "mcp:test",
    packageDigest: "d".repeat(64),
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
  });
  assertEquals(records.length, 1);
  const rec = records[0];
  const validated = await rec.validateArguments({ a: 2, b: 4 });
  assert(validated.ok === true, "valid args pass the compiled schema");
  const dispatched = await rec.dispatch({ a: 2, b: 4 }, {});
  assertEquals(dispatched?.untrusted, true, "the dispatched MCP result stays fenced untrusted");
  assertEquals(dispatched?.value, "6");
});

Deno.test("per-server first-use approval: one card per server per run", async () => {
  const asked = [];
  const map = buildMcpRunTools(fakeMount(), {
    approveServer: async (serverId) => {
      asked.push(serverId);
      return { ok: true };
    },
  });
  await map["mcp__calc__add"].execute({ a: 1, b: 1 });
  await map["mcp__calc__add"].execute({ a: 2, b: 2 });
  assertEquals(asked, ["calc"], "the owner is asked exactly once for the server, then the grant holds for the run");
});

Deno.test("a denied server call is NOT performed and NOT fenced-as-content", async () => {
  const calls = [];
  const map = buildMcpRunTools(fakeMount(calls), {
    approveServer: async () => ({ ok: false, approvalDenied: true, error: "The owner denied MCP server calc." }),
  });
  const result = await map["mcp__calc__add"].execute({ a: 1, b: 1 });
  assertEquals(result.ok, false);
  assertEquals(result.approvalDenied, true);
  assertEquals(calls.length, 0, "the underlying MCP tool was never called");
  assert(result.untrusted !== true, "our own denial message is not tagged as untrusted server content");
});

Deno.test("a successful MCP call is ledgered; an error result is not", async () => {
  const rows = [];
  const ledger = (row) => rows.push(row);

  const okMap = buildMcpRunTools(fakeMount(), { ledger });
  await okMap["mcp__calc__add"].execute({ a: 1, b: 2 });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].name, "mcp__calc__add");
  assertEquals(rows[0].serverId, "calc");

  // A call that returns mcp-client-core's error string is a failure — no row.
  const errMount = {
    tools: {
      "mcp__calc__boom": {
        name: "mcp__calc__boom", description: "", inputSchema: {}, origin: "calc",
        async call() { return "Error calling mcp__calc__boom: down"; },
      },
    },
  };
  const errMap = buildMcpRunTools(errMount, { ledger });
  const errResult = await errMap["mcp__calc__boom"].execute({});
  assertEquals(rows.length, 1, "a failed MCP call is not ledgered");
  // The error text is still fenced (a server-echoed error can carry injection).
  assertEquals(errResult.untrusted, true);
  assert(isMcpErrorResult("Error calling x: y"));
  assert(!isMcpErrorResult("8"));
});
