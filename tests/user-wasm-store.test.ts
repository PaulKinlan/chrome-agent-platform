// @ts-nocheck — injected OPFS handles model browser commit-on-close semantics.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createOwnerBlobStore, OWNER_BLOB_KINDS, OWNER_BLOBS_ROOT } from "../extension/lib/user-wasm-store.js";

// Writes are invisible until close. Faults can happen at write, close, move,
// or remove; re-opening the store must never publish incomplete uploads.
function fixture() {
  const files = new Map();
  const directories = new Map();
  const calls = [];
  let fault = null;
  function check(op, path) {
    calls.push([op, path]);
    if (fault?.op === op && path.endsWith(fault.suffix)) {
      fault = null;
      throw new DOMException("Injected storage failure", "QuotaExceededError");
    }
  }
  const missing = () => new DOMException("Missing file", "NotFoundError");
  function directory(prefix = "") {
    return {
      kind: "directory",
      _prefix: prefix,
      async getDirectoryHandle(name, { create } = {}) {
        if (!directories.has(prefix + name)) {
          if (!create) throw missing();
          directories.set(prefix + name, directory(prefix + name + "/"));
        }
        return directories.get(prefix + name);
      },
      async getFileHandle(name, { create } = {}) {
        let path = prefix + name;
        if (!files.has(path)) {
          if (!create) throw missing();
          files.set(path, new Blob());
        }
        return {
          kind: "file",
          get name() { return path.slice(prefix.length); },
          async getFile() {
            check("read", path);
            if (!files.has(path)) throw missing();
            return files.get(path);
          },
          async createWritable() {
            const chunks = [];
            return {
              async write(chunk) { check("write", path); chunks.push(chunk); },
              async close() { check("close", path); files.set(path, new Blob(chunks)); },
              async abort() {},
            };
          },
          // Real OPFS move() has two forms: same-directory rename and
          // cross-directory move. Both must preserve bytes exactly.
          async move(nameOrDir, maybeName) {
            check("move", path);
            const [destPrefix, newName] = typeof nameOrDir === "string"
              ? [prefix, nameOrDir]
              : [nameOrDir._prefix ?? "", maybeName];
            files.set(destPrefix + newName, files.get(path));
            files.delete(path);
            path = destPrefix + newName;
          },
        };
      },
      async removeEntry(name, { recursive } = {}) {
        const path = prefix + name;
        if (recursive) {
          let removed = false;
          for (const key of [...files.keys()]) {
            if (key.startsWith(path)) { files.delete(key); removed = true; }
          }
          for (const key of [...directories.keys()]) {
            if (key.startsWith(path)) directories.delete(key);
          }
          if (!removed && !directories.has(path)) throw missing();
          return;
        }
        check("remove", path);
        if (!files.delete(path)) throw missing();
      },
      async *entries() {
        for (const path of [...files.keys()]) {
          if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
            yield [path.slice(prefix.length), { kind: "file" }];
          }
        }
      },
    };
  }
  const storage = { getDirectory: async () => directory() };
  // Real Web Locks coordinate independent store instances in Deno and Chrome.
  const options = { storage, locks: navigator.locks, now: () => 123456 };
  return {
    files, calls, options,
    store: createOwnerBlobStore(options),
    fail(op, suffix) { fault = { op, suffix }; },
  };
}
const hex = (bytes) => [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");
const digest = async (file) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())));
const upload = (file, name = "Owner name", description = "Owner description", kind = "wasm") => ({ file, name, description, kind });

Deno.test("owner-blobs: stores arbitrary bytes exactly, by their digest, and survives reopening", async () => {
  const f = fixture();
  const file = new Blob(["not valid WebAssembly\u0000\u00ff"]);
  const expected = await digest(file);
  const saved = await f.store.put(upload(file));
  assertEquals(saved, { version: 2, digest: expected, kind: "wasm", name: "Owner name", description: "Owner description", size: file.size, addedAt: 123456, replaced: false, previousName: null });
  const reopened = createOwnerBlobStore(f.options);
  assertEquals(await reopened.list(), [{ version: 2, digest: expected, kind: "wasm", name: "Owner name", description: "Owner description", size: file.size, addedAt: 123456 }]);
  assertEquals(await (await reopened.getFile(expected)).arrayBuffer(), await file.arrayBuffer());
});

