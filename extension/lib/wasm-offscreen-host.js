// lib/wasm-offscreen-host.js — the isolated execution-host contract used by
// the bounded Settings preview.
//
// It has no provider/tool-catalog selection binding and no OPFS/artifact
// mutation authority. The owner-only Settings route supplies already pinned
// package bytes; each call is fenced and executed in a fresh Worker.
//
// The workspace is supplied by the WORKER side (a per-job synchronous model,
// wasm-sync-workspace.js) — the LANDED WASI adapters are synchronous, so no
// cross-context file-op RPC exists. This host's job is: validate the strict
// bounded request, check the job against the HOST-BOUND authoritative fence
// record (never self-asserted), and run the bounded executor.

import { WasmExecutor, TRANSPORT_MESSAGE_TYPES, validateAuthorityRecord, checkJobAgainstAuthority } from "./wasm-executor.js";
import { createWasiJob } from "./wasm-host-types.js";
import { EXECUTOR_BOUNDS } from "./wasm-executor-bounds.js";

function failClosed(code, detail) {
  const error = new Error(`offscreen-host fail-closed: ${code}`);
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

const REQUEST_KEYS = Object.freeze(["type", "job", "wasmBytes"]);

/** The STRICT EXACT-key bounded job-request schema. The request carries ONLY
 * the job + wasmBytes — the fences come from the host-bound authority. */
export function validateOffscreenRequest(raw) {
  if (!plainData(raw)) throw failClosed("request-shape");
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify([...REQUEST_KEYS].sort())) {
    throw failClosed("request-shape");
  }
  if (raw.type !== TRANSPORT_MESSAGE_TYPES.JOB) throw failClosed("request-type");
  if (!(raw.wasmBytes instanceof Uint8Array) || raw.wasmBytes.byteLength < 8) {
    throw failClosed("request-wasm");
  }
  // Cap the wasm bytes BEFORE the copy (the JSON budget downstream cannot
  // prevent this allocation).
  if (raw.wasmBytes.byteLength > EXECUTOR_BOUNDS.maxWasmBytes) {
    throw failClosed("request-wasm-over-budget");
  }
  const job = createWasiJob(raw.job); // strict + bounded (the landed types)
  return Object.freeze({
    type: raw.type,
    job,
    wasmBytes: new Uint8Array(raw.wasmBytes),
  });
}

/** The offscreen host. `authority` is the SEPARATELY SUPPLIED authoritative
 * fence record the host is bound to (the future durable run record supplies
 * it); handleJob is inert until a future reviewed route calls it. */
export function createOffscreenWasmHost({ executor, authority }) {
  if (!(executor instanceof WasmExecutor)) {
    throw new TypeError("offscreen_executor");
  }
  const fences = validateAuthorityRecord(authority);

  return Object.freeze({
    authority: fences,
    async handleJob(request) {
      const validated = validateOffscreenRequest(request);
      // The job context is checked against the BOUND authority (execution/
      // call/origin/workspaceRoot) — no self-asserted values.
      checkJobAgainstAuthority(validated.job, fences);
      const result = await executor.run({
        job: validated.job,
        wasmBytes: validated.wasmBytes,
        authority: fences,
        buildRequest: ({ sessionId, job, wasmBytes }) =>
          Object.freeze({
            type: TRANSPORT_MESSAGE_TYPES.JOB,
            sessionId, // the AUTHORITY's session — never request-borne
            job: {
              context: job.context,
              args: job.args,
              stdin: job.stdin,
              quota: job.quota,
              tier: job.tier,
              acceptedExitCodes: job.acceptedExitCodes,
              stdoutEncoding: job.stdoutEncoding,
              workspaceSeed: job.workspaceSeed,
            },
            wasmBytes: Array.from(wasmBytes),
          }),
      });
      return result;
    },
  });
}
