// @ts-nocheck — untyped DI harness by design (fake OPFS + session kv, same
// precedent as review49-regression.test.ts).
// tests/tool-library-site-tools.test.ts — chrome-agent-platform-lmk2: the
// Settings tool library must show per-origin WebMCP declared/inferred tools.
// Drives the REAL production chain: enrollOrigin → replacePageTools →
// listOrigins/listTools → adaptWebMcpTools → buildToolCatalog →
// ShadowToolCatalogController.inspect({action:"summary"}).

import { assert, assertEquals } from "jsr:@std/assert@1";

// ── in-memory OPFS fake (same shape as review49-regression) ────────────────
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(c) { return { kind: "file", content: c }; }
class W {
  constructor(n) { this.n = n; this.p = []; }
  async write(s) { this.p.push(String(s)); }
  async close() { this.n.content = this.p.join(""); }
}
class F {
  constructor(n) { this.n = n; this.name = null; }
  get kind() { return "file"; }
  async getFile() {
    const n = this.n;
    return { size: (n.content ?? "").length, async text() { return n.content ?? ""; }, async arrayBuffer() { return new TextEncoder().encode(n.content ?? "").buffer; } };
  }
  async createWritable() {
    const w = new W(this.n);
    w.n.name = this.name;
    return w;
  }
}
class D {
  constructor(n) { this.n = n; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, o = {}) {
    if (!this.n.children.has(name)) {
      if (!o.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      this.n.children.set(name, dirNode());
    }
    return new D(this.n.children.get(name));
  }
  async getFileHandle(name, o = {}) {
    if (!this.n.children.has(name)) {
      if (!o.create) throw Object.assign(new Error("not found"), { name: "NotFoundError" });
      this.n.children.set(name, fileNode(""));
    }
    const f = new F(this.n.children.get(name));
    f.name = name;
    return f;
  }
  async removeEntry(name) { this.n.children.delete(name); }
  async *entries() {
    for (const [name, n] of this.n.children) {
      const h = n.kind === "file" ? new F(n) : new D(n);
      if (h instanceof F) h.name = name;
      yield [name, h];
    }
  }
  async *values() {
    for (const [name, n] of this.n.children) {
      const h = n.kind === "file" ? new F(n) : new D(n);
      if (h instanceof F) h.name = name;
      yield h;
    }
  }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new D(root); } } },
  configurable: true,
});

const { enrollOrigin, replacePageTools, listTools, enrollmentSnapshot } = await import("../extension/lib/tools.js");
const { listOrigins } = await import("../extension/lib/memory.js");
const { adaptWebMcpTools, TOOL_CATALOG_BOUNDS } = await import("../extension/lib/tool-catalog.js");
const { ShadowToolCatalogController } = await import("../extension/lib/tool-catalog-shadow.js");

/** BYTE-FAITHFUL mirror of service-worker.js readShadowCatalogInputs's origin
 * loop (post-lmk2 fix): every enrolled origin's directory is adapted into the
 * catalog with no arithmetic bound (dptw removed descriptor size caps; the old
 * loop kept computing the removed TOOL_CATALOG_BOUNDS.maxDescriptors, NaN
 * arithmetic that silently sliced every origin's tools to nothing). */
async function readSiteToolInputs() {
  const inputs = [];
  for (const origin of await listOrigins()) {
    const enrollment = await enrollmentSnapshot(origin);
    const sourceGeneration = `enrollment:${enrollment.gen ?? 0}`;
    inputs.push(...adaptWebMcpTools(await listTools(origin), {
      origin,
      agentId: `site:${origin}`,
      documentId: "",
      sourceGeneration,
      availability: "stale",
    }));
  }
  return inputs;
}

const DECLARED = [
  { name: "search_docs", source: "declared", description: "Search the documentation", inputSchema: { type: "object" } },
  { name: "open_skill", source: "declared", description: "Open a skill page", inputSchema: { type: "object" } },
];
const INFERRED = [
  { name: "click_login", source: "inferred", description: "Click the login control", inputSchema: { type: "object" } },
];

