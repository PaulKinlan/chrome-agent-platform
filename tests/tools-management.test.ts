// tools-management.test.ts — a test SUITE per management tool: each tool's
// execute() routes to the RIGHT (type, args) + its zod schema validates (or
// rejects) its inputs. The management toolset is a pure route-mapping layer
// over callRoute (the actual route side effects are tested in the
// named-agents/artifacts/enrollment suites).
// @ts-nocheck

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { managementToolset, MANAGEMENT_TOOL_NAMES } from "../extension/lib/management-tools.js";

function makeTools() {
  const calls = [];
  const toolset = managementToolset({
    callRoute: async (type, args) => {
      calls.push({ type, args });
      return { ok: true, type, args };
    },
  });
  return { toolset, calls };
}

Deno.test("management: every tool in the catalog is callable except owner-only enroll_origin", () => {
  const { toolset } = makeTools();
  const ownerOnly = new Set(["enroll_origin"]); // owner-only host-access grant
  for (const name of MANAGEMENT_TOOL_NAMES) {
    if (ownerOnly.has(name)) continue;
    assert(toolset[name], `MANAGEMENT_TOOL_NAMES has ${name} but the toolset is missing it`);
    assert(typeof toolset[name].execute === "function", `${name}.execute must be a function`);
  }
});

Deno.test("management create_agent: routes to agent.create with the origin+name", async () => {
  const { toolset, calls } = makeTools();
  await toolset.create_agent.execute({ origin: "https://example.com", name: "Docs" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].type, "agent.create");
  assertEquals(calls[0].args.origin, "https://example.com");
  assertEquals(calls[0].args.name, "Docs");
});

Deno.test("management update_agent: routes to agent.update", async () => {
  const { toolset, calls } = makeTools();
  await toolset.update_agent.execute({ origin: "https://example.com", name: "Renamed" });
  assertEquals(calls[0].type, "agent.update");
  assertEquals(calls[0].args.name, "Renamed");
});

Deno.test("management delete_agent: routes to agent.delete (authoritative)", async () => {
  const { toolset, calls } = makeTools();
  await toolset.delete_agent.execute({ origin: "https://example.com" });
  assertEquals(calls[0].type, "agent.delete");
});

Deno.test("management get_agent / list_agents: route correctly", async () => {
  const { toolset, calls } = makeTools();
  await toolset.get_agent.execute({ origin: "https://example.com" });
  assertEquals(calls[0].type, "agent.get");
  await toolset.list_agents.execute({});
  assertEquals(calls[1].type, "agent.directory");
});

Deno.test("management enroll_origin is NOT exposed (owner-only host access)", () => {
  const { toolset } = makeTools();
  assert(!("enroll_origin" in toolset), "enroll_origin must NOT be model-callable (owner-only)");
});

Deno.test("management disenroll_origin: routes to agent.delete", async () => {
  const { toolset, calls } = makeTools();
  await toolset.disenroll_origin.execute({ origin: "https://example.com" });
  assertEquals(calls[0].type, "agent.delete");
});

Deno.test("management create_asset: routes with an explicit origin + type", async () => {
  const { toolset, calls } = makeTools();
  await toolset.create_asset.execute({ origin: "master", name: "report", content: "<h1>hi</h1>", type: "html" });
  assertEquals(calls[0].type, "asset.create");
  assertEquals(calls[0].args.origin, "master");
  assertEquals(calls[0].args.assetType, "html");
  assertEquals(calls[0].args.content, "<h1>hi</h1>");
});

Deno.test("management create_asset: the schema DEFAULTS origin to master + type to text", () => {
  const { toolset } = makeTools();
  const parsed = toolset.create_asset.inputSchema.parse({ name: "x", content: "y" });
  assertEquals(parsed.origin, "master");
  assertEquals(parsed.type, "text");
});

Deno.test("management create_asset: the schema rejects an unknown type", () => {
  const { toolset } = makeTools();
  assertThrows(() => toolset.create_asset.inputSchema.parse({ name: "x", content: "y", type: "nope" }));
});

Deno.test("management update_asset: routes with the id + optional fields", async () => {
  const { toolset, calls } = makeTools();
  await toolset.update_asset.execute({ id: "abc", content: "updated" });
  assertEquals(calls[0].type, "asset.update");
  assertEquals(calls[0].args.id, "abc");
  assertEquals(calls[0].args.content, "updated");
});

Deno.test("management delete_asset: routes to asset.delete", async () => {
  const { toolset, calls } = makeTools();
  await toolset.delete_asset.execute({ id: "abc" });
  assertEquals(calls[0].type, "asset.delete");
});

Deno.test("management list_assets / get_asset: route correctly", async () => {
  const { toolset, calls } = makeTools();
  await toolset.list_assets.execute({ origin: "https://example.com" });
  assertEquals(calls[0].type, "asset.list");
  await toolset.get_asset.execute({ id: "abc" });
  assertEquals(calls[1].type, "asset.get");
});

Deno.test("management grant_capability / revoke_capability: route correctly", async () => {
  const { toolset, calls } = makeTools();
  await toolset.grant_capability.execute({ id: "alarms" });
  assertEquals(calls[0].type, "capability.request");
  assertEquals(calls[0].args.id, "alarms");
  await toolset.revoke_capability.execute({ id: "alarms" });
  assertEquals(calls[1].type, "capability.revoke");
  assertEquals(calls[1].args.id, "alarms");
});

Deno.test("management get_usage / get_memory_overview: route correctly", async () => {
  const { toolset, calls } = makeTools();
  await toolset.get_usage.execute({});
  assertEquals(calls[0].type, "usage.get");
  await toolset.get_memory_overview.execute({});
  assertEquals(calls[1].type, "memory.overview");
});

Deno.test("management create_named_agent: routes to named-agent.create", async () => {
  const { toolset, calls } = makeTools();
  await toolset.create_named_agent.execute({ name: "PR Penguin", role: "reviews PRs" });
  assertEquals(calls[0].type, "named-agent.create");
  assertEquals(calls[0].args.name, "PR Penguin");
});

Deno.test("management subscribe_hook: routes to hooks.subscribe", async () => {
  const { toolset, calls } = makeTools();
  await toolset.subscribe_hook.execute({ hookId: "bookmarks.onCreated", recipeId: "auto-group-by-domain" });
  assertEquals(calls[0].type, "hooks.subscribe");
  assertEquals(calls[0].args.hookId, "bookmarks.onCreated");
  assertEquals(calls[0].args.recipeId, "auto-group-by-domain");
});

Deno.test("management generate_ui: routes to asset.create as an html artifact", async () => {
  const { toolset, calls } = makeTools();
  await toolset.generate_ui.execute({ name: "chart", html: "<div>hi</div>" });
  assertEquals(calls[0].type, "asset.create");
  assertEquals(calls[0].args.assetType, "html");
  assertEquals(calls[0].args.name, "chart");
  assertEquals(calls[0].args.content, "<div>hi</div>");
});

Deno.test("management: every callable tool declares a description", () => {
  const { toolset } = makeTools();
  for (const name of Object.keys(toolset)) {
    assert(toolset[name]?.description, `${name} must have a description`);
  }
});
