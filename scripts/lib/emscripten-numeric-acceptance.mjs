// scripts/lib/emscripten-numeric-acceptance.mjs — the build-time-only ltkj.2
// acceptance fixture builder (chrome-agent-platform-ltkj.2).
//
// Selects ONLY the tracked, source-reviewed A0 numeric fixture metadata/pins
// (packages/bundled/evidence/emscripten-abi: provenance.json,
// artifact-report.json, build-a/build-b byte-identical outputs, numeric.c,
// build.sh, and the newly authored cap-a0-numeric-v1 adapter source) and emits
// the real schema-2 manifest + assets for the generated BUNDLED_INVENTORY.
//
// Invariants enforced here, fail closed:
//   - every byte and every recorded pin is re-verified against the tracked
//     evidence records before anything is emitted (record drift = refusal);
//   - the module declaration is MEASURED from the real wasm bytes via
//     auditEmscriptenModule (truthful by construction, never hand-written);
//   - the final manifest re-validates through the REAL authority
//     (validateManifest + validateProvenance + auditEmscriptenGraph +
//     assertNumericEligibility) exactly as admission will;
//   - NO executable catalog row is produced: this package is validation-only
//     and must never appear in the default/release inventory (the generator
//     only calls this builder under the explicit acceptance flag).
//
// Runs under Node (generator/build) and Deno (committed fixture tests).

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
// Runtime-agnostic concat (Node Buffer and Deno Uint8Array both accepted).
const concatBytes = (a, b) => {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
};
const hash = (value) => sha256Hex(canonicalJson(value));

// ── Reviewed pins (sourced ONLY from tracked ltkj.1 evidence records) ───────
// Evidence landed with chrome-agent-platform-ltkj.1 @ 245cfdbb; every value
// below is cross-checked against provenance.json / artifact-report.json at
// build time, so a stale pin here fails closed instead of emitting drift.
export const NUMERIC_ACCEPTANCE_PINS = Object.freeze({
  evidenceCommit: "245cfdbbe9269f3ef7f60ed0a79465ac6f9d01e5",
  packageId: "cap.acceptance.a0.numeric",
  packageVersion: "1.0.0",
  packageName: "cap_acceptance_a0_numeric",
  adapterId: "cap-a0-numeric-v1",
  emsdkCommit: "d223ae73c6998296e3ab27cf81dc2c2c9fd383de",
  emscriptenCommit: "afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3",
  toolchainArchive: Object.freeze({
    url: "https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/772bb4648be4a897ca062d6adc65bc70223d2703/wasm-binaries.tar.xz",
    sha256: "b5ed0963521f1d35b8967f20b1776327980bcfd5133166b40e018f27f2380e89",
    size: 269920796,
  }),
  sourceDateEpoch: "1788566400",
  numericC: Object.freeze({ sha256: "b6c082e792370685e4ece7cc96e4a8d19b0cb571ded54ffe5259899dd6f46617", size: 159 }),
  buildSh: Object.freeze({ sha256: "1e81cfc0c5708e75c2f9a0d352982a2da6d6dec5ce4324371c43fad139d75f73", size: 2522 }),
  glue: Object.freeze({ sha256: "921175ec0ad89d8af17dbdffc49e58033c8717a246fe80b458f32e4a5a8584a9", size: 6155 }),
  main: Object.freeze({ sha256: "fea83472b7e56292785f132d0c5f564048cf34ae047627334f504b28dd405503", size: 278 }),
  // Newly authored adapter (this branch); content-addressed revision pin.
  adapter: Object.freeze({ sha256: "5f1ba5509267b0d7234fe508a10967be84451131d359f1eb1ab1b7e18dfe6a6b", size: 1751 }),
  argv: Object.freeze([
    "emcc", "source/numeric.c",
    "-O2", "--no-entry",
    "-sMODULARIZE=1", "-sEXPORT_ES6=1", "-sENVIRONMENT=worker",
    "-sDYNAMIC_EXECUTION=0", "-sFILESYSTEM=0",
    "-sALLOW_MEMORY_GROWTH=0", "-sINITIAL_MEMORY=16777216",
    "-sEXPORTED_FUNCTIONS=[\"_cap_weighted_sum\"]",
    "-o", "build-a/numeric.mjs",
  ]),
  sbomSerial: "urn:uuid:9b6f5eec-9f3f-5b03-8044-8a0b0f506551",
  sbomRel: "extension/wasm/sbom/cap.acceptance.a0.numeric.cdx.json",
  sidecarRel: "extension/wasm/provenance/cap.acceptance.a0.numeric-1.0.0.json",
});

const P = NUMERIC_ACCEPTANCE_PINS;
const EVIDENCE_REL = "packages/bundled/evidence/emscripten-abi";

