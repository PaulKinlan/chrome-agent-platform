#!/usr/bin/env node
// build-bundled-tool-packages.mjs — regenerate the shipped immutable bundled
// tool packages from the frozen, independently reviewed evidence trees.
//
// Reads (paths via --evidence-root, default packages/bundled/evidence):
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
// Evidence lives IN THE REPO at packages/bundled/evidence/<lane>/ (durable
// migration, owner directive: never depend on paths outside the source tree).
// --evidence-root remains for provenance hosts re-running against original trees.
const evidenceIdx = args.indexOf("--evidence-root");
const EVIDENCE = evidenceIdx >= 0 ? args[evidenceIdx + 1] : join(REPO, "packages/bundled/evidence");
// --verify: generate everything IN MEMORY and fail closed on ANY drift versus
// the committed tree. The default build path (build.mjs) runs this so
// `npm run build` truthfully bundles the exact generated tools and hand edits
// cannot slip through. Full regeneration is the explicit --regen-tools build
// flag (plain invocation of this script). Verify mode writes/deletes NOTHING.
// On a host WITHOUT the frozen evidence trees, verify degrades to an honest
// WARNING + pass (fresh-checkout portability); regeneration still hard-fails.
const VERIFY = args.includes("--verify");
const emitted = new Map(); // verify mode only: repo-relative path -> bytes
function emit(abs, bytes) {
  if (VERIFY) { emitted.set(abs.slice(REPO.length + 1), Buffer.from(bytes)); return; }
  writeFileSync(abs, bytes);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const enc = new TextEncoder();

const PATHS = {
  a2: join(EVIDENCE, "a2"),
  b2: join(EVIDENCE, "b2"),
  c2: join(EVIDENCE, "c2"),
  csvtool: join(EVIDENCE, "csvtool"),
  d3: join(EVIDENCE, "d3"),
  sqlite3: join(EVIDENCE, "sqlite3"),
  stream: join(REPO, "packages/bundled/unix-stream-v1"),
  awkFull: join(REPO, "packages/bundled/awk-posixutils-v1"),
  sed: join(REPO, "docs/admissions/t3-trio/sed"),
  jq: join(REPO, "docs/admissions/jq-filter-bounded"),
  awk: join(REPO, "docs/admissions/t3-trio/awk"),
  date: join(REPO, "docs/admissions/t3-trio/date"),
  catalog: join(EVIDENCE, "catalog", "inventory.json"),
};
const missingEvidence = Object.entries(PATHS).filter(([, p]) => !existsSync(p));
if (missingEvidence.length > 0) {
  if (!VERIFY) {
    // Full regeneration must never run from nothing.
    throw new Error(`missing evidence path (${missingEvidence[0][0]}): ${missingEvidence[0][1]} — regeneration requires the frozen evidence trees (pass --evidence-root <dir>)`);
  }
  // Degraded verify on a fresh checkout: the frozen evidence trees live on the
  // provenance host, not in the repo. The committed generated outputs remain
  // authoritative (build.mjs still enforces the shipped-Wasm manifest/bounded
  // scan), but regeneration-drift verification is IMPOSSIBLE without the raw
  // trees — say so honestly instead of failing an innocent checkout.
  console.warn(
    `WARNING: bundled-tool verify DEGRADED — evidence trees absent (${missingEvidence.map(([k]) => k).join(", ")}); ` +
    `skipping regeneration-drift verification. Committed generated outputs are trusted as pinned ` +
    `(build.mjs shipped-Wasm manifest checks still apply). Provide --evidence-root <dir> for full verification.`
  );
  process.exit(0);
}

const CATALOG = JSON.parse(readFileSync(PATHS.catalog, "utf8"));
// The catalog sha is computed ONCE from the actual pinned evidence file and is
// the SINGLE authoritative source for BOTH the enforcement below and the
// generated README literal — never a hand-fabricated value.
const catalogSha = sha256(readFileSync(PATHS.catalog));
if (catalogSha !== "8e9e3a689a1c19193a7a6723b4f94039a5b06ef57543de68ebd79bcf91fa4d9a") {
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

// ── Agent-useful descriptions (CAP-FB-20260823-TOOL-DESCRIPTION-QUALITY-01) ──
// Each description carries: plain function, when to choose, in/out shape, key flags,
// bounds, and a concrete example. Provenance/library names stay in SBOM/licence fields.
export const AGENT_DESCRIPTIONS = Object.freeze({
  base64: "base64 - stream binary data to base64 text or decode it. Use for lossless text/binary conversion. In/out: file-backed stdin to chainable output. Flag: -d. Example: 'hello' -> 'aGVsbG8=\\n'.",
  md5sum: "md5sum - compute legacy 128-bit MD5 hash checksums. Use for non-security file verification. In/out: stdin (<=2 KiB) to 32-hex digest. No flags. Example: stdin 'hello' -> '5d41402abc4b2a76b9719d911017c592'.",
  sha256sum: "sha256sum - compute cryptographic 256-bit SHA-256 hash digests. Use to hash files or verify secure integrity. In/out: stdin (<=2 KiB) to 64-hex digest. No flags. Example: stdin 'hello' -> '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'.",
  sha512sum: "sha512sum - compute cryptographic 512-bit SHA-512 hash digests. Use for high-security hashing. In/out: stdin (<=2 KiB) to 128-hex digest. No flags. Example: stdin 'hello' -> the 128-hex digest.",
  xxd: "xxd - convert binary data to hex dumps and reconstruct it. Use for byte-level inspection. In/out: stdin (<=2 KiB) to hex stdout. Key flag: -p (plain hex). Example: -p + stdin 'Hi' -> '4869\\n'.",
  uuid: "uuid - generate random UUID v4 unique identifier strings. Use to create unique keys or IDs. In/out: empty stdin to UUID stdout. Key flag: -n <count> (max 64). Example: -n 2 -> two UUID lines.",
  wc: "wc - stream and count lines, words, and bytes. Use to measure arbitrarily large text without loading it whole. In/out: file-backed stdin to counts. Flags: -l, -w, -c. Example: 'a b\\n' -> '1 2 4\\n'.",
  head: "head - extract the leading lines from a text stream. Use to inspect the start of a file. In/out: stdin (<=2 KiB) to sliced stdout. Key flag: -n (default 10). Example: -n 2 + stdin 'a\\nb\\nc' -> 'a\\nb'.",
  tail: "tail - extract the trailing lines from a text stream. Use to inspect the end of a log file. In/out: stdin (<=2 KiB) to sliced stdout. Key flag: -n (default 10). Example: -n 2 + stdin 'a\\nb\\nc' -> 'b\\nc'.",
  cut: "cut - extract columns or delimiter-separated fields from text. Use to parse CSV or TSV columns. In/out: stdin (<=2 KiB) to column stdout. Flags: -d, -f. Example: -d , -f 2 + stdin 'a,b,c' -> 'b'.",
  sort: "sort - external merge-sort file-backed text in the C byte locale. Use to order data larger than Wasm memory. In/out: chainable references. Flags: -r, -n, -u. Example: 'b\\na\\n' -> 'a\\nb\\n'.",
  uniq: "uniq - stream adjacent lines and remove or count duplicates. Use after sort for deduplication. In/out: file-backed stdin to chainable output. Flags: -c, -d, -u. Example: 'a\\na\\nb' -> 'a\\nb'.",
  tr: "tr - stream byte translation, deletion, and squeezing in the C locale. Use for case shifts and character maps. In/out: file-backed stdin to chainable output. Flags: -c, -d, -s. Example: 'a-z' 'A-Z' maps 'hi' to 'HI'.",
  grep: "grep - stream matching text lines with POSIX BRE/ERE or fixed strings. Use to search, find, and filter large text. In/out: file-backed stdin to chainable output. Flags: -E, -F, -i, -v, -n, -c.",
  sed: "sed - stream-edit text with minised 1.16. Use for substitutions, selection, deletion, and standard sed scripts. In/out: file-backed stdin to chainable output. Flags: -e, -n. Example: 's/a/b/g'.",
  awk: "awk - run the posixutils-rs parser and interpreter over streaming records. Use for fields, expressions, regex, arrays, and reports. In/out: file-backed stdin to chainable output. Command pipes and system() are unavailable.",
  jq: "jq - parse and transform JSON with upstream jq 1.8.2. Use for object, array, filter, reduction, and formatting operations over JSON streams. In/out: file-backed stdin to chainable output. Oniguruma regex built-ins are unavailable.",
  diff: "diff - compare text documents and calculate diff changes. Use to compare revisions by viewing differences, or for file editing. In/out: two text args (<=1 KiB each) to unified diff. No flags. Example: 'a\\nb\\n' and 'a\\nc\\n' -> hunk diff.",
  patch: "patch - apply unified diff hunks to a source text document. Use to update files or do editing from patches. In/out: source text arg + diff arg (<=1 KiB each) to patched stdout. No flags. Example: source 'a\\nb\\n' + diff -> 'a\\nc\\n'.",
  toml2json: "toml2json - convert TOML configuration text to JSON format. Use to parse, convert, or read config data. In/out: valid TOML stdin (<=2 KiB) to JSON stdout. No flags. Example: stdin 'a = 1' -> '{\"a\":1}\\n'.",
  markdown: "markdown - convert Markdown formatted text into safe HTML. Use to render and view formatted content. In/out: Markdown stdin (<=2 KiB) to HTML stdout. No flags; safe mode is enforced. Example: stdin '# Hi' -> '<h1>Hi</h1>\\n'.",
  du: "du - measure disk usage and file sizes across directories. Use to check file and folder space. In/out: optional /job path operand (default /job) to usage stdout. Bounded to 4096 entries. No flags. Example: empty args -> '1\\t/job'.",
  stat: "stat - inspect file and directory metadata including size and type. Use to check file existence and details. In/out: /job path operand to stat stdout. Read-only. No flags. Example: '/job/inputs/f.bin' -> 'size=2\\ntype=regular file'.",
  tree: "tree - display directory file structures as visual text trees. Use to explore workspace and folder layout. In/out: optional /job path operand to tree stdout. Bounded to 4096 nodes. No flags. Example: empty args -> directory tree.",
  touch: "touch - create empty files or update file timestamps. Use to create or touch files in scratch space. In/out: /job/scratch path operand. Flags: -t <epoch_sec>, -c (no-create). Example: -t 0 '/job/scratch/touched'.",
  truncate: "truncate - resize a file to a target size (shrink or extend); supports +/- and K/M/G/T suffixes. Use for editing file sizes in scratch space. In/out: /job/scratch path (max 10 MiB). Flag: -s. Example: -s 0 '/job/scratch/touched'.",
  csvtool: "csvtool - parse, transform, and edit RFC 4180 CSV spreadsheet table data. Use for CSV editing, filtering, or formatting rows. In/out: CSV stdin (<=2 KiB) to CSV stdout. No flags. Example: stdin 'a,b\\n1,2' -> 'a,b\\n1,2'.",
  gzip: "gzip - compress or decompress data streams. Use to compress and decompress files or streams. In/out: stdin (<=2 KiB) to base64 stdout (<=64 KiB). Key flag: -d (decompress). Example: -d + base64 -> decompressed.",
  sqlite3_query_bounded: "sqlite3_query_bounded - execute SQL queries to read, search, and filter SQLite database tables. Use to query relational data. In/out: JSON request (<=2 KiB) with sql and params to row set (<=64 KiB). No flags. Example: 'SELECT * FROM test'.",
  awk_filter_bounded: "awk_filter_bounded - split, filter, and print bounded text records. Use for field extraction and literal line filtering. In/out: stdin plus one program arg to stdout. Supports -F and literal /pattern/ with ^/$ edge anchors.",
  date_formatter_bounded: "date_formatter_bounded - format current time, numeric epochs, or exact ISO dates. Use for UTC and ISO formatting. In/out: up to four bounded args to one stdout line. Invalid or missing date specs fail nonzero.",
});

// ── Read + hash-verify every binary against its evidence inventory ──────────
function verifiedBinary(lane, toolId, rel, expectedSha, expectedBytes) {
  const bytes = readFileSync(join(PATHS[lane], rel));
  const actual = sha256(bytes);
  if (actual !== expectedSha) throw new Error(`hash mismatch ${toolId}: ${actual} != ${expectedSha}`);
  if (bytes.byteLength !== expectedBytes) throw new Error(`size mismatch ${toolId}`);
  return bytes;
}

function cdxBytes(name, version, license, components) {
  return enc.encode(JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: { component: { type: "application", name, version, licenses: [{ expression: license }] } },
    components,
  }, null, 1) + "\n");
}

