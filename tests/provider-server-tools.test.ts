// tests/provider-server-tools.test.ts — KATs for provider-EXECUTED tools
// (slice 1: Gemini google_search via the native @ai-sdk/google lane).
//
// Every test is falsification-gated: the module, source kind, lane, latch, and
// rendering seams did not exist before this change, so each assertion fails on
// the pre-change tree (the source-pin tests fail on a tree missing the wiring;
// the functional tests fail with an import error).
// @ts-nocheck — the chrome/kv mock + protocol envelope shapes are intentionally
// dynamic (no types in Deno), matching the repo's established test pattern.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createServerToolLatchRegistry,
  geminiModelSupportsServerTools,
  groundingFromProviderMetadata,
  injectLatchedServerTools,
  liveProviderServerToolRecords,
  normalizeGeminiGrounding,
  PROVIDER_SERVER_TOOL_SPECS,
  resolveServerToolAvailability,
  SERVER_TOOL_LATCH_CAP_PER_RUN,
} from "../extension/lib/provider-server-tools.js";
import {
  GEMINI_COMPAT_DEFAULT_BASE_URL,
  isDefaultGeminiEndpoint,
} from "../extension/lib/models/gemini-native-model.js";
import { TOOL_SOURCE_KINDS } from "../extension/lib/tool-catalog.js";
import { resolveModelFromConfig } from "../extension/lib/provider.js";
import { LazyToolProtocol } from "../extension/lib/lazy-tool-protocol.js";

// ── chrome/kv mock (the established pattern from named-agents-provider.test.ts)
const store = new Map();
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
globalThis.chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (key) => {
        for (const k of (Array.isArray(key) ? key : [key])) store.delete(k);
      },
    },
  },
};

const GEMINI_SPEC = PROVIDER_SERVER_TOOL_SPECS[0];

Deno.test("provider-server: the source kind is a catalog member", () => {
  assert(TOOL_SOURCE_KINDS.includes("provider-server"));
});

Deno.test("provider-server: the descriptor carries the cost card + citation shape (report §3.2)", () => {
  assertEquals(GEMINI_SPEC.name, "provider-server/gemini/google_search");
  assertEquals(GEMINI_SPEC.cost.unit, "per-search-query");
  assertEquals(GEMINI_SPEC.cost.rateUsd, 0.014);
  assertStringIncludes(GEMINI_SPEC.cost.freeTierNote, "5,000");
  assertEquals(GEMINI_SPEC.citations, "inline-annotations");
  assertEquals(GEMINI_SPEC.v2.id, "google.google_search");
  assertEquals(GEMINI_SPEC.v2.type, "provider");
});

Deno.test("provider-server: the model gate admits Gemini 2.x/3.x and rejects pre-2.0/on-device", () => {
  assert(geminiModelSupportsServerTools("gemini-2.5-flash"));
  assert(geminiModelSupportsServerTools("gemini-3.7-flash"));
  assert(geminiModelSupportsServerTools("gemini-3.1-pro-preview"));
  assert(!geminiModelSupportsServerTools("gemini-1.5-pro"));
  assert(!geminiModelSupportsServerTools("gemini-nano"));
  assert(!geminiModelSupportsServerTools("gpt-5.5"));
  assert(!geminiModelSupportsServerTools(""));
});

Deno.test("provider-server: availability is disabled when the global toggle is off", () => {
  const r = resolveServerToolAvailability({
    spec: GEMINI_SPEC,
    lane: "gemini-native",
    modelId: "gemini-3.7-flash",
    globalEnabled: false,
    agentOptIn: true,
  });
  assertEquals(r.availability, "disabled");
  assertStringIncludes(r.reason, "Settings");
});

Deno.test("provider-server: availability is owner-action-required on the wrong lane, with an honest reason", () => {
  const r = resolveServerToolAvailability({
    spec: GEMINI_SPEC,
    lane: "openai-compatible",
    modelId: "gemini-3.7-flash",
    globalEnabled: true,
    agentOptIn: true,
  });
  assertEquals(r.availability, "owner-action-required");
  assertStringIncludes(r.reason, "gemini native provider");
});

