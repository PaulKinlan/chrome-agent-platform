// ltkj.4.3: isolated run-owned stream custody, without a binary tool wire or publication.
// @ts-nocheck
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import * as custody from "../extension/lib/emscripten-custody.js";
import * as audited from "../extension/lib/emscripten-custody-audit.js";
import {
  listWasmStreamEntries,
  stageWasmStreamInputChunks,
  WASM_STREAM_ROOT_NAME,
} from "../extension/lib/wasm-stream-files.js";

const RUN = "exec_ems_custody_run_123456";
const OTHER_RUN = "exec_ems_custody_run_654321";
const owner = (runId = RUN, agentId = "hub") => custody.emscriptenJobOwner({ runId, agentId });
const fileNode = () => ({ kind: "file", bytes: new Uint8Array() });
const dirNode = () => ({ kind: "directory", children: new Map() });

class MemoryDirectory {
  kind = "directory";
  constructor(node = dirNode()) { this.node = node; }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.node.children.has(name) && create) this.node.children.set(name, dirNode());
    const child = this.node.children.get(name);
    if (child?.kind !== "directory") throw new Error("directory not found");
    return new MemoryDirectory(child);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.node.children.has(name) && create) this.node.children.set(name, fileNode());
    const node = this.node.children.get(name);
    if (node?.kind !== "file") throw new Error("file not found");
    return {
      kind: "file",
      getFile: async () => new Blob([node.bytes]),
      createWritable: async ({ keepExistingData = false } = {}) => {
        let next = keepExistingData ? node.bytes.slice() : new Uint8Array();
        let position = 0;
        return {
          async seek(at) { position = at; },
          async write(value) {
            const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
            const merged = new Uint8Array(Math.max(next.length, position + bytes.length));
            merged.set(next); merged.set(bytes, position); next = merged; position += bytes.length;
          },
          async close() { node.bytes = next; },
          async abort() {},
        };
      },
    };
  }
  async removeEntry(name) {
    if (!this.node.children.delete(name)) throw new Error("entry not found");
  }
  async *entries() {
    for (const [name, node] of this.node.children) yield [name, { kind: node.kind }];
  }
}
function memoryStorage() {
  const root = new MemoryDirectory();
  return { storage: { async getDirectory() { return root; } }, root };
}
const digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");
const provenance = { packageId: "cap.example.image", version: "1.0.0", operationId: "image_resize", graphDigest: "a".repeat(64) };
async function setup({ runId = RUN, agentId = "hub", storage } = {}) {
  const inputBytes = new TextEncoder().encode("unchanged original input");
  const inputRef = await stageWasmStreamInputChunks({ owner: owner(runId, agentId), chunks: [inputBytes], storage });
  return { inputBytes, inputRef, ...await custody.allocateEmscriptenJobStreams({ runId, agentId, inputRef, storage }) };
}
const expectCode = async (promise, code) => {
  const error = await assertRejects(() => promise);
  assertEquals(error.code ?? error.message, code);
};

Deno.test("ltkj.4.3: only sealed input Blob and output handles cross the job boundary", async () => {
  const { storage } = memoryStorage();
  const job = await setup({ storage });
  assertEquals(job.owner, owner());
  assertEquals(job.inputRef.kind, "input");
  assertEquals(job.outputRef.kind, "stdout");
  assertEquals(new TextDecoder().decode(await job.handles.inputFile.arrayBuffer()), "unchanged original input");
  assertEquals(typeof job.handles.inputFile.createWritable, "undefined", "input must not carry a writable OPFS handle");
  assertEquals(typeof job.handles.stdoutFile.createWritable, "function");
  assertEquals(typeof job.handles.stderrFile.createWritable, "function");
  assertEquals(Object.keys(job.handles).sort(), ["inputFile", "stderrFile", "stdoutFile"]);
  assertEquals("directory" in job, false, "never hand a job an OPFS directory/root");
  await custody.discardEmscriptenJobOutput({ runId: RUN, agentId: "hub", outputRef: job.outputRef, storage });
  assertEquals((await listWasmStreamEntries({ storage })).length, 1, "original sealed input survives output cleanup");
});

