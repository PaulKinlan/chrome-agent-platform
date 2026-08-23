// lib/wasm-executor.js — the bounded fresh-Worker executor (WASM-EXECUTION-HOST
// Gate 2, corrected successor). SOURCE ONLY AND UNREACHABLE.
//
// No route/provider binding, no package/binary admission, no Settings, no
// OPFS/artifact authority mutation, no Chrome. Invariants:
//   - ONE fresh dedicated Worker per call — never pooled;
//   - NO main-thread fallback (a spawn/transport failure is a FAILURE);
//   - wall deadline → the worker is TERMINATED + the abort listener removed +
//     `settled` set on EVERY path + the per-job workspace is discarded (it
//     lives inside the terminated worker — no post-timeout mutation);
//   - ONE-WAY transport (job → worker, worker → final result) with STRICT
//     EXACT-key, UTF-8-BYTE-bounded schemas — hostile/extra-key/garbage
//     messages fail closed; the result envelope fields are never overwritten;
//   - the session/execution/call/agent/origin/document fences come from a
//     SEPARATELY SUPPLIED authoritative record (the host's bound authority —
//     the future durable run record), NEVER self-asserted by the request;
//     the request envelope carries ONLY the bounded job + wasmBytes; the
//     sessionId on every envelope is the authority's;
//   - no ambient credentials: the worker receives only the bounded payload.

import { EXECUTOR_BOUNDS } from "./wasm-executor-bounds.js";
import { decodeCanonicalBase64 } from "./wasm-base64.js";

export const TRANSPORT_MESSAGE_TYPES = Object.freeze({
  JOB: "wasm.job",
  RESULT: "wasm.result",
});

function failClosed(code, detail) {
  const error = new Error(`executor fail-closed: ${code}`);
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

function boundedString(value, maxBytes) {
  if (typeof value !== "string") return "";
  return value.slice(0, maxBytes);
}

/** The EXACT fence record: a separately supplied authority. The request NEVER
 * self-asserts these; the host binds them (the future durable run record). */
export function validateAuthorityRecord(value) {
  if (!plainData(value)) throw failClosed("authority-shape");
  const required = ["sessionId", "executionId", "callId", "agentId", "origin", "documentId"];
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw failClosed("authority-shape");
    }
  }
  if (Object.keys(value).length !== required.length) {
    throw failClosed("authority-shape");
  }
  const out = {};
  for (const key of required) {
    const v = value[key];
    if (typeof v !== "string" || v.length === 0 || utf8Bytes(v) > 256) {
      throw failClosed("authority-shape");
    }
    out[key] = v;
  }
  return Object.freeze(out);
}

/** Check the job's context (execution/call/origin/workspaceRoot) against the
 * authoritative record — the ONLY fence comparison (no self-asserted values). */
export function checkJobAgainstAuthority(job, authority) {
  const context = job?.context ?? {};
  if (context.executionId !== authority.executionId ||
      context.callId !== authority.callId ||
      context.origin !== authority.origin) {
    throw failClosed("fence-mismatch");
  }
  const expectedRoot = `tool-jobs/${authority.executionId}/${authority.callId}/`;
  if (context.workspaceRoot !== expectedRoot) throw failClosed("fence-mismatch");
  return Object.freeze(authority);
}

/** Strict EXACT-key UTF-8-byte-bounded validation of the worker RESULT. The
 * `result` is constrained to null in Gate 2 (the run() export returns
 * nothing); `counters` is an exact-key bounded record; failure fields have an
 * exact shape; ok/phase consistency is enforced. */
const RESULT_KEYS = Object.freeze([
  // EXACTLY 16: the predecessor envelope plus the tagged stdoutBase64 arm.
  "type", "sessionId", "executionId", "jobId", "ok", "phase", "result",
  "counters", "stdoutBytes", "stderrBytes", "stdout", "stdoutBase64", "stderr",
  "workerInstanceId", "error", "errno",
]);
const COUNTER_KEYS = Object.freeze([
  "hostCalls", "pathCalls", "fileBytes", "stdinBytesRead",
  "stdoutBytes", "stderrBytes", "openDynamicFds",
]);
// phase↔ok binding: ok:true allows ONLY "completed"; ok:false allows ONLY the
// failure phases (never "completed").
const OK_PHASES = new Set(["completed"]);
const FAILURE_PHASES = new Set([
  "timeout", "instantiation-error", "import-rejected",
  "memory-rejected", "compile-bounded", "runtime-error", "proc-exit",
]);
const PHASES = new Set([...OK_PHASES, ...FAILURE_PHASES]);

