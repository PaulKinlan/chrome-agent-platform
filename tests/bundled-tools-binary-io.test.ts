// @ts-nocheck
// Bundled tools with BYTES on the stdin pipe (chrome-agent-platform-8oil):
// a shared stdin-encoding resolver mirrors the existing stdout one, so the job
// lane carries raw bytes end-to-end for every tool whose contract takes bytes
// in — not just gzip.
//
// Found through the az4k canon probe (real runWorkerJob over the real CAS
// bytes, job built exactly as the SW builds it — cap-evidence/cap-az4k/ +
// cap-evidence/cap-8oil/mint-frames.log): compressops's zstd/brotli
// subcommands write frame BYTES under a utf8 stdoutEncoding → the worker's
// fatal decoder refuses ("The encoded data is not valid"), and its -d/info
// subcommands need frame bytes on stdin — gzip had the only binary-stdin path
// (keyed on toolId === "gzip"). zxing read (a PNG on stdin) has the IDENTICAL
// gap: a live-shaped job fed it the base64 TEXT as bytes → proc-exit.
//
// The generalisation is gzip's own mechanism, driven by a shared resolver
// (previewStdinEncoding) instead of the toolId key: the worker's base64 stdout
// arm already exists (wasm-execution-worker.js) and does NOT change.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  buildPreviewAuthority,
  buildPreviewJob,
  PREVIEW_SPECS,
  previewSpecFor,
  previewStdinEncoding,
  previewStdoutEncoding,
  validatePreviewInput,
} from "../extension/lib/tool-exec-preview.js";
import { runWorkerJob } from "../extension/lib/wasm-execution-worker.js";
import { createWasiJob } from "../extension/lib/wasm-host-types.js";
import { encodeCanonicalBase64, decodeCanonicalBase64 } from "../extension/lib/wasm-base64.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";

const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "binary-io", now: () => 1 });
const enc = new TextEncoder();

/** Encode bytes to a canonical base64 string (the model's stdin payload). */
const b64Of = (bytes) => encodeCanonicalBase64(bytes);
/** Decode a base64 envelope stdout to bytes. */
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

// Fixtures minted through the REAL worker (cap-evidence/cap-8oil/mint-frames.log).
// A zstd frame for "hello" (level 3): magic 28b52ffd → base64 starts "KLUv/Q".
const ZSTD_HELLO_FRAME = "KLUv/QBYKQAAaGVsbG8=";
// A brotli stream for "hello" (quality 5): no magic bytes.
const BROTLI_HELLO_STREAM = "CwKAaGVsbG8D";

Deno.test("8oil: previewStdinEncoding + previewStdoutEncoding name every byte-at-the-pipe mode", () => {
  // stdin: bytes-in modes ride base64; compress modes take UTF-8 text
  // (gzip's precedent); base64 -d stays UTF-8 (a natural-language arm — it
  // fails on non-base64 bytes, the contract stays honest).
  assertEquals(previewStdinEncoding("gzip", []), "utf8");
  assertEquals(previewStdinEncoding("gzip", ["-d"]), "base64");
  assertEquals(previewStdinEncoding("compressops", ["zstd"]), "utf8", "compress: text in (the compressed frame is base64 out)");
  assertEquals(previewStdinEncoding("compressops", ["zstd", "-d"]), "base64");
  assertEquals(previewStdinEncoding("compressops", ["brotli", "-q", "5"]), "utf8");
  assertEquals(previewStdinEncoding("compressops", ["brotli", "-d"]), "base64");
  assertEquals(previewStdinEncoding("compressops", ["info"]), "base64", "info takes a frame in");
  assertEquals(previewStdinEncoding("zxing", ["read"]), "base64", "zxing read takes a PNG in");
  assertEquals(previewStdinEncoding("zxing", ["write", "qrcode", "x"]), "utf8");
  // stdout: compressops's compression subcommands emit frame BYTES in BOTH
  // directions (a decompress emits the original bytes — binary stays lossless,
  // exactly gzip -d's arm); info emits the JSON report (utf8).
  assertEquals(previewStdoutEncoding("compressops", ["info"]), "utf8");
  assertEquals(previewStdoutEncoding("compressops", ["zstd"]), "base64");
  assertEquals(previewStdoutEncoding("compressops", ["zstd", "-d"]), "base64");
  assertEquals(previewStdoutEncoding("compressops", ["brotli", "-q", "5"]), "base64");
  assertEquals(previewStdoutEncoding("compressops", ["brotli", "-d"]), "base64");
  // The pre-existing per-argv resolvers are unchanged.
  assertEquals(previewStdoutEncoding("zxing", ["read"]), "utf8");
  assertEquals(previewStdoutEncoding("zxing", ["write", "qrcode", "x"]), "base64");
  assertEquals(previewStdoutEncoding("imageops", ["info"]), "utf8");
  assertEquals(previewStdoutEncoding("imageops", ["resize", "in.png", "out.png"]), "base64");
  assertEquals(previewStdoutEncoding("gzip", []), "base64");
  // A tool with no binary mode is text in / spec out.
  assertEquals(previewStdinEncoding("wc", []), "utf8");
});

