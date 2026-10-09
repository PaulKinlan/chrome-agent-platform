// @ts-nocheck
// tests/tool-platform-abuse-gates.test.ts — Adversarial abuse, quota, and lifecycle gates.
// CAP-FB-20260822-TOOL-PLATFORM-ABUSE-GATES-01 (Pillar 2 / 78s alignment).

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createStreamQuotaTracker,
  gcOrphanStreams,
  runManagedStreamJob,
  promoteWasmStreamToArtifact,
} from "../extension/lib/tool-stream-platform.js";
import {
  createWasmStreamInput,
  createWasmStreamOutput,
  appendWasmStreamInput,
  sealWasmStreamInput,
  sealWasmStreamOutput,
  validateSealedWasmStream,
  validateWasmStreamRef,
  discardWasmStream,
} from "../extension/lib/wasm-stream-files.js";
import {
  sanitizeFormulaCell,
  parseTableBytes,
} from "../extension/lib/table-core.js";

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
  const storage = {
    async getDirectory() { return new FakeDirHandle(root); }
  };
  Object.defineProperty(globalThis.navigator, "storage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  return storage;
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

Deno.test("abuse gate 8: unsealed or discarded stream promotion is rejected", async () => {
  const storage = makeStorage();
  const owner = "agent:run-alpha:origin-a";

  // 1. Unsealed stream promotion attempt -> fails closed with wasm_stream_authority
  const unsealedStream = await createWasmStreamOutput({ owner, storage });
  await assertRejects(
    async () => promoteWasmStreamToArtifact(unsealedStream, { owner, storage, force: true }),
    Error,
    "wasm_stream_authority",
  );

  // 2. Discarded stream promotion attempt -> fails closed (stream directory missing)
  const discardedStream = await createWasmStreamOutput({ owner, storage });
  await discardWasmStream({ ref: discardedStream, owner, storage });
  await assertRejects(
    async () => promoteWasmStreamToArtifact(discardedStream, { owner, storage, force: true }),
    Error,
  );
});

Deno.test("abuse gate 9: cross-owner stream promotion hijacking fails closed", async () => {
  const storage = makeStorage();
  const ownerVictim = "agent:run-alpha:victim";
  const ownerAttacker = "agent:run-beta:attacker";

  const stream = await createWasmStreamOutput({ owner: ownerVictim, storage });
  const dir = await storage.getDirectory();
  const streams = await dir.getDirectoryHandle("wasm-tool-streams-v1");
  const streamDir = await streams.getDirectoryHandle(stream.id);
  const stdoutFile = await streamDir.getFileHandle("stdout.bin");
  const writer = await stdoutFile.createWritable();
  await writer.write("Victim confidential output");
  await writer.close();

  await sealWasmStreamOutput({
    ref: stream,
    owner: ownerVictim,
    bytes: 26,
    receipt: { toolId: "grep", exitCode: 0 },
    storage,
  });

  // Unauthorized attacker attempts to promote victim's sealed stream -> REJECTED with wasm_stream_authority
  await assertRejects(
    async () => promoteWasmStreamToArtifact(stream, { owner: ownerAttacker, storage, force: true }),
    Error,
    "wasm_stream_authority",
  );

  // Legitimate owner promotion succeeds
  const res = await promoteWasmStreamToArtifact(stream, { owner: ownerVictim, storage, force: true });
  assertEquals(res.ok, true);
  assertEquals(res.promoted, true);
});

Deno.test("abuse gate 10: adversarial tabular formula injection with Unicode separators and chunk overflows fail closed", () => {
  // 1. Formula injection neutralization with Unicode line separators, whitespace, and tabs
  const hostileFormulas = [
    "\u2028=1+1",
    "\u2029-SUM(A1:B10)",
    "\t=CMD()",
    "\r\n+42",
    "   @MACRO",
    " \t |malicious_pipe",
    "\uFEFF=100+200",
  ];

  for (const hostile of hostileFormulas) {
    const sanitized = sanitizeFormulaCell(hostile);
    assert(sanitized.startsWith("'"), `formula injection "${hostile}" must be neutralized with leading apostrophe`);
  }

  // Benign values must remain untouched
  assertEquals(sanitizeFormulaCell("Hello world"), "Hello world");
  assertEquals(sanitizeFormulaCell("2026-09-05"), "2026-09-05");
  assertEquals(sanitizeFormulaCell(12345), 12345);

  // 2. Tabular row overflow attack: rows wider than declared width fail closed
  const wideCsv = "c1,c2\nv1,v2,v3_unexpected\n";
  let wideThrew = false;
  try {
    parseTableBytes(new TextEncoder().encode(wideCsv), { format: "csv" });
  } catch (err) {
    if (err.code === "table_row_width") wideThrew = true;
  }
  assertEquals(wideThrew, true, "row wider than header must fail closed with table_row_width");

  // 3. Tabular cell byte overflow attack: cell exceeding maxCellBytes fails closed
  const oversizedCell = "a".repeat(17 * 1024); // 17 KiB > 16 KiB limit
  const oversizedCsv = `c1\n"${oversizedCell}"\n`;
  let cellThrew = false;
  try {
    parseTableBytes(new TextEncoder().encode(oversizedCsv), { format: "csv" });
  } catch (err) {
    if (err.code === "table_cell_bound") cellThrew = true;
  }
  assertEquals(cellThrew, true, "cell exceeding maxCellBytes must fail closed with table_cell_bound");
});
