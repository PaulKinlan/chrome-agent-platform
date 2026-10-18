// scripts/lib/wasm-manifest-assets.mjs — the single schema-aware
// manifest→physical-asset mapping (chrome-agent-platform-ltkj.2 contract:
// generator emit, production-build scan (build.mjs) and the Store archive map
// (package-archive.mjs) share ONE mapping rule instead of three parsers).
//
// Schema 1: manifest.executables[] → content-addressed CAS binaries; the
// executable record is the scan identity.
// Schema 2: manifest.assets[] roles main-wasm/side-wasm → CAS binaries (scan
// identity is the typed asset record); roles adapter/glue/pthread-bootstrap/
// data are runtime data assets, never CAS members.
//
// Fails closed on: unsupported schemaVersion, missing/malformed content
// addresses, unknown schema-2 asset roles, a wasm asset whose declared path is
// not its exact CAS path, a non-wasm asset squatting a CAS path, duplicate
// mappings within one manifest, and inventory-row manifest digest drift.

import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { WasmPackageAuthority, canonicalJson } from "../../extension/lib/wasm-package-authority.js";
import { REVIEWED_RUNTIME_JS } from "./reviewed-runtime-js.mjs";

const CAS_RE = /^extension\/wasm\/cas\/[0-9a-f]{64}\.wasm$/u;
const HEX64_RE = /^[0-9a-f]{64}$/u;
const WASM_ROLES = new Set(["main-wasm", "side-wasm"]);
const SCHEMA2_ROLES = new Set(["adapter", "glue", "main-wasm", "side-wasm", "pthread-bootstrap", "data"]);

const probe = new WasmPackageAuthority();

export function wasmManifestMappingError(message) {
  const error = new Error(`wasm-manifest-assets: ${message}`);
  error.code = "manifest_mapping_invalid";
  return error;
}

/**
 * Map one parsed manifest to its content-addressed Wasm members.
 * @param {object} manifest parsed manifest JSON
 * @returns {{casRel: string, schemaVersion: 1|2, executable: object|null, asset: object|null}[]}
 */
export function manifestCasMappings(manifest) {
  if (manifest?.schemaVersion === 1) {
    if (!Array.isArray(manifest.executables) || manifest.executables.length === 0) {
      throw wasmManifestMappingError("schema-1 manifest without an executables array");
    }
    const out = [];
    for (const executable of manifest.executables) {
      if (!HEX64_RE.test(executable?.sha256 ?? "")) {
        throw wasmManifestMappingError(`schema-1 executable without a CAS content address: ${executable?.id ?? "?"}`);
      }
      out.push({ casRel: `extension/wasm/cas/${executable.sha256}.wasm`, schemaVersion: 1, executable, asset: null });
    }
    return assertUnique(out);
  }
  if (manifest?.schemaVersion === 2) {
    if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
      throw wasmManifestMappingError("schema-2 manifest without an assets array");
    }
    const out = [];
    for (const asset of manifest.assets) {
      if (!SCHEMA2_ROLES.has(asset?.role)) {
        throw wasmManifestMappingError(`unknown schema-2 asset role: ${asset?.role}`);
      }
      if (!HEX64_RE.test(asset?.sha256 ?? "")) {
        throw wasmManifestMappingError(`schema-2 asset without a content address: ${asset?.id ?? "?"}`);
      }
      if (WASM_ROLES.has(asset.role)) {
        const casRel = `extension/wasm/cas/${asset.sha256}.wasm`;
        // The manifest validator already pins wasm assets to their exact CAS
        // path; re-asserted here so no consumer can map a drifted pair.
        if (asset.path !== casRel || !CAS_RE.test(casRel)) {
          throw wasmManifestMappingError(`schema-2 wasm asset path outside its CAS address: ${asset?.path}`);
        }
        out.push({ casRel, schemaVersion: 2, executable: null, asset });
      } else if (/^extension\/wasm\/cas\//u.test(asset.path ?? "")) {
        throw wasmManifestMappingError(`non-wasm schema-2 asset inside the CAS namespace: ${asset?.path}`);
      }
    }
    return assertUnique(out);
  }
  throw wasmManifestMappingError(`unsupported manifest schemaVersion: ${manifest?.schemaVersion}`);
}

