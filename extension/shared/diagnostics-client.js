// shared/diagnostics-client.js — the page-side half of the transparency
// surface. Installs capture of the PAGE realm's own failures (CSP violations,
// uncaught errors, unhandled rejections) and forwards them to the service
// worker's diagnostics buffer, then keeps the <error-console> + <security-shield>
// badge counts fresh.
//
// The extension pages load this so ONE console shows the whole extension (the SW
// captures its own errors; this forwards the page's). Degrades to a no-op in the
// docs showcase (no chrome.runtime).
//
// The badges are PUSH-driven (CAP-FB-20260830-HUB-POLLING-01). The service
// worker bumps ONE integer, `cap:diagnosticsRevision`, in chrome.storage.session
// whenever a diagnostic / security / usage entry lands or is cleared;
// `chrome.storage.onChanged` delivers that to every extension page without a
// port and without a timer. There is deliberately no setInterval here: a 5 s
// poll from every open new tab kept the MV3 worker awake for the life of the
// tab (two wakes per tab per 5 s) and was most of what filled the trace ring.

import { send } from "../lib/messages.js";

/** The session-storage key the SW bumps. Carries an integer only — never event content. */
export const DIAGNOSTICS_REVISION_KEY = "cap:diagnosticsRevision";

let installed = false;

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
 * Refresh the badge counts on the <error-console> + <security-shield> +
 * <diagnostics-panel> (if present). Called once on load and on every revision
 * change while visible.
 */
export async function refreshDiagnostics() {
  const consoleEl = document.querySelector("error-console");
  const shieldEl = document.querySelector("security-shield");
  const diagEl = document.querySelector("diagnostics-panel");
  if (!consoleEl && !shieldEl && !diagEl) return;

  try {
    if (consoleEl || diagEl) {
      const res = await send("diagnostics.list");
      const count = res?.count ?? 0;
      if (consoleEl) consoleEl.setAttribute("count", String(count));
      if (diagEl) {
        diagEl.setAttribute("count", String(count));
        if (count > 0) diagEl.setAttribute("attention", "");
        else diagEl.removeAttribute("attention");
        if (diagEl._open) diagEl.refresh?.();
      }
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

/**
 * Subscribe to the SW's diagnostics revision. `onChange` runs on every bump
 * while the page is visible; a bump that arrives while the page is hidden is
 * remembered and delivered ONCE when the page becomes visible again (so ten
 * background hub tabs cost nothing until one is looked at). Returns an
 * unsubscribe function. No timer is ever installed.
 */
export function subscribeDiagnosticsRevision(onChange) {
  if (typeof chrome === "undefined" || !chrome.storage) return () => {};
  let stale = false;
  const deliver = () => {
    stale = false;
    try {
      const r = onChange();
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch { /* a subscriber never breaks the subscription */ }
  };
  const onStorageChanged = (changes, area) => {
    if (area && area !== "session") return;
    if (!changes || !(DIAGNOSTICS_REVISION_KEY in changes)) return;
    if (document.visibilityState === "hidden") {
      stale = true;
      return;
    }
    deliver();
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible" && stale) deliver();
  };
  // Prefer the per-area event (no area filter needed); fall back to the
  // top-level event with an area check on older channels.
  const sessionEvent = chrome.storage.session?.onChanged;
  const topEvent = chrome.storage.onChanged;
  const target = sessionEvent?.addListener ? sessionEvent : topEvent;
  target?.addListener?.(onStorageChanged);
  document.addEventListener?.("visibilitychange", onVisibility);
  return () => {
    target?.removeListener?.(onStorageChanged);
    document.removeEventListener?.("visibilitychange", onVisibility);
  };
}

let unsubscribe = null;

/**
 * Keep the badges live without a timer: refresh once now, then on every
 * revision change (deferred while hidden, delivered on return to visible).
 */
export function startDiagnosticSubscription() {
  stopDiagnosticSubscription();
  refreshDiagnostics().catch(() => {});
  unsubscribe = subscribeDiagnosticsRevision(() => refreshDiagnostics());
}

export function stopDiagnosticSubscription() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

/**
 * @deprecated Kept for one release as an alias of startDiagnosticSubscription.
 * The interval argument is ignored — the badges are push-driven now.
 */
export function startDiagnosticPolling(_intervalMs) {
  startDiagnosticSubscription();
}

/** @deprecated Alias of stopDiagnosticSubscription. */
export function stopDiagnosticPolling() {
  stopDiagnosticSubscription();
}