Deno.test("owner-blobs: kinds come from the closed exported set and invalid kinds are refused", async () => {
  assertEquals(OWNER_BLOB_KINDS, ["wasm", "wheel"]);
  assert(Object.isFrozen(OWNER_BLOB_KINDS));
  const f = fixture();
  const wheel = await f.store.put(upload(new Blob(["PK\u0003\u0004 wheel bytes"]), "A wheel", "desc", "wheel"));
  assertEquals(wheel.kind, "wheel");
  const listed = await f.store.list();
  assertEquals(listed.map((m) => m.kind), ["wheel"]);
  await assertRejects(() => f.store.put(upload(new Blob(["x"]), "X", "", "executable")), TypeError, "Unknown blob kind");
  await assertRejects(() => f.store.put(upload(new Blob(["x"]), "X", "", "WASM")), TypeError, "Unknown blob kind");
  assertEquals(await f.store.list(), listed, "a refused kind must not publish anything");
});

Deno.test("owner-blobs: bytes (Uint8Array or ArrayBuffer) are accepted without wrapping by the caller", async () => {
  const f = fixture();
  const raw = new Uint8Array([1, 2, 3, 4, 5]);
  const expected = await digest(new Blob([raw]));
  const saved = await f.store.put({ bytes: raw, name: "From bytes", kind: "wheel" });
  assertEquals(saved.digest, expected);
  assertEquals(saved.kind, "wheel");
  assertEquals(await (await f.store.getFile(saved.digest)).arrayBuffer(), raw.buffer.slice(0, raw.byteLength * raw.BYTES_PER_ELEMENT).slice(0));
  const saved2 = await f.store.put({ bytes: raw.buffer, name: "From ArrayBuffer" });
  assertEquals(saved2.digest, expected, "ArrayBuffer and Uint8Array of the same bytes are the same blob");
});

Deno.test("owner-blobs: re-uploading identical bytes reports the explicit replacement signal", async () => {
  const f = fixture();
  const file = new Blob(["first"]);
  const first = await f.store.put(upload(file, "Original name"));
  assertEquals(first.replaced, false, "a fresh entry is not a replacement");
  assertEquals(first.previousName, null);
  const again = await f.store.put(upload(file, "Renamed"));
  assertEquals(again.replaced, true, "the caller is told this put replaced an entry");
  assertEquals(again.previousName, "Original name", "the caller learns the name it replaced");
  assertEquals(again.addedAt, first.addedAt, "addedAt is retained across replacement");
});

Deno.test("owner-blobs: names are metadata, never paths; description and Unicode are preserved", async () => {
  const f = fixture();
  const saved = await f.store.put(upload(new Blob(["hello"]), "../../工具.wasm", "<img onerror=alert(1)>\n💡"));
  assertEquals(saved.name, "../../工具.wasm");
  assertEquals(saved.description, "<img onerror=alert(1)>\n💡");
  assertEquals([...f.files.keys()].sort(), [
    `cap-owner-blobs-v1/${saved.digest}.bin`,
    `cap-owner-blobs-v1/${saved.digest}.json`,
  ]);
});

Deno.test("owner-blobs: identical bytes update metadata; same name with different bytes keeps both", async () => {
  const f = fixture();
  const file = new Blob(["first"]);
  const first = await f.store.put(upload(file));
  const secondStore = createOwnerBlobStore({ ...f.options, now: () => 999999 });
  const renamed = await secondStore.put(upload(file, "Renamed", "Changed"));
  assertEquals(renamed.digest, first.digest);
  assertEquals(renamed.addedAt, first.addedAt);
  assertEquals((await f.store.list()).length, 1);
  assertEquals((await f.store.list())[0].name, "Renamed");
  await f.store.put(upload(new Blob(["different"]), "Renamed"));
  assertEquals((await f.store.list()).map((m) => m.name), ["Renamed", "Renamed"]);
});

Deno.test("owner-blobs: list reads metadata only, never blob bytes", async () => {
  const f = fixture();
  const saved = await f.store.put(upload(new Blob(["opaque bytes"])));
  f.calls.length = 0;
  assertEquals(await f.store.list(), [{ ...saved, replaced: false, previousName: null }].map(({ replaced, previousName, ...record }) => record));
  assertEquals(f.calls.filter(([op, path]) => op === "read" && path.endsWith(".bin")), []);
});

