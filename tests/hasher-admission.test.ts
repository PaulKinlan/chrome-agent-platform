// @ts-nocheck
// hasher admission KAT (chrome-agent-platform-3wei): the CAP-authored WASI
// hash tool admitting the catalogue §3 candidates hash-wasm + blake3-wasm.
// The algorithms come from the audited reference implementations those npm
// packages wrap (RustCrypto sha2/sha3/blake2, official blake3). Pure-WASI,
// single-threaded, default-tier bounded, reproducible, and runnable through
// the REAL stream worker. Known-answer vectors: RFC 4634 / NIST / BLAKE3 spec.
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

const HASHER_SHA256 = "c5f0f9b744f1c5c5620ccf48bfa894c932c2f5ebb0105d7d8cadfa1df5de7d3b";
const HASHER_BYTES = 97135;

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
    const child = this.node.children.get(name);
    if (child.kind !== "directory") throw new Error("type mismatch");
    return new MemoryDirectory(child);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.node.children.has(name)) {
      if (!create) throw new Error("not found");
      this.node.children.set(name, fileNode());
    }
    const child = this.node.children.get(name);
    if (child.kind !== "file") throw new Error("type mismatch");
    return new MemoryFile(child);
  }
  async removeEntry(name) { if (!this.node.children.delete(name)) throw new Error("not found"); }
}
function memoryStorage() {
  const root = new MemoryDirectory(directoryNode());
  return { storage: { async getDirectory() { return root; } } };
}

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("hasher: the shipped wasm is pure-WASI preview-1, single-threaded, default-tier bounded", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${HASHER_SHA256}.wasm`);
  assertEquals(bytes.length, HASHER_BYTES, "pinned size");
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  const fns = imports.filter((i) => i.kind === "function");
  assertEquals([...new Set(fns.map((f) => f.module))], ["wasi_snapshot_preview1"], "only WASI preview-1");
  assert(!fns.some((f) => /atomic|memory\.atomic/.test(f.name)), "no atomics/threads");
  const audit = auditWasmBinary(bytes, {
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    memory: { tier: "default", maxPages: 2048 },
  });
  assertEquals(audit.measured.memoryMax, 2048, "declared max memory is the default tier ceiling");
});

Deno.test("hasher: the pinned sha256 is the real committed CAS artifact", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${HASHER_SHA256}.wasm`);
  assertEquals(await sha256Hex(bytes), HASHER_SHA256, "CAS address IS the content hash");
});

Deno.test("hasher: the evidence tree proves byte-for-byte reproducibility (build-a == build-b)", async () => {
  const a = await Deno.readFile("packages/bundled/evidence/hasher/build-a/hasher.wasm");
  const b = await Deno.readFile("packages/bundled/evidence/hasher/build-b/hasher.wasm");
  assertEquals(await sha256Hex(a), HASHER_SHA256, "build-a is the shipped artifact");
  assertEquals(await sha256Hex(b), HASHER_SHA256, "build-b reproduces it exactly");
});

Deno.test("hasher: manifest declares the default tier + read-only replay + compute/crypto capabilities", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/wasm/manifests/cap.bundled.hasher-1.0.0.manifest.json"));
  assertEquals(manifest.package.id, "cap.bundled.hasher");
  assertEquals(manifest.license.spdx, "MIT AND Apache-2.0");
  const exec = manifest.executables[0];
  assertEquals(exec.memory.tier, "default");
  assertEquals(exec.memory.maxPages, 2048);
  assertEquals(exec.imports.allowed, ["wasi_snapshot_preview1"]);
  assertEquals(exec.replayClass, "read-only");
  assertEquals(exec.capabilities.sort(), ["compute", "crypto"]);
  assertEquals(exec.sha256, HASHER_SHA256);
});

Deno.test("hasher: known-answer vectors through the REAL stream worker + determinism", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === "hasher");
  assert(row, "hasher is in the bundled inventory");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);

  const { storage } = memoryStorage();
  const owner = "agent:run-hasher:hub";
  const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "run-hasher", now: () => 1 });

  async function run(args, inputBytes) {
    const inputRef = await createWasmStreamInput({ owner, storage });
    await appendWasmStreamInput({ ref: inputRef, owner, bytes: inputBytes, storage });
    await sealWasmStreamInput({ ref: inputRef, owner, storage });
    const outputRef = await createWasmStreamOutput({ owner, storage });
    const job = buildPreviewJob({
      input: validatePreviewInput({ toolId: "hasher", args, stdin: "" }),
      authority,
      quota: {
        hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
        stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
        stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
        fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
      },
    });
    const result = await executeWasmStreamJob({
      wasmBytes, job, owner, inputRef, outputRef, toolId: "hasher",
    }, { storage, authority });
    assert(result.ok, `run ${args.join(" ")} failed: ${result.error ?? ""}`);
    assertEquals(result.exitCode, 0);
    await sealWasmStreamOutput({ ref: outputRef, owner, bytes: result.receipt.stdoutBytes, receipt: result.receipt, storage });
    const window = await readWasmStreamWindow({ ref: outputRef, owner, offset: 0, length: result.receipt.stdoutBytes, storage });
    return new TextDecoder().decode(Uint8Array.from(atob(window.base64), (c) => c.charCodeAt(0))).trim();
  }

  const hello = new TextEncoder().encode("hello");
  // Known-answer vectors (RFC 4634 / NIST / BLAKE3 spec, input "hello"):
  assertEquals(await run(["--algo", "sha256"], hello), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assertEquals(await run(["--algo", "sha512"], hello), "9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043");
  assertEquals(await run(["--algo", "sha3-256"], hello), "3338be694f50c5f338814986cdf0686453a888b84f424d792af4b9202398f392");
  assertEquals(await run(["--algo", "sha3-512"], hello), "75d527c368f2efe848ecf6b073a36767800805e9eef2b1857d5f984f036eb6df891d75f72d9b154518c1cd58835286d1da9a38deba3de98b5a53e5ed78a84976");
  assertEquals(await run(["--algo", "blake2b"], hello), "e4cfa39a3d37be31c59609e807970799caa68a19bfaa15135f165085e01d41a65ba1e1b146aeb6bd0092b49eac214c103ccfa3a365954bbbe52f74a2b3620c94");
  assertEquals(await run(["--algo", "blake3"], hello), "ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f");

  // Determinism: the same input hashes identically on a second run.
  assertEquals(await run(["--algo", "sha256"], hello), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");

  // RFC 4634 "abc" vector for sha256.
  assertEquals(await run(["--algo", "sha256"], new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");

  // Unknown algorithm fails CLOSED (non-zero exit), never a silent digest.
  const bad = await executeWasmStreamJob({
    wasmBytes,
    job: buildPreviewJob({
      input: validatePreviewInput({ toolId: "hasher", args: ["--algo", "md5"], stdin: "" }),
      authority,
      quota: {
        hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
        stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
        stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
        fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
      },
    }),
    owner,
    inputRef: (() => null)() ?? undefined,
    outputRef: undefined,
    toolId: "hasher",
  }, { storage, authority }).catch((e) => ({ ok: false, error: String(e) }));
  assert(!(bad && bad.ok === true), "an unknown algorithm must never be admitted");
});

Deno.test("hasher: resolves to the hashes-ids purpose group", () => {
  assertEquals(toolPurposeGroup("hasher"), "hashes-ids");
});
