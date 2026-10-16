// tests/build-pyodide-staging.test.ts — bead chrome-agent-platform-z3983.
// Pin the Pyodide two-phase staging: verify-all-before-copy order.
// A drifted byte must fail the build closed with NOTHING copied to stage.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { stagePyodideRuntime } from "../scripts/lib/pyodide-staging.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PYODIDE_SRC = path.join(ROOT, "wasm-tools/python");

Deno.test("pyodide staging: two-phase staging copies all files when verification passes", async () => {
  const scratch = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-pyodide-clean-" });
  try {
    const count = await stagePyodideRuntime(PYODIDE_SRC, scratch);
    assertEquals(count, 7);
    const stagedDir = path.join(scratch, "wasm-tools/python");
    const stagedFiles = [];
    for await (const entry of Deno.readDir(stagedDir)) {
      stagedFiles.push(entry.name);
    }
    assertEquals(stagedFiles.sort(), [
      "pyodide-lock.json",
      "pyodide.asm.js",
      "pyodide.asm.wasm",
      "pyodide.js",
      "pyodide.mjs",
      "python-worker.js",
      "python_stdlib.zip",
    ].sort());
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});

Deno.test("pyodide staging z3983: verify-all-before-copy fails closed with NOTHING copied when one file has drifted bytes", async () => {
  const scratch = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-pyodide-drift-" });
  const scratchRuntime = path.join(scratch, "runtime");
  const scratchStage = path.join(scratch, "stage");
  await Deno.mkdir(scratchRuntime, { recursive: true });
  await Deno.mkdir(scratchStage, { recursive: true });

  try {
    // Copy real runtime files + MANIFEST.json into scratchRuntime
    const manifestText = await Deno.readTextFile(path.join(PYODIDE_SRC, "MANIFEST.json"));
    await Deno.writeTextFile(path.join(scratchRuntime, "MANIFEST.json"), manifestText);
    const manifest = JSON.parse(manifestText);

    for (const file of Object.keys(manifest.files)) {
      await Deno.copyFile(path.join(PYODIDE_SRC, file), path.join(scratchRuntime, file));
    }

    // Tamper with exactly ONE admitted file (e.g. python-worker.js)
    const tamperedFile = "python-worker.js";
    await Deno.writeTextFile(path.join(scratchRuntime, tamperedFile), "// drifted byte tamper\n");

    // Call stagePyodideRuntime and expect rejection with exact error format
    const err = await assertRejects(
      () => stagePyodideRuntime(scratchRuntime, scratchStage),
      Error,
      "pyodide runtime admission mismatch: python-worker.js",
    );
    assert(err.message.includes(`pyodide runtime admission mismatch: ${tamperedFile}`));

    // Assert that NO file of the runtime exists under STAGE/wasm-tools/python
    const pyStage = path.join(scratchStage, "wasm-tools/python");
    const stagedEntries = [];
    try {
      for await (const entry of Deno.readDir(pyStage)) {
        stagedEntries.push(entry.name);
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    assertEquals(stagedEntries, [], "no file of the runtime must exist under STAGE/wasm-tools/python after verification failure");
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});

Deno.test("pyodide staging z3983: falsification — collapsed verify-then-copy pass fails closed assertion", async () => {
  // Simulates the buggy single-pass behavior: if verification and copy are merged into one pass,
  // files verified before the tampered file would leak into the staging directory.
  const scratch = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-pyodide-falsify-" });
  const scratchRuntime = path.join(scratch, "runtime");
  const scratchStage = path.join(scratch, "stage");
  await Deno.mkdir(scratchRuntime, { recursive: true });
  await Deno.mkdir(scratchStage, { recursive: true });

  try {
    const manifestText = await Deno.readTextFile(path.join(PYODIDE_SRC, "MANIFEST.json"));
    await Deno.writeTextFile(path.join(scratchRuntime, "MANIFEST.json"), manifestText);
    const manifest = JSON.parse(manifestText);
    for (const file of Object.keys(manifest.files)) {
      await Deno.copyFile(path.join(PYODIDE_SRC, file), path.join(scratchRuntime, file));
    }
    // Tamper with the LAST file in the manifest so prior files would be copied in a single-pass implementation
    const files = Object.keys(manifest.files);
    const tamperedFile = files[files.length - 1];
    await Deno.writeTextFile(path.join(scratchRuntime, tamperedFile), "// drifted\n");

    // Buggy mock single-pass: copies as it verifies
    async function singlePassVerifyAndCopy(src: string, dst: string) {
      const pyDist = path.join(dst, "wasm-tools/python");
      await Deno.mkdir(pyDist, { recursive: true });
      for (const file of files) {
        const expected = manifest.files[file]?.sha256;
        const data = await Deno.readFile(path.join(src, file));
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)))
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        if (hash !== expected) {
          throw new Error(`pyodide runtime admission mismatch: ${file}`);
        }
        await Deno.copyFile(path.join(src, file), path.join(pyDist, file));
      }
    }

    await assertRejects(() => singlePassVerifyAndCopy(scratchRuntime, scratchStage));
    const pyStage = path.join(scratchStage, "wasm-tools/python");
    const leaked = [];
    for await (const entry of Deno.readDir(pyStage)) {
      leaked.push(entry.name);
    }
    // Proves that in a buggy single-pass implementation, earlier files leak into staging
    assert(leaked.length > 0, "falsifier: single-pass verify+copy leaks files into staging");
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});
