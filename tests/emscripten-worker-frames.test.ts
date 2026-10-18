// Pure protocol test for the retained binary worker path; binary execution is
// still denied by the broker and host until custody and publication are audited.
// @ts-nocheck
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  acceptEmscriptenOutputFrame, createEmscriptenFrameAcks, EMSCRIPTEN_OUTPUT_ACK_TYPE,
  EMSCRIPTEN_OUTPUT_FRAME_TYPE, postEmscriptenOutputFrames,
} from "../extension/lib/emscripten-worker-frames.js";

const ID = { sessionId: "s1", packageId: "p1", operationId: "o1", workerInstanceId: "w1" };
function ack(seq, overrides = {}) {
  return { type: EMSCRIPTEN_OUTPUT_ACK_TYPE, ...ID, seq, ok: true, ...overrides };
}
async function code(operation, expected) {
  const error = await assertRejects(operation);
  assertEquals(error.code ?? error.message, expected);
}

Deno.test("3mcu1: worker posts at most one 64KiB frame before host ACK, no output ref", async () => {
  const acks = createEmscriptenFrameAcks(ID);
  const frames = [];
  const transfer = [];
  const bytes = new Uint8Array(2 * 65536 + 3);
  bytes.fill(17);
  let finished = false;
  const sending = postEmscriptenOutputFrames(bytes, ID, {
    expectAck: (seq) => acks.expect(seq),
    postFrame: (frame, list) => { frames.push(frame); transfer.push(list); },
  }).then((result) => { finished = true; return result; });
  assertEquals(frames.length, 1);
  assertEquals(frames[0].type, EMSCRIPTEN_OUTPUT_FRAME_TYPE);
  assertEquals(frames[0].chunk.byteLength, 65536);
  assertEquals(Object.keys(frames[0]).sort(),
    ["type", "sessionId", "packageId", "operationId", "workerInstanceId", "seq", "chunk"].sort());
  assertEquals(transfer[0][0], frames[0].chunk.buffer);
  assertEquals(finished, false);
  // A forged/malformed ACK cannot permit the next frame.
  assert(acks.receive(ack(0, { workerInstanceId: "other" })));
  assert(acks.receive(ack(1)));
  await Promise.resolve();
  assertEquals(frames.length, 1);
  assert(acks.receive(ack(0)));
  await Promise.resolve();
  assertEquals(frames.length, 2);
  assertEquals(frames[1].chunk.byteLength, 65536);
  assert(acks.receive(ack(1)));
  await Promise.resolve();
  assertEquals(frames.length, 3);
  assertEquals(frames[2].chunk.byteLength, 3);
  assert(acks.receive(ack(2)));
  assertEquals(await sending, { frames: 3, bytes: bytes.length });
  assertEquals(finished, true);
});

Deno.test("3mcu1: host write failure ACK stops output; a stale success cannot restart it", async () => {
  const acks = createEmscriptenFrameAcks(ID);
  const frames = [];
  const send = postEmscriptenOutputFrames(new Uint8Array(65537), ID, {
    expectAck: (seq) => acks.expect(seq),
    postFrame: (frame) => frames.push(frame),
  });
  assertEquals(frames.length, 1);
  assert(acks.receive(ack(0, { ok: false })));
  await code(() => send, "emscripten_frame_write_failed");
  assert(acks.receive(ack(0)));
  assertEquals(frames.length, 1);
});

Deno.test("3mcu1: invalid identity cannot smuggle OPFS handles/ref into frame", async () => {
  const acks = createEmscriptenFrameAcks(ID);
  await code(() => postEmscriptenOutputFrames(new Uint8Array([1]),
    { ...ID, outputRef: { id: "a".repeat(32), kind: "stdout" } },
    { expectAck: (seq) => acks.expect(seq), postFrame: () => assert(false) }), "emscripten_frame_data");
  assertEquals(acks.receive({ ...ack(0), outputRef: "secret" }), true);
  assertEquals(acks.receive({ type: "irrelevant" }), false);
});

Deno.test("3mcu1: host ACK is emitted only AFTER the host-owned write completes", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const messages = [];
  const hostIdentity = { sessionId: "s1", packageId: "p1", operationId: "o1", workerInstanceId: null };
  const channel = { async push({ seq, chunk }) { assertEquals(seq, 0); assertEquals([...chunk], [1, 2]); await gate; },
    abort: () => assert(false) };
  const accepting = acceptEmscriptenOutputFrame({ type: EMSCRIPTEN_OUTPUT_FRAME_TYPE, ...ID,
    seq: 0, chunk: new Uint8Array([1, 2]) }, hostIdentity, channel, (ack) => messages.push(ack));
  await Promise.resolve();
  assertEquals(messages, []);
  release();
  assertEquals(await accepting, true);
  assertEquals(messages, [ack(0)]);
  assertEquals(hostIdentity.workerInstanceId, "w1");
});