function fail(message) {
  const error = new Error(`emscripten-numeric-acceptance: ${message}`);
  error.code = "acceptance_fixture_invalid";
  throw error;
}

function pinned(rel, expected) {
  const bytes = readFileSync(join(REPO, rel));
  if (sha256Bytes(bytes) !== expected.sha256 || bytes.byteLength !== expected.size) {
    fail(`pin drift for ${rel} (expected ${expected.sha256}/${expected.size}B)`);
  }
  return bytes;
}

/**
 * Build the complete acceptance fixture: every file to ship (repo-relative
 * path + exact bytes) plus the inventory manifests row. Deterministic given
 * the pinned evidence; refuses on any drift or eligibility failure.
 */
export async function buildNumericAcceptancePackage() {
  const evidence = (rel) => join(REPO, EVIDENCE_REL, rel);

  // ── Cross-check the pins against the tracked evidence records ────────────
  const provenanceRecord = JSON.parse(readFileSync(evidence("provenance.json"), "utf8"));
  if (provenanceRecord.format !== "cap-emscripten-abi-provenance-v1") fail("provenance record format drift");
  const emsdk = provenanceRecord.toolchain?.emsdk;
  if (
    emsdk?.version !== "6.0.0" ||
    emsdk?.managerCommit !== P.emsdkCommit ||
    emsdk?.emscriptenCommit !== P.emscriptenCommit ||
    emsdk?.archives?.[0]?.url !== P.toolchainArchive.url ||
    emsdk?.archives?.[0]?.sha256 !== P.toolchainArchive.sha256 ||
    emsdk?.archives?.[0]?.bytes !== P.toolchainArchive.size
  ) fail("toolchain record drift");
  if (String(provenanceRecord.build?.sourceDateEpoch) !== P.sourceDateEpoch) fail("SOURCE_DATE_EPOCH record drift");
  const numericSourceRecord = (provenanceRecord.sources ?? []).find((s) => s.path === "source/numeric.c");
  if (numericSourceRecord?.sha256 !== P.numericC.sha256) fail("numeric.c record drift");

  const artifactReport = JSON.parse(readFileSync(evidence("artifact-report.json"), "utf8"));
  if (artifactReport.reproducibility?.byteIdentical !== true) fail("evidence is not byte-identical across builds");
  const reported = (build, file) => (artifactReport.builds?.[build] ?? []).find((f) => f.file === file);
  for (const build of ["build-a", "build-b"]) {
    const glueRecord = reported(build, "numeric.mjs");
    const mainRecord = reported(build, "numeric.wasm");
    if (glueRecord?.sha256 !== P.glue.sha256 || glueRecord?.bytes !== P.glue.size) fail(`${build} glue record drift`);
    if (mainRecord?.sha256 !== P.main.sha256 || mainRecord?.bytes !== P.main.size) fail(`${build} main record drift`);
    if (glueRecord?.javascript?.evalCalls !== 0 || glueRecord?.javascript?.functionConstructors !== 0) {
      fail(`${build} glue is not dynamic-execution-free`);
    }
  }

  // ── Verify every emitted byte against its pin ────────────────────────────
  const adapterBytes = pinned(`${EVIDENCE_REL}/adapter/cap-a0-numeric-v1.mjs`, P.adapter);
  const numericCBytes = pinned(`${EVIDENCE_REL}/source/numeric.c`, P.numericC);
  const buildShBytes = pinned(`${EVIDENCE_REL}/build.sh`, P.buildSh);
  const glueA = pinned(`${EVIDENCE_REL}/build-a/numeric.mjs`, P.glue);
  const mainA = pinned(`${EVIDENCE_REL}/build-a/numeric.wasm`, P.main);
  const glueB = pinned(`${EVIDENCE_REL}/build-b/numeric.mjs`, P.glue);
  const mainB = pinned(`${EVIDENCE_REL}/build-b/numeric.wasm`, P.main);
  if (sha256Bytes(glueA) !== sha256Bytes(glueB) || sha256Bytes(mainA) !== sha256Bytes(mainB)) {
    fail("build-a/build-b comparison bytes are not identical");
  }

  // ── Measure the real module (never hand-written) ─────────────────────────
  const scan = auditEmscriptenModule(mainA);
  if (scan.imports.length || scan.features.length || scan.dylink !== null || scan.start !== null || scan.tags.length) {
    fail("measured module is outside the numeric eligibility ABI");
  }
  if (
    scan.memories.length !== 1 || scan.memories[0].type.min !== 256 || scan.memories[0].type.max !== 256 ||
    scan.tables.length !== 1 || scan.tables[0].type.min !== 1 || scan.tables[0].type.max !== 1 ||
    !scan.exports.some((e) => e.name === "cap_weighted_sum" && e.kind === "function")
  ) fail("measured module does not match the numeric resource profile");

  // ── Paths (single schema-aware mapping helper owns the CAS address) ──────
  const runtimeDir = `extension/wasm/runtime/${P.packageName}/${P.packageVersion}`;
  const adapterRel = `${runtimeDir}/adapter.mjs`;
  const glueRel = `${runtimeDir}/glue.mjs`;
  const casRel = `extension/wasm/cas/${P.main.sha256}.wasm`;
  const manifestRel = `extension/wasm/manifests/${P.packageId}-${P.packageVersion}.manifest.json`;

  const assets = [
    { id: "adapter", role: "adapter", path: adapterRel, sha256: P.adapter.sha256, size: P.adapter.size },
    { id: "glue", role: "glue", path: glueRel, sha256: P.glue.sha256, size: P.glue.size },
    { id: "main", role: "main-wasm", path: casRel, sha256: P.main.sha256, size: P.main.size },
  ];

  const operation = {
    id: "weighted_sum",
    toolId: "a0_numeric_weighted_sum",
    kind: "native-scalar-v1",
    exportName: "cap_weighted_sum",
    params: ["value", "weight", "bias"].map((name) => ({ name, type: "f64", minimum: -1000000, maximum: 1000000 })),
    result: "f64",
    capabilities: ["compute"],
    replayClass: "read-only",
    io: { kind: "none" },
  };

  const runtimeProfile = {
    kind: "emscripten-module-v1",
    abi: "emscripten-6.0.0-thin-native-v1",
    compiler: { version: "6.0.0", emsdkCommit: P.emsdkCommit, emscriptenCommit: P.emscriptenCommit },
    glue: { format: "es-module-factory", environment: "worker", dynamicExecution: false, filesystem: false },
    features: [...scan.features],
  };

  // ── Provenance sidecar (cap-emscripten-admission-provenance-v1) ──────────
  const comparisonDigest = sha256Bytes(concatBytes(glueA, mainA));
  const comparisonDigestB = sha256Bytes(concatBytes(glueB, mainB));
  if (comparisonDigest !== comparisonDigestB) fail("comparison scope digest differs between builds");
  const comparisonPin = (name) => ({
    name,
    source: `${EVIDENCE_REL}/${name}`,
    revision: P.evidenceCommit,
    sha256: comparisonDigest,
    size: glueA.byteLength + mainA.byteLength,
  });
  const sidecar = {
    format: "cap-emscripten-admission-provenance-v1",
    toolchain: [{
      name: "emscripten",
      source: P.toolchainArchive.url,
      revision: P.emscriptenCommit,
      sha256: P.toolchainArchive.sha256,
      size: P.toolchainArchive.size,
    }],
    sources: [
      {
        name: "cap-a0-numeric-v1.mjs",
        source: `${EVIDENCE_REL}/adapter/cap-a0-numeric-v1.mjs`,
        revision: `sha256:${P.adapter.sha256}`,
        sha256: P.adapter.sha256,
        size: P.adapter.size,
      },
      {
        name: "numeric.c",
        source: `${EVIDENCE_REL}/source/numeric.c`,
        revision: P.evidenceCommit,
        sha256: P.numericC.sha256,
        size: P.numericC.size,
      },
    ],
    dependencies: [],
    patches: [],
    buildScript: {
      name: "build.sh",
      source: `${EVIDENCE_REL}/build.sh`,
      revision: P.evidenceCommit,
      sha256: P.buildSh.sha256,
      size: P.buildSh.size,
    },
    argv: [...P.argv],
    environment: { SOURCE_DATE_EPOCH: P.sourceDateEpoch },
    outputAssets: assets.map((a) => a.id),
    comparison: {
      kind: "same-sdk-byte-identical",
      buildA: comparisonPin("build-a"),
      buildB: comparisonPin("build-b"),
      hermeticReprovisioned: false,
      // The comparison scope names exactly the historical numeric Wasm + glue;
      // the newly authored adapter is pinned through `sources` instead.
      assets: ["glue", "main"],
    },
  };
  const sidecarBytes = enc.encode(canonicalJson(sidecar));

  // ── SBOM (minimal honest CycloneDX 1.5) ───────────────────────────────────
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: P.sbomSerial,
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": `${P.packageId}@${P.packageVersion}`,
        name: P.packageId,
        version: P.packageVersion,
        description: "ltkj.2 acceptance fixture: A0 numeric module (cap_weighted_sum) bound to one admitted schema-2 graph. Validation-only; execution is not enabled; absent from the default/release inventory.",
        licenses: [{ expression: "Apache-2.0" }],
        properties: [
          { name: "cap:admitted", value: "false" },
          { name: "cap:executable", value: "false" },
          { name: "cap:acceptanceFixture", value: "true" },
          { name: "cap:evidence", value: EVIDENCE_REL },
        ],
      },
    },
    components: [
      {
        type: "library",
        "bom-ref": "numeric.c",
        name: "numeric.c",
        version: "1.0.0",
        description: "CAP-authored A0 fixture source compiled with pinned Emscripten 6.0.0 (worker, no dynamic execution).",
        licenses: [{ license: { id: "Apache-2.0" } }],
        hashes: [{ "alg": "SHA-256", content: P.numericC.sha256 }],
      },
      {
        type: "library",
        "bom-ref": "cap-a0-numeric-v1.mjs",
        name: "cap-a0-numeric-v1 adapter",
        version: "1.0.0",
        description: "CAP-authored adapter binding the declared entry operation to the exact typed export with manifest-declared parameter bounds.",
        licenses: [{ license: { id: "Apache-2.0" } }],
        hashes: [{ "alg": "SHA-256", content: P.adapter.sha256 }],
      },
    ],
  };
  const sbomBytes = enc.encode(JSON.stringify(sbom, null, 1) + "\n");

  // ── Manifest (modules measured from the real bytes) ───────────────────────
  const { features: _features, ...measured } = scan;
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
    source: { repo: "https://github.com/PaulKinlan/chrome-agent-platform", commit: P.evidenceCommit },
    build: {
      toolchain: "emcc 6.0.0",
      profile: "release",
      reproducible: false,
      rebuildRef: `${EVIDENCE_REL}/build.sh`,
    },
    sbom: { format: "cyclonedx-json@1.5", sha256: sha256Bytes(sbomBytes), ref: P.sbomRel },
    license: { spdx: "Apache-2.0", file: "extension/wasm/licenses/CAP-authored-Apache-2.0.txt" },
    meta: {
      category: "validation",
      channel: "bundled",
      description: "A0 numeric acceptance fixture: cap_weighted_sum(value, weight, bias) as one f64 scalar operation. Validation-only; execution is not enabled.",
      label: "a0_numeric",
      status: "validation-only",
      note: `ltkj.2 acceptance fixture; evidence: ${EVIDENCE_REL}; never present in the default/release inventory`,
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
      imports: [],
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
    identity: emscriptenIdentity,
    auditGraph: auditEmscriptenGraph,
    auditModule: auditEmscriptenModule,
  });
  const authority = new WasmPackageAuthority();
  const validated = authority.validateManifest(canonical);
  if (!validated.ok) {
    fail(`generated acceptance manifest failed validation: ${validated.error} ${validated.path ?? ""} ${validated.detail ?? ""}`);
  }

  // Re-audit with the FINAL declared values exactly as admission will.
  const fileMap = new Map([
    [adapterRel, adapterBytes instanceof Uint8Array ? adapterBytes : new Uint8Array(adapterBytes)],
    [glueRel, new Uint8Array(glueA)],
    [casRel, new Uint8Array(mainA)],
  ]);
  validateEmscriptenProvenance(new TextDecoder().decode(sidecarBytes), validated.manifest);
  const graph = await auditEmscriptenGraph(
    { assets: validated.manifest.assets, modules: validated.manifest.modules, linkGraph: validated.manifest.linkGraph },
    fileMap,
  );
  assertEmscriptenNumericEligibility(validated.manifest, graph);

  // CAS mapping goes through the shared schema-aware helper (single mapping rule).
  const mappings = manifestCasMappings(validated.manifest);
  if (mappings.length !== 1 || mappings[0].casRel !== casRel || mappings[0].schemaVersion !== 2) {
    fail("schema-aware CAS mapping disagrees with the fixture address");
  }

  const manifestBytes = enc.encode(canonical);
  return {
    files: [
      { rel: adapterRel, bytes: adapterBytes instanceof Uint8Array ? adapterBytes : new Uint8Array(adapterBytes) },
      { rel: glueRel, bytes: new Uint8Array(glueA) },
      { rel: casRel, bytes: new Uint8Array(mainA) },
      { rel: P.sidecarRel, bytes: sidecarBytes },
      { rel: P.sbomRel, bytes: sbomBytes },
      { rel: manifestRel, bytes: manifestBytes },
    ],
    manifest: validated.manifest,
    manifestCanonical: canonical,
    manifestDigest: validated.manifestDigest,
    inventoryManifestRow: { pkg: P.packageId, version: P.packageVersion, digest: validated.manifestDigest },
    identity: emscriptenIdentity(validated.manifest),
    digests: {
      adapter: P.adapter.sha256,
      glue: P.glue.sha256,
      main: P.main.sha256,
      sidecar: sha256Bytes(sidecarBytes),
      sbom: sha256Bytes(sbomBytes),
      numericC: P.numericC.sha256,
      buildSh: P.buildSh.sha256,
    },
    evidenceCommit: P.evidenceCommit,
  };
}
