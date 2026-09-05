// tests/tool-purpose-groups.test.ts — the tool library's purpose taxonomy
// (CAP-FB-20260828-TOOL-LIBRARY-GROUPING-01).
//
// The taxonomy is a product judgement (docs/TOOL-PURPOSE-GROUPS.md): two
// families ("running the browser" / "doing the work") subdivided into
// task-shaped groups. These tests pin the INVARIANTS, not the judgement:
//   - every catalogued tool resolves to exactly one known group (the taxonomy
//     can never silently drop a tool as the registry grows);
//   - no static group is empty (a group with no tools is dead copy);
//   - group copy stays plain language a person would recognise;
//   - the shadow summary stamps each row's purpose so the component groups
//     without a second source of truth.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  TOOL_PURPOSE_FAMILIES,
  TOOL_PURPOSE_GROUPS,
  STATIC_TOOL_INVENTORY,
  purposeGroupMeta,
  toolPurposeGroup,
} from "../extension/lib/tool-purpose-groups.js";

Deno.test("purpose taxonomy: exactly the two product families, in order", () => {
  assertEquals(
    TOOL_PURPOSE_FAMILIES.map((f) => f.id),
    ["running-the-browser", "doing-the-work"],
  );
  for (const family of TOOL_PURPOSE_FAMILIES) {
    assert(typeof family.label === "string" && family.label.length > 0);
    assert(typeof family.line === "string" && family.line.length > 0);
  }
});

Deno.test("purpose taxonomy: every group names a declared family and carries a plain one-line purpose", () => {
  const familyIds = new Set(TOOL_PURPOSE_FAMILIES.map((f) => f.id));
  for (const [gid, meta] of Object.entries(TOOL_PURPOSE_GROUPS)) {
    assert(familyIds.has(meta.family), `${gid} names a declared family`);
    assert(typeof meta.label === "string" && meta.label.length > 0, `${gid} has a label`);
    assert(typeof meta.line === "string" && meta.line.length > 0, `${gid} has a one-line purpose`);
    // Plain language: no engineering axis leaks into the group copy.
    for (const text of [meta.label, meta.line]) {
      assert(!/chrome\.\w+|routeFamily|sourceKind|api\b/i.test(text), `${gid} copy carries no API jargon: ${text}`);
    }
  }
});

Deno.test("purpose taxonomy: EVERY static tool resolves to exactly one known group", () => {
  assert(STATIC_TOOL_INVENTORY.length >= 200, "the inventory covers the registry + bundled + built-in tools");
  for (const toolId of STATIC_TOOL_INVENTORY) {
    const gid = toolPurposeGroup(toolId);
    assert(gid !== null, `${toolId} resolves to a purpose group`);
    assert(purposeGroupMeta(gid), `${toolId} resolves to a KNOWN group (${gid})`);
  }
});

Deno.test("purpose taxonomy: no static group is empty", () => {
  const counts = new Map();
  for (const toolId of STATIC_TOOL_INVENTORY) {
    const gid = toolPurposeGroup(toolId);
    counts.set(gid, (counts.get(gid) ?? 0) + 1);
  }
  for (const gid of Object.keys(TOOL_PURPOSE_GROUPS)) {
    if (gid === "site-declared" || gid === "site-inferred") continue; // dynamic by nature
    assert((counts.get(gid) ?? 0) > 0, `group ${gid} has at least one tool`);
  }
});

Deno.test("purpose taxonomy: the split families land where the product judgement puts them", () => {
  // browser.page splits into reading vs. driving.
  assertEquals(toolPurposeGroup("read_page", "chrome-api"), "reading-capture");
  assertEquals(toolPurposeGroup("click_element", "chrome-api"), "driving-pages");
  // Tab zoom is appearance, not tab management.
  assertEquals(toolPurposeGroup("set_tab_zoom", "chrome-api"), "appearance-system");
  assertEquals(toolPurposeGroup("close_tab", "chrome-api"), "tabs-windows");
  // schedule_task is the agent scheduling its own work — family 2.
  assertEquals(toolPurposeGroup("schedule_task", "chrome-api"), "automation");
  // Site tools keep the declared/inferred honesty split.
  assertEquals(toolPurposeGroup("anything", "webmcp-declared"), "site-declared");
  assertEquals(toolPurposeGroup("anything", "webmcp-inferred"), "site-inferred");
  // An unknown tool with an unknown source resolves to null (never guessed).
  assertEquals(toolPurposeGroup("no_such_tool", "chrome-api"), null);
});

