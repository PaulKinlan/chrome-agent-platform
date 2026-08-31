// CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01 — the library must never
// silently evict the owner's OLDEST artifact when the index byte bound is
// reached. At capacity it either rolls a regenerable derived row (a scheduled
// report / tab snapshot the system can regenerate) or REFUSES the create — it
// never drops an owner-created artifact.
//
// Falsification: revert the guard in createAssetLocked to the old
// `while (idx.length > 1) idx = idx.slice(1)` silent-eviction loop and the
// first test goes RED (the oldest owner artifact disappears and no refusal is
// returned).
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ASSET_BOUNDS,
  createAsset,
  createAssetKeyed,
  getAsset,
  listAllAssets,
} from "../extension/lib/artifacts.js";

// ---- minimal in-memory OPFS fake (same shape as tests/artifacts.test.ts).
// A fresh module-global `root` per test FILE isolates this from the byte state
// accumulated by tests/artifacts.test.ts, so a tiny maxIndexBytes is reliable.
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

const enc = new TextEncoder();
async function indexBytes() {
  const list = await listAllAssets();
  return enc.encode(JSON.stringify(list.assets)).byteLength;
}

Deno.test("capacity: a full library REFUSES a create — the owner's oldest artifact is never silently dropped", async () => {
  const origin = "https://libcap-owner.example";
  const saved = ASSET_BOUNDS.maxIndexBytes;
  try {
    // Seed a few owner artifacts with a generous bound, then clamp the bound to
    // exactly the current index size: any further row now exceeds it.
    ASSET_BOUNDS.maxIndexBytes = 1024 * 1024;
    const ownerIds = [];
    for (let i = 0; i < 4; i++) {
      const r = await createAsset(origin, { type: "text", name: `owner ${i}`, content: `${i}` });
      assert(r.ok, `seed create ${i} must succeed: ${r.error}`);
      ownerIds.push(r.asset.id);
    }
    ASSET_BOUNDS.maxIndexBytes = await indexBytes(); // the library is now exactly full

    const refused = await createAsset(origin, { type: "text", name: "one too many", content: "x" });
    assertEquals(refused.ok, false, "a create past the bound must fail");
    assertEquals(refused.code, "library_full", `must be a capacity refusal, got: ${refused.error}`);

    // The OLDEST owner artifact — and every owner artifact — must still be there.
    const oldest = ownerIds[0];
    const gotOldest = await getAsset(origin, oldest);
    assert(gotOldest.ok, "the OLDEST owner artifact must survive a full-library create");
    const list = await listAllAssets();
    for (const id of ownerIds) {
      assert(list.assets.some((a) => a.id === id), `owner artifact ${id} must not be silently evicted`);
    }
    // The refused row never entered the index.
    assert(!list.assets.some((a) => a.name === "one too many"), "a refused create leaves no row");
  } finally {
    ASSET_BOUNDS.maxIndexBytes = saved;
  }
});

Deno.test("capacity: a regenerable derived row ROLLS to make room; owner rows never do", async () => {
  const origin = "https://libcap-regen.example";
  const saved = ASSET_BOUNDS.maxIndexBytes;
  try {
    ASSET_BOUNDS.maxIndexBytes = 1024 * 1024;
    // A regenerable derived row (a scheduled report) is the OLDEST row here.
    const regen = await createAssetKeyed(origin, {
      key: "scheduled-report:daily", type: "text", name: "daily report", content: "r",
    });
    assert(regen.ok, `regenerable seed must succeed: ${regen.error}`);
    const regenId = regen.asset?.id ?? regen.id;

    const ownerIds = [];
    for (let i = 0; i < 3; i++) {
      const r = await createAsset(origin, { type: "text", name: `owner ${i}`, content: `${i}` });
      assert(r.ok, `owner seed ${i} must succeed`);
      ownerIds.push(r.asset.id);
    }
    ASSET_BOUNDS.maxIndexBytes = await indexBytes(); // exactly full

    // The next create fits by ROLLING the regenerable row (a keyed row carries a
    // `pk`, so it is larger than the plain incoming row — dropping it frees more
    // than the new row adds), so the create SUCCEEDS.
    const created = await createAsset(origin, { type: "text", name: "new owner work", content: "y" });
    assert(created.ok, `a create must succeed by rolling the regenerable row: ${created.error}`);

    const list = await listAllAssets();
    assert(!list.assets.some((a) => a.id === regenId), "the regenerable row must be rolled off");
    for (const id of ownerIds) {
      assert(list.assets.some((a) => a.id === id), `owner artifact ${id} must survive`);
    }
    assert(list.assets.some((a) => a.id === (created.asset?.id ?? created.id)), "the new artifact is filed");
  } finally {
    ASSET_BOUNDS.maxIndexBytes = saved;
  }
});
