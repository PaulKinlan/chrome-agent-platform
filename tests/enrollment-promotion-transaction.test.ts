// @ts-nocheck — Chrome/OPFS fault fakes intentionally implement a narrow surface.
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { kvGet } from "../extension/lib/kv.js";
import { createEphemeralSiteToolConsentStore } from "../extension/lib/ephemeral-site-tool-consent.js";
import { markCleanupPending } from "../extension/lib/enrollment.js";
import { listOrigins, siteMemory } from "../extension/lib/memory.js";
import {
  abandonEnrollmentPromotion, abandonEnrollmentPromotionLocked, completeEnrollmentPromotion, disenrollOrigin,
  enrollOrigin, enrollmentGeneration, enrollmentSnapshot, isEnrolled, listEnrollmentSweepTargets,
  listPendingEnrollmentPromotions, prepareEnrollmentPromotion, replaceTools, setEnrollmentPolicy,
  setToolConsentDecision,
} from "../extension/lib/tools.js";
import { SITE_TOOL_CONSENT_KEY, siteToolConsentSnapshot, siteToolIdentity } from "../extension/lib/site-tool-consent.js";
import { evaluateWebmcpAuthority, siteToolConsentPermissionDigest } from "../extension/lib/webmcp-authority.js";

const data = new Map();
let storageGranted = true;
let failRegistryFlip = false;
let failConsentWrite = false;
Object.defineProperty(globalThis, "chrome", { configurable: true, writable: true, value: {
  permissions: { contains: async () => storageGranted },
  storage: { local: {
    get: async (keys) => {
      const out = {};
      for (const key of (keys == null ? data.keys() : Array.isArray(keys) ? keys : [keys])) {
        if (data.has(key)) out[key] = structuredClone(data.get(key));
      }
      return out;
    },
    set: async (values) => {
      const map = values["cap:enrollment"];
      if (failRegistryFlip && map && Object.values(map).some((entry) =>
        entry?.enrolled === true && !entry.phase && !entry.promotionPending)) {
        throw new Error("simulated authority flip failure");
      }
      for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value));
    },
    remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); },
  } },
} });

function directory() { return { kind: "directory", nodes: new Map() }; }
const root = directory();
class FakeFile {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() { const node = this.node; return { async text() { return node.content ?? ""; }, size: node.content?.length ?? 0 }; }
  async createWritable() {
    const node = this.node;
    return { async write(text) { node.pending = String(text); }, async close() {
      if (failConsentWrite && node.name.includes("webmcp-tool-consent")) throw new Error("simulated consent write failure");
      node.content = node.pending;
    } };
  }
}
class FakeDirectory {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.nodes.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.nodes.set(name, directory());
    }
    return new FakeDirectory(this.node.nodes.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.nodes.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.nodes.set(name, { kind: "file", name, content: "" });
    }
    return new FakeFile(this.node.nodes.get(name));
  }
  async removeEntry(name) { this.node.nodes.delete(name); }
  async *entries() { for (const [name, node] of this.node.nodes) yield [name, node.kind === "file" ? new FakeFile(node) : new FakeDirectory(node)]; }
}
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true,
  value: { storage: { async getDirectory() { return new FakeDirectory(root); } } },
});

const allowTool = { name: "find_items", description: "Find items", source: "declared", inputSchema: { type: "object", properties: {} } };
const denyTool = { ...allowTool, name: "erase_items" };
const ready = async () => ({ scriptsRegistered: true, hostGranted: true });
const complete = (origin: string, gen: number, opts = {}) =>
  completeEnrollmentPromotion(origin, gen, { beforeFlip: ready, ...opts });
function decisions(origin) {
  return [
    { name: allowTool.name, source: "declared", identityDigest: siteToolIdentity(origin, allowTool).identityDigest, state: "allowed" },
    { name: denyTool.name, source: "declared", identityDigest: siteToolIdentity(origin, denyTool).identityDigest, state: "denied" },
  ];
}
const pending = async (origin: string) => (await kvGet("cap:enrollment"))["cap:enrollment"]?.[origin];

