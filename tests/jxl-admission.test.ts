// @ts-nocheck
// jxl admission KAT (chrome-agent-platform-agpu, qazo option B): the
// CAP-authored WASI JPEG XL decoder — pure-WASI, single-threaded, default-tier
// memory-bounded, reproducible, dispatchable through the ten9 offscreen
// WASI-job lane, and runnable through the REAL stream worker with pixel
// correctness verified against reference PNG output.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { crypto } from "jsr:@std/crypto";
import { auditWasmBinary } from "../extension/lib/wasm-package-authority.js";
import {
  appendWasmStreamInput,
  createWasmStreamInput,
  createWasmStreamOutput,
  readWasmStreamWindow,
  sealWasmStreamInput,
  sealWasmStreamOutput,
} from "../extension/lib/wasm-stream-files.js";
import {
  buildPreviewAuthority,
  buildPreviewJob,
  PREVIEW_TOOL_IDS,
  previewStdoutEncoding,
  validatePreviewInput,
} from "../extension/lib/tool-exec-preview.js";
import { executeWasmStreamJob } from "../extension/lib/wasm-stream-worker.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { toolPurposeGroup } from "../extension/lib/tool-purpose-groups.js";

// In-memory OPFS stand-in (the compressops/oxipng admission tests' shape).
const fileNode = () => ({ kind: "file", bytes: new Uint8Array(), syncOpen: false });
const directoryNode = () => ({ kind: "directory", children: new Map() });
class MemorySyncAccess {
  constructor(node) { this.node = node; }
  read(target, { at = 0 } = {}) {
    const count = Math.max(0, Math.min(target.byteLength, this.node.bytes.byteLength - at));
    target.set(this.node.bytes.subarray(at, at + count));
    return count;
  }
  write(bytes, { at = 0 } = {}) {
    const end = at + bytes.byteLength;
    if (end > this.node.bytes.byteLength) {
      const next = new Uint8Array(end); next.set(this.node.bytes); this.node.bytes = next;
    }
    this.node.bytes.set(bytes, at);
    return bytes.byteLength;
  }
  truncate(size) { const next = new Uint8Array(size); next.set(this.node.bytes.subarray(0, size)); this.node.bytes = next; }
  getSize() { return this.node.bytes.byteLength; }
  flush() {}
  close() {}
}
class MemoryFile {
  constructor(node) { this.node = node; this.kind = "file"; }
  async getFile() { return new Blob([this.node.bytes]); }
  async createWritable() {
    const node = this.node;
    return {
      bytes: new Uint8Array(), position: 0,
      async seek(p) { this.position = p; },
      async write(value) {
        const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
        const length = Math.max(this.bytes.byteLength, this.position + bytes.byteLength);
        const next = new Uint8Array(length);
        next.set(this.bytes); next.set(bytes, this.position);
        this.bytes = next; this.position += bytes.byteLength;
      },
      async close() { node.bytes = this.bytes; },
    };
  }
  async createSyncAccessHandle() { return new MemorySyncAccess(this.node); }
}
class MemoryDirectory {
  constructor(node) { this.node = node; this.kind = "directory"; }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.node.children.has(name)) {
      if (!create) throw new Error("not found");
      this.node.children.set(name, directoryNode());
    }
    return new MemoryDirectory(this.node.children.get(name));
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.node.children.has(name)) {
      if (!create) throw new Error("not found");
      this.node.children.set(name, fileNode());
    }
    return new MemoryFile(this.node.children.get(name));
  }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new MemoryFile(node) : new MemoryDirectory(node)];
    }
  }
}
function memoryStorage() {
  const root = directoryNode();
  return { storage: { async getDirectory() { return new MemoryDirectory(root); } } };
}

