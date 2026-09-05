// @ts-nocheck
// tests/tool-platform-abuse-gates.test.ts — Adversarial abuse, quota, and lifecycle gates.
// CAP-FB-20260822-TOOL-PLATFORM-ABUSE-GATES-01 (Pillar 2 / 78s alignment).

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createStreamQuotaTracker,
  gcOrphanStreams,
  runManagedStreamJob,
} from "../extension/lib/tool-stream-platform.js";
import {
  createWasmStreamInput,
  appendWasmStreamInput,
  sealWasmStreamInput,
  validateSealedWasmStream,
  validateWasmStreamRef,
  discardWasmStream,
} from "../extension/lib/wasm-stream-files.js";

// In-memory OPFS fake
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content = "") { return { kind: "file", content }; }

class FakeWritable {
  constructor(node, { keepExistingData = false } = {}) {
    this.node = node;
    this.pos = 0;
    if (!keepExistingData) {
      this.node.content = "";
    }
  }
  async seek(pos) { this.pos = pos; }
  async write(chunk) {
    const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const prev = this.node.content ?? "";
    const prefix = prev.slice(0, this.pos);
    const suffix = prev.slice(this.pos + str.length);
    this.node.content = prefix + str + suffix;
    this.pos += str.length;
  }
  async close() {}
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
    return new FakeWritable(this.node, { keepExistingData });
  }
}

class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts?.create) throw new Error(`directory ${name} not found`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts?.create) throw new Error(`file ${name} not found`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}

function makeStorage() {
  const root = dirNode();
  return {
    async getDirectory() { return new FakeDirHandle(root); }
  };
}

Deno.test("abuse gate 1: infinite loop / hang watchdog terminates worker and cleans up output", async () => {
  let workerTerminated = false;
  let partialOutputCleaned = false;

  const hangingJob = () => new Promise(() => {
    // Hangs forever (simulating while(1) or catastrophic regex)
  });

  const onTimeout = async () => {
    workerTerminated = true;
    partialOutputCleaned = true;
  };

  const res = await runManagedStreamJob(hangingJob, {
    timeoutMs: 150, // fast timeout for test
    onTimeout,
  });

  assertEquals(res.ok, false);
  assertEquals(res.phase, "timeout");
  assertEquals(res.error, "wall deadline exceeded; worker terminated");
  assertEquals(workerTerminated, true, "watchdog must terminate worker on timeout");
  assertEquals(partialOutputCleaned, true, "watchdog must trigger partial stream cleanup");
});

Deno.test("abuse gate 2: stream ID traversal and prototype attacks fail closed", () => {
  const hostileIds = [
    "../evil",
    "../../etc/passwd",
    "0123456789abcdef0123456789abcdef/../traversal",
    "__proto__",
    "constructor",
    "0123456789ABCDEF0123456789ABCDEF", // uppercase rejected
    "0123456789abcdef0123456789abcde",  // 31 chars
    "0123456789abcdef0123456789abcdef0", // 33 chars
    "0123456789abcdef0123456789abcdef\0", // null byte
  ];

  for (const id of hostileIds) {
    let threw = false;
    try {
      validateWasmStreamRef({ version: 1, id, kind: "input" });
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `hostile id "${id}" must fail validation`);
  }
});

Deno.test("abuse gate 3: cross-owner stream access is rejected (owner authority fence)", async () => {
  const storage = makeStorage();
  const ownerA = "agent:run-alpha:origin-a";
  const ownerB = "agent:run-beta:origin-b";

  const streamA = await createWasmStreamInput({ owner: ownerA, storage });

  // Owner A appends successfully
  await appendWasmStreamInput({
    ref: streamA,
    owner: ownerA,
    bytes: new TextEncoder().encode("Owner A confidential data"),
    storage,
  });

  // Owner B attempts to append to Owner A's stream -> REJECTED
  await assertRejects(
    async () => appendWasmStreamInput({
      ref: streamA,
      owner: ownerB,
      bytes: new TextEncoder().encode("Hostile injection"),
      storage,
    }),
    Error,
    "wasm_stream_authority",
  );

  // Owner B attempts to seal Owner A's stream -> REJECTED
  await assertRejects(
    async () => sealWasmStreamInput({ ref: streamA, owner: ownerB, storage }),
    Error,
    "wasm_stream_authority",
  );

  // Owner B attempts to discard Owner A's stream -> REJECTED
  await assertRejects(
    async () => discardWasmStream({ ref: streamA, owner: ownerB, storage }),
    Error,
    "wasm_stream_authority",
  );

  // Owner A seals properly
  const sealed = await sealWasmStreamInput({ ref: streamA, owner: ownerA, storage });
  assertEquals(sealed.ok, true);

  // Owner B attempts to validate/read Owner A's sealed stream -> REJECTED
  await assertRejects(
    async () => validateSealedWasmStream({ ref: streamA, owner: ownerB, storage }),
    Error,
    "wasm_stream_authority",
  );
});

