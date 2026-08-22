// lib/chrome-tool-capabilities.js — canonical bounded metadata for the exact
// shipped browser + management tool inventory.
//
// The table contains DATA ONLY. It is not a grant, permission request,
// dispatcher, validator, provider binding, or execution allowlist.

export const CHROME_TOOL_CAPABILITY_BOUNDS = Object.freeze({
  browserTools: 9,
  managementTools: 29,
  totalTools: 38,
  maxCapabilityTokens: 4,
  maxCapabilityTokenBytes: 96,
  maxPermissions: 8,
  maxPermissionBytes: 32,
  maxRouteFamilyBytes: 64,
});

export const BROWSER_TOOL_NAMES = Object.freeze([
  "open_side_panel",
  "open_tab",
  "navigate_tab",
  "read_page",
  "capture_screenshot",
  "list_tabs",
  "close_tab",
  "recent_browser_events",
  "schedule_task",
]);

export const MANAGEMENT_CAPABILITY_TOOL_NAMES = Object.freeze([
  "create_agent",
  "update_agent",
  "delete_agent",
  "get_agent",
  "list_agents",
  "disenroll_origin",
  "create_asset",
  "update_asset",
  "delete_asset",
  "list_assets",
  "get_asset",
  "get_usage",
  "get_memory_overview",
  "create_named_agent",
  "update_named_agent",
  "delete_named_agent",
  "get_named_agent",
  "list_named_agents",
  "set_agent_provider",
  "list_hooks",
  "subscribe_hook",
  "unsubscribe_hook",
  "generate_ui",
  "create_script",
  "update_script",
  "delete_script",
  "list_scripts",
  "get_script",
  "run_script",
]);

export const FLAGGED_FOR_LATER_PROVIDER_CUTOVER = Object.freeze([
  "open_side_panel",
  "capture_screenshot",
  "schedule_task",
  "run_script",
  "set_agent_provider",
  "delete_agent",
  "delete_asset",
  "disenroll_origin",
  "delete_named_agent",
  "update_asset",
]);

const REPLAY = new Set(["read-only", "idempotent", "mutating", "unknown"]);
const MUTATION = new Set(["read", "idempotent", "mutating"]);
const GRANT_SCOPES = new Set([
  "none",
  "destination-origin",
  "tab-scoped",
  "global",
  "owner-gesture-activeTab",
]);
const TOKEN = /^(?:chrome|management)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const GENERIC_TOKEN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const PERMISSION = /^[A-Za-z][A-Za-z0-9.]*$/u;
const ROUTE = /^(?:browser|management)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const bytes = (value) => new TextEncoder().encode(value).byteLength;

function record(toolName, sourceKind, capabilityTokens, optionalPermissions,
  productGrantScopeKind, replayClass, requiresOwnerGesture, mutationClass,
  routeFamily) {
  return {
    toolName,
    sourceKind,
    capabilityTokens,
    optionalPermissions,
    productGrantScopeKind,
    replayClass,
    trustedReplaySafety: replayClass,
    requiresOwnerGesture,
    mutationClass,
    routeFamily,
  };
}

