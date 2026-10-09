import { assert } from "jsr:@std/assert@1";

Deno.test("3p3e.3: attached audit uses SW browser/run/reset principal, not enrolled append gate", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const start = sw.indexOf("const ephemeralSiteToolAuditPrincipal = createEphemeralSiteToolAuditPrincipal({");
  const end = sw.indexOf("\n});", start);
  assert(start > 0 && end > start, "SW must own a distinct ephemeral audit principal");
  const body = sw.slice(start, end);
  for (const part of [
    "consentStore: ephemeralSiteToolConsentStore", "attestCurrentAttachedWebmcpTab", "listKnownWebmcpOrigins()",
    "listOrigins()", "activeExecutions.has(runId)", "appendSiteToolAudit", "siteToolProfileEpoch", "siteToolResetting",
  ]) assert(body.includes(part), `ephemeral principal must bind ${part}`);
  assert(!body.includes("appendRequiredSiteToolAudit"), "enrolled Q23 audit must keep its original gate");
});
