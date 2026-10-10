// @ts-nocheck — the OPFS fake is intentionally dynamic.
// Exact first-use WebMCP consent: enrollment is discovery, not automatic use.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  disenrollOrigin,
  enrollOrigin,
  reEnrollOrigin,
  isApproved,
  listTools,
  pendingApprovals,
  replaceTools,
  resetToolConsents,
  setToolConsentDecision,
  toolConsentSnapshot,
} from "../extension/lib/tools.js";
import { siteMemory } from "../extension/lib/memory.js";
import {
  currentSiteToolConsentProfileEpoch,
  invalidateSiteToolConsentWriters,
  SITE_TOOL_CONSENT_KEY,
  siteToolIdentity,
  promoteEphemeralSiteToolConsents,
} from "../extension/lib/site-tool-consent.js";
import { createEphemeralSiteToolConsentStore } from "../extension/lib/ephemeral-site-tool-consent.js";

function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; }
  async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() { this.node.content = this.parts.join(""); }
}
class FakeFileHandle {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() {
    const node = this.node;
    return { size: new TextEncoder().encode(node.content ?? "").byteLength, async text() { return node.content ?? ""; } };
  }
  async createWritable() { return new FakeWritable(this.node); }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no dir ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`no file ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
  configurable: true,
  writable: true,
});

const BOOK = { name: "book_table_le_petit_bistro", source: "declared", description: "Book a table", inputSchema: { type: "object" } };

Deno.test("first-use consent: a newly enrolled exact tool starts ASK", async () => {
  const origin = "https://consent-a.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK]);
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "ask");
  assertEquals(await isApproved(origin, BOOK.name), false);
  assertEquals((await pendingApprovals(origin)).map((tool) => tool.name), [BOOK.name]);
});

Deno.test("first-use consent: Allow persists and exact reset rearms", async () => {
  const origin = "https://consent-b.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK]);
  const before = await toolConsentSnapshot(origin, BOOK.name);
  const allowed = await setToolConsentDecision(origin, BOOK.name, "allowed", { expected: before });
  assertEquals(allowed.state, "allowed");
  assertEquals(await isApproved(origin, BOOK.name), true);
  assert((await toolConsentSnapshot(origin, BOOK.name)).revision > before.revision);
  await setToolConsentDecision(origin, BOOK.name, "ask");
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "ask");
});

Deno.test("first-use consent: later tool asks separately; site automatic reset leaves sticky Deny", async () => {
  const origin = "https://consent-c.example.com";
  const late = { name: "cancel_reservation", source: "declared", description: "Cancel", inputSchema: { type: "object" } };
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK, late]);
  await setToolConsentDecision(origin, BOOK.name, "allowed");
  await setToolConsentDecision(origin, late.name, "denied");
  assertEquals((await toolConsentSnapshot(origin, late.name)).state, "denied");
  await resetToolConsents(origin, "automatic");
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "ask");
  assertEquals((await toolConsentSnapshot(origin, late.name)).state, "denied");
  await resetToolConsents(origin, "all");
  assertEquals((await toolConsentSnapshot(origin, late.name)).state, "ask");
});

Deno.test("first-use consent: every site reset fences a stale ASK even when no decision changes", async () => {
  for (const mode of ["all", "automatic"]) {
    const origin = `https://consent-empty-reset-${mode}.example.com`;
    await enrollOrigin(origin);
    await replaceTools(origin, [BOOK]);
    const stale = await toolConsentSnapshot(origin, BOOK.name);
    const reset = await resetToolConsents(origin, mode);
    assert(reset.revision > stale.revision);
    assertEquals(reset.removed, []);
    await assertRejects(
      () => setToolConsentDecision(origin, BOOK.name, "allowed", { expected: stale }),
      Error,
      "site_tool_consent_changed",
    );
    assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "ask");
  }
});

Deno.test("first-use consent: descriptor drift rearms Allow but cannot evade sticky Deny", async () => {
  const origin = "https://consent-d.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK]);
  await setToolConsentDecision(origin, BOOK.name, "allowed");
  await replaceTools(origin, [{ ...BOOK, inputSchema: { type: "object", properties: { party: { type: "integer" } } } }]);
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "ask", "changed execution identity rearms Allow");
  await setToolConsentDecision(origin, BOOK.name, "denied");
  await replaceTools(origin, [{ ...BOOK, source: "inferred" }]);
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "denied", "same exact name cannot mutate around Deny");
});

