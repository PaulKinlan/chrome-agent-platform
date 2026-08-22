// CAP-FB-20260822-WASM-PACKAGE-AUTHORITY-01 — bundled-only package records.
// Pure no-Chrome tests: strict raw manifest, bounded binary measurement,
// immutable inventory, exact-generation WAL recovery, revocation and no route.
// @ts-nocheck
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  auditWasmBinary,
  BUNDLED_ALLOWED_IMPORT_MODULES,
  canonicalJson,
  WasmPackageAuthority,
  WasmPackageAuthorityError,
  WASM_PACKAGE_LIMITS,
} from "../extension/lib/wasm-package-authority.js";
import { sha256Hex } from "../extension/lib/pure.js";
import { scanBundledWasmFiles, scanShippedJs } from "../scripts/scan-shipped.mjs";

const enc = new TextEncoder();
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const digest = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
const leb = (value) => {
  const out = [];
  let n = value >>> 0;
  do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n);
  return out;
};
const section = (id, payload) => new Uint8Array([id, ...leb(payload.length), ...payload]);
const moduleBytes = (...sections) => new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sections.flatMap((value) => [...value])]);
const memorySection = ({ flags = 1, min = 1, max = 2, count = 1 } = {}) => section(5, [count, ...Array.from({ length: count }, () => [flags, min, ...(flags & 1 ? [max] : [])]).flat()]);
const asciiName = (value) => [value.length, ...enc.encode(value)];
const importedMemory = ({ module = "wasi_snapshot_preview1", name = "memory", flags = 1, min = 1, max = 2 } = {}) => section(2, [1, ...asciiName(module), ...asciiName(name), 2, flags, min, ...(flags & 1 ? [max] : [])]);
const typeSection = () => section(1, [1, 0x60, 0, 0]);
const functionImport = ({ module = "wasi_snapshot_preview1", name = "fd_write", typeIndex = 0 } = {}) => section(2, [1, ...asciiName(module), ...asciiName(name), 0, typeIndex]);
const expectCode = async (fn, code) => {
  let caught;
  try { await fn(); } catch (error) { caught = error; }
  assert(caught instanceof WasmPackageAuthorityError, `expected ${code}, got ${caught?.name ?? "no error"}`);
  assertEquals(caught.code, code);
};

class FakeStore {
  constructor() {
    this.rows = new Map();
    this.version = 0;
    this.fault = null;
  }
  arm({ method, key = null, state = null, when = "before" }) { this.fault = { method, key, state, when }; }
  _match(method, key, value, when) {
    const fault = this.fault;
    if (!fault || fault.method !== method || fault.when !== when || (fault.key != null && fault.key !== key) || (fault.state != null && fault.state !== value?.state)) return false;
    this.fault = null;
    return true;
  }
  _throw() { throw new Error("injected crash"); }
  async getStrict(key) { return this.rows.has(key) ? structuredClone(this.rows.get(key).value) : null; }
  async getVersion(key) { return this.rows.get(key)?.version ?? 0; }
  async setTrusted(key, value) {
    if (this._match("setTrusted", key, value, "before")) this._throw();
    const token = ++this.version;
    this.rows.set(key, { value: structuredClone(value), version: token });
    if (this._match("setTrusted", key, value, "after")) this._throw();
    return token;
  }
  async compareAndRestore(key, expectedVersion, value) {
    if (this._match("compareAndRestore", key, value, "before")) this._throw();
    if ((this.rows.get(key)?.version ?? 0) !== expectedVersion) return false;
    const token = ++this.version;
    this.rows.set(key, { value: structuredClone(value), version: token });
    if (this._match("compareAndRestore", key, value, "after")) this._throw();
    return true;
  }
  async compareAndDelete(key, expectedVersion) {
    if ((this.rows.get(key)?.version ?? 0) !== expectedVersion) return false;
    this.rows.delete(key);
    this.version++;
    return true;
  }
}

function capabilityDigest(values = ["compute"]) { return sha256Hex(canonicalJson(values)); }

