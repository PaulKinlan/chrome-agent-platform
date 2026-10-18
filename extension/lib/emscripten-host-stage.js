// x9r8k.2: SW-only offscreen binary STAGING host. No seal, publish or delete.
import { emscriptenJobOwner } from "./emscripten-custody.js";

import { runAuditedHostBinaryJob } from "./emscripten-host-binary-runner.js";
import { EMSCRIPTEN_HOST_STAGE_TYPE } from "./emscripten-stage-protocol.js";
import { isTrustedServiceWorkerSender, sha256HexBytes } from "./pure.js";
import { validateSealedWasmStream, validateWasmStreamRef } from "./wasm-stream-files.js";

const REQUEST_KEYS = ["type", "identity", "inputRef", "packageId", "version", "graphDigest",
  "operationId", "sessionId", "operation", "args", "assets", "lifecycle"];
const IDENTITY_KEYS = ["runId", "agentId", "outputRef", "generation", "packageId", "graphDigest", "operationId"];
const OPERATION_KEYS = ["id", "adapterId", "exportName", "result", "params"];
const PARAM_KEYS = ["name", "type", "minimum", "maximum"];
const HEX64 = /^[0-9a-f]{64}$/u;
const HEX32 = /^[0-9a-f]{32}$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const CAS_PATH = /^wasm\/cas\/[0-9a-f]{64}\.wasm$/u;
const RUNTIME_PATH = /^wasm\/runtime\/[a-z0-9._-]+\/[0-9A-Za-z.+-]+\/[A-Za-z0-9._-]+\.mjs$/u;
const activePackages = new Set();
function exact(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function unknown(code) { return Object.freeze({ ok: false, phase: "unknown", error: code }); }
async function fetchStagingAsset(asset, runtime) {
  if (!exact(asset, ["role", "path", "sha256", "size"]) ||
      !["adapter", "glue", "main-wasm"].includes(asset.role) ||
      !HEX64.test(asset.sha256 ?? "") || !Number.isSafeInteger(asset.size) || asset.size <= 0 ||
      !(asset.role === "main-wasm" ? CAS_PATH : RUNTIME_PATH).test(asset.path ?? "")) {
    fail("emscripten_stage_assets");
  }
  const response = await fetch(runtime.getURL(asset.path));
  if (!response.ok) fail("emscripten_stage_asset_fetch");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== asset.size || await sha256HexBytes(bytes) !== asset.sha256) {
    fail("emscripten_stage_asset_hash");
  }
  return bytes;
}
function validate(raw) {
  if (!exact(raw, REQUEST_KEYS) || raw.type !== EMSCRIPTEN_HOST_STAGE_TYPE ||
      !exact(raw.identity, IDENTITY_KEYS) ||
      typeof raw.packageId !== "string" || typeof raw.operationId !== "string" ||
      typeof raw.version !== "string" || !SEMVER.test(raw.version) ||
      !HEX64.test(raw.graphDigest ?? "") || !HEX32.test(raw.identity.generation ?? "") ||
      raw.identity.packageId !== raw.packageId || raw.identity.graphDigest !== raw.graphDigest ||
      raw.identity.operationId !== raw.operationId ||
      !exact(raw.operation, OPERATION_KEYS) || raw.operation.result !== "buffer" ||
      raw.operation.id !== raw.operationId || typeof raw.operation.adapterId !== "string" ||
      typeof raw.operation.exportName !== "string" ||
      !/^_[A-Za-z0-9_]+$|^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(raw.operation.exportName) ||
      !Array.isArray(raw.operation.params) || !Array.isArray(raw.args) ||
      raw.operation.params.length > 16 || raw.operation.params.length !== raw.args.length ||
      typeof raw.sessionId !== "string" || raw.sessionId.length < 1 || raw.sessionId.length > 128 ||
      !Array.isArray(raw.assets) || raw.assets.length !== 3 ||
      raw.assets.map((asset) => asset?.role).sort().join(",") !== "adapter,glue,main-wasm" ||
      !exact(raw.lifecycle, ["startupMs", "callMs"]) ||
      !Number.isFinite(raw.lifecycle.startupMs) || raw.lifecycle.startupMs <= 0 ||
      raw.lifecycle.startupMs > 120_000 || !Number.isFinite(raw.lifecycle.callMs) ||
      raw.lifecycle.callMs <= 0 || raw.lifecycle.callMs > 120_000 ||
      raw.lifecycle.startupMs + raw.lifecycle.callMs + 5_000 > 245_000) {
    fail("emscripten_stage_request");
  }
  for (const [index, param] of raw.operation.params.entries()) {
    const value = raw.args[index];
    if (!exact(param, PARAM_KEYS) || typeof param.name !== "string" || param.name.length < 1 ||
        !["i32", "f64", "string"].includes(param.type) ||
        !Number.isFinite(param.minimum) || !Number.isFinite(param.maximum) ||
        param.minimum > param.maximum) fail("emscripten_stage_args");
    if (param.type === "string") {
      const size = typeof value === "string" ? new TextEncoder().encode(value).length : -1;
      if (size < param.minimum || size > param.maximum) fail("emscripten_stage_args");
    } else if (typeof value !== "number" || !Number.isFinite(value) ||
        (param.type === "i32" && !Number.isSafeInteger(value)) ||
        value < param.minimum || value > param.maximum) fail("emscripten_stage_args");
  }
  const owner = emscriptenJobOwner(raw.identity);
  validateWasmStreamRef(raw.identity.outputRef, { kinds: ["stdout"] });
  validateWasmStreamRef(raw.inputRef, { kinds: ["input"] });
  return owner;
}