const NEW_SOURCE = {
  repo: "https://github.com/PaulKinlan/chrome-agent-platform",
  commit: "ad670c717f70b6df1bc63aeefa13023422619581",
};
const STREAM_EXPECT = Object.freeze({
  base64: ["20d6324f4925ee8263322bb74eb818861f13fbd0d4ce080b13c2140b213232cf", 15346],
  grep: ["04d32c115c9e3a979d59cfe27ea0e5ece616efd64ff958d4fcc96bb217191588", 83434],
  sort: ["e0543d170ac9bd0cd55b274604b55add18c17c5d87169ebfdf25b4b7245a386a", 35917],
  tr: ["bec02b43bdeb1997f9616d95499ce91010e124aecb1cad6e6bd97102c0956f3f", 37263],
  uniq: ["973d78aa28f825019fbfb4aa9463dc6940a65d7da6de80590ba1a691443154df", 32627],
  wc: ["ce303be0226d2675019191dddbcded6d83de100922fcc10e5ee48a058c0d27d5", 28861],
});
const STREAM_SBOM = {
  bytes: cdxBytes("cap-bundled-unix-stream-v1", "2.0.0", "MIT",
    Object.keys(STREAM_EXPECT).map((name) => ({ type: "application", name, version: "2.0.0", licenses: [{ license: { id: "MIT" } }] }))),
  rel: "extension/wasm/sbom/unix-stream-v1.cdx.json",
  format: "cyclonedx-json@1.5",
};
function streamPackage(toolId, row) {
  const [expectedSha, expectedBytes] = STREAM_EXPECT[toolId];
  const bytes = readFileSync(join(PATHS.stream, "binaries", `${toolId}.wasm`));
  if (sha256(bytes) !== expectedSha || bytes.byteLength !== expectedBytes) throw new Error(`${toolId}: streaming binary drift`);
  return {
    toolId, lane: "unix-stream-v1", version: "2.0.0", bytes,
    row: {
      ...row,
      caveats: ["Stdin/stdout only; file operands are rejected.", "C byte-locale semantics."],
      metaStatus: "file-stream-enabled",
      metaNote: "source, deterministic rebuild, and streaming profile: packages/bundled/unix-stream-v1",
    },
    spdx: "MIT", licenseFile: "extension/wasm/licenses/MIT.txt", notices: null,
    sbom: STREAM_SBOM, toolchain: "wasi-sdk clang 18.1.2", buildScriptLane: "unix-stream-v1",
    sourceAnchor: NEW_SOURCE, metaStatus: "file-stream-enabled",
    metaNote: "source, deterministic rebuild, and streaming profile: packages/bundled/unix-stream-v1",
  };
}

