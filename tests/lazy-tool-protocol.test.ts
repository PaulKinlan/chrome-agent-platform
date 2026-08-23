// tests/lazy-tool-protocol.test.ts — shadow-only run-bound lazy protocol authority.

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { tool } from "ai";
import { z } from "zod";
import {
  executableBrowserToolRecords,
  executableBuiltinToolRecords,
  executableManagementToolRecords,
  executableWebMcpToolRecords,
  LAZY_PROTOCOL_TOOL_WIRE,
  LAZY_TOOL_PROTOCOL_BOUNDS,
  LazyToolProtocol,
} from "../extension/lib/lazy-tool-protocol.js";
import { ShadowToolCatalogController } from "../extension/lib/tool-catalog-shadow.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import { managementToolset } from "../extension/lib/management-tools.js";
import { memoryToolset } from "../extension/lib/agent.js";
import { browserToolset } from "../extension/lib/browser-tools.js";

const HUB_SCOPE = { hub: true, agentId: "hub", origin: "", documentId: "" };

function refFactory() {
  let value = 0;
  return () => `sel_${(++value).toString(16).padStart(36, "0")}`;
}

function adapterContext(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.0.0",
    sourceGeneration: "extension:1",
    scope: HUB_SCOPE,
    capabilities: ["test.invoke"],
    ...overrides,
  };
}

function runContext(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    taskId: "task-1",
    runGeneration: "generation-1",
    agentId: "hub",
    origin: "",
    documentId: "hub-doc",
    ...overrides,
  };
}

function builtinRecords(
  execute: (args: Record<string, unknown>, options?: unknown) => unknown,
  overrides: Record<string, unknown> = {},
) {
  const tools = {
    echo: tool({
      description: "Echo a bounded value",
      inputSchema: z.object({ value: z.string().max(64) }),
      execute,
    }),
  };
  return executableBuiltinToolRecords(tools, adapterContext(overrides));
}

async function searchedRef(protocol: LazyToolProtocol, context = runContext()) {
  const searched = await protocol.search({ query: "echo", limit: 1 }, context);
  assertEquals(searched.ok, true);
  assertEquals(searched.results.length, 1);
  assertMatch(searched.results[0].selectionRef, /^sel_[a-f0-9]{36}$/);
  assertEquals(searched.results[0].authorizes, false);
  return searched.results[0].selectionRef;
}

