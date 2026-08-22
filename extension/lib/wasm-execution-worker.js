// lib/wasm-execution-worker.js — the dedicated Worker entry (Gate 2, corrected
// successor). SOURCE ONLY AND UNREACHABLE. Nothing constructs this Worker in
// Gate 2; the executor tests load it as a REAL Deno module Worker.
//
// The worker:
//   - validates the bounded job envelope (EXACT keys, UTF-8 byte bounds);
//   - AUDITS the binary BEFORE instantiation: auditWasmBinary (the landed
//     package authority — size/import/memory/framing/tier) + revalidateAuditedMemory
//     (the readback) → exact phases (import-rejected / memory-rejected /
//     compile-bounded / instantiation-error);
//   - builds the LANDED WASI runtime with the instance-memory adapter + a
//     PER-JOB SYNCHRONOUS workspace model (wasm-sync-workspace.js) bound to
//     the job's workspaceRoot — the landed adapters are synchronous, so no
//     cross-context file-op RPC exists;
//   - compiles + instantiates (the ONLY execution path — never a document
//     main thread), runs the export, posts the bounded exact-key result;
//   - holds no OPFS/chrome/credentials.

import {
  createWasiPreview1Runtime,
  revalidateAuditedMemory,
} from "./wasi-preview1-runtime.js";
import { WasiProcExit } from "./wasm-host-types.js";
import { auditWasmBinary, WASM_PACKAGE_LIMITS } from "./wasm-package-authority.js";
import { createSyncWorkspace } from "./wasm-sync-workspace.js";
import { TRANSPORT_MESSAGE_TYPES } from "./wasm-executor.js";
import { EXECUTOR_BOUNDS } from "./wasm-executor-bounds.js";

function failClosed(code, detail) {
  const error = new Error(`worker fail-closed: ${code}`);
  error.executorCode = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function plainData(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype);
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

const workerInstanceId = (globalThis.crypto?.randomUUID
  ? crypto.randomUUID()
  : `worker_${Math.random().toString(36).slice(2)}_${Date.now()}`);

const JOB_ENVELOPE_KEYS = Object.freeze(["type", "sessionId", "job", "wasmBytes"]);
const JOB_INNER_KEYS = Object.freeze(["context", "args", "stdin", "quota", "tier"]);
const CONTEXT_KEYS = Object.freeze(["executionId", "callId", "origin", "workspaceRoot"]);

function exactKeys(value, keys, code) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw failClosed(code);
  }
}

/** The STRICT EXACT-key bounded job-envelope validation (the executor's wire
 * shape; the sessionId is the authority's — never self-asserted). */
export function validateJobEnvelope(raw) {
  if (!plainData(raw)) throw failClosed("job-shape");
  exactKeys(raw, JOB_ENVELOPE_KEYS, "job-shape");
  if (raw.type !== TRANSPORT_MESSAGE_TYPES.JOB) throw failClosed("job-type");
  if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0 ||
      utf8Bytes(raw.sessionId) > EXECUTOR_BOUNDS.maxSessionIdBytes) {
    throw failClosed("job-session");
  }
  if (!Array.isArray(raw.wasmBytes) || raw.wasmBytes.length < 8 ||
      raw.wasmBytes.length > EXECUTOR_BOUNDS.maxRequestBytes) {
    throw failClosed("job-wasm");
  }
  if (!plainData(raw.job)) throw failClosed("job-inner");
  exactKeys(raw.job, JOB_INNER_KEYS, "job-inner");
  if (!plainData(raw.job.context)) throw failClosed("job-context");
  exactKeys(raw.job.context, CONTEXT_KEYS, "job-context");
  if (!Array.isArray(raw.job.args)) throw failClosed("job-args");
  if (!Array.isArray(raw.job.stdin)) throw failClosed("job-stdin");
  if (!plainData(raw.job.quota)) throw failClosed("job-quota");
  if (typeof raw.job.tier !== "string" || !["tiny", "default"].includes(raw.job.tier)) {
    throw failClosed("job-tier");
  }
  return Object.freeze({
    sessionId: raw.sessionId,
    job: raw.job,
    wasmBytes: new Uint8Array(raw.wasmBytes),
  });
}

