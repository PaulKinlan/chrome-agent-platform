// @ts-nocheck — retained gzip integration + hostile binary fixtures.
// CAP-FB-20260823-GZIP-SETTINGS-ADMISSION-01: gzip-only owner-Settings
// admission over the generic FND-1 lossless envelope. No Chrome.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { WasmExecutor } from "../extension/lib/wasm-executor.js";
import { createOffscreenWasmHost } from "../extension/lib/wasm-offscreen-host.js";
import {
  boundPreviewResult,
  buildPreviewAuthority,
  buildPreviewJob,
  previewSpecFor,
  validatePreviewInput,
} from "../extension/lib/tool-exec-preview.js";
import { decodeCanonicalBase64, encodeCanonicalBase64 } from "../extension/lib/wasm-base64.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { SUPPORTED_WASI_PREVIEW1_IMPORTS } from "../extension/lib/wasi-preview1-runtime.js";

const WORKER_URL = new URL("../extension/lib/wasm-execution-worker.js", import.meta.url).href;
const GZIP_CAS = new URL(
  "../extension/wasm/cas/d03a2558682ea04653d34753eae8df1fcd5cc8d92fc53de43106c3db0e1c57dc.wasm",
  import.meta.url,
);
const HELLO_GZIP_BASE64 = "H4sIAAAAAAAAA8tIzcnJBwCGphA2BQAAAA==";

