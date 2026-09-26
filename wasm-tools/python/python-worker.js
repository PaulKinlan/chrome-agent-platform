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
// `indexedDB`/`caches` are STRIPPED alongside network globals (bead
// chrome-agent-platform-4p7j.3) — leaving them open creates an unmanaged
// cross-run covert persistence channel across tasks and agents. Teaching
// guards match script-sandbox.js.
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

// The ambient storage reach removed from this worker's scope before any Python
// runs (bead chrome-agent-platform-4p7j.3, owner ruling 2026-09-11).
//
// WHY IT IS STRIPPED: This worker runs at the chrome-extension:// origin.
// Leaving self.indexedDB and self.caches intact exposes the extension origin's
// persistent browser storage, allowing Python code in one run to persist state
// and read it back in another run. That turns an interpreter that is supposed to
// be fresh per run into an unmanaged cross-run covert channel between tasks and
// agents.
//
// In script-sandbox.js, agent-authored JavaScript is denied indexedDB and
// caches with teaching guards. Stripping them here restores symmetry: the
// fresh-per-run property holds across both memory and storage, and Python
// learns the exact same platform storage model.
//
// Pyodide and the standard library do NOT use indexedDB or caches (installed
// modules/wheels unpack from the platform owner-blob store into MEMFS; task
// data uses memory_set / create_asset / OPFS workspace directories).
function stripAmbientStorage() {
  const reason = (name) =>
    name + " is unavailable inside the Python worker — an execution keeps no state " +
    "between runs: compute and return the value; store durable data with the platform " +
    "(memory_set / create_asset / workspace files) from the agent side.";

  function makeDenyApi(prop, methods) {
    const fn = function denied() { throw new Error(reason(prop)); };
    for (const m of methods) {
      fn[m] = function deniedMethod() { throw new Error(reason(prop + "." + m)); };
    }
    return fn;
  }

  const STORAGE_APIS = {
    indexedDB: ["open", "deleteDatabase", "databases", "cmp"],
    caches: ["open", "keys", "delete", "match", "has"],
  };

  for (const [name, methods] of Object.entries(STORAGE_APIS)) {
    try {
      const deny = makeDenyApi(name, methods);
      Object.defineProperty(self, name, {
        value: deny,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      try { self[name] = undefined; } catch { /* ignore */ }
      try { delete self[name]; } catch { /* ignore */ }
    }
  }

  if (self.navigator && self.navigator.storage) {
    try {
      self.navigator.storage.getDirectory = function denied() {
        return Promise.reject(new Error(reason("navigator.storage.getDirectory (OPFS)")));
      };
    } catch { /* ignore */ }
  }
}
// ---- Python's permissioned network access (bead chrome-agent-platform-4p7j.2,
// stage S0.5) ---------------------------------------------------------------
//
// S0 above removed every ambient network global from this worker. That was
// never meant to be the end state: Paul's requirement is that model-authored
// Python CAN make requests, but only ones the owner granted, only through a
// proxy the owner can see, and only with a record. So this worker gets ONE way
// out — `await cap.fetch(url)` — and it is not a network capability at all. It
// is a message.
//
//   Python cap.fetch  ->  capFetchRequest (here)  ->  postMessage to the
//   offscreen host  ->  chrome.runtime to the SERVICE WORKER  ->  grant check,
//   the one real fetch, and the record  ->  the answer back down the same path.
//
// Nothing in this file decides anything. There is no allow-list here, no
// credential policy here, no logging here — all of that is in the service
// worker (background/service-worker.js "python.fetch" + lib/python-network.js),
// deliberately, so that a reader who wants to know what Python may reach has
// exactly one place to read and this worker cannot quietly disagree with it.
// This side is a mailbox.
//
// AWAITABLE, NOT SYNCHRONOUS. The shim returns a promise the Python side
// awaits; runPythonAsync supports that, so no SharedArrayBuffer/Atomics gymnastics
// are needed. The honest consequence is stated in cap.py's docstring: `requests`
// and `urllib` CANNOT be offered on top of an async primitive and stay
// unavailable. An import of one of them raises a message pointing at cap.fetch
// rather than a bare ModuleNotFoundError.
let currentRunId = "";
let nextCallId = 0;
const pendingFetches = new Map();

/** The Python-facing primitive. Takes a JSON request string, resolves with a
 * JSON response string. It NEVER rejects: every outcome, including "the proxy
 * could not be reached", comes back as an ok:false envelope, so the Python side
 * has exactly one shape to read and raises the exception itself. */
function capFetchRequest(payloadJson) {
  return new Promise((resolve) => {
    const fail = (error) => resolve(JSON.stringify({ ok: false, error }));
    let payload;
    try {
      payload = JSON.parse(String(payloadJson ?? "{}"));
    } catch {
      fail("the request could not be encoded for the network proxy");
      return;
    }
    const callId = "cap-fetch-" + (++nextCallId);
    pendingFetches.set(callId, resolve);
    try {
      self.postMessage({
        type: "python.fetch",
        runId: currentRunId,
        callId,
        url: String(payload.url ?? ""),
        method: String(payload.method ?? "GET"),
        headers: payload.headers && typeof payload.headers === "object" ? payload.headers : {},
        body: typeof payload.body === "string" ? payload.body : "",
      });
    } catch (error) {
      pendingFetches.delete(callId);
      fail("the network proxy could not be reached from this interpreter: " + String(error?.message ?? error));
    }
  });
}

// The `cap` module, written into the interpreter's site-packages so `import cap`
// is an ordinary import and the program's own namespace stays clean.
const CAP_PY_SOURCE = `"""cap - the only way out of this interpreter, and a narrow one.

This Python runs with NO ambient network access: fetch, XMLHttpRequest,
WebSocket, EventSource and friends were removed from the environment before your
code started. That is deliberate. Network access here is a permission the owner
grants per origin, not a capability that comes with the interpreter.

    import cap
    response = await cap.fetch("https://api.example.com/items")
    data = response.json()

WHAT YOU CAN COUNT ON
  * cap.fetch is AWAITABLE. Call it with await, from an async function or at
    top level (this runtime supports top-level await).
  * GET, HEAD and POST only.
  * Only origins the owner has granted. An ungranted origin raises
    cap.NetworkRefused naming the origin - it is not an outage and retrying will
    not help; the owner has to grant it.
  * Requests are ANONYMOUS. No cookies and no credentials are ever attached, and
    you cannot set Cookie or Authorization headers. A granted origin buys
    anonymous access, never the owner's logged-in session there.
  * Redirects are NOT followed. A granted origin that redirects elsewhere is
    refused, because the owner granted an origin and not a starting point.
  * EVERY request and every refusal is recorded and shown to the owner: method,
    URL, status, size, duration. Visibility is the point of the design.

WHY NOT requests / urllib / httpx
  They are synchronous, and the only primitive available here is asynchronous -
  a message to the extension and an answer back. There is no honest way to put a
  blocking API on top of that, so those libraries are not offered rather than
  offered broken. Importing one tells you this and points back here, whether or
  not you imported cap first - the guard is installed when the interpreter starts.
"""

import json as _json
import sys as _sys

import _cap_net as _bridge

__all__ = ["fetch", "Response", "NetworkRefused", "NetworkError"]


class NetworkRefused(Exception):
    """The request was not permitted: the origin is not granted, the method or
    scheme is not allowed, the address is private, or a redirect left the
    granted origin. Retrying changes nothing - the owner decides."""


class NetworkError(Exception):
    """The request was permitted but did not complete (DNS, TLS, the network,
    or the server). Retrying may help."""


class Response:
    """One HTTP response. Bodies are text; use .json() to parse."""

    __slots__ = ("status", "url", "headers", "text", "bytes")

    def __init__(self, payload):
        self.status = payload.get("status")
        self.url = payload.get("url") or ""
        self.headers = dict(payload.get("headers") or {})
        self.text = payload.get("text") or ""
        self.bytes = payload.get("bytes") or 0

    @property
    def ok(self):
        """True for a 2xx status. A 404 is a completed request, not a refusal."""
        return isinstance(self.status, int) and 200 <= self.status < 300

    def json(self):
        return _json.loads(self.text)

    def __repr__(self):
        return "<cap.Response %s %s (%s bytes)>" % (self.status, self.url, self.bytes)


async def fetch(url, method="GET", headers=None, body=None):
    """Make one HTTP request through the owner's grant. Awaitable.

    Raises cap.NetworkRefused when the request was not permitted (the message
    names the origin and how to grant it) and cap.NetworkError when it was
    permitted but failed. Both are recorded for the owner either way."""
    if body is None:
        payload_body = ""
    elif isinstance(body, (str, bytes, bytearray)):
        payload_body = body.decode("utf-8") if isinstance(body, (bytes, bytearray)) else body
    else:
        payload_body = _json.dumps(body)
    request = _json.dumps({
        "url": str(url),
        "method": str(method).upper(),
        "headers": {str(k): str(v) for k, v in dict(headers or {}).items()},
        "body": payload_body,
    })
    raw = await _bridge.request(request)
    payload = _json.loads(raw)
    if not payload.get("ok"):
        message = payload.get("error") or "the request was refused"
        if "failed" in message and "not granted" not in message:
            raise NetworkError(message)
        raise NetworkRefused(message)
    return Response(payload)


class _NoHttpClientLibraries:
    """Turn 'ModuleNotFoundError: requests' into an answer.

    These are third-party libraries that are not installed here anyway, so this
    changes no behaviour - only the message, from a dead end into a pointer at
    the thing that does work."""

    _NAMES = frozenset({"requests", "httpx", "aiohttp", "urllib3", "treq", "grequests"})

    def find_spec(self, fullname, path=None, target=None):
        root = fullname.split(".")[0]
        if root in self._NAMES:
            raise ImportError(
                root + " is not available in this interpreter, and neither is any other "
                "HTTP client library: there is no ambient network here to build one on. "
                "Use cap.fetch instead - 'import cap' then 'await cap.fetch(url)'. It "
                "reaches only origins the owner has granted, sends no cookies, and every "
                "request is recorded for the owner to see."
            )
        return None


_sys.meta_path.insert(0, _NoHttpClientLibraries())
`;

/** Run a snippet in a THROWAWAY namespace. `pyodide.runPython` defaults to the
 * program's own `__main__` globals, and the interpreter is advertised as fresh
 * per run — installing the bridge must not leave `site`, `importlib` or a
 * stray underscore name sitting in the namespace the owner's code then runs in. */
function runIsolated(pyodide, code) {
  const ns = pyodide.toPy({});
  try {
    return pyodide.runPython(code, { globals: ns });
  } finally {
    try { ns.destroy(); } catch { /* the dict outlives the proxy if anything holds it */ }
  }
}

/** Install `cap` as a real importable module. Writing the file (rather than
 * exec-ing a string into a synthesised module) keeps `import cap` an ordinary
 * import with an ordinary traceback, and keeps the program's namespace clean.
 *
 * This THROWS on failure rather than continuing quietly. A Python runtime that
 * silently lacks the one documented way to reach the network would send the
 * model hunting for the ambient globals S0 removed, and the owner would see a
 * confusing failure instead of a clear one. */
function installCapModule(pyodide) {
  let dir = "";
  try {
    dir = String(runIsolated(pyodide, [
      "import sys, site",
      "_d = ''",
      "try:",
      "    _d = site.getsitepackages()[0]",
      "except Exception:",
      "    _d = ''",
      "if not _d:",
      "    for _p in sys.path:",
      "        if _p.endswith('site-packages'):",
      "            _d = _p",
      "            break",
      "_d",
    ].join("\n")) ?? "");
  } catch (error) {
    throw new Error("python network bridge: could not locate site-packages (" + String(error?.message ?? error) + ")");
  }
  if (!dir) throw new Error("python network bridge: could not locate site-packages (no candidate on sys.path)");
  try {
    pyodide.FS.writeFile(dir + "/cap.py", CAP_PY_SOURCE);
  } catch (error) {
    throw new Error("python network bridge: could not write cap.py (" + String(error?.message ?? error) + ")");
  }
  // A file written this instant can be invisible to an import that already
  // cached this directory's listing — the finder's cache has 1-second mtime
  // granularity, so the very first run is exactly the one at risk.
  try {
    runIsolated(pyodide, "import importlib\nimportlib.invalidate_caches()");
  } catch { /* a cold interpreter has nothing cached to invalidate */ }
  // Import it NOW, before the owner's program runs, for two reasons.
  //
  // The first is the import guard. cap installs a meta_path finder that turns
  // `import requests` into a message pointing at cap.fetch. Left to load lazily,
  // that guard would only exist AFTER `import cap` — which is exactly backwards:
  // the program reaching for `requests` is the one that has NOT found cap yet,
  // and it would get a bare "No module named 'requests'" and conclude the
  // network is simply absent. (Measured: the first real-browser run of
  // scripts/kat-python-permissioned-fetch.ts failed on precisely that.)
  //
  // The second is that a broken cap.py should fail HERE, loudly, at interpreter
  // startup, rather than as a mystery inside somebody's first await.
  try {
    runIsolated(pyodide, "import cap");
  } catch (error) {
    throw new Error("python network bridge: cap.py did not import (" + String(error?.message ?? error) + ")");
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
      stripAmbientStorage();
      // Then hand back the ONE narrow, permissioned, recorded way out. The
      // order matters here too: the ambient reach is gone before the granted
      // reach exists, so there is never a moment when both are available.
      pyodide.registerJsModule("_cap_net", { request: capFetchRequest });
      installCapModule(pyodide);
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
  if (message.type === "python.fetch.result") {
    // The host's answer to one cap.fetch. Correlated by callId, because a
    // program may have several requests in flight.
    const callId = String(message.callId ?? "");
    const resolve = pendingFetches.get(callId);
    if (!resolve) return; // a late answer to a call this run already abandoned
    pendingFetches.delete(callId);
    const result = message.result && typeof message.result === "object"
      ? message.result
      : { ok: false, error: "the network proxy returned nothing" };
    try {
      resolve(JSON.stringify(result));
    } catch {
      resolve(JSON.stringify({ ok: false, error: "the network proxy's answer could not be decoded" }));
    }
    return;
  }
  if (message.type !== "python.run") return;
  // The run id every cap.fetch frame carries, so the service worker can file
  // the record against the run the owner is looking at.
  currentRunId = String(message.runId ?? "");
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
