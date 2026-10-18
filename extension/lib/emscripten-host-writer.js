// Host-realm-only, retained Emscripten output writer. Never import this from the
// job Worker: it receives bytes over postMessage, NOT an OPFS handle or ref.
// Binary execution remains refused until SW/host audit and publication land.
import { emscriptenJobOwner } from "./emscripten-custody.js";
import { createIncrementalSha256 } from "./incremental-sha256.js";
import { openWasmStreamHandles, validateWasmStreamRef } from "./wasm-stream-files.js";

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
async function exclusiveWriter(handle) {
  let primary;
  try {
    primary = await handle.createWritable({ mode: "exclusive" });
    let secondary;
    try { secondary = await handle.createWritable({ mode: "exclusive" }); }
    catch (error) {
      if (error?.name === "NoModificationAllowedError") return primary;
      throw error;
    }
    await secondary.abort?.().catch(() => {});
    fail("emscripten_writer_exclusivity_unavailable");
  } catch (error) {
    await primary?.abort?.().catch(() => {});
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
  const { stdoutFile } = await openWasmStreamHandles({ ref, owner, allowUnsealedOutput: true, storage });
  const writer = await exclusiveWriter(stdoutFile);
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
      if (firstFailure) {
        await unknown("writer_fence_unavailable");
        fail("emscripten_writer_write_failed", firstFailure);
      }
      try { await writer.close(); }
      catch (cause) {
        await unknown("writer_fence_unavailable");
        fail("emscripten_writer_close_failed", cause);
      }
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
