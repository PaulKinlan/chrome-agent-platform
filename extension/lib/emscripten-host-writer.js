// Host-realm-only, retained Emscripten output writer. Never import this from the
// job Worker: it receives bytes over postMessage, NOT an OPFS handle or ref.
// Binary execution remains refused until SW/host audit and publication land.
import { emscriptenJobOwner } from "./emscripten-custody.js";
import { createEmscriptenHostEvidence } from "./emscripten-host-evidence.js";
import { createIncrementalSha256 } from "./incremental-sha256.js";
import { openWasmStreamHandles, validateWasmStreamRef, WASM_STREAM_FILE_NAMES } from "./wasm-stream-files.js";

const FRAME_BYTES = 64 * 1024;
const READ_BYTES = 64 * 1024;
const MAX_PENDING_FRAMES = 8; // Backpressure only, never an output-size ceiling.

function fail(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

/** Keep the exclusive writer open while probing a second open. An unknown
 * WebIDL dictionary member can be silently ignored, so an ordinary successful
 * first open is NOT evidence of exclusivity. No fallback to siloed mode. */
async function exclusiveWriter(handle, directory) {
  let primary;
  try {
    primary = await handle.createWritable({ mode: "exclusive" });
    let secondary;
    try {
      const independentHandle = await directory.getFileHandle(WASM_STREAM_FILE_NAMES.stdout);
      secondary = await independentHandle.createWritable({ mode: "exclusive" });
    }
    catch (error) {
      if (error?.name === "NoModificationAllowedError") return primary;
      throw error;
    }
    if (secondary?.abort) await secondary.abort().catch(() => {});
    fail("emscripten_writer_exclusivity_unavailable");
  } catch (error) {
    if (primary?.abort) await primary.abort().catch(() => {});
    if (error?.code === "emscripten_writer_exclusivity_unavailable") throw error;
    fail("emscripten_writer_exclusivity_unavailable", error);
  }
}

/** This API stays in the offscreen host. push() copies each bounded frame and
 * serializes it onto one exclusive writer; callers MUST await push() for
 * backpressure. close() refuses new frames, drains, closes, then independently
 * re-reads all bytes. It does not seal or publish the stream. */
export async function openHostOwnedEmscriptenWriter({ runId, agentId, outputRef, storage, recordUnknown } = {}) {
  const owner = emscriptenJobOwner({ runId, agentId });
  const ref = validateWasmStreamRef(outputRef, { kinds: ["stdout"] });
  const { stdoutFile, directory } = await openWasmStreamHandles({ ref, owner, allowUnsealedOutput: true, storage });
  const writer = await exclusiveWriter(stdoutFile, directory);
  let state = "open";
  let pending = Promise.resolve();
  let queued = 0;
  let sequence = 0;
  let bytes = 0;
  let firstFailure = null;

  const unknown = async (reason) => {
    if (state === "unknown") return Object.freeze({ ok: false, state, reason });
    state = "unknown";
    try { await writer.abort?.(); } catch { /* preserve the original failure */ }
    if (recordUnknown !== undefined) {
      if (typeof recordUnknown !== "function") fail("emscripten_writer_evidence_unavailable");
      try { await recordUnknown(reason); }
      catch (cause) { fail("emscripten_writer_evidence_unavailable", cause); }
    }
    return Object.freeze({ ok: false, state, reason });
  };

  return Object.freeze({
    get state() { return state; },
    async push({ seq, chunk } = {}) {
      if (state === "draining") {
        await unknown("writer_fence_unavailable");
        fail("emscripten_writer_not_open");
      }
      if (state !== "open" || firstFailure) fail("emscripten_writer_not_open");
      if (!Number.isSafeInteger(seq) || seq !== sequence || !(chunk instanceof Uint8Array) ||
          chunk.byteLength > FRAME_BYTES || queued >= MAX_PENDING_FRAMES) {
        await unknown("writer_fence_unavailable");
        fail("emscripten_writer_frame_invalid");
      }
      sequence += 1;
      queued += 1;
      const copy = chunk.slice();
      const write = pending.then(async () => {
        if (state !== "open" && state !== "draining") fail("emscripten_writer_not_open");
        await writer.write(copy);
        bytes += copy.byteLength;
      });
      pending = write.catch((error) => { firstFailure ??= error; }).finally(() => { queued -= 1; });
      try { await write; }
      catch (cause) {
        await unknown("writer_fence_unavailable");
        fail("emscripten_writer_write_failed", cause);
      }
      return Object.freeze({ ok: true, seq });
    },
    async close() {
      if (state !== "open") fail("emscripten_writer_not_open");
      state = "draining"; // terminal channel fence: reject all later push calls.
      await pending;
      if (state !== "draining") fail("emscripten_writer_not_open");
      if (firstFailure) {
        await unknown("writer_fence_unavailable");
        fail("emscripten_writer_write_failed", firstFailure);
      }
      try { await writer.close(); }
      catch (cause) {
        await unknown("writer_fence_unavailable");
        fail("emscripten_writer_close_failed", cause);
      }
      if (state !== "draining") fail("emscripten_writer_not_open");
      // Probe again AFTER close: a different file holder would deny this open.
      // Failure is UNKNOWN. Never infer a fence from terminate() or a message.
      try {
        const probe = await exclusiveWriter(stdoutFile, directory);
        await probe.abort();
      } catch (cause) {
        await unknown("writer_fence_unavailable");
        fail("emscripten_writer_exclusivity_unavailable", cause);
      }
      if (state !== "draining") fail("emscripten_writer_not_open");
      // The file is visible only AFTER the writable's close has returned.
      // A second independent File snapshot/re-read verifies every committed byte.
      try {
        const file = await stdoutFile.getFile();
        if (file.size !== bytes) fail("emscripten_writer_verification_failed");
        const hash = createIncrementalSha256();
        for (let offset = 0; offset < bytes; offset += READ_BYTES) {
          const end = Math.min(offset + READ_BYTES, bytes);
          const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
          if (chunk.byteLength !== end - offset) fail("emscripten_writer_verification_failed");
          hash.update(chunk);
        }
        if (state !== "draining") fail("emscripten_writer_not_open");
        state = "closed";
        return Object.freeze({ ok: true, state, writerFence: "exclusive", frames: sequence, bytes, sha256: hash.hex() });
      } catch (cause) {
        await unknown("writer_fence_unavailable");
        fail("emscripten_writer_verification_failed", cause);
      }
    },
    async abort(reason = "worker_termination_unproved") {
      if (state === "closed") fail("emscripten_writer_already_closed");
      return await unknown(reason);
    },
  });
}

/** Trusted offscreen composition: durably begin before opening the writer and
 * persist the positive close receipt only after the host's own drain, close and
 * independent re-read. A failed append never returns a successful receipt. */
export async function openAuditedHostOwnedEmscriptenWriter({ identity, storage, evidence = createEmscriptenHostEvidence({ storage }) } = {}) {
  if (!identity || typeof identity !== "object" || typeof evidence?.begin !== "function" ||
      typeof evidence?.recordUnknown !== "function" || typeof evidence?.recordClosed !== "function") {
    fail("emscripten_writer_evidence_unavailable");
  }
  await evidence.begin(identity);
  let channel;
  try {
    channel = await openHostOwnedEmscriptenWriter({
      runId: identity.runId, agentId: identity.agentId, outputRef: identity.outputRef, storage,
      recordUnknown: (reason) => evidence.recordUnknown(identity, reason),
    });
  } catch (cause) {
    await evidence.recordUnknown(identity, "writer_fence_unavailable");
    throw cause;
  }
  return Object.freeze({
    get state() { return channel.state; },
    push: (frame) => channel.push(frame),
    abort: (reason) => channel.abort(reason),
    async close() {
      const proof = await channel.close();
      await evidence.recordClosed(identity, proof);
      return Object.freeze({ ...proof, evidenceState: "closed" });
    },
  });
}
