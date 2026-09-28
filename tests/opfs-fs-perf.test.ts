// tests/opfs-fs-perf.test.ts
// Unit and falsification tests for OPFS & FS Performance improvements (chrome-agent-platform-d885.2)
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { rechunk } from "../extension/lib/backup-export.js";
import {
  searchFsGrantFiles,
  grepFsGrant,
  scanFsGrantManifest,
  saveFsGrant,
  DEFAULT_IGNORED_DIRS,
} from "../extension/lib/fs-grants.js";
import {
  masterMemory,
  siteMemory,
  resetAllStores,
} from "../extension/lib/memory.js";

// ============================================================================
// PART A: rechunk lazy stream reader locking & cancel
// ============================================================================

Deno.test("rechunk does NOT lock underlying stream until the returned stream is pulled", async () => {
  let cancelled = false;
  let cancelReason = null;
  const sourceChunks = [
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array([5, 6, 7, 8]),
  ];
  let chunkIdx = 0;

  const underlying = new ReadableStream({
    pull(controller) {
      if (chunkIdx < sourceChunks.length) {
        controller.enqueue(sourceChunks[chunkIdx++]);
      } else {
        controller.close();
      }
    },
    cancel(reason) {
      cancelled = true;
      cancelReason = reason;
    },
  });

  assertEquals(underlying.locked, false, "underlying stream starts unlocked");

  // Wrap in rechunk
  const rechunked = rechunk(underlying, 2);

  // CRITICAL: rechunking must NOT lock the stream eagerly!
  assertEquals(underlying.locked, false, "rechunk must not eagerly acquire reader");

  const reader = rechunked.getReader();
  // Before the first read/pull, underlying is still unlocked
  assertEquals(underlying.locked, false, "before first read(), underlying remains unlocked");

  // First read triggers pull() which acquires reader lazily
  const chunk1 = await reader.read();
  assertEquals(underlying.locked, true, "after first read(), underlying reader is acquired");
  assertEquals(chunk1.done, false);
  assertEquals(chunk1.value.length, 2);
  assertEquals(Array.from(chunk1.value), [1, 2]);

  // Read remaining chunks
  const chunk2 = await reader.read();
  assertEquals(Array.from(chunk2.value), [3, 4]);

  const chunk3 = await reader.read();
  assertEquals(Array.from(chunk3.value), [5, 6]);

  const chunk4 = await reader.read();
  assertEquals(Array.from(chunk4.value), [7, 8]);

  const end = await reader.read();
  assertEquals(end.done, true);
});

Deno.test("rechunk cleanly cancels underlying stream if cancelled before first pull", async () => {
  let cancelled = false;
  let cancelReason = null;

  const underlying = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel(reason) {
      cancelled = true;
      cancelReason = reason;
    },
  });

  assertEquals(underlying.locked, false);
  const rechunked = rechunk(underlying, 64);
  assertEquals(underlying.locked, false);

  // Cancel before any read
  await rechunked.cancel("user_aborted");
  assertEquals(cancelled, true, "underlying stream cancel was called");
  assertEquals(cancelReason, "user_aborted");
  assertEquals(underlying.locked, false, "underlying stream was not left locked");
});

// ============================================================================
// PART B: fs-grants ignore defaults & 8 KiB binary probe
// ============================================================================

function makeMockDirectory(tree, name = "root") {
  const makeFile = (fileName, val) => {
    const content = val.content ?? "";
    const bytes = val.bytes ?? new TextEncoder().encode(content);
    return {
      kind: "file",
      name: fileName,
      queryPermission: async () => "granted",
      getFile: async () => ({
        name: fileName,
        size: bytes.byteLength,
        lastModified: 1700000000000,
        text: async () => new TextDecoder().decode(bytes),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        slice: (start, end) => ({
          arrayBuffer: async () => bytes.subarray(start, end).slice().buffer,
        }),
      }),
    };
  };

  return {
    kind: "directory",
    name,
    queryPermission: async () => "granted",
    async *values() {
      for (const [key, val] of Object.entries(tree)) {
        if (typeof val === "object" && val !== null && !val.content && !val.bytes) {
          yield makeMockDirectory(val, key);
        } else {
          yield makeFile(key, val);
        }
      }
    },
    async getDirectoryHandle(dirName) {
      if (tree[dirName] && typeof tree[dirName] === "object") {
        return makeMockDirectory(tree[dirName], dirName);
      }
      throw new Error(`Directory not found: ${dirName}`);
    },
    async getFileHandle(fileName) {
      if (tree[fileName]) {
        return makeFile(fileName, tree[fileName]);
      }
      throw new Error(`File not found: ${fileName}`);
    },
  };
}

