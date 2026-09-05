// @ts-nocheck — the OPFS fake is intentionally dynamic.
// tests/webmcp-lazyauth.test.ts — CAP-FB-20260824-WEBMCP-LAZYAUTH-01:
// the WebMCP live-authorization consent chain, driven end-to-end through the
// REAL guard factory (lib/webmcp-authority.js) + REAL enrollment state + the
// REAL lazy protocol. The previous inline SW guard referenced an unimported
// `ownData` → ReferenceError → { ok:false } → blind `lazy-authority-stale-or-denied`
// on EVERY delegated invocation; the protocol tests stubbed the guard, so
// nothing caught it. These KATs exercise the shipped guard code.
import { assert, assertEquals } from "jsr:@std/assert@1";

function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable { constructor(n) { this.node = n; this.parts = []; } async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); } async close() { this.node.content = this.parts.join(""); } }
class FakeFileHandle { constructor(n) { this.node = n; } get kind() { return "file"; } async getFile() { const n = this.node; return { size: (n.content ?? "").length, async text() { return n.content ?? ""; } }; } async createWritable() { return new FakeWritable(this.node); } }
class FakeDirHandle { constructor(n) { this.node = n; } get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no dir ${name}`); this.node.children.set(name, dirNode()); } return new FakeDirHandle(this.node.children.get(name)); }
  async getFileHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no file ${name}`); this.node.children.set(name, fileNode("")); } return new FakeFileHandle(this.node.children.get(name)); }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() { for (const [name, node] of this.node.children) yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; } }
const root = dirNode();
Object.defineProperty(globalThis, "navigator", { value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } }, configurable: true, writable: true });

import { disenrollOrigin, enrollOrigin, enrollmentSnapshot, listTools, replaceTools, setToolConsentDecision, toolConsentSnapshot } from "../extension/lib/tools.js";
import { createWebmcpAuthorizationGuard, evaluateWebmcpAuthority, siteToolConsentPermissionDigest, siteToolSourceGeneration, WEBMCP_AUTHORITY_REASONS } from "../extension/lib/webmcp-authority.js";
import { executableWebMcpToolRecords, LazyToolProtocol, withOwnerSiteToolActivity } from "../extension/lib/lazy-tool-protocol.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import { sha256Hex } from "../extension/lib/pure.js";

const TOOL = { name: "book_table", source: "declared", description: "Book a table", inputSchema: { type: "object", properties: { partySize: { type: "number" } }, required: ["partySize"] } };

// Build the lazy records EXACTLY as the SW's readSiteLazySources does — the
// guard is the shipped factory (zero replica drift).
async function siteRecords(origin, runGenCell, denials, dispatched, autoAllow = false) {
  const enrollment = await enrollmentSnapshot(origin);
  const sourceGeneration = siteToolSourceGeneration(enrollment.gen, { documentId: "", epoch: 0, seq: 0 });
  const tools = await listTools(origin);
  const permissionDigestByTool = {};
  const availabilityByTool = {};
  for (const t of tools) {
    const consent = await toolConsentSnapshot(origin, t.name).catch(() => null);
    permissionDigestByTool[t.name] = siteToolConsentPermissionDigest(consent);
    availabilityByTool[t.name] = !enrollment.enrolled || consent?.state === "denied" ? "disabled" : "ready";
  }
  const authorizationGuard = createWebmcpAuthorizationGuard({
    origin, enrollmentSnapshot, listTools, consentSnapshot: toolConsentSnapshot, runGenCell,
    onDeny: (decision, target) => denials.push({ reason: decision.reason, name: target.name }),
  });
  return executableWebMcpToolRecords(tools, {
    origin, agentId: origin, documentId: "", version: "page-current",
    sourceGeneration, closureGeneration: sourceGeneration,
    packageDigest: sha256Hex(`webmcp:${origin}:${sourceGeneration}`),
    permissionDigestByTool, grantDigest: sha256Hex(sourceGeneration), availabilityByTool, authorizationGuard,
  }, async ({ name, args, authorizationTransition }) => {
    if (autoAllow && (await toolConsentSnapshot(origin, name)).state === "ask") {
      await setToolConsentDecision(origin, name, "allowed");
      authorizationTransition?.();
    }
    dispatched.push({ name, args });
    return withOwnerSiteToolActivity({ ok: true, result: "done" }, { origin, tool: name });
  });
}

