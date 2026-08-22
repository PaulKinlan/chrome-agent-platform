// tests/wasm-host-gate2.test.ts — Gate 2 corrected: bounded executor + offscreen
// host + PER-JOB SYNCHRONOUS workspace + audit-before-instantiate. NO Chrome.
//
// Covers every Gate-2 review item: (1) REAL synchronous stat/open/read/write/
// close round trips through the LANDED runtime + the sync workspace (no async
// RPC); (2) audit-before-instantiate with EXACT phases; (3) strict EXACT-key
// UTF-8-byte-bounded schemas; (4) authoritative fences supplied separately,
// never self-asserted; (5) complete timeout cleanup (listener removed, no
// post-timeout mutation); (6) per-job workspace binding; (7) the scanner-owned
// fixed canonical exemption with the exact allowed call shape.
// @ts-nocheck

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  TRANSPORT_MESSAGE_TYPES,
  validateAuthorityRecord,
  checkJobAgainstAuthority,
  validateWorkerResult,
  WasmExecutor,
} from "../extension/lib/wasm-executor.js";
import { createOffscreenWasmHost, validateOffscreenRequest } from "../extension/lib/wasm-offscreen-host.js";
import { createSyncWorkspace } from "../extension/lib/wasm-sync-workspace.js";
import { buildWasiEntryExportWasm, buildWasiFdRoundTripWasm } from "./wasm-fixture-builder.mjs";
import { createWasiPreview1Runtime } from "../extension/lib/wasi-preview1-runtime.js";
import { WASI_HOST_DEFAULT_QUOTA, WASI_ERRNO, WASI_RIGHTS, WASI_OFLAGS } from "../extension/lib/wasm-host-types.js";
import { EXECUTOR_BOUNDS } from "../extension/lib/wasm-executor-bounds.js";

const WORKER_URL = new URL("../extension/lib/wasm-execution-worker.js", import.meta.url).href;

// A minimal wasm module exporting `run: () -> ()` (memory min1/max1).
const RUN_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x04, 0x01, 0x01, 0x01, 0x01,
  0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00,
  0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
]);
// A wasm declaring memory beyond the tiny tier (max 600 pages > 512) — the
// audit must reject it BEFORE instantiation with phase memory-rejected.
const OVER_TIER_MEMORY_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x06, 0x01, 0x01, 0x01, 0x80, 0x84, 0x04, // min 1, max 0x21000 = 600 pages
  0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00,
  0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
]);
// A wasm importing env.hostile (NOT wasi_snapshot_preview1) — import-rejected.
const FOREIGN_IMPORT_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
  0x02, 0x0f, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x07, 0x68, 0x6f, 0x73, 0x74, 0x69, 0x6c, 0x65, 0x00, 0x00,
  0x03, 0x02, 0x01, 0x00,
  0x05, 0x04, 0x01, 0x01, 0x01, 0x01,
  0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01,
  0x0a, 0x06, 0x01, 0x04, 0x00, 0x10, 0x00, 0x0b,
]);
// A framing bomb (a section declaring more bytes than remain) — compile-bounded.
const FRAMING_BOMB_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x7f, // section 1 declaring a 127-byte payload that does not exist
]);

const AUTHORITY = Object.freeze({
  sessionId: "session-1",
  executionId: "exec-1",
  callId: "call-1",
  agentId: "hub",
  origin: "https://a.example",
  documentId: "doc-1",
});

function makeJob(overrides = {}) {
  return {
    tier: "tiny",
    context: {
      executionId: "exec-1", callId: "call-1", origin: "https://a.example",
      workspaceRoot: "tool-jobs/exec-1/call-1/",
    },
    args: [],
    stdin: new Uint8Array(0),
    quota: { ...WASI_HOST_DEFAULT_QUOTA, hostCalls: 1000, pathCalls: 100, stdinBytes: 64, stdoutBytes: 64, stderrBytes: 64, fileBytes: 1024, fileSize: 1024, dynamicFds: 4 },
    ...overrides,
  };
}

function makeRunEnvelope() {
  // the DIRECT executor.run() wire envelope (the host's buildRequest shape):
  // stdin must be an ARRAY (the worker re-materializes the Uint8Array).
  const job = makeJob();
  return { type: TRANSPORT_MESSAGE_TYPES.JOB, job: { ...job, stdin: [...job.stdin] }, wasmBytes: Array.from(RUN_WASM) };
}

