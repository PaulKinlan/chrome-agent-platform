// Revision-1 falsification tests for slice 2 (the BLOCK findings): imports
// ONLY seams that already exist on candidate b294cabe, so each test FAILS ON
// THE R0 CANDIDATE for a behavioral reason (no authoritative counter, no
// billed/observed split, unanchored model gate, no pricing caveat).
// @ts-nocheck — dynamic shapes, matching the repo's test pattern.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  anthropicModelSupportsServerTools,
  createServerGroundingAccumulator,
  normalizeAnthropicWebSearchPart,
  PROVIDER_SERVER_TOOL_SPECS,
  serverToolBillingFor,
  serverToolSpecForProvider,
} from "../extension/lib/provider-server-tools.js";

const ANTHROPIC_SPEC = PROVIDER_SERVER_TOOL_SPECS.find((s) => s.provider === "anthropic");
const SEARCH_CALL = {
  type: "tool-call",
  toolCallId: "srvtoolu_01",
  toolName: "web_search",
  input: JSON.stringify({ query: "q" }),
  providerExecuted: true,
};

Deno.test("r1 RED: the accumulator exposes the authoritative counter and bills it over observed parts", () => {
  const acc = createServerGroundingAccumulator();
  // Two searches observed as stream parts…
  acc.add(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  acc.add(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  // …but the provider's OWN usage object says FIVE billable requests happened
  // (the SDK preserves server_tool_use.web_search_requests via z.looseObject).
  acc.add({
    provider: "anthropic",
    queries: [],
    rawQueryCount: 0,
    citations: [],
    authoritativeSearchRequests: 5,
  });
  const snap = acc.snapshot();
  assertEquals(snap.authoritativeSearchRequests, 5, "authoritative sum rides the snapshot");
  assertEquals(snap.queryOccurrenceCount, 2, "observed occurrences stay tracked separately");
  assertEquals(snap.billedSearchRequests, 5, "billing takes the provider count — never the sum (5+2=7 would double-count)");
});

Deno.test("r1 RED: observed occurrences are the billing fallback when the provider reports nothing", () => {
  const acc = createServerGroundingAccumulator();
  acc.add(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  acc.add(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  const snap = acc.snapshot();
  assertEquals(snap.authoritativeSearchRequests, null);
  assertEquals(snap.billedSearchRequests, 2);
});

Deno.test("r1 RED: an authoritative ZERO is honored (searches declared but none executed bill nothing)", () => {
  const acc = createServerGroundingAccumulator();
  acc.add(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  acc.add({ provider: "anthropic", queries: [], rawQueryCount: 0, citations: [], authoritativeSearchRequests: 0 });
  const snap = acc.snapshot();
  assertEquals(snap.authoritativeSearchRequests, 0);
  assertEquals(snap.billedSearchRequests, 0, "provider says zero billable — the observed part is not billed");
});

Deno.test("r1 RED: authoritative counts SUM across a run's model calls", () => {
  const acc = createServerGroundingAccumulator();
  acc.add({ provider: "anthropic", queries: [], rawQueryCount: 0, citations: [], authoritativeSearchRequests: 2 });
  acc.add({ provider: "anthropic", queries: [], rawQueryCount: 0, citations: [], authoritativeSearchRequests: 3 });
  assertEquals(acc.snapshot().billedSearchRequests, 5);
});

Deno.test("r1 RED: hostile authoritative shapes are ignored, not trusted", () => {
  const acc = createServerGroundingAccumulator();
  for (const bad of [-1, 1.5, "3", NaN, Infinity, null, undefined]) {
    acc.add({ provider: "anthropic", queries: [], rawQueryCount: 0, citations: [], authoritativeSearchRequests: bad });
  }
  assertEquals(acc.snapshot().authoritativeSearchRequests, null);
});

Deno.test("r1 RED: the model gate is anchored — near-miss ids fail closed", () => {
  assert(!anthropicModelSupportsServerTools("claude-sonnet-4000"));
  assert(!anthropicModelSupportsServerTools("claude-3-7-sonnet-not-a-model"));
  assert(!anthropicModelSupportsServerTools("claude-3-5-haiku-invalid"));
  assert(!anthropicModelSupportsServerTools("claude-3-5-sonnet-20241023"));
  assert(!anthropicModelSupportsServerTools("claude-sonnet-4-beta"));
});

Deno.test("r1 RED: the persisted billing note carries the pricing re-verification caveat", () => {
  const billing = serverToolBillingFor(ANTHROPIC_SPEC, 1, { authoritative: true });
  assertStringIncludes(billing.note, "pricing not re-verified against live documentation");
  // And the descriptor's cost card carries it too.
  assertStringIncludes(ANTHROPIC_SPEC.cost.freeTierNote, "pricing not re-verified");
});
