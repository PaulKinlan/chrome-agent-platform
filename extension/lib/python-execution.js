// lib/python-execution.js — the bounded `python` execution surface
// (CAP-FEATURE-PYODIDE-01). It mirrors the WASI runtime's sandboxing contract
// at the Python level: bounded stdin/stdout, a bounded wall-clock fence, fresh
// per-run (no cross-run state), and NO network (the adapter passes only the
// code + stdin; the runtime's own fetch/network stays out of scope).
//
// `runtime` is the loaded Pyodide instance (the `runPython`-bearing object) —
// injected so the no-Chrome KATs drive a mock and a missing runtime degrades.

import { EXECUTOR_BOUNDS } from "./wasm-executor-bounds.js";

export const PYTHON_EXEC_BOUNDS = Object.freeze({
  // The bounded stdin mirror the Settings stdin tools (2 KiB).
  maxStdinBytes: 2048,
  // The bounded stdout mirror the FND-1 binary response ceiling (64 KiB).
  maxStdoutBytes: EXECUTOR_BOUNDS.maxBinaryResponseBytes,
  // The bounded wall-clock fence mirror the executor's call ceiling.
  maxRunMs: EXECUTOR_BOUNDS.maxCallMs,
});

const encoder = new TextEncoder();
function utf8Bytes(value) { return encoder.encode(String(value ?? "")); }

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("python_run_timeout")), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Run bounded Python. Returns { ok:true, stdout } or { ok:false, error }. The
 * code/stdin are the ONLY inputs; the result is the bounded stdout string. */
export async function runPython(runtime, { code = "", stdin = "", timeoutMs = PYTHON_EXEC_BOUNDS.maxRunMs } = {}) {
  const codeBytes = utf8Bytes(code);
  const stdinBytes = utf8Bytes(stdin);
  if (codeBytes.byteLength === 0) return { ok: false, error: "python_empty_code" };
  if (codeBytes.byteLength > PYTHON_EXEC_BOUNDS.maxStdinBytes) {
    return { ok: false, error: "python_code_over_budget" };
  }
  if (stdinBytes.byteLength > PYTHON_EXEC_BOUNDS.maxStdinBytes) {
    return { ok: false, error: "python_stdin_over_budget" };
  }
  if (!runtime || typeof runtime.runPython !== "function") {
    return { ok: false, error: "python_unavailable" };
  }
  let result;
  try {
    // The real Pyodide runPython returns synchronously; wrap it so the timeout
    // fence covers both the sync and the async (the mock) shapes.
    result = await withTimeout(Promise.resolve(runtime.runPython(code, stdin)), timeoutMs);
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
  const stdout = String(result ?? "");
  if (utf8Bytes(stdout).byteLength > PYTHON_EXEC_BOUNDS.maxStdoutBytes) {
    return { ok: false, error: "python_stdout_over_budget" };
  }
  return { ok: true, stdout };
}