Deno.test("provider-server: availability is owner-action-required on an unsupported model + missing opt-in", () => {
  const badModel = resolveServerToolAvailability({
    spec: GEMINI_SPEC,
    lane: "gemini-native",
    modelId: "gemini-1.5-pro",
    globalEnabled: true,
    agentOptIn: true,
  });
  assertEquals(badModel.availability, "owner-action-required");
  assertStringIncludes(badModel.reason, "does not support");
  const noOptIn = resolveServerToolAvailability({
    spec: GEMINI_SPEC,
    lane: "gemini-native",
    modelId: "gemini-3.7-flash",
    globalEnabled: true,
    agentOptIn: false,
  });
  assertEquals(noOptIn.availability, "owner-action-required");
  assertStringIncludes(noOptIn.reason, "not enabled for this agent");
});

Deno.test("provider-server: availability is ready only when every gate holds", () => {
  const r = resolveServerToolAvailability({
    spec: GEMINI_SPEC,
    lane: "gemini-native",
    modelId: "gemini-3.7-flash",
    globalEnabled: true,
    agentOptIn: true,
  });
  assertEquals(r.availability, "ready");
});

Deno.test("provider-server: the per-run latch cap is enforced and re-activation counts", () => {
  const registry = createServerToolLatchRegistry({ capPerRun: 3 });
  assertEquals(registry.latch("run-a", "google_search").ok, true);
  const again = registry.latch("run-a", "google_search");
  assertEquals(again.ok, true);
  assertEquals(again.alreadyActive, true); // still active, but the op counted
  registry.latch("run-a", "google_search");
  const over = registry.latch("run-a", "google_search");
  assertEquals(over.ok, false);
  assertStringIncludes(over.reason, "cap");
  // A different run has its own budget.
  assertEquals(registry.latch("run-b", "google_search").ok, true);
  // The default cap matches the documented budget.
  assertEquals(SERVER_TOOL_LATCH_CAP_PER_RUN, 10);
});

Deno.test("provider-server: unknown tool ids fail closed", () => {
  const registry = createServerToolLatchRegistry();
  const r = registry.latch("run-a", "delete_everything");
  assertEquals(r.ok, false);
  assertEquals(registry.latchedToolsFor("run-a").length, 0);
});

Deno.test("provider-server: injection adds the V2 provider tool and preserves function tools", () => {
  const registry = createServerToolLatchRegistry();
  registry.latch("run-a", "google_search");
  const latched = registry.latchedToolsFor("run-a");
  const options = {
    tools: [{ type: "function", name: "search_tools" }],
    prompt: [],
  };
  const injected = injectLatchedServerTools(options, latched);
  assertEquals(injected.tools.length, 2);
  assert(injected.tools.some((t) => t.type === "provider" && t.id === "google.google_search"));
  assert(injected.tools.some((t) => t.type === "function" && t.name === "search_tools"));
  // The untouched case returns the SAME object (no-op, no copy).
  assertEquals(injectLatchedServerTools(options, []), options);
  // Dedupe: injecting twice can never declare the server tool twice.
  const twice = injectLatchedServerTools(injected, latched);
  assertEquals(twice.tools.filter((t) => t.type === "provider").length, 1);
  // A run with no latch injects nothing.
  assertEquals(injectLatchedServerTools(options, registry.latchedToolsFor("run-nope")), options);
});

Deno.test("provider-server: the latch → next-model-call seam (the proxy's exact call pattern)", () => {
  // Mirrors agent.js's guarded(): latch during run, inject at the model call.
  const registry = createServerToolLatchRegistry();
  const calls = [];
  const fakeModelCall = (options) => {
    calls.push(injectLatchedServerTools(options, registry.latchedToolsFor("run-1")));
  };
  fakeModelCall({ tools: [{ type: "function", name: "execute_tool" }] });
  assertEquals(calls[0].tools.filter((t) => t.type === "provider").length, 0);
  registry.latch("run-1", "google_search"); // execute_tool dispatch latches
  fakeModelCall({ tools: [{ type: "function", name: "execute_tool" }] });
  assertEquals(calls[1].tools.filter((t) => t.type === "provider").length, 1);
  assertEquals(calls[1].tools.find((t) => t.type === "provider").name, "google_search");
  // And it STAYS latched for the rest of the run.
  fakeModelCall({ tools: [] });
  assertEquals(calls[2].tools.filter((t) => t.type === "provider").length, 1);
});