Deno.test("D2: durable enrolled:true+promotionPending carries BOTH decisions but all readers refuse authority", async () => {
  const origin = "https://promotion-recover.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  assertEquals((await pending(origin)).enrolled, true);
  assertEquals((await pending(origin)).promotionPending.map((row) => row.state), ["allowed", "denied"]);
  assertEquals(await isEnrolled(origin), false);
  assertEquals(await enrollmentGeneration(origin, { requireActive: true }), 0,
    "locked-audit exception must not infer authority from a pending gen");
  assertEquals(await enrollmentGeneration(origin), gen, "raw generation remains available for tombstone lifecycle");
  assertEquals((await enrollmentSnapshot(origin)).pending, true);
  assertEquals((await listOrigins()).includes(origin), false);
  // Worker restart: the durable copy, not a vanished run token, is authoritative.
  await complete(origin, gen);
  assertEquals(await isEnrolled(origin), true);
  assertEquals((await pending(origin)).promotionPending, undefined);
  assertEquals((await siteToolConsentSnapshot(origin, allowTool, gen)).state, "allowed");
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, gen)).state, "denied");
});

Deno.test("D2 split: owner enrollment with no attached run writes and verifies an empty same-gen envelope", async () => {
  const origin = "https://promotion-no-tab-binding.example";
  const store = createEphemeralSiteToolConsentStore();
  assertEquals(await store.withPromotionForOrigin(origin, async () => { throw Error("must not run without a token"); }), null);
  const { gen } = await prepareEnrollmentPromotion(origin, []);
  assertEquals(await isEnrolled(origin), false);
  await complete(origin, gen);
  assertEquals(await isEnrolled(origin), true);
  assertEquals((await listOrigins()).includes(origin), true);
  const envelope = await siteMemory(origin).getStrict(SITE_TOOL_CONSENT_KEY);
  assertEquals(envelope?.enrollmentGen, gen);
  assertEquals(envelope?.records, []);
});

Deno.test("D2: consent write failure leaves inert registry copy and retry preserves Deny", async () => {
  const origin = "https://promotion-write-fail.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  failConsentWrite = true;
  try { await assertRejects(() => complete(origin, gen), Error, "simulated consent write failure"); }
  finally { failConsentWrite = false; }
  assertEquals((await pending(origin)).promotionPending.length, 2);
  assertEquals(await isEnrolled(origin), false);
  await complete(origin, gen);
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, gen)).state, "denied");
});

Deno.test("D2: host or either registered script missing keeps pending after verified envelope", async () => {
  const origin = "https://promotion-script-missing.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  for (const result of [
    { scriptsRegistered: false, hostGranted: true },
    { scriptsRegistered: true, hostGranted: false },
  ]) {
    await assertRejects(() => complete(origin, gen, { beforeFlip: async () => result }), Error,
      "site_enrollment_promotion_precondition_missing");
    assertEquals((await pending(origin)).promotionPending.length, 2);
    assertEquals((await enrollmentSnapshot(origin)).enrolled, false);
    assertEquals((await listOrigins()).includes(origin), false);
    assertEquals((await siteMemory(origin).getStrict(SITE_TOOL_CONSENT_KEY)).enrollmentGen, gen);
  }
  await complete(origin, gen); // boot retry after scripts + permission become available
  assertEquals(await isEnrolled(origin), true);
});

Deno.test("D2: absent pre-flip proof cannot clear pending even after valid consent write", async () => {
  const origin = "https://promotion-no-proof.example";
  const { gen } = await prepareEnrollmentPromotion(origin, []);
  await assertRejects(() => completeEnrollmentPromotion(origin, gen), Error,
    "site_enrollment_promotion_unverified");
  assertEquals(await isEnrolled(origin), false);
  await complete(origin, gen);
  assertEquals((await siteMemory(origin).getStrict(SITE_TOOL_CONSENT_KEY)).enrollmentGen, gen);
});