Deno.test("Q23 n6c31: enrolled consent Deny is sticky across tool name casing variants", async () => {
  const origin = "https://consent-casing.example.com";
  const tool = { name: "BookTable", source: "declared", description: "Book a table", inputSchema: { type: "object" } };
  await enrollOrigin(origin);
  await replaceTools(origin, [tool]);

  // Starts in ASK
  assertEquals((await toolConsentSnapshot(origin, "BookTable")).state, "ask");

  // Owner denies "BookTable"
  await setToolConsentDecision(origin, "BookTable", "denied");
  assertEquals((await toolConsentSnapshot(origin, "BookTable")).state, "denied");

  // Page re-registers tool under different casing: lowercase "booktable"
  await replaceTools(origin, [{ ...tool, name: "booktable" }]);
  assertEquals(
    (await toolConsentSnapshot(origin, "booktable")).state,
    "denied",
    "lowercase re-registration must honor sticky Deny",
  );
  assertEquals(await isApproved(origin, "booktable"), false);

  // Page re-registers tool under different casing: uppercase "BOOKTABLE"
  await replaceTools(origin, [{ ...tool, name: "BOOKTABLE" }]);
  assertEquals(
    (await toolConsentSnapshot(origin, "BOOKTABLE")).state,
    "denied",
    "uppercase re-registration must honor sticky Deny",
  );
  assertEquals(await isApproved(origin, "BOOKTABLE"), false);

  // Mixed casing "bookTable"
  await replaceTools(origin, [{ ...tool, name: "bookTable" }]);
  assertEquals(
    (await toolConsentSnapshot(origin, "bookTable")).state,
    "denied",
    "mixed-case re-registration must honor sticky Deny",
  );

  // Unrelated tool remains ASK
  await replaceTools(origin, [{ ...tool, name: "other_tool" }]);
  assertEquals((await toolConsentSnapshot(origin, "other_tool")).state, "ask", "unrelated tool remains ask");

  // Re-register "booktable" so it is declared on the site
  await replaceTools(origin, [{ ...tool, name: "booktable" }]);

  // Owner explicitly changes consent in Settings: Allow replaces Deny
  await setToolConsentDecision(origin, "booktable", "allowed");
  assertEquals((await toolConsentSnapshot(origin, "booktable")).state, "allowed");
  assertEquals(await isApproved(origin, "booktable"), true);
});

Deno.test("first-use consent: re-enrollment generation cannot resurrect an old grant", async () => {
  const origin = "https://consent-e.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK]);
  await setToolConsentDecision(origin, BOOK.name, "allowed");
  await disenrollOrigin(origin);
  assertEquals(await isApproved(origin, BOOK.name), false);
  await enrollOrigin(origin);
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "ask");
});

Deno.test("first-use consent: prototype-looking exact names stay isolated", async () => {
  const origin = "https://consent-f.example.com";
  const tools = ["__proto__", "constructor"].map((name) => ({ ...BOOK, name }));
  await enrollOrigin(origin);
  await replaceTools(origin, tools);
  await setToolConsentDecision(origin, "__proto__", "allowed");
  assertEquals((await toolConsentSnapshot(origin, "__proto__")).state, "allowed");
  assertEquals((await toolConsentSnapshot(origin, "constructor")).state, "ask");
});

Deno.test("first-use consent: stale card revision cannot resurrect authority after reset", async () => {
  const origin = "https://consent-g.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK]);
  const stale = await toolConsentSnapshot(origin, BOOK.name);
  await setToolConsentDecision(origin, BOOK.name, "allowed");
  await setToolConsentDecision(origin, BOOK.name, "ask");
  await assertRejects(
    () => setToolConsentDecision(origin, BOOK.name, "allowed", { expected: stale }),
    Error,
    "site_tool_consent_changed",
  );
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "ask");
});

Deno.test("first-use consent: persisted envelopes and records accept only the exact plain shape", async () => {
  const origin = "https://consent-corrupt.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK]);
  const snapshot = await toolConsentSnapshot(origin, BOOK.name);
  const record = {
    name: snapshot.name,
    source: snapshot.source,
    identityDigest: snapshot.identityDigest,
    state: "allowed",
    revision: 1,
    decidedAt: 1,
  };
  const variants = [
    { version: 1, enrollmentGen: snapshot.enrollmentGen, revision: 1, records: [record], extra: true },
    { version: 1, enrollmentGen: snapshot.enrollmentGen, revision: 1, records: [{ ...record, extra: true }] },
    { version: 1, enrollmentGen: snapshot.enrollmentGen, revision: 1, records: [record, { ...record }] },
    { version: 1, enrollmentGen: snapshot.enrollmentGen, revision: 0, records: [record] },
  ];
  for (const variant of variants) {
    await siteMemory(origin).setTrusted(SITE_TOOL_CONSENT_KEY, variant);
    await assertRejects(
      () => toolConsentSnapshot(origin, BOOK.name),
      Error,
      "site_tool_consent_corrupt",
    );
  }
});

Deno.test("first-use consent: a profile-reset fence rejects a writer captured before the wipe", async () => {
  const origin = "https://consent-reset-fence.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK]);
  const before = await toolConsentSnapshot(origin, BOOK.name);
  const writerEpoch = currentSiteToolConsentProfileEpoch();
  invalidateSiteToolConsentWriters();
  await assertRejects(
    () => setToolConsentDecision(origin, BOOK.name, "allowed", {
      expected: before,
      expectedProfileEpoch: writerEpoch,
    }),
    Error,
    "site_tool_consent_profile_changed",
  );
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "ask");
});