async function manifestObject({ version = "1.0.0", wasm = moduleBytes(memorySection()), capabilities = ["compute"], imports = { allowed: [], disallowed: [] }, tier = "tiny", keyId = "release-key", sig = undefined } = {}) {
  const wasmDigest = await digest(wasm);
  const sbomBytes = enc.encode('{"bomFormat":"CycloneDX"}');
  const sbomDigest = await digest(sbomBytes);
  const object = {
    schemaVersion: 1,
    package: { id: "org.example.text", version, name: "example_text", type: "tool-bundle" },
    tools: [{ toolId: "transform", digest: "a".repeat(64), capabilityDigest: capabilityDigest(capabilities), replayClass: "read-only", capabilities }],
    executables: [{
      id: "transform_wasm", sha256: wasmDigest, size: wasm.byteLength,
      imports: structuredClone(imports),
      memory: { tier, initialPages: 1, maxPages: tier === "tiny" ? 8 : tier === "default" ? 64 : 4096 },
      runtimeCompat: ["wasm32"], replayClass: "read-only", capabilities,
      capabilityDigest: capabilityDigest(capabilities),
    }],
    signer: { lane: "bundled", keyId, alg: sig ? "Ed25519" : "none", ...(sig ? { sig } : {}) },
    source: { repo: "https://example.test/repo", commit: "b".repeat(40) },
    build: { toolchain: "clang-19", profile: "release", reproducible: true, rebuildRef: "build/example" },
    sbom: { format: "cyclonedx-json@1.5", sha256: sbomDigest, ref: `extension/wasm/sbom/${sbomDigest}.json` },
    license: { spdx: "MIT", file: "extension/wasm/licenses/example.txt", notices: "extension/wasm/licenses/NOTICE.txt" },
    meta: {},
  };
  return { object, wasm, wasmDigest, sbomBytes, sbomDigest };
}

async function scenario(options = {}) {
  const built = await manifestObject(options);
  const raw = canonicalJson(built.object);
  const probe = new WasmPackageAuthority();
  const manifestDigest = probe.manifestDigest(built.object);
  const manifestRel = `extension/wasm/manifests/${built.object.package.id}-${built.object.package.version}.manifest.json`;
  const files = new Map([
    [`extension/wasm/cas/${built.wasmDigest}.wasm`, built.wasm],
    [manifestRel, enc.encode(raw)],
    [built.object.sbom.ref, built.sbomBytes],
    [built.object.license.file, enc.encode("MIT\n")],
    [built.object.license.notices, enc.encode("Notices\n")],
  ]);
  const inventoryFiles = [];
  for (const [rel, bytes] of files) inventoryFiles.push({ rel, sha256: await digest(bytes), size: bytes.byteLength });
  const inventory = {
    release: "0.2.151",
    files: inventoryFiles,
    manifests: [{ pkg: built.object.package.id, version: built.object.package.version, digest: manifestDigest }],
    signer: { lane: "bundled", keyId: built.object.signer.keyId },
    evidence: options.largeEvidence ? [{ id: "mv3-ref", kind: "mv3-worker-memory", tier: "large", result: "PASS" }] : [],
    revocations: [],
    transitions: [],
    async readFile(rel) { return files.get(rel); },
    async listFiles() { return [...files.keys()]; },
  };
  const store = options.store ?? new FakeStore();
  const authority = new WasmPackageAuthority({ getStore: () => store, inventory, now: options.now ?? (() => 1000) });
  return { ...built, raw, manifestDigest, files, inventory, store, authority, admissionFiles: new Map([[built.wasmDigest, built.wasm]]) };
}

async function addVersion(s, options) {
  const built = await manifestObject(options);
  const raw = canonicalJson(built.object);
  const manifestDigest = s.authority.manifestDigest(built.object);
  const rel = `extension/wasm/manifests/${built.object.package.id}-${built.object.package.version}.manifest.json`;
  const bytes = enc.encode(raw);
  s.files.set(rel, bytes);
  s.inventory.files.push({ rel, sha256: await digest(bytes), size: bytes.byteLength });
  s.inventory.manifests.push({ pkg: built.object.package.id, version: built.object.package.version, digest: manifestDigest });
  await s.authority.loadInventory();
  return { ...built, raw, manifestDigest, admissionFiles: new Map([[built.wasmDigest, built.wasm]]) };
}

Deno.test("wasm manifest: canonical strict schema accepts one bounded bundled record", async () => {
  const s = await scenario();
  const result = s.authority.validateManifest(s.raw);
  assert(result.ok);
  assertEquals(result.manifestDigest, s.manifestDigest);
  assertEquals(result.signatureScope, `cap-wasm-manifest:v1\u0000${s.manifestDigest}`);
  assertEquals((await s.authority.loadInventory()).files, 5);
});

