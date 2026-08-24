// Security regression tests for owner-bound destructive operations.
// These probes were ported from the rejected f3b4e1f review BEFORE implementation.
// @ts-nocheck
import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  MAX_PENDING_APPROVALS,
  OWNER_DIRECT_ACTIONS,
  approvalPendingCount,
  bindModelApprovalDispatcher,
  canonicalArray,
  canonicalBinary,
  canonicalField,
  canonicalOperationTarget,
  canonicalRecord,
  canonicalScalar,
  consumeApproved,
  createApprovalStore,
  createPendingApproval,
  isOwnerDirectApproval,
  listPendingApprovals,
  opaqueTargetRefWithKey,
  payloadDigest,
  resolvePendingApproval,
} from "../extension/lib/owner-approval.js";
import { isExactOptionsSender } from "../extension/lib/pure.js";
import { scrubEventDetail } from "../extension/lib/diagnostics.js";

const action = "asset.delete";
const target = canonicalOperationTarget("asset", { origin: "https://EXAMPLE.com:443/path", id: "a_1" });
const payload = canonicalRecord(
  canonicalField("origin", canonicalScalar("https://example.com")),
  canonicalField("id", canonicalScalar("a_1")),
);

Deno.test("owner-direct approval: a browser-attested owner UI document's asset.delete IS the approval", () => {
  // Direct owner UI documents (the artifacts gallery / Settings) pass with NO
  // pre-granted Settings decision.
  assertEquals(isOwnerDirectApproval({ principal: "extension", documentId: "doc-1" }, "asset.delete"), true);
  assertEquals(isOwnerDirectApproval({ principal: "owner-options", documentId: "doc-2" }, "asset.delete"), true);
  // Agent/model-initiated deletes keep the full approval flow.
  assertEquals(isOwnerDirectApproval({ principal: "model", executionId: "exec-1" }, "asset.delete"), false);
  // Page/content-script principals can never claim owner-direct authority.
  assertEquals(isOwnerDirectApproval({ principal: "page", documentId: "doc-3" }, "asset.delete"), false);
  // No browser-attested document → fail closed.
  assertEquals(isOwnerDirectApproval({ principal: "extension", documentId: "" }, "asset.delete"), false);
  assertEquals(isOwnerDirectApproval({ principal: "extension" }, "asset.delete"), false);
  assertEquals(isOwnerDirectApproval({ principal: "owner-options", documentId: 7 }, "asset.delete"), false);
  // Only asset.delete is owner-direct: every other destructive action keeps
  // the Settings approval flow even from a UI document.
  for (const other of ["asset.update", "script.delete", "script.update", "agent.delete", "capability.revoke", "hooks.subscribe"]) {
    assertEquals(isOwnerDirectApproval({ principal: "extension", documentId: "doc-1" }, other), false, other);
  }
  // Malformed inputs fail closed without throwing.
  assertEquals(isOwnerDirectApproval(null, "asset.delete"), false);
  assertEquals(isOwnerDirectApproval(undefined, "asset.delete"), false);
  assertEquals(isOwnerDirectApproval({ principal: "extension", documentId: "doc-1" }, undefined), false);
});

Deno.test("owner-direct scope is exactly the audited action set (no silent widening)", () => {
  assertEquals([...OWNER_DIRECT_ACTIONS], ["asset.delete"]);
  // Every owner-direct action passes the audit grammar; widening this set
  // requires a new permission-model review.
  for (const direct of OWNER_DIRECT_ACTIONS) {
    assert(typeof direct === "string" && /^[a-z][a-z.-]{0,63}$/.test(direct), direct);
  }
});

