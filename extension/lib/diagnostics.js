// lib/diagnostics.js — the extension-wide error + security telemetry ring buffer.
//
// The transparency surface (the <error-console> + <security-shield> components)
// reads from here. Everything the extension does that fails — provider errors,
// tool failures, scheduled-task failures, hook denials, cross-origin attempts,
// CSP violations — lands in ONE bounded buffer, exposed through two message
// routes (`diagnostics.list` / `diagnostics.clear` + `security.state`).
//
// MV3-CSP-safe: no eval / new Function. The buffer is a plain in-memory ring in
// the service worker (a page's own console errors are ALSO captured client-side
// and forwarded via `diagnostics.report` so one surface shows everything).

/** Maximum retained entries (bounded — Constitution §4: no unbounded growth). */
const MAX_ENTRIES = 200;

/** @type {Array<{ts:number, level:string, message:string, source:string, kind:string}>} */
const buffer = [];

/** Security-relevant events only (denied hooks, blocked actions, CSP, cross-origin). */
const securityBuffer = [];

let captureInstalled = false;

function now() {
  return Date.now();
}

/** The one capture path — every entry funnels through here. */
export function push(level, message, source = "service-worker", kind = "runtime") {
  const entry = { ts: now(), level, message: String(message ?? ""), source, kind };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  return entry;
}

/**
 * Record a security-relevant event for the shield. `kind` is a stable tag
 * (csp, denied-hook, blocked-action, cross-origin, permission, grant). A blocked
 * action is the transparency surface the shield shows — the user can SEE the
 * security posture + every refusal, not just the final state.
 */
export function securityEvent(kind, detail = "") {
  const entry = {
    ts: now(),
    level: kind === "csp" || kind === "blocked-action" ? "error" : "warn",
    message: String(detail ?? ""),
    source: "security",
    kind,
  };
  securityBuffer.push(entry);
  if (securityBuffer.length > MAX_ENTRIES) {
    securityBuffer.splice(0, securityBuffer.length - MAX_ENTRIES);
  }
  // A refusal is also a diagnostic entry (the console shows it too).
  push(entry.level, `[security:${kind}] ${entry.message}`, "security", kind);
  return entry;
}

/**
 * Install capture in the service worker: wrap console.error/warn + hook
 * `error` + `unhandledrejection`. Idempotent. The wrapped console is restored
 * on the same functions (no monkey-patching beyond what the SW owns).
 */
export function installDiagnosticCapture() {
  if (captureInstalled) return;
  captureInstalled = true;

  const selfRef = globalThis;

  // Unhandled promise rejections (the AI_NoOutputGeneratedError etc.).
  try {
    selfRef.addEventListener?.("unhandledrejection", (ev) => {
      const reason = ev?.reason;
      const msg =
        reason?.message || reason?.name ||
        (typeof reason === "string" ? reason : "unhandled rejection");
      push("error", `unhandled rejection: ${msg}`, "service-worker", "rejection");
    });
  } catch { /* no-op */ }

  // Uncaught errors in the worker realm.
  try {
    selfRef.addEventListener?.("error", (ev) => {
      push("error", ev?.message || "uncaught error", "service-worker", "error");
    });
  } catch { /* no-op */ }

  // Wrap console.error/warn so the buffer catches the existing error paths
  // (provider failures, tool failures, scheduled-task failures) WITHOUT the
  // callsites changing. The original still writes to the real console.
  const origError = selfRef.console?.error?.bind(selfRef.console);
  const origWarn = selfRef.console?.warn?.bind(selfRef.console);
  if (origError) {
    selfRef.console.error = (...args) => {
      push("error", args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "), "service-worker", "error");
      try { origError(...args); } catch { /* never throw from a logger */ }
    };
  }
  if (origWarn) {
    selfRef.console.warn = (...args) => {
      push("warn", args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "), "service-worker", "warning");
      try { origWarn(...args); } catch { /* never throw from a logger */ }
    };
  }
}

/** Full diagnostic list (newest first) — for the <error-console>. */
export function diagnosticList() {
  return { entries: buffer.slice().reverse(), count: buffer.length };
}

export function diagnosticClear() {
  buffer.length = 0;
  return { ok: true };
}

export function securityState() {
  return {
    violations: securityBuffer.slice().reverse(),
    count: securityBuffer.length,
  };
}

export function securityClear() {
  securityBuffer.length = 0;
  return { ok: true };
}