const rows = [
  record("open_side_panel", "chrome-api", ["chrome.side-panel.open"], ["sidePanel"], "owner-gesture-activeTab", "mutating", true, "mutating", "browser.side-panel"),
  record("open_tab", "chrome-api", ["chrome.tabs.open.destination-origin"], ["tabs"], "destination-origin", "mutating", false, "mutating", "browser.tabs"),
  record("navigate_tab", "chrome-api", ["chrome.tabs.navigate.destination-origin"], ["tabs"], "destination-origin", "mutating", false, "mutating", "browser.tabs"),
  record("read_page", "chrome-api", ["chrome.host.exact-origin", "chrome.page.read"], ["activeTab", "scripting", "tabs"], "none", "read-only", false, "read", "browser.page"),
  record("capture_screenshot", "chrome-api", ["chrome.host.exact-origin", "chrome.screenshot.capture.tab-origin", "chrome.screenshot.capture.owner-gesture-alternative"], ["activeTab", "tabs"], "tab-scoped", "read-only", false, "read", "browser.capture"),
  record("list_tabs", "chrome-api", ["chrome.tabs.list"], ["tabs"], "none", "read-only", false, "read", "browser.tabs"),
  record("close_tab", "chrome-api", ["chrome.tabs.close.tab-origin"], ["tabs"], "tab-scoped", "mutating", false, "mutating", "browser.tabs"),
  record("recent_browser_events", "chrome-api", ["chrome.events.recent.read"], [], "none", "read-only", false, "read", "browser.events"),
  record("schedule_task", "chrome-api", ["chrome.alarms.schedule", "chrome.scripts.schedule"], ["alarms"], "none", "mutating", false, "mutating", "browser.scheduler"),

  record("create_agent", "management", ["management.agent.create"], [], "none", "mutating", false, "mutating", "management.agents"),
  record("update_agent", "management", ["management.agent.update"], [], "none", "mutating", false, "mutating", "management.agents"),
  record("delete_agent", "management", ["management.agent.delete"], [], "none", "mutating", false, "mutating", "management.agents"),
  record("get_agent", "management", ["management.agent.get"], [], "none", "read-only", false, "read", "management.agents"),
  record("list_agents", "management", ["management.agent.list"], [], "none", "read-only", false, "read", "management.agents"),
  record("disenroll_origin", "management", ["management.origin.disenroll"], [], "none", "mutating", false, "mutating", "management.agents"),
  record("create_asset", "management", ["management.asset.create"], [], "none", "mutating", false, "mutating", "management.assets"),
  record("update_asset", "management", ["management.asset.update"], [], "none", "mutating", false, "mutating", "management.assets"),
  record("delete_asset", "management", ["management.asset.delete"], [], "none", "mutating", false, "mutating", "management.assets"),
  record("list_assets", "management", ["management.asset.list"], [], "none", "read-only", false, "read", "management.assets"),
  record("get_asset", "management", ["management.asset.get"], [], "none", "read-only", false, "read", "management.assets"),
  record("get_usage", "management", ["management.usage.get"], [], "none", "read-only", false, "read", "management.usage"),
  record("get_memory_overview", "management", ["management.memory.overview.get"], [], "none", "read-only", false, "read", "management.memory"),
  record("create_named_agent", "management", ["management.named-agent.create"], [], "none", "mutating", false, "mutating", "management.named-agents"),
  record("update_named_agent", "management", ["management.named-agent.update"], [], "none", "mutating", false, "mutating", "management.named-agents"),
  record("delete_named_agent", "management", ["management.named-agent.delete"], [], "none", "mutating", false, "mutating", "management.named-agents"),
  record("get_named_agent", "management", ["management.named-agent.get"], [], "none", "read-only", false, "read", "management.named-agents"),
  record("list_named_agents", "management", ["management.named-agent.list"], [], "none", "read-only", false, "read", "management.named-agents"),
  record("set_agent_provider", "management", ["management.provider.set"], [], "none", "mutating", false, "mutating", "management.named-agents"),
  record("list_hooks", "management", ["management.hooks.list"], [], "none", "read-only", false, "read", "management.hooks"),
  record("subscribe_hook", "management", ["management.hooks.subscribe"], [], "none", "idempotent", false, "idempotent", "management.hooks"),
  record("unsubscribe_hook", "management", ["management.hooks.unsubscribe"], [], "none", "idempotent", false, "idempotent", "management.hooks"),
  record("generate_ui", "management", ["management.ui.generate"], [], "none", "mutating", false, "mutating", "management.ui"),
  record("create_script", "management", ["management.script.create"], [], "none", "mutating", false, "mutating", "management.scripts"),
  record("update_script", "management", ["management.script.update"], [], "none", "mutating", false, "mutating", "management.scripts"),
  record("delete_script", "management", ["management.script.delete"], [], "none", "mutating", false, "mutating", "management.scripts"),
  record("list_scripts", "management", ["management.script.list"], [], "none", "read-only", false, "read", "management.scripts"),
  record("get_script", "management", ["management.script.get"], [], "none", "read-only", false, "read", "management.scripts"),
  record("run_script", "management", ["management.script.run"], [], "none", "mutating", false, "mutating", "management.scripts"),
];

function validateRow(row, seen) {
  if (!row || typeof row !== "object" || seen.has(`${row.sourceKind}:${row.toolName}`)) throw new Error("duplicate_capability_entry");
  seen.add(`${row.sourceKind}:${row.toolName}`);
  if (!["chrome-api", "management"].includes(row.sourceKind)) throw new Error("invalid_capability_source");
  const expectedNames = row.sourceKind === "chrome-api" ? BROWSER_TOOL_NAMES : MANAGEMENT_CAPABILITY_TOOL_NAMES;
  if (!expectedNames.includes(row.toolName)) throw new Error("unknown_capability_entry");
  if (!Array.isArray(row.capabilityTokens) || row.capabilityTokens.length < 1 || row.capabilityTokens.length > CHROME_TOOL_CAPABILITY_BOUNDS.maxCapabilityTokens) throw new Error("invalid_capability_tokens");
  if (new Set(row.capabilityTokens).size !== row.capabilityTokens.length || row.capabilityTokens.some((token) => typeof token !== "string" || !TOKEN.test(token) || bytes(token) > CHROME_TOOL_CAPABILITY_BOUNDS.maxCapabilityTokenBytes)) throw new Error("invalid_capability_tokens");
  if (!Array.isArray(row.optionalPermissions) || row.optionalPermissions.length > CHROME_TOOL_CAPABILITY_BOUNDS.maxPermissions || new Set(row.optionalPermissions).size !== row.optionalPermissions.length || row.optionalPermissions.some((permission) => typeof permission !== "string" || !PERMISSION.test(permission) || bytes(permission) > CHROME_TOOL_CAPABILITY_BOUNDS.maxPermissionBytes)) throw new Error("invalid_capability_permissions");
  if (!GRANT_SCOPES.has(row.productGrantScopeKind)) throw new Error("invalid_grant_scope");
  if (!REPLAY.has(row.replayClass) || row.trustedReplaySafety !== row.replayClass) throw new Error("invalid_replay_class");
  if (typeof row.requiresOwnerGesture !== "boolean" || !MUTATION.has(row.mutationClass)) throw new Error("invalid_mutation_metadata");
  if (typeof row.routeFamily !== "string" || !ROUTE.test(row.routeFamily) || bytes(row.routeFamily) > CHROME_TOOL_CAPABILITY_BOUNDS.maxRouteFamilyBytes) throw new Error("invalid_route_family");
}