Deno.test("approval payload: raw structures/prototypes/accessors/proxies/cycles fail closed without observation", async () => {
  let getter = 0;
  const accessor = {};
  Object.defineProperty(accessor, "secret", { enumerable: true, get() { getter++; return "no"; } });
  await assertRejects(() => payloadDigest(accessor));
  assertEquals(getter, 0);

  let traps = 0;
  const proxy = new Proxy({}, {
    ownKeys() { traps++; return []; },
    getOwnPropertyDescriptor() { traps++; return undefined; },
    getPrototypeOf() { traps++; return Object.prototype; },
    get() { traps++; return undefined; },
  });
  await assertRejects(() => payloadDigest(proxy));
  assertEquals(traps, 0);

  const cycle: any = {};
  cycle.self = cycle;
  await assertRejects(() => payloadDigest(cycle));
  await assertRejects(() => payloadDigest(Object.create(null)));
  await assertRejects(() => payloadDigest(new Date(0)));
  await assertRejects(() => payloadDigest(Symbol("x")));
});

Deno.test("approval payload: sparse/dense, undefined/null/-0/NaN/infinities and binary offsets remain distinct", async () => {
  const values = [undefined, null, -0, 0, NaN, Infinity, -Infinity].map((v) => canonicalScalar(v));
  const digests = await Promise.all(values.map(payloadDigest));
  assertEquals(new Set(digests).size, values.length);

  const sparseShape = canonicalArray(canonicalScalar(undefined), canonicalScalar("x"));
  const denseShape = canonicalArray(canonicalScalar("x"));
  assertNotEquals(await payloadDigest(sparseShape), await payloadDigest(denseShape));

  const bytes = new Uint8Array([9, 1, 2, 9]);
  const offsetA = canonicalBinary(new Uint8Array(bytes.buffer, 1, 2));
  const offsetB = canonicalBinary(new Uint8Array(new Uint8Array([1, 2]).buffer, 0, 2));
  assertNotEquals(await payloadDigest(offsetA), await payloadDigest(offsetB));

  let binaryAccessors = 0;
  const hostileView = new Uint8Array([1, 2]);
  for (const key of ["buffer", "byteOffset", "byteLength"]) {
    Object.defineProperty(hostileView, key, { get() { binaryAccessors++; throw new Error("observed"); } });
  }
  Object.defineProperty(hostileView, Symbol.toStringTag, { get() { binaryAccessors++; throw new Error("observed"); } });
  const safeView = canonicalBinary(hostileView);
  assertEquals(binaryAccessors, 0, "binary canonicalization uses intrinsic getters only");
  assertEquals(await payloadDigest(safeView), await payloadDigest(canonicalBinary(new Uint8Array([1, 2]))));
});

Deno.test("approval payload: overflow rejects instead of truncating/colliding", () => {
  assertThrows(() => canonicalScalar("x".repeat(400_000)));
  assertThrows(() => canonicalArray(...Array.from({ length: 300 }, () => canonicalScalar(1))));
});

Deno.test("approval targets use effective normalized identities and reject invalid aliases", () => {
  assertEquals(target, canonicalOperationTarget("asset", { origin: "https://example.com", id: "a_1" }));
  assertEquals(canonicalOperationTarget("named", { id: "My Agent!!" }), canonicalOperationTarget("named", { id: "my-agent" }));
  assertEquals(canonicalOperationTarget("script", { origin: "master", id: "s_1" }).startsWith("script:"), true);
  assertNotEquals(canonicalOperationTarget("asset", { origin: "master", id: "a_1" }), canonicalOperationTarget("asset", { origin: "master", id: " a_1" }));
  assertEquals(canonicalOperationTarget("script", { origin: "not-an-origin", id: "s_1" }), "");
  assertEquals(canonicalOperationTarget("hook", { hookId: "tabs.onCreated", recipeId: null }), canonicalOperationTarget("hook", { hookId: "tabs.onCreated" }));
  assertNotEquals(canonicalOperationTarget("hook", { hookId: "tabs.onCreated", recipeId: null }), canonicalOperationTarget("hook", { hookId: "tabs.onCreated", recipeId: "master" }));
});

