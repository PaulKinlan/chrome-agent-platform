// bundled-tool-packages.js — bundled tool package descriptors + admission.
//
// Posture: every descriptor is admitted:false, disabled:true
// (disabledReason "no-execution-host"), canonicalNameClaim:false, and
// sourceKind "bundled-package" — the source kind reserved by the
// package-catalog precursor. NOTHING here registers a tool in the live
// catalog, exposes an execution route, or is imported by the service worker.
// The catalog may ENUMERATE these rows only after that precursor lands.

import { BUNDLED_TOOL_PACKAGE_ROWS } from "./bundled-tool-packages.data.js";
import { createBundledInventory } from "./bundled-inventory.js";

export const BUNDLED_PACKAGE_SOURCE_KIND = "bundled-package";

// Frozen, deeply immutable descriptor rows for future catalog enumeration.
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}
export const BUNDLED_TOOL_PACKAGES = deepFreeze(BUNDLED_TOOL_PACKAGE_ROWS.map((row) => structuredClone(row)));

export function listBundledToolPackages() {
  return BUNDLED_TOOL_PACKAGES.map((row) => structuredClone(row));
}

// Admit every shipped bundled package into the package store via the real
// authority. `files` for admitBundled is the sha256→bytes map of the package's
// executables, read from the shipped CAS through the inventory's readFile.
// Idempotent per the authority (deduped re-admission returns deduped:true).
export async function admitBundledToolPackages(authority, { inventory = createBundledInventory(), onAdmit = null } = {}) {
  const results = [];
  for (const row of BUNDLED_TOOL_PACKAGES) {
    const manifestRawBytes = new Uint8Array(await inventory.readFile(row.manifestRef));
    const manifestRaw = new TextDecoder().decode(manifestRawBytes);
    const files = new Map();
    for (const executableSha of [row.binary.sha256]) {
      files.set(executableSha, new Uint8Array(await inventory.readFile(`extension/wasm/cas/${executableSha}.wasm`)));
    }
    const result = await authority.admitBundled({ manifest: manifestRaw, files });
    results.push({ packageId: row.packageId, ok: result.ok === true, deduped: result.deduped === true });
    if (onAdmit) await onAdmit(row, result);
  }
  return { ok: results.every((r) => r.ok), results };
}