// Inventory identity is independent of CAS identity: two packages may share
// identical bytes, but the same package@version must never be listed twice.
export function registerBundledManifestIdentity(seen, identity, manifest) {
  const key = `${identity?.pkg ?? ""}\0${identity?.version ?? ""}`;
  if (!identity?.pkg || !identity?.version || seen.has(key) ||
      manifest?.package?.id !== identity.pkg || manifest?.package?.version !== identity.version) {
    throw wasmManifestMappingError(`duplicate bundled Wasm manifest mapping or identity mismatch: ${key}`);
  }
  const validated = probe.validateManifest(canonicalJson(manifest));
  if (!validated.ok) {
    throw wasmManifestMappingError(`bundled Wasm manifest invalid for ${key}: ${validated.error}`);
  }
  seen.add(key);
}

/** One physical CAS member may have multiple independently digest-bound schema-1
 * call-export claimants. No other duplicate is permitted. Return true for the
 * first claim so consumers retain exactly one physical scan/map entry. */
export function recordBundledWasmClaim(claims, mapping, manifest) {
  const { casRel, schemaVersion, executable } = mapping;
  const prior = claims.get(casRel);
  if (!prior) {
    claims.set(casRel, [{ mapping, manifest }]);
    return true;
  }
  const representative = prior[0];
  const old = representative.mapping.executable;
  if (schemaVersion !== 1 || representative.mapping.schemaVersion !== 1 ||
      !executable?.callExport || !old?.callExport) {
    throw wasmManifestMappingError(`duplicate bundled Wasm manifest mapping: ${casRel}`);
  }
  const { id: _id, callExport: call, ...physical } = executable;
  const { id: _oldId, callExport: oldCall, ...oldPhysical } = old;
  const { digestBytes: _digest, initParam: _init, finalParam: _final, ...abi } = call;
  const { digestBytes: _oldDigest, initParam: _oldInit, finalParam: _oldFinal, ...oldAbi } = oldCall;
  const common = (m) => ({ build: m.build, license: m.license, source: m.source,
    signer: m.signer, packageType: m.package?.type, packageVersion: m.package?.version });
  if (!isDeepStrictEqual(physical, oldPhysical) || !isDeepStrictEqual(abi, oldAbi) ||
      !isDeepStrictEqual(common(manifest), common(representative.manifest))) {
    throw wasmManifestMappingError(`bundled Wasm variant divergence: ${casRel}`);
  }
  prior.push({ mapping, manifest });
  return false;
}