Deno.test("approval store deduplicates exact requests, never evicts approved grants, and deny is exactly correlated", async () => {
  const store = createApprovalStore();
  const digest = await payloadDigest(payload);
  const one = createPendingApproval(store, "exec:1", action, target, digest);
  const same = createPendingApproval(store, "exec:1", action, target, digest);
  assertEquals(one.approvalId, same.approvalId);
  assertEquals(approvalPendingCount(store), 1);

  const resolved = resolvePendingApproval(store, one.approvalId, true);
  assert(resolved.ok);
  for (let i = 0; i < MAX_PENDING_APPROVALS - 1; i++) {
    const p = createPendingApproval(store, `exec:${i + 2}`, action, target, i.toString(16).padStart(64, "0"));
    assert(p.ok);
  }
  const full = createPendingApproval(store, "exec:overflow", action, target, "f".repeat(64));
  assertEquals(full.ok, false);
  assertEquals(store.approvals.get(one.approvalId)?.status, "approved");

  const denyTarget = listPendingApprovals(store).find((p) => p.approvalId !== one.approvalId)!;
  assert(resolvePendingApproval(store, denyTarget.approvalId, false).ok);
  assertEquals(store.approvals.has(denyTarget.approvalId), false);
  assertEquals(store.approvals.get(one.approvalId)?.status, "approved");
});

Deno.test("model approval dispatcher captures an immutable build-local execution id", () => {
  const seen = [];
  const dispatch = (_type, _args, context) => { seen.push(context.executionId); return context.executionId; };
  const runA = bindModelApprovalDispatcher("exec:A", dispatch);
  const runB = bindModelApprovalDispatcher("exec:B", dispatch);
  assertEquals(runA("asset.delete", {}), "exec:A");
  assertEquals(runB("asset.delete", {}), "exec:B");
  assertEquals(runA("asset.delete", {}), "exec:A", "a stale closure cannot borrow run B's id");
  assertEquals(seen, ["exec:A", "exec:B", "exec:A"]);
});

Deno.test("approval grants bind run/action/target/digest, expire, and consume exactly once", async () => {
  const store = createApprovalStore();
  const digest = await payloadDigest(payload);
  const pending = createPendingApproval(store, "exec:A", action, target, digest, 1000);
  assert(pending.ok);
  assert(resolvePendingApproval(store, pending.approvalId, true).ok);
  assertEquals(consumeApproved(store, "exec:B", action, target, digest).ok, false);
  assertEquals(consumeApproved(store, "exec:A", "asset.update", target, digest).ok, false);
  assertEquals(consumeApproved(store, "exec:A", action, target + "x", digest).ok, false);
  assertEquals(consumeApproved(store, "exec:A", action, target, digest + "x").ok, false);
  assert(consumeApproved(store, "exec:A", action, target, digest).ok);
  assertEquals(consumeApproved(store, "exec:A", action, target, digest).ok, false, "single use");

  const expired = createPendingApproval(store, "exec:E", action, target, digest, 1);
  assert(expired.ok);
  store.approvals.get(expired.approvalId).expiresAt = Date.now();
  assertEquals(resolvePendingApproval(store, expired.approvalId, true).ok, false, "expiry is inclusive");
});

Deno.test("approval pending rows remain FIFO", async () => {
  const store = createApprovalStore();
  const digest = await payloadDigest(payload);
  const a = createPendingApproval(store, "exec:1", action, target, digest);
  const b = createPendingApproval(store, "exec:2", action, target, "b".repeat(64));
  store.approvals.get(a.approvalId).at = 1;
  store.approvals.get(b.approvalId).at = 2;
  assertEquals(listPendingApprovals(store).map((row) => row.approvalId), [a.approvalId, b.approvalId]);
});

Deno.test("approval opaque references are keyed, stable for an install key, and do not expose the target", async () => {
  const keyA = new Uint8Array(32).fill(7);
  const keyB = new Uint8Array(32).fill(8);
  const a1 = await opaqueTargetRefWithKey(target, keyA);
  const a2 = await opaqueTargetRefWithKey(target, keyA);
  const b = await opaqueTargetRefWithKey(target, keyB);
  assertEquals(a1, a2);
  assertNotEquals(a1, b);
  assert(!a1.includes("example") && !a1.includes("a_1"));
});

