// tests/provider-server-tools-anthropic.test.ts — KATs for provider-EXECUTED
// tools (slice 2: Anthropic web_search via the native @ai-sdk/anthropic lane).
//
// The wire shapes asserted here were verified against the installed
// @ai-sdk/anthropic 4.0.45 package source (dist/internal/index.js):
//   - provider-tool entry: { type:"provider", id:"anthropic.web_search_20250305",
//     name:"web_search", args } — prepareTools maps it to the
//     { type:"web_search_20250305", name:"web_search" } wire tool.
//   - stream/doGenerate observations: provider-executed tool-call parts
//     (toolName "web_search", input JSON "{\"query\":...}", providerExecuted:
//     true), tool-result parts (result: web_search_result[]), and source parts
//     (sourceType "url"; inline citations carry providerMetadata.anthropic.
//     citedText). The SDK does NOT surface Anthropic's server_tool_use usage
//     counter, so billing counts one tool-call part per executed search.
// Behavioral REDs against pre-existing seams live in
// provider-server-tools-anthropic-red.test.ts.
// @ts-nocheck — dynamic protocol envelopes, matching the repo's test pattern.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  anthropicAuthoritativeSearchRequests,
  anthropicModelSupportsServerTools,
  createServerGroundingAccumulator,
  createServerToolLatchRegistry,
  injectLatchedServerTools,
  liveProviderServerToolRecords,
  normalizeAnthropicWebSearchPart,
  PROVIDER_SERVER_TOOL_SPECS,
  resolveServerToolAvailability,
  serverToolBillingFor,
  serverToolSpecForProvider,
} from "../extension/lib/provider-server-tools.js";
import { isDefaultAnthropicEndpoint } from "../extension/lib/models/anthropic-native-model.js";
import { resolveModelFromConfig } from "../extension/lib/provider.js";
import { LazyToolProtocol } from "../extension/lib/lazy-tool-protocol.js";

const ANTHROPIC_SPEC = PROVIDER_SERVER_TOOL_SPECS.find((s) => s.provider === "anthropic");

// ── descriptor + cost honesty ────────────────────────────────────────────────

Deno.test("anthropic-server: the descriptor carries the cost card + citation shape", () => {
  assert(ANTHROPIC_SPEC, "the anthropic spec exists");
  assertEquals(ANTHROPIC_SPEC.name, "provider-server/anthropic/web_search");
  assertEquals(ANTHROPIC_SPEC.lane, "anthropic-native");
  assertEquals(ANTHROPIC_SPEC.cost.unit, "per-search-request");
  assertEquals(ANTHROPIC_SPEC.cost.rateUsd, 0.01);
  assertStringIncludes(ANTHROPIC_SPEC.cost.freeTierNote, "$10 per 1,000");
  assertStringIncludes(ANTHROPIC_SPEC.cost.freeTierNote, "invisible to CAP");
  assertEquals(ANTHROPIC_SPEC.v2.id, "anthropic.web_search_20250305");
  assertEquals(ANTHROPIC_SPEC.v2.name, "web_search");
  assertEquals(ANTHROPIC_SPEC.v2.type, "provider");
});

Deno.test("anthropic-server: the spec registry keeps BOTH providers", () => {
  assertEquals(PROVIDER_SERVER_TOOL_SPECS.length, 2);
  assertEquals(serverToolSpecForProvider("gemini")?.toolId, "google_search");
  assertEquals(serverToolSpecForProvider("anthropic")?.toolId, "web_search");
  assertEquals(serverToolSpecForProvider("openai"), null);
});

// ── model + lane gates ───────────────────────────────────────────────────────

