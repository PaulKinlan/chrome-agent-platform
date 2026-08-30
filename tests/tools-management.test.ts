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

Deno.test("management: MANAGEMENT_TOOL_NAMES exactly equals the callable toolset (no owner-only exception)", () => {
  const { toolset } = makeTools();
  const callable = Object.keys(toolset).sort();
  assertEquals(MANAGEMENT_TOOL_NAMES.slice().sort(), callable, "the introspection catalog must exactly match the callable tools");
  for (const name of callable) {
    assert(typeof toolset[name].execute === "function", `${name}.execute must be a function`);
  }
});

Deno.test("management: the all-name × all-surface forbidden-tool matrix is standalone-clean", async () => {
  const { toolset } = makeTools();
  const FORBIDDEN = ["enroll_origin", "grant_capability", "revoke_capability"];
  // A STANDALONE word for each forbidden name: word boundaries on BOTH sides so
  // `enroll_origin` is caught in `enroll_origin(` and `(enroll_origin)` but never
  // as the substring inside the STILL-callable `disenroll_origin`.
  const standalone = (name) => new RegExp(`\\b${name}\\b`);
  const masterSkill = await Deno.readTextFile("extension/lib/master-skill.js");
  const policy = await Deno.readTextFile("extension/lib/runtime-policy.js");

  // The matrix surfaces: every place the model could learn a removed tool.
  const surfaces = [
    ["toolset-keys", Object.keys(toolset).join("\n")],
    ["catalog", MANAGEMENT_TOOL_NAMES.join("\n")],
    ["master-skill", masterSkill],
    ["runtime-policy", policy],
    ...Object.entries(toolset).map(([name, t]) => [`${name}.description`, String(t?.description ?? "")]),
  ];
  for (const name of FORBIDDEN) {
    for (const [surface, text] of surfaces) {
      assert(!standalone(name).test(text), `${surface} must not contain the standalone tool name ${name}`);
    }
  }

  // Exact OLD parenthesized/plain fixtures MUST be caught.
  assert(standalone("enroll_origin").test("(enroll_origin)"), "the parenthesized (enroll_origin) fixture must match");
  assert(standalone("enroll_origin").test("enroll_origin("), "the plain enroll_origin( fixture must match");
  assert(standalone("grant_capability").test("grant_capability(id)"), "the grant_capability(id) fixture must match");
  assert(standalone("revoke_capability").test("revoke_capability(id)"), "the revoke_capability(id) fixture must match");

  // disenroll_origin MUST pass (never flagged by the standalone enroll_origin).
  assert(!standalone("enroll_origin").test("disenroll_origin"), "standalone enroll_origin must NOT match disenroll_origin");
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

Deno.test("management never exposes grant/revoke capability tools to the model", () => {
  const { toolset } = makeTools();
  assertEquals("grant_capability" in toolset, false);
  assertEquals("revoke_capability" in toolset, false);
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

// CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01 (commit B, the gate): the two
// tools are back, and their descriptions tell the model the owner approves the
// exact source + hosts (a description that omits this invites computed URLs
// and private targets the gate will refuse).
Deno.test("run_script and create_script are model-callable again and declare the owner-approval gate", async () => {
  const { toolset, calls } = makeTools();
  for (const name of ["run_script", "create_script"]) {
    assert(name in toolset, `${name} is callable`);
    assert(/OWNER APPROVAL/.test(String(toolset[name].description)), `${name} declares the approval gate`);
  }
  await toolset.create_script.execute({ name: "x", source: "return 1", origin: "master" });
  assertEquals(calls[0].type, "script.create");
  await toolset.run_script.execute({ id: "s_1", origin: "master" });
  assertEquals(calls[1].type, "script.run");
});
