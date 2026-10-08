// @ts-nocheck
// tests/sw-dispatch-authority-census.test.ts — pins the full SW dispatch authority census (ygvt).
//
// Invariants guarded:
//   1. docs/SW-DISPATCH-AUTHORITY-CENSUS.md exists and is cited in AGENTS.md and routes/ROUTE_MAP.md.
//   2. Every registered route in handlers (via mergeRouteMaps) is extracted from actual AST composition.
//   3. The census classification is complete, disjoint, and covers 100% of registered routes (290 total).
//      (l0r: recipe.list catalog fork deleted; wfo5: browser.callTool added;
//       s7wl: the vault/enclave maps the resolver below used to skip, +9.)
//   4. Any new route added to mergeRouteMaps without explicit census classification fails RED.
//   5. Unclassified mutations (e.g. named-agent.set-tools) are pinned to an explicit inventory.
//   6. The document's §3/§4 categories exactly match the tested classifications (4h47).
//   7. Each §4.3/§4.4 handler reaches its declared approval seam and owner-direct policy (gn3c).
//   8. Deleting a route seam or its injection fails RED naming the route (gn3c).
//   9. Every mergeRouteMaps group and companion R11/ROUTE_MAP/threat/architecture/strategy counts stay in sync (zb58/r073).

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
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
import { createVaultRoutes } from "../extension/background/routes/vault.js";
import { createEnclaveProxyRoutes } from "../extension/background/routes/enclave-proxy.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Exhaustive census classification
export const CENSUS_CATEGORIES = {
  PAGE_ALLOWED: new Set([
    "webmcp.detect.bootstrap", "webmcp.detect.arm", "webmcp.detected", "tools.list",
    "tools.upsert", "tools.pending", "enrollment.status",
  ]),
  SETTINGS_ONLY_DIRECT: new Set([
    "provider.get", "provider.set", "provider.clear-key", "provider.test",
    "mcp.servers.set", "mcp.servers.test",
    "fs-grant.remove", "fs-grant.write-file",
    "system.factoryReset", "system.factoryResetEnumerate", "owner.export.all", "owner.import.all",
    "memory.purgeJournals", "memory.sweepOrphans", "tool.preview.run", "tool-catalog.shadow",
    // ltkj.2: the Settings-only schema-2 validation surface (validation-list +
    // validate), both principal === "owner-options" with the exact-document
    // re-assertion; the broker runs in the options document, never the SW.
    "tool.package.validation-list", "tool.package.validate",
    // ltkj.3: the Settings-only schema-2 execution surface (tool.package.run).
    "tool.package.run",
    "management.pending-approvals", "hooks.deny", "tools.policy.set", "webmcp.consent.snapshot",
    "webmcp.consent.tool.set", "webmcp.consent.site.reset", "webmcp.audit.list", "tools.approve",
    "tool-stream.input.create", "tool-stream.input.append", "tool-stream.input.seal", "tool-stream.run",
    "tool-stream.output.read", "tool-stream.output.receipt", "tool-stream.stage-attachment",
    "tool-stream.stage-asset", "tool-stream.promote-output", "tool-stream.remove", "tool-stream.discard",
    "tool-stream.tabular-transform",
    "python.network.grant", "python.network.revoke",
    "wheel.put", "wheel.delete",
    // The vault + enclave Settings surface (jao1.5, bd17634f): every one of these
    // calls requireSettingsSender, or checks principal === "owner-options" itself
    // (enclave.status). chrome-agent-platform-s7wl added them to the population.
    "vault.status", "vault.set", "vault.configureProxy", "vault.rotate", "vault.delete",
    "vault.ledger.clear", "vault.test", "enclave.status",
  ]),
  OWNER_APPROVAL_DIRECT: new Set([
    "named-agent.update", "named-agent.delete", "named-agent.set-schedule", "named-agent.set-mcp-servers",
    "agent.delete", "asset.delete", "asset.restore", "script.create", "script.run",
    "task.pause", "task.resume", "task.update", "background-agent.delete",
  ]),
  OWNER_APPROVAL_REQUIRED: new Set([
    "capability.revoke", "named-agent.create", "named-agent.set-provider", "agent.update",
    "asset.update", "asset.patch", "asset.append", "script.update", "script.delete",
    "browser.cookie-value", "browser.destructive-action", "task.schedule-script",
    "workflow.run", "hooks.subscribe", "hooks.unsubscribe", "fs-grant.write-file-approved",
    "webmcp.use-tool", "attached-webmcp.invoke",
  ]),
  OWNER_EXTENSION_FENCED: new Set([
    "acp.commands",
    "actions.undo", "notifications.list", "notification.get", "notification.dismiss",
    "privacy.statement", "tools.invoke", "management.resolve-approval",
    "run.resolve-inline-approval", "approval.detail", "run.dismissFailed", "run.cancel",
    "run.resume", "run.continue", "run.control.steer", "run.control.queue.list",
    "run.control.queue.enqueue", "run.control.queue.remove", "run.control.queue.move",
    "run.retry", "run.logs", "site-skills.set", "agent-workspace.clear",
    "browser.callTool",
    // isAllowedCaller() is isOwnerPrincipal(context) or the SW-internal caller flag
    // (routes/enclave-proxy.js:180); pages and model runs are refused.
    "enclave.proxy",
  ]),
  EXECUTION_AND_WORKER_ORCHESTRATION: new Set([
    "agent.run", "named-agent.run", "named-agent.delegate", "agent.delegate",
    "background-agent.run", "skill.run", "register-task", "run-task", "task.retry",
    "python.execute", "python.fetch", "table.run", "agent-worker.alive", "agent-worker.progress",
    "agent-worker.result", "agent-worker.ensure", "agent-worker.run", "agent-worker.dispatch",
    "agent-worker.tool", "agent-worker.close", "agent-worker.steer", "agent-worker.journal-append",
    "acp.journal",
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
    "skill.importBatch", "command.delete", "background-agent.duplicate",
    "background-agent.update",
    "background-agent.set", "prompt.set", "prompt.reset", "prompt.keep",
    "prompt.rotateAttestationKey", "browser-control.set", "browser-control.revoke",
    "agent.create", "agent.enroll-origin", "agent.retry-cleanup", "agent.pending-cleanup",
    "task.cancel", "task.cancelBackground", "schedule.cancelOrphans", "diagnostics.clear",
    "security.clear", "usage.clear", "webmcp.diagnostics.set", "skills.set",
    "clipboard.write", "write_clipboard", "page.capture", "capture.page", "asset.export-to-folder",
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
    "provider.permission-summary", "provider.status", "provider.summary",
    "background-agent.custom-list", "run-log.list", "run.dismissedFailed", "run.list", "schedules.list",
    "screenshots.get", "screenshots.list", "script.get", "script.list", "security.state",
    "sidepanel.getTarget", "sidepanel.getTools", "sidepanel.openPage", "site-skills.get",
    "skill.discover", "skill.list", "skills.all", "skills.get", "task.list", "task.nextRun",
    "thread.get", "thread.list", "tools.allOrigins", "tools.consent.states",
    "tools.policies", "usage.get", "webmcp.diagnostics.get", "webmcp.status",
    "python.network.grants",
    "onDeviceText.summarize", "onDeviceText.detectLanguage", "onDeviceText.translate", "onDeviceText.availability",
    "wheel.list",
  ]),
};

