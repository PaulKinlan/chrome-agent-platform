// lib/python-tool.js — the bounded `python` TOOL definition
// (CAP-FB-20260823-PYODIDE-PYTHON-01, owner OPTION A).
//
// This is the ready-to-wire tool for the compute toolset. It is NOT part of the
// browser toolset (it is a compute/runtime tool, not a chrome API) — the build
// lane that admits the bounded Pyodide runtime merges this tool into the
// compute surface, NOT the browser registry (so the 130-tool chrome-api parity
// stays exact). Until the runtime is admitted, `pythonTool` fails closed with an
// honest "unavailable" — it never fabricates a result.
//
// DISPATCHER SEPARATION: the Pyodide runtime is NOT a WASI binary. It runs under
// a SEPARATE Emscripten/JS-glue dispatcher profile; the WASI host and its import
// allowlist are NOT widened. `getPythonRuntime` is the injection seam — the build
// lane supplies a loader that reads the admitted OPFS-cached runtime and returns
// the non-eval interpreter surface ({ runPythonAsync, setStdout, setStdin }).

import { tool } from "ai";
import { z } from "zod";
import { runPython, PYTHON_EXEC_BOUNDS } from "./python-execution.js";

/** The runtime provider seam. Default = unavailable (fails closed). The build
 * lane injects the real OPFS-cached loader. NEVER a CDN fetch (Option A). */
let runtimeProvider = async () => null;

export function setPythonRuntimeProvider(provider) {
  if (typeof provider === "function") runtimeProvider = provider;
}

/** The ONE bounded python tool (stdin ≤2 KiB, stdout ≤64 KiB, top-level-only,
 * non-eval entrypoint, fresh per run, no network). */
export const pythonTool = tool({
  description:
    "Run a small, bounded Python program (top-level only) in an in-browser Python runtime. Input is source code (≤2 KiB) + optional stdin (≤2 KiB); output is the captured stdout (≤64 KiB). The runtime is isolated, fresh per run, has no network, and is unavailable until the Python runtime is enabled.",
  inputSchema: z.object({
    code: z.string().min(1).max(PYTHON_EXEC_BOUNDS.maxStdinBytes).describe("the Python program source, top-level only (≤2 KiB)"),
    stdin: z.string().max(PYTHON_EXEC_BOUNDS.maxStdinBytes).optional().describe("optional stdin bytes (≤2 KiB)"),
  }),
  execute: async ({ code, stdin }) => {
    const runtime = await runtimeProvider();
    if (!runtime) {
      return { error: "python unavailable — the bounded Python runtime is not admitted yet (see docs/PYODIDE-BOUNDED-BUILD.md); no result was fabricated" };
    }
    const result = await runPython(runtime, { code, stdin: stdin ?? "" });
    if (!result.ok) return { error: result.error };
    return { ok: true, stdout: result.stdout, stdoutBytes: new TextEncoder().encode(result.stdout).byteLength };
  },
});
