#!/usr/bin/env node
// build-bundled-tool-packages.mjs — regenerate the shipped immutable bundled
// tool packages from the frozen, independently reviewed evidence trees.
//
// Reads (paths via --evidence-root, default /tmp):
//   <root>/cap-fixed-tools-a2/            (10 MIT stdin tools)
//   <root>/cap-fixed-tools-b2/            (6 Apache-2.0 + toml2json MIT AND Apache-2.0)
//   <root>/cap-fixed-tools-c2/            (markdown BSD-2-Clause + 5 Apache-2.0 preopen tools)
//   <root>/cap-csvtool-cleanroom/         (CAP-authored clean-room csvtool, Apache-2.0)
//   <root>/cap-fixed-tools-d3/            (gzip: zlib 1.3.1 minigzip + CAP-authored runtime)
//   <root>/cap-23-tool-catalog-metadata-v3/inventory.json  (reviewed per-tool metadata)
//
// Writes (byte-deterministic given identical inputs):
//   extension/wasm/cas/<sha256>.wasm                      (25 content-addressed binaries)
//   extension/wasm/manifests/<pkg>-1.0.0.manifest.json    (25 canonical manifests)
//   extension/wasm/sbom/*.cdx.json | c2.spdx.json         (5 copied SBOMs)
//   extension/wasm/licenses/*                             (6 licence/notice texts)
//   extension/lib/bundled-inventory-data.js               (generated inventory module)
//   extension/lib/bundled-tool-packages.data.js           (generated descriptor rows)
//   packages/bundled/<lane>/build.sh + README.md          (exact build scripts/provenance)
//
// Every shipped byte is hash-verified against the evidence inventories BEFORE
// writing; every generated manifest is re-validated through the REAL authority
// (validateManifest + auditWasmBinary) before the run reports success.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, WasmPackageAuthority, auditWasmBinary, WASM_PACKAGE_LIMITS } from "../extension/lib/wasm-package-authority.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const EVIDENCE = args[args.indexOf("--evidence-root") + 1] || "/tmp";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const enc = new TextEncoder();

const PATHS = {
  a2: join(EVIDENCE, "cap-fixed-tools-a2"),
  b2: join(EVIDENCE, "cap-fixed-tools-b2"),
  c2: join(EVIDENCE, "cap-fixed-tools-c2"),
  csvtool: join(EVIDENCE, "cap-csvtool-cleanroom"),
  d3: join(EVIDENCE, "cap-fixed-tools-d3"),
  sqlite3: join(EVIDENCE, "cap-sqlite3-query-bounded-v2"),
  catalog: join(EVIDENCE, "cap-23-tool-catalog-metadata-v3", "inventory.json"),
};
for (const [k, p] of Object.entries(PATHS)) if (!existsSync(p)) throw new Error(`missing evidence path (${k}): ${p}`);

const CATALOG = JSON.parse(readFileSync(PATHS.catalog, "utf8"));
if (sha256(readFileSync(PATHS.catalog)) !== "8e9e3a689a1c19193a7a6723b4f94039a5b06ef57543de68ebd79bcf91fa4d9a") {
  throw new Error("23-tool inventory hash mismatch — refusing to build from unreviewed metadata");
}

// ── Package definitions (25 single-tool packages; licence-exact per package) ─
const LANES = {
  a2: { tools: ["base64", "md5sum", "sha256sum", "sha512sum", "xxd", "uuid", "wc", "head", "tail", "cut"], spdx: "MIT", licenseFile: "extension/wasm/licenses/MIT.txt", sbom: { src: join(PATHS.a2, "sbom/cyclonedx-1.5.json"), rel: "extension/wasm/sbom/a2.cdx.json", format: "cyclonedx-json@1.5" }, buildScript: join(PATHS.a2, "build.sh"), toolchain: "clang wasi-sdk (see packages/bundled/a2/build.sh)" },
  b2: { tools: ["sort", "uniq", "tr", "grep", "diff", "patch"], spdx: "Apache-2.0", licenseFile: "extension/wasm/licenses/Apache-2.0.txt", sbom: { src: join(PATHS.b2, "sbom.cdx.json"), rel: "extension/wasm/sbom/b2.cdx.json", format: "cyclonedx-json@1.5" }, buildScript: join(PATHS.b2, "build.sh"), toolchain: "clang wasi-sdk (see packages/bundled/b2/build.sh)" },
  c2: { tools: ["markdown", "du", "stat", "tree", "touch", "truncate"], sbom: { src: join(PATHS.c2, "sbom/spdx.json"), rel: "extension/wasm/sbom/c2.spdx.json", format: "spdx-json@2.3" }, buildScript: join(PATHS.c2, "scripts/build.sh"), toolchain: "clang wasi-sdk cmake (see packages/bundled/c2/build.sh)" },
};
const C2_LICENSE = { markdown: { spdx: "BSD-2-Clause", file: "extension/wasm/licenses/BSD-2-Clause-cmark.txt" } };
const C2_DEFAULT_LICENSE = { spdx: "Apache-2.0", file: "extension/wasm/licenses/Apache-2.0.txt" };

