// Shape/identity tests ONLY. Synthetic pins are not an inventory, licensing
// evidence, a released candidate, or a successful numeric admission fixture.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { canonicalJson, WasmPackageAuthority } from "../extension/lib/wasm-package-authority.js";
// ycez/ltkj.2: the schema-2 surface is REGISTERED by the options-document broker — importing it here
// is what lets `authority.validateManifest` validate a schema-2 record at all (the authority takes the
// surface by injection and never imports the decoder itself; see lib/emscripten-admission.js).
import "../extension/lib/emscripten-admission.js";
import { emscriptenIdentity, validateEmscriptenProvenance } from "../extension/lib/emscripten-manifest.js";
import { sha256Hex } from "../extension/lib/pure.js";
const hash = (v: unknown) => sha256Hex(canonicalJson(v));
function fixture(): any {
  const capabilities = ["compute"];
  const op = { id: "weighted_sum", toolId: "weighted_sum", kind: "native-scalar-v1", exportName: "cap_weighted_sum", params: ["value", "weight", "bias"].map(name => ({ name, type: "f64", minimum: -1000000, maximum: 1000000 })), result: "f64", capabilities, replayClass: "read-only", io: { kind: "none" } };
  const runtime: any = { kind: "emscripten-module-v1", abi: "emscripten-6.0.0-thin-native-v1", compiler: { version: "6.0.0", emsdkCommit: "d223ae73c6998296e3ab27cf81dc2c2c9fd383de", emscriptenCommit: "afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3" }, glue: { format: "es-module-factory", environment: "worker", dynamicExecution: false, filesystem: false }, features: [] };
  runtime.profileDigest = hash(runtime);
  return {
    schemaVersion: 2, package: { id: "org.example.shape", version: "1.0.0", name: "shape", type: "tool-bundle" },
    tools: [{ toolId: op.toolId, digest: hash(op), capabilityDigest: hash(capabilities), replayClass: op.replayClass, capabilities }],
    signer: { lane: "bundled", keyId: "shape-only", alg: "none" },
    source: { repo: "https://example.test/shape", commit: "b".repeat(40) },
    build: { toolchain: "shape-only", profile: "release", reproducible: false },
    sbom: { format: "cyclonedx-json@1.5", sha256: "c".repeat(64), ref: "shape/sbom.json" },
    license: { spdx: "MIT", file: "shape/synthetic-license.txt" }, meta: {}, runtime,
    assets: [
      { id: "adapter", role: "adapter", path: "extension/wasm/runtime/shape/1.0.0/adapter.mjs", sha256: "a".repeat(64), size: 1 },
      { id: "glue", role: "glue", path: "extension/wasm/runtime/shape/1.0.0/glue.mjs", sha256: "b".repeat(64), size: 2 },
      { id: "main", role: "main-wasm", path: `extension/wasm/cas/${"c".repeat(64)}.wasm`, sha256: "c".repeat(64), size: 3 },
    ],
    entry: { adapterId: "cap-a0-numeric-v1", adapterAsset: "adapter", glueAsset: "glue", mainAsset: "main", operations: [op] },
    modules: [{ asset: "main", imports: [], exports: [{ name: "cap_weighted_sum", kind: "function", index: 0, type: { params: ["f64", "f64", "f64"], results: ["f64"] } }], memories: [{ index: 0, type: { address: "i32", shared: false, min: 256, max: 256 } }], tables: [{ index: 0, type: { element: "funcref", min: 1, max: 1 } }], globals: [{ index: 0, type: { value: "i32", mutable: true }, initializer: { op: "i32.const", value: 66560 } }], tags: [], start: null, dylink: null }],
    linkGraph: { policy: "none", main: "main", dependencies: [] },
    resources: { class: "em32-unshared-fixed-16", memory: { owner: "main", index: 0, initialPages: 256, maxPages: 256, growth: false }, table: { owner: "main", index: 0, initialElements: 1, maxElements: 1, growth: false }, threads: { mode: "none" }, io: { filesystem: "none", network: false, clock: false, random: false }, lifecycle: { freshInstance: true, startupMs: 10000, callMs: 30000, concurrentJobs: 1 } },
    provenance: { record: { path: "shape/provenance.json", sha256: "d".repeat(64), size: 10 }, comparison: "same-sdk-byte-identical", hermeticReprovisioned: false },
  };
}
const authority = new WasmPackageAuthority();
Deno.test("emscripten manifest: 0mld dependencies use literal from/name tuple order", () => {
  const edges = [
    { from: "main", name: "z.wasm", to: "side" },
    { from: "main-side", name: "a.wasm", to: "side" },
  ];
  const m = fixture(); m.linkGraph = { policy: "eager", main: "main", dependencies: edges };
  assert(authority.validateManifest(canonicalJson(m)).ok);
  m.linkGraph.dependencies = [...edges].reverse();
  assertEquals(authority.validateManifest(canonicalJson(m)).error, "manifest_order");
  m.linkGraph.dependencies = [edges[0], edges[0]];
  assertEquals(authority.validateManifest(canonicalJson(m)).error, "manifest_order");
  m.linkGraph.dependencies = [{ ...edges[0], name: "a.wasm" }, edges[0]];
  assert(authority.validateManifest(canonicalJson(m)).ok);
  m.linkGraph.dependencies.reverse();
  assertEquals(authority.validateManifest(canonicalJson(m)).error, "manifest_order");
});
Deno.test("emscripten manifest: schema-2 shape has distinct signature scope and rejects unknown fields at nested boundaries", () => {
  const m = fixture();
  const valid = authority.validateManifest(canonicalJson(m));
  assert(valid.ok);
  assert(valid.signatureScope?.startsWith("cap-wasm-manifest:v2\u0000"));
  const paths = ["", "runtime", "runtime.compiler", "runtime.glue", "assets.0", "entry", "entry.operations.0", "entry.operations.0.params.0", "entry.operations.0.io", "modules.0", "modules.0.exports.0", "modules.0.exports.0.type", "modules.0.memories.0", "modules.0.memories.0.type", "modules.0.tables.0.type", "modules.0.globals.0.type", "modules.0.globals.0.initializer", "linkGraph", "resources", "resources.memory", "resources.table", "resources.threads", "resources.io", "resources.lifecycle", "provenance", "provenance.record"];
  for (const path of paths) {
    const changed = fixture(); const target = path ? path.split(".").reduce((o, k) => o[k], changed) : changed;
    target.surprise = true;
    assert(!authority.validateManifest(canonicalJson(changed)).ok, path);
  }
  assert(!authority.validateManifest(canonicalJson({ ...m, executables: [] })).ok);
  assert(!authority.validateManifest(canonicalJson(m).replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2')).ok);
  assert(!authority.validateManifest(` ${canonicalJson(m)}`).ok);
});
Deno.test("emscripten manifest: repinned operation digest cannot hide malformed shape, runtime or resource claims", () => {
  const mutations = [
    (m: any) => m.runtime.features.push("threads"),
    (m: any) => m.runtime.compiler.version = "6.0.1",
    (m: any) => m.assets[2].path = "extension/wasm/cas/wrong.wasm",
    (m: any) => m.assets[0].path = "../adapter.mjs",
    (m: any) => m.entry.operations[0].params[0].minimum = 1000001,
    (m: any) => m.entry.operations[0].io.kind = "filesystem",
    (m: any) => m.resources.threads.mode = "pthreads",
    (m: any) => m.build.reproducible = true,
    (m: any) => m.provenance.hermeticReprovisioned = true,
    (m: any) => m.modules[0].globals[0].initializer.value = 2147483648,
    (m: any) => m.modules[0].memories[0].type.address = "i64",
    (m: any) => m.modules[0].exports[0].type.results.push("f64"),
  ];
  for (const mutate of mutations) {
    const m = fixture(); mutate(m);
    const { profileDigest: _, ...profile } = m.runtime; m.runtime.profileDigest = hash(profile);
    m.tools[0].digest = hash(m.entry.operations[0]);
    assert(!authority.validateManifest(canonicalJson(m)).ok, String(mutate));
  }
});
Deno.test("emscripten manifest: graph and operation identities are content-bound, never a version surrogate", () => {
  const original = fixture(); const identity = emscriptenIdentity(original);
  const fields = ["runtime", "assets", "entry", "modules", "linkGraph", "resources", "provenance"];
  for (const field of fields) {
    const m = fixture();
    // Digest algebra is tested independently of schema/eligibility: a changed
    // subtree must never be omitted from the epoch identity projection.
    m[field] = { changed: m[field] };
    if (field === "entry") m.entry.operations = original.entry.operations;
    const changed = emscriptenIdentity(m);
    assert(changed.graphDigest !== identity.graphDigest, field);
    assert(changed.capabilityDigest !== identity.capabilityDigest, field);
    assertEquals(m.package.version, original.package.version);
  }
  const m = fixture(); m.entry.operations[0].params[0].maximum = 10;
  assert(emscriptenIdentity(m).operationDigests[0].digest !== identity.operationDigests[0].digest);
  m.provenance.record.sha256 = "e".repeat(64);
  assert(emscriptenIdentity(m).graphDigest !== identity.graphDigest);
  const onlyVersion = fixture(); onlyVersion.package.version = "2.0.0";
  assertEquals(emscriptenIdentity(onlyVersion), identity);
});
function sidecar(): any {
  const pin = { name: "shape", source: "shape/source.txt", revision: "shape-only", sha256: "a".repeat(64), size: 1 };
  return { format: "cap-emscripten-admission-provenance-v1", toolchain: [pin], sources: [{ ...pin, revision: `sha256:${pin.sha256}` }], dependencies: [], patches: [], buildScript: pin, argv: ["shape-only"], environment: { SOURCE_DATE_EPOCH: "0" }, outputAssets: ["adapter", "glue", "main"], comparison: { kind: "same-sdk-byte-identical", buildA: pin, buildB: pin, hermeticReprovisioned: false, assets: ["glue", "main"] } };
}
Deno.test("emscripten provenance: comparison scope excludes new adapter, is closed and binds graph identity through sidecar hash", () => {
  const m = fixture(); const p = sidecar();
  assertEquals(validateEmscriptenProvenance(canonicalJson(p), m), p);
  for (const scope of [undefined, [], ["glue"], ["glue", "main", "unknown"], ["glue", "glue", "main"], ["main", "glue"], ["adapter", "glue", "main"]]) {
    const changed = sidecar(); if (scope === undefined) delete changed.comparison.assets; else changed.comparison.assets = scope;
    assertThrows(() => validateEmscriptenProvenance(canonicalJson(changed), m));
    assert(hash(changed) !== hash(p));
    const changedManifest = fixture(); changedManifest.provenance.record.sha256 = hash(changed);
    const baseline = fixture(); baseline.provenance.record.sha256 = hash(p);
    assert(emscriptenIdentity(changedManifest).graphDigest !== emscriptenIdentity(baseline).graphDigest);
  }
  for (const path of ["", "toolchain.0", "sources.0", "buildScript", "environment", "comparison", "comparison.buildA", "comparison.buildB"]) {
    const changed = sidecar(); const target = path ? path.split(".").reduce((o, k) => o[k], changed) : changed; target.extra = true;
    assertThrows(() => validateEmscriptenProvenance(canonicalJson(changed), m));
  }
  const missingOutput = sidecar(); missingOutput.outputAssets.pop();
  assertThrows(() => validateEmscriptenProvenance(canonicalJson(missingOutput), m));
  const wrongSource = sidecar(); wrongSource.sources[0].revision = "historical-build";
  assertThrows(() => validateEmscriptenProvenance(canonicalJson(wrongSource), m));
});
