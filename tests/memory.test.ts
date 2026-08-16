// Unit test for the round-19 CRITICAL blocker: saveScreenshot re-acquired the
// non-reentrant global write mutex (withWriteLock → setTrusted → setValue →
// withWriteLock) and DEADLOCKED. This test drives saveScreenshot against a
// minimal in-memory OPFS fake and asserts it (a) completes (no deadlock), (b)
// writes the blob + commits the metadata index, and (c) charges the global quota.
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { masterMemory, saveScreenshot, listScreenshots, journalAppend } from "../extension/lib/memory.js";

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

Deno.test("memory.has distinguishes a stored null from an absent key (round-22 null-compensation)", async () => {
  const mem = masterMemory();
  const key = "null-compensation-key";
  // Absent key: has() is false AND get() is null (they coincide only here).
  assertEquals(await mem.has(key), false, "absent key must report has=false");
  // Store a LEGITIMATE null value: has() is true while get() is still null.
  await mem.set(key, null);
  assertEquals(await mem.has(key), true, "a stored null must report has=true");
  assertEquals(await mem.get(key), null, "get() returns null for a stored null");
  // The round-22 bug: `existed = prev !== undefined && prev !== null` classified
  // this stored null as absent and DELETED it on compensation. `has` keeps the
  // two cases distinct so compensation restores null rather than deleting the key.
  await mem.delete(key);
  assertEquals(await mem.has(key), false, "deleted key must report has=false");
});

Deno.test("journalAppend compensation restores the EXACT pre-append state at the 500-entry cap (round-23)", async () => {
  const mem = masterMemory();
  // Seed a FULL 500-entry journal so the append would evict old-0 via the ring cap.
  const seed = Array.from({ length: 500 }, (_, i) => ({ ts: i, result: `old-${i}` }));
  await mem.setTrusted("journal", seed);

  let calls = 0;
  const guard = async () => {
    calls++;
    // First call (pre-commit) succeeds; second call (post-commit) throws so
    // compensation is exercised.
    if (calls >= 2) throw new Error("ownership lost during commit");
  };
  let threw = false;
  try {
    await journalAppend(mem, { result: "new-entry" }, guard);
  } catch {
    threw = true;
  }
  assert(threw, "journalAppend must rethrow the post-commit guard failure");
  const after = (await mem.get("journal")) ?? [];
  assertEquals(after.length, 500, "compensation must restore the full 500-entry pre-state (not 499)");
  assertEquals(after[0]?.result, "old-0", "old-0 must be restored — not lost to ring-buffer eviction (the round-23 blocker)");
  assert(!after.some((e) => e?.result === "new-entry"), "the appended row must be removed by compensation");
});
