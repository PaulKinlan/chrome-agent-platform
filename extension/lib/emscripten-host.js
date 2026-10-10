// Offscreen host for admitted Emscripten schema-2 packages (chrome-agent-platform-ltkj.3).
//
// The SW broker (and only the SW) selects the package, operation and graph and
// authorizes the run; this host receives the exact cap:emscripten-run envelope
// (identity + broker-derived operation descriptor + scalar-validated args +
// opaque asset references), verifies every declared asset byte-for-byte against
// the broker-supplied hashes, then runs the admitted operation in a FRESH
// module Worker with a host-owned deadline armed before initialization.
//
// Hard rules (bead contract):
//   - Only the extension service worker may submit (tab/document senders are
//     rejected even when the extension id matches).
//   - The envelope carries no caller-provided Module, hooks, JS, asset URLs,
//     export names, locateFile, dynamicLibraries or memory/pool settings —
//     the exact-key check rejects them structurally.
//   - One in-flight job per package (resources.lifecycle.concurrentJobs: 1);
//     a second run refuses honestly, it never queues.
//   - Settlement is exactly-once; the worker is terminated on every path.

import { validateAuthorityRecord } from "./wasm-executor.js";
import { isTrustedServiceWorkerSender, sha256HexBytes } from "./pure.js";

export const EMSCRIPTEN_RUN_TYPE = "cap:emscripten-run";
export const EMSCRIPTEN_RESULT_TYPE = "cap:emscripten-run-result";
export const EMSCRIPTEN_JOB_TYPE = "cap:emscripten-worker-job";
export const EMSCRIPTEN_WORKER_PATH = "lib/emscripten-worker.js";
// Deadline = startup + call + a fixed network/dispatch margin, all
// broker-derived from the admitted manifest's resources.lifecycle.
export const EMSCRIPTEN_DEADLINE_MARGIN_MS = 5_000;

const REQUEST_KEYS = Object.freeze([
  "args",
  "assets",
  "authority",
  "graphDigest",
  "lifecycle",
  "operation",
  "operationId",
  "packageId",
  "type",
  "version",
]);
const RESULT_KEYS = Object.freeze([
  "error",
  "ok",
  "operationId",
  "packageId",
  "phase",
  "result",
  "sessionId",
  "type",
  "workerInstanceId",
]);
const ASSET_KEYS = Object.freeze(["path", "role", "sha256", "size"]);
const OPERATION_KEYS = Object.freeze(["adapterId", "exportName", "id", "params", "result"]);
const PARAM_KEYS = Object.freeze(["maximum", "minimum", "name", "type"]);
const LIFECYCLE_KEYS = Object.freeze(["callMs", "startupMs"]);

const PACKAGE_ID_RE = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/u;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const HEX64_RE = /^[0-9a-f]{64}$/u;
const CAS_PATH_RE = /^wasm\/cas\/[0-9a-f]{64}\.wasm$/u;
const RUNTIME_PATH_RE = /^wasm\/runtime\/[a-z0-9._-]+\/[0-9A-Za-z.+-]+\/[A-Za-z0-9._-]+\.mjs$/u;

