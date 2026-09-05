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
  assertEquals(res.stdout, sampleOutput);
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
