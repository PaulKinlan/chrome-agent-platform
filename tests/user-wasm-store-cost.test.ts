// tests/user-wasm-store-cost.test.ts — chrome-agent-platform-h2ge.
//
// The COST properties of the owner-blob store, pinned so they cannot regress
// silently:
//
//   1. get/remove/put NEVER enumerate the store directory — list() is the only
//      recovery site. On the pre-h2ge store every operation ran recover(),
//      which enumerated the whole directory and parsed every metadata file, so
//      this test FAILS on the old code by design. That is the point.
//   2. A large put does NOT hold the origin lock for its whole byte stream: a
//      concurrent list() on a second store instance completes while the put is
//      still streaming. On the pre-h2ge store put held the lock across the
//      stream, so this test fails there too.
//   3. In-flight temporaries are named with a creation stamp and are skipped
//      by the recovery prune while fresh; crashed temporaries age past the
//      grace and are pruned.
//
// The fixture is the same shape as tests/user-wasm-store.test.ts (injected
// OPFS + real Web Locks), with an enumeration counter wired into entries().
// @ts-nocheck — injected OPFS handles model browser commit-on-close semantics.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createOwnerBlobStore, OWNER_BLOBS_ROOT } from "../extension/lib/user-wasm-store.js";

function fixture({ now = () => 123456 } = {}) {
  const files = new Map();
  const directories = new Map();
  let enumerations = 0;
  function directory(prefix = "") {
    return {
      kind: "directory",
      _prefix: prefix,
      async getDirectoryHandle(name, { create } = {}) {
        if (!directories.has(prefix + name)) {
          if (!create) {
            const error = new DOMException("Missing file", "NotFoundError");
            throw error;
          }
          directories.set(prefix + name, directory(prefix + name + "/"));
        }
        return directories.get(prefix + name);
      },
      async getFileHandle(name, { create } = {}) {
        const path = prefix + name;
        if (!files.has(path)) {
          if (!create) throw missing();
          files.set(path, new Blob());
        }
        return {
          kind: "file",
          get name() { return path.slice(prefix.length); },
          async getFile() {
            if (!files.has(path)) throw missing();
            return files.get(path);
          },
          async createWritable() {
            const chunks = [];
            return {
              async write(chunk) { chunks.push(chunk); },
              async close() { files.set(path, new Blob(chunks)); },
              async abort() {},
            };
          },
          async move(nameOrDir, maybeName) {
            const [destPrefix, newName] = typeof nameOrDir === "string"
              ? [prefix, nameOrDir]
              : [nameOrDir._prefix ?? "", maybeName];
            files.set(destPrefix + newName, files.get(path));
            files.delete(path);
          },
        };
      },
      async removeEntry(name, { recursive } = {}) {
        const path = prefix + name;
        if (recursive) {
          for (const key of [...files.keys()]) if (key.startsWith(path)) files.delete(key);
          for (const key of [...directories.keys()]) if (key.startsWith(path)) directories.delete(key);
          return;
        }
        if (!files.delete(path)) throw missing();
      },
      async *entries() {
        enumerations += 1;
        for (const path of [...files.keys()]) {
          if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
            yield [path.slice(prefix.length), { kind: "file" }];
          }
        }
      },
    };
  }
  function missing() {
    const error = new DOMException("Missing file", "NotFoundError");
    return error;
  }
  const storage = { getDirectory: async () => directory() };
  const options = { storage, locks: navigator.locks, now };
  return {
    files, options, now,
    enumerations: () => enumerations,
    store: createOwnerBlobStore(options),
  };
}

const upload = (file, name = "Owner name") => ({ file, name, description: "", kind: "wasm" });

Deno.test("store cost: get, remove and put never enumerate the store directory", async () => {
  const f = fixture();
  await f.store.put(upload(new Blob(["alpha"]), "Alpha"));
  const b = await f.store.put(upload(new Blob(["beta"]), "Beta"));
  assertEquals(f.enumerations(), 0, "seeding puts never enumerate the directory");

  await f.store.getFile(b.digest);
  assertEquals(f.enumerations(), 0, "getFile must not enumerate the directory");

  await f.store.remove(b.digest);
  assertEquals(f.enumerations(), 0, "remove must not enumerate the directory");

  await f.store.put(upload(new Blob(["gamma"]), "Gamma"));
  assertEquals(f.enumerations(), 0, "a later put must not enumerate the directory");

  // The O(1) reads are still real reads: the gamma record survived the ops
  // above and its bytes come back exactly.
  const listed = await f.store.list();
  assertEquals(listed.map((m) => m.name).sort(), ["Alpha", "Gamma"]);
  const gamma = listed.find((m) => m.name === "Gamma");
  assertEquals(await (await f.store.getFile(gamma.digest)).text(), "gamma");
});

Deno.test("store cost: list() is the only enumeration site and stays complete", async () => {
  const f = fixture();
  await f.store.put(upload(new Blob(["one"])));
  await f.store.put(upload(new Blob(["two"])));
  const before = f.enumerations();
  const listed = await f.store.list();
  assert(f.enumerations() > before, "list() recovers through the directory — it must enumerate");
  assertEquals(listed.length, 2);
});