Deno.test("fs-grants DEFAULT_IGNORED_DIRS includes .git, node_modules, .deno", () => {
  assert(DEFAULT_IGNORED_DIRS.has(".git"));
  assert(DEFAULT_IGNORED_DIRS.has("node_modules"));
  assert(DEFAULT_IGNORED_DIRS.has(".deno"));
});

Deno.test("searchFsGrantFiles skips .git, node_modules, and .deno by default, includes with includeIgnored", async () => {
  const tree = {
    src: {
      "app.ts": { content: "console.log('hello');" },
    },
    node_modules: {
      lib: {
        "index.js": { content: "module.exports = {};" },
      },
    },
    ".git": {
      "config": { content: "[core]\nrepositoryformatversion = 0" },
    },
    ".deno": {
      "cache.json": { content: "{}" },
    },
  };

  const mockDir = makeMockDirectory(tree, "project-root");
  await saveFsGrant({
    grantId: "fsg_ignore_test",
    handle: mockDir,
    name: "project-root",
    mode: "readwrite",
  });

  // Default search without includeIgnored: should only find src/app.ts
  const defaultRes = await searchFsGrantFiles("", { grantId: "fsg_ignore_test" });
  assertEquals(defaultRes.ok, true);
  const defaultPaths = defaultRes.files.map((f) => f.relativePath).sort();
  assertEquals(defaultPaths, ["src/app.ts"]);

  // Search with includeIgnored: true: should find all 4 files
  const allRes = await searchFsGrantFiles("", { grantId: "fsg_ignore_test", includeIgnored: true });
  assertEquals(allRes.ok, true);
  const allPaths = allRes.files.map((f) => f.relativePath).sort();
  assertEquals(allPaths, [
    ".deno/cache.json",
    ".git/config",
    "node_modules/lib/index.js",
    "src/app.ts",
  ]);
});

Deno.test("grepFsGrant skips ignored directories by default and probes only first 8192 bytes for binary", async () => {
  // Create a file larger than 8192 bytes where byte 8193 is NUL (0).
  // A probe of the first 8192 bytes will NOT see the NUL and treat it as text.
  const largeBytes = new Uint8Array(10000);
  largeBytes.fill(97); // 'a'
  largeBytes[8193] = 0; // NUL after 8192 threshold

  // Another file that has NUL inside first 8192 bytes
  const binaryBytes = new Uint8Array(200);
  binaryBytes.fill(97);
  binaryBytes[50] = 0; // NUL inside probe window

  const tree = {
    "large-source.txt": { bytes: largeBytes },
    "real-binary.bin": { bytes: binaryBytes },
    node_modules: {
      "vendor.txt": { content: "target-needle in node_modules" },
    },
  };

  const mockDir = makeMockDirectory(tree, "grep-root");
  await saveFsGrant({
    grantId: "fsg_grep_test",
    handle: mockDir,
    name: "grep-root",
    mode: "readwrite",
  });

  // 1. By default, vendor.txt in node_modules is skipped
  const defaultGrep = await grepFsGrant("fsg_grep_test", { query: "target-needle" });
  assertEquals(defaultGrep.ok, true);
  assertEquals(defaultGrep.matches.length, 0);

  // 2. With includeIgnored: true, vendor.txt is matched
  const ignoredGrep = await grepFsGrant("fsg_grep_test", { query: "target-needle", includeIgnored: true });
  assertEquals(ignoredGrep.ok, true);
  assertEquals(ignoredGrep.matches.length, 1);
  assertEquals(ignoredGrep.matches[0].path, "node_modules/vendor.txt");

  // 3. Binary probe: real-binary.bin has NUL in first 8192 bytes, so it is skipped
  const binGrep = await grepFsGrant("fsg_grep_test", { query: "a" });
  assertEquals(binGrep.ok, true);
  const matchedFiles = binGrep.matches.map((m) => m.path);
  assert(!matchedFiles.includes("real-binary.bin"), "real-binary.bin must be skipped as binary");
  assert(matchedFiles.includes("large-source.txt"), "large-source.txt with NUL >8192 must be treated as text by probe");
});