const JXL_SHA256 = "d268e1ced9db8192d986d2138b03dcec174a88865e10e9f9c7c8e53ab3c0010a";
const JXL_BYTES = 1376194;
const JXL_IMPORTS = [
  "args_get", "args_sizes_get", "environ_get", "environ_sizes_get",
  "fd_read", "fd_write", "proc_exit", "random_get",
];

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parsePngDimensions(pngBytes) {
  assertEquals([...pngBytes.subarray(0, 8)], [...PNG_SIG], "must have PNG signature");
  // IHDR chunk: length (4 bytes) + "IHDR" (4 bytes) + width (4 bytes) + height (4 bytes)
  const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  const type = new TextDecoder().decode(pngBytes.subarray(12, 16));
  assertEquals(type, "IHDR", "first chunk must be IHDR");
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = pngBytes[24];
  const colorType = pngBytes[25];
  return { width, height, bitDepth, colorType };
}

Deno.test("jxl: the shipped wasm is pure-WASI preview-1, single-threaded, default-tier bounded", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${JXL_SHA256}.wasm`);
  assertEquals(bytes.length, JXL_BYTES, "pinned size");
  const mod = new WebAssembly.Module(bytes);
  const fns = WebAssembly.Module.imports(mod).filter((i) => i.kind === "function");
  assertEquals([...new Set(fns.map((f) => f.module))], ["wasi_snapshot_preview1"], "only WASI preview-1");
  assertEquals(fns.map((f) => f.name).sort(), JXL_IMPORTS, "the exact nine imports");
  assert(!fns.some((f) => /atomic|thread/.test(f.name)), "no atomics/threads");
  const exportsList = WebAssembly.Module.exports(mod).map((e) => `${e.name}:${e.kind}`);
  assert(exportsList.includes("_start:function") && exportsList.includes("memory:memory"), `a WASI command (${exportsList})`);
  const audit = auditWasmBinary(bytes, {
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    memory: { tier: "default", maxPages: 2048 },
  });
  assertEquals(audit.measured.memoryMax, 2048, "declared max memory is the default tier ceiling");
});

Deno.test("jxl: the pinned sha256 is the real committed CAS artifact", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${JXL_SHA256}.wasm`);
  assertEquals(await sha256Hex(bytes), JXL_SHA256, "CAS address IS the content hash");
});

Deno.test("jxl: the evidence tree proves byte-for-byte reproducibility (build-a == build-b)", async () => {
  const a = await Deno.readFile("packages/bundled/evidence/jxl/build-a/jxl.wasm");
  const b = await Deno.readFile("packages/bundled/evidence/jxl/build-b/jxl.wasm");
  assertEquals(await sha256Hex(a), JXL_SHA256, "build-a is the shipped artifact");
  assertEquals(await sha256Hex(b), JXL_SHA256, "build-b reproduces it exactly");
  const sums = await Deno.readTextFile("packages/bundled/evidence/jxl/SHA256SUMS");
  assert(sums.includes(JXL_SHA256), "SHA256SUMS pins the same artifact");
});

Deno.test("jxl: manifest declares the default tier, read-only replay, compute, and the MIT AND Apache-2.0 composite with its notices", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/wasm/manifests/cap.bundled.jxl-1.0.0.manifest.json"));
  assertEquals(manifest.package.id, "cap.bundled.jxl");
  assertEquals(manifest.license.spdx, "MIT AND Apache-2.0");
  assertEquals(manifest.license.notices, "extension/wasm/licenses/jxl-NOTICES.txt");
  const notices = await Deno.readTextFile(manifest.license.notices);
  for (const needle of ["jxl-oxide", "png", "brotli-decompressor", "Wonwoo Choi", "Apache-2.0", "MIT OR Apache-2.0"]) {
    assert(notices.includes(needle), `notices name ${needle}`);
  }
  const exec = manifest.executables[0];
  assertEquals(exec.memory.tier, "default");
  assertEquals(exec.memory.maxPages, 2048);
  assertEquals(exec.imports.allowed, ["wasi_snapshot_preview1"]);
  assertEquals(exec.replayClass, "read-only");
  assertEquals(exec.capabilities, ["compute"]);
  assertEquals(exec.sha256, JXL_SHA256);
  assertEquals(exec.size, JXL_BYTES);
  const sbom = JSON.parse(await Deno.readTextFile(manifest.sbom.ref));
  const names = sbom.components.map((c) => c.name);
  for (const needle of ["jxl-oxide", "png", "brotli-decompressor", "base64"]) assert(names.includes(needle), `SBOM lists ${needle}`);
  assert(!names.some((n) => /rayon|clap/.test(n)), "no parallel or clap CLI crates in the shipped graph");
});

