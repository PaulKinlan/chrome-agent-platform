// lib/tool-exec-preview.js — Settings-only bounded Wasm tool execution
// (CAP-FB-20260822-TOOL-PREVIEW-EXEC-01/02/03/04). The technically-admitted
// static allowlist of bundled packages (31 tools) may be run from the
// exact Settings options document by an EXPLICIT owner click.
//
// Invariants:
//   - NO package catalog/provider selection authority: the catalog summary stays
//     metadata-only; there is no selection route, no provider binding, no
//     capability grant — the preview is a self-contained owner-requested run.
//   - IMMUTABLE revalidation at every execution: the bundled manifest is
//     re-parsed + re-validated through the REAL authority, its digest must
//     equal the immutable inventory row, and the CAS bytes must re-match the
//     manifest executable's sha256 + size; auditWasmBinary re-checks
//     imports/memory; capabilities are re-verified against the manifest.
//   - STRICT bounds: args/stdin/output/wall-time are bounded by PREVIEW_LIMITS;
//     the executor's own bounds still apply on the worker side.
//   - This module is scanner-clean: no `new Worker`, no `WebAssembly.` direct
//     calls — the fresh-Worker execution lives in the canonical executor/
//     offscreen host (scanner-owned exemptions), reached only through the
//     reviewed offscreen document.

import { createWasiJob } from "./wasm-host-types.js";
import { EXECUTOR_BOUNDS } from "./wasm-executor-bounds.js";
import { decodeCanonicalBase64 } from "./wasm-base64.js";

// The wasm-bytes cap = the executor's maxWasmBytes (the tiny-tier max, 4 MiB —
// the B2 tools are 164–325 KB); the METADATA/request JSON cap (maxRequestBytes
// 64 KiB) is enforced separately and independently.
const EXECUTOR_WASM_MAX_BYTES = EXECUTOR_BOUNDS.maxWasmBytes;
import {
  WasmPackageAuthority,
  auditWasmBinary,
  WASM_PACKAGE_LIMITS,
} from "./wasm-package-authority.js";

export const PREVIEW_LIMITS = Object.freeze({
  // dptw: no byte/arg ceilings on the settings preview — stdin/stdout/stderr
  // and the rendered output text carry complete data. wallMs stays: a hung
  // preview must still time out.
  maxStdinBytes: Number.POSITIVE_INFINITY,
  maxStdoutBytes: Number.POSITIVE_INFINITY,
  maxStderrBytes: Number.POSITIVE_INFINITY,
  wallMs: 5000,
  maxOutputTextBytes: Number.POSITIVE_INFINITY,
});

import { BUNDLED_TOOL_PACKAGE_ROWS } from "./bundled-tool-packages.data.js";
import { BUNDLED_INVENTORY } from "./bundled-inventory-data.js";

// The immutable trusted spec map for the Settings-only preview allowlist. It is
// DERIVED at module load from the generated immutable descriptor rows (only the
// `settingsPreview:true` rows) — the toolId is the ONLY request-borne input and
// it resolves HERE (packageId, manifest rel, CAS SHA/size, caps, argv0). The
// request never carries bytes, digests or capabilities; every run re-validates
// the manifest + CAS through the REAL package authority.
// diff/patch take the two documents as argv[1..2] (the current binaries'
// contract — strlen-based C strings, multiline legal, NUL truncates by C
// semantics); their per-arg bound is EXACTLY the createWasiJob 1024-byte cap
// (2 docs + flags fit the 2048 total; the global host schema is unchanged).
// dptw (2026-09-03): no argv/stdin byte ceilings. The per-tool SHAPE rules
// stay (gzip's two modes, the diff/patch BOM guard, NUL rejection — argv is a
// C-string surface), but no size limit refuses complete input.