const packages = [];
for (const toolId of LANES.a2.tools) {
  const row = catalogRow(toolId);
  packages.push(STREAM_EXPECT[toolId]
    ? streamPackage(toolId, row)
    : { toolId, lane: "a2", bytes: verifiedBinary("a2", toolId, row.binary.path, row.binary.sha256, row.binary.bytes), row, spdx: LANES.a2.spdx, licenseFile: LANES.a2.licenseFile, notices: null, sbom: LANES.a2.sbom, toolchain: LANES.a2.toolchain, buildScriptLane: "a2" });
}
for (const toolId of LANES.b2.tools) {
  const row = catalogRow(toolId);
  packages.push(STREAM_EXPECT[toolId]
    ? streamPackage(toolId, row)
    : { toolId, lane: "b2", bytes: verifiedBinary("b2", toolId, row.binary.path, row.binary.sha256, row.binary.bytes), row, spdx: "Apache-2.0", licenseFile: LANES.b2.licenseFile, notices: null, sbom: LANES.b2.sbom, toolchain: LANES.b2.toolchain, buildScriptLane: "b2" });
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
  packages.push({ toolId: "csvtool", lane: "csvtool", bytes: wasm, row: null, spdx: "Apache-2.0", licenseFile: "extension/wasm/licenses/Apache-2.0.txt", notices: null, sbom: { src: join(PATHS.csvtool, "sbom/cyclonedx-1.5.json"), rel: "extension/wasm/sbom/csvtool.cdx.json", format: "cyclonedx-json@1.5" }, toolchain: "clang 22.1.8; LLD 22.1.8", buildScriptLane: "csvtool", displayName: "csvtool", category: "text", description: AGENT_DESCRIPTIONS.csvtool, caveats: ["Stdin/stdout only; no file operands."], replayClass: "read-only", capabilities: ["compute", "text.transform"] });
}
{ // gzip (zlib 1.3.1 minigzip upstream + CAP-authored runtime): Zlib AND Apache-2.0
  const d3 = JSON.parse(readFileSync(join(PATHS.d3, "inventory.json"), "utf8"));
  const bin = d3.retainedBinaries[0];
  const wasm = readFileSync(join(PATHS.d3, bin.file));
  if (sha256(wasm) !== bin.sha256 || wasm.byteLength !== bin.bytes) throw new Error("gzip hash/size mismatch");
  if (sha256(readFileSync(join(PATHS.d3, "inventory.json"))) !== "7ddeea056eec79eaa0c496522297d9f381293532816f2085611c027584482af9") throw new Error("d3 inventory hash mismatch");
  const mem = d3.tools[0].memory;
  packages.push({ toolId: "gzip", lane: "gzip", bytes: wasm, row: null, spdx: "Zlib AND Apache-2.0", licenseFile: "extension/wasm/licenses/Zlib-1.3.1.txt", notices: "extension/wasm/licenses/CAP-authored-Apache-2.0.txt", sbom: { src: join(PATHS.d3, "sbom/gzip-zlib-minigzip-stdio.cdx.json"), rel: "extension/wasm/sbom/gzip.cdx.json", format: "cyclonedx-json@1.5" }, toolchain: "clang 22.1.8; wasm-ld 22.1.8", buildScriptLane: "gzip", displayName: "gzip", category: "data", description: AGENT_DESCRIPTIONS.gzip, caveats: ["Stdin/stdout only; rejects file operands, recursion, unknown options.", "Experimental candidate; not the canonical full gzip."], replayClass: "read-only", capabilities: ["compute", "text.transform"], memoryOverride: { initialPages: mem.initialPages, maxPages: mem.maxPages } });
}
const T3_SOURCE = { repo: "https://github.com/PaulKinlan/chrome-agent-platform", commit: "486005dbfb84bd8ae9f469ee1f83f3e91f9b038c" };
for (const [toolId, lane] of [["awk_filter_bounded", "awk"], ["date_formatter_bounded", "date"]]) {
  const binaryName = lane === "awk" ? "awk.wasm" : "date.wasm";
  const bytes = readFileSync(join(PATHS[lane], "binaries", binaryName));
  const receipt = Object.fromEntries(readFileSync(join(PATHS[lane], "metadata/build-receipt.txt"), "utf8").trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
  if (sha256(bytes) !== receipt.binary_sha256 || bytes.byteLength !== Number(receipt.binary_bytes)) throw new Error(`${lane}: receipt binary identity mismatch`);
  if (!readFileSync(join(PATHS[lane], "metadata/rebuild-" + binaryName)).equals(bytes)) throw new Error(`${lane}: rebuild is not byte-identical`);
  packages.push({
    toolId, lane, bytes, row: null, spdx: "0BSD AND Apache-2.0",
    licenseFile: "extension/wasm/licenses/0BSD.txt",
    notices: `extension/wasm/licenses/${lane}-NOTICES.txt`,
    sbom: { src: join(PATHS[lane], "sbom.cdx.json"), rel: `extension/wasm/sbom/${lane}.cdx.json`, format: "cyclonedx-json@1.5" },
    toolchain: "wasi-sdk clang 18.1.2", buildScriptLane: lane, sourceAnchor: T3_SOURCE,
    displayName: toolId, category: lane === "awk" ? "text" : "time", description: AGENT_DESCRIPTIONS[toolId],
    caveats: lane === "awk"
      ? ["Bounded clean-room subset, not canonical awk; literal patterns with optional ^/$ edge anchors only.", "CAP preview is stdin-only; no owner files are projected."]
      : ["Bounded clean-room formatter, not canonical date; exact numeric epoch and ISO date inputs only."],
    replayClass: "read-only", capabilities: ["compute", "text.transform"],
  });
}

{ // Canonical sed: minised 1.16, BSD-3-Clause, byte-identical rebuild retained.
  const bytes = readFileSync(join(PATHS.sed, "binaries/sed.wasm"));
  const rebuild = readFileSync(join(PATHS.sed, "metadata/rebuild-sed.wasm"));
  if (sha256(bytes) !== "3e553ca399ce02c6d796cf80e08057ae41730f32f507d9bc2561e75faa4c2438" ||
      bytes.byteLength !== 49977 || !bytes.equals(rebuild)) throw new Error("sed identity/rebuild mismatch");
  packages.push({
    toolId: "sed", lane: "sed", version: "1.0.0", bytes, row: null,
    spdx: "BSD-3-Clause", licenseFile: "extension/wasm/licenses/minised-BSD-3-Clause.txt", notices: null,
    sbom: { bytes: cdxBytes("cap.bundled.sed", "1.0.0", "BSD-3-Clause", [
      { type: "application", name: "minised", version: "1.16", licenses: [{ license: { id: "BSD-3-Clause" } }] },
    ]), rel: "extension/wasm/sbom/sed.cdx.json", format: "cyclonedx-json@1.5" },
    toolchain: "clang 22.1.8; wasi-sysroot 22.0", buildScriptLane: "sed", sourceAnchor: NEW_SOURCE,
    displayName: "sed", category: "text", description: AGENT_DESCRIPTIONS.sed,
    caveats: ["Stdin/stdout only; file operands and in-place editing are unavailable."],
    replayClass: "read-only", capabilities: ["compute", "text.transform"],
    metaStatus: "file-stream-enabled",
  });
}
{ // Canonical awk: upstream posixutils-rs parser/interpreter with a WASI adaptation.
  const bytes = readFileSync(join(PATHS.awkFull, "binaries/awk.wasm"));
  if (sha256(bytes) !== "e48cd71ae08b03a62e06cf3e0c21acdf051bd9ecfd7e83812be4307502f1fb23" ||
      bytes.byteLength !== 1064871) throw new Error("awk identity mismatch");
  packages.push({
    toolId: "awk", lane: "awk-posixutils-v1", version: "1.0.0", bytes, row: null,
    spdx: "MIT", licenseFile: "extension/wasm/licenses/posixutils-rs-MIT.txt", notices: null,
    sbom: { bytes: cdxBytes("cap.bundled.awk", "1.0.0", "MIT", [
      { type: "application", name: "posixutils-awk", version: "0.8.0", licenses: [{ license: { id: "MIT" } }] },
      { type: "library", name: "revera", version: "0.2.1", licenses: [{ license: { id: "MIT" } }] },
    ]), rel: "extension/wasm/sbom/awk-posixutils-v1.cdx.json", format: "cyclonedx-json@1.5" },
    toolchain: "Rust 1.97.1; wasm32-wasip1", buildScriptLane: "awk-posixutils-v1", sourceAnchor: NEW_SOURCE,
    displayName: "awk", category: "text", description: AGENT_DESCRIPTIONS.awk,
    caveats: ["Stdin record input only; command pipes are unavailable and system() returns -1."],
    replayClass: "read-only", capabilities: ["compute", "text.transform"],
    memoryOverride: { initialPages: 64, maxPages: 512 }, metaStatus: "file-stream-enabled",
  });
}
{ // Canonical jq 1.8.2, single-threaded WASI adaptation without Oniguruma.
  const bytes = readFileSync(join(PATHS.jq, "binaries/jq.wasm"));
  const rebuild = readFileSync(join(PATHS.jq, "metadata/rebuild-jq.wasm"));
  if (sha256(bytes) !== "e884973be3742724a5bdf4637644dfd7f9630d54132835d3849b44da9e4e4234" ||
      bytes.byteLength !== 501650 || !bytes.equals(rebuild)) throw new Error("jq identity/rebuild mismatch");
  packages.push({
    toolId: "jq", lane: "jq", version: "1.0.0", bytes, row: null,
    spdx: "MIT", licenseFile: "extension/wasm/licenses/jq-MIT.txt", notices: null,
    sbom: { bytes: cdxBytes("cap.bundled.jq", "1.0.0", "MIT", [
      { type: "application", name: "jq", version: "1.8.2", licenses: [{ license: { id: "MIT" } }] },
    ]), rel: "extension/wasm/sbom/jq.cdx.json", format: "cyclonedx-json@1.5" },
    toolchain: "clang 22.1.8; wasi-sysroot 22.0", buildScriptLane: "jq", sourceAnchor: NEW_SOURCE,
    displayName: "jq", category: "data", description: AGENT_DESCRIPTIONS.jq,
    caveats: ["Oniguruma-dependent regex built-ins are unavailable in this WASI profile."],
    replayClass: "read-only", capabilities: ["compute", "text.transform"],
    memoryOverride: { initialPages: 64, maxPages: 512 }, metaStatus: "file-stream-enabled",
  });
}

// ── Clean + recreate output trees ───────────────────────────────────────────
const WASM_OUT = join(REPO, "extension/wasm");
if (!VERIFY) {
  rmSync(WASM_OUT, { recursive: true, force: true });
  for (const d of ["cas", "manifests", "sbom", "licenses"]) mkdirSync(join(WASM_OUT, d), { recursive: true });
  mkdirSync(join(REPO, "packages/bundled"), { recursive: true });
}

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
  "extension/wasm/licenses/0BSD.txt": enc.encode(`Copyright (C) 2026 Chrome Agent Platform Authors\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.\n\nTHE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n`),
  "extension/wasm/licenses/awk-NOTICES.txt": readFileSync(join(PATHS.awk, "NOTICES.md")),
  "extension/wasm/licenses/date-NOTICES.txt": readFileSync(join(PATHS.date, "NOTICES.md")),
  "extension/wasm/licenses/minised-BSD-3-Clause.txt": readFileSync(join(PATHS.sed, "NOTICES.md")),
  "extension/wasm/licenses/posixutils-rs-MIT.txt": readFileSync(join(PATHS.awkFull, "source/LICENSE")),
  "extension/wasm/licenses/jq-MIT.txt": readFileSync(join(PATHS.jq, "COPYING-jq.txt")),
};

