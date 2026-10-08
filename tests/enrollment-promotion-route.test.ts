import { assert } from "jsr:@std/assert@1";

Deno.test("D2: owner route delegates Chrome host/script proof BEFORE registry pending clear", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const tools = await Deno.readTextFile(new URL("../extension/lib/tools.js", import.meta.url));
  const from = sw.indexOf('async "agent.enroll-origin"(');
  const until = sw.indexOf('async "agent.delete"(', from);
  assert(from > 0 && until > from);
  const owner = sw.slice(from, until);
  assert(owner.includes("prepareEnrollmentPromotion(canonical, records"));
  assert(owner.includes("beforeFlip: verifyOwnerPromotionPreconditions"));
  assert(!owner.includes("await enrollOrigin(canonical)"));
  assert(!owner.includes("await ensureOriginScriptsRegistered(canonical)"),
    "registration after the durable flip would create an orphaned authority window");
  assert(owner.includes("ephemeralSiteToolConsentStore.withPromotionForOrigin"));
  assert(owner.includes("abandonEnrollmentPromotion(canonical, pending.gen)"));

  const pre = sw.slice(sw.indexOf("async function verifyOwnerPromotionPreconditions("),
    sw.indexOf("// A pending Q1 promotion", sw.indexOf("async function verifyOwnerPromotionPreconditions(")));
  assert(pre.includes("ensureOriginScriptsRegistered(origin)"));
  assert(pre.includes('permissions: ["scripting"]'));
  assert(pre.includes('siteMemory(origin).setTrusted("enrolled"'));
  const txn = tools.slice(tools.indexOf("export async function completeEnrollmentPromotion("),
    tools.indexOf("export async function listPendingEnrollmentPromotions("));
  const envelope = txn.indexOf("verifyPromotedSiteToolConsents(");
  const chromeProof = txn.indexOf("await beforeFlip(canonical)", envelope);
  const clear = txn.indexOf("promotionPending: _pending", chromeProof);
  const flip = txn.indexOf("kvSetDurable({ [ENROLL_KEY]: map })", clear);
  assert(envelope > 0 && chromeProof > envelope && clear > chromeProof && flip > clear);
});

Deno.test("D2: boot retries from durable pending and model create refuses live attached runs", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes("reconcileEnrollmentPromotionsOnBoot().catch"));
  const boot = sw.slice(sw.indexOf("async function reconcileEnrollmentPromotionsOnBoot("),
    sw.indexOf("// Recover stale in-flight locks", sw.indexOf("async function reconcileEnrollmentPromotionsOnBoot(")));
  assert(boot.includes("beforeFlip: verifyOwnerPromotionPreconditions"));
  const start = sw.indexOf('async "agent.create"(');
  const end = sw.indexOf('async "agent.enroll-origin"(', start);
  assert(start > 0 && end > start && sw.slice(start, end).includes("ephemeralSiteToolConsentStore.hasLiveOrigin(canonical)"));
});