async function gzipFixture(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function runGzip(args: string[], stdin: string) {
  const input = validatePreviewInput({ toolId: "gzip", args, stdin });
  const authority = buildPreviewAuthority({ origin: "https://settings.cap" });
  const job = buildPreviewJob({ input, authority });
  const wasmBytes = new Uint8Array(await Deno.readFile(GZIP_CAS));
  const host = createOffscreenWasmHost({
    executor: new WasmExecutor({ workerUrl: WORKER_URL, callMs: 5000 }),
    authority,
  });
  // Runtime messaging rehydrates createWasiJob's frozen byte array in the
  // options host; mirror that exact transport boundary in this no-Chrome test.
  return await host.handleJob({
    type: "wasm.job",
    job: { ...job, stdin: new Uint8Array(job.stdin) },
    wasmBytes,
  });
}

function expectNoPartial(result, label: string) {
  assertEquals(result.ok, false, `${label}: failure`);
  assertEquals(result.stdout, "", `${label}: no text output`);
  assertEquals(result.stdoutBase64, null, `${label}: no binary output`);
  assertEquals(result.stdoutBytes, 0, `${label}: zero public bytes`);
  assertEquals(result.stderrBytes, 0, `${label}: stderr is discarded too`);
  assertEquals(result.counters, null, `${label}: counters discarded`);
}

function expectReject(input, code: string) {
  let actual = null;
  try { validatePreviewInput(input); } catch (error) { actual = error?.code ?? null; }
  assertEquals(actual, code, JSON.stringify(input));
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

Deno.test("gzip spec/request: immutable exact modes, UTF-8 scalar checks and strict canonical base64", () => {
  const spec = previewSpecFor("gzip");
  assertEquals(spec.acceptedExitCodes, [0]);
  assertEquals(spec.stdoutEncoding, "base64");
  assertEquals(spec.allowedArgs, [[], ["-d"]]);
  // dptw: no maxTextInputBytes/maxBase64InputChars/maxDecodedInputBytes/maxBinaryOutputBytes in the spec.
  for (const k of ["maxTextInputBytes", "maxBase64InputChars", "maxDecodedInputBytes", "maxBinaryOutputBytes"]) {
    assertEquals(k in spec, false, `dptw: ${k} gone`);
  }
  assert(Object.isFrozen(spec) && Object.isFrozen(spec.allowedArgs) && spec.allowedArgs.every(Object.isFrozen));

  assertEquals(validatePreviewInput({ toolId: "gzip", args: [], stdin: "hello" }).stdin, "hello");
  assertEquals(validatePreviewInput({ toolId: "gzip", args: ["-d"], stdin: HELLO_GZIP_BASE64 }).stdin, HELLO_GZIP_BASE64);
  for (const args of [["-c"], ["-f"], ["-9"], ["--"], ["file.gz"], ["-d", "file.gz"], ["-dc"]]) {
    expectReject({ toolId: "gzip", args, stdin: "" }, "preview_args");
  }
  for (const stdin of ["\ufeffhello", "a\0b", "\ud800", "x\udfff"]) {
    expectReject({ toolId: "gzip", args: [], stdin }, "preview_gzip_text");
  }
  // dptw: text past the removed 2048-byte cap is accepted whole.
  assertEquals(validatePreviewInput({ toolId: "gzip", args: [], stdin: "a".repeat(2049) }).stdin.length, 2049, "long UTF-8 text accepted");
  // A valid surrogate pair remains valid UTF-8 text.
  assertEquals(validatePreviewInput({ toolId: "gzip", args: [], stdin: "\ud83d\ude00" }).stdin, "😀");

  for (const stdin of [
    ` ${HELLO_GZIP_BASE64}`, `${HELLO_GZIP_BASE64}\n`, "____",
    HELLO_GZIP_BASE64.slice(0, -1), "Zh==", "A===", "AA=A", "é===",
  ]) expectReject({ toolId: "gzip", args: ["-d"], stdin }, "preview_gzip_base64");
  // dptw: canonical base64 of any decoded size is accepted (shape, not size).
  const longCanonical = encodeCanonicalBase64(new Uint8Array(4097));
  assertEquals(validatePreviewInput({ toolId: "gzip", args: ["-d"], stdin: longCanonical }).stdin, longCanonical, "long canonical base64 accepted");
  const tooManyDecoded = encodeCanonicalBase64(new Uint8Array(1537));
  assertEquals(validatePreviewInput({ toolId: "gzip", args: ["-d"], stdin: tooManyDecoded }).stdin, tooManyDecoded, "decoded past the removed 1536 cap accepted");

  // No request-borne mode, encoding, bytes, quota, package or capability authority.
  for (const extra of ["mode", "stdoutEncoding", "stdinBytes", "quota", "packageId", "capabilities"]) {
    expectReject({ toolId: "gzip", args: [], stdin: "", [extra]: extra === "quota" ? {} : "forged" }, "preview_request_shape");
  }
});

Deno.test("gzip job: compress UTF-8 and decompress canonical base64 become exact raw stdin with a 64 KiB output quota", () => {
  const authority = buildPreviewAuthority({ origin: "https://settings.cap" });
  const compress = buildPreviewJob({ input: validatePreviewInput({ toolId: "gzip", args: [], stdin: "hello" }), authority });
  assertEquals(compress.args, ["gzip"]);
  assertEquals([...compress.stdin], [...new TextEncoder().encode("hello")]);
  assertEquals(compress.stdoutEncoding, "base64");
  assertEquals(compress.quota.stdinBytes, Number.POSITIVE_INFINITY, "dptw: no stdin quota");
  assertEquals(compress.quota.stdoutBytes, Number.POSITIVE_INFINITY, "dptw: no stdout quota");

  const decompress = buildPreviewJob({ input: validatePreviewInput({ toolId: "gzip", args: ["-d"], stdin: HELLO_GZIP_BASE64 }), authority });
  assertEquals(decompress.args, ["gzip", "-d"]);
  assertEquals([...decompress.stdin], [...decodeCanonicalBase64(HELLO_GZIP_BASE64)]);
  assertEquals(decompress.quota.stdinBytes, Number.POSITIVE_INFINITY);
  assertEquals(decompress.quota.stdoutBytes, Number.POSITIVE_INFINITY);
});

Deno.test("gzip retained Worker: deterministic hello member has RFC1952 header/footer and decompresses only to base64", async () => {
  const first = await runGzip([], "hello");
  const second = await runGzip([], "hello");
  for (const result of [first, second]) {
    assertEquals(result.ok, true, JSON.stringify(result));
    assertEquals(result.stdout, null);
    assertEquals(result.stdoutBase64, HELLO_GZIP_BASE64);
    assertEquals(result.stdoutBytes, 25);
    assertEquals(result.counters.stdoutBytes, 25);
    const raw = decodeCanonicalBase64(result.stdoutBase64);
    assertEquals([...raw.slice(0, 3)], [0x1f, 0x8b, 0x08], "RFC1952 gzip header");
    const footer = new DataView(raw.buffer, raw.byteOffset + raw.byteLength - 8, 8);
    assertEquals(footer.getUint32(0, true), crc32(new TextEncoder().encode("hello")), "CRC32");
    assertEquals(footer.getUint32(4, true), 5, "ISIZE");
  }
  assertEquals(first.stdoutBase64, second.stdoutBase64, "retained compressor is deterministic");

  const decoded = await runGzip(["-d"], HELLO_GZIP_BASE64);
  assertEquals(decoded.ok, true, JSON.stringify(decoded));
  assertEquals(decoded.stdout, null, "decompression never selects text");
  assertEquals(decoded.stdoutBase64, "aGVsbG8=");
  assertEquals(decoded.stdoutBytes, 5);
});

Deno.test("gzip retained Worker: arbitrary binary, NUL/invalid UTF-8 and empty output round-trip losslessly", async () => {
  const binary = new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x00, 0xc3, 0x28]);
  const member = await gzipFixture(binary);
  const result = await runGzip(["-d"], encodeCanonicalBase64(member));
  assertEquals(result.ok, true, JSON.stringify(result));
  assertEquals(result.stdout, null);
  assertEquals(result.stdoutBase64, encodeCanonicalBase64(binary));
  assertEquals([...decodeCanonicalBase64(result.stdoutBase64)], [...binary]);

  const emptyMember = await gzipFixture(new Uint8Array(0));
  const empty = await runGzip(["-d"], encodeCanonicalBase64(emptyMember));
  assertEquals(empty.ok, true, JSON.stringify(empty));
  assertEquals(empty.stdout, null);
  assertEquals(empty.stdoutBase64, "");
  assertEquals(empty.stdoutBytes, 0);
});

