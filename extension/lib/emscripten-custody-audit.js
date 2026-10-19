// Preparatory SW-owned custody audit. No model/offscreen entry imports this yet:
// the binary operation guard stays closed until a separate staging root and
// publication protocol have been reviewed. These rows are NOT deletion proof:
// durable run logs may be compacted by retention policy.
import {
  allocateEmscriptenJobStreams,
  discardEmscriptenJobOutput,
  emscriptenJobOwner,
  verifyEmscriptenOutputSeal,
} from "./emscripten-custody.js";
import { validateWasmStreamRef } from "./wasm-stream-files.js";

function fail(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

/** Build the only audit adapter intended for the service worker. The injected
 * run registry owns its on-disk WAL; a missing/compacted row is a hard refusal,
 * never inferred from the untrusted worker or from stream metadata. */
export function emscriptenRunAuditAuthority({ registry, isLive, isTerminated } = {}) {
  if (typeof registry?.appendLog !== "function" || typeof registry?.listLogs !== "function" ||
      typeof isLive !== "function" || typeof isTerminated !== "function") fail("emscripten_custody_audit_unavailable");
  return Object.freeze({
    append: (runId, row, key) => registry.appendLog(runId, row, key),
    readIntent: async (runId, key) => {
      const rows = await registry.listLogs(runId);
      return rows.find((row) => row?.idempotencyKey === key && row?.type === "emscripten-custody-intent") ?? null;
    },
    isLive, isTerminated,
  });
}

function requireAudit(append, isLive) {
  if (typeof append !== "function" || typeof isLive !== "function") fail("emscripten_custody_audit_unavailable");
}

const REGISTRY_ROW_KEYS = new Set(["schemaVersion", "retentionPolicyVersion", "executionId", "at", "idempotencyKey"]);
function sameRow(actual, expected) {
  // appendLog stamps only registry-owned bookkeeping onto the complete custody
  // row (also on a replay). An unknown persisted field is not an exact match.
  if (!actual || typeof actual !== "object" || Array.isArray(actual) ||
      Object.getPrototypeOf(actual) !== Object.prototype) return false;
  return Object.keys(actual).every((key) => Object.hasOwn(expected, key) || REGISTRY_ROW_KEYS.has(key)) &&
    Object.keys(expected).every((key) => Object.hasOwn(actual, key) &&
      JSON.stringify(actual[key]) === JSON.stringify(expected[key]));
}

async function appendExact({ append, row, key }) {
  let persisted;
  try { persisted = await append(row.runId, row, key); }
  catch (error) { fail("emscripten_custody_audit_unavailable", error); }
  if (!sameRow(persisted, row)) fail("emscripten_custody_audit_mismatch");
  return persisted;
}

/** Reserve a stream id and durably append an exact, staging-only intent BEFORE
 * the shared stream root is even opened. The trusted SW supplies appendLog and
 * liveness; these capabilities must never be forwarded to a native worker. */
export async function allocateAuditedEmscriptenJobStreams({
  runId, agentId, inputRef, storage, append, isLive,
} = {}) {
  requireAudit(append, isLive);
  const owner = emscriptenJobOwner({ runId, agentId });
  const input = validateWasmStreamRef(inputRef, { kinds: ["input"] });
  if (!(await isLive())) fail("emscripten_run_not_live");
  return await allocateEmscriptenJobStreams({
    runId, agentId, inputRef: input, storage,
    beforeCreate: async (outputRef) => {
      if (!(await isLive())) fail("emscripten_run_not_live");
      const row = {
        type: "emscripten-custody-intent", custodyVersion: 1,
        runId, agentId, owner, inputRef: input, outputRef,
        stagingOnly: true, nonpromotable: true,
      };
      await appendExact({ append, row, key: `emscripten-intent:${runId}:${outputRef.id}` });
      // Cancellation during the append fences creation. The orphan intent is
      // intentionally retained for reconciliation, not treated as an output.
      if (!(await isLive())) fail("emscripten_run_not_live");
    },
  });
}

/** Terminal audit is independent of worker self-report. A trusted SW callback
 * proves termination AND release of every output handle; only then do we hash
 * sealed bytes again. This returns audit evidence, never a publishable ref. */
export async function recordEmscriptenTerminalAudit({
  runId, agentId, inputRef, outputRef, storage, append, readIntent, isLive, isTerminated,
} = {}) {
  requireAudit(append, isLive);
  if (typeof isTerminated !== "function" || typeof readIntent !== "function") fail("emscripten_custody_audit_unavailable");
  const owner = emscriptenJobOwner({ runId, agentId });
  const input = validateWasmStreamRef(inputRef, { kinds: ["input"] });
  const output = validateWasmStreamRef(outputRef, { kinds: ["stdout"] });
  // A dead/unknown worker is NEVER assumed terminated just because its SW
  // boot was replaced. No destructive cleanup occurs without this proof.
  if (!(await isTerminated())) fail("emscripten_worker_not_fenced");
  if (!(await isLive())) fail("emscripten_run_not_live");
  let intent;
  try { intent = await readIntent(runId, `emscripten-intent:${runId}:${output.id}`); }
  catch (error) { fail("emscripten_custody_audit_unavailable", error); }
  if (!sameRow(intent, {
    type: "emscripten-custody-intent", custodyVersion: 1,
    runId, agentId, owner, inputRef: input, outputRef: output,
    stagingOnly: true, nonpromotable: true,
  })) fail("emscripten_custody_audit_mismatch");
  const verified = await verifyEmscriptenOutputSeal({ runId, agentId, outputRef: output, storage });
  if (!(await isTerminated())) fail("emscripten_worker_not_fenced");
  if (!(await isLive())) fail("emscripten_run_not_live");
  const row = {
    type: "emscripten-custody-terminal", custodyVersion: 1,
    runId, agentId, owner, inputRef: input, outputRef: output,
    bytes: verified.bytes, sha256: verified.sha256,
    receipt: verified.receipt, workerTerminated: true,
  };
  await appendExact({ append, row, key: `emscripten-terminal:${runId}:${output.id}` });
  if (!(await isTerminated())) fail("emscripten_worker_not_fenced");
  if (!(await isLive())) fail("emscripten_run_not_live");
  return Object.freeze({ ok: true, audited: true, bytes: verified.bytes, sha256: verified.sha256 });
}

/** Only metadata-proved unpromoted output is discardable; corrupt metadata is
 * quarantined by refusal (9a1wj), never removed by id alone. */
export async function discardFencedEmscriptenOutput({ runId, agentId, outputRef, storage, isTerminated } = {}) {
  if (typeof isTerminated !== "function" || !(await isTerminated())) fail("emscripten_worker_not_fenced");
  return await discardEmscriptenJobOutput({ runId, agentId, outputRef, storage });
}