Deno.test("anthropic-server: the model gate admits the documented set and fails closed elsewhere", () => {
  assert(anthropicModelSupportsServerTools("claude-sonnet-4-5"));
  assert(anthropicModelSupportsServerTools("claude-opus-4-1"));
  assert(anthropicModelSupportsServerTools("claude-haiku-4-5-20251001"));
  assert(anthropicModelSupportsServerTools("claude-3-7-sonnet-20250219"));
  assert(anthropicModelSupportsServerTools("claude-3-5-sonnet-20241022"));
  assert(anthropicModelSupportsServerTools("claude-3-5-sonnet-latest"));
  assert(anthropicModelSupportsServerTools("claude-3-5-haiku-20241022"));
  // The June-2024 3.5 Sonnet predates server tools; 3.0/3-opus/3-haiku too.
  assert(!anthropicModelSupportsServerTools("claude-3-5-sonnet-20240620"));
  assert(!anthropicModelSupportsServerTools("claude-3-opus-20240229"));
  assert(!anthropicModelSupportsServerTools("claude-3-haiku-20240307"));
  // r1: near-misses must NOT admit (the anchored gate).
  assert(!anthropicModelSupportsServerTools("claude-sonnet-4000"));
  assert(!anthropicModelSupportsServerTools("claude-3-7-sonnet-not-a-model"));
  assert(!anthropicModelSupportsServerTools("claude-3-5-haiku-invalid"));
  assert(!anthropicModelSupportsServerTools("claude-3-5-sonnet-20241023"));
  assert(!anthropicModelSupportsServerTools("claude-3-5-sonnet"));
  assert(!anthropicModelSupportsServerTools("claude-opus-3-9"));
  assert(!anthropicModelSupportsServerTools("claude-sonnet-4-beta"));
  assert(!anthropicModelSupportsServerTools("gemini-3.7-flash"));
  assert(!anthropicModelSupportsServerTools(""));
  assert(!anthropicModelSupportsServerTools(null));
  // Documented forms still admit.
  assert(anthropicModelSupportsServerTools("claude-sonnet-4"));
  assert(anthropicModelSupportsServerTools("claude-opus-4-20250514"));
  assert(anthropicModelSupportsServerTools("claude-3-7-sonnet-latest"));
  assert(anthropicModelSupportsServerTools("claude-3-5-haiku-latest"));
});

Deno.test("anthropic-server: availability gates on lane + model + both opt-ins, fail closed", () => {
  const ready = resolveServerToolAvailability({
    spec: ANTHROPIC_SPEC, lane: "anthropic-native", modelId: "claude-sonnet-4-5",
    globalEnabled: true, agentOptIn: true,
  });
  assertEquals(ready.availability, "ready");
  // The OpenAI-compatible shim cannot carry server tools (same honesty as Gemini).
  assertEquals(resolveServerToolAvailability({
    spec: ANTHROPIC_SPEC, lane: "openai-compatible", modelId: "claude-sonnet-4-5",
    globalEnabled: true, agentOptIn: true,
  }).availability, "owner-action-required");
  const wrongModel = resolveServerToolAvailability({
    spec: ANTHROPIC_SPEC, lane: "anthropic-native", modelId: "claude-3-opus-20240229",
    globalEnabled: true, agentOptIn: true,
  });
  assertEquals(wrongModel.availability, "owner-action-required");
  assertStringIncludes(wrongModel.reason, "claude-3-opus-20240229");
  assertEquals(resolveServerToolAvailability({
    spec: ANTHROPIC_SPEC, lane: "anthropic-native", modelId: "claude-sonnet-4-5",
    globalEnabled: false, agentOptIn: true,
  }).availability, "disabled");
  assertEquals(resolveServerToolAvailability({
    spec: ANTHROPIC_SPEC, lane: "anthropic-native", modelId: "claude-sonnet-4-5",
    globalEnabled: true, agentOptIn: false,
  }).availability, "owner-action-required");
});

// ── latch + injection (the execution-as-declaration contract) ───────────────

Deno.test("anthropic-server: latch + injection declare the exact V2 provider-tool entry", () => {
  const registry = createServerToolLatchRegistry();
  const latched = registry.latch("run-a", "web_search");
  assertEquals(latched.ok, true);
  assertEquals(latched.alreadyActive, false);
  const tools = registry.latchedToolsFor("run-a");
  assertEquals(tools.length, 1);
  assertEquals(tools[0], {
    type: "provider",
    id: "anthropic.web_search_20250305",
    name: "web_search",
    args: {},
  });
  const options = injectLatchedServerTools(
    { tools: [{ type: "function", name: "execute_tool" }] }, tools, true);
  assertEquals(options.tools.filter((t) => t.type === "provider").length, 1);
  // Revocation at the boundary: authorized=false injects nothing.
  const revoked = injectLatchedServerTools({ tools: [] }, tools, false);
  assertEquals(revoked.tools.length, 0);
  // Double-injection dedupes by provider-tool id.
  const twice = injectLatchedServerTools(options, tools, true);
  assertEquals(twice.tools.filter((t) => t.type === "provider").length, 1);
});

