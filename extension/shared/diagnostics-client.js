// shared/diagnostics-client.js — the page-side half of the transparency
// surface. Installs capture of the PAGE realm's own failures (CSP violations,
// uncaught errors, unhandled rejections) and forwards them to the service
// worker's diagnostics buffer, then keeps the <error-console> + <security-shield>
// badge counts fresh.
//
// The extension pages load this so ONE console shows the whole extension (the SW
// captures its own errors; this forwards the page's). Degrades to a no-op in the
// docs showcase (no chrome.runtime).

import { send } from "../lib/messages.js";

let installed = false;
let pollTimer = null;

/** Forward the page's CSP/security violations + errors to the SW. */
export function installPageDiagnostics() {
  if (installed) return;
  installed = true;
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  const report = (entries) => {
    send("diagnostics.report", { entries }).catch(() => {});
  };

  // CSP violations (the eval/script blocks — the shield's transparency surface).
  document.addEventListener?.("securitypolicyviolation", (ev) => {
    report([{
      kind: "csp",
      message: `${ev?.violatedDirective || "CSP"}: ${ev?.blockedURI || "blocked resource"}`,
    }]);
  });

  // Uncaught errors in this page realm.
  window.addEventListener?.("error", (ev) => {
    report([{ kind: "runtime", level: "error", message: ev?.message || "page error", source: "page" }]);
  });

  // Unhandled promise rejections in this page realm.
  window.addEventListener?.("unhandledrejection", (ev) => {
    const reason = ev?.reason;
    // Do not dereference arbitrary rejection objects/proxies before the SW's
    // bounded redaction boundary.
    const message = typeof reason === "string" ? reason : "<redacted:structured rejection>";
    report([{ kind: "rejection", level: "error", message, source: "page" }]);
  });
}

/**
 * Refresh the badge counts on the <error-console> + <security-shield> (if
 * present). Call once on load + periodically (or on the progress port).
 */
export async function refreshDiagnostics() {
  const consoleEl = document.querySelector("error-console");
  const shieldEl = document.querySelector("security-shield");
  if (!consoleEl && !shieldEl) return;

  try {
    if (consoleEl) {
      const res = await send("diagnostics.list");
      const count = res?.count ?? 0;
      consoleEl.setAttribute("count", String(count));
    }
  } catch { /* no backend */ }

  try {
    if (shieldEl) {
      const res = await send("security.state");
      const count = res?.count ?? 0;
      shieldEl.setAttribute("count", String(count));
      if (count > 0) shieldEl.setAttribute("attention", "");
      else shieldEl.removeAttribute("attention");
    }
  } catch { /* no backend */ }
}

/** Start a lightweight poll so the badges stay live without a full reload. */
export function startDiagnosticPolling(intervalMs = 5000) {
  stopDiagnosticPolling();
  pollTimer = setInterval(() => refreshDiagnostics().catch(() => {}), intervalMs);
}

export function stopDiagnosticPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
