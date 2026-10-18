// Direct trusted-module seam only; NOT registered on chrome.runtime/onMessage.
// The SW broker and offscreen request validator continue to reject binary runs.
// x9r8k must supply a verified, SW-issued job and live authority separately.
import { openAuditedHostOwnedEmscriptenWriter } from "./emscripten-host-writer.js";
import { acceptEmscriptenOutputFrame, EMSCRIPTEN_OUTPUT_FRAME_TYPE } from "./emscripten-worker-frames.js";

const JOB_KEYS = ["adapterUrl", "args", "glueUrl", "graphDigest", "operation", "operationId",
  "packageId", "sessionId", "type", "version", "wasmBytes"];
const RESULT_KEYS = ["error", "ok", "operationId", "packageId", "phase", "result",
  "sessionId", "type", "workerInstanceId"];
const OPERATION_KEYS = ["adapterId", "exportName", "id", "params", "result"];
const PARAM_KEYS = ["maximum", "minimum", "name", "type"];

function fail(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}
function exact(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

/** Called only by a future trusted host module, after its SW-issued identity,
 * asset hashes and operation have been validated. This runner has no message
 * listener, no publish/seal/delete path and no binary-guard bypass. */
export async function runAuditedHostBinaryJob({ identity, job, storage, evidence, createWorker, wallMs } = {}) {
  if (!exact(job, JOB_KEYS) || job.type !== "cap:emscripten-worker-job" ||
      !exact(job.operation, OPERATION_KEYS) || job.operation.result !== "buffer" ||
      job.operation.id !== job.operationId || typeof job.operation.adapterId !== "string" ||
      typeof job.operation.exportName !== "string" || !Array.isArray(job.operation.params) ||
      job.operation.params.length !== job.args?.length ||
      !job.operation.params.every((param) => exact(param, PARAM_KEYS) &&
        ["i32", "f64", "string"].includes(param.type) && typeof param.name === "string" &&
        Number.isFinite(param.minimum) && Number.isFinite(param.maximum) && param.minimum <= param.maximum) ||
      !(job.wasmBytes instanceof Uint8Array) || !Array.isArray(job.args) ||
      !job.args.every((value) => typeof value === "string" ||
        (typeof value === "number" && Number.isFinite(value))) ||
      typeof job.glueUrl !== "string" || typeof job.adapterUrl !== "string" ||
      job.packageId !== identity?.packageId ||
      job.operationId !== identity?.operationId || job.graphDigest !== identity?.graphDigest ||
      typeof job.sessionId !== "string" || job.sessionId.length === 0 ||
      typeof createWorker !== "function" || !Number.isSafeInteger(wallMs) || wallMs <= 0 || wallMs > 245_000) {
    fail("emscripten_host_binary_job");
  }
  const channel = await openAuditedHostOwnedEmscriptenWriter({ identity, storage, evidence });
  let worker;
  try { worker = createWorker(); }
  catch (cause) {
    await channel.abort("worker_error");
    fail("emscripten_host_binary_worker", cause);
  }
  let timer;
  let done = false;
  let events = Promise.resolve();
  const hostIdentity = { sessionId: job.sessionId, packageId: job.packageId,
    operationId: job.operationId, workerInstanceId: null };
  const stop = () => {
    clearTimeout(timer);
    try { worker.terminate(); } catch { /* no claim that terminate fences a writer */ }
  };
  try {
    const proof = await new Promise((resolve, reject) => {
      const rejectUnknown = async (reason, cause) => {
        if (done) return;
        done = true;
        stop();
        try { await channel.abort(reason); }
        catch (error) { reject(error); return; } // failed audit stays nonpublishable
        reject(cause);
      };
      // Deadline is armed before posting the job: constructors and all ACKs
      // consume the same wall-clock bound. Timeout is UNKNOWN, never CLOSED.
      timer = setTimeout(() => { void rejectUnknown("deadline", new Error("emscripten_host_binary_deadline")); }, wallMs);
      worker.onerror = (event) => {
        void rejectUnknown("worker_error", new Error(String(event?.message ?? "worker error")));
      };
      worker.onmessage = ({ data }) => {
        events = events.then(async () => {
          if (done) return;
          if (data?.type === EMSCRIPTEN_OUTPUT_FRAME_TYPE) {
            await acceptEmscriptenOutputFrame(data, hostIdentity, channel,
              (ack) => worker.postMessage(ack));
            return;
          }
          if (!exact(data, RESULT_KEYS) || data.type !== "cap:emscripten-run-result" ||
              data.sessionId !== job.sessionId || data.packageId !== job.packageId ||
              data.operationId !== job.operationId ||
              typeof data.workerInstanceId !== "string" || data.workerInstanceId.length === 0 ||
              data.workerInstanceId.length > 128 ||
              (hostIdentity.workerInstanceId !== null && data.workerInstanceId !== hostIdentity.workerInstanceId) ||
              data.ok !== true || data.phase !== "completed" || data.result !== null || data.error !== null) {
            fail("emscripten_host_binary_result");
          }
          // The worker cannot open or hold this file. Only the host-owned
          // channel closes and records evidence after all ACKed writes.
          const closed = await channel.close();
          done = true;
          stop();
          resolve(closed);
        }).catch((cause) => {
          void rejectUnknown("writer_fence_unavailable", cause);
        });
      };
      try { worker.postMessage(job, [job.wasmBytes.buffer]); }
      catch (cause) { void rejectUnknown("worker_error", cause); }
    });
    return proof;
  } finally { stop(); }
}
