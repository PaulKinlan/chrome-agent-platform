// @ts-nocheck
// compressops admission KAT (chrome-agent-platform-y75s):
// the CAP-authored WASI compression tool — pure-WASI, single-threaded, default-tier
// memory-bounded, reproducible, and runnable through the REAL stream worker.
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
import { buildPreviewAuthority, buildPreviewJob, validatePreviewInput } from "../extension/lib/tool-exec-preview.js";
import { executeWasmStreamJob } from "../extension/lib/wasm-stream-worker.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { toolPurposeGroup } from "../extension/lib/tool-purpose-groups.js";

// In-memory OPFS stand-in
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

const COMPRESSOPS_SHA256 = "3eb5e7391eefe588758169d012186064577c9e9060af8e027c33702e2aa207ce";
const COMPRESSOPS_BYTES = 1411911;

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("compressops: the shipped wasm is pure-WASI preview-1, single-threaded, default-tier bounded", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${COMPRESSOPS_SHA256}.wasm`);
  assertEquals(bytes.length, COMPRESSOPS_BYTES, "pinned size");
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  const fns = imports.filter((i) => i.kind === "function");
  assertEquals([...new Set(fns.map((f) => f.module))], ["wasi_snapshot_preview1"], "only WASI preview-1");
  assertEquals(fns.length, 7, "7 imports (args, environ, fd io, proc_exit)");
  assert(!fns.some((f) => /atomic|memory\.atomic/.test(f.name)), "no atomics/threads");
  const audit = auditWasmBinary(bytes, {
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    memory: { tier: "default", maxPages: 2048 },
  });
  assertEquals(audit.measured.memoryMax, 2048, "declared max memory is the default tier ceiling");
});

Deno.test("compressops: the pinned sha256 is the real committed CAS artifact", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${COMPRESSOPS_SHA256}.wasm`);
  assertEquals(await sha256Hex(bytes), COMPRESSOPS_SHA256, "CAS address IS the content hash");
});

Deno.test("compressops: the evidence tree proves byte-for-byte reproducibility (build-a == build-b)", async () => {
  const a = await Deno.readFile("packages/bundled/evidence/compressops/build-a/compressops.wasm");
  const b = await Deno.readFile("packages/bundled/evidence/compressops/build-b/compressops.wasm");
  assertEquals(await sha256Hex(a), COMPRESSOPS_SHA256, "build-a is the shipped artifact");
  assertEquals(await sha256Hex(b), COMPRESSOPS_SHA256, "build-b reproduces it exactly");
});

Deno.test("compressops: manifest declares the default tier + read-only replay + compute capability", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/wasm/manifests/cap.bundled.compressops-1.0.0.manifest.json"));
  assertEquals(manifest.package.id, "cap.bundled.compressops");
  assertEquals(manifest.license.spdx, "Apache-2.0");
  const exec = manifest.executables[0];
  assertEquals(exec.memory.tier, "default");
  assertEquals(exec.memory.maxPages, 2048);
  assertEquals(exec.imports.allowed, ["wasi_snapshot_preview1"]);
  assertEquals(exec.replayClass, "read-only");
  assertEquals(exec.capabilities, ["compute"]);
  assertEquals(exec.sha256, COMPRESSOPS_SHA256);
});

Deno.test("compressops: runs through the REAL stream worker — zstd, brotli, info", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === "compressops");
  assert(row, "compressops is in the bundled inventory");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);

  const { storage } = memoryStorage();
  const owner = "agent:run-compressops:hub";
  const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "run-compressops", now: () => 1 });

  async function run(args, inputBytes) {
    const inputRef = await createWasmStreamInput({ owner, storage });
    await appendWasmStreamInput({ ref: inputRef, owner, bytes: inputBytes, storage });
    await sealWasmStreamInput({ ref: inputRef, owner, storage });
    const outputRef = await createWasmStreamOutput({ owner, storage });
    const job = buildPreviewJob({
      input: validatePreviewInput({ toolId: "compressops", args, stdin: "" }),
      authority,
      quota: {
        hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
        stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
        stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
        fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
      },
    });
    const result = await executeWasmStreamJob({
      wasmBytes, job, owner, inputRef, outputRef, toolId: "compressops",
    }, { storage, authority });
    assert(result.ok, `run ${args.join(" ")} failed: ${result.error ?? ""}`);
    assertEquals(result.exitCode, 0);
    await sealWasmStreamOutput({ ref: outputRef, owner, bytes: result.receipt.stdoutBytes, receipt: result.receipt, storage });
    const window = await readWasmStreamWindow({ ref: outputRef, owner, offset: 0, length: result.receipt.stdoutBytes, storage });
    return Uint8Array.from(atob(window.base64), (c) => c.charCodeAt(0));
  }

  const sample = new TextEncoder().encode("Hello Chrome Agent Platform! ".repeat(10));

  // 1. zstd compress -> decompress round-trip
  const zstdComp = await run(["zstd", "-l", "3"], sample);
  assert(zstdComp.length > 0);
  const zstdDecomp = await run(["zstd", "-d"], zstdComp);
  assertEquals(new TextDecoder().decode(zstdDecomp), new TextDecoder().decode(sample));

  // 2. info detects zstd frame magic
  const infoOut = await run(["info"], zstdComp);
  const info = JSON.parse(new TextDecoder().decode(infoOut));
  assertEquals(info.magic, "zstd");
  assertEquals(info.bytes, zstdComp.length);

  // 3. brotli compress -> decompress round-trip
  const brotliComp = await run(["brotli", "-q", "5"], sample);
  assert(brotliComp.length > 0);
  const brotliDecomp = await run(["brotli", "-d"], brotliComp);
  assertEquals(new TextDecoder().decode(brotliDecomp), new TextDecoder().decode(sample));

  // 4. invalid command fails closed nonzero
  const badRef = await createWasmStreamInput({ owner, storage });
  await appendWasmStreamInput({ ref: badRef, owner, bytes: sample, storage });
  await sealWasmStreamInput({ ref: badRef, owner, storage });
  const badOut = await createWasmStreamOutput({ owner, storage });
  const bad = await executeWasmStreamJob({
    wasmBytes, job: buildPreviewJob({
      input: validatePreviewInput({ toolId: "compressops", args: ["invalid_subcommand"], stdin: "" }),
      authority,
      quota: {
        hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
        stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
        stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
        fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
      },
    }), owner, inputRef: badRef, outputRef: badOut, toolId: "compressops",
  }, { storage, authority });
  assert(bad.ok === false || bad.exitCode !== 0, "invalid subcommand fails nonzero");
});

Deno.test("compressops: toolPurposeGroup resolves to files-data", () => {
  assertEquals(toolPurposeGroup("compressops"), "files-data");
});
