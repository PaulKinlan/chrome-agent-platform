// tests/emscripten-blake3-admission.test.ts — admission test for blake3-wasm
// (connor4312 v3.0.0) as a managed Wasm tool with Emscripten glue class
// (chrome-agent-platform-fh9k).
// @ts-nocheck — browser stubs and dynamic envelopes are intentionally dynamic.
//
// Verifies:
//   - Deterministic pins: exact content-addressed digests for manifest, graph,
//     and assets.
//   - Re-validation through the real schema-2 authority chain.
//   - Hostile falsification: tampered asset byte and sidecar text are refused.
//   - Full authority admission: admitBundled executes the real admission chain
//     and commits the schema-2 record.
//   - Full broker and host integration: envelope generation, argument validation,
//     input schema generation, catalog exposure, and request validation.
//   - Live adapter execution: known-answer test vectors ("abc", empty input).
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import {
  buildBlake3AdmissionPackage,
  BLAKE3_ADMISSION_PINS,
} from "../scripts/lib/emscripten-blake3-admission.mjs";
import {
  validateEmscriptenManifest,
  validateEmscriptenProvenance,
  assertEmscriptenBlake3Eligibility,
  emscriptenIdentity,
} from "../extension/lib/emscripten-manifest.js";
import {
  auditEmscriptenGraph,
  auditEmscriptenModule,
} from "../extension/lib/emscripten-module-audit.js";
import {
  EMSCRIPTEN_ADAPTER_CONTRACTS,
  adapterContractFor,
} from "../extension/lib/emscripten-adapter-registry.js";
import {
  buildEmscriptenRunEnvelope,
  emscriptenCatalogRows,
  executableEmscriptenToolRecords,
  validateEmscriptenOperationArgs,
} from "../extension/lib/emscripten-run-broker.js";
import {
  EMSCRIPTEN_RUN_TYPE,
  executeEmscriptenRunRequest,
} from "../extension/lib/emscripten-host.js";
import {
  WasmPackageAuthority,
  registerSchema2Surface,
} from "../extension/lib/wasm-package-authority.js";
import { buildPreviewAuthority } from "../extension/lib/tool-exec-preview.js";
import { createBlake3Adapter } from "../packages/bundled/evidence/blake3-wasm/adapter/cap-blake3-wasm-v1.mjs";

// Static import graph edges for select-tests tracking:
// import("../extension/lib/emscripten-worker.js")
// import("../extension/about/about.html")
// import("../packages/bundled/evidence/blake3-wasm/extract.mjs")
// import("../packages/bundled/evidence/blake3-wasm/glue/blake3.mjs")
// import("../packages/bundled/evidence/blake3-wasm/binaries/blake3.wasm")
// import("../packages/bundled/evidence/blake3-wasm/build-a/blake3.wasm")
// import("../packages/bundled/evidence/blake3-wasm/build-a/blake3.mjs")
// import("../packages/bundled/evidence/blake3-wasm/build-b/blake3.wasm")
// import("../packages/bundled/evidence/blake3-wasm/build-b/blake3.mjs")
// import("../packages/bundled/evidence/blake3-wasm/blake3-wasm-3.0.0.tgz")
// import("../packages/bundled/evidence/blake3-wasm/LICENSES/MIT.txt")
// import("../packages/bundled/evidence/blake3-wasm/sbom/cyclonedx-1.5.json")
// import("../packages/bundled/evidence/blake3-wasm/source/blake3.c")

class FakeStore {
  constructor() {
    this.rows = new Map();
    this.version = 0;
  }
  async getStrict(key) { return this.rows.has(key) ? structuredClone(this.rows.get(key).value) : null; }
  async getVersion(key) { return this.rows.get(key)?.version ?? 0; }
  async setTrusted(key, value) {
    const token = ++this.version;
    this.rows.set(key, { value: structuredClone(value), version: token });
    return token;
  }
  async compareAndRestore(key, expectedVersion, value) {
    if ((this.rows.get(key)?.version ?? 0) !== expectedVersion) return false;
    const token = ++this.version;
    this.rows.set(key, { value: structuredClone(value), version: token });
    return true;
  }
}

