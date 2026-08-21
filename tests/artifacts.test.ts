// Unit test for the artifacts (asset) system — lib/artifacts.js.
// Assets are origin-keyed; each is a bounded OPFS value under `asset:<id>` with
// a lightweight reserved `assets` index. Verifies create/list/get/update/delete,
// the type + name + content bounds, and the per-origin count cap.
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ASSET_BOUNDS,
  ASSET_TYPES,
  createAsset,
  deleteAsset,
  getAsset,
  listAssets,
  updateAsset,
} from "../extension/lib/artifacts.js";

// ---- minimal in-memory OPFS fake (same shape as tests/memory.test.ts) ----
function dirNode() {
  return { kind: "directory", children: new Map() };
}
function fileNode(content) {
  return { kind: "file", content };
}
class FakeWritable {
  constructor(node) {
    this.node = node;
    this.parts = [];
  }
  async write(s) {
    this.parts.push(String(s));
  }
  async close() {
    this.node.content = this.parts.join("");
  }
}
class FakeFileHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "file";
  }
  async getFile() {
    const node = this.node;
    return {
      size: (node.content ?? "").length,
      async text() {
        return node.content ?? "";
      },
    };
  }
  async createWritable() {
    return new FakeWritable(this.node);
  }
}
class FakeDirHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "directory";
  }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name, opts = {}) {
    this.node.children.delete(name);
  }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: {
    storage: { async getDirectory() { return new FakeDirHandle(root); } },
  },
  configurable: true,
  writable: true,
});

Deno.test("createAsset → list → get round-trips a hub artifact", async () => {
  const created = await createAsset("master", {
    type: "html",
    name: "generated report",
    content: "<h1>hi</h1>",
  });
  assert(created.ok, `create must succeed: ${created.error}`);
  const id = created.asset.id;
  assert(typeof id === "string" && id.startsWith("a_"), "id must be generated");

  const list = await listAssets("master");
  assert(list.ok, "list must succeed");
  assert(list.assets.some((a) => a.id === id), "index must contain the new asset");
  assert(!("content" in (list.assets[0] ?? {})), "index entries must not carry content");

  const got = await getAsset("master", id);
  assert(got.ok, "get must succeed");
  assertEquals(got.asset.content, "<h1>hi</h1>", "content must round-trip");
  assertEquals(got.asset.type, "html");
  assertEquals(got.asset.name, "generated report");
});

Deno.test("updateAsset patches name/type/content", async () => {
  const created = await createAsset("master", {
    type: "text",
    name: "draft",
    content: "v1",
  });
  const id = created.asset.id;
  const updated = await updateAsset("master", id, {
    name: "final",
    type: "html",
    content: "<p>v2</p>",
  });
  assert(updated.ok, `update must succeed: ${updated.error}`);
  const got = await getAsset("master", id);
  assertEquals(got.asset.name, "final");
  assertEquals(got.asset.type, "html");
  assertEquals(got.asset.content, "<p>v2</p>");
});

Deno.test("deleteAsset removes the index entry + the asset body", async () => {
  const created = await createAsset("master", { type: "text", name: "x", content: "y" });
  const id = created.asset.id;
  const del = await deleteAsset("master", id);
  assert(del.ok, "delete must succeed");
  const got = await getAsset("master", id);
  assert(!got.ok, "get after delete must fail");
  const list = await listAssets("master");
  assert(!list.assets.some((a) => a.id === id), "index must drop the deleted asset");
});

Deno.test("createAsset rejects bad types, empty names, oversized content", async () => {
  assert(ASSET_TYPES.has("html"), "ASSET_TYPES must include html");
  const badType = await createAsset("master", { type: "exe", name: "a", content: "b" });
  assert(!badType.ok, "bad type must be rejected");
  const noName = await createAsset("master", { type: "text", name: "  ", content: "b" });
  assert(!noName.ok, "empty name must be rejected");
  const huge = await createAsset("master", {
    type: "text",
    name: "big",
    content: "x".repeat(ASSET_BOUNDS.maxContentBytes + 1),
  });
  assert(!huge.ok, "oversized content must be rejected");
});

Deno.test("createAsset enforces the per-origin count cap", async () => {
  // Use a dedicated origin so the cap test doesn't depend on prior tests' state.
  for (let i = 0; i < ASSET_BOUNDS.maxAssetsPerOrigin + 1; i++) {
    const r = await createAsset("https://cap.example", {
      type: "text",
      name: `asset ${i}`,
      content: `${i}`,
    });
    if (i < ASSET_BOUNDS.maxAssetsPerOrigin) {
      assert(r.ok, `asset ${i} must succeed`);
    } else {
      assert(!r.ok, "the 201st asset must be rejected");
      assert(/limit/.test(r.error), "the rejection must explain the limit");
    }
  }
});

Deno.test("assets are origin-scoped (master vs site don't mix)", async () => {
  const m = await createAsset("master", { type: "text", name: "hub", content: "m" });
  const s = await createAsset("https://scope.example", {
    type: "text",
    name: "site",
    content: "s",
  });
  const masterList = await listAssets("master");
  const siteList = await listAssets("https://scope.example");
  assert(masterList.assets.some((a) => a.id === m.asset.id), "master lists the hub asset");
  assert(siteList.assets.some((a) => a.id === s.asset.id), "site lists its asset");
  assert(!masterList.assets.some((a) => a.id === s.asset.id), "master must NOT see the site asset");
  assert(!siteList.assets.some((a) => a.id === m.asset.id), "site must NOT see the master asset");
});

Deno.test("assets: same-tick same-name ids disambiguate by the UNIQUE random tail (AX suffix)", async () => {
  // createAsset calls newId() synchronously before its first await, so two
  // un-awaited calls share the same Date.now() tick — the old slice(0,8) prefix
  // collides, the fixed slice(-8) tail does not.
  const p1 = createAsset("master", { type: "text", name: "dup", content: "1" });
  const p2 = createAsset("master", { type: "text", name: "dup", content: "2" });
  const [a, b] = await Promise.all([p1, p2]);
  assert(a.ok && b.ok, "both same-name creates succeed");
  const id1 = a.asset.id;
  const id2 = b.asset.id;
  assert(id1 !== id2, "distinct ids");
  // The AX disambiguator (index.js distinct) uses slice(-8): the random tail is
  // unique even when the timestamp prefix (slice(0,8)) is shared.
  assert(id1.slice(-8) !== id2.slice(-8), "the id tail (AX suffix) is unique in the same tick");
});

Deno.test("assets: concurrent same-tick creates both persist in the index (no RMW loss)", async () => {
  // Two un-awaited creates read the index before either writes; the per-origin
  // mutex must serialize the read-modify-write so neither row is dropped.
  const p1 = createAsset("master", { type: "text", name: "concurrent", content: "1" });
  const p2 = createAsset("master", { type: "text", name: "concurrent", content: "2" });
  const [a, b] = await Promise.all([p1, p2]);
  assert(a.ok && b.ok, "both creates succeed");
  const list = await listAssets("master");
  const ids = new Set(list.assets.map((x) => x.id));
  assert(ids.has(a.asset.id), "the first id persists in the index");
  assert(ids.has(b.asset.id), "the second id persists in the index");
});
