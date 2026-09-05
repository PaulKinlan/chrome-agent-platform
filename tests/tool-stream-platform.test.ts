// @ts-nocheck
// tests/tool-stream-platform.test.ts — Platform streaming I/O and artifact promotion tests.
// CAP-FB-20260822-WASM-TOOL-PLATFORM-01 (Pillar 1).

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  validateStreamChaining,
  stageAttachmentAsWasmStream,
  stageAssetAsWasmStream,
  readWasmStreamPreview,
  promoteWasmStreamToArtifact,
  STREAM_PLATFORM_LIMITS,
} from "../extension/lib/tool-stream-platform.js";
import {
  createWasmStreamInput,
  createWasmStreamOutput,
  appendWasmStreamInput,
  sealWasmStreamInput,
  sealWasmStreamOutput,
  validateSealedWasmStream,
} from "../extension/lib/wasm-stream-files.js";
import { runPipeline } from "../extension/lib/tool-pipeline.js";

// In-memory OPFS directory stub
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content = "") { return { kind: "file", content, parts: [] }; }
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; this.pos = 0; }
  async seek(pos) { this.pos = pos; }
  async write(chunk) {
    const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    this.parts.push(str);
  }
  async close() {
    this.node.content = this.parts.join("");
  }
}
class FakeFileHandle {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() {
    const text = this.node.content ?? "";
    return {
      size: text.length,
      text: async () => text,
      slice: (start, end) => ({
        arrayBuffer: async () => new TextEncoder().encode(text.slice(start, end)).buffer,
      }),
    };
  }
  async createWritable({ keepExistingData = false } = {}) {
    return new FakeWritable(this.node);
  }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`directory ${name} not found`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (opts?.create !== true) throw new Error(`file ${name} not found`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name, opts = {}) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}

const root = dirNode();
const fakeStorage = {
  async getDirectory() { return new FakeDirHandle(root); }
};

Object.defineProperty(globalThis, "navigator", {
  value: { storage: fakeStorage },
  configurable: true,
  writable: true,
});

const TEST_OWNER = "test-session-owner";

Deno.test("stream chaining: validates input and stdout capability references", () => {
  const inputRef = { version: 1, id: "0123456789abcdef0123456789abcdef", kind: "input" };
  const stdoutRef = { version: 1, id: "abcdef0123456789abcdef0123456789", kind: "stdout" };

  const chainInput = validateStreamChaining(inputRef);
  assertEquals(chainInput.valid, true);
  assertEquals(chainInput.chainable, true);

  const chainStdout = validateStreamChaining(stdoutRef);
  assertEquals(chainStdout.valid, true);
  assertEquals(chainStdout.chainable, true);

  // Invalid ref fails
  assertRejects(async () => validateStreamChaining({ version: 2, id: "bad", kind: "other" }));
});

Deno.test("stageAttachmentAsWasmStream: stages text attachment into sealed input", async () => {
  const attachment = {
    name: "data.csv",
    type: "text/csv",
    content: "id,val\n1,alpha\n2,beta\n",
  };

  const res = await stageAttachmentAsWasmStream(attachment, { owner: TEST_OWNER, storage: fakeStorage });
  assertEquals(res.ok, true);
  assertEquals(res.name, "data.csv");
  assertEquals(res.bytes, 22);
  assertEquals(res.inputRef.kind, "input");

  // Validate the sealed stream
  const validated = await validateSealedWasmStream({ ref: res.inputRef, owner: TEST_OWNER, storage: fakeStorage });
  assertEquals(validated.bytes, 22);
});

Deno.test("stageAttachmentAsWasmStream: stages base64 dataURL attachment", async () => {
  const text = "Hello binary stream";
  const base64 = btoa(text);
  const attachment = {
    name: "image.png",
    type: "image/png",
    dataURL: `data:image/png;base64,${base64}`,
  };

  const res = await stageAttachmentAsWasmStream(attachment, { owner: TEST_OWNER, storage: fakeStorage });
  assertEquals(res.ok, true);
  assertEquals(res.name, "image.png");
  assertEquals(res.bytes, text.length);

  const preview = await readWasmStreamPreview(res.inputRef, { owner: TEST_OWNER, storage: fakeStorage });
  assertEquals(preview.preview, text);
  assertEquals(preview.complete, true);
});

Deno.test("stageAttachmentAsWasmStream: refuses local-folder grants for security isolation", async () => {
  const attachment = {
    name: "my-dir",
    kind: "local-folder",
    grantId: "g_123",
  };

  await assertRejects(
    async () => stageAttachmentAsWasmStream(attachment, { owner: TEST_OWNER, storage: fakeStorage }),
    Error,
    "local folder grants are host-only",
  );
});

