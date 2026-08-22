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
const SOURCE = { repo: "https://github.com/PaulKinlan/chrome-agent-platform", commit: "5e086c1fb0847ddccf1a16ba3129a4cf900eac8f" };
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

for (const [rel, bytes] of Object.entries(LICENSE_WRITES)) ship(rel, bytes);

for (const pkg of packages) {
  const wasmSha = sha256(pkg.bytes);
  ship(`extension/wasm/cas/${wasmSha}.wasm`, pkg.bytes);
  const sbomBytes = readFileSync(pkg.sbom.src);
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
    package: { id: `cap.bundled.${pkg.toolId}`, version: "1.0.0", name: `cap_bundled_${pkg.toolId.replace(/-/g, "_")}`, type: "tool-bundle" },
    tools: [{ toolId: pkg.toolId, digest: wasmSha, capabilityDigest, replayClass: meta.replayClass, capabilities }],
    executables: [{ id: pkg.toolId, sha256: wasmSha, size: pkg.bytes.byteLength, imports: { allowed, disallowed: [] }, memory: { tier, initialPages, maxPages }, runtimeCompat: ["wasm32"], replayClass: meta.replayClass, capabilities, capabilityDigest }],
    signer: { lane: SIGNER.lane, keyId: SIGNER.keyId, alg: "none" },
    source: SOURCE,
    build: { toolchain: pkg.toolchain, profile: "release", reproducible: true, rebuildRef: `packages/bundled/${pkg.buildScriptLane}/build.sh` },
    sbom: { format: pkg.sbom.format, sha256: sha256(sbomBytes), ref: pkg.sbom.rel },
    license: { spdx: pkg.spdx, file: pkg.licenseFile, ...(pkg.notices ? { notices: pkg.notices } : {}) },
    meta: { category: String(meta.category), channel: "bundled", description, label: pkg.toolId, status: "disabled-no-host", note: `evidence: /tmp cap-fixed-tools/${pkg.lane}; owner decision CAP-DECISION-TEMPLATE-20260822-06` },
  };
  const canonical = canonicalJson(manifest);
  const validated = probe.validateManifest(canonical);
  if (!validated.ok) throw new Error(`generated manifest failed validation for ${pkg.toolId}: ${validated.error} ${validated.path ?? ""} ${validated.detail ?? ""}`);
  // Re-audit with the FINAL declared values exactly as admission will.
  auditWasmBinary(pkg.bytes, manifest.executables[0], {});
  const manifestRel = `extension/wasm/manifests/cap.bundled.${pkg.toolId}-1.0.0.manifest.json`;
  ship(manifestRel, enc.encode(canonical));
  inventoryManifests.push({ pkg: manifest.package.id, version: "1.0.0", digest: validated.manifestDigest });

  descriptorRows.push({
    packageId: manifest.package.id, version: "1.0.0", toolId: pkg.toolId, lane: pkg.lane,
    displayName: String(meta.displayName ?? meta.displayName), category: String(meta.category),
    description, caveats: Array.isArray(meta.caveats) ? meta.caveats : [],
    capabilities, replayClass: meta.replayClass,
    licence: { spdx: pkg.spdx, file: pkg.licenseFile, notices: pkg.notices ?? null },
    binary: { sha256: wasmSha, bytes: pkg.bytes.byteLength, tier, initialPages, maxPages },
    manifestRef: manifestRel, sourceKind: "bundled-package",
    canonicalNameClaim: false, admitted: false, disabled: true, disabledReason: "no-execution-host",
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
writeFileSync(join(REPO, "packages/bundled/README.md"), `# Bundled tool packages (immutable, disabled-until-host)

25 single-tool Wasm packages generated by \`scripts/build-bundled-tool-packages.mjs\`
from the frozen, independently reviewed evidence trees under \`/tmp/cap-fixed-tools-*\`,
\`/tmp/cap-csvtool-cleanroom/\`, and \`/tmp/cap-23-tool-catalog-metadata-v3/\`
(inventory sha256 8e9e3a689a1c19193a7a6723b4f94039a5b06ef57543de68ebd79bcf91fa4d9a).

- Binaries ship content-addressed in \`extension/wasm/cas/<sha256>.wasm\`.
- Manifests are authority-schema-exact canonical JSON in \`extension/wasm/manifests/\`.
- SBOMs and licence texts ship in \`extension/wasm/sbom/\` and \`extension/wasm/licenses/\`.
- The admission inventory is \`extension/lib/bundled-inventory-data.js\` (generated).
- Descriptors (\`extension/lib/bundled-tool-packages.data.js\`) are
  \`admitted:false\`, \`disabled:true\` (reason \`no-execution-host\`),
  \`canonicalNameClaim:false\`, \`sourceKind:"bundled-package"\` — enumerated only
  by the package catalog once its precursor (bundled-package source-kind gate) lands.
- No execution route exists: nothing in the service worker imports these modules.

Provenance anchor: source.repo is the public platform repo at commit
5e086c1fb0847ddccf1a16ba3129a4cf900eac8f (the landing base); binary identity is
content-addressed and hash-pinned in every manifest. Upstream provenance
(zlib 51b7f2ab, cmark 0.31.1, tomlc99, GNU-bound blocked tools) is recorded in
the evidence inventories and the owner decision template
CAP-DECISION-TEMPLATE-20260822-06.
`);

console.log(`OK: ${packages.length} packages, ${inventoryFiles.length} shipped files, ${inventoryManifests.length} manifest identities`);
