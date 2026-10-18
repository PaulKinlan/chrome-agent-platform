// Direct trusted-module seam only. No SW or offscreen-message binary route.
// @ts-nocheck
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { runAuditedHostBinaryJob } from "../extension/lib/emscripten-host-binary-runner.js";
import { createEmscriptenHostEvidence } from "../extension/lib/emscripten-host-evidence.js";
import { emscriptenJobOwner } from "../extension/lib/emscripten-custody.js";
import { createWasmStreamOutput, listWasmStreamEntries } from "../extension/lib/wasm-stream-files.js";
import { EMSCRIPTEN_OUTPUT_FRAME_TYPE, EMSCRIPTEN_OUTPUT_ACK_TYPE, createEmscriptenOutputEnd } from "../extension/lib/emscripten-worker-frames.js";

function storageFixture() {
  function directory() {
    const children = new Map();
    return {
      async getDirectoryHandle(name, { create = false } = {}) {
        if (!children.has(name) && create) children.set(name, directory());
        const value = children.get(name);
        if (!value?.getDirectoryHandle) throw new DOMException("missing", "NotFoundError");
        return value;
      },
      async getFileHandle(name, { create = false } = {}) {
        if (!children.has(name) && create) children.set(name, { bytes: new Uint8Array(), open: 0 });
        const file = children.get(name);
        if (!file || file.getDirectoryHandle) throw new DOMException("missing", "NotFoundError");
        return {
          getFile: async () => new Blob([file.bytes]),
          createWritable: async ({ mode } = {}) => {
            if (mode === "exclusive" && file.open) {
              throw new DOMException("locked", "NoModificationAllowedError");
            }
            file.open++;
            let buffer = new Uint8Array(); let done = false;
            const release = () => { if (!done) { done = true; file.open--; } };
            return {
              async write(data) {
                if (done) throw new Error("writer closed");
                const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
                const next = new Uint8Array(buffer.length + bytes.length);
                next.set(buffer); next.set(bytes, buffer.length); buffer = next;
              },
              async close() { file.bytes = buffer; release(); },
              async abort() { release(); },
            };
          },
        };
      },
      async *entries() { for (const [name, node] of children) yield [name, { kind: node.getDirectoryHandle ? "directory" : "file" }]; },
    };
  }
  const root = directory();
  return { getDirectory: async () => root };
}
async function context() {
  const storage = storageFixture();
  const runId = "exec_host_runner_123456";
  const agentId = "named:alice";
  const outputRef = await createWasmStreamOutput({ owner: emscriptenJobOwner({ runId, agentId }), storage });
  const identity = { runId, agentId, outputRef, generation: "f".repeat(32),
    packageId: "image.tool", graphDigest: "a".repeat(64), operationId: "resize" };
  const evidence = createEmscriptenHostEvidence({ storage });
  const job = { type: "cap:emscripten-worker-job", sessionId: "session-1",
    packageId: identity.packageId, version: "1.0.0", graphDigest: identity.graphDigest,
    operationId: identity.operationId, operation: {
      id: identity.operationId, adapterId: "cap-blake3-wasm-v1", exportName: "hash",
      params: [], result: "buffer",
    },
    args: [], glueUrl: "chrome-extension://test/glue.mjs",
    adapterUrl: "chrome-extension://test/adapter.mjs", wasmBytes: new Uint8Array([1]) };
  return { storage, identity, evidence, job };
}
function fakeWorker({ malformed = false, timeout = false, lateFrame = false,
  sendEnd = true, wrongDigest = false, frameAfterEnd = false,
  emptyOutput = false, duplicateEnd = false, wrongEndIdentity = false } = {}) {
  const frames = [];
  let stopped = 0;
  const instance = "11111111-1111-4111-8111-111111111111";
  let job;
  let transfer;
  const worker = {
    get stopped() { return stopped; },
    get frames() { return frames; },
    get transfer() { return transfer; },
    emitLateFrame() {
      worker.onmessage({ data: {
        type: EMSCRIPTEN_OUTPUT_FRAME_TYPE, sessionId: job.sessionId,
        packageId: job.packageId, operationId: job.operationId,
        workerInstanceId: instance, seq: 1, chunk: new Uint8Array([30]),
      } });
    },
    terminate() { stopped++; },
    postMessage(message, transferList) {
      if (message.type === "cap:emscripten-worker-job") {
        job = message;
        transfer = transferList;
        if (timeout) return;
        if (emptyOutput) {
          queueMicrotask(() => {
            const identity = { sessionId: job.sessionId, packageId: job.packageId,
              operationId: job.operationId, workerInstanceId: instance };
            if (sendEnd) worker.onmessage({ data: createEmscriptenOutputEnd(new Uint8Array(),
              identity, { frames: 0, bytes: 0 }) });
            worker.onmessage({ data: { type: "cap:emscripten-run-result",
              sessionId: job.sessionId, packageId: job.packageId, operationId: job.operationId,
              workerInstanceId: instance, ok: true, phase: "completed", result: null, error: null } });
          });
          return;
        }
        queueMicrotask(() => worker.onmessage({ data: {
          type: EMSCRIPTEN_OUTPUT_FRAME_TYPE, sessionId: job.sessionId,
          packageId: job.packageId, operationId: job.operationId,
          workerInstanceId: instance, seq: 0, chunk: new Uint8Array([10, 20]),
          ...(malformed ? { outputRef: "forged" } : {}),
        } }));
      } else if (message.type === EMSCRIPTEN_OUTPUT_ACK_TYPE) {
        frames.push(message);
        queueMicrotask(() => {
          if (sendEnd) {
            const end = createEmscriptenOutputEnd(new Uint8Array([10, 20]), {
              sessionId: job.sessionId, packageId: job.packageId,
              operationId: job.operationId, workerInstanceId: instance,
            }, { frames: 1, bytes: 2 });
            worker.onmessage({ data: wrongDigest ? { ...end, sha256: "0".repeat(64) } :
              wrongEndIdentity ? { ...end, workerInstanceId: "foreign" } : end });
            if (duplicateEnd) worker.onmessage({ data: end });
          }
          if (frameAfterEnd) worker.emitLateFrame();
          worker.onmessage({ data: {
            type: "cap:emscripten-run-result", sessionId: job.sessionId,
            packageId: job.packageId, operationId: job.operationId,
            workerInstanceId: instance, ok: true, phase: "completed", result: null, error: null,
          } });
          if (lateFrame) worker.onmessage({ data: {
            type: EMSCRIPTEN_OUTPUT_FRAME_TYPE, sessionId: job.sessionId,
            packageId: job.packageId, operationId: job.operationId,
            workerInstanceId: instance, seq: 1, chunk: new Uint8Array([30]),
          } });
        });
      }
    },
  };
  return worker;
}