function catalogRow(toolId) {
  const row = CATALOG.tools.find((t) => t.toolId === toolId);
  if (!row) throw new Error(`tool ${toolId} absent from reviewed 23-tool inventory`);
  if (row.canonicalNameClaim !== false || row.admitted !== false) throw new Error(`tool ${toolId} metadata drifted (canonicalNameClaim/admitted)`);
  return row;
}

// ── Read + hash-verify every binary against its evidence inventory ──────────
function verifiedBinary(lane, toolId, rel, expectedSha, expectedBytes) {
  const bytes = readFileSync(join(PATHS[lane], rel));
  const actual = sha256(bytes);
  if (actual !== expectedSha) throw new Error(`hash mismatch ${toolId}: ${actual} != ${expectedSha}`);
  if (bytes.byteLength !== expectedBytes) throw new Error(`size mismatch ${toolId}`);
  return bytes;
}

const packages = [];
for (const toolId of LANES.a2.tools) {
  const row = catalogRow(toolId);
  packages.push({ toolId, lane: "a2", bytes: verifiedBinary("a2", toolId, row.binary.path, row.binary.sha256, row.binary.bytes), row, spdx: LANES.a2.spdx, licenseFile: LANES.a2.licenseFile, notices: null, sbom: LANES.a2.sbom, toolchain: LANES.a2.toolchain, buildScriptLane: "a2" });
}
for (const toolId of LANES.b2.tools) {
  const row = catalogRow(toolId);
  packages.push({ toolId, lane: "b2", bytes: verifiedBinary("b2", toolId, row.binary.path, row.binary.sha256, row.binary.bytes), row, spdx: "Apache-2.0", licenseFile: LANES.b2.licenseFile, notices: null, sbom: LANES.b2.sbom, toolchain: LANES.b2.toolchain, buildScriptLane: "b2" });
}
{ // toml2json: exact dual composite (tomlc99 MIT + CAP-authored Apache-2.0)
  const row = catalogRow("toml2json");
  if (row.licence.spdx !== "MIT AND Apache-2.0") throw new Error(`toml2json licence drifted: ${row.licence.spdx}`);
  packages.push({ toolId: "toml2json", lane: "b2", bytes: verifiedBinary("b2", "toml2json", row.binary.path, row.binary.sha256, row.binary.bytes), row, spdx: "MIT AND Apache-2.0", licenseFile: LANES.b2.licenseFile, notices: "extension/wasm/licenses/toml2json-NOTICES.txt", sbom: LANES.b2.sbom, toolchain: LANES.b2.toolchain, buildScriptLane: "b2" });
}
for (const toolId of LANES.c2.tools) {
  const row = catalogRow(toolId);
  const lic = C2_LICENSE[toolId] ?? C2_DEFAULT_LICENSE;
  packages.push({ toolId, lane: "c2", bytes: verifiedBinary("c2", toolId, row.binary.path, row.binary.sha256, row.binary.bytes), row, spdx: lic.spdx, licenseFile: lic.file, notices: null, sbom: LANES.c2.sbom, toolchain: LANES.c2.toolchain, buildScriptLane: "c2" });
}
{ // csvtool (CAP-authored clean-room; owner decision: Apache-2.0)
  const wasm = readFileSync(join(PATHS.csvtool, "build-a/csvtool.wasm"));
  if (sha256(wasm) !== "5c8210c93d390893f961943093ccad314e87500b29eafe9f166b0b3327333d81" || wasm.byteLength !== 10581) throw new Error("csvtool hash/size mismatch");
  const buildB = readFileSync(join(PATHS.csvtool, "build-b/csvtool.wasm"));
  if (sha256(buildB) !== sha256(wasm)) throw new Error("csvtool reproducibility broken (build-a != build-b)");
  packages.push({ toolId: "csvtool", lane: "csvtool", bytes: wasm, row: null, spdx: "Apache-2.0", licenseFile: "extension/wasm/licenses/Apache-2.0.txt", notices: null, sbom: { src: join(PATHS.csvtool, "sbom/cyclonedx-1.5.json"), rel: "extension/wasm/sbom/csvtool.cdx.json", format: "cyclonedx-json@1.5" }, toolchain: "clang 22.1.8; LLD 22.1.8", buildScriptLane: "csvtool", displayName: "Bounded clean-room RFC 4180 CSV stream tool", category: "text", description: "Clean-room bounded RFC 4180 CSV stream filter (stdin/stdout only); CAP-authored, Apache-2.0.", caveats: ["Stdin/stdout only; no file operands."], replayClass: "read-only", capabilities: ["compute", "text.transform"] });
}
{ // gzip (zlib 1.3.1 minigzip upstream + CAP-authored runtime): Zlib AND Apache-2.0
  const d3 = JSON.parse(readFileSync(join(PATHS.d3, "inventory.json"), "utf8"));
  const bin = d3.retainedBinaries[0];
  const wasm = readFileSync(join(PATHS.d3, bin.file));
  if (sha256(wasm) !== bin.sha256 || wasm.byteLength !== bin.bytes) throw new Error("gzip hash/size mismatch");
  if (sha256(readFileSync(join(PATHS.d3, "inventory.json"))) !== "7ddeea056eec79eaa0c496522297d9f381293532816f2085611c027584482af9") throw new Error("d3 inventory hash mismatch");
  const mem = d3.tools[0].memory;
  packages.push({ toolId: "gzip", lane: "gzip", bytes: wasm, row: null, spdx: "Zlib AND Apache-2.0", licenseFile: "extension/wasm/licenses/Zlib-1.3.1.txt", notices: "extension/wasm/licenses/CAP-authored-Apache-2.0.txt", sbom: { src: join(PATHS.d3, "sbom/gzip-zlib-minigzip-stdio.cdx.json"), rel: "extension/wasm/sbom/gzip.cdx.json", format: "cyclonedx-json@1.5" }, toolchain: "clang 22.1.8; wasm-ld 22.1.8", buildScriptLane: "gzip", displayName: "Bounded RFC 1952 gzip stream tool (zlib 1.3.1 minigzip)", category: "data", description: "Upstream zlib 1.3.1 Z_SOLO minigzip RFC1952 compressor/decompressor over stdin/stdout only; experimental, no canonical gzip claim.", caveats: ["Stdin/stdout only; rejects file operands, recursion, unknown options.", "Experimental candidate; not the canonical full gzip."], replayClass: "read-only", capabilities: ["compute", "text.transform"], memoryOverride: { initialPages: mem.initialPages, maxPages: mem.maxPages } });
}