Deno.test("ltkj.4.3: invalid identities and caller owner are refused before any allocation", async () => {
  const { storage } = memoryStorage();
  for (const overrides of [
    { runId: "" }, { runId: "arbitrary-run" }, { runId: "x".repeat(257) }, { runId: null },
    { agentId: "" }, { agentId: "x".repeat(257) }, { agentId: "hub/../foreign" },
    { owner: "agent:forged:hub" },
  ]) {
    await expectCode(custody.allocateEmscriptenJobStreams({ runId: RUN, agentId: "hub", storage, ...overrides }),
      "emscripten_custody_invalid_identity");
  }
  assertEquals(await listWasmStreamEntries({ storage }), []);
});

Deno.test("ltkj.4.3: a foreign sealed input never creates an output or changes original bytes", async () => {
  const { storage } = memoryStorage();
  const inputRef = await stageWasmStreamInputChunks({ owner: owner(RUN, "named:alice"),
    chunks: [new TextEncoder().encode("alice's original")], storage });
  await expectCode(custody.allocateEmscriptenJobStreams({ runId: RUN, agentId: "named:bob", inputRef, storage }),
    "wasm_stream_authority");
  await expectCode(custody.allocateEmscriptenJobStreams({ runId: OTHER_RUN, agentId: "named:alice", inputRef, storage }),
    "wasm_stream_authority");
  assertEquals((await listWasmStreamEntries({ storage })).map(({ id }) => id), [inputRef.id]);
});

Deno.test("7wywc: colon-bearing run/agent tuples have distinct, reversible stream owners", () => {
  const first = { runId: "acp:aaaaaaaa", agentId: "b:c" };
  const second = { runId: "acp:aaaaaaaa:b", agentId: "c" };
  const firstOwner = custody.emscriptenJobOwner(first);
  const secondOwner = custody.emscriptenJobOwner(second);
  assert(firstOwner !== secondOwner, "different run/agent tuples must never share a stream owner");
  for (const { runId, agentId } of [first, second, { runId: RUN, agentId: "named:alice" }]) {
    const encoded = custody.emscriptenJobOwner({ runId, agentId });
    assertEquals(encoded.startsWith(`agent:${runId}:|`), true);
    assertEquals(encoded.slice(`agent:${runId}:|`.length), agentId);
  }
});

Deno.test("7wywc: a colliding tuple cannot open or discard another job's streams", async () => {
  const { storage } = memoryStorage();
  const first = { runId: "acp:aaaaaaaa", agentId: "b:c" };
  const second = { runId: "acp:aaaaaaaa:b", agentId: "c" };
  const job = await setup({ ...first, storage });
  await expectCode(custody.allocateEmscriptenJobStreams({ ...second, inputRef: job.inputRef, storage }), "wasm_stream_authority");
  await expectCode(custody.discardEmscriptenJobOutput({ ...second, outputRef: job.outputRef, storage }), "wasm_stream_authority");
  assertEquals((await listWasmStreamEntries({ storage })).map(({ id }) => id).sort(),
    [job.inputRef.id, job.outputRef.id].sort(), "foreign owner cannot delete the other job's input or output");
  await custody.discardEmscriptenJobOutput({ ...first, outputRef: job.outputRef, storage });
});

