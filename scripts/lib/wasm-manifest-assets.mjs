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

import { WasmPackageAuthority } from "../../extension/lib/wasm-package-authority.js";

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