Deno.test("provider-server: grounding normalization maps the documented Gemini shape", () => {
  // The shape verified against @ai-sdk/google's getGroundingMetadataSchema.
  const meta = {
    webSearchQueries: ["cap provider tools", "gemini grounding"],
    searchEntryPoint: { renderedContent: "<style>.x{}</style><div>suggestions</div>" },
    groundingChunks: [
      { web: { uri: "https://example.com/a", title: "Example A" } },
      { web: { uri: "https://example.com/b", title: "Example B" } },
    ],
    groundingSupports: [
      {
        segment: { startIndex: 10, endIndex: 42, text: "the grounded claim" },
        groundingChunkIndices: [0, 1],
      },
    ],
  };
  const n = normalizeGeminiGrounding(meta);
  assertEquals(n.queries, ["cap provider tools", "gemini grounding"]);
  assertEquals(n.citations.length, 2);
  assertEquals(n.citations[0].url, "https://example.com/a");
  assertEquals(n.citations[0].startIndex, 10);
  assertEquals(n.citations[0].endIndex, 42);
  assertEquals(n.citations[0].citedText, "the grounded claim");
  assertEquals(n.citations[0].provider, "google");
  assertStringIncludes(n.searchEntryPointHtml, "suggestions");
});

Deno.test("provider-server: chunks without support ranges still surface as sources", () => {
  const n = normalizeGeminiGrounding({
    groundingChunks: [{ web: { uri: "https://example.com/x", title: "X" } }],
  });
  assertEquals(n.citations.length, 1);
  assertEquals(n.citations[0].url, "https://example.com/x");
  assertEquals(n.citations[0].startIndex, undefined);
});

