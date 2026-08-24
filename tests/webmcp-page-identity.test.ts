// @ts-nocheck — OPFS fake is dynamic for isolated unit tests.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";

function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable { constructor(n) { this.node = n; this.parts = []; } async write(s) { this.parts.push(String(s)); } async close() { this.node.content = this.parts.join(""); } }
class FakeFileHandle { constructor(n) { this.node = n; } get kind() { return "file"; } async getFile() { const n = this.node; return { size: (n.content ?? "").length, async text() { return n.content ?? ""; } }; } async createWritable() { return new FakeWritable(this.node); } }
class FakeDirHandle { constructor(n) { this.node = n; } get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no dir ${name}`); this.node.children.set(name, dirNode()); } return new FakeDirHandle(this.node.children.get(name)); }
  async getFileHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no file ${name}`); this.node.children.set(name, fileNode("")); } return new FakeFileHandle(this.node.children.get(name)); }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() { for (const [name, node] of this.node.children) yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; } }
const root = dirNode();
Object.defineProperty(globalThis, "navigator", { value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } }, configurable: true, writable: true });

import { describeTool, getCurrentSiteIdentity, listSiteIdentityHistory, listTools, replacePageTools, replaceTools } from "../extension/lib/tools.js";
import { matchesPageIdentity, planWebmcpInvocationTab } from "../extension/lib/pure.js";
import { buildAgentCandidates } from "../extension/shared/agent-candidates.js";
import { attestReportedPageUrl, formatSiteAgentName } from "../extension/lib/site-identity.js";

const CANONICAL = "https://app.example";

Deno.test("page identity: same-origin pages with different declared tools persist distinct page tools & identities (coexistence)", async () => {
  const checkoutTools = [
    { name: "checkout.pay", source: "declared", description: "Pay invoice", inputSchema: { type: "object" } },
  ];
  const searchTools = [
    { name: "search.query", source: "declared", description: "Search catalog", inputSchema: { type: "object" } },
  ];

  // 1. Snapshot for checkout page
  const res1 = await replacePageTools(CANONICAL, checkoutTools, {
    pageUrl: `${CANONICAL}/checkout`,
    title: "Checkout",
    tabId: 1,
    documentId: "doc-checkout-1",
    navigationEpoch: 1,
  });
  assertEquals(res1.pageTools.length, 1);
  assertEquals(res1.pageTools[0].path, "/checkout");
  assertEquals(res1.identity?.path, "/checkout");
  assertEquals(res1.identity?.title, "Checkout");

  const id1 = await getCurrentSiteIdentity(CANONICAL);
  assertEquals(id1.path, "/checkout");
  assertEquals(id1.toolNames, ["checkout.pay"]);

  const dirAfterCheckout = await listTools(CANONICAL);
  assertEquals(dirAfterCheckout.length, 1);
  assertEquals(dirAfterCheckout[0].name, "checkout.pay");
  assertEquals(dirAfterCheckout[0].path, "/checkout");

  // 2. Snapshot for search page replaces live current identity while saving checkout to history,
  // AND BOTH tools coexist in the origin tool directory (the non-clobber slice invariant)
  const res2 = await replacePageTools(CANONICAL, searchTools, {
    pageUrl: `${CANONICAL}/search`,
    title: "Search Catalog",
    tabId: 1,
    documentId: "doc-search-2",
    navigationEpoch: 2,
  });
  assertEquals(res2.pageTools.length, 1);
  assertEquals(res2.pageTools[0].path, "/search");
  assertEquals(res2.identity?.path, "/search");

  const id2 = await getCurrentSiteIdentity(CANONICAL);
  assertEquals(id2.path, "/search");
  assertEquals(id2.toolNames, ["search.query"]);

  const history = await listSiteIdentityHistory(CANONICAL);
  assertEquals(history.length, 1);
  assertEquals(history[0].id, id1.id);
  assertEquals(history[0].path, "/checkout");
  assertNotEquals(id1.id, id2.id, "different page paths create distinct v2 identities");

  // DISCRIMINATING ASSERTION: listTools contains BOTH checkout.pay AND search.query
  const dirAfterSearch = await listTools(CANONICAL);
  assertEquals(dirAfterSearch.length, 2, "both pages' tools coexist in the origin directory");
  const checkoutEntry = dirAfterSearch.find((t) => t.name === "checkout.pay");
  const searchEntry = dirAfterSearch.find((t) => t.name === "search.query");
  assert(checkoutEntry, "checkout.pay survives subsequent snapshots from other pages");
  assert(searchEntry, "search.query is stored alongside checkout.pay");
  assertEquals(checkoutEntry.path, "/checkout");
  assertEquals(searchEntry.path, "/search");
});

