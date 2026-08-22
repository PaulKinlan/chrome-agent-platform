// lib/jwt-decode.js — bounded JWT inspection (browser-native fresh Worker).
// Pure decode only: `verified: false`, no keys, no claim validation, no crypto.
import { JwtDecodeError } from "./jwt-decode-core.js";

const DEFAULT_WORKER_URL = new URL("./jwt-decode-worker.js", import.meta.url);
export const WORKER_TIMEOUT_MS = 2_000;

function isExactErrorResponse(response, requestId) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) return false;
  if (Object.keys(response).sort().join(",") !== "error,id,ok,schemaVersion") return false;
  if (response.schemaVersion !== 1 || (response.id !== requestId && response.id !== null) || response.ok !== false) {
    return false;
  }
  const error = response.error;
  return (
    error !== null &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    Object.keys(error).sort().join(",") === "code,diagnostic,exitCode" &&
    (error.exitCode === 1 || error.exitCode === 2) &&
    typeof error.code === "string" &&
    typeof error.diagnostic === "string"
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactSuccessResponse(response, requestId) {
  if (!isRecord(response)) return false;
  const result = response.result;
  return (
    Object.keys(response).sort().join(",") === "id,ok,result,schemaVersion" &&
    response.schemaVersion === 1 &&
    response.id === requestId &&
    response.ok === true &&
    isRecord(result) &&
    Object.keys(result).join(",") === "header,payload,verified,warnings" &&
    isRecord(result.header) &&
    isRecord(result.payload) &&
    result.verified === false &&
    Array.isArray(result.warnings) &&
    result.warnings.length >= 1 &&
    result.warnings.length <= 2 &&
    result.warnings.every((warning) => typeof warning === "string") &&
    result.warnings[0] ===
      "WARNING: JWT signature was not verified; header and payload claims are untrusted."
  );
}

export function runRequestInDedicatedWorker(
  request,
  { workerUrl = DEFAULT_WORKER_URL, timeoutMs = WORKER_TIMEOUT_MS } = {},
) {
  if (!(workerUrl instanceof URL) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > WORKER_TIMEOUT_MS) {
    return Promise.reject(new JwtDecodeError(2, "WORKER_OPTIONS", "jwt: invalid Worker execution options"));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      action(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new JwtDecodeError(1, "WORKER_TIMEOUT", "jwt: execution timed out"));
    }, timeoutMs);
    worker.onmessage = (event) => {
      const response = event?.data;
      if (isExactSuccessResponse(response, request.id)) {
        finish(resolve, response.result);
      } else if (isExactErrorResponse(response, request.id)) {
        finish(
          reject,
          new JwtDecodeError(response.error.exitCode, response.error.code, response.error.diagnostic),
        );
      } else {
        finish(reject, new JwtDecodeError(1, "WORKER_RESPONSE", "jwt: invalid Worker response schema"));
      }
    };
    worker.onerror = () => {
      finish(reject, new JwtDecodeError(1, "WORKER_FAILURE", "jwt: Worker execution failed"));
    };
    worker.postMessage(request);
  });
}

export function decodeInDedicatedWorker(token) {
  return runRequestInDedicatedWorker({
    schemaVersion: 1,
    id: "decode-1",
    method: "jwt_decode_bounded",
    params: { token },
  });
}