/** Deterministic phase mapping: extract the code from error.code OR the
 * TypeError MESSAGE (the landed authorities throw `new TypeError(code)` — the
 * code IS the message). NEVER a message-substring guess. */
export function auditPhaseForCode(code) {
  const s = String(code ?? "");
  if (s === "import_not_allowed" || s === "import_count_bound" ||
      s === "import_kind_invalid" || s === "unsupported_wasi_import" ||
      s === "duplicate_wasi_import" || s === "wasi_import_shape") {
    return "import-rejected";
  }
  if (s.includes("memory") || s === "tier_invalid" || s === "tier_blocked" ||
      s === "memory_exceeds_ceiling") {
    return "memory-rejected";
  }
  return "compile-bounded";
}

export function auditCodeFromError(error) {
  if (error?.code) return error.code;
  // the landed authorities throw TypeError whose MESSAGE is the code
  if (error instanceof TypeError || error?.name === "TypeError") {
    return String(error?.message ?? "");
  }
  return String(error?.message ?? "");
}

export function compilePhaseFromError(error) {
  const name = String(error?.name ?? "");
  if (name === "CompileError" || name === "LinkError" ||
      String(error?.message ?? "").startsWith("CompileError") ||
      String(error?.message ?? "").startsWith("LinkError")) {
    return "instantiation-error";
  }
  return "runtime-error";
}

