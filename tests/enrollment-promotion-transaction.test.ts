// @ts-nocheck — Chrome/OPFS fault fakes intentionally implement a narrow surface.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { kvGet } from "../extension/lib/kv.js";
import { listOrigins, siteMemory } from "../extension/lib/memory.js";
import {
  abandonEnrollmentPromotion, completeEnrollmentPromotion, disenrollOrigin, enrollOrigin,
  enrollmentGeneration, enrollmentSnapshot, isEnrolled, prepareEnrollmentPromotion, setEnrollmentPolicy,
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