// The SAME byte-exact JS authority is consumed by the Store build's shipped-
// code scan and by the ZIP policy. Keys are archive paths (no "extension/"
// prefix); values include only the manifest-reviewed role, size and digest.
// Neither a repinned manifest alone nor an inventory row alone may waive an
// AST scan. The injected reader is scoped to the consumer's immutable tree.
export async function buildSchema2RuntimeJsMap(inventory, { readBytes, reviewedSources = REVIEWED_RUNTIME_JS } = {}) {
  if (!Array.isArray(inventory?.files) || !Array.isArray(inventory?.manifests) ||
      typeof readBytes !== "function") {
    throw wasmManifestMappingError("schema-2 JS map requires inventory and a byte reader");
  }
  // reviewedSources is injectable only for in-memory synthetic tests; the
  // build and package callers always use the immutable reviewed source table.
  if (!reviewedSources || typeof reviewedSources !== "object") {
    throw wasmManifestMappingError("schema-2 JS map requires reviewed source identities");
  }
  const runtimeJs = /^extension\/wasm\/.+\.(?:m?js)$/u;
  const reviewedJs = /^extension\/wasm\/runtime\/.+\.(?:m?js)$/u;
  const fileRows = new Map();
  for (const row of inventory.files) {
    if (!runtimeJs.test(row?.rel ?? "")) continue;
    if (fileRows.has(row.rel)) throw wasmManifestMappingError(`duplicate runtime JS inventory row: ${row.rel}`);
    fileRows.set(row.rel, row);
  }
  const seenIdentities = new Set();
  const mapped = new Map();
  let schema2AdmissionReady = false;
  for (const identity of inventory.manifests) {
    const manifestRel = `extension/wasm/manifests/${identity?.pkg}-${identity?.version}.manifest.json`;
    if (!inventory.files.some((row) => row?.rel === manifestRel)) {
      throw wasmManifestMappingError(`schema-2 JS map missing declared manifest: ${manifestRel}`);
    }
    let manifestBytes;
    try { manifestBytes = await readBytes(manifestRel); }
    catch { throw wasmManifestMappingError(`schema-2 JS map cannot read manifest: ${manifestRel}`); }
    const manifestRow = inventory.files.find((row) => row?.rel === manifestRel);
    if (!(manifestBytes instanceof Uint8Array) || manifestBytes.byteLength !== manifestRow.size ||
        createHash("sha256").update(manifestBytes).digest("hex") !== manifestRow.sha256) {
      throw wasmManifestMappingError(`schema-2 JS map manifest file pin drift: ${manifestRel}`);
    }
    let manifestText;
    try { manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes); }
    catch { throw wasmManifestMappingError(`schema-2 JS map invalid manifest encoding: ${manifestRel}`); }
    assertManifestRowDigest(manifestText, identity);
    const manifest = JSON.parse(manifestText);
    if (manifest?.schemaVersion !== 2) continue;
    if (!schema2AdmissionReady) {
      // Node-only build/package helper. The SW never imports this broker.
      await import("../../extension/lib/wasm-package-admission.js");
      schema2AdmissionReady = true;
    }
    registerBundledManifestIdentity(seenIdentities, identity, manifest);
    manifestCasMappings(manifest); // enforce shared role/CAS mapping even for JS-only claims
    for (const asset of manifest.assets) {
      if (!/\.(?:m?js)$/u.test(asset.path ?? "")) continue;
      const rel = asset.path;
      if (!reviewedJs.test(rel) || WASM_ROLES.has(asset.role) || !SCHEMA2_ROLES.has(asset.role)) {
        throw wasmManifestMappingError(`schema-2 JS asset is not a runtime data role: ${rel}`);
      }
      const archivePath = rel.slice("extension/".length);
      const row = fileRows.get(rel);
      if (mapped.has(archivePath)) throw wasmManifestMappingError(`duplicate runtime JS asset mapping: ${archivePath}`);
      if (!row || row.sha256 !== asset.sha256 || row.size !== asset.size) {
        throw wasmManifestMappingError(`runtime JS inventory pin drift: ${archivePath}`);
      }
      // An inventory row and a manifest digest can both be regenerated in an
      // unreviewed tree. They NEVER suffice for an AST-scan exemption: the
      // distinct manually approved source commit + review bead must also pin
      // this asset's original bytes. No entry means no schema-2 JS waiver.
      const review = Object.hasOwn(reviewedSources, archivePath) ? reviewedSources[archivePath] : null;
      if (!review || review.packageId !== identity.pkg || review.version !== identity.version ||
          review.role !== asset.role || review.sha256 !== asset.sha256 || review.size !== asset.size ||
          !/^[0-9a-f]{40}$/u.test(review.sourceCommit ?? "") ||
          !/^chrome-agent-platform-[a-z0-9.]+$/u.test(review.reviewBead ?? "") ||
          typeof review.sourcePath !== "string" || !review.sourcePath.startsWith("packages/bundled/evidence/")) {
        throw wasmManifestMappingError(`runtime JS review anchor missing or drifted: ${archivePath}`);
      }
      let bytes;
      try { bytes = await readBytes(rel); }
      catch { throw wasmManifestMappingError(`runtime JS unreadable: ${archivePath}`); }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== asset.size ||
          createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
        throw wasmManifestMappingError(`runtime JS byte drift: ${archivePath}`);
      }
      mapped.set(archivePath, Object.freeze({ role: asset.role, size: asset.size, sha256: asset.sha256 }));
    }
  }
  for (const rel of fileRows.keys()) {
    if (!mapped.has(rel.slice("extension/".length))) {
      throw wasmManifestMappingError(`unlisted runtime JS inventory row: ${rel}`);
    }
  }
  return mapped;
}

function assertUnique(out) {
  const seen = new Set();
  for (const entry of out) {
    if (seen.has(entry.casRel)) throw wasmManifestMappingError(`duplicate CAS mapping within one manifest: ${entry.casRel}`);
    seen.add(entry.casRel);
  }
  return out;
}

/**
 * Digest-drift guard: the shipped manifest bytes must reproduce the exact
 * digest recorded in the generated inventory row (same authority method the
 * generator used at emit time).
 * @param {string} manifestText shipped manifest file text
 * @param {{pkg: string, version: string, digest: string}} row inventory manifests row
 */
export function assertManifestRowDigest(manifestText, row) {
  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw wasmManifestMappingError(`manifest is not valid JSON: ${row?.pkg}-${row?.version}`);
  }
  const digest = probe.manifestDigest(parsed);
  if (digest !== row?.digest) {
    throw wasmManifestMappingError(
      `manifest digest drift for ${row?.pkg}-${row?.version}: inventory ${row?.digest} != measured ${digest}`,
    );
  }
  return digest;
}
