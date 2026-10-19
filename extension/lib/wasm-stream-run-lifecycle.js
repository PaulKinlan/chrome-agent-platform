// Run-scoped custody for model-created OPFS tool outputs.
// References stay available for chaining during the run and are discarded when
// that exact run settles. Promoted references fail closed in discardWasmStream
// and therefore retain their artifact-owned lifetime.

import { discardWasmStream, validateWasmStreamRef } from "./wasm-stream-files.js";
import { decodeModelStreamOwner } from "./wasm-stream-owner-codec.js";

const outputsByRun = new Map();

function runKey(runId) {
  if (typeof runId !== "string" || !runId || runId.length > 256) {
    const error = new Error("wasm_stream_run");
    error.code = "wasm_stream_run";
    throw error;
  }
  return runId;
}

export function retainRunWasmStreamOutput(runId, { ref, owner } = {}) {
  const key = runKey(runId);
  const output = validateWasmStreamRef(ref, { kinds: ["stdout"] });
  // ko4h6: exact decoded runId equality only. A legacy or foreign owner —
  // including one whose run id merely has this run id as a prefix — decodes
  // to a different tuple (or nothing) and is refused, never inferred.
  if (decodeModelStreamOwner(owner)?.runId !== key) {
    const error = new Error("wasm_stream_owner");
    error.code = "wasm_stream_owner";
    throw error;
  }
  const records = outputsByRun.get(key) ?? new Map();
  records.set(output.id, Object.freeze({ ref: output, owner }));
  outputsByRun.set(key, records);
  return output;
}

export async function releaseRunWasmStreamOutputs(runId, { storage } = {}) {
  const key = runKey(runId);
  const records = outputsByRun.get(key);
  outputsByRun.delete(key);
  if (!records) return Object.freeze({ released: 0, preserved: 0, failed: 0 });

  let released = 0;
  let preserved = 0;
  let failed = 0;
  for (const record of records.values()) {
    // Retained records were admitted under this exact run; re-prove it before
    // any deletion so a corrupted record can never discard a foreign stream.
    if (decodeModelStreamOwner(record.owner)?.runId !== key) { failed += 1; continue; }
    try {
      await discardWasmStream({ ...record, storage });
      released += 1;
    } catch (error) {
      if (error?.code === "wasm_stream_promoted") preserved += 1;
      else failed += 1;
    }
  }
  return Object.freeze({ released, preserved, failed });
}
