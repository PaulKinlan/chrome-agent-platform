// @ts-nocheck — the OPFS fake is intentionally dynamic.
// Exact first-use WebMCP consent: enrollment is discovery, not automatic use.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  disenrollOrigin,
  enrollOrigin,
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
} from "../extension/lib/site-tool-consent.js";

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
