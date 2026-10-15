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
import { enumerateMemoryStores } from "../extension/background/routes/memory.js";

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

Deno.test("9epn.11 P2: enumerateMemoryStores makes ZERO keys() calls across all four store types", async () => {
  // Pin all 4 store factories driven by the memory.stores route:
  // 1. masterMemory
  // 2. namedAgentMemory
  // 3. backgroundAgentMemory
  // 4. siteMemory
  const keysCalls = { master: 0, named: 0, background: 0, site: 0 };
  const countCalls = { master: 0, named: 0, background: 0, site: 0 };

  function instrumentStore(store, kind) {
    return new Proxy(store, {
      get(target, prop) {
        if (prop === "keys") {
          return async (...args) => {
            keysCalls[kind]++;
            return await target.keys(...args);
          };
        }
        if (prop === "count") {
          return async (...args) => {
            countCalls[kind]++;
            return await target.count(...args);
          };
        }
        const val = target[prop];
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
  }

  const fakeMaster = instrumentStore(masterMemory(), "master");
  const fakeNamed = instrumentStore(namedAgentMemory("agent-1"), "named");
  const fakeBg = instrumentStore(backgroundAgentMemory("bg-1"), "background");
  const fakeSite = instrumentStore(siteMemory("https://example.org"), "site");

  // Seed keys in each store
  await fakeMaster.set("master_k1", "v");
  await fakeNamed.set("named_k1", "v");
  await fakeBg.set("bg_k1", "v");
  await fakeSite.set("site_k1", "v");

  const res = await enumerateMemoryStores({
    listNamedAgentIds: async () => ["agent-1"],
    listBackgroundAgentIds: async () => ["bg-1"],
    listOrigins: async () => ["https://example.org"],
    listNamedAgents: async () => [{ id: "agent-1", name: "Agent One", instanceId: "agent-1" }],
    classifyAgentMemoryDirs: () => [{ dir: "agent-1", selector: "agent:agent-1", state: "canonical", readOnly: false }],
    masterMemory: () => fakeMaster,
    namedAgentMemory: () => fakeNamed,
    backgroundAgentMemory: () => fakeBg,
    siteMemory: () => fakeSite,
  });

  assert(res.ok === true);
  assertEquals(res.stores.length, 4, "all 4 store categories are returned");

  // Strict pin: ZERO keys() calls across all four stores
  assertEquals(keysCalls.master, 0, "masterMemory must receive 0 keys() calls");
  assertEquals(keysCalls.named, 0, "namedAgentMemory must receive 0 keys() calls");
  assertEquals(keysCalls.background, 0, "backgroundAgentMemory must receive 0 keys() calls");
  assertEquals(keysCalls.site, 0, "siteMemory must receive 0 keys() calls");

  // Each store received exactly 1 bounded count() call
  assertEquals(countCalls.master, 1, "masterMemory must receive 1 count() call");
  assertEquals(countCalls.named, 1, "namedAgentMemory must receive 1 count() call");
  assertEquals(countCalls.background, 1, "backgroundAgentMemory must receive 1 count() call");
  assertEquals(countCalls.site, 1, "siteMemory must receive 1 count() call");

  // Falsification drill: if an unpinned route implementation uses (await store.keys()).length,
  // keysCalls MUST be non-zero
  const legacyRevertRun = async (store) => (await store.keys()).length;
  await legacyRevertRun(fakeMaster);
  await legacyRevertRun(fakeNamed);
  await legacyRevertRun(fakeBg);
  await legacyRevertRun(fakeSite);
  assertEquals(keysCalls.master, 1, "legacy revert increments master keysCalls");
  assertEquals(keysCalls.named, 1, "legacy revert increments named keysCalls");
  assertEquals(keysCalls.background, 1, "legacy revert increments bg keysCalls");
  assertEquals(keysCalls.site, 1, "legacy revert increments site keysCalls");
});

Deno.test("9epn.11: data-memory-clear regex matches both numeric and capped 500+ label formats", () => {
  const parseCount = (text) => {
    const m = text.match(/clear-fixture\.example \((\d+)\+?\)/);
    return m ? Number(m[1]) : -1;
  };

  assertEquals(parseCount("clear-fixture.example (5)"), 5);
  assertEquals(parseCount("clear-fixture.example (500+)"), 500);
  assertEquals(parseCount("clear-fixture.example (unknown)"), -1);
});