Deno.test("wasm manifest/import policy: only exact WASI P1 is allowlisted; declarations remain bounded, sorted and fail closed", async () => {
  assertEquals(BUNDLED_ALLOWED_IMPORT_MODULES, ["wasi_snapshot_preview1"]);
  assert(Object.isFrozen(BUNDLED_ALLOWED_IMPORT_MODULES));
  assertEquals(WASM_PACKAGE_LIMITS.MAX_IMPORT_MODULES, 8);
  assertEquals(WASM_PACKAGE_LIMITS.MAX_IMPORT_MODULE_NAME_BYTES, 64);
  const base = await scenario();
  const variants = [
    [{ allowed: ["env"], disallowed: [] }, "import_not_allowed"],
    [{ allowed: ["wasi_snapshot_previewl"], disallowed: [] }, "import_not_allowed"],
    [{ allowed: ["wasi_unstable"], disallowed: [] }, "import_not_allowed"],
    [{ allowed: ["wasí_snapshot_preview1"], disallowed: [] }, "manifest_non_ascii"],
    [{ allowed: ["a".repeat(65)], disallowed: [] }, "manifest_string_bound"],
    [{ allowed: ["*"], disallowed: [] }, "import_invalid"],
    [{ allowed: [], disallowed: [".env"] }, "import_invalid"],
    [{ allowed: ["wasi_snapshot_preview1", "wasi_snapshot_preview1"], disallowed: [] }, "import_order"],
    [{ allowed: [], disallowed: ["env", "*"] }, "import_order"],
    [{ allowed: [], disallowed: ["env", "env"] }, "import_order"],
    [{ allowed: [], disallowed: Array.from({ length: 9 }, (_, index) => `module${index}`) }, "import_bound"],
  ];
  for (const [imports, code] of variants) {
    const object = structuredClone(base.object);
    object.executables[0].imports = imports;
    assertEquals(base.authority.validateManifest(canonicalJson(object)).error, code, JSON.stringify(imports));
  }
  for (const disallowed of [["*"], ["env"], ["a".repeat(64)], ["wasi_snapshot_preview1"]]) {
    const object = structuredClone(base.object);
    object.executables[0].imports = { allowed: ["wasi_snapshot_preview1"], disallowed };
    assert(base.authority.validateManifest(canonicalJson(object)).ok, JSON.stringify(disallowed));
  }
});

Deno.test("wasm manifest: duplicate keys are rejected before materialization including escaped/nested forms", async () => {
  const authority = new WasmPackageAuthority();
  for (const raw of [
    '{"a":1,"a":2}',
    '{"a":{"x":1,"x":2}}',
    '{"a\\\"b":1,"a\\\"b":2}',
    '{"a":1,"\\u0061":2}',
    '{"a\\\\b":1,"a\\\\b":2}',
  ]) {
    assertEquals(authority.validateManifest(raw).error, "manifest_duplicate_key", raw);
  }
  assertEquals(authority.validateManifest('{"A":1,"a":2}').error, "manifest_unknown_field", "lookalike distinct keys are not collapsed");
});

Deno.test("wasm manifest: unknown fields fail every depth; Unicode, semver, identity and owner lane fail closed", async () => {
  const s = await scenario();
  const variants = [
    [{ ...s.object, evil: true }, "manifest_unknown_field"],
    [{ ...s.object, package: { ...s.object.package, evil: true } }, "manifest_unknown_field"],
    [{ ...s.object, executables: [{ ...s.object.executables[0], evil: true }] }, "manifest_unknown_field"],
    [{ ...s.object, meta: { evil: "x" } }, "manifest_unknown_field"],
    [{ ...s.object, package: { ...s.object.package, name: "unicodé" } }, "manifest_non_ascii"],
    [{ ...s.object, package: { ...s.object.package, name: "bad\ud800" } }, "manifest_non_ascii"],
    [{ ...s.object, package: { ...s.object.package, name: "bad\u202e" } }, "manifest_non_ascii"],
    [{ ...s.object, package: { ...s.object.package, version: "01.0.0" } }, "semver_invalid"],
    [{ ...s.object, signer: { ...s.object.signer, lane: "owner" } }, "lane_not_admitted"],
    [{ ...s.object, tools: [s.object.tools[0], s.object.tools[0]] }, "tool_id_duplicate"],
  ];
  for (const [object, code] of variants) assertEquals(s.authority.validateManifest(canonicalJson(object)).error, code);
  assertEquals(s.authority.validateManifest(JSON.stringify(s.object)).error, "manifest_not_canonical");
});