Deno.test("D2: reset epoch loss after script proof cannot clear pending", async () => {
  const origin = "https://promotion-reset-race.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  let current = true;
  await assertRejects(() => complete(origin, gen, {
    commitGuard: () => current,
    beforeFlip: async () => { current = false; return ready(); },
  }), Error, "site_enrollment_promotion_cancelled");
  assertEquals((await pending(origin)).promotionPending.length, 2);
  assertEquals(await isEnrolled(origin), false);
  // If reset aborts without clearing this pending row, an owner may retry
  // from the durable copy; a completed reset instead removes the row entirely.
  await complete(origin, gen);
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, gen)).state, "denied");
});

Deno.test("D2: failed registry clear after verification stays pending and replays idempotently", async () => {
  const origin = "https://promotion-flip-fail.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  failRegistryFlip = true;
  try { await assertRejects(() => complete(origin, gen), Error, "simulated authority flip failure"); }
  finally { failRegistryFlip = false; }
  assertEquals((await pending(origin)).promotionPending.length, 2);
  assertEquals(await isEnrolled(origin), false);
  await complete(origin, gen);
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, gen)).state, "denied");
});

Deno.test("D2: owner abandonment tombstones first; stale completion cannot clear a later generation", async () => {
  const origin = "https://promotion-abandon.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  assertEquals((await abandonEnrollmentPromotion(origin, gen)).abandoned, true);
  await assertRejects(() => complete(origin, gen), Error, "site_enrollment_promotion_stale");
  assertEquals(await isEnrolled(origin), false);
});

Deno.test("D2: scripting Disable's surviving Deny migrates into the owner retry without a dead-end", async () => {
  const origin = "https://promotion-disable-retry.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  await complete(origin, gen);
  await disenrollOrigin(origin); // capability Disable leaves OPFS consent behind
  await assertRejects(() => enrollOrigin(origin), Error, "site_enrollment_existing_consent_requires_review");
  const newer = await prepareEnrollmentPromotion(origin, [decisions(origin)[0]]);
  const row = await pending(origin);
  assertEquals(row.promotionPending.map((r) => [r.name, r.state]), [
    [allowTool.name, "allowed"], [denyTool.name, "denied"],
  ]);
  assertEquals(await isEnrolled(origin), false);
  await complete(origin, newer.gen); // boot or Settings retry from durable copy
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, newer.gen)).state, "denied");
  assertEquals((await siteToolConsentSnapshot(origin, allowTool, newer.gen)).state, "allowed");
  assertEquals(await isEnrolled(origin), true);
});

Deno.test("D2: a legacy inferred Deny stays a denial after declared-only owner promotion", async () => {
  const origin = "https://promotion-inferred-deny.example";
  await enrollOrigin(origin);
  await replaceTools(origin, [{ ...denyTool, source: "inferred" }]);
  await setToolConsentDecision(origin, denyTool.name, "denied");
  await disenrollOrigin(origin);
  const { gen } = await prepareEnrollmentPromotion(origin, []);
  assertEquals((await pending(origin)).promotionPending.map((r) => [r.name, r.source, r.state]),
    [[denyTool.name, "declared", "denied"]]);
  await complete(origin, gen);
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, gen)).state, "denied");
});

Deno.test("D2: missing durable storage permission cannot even stage intent", async () => {
  const origin = "https://promotion-no-storage.example";
  storageGranted = false;
  try { await assertRejects(() => prepareEnrollmentPromotion(origin, decisions(origin)), Error, "durable storage permission unavailable"); }
  finally { storageGranted = true; }
  assertEquals(await pending(origin), undefined);
});

Deno.test("D2: duplicate owner clicks and agent.create/delete cannot overtake pending", async () => {
  const origin = "https://promotion-compete.example";
  const proposal = decisions(origin);
  const results = await Promise.allSettled([prepareEnrollmentPromotion(origin, proposal), prepareEnrollmentPromotion(origin, proposal)]);
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  await assertRejects(() => enrollOrigin(origin), Error, "site_enrollment_promotion_pending");
  await assertRejects(() => disenrollOrigin(origin), Error, "site_enrollment_promotion_pending");
  assertEquals(await isEnrolled(origin), false);
});

