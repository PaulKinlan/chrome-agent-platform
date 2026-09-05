// @ts-nocheck — the OPFS fake is intentionally dynamic.
// Coarse site availability is separate from exact first-use tool consent.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable { constructor(node) { this.node = node; this.parts = []; } async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); } async close() { this.node.content = this.parts.join(""); } }
class FakeFileHandle { constructor(node) { this.node = node; } get kind() { return "file"; } async getFile() { const node = this.node; return { size: (node.content ?? "").length, async text() { return node.content ?? ""; } }; } async createWritable() { return new FakeWritable(this.node); } }
class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, options = {}) { if (!this.node.children.has(name)) { if (options.create !== true) throw new Error("missing"); this.node.children.set(name, dirNode()); } return new FakeDirHandle(this.node.children.get(name)); }
  async getFileHandle(name, options = {}) { if (!this.node.children.has(name)) { if (options.create !== true) throw new Error("missing"); this.node.children.set(name, fileNode("")); } return new FakeFileHandle(this.node.children.get(name)); }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() { for (const [name, node] of this.node.children) yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", { value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } }, configurable: true, writable: true });

import {
  disenrollOrigin,
  enrollOrigin,
  enrollmentGeneration,
  enrollmentPolicy,
  enrollmentSnapshot,
  isEnrolled,
  isSiteToolPolicy,
  replaceTools,
  setEnrollmentPolicy,
  setToolConsentDecision,
  SITE_TOOL_POLICIES,
  toolConsentSnapshot,
  toolConsentStatesLocked,
  withEnrollmentLock,
} from "../extension/lib/tools.js";
import {
  evaluateWebmcpAuthority,
  gateWebmcpToolDispatch,
  siteToolConsentPermissionDigest,
  WEBMCP_AUTHORITY_REASONS,
} from "../extension/lib/webmcp-authority.js";
import { DESTRUCTIVE_ACTIONS, canonicalOperationTarget } from "../extension/lib/owner-approval.js";
import { PAGE_ALLOWED_ROUTES } from "../extension/lib/pure.js";

const TOOL = { name: "book_table", source: "declared", description: "Book a table", inputSchema: { type: "object" } };

Deno.test("enrollment policy: closed legacy vocabulary and fresh default", async () => {
  assertEquals(SITE_TOOL_POLICIES, ["allow", "deny", "ask"]);
  assertEquals(isSiteToolPolicy("allow"), true);
  assertEquals(isSiteToolPolicy("deny"), true);
  assertEquals(isSiteToolPolicy("ask"), true);
  assertEquals(isSiteToolPolicy("auto"), false);
  const origin = "https://policy-default.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  assertEquals(await enrollmentPolicy(origin), "allow");
  assertEquals((await toolConsentSnapshot(origin, TOOL.name)).state, "ask", "enrollment is discovery, not automatic-use consent");
});

Deno.test("enrollment policy: every flip advances the enrollment generation", async () => {
  const origin = "https://policy-flip.example.com";
  await enrollOrigin(origin);
  const gen0 = await enrollmentGeneration(origin);
  assertEquals(await setEnrollmentPolicy(origin, "deny"), "deny");
  const gen1 = await enrollmentGeneration(origin);
  assert(gen1 > gen0);
  assertEquals(await setEnrollmentPolicy(origin, "ask"), "ask", "legacy ask remains readable and means first-use semantics");
  const gen2 = await enrollmentGeneration(origin);
  assert(gen2 > gen1);
  assertEquals(await setEnrollmentPolicy(origin, "allow"), "allow");
  assert((await enrollmentGeneration(origin)) > gen2);
  assertEquals(await isEnrolled(origin), true);
});

Deno.test("enrollment policy: invalid and non-enrolled mutations reject", async () => {
  const origin = "https://policy-reject.example.com";
  await assertRejects(() => setEnrollmentPolicy(origin, "auto"), /invalid site tool policy/);
  await assertRejects(() => setEnrollmentPolicy(origin, "allow"), /not enrolled/);
  await assertRejects(() => setEnrollmentPolicy("not an origin", "deny"), /invalid origin/);
});

Deno.test("enrollment policy: re-enrollment resets coarse policy and exact consent generation", async () => {
  const origin = "https://policy-tombstone.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  await setToolConsentDecision(origin, TOOL.name, "allowed");
  await setEnrollmentPolicy(origin, "deny");
  await disenrollOrigin(origin);
  assertEquals(await isEnrolled(origin), false);
  await enrollOrigin(origin);
  assertEquals(await enrollmentPolicy(origin), "allow");
  assertEquals((await toolConsentSnapshot(origin, TOOL.name)).state, "ask", "old-profile grants cannot cross an enrollment generation");
});

Deno.test("enrollment policy: scripting Disable can read consent under its existing enrollment lock", async () => {
  const origin = "https://locked-consent.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  await setToolConsentDecision(origin, TOOL.name, "allowed");
  let timer;
  try {
    const states = await Promise.race([
      withEnrollmentLock(() => toolConsentStatesLocked(origin)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("enrollment lock re-entered")), 250);
      }),
    ]);
    assertEquals(states.length, 1);
    assertEquals(states[0].name, TOOL.name);
    assertEquals(states[0].state, "allowed");
  } finally {
    clearTimeout(timer);
  }
});