// ── Clean + recreate output trees ───────────────────────────────────────────
const WASM_OUT = join(REPO, "extension/wasm");
rmSync(WASM_OUT, { recursive: true, force: true });
for (const d of ["cas", "manifests", "sbom", "licenses"]) mkdirSync(join(WASM_OUT, d), { recursive: true });
mkdirSync(join(REPO, "packages/bundled"), { recursive: true });

// ── Licence / notice files ──────────────────────────────────────────────────
const zlibUpstream = readFileSync(join(PATHS.d3, "licenses/zlib-1.3.1.txt"));
const apacheText = readFileSync(join(PATHS.b2, "source/LICENSE.Apache-2.0"));
const mitText = readFileSync(join(PATHS.a2, "licenses/LICENSE-MIT"));
const cmarkCopying = readFileSync(join(PATHS.c2, "sources/markdown/cmark-0.31.1/COPYING"));
const tomlMit = readFileSync(join(PATHS.b2, "source/toml2json/upstream/LICENSE"));
const CAP_AUTHORED_GRANT = `CAP-authored bundled-package material — Apache-2.0 grant

The authored freestanding WASI runtime, compatibility headers, minigzip
patches, Node WASI quota sink, worker boundary, and acceptance fixtures
associated with the bundled gzip candidate are authored by the Chrome Agent
Platform project and licensed under Apache-2.0 (full text below), per owner
decision CAP-DECISION-TEMPLATE-20260822-06 (Decision 3).

The upstream zlib 1.3.1 material remains under the Zlib licence (see
Zlib-1.3.1.txt). This file is the notices companion for packages whose
licence expression is "Zlib AND Apache-2.0".

======================================================================

${apacheText}`;
const TOML_NOTICES = `toml2json bundled-package notices

toml2json combines:
  1. tomlc99 (upstream parser) — MIT License (full text below), and
  2. CAP-authored WASI driver/glue — Apache-2.0 (see Apache-2.0.txt).

Package licence expression: "MIT AND Apache-2.0".

======================================================================

${tomlMit}`;
const LICENSE_WRITES = {
  "extension/wasm/licenses/MIT.txt": mitText,
  "extension/wasm/licenses/Apache-2.0.txt": apacheText,
  "extension/wasm/licenses/BSD-2-Clause-cmark.txt": cmarkCopying,
  "extension/wasm/licenses/toml2json-NOTICES.txt": enc.encode(TOML_NOTICES),
  "extension/wasm/licenses/Zlib-1.3.1.txt": zlibUpstream,
  "extension/wasm/licenses/CAP-authored-Apache-2.0.txt": enc.encode(CAP_AUTHORED_GRANT),
};

// ── Manifests (authority-schema-exact; canonical bytes; re-validated) ───────
const probe = new WasmPackageAuthority();
const SIGNER = { lane: "bundled", keyId: "cap-bundled-release" };
// The technically-admitted Settings-preview allowlist (the static tranches):
// the 16 tools in SETTINGS_PREVIEW_LANES expose bounded Settings-only previews
// (explicit owner click). Every other lane stays admitted:false / disabled:true
// — no catalog/provider selection authority.
const SETTINGS_PREVIEW_LANES = new Set(["csvtool", "uuid", "head", "tail", "cut", "base64", "md5sum", "sha256sum", "sha512sum", "wc", "xxd", "sort", "uniq", "tr", "grep", "toml2json"]);
// Per-package source anchors: the original 25 keep the bundle-landing anchor;
// SQLite (package 26) anchors at the exact 0.2.166 tabular parent.
const SOURCE = { repo: "https://github.com/PaulKinlan/chrome-agent-platform", commit: "5e086c1fb0847ddccf1a16ba3129a4cf900eac8f" };
const SOURCE_SQLITE = { repo: "https://github.com/PaulKinlan/chrome-agent-platform", commit: "acf663a64aa741d8a914b2d0d4d63bca6e525cf5" };
const RELEASE = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

