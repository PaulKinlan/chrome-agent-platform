// @ts-nocheck — the parent intentionally lacks queryOccurrenceCount; RED must
// reach the runtime assertion instead of stopping in type-checking.
// Revision-2 behavioral falsification against parent ec37b49e. The accumulator
// seam already exists there, so the parent reaches this billing assertion.
import { assertEquals } from "jsr:@std/assert@1";
import { createServerGroundingAccumulator } from "../extension/lib/provider-server-tools.js";

Deno.test("provider-server revision 2: occurrence billing survives bounded query-text retention", () => {
  const accumulator = createServerGroundingAccumulator({ maxQueryOccurrences: 2 });
  accumulator.add({ queries: ["one", "two", "three"], citations: [] });
  const snapshot = accumulator.snapshot();
  assertEquals(snapshot.queries, ["one", "two"], "retained query text stays bounded");
  assertEquals(snapshot.queryOccurrenceCount, 3, "billing counts every occurrence beyond the text cap");
});
