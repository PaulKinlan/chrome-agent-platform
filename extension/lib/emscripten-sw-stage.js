// x9r8k.2: trusted SW-only binary STAGING, not a model/publish/seal/delete route.
// No host receipt (including CLOSED) establishes literal Worker termination.
import { emscriptenJobOwner } from "./emscripten-custody.js";
import { createEmscriptenHostEvidence } from "./emscripten-host-evidence.js";
import { verifyStagedEmscriptenRun } from "./emscripten-staging-authority.js";
import { createEmscriptenSwIntent } from "./emscripten-sw-intent.js";
import { EMSCRIPTEN_HOST_STAGE_TYPE, EMSCRIPTEN_SW_STAGE_TYPE } from "./emscripten-stage-protocol.js";
import { createWasmStreamOutput, validateSealedWasmStream } from "./wasm-stream-files.js";

export { EMSCRIPTEN_SW_STAGE_TYPE };
const REQUEST_KEYS = ["type", "runId", "agentId", "inputRef", "packageId", "version", "graphDigest", "operationId", "args"];
const HEX64 = /^[0-9a-f]{64}$/u;
const ID_RE = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/u;
const NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const inFlight = new Set();
function exact(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function unknown(code) { return Object.freeze({ ok: false, phase: "unknown", error: code }); }
function live(isLive, raw) {
  if (typeof isLive !== "function" || isLive(raw.runId, raw.agentId) !== true) {
    fail("emscripten_run_not_live");
  }
}
function admittedOperation(current, raw) {
  if (!current?.manifest || current.version !== raw.version ||
      current.graphDigest !== raw.graphDigest ||
      current.manifest.package?.id !== raw.packageId ||
      current.manifest.package?.version !== raw.version) fail("emscripten_stage_stale_graph");
  const manifest = current.manifest;
  const operation = manifest.entry?.operations?.find((op) => op?.id === raw.operationId);
  if (operation?.kind !== "native-buffer-v1" || operation.result !== "buffer" ||
      !NAME.test(operation.id) || !NAME.test(manifest.entry.adapterId) ||
      typeof operation.exportName !== "string" ||
      !/^_[A-Za-z0-9_]+$|^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(operation.exportName) ||
      !Array.isArray(operation.params) || operation.params.length > 16 ||
      raw.args.length !== operation.params.length) fail("emscripten_stage_operation");
  const params = operation.params.map((param, index) => {
    const value = raw.args[index];
    if (!NAME.test(param.name ?? "") || !["i32", "f64", "string"].includes(param.type) ||
        !Number.isFinite(param.minimum) || !Number.isFinite(param.maximum) ||
        param.minimum > param.maximum) fail("emscripten_stage_args");
    if (param.type === "string") {
      const size = typeof value === "string" ? new TextEncoder().encode(value).length : -1;
      if (size < param.minimum || size > param.maximum) fail("emscripten_stage_args");
    } else if (typeof value !== "number" || !Number.isFinite(value) ||
        (param.type === "i32" && !Number.isSafeInteger(value)) ||
        value < param.minimum || value > param.maximum) fail("emscripten_stage_args");
    return Object.freeze({ name: param.name, type: param.type,
      minimum: param.minimum, maximum: param.maximum });
  });
  const assets = manifest.assets;
  if (!Array.isArray(assets) || assets.length !== 3 ||
      assets.map((asset) => asset.role).sort().join(",") !== "adapter,glue,main-wasm") {
    fail("emscripten_stage_assets");
  }
  const lifecycle = manifest.resources?.lifecycle;
  if (!Number.isFinite(lifecycle?.startupMs) || lifecycle.startupMs <= 0 ||
      lifecycle.startupMs > 120_000 || !Number.isFinite(lifecycle?.callMs) ||
      lifecycle.callMs <= 0 || lifecycle.callMs > 120_000 ||
      lifecycle.startupMs + lifecycle.callMs + 5_000 > 245_000 ||
      lifecycle.concurrentJobs !== 1) fail("emscripten_stage_lifecycle");
  return Object.freeze({
    operation: Object.freeze({ id: operation.id, adapterId: manifest.entry.adapterId,
      exportName: operation.exportName, result: "buffer", params: Object.freeze(params) }),
    assets: Object.freeze(assets.map((asset) => Object.freeze({ role: asset.role,
      path: String(asset.path).replace(/^extension\//u, ""),
      sha256: asset.sha256, size: asset.size }))),
    lifecycle: Object.freeze({ startupMs: lifecycle.startupMs, callMs: lifecycle.callMs }),
  });
}
async function sendOffscreen(message, wallMs, runtime) {
  if (typeof runtime?.sendMessage !== "function") fail("emscripten_stage_host_unavailable");
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => finish(null), wallMs);
    try {
      runtime.sendMessage(message, (result) => {
        if (runtime.lastError) finish(null);
        else finish(result ?? null);
      });
    } catch { finish(null); }
  });
}

/** Only a SW-created live execution may stage an already sealed, run-owned
 * input. A fresh registry read and an OPFS intent precede output creation.
 * Every terminal path is typed UNKNOWN; nothing returns an output capability. */
