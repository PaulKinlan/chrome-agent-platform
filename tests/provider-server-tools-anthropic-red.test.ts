// Behavioral falsification subset for slice 2: imports ONLY seams that already
// existed on base 9518105e, so the base reaches assertions instead of failing
// at import. Each test FAILS ON THE BASE for a behavioral reason (the base
// routes anthropic through the compatible adapter and its accumulator has no
// provider tagging), not because an import is missing.
// @ts-nocheck — dynamic config shapes, matching the repo's test pattern.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createServerGroundingAccumulator } from "../extension/lib/provider-server-tools.js";
import { resolveModelFromConfig } from "../extension/lib/provider.js";

Deno.test("behavioral RED (slice 2): the default anthropic config resolves through the NATIVE lane", async () => {
  // Base behavior: provider "anthropic" always resolves through the
  // OpenAI-compatible adapter (providerLane "openai-compatible"), which cannot
  // carry provider-defined server tools — the slice-2 native routing is absent.
  const resolved = await resolveModelFromConfig({
    provider: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    apiKey: "test-key",
    model: "claude-sonnet-4-5",
  });
  assertEquals(resolved.providerLane, "anthropic-native");
});

Deno.test("behavioral RED (slice 2): the grounding accumulator tags the feeding provider", async () => {
  // Base behavior: snapshot() has no provider/providers fields, so the settle
  // path cannot bill per provider and hard-codes Gemini.
  const acc = createServerGroundingAccumulator();
  acc.add({ provider: "anthropic", queries: ["q"], rawQueryCount: 1, citations: [] });
  const snap = acc.snapshot();
  assertEquals(snap.provider, "anthropic");
  assertEquals(snap.providers, ["anthropic"]);
});

Deno.test("behavioral RED (slice 2): the Gemini normalizer tags its own provider", async () => {
  // Base behavior: normalizeGeminiGrounding output carries no provider field,
  // so multi-provider accumulation cannot attribute fragments.
  const { normalizeGeminiGrounding } = await import("../extension/lib/provider-server-tools.js");
  const normalized = normalizeGeminiGrounding({ webSearchQueries: ["q"] });
  assert(normalized);
  assertEquals(normalized.provider, "gemini");
});
