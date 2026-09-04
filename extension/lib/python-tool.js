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

export function getPythonRuntimeProvider() {
  return runtimeProvider;
}

/** The ONE bounded python tool (top-level only, non-eval entrypoint, fresh per run, no network). */
export const pythonExecuteTool = tool({
  description:
    "Run a Python program in the in-browser Pyodide runtime. Input is Python source code (code: string) and optional standard input (stdin: string). Output is captured standard output. The runtime is isolated, fresh per run, has no network, and runs sandboxed.",
  inputSchema: z.object({
    code: z.string().min(1).describe("the Python program source, top-level only"),
    stdin: z.string().optional().describe("optional standard input passed to the Python program"),
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

export const pythonTool = pythonExecuteTool;
