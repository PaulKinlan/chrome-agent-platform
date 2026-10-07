// chrome-agent-platform-ltkj.2 — acceptance fixture builder contract.
//
// The builder selects ONLY tracked, source-reviewed A0 numeric pins and emits
// the real schema-2 manifest + assets. This test pins:
//   - determinism: every emitted digest is a reviewed constant (a pin change
//     anywhere in the chain — evidence bytes, adapter source, sidecar shape,
//     SBOM, canonicalization — fails here deliberately);
//   - truthful-by-construction: the module declaration re-audits against the
//     real bytes through the REAL graph audit + numeric eligibility;
//   - fail-closed falsification: one mutated byte in any emitted asset is
//     refused by the same authority chain admission will run;
//   - validation-only surface: no executable catalog row, no admission grant;
//   - default-tree vacuity: the reviewed tree ships no JS under extension/wasm
//     (the acceptance lane is build-time only and never lands in a release).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { buildNumericAcceptancePackage, NUMERIC_ACCEPTANCE_PINS } from "../scripts/lib/emscripten-numeric-acceptance.mjs";
import {
  validateEmscriptenManifest,
  validateEmscriptenProvenance,
  assertEmscriptenNumericEligibility,
} from "../extension/lib/emscripten-manifest.js";
import { auditEmscriptenGraph, auditEmscriptenModule } from "../extension/lib/emscripten-module-audit.js";

const root = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

Deno.test("acceptance fixture: emitted digests are the reviewed deterministic pins", async () => {
  const out = await buildNumericAcceptancePackage();
  // Manifest / graph identity — content-addressed over the measured module.
  assertEquals(out.manifestDigest, "97621e5e889b272b79b7e0723a7f5b94254ac187be2cd896e02a35a3a2119343");
  assertEquals(out.identity.graphDigest, "00544d07c39c5cee8473217ef1472d19dc8e0e60f36c3cbef4eb9f63833e7771");
  assertEquals(out.identity.capabilityDigest, "097ef6d577274b7fce277b80a73ff44acc9067063e29d41de9b94dac706caab6");
  assertEquals(out.identity.operationDigests.length, 1);
  assertEquals(out.identity.operationDigests[0].id, "weighted_sum");
  // Sidecar / SBOM / evidence pins.
  assertEquals(out.digests.sidecar, "c7071627233396bd6a0cfd503712c345ae5f875ffa3283772af5b0390c58cca2");
  assertEquals(out.digests.sbom, "686138f6a12224c3558f4d46dde61a1282c6c8db487999060a7d239da727b1bc");
  assertEquals(out.digests.adapter, NUMERIC_ACCEPTANCE_PINS.adapter.sha256);
  assertEquals(out.digests.glue, NUMERIC_ACCEPTANCE_PINS.glue.sha256);
  assertEquals(out.digests.main, NUMERIC_ACCEPTANCE_PINS.main.sha256);
  // Inventory manifests row (no descriptor/catalog row exists in the output).
  assertEquals(out.inventoryManifestRow, {
    pkg: "cap.acceptance.a0.numeric",
    version: "1.0.0",
    digest: out.manifestDigest,
  });
  // Exactly six shipped files; none of them a catalog/descriptor data module.
  const rels = out.files.map((f) => f.rel).sort();
  assertEquals(rels, [
    "extension/wasm/cas/fea83472b7e56292785f132d0c5f564048cf34ae047627334f504b28dd405503.wasm",
    "extension/wasm/manifests/cap.acceptance.a0.numeric-1.0.0.manifest.json",
    "extension/wasm/provenance/cap.acceptance.a0.numeric-1.0.0.json",
    "extension/wasm/runtime/cap_acceptance_a0_numeric/1.0.0/adapter.mjs",
    "extension/wasm/runtime/cap_acceptance_a0_numeric/1.0.0/glue.mjs",
    "extension/wasm/sbom/cap.acceptance.a0.numeric.cdx.json",
  ]);
  assert(!rels.some((rel) => rel.includes("bundled-tool-packages.data")), "no executable catalog row may be emitted");
});

