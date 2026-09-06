// @ts-nocheck
// imageops admission KAT (chrome-agent-platform-e5o8, owner option B):
// the CAP-authored WASI image tool — pure-WASI, single-threaded, default-tier
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

// In-memory OPFS stand-in (the same minimal shape tests/wasm-streaming.test.ts
// uses: sync access handles over Map-backed nodes).
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

const ZXING_SHA256 = "f0e567aebad58ed30b0ca751918c59c2b81642e58a5df81d6dbdce3334c0f98f";
const ZXING_BYTES = 1173493;

// A QR of "CAP-INDEPENDENT-KAT-2026" generated with segno (pure-Python
// encoder) — an encoder INDEPENDENT of zxing-cpp, so a self-consistent but
// wrong writer cannot pass this vector. 274 bytes.
const KAT_QR_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAOgAAADoAQAAAADN0pXVAAAA2UlEQVR42u2ZQQ6FMAhEyb//ncf8wlDcuPdVjAnY1RSGoTX0ZPGtvn810v5+RvvLL57sjavhDYlEOraIi7eQrkjLry9ovGHAp+DNaGYczV+ZvnT+ljMedH9uaTLobUy8Rd187S/cULxDeN2xFmR0fkd9V4vm6lHSVy3EpUpcvPfA5czVo83izrW4eOWGHC1K+PORYpwbapLG4o0uZlNZ4s9XJq8sR+z5udpUjAZNv9/oQbJkGH7eH7dX4s7PN7yDvfj7K+3hQyfw11ntkob3507zGfr7/X0Arl6ebyGFsFV1+QAAAABJRU5ErkJggg==";

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("zxing: the shipped wasm is pure-WASI preview-1, single-threaded, default-tier bounded", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${ZXING_SHA256}.wasm`);
  assertEquals(bytes.length, ZXING_BYTES, "pinned size");
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  const fns = imports.filter((i) => i.kind === "function");
  assertEquals([...new Set(fns.map((f) => f.module))], ["wasi_snapshot_preview1"], "only WASI preview-1");
  assertEquals(fns.length, 12, "12 imports (args, environ, fd io, proc_exit)");
  assert(!fns.some((f) => /atomic|memory\.atomic/.test(f.name)), "no atomics/threads");
  const audit = auditWasmBinary(bytes, {
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    memory: { tier: "default", maxPages: 2048 },
  });
  assertEquals(audit.measured.memoryMax, 2048, "declared max memory is the default tier ceiling");
});

Deno.test("zxing: the pinned sha256 is the real committed CAS artifact", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${ZXING_SHA256}.wasm`);
  assertEquals(await sha256Hex(bytes), ZXING_SHA256, "CAS address IS the content hash");
});