// ── Manifests (authority-schema-exact; canonical bytes; re-validated) ───────
const probe = new WasmPackageAuthority();
const SIGNER = { lane: "bundled", keyId: "cap-bundled-release" };
// The technically-admitted Settings-preview allowlist (the static tranches):
// the 25 tools in SETTINGS_PREVIEW_LANES expose bounded Settings-only previews
// (explicit owner click). Every other lane stays admitted:false / disabled:true
// — no catalog/provider selection authority. New semantic tranches append so
// the predecessor order stays stable.
// The technically-admitted Settings-preview allowlist (the static tranches):
// the 26 tools in SETTINGS_PREVIEW_LANES expose bounded Settings-only previews
// (explicit owner click). Every other lane stays admitted:false / disabled:true
// — no catalog/provider selection authority. New semantic tranches append so
// the predecessor order stays stable.
const SETTINGS_PREVIEW_LANES = new Set(["csvtool", "uuid", "head", "tail", "cut", "base64", "md5sum", "sha256sum", "sha512sum", "wc", "xxd", "sort", "uniq", "tr", "grep", "toml2json", "markdown", "diff", "patch", "stat", "du", "tree", "gzip", "truncate", "touch", "sqlite3_query_bounded", "awk_filter_bounded", "date_formatter_bounded", "sed", "awk", "jq"]);
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
  if (!VERIFY) mkdirSync(dirname(abs), { recursive: true });
  emit(abs, bytes);
  written.set(rel, bytes);
  inventoryFiles.push({ rel, sha256: sha256(bytes), size: bytes.byteLength });
}