Deno.test("ltkj.4.3: seal independently hashes bounded chunks and binds exact run provenance", async () => {
  const { storage } = memoryStorage();
  const job = await setup({ storage });
  const bytes = Uint8Array.from({ length: 150_009 }, (_, i) => i % 251);
  const writer = await job.handles.stdoutFile.createWritable();
  await writer.write(bytes); await writer.close();
  const sha256 = await digest(bytes);
  const sealed = await custody.sealEmscriptenOutput({ runId: RUN, agentId: "hub", outputRef: job.outputRef,
    bytes: bytes.length, sha256, provenance, storage });
  assertEquals(sealed.receipt, { ...provenance, runId: RUN, agentId: "hub", bytes: bytes.length, sha256 });
  assertEquals((await custody.verifyEmscriptenOutputSeal({ runId: RUN, agentId: "hub", outputRef: job.outputRef, storage })).sha256, sha256);
  assertEquals((await custody.verifyEmscriptenOutputSeal({ runId: RUN, agentId: "hub", outputRef: job.outputRef, storage })).bytes, bytes.length,
    "independent second verification is safe and does not publish");
});

Deno.test("ltkj.4.3: size and digest drift discard the unpublished output, never the input", async () => {
  for (const drift of ["size", "digest"]) {
    const { storage } = memoryStorage();
    const job = await setup({ storage });
    const bytes = new TextEncoder().encode("output bytes");
    const writer = await job.handles.stdoutFile.createWritable();
    await writer.write(bytes); await writer.close();
    await expectCode(custody.sealEmscriptenOutput({ runId: RUN, agentId: "hub", outputRef: job.outputRef,
      bytes: drift === "size" ? bytes.length + 1 : bytes.length,
      sha256: drift === "digest" ? "0".repeat(64) : await digest(bytes), provenance, storage }),
    drift === "size" ? "wasm_stream_size_drift" : "emscripten_output_verification_failed");
    const entries = await listWasmStreamEntries({ storage });
    assertEquals(entries.map(({ id }) => id), [job.inputRef.id], `${drift}: only original sealed input remains`);
  }
});

Deno.test("ltkj.4.3: post-seal mutation fails verification and discards the output", async () => {
  const { storage } = memoryStorage();
  const job = await setup({ storage });
  const bytes = new TextEncoder().encode("original output");
  let writer = await job.handles.stdoutFile.createWritable();
  await writer.write(bytes); await writer.close();
  await custody.sealEmscriptenOutput({ runId: RUN, agentId: "hub", outputRef: job.outputRef,
    bytes: bytes.length, sha256: await digest(bytes), provenance, storage });
  writer = await job.handles.stdoutFile.createWritable();
  await writer.write(new TextEncoder().encode("modified output")); await writer.close();
  await expectCode(custody.verifyEmscriptenOutputSeal({ runId: RUN, agentId: "hub", outputRef: job.outputRef, storage }),
    "emscripten_output_verification_failed");
  assertEquals((await listWasmStreamEntries({ storage })).map(({ id }) => id), [job.inputRef.id]);
});

Deno.test("ltkj.4.3: malformed sealed receipt is discarded before any publication", async () => {
  const { storage, root } = memoryStorage();
  const job = await setup({ storage });
  const bytes = new TextEncoder().encode("output");
  const writer = await job.handles.stdoutFile.createWritable();
  await writer.write(bytes); await writer.close();
  await custody.sealEmscriptenOutput({ runId: RUN, agentId: "hub", outputRef: job.outputRef,
    bytes: bytes.length, sha256: await digest(bytes), provenance, storage });
  const streamRoot = await root.getDirectoryHandle(WASM_STREAM_ROOT_NAME);
  const outputDir = await streamRoot.getDirectoryHandle(job.outputRef.id);
  const receipt = await outputDir.getFileHandle("receipt.json");
  const corrupt = await receipt.createWritable();
  await corrupt.write(JSON.stringify({ ...provenance, runId: RUN, agentId: "hub", bytes: bytes.length, sha256: "0".repeat(64), forged: true }));
  await corrupt.close();
  await expectCode(custody.verifyEmscriptenOutputSeal({ runId: RUN, agentId: "hub", outputRef: job.outputRef, storage }),
    "emscripten_output_verification_failed");
  assertEquals((await listWasmStreamEntries({ storage })).map(({ id }) => id), [job.inputRef.id]);
});