Deno.test("store lock scope: a concurrent list() completes while a large put is still streaming", async () => {
  const f = fixture();
  const other = createOwnerBlobStore(f.options);
  // A multi-megabyte upload whose stream yields slowly, so the streaming phase
  // is observably long.
  const total = 8 * 1024 * 1024;
  const chunkSize = 64 * 1024;
  const chunk = new Uint8Array(chunkSize);
  const big = new Blob([new Uint8Array(total)]);
  let offset = 0;
  big.stream = () => new ReadableStream({
    async pull(controller) {
      if (offset >= total) { controller.close(); return; }
      controller.enqueue(chunk);
      offset += chunkSize;
      await new Promise((r) => setTimeout(r, 1));
    },
  });
  let streamed = 0;
  const putPromise = f.store.put(upload(big, "Big"), {
    onProgress(size) { if (size >= chunkSize) streamed = size; },
  });
  // Wait until the put is provably streaming (past its first chunk).
  while (streamed === 0) await new Promise((r) => setTimeout(r, 1));
  assert(streamed > 0 && streamed < total, "the put must still be mid-stream");
  // On the pre-h2ge store the put holds the origin lock across the whole
  // stream, so this list() cannot resolve until the put is done.
  const race = await Promise.race([
    other.list().then(() => "list"),
    putPromise.then(() => "put"),
  ]);
  assertEquals(race, "list", "list() must complete while the put is still streaming");
  await putPromise;
});

Deno.test("store lock scope: two concurrent puts of different bytes both publish, same bytes publish once", async () => {
  const f = fixture();
  const other = createOwnerBlobStore(f.options);
  const [a, b] = await Promise.all([
    f.store.put(upload(new Blob(["a-bytes"]), "A")),
    other.put(upload(new Blob(["b-bytes"]), "B")),
  ]);
  const again = await other.put(upload(new Blob(["a-bytes"]), "A2"));
  assertEquals(again.replaced, true, "same bytes re-upload is a replacement");
  const listed = await f.store.list();
  assertEquals(listed.map((m) => m.name).sort(), ["A2", "B"]); // same-bytes re-upload updates the name: one entry
  assertEquals(listed.length, 2, "two concurrent puts of different bytes both publish");
  void a; void b;
});

Deno.test("store cost: crashed temporaries age past the grace and are pruned; live ones survive", async () => {
  let clock = 1_000_000;
  const f = fixture({ now: () => clock });
  const root = await (await f.options.storage.getDirectory()).getDirectoryHandle(OWNER_BLOBS_ROOT, { create: true });
  // A crashed temporary from an hour ago, and a live one streaming right now.
  await (await root.getFileHandle("upload-40000-1a2b3c4d-0000-4000-8000-000000000000.bin", { create: true })).createWritable().then(async (w) => { await w.write("partial"); await w.close(); });
  await (await root.getFileHandle(`upload-${clock}-6b1c2d3e-1111-4222-8333-444455556666.bin`, { create: true })).createWritable().then(async (w) => { await w.write("in flight"); await w.close(); });
  clock = 1_030_000; // 30 seconds pass — the crashed one is past the grace, the live one is not
  const listed = await f.store.list();
  assertEquals(listed, [], "no records: temporaries are never records");
  let names = [...f.files.keys()];
  assert(!names.some((n) => n.includes("0000-4000-8000")), "the aged temporary is pruned");
  assert(names.some((n) => n.includes("444455556666")), "the in-flight temporary survives the prune");
});

// ── h2ge REVISE findings: intent completion and corrupt-record preservation ──

Deno.test("store integrity: a crashed remove's durable intent is completed by getFile, O(1), with no list()", async () => {
  const f = fixture();
  const saved = await f.store.put(upload(new Blob(["delete me"])),);
  // Simulate the crash: the intent is durable, the metadata and bytes remain.
  const root = await (await f.options.storage.getDirectory()).getDirectoryHandle(OWNER_BLOBS_ROOT, { create: true });
  await (await root.getFileHandle(`delete-${saved.digest}.json`, { create: true })).createWritable().then(async (w) => { await w.write(JSON.stringify({ digest: saved.digest })); await w.close(); });
  const before = f.enumerations();
  // The owner asked for this deletion: getFile completes it and answers NotFound.
  await assertRejects(() => f.store.getFile(saved.digest), DOMException, "Stored file not found");
  assertEquals(f.enumerations(), before, "the completion is O(1) — no directory scan");
  // Every trace is gone: the finished delete needed no list() and no second op.
  assertEquals([...f.files.keys()], []);
});

Deno.test("store integrity: a put over a corrupt same-digest record preserves the bytes and fails closed", async () => {
  const f = fixture();
  const file = new Blob(["original bytes"]);
  const saved = await f.store.put(upload(file));
  const root = await (await f.options.storage.getDirectory()).getDirectoryHandle(OWNER_BLOBS_ROOT, { create: true });
  await (await root.getFileHandle(`${saved.digest}.json`, { create: true })).createWritable().then(async (w) => {
    await w.write(JSON.stringify({ version: 2, digest: saved.digest, kind: "executable", name: "x", description: "", size: file.size, addedAt: 1 }));
    await w.close();
  });
  // Re-uploading the SAME bytes must not destroy the record it cannot read.
  await assertRejects(() => f.store.put(upload(file, "again")), Error, "Invalid stored metadata for blob");
  const names = [...f.files.keys()];
  // f.files is keyed by the full OPFS path (the root prefix included), so the
  // membership check is suffix-based, never Array.includes (element equality).
  assert(names.some((n) => n.endsWith(`${saved.digest}.bin`)), "the stored bytes are preserved");
  assert(names.some((n) => n.endsWith(`${saved.digest}.json`)), "the corrupt record is preserved for its owner");
  const stored = await (await (await root.getFileHandle(`${saved.digest}.bin`)).getFile()).text();
  assertEquals(stored, "original bytes");
  // And the fail-closed posture is unchanged: recovery still refuses the tree.
  const reopened = createOwnerBlobStore(f.options);
  await assertRejects(() => reopened.list(), Error, "Invalid stored metadata for blob");
});
