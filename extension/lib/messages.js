// lib/messages.js — thin wrapper over chrome.runtime messaging for UI pages.
//
// `send` is the SINGLE chokepoint for ntp.js + sidepanel.js. It must never leave
// a caller hanging: a service worker killed/suspended mid-route leaves the
// sendMessage callback NEVER fired (the port stays open, nothing resolves), which
// dead-renders every surface that awaits it (the real-profile "everything is
// broken" class). The bounded timeout settles with an honest {ok:false, error}
// so callers show an error + Retry instead of a blank/loading-forever surface.
// Run dispatches are TERMINAL HANDSHAKES: the route responds only when the
// run completes (minutes for a real task) — the 12s dead-surface bound must
// never apply to them (it produced "the agent worker didn't answer" on any
// run over 12s while the run actually finished — owner P0 2026-08-27).
const LONG_RUN_ROUTES = new Set(["agent.run", "named-agent.run", "background-agent.run", "agent.delegate"]);
const LONG_RUN_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — a real task's ceiling

export function send(type, payload = {}, timeoutMs = 12000) {
  const effectiveTimeout = LONG_RUN_ROUTES.has(type) ? LONG_RUN_TIMEOUT_MS : timeoutMs;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, error: "the agent worker didn't answer — it may be busy (retry)" });
    }, effectiveTimeout);
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          finish({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          finish(res ?? { ok: true });
        }
      });
    } catch (e) {
      clearTimeout(timer);
      finish({ ok: false, error: String(e) });
    }
  });
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}
