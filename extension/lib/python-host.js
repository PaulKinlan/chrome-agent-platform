// lib/python-host.js — the OFFSCREEN-DOCUMENT side of the admitted Pyodide
// runtime (CAP-FB-20260823-PYODIDE-PYTHON-01, bead chrome-agent-platform-4usu).
//
// The service worker cannot create workers; this host (registered in
// offscreen/offscreen.js, the same document that runs agent scripts) can. It:
//
//   1. verifies the pinned runtime bytes ONCE per host session (fetch +
//      sha256 against PYTHON_RUNTIME_PIN — a substituted package byte fails
//      closed before any code runs), then
//   2. spawns a FRESH classic worker per python.run (fresh interpreter per
//      run) and terminates it when the run settles or its 30s fence fires —
//      worker.terminate is the only reliable way to stop a busy Python loop.
//
// The worker (wasm-tools/python/python-worker.js, copied to dist at build)
// loads Pyodide's classic glue via importScripts — its native environment.
// All bytes are local to the extension package; nothing here touches the
// network.
//
// The single worker-construction call below is the scanner's canonical python
// worker-host exemption (scripts/scan-shipped.mjs) — keep that call shape
// and location intact.

import { PYTHON_RUNTIME_DIR, PYTHON_RUNTIME_PIN, PYTHON_EXEC_TIMEOUT_MS } from "./python-runtime.js";
import { sha256HexBytes } from "./pure.js";

const RUN_TIMEOUT_MS = PYTHON_EXEC_TIMEOUT_MS;

let verification = null;

/** Admission check: every pinned runtime byte must match its exact sha256
 * before the interpreter may load. Single-flight; a failed admission retries
 * on the next run (a transient read should not brick python forever). */
function ensureVerified(deps) {
  if (verification) return verification;
  verification = (async () => {
    const base = deps.getURL(PYTHON_RUNTIME_DIR);
    for (const [file, pin] of Object.entries(PYTHON_RUNTIME_PIN.files)) {
      const response = await deps.fetchImpl(base + file);
      if (!response || !response.ok) throw new Error(`python_runtime_fetch_failed:${file}`);
      const bytes = await response.arrayBuffer();
      const got = await sha256HexBytes(bytes);
      if (got !== pin.sha256) throw new Error(`python_runtime_integrity_mismatch:${file}`);
    }
    return true;
  })().catch((error) => {
    verification = null; // retry on the next run
    throw error;
  });
  return verification;
}

/** One fresh classic worker per run. The worker loads Pyodide, runs the code
 * in a fresh interpreter, and posts {ok, stdout} / {ok:false, error}; the
 * 30s fence terminates a busy worker. */
function runInFreshWorker({ runId, code, stdin, workerUrl, WorkerCtor }) {
  return new Promise((resolve) => {
    let settled = false;
    let worker = null;
    let timer = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (worker) worker.terminate(); // the worker dies with its run
      } catch {
        // Already gone.
      }
      resolve(payload);
    };
    try {
      worker = new WorkerCtor(workerUrl);
    } catch (error) {
      resolve({ ok: false, error: `python_unavailable_worker (${String(error?.message ?? error)})` });
      return;
    }
    timer = setTimeout(() => {
      finish({ ok: false, error: "python_run_timeout" }); // terminates the busy worker
    }, RUN_TIMEOUT_MS);
    worker.onmessage = (event) => {
      const data = event && typeof event.data === "object" ? event.data : {};
      if (data.runId !== runId) return;
      if (data.ok) finish({ ok: true, stdout: String(data.stdout ?? "") });
      else finish({ ok: false, error: String(data.error ?? "python_run_failed") });
    };
    worker.onerror = (event) => {
      finish({ ok: false, error: `python_worker_error:${String(event?.message ?? "unknown")}` });
    };
    worker.postMessage({ type: "python.run", runId, code, stdin });
  });
}

function defaults() {
  return {
    getURL: (rel) => (typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL(rel) : rel),
    fetchImpl: (url) => fetch(url),
    WorkerCtor: typeof Worker === "function" ? Worker : null,
  };
}

async function executeRun(message, deps) {
  try {
    const code = String(message?.code ?? "");
    if (code.length === 0) return { ok: false, error: "python_empty_code" };
    if (typeof deps.WorkerCtor !== "function") return { ok: false, error: "python_unavailable_worker" };
    await ensureVerified(deps); // a hash mismatch → fail closed below
    const workerUrl = deps.getURL(PYTHON_RUNTIME_DIR + PYTHON_RUNTIME_PIN.worker.file);
    return await runInFreshWorker({
      runId: String(message?.runId ?? ""),
      code,
      stdin: String(message?.stdin ?? ""),
      workerUrl,
      WorkerCtor: deps.WorkerCtor,
    });
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }; // fail closed, never throw
  }
}

/** Register the offscreen-document python host. Only the offscreen doc
 * registers this listener, so no claim protocol is needed — the SW's
 * broadcast resolves with this host's response. */
export function registerPythonHost(deps = null) {
  const resolved = deps ?? defaults();
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== "object" || message.type !== "python.run") return false;
      executeRun(message, resolved).then(
        (result) => sendResponse(result),
        (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }),
      );
      return true; // keep the channel open for the async response
    });
  }
  return Object.freeze({ executeRun: (message) => executeRun(message, resolved) });
}
