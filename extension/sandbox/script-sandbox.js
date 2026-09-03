// sandbox/script-sandbox.js — the SANDBOXED extension page that runs an
// agent-generated script (Paul 2026-08-17). This page is declared in the
// manifest `sandbox` key, so it has NO access to chrome.* APIs, no same-origin,
// and its CSP permits the inline/eval execution that a regular extension page
// forbids (the extension CSP blocks inline scripts in srcdoc iframes). The host
// (the offscreen doc / NTP hub) loads this page in an iframe, sends the source +
// a one-time nonce over postMessage, bridges the controlled fetch, and receives
// the result back. The script's ONLY capabilities are `fetch(url, opts)` (the
// HOST fetches on the extension's behalf — URL-validated + size-bounded) and
// `log(...)` — no DOM of the host, no extension APIs, no direct network.

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const d = event.data;
  if (!d || typeof d !== "object" || d.type !== "cap:script-source") return;
  runScript(String(d.source ?? ""), String(d.runId ?? ""), String(d.nonce ?? ""));
});

// chrome-agent-platform-np64 (2026-09-03): the manifest-sandbox page is an
// opaque origin (no allow-same-origin), so a script source that reaches for
// localStorage/sessionStorage/indexedDB/cookies/OPFS gets a raw SecurityError
// and the agent — who often guesses those APIs to cache state between runs —
// learns nothing. Redefine the known-broken storage surfaces so the thrown
// error TEACHES: a sandboxed script shares no state between runs, so compute
// and return the value; durable state lives with the platform (the agent's
// memory_set / create_asset), never in the script. window.fetch is NOT touched
// — it IS the script's controlled host-bridged api.
(function installScriptSandboxTeachGuards() {
  const fix = "a sandboxed script keeps no state between runs - compute and return the value; store durable data with the platform (memory_set / create_asset) from the agent side";
  const teach = (api) => new Error(api + " is unavailable inside the script sandbox - " + fix);
  const denyStore = (prop) => {
    try {
      Object.defineProperty(window, prop, { configurable: true, get: () => { throw teach(prop); } });
    } catch { /* surface already defined by a caller */ }
  };
  const denyApi = (prop, methods) => {
    try {
      Object.defineProperty(window, prop, {
        configurable: true,
        get: () => {
          const o = {};
          for (const m of methods) o[m] = () => { throw teach(prop + "." + m); };
          return o;
        },
      });
    } catch { /* surface already defined by a caller */ }
  };
  denyStore("localStorage");
  denyStore("sessionStorage");
  denyApi("indexedDB", ["open", "deleteDatabase"]);
  denyApi("caches", ["open", "keys", "delete", "match", "has"]);
  try {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "",
      set: () => { throw teach("document.cookie"); },
    });
  } catch { /* surface already defined by a caller */ }
  try {
    if (navigator.storage && navigator.storage.getDirectory) {
      navigator.storage.getDirectory = () => Promise.reject(teach("navigator.storage.getDirectory (OPFS)"));
    }
  } catch { /* storage manager absent */ }
})();

function runScript(source, runId, nonce) {
  const post = (type, extra) => {
    try { window.parent.postMessage({ type, runId, nonce, ...extra }, "*"); } catch { /* parent gone */ }
  };
  const pending = {};
  const call = (kind, payload) => new Promise((resolve, reject) => {
    const callId = Math.random().toString(36).slice(2);
    pending[callId] = { resolve, reject };
    post("cap:script-call", { callId, kind, payload: payload || {} });
  });

  // The controlled api as globals (shadow the natives — the page has no network
  // of its own, so this is the script's only fetch + log).
  window.fetch = (url, opts) => call("fetch", { url: String(url ?? ""), opts: opts || {} });
  window.log = (...args) => post("cap:script-log", { text: args.map((x) => String(x)).join(" ") });

  window.addEventListener("message", (ev) => {
    if (ev.source !== window.parent) return;
    const d = ev.data;
    if (!d || d.runId !== runId || d.type !== "cap:script-call-result") return;
    const p = pending[d.callId];
    if (!p) return;
    delete pending[d.callId];
    d.ok ? p.resolve(d.value) : p.reject(new Error(d.error || "call failed"));
  });

  // The source is the body of an async function, so `await fetch(...)`, `log(...)`,
  // and `return <value>` all work. The sandboxed page allows the Function
  // constructor (its CSP is `sandbox allow-scripts`, no `script-src 'self'`).
  let fn;
  try {
    fn = new Function("return (async function(){\n" + source + "\n})();");
  } catch (e) {
    post("cap:script-error", { error: String(e && e.message ? e.message : e) });
    return;
  }
  Promise.resolve()
    .then(fn)
    .then((result) => post("cap:script-result", { ok: true, result }))
    .catch((err) => post("cap:script-error", { error: String(err && err.message ? err.message : err) }));
}