/** Run one job inside the worker. Exported for the no-Chrome tests. */
export async function runWorkerJob({ sessionId, job, wasmBytes, post, respond }) {
  let result = null;
  try {
    // 1. AUDIT the binary BEFORE any instantiation (the landed authority).
    const tier = WASM_PACKAGE_LIMITS.TIERS[job?.tier];
    if (!tier) throw failClosed("tier_invalid");
    const executable = {
      memory: { tier: job.tier, maxPages: tier.maxPages },
      imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    };
    let audit;
    try {
      audit = auditWasmBinary(wasmBytes, executable);
    } catch (error) {
      throw failClosed(`audit:${auditCodeFromError(error)}`, String(error?.message ?? error));
    }
    try {
      // The readback envelope: the audit record + the declared tier ceilings.
      revalidateAuditedMemory({
        audit: {
          ok: audit.ok,
          bytes: audit.bytes,
          imports: audit.imports,
          measured: audit.measured,
        },
        binaryBytes: audit.bytes,
        declaredMaxPages: tier.maxPages,
        tier: job.tier,
      });
    } catch (error) {
      throw failClosed(`audit:${auditCodeFromError(error)}`, String(error?.message ?? error));
    }

    // 2. The PER-JOB SYNCHRONOUS workspace bound to the job's workspaceRoot.
    const workspace = createSyncWorkspace({ root: job?.context?.workspaceRoot });

    // 3. The LANDED WASI runtime with the instance-memory adapter + the sync
    //    workspace (no Promises — the runtime syncResult-rejects them).
    const runtime = createWasiPreview1Runtime({
      job: {
        tier: job.tier,
        context: job.context,
        args: Array.isArray(job.args) ? job.args : [],
        stdin: new Uint8Array(job.stdin ?? []),
        quota: job.quota,
      },
      memory: {
        // Wasm memory is reached through instance.EXPORTS.memory (the export),
        // never instance.memory.
        size: () => {
          const mem = result?.exports?.memory;
          if (!mem) return 0;
          return mem.buffer.byteLength;
        },
        read: (ptr, len) => {
          const mem = result?.exports?.memory;
          if (!mem) return new Uint8Array(0);
          const buffer = mem.buffer;
          if (ptr + len > buffer.byteLength) return new Uint8Array(0);
          return new Uint8Array(buffer, ptr, len);
        },
        write: (ptr, bytes) => {
          const mem = result?.exports?.memory;
          if (!mem) return;
          const buffer = mem.buffer;
          if (ptr + bytes.byteLength > buffer.byteLength) {
            throw failClosed("memory-write-oob");
          }
          new Uint8Array(buffer).set(bytes, ptr);
        },
      },
      workspace,
    });

    // 4. Compile + instantiate (the ONLY execution path).
    const module = await WebAssembly.instantiate(wasmBytes, runtime.imports);
    const instance = module.instance;
    result = instance;
    // Entry-export selection (canonical, NOT preview-specific): prefer the
    // function-export `run`; fall back to the WASI command/main convention
    // `_start` (e.g. the csvtool). Neither export → export-missing.
    const fn = typeof instance.exports.run === "function"
      ? instance.exports.run
      : typeof instance.exports._start === "function"
        ? instance.exports._start
        : null;
    if (!fn) {
      throw failClosed("export-missing");
    }
    let snapshot;
    try {
      fn();
      snapshot = runtime.snapshot();
    } catch (error) {
      if (error instanceof WasiProcExit && error.code === 0) {
        // `_start` success: proc_exit(0) IS the normal WASI command
        // completion — snapshot the output so bounded stdout/stderr content
        // is preserved (never dropped).
        snapshot = runtime.snapshot();
      } else if (error instanceof WasiProcExit) {
        // Nonzero: the CURRENT failure schema — ok:false phase proc-exit with
        // errno = the exit code; bounded, no stale stdout under this schema.
        const exit = new Error(`WASI proc_exit(${error.code})`);
        exit.executorCode = "proc-exit";
        exit.errno = error.code;
        throw exit;
      } else {
        throw error;
      }
    }
    respond(Object.freeze({
      type: TRANSPORT_MESSAGE_TYPES.RESULT,
      sessionId,
      executionId: String(job?.context?.executionId ?? ""),
      jobId: String(job?.context?.callId ?? ""),
      ok: true,
      phase: "completed",
      result: null,
      counters: snapshot.counters,
      stdoutBytes: snapshot.stdout.byteLength,
      stderrBytes: snapshot.stderr.byteLength,
      stdout: new TextDecoder().decode(snapshot.stdout).slice(0, EXECUTOR_BOUNDS.maxResponseBytes),
      stderr: new TextDecoder().decode(snapshot.stderr).slice(0, EXECUTOR_BOUNDS.maxResponseBytes),
      workerInstanceId,
      error: null,
      errno: null,
    }));
  } catch (error) {
    const code = error?.executorCode ?? "";
    let phase;
    if (code.startsWith("audit:")) {
      phase = auditPhaseForCode(code.slice("audit:".length));
    } else if (
      String(error?.executorCode ?? "") === "proc-exit" ||
      (error instanceof Error && String(error.message).includes("proc_exit"))
    ) {
      phase = "proc-exit";
    } else if (String(error?.executorCode ?? "") === "export-missing") {
      phase = "runtime-error";
    } else {
      phase = compilePhaseFromError(error);
    }
    respond(Object.freeze({
      type: TRANSPORT_MESSAGE_TYPES.RESULT,
      sessionId,
      executionId: String(job?.context?.executionId ?? ""),
      jobId: String(job?.context?.callId ?? ""),
      ok: false,
      phase,
      result: null,
      counters: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdout: "",
      stderr: "",
      workerInstanceId,
      error: String(error?.message ?? error).slice(0, EXECUTOR_BOUNDS.maxTransportErrorBytes),
      errno: Number.isSafeInteger(error?.errno) ? error.errno : null,
    }));
  }
}

// The Worker entry (module worker): validate → audit → run → post the result.
self.onmessage = (event) => {
  const message = event.data;
  try {
    const validated = validateJobEnvelope(message);
    runWorkerJob({
      sessionId: validated.sessionId,
      job: validated.job,
      wasmBytes: validated.wasmBytes,
      post: (msg) => self.postMessage(msg),
      respond: (msg) => self.postMessage(msg),
    });
  } catch (error) {
    self.postMessage(Object.freeze({
      type: TRANSPORT_MESSAGE_TYPES.RESULT,
      sessionId: typeof message?.sessionId === "string" ? message.sessionId : "",
      executionId: String(message?.job?.context?.executionId ?? ""),
      jobId: String(message?.job?.context?.callId ?? ""),
      ok: false,
      phase: "runtime-error",
      result: null,
      counters: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdout: "",
      stderr: "",
      workerInstanceId,
      error: String(error?.message ?? error).slice(0, EXECUTOR_BOUNDS.maxTransportErrorBytes),
      errno: null,
    }));
  }
};