Deno.test("first-use consent: a cancelled run guard blocks its late durable Allow", async () => {
  const origin = "https://consent-run-cancel.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK]);
  const before = await toolConsentSnapshot(origin, BOOK.name);
  await assertRejects(
    () => setToolConsentDecision(origin, BOOK.name, "allowed", {
      expected: before,
      commitGuard: () => false,
    }),
    Error,
    "site_tool_consent_run_cancelled",
  );
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "ask");
});

Deno.test("consent migration primitive: owner enrollment carries Allow AND sticky Deny without a pre-enrollment site store", async () => {
  const origin = "https://attached-promotion.example.com";
  const store = createEphemeralSiteToolConsentStore();
  const token = store.begin({ origin, tabId: 71, documentId: "doc-promotion", runId: "run-promotion", threadId: "thread-promotion" });
  const denyTool = { ...BOOK, name: "cancel_reservation" };
  store.decide(token, BOOK, "allowed");
  store.decide(token, denyTool, "denied");
  const { listOrigins } = await import("../extension/lib/memory.js");
  assertEquals((await listOrigins()).includes(origin), false, "unenrolled decisions did not create a Site Agent store");
  await enrollOrigin(origin); // only the owner's explicit enrollment path may promote
  await replaceTools(origin, [BOOK, denyTool]);
  const gen = (await toolConsentSnapshot(origin, BOOK.name)).enrollmentGen;
  await store.withPromotionForOrigin(origin, (records, isCurrent) =>
    promoteEphemeralSiteToolConsents(origin, gen, records, { commitGuard: isCurrent }));
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "allowed");
  await replaceTools(origin, [BOOK, { ...denyTool, inputSchema: { type: "string" } }]);
  assertEquals((await toolConsentSnapshot(origin, denyTool.name)).state, "denied", "Deny survives descriptor drift");
  assertThrows(() => store.snapshot(token, BOOK), Error, "ephemeral_site_tool_run_not_live");
});

Deno.test("consent migration primitive: failed copy leaves no partial Allow or Deny and a live run may retry", async () => {
  const origin = "https://attached-promotion-retry.example.com";
  const store = createEphemeralSiteToolConsentStore();
  const token = store.begin({ origin, tabId: 72, documentId: "doc-retry", runId: "run-retry" });
  store.decide(token, BOOK, "allowed");
  store.decide(token, { ...BOOK, name: "cancel_reservation" }, "denied");
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK, { ...BOOK, name: "cancel_reservation" }]);
  const gen = (await toolConsentSnapshot(origin, BOOK.name)).enrollmentGen;
  await assertRejects(() => store.withPromotionForOrigin(origin, (records) =>
    promoteEphemeralSiteToolConsents(origin, gen, records, { commitGuard: () => false })), Error);
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "ask");
  assertEquals((await toolConsentSnapshot(origin, "cancel_reservation")).state, "ask");
  assertEquals(store.snapshot(token, BOOK).state, "allowed");
  await store.withPromotionForOrigin(origin, (records, isCurrent) =>
    promoteEphemeralSiteToolConsents(origin, gen, records, { commitGuard: isCurrent }));
  assertEquals((await toolConsentSnapshot(origin, BOOK.name)).state, "allowed");
  assertEquals((await toolConsentSnapshot(origin, "cancel_reservation")).state, "denied");
});

Deno.test("first-use consent: descriptor identity rejects hostile outer shapes without invoking accessors", () => {
  const origin = "https://consent-identity.example.com";
  let getterRuns = 0;
  const accessor = { source: "declared", inputSchema: {} };
  Object.defineProperty(accessor, "name", {
    enumerable: true,
    get() { getterRuns++; throw new Error("getter ran"); },
  });
  assertThrows(() => siteToolIdentity(origin, accessor), Error, "site_tool_identity_invalid");
  assertEquals(getterRuns, 0);
  assertThrows(
    () => siteToolIdentity(origin, Object.assign(Object.create({ inherited: true }), BOOK)),
    Error,
    "site_tool_identity_invalid",
  );
  assertThrows(
    () => siteToolIdentity(origin, { ...BOOK, [Symbol("hidden")]: true }),
    Error,
    "site_tool_identity_invalid",
  );
});

