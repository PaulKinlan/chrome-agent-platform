// python-worker.js — the bounded Pyodide execution worker (CAP-FB-20260823-
// PYODIDE-PYTHON-01, bead chrome-agent-platform-4usu).
//
// CLASSIC worker (no modules) on purpose: Pyodide's shipped loader is
// classic-script glue — pyodide.asm.js defines the Emscripten module factory
// and pyodide.js defines loadPyodide, both via `importScripts`-style global
// side effects. A module worker cannot host them without shims; a classic
// worker is Pyodide's native environment.
//
// The offscreen document (extension/lib/python-host.js) spawns ONE fresh
// worker per python.run and terminates it when the run settles — fresh
// interpreter per run (no cross-run state) and a busy Python loop dies with
// its worker (worker.terminate is the only reliable way to stop one).
//
// No network: every byte comes from the extension package (indexURL below
// resolves to the packaged dist copy of wasm-tools/python/).
"use strict";

// The pinned glue, same directory as this worker in the packaged extension.
importScripts("./pyodide.asm.js", "./pyodide.js"); // _createPyodideModule + loadPyodide globals

// One interpreter per worker; single-flight so a burst of runs in the same
// worker (should not happen: the host spawns one worker per run) shares one
// init instead of racing it.
let runtimePromise = null;

function indexUrl() {
  return new URL("./", self.location.href).href;
}

function runtime() {
  if (!runtimePromise) {
    runtimePromise = loadPyodide({
      indexURL: indexUrl(),
      // Startup writes (e.g. banner warnings) go nowhere; per-run capture
      // installs its own batched writer before each runPythonAsync.
      stdout: () => {},
      stderr: () => {},
    }).catch((error) => {
      runtimePromise = null; // a failed init can be retried by the next run
      throw error;
    });
  }
  return runtimePromise;
}

self.onmessage = async (event) => {
  const message = event && typeof event.data === "object" ? event.data : {};
  if (message.type !== "python.run") return;
  const respond = (payload) => {
    try {
      self.postMessage({ runId: message.runId, ...payload });
    } catch {
      // The host terminated the worker mid-run (timeout) — nothing to do.
    }
  };
  try {
    const pyodide = await runtime();
    const stdout = [];
    pyodide.setStdout({ batched: (chunk) => stdout.push(String(chunk ?? "")) });
    // One-shot stdin: the whole input arrives once, then EOF — a program that
    // reads to EOF terminates instead of re-reading the same bytes forever.
    let stdinGiven = false;
    pyodide.setStdin({
      stdin: () => {
        if (stdinGiven) return undefined;
        stdinGiven = true;
        return String(message.stdin ?? "");
      },
    });
    await pyodide.runPythonAsync(String(message.code ?? ""));
    respond({ ok: true, stdout: stdout.join("") });
  } catch (error) {
    // A Python error surfaces as a rejection whose message carries the
    // traceback — bounded by what the program itself printed/raised.
    respond({ ok: false, error: String(error?.message ?? error) });
  }
};