Deno.test("wasm manifest: capability/digest/signature substitution and provenance fields are explicit", async () => {
  const s = await scenario({ sig: "ab".repeat(64) });
  const base = s.authority.validateManifest(s.raw);
  assert(base.ok);
  const changedSig = structuredClone(s.object);
  changedSig.signer.sig = "cd".repeat(64);
  assertEquals(s.authority.validateManifest(canonicalJson(changedSig)).manifestDigest, base.manifestDigest, "signature bytes are outside identity and explicitly unverified");
  const changedTool = structuredClone(s.object);
  changedTool.tools[0].digest = "c".repeat(64);
  assert(s.authority.validateManifest(canonicalJson(changedTool)).manifestDigest !== base.manifestDigest);
  const badCapabilities = structuredClone(s.object);
  badCapabilities.executables[0].capabilities = ["data.read"];
  assertEquals(s.authority.validateManifest(canonicalJson(badCapabilities)).error, "capability_digest_mismatch");
  const undeclared = structuredClone(s.object);
  undeclared.executables[0].capabilities = ["network"];
  undeclared.executables[0].capabilityDigest = capabilityDigest(["network"]);
  assertEquals(s.authority.validateManifest(canonicalJson(undeclared)).error, "capability_not_declared");
  const missingBuild = structuredClone(s.object);
  delete missingBuild.build.toolchain;
  assertEquals(s.authority.validateManifest(canonicalJson(missingBuild)).error, "manifest_missing_field");
  const badLicense = structuredClone(s.object);
  badLicense.license.spdx = "SEE-FILE";
  assertEquals(s.authority.validateManifest(canonicalJson(badLicense)).error, "license_invalid");
});

Deno.test("wasm scanner: canonical framing measures one defined/imported memory and records skipped sections", async () => {
  const s = await scenario();
  const measured = auditWasmBinary(s.wasm, s.object.executables[0]);
  assertEquals(measured.measured.memoryMax, 2);
  assertEquals(measured.measured.imported, false);
  const imported = moduleBytes(importedMemory());
  const importedBuilt = await manifestObject({
    wasm: imported,
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
  });
  const measuredImport = auditWasmBinary(imported, importedBuilt.object.executables[0]);
  assertEquals(measuredImport.measured.imported, true);
  assertEquals(measuredImport.imports[0], {
    module: "wasi_snapshot_preview1",
    name: "memory",
    kind: "memory",
  });
  const withSkipped = moduleBytes(section(1, []), memorySection(), section(10, []));
  const skippedBuilt = await manifestObject({ wasm: withSkipped });
  const skipped = auditWasmBinary(withSkipped, skippedBuilt.object.executables[0]);
  assertEquals(skipped.skippedSections.map((row) => row.name), ["type", "code"]);
});

Deno.test("wasm scanner/import policy: exact WASI function imports are inspected and disallowed declarations block admission", async () => {
  const wasi = moduleBytes(typeSection(), functionImport(), memorySection());
  assert(WebAssembly.validate(wasi), "bounded WASI function-import fixture is a valid Wasm module");
  const admitted = await scenario({
    wasm: wasi,
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
  });
  const manifest = admitted.authority.validateManifest(admitted.raw);
  assert(manifest.ok);
  const measured = auditWasmBinary(wasi, admitted.object.executables[0]);
  assertEquals(measured.imports, [{
    module: "wasi_snapshot_preview1",
    name: "fd_write",
    kind: "function",
  }]);
  assertEquals(measured.measured, {
    memoryInitial: 1,
    memoryMax: 2,
    imported: false,
    tier: "tiny",
  });
  assert((await admitted.authority.admitBundled({
    manifest: admitted.raw,
    files: admitted.admissionFiles,
  })).ok);

  for (const disallowed of [["*"], ["wasi_snapshot_preview1"]]) {
    const built = await manifestObject({
      wasm: wasi,
      imports: { allowed: ["wasi_snapshot_preview1"], disallowed },
    });
    await expectCode(
      () => Promise.resolve(auditWasmBinary(wasi, built.object.executables[0])),
      "import_not_allowed",
    );
  }
  const unrelatedBlock = await manifestObject({
    wasm: wasi,
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: ["env"] },
  });
  assertEquals(auditWasmBinary(wasi, unrelatedBlock.object.executables[0]).imports[0].module, "wasi_snapshot_preview1");

  const env = moduleBytes(typeSection(), functionImport({ module: "env" }), memorySection());
  const forged = await manifestObject({ wasm: env });
  forged.object.executables[0].imports.allowed = ["env"];
  await expectCode(
    () => Promise.resolve(auditWasmBinary(env, forged.object.executables[0])),
    "import_not_allowed",
  );
});