Deno.test("lazy protocol: search is non-authorizing and execute delegates through the existing closure", async () => {
  let calls = 0;
  let dispatchOptions: unknown;
  const records = builtinRecords((args, options) => {
    calls++;
    dispatchOptions = options;
    return { echoed: args.value };
  });
  const protocol = new LazyToolProtocol({
    readSources: () => records,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = runContext();
  const ref = await searchedRef(protocol, context);
  assertEquals(calls, 0, "retrieval must not execute or grant");
  assertEquals(
    await protocol.execute({
      selectionRef: "sel_ffffffffffffffffffffffffffffffffffff",
      arguments: { value: "forged" },
    }, context),
    { ok: false, error: "selection-missing-or-expired" },
  );
  assertEquals(calls, 0, "a forged or non-selected reference is uncallable");
  const result = await protocol.execute({
    selectionRef: ref,
    arguments: { value: "hello" },
  }, context);
  assertEquals(result.ok, true);
  assertEquals(result.result, { echoed: "hello" });
  assertEquals(result.authorizes, false);
  assertEquals(result.requiresLiveAuthorization, true);
  assertEquals(result.replay.safety, "unknown");
  assertEquals(
    (dispatchOptions as { lazyReplayMetadata?: { safety?: string } })
      ?.lazyReplayMetadata?.safety,
    "unknown",
  );
  assertEquals(calls, 1);
  assertEquals(
    await protocol.execute({
      selectionRef: ref,
      arguments: { value: "replayed" },
    }, context),
    { ok: false, error: "selection-replayed" },
  );
  assertEquals(calls, 1, "a consumed ref cannot dispatch twice");
  assertEquals(protocol.diagnostics().providerBound, false);
  assertEquals(protocol.diagnostics().grantsCreated, 0);
});

Deno.test("lazy protocol: Zod validation cache cannot rotate catalog/package identity", async () => {
  const records = builtinRecords(() => ({ ok: true }));
  const before = new LazyToolProtocol({
    readSources: () => records,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = runContext();
  const searched = await before.search({ query: "echo", limit: 1 }, context);
  const stableId = searched.results[0].stableId;
  const schema = records[0].descriptorInput.inputSchema as {
    safeParse(value: unknown): unknown;
  };
  schema.safeParse({ value: "warms-runtime-cache" });
  const afterSearch = await before.search({ query: "echo", limit: 1 }, context);
  assertEquals(afterSearch.results[0].stableId, stableId);
  const executed = await before.execute({
    selectionRef: searched.results[0].selectionRef,
    arguments: { value: "still-valid" },
  }, context);
  assertEquals(executed.ok, true);
});

Deno.test("lazy protocol: run/agent/origin/document fences cannot cross contexts", async () => {
  const records = builtinRecords(() => ({ ok: true }));
  const authority = new ToolSelectionAuthority({ newRef: refFactory() });
  const protocol = new LazyToolProtocol({
    readSources: () => records,
    selectionAuthority: authority,
  });
  const original = runContext();
  const ref = await searchedRef(protocol, original);
  for (
    const changed of [
      { runId: "run-2" },
      { agentId: "other" },
      { origin: "https://other.test" },
      { documentId: "other-doc" },
    ]
  ) {
    const result = await protocol.execute({
      selectionRef: ref,
      arguments: { value: "x" },
    }, runContext(changed));
    assertEquals(result.ok, false);
    assertEquals(result.error, "selection-scope-mismatch");
  }
});

Deno.test("lazy protocol: expiry and service-worker restart lose every reference", async () => {
  let now = 100;
  const records = builtinRecords(() => ({ ok: true }));
  const authority = new ToolSelectionAuthority({
    clock: () => now,
    newRef: refFactory(),
  });
  const protocol = new LazyToolProtocol({
    readSources: () => records,
    selectionAuthority: authority,
  });
  const context = runContext();
  const searched = await protocol.search({ query: "echo", ttlMs: 10 }, context);
  const ref = searched.results[0].selectionRef;
  now += 11;
  assertEquals(
    await protocol.execute(
      { selectionRef: ref, arguments: { value: "x" } },
      context,
    ),
    { ok: false, error: "selection-missing-or-expired" },
  );
  const restarted = new LazyToolProtocol({ readSources: () => records });
  assertEquals(
    await restarted.execute(
      { selectionRef: ref, arguments: { value: "x" } },
      context,
    ),
    { ok: false, error: "selection-missing-or-expired" },
  );
});

Deno.test("lazy protocol: catalog/source/package identity changes fail closed before dispatch", async () => {
  let version = "1.0.0";
  let sourceGeneration = "extension:1";
  let description = "Echo a bounded value";
  let calls = 0;
  const readSources = () =>
    executableBuiltinToolRecords({
      echo: tool({
        description,
        inputSchema: z.object({ value: z.string() }),
        execute: () => {
          calls++;
          return { ok: true };
        },
      }),
    }, adapterContext({ version, sourceGeneration }));
  const protocol = new LazyToolProtocol({
    readSources,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = runContext();
  for (
    const mutate of [
      () => sourceGeneration = "extension:2",
      () => version = "2.0.0",
      () => description = "descriptor digest changed",
    ]
  ) {
    version = "1.0.0";
    sourceGeneration = "extension:1";
    description = "Echo a bounded value";
    const ref = await searchedRef(protocol, context);
    mutate();
    const result = await protocol.execute({
      selectionRef: ref,
      arguments: { value: "x" },
    }, context);
    assertEquals(result.ok, false);
  }
  assertEquals(calls, 0);
});

Deno.test("lazy protocol: unavailable tools are explainable but receive no executable ref", async () => {
  const records = builtinRecords(() => ({ ok: true }), {
    availability: "owner-action-required",
  });
  const protocol = new LazyToolProtocol({
    readSources: () => records,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const searched = await protocol.search({ query: "echo" }, runContext());
  assertEquals(searched.ok, true);
  assertEquals(searched.results.length, 1);
  assertEquals(searched.results[0].selectionRef, null);
  assertEquals(searched.results[0].availability, "owner-action-required");
  assertEquals(protocol.diagnostics().activeSelections, 0);
});

Deno.test("lazy protocol: hostile accessors, Unicode and oversized arguments fail without dispatch", async () => {
  let calls = 0;
  const protocol = new LazyToolProtocol({
    readSources: () => builtinRecords(() => calls++),
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = runContext();
  const ref = await searchedRef(protocol, context);
  const hostile = {};
  Object.defineProperty(hostile, "value", {
    get() {
      throw new Error("owned");
    },
  });
  for (
    const args of [
      hostile,
      { value: "\ud800" },
      { value: "x".repeat(LAZY_TOOL_PROTOCOL_BOUNDS.maxArgumentBytes + 1) },
      { constructor: "poison", value: "x" },
    ]
  ) {
    const result = await protocol.execute({
      selectionRef: ref,
      arguments: args,
    }, context);
    assertEquals(result.ok, false);
  }
  assertEquals(calls, 0);
});

Deno.test("lazy protocol: Zod validation is applied before the existing dispatcher", async () => {
  let calls = 0;
  const protocol = new LazyToolProtocol({
    readSources: () => builtinRecords(() => calls++),
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = runContext();
  const ref = await searchedRef(protocol, context);
  assertEquals(
    await protocol.execute(
      { selectionRef: ref, arguments: { value: 42 } },
      context,
    ),
    { ok: false, error: "lazy-arguments-invalid" },
  );
  assertEquals(calls, 0);
});

Deno.test("lazy protocol: cancellation fences before and after the existing dispatcher", async () => {
  const pre = new AbortController();
  pre.abort();
  const records = builtinRecords(() => ({ ok: true }));
  const protocol = new LazyToolProtocol({
    readSources: () => records,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  assertEquals(
    await protocol.search(
      { query: "echo" },
      runContext({ signal: pre.signal }),
    ),
    { ok: false, error: "lazy-run-aborted" },
  );

  const during = new AbortController();
  const changing = builtinRecords(() => {
    during.abort();
    return { shouldNotSurface: true };
  });
  const protocol2 = new LazyToolProtocol({
    readSources: () => changing,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = runContext({ signal: during.signal });
  const ref = await searchedRef(protocol2, context);
  assertEquals(
    await protocol2.execute(
      { selectionRef: ref, arguments: { value: "x" } },
      context,
    ),
    { ok: false, error: "lazy-run-aborted" },
  );
});

Deno.test("lazy protocol: validator replacement at an async boundary fails before dispatch", async () => {
  let reads = 0;
  let calls = 0;
  const baseRecord = builtinRecords(() => ({ ok: true }))[0];
  const descriptorInput = baseRecord.descriptorInput;
  const accepting = {
    descriptorInput,
    authorize: baseRecord.authorize,
    validateArguments: async (args: unknown) => ({ ok: true, data: args }),
    dispatch: () => {
      calls++;
      return { ok: true };
    },
  };
  const rejecting = {
    ...accepting,
    validateArguments: async () => ({ ok: false }),
  };
  const protocol = new LazyToolProtocol({
    readSources: () => [++reads >= 3 ? rejecting : accepting],
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = runContext();
  const ref = await searchedRef(protocol, context);
  const result = await protocol.execute({
    selectionRef: ref,
    arguments: { value: "x" },
  }, context);
  assertEquals(result, { ok: false, error: "lazy-arguments-invalid" });
  assertEquals(calls, 0);
});

Deno.test("lazy protocol: post-dispatch source revocation discards the result", async () => {
  let generation = "extension:1";
  const readSources = () =>
    executableBuiltinToolRecords({
      echo: tool({
        description: "echo",
        inputSchema: z.object({ value: z.string() }),
        execute: () => {
          generation = "extension:2";
          return { shouldNotSurface: true };
        },
      }),
    }, adapterContext({ sourceGeneration: generation }));
  const protocol = new LazyToolProtocol({
    readSources,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = runContext();
  const ref = await searchedRef(protocol, context);
  const result = await protocol.execute({
    selectionRef: ref,
    arguments: { value: "x" },
  }, context);
  assertEquals(result.ok, false);
  assertNotEquals(result.error, undefined);
});

Deno.test("lazy protocol: built-in, browser, management and WebMCP adapters preserve dispatch parity", async () => {
  const calls: string[] = [];
  const builtin = executableBuiltinToolRecords(
    memoryToolset({
      get: async () => {
        calls.push("builtin");
        return "value";
      },
      set: async () => {},
      list: async () => [],
      grep: async () => [],
    }),
    adapterContext(),
  ).filter(
    (record: { descriptorInput: { toolId: string } }) =>
      record.descriptorInput.toolId === "memory_get",
  );
  const browser = executableBrowserToolRecords(
    browserToolset(false),
    adapterContext(),
  ).filter((record: { descriptorInput: { toolId: string } }) =>
    record.descriptorInput.toolId === "list_tabs"
  );
  const management = executableManagementToolRecords(
    managementToolset({
      callRoute: (type: string) => calls.push(`management:${type}`),
    }),
    adapterContext(),
  ).filter((record: { descriptorInput: { toolId: string } }) =>
    record.descriptorInput.toolId === "list_agents"
  );
  const webmcp = executableWebMcpToolRecords([{
    name: "page_lookup",
    source: "declared",
    description: "lookup",
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  }], {
    origin: "https://example.test",
    agentId: "hub",
    documentId: "hub-doc",
    sourceGeneration: "enrollment:1:epoch:1:seq:1",
  }, ({ name }: { name: string }) => calls.push(`webmcp:${name}`));
  const records = [...builtin, ...browser, ...management, ...webmcp];
  const protocol = new LazyToolProtocol({
    readSources: () => records,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const priorChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      permissions: { contains: async () => true },
      tabs: {
        query: async () => {
          calls.push("browser");
          return [{ id: 1, title: "Tab", url: "https://example.test/" }];
        },
      },
    },
  });
  try {
    for (
      const [query, args] of [
        ["memory_get", { key: "key" }],
        ["list_tabs", {}],
        ["list_agents", {}],
        ["page_lookup", { q: "x" }],
      ] as const
    ) {
      const context = query === "page_lookup"
        ? runContext({ origin: "https://example.test" })
        : runContext();
      const searched = await protocol.search({ query, limit: 1 }, context);
      assertEquals(searched.results.length, 1);
      const result = await protocol.execute({
        selectionRef: searched.results[0].selectionRef,
        arguments: args,
      }, context);
      assertEquals(result.ok, true, `${query} should use its existing closure`);
    }
  } finally {
    if (priorChrome) Object.defineProperty(globalThis, "chrome", priorChrome);
    else delete (globalThis as unknown as Record<string, unknown>).chrome;
  }
  assertEquals(calls, [
    "builtin",
    "browser",
    "management:agent.directory",
    "webmcp:page_lookup",
  ]);
});

Deno.test("lazy protocol: hostile structured dispatcher errors never invoke getters", async () => {
  let getterCalls = 0;
  const hostile = new Proxy({}, {
    get() {
      getterCalls++;
      throw new Error("getter executed");
    },
  });
  const protocol = new LazyToolProtocol({
    readSources: () =>
      builtinRecords(() => {
        throw hostile;
      }),
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = runContext();
  const ref = await searchedRef(protocol, context);
  const result = await protocol.execute({
    selectionRef: ref,
    arguments: { value: "x" },
  }, context);
  assertEquals(result, {
    ok: false,
    selectedTool: "echo",
    error: "lazy dispatcher failed",
  });
  assertEquals(getterCalls, 0);
});

Deno.test("lazy protocol: results are bounded and secret-safe", async () => {
  const protocol = new LazyToolProtocol({
    readSources: () =>
      builtinRecords(() => ({
        apiKey: "sk-supersecretvalue",
        message: "Bearer abcdefghijklmnop",
        huge: "x".repeat(LAZY_TOOL_PROTOCOL_BOUNDS.maxResultBytes * 2),
      })),
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const context = runContext();
  const ref = await searchedRef(protocol, context);
  const result = await protocol.execute({
    selectionRef: ref,
    arguments: { value: "x" },
  }, context);
  assertEquals(result.ok, true);
  const wire = JSON.stringify(result);
  assert(wire.length < LAZY_TOOL_PROTOCOL_BOUNDS.maxResultBytes);
  assert(!wire.includes("sk-supersecretvalue"));
  assert(!wire.includes("abcdefghijklmnop"));
});

Deno.test("lazy provider capture: only two fixed protocol tools and selected schemas cross the wire", async () => {
  const inputs = [{
    sourceKind: "extension-builtin",
    packageId: "cap.core-tools",
    toolId: "selected_tool",
    version: "1",
    name: "selected_tool",
    aliases: [],
    description: "selected-only-description",
    inputSchema: {
      type: "object",
      properties: { selected_marker: { type: "string" } },
    },
    capabilities: ["memory.read"],
    scope: HUB_SCOPE,
    sourceGeneration: "extension:1",
    availability: "ready",
    dispatcherKind: "builtin",
  }, {
    sourceKind: "extension-builtin",
    packageId: "cap.core-tools",
    toolId: "not_selected_tool",
    version: "1",
    name: "not_selected_tool",
    aliases: [],
    description: "NON_SELECTED_SECRET_SCHEMA_MARKER",
    inputSchema: {
      type: "object",
      properties: { NON_SELECTED_PROPERTY: { type: "string" } },
    },
    capabilities: ["nonselected.secret.capability"],
    scope: HUB_SCOPE,
    sourceGeneration: "extension:1",
    availability: "ready",
    dispatcherKind: "builtin",
  }];
  const controller = new ShadowToolCatalogController({
    readInputs: () => inputs,
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const capture = await controller.inspect({
    action: "capture",
    query: "selected_tool",
    limit: 1,
    runId: "run-1",
    agentId: "hub",
    origin: "",
    documentId: "hub-doc",
  });
  assertEquals(capture.ok, true);
  assertEquals(capture.providerBound, false);
  assertEquals(capture.eagerBindingChanged, false);
  assertEquals(capture.protocolTools, LAZY_PROTOCOL_TOOL_WIRE);
  assertEquals(capture.protocolTools.map((row: { name: string }) => row.name), [
    "search_tools",
    "list_tools",
    "execute_tool",
  ]);
  assertEquals(capture.selectedDescriptors.length, 1);
  assertEquals(capture.selectedDescriptors[0].name, "selected_tool");
  assertEquals(capture.selectedDescriptors[0].capabilitySummary.capabilityTokens, ["memory.read"]);
  assertEquals(capture.selectedDescriptors[0].trustedReplaySafety, "unknown");
  assertMatch(capture.selectedDescriptors[0].capabilityDigest, /^[0-9a-f]{64}$/u);
  assertEquals(capture.nonSelectedCount, 1);
  assertEquals(capture.omittedNonSelected, true);
  assertEquals(capture.canExecute, false);
  assertEquals(capture.canGrant, false);
  const wire = JSON.stringify(capture);
  assertStringIncludes(wire, "selected_marker");
  assert(!wire.includes("NON_SELECTED_SECRET_SCHEMA_MARKER"));
  assert(!wire.includes("NON_SELECTED_PROPERTY"));
  assert(!wire.includes("nonselected.secret.capability"));
  assert(!wire.includes("not_selected_tool"));
});

Deno.test("lazy protocol: production provider cutover binds only the fixed pair and protected flow guidance", async () => {
  const agent = await Deno.readTextFile("extension/lib/agent.js");
  const policy = await Deno.readTextFile("extension/lib/runtime-policy.js");
  const worker = await Deno.readTextFile(
    "extension/background/service-worker.js",
  );
  assertStringIncludes(agent, "createLazyProviderToolset");
  assertStringIncludes(agent, "const allTools = lazy.tools");
  assertStringIncludes(policy, "first call search_tools (or list_tools)");
  assertStringIncludes(policy, "then call execute_tool with the exact selectionRef");
  assertStringIncludes(worker, "readMasterLazySources");
  assertStringIncludes(worker, "readSiteLazySources");
  assertStringIncludes(worker, 'async "tool-catalog.shadow"(m, context)');
});

Deno.test("lazy protocol: top-k and aggregate selection responses stay bounded", async () => {
  const map: Record<string, unknown> = {};
  for (let index = 0; index < 40; index++) {
    map[`bounded_${index}`] = tool({
      description: "bounded common ".repeat(30),
      inputSchema: z.object({ value: z.string().optional() }),
      execute: () => index,
    });
  }
  const protocol = new LazyToolProtocol({
    readSources: () => executableBuiltinToolRecords(map, adapterContext()),
    selectionAuthority: new ToolSelectionAuthority({ newRef: refFactory() }),
  });
  const searched = await protocol.search(
    { query: "bounded", limit: 9999 },
    runContext(),
  );
  assert(searched.results.length <= 12);
  assert(JSON.stringify(searched).length <= 32 * 1024);
});