export async function stageTrustedEmscriptenBinary(raw, {
  storage = globalThis.navigator?.storage, intent, evidence, isLive, readPackages,
  ensureHost, sendHost, runtime = globalThis.chrome?.runtime,
} = {}) {
  let outputRef = null;
  let identity = null;
  let swIntent;
  let result = unknown("emscripten_stage_unavailable");
  let retentionReason = "host_unavailable";
  let claimed = false;
  try {
    if (!exact(raw, REQUEST_KEYS) || raw.type !== EMSCRIPTEN_SW_STAGE_TYPE ||
        !(raw.agentId === null || (typeof raw.agentId === "string" && raw.agentId.length > 0)) ||
        !ID_RE.test(raw.packageId ?? "") || !NAME.test(raw.operationId ?? "") ||
        !HEX64.test(raw.graphDigest ?? "") || !Array.isArray(raw.args)) {
      fail("emscripten_stage_request");
    }
    live(isLive, raw);
    if (inFlight.has(raw.packageId)) fail("emscripten_stage_busy");
    inFlight.add(raw.packageId);
    claimed = true;
    const agentId = raw.agentId === null ? "hub" : raw.agentId;
    const owner = emscriptenJobOwner({ runId: raw.runId, agentId });
    if (typeof readPackages !== "function" || typeof ensureHost !== "function" ||
        typeof storage?.getDirectory !== "function") fail("emscripten_stage_unavailable");
    const read = await readPackages();
    if (read?.ok !== true || !(read.packages instanceof Map)) fail("emscripten_stage_registry_unavailable");
    const admitted = admittedOperation(read.packages.get(raw.packageId), raw);
    live(isLive, raw);
    // A sealed input is an independently owned stream; output ref creation
    // must never be used to create or implicitly seal the input.
    try { await validateSealedWasmStream({ ref: raw.inputRef, owner, storage }); }
    catch { fail("emscripten_stage_input_unavailable"); }
    live(isLive, raw);
    swIntent = intent ?? createEmscriptenSwIntent({ storage });
    const hostEvidence = evidence ?? createEmscriptenHostEvidence({ storage });
    const generation = crypto.randomUUID().replaceAll("-", "");
    outputRef = await createWasmStreamOutput({ owner, storage, preserveOnFailure: true,
      beforeCreate: async (ref) => {
        live(isLive, raw);
        identity = { runId: raw.runId, agentId, outputRef: ref, generation,
          packageId: raw.packageId, graphDigest: raw.graphDigest, operationId: raw.operationId };
        await swIntent.begin({ identity, inputRef: raw.inputRef });
      },
      onRetainedFailure: (ref, reason) => {
        if (ref.id !== identity?.outputRef.id || ref.kind !== "stdout") fail("emscripten_stage_ref");
        return swIntent.recordRetained({ identity, inputRef: raw.inputRef }, reason);
      },
    });
    live(isLive, raw);
    const host = await ensureHost();
    if (host?.ok !== true) fail("emscripten_stage_host_unavailable");
    live(isLive, raw);
    const message = Object.freeze({
      type: EMSCRIPTEN_HOST_STAGE_TYPE, identity, inputRef: raw.inputRef,
      packageId: raw.packageId, version: raw.version, graphDigest: raw.graphDigest,
      operationId: raw.operationId, operation: admitted.operation, args: raw.args,
      assets: admitted.assets, lifecycle: admitted.lifecycle, sessionId: crypto.randomUUID(),
    });
    const wallMs = admitted.lifecycle.startupMs + admitted.lifecycle.callMs + 5_000;
    const hostResult = typeof sendHost === "function"
      ? await sendHost(message, wallMs) : await sendOffscreen(message, wallMs + 5_000, runtime);
    live(isLive, raw);
    if (hostResult?.ok !== false || hostResult?.phase !== "unknown" ||
        hostResult?.error !== "emscripten_worker_termination_unproved" ||
        hostResult.hostProof === undefined) fail("emscripten_stage_host_unavailable");
    result = await verifyStagedEmscriptenRun({ identity, inputRef: raw.inputRef,
      hostProof: hostResult.hostProof, intent: swIntent, evidence: hostEvidence,
      storage, isLive: () => isLive(raw.runId, raw.agentId) });
    retentionReason = "termination_unproved";
  } catch (cause) {
    const code = typeof cause?.code === "string" && /^emscripten_|^wasm_stream_/u.test(cause.code)
      ? cause.code : "emscripten_stage_unavailable";
    result = unknown(code);
    if (code === "emscripten_run_not_live") retentionReason = "run_not_live";
    else if (code === "emscripten_staging_evidence_mismatch" ||
        code === "emscripten_staging_bytes_mismatch") retentionReason = "evidence_mismatch";
    else if (code.startsWith("emscripten_staging_") || code.startsWith("wasm_stream_")) {
      retentionReason = "evidence_unavailable";
    }
  } finally {
    if (outputRef && swIntent) {
      try { await swIntent.recordRetained({ identity, inputRef: raw.inputRef }, retentionReason); }
      catch { result = unknown("emscripten_stage_retention_unavailable"); }
    }
    if (claimed) inFlight.delete(raw.packageId);
  }
  return result;
}

// Bind an immutable SW-local authority closure. There is intentionally NO
// runtime.onMessage listener for the SW stage type: Chromium does not deliver
// a service worker's sendMessage back to that worker (real browser falsifier),
// while allowing extension pages to call this function would break SW-only
// custody. The offscreen host alone receives a runtime message, from the SW.
export function bindTrustedSwStaging(deps) {
  const bound = Object.freeze({ ...deps });
  return Object.freeze((raw) => stageTrustedEmscriptenBinary(raw, bound));
}
