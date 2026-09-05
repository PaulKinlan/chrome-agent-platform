// @ts-nocheck
import { createIncrementalSha256 } from "../extension/lib/incremental-sha256.js";
import { decodeCanonicalBase64, encodeCanonicalBase64 } from "../extension/lib/wasm-base64.js";
import {
  appendWasmStreamInput,
  createWasmStreamInput,
  createWasmStreamOutput,
  readWasmStreamReceipt,
  readWasmStreamWindow,
  removeWasmStream,
  sealWasmStreamInput,
  sealWasmStreamOutput,
  validateSealedWasmStream,
  WASM_STREAM_ROOT_NAME,
} from "../extension/lib/wasm-stream-files.js";
import { createWasiPreview1Runtime } from "../extension/lib/wasi-preview1-runtime.js";
import { buildPreviewAuthority, buildPreviewJob, validatePreviewInput } from "../extension/lib/tool-exec-preview.js";
import { createSyncWorkspace } from "../extension/lib/wasm-sync-workspace.js";
import { WasiProcExit } from "../extension/lib/wasm-host-types.js";
import { executeWasmStreamJob } from "../extension/lib/wasm-stream-worker.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";

function assert(condition, message = "assertion failed") { if (!condition) throw new Error(message); }
function equal(actual, expected, message = "values differ") {
  if (actual !== expected) throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

const fileNode = () => ({ kind: "file", bytes: new Uint8Array(), syncOpen: false });
const directoryNode = () => ({ kind: "directory", children: new Map() });

class MemoryWritable {
  constructor(node, keep) { this.node = node; this.bytes = keep ? node.bytes.slice() : new Uint8Array(); this.position = 0; }
  async seek(position) { this.position = position; }
  async write(value) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    const length = Math.max(this.bytes.byteLength, this.position + bytes.byteLength);
    const next = new Uint8Array(length);
    next.set(this.bytes); next.set(bytes, this.position);
    this.bytes = next; this.position += bytes.byteLength;
  }
  async close() { this.node.bytes = this.bytes; }
  async abort() {}
}
class MemorySyncAccess {
  constructor(node) {
    if (node.syncOpen) throw new Error("sync handle already open");
    node.syncOpen = true; this.node = node; this.closed = false;
  }
  read(target, { at = 0 } = {}) {
    if (this.closed) throw new Error("closed");
    const count = Math.max(0, Math.min(target.byteLength, this.node.bytes.byteLength - at));
    target.set(this.node.bytes.subarray(at, at + count));
    return count;
  }
  write(bytes, { at = 0 } = {}) {
    if (this.closed) throw new Error("closed");
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
  close() { if (!this.closed) { this.closed = true; this.node.syncOpen = false; } }
}
class MemoryFile {
  constructor(node) { this.node = node; this.kind = "file"; }
  async getFile() { return new Blob([this.node.bytes]); }
  async createWritable({ keepExistingData = false } = {}) { return new MemoryWritable(this.node, keepExistingData); }
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
  return { root, storage: { async getDirectory() { return root; } } };
}

Deno.test("incremental SHA-256 is byte-exact across arbitrary chunk boundaries", async () => {
  const bytes = new TextEncoder().encode("abc".repeat(100_003));
  const expected = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const hash = createIncrementalSha256();
  for (let offset = 0, size = 1; offset < bytes.length; size = size % 8191 + 1) {
    hash.update(bytes.subarray(offset, offset += Math.min(size, bytes.length - offset)));
  }
  equal(hash.hex(), expected);
  equal(hash.bytesHashed, bytes.byteLength);
});

Deno.test("canonical base64 validates a 4 MiB transport chunk without a regexp-size ceiling", () => {
  const input = new Uint8Array(4 * 1024 * 1024);
  for (let index = 0; index < input.length; index++) input[index] = index & 0xff;
  const encoded = encodeCanonicalBase64(input);
  const decoded = decodeCanonicalBase64(encoded);
  equal(decoded.byteLength, input.byteLength);
  equal(decoded[0], 0);
  equal(decoded[decoded.length - 1], 255);
  for (const hostile of [encoded.slice(0, -1), `${encoded.slice(0, -3)}x==`, `${encoded.slice(0, -4)}====`]) {
    let rejected = false;
    try { decodeCanonicalBase64(hostile); } catch { rejected = true; }
    assert(rejected, "noncanonical large transport input must fail closed");
  }
});

Deno.test("OPFS stream references are sealed, owner-bound, ranged, chainable, and removable", async () => {
  const { root, storage } = memoryStorage();
  const owner = "owner-options:document-a";
  const input = await createWasmStreamInput({ owner, storage });
  await appendWasmStreamInput({ ref: input, owner, bytes: new TextEncoder().encode("hello "), storage });
  await appendWasmStreamInput({ ref: input, owner, bytes: new TextEncoder().encode("world"), storage });
  let unsealedRejected = false;
  try { await validateSealedWasmStream({ ref: input, owner, storage }); } catch { unsealedRejected = true; }
  assert(unsealedRejected, "unsealed input must not execute");
  await sealWasmStreamInput({ ref: input, owner, storage });
  let foreignRejected = false;
  try { await readWasmStreamWindow({ ref: input, owner: "foreign", offset: 0, length: 5, storage }); } catch { foreignRejected = true; }
  assert(foreignRejected, "foreign owner must not read");
  const window = await readWasmStreamWindow({ ref: input, owner, offset: 6, length: 5, storage });
  equal(atob(window.base64), "world");
  assert(window.eof);

  const output = await createWasmStreamOutput({ owner, storage });
  const streams = await root.getDirectoryHandle(WASM_STREAM_ROOT_NAME);
  const outputDir = await streams.getDirectoryHandle(output.id);
  const stdout = await outputDir.getFileHandle("stdout.bin");
  const writer = await stdout.createWritable();
  await writer.write("result\n"); await writer.close();
  const receipt = { stdoutBytes: 7, stdoutSha256: "0".repeat(64) };
  await sealWasmStreamOutput({ ref: output, owner, bytes: 7, receipt, storage });
  equal((await validateSealedWasmStream({ ref: output, owner, storage })).bytes, 7);
  equal((await readWasmStreamReceipt({ ref: output, owner, storage })).receipt.stdoutBytes, 7);
  await removeWasmStream({ ref: output, owner, storage });
  let removed = false;
  try { await validateSealedWasmStream({ ref: output, owner, storage }); } catch { removed = true; }
  assert(removed, "removed output must disappear");
});

Deno.test("WASI stdio adapters stream complete input/output without runtime accumulation", async () => {
  const wasm = await Deno.readFile(new URL("../packages/bundled/unix-stream-v1/binaries/wc.wasm", import.meta.url));
  const authority = buildPreviewAuthority({ origin: "https://settings.cap", documentId: "test-doc", now: () => 1 });
  const input = validatePreviewInput({ toolId: "wc", args: [], stdin: "" });
  const base = buildPreviewJob({ input, authority, quota: {
    hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
    stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
    stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
    fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
  } });
  const source = new TextEncoder().encode("one two\nthree\n");
  let sourceOffset = 0, output = new Uint8Array(), instance = null;
  const runtime = createWasiPreview1Runtime({
    job: { ...base, stdin: new Uint8Array() },
    memory: {
      size: () => instance?.exports?.memory?.buffer?.byteLength ?? 0,
      read(pointer, length) { return new Uint8Array(instance.exports.memory.buffer, pointer, length); },
      write(pointer, bytes) { new Uint8Array(instance.exports.memory.buffer, pointer, bytes.byteLength).set(bytes); },
    },
    workspace: createSyncWorkspace({ root: base.context.workspaceRoot, seed: base.workspaceSeed }),
    stdio: {
      readStdin(_offset, length) { const chunk = source.slice(sourceOffset, sourceOffset + Math.min(length, 3)); sourceOffset += chunk.length; return chunk; },
      writeStdout(_offset, bytes) { const next = new Uint8Array(output.length + bytes.length); next.set(output); next.set(bytes, output.length); output = next; return bytes.length; },
      writeStderr(_offset, bytes) { return bytes.length; },
    },
  });
  const instantiated = await WebAssembly.instantiate(wasm, runtime.imports);
  instance = instantiated.instance;
  let exit = 0;
  try { instance.exports._start(); } catch (error) { if (error instanceof WasiProcExit) exit = error.code; else throw error; }
  equal(exit, 0);
  equal(new TextDecoder().decode(output), "2 3 14\n");
  equal(runtime.snapshot().stdout.byteLength, 0, "streaming runtime must not retain stdout chunks");
  equal(runtime.snapshot().counters.stdinBytesRead, source.byteLength);
});

Deno.test("service worker exposes one owner-derived stream lifecycle instead of shadowing routes", async () => {
  const source = await Deno.readTextFile("extension/background/service-worker.js");
  for (const route of [
    "tool-stream.input.create",
    "tool-stream.input.append",
    "tool-stream.input.seal",
    "tool-stream.run",
    "tool-stream.output.read",
    "tool-stream.output.receipt",
    "tool-stream.remove",
  ]) {
    equal(source.split(`async \"${route}\"`).length - 1, 1, `${route} must have exactly one route definition`);
  }
  const lifecycle = source.slice(
    source.indexOf('async "tool-stream.input.create"'),
    source.indexOf('// ── The "what I did" action ledger'),
  );
  assert(lifecycle.includes("wasmStreamOwner(context)"), "lifecycle routes must derive owner authority from the sender context");
  assert(lifecycle.includes("appendWasmStreamInputBase64"), "Chrome transport must use canonical base64 bytes");
  assert(!lifecycle.includes('owner = "hub"'), "lifecycle authority must not be caller-selected");
});

Deno.test("stream worker core executes exact shipped CAS bytes through sync OPFS handles", async () => {
  const { storage } = memoryStorage();
  const owner = "agent:run-1:hub";
  const inputRef = await createWasmStreamInput({ owner, storage });
  const inputBytes = new TextEncoder().encode("one two\nthree\n");
  await appendWasmStreamInput({ ref: inputRef, owner, bytes: inputBytes, storage });
  await sealWasmStreamInput({ ref: inputRef, owner, storage });
  const outputRef = await createWasmStreamOutput({ owner, storage });
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === "wc");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);
  const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "run-1", now: () => 1 });
  const validated = validatePreviewInput({ toolId: "wc", args: [], stdin: "" });
  const job = buildPreviewJob({ input: validated, authority, quota: {
    hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
    stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
    stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
    fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
  } });
  const result = await executeWasmStreamJob({
    wasmBytes, job, owner, inputRef, outputRef, toolId: "wc",
  }, { storage });
  assert(result.ok, result.error);
  equal(result.exitCode, 0);
  equal(result.outputRef.id, outputRef.id);
  equal(result.receipt.stdinBytes, inputBytes.byteLength);
  equal(result.receipt.stdoutBytes, 7);
  const expectedInputSha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", inputBytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  equal(result.receipt.stdinSha256, expectedInputSha);
  await sealWasmStreamOutput({ ref: outputRef, owner, bytes: result.receipt.stdoutBytes, receipt: result.receipt, storage });
  const window = await readWasmStreamWindow({ ref: outputRef, owner, offset: 0, length: 7, storage });
  equal(atob(window.base64), "2 3 14\n");
  let rejected = false;
  try {
    await executeWasmStreamJob({ wasmBytes, job, owner: "agent:other:hub", inputRef, outputRef, toolId: "wc" }, { storage });
  } catch (error) { rejected = error?.code === "wasm_stream_authority"; }
  assert(rejected, "worker core rejects a foreign owner before execution");
});
