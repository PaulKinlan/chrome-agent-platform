// tests/wheel-store-routes.test.ts — Unit tests for pure-Python wheel validation and OPFS storage routes.
// Part of chrome-agent-platform-4p7j (Slice 2, Task 1 / S1.1).
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { validatePurePythonWheel } from "../extension/lib/python-wheel-validator.js";
import { createOwnerBlobStore, listOwnerBlobs } from "../extension/lib/user-wasm-store.js";

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files: Array<{ name: string; content: string | Uint8Array }>): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const cdChunks: Uint8Array[] = [];
  let offset = 0;

  for (const { name, content } of files) {
    const nameBytes = new TextEncoder().encode(name);
    const dataBytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const crc = crc32(dataBytes);
    const size = dataBytes.byteLength;

    const local = new Uint8Array(30 + nameBytes.byteLength + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    local.set(dataBytes, 30 + nameBytes.byteLength);
    localChunks.push(local);

    const cd = new Uint8Array(46 + nameBytes.byteLength);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdChunks.push(cd);
    offset += local.byteLength;
  }

  const cdSize = cdChunks.reduce((acc, c) => acc + c.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  for (const c of localChunks) { out.set(c, pos); pos += c.byteLength; }
  for (const c of cdChunks) { out.set(c, pos); pos += c.byteLength; }
  out.set(eocd, pos);
  return out;
}

// In-memory OPFS storage fixture
function opfsFixture() {
  const files = new Map();
  const directories = new Map();
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
          async getFile() { return files.get(path); },
          async move(nameOrDir, maybeName) {
            const [destPrefix, newName] = typeof nameOrDir === "string"
              ? [prefix, nameOrDir]
              : [nameOrDir._prefix ?? "", maybeName];
            files.set(destPrefix + newName, files.get(path));
            files.delete(path);
            path = destPrefix + newName;
          },
          async createWritable() {
            let buffer = new Uint8Array();
            return {
              async write(data) {
                if (data instanceof Blob) {
                  buffer = new Uint8Array(await data.arrayBuffer());
                } else if (typeof data === "string") {
                  buffer = new TextEncoder().encode(data);
                } else if (data instanceof Uint8Array) {
                  buffer = data;
                }
              },
              async close() { files.set(path, new Blob([buffer])); },
              async abort() {},
            };
          },
        };
      },
      async removeEntry(name) {
        const path = prefix + name;
        if (!files.has(path) && !directories.has(path)) throw missing();
        files.delete(path);
        directories.delete(path);
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
  return {
    storage: { getDirectory: async () => directory("") },
    locks: { request: async (_name, fn) => await fn() },
  };
}

// ── Pure Python Wheel Validation Tests ──────────────────────────────────────

Deno.test("validatePurePythonWheel: accepts a valid pure-Python wheel", () => {
  const zip = makeZip([
    { name: "testpkg/__init__.py", content: "ANSWER = 42\n" },
    { name: "testpkg-1.0.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
  ]);
  const res = validatePurePythonWheel({ name: "testpkg-1.0.0-py3-none-any.whl", bytes: zip });
  assertEquals(res.ok, true);
  assertEquals(res.name, "testpkg-1.0.0-py3-none-any.whl");
  assert(res.files.includes("testpkg/__init__.py"));
});

Deno.test("validatePurePythonWheel: refuses a valid zip containing native binary (.so / .pyd) in .whl clothing", () => {
  // Negative control required by coord: zip is valid, but payload is binary
  const zip = makeZip([
    { name: "fastmath/__init__.py", content: "import fastmath._accel\n" },
    { name: "fastmath/_accel.so", content: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02]) }, // ELF header
    { name: "fastmath-1.0.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
  ]);
  const res = validatePurePythonWheel({ name: "fastmath-1.0.0-py3-none-any.whl", bytes: zip });
  assertEquals(res.ok, false);
  assertEquals(res.refused, "binary-wheel-rejected");
  assert(res.error.includes("fastmath/_accel.so"));
});