async function drive(origin, runGenCell, { autoAllow = false } = {}) {
  const denials = [];
  const dispatched = [];
  const ownerEvents = [];
  const protocol = new LazyToolProtocol({
    readSources: () => siteRecords(origin, runGenCell, denials, dispatched, autoAllow),
    selectionAuthority: new ToolSelectionAuthority(),
  });
  const gen = (await enrollmentSnapshot(origin)).gen;
  const context = { signal: new AbortController().signal, runId: "run-1", taskId: "task-1", agentId: origin, origin, documentId: "", runGeneration: String(gen), catalogGeneration: "1", onProgress: (event) => ownerEvents.push(event) };
  const search = await protocol.search({ query: "book table" }, context);
  if (!search.ok || !search.results?.length) return { search, exec: null, denials, dispatched, ownerEvents };
  const exec = await protocol.execute({ selectionRef: search.results[0].selectionRef, arguments: { partySize: 2 } }, context);
  return { search, exec, denials, dispatched, ownerEvents };
}

Deno.test("lazyauth: identical authenticated re-polls do not change the execution realm", () => {
  const first = siteToolSourceGeneration(7, { documentId: "doc-a", epoch: 3, seq: 1 });
  const rePoll = siteToolSourceGeneration(7, { documentId: "doc-a", epoch: 3, seq: 999 });
  assertEquals(first, rePoll, "report seq orders authenticated snapshots but is not execution identity");
  assertEquals(first, "enrollment:7:document:doc-a:epoch:3");
  assert(siteToolSourceGeneration(7, { documentId: "doc-b", epoch: 3, seq: 999 }) !== first);
  assert(siteToolSourceGeneration(7, { documentId: "doc-a", epoch: 4, seq: 1 }) !== first);
});

Deno.test("lazyauth: first-use Allow crosses only the marked revision transition, then stays ready", async () => {
  const origin = "https://lazyauth-a.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  const gen = (await enrollmentSnapshot(origin)).gen;
  assertEquals((await toolConsentSnapshot(origin, TOOL.name)).state, "ask");
  const first = await drive(origin, { get: () => gen }, { autoAllow: true });
  assertEquals(first.search.results[0].availability, "ready", "ASK is executable solely so dispatch can show the card");
  assert(typeof first.search.results[0].selectionRef === "string");
  assertEquals(first.exec?.ok, true);
  assertEquals(first.dispatched.length, 1);
  const firstActivity = first.ownerEvents.find((event) => event.type === "site-activity")?.siteActivity;
  assertEquals(firstActivity, { origin, tool: TOOL.name });
  assertEquals(Reflect.ownKeys(firstActivity ?? {}).length, 2, "owner metadata carries only origin + exact tool");
  assert(!JSON.stringify(first.exec).includes("siteActivity"), "owner metadata never enters the model/result journal JSON");
  assertEquals((await toolConsentSnapshot(origin, TOOL.name)).state, "allowed");
  const later = await drive(origin, { get: () => gen });
  assertEquals(later.exec?.ok, true, "the persisted exact Allow dispatches without another transition");
  assertEquals(later.dispatched.length, 1);
  assertEquals(later.denials, []);
  const cachedActivity = later.ownerEvents.find((event) => event.type === "site-activity")?.siteActivity;
  assertEquals(cachedActivity, { origin, tool: TOOL.name }, "silent cached Allow keeps the owner audit pointer");
  assertEquals(Reflect.ownKeys(cachedActivity ?? {}).length, 2);
  assert(!JSON.stringify(later.exec).includes("siteActivity"));
});

Deno.test("lazyauth: a DISENROLLED origin fails closed (reason: not-enrolled)", async () => {
  const origin = "https://lazyauth-b.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  const gen = (await enrollmentSnapshot(origin)).gen;
  await disenrollOrigin(origin);
  const { search, exec, dispatched } = await drive(origin, { get: () => gen });
  assertEquals(search.ok, true);
  assertEquals(search.results[0].availability, "disabled", "a disenrolled origin never issues a usable selection");
  assertEquals(search.results[0].selectionRef, null);
  assertEquals(dispatched.length, 0);
  // The guard itself names the conjunct when consulted directly:
  const guard = createWebmcpAuthorizationGuard({ origin, enrollmentSnapshot, listTools, consentSnapshot: toolConsentSnapshot, runGenCell: { get: () => gen } });
  const denied = await guard({ name: "book_table", source: "declared", descriptorInput: { permissionDigest: sha256Hex("approved:false"), grantDigest: "g" } });
  assertEquals(denied.ok, false);
  assertEquals(denied.reason, "not-enrolled");
});

Deno.test("lazyauth: a mid-run re-enrollment (gen bump) fails the STALE run closed (run-generation-stale)", async () => {
  const origin = "https://lazyauth-c.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  const runGen = (await enrollmentSnapshot(origin)).gen;
  // Re-enroll MID-RUN: the enrollment generation bumps; the run's captured gen is stale.
  await enrollOrigin(origin);
  await setToolConsentDecision(origin, TOOL.name, "allowed");
  const { exec, denials, dispatched } = await drive(origin, { get: () => runGen });
  assertEquals(exec?.ok, false, "the stale run must not operate under the new enrollment");
  assertEquals(dispatched.length, 0);
  assert(denials.some((d) => d.reason === "run-generation-stale"), `denial names the conjunct (got ${JSON.stringify(denials)})`);
});