Deno.test("8oil: the spec census names the compression tool as base64-stdout (base64 -d stays utf8)", () => {
  const spec = previewSpecFor("compressops");
  assertEquals(spec.stdoutEncoding, "base64", "compressops joins the base64-stdout spec rows");
  // Every other spec keeps its encoding — base64 -d is NOT re-armed (the
  // resolved utf8 default above is unchanged), and the base64 tool's default
  // arm is text-out.
  assertEquals(previewSpecFor("base64").stdoutEncoding, "utf8");
  for (const [toolId, s] of Object.entries(PREVIEW_SPECS)) {
    const expect = ["gzip", "imageops", "zxing", "oxipng", "compressops"].includes(toolId) ? "base64" : "utf8";
    assertEquals(s.stdoutEncoding, expect, `${toolId}: spec stdoutEncoding`);
  }
  // The spec is frozen, and only tiny/default tiers appear (az4k).
  assert(Object.isFrozen(spec));
  assert(spec.tier === "default", "compressops declares the default tier");
});

Deno.test("8oil: validator + job builder consume the resolver — bytes-in stdin is canonical base64, text modes stay strict", () => {
  // Bytes-in modes ACCEPT canonical base64 and DECODE it for the job.
  const dec = validatePreviewInput({ toolId: "compressops", args: ["zstd", "-d"], stdin: ZSTD_HELLO_FRAME });
  assertEquals(dec.stdin, ZSTD_HELLO_FRAME);
  const job = buildPreviewJob({ input: dec, authority });
  assertEquals(Array.from(job.stdin), Array.from(fromB64(ZSTD_HELLO_FRAME)), "the job carries the decoded frame bytes");
  assertEquals(job.stdoutEncoding, "base64");
  assertEquals(job.tier, "default", "the default tier rides (az4k)");
  // zxing read: a PNG payload is base64 → decoded bytes.
  const png = b64Of(enc.encode("not a real png but bytes"));
  const zjob = buildPreviewJob({ input: validatePreviewInput({ toolId: "zxing", args: ["read"], stdin: png }), authority });
  assertEquals(Array.from(zjob.stdin), Array.from(fromB64(png)));
  assertEquals(zjob.stdoutEncoding, "utf8", "zxing read emits JSON lines");
  // Compress modes take UTF-8 text, NOT base64 (gzip's model-facing contract).
  assertEquals(validatePreviewInput({ toolId: "compressops", args: ["zstd"], stdin: "hello" }).stdin, "hello");
  const cjob = buildPreviewJob({ input: validatePreviewInput({ toolId: "compressops", args: ["zstd"], stdin: "hello" }), authority });
  assertEquals(Array.from(cjob.stdin), Array.from(enc.encode("hello")));
  assertEquals(cjob.stdoutEncoding, "base64", "the compressed frame is base64 out");
  // Refused before any Worker spawns: non-canonical base64 on a bytes-in mode.
  assertThrows(() => validatePreviewInput({ toolId: "compressops", args: ["zstd", "-d"], stdin: "not base64!!" }), Error, "preview_stdin_base64");
  assertThrows(() => validatePreviewInput({ toolId: "zxing", args: ["read"], stdin: "hi" }), Error, "preview_stdin_base64");
  // Text modes reject non-UTF-8-scalar stdin (gzip's strictness, generalised).
  assertThrows(() => validatePreviewInput({ toolId: "compressops", args: ["zstd"], stdin: "\ud83d" }), Error, "preview_stdin_text");
  // gzip keeps its arm: [] text (with its scalar checks) / -d base64.
  assertThrows(() => validatePreviewInput({ toolId: "gzip", args: ["-d"], stdin: "x" }), Error, "preview_stdin_base64");
});