async function summary() {
  const controller = new ShadowToolCatalogController({ readInputs: readSiteToolInputs });
  return await controller.inspect({ action: "summary" }, { principal: "owner-options" });
}

Deno.test("site tools: declared + inferred tools of an enrolled origin reach the Settings summary with origin labels", async () => {
  root.children.clear();
  await enrollOrigin("https://beads.gascity.com");
  await replacePageTools("https://beads.gascity.com", [...DECLARED, ...INFERRED]);

  const s = await summary();
  assertEquals(s.ok, true);
  assertEquals(s.bySource["webmcp-declared"], 2, "two declared site tools counted");
  assertEquals(s.bySource["webmcp-inferred"], 1, "one inferred site tool counted");

  const declaredRows = s.toolsBySource["webmcp-declared"] ?? [];
  assertEquals(declaredRows.length, 2);
  // Each row names its origin so the owner sees WHICH site declares the tool.
  const names = declaredRows.map((r) => r.name);
  assert(names.includes("search_docs"));
  assert(names.includes("open_skill"));
  for (const row of declaredRows) {
    assertEquals(row.origin, "https://beads.gascity.com", `row ${row.name} carries its origin`);
  }
  const inferredRows = s.toolsBySource["webmcp-inferred"] ?? [];
  assertEquals(inferredRows.length, 1);
  assertEquals(inferredRows[0].origin, "https://beads.gascity.com");
});

Deno.test("site tools: multiple origins aggregate into one library", async () => {
  root.children.clear();
  await enrollOrigin("https://beads.gascity.com");
  await enrollOrigin("https://example.com");
  await replacePageTools("https://beads.gascity.com", DECLARED);
  await replacePageTools("https://example.com", [
    { name: "search_api", source: "declared", description: "Search the API", inputSchema: {} },
  ]);

  const s = await summary();
  assertEquals(s.bySource["webmcp-declared"], 3, "declared tools from BOTH origins aggregate");
  const rows = s.toolsBySource["webmcp-declared"] ?? [];
  const origins = new Set(rows.map((r) => r.origin));
  assert(origins.has("https://beads.gascity.com"));
  assert(origins.has("https://example.com"));
});

Deno.test("site tools: no enrolled tools means an honest 0 (never a phantom count)", async () => {
  root.children.clear();
  const s = await summary();
  assertEquals(s.bySource["webmcp-declared"] ?? 0, 0);
  assertEquals(s.bySource["webmcp-inferred"] ?? 0, 0);
});

Deno.test("site tools: an unenrolled origin's directory is never listed", async () => {
  root.children.clear();
  await enrollOrigin("https://beads.gascity.com");
  await replacePageTools("https://beads.gascity.com", DECLARED);
  await enrollOrigin("https://gone.example.com");
  await replacePageTools("https://gone.example.com", [
    { name: "ghost_tool", source: "declared", description: "", inputSchema: {} },
  ]);
  const { disenrollOrigin } = await import("../extension/lib/tools.js");
  await disenrollOrigin("https://gone.example.com");

  const s = await summary();
  assertEquals(s.bySource["webmcp-declared"], 2, "only the still-enrolled origin's tools are listed");
  const names = (s.toolsBySource["webmcp-declared"] ?? []).map((r) => r.name);
  assert(!names.includes("ghost_tool"));
});


Deno.test("source pin: the shadow catalog never computes the removed descriptor ceiling again", async () => {
  // The lmk2 defect: dptw removed maxDescriptors, the shadow-catalog origin
  // loop kept multiplying by it (NaN → slice(0, NaN) → [] → 0 site tools).
  // A re-introduction of that dead reference must fail loudly here.
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(!/TOOL_CATALOG_BOUNDS\.maxDescriptors/.test(sw), "service-worker.js still computes the removed descriptor ceiling");
});