Deno.test("first-use consent: re-enrollment preserves sticky Deny while reverting Allow to ASK", async () => {
  const origin = "https://re-enroll-sticky.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [
    { ...BOOK, name: "tool_allow" },
    { ...BOOK, name: "tool_deny" },
  ]);
  const s1 = await toolConsentSnapshot(origin, "tool_allow");
  await setToolConsentDecision(origin, "tool_allow", "allowed");
  const s2 = await toolConsentSnapshot(origin, "tool_deny");
  await setToolConsentDecision(origin, "tool_deny", "denied");

  assertEquals((await toolConsentSnapshot(origin, "tool_allow")).state, "allowed");
  assertEquals((await toolConsentSnapshot(origin, "tool_deny")).state, "denied");

  // Re-enroll origin advances generation
  const re = await reEnrollOrigin(origin);
  assertEquals(re.enrolled, true);
  assert(re.gen > s1.enrollmentGen);

  // tool_allow must revert to ASK in the new generation
  assertEquals((await toolConsentSnapshot(origin, "tool_allow")).state, "ask");
  // tool_deny must remain sticky DENIED in the new generation!
  assertEquals((await toolConsentSnapshot(origin, "tool_deny")).state, "denied");
});

Deno.test("first-use consent SW wiring: exact state drives availability, guard, card and audit", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes("initialConsentByTool"));
  assert(sw.includes("consentSnapshot: toolConsentSnapshot"));
  assert(sw.includes("requestSiteToolFirstUse"));
  assert(sw.includes("appendRequiredSiteToolAudit"));
  assert(sw.includes("verifySiteToolAuthorization"));
  assert(sw.includes('async "webmcp.consent.tool.set"'));
  assert(sw.includes("requireSettingsSender(context)"));
  assert(sw.includes('const affected = states.filter((state) => resetMode === "all" || state.state !== "denied");'));
  assert(sw.includes("if (pending?.origin !== canonical) continue;"));
  assert(sw.includes("pending.cancelled = true;"));
  assert(sw.includes("cancelPendingApproval("));
  assert(
    sw.indexOf("const decisionWait = waitForApprovalDecision(ownerApprovalStore, pending.approvalId);") <
      sw.indexOf("await context.onApprovalEvent({"),
    "the cancellation waiter exists before the card is published",
  );
  assert(!sw.includes("if (affected.length) await invalidateSiteToolWork(canonical);"));
  assert(!sw.includes("if (enrolled) return true;"), "enrollment blanket approval is gone");
  assertEquals((await listTools("https://consent-a.example.com")).length, 1);
});

Deno.test("T1 out-of-order: two calls to the SAME tool in ONE execution whose results arrive B-then-A receive own decisions and consume aliases once", async () => {
  const { createExecutionApprovalStore } = await import("../extension/lib/owner-approval.js");
  const store = createExecutionApprovalStore(64);

  // Two calls to SAME tool in one execution
  // Call A: callId "call-A", approvalId "ap-A", decision "approved"
  store.register({
    canonicalId: "ap-A",
    aliases: ["call-A"],
    requirement: { reason: "Call A" },
    decision: "approved",
    tool: "remove_from_cart",
    executionId: "exec-1",
  });

  // Call B: callId "call-B", approvalId "ap-B", decision "denied"
  store.register({
    canonicalId: "ap-B",
    aliases: ["call-B"],
    requirement: { reason: "Call B" },
    decision: "denied",
    tool: "remove_from_cart",
    executionId: "exec-1",
  });

  // Both records and all aliases exist before consumption
  assertEquals(store.size, 2);
  assert(store.has("ap-A"));
  assert(store.has("call-A"));
  assert(store.has("ap-B"));
  assert(store.has("call-B"));

  // Out of order arrival: B arrives FIRST
  const consumedB = store.consume("call-B");
  assert(consumedB != null, "Result B must match its exact call ID");
  assertEquals(consumedB.decision, "denied");
  assertEquals(consumedB.canonicalId, "ap-B");

  // Assert B and ALL its aliases are atomically deleted
  assertEquals(store.has("call-B"), false, "call-B must be deleted");
  assertEquals(store.has("ap-B"), false, "ap-B alias must be deleted atomically with call-B");

  // Assert A's record and aliases are completely untouched
  assertEquals(store.size, 1);
  assert(store.has("call-A"), "call-A must remain intact");
  assert(store.has("ap-A"), "ap-A must remain intact");

  // Assert second consume on B returns null (no double consumption)
  assertEquals(store.consume("call-B"), null, "call-B cannot be consumed twice");
  assertEquals(store.consume("ap-B"), null, "ap-B cannot be consumed twice");

  // Now result A arrives
  const consumedA = store.consume("call-A");
  assert(consumedA != null, "Result A must match its exact call ID");
  assertEquals(consumedA.decision, "approved");
  assertEquals(consumedA.canonicalId, "ap-A");

  // Assert A and ALL its aliases are atomically deleted
  assertEquals(store.has("call-A"), false, "call-A must be deleted");
  assertEquals(store.has("ap-A"), false, "ap-A alias must be deleted atomically with call-A");
  assertEquals(store.size, 0, "No records or aliases survive in the store");
  assertEquals(store.consume("call-A"), null);
  assertEquals(store.consume("ap-A"), null);
});

