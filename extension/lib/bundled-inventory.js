// bundled-inventory.js — the immutable bundled-package inventory provider for
// WasmPackageAuthority. Wraps the GENERATED BUNDLED_INVENTORY data (see
// scripts/build-bundled-tool-packages.mjs) with readFile/listFiles readers.
//
// In the MV3 service worker, defaultReadFile fetches the shipped extension
// asset via chrome.runtime.getURL. Tests inject their own readers (e.g. Deno
// fs). NO execution route consumes this module until the Wasm execution host
// lands; admission is performed only through admitBundledToolPackages() in
// bundled-tool-packages.js under an explicit caller.

import { BUNDLED_INVENTORY } from "./bundled-inventory-data.js";

async function defaultReadFile(rel) {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.getURL) throw new Error("bundled-inventory: chrome.runtime.getURL unavailable (inject readFile)");
  const response = await fetch(runtime.getURL(rel));
  if (!response.ok) throw new Error(`bundled-inventory: fetch failed ${response.status} for ${rel}`);
  return await response.arrayBuffer();
}

export function createBundledInventory({ readFile, listFiles } = {}) {
  const data = BUNDLED_INVENTORY;
  return {
    release: data.release,
    files: data.files.map((row) => ({ ...row })),
    manifests: data.manifests.map((row) => ({ ...row })),
    signer: { ...data.signer },
    evidence: [...data.evidence],
    revocations: [...data.revocations],
    readFile: readFile ?? defaultReadFile,
    // Default listing is the declared set: the authority re-reads and
    // hash-verifies every declared file through readFile, so a missing or
    // mutated shipped byte fails admission closed.
    listFiles: listFiles ?? (async () => data.files.map((row) => row.rel)),
  };
}

export const BUNDLED_SIGNER_KEY_ID = BUNDLED_INVENTORY.signer.keyId;