export const PREVIEW_SPECS = Object.freeze(
  Object.fromEntries(
    BUNDLED_TOOL_PACKAGE_ROWS
      .filter((row) => row?.settingsPreview === true && row?.admitted === true)
      .map((row) => [
        row.toolId,
        Object.freeze({
          packageId: row.packageId,
          toolId: row.toolId,
          manifestRel: row.manifestRef.startsWith("extension/")
            ? row.manifestRef.slice("extension/".length)
            : row.manifestRef,
          casRel: `wasm/cas/${row.binary?.sha256}.wasm`,
          casSha: row.binary?.sha256,
          size: row.binary?.bytes,
          // az4k: the tool's DECLARED memory tier rides the spec (from the
          // generated row — never the request). The job worker audits the
          // binary against the job's tier ceiling; a default-tier binary
          // (2048 pages: compressops, zxing, oxipng) under a hardcoded tiny
          // job (512) was memory-rejected on every live run. The large tier
          // is never a job tier (createWasiJob refuses it).
          tier: row.binary?.tier === "default" ? "default" : "tiny",
          maxPages: row.binary?.maxPages,
          caps: Object.freeze([...(row.capabilities ?? [])].sort()),
          argv0: row.toolId,
          // The immutable acceptedExitCodes: diff's exit 1 means differences
          // found; grep's exit 1 means no selected lines. Both are normal,
          // useful results. Everything else accepts only exit 0. This is never
          // request-borne — the SW copies it into the trusted job envelope.
          acceptedExitCodes: row.toolId === "diff" || row.toolId === "grep"
            ? Object.freeze([0, 1]) : Object.freeze([0]),
          // Default output policy is immutable spec authority. gzip always uses
          // the lossless binary arm; base64 decode selects that same arm from
          // its validated trusted argv through previewStdoutEncoding().
          // Binary-at-the-pipe tools emit base64 (gzip always; imageops except
          // its info subcommand, resolved per-argv in previewStdoutEncoding).
          stdoutEncoding: row.toolId === "gzip" || row.toolId === "imageops" || row.toolId === "zxing" ? "base64" : "utf8",
          ...(row.toolId === "gzip" ? {
            allowedArgs: Object.freeze([
              Object.freeze([]),
              Object.freeze(["-d"]),
            ]),
          } : {}),
          // Immutable per-tool workspace seeds. stat/du retain their minimum
          // deterministic input; tree alone gets the nested seed required to
          // exercise directory synthesis. Specs hold FROZEN DENSE PLAIN byte
          // arrays — never mutable Uint8Arrays — so this authority is deep immutable.
          workspaceSeed: row.toolId === "tree"
            ? Object.freeze({ files: Object.freeze([
              Object.freeze({ path: "inputs/f.bin", bytes: Object.freeze([104, 105]) }),
              Object.freeze({ path: "inputs/sub/g.txt", bytes: Object.freeze([103]) }),
            ]) })
            : row.toolId === "stat" || row.toolId === "du"
            ? Object.freeze({ files: Object.freeze([Object.freeze({ path: "inputs/f.bin", bytes: Object.freeze([104, 105]) })]) })
            : row.toolId === "truncate" || row.toolId === "touch"
            ? Object.freeze({ files: Object.freeze([Object.freeze({ path: "scratch/touched", bytes: Object.freeze([]) })]) })
            : row.toolId === "sqlite3_query_bounded"
            ? Object.freeze({ files: Object.freeze([Object.freeze({ path: "scratch/test.db", bytes: Object.freeze([83,81,76,105,116,101,32,102,111,114,109,97,116,32,51,0,16,0,1,1,0,64,32,32,0,0,0,2,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,4,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,46,138,20,13,0,0,0,1,15,189,0,15,189,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,65,1,6,23,23,23,1,99,116,97,98,108,101,105,116,101,109,115,105,116,101,109,115,2,67,82,69,65,84,69,32,84,65,66,76,69,32,105,116,101,109,115,32,40,110,97,109,101,32,84,69,88,84,44,32,113,116,121,32,73,78,84,69,71,69,82,41,13,0,0,0,2,15,236,0,15,246,15,236,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,8,2,3,21,1,98,101,116,97,2,8,1,3,23,9,97,108,112,104,97]) })]) })
            : Object.freeze({ files: Object.freeze([]) }),
          // Recursive readers alone have immutable safe default operands. They
          // apply only when the owner leaves generic Arguments empty and are
          // never request-borne package/capability/seed/exit authority.
          ...(row.toolId === "du"
            ? { defaultArgs: Object.freeze(["/job"]) }
            : row.toolId === "tree"
            ? { defaultArgs: Object.freeze(["/job/inputs"]) }
            : row.toolId === "truncate"
            ? { defaultArgs: Object.freeze(["-s", "0", "/job/scratch/touched"]) }
            : row.toolId === "touch"
            ? { defaultArgs: Object.freeze(["-t", "0", "/job/scratch/touched"]) }
            : {}),
        }),
      ]),
  ),
);
export const PREVIEW_TOOL_IDS = Object.freeze(Object.keys(PREVIEW_SPECS).sort());
// 6s2c: imageops joins the stream-backed set — the ONLY live-execution lane for
// bundled tools in a run (the Settings-preview worker path cannot exist in the
// service worker, so a non-stream tool fails closed as wasi_task_host_unavailable).
export const STREAM_BACKED_BUNDLED_TOOL_IDS = Object.freeze([
  "awk", "base64", "grep", "imageops", "jq", "sed", "sort", "tr", "uniq", "wc",
]);
export function isStreamBackedBundledTool(toolId) {
  return STREAM_BACKED_BUNDLED_TOOL_IDS.includes(toolId);
}

