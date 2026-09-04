// lib/python-runtime.js — the admitted Pyodide runtime + the python runtime
// PROVIDER (CAP-FB-20260823-PYODIDE-PYTHON-01, bead chrome-agent-platform-4usu).
//
// The Pyodide runtime is an ADMITTED local artifact: the pinned 0.26.4 core
// distribution lives in wasm-tools/python/ (committed; MANIFEST.json holds the
// exact sha256 of every file), and build.mjs verifies + copies it into the
// packaged extension at dist/wasm-tools/python/ (the generated-artifact tree —
// the raw third-party glue is never shipped as scanned source; Chrome serves
// it from the chrome-extension:// origin, so nothing touches the network).
//
// The pins below MUST agree with wasm-tools/python/MANIFEST.json and the
// on-disk bytes (tests/python-runtime.test.ts asserts all three).
//
// Execution host: python code runs in a FRESH classic Worker per run, spawned
// by the offscreen document (extension/lib/python-host.js). The service worker
// has no DOM and module workers cannot host Pyodide's classic glue; the
// offscreen doc CAN spawn a classic worker, and a busy Python loop dies with
// worker.terminate — the only reliable stop. Zero network at execution time;
// fresh interpreter per run (no cross-run state).
//
// This module is the SERVICE-WORKER side: it owns the pins and the lazy
// single-flight host handoff, and it exports the runtime PROVIDER the boot
// injects through python-tool.js's setPythonRuntimeProvider seam. The provider
// returns a runtime of the exact shape lib/python-execution.js's runPython
// expects ({ setStdout, setStdin, runPythonAsync }) — code in → captured
// stdout out — so the python.execute route and the python tool keep their
// shape unchanged.

import { EXECUTOR_BOUNDS } from "./wasm-executor-bounds.js";
import { newId } from "./pure.js";

export const PYTHON_EXEC_TIMEOUT_MS = EXECUTOR_BOUNDS.maxCallMs; // 30s: a hung interpreter must die
export const PYTHON_RUNTIME_VERSION = "0.26.4";

/** The packaged location of the runtime (extension/dist/wasm-tools/python/).
 * dist is the generated-artifact tree: built + verified from the committed
 * wasm-tools/python/ sources by build.mjs. */
export const PYTHON_RUNTIME_DIR = "dist/wasm-tools/python/";

/** Exact admission hashes — must match wasm-tools/python/MANIFEST.json and
 * the on-disk bytes (tests/python-runtime.test.ts asserts all three). */