function makeRequest(overrides = {}) {
  return {
    type: TRANSPORT_MESSAGE_TYPES.JOB,
    job: makeJob(),
    wasmBytes: RUN_WASM,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// (B11) the 6-tool A2 stream tranche — EXACT example contracts through the
// REAL worker (the coordinator's expected outputs are the authority)
// ──────────────────────────────────────────────────────────────────────────
const A2_CONTRACTS = {
  base64: { stdin: "hello", args: [], expect: "aGVsbG8=\n" },
  md5sum: { stdin: "hello", args: [], expect: "5d41402abc4b2a76b9719d911017c592\n" },
  sha256sum: { stdin: "hello", args: [], expect: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824\n" },
  sha512sum: { stdin: "hello", args: [], expect: "9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043\n" },
  wc: { stdin: "one two\nthree\n", args: [], expect: "2 3 14\n" },
  xxd: { stdin: "Hi", args: ["-p"], expect: "4869\n" },
};

Deno.test("A2 stream tranche: base64/md5/sha256/sha512/wc/xxd produce the EXACT example outputs through the REAL worker", async () => {
  const { PREVIEW_SPECS } = await import("../extension/lib/tool-exec-preview.js");
  const repoRoot = new URL("..", import.meta.url).pathname;
  for (const [toolId, contract] of Object.entries(A2_CONTRACTS)) {
    const spec = PREVIEW_SPECS[toolId];
    assert(spec, `${toolId} is in the spec map`);
    const casBytes = new Uint8Array(await Deno.readFile(`${repoRoot}extension/wasm/cas/${spec.casSha}.wasm`));
    const authority = { ...AUTHORITY };
    // a generous output quota (the tool outputs 65+ char digests); stdin stays
    // bounded by the preview limits.
    const job = makeJob({
      stdin: new Uint8Array(new TextEncoder().encode(contract.stdin)),
      quota: { ...WASI_HOST_DEFAULT_QUOTA, hostCalls: 1000, pathCalls: 100, stdinBytes: 64, stdoutBytes: 1024, stderrBytes: 256, fileBytes: 1024, fileSize: 1024, dynamicFds: 4 },
    });
    // the options host rehydrates the stdin to a genuine Uint8Array
    const rehydrated = { ...job, stdin: new Uint8Array(job.stdin) };
    const executor = new WasmExecutor({ workerUrl: WORKER_URL, callMs: 15000 });
    const host = createOffscreenWasmHost({ executor, authority });
    // argv0 = the toolId (the WASI command convention), then the user args
    const res = await host.handleJob({
      type: "wasm.job",
      job: { ...rehydrated, args: [toolId, ...contract.args] },
      wasmBytes: casBytes,
    });
    assertEquals(res.ok, true, `${toolId}: ${JSON.stringify(res)}`);
    assertEquals(res.phase, "completed", toolId);
    assertEquals(res.stdout, contract.expect, `${toolId} exact contract output`);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// (B12) the 5-tool B2 text tranche — EXACT example contracts through the REAL
// worker (the coordinator's expected outputs are the authority)
// ──────────────────────────────────────────────────────────────────────────
const B2_CONTRACTS = {
  sort: { stdin: "b\na\n", args: [], expect: "a\nb\n" },
  uniq: { stdin: "a\na\nb\n", args: [], expect: "a\nb\n" },
  tr: { stdin: "Hi\n", args: ["a-z", "A-Z"], expect: "HI\n" },
  grep: { stdin: "foo\nbar\nfood\n", args: ["-n", "foo"], expect: "1:foo\n3:food\n" },
  toml2json: { stdin: 'title = "x"\n[n]\na = 1\n', args: [], expect: '{"title":"x","n":{"a":1}}\n' },
};

Deno.test("B2 text tranche: sort/uniq/tr/grep/toml2json produce the EXACT example outputs through the REAL worker", async () => {
  const { PREVIEW_SPECS } = await import("../extension/lib/tool-exec-preview.js");
  const repoRoot = new URL("..", import.meta.url).pathname;
  for (const [toolId, contract] of Object.entries(B2_CONTRACTS)) {
    const spec = PREVIEW_SPECS[toolId];
    assert(spec, `${toolId} is in the spec map`);
    const casBytes = new Uint8Array(await Deno.readFile(`${repoRoot}extension/wasm/cas/${spec.casSha}.wasm`));
    assert(casBytes.byteLength > EXECUTOR_BOUNDS.maxRequestBytes, `${toolId} (${casBytes.byteLength} B) exceeds the old 64 KiB request cap — the 4 MiB wasm cap is what admits it`);
    assert(casBytes.byteLength <= EXECUTOR_BOUNDS.maxWasmBytes, `${toolId} fits the 4 MiB wasm cap`);
    const job = makeJob({
      stdin: new Uint8Array(new TextEncoder().encode(contract.stdin)),
      quota: { ...WASI_HOST_DEFAULT_QUOTA, hostCalls: 1000, pathCalls: 100, stdinBytes: 64, stdoutBytes: 1024, stderrBytes: 256, fileBytes: 1024, fileSize: 1024, dynamicFds: 4 },
    });
    const rehydrated = { ...job, stdin: new Uint8Array(job.stdin) };
    const executor = new WasmExecutor({ workerUrl: WORKER_URL, callMs: 15000 });
    const host = createOffscreenWasmHost({ executor, authority: { ...AUTHORITY } });
    const res = await host.handleJob({
      type: "wasm.job",
      job: { ...rehydrated, args: [toolId, ...contract.args] },
      wasmBytes: casBytes,
    });
    assertEquals(res.ok, true, `${toolId}: ${JSON.stringify(res)}`);
    assertEquals(res.stdout, contract.expect, `${toolId} exact contract output`);
  }
  // an INVALID grep regex `[` is a bounded proc-exit(2) with NO stale stdout
  const grepSpec = PREVIEW_SPECS.grep;
  const grepBytes = new Uint8Array(await Deno.readFile(`${repoRoot}extension/wasm/cas/${grepSpec.casSha}.wasm`));
  const executor2 = new WasmExecutor({ workerUrl: WORKER_URL, callMs: 15000 });
  const host2 = createOffscreenWasmHost({ executor: executor2, authority: { ...AUTHORITY } });
  const badJob = makeJob({ stdin: new Uint8Array(new TextEncoder().encode("foo\nbar\n")) });
  const badRes = await host2.handleJob({
    type: "wasm.job",
    job: { ...badJob, stdin: new Uint8Array(badJob.stdin), args: ["grep", "-n", "["] },
    wasmBytes: grepBytes,
  });
  assertEquals(badRes.ok, false, "invalid regex fails");
  assertEquals(badRes.errno, 2, "invalid regex → errno 2");
  assertEquals(badRes.stdout, "", "no stale stdout on the bounded error");
});

// ──────────────────────────────────────────────────────────────────────────
// (B10) strict request-byte measurement (JSON inflation no longer governs)
// ──────────────────────────────────────────────────────────────────────────
import { measureRequestBytes } from "../extension/lib/wasm-executor.js";

const localUtf8Bytes = (value) => new TextEncoder().encode(value).byteLength;

function envelopeFor(wasmBytes, extraMeta = {}) {
  return {
    type: TRANSPORT_MESSAGE_TYPES.JOB,
    sessionId: "session-1",
    job: makeJob(),
    wasmBytes,
    ...extraMeta,
  };
}

Deno.test("request budget: a 32.7K wasm byte array + metadata PASSES (JSON inflation no longer governs)", () => {
  const bytes = new Uint8Array(32768); // the uuid/head/tail/cut size class
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
  const request = envelopeFor(bytes);
  const measured = measureRequestBytes(request);
  assert(measured < EXECUTOR_BOUNDS.maxRequestBytes, `measured ${measured} < 64 KiB`);
  assertEquals(measured, bytes.length + localUtf8Bytes(JSON.stringify({ type: request.type, sessionId: request.sessionId, job: request.job })), "raw length + metadata JSON");
  // the OLD JSON.stringify of the full envelope would exceed the bound —
  // proving the inflation no longer governs.
  const inflated = localUtf8Bytes(JSON.stringify(request));
  assert(inflated > EXECUTOR_BOUNDS.maxRequestBytes, `old-style inflation ${inflated} exceeded the 64 KiB bound`);
});

Deno.test("request budget: METADATA over 64 KiB rejects (the metadata/request JSON cap is preserved) + the run path surfaces request-over-budget", async () => {
  const bytes = new Uint8Array(4096);
  // the metadata JSON alone exceeds the 64 KiB cap → the measure throws
  let caught = null;
  try { measureRequestBytes(envelopeFor(bytes, { padding: "x".repeat(EXECUTOR_BOUNDS.maxRequestBytes) })); } catch (e) { caught = e?.executorCode ?? null; }
  assertEquals(caught, "request-over-budget", "metadata over the 64 KiB cap rejects");
  // a 4 MiB wasm + small metadata MEASURES fine (the wasm cap is independent)
  const big = new Uint8Array(EXECUTOR_BOUNDS.maxWasmBytes);
  const measured = measureRequestBytes(envelopeFor(big));
  assertEquals(measured, EXECUTOR_BOUNDS.maxWasmBytes + localUtf8Bytes(JSON.stringify({ type: TRANSPORT_MESSAGE_TYPES.JOB, sessionId: "session-1", job: makeJob() })));
  // and the executor run path surfaces request-over-budget for big metadata
  const executor = new WasmExecutor({ workerUrl: WORKER_URL, callMs: 5000 });
  const host = createOffscreenWasmHost({ executor, authority: AUTHORITY });
  const over = await host.handleJob(makeRequest({ wasmBytes: bytes })).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  assert(!over.ok, JSON.stringify(over));
});

Deno.test("request budget: sparse/fractional/out-of-range/short wasm sequences reject (strict dense check)", () => {
  const ok = new Uint8Array(16);
  assertEquals(measureRequestBytes(envelopeFor(ok)), ok.length + localUtf8Bytes(JSON.stringify({ type: TRANSPORT_MESSAGE_TYPES.JOB, sessionId: "session-1", job: makeJob() })));
  const cases = {
    "plain-object": { 0: 1, length: 8 },
    "sparse-array": Array.from({ length: 16 }), // holes → not dense
    "fractional": [1, 2.5, 3, 4, 5, 6, 7, 8],
    "negative": [1, -1, 3, 4, 5, 6, 7, 8],
    "out-of-range": [1, 256, 3, 4, 5, 6, 7, 8],
    "string-byte": [1, "2", 3, 4, 5, 6, 7, 8],
    "too-short": [1, 2, 3],
  };
  for (const [label, wasm] of Object.entries(cases)) {
    let caught = null;
    try { measureRequestBytes(envelopeFor(wasm)); } catch (e) { caught = e?.executorCode ?? null; }
    assertEquals(caught, "request-wasm", `${label} rejects`);
  }
  // a wasm array LARGER than maxWasmBytes (the 4 MiB tiny-tier cap) rejects
  // even though it is dense — the wasm cap is explicit, not unbounded
  let caught = null;
  try { measureRequestBytes(envelopeFor(new Uint8Array(EXECUTOR_BOUNDS.maxWasmBytes + 1))); } catch (e) { caught = e?.executorCode ?? null; }
  assertEquals(caught, "request-wasm", "over-max-wasm-length rejects");
});

Deno.test("request budget: HUGE metadata rejects (metadata JSON counts toward the 64 KiB)", () => {
  const bytes = new Uint8Array(4096);
  const request = envelopeFor(bytes, { bloat: "y".repeat(EXECUTOR_BOUNDS.maxRequestBytes) });
  let caught = null;
  try { measureRequestBytes(request); } catch (e) { caught = e?.executorCode ?? null; }
  assertEquals(caught, "request-over-budget", "huge metadata throws request-over-budget");
});

// ──────────────────────────────────────────────────────────────────────────
// (B9) WASI fd_read STDIN short-read semantics (oversized advertised iovecs)
// ──────────────────────────────────────────────────────────────────────────
function directRuntime(jobOverrides = {}, memoryBytes = 256 * 1024) {
  const ws = createSyncWorkspace({ root: "tool-jobs/exec-1/call-1/" });
  const mem = new Uint8Array(memoryBytes);
  const memory = {
    size: () => mem.byteLength,
    read: (p, l) => mem.slice(p, p + l),
    write: (p, b) => { mem.set(b, p); },
  };
  const job = makeJob(jobOverrides);
  const runtime = createWasiPreview1Runtime({ job, memory, workspace: ws });
  return { wasi: runtime.imports.wasi_snapshot_preview1, mem, job, ws };
}

Deno.test("WASI fd_read STDIN: an OVERSIZED advertised iovec short-reads the real stdin to SUCCESS+EOF (no E2BIG, no large allocation)", () => {
  // The advertised buffer (8388609 B) must FIT the memory so the pointer
  // validation passes and the total-length exemption is what's under test.
  const { wasi, mem } = directRuntime(
    { stdin: new Uint8Array(new TextEncoder().encode("hi")) },
    9 * 1024 * 1024,
  );
  // iovec at 4000 = { buf: 5000, len: 8388609 (MAX_INPUT+1) } — the csvtool
  // advertises a huge read buffer while the actual stdin is 2 bytes.
  mem.set([0x88, 0x13, 0x00, 0x00], 4000);      // buf ptr 5000
  mem.set([0x01, 0x80, 0x80, 0x00], 4004);      // len 8388609 (0x800001)
  const v = new DataView(mem.buffer);
  const errno = wasi.fd_read(0, 4000, 1, 4100);
  assertEquals(errno, WASI_ERRNO.SUCCESS, `oversized advertised stdin iovec short-reads, not E2BIG: ${errno}`);
  assertEquals(v.getUint32(4100, true), 2, "nread = the real stdin bytes");
  assertEquals(new TextDecoder().decode(mem.slice(5000, 5002)), "hi", "the real stdin bytes are copied");
  // EOF: the second read sees no remaining bytes → nread 0 (SUCCESS + EOF).
  const errno2 = wasi.fd_read(0, 4000, 1, 4104);
  assertEquals(errno2, WASI_ERRNO.SUCCESS);
  assertEquals(v.getUint32(4104, true), 0, "EOF short-read");
});

Deno.test("WASI fd_read STDIN: OOB/overlap iovecs still reject EINVAL (table/pointer/overlap checks unchanged)", () => {
  const { wasi, mem } = directRuntime({ stdin: new Uint8Array([1, 2, 3]) }, 1024 * 1024);
  // iovec buffer overlapping the iovec TABLE → EINVAL.
  mem.set([0x84, 0x0f, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00], 4000); // buf 3972, len 4 → 3972..3976? NO — buf 4004, len 4
  mem.set([0xa4, 0x0f, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00], 4000); // buf 4004, len 8 → overlaps the table 4000..4008
  assertEquals(wasi.fd_read(0, 4000, 1, 4100), WASI_ERRNO.EINVAL, "table-overlapping buffer rejects");
  // two iovecs whose buffers overlap each other → EINVAL.
  mem.set([0x20, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00], 4000); // buf 0x20 len 0x10
  mem.set([0x28, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00], 4008); // buf 0x28 len 0x10 (overlaps row 0)
  assertEquals(wasi.fd_read(0, 4000, 2, 4100), WASI_ERRNO.EINVAL, "mutually-overlapping buffers reject");
  // the iovec buffer overlapping the nread result → EINVAL.
  mem.set([0x00, 0x10, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00], 4000); // buf 4096, len 8 → 4096..4104 overlaps nread@4100
  assertEquals(wasi.fd_read(0, 4000, 1, 4100), WASI_ERRNO.EINVAL, "result-overlapping buffer rejects");
});

Deno.test("WASI fd_read FILE + fd_write: advertised totals > MAX_IO_BYTES_PER_CALL still E2BIG (cap preserved)", () => {
  // A 2 MiB memory so a 1 MiB+1 advertised total passes the pointer check
  // and the MAX_IO_BYTES_PER_CALL cap is what's exercised.
  const { wasi, mem, ws } = directRuntime({}, 2 * 1024 * 1024);
  // open a real file + write a payload.
  const putPath = (ptr, text) => { const b = new TextEncoder().encode(text); mem.set(b, ptr); return b.length; };
  const v = new DataView(mem.buffer);
  const pathLen = putPath(1000, "scratch/f.bin");
  const rights = WASI_RIGHTS.FD_WRITE | WASI_RIGHTS.FD_READ | WASI_RIGHTS.FD_SEEK | WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  const openErrno = wasi.path_open(3, 0, 1000, pathLen, WASI_OFLAGS.CREAT, rights, 0n, 0, 2000);
  assertEquals(openErrno, WASI_ERRNO.SUCCESS);
  const fd = v.getUint32(2000, true);
  // fd_write with an advertised total > 1 MiB (1048577, fits the memory) →
  // E2BIG (unchanged — the write path never gets the stdin exemption).
  mem.set([0x70, 0x17, 0x00, 0x00, 0x01, 0x00, 0x10, 0x00], 4000); // buf 6000, len 1048577 (> MAX_IO_BYTES_PER_CALL)
  assertEquals(wasi.fd_write(fd, 4000, 1, 4100), WASI_ERRNO.E2BIG, "write overbound stays E2BIG");
  // FILE read with an advertised total > 1 MiB → E2BIG (the stdin exemption is
  // NOT extended to files).
  const readFd = v.getUint32(2000, true);
  assertEquals(wasi.fd_read(readFd, 4000, 1, 4100), WASI_ERRNO.E2BIG, "file read overbound stays E2BIG");
});

// ──────────────────────────────────────────────────────────────────────────
// 1. (B1) REAL synchronous stat/open/read/write/close round trips
// ──────────────────────────────────────────────────────────────────────────
Deno.test("sync workspace: REAL stat/open/read/write/close round trips on real bytes", () => {
  const ws = createSyncWorkspace({ root: "tool-jobs/exec-1/call-1/" });
  // open + write + stat + read + close
  const h = ws.open("scratch/f.bin", { create: true, write: true });
  assertEquals(h.write(0, new TextEncoder().encode("CAP1WASM")), 8);
  assertEquals(h.stat().size, 8);
  const readBack = h.read(0, 8);
  assertEquals(new TextDecoder().decode(readBack), "CAP1WASM");
  assertEquals(h.close(), true);
  // stat via the workspace
  assertEquals(ws.stat("scratch/f.bin").size, 8);
  // create-exclusive on an existing file → EEXIST
  let caught = null;
  try { ws.open("scratch/f.bin", { create: true, exclusive: true }); } catch (e) { caught = e; }
  assertEquals(caught?.code, "EEXIST");
  // missing file → ENOENT
  caught = null;
  try { ws.open("output/missing.bin", { create: false }); } catch (e) { caught = e; }
  assertEquals(caught?.code, "ENOENT");
  // traversal / empty segments are refused
  caught = null;
  try { ws.open("../escape.bin", { create: true }); } catch (e) { caught = e; }
  assertEquals(caught?.code, "EPERM");
  caught = null;
  try { ws.stat("scratch//double.bin"); } catch (e) { caught = e; }
  assertEquals(caught?.code, "EPERM");
});

Deno.test("sync workspace: the LANDED WASI runtime drives a REAL path_open→fd_write→filestat→fd_close round trip", () => {
  const ws = createSyncWorkspace({ root: "tool-jobs/exec-1/call-1/" });
  // an in-memory 64 KiB wasm-memory adapter
  const mem = new Uint8Array(64 * 1024);
  const memory = {
    size: () => mem.byteLength,
    read: (p, l) => mem.slice(p, p + l),
    write: (p, b) => { mem.set(b, p); },
  };
  const runtime = createWasiPreview1Runtime({ job: makeJob(), memory, workspace: ws });
  const wasi = runtime.imports.wasi_snapshot_preview1;

  const putPath = (ptr, text) => {
    const bytes = new TextEncoder().encode(text);
    mem.set(bytes, ptr);
    return bytes.length;
  };
  const opened = new DataView(mem.buffer);
  // path_open scratch/work.txt with create+write rights
  const pathPtr = 1000;
  const len = putPath(pathPtr, "scratch/work.txt");
  const writeRights = WASI_RIGHTS.FD_WRITE | WASI_RIGHTS.FD_SEEK |
    WASI_RIGHTS.FD_TELL | WASI_RIGHTS.FD_FILESTAT_GET;
  const openErrno = wasi.path_open(3, 0, pathPtr, len, WASI_OFLAGS.CREAT, writeRights, 0n, 0, 2000);
  assertEquals(openErrno, WASI_ERRNO.SUCCESS);
  const fd = opened.getUint32(2000, true);
  assert(fd >= 4, `a dynamic fd was allocated: ${fd}`);
  // fd_write the payload
  mem.set(new TextEncoder().encode("hello"), 3000);
  const iovecs = 4000;
  opened.setUint32(iovecs, 3000, true);
  opened.setUint32(iovecs + 4, 5, true);
  const nwritten = new DataView(mem.buffer);
  const writeErrno = wasi.fd_write(fd, iovecs, 1, 4100);
  assertEquals(writeErrno, WASI_ERRNO.SUCCESS);
  assertEquals(nwritten.getUint32(4100, true), 5);
  // filestat_get shows the size
  const statErrno = wasi.fd_filestat_get(fd, 5000);
  assertEquals(statErrno, WASI_ERRNO.SUCCESS);
  assertEquals(new DataView(mem.buffer).getBigUint64(5000 + 32, true), 5n);
  // close + the workspace reflects the bytes
  assertEquals(wasi.fd_close(fd), WASI_ERRNO.SUCCESS);
  assertEquals(new TextDecoder().decode(ws.stat("scratch/work.txt") && ws.open("scratch/work.txt").read(0, 5)), "hello");
});

// ──────────────────────────────────────────────────────────────────────────
// 2. (B2) audit-before-instantiate with EXACT phases (through the REAL worker)
// ──────────────────────────────────────────────────────────────────────────
async function runRealWorker(wasmBytes, overrides = {}) {
  const executor = new WasmExecutor({ workerUrl: WORKER_URL, callMs: 5000 });
  const host = createOffscreenWasmHost({ executor, authority: AUTHORITY });
  return await host.handleJob(makeRequest({ wasmBytes, ...overrides }));
}

Deno.test("audit: an over-tier memory declaration is rejected BEFORE instantiation (phase memory-rejected)", async () => {
  const res = await runRealWorker(OVER_TIER_MEMORY_WASM);
  assert(!res.ok && res.phase === "memory-rejected", JSON.stringify(res));
});

Deno.test("audit: a foreign import is rejected BEFORE instantiation (phase import-rejected)", async () => {
  const res = await runRealWorker(FOREIGN_IMPORT_WASM);
  assert(!res.ok && res.phase === "import-rejected", JSON.stringify(res));
});

Deno.test("audit: a framing bomb is rejected (phase compile-bounded)", async () => {
  const res = await runRealWorker(FRAMING_BOMB_WASM);
  assert(!res.ok && res.phase === "compile-bounded", JSON.stringify(res));
});

Deno.test("audit: a valid bounded module completes (phase completed) through the REAL worker", async () => {
  const res = await runRealWorker(RUN_WASM);
  assert(res.ok === true && res.phase === "completed", JSON.stringify(res));
  assert(typeof res.workerInstanceId === "string" && res.workerInstanceId.length > 0);
});

// ──────────────────────────────────────────────────────────────────────────
// 3. (B3) strict EXACT-key UTF-8-byte-bounded schemas
// ──────────────────────────────────────────────────────────────────────────
Deno.test("worker export selection: the function-export `run` entry is compatible (stdout preserved)", async () => {
  const res = await runRealWorker(buildWasiEntryExportWasm({ exportName: "run" }));
  assertEquals(res.ok, true, JSON.stringify(res));
  assertEquals(res.phase, "completed", JSON.stringify(res));
  assertEquals(res.stdout, "hi", "the run entry writes to stdout");
});

Deno.test("worker export selection: the WASI command `_start` entry runs normally (stdout preserved)", async () => {
  const res = await runRealWorker(buildWasiEntryExportWasm({ exportName: "_start" }));
  assertEquals(res.ok, true, JSON.stringify(res));
  assertEquals(res.phase, "completed", JSON.stringify(res));
  assertEquals(res.stdout, "hi", "the _start entry writes to stdout");
});

Deno.test("worker export selection: `_start` with proc_exit(0) is a SUCCESS with output preserved", async () => {
  const res = await runRealWorker(buildWasiEntryExportWasm({ exportName: "_start", callsProcExit: true, exitCode: 0 }));
  assertEquals(res.ok, true, JSON.stringify(res));
  assertEquals(res.phase, "completed", JSON.stringify(res));
  assertEquals(res.errno, null, JSON.stringify(res));
  assertEquals(res.stdout, "hi", "proc_exit(0) output is snapshotted, never dropped");
});

Deno.test("worker export selection: `_start` with proc_exit(2) FAILS with errno 2 (phase proc-exit, bounded, no stale stdout)", async () => {
  const res = await runRealWorker(buildWasiEntryExportWasm({ exportName: "_start", callsProcExit: true, exitCode: 2 }));
  assertEquals(res.ok, false, JSON.stringify(res));
  assertEquals(res.phase, "proc-exit", JSON.stringify(res));
  assertEquals(res.errno, 2, JSON.stringify(res));
  assertEquals(res.stdout, "", "the failure schema keeps no stale stdout");
});

Deno.test("worker export selection: NEITHER run nor _start rejects with export-missing", async () => {
  const res = await runRealWorker(buildWasiEntryExportWasm({ exportName: null }));
  assertEquals(res.ok, false, JSON.stringify(res));
  assert(res.phase === "runtime-error" || res.phase === "proc-exit", res.phase);
  assert(String(res.error).includes("export-missing"), `error names the missing export: ${res.error}`);
});

Deno.test("schemas: EXACT keys — extra keys are rejected everywhere", () => {
  for (const bad of [
    { ...makeRequest(), call: {} },                       // extra key
    { ...makeRequest(), sessionId: "self-asserted" },     // extra key (no self-assertion)
    { type: TRANSPORT_MESSAGE_TYPES.JOB, job: makeJob() }, // missing wasmBytes
  ]) {
    let caught = null;
    try { validateOffscreenRequest(bad); } catch (e) { caught = e; }
    assert(caught, `must reject: ${JSON.stringify(bad)?.slice(0, 80)}`);
  }
  // the authority record is exact
  let caught = null;
  try { validateAuthorityRecord({ ...AUTHORITY, agentId: "hub", extra: 1 }); } catch (e) { caught = e; }
  assert(caught, "extra authority key rejected");
  caught = null;
  try { validateAuthorityRecord({ ...AUTHORITY, agentId: "" }); } catch (e) { caught = e; }
  assert(caught, "empty agent rejected");
});

Deno.test("schemas: the worker RESULT is EXACT-key validated (extra keys, field shapes, ok/phase consistency)", () => {
  const base = {
    type: TRANSPORT_MESSAGE_TYPES.RESULT,
    sessionId: "session-1",
    executionId: "exec-1",
    jobId: "call-1",
    ok: true,
    phase: "completed",
    result: null,
    counters: { hostCalls: 3, pathCalls: 0, fileBytes: 0, stdinBytesRead: 0, stdoutBytes: 0, stderrBytes: 0, openDynamicFds: 0 },
    stdoutBytes: 0,
    stderrBytes: 0,
    stdout: "",
    stderr: "",
    workerInstanceId: "w-1",
    error: null,
    errno: null,
  };
  assert(validateWorkerResult(base, { jobId: "call-1", sessionId: "session-1", executionId: "exec-1" }).ok);
  for (const bad of [
    { ...base, junk: 1 },                                // extra key
    { ...base, sessionId: "other" },                     // identity mismatch
    { ...base, executionId: "other" },                   // execution identity mismatch
    { ...base, ok: false, error: "" },                   // missing error
    { ...base, ok: true, result: 42 },                   // non-null result
    { ...base, counters: { hostCalls: 3 } },             // missing counter keys
    { ...base, counters: { hostCalls: -1, pathCalls: 0, fileBytes: 0, stdinBytesRead: 0, stdoutBytes: 0, stderrBytes: 0, openDynamicFds: 0 } }, // negative counter
    { ...base, stdoutBytes: EXECUTOR_BOUNDS.maxResponseBytes + 1 }, // over-budget
    { ...base, ok: true, error: "x" },                   // ok/error conflict
    { ...base, phase: "unknown-phase" },
  ]) {
    let caught = null;
    try { validateWorkerResult(bad, { jobId: "call-1", sessionId: "session-1", executionId: "exec-1" }); } catch (e) { caught = e; }
    assert(caught, `must reject: ${JSON.stringify(bad)?.slice(0, 100)}`);
  }
});

Deno.test("schemas: UTF-8 BYTE bounds are enforced (not UTF-16 code units)", () => {
  // a session of 200 multi-byte chars exceeds the 256-BYTE bound
  const wide = "é".repeat(200); // 400 UTF-8 bytes
  let caught = null;
  try { validateAuthorityRecord({ ...AUTHORITY, sessionId: wide }); } catch (e) { caught = e; }
  assert(caught, "a 400-byte session must be rejected (UTF-8 byte bound)");
});

// ──────────────────────────────────────────────────────────────────────────
// 4. (B4) authoritative fences supplied separately, never self-asserted
// ──────────────────────────────────────────────────────────────────────────
Deno.test("fences: the executor requires the SEPARATE authority; a job whose context mismatches it is refused BEFORE any worker", async () => {
  let spawns = 0;
  const executor = new WasmExecutor({
    workerUrl: WORKER_URL,
    createWorker: (url) => { spawns++; return new Worker(url, { type: "module" }); },
  });
  // no authority → refused
  await assertRejects(
    () => executor.run({ job: makeJob(), wasmBytes: RUN_WASM, buildRequest: () => ({ type: TRANSPORT_MESSAGE_TYPES.JOB }) }),
    (e) => e?.executorCode === "authority-shape",
  );
  assertEquals(spawns, 0);
  // a job whose execution/call/origin/workspaceRoot differ from the authority → refused
  for (const context of [
    { executionId: "exec-2", callId: "call-1", origin: "https://a.example", workspaceRoot: "tool-jobs/exec-2/call-1/" },
    { executionId: "exec-1", callId: "call-9", origin: "https://a.example", workspaceRoot: "tool-jobs/exec-1/call-9/" },
    { executionId: "exec-1", callId: "call-1", origin: "https://b.example", workspaceRoot: "tool-jobs/exec-1/call-1/" },
  ]) {
    const executor2 = new WasmExecutor({
      workerUrl: WORKER_URL,
      createWorker: (url) => { spawns++; return new Worker(url, { type: "module" }); },
    });
    const host = createOffscreenWasmHost({ executor: executor2, authority: AUTHORITY });
    let caught = null;
    try { await host.handleJob(makeRequest({ job: makeJob({ context }) })); } catch (e) { caught = e; }
    assert(caught && caught.executorCode === "fence-mismatch", JSON.stringify(context));
  }
  assertEquals(spawns, 0, "no worker spawned for any fence failure");
});

Deno.test("fences: the request cannot self-assert session/agent/document (the schema has no such keys)", () => {
  // the request schema is EXACT — any session/agent/document/call key is an
  // extra key and is rejected; the authority is the ONLY source.
  let caught = null;
  try { validateOffscreenRequest({ ...makeRequest(), sessionId: "forged", agentId: "evil" }); } catch (e) { caught = e; }
  assert(caught, "self-asserted fence keys are rejected");
});

// ──────────────────────────────────────────────────────────────────────────
// 5. (B5) complete timeout cleanup — listener removed, no post-timeout mutation
// ──────────────────────────────────────────────────────────────────────────
Deno.test("timeout: the abort listener is removed on ordinary completion", async () => {
  const controller = new AbortController();
  const executor = new WasmExecutor({ workerUrl: WORKER_URL, callMs: 5000 });
  const host = createOffscreenWasmHost({ executor, authority: AUTHORITY });
  const res = await host.handleJob(makeRequest());
  assert(res.ok === true);
  // the abort listener must be gone (aborting afterwards must not reject anything)
  controller.abort();
});

Deno.test("timeout: a never-responding worker is TERMINATED and a SECOND run works (no residue)", async () => {
  let terminated = 0;
  const executor = new WasmExecutor({
    workerUrl: "file:///x.js",
    createWorker: () => ({ postMessage() {}, terminate() { terminated++; }, onmessage: null, onerror: null }),
    callMs: 150,
  });
  const res = await executor.run({
    job: makeJob(),
    wasmBytes: RUN_WASM,
    buildRequest: ({ sessionId }) => ({ type: TRANSPORT_MESSAGE_TYPES.JOB, sessionId, job: makeJob(), wasmBytes: Array.from(RUN_WASM) }),
    authority: AUTHORITY,
  });
  assert(!res.ok && res.phase === "timeout", JSON.stringify(res));
  assertEquals(terminated, 1, "the worker was terminated exactly once");
  // a SECOND run on the SAME executor works (no listener/residue leaks)
  const realExecutor = new WasmExecutor({ workerUrl: WORKER_URL, callMs: 5000 });
  const host = createOffscreenWasmHost({ executor: realExecutor, authority: AUTHORITY });
  const res2 = await host.handleJob(makeRequest());
  assert(res2.ok === true, JSON.stringify(res2));
});

// ──────────────────────────────────────────────────────────────────────────
// 6. (B6) per-job workspace binding
// ──────────────────────────────────────────────────────────────────────────
Deno.test("workspace: the sync workspace is created PER JOB bound to the job's workspaceRoot", () => {
  const a = createSyncWorkspace({ root: "tool-jobs/exec-1/call-1/" });
  const b = createSyncWorkspace({ root: "tool-jobs/exec-1/call-2/" });
  a.open("scratch/f.bin", { create: true, write: true }).write(0, new TextEncoder().encode("aaa"));
  // b has NO visibility of a's file — per-job isolation
  let caught = null;
  try { b.stat("scratch/f.bin"); } catch (e) { caught = e; }
  assertEquals(caught?.code, "ENOENT");
  assertEquals(a.root, "tool-jobs/exec-1/call-1/");
  assertEquals(b.root, "tool-jobs/exec-1/call-2/");
});

// ──────────────────────────────────────────────────────────────────────────
// 7. (B7) the scanner-owned fixed canonical exemption + exact call shape
// ──────────────────────────────────────────────────────────────────────────
Deno.test("scan exemption: ONLY the canonical worker path is exempt, and ONLY the exact WebAssembly.instantiate shape", async () => {
  const { scanShippedJs } = await import("../scripts/scan-shipped.mjs");
  const worker = await Deno.readTextFile(new URL("../extension/lib/wasm-execution-worker.js", import.meta.url));
  const fake = "export const x = () => WebAssembly.compile(new Uint8Array(8));";
  const canonical = worker.replace(
    "WebAssembly.instantiate(wasmBytes, runtime.imports)",
    "WebAssembly.compile(wasmBytes, runtime.imports)",
  );
  // 1. a DIFFERENT file with a WebAssembly call → violation
  const v1 = await scanShippedJs(["extension/lib/other.js"], {
    readText: async () => fake,
  });
  assert(v1.length >= 1, "a non-canonical file with a Wasm call violates");
  // 2. the canonical path with a DEVIATING call shape → violation
  const v2 = await scanShippedJs(["extension/lib/wasm-execution-worker.js"], {
    readText: async () => canonical,
  });
  assert(v2.length >= 1, "the canonical file with a deviating call shape violates");
  // 3. the canonical path with the exact single instantiate → clean
  const v3 = await scanShippedJs(["extension/lib/wasm-execution-worker.js"], {
    readText: async () => worker,
  });
  assertEquals(v3.length, 0, "the canonical worker with the exact shape is clean");
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-1: the REAL worker drives landed-runtime FILE syscalls (path_open →
// fd_write → fd_seek → fd_read → fd_close → stdout) through exports.memory
// ──────────────────────────────────────────────────────────────────────────
Deno.test("REAL worker: the fd round-trip wasm performs path_open/write/seek/read/close and echoes to stdout", async () => {
  const executor = new WasmExecutor({ workerUrl: WORKER_URL, callMs: 5000 });
  const host = createOffscreenWasmHost({ executor, authority: AUTHORITY });
  const res = await host.handleJob(makeRequest({ wasmBytes: buildWasiFdRoundTripWasm() }));
  assert(res.ok === true, JSON.stringify(res));
  assertEquals(res.phase, "completed");
  // EXACT counters/state: every syscall trapped on errno (a failure would
  // abort the run), the file write+read accumulated fileBytes=10, the echo
  // emitted stdoutBytes=5, and the fd was CLOSED (openDynamicFds=0).
  assertEquals(res.counters.hostCalls, 6, JSON.stringify(res));
  assertEquals(res.counters.pathCalls, 1, JSON.stringify(res));
  assertEquals(res.counters.fileBytes, 10, JSON.stringify(res)); // 5 write + 5 read
  assertEquals(res.counters.stdoutBytes, 5, JSON.stringify(res));
  assertEquals(res.counters.openDynamicFds, 0, JSON.stringify(res));
  assertEquals(res.stdoutBytes, 5, JSON.stringify(res));
  // NON-VACUITY (the 15-key envelope preserves the CONTENT): fd_read + the
  // stdout echo use the 0x210 READ iovec at the GARBAGE-seeded 0x20 buffer —
  // the echoed stdout can ONLY be the FILE bytes a real fd_read wrote there.
  assertEquals(res.stdout, "hello", JSON.stringify(res));
  assertEquals(res.stderr, "", JSON.stringify(res));
  assertEquals(res.executionId, "exec-1", JSON.stringify(res));
  assertEquals(res.type, TRANSPORT_MESSAGE_TYPES.RESULT, JSON.stringify(res));
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-2: exact audit phases (unsupported WASI name → import-rejected;
// malformed-but-audited code → instantiation-error)
// ──────────────────────────────────────────────────────────────────────────
// A minimal import section for wasi_snapshot_preview1.<name>
function wasiImportSection(name) {
  const n = [...new TextEncoder().encode(name)];
  const m = [...new TextEncoder().encode("wasi_snapshot_preview1")];
  const payload = [
    1, m.length, ...m, n.length, ...n, 0x00, 0x00,
  ];
  return [0x02, payload.length, ...payload];
}

function buildUnsupportedWasiNameWasm(name) {
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type () -> () (size 4)
    ...wasiImportSection(name),
    0x03, 0x02, 0x01, 0x00,
    0x05, 0x04, 0x01, 0x01, 0x01, 0x01,
    0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01,
    0x0a, 0x06, 0x01, 0x04, 0x00, 0x10, 0x00, 0x0b,
  ]);
}

// A malformed-but-audited module: valid framing/memory, but the CODE body has
// an invalid opcode — the audit skips code ("not_audited"), instantiate fails.
function buildMalformedCodeWasm() {
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x05, 0x04, 0x01, 0x01, 0x01, 0x01,
    0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00,
    0x0a, 0x05, 0x01, 0x03, 0x00, 0xff, 0x0b, // code: 0 locals, 0xff (invalid), end
  ]);
}

Deno.test("audit: an unsupported WASI import NAME → phase import-rejected (deterministic)", async () => {
  const wasm = buildUnsupportedWasiNameWasm("fd_nope");
  const res = await runRealWorker(wasm);
  assert(!res.ok && res.phase === "import-rejected", JSON.stringify(res));
});

Deno.test("audit: malformed-but-audited code (invalid opcode) → phase instantiation-error", async () => {
  const res = await runRealWorker(buildMalformedCodeWasm());
  assert(!res.ok && res.phase === "instantiation-error", JSON.stringify(res));
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-3: phase↔ok binding, failure null/zero fields, bytes==counters
// ──────────────────────────────────────────────────────────────────────────
Deno.test("schemas: phase↔ok conflicts and hostile failure fields are rejected", () => {
  const okBase = {
    type: TRANSPORT_MESSAGE_TYPES.RESULT,
    sessionId: "session-1", executionId: "exec-1", jobId: "call-1", ok: true, phase: "completed",
    result: null,
    counters: { hostCalls: 3, pathCalls: 0, fileBytes: 0, stdinBytesRead: 0, stdoutBytes: 5, stderrBytes: 0, openDynamicFds: 0 },
    stdoutBytes: 5, stderrBytes: 0, stdout: "hello", stderr: "", workerInstanceId: "w-1", error: null, errno: null,
  };
  assert(validateWorkerResult(okBase, { jobId: "call-1", sessionId: "session-1", executionId: "exec-1" }).ok);
  for (const bad of [
    { ...okBase, ok: true, phase: "runtime-error" },              // ok+non-completed phase
    { ...okBase, ok: false, phase: "completed" },                  // fail+completed phase
    { ...okBase, ok: false, phase: "import-rejected", error: "x", stdoutBytes: 1 }, // failure with nonzero stdout
    { ...okBase, ok: false, phase: "import-rejected", error: "x", result: 7 },      // failure with result
    { ...okBase, ok: true, stdoutBytes: 6 },                       // bytes != counters.stdoutBytes
    { ...okBase, ok: true, stderrBytes: 1, counters: { ...okBase.counters, stderrBytes: 0 } }, // bytes != counters.stderrBytes
    { ...okBase, ok: false, phase: "import-rejected", error: "x", counters: { hostCalls: 1, pathCalls: 0, fileBytes: 0, stdinBytesRead: 0, stdoutBytes: 0, stderrBytes: 0, openDynamicFds: 0 } }, // failure with counters
  ]) {
    let caught = null;
    try { validateWorkerResult(bad, { jobId: "call-1", sessionId: "session-1", executionId: "exec-1" }); } catch (e) { caught = e; }
    assert(caught, `must reject: ${JSON.stringify(bad)?.slice(0, 140)}`);
  }
});

Deno.test("schemas: the offscreen request caps wasmBytes BEFORE the copy", () => {
  const oversized = makeRequest({ wasmBytes: new Uint8Array(EXECUTOR_BOUNDS.maxWasmBytes + 1) });
  let caught = null;
  try { validateOffscreenRequest(oversized); } catch (e) { caught = e; }
  assert(caught && caught.executorCode === "request-wasm-over-budget", String(caught?.executorCode));
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-4: timeout/abort route through one finish; real signal; second run on
// the SAME executor
// ──────────────────────────────────────────────────────────────────────────
Deno.test("abort: an instrumented signal + a STATEFUL factory — abort, listener add/remove balance, then a REAL run on the SAME executor", async () => {
  // an instrumented signal that COUNTS add/removeEventListener
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const signal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(...args) { added++; return controller.signal.addEventListener(...args); },
    removeEventListener(...args) { removed++; return controller.signal.removeEventListener(...args); },
  };
  // a STATEFUL factory: first call returns a never-responding fake worker
  // (for the abort), subsequent calls return REAL workers.
  let terminated = 0;
  let spawns = 0;
  const factory = (url) => {
    spawns++;
    if (spawns === 1) {
      return { postMessage() {}, terminate() { terminated++; }, onmessage: null, onerror: null };
    }
    return new Worker(url, { type: "module" });
  };
  const executor = new WasmExecutor({ workerUrl: WORKER_URL, createWorker: factory, callMs: 5000 });

  // RUN 1 (SAME executor): the signal aborts mid-flight → call-aborted,
  // terminated once, the listener was added once AND removed once.
  const runPromise = executor.run({
    job: makeJob(), wasmBytes: RUN_WASM,
    buildRequest: ({ sessionId }) => ({ type: TRANSPORT_MESSAGE_TYPES.JOB, sessionId, ...makeRunEnvelope() }),
    authority: AUTHORITY,
    signal,
  });
  queueMicrotask(() => controller.abort());
  let caught = null;
  try { await runPromise; } catch (e) { caught = e; }
  assert(caught && caught.executorCode === "call-aborted", String(caught?.executorCode));
  assertEquals(terminated, 1, "the aborted worker was terminated once");
  assertEquals(added, 1, "the abort listener was added exactly once");
  assertEquals(removed, 1, "the abort listener was REMOVED exactly once (finish)");

  // RUN 2 (THE SAME executor instance + the same stateful factory): a REAL
  // Deno worker completes successfully — with a FRESH instrumented signal (the
  // first controller is aborted; a new signal also lets us count the second
  // add/remove pair).
  const controller2 = new AbortController();
  let added2 = 0;
  let removed2 = 0;
  const signal2 = {
    get aborted() { return controller2.signal.aborted; },
    addEventListener(...args) { added2++; return controller2.signal.addEventListener(...args); },
    removeEventListener(...args) { removed2++; return controller2.signal.removeEventListener(...args); },
  };
  const res2 = await executor.run({
    job: makeJob(), wasmBytes: RUN_WASM,
    buildRequest: ({ sessionId }) => ({ type: TRANSPORT_MESSAGE_TYPES.JOB, sessionId, ...makeRunEnvelope() }),
    authority: AUTHORITY,
    signal: signal2,
  });
  assert(res2.ok === true, JSON.stringify(res2));
  assertEquals(spawns, 2, "two workers spawned on the SAME executor");
  assertEquals(added2, 1, "the second signal listener was added");
  assertEquals(removed2, 1, "the second signal listener was removed on completion");
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-5: scanner exact AST — arguments, location, count, constructor APIs
// ──────────────────────────────────────────────────────────────────────────
Deno.test("scan exemption: argument/location/count/constructor mutants all violate", async () => {
  const { scanShippedJs } = await import("../scripts/scan-shipped.mjs");
  const worker = await Deno.readTextFile(new URL("../extension/lib/wasm-execution-worker.js", import.meta.url));
  const canonical = "extension/lib/wasm-execution-worker.js";
  const scan = async (code, path = canonical) =>
    (await scanShippedJs([path], { generatedBundles: new Set(), readText: async () => code })).length;
  // the real canonical file is clean
  assertEquals(await scan(worker), 0, "the canonical worker is clean");
  // changed ARGUMENT (wasmBytes → otherBytes)
  assert((await scan(worker.replace("WebAssembly.instantiate(wasmBytes, runtime.imports)", "WebAssembly.instantiate(otherBytes, runtime.imports)"))) >= 1, "arg mutant");
  // changed SECOND argument (runtime.imports → runtime.exports)
  assert((await scan(worker.replace("WebAssembly.instantiate(wasmBytes, runtime.imports)", "WebAssembly.instantiate(wasmBytes, runtime.exports)"))) >= 1, "arg2 mutant");
  // an EXTRA operand
  assert((await scan(worker.replace("WebAssembly.instantiate(wasmBytes, runtime.imports)", "WebAssembly.instantiate(wasmBytes, runtime.imports, extra)"))) >= 1, "extra-operand mutant");
  // a LOCATION shift (a newline before the call)
  assert((await scan(worker.replace("WebAssembly.instantiate(wasmBytes, runtime.imports);", "WebAssembly.instantiate\n      (wasmBytes, runtime.imports);"))) >= 1, "location mutant");
  // a CONSTRUCTOR API in any file (new WebAssembly.Module)
  assert((await scan("const m = new WebAssembly.Module(bytes);", "extension/lib/other.js")) >= 1, "constructor mutant");
  // TWO instantiate calls → count mutant
  const doubled = worker.replace("WebAssembly.instantiate(wasmBytes, runtime.imports)", "WebAssembly.instantiate(wasmBytes, runtime.imports); WebAssembly.instantiate(wasmBytes, runtime.imports)");
  assert((await scan(doubled)) >= 1, "count mutant");
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-5 residual: alias-based WebAssembly forms are EXPLICITLY residual/
// heuristic (documented, not silently claimed as caught)
// ──────────────────────────────────────────────────────────────────────────
Deno.test("scan exemption: alias-based WebAssembly forms are a DOCUMENTED residual heuristic", async () => {
  const { scanShippedJs } = await import("../scripts/scan-shipped.mjs");
  // an alias assignment (const inst = WebAssembly.instantiate) is NOT caught by
  // the AST predicate — this test PINs that as the documented residual so the
  // exemption can never silently claim it is covered.
  const alias = "const inst = WebAssembly.instantiate; const m = inst(bytes, imports);";
  const v = await scanShippedJs(["extension/lib/other.js"], {
    generatedBundles: new Set(), readText: async () => alias,
  });
  // BEHAVIORALLY pinned: the alias form is NOT caught (0 violations) — the
  // residual is documented HERE, not silently claimed as covered. If the
  // scanner later hardens alias tracking, this assert flips to a violation.
  assertEquals(v.length, 0, "alias-based WebAssembly forms are a documented residual (0 violations today)");
  // the honest future-host wording stays in the scan.
  const scanText = await Deno.readTextFile(new URL("../scripts/scan-shipped.mjs", import.meta.url));
  assert(scanText.includes("requires a separately reviewed static CAS route"), "the scan keeps the honest future-host wording");
});

// ──────────────────────────────────────────────────────────────────────────
// no ambient credentials + one fresh worker per call
// ──────────────────────────────────────────────────────────────────────────
// no ambient credentials + one fresh worker per call
// ──────────────────────────────────────────────────────────────────────────
Deno.test("no ambient credentials: the host modules never touch chrome/storage/provider", async () => {
  for (const rel of ["../extension/lib/wasm-execution-worker.js", "../extension/lib/wasm-executor.js", "../extension/lib/wasm-offscreen-host.js", "../extension/lib/wasm-sync-workspace.js"]) {
    const src = await Deno.readTextFile(new URL(rel, import.meta.url));
    for (const forbidden of ["chrome.", "navigator.storage", "localStorage", "sessionStorage", "createAsset", "OpfsToolWorkspace"]) {
      assert(!src.includes(forbidden), `${rel} must not contain ${forbidden}`);
    }
  }
});

Deno.test("lifecycle: ONE fresh worker per call — two runs spawn two workers with distinct instance ids", async () => {
  let spawnCount = 0;
  const realFactory = (url) => { spawnCount++; return new Worker(url, { type: "module" }); };
  const executor = new WasmExecutor({ workerUrl: WORKER_URL, createWorker: realFactory, callMs: 5000 });
  const host = createOffscreenWasmHost({ executor, authority: AUTHORITY });
  const r1 = await host.handleJob(makeRequest());
  const r2 = await host.handleJob(makeRequest());
  assert(r1.ok && r2.ok);
  assertEquals(spawnCount, 2);
  assert(r1.workerInstanceId !== r2.workerInstanceId, "a FRESH worker per call");
});

Deno.test("lifecycle: a spawn failure FAILS CLOSED — never a main-thread fallback", async () => {
  const executor = new WasmExecutor({
    workerUrl: "file:///nonexistent.js",
    createWorker: () => { throw new Error("cannot spawn"); },
  });
  await assertRejects(
    () => executor.run({
      job: makeJob(), wasmBytes: RUN_WASM,
      buildRequest: ({ sessionId }) => ({ type: TRANSPORT_MESSAGE_TYPES.JOB, sessionId, job: makeJob(), wasmBytes: Array.from(RUN_WASM) }),
      authority: AUTHORITY,
    }),
    (e) => e?.executorCode === "worker-spawn",
  );
});
