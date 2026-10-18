// Direct trusted-module seam only. No SW or offscreen-message binary route.
// @ts-nocheck
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { runAuditedHostBinaryJob } from "../extension/lib/emscripten-host-binary-runner.js";
import { createEmscriptenHostEvidence } from "../extension/lib/emscripten-host-evidence.js";
import { emscriptenJobOwner } from "../extension/lib/emscripten-custody.js";
import { createWasmStreamOutput, listWasmStreamEntries } from "../extension/lib/wasm-stream-files.js";
import { EMSCRIPTEN_OUTPUT_FRAME_TYPE, EMSCRIPTEN_OUTPUT_ACK_TYPE } from "../extension/lib/emscripten-worker-frames.js";

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
function fakeWorker({ malformed = false, timeout = false } = {}) {
  const frames = [];
  let stopped = 0;
  const instance = "11111111-1111-4111-8111-111111111111";
  let job;
  const worker = {
    get stopped() { return stopped; },
    get frames() { return frames; },
    terminate() { stopped++; },
    postMessage(message) {
      if (message.type === "cap:emscripten-worker-job") {
        job = message;
        if (timeout) return;
        queueMicrotask(() => worker.onmessage({ data: {
          type: EMSCRIPTEN_OUTPUT_FRAME_TYPE, sessionId: job.sessionId,
          packageId: job.packageId, operationId: job.operationId,
          workerInstanceId: instance, seq: 0, chunk: new Uint8Array([10, 20]),
          ...(malformed ? { outputRef: "forged" } : {}),
        } }));
      } else if (message.type === EMSCRIPTEN_OUTPUT_ACK_TYPE) {
        frames.push(message);
        queueMicrotask(() => worker.onmessage({ data: {
          type: "cap:emscripten-run-result", sessionId: job.sessionId,
          packageId: job.packageId, operationId: job.operationId,
          workerInstanceId: instance, ok: true, phase: "completed", result: null, error: null,
        } }));
      }
    },
  };
  return worker;
}

Deno.test("3mcu1: host-only runner writes through host channel, closes and persists exact proof", async () => {
  const { storage, identity, evidence, job } = await context();
  const worker = fakeWorker();
  const proof = await runAuditedHostBinaryJob({ identity, job, storage, evidence,
    createWorker: () => worker, wallMs: 1000 });
  assertEquals(proof.bytes, 2);
  assertEquals(proof.frames, 1);
  assertEquals(proof.evidenceState, "closed");
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
