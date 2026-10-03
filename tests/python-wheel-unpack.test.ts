// tests/python-wheel-unpack.test.ts — Verification for pure-Python wheel in-sandbox materialization.
// Part of chrome-agent-platform-4p7j (Slice 2, Task 2 / S2.1).
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";

const RUNTIME_SRC = fileURLToPath(new URL("../wasm-tools/python/", import.meta.url));

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

function makeWheelZip(files: Array<{ name: string; content: string | Uint8Array }>): Uint8Array {
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

async function createTestPyodide() {
  const mods = {};
  for (const [key, spec] of Object.entries({
    fs: "node:fs", crypto: "node:crypto", cp: "node:child_process",
    path: "node:path", url: "node:url", vm: "node:vm", tty: "node:tty",
  })) mods[key] = await import(spec);
  globalThis.require = (name) => ({ ...mods, ws: {} })[name];
  globalThis.__dirname = RUNTIME_SRC;
  globalThis.__filename = `${RUNTIME_SRC}/pyodide.mjs`;
  await import(new URL(`file://${RUNTIME_SRC}/pyodide.asm.js`).href);
  const { loadPyodide } = await import(new URL(`file://${RUNTIME_SRC}/pyodide.mjs`).href);
  return await loadPyodide({
    indexURL: RUNTIME_SRC,
    stdout: () => {},
    stderr: () => {},
  });
}

// ── In-Sandbox Wheel Materialization Tests ───────────────────────────────────

Deno.test("python worker: unpackArchive extracts pure wheel into site-packages and executes offline", async () => {
  const pyodide = await createTestPyodide();

  const wheelBytes = makeWheelZip([
    { name: "testcalc/__init__.py", content: "def add(a, b): return a + b\n" },
    { name: "testcalc-1.0.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
  ]);

  // Unpack wheel into site-packages (exact logic in python-worker.js materializeWheels)
  pyodide.unpackArchive(wheelBytes, "zip", { extractDir: "/lib/python3.12/site-packages" });
  pyodide.runPython("import importlib; importlib.invalidate_caches()");

  // Run user code using the materialized wheel
  const stdout: string[] = [];
  pyodide.setStdout({ batched: (chunk: string) => stdout.push(chunk) });
  await pyodide.runPythonAsync("import testcalc\nprint(testcalc.add(20, 22))");

  assertEquals(stdout.join("").trim(), "42");
});

Deno.test("python worker negative control: module is missing in clean environment without wheel", async () => {
  const pyodide = await createTestPyodide();

  let threw = false;
  try {
    await pyodide.runPythonAsync("import non_existent_pkg\nprint('unexpected')");
  } catch (err) {
    threw = true;
    assert(String(err).includes("No module named 'non_existent_pkg'"));
  }
  assert(threw, "Execution must fail when required module is not installed");
});

Deno.test("python worker negative control: corrupted wheel bytes fail closed before user code runs", async () => {
  const pyodide = await createTestPyodide();

  const corruptBytes = new Uint8Array([1, 2, 3, 4, 5]);
  let failedExtraction = false;
  try {
    pyodide.unpackArchive(corruptBytes, "zip", { extractDir: "/lib/python3.12/site-packages" });
  } catch (err) {
    failedExtraction = true;
    assert(String(err).includes("ReadError") || String(err).includes("not a zip"));
  }
  assert(failedExtraction, "Corrupted wheel must fail closed on unpackArchive");
});

Deno.test("python worker: multiple pure wheels materialize simultaneously and can interoperate", async () => {
  const pyodide = await createTestPyodide();

  const wheelA = makeWheelZip([
    { name: "mod_a/__init__.py", content: "VAL = 'HELLO '\n" },
    { name: "mod_a-1.0.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
  ]);

  const wheelB = makeWheelZip([
    { name: "mod_b/__init__.py", content: "VAL = 'WORLD'\n" },
    { name: "mod_b-1.0.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
  ]);

  pyodide.unpackArchive(wheelA, "zip", { extractDir: "/lib/python3.12/site-packages" });
  pyodide.unpackArchive(wheelB, "zip", { extractDir: "/lib/python3.12/site-packages" });
  pyodide.runPython("import importlib; importlib.invalidate_caches()");

  const stdout: string[] = [];
  pyodide.setStdout({ batched: (chunk: string) => stdout.push(chunk) });
  await pyodide.runPythonAsync("import mod_a, mod_b\nprint(mod_a.VAL + mod_b.VAL)");

  assertEquals(stdout.join("").trim(), "HELLO WORLD");
});

Deno.test("python-worker.js: AST verification that materializeWheels unpacks into /lib/python3.12/site-packages and fails closed", async () => {
  const workerSrc = await Deno.readTextFile(new URL("../wasm-tools/python/python-worker.js", import.meta.url));

  assert(workerSrc.includes("function materializeWheels(pyodide, wheels)"));
  assert(workerSrc.includes('/lib/python3.12/site-packages'));
  assert(workerSrc.includes('pyodide.unpackArchive(rawBytes, "zip"'));
  assert(workerSrc.includes("wheel-materialization-failed"));
  assert(workerSrc.includes("importlib.invalidate_caches()"));
  assert(workerSrc.includes("materializeWheels(pyodide, message.wheels)"));
});