Deno.test("3mcu1: malformed, foreign or oversized frame aborts host writer without ACK", async () => {
  for (const frame of [
    { type: EMSCRIPTEN_OUTPUT_FRAME_TYPE, ...ID, seq: 0, chunk: new Uint8Array(65537) },
    { type: EMSCRIPTEN_OUTPUT_FRAME_TYPE, ...ID, workerInstanceId: "foreign", seq: 0, chunk: new Uint8Array() },
    { type: EMSCRIPTEN_OUTPUT_FRAME_TYPE, ...ID, seq: 0, chunk: new Uint8Array(), outputRef: "smuggled" },
  ]) {
    const reasons = []; const replies = [];
    const channel = { push: () => assert(false), abort: (reason) => reasons.push(reason) };
    const identity = { ...ID };
    await code(() => acceptEmscriptenOutputFrame(frame, identity, channel, (ack) => replies.push(ack)),
      "emscripten_frame_invalid");
    assertEquals(reasons, ["writer_fence_unavailable"]);
    assertEquals(replies, []);
  }
});

Deno.test("3mcu1: actual module Worker transfers frames and returns no binary result", async () => {
  const worker = new Worker(new URL("../extension/lib/emscripten-worker.js", import.meta.url).href, { type: "module" });
  const glueUrl = "data:text/javascript," + encodeURIComponent(
    "export default async () => ({ hash: () => 0 })");
  const adapterUrl = "data:text/javascript," + encodeURIComponent(
    "export function createBlake3Adapter() { return { hash: () => new Uint8Array(65539).fill(23) }; }");
  const frames = [];
  const hostIdentity = { sessionId: "session", packageId: "pkg", operationId: "hash", workerInstanceId: null };
  let pushedBytes = 0;
  const hostChannel = { push: async ({ chunk }) => { pushedBytes += chunk.byteLength; },
    abort: () => assert(false, "real Worker never poisons the host writer") };
  let timer;
  try {
    const terminal = await Promise.race([
      new Promise((resolve, reject) => {
        worker.onerror = (event) => reject(new Error(String(event.message)));
        worker.onmessage = ({ data }) => {
          if (data.type === EMSCRIPTEN_OUTPUT_FRAME_TYPE) {
            frames.push(data);
            acceptEmscriptenOutputFrame(data, hostIdentity, hostChannel,
              (ack) => worker.postMessage(ack)).catch(reject);
          } else resolve(data);
        };
        worker.postMessage({
          type: "cap:emscripten-worker-job", sessionId: "session", packageId: "pkg",
          version: "1.0.0", graphDigest: "a".repeat(64), operationId: "hash",
          operation: { adapterId: "cap-blake3-wasm-v1", exportName: "hash", result: "buffer" },
          args: [], glueUrl, adapterUrl, wasmBytes: new Uint8Array([1]),
        });
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("worker frame deadline")), 5000); }),
    ]);
    assertEquals(terminal.ok, true);
    assertEquals(terminal.result, null, "terminal must not clone binary data");
    assertEquals(frames.map((frame) => frame.chunk.byteLength), [65536, 3]);
    assertEquals(frames.map((frame) => frame.seq), [0, 1]);
    assertEquals(pushedBytes, 65539, "terminal follows all acknowledged host writes");
    assertEquals(hostIdentity.workerInstanceId, terminal.workerInstanceId);
    assert(frames.every((frame) => frame.chunk.every((byte) => byte === 23)));
  } finally { clearTimeout(timer); worker.terminate(); }
});

Deno.test("3mcu1: frozen host identity cannot turn a frame into an untyped omission", async () => {
  const reasons = []; const replies = [];
  const frozen = Object.freeze({ sessionId: "s1", packageId: "p1", operationId: "o1", workerInstanceId: null });
  const channel = { push: () => assert(false), abort: (reason) => reasons.push(reason) };
  await code(() => acceptEmscriptenOutputFrame({ type: EMSCRIPTEN_OUTPUT_FRAME_TYPE,
    ...ID, seq: 0, chunk: new Uint8Array([1]) }, frozen, channel,
  (ack) => replies.push(ack)), "emscripten_frame_invalid");
  assertEquals(reasons, ["writer_fence_unavailable"]);
  assertEquals(replies, []);
});

Deno.test("3mcu1: empty binary output sends no frames or payload", async () => {
  const result = await postEmscriptenOutputFrames(new Uint8Array(), ID, {
    expectAck: () => assert(false), postFrame: () => assert(false),
  });
  assertEquals(result, { frames: 0, bytes: 0 });
});