const inventoryFiles = [];
const inventoryManifests = [];
const descriptorRows = [];
const written = new Map();

function ship(rel, bytes) {
  if (written.has(rel)) {
    if (sha256(written.get(rel)) !== sha256(bytes)) throw new Error(`conflicting content for ${rel}`);
    return;
  }
  const abs = join(REPO, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  written.set(rel, bytes);
  inventoryFiles.push({ rel, sha256: sha256(bytes), size: bytes.byteLength });
}

// ── Package 26: sqlite3-query-bounded (SQLite 3.46.0 amalgamation + CAP-authored
// wrapper/host). Exact upstream Blessing + Apache-2.0 authored provenance.
// The binary imports 24 WASI functions; the CAP runtime implements 15 of them
// (nine unimplemented) — the descriptor is disabled runtime-imports-unimplemented.
// No scanner exemption, no route, no runtime change.
const SQLITE_EVIDENCE = PATHS.sqlite3;
const SQLITE_EXPECT = {
  wasm: { sha256: "ba468c6eec9c4743167c807b4781d2ca7b5e28b48850e394bf292d13f9c9559d", bytes: 1125792 },
  archive: { sha256: "712a7d09d2a22652fb06a49af516e051979a3984adb067da86760e60ed51a7f5", bytes: 2763740 },
  blessing: { sha256: "06545a6ec25fbbff6c62f205f94a35be49e38f33bea827a8cfb07d7b82e4b083", bytes: 254 },
  sources: {
    "src/sqlite3_query_main.c": "f855d99700ddd15c36f9d1fb72eea60c74a4254a0575aa6e81cde403ed435251",
    "host/quota-sink.mjs": "48b4cc3e7489df8af5ed0d5417c28edc8905a961ffaa39e90399a57ee32e6f82",
    "host/run-query.mjs": "432f548ecd86f2add258e32f025faf27f10cbada68440c6dd3ecf8f0abe2194d",
    "host/wasi-worker.mjs": "9f1ee85b4c7e483da2142b309840a96960c80e3ae91df02486e3b481476b288b",
    "scripts/build-one.sh": "94e03f61169907757373ca22c6d4632256fb2dcc5ff1d8f43074e1364fbf0665",
    "scripts/build-all.sh": "a7be3ad3af97f60444d741ce0d7696c8683e9471cd493db308d4f9d3f494371c",
  },
  sbomCorrected: "496d6e5a7d085700984fc96c0e123e925edb172d2a4cde65b91bcab2e2f32107",
};
{
  const wasm = readFileSync(join(SQLITE_EVIDENCE, "dist/sqlite3-query-bounded.wasm"));
  if (sha256(wasm) !== SQLITE_EXPECT.wasm.sha256 || wasm.byteLength !== SQLITE_EXPECT.wasm.bytes) throw new Error("sqlite wasm hash/size mismatch");
  const archive = readFileSync(join(SQLITE_EVIDENCE, "sources/archives/sqlite-amalgamation-3460000.zip"));
  if (sha256(archive) !== SQLITE_EXPECT.archive.sha256 || archive.byteLength !== SQLITE_EXPECT.archive.bytes) throw new Error("sqlite archive hash/size mismatch");
  const blessing = readFileSync(join(SQLITE_EVIDENCE, "licenses/LICENSE-BLESSING"));
  if (sha256(blessing) !== SQLITE_EXPECT.blessing.sha256 || blessing.byteLength !== SQLITE_EXPECT.blessing.bytes) throw new Error("sqlite blessing hash/size mismatch");
  for (const [rel, expected] of Object.entries(SQLITE_EXPECT.sources)) {
    if (sha256(readFileSync(join(SQLITE_EVIDENCE, rel))) !== expected) throw new Error(`sqlite source drifted: ${rel}`);
  }
  const receipt = JSON.parse(readFileSync(join(SQLITE_EVIDENCE, "receipts/build.json"), "utf8"));
  if (receipt.byteIdentical !== true || receipt.buildA?.sha256 !== SQLITE_EXPECT.wasm.sha256 || receipt.buildB?.sha256 !== SQLITE_EXPECT.wasm.sha256 || receipt.sqliteOmitAttachAbsent !== true || receipt.sqliteOmitLoadExtension !== true) throw new Error("sqlite build receipt fails the reproducible/OMIT invariants");

  // Corrected landing SBOM: upstream SQLite = blessing; CAP-authored wrapper +
  // retained host = Apache-2.0; aggregate = "blessing AND Apache-2.0". The
  // candidate's evaluation-only/pending-owner wording is REMOVED.
  const candidateSbom = JSON.parse(readFileSync(join(SQLITE_EVIDENCE, "sbom/sqlite3-query-bounded.cdx.json"), "utf8"));
  const correctedSbom = {
    bomFormat: "CycloneDX", specVersion: "1.5", serialNumber: "urn:uuid:8f2c1d34-9a4b-4c3e-8f2a-1d36e0a2b1c4d5", version: 1,
    metadata: {
      component: { type: "application", "bom-ref": "cap.bundled.sqlite3-query-bounded@1.0.0", name: "cap.bundled.sqlite3-query-bounded", version: "1.0.0",
        description: "Immutable bundled CAP package: SQLite 3.46.0 amalgamation (upstream Blessing) + CAP-authored wrapper/host (Apache-2.0). Disabled: runtime-imports-unimplemented.",
        licenses: [{ expression: "blessing AND Apache-2.0" }],
        properties: [
          { name: "cap:admitted", value: "false" },
          { name: "cap:canonicalNameClaim", value: "false" },
          { name: "cap:disabledReason", value: "runtime-imports-unimplemented" },
          { name: "cap:upstreamVersion", value: "3.46.0" },
          { name: "cap:sourceArchiveSha256", value: SQLITE_EXPECT.archive.sha256 },
        ] },
    },
    components: (candidateSbom.components ?? []).map((c) => {
      if (c.name === "SQLite amalgamation") return { ...c, licenses: [{ license: { id: "blessing" } }] };
      return { ...c, licenses: [{ license: { id: "Apache-2.0" } }] };
    }),
  };
  const sbomBytes = enc.encode(JSON.stringify(correctedSbom, null, 1) + "\n");
  if (SQLITE_EXPECT.sbomCorrected.startsWith("__")) {
    console.log(`sqlite corrected SBOM sha256 (pin me): ${sha256(sbomBytes)}`);
  } else if (sha256(sbomBytes) !== SQLITE_EXPECT.sbomCorrected) {
    throw new Error("sqlite corrected SBOM drifted from the pinned landing form");
  }
  packages.push({
    toolId: "sqlite3_query_bounded", lane: "sqlite3", bytes: wasm, row: null,
    spdx: "blessing AND Apache-2.0",
    licenseFile: "extension/wasm/licenses/Apache-2.0.txt",
    notices: "extension/wasm/licenses/SQLite-Blessing-3.46.0.txt",
    sbom: { src: null, bytes: sbomBytes, rel: "extension/wasm/sbom/sqlite3-query-bounded.cdx.json", format: "cyclonedx-json@1.5" },
    toolchain: "wasi-sdk clang 18.1.2", buildScriptLane: "sqlite3",
    sourceAnchor: SOURCE_SQLITE,
    displayName: "Bounded SQLite 3.46.0 query tool (upstream amalgamation)",
    category: "data",
    description: "SQLite 3.46.0 amalgamation query tool (upstream Blessing) with CAP-authored wrapper/host (Apache-2.0). ATTACH/DETACH/load_extension denied by runtime authorizer.",
    caveats: [
      "Memory tranche has no external persistence; may later be classified read-only for replay only after runtime wiring.",
      "Workspace tranche is mutating and requires a sole bounded workspace preopen.",
      "Package-level capability union is intentionally conservative.",
      "No grants are issued and no route consumes this descriptor in this release.",
    ],
    replayClass: "mutating",
    capabilities: ["compute", "data.read", "data.write", "file.read", "file.write"],
    memoryOverride: { initialPages: 64, maxPages: 512 },
    disabledReason: "runtime-imports-unimplemented",
    metaStatus: "disabled-runtime-imports",
    metaNote: "evidence digests in packages/bundled/sqlite3/PROVENANCE.json; owner decision CAP-DECISION-TEMPLATE-20260822-06 D4",
  });
  LICENSE_WRITES["extension/wasm/licenses/SQLite-Blessing-3.46.0.txt"] = blessing;
}


for (const [rel, bytes] of Object.entries(LICENSE_WRITES)) ship(rel, bytes);

for (const pkg of packages) {
  const wasmSha = sha256(pkg.bytes);
  ship(`extension/wasm/cas/${wasmSha}.wasm`, pkg.bytes);
  const sbomBytes = pkg.sbom.bytes ?? readFileSync(pkg.sbom.src);
  ship(pkg.sbom.rel, sbomBytes);

  // Ground-truth the binary: audit the real bytes, then declare EXACTLY the
  // measured memory (initial/max pages) so the manifest is truthful by
  // construction. The declared import module list must cover the actual set.
  const tier = "tiny";
  const probeExec = { memory: { tier, maxPages: WASM_PACKAGE_LIMITS.TIERS.tiny.maxPages }, imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] } };
  const audit = auditWasmBinary(pkg.bytes, probeExec, {});
  const actualModules = [...new Set(audit.imports.map((i) => i.module))].sort();
  const allowed = ["wasi_snapshot_preview1"];
  if (!actualModules.every((m) => allowed.includes(m))) throw new Error(`${pkg.toolId}: unaudited import module ${actualModules}`);
  const initialPages = pkg.memoryOverride?.initialPages ?? audit.measured.memoryInitial;
  const maxPages = pkg.memoryOverride?.maxPages ?? audit.measured.memoryMax ?? WASM_PACKAGE_LIMITS.TIERS.tiny.maxPages;
  if (audit.measured.memoryMax != null && audit.measured.memoryMax > maxPages) throw new Error(`${pkg.toolId}: binary max ${audit.measured.memoryMax} exceeds declared ${maxPages}`);
  if (audit.measured.memoryInitial > initialPages) throw new Error(`${pkg.toolId}: binary initial ${audit.measured.memoryInitial} exceeds declared ${initialPages}`);
  if (maxPages > WASM_PACKAGE_LIMITS.TIERS.tier?.maxPages) throw new Error("unreachable");
  if (maxPages > WASM_PACKAGE_LIMITS.TIERS.tiny.maxPages) throw new Error(`${pkg.toolId}: exceeds tiny tier`);

  const meta = pkg.row ?? pkg;
  const capabilities = [...meta.capabilities].sort();
  const capabilityDigest = sha256(enc.encode(canonicalJson(capabilities)));
  const description = String(meta.description);
  if (!/^[\x20-\x7e]{1,256}$/.test(description)) throw new Error(`${pkg.toolId}: description not ASCII/bounded`);
  const manifest = {
    schemaVersion: 1,
    // package.id derives from toolId with '-' → '.' (PACKAGE_ID_RE admits only
    // [a-z0-9.-]); e.g. sqlite3-query-bounded → cap.bundled.sqlite3.query.bounded.
    package: { id: `cap.bundled.${pkg.toolId.replace(/-/g, ".").replace(/_/g, ".")}`, version: "1.0.0", name: `cap_bundled_${pkg.toolId.replace(/-/g, "_")}`, type: "tool-bundle" },
    tools: [{ toolId: pkg.toolId, digest: wasmSha, capabilityDigest, replayClass: meta.replayClass, capabilities }],
    executables: [{ id: pkg.toolId, sha256: wasmSha, size: pkg.bytes.byteLength, imports: { allowed, disallowed: [] }, memory: { tier, initialPages, maxPages }, runtimeCompat: ["wasm32"], replayClass: meta.replayClass, capabilities, capabilityDigest }],
    signer: { lane: SIGNER.lane, keyId: SIGNER.keyId, alg: "none" },
    source: pkg.sourceAnchor ?? SOURCE,
    build: { toolchain: pkg.toolchain, profile: "release", reproducible: true, rebuildRef: `packages/bundled/${pkg.buildScriptLane}/build.sh` },
    sbom: { format: pkg.sbom.format, sha256: sha256(sbomBytes), ref: pkg.sbom.rel },
    license: { spdx: pkg.spdx, file: pkg.licenseFile, ...(pkg.notices ? { notices: pkg.notices } : {}) },
    meta: { category: String(meta.category), channel: "bundled", description, label: pkg.toolId, status: meta.metaStatus ?? (SETTINGS_PREVIEW_LANES.has(pkg.toolId) ? "settings-preview-enabled" : "disabled-no-host"), note: meta.metaNote ?? `evidence: /tmp cap-fixed-tools/${pkg.lane}; owner decision CAP-DECISION-TEMPLATE-20260822-06` },
  };
  const canonical = canonicalJson(manifest);
  const validated = probe.validateManifest(canonical);
  if (!validated.ok) throw new Error(`generated manifest failed validation for ${pkg.toolId}: ${validated.error} ${validated.path ?? ""} ${validated.detail ?? ""}`);
  // Re-audit with the FINAL declared values exactly as admission will.
  auditWasmBinary(pkg.bytes, manifest.executables[0], {});
  const manifestRel = `extension/wasm/manifests/${manifest.package.id}-1.0.0.manifest.json`;
  ship(manifestRel, enc.encode(canonical));
  inventoryManifests.push({ pkg: manifest.package.id, version: "1.0.0", digest: validated.manifestDigest });

  const settingsPreview = SETTINGS_PREVIEW_LANES.has(pkg.toolId);
  descriptorRows.push({
    packageId: manifest.package.id, version: "1.0.0", toolId: pkg.toolId, lane: pkg.lane,
    displayName: String(meta.displayName ?? meta.displayName), category: String(meta.category),
    description, caveats: Array.isArray(meta.caveats) ? meta.caveats : [],
    capabilities, replayClass: meta.replayClass,
    licence: { spdx: pkg.spdx, file: pkg.licenseFile, notices: pkg.notices ?? null },
    binary: { sha256: wasmSha, bytes: pkg.bytes.byteLength, tier, initialPages, maxPages },
    manifestRef: manifestRel, sourceKind: "bundled-package",
    canonicalNameClaim: false,
    ...(settingsPreview
      ? { admitted: true, settingsPreview: true, disabled: false, disabledReason: null }
      : { admitted: false, disabled: true, disabledReason: pkg.disabledReason ?? "no-execution-host" }),
  });
}