Deno.test("D2: failed policy envelope leaves inert pending; recovery retains sticky Deny", async () => {
  const origin = "https://promotion-policy-fail.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  await complete(origin, gen);
  failConsentWrite = true;
  try { await assertRejects(() => setEnrollmentPolicy(origin, "deny"), Error, "simulated consent write failure"); }
  finally { failConsentWrite = false; }
  assertEquals((await pending(origin)).phase, "policy-pending");
  assertEquals((await pending(origin)).enrolled, false);
  assertEquals((await pending(origin)).consentCopy.records.map((r) => r.state), ["denied"]);
  assertEquals(await isEnrolled(origin), false);
  await complete(origin, (await pending(origin)).gen); // policy's durable Deny-only copy
  const after = await enrollmentSnapshot(origin);
  assertEquals(after.policy, "deny");
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, after.gen)).state, "denied");
  assertEquals((await siteToolConsentSnapshot(origin, allowTool, after.gen)).state, "ask");
});

Deno.test("D2: repeated legacy create and policy flip cannot drop sticky Deny", async () => {
  const origin = "https://promotion-policy.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  await complete(origin, gen);
  await enrollOrigin(origin);
  assertEquals((await enrollmentSnapshot(origin)).gen, gen);
  await setEnrollmentPolicy(origin, "deny");
  const after = await enrollmentSnapshot(origin);
  assertEquals(after.gen > gen, true, "policy flip revokes in-flight grants");
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, after.gen)).state, "denied");
  const allowedAfter = await siteToolConsentSnapshot(origin, allowTool, after.gen);
  assertEquals(allowedAfter.state, "ask");
  // Even if a NEW owner card later re-allows the descriptor, the old run's
  // immutable generation cannot borrow that new Allow.
  const freshPermission = siteToolConsentPermissionDigest({
    identityDigest: allowedAfter.identityDigest, enrollmentGen: after.gen,
    revision: allowedAfter.revision, state: "allowed",
  });
  assertEquals(evaluateWebmcpAuthority({ enrolled: true, enrollmentGen: after.gen,
    policy: "allow", toolPresent: true, consentState: "allowed", consentEnrollmentGen: after.gen,
    consentRevision: allowedAfter.revision, identityDigest: allowedAfter.identityDigest,
    runGen: gen, descriptorInput: { permissionDigest: freshPermission },
  }).reason, "run-generation-stale");
});

Deno.test("D2 n6c31: an old-generation Deny cannot be bypassed by promoting a differently-cased Allow", async () => {
  const origin = "https://promotion-casing-deny.example";
  // Old generation has Deny on "BookTable"
  const { gen: gen1 } = await prepareEnrollmentPromotion(origin, [
    { name: "BookTable", source: "declared", identityDigest: "a".repeat(64), state: "denied" },
  ]);
  await complete(origin, gen1);
  await disenrollOrigin(origin); // leaves OPFS consent with "BookTable" denied

  // New run decision attempts to promote an Allow for lowercase "booktable"
  const newer = await prepareEnrollmentPromotion(origin, [
    { name: "booktable", source: "declared", identityDigest: "b".repeat(64), state: "allowed" },
  ]);
  const row = await pending(origin);

  // The sticky Deny on "BookTable" must displace the run Allow for "booktable" across casing variants
  assertEquals(row.promotionPending.map((r) => [r.name, r.state]), [
    ["BookTable", "denied"],
  ]);
  await complete(origin, newer.gen);
  assertEquals((await siteToolConsentSnapshot(origin, { name: "booktable", source: "declared" }, newer.gen)).state, "denied");
  assertEquals((await siteToolConsentSnapshot(origin, { name: "BookTable", source: "declared" }, newer.gen)).state, "denied");
});