Deno.test("zxing: tampering with the artifact breaks the pin", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${ZXING_SHA256}.wasm`);
  const tampered = new Uint8Array(bytes);
  tampered[tampered.length - 1] ^= 0xff;
  assert((await sha256Hex(tampered)) !== ZXING_SHA256, "a one-byte flip defeats the hash pin");
});

Deno.test("zxing: the evidence tree proves byte-for-byte reproducibility (build-a == build-b)", async () => {
  const a = await Deno.readFile("packages/bundled/evidence/zxing/build-a/zxing.wasm");
  const b = await Deno.readFile("packages/bundled/evidence/zxing/build-b/zxing.wasm");
  assertEquals(await sha256Hex(a), ZXING_SHA256, "build-a is the shipped artifact");
  assertEquals(await sha256Hex(b), ZXING_SHA256, "build-b reproduces it exactly");
});

Deno.test("zxing: manifest declares the default tier + read-only replay + compute capability", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/wasm/manifests/cap.bundled.zxing-1.0.0.manifest.json"));
  assertEquals(manifest.package.id, "cap.bundled.zxing");
  assertEquals(manifest.license.spdx, "Apache-2.0");
  const exec = manifest.executables[0];
  assertEquals(exec.memory.tier, "default");
  assertEquals(exec.memory.maxPages, 2048);
  assertEquals(exec.imports.allowed, ["wasi_snapshot_preview1"]);
  assertEquals(exec.replayClass, "read-only");
  assertEquals(exec.capabilities, ["compute"]);
  assertEquals(exec.sha256, ZXING_SHA256);
});

Deno.test("zxing: runs through the REAL stream worker — write then read round trip, independent KAT, fail-closed garbage", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === "zxing");
  assert(row, "zxing is in the bundled inventory");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);

  const { storage } = memoryStorage();
  const owner = "agent:run-zxing:hub";
  const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "run-zxing", now: () => 1 });

  async function run(args, inputBytes) {
    const inputRef = await createWasmStreamInput({ owner, storage });
    await appendWasmStreamInput({ ref: inputRef, owner, bytes: inputBytes, storage });
    await sealWasmStreamInput({ ref: inputRef, owner, storage });
    const outputRef = await createWasmStreamOutput({ owner, storage });
    const job = buildPreviewJob({
      input: validatePreviewInput({ toolId: "zxing", args, stdin: "" }),
      authority,
      quota: {
        hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
        stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
        stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
        fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
      },
    });
    const result = await executeWasmStreamJob({
      wasmBytes, job, owner, inputRef, outputRef, toolId: "zxing",
    }, { storage, authority });
    await sealWasmStreamOutput({ ref: outputRef, owner, bytes: result.receipt.stdoutBytes, receipt: result.receipt, storage });
    const window = await readWasmStreamWindow({ ref: outputRef, owner, offset: 0, length: result.receipt.stdoutBytes, storage });
    return { result, out: Uint8Array.from(atob(window.base64), (c) => c.charCodeAt(0)) };
  }

  // KAT 1: decode the independently-encoded QR (segno) — exact text.
  const kat = await run(["read"], Uint8Array.from(atob(KAT_QR_PNG_B64), (c) => c.charCodeAt(0)));
  assert(kat.result.ok, `KAT read failed: ${kat.result.error ?? ""}`);
  assertEquals(kat.result.exitCode, 0);
  assertEquals(new TextDecoder().decode(kat.out).trim(),
    '{"format":"QRCode","text":"CAP-INDEPENDENT-KAT-2026"}');

  // KAT 2: write a QR, read it back — the PNG must be a real image and the
  // payload must survive the round trip exactly.
  const w = await run(["write", "qrcode", "HELLO-CAP-2HTN"], new Uint8Array());
  assert(w.result.ok, `write failed: ${w.result.error ?? ""}`);
  assertEquals(w.result.exitCode, 0);
  assert(w.out.length > 100, "a real PNG, not an empty stream");
  assertEquals([...w.out.slice(1, 4)], [..."PNG"].map((c) => c.charCodeAt(0)), "PNG magic");
  const r = await run(["read"], w.out);
  assert(r.result.ok, `read failed: ${r.result.error ?? ""}`);
  assertEquals(r.result.exitCode, 0);
  assertEquals(new TextDecoder().decode(r.out).trim(), '{"format":"QRCode","text":"HELLO-CAP-2HTN"}');

  // KAT 3: EAN-13 round trip (a different symbology family).
  const w2 = await run(["write", "ean13", "5901234123457"], new Uint8Array());
  assert(w2.result.ok, `ean write failed: ${w2.result.error ?? ""}`);
  const r2 = await run(["read"], w2.out);
  assertEquals(new TextDecoder().decode(r2.out).trim(), '{"format":"EAN-13","text":"5901234123457"}');

  // Fail-closed: garbage on stdin exits non-zero, never silent empty output.
  const bad = await run(["read"], new TextEncoder().encode("not an image"));
  assert(bad.result.ok === false || bad.result.exitCode !== 0, "garbage input fails nonzero");

  // Fail-closed: an unknown format exits non-zero.
  const badFormat = await run(["write", "nonsense", "x"], new Uint8Array());
  assert(badFormat.result.ok === false || badFormat.result.exitCode !== 0, "unknown format fails nonzero");
});

Deno.test("zxing: resolves to the media-images purpose group", () => {
  assertEquals(toolPurposeGroup("zxing"), "media-images");
});
