// tests/tool-catalog-user-wasm.test.ts — Catalog registration and lazy search for user-uploaded WebAssembly tools (S3).
// @ts-nocheck

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  adaptUserWasmTools,
  buildToolCatalog,
  canonicalToolDescriptor,
  userWasmCatalogInputs,
  TOOL_SOURCE_KINDS,
  ToolCatalogValidationError,
} from "../extension/lib/tool-catalog.js";
import { buildToolSearchIndex, searchToolIndex } from "../extension/lib/tool-search.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import {
  createLazyProviderToolset,
  executableUserWasmToolRecords,
  userWasmLazyRecords,
} from "../extension/lib/lazy-tool-protocol.js";
import { ShadowToolCatalogController } from "../extension/lib/tool-catalog-shadow.js";
import { listOwnerBlobs, createOwnerBlobStore } from "../extension/lib/user-wasm-store.js";

const SAMPLE_DIGEST = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

Deno.test("user-wasm catalog: TOOL_SOURCE_KINDS includes 'user-wasm'", () => {
  assert(TOOL_SOURCE_KINDS.includes("user-wasm"), "TOOL_SOURCE_KINDS must include 'user-wasm'");
});

Deno.test("user-wasm catalog: adaptUserWasmTools maps store rows to canonical descriptors", () => {
  const row = {
    version: 2,
    digest: SAMPLE_DIGEST,
    kind: "wasm",
    name: "csv_filter",
    description: "Filters CSV rows by column value via user-uploaded WASI module",
    size: 65536,
    addedAt: 1725555555555,
  };

  const inputs = adaptUserWasmTools([row], {
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
  });

  assertEquals(inputs.length, 1);
  const input = inputs[0];
  assertEquals(input.sourceKind, "user-wasm");
  assertEquals(input.name, "csv_filter");
  assertEquals(input.toolId, "csv_filter");
  assertEquals(input.description, "Filters CSV rows by column value via user-uploaded WASI module");
  assertEquals(input.packageDigest, SAMPLE_DIGEST);
  assertEquals(input.dispatcherKind, "user-wasm-task");
  assertEquals(input.availability, "ready");

  const canonical = canonicalToolDescriptor(input);
  assertEquals(canonical.sourceKind, "user-wasm");
  assertEquals(canonical.name, "csv_filter");
  assertEquals(canonical.description, "Filters CSV rows by column value via user-uploaded WASI module");
  assertEquals(canonical.packageDigest, SAMPLE_DIGEST);
  assertEquals(canonical.dispatcherKind, "user-wasm-task");
  assertEquals(canonical.availability, "ready");
  assertEquals(canonical.trustedReplaySafety, "unknown");

  // Input schema must be the WASI shape: argv (args) + stdin text, no invented per-module JSON schema
  const inputSchema = input.inputSchema;
  assertEquals(inputSchema.type, "object");
  assert(inputSchema.properties.args, "must declare args property for argv");
  assertEquals(inputSchema.properties.args.type, "array");
  assert(inputSchema.properties.stdin, "must declare stdin property for stdin text");
  assertEquals(inputSchema.properties.stdin.type, "string");
  assertEquals(inputSchema.additionalProperties, false);

  const schemaSummary = JSON.parse(canonical.schemaSummary);
  assert(schemaSummary && typeof schemaSummary === "object");

  // userWasmCatalogInputs composition delegates and produces identical output
  const inputsViaCatalogInputs = userWasmCatalogInputs([row], { version: "0.3.284", scope: { hub: true } });
  assertEquals(inputsViaCatalogInputs.length, 1);
  assertEquals(inputsViaCatalogInputs[0].name, "csv_filter");
  assertEquals(inputsViaCatalogInputs[0].sourceKind, "user-wasm");
});

