// @ts-nocheck
// avif admission KAT (chrome-agent-platform-ou4x, qazo option B): the
// CAP-authored WASI AVIF encoder over ravif+rav1e — pure-WASI preview-1,
// single-threaded, default-tier bounded, byte-reproducible, and runnable
// through the REAL job-lane worker (runWorkerJob — the az4k/8oil canon; avif
// is NOT stream-backed).
//
// The model sends base64 image text at the tool boundary; the job lane (spec
// stdinEncoding "base64") decodes it and the worker writes RAW bytes to the
// tool's stdin pipe — the tool reads RAW bytes (the compressops/zxing 8oil
// contract). The run() helper below sends the model-facing base64 text.
//
// The two gates that had to clear BEFORE admission (both on the bead):
//   Step 1 native probe — Chrome cannot encode AVIF from canvas
//     (cap-evidence/cap-avif/native-probe.md), so the gap is real;
//   Step 2 fit — the encode fits the executor's 5 s wall bound
//     (cap-evidence/cap-avif/fit-report.md: 512×512 speed-10 ≈ 278 ms, worst
//     2,886 ms at 1024×768 speed 8).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { crypto } from "jsr:@std/crypto";
import { auditWasmBinary } from "../extension/lib/wasm-package-authority.js";
import {
  buildPreviewAuthority,
  buildPreviewJob,
  PREVIEW_SPECS,
  previewSpecFor,
  previewStdinEncoding,
  previewStdoutEncoding,
  validatePreviewInput,
  isStreamBackedBundledTool,
} from "../extension/lib/tool-exec-preview.js";
import { runWorkerJob } from "../extension/lib/wasm-execution-worker.js";
import { createWasiJob } from "../extension/lib/wasm-host-types.js";
import { encodeCanonicalBase64 } from "../extension/lib/wasm-base64.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { toolPurposeGroup } from "../extension/lib/tool-purpose-groups.js";

const AVIF_SHA256 = "efafe563c9aa683d8688d17f477584c04f17ba4cac5a52d0df027bcd76e1e294";
const AVIF_BYTES = 1436513;

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A deterministic COMPRESSIBLE 64×64 RGBA PNG (a flat gradient — the honest
 *  fixture: synthetic noise encodes LARGER than the PNG, so the smaller-than
 *  assertion must use a compressible source; see fit-report.md). Naive
 *  filter-0 scanlines, zlib level 6. */
async function fixturePng() {
  const { deflateSync } = await import("node:zlib");
  const be32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (type, data) => {
    const t = Buffer.from(type, "latin1");
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const b of Buffer.concat([t, data])) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
    return Buffer.concat([be32(data.length), t, data, be32((crc ^ 0xffffffff) >>> 0)]);
  };
  const W = 64, H = 64;
  const ihdr = Buffer.concat([be32(W), be32(H), Buffer.from([8, 6, 0, 0, 0])]);
  const rows = [];
  for (let y = 0; y < H; y++) {
    const r = Buffer.alloc(1 + W * 4);
    for (let x = 0; x < W; x++) { const i = 1 + x * 4; r[i] = (x / W * 255) | 0; r[i + 1] = (y / H * 255) | 0; r[i + 2] = 128; r[i + 3] = 255; }
    rows.push(r);
  }
  const raw = Buffer.concat(rows);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

const b64 = (bytes) => encodeCanonicalBase64(bytes);
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** The AVIF brand box: bytes 4..12 = "ftypavif" (or "ftypavis"). */
const hasAvifBrand = (bytes) => bytes.length > 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp" && /avif|avis/.test(String.fromCharCode(...bytes.slice(8, 12)));