Deno.test("ltkj.4.3: foreign or unsealed output cannot be verified or discarded across owners", async () => {
  const { storage } = memoryStorage();
  const alice = await setup({ agentId: "named:alice", storage });
  await expectCode(custody.verifyEmscriptenOutputSeal({ runId: RUN, agentId: "named:alice", outputRef: alice.outputRef, storage }), "wasm_stream_authority");
  await expectCode(custody.verifyEmscriptenOutputSeal({ runId: OTHER_RUN, agentId: "named:alice", outputRef: alice.outputRef, storage }), "wasm_stream_authority");
  await expectCode(custody.discardEmscriptenJobOutput({ runId: RUN, agentId: "named:bob", outputRef: alice.outputRef, storage }), "wasm_stream_authority");
  assertEquals((await listWasmStreamEntries({ storage })).length, 2, "failed foreign calls leave original input and output intact");
});

Deno.test("ltkj.4.4: durable intent precedes output-directory creation and append refusal preserves input", async () => {
  const { storage, root } = memoryStorage();
  const inputRef = await stageWasmStreamInputChunks({ owner: owner(), chunks: [new TextEncoder().encode("original")], storage });
  const events = [];
  const auditedStorage = { async getDirectory() {
    events.push("directory-open");
    return root;
  } };
  await expectCode(audited.allocateAuditedEmscriptenJobStreams({
    runId: RUN, agentId: "hub", inputRef, storage: auditedStorage,
    isLive: () => true,
    append: () => { events.push("intent-append-failed"); throw new Error("disk full"); },
  }), "emscripten_custody_audit_unavailable");
  assertEquals(events.slice(-1), ["intent-append-failed"], "no directory open after rejected intent");
  assertEquals((await listWasmStreamEntries({ storage })).map((entry) => entry.id), [inputRef.id]);
  const rows = new Map();
  const job = await audited.allocateAuditedEmscriptenJobStreams({
    runId: RUN, agentId: "hub", inputRef, storage, isLive: () => true,
    append: async (_run, row, key) => { rows.set(key, row); return row; },
  });
  const intent = rows.get(`emscripten-intent:${RUN}:${job.outputRef.id}`);
  assertEquals(intent.outputRef, job.outputRef);
  assertEquals(intent.owner, owner());
  assertEquals(intent.nonpromotable, true);
  assertEquals(Object.keys(job.handles).sort(), ["inputFile", "stderrFile", "stdoutFile"]);
});

Deno.test("ltkj.4.4: terminal audit requires matching durable intent, stopped worker and live SW run", async () => {
  const { storage } = memoryStorage();
  const inputRef = await stageWasmStreamInputChunks({ owner: owner(), chunks: [new TextEncoder().encode("original")], storage });
  const rows = new Map();
  const append = async (_run, row, key) => { rows.set(key, row); return row; };
  const job = await audited.allocateAuditedEmscriptenJobStreams({
    runId: RUN, agentId: "hub", inputRef, storage, isLive: () => true, append,
  });
  const bytes = new TextEncoder().encode("output");
  const writer = await job.handles.stdoutFile.createWritable();
  await writer.write(bytes); await writer.close();
  await custody.sealEmscriptenOutput({ runId: RUN, agentId: "hub", outputRef: job.outputRef,
    bytes: bytes.length, sha256: await digest(bytes), provenance, storage });
  const args = { runId: RUN, agentId: "hub", inputRef, outputRef: job.outputRef, storage, append,
    readIntent: async (_run, key) => rows.get(key), isLive: () => true, isTerminated: () => true };
  await expectCode(audited.recordEmscriptenTerminalAudit({ ...args, isTerminated: () => false }), "emscripten_worker_not_fenced");
  await expectCode(audited.recordEmscriptenTerminalAudit({ ...args, isLive: () => false }), "emscripten_run_not_live");
  await expectCode(audited.recordEmscriptenTerminalAudit({ ...args, readIntent: async () => null }), "emscripten_custody_audit_mismatch");
  await expectCode(audited.recordEmscriptenTerminalAudit({ ...args, readIntent: async () => ({ ...rows.values().next().value, agentId: "foreign" }) }), "emscripten_custody_audit_mismatch");
  assertEquals([...rows.keys()].filter((key) => key.includes("terminal")).length, 0);
  const terminal = await audited.recordEmscriptenTerminalAudit(args);
  assertEquals(terminal, { ok: true, audited: true, bytes: bytes.length, sha256: await digest(bytes) });
  assertEquals(rows.get(`emscripten-terminal:${RUN}:${job.outputRef.id}`).workerTerminated, true);
  await expectCode(audited.discardFencedEmscriptenOutput({ ...args, isTerminated: () => false }), "emscripten_worker_not_fenced");
  assertEquals((await listWasmStreamEntries({ storage })).length, 2);
});

