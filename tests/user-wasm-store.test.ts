// @ts-nocheck — injected OPFS handles model browser commit-on-close semantics.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createUserWasmStore } from "../extension/lib/user-wasm-store.js";

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
          async move(name) {
            check("move", path);
            files.set(prefix + name, files.get(path));
            files.delete(path);
            path = prefix + name;
          },
        };
      },
      async removeEntry(name) {
        const path = prefix + name;
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
    store: createUserWasmStore(options),
    fail(op, suffix) { fault = { op, suffix }; },
  };
}
const hex = (bytes) => [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");
const digest = async (file) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())));
const upload = (file, name = "Owner name", description = "Owner description") => ({ file, name, description });

Deno.test("user-wasm: stores arbitrary bytes exactly, by their digest, and survives reopening", async () => {
  const f = fixture();
  const file = new Blob(["not valid WebAssembly\u0000\u00ff"]);
  const expected = await digest(file);
  const saved = await f.store.put(upload(file));
  assertEquals(saved, { version: 1, digest: expected, name: "Owner name", description: "Owner description", size: file.size, addedAt: 123456 });
  const reopened = createUserWasmStore(f.options);
  assertEquals(await reopened.list(), [saved]);
  assertEquals(await (await reopened.getFile(expected)).arrayBuffer(), await file.arrayBuffer());
});

Deno.test("user-wasm: names are metadata, never paths; description and Unicode are preserved", async () => {
  const f = fixture();
  const saved = await f.store.put(upload(new Blob(["hello"]), "../../工具.wasm", "<img onerror=alert(1)>\n💡"));
  assertEquals(saved.name, "../../工具.wasm");
  assertEquals(saved.description, "<img onerror=alert(1)>\n💡");
  assertEquals([...f.files.keys()].sort(), [`cap-user-wasm-v1/${saved.digest}.json`, `cap-user-wasm-v1/${saved.digest}.wasm`]);
});

Deno.test("user-wasm: identical bytes update metadata; same name with different bytes keeps both", async () => {
  const f = fixture();
  const file = new Blob(["first"]);
  const first = await f.store.put(upload(file));
  const secondStore = createUserWasmStore({ ...f.options, now: () => 999999 });
  const renamed = await secondStore.put(upload(file, "Renamed", "Changed"));
  assertEquals(renamed.digest, first.digest);
  assertEquals(renamed.addedAt, first.addedAt);
  assertEquals((await f.store.list()).length, 1);
  assertEquals((await f.store.list())[0].name, "Renamed");
  await f.store.put(upload(new Blob(["different"]), "Renamed"));
  assertEquals((await f.store.list()).map((m) => m.name), ["Renamed", "Renamed"]);
});

Deno.test("user-wasm: list reads metadata only, never module bytes", async () => {
  const f = fixture();
  const saved = await f.store.put(upload(new Blob(["opaque bytes"])));
  f.calls.length = 0;
  assertEquals(await f.store.list(), [saved]);
  assertEquals(f.calls.filter(([op, path]) => op === "read" && path.endsWith(".wasm")), []);
});

Deno.test("user-wasm: input is streamed without calling whole-file arrayBuffer", async () => {
  const f = fixture();
  const file = new Blob([new Uint8Array(2 * 1024 * 1024 + 71)]);
  const expected = await digest(file);
  file.arrayBuffer = () => { throw new Error("whole-file allocation forbidden"); };
  const saved = await f.store.put(upload(file));
  assertEquals(saved.digest, expected);
  assertEquals(saved.size, 2 * 1024 * 1024 + 71);
  assertEquals((await f.store.getFile(saved.digest)).size, file.size);
});

for (const [op, suffix] of [["write", ".wasm"], ["close", ".wasm"], ["move", ".wasm"], ["write", ".json"], ["close", ".json"]]) {
  Deno.test(`user-wasm: ${op} failure on ${suffix} never publishes a partial file`, async () => {
    const f = fixture();
    f.fail(op, suffix);
    await assertRejects(() => f.store.put(upload(new Blob(["failed upload"]))), DOMException, "Injected storage failure");
    assertEquals(await createUserWasmStore(f.options).list(), []);
    assertEquals([...f.files.keys()], []);
  });
}

Deno.test("user-wasm: failed metadata update preserves the existing bytes and labels", async () => {
  const f = fixture();
  const file = new Blob(["original"]);
  const saved = await f.store.put(upload(file));
  f.fail("close", ".json");
  await assertRejects(() => f.store.put(upload(file, "Uncommitted")), DOMException);
  assertEquals(await f.store.list(), [saved]);
  assertEquals(await (await f.store.getFile(saved.digest)).text(), "original");
});

Deno.test("user-wasm: removal deletes both bytes and metadata; retry is idempotent", async () => {
  const f = fixture();
  const saved = await f.store.put(upload(new Blob(["delete me"])));
  await f.store.remove(saved.digest);
  assertEquals(await createUserWasmStore(f.options).list(), []);
  assertEquals([...f.files.keys()], []);
  await f.store.remove(saved.digest);
  await assertRejects(() => f.store.getFile(saved.digest));
});

Deno.test("user-wasm: interrupted deletion completes on reopening", async () => {
  const f = fixture();
  const saved = await f.store.put(upload(new Blob(["delete me"])));
  f.fail("remove", ".wasm");
  await assertRejects(() => f.store.remove(saved.digest), DOMException);
  assertEquals(await createUserWasmStore(f.options).list(), []);
  assertEquals([...f.files.keys()], []);
});

Deno.test("user-wasm: concurrent store instances serialize put/remove without lost updates", async () => {
  const f = fixture();
  const other = createUserWasmStore(f.options);
  const [a, b] = await Promise.all([
    f.store.put(upload(new Blob(["a"]), "A")),
    other.put(upload(new Blob(["b"]), "B")),
  ]);
  await Promise.all([f.store.remove(a.digest), other.put(upload(new Blob(["c"]), "C"))]);
  assertEquals((await f.store.list()).map((m) => m.name).sort(), ["B", "C"]);
  assertEquals(await (await other.getFile(b.digest)).text(), "b");
});

for (const op of ["write", "close"]) {
  Deno.test(`user-wasm: ${op} failure before delete intent commits preserves the file`, async () => {
    const f = fixture();
    const saved = await f.store.put(upload(new Blob(["keep me"])));
    f.fail(op, `delete-${saved.digest}.json`);
    await assertRejects(() => f.store.remove(saved.digest), DOMException);
    assertEquals(await createUserWasmStore(f.options).list(), [saved]);
    assertEquals(await (await f.store.getFile(saved.digest)).text(), "keep me");
  });
}

Deno.test("user-wasm: a file above the 64 MiB message boundary is stored without a whole-file allocation", async () => {
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

Deno.test("user-wasm: digest parameters cannot traverse the OPFS tree", async () => {
  const f = fixture();
  for (const id of ["../x", "", "A".repeat(64), "a".repeat(63), "a/".repeat(32)]) {
    await assertRejects(() => f.store.remove(id), Error, "digest");
    await assertRejects(() => f.store.getFile(id), Error, "digest");
  }
  assertEquals([...f.files.keys()], []);
});
