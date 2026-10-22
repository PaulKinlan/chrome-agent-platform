// scripts/lib/pyodide-staging.mjs — staging the admitted Pyodide runtime (CAP-FB-20260823-PYODIDE-PYTHON-01).
// Extracted so the two-phase staging (verify-all-before-copy) is unit-testable without running a full build.

import { createHash } from "node:crypto";
import { readFile, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { settleAll } from "./build-concurrency.mjs";

/**
 * Stage the admitted Pyodide runtime into the target staging directory in two phases:
 * Phase 1 — verify EVERY admitted file before any is staged: a drifted byte fails the build
 *           closed with nothing copied, rather than leaving its already-verified siblings in STAGE.
 * Phase 2 — stage them (copy to stageDistDir/wasm-tools/python).
 *
 * @param {string} runtimeSrc Directory containing MANIFEST.json and runtime assets
 * @param {string} stageDistDir Target staging directory (where wasm-tools/python/ will be created)
 * @returns {Promise<number>} Number of staged files
 */
export async function stagePyodideRuntime(runtimeSrc, stageDistDir) {
  const manifest = JSON.parse(await readFile(path.join(runtimeSrc, "MANIFEST.json"), "utf8"));
  const runtimeFiles = Object.keys(manifest.files); // 7 pinned files incl. python-worker.js
  const pyDist = path.join(stageDistDir, "wasm-tools/python");
  await mkdir(pyDist, { recursive: true });

  // Phase 1 — verify EVERY admitted file before any is staged: a drifted byte fails the build
  // closed with nothing copied, rather than leaving its already-verified siblings in STAGE.
  await settleAll(runtimeFiles.map(async (file) => {
    const expected = manifest.files[file]?.sha256;
    if (!expected) throw new Error(`pyodide runtime ${file} has no admission hash in wasm-tools/python/MANIFEST.json`);
    const digest = createHash("sha256").update(await readFile(path.join(runtimeSrc, file))).digest("hex");
    if (digest !== expected) {
      throw new Error(`pyodide runtime admission mismatch: ${file} sha256 ${digest} != manifest ${expected}`);
    }
  }));

  // Phase 2 — stage them.
  await settleAll(runtimeFiles.map((file) => copyFile(path.join(runtimeSrc, file), path.join(pyDist, file))));
  return runtimeFiles.length;
}