// chrome-agent-platform-2tttw (P1, reviewer finding on do09a f5b01d63). A policy-pending row is
// enrolled:false|phase:"policy-pending": a decision envelope whose consent write failed, staged with no
// authority. listPendingEnrollmentPromotions() includes it, so the scripting-Disable sweep snapshots it - but
// abandonEnrollmentPromotion refused it as `stale` (it only accepted the enrolled:true promotion shapes). The
// sweep therefore marked cleanupPending and left the row; the next boot replayed the staged decision through
// completeEnrollmentPromotion and isEnrolled flipped to TRUE with no scripting or host precondition satisfied
// in that session. Disable must tombstone this shape too, at a NEW generation, so the replay is stale.
Deno.test("2tttw: an abandoned policy-pending row cannot reauthorize on a later boot", async () => {
  const origin = "https://policy-pending-abandon.example";
  const first = await prepareEnrollmentPromotion(origin, decisions(origin));
  await complete(origin, first.gen);
  failConsentWrite = true;
  try { await assertRejects(() => setEnrollmentPolicy(origin, "deny"), Error, "simulated consent write failure"); }
  finally { failConsentWrite = false; }
  const staged = await pending(origin);
  assertEquals(staged.phase, "policy-pending");
  assertEquals(staged.enrolled, false);
  assertEquals(await isEnrolled(origin), false);
  // The sweep's population DOES contain this row, so the abandon it performs must tombstone it.
  const target = (await listPendingEnrollmentPromotions()).find((row) => row.origin === origin);
  assertEquals(target?.phase, "policy-pending");
  assertEquals(target?.gen, staged.gen);
  assertEquals((await abandonEnrollmentPromotion(origin, staged.gen)).abandoned, true);
  // The durable copy is now a tombstone at a NEW generation - no phase, still not enrolled.
  const row = await pending(origin);
  assertEquals(row.enrolled, false);
  assertEquals(row.phase, undefined);
  assertNotEquals(row.gen, staged.gen);
  assertEquals(await isEnrolled(origin), false);
  // A later boot's reconcile replays the staged decision (old generation): stale, never authority.
  await assertRejects(() => completeEnrollmentPromotion(origin, staged.gen), Error, "site_enrollment_promotion_stale");
  assertEquals(await isEnrolled(origin), false);
  // Even a replay that guessed the new generation finds no pending row to complete.
  await assertRejects(() => completeEnrollmentPromotion(origin, row.gen), Error);
  assertEquals(await isEnrolled(origin), false);
  assertEquals((await listPendingEnrollmentPromotions()).some((entry) => entry.origin === origin), false);
});

// chrome-agent-platform-do09a. The scripting-Disable transition tombstones every origin from
// listOrigins(), and listOrigins() hides a pending promotion (`pending` is inert by design), so the
// owner's Disable left the pending row durable: a LATER boot's reconcileEnrollmentPromotionsOnBoot
// completed the promotion with no owner gesture in that session. No authority exists while pending and
// completion needs scripting re-enabled, so this was hygiene rather than a bypass - but Disable was not
// total. The sweep now reads one snapshot of both populations (listEnrollmentSweepTargets) and abandons
// the pending rows with the SAME tombstone; the last test pins that wiring in the transition itself.
Deno.test("do09a: the Disable sweep's target list covers the pending promotion that listOrigins() hides", async () => {
  const origin = "https://disable-sweep-pending.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  // The hole, restated as an assertion: the enrolled-origin list on its own does not cover this row.
  assertEquals((await listOrigins()).includes(origin), false);
  const targets = await listEnrollmentSweepTargets();
  assertEquals(targets.origins.includes(origin), false);
  assertEquals(targets.pending.filter((row) => row.origin === origin).map((row) => [row.gen, row.phase]), [[gen, "promotion-pending"]]);
  // No row may be counted twice, and no enrolled origin may be swept as a pending promotion.
  assertEquals(targets.pending.every((row) => !targets.origins.includes(row.origin)), true);
});

