// tests/memory-stores-perf.test.ts
// Tests for chrome-agent-platform-9epn.11: memory.stores diagnostics route must not
// walk stores with keys() on every Settings → Data open (perf #12).
// @ts-nocheck — OPFS fake is dynamic.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  masterMemory,
  namedAgentMemory,
  backgroundAgentMemory,
  siteMemory,
  durableRunMemory,
  countStoreKeys,
} from "../extension/lib/memory.js";

// In-memory OPFS mock structures
function dirNode() {
  return { kind: "directory", children: new Map() };
}
function fileNode(content) {
  return { kind: "file", content };
}

class FakeFileHandle {
  constructor(node, name = "") {
    this.node = node;
    this.name = name;
  }
  get kind() { return "file"; }
  async getFile() {
    return {
      size: (this.node.content ?? "").length,
      text: async () => this.node.content ?? "",
    };
  }
  async createWritable() {
    const node = this.node;
    const parts = [];
    return {
      async write(s) {
        parts.push(typeof s === "string" ? s : new TextDecoder().decode(s));
      },
      async close() {
        node.content = parts.join("");
      },
    };
  }
}

class FakeDirHandle {
  constructor(node) {
    this.node = node;
  }
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
    return new FakeFileHandle(this.node.children.get(name), name);
  }
  async removeEntry(name, opts = {}) {
    this.node.children.delete(name);
  }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node, name) : new FakeDirHandle(node)];
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

Deno.test("9epn.11: store.count({ cap }) stops early and reports capped state", async () => {
  const store = namedAgentMemory("agent-count-test");
  // Empty store
  assertEquals(await store.count({ cap: 500 }), { count: 0, capped: false });
  assertEquals(await countStoreKeys(store, 500), 0);

  // Seed 10 keys
  for (let i = 0; i < 10; i++) {
    await store.set(`k_${i}`, `v_${i}`);
  }

  // Under cap
  assertEquals(await store.count({ cap: 50 }), { count: 10, capped: false });
  assertEquals(await countStoreKeys(store, 50), 10);

  // At/over cap: stops as soon as cap is reached
  assertEquals(await store.count({ cap: 5 }), { count: 5, capped: true });
  assertEquals(await countStoreKeys(store, 5), "5+");

  // Tombstones are respected: deleted key is not counted
  await store.delete("k_0");
  assertEquals(await store.count({ cap: 50 }), { count: 9, capped: false });
  assertEquals(await countStoreKeys(store, 50), 9);
});

Deno.test("9epn.11: durableRunMemory implements bounded count()", async () => {
  const durable = durableRunMemory();
  const res = await durable.count({ cap: 500 });
  assert(typeof res.count === "number");
  assert(typeof res.capped === "boolean");
});

Deno.test("9epn.11: countStoreKeys makes ZERO store.keys() calls", async () => {
  const store = siteMemory("https://example.com");
  for (let i = 0; i < 20; i++) {
    await store.set(`entry_${i}`, i);
  }

  let keysCalls = 0;
  let countCalls = 0;
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === "keys") {
        return async (...args) => {
          keysCalls++;
          return await target.keys(...args);
        };
      }
      if (prop === "count") {
        return async (...args) => {
          countCalls++;
          return await target.count(...args);
        };
      }
      const val = target[prop];
      return typeof val === "function" ? val.bind(target) : val;
    },
  });

  const countResult = await countStoreKeys(proxy, 10);
  assertEquals(countResult, "10+");
  assertEquals(countCalls, 1, "store.count() must be invoked");
  assertEquals(keysCalls, 0, "store.keys() must NOT be called on countStoreKeys");

  // Falsification: the pre-change pattern (await store.keys()).length MUST trip keysCalls
  const preChangeCount = (await proxy.keys()).length;
  assertEquals(preChangeCount, 20);
  assertEquals(keysCalls, 1, "legacy (await store.keys()).length triggers keysCalls");
});

Deno.test("9epn.11: bounded count benchmarks < 5 ms even with high key volumes", async () => {
  const store = masterMemory();
  for (let i = 0; i < 550; i++) {
    await store.set(`scale_key_${i}`, i);
  }

  const t0 = performance.now();
  const keyCount = await countStoreKeys(store, 500);
  const elapsed = performance.now() - t0;

  assertEquals(keyCount, "500+");
  assert(elapsed < 5, `countStoreKeys must finish in < 5ms on 500+ keys (took ${elapsed.toFixed(2)}ms)`);
});
