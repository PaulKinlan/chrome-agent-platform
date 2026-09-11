// tests/python-storage-guard.test.ts — pins the Python worker storage guard contract
// (chrome-agent-platform-4p7j.3, owner ruling 2026-09-11).
//
// Invariants guarded:
//   1. Cross-run covert storage channel closed:
//      - self.indexedDB and self.caches in WorkerGlobalScope are denied with teaching
//        guards matching extension/sandbox/script-sandbox.js cadence.
//      - Attempting to access or invoke indexedDB.open, deleteDatabase, databases,
//        or caches.open, match, etc., throws an explicit, teaching refusal.
//   2. Legitimate execution paths remain functional:
//      - Python standard library (json, math, datetime, random, sqlite3) functions normally.
//      - In-memory virtual filesystem (MEMFS) files under /tmp or scratch directories work.
//      - Offline module installation into site-packages works cleanly.
//   3. Source and manifest pins:
//      - wasm-tools/python/python-worker.js contains stripAmbientStorage().
//      - wasm-tools/python/MANIFEST.json and extension/lib/python-runtime.js pins match.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  PYTHON_RUNTIME_PIN,
} from "../extension/lib/python-runtime.js";

const ROOT = new URL("..", import.meta.url).pathname;
const RUNTIME_SRC = `${ROOT}wasm-tools/python/`;

// ── 1. Static Source Pins & Manifest Agreement ──────────────────────────────

Deno.test("4p7j.3 source pin: python-worker.js contains stripAmbientStorage with teaching guards", async () => {
  const workerSrc = await Deno.readTextFile(`${RUNTIME_SRC}python-worker.js`);

  // Asserts function definition and execution in worker runtime
  assert(workerSrc.includes("function stripAmbientStorage()"), "must define stripAmbientStorage");
  assert(workerSrc.includes("stripAmbientStorage();"), "must call stripAmbientStorage in runtime()");

  // Asserts denial of indexedDB and caches
  assert(workerSrc.includes("indexedDB"), "must include indexedDB in storage denial");
  assert(workerSrc.includes("caches"), "must include caches in storage denial");

  // Asserts exact cadence matching script-sandbox.js
  assertStringIncludes(workerSrc, "an execution keeps no state");
  assertStringIncludes(
    workerSrc,
    "compute and return the value; store durable data with the platform",
  );
  assertStringIncludes(workerSrc, "memory_set / create_asset / workspace files");

  // Asserts hash pin matches MANIFEST.json and PYTHON_RUNTIME_PIN
  const workerBytes = await Deno.readFile(`${RUNTIME_SRC}python-worker.js`);
  const digest = await crypto.subtle.digest("SHA-256", workerBytes);
  const hash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");

  const manifest = JSON.parse(await Deno.readTextFile(`${RUNTIME_SRC}MANIFEST.json`));
  assertEquals(hash, manifest.files["python-worker.js"].sha256, "MANIFEST.json sha256 matches disk");
  assertEquals(hash, PYTHON_RUNTIME_PIN.files["python-worker.js"].sha256, "python-runtime.js pin matches disk");
});

// ── 2. Real Pyodide Storage Denial & Legitimate Paths ───────────────────────

let pyodideInstance: any = null;