Deno.test("validatePurePythonWheel: refuses an sdist or plain zip missing .dist-info/WHEEL", () => {
  const zip = makeZip([
    { name: "setup.py", content: "from setuptools import setup\n" },
    { name: "pkg/module.py", content: "x = 1\n" },
  ]);
  const res = validatePurePythonWheel({ name: "pkg-1.0.0-py3-none-any.whl", bytes: zip });
  assertEquals(res.ok, false);
  assertEquals(res.refused, "missing-dist-info");
});

Deno.test("validatePurePythonWheel: refuses ABI/platform-specific filename tags", () => {
  const zip = makeZip([
    { name: "numpy/__init__.py", content: "pass\n" },
    { name: "numpy-1.26.4.dist-info/WHEEL", content: "Wheel-Version: 1.0\n" },
  ]);
  const res = validatePurePythonWheel({ name: "numpy-1.26.4-cp312-cp312-manylinux.whl", bytes: zip });
  assertEquals(res.ok, false);
  assertEquals(res.refused, "not-pure-python");
});

Deno.test("validatePurePythonWheel: refuses corrupt or truncated zip bytes", () => {
  const corrupt = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
  const res = validatePurePythonWheel({ name: "test-1.0.0-py3-none-any.whl", bytes: corrupt });
  assertEquals(res.ok, false);
  assertEquals(res.refused, "invalid-zip");
});

// ── OPFS Storage Lifecycle Tests for Wheels ─────────────────────────────────

Deno.test("OPFS wheel storage: stores pure wheel, lists by kind, and deletes cleanly", async () => {
  const env = opfsFixture();
  const store = createOwnerBlobStore(env);

  const zip = makeZip([
    { name: "simpletool/__init__.py", content: "def run(): return 'ok'\n" },
    { name: "simpletool-0.1.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
  ]);

  const saved = await store.put({
    bytes: zip,
    name: "simpletool-0.1.0-py3-none-any.whl",
    description: "Simple pure-Python tool",
    kind: "wheel",
  });

  assert(typeof saved.digest === "string" && saved.digest.length === 64);
  assertEquals(saved.name, "simpletool-0.1.0-py3-none-any.whl");
  assertEquals(saved.kind, "wheel");

  const wheels = await listOwnerBlobs({ kind: "wheel", ...env });
  assertEquals(wheels.length, 1);
  assertEquals(wheels[0].digest, saved.digest);
  assertEquals(wheels[0].name, "simpletool-0.1.0-py3-none-any.whl");
  assertEquals(wheels[0].kind, "wheel");

  // Other blob kinds must not leak into wheel listing
  const wasmList = await listOwnerBlobs({ kind: "wasm", ...env });
  assertEquals(wasmList.length, 0);

  // Deletion
  await store.remove(saved.digest);
  const afterDelete = await listOwnerBlobs({ kind: "wheel", ...env });
  assertEquals(afterDelete.length, 0);
});

// ── Service Worker Route Contract Tests ─────────────────────────────────────

Deno.test("Service worker wheel routes: permissions and handler contracts", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));

  // Verify principal checks and implementation contracts
  const listRoute = sw.slice(sw.indexOf('async "wheel.list"'), sw.indexOf('async "wheel.put"'));
  assert(listRoute.includes('context?.principal !== "extension" && context?.principal !== "owner-options"'));
  assert(listRoute.includes('listOwnerBlobs({ kind: "wheel" })'));

  const putRoute = sw.slice(sw.indexOf('async "wheel.put"'), sw.indexOf('async "wheel.delete"'));
  assert(putRoute.includes('context?.principal !== "owner-options"'));
  assert(putRoute.includes("validatePurePythonWheel"));
  assert(putRoute.includes('kind: "wheel"'));

  const deleteRoute = sw.slice(sw.indexOf('async "wheel.delete"'), sw.indexOf('async "capabilities.status"'));
  assert(deleteRoute.includes('context?.principal !== "owner-options"'));
  assert(deleteRoute.includes("store.remove(d)"));
});