Deno.test("wasm scanner: malformed/noncanonical/order/duplicate/framing and import policy fail closed", async () => {
  const s = await scenario();
  const executable = s.object.executables[0];
  const cases = [
    [new Uint8Array([0, 1]), "wasm_magic"],
    [new Uint8Array([0, 0x61, 0x73, 0x6d, 2, 0, 0, 0]), "wasm_version"],
    [moduleBytes(new Uint8Array([0, 0x80, 0x00])), "leb_non_canonical"],
    [moduleBytes(new Uint8Array([0, 10, 1])), "section_size_overflow"],
    [moduleBytes(memorySection(), section(2, [])), "section_order"],
    [moduleBytes(memorySection(), memorySection()), "duplicate_section"],
  ];
  for (const [bytes, code] of cases) await expectCode(() => Promise.resolve(auditWasmBinary(bytes, executable)), code);
  const imported = moduleBytes(importedMemory({ module: "evil" }));
  const importedBuilt = await manifestObject({
    wasm: imported,
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
  });
  await expectCode(() => Promise.resolve(auditWasmBinary(imported, importedBuilt.object.executables[0])), "import_not_allowed");
  const unknownFlags = moduleBytes(memorySection({ flags: 9 }));
  const unknownBuilt = await manifestObject({ wasm: unknownFlags });
  await expectCode(() => Promise.resolve(auditWasmBinary(unknownFlags, unknownBuilt.object.executables[0])), "memory_flags_unknown");
});

Deno.test("wasm scanner: memory64/shared/missing-max/multi-memory/measured ceilings and tier evidence are enforced", async () => {
  for (const [bytes, code] of [
    [moduleBytes(memorySection({ flags: 5 })), "memory64_rejected"],
    [moduleBytes(memorySection({ flags: 3 })), "memory_shared_rejected"],
    [moduleBytes(memorySection({ flags: 0 })), "memory_max_missing"],
    [moduleBytes(memorySection({ count: 2 })), "multi_memory_rejected"],
  ]) {
    const built = await manifestObject({ wasm: bytes });
    await expectCode(() => Promise.resolve(auditWasmBinary(bytes, built.object.executables[0])), code);
  }
  const importedAndDefined = moduleBytes(importedMemory(), memorySection());
  const unionBuilt = await manifestObject({
    wasm: importedAndDefined,
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
  });
  await expectCode(() => Promise.resolve(auditWasmBinary(importedAndDefined, unionBuilt.object.executables[0])), "multi_memory_rejected");
  const over = moduleBytes(memorySection({ max: 9 }));
  const overBuilt = await manifestObject({ wasm: over });
  overBuilt.object.executables[0].memory.maxPages = 8;
  await expectCode(() => Promise.resolve(auditWasmBinary(over, overBuilt.object.executables[0])), "memory_exceeds_ceiling");
  const defaultTier = await scenario({ tier: "default" });
  assert((await defaultTier.authority.admitBundled({ manifest: defaultTier.raw, files: defaultTier.admissionFiles })).ok, "default tier is admitted within measured ceilings");
  const large = await scenario({ tier: "large" });
  await expectCode(() => large.authority.admitBundled({ manifest: large.raw, files: large.admissionFiles }), "tier_blocked");
  const allowedLarge = await scenario({ tier: "large", largeEvidence: true });
  assert((await allowedLarge.authority.admitBundled({ manifest: allowedLarge.raw, files: allowedLarge.admissionFiles })).ok);
});

