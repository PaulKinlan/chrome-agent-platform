// tests/lazy-tool-registry-live-parity.test.ts
// Bead: chrome-agent-platform-l1ah
// Parity test ensuring live browser, management (with write_clipboard), and on-device tools
// can be passed to executable records and createLazyProviderToolset without
// throwing capability_table_inventory_mismatch or failing with lazy-source-unavailable.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { tool } from "ai";
import { z } from "zod";
import { browserToolset } from "../extension/lib/browser-tools.js";
import { managementToolset } from "../extension/lib/management-tools.js";
import { onDeviceTextToolset } from "../extension/lib/on-device-text-tools.js";
import {
  capabilitiesByTool,
  chromeToolCapability,
} from "../extension/lib/chrome-tool-capabilities.js";
import {
  executableBrowserToolRecords,
  executableManagementToolRecords,
  executableBuiltinToolRecords,
  createLazyProviderToolset,
} from "../extension/lib/lazy-tool-protocol.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";

const HUB_SCOPE = { hub: true, agentId: "hub", origin: "", documentId: "" };

function refFactory() {
  let value = 0;
  return () => `sel_${(++value).toString(16).padStart(36, "0")}`;
}

function runContext(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-test-parity",
    taskId: "task-test-parity",
    runGeneration: "generation-1",
    agentId: "hub",
    origin: "",
    documentId: "hub-doc",
    ...overrides,
  };
}

Deno.test("live toolset parity: browser + management (with write_clipboard) + on-device tools search and list cleanly", async () => {
  const browserTools = browserToolset(false, { developerFeatures: false });
  const managementTools = managementToolset({ callRoute: async () => ({ ok: true }) }) as Record<string, any>;
  // If write_clipboard is not yet part of managementToolset, attach it like service-worker.js:2725 did
  if (!managementTools.write_clipboard) {
    managementTools.write_clipboard = tool({
      description: "Copy text to the system clipboard.",
      inputSchema: z.object({ text: z.string() }),
      execute: async () => ({ ok: true }),
    });
  }
  const onDeviceTools = onDeviceTextToolset({ dispatchRoute: async () => ({ ok: true }) });

  const version = "1.0.0";
  const sourceGeneration = `extension:${version}:test`;
  const context = {
    version,
    sourceGeneration,
    closureGeneration: `${sourceGeneration}:test`,
    packageDigest: "digest-test",
    permissionDigest: "perm-test",
    grantDigest: "grant-test",
    scope: HUB_SCOPE,
  };

  const readSources = () => {
    return [
      ...executableBrowserToolRecords(browserTools, {
        ...context,
        capabilitiesByTool: Object.fromEntries(
          Object.keys(browserTools).map((name) => [
            name,
            chromeToolCapability(name, "chrome-api").capabilityTokens,
          ]),
        ),
      }),
      ...executableManagementToolRecords(managementTools, {
        ...context,
        capabilitiesByTool: capabilitiesByTool(managementTools, "management"),
      }),
      ...executableBuiltinToolRecords(onDeviceTools, {
        ...context,
        packageId: "cap.on-device-text-tools",
      }),
    ];
  };

  const lazy = createLazyProviderToolset({
    readSources,
    contextReader: () => runContext(),
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  }) as any;

  // 1. search for read_page
  const readPageSearch = await lazy.tools.search_tools.execute({ query: "read_page" });
  assertEquals(readPageSearch.ok, true, `search_tools for read_page failed: ${JSON.stringify(readPageSearch)}`);
  assert(readPageSearch.results?.length > 0, "must find read_page");
  assert(readPageSearch.results.some((r: any) => r.name === "read_page"), "read_page must be in results");

  // 2. search for summarize
  const summarizeSearch = await lazy.tools.search_tools.execute({ query: "summarize" });
  assertEquals(summarizeSearch.ok, true, `search_tools for summarize failed: ${JSON.stringify(summarizeSearch)}`);
  assert(summarizeSearch.results?.length > 0, "must find summarize_text");
  assert(summarizeSearch.results.some((r: any) => r.name === "summarize_text"), "summarize_text must be in results");

  // 3. search for write_clipboard and clipboard
  const clipboardSearch = await lazy.tools.search_tools.execute({ query: "write_clipboard" });
  assertEquals(clipboardSearch.ok, true, `search_tools for write_clipboard failed: ${JSON.stringify(clipboardSearch)}`);
  assert(clipboardSearch.results?.length > 0, "must find write_clipboard");
  assert(clipboardSearch.results.some((r: any) => r.name === "write_clipboard"), "write_clipboard must be in results");

  const clipSearch = await lazy.tools.search_tools.execute({ query: "clipboard" });
  assertEquals(clipSearch.ok, true, `search_tools for clipboard failed: ${JSON.stringify(clipSearch)}`);
  assert(clipSearch.results?.length > 0, "must find clipboard tool");
  assert(clipSearch.results.some((r: any) => r.name === "write_clipboard"), "write_clipboard must be in results for clipboard query");

  // 4. list_tools
  const listRes = await lazy.tools.list_tools.execute({});
  assertEquals(listRes.ok, true, `list_tools failed: ${JSON.stringify(listRes)}`);
  assert(listRes.tools, "list_tools must return tools");
  assert(listRes.tools.browser?.length > 0, "browser tools must be present");
  assert(listRes.tools.management?.length > 0, "management tools must be present");
  assert(listRes.tools.builtin?.length > 0, "builtin on-device tools must be present");
});