async function shaHexBytes(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("blake3 admission: adapter registry contract", () => {
  const contract = adapterContractFor("cap-blake3-wasm-v1");
  assertEquals(contract, {
    factoryExport: "createBlake3Adapter",
    operations: {
      hash: "hash",
    },
  });
  assertEquals(EMSCRIPTEN_ADAPTER_CONTRACTS["cap-blake3-wasm-v1"], contract);
});

Deno.test("blake3 admission: emitted digests match the reviewed deterministic pins", async () => {
  const out = await buildBlake3AdmissionPackage();

  // Manifest and graph identity
  assertEquals(out.manifestDigest, "fecab10d5df322397812c0395df0a5ab35a5713a734f542eb539e2ed8163352f");
  assertEquals(out.identity.graphDigest, "529b2bd1bda57c6fc78b4af0c17ea32d7f9fbac639afea1e57f4af674dfbf45f");
  assertEquals(out.identity.operationDigests.length, 1);
  assertEquals(out.identity.operationDigests[0].id, "hash");

  // Asset digests
  assertEquals(out.digests.main, BLAKE3_ADMISSION_PINS.wasm.sha256);
  assertEquals(out.digests.glue, BLAKE3_ADMISSION_PINS.glue.sha256);
  assertEquals(out.digests.adapter, BLAKE3_ADMISSION_PINS.adapter.sha256);

  // Inventory row
  assertEquals(out.inventoryManifestRow, {
    pkg: "cap.managed.blake3",
    version: "3.0.0",
    digest: out.manifestDigest,
  });

  // Exactly seven emitted assets (including license text)
  const rels = out.files.map((f) => f.rel).sort();
  assertEquals(rels, [
    "extension/wasm/cas/7bc38ed8b469117059b43ab04c70b2a5506ab313a9ae2926dd338f072dbd310d.wasm",
    "extension/wasm/licenses/blake3-wasm-MIT.txt",
    "extension/wasm/manifests/cap.managed.blake3-3.0.0.manifest.json",
    "extension/wasm/provenance/cap.managed.blake3-3.0.0.json",
    "extension/wasm/runtime/cap_managed_blake3/3.0.0/adapter.mjs",
    "extension/wasm/runtime/cap_managed_blake3/3.0.0/glue.mjs",
    "extension/wasm/sbom/cap.managed.blake3.cdx.json",
  ]);
});

Deno.test("blake3 admission: manifest re-validates through the real schema-2 chain", async () => {
  const out = await buildBlake3AdmissionPackage();
  const manifest = out.manifest;

  // 1. Structural schema-2 manifest validation
  validateEmscriptenManifest(manifest);

  // 2. Provenance sidecar validation
  const sidecarFile = out.files.find((f) => f.rel === BLAKE3_ADMISSION_PINS.sidecarRel);
  assert(sidecarFile, "sidecar must be present");
  const sidecar = validateEmscriptenProvenance(new TextDecoder().decode(sidecarFile!.bytes), manifest);
  assertEquals(sidecar.comparison.assets, ["glue", "main"]);
  assertEquals(sidecar.comparison.kind, "same-sdk-byte-identical");
  assertEquals(sidecar.environment, { SOURCE_DATE_EPOCH: BLAKE3_ADMISSION_PINS.sourceDateEpoch });
  assertEquals(sidecar.comparison.buildA.sha256, sidecar.comparison.buildB.sha256);

  // 3. Graph audit over the exact emitted bytes + blake3 eligibility
  const fileMap = new Map(
    out.files
      .filter((f) => manifest.assets.some((a: { path: string }) => a.path === f.rel))
      .map((f) => [f.rel, f.bytes]),
  );
  assertEquals(fileMap.size, 3);
  const graph = await auditEmscriptenGraph(
    { assets: manifest.assets, modules: manifest.modules, linkGraph: manifest.linkGraph },
    fileMap,
  );
  assertEmscriptenBlake3Eligibility(manifest, graph);

  // 4. Measured module structure matches real Wasm bytes
  const wasmFile = out.files.find((f) => f.rel.startsWith("extension/wasm/cas/"));
  const rescan = auditEmscriptenModule(wasmFile!.bytes);
  assertEquals(rescan.imports.length, 3);
  assertEquals(rescan.memories, [{ index: 0, type: { address: "i32", shared: false, min: 256, max: 256 } }]);
  assertEquals(rescan.tables, [{ index: 0, type: { element: "funcref", min: 1, max: 1 } }]);
});

Deno.test("blake3 admission hostile: one mutated asset byte is refused", async () => {
  const out = await buildBlake3AdmissionPackage();
  const manifest = out.manifest;
  const fileMap = new Map(
    out.files
      .filter((f) => manifest.assets.some((a: { path: string }) => a.path === f.rel))
      .map((f) => [f.rel, f.bytes.slice()]),
  );
  const casRel = [...fileMap.keys()].find((k) => k.startsWith("extension/wasm/cas/"))!;
  const mainBytes = fileMap.get(casRel)!;
  mainBytes[mainBytes.byteLength - 10] ^= 0xff;

  let caught: unknown = null;
  try {
    await auditEmscriptenGraph(
      { assets: manifest.assets, modules: manifest.modules, linkGraph: manifest.linkGraph },
      fileMap,
    );
  } catch (error) {
    caught = error;
  }
  assert(caught, "mutated main asset must be refused");
  assertEquals((caught as { code?: string }).code, "asset_digest_mismatch");
});

Deno.test("blake3 admission hostile: mutated sidecar text is refused", async () => {
  const out = await buildBlake3AdmissionPackage();
  const sidecarFile = out.files.find((f) => f.rel === BLAKE3_ADMISSION_PINS.sidecarRel)!;
  const tampered = new TextDecoder().decode(sidecarFile.bytes).replace(
    '"cap-emscripten-admission-provenance-v1"',
    '"cap-emscripten-admission-provenance-v2"',
  );
  let caught: unknown = null;
  try {
    validateEmscriptenProvenance(tampered, out.manifest);
  } catch (error) {
    caught = error;
  }
  assert(caught, "tampered sidecar must be refused");
});

Deno.test("blake3 admission: full authority admission, catalog rows, and run envelope", async () => {
  const out = await buildBlake3AdmissionPackage();

  // 1. Setup real authority with complete inventory including blake3 and license file
  registerSchema2Surface({
    validateManifest: validateEmscriptenManifest,
    validateProvenance: validateEmscriptenProvenance,
    assertNumericEligibility: () => {},
    assertBlake3Eligibility: assertEmscriptenBlake3Eligibility,
    identity: emscriptenIdentity,
    auditGraph: auditEmscriptenGraph,
    auditModule: auditEmscriptenModule,
  });

  const filesMap = new Map<string, Uint8Array>();
  for (const f of out.files) {
    filesMap.set(f.rel, f.bytes);
  }

  const inventoryFiles = await Promise.all(
    out.files.map(async (f) => ({
      rel: f.rel,
      sha256: await shaHexBytes(f.bytes),
      size: f.bytes.byteLength,
    })),
  );

  const inventory = {
    schemaVersion: 1,
    release: "0.3.616",
    signer: { lane: "bundled", keyId: "cap-bundled-release" },
    manifests: [out.inventoryManifestRow],
    files: inventoryFiles,
    evidence: [],
    revocations: [],
    listFiles: async () => out.files.map((f) => f.rel),
    readFile: async (rel: string) => filesMap.get(rel),
  };

  const store = new FakeStore();
  const authority = new WasmPackageAuthority({ getStore: () => store, inventory, now: () => 1000 });

  // Real admitBundled call
  const admissionResult = await authority.admitBundled({
    manifest: out.canonicalManifest,
    files: out.files,
  });
  assertEquals(admissionResult.ok, true);
  assertEquals(admissionResult.record.packageId, "cap.managed.blake3");
  assertEquals(admissionResult.record.current.manifestDigest, out.manifestDigest);
  assertEquals(admissionResult.record.current.graphDigest, out.identity.graphDigest);

  const admittedRecord = {
    schema2: true,
    packageId: out.manifest.package.id,
    version: out.manifest.package.version,
    graphDigest: out.identity.graphDigest,
    manifestDigest: out.manifestDigest,
    manifest: out.manifest,
    state: "admitted",
  };

  // 2. Broker catalog exposure and inputSchema verification
  const rows = emscriptenCatalogRows([admittedRecord]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].packageId, "cap.managed.blake3");
  assertEquals(rows[0].version, "3.0.0");
  assertEquals(rows[0].operationId, "hash");
  assertEquals(rows[0].toolId, "blake3_wasm");

  const tools = executableEmscriptenToolRecords([admittedRecord]);
  assertEquals(tools.length, 1);
  assertEquals(tools[0].descriptorInput.inputSchema.type, "object");
  assertEquals(tools[0].descriptorInput.inputSchema.properties.data.type, "string");
  assertEquals(tools[0].descriptorInput.inputSchema.properties.data.maxLength, 4194304);

  // 3. Broker argument validation
  const validArgs = validateEmscriptenOperationArgs(rows[0], { data: "hello world" });
  assertEquals(validArgs.ok, true);
  if (validArgs.ok && validArgs.data) {
    assertEquals(validArgs.data.args, ["hello world"]);
  }

  const invalidArgs = validateEmscriptenOperationArgs(rows[0], { data: 12345 });
  assertEquals(invalidArgs.ok, false);

  // Multibyte regression assertion: char count <= 4,194,304 but UTF-8 bytes > 4,194,304
  // 1,048,577 emoji characters (each 4 UTF-8 bytes, 2 UTF-16 code units) = 2,097,154 chars, but 4,194,308 bytes!
  const multibyteOversize = "🔑".repeat(1048577);
  assertEquals(multibyteOversize.length < 4194304, true);
  const multibyteResult = validateEmscriptenOperationArgs(rows[0], { data: multibyteOversize });
  assertEquals(multibyteResult.ok, false);
  assert(multibyteResult.error?.includes("UTF-8 byte length outside"));

  // Exact-byte-bound acceptance: exactly 4,194,304 ASCII bytes
  const exactBound = "a".repeat(4194304);
  const exactResult = validateEmscriptenOperationArgs(rows[0], { data: exactBound });
  assertEquals(exactResult.ok, true);

  const testAuthority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "host-kat", now: () => 1 });

  // 4. Broker envelope creation
  const envelope = buildEmscriptenRunEnvelope({
    record: admittedRecord,
    operationId: "hash",
    args: ["hello world"],
    authority: testAuthority,
  });

  assert(envelope !== null, "envelope must not be null");
  assertEquals(envelope.type, "cap:emscripten-run");
  assertEquals(envelope.packageId, "cap.managed.blake3");
  assertEquals(envelope.operationId, "hash");
  assertEquals(envelope.operation.exportName, "hash_oneshot");
  assertEquals(envelope.operation.result, "string");
  assertEquals(envelope.args, ["hello world"]);
  assertEquals(envelope.assets.length, 3);

  // 5. Host execution integration: executeEmscriptenRunRequest with synthetic worker
  const realChrome = globalThis.chrome;
  const realFetch = globalThis.fetch;
  const realWorker = globalThis.Worker;

  const bytesByPath: Record<string, Uint8Array> = {};
  for (const asset of envelope.assets) {
    const file = out.files.find((f) => f.rel.endsWith(asset.path));
    assert(file, `asset file must exist: ${asset.path}`);
    bytesByPath[asset.path] = file.bytes;
  }

  try {
    globalThis.chrome = {
      runtime: {
        id: "cap-test",
        getURL(path: string) { return `chrome-extension://cap-test/${path}`; },
        getManifest() { return { background: { service_worker: "dist/background/service-worker.js" } }; },
      },
    };

    globalThis.fetch = async (url: string | URL) => {
      const path = String(url).replace("chrome-extension://cap-test/", "");
      const bytes = bytesByPath[path];
      if (!bytes) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return {
        ok: true,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    };

    let workerPostedMessage: unknown = null;
    class MockWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: { message: string }) => void) | null = null;
      postMessage(msg: unknown) {
        workerPostedMessage = msg;
        setTimeout(() => {
          this.onmessage?.({
            data: {
              type: "cap:emscripten-run-result",
              sessionId: envelope.authority.sessionId,
              packageId: envelope.packageId,
              operationId: envelope.operationId,
              workerInstanceId: "worker-inst-01",
              phase: "completed",
              ok: true,
              result: "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
              error: null,
            },
          });
        }, 5);
      }
      terminate() {}
    }
    globalThis.Worker = MockWorker;

    const hostResult = await executeEmscriptenRunRequest(envelope);
    assertEquals(hostResult.ok, true);
    assertEquals(hostResult.phase, "completed");
    assertEquals(hostResult.result, "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85");
    assert(workerPostedMessage !== null);
  } finally {
    globalThis.chrome = realChrome;
    globalThis.fetch = realFetch;
    globalThis.Worker = realWorker;
  }
});

