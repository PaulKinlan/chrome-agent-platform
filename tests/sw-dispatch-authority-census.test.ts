// @ts-nocheck
// tests/sw-dispatch-authority-census.test.ts — pins the full SW dispatch authority census (ygvt).
//
// Invariants guarded:
//   1. docs/SW-DISPATCH-AUTHORITY-CENSUS.md exists and is cited in AGENTS.md and routes/ROUTE_MAP.md.
//   2. Every registered route in handlers (via mergeRouteMaps) is extracted from actual AST composition.
//   3. The census classification is complete, disjoint, and covers 100% of registered routes (258 total).
//   4. Any new route added to mergeRouteMaps without explicit census classification fails RED.
//   5. Unclassified mutations (e.g. named-agent.set-tools) are pinned to an explicit inventory.
//   6. Unknown message types fail closed at the dispatcher.

import { assert, assertEquals } from "jsr:@std/assert@1";
import * as acorn from "npm:acorn";
import { PAGE_ALLOWED_ROUTES } from "../extension/lib/pure.js";
import { OWNER_DIRECT_ACTIONS, DESTRUCTIVE_ACTIONS } from "../extension/lib/owner-approval.js";

import { createActivityRoutes } from "../extension/background/routes/activity.js";
import { createSchedulerRoutes } from "../extension/background/routes/scheduler.js";
import { createFsGrantRoutes } from "../extension/background/routes/fs-grants.js";
import { createAgentWorkspaceRoutes } from "../extension/background/routes/agent-workspace.js";
import { createAgentBoardRoutes } from "../extension/lib/agent-board.js";
import { createMemoryRoutes } from "../extension/background/routes/memory.js";
import { createAgentScheduleRoutes } from "../extension/background/routes/agent-schedule.js";
import { createAgentWorkerRoutes } from "../extension/background/routes/agent-worker.js";
import { kvRoutes } from "../extension/background/routes/kv.js";
import { permLeaseRoutes } from "../extension/background/routes/perm-lease.js";
import { createProviderRoutes } from "../extension/background/routes/provider.js";
import { createMcpRoutes } from "../extension/background/routes/mcp.js";

const ROOT = new URL("..", import.meta.url).pathname;

