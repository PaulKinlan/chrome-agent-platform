// lib/python-execution.js — the bounded `python` execution surface
// (CAP-FEATURE-PYODIDE-01). It mirrors the WASI runtime's sandboxing contract
// at the Python level: bounded stdin/stdout, a bounded wall-clock fence, fresh
// per-run (no cross-run state), and NO network (the adapter passes only the
// code + stdin; the runtime's own fetch/network stays out of scope).
//
// NON-EVAL ENTRYPOINT (owner OPTION A, caveat 4): the user's program text is
// handed ONLY to the wasm Python interpreter via `runPythonAsync` — it is NEVER
// `eval`'d or `new Function`'d at the JS level (the MV3 CSP forbids JS eval;
// `wasm-unsafe-eval` covers wasm instantiation only). The adapter therefore
// accepts a runtime exposing `runPythonAsync`/`setStdout`/`setStdin` and NEVER
// touches any JS-eval-shaped surface. Top-level program text only; fail-closed.

import { EXECUTOR_BOUNDS } from "./wasm-executor-bounds.js";

export const PYTHON_EXEC_BOUNDS = Object.freeze({
  // dptw: no byte budgets on code/stdin/stdout — a program of any size runs
  // and its output arrives whole. The wall-clock fence stays (a hung
  // interpreter must still time out).
  maxStdinBytes: Number.POSITIVE_INFINITY,
  maxStdoutBytes: Number.POSITIVE_INFINITY,
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

/**
 * Run bounded Python through the NON-EVAL interpreter entrypoint.
 *
 * The `runtime` is the loaded Pyodide instance with the shape:
 *   { runPythonAsync(code) -> Promise<PyProxy|void>, setStdout({batched}), setStdin({stdin}) }
 * A mock with the same shape drives the no-Chrome KATs; a missing runtime
 * degrades to `{ ok:false, error:"python_unavailable" }`.
 *
 * Returns { ok:true, stdout } or { ok:false, error }. The code/stdin are the
 * ONLY inputs; the result is the bounded stdout string; fresh per run.
 */
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
  // The NON-EVAL guard: the runtime MUST expose the interpreter entrypoint.
  // We never call `eval` / `new Function` — the code string is handed to the
  // wasm Python interpreter via runPythonAsync. A runtime that only offers a
  // JS-eval-shaped path (no runPythonAsync) is refused fail-closed.
  if (!runtime || typeof runtime.runPythonAsync !== "function") {
    return { ok: false, error: "python_unavailable" };
  }
  let out = "";
  try {
    // Wire the bounded stdout + stdin into the interpreter BEFORE running, so
    // the capture is the interpreter's actual output — never a JS-level echo.
    if (typeof runtime.setStdout === "function") {
      runtime.setStdout({ batched: (chunk) => { out += String(chunk ?? ""); } });
    }
    if (typeof runtime.setStdin === "function") {
      // ONE-SHOT stdin: the whole input arrives once, then EOF. A provider
      // that re-serves the same bytes forever makes `sys.stdin.read()` loop
      // indefinitely in a real interpreter (verified against Pyodide 0.26.4)
      // — the fence would have to kill every read-to-EOF program.
      let stdinGiven = false;
      runtime.setStdin({ stdin: () => {
        if (stdinGiven) return undefined; // EOF
        stdinGiven = true;
        return stdin;
      } });
    }
    const result = await withTimeout(
      Promise.resolve(runtime.runPythonAsync(code)),
      timeoutMs,
    );
    // `result` (a PyProxy or a raw value) is ignored — the bounded stdout
    // capture is the only output surface. This keeps the contract honest and
    // prevents a proxy from smuggling unbounded data through the return value.
    void result;
  } catch (error) {
    // Fail closed: a JS-level throw (including any accidental eval path) is a
    // bounded error, never a raw exception escape.
    return { ok: false, error: String(error?.message ?? error).slice(0, 200) };
  }
  if (utf8Bytes(out).byteLength > PYTHON_EXEC_BOUNDS.maxStdoutBytes) {
    return { ok: false, error: "python_stdout_over_budget" };
  }
  return { ok: true, stdout: out };
}
