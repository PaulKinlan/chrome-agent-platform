// scripts/lib/emscripten-blake3-admission.mjs — admission package builder for
// blake3-wasm (connor4312 v3.0.0) as an Emscripten glue class managed tool
// (chrome-agent-platform-fh9k).
//
// Invariants enforced here:
//   - exact version + integrity pinned against the tracked evidence records;
//   - module declaration measured from the real wasm bytes via auditEmscriptenModule;
//   - re-validates through the real authority chain (validateEmscriptenManifest,
//     validateEmscriptenProvenance, auditEmscriptenGraph, assertEmscriptenBlake3Eligibility).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  WasmPackageAuthority,
  registerSchema2Surface,
} from "../../extension/lib/wasm-package-authority.js";
import {
  validateEmscriptenManifest,
  validateEmscriptenProvenance,
  assertEmscriptenNumericEligibility,
  assertEmscriptenBlake3Eligibility,
  emscriptenIdentity,
} from "../../extension/lib/emscripten-manifest.js";
import {
  auditEmscriptenGraph,
  auditEmscriptenModule,
} from "../../extension/lib/emscripten-module-audit.js";
import { sha256Hex } from "../../extension/lib/pure.js";
import { manifestCasMappings } from "./wasm-manifest-assets.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const enc = new TextEncoder();
const sha256Bytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const concatBytes = (a, b) => {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
};
const hash = (value) => sha256Hex(canonicalJson(value));

export const BLAKE3_ADMISSION_PINS = Object.freeze({
  evidenceCommit: "54234cd2a731ef84f3f0db658512e09ff7b4b3c4",
  upstreamRepo: "https://github.com/connor4312/blake3",
  upstreamCommit: "8605a2a2f30d1c430b9aa5b37c44ec2fef4e199d",
  packageId: "cap.managed.blake3",
  packageVersion: "3.0.0",
  packageName: "cap_managed_blake3",
  adapterId: "cap-blake3-wasm-v1",
  tarball: Object.freeze({
    url: "https://registry.npmjs.org/blake3-wasm/-/blake3-wasm-3.0.0.tgz",
    sha512: "X410nN2AIX6k8gHQmXruQ9YV3U8fe7ZrfLMp88qBcGx5oEIGzz305HvquXoSTPdaR74EA99KHBTb8El9q0vjqQ==",
    sha256: "83bad3dc00d9f4fcc97dab4ab1d32a87c32d1296a37db57c1b8e76a76514bd20",
    size: 43040,
  }),
  sourceDateEpoch: "1665293420",
  wasm: Object.freeze({
    sha256: "7bc38ed8b469117059b43ab04c70b2a5506ab313a9ae2926dd338f072dbd310d",
    size: 43943,
  }),
  glue: Object.freeze({
    sha256: "7d03777d994e39a8a619a8c9fe20c1bcb11710b114fc2f280022a2a103052878",
    size: 17819,
  }),
  adapter: Object.freeze({
    sha256: "69a3ecc777d9c7fe54e44b86e939933e860f29fe8bcd44dbddcfc16d9b5d44fc",
    size: 2914,
  }),
  cSource: Object.freeze({
    sha256: "dae08d775a999efceb8b9f1127d76efbba722aa2812be49ef24d6346f1530326",
    size: 1836,
  }),
  license: Object.freeze({
    rel: "extension/wasm/licenses/blake3-wasm-MIT.txt",
    sha256: "6ae51be712bd278ca37cd2204a6e836d71aacea5b7b8210d5a95c0e02a15dc35",
    size: 1068,
  }),
  extractSh: Object.freeze({
    name: "extract.mjs",
  }),
  sbomSerial: "urn:uuid:7bc38ed8-b469-4170-89b4-3ab04c70b2a5",
  sbomRel: "extension/wasm/sbom/cap.managed.blake3.cdx.json",
  sidecarRel: "extension/wasm/provenance/cap.managed.blake3-3.0.0.json",
});

const P = BLAKE3_ADMISSION_PINS;
const EVIDENCE_REL = "packages/bundled/evidence/blake3-wasm";

function fail(message) {
  const error = new Error(`emscripten-blake3-admission: ${message}`);
  error.code = "admission_fixture_invalid";
  throw error;
}

function pinned(rel, expected) {
  const bytes = readFileSync(join(REPO, rel));
  if (expected.sha512) {
    const actual512 = createHash("sha512").update(bytes).digest("base64");
    if (actual512 !== expected.sha512) {
      fail(`sha512 pin drift for ${rel} (expected ${expected.sha512}, got ${actual512})`);
    }
  }
  if (expected.sha256 && (sha256Bytes(bytes) !== expected.sha256 || bytes.byteLength !== expected.size)) {
    fail(`pin drift for ${rel} (expected ${expected.sha256}/${expected.size}B, got ${sha256Bytes(bytes)}/${bytes.byteLength}B)`);
  }
  return bytes;
}