/** Error message when a preview-only tool is invoked in a live agent task. */
export function previewOnlyToolError(toolId) {
  return `preview_only_tool: ${toolId} is available in Settings preview, not in live agent tasks`;
}

/** Fail-closed envelope for live invocation of a preview-only bundled tool. */
export function previewOnlyToolEnvelope(toolId) {
  return Object.freeze({
    ok: false,
    phase: "failed",
    error: previewOnlyToolError(toolId),
    code: "preview_only_tool",
    stdoutEncoding: "utf8",
    stdout: "",
    stdoutBase64: null,
    stdoutBytes: 0,
    stderr: "",
    errno: null,
    exitCode: null,
  });
}

export function previewSpecFor(toolId) {
  return PREVIEW_SPECS[toolId] ?? null;
}

/** Resolve mode-sensitive output typing from trusted, validated argv. */
export function previewStdoutEncoding(toolId, inputArgs = []) {
  const spec = previewSpecFor(toolId);
  if (!spec || !Array.isArray(inputArgs)) fail("preview_args");
  if (toolId === "imageops") {
    // info emits a small JSON line (utf8); resize/convert emit image bytes
    // (base64 at the tool boundary).
    return inputArgs[0] === "info" ? "utf8" : "base64";
  }
  if (toolId === "zxing") {
    // read emits JSON lines (utf8); write emits PNG bytes (base64 at the
    // tool boundary).
    return inputArgs[0] === "read" ? "utf8" : "base64";
  }
  return toolId === "base64" && inputArgs.length === 1 &&
      (inputArgs[0] === "-d" || inputArgs[0] === "--decode")
    ? "base64"
    : spec.stdoutEncoding;
}

export function wasmStreamOutputDescriptor(toolId, inputArgs = []) {
  const encoding = previewStdoutEncoding(toolId, inputArgs);
  return Object.freeze(encoding === "base64"
    ? { type: "binary", mediaType: "application/octet-stream" }
    : { type: "utf8", mediaType: "text/plain;charset=utf-8" });
}

/** Resolve the exact argv vector used by both inline preview and file-backed
 * execution. Defaults therefore cannot drift between the two hosts. jq runs
 * against file-backed stdout, so disable terminal colour unless the caller
 * explicitly requests colour with -C/--color-output. */
export function previewWasiArgs(toolId, inputArgs) {
  const spec = previewSpecFor(toolId);
  if (!spec || !Array.isArray(inputArgs)) fail("preview_args");
  const selected = inputArgs.length === 0 && spec.defaultArgs
    ? [...spec.defaultArgs]
    : [...inputArgs];
  if (toolId === "jq") {
    const explicitColour = selected.some((arg) => arg === "--color-output" || /^-[^-]*C/u.test(arg));
    const explicitMono = selected.some((arg) => arg === "--monochrome-output" || /^-[^-]*M/u.test(arg));
    if (!explicitColour && !explicitMono) selected.unshift("-M");
  }
  return Object.freeze([spec.argv0, ...selected]);
}
// The reserved https origin representing the exact Settings surface in the WASI
// job context (boundedOrigin accepts http(s) only — chrome-extension:// cannot
// be a WASI job origin). Never routable, never a web origin.
export const PREVIEW_SETTINGS_ORIGIN = "https://settings.cap";

const HEX64_RE = /^[0-9a-f]{64}$/u;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const encoder = new TextEncoder();

