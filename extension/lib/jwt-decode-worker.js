// lib/jwt-decode-worker.js — the bounded JWT inspection worker (browser Worker).
// Pure decode only: no signature verification, no keys, no network/filesystem.
import { decodeJwtBounded, JwtDecodeError, validateWorkerRequest } from "./jwt-decode-core.js";

self.onmessage = (event) => {
  const rawRequest = event?.data;
  let id = null;
  try {
    const request = validateWorkerRequest(rawRequest);
    id = request.id;
    const result = decodeJwtBounded(request.params.token);
    self.postMessage({ schemaVersion: 1, id, ok: true, result });
  } catch (error) {
    const safe =
      error instanceof JwtDecodeError
        ? error
        : new JwtDecodeError(1, "WORKER_FAILURE", "jwt: Worker execution failed");
    self.postMessage({
      schemaVersion: 1,
      id,
      ok: false,
      error: { exitCode: safe.exitCode, code: safe.code, diagnostic: safe.diagnostic },
    });
  }
};