export function validateWorkerResult(raw, { jobId, sessionId, executionId = null, stdoutEncoding }) {
  if (stdoutEncoding !== "utf8" && stdoutEncoding !== "base64") {
    throw failClosed("result-stdout-encoding");
  }
  if (!plainData(raw)) throw failClosed("result-shape");
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify([...RESULT_KEYS].sort())) {
    throw failClosed("result-shape");
  }
  if (raw.type !== TRANSPORT_MESSAGE_TYPES.RESULT) throw failClosed("result-type");
  if (raw.sessionId !== sessionId || raw.jobId !== jobId ||
      (executionId !== null && raw.executionId !== executionId)) {
    throw failClosed("result-identity-mismatch");
  }
  if (raw.ok !== true && raw.ok !== false) throw failClosed("result-ok");
  if (!PHASES.has(raw.phase)) throw failClosed("result-phase");
  // phase↔ok consistency: ok:true ⇒ phase "completed"; ok:false ⇒ a failure phase.
  if (raw.ok === true && !OK_PHASES.has(raw.phase)) throw failClosed("result-phase-ok-conflict");
  if (raw.ok === false && !FAILURE_PHASES.has(raw.phase)) throw failClosed("result-phase-ok-conflict");
  if (typeof raw.workerInstanceId !== "string" ||
      raw.workerInstanceId.length === 0 ||
      utf8Bytes(raw.workerInstanceId) > EXECUTOR_BOUNDS.maxWorkerInstanceIdBytes) {
    throw failClosed("result-worker-id");
  }
  if (raw.ok === true) {
    if (raw.result !== null) throw failClosed("result-value");
    if (!plainData(raw.counters) ||
        JSON.stringify(Object.keys(raw.counters).sort()) !==
          JSON.stringify([...COUNTER_KEYS].sort())) {
      throw failClosed("result-counters");
    }
    for (const key of COUNTER_KEYS) {
      if (!Number.isSafeInteger(raw.counters[key]) || raw.counters[key] < 0) {
        throw failClosed("result-counters");
      }
    }
    if (raw.error !== null) throw failClosed("result-conflict");
    if (raw.errno !== null) throw failClosed("result-conflict");
    if (!Number.isSafeInteger(raw.stdoutBytes) || raw.stdoutBytes < 0 ||
        raw.stdoutBytes > EXECUTOR_BOUNDS.maxResponseBytes ||
        !Number.isSafeInteger(raw.stderrBytes) || raw.stderrBytes < 0 ||
        raw.stderrBytes > EXECUTOR_BOUNDS.maxResponseBytes) {
      throw failClosed("result-bounds");
    }
    // the byte counts MUST equal the corresponding counters.
    if (raw.stdoutBytes !== raw.counters.stdoutBytes ||
        raw.stderrBytes !== raw.counters.stderrBytes) {
      throw failClosed("result-bytes-mismatch");
    }
    // The immutable job encoding selects exactly one output arm. Text stays
    // exact UTF-8; binary stays inert canonical base64 and is never decoded as
    // text. Canonical decoding includes strict grammar + re-encode equality.
    if (stdoutEncoding === "utf8") {
      if (typeof raw.stdout !== "string" || raw.stdoutBase64 !== null ||
          utf8Bytes(raw.stdout) !== raw.stdoutBytes) {
        throw failClosed("result-content");
      }
    } else {
      if (raw.stdout !== null || typeof raw.stdoutBase64 !== "string" ||
          raw.stdoutBase64.length > EXECUTOR_BOUNDS.maxBase64ResponseChars) {
        throw failClosed("result-content");
      }
      let decoded;
      try {
        decoded = decodeCanonicalBase64(raw.stdoutBase64);
      } catch {
        throw failClosed("result-content");
      }
      if (decoded.byteLength > EXECUTOR_BOUNDS.maxBinaryResponseBytes ||
          decoded.byteLength !== raw.stdoutBytes ||
          decoded.byteLength !== raw.counters.stdoutBytes) {
        throw failClosed("result-bytes-mismatch");
      }
    }
    if (typeof raw.stderr !== "string" || utf8Bytes(raw.stderr) !== raw.stderrBytes) {
      throw failClosed("result-content");
    }
  } else {
    if (typeof raw.error !== "string" || raw.error.length === 0 ||
        utf8Bytes(raw.error) > EXECUTOR_BOUNDS.maxTransportErrorBytes) {
      throw failClosed("result-error");
    }
    if (raw.counters !== null) throw failClosed("result-conflict");
    if (raw.result !== null) throw failClosed("result-conflict");
    if (raw.stdoutBytes !== 0 || raw.stderrBytes !== 0) {
      throw failClosed("result-conflict");
    }
    if (raw.stdout !== "" || raw.stdoutBase64 !== null || raw.stderr !== "") {
      throw failClosed("result-conflict");
    }
    if (raw.errno !== null && !Number.isSafeInteger(raw.errno)) {
      throw failClosed("result-conflict");
    }
  }
  return Object.freeze({
    // The full exact envelope preserves the selected output arm unchanged.
    type: raw.type,
    sessionId: raw.sessionId,
    executionId: raw.executionId,
    jobId: raw.jobId,
    ok: raw.ok === true,
    phase: raw.phase,
    result: raw.result,
    counters: raw.ok === true ? Object.freeze({ ...raw.counters }) : null,
    stdoutBytes: raw.stdoutBytes,
    stderrBytes: raw.stderrBytes,
    stdout: raw.ok === true ? raw.stdout : "",
    stdoutBase64: raw.ok === true ? raw.stdoutBase64 : null,
    stderr: raw.ok === true ? raw.stderr : "",
    workerInstanceId: raw.workerInstanceId,
    error: raw.ok === true ? null : boundedString(raw.error, EXECUTOR_BOUNDS.maxTransportErrorBytes),
    errno: Number.isSafeInteger(raw.errno) ? raw.errno : null,
  });
}

