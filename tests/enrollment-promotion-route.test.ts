import { assert } from "jsr:@std/assert@1";

Deno.test("D2: owner route writes pending, verifies envelope, then publishes authority before registration", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const from = sw.indexOf('async "agent.enroll-origin"(');
  const until = sw.indexOf('async "agent.delete"(', from);
  assert(from > 0 && until > from);
  const owner = sw.slice(from, until);
  const stage = owner.indexOf("prepareEnrollmentPromotion(canonical, records");
  const verify = owner.indexOf("completeEnrollmentPromotion(canonical, prepared.gen", stage);
  const marker = owner.indexOf('siteMemory(canonical).setTrusted("enrolled"', verify);
  const register = owner.indexOf("ensureOriginScriptsRegistered(canonical)", marker);
  assert(stage > 0 && verify > stage && marker > verify && register > marker);
  assert(!owner.includes("await enrollOrigin(canonical)"), "owner route must never publish immediate enrolled authority");
  assert(owner.includes("ephemeralSiteToolConsentStore.withPromotionForOrigin"));
  assert(owner.includes("abandonEnrollmentPromotion(canonical, pending.gen)"));
});

Deno.test("D2: boot always attempts pending recovery and legacy create refuses live attached runs", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes("reconcileEnrollmentPromotionsOnBoot().catch"));
  const start = sw.indexOf('async "agent.create"(');
  const end = sw.indexOf('async "agent.enroll-origin"(', start);
  assert(start > 0 && end > start && sw.slice(start, end).includes("ephemeralSiteToolConsentStore.hasLiveOrigin(canonical)"));
});
