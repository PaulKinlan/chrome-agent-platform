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
// scripts/select-tests.mjs. Static file reads and CAS binary hashes: no browser, no spawn, no build
// precondition (it skips extension/dist). Do not fold it back into the original file, and do not
// promote that file whole.
// @ts-nocheck
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { scanShippedJs } from "../scripts/scan-shipped.mjs";
import { collectProductSources, auditStaticFirst } from "./helpers/emscripten-static-first-audit.mjs";

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
  // Since 0.2.157 the bundled lane PHYSICALLY SHIPS the reviewed binaries
  // (inventory-only; still no route/execution) - the COUNT is deliberately not
  // written down: this test asserts the set is exactly the inventory's, so a
  // literal here only rots. The successor invariant: the
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

// wjrgk: reuse this already-always-on source guard rather than editing the
// selector's own machinery (which correctly turns a fast gate into a full one).
// The deliberately injected source is IN MEMORY, never left in the repo.
Deno.test("static-first: walked product JS cannot install a dynamic linker", async () => {
  const worker = "extension/lib/emscripten-worker.js";
  const sources = await collectProductSources(new URL("../", import.meta.url));
  assert(sources.size > 300, `source audit vacuous: ${sources.size} modules`);
  for (const anchor of [worker, "extension/lib/emscripten-run-broker.js", "extension/lib/wasm-package-authority.js"]) {
    assert(sources.has(anchor), `product source anchor absent: ${anchor}`);
  }
  assertEquals(auditStaticFirst(sources), []);
  const mutated = new Map(sources);
  mutated.set(worker, `${sources.get(worker)}\nModule["dynamicLibraries"] = []; loadDylibs();\n`);
  assert(auditStaticFirst(mutated).some((row) => row === `${worker}:dynamicLibraries`), "dynamic library knob must trip");
  assert(auditStaticFirst(mutated).some((row) => row === `${worker}:loadDylibs`), "dynamic linker call must trip");
  const hooks = new Map([[worker, 'Module["instantiateWasm"] = () => {}; Module.locateFile = () => {};']]);
  assertEquals(auditStaticFirst(hooks), [
    `${worker}:Module-hook`, `${worker}:Module-hook`, `${worker}:instantiateWasm`, `${worker}:locateFile`,
  ].sort(), "Module hooks cannot install an unreviewed byte source");
  assertEquals(auditStaticFirst(new Map([[worker, "// loadDylibs and dynamicLibraries remain unsupported\n"]])), [],
    "a negation comment is not an executable path");
});

// zeaub: walk a disposable tree, not only an in-memory Map. A vendor/cjs skip
// must turn this test RED even when the real source count remains above 300.
Deno.test("static-first: the walked JS file set matches the documented scope", async () => {
  const root = await Deno.makeTempDir({ prefix: "cap-static-first-walk-" });
  const allowed = [
    "extension/lib/entry.js", "extension/lib/vendor/third.mjs",
    "extension/lib/legacy.cjs", "packages/pkg/src/entry.js",
  ];
  const excluded = [
    "extension/dist/gen.js", "extension/lib/deep/dist/gen.js",
    "packages/pkg/deep/dist-versions/gen.js", "packages/pkg/dist-archives/gen.js",
    "packages/pkg/deep/node_modules/gen.js",
    "extension/.dist-stage-1/gen.js", "extension/.dist-link-1/gen.js",
    "extension/.dist-prev-1/gen.js", "packages/bundled/evidence/archive/gen.js",
    "extension/lib/other.ts", "extension/lib/other.tsx", "extension/lib/other.jsx",
  ];
  const put = async (relative: string, contents: string) => {
    const file = join(root, relative);
    await Deno.mkdir(dirname(file), { recursive: true });
    await Deno.writeTextFile(file, contents);
  };
  try {
    for (const path of allowed) await put(path, "export const safe = 1;");
    for (const path of excluded) await put(path, "Module.loadDylibs();");
    const sourceRoot = pathToFileURL(`${root}/`);
    const sources = await collectProductSources(sourceRoot);
    assertEquals([...sources.keys()].sort(), allowed.sort(), "every documented inclusion and exclusion must be witnessed");
    assertEquals(auditStaticFirst(sources), [], "excluded hostile code must not enter the audit");
    await Deno.symlink(join(root, allowed[0]), join(root, "packages/pkg/src/linked.js"));
    await assertRejects(
      () => collectProductSources(sourceRoot),
      Error,
      "unreviewed product source symlink",
      "a symlink outside the exclusions must fail closed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// The per-tool SBOM identity was unpinned (chrome-agent-platform-10z9): the manifests are what a
// licence disclosure reads, and nothing asserted that a hash-wasm package's CycloneDX identity names
// the hash-wasm component for THAT algorithm rather than a generic or shared one. A shared serial or
// a wrong component name would make two reviewed binaries indistinguishable in a notice file, and no
// gate would say so. This reads the tracked manifests and the CDX files they pin as data.
Deno.test("wasm-package-authority-static: every hash-wasm manifest pins its own SBOM component name and serial", async () => {
  const dir = new URL("../extension/wasm/manifests/", import.meta.url);
  const rows: { id: string; algo: string; ref: string; name: string; serial: string }[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.startsWith("cap.bundled.hash.") || !entry.name.endsWith(".manifest.json")) continue;
    const manifest = JSON.parse(await Deno.readTextFile(new URL(entry.name, dir)));
    const id = String(manifest?.package?.id ?? "");
    const sbom = manifest?.sbom ?? {};
    assert(typeof sbom.ref === "string" && typeof sbom.sha256 === "string", `${entry.name}: the manifest pins an sbom ref and digest`);
    const cdxBytes = await Deno.readFile(new URL(`../${sbom.ref}`, import.meta.url));
    assertEquals(
      hex(new Uint8Array(await crypto.subtle.digest("SHA-256", cdxBytes))),
      sbom.sha256,
      `${entry.name}: the pinned digest is the referenced CDX's bytes`,
    );
    const cdx = JSON.parse(new TextDecoder().decode(cdxBytes));
    rows.push({
      id,
      // hash-wasm's module names spell `sha3.256` as `sha3_256`, and the CDX file name and its
      // component name agree on that spelling (verified across all fourteen at filing time), so the
      // id is normalised rather than compared literally - the tree, not a guess, decides the form.
      algo: id.replace("cap.bundled.hash.", "").replace(/[.-]/g, "_"),
      ref: sbom.ref,
      name: String(cdx?.metadata?.component?.name ?? ""),
      serial: String(cdx?.serialNumber ?? ""),
    });
  }
  assert(rows.length >= 14, `the reviewed hash-wasm family is present (found ${rows.length})`);
  for (const row of rows) {
    assertEquals(row.name, `hashwasm-${row.algo}`, `${row.id}: the SBOM component names this algorithm's hash-wasm package, not a generic one`);
    assertEquals(row.ref, `extension/wasm/sbom/hash_${row.algo}.cdx.json`, `${row.id}: the manifest pins ITS OWN tool's CDX, not a sibling's`);
    assert(/^urn:uuid:[0-9a-f-]{36}$/.test(row.serial), `${row.id}: serialNumber is a URN uuid (got ${JSON.stringify(row.serial)})`);
  }
  assertEquals(new Set(rows.map((r) => r.serial)).size, rows.length, "each reviewed binary carries its own SBOM serial");
  assertEquals(new Set(rows.map((r) => r.ref)).size, rows.length, "each manifest pins its own CDX file");
});