Deno.test("ltkj.4.4: SW registry adapter refuses absent/compacted intent and checks persisted replay", async () => {
  const rows = [];
  const registry = {
    async appendLog(runId, row, idempotencyKey) {
      const existing = rows.find((item) => item.idempotencyKey === idempotencyKey);
      if (existing) return existing;
      const saved = { ...row, executionId: runId, idempotencyKey };
      rows.push(saved); return saved;
    },
    async listLogs() { return rows.slice(); },
  };
  const authority = audited.emscriptenRunAuditAuthority({ registry, isLive: () => true, isTerminated: () => true });
  const row = { type: "emscripten-custody-intent", runId: RUN, agentId: "hub" };
  const key = `emscripten-intent:${RUN}:abcd`;
  await authority.append(RUN, row, key);
  assertEquals((await authority.readIntent(RUN, key)).agentId, "hub");
  const replay = await authority.append(RUN, { ...row, agentId: "foreign" }, key);
  assertEquals(replay.agentId, "hub", "caller must reject a mismatched persisted replay");
  rows.length = 0;
  assertEquals(await authority.readIntent(RUN, key), null, "a compacted intent cannot be inferred");
  await expectCode(Promise.resolve().then(() => audited.emscriptenRunAuditAuthority({ registry: null, isLive: () => true, isTerminated: () => true })),
    "emscripten_custody_audit_unavailable");
});

Deno.test("ltkj.4.4: intent replay mismatch and post-append cancellation never create output", async () => {
  const { storage } = memoryStorage();
  const inputRef = await stageWasmStreamInputChunks({ owner: owner(), chunks: [new TextEncoder().encode("original")], storage });
  await expectCode(audited.allocateAuditedEmscriptenJobStreams({ runId: RUN, agentId: "hub", inputRef, storage,
    isLive: () => true, append: (_run, row) => ({ ...row, agentId: "other" }),
  }), "emscripten_custody_audit_mismatch");
  let checks = 0;
  await expectCode(audited.allocateAuditedEmscriptenJobStreams({ runId: RUN, agentId: "hub", inputRef, storage,
    isLive: () => ++checks < 3, append: (_run, row) => row,
  }), "emscripten_run_not_live");
  assertEquals((await listWasmStreamEntries({ storage })).map((entry) => entry.id), [inputRef.id]);
});

Deno.test("ltkj.4.3: custody has no publication path and cannot bypass binary refusal", async () => {
  assertEquals("publishEmscriptenArtifact" in custody, false);
  const moduleText = await Deno.readTextFile(new URL("../extension/lib/emscripten-custody.js", import.meta.url));
  assert(!moduleText.includes("promoteWasmStreamToArtifact"));
  const brokerText = await Deno.readTextFile(new URL("../extension/lib/emscripten-run-broker.js", import.meta.url));
  assert(brokerText.includes("requiresSealedCustody(op)"));
  const hostText = await Deno.readTextFile(new URL("../extension/lib/emscripten-host.js", import.meta.url));
  assert(hostText.includes('fail("emscripten_output_custody_unavailable")'));
});
