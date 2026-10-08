// @ts-nocheck — Chrome/OPFS fault fakes intentionally implement a narrow surface.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { kvGet } from "../extension/lib/kv.js";
import { listOrigins } from "../extension/lib/memory.js";
import {
  completeEnrollmentPromotion, disenrollOrigin, enrollOrigin, enrollmentSnapshot,
  isEnrolled, prepareEnrollmentPromotion, setEnrollmentPolicy,
} from "../extension/lib/tools.js";
import { siteToolConsentSnapshot, siteToolIdentity } from "../extension/lib/site-tool-consent.js";

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
      if (failRegistryFlip && map && Object.values(map).some((entry) => entry?.enrolled === true)) {
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
function decisions(origin) {
  return [
    { name: allowTool.name, source: "declared", identityDigest: siteToolIdentity(origin, allowTool).identityDigest, state: "allowed" },
    { name: denyTool.name, source: "declared", identityDigest: siteToolIdentity(origin, denyTool).identityDigest, state: "denied" },
  ];
}

Deno.test("D2: registry contains BOTH decisions before authority; recovery promotes from durable copy", async () => {
  const origin = "https://promotion-recover.example";
  const prepared = await prepareEnrollmentPromotion(origin, decisions(origin));
  assertEquals(prepared.phase, "promotion-pending");
  assertEquals(await isEnrolled(origin), false);
  assertEquals((await listOrigins()).includes(origin), false);
  const pending = (await kvGet("cap:enrollment"))["cap:enrollment"][origin];
  assertEquals(pending.enrolled, false);
  assertEquals(pending.decisions.map((row) => row.state), ["allowed", "denied"]);
  // This completion has no ephemeral-run token; it is the worker-restart path.
  await completeEnrollmentPromotion(origin, prepared.gen);
  assertEquals(await isEnrolled(origin), true);
  assertEquals((await enrollmentSnapshot(origin)).gen, prepared.gen);
  assertEquals((await siteToolConsentSnapshot(origin, allowTool, prepared.gen)).state, "allowed");
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, prepared.gen)).state, "denied");
});

Deno.test("D2: failed consent write leaves inert durable pending; retry preserves sticky Deny", async () => {
  const origin = "https://promotion-write-fail.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  failConsentWrite = true;
  try { await assertRejects(() => completeEnrollmentPromotion(origin, gen), Error, "simulated consent write failure"); }
  finally { failConsentWrite = false; }
  assertEquals(await isEnrolled(origin), false);
  assertEquals((await kvGet("cap:enrollment"))["cap:enrollment"][origin].phase, "promotion-pending");
  await completeEnrollmentPromotion(origin, gen);
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, gen)).state, "denied");
});

Deno.test("D2: failure after verified envelope but before registry flip stays pending and retries", async () => {
  const origin = "https://promotion-flip-fail.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  failRegistryFlip = true;
  try { await assertRejects(() => completeEnrollmentPromotion(origin, gen), Error, "simulated authority flip failure"); }
  finally { failRegistryFlip = false; }
  assertEquals(await isEnrolled(origin), false);
  assertEquals((await kvGet("cap:enrollment"))["cap:enrollment"][origin].phase, "promotion-pending");
  await completeEnrollmentPromotion(origin, gen);
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, gen)).state, "denied");
});

Deno.test("D2: empty owner promotion still writes a same-gen envelope before authority", async () => {
  const origin = "https://promotion-empty.example";
  const { gen } = await prepareEnrollmentPromotion(origin, []);
  await completeEnrollmentPromotion(origin, gen);
  assertEquals(await isEnrolled(origin), true);
  const { siteMemory } = await import("../extension/lib/memory.js");
  const { SITE_TOOL_CONSENT_KEY } = await import("../extension/lib/site-tool-consent.js");
  assertEquals((await siteMemory(origin).getStrict(SITE_TOOL_CONSENT_KEY)).enrollmentGen, gen);
});