Deno.test("abuse gate 4: stream quota tracker blocks excessive concurrent allocations", () => {
  const tracker = createStreamQuotaTracker({ maxActive: 3 });
  const owner = "test-agent-quota";

  assertEquals(tracker.claim(owner), 1);
  assertEquals(tracker.claim(owner), 2);
  assertEquals(tracker.claim(owner), 3);

  // 4th allocation exceeds quota -> REJECTED
  let threw = false;
  try {
    tracker.claim(owner);
  } catch (err) {
    if (err.code === "stream_quota_exceeded") threw = true;
  }
  assertEquals(threw, true, "allocation beyond maxActive must throw stream_quota_exceeded");

  // Releasing a slot allows new allocation
  tracker.release(owner);
  assertEquals(tracker.count(owner), 2);
  assertEquals(tracker.claim(owner), 3);
});

Deno.test("abuse gate 5: orphan stream garbage collection cleans abandoned unsealed streams", async () => {
  const storage = makeStorage();
  const owner = "test-agent-gc";
  const oldStream = await createWasmStreamInput({ owner, storage });

  // Tamper timestamp to simulate an abandoned stream from 2 hours ago
  const dir = await storage.getDirectory();
  const streams = await dir.getDirectoryHandle("wasm-tool-streams-v1");
  const oldStreamDir = await streams.getDirectoryHandle(oldStream.id);
  const handle = await oldStreamDir.getFileHandle("authority.json");
  const meta = JSON.parse(await (await handle.getFile()).text());
  meta.createdAt = Date.now() - (2 * 3600_000); // 2 hours old
  const writer = await handle.createWritable();
  await writer.write(JSON.stringify(meta));
  await writer.close();

  // Create a fresh stream (not orphan)
  const freshStream = await createWasmStreamInput({ owner, storage });
  await sealWasmStreamInput({ ref: freshStream, owner, storage });

  // Run GC with 1-hour threshold
  const gcRes = await gcOrphanStreams({ maxAgeMs: 3600_000, storage });
  assertEquals(gcRes.collected, 1, "must collect exactly the 1 old unsealed stream");

  // Fresh sealed stream remains intact
  const validatedFresh = await validateSealedWasmStream({ ref: freshStream, owner, storage });
  assertEquals(validatedFresh.ref.id, freshStream.id);
});

Deno.test("abuse gate 6: size drift between file and metadata fails closed", async () => {
  const storage = makeStorage();
  const owner = "test-agent-drift";
  const stream = await createWasmStreamInput({ owner, storage });
  await appendWasmStreamInput({
    ref: stream,
    owner,
    bytes: new TextEncoder().encode("Genuine bytes"),
    storage,
  });
  await sealWasmStreamInput({ ref: stream, owner, storage });

  // Tamper file content directly to simulate truncation or corruption
  const dir = await storage.getDirectory();
  const streams = await dir.getDirectoryHandle("wasm-tool-streams-v1");
  const streamDir = await streams.getDirectoryHandle(stream.id);
  const dataFile = await streamDir.getFileHandle("stdin.bin");
  const writer = await dataFile.createWritable();
  await writer.write("Corrupted shorter text");
  await writer.close();

  // Validation detects size drift -> FAILS CLOSED
  await assertRejects(
    async () => validateSealedWasmStream({ ref: stream, owner, storage }),
    Error,
    "wasm_stream_size_drift",
  );
});

Deno.test("abuse gate 7: concurrent appends serialize cleanly via appendLock", async () => {
  const storage = makeStorage();
  const owner = "test-agent-concurrency";
  const stream = await createWasmStreamInput({ owner, storage });

  // Launch 10 concurrent appends
  const chunks = Array.from({ length: 10 }, (_, i) => new TextEncoder().encode(`chunk-${i};`));
  await Promise.all(chunks.map((bytes) => appendWasmStreamInput({ ref: stream, owner, bytes, storage })));

  const sealed = await sealWasmStreamInput({ ref: stream, owner, storage });
  assertEquals(sealed.ok, true);
  assertEquals(sealed.bytes, chunks.reduce((sum, c) => sum + c.length, 0));
});