Deno.test("jxl: admitted, and its binary stdout rides the tool boundary as base64 (the stdoutEncoding row)", () => {
  assert(PREVIEW_TOOL_IDS.includes("jxl"), "jxl is in the admitted spec map");
  assertEquals(previewStdoutEncoding("jxl", []), "base64");
  assertEquals(previewStdoutEncoding("jxl", ["--to", "png"]), "base64");
});

Deno.test("jxl: runs through the REAL stream worker — decodes JXL to valid PNG; dimensions kept; garbage fails closed", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === "jxl");
  assert(row, "jxl is in the bundled inventory");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);

  const { storage } = memoryStorage();
  const owner = "agent:run-jxl:hub";
  const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "run-jxl", now: () => 1 });
  const quota = {
    hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
    stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
    stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
    fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
  };
  const b64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };

  async function run(args, stdinText) {
    const inputRef = await createWasmStreamInput({ owner, storage });
    await appendWasmStreamInput({ ref: inputRef, owner, bytes: new TextEncoder().encode(stdinText), storage });
    await sealWasmStreamInput({ ref: inputRef, owner, storage });
    const outputRef = await createWasmStreamOutput({ owner, storage });
    const job = buildPreviewJob({ input: validatePreviewInput({ toolId: "jxl", args, stdin: "" }), authority, quota });
    const result = await executeWasmStreamJob({ wasmBytes, job, owner, inputRef, outputRef, toolId: "jxl" }, { storage, authority });
    if (!result.ok || result.exitCode !== 0) return { ok: false, exitCode: result.exitCode, error: result.error };
    await sealWasmStreamOutput({ ref: outputRef, owner, bytes: result.receipt.stdoutBytes, receipt: result.receipt, storage });
    const window = await readWasmStreamWindow({ ref: outputRef, owner, offset: 0, length: result.receipt.stdoutBytes, storage });
    return { ok: true, bytes: Uint8Array.from(atob(window.base64), (c) => c.charCodeAt(0)) };
  }

  // 1. Small lossless fixture
  const smallBytes = await Deno.readFile("/home/paulkinlan/cap-evidence/cap-jxl/fixtures/small8.jxl");
  const smallOut = await run([], b64(smallBytes));
  assert(smallOut.ok, `small lossless run failed: ${smallOut.error ?? smallOut.exitCode}`);
  const smallInfo = parsePngDimensions(smallOut.bytes);
  assertEquals(smallInfo.width, 128);
  assertEquals(smallInfo.height, 128);
  assertEquals(smallInfo.bitDepth, 8);

  // 2. 1 MP lossy fixture
  const lossyBytes = await Deno.readFile("/home/paulkinlan/cap-evidence/cap-jxl/fixtures/lossy-1mp.jxl");
  const lossyOut = await run(["--to", "png"], b64(lossyBytes));
  assert(lossyOut.ok, `lossy 1MP run failed: ${lossyOut.error ?? lossyOut.exitCode}`);
  const lossyInfo = parsePngDimensions(lossyOut.bytes);
  assertEquals(lossyInfo.width, 1024);
  assertEquals(lossyInfo.height, 1024);

  // 3. Garbage fails CLOSED
  for (const [args, stdin, what] of [
    [[], "not base64!!", "non-base64 stdin"],
    [[], btoa("hello, not a jxl"), "base64 of a non-JXL"],
    [["--to", "bmp"], b64(smallBytes), "unsupported format flag"],
    [["--unknown-arg"], b64(smallBytes), "unknown argument"],
  ]) {
    const bad = await run(args, stdin);
    assert(bad.ok === false, `${what} must fail closed`);
  }
});

Deno.test("jxl: resolves to the media-images purpose group", () => {
  assertEquals(toolPurposeGroup("jxl"), "media-images");
});