Deno.test("user-wasm catalog: non-wasm kinds (e.g. wheels) NEVER surface as user-wasm tools (M2 guard)", async () => {
  const wasmRow = {
    version: 2,
    digest: SAMPLE_DIGEST,
    kind: "wasm",
    name: "image_resizer",
    description: "Resize images on-device",
  };
  const wheelRow = {
    version: 2,
    digest: "f".repeat(64),
    kind: "wheel",
    name: "numpy_wheel",
    description: "Python numpy wheel package",
  };
  const kindlessRow = {
    version: 2,
    digest: "e".repeat(64),
    name: "kindless_entry",
    description: "Missing kind field",
  };

  // 1. adaptUserWasmTools is fail-closed: drops wheel rows AND kindless rows
  const inputs = adaptUserWasmTools([wasmRow, wheelRow, kindlessRow]);
  assertEquals(inputs.length, 1, "adaptUserWasmTools must drop non-wasm and kindless rows (fail-closed)");
  assertEquals(inputs[0].name, "image_resizer");
  assertEquals(adaptUserWasmTools([wheelRow]).length, 0, "direct wheel row must yield 0 descriptors");
  assertEquals(adaptUserWasmTools([kindlessRow]).length, 0, "kindless row must yield 0 descriptors");

  // 2. Catalog built from mixed inputs never registers wheel
  const catalog = buildToolCatalog(inputs);
  assertEquals(catalog.descriptors.length, 1);
  assertEquals(catalog.descriptors[0].name, "image_resizer");

  // 3. userWasmCatalogInputs also drops wheels
  const catalogInputs = userWasmCatalogInputs([wasmRow, wheelRow], { version: "1" });
  assertEquals(catalogInputs.length, 1);
  assertEquals(catalogInputs[0].name, "image_resizer");
});

Deno.test("user-wasm catalog: packageDigest must be a valid 64-character hex SHA-256", () => {
  const badDigestInput = {
    sourceKind: "user-wasm",
    packageId: "cap.user-wasm",
    toolId: "test_tool",
    name: "test_tool",
    version: "1",
    description: "A test tool",
    sourceGeneration: "gen-1",
    packageDigest: "invalid-not-sha256",
    dispatcherKind: "user-wasm-task",
    availability: "ready",
  };

  let threw = false;
  try {
    canonicalToolDescriptor(badDigestInput);
  } catch (err) {
    threw = true;
    assert(err instanceof ToolCatalogValidationError);
    assertEquals(err.code, "package-digest");
  }
  assert(threw, "descriptor must fail closed when packageDigest is not a valid 64-hex SHA-256");
});

Deno.test("user-wasm catalog: search_tools returns uploaded module with owner's name, description, and digest", async () => {
  const row = {
    version: 2,
    digest: SAMPLE_DIGEST,
    kind: "wasm",
    name: "image_resizer",
    description: "Downscales images using custom WebAssembly binary",
    size: 1048576,
    addedAt: 1725555555555,
  };

  const inputs = adaptUserWasmTools([row]);
  const catalog = buildToolCatalog(inputs);
  assertEquals(catalog.descriptors.length, 1);
  assertEquals(catalog.diagnostics.rejected, 0);

  const index = buildToolSearchIndex(catalog);
  const searchResult = searchToolIndex(index, "resizer");
  assertEquals(searchResult.results.length, 1);

  const found = searchResult.results[0];
  assertEquals(found.name, "image_resizer");
  assertEquals(found.summary, "Downscales images using custom WebAssembly binary");
  assertEquals(found.packageDigest, SAMPLE_DIGEST);
  assertEquals(found.sourceKind, "user-wasm");
  assertEquals(found.dispatcherKind, "user-wasm-task");
  assertEquals(found.availability, "ready");

  // Selection authority issues a valid selection reference
  const selections = new ToolSelectionAuthority();
  const issued = selections.issue(
    searchResult,
    {
      runId: "run-user-wasm-1",
      taskId: "task-user-wasm-1",
      agentId: "hub",
      origin: "",
      documentId: "",
      runGeneration: "1",
      catalogGeneration: catalog.generation,
    },
    catalog,
  );
  assertEquals(issued.ok, true);
  assertEquals(issued.results.length, 1);
  assert(issued.results[0].selectionRef.startsWith("sel_"), "must issue valid selectionRef");
  assertEquals(issued.results[0].name, "image_resizer");
});

Deno.test("user-wasm catalog: removing a module removes it from the catalog within the same session (no reload)", async () => {
  const storeRows = [
    {
      version: 2,
      digest: SAMPLE_DIGEST,
      kind: "wasm",
      name: "markdown_parser",
      description: "Fast markdown to AST converter in Wasm",
      size: 131072,
      addedAt: 1725555555555,
    },
  ];

  const toolset = createLazyProviderToolset({
    readSources: async () => {
      return executableUserWasmToolRecords(storeRows, {
        scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
        sourceGeneration: `user-wasm:${storeRows.length}:${storeRows.map((r) => r.digest).join(",")}`,
      });
    },
    contextReader: async () => ({
      runId: "run-session-1",
      taskId: "task-session-1",
      agentId: "hub",
      origin: "",
      documentId: "",
      runGeneration: "1",
    }),
    selectionAuthority: new ToolSelectionAuthority(),
  });

  // Step 1: Tool is uploaded -> search_tools returns it
  const searchBefore = await toolset.tools.search_tools.execute({ query: "markdown" });
  assertEquals(searchBefore.ok, true);
  assertEquals(searchBefore.results.length, 1);
  assertEquals(searchBefore.results[0].name, "markdown_parser");
  assertEquals(searchBefore.results[0].summary, "Fast markdown to AST converter in Wasm");

  // Step 2: Remove module in store -> search_tools in SAME session without reload no longer returns it
  storeRows.length = 0; // removed

  const searchAfter = await toolset.tools.search_tools.execute({ query: "markdown" });
  assertEquals(searchAfter.ok, true);
  assertEquals(searchAfter.results.length, 0, "removed tool must not appear in search_tools in same session");
});