Deno.test("wasm scanner: section/custom/total bomb caps and unmanifested static scan are bounded", async () => {
  const s = await scenario();
  const tinyLimits = { ...WASM_PACKAGE_LIMITS, MAX_SECTIONS: 2, MAX_SECTION_BYTES: 8, MAX_CUSTOM_SECTION_BYTES: 2, MAX_BINARY_BYTES: 64, TIERS: WASM_PACKAGE_LIMITS.TIERS };
  await expectCode(() => Promise.resolve(auditWasmBinary(moduleBytes(section(0, []), section(0, []), memorySection()), s.object.executables[0], { limits: tinyLimits })), "too_many_sections");
  await expectCode(() => Promise.resolve(auditWasmBinary(moduleBytes(section(0, [1, 2, 3]), memorySection()), s.object.executables[0], { limits: tinyLimits })), "custom_section_over_budget");
  await expectCode(() => Promise.resolve(auditWasmBinary(moduleBytes(section(1, new Array(9).fill(0)), memorySection()), s.object.executables[0], { limits: tinyLimits })), "section_too_large");
  await expectCode(() => Promise.resolve(auditWasmBinary(new Uint8Array(65), s.object.executables[0], { limits: tinyLimits })), "binary_too_large");
  const violations = await scanBundledWasmFiles(["fixture.wasm"], { readBytes: async () => s.wasm, manifestByFile: new Map() });
  assertEquals(violations, ["fixture.wasm: unmanifested_binary"]);
});

Deno.test("wasm inventory/admission: exact bytes, size, SBOM, licence and signer inventory are required", async () => {
  const s = await scenario();
  const admitted = await s.authority.admitBundled({ manifest: s.raw, files: s.admissionFiles });
  assert(admitted.ok);
  assertEquals(admitted.record.signer.verified, false);
  assertEquals(admitted.record.signer.verification, "not-implemented");
  assertEquals((await s.authority.query({ packageId: s.object.package.id })).record.current.executables[0].measured.memoryMax, 2);

  const badBytes = await scenario();
  badBytes.admissionFiles.set(badBytes.wasmDigest, new Uint8Array(badBytes.wasm.length));
  await expectCode(() => badBytes.authority.admitBundled({ manifest: badBytes.raw, files: badBytes.admissionFiles }), "digest_mismatch");
  assertEquals(await badBytes.store.getStrict("__wasmTx"), null, "verification failure writes no WAL");
  const shortBytes = await scenario();
  shortBytes.admissionFiles.set(shortBytes.wasmDigest, shortBytes.wasm.slice(0, -1));
  await expectCode(() => shortBytes.authority.admitBundled({ manifest: shortBytes.raw, files: shortBytes.admissionFiles }), "size_mismatch");
  const badInventory = await scenario();
  badInventory.inventory.files[0].size += 1;
  await expectCode(() => badInventory.authority.loadInventory(), "inventory_mismatch");
  const badSbom = await scenario();
  const sbomRel = badSbom.object.sbom.ref;
  badSbom.files.set(sbomRel, enc.encode("tampered"));
  await expectCode(() => badSbom.authority.loadInventory(), "inventory_mismatch");
  const badSbomRecord = await scenario();
  badSbomRecord.object.sbom.sha256 = "f".repeat(64);
  badSbomRecord.raw = canonicalJson(badSbomRecord.object);
  badSbomRecord.inventory.manifests[0].digest = badSbomRecord.authority.manifestDigest(badSbomRecord.object);
  await expectCode(() => badSbomRecord.authority.admitBundled({ manifest: badSbomRecord.raw, files: badSbomRecord.admissionFiles }), "sbom_mismatch");
  const duplicateManifest = await scenario();
  duplicateManifest.inventory.manifests.push({ ...duplicateManifest.inventory.manifests[0], digest: "f".repeat(64) });
  await expectCode(() => duplicateManifest.authority.loadInventory(), "manifest_identity_conflict");
  const wrongSigner = await scenario();
  wrongSigner.inventory.signer.keyId = "other-release-key";
  await expectCode(() => wrongSigner.authority.admitBundled({ manifest: wrongSigner.raw, files: wrongSigner.admissionFiles }), "key_not_active");
  const identity = await scenario();
  await identity.authority.admitBundled({ manifest: identity.raw, files: identity.admissionFiles });
  const conflicting = structuredClone(identity.object);
  conflicting.tools[0].digest = "c".repeat(64);
  const conflictingRaw = canonicalJson(conflicting);
  const conflictingDigest = identity.authority.manifestDigest(conflicting);
  identity.inventory.manifests[0].digest = conflictingDigest;
  const manifestRel = `extension/wasm/manifests/${conflicting.package.id}-${conflicting.package.version}.manifest.json`;
  const manifestBytes = enc.encode(conflictingRaw);
  identity.files.set(manifestRel, manifestBytes);
  const inventoryRow = identity.inventory.files.find((row) => row.rel === manifestRel);
  inventoryRow.sha256 = await digest(manifestBytes);
  inventoryRow.size = manifestBytes.byteLength;
  const identityRestart = new WasmPackageAuthority({ getStore: () => identity.store, inventory: identity.inventory });
  await expectCode(() => identityRestart.admitBundled({ manifest: conflictingRaw, files: identity.admissionFiles, expectedVersion: "1.0.0" }), "manifest_identity_conflict");
  const keyRevoked = await scenario();
  keyRevoked.inventory.revocations.push({ keyId: "release-key", reason: "offline", at: 1 });
  await expectCode(() => keyRevoked.authority.admitBundled({ manifest: keyRevoked.raw, files: keyRevoked.admissionFiles }), "key_revoked");
});