function extractAllRegisteredRoutes(
  swSrc = Deno.readTextFileSync(`${ROOT}extension/background/service-worker.js`),
): Set<string> {
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

  // The module's own map declarations. Before chrome-agent-platform-s7wl this
  // extractor SKIPPED any mergeRouteMaps argument it did not recognize, silently:
  // `vaultRoutes`, `enclaveProxyRoutes` and `enclaveStatusRoutes` (9 routes,
  // landed 2026-10-03 in bd17634f) were never in the population the census
  // called complete. Every argument form is now resolved, and an unknown one
  // THROWS rather than shrinking the population.
  const swConsts = new Map<string, any>();
  for (const node of ast.body) {
    if (node.type !== "VariableDeclaration") continue;
    for (const decl of node.declarations) {
      if (decl.id?.type === "Identifier" && decl.init) swConsts.set(decl.id.name, decl.init);
    }
  }

  // The factories service-worker.js composes a map from. The stubs only satisfy
  // each factory's own argument validation — the keys come from the real returned
  // object, never from a parallel hand-kept list.
  const SW_ROUTE_FACTORY_STUBS: Record<string, () => object> = {
    createVaultRoutes: () => createVaultRoutes({ vault: { listMasked: () => [] }, requireSettingsSender: () => {} }),
    createEnclaveProxyRoutes: () => createEnclaveProxyRoutes({ vault: { getSecretRaw: () => null } }),
  };
  const keysOfObjectExpression = (node: any): string[] => {
    const keys: string[] = [];
    for (const prop of node.properties) {
      assert(prop.type === "Property", `mergeRouteMaps object contains unsupported ${prop.type}; route keys cannot be skipped`);
      assert(prop.key.type === "Literal" || prop.key.type === "Identifier", `mergeRouteMaps object contains computed key ${prop.key.type}`);
      keys.push(prop.key.type === "Literal" ? String(prop.key.value) : prop.key.name);
    }
    return keys;
  };

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
      else {
        const init = swConsts.get(arg.name);
        assert(init, `mergeRouteMaps argument "${arg.name}" is an identifier this extractor cannot resolve`);
        if (init.type === "ObjectExpression") {
          for (const k of keysOfObjectExpression(init)) routes.add(k);
        } else if (
          init.type === "CallExpression" && init.callee?.type === "Identifier" && SW_ROUTE_FACTORY_STUBS[init.callee.name]
        ) {
          for (const k of Object.keys(SW_ROUTE_FACTORY_STUBS[init.callee.name]())) routes.add(k);
        } else {
          throw new Error(
            `mergeRouteMaps argument "${arg.name}" resolves to a ${init.type} this extractor cannot read — ` +
              "teach it the form rather than letting the population shrink",
          );
        }
      }
    } else if (arg.type === "CallExpression") {
      if (arg.callee.name === "createAgentWorkspaceRoutes") for (const k of Object.keys(createAgentWorkspaceRoutes())) routes.add(k);
      else if (arg.callee.name === "createMemoryRoutes") for (const k of Object.keys(createMemoryRoutes())) routes.add(k);
      else if (arg.callee.name === "createAgentWorkerRoutes") for (const k of Object.keys(createAgentWorkerRoutes({}))) routes.add(k);
      else if (SW_ROUTE_FACTORY_STUBS[arg.callee.name]) for (const k of Object.keys(SW_ROUTE_FACTORY_STUBS[arg.callee.name]())) routes.add(k);
      else {
        throw new Error(
          `mergeRouteMaps argument calls ${arg.callee.name}(...) and this extractor cannot resolve it — ` +
            "teach it the form rather than letting the population shrink",
        );
      }
    } else if (arg.type === "MemberExpression") {
      if (arg.object.name === "boardRoutes" && arg.property.name === "routes") {
        for (const k of Object.keys(createAgentBoardRoutes({}).routes)) routes.add(k);
      } else {
        throw new Error(
          `mergeRouteMaps argument ${arg.object.name}.${arg.property.name} is a member expression this extractor cannot resolve`,
        );
      }
    } else if (arg.type === "ObjectExpression") {
      for (const k of keysOfObjectExpression(arg)) routes.add(k);
    } else {
      throw new Error(
        `mergeRouteMaps argument of type ${arg.type} is not handled by this extractor — ` +
          "teach it the form rather than letting the population shrink",
      );
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

// zb58: the route-map inventory was still at 258 after the executable census
// reached 285. Reconcile each named module/inline row with actual factory keys
// or service-worker AST keys; do not merely compare two hand-kept doc totals.
function assertRouteMap(routeMap: string): void {
  const registered = extractAllRegisteredRoutes();
  for (const [part, pattern] of [
    ["title", /## Route Map Inventory \(Comprehensive Census — (\d+) Routes\)/],
    ["intro", /exhaustive authority classification across all (\d+) routes/],
    ["total", /\| \*\*Total Registered Routes\*\* \| \*\*(\d+)\*\* \|/],
  ] as const) {
    const match = pattern.exec(routeMap);
    assert(match, `ROUTE_MAP ${part} must state a route total`);
    assertEquals(Number(match[1]), registered.size, `ROUTE_MAP ${part} must equal registered ${registered.size}`);
  }

  const sw = Deno.readTextFileSync(`${ROOT}extension/background/service-worker.js`);
  const ast = acorn.parse(sw, { ecmaVersion: "latest", sourceType: "module" }) as any;
  const decls = ast.body.flatMap((node: any) => node.type === "VariableDeclaration" ? node.declarations : []);
  const args = decls.find((decl: any) => decl.id?.name === "handlers")?.init?.arguments;
  assert(args, "SW handlers must still have mergeRouteMaps arguments");
  const keys = (arg: any): string[] => arg.properties.map((prop: any) => {
    assert(prop.type === "Property", `ROUTE_MAP cannot omit spread route group ${prop.type}`);
    return prop.key.type === "Literal" ? String(prop.key.value) : prop.key.name;
  });
  const assertNames = (row: string, cell: string, actual: string[]) => {
    const listed = [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    assertEquals(listed.length, actual.length, `ROUTE_MAP ${row} must list ${actual.length} names once`);
    for (const name of listed) assert(actual.includes(name), `ROUTE_MAP ${row} lists unknown route ${name}`);
    for (const name of actual) assert(listed.includes(name), `ROUTE_MAP ${row} omits registered route ${name}`);
  };
  let rowTotal = 0;
  const inline = args.map((arg: any, index: number) => arg.type === "ObjectExpression" ? index : -1).filter((n: number) => n >= 0);
  const inlineRows = [...routeMap.matchAll(/^\| `service-worker\.js` \(inline arg\[(\d+)\]\) \| (\d+) \| ([^|]+) \|/gm)];
  assertEquals(inlineRows.map((row) => Number(row[1])), inline, "ROUTE_MAP inline indexes must follow executable composition");
  for (const row of inlineRows) {
    const index = Number(row[1]);
    const actual = keys(args[index]);
    assertEquals(Number(row[2]), actual.length, `ROUTE_MAP inline arg[${index}] count`);
    if (actual.length <= 24) assertNames(`inline arg[${index}]`, row[3], actual);
    rowTotal += Number(row[2]);
  }

  const modules = new Map<string, string[]>([
    ["routes/kv.js", Object.keys(kvRoutes)],
    ["routes/perm-lease.js", Object.keys(permLeaseRoutes)],
    ["routes/provider.js", Object.keys(createProviderRoutes({}))],
    ["routes/mcp.js", Object.keys(createMcpRoutes({}))],
    ["routes/activity.js", Object.keys(createActivityRoutes({}))],
    ["routes/memory.js", Object.keys(createMemoryRoutes({}))],
    ["routes/fs-grants.js", Object.keys(createFsGrantRoutes({}))],
    ["routes/agent-workspace.js", Object.keys(createAgentWorkspaceRoutes())],
    ["routes/agent-schedule.js", Object.keys(createAgentScheduleRoutes({}))],
    ["routes/scheduler.js", Object.keys(createSchedulerRoutes({}))],
    ["routes/agent-worker.js", Object.keys(createAgentWorkerRoutes({}))],
    ["extension/lib/agent-board.js", Object.keys(createAgentBoardRoutes({}).routes)],
    ["routes/vault.js", Object.keys(createVaultRoutes({ vault: { listMasked: () => [] }, requireSettingsSender: () => {}, storageArea: null }))],
    ["routes/enclave-proxy.js", Object.keys(createEnclaveProxyRoutes({ vault: { getSecretRaw: () => null } }))],
  ]);
  const moduleRows = [...routeMap.matchAll(/^\| `((?:routes\/|extension\/lib\/)[^`]+)`(?: \([^|]+\))? \| (\d+) \| ([^|]+) \|/gm)];
  assertEquals(moduleRows.map((row) => row[1]), [...modules.keys()], "ROUTE_MAP must list all composed route modules once");
  for (const row of moduleRows) {
    const actual = modules.get(row[1])!;
    assertEquals(Number(row[2]), actual.length, `ROUTE_MAP ${row[1]} count`);
    assertNames(row[1], row[3], actual);
    rowTotal += Number(row[2]);
  }

  const statusRow = /^\| `service-worker\.js` \(`enclaveStatusRoutes`, arg\[(\d+)\]\) \| (\d+) \| ([^|]+) \|/m.exec(routeMap);
  assert(statusRow, "ROUTE_MAP must name the enclaveStatusRoutes group");
  const statusIndex = Number(statusRow[1]);
  assertEquals(args[statusIndex]?.name, "enclaveStatusRoutes", "ROUTE_MAP enclaveStatusRoutes index must match AST");
  const status = decls.find((decl: any) => decl.id?.name === "enclaveStatusRoutes")?.init;
  assertEquals(status?.type, "ObjectExpression", "enclaveStatusRoutes must remain an AST-readable route map");
  const statusKeys = keys(status);
  assertEquals(Number(statusRow[2]), statusKeys.length, "ROUTE_MAP enclaveStatusRoutes count");
  assertNames("enclaveStatusRoutes", statusRow[3], statusKeys);
  rowTotal += Number(statusRow[2]);
  assertEquals(rowTotal, registered.size, "ROUTE_MAP row counts must sum to registered population");
}

function assertRiskAndThreatPopulation(risks: string, threat: string): void {
  const r11 = /^### R11[^\n]*\n([\s\S]*?)(?=^---|^### R12)/m.exec(risks)?.[1];
  assert(r11, "RISK-REGISTER R11 section must exist");
  const unclassified = CENSUS_CATEGORIES.UNCLASSIFIED_MUTATIONS;
  const examples = /For example, ([^\n]+)$/.exec(r11.split("\n").find((line) => line.includes("For example,")) ?? "")?.[1] ?? "";
  const listed = [...examples.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  assertEquals(listed.length, 2, "RISK-REGISTER R11 must name two example routes");
  assertEquals(new Set(listed).size, 2, "RISK-REGISTER R11 examples must be distinct");
  for (const name of listed) assert(unclassified.has(name), `RISK-REGISTER R11 example route ${name} is not unclassified`);
  assert(CENSUS_CATEGORIES.OWNER_APPROVAL_DIRECT.has("background-agent.delete"), "R11's former deletion example must now be owner-direct");
  for (const [place, pattern, expected] of [
    ["R11 risk", /lists (\d+) unclassified mutation routes/, unclassified.size],
    ["R11 other routes", /other (\d+) routes in §4\.9/, unclassified.size - listed.length],
    ["R11 open question", /all (\d+) unclassified mutation routes/, unclassified.size],
  ] as const) {
    const match = pattern.exec(r11);
    assert(match, `RISK-REGISTER ${place} must state a population`);
    assertEquals(Number(match[1]), expected, `RISK-REGISTER ${place} population`);
  }
  const registered = extractAllRegisteredRoutes().size;
  for (const [place, pattern, expected] of [
    ["component map", /Service worker \(the privileged broker\)[^\n]*; (\d+) registered routes/, registered],
    ["dispatch census", /the (\d+)-route dispatch census and its (\d+) unclassified mutations/, registered],
    ["T4", /The (\d+) unclassified mutation routes \(T4\)/, unclassified.size],
  ] as const) {
    const match = pattern.exec(threat);
    assert(match, `THREAT_MODEL ${place} must state a population`);
    assertEquals(Number(match[1]), expected, `THREAT_MODEL ${place} population`);
    if (place === "dispatch census") assertEquals(Number(match[2]), unclassified.size, "THREAT_MODEL dispatch census gap count");
  }
  // 5x4iw: two additional mentions were not pinned by the older assertions.
  // Compare every population mention to the AST-derived route set, so changing
  // either the component-map pin or the T4 evidence pin turns the gate red.
  const mapPin = /The dispatch census and `tests\/sw-dispatch-authority-census\.test\.ts` assert (\d+) registered routes/.exec(threat);
  assert(mapPin, "THREAT_MODEL component-map evidence pin must state a population");
  assertEquals(Number(mapPin[1]), registered, "THREAT_MODEL component-map evidence pin population");
  const t4Pin = /The census §4\.9 lists (\d+) unclassified mutations among (\d+) registered routes/.exec(threat);
  assert(t4Pin, "THREAT_MODEL T4 evidence pin must state its populations");
  assertEquals(Number(t4Pin[1]), unclassified.size, "THREAT_MODEL T4 evidence pin unclassified count");
  assertEquals(Number(t4Pin[2]), registered, "THREAT_MODEL T4 evidence pin registered count");
  const populationMentions = [...threat.matchAll(/\b(\d+)(?:-route dispatch census| registered routes)\b/g)];
  assertEquals(populationMentions.length, 4, "THREAT_MODEL route-population mentions must be inventoried in this gate");
  for (const match of populationMentions) assertEquals(Number(match[1]), registered, "THREAT_MODEL route-population mention");
}

function assertArchitectureAndStrategyPopulation(arch: string, nativePlan: string): void {
  const registered = extractAllRegisteredRoutes().size;
  const archMatch = /documents the complete\s+(\d+)-route population/.exec(arch);
  assert(archMatch, "ARCHITECTURE.md must state the complete route population");
  assertEquals(Number(archMatch[1]), registered, "ARCHITECTURE.md route count must equal registered population");

  const planMatch = /maintain a (\d+)-route dispatch authority/.exec(nativePlan);
  assert(planMatch, "NATIVE-AGENT-POSITION-PLAN.md must state the dispatch authority route count");
  assertEquals(Number(planMatch[1]), registered, "NATIVE-AGENT-POSITION-PLAN.md route count must equal registered population");
}

Deno.test("census: ROUTE_MAP, risk R11, THREAT_MODEL, ARCHITECTURE, and NATIVE-AGENT-POSITION-PLAN match executable population", async () => {
  assertRouteMap(await Deno.readTextFile(`${ROOT}extension/background/routes/ROUTE_MAP.md`));
  assertRiskAndThreatPopulation(
    await Deno.readTextFile(`${ROOT}docs/RISK-REGISTER.md`),
    await Deno.readTextFile(`${ROOT}THREAT_MODEL.md`),
  );
  assertArchitectureAndStrategyPopulation(
    await Deno.readTextFile(`${ROOT}docs/ARCHITECTURE.md`),
    await Deno.readTextFile(`${ROOT}docs/NATIVE-AGENT-POSITION-PLAN.md`),
  );
});

Deno.test("census: companion-doc total and route-name falsifications RED by document/name", async () => {
  const map = await Deno.readTextFile(`${ROOT}extension/background/routes/ROUTE_MAP.md`);
  const risks = await Deno.readTextFile(`${ROOT}docs/RISK-REGISTER.md`);
  const threat = await Deno.readTextFile(`${ROOT}THREAT_MODEL.md`);
  const arch = await Deno.readTextFile(`${ROOT}docs/ARCHITECTURE.md`);
  const plan = await Deno.readTextFile(`${ROOT}docs/NATIVE-AGENT-POSITION-PLAN.md`);

  assertThrows(() => assertRouteMap(map.replace("**290**", "**289**")), Error, "ROUTE_MAP total");
  assertThrows(() => assertRouteMap(map.replace("`enclave.proxy`", "`enclave.proxy-renamed`")), Error, "enclave.proxy-renamed");
  assertThrows(() => assertRiskAndThreatPopulation(risks.replace("37 unclassified mutation routes", "31 unclassified mutation routes"), threat), Error, "RISK-REGISTER R11 risk");
  assertThrows(() => assertRiskAndThreatPopulation(risks.replace("`asset.export-to-folder` writes", "`asset.export-to-folder-renamed` writes"), threat), Error, "asset.export-to-folder-renamed");
  assertThrows(() => assertRiskAndThreatPopulation(risks,
    threat.replace("` assert 290 registered routes", "` assert 289 registered routes")),
    Error, "THREAT_MODEL component-map evidence pin population");
  assertThrows(() => assertRiskAndThreatPopulation(risks,
    threat.replace("37 unclassified mutations among 290 registered routes", "37 unclassified mutations among 289 registered routes")),
    Error, "THREAT_MODEL T4 evidence pin registered count");

  // r073 falsification drills:
  assertThrows(
    () => assertArchitectureAndStrategyPopulation(arch.replace("290-route population", "289-route population"), plan),
    Error,
    "ARCHITECTURE.md route count must equal registered population",
  );
  assertThrows(
    () => assertArchitectureAndStrategyPopulation(arch.replace("290-route population", "bogus text"), plan),
    Error,
    "ARCHITECTURE.md must state the complete route population",
  );
  assertThrows(
    () => assertArchitectureAndStrategyPopulation(arch, plan.replace("290-route dispatch authority", "289-route dispatch authority")),
    Error,
    "NATIVE-AGENT-POSITION-PLAN.md route count must equal registered population",
  );
  assertThrows(
    () => assertArchitectureAndStrategyPopulation(arch, plan.replace("290-route dispatch authority", "bogus text")),
    Error,
    "NATIVE-AGENT-POSITION-PLAN.md must state the dispatch authority route count",
  );
});

Deno.test("census: all registered routes in handlers are derived via AST and total 290", () => {
  const registered = extractAllRegisteredRoutes();
  assertEquals(registered.size, 290, `registered routes population must equal 290 (got ${registered.size})`);
});

function assertCompleteClassification(registered: Set<string>): void {
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
}

Deno.test("census: classification categories are exhaustive and mutually disjoint", () => {
  assertCompleteClassification(extractAllRegisteredRoutes());
});

Deno.test("census: a newly composed route group cannot be skipped or silently classified", () => {
  const source = Deno.readTextFileSync(`${ROOT}extension/background/service-worker.js`);
  const anchor = "const handlers = mergeRouteMaps(";
  assertEquals(source.split(anchor).length, 2, "falsification must find the real handlers composition exactly once");
  const original = extractAllRegisteredRoutes(source);
  // A newly declared map is resolvable from the ACTUAL service-worker AST. Its
  // route changes the population and the same exhaustive check must fail by name.
  const named = source.replace(anchor,
    `const zb58AddedRoutes = { "zb58.synthetic.route": () => ({ ok: true }) };\n${anchor}\n  zb58AddedRoutes,`);
  const added = extractAllRegisteredRoutes(named);
  assertEquals(added.size, original.size + 1, "the new group must change the registered population");
  assert(added.has("zb58.synthetic.route"), "the new group must retain its route name");
  assertThrows(() => assertCompleteClassification(added), Error, "zb58.synthetic.route");
  // An unknown identifier must name its group rather than being silently
  // ignored (the exact failure that undercounted vault/enclave routes).
  const unresolved = source.replace(anchor, `${anchor}\n  zb58UnresolvedRoutes,`);
  assertThrows(() => extractAllRegisteredRoutes(unresolved), Error, "zb58UnresolvedRoutes");
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

// ── chrome-agent-platform-4h47: the doc and this table are ONE authority ─────
//
// Until this bead, tests/sw-dispatch-authority-census.test.ts held its own copy
// of the classification and NEVER parsed the markdown, so the doc rotted while
// every gate stayed green: it said 260 total where this file pinned 276, and six
// section headers disagreed with their OWN tables (4.2 36/40, 4.4 16/17, 4.5
// 23/24, 4.6 21/23, 4.9 31/37, 4.10 88/91). The assertion below parses the doc
// and requires, per section, that the route-name SET equals this file's
// CENSUS_CATEGORIES set AND that the section header's stated count matches its
// own table. A number that rots, or a route that moves between sections in only
// one of the two authorities, now REDs here naming the section.
//
// ── chrome-agent-platform-s7wl: the same parser was blind to three maps ──────
//
// 4h47 pinned the doc to this file's sets, and BOTH still undercounted: the
// resolver above recognized only a hardcoded identifier list and skipped every
// other mergeRouteMaps argument without a word, which is exactly `vaultRoutes`,
// `enclaveProxyRoutes` and `enclaveStatusRoutes` — 9 routes that landed
// 2026-10-03 (bd17634f), three days BEFORE the landing that set 276. Evaluating
// the real composition (`mergeRouteMaps` over the same argument list, factories
// called with the same stubs) at `origin/main@f507d58f` returned 288 at that historical pin. The counts
// that follow are 290 population, 51 SETTINGS_ONLY_DIRECT, 25
// OWNER_EXTENSION_FENCED, 37 UNCLASSIFIED_MUTATIONS (none of the 9 is an
// unclassified mutation: all are gated).
//
// The document's shape, stated so the parse is not a guess:
//   • §4.1–4.9 are markdown tables whose FIRST cell is the route name (4.9's
//     first row is bolded, hence the optional `**`).
//   • §4.10 is NOT a table — it is one prose line listing the routes. It is
//     still parsed exactly, not skipped: the only backticked tokens in that
//     section are the route names, and the set-equality assertion is itself the
//     guard — a stray code token in the prose would fail the parse loudly rather
//     than silently shrink the set.
//   • §3 is the high-level summary table; its rows are asserted against the
//     same sets, and its Total against the registered-route population.
const CENSUS_DOC_SECTIONS: Readonly<Record<string, keyof typeof CENSUS_CATEGORIES>> = {
  "4.1": "PAGE_ALLOWED",
  "4.2": "SETTINGS_ONLY_DIRECT",
  "4.3": "OWNER_APPROVAL_DIRECT",
  "4.4": "OWNER_APPROVAL_REQUIRED",
  "4.5": "OWNER_EXTENSION_FENCED",
  "4.6": "EXECUTION_AND_WORKER_ORCHESTRATION",
  "4.7": "AGENT_BOARD",
  "4.8": "STORAGE_KV_MEMORY_FENCED",
  "4.9": "UNCLASSIFIED_MUTATIONS",
  "4.10": "READ_ONLY_STATUS_TELEMETRY",
};

const CENSUS_DOC_SUMMARY_ROWS: ReadonlyArray<readonly [string, keyof typeof CENSUS_CATEGORIES]> = [
  ["Page-Allowed (`PAGE_ALLOWED`)", "PAGE_ALLOWED"],
  ["Settings-Only Direct (`SETTINGS_ONLY_DIRECT`)", "SETTINGS_ONLY_DIRECT"],
  ["Owner-Approval Direct (`OWNER_APPROVAL_DIRECT`)", "OWNER_APPROVAL_DIRECT"],
  ["Owner-Approval Required (`OWNER_APPROVAL_REQUIRED`)", "OWNER_APPROVAL_REQUIRED"],
  ["Owner Extension-Fenced (`OWNER_EXTENSION_FENCED`)", "OWNER_EXTENSION_FENCED"],
  ["Execution & Worker Orchestration", "EXECUTION_AND_WORKER_ORCHESTRATION"],
  ["Agent Task Board (`AGENT_BOARD`)", "AGENT_BOARD"],
  ["Storage, KV & Memory Fenced", "STORAGE_KV_MEMORY_FENCED"],
  ["Unclassified Mutations (Gaps)", "UNCLASSIFIED_MUTATIONS"],
  ["Read-Only / Status / Telemetry", "READ_ONLY_STATUS_TELEMETRY"],
];

/** The route names a §4.N section lists, plus the count its own header states. */
function parseCensusDocSection(section: string, header: string, body: string): { names: Set<string>; stated: number } {
  const tableNames = [...body.matchAll(/^\|\s*\*{0,2}`([^`]+)`/gm)].map((match) => match[1]);
  // §4.10 is a prose list, not a table; its backticked tokens ARE its routes.
  const names = new Set(tableNames.length ? tableNames : [...body.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
  const stated = /\((?:[^()]*?)(\d+) routes\)/.exec(header);
  assert(stated !== null, `census ${section} header must state its route count: ${header}`);
  return { names, stated: Number(stated[1]) };
}

Deno.test("census: the document's §4 tables and §3 summary ARE this test's classification (no drift possible)", async () => {
  const census = await Deno.readTextFile(`${ROOT}docs/SW-DISPATCH-AUTHORITY-CENSUS.md`);
  const lines = census.split("\n");

  // Every section this file knows about, in document order.
  const sections: Array<{ section: string; header: string; start: number }> = [];
  lines.forEach((line, index) => {
    const match = /^### (4\.\d+)/.exec(line);
    if (match) sections.push({ section: match[1], header: line, start: index });
  });
  assertEquals(
    sections.map((s) => s.section),
    Object.keys(CENSUS_DOC_SECTIONS),
    "the document must still have exactly the §4.N sections this test maps",
  );

  let docTotal = 0;
  for (const [index, { section, header, start }] of sections.entries()) {
    const end = sections[index + 1]?.start ?? lines.findIndex((line, at) => at > start && line.startsWith("## "));
    const body = lines.slice(start + 1, end).join("\n");
    const category = CENSUS_DOC_SECTIONS[section];
    const expected = CENSUS_CATEGORIES[category];
    const { names, stated } = parseCensusDocSection(section, header, body);
    const where = `census ${section} (${category})`;

    assertEquals(
      [...names].sort(),
      [...expected].sort(),
      `${where}: the document's route set must equal this test's category set — ` +
        `doc-only ${[...names].filter((name) => !expected.has(name)).join(", ") || "(none)"}; ` +
        `test-only ${[...expected].filter((name) => !names.has(name)).join(", ") || "(none)"}`,
    );
    assertEquals(names.size, stated, `${where}: the header states ${stated} routes but the table lists ${names.size}`);
    docTotal += names.size;
  }

  // §3's summary table, keyed by its own row labels — a row that disappears (or
  // a count that rots) fails here as well as above.
  const summary = new Map<string, number>();
  for (const line of lines) {
    const row = /^\| \*\*(.+?)\*\* \| \*{0,2}(\d+)\*{0,2} \|/.exec(line);
    if (row) summary.set(row[1], Number(row[2]));
  }
  for (const [label, category] of CENSUS_DOC_SUMMARY_ROWS) {
    assertEquals(
      summary.get(label),
      CENSUS_CATEGORIES[category].size,
      `census §3: the "${label}" summary row must equal the ${category} set (which is what §4 lists)`,
    );
  }
  assertEquals(
    summary.get("Total"),
    docTotal,
    "census §3: the Total row must equal the sum of the §4 section tables",
  );
  assertEquals(
    summary.get("Total"),
    extractAllRegisteredRoutes().size,
    "census §3: the Total row must equal the registered-route population this test derives from handlers",
  );
});

// gn3c: declarations above do not themselves prove that an individual handler
// reaches its declared approval seam. Parse the registered handler nodes, not
// arbitrary text elsewhere in the worker (or comments that mention a call).
function walkApprovalAst(node: any, visit: (node: any) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkApprovalAst(child, visit);
    return;
  }
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "start" && key !== "end" && key !== "loc") walkApprovalAst(child, visit);
  }
}

function approvalCalls(node: any, name: string): any[] {
  const calls: any[] = [];
  walkApprovalAst(node, (part) => {
    if (part.type === "CallExpression" && part.callee?.type === "Identifier" && part.callee.name === name) {
      calls.push(part);
    }
  });
  return calls;
}

function approvalFunction(ast: any, name: string): any {
  for (const statement of ast.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name === name) return declaration;
  }
  return null;
}

const APPROVAL_MODULES = {
  schedulerRoutes: "extension/background/routes/scheduler.js",
  fsGrantRoutes: "extension/background/routes/fs-grants.js",
  agentScheduleRoutes: "extension/background/routes/agent-schedule.js",
};

// These are action-name aliases or indirect paths, NOT blanket exemptions from
// enforcement. Every entry must still prove the named helper/factory calls the
// approval seam. A route added to the classification without a handler fails.
const APPROVAL_ACTION_ALIASES: Record<string, { action: string; reason: string }> = {
  "asset.patch": { action: "asset.update", reason: "a patch pays the asset.update card" },
  "asset.append": { action: "asset.update", reason: "an append pays the asset.update card" },
  "fs-grant.write-file-approved": { action: "fs.write", reason: "model file writes use the fs.write card" },
  "browser.destructive-action": { action: "<DESTRUCTIVE_BROWSER_ACTIONS>", reason: "validated browser action chooses one of the declared destructive actions" },
  "attached-webmcp.invoke": { action: "webmcp.use-tool", reason: "run-local attached tool uses the existing per-tool owner card with an exact run/document digest" },
};

function approvalHandlerNodes(swAst: any): Map<string, { node: any; module?: string }> {
  const target = new Set([
    ...CENSUS_CATEGORIES.OWNER_APPROVAL_DIRECT,
    ...CENSUS_CATEGORIES.OWNER_APPROVAL_REQUIRED,
  ]);
  const handlers = new Map<string, { node: any; module?: string }>();
  let mergeCall: any = null;
  for (const statement of swAst.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (declaration.id?.name === "handlers" && declaration.init?.callee?.name === "mergeRouteMaps") {
        mergeCall = declaration.init;
      }
    }
  }
  assert(mergeCall, "approval census: handlers must be registered via mergeRouteMaps");
  for (const arg of mergeCall.arguments) {
    if (arg.type === "ObjectExpression") {
      for (const property of arg.properties) {
        const name = property.key?.value ?? property.key?.name;
        if (target.has(name)) {
          assert(!handlers.has(name), `approval census: route "${name}" is registered more than once`);
          handlers.set(name, { node: property.value });
        }
      }
    } else if (arg.type === "Identifier" && Object.hasOwn(APPROVAL_MODULES, arg.name)) {
      const module = APPROVAL_MODULES[arg.name as keyof typeof APPROVAL_MODULES];
      const moduleAst = acorn.parse(Deno.readTextFileSync(`${ROOT}${module}`), { ecmaVersion: "latest", sourceType: "module" });
      walkApprovalAst(moduleAst, (part) => {
        if (part.type !== "Property" || !target.has(part.key?.value ?? part.key?.name)) return;
        const name = part.key?.value ?? part.key?.name;
        assert(!handlers.has(name), `approval census: route "${name}" is registered more than once`);
        handlers.set(name, { node: part.value, module: arg.name });
      });
    }
  }
  return handlers;
}