Deno.test("owner-blobs: input is streamed without calling whole-file arrayBuffer", async () => {
  const f = fixture();
  const file = new Blob([new Uint8Array(2 * 1024 * 1024 + 71)]);
  const expected = await digest(file);
  file.arrayBuffer = () => { throw new Error("whole-file allocation forbidden"); };
  const saved = await f.store.put(upload(file));
  assertEquals(saved.digest, expected);
  assertEquals(saved.size, 2 * 1024 * 1024 + 71);
  assertEquals((await f.store.getFile(saved.digest)).size, file.size);
});

for (const [op, suffix] of [["write", ".bin"], ["close", ".bin"], ["move", ".bin"], ["write", ".json"], ["close", ".json"]]) {
  Deno.test(`owner-blobs: ${op} failure on ${suffix} never publishes a partial file`, async () => {
    const f = fixture();
    f.fail(op, suffix);
    await assertRejects(() => f.store.put(upload(new Blob(["failed upload"]))), DOMException, "Injected storage failure");
    assertEquals(await createOwnerBlobStore(f.options).list(), []);
    assertEquals([...f.files.keys()], []);
  });
}

Deno.test("owner-blobs: failed metadata update preserves the existing bytes and labels", async () => {
  const f = fixture();
  const file = new Blob(["original"]);
  const saved = await f.store.put(upload(file));
  f.fail("close", ".json");
  await assertRejects(() => f.store.put(upload(file, "Uncommitted")), DOMException);
  assertEquals(await f.store.list(), [{ ...saved, replaced: false, previousName: null }].map(({ replaced, previousName, ...record }) => record));
  assertEquals(await (await f.store.getFile(saved.digest)).text(), "original");
});

Deno.test("owner-blobs: removal deletes both bytes and metadata; retry is idempotent", async () => {
  const f = fixture();
  const saved = await f.store.put(upload(new Blob(["delete me"])));
  await f.store.remove(saved.digest);
  assertEquals(await createOwnerBlobStore(f.options).list(), []);
  assertEquals([...f.files.keys()], []);
  await f.store.remove(saved.digest);
  await assertRejects(() => f.store.getFile(saved.digest));
});

Deno.test("owner-blobs: interrupted deletion completes on reopening", async () => {
  const f = fixture();
  const saved = await f.store.put(upload(new Blob(["delete me"])));
  f.fail("remove", ".bin");
  await assertRejects(() => f.store.remove(saved.digest), DOMException);
  assertEquals(await createOwnerBlobStore(f.options).list(), []);
  assertEquals([...f.files.keys()], []);
});

Deno.test("owner-blobs: concurrent store instances serialize put/remove without lost updates", async () => {
  const f = fixture();
  const other = createOwnerBlobStore(f.options);
  const [a, b] = await Promise.all([
    f.store.put(upload(new Blob(["a"]), "A")),
    other.put(upload(new Blob(["b"]), "B")),
  ]);
  await Promise.all([f.store.remove(a.digest), other.put(upload(new Blob(["c"]), "C"))]);
  assertEquals((await f.store.list()).map((m) => m.name).sort(), ["B", "C"]);
  assertEquals(await (await other.getFile(b.digest)).text(), "b");
});

for (const op of ["write", "close"]) {
  Deno.test(`owner-blobs: ${op} failure before delete intent commits preserves the file`, async () => {
    const f = fixture();
    const saved = await f.store.put(upload(new Blob(["keep me"])));
    f.fail(op, `delete-${saved.digest}.json`);
    await assertRejects(() => f.store.remove(saved.digest), DOMException);
    assertEquals(await createOwnerBlobStore(f.options).list(), [ { ...saved, replaced: false, previousName: null } ].map(({ replaced, previousName, ...record }) => record));
    assertEquals(await (await f.store.getFile(saved.digest)).text(), "keep me");
  });
}

Deno.test("owner-blobs: a file above the 64 MiB message boundary is stored without a whole-file allocation", async () => {
  const f = fixture();
  const block = new Uint8Array(1024 * 1024).fill(0xa7);
  const file = new Blob([...Array(65).fill(block), new Uint8Array([1, 2, 3])]);
  assert(file.size > 64 * 1024 * 1024);
  const expected = await digest(file);
  file.arrayBuffer = () => { throw new Error("whole-file allocation forbidden"); };
  const saved = await f.store.put(upload(file, "Large input"));
  assertEquals(saved.digest, expected);
  const stored = await f.store.getFile(saved.digest);
  assertEquals(stored.size, file.size);
  assertEquals(new Uint8Array(await stored.slice(-3).arrayBuffer()), new Uint8Array([1, 2, 3]));
});

