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

const MAX_DETAIL_BYTES = 800;
const MAX_INPUT_CODE_UNITS = 4096;
const encoder = new TextEncoder();

function byteCap(value, maxBytes = MAX_DETAIL_BYTES) {
  const source = String(value).slice(0, MAX_INPUT_CODE_UNITS);
  let out = "";
  let used = 0;
  for (const ch of source) {
    const bytes = encoder.encode(ch).byteLength;
    if (used + bytes > maxBytes) return out + "…";
    out += ch;
    used += bytes;
  }
  return out;
}

function scrubPrimitive(value) {
  if (value == null) return value === null ? "<null>" : "<undefined>";
  const type = typeof value;
  if (type === "object" || type === "function" || type === "symbol") {
    // JavaScript has no trap-free way to distinguish a plain object from a
    // Proxy. Diagnostics therefore fail closed for EVERY arbitrary structure
    // rather than enumerating it, invoking accessors, or trusting prototypes.
    return "<redacted:structured>";
  }
  let text;
  try { text = String(value).slice(0, MAX_INPUT_CODE_UNITS).normalize("NFKC"); }
  catch { return "<redacted>"; }
  let clean = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a) || cp === 0x7f) continue;
    if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) continue;
    if ([0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff, 0x00ad, 0x2060, 0x034f].includes(cp)) continue;
    clean += ch;
    if (clean.length >= MAX_INPUT_CODE_UNITS) break;
  }
  clean = clean
    .replace(/\b(?:api[_-]?key|token|secret|password|passwd|authorization|credential|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=<redacted>")
    .replace(/\b(?:sk-|ghp_|xox[bap]-|Bearer\s+)[A-Za-z0-9._~+/=-]{8,}\b/gi, "<redacted:token>")
    .replace(/[0-9a-f]{24,}/gi, "<redacted:opaque>")
    .replace(/[A-Za-z0-9_-]{40,}/g, "<redacted:opaque>");
  return byteCap(clean);
}

/** Public fail-closed redaction. It never inspects object keys/prototypes. */
export function scrubEventDetail(detail) {
  return scrubPrimitive(detail);
}

function safeEntry(level, message, source, kind) {
  const entry = Object.create(null);
  entry.ts = now();
  entry.level = scrubPrimitive(level);
  entry.message = scrubPrimitive(message);
  entry.source = scrubPrimitive(source);
  entry.kind = scrubPrimitive(kind);
  return entry;
}

/** The one capture path — every entry funnels through here. */
export function push(level, message, source = "service-worker", kind = "runtime") {
  const entry = safeEntry(level, message, source, kind);
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  return entry;
}

/** Record a security-relevant event for the owner transparency surface. */
export function securityEvent(kind, detail = "") {
  const safeKind = scrubPrimitive(kind);
  const entry = safeEntry(
    safeKind === "csp" || safeKind === "blocked-action" ? "error" : "warn",
    detail,
    "security",
    safeKind,
  );
  securityBuffer.push(entry);
  if (securityBuffer.length > MAX_ENTRIES) {
    securityBuffer.splice(0, securityBuffer.length - MAX_ENTRIES);
  }
  push(entry.level, `[security:${safeKind}] ${entry.message}`, "security", safeKind);
  return entry;
}

/**
 * Approval audit events contain only schema-validated fixed fields. The opaque
 * 128-bit HMAC reference is intentionally retained for owner correlation; the
 * generic redactor would otherwise treat any long hex as possible key material.
 */
export function securityApprovalEvent(decision, action, targetRef) {
  if (!new Set(["requested", "approved", "denied", "consumed"]).has(decision)) return null;
  if (typeof action !== "string" || !/^[a-z][a-z.-]{0,63}$/.test(action)) return null;
  if (typeof targetRef !== "string" || !/^[0-9a-f]{32}$/.test(targetRef)) return null;
  const kind = `owner-${decision}`;
  const entry = safeEntry("warn", "approval", "security", kind);
  // These three fields passed the strict primitive grammar above; preserve the
  // HMAC reference for correlation instead of sending it through generic
  // secret-shaped-string redaction.
  entry.message = `approval ${decision} action=${action} ref=${targetRef}`;
  securityBuffer.push(entry);
  buffer.push(entry);
  if (securityBuffer.length > MAX_ENTRIES) securityBuffer.splice(0, securityBuffer.length - MAX_ENTRIES);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
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
      // Never dereference reason.message/name: a rejected Proxy can execute
      // those getters before the redactor sees it. Structured reasons fail
      // closed to a fixed marker; primitive strings remain bounded/redacted.
      const msg = typeof reason === "string" ? reason : "<redacted:structured rejection>";
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
      const safe = args.slice(0, 16).map(scrubPrimitive).join(" ");
      push("error", safe, "service-worker", "error");
      try { origError(safe); } catch { /* never throw from a logger */ }
    };
  }
  if (origWarn) {
    selfRef.console.warn = (...args) => {
      const safe = args.slice(0, 16).map(scrubPrimitive).join(" ");
      push("warn", safe, "service-worker", "warning");
      try { origWarn(safe); } catch { /* never throw from a logger */ }
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
