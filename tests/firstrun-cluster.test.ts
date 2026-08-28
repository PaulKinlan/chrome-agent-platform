// tests/firstrun-cluster.test.ts — the first-run cluster fixes
// (CAP-FB-20260823-FIRST-RUN-DUPLICATE-TEST-ASSET-01,
// CAP-FB-20260823-FIRST-RUN-EXAMPLE-AGENT-01).
// @ts-nocheck — the OPFS fake is intentionally dynamic (house style).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createAsset,
  createOrUpdateAssetKeyed,
  listAssets,
  normalizeModelAssetKey,
} from "../extension/lib/artifacts.js";
import {
  FIRST_RUN_TASK_PROMPT,
  FIRST_RUN_EXAMPLE_AGENTS,
  firstRunExampleAgent,
} from "../extension/lib/first-run-onboarding.js";

// ---- minimal in-memory OPFS fake (same shape as tests/artifacts.test.ts) ----
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
  async getFile() { const n = this.node; return { size: (n.content ?? "").length, async text() { return n.content ?? ""; } }; }
  async createWritable() { return new FakeWritable(this.node); }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) { if (!opts.create) throw new Error(`not found: ${name}`); this.node.children.set(name, dirNode()); }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) { if (!opts.create) throw new Error(`not found: ${name}`); this.node.children.set(name, fileNode("")); }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() { for (const [name, node] of this.node.children) yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
  configurable: true, writable: true,
});

Deno.test("DUPLICATE-ASSET: repeated keyed create-or-update yields EXACTLY ONE asset (same id, content replaced)", async () => {
  const first = await createOrUpdateAssetKeyed("master", { key: "model:first-task", type: "text", name: "First task", content: "v1" });
  assert(first.ok && first.created === true, `first create must succeed: ${first.error}`);
  const id = first.id;
  assert(typeof id === "string" && id.startsWith("a_"), "the id is a normal asset id");
  const second = await createOrUpdateAssetKeyed("master", { key: "model:first-task", type: "text", name: "First task", content: "v2" });
  assert(second.ok && second.updated === true, "the repeat must update, not create");
  assertEquals(second.id, id, "the repeat must reuse the SAME id");
  const list = await listAssets("master");
  const matches = list.assets.filter((a) => a.id === id);
  assertEquals(matches.length, 1, "exactly one asset after repeated keyed runs");
  assertEquals(matches[0].name, "First task");
});

Deno.test("DUPLICATE-ASSET: the keyed and unkeyed paths stay disjoint", async () => {
  const keyed = await createOrUpdateAssetKeyed("master", { key: "model:disjoint", type: "text", name: "k", content: "x" });
  const unkeyed = await createAsset("master", { type: "text", name: "u", content: "x" });
  assert(keyed.ok && unkeyed.ok, "both paths succeed");
  assert(keyed.id !== unkeyed.asset.id, "the keyed and unkeyed ids differ");
  const list = await listAssets("master");
  assert(list.assets.some((a) => a.id === keyed.id), "the keyed row is discoverable");
  assert(list.assets.some((a) => a.id === unkeyed.asset.id), "the unkeyed row is discoverable");
});

Deno.test("DUPLICATE-ASSET: the key grammar rejects smuggling + the prompt names the key", () => {
  assertEquals(normalizeModelAssetKey("first-task"), "model:first-task");
  assertEquals(normalizeModelAssetKey("My Key 2"), "model:My Key 2");
  assertEquals(normalizeModelAssetKey("a:b"), null, "colons rejected");
  assertEquals(normalizeModelAssetKey("opfs:promote:abc"), null, "no namespace smuggling");
  assertEquals(normalizeModelAssetKey(""), null);
  assertEquals(normalizeModelAssetKey("x".repeat(65)), null);
  assert(FIRST_RUN_TASK_PROMPT.includes('"first-task"'), "the first-run prompt names the idempotency key");
});

Deno.test("DUPLICATE-ASSET: a keyed index row with a missing body fails closed (no create/update)", async () => {
  const { masterMemory } = await import("../extension/lib/memory.js");
  // Write a keyed index row WITHOUT its body — the repair-in-progress state the
  // create-or-update must fail closed on (never a silent duplicate or an update
  // into a dead body).
  await masterMemory().setTrusted("assets", [
    { id: "a_dead", type: "text", name: "dead", origin: "master", at: Date.now(), size: 1, pk: "model:dead" },
  ]);
  const retry = await createOrUpdateAssetKeyed("master", { key: "model:dead", type: "text", name: "dead", content: "y" });
  assert(!retry.ok, "the missing-body keyed row must fail closed");
  assert(String(retry.error).includes("body missing"), "the error names the missing body");
  const list = await listAssets("master");
  assertEquals(list.assets.filter((a) => a.id === "a_dead").length, 1, "the index row is unchanged (no new asset, no update)");
});

Deno.test("EXAMPLE-AGENT: the swappable catalogue resolves the default example", () => {
  const ex = firstRunExampleAgent("weekly-browsing-review");
  assert(ex, "the default example exists");
  assertEquals(ex.name, "Weekly browsing review");
  assert(ex.role.includes("weekly"), "the role is a truthful weekly-review description");
  assertEquals(firstRunExampleAgent("nope"), null, "an unknown example resolves null");
  assert(Array.isArray(FIRST_RUN_EXAMPLE_AGENTS) && FIRST_RUN_EXAMPLE_AGENTS.length >= 1, "the catalogue is swappable (a list)");
});