Deno.test("gzip retained Worker: 64 KiB succeeds complete; past-cap and large expansions succeed whole (dptw)", async () => {
  const exactBytes = new Uint8Array(65536).fill(0x41);
  const exactMember = await gzipFixture(exactBytes);
  assert(exactMember.byteLength <= 1536, "exact-bound fixture fits immutable compressed-input cap");
  const exact = await runGzip(["-d"], encodeCanonicalBase64(exactMember));
  assertEquals(exact.ok, true, JSON.stringify(exact));
  assertEquals(exact.stdout, null);
  assertEquals(exact.stdoutBytes, 65536);
  assertEquals(exact.stdoutBase64.length, 87384);
  assertEquals(decodeCanonicalBase64(exact.stdoutBase64).byteLength, 65536);
  assertEquals(exact.counters.stdoutBytes, 65536);

  // dptw: expansions past the removed 64 KiB output cap succeed whole.
  const overMember = await gzipFixture(new Uint8Array(65537).fill(0x41));
  const over = await runGzip(["-d"], encodeCanonicalBase64(overMember));
  assertEquals(over.ok, true, `65,537-byte expansion succeeds: ${JSON.stringify(over).slice(0, 160)}`);
  assertEquals(over.stdoutBytes, 65537, "every expanded byte arrives");

  const bigMember = await gzipFixture(new Uint8Array(200000).fill(0x41));
  const started = performance.now();
  const big = await runGzip(["-d"], encodeCanonicalBase64(bigMember));
  const elapsed = performance.now() - started;
  assertEquals(big.ok, true, `200,000-byte expansion succeeds: ${JSON.stringify(big).slice(0, 160)}`);
  assertEquals(big.stdoutBytes, 200000, "every expanded byte arrives");
  assert(elapsed < 5000, `expansion completes within preview deadline (${elapsed}ms)`);
});

Deno.test("gzip retained Worker: malformed header/truncation/deflate/CRC failures expose no partial or stale output", async () => {
  const valid = decodeCanonicalBase64(HELLO_GZIP_BASE64);
  const variants = new Map<string, Uint8Array>();
  const header = new Uint8Array(valid); header[0] ^= 0xff; variants.set("malformed header", header);
  variants.set("truncated member", valid.slice(0, valid.length - 3));
  const deflate = new Uint8Array(valid); deflate[12] ^= 0x40; variants.set("corrupt deflate", deflate);
  const crc = new Uint8Array(valid); crc[crc.length - 8] ^= 0x01; variants.set("wrong CRC", crc);
  for (const [label, bytes] of variants) {
    const result = await runGzip(["-d"], encodeCanonicalBase64(bytes));
    expectNoPartial(result, label);
  }
});