function defaultCreateWorker(workerUrl) {
  return new Worker(workerUrl, { type: "module" });
}

/** The bounded executor. `authority` is the SEPARATELY SUPPLIED fence record
 * (never self-asserted); `buildRequest` receives the authority's sessionId. */
export class WasmExecutor {
  constructor({
    workerUrl,
    createWorker = null,
    now = () => Date.now(),
    startupMs = EXECUTOR_BOUNDS.maxWorkerStartupMs,
    callMs = EXECUTOR_BOUNDS.maxCallMs,
  } = {}) {
    if (!workerUrl || typeof workerUrl !== "string") {
      throw new TypeError("executor_worker_url");
    }
    this._workerUrl = workerUrl;
    this._createWorker = createWorker ?? ((url) => defaultCreateWorker(url));
    this._now = now;
    this._startupMs = startupMs;
    this._callMs = callMs;
  }

  async run({ job, wasmBytes, buildRequest, authority, signal = null }) {
    // 1. The authority is REQUIRED + validated BEFORE any worker.
    const fences = validateAuthorityRecord(authority);
    checkJobAgainstAuthority(job, fences);

    // 2. The bounded request; the sessionId on the envelope is the
    //    AUTHORITY's (never request-borne).
    let request;
    try {
      request = buildRequest({ sessionId: fences.sessionId, job, wasmBytes });
    } catch (error) {
      throw failClosed("request-build", String(error?.message ?? error));
    }
    if (!plainData(request) || request.type !== TRANSPORT_MESSAGE_TYPES.JOB) {
      throw failClosed("request-shape");
    }
    // Strict logical measurement: the wasm bytes are capped independently at
    // maxWasmBytes (the tiny-tier max) while the metadata JSON keeps the
    // 64 KiB cap — the measure throws request-wasm / request-over-budget.
    measureRequestBytes(request);

    // 3. ONE fresh dedicated worker (the ONLY execution path).
    let worker = null;
    let settled = false;
    const startedAt = this._now();
    const deadline = startedAt + this._callMs;

    const cleanup = () => {
      if (!worker) return;
      try { worker.terminate(); } catch { /* best effort */ }
      worker = null;
    };

    try {
      worker = this._createWorker(this._workerUrl);
      if (!worker || typeof worker.postMessage !== "function") {
        throw failClosed("worker-spawn", "the worker factory returned no worker");
      }
    } catch (error) {
      cleanup();
      throw failClosed("worker-spawn", String(error?.message ?? error));
    }

    // 4. Post + race the FIRST worker message against the wall deadline.
    try {
      worker.postMessage(request);
    } catch (error) {
      cleanup();
      throw failClosed("request-post", String(error?.message ?? error));
    }

    const resultPromise = new Promise((resolve, reject) => {
      let deadlineTimer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", abortHandler);
        }
        cleanup();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const abortHandler = () => {
        finish(failClosed("call-aborted"));
      };
      deadlineTimer = setTimeout(() => {
        finish(failClosed("call-timeout"));
      }, Math.max(1, deadline - this._now()));
      if (signal) {
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }

      worker.onerror = (event) => {
        finish(failClosed("worker-error", event?.message ?? "worker error"));
      };
      worker.onmessage = (event) => {
        if (settled) return;
        const message = event.data;
        if (message?.type !== TRANSPORT_MESSAGE_TYPES.RESULT) {
          finish(failClosed("message-type", boundedString(String(message?.type ?? "unknown"), 64)));
          return;
        }
        try {
          finish(validateWorkerResult(message, {
            jobId: String(job?.context?.callId ?? ""),
            sessionId: fences.sessionId,
            executionId: fences.executionId,
            stdoutEncoding: job.stdoutEncoding,
          }));
        } catch (error) {
          finish(error);
        }
      };
    });

