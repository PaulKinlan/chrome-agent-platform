// lib/python-runtime.js — the lazy Pyodide loader (CAP-FEATURE-PYODIDE-01).
//
// The ~24 MB Pyodide runtime is NOT bundled into the extension. It loads on
// demand from a pinned CDN entrypoint with an SRI integrity check, caches the
// verified bytes in OPFS (the cold-start cache), and degrades GRACEFULLY: any
// fetch/integrity/instantiation failure returns the product to "unavailable"
// with no exception escaping — the platform works without Python.
//
// The status machine is: `unavailable` -> `loading` -> `available` (success) or
// back to `unavailable` (any failure). `load` is single-flight (one in-flight
// load at a time; a concurrent caller awaits the same promise).

export const PYTHON_RUNTIME_PIN = Object.freeze({
  version: "0.26.4",
  jsUrl: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js",
  wasmUrl: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.asm.wasm",
  // The SRI integrity hashes are the SECURITY PIN: a substituted or truncated
  // CDN response fails the check and degrades to unavailable. The exact digest
  // is computed from the real bytes at the browser-gate lane (this module ships
  // the check + the pins; the hashes are filled before any production enable).
  jsIntegrity: "",
  wasmIntegrity: "",
});

export const PYTHON_STATUS = Object.freeze({
  unavailable: "unavailable",
  loading: "loading",
  available: "available",
});

/** An SRI-style integrity check over the fetched text. Empty pin = the check is
 * intentionally UNPINNED (the load still works, but the browser-gate lane MUST
 * fill the pin before any production enable). A non-empty pin that mismatches
 * throws (fail closed). */
export async function verifyIntegrity(text, { integrity, digest = null } = {}) {
  if (!integrity) return text; // unpinned — the browser-gate lane fills it.
  if (typeof integrity !== "string" || !/^sha384-[A-Za-z0-9+/=]+$/.test(integrity)) {
    throw new Error("python_runtime_bad_integrity_pin");
  }
  if (typeof digest !== "function") throw new Error("python_runtime_no_digest");
  const want = integrity.slice("sha384-".length);
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const gotBytes = new Uint8Array(await digest(bytes));
  const got = btoa(String.fromCharCode(...gotBytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (got !== want) throw new Error("python_runtime_integrity_mismatch");
  return text;
}

/** The lazy loader. `loadPyodide` is the injected dependency: the REAL one (the
 * CDN glue + wasm instantiation) at the browser-gate lane; a mock in the KATs.
 * `fetch`/`crypto` are injected for the no-Chrome tests. */
export function createPythonRuntime({ fetchImpl = null, cryptoImpl = null, cache = null } = {}) {
  const doFetch = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const digest = cryptoImpl?.subtle
    ? (bytes) => cryptoImpl.subtle.digest("SHA-384", bytes)
    : (bytes) => (typeof crypto !== "undefined" && crypto.subtle
      ? crypto.subtle.digest("SHA-384", bytes)
      : Promise.resolve(new ArrayBuffer(0)));
  const store = cache ?? { bytes: new Map(), get: null, set: null };

  let state = PYTHON_STATUS.unavailable;
  let runtime = null;
  let inflight = null;

  async function fetchPinned(url, integrity) {
    const cached = typeof store.get === "function" ? await store.get(url) : store.bytes.get(url);
    if (cached != null) return verifyIntegrity(cached, { integrity, digest });
    const res = await doFetch(url, { method: "GET" });
    if (!res || !res.ok) throw new Error("python_runtime_fetch_failed");
    const text = await res.text();
    await verifyIntegrity(text, { integrity, digest });
    if (typeof store.set === "function") await store.set(url, text);
    else store.bytes.set(url, text);
    return text;
  }

  function status() { return state; }

  async function load(loadPyodide) {
    if (state === PYTHON_STATUS.available) return { ok: true, runtime };
    if (inflight) return inflight;
    inflight = (async () => {
      state = PYTHON_STATUS.loading;
      try {
        await fetchPinned(PYTHON_RUNTIME_PIN.jsUrl, PYTHON_RUNTIME_PIN.jsIntegrity);
        await fetchPinned(PYTHON_RUNTIME_PIN.wasmUrl, PYTHON_RUNTIME_PIN.wasmIntegrity);
        if (typeof loadPyodide !== "function") throw new Error("python_runtime_no_loader");
        runtime = await loadPyodide();
        state = PYTHON_STATUS.available;
        return { ok: true, runtime };
      } catch (error) {
        state = PYTHON_STATUS.unavailable; // the graceful degrade.
        return { ok: false, error: String(error?.message ?? error) };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return Object.freeze({ status, load });
}