if (rows.length !== CHROME_TOOL_CAPABILITY_BOUNDS.totalTools) throw new Error("capability_table_count_mismatch");
const seen = new Set();
for (const row of rows) validateRow(row, seen);
for (const name of BROWSER_TOOL_NAMES) if (!seen.has(`chrome-api:${name}`)) throw new Error("capability_table_browser_incomplete");
for (const name of MANAGEMENT_CAPABILITY_TOOL_NAMES) if (!seen.has(`management:${name}`)) throw new Error("capability_table_management_incomplete");

export const CHROME_TOOL_CAPABILITY_TABLE = Object.freeze(rows.map((row) => Object.freeze({
  ...row,
  capabilityTokens: Object.freeze([...row.capabilityTokens].sort()),
  optionalPermissions: Object.freeze([...row.optionalPermissions].sort()),
})));

const byIdentity = new Map(CHROME_TOOL_CAPABILITY_TABLE.map((row) => [`${row.sourceKind}:${row.toolName}`, row]));

export function chromeToolCapability(toolName, sourceKind) {
  const row = typeof toolName === "string" && typeof sourceKind === "string"
    ? byIdentity.get(`${sourceKind}:${toolName}`)
    : null;
  if (!row) {
    const error = new Error("unknown_capability_entry");
    error.code = "unknown_capability_entry";
    throw error;
  }
  return row;
}

export function capabilitiesByTool(toolMap, sourceKind) {
  if (!["chrome-api", "management"].includes(sourceKind)) throw new Error("unknown_capability_source");
  const names = Object.keys(toolMap ?? {}).sort();
  const expected = [...(sourceKind === "chrome-api" ? BROWSER_TOOL_NAMES : MANAGEMENT_CAPABILITY_TOOL_NAMES)].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    const error = new Error("capability_table_inventory_mismatch");
    error.code = "capability_table_inventory_mismatch";
    throw error;
  }
  return Object.freeze(Object.fromEntries(names.map((name) => [name, chromeToolCapability(name, sourceKind).capabilityTokens])));
}

export function selectedCapabilitySummary(name, sourceKind, fallbackCapabilities = [], fallbackReplay = "unknown") {
  if (sourceKind === "chrome-api" || sourceKind === "management") {
    const row = chromeToolCapability(name, sourceKind);
    return Object.freeze({
      capabilityTokens: row.capabilityTokens,
      optionalPermissions: row.optionalPermissions,
      productGrantScopeKind: row.productGrantScopeKind,
      replayClass: row.replayClass,
      requiresOwnerGesture: row.requiresOwnerGesture,
      mutationClass: row.mutationClass,
      routeFamily: row.routeFamily,
    });
  }
  const tokens = Array.isArray(fallbackCapabilities)
    ? fallbackCapabilities.filter((token) =>
      typeof token === "string" && GENERIC_TOKEN.test(token) &&
      bytes(token) <= CHROME_TOOL_CAPABILITY_BOUNDS.maxCapabilityTokenBytes
    ).slice(0, CHROME_TOOL_CAPABILITY_BOUNDS.maxCapabilityTokens)
    : [];
  return Object.freeze({
    capabilityTokens: Object.freeze(tokens),
    optionalPermissions: Object.freeze([]),
    productGrantScopeKind: "none",
    replayClass: REPLAY.has(fallbackReplay) ? fallbackReplay : "unknown",
    requiresOwnerGesture: false,
    mutationClass: fallbackReplay === "read-only" ? "read" : fallbackReplay === "idempotent" ? "idempotent" : "mutating",
    routeFamily: sourceKind === "extension-builtin" ? "catalog.builtin" : "catalog.webmcp",
  });
}
