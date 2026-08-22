// lib/jwt-decode-tools.js — bounded JWT inspection lane (disabled metadata).
// Pure unverified decode only: `verified: false`, no keys, no claim validation,
// no crypto. Nothing here is admitted or granted a route — the descriptor is
// disabled and there is NO provider cutover.

import { decodeInDedicatedWorker } from "./jwt-decode.js";

export const JWT_DECODE_TOOL = Object.freeze({
  toolId: "jwt_decode_bounded",
  sourceKind: "bundled-package",
  packageId: "core-jwt-decode",
  version: "1.0.0",
  canonicalNameClaim: false,
  admitted: false,
  canExecute: false,
  canGrant: false,
  availability: "disabled",
  capabilities: Object.freeze(["compute", "data.read"]),
  replayClass: "read-only",
  spdxLicense: "MIT",
  licenceStatus: "owner-authorized",
  bounds: Object.freeze({
    tokenUtf8Bytes: 16384,
    jsonDepth: 32,
    outputUtf8BytesIncludingLf: 32768,
    workerWallMilliseconds: 2000,
  }),
});

export { decodeInDedicatedWorker };