Deno.test("approval resolution accepts only the exact options extension sender", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const url = `chrome-extension://${id}/options/options.html`;
  const exact = { id, url, origin: `chrome-extension://${id}`, frameId: 0, documentLifecycle: "active", documentId: "doc-1" };
  assert(isExactOptionsSender(exact, id, url));
  assert(isExactOptionsSender({ id, url, documentId: "doc-2" }, id, url), "Chrome extension-page senders omit origin/frame/lifecycle metadata");
  for (const hash of ["#providers", "#local-models", "#tool-library", "#agents", "#background", "#background-agents", "#appearance", "#browser", "#permissions", "#approvals", "#hooks", "#prompts", "#usage", "#data", "#about"]) {
    assert(isExactOptionsSender({ ...exact, url: url + hash }, id, url), `the exact Settings document owns ${hash}`);
  }
  assert(!isExactOptionsSender({ ...exact, url: url + "#foreign" }, id, url), "unknown fragments remain outside the owner surface");
  assert(!isExactOptionsSender({ ...exact, url: url + "?x" }, id, url));
  assert(!isExactOptionsSender({ ...exact, url: url + "?x#providers" }, id, url));
  assert(!isExactOptionsSender({ ...exact, id: "other" }, id, url));
  assert(!isExactOptionsSender({ ...exact, url: `chrome-extension://${id}/ntp/ntp.html` }, id, url));
  assert(isExactOptionsSender({ ...exact, tab: { id: 1, url } }, id, url), "Settings normally runs in its own tab");
  assert(!isExactOptionsSender({ ...exact, origin: "https://evil.example" }, id, url));
  const ntp = `chrome-extension://${id}/ntp/ntp.html`;
  assert(isExactOptionsSender({ ...exact, frameId: 2, tab: { id: 1, url: ntp } }, id, url), "the exact private Settings document is trusted in the shipped NTP iframe");
  assert(!isExactOptionsSender({ ...exact, documentLifecycle: "prerender" }, id, url));
  assert(!isExactOptionsSender({ ...exact, documentId: "" }, id, url));
});

Deno.test("every shipped Settings navigation hash remains inside exact owner authority", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  const url = `chrome-extension://${id}/options/options.html`;
  const exact = { id, url, origin: `chrome-extension://${id}`, frameId: 0, documentLifecycle: "active", documentId: "doc-1" };
  const html = Deno.readTextFileSync(new URL("../extension/options/options.html", import.meta.url));
  const hashes = [...html.matchAll(/<a\s+href="(#[^"]+)"\s+class="nav-item"/g)].map((match) => match[1]);
  assertEquals(hashes.length, 15, "the complete Settings navigation is covered by this authority drift test");
  for (const hash of hashes) {
    assert(isExactOptionsSender({ ...exact, url: url + hash }, id, url), `Settings navigation hash ${hash} must retain owner authority`);
  }
});

Deno.test("diagnostic redaction is Unicode-normalized, byte-bounded, and invokes zero hostile traps", () => {
  let traps = 0;
  const proxy = new Proxy({}, {
    ownKeys() { traps++; return ["token"]; },
    getOwnPropertyDescriptor() { traps++; return { configurable: true, enumerable: true, value: "secret" }; },
    getPrototypeOf() { traps++; return Object.prototype; },
    get() { traps++; return "secret"; },
  });
  const out = scrubEventDetail(proxy);
  assertEquals(traps, 0);
  assert(!out.includes("secret"));
  assert(new TextEncoder().encode(out).length <= 800);

  const unicodeKey = { ["to\u200bken"]: "plain-secret-value" };
  const u = scrubEventDetail(unicodeKey);
  assert(!u.includes("plain-secret-value"));
  assert(!u.includes("__proto__"));
});
