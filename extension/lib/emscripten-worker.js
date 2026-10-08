// Fresh-per-job module worker for admitted Emscripten schema-2 packages
// (chrome-agent-platform-ltkj.3). Spawned only by lib/emscripten-host.js after
// every declared asset byte was hash-verified against the admitted manifest.
//
// Isolation contract: this worker is created for exactly ONE job and
// terminated by the host on every outcome — no pooling, no module/heap/FS
// reuse across jobs. The factory receives exactly { wasmBinary } — no
// caller-influenced Module fields, hooks, locateFile or memory settings.

import { adapterContractFor } from "./emscripten-adapter-registry.js";

const JOB_TYPE = "cap:emscripten-worker-job";
const RESULT_TYPE = "cap:emscripten-run-result";
const JOB_KEYS = Object.freeze([
  "adapterUrl",
  "args",
  "glueUrl",
  "graphDigest",
  "operation",
  "operationId",
  "packageId",
  "sessionId",
  "type",
  "version",
  "wasmBytes",
]);

const workerInstanceId = crypto.randomUUID();
let jobAccepted = false;
let active = false;

function exactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function post(payload) {
  postMessage({
    type: RESULT_TYPE,
    sessionId: payload.sessionId,
    packageId: payload.packageId,
    operationId: payload.operationId,
    ok: payload.ok,
    phase: payload.phase,
    result: payload.result ?? null,
    error: payload.error ?? null,
    workerInstanceId,
  });
}

async function run(job) {
  const contract = adapterContractFor(job.operation.adapterId);
  if (!contract) {
    throw new Error(`unsupported adapter: ${String(job.operation.adapterId).slice(0, 128)}`);
  }
  const method = contract.operations[job.operationId];
  if (typeof method !== "string") {
    throw new Error(`unsupported operation for adapter ${job.operation.adapterId}: ${String(job.operationId).slice(0, 128)}`);
  }
  const [glueModule, adapterModule] = await Promise.all([
    import(job.glueUrl),
    import(job.adapterUrl),
  ]);
  const factory = glueModule?.default;
  if (typeof factory !== "function") throw new Error("glue default export is not a factory");
  const createAdapter = adapterModule?.[contract.factoryExport];
  if (typeof createAdapter !== "function") throw new Error("adapter factory export missing");
  // The ONLY factory argument is the verified wasm bytes.
  const module = await factory({ wasmBinary: job.wasmBytes });
  const exportFn =
    (typeof module?.[job.operation.exportName] === "function" ? module[job.operation.exportName] : null) ??
    (typeof module?.[`_${job.operation.exportName}`] === "function" ? module[`_${job.operation.exportName}`] : null) ??
    (typeof module?.asm?.[job.operation.exportName] === "function" ? module.asm[job.operation.exportName] : null);
  if (typeof exportFn !== "function") {
    throw new Error(`admitted export missing on the instance: ${job.operation.exportName}`);
  }
  const adapter = createAdapter({ exports: { [job.operation.exportName]: exportFn } });
  const operation = adapter?.[method];
  if (typeof operation !== "function") throw new Error(`adapter operation missing: ${method}`);
  return operation(...job.args);
}

addEventListener("error", (event) => {
  event.preventDefault();
  if (!active) return;
  active = false;
  post({
    sessionId: null, packageId: null, operationId: null,
    ok: false, phase: "failed",
    error: String(event.error?.stack ?? event.message).slice(0, 1024),
  });
});
addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  if (!active) return;
  active = false;
  post({
    sessionId: null, packageId: null, operationId: null,
    ok: false, phase: "failed",
    error: String(event.reason?.stack ?? event.reason).slice(0, 1024),
  });
});

addEventListener("message", async (event) => {
  const job = event.data;
  if (jobAccepted) return; // exactly ONE job per worker, ever — permanent guard
  if (!exactKeys(job, JOB_KEYS) || job.type !== JOB_TYPE) return;
  jobAccepted = true;
  active = true;
  const identity = {
    sessionId: job.sessionId,
    packageId: job.packageId,
    operationId: job.operationId,
  };
  try {
    const result = await run(job);
    active = false;
    post({ ...identity, ok: true, phase: "completed", result });
  } catch (error) {
    active = false;
    post({
      ...identity, ok: false, phase: "failed",
      error: String(error?.stack ?? error).slice(0, 1024),
    });
  }
});
