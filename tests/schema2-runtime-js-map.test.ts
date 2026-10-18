// tiwpa: one byte-exact schema-2 JS map feeds build and Store ZIP admission.
// Fixtures are in memory: no mutable repo/dist inputs and no serial gate cost.
// @ts-nocheck
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createHash } from "node:crypto";
import { canonicalJson, WasmPackageAuthority } from "../extension/lib/wasm-package-authority.js";
import { sha256Hex } from "../extension/lib/pure.js";
import { buildSchema2RuntimeJsMap } from "../scripts/lib/wasm-manifest-assets.mjs";

const hash = (v) => sha256Hex(canonicalJson(v));
const bytes = (v) => new TextEncoder().encode(v);
const pin = (b) => createHash("sha256").update(b).digest("hex");
const A = "extension/wasm/runtime/shape/1.0.0/adapter.mjs";
const G = "extension/wasm/runtime/shape/1.0.0/glue.mjs";
const ADAPTER = bytes("export const adapter = true;\n");
const GLUE = bytes("export const instantiate = WebAssembly.instantiate;\n");

function fixture() {
  const capabilities = ["compute"];
  const op = { id: "weighted_sum", toolId: "weighted_sum", kind: "native-scalar-v1", exportName: "cap_weighted_sum", params: ["value", "weight", "bias"].map(name => ({ name, type: "f64", minimum: -1000000, maximum: 1000000 })), result: "f64", capabilities, replayClass: "read-only", io: { kind: "none" } };
  const runtime = { kind: "emscripten-module-v1", abi: "emscripten-6.0.0-thin-native-v1", compiler: { version: "6.0.0", emsdkCommit: "d223ae73c6998296e3ab27cf81dc2c2c9fd383de", emscriptenCommit: "afa15e0c56d1292e073c2c91bafc1d5e0cdf0dd3" }, glue: { format: "es-module-factory", environment: "worker", dynamicExecution: false, filesystem: false }, features: [] };
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
      { id: "adapter", role: "adapter", path: A, sha256: pin(ADAPTER), size: ADAPTER.length },
      { id: "glue", role: "glue", path: G, sha256: pin(GLUE), size: GLUE.length },
      { id: "main", role: "main-wasm", path: `extension/wasm/cas/${"c".repeat(64)}.wasm`, sha256: "c".repeat(64), size: 3 },
    ],
    entry: { adapterId: "cap-a0-numeric-v1", adapterAsset: "adapter", glueAsset: "glue", mainAsset: "main", operations: [op] },
    modules: [{ asset: "main", imports: [], exports: [{ name: "cap_weighted_sum", kind: "function", index: 0, type: { params: ["f64", "f64", "f64"], results: ["f64"] } }], memories: [{ index: 0, type: { address: "i32", shared: false, min: 256, max: 256 } }], tables: [{ index: 0, type: { element: "funcref", min: 1, max: 1 } }], globals: [{ index: 0, type: { value: "i32", mutable: true }, initializer: { op: "i32.const", value: 66560 } }], tags: [], start: null, dylink: null }],
    linkGraph: { policy: "none", main: "main", dependencies: [] },
    resources: { class: "em32-unshared-fixed-16", memory: { owner: "main", index: 0, initialPages: 256, maxPages: 256, growth: false }, table: { owner: "main", index: 0, initialElements: 1, maxElements: 1, growth: false }, threads: { mode: "none" }, io: { filesystem: "none", network: false, clock: false, random: false }, lifecycle: { freshInstance: true, startupMs: 10000, callMs: 30000, concurrentJobs: 1 } },
    provenance: { record: { path: "shape/provenance.json", sha256: "d".repeat(64), size: 10 }, comparison: "same-sdk-byte-identical", hermeticReprovisioned: false },
  };
}

