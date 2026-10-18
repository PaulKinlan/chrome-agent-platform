// x9r8k: SW-issued, staging-only intent outside compactable run logs.
// This is an audit record, never an output/publish/delete capability.
import { validExecutionId } from "./durable-runs.js";
import { emscriptenJobOwner } from "./emscripten-custody.js";
import { validateWasmStreamRef } from "./wasm-stream-files.js";

export const EMSCRIPTEN_SW_INTENT_ROOT = "emscripten-sw-intent-v1";
const HEX32 = /^[0-9a-f]{32}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const IDENTITY_KEYS = ["runId", "agentId", "outputRef", "generation", "packageId", "graphDigest", "operationId"];
const RECORD_KEYS = ["version", "state", "identity", "inputRef", "stagingOnly", "nonpromotable"];
const activeByStorage = new WeakMap();

function fail(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}
function exact(value, keys) {
  return Boolean(value && Object.getPrototypeOf(value) === Object.prototype &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function recordFor(raw) {
  if (!exact(raw, ["identity", "inputRef"]) || !exact(raw.identity, IDENTITY_KEYS) ||
      !validExecutionId(raw.identity.runId) || !HEX32.test(raw.identity.generation) ||
      !NAME.test(raw.identity.packageId) || !HEX64.test(raw.identity.graphDigest) ||
      !NAME.test(raw.identity.operationId)) fail("emscripten_sw_intent_identity");
  const identity = raw.identity;
  const owner = emscriptenJobOwner({ runId: identity.runId, agentId: identity.agentId });
  return {
    version: 1, state: "pending",
    identity: {
      runId: identity.runId, agentId: identity.agentId, owner,
      outputRef: validateWasmStreamRef(identity.outputRef, { kinds: ["stdout"] }),
      generation: identity.generation, packageId: identity.packageId,
      graphDigest: identity.graphDigest, operationId: identity.operationId,
    },
    inputRef: validateWasmStreamRef(raw.inputRef, { kinds: ["input"] }),
    stagingOnly: true, nonpromotable: true,
  };
}
async function directoryFor(storage, refId, create) {
  if (typeof storage?.getDirectory !== "function") fail("emscripten_sw_intent_unavailable");
  try {
    const root = await storage.getDirectory();
    const intents = await root.getDirectoryHandle(EMSCRIPTEN_SW_INTENT_ROOT, { create });
    // One reservation per output ref (NOT per generation): a new generation
    // cannot silently recycle an old staging file and its irrevocable intent.
    try { return { directory: await intents.getDirectoryHandle(refId), existed: true }; }
    catch (cause) {
      if (!create || cause?.name !== "NotFoundError") throw cause;
      return { directory: await intents.getDirectoryHandle(refId, { create: true }), existed: false };
    }
  } catch (cause) { fail("emscripten_sw_intent_unavailable", cause); }
}
async function load(directory) {
  let file;
  try { file = await directory.getFileHandle("intent.json"); }
  catch (cause) {
    if (cause?.name === "NotFoundError") return null;
    fail("emscripten_sw_intent_unavailable", cause);
  }
  try { return JSON.parse(await (await file.getFile()).text()); }
  catch (cause) { fail("emscripten_sw_intent_unavailable", cause); }
}
function checked(actual, expected) {
  if (!exact(actual, RECORD_KEYS) || actual.version !== 1 || actual.state !== "pending" ||
      actual.stagingOnly !== true || actual.nonpromotable !== true ||
      !exact(actual.identity, [...IDENTITY_KEYS, "owner"]) ||
      !same(actual.identity, expected.identity) || !same(actual.inputRef, expected.inputRef)) {
    fail("emscripten_sw_intent_collision");
  }
  return Object.freeze(actual);
}

/** Trusted SW calls begin from the stream allocator's beforeCreate hook.
 * No output directory is opened unless its distinct, verified intent is durable.
 * A duplicate begin is NEVER an idempotent execution grant. */
export function createEmscriptenSwIntent({ storage = globalThis.navigator?.storage } = {}) {
  if (!storage || typeof storage !== "object" || typeof storage.getDirectory !== "function") {
    fail("emscripten_sw_intent_unavailable");
  }
  return Object.freeze({
    async begin(raw) {
      const expected = recordFor(raw);
      const refId = expected.identity.outputRef.id;
      let active = activeByStorage.get(storage);
      if (!active) { active = new Set(); activeByStorage.set(storage, active); }
      if (active.has(refId)) fail("emscripten_sw_intent_replay");
      active.add(refId);
      try {
        const { directory, existed } = await directoryFor(storage, refId, true);
        if (existed) {
          const present = await load(directory);
          if (present === null) fail("emscripten_sw_intent_unavailable");
          checked(present, expected);
          fail("emscripten_sw_intent_replay");
        }
        try {
          const handle = await directory.getFileHandle("intent.json", { create: true });
          const writer = await handle.createWritable({ mode: "exclusive" });
          try { await writer.write(JSON.stringify(expected)); await writer.close(); }
          catch (cause) { await writer.abort?.().catch(() => {}); throw cause; }
        } catch (cause) { fail("emscripten_sw_intent_unavailable", cause); }
        return checked(await load(directory), expected);
      } finally { active.delete(refId); }
    },
    async read(raw) {
      const expected = recordFor(raw);
      const { directory } = await directoryFor(storage, expected.identity.outputRef.id, false);
      const stored = await load(directory);
      if (stored === null) fail("emscripten_sw_intent_unavailable");
      return checked(stored, expected);
    },
  });
}
