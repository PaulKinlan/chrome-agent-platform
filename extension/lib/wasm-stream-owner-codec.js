// Versioned injective owner codec for model-run wasm streams (ko4h6).
//
// One shared encoding for every (runId, agentId) stream owner. Both identity
// grammars admit ':', so delimiter concatenation is ambiguous (v40vm/7wywc):
// the v2 form length-prefixes the run id and is parsed by exact index
// arithmetic — never split, startsWith, or prefix inference.
//
//   agent:v2:<runId length in UTF-16 code units>:<runId><agentId>
//
// Legacy owners ("agent:<run>:<agent>", "agent:<run>:|<agent>") do not parse:
// they are non-authoritative, are never silently recoded, and every authority
// check over them fails closed. Non-model owners (e.g. "owner-options:<doc>")
// are a different family and stay opaque to this codec.

const PREFIX = "agent:v2:";
const MAX_OWNER_BYTES = 1024;
const encoder = new TextEncoder();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

/** Encode one exact (runId, agentId) tuple as a model-stream owner string. */
export function encodeModelStreamOwner(runId, agentId) {
  if (typeof runId !== "string" || !runId || typeof agentId !== "string" || !agentId) {
    fail("wasm_stream_owner");
  }
  const owner = `${PREFIX}${runId.length}:${runId}${agentId}`;
  if (encoder.encode(owner).byteLength > MAX_OWNER_BYTES) fail("wasm_stream_owner");
  return owner;
}

/** Decode a v2 owner to its exact tuple, or null for anything else. */
export function decodeModelStreamOwner(owner) {
  if (typeof owner !== "string" || !owner.startsWith(PREFIX)) return null;
  if (encoder.encode(owner).byteLength > MAX_OWNER_BYTES) return null;
  const lengthEnd = owner.indexOf(":", PREFIX.length);
  if (lengthEnd === -1) return null;
  const lengthText = owner.slice(PREFIX.length, lengthEnd);
  if (!/^[1-9]\d*$/u.test(lengthText)) return null;
  const runLength = Number(lengthText);
  const runStart = lengthEnd + 1;
  const runEnd = runStart + runLength;
  if (runEnd >= owner.length) return null; // run id truncated or agent id empty
  const runId = owner.slice(runStart, runEnd);
  const agentId = owner.slice(runEnd);
  // Canonical form only: a re-encode must reproduce the input byte for byte.
  try {
    if (encodeModelStreamOwner(runId, agentId) !== owner) return null;
  } catch {
    return null;
  }
  return Object.freeze({ runId, agentId });
}

/** True exactly when `owner` is a canonical v2 model-stream owner. */
export function isModelStreamOwner(owner) {
  return decodeModelStreamOwner(owner) !== null;
}
