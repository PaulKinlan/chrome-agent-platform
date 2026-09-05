// @ts-nocheck
import { runExternalSort, EXTERNAL_SORT_PROFILE } from "../extension/lib/wasm-external-sort.js";
import { buildPreviewAuthority, buildPreviewJob, validatePreviewInput } from "../extension/lib/tool-exec-preview.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";

function assert(condition, message = "assertion failed") { if (!condition) throw new Error(message); }
function equal(actual, expected, message = "values differ") {
  if (actual !== expected) throw new Error(`${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

class MemorySyncAccess {
  constructor(node) {
    if (node.open) throw new Error("exclusive access already open");
    node.open = true;
    this.node = node;
    this.closed = false;
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
      const next = new Uint8Array(end);
      next.set(this.node.bytes);
      this.node.bytes = next;
    }
    this.node.bytes.set(bytes, at);
    return bytes.byteLength;
  }
  truncate(size) {
    const next = new Uint8Array(size);
    next.set(this.node.bytes.subarray(0, size));
    this.node.bytes = next;
  }
  getSize() { return this.node.bytes.byteLength; }
  flush() {}
  close() { if (!this.closed) { this.closed = true; this.node.open = false; } }
}
class MemoryFileHandle {
  constructor(bytes = new Uint8Array()) { this.node = { bytes, open: false }; }
  async createSyncAccessHandle() { return new MemorySyncAccess(this.node); }
}
class MemoryScratchDirectory {
  constructor() { this.files = new Map(); }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.files.has(name)) {
      if (!create) throw new Error("not found");
      this.files.set(name, new MemoryFileHandle());
    }
    return this.files.get(name);
  }
  async removeEntry(name) {
    const file = this.files.get(name);
    if (!file) throw new Error("not found");
    if (file.node.open) throw new Error("still open");
    this.files.delete(name);
  }
}

async function jobFor(args) {
  const input = validatePreviewInput({ toolId: "sort", args, stdin: "" });
  const authority = buildPreviewAuthority({ origin: "https://settings.cap", documentId: "external-sort-kat", now: () => 1 });
  return buildPreviewJob({ input, authority, quota: {
    hostCalls: Number.POSITIVE_INFINITY,
    pathCalls: 4096,
    stdinBytes: Number.POSITIVE_INFINITY,
    stdoutBytes: Number.POSITIVE_INFINITY,
    stderrBytes: Number.POSITIVE_INFINITY,
    fileBytes: Number.POSITIVE_INFINITY,
    fileSize: Number.POSITIVE_INFINITY,
    dynamicFds: 256,
  } });
}

async function run(inputBytes, args = [], instantiateWasi = async (bytes, runtime) => {
  const result = await WebAssembly.instantiate(bytes, runtime.imports);
  return result.instance ?? result;
}) {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === "sort");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);
  const inputFile = new MemoryFileHandle(inputBytes);
  const inputAccess = await inputFile.createSyncAccessHandle();
  const scratchDirectory = new MemoryScratchDirectory();
  let inputOffset = 0;
  const output = [], errors = [];
  const stdin = {
    read(length) {
      const target = new Uint8Array(length);
      const count = inputAccess.read(target, { at: inputOffset });
      inputOffset += count;
      return target.subarray(0, count);
    },
  };
  try {
    const code = await runExternalSort({
      wasmBytes,
      args,
      job: await jobFor(args),
      inputAccess,
      stdin,
      stdout: { write(bytes) { output.push(bytes.slice()); return bytes.byteLength; } },
      stderr: { write(bytes) { errors.push(bytes.slice()); return bytes.byteLength; } },
      scratchDirectory,
      instantiateWasi,
    });
    return { code, output: concat(output), stderr: new TextDecoder().decode(concat(errors)), scratchDirectory };
  } catch (error) {
    error.stderr = new TextDecoder().decode(concat(errors));
    error.scratchDirectory = scratchDirectory;
    throw error;
  } finally {
    inputAccess.close();
  }
}
function concat(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

Deno.test("external sort creates multiple runs and merges reverse unique output exactly", async () => {
  const values = [];
  for (let index = 39_999; index >= 0; index--) values.push(String(index % 20_000).padStart(5, "0"));
  const input = new TextEncoder().encode(`${values.join("\n")}\n`);
  const result = await run(input, ["-ru"]);
  equal(result.code, 0);
  const expected = [...new Set(values)].sort().reverse().join("\n") + "\n";
  equal(new TextDecoder().decode(result.output), expected);
  equal(result.scratchDirectory.files.size, 0, "scratch runs removed after success");
});

Deno.test("external numeric merge uses the same decimal-prefix ordering as its Wasm runs", async () => {
  const values = Array.from({ length: EXTERNAL_SORT_PROFILE.runLines }, () => "10");
  values.push("2.1", "2.00", "2", "-3", "0002");
  const result = await run(new TextEncoder().encode(values.join("\n") + "\n"), ["-n"]);
  const lines = new TextDecoder().decode(result.output).trimEnd().split("\n");
  equal(lines.slice(0, 5).join("|"), "-3|0002|2|2.00|2.1");
  equal(lines.length, values.length);
  assert(lines.slice(5).every((line) => line === "10"), "all 10 records follow the 2.x records");
  equal(result.scratchDirectory.files.size, 0);
});

Deno.test("external sort keeps a record larger than a run file-backed and complete", async () => {
  const huge = "z".repeat(EXTERNAL_SORT_PROFILE.runBytes + 123);
  const input = new TextEncoder().encode(`${huge}\na\n`);
  const result = await run(input);
  equal(result.output.byteLength, input.byteLength);
  const decoder = new TextDecoder();
  equal(decoder.decode(result.output.subarray(0, 2)), "a\n");
  equal(result.output[result.output.byteLength - 1], 10);
  assert(result.output.subarray(2, -1).every((byte) => byte === 122), "oversized z record remains exact");
  equal(result.scratchDirectory.files.size, 0);
});

Deno.test("external sort rejects malformed text and cleans every partial run", async () => {
  const prefix = "a\n".repeat(EXTERNAL_SORT_PROFILE.runLines);
  const input = new Uint8Array(new TextEncoder().encode(prefix).byteLength + 2);
  input.set(new TextEncoder().encode(prefix));
  input.set([0, 10], input.byteLength - 2);
  let thrown = null;
  try { await run(input); } catch (error) { thrown = error; }
  assert(thrown?.message.includes("sort_nul_input"), String(thrown));
  assert(thrown.stderr.includes("sort_nul_input"));
  equal(thrown.scratchDirectory.files.size, 0, "partial run removed after failure");
});

Deno.test("external sort cleans a created run when Wasm instantiation fails", async () => {
  let thrown = null;
  try {
    await run(new TextEncoder().encode("b\na\n"), [], async () => { throw new Error("injected instantiate failure"); });
  } catch (error) { thrown = error; }
  assert(thrown?.message.includes("injected instantiate failure"));
  equal(thrown.scratchDirectory.files.size, 0);
});
