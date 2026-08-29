// Revision-2 falsification tests for slice 2 (the round-2 BLOCK findings):
// imports ONLY seams that already exist on the r1 candidate 6cb2c7c0, so each
// test FAILS ON R1 for a behavioral reason (run-global billing flip, Gemini
// provenance regression), not because an import is missing.
// @ts-nocheck — dynamic shapes, matching the repo's test pattern.

import { assertEquals } from "jsr:@std/assert@1";
import {
  createServerGroundingAccumulator,
  normalizeAnthropicWebSearchPart,
  PROVIDER_SERVER_TOOL_SPECS,
  serverToolBillingFor,
  serverToolSpecForProvider,
} from "../extension/lib/provider-server-tools.js";

const SEARCH_CALL = {
  type: "tool-call",
  toolCallId: "srvtoolu_01",
  toolName: "web_search",
  input: JSON.stringify({ query: "q" }),
  providerExecuted: true,
};

Deno.test("r2 RED: raw authoritative fragments no longer flip run-global billing", () => {
  // On r1 the accumulator flipped the WHOLE run to the authoritative sum the
  // moment any authoritative fragment arrived. r2 moves reconciliation to the
  // per-call reconciler; a bare authoritative fragment (no reconciled flag)
  // contributes NOTHING to the count — the observed parts still bill.
  const acc = createServerGroundingAccumulator();
  acc.add(normalizeAnthropicWebSearchPart(SEARCH_CALL)); // observed: 1
  acc.add(normalizeAnthropicWebSearchPart(SEARCH_CALL)); // observed: 2
  acc.add({ provider: "anthropic", queries: [], rawQueryCount: 0, citations: [], authoritativeSearchRequests: 3 });
  const snap = acc.snapshot();
  assertEquals(snap.queryOccurrenceCount, 2, "r1 flipped the whole run to 3 (run-global); r2 ignores unreconciled fragments");
  // And the r1 snapshot fields are gone (provenance is a billed-split now).
  assertEquals("billedSearchRequests" in snap, false);
  assertEquals("authoritativeSearchRequests" in snap, false);
});

Deno.test("r2 RED: the Gemini ledger note is byte-identical to slice 1", () => {
  // On r1 the provenance suffix was appended to EVERY provider's note.
  const gemini = serverToolBillingFor(serverToolSpecForProvider("gemini"), 2);
  assertEquals(
    gemini.note,
    "Web search: 2 calls (Gemini) — est. $0.0280 (ESTIMATE — the 5,000/mo free tier is metered provider-side and invisible to CAP)",
  );
});

Deno.test("r2 RED: the spec catalogue is intact for both providers", () => {
  assertEquals(PROVIDER_SERVER_TOOL_SPECS.length, 2);
});