Deno.test("wasm WAL: every install transition recovers to exact compensated/committed state", async () => {
  const matrix = [
    [{ method: "setTrusted", key: "__wasmTx", state: "prepared", when: "before" }, null, "absent"],
    [{ method: "setTrusted", key: "__wasmTx", state: "prepared", when: "after" }, "compensated", "absent"],
    [{ method: "compareAndRestore", key: "wasmPkg", when: "before" }, "compensated", "absent"],
    [{ method: "compareAndRestore", key: "wasmPkg", when: "after" }, "committed", "present"],
    [{ method: "setTrusted", key: "__wasmTx", state: "committed", when: "before" }, "committed", "present"],
    [{ method: "setTrusted", key: "__wasmTx", state: "committed", when: "after" }, "committed", "present"],
    [{ method: "setTrusted", key: "__wasmTx", state: "none", when: "before" }, "committed", "present"],
  ];
  for (const [fault, terminal, expected] of matrix) {
    const s = await scenario();
    s.store.arm(fault);
    await assertRejects(() => s.authority.admitBundled({ manifest: s.raw, files: s.admissionFiles }));
    const restart = new WasmPackageAuthority({ getStore: () => s.store, inventory: s.inventory });
    const recovered = await restart.recoverTx();
    assertEquals(recovered.terminal ?? null, terminal, JSON.stringify(fault));
    const queried = await restart.query({ packageId: s.object.package.id });
    assertEquals(queried.ok === true ? "present" : queried.error, expected, JSON.stringify(fault));
  }
});

Deno.test("wasm WAL: update/revoke concurrency has one winner; revocation survives offline restart", async () => {
  const v1 = await scenario();
  await v1.authority.admitBundled({ manifest: v1.raw, files: v1.admissionFiles });
  const v2built = await addVersion(v1, { version: "2.0.0", wasm: v1.wasm, capabilities: ["data.read"] });
  const outcomes = await Promise.allSettled([
    v1.authority.admitBundled({ manifest: v2built.raw, files: v2built.admissionFiles, expectedVersion: "1.0.0" }),
    v1.authority.admitBundled({ manifest: v2built.raw, files: v2built.admissionFiles, expectedVersion: "1.0.0" }),
    v1.authority.revoke({ packageId: v1.object.package.id, version: "1.0.0", reason: "release revoked" }),
  ]);
  assertEquals(outcomes.filter((row) => row.status === "fulfilled").length, 1, "exactly one update/revoke wins");
  const restart = new WasmPackageAuthority({ getStore: () => v1.store, inventory: v1.inventory });
  const current = await restart.query({ packageId: v1.object.package.id });
  if (outcomes[2].status === "fulfilled") assertEquals(current.error, "revoked");
  else assertEquals(current.record.current.version, "2.0.0");

  // UPDATE crash after its exact registry CAS recovers committed.
  const updateCrash = await scenario();
  await updateCrash.authority.admitBundled({ manifest: updateCrash.raw, files: updateCrash.admissionFiles });
  const updateV2 = await addVersion(updateCrash, { version: "2.0.0", wasm: updateCrash.wasm, capabilities: ["data.read"] });
  updateCrash.store.arm({ method: "compareAndRestore", key: "wasmPkg", when: "after" });
  await assertRejects(() => updateCrash.authority.admitBundled({ manifest: updateV2.raw, files: updateV2.admissionFiles, expectedVersion: "1.0.0" }));
  const updateRestart = new WasmPackageAuthority({ getStore: () => updateCrash.store, inventory: updateCrash.inventory });
  assertEquals((await updateRestart.recoverTx()).terminal, "committed");
  assertEquals((await updateRestart.query({ packageId: updateCrash.object.package.id })).record.current.version, "2.0.0");

  // REVOKE before-CAS compensates to active; after-CAS commits revoked.
  for (const [when, terminal, expected] of [["before", "compensated", "present"], ["after", "committed", "revoked"]]) {
    const revokeCrash = await scenario();
    await revokeCrash.authority.admitBundled({ manifest: revokeCrash.raw, files: revokeCrash.admissionFiles });
    revokeCrash.store.arm({ method: "compareAndRestore", key: "wasmPkg", when });
    await assertRejects(() => revokeCrash.authority.revoke({ packageId: revokeCrash.object.package.id, version: "1.0.0", reason: "crash revoke" }));
    const revokeRestart = new WasmPackageAuthority({ getStore: () => revokeCrash.store, inventory: revokeCrash.inventory });
    assertEquals((await revokeRestart.recoverTx()).terminal, terminal);
    const result = await revokeRestart.query({ packageId: revokeCrash.object.package.id });
    assertEquals(result.ok ? "present" : result.error, expected);
  }
});

