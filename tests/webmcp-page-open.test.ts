// @ts-nocheck — OPFS fake is dynamic for isolated unit tests.
// WebMCP page-open KATs (owner: "the bistro demo opened the root origin page,
// not the actual page that had the tools registered"). These FAIL on the base
// (a legacy origin-only entry permanently shadows the fresh page-scoped
// report; no identity-history recovery exists) and PASS on the fix.
import { assert, assertEquals } from "jsr:@std/assert@1";

function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable { constructor(n) { this.node = n; this.parts = []; } async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); } async close() { this.node.content = this.parts.join(""); } }
class FakeFileHandle { constructor(n) { this.node = n; } get kind() { return "file"; } async getFile() { const n = this.node; return { size: (n.content ?? "").length, async text() { return n.content ?? ""; } }; } async createWritable() { return new FakeWritable(this.node); } }
class FakeDirHandle {
  constructor(n) { this.node = n; } get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no dir ${name}`); this.node.children.set(name, dirNode()); } return new FakeDirHandle(this.node.children.get(name)); }
  async getFileHandle(name, opts = {}) { if (!this.node.children.has(name)) { if (opts?.create !== true) throw new Error(`no file ${name}`); this.node.children.set(name, fileNode("")); } return new FakeFileHandle(this.node.children.get(name)); }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() { for (const [name, node] of this.node.children) yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", { value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } }, configurable: true, writable: true });

const { replacePageTools, replaceTools, listTools } = await import("../extension/lib/tools.js");
const { planWebmcpInvocationTab } = await import("../extension/lib/pure.js");
const { recoverDeclaringPageIdentity } = await import("../extension/lib/site-identity.js");

const O = "https://googlechromelabs.github.io";
const BISTRO = `${O}/webmcp-tools/demos/french-bistro/`;
const pg = (url, tabId, doc) => ({ pageUrl: url, tabId, documentId: doc, navigationEpoch: 1 });
const bookTool = { name: "book_table_le_petit_bistro", source: "declared", description: "Book a table", inputSchema: { type: "object" } };

Deno.test("KAT 1: a tool declared on a nested path opens THAT page (not the origin root)", async () => {
  await replacePageTools(O, [bookTool], pg(BISTRO, 1, "d1"));
  const descriptor = (await listTools(O)).find((t) => t.name === bookTool.name);
  assertEquals(descriptor.pageUrl, BISTRO, "the declaring page URL is stored on the directory entry");
  assertEquals(descriptor.path, "/webmcp-tools/demos/french-bistro/");
  const plan = planWebmcpInvocationTab({ canonical: O, path: descriptor.path, pageUrl: descriptor.pageUrl, binding: null, tabs: [] });
  assertEquals(plan, { kind: "open", url: BISTRO }, "opens the declaring page, not the origin root");
  // And when the declaring page is ALREADY open among other same-origin tabs,
  // it is the one reused (not the root, not another page).
  const plan2 = planWebmcpInvocationTab({
    canonical: O, path: descriptor.path, pageUrl: descriptor.pageUrl, binding: null,
    tabs: [{ id: 1, url: `${O}/`, active: true }, { id: 2, url: BISTRO, active: false }],
  });
  assertEquals(plan2, { kind: "reuse", tabId: 2 });
});

Deno.test("KAT 2: a fresh page report SUPERSEDES the same-named legacy origin-only entry (the owner's bug)", async () => {
  const O2 = "https://k2.example";
  await replaceTools(O2, [{ ...bookTool, origin: O2 }]); // enrolled/registered before page-identity
  await replacePageTools(O2, [bookTool], pg(`${O2}/demos/french-bistro/`, 1, "d1")); // the demo re-reports
  const dir = await listTools(O2);
  const entries = dir.filter((t) => t.name === bookTool.name);
  assertEquals(entries.length, 1, "exactly one entry for the tool (the legacy row is upgraded, not shadowed)");
  assertEquals(entries[0].pageUrl, `${O2}/demos/french-bistro/`, "the page-scoped descriptor wins");
  const plan = planWebmcpInvocationTab({ canonical: O2, path: entries[0].path, pageUrl: entries[0].pageUrl, binding: null, tabs: [] });
  assertEquals(plan, { kind: "open", url: `${O2}/demos/french-bistro/` });
});

Deno.test("KAT 3: two same-origin nested pages stay separately indexed with their own open targets", async () => {
  const O3 = "https://k3.example";
  await replacePageTools(O3, [{ name: "search.query", source: "declared", description: "S", inputSchema: { type: "object" } }], pg(`${O3}/app/search`, 1, "d1"));
  await replacePageTools(O3, [{ name: "checkout.pay", source: "declared", description: "P", inputSchema: { type: "object" } }], pg(`${O3}/app/checkout`, 2, "d2"));
  const dir = await listTools(O3);
  const search = dir.find((t) => t.name === "search.query");
  const checkout = dir.find((t) => t.name === "checkout.pay");
  assert(search && checkout, "both pages' tools are indexed");
  assertEquals(search.pageUrl, `${O3}/app/search`);
  assertEquals(checkout.pageUrl, `${O3}/app/checkout`);
  assertEquals(planWebmcpInvocationTab({ canonical: O3, path: search.path, pageUrl: search.pageUrl, binding: null, tabs: [] }), { kind: "open", url: `${O3}/app/search` });
  assertEquals(planWebmcpInvocationTab({ canonical: O3, path: checkout.path, pageUrl: checkout.pageUrl, binding: null, tabs: [] }), { kind: "open", url: `${O3}/app/checkout` });
});

Deno.test("KAT 4: a legacy entry with NO re-report recovers its declaring page from identity history", () => {
  // The owner's stored state: directory entry has no pageUrl, but the identity
  // history (0.2.252+) knows the bistro page declared the tool.
  const identities = [
    { id: "v2:a", state: "history", pageUrl: `${O}/webmcp-tools/demos/french-bistro/`, path: "/webmcp-tools/demos/french-bistro/", toolNames: ["book_table_le_petit_bistro"], observedAt: 100 },
    { id: "v2:b", state: "history", pageUrl: `${O}/webmcp-tools/demos/other/`, path: "/webmcp-tools/demos/other/", toolNames: ["other_tool"], observedAt: 200 },
  ];
  const recovered = recoverDeclaringPageIdentity(identities, "book_table_le_petit_bistro");
  assertEquals(recovered, { pageUrl: `${O}/webmcp-tools/demos/french-bistro/`, path: "/webmcp-tools/demos/french-bistro/" });
  // A tool no identity names → null (honest, plan falls back to origin).
  assertEquals(recoverDeclaringPageIdentity(identities, "never_seen"), null);
  // The current/known identity outranks older history.
  const withCurrent = [
    { id: "v2:old", state: "history", pageUrl: `${O}/old-page/`, toolNames: ["t"], observedAt: 999 },
    { id: "v2:cur", state: "known", pageUrl: `${O}/current-page/`, toolNames: ["t"], observedAt: 1 },
  ];
  assertEquals(recoverDeclaringPageIdentity(withCurrent, "t").pageUrl, `${O}/current-page/`);
});

Deno.test("KAT 5: no page info anywhere → origin-root fallback preserved (honest unknown)", async () => {
  const O5 = "https://k5.example";
  await replaceTools(O5, [{ name: "legacy.only", origin: O5, source: "declared", description: "L", inputSchema: { type: "object" } }]);
  const descriptor = (await listTools(O5)).find((t) => t.name === "legacy.only");
  const recovered = recoverDeclaringPageIdentity([], descriptor.name);
  assertEquals(recovered, null);
  const plan = planWebmcpInvocationTab({ canonical: O5, path: descriptor?.path ?? null, pageUrl: descriptor?.pageUrl ?? recovered?.pageUrl ?? null, binding: null, tabs: [] });
  assertEquals(plan, { kind: "open", url: O5 }, "unchanged honest fallback when the declaring page is unknowable");
});

Deno.test("KAT 6 (wiring pins): invokeSiteTool recovers the declaring page and the fences are intact", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes("recoverDeclaringPageIdentity(identities, name)"), "invokeSiteTool consults identity history for legacy descriptors");
  assert(sw.includes("path: descriptor.path ?? null") && sw.includes("pageUrl: descriptor.pageUrl ?? null"),
    "the plan receives the descriptor's page identity");
  // The fences from the earlier lanes remain:
  assert(sw.includes("attestReportedPageUrl(pageUrl, tabUrl, canonical)"), "attested-URL-over-reported-URL (r2)");
  assert(sw.includes("origin ${canonical} was re-enrolled during run"), "run-gen fence");
  assert(sw.includes("the approved document changed before"), "round-30 document-binding fence");
});
