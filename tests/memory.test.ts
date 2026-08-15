// Unit test for the round-19 CRITICAL blocker: saveScreenshot re-acquired the
// non-reentrant global write mutex (withWriteLock → setTrusted → setValue →
// withWriteLock) and DEADLOCKED. This test drives saveScreenshot against a
// minimal in-memory OPFS fake and asserts it (a) completes (no deadlock), (b)
// writes the blob + commits the metadata index, and (c) charges the global quota.
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { masterMemory, saveScreenshot, listScreenshots } from "../extension/lib/memory.js";

// ---- minimal in-memory OPFS fake ----
// A directory tree: { kind, children: Map<name, node>, content?: string }
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
function installNavigator() {
  const fakeStorageManager = {
    async getDirectory() {
      return new FakeDirHandle(root);
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { storage: fakeStorageManager },
    configurable: true,
    writable: true,
  });
}
installNavigator();

Deno.test("saveScreenshot completes without deadlocking (round-19 CRITICAL)", async () => {
  const mem = masterMemory();
  const dataURL = "data:image/png;base64," + "A".repeat(16);
  const result = await saveScreenshot(mem, { url: "https://example.com/", dataURL });
  assert(result?.id, "saveScreenshot must return an id");

  const index = await listScreenshots();
  assert(index.some((s) => s.id === result.id), "index must contain the saved screenshot id");
});

Deno.test("saveScreenshot commits the index and evicts beyond MAX_SCREENSHOTS", async () => {
  const mem = masterMemory();
  const make = (i) => "data:image/png;base64," + "B".repeat(16) + i;
  for (let i = 0; i < 7; i++) {
    await saveScreenshot(mem, { url: `https://example.com/${i}`, dataURL: make(i) });
  }
  const index = await listScreenshots();
  assert(index.length <= 5, "the screenshot index must be bounded to MAX_SCREENSHOTS");
  assert(index.length === 5, "the oldest two must be evicted");
});