Deno.test("lazyauth: a missing run generation fails closed AND named (run-generation-missing — the old blind dead-end)", async () => {
  const origin = "https://lazyauth-d.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  await setToolConsentDecision(origin, TOOL.name, "allowed");
  const { exec, denials, dispatched } = await drive(origin, { get: () => null });
  assertEquals(exec?.ok, false);
  assertEquals(dispatched.length, 0);
  assert(denials.some((d) => d.reason === "run-generation-missing"), `denial names the conjunct (got ${JSON.stringify(denials)})`);
});

Deno.test("lazyauth: a tool removed from the live directory fails closed (tool-not-in-directory)", async () => {
  const origin = "https://lazyauth-e.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [TOOL]);
  const gen = (await enrollmentSnapshot(origin)).gen;
  const guard = createWebmcpAuthorizationGuard({ origin, enrollmentSnapshot, listTools, consentSnapshot: toolConsentSnapshot, runGenCell: { get: () => gen } });
  await replaceTools(origin, []); // the page removed its tools
  const denied = await guard({ name: "book_table", source: "declared", descriptorInput: { permissionDigest: sha256Hex("approved:true"), grantDigest: "g" } });
  assertEquals(denied.ok, false);
  assertEquals(denied.reason, "tool-not-in-directory");
});

Deno.test("lazyauth: evaluateWebmcpAuthority names every exact conjunct (unit)", () => {
  const identityDigest = "1".repeat(64);
  const consent = { state: "allowed", enrollmentGen: 7, revision: 4, identityDigest };
  const base = {
    enrolled: true, policy: "allow", enrollmentGen: 7, toolPresent: true,
    consentState: consent.state, consentEnrollmentGen: consent.enrollmentGen,
    consentRevision: consent.revision, identityDigest,
    runGen: 7, descriptorInput: { permissionDigest: siteToolConsentPermissionDigest(consent), grantDigest: "g" },
  };
  assertEquals(evaluateWebmcpAuthority(base).ok, true);
  assertEquals(evaluateWebmcpAuthority({ ...base, enrolled: false }).reason, "not-enrolled");
  assertEquals(evaluateWebmcpAuthority({ ...base, policy: "deny" }).reason, "site-policy-denied");
  assertEquals(evaluateWebmcpAuthority({ ...base, toolPresent: false }).reason, "tool-not-in-directory");
  const asking = { ...base, consentState: "ask", descriptorInput: { ...base.descriptorInput, permissionDigest: siteToolConsentPermissionDigest({ ...consent, state: "ask" }) } };
  assertEquals(evaluateWebmcpAuthority(asking).ok, true, "ASK may reach the card-owning dispatch closure");
  assertEquals(evaluateWebmcpAuthority({ ...asking, phase: "after-dispatch" }).reason, "tool-consent-required");
  assertEquals(evaluateWebmcpAuthority({ ...base, consentState: "denied" }).reason, "tool-consent-denied");
  assertEquals(evaluateWebmcpAuthority({ ...base, consentEnrollmentGen: 6 }).reason, "tool-consent-generation-stale");
  assertEquals(evaluateWebmcpAuthority({ ...base, runGen: null }).reason, "run-generation-missing");
  assertEquals(evaluateWebmcpAuthority({ ...base, runGen: 6 }).reason, "run-generation-stale");
  assertEquals(evaluateWebmcpAuthority({ ...base, descriptorInput: { permissionDigest: "other", grantDigest: "g" } }).reason, "permission-digest-drift");
  for (const r of ["not-enrolled", "site-policy-denied", "tool-not-in-directory", "tool-consent-required", "tool-consent-denied", "tool-consent-generation-stale", "run-generation-missing", "run-generation-stale", "permission-digest-drift"]) {
    assert(WEBMCP_AUTHORITY_REASONS.includes(r));
  }
});

Deno.test("lazyauth SW wiring: the shipped guard is the tested factory; no unbound ownData remains (source pins)", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes('from "../lib/webmcp-authority.js"') && sw.includes("createWebmcpAuthorizationGuard"), "the SW imports the tested factory");
  assert(sw.includes("const authorizationGuard = createWebmcpAuthorizationGuard({"), "readSiteLazySources builds the guard via the factory");
  assert(sw.includes('pushDiagnostic(') && sw.includes("WebMCP tool authorization denied:"), "denials surface to the diagnostics ring");
  // The bug pin: no BARE ownData CALL may remain in the SW (it was never
  // imported there — the ReferenceError that dead-ended every invocation).
  const bareCalls = sw.match(/[^.\w]ownData\(/g) ?? [];
  assertEquals(bareCalls.length, 0, "no unbound ownData() call in the service worker");
});