Deno.test("owner-blobs: digest parameters cannot traverse the OPFS tree", async () => {
  const f = fixture();
  for (const id of ["../x", "", "A".repeat(64), "a".repeat(63), "a/".repeat(32)]) {
    await assertRejects(() => f.store.remove(id), Error, "digest");
    await assertRejects(() => f.store.getFile(id), Error, "digest");
  }
  assertEquals([...f.files.keys()], []);
});

// ── v1 → v2 migration (chrome-agent-platform-m6x8) ─────────────────────────
// The pre-v2 root cap-user-wasm-v1 holds real owner bytes. Migration must
// surface them under the neutral root as kind "wasm", survive crashes between
// its steps without loss or duplication, never rewrite bytes, and fail closed
// when bytes are missing — exactly as v1 did.

/** Seeds a v1-format store exactly as the v1 code wrote it. */
async function seedV1(f, entries) {
  const v1 = await (await f.options.storage.getDirectory()).getDirectoryHandle("cap-user-wasm-v1", { create: true });
  for (const [bytes, name, description] of entries) {
    const file = bytes instanceof Blob ? bytes : new Blob([bytes]);
    const d = await digest(file);
    await (await v1.getFileHandle(`${d}.wasm`, { create: true })).createWritable().then(async (w) => { await w.write(await file.arrayBuffer()); await w.close(); });
    await (await v1.getFileHandle(`${d}.json`, { create: true })).createWritable().then(async (w) => {
      await w.write(JSON.stringify({ version: 1, digest: d, name, description, size: file.size, addedAt: 777 }));
      await w.close();
    });
    entries.digests ??= [];
    entries.digests.push(d);
  }
  return entries;
}

Deno.test("migration: a v1 store with entries opens under v2, listed with kind 'wasm', v1 root removed", async () => {
  const f = fixture();
  await seedV1(f, [["v1 module bytes", "Legacy module", "uploaded under v1"]]);
  const store = createOwnerBlobStore(f.options);
  const listed = await store.list();
  assertEquals(listed.length, 1);
  assertEquals(listed[0].kind, "wasm", "v1 entries are wasm by definition");
  assertEquals(listed[0].version, 2, "records are re-keyed to the v2 record version");
  assertEquals(listed[0].name, "Legacy module");
  assertEquals(listed[0].description, "uploaded under v1");
  assertEquals(listed[0].addedAt, 777, "the owner's original addedAt survives");
  assertEquals(listed[0].size, "v1 module bytes".length);
  const bytes = await (await store.getFile(listed[0].digest)).text();
  assertEquals(bytes, "v1 module bytes");
  // The v1 root is gone; everything lives under the neutral root as .bin.
  assertEquals([...f.files.keys()].sort(), [
    `cap-owner-blobs-v1/${listed[0].digest}.bin`,
    `cap-owner-blobs-v1/${listed[0].digest}.json`,
  ]);
  // Migration is one-shot: reopening is stable and idempotent.
  assertEquals(await createOwnerBlobStore(f.options).list(), listed);
});

Deno.test("migration: crash after the bytes moved but before v2 metadata committed — retry finishes, nothing lost or duplicated", async () => {
  const f = fixture();
  const seeded = await seedV1(f, [["crashed bytes", "Crash survivor", "mid-move"]]);
  const d = seeded.digests[0];
  // Reproduce the crash window by hand: bytes moved to v2, no v2 metadata,
  // v1 metadata still present.
  const parent = await f.options.storage.getDirectory();
  const v1 = await parent.getDirectoryHandle("cap-user-wasm-v1");
  const v2 = await parent.getDirectoryHandle("cap-owner-blobs-v1", { create: true });
  await (await v1.getFileHandle(`${d}.wasm`)).move(v2, `${d}.bin`);
  const store = createOwnerBlobStore(f.options);
  const listed = await store.list();
  assertEquals(listed.length, 1, "exactly one entry — never neither, never both");
  assertEquals(listed[0].digest, d);
  assertEquals(listed[0].kind, "wasm");
  assertEquals(await (await store.getFile(d)).text(), "crashed bytes");
  assertEquals([...f.files.keys()].filter((k) => k.startsWith("cap-user-wasm-v1")).length, 0, "v1 residue is cleaned");
});