Deno.test("avif: the shipped wasm is pure-WASI preview-1, single-threaded, default-tier bounded", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${AVIF_SHA256}.wasm`);
  assertEquals(bytes.byteLength, AVIF_BYTES);
  const audit = auditWasmBinary(bytes, {
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    memory: { tier: "default", initialPages: 21, maxPages: 2048 },
    size: AVIF_BYTES,
  });
  assertEquals(audit.ok, true);
  assertEquals(audit.measured.memoryMax, 2048, "declared max memory is the default-tier ceiling");
  assert(audit.measured.memoryInitial <= 21, "initial within the declaration");
});

Deno.test("avif: the pinned sha256 is the real committed CAS artifact", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${AVIF_SHA256}.wasm`);
  assertEquals(await sha256Hex(bytes), AVIF_SHA256);
});

Deno.test("avif: the evidence tree proves byte-for-byte reproducibility (build-a == build-b)", async () => {
  const a = await Deno.readFile("packages/bundled/evidence/avif/build-a/avif.wasm");
  const b = await Deno.readFile("packages/bundled/evidence/avif/build-b/avif.wasm");
  assertEquals(await sha256Hex(a), AVIF_SHA256, "build-a is the shipped artifact");
  assertEquals(await sha256Hex(b), AVIF_SHA256, "build-b reproduces it exactly");
  const sums = await Deno.readTextFile("packages/bundled/evidence/avif/SHA256SUMS");
  assert(sums.includes(`build-a/avif.wasm`) && sums.includes(AVIF_SHA256), "SHA256SUMS pins the artifact");
});

Deno.test("avif: manifest declares the default tier, read-only replay, compute, and the BSD composite with its notices + SBOM", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/wasm/manifests/cap.bundled.avif-1.0.0.manifest.json"));
  assertEquals(manifest.package.id, "cap.bundled.avif");
  // ravif BSD-3-Clause + rav1e BSD-2-Clause over an MIT/Apache-2.0 tree; the
  // 2-term SPDX grammar carries BSD-3 AND Apache-2.0 (the distinguishing terms);
  // the full expression is in NOTICES.md + the SBOM.
  assertEquals(manifest.license.spdx, "BSD-3-Clause AND Apache-2.0");
  assertEquals(manifest.license.notices, "extension/wasm/licenses/avif-NOTICES.txt");
  const notices = await Deno.readTextFile(manifest.license.notices);
  for (const needle of ["ravif", "rav1e", "BSD-3-Clause", "BSD-2-Clause", "Apache-2.0", "MIT"]) {
    assert(notices.includes(needle), `notices name ${needle}`);
  }
  const exec = manifest.executables[0];
  assertEquals(exec.memory.tier, "default");
  assertEquals(exec.memory.maxPages, 2048);
  assertEquals(exec.imports.allowed, ["wasi_snapshot_preview1"]);
  assertEquals(exec.replayClass, "read-only");
  assertEquals(exec.capabilities, ["compute"]);
  assertEquals(exec.sha256, AVIF_SHA256);
  assertEquals(exec.size, AVIF_BYTES);
  const sbom = JSON.parse(await Deno.readTextFile("extension/wasm/sbom/avif.cdx.json"));
  const names = sbom.components.map((c) => c.name);
  for (const needle of ["ravif", "rav1e", "image", "imgref", "rgb"]) assert(names.includes(needle), `SBOM names ${needle}`);
});

Deno.test("avif: admitted, job-lane (NOT stream-backed), base64 stdout + ALWAYS base64 stdin", () => {
  assert(PREVIEW_SPECS.avif, "avif is in the admitted spec map");
  assert(!isStreamBackedBundledTool("avif"), "avif dispatches through the job lane, not the stream lane");
  assertEquals(previewStdoutEncoding("avif", []), "base64", "AVIF bytes ride base64 out");
  assertEquals(previewStdoutEncoding("avif", ["--quality", "60"]), "base64");
  // The encode's ONLY mode reads a base64 image on stdin, whatever the flags.
  assertEquals(previewStdinEncoding("avif", []), "base64");
  assertEquals(previewStdinEncoding("avif", ["--quality", "60", "--speed", "8"]), "base64");
  const spec = previewSpecFor("avif");
  assertEquals(spec.stdinEncoding, "base64");
  assertEquals(spec.tier, "default");
  // A non-base64 stdin is refused before any Worker spawns.
  let threw = null;
  try { validatePreviewInput({ toolId: "avif", args: [], stdin: "not base64!!" }); } catch (e) { threw = e.code ?? null; }
  assertEquals(threw, "preview_stdin_base64");
});

