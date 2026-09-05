// @ts-nocheck — the OPFS fake is intentionally dynamic.
// tests/webmcp-autoapprove.test.ts — CAP-FB-20260824-WEBMCP-AUTOAPPROVE-01:
// ENROLLMENT IS THE CONSENT. An enrolled origin's WebMCP tools are approved
// as a class (no per-tool approval UI exists, so the per-tool gate was an
// unsatisfiable dead-end). Disenrollment revokes. The explicit per-tool
// record still serves NON-enrolled origins.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  approveTool,
  disenrollOrigin,
  enrollOrigin,
  isApproved,
  listTools,
  pendingApprovals,
  replaceTools,
} from "../extension/lib/tools.js";

// ---- minimal in-memory OPFS fake (kv.js falls back to its session Map with
// no chrome mock — shared module state is isolated per test file process) ----
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
  async removeEntry(name, opts = {}) { this.node.children.delete(name); }
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

Deno.test("eo4d: an enrolled origin's declared tool is NOT approved until its first call is approved", async () => {
  const origin = "https://autoapprove-a.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK]);
  // eo4d FIRST-CALL CONSENT: enrollment no longer blanket-approves. The tool
  // is callable only after the first call's card is allowed (approveTool).
  assertEquals(await isApproved(origin, "book_table_le_petit_bistro"), false, "enrolled ⇒ unconsumed until first-call approval");
  await approveTool(origin, "book_table_le_petit_bistro", true);
  assertEquals(await isApproved(origin, "book_table_le_petit_bistro"), true, "first-call Allow consumes the consent");
});

Deno.test("eo4d: a tool declared AFTER enrollment also waits for its own first call", async () => {
  const origin = "https://autoapprove-b.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK]);
  await approveTool(origin, "book_table_le_petit_bistro", true);
  assertEquals(await isApproved(origin, "book_table_le_petit_bistro"), true);
  // The page declares/updates a NEW tool in a later snapshot — it has its
  // OWN first-call consent to consume; the earlier approval does not cover it.
  const LATE = { name: "cancel_reservation", source: "declared", description: "Cancel", inputSchema: { type: "object" } };
  await replaceTools(origin, [BOOK, LATE]);
  assertEquals((await listTools(origin)).length, 2);
  assertEquals(await isApproved(origin, "cancel_reservation"), false, "each tool's first call is its own consent");
});

Deno.test("eo4d: disenrollment REVOKES; re-enrollment starts consent FRESH (consumed state is not silently restored)", async () => {
  const origin = "https://autoapprove-c.example.com";
  await enrollOrigin(origin);
  await replaceTools(origin, [BOOK]);
  await approveTool(origin, "book_table_le_petit_bistro", true);
  assertEquals(await isApproved(origin, "book_table_le_petit_bistro"), true);
  await disenrollOrigin(origin);
  assertEquals(await isApproved(origin, "book_table_le_petit_bistro"), false, "disenroll revokes (fail closed)");
  await enrollOrigin(origin);
  // eo4d: the owner re-admitting the site re-arms the first-call card — the
  // old consumed consent must not resurrect silently.
  assertEquals(await isApproved(origin, "book_table_le_petit_bistro"), false, "re-enrollment re-arms the first-call card");
});

Deno.test("auto-approve: the explicit per-tool record still serves NON-enrolled origins (legacy path intact)", async () => {
  const origin = "https://autoapprove-d.example.com";
  await replaceTools(origin, [BOOK]);
  assertEquals(await isApproved(origin, "book_table_le_petit_bistro"), false, "non-enrolled + no grant ⇒ not approved");
  await approveTool(origin, "book_table_le_petit_bistro", true);
  assertEquals(await isApproved(origin, "book_table_le_petit_bistro"), true, "explicit grant honored");
  await approveTool(origin, "book_table_le_petit_bistro", false);
  assertEquals(await isApproved(origin, "book_table_le_petit_bistro"), false, "explicit denial honored");
});

Deno.test("auto-approve SW wiring: availability + guard + execute path all consult isApproved (source pins)", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  // The availability computation is unchanged — enrollment-derived approval
  // makes enrolled tools "ready", so the owner-action-required dead-end is
  // unreachable for an enrolled origin (only a storage error can still map
  // there).
  assert(sw.includes('availabilityByTool[sourceTool.name] = enrollment.enrolled && approved'), "availability keyed on isApproved");
  assert(sw.includes('const approved = await isApproved(origin, sourceTool.name)'), "readSiteLazySources consults isApproved");
  assert(sw.includes('isApproved,') && sw.includes("createWebmcpAuthorizationGuard({"), "authorizationGuard consults isApproved via the extracted factory (lib/webmcp-authority.js)");
  assert(sw.includes("executableWebMcpToolRecords(tools,"), "readSiteLazySources wires executable WebMCP records");
  assert(!sw.includes("async function siteToolset"), "dead siteToolset is removed from service-worker.js");
  // tools.js derivation pins
  const tools = await Deno.readTextFile(new URL("../extension/lib/tools.js", import.meta.url));
  assert(tools.includes("return Boolean(approved[toolName]);"), "eo4d: isApproved consults the per-tool consent map for enrolled origins too");
});
