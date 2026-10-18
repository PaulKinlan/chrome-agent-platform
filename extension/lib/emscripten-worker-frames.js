// Pure job-Worker -> offscreen-host byte transport. No OPFS ref, handle or
// directory crosses this message channel. A frame ACK grants only backpressure.
export const EMSCRIPTEN_OUTPUT_FRAME_TYPE = "cap:emscripten-output-frame";
export const EMSCRIPTEN_OUTPUT_ACK_TYPE = "cap:emscripten-output-ack";
const FRAME_BYTES = 64 * 1024;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

/** Receiver is scoped to ONE worker instance and one broker-issued session.
 * An ACK cannot authorize a file write; it only lets the worker send the next
 * bounded frame. The host's existing deadline ends an unacknowledged worker. */
export function createEmscriptenFrameAcks({ sessionId, packageId, operationId, workerInstanceId }) {
  let waiting = null;
  return Object.freeze({
    expect(seq) {
      if (waiting || !Number.isSafeInteger(seq) || seq < 0) fail("emscripten_frame_ack_state");
      return new Promise((resolve, reject) => { waiting = { seq, resolve, reject }; });
    },
    receive(raw) {
      if (raw?.type !== EMSCRIPTEN_OUTPUT_ACK_TYPE) return false;
      if (!exactKeys(raw, ["type", "sessionId", "packageId", "operationId", "workerInstanceId", "seq", "ok"]) ||
          raw.sessionId !== sessionId || raw.packageId !== packageId ||
          raw.operationId !== operationId || raw.workerInstanceId !== workerInstanceId ||
          !Number.isSafeInteger(raw.seq) || raw.seq < 0 || typeof raw.ok !== "boolean" ||
          !waiting || waiting.seq !== raw.seq) return true; // malformed/stale ACK has no effect
      const next = waiting;
      waiting = null;
      if (raw.ok) next.resolve();
      else next.reject(Object.assign(new Error("emscripten_frame_write_failed"), { code: "emscripten_frame_write_failed" }));
      return true;
    },
  });
}

/** One in-flight frame: never buffer total output in the host message queue.
 * Caller must verify result is Uint8Array and wait for all ACKs BEFORE posting
 * the scalar terminal result; no binary result is sent in the final message. */
export async function postEmscriptenOutputFrames(bytes, identity, { expectAck, postFrame }) {
  if (!(bytes instanceof Uint8Array) ||
      !exactKeys(identity, ["sessionId", "packageId", "operationId", "workerInstanceId"]) ||
      typeof identity.sessionId !== "string" || typeof identity.packageId !== "string" ||
      typeof identity.operationId !== "string" || typeof identity.workerInstanceId !== "string" ||
      typeof expectAck !== "function" || typeof postFrame !== "function") {
    fail("emscripten_frame_data");
  }
  let seq = 0;
  for (let offset = 0; offset < bytes.byteLength; offset += FRAME_BYTES) {
    const chunk = bytes.slice(offset, Math.min(offset + FRAME_BYTES, bytes.byteLength));
    const ack = expectAck(seq); // arm BEFORE posting to prevent synchronous ACK races.
    postFrame({ type: EMSCRIPTEN_OUTPUT_FRAME_TYPE, ...identity, seq, chunk }, [chunk.buffer]);
    await ack;
    seq++;
  }
  return Object.freeze({ frames: seq, bytes: bytes.byteLength });
}

/** Host-owned receiver: an ACK follows the actual serialized writer.write(),
 * never mere receipt of an untrusted worker message. On mismatch, abort the
 * channel (UNKNOWN) and let the host terminate the job Worker. */
export async function acceptEmscriptenOutputFrame(frame, identity, channel, reply) {
  if (frame?.type !== EMSCRIPTEN_OUTPUT_FRAME_TYPE) return false;
  if (!exactKeys(frame, ["type", "sessionId", "packageId", "operationId", "workerInstanceId", "seq", "chunk"]) ||
      frame.sessionId !== identity?.sessionId || frame.packageId !== identity?.packageId ||
      frame.operationId !== identity?.operationId ||
      typeof frame.workerInstanceId !== "string" || frame.workerInstanceId.length === 0 ||
      frame.workerInstanceId.length > 128 ||
      (identity.workerInstanceId !== null && frame.workerInstanceId !== identity.workerInstanceId) ||
      !Number.isSafeInteger(frame.seq) || frame.seq < 0 ||
      !(frame.chunk instanceof Uint8Array) || frame.chunk.byteLength > FRAME_BYTES ||
      typeof channel?.push !== "function" || typeof channel?.abort !== "function" ||
      typeof reply !== "function") {
    await channel?.abort?.("writer_fence_unavailable");
    fail("emscripten_frame_invalid");
  }
  if (identity.workerInstanceId === null) {
    try { identity.workerInstanceId = frame.workerInstanceId; }
    catch {
      await channel.abort("writer_fence_unavailable");
      fail("emscripten_frame_invalid");
    }
  }
  try {
    await channel.push({ seq: frame.seq, chunk: frame.chunk });
    reply({ type: EMSCRIPTEN_OUTPUT_ACK_TYPE, sessionId: frame.sessionId,
      packageId: frame.packageId, operationId: frame.operationId,
      workerInstanceId: frame.workerInstanceId, seq: frame.seq, ok: true });
  } catch (cause) {
    await channel.abort("writer_fence_unavailable");
    fail("emscripten_frame_write_failed");
  }
  return true;
}
