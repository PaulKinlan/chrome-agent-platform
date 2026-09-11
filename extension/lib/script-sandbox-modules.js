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
 * Prepare a script source for execution as an ES module in the sandbox.
 * If the source already has explicit export declarations (export default, export const, etc.),
 * it is returned as an explicit module.
 * If the source has static imports and statements (with return), the imports are
 * hoisted to module top-level and the remaining body is wrapped in an async default export.
 * If the source has no static imports or exports, returns isExplicitModule: false.
 */
export function prepareScriptModuleSource(source) {
  if (typeof source !== "string") {
    return { isExplicitModule: false, hasImports: false, source: "" };
  }
  if (/^\s*export\s+(default|const|let|var|function|class|\{)/m.test(source)) {
    return { isExplicitModule: true, hasImports: true, source };
  }
  const importRegex = /^\s*import\s+(?:[\s\S]*?from\s+)?["\x27][^"\x27]+["\x27]\s*;?/gm;
  const imports = [];
  let hasImports = false;
  const body = source.replace(importRegex, (match) => {
    hasImports = true;
    imports.push(match.trim());
    return "";
  });

  if (!hasImports) {
    return { isExplicitModule: false, hasImports: false, source };
  }

  const moduleText = imports.join("\n") +
    "\nexport default async function() {\n" +
    body +
    "\n};\n";
  return { isExplicitModule: true, hasImports: true, source: moduleText };
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
 *   bytes: string | Uint8Array | ArrayBuffer,
 *   createBlobUrl?: ((bytes: Uint8Array) => string) | null,
 * }} options
 * @returns {{ name: string, digest: string, blobUrl: string | null, bytes: Uint8Array }}
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

  let uint8;
  if (typeof bytes === "string") {
    uint8 = new TextEncoder().encode(bytes);
  } else if (bytes instanceof Uint8Array) {
    uint8 = bytes;
  } else if (bytes instanceof ArrayBuffer) {
    uint8 = new Uint8Array(bytes);
  } else {
    throw new TypeError("Module bytes must be a string, Uint8Array, or ArrayBuffer");
  }

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
  const blobUrl = createBlobUrl ? createBlobUrl(uint8) : null;
  return Object.freeze({
    name: validName,
    digest: cleanDigest,
    blobUrl,
    bytes: uint8,
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

/**
 * Resolve an array of module references (either with inline source/bytes or
 * stored in OPFS) and verify their digests.
 */
export async function resolveScriptModules(modules = [], { storage, locks } = {}) {
  if (!Array.isArray(modules) || modules.length === 0) return [];
  const resolved = [];
  for (const mod of modules) {
    if (!mod || typeof mod !== "object") continue;
    const name = validateJsModuleName(mod.name);
    const digest = String(mod.digest || "").toLowerCase();
    if (typeof mod.source === "string" || mod.bytes instanceof Uint8Array || mod.bytes instanceof ArrayBuffer) {
      const verified = verifyAndPrepareJsModule({
        name,
        digest,
        bytes: typeof mod.source === "string" ? mod.source : mod.bytes,
        createBlobUrl: null,
      });
      resolved.push({
        name: verified.name,
        digest: verified.digest,
        bytes: verified.bytes,
      });
    } else {
      const record = await readAndVerifyJsModule({ name, digest, storage, locks, createBlobUrl: null });
      resolved.push({
        name: record.name,
        digest: record.digest,
        bytes: record.bytes,
      });
    }
  }
  return resolved;
}

