// tests/agent-wasm-discovery.test.ts — Verification of agent WebAssembly tool discovery,
// list_tools enumeration capability, bounded result capping, and truthful catalog reporting
// (CAP-FB-20260823-AGENT-WASM-DISCOVERY-01).
// @ts-nocheck

import { createLazyProviderToolset } from "../extension/lib/lazy-tool-protocol.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import { executableBundledToolRecords } from "../extension/lib/lazy-tool-protocol.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { BUNDLED_INVENTORY } from "../extension/lib/bundled-inventory-data.js";
import { MASTER_SKILL } from "../extension/lib/master-skill.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("list_tools: enumerates all categories including the 28 admitted bundled Wasm tools", async () => {
  const bundledRecords = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
    sourceGeneration: `bundled-inventory:${BUNDLED_INVENTORY.release}`,
  });

  const toolset = createLazyProviderToolset({
    readSources: async () => bundledRecords,
    contextReader: async () => ({
      runId: "run-test-1",
      taskId: "task-test-1",
      agentId: "hub",
      origin: "",
      documentId: "",
      runGeneration: "1",
    }),
    selectionAuthority: new ToolSelectionAuthority(),
  });

  assert(toolset.tools.list_tools, "list_tools must be exposed in lazy toolset");

  // Call list_tools
  const result = await toolset.tools.list_tools.execute({});
  assertEquals(result.ok, true);
  assertEquals(result.counts.bundledWasm, 28, "must report exactly 28 bundled Wasm tools");
  assertEquals(result.tools["bundled-wasm"].length, 31, "must list all 31 bundled Wasm tools");

  const names = result.tools["bundled-wasm"].map((t) => t.name);
  const expectedSubset = ["awk_filter_bounded", "date_formatter_bounded", "diff", "patch", "truncate", "csvtool", "gzip", "md5sum", "sha256sum", "sqlite3_query_bounded"];
  for (const exp of expectedSubset) {
    assert(names.includes(exp), `bundled Wasm list must include '${exp}'`);
  }
});

Deno.test("list_tools: category filter returns only the requested category", async () => {
  const bundledRecords = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
    sourceGeneration: `bundled-inventory:${BUNDLED_INVENTORY.release}`,
  });

  const toolset = createLazyProviderToolset({
    readSources: async () => bundledRecords,
    contextReader: async () => ({
      runId: "run-test-2",
      taskId: "task-test-2",
      agentId: "hub",
      origin: "",
      documentId: "",
      runGeneration: "1",
    }),
    selectionAuthority: new ToolSelectionAuthority(),
  });

  const filtered = await toolset.tools.list_tools.execute({ source: "bundled-wasm" });
  assertEquals(filtered.ok, true);
  assertEquals(filtered.tools["bundled-wasm"].length, 31);
  assertEquals(filtered.tools.builtin.length, 0, "filtered category should not populate other categories");
});

Deno.test("list_tools: result stays strictly bounded under 32 KiB and includes truncated flag", async () => {
  const bundledRecords = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
    sourceGeneration: `bundled-inventory:${BUNDLED_INVENTORY.release}`,
  });

  const toolset = createLazyProviderToolset({
    readSources: async () => bundledRecords,
    contextReader: async () => ({
      runId: "run-test-3",
      taskId: "task-test-3",
      agentId: "hub",
      origin: "",
      documentId: "",
      runGeneration: "1",
    }),
    selectionAuthority: new ToolSelectionAuthority(),
  });

  const result = await toolset.tools.list_tools.execute({});
  assertEquals(result.ok, true);
  assertEquals(typeof result.truncated, "boolean");

  const jsonBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  assert(jsonBytes <= 32 * 1024, `list_tools result exceeds 32 KiB cap (${jsonBytes} bytes)`);
});

Deno.test("master-skill: operating manual truthfully includes list_tools and the 28 bundled Wasm tools", () => {
  assert(MASTER_SKILL.includes("list_tools"), "MASTER_SKILL must describe list_tools");
  assert(MASTER_SKILL.includes("search_tools"), "MASTER_SKILL must describe search_tools");
  assert(MASTER_SKILL.includes("execute_tool"), "MASTER_SKILL must describe execute_tool");
  assert(MASTER_SKILL.includes("28 on-device bundled Wasm tools"), "MASTER_SKILL must mention 28 bundled Wasm tools");
  assert(!MASTER_SKILL.includes("there are no native WebAssembly tools"), "must NOT claim no Wasm tools");
});

Deno.test("master-skill: the manual's bundled-Wasm count is PINNED to the shipped inventory", async () => {
  // The prompt's count literal must equal the REAL bundled inventory — when a
  // bundled tool is added or removed, this test forces the prompt to follow.
  const { BUNDLED_INVENTORY } = await import("../extension/lib/bundled-inventory-data.js");
  const live = (Array.isArray(BUNDLED_INVENTORY.manifests)
    ? BUNDLED_INVENTORY.manifests
    : Object.values(BUNDLED_INVENTORY.manifests)).length;
  assert(
    MASTER_SKILL.includes(`${live} on-device bundled Wasm tools`),
    `MASTER_SKILL must state the live bundled count (${live}) — update the manual when the inventory changes`,
  );
});

Deno.test("master-skill: every cited tool name resolves to a real registry entry", async () => {
  // Accuracy pin: the manual must never describe a tool that does not exist.
  const { browserToolset } = await import("../extension/lib/browser-tools.js");
  const browser = new Set(Object.keys(browserToolset(false)));
  const bundled = new Set(
    (await import("../extension/lib/bundled-inventory-data.js"))
      .BUNDLED_INVENTORY.manifests.flatMap((x) => {
        const raw = x.pkg.replace("cap.bundled.", "");
        return [raw, raw.replace(/\./g, "_")];
      }),
  );
  // The management set derives from the REAL toolset (the hardcoded list
  // drifted — it lacked the named-agent tools that genuinely exist), unioned
  // with the lazy-protocol + builtin agent tools (search_tools/execute_tool/
  // list_tools/delegate_task/memory_*) that live outside the management map.
  const { managementToolset } = await import("../extension/lib/management-tools.js");
  const management = new Set([
    ...Object.keys(managementToolset({ callRoute: () => Promise.resolve({ ok: true }) })),
    "schedule_task", "delegate_task", "memory_get", "memory_set",
    "memory_list", "memory_grep", "get_usage", "get_memory_overview", "search_tools",
    "list_tools", "execute_tool", "read_page", "capture_screenshot",
  ]);
  const cited = [...MASTER_SKILL.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)]
    .map((m) => m[1]);
  const missing = [...new Set(cited)].filter(
    (n) => !browser.has(n) && !bundled.has(n) && !management.has(n),
  );
  assert(
    missing.length === 0,
    `manual cites non-existent tools: ${missing.join(", ")}`,
  );
});