Deno.test("wasm revocation/grant epoch: update invalidates grants and revoked state survives offline restart", async () => {
  const s = await scenario();
  await s.authority.admitBundled({ manifest: s.raw, files: s.admissionFiles });
  const epoch1 = (await s.authority.grantEpoch(s.object.package.id)).epoch;
  const v2 = await addVersion(s, { version: "2.0.0", wasm: s.wasm, capabilities: ["data.read"] });
  await s.authority.admitBundled({ manifest: v2.raw, files: v2.admissionFiles, expectedVersion: "1.0.0" });
  const epoch2 = (await s.authority.grantEpoch(s.object.package.id)).epoch;
  assert(epoch1 !== epoch2 && epoch2.startsWith("2.0.0:"), "version/capability change invalidates the grant epoch");
  const revoked = await s.authority.revoke({ packageId: s.object.package.id, version: "2.0.0", reason: "offline revoke" });
  assert(revoked.ok);
  assert((await s.authority.revoke({ packageId: s.object.package.id, version: "2.0.0", reason: "offline revoke" })).deduped);
  const restart = new WasmPackageAuthority({ getStore: () => s.store, inventory: s.inventory });
  assertEquals((await restart.query({ packageId: s.object.package.id })).error, "revoked");
  assertEquals((await restart.grantEpoch(s.object.package.id)).error, "revoked");
});

Deno.test("wasm authority corruption fails closed and never becomes an empty registry", async () => {
  const s = await scenario();
  await s.store.setTrusted("wasmPkg", "corrupt");
  await expectCode(() => s.authority.query({ packageId: s.object.package.id }), "registry_corrupt");
  const wal = await scenario();
  await wal.store.setTrusted("__wasmTx", { state: "prepared", op: "invented" });
  await expectCode(() => wal.authority.recoverTx(), "wasm_wal_corrupt");

  // Exact generation tokens reject an ABA-shaped registry rewrite even when
  // the package row again looks absent.
  const aba = await scenario();
  aba.store.arm({ method: "compareAndRestore", key: "wasmPkg", when: "before" });
  await assertRejects(() => aba.authority.admitBundled({ manifest: aba.raw, files: aba.admissionFiles }));
  await aba.store.setTrusted("wasmPkg", { schemaVersion: 1, packages: {} });
  const abaRestart = new WasmPackageAuthority({ getStore: () => aba.store, inventory: aba.inventory });
  await expectCode(() => abaRestart.recoverTx(), "wasm_wal_recovery_conflict");
});

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
  await walk(new URL("../extension", import.meta.url).pathname);
  // Since 0.2.157 the bundled lane PHYSICALLY SHIPS the 25 reviewed binaries
  // (inventory-only; still no route/execution). The successor invariant: the
  // shipped set is EXACTLY the inventory's declared CAS set — no more, no
  // less — and every byte hashes to its pinned content address.
  const { BUNDLED_INVENTORY } = await import("../extension/lib/bundled-inventory-data.js");
  const declaredCas = BUNDLED_INVENTORY.files
    .filter((row) => row.rel.startsWith("extension/wasm/cas/"))
    .map((row) => new URL(`../${row.rel}`, import.meta.url).pathname)
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