Deno.test("provider-server: normalization never throws on hostile shapes and drops non-http urls", () => {
  for (const hostile of [null, undefined, 42, "x", [], { groundingChunks: "no" }, {
    groundingSupports: [{ segment: null, groundingChunkIndices: [0, 99, -1] }],
    groundingChunks: [{ web: { uri: "javascript:alert(1)" } }, { web: { uri: 7 } }],
  }]) {
    const n = normalizeGeminiGrounding(hostile);
    assertEquals(n.queries.length, 0);
    assert(n.citations.every((c) => /^https:\/\//u.test(c.url)));
  }
});

Deno.test("provider-server: groundingFromProviderMetadata reads providerMetadata.google.groundingMetadata", () => {
  const found = groundingFromProviderMetadata({
    google: {
      groundingMetadata: {
        webSearchQueries: ["q"],
        groundingChunks: [{ web: { uri: "https://a.dev/", title: "A" } }],
      },
    },
  });
  assert(found);
  assertEquals(found.queries, ["q"]);
  // No grounding → null (the proxy's harvest skips it).
  assertEquals(groundingFromProviderMetadata({ google: {} }), null);
  assertEquals(groundingFromProviderMetadata(null), null);
  assertEquals(groundingFromProviderMetadata({ google: { groundingMetadata: {} } }), null);
});

Deno.test("provider-server: records expose the descriptor for a ready gemini agent and gate a non-gemini agent", async () => {
  const registry = createServerToolLatchRegistry();
  const readyRecords = await liveProviderServerToolRecords({
    lane: "gemini-native",
    modelId: "gemini-3.7-flash",
    readSwitches: async () => ({ globalEnabled: true, agentOptIn: true }),
    latchRegistry: registry,
    sourceGeneration: "test-gen",
  });
  assertEquals(readyRecords.length, 1);
  assertEquals(readyRecords[0].descriptorInput.sourceKind, "provider-server");
  assertEquals(readyRecords[0].descriptorInput.availability, "ready");
  assertEquals(readyRecords[0].descriptorInput.name, "provider-server/gemini/google_search");

  const otherLane = await liveProviderServerToolRecords({
    lane: "openai-compatible",
    modelId: "gpt-5.5",
    readSwitches: async () => ({ globalEnabled: true, agentOptIn: true }),
    latchRegistry: registry,
    sourceGeneration: "test-gen",
  });
  assertEquals(otherLane[0].descriptorInput.availability, "owner-action-required");
  // The honest reason rides the descriptor so the model can act on it.
  assertStringIncludes(otherLane[0].descriptorInput.description, "gemini native provider");

  const globalOff = await liveProviderServerToolRecords({
    lane: "gemini-native",
    modelId: "gemini-3.7-flash",
    readSwitches: async () => ({ globalEnabled: false, agentOptIn: true }),
    latchRegistry: registry,
    sourceGeneration: "test-gen",
  });
  assertEquals(globalOff[0].descriptorInput.availability, "disabled");
});

Deno.test("provider-server: execute authorization re-reads the switches live (toggle flip between search and execute fails closed)", async () => {
  const registry = createServerToolLatchRegistry();
  let switches = { globalEnabled: true, agentOptIn: true };
  const records = await liveProviderServerToolRecords({
    lane: "gemini-native",
    modelId: "gemini-3.7-flash",
    readSwitches: async () => switches,
    latchRegistry: registry,
    sourceGeneration: "test-gen",
  });
  const record = records[0];
  // Descriptor said ready (snapshot), then the owner turns the global toggle OFF.
  switches = { globalEnabled: false, agentOptIn: true };
  const denied = await record.authorize({}, {});
  assertEquals(denied.ok, false);
  assertStringIncludes(denied.reason, "Settings");
  // Back on → authorize passes and dispatch latches.
  switches = { globalEnabled: true, agentOptIn: true };
  const allowed = await record.authorize({}, {});
  assertEquals(allowed.ok, true);
  const validated = await record.validateArguments({});
  assertEquals(validated.ok, true);
  const result = await record.dispatch(validated.data, { runId: "run-x" });
  assertEquals(result.ok, true);
  assertEquals(result.activated, "google_search");
  assertEquals(registry.latchedToolsFor("run-x").length, 1);
});

Deno.test("provider-server: dispatch without a run context fails closed", async () => {
  const registry = createServerToolLatchRegistry();
  const records = await liveProviderServerToolRecords({
    lane: "gemini-native",
    modelId: "gemini-3.7-flash",
    readSwitches: async () => ({ globalEnabled: true, agentOptIn: true }),
    latchRegistry: registry,
    sourceGeneration: "test-gen",
  });
  const r = await records[0].dispatch({}, {});
  assertEquals(r.ok, false);
});

Deno.test("provider-server: arguments are rejected (the provider generates the query server-side)", async () => {
  const records = await liveProviderServerToolRecords({
    lane: "gemini-native",
    modelId: "gemini-3.7-flash",
    readSwitches: async () => ({ globalEnabled: true, agentOptIn: true }),
    latchRegistry: createServerToolLatchRegistry(),
    sourceGeneration: "test-gen",
  });
  const bad = await records[0].validateArguments({ query: "injected" });
  assertEquals(bad.ok, false);
  assertEquals(bad.reason, "parse-rejected");
});

Deno.test("provider-server: the descriptor is discoverable through the REAL lazy protocol search", async () => {
  const registry = createServerToolLatchRegistry();
  const protocol = new LazyToolProtocol({
    readSources: async () =>
      await liveProviderServerToolRecords({
        lane: "gemini-native",
        modelId: "gemini-3.7-flash",
        readSwitches: async () => ({ globalEnabled: true, agentOptIn: true }),
        latchRegistry: registry,
        sourceGeneration: "test-gen",
      }),
  });
  // The selection fence requires the full run context (run/task/agent/gen).
  const ctx = { runId: "run-1", taskId: "task-1", agentId: "hub", runGeneration: "1" };
  const found = await protocol.search({ query: "google search" }, ctx);
  assertEquals(found.ok, true);
  const names = (found.results ?? []).map((r) => r.name);
  assert(names.includes("provider-server/gemini/google_search"));
  const listed = await protocol.list({}, ctx);
  assertEquals(listed.ok, true);
  assertEquals(listed.counts.providerServer, 1);
  assertEquals((listed.tools["provider-server"] ?? []).length, 1);
});

Deno.test("provider-server: a non-gemini run sees the descriptor as owner-action-required through the REAL search", async () => {
  const registry = createServerToolLatchRegistry();
  const protocol = new LazyToolProtocol({
    readSources: async () =>
      await liveProviderServerToolRecords({
        lane: "openai-compatible",
        modelId: "gpt-5.5",
        readSwitches: async () => ({ globalEnabled: true, agentOptIn: true }),
        latchRegistry: registry,
        sourceGeneration: "test-gen",
      }),
  });
  const ctx = { runId: "run-1", taskId: "task-1", agentId: "hub", runGeneration: "1" };
  const found = await protocol.search({ query: "google search" }, ctx);
  assertEquals(found.ok, true);
  const row = (found.results ?? []).find((r) => r.name === "provider-server/gemini/google_search");
  assert(row, "descriptor is discoverable even when gated");
  assertEquals(row.availability, "owner-action-required");
});

Deno.test("provider-server: the gemini provider resolves through the NATIVE lane on the default endpoint", async () => {
  const resolved = await resolveModelFromConfig({
    provider: "gemini",
    baseURL: GEMINI_COMPAT_DEFAULT_BASE_URL,
    apiKey: "test-key",
    model: "Gemini 3.7 Flash",
  });
  assertEquals(resolved.providerLane, "gemini-native");
  assertEquals(resolved.providerName, "gemini");
});

Deno.test("provider-server: a CUSTOM gemini base URL (BYO proxy) stays on the compatible adapter", async () => {
  assertEquals(isDefaultGeminiEndpoint("https://my-proxy.example.com/v1"), false);
  const resolved = await resolveModelFromConfig({
    provider: "gemini",
    baseURL: "https://my-proxy.example.com/v1",
    apiKey: "test-key",
    model: "gemini-3.7-flash",
  });
  assertEquals(resolved.providerLane, "openai-compatible");
});

Deno.test("provider-server: source pins — the agent proxy injects latched tools and harvests grounding", async () => {
  const src = await Deno.readTextFile(
    new URL("../extension/lib/agent.js", import.meta.url),
  );
  assertStringIncludes(src, "injectLatchedServerTools");
  assertStringIncludes(src, "latchedToolsFor");
  assertStringIncludes(src, "groundingFromProviderMetadata");
  assertStringIncludes(src, "serverTooling");
});

Deno.test("provider-server: source pins — the service worker wires the records + the settle path", async () => {
  const src = await Deno.readTextFile(
    new URL("../extension/background/service-worker.js", import.meta.url),
  );
  assertStringIncludes(src, "liveProviderServerToolRecords");
  assertStringIncludes(src, "createServerToolLatchRegistry");
  assertStringIncludes(src, "cap:providerServerTools");
  assertStringIncludes(src, "serverToolEvents");
  assertStringIncludes(src, "recordServerToolUsage");
});

Deno.test("provider-server: source pins — the settings toggle + rate card exist", async () => {
  const html = await Deno.readTextFile(
    new URL("../extension/options/options.html", import.meta.url),
  );
  assertStringIncludes(html, "server-tools-enabled");
  assertStringIncludes(html, "$14 per 1,000 searches");
  const js = await Deno.readTextFile(
    new URL("../extension/options/options.js", import.meta.url),
  );
  assertStringIncludes(js, "cap:providerServerTools");
});

Deno.test("provider-server: source pins — usage records the labelled estimate", async () => {
  const src = await Deno.readTextFile(
    new URL("../extension/background/service-worker.js", import.meta.url),
  );
  assertStringIncludes(src, "ESTIMATE");
  const usage = await Deno.readTextFile(
    new URL("../extension/lib/usage.js", import.meta.url),
  );
  assertStringIncludes(usage, "recordServerToolUsage");
  assertStringIncludes(usage, "getServerToolUsage");
});