Deno.test("enrollment policy: pure authority denies coarse off before exact consent", () => {
  const consent = { state: "allowed", enrollmentGen: 7, revision: 2, identityDigest: "2".repeat(64) };
  const base = {
    enrolled: true,
    enrollmentGen: 7,
    policy: "allow",
    toolPresent: true,
    consentState: consent.state,
    consentEnrollmentGen: consent.enrollmentGen,
    consentRevision: consent.revision,
    identityDigest: consent.identityDigest,
    runGen: 7,
    descriptorInput: { permissionDigest: siteToolConsentPermissionDigest(consent), grantDigest: "g" },
  };
  assertEquals(evaluateWebmcpAuthority(base).ok, true);
  const denied = evaluateWebmcpAuthority({ ...base, policy: "deny" });
  assertEquals(denied.ok, false);
  assertEquals(denied.reason, "site-policy-denied");
  assert(WEBMCP_AUTHORITY_REASONS.includes("site-policy-denied"));
});

Deno.test("enrollment policy: first-use gate separates allowed, ASK, sticky Deny and no-channel", async () => {
  assertEquals(await gateWebmcpToolDispatch({ enrolled: true, policy: "allow", consentState: "allowed" }), { ok: true });
  const coarse = await gateWebmcpToolDispatch({ enrolled: true, policy: "deny", consentState: "allowed" });
  assertEquals(coarse.reason, "site-policy-denied");
  const sticky = await gateWebmcpToolDispatch({
    enrolled: true,
    policy: "allow",
    consentState: "denied",
    askGate: () => { throw new Error("must not re-prompt"); },
  });
  assertEquals(sticky.reason, "tool-consent-denied");
  assertEquals(sticky.sticky, true);
  const noChannel = await gateWebmcpToolDispatch({ enrolled: true, policy: "allow", consentState: "ask" });
  assertEquals(noChannel.reason, "owner-approval-channel-missing");
  let calls = 0;
  const allowed = await gateWebmcpToolDispatch({
    enrolled: true,
    policy: "allow",
    consentState: "ask",
    askGate: async () => { calls++; return { ok: true }; },
  });
  assertEquals(allowed, { ok: true });
  assertEquals(calls, 1);
  const expired = await gateWebmcpToolDispatch({
    enrolled: true,
    policy: "allow",
    consentState: "ask",
    askGate: async () => ({ ok: false, approvalExpired: true, error: "expired" }),
  });
  assertEquals(expired.ok, false);
  assertEquals(expired.approvalExpired, true);
});

Deno.test("enrollment policy: WebMCP approval target is exact origin plus exact tool", () => {
  assert(DESTRUCTIVE_ACTIONS.has("webmcp.use-tool"));
  const target = canonicalOperationTarget("webmcp-tool", { origin: "https://policy.example.com", name: "book_table" });
  assertEquals(target, canonicalOperationTarget("webmcp-tool", { origin: "https://policy.example.com", name: "book_table" }));
  assert(target !== canonicalOperationTarget("webmcp-tool", { origin: "https://policy.example.com", name: "cancel_reservation" }));
  assert(target !== canonicalOperationTarget("webmcp-tool", { origin: "https://other.example.com", name: "book_table" }));
});

Deno.test("enrollment policy SW/UI wiring: mutations are exact Settings-only; Directory is read-only", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes('if (enrollment.policy === "deny") return [];'));
  assert(sw.includes('if (snap.policy === "deny") {'));
  for (const route of [
    "tools.policy.set",
    "webmcp.consent.snapshot",
    "webmcp.consent.tool.set",
    "webmcp.consent.site.reset",
    "webmcp.audit.list",
  ]) {
    assert(sw.includes(`"${route}"`), `${route} registered`);
    assertEquals(PAGE_ALLOWED_ROUTES.has(route), false, `${route} is never page reachable`);
  }
  assert(sw.includes('async "tools.policy.set"({ origin, policy }, context) {\n    requireSettingsSender(context);'));
  assert(sw.includes('async "webmcp.consent.tool.set"({ origin, name, state }, context) {\n    requireSettingsSender(context);'));
  assert(sw.includes("toolConsentStatesLocked(origin)"), "scripting Disable never re-enters its enrollment mutex");
  assert(sw.includes("{ enrollmentLocked: true }"), "required revocation audit uses the held-lock enrollment check");
  const directory = await Deno.readTextFile(new URL("../extension/directory/directory.js", import.meta.url));
  assert(directory.includes("read-only Agent Directory"));
  assert(directory.includes('send("tools.consent.states"'));
  assert(!directory.includes('send("tools.policy.set"'));
  assert(!directory.includes('send("tools.approve"'));
  assert(directory.includes("Open Settings"));
});