Deno.test("T2 persistence: every field reaching the durable log bounds and redacts long and secret inputs at the persisted value", async () => {
  const {
    boundedAndRedacted,
    normalizeDurableToolCall,
    normalizeDurableToolResult,
  } = await import("../extension/lib/pure.js");

  const longTail = "x".repeat(1000);
  const secretApiKey = "sk-proj-1234567890abcdef1234567890abcdef";
  const secretGitHub = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";

  const rawDurableLog = {
    type: "tool-result",
    id: "task-1",
    executionId: "exec-1",
    callId: "call-1",
    tool: `tool_name_${secretApiKey}_${longTail}`,
    selectedTool: `selected_${secretGitHub}_${longTail}`,
    siteActivity: {
      origin: `https://user:password123@example.com/api?token=${secretApiKey}&other=val#${longTail}`,
      tool: `site_tool_${secretGitHub}_${longTail}`,
    },
    permissionRequirement: {
      reason: `Blocked due to api_key=${secretApiKey} and secret=${secretGitHub} ${longTail}`,
      permissions: [`perm_${secretApiKey}_${longTail}`],
      grantOrigins: [`https://secret:auth@grant.com?key=${secretApiKey}&tail=${longTail}`],
      hostOrigins: [`https://admin:pass@host.com?token=${secretGitHub}&tail=${longTail}`],
      approvals: [
        {
          approvalId: `ap_${secretApiKey}_${longTail}`,
          action: `action_${secretApiKey}_${longTail}`,
          targetRef: `https://ref.com?secret=${secretApiKey}&tail=${longTail}`,
          detail: {
            kind: `kind_${secretApiKey}_${longTail}`,
            origin: `https://user:secret@detail.com?key=${secretApiKey}&tail=${longTail}`,
            tool: `detail_tool_${secretGitHub}_${longTail}`,
            scope: `scope_${secretApiKey}_${longTail}`,
          },
        },
      ],
    },
    result: '{"ok":true}',
  };

  const normalized = normalizeDurableToolResult(rawDurableLog);

  // 1. Assert bounded limits
  assert(normalized.tool.length <= 128, `tool length ${normalized.tool.length} exceeds 128`);
  assert(normalized.selectedTool.length <= 128, `selectedTool length ${normalized.selectedTool.length} exceeds 128`);
  assert(normalized.siteActivity.origin.length <= 240, `siteActivity.origin length ${normalized.siteActivity.origin.length} exceeds 240`);
  assert(normalized.siteActivity.tool.length <= 128, `siteActivity.tool length ${normalized.siteActivity.tool.length} exceeds 128`);
  assert(normalized.permissionRequirement.reason.length <= 240, `reason length ${normalized.permissionRequirement.reason.length} exceeds 240`);
  assert(normalized.permissionRequirement.permissions[0].length <= 64, `permissions length exceeds 64`);
  assert(normalized.permissionRequirement.grantOrigins[0].length <= 240, `grantOrigins length exceeds 240`);
  assert(normalized.permissionRequirement.hostOrigins[0].length <= 240, `hostOrigins length exceeds 240`);

  const app = normalized.permissionRequirement.approvals[0];
  assert(app.approvalId.length <= 64, `approvalId length exceeds 64`);
  assert(app.action.length <= 64, `action length exceeds 64`);
  assert(app.targetRef.length <= 240, `targetRef length exceeds 240`);
  assert(app.detail.kind.length <= 32, `detail.kind length exceeds 32`);
  assert(app.detail.origin.length <= 240, `detail.origin length exceeds 240`);
  assert(app.detail.tool.length <= 1024, `detail.tool length exceeds 1024`);
  assert(app.detail.scope.length <= 32, `detail.scope length exceeds 32`);

  // 2. Assert no secret pattern survived anywhere in the normalized entry
  const json = JSON.stringify(normalized);
  assert(!json.includes(secretApiKey), "secretApiKey must be redacted from durable log");
  assert(!json.includes(secretGitHub), "secretGitHub must be redacted from durable log");
  assert(!json.includes("password123"), "userinfo password must be redacted from durable log");
  assert(!json.includes("user:secret@"), "user:secret must be redacted from durable log");
  assert(!json.includes("secret:auth@"), "secret:auth must be redacted from durable log");
  assert(!json.includes("admin:pass@"), "admin:pass must be redacted from durable log");
  assert(!json.includes("?token="), "URL token query must be stripped from durable log");
  assert(!json.includes("?key="), "URL key query must be stripped from durable log");
});