// ── Package 26: sqlite3-query-bounded (SQLite 3.46.0 amalgamation + CAP-authored
// wrapper/host). Exact upstream Blessing + Apache-2.0 authored provenance.
// The binary imports 24 WASI functions; the CAP runtime implements 15 of them
// (eight unimplemented; fd_fdstat_set_flags is linkage-only callable but unauthorized) —
// the descriptor is disabled runtime-imports-unimplemented.
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
    "scripts/build-one.sh": "dbee22cd00d904f6c7706027e3728c22e7e1535571fda1d45c223b6db275d3da",  // re-pinned after owner-directed host-path scrub (no other byte changed),
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
    displayName: "sqlite3_query_bounded",
    category: "data",
    description: AGENT_DESCRIPTIONS.sqlite3_query_bounded,
    caveats: [
      "Memory tranche has no external persistence.",
      "Package-level capability union is intentionally conservative.",
    ],
    replayClass: "mutating",
    capabilities: ["compute", "data.read", "data.write", "file.read", "file.write"],
    memoryOverride: { initialPages: 64, maxPages: 512 },
    metaNote: "evidence digests in packages/bundled/sqlite3/PROVENANCE.json; owner decision CAP-DECISION-TEMPLATE-20260822-06 D4",
  });
  LICENSE_WRITES["extension/wasm/licenses/SQLite-Blessing-3.46.0.txt"] = blessing;
}


for (const [rel, bytes] of Object.entries(LICENSE_WRITES)) ship(rel, bytes);

