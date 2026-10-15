// A fresh fake OPFS per test file keeps this regression independent of other
// tests' in-memory tombstone cache and writes no shared build artifacts.
// @ts-nocheck
import { assertEquals } from "jsr:@std/assert@1";

function missing(name) { return new DOMException(`not found: ${name}`, "NotFoundError"); }
function directory() { return { kind: "directory", children: new Map() }; }
const root = directory();
class FakeDirectory {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, { create = false } = {}) {
    let node = this.node.children.get(name);
    if (!node) {
      if (!create) throw missing(name);
      node = directory();
      this.node.children.set(name, node);
    }
    return new FakeDirectory(node);
  }
  async getFileHandle(name, { create = false } = {}) {
    let node = this.node.children.get(name);
    if (!node) {
      if (!create) throw missing(name);
      node = { kind: "file", text: "" };
      this.node.children.set(name, node);
    }
    return {
      kind: "file",
      async getFile() {
        return {
          size: new TextEncoder().encode(node.text).byteLength,
          async text() { return node.text; },
          async arrayBuffer() { return new TextEncoder().encode(node.text).buffer; },
        };
      },
      async createWritable() {
        let parts = [];
        return {
          async write(value) { parts.push(typeof value === "string" ? value : new TextDecoder().decode(value)); },
          async close() { node.text = parts.join(""); },
          async abort() { parts = []; },
        };
      },
    };
  }
  async removeEntry(name) {
    if (name === "victim.json") throw new Error("injected unlink failure");
    if (!this.node.children.delete(name)) throw missing(name);
  }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "directory" ? new FakeDirectory(node) : await this.getFileHandle(name)];
    }
  }
}
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirectory(root); } } },
  configurable: true,
});

Deno.test("cducc: folding 513 later tombstones must not expose an older failed-unlink orphan", async () => {
  const { masterMemory } = await import("../extension/lib/memory.js");
  const store = masterMemory();
  const staleLiveVersion = await store.set("victim", "live");
  const deletedVersion = await store.compareAndDelete("victim", staleLiveVersion);
  assertEquals(await store.get("victim"), null, "a failed unlink is hidden by the tombstone");
  for (let index = 0; index < 513; index++) {
    const key = `fold-${index}`;
    await store.set(key, index);
    await store.delete(key);
  }
  assertEquals(await store.get("victim"), null, "compaction must not resurrect an orphan");
  assertEquals(await store.has("victim"), false);
  assertEquals((await store.keys()).includes("victim"), false);
  assertEquals(await store.getVersion("victim"), deletedVersion,
    "a retained tombstone, not an orphaned envelope, owns the version token");
  assertEquals(await store.compareAndRestore("victim", staleLiveVersion, "stale"), false,
    "a stale pre-delete CAS cannot resurrect the orphan");
});
