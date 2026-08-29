// @ts-nocheck — parent 49a21e5d intentionally lacks rawQueryCount; RED must
// reach the runtime billing assertion.
import { assertEquals } from "jsr:@std/assert@1";
import {
  createServerGroundingAccumulator,
  normalizeGeminiGrounding,
} from "../extension/lib/provider-server-tools.js";

Deno.test("provider-server revision 3: normalization preserves billing count above retained-text cap", () => {
  const providerQueries = Array.from({ length: 40 }, (_, i) => `query ${i}`);
  const normalized = normalizeGeminiGrounding({ webSearchQueries: providerQueries });
  const accumulator = createServerGroundingAccumulator();
  accumulator.add(normalized);
  const snapshot = accumulator.snapshot();
  assertEquals(normalized.queries.length, 32, "retained query text stays bounded");
  assertEquals(normalized.rawQueryCount, 40, "normalization exposes every valid provider occurrence");
  assertEquals(snapshot.queryOccurrenceCount, 40, "billing consumes the raw occurrence count");
});