function approvalFindings(swSource: string): string[] {
  const swAst = acorn.parse(swSource, { ecmaVersion: "latest", sourceType: "module" });
  const handlers = approvalHandlerNodes(swAst);
  const expected = new Set([
    ...CENSUS_CATEGORIES.OWNER_APPROVAL_DIRECT,
    ...CENSUS_CATEGORIES.OWNER_APPROVAL_REQUIRED,
  ]);
  const findings: string[] = [];
  if (expected.size !== 31) findings.push(`approval census population drift: expected 31, found ${expected.size}`);

  const approvalBridge = approvalFunction(swAst, "requireOwnerApproval");
  const entersOwnerDirectPath = approvalCalls(approvalBridge?.body, "isOwnerDirectApproval")
    .some((call) => call.arguments[0]?.name === "context" && call.arguments[1]?.name === "action");
  const scriptBridge = approvalFunction(swAst, "scriptApprovalGate");
  const forwardsScriptAction = scriptBridge?.params?.[1]?.name === "action" &&
    approvalCalls(scriptBridge.body, "requireOwnerApproval")
      .some((call) => call.arguments[0]?.name === "context" && call.arguments[1]?.name === "action");
  const siteToolBridge = approvalFunction(swAst, "requestSiteToolFirstUse");
  // The unenrolled route delegates to a factory: inspect its injected callback
  // rather than blessing the route name alone. It must retain BOTH the model
  // approval card and the separate required WAL/page-effect executor.
  const attachedFactory = swAst.body.flatMap((statement: any) =>
    statement.type === "VariableDeclaration" ? statement.declarations : [])
    .find((part: any) => part.id?.name === "attachedDeclaredInvoker" &&
      part.init?.callee?.name === "createAttachedDeclaredInvoker");
  const attachedDeps = attachedFactory?.init?.arguments?.[0]?.properties ?? [];
  const attachedDep = (name: string) => attachedDeps.find((part: any) => part.key?.name === name)?.value;
  const attachedApproval = attachedDep("requestApproval")?.body;
  const attachedAudit = attachedDep("audit")?.body;
  const attachedInvoke = attachedDep("invoke")?.body;
  const agentScheduleAst = acorn.parse(
    Deno.readTextFileSync(`${ROOT}extension/background/routes/agent-schedule.js`),
    { ecmaVersion: "latest", sourceType: "module" },
  );
  const deleteBridge = approvalFunction(agentScheduleAst, "createNamedAgentDeleteGate");

  for (const route of [...expected].sort()) {
    const category = CENSUS_CATEGORIES.OWNER_APPROVAL_DIRECT.has(route)
      ? "OWNER_APPROVAL_DIRECT" : "OWNER_APPROVAL_REQUIRED";
    const entry = handlers.get(route);
    if (!entry) {
      findings.push(`route "${route}" (${category}) has no registered handler AST — if extracted, add its binding to APPROVAL_MODULES`);
      continue;
    }
    if (entry.module) {
      const declaration = swAst.body.flatMap((statement: any) => statement.type === "VariableDeclaration" ? statement.declarations : [])
        .find((part: any) => part.id?.name === entry.module);
      const injected = declaration?.init?.arguments?.some((arg: any) => arg.type === "ObjectExpression" &&
        arg.properties.some((prop: any) => prop.key?.name === "requireOwnerApproval" && prop.value?.name === "requireOwnerApproval"));
      if (!injected) findings.push(`route "${route}" (${category}) has no requireOwnerApproval dependency injection`);
    }
    const calls = [
      ...approvalCalls(entry.node, "requireOwnerApproval"),
      ...approvalCalls(entry.node, "scriptApprovalGate"),
    ];
    const actions = new Set<string>();
    for (const call of calls) {
      const action = call.arguments[1];
      if (typeof action?.value === "string") actions.add(action.value);
      else if (route === "browser.destructive-action" && action?.name === "act") {
        let guarded = false;
        walkApprovalAst(entry.node, (part) => {
          const test = part.type === "IfStatement" && part.start < call.start &&
            part.test?.type === "UnaryExpression" && part.test.operator === "!" && part.test.argument;
          if (test?.callee?.object?.name === "DESTRUCTIVE_BROWSER_ACTIONS" &&
            test.callee?.property?.name === "has" && test.arguments[0]?.name === "act" &&
            part.consequent?.body?.some((statement: any) => statement.type === "ReturnStatement")) guarded = true;
        });
        if (guarded) actions.add("<DESTRUCTIVE_BROWSER_ACTIONS>");
      }
      if (call.callee.name === "scriptApprovalGate" && !forwardsScriptAction) {
        findings.push(`route "${route}" (${category}) calls scriptApprovalGate without a requireOwnerApproval action-forwarding bridge`);
      }
    }
    if (route === "webmcp.use-tool" && approvalCalls(entry.node, "requestSiteToolFirstUse").length) {
      if (approvalCalls(siteToolBridge?.body, "requireOwnerApproval").some((call) => call.arguments[1]?.value === route)) {
        actions.add(route);
      }
    }
    if (route === "attached-webmcp.invoke" && approvalCalls(entry.node, "attachedDeclaredInvoker").length) {
      const card = approvalCalls(attachedApproval, "requireOwnerApproval")
        .some((call) => call.arguments[1]?.value === "webmcp.use-tool");
      let wal = false;
      walkApprovalAst(attachedAudit, (part) => {
        if (part.type === "CallExpression" && part.callee?.object?.name === "ephemeralSiteToolAuditPrincipal" &&
          part.callee?.property?.name === "append") wal = true;
      });
      const effect = approvalCalls(attachedInvoke, "auditedAttachedDeclaredCall").length > 0;
      if (card && wal && effect) actions.add("webmcp.use-tool");
      else findings.push(`route "${route}" lost a model approval, required WAL, or audited exact-document invoke seam`);
    }
    if (route === "named-agent.delete" && approvalCalls(entry.node, "createNamedAgentDeleteGate").length) {
      const hookCall = approvalCalls(entry.node, "createNamedAgentDeleteGate")[0];
      const wired = hookCall.arguments[1]?.properties?.some((prop: any) =>
        prop.key?.name === "requireOwnerApproval" && prop.value?.name === "requireOwnerApproval");
      const installed = approvalCalls(entry.node, "deleteNamedAgent").some((call) =>
        call.arguments[1]?.properties?.some((prop: any) =>
          prop.key?.name === "gateBeforeDelete" && prop.value === hookCall));
      if (wired && installed && approvalCalls(deleteBridge?.body, "requireOwnerApproval").some((call) => call.arguments[1]?.value === route)) {
        actions.add(route);
      }
    }
    const alias = APPROVAL_ACTION_ALIASES[route];
    if (alias && !alias.reason) findings.push(`route "${route}" (${category}) has an undocumented action alias`);
    const wanted = alias?.action ?? route;
    if (actions.size !== 1 || !actions.has(wanted)) {
      findings.push(`route "${route}" (${category}) reaches [${[...actions].sort().join(", ") || "no approval seam"}] instead of declared owner-approval action "${wanted}"`);
    }
    if (category === "OWNER_APPROVAL_DIRECT") {
      if (!OWNER_DIRECT_ACTIONS.has(wanted) || !entersOwnerDirectPath) {
        findings.push(`route "${route}" (${category}) action "${wanted}" cannot enter the owner-principal direct path`);
      }
    } else if (route === "browser.destructive-action") {
      const declaration = swAst.body.flatMap((statement: any) => statement.type === "VariableDeclaration" ? statement.declarations : [])
        .find((part: any) => part.id?.name === "DESTRUCTIVE_BROWSER_ACTIONS");
      const members = declaration?.init?.arguments?.[0]?.elements?.map((member: any) => member.value);
      if (!members?.length || members.some((action: string) => !DESTRUCTIVE_ACTIONS.has(action))) {
        findings.push(`route "${route}" (${category}) browser action set is absent or contains an unapprovable action`);
      }
    } else if (!DESTRUCTIVE_ACTIONS.has(wanted)) {
      findings.push(`route "${route}" (${category}) action "${wanted}" cannot create a pending approval`);
    }
  }
  return findings;
}