Deno.test("gzip admission census: all 34 exact CAS parse against the 29-import host with exact 34/0 posture", async () => {
  assertEquals(SUPPORTED_WASI_PREVIEW1_IMPORTS.length, 29, "fd_renumber is the exact twenty-ninth supported import");
  const supported = new Set(SUPPORTED_WASI_PREVIEW1_IMPORTS);
  const census = new Map();
  for (const row of BUNDLED_TOOL_PACKAGE_ROWS) {
    const bytes = await Deno.readFile(new URL(`../extension/wasm/cas/${row.binary.sha256}.wasm`, import.meta.url));
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes))
      .filter((entry) => entry.module === "wasi_snapshot_preview1")
      .map((entry) => entry.name);
    census.set(row.toolId, imports.filter((name) => !supported.has(name)).sort());
  }
  assertEquals(census.size, 34);
  const enabled = BUNDLED_TOOL_PACKAGE_ROWS.filter((row) => row.admitted === true);
  assertEquals(enabled.length, 34);
  for (const row of enabled) assertEquals(census.get(row.toolId), [], `${row.toolId}: admitted imports`);
  const disabled = BUNDLED_TOOL_PACKAGE_ROWS.filter((row) => row.admitted !== true);
  assertEquals(disabled.map((row) => row.toolId).sort(), []);
  assertEquals(census.get("sqlite3_query_bounded"), [], "R11: the six sqlite imports are now SUPPORTED — sqlite's missing list is EMPTY (import-complete, admitted in R12)");
  assertEquals(census.get("touch"), [], "R6: path_filestat_set_times is now SUPPORTED, so touch's missing list is EMPTY — the R9 admission flips the descriptor only (no new import)");
  assertEquals(census.get("truncate"), [], "R5: fd_filestat_set_size is now SUPPORTED, so truncate's missing list is EMPTY — the R8 admission flips the descriptor only (no new import)");
  assertEquals(census.get("sqlite3_query_bounded"), [], "R12: sqlite's supported-import gap is empty and the package is admitted");
});

Deno.test("gzip service boundary: trusted expected encoding admits one arm and rejects hostile/mismatched arms", () => {
  const binary = boundPreviewResult({
    ok: true, phase: "completed", exitCode: 0, stdout: null, stdoutBase64: "aGVsbG8=",
    stdoutBytes: 5, stderr: "", errno: null, error: null,
  }, { stdoutEncoding: "base64" });
  assertEquals(binary.stdoutEncoding, "base64");
  assertEquals(binary.stdout, null);
  assertEquals(binary.stdoutBase64, "aGVsbG8=");
  assertEquals(binary.stdoutBytes, 5);

  const hostile = [
    [{ ok: true, stdout: "hello", stdoutBase64: null, stdoutBytes: 5, stderr: "" }, "base64"],
    [{ ok: true, stdout: null, stdoutBase64: "aGVsbG8=", stdoutBytes: 5, stderr: "" }, "utf8"],
    [{ ok: true, stdout: null, stdoutBase64: "aGVsbG8=", stdoutBytes: 4, stderr: "" }, "base64"],
    [{ ok: true, stdout: null, stdoutBase64: "Zh==", stdoutBytes: 1, stderr: "" }, "base64"],
    [{ ok: false, stdout: "", stdoutBase64: "", stdoutBytes: 0, stderr: "", error: "x" }, "base64"],
    [{ ok: false, stdout: "partial", stdoutBase64: null, stdoutBytes: 7, stderr: "", error: "x" }, "utf8"],
  ];
  for (const [result, stdoutEncoding] of hostile) {
    let rejected = false;
    try { boundPreviewResult(result, { stdoutEncoding }); } catch { rejected = true; }
    assert(rejected, `${stdoutEncoding}: ${JSON.stringify(result)}`);
  }
  for (const stdoutEncoding of [undefined, "result-borne", "binary"]) {
    let rejected = false;
    try { boundPreviewResult({}, { stdoutEncoding }); } catch { rejected = true; }
    assert(rejected, `unknown expected encoding ${stdoutEncoding}`);
  }
});