Deno.test("x9r8k: scalar terminal without a producer-end declaration stays UNKNOWN", async () => {
  const { storage, identity, evidence, job } = await context();
  await assertRejects(() => runAuditedHostBinaryJob({ identity, job, storage, evidence,
    createWorker: () => fakeWorker({ sendEnd: false }), wallMs: 1000 }));
  assertEquals((await evidence.read(identity)).state, "unknown");
});

Deno.test("x9r8k: mismatched producer end or frame after end never yields CLOSED", async () => {
  for (const options of [{ wrongDigest: true }, { frameAfterEnd: true },
    { duplicateEnd: true }, { wrongEndIdentity: true }]) {
    const { storage, identity, evidence, job } = await context();
    await assertRejects(() => runAuditedHostBinaryJob({ identity, job, storage, evidence,
      createWorker: () => fakeWorker(options), wallMs: 1000 }));
    assertEquals((await evidence.read(identity)).state, "unknown");
  }
});

Deno.test("x9r8k: empty output binds Worker instance at producer-end and closes zero bytes", async () => {
  const { storage, identity, evidence, job } = await context();
  const proof = await runAuditedHostBinaryJob({ identity, job, storage, evidence,
    createWorker: () => fakeWorker({ emptyOutput: true }), wallMs: 1000 });
  assertEquals(proof.frames, 0);
  assertEquals(proof.bytes, 0);
  assertEquals(proof.sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assertEquals((await evidence.read(identity)).state, "closed");
});

Deno.test("3mcu1: host-only runner writes through host channel, closes and persists exact proof", async () => {
  const { storage, identity, evidence, job } = await context();
  const worker = fakeWorker();
  const proof = await runAuditedHostBinaryJob({ identity, job, storage, evidence,
    createWorker: () => worker, wallMs: 1000 });
  assertEquals(proof.bytes, 2);
  assertEquals(proof.frames, 1);
  assertEquals(proof.evidenceState, "closed");
  assertEquals(proof.ledgerRef.id, `${identity.outputRef.id}-${identity.generation}`);
  assertEquals(proof.ledgerRef.root, "emscripten-host-evidence-v1");
  assertEquals(worker.frames.length, 1);
  assertEquals(worker.frames[0].ok, true);
  assert(worker.stopped >= 1);
  assertEquals((await createEmscriptenHostEvidence({ storage }).read(identity)).state, "closed");
  assertEquals((await listWasmStreamEntries({ storage })).length, 1, "staging kept; never seal/publish/delete");
});

Deno.test("3mcu1: direct runner rejects nested OPFS capability before opening writer or Worker", async () => {
  const { storage, identity, evidence, job } = await context();
  let spawned = false;
  await assertRejects(() => runAuditedHostBinaryJob({ identity,
    job: { ...job, args: [{ outputRef: identity.outputRef }],
      operation: { ...job.operation, params: [{ name: "input", type: "buffer", minimum: 0, maximum: 3 }] } },
    storage, evidence, createWorker: () => { spawned = true; }, wallMs: 1000 }), Error,
  "emscripten_host_binary_job");
  assertEquals(spawned, false);
  assertEquals((await listWasmStreamEntries({ storage })).length, 1);
});

Deno.test("3mcu1: only the verified wasm subarray bytes cross the Worker transfer boundary", async () => {
  const { storage, identity, evidence, job } = await context();
  const backing = new Uint8Array([99, 99, 1, 2, 99, 99]);
  const worker = fakeWorker();
  const proof = await runAuditedHostBinaryJob({ identity,
    job: { ...job, wasmBytes: backing.subarray(2, 4) }, storage, evidence,
    createWorker: () => worker, wallMs: 1000 });
  assertEquals(proof.state, "closed");
  assertEquals(worker.transfer.length, 1);
  assertEquals(worker.transfer[0].byteLength, 2, "do not transfer unverified siblings");
});

Deno.test("3mcu1: a frame sent immediately after terminal poisons CLOSED evidence", async () => {
  const { storage, identity, evidence, job } = await context();
  const worker = fakeWorker({ lateFrame: true });
  await assertRejects(() => runAuditedHostBinaryJob({ identity, job, storage, evidence,
    createWorker: () => worker, wallMs: 1000 }));
  assertEquals((await evidence.read(identity)).state, "unknown");
  assertEquals((await listWasmStreamEntries({ storage })).length, 1);
});

Deno.test("3mcu1: frame observed after returned CLOSED revokes durable evidence", async () => {
  const { storage, identity, evidence, job } = await context();
  const worker = fakeWorker();
  let invalidation;
  const trackedEvidence = {
    begin: (raw) => evidence.begin(raw),
    recordUnknown: (raw, reason) => evidence.recordUnknown(raw, reason),
    recordClosed: (raw, proof) => evidence.recordClosed(raw, proof),
    recordProtocolViolation: (raw, reason) => {
      invalidation = evidence.recordProtocolViolation(raw, reason);
      return invalidation;
    },
  };
  const proof = await runAuditedHostBinaryJob({ identity, job, storage,
    evidence: trackedEvidence, createWorker: () => worker, wallMs: 1000 });
  assertEquals(proof.state, "closed");
  const closedRecord = await evidence.read(identity);
  assertEquals(proof.ledgerRef.id, `${identity.outputRef.id}-${identity.generation}`);
  worker.emitLateFrame();
  assert(invalidation instanceof Promise, "late frame must not be silently dropped");
  await invalidation;
  assertEquals((await evidence.read(identity)).state, "unknown");
  const restarted = createEmscriptenHostEvidence({ storage });
  assertEquals((await restarted.read(identity)).state, "unknown", "revocation survives restart");
  await assertRejects(() => evidence.recordClosed(identity, closedRecord.proof), Error,
    "emscripten_host_evidence_collision");
  await assertRejects(() => restarted.begin(identity), Error, "emscripten_host_evidence_unknown");
});

Deno.test("3mcu1: a late frame during terminal evidence append cannot leave CLOSED", async () => {
  const { storage, identity, evidence, job } = await context();
  const worker = fakeWorker();
  let entered;
  const recordEntered = new Promise((resolve) => { entered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let appendFinished;
  const appendSettled = new Promise((resolve) => { appendFinished = resolve; });
  const slowEvidence = {
    begin: (raw) => evidence.begin(raw),
    recordUnknown: (raw, reason) => evidence.recordUnknown(raw, reason),
    recordClosed: async (raw, proof) => {
      entered(); await gate;
      try { return await evidence.recordClosed(raw, proof); }
      finally { appendFinished(); }
    },
    recordProtocolViolation: (raw, reason) => evidence.recordProtocolViolation(raw, reason),
  };
  const running = runAuditedHostBinaryJob({ identity, job, storage, evidence: slowEvidence,
    createWorker: () => worker, wallMs: 1000 });
  const rejected = assertRejects(() => running);
  await recordEntered; // writer already closed; durable CLOSED append is still pending.
  worker.emitLateFrame();
  release();
  await rejected;
  await appendSettled; // distinguish pending's implicit UNKNOWN from a later CLOSED append.
  assertEquals((await evidence.read(identity)).state, "unknown");
});

Deno.test("3mcu1: evidence override without late-frame revocation refuses before Worker spawn", async () => {
  const { storage, identity, evidence, job } = await context();
  let spawned = false;
  const incomplete = {
    begin: (raw) => evidence.begin(raw),
    recordUnknown: (raw, reason) => evidence.recordUnknown(raw, reason),
    recordClosed: (raw, proof) => evidence.recordClosed(raw, proof),
  };
  await assertRejects(() => runAuditedHostBinaryJob({ identity, job, storage, evidence: incomplete,
    createWorker: () => { spawned = true; return fakeWorker(); }, wallMs: 1000 }), Error,
  "emscripten_writer_evidence_unavailable");
  assertEquals(spawned, false);
});

Deno.test("3mcu1: malformed frame and silent job both end UNKNOWN, never CLOSED", async () => {
  for (const options of [{ malformed: true }, { timeout: true }]) {
    const { storage, identity, evidence, job } = await context();
    const worker = fakeWorker(options);
    await assertRejects(() => runAuditedHostBinaryJob({ identity, job, storage, evidence,
      createWorker: () => worker, wallMs: options.timeout ? 5 : 1000 }));
    const terminal = await evidence.read(identity);
    assertEquals(terminal.state, "unknown");
    assertEquals(terminal.reason, options.timeout ? "deadline" : "writer_fence_unavailable");
    assert(worker.stopped >= 1);
    assertEquals((await listWasmStreamEntries({ storage })).length, 1);
  }
});

Deno.test("3mcu1: non-scalar version cannot smuggle a handle into the Worker", async () => {
  const { storage, identity, evidence, job } = await context();
  let spawned = false;
  await assertRejects(() => runAuditedHostBinaryJob({ identity,
    job: { ...job, version: { opfsHandle: "structured-cloneable" } }, storage, evidence,
    createWorker: () => { spawned = true; return fakeWorker(); }, wallMs: 1000 }), Error,
  "emscripten_host_binary_job");
  assertEquals(spawned, false);
});

Deno.test("3mcu1: no untrusted message port or SW route can call the direct runner", async () => {
  const host = await Deno.readTextFile(new URL("../extension/lib/emscripten-host.js", import.meta.url));
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const runner = await Deno.readTextFile(new URL("../extension/lib/emscripten-host-binary-runner.js", import.meta.url));
  assert(host.includes('fail("emscripten_output_custody_unavailable")'));
  assert(!host.includes("emscripten-host-binary-runner"));
  assert(!sw.includes("emscripten-host-binary-runner"));
  assert(!runner.includes("onMessage.addListener") && !runner.includes('addEventListener("message"'));
  assert(!runner.includes("outputRef: job") && !runner.includes("removeEntry("));
});