Deno.test("avif: runs through the REAL job-lane worker — AVIF brand, smaller than the compressible PNG input; garbage fails closed", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === "avif");
  assert(row, "avif is in the bundled inventory");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);
  const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "avif-admission", now: () => 1 });

  async function run(args, stdinText) {
    const built = buildPreviewJob({ input: validatePreviewInput({ toolId: "avif", args, stdin: stdinText }), authority });
    const job = createWasiJob({ ...built, stdin: new Uint8Array(built.stdin) });
    let out = null;
    await runWorkerJob({ sessionId: "s", job, wasmBytes, post: () => {}, respond: (r) => { out = r; } });
    return out;
  }

  const input = await fixturePng();
  // Default quality/speed: a real AVIF, SMALLER than the naive-compressible PNG.
  const out = await run([], b64(input));
  assertEquals(out.phase, "completed", `default encode failed: ${out.error ?? ""}`);
  const avif = fromB64(out.stdoutBase64);
  assert(hasAvifBrand(avif), `output carries the AVIF ftyp/avif brand (got ${String.fromCharCode(...avif.slice(4, 12))})`);
  assert(avif.length < input.length, `AVIF (${avif.length}) smaller than the compressible PNG (${input.length})`);
  assert(avif.length > 0);

  // Explicit quality/speed: still a valid AVIF.
  const q = await run(["--quality", "60", "--speed", "8"], b64(input));
  assertEquals(q.phase, "completed", `q60/s8 encode failed: ${q.error ?? ""}`);
  assert(hasAvifBrand(fromB64(q.stdoutBase64)));

  // Garbage fails CLOSED (non-zero / a structured error), never a silent empty output.
  const notImage = await run([], btoa("hello, not an image"));
  assert(notImage.phase !== "completed" || notImage.exitCode !== 0, "base64 of a non-image must fail closed");
});

Deno.test("avif: resolves to the media-images purpose group", () => {
  assertEquals(toolPurposeGroup("avif"), "media-images");
});

Deno.test("avif: a threading mutant (rav1e's threading restored → shared memory) is REJECTED by the audit's single-thread check", async () => {
  // The bead's falsification: restoring rav1e's threading feature would emit a
  // SHARED memory (limits flag 0x02). Flip the shipped wasm's memory-section
  // flag to shared at the byte level and prove the audit refuses it — the
  // single-thread guarantee has teeth.
  const bytes = new Uint8Array(await Deno.readFile(`extension/wasm/cas/${AVIF_SHA256}.wasm`));
  const mutant = bytes.slice();
  // Locate the memory section (id 5) and set the limits flag to shared+max (0x03).
  let i = 8;
  const u32 = () => { let r = 0, s = 0; for (;;) { const x = mutant[i++]; r |= (x & 127) << s; if (!(x & 128)) break; s += 7; } return r; };
  while (i < mutant.length) {
    const id = mutant[i++]; const size = u32();
    if (id === 5) { u32(); mutant[i] = 0x03; break; } // count, then the limits flag
    i += size;
  }
  let code = null;
  try { auditWasmBinary(mutant, { imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] }, memory: { tier: "default", initialPages: 21, maxPages: 2048 }, size: mutant.byteLength }); }
  catch (e) { code = e.code ?? e.message; }
  assertEquals(code, "memory_shared_rejected", "a shared (threaded) memory is refused — threading can never ride this admission");
  // …and the unmutated artifact still passes (the control).
  const clean = auditWasmBinary(bytes, { imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] }, memory: { tier: "default", initialPages: 21, maxPages: 2048 }, size: bytes.byteLength });
  assertEquals(clean.ok, true, "the shipped artifact is single-threaded (not shared)");
});