Deno.test("page identity: page slice replacement clears only the reporting page's slice on empty snapshot", async () => {
  const origin = "https://slice.example";
  await replacePageTools(origin, [{ name: "pageA.tool", source: "declared" }], { pageUrl: `${origin}/page-a` });
  await replacePageTools(origin, [{ name: "pageB.tool", source: "declared" }], { pageUrl: `${origin}/page-b` });

  let dir = await listTools(origin);
  assertEquals(dir.length, 2);

  // Clear page-a's tools with an empty snapshot
  await replacePageTools(origin, [], { pageUrl: `${origin}/page-a` });

  dir = await listTools(origin);
  assertEquals(dir.length, 1, "only page-a's tools are cleared");
  assertEquals(dir[0].name, "pageB.tool", "page-b's tools remain intact");
});

Deno.test("page identity: legacy origin-only tool records coexist with page-scoped tool records", async () => {
  const origin = "https://legacy-coexist.example";
  // 1. Initial legacy origin-only tool
  await replaceTools(origin, [{ origin, name: "legacy_tool", source: "declared", description: "Old tool" }]);
  let dir = await listTools(origin);
  assertEquals(dir.length, 1);
  assertEquals(dir[0].name, "legacy_tool");

  // 2. Add a page-scoped tool on /subpage
  await replacePageTools(origin, [{ name: "subpage.tool", source: "declared" }], { pageUrl: `${origin}/subpage` });
  dir = await listTools(origin);
  assertEquals(dir.length, 2, "legacy tool and page-scoped tool coexist");
  assert(dir.some((t) => t.name === "legacy_tool"));
  assert(dir.some((t) => t.name === "subpage.tool"));
});

Deno.test("page identity: planWebmcpInvocationTab matches exact declaring page and opens targeted page URL", () => {
  const tabs = [
    { id: 10, url: "https://app.example/dashboard", active: false },
    { id: 20, url: "https://app.example/checkout", active: true },
    { id: 30, url: "https://app.example/search", active: false },
  ];

  // Invoking a tool declared on /checkout selects tab 20
  const planCheckout = planWebmcpInvocationTab({
    canonical: CANONICAL,
    path: "/checkout",
    binding: null,
    tabs,
  });
  assertEquals(planCheckout.kind, "reuse");
  assertEquals(planCheckout.tabId, 20);

  // Invoking a tool declared on /search selects tab 30
  const planSearch = planWebmcpInvocationTab({
    canonical: CANONICAL,
    path: "/search",
    binding: null,
    tabs,
  });
  assertEquals(planSearch.kind, "reuse");
  assertEquals(planSearch.tabId, 30);

  // Invoking a tool declared on /settings (no matching tab) plans an open with the exact page URL
  const planSettings = planWebmcpInvocationTab({
    canonical: CANONICAL,
    path: "/settings",
    pageUrl: "https://app.example/settings?tab=profile",
    binding: null,
    tabs,
  });
  assertEquals(planSettings.kind, "open");
  assertEquals(planSettings.url, "https://app.example/settings?tab=profile");
});

Deno.test("page identity: buildAgentCandidates formats page-scoped site agents with paths and titles", () => {
  const siteAgents = [
    {
      origin: "https://shop.example",
      path: "/checkout",
      pageUrl: "https://shop.example/checkout",
      title: "Checkout",
      toolCount: 2,
      enrolled: true,
    },
    {
      origin: "https://docs.example",
      path: "/",
      pageUrl: "https://docs.example/",
      toolCount: 5,
      enrolled: true,
    },
  ];

  const candidates = buildAgentCandidates([], [], siteAgents);
  assertEquals(candidates.length, 2);
  assertEquals(candidates[0].label, "@shop.example/checkout");
  assertEquals(candidates[1].label, "@docs.example");
});

Deno.test("page identity: attestReportedPageUrl prevents same-origin path spoofing and cross-origin claims", () => {
  // 1. Cross-origin spoof fails
  const cross = attestReportedPageUrl("https://evil.example/steal", "https://app.example/home", CANONICAL);
  assertEquals(cross.ok, false);

  // 2. Mismatched path fails attestation (tab URL authority wins)
  const mismatch = attestReportedPageUrl("https://app.example/checkout", "https://app.example/search", CANONICAL);
  assertEquals(mismatch.ok, false);

  // 3. Matching canonical path succeeds
  const match = attestReportedPageUrl("https://app.example/checkout#frag", "https://app.example/checkout", CANONICAL);
  assertEquals(match.ok, true);
  assertEquals(match.canonicalUrl, "https://app.example/checkout");
});
