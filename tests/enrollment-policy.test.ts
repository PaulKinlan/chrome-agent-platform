// @ts-nocheck — the OPFS fake is intentionally dynamic.
// tests/enrollment-policy.test.ts — CAP-FB-20260819-DIRECTORY-TOOL-EXPLORER-01:
// the per-site enrollment policy (allow | deny | ask) that decides whether a
// site's tools are available to agents.
//
// FALSIFICATION GATE: a BLOCKED (deny) site's tools MUST NOT appear in the
// agent toolset and MUST fail closed on invocation with the named reason.
// The toolset builder here mirrors readSiteLazySources EXACTLY (the shipped
// SW function returns [] for a denied site before any record is built), and
// the dispatch gate is the shipped factory (lib/webmcp-authority.js) — zero
// replica drift between the KATs and the service worker.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable { constructor(node) { this.node = node; this.parts = []; }
  async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() { this.node.content = this.parts.join(""); } }
class FakeFileHandle {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() {
    const node = this.node;
    return { size: (node.content ?? "").length, async text() { return node.content ?? ""; } };
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

import {
  disenrollOrigin,
  enrollOrigin,
  enrollmentGeneration,
  enrollmentPolicy,
  enrollmentSnapshot,
  isEnrolled,
  isSiteToolPolicy,
  listTools,
  replaceTools,
  setEnrollmentPolicy,
  SITE_TOOL_POLICIES,
} from "../extension/lib/tools.js";
import {
  createWebmcpAuthorizationGuard,
  evaluateWebmcpAuthority,
  gateWebmcpToolDispatch,
  WEBMCP_AUTHORITY_REASONS,
} from "../extension/lib/webmcp-authority.js";
import {
  DESTRUCTIVE_ACTIONS,
  canonicalOperationTarget,
} from "../extension/lib/owner-approval.js";
import { executableWebMcpToolRecords, LazyToolProtocol } from "../extension/lib/lazy-tool-protocol.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import { sha256Hex, PAGE_ALLOWED_ROUTES } from "../extension/lib/pure.js";

const TOOL = { name: "book_table", source: "declared", description: "Book a table", inputSchema: { type: "object", properties: { partySize: { type: "number" } }, required: ["partySize"] } };

// Build the lazy records EXACTLY as the SW's readSiteLazySources does: a
// DENIED site returns NO records (its tools never enter an agent toolset);
// every other policy builds the full records with the shipped guard.
async function siteRecords(origin, runGenCell, denials, dispatched, askGateGetter = null) {
  const enrollment = await enrollmentSnapshot(origin);
  if (enrollment.policy === "deny") return [];
  const sourceGeneration = `enrollment:${enrollment.gen ?? 0}:document::epoch:0:seq:0`;
  const tools = await listTools(origin);
  const permissionDigestByTool = {};
  const availabilityByTool = {};
  for (const t of tools) {
    const approved = await isApprovedForTest(origin, t.name);
    permissionDigestByTool[t.name] = sha256Hex(`approved:${approved}`);
    availabilityByTool[t.name] = enrollment.enrolled && approved ? "ready" : enrollment.enrolled ? "owner-action-required" : "disabled";
  }
  const authorizationGuard = createWebmcpAuthorizationGuard({
    origin, enrollmentSnapshot, listTools, isApproved: isApprovedForTest, runGenCell,
    onDeny: (decision, target) => denials.push({ reason: decision.reason, name: target.name }),
  });
  return executableWebMcpToolRecords(tools, {
    origin, agentId: origin, documentId: "", version: "page-current",
    sourceGeneration, closureGeneration: sourceGeneration,
    packageDigest: sha256Hex(`webmcp:${origin}:${sourceGeneration}`),
    permissionDigestByTool, grantDigest: sha256Hex(sourceGeneration), availabilityByTool, authorizationGuard,
  }, async ({ name, source, args }) => {
    // The dispatch closure mirrors readSiteLazySources' dispatch-time gate.
    const live = await enrollmentSnapshot(origin);
    const gate = await gateWebmcpToolDispatch({
      enrolled: live.enrolled,
      policy: live.policy,
      askGate: typeof askGateGetter === "function" ? askGateGetter() : null,
      askPayload: { origin, name, source },
    });
    if (gate.ok !== true) return { ok: false, error: gate.error };
    dispatched.push({ name, args });
    return { ok: true, result: "done" };
  });
}

// isApproved lives in tools.js — resolve it here (enrolled ⇒ class-consent).
async function isApprovedForTest(origin, toolName) {
  const { enrolled } = await enrollmentSnapshot(origin);
  if (enrolled) return true;
  return false;
}

async function drive(origin, runGenCell, askGateGetter = null) {
  const denials = [];
  const dispatched = [];
  const protocol = new LazyToolProtocol({
    readSources: () => siteRecords(origin, runGenCell, denials, dispatched, askGateGetter),
    selectionAuthority: new ToolSelectionAuthority(),
  });
  const gen = (await enrollmentSnapshot(origin)).gen;
  const context = { signal: new AbortController().signal, runId: "run-1", taskId: "task-1", agentId: origin, origin, documentId: "", runGeneration: String(gen), catalogGeneration: "1" };
  const search = await protocol.search({ query: "book table" }, context);
  if (!search.ok || !search.results?.length) return { search, exec: null, denials, dispatched };
  const exec = await protocol.execute({ selectionRef: search.results[0].selectionRef, arguments: { partySize: 2 } }, context);
  return { search, exec, denials, dispatched };
}

// ── registry ──────────────────────────────────────────────────────────────

Deno.test("enrollment policy: closed vocabulary + default allow after enroll", async () => {
  assertEquals(SITE_TOOL_POLICIES, ["allow", "deny", "ask"]);
  assertEquals(isSiteToolPolicy("allow"), true);
  assertEquals(isSiteToolPolicy("deny"), true);
  assertEquals(isSiteToolPolicy("ask"), true);
  assertEquals(isSiteToolPolicy("auto"), false);
  const origin = "https://policy-default.example.com";
  await enrollOrigin(origin);
  assertEquals(await enrollmentPolicy(origin), "allow", "a fresh enrollment defaults to allow (enrollment = consent)");
  const snap = await enrollmentSnapshot(origin);
  assertEquals(snap.policy, "allow");
});

Deno.test("enrollment policy: set/get allow→deny→ask→allow + generation bumps on every flip", async () => {
  const origin = "https://policy-flip.example.com";
  await enrollOrigin(origin);
  const gen0 = await enrollmentGeneration(origin);
  assertEquals(await setEnrollmentPolicy(origin, "deny"), "deny");
  assertEquals(await enrollmentPolicy(origin), "deny");
  const gen1 = await enrollmentGeneration(origin);
  assert(gen1 > gen0, "a policy flip is a revocation fence — the generation must bump");
  assertEquals(await setEnrollmentPolicy(origin, "ask"), "ask");
  assertEquals(await enrollmentPolicy(origin), "ask");
  assert((await enrollmentGeneration(origin)) > gen1);
  assertEquals(await setEnrollmentPolicy(origin, "allow"), "allow");
  assertEquals(await enrollmentPolicy(origin), "allow");
  assert((await enrollmentGeneration(origin)) > gen1, "flipping back also bumps — stale catalogs can never outlive a flip");
  // enrollment itself is untouched by policy flips
  assertEquals(await isEnrolled(origin), true);
});

Deno.test("enrollment policy: invalid policies and non-enrolled origins are rejected", async () => {
  const origin = "https://policy-reject.example.com";
  await assertRejects(() => setEnrollmentPolicy(origin, "auto"), /invalid site tool policy/);
  await assertRejects(() => setEnrollmentPolicy(origin, "allow"), /not enrolled/);
  await assertRejects(() => setEnrollmentPolicy("not an origin", "deny"), /invalid origin/);
});

Deno.test("enrollment policy: disenroll clears nothing policy-wise (tombstone keeps semantics; re-enroll resets to allow)", async () => {
  const origin = "https://policy-tombstone.example.com";
  await enrollOrigin(origin);
  await setEnrollmentPolicy(origin, "deny");
  await disenrollOrigin(origin);
  assertEquals(await isEnrolled(origin), false);
  // Not enrolled ⇒ the read defaults to allow (no live tool access either way)
  assertEquals(await enrollmentPolicy(origin), "allow");
  await enrollOrigin(origin);
  assertEquals(await enrollmentPolicy(origin), "allow", "re-enrollment starts from allow — the owner decides again");
});

// ── FALSIFICATION GATE: deny excludes the site's tools from the agent toolset ──

Deno.test("FALSIFICATION: a blocked site's tool does NOT appear in the agent toolset and never dispatches", async () => {
  const origin = "https://policy-deny.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  await setEnrollmentPolicy(origin, "deny");
  const gen = (await enrollmentSnapshot(origin)).gen;
  const records = await siteRecords(origin, { get: () => gen }, [], []);
  assertEquals(records.length, 0, "readSiteLazySources returns NO records for a denied site — the tool must not appear in the agent toolset");
  const { search, exec, denials, dispatched } = await drive(origin, { get: () => gen });
  assertEquals(search?.results?.length ?? 0, 0, "searching for the blocked tool surfaces nothing");
  assertEquals(exec, null, "nothing dispatches — there is no selection to execute");
  assertEquals(denials, [], "no authorization denial is even needed: the tool never reached the catalog");
  assertEquals(dispatched, []);
});

Deno.test("FALSIFICATION: a stale catalog built before a deny flip fails closed at the guard with the named reason", async () => {
  const origin = "https://policy-stale.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  const genBefore = (await enrollmentSnapshot(origin)).gen;
  // Build the catalog while the site is still allow (the in-flight snapshot),
  // then flip to deny — the next invocation must fail closed.
  const denials = [];
  const records = await siteRecords(origin, { get: () => genBefore }, denials, []);
  assert(records.length === 1, "the pre-flip catalog still carried the tool");
  const guard = createWebmcpAuthorizationGuard({
    origin, enrollmentSnapshot, listTools, isApproved: isApprovedForTest, runGenCell: { get: () => genBefore },
    onDeny: (decision, target) => denials.push({ reason: decision.reason, name: target.name }),
  });
  await setEnrollmentPolicy(origin, "deny");
  const decision = await guard({ name: "book_table", source: "declared", descriptorInput: {} });
  assertEquals(decision.ok, false);
  assertEquals(decision.reason, "site-policy-denied", "the named reason must identify the enrollment policy as the failing conjunct");
  assertEquals(denials.length, 1);
  assertEquals(denials[0].reason, "site-policy-denied");
  assertEquals(WEBMCP_AUTHORITY_REASONS.includes("site-policy-denied"), true);
});

Deno.test("FALSIFICATION: the pure authority evaluation denies a deny-policy origin before every other conjunct", async () => {
  const denied = evaluateWebmcpAuthority({
    enrolled: true, enrollmentGen: 7, policy: "deny", toolPresent: true,
    approved: true, runGen: 7, descriptorInput: { permissionDigest: "none", grantDigest: "none" },
  });
  assertEquals(denied.ok, false);
  assertEquals(denied.reason, "site-policy-denied");
  // allow + everything else green still passes (regression)
  const allowed = evaluateWebmcpAuthority({
    enrolled: true, enrollmentGen: 7, policy: "allow", toolPresent: true,
    approved: true, runGen: 7, descriptorInput: { permissionDigest: sha256Hex("approved:true"), grantDigest: "none" },
  });
  assertEquals(allowed.ok, true);
});

// ── allow regression: the default must keep today's behavior ─────────────

Deno.test("enrollment policy: an ALLOW site's tool appears in the toolset and dispatches (default behavior unchanged)", async () => {
  const origin = "https://policy-allow.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  const gen = (await enrollmentSnapshot(origin)).gen;
  const { search, exec, denials, dispatched } = await drive(origin, { get: () => gen });
  assertEquals(dispatched.length, 1);
  assertEquals(denials, []);
});

// ── ask: the dispatch-time owner gate ─────────────────────────────────────

Deno.test("enrollment policy: ASK keeps tools discoverable but every dispatch pays the owner gate", async () => {
  const origin = "https://policy-ask.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  await setEnrollmentPolicy(origin, "ask");
  const gen = (await enrollmentSnapshot(origin)).gen;
  // An approved owner gate lets the call run. The drive passes a GETTER that
  // returns the run's ask-gate function (the same contract readSiteLazySources
  // uses: askGateGetter() → the build-bound gate).
  const approvals = [];
  const approvedGateFn = () => { approvals.push(1); return Promise.resolve({ ok: true }); };
  const ran = await drive(origin, { get: () => gen }, () => approvedGateFn);
  assertEquals(ran.search.ok, true);
  assertEquals(ran.search.results.length, 1, "ask-policy tools stay discoverable");
  assertEquals(ran.search.results[0].availability, "ready");
  assertEquals(ran.dispatched.length, 1);
  assertEquals(approvals.length, 1, "the gate was consulted exactly once for the invocation");
  // A denied gate refuses the call — nothing reaches the page.
  const deniedGateFn = () => Promise.resolve({ ok: false, approvalDenied: true, error: "the owner denied this tool call" });
  const refused = await drive(origin, { get: () => gen }, () => deniedGateFn);
  assertEquals(refused.dispatched.length, 0, "a denied ask call NEVER dispatches to the page");
  assert(refused.exec?.ok === true && String(JSON.stringify(refused.exec.result ?? "")).includes("the owner denied this tool call"), "the denial reaches the model as an honest tool error — nothing runs silently");
  // NO gate (a scoped/unattended run with no owner conversation) fails closed honestly.
  const noChannel = await drive(origin, { get: () => gen }, null);
  assertEquals(noChannel.dispatched.length, 0);
  assert(noChannel.exec?.ok === true && String(JSON.stringify(noChannel.exec.result ?? "")).includes("no approval channel"), "no-channel runs fail closed with the honest reason");
});

Deno.test("enrollment policy: gateWebmcpToolDispatch (the shipped dispatch fence) decides each state", async () => {
  assertEquals(await gateWebmcpToolDispatch({ enrolled: true, policy: "allow" }), { ok: true });
  const denied = await gateWebmcpToolDispatch({ enrolled: true, policy: "deny", askGate: () => Promise.resolve({ ok: true }) });
  assertEquals(denied.ok, false);
  assertEquals(denied.reason, "site-policy-denied");
  assertEquals(denied.error, "site tools are blocked by the enrollment policy");
  const notEnrolled = await gateWebmcpToolDispatch({ enrolled: false, policy: "deny" });
  assertEquals(notEnrolled.reason, "not-enrolled");
  const noChannel = await gateWebmcpToolDispatch({ enrolled: true, policy: "ask", askGate: null });
  assertEquals(noChannel.ok, false);
  assertEquals(noChannel.reason, "owner-approval-channel-missing");
  assertEquals(await gateWebmcpToolDispatch({ enrolled: true, policy: "ask", askGate: () => Promise.resolve({ ok: true }) }), { ok: true });
  const refused = await gateWebmcpToolDispatch({
    enrolled: true, policy: "ask",
    askGate: () => Promise.resolve({ ok: false, approvalExpired: true, error: "expired" }),
  });
  assertEquals(refused.ok, false);
  assertEquals(refused.approvalExpired, true);
});

// ── ask approval action registration (the in-conversation card can exist) ──

Deno.test("enrollment policy: webmcp.use-tool is an approvable action with a canonical origin+tool target", async () => {
  assert(DESTRUCTIVE_ACTIONS.has("webmcp.use-tool"), "createPendingApproval refuses any action not in the approvable set — an ask tool could never pay a card without membership");
  const target = canonicalOperationTarget("webmcp-tool", { origin: "https://policy-ask.example.com", name: "book_table" });
  assertEquals(target.length > 0, true);
  const same = canonicalOperationTarget("webmcp-tool", { origin: "https://policy-ask.example.com", name: "book_table" });
  assertEquals(target, same, "the same origin+tool maps to one stable approval target");
  const otherTool = canonicalOperationTarget("webmcp-tool", { origin: "https://policy-ask.example.com", name: "cancel_reservation" });
  assert(otherTool !== target, "two tools on one site must not share an approval row");
});

// ── SW wiring pins: the shipped service worker enforces the policy ────────

Deno.test("enrollment policy SW wiring: deny excludes records, dispatch gates live, routes exist and stay extension-only", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  // readSiteLazySources excludes a denied site BEFORE building any record.
  assert(sw.includes('if (enrollment.policy === "deny") return [];'), "a denied site's tools never enter the agent toolset");
  // The dispatch closure runs the shipped gate factory (not a private copy).
  assert(sw.includes("gateWebmcpToolDispatch"), "the dispatch closure consults the shipped gate");
  // invokeSiteToolCore fails closed for a denied site on EVERY invocation path.
  assert(sw.includes('if (snap.policy === "deny") {'), "invokeSiteToolCore rejects a denied site");
  // The Directory routes exist; none of them is page-reachable.
  for (const route of ["tools.policies", "tools.policy.set", "webmcp.use-tool"]) {
    assert(sw.includes(`"${route}"`), `route ${route} is registered`);
    assertEquals(PAGE_ALLOWED_ROUTES.has(route), false, `${route} must never be page-allowed`);
  }
  // The Directory renders the three-state control and labels blocked sites.
  const dir = await Deno.readTextFile(new URL("../extension/directory/directory.js", import.meta.url));
  for (const text of [
    "Allow tools", "Ask before use", "Blocked",
    "Tool-use policy", "tools.policy.set", "tools.policies",
  ]) {
    assert(dir.includes(text), `directory.js must render/control: ${text}`);
  }
  assert(dir.includes("not available to any agent"), "a blocked site's consequence is stated plainly in the Directory");
});
