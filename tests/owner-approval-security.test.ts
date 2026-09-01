// Security regression tests for owner-bound destructive operations.
// These probes were ported from the rejected f3b4e1f review BEFORE implementation.
// @ts-nocheck
import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  DESTRUCTIVE_ACTIONS,
  MAX_PENDING_APPROVALS,
  OWNER_DIRECT_ACTIONS,
  approvalCardDenial,
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
  SOURCE_DISCLOSING_ACTIONS,
  waitForApprovalDecision,
  boundStagedApprovalDetail,
  getStagedApprovalDetail,
  mayReadApprovalDetail,
  stageApprovalDetail,
} from "../extension/lib/owner-approval.js";
// The BUILT diff bundle (jsdiff): the consumers never resolve the bare "diff"
// specifier from source, so the test computes the reference counts through the
// same build the extension ships (run `npm run build` first).
import { structuredPatch } from "../extension/dist/shared/diff-core.bundle.js";
import { isExactOptionsSender, SETTINGS_SECTIONS } from "../extension/lib/pure.js";
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
  for (const other of ["asset.update", "script.delete", "script.update", "capability.revoke", "hooks.subscribe"]) {
    assertEquals(isOwnerDirectApproval({ principal: "extension", documentId: "doc-1" }, other), false, other);
  }
  for (const direct of ["asset.delete", "agent.delete", "named-agent.delete", "recipe.delete"]) {
    assertEquals(isOwnerDirectApproval({ principal: "extension", documentId: "doc-1" }, direct), true, direct);
  }
  // Malformed inputs fail closed without throwing.
  assertEquals(isOwnerDirectApproval(null, "asset.delete"), false);
  assertEquals(isOwnerDirectApproval(undefined, "asset.delete"), false);
  assertEquals(isOwnerDirectApproval({ principal: "extension", documentId: "doc-1" }, undefined), false);
});

Deno.test("owner-direct scope is exactly the audited action set (no silent widening)", () => {
  // PER-AGENT SCHEDULES WIDENING (owner request: pause/resume/update schedules
  // from the agent + UI): task.pause/resume/update join the audited owner-direct
  // set — the owner's own UI click IS the approval (asset.delete precedent);
  // model-initiated calls keep the full pending-approval flow. FLAGGED for the
  // independent permission-model review.
  // UNIFIED AGENT MODEL WIDENING (owner directive 2026-08-28): an agent is
  // persona + skills + memory + an OPTIONAL schedule — the owner's schedule
  // edit in the agent dialog IS the approval, so named-agent.set-schedule
  // joins the audited owner-direct set; model-initiated calls keep the full
  // pending-approval flow.
  // SCRIPT WIDENING (CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01): the
  // owner writing/running a saved script from the hub IS the approval;
  // a model-initiated script.create/run pays the source-disclosing card.
  // VERSION RESTORE WIDENING (CAP-FB-20260830-ARTIFACT-VERSIONS-01): the
  // owner's own Restore click in the artifact viewer IS the approval (the
  // asset.delete precedent); a model-initiated asset.restore pays the card.
  // WORKFLOW WIDENING (CAP-FB-20260831-WORKFLOWS-TO-MEMORY-01): the owner's
  // own workflow run from an extension surface IS the approval (script.run
  // precedent); a model-initiated workflow.run pays the source-disclosing card.
  assertEquals([...OWNER_DIRECT_ACTIONS].sort(), ["agent.delete", "asset.delete", "asset.restore", "named-agent.delete", "named-agent.set-schedule", "recipe.delete", "script.create", "script.run", "task.pause", "task.resume", "task.update", "workflow.run"].sort());
  // Every owner-direct action passes the audit grammar; widening this set
  // requires a new permission-model review.
  for (const direct of OWNER_DIRECT_ACTIONS) {
    assert(typeof direct === "string" && /^[a-z][a-z.-]{0,63}$/.test(direct), direct);
  }
});