Deno.test("stageAssetAsWasmStream: stages existing artifact content into stream input", async () => {
  const asset = {
    id: "a_test_01",
    name: "report.json",
    type: "text",
    content: JSON.stringify({ status: "ok", count: 42 }),
  };

  const res = await stageAssetAsWasmStream(asset, { owner: TEST_OWNER, storage: fakeStorage });
  assertEquals(res.ok, true);
  assertEquals(res.name, "report.json");
  assertEquals(res.bytes > 0, true);

  const preview = await readWasmStreamPreview(res.inputRef, { owner: TEST_OWNER, storage: fakeStorage });
  assertEquals(preview.preview, asset.content);
});

Deno.test("promoteWasmStreamToArtifact: under-threshold outputs return preview without forced promotion", async () => {
  const outRef = await createWasmStreamOutput({ owner: TEST_OWNER, storage: fakeStorage });
  const dir = await fakeStorage.getDirectory();
  const streams = await dir.getDirectoryHandle("wasm-tool-streams-v1");
  const streamDir = await streams.getDirectoryHandle(outRef.id);
  const stdoutFile = await streamDir.getFileHandle("stdout.bin");
  const writer = await stdoutFile.createWritable();
  await writer.write("Small stdout content");
  await writer.close();

  await sealWasmStreamOutput({
    ref: outRef,
    owner: TEST_OWNER,
    bytes: 20,
    receipt: { toolId: "grep", exitCode: 0 },
    storage: fakeStorage,
  });

  const res = await promoteWasmStreamToArtifact(outRef, {
    owner: TEST_OWNER,
    storage: fakeStorage,
  });

  assertEquals(res.ok, true);
  assertEquals(res.promoted, false);
  assertEquals(res.stdout, "Small stdout content");
  assertEquals(res.stdoutComplete, true);
});

Deno.test("promoteWasmStreamToArtifact: promoted outputs write keyed artifact", async () => {
  const outRef = await createWasmStreamOutput({ owner: TEST_OWNER, storage: fakeStorage });
  const dir = await fakeStorage.getDirectory();
  const streams = await dir.getDirectoryHandle("wasm-tool-streams-v1");
  const streamDir = await streams.getDirectoryHandle(outRef.id);
  const stdoutFile = await streamDir.getFileHandle("stdout.bin");
  const writer = await stdoutFile.createWritable();
  const sampleOutput = "Generated pipeline report content that needs permanent storage.";
  await writer.write(sampleOutput);
  await writer.close();

  await sealWasmStreamOutput({
    ref: outRef,
    owner: TEST_OWNER,
    bytes: sampleOutput.length,
    receipt: { toolId: "sort", exitCode: 0 },
    storage: fakeStorage,
  });

  const res = await promoteWasmStreamToArtifact(outRef, {
    owner: TEST_OWNER,
    storage: fakeStorage,
    name: "sorted-report.txt",
    force: true,
  });

  assertEquals(res.ok, true);
  assertEquals(res.promoted, true);
  assert(typeof res.artifactId === "string", "must return promoted artifactId");
  assertEquals(res.asset.meta.streamRef, outRef, "must retain sealed streamRef without duplicating OPFS content");
  assertEquals(res.asset.meta.isStreamBacked, true);
  assertEquals(res.stdout, sampleOutput);

  // Direct zero-copy chaining from stream-backed asset
  const stagedFromAsset = await stageAssetAsWasmStream(res.asset, {
    owner: TEST_OWNER,
    storage: fakeStorage,
  });
  assertEquals(stagedFromAsset.ok, true);
  assertEquals(stagedFromAsset.chained, true);
  assertEquals(stagedFromAsset.inputRef, outRef);
});