for (const pkg of packages) {
  const pkgVersion = pkg.version ?? "1.0.0";
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
  const description = AGENT_DESCRIPTIONS[pkg.toolId] ?? String(meta.description);
  if (!/^[\x20-\x7e]{1,256}$/.test(description)) throw new Error(`${pkg.toolId}: description not ASCII/bounded`);
  const manifest = {
    schemaVersion: 1,
    // package.id derives from toolId with '-' → '.' (PACKAGE_ID_RE admits only
    // [a-z0-9.-]); e.g. sqlite3-query-bounded → cap.bundled.sqlite3.query.bounded.
    package: { id: `cap.bundled.${pkg.toolId.replace(/-/g, ".").replace(/_/g, ".")}`, version: pkgVersion, name: `cap_bundled_${pkg.toolId.replace(/-/g, "_")}`, type: "tool-bundle" },
    tools: [{ toolId: pkg.toolId, digest: wasmSha, capabilityDigest, replayClass: meta.replayClass, capabilities }],
    executables: [{ id: pkg.toolId, sha256: wasmSha, size: pkg.bytes.byteLength, imports: { allowed, disallowed: [] }, memory: { tier, initialPages, maxPages }, runtimeCompat: ["wasm32"], replayClass: meta.replayClass, capabilities, capabilityDigest }],
    signer: { lane: SIGNER.lane, keyId: SIGNER.keyId, alg: "none" },
    source: pkg.sourceAnchor ?? SOURCE,
    build: { toolchain: pkg.toolchain, profile: "release", reproducible: true, rebuildRef: `packages/bundled/${pkg.buildScriptLane}/build.sh` },
    sbom: { format: pkg.sbom.format, sha256: sha256(sbomBytes), ref: pkg.sbom.rel },
    license: { spdx: pkg.spdx, file: pkg.licenseFile, ...(pkg.notices ? { notices: pkg.notices } : {}) },
    meta: { category: String(meta.category), channel: "bundled", description, label: pkg.toolId, status: meta.metaStatus ?? (SETTINGS_PREVIEW_LANES.has(pkg.toolId) ? "settings-preview-enabled" : "disabled-no-host"), note: meta.metaNote ?? `evidence: packages/bundled/evidence/${pkg.lane}; owner decision CAP-DECISION-TEMPLATE-20260822-06` },
  };
  const canonical = canonicalJson(manifest);
  const validated = probe.validateManifest(canonical);
  if (!validated.ok) throw new Error(`generated manifest failed validation for ${pkg.toolId}: ${validated.error} ${validated.path ?? ""} ${validated.detail ?? ""}`);
  // Re-audit with the FINAL declared values exactly as admission will.
  auditWasmBinary(pkg.bytes, manifest.executables[0], {});
  const manifestRel = `extension/wasm/manifests/${manifest.package.id}-${pkgVersion}.manifest.json`;
  ship(manifestRel, enc.encode(canonical));
  inventoryManifests.push({ pkg: manifest.package.id, version: pkgVersion, digest: validated.manifestDigest });

  const settingsPreview = SETTINGS_PREVIEW_LANES.has(pkg.toolId);
  // The ADMITTED rows keep their TRUE per-tool caveats; ONLY the stale
  // pre-admission phrases are surgically removed, then a generic Settings-only
  // sentence is appended to every admitted row and the file.read-declared-
  // but-denied sentence ONLY to rows whose caps include file.read (markdown).
  const STALE_PRE_ADMISSION_PHRASES = [
    "implementation/provenance still pending owner admission",
    "If narrowed to stdin-only in product integration, that contract requires an explicit adapter check",
    "Requires future reviewed execution adapter; not currently executable/admitted.",
    "Requires future reviewed execution adapter to map only exact per-job CAP OPFS authority to WASI /job; not currently executable/admitted",
    "Requires future reviewed execution adapter to enforce path classes; not currently executable/admitted.",
    "Requires future reviewed execution adapter to enforce bounded path classes and reject symlink following; not currently executable/admitted.",
    "Requires future reviewed execution adapter to restrict writes to mutable path classes and enforce traversal and quota fail-closed rules. Not currently executable/admitted.",
    "Requires future reviewed execution adapter to restrict writes to approved mutable path classes (scratch/output, never immutable inputs), and enforce symlink, cross-job, and over-quota rejection fail closed. Not currently executable/admitted.",
  ];
  const FILE_STREAM_TOOLS = new Set(["base64", "wc", "tr", "grep", "uniq", "sort", "sed", "awk", "jq"]);
  const FILE_STREAM_CAVEAT =
    "Model and Settings execution use owner-bound OPFS input/output references; large results return a complete size and SHA-256 receipt instead of truncation, and can feed the next tool by reference.";
  const GENERIC_ADMITTED_CAVEAT =
    "Settings preview requires an explicit owner click; model execution remains subject to run ownership and live package revalidation.";
  const STAT_ADMITTED_CAVEAT =
    "Settings preview requires an explicit owner click and model execution requires live run ownership; both read only the immutable in-memory inputs/f.bin job seed.";
  const DU_ADMITTED_CAVEAT =
    "Settings preview requires an explicit owner click and model execution requires live run ownership; both enumerate only the immutable inputs/f.bin job seed, using /job by default.";
  const TREE_ADMITTED_CAVEAT =
    "Settings preview requires an explicit owner click and model execution requires live run ownership; both enumerate only the immutable nested /job/inputs seed.";
  const GZIP_ADMITTED_CAVEAT =
    "Settings preview represents lossless binary output as canonical base64; file-backed model execution keeps binary stdout as an owner-bound OPFS reference.";
  const TRUNCATE_ADMITTED_CAVEAT =
    "Execution is confined to the spec-owned scratch/touched fixture; the observable mutation is the post-run stat readback. Settings requires an owner click and model execution requires live run ownership.";
  const TOUCH_ADMITTED_CAVEAT = TRUNCATE_ADMITTED_CAVEAT;
  const SQLITE_ADMITTED_CAVEAT =
    "Execution is confined to the spec-owned scratch/test.db fixture; readOnly is forced and the guest authorizer denies writes. Settings requires an owner click and model execution requires live run ownership.";
  const FILE_READ_DECLARED_CAVEAT = pkg.toolId === "stat"
    ? "file.read is confined to the immutable per-job inputs/f.bin seed; path normalization and read-only inputs rights prevent escape, mutation, persistence, and cross-job access."
    : pkg.toolId === "du"
    ? "file.read is confined to bounded recursive enumeration of the immutable per-job inputs/f.bin seed; path normalization and read-only inputs rights prevent escape, mutation, persistence, and cross-job access."
    : pkg.toolId === "tree"
    ? "file.read is confined to bounded recursive enumeration of the immutable nested per-job inputs seed; path normalization and read-only inputs rights prevent escape, mutation, persistence, and cross-job access."
    : pkg.toolId === "truncate"
    ? "file.read/write is confined to the spec-owned scratch/touched fixture (0..10 MiB); path normalization and the scratch class rights prevent escape, persistence, and cross-job access."
    : pkg.toolId === "touch"
    ? "file.read/write is confined to the spec-owned scratch/touched fixture (bounded epoch timestamps); path normalization and the scratch class rights prevent escape, persistence, and cross-job access."
    : pkg.toolId === "sqlite3_query_bounded"
    ? "file.read/write is confined to the spec-owned scratch/test.db fixture (readOnly forced — the DB file is never written); path normalization and the scratch class rights prevent escape, persistence, and cross-job access."
    : "file.read remains declared in the manifest; the route projects NO files into the fresh empty per-job workspace, so a file operand cannot read owner data and fails closed (path normalization prevents escape/cross-job).";
  const cleanedCaveats = (Array.isArray(meta.caveats) ? meta.caveats : []).map((caveat) => {
    let out = String(caveat);
    for (const phrase of STALE_PRE_ADMISSION_PHRASES) {
      const at = out.indexOf(phrase);
      if (at !== -1) out = out.slice(0, at).replace(/[.;]\s*$/, "");
    }
    return out.replace(/\s{2,}/g, " ").trim();
  }).filter(Boolean);
  const admittedCaveats = [
    ...cleanedCaveats,
    FILE_STREAM_TOOLS.has(pkg.toolId) ? FILE_STREAM_CAVEAT
      : pkg.toolId === "stat" ? STAT_ADMITTED_CAVEAT
      : pkg.toolId === "du" ? DU_ADMITTED_CAVEAT
      : pkg.toolId === "tree" ? TREE_ADMITTED_CAVEAT
      : pkg.toolId === "gzip" ? GZIP_ADMITTED_CAVEAT
      : pkg.toolId === "truncate" ? TRUNCATE_ADMITTED_CAVEAT
      : pkg.toolId === "touch" ? TOUCH_ADMITTED_CAVEAT
      : pkg.toolId === "sqlite3_query_bounded" ? SQLITE_ADMITTED_CAVEAT
      : GENERIC_ADMITTED_CAVEAT,
    ...(capabilities.includes("file.read") ? [FILE_READ_DECLARED_CAVEAT] : []),
  ];
  const disabledCaveats = Array.isArray(meta.caveats) ? meta.caveats : [];
  descriptorRows.push({
    packageId: manifest.package.id, version: pkgVersion, toolId: pkg.toolId, lane: pkg.lane,
    displayName: String(pkg.toolId), category: String(meta.category),
    description, caveats: settingsPreview ? admittedCaveats : disabledCaveats,
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
emit(join(REPO, "extension/lib/bundled-inventory-data.js"), `${banner}export const BUNDLED_INVENTORY = Object.freeze(${JSON.stringify(inventory, null, 1)});\n`);
emit(join(REPO, "extension/lib/bundled-tool-packages.data.js"), `${banner}export const BUNDLED_TOOL_PACKAGE_ROWS = Object.freeze(${JSON.stringify(descriptorRows, null, 1)});\n`);

// ── packages/bundled/: exact build scripts + provenance ─────────────────────
const scriptSources = { a2: join(PATHS.a2, "build.sh"), b2: join(PATHS.b2, "build.sh"), c2: join(PATHS.c2, "scripts/build.sh") };
for (const [lane, src] of Object.entries(scriptSources)) {
  if (!VERIFY) mkdirSync(join(REPO, `packages/bundled/${lane}`), { recursive: true });
  emit(join(REPO, `packages/bundled/${lane}/build.sh`), readFileSync(src));
}
if (!VERIFY) mkdirSync(join(REPO, "packages/bundled/csvtool"), { recursive: true });
emit(join(REPO, "packages/bundled/csvtool/build.sh"), `#!/usr/bin/env bash
# Reconstructed from the EXACT command recorded in the clean-room evidence
# (packages/bundled/evidence/csvtool, REPORT.md line 24 in the original
# provenance tree; toolchain clang/LLD 22.1.8,
# SOURCE_DATE_EPOCH=0 via scripts/safe-build-env.sh). Two builds must be
# byte-identical: sha256 5c8210c93d390893f961943093ccad314e87500b29eafe9f166b0b3327333d81.
set -euo pipefail
clang --target=wasm32 -std=c17 -O2 -Wall -Wextra -Werror -nostdlib -fno-builtin \\
  -Wl,--no-entry,--initial-memory=131072,--max-memory=33554432,--export-memory,--stack-first,-z,stack-size=65536,--strip-all \\
  -o csvtool.wasm source/csvtool.c
`);
if (!VERIFY) mkdirSync(join(REPO, "packages/bundled/gzip"), { recursive: true });
emit(join(REPO, "packages/bundled/gzip/build.sh"), `#!/usr/bin/env bash
# gzip (zlib 1.3.1 Z_SOLO minigzip + CAP-authored freestanding runtime).
# The exact units/flags/two-build evidence is the retained receipt
# receipts/gzip-build.json inside the pinned evidence tree
# (packages/bundled/evidence/d3, inventory sha256 7ddeea056eec79eaa0c496522297d9f381293532816f2085611c027584482af9);
# toolchain clang 22.1.8 / wasm-ld 22.1.8, target wasm32-unknown-unknown,
# SOURCE_DATE_EPOCH=1716422400. Both trusted builds were byte-identical:
# sha256 d03a2558682ea04653d34753eae8df1fcd5cc8d92fc53de43106c3db0e1c57dc (56,938 B).
# This script intentionally does NOT re-run the build: reproduction requires
# the pinned source archive + overlay recorded in that receipt.
echo "see receipts/gzip-build.json in the frozen evidence tree" >&2; exit 0
`);
for (const lane of ["awk", "date"]) {
  if (!VERIFY) mkdirSync(join(REPO, `packages/bundled/${lane}/source`), { recursive: true });
  emit(join(REPO, `packages/bundled/${lane}/build.sh`), readFileSync(join(PATHS[lane], "build.sh")));
  emit(join(REPO, `packages/bundled/${lane}/source/main.c`), readFileSync(join(PATHS[lane], "source/main.c")));
  emit(join(REPO, `packages/bundled/${lane}/PROVENANCE.md`), readFileSync(join(PATHS[lane], "PROVENANCE.md")));
}
if (!VERIFY) mkdirSync(join(REPO, "packages/bundled/sed/source"), { recursive: true });
emit(join(REPO, "packages/bundled/sed/build.sh"), readFileSync(join(PATHS.sed, "build.sh")));
for (const file of ["sed.h", "sedcomp.c", "sedexec.c"]) {
  emit(join(REPO, `packages/bundled/sed/source/${file}`), readFileSync(join(PATHS.sed, `source/${file}`)));
}
emit(join(REPO, "packages/bundled/sed/PROVENANCE.md"), readFileSync(join(PATHS.sed, "PROVENANCE.md")));
if (!VERIFY) mkdirSync(join(REPO, "packages/bundled/jq/source"), { recursive: true });
emit(join(REPO, "packages/bundled/jq/build.sh"), readFileSync(join(PATHS.jq, "build.sh")));
for (const file of ["pthread-shim.c", "pthread-shim.h"]) {
  emit(join(REPO, `packages/bundled/jq/source/${file}`), readFileSync(join(PATHS.jq, `source/${file}`)));
}
emit(join(REPO, "packages/bundled/jq/PROVENANCE.md"), readFileSync(join(PATHS.jq, "PROVENANCE.md")));
if (!VERIFY) {
  mkdirSync(join(REPO, "packages/bundled/sqlite3/src"), { recursive: true });
  mkdirSync(join(REPO, "packages/bundled/sqlite3/host"), { recursive: true });
}
emit(join(REPO, "packages/bundled/sqlite3/src/sqlite3_query_main.c"), readFileSync(join(SQLITE_EVIDENCE, "src/sqlite3_query_main.c")));
for (const f of ["quota-sink.mjs", "run-query.mjs", "wasi-worker.mjs"]) {
  emit(join(REPO, `packages/bundled/sqlite3/host/${f}`), readFileSync(join(SQLITE_EVIDENCE, `host/${f}`)));
}
emit(join(REPO, "packages/bundled/sqlite3/build.sh"), `#!/usr/bin/env bash
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
emit(join(REPO, "packages/bundled/sqlite3/PROVENANCE.json"), JSON.stringify({
  schemaVersion: 1,
  package: "cap.bundled.sqlite3-query-bounded",
  upstream: { name: "SQLite", version: "3.46.0", archiveRel: "sources/archives/sqlite-amalgamation-3460000.zip", archiveSha256: SQLITE_EXPECT.archive.sha256, license: "blessing" },
  authored: { license: "Apache-2.0", files: {
    "src/sqlite3_query_main.c": SQLITE_EXPECT.sources["src/sqlite3_query_main.c"],
    "host/quota-sink.mjs": SQLITE_EXPECT.sources["host/quota-sink.mjs"],
    "host/run-query.mjs": SQLITE_EXPECT.sources["host/run-query.mjs"],
    "host/wasi-worker.mjs": SQLITE_EXPECT.sources["host/wasi-worker.mjs"] } },
  binary: { sha256: SQLITE_EXPECT.wasm.sha256, bytes: SQLITE_EXPECT.wasm.bytes, tier: "tiny", memoryPages: { initial: 64, max: 512 }, importModule: "wasi_snapshot_preview1", importedFunctions: 24, capRuntimeGap: ["fd_filestat_set_size","fd_sync","path_create_directory","path_filestat_set_times","path_readlink","path_remove_directory","path_unlink_file","poll_oneoff"] },
  buildReceipts: { byteIdentical: true, sqliteOmitAttachAbsent: true, sqliteOmitLoadExtension: true, toolchain: "wasi-sdk clang 18.1.2" },
  licenseExpression: "blessing AND Apache-2.0",
  blessingNoticeSha256: SQLITE_EXPECT.blessing.sha256,
  posture: { admitted: false, canonicalNameClaim: false, disabled: true, disabledReason: "runtime-imports-unimplemented" }
}, null, 1) + "\n");
emit(join(REPO, "packages/bundled/sqlite3/README.md"), `# sqlite3-query-bounded (bundled package 26, DISABLED)

SQLite 3.46.0 amalgamation (upstream Blessing) + CAP-authored wrapper/host
(Apache-2.0); licence expression "blessing AND Apache-2.0". Physically bundled
and inventory-admissible; NOT executable in this release: the binary imports 24
WASI functions, eight of which the CAP runtime does not yet implement (see
PROVENANCE.json binary.capRuntimeGap; fd_fdstat_set_flags is linkage-only
callable but UNAUTHORIZED — its change semantics are unsupported). No route,
grant, or catalog entry
consumes this package. Node host sources under host/ are public Apache-2.0
provenance only — they are not shipped runtime code.
`);
emit(join(REPO, "packages/bundled/README.md"), `# Bundled tool packages (immutable; 31-tool execution tranche)

31 single-tool Wasm packages generated by \`scripts/build-bundled-tool-packages.mjs\`
from the pinned, independently reviewed evidence trees committed under
\`packages/bundled/evidence/\` (catalog inventory sha256 ${catalogSha}).

- Binaries ship content-addressed in \`extension/wasm/cas/<sha256>.wasm\`.
- Manifests are authority-schema-exact canonical JSON in \`extension/wasm/manifests/\`.
- SBOMs and licence texts ship in \`extension/wasm/sbom/\` and \`extension/wasm/licenses/\`.
- The admission inventory is \`extension/lib/bundled-inventory-data.js\` (generated).
- Every descriptor in \`extension/lib/bundled-tool-packages.data.js\` is
  \`admitted:true\` + \`settingsPreview:true\`: \`csvtool\`, \`uuid\`, \`head\`,
  \`tail\`, \`cut\`, \`base64\`, \`md5sum\`, \`sha256sum\`, \`sha512sum\`, \`wc\`,
  \`xxd\`, \`sort\`, \`uniq\`, \`tr\`, \`grep\`, \`toml2json\`, \`markdown\`,
  \`diff\`, \`patch\`, \`stat\`, \`du\`, \`tree\`, \`gzip\`, \`truncate\`,
  \`touch\`, \`sqlite3_query_bounded\`, \`awk_filter_bounded\`,
  \`date_formatter_bounded\`, \`sed\`, \`awk\`, and \`jq\`.
- Settings preview execution requires an explicit owner click. Model calls use
  the lazy selection authority and live run fence. Both resolve the toolId
  through the immutable spec map and revalidate manifest, inventory, CAS,
  imports, memory, and capabilities at every run.
- \`base64\`, \`wc\`, \`sort\`, \`uniq\`, \`tr\`, \`grep\`, \`sed\`, \`awk\`, and
  \`jq\` use owner-bound OPFS stdin/stdout. Large results are complete
  file-backed artifacts with byte count and SHA-256 receipts and can chain by
  opaque reference; no result is silently sliced to fit a Chrome message.

Provenance anchor: source.repo is the public platform repo at commit
5e086c1fb0847ddccf1a16ba3129a4cf900eac8f (the landing base); binary identity is
content-addressed and hash-pinned in every manifest. Upstream provenance
(zlib 51b7f2ab, cmark 0.31.1, tomlc99, GNU-bound blocked tools) is recorded in
the evidence inventories and the owner decision template
CAP-DECISION-TEMPLATE-20260822-06.
`);

if (VERIFY) {
  // Zero-drift assertion over EVERY generated output, fail closed:
  //   (a) each emitted file must exist on disk byte-identically;
  //   (b) the two generator-owned trees (extension/wasm, packages/bundled)
  //       must contain NO file the generator did not emit.
  const drift = [];
  for (const [rel, bytes] of emitted) {
    const abs = join(REPO, rel);
    if (!existsSync(abs)) { drift.push(`missing: ${rel}`); continue; }
    if (!readFileSync(abs).equals(bytes)) drift.push(`byte-drift: ${rel}`);
  }
  const walk = (dirRel) => {
    const out = [];
    const absDir = join(REPO, dirRel);
    if (!existsSync(absDir)) return out;
    for (const ent of readdirSync(absDir, { withFileTypes: true })) {
      const childRel = `${dirRel}/${ent.name}`;
      if (ent.isDirectory()) out.push(...walk(childRel));
      else out.push(childRel);
    }
    return out;
  };
  for (const rootRel of ["extension/wasm", "packages/bundled"]) {
    for (const rel of walk(rootRel)) {
      // packages/bundled/evidence/** is generator INPUT (the pinned evidence
      // trees), not generated output — exclude it from the ungenerated sweep.
      if (rel.startsWith("packages/bundled/evidence/") ||
          rel.startsWith("packages/bundled/unix-stream-v1/") ||
          rel.startsWith("packages/bundled/awk-posixutils-v1/")) continue;
      if (!emitted.has(rel)) drift.push(`ungenerated file present: ${rel}`);
    }
  }
  if (drift.length > 0) {
    console.error(`bundled-tool VERIFY FAILED — generated outputs drifted (${drift.length}):`);
    for (const d of drift) console.error(`  ${d}`);
    console.error("regenerate deliberately with: node build.mjs --target=store --regen-tools");
    process.exit(1);
  }
  console.log(`VERIFY OK: ${emitted.size} generated files byte-identical to the committed tree`);
}

console.log(`OK: ${packages.length} packages, ${inventoryFiles.length} shipped files, ${inventoryManifests.length} manifest identities`);
