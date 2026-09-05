// @ts-nocheck — the OPFS fake is intentionally dynamic.
// tests/site-tool-consent.test.ts — chrome-agent-platform-eo4d: FIRST-call
// consent for enrolled sites' tools, the audit ledger, and re-arm on disable.
//
// FALSIFICATION GATE: an enrolled origin's tool MUST be unapproved until its
// first call is approved; approving consumes it; disabling re-arms. Every
// decision — auto, allow, deny — must append an audit row.
import { assertEquals } from "jsr:@std/assert@1";

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
  async *keys() { for (const k of this.node.children.keys()) yield k; }
  async *values() { for (const v of this.node.children.values()) yield v; }
  async *entries() { for (const [k, v] of this.node.children) yield [k, v]; }
}

function installFakeOPFS() {
  const root = dirNode();
  Object.defineProperty(globalThis, "navigator", {
    value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
    configurable: true,
  });
  return root;
}

const { enrollOrigin, isApproved, approveTool } = await import("../extension/lib/tools.js");
const { auditSiteToolCall, readSiteToolAudit, clearSiteToolAudit } = await import("../extension/lib/site-tool-audit.js");

Deno.test("eo4d: enrolled origin's tool is NOT approved before its first call", async () => {
  installFakeOPFS();
  await enrollOrigin("https://example.com");
  assertEquals(await isApproved("https://example.com", "search"), false);
});

Deno.test("eo4d: approving the tool (first-call Allow) makes later calls pass", async () => {
  installFakeOPFS();
  await enrollOrigin("https://example.com");
  await approveTool("https://example.com", "search", true);
  assertEquals(await isApproved("https://example.com", "search"), true);
});

Deno.test("eo4d: disabling (delete key) RE-ARMS the first-call card", async () => {
  installFakeOPFS();
  await enrollOrigin("https://example.com");
  await approveTool("https://example.com", "search", true);
  assertEquals(await isApproved("https://example.com", "search"), true);
  await approveTool("https://example.com", "search", false);
  assertEquals(await isApproved("https://example.com", "search"), false);
});

Deno.test("eo4d: audit rows append for auto, allow, AND deny decisions", async () => {
  installFakeOPFS();
  await auditSiteToolCall("https://example.com", { tool: "search", decision: "auto", runId: "r1" });
  await auditSiteToolCall("https://example.com", { tool: "edit", decision: "allow", runId: "r1" });
  await auditSiteToolCall("https://example.com", { tool: "delete", decision: "deny", runId: "r2" });
  const rows = await readSiteToolAudit("https://example.com");
  assertEquals(rows.length, 3);
  assertEquals(rows.map((r) => r.decision), ["auto", "allow", "deny"]);
  assertEquals(typeof rows[0].at, "number");
});

Deno.test("eo4d: clearing the audit trail empties it", async () => {
  installFakeOPFS();
  await auditSiteToolCall("https://example.com", { tool: "search", decision: "auto" });
  await clearSiteToolAudit("https://example.com");
  assertEquals(await readSiteToolAudit("https://example.com"), []);
});