Deno.test("8oil: compressops compress → base64 frame with the magic → decompress round trip through the REAL job worker", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((r) => r.toolId === "compressops");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);
  const run = async (args, stdin) => {
    const built = buildPreviewJob({ input: validatePreviewInput({ toolId: "compressops", args, stdin }), authority });
    const job = createWasiJob({ ...built, stdin: new Uint8Array(built.stdin) });
    let out = null;
    await runWorkerJob({ sessionId: "s", job, wasmBytes, post: () => {}, respond: (r) => { out = r; } });
    return out;
  };
  // zstd: compress text → base64 frame with the 28b52ffd magic → decompress → "hello".
  const z = await run(["zstd", "-l", "3"], "hello");
  assertEquals(z.phase, "completed", `zstd compress must run (was runtime-error "The encoded data is not valid"): ${z.error ?? ""}`);
  assertEquals(z.stdoutEncoding ?? "base64", "base64");
  assert(z.stdoutBase64.startsWith("KLUv/Q"), `zstd frame magic in base64: ${String(z.stdoutBase64).slice(0, 20)}`);
  const zd = await run(["zstd", "-d"], z.stdoutBase64);
  assertEquals(zd.phase, "completed", `zstd decompress: ${zd.error ?? ""}`);
  assertEquals(fromB64(zd.stdoutBase64), enc.encode("hello"), "zstd round trip");
  // brotli likewise (no magic — the round trip is the proof).
  const b = await run(["brotli", "-q", "5"], "hello");
  assertEquals(b.phase, "completed", `brotli compress: ${b.error ?? ""}`);
  assert(b.stdoutBase64.length > 0);
  const bd = await run(["brotli", "-d"], b.stdoutBase64);
  assertEquals(fromB64(bd.stdoutBase64), enc.encode("hello"), "brotli round trip");
  // info on a frame (bytes in, utf8 JSON out) — the az4k KAT stdin was text;
  // a real frame is the honest input.
  const info = await run(["info"], z.stdoutBase64);
  assertEquals(info.phase, "completed", `info: ${info.error ?? ""}`);
  assert(String(info.stdout).includes('"magic":"zstd"'), `info reports the frame: ${String(info.stdout).slice(0, 60)}`);
});

Deno.test("8oil: zxing read decodes a QR written live (PNG on stdin as base64) through the REAL job worker", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((r) => r.toolId === "zxing");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);
  const run = async (args, stdin) => {
    const built = buildPreviewJob({ input: validatePreviewInput({ toolId: "zxing", args, stdin }), authority });
    const job = createWasiJob({ ...built, stdin: new Uint8Array(built.stdin) });
    let out = null;
    await runWorkerJob({ sessionId: "s", job, wasmBytes, post: () => {}, respond: (r) => { out = r; } });
    return out;
  };
  const w = await run(["write", "qrcode", "CAP-8OIL"], "");
  assertEquals(w.phase, "completed", `zxing write: ${w.error ?? ""}`);
  assert(w.stdoutBase64.startsWith("iVBORw0KGgo"), "a PNG out");
  const rd = await run(["read"], w.stdoutBase64);
  assertEquals(rd.phase, "completed", `zxing read must run (a live run fed it the base64 TEXT as bytes → proc-exit): ${rd.error ?? ""}`);
  assert(String(rd.stdout).includes('"text":"CAP-8OIL"'), `the payload survives: ${String(rd.stdout).slice(0, 80)}`);
});

Deno.test("8oil detector honesty: the worker's fatal utf8 decode STILL rejects binary output declared utf8", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((r) => r.toolId === "compressops");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);
  const built = buildPreviewJob({ input: validatePreviewInput({ toolId: "compressops", args: ["zstd", "-l", "3"], stdin: "hello" }), authority });
  const forcedUtf8 = createWasiJob({ ...built, stdin: new Uint8Array(built.stdin), stdoutEncoding: "utf8" });
  let out = null;
  await runWorkerJob({ sessionId: "s", job: forcedUtf8, wasmBytes, post: () => {}, respond: (r) => { out = r; } });
  assertEquals(out.phase, "runtime-error", "the worker's fatal decoder keeps its teeth on a utf8-declared binary stream");
  assert(/not valid/.test(out.error), `the refusal names the decode: ${out.error}`);
  // sanity: the helper round-trips
  assertEquals(fromB64(ZSTD_HELLO_FRAME).length > 0, true);
  assertEquals(decodeCanonicalBase64(ZSTD_HELLO_FRAME).length > 0, true);
});