Deno.test("user-wasm catalog: falsification — dropping user-wasm adapter causes search to fail", async () => {
  const storeRows = [
    {
      version: 2,
      digest: SAMPLE_DIGEST,
      kind: "wasm",
      name: "json_validator",
      description: "Validates JSON against schema using Wasm",
      size: 32768,
      addedAt: 1725555555555,
    },
  ];

  // With adapter: finds the tool
  const withAdapterToolset = createLazyProviderToolset({
    readSources: async () => executableUserWasmToolRecords(storeRows, {
      scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
    }),
    contextReader: async () => ({
      runId: "run-falsify-1",
      taskId: "task-falsify-1",
      agentId: "hub",
      origin: "",
      documentId: "",
      runGeneration: "1",
    }),
    selectionAuthority: new ToolSelectionAuthority(),
  });

  const foundWith = await withAdapterToolset.tools.search_tools.execute({ query: "validator" });
  assertEquals(foundWith.results.length, 1);
  assertEquals(foundWith.results[0].name, "json_validator");

  // Dropping adapter: does not find the tool
  const withoutAdapterToolset = createLazyProviderToolset({
    readSources: async () => [], // adapter dropped
    contextReader: async () => ({
      runId: "run-falsify-2",
      taskId: "task-falsify-2",
      agentId: "hub",
      origin: "",
      documentId: "",
      runGeneration: "1",
    }),
    selectionAuthority: new ToolSelectionAuthority(),
  });

  const foundWithout = await withoutAdapterToolset.tools.search_tools.execute({ query: "validator" });
  assertEquals(foundWithout.results.length, 0, "dropping adapter must not return user-wasm tool");
});

Deno.test("user-wasm catalog: per-agent allowlist grants are strictly DIGEST-ONLY, never name-based", () => {
  const rowA = {
    version: 2,
    digest: "a".repeat(64),
    kind: "wasm",
    name: "tool_a",
    description: "Tool A",
  };
  const rowB = {
    version: 2,
    digest: "b".repeat(64),
    kind: "wasm",
    name: "tool_b",
    description: "Tool B",
  };
  const storeRows = [rowA, rowB];

  // 1. Full access when agentTools is unset
  const allRecords = userWasmLazyRecords(storeRows, { scope: { hub: true } });
  assertEquals(allRecords.length, 2);

  // 2. Digest grant works
  const grantedByDigest = userWasmLazyRecords(storeRows, {
    agentTools: { userWasm: ["a".repeat(64)] },
    scope: { hub: true },
  });
  assertEquals(grantedByDigest.length, 1);
  assertEquals(grantedByDigest[0].descriptorInput.name, "tool_a");

  // 3. Name grant FAILS (coord ruling: digest-only, name is display only)
  const grantedByName = userWasmLazyRecords(storeRows, {
    agentTools: { userWasm: ["tool_a"] },
    scope: { hub: true },
  });
  assertEquals(grantedByName.length, 0, "name-based grant must be rejected — grants are digest-only");

  // 4. Unknown digest fails
  const unknownDigest = userWasmLazyRecords(storeRows, {
    agentTools: { userWasm: ["c".repeat(64)] },
    scope: { hub: true },
  });
  assertEquals(unknownDigest.length, 0);
});

