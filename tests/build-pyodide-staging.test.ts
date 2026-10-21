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

