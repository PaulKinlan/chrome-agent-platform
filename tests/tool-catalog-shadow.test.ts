// tests/tool-catalog-shadow.test.ts — diagnostics-only integration and provider nondisclosure.
// @ts-nocheck

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { ShadowToolCatalogController } from "../extension/lib/tool-catalog-shadow.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import { PAGE_ALLOWED_ROUTES } from "../extension/lib/pure.js";

function inputs(generation = "source:1") {
  return [{
    sourceKind: "webmcp-declared",
    packageId: "webmcp:https://example.test",
    toolId: "lookup",
    version: "page-current",
    name: "lookup",
    aliases: ["find"],
    description: "Look up page data",
    inputSchema: { type: "object" },
    capabilities: ["webmcp.invoke"],
    scope: {
      hub: false,
      agentId: "site:https://example.test",
      origin: "https://example.test",
      documentId: "doc-1",
    },
    sourceGeneration: generation,
    availability: "ready",
    dispatcherKind: "webmcp",
  }];
}

function refFactory() {
  let value = 0;
  return () => `sel_${(++value).toString(16).padStart(36, "0")}`;
}

Deno.test("tool catalog shadow: summary/search/resolve remain metadata-only", async () => {
  const controller = new ShadowToolCatalogController({
    readInputs: () => inputs(),
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const summary = await controller.inspect({ action: "summary" });
  assertEquals(summary.mode, "shadow-metadata-only");
  assertEquals(summary.descriptorCount, 1);
  assertEquals(summary.canExecute, false);
  assertEquals(summary.canGrant, false);

  const request = {
    action: "search",
    query: "find",
    runId: "run-1",
    agentId: "site:https://example.test",
    origin: "https://example.test",
    documentId: "doc-1",
  };
  const searched = await controller.inspect(request);
  assertEquals(searched.ok, true);
  assertEquals(searched.results.length, 1);
  assertEquals(searched.results[0].authorizes, false);
  const resolved = await controller.inspect({
    ...request,
    action: "resolve",
    selectionRef: searched.results[0].selectionRef,
  });
  assertEquals(resolved.ok, true);
  assertEquals(resolved.authorizes, false);
  assertEquals("execute" in resolved, false);
});

Deno.test("tool catalog shadow: live source-generation replacement stales prior refs", async () => {
  let generation = "source:1";
  const controller = new ShadowToolCatalogController({
    readInputs: () => inputs(generation),
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = {
    query: "lookup",
    runId: "run-1",
    agentId: "site:https://example.test",
    origin: "https://example.test",
    documentId: "doc-1",
  };
  const searched = await controller.inspect({ action: "search", ...context });
  generation = "source:2";
  const stale = await controller.inspect({
    action: "resolve",
    ...context,
    selectionRef: searched.results[0].selectionRef,
  });
  assertEquals(stale.ok, false);
});

Deno.test("tool catalog shadow: route remains Settings-only and absent from provider binding", async () => {
  const worker = await Deno.readTextFile(
    "extension/background/service-worker.js",
  );
  const prompts = await Deno.readTextFile("extension/lib/system-prompts.js");
  const agent = await Deno.readTextFile("extension/lib/agent.js");

  assertStringIncludes(worker, 'async "tool-catalog.shadow"(m, context)');
  assertStringIncludes(worker, 'context?.principal !== "owner-options"');
  assertEquals(PAGE_ALLOWED_ROUTES.has("tool-catalog.shadow"), false);
  assertStringIncludes(worker, "const liveBrowserTools = browserToolset(scoped)");
  assertStringIncludes(worker, "const liveManagementTools = scoped ? {} : managementToolset({");
  assertStringIncludes(worker, "readMasterLazySources");
  assertStringIncludes(worker, "readSiteLazySources");
  assertStringIncludes(agent, "const allTools = lazy.tools");
  assertStringIncludes(agent, "createLazyProviderToolset");
  assert(!prompts.includes("tool-catalog.shadow"));
  assert(!agent.includes("tool-catalog.shadow"));
});

Deno.test("tool catalog shadow: source module has no execute/grant/install/package runtime imports", async () => {
  const source = await Deno.readTextFile(
    "extension/lib/tool-catalog-shadow.js",
  );
  assert(!/\.execute\s*\(/u.test(source));
  assert(
    !/permissions\.request|setProvider|install|WebAssembly|Worker/u.test(
      source,
    ),
  );
  assertStringIncludes(source, "canExecute: false");
  assertStringIncludes(source, "canGrant: false");
});