Deno.test("T3 durable append: actual appendLog path allowlists, bounds, and redacts adversarial input without throwing", async () => {
  const {
    normalizeDurableToolCall,
    normalizeDurableToolResult,
  } = await import("../extension/lib/pure.js");
  const { createDurableRunRegistry } = await import("../extension/lib/durable-runs.js");
  const { createMemoryRunLogHandles } = await import("./fixtures/run-log-wal-memory.js");

  class MemoryStore {
    values = new Map();
    versions = new Map();
    async get(k) { return structuredClone(this.values.get(k) ?? null); }
    async has(k) { return this.values.has(k); }
    async getVersion(k) { return this.versions.get(k) ?? 0; }
    async snapshot(k) {
      return { exists: this.values.has(k), value: this.values.has(k) ? structuredClone(this.values.get(k)) : null, version: this.versions.get(k) ?? 0 };
    }
    async setTrusted(k, v) {
      const ver = (this.versions.get(k) ?? 0) + 1;
      this.values.set(k, structuredClone(v));
      this.versions.set(k, ver);
      return ver;
    }
    async keys() { return [...this.values.keys()]; }
    async compareAndDelete(k, expectedVersion) {
      if ((this.versions.get(k) ?? 0) !== expectedVersion) return false;
      this.values.delete(k);
      this.versions.delete(k);
      return true;
    }
    async compareAndRestore(key, expected, value) {
      if ((this.versions.get(key) ?? 0) !== expected) return false;
      await this.setTrusted(key, value);
      return true;
    }
  }

  const store = new MemoryStore();
  const registry = createDurableRunRegistry({
    store,
    logHandleFor: createMemoryRunLogHandles(),
  });

  const executionId = "exec_adversarial_t3_12345678";
  await registry.start({
    executionId,
    clientCorrelationId: "client-corr-1",
    threadId: "thread-t3",
    kind: "task",
    taskPreview: "adversarial durable run",
    journalTarget: "master",
    resumeRequest: { id: "task-t3", task: "adversarial test", memoryOrigin: "master", providerBinding: { schemaVersion: 1, provider: "demo", model: "demo", requestedScope: null, local: true }, idempotencyKey: executionId },
  });

  // Construct adversarial inputs:
  const secret100k = "sk-ant-api03-" + "A".repeat(100000);
  const thousandItemArray = Array.from({ length: 1000 }, (_, i) => `item_${i}_${secret100k.slice(0, 30)}`);
  const circularObj = { name: "circular-root" };
  circularObj.self = circularObj;

  // 1. Tool-Call entry with adversarial inputs & unknown extra fields
  const rawToolCall = {
    type: "tool-call",
    id: "task-call-1",
    executionId,
    callId: "call-1",
    tool: `tool_${secret100k}`,
    args: JSON.stringify({ argKey: secret100k.slice(0, 500) }),
    unknownExtraFieldOnCall: "should_be_dropped",
    hostileNestedObject: circularObj,
    unboundedArray: thousandItemArray,
  };

  // 2. Tool-Result entry with adversarial inputs, non-array grantOrigins, unknown extra fields, circular object, 100k secret, 1000-item array
  const rawToolResult = {
    type: "tool-result",
    id: "task-result-1",
    executionId,
    callId: "call-1",
    tool: `tool_${secret100k}`,
    result: JSON.stringify({ output: "done" }),
    ok: true,
    unknownExtraFieldOnResult: "should_be_dropped",
    circularField: circularObj,
    siteActivity: {
      origin: `https://user:password123@example.com?secret=${secret100k}`,
      tool: `site_tool_${secret100k}`,
      extraSiteActivityField: "dropped",
    },
    permissionRequirement: {
      reason: `Blocked reason containing secret ${secret100k}`,
      permissions: thousandItemArray,
      grantOrigins: "not-an-array-origin-hostile-input", // NON-ARRAY grantOrigins
      grantGlobal: false,
      hostOrigins: thousandItemArray,
      extraPermissionField: "dropped",
      approvals: [
        {
          approvalId: `app_${secret100k}`,
          action: `act_${secret100k}`,
          targetRef: `https://ref.com?key=${secret100k}`,
          detail: {
            kind: `kind_${secret100k}`,
            origin: `https://detail.com?token=${secret100k}`,
            tool: `detail_tool_${secret100k}`,
            scope: `scope_${secret100k}`,
            circularDetail: circularObj,
            extraDetailField: "dropped",
          },
          extraApprovalField: "dropped",
        },
      ],
    },
  };

  // Verify falsification: raw adversarial input with circular references throws in appendLog
  let rawAppendFailed = false;
  try {
    await registry.appendLog(executionId, rawToolResult, "tool-result:unnormalized");
  } catch {
    rawAppendFailed = true;
  }
  assertEquals(rawAppendFailed, true, "unnormalized adversarial input with circular structure must fail appendLog");

  // Drive through the ACTUAL durable append path using the normalizers
  // Must NOT throw
  let callAppendErr = null;
  let resultAppendErr = null;
  try {
    await registry.appendLog(executionId, normalizeDurableToolCall(rawToolCall), "tool-call:call-1");
  } catch (err) {
    callAppendErr = err;
  }
  try {
    await registry.appendLog(executionId, normalizeDurableToolResult(rawToolResult), "tool-result:call-1");
  } catch (err) {
    resultAppendErr = err;
  }

  assertEquals(callAppendErr, null, "tool-call appendLog must not throw on adversarial/circular/huge input");
  assertEquals(resultAppendErr, null, "tool-result appendLog must not throw on adversarial/circular/huge input");

  // Read back the persisted records from durable storage
  const persistedLogs = await registry.listLogs(executionId);
  const persistedCall = persistedLogs.find((r) => r.type === "tool-call");
  const persistedResult = persistedLogs.find((r) => r.type === "tool-result");

  assert(persistedCall, "tool-call log must be persisted and readable");
  assert(persistedResult, "tool-result log must be persisted and readable");

  // Verify allowlisting and bounds on persisted tool-call:
  assertEquals(persistedCall.unknownExtraFieldOnCall, undefined, "extra unknown field must be dropped from tool-call");
  assertEquals(persistedCall.hostileNestedObject, undefined, "extra nested object must be dropped from tool-call");
  assertEquals(persistedCall.unboundedArray, undefined, "extra array must be dropped from tool-call");
  assert(persistedCall.tool.length <= 128, "persisted tool name must be bounded <= 128");
  assert(persistedCall.tool.includes("[REDACTED]"), "persisted tool name must be redacted");
  assert(!persistedCall.tool.includes("AAAAA"), "100k secret must not survive in persisted tool name");

  // Verify allowlisting and bounds on persisted tool-result:
  assertEquals(persistedResult.unknownExtraFieldOnResult, undefined, "extra unknown field must be dropped from tool-result");
  assertEquals(persistedResult.circularField, undefined, "circular field must be dropped from tool-result");
  assert(persistedResult.tool.length <= 128, "persisted tool name on result must be bounded <= 128");

  // Verify non-array grantOrigins was coerced to empty array [] (no leak/raw value)
  assert(Array.isArray(persistedResult.permissionRequirement.grantOrigins), "non-array grantOrigins must be coerced to array");
  assertEquals(persistedResult.permissionRequirement.grantOrigins.length, 0, "non-array grantOrigins must become empty array");

  // Verify permissionRequirement extra fields dropped
  assertEquals(persistedResult.permissionRequirement.extraPermissionField, undefined, "extra field on permissionRequirement must be dropped");
  assert(persistedResult.permissionRequirement.reason.length <= 240, "reason must be bounded <= 240");
  assert(!persistedResult.permissionRequirement.reason.includes("AAAAA"), "100k secret must not survive in reason");
  assert(persistedResult.permissionRequirement.reason.includes("[REDACTED]"), "secret must be redacted in reason");

  // Verify array capping (thousandItemArray capped)
  assert(persistedResult.permissionRequirement.permissions.length <= 8, "permissions array must be capped at 8");
  assert(persistedResult.permissionRequirement.hostOrigins.length <= 50, "hostOrigins array must be capped at 50");

  // Verify approval allowlisting & detail bounds
  const app = persistedResult.permissionRequirement.approvals[0];
  assert(app, "approval must be present in permissionRequirement");
  assertEquals(app.extraApprovalField, undefined, "extraApprovalField must be dropped");
  assertEquals(app.detail.extraDetailField, undefined, "extraDetailField must be dropped");
  assertEquals(app.detail.circularDetail, undefined, "circularDetail must be dropped from detail");
  assert(app.approvalId.length <= 64, "approvalId length <= 64");
  assert(app.detail.origin.length <= 240, "detail.origin length <= 240");
  assert(!app.detail.origin.includes("AAAAA"), "100k secret must not survive in detail.origin");
  assert(app.detail.origin.includes("[REDACTED]") || app.detail.origin.includes("[query redacted]"), "secret must be redacted in detail.origin");

  // Verify siteActivity allowlisting & bounds
  assertEquals(persistedResult.siteActivity.extraSiteActivityField, undefined, "extraSiteActivityField must be dropped");
  assert(persistedResult.siteActivity.origin.length <= 240, "siteActivity.origin length <= 240");
  assert(!persistedResult.siteActivity.origin.includes("password123"), "userinfo password must be redacted from siteActivity");

  // 3. Falsify and verify throwing getters on ALLOWLISTED fields
  const throwingCall = {
    type: "tool-call",
    id: "task-call-2",
    executionId,
    callId: "call-throwing-2",
  };
  Object.defineProperty(throwingCall, "tool", {
    get() { throw new Error("tool getter bomb"); },
    enumerable: true,
  });
  Object.defineProperty(throwingCall, "args", {
    get() { throw new Error("args getter bomb"); },
    enumerable: true,
  });

  const throwingResult = {
    type: "tool-result",
    id: "task-result-2",
    executionId,
    callId: "call-throwing-2",
    ok: true,
  };
  Object.defineProperty(throwingResult, "tool", {
    get() { throw new Error("result tool getter bomb"); },
    enumerable: true,
  });
  Object.defineProperty(throwingResult, "result", {
    get() { throw new Error("result getter bomb"); },
    enumerable: true,
  });
  const throwingSite = {};
  Object.defineProperty(throwingSite, "origin", {
    get() { throw new Error("origin getter bomb"); },
    enumerable: true,
  });
  Object.defineProperty(throwingSite, "tool", {
    get() { throw new Error("site tool getter bomb"); },
    enumerable: true,
  });
  throwingResult.siteActivity = throwingSite;

  const throwingPr = {};
  Object.defineProperty(throwingPr, "reason", {
    get() { throw new Error("reason getter bomb"); },
    enumerable: true,
  });
  throwingResult.permissionRequirement = throwingPr;

  // Confirm falsification: reading throwingCall.tool directly throws
  assertThrows(() => { const _ = throwingCall.tool; }, Error, "tool getter bomb");
  assertThrows(() => { const _ = throwingResult.result; }, Error, "result getter bomb");

  // Normalizer and appendLog must NOT throw on throwing getters
  let throwingCallErr = null;
  let throwingResultErr = null;
  try {
    await registry.appendLog(executionId, normalizeDurableToolCall(throwingCall), "tool-call:call-throwing-2");
  } catch (err) {
    throwingCallErr = err;
  }
  try {
    await registry.appendLog(executionId, normalizeDurableToolResult(throwingResult), "tool-result:call-throwing-2");
  } catch (err) {
    throwingResultErr = err;
  }
  assertEquals(throwingCallErr, null, "tool-call with throwing getter must not throw in appendLog");
  assertEquals(throwingResultErr, null, "tool-result with throwing getter must not throw in appendLog");

  // Read back throwing records from storage: must show bounded placeholder, not throw
  const throwingLogs = await registry.listLogs(executionId);
  const pThrowCall = throwingLogs.find((r) => r.idempotencyKey === "tool-call:call-throwing-2");
  const pThrowResult = throwingLogs.find((r) => r.idempotencyKey === "tool-result:call-throwing-2");
  assert(pThrowCall, "persisted throwing tool-call must be readable");
  assert(pThrowResult, "persisted throwing tool-result must be readable");
  assertEquals(pThrowCall.tool, "[unserializable]", "throwing tool getter must become [unserializable]");
  assertEquals(pThrowCall.args, "[unserializable]", "throwing args getter must become [unserializable]");
  assertEquals(pThrowResult.tool, "[unserializable]", "throwing result tool getter must become [unserializable]");
  assertEquals(pThrowResult.result, "[unserializable]", "throwing result getter must become [unserializable]");
  assertEquals(pThrowResult.siteActivity.origin, "[unserializable]", "throwing site origin getter must become [unserializable]");
  assertEquals(pThrowResult.permissionRequirement.reason, "[unserializable]", "throwing reason getter must become [unserializable]");

  // 4. Falsify and verify Object.create(null) on ALLOWLISTED fields
  // Confirm falsification: String(Object.create(null)) throws TypeError in JavaScript
  assertThrows(() => { String(Object.create(null)); }, TypeError);

  const nullProtoCall = {
    type: "tool-call",
    id: "task-call-3",
    executionId,
    callId: "call-null-3",
    tool: Object.create(null),
    args: Object.create(null),
  };

  const nullProtoResult = {
    type: "tool-result",
    id: "task-result-3",
    executionId,
    callId: "call-null-3",
    tool: Object.create(null),
    result: Object.create(null),
    ok: true,
    siteActivity: {
      origin: Object.create(null),
      tool: Object.create(null),
    },
    permissionRequirement: {
      reason: Object.create(null),
      grantOrigins: [Object.create(null)],
      permissions: [Object.create(null)],
    },
  };

  let nullCallErr = null;
  let nullResultErr = null;
  try {
    await registry.appendLog(executionId, normalizeDurableToolCall(nullProtoCall), "tool-call:call-null-3");
  } catch (err) {
    nullCallErr = err;
  }
  try {
    await registry.appendLog(executionId, normalizeDurableToolResult(nullProtoResult), "tool-result:call-null-3");
  } catch (err) {
    nullResultErr = err;
  }
  assertEquals(nullCallErr, null, "tool-call with Object.create(null) must not throw in appendLog");
  assertEquals(nullResultErr, null, "tool-result with Object.create(null) must not throw in appendLog");

  const nullLogs = await registry.listLogs(executionId);
  const pNullCall = nullLogs.find((r) => r.idempotencyKey === "tool-call:call-null-3");
  const pNullResult = nullLogs.find((r) => r.idempotencyKey === "tool-result:call-null-3");
  assert(pNullCall, "persisted null-proto call must be readable");
  assert(pNullResult, "persisted null-proto result must be readable");
  assert(typeof pNullCall.tool === "string", "null-proto tool must resolve to string");
  assert(typeof pNullCall.args === "string", "null-proto args must resolve to string");
  assert(typeof pNullResult.tool === "string", "null-proto result tool must resolve to string");
  assert(typeof pNullResult.result === "string", "null-proto result must resolve to string");
  assert(typeof pNullResult.siteActivity.origin === "string", "null-proto origin must resolve to string");
  assert(typeof pNullResult.permissionRequirement.reason === "string", "null-proto reason must resolve to string");
});
