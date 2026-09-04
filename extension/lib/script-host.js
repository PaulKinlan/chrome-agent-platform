// lib/script-host.js — the shared HOST for agent-generated scripts
// (Paul 2026-08-17). The script runs in a SANDBOXED EXTENSION PAGE (declared in
// the manifest `sandbox` key — sandbox/script-sandbox.html), which is the ONLY
// place arbitrary agent-generated JS can run under MV3: the extension CSP blocks
// inline scripts in a srcdoc iframe, but a sandboxed page has its own CSP
// (`sandbox allow-scripts`) + no chrome.* access. This host (the offscreen doc or
// the NTP hub) loads that page in an iframe, sends the source + a one-time nonce,
// bridges the controlled fetch (URL-validated + size-bounded), and resolves with
// the result.


/** Validate a fetch URL: http/https only, no credentials. */
function validateUrl(url) {
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    return { ok: false, error: "invalid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: `protocol ${u.protocol} is not allowed (http/https only)` };
  }
  if (u.username || u.password) {
    return { ok: false, error: "URLs with credentials are not allowed" };
  }
  return { ok: true, url: u.href };
}

/** The read-only fetch capability (GET/HEAD, size-bounded). Routed through the
 * SERVICE WORKER (chrome.runtime `cap:fetch`) so the cross-origin fetch carries
 * the extension's host permission — a DIRECT fetch from the NTP/offscreen page
 * is CORS-blocked for a cross-origin page with no Access-Control-Allow-Origin. */
export async function runFetch(payload, runId = null) {
  const v = validateUrl(payload?.url);
  if (!v.ok) return { ok: false, error: v.error };
  const method = payload?.opts?.method ? String(payload.opts.method).toUpperCase() : "GET";
  if (method !== "GET" && method !== "HEAD") {
    return { ok: false, error: `method ${method} is not allowed (GET/HEAD only)` };
  }
  // Prefer the SW route (host permission → no CORS wall). Fall back to a direct
  // fetch only when chrome.runtime is absent (a unit test / non-extension host),
  // where the caller's context is trusted.
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      // The run id lets the SW apply THIS run's approved host allow-list
      // (CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01); a fetch outside a
      // registered run is refused there.
      const res = await chrome.runtime.sendMessage({ type: "cap:fetch", url: v.url, method, runId });
      if (res?.ok) return res;
      return { ok: false, error: res?.error ?? "fetch failed" };
    } catch (e) {
      return { ok: false, error: `fetch failed: ${e?.message ?? e}` };
    }
  }
  let res;
  try {
    res = await fetch(v.url, { method, headers: payload?.opts?.headers && typeof payload.opts.headers === "object" ? payload.opts.headers : undefined });
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e?.message ?? e}` };
  }
  let text = "";
  try {
    // Response bodies are one-shot streams: cache the single read before
    // bounding it (arrayBuffer() followed by text() throws in Chrome).
    text = await res.text();
  } catch {
    text = "";
  }
  return { ok: true, status: res.status, url: res.url, text };
}

/**
 * Run one script source to completion in the sandboxed page. Resolves
 * `{ ok, result, logs }` or `{ ok:false, error, logs }`. Bounded by `timeoutMs`.
 */
export function runScriptInIframe(doc, source, runId, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const nonce = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `nonce-${Math.random().toString(36).slice(2)}`;
    const sandboxUrl = (typeof chrome !== "undefined" && chrome.runtime?.getURL)
      ? chrome.runtime.getURL("sandbox/script-sandbox.html")
      : null;
    if (!sandboxUrl) {
      resolve({ ok: false, error: "sandbox page unavailable" });
      return;
    }
    const iframe = doc.createElement("iframe");
    iframe.setAttribute("title", "agent script sandbox");
    iframe.style.display = "none";
    iframe.src = sandboxUrl;
    doc.body.appendChild(iframe);

    const logs = [];
    let settled = false;
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const d = event.data;
      if (!d || typeof d !== "object" || d.runId !== runId || d.nonce !== nonce) return;
      switch (d.type) {
        case "cap:script-call": {
          if (d.kind === "fetch") {
            runFetch(d.payload, runId).then((value) => {
              iframe.contentWindow?.postMessage(
                { type: "cap:script-call-result", runId, callId: d.callId, ok: value.ok, value: value.ok ? value : undefined, error: value.ok ? undefined : value.error },
                "*"
              );
            });
          } else {
            iframe.contentWindow?.postMessage(
              { type: "cap:script-call-result", runId, callId: d.callId, ok: false, error: `unknown call kind ${d.kind}` },
              "*"
            );
          }
          break;
        }
        case "cap:script-log":
          if (typeof d.text === "string") logs.push(d.text.slice(0, 2000));
          break;
        case "cap:script-result":
          settle({ ok: true, result: d.result, logs });
          break;
        case "cap:script-error":
          settle({ ok: false, error: typeof d.error === "string" ? d.error : "script failed", logs });
          break;
      }
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      (doc.defaultView || window).removeEventListener("message", onMessage);
      try { iframe.remove(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => settle({ ok: false, error: "script timed out", logs }), timeoutMs);
    (doc.defaultView || window).addEventListener("message", onMessage);

    // Send the source once the sandbox page has loaded (its listener is ready).
    const sendSource = () => {
      if (settled) return;
      iframe.contentWindow?.postMessage({ type: "cap:script-source", source, runId, nonce }, "*");
    };
    iframe.addEventListener("load", sendSource);
    // The sandbox page may load very fast; also attempt immediately in case the
    // load event already fired.
    setTimeout(sendSource, 0);
  });
}

/** The runtime-message handler both the offscreen doc and the NTP hub register
 * so the service worker's `chrome.runtime.sendMessage` reaches whichever host
 * is open. A TWO-PHASE CLAIM PROTOCOL prevents double execution when two hosts
 * are open at once (the offscreen doc AND the hub): the SW first announces the
 * runId, the hosts claim it (the SW's sendMessage resolves with the FIRST
 * claim), then the SW sends the source addressed to the winning host only.
 *
 * `hostId` identifies the caller ("offscreen" or "ntp").
 *
 * Returns `true` to hold the channel for the async response. */
export function handleScriptRunMessage(message, sendResponse, doc = document, hostId = "host") {
  if (message?.type === "cap:script-run-announce") {
    // Claim phase: the FIRST host to respond wins (Chrome resolves the SW's
    // sendMessage with the first sendResponse). Identify ourselves so the SW
    // can address the source back to us.
    if (typeof message.runId !== "string" || message.runId.length < 8 || message.runId.length > 64) return false;
    sendResponse({ claimed: true, host: hostId, runId: message.runId });
    return false;
  }
  if (message?.type !== "cap:script-run") return false;
  const { source, runId, for: forHost } = message;
  // Only the claimed host executes — a script addressed to another host is
  // dropped (prevents every fetch/side-effect firing twice).
  if (forHost && forHost !== hostId) return false;
  if (typeof source !== "string" || typeof runId !== "string" || runId.length < 8 || runId.length > 64) {
    sendResponse({ ok: false, error: "invalid script-run request" });
    return false;
  }
  runScriptInIframe(doc, source, runId).then((outcome) => sendResponse(outcome));
  return true;
}