Deno.test("acceptance fixture: manifest re-validates through the real schema-2 chain", async () => {
  const out = await buildNumericAcceptancePackage();
  const manifest = out.manifest;
  // Structural validation (throws on any drift).
  validateEmscriptenManifest(manifest);
  // Provenance sidecar against the manifest.
  const sidecarFile = out.files.find((f) => f.rel === NUMERIC_ACCEPTANCE_PINS.sidecarRel);
  assert(sidecarFile, "sidecar must be emitted");
  const sidecar = validateEmscriptenProvenance(new TextDecoder().decode(sidecarFile!.bytes), manifest);
  // Comparison scope names exactly the historical glue + main; the newly
  // authored adapter is pinned through `sources` with a content-addressed
  // revision instead (scoped-comparison clarification).
  assertEquals(sidecar.comparison.assets, ["glue", "main"]);
  assertEquals(sidecar.comparison.kind, "same-sdk-byte-identical");
  assertEquals(sidecar.comparison.hermeticReprovisioned, false);
  assertEquals(sidecar.comparison.buildA.sha256, sidecar.comparison.buildB.sha256);
  const adapterPin = sidecar.sources.find((s: { name: string }) => s.name === "cap-a0-numeric-v1.mjs");
  assert(adapterPin, "adapter source pin required");
  assertEquals(adapterPin!.revision, `sha256:${NUMERIC_ACCEPTANCE_PINS.adapter.sha256}`);
  assertEquals(sidecar.environment, { SOURCE_DATE_EPOCH: NUMERIC_ACCEPTANCE_PINS.sourceDateEpoch });
  // Graph audit over the exact emitted bytes + numeric eligibility.
  const fileMap = new Map(out.files.filter((f) => manifest.assets.some((a: { path: string }) => a.path === f.rel)).map((f) => [f.rel, f.bytes]));
  assertEquals(fileMap.size, 3);
  const graph = await auditEmscriptenGraph(
    { assets: manifest.assets, modules: manifest.modules, linkGraph: manifest.linkGraph },
    fileMap,
  );
  assertEmscriptenNumericEligibility(manifest, graph);
  // The measured declaration matches a fresh audit of the real main bytes.
  const mainFile = out.files.find((f) => f.rel.startsWith("extension/wasm/cas/"));
  const rescan = auditEmscriptenModule(mainFile!.bytes);
  const { features: _features, ...measured } = rescan;
  const declared = { ...manifest.modules[0] };
  delete (declared as Record<string, unknown>).asset;
  assertEquals(declared.imports, measured.imports);
  assertEquals(declared.exports, measured.exports);
  assertEquals(declared.memories, measured.memories);
  assertEquals(declared.tables, measured.tables);
  assertEquals(declared.globals, measured.globals);
  assertEquals(rescan.features, []);
});

Deno.test("acceptance fixture hostile: one mutated asset byte is refused by the same chain", async () => {
  const out = await buildNumericAcceptancePackage();
  const manifest = out.manifest;
  const fileMap = new Map(
    out.files
      .filter((f) => manifest.assets.some((a: { path: string }) => a.path === f.rel))
      .map((f) => [f.rel, f.bytes.slice()]),
  );
  // Mutate exactly one byte of the main Wasm (a data-segment byte, past the
  // 8-byte header, keeping the file the same length).
  const casRel = [...fileMap.keys()].find((k) => k.startsWith("extension/wasm/cas/"))!;
  const mainBytes = fileMap.get(casRel)!;
  mainBytes[mainBytes.byteLength - 3] ^= 0xff;
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

Deno.test("acceptance fixture hostile: mutated sidecar text is refused", async () => {
  const out = await buildNumericAcceptancePackage();
  const sidecarFile = out.files.find((f) => f.rel === NUMERIC_ACCEPTANCE_PINS.sidecarRel)!;
  const tampered = new TextDecoder().decode(sidecarFile.bytes).replace('"cap-emscripten-admission-provenance-v1"', '"cap-emscripten-admission-provenance-v2"');
  let caught: unknown = null;
  try {
    validateEmscriptenProvenance(tampered, out.manifest);
  } catch (error) {
    caught = error;
  }
  assert(caught, "tampered sidecar must be refused");
});

Deno.test("default tree vacuity: no JS ships under extension/wasm and no schema-2 manifests exist", async () => {
  // The acceptance lane is build-time only; the reviewed tree must stay free of
  // schema-2 candidates and of any JS asset under the package store (which the
  // reachability gate excludes as generated data).
  const inventoryData = await import("../extension/lib/bundled-inventory-data.js");
  const inventory = (inventoryData as { BUNDLED_INVENTORY: { manifests: { pkg: string; version: string }[]; files: { rel: string }[] } }).BUNDLED_INVENTORY;
  for (const row of inventory.manifests) {
    const text = await Deno.readTextFile(root(`extension/wasm/manifests/${row.pkg}-${row.version}.manifest.json`));
    const parsed = JSON.parse(text);
    assertNotEquals(parsed.schemaVersion, 2, `${row.pkg} must not be schema-2 in the default tree`);
  }
  for (const file of inventory.files) {
    assert(!/^extension\/wasm\/.*\.(m?js)$/u.test(file.rel), `default inventory ships JS under the package store: ${file.rel}`);
  }
  // And physically: walk extension/wasm recursively for JS/MJS.
  async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) await walk(`${dir}/${entry.name}`);
      else assert(!entry.name.endsWith(".mjs") && !entry.name.endsWith(".js"), `stray JS in the package store: ${dir}/${entry.name}`);
    }
  }
  await walk(root("extension/wasm"));
});
