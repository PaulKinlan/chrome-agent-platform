// extension/lib/script-sandbox-modules.js — Pre-execution digest verification
// and module resolution helpers for installable JavaScript modules in the
// script sandbox (ovfm.1 / docs/SANDBOX-JS-MODULES-DESIGN.md).
//
// Invariants:
// 1. Module Name Validation: bare specifiers must be non-empty and match
//    /^[a-z0-9_@/-]+$/i (no spaces, no quotes, no path-traversal "../").
// 2. Cryptographic Re-hash Before Minting: module bytes MUST be re-hashed
//    and verified against the registered SHA-256 digest BEFORE any Blob URL
//    is created or mounted.
// 3. Fail-Closed on Mismatch: a corrupted or substituted module fails closed
//    with error.code = "digest_mismatch"; createBlobUrl is NEVER invoked.

import { createSha256 } from "./pure.js";
import { verifyAndReadOwnerBlobBytes } from "./user-wasm-store.js";

export const JS_MODULE_NAME_RE = /^[a-z0-9_@/-]+$/i;

/** Validate a bare module specifier. */
export function validateJsModuleName(name) {
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError("Module name must be a non-empty string");
  }
  const trimmed = name.trim();
  if (trimmed.includes("..") || trimmed.startsWith("/") || !JS_MODULE_NAME_RE.test(trimmed)) {
    throw new Error(`Invalid module name: "${name}" (use alphanumeric, @, _, -, /)`);
  }
  return trimmed;
}

/** Compute SHA-256 hex digest of Uint8Array bytes using pure.js createSha256. */
export function computeModuleDigest(bytes) {
  const hash = createSha256();
  hash.update(bytes);
  return hash.hex();
}

/**
 * Verify module content against claimed SHA-256 digest and prepare it for
 * resolution.
 *
 * CRITICAL SECURITY INVARIANT:
 * Digest verification runs and succeeds BEFORE createBlobUrl is invoked. If
 * the computed hash does not equal the claimed digest, throws a typed
 * `digest_mismatch` error and createBlobUrl is NEVER called.
 *
 * @param {{
 *   name: string,
 *   digest: string,
 *   bytes: Uint8Array | ArrayBuffer,
 *   createBlobUrl?: (bytes: Uint8Array) => string,
 * }} options
 * @returns {{ name: string, digest: string, blobUrl: string }}
 */
export function verifyAndPrepareJsModule({
  name,
  digest,
  bytes,
  createBlobUrl = (b) => URL.createObjectURL(new Blob([b], { type: "text/javascript" })),
}) {
  const validName = validateJsModuleName(name);
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest)) {
    const err = new Error(`Invalid module digest: ${digest}`);
    err.code = "invalid_digest";
    throw err;
  }
  const cleanDigest = digest.toLowerCase();
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) {
    throw new TypeError("Module bytes must be a Uint8Array or ArrayBuffer");
  }
  const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  // Pre-execution cryptographic re-hash
  const computed = computeModuleDigest(uint8);
  if (computed !== cleanDigest) {
    const error = new Error(`module_digest_mismatch for "${validName}": expected ${cleanDigest}, computed ${computed}`);
    error.code = "digest_mismatch";
    error.moduleName = validName;
    error.expected = cleanDigest;
    error.computed = computed;
    throw error;
  }

  // Mint Blob URL only AFTER digest verification succeeds
  const blobUrl = createBlobUrl(uint8);
  return Object.freeze({
    name: validName,
    digest: cleanDigest,
    blobUrl,
  });
}

/**
 * Read and verify a stored JS module from the shared owner-blob store.
 */
export async function readAndVerifyJsModule({
  name,
  digest,
  storage = globalThis.navigator?.storage,
  locks = globalThis.navigator?.locks,
  createBlobUrl,
} = {}) {
  const bytes = await verifyAndReadOwnerBlobBytes({ digest, storage, locks });
  return verifyAndPrepareJsModule({ name, digest, bytes, createBlobUrl });
}