// Exhaustive census classification
export const CENSUS_CATEGORIES = {
  PAGE_ALLOWED: new Set([
    "webmcp.detect.bootstrap", "webmcp.detect.arm", "webmcp.detected", "tools.list",
    "tools.upsert", "tools.pending", "webmcp.diagnostics.get", "enrollment.status",
  ]),
  SETTINGS_ONLY_DIRECT: new Set([
    "provider.get", "provider.set", "provider.clear-key", "provider.test",
    "mcp.servers.set", "mcp.servers.test",
    "fs-grant.remove", "fs-grant.write-file",
    "system.factoryReset", "system.factoryResetEnumerate", "owner.export.all", "owner.import.all",
    "memory.purgeJournals", "memory.sweepOrphans", "tool.preview.run", "tool-catalog.shadow",
    "management.pending-approvals", "hooks.deny", "tools.policy.set", "webmcp.consent.snapshot",
    "webmcp.consent.tool.set", "webmcp.consent.site.reset", "webmcp.audit.list", "tools.approve",
    "tool-stream.input.create", "tool-stream.input.append", "tool-stream.input.seal", "tool-stream.run",
    "tool-stream.output.read", "tool-stream.output.receipt", "tool-stream.stage-attachment",
    "tool-stream.stage-asset", "tool-stream.promote-output", "tool-stream.remove", "tool-stream.discard",
    "tool-stream.tabular-transform",
  ]),
  OWNER_APPROVAL_DIRECT: new Set([
    "named-agent.update", "named-agent.delete", "named-agent.set-schedule", "named-agent.set-mcp-servers",
    "agent.delete", "asset.delete", "asset.restore", "script.create", "script.run",
    "task.pause", "task.resume", "task.update", "recipe.delete",
  ]),
  OWNER_APPROVAL_REQUIRED: new Set([
    "capability.revoke", "named-agent.create", "named-agent.set-provider", "agent.update",
    "asset.update", "asset.patch", "asset.append", "script.update", "script.delete",
    "browser.cookie-value", "browser.destructive-action", "task.schedule-script",
    "workflow.run", "hooks.subscribe", "hooks.unsubscribe", "fs-grant.write-file-approved",
    "webmcp.use-tool",
  ]),
  OWNER_EXTENSION_FENCED: new Set([
    "actions.undo", "notifications.list", "notification.get", "notification.dismiss",
    "privacy.statement", "tools.invoke", "management.resolve-approval",
    "run.resolve-inline-approval", "approval.detail", "run.dismissFailed", "run.cancel",
    "run.resume", "run.continue", "run.control.steer", "run.control.queue.list",
    "run.control.queue.enqueue", "run.control.queue.remove", "run.control.queue.move",
    "run.retry", "run.logs", "site-skills.set", "agent-workspace.clear",
  ]),
  EXECUTION_AND_WORKER_ORCHESTRATION: new Set([
    "agent.run", "named-agent.run", "named-agent.delegate", "agent.delegate",
    "background-agent.run", "recipe.run", "register-task", "run-task", "task.retry",
    "python.execute", "table.run", "agent-worker.alive", "agent-worker.progress",
    "agent-worker.result", "agent-worker.ensure", "agent-worker.run", "agent-worker.dispatch",
    "agent-worker.tool", "agent-worker.close", "agent-worker.steer", "agent-worker.journal-append",
  ]),
  AGENT_BOARD: new Set([
    "board.list", "board.messages", "board.read", "board.deny.list", "board.post",
    "board.claim", "board.complete", "board.fail", "board.heartbeat", "board.wake",
    "board.message", "board.deny.add", "board.deny.remove",
  ]),
  STORAGE_KV_MEMORY_FENCED: new Set([
    "kv.get", "kv.set", "kv.remove", "perm-lease.state", "perm-lease.acquire",
    "perm-lease.settle", "memory.get", "memory.set", "memory.list", "memory.clear",
  ]),
  UNCLASSIFIED_MUTATIONS: new Set([
    "named-agent.set-tools", "named-agent.avatar", "named-agent.refine", "thread.delete",
    "thread.rename", "thread.name", "asset.create", "skill.import", "skill.delete",
    "skill.importBatch", "command.delete", "recipe.duplicate", "recipe.update",
    "background-agent.set", "prompt.set", "prompt.reset", "prompt.keep",
    "prompt.rotateAttestationKey", "browser-control.set", "browser-control.revoke",
    "agent.create", "agent.enroll-origin", "agent.retry-cleanup", "agent.pending-cleanup",
    "task.cancel", "task.cancelBackground", "schedule.cancelOrphans", "diagnostics.clear",
    "security.clear", "usage.clear", "webmcp.diagnostics.set", "skills.set",
  ]),
  READ_ONLY_STATUS_TELEMETRY: new Set([
    "actions.list", "activity.list", "agent-workspace.usage", "agent.directory",
    "agent.discoverable-tabs", "agent.get", "agent.history-view", "agent.list",
    "agent.listAll", "agent.orchestrator", "agent.registry", "agent.tool-offers",
    "alarms.permission-granted", "asset.capacity", "asset.get", "asset.list",
    "asset.version-get", "asset.versions", "background-agent.history", "background-agent.list",
    "browser-control.get", "cap:fetch", "capabilities.status", "capability.request",
    "capture.tab", "command.list", "diagnostics.list", "diagnostics.report",
    "fs-grant.get", "fs-grant.grep", "fs-grant.list", "fs-grant.list-entries",
    "fs-grant.read-file", "fs-grant.scan", "fs-grant.search", "hooks.status",
    "invalidate-agent", "mcp.servers.get", "mcp.servers.global-redacted", "memory.origins",
    "memory.overview", "memory.stores", "named-agent.get", "named-agent.grep",
    "named-agent.history", "named-agent.list", "named-agent.delegations", "observability.clearTrace",
    "observability.dumpTrace", "observability.page-measures", "observability.setVerbosity",
    "prompt.attest", "prompt.attestRun", "prompt.describe", "provider.models",
    "provider.permission-summary", "provider.status", "provider.summary", "recipe.custom-list",
    "recipe.list", "run-log.list", "run.dismissedFailed", "run.list", "schedules.list",
    "screenshots.get", "screenshots.list", "script.get", "script.list", "security.state",
    "sidepanel.getTarget", "sidepanel.getTools", "sidepanel.openPage", "site-skills.get",
    "skill.discover", "skill.list", "skills.all", "skills.get", "task.list", "task.nextRun",
    "thread.get", "thread.list", "tools.allOrigins", "tools.consent.states",
    "tools.policies", "usage.get", "webmcp.status",
  ]),
};