Deno.test("census: each direct/required route handler reaches its declared approval seam by route name", () => {
  const sw = Deno.readTextFileSync(`${ROOT}extension/background/service-worker.js`);
  assertEquals(approvalFindings(sw), []);
});

Deno.test("census: deleting a route seam or its injected authority turns RED naming the route", () => {
  const sw = Deno.readTextFileSync(`${ROOT}extension/background/service-worker.js`);
  const ast = acorn.parse(sw, { ecmaVersion: "latest", sourceType: "module" });
  const handler = approvalHandlerNodes(ast).get("capability.revoke")?.node;
  const call = approvalCalls(handler, "requireOwnerApproval");
  assertEquals(call.length, 1, "falsification must find the live capability.revoke seam by AST");
  const remove = (node: any) => sw.slice(0, node.start) + "null" + sw.slice(node.end);
  const routeFindings = approvalFindings(remove(call[0]));
  assert(routeFindings.some((finding) => finding.includes('route "capability.revoke"') && finding.includes("no approval seam")),
    `removing capability.revoke's seam must fail by name, got ${routeFindings.join("; ")}`);

  const scheduler = ast.body.flatMap((statement: any) => statement.type === "VariableDeclaration" ? statement.declarations : [])
    .find((part: any) => part.id?.name === "schedulerRoutes");
  const injected = scheduler?.init?.arguments?.flatMap((arg: any) => arg.type === "ObjectExpression" ? arg.properties : [])
    .filter((part: any) => part.key?.name === "requireOwnerApproval");
  assertEquals(injected?.length, 1, "falsification must find scheduler's live approval injection by AST");
  const injectionFindings = approvalFindings(sw.slice(0, injected[0].start) + "missingApproval: null" + sw.slice(injected[0].end));
  assert(injectionFindings.some((finding) => finding.includes('route "task.pause"') && finding.includes("dependency injection")),
    `removing task.pause's approval injection must fail by name, got ${injectionFindings.join("; ")}`);

  const script = approvalCalls(approvalFunction(ast, "scriptApprovalGate")?.body, "requireOwnerApproval");
  assertEquals(script.length, 1, "falsification must find the script helper's live forwarding seam by AST");
  const scriptFindings = approvalFindings(remove(script[0]));
  assert(scriptFindings.some((finding) => finding.includes('route "script.run"') && finding.includes("action-forwarding bridge")),
    `removing script.run's forwarding seam must fail by name, got ${scriptFindings.join("; ")}`);
});