function setup() {
  const manifest = fixture();
  const rel = `extension/wasm/manifests/${manifest.package.id}-${manifest.package.version}.manifest.json`;
  const manifestBytes = bytes(canonicalJson(manifest));
  const inventory = {
    manifests: [{ pkg: manifest.package.id, version: manifest.package.version, digest: new WasmPackageAuthority().manifestDigest(manifest) }],
    files: [
      { rel, sha256: pin(manifestBytes), size: manifestBytes.length },
      { rel: A, sha256: pin(ADAPTER), size: ADAPTER.length },
      { rel: G, sha256: pin(GLUE), size: GLUE.length },
    ],
  };
  const byRel = new Map([[rel, manifestBytes], [A, ADAPTER], [G, GLUE]]);
  // In-memory TEST anchors model separate human-reviewed source records. The
  // production table has real source commits and bead IDs, never these mocks.
  const reviewedSources = Object.fromEntries([
    [A, "adapter", ADAPTER], [G, "glue", GLUE],
  ].map(([path, role, content]) => [path.slice("extension/".length), {
    packageId: manifest.package.id, version: manifest.package.version, role,
    sha256: pin(content), size: content.length, sourceCommit: "f".repeat(40),
    sourcePath: "packages/bundled/evidence/test/fixture.mjs", reviewBead: "chrome-agent-platform-testfixture",
  }]));
  const state = { manifest, rel, inventory, byRel, reviewedSources,
    readBytes: async (path) => { if (!byRel.has(path)) throw new Error(`missing: ${path}`); return byRel.get(path); } };
  state.check = () => buildSchema2RuntimeJsMap(state.inventory, { readBytes: state.readBytes, reviewedSources: state.reviewedSources });
  return state;
}

Deno.test("tiwpa: manifest + inventory + exact bytes admit only reviewed runtime JS", async () => {
  const s = setup();
  const map = await s.check();
  assertEquals([...map], [
    [A.slice("extension/".length), { role: "adapter", size: ADAPTER.length, sha256: pin(ADAPTER) }],
    [G.slice("extension/".length), { role: "glue", size: GLUE.length, sha256: pin(GLUE) }],
  ]);
});

Deno.test("tiwpa: mutated, partially repinned, duplicate or unlisted runtime JS fails closed", async () => {
  const mutated = setup();
  mutated.byRel.set(G, bytes("export const instantiate = WebAssembly.compile;\n"));
  await assertRejects(() => mutated.check(), Error, "runtime JS byte drift");

  const repinned = setup();
  const manifest = structuredClone(repinned.manifest);
  manifest.assets[1].sha256 = pin(bytes("unreviewed glue"));
  const manifestBytes = bytes(canonicalJson(manifest));
  repinned.byRel.set(repinned.rel, manifestBytes);
  repinned.inventory.files[0].sha256 = pin(manifestBytes);
  repinned.inventory.files[0].size = manifestBytes.length;
  repinned.inventory.manifests[0].digest = new WasmPackageAuthority().manifestDigest(manifest);
  await assertRejects(() => repinned.check(), Error, "runtime JS inventory pin drift");

  const dualRepin = setup();
  const unreviewedBytes = bytes("export const instantiate = WebAssembly.compile;\n");
  const amended = structuredClone(dualRepin.manifest);
  amended.assets[1].sha256 = pin(unreviewedBytes);
  amended.assets[1].size = unreviewedBytes.length;
  const amendedManifest = bytes(canonicalJson(amended));
  dualRepin.byRel.set(dualRepin.rel, amendedManifest);
  dualRepin.byRel.set(G, unreviewedBytes);
  dualRepin.inventory.files[0].sha256 = pin(amendedManifest);
  dualRepin.inventory.files[0].size = amendedManifest.length;
  dualRepin.inventory.files[2].sha256 = pin(unreviewedBytes);
  dualRepin.inventory.files[2].size = unreviewedBytes.length;
  dualRepin.inventory.manifests[0].digest = new WasmPackageAuthority().manifestDigest(amended);
  await assertRejects(() => dualRepin.check(), Error, "runtime JS review anchor missing or drifted",
    "repinning BOTH manifest and inventory in a new tree must not create a review anchor");

  const unlisted = setup();
  unlisted.inventory.files.push({ rel: "extension/wasm/runtime/shape/1.0.0/stray.mjs", sha256: pin(GLUE), size: GLUE.length });
  await assertRejects(() => unlisted.check(), Error, "unlisted runtime JS inventory row");

  const duplicate = setup();
  const other = structuredClone(duplicate.manifest);
  other.package.id = "org.example.second";
  const rel = `extension/wasm/manifests/${other.package.id}-${other.package.version}.manifest.json`;
  const otherBytes = bytes(canonicalJson(other));
  duplicate.byRel.set(rel, otherBytes);
  duplicate.inventory.files.push({ rel, sha256: pin(otherBytes), size: otherBytes.length });
  duplicate.inventory.manifests.push({ pkg: other.package.id, version: other.package.version, digest: new WasmPackageAuthority().manifestDigest(other) });
  await assertRejects(() => duplicate.check(), Error, "duplicate runtime JS asset mapping");
});