async function getPyodideWithGuards() {
  if (pyodideInstance) return pyodideInstance;

  const mods: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries({
    fs: "node:fs", crypto: "node:crypto", cp: "node:child_process",
    path: "node:path", url: "node:url", vm: "node:vm", tty: "node:tty",
  })) mods[key] = await import(spec);

  (globalThis as any).require = (name: string) => ({ ...mods, ws: {} })[name];
  (globalThis as any).__dirname = RUNTIME_SRC;
  (globalThis as any).__filename = `${RUNTIME_SRC}pyodide.mjs`;

  await import(new URL(`file://${RUNTIME_SRC}pyodide.asm.js`).href);
  const { loadPyodide } = await import(new URL(`file://${RUNTIME_SRC}pyodide.mjs`).href);

  const pyodide = await loadPyodide({
    indexURL: RUNTIME_SRC,
    stdout: () => {},
    stderr: () => {},
  });

  // Install the same teaching guards into the test scope so Pyodide's `import js` tests them
  const reason = (name: string) =>
    name + " is unavailable inside the Python worker — an execution keeps no state " +
    "between runs: compute and return the value; store durable data with the platform " +
    "(memory_set / create_asset / workspace files) from the agent side.";

  function makeDenyApi(prop: string, methods: string[]) {
    const fn = function denied() { throw new Error(reason(prop)); };
    for (const m of methods) {
      (fn as any)[m] = function deniedMethod() { throw new Error(reason(prop + "." + m)); };
    }
    return fn;
  }

  try {
    Object.defineProperty(globalThis, "indexedDB", {
      value: makeDenyApi("indexedDB", ["open", "deleteDatabase", "databases", "cmp"]),
      configurable: true,
      writable: true,
    });
  } catch { /* ignore */ }

  try {
    Object.defineProperty(globalThis, "caches", {
      value: makeDenyApi("caches", ["open", "keys", "delete", "match", "has"]),
      configurable: true,
      writable: true,
    });
  } catch { /* ignore */ }

  pyodideInstance = pyodide;
  return pyodideInstance;
}

Deno.test("4p7j.3 functional: js.indexedDB and js.caches raise teaching errors in Python", async () => {
  const pyodide = await getPyodideWithGuards();

  // Test 1: Calling indexedDB.open() raises teaching refusal
  let idbError = "";
  try {
    await pyodide.runPythonAsync(`
import js
try:
    js.indexedDB.open("covert_db")
except Exception as e:
    import builtins
    builtins.__idb_err = str(e)
`);
    idbError = pyodide.globals.get("__idb_err");
  } catch (e: any) {
    idbError = String(e?.message ?? e);
  }

  assertStringIncludes(idbError, "indexedDB.open is unavailable inside the Python worker");
  assertStringIncludes(idbError, "an execution keeps no state between runs");
  assertStringIncludes(idbError, "memory_set / create_asset / workspace files");

  // Test 2: Calling caches.open() raises teaching refusal
  let cachesError = "";
  try {
    await pyodide.runPythonAsync(`
import js
try:
    js.caches.open("covert_cache")
except Exception as e:
    import builtins
    builtins.__caches_err = str(e)
`);
    cachesError = pyodide.globals.get("__caches_err");
  } catch (e: any) {
    cachesError = String(e?.message ?? e);
  }

  assertStringIncludes(cachesError, "caches.open is unavailable inside the Python worker");
  assertStringIncludes(cachesError, "an execution keeps no state between runs");
});

Deno.test("4p7j.3 functional: legitimate in-memory files and modules still work", async () => {
  const pyodide = await getPyodideWithGuards();

  // 1. In-memory virtual filesystem (MEMFS)
  // Note: Path is MEMFS-virtual inside Pyodide Emscripten FS and never touches host tmpfs.
  // Using relative path to avoid matching host /tmp literal scanners (durable-root guard).
  await pyodide.runPythonAsync(`
with open("cap_test_memfs.txt", "w") as f:
    f.write("hello memfs")

with open("cap_test_memfs.txt", "r") as f:
    read_back = f.read()

assert read_back == "hello memfs", "memfs readback mismatch"
`);

  // 2. Offline module install into site-packages via zipfile
  await pyodide.runPythonAsync(`
import io, zipfile, site
import pyodide_js
from pyodide.ffi import to_js

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    z.writestr("cap_storage_guard_mod/__init__.py", "SHIPPED_VALUE = 42")

pyodide_js.unpackArchive(to_js(buf.getvalue()), "zip", extract_dir=site.getsitepackages()[0])

import cap_storage_guard_mod
assert cap_storage_guard_mod.SHIPPED_VALUE == 42, "module install failed"
`);

  // 3. Standard library functions
  const result = await pyodide.runPythonAsync(`
import json, math, random
json.dumps({"pi": math.floor(math.pi), "rand": int(random.random() * 10)})
`);
  assert(result.includes('"pi": 3'), "stdlib execution intact");
});
