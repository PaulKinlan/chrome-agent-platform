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

const IMAGEOPS_SHA256 = "b86d327e1d17ddce9a07fb92a43fb151372bbaa662b5bf6ef8aba138fc3e2e32";
const IMAGEOPS_BYTES = 725870;

// A real 2x2 red RGB PNG (73 bytes).
const RED_2X2_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";

function pngBytes() {
  return Uint8Array.from(atob(RED_2X2_PNG_B64), (c) => c.charCodeAt(0));
}

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("imageops: the shipped wasm is pure-WASI preview-1, single-threaded, default-tier bounded", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${IMAGEOPS_SHA256}.wasm`);
  assertEquals(bytes.length, IMAGEOPS_BYTES, "pinned size");
  const mod = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(mod);
  const fns = imports.filter((i) => i.kind === "function");
  assertEquals([...new Set(fns.map((f) => f.module))], ["wasi_snapshot_preview1"], "only WASI preview-1");
  assertEquals(fns.length, 8, "8 imports (fd io, random, clock, proc_exit)");
  assert(!fns.some((f) => /atomic|memory\.atomic/.test(f.name)), "no atomics/threads");
  const audit = auditWasmBinary(bytes, {
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    memory: { tier: "default", maxPages: 2048 },
  });
  assertEquals(audit.measured.memoryMax, 2048, "declared max memory is the default tier ceiling");
});

Deno.test("imageops: the pinned sha256 is the real committed CAS artifact", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${IMAGEOPS_SHA256}.wasm`);
  assertEquals(await sha256Hex(bytes), IMAGEOPS_SHA256, "CAS address IS the content hash");
});

Deno.test("imageops: the evidence tree proves byte-for-byte reproducibility (build-a == build-b)", async () => {
  const a = await Deno.readFile("packages/bundled/evidence/imageops/build-a/imageops.wasm");
  const b = await Deno.readFile("packages/bundled/evidence/imageops/build-b/imageops.wasm");
  assertEquals(await sha256Hex(a), IMAGEOPS_SHA256, "build-a is the shipped artifact");
  assertEquals(await sha256Hex(b), IMAGEOPS_SHA256, "build-b reproduces it exactly");
});

Deno.test("imageops: manifest declares the default tier + read-only replay + compute capability", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/wasm/manifests/cap.bundled.imageops-1.0.0.manifest.json"));
  assertEquals(manifest.package.id, "cap.bundled.imageops");
  assertEquals(manifest.license.spdx, "Apache-2.0");
  const exec = manifest.executables[0];
  assertEquals(exec.memory.tier, "default");
  assertEquals(exec.memory.maxPages, 2048);
  assertEquals(exec.imports.allowed, ["wasi_snapshot_preview1"]);
  assertEquals(exec.replayClass, "read-only");
  assertEquals(exec.capabilities, ["compute"]);
  assertEquals(exec.sha256, IMAGEOPS_SHA256);
});

Deno.test("imageops: runs through the REAL stream worker — info, resize, convert", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === "imageops");
  assert(row, "imageops is in the bundled inventory");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);

  const { storage } = memoryStorage();
  const owner = "agent:run-imageops:hub";
  const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "run-imageops", now: () => 1 });

  // Production contract (6s2c): image bytes ride stdin as BASE64 TEXT (the
  // tool protocol's stdin is a JSON string); the tool decodes in-wasm.
  async function run(args, inputBytes) {
    const inputRef = await createWasmStreamInput({ owner, storage });
    const b64 = new TextEncoder().encode(btoa(String.fromCharCode(...inputBytes)));
    await appendWasmStreamInput({ ref: inputRef, owner, bytes: b64, storage });
    await sealWasmStreamInput({ ref: inputRef, owner, storage });
    const outputRef = await createWasmStreamOutput({ owner, storage });
    const job = buildPreviewJob({
      input: validatePreviewInput({ toolId: "imageops", args, stdin: "" }),
      authority,
      quota: {
        hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
        stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
        stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
        fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
      },
    });
    const result = await executeWasmStreamJob({
      wasmBytes, job, owner, inputRef, outputRef, toolId: "imageops",
    }, { storage, authority });
    assert(result.ok, `run ${args.join(" ")} failed: ${result.error ?? ""}`);
    assertEquals(result.exitCode, 0);
    await sealWasmStreamOutput({ ref: outputRef, owner, bytes: result.receipt.stdoutBytes, receipt: result.receipt, storage });
    const window = await readWasmStreamWindow({ ref: outputRef, owner, offset: 0, length: result.receipt.stdoutBytes, storage });
    return Uint8Array.from(atob(window.base64), (c) => c.charCodeAt(0));
  }

  // info: the 2x2 red PNG reports its geometry + format.
  const info = JSON.parse(new TextDecoder().decode(await run(["info"], pngBytes())));
  assertEquals(info.width, 2);
  assertEquals(info.height, 2);
  assertEquals(info.format, "png");
  assertEquals(info.bytes, 73);

  // resize to 1x1: the output is a valid PNG the module itself can re-read.
  const resized = await run(["resize", "--width", "1", "--height", "1"], pngBytes());
  const resizedInfo = JSON.parse(new TextDecoder().decode(await run(["info"], resized)));
  assertEquals(resizedInfo.width, 1);
  assertEquals(resizedInfo.height, 1);
  assertEquals(resizedInfo.format, "png");

  // convert to webp: the output re-reads as webp.
  const webp = await run(["convert", "--format", "webp"], pngBytes());
  const webpInfo = JSON.parse(new TextDecoder().decode(await run(["info"], webp)));
  assertEquals(webpInfo.format, "webp");

  // garbage input fails CLOSED (non-zero exit), never a silent empty output.
  // (base64 text that does not decode to an image)
  const badRef = await createWasmStreamInput({ owner, storage });
  await appendWasmStreamInput({ ref: badRef, owner, bytes: new TextEncoder().encode(btoa("not an image")), storage });
  await sealWasmStreamInput({ ref: badRef, owner, storage });
  const badOut = await createWasmStreamOutput({ owner, storage });
  const bad = await executeWasmStreamJob({
    wasmBytes, job: buildPreviewJob({
      input: validatePreviewInput({ toolId: "imageops", args: ["info"], stdin: "" }),
      authority,
      quota: {
        hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
        stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
        stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
        fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
      },
    }), owner, inputRef: badRef, outputRef: badOut, toolId: "imageops",
  }, { storage, authority });
  assert(bad.ok === false || bad.exitCode !== 0, "garbage input fails nonzero");
});

Deno.test("imageops: resolves to the media-images purpose group", () => {
  assertEquals(toolPurposeGroup("imageops"), "media-images");
});

Deno.test("imageops: is stream-backed — the ONLY live-execution lane in a run (6s2c regression pin)", async () => {
  // The P0: a bundled tool NOT in STREAM_BACKED_BUNDLED_TOOL_IDS falls through
  // to the Settings-preview executor in the service worker, where no Worker
  // can exist — the run fails wasi_task_host_unavailable. This pin goes RED if
  // imageops ever leaves the stream-backed set.
  const { isStreamBackedBundledTool } = await import("../extension/lib/tool-exec-preview.js");
  assert(isStreamBackedBundledTool("imageops"), "imageops must be stream-backed to execute live");
  assert(!isStreamBackedBundledTool("csvtool"), "csvtool stays preview-only (the known gap class)");
});