export const PYTHON_RUNTIME_PIN = Object.freeze({
  version: PYTHON_RUNTIME_VERSION,
  worker: Object.freeze({ file: "python-worker.js" }),
  files: Object.freeze({
    "pyodide.js": Object.freeze({ sha256: "c0069107621d5b942a659e737a12e774cc0451feaa2256f475d72e071d844ec7", bytes: 14761 }),
    "pyodide.mjs": Object.freeze({ sha256: "7f24c6655a79eacf0061d3d4e6a60dc0b1938812d15c52d7ff8b37d9e0689e51", bytes: 13779 }),
    "pyodide.asm.js": Object.freeze({ sha256: "919560652ed3dad3707cb3a394785da1e046fb13dc0defa162058ff230cb7eed", bytes: 1229099 }),
    "pyodide.asm.wasm": Object.freeze({ sha256: "b7e66a19427a55010ac3367c1b6c64b893f9826f783412945fdf0c3337f3bc94", bytes: 10088051 }),
    "python_stdlib.zip": Object.freeze({ sha256: "72894522b791858b9d613ac786b951d8b5094035dcf376313ea24a466810f336", bytes: 2341872 }),
    "pyodide-lock.json": Object.freeze({ sha256: "cd50b49de944c579045e122fe8628b31f9ce446379f032f36c05e273d38766e0", bytes: 106335 }),
    "python-worker.js": Object.freeze({ sha256: "ed4cef93bfcc68103fa7ac1e640a57e1356f77f54c4c1604c4992056f1a1ec46", bytes: 3088 }),
  }),
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("python_run_timeout")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function sanitizeInput(value, max = 256 * 1024) {
  const text = String(value ?? "");
  return text.slice(0, max); // the message channel is not the stdout pipe — keep frames sane
}

/**
 * Create the python runtime PROVIDER for the setPythonRuntimeProvider seam
 * (extension/lib/python-tool.js). provider() resolves to a runtime facade of
 * the lib/python-execution.js runPython shape — { setStdout({batched}),
 * setStdin({stdin}), runPythonAsync(code) } — whose calls are transported to
 * the offscreen-document python host (extension/lib/python-host.js), which
 * runs each program in a FRESH classic Pyodide worker and streams the captured
 * stdout back whole.
 *
 * `ensureHost` lazily opens/keeps the offscreen document (single-flight);
 * `sendMessage` is the chrome.runtime round-trip to the host. Injectable for
 * the no-Chrome tests. The host is retried on the next run when it cannot open
 * or dies between runs.
 */
export function createPythonRuntimeProvider({
  ensureHost = null,
  sendMessage = null,
  timeoutMs = PYTHON_EXEC_TIMEOUT_MS,
} = {}) {
  let hostSettled = false;
  let hostOk = false;
  let pending = null;

  const doSend = sendMessage ?? ((message) => {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      return Promise.resolve(null);
    }
    return Promise.resolve(chrome.runtime.sendMessage(message));
  });

  /** Lazily bring up the host ONCE (single-flight); later calls reuse the
   * verdict. A host that dies later is retried on the next run's failure. */
  async function ensureHostReady() {
    if (hostSettled) return hostOk;
    if (pending) return pending;
    if (typeof ensureHost !== "function") {
      hostSettled = true;
      hostOk = false;
      return false;
    }
    pending = (async () => {
      try {
        const result = await ensureHost();
        hostOk = !result || result.ok !== false;
      } catch {
        hostOk = false;
      } finally {
        // Only SUCCESS is cached: a host that cannot open right now is retried
        // on the next run (offscreen creation can fail transiently).
        hostSettled = hostOk;
        pending = null;
      }
      return hostOk;
    })();
    return pending;
  }

  /** One fresh facade per provider() call — runPython wires setStdout/setStdin
   * first, then runPythonAsync, exactly once each. */
  function facade() {
    let emitStdout = null;
    let readStdin = null;
    let stdinGiven = false;
    const oneShotStdin = () => {
      if (stdinGiven) return undefined; // EOF — the whole input arrives once
      stdinGiven = true;
      return typeof readStdin === "function" ? readStdin() : "";
    };
    return {
      setStdout({ batched }) {
        if (typeof batched === "function") emitStdout = batched;
      },
      setStdin({ stdin }) {
        if (typeof stdin === "function") readStdin = stdin;
      },
      runPythonAsync: async (code) => {
        const runId = newId("python");
        const ready = await ensureHostReady();
        if (!ready) throw new Error("python_unavailable_host");
        let response;
        try {
          response = await withTimeout(
            doSend({
              type: "python.run",
              runId,
              code: sanitizeInput(code),
              stdin: sanitizeInput(oneShotStdin()),
            }),
            timeoutMs,
          );
        } catch (error) {
          if (String(error?.message ?? error) === "python_run_timeout") throw error;
          // A dead host channel is retried next run.
          hostSettled = false;
          throw new Error("python_unavailable_host");
        }
        if (!response || typeof response !== "object") {
          // No host answered (it can die between ensureHost and the send) — the
          // next run retries the host.
          hostSettled = false;
          throw new Error("python_unavailable_host");
        }
        if (response.ok) {
          if (emitStdout) emitStdout(String(response.stdout ?? ""));
          return undefined;
        }
        throw new Error(String(response.error ?? "python_run_failed"));
      },
    };
  }

  return Object.freeze({
    /** The provider: async () => runtime facade (the runPython surface). */
    provider: async () => facade(),
  });
}
