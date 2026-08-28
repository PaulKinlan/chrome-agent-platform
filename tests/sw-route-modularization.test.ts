// tests/sw-route-modularization.test.ts
// Tests for CAP-FB-20260821-SW-ROUTE-MODULARIZATION-01 (first slice: provider + kv + perm-lease)
// @ts-nocheck — unit tests run under Deno.

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import * as acorn from "npm:acorn";
import {
  createActivityRoutes,
  createProviderRoutes,
  createSchedulerRoutes,
  kvRoutes,
  mergeRouteMaps,
  permLeaseRoutes,
  requireSettingsSender,
} from "../extension/background/routes/index.js";
import { PAGE_ALLOWED_ROUTES } from "../extension/lib/pure.js";
import { ATTESTATION_KEY_STORE } from "../extension/lib/system-prompts.js";
import { kvSet } from "../extension/lib/kv.js";

// Canonical baseline route list (the exact registered routes; grows only with a deliberate route addition)
const BASELINE_ROUTES = [
  "cap:fetch",
  "capabilities.status",
  "notifications.list",
  "notification.get",
  "notification.dismiss",
  "alarms.permission-granted",
  "capability.revoke",
  "kv.get",
  "kv.set",
  "kv.remove",
  "perm-lease.acquire",
  "perm-lease.settle",
  "perm-lease.state",
  "provider.get",
  "provider.summary",
  "provider.permission-summary",
  "provider.status",
  "provider.set",
  "provider.clear-key",
  "provider.test",
  "provider.models",
  "invalidate-agent",
  "agent.orchestrator",
  "tool-catalog.shadow",
  "tool.preview.run",
  "agent.run",
  "agent.list",
  "thread.list",
  "thread.get",
  "thread.delete",
  "thread.rename",
  "thread.name",
  "fs-grant.list",
  "fs-grant.get",
  "fs-grant.remove",
  "fs-grant.list-entries",
  "fs-grant.read-file",
  "fs-grant.write-file",
  "fs-grant.scan",
  "named-agent.list",
  "named-agent.get",
  "named-agent.create",
  "named-agent.update",
  "named-agent.set-provider",
  "named-agent.delete",
  "named-agent.grep",
  "named-agent.avatar",
  "named-agent.refine",
  "named-agent.run",
  "named-agent.history",
  "run-log.list",
  "activity.list",
  "agent.discoverable-tabs",
  "agent.directory",
  "system.factoryReset",
  "system.factoryResetEnumerate",
  "agent.registry",
  "agent.get",
  "agent.update",
  "tools.list",
  "tools.invoke",
  "tools.upsert",
  "enrollment.status",
  "tools.approve",
  "tools.pending",
  "tools.allOrigins",
  "webmcp.diagnostics.get",
  "webmcp.diagnostics.set",
  "webmcp.status",
  "sidepanel.getTarget",
  "sidepanel.getTools",
  "sidepanel.openPage",
  "skills.set",
  "skills.get",
  "skills.all",
  "memory.get",
  "memory.set",
  "memory.list",
  "memory.clear",
  "memory.origins",
  "screenshots.list",
  "screenshots.get",
  "usage.get",
  "usage.clear",
  "management.pending-approvals",
  "management.resolve-approval",
  "asset.create",
  "asset.update",
  "asset.delete",
  "asset.list",
  "asset.get",
  "script.create",
  "script.update",
  "script.delete",
  "script.list",
  "script.get",
  "script.run",
  "capability.request",
  "memory.overview",
  "memory.stores",
  "register-task",
  "run-task",
  "run.list",
  "run.cancel",
  "run.resume",
  "run.retry",
  "run.logs",
  "task.list",
  "task.retry",
  "task.cancel",
  "task.cancelBackground",
  // Per-agent schedule visibility + control (owner request): the routes are
  // mutation-gated (requireOwnerApproval) — task.pause/resume/update; the
  // schedules.list route is the agent-scoped read for the schedules_list tool.
  "task.pause",
  "task.resume",
  "task.update",
  "schedules.list",
  "recipe.list",
  "skill.list",
  "skill.import",
  "recipe.run",
  "background-agent.list",
  "background-agent.set",
  "recipe.custom-list",
  "recipe.duplicate",
  "recipe.update",
  "recipe.delete",
  "prompt.describe",
  "prompt.set",
  "prompt.reset",
  "prompt.keep",
  "prompt.rotateAttestationKey",
  "prompt.attest",
  "prompt.attestRun",
  "background-agent.history",
  "background-agent.run",
  "hooks.status",
  "hooks.deny",
  "hooks.subscribe",
  "hooks.unsubscribe",
  "browser-control.get",
  "browser-control.set",
  "agent.create",
  "agent.enroll-origin",
  "agent.delete",
  "agent.retry-cleanup",
  "agent.pending-cleanup",
  "agent.delegate",
  "agent.listAll",
  "capture.tab",
  "diagnostics.list",
  "diagnostics.clear",
  "observability.dumpTrace",
  "observability.clearTrace",
  "observability.setVerbosity",
  "diagnostics.report",
  "security.state",
  "security.clear",
];