/**
 * Build the complete blake3-wasm admission package: every file to ship
 * (repo-relative path + exact bytes) plus the inventory manifests row.
 */
export async function buildBlake3AdmissionPackage() {
  const evidence = (rel) => join(REPO, EVIDENCE_REL, rel);

  // ── Verify every asset byte against its pin ──────────────────────────────
  const adapterBytes = pinned(`${EVIDENCE_REL}/adapter/cap-blake3-wasm-v1.mjs`, P.adapter);
  const wasmBytes = pinned(`${EVIDENCE_REL}/binaries/blake3.wasm`, P.wasm);
  const glueBytes = pinned(`${EVIDENCE_REL}/glue/blake3.mjs`, P.glue);
  const wasmA = pinned(`${EVIDENCE_REL}/build-a/blake3.wasm`, P.wasm);
  const glueA = pinned(`${EVIDENCE_REL}/build-a/blake3.mjs`, P.glue);
  const wasmB = pinned(`${EVIDENCE_REL}/build-b/blake3.wasm`, P.wasm);
  const glueB = pinned(`${EVIDENCE_REL}/build-b/blake3.mjs`, P.glue);
  const cBytes = pinned(`${EVIDENCE_REL}/source/blake3.c`, P.cSource);
  const licenseBytes = pinned(`${EVIDENCE_REL}/LICENSES/MIT.txt`, P.license);
  const tarballBytes = pinned(`${EVIDENCE_REL}/blake3-wasm-3.0.0.tgz`, P.tarball);

  // ── Measure the real module (never hand-written) ─────────────────────────
  const scan = auditEmscriptenModule(wasmBytes);
  if (scan.imports.length !== 3 || scan.start !== null || scan.tags.length || scan.dylink !== null) {
    fail("measured module is outside the blake3 admission ABI");
  }
  if (
    scan.memories.length !== 1 || scan.memories[0].type.min !== 256 || scan.memories[0].type.max !== 256 ||
    scan.tables.length !== 1 || scan.tables[0].type.min !== 1 || scan.tables[0].type.max !== 1
  ) {
    fail("measured module does not match the blake3 resource profile");
  }

  // ── Paths ─────────────────────────────────────────────────────────────────
  const runtimeDir = `extension/wasm/runtime/${P.packageName}/${P.packageVersion}`;
  const adapterRel = `${runtimeDir}/adapter.mjs`;
  const glueRel = `${runtimeDir}/glue.mjs`;
  const casRel = `extension/wasm/cas/${P.wasm.sha256}.wasm`;
  const manifestRel = `extension/wasm/manifests/${P.packageId}-${P.packageVersion}.manifest.json`;

  const assets = [
    { id: "adapter", role: "adapter", path: adapterRel, sha256: P.adapter.sha256, size: P.adapter.size },
    { id: "glue", role: "glue", path: glueRel, sha256: P.glue.sha256, size: P.glue.size },
    { id: "main", role: "main-wasm", path: casRel, sha256: P.wasm.sha256, size: P.wasm.size },
  ];

  const operation = {
    id: "hash",
    toolId: "blake3_wasm",
    kind: "native-buffer-v1",
    exportName: "hash_oneshot",
    params: [{ name: "data", type: "string", minimum: 0, maximum: 4194304 }],
    result: "string",
    capabilities: ["compute", "crypto"],
    replayClass: "read-only",
    io: { kind: "none" },
  };

  const runtimeProfile = {
    kind: "emscripten-module-v1",
    abi: "emscripten-glue-v1",
    compiler: { version: "3.0.0", package: "blake3-wasm" },
    glue: { format: "es-module-factory", environment: "worker", dynamicExecution: false, filesystem: false },
    features: [...scan.features],
  };

  // ── Provenance sidecar (cap-emscripten-admission-provenance-v1) ──────────
  const comparisonDigestA = sha256Bytes(concatBytes(glueA, wasmA));
  const comparisonDigestB = sha256Bytes(concatBytes(glueB, wasmB));
  if (comparisonDigestA !== comparisonDigestB) {
    fail("comparison scope digest differs between builds A and B");
  }
  const comparisonPin = (name) => ({
    name,
    source: `${EVIDENCE_REL}/${name}`,
    revision: P.evidenceCommit,
    sha256: comparisonDigestA,
    size: glueA.byteLength + wasmA.byteLength,
  });

  const sidecar = {
    format: "cap-emscripten-admission-provenance-v1",
    toolchain: [{
      name: "blake3-wasm-tarball",
      source: P.tarball.url,
      revision: P.packageVersion,
      sha256: P.tarball.sha256,
      size: P.tarball.size,
    }],
    sources: [
      {
        name: "blake3.c",
        source: `${EVIDENCE_REL}/source/blake3.c`,
        revision: P.evidenceCommit,
        sha256: P.cSource.sha256,
        size: P.cSource.size,
      },
      {
        name: "cap-blake3-wasm-v1.mjs",
        source: `${EVIDENCE_REL}/adapter/cap-blake3-wasm-v1.mjs`,
        revision: `sha256:${P.adapter.sha256}`,
        sha256: P.adapter.sha256,
        size: P.adapter.size,
      },
    ],
    dependencies: [],
    patches: [],
    buildScript: {
      name: "extract.mjs",
      source: `${EVIDENCE_REL}/extract.mjs`,
      revision: P.evidenceCommit,
      sha256: sha256Bytes(readFileSync(join(REPO, `${EVIDENCE_REL}/extract.mjs`))),
      size: readFileSync(join(REPO, `${EVIDENCE_REL}/extract.mjs`)).byteLength,
    },
    argv: ["node", "extract.mjs"],
    environment: { SOURCE_DATE_EPOCH: P.sourceDateEpoch },
    outputAssets: assets.map((a) => a.id),
    comparison: {
      kind: "same-sdk-byte-identical",
      buildA: comparisonPin("build-a"),
      buildB: comparisonPin("build-b"),
      hermeticReprovisioned: false,
      assets: ["glue", "main"],
    },
  };
  const sidecarBytes = enc.encode(canonicalJson(sidecar));

  // ── SBOM (CycloneDX 1.5) ─────────────────────────────────────────────────
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: P.sbomSerial,
    version: 1,
    metadata: {
      component: {
        type: "library",
        "bom-ref": `${P.packageId}@${P.packageVersion}`,
        name: P.packageId,
        version: P.packageVersion,
        description: "Admitted blake3-wasm (connor4312 v3.0.0) as managed Wasm tool with Emscripten glue class.",
        licenses: [{ license: { id: "MIT" } }],
        properties: [
          { name: "cap:admitted", value: "true" },
          { name: "cap:executable", value: "true" },
          { name: "cap:evidence", value: EVIDENCE_REL },
        ],
      },
    },
    components: [
      {
        type: "file",
        "bom-ref": "binaries/blake3.wasm",
        name: "binaries/blake3.wasm",
        version: P.packageVersion,
        licenses: [{ license: { id: "MIT" } }],
        hashes: [{ alg: "SHA-256", content: P.wasm.sha256 }],
      },
      {
        type: "file",
        "bom-ref": "glue/blake3.mjs",
        name: "glue/blake3.mjs",
        version: P.packageVersion,
        licenses: [{ license: { id: "MIT" } }],
        hashes: [{ alg: "SHA-256", content: P.glue.sha256 }],
      },
      {
        type: "library",
        "bom-ref": "cap-blake3-wasm-v1.mjs",
        name: "cap-blake3-wasm-v1 adapter",
        version: "1.0.0",
        description: "CAP-authored adapter binding hash operation to hash_oneshot.",
        licenses: [{ license: { id: "MIT" } }],
        hashes: [{ alg: "SHA-256", content: P.adapter.sha256 }],
      },
    ],
  };
  const sbomBytes = enc.encode(JSON.stringify(sbom, null, 1) + "\n");

  // ── Manifest (modules measured from the real bytes) ───────────────────────
  const { features: _features, ...measured } = scan;
  // Map providers onto declared imports
  const declaredImports = measured.imports.map((imported) => {
    let binding = imported.symbol;
    if (imported.symbol === "a") binding = "a";
    else if (imported.symbol === "b") binding = "b";
    else if (imported.symbol === "c") binding = "c";
    return {
      ...imported,
      provider: { kind: "glue", asset: "glue", binding },
    };
  });

  const manifest = {
    schemaVersion: 2,
    package: { id: P.packageId, version: P.packageVersion, name: P.packageName, type: "tool-bundle" },
    tools: [{
      toolId: operation.toolId,
      digest: hash(operation),
      capabilityDigest: hash(operation.capabilities),
      replayClass: operation.replayClass,
      capabilities: operation.capabilities,
    }],
    signer: { lane: "bundled", keyId: "cap-bundled-release", alg: "none" },
    source: { repo: P.upstreamRepo, commit: P.upstreamCommit },
    build: {
      toolchain: "blake3-wasm@3.0.0 npm extraction",
      profile: "release",
      reproducible: false,
      rebuildRef: `${EVIDENCE_REL}/extract.mjs`,
    },
    sbom: { format: "cyclonedx-json@1.5", sha256: sha256Bytes(sbomBytes), ref: P.sbomRel },
    license: { spdx: "MIT", file: P.license.rel },
    meta: {
      category: "crypto",
      channel: "bundled",
      description: "blake3_wasm - compute cryptographic 256-bit BLAKE3 hash digests with connor4312 v3.0.0 Emscripten glue class.",
      label: "blake3_wasm",
      status: "managed-wasm-tool-admitted",
      note: `admitted managed tool; evidence: ${EVIDENCE_REL}`,
    },
    runtime: { ...runtimeProfile, profileDigest: hash(runtimeProfile) },
    assets,
    entry: {
      adapterId: P.adapterId,
      adapterAsset: "adapter",
      glueAsset: "glue",
      mainAsset: "main",
      operations: [operation],
    },
    modules: [{
      asset: "main",
      imports: declaredImports,
      exports: structuredClone(measured.exports),
      memories: structuredClone(measured.memories),
      tables: structuredClone(measured.tables),
      globals: structuredClone(measured.globals),
      tags: structuredClone(measured.tags),
      start: measured.start,
      dylink: measured.dylink,
    }],
    linkGraph: { policy: "none", main: "main", dependencies: [] },
    resources: {
      class: "em32-unshared-fixed-16",
      memory: { owner: "main", index: 0, initialPages: 256, maxPages: 256, growth: false },
      table: { owner: "main", index: 0, initialElements: 1, maxElements: 1, growth: false },
      threads: { mode: "none" },
      io: { filesystem: "none", network: false, clock: false, random: false },
      lifecycle: { freshInstance: true, startupMs: 10000, callMs: 30000, concurrentJobs: 1 },
    },
    provenance: {
      record: { path: P.sidecarRel, sha256: sha256Bytes(sidecarBytes), size: sidecarBytes.byteLength },
      comparison: "same-sdk-byte-identical",
      hermeticReprovisioned: false,
    },
  };

  const canonical = canonicalJson(manifest);
  registerSchema2Surface({
    validateManifest: validateEmscriptenManifest,
    validateProvenance: validateEmscriptenProvenance,
    assertNumericEligibility: assertEmscriptenNumericEligibility,
    assertBlake3Eligibility: assertEmscriptenBlake3Eligibility,
    identity: emscriptenIdentity,
    auditGraph: auditEmscriptenGraph,
    auditModule: auditEmscriptenModule,
  });

  const authority = new WasmPackageAuthority();
  const validated = authority.validateManifest(canonical);
  if (!validated.ok) {
    fail(`generated blake3 manifest failed validation: ${validated.error} ${validated.path ?? ""} ${validated.detail ?? ""}`);
  }

  // Re-audit with the FINAL declared values exactly as admission will.
  const fileMap = new Map([
    [adapterRel, adapterBytes instanceof Uint8Array ? adapterBytes : new Uint8Array(adapterBytes)],
    [glueRel, new Uint8Array(glueBytes)],
    [casRel, new Uint8Array(wasmBytes)],
  ]);
  validateEmscriptenProvenance(new TextDecoder().decode(sidecarBytes), validated.manifest);
  const graph = await auditEmscriptenGraph(
    { assets: validated.manifest.assets, modules: validated.manifest.modules, linkGraph: validated.manifest.linkGraph },
    fileMap,
  );
  assertEmscriptenBlake3Eligibility(validated.manifest, graph);

  const mappings = manifestCasMappings(validated.manifest);
  if (mappings.length !== 1 || mappings[0].casRel !== casRel || mappings[0].schemaVersion !== 2) {
    fail("schema-aware CAS mapping disagrees with the fixture address");
  }

  const manifestBytes = enc.encode(canonical);
  const manifestDigest = sha256Bytes(manifestBytes);
  const identity = emscriptenIdentity(validated.manifest);

  const files = [
    { rel: casRel, bytes: wasmBytes },
    { rel: glueRel, bytes: glueBytes },
    { rel: adapterRel, bytes: adapterBytes },
    { rel: P.sidecarRel, bytes: sidecarBytes },
    { rel: P.sbomRel, bytes: sbomBytes },
    { rel: P.license.rel, bytes: licenseBytes },
    { rel: manifestRel, bytes: manifestBytes },
  ];

  const inventoryManifestRow = {
    pkg: P.packageId,
    version: P.packageVersion,
    digest: manifestDigest,
  };

  return {
    manifest: validated.manifest,
    canonicalManifest: canonical,
    manifestDigest,
    identity,
    files,
    inventoryManifestRow,
    digests: {
      manifest: manifestDigest,
      main: P.wasm.sha256,
      glue: P.glue.sha256,
      adapter: P.adapter.sha256,
      sidecar: sha256Bytes(sidecarBytes),
      sbom: sha256Bytes(sbomBytes),
    },
  };
}
