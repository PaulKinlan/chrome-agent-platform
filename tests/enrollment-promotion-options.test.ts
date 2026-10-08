import { assert } from "jsr:@std/assert@1";

Deno.test("D2: Settings surfaces inert pending, retry, abandonment, and cleanup without listing a Site Agent", async () => {
  const options = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const start = options.indexOf('boundedSend("agent.pending-cleanup")');
  const end = options.indexOf("// ── Factory reset / Delete all data", start);
  assert(start > 0 && end > start);
  const panel = options.slice(start, end);
  for (const marker of ["pending?.promotions", "promotion pending (tools unavailable)", "Retry promotion",
    "Abandon promotion", "pending?.abandoned", "retryAbandonedCleanup: true", "abandonPending: true", "ownerGesture: true"]) {
    assert(panel.includes(marker), `Settings pending panel must include ${marker}`);
  }
  assert(sw.includes("promotions: await listPendingEnrollmentPromotions()"));
  assert(sw.includes("abandoned: await listAbandonedEnrollmentCleanups()"));
  assert(!sw.slice(sw.indexOf('async "agent.list"('), sw.indexOf('async "agent.get"(')).includes("listPendingEnrollmentPromotions"),
    "pending owners are not model-visible enrolled workers");
});
