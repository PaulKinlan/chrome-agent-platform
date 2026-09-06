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

// The ambient network reach removed from this worker's scope before any Python
// runs (bead chrome-agent-platform-4p7j.1, owner decision 2026-09-06).
//
// MEASURED before this change, through the real python.execute route in a
// loaded extension: `import js` exposed fetch, XMLHttpRequest, WebSocket,
// EventSource, importScripts, Worker, indexedDB and caches, and a real
// cross-origin request returned a status — it left the browser. This worker
// runs at the chrome-extension:// origin and the extension holds
// host_permissions <all_urls>, so model-authored Python could reach ANY origin
// with the extension's privileges, with nothing in the transcript.
//
// THE BOUNDARY — read this before widening or narrowing the list:
//   IN SCOPE: this worker's own global scope, and nothing else. Python loses
//   its AMBIENT reach; that is all this does.
//   OUT OF SCOPE and deliberately untouched: every other request the extension
//   makes — the service worker's provider calls, the offscreen document's own
//   fetches, script-sandbox.js's host-bridged fetch for agent scripts, and
//   python-host.js's fetch of THIS file and its siblings for hash verification
//   (that runs in the HOST, not here; break it and the runtime can no longer be
//   verified before it loads).
//   THE FORWARD RULE: Python HTTP comes back as an EXPLICIT PERMISSIONED
//   capability — per-origin grants, every request and refusal in the
//   transcript (bead chrome-agent-platform-4p7j.2) — never as an ambient
//   global the model can reach without the owner seeing it.
//
// This is not an admission bound: it removes a capability the tool never
// advertised. It refuses no payload and caps no size.
//
// WHY THE LIST IS LONGER than "fetch": a strip that leaves one door open is
// theatre. `importScripts` loads remote script; `Worker` spawns a nested
// worker that would have its own untouched fetch; `navigator.sendBeacon` posts
// a body with no response needed, which is all exfiltration requires;
// WebSocket/EventSource/WebTransport are each a full channel.
// `indexedDB`/`caches` are NOT stripped — they are storage, not network, and
// removing them is a separate question about cross-run state
// (chrome-agent-platform-4p7j.3), not this one.
//
// WHY IT RUNS AFTER loadPyodide RESOLVES: Pyodide's own loader needs fetch to
// read pyodide.asm.wasm and python_stdlib.zip. Stripping first would break the
// interpreter before it exists. Nothing Python-authored can run between
// loadPyodide resolving and this strip — runtime() is awaited before the
// per-run stdout/stdin wiring and before runPythonAsync — so there is no
// window in which the globals are both present and reachable from Python.
const AMBIENT_NETWORK_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "Worker",
  "SharedWorker",
  "WebTransport",
];

function stripAmbientNetwork() {
  // These globals live on WorkerGlobalScope.prototype, not as own properties of
  // `self`, so `delete self.fetch` is a silent no-op — it removes an own
  // property that was never there and returns true. The first cut of this
  // function did exactly that and left `js.fetch` resolving to None: the
  // capability was gone, but a caller got "'NoneType' object is not callable",
  // which tells a model nothing about what happened or what to do instead.
  //
  // So each name is REPLACED with a function that throws a readable error, in
  // the same teaching style script-sandbox.js uses for the storage APIs an
  // agent reaches for out of habit. The capability is equally gone; the
  // difference is that the model learns the boundary instead of guessing at a
  // null.
  const reason = (name) =>
    name + " is not available to Python here. This interpreter has no ambient " +
    "network access: it cannot reach any origin on its own, by design. Network " +
    "access is granted per origin by the owner and every request is recorded in " +
    "the run transcript. Compute what you can from the input you were given, and " +
    "return it — do not try to fetch it.";

  for (const name of AMBIENT_NETWORK_GLOBALS) {
    try {
      const deny = function denied() { throw new Error(reason(name)); };
      Object.defineProperty(self, name, {
        value: deny,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      // defineProperty can fail on an already non-configurable own property.
      // Fall back to assignment, then to delete: a name that ends up undefined
      // is still stripped of its power, which is the property that matters.
      try { self[name] = undefined; } catch { /* ignore */ }
      try { delete self[name]; } catch { /* ignore */ }
    }
  }
  // sendBeacon posts a body and needs no response — exfiltration does not
  // require reading the answer. navigator itself stays (Pyodide reads it).
  try {
    Object.defineProperty(self.navigator, "sendBeacon", {
      value: function denied() { throw new Error(reason("navigator.sendBeacon")); },
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch {
    try { self.navigator.sendBeacon = undefined; } catch { /* ignore */ }
  }
}

function runtime() {
  if (!runtimePromise) {
    runtimePromise = loadPyodide({
      indexURL: indexUrl(),
      // Startup writes (e.g. banner warnings) go nowhere; per-run capture
      // installs its own batched writer before each runPythonAsync.
      stdout: () => {},
      stderr: () => {},
    }).then((pyodide) => {
      // AFTER the interpreter exists, BEFORE any Python runs. See the boundary
      // note above for why this ordering is load-bearing.
      stripAmbientNetwork();
      return pyodide;
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
