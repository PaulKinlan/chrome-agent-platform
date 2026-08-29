// Revision-1 tests for slice 2 (authoritative counter, anchored gate, pricing
// caveat), UPDATED in r2 to the per-call reconciliation mechanism (the r1
// run-global flip underbilled mixed runs — see revision2 REDs).
// @ts-nocheck — dynamic shapes, matching the repo's test pattern.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  anthropicModelSupportsServerTools,
  createAnthropicCallReconciler,
  createServerGroundingAccumulator,
  normalizeAnthropicWebSearchPart,
  PROVIDER_SERVER_TOOL_SPECS,
  serverToolBillingFor,
} from "../extension/lib/provider-server-tools.js";

const ANTHROPIC_SPEC = PROVIDER_SERVER_TOOL_SPECS.find((s) => s.provider === "anthropic");
const SEARCH_CALL = {
  type: "tool-call",
  toolCallId: "srvtoolu_01",
  toolName: "web_search",
  input: JSON.stringify({ query: "q" }),
  providerExecuted: true,
};

Deno.test("r1: within ONE call the provider counter supersedes observed parts (never summed)", () => {
  const call = createAnthropicCallReconciler();
  call.addPart(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  call.addPart(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  call.setAuthoritative({ authoritativeSearchRequests: 5 });
  const fragment = call.flush();
  assertEquals(fragment.rawQueryCount, 5, "provider count wins within the call — 5, not 5+2");
  assertEquals(fragment.reconciled, true);
  assertEquals(fragment.authoritativeCount, 5);
  assertEquals(fragment.observedCount, 2);
  const acc = createServerGroundingAccumulator();
  acc.add(fragment);
  assertEquals(acc.snapshot().queryOccurrenceCount, 5);
});

Deno.test("r1: observed occurrences are the billing fallback when a call reports no counter", () => {
  const call = createAnthropicCallReconciler();
  call.addPart(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  call.addPart(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  const fragment = call.flush();
  assertEquals(fragment.rawQueryCount, 2);
  assertEquals(fragment.authoritativeCount, null);
  const acc = createServerGroundingAccumulator();
  acc.add(fragment);
  assertEquals(acc.snapshot().queryOccurrenceCount, 2);
  assertEquals(acc.snapshot().observedBilled, 2);
  assertEquals(acc.snapshot().authoritativeBilled, 0);
});

Deno.test("r1: an authoritative ZERO is honored (searches declared but none executed bill nothing)", () => {
  const call = createAnthropicCallReconciler();
  call.addPart(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  call.setAuthoritative({ authoritativeSearchRequests: 0 });
  const fragment = call.flush();
  assertEquals(fragment.rawQueryCount, 0, "provider says zero billable — the observed part is not billed");
  const acc = createServerGroundingAccumulator();
  acc.add(fragment);
  // reconciled counts are verbatim — the max(raw, retained) rule must NOT
  // resurrect the observed query.
  assertEquals(acc.snapshot().queryOccurrenceCount, 0);
});

Deno.test("r1: per-call bills SUM across a run's model calls", () => {
  const acc = createServerGroundingAccumulator();
  for (const n of [2, 3]) {
    const call = createAnthropicCallReconciler();
    call.setAuthoritative({ authoritativeSearchRequests: n });
    acc.add(call.flush());
  }
  assertEquals(acc.snapshot().queryOccurrenceCount, 5);
  assertEquals(acc.snapshot().authoritativeBilled, 5);
});

Deno.test("r1: hostile authoritative shapes are ignored, not trusted", () => {
  const call = createAnthropicCallReconciler();
  for (const bad of [-1, 1.5, "3", NaN, Infinity, null, undefined, {}]) {
    call.setAuthoritative({ authoritativeSearchRequests: bad });
  }
  call.setAuthoritative(null);
  call.addPart(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  assertEquals(call.flush().rawQueryCount, 1, "no valid counter — observed fallback");
});

Deno.test("r1: the model gate is anchored — near-miss ids fail closed", () => {
  assert(!anthropicModelSupportsServerTools("claude-sonnet-4000"));
  assert(!anthropicModelSupportsServerTools("claude-3-7-sonnet-not-a-model"));
  assert(!anthropicModelSupportsServerTools("claude-3-5-haiku-invalid"));
  assert(!anthropicModelSupportsServerTools("claude-3-5-sonnet-20241023"));
  assert(!anthropicModelSupportsServerTools("claude-sonnet-4-beta"));
});

Deno.test("r1: the persisted billing note carries the pricing re-verification caveat", () => {
  const billing = serverToolBillingFor(ANTHROPIC_SPEC, 1, { provenance: "provider-reported count" });
  assertStringIncludes(billing.note, "pricing not re-verified against live documentation");
  // And the descriptor's cost card carries it too.
  assertStringIncludes(ANTHROPIC_SPEC.cost.freeTierNote, "pricing not re-verified");
});

Deno.test("r1: an untouched call reconciles to nothing and is never emitted", () => {
  const call = createAnthropicCallReconciler();
  assertEquals(call.seen, false);
  call.addPart(null);
  assertEquals(call.seen, false);
  call.addPart(normalizeAnthropicWebSearchPart(SEARCH_CALL));
  assertEquals(call.seen, true);
});
