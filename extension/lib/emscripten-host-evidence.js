// Host-owned, fail-closed Emscripten lifecycle evidence (xoeaa slice).
// Separate from compactable SW run logs and from job-writable stream dirs.
// No positive no-writers receipt exists yet: terminate(), timeout and a worker
// message can only yield UNKNOWN until a reviewed writer/close fence exists.
import { validExecutionId } from "./durable-runs.js";
import { emscriptenJobOwner } from "./emscripten-custody.js";
import { validateWasmStreamRef } from "./wasm-stream-files.js";

export const EMSCRIPTEN_HOST_EVIDENCE_ROOT = "emscripten-host-evidence-v1";
const HEX32 = /^[0-9a-f]{32}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const REASONS = new Set(["worker_termination_unproved", "worker_error", "deadline", "writer_fence_unavailable"]);

function fail(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function identityFor(raw) {
  if (!exact(raw, ["runId", "agentId", "outputRef", "generation", "packageId", "graphDigest", "operationId"]) ||
      !validExecutionId(raw.runId) || !HEX32.test(raw.generation) ||
      !NAME.test(raw.packageId) || !HEX64.test(raw.graphDigest) || !NAME.test(raw.operationId)) {
    fail("emscripten_host_evidence_identity");
  }
  const owner = emscriptenJobOwner({ runId: raw.runId, agentId: raw.agentId });
  const outputRef = validateWasmStreamRef(raw.outputRef, { kinds: ["stdout"] });
  return Object.freeze({
    runId: raw.runId, agentId: raw.agentId, owner, outputRef,
    generation: raw.generation, packageId: raw.packageId,
    graphDigest: raw.graphDigest, operationId: raw.operationId,
  });
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function rootFor(storage) {
  if (typeof storage?.getDirectory !== "function") fail("emscripten_host_evidence_unavailable");
  try {
    return await (await storage.getDirectory()).getDirectoryHandle(EMSCRIPTEN_HOST_EVIDENCE_ROOT, { create: true });
  } catch (cause) { fail("emscripten_host_evidence_unavailable", cause); }
}

async function load(directory, name) {
  let file;
  try { file = await directory.getFileHandle(name); }
  catch (cause) {
    if (cause?.name === "NotFoundError") return null;
    fail("emscripten_host_evidence_unavailable", cause);
  }
  try { return JSON.parse(await (await file.getFile()).text()); }
  catch (cause) { fail("emscripten_host_evidence_unavailable", cause); }
}

async function writeVerified(directory, name, record) {
  let handle;
  try {
    handle = await directory.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    try {
      await writer.write(JSON.stringify(record));
      await writer.close();
    } catch (cause) {
      await writer.abort?.().catch(() => {});
      throw cause;
    }
    if (!same(await load(directory, name), record)) fail("emscripten_host_evidence_unavailable");
  } catch (cause) { fail("emscripten_host_evidence_unavailable", cause); }
}

/** Caller is the trusted offscreen host, never the job Worker. This creates a
 * pending record before native construction. The host incarnation is generated
 * here, not accepted from a worker result or an extension message. */
export function createEmscriptenHostEvidence({ storage = globalThis.navigator?.storage } = {}) {
  const incarnation = crypto.randomUUID();
  const entry = async (raw, create = false) => {
    const identity = identityFor(raw);
    const root = await rootFor(storage);
    let directory;
    try { directory = await root.getDirectoryHandle(`${identity.outputRef.id}-${identity.generation}`, { create }); }
    catch (cause) { fail("emscripten_host_evidence_unavailable", cause); }
    return { identity, directory };
  };
  return Object.freeze({
    incarnation,
    async begin(raw) {
      const { identity, directory } = await entry(raw, true);
      // An UNKNOWN is terminal for this exact ref/generation. A duplicate
      // begin must never re-open native construction after an unproved stop.
      if (await load(directory, "unknown.json") !== null) fail("emscripten_host_evidence_unknown");
      const present = await load(directory, "pending.json");
      if (present !== null) {
        if (!exact(present, ["version", "state", "identity", "hostIncarnation"]) ||
            present.version !== 1 || present.state !== "pending" ||
            !same(present.identity, identity) || present.hostIncarnation !== incarnation) {
          fail("emscripten_host_evidence_collision");
        }
        return Object.freeze(present);
      }
      const record = { version: 1, state: "pending", identity, hostIncarnation: incarnation };
      await writeVerified(directory, "pending.json", record);
      return Object.freeze(record);
    },
    async recordUnknown(raw, reason) {
      if (!REASONS.has(reason)) fail("emscripten_host_evidence_reason");
      const { identity, directory } = await entry(raw);
      const pending = await load(directory, "pending.json");
      if (!exact(pending, ["version", "state", "identity", "hostIncarnation"]) ||
          pending.version !== 1 || pending.state !== "pending" ||
          !same(pending.identity, identity) || pending.hostIncarnation !== incarnation) {
        fail("emscripten_host_evidence_collision");
      }
      const record = { version: 1, state: "unknown", identity, hostIncarnation: incarnation, reason };
      const present = await load(directory, "unknown.json");
      if (present !== null) {
        if (!same(present, record)) fail("emscripten_host_evidence_collision");
        return Object.freeze(present);
      }
      await writeVerified(directory, "unknown.json", record);
      return Object.freeze(record);
    },
    async read(raw) {
      const { identity, directory } = await entry(raw);
      const pending = await load(directory, "pending.json");
      if (!exact(pending, ["version", "state", "identity", "hostIncarnation"]) ||
          pending.version !== 1 || pending.state !== "pending" || !same(pending.identity, identity)) {
        fail("emscripten_host_evidence_unavailable");
      }
      const unknown = await load(directory, "unknown.json");
      if (unknown !== null && (!exact(unknown, ["version", "state", "identity", "hostIncarnation", "reason"]) ||
          unknown.version !== 1 || unknown.state !== "unknown" || !same(unknown.identity, identity) ||
          unknown.hostIncarnation !== pending.hostIncarnation || !REASONS.has(unknown.reason))) {
        fail("emscripten_host_evidence_unavailable");
      }
      return Object.freeze(unknown ?? { version: 1, state: "unknown", identity,
        hostIncarnation: pending.hostIncarnation, reason: "writer_fence_unavailable" });
    },
  });
}
