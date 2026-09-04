// @ts-nocheck — exact shipped tool maps and metadata-only adapters.
import { assert, assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";
import { browserToolset } from "../extension/lib/browser-tools.js";
import {
  MANAGEMENT_TOOL_NAMES,
  managementToolset,
} from "../extension/lib/management-tools.js";
import {
  BROWSER_TOOL_NAMES,
  capabilitiesByTool,
  CHROME_TOOL_CAPABILITY_BOUNDS,
  DEVELOPER_ONLY_TOOL_NAMES,
  CHROME_TOOL_CAPABILITY_TABLE,
  chromeToolCapability,
  FLAGGED_FOR_LATER_PROVIDER_CUTOVER,
  MANAGEMENT_CAPABILITY_TOOL_NAMES,
  selectedCapabilitySummary,
} from "../extension/lib/chrome-tool-capabilities.js";
import {
  adaptBrowserTools,
  adaptManagementTools,
  buildToolCatalog,
} from "../extension/lib/tool-catalog.js";
import { sha256Hex } from "../extension/lib/pure.js";
import { replaySafetyForTool } from "../extension/lib/tool-replay-safety.js";
import {
  executableBrowserToolRecords,
  executableManagementToolRecords,
} from "../extension/lib/lazy-tool-protocol.js";
import { ShadowToolCatalogController } from "../extension/lib/tool-catalog-shadow.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";

const enc = new TextEncoder();
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function context() {
  return {
    version: "0.2.153",
    sourceGeneration: "extension:0.2.153",
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
  };
}
function refFactory() {
  let value = 0;
  return () => `sel_${(++value).toString(16).padStart(36, "0")}`;
}

Deno.test("chrome capability table is exact and complete for 138 browser + 44 management tools", () => {
  // The capability table describes the SHIPPED inventory, which is the
  // developer build: the developer-only tools keep their rows because the
  // build genuinely contains them (CAP-FB-20260830-COOKIE-TOOLS-CUT-01).
  const browser = browserToolset(false, { developerFeatures: true });
  const management = managementToolset({ callRoute: () => { throw new Error("must not dispatch"); } });
  assertEquals(Object.keys(browser), BROWSER_TOOL_NAMES);
  // The DEFAULT build offers exactly the inventory minus the developer-only
  // names — never more, and never a name the table does not know.
  assertEquals(
    Object.keys(browserToolset(false)),
    BROWSER_TOOL_NAMES.filter((name) => !DEVELOPER_ONLY_TOOL_NAMES.includes(name)),
  );
  assertEquals(DEVELOPER_ONLY_TOOL_NAMES, ["get_cookie", "set_cookie", "remove_cookie"]);
  assertEquals(MANAGEMENT_TOOL_NAMES, MANAGEMENT_CAPABILITY_TOOL_NAMES);
  assertEquals(Object.keys(management).sort(), [...MANAGEMENT_CAPABILITY_TOOL_NAMES].sort());
  assertEquals(CHROME_TOOL_CAPABILITY_TABLE.length, 182);
  assertEquals(CHROME_TOOL_CAPABILITY_TABLE.filter((row) => row.sourceKind === "chrome-api").length, 138);
  assertEquals(CHROME_TOOL_CAPABILITY_TABLE.filter((row) => row.sourceKind === "management").length, 42);
  assertEquals(CHROME_TOOL_CAPABILITY_BOUNDS, {
    browserTools: 138,
    managementTools: 44,
    totalTools: 182,
    maxCapabilityTokens: 4,
    maxCapabilityTokenBytes: 96,
    maxPermissions: 8,
    maxPermissionBytes: 32,
    maxRouteFamilyBytes: 64,
  });
  const unknown = assertThrows(() => chromeToolCapability("not_a_tool", "chrome-api"));
  assertEquals(unknown.code, "unknown_capability_entry");
  const mismatch = assertThrows(() => capabilitiesByTool({ ...browser, injected: {} }, "chrome-api"));
  assertEquals(mismatch.code, "capability_table_inventory_mismatch");
});

Deno.test("chrome capability metadata is bounded, canonical data only, and namespaced", () => {
  const identities = new Set();
  for (const row of CHROME_TOOL_CAPABILITY_TABLE) {
    assertEquals(Object.isFrozen(row), true);
    assertEquals(Object.isFrozen(row.capabilityTokens), true);
    assertEquals(Object.isFrozen(row.optionalPermissions), true);
    assert(!Object.values(row).some((value) => typeof value === "function"));
    assert(!identities.has(`${row.sourceKind}:${row.toolName}`));
    identities.add(`${row.sourceKind}:${row.toolName}`);
    assert(row.capabilityTokens.length >= 1 && row.capabilityTokens.length <= CHROME_TOOL_CAPABILITY_BOUNDS.maxCapabilityTokens);
    for (const token of row.capabilityTokens) {
      assertMatch(token, /^(?:chrome|management)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/u);
      assert(enc.encode(token).byteLength <= CHROME_TOOL_CAPABILITY_BOUNDS.maxCapabilityTokenBytes);
    }
    assert(row.optionalPermissions.length <= CHROME_TOOL_CAPABILITY_BOUNDS.maxPermissions);
    assert(["none", "destination-origin", "tab-scoped", "global", "owner-gesture-activeTab"].includes(row.productGrantScopeKind));
    assert(["read-only", "idempotent", "mutating", "unknown"].includes(row.replayClass));
    assertEquals(row.trustedReplaySafety, row.replayClass);
    assert(["read", "idempotent", "mutating"].includes(row.mutationClass));
    assertMatch(row.routeFamily, /^(?:browser|management)\./u);
  }
  const serialized = JSON.stringify(CHROME_TOOL_CAPABILITY_TABLE);
  for (const forbidden of ["execute", "dispatch", "validator", "callRoute", "selectionRef"]) assert(!serialized.includes(`\"${forbidden}\"`));
});

Deno.test("policy: every browser tool has a policyClass and every read-only tool is 'read'", () => {
  // CAP-FB-20260830-DESTRUCTIVE-ACTION-POLICY-01: the three visible classes.
  // Read (page text, tab list) never prompts; Act (tabs/groups/bookmarks/page
  // actions) asks once per origin then automatic; Destructive (delete, wipe,
  // downloads to disk) always asks. Every browser tool carries the column.
  const DESTRUCTIVE_BROWSER_TOOLS = new Set([
    "close_tab", "close_window", "wipe_browsing_data",
    "remove_bookmark", "set_cookie", "remove_cookie",
  ]);
  const browserRows = CHROME_TOOL_CAPABILITY_TABLE.filter((row) => row.sourceKind === "chrome-api");
  assert(browserRows.length > 0, "there must be browser tools to classify");
  for (const row of browserRows) {
    assert(["read", "act", "destructive"].includes(row.policyClass), `${row.toolName} has no valid policyClass (got ${row.policyClass})`);
    // A read-only tool can never be Act or Destructive — a read never prompts.
    if (row.replayClass === "read-only") assertEquals(row.policyClass, "read", `${row.toolName} is read-only but not policyClass read`);
    // The destructive set is exactly the always-ask browser actions.
    if (DESTRUCTIVE_BROWSER_TOOLS.has(row.toolName)) assertEquals(row.policyClass, "destructive", `${row.toolName} must be policyClass destructive`);
    // A Destructive tool is never read-only (it mutates).
    if (row.policyClass === "destructive") assert(row.replayClass !== "read-only", `${row.toolName} is destructive but read-only`);
  }
  // The frozen serialized table carries the column (data only, no functions).
  const serialized = JSON.stringify(CHROME_TOOL_CAPABILITY_TABLE);
  assert(serialized.includes("\"policyClass\""), "policyClass must be a serialized column");
});

Deno.test("canonical replay metadata cannot drift from the existing trusted replay authority", () => {
  for (const row of CHROME_TOOL_CAPABILITY_TABLE) {
    assertEquals(row.replayClass, replaySafetyForTool(row.toolName), row.toolName);
    assertEquals(row.trustedReplaySafety, replaySafetyForTool(row.toolName), row.toolName);
    if (row.replayClass === "read-only") assertEquals(row.mutationClass, "read");
    if (row.replayClass === "idempotent") assertEquals(row.mutationClass, "idempotent");
    if (row.replayClass === "mutating") assertEquals(row.mutationClass, "mutating");
  }
});

Deno.test("management capabilities are tool-specific and never collapse to management.route", () => {
  const management = CHROME_TOOL_CAPABILITY_TABLE.filter((row) => row.sourceKind === "management");
  const primary = management.map((row) => row.capabilityTokens[0]);
  assertEquals(new Set(primary).size, MANAGEMENT_CAPABILITY_TOOL_NAMES.length);
  assert(!primary.includes("management.route"));
  assertEquals(chromeToolCapability("get_asset", "management").capabilityTokens, ["management.asset.get"]);
  assertEquals(chromeToolCapability("delete_asset", "management").capabilityTokens, ["management.asset.delete"]);
  assertEquals(chromeToolCapability("run_script", "management").capabilityTokens, ["management.script.run"]);
});

Deno.test("capabilitiesByTool still fails closed: an unknown tool, or a MISSING non-developer tool, is a drift error", () => {
  // The inventory check was relaxed to permit ONE kind of omission — the
  // developer-only tools the default build does not offer
  // (CAP-FB-20260830-COOKIE-TOOLS-CUT-01). Everything it caught before, it
  // must still catch; this is the guard for that relaxation.
  const full = browserToolset(false, { developerFeatures: true });
  const def = browserToolset(false);
  // The default build (developer-only names omitted) is accepted...
  assertEquals(
    Object.keys(capabilitiesByTool(def, "chrome-api")).length,
    BROWSER_TOOL_NAMES.length - DEVELOPER_ONLY_TOOL_NAMES.length,
  );
  // ...but a tool the table has never heard of is still a hard error.
  const withStranger = { ...full, not_a_real_tool: full.list_tabs };
  assertEquals(assertThrows(() => capabilitiesByTool(withStranger, "chrome-api")).code, "capability_table_inventory_mismatch");
  // ...and so is a MISSING tool that is not developer-only.
  const withoutOrdinary = { ...full };
  delete withoutOrdinary.list_tabs;
  assertEquals(assertThrows(() => capabilitiesByTool(withoutOrdinary, "chrome-api")).code, "capability_table_inventory_mismatch");
  // Management tools have no developer-only class at all: any omission fails.
  const management = managementToolset({ callRoute: () => { throw new Error("must not dispatch"); } });
  const shortManagement = { ...management };
  delete shortManagement[Object.keys(management)[0]];
  assertEquals(assertThrows(() => capabilitiesByTool(shortManagement, "management")).code, "capability_table_inventory_mismatch");
});

Deno.test("catalog descriptors consume exact canonical capabilities and capability digests", () => {
  const browser = browserToolset(false, { developerFeatures: true });
  const management = managementToolset({ callRoute: () => { throw new Error("must not dispatch"); } });
  const inputs = [
    ...adaptBrowserTools(browser, { ...context(), capabilitiesByTool: capabilitiesByTool(browser, "chrome-api") }),
    ...adaptManagementTools(management, { ...context(), capabilitiesByTool: capabilitiesByTool(management, "management") }),
  ];
  const catalog = buildToolCatalog(inputs);
  assertEquals(catalog.descriptors.length, 182);
  for (const descriptor of catalog.descriptors) {
    const row = chromeToolCapability(descriptor.name, descriptor.sourceKind);
    assertEquals(descriptor.capabilities, row.capabilityTokens);
    assertEquals(descriptor.capabilityDigest, sha256Hex(canonicalJson(row.capabilityTokens)));
    assertEquals(descriptor.trustedReplaySafety, row.trustedReplaySafety);
  }
});

Deno.test("unbound lazy browser/management records preserve source closure and validator custody without invocation", async () => {
  let routeCalls = 0;
  const browser = browserToolset(false, { developerFeatures: true });
  const management = managementToolset({ callRoute: () => { routeCalls++; throw new Error("must not dispatch"); } });
  const eager = new Map();
  for (const [name, aiTool] of Object.entries({ ...browser, ...management })) {
    eager.set(name, { execute: aiTool.execute, safeParse: aiTool.inputSchema.safeParse, schema: aiTool.inputSchema });
  }
  const browserRecords = executableBrowserToolRecords(browser, { ...context(), capabilitiesByTool: capabilitiesByTool(browser, "chrome-api") });
  const managementRecords = executableManagementToolRecords(management, { ...context(), capabilitiesByTool: capabilitiesByTool(management, "management") });
  assertEquals(browserRecords.length, 138);
  assertEquals(managementRecords.length, 42);
  for (const record of [...browserRecords, ...managementRecords]) {
    const name = record.descriptorInput.toolId;
    const sourceMap = record.descriptorInput.sourceKind === "chrome-api" ? browser : management;
    // The unbound record resolves back to the exact eager source object; the
    // adapter never clones/replaces either authority closure or Zod validator.
    assert(Object.is(sourceMap[name].execute, eager.get(name).execute));
    assert(Object.is(sourceMap[name].inputSchema, eager.get(name).schema));
    assert(Object.is(sourceMap[name].inputSchema.safeParse, eager.get(name).safeParse));
    const expected = await eager.get(name).schema.safeParse({});
    const actual = await record.validateArguments({});
    assertEquals(actual.ok, expected.success);
  }
  assertEquals(routeCalls, 0);
});

Deno.test("shadow capture discloses bounded selected capability summaries and only a non-selected count", async () => {
  let routeCalls = 0;
  const browser = browserToolset(false, { developerFeatures: true });
  const management = managementToolset({ callRoute: () => { routeCalls++; throw new Error("must not dispatch"); } });
  const inputs = [
    ...adaptBrowserTools(browser, { ...context(), capabilitiesByTool: capabilitiesByTool(browser, "chrome-api") }),
    ...adaptManagementTools(management, { ...context(), capabilitiesByTool: capabilitiesByTool(management, "management") }),
  ];
  const controller = new ShadowToolCatalogController({
    readInputs: () => inputs,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const capture = await controller.inspect({
    action: "capture",
    query: "tabs",
    limit: 2,
    runId: "run-1",
    agentId: "hub",
    origin: "",
    documentId: "",
  });
  assertEquals(capture.mode, "shadow-lazy-provider-capture");
  assertEquals(capture.providerBound, false);
  assertEquals(capture.eagerBindingChanged, false);
  assertEquals(capture.canExecute, false);
  assertEquals(capture.canGrant, false);
  assertEquals(capture.selectedCount, capture.selectedDescriptors.length);
  assertEquals(capture.nonSelectedCount, 182 - capture.selectedCount);
  assertEquals(capture.omittedNonSelected, true);
  assert(capture.selectedCount > 0 && capture.selectedCount <= 2);
  for (const selected of capture.selectedDescriptors) {
    assertMatch(selected.capabilityDigest, /^[0-9a-f]{64}$/u);
    assertEquals(selected.trustedReplaySafety, replaySafetyForTool(selected.name));
    const row = chromeToolCapability(selected.name, selected.sourceKind);
    assertEquals(selected.capabilitySummary.capabilityTokens, row.capabilityTokens);
    assertEquals(selected.capabilitySummary.optionalPermissions, row.optionalPermissions);
    assertEquals(selected.capabilitySummary.productGrantScopeKind, row.productGrantScopeKind);
    assertEquals(selected.capabilitySummary.routeFamily, row.routeFamily);
    assertEquals(selected.authorizes, false);
    assertEquals(selected.requiresLiveAuthorization, true);
    assertEquals("execute" in selected, false);
    assertEquals("grant" in selected, false);
  }
  const topKeys = Object.keys(capture).sort();
  assertEquals(topKeys, ["canExecute", "canGrant", "eagerBindingChanged", "mode", "nonSelectedCount", "ok", "omittedNonSelected", "protocolTools", "providerBound", "selectedCount", "selectedDescriptors"].sort());
  assertEquals(routeCalls, 0);
});

Deno.test("selected capability summary is bounded for non-Chrome catalog sources", () => {
  const summary = selectedCapabilitySummary(
    "page_tool",
    "webmcp-declared",
    Array.from({ length: 20 }, (_, index) => `webmcp.capability.${index}`),
    "unknown",
  );
  assertEquals(summary.capabilityTokens.length, CHROME_TOOL_CAPABILITY_BOUNDS.maxCapabilityTokens);
  assertEquals(summary.optionalPermissions, []);
  assertEquals(summary.productGrantScopeKind, "none");
  assertEquals(summary.replayClass, "unknown");
});

Deno.test("unsafe-for-cutover list remains policy metadata and does not filter the 182-record catalog", () => {
  for (const name of ["run_script", "schedule_task", "set_agent_provider", "capture_screenshot"]) {
    assert(FLAGGED_FOR_LATER_PROVIDER_CUTOVER.includes(name));
  }
  // open_side_panel was removed 2026-08-30 (CAP-FB-20260830-SIDE-PANEL-TOOL-CUT-01),
  // so it is gone from the cutover list as well as the catalog.
  assert(!FLAGGED_FOR_LATER_PROVIDER_CUTOVER.includes("open_side_panel"));
  assertEquals(CHROME_TOOL_CAPABILITY_TABLE.length, 182);
  assertEquals(new Set(CHROME_TOOL_CAPABILITY_TABLE.map((row) => row.toolName)).size, 182);
});

Deno.test("Tranche 2 tools: permission-gated execution fails closed when permission is missing", async () => {
  const browser = browserToolset(false);

  // Without chrome.permissions granted:
  const alarmRes = await browser.create_alarm.execute({ name: "test_alarm", delayInMinutes: 5 });
  assertEquals(alarmRes.error, "alarms permission not granted — allow it in the approval card here, or in Settings → Permissions");

  const listAlarmsRes = await browser.list_alarms.execute({});
  assertEquals(listAlarmsRes.error, "alarms permission not granted — allow it in the approval card here, or in Settings → Permissions");

  const bmRes = await browser.create_bookmark.execute({ title: "Test" });
  assertEquals(bmRes.error, "bookmarks permission not granted — allow it in the approval card here, or in Settings → Permissions");

  const notifyRes = await browser.notify.execute({ title: "Test", message: "Hello" });
  assertEquals(notifyRes.error, "notifications permission not granted — allow it in the approval card here, or in Settings → Permissions");

  const idleRes = await browser.query_idle_state.execute({ detectionIntervalInSeconds: 60 });
  assertEquals(idleRes.error, "idle permission not granted — allow it in the approval card here, or in Settings → Permissions");

  const menuRes = await browser.create_context_menu.execute({ id: "menu1", title: "Menu" });
  assertEquals(menuRes.error, "contextMenus permission not granted — allow it in the approval card here, or in Settings → Permissions");
});
Deno.test("shadow metadata wiring contains no permission request, grant, runtime-send, provider or execute path", async () => {
  const files = [
    "extension/lib/chrome-tool-capabilities.js",
    "extension/lib/lazy-tool-wire.js",
    "extension/lib/tool-catalog-shadow.js",
  ];
  const source = (await Promise.all(files.map((file) => Deno.readTextFile(file)))).join("\n");
  for (const forbidden of ["permissions.request", "runtime.sendMessage", "setGlobalBrowserControlGrant", "setOriginBrowserControlGrant", "execute(args", ".execute(", "setProvider", "bindModel"] ) assert(!source.includes(forbidden), forbidden);
  const worker = await Deno.readTextFile("extension/background/service-worker.js");
  assert(worker.includes('context?.principal !== "owner-options"'));
  assert(!worker.includes("search_tools"));
  assert(!worker.includes("execute_tool"));
});

// ──────────────────────────────────────────────────────────────────────────
// Tool-library <details> slice: the shadow summary's bounded per-tool list
// ──────────────────────────────────────────────────────────────────────────
Deno.test("shadow summary: toolsBySource is a bounded read-only per-tool list (name/source label/version-availability/description; no secrets or authority)", async () => {
  const { adaptBundledTools, adaptBuiltinTools } = await import("../extension/lib/tool-catalog.js");
  const { BUNDLED_TOOL_PACKAGE_ROWS } = await import("../extension/lib/bundled-tool-packages.data.js");
  const inputs = [
    ...adaptBuiltinTools({ "memory.read": { kind: "builtin", source: "extension", version: "1", name: "memory.read", description: "Read the hub memory" } }, { version: "0.2.185" }),
    ...adaptBundledTools([
      { toolId: "csvtool", packageId: "cap.bundled.csvtool", version: "1.0.0", description: "Bounded RFC 4180 CSV stream filter", displayName: "csvtool", admitted: true, settingsPreview: true },
      { toolId: "disabled-candidate", packageId: "cap.bundled.disabled-candidate", version: "1.0.0", description: "a fictional disabled candidate", displayName: "disabled-candidate", admitted: false, settingsPreview: false },
    ]),
  ];
  const controller = new ShadowToolCatalogController({
    readInputs: () => inputs,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const summary = await controller.inspect({ action: "summary" });
  assertEquals(summary.ok, true);
  assertEquals(summary.canExecute, false, "no execution authority");
  assertEquals(summary.canGrant, false, "no grant authority");
  assert(summary.toolsBySource, "the summary carries the bounded per-tool list");
  // the bundled rows are enriched (displayName/description/version) + the
  // availability reflects the admitted preview posture.
  const bundled = summary.toolsBySource["bundled-package"] ?? [];
  assert(bundled.length >= 2, "the bundled rows appear");
  const csv = bundled.find((row) => row.toolId === "csvtool");
  assert(csv, "csvtool row present");
  assertEquals(csv.name, BUNDLED_TOOL_PACKAGE_ROWS.find((r) => r.toolId === "csvtool")?.displayName ?? "csvtool", "the real displayName is carried");
  assertEquals(csv.sourceLabel, "Bundled packages");
  assertEquals(csv.version, BUNDLED_TOOL_PACKAGE_ROWS.find((r) => r.toolId === "csvtool")?.version ?? "1.0.0");
  assertEquals(csv.available, true, "the admitted preview tool is available");
  assert(csv.description.length > 0, "the one-line description is present");
  const disabledCandidate = bundled.find((row) => row.toolId === "disabled-candidate");
  assertEquals(disabledCandidate.available, false, "the disabled candidate is unavailable");
  // every row is bounded + has only the summary fields (no secrets/history/
  // digests/capabilities/grant surface)
  for (const rows of Object.values(summary.toolsBySource)) {
    assert(rows.length <= 64, "bounded rows per source");
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        assert(["toolId", "name", "sourceLabel", "version", "available", "description"].includes(key), `only summary fields: ${key}`);
      }
      assertEquals(typeof row.name, "string");
      assertEquals(typeof row.description, "string");
      assert(row.description.length <= 240, "bounded description");
    }
  }
  // the per-source label is carried on every row (the bundled label verified
  // above); the row set is exactly the catalog's sources.
  assertEquals(Object.keys(summary.toolsBySource).sort(), Object.keys(summary.bySource).sort(), "one row set per bySource category");
});

Deno.test("shadow summary: an empty catalog yields an empty toolsBySource (empty state, no throw)", async () => {
  const controller = new ShadowToolCatalogController({
    readInputs: () => [],
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const summary = await controller.inspect({ action: "summary" });
  assertEquals(summary.ok, true);
  assertEquals(summary.descriptorCount, 0);
  assertEquals(Object.keys(summary.toolsBySource).length, 0);
});

// ──────────────────────────────────────────────────────────────────────────
// Details-slice product fix: the production shadow catalog projects the
// bundled tools, so the Settings <details> bundled category lists all 28.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("shadow summary: the full BUNDLED row set projects into the catalog (28 rows in toolsBySource[bundled-package])", async () => {
  const { BUNDLED_TOOL_PACKAGE_ROWS } = await import("../extension/lib/bundled-tool-packages.data.js");
  const { adaptBundledTools } = await import("../extension/lib/tool-catalog.js");
  const inputs = adaptBundledTools(BUNDLED_TOOL_PACKAGE_ROWS, {
    version: "0.2.187",
    sourceGeneration: "bundled-inventory:test",
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
  });
  const controller = new ShadowToolCatalogController({
    readInputs: () => inputs,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const summary = await controller.inspect({ action: "summary" });
  const bundled = summary.toolsBySource["bundled-package"] ?? [];
  assertEquals(bundled.length, 28, "all 28 bundled rows are listed");
  assertEquals(summary.bySource["bundled-package"], 28, "the bySource count matches");
  // every row carries the summary-only fields + the admitted-preview availability
  const admitted = BUNDLED_TOOL_PACKAGE_ROWS.filter((r) => r.admitted === true && r.settingsPreview === true).length;
  assertEquals(bundled.filter((r) => r.available === true).length, admitted, "the available count equals the admitted previews");
  for (const row of bundled) {
    assertEquals(typeof row.name, "string");
    assertEquals(typeof row.sourceLabel, "string");
    assertEquals(row.sourceLabel, "Bundled packages");
    assert(["string", "object"].includes(typeof row.version) ? typeof row.version === "string" || row.version === null : true);
    assertEquals(typeof row.description, "string");
    assert(row.description.length <= 240);
  }
});

Deno.test("details slice: the production readShadowCatalogInputs projects the bundled tools (source assertion)", async () => {
  const worker = await Deno.readTextFile("extension/background/service-worker.js");
  const block = worker.slice(
    worker.indexOf("async function readShadowCatalogInputs"),
    worker.indexOf("async function readShadowCatalogInputs") + 2500,
  );
  assert(block.includes("adaptBundledTools(BUNDLED_TOOL_PACKAGE_ROWS"), "the production shadow inputs include the bundled projection");
  assert(block.includes("bundled-inventory:${BUNDLED_INVENTORY.release}"), "the bundled source generation is bound to the inventory release");
});