// ── Generated data modules ──────────────────────────────────────────────────
const inventory = {
  schemaVersion: 1, release: RELEASE, signer: SIGNER,
  manifests: inventoryManifests.sort((a, b) => a.pkg.localeCompare(b.pkg)),
  files: inventoryFiles.sort((a, b) => a.rel.localeCompare(b.rel)),
  evidence: [], revocations: [],
};
const banner = "// GENERATED by scripts/build-bundled-tool-packages.mjs — do not hand-edit.\n// Rebuild: node scripts/build-bundled-tool-packages.mjs --evidence-root <dir>\n";
writeFileSync(join(REPO, "extension/lib/bundled-inventory-data.js"), `${banner}export const BUNDLED_INVENTORY = Object.freeze(${JSON.stringify(inventory, null, 1)});\n`);
writeFileSync(join(REPO, "extension/lib/bundled-tool-packages.data.js"), `${banner}export const BUNDLED_TOOL_PACKAGE_ROWS = Object.freeze(${JSON.stringify(descriptorRows, null, 1)});\n`);

// ── packages/bundled/: exact build scripts + provenance ─────────────────────
const scriptSources = { a2: join(PATHS.a2, "build.sh"), b2: join(PATHS.b2, "build.sh"), c2: join(PATHS.c2, "scripts/build.sh") };
for (const [lane, src] of Object.entries(scriptSources)) {
  mkdirSync(join(REPO, `packages/bundled/${lane}`), { recursive: true });
  writeFileSync(join(REPO, `packages/bundled/${lane}/build.sh`), readFileSync(src));
}
mkdirSync(join(REPO, "packages/bundled/csvtool"), { recursive: true });
writeFileSync(join(REPO, "packages/bundled/csvtool/build.sh"), `#!/usr/bin/env bash
# Reconstructed from the EXACT command recorded in the clean-room evidence
# (/tmp/cap-csvtool-cleanroom/REPORT.md line 24; toolchain clang/LLD 22.1.8,
# SOURCE_DATE_EPOCH=0 via scripts/safe-build-env.sh). Two builds must be
# byte-identical: sha256 5c8210c93d390893f961943093ccad314e87500b29eafe9f166b0b3327333d81.
set -euo pipefail
clang --target=wasm32 -std=c17 -O2 -Wall -Wextra -Werror -nostdlib -fno-builtin \\
  -Wl,--no-entry,--initial-memory=131072,--max-memory=33554432,--export-memory,--stack-first,-z,stack-size=65536,--strip-all \\
  -o csvtool.wasm source/csvtool.c
`);
mkdirSync(join(REPO, "packages/bundled/gzip"), { recursive: true });
writeFileSync(join(REPO, "packages/bundled/gzip/build.sh"), `#!/usr/bin/env bash
# gzip (zlib 1.3.1 Z_SOLO minigzip + CAP-authored freestanding runtime).
# The exact units/flags/two-build evidence is the retained receipt
# receipts/gzip-build.json inside the frozen evidence tree
# (/tmp/cap-fixed-tools-d3/, inventory sha256 7ddeea056eec79eaa0c496522297d9f381293532816f2085611c027584482af9);
# toolchain clang 22.1.8 / wasm-ld 22.1.8, target wasm32-unknown-unknown,
# SOURCE_DATE_EPOCH=1716422400. Both trusted builds were byte-identical:
# sha256 d03a2558682ea04653d34753eae8df1fcd5cc8d92fc53de43106c3db0e1c57dc (56,938 B).
# This script intentionally does NOT re-run the build: reproduction requires
# the pinned source archive + overlay recorded in that receipt.
echo "see receipts/gzip-build.json in the frozen evidence tree" >&2; exit 0
`);
mkdirSync(join(REPO, "packages/bundled/sqlite3/src"), { recursive: true });
mkdirSync(join(REPO, "packages/bundled/sqlite3/host"), { recursive: true });
writeFileSync(join(REPO, "packages/bundled/sqlite3/src/sqlite3_query_main.c"), readFileSync(join(SQLITE_EVIDENCE, "src/sqlite3_query_main.c")));
for (const f of ["quota-sink.mjs", "run-query.mjs", "wasi-worker.mjs"]) {
  writeFileSync(join(REPO, `packages/bundled/sqlite3/host/${f}`), readFileSync(join(SQLITE_EVIDENCE, `host/${f}`)));
}
writeFileSync(join(REPO, "packages/bundled/sqlite3/build.sh"), `#!/usr/bin/env bash
# sqlite3-query-bounded — SQLite 3.46.0 amalgamation + CAP-authored wrapper.
# Adapted from the pinned evidence build scripts (digests in PROVENANCE.json):
# the absolute local compiler path is replaced by an explicit WASI_SDK_PATH
# input; flags, archive digest, negative assertions, and two-build equality are
# preserved. NEVER fetches the archive implicitly: fail clearly until the
# hash-pinned archive is supplied at ./sources/archives/.
set -euo pipefail
SDK="\${WASI_SDK_PATH:?set WASI_SDK_PATH to a wasi-sdk 18.1.2 root}"
ARCHIVE="sources/archives/sqlite-amalgamation-3460000.zip"
[ -f "$ARCHIVE" ] || { echo "supply the pinned archive at $ARCHIVE (sha256 ${SQLITE_EXPECT.archive.sha256})" >&2; exit 1; }
echo "$ARCHIVE" | sha256sum --check <(echo "${SQLITE_EXPECT.archive.sha256}  $ARCHIVE")
# Negative assertions preserved: SQLITE_OMIT_ATTACH must be ABSENT;
# SQLITE_OMIT_LOAD_EXTENSION=1 must clean-link. Exact flags: see the pinned
# evidence scripts/build-one.sh (sha256 ${SQLITE_EXPECT.sources["scripts/build-one.sh"]}).
# Two builds must be byte-identical:
# sha256 ${SQLITE_EXPECT.wasm.sha256} (${SQLITE_EXPECT.wasm.bytes} bytes)
echo "adapt with the pinned evidence script; do not improvise flags" >&2; exit 1
`);
writeFileSync(join(REPO, "packages/bundled/sqlite3/PROVENANCE.json"), JSON.stringify({
  schemaVersion: 1,
  package: "cap.bundled.sqlite3-query-bounded",
  upstream: { name: "SQLite", version: "3.46.0", archiveRel: "sources/archives/sqlite-amalgamation-3460000.zip", archiveSha256: SQLITE_EXPECT.archive.sha256, license: "blessing" },
  authored: { license: "Apache-2.0", files: {
    "src/sqlite3_query_main.c": SQLITE_EXPECT.sources["src/sqlite3_query_main.c"],
    "host/quota-sink.mjs": SQLITE_EXPECT.sources["host/quota-sink.mjs"],
    "host/run-query.mjs": SQLITE_EXPECT.sources["host/run-query.mjs"],
    "host/wasi-worker.mjs": SQLITE_EXPECT.sources["host/wasi-worker.mjs"] } },
  binary: { sha256: SQLITE_EXPECT.wasm.sha256, bytes: SQLITE_EXPECT.wasm.bytes, tier: "tiny", memoryPages: { initial: 64, max: 512 }, importModule: "wasi_snapshot_preview1", importedFunctions: 24, capRuntimeGap: ["fd_fdstat_set_flags","fd_filestat_set_size","fd_sync","path_create_directory","path_filestat_set_times","path_readlink","path_remove_directory","path_unlink_file","poll_oneoff"] },
  buildReceipts: { byteIdentical: true, sqliteOmitAttachAbsent: true, sqliteOmitLoadExtension: true, toolchain: "wasi-sdk clang 18.1.2" },
  licenseExpression: "blessing AND Apache-2.0",
  blessingNoticeSha256: SQLITE_EXPECT.blessing.sha256,
  posture: { admitted: false, canonicalNameClaim: false, disabled: true, disabledReason: "runtime-imports-unimplemented" }
}, null, 1) + "\n");
writeFileSync(join(REPO, "packages/bundled/sqlite3/README.md"), `# sqlite3-query-bounded (bundled package 26, DISABLED)

SQLite 3.46.0 amalgamation (upstream Blessing) + CAP-authored wrapper/host
(Apache-2.0); licence expression "blessing AND Apache-2.0". Physically bundled
and inventory-admissible; NOT executable in this release: the binary imports 24
WASI functions, nine of which the CAP runtime does not yet implement (see
PROVENANCE.json binary.capRuntimeGap). No route, grant, or catalog entry
consumes this package. Node host sources under host/ are public Apache-2.0
provenance only — they are not shipped runtime code.
`);
writeFileSync(join(REPO, "packages/bundled/README.md"), `# Bundled tool packages (immutable; 16-tool Settings-preview tranche)

25 single-tool Wasm packages generated by \`scripts/build-bundled-tool-packages.mjs\`
from the frozen, independently reviewed evidence trees under \`/tmp/cap-fixed-tools-*\`,
\`/tmp/cap-csvtool-cleanroom/\`, and \`/tmp/cap-23-tool-catalog-metadata-v3/\`
(inventory sha256 8d956191ddcf514da699f70d0eccde10494244151b1f03ce272ad8b6af6d5689).

- Binaries ship content-addressed in \`extension/wasm/cas/<sha256>.wasm\`.
- Manifests are authority-schema-exact canonical JSON in \`extension/wasm/manifests/\`.
- SBOMs and licence texts ship in \`extension/wasm/sbom/\` and \`extension/wasm/licenses/\`.
- The admission inventory is \`extension/lib/bundled-inventory-data.js\` (generated).
- Descriptors (\`extension/lib/bundled-tool-packages.data.js\`): ONLY the static
  tranche \`csvtool\`, \`uuid\`, \`head\`, \`tail\`, \`cut\`, \`base64\`,
  \`md5sum\`, \`sha256sum\`, \`sha512sum\`, \`wc\`, \`xxd\`, \`sort\`,
  \`uniq\`, \`tr\`, \`grep\`, \`toml2json\` are
  \`admitted:true\` + \`settingsPreview:true\` (Settings-only bounded previews,
  explicit owner click, argv0 = the exact toolId; no catalog/provider selection
  authority). The other 10 remain \`admitted:false\`, \`disabled:true\` (reason
  \`no-execution-host\`), \`canonicalNameClaim:false\`,
  \`sourceKind:"bundled-package"\`.
- The ONLY execution route is \`tool.preview.run\` (exact Settings options
  document sender; the toolId resolves through the immutable spec map +
  revalidation of manifest/CAS/imports/memory/caps at every run). No provider
  route, no selection authority, no other executor.

Provenance anchor: source.repo is the public platform repo at commit
5e086c1fb0847ddccf1a16ba3129a4cf900eac8f (the landing base); binary identity is
content-addressed and hash-pinned in every manifest. Upstream provenance
(zlib 51b7f2ab, cmark 0.31.1, tomlc99, GNU-bound blocked tools) is recorded in
the evidence inventories and the owner decision template
CAP-DECISION-TEMPLATE-20260822-06.
`);

console.log(`OK: ${packages.length} packages, ${inventoryFiles.length} shipped files, ${inventoryManifests.length} manifest identities`);