Deno.test("pipeline stream chaining: passes output.ref of step 1 directly as inputRef to step 2", async () => {
  const stdoutRef = { version: 1, id: "11112222333344445555666677778888", kind: "stdout" };
  const dispatchedCalls = [];

  const pipeline = {
    name: "stream-pipeline",
    steps: [
      { id: "s1", tool: "grep", args: { pattern: "error", stdin: "line 1\nerror here\nline 3" } },
      { id: "s2", tool: "sort", args: { inputRef: { $ref: "s1", path: "output.ref" } } },
    ],
  };

  const dispatchTool = async (tool, args) => {
    dispatchedCalls.push({ tool, args });
    if (tool === "grep") {
      return {
        ok: true,
        value: {
          exitCode: 0,
          stdout: "error here",
          output: { ref: stdoutRef, bytes: 10, sha256: "abc" },
        },
      };
    }
    if (tool === "sort") {
      return {
        ok: true,
        value: {
          exitCode: 0,
          stdout: "error here",
          output: { ref: { version: 1, id: "99998888777766665555444433332222", kind: "stdout" }, bytes: 10, sha256: "def" },
        },
      };
    }
    return { ok: false, error: "unknown tool" };
  };

  const result = await runPipeline(pipeline, { dispatchTool });
  assertEquals(result.ok, true);
  assertEquals(dispatchedCalls.length, 2);

  // Step 2 received the resolved output.ref from Step 1
  assertEquals(dispatchedCalls[1].tool, "sort");
  assertEquals(dispatchedCalls[1].args.inputRef, stdoutRef);
  assertEquals(result.final.exitCode, 0);
});

Deno.test("1bbu gate: file-backed binary-safe stream artifact promotion and zero-copy re-staging", async () => {
  const outRef = await createWasmStreamOutput({ owner: TEST_OWNER, storage: fakeStorage });
  const dir = await fakeStorage.getDirectory();
  const streams = await dir.getDirectoryHandle("wasm-tool-streams-v1");
  const streamDir = await streams.getDirectoryHandle(outRef.id);
  const stdoutFile = await streamDir.getFileHandle("stdout.bin");
  const writer = await stdoutFile.createWritable();

  // Write a large stream (128 KiB > 64 KiB threshold)
  const largeChunk = "0123456789abcdef".repeat(8 * 1024); // 128 KiB
  await writer.write(largeChunk);
  await writer.close();

  await sealWasmStreamOutput({
    ref: outRef,
    owner: TEST_OWNER,
    bytes: largeChunk.length,
    receipt: { toolId: "base64", exitCode: 0 },
    storage: fakeStorage,
  });

  // Promote output (automatic promotion because bytes > 64 KiB)
  const res = await promoteWasmStreamToArtifact(outRef, {
    owner: TEST_OWNER,
    storage: fakeStorage,
    name: "large-output.bin",
    force: false,
  });

  assertEquals(res.ok, true);
  assertEquals(res.promoted, true);
  assertEquals(res.asset.meta.fileBacked, true);
  assertEquals(res.asset.meta.isStreamBacked, true);
  assertEquals(res.asset.meta.contentIncomplete, true);
  assertEquals(res.asset.meta.streamBytes, largeChunk.length);
  assertEquals(res.asset.meta.bytes, largeChunk.length);
  // Preview must be bounded to 64 KiB
  assertEquals(res.stdout.length <= 64 * 1024, true);

  // Authority marker verification
  const metaHandle = await streamDir.getFileHandle("authority.json");
  const metaObj = JSON.parse(await (await metaHandle.getFile()).text());
  assertEquals(metaObj.promoted, true);

  // GC orphan sweep must NEVER collect promoted streams
  const { gcOrphanStreams } = await import("../extension/lib/tool-stream-platform.js");
  const gcRes = await gcOrphanStreams({ maxAgeMs: 0, storage: fakeStorage });
  assertEquals(gcRes.collected, 0);

  // Zero-copy re-staging from asset
  const staged = await stageAssetAsWasmStream(res.asset, {
    owner: TEST_OWNER,
    storage: fakeStorage,
  });
  assertEquals(staged.ok, true);
  assertEquals(staged.chained, true);
  assertEquals(staged.inputRef, outRef);
  assertEquals(staged.bytes, largeChunk.length); // Full 128 KiB, NOT truncated preview!
});

Deno.test("adversarial gate: wrong-owner and forged streamOwner fail closed", async () => {
  // 1. Create a stream owned by owner-a
  const outRef = await createWasmStreamOutput({ owner: "owner-a", storage: fakeStorage });
  const dir = await fakeStorage.getDirectory();
  const streams = await dir.getDirectoryHandle("wasm-tool-streams-v1");
  const streamDir = await streams.getDirectoryHandle(outRef.id);
  const stdoutFile = await streamDir.getFileHandle("stdout.bin");
  const writer = await stdoutFile.createWritable();
  await writer.write("Secret data belonging to owner-a");
  await writer.close();

  await sealWasmStreamOutput({
    ref: outRef,
    owner: "owner-a",
    bytes: 32,
    receipt: { toolId: "grep", exitCode: 0 },
    storage: fakeStorage,
  });

  // 2. Caller owner-b attempts to stage owner-a's stream directly -> must FAIL CLOSED
  const rawAsset = {
    id: "a_victim",
    name: "data.bin",
    meta: { streamRef: outRef },
  };
  await assertRejects(
    async () => stageAssetAsWasmStream(rawAsset, { owner: "owner-b", storage: fakeStorage }),
    Error,
    "wasm_stream_authority",
  );

  // 3. Adversary owner-b presents forged asset claiming meta.streamOwner = "owner-a" -> must FAIL CLOSED
  const forgedAsset = {
    id: "a_forged",
    name: "forged.bin",
    meta: {
      streamRef: outRef,
      streamOwner: "owner-a", // Forged claim
    },
  };
  await assertRejects(
    async () => stageAssetAsWasmStream(forgedAsset, { owner: "owner-b", storage: fakeStorage }),
    Error,
    "wasm_stream_authority",
  );
});