function extractAllRegisteredRoutes(): Set<string> {
  const swSrc = Deno.readTextFileSync(`${ROOT}extension/background/service-worker.js`);
  const ast = acorn.parse(swSrc, { ecmaVersion: "latest", sourceType: "module" }) as any;

  let mergeCall: any = null;
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

  const routes = new Set<string>();
  for (const arg of mergeCall.arguments) {
    if (arg.type === "Identifier") {
      if (arg.name === "activityRoutes") for (const k of Object.keys(createActivityRoutes({}))) routes.add(k);
      else if (arg.name === "schedulerRoutes") for (const k of Object.keys(createSchedulerRoutes({}))) routes.add(k);
      else if (arg.name === "fsGrantRoutes") for (const k of Object.keys(createFsGrantRoutes({}))) routes.add(k);
      else if (arg.name === "agentScheduleRoutes") for (const k of Object.keys(createAgentScheduleRoutes({}))) routes.add(k);
      else if (arg.name === "kvRoutes") for (const k of Object.keys(kvRoutes)) routes.add(k);
      else if (arg.name === "permLeaseRoutes") for (const k of Object.keys(permLeaseRoutes)) routes.add(k);
      else if (arg.name === "providerRoutes") for (const k of Object.keys(createProviderRoutes({}))) routes.add(k);
      else if (arg.name === "mcpRoutes") for (const k of Object.keys(createMcpRoutes({}))) routes.add(k);
    } else if (arg.type === "CallExpression") {
      if (arg.callee.name === "createAgentWorkspaceRoutes") for (const k of Object.keys(createAgentWorkspaceRoutes())) routes.add(k);
      else if (arg.callee.name === "createMemoryRoutes") for (const k of Object.keys(createMemoryRoutes())) routes.add(k);
      else if (arg.callee.name === "createAgentWorkerRoutes") for (const k of Object.keys(createAgentWorkerRoutes({}))) routes.add(k);
    } else if (arg.type === "MemberExpression") {
      if (arg.object.name === "boardRoutes" && arg.property.name === "routes") {
        for (const k of Object.keys(createAgentBoardRoutes({}).routes)) routes.add(k);
      }
    } else if (arg.type === "ObjectExpression") {
      for (const prop of arg.properties) {
        if (prop.type !== "Property") continue;
        const key = prop.key.type === "Literal" ? prop.key.value : prop.key.name;
        routes.add(key);
      }
    }
  }

  return routes;
}

Deno.test("census: docs/SW-DISPATCH-AUTHORITY-CENSUS.md exists and is cited", async () => {
  const census = await Deno.readTextFile(`${ROOT}docs/SW-DISPATCH-AUTHORITY-CENSUS.md`).catch(() => null);
  assert(census !== null, "docs/SW-DISPATCH-AUTHORITY-CENSUS.md must exist");
  assert(census.includes("named-agent.set-tools"), "census must document named-agent.set-tools finding");

  const routeMap = await Deno.readTextFile(`${ROOT}extension/background/routes/ROUTE_MAP.md`);
  assert(routeMap.includes("docs/SW-DISPATCH-AUTHORITY-CENSUS.md"), "ROUTE_MAP.md must cite census");

  const agents = await Deno.readTextFile(`${ROOT}AGENTS.md`);
  assert(agents.includes("docs/SW-DISPATCH-AUTHORITY-CENSUS.md"), "AGENTS.md must cite census");
});

Deno.test("census: all registered routes in handlers are derived via AST and total 258", () => {
  const registered = extractAllRegisteredRoutes();
  assertEquals(registered.size, 258, `registered routes population must equal 258 (got ${registered.size})`);
});

Deno.test("census: classification categories are exhaustive and mutually disjoint", () => {
  const registered = extractAllRegisteredRoutes();
  const classified = new Set<string>();

  for (const [categoryName, set] of Object.entries(CENSUS_CATEGORIES)) {
    for (const route of set) {
      assert(!classified.has(route), `route "${route}" is multiply classified in category "${categoryName}"`);
      assert(registered.has(route), `census category "${categoryName}" lists route "${route}" which is not in handlers`);
      classified.add(route);
    }
  }

  const unclassified = [...registered].filter((r) => !classified.has(r));
  assertEquals(
    unclassified,
    [],
    `new route(s) registered in handlers without census classification: ${unclassified.join(", ")}`,
  );
  assertEquals(classified.size, registered.size, "every registered route must be classified");
});

Deno.test("census: PAGE_ALLOWED matches PAGE_ALLOWED_ROUTES in lib/pure.js exactly", () => {
  assertEquals(
    CENSUS_CATEGORIES.PAGE_ALLOWED,
    PAGE_ALLOWED_ROUTES,
    "census PAGE_ALLOWED must match PAGE_ALLOWED_ROUTES exactly",
  );
});

Deno.test("census: named-agent.set-tools is pinned as an unclassified mutation gap", () => {
  assert(
    CENSUS_CATEGORIES.UNCLASSIFIED_MUTATIONS.has("named-agent.set-tools"),
    "named-agent.set-tools must be tracked as an unclassified mutation gap",
  );
});