Deno.test("do09a: a pending promotion the sweep abandons cannot be completed by a later boot", async () => {
  const origin = "https://disable-sweep-abandon.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  const target = (await listEnrollmentSweepTargets()).pending.find((row) => row.origin === origin);
  assertEquals(target?.gen, gen);
  // Exactly what the sweep does: the LOCKED abandon, because the sweep already holds the enrollment lock.
  assertEquals((await abandonEnrollmentPromotionLocked(origin, target!.gen)).abandoned, true);
  // A later boot's reconcile finds nothing to complete...
  assertEquals((await listPendingEnrollmentPromotions()).some((row) => row.origin === origin), false);
  // ...the durable copy is a tombstone at a NEW generation, so replaying the decision cannot resurrect it...
  const row = await pending(origin);
  assertEquals(row.enrolled, false);
  assertEquals(row.phase, undefined);
  assertNotEquals(row.gen, gen);
  await assertRejects(() => complete(origin, gen), Error, "site_enrollment_promotion_stale");
  assertEquals(await isEnrolled(origin), false);
  // ...and the same-generation consent envelope is gone, so no site copy outlives the tombstone.
  assertEquals(await siteMemory(origin).getStrict(SITE_TOOL_CONSENT_KEY).catch(() => null), null);
});

Deno.test("do09a: policy-pending Disable survives boot reconciliation without re-enrollment", async () => {
  const origin = "https://policy-pending-disable-restart.example";
  const first = await prepareEnrollmentPromotion(origin, decisions(origin));
  await complete(origin, first.gen);
  failConsentWrite = true;
  try { await assertRejects(() => setEnrollmentPolicy(origin, "deny"), Error, "simulated consent write failure"); }
  finally { failConsentWrite = false; }
  const staged = await pending(origin);
  assertEquals(staged.phase, "policy-pending");
  assertEquals(await isEnrolled(origin), false);

  // Model the production Disable sweep's pending-row path. Its catch writes only
  // cleanupPending; that flag alone must not leave a replayable policy decision.
  const targets = await listEnrollmentSweepTargets();
  const failures = [];
  for (const row of targets.pending.filter((entry) => entry.origin === origin)) {
    try { await abandonEnrollmentPromotionLocked(row.origin, row.gen); }
    catch (error) { await markCleanupPending(row.origin); failures.push(error); }
  }
  // A worker restart reads the durable pending population anew. The real boot
  // reconciler calls completeEnrollmentPromotion for each policy-pending row.
  for (const row of await listPendingEnrollmentPromotions()) {
    if (row.origin === origin && row.phase === "policy-pending") await complete(row.origin, row.gen);
  }
  assertEquals(await isEnrolled(origin), false, "boot must not restore enrollment after Disable");
  assertEquals(failures.length, 0, "Disable must tombstone, not leave a retry-only cleanup marker");
  assertEquals((await listPendingEnrollmentPromotions()).some((row) => row.origin === origin), false);
  const tombstone = await pending(origin);
  assertEquals(tombstone.phase, undefined);
  assertNotEquals(tombstone.gen, staged.gen);
});

Deno.test("do09a: the scripting-Disable transition sweeps the pending promotions, not just listOrigins()", async () => {
  const source = Deno.readTextFileSync(new URL("../extension/background/service-worker.js", import.meta.url));
  const disableAt = source.indexOf('id === "scripting"');
  const snapshotAt = source.indexOf("await listEnrollmentSweepTargets()");
  const loopAt = source.indexOf("for (const pending of pendingPromotions)");
  assert(disableAt > 0, "the scripting branch of the permission transition must exist");
  assert(snapshotAt > disableAt, "the sweep must take its snapshot from listEnrollmentSweepTargets() INSIDE the scripting branch");
  assert(loopAt > snapshotAt, "the sweep must then walk the pending promotions it snapshot");
  const body = source.slice(loopAt, loopAt + 1200);
  assert(body.includes("abandonEnrollmentPromotionLocked(pending.origin, pending.gen)"),
    "each pending promotion must be abandoned with the same tombstone the owner gesture uses");
  assert(body.includes("unregisterOriginScripts(pending.origin)"),
    "a pending promotion can already have its scripts registered, so Disable must unregister them");
  assert(source.slice(disableAt, snapshotAt).indexOf("const origins = await listOrigins()") < 0,
    "the snapshot must not revert to listOrigins() alone: that is the population that hid the pending rows");
});