Deno.test("purpose taxonomy: the static inventory's built-in segment matches the LIVE builtin toolset", async () => {
  // The taxonomy module deliberately does NOT import agent.js (the UI bundle
  // stays light); this test is the sync gate instead. A truthy stub enumerates
  // the memory tools' keys without a store.
  const { memoryToolset, delegationToolMetadata } = await import("../extension/lib/agent.js");
  const liveBuiltin = Object.keys({
    ...memoryToolset({} /* stub: key enumeration only, never executed */),
    ...delegationToolMetadata(),
  }).sort();
  const staticBuiltin = ["memory_get", "memory_set", "memory_list", "memory_grep", "list_agents", "delegate_task"].sort();
  assertEquals(staticBuiltin, liveBuiltin, "the taxonomy's built-in list IS the live builtin toolset");
  for (const toolId of liveBuiltin) {
    assert(STATIC_TOOL_INVENTORY.includes(toolId), `${toolId} is in the static inventory`);
    assert(toolPurposeGroup(toolId, "extension-builtin") !== null, `${toolId} is classified`);
  }
});

Deno.test("purpose taxonomy: the shadow summary stamps every row's purpose group", async () => {
  const { ShadowToolCatalogController } = await import("../extension/lib/tool-catalog-shadow.js");
  const { adaptBrowserTools, adaptManagementTools } = await import("../extension/lib/tool-catalog.js");
  const { browserToolset } = await import("../extension/lib/browser-tools.js");
  const { managementToolset } = await import("../extension/lib/management-tools.js");
  const { capabilitiesByTool } = await import("../extension/lib/chrome-tool-capabilities.js");
  const browserTools = browserToolset(false, { developerFeatures: true });
  const managementTools = managementToolset({ callRoute: () => Promise.reject(new Error("shadow")) });
  const hubScope = { hub: true, agentId: "hub", origin: "", documentId: "" };
  const controller = new ShadowToolCatalogController({
    readInputs: () => [
      ...adaptBrowserTools(browserTools, {
        version: "0.0.0-test",
        sourceGeneration: "test",
        scope: hubScope,
        capabilitiesByTool: capabilitiesByTool(browserTools, "chrome-api"),
      }),
      ...adaptManagementTools(managementTools, {
        version: "0.0.0-test",
        sourceGeneration: "test",
        scope: hubScope,
        capabilitiesByTool: capabilitiesByTool(managementTools, "management"),
      }),
    ],
  });
  const summary = /** @type {any} */ (await controller.inspect({ action: "summary" }));
  let stamped = 0;
  const rowSets = [];
  for (const kind of Object.keys(summary.toolsBySource ?? {})) rowSets.push(summary.toolsBySource[kind]);
  for (const rows of rowSets) {
    for (const row of rows) {
      assert(typeof row.purpose === "string" && purposeGroupMeta(row.purpose),
        `${row.toolId} carries a known purpose group`);
      stamped++;
    }
  }
  assert(stamped > 150, `the registry rows are all stamped (${stamped})`);
  // The count honesty from 0.2.312 is preserved: the stamped rows ARE the
  // bySource rows, so count and rows agree by construction.
  const rowTotal = rowSets.reduce((n, rows) => n + rows.length, 0);
  const countTotal = Object.keys(summary.bySource ?? {}).map((k) => Number(summary.bySource[k])).reduce((n, c) => n + c, 0);
  assertEquals(rowTotal, countTotal, "the rows and the by-source counts agree");
});