function fail(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function plainData(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function utf8Bytes(value) {
  return encoder.encode(String(value)).byteLength;
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function randomHex(bytes) {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The explicit wasm-bytes transport: Chrome runtime messaging JSON-serializes
// typed arrays, so a Uint8Array never arrives as `instanceof Uint8Array` on the
// receiving side. The SW sends an explicit Array.from(casBytes) array and the
// options host STRICTLY validates + rehydrates it before the host contract
// (which requires a genuine Uint8Array). Bound: 8 bytes .. maxWasmBytes
// (4 MiB — the B2 binaries exceed the old 64 KiB metadata cap and MUST
// transport at the wasm cap; the metadata JSON cap stays 64 KiB separately).
export function rehydratePreviewWasmBytes(value) {
  if (!Array.isArray(value) || value.length < 8 ||
      value.length > EXECUTOR_WASM_MAX_BYTES) {
    fail("preview_wasm_transport");
  }
  const out = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const byte = value[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      fail("preview_wasm_transport");
    }
    out[index] = byte;
  }
  return out;
}

// The stdin transport rehydration: createWasiJob on the SW side emits the
// stdin as a FROZEN PLAIN byte array, which the generic offscreen-host contract
// (createWasiJob) rejects (it requires a genuine Uint8Array). The options host
// STRICTLY validates + rehydrates a dense byte array (0..maxStdinBytes, every
// element an integer 0..255, no holes) and clones the job before handleJob.
export function rehydratePreviewStdin(value) {
  if (!Array.isArray(value)) fail("preview_stdin_transport");
  if (value.length > PREVIEW_LIMITS.maxStdinBytes) fail("preview_stdin_transport");
  const out = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const byte = value[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      fail("preview_stdin_transport");
    }
    out[index] = byte;
  }
  return out;
}

/** The route's LOCAL extraction from the runtime message. The global
 * dispatcher passes the message body (which carries `type`) straight to the
 * handler, so the strict validator would reject it; this extracts ONLY
 * `args` + `stdin` so the standard `{type,args,stdin}` message works and ANY
 * extra key (hostile or accidental) can never reach the validator/executor.
 * The global dispatch is deliberately NOT modified. */
export function extractPreviewInput(message) {
  if (!plainData(message)) return message; // let the validator reject the shape
  return { toolId: message.toolId, args: message.args, stdin: message.stdin };
}

/** The R12 sqlite stdin discipline: an exact-key plain JSON {sql, params,
 * database, readOnly}; `database` pinned to the spec fixture `test.db`;
 * `readOnly` FORCED true; the canonical fresh-object re-serialization is the
 * SINGLE 2 KiB total gate (the `sql` ≤ 1792 + `params` ≤ 512 + the ≤ 8-count
 * field maxima are NOT simultaneously reachable). */
function parseSqliteInput(raw) {
  if (typeof raw !== "string") fail("preview_sqlite_shape");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("preview_sqlite_shape");
  }
  if (!plainData(parsed)) fail("preview_sqlite_shape");
  if (
    JSON.stringify(Object.keys(parsed).sort()) !==
    JSON.stringify(["database", "params", "readOnly", "sql"].sort())
  ) fail("preview_sqlite_shape");
  const { sql, params, database, readOnly } = parsed;
  if (typeof sql !== "string") fail("preview_sqlite_shape");
  if (database !== "test.db") fail("preview_sqlite_database");
  if (readOnly !== true) fail("preview_sqlite_readonly");
  if (!Array.isArray(params)) fail("preview_sqlite_params");
  const canonical = JSON.stringify({ sql, params, database, readOnly });
  return Object.freeze({ sql, params: Object.freeze([...params]), database, readOnly, canonical });
}

/** The STRICT exact-key bounded preview request: ONLY `toolId` + `args` +
 * `stdin`. Nothing else may reach the executor (no fences, no package bytes,
 * no capability claims — the SW supplies those). The toolId MUST resolve in
 * the immutable spec map; unknown tools fail closed. */
export function validatePreviewInput(raw) {
  if (!plainData(raw)) fail("preview_request_shape");
  if (
    JSON.stringify(Object.keys(raw).sort()) !==
    JSON.stringify(["args", "stdin", "toolId"].sort())
  ) fail("preview_request_shape");
  const spec = previewSpecFor(raw.toolId);
  if (!spec) fail("preview_unknown_tool");
  if (!Array.isArray(raw.args)) {
    fail("preview_args");
  }
  // gzip is intentionally not a generic argv surface: only exact compress []
  // and decompress ["-d"] modes are admitted, before any Worker can spawn.
  if (raw.toolId === "gzip" && !spec.allowedArgs.some(
    (allowed) => JSON.stringify(allowed) === JSON.stringify(raw.args),
  )) fail("preview_args");
  // The leading-BOM rejection is scoped to the two-document tools ONLY: the
  // diff/patch binaries are NUL/C-string argv consumers where a BOM would
  // corrupt argv[0]-adjacent parsing. The predecessor 17 keep their exact
  // prior argv behavior (a leading BOM in an arg is accepted as before).
  // dptw: no per-arg or total byte ceilings.
  const rejectLeadingBom = raw.toolId === "diff" || raw.toolId === "patch";
  const args = raw.args.map((arg) => {
    if (typeof arg !== "string" || arg.includes("\0")) fail("preview_args");
    if (rejectLeadingBom && arg.charCodeAt(0) === 0xfeff) fail("preview_args");
    return arg;
  });
  if (typeof raw.stdin !== "string") fail("preview_stdin");
  let sqliteInput = null;
  if (raw.toolId === "gzip") {
    if (args.length === 0) {
      // TextEncoder replaces malformed scalar values, so reject those values
      // first. A BOM or NUL is outside this intentionally narrow text mode.
      if (raw.stdin.charCodeAt(0) === 0xfeff || raw.stdin.includes("\0") ||
          hasLoneSurrogate(raw.stdin)) {
        fail("preview_gzip_text");
      }
    } else {
      try { decodeCanonicalBase64(raw.stdin); }
      catch { fail("preview_gzip_base64"); }
    }
  } else if (raw.toolId === "sqlite3_query_bounded") {
    // The sqlite stdin is the canonical JSON string (the shape/readOnly/
    // fixture/bounds validated inside).
    sqliteInput = parseSqliteInput(raw.stdin);
  } else {
    const stdinBytes = utf8Bytes(raw.stdin);
    if (stdinBytes > PREVIEW_LIMITS.maxStdinBytes) fail("preview_stdin");
  }
  // The validated toolId MUST survive (the SW resolves the spec from it — a
  // dropped toolId would make every allowlisted tool appear unknown).
  return Object.freeze({
    toolId: raw.toolId,
    args: Object.freeze(args),
    stdin: sqliteInput ? sqliteInput.canonical : raw.stdin,
  });
}

/** Build the host-bound authority fence record for a settings preview run.
 * The fences are synthesized by the trusted Settings surface (the SW route) —
 * never request-borne. `origin` is the extension's own origin.
 * @param {{ origin: string, documentId?: string, now?: (() => number) | null }} [options] */
export function buildPreviewAuthority({ origin, documentId = "settings-options", now = null } = {}) {
  if (typeof origin !== "string" || !origin) fail("preview_authority_origin");
  const at = (now ?? (() => Date.now()))();
  const executionId = `settings-${at.toString(36)}-${randomHex(4)}`;
  const callId = `preview-${randomHex(4)}`;
  if (!ID_RE.test(executionId) || !ID_RE.test(callId)) fail("preview_authority_id");
  return Object.freeze({
    sessionId: `settings-preview-${randomHex(6)}`,
    executionId,
    callId,
    agentId: "settings-owner",
    origin,
    documentId,
  });
}

/** Build the bounded WasiJob from a validated preview input + the authority. */
export function buildPreviewJob({ input, authority, quota = null }) {
  if (!plainData(authority) ||
      JSON.stringify(Object.keys(authority).sort()) !==
        JSON.stringify(["agentId", "callId", "documentId", "executionId", "origin", "sessionId"].sort()) ||
      typeof authority.executionId !== "string" ||
      typeof authority.callId !== "string" || typeof authority.origin !== "string") {
    fail("preview_authority");
  }
  // argv0 = the EXACT requested toolId (the WASI `_start` command convention
  // requires argv[0]). It is resolved from the validated input — never typed
  // by the UI and never request-borne beyond the allowlisted toolId.
  const spec = previewSpecFor(input.toolId);
  if (!spec) fail("preview_unknown_tool");
  const args = previewWasiArgs(input.toolId, input.args);
  let stdinBytes;
  if (input.toolId === "gzip" && input.args.length === 1) {
    try { stdinBytes = decodeCanonicalBase64(input.stdin); }
    catch { fail("preview_gzip_base64"); }
    if (stdinBytes.byteLength > spec.maxDecodedInputBytes) fail("preview_gzip_base64");
  } else {
    stdinBytes = encoder.encode(input.stdin);
  }
  const job = createWasiJob({
    // The spec's declared tier (az4k) — createWasiJob still refuses anything
    // but tiny/default, so a spec can never open the large tier.
    tier: spec.tier,
    context: {
      executionId: authority.executionId,
      callId: authority.callId,
      origin: authority.origin,
      workspaceRoot: `tool-jobs/${authority.executionId}/${authority.callId}/`,
    },
    args,
    stdin: stdinBytes,
    acceptedExitCodes: spec.acceptedExitCodes,
    stdoutEncoding: previewStdoutEncoding(input.toolId, input.args),
    workspaceSeed: spec.workspaceSeed,
    quota: quota ?? {
      // dptw: byte quotas are unbounded; the count guards stay (runaway guard).
      hostCalls: 50_000,
      pathCalls: 4096,
      stdinBytes: Number.POSITIVE_INFINITY,
      stdoutBytes: Number.POSITIVE_INFINITY,
      stderrBytes: Number.POSITIVE_INFINITY,
      fileBytes: Number.POSITIVE_INFINITY,
      fileSize: Number.POSITIVE_INFINITY,
      dynamicFds: 256,
    },
  });
  return job;
}

/** The immutable execution-time revalidation. Every check uses the REAL
 * authority + the immutable bundled manifest + the pinned CAS bytes. */
export async function revalidatePreviewExecution({
  toolId,
  manifestText,
  casBytes,
  inventory = null,
  limits = WASM_PACKAGE_LIMITS,
  now = null,
}) {
  if (typeof toolId !== "string" || typeof manifestText !== "string" ||
      !(casBytes instanceof Uint8Array)) {
    fail("preview_revalidate_input");
  }
  const spec = previewSpecFor(toolId);
  if (!spec) fail("preview_unknown_tool");
  const authority = new WasmPackageAuthority({ now: now ?? (() => Date.now()) });
  const validated = authority.validateManifest(manifestText);
  if (!validated?.ok) fail("preview_manifest_invalid", validated?.error ?? "");
  const manifest = validated.manifest;

  // The package identity must be the SPEC's pinned package — a substituted
  // manifest (or a toolId→package swap) fails closed.
  if (
    manifest?.package?.id !== spec.packageId ||
    manifest?.package?.type !== "tool-bundle"
  ) fail("preview_package_identity");

  // The manifest digest must equal the IMMUTABLE inventory row (when supplied).
  if (inventory && Array.isArray(inventory.manifests)) {
    const row = inventory.manifests.find(
      (candidate) => candidate?.pkg === spec.packageId,
    );
    if (!row || typeof row.digest !== "string" || !HEX64_RE.test(row.digest)) {
      fail("preview_inventory_row");
    }
    if (row.digest !== validated.manifestDigest) {
      fail("preview_manifest_drift");
    }
  }

  // The executables must contain exactly the spec's tool + no others.
  const executables = Array.isArray(manifest?.executables)
    ? manifest.executables
    : [];
  if (executables.length !== 1) fail("preview_executable_count");
  const executable = executables[0];
  if (
    !executable || executable?.id !== spec.toolId ||
    typeof executable?.sha256 !== "string" || !HEX64_RE.test(executable.sha256) ||
    !Number.isSafeInteger(executable?.size) || executable.size < 0
  ) fail("preview_executable");

  // The manifest executable's SHA/size must equal the SPEC's pinned values
  // (the immutable descriptor row) — a spec substitution fails closed.
  if (
    executable.sha256 !== spec.casSha ||
    executable.size !== spec.size
  ) fail("preview_spec_mismatch");

  // CAS bytes MUST re-match the manifest executable (sha256 + size) —
  // a substituted/truncated/grown binary fails closed.
  if (casBytes.byteLength !== executable.size) fail("preview_cas_size");
  const digest = await crypto.subtle.digest("SHA-256", casBytes).then(
    (d) => [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
  if (digest !== executable.sha256) fail("preview_cas_sha");

  // auditWasmBinary re-checks imports/memory/tier against the manifest.
  auditWasmBinary(casBytes, executable, { limits });

  // Capabilities must match the SPEC's declared set exactly (per-tool).
  const caps = Array.isArray(executable?.capabilities)
    ? executable.capabilities
    : [];
  if (
    JSON.stringify([...caps].sort()) !==
    JSON.stringify(spec.caps)
  ) fail("preview_capabilities");

  return Object.freeze({
    ok: true,
    executable,
    manifestDigest: validated.manifestDigest,
    casSha256: digest,
    casSize: casBytes.byteLength,
    memory: executable.memory ?? null,
    capabilities: Object.freeze(caps),
  });
}

/** Bind a result to trusted per-tool output authority for the Settings UI. */
export function boundPreviewResult(result, {
  stdoutEncoding,
  maxTextBytes = PREVIEW_LIMITS.maxOutputTextBytes,
} = {}) {
  if (!plainData(result)) fail("preview_result_shape");
  if (stdoutEncoding !== "utf8" && stdoutEncoding !== "base64") {
    fail("preview_result_encoding");
  }
  const boundedString = (value, label, limit = maxTextBytes) => {
    if (typeof value !== "string") fail(`preview_result_${label}`);
    if (utf8Bytes(value) > limit) fail(`preview_result_${label}_over_budget`);
    return value;
  };
  const ok = result.ok === true;
  let stdout;
  let stdoutBase64;
  let stdoutBytes;
  if (ok && stdoutEncoding === "utf8") {
    if (result.stdoutBase64 !== null || typeof result.stdout !== "string" ||
        !Number.isSafeInteger(result.stdoutBytes) || result.stdoutBytes < 0 ||
        utf8Bytes(result.stdout) !== result.stdoutBytes) fail("preview_result_stdout");
    stdout = boundedString(result.stdout, "stdout");
    stdoutBase64 = null;
    stdoutBytes = result.stdoutBytes;
  } else if (ok) {
    if (result.stdout !== null || typeof result.stdoutBase64 !== "string" ||
        result.stdoutBase64.length > EXECUTOR_BOUNDS.maxBase64ResponseChars ||
        !Number.isSafeInteger(result.stdoutBytes) || result.stdoutBytes < 0) {
      fail("preview_result_stdout_base64");
    }
    let decoded;
    try { decoded = decodeCanonicalBase64(result.stdoutBase64); }
    catch { fail("preview_result_stdout_base64"); }
    if (decoded.byteLength !== result.stdoutBytes ||
        decoded.byteLength > EXECUTOR_BOUNDS.maxBinaryResponseBytes) {
      fail("preview_result_stdout_base64");
    }
    stdout = null;
    stdoutBase64 = result.stdoutBase64;
    stdoutBytes = result.stdoutBytes;
  } else {
    if (result.stdout !== "" || result.stdoutBase64 !== null || result.stdoutBytes !== 0 ||
        result.stderr !== "" || result.counters !== null) {
      fail("preview_result_failure_output");
    }
    stdout = "";
    stdoutBase64 = null;
    stdoutBytes = 0;
  }
  return Object.freeze({
    ok,
    phase: typeof result.phase === "string" ? result.phase : "unknown",
    exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
    stdoutEncoding,
    stdout,
    stdoutBase64,
    stdoutBytes,
    stderr: ok ? boundedString(result.stderr, "stderr") : "",
    errno: Number.isSafeInteger(result.errno) ? result.errno : null,
    error: ok ? null : boundedString(String(result.error ?? "").slice(0, 512), "error", 512),
  });
}

/**
 * Executes a bundled WASI job for a task or preview run, reusing the shared
 * revalidation, job synthesis, execution host dispatch, and result bounds.
 *
 * Seeding policy:
 *   - Inputs: Referenced input projection (attachments -> inputs/<sha256>.bin) is
 *     deferred until the task-scoped attachment reference contract lands. The
 *     workspace is seeded with the immutable per-tool static seed or empty.
 *   - Scratch: Fresh per-call sync workspace.
 *   - Output: Bounded stdout (utf8 / base64), all-or-nothing failure semantics.
 */
export async function executeBundledWasiJob({
  toolId,
  args = [],
  stdin = "",
  runContext = {},
  fetchFn = typeof fetch !== "undefined" ? fetch : null,
  createWorker = null,
  now = null,
} = {}) {
  const spec = previewSpecFor(toolId);
  if (!spec) {
    return Object.freeze({
      ok: false,
      phase: "failed",
      error: `unknown_bundled_tool: ${toolId}`,
      stdoutEncoding: "utf8",
      stdout: "",
      stdoutBase64: null,
      stdoutBytes: 0,
      stderr: "",
      errno: null,
      exitCode: null,
    });
  }

  let input;
  let stdoutEncoding = spec.stdoutEncoding;
  try {
    input = validatePreviewInput({
      toolId,
      args: Array.isArray(args) ? args : [],
      stdin: typeof stdin === "string" ? stdin : "",
    });
    stdoutEncoding = previewStdoutEncoding(input.toolId, input.args);
  } catch (err) {
    return Object.freeze({
      ok: false,
      phase: "failed",
      error: `invalid_input: ${err.message || err}`,
      stdoutEncoding,
      stdout: "",
      stdoutBase64: null,
      stdoutBytes: 0,
      stderr: "",
      errno: null,
      exitCode: null,
    });
  }

  const manifestUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL(spec.manifestRel)
    : spec.manifestRel;
  const casUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL(spec.casRel)
    : spec.casRel;

  let manifestText;
  let casBytes;
  try {
    if (!fetchFn) throw new Error("fetch unavailable in this environment");
    const mRes = await fetchFn(manifestUrl);
    if (!mRes.ok) throw new Error(`manifest fetch failed (${mRes.status})`);
    manifestText = await mRes.text();
    const cRes = await fetchFn(casUrl);
    if (!cRes.ok) throw new Error(`CAS fetch failed (${cRes.status})`);
    casBytes = new Uint8Array(await cRes.arrayBuffer());
  } catch (err) {
    return Object.freeze({
      ok: false,
      phase: "failed",
      error: `asset_fetch_failed: ${err.message || err}`,
      stdoutEncoding,
      stdout: "",
      stdoutBase64: null,
      stdoutBytes: 0,
      stderr: "",
      errno: null,
      exitCode: null,
    });
  }

  try {
    await revalidatePreviewExecution({
      toolId,
      manifestText,
      casBytes,
      inventory: BUNDLED_INVENTORY,
      now,
    });
  } catch (err) {
    return Object.freeze({
      ok: false,
      phase: "failed",
      error: `revalidation_failed: ${err.code || err.message || err}`,
      stdoutEncoding,
      stdout: "",
      stdoutBase64: null,
      stdoutBytes: 0,
      stderr: "",
      errno: null,
      exitCode: null,
    });
  }

  const authority = buildPreviewAuthority({
    origin: typeof runContext.origin === "string" && runContext.origin.startsWith("http")
      ? runContext.origin
      : PREVIEW_SETTINGS_ORIGIN,
    documentId: typeof runContext.documentId === "string" ? runContext.documentId : "task-run",
    now,
  });

  const job = buildPreviewJob({ input, authority });

  // 1. Task-lane dedicated fresh Worker host path (runtime-URL dynamic import keeps bundles scanner-clean)
  const canSpawnWorker = typeof createWorker === "function" ||
    (typeof Worker !== "undefined" && typeof chrome !== "undefined" && chrome.runtime?.getURL);

  if (canSpawnWorker) {
    try {
      const executorModuleUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
        ? chrome.runtime.getURL("lib/wasm-executor.js")
        : "./wasm-executor.js";
      const hostModuleUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
        ? chrome.runtime.getURL("lib/wasm-offscreen-host.js")
        : "./wasm-offscreen-host.js";
      const workerUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
        ? chrome.runtime.getURL("lib/wasm-execution-worker.js")
        : "lib/wasm-execution-worker.js";

      const { WasmExecutor } = await import(executorModuleUrl);
      const { createOffscreenWasmHost } = await import(hostModuleUrl);

      const executor = new WasmExecutor({
        workerUrl,
        createWorker: createWorker || undefined,
        callMs: PREVIEW_LIMITS.wallMs,
      });
      const host = createOffscreenWasmHost({ executor, authority });
      const rawResult = await host.handleJob({
        type: "wasm.job",
        job: { ...job, stdin: new Uint8Array(job.stdin) },
        wasmBytes: casBytes,
      });
      return boundPreviewResult(rawResult, { stdoutEncoding });
    } catch (err) {
      return Object.freeze({
        ok: false,
        phase: "failed",
        error: `execution_worker_failed: ${err.message || err}`,
        stdoutEncoding,
        stdout: "",
        stdoutBase64: null,
        stdoutBytes: 0,
        stderr: "",
        errno: null,
        exitCode: null,
      });
    }
  }

  // 2. Options-context preview fallback path (if in extension environment with options page open)
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage && runContext.origin === PREVIEW_SETTINGS_ORIGIN) {
    const envelope = await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(
        () => finish({ ok: false, error: "tool execution timed out" }),
        PREVIEW_LIMITS.wallMs + 5000,
      );
      chrome.runtime.sendMessage({
        type: "wasm.preview.options",
        authority,
        job,
        wasmBytes: Array.from(casBytes),
        wallMs: PREVIEW_LIMITS.wallMs,
      }).then(
        (res) => { clearTimeout(timer); finish(res); },
        (err) => { clearTimeout(timer); finish({ ok: false, error: String(err?.message ?? err) }); },
      );
    });

    if (envelope?.ok && envelope.result) {
      return boundPreviewResult(envelope.result, { stdoutEncoding });
    }
    return Object.freeze({
      ok: false,
      phase: "failed",
      error: envelope?.error || "execution_failed",
      stdoutEncoding,
      stdout: "",
      stdoutBase64: null,
      stdoutBytes: 0,
      stderr: "",
      errno: null,
      exitCode: null,
    });
  }

  // 3. Typed fail-closed error envelope when no WASI execution host is available
  return Object.freeze({
    ok: false,
    phase: "failed",
    error: "wasi_task_host_unavailable",
    stdoutEncoding,
    stdout: "",
    stdoutBase64: null,
    stdoutBytes: 0,
    stderr: "",
    errno: null,
    exitCode: null,
  });
}