    try {
      const result = await resultPromise;
      cleanup();
      return result;
    } catch (error) {
      cleanup();
      if (error?.executorCode === "call-timeout") {
        return Object.freeze({
          ok: false, phase: "timeout",
          error: "wall deadline exceeded; worker terminated",
          workerInstanceId: null, counters: null, stdoutBytes: 0, stderrBytes: 0,
          stdout: "", stdoutBase64: null, stderr: "",
          result: null, errno: null,
        });
      }
      throw error;
    }
  }
}

// ── Strict request-byte measurement (CAP-FB-20260822-TOOL-PREVIEW-EXEC-02) ──
// The JSON-stringify budget inflated a wasm byte ARRAY (~4 chars/byte), so
// 28–33 KiB binaries tripped request-over-budget even though the logical
// envelope was far below 64 KiB. The real transport is structured clone
// (one byte per element), so the bound is measured as `wasmBytes.length` +
// the metadata JSON (wasmBytes excluded). The 64 KiB total is PRESERVED.
function isDenseByteSequence(value) {
  if (value instanceof Uint8Array) return true;
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) return false; // a hole is not dense
    const byte = value[index];
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return false;
    }
  }
  return true;
}

export function measureRequestBytes(request) {
  if (!plainData(request)) throw failClosed("request-shape");
  const wasm = request.wasmBytes;
  // The wasm bytes are capped independently at maxWasmBytes (the tiny-tier
  // max — never an unbounded raise); the metadata JSON keeps the 64 KiB cap.
  if (!isDenseByteSequence(wasm) || wasm.length < 8 ||
      wasm.length > EXECUTOR_BOUNDS.maxWasmBytes) {
    throw failClosed("request-wasm");
  }
  const meta = { ...request };
  delete meta.wasmBytes;
  const metadataBytes = utf8Bytes(JSON.stringify(meta));
  if (metadataBytes > EXECUTOR_BOUNDS.maxRequestBytes) {
    throw failClosed("request-over-budget");
  }
  return wasm.length + metadataBytes;
}