Deno.test("blake3 admission execution: real execution of adapter with KAT vectors", async () => {
  const out = await buildBlake3AdmissionPackage();
  const wasmFile = out.files.find((f) => f.rel.startsWith("extension/wasm/cas/"))!;

  let memory: WebAssembly.Memory;
  const importObject = {
    a: {
      a: (_req: number) => 0,
      b: (dest: number, src: number, num: number) => {
        const u8 = new Uint8Array(memory.buffer);
        u8.copyWithin(dest, src, src + num);
      },
      c: (_cond: number, _file: number, _line: number, _fn: number) => {
        throw new Error("assert fail");
      },
    },
  };

  const wasmModule = new WebAssembly.Module(wasmFile.bytes);
  const instance = new WebAssembly.Instance(wasmModule, importObject);
  memory = instance.exports.d as WebAssembly.Memory;
  (instance.exports.e as () => void)(); // ctors

  const adapter = createBlake3Adapter(instance as unknown as { exports: Record<string, unknown> });

  // Known BLAKE3 test vectors:
  // 1. "abc"
  assertEquals(
    adapter.hash("abc"),
    "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
  );

  // 2. Empty input ""
  assertEquals(
    adapter.hash(""),
    "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
  );

  // 3. Uint8Array input
  const u8Input = new TextEncoder().encode("abc");
  assertEquals(
    adapter.hash(u8Input),
    "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
  );

  // 4. Invalid input rejected
  assertThrows(() => adapter.hash(123 as unknown as string), TypeError);
});