Deno.test("sw routes: mergeRouteMaps combines maps and detects collisions", () => {
  const mapA = { "test.a": () => "a" };
  const mapB = { "test.b": () => "b" };
  const merged = mergeRouteMaps(mapA, mapB);
  assertEquals(Object.keys(merged), ["test.a", "test.b"]);
  assertEquals(Object.isFrozen(merged), true);

  // Collision detection fails closed
  const mapC = { "test.a": () => "collision" };
  assertThrows(
    () => mergeRouteMaps(mapA, mapC),
    Error,
    'Route collision: "test.a" is already registered',
  );
});

Deno.test("sw routes: extracted module route maps are frozen and complete", () => {
  // KV routes (3)
  assertEquals(Object.keys(kvRoutes), ["kv.get", "kv.set", "kv.remove"]);
  assertEquals(Object.isFrozen(kvRoutes), true);

  // Perm-lease routes (3)
  assertEquals(Object.keys(permLeaseRoutes), [
    "perm-lease.acquire",
    "perm-lease.settle",
    "perm-lease.state",
  ]);
  assertEquals(Object.isFrozen(permLeaseRoutes), true);

  // Provider routes (8)
  let invalidated = false;
  const providerRoutes = createProviderRoutes({ invalidateAgent: () => { invalidated = true; } });
  assertEquals(Object.keys(providerRoutes), [
    "provider.get",
    "provider.summary",
    "provider.permission-summary",
    "provider.status",
    "provider.set",
    "provider.clear-key",
    "provider.test",
    "provider.models",
  ]);
  assertEquals(Object.isFrozen(providerRoutes), true);
});

Deno.test("sw routes: requireSettingsSender owner gate rejects non-owner-options principals", () => {
  // Pass with owner-options
  requireSettingsSender({ principal: "owner-options" });

  // Fail on all other principals
  for (const bad of [
    undefined,
    null,
    {},
    { principal: "extension" },
    { principal: "page" },
    { principal: "owner-ntp" },
    { principal: "owner-directory" },
  ]) {
    assertThrows(
      () => requireSettingsSender(bad),
      Error,
      "provider credential routes are restricted to the Settings surface",
    );
  }
});

const SCHEDULER_STUB_DEPS = {
  pauseScheduledTask: () => {},
  resumeScheduledTask: () => {},
  updateScheduledTask: () => {},
  listScheduledTasks: () => {},
  requireOwnerApproval: () => {},
  currentRunContext: () => null,
  broadcastProgress: () => {},
  canonicalOperationTarget: () => "",
  canonicalScalar: (v) => v,
  payloadFields: () => ({}),
};

Deno.test("sw routes: AST verification of route registration across service-worker and modules", () => {
  const swSrc = Deno.readTextFileSync(new URL("../extension/background/service-worker.js", import.meta.url).pathname);
  const ast = acorn.parse(swSrc, { ecmaVersion: "latest", sourceType: "module" });

  // Find the mergeRouteMaps call for handlers
  let mergeCall = null;
  for (const node of ast.body) {
    if (node.type === "VariableDeclaration") {
      for (const decl of node.declarations) {
        if (decl.id.name === "handlers" && decl.init && decl.init.type === "CallExpression") {
          mergeCall = decl.init;
          break;
        }
      }
    }
  }

  assert(mergeCall, "handlers must be initialized via mergeRouteMaps");
  assertEquals(mergeCall.callee.name, "mergeRouteMaps");

  // Extract inline routes from ObjectExpressions in the mergeRouteMaps arguments
  const registeredRouteKeys = [];
  const providerRoutes = createProviderRoutes();
  const activityRoutes = createActivityRoutes();

  for (const arg of mergeCall.arguments) {
    if (arg.type === "ObjectExpression") {
      for (const prop of arg.properties) {
        if (prop.key.type === "Literal") {
          registeredRouteKeys.push(prop.key.value);
        } else if (prop.key.type === "Identifier") {
          registeredRouteKeys.push(prop.key.name);
        }
      }
    } else if (arg.type === "Identifier") {
      if (arg.name === "kvRoutes") {
        registeredRouteKeys.push(...Object.keys(kvRoutes));
      } else if (arg.name === "permLeaseRoutes") {
        registeredRouteKeys.push(...Object.keys(permLeaseRoutes));
      } else if (arg.name === "providerRoutes") {
        registeredRouteKeys.push(...Object.keys(providerRoutes));
      } else if (arg.name === "activityRoutes") {
        registeredRouteKeys.push(...Object.keys(activityRoutes));
      } else if (arg.name === "schedulerRoutes") {
        // Per-agent schedule routes (schedules.list / task.pause / task.resume /
        // task.update / task.retry).
        registeredRouteKeys.push(...Object.keys(createSchedulerRoutes(SCHEDULER_STUB_DEPS)));
      }
    }
  }

  assertEquals(
    registeredRouteKeys.length,
    BASELINE_ROUTES.length,
    `Registered routes count (${registeredRouteKeys.length}) must match baseline (${BASELINE_ROUTES.length})`,
  );

  const registeredSet = new Set(registeredRouteKeys);
  const baselineSet = new Set(BASELINE_ROUTES);
  assertEquals(registeredSet, baselineSet, "Route sets must be byte-identical");
});

