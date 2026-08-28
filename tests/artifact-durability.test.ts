// @ts-nocheck
// CAP-FB-20260828-ARTIFACT-DURABILITY-01 — artifacts outlive the agent and the
// task that made them.
//
// Owner: "we do need access to all the artifacts because the agents might go
// away when we kill them, and tasks might go away. We need this central store
// of things that we can reference in the future because we can build upon
// them... the whole point of the artifacts is that they're the central source
// of all the information that has been created by the worker, by the person."
//
// Two shipped behaviours contradicted that, and BOTH are asserted here:
//   1. an artifact created under a site origin was stored in that site's own
//      OPFS store, and `agent.delete` clears that store — so deleting a Site
//      Agent destroyed the owner's artifacts; and
//   2. the artifacts gallery only ever listed `origin:"master"`, so those
//      artifacts were never visible in the library in the first place.
//
// These tests were written to FAIL against the pre-fix code and must keep
// failing if the coupling is reintroduced.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createAsset,
  deleteAsset,
  getAsset,
  listAllAssets,
  listAssets,
} from "../extension/lib/artifacts.js";
import { siteMemory } from "../extension/lib/memory.js";

// ---- minimal in-memory OPFS fake (same shape as tests/artifacts.test.ts) ----
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content) { return { kind: "file", content }; }
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; }
  async write(chunk) { this.parts.push(chunk); }
  async close() {
    const joined = this.parts.map((p) => (typeof p === "string" ? p : new TextDecoder().decode(p))).join("");
    this.node.content = joined;
  }
}
class FakeFileHandle {
  constructor(node) { this.node = node; }
  async createWritable() { return new FakeWritable(this.node); }
  async getFile() {
    const c = this.node.content ?? "";
    return { async text() { return c; }, size: c.length };
  }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  async getDirectoryHandle(name, opts) {
    let n = this.node.children.get(name);
    if (!n) {
      if (!opts?.create) throw new DOMException("NotFoundError", "NotFoundError");
      n = dirNode(); this.node.children.set(name, n);
    }
    return new FakeDirHandle(n);
  }
  async getFileHandle(name, opts) {
    let n = this.node.children.get(name);
    if (!n) {
      if (!opts?.create) throw new DOMException("NotFoundError", "NotFoundError");
      n = fileNode(""); this.node.children.set(name, n);
    }
    return new FakeFileHandle(n);
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

const SITE = "https://shop.example";

Deno.test("durability: a site-origin artifact SURVIVES the Site Agent's store being cleared", async () => {
  // This is the reported bug, end to end. `agent.delete` clears the site's
  // memory store; before the fix the artifact lived in that store and went
  // with it.
  const created = await createAsset(SITE, {
    type: "text",
    name: "quarterly summary",
    content: "the numbers for Q3",
  });
  assert(created.ok, `create must succeed: ${created.error}`);
  const id = created.asset.id;

  // Exactly what agent.delete does to a Site Agent's own store.
  await siteMemory(SITE).clear();

  const after = await getAsset(SITE, id);
  assert(after.ok, "the artifact must still be readable after the site store is cleared");
  assertEquals(after.asset.content, "the numbers for Q3", "content must survive intact");
  assertEquals(after.asset.name, "quarterly summary");
});

Deno.test("durability: site-origin artifacts are VISIBLE in the central library", async () => {
  // The second half of the bug: the gallery lists the library, and a
  // site-origin artifact was never in it.
  const a = await createAsset(SITE, { type: "text", name: "site note", content: "x" });
  const b = await createAsset("master", { type: "text", name: "hub note", content: "y" });
  assert(a.ok && b.ok);

  const all = await listAllAssets();
  assert(all.ok, `library list must succeed: ${all.error}`);
  const ids = all.assets.map((r) => r.id);
  assert(ids.includes(a.asset.id), "a site-origin artifact must appear in the library");
  assert(ids.includes(b.asset.id), "a hub artifact must appear in the library");

  // Provenance is preserved so the owner can still tell where each came from,
  // and so a deleted agent's artifacts remain attributable.
  const siteRow = all.assets.find((r) => r.id === a.asset.id);
  assertEquals(siteRow.origin, SITE, "provenance must survive");
});

Deno.test("durability: listAssets(origin) still filters by provenance", async () => {
  const s = await createAsset(SITE, { type: "text", name: "only-site", content: "s" });
  const m = await createAsset("master", { type: "text", name: "only-master", content: "m" });
  assert(s.ok && m.ok);

  const siteOnly = await listAssets(SITE);
  assert(siteOnly.ok);
  assert(siteOnly.assets.every((r) => r.origin === SITE), "listAssets(origin) must return only that origin");
  assert(siteOnly.assets.some((r) => r.id === s.asset.id));
  assert(!siteOnly.assets.some((r) => r.id === m.asset.id), "must not leak another origin's rows");

  const masterOnly = await listAssets("master");
  assert(masterOnly.ok);
  assert(masterOnly.assets.every((r) => r.origin === "master"));
});

Deno.test("durability: asset.delete remains the ONLY way an artifact goes away", async () => {
  const created = await createAsset(SITE, { type: "text", name: "deliberate", content: "z" });
  assert(created.ok);
  const id = created.asset.id;

  // Clearing the site store must not remove it...
  await siteMemory(SITE).clear();
  assert((await getAsset(SITE, id)).ok, "still present after a store clear");

  // ...but an explicit owner delete must.
  const del = await deleteAsset(SITE, id);
  assert(del.ok, `explicit delete must succeed: ${del.error}`);
  assertEquals((await getAsset(SITE, id)).ok, false, "explicitly deleted artifacts are gone");
  const all = await listAllAssets();
  assert(!all.assets.some((r) => r.id === id), "and are gone from the library");
});