Deno.test("migration: crash after v2 metadata committed but before v1 metadata removed — retry cleans up without duplicating", async () => {
  const f = fixture();
  const seeded = await seedV1(f, [["residue bytes", "Residue case", "post-commit crash"]]);
  const d = seeded.digests[0];
  const parent = await f.options.storage.getDirectory();
  const v1 = await parent.getDirectoryHandle("cap-user-wasm-v1");
  const v2 = await parent.getDirectoryHandle("cap-owner-blobs-v1", { create: true });
  // Both halves complete: v2 fully published, v1 not yet cleaned.
  await (await v1.getFileHandle(`${d}.wasm`)).move(v2, `${d}.bin`);
  await (await v2.getFileHandle(`${d}.json`, { create: true })).createWritable().then(async (w) => {
    await w.write(JSON.stringify({ version: 2, digest: d, kind: "wasm", name: "Residue case", description: "post-commit crash", size: "residue bytes".length, addedAt: 777 }));
    await w.close();
  });
  const store = createOwnerBlobStore(f.options);
  const listed = await store.list();
  assertEquals(listed.length, 1, "the stale v1 entry must not create a duplicate");
  assertEquals(listed[0].digest, d);
  assertEquals(await (await store.getFile(d)).text(), "residue bytes");
  assertEquals([...f.files.keys()].filter((k) => k.startsWith("cap-user-wasm-v1")).length, 0);
});

Deno.test("migration: a v1 entry whose bytes are missing fails CLOSED exactly as v1 did", async () => {
  const f = fixture();
  const seeded = await seedV1(f, [["doomed bytes", "Missing bytes", "the bytes are gone"]]);
  const d = seeded.digests[0];
  const parent = await f.options.storage.getDirectory();
  const v1 = await parent.getDirectoryHandle("cap-user-wasm-v1");
  await v1.removeEntry(`${d}.wasm`);
  const store = createOwnerBlobStore(f.options);
  await assertRejects(() => store.list(), Error, "Stored blob bytes are missing");
  await assertRejects(() => store.list(), Error, "Stored blob bytes are missing", "still failing closed on every subsequent open");
});

Deno.test("migration: never rewrites owner bytes — digest identity is preserved bit-for-bit", async () => {
  const f = fixture();
  const bytes = new Uint8Array(4096);
  crypto.getRandomValues(bytes);
  const seeded = await seedV1(f, [[bytes, "Random owner bytes", "bit-for-bit"]]);
  const before = await digest(new Blob([bytes]));
  assertEquals(seeded.digests[0], before);
  const store = createOwnerBlobStore(f.options);
  const listed = await store.list();
  assertEquals(listed[0].digest, before, "the digest over the original bytes is the digest after migration");
  const after = await digest(await store.getFile(before));
  assertEquals(after, before, "the migrated bytes hash identically");
});

Deno.test("migration: v1 temporaries and delete intents are resolved, not migrated", async () => {
  const f = fixture();
  const seeded = await seedV1(f, [["kept bytes", "Keeper", "survives the cleanup"]]);
  const d = seeded.digests[0];
  const parent = await f.options.storage.getDirectory();
  const v1 = await parent.getDirectoryHandle("cap-user-wasm-v1");
  await (await v1.getFileHandle("upload-crash-test.wasm", { create: true })).createWritable().then(async (w) => { await w.write("partial"); await w.close(); });
  await (await v1.getFileHandle(`delete-${d}.json`, { create: true })).createWritable().then(async (w) => { await w.write(JSON.stringify({ digest: d })); await w.close(); });
  const store = createOwnerBlobStore(f.options);
  assertEquals(await store.list(), [], "the durable v1 delete intent is completed, not migrated");
  assertEquals([...f.files.keys()], [], "temporaries and the intent are gone with the root");
});

Deno.test("owner-blobs: stored metadata with an out-of-set kind fails closed (kind validation is load-bearing)", async () => {
  const f = fixture();
  const file = new Blob(["legit"]);
  const saved = await f.store.put(upload(file));
  const d = saved.digest;
  // Corrupt the stored kind directly, as a future bad writer might.
  const root = await (await f.options.storage.getDirectory()).getDirectoryHandle("cap-owner-blobs-v1");
  await (await root.getFileHandle(`${d}.json`, { create: true })).createWritable().then(async (w) => {
    await w.write(JSON.stringify({ version: 2, digest: d, kind: "executable", name: "x", description: "", size: file.size, addedAt: 1 }));
    await w.close();
  });
  const reopened = createOwnerBlobStore(f.options);
  await assertRejects(() => reopened.list(), Error, "Invalid stored metadata for blob");
});