Deno.test("sw routes: PAGE_ALLOWED_ROUTES admits only safe read/report routes", () => {
  // Extracted routes (kv, perm-lease, provider) must NEVER be in PAGE_ALLOWED_ROUTES
  for (const k of Object.keys(kvRoutes)) {
    assertEquals(PAGE_ALLOWED_ROUTES.has(k), false, `kv route ${k} must not be page-callable`);
  }
  for (const p of Object.keys(permLeaseRoutes)) {
    assertEquals(PAGE_ALLOWED_ROUTES.has(p), false, `perm-lease route ${p} must not be page-callable`);
  }
  const providerRoutes = createProviderRoutes();
  for (const pr of Object.keys(providerRoutes)) {
    assertEquals(PAGE_ALLOWED_ROUTES.has(pr), false, `provider route ${pr} must not be page-callable`);
  }
});

Deno.test("sw routes: kv route handlers enforce secret redaction and settings owner gate", async () => {
  // Seed secret-bearing and prompt-owned data
  await kvSet({
    "providerConfig": { provider: "anthropic", apiKey: "sk-ant-testsecret123456", model: "claude" },
    "cap:namedAgents": { "agent1": { apiKey: "sk-ant-agentkey" } },
    "custom-key": "public-val",
  });

  // kv.get redacts secret-bearing keys
  const readAll = await kvRoutes["kv.get"]({});
  assertEquals(readAll["custom-key"], "public-val");
  assertEquals(readAll["providerConfig"]?.apiKey, "[REDACTED]");
  assertEquals(readAll["cap:namedAgents"]?.agent1?.apiKey, "[REDACTED]");

  // kv.get denies explicit read of attestation key store
  const deniedKey = await kvRoutes["kv.get"]({ keys: [ATTESTATION_KEY_STORE] });
  assertEquals(deniedKey.ok, false);
  assert(deniedKey.error.includes("managed by the prompt.* routes"));

  // kv.set rejects secret-controlled keys from non-options principal
  const nonOptionsSet = await kvRoutes["kv.set"](
    { values: { "providerConfig": { provider: "openai" } } },
    { principal: "extension" },
  );
  assertEquals(nonOptionsSet.ok, false);
  assert(nonOptionsSet.error.includes("mutation requires the Settings surface"));

  // kv.set accepts secret-controlled keys from owner-options principal
  const optionsSet = await kvRoutes["kv.set"](
    { values: { "custom-allowed": "123" } },
    { principal: "owner-options" },
  );
  assertEquals(optionsSet.ok, true);

  // kv.remove rejects secret-controlled keys from non-options principal
  const nonOptionsRemove = await kvRoutes["kv.remove"](
    { keys: ["providerConfig"] },
    { principal: "extension" },
  );
  assertEquals(nonOptionsRemove.ok, false);
  assert(nonOptionsRemove.error.includes("removal requires the Settings surface"));
});

Deno.test("sw routes: provider route handlers enforce settings owner gate and invalidateAgent", async () => {
  let invalidated = false;
  const providerRoutes = createProviderRoutes({ invalidateAgent: () => { invalidated = true; } });

  // provider.get requires Settings sender
  await assertRejects(
    async () => await providerRoutes["provider.get"]({}, { principal: "extension" }),
    Error,
    "provider credential routes are restricted to the Settings surface",
  );

  // provider.set requires Settings sender
  await assertRejects(
    async () => await providerRoutes["provider.set"]({}, { principal: "extension" }),
    Error,
    "provider credential routes are restricted to the Settings surface",
  );

  // provider.clear-key requires Settings sender
  await assertRejects(
    async () => await providerRoutes["provider.clear-key"]({}, { principal: "extension" }),
    Error,
    "provider credential routes are restricted to the Settings surface",
  );

  // provider.test requires Settings sender
  await assertRejects(
    async () => await providerRoutes["provider.test"]({}, { principal: "extension" }),
    Error,
    "provider credential routes are restricted to the Settings surface",
  );

  // provider.models is accessible to extension
  const models = await providerRoutes["provider.models"]();
  assert(Array.isArray(models.choices));
});