Deno.test("scanFsGrantManifest skips ignored directories by default", async () => {
  const tree = {
    "README.md": { content: "# Hello" },
    node_modules: {
      "foo.js": { content: "bar" },
    },
  };

  const mockDir = makeMockDirectory(tree, "manifest-root");
  await saveFsGrant({
    grantId: "fsg_manifest_test",
    handle: mockDir,
    name: "manifest-root",
  });

  const defaultScan = await scanFsGrantManifest("fsg_manifest_test");
  assertEquals(defaultScan.ok, true);
  const defaultEntries = defaultScan.entries.map((e) => e.path);
  assertEquals(defaultEntries, ["README.md"]);

  const allScan = await scanFsGrantManifest("fsg_manifest_test", { includeIgnored: true });
  assertEquals(allScan.ok, true);
  const allEntries = allScan.entries.map((e) => e.path).sort();
  assertEquals(allEntries, ["README.md", "node_modules", "node_modules/foo.js"]);
});

// ============================================================================
// PART C: memory.js sharded write locks, metadata caching & resetAllStores
// ============================================================================

// Minimal OPFS fake for memory tests
function dirNode() {
  return { kind: "directory", children: new Map() };
}
function fileNode(content) {
  return { kind: "file", content };
}

let fileReadCount = 0;

class FakeWritable {
  constructor(node) {
    this.node = node;
    this.parts = [];
  }
  async write(s) {
    this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s));
  }
  async close() {
    this.node.content = this.parts.join("");
  }
}

class FakeFileHandle {
  constructor(node, name) {
    this.node = node;
    this.name = name;
  }
  get kind() {
    return "file";
  }
  async getFile() {
    fileReadCount++;
    const node = this.node;
    return {
      size: new TextEncoder().encode(node.content ?? "").byteLength,
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
    return new FakeFileHandle(this.node.children.get(name), name);
  }
  async removeEntry(name) {
    this.node.children.delete(name);
  }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node, name) : new FakeDirHandle(node)];
    }
  }
}

const memoryRoot = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: {
    storage: {
      async getDirectory() {
        return new FakeDirHandle(memoryRoot);
      },
    },
  },
  configurable: true,
  writable: true,
});

Deno.test("memory.js: sharded writeMutex allows concurrent writes to distinct stores and metadata caching avoids re-reads", async () => {
  await resetAllStores();

  const storeA = siteMemory("https://alpha.example.com");
  const storeB = siteMemory("https://beta.example.com");

  // Perform initial writes to seed stores
  await storeA.set("key1", "valA1");
  await storeB.set("key1", "valB1");

  // Verify initial read
  assertEquals(await storeA.get("key1"), "valA1");
  assertEquals(await storeB.get("key1"), "valB1");

  // Track reads during metadata caching
  fileReadCount = 0;

  // Multiple sequential writes to storeA
  await storeA.set("key2", "valA2");
  await storeA.set("key3", "valA3");

  // Version tokens must be monotonic
  const v1 = await storeA.getVersion("key1");
  const v2 = await storeA.getVersion("key2");
  const v3 = await storeA.getVersion("key3");
  assert(v1 < v2, `v1 (${v1}) must be < v2 (${v2})`);
  assert(v2 < v3, `v2 (${v2}) must be < v3 (${v3})`);

  // Concurrent writes to both stores
  const concurrentWrites = await Promise.all([
    storeA.set("concurrent", "alpha-done"),
    storeB.set("concurrent", "beta-done"),
  ]);
  assert(concurrentWrites[0] > 0);
  assert(concurrentWrites[1] > 0);

  assertEquals(await storeA.get("concurrent"), "alpha-done");
  assertEquals(await storeB.get("concurrent"), "beta-done");

  // Deletion maintains tombstones
  await storeA.delete("key2");
  assertEquals(await storeA.has("key2"), false);
  assertEquals(await storeA.get("key2"), null);
  const deletedV = await storeA.getVersion("key2");
  assert(deletedV > v2, "tombstone version must be higher than live version");

  // resetAllStores clears mutexes and caches cleanly
  await resetAllStores();
  assertEquals(await storeA.get("key1"), "valA1");
});