function plain(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function exactKeys(value, keys) {
  return plain(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function validateParam(param) {
  if (!exactKeys(param, PARAM_KEYS) || typeof param.name !== "string" ||
      param.name.length === 0 || param.name.length > 64 ||
      (!["i32", "f64", "string", "buffer"].includes(param.type)) ||
      typeof param.minimum !== "number" || !Number.isFinite(param.minimum) ||
      typeof param.maximum !== "number" || !Number.isFinite(param.maximum) ||
      param.minimum > param.maximum) {
    fail("emscripten_run_operation");
  }
}

function validateArg(param, value) {
  if (param.type === "i32" || param.type === "f64") {
    if (typeof value !== "number" || !Number.isFinite(value) || (param.type === "i32" && !Number.isSafeInteger(value)) || value < param.minimum || value > param.maximum) fail("emscripten_run_args");
  } else if (param.type === "string") { const len = typeof value === "string" ? new TextEncoder().encode(value).byteLength : -1; if (len < param.minimum || len > param.maximum) fail("emscripten_run_args"); } else if (param.type === "buffer") { if (!(value instanceof Uint8Array) || value.byteLength < param.minimum || value.byteLength > param.maximum) fail("emscripten_run_args"); } else fail("emscripten_run_args");
}

function validateAsset(asset) {
  if (!exactKeys(asset, ASSET_KEYS) ||
      (asset.role !== "adapter" && asset.role !== "glue" && asset.role !== "main-wasm") ||
      typeof asset.path !== "string" || !HEX64_RE.test(asset.sha256 ?? "") ||
      !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    fail("emscripten_run_assets");
  }
  if (asset.role === "main-wasm" && !CAS_PATH_RE.test(asset.path)) fail("emscripten_run_assets");
  if (asset.role !== "main-wasm" && !RUNTIME_PATH_RE.test(asset.path)) fail("emscripten_run_assets");
}

function validateRequest(raw) {
  if (!exactKeys(raw, REQUEST_KEYS) || raw.type !== EMSCRIPTEN_RUN_TYPE ||
      typeof raw.packageId !== "string" || !PACKAGE_ID_RE.test(raw.packageId) ||
      typeof raw.version !== "string" || !SEMVER_RE.test(raw.version) ||
      typeof raw.graphDigest !== "string" || !HEX64_RE.test(raw.graphDigest) ||
      typeof raw.operationId !== "string" || raw.operationId.length === 0 ||
      raw.operationId.length > 128 || !Array.isArray(raw.args)) {
    fail("emscripten_run_request");
  }
  const operation = raw.operation;
  if (!exactKeys(operation, OPERATION_KEYS) || operation.id !== raw.operationId ||
      typeof operation.adapterId !== "string" || operation.adapterId.length === 0 ||
      operation.adapterId.length > 128 ||
      typeof operation.exportName !== "string" || !/^_[A-Za-z0-9_]+$|^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(operation.exportName) ||
      (!["i32", "f64", "string", "buffer"].includes(operation.result)) ||
      !Array.isArray(operation.params) || operation.params.length > 16) {
    fail("emscripten_run_operation");
  }
  for (const param of operation.params) validateParam(param);
  if (raw.args.length !== operation.params.length) fail("emscripten_run_args");
  operation.params.forEach((param, index) => validateArg(param, raw.args[index]));
  if (!Array.isArray(raw.assets) || raw.assets.length !== 3) fail("emscripten_run_assets");
  for (const asset of raw.assets) validateAsset(asset);
  const roles = raw.assets.map((asset) => asset.role).sort().join(",");
  if (roles !== "adapter,glue,main-wasm") fail("emscripten_run_assets");
  if (!exactKeys(raw.lifecycle, LIFECYCLE_KEYS) ||
      !Number.isFinite(raw.lifecycle.startupMs) || raw.lifecycle.startupMs <= 0 || raw.lifecycle.startupMs > 120_000 ||
      !Number.isFinite(raw.lifecycle.callMs) || raw.lifecycle.callMs <= 0 || raw.lifecycle.callMs > 120_000) {
    fail("emscripten_run_lifecycle");
  }
  const authority = validateAuthorityRecord(raw.authority);
  return Object.freeze({
    packageId: raw.packageId,
    version: raw.version,
    graphDigest: raw.graphDigest,
    operationId: raw.operationId,
    operation: Object.freeze({
      id: operation.id,
      adapterId: operation.adapterId,
      exportName: operation.exportName,
      result: operation.result,
      params: Object.freeze(operation.params.map((param) => Object.freeze({ ...param }))),
    }),
    args: Object.freeze([...raw.args]),
    assets: Object.freeze(raw.assets.map((asset) => Object.freeze({ ...asset }))),
    lifecycle: Object.freeze({ ...raw.lifecycle }),
    authority,
  });
}

// Fetch + hash-verify one declared asset. Bytes of main-wasm are retained;
// glue/adapter are imported by the worker from their packaged URLs afterwards
// (fetch-then-import is not an atomic boundary in an unpacked tree, by design).
async function fetchVerifiedAsset(asset, runtime = globalThis.chrome?.runtime) {
  const getURL = runtime?.getURL ?? globalThis.chrome?.runtime?.getURL;
  if (!getURL) fail("emscripten_asset_fetch");
  const response = await fetch(getURL(asset.path));
  if (!response.ok) fail("emscripten_asset_fetch");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== asset.size || await sha256HexBytes(bytes) !== asset.sha256) {
    fail("emscripten_asset_hash");
  }
  return bytes;
}

function errorResult(request, phase, error) {
  return Object.freeze({
    type: EMSCRIPTEN_RESULT_TYPE,
    sessionId: request.authority.sessionId,
    packageId: request.packageId,
    operationId: request.operationId,
    ok: false,
    phase,
    result: null,
    error: String(error?.message ?? error).slice(0, 1024),
    workerInstanceId: null,
  });
}

// One in-flight job per package (resources.lifecycle.concurrentJobs: 1).
const inFlight = new Set();

export async function executeEmscriptenRunRequest(raw, {
  createWorker = (url) => new Worker(url, { type: "module" }),
  runtime = globalThis.chrome?.runtime,
} = {}) {
  const request = validateRequest(raw);
  if (inFlight.has(request.packageId)) fail("emscripten_busy");
  inFlight.add(request.packageId);
  try {
    const effectiveRuntime = runtime ?? globalThis.chrome?.runtime;
    if (!effectiveRuntime?.getURL) fail("emscripten_asset_fetch");
    const bytesByRole = new Map();
    for (const asset of request.assets) {
      bytesByRole.set(asset.role, await fetchVerifiedAsset(asset, effectiveRuntime));
    }
    const wasmBytes = bytesByRole.get("main-wasm");
    const glueUrl = effectiveRuntime.getURL(request.assets.find((a) => a.role === "glue").path);
    const adapterUrl = effectiveRuntime.getURL(request.assets.find((a) => a.role === "adapter").path);
    const wallMs = request.lifecycle.startupMs + request.lifecycle.callMs + EMSCRIPTEN_DEADLINE_MARGIN_MS;

    let worker;
    try {
      worker = createWorker(effectiveRuntime.getURL("lib/emscripten-worker.js"));
    } catch (error) {
      throw error;
    }
    try {
      return await new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { worker.terminate(); } catch { /* best effort */ }
          resolve(result);
        };
        // The deadline is armed BEFORE the job is posted: initialization,
        // compile and constructors all run under it (never after).
        const timer = setTimeout(
          () => finish(errorResult(request, "timeout", "wall deadline exceeded; worker terminated")),
          wallMs,
        );
        worker.onerror = (event) => finish(errorResult(
          request, "failed", String(event?.message ?? "emscripten worker error").slice(0, 1024),
        ));
        worker.onmessage = (event) => {
          const result = event.data;
          try {
            finish(validateWorkerResult(result, request));
          } catch (error) {
            finish(errorResult(request, "failed", error));
          }
        };
        worker.postMessage({
          type: EMSCRIPTEN_JOB_TYPE,
          sessionId: request.authority.sessionId,
          packageId: request.packageId,
          version: request.version,
          graphDigest: request.graphDigest,
          operationId: request.operationId,
          operation: request.operation,
          args: request.args,
          glueUrl,
          adapterUrl,
          wasmBytes,
        }, [wasmBytes.buffer]);
      });
    } finally {
      try { worker.terminate(); } catch { /* best effort */ }
    }
  } finally {
    inFlight.delete(request.packageId);
  }
}