Deno.test("D2: script-registration rollback keeps BOTH decisions in an inert retry row", async () => {
  const origin = "https://promotion-rollback.example";
  const proposal = decisions(origin);
  const { gen } = await prepareEnrollmentPromotion(origin, proposal);
  await completeEnrollmentPromotion(origin, gen);
  const { rollbackEnrollmentPromotion, finalizeEnrollmentPromotionReceipt } = await import("../extension/lib/tools.js");
  const rollback = await rollbackEnrollmentPromotion(origin, gen);
  assertEquals(rollback.phase, "promotion-retry");
  assertEquals(await isEnrolled(origin), false);
  assertEquals((await kvGet("cap:enrollment"))["cap:enrollment"][origin].decisions, proposal);
  await assertRejects(() => completeEnrollmentPromotion(origin, gen), Error, "site_enrollment_promotion_stale");
  // Simulate script/OPFS cleanup and then a new owner gesture or boot retry.
  const { siteMemory } = await import("../extension/lib/memory.js");
  await siteMemory(origin).clear();
  await completeEnrollmentPromotion(origin, rollback.gen);
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, rollback.gen)).state, "denied");
  assertEquals((await siteToolConsentSnapshot(origin, allowTool, rollback.gen)).state, "allowed");
  await finalizeEnrollmentPromotionReceipt(origin, rollback.gen);
  assertEquals((await kvGet("cap:enrollment"))["cap:enrollment"][origin].promotionReceipt, undefined);
});

Deno.test("D2: abandonment tombstones before cleanup; a stale completion cannot flip", async () => {
  const origin = "https://promotion-abandon.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  const { abandonEnrollmentPromotion } = await import("../extension/lib/tools.js");
  const result = await abandonEnrollmentPromotion(origin, gen);
  assertEquals(result.abandoned, true);
  await assertRejects(() => completeEnrollmentPromotion(origin, gen), Error, "site_enrollment_promotion_stale");
  assertEquals(await isEnrolled(origin), false);
});

Deno.test("D2: permissionless storage cannot stage a session-only enrollment or create an OPFS authority", async () => {
  const origin = "https://promotion-no-storage.example";
  storageGranted = false;
  try { await assertRejects(() => prepareEnrollmentPromotion(origin, decisions(origin)), Error, "durable storage permission unavailable"); }
  finally { storageGranted = true; }
  assertEquals(await isEnrolled(origin), false);
  assertEquals((await kvGet("cap:enrollment"))["cap:enrollment"]?.[origin], undefined);
});

Deno.test("D2: duplicate owner clicks and legacy create/delete cannot overtake pending", async () => {
  const origin = "https://promotion-compete.example";
  const proposal = decisions(origin);
  const results = await Promise.allSettled([prepareEnrollmentPromotion(origin, proposal), prepareEnrollmentPromotion(origin, proposal)]);
  assertEquals(results.filter((r) => r.status === "fulfilled").length, 1);
  await assertRejects(() => enrollOrigin(origin), Error, "site_enrollment_promotion_pending");
  await assertRejects(() => disenrollOrigin(origin), Error, "site_enrollment_promotion_pending");
  assertEquals(await isEnrolled(origin), false);
});

Deno.test("D2: failed policy-envelope write is non-authorizing and restart recovery retains Deny", async () => {
  const origin = "https://promotion-policy-fail.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  await completeEnrollmentPromotion(origin, gen);
  failConsentWrite = true;
  try { await assertRejects(() => setEnrollmentPolicy(origin, "deny"), Error, "simulated consent write failure"); }
  finally { failConsentWrite = false; }
  const pending = (await kvGet("cap:enrollment"))["cap:enrollment"][origin];
  assertEquals(pending.phase, "policy-pending");
  assertEquals(pending.enrolled, false);
  assertEquals(await isEnrolled(origin), false);
  await completeEnrollmentPromotion(origin, pending.gen); // no run token after restart
  assertEquals((await enrollmentSnapshot(origin)).policy, "deny");
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, pending.gen)).state, "denied");
});

Deno.test("D2: repeating legacy enroll or flipping site policy must not erase durable sticky Deny", async () => {
  const origin = "https://promotion-policy.example";
  const { gen } = await prepareEnrollmentPromotion(origin, decisions(origin));
  await completeEnrollmentPromotion(origin, gen);
  await enrollOrigin(origin);
  assertEquals((await enrollmentSnapshot(origin)).gen, gen, "duplicate create must not bump generation");
  await setEnrollmentPolicy(origin, "deny");
  const after = await enrollmentSnapshot(origin);
  assertEquals((await siteToolConsentSnapshot(origin, denyTool, after.gen)).state, "denied");
});
