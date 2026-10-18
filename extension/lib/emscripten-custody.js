// ltkj.4.3 — preparatory, run-owned Emscripten stream custody.
// This module is NOT connected to the model/offscreen wire. Binary operations
// remain refused until durable audit, worker isolation and live publication land.
import { validExecutionId } from "./durable-runs.js";
import { createIncrementalSha256 } from "./incremental-sha256.js";
import {
  createWasmStreamOutput,
  discardWasmStream,
  openWasmStreamHandles,
  readWasmStreamReceipt,
  sealWasmStreamOutput,
  validateSealedWasmStream,
  validateWasmStreamRef,
} from "./wasm-stream-files.js";

const CHUNK_BYTES = 64 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,256}$/u;
const PROVENANCE_KEYS = ["graphDigest", "operationId", "packageId", "version"];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function emscriptenJobOwner({ runId, agentId } = {}) {
  if (!validExecutionId(runId) || typeof agentId !== "string" || !AGENT_RE.test(agentId)) {
    fail("emscripten_custody_invalid_identity");
  }
  return `agent:${runId}:${agentId}`;
}

function receiptFor({ runId, agentId, bytes, sha256, provenance }) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || typeof sha256 !== "string" || !SHA256_RE.test(sha256) ||
      !provenance || Object.getPrototypeOf(provenance) !== Object.prototype ||
      JSON.stringify(Object.keys(provenance).sort()) !== JSON.stringify(PROVENANCE_KEYS) ||
      !PROVENANCE_KEYS.every((key) => typeof provenance[key] === "string" &&
        provenance[key].length > 0 && provenance[key].length <= 256) || !SHA256_RE.test(provenance.graphDigest)) {
    fail("emscripten_custody_receipt_invalid");
  }
  return Object.freeze({ ...provenance, runId, agentId, bytes, sha256 });
}

/** Input is a sealed, read-only Blob snapshot. Only the two output FILE handles
 * reach a future job; the OPFS root, directory and owner authority do not. */
export async function allocateEmscriptenJobStreams(options = {}) {
  if (!options || typeof options !== "object" || Object.hasOwn(options, "owner")) {
    fail("emscripten_custody_invalid_identity");
  }
  const { runId, agentId, inputRef, storage } = options;
  const owner = emscriptenJobOwner({ runId, agentId });
  const input = validateWasmStreamRef(inputRef, { kinds: ["input"] });
  const openedInput = await openWasmStreamHandles({ ref: input, owner, storage });
  const inputFile = await openedInput.inputFile.getFile();
  let outputRef;
  try {
    outputRef = await createWasmStreamOutput({ owner, storage });
    const { stdoutFile, stderrFile } = await openWasmStreamHandles({
      ref: outputRef, owner, allowUnsealedOutput: true, storage,
    });
    return Object.freeze({ owner, inputRef: input, outputRef, handles: Object.freeze({ inputFile, stdoutFile, stderrFile }) });
  } catch (error) {
    if (outputRef) await discardWasmStream({ ref: outputRef, owner, storage }).catch(() => {});
    throw error;
  }
}

/** Re-open and independently hash the sealed file in bounded chunks. Neither
 * the caller's digest nor a mutable File/handle is trusted as verification. */
export async function verifyEmscriptenOutputSeal({ runId, agentId, outputRef, storage } = {}) {
  const owner = emscriptenJobOwner({ runId, agentId });
  const ref = validateWasmStreamRef(outputRef, { kinds: ["stdout"] });
  let validated;
  try {
    validated = await validateSealedWasmStream({ ref, owner, storage });
  } catch (error) {
    if (error?.code === "wasm_stream_size_drift") {
      await discardWasmStream({ ref, owner, storage }).catch(() => {});
      fail("emscripten_output_verification_failed");
    }
    throw error; // foreign/unsealed refs never trigger deletion
  }
  try {
    const { receipt } = await readWasmStreamReceipt({ ref, owner, storage });
    if (!receipt || Object.getPrototypeOf(receipt) !== Object.prototype ||
        JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([
          ...PROVENANCE_KEYS, "runId", "agentId", "bytes", "sha256",
        ].sort()) || receipt.runId !== runId || receipt.agentId !== agentId ||
        receipt.bytes !== validated.bytes || !SHA256_RE.test(receipt.sha256) ||
        !SHA256_RE.test(receipt.graphDigest)) fail("emscripten_output_verification_failed");
    const file = await (await validated.directory.getFileHandle(validated.fileName)).getFile();
    const hash = createIncrementalSha256();
    for (let offset = 0; offset < validated.bytes; offset += CHUNK_BYTES) {
      const end = Math.min(offset + CHUNK_BYTES, validated.bytes);
      const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      if (chunk.byteLength !== end - offset) fail("emscripten_output_verification_failed");
      hash.update(chunk);
    }
    if (hash.hex() !== receipt.sha256) fail("emscripten_output_verification_failed");
    return Object.freeze({ ok: true, ref, bytes: validated.bytes, sha256: receipt.sha256, receipt: Object.freeze(receipt) });
  } catch (error) {
    await discardWasmStream({ ref, owner, storage }).catch(() => {});
    if (error?.code === "emscripten_output_verification_failed") throw error;
    fail("emscripten_output_verification_failed");
  }
}

/** Seal cannot succeed unless the independent re-read matches the job receipt. */
export async function sealEmscriptenOutput({ runId, agentId, outputRef, bytes, sha256, provenance, storage } = {}) {
  const owner = emscriptenJobOwner({ runId, agentId });
  const receipt = receiptFor({ runId, agentId, bytes, sha256, provenance });
  await sealWasmStreamOutput({ ref: outputRef, owner, bytes, receipt, storage });
  return await verifyEmscriptenOutputSeal({ runId, agentId, outputRef, storage });
}

/** Cleanup is constrained to one output owned by this exact run and agent. */
export async function discardEmscriptenJobOutput({ runId, agentId, outputRef, storage } = {}) {
  const owner = emscriptenJobOwner({ runId, agentId });
  return await discardWasmStream({ ref: validateWasmStreamRef(outputRef, { kinds: ["stdout"] }), owner, storage });
}