Deno.test("user-wasm catalog: executing shadow catalog inspection projects user-wasm tools", async () => {
  const row = {
    version: 2,
    digest: SAMPLE_DIGEST,
    kind: "wasm",
    name: "wasm_formatter",
    description: "Formats code on-device using custom WebAssembly",
  };

  // Executing inspection WITH user-wasm adapter
  const controllerWith = new ShadowToolCatalogController({
    readInputs: () => adaptUserWasmTools([row], {
      version: "0.3.284",
      scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
    }),
  });

  const summaryWith = await controllerWith.inspect({ action: "summary" });
  assertEquals(summaryWith.bySource["user-wasm"], 1);
  assert(Array.isArray(summaryWith.toolsBySource["user-wasm"]));
  assertEquals(summaryWith.toolsBySource["user-wasm"].length, 1);
  assertEquals(summaryWith.toolsBySource["user-wasm"][0].name, "wasm_formatter");
  assertEquals(summaryWith.toolsBySource["user-wasm"][0].description, "Formats code on-device using custom WebAssembly");

  // Falsification: executing inspection WITHOUT user-wasm adapter
  const controllerWithout = new ShadowToolCatalogController({
    readInputs: () => [],
  });
  const summaryWithout = await controllerWithout.inspect({ action: "summary" });
  assertEquals(summaryWithout.bySource["user-wasm"] ?? 0, 0);
  assertEquals((summaryWithout.toolsBySource["user-wasm"] ?? []).length, 0, "omitting adapter must project 0 user-wasm tools");
});

Deno.test("user-wasm catalog: storage read failure pushes diagnostic instead of failing silently", async () => {
  const pushedDiagnostics = [];
  const fakePushDiagnostic = (severity, message, category, topic) => {
    pushedDiagnostics.push({ severity, message, category, topic });
  };

  const mockReadUserWasmRows = async (failingStore) => {
    try {
      return await failingStore();
    } catch (err) {
      fakePushDiagnostic(
        "error",
        `User Wasm catalog listing failed: ${String(err?.message ?? err).slice(0, 160)}`,
        "user-wasm",
        "catalog",
      );
      return [];
    }
  };

  // Test: storage failure must push an error diagnostic
  const failingOpfs = () => Promise.reject(new Error("OPFS quota exceeded"));
  const rows = await mockReadUserWasmRows(failingOpfs);
  assertEquals(rows, []);
  assertEquals(pushedDiagnostics.length, 1);
  assertEquals(pushedDiagnostics[0].severity, "error");
  assertEquals(pushedDiagnostics[0].category, "user-wasm");
  assertEquals(pushedDiagnostics[0].topic, "catalog");
  assert(pushedDiagnostics[0].message.includes("OPFS quota exceeded"));
});

Deno.test("user-wasm catalog: service worker calls are active and not dead-coded (M1/M1' guard)", async () => {
  const swCode = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));

  // Must not be dead-coded or conditionally bypassed (kills M1/M1' dead-code mutants)
  assert(!/\(\s*false\s*\?\s*[^:]*userWasmCatalogInputs/.test(swCode), "userWasmCatalogInputs call site must not be dead-coded with false ?");
  assert(!/\(\s*false\s*\?\s*[^:]*adaptUserWasmTools/.test(swCode), "adaptUserWasmTools call site must not be dead-coded with false ?");
  assert(!/\(\s*false\s*\?\s*[^:]*userWasmLazyRecords/.test(swCode), "userWasmLazyRecords call site must not be dead-coded with false ?");
  assert(!/\(\s*false\s*\?\s*[^:]*executableUserWasmToolRecords/.test(swCode), "executableUserWasmToolRecords call site must not be dead-coded with false ?");

  // Must be active calls in readShadowCatalogInputs and liveChromeLazyRecords
  assert(
    swCode.includes("...userWasmCatalogInputs(") || swCode.includes("...adaptUserWasmTools("),
    "shadow catalog inputs must spread userWasmCatalogInputs/adaptUserWasmTools",
  );
  assert(
    swCode.includes("...userWasmLazyRecords(") || swCode.includes("...executableUserWasmToolRecords("),
    "lazy records must spread userWasmLazyRecords/executableUserWasmToolRecords",
  );
  const lazyCode = await Deno.readTextFile(new URL("../extension/lib/lazy-tool-protocol.js", import.meta.url));
  assert(
    lazyCode.includes("allowed.has(row.digest)") || swCode.includes("allowed.has(row.digest)"),
    "Lazy records must enforce digest-only allowlisting",
  );
  assert(
    !lazyCode.includes("allowed.has(row.name)") && !swCode.includes("allowed.has(row.name)"),
    "Lazy records must not allowlist by name",
  );
});

Deno.test("user-wasm catalog: service worker pushes owner-visible diagnostic on listing error (M4 guard)", async () => {
  const swCode = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(
    swCode.includes("User Wasm catalog listing failed:"),
    "service-worker must push error diagnostic on User Wasm catalog listing failure (M4 guard)",
  );
  assert(
    swCode.includes('"user-wasm"') && swCode.includes('"catalog"'),
    "readUserWasmRows diagnostic must carry 'user-wasm' category and 'catalog' topic",
  );
});