Deno.test("policy: the six destructive browser actions are approvable (in DESTRUCTIVE_ACTIONS)", () => {
  // CAP-FB-20260830-DESTRUCTIVE-ACTION-POLICY-01: once Browser control is on,
  // a destructive browser action (close a foreign tab/window, wipe data,
  // remove a bookmark, set/remove a cookie) must take a per-action owner
  // approval. createPendingApproval refuses any action not in this set, so the
  // approval path cannot even be requested without membership.
  for (const action of [
    "browser.close-foreign-tab",
    "browser.close-window",
    "browser.wipe",
    "browser.remove-bookmark",
    "browser.set-cookie",
    "browser.remove-cookie",
  ]) {
    assert(DESTRUCTIVE_ACTIONS.has(action), `${action} must be an approvable destructive action`);
    // The action name passes the same audit grammar every approvable action does.
    assert(/^[a-z][a-z.-]{0,63}$/.test(action), action);
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

Deno.test("model approval dispatcher captures an immutable build-local execution id and progress seam", () => {
  const seen = [];
  const events = [];
  const dispatch = (_type, _args, context) => {
    seen.push(context.executionId);
    context.onApprovalEvent?.({ type: "approval-request" });
    return context.executionId;
  };
  const runA = bindModelApprovalDispatcher("exec:A", dispatch, (event) => events.push(event));
  const runB = bindModelApprovalDispatcher("exec:B", dispatch);
  assertEquals(runA("asset.delete", {}), "exec:A");
  assertEquals(runB("asset.delete", {}), "exec:B");
  assertEquals(runA("asset.delete", {}), "exec:A", "a stale closure cannot borrow run B's id");
  assertEquals(seen, ["exec:A", "exec:B", "exec:A"]);
  assertEquals(events, [{ type: "approval-request" }, { type: "approval-request" }], "run A's inline events stay on its captured progress channel");
});

Deno.test("inline decision wait: the tool stays pending, approve resumes exactly once, deny and timeout fail closed", async () => {
  const digest = await payloadDigest(payload);

  const approvedStore = createApprovalStore();
  const approved = createPendingApproval(approvedStore, "exec:approve", action, target, digest, 1000);
  let settled = false;
  const approvalWait = waitForApprovalDecision(approvedStore, approved.approvalId).then((value) => { settled = true; return value; });
  await Promise.resolve();
  assertEquals(settled, false, "the originating tool promise remains pending before the owner decides");
  assertEquals(resolvePendingApproval(approvedStore, approved.approvalId, true).decision, "approved");
  assertEquals((await approvalWait).decision, "approved");
  assertEquals(consumeApproved(approvedStore, "exec:approve", action, target, digest).ok, true, "the same tool invocation consumes the exact decision once");

  const deniedStore = createApprovalStore();
  const denied = createPendingApproval(deniedStore, "exec:deny", action, target, digest, 1000);
  const denialWait = waitForApprovalDecision(deniedStore, denied.approvalId);
  assertEquals(resolvePendingApproval(deniedStore, denied.approvalId, false).decision, "denied");
  assertEquals((await denialWait).decision, "denied");
  assertEquals(consumeApproved(deniedStore, "exec:deny", action, target, digest).ok, false, "deny grants nothing");

  const expiredStore = createApprovalStore();
  const expired = createPendingApproval(expiredStore, "exec:expire", action, target, digest, 15);
  const expiry = await waitForApprovalDecision(expiredStore, expired.approvalId);
  assertEquals(expiry.decision, "expired");
  assertEquals(consumeApproved(expiredStore, "exec:expire", action, target, digest).ok, false, "timeout grants nothing");
  assertEquals(resolvePendingApproval(expiredStore, expired.approvalId, true).ok, false, "a late click cannot revive expired work");
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
  for (const hash of ["#providers", "#tool-library", "#agents", "#background", "#background-agents", "#browser", "#permissions", "#hooks", "#prompts", "#usage", "#data", "#about"]) {
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
  assertEquals(hashes.length, SETTINGS_SECTIONS.length, "the complete Settings navigation is covered by this authority drift test");
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

// CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01: a model-created script, a
// model-run script, and a model-scheduled script are approvable destructive
// actions (the card shows the source + the hosts it fetches). The owner's own
// Settings/hub action on the same routes is owner-direct.
Deno.test("script.create / script.run / task.schedule-script are approvable destructive actions", () => {
  for (const action of ["script.create", "script.run", "task.schedule-script"]) {
    assert(DESTRUCTIVE_ACTIONS.has(action), `${action} must be in DESTRUCTIVE_ACTIONS`);
    assertEquals(isOwnerDirectApproval({ principal: "model", executionId: "exec-1" }, action), false, action);
  }
  for (const action of ["script.create", "script.run"]) {
    assertEquals(isOwnerDirectApproval({ principal: "owner-options", documentId: "doc-1" }, action), true, action);
    assertEquals(isOwnerDirectApproval({ principal: "page", documentId: "doc-1" }, action), false, action);
  }
  // A card can carry the script source + fetch hosts (bounded) for these
  // actions and for no other.
  const withDetail = approvalCardDenial({ approvalId: "a1", action: "script.run", targetRef: "ref", detail: { source: "return 1", hosts: ["example.com"], dynamic: false } });
  assertEquals(withDetail.permissionRequirement.approvals[0].detail, { source: "return 1", hosts: ["example.com"], dynamic: false });
  const other = approvalCardDenial({ approvalId: "a1", action: "asset.delete", targetRef: "ref", detail: { source: "x", hosts: [], dynamic: false } });
  assertEquals(other.permissionRequirement.approvals[0].detail, undefined);
});

// CAP-FB-20260831-WORKFLOWS-TO-MEMORY-01 (review blocker 1): a model-run saved
// workflow executes a script body — the same controlled-fetch + SSRF channel as
// script.run — so it must be an approvable destructive action (the card shows
// the exact source + hosts), and the owner's own run from an extension surface
// is owner-direct.
Deno.test("workflow.run is an approvable destructive action (owner approval is reachable)", () => {
  assert(DESTRUCTIVE_ACTIONS.has("workflow.run"), "workflow.run must be in DESTRUCTIVE_ACTIONS");
  assert(SOURCE_DISCLOSING_ACTIONS.has("workflow.run"), "workflow.run must disclose the source on the card");
  // A MODEL-initiated run pays the approval card; the owner's own run is direct.
  assertEquals(isOwnerDirectApproval({ principal: "model", executionId: "exec-1" }, "workflow.run"), false);
  assertEquals(isOwnerDirectApproval({ principal: "owner-options", documentId: "doc-1" }, "workflow.run"), true);
  assertEquals(isOwnerDirectApproval({ principal: "page", documentId: "doc-1" }, "workflow.run"), false);
});

// CAP-FB-20260830-EDIT-APPROVAL-SHOWS-DIFF-01: a model-initiated asset.update /
// script.update stages the PRIVATE edit detail (current + proposed body) so the
// owner surface can render the diff on the approval card. The record is gated to
// the owner surfaces only, never enters the model-facing envelope, and is
// evicted with its approval row.
const EDIT_V1 = [
  "<!doctype html>", "<html>", "  <body>", "    <h1>Crumb</h1>",
  "    <p>Fresh sourdough, baked daily.</p>", "  </body>", "</html>",
].join("\n");
const EDIT_V2 = [
  "<!doctype html>", "<html>", "  <body>", "    <h1>Crumb Bakery</h1>",
  "    <p>Fresh sourdough and pastries, baked daily.</p>",
  "    <h2>Opening hours</h2>", "    <p>Mon to Sat, 7am to 3pm.</p>", "  </body>", "</html>",
].join("\n");
const editTarget = canonicalOperationTarget("asset", { origin: "master", id: "a_1" });
const editDigest = "a".repeat(64);

Deno.test("approval.detail is refused for the model principal and for page senders", () => {
  // Only the owner surfaces (the conversation's extension document, or Settings)
  // may read the staged diff bodies.
  assertEquals(mayReadApprovalDetail("extension"), true);
  assertEquals(mayReadApprovalDetail("owner-options"), true);
  // The model principal and any page / content-script sender are refused.
  assertEquals(mayReadApprovalDetail("model"), false);
  assertEquals(mayReadApprovalDetail("page"), false);
  assertEquals(mayReadApprovalDetail("content-script"), false);
  assertEquals(mayReadApprovalDetail(undefined), false);
  assertEquals(mayReadApprovalDetail(""), false);
});

Deno.test("the staged detail is evicted when the approval resolves or expires", async () => {
  const store = createApprovalStore();
  const detail = { kind: "asset.update", name: "crumb.html", oldContent: EDIT_V1, newContent: EDIT_V2, added: 4, removed: 2 };

  // Staging fails closed without a pending row.
  assertEquals(stageApprovalDetail(store, "ap_none", detail).ok, false);

  // Deny evicts.
  const denied = createPendingApproval(store, "run-deny", "asset.update", editTarget, editDigest);
  assert(denied.ok);
  assertEquals(stageApprovalDetail(store, denied.approvalId, detail).ok, true);
  assert(getStagedApprovalDetail(store, denied.approvalId) !== null);
  resolvePendingApproval(store, denied.approvalId, false);
  assertEquals(getStagedApprovalDetail(store, denied.approvalId), null);

  // Approve then consume evicts (the row lingers between approve and consume).
  const approved = createPendingApproval(store, "run-approve", "asset.update", editTarget, editDigest);
  assert(approved.ok);
  stageApprovalDetail(store, approved.approvalId, detail);
  resolvePendingApproval(store, approved.approvalId, true);
  assert(getStagedApprovalDetail(store, approved.approvalId) !== null);
  assertEquals(consumeApproved(store, "run-approve", "asset.update", editTarget, editDigest).ok, true);
  assertEquals(getStagedApprovalDetail(store, approved.approvalId), null);

  // TTL expiry evicts (sweep on the next read).
  const expiring = createPendingApproval(store, "run-expire", "asset.update", editTarget, editDigest, 5);
  assert(expiring.ok);
  stageApprovalDetail(store, expiring.approvalId, detail);
  assert(getStagedApprovalDetail(store, expiring.approvalId) !== null);
  await new Promise((r) => setTimeout(r, 25));
  assertEquals(getStagedApprovalDetail(store, expiring.approvalId), null);
});

Deno.test("staged added/removed equals structuredPatch of the two bodies", () => {
  const store = createApprovalStore();
  const pending = createPendingApproval(store, "run-diff", "asset.update", editTarget, editDigest);
  assert(pending.ok);
  // The reference counts from the shipped diff core.
  const patch = structuredPatch("crumb.html", "crumb.html", EDIT_V1, EDIT_V2, undefined, undefined, { context: 3 });
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line[0] === "+") added++;
      else if (line[0] === "-") removed++;
    }
  }
  assert(added > 0 && removed > 0, "the fixture edit must add and remove lines");
  assertEquals(stageApprovalDetail(store, pending.approvalId, {
    kind: "asset.update", name: "crumb.html", oldContent: EDIT_V1, newContent: EDIT_V2, added, removed,
  }).ok, true);
  const staged = getStagedApprovalDetail(store, pending.approvalId);
  assert(staged);
  assertEquals(staged.added, added);
  assertEquals(staged.removed, removed);
  // The stored bodies are exactly the ones the counts describe (the card diffs
  // these, so the title's +n -m can never disagree with the rendered hunks).
  assertEquals(staged.oldContent, EDIT_V1);
  assertEquals(staged.newContent, EDIT_V2);
  assertEquals(staged.oldLabel, "crumb.html (current)");
  assertEquals(staged.newLabel, "crumb.html (proposed)");
});

Deno.test("boundStagedApprovalDetail drops a malformed or model-forbidden record and never leaks it to the model envelope", () => {
  // Unknown kind, missing name → dropped (the card falls back to the opaque form).
  assertEquals(boundStagedApprovalDetail({ kind: "asset.delete", name: "x", oldContent: "a", newContent: "b" }), null);
  assertEquals(boundStagedApprovalDetail({ kind: "asset.update", name: "", oldContent: "a", newContent: "b" }), null);
  assertEquals(boundStagedApprovalDetail(null), null);
  assertEquals(boundStagedApprovalDetail("nope"), null);
  // Negative / non-integer counts are floored to 0, bodies coerced to strings.
  const bounded = boundStagedApprovalDetail({ kind: "asset.update", name: "n", oldContent: "a", newContent: "b", added: -3, removed: 1.5 });
  assertEquals(bounded?.added, 0);
  assertEquals(bounded?.removed, 0);
  // The model-facing envelope (approvalCardDenial) never carries the staged
  // bodies for an edit action — the current body is not necessarily model-authored.
  const envelope = approvalCardDenial({ approvalId: "a1", action: "asset.update", targetRef: "ref", detail: { source: EDIT_V1, hosts: [], dynamic: false } });
  assertEquals(envelope.permissionRequirement.approvals[0].detail, undefined);
  assert(!JSON.stringify(envelope).includes("Opening hours"));
});