Deno.test("adversarial gate: remove/discard on promoted streams fail closed", async () => {
  const { removeWasmStream, discardWasmStream } = await import("../extension/lib/wasm-stream-files.js");
  const outRef = await createWasmStreamOutput({ owner: TEST_OWNER, storage: fakeStorage });
  const dir = await fakeStorage.getDirectory();
  const streams = await dir.getDirectoryHandle("wasm-tool-streams-v1");
  const streamDir = await streams.getDirectoryHandle(outRef.id);
  const stdoutFile = await streamDir.getFileHandle("stdout.bin");
  const writer = await stdoutFile.createWritable();
  await writer.write("Permanent promoted artifact stream");
  await writer.close();

  await sealWasmStreamOutput({
    ref: outRef,
    owner: TEST_OWNER,
    bytes: 34,
    receipt: { toolId: "sort", exitCode: 0 },
    storage: fakeStorage,
  });

  // Promote stream
  await promoteWasmStreamToArtifact(outRef, {
    owner: TEST_OWNER,
    storage: fakeStorage,
    force: true,
  });

  // Calling removeWasmStream on promoted stream must FAIL CLOSED
  await assertRejects(
    async () => removeWasmStream({ ref: outRef, owner: TEST_OWNER, storage: fakeStorage }),
    Error,
    "wasm_stream_promoted",
  );

  // Calling discardWasmStream on promoted stream must FAIL CLOSED
  await assertRejects(
    async () => discardWasmStream({ ref: outRef, owner: TEST_OWNER, storage: fakeStorage }),
    Error,
    "wasm_stream_promoted",
  );
});

Deno.test("adversarial gate: arbitrary binary payload stream promotion and zero-copy transfer without UTF-8 corruption", async () => {
  const { readWasmStreamWindow } = await import("../extension/lib/wasm-stream-files.js");
  const outRef = await createWasmStreamOutput({ owner: TEST_OWNER, storage: fakeStorage });
  const dir = await fakeStorage.getDirectory();
  const streams = await dir.getDirectoryHandle("wasm-tool-streams-v1");
  const streamDir = await streams.getDirectoryHandle(outRef.id);
  const stdoutFile = await streamDir.getFileHandle("stdout.bin");
  const writer = await stdoutFile.createWritable();

  // Arbitrary raw binary: NULL bytes, high bytes, invalid UTF-8 sequences
  const rawBinary = new Uint8Array([0x00, 0xFF, 0xFE, 0x00, 0x80, 0x81, 0x7F, 0x00, 0xC0, 0xAF]);
  await writer.write(rawBinary);
  await writer.close();

  await sealWasmStreamOutput({
    ref: outRef,
    owner: TEST_OWNER,
    bytes: rawBinary.byteLength,
    receipt: { toolId: "gzip", exitCode: 0 },
    storage: fakeStorage,
  });

  const res = await promoteWasmStreamToArtifact(outRef, {
    owner: TEST_OWNER,
    storage: fakeStorage,
    force: true,
  });

  assertEquals(res.ok, true);
  assertEquals(res.promoted, true);
  assertEquals(res.bytes, rawBinary.byteLength);

  // Staging as stream input preserves exact byte count and ref
  const staged = await stageAssetAsWasmStream(res.asset, {
    owner: TEST_OWNER,
    storage: fakeStorage,
  });
  assertEquals(staged.ok, true);
  assertEquals(staged.bytes, rawBinary.byteLength);

  // Read window from stream to verify byte preservation
  const win = await readWasmStreamWindow({ ref: staged.inputRef, owner: TEST_OWNER, offset: 0, length: 10, storage: fakeStorage });
  assertEquals(win.ok, true);
  assertEquals(win.size, rawBinary.byteLength);
});