Deno.test("anthropic-server: both providers can latch on one run and stay distinct", () => {
  const registry = createServerToolLatchRegistry();
  assertEquals(registry.latch("run-b", "google_search").ok, true);
  assertEquals(registry.latch("run-b", "web_search").ok, true);
  const ids = registry.latchedToolsFor("run-b").map((t) => t.id).sort();
  assertEquals(ids, ["anthropic.web_search_20250305", "google.google_search"]);
  assertEquals(registry.latchCount("run-b"), 2);
});

// ── part normalization (the harvest seam) ────────────────────────────────────

const SEARCH_CALL = {
  type: "tool-call",
  toolCallId: "srvtoolu_01",
  toolName: "web_search",
  input: JSON.stringify({ query: "chrome agent platform news" }),
  providerExecuted: true,
};

Deno.test("anthropic-server: a provider-executed web_search tool-call counts ONE billed request", () => {
  const fragment = normalizeAnthropicWebSearchPart(SEARCH_CALL);
  assert(fragment);
  assertEquals(fragment.provider, "anthropic");
  assertEquals(fragment.rawQueryCount, 1);
  assertEquals(fragment.queries, ["chrome agent platform news"]);
  assertEquals(fragment.citations.length, 0);
});

Deno.test("anthropic-server: a search request with unusable input still bills one occurrence", () => {
  for (const input of ["not json", "{}", JSON.stringify({ query: "  " }), 42, undefined]) {
    const fragment = normalizeAnthropicWebSearchPart({ ...SEARCH_CALL, input });
    assert(fragment, `input ${String(input)} still yields a fragment`);
    assertEquals(fragment.rawQueryCount, 1);
    assertEquals(fragment.queries.length, 0);
  }
});

Deno.test("anthropic-server: client-side tool-calls and other server tools are NOT harvested", () => {
  assertEquals(normalizeAnthropicWebSearchPart({ ...SEARCH_CALL, providerExecuted: false }), null);
  assertEquals(normalizeAnthropicWebSearchPart({ ...SEARCH_CALL, providerExecuted: undefined }), null);
  assertEquals(normalizeAnthropicWebSearchPart({ ...SEARCH_CALL, toolName: "bash" }), null);
  assertEquals(normalizeAnthropicWebSearchPart({ ...SEARCH_CALL, toolName: "web_fetch" }), null);
  assertEquals(normalizeAnthropicWebSearchPart({ type: "text-delta", text: "hello" }), null);
  assertEquals(normalizeAnthropicWebSearchPart(null), null);
  assertEquals(normalizeAnthropicWebSearchPart("tool-call"), null);
  assertEquals(normalizeAnthropicWebSearchPart({ type: "tool-call" }), null);
});

Deno.test("anthropic-server: source parts become citations (inline when citedText present), https only", () => {
  const inline = normalizeAnthropicWebSearchPart({
    type: "source",
    sourceType: "url",
    id: "src-1",
    url: "https://example.com/story",
    title: "A story",
    providerMetadata: { anthropic: { citedText: "the cited claim", encryptedIndex: "enc" } },
  });
  assert(inline);
  assertEquals(inline.provider, "anthropic");
  assertEquals(inline.rawQueryCount, 0);
  assertEquals(inline.citations.length, 1);
  assertEquals(inline.citations[0].url, "https://example.com/story");
  assertEquals(inline.citations[0].title, "A story");
  assertEquals(inline.citations[0].citedText, "the cited claim");
  // A bare result source (no citedText) still surfaces as a source citation.
  const bare = normalizeAnthropicWebSearchPart({
    type: "source", sourceType: "url", id: "src-2", url: "https://example.com/other", title: "Other",
  });
  assertEquals(bare?.citations[0]?.citedText, undefined);
  // Non-https sources are dropped; document sources are not web citations.
  assertEquals(normalizeAnthropicWebSearchPart({
    type: "source", sourceType: "url", id: "src-3", url: "http://example.com/x", title: "x",
  }), null);
  assertEquals(normalizeAnthropicWebSearchPart({
    type: "source", sourceType: "document", id: "src-4", url: "https://example.com/d", title: "d",
  }), null);
});