function validateWorkerResult(result, request) {
  if (!exactKeys(result, RESULT_KEYS) || result.type !== EMSCRIPTEN_RESULT_TYPE ||
      result.sessionId !== request.authority.sessionId ||
      result.packageId !== request.packageId ||
      result.operationId !== request.operationId ||
      typeof result.ok !== "boolean") {
    fail("emscripten_worker_result");
  }
  if (!result.ok) {
    return Object.freeze({
      ...errorResult(request, result.phase === "timeout" ? "timeout" : "failed", result.error ?? "emscripten worker failed"),
      workerInstanceId: typeof result.workerInstanceId === "string" ? result.workerInstanceId.slice(0, 128) : null,
    });
  }
  if (result.phase !== "completed" ||
      typeof result.workerInstanceId !== "string" || result.workerInstanceId.length === 0 ||
      result.workerInstanceId.length > 128) {
    fail("emscripten_worker_result");
  }
  if (request.operation.result === "i32" &&
      (!Number.isSafeInteger(result.result))) {
    fail("emscripten_worker_result");
  }
  if (request.operation.result === "f64" &&
      (typeof result.result !== "number" || !Number.isFinite(result.result))) {
    fail("emscripten_worker_result");
  }
  if (request.operation.result === "string" &&
      typeof result.result !== "string") {
    fail("emscripten_worker_result");
  }
  if (request.operation.result === "buffer" &&
      !(result.result instanceof Uint8Array)) {
    fail("emscripten_worker_result");
  }
  return Object.freeze({ ...result });
}

export function registerEmscriptenHost(deps = {}) {
  const runtime = deps?.runtime ?? globalThis.chrome?.runtime;
  if (!runtime?.onMessage) return;
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== EMSCRIPTEN_RUN_TYPE) return undefined;
    // Only the extension service worker may submit a run. Same-extension pages
    // and content scripts share sender.id, so id-only checking is not an
    // authority boundary; document/tab senders are rejected explicitly.
    if (!isTrustedServiceWorkerSender(sender, runtime)) {
      sendResponse({ ok: false, error: "emscripten_run_sender" });
      return false;
    }
    executeEmscriptenRunRequest(message, { ...deps, runtime })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({
        ok: false,
        phase: "failed",
        error: String(error?.message ?? error).slice(0, 1024),
      }));
    return true;
  });
}
