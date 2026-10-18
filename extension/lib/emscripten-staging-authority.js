// x9r8k: SW-only inspection of staging facts. NEVER a publish/seal/delete path.
// A matching host CLOSED proves writer bytes, not literal Worker termination.
import { emscriptenJobOwner } from "./emscripten-custody.js";
import { EMSCRIPTEN_HOST_EVIDENCE_ROOT } from "./emscripten-host-evidence.js";
import { createIncrementalSha256 } from "./incremental-sha256.js";

const STREAM_ROOT = "wasm-tool-streams-v1";
const READ_BYTES = 64 * 1024;
const HEX64 = /^[0-9a-f]{64}$/u;
const PROOF_KEYS = ["ok", "state", "writerFence", "frames", "bytes", "sha256"];
const LEDGER_KEYS = ["version", "root", "id", "hostIncarnation"];
const IDENTITY_KEYS = ["runId", "agentId", "owner", "outputRef", "generation", "packageId", "graphDigest", "operationId"];

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
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function independentlyReadStagedBytes(storage, identity, expected) {
  try {
    const root = await storage.getDirectory();
    const streams = await root.getDirectoryHandle(STREAM_ROOT);
    const directory = await streams.getDirectoryHandle(identity.outputRef.id);
    const authority = JSON.parse(await (await (await directory.getFileHandle("authority.json")).getFile()).text());
    if (!exact(authority, ["version", "id", "type", "owner", "sealed", "bytes", "createdAt"]) ||
        authority.version !== 1 || authority.id !== identity.outputRef.id ||
        authority.type !== "output" || authority.owner !== identity.owner ||
        authority.sealed !== false || authority.bytes !== 0 ||
        !Number.isSafeInteger(authority.createdAt) || authority.createdAt < 0) {
      fail("emscripten_staging_bytes_unavailable");
    }
    const file = await (await directory.getFileHandle("stdout.bin")).getFile();
    if (file.size !== expected.bytes) fail("emscripten_staging_bytes_mismatch");
    const hash = createIncrementalSha256();
    for (let offset = 0; offset < file.size; offset += READ_BYTES) {
      const end = Math.min(file.size, offset + READ_BYTES);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      if (bytes.length !== end - offset) fail("emscripten_staging_bytes_unavailable");
      hash.update(bytes);
    }
    if (hash.hex() !== expected.sha256) fail("emscripten_staging_bytes_mismatch");
  } catch (cause) {
    if (cause?.code === "emscripten_staging_bytes_mismatch") throw cause;
    fail("emscripten_staging_bytes_unavailable", cause);
  }
}

/** The trusted SW supplies its own identity, live-run closure and independent
 * OPFS readers. The host callback proof is a locator only: all receipt facts
 * are checked again from distinct intent, host-ledger and staging-file roots.
 * Even complete agreement returns typed UNKNOWN: no literal Worker join exists. */
export async function verifyStagedEmscriptenRun({ identity, inputRef, hostProof, intent,
  evidence, storage, isLive } = {}) {
  if (typeof isLive !== "function" || typeof intent?.read !== "function" ||
      typeof evidence?.read !== "function" || typeof storage?.getDirectory !== "function") {
    fail("emscripten_staging_unavailable");
  }
  if (!isLive()) fail("emscripten_run_not_live");
  let swRecord;
  try { swRecord = await intent.read({ identity, inputRef }); }
  catch (cause) { fail("emscripten_staging_intent_unavailable", cause); }
  const expectedOwner = emscriptenJobOwner({ runId: identity?.runId, agentId: identity?.agentId });
  if (!exact(swRecord, ["version", "state", "identity", "inputRef", "stagingOnly", "nonpromotable"]) ||
      swRecord.version !== 1 || swRecord.state !== "pending" ||
      swRecord.stagingOnly !== true || swRecord.nonpromotable !== true ||
      !exact(swRecord.identity, IDENTITY_KEYS) || swRecord.identity.owner !== expectedOwner ||
      !same(swRecord.identity?.outputRef, identity?.outputRef) ||
      !["runId", "agentId", "generation", "packageId", "graphDigest", "operationId"].every(
        (key) => swRecord.identity[key] === identity[key]) ||
      !same(swRecord.inputRef, inputRef)) fail("emscripten_staging_intent_unavailable");
  if (!exact(hostProof, [...PROOF_KEYS, "evidenceState", "ledgerRef"]) ||
      hostProof.ok !== true || hostProof.state !== "closed" || hostProof.evidenceState !== "closed" ||
      hostProof.writerFence !== "exclusive" || !Number.isSafeInteger(hostProof.frames) ||
      hostProof.frames < 0 || !Number.isSafeInteger(hostProof.bytes) || hostProof.bytes < 0 ||
      !HEX64.test(hostProof.sha256) || !exact(hostProof.ledgerRef, LEDGER_KEYS) ||
      hostProof.ledgerRef.version !== 1 || hostProof.ledgerRef.root !== EMSCRIPTEN_HOST_EVIDENCE_ROOT ||
      hostProof.ledgerRef.id !== `${identity.outputRef.id}-${identity.generation}`) {
    fail("emscripten_staging_evidence_mismatch");
  }
  let hostRecord;
  try { hostRecord = await evidence.read(identity); }
  catch (cause) { fail("emscripten_staging_evidence_unavailable", cause); }
  if (!exact(hostRecord, ["version", "state", "identity", "hostIncarnation", "proof"]) ||
      hostRecord.version !== 1 || hostRecord.state !== "closed" ||
      !exact(hostRecord.identity, IDENTITY_KEYS) || !exact(hostRecord.proof, PROOF_KEYS)) {
    fail("emscripten_staging_evidence_unavailable");
  }
  if (hostRecord.hostIncarnation !== hostProof.ledgerRef.hostIncarnation ||
      !same(hostRecord.identity, swRecord.identity) ||
      !same(hostRecord.proof, Object.fromEntries(PROOF_KEYS.map((key) => [key, hostProof[key]])))) {
    fail("emscripten_staging_evidence_mismatch");
  }
  await independentlyReadStagedBytes(storage, swRecord.identity, hostProof);
  // A SW restart or cancellation cannot inherit a host receipt as authority.
  if (!isLive()) fail("emscripten_run_not_live");
  return Object.freeze({ ok: false, phase: "unknown", error: "emscripten_worker_termination_unproved" });
}