Deno.test("anthropic-server: web_search tool-results surface unindexed source citations", () => {
  const fragment = normalizeAnthropicWebSearchPart({
    type: "tool-result",
    toolCallId: "srvtoolu_01",
    toolName: "web_search",
    result: [
      { type: "web_search_result", url: "https://example.com/a", title: "A", pageAge: null, encryptedContent: "e1" },
      { type: "web_search_result", url: "http://insecure.example/b", title: "B", pageAge: null, encryptedContent: "e2" },
      { type: "web_search_result_error", errorCode: "max_uses_exceeded" },
    ],
  });
  assert(fragment);
  assertEquals(fragment.citations.length, 1);
  assertEquals(fragment.citations[0].url, "https://example.com/a");
  // Other tools' results and empty results are ignored.
  assertEquals(normalizeAnthropicWebSearchPart({ type: "tool-result", toolName: "bash", result: [] }), null);
  assertEquals(normalizeAnthropicWebSearchPart({ type: "tool-result", toolName: "web_search", result: [] }), null);
});

// ── accumulation + billing ──────────────────────────────────────────────────

Deno.test("anthropic-server: the accumulator bills every executed request and tags the provider", () => {
  const acc = createServerGroundingAccumulator();
  acc.add(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  acc.add(normalizeAnthropicWebSearchPart(SEARCH_CALL)); // a second search on a later model call
  acc.add(normalizeAnthropicWebSearchPart({
    type: "source", sourceType: "url", id: "s1", url: "https://example.com/s", title: "S",
    providerMetadata: { anthropic: { citedText: "claim" } },
  }));
  const snap = acc.snapshot();
  assertEquals(snap.queryOccurrenceCount, 2);
  assertEquals(snap.provider, "anthropic");
  assertEquals(snap.providers, ["anthropic"]);
  assertEquals(snap.displayQueries, ["chrome agent platform news"]); // presentation dedupes
  assertEquals(snap.citations.length, 1);
});

Deno.test("anthropic-server: billing is spec-driven and honestly labelled", () => {
  const billing = serverToolBillingFor(ANTHROPIC_SPEC, 3, { authoritative: true });
  assertEquals(billing.provider, "anthropic");
  assertEquals(billing.tool, "web_search");
  assertEquals(billing.queries, 3);
  assertEquals(billing.estimatedUsd, 0.03);
  assertStringIncludes(billing.note, "(Anthropic, provider-reported count)");
  assertStringIncludes(billing.note, "ESTIMATE");
  assertStringIncludes(billing.note, "$10 per 1,000 searches");
  // r1 (P1-3): the persisted ledger note carries the re-verification caveat.
  assertStringIncludes(billing.note, "pricing not re-verified against live documentation");
  const observed = serverToolBillingFor(ANTHROPIC_SPEC, 2);
  assertStringIncludes(observed.note, "(Anthropic, counted from the stream)");
  // The Gemini line stays deterministic (provenance suffix is the only r1 change).
  const gemini = serverToolBillingFor(serverToolSpecForProvider("gemini"), 2);
  assertEquals(gemini.provider, "gemini");
  assertEquals(gemini.tool, "google_search");
  assertEquals(gemini.estimatedUsd, 0.028);
  assertEquals(
    gemini.note,
    "Web search: 2 calls (Gemini, counted from the stream) — est. $0.0280 (ESTIMATE — the 5,000/mo free tier is metered provider-side and invisible to CAP)",
  );
});

// ── the AUTHORITATIVE usage counter (r1: bills the provider's own count) ────

Deno.test("anthropic-server: the provider usage object yields the authoritative billable count", () => {
  // The shape verified in @ai-sdk/anthropic 4.0.45: BOTH the stream finish
  // part and the doGenerate result expose providerMetadata.anthropic.usage as
  // the raw response usage (z.looseObject — server_tool_use survives).
  for (const metadata of [
    { anthropic: { usage: { server_tool_use: { web_search_requests: 5 }, input_tokens: 10 } } },
    { anthropic: { usage: { server_tool_use: { web_search_requests: 0 } } } },
  ]) {
    const fragment = anthropicAuthoritativeSearchRequests(metadata);
    assert(fragment);
    assertEquals(fragment.provider, "anthropic");
    assertEquals(typeof fragment.authoritativeSearchRequests, "number");
    assertEquals(fragment.rawQueryCount, 0, "authoritative fragments never add observed occurrences");
  }
  // Absent / hostile shapes read as nothing (never guessed).
  for (const bad of [
    null, {}, { anthropic: {} }, { anthropic: { usage: {} } },
    { anthropic: { usage: { server_tool_use: {} } } },
    { anthropic: { usage: { server_tool_use: { web_search_requests: -1 } } } },
    { anthropic: { usage: { server_tool_use: { web_search_requests: 1.5 } } } },
    { anthropic: { usage: { server_tool_use: { web_search_requests: "5" } } } },
    { google: { groundingMetadata: { webSearchQueries: ["q"] } } },
  ]) {
    assertEquals(anthropicAuthoritativeSearchRequests(bad), null);
  }
});

// ── the live records path (descriptor + dispatch through the real protocol) ──

Deno.test("anthropic-server: the descriptor is discoverable and latches through the REAL LazyToolProtocol", async () => {
  const registry = createServerToolLatchRegistry();
  const protocol = new LazyToolProtocol({
    readSources: async () =>
      await liveProviderServerToolRecords({
        lane: "anthropic-native",
        modelId: "claude-sonnet-4-5",
        readSwitches: async () => ({ globalEnabled: true, agentOptIn: true }),
        latchRegistry: registry,
        sourceGeneration: "test-gen",
      }),
  });
  const ctx = { runId: "run-l", taskId: "task-1", agentId: "hub", runGeneration: "1" };
  const found = await protocol.search({ query: "web search" }, ctx);
  assertEquals(found.ok, true);
  const row = (found.results ?? []).find((r) => r.name === "provider-server/anthropic/web_search");
  assert(row, "the anthropic descriptor is discoverable");
  assertEquals(row.availability, "ready");
  const executed = await protocol.execute({ selectionRef: row.selectionRef, arguments: {} }, ctx);
  assertEquals(executed.ok, true);
  assertEquals(registry.latchedToolsFor("run-l").map((t) => t.id), ["anthropic.web_search_20250305"]);
});

Deno.test("anthropic-server: a gemini-lane run sees the anthropic descriptor as owner-action-required", async () => {
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
  const ctx = { runId: "run-g", taskId: "task-1", agentId: "hub", runGeneration: "1" };
  const found = await protocol.search({ query: "web search" }, ctx);
  const row = (found.results ?? []).find((r) => r.name === "provider-server/anthropic/web_search");
  assert(row, "descriptor is discoverable even when gated");
  assertEquals(row.availability, "owner-action-required");
  const executed = await protocol.execute({ selectionRef: row.selectionRef, arguments: {} }, ctx);
  assertEquals(executed.ok, false, "dispatch on the wrong lane fails closed");
  assertEquals(registry.latchedToolsFor("run-g").length, 0);
});

// ── native lane routing ──────────────────────────────────────────────────────

Deno.test("anthropic-server: endpoint classification mirrors the Gemini rule", () => {
  assert(isDefaultAnthropicEndpoint(""));
  assert(isDefaultAnthropicEndpoint("https://api.anthropic.com/v1"));
  assert(isDefaultAnthropicEndpoint("https://api.anthropic.com/v1/"));
  assert(!isDefaultAnthropicEndpoint("https://proxy.example.com/v1"));
});

Deno.test("anthropic-server: the default anthropic config resolves through the NATIVE lane", async () => {
  const resolved = await resolveModelFromConfig({
    provider: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    apiKey: "test-key",
    model: "claude-sonnet-4-5",
  });
  assertEquals(resolved.providerLane, "anthropic-native");
  assertEquals(resolved.providerName, "anthropic");
  assertEquals(resolved.modelId, "claude-sonnet-4-5");
  assert(typeof resolved.model?.doStream === "function", "a real wrapped LanguageModel comes back");
});

Deno.test("anthropic-server: a custom anthropic base URL honestly stays on the compatible adapter", async () => {
  const resolved = await resolveModelFromConfig({
    provider: "anthropic",
    baseURL: "https://proxy.example.com/v1",
    apiKey: "test-key",
    model: "claude-sonnet-4-5",
  });
  assertEquals(resolved.providerLane, "openai-compatible");
});