/** Independent host input and asset verification. The CLOSED proof is returned
 * to its trusted SW caller solely as a locator for a *fresh SW-side re-read*;
 * the result is always UNKNOWN and contains no byte/artifact capability. */
export async function executeStagedEmscriptenBinaryRequest(raw, {
  runtime = globalThis.chrome?.runtime, storage = globalThis.navigator?.storage,
  runBinary = runAuditedHostBinaryJob,
} = {}) {
  let claimed = false;
  try {
    const owner = validate(raw);
    if (activePackages.has(raw.packageId)) fail("emscripten_stage_busy");
    activePackages.add(raw.packageId);
    claimed = true;
    if (typeof storage?.getDirectory !== "function" || typeof runtime?.getURL !== "function") {
      fail("emscripten_stage_host_unavailable");
    }
    try { await validateSealedWasmStream({ ref: raw.inputRef, owner, storage }); }
    catch { fail("emscripten_stage_input_unavailable"); }
    const byRole = new Map();
    for (const asset of raw.assets) {
      byRole.set(asset.role, await fetchStagingAsset(asset, runtime));
    }
    const glue = raw.assets.find((asset) => asset.role === "glue");
    const adapter = raw.assets.find((asset) => asset.role === "adapter");
    const job = Object.freeze({ type: "cap:emscripten-worker-job", sessionId: raw.sessionId,
      packageId: raw.packageId, version: raw.version, graphDigest: raw.graphDigest,
      operationId: raw.operationId, operation: raw.operation, args: raw.args,
      glueUrl: runtime.getURL(glue.path), adapterUrl: runtime.getURL(adapter.path),
      wasmBytes: byRole.get("main-wasm") });
    const proof = await runBinary({ identity: raw.identity, job, storage,
      createWorker: () => new Worker(runtime.getURL("lib/emscripten-worker.js"), { type: "module" }),
      wallMs: raw.lifecycle.startupMs + raw.lifecycle.callMs + 5_000 });
    return Object.freeze({ ...unknown("emscripten_worker_termination_unproved"), hostProof: proof });
  } catch (cause) {
    return unknown(typeof cause?.code === "string" && cause.code.startsWith("emscripten_")
      ? cause.code : "emscripten_stage_host_unavailable");
  } finally {
    if (claimed) activePackages.delete(raw.packageId);
  }
}

export function registerEmscriptenBinaryStagingHost(deps = {}) {
  const runtime = deps.runtime ?? globalThis.chrome?.runtime;
  if (!runtime?.onMessage) return;
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== EMSCRIPTEN_HOST_STAGE_TYPE) return undefined;
    if (!isTrustedServiceWorkerSender(sender, runtime)) {
      sendResponse(unknown("emscripten_stage_sender"));
      return false;
    }
    const execute = deps.execute ?? executeStagedEmscriptenBinaryRequest;
    execute(message, { ...deps, runtime })
      .then(sendResponse).catch(() => sendResponse(unknown("emscripten_stage_host_unavailable")));
    return true;
  });
}
