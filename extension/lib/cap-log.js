// lib/cap-log.js — extension-wide namespaced, levelled, timed logging.
//
// Owner requirement (CAP-FB-20260826-OBSERVABILITY-01): the extension had no
// observability — clicking a task could take ~10s with zero trace. This module
// is the single logging surface for the service worker, NTP, side panel,
// options, and content scripts.
//
// Usage:
//   import { capLog } from "./cap-log.js";        // (path varies by context)
//   const log = capLog("sw:grant");
//   log.info("grant check", { origin });          // normal+
//   log.debug("route detail", message?.type);     // verbose only
//   log.warn("grant DENIED", { origin, tool });   // normal+
//   log.error("dispatch failed", err);            // always (unless off)
//   const g = log.group("task run"); ... g.end();
//
// Levels: off (0) — nothing; normal (1) — info/warn/error; verbose (2) — adds
// debug + collapsed groups. The effective level is:
//   1. chrome.storage.local["cap:logVerbosity"] when set ({level,origin} shape,
//      or a legacy bare string), live-updated via storage.onChanged;
//   2. the build default injected by esbuild (`__CAP_BUILD_LOG_DEFAULT__`:
//      "verbose" in developer builds, "off" in store builds);
//   3. "off" when neither exists (safe production fallback).
// The bundled service worker (and options bundle) know the build default and
// persist it to storage at startup as {level, origin:"build"} so UNBUNDLED
// pages (NTP / side panel) inherit the same default. An explicit user choice
// (origin:"user") is never clobbered by a build.
//
// REDACTION: console arguments pass through scrubLogValue by default. The owner
// may explicitly enable full detail for LOCAL DevTools only; this can include
// page content, arguments, results, and errors. The ring buffer remains redacted
// regardless, so trace dumps/exports/shared reports never inherit that choice.
//
// Ring buffer: the last MAX_RING entries per context are kept in memory for
// the trace dump (`observability.dumpTrace`); bounded with an honest dropped
// counter. MV3-CSP-safe: no eval, no new Function.

import { SECRET_KEY_RE } from "./pure.js";

const LEVELS = Object.freeze({ off: 0, normal: 1, verbose: 2 });
const STORAGE_KEY = "cap:logVerbosity";
const FULL_DETAIL_STORAGE_KEY = "cap:logFullDetail";
const MAX_RING = 500;

/** Build-time default injected by esbuild define; "off" outside the bundles. */
const BUILD_DEFAULT =
  typeof __CAP_BUILD_LOG_DEFAULT__ === "string" ? __CAP_BUILD_LOG_DEFAULT__ : "off";

let currentLevel = normaliseLevel(BUILD_DEFAULT) ?? "off";
let currentFullDetail = false;
let storageReady = false;

/** @type {Array<{ts:number, level:string, ns:string, msg:string}>} */
const ring = [];
let dropped = 0;
const listeners = new Set();

function normaliseLevel(value) {
  return typeof value === "string" && value in LEVELS ? value : null;
}

function hasStorage() {
  try {
    return typeof chrome !== "undefined" && !!chrome?.storage?.local;
  } catch {
    return false;
  }
}

function readStoredLevel(value) {
  // {level, origin} shape, or a legacy bare string.
  if (typeof value === "string") return normaliseLevel(value);
  if (value && typeof value === "object") return normaliseLevel(value.level);
  return null;
}

function applyLevel(level, reason) {
  if (!level || level === currentLevel) return;
  currentLevel = level;
  for (const fn of listeners) {
    try { fn(level, reason); } catch { /* never throw from a logger */ }
  }
}

async function initFromStorage() {
  if (!hasStorage()) return;
  try {
    const read = await chrome.storage.local.get([STORAGE_KEY, FULL_DETAIL_STORAGE_KEY]);
    const stored = readStoredLevel(read?.[STORAGE_KEY]);
    currentFullDetail = read?.[FULL_DETAIL_STORAGE_KEY] === true;
    if (stored) applyLevel(stored, "storage");
    // Build default bridge: bundled contexts (SW / options) persist the build
    // default so unbundled pages inherit it — unless the OWNER chose a level.
    const record = read?.[STORAGE_KEY];
    const origin = record && typeof record === "object" ? record.origin : null;
    if (BUILD_DEFAULT !== "off" && origin !== "user" && stored !== BUILD_DEFAULT) {
      await chrome.storage.local.set({
        [STORAGE_KEY]: { level: BUILD_DEFAULT, origin: "build" },
      });
    }
    storageReady = true;
  } catch { /* storage races must never break logging */ }
  try {
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      if (STORAGE_KEY in (changes ?? {})) {
        const next = readStoredLevel(changes[STORAGE_KEY]?.newValue);
        if (next) applyLevel(next, "storage-change");
      }
      if (FULL_DETAIL_STORAGE_KEY in (changes ?? {})) {
        currentFullDetail = changes[FULL_DETAIL_STORAGE_KEY]?.newValue === true;
      }
    });
  } catch { /* older shims without onChanged are fine */ }
}

// Eagerly initialise (fire-and-forget; logging works synchronously with the
// build default / "off" until storage resolves).
const initPromise = initFromStorage();

/** Promise that settles once the storage-backed level has been read (tests). */
export function capLogReady() {
  return initPromise;
}

/** Owner-facing override: persist an explicit verbosity choice (sticky). */
export async function setLogVerbosity(level) {
  const clean = normaliseLevel(level);
  if (!clean) throw new Error(`invalid log verbosity: ${String(level)}`);
  applyLevel(clean, "explicit");
  if (hasStorage()) {
    await chrome.storage.local.set({ [STORAGE_KEY]: { level: clean, origin: "user" } });
  }
}

export function getLogVerbosity() {
  return currentLevel;
}

/**
 * Owner-only local console detail. This NEVER changes the redacted ring buffer
 * used by trace dumps/exports; it only controls values passed to DevTools.
 */
export async function setLogFullDetail(enabled) {
  currentFullDetail = enabled === true;
  if (hasStorage()) await chrome.storage.local.set({ [FULL_DETAIL_STORAGE_KEY]: currentFullDetail });
}

export function getLogFullDetail() {
  return currentFullDetail;
}

/** Test seam: subscribe to level changes. Returns an unsubscribe function. */
export function onLogVerbosityChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── redaction ───────────────────────────────────────────────────────────────
// Token-like shapes: 24+ hex/base64url runs, common API-key prefixes, Bearer
// tokens, and anything labelled like a grant/key id inside serialised JSON.
const TOKEN_RUN_RE = /\b[0-9A-Za-z_\-+/=]{24,}\b/g;
const KEYISH_RE = /\b(sk-[0-9A-Za-z_\-]+|AIza[0-9A-Za-z_\-]+|Bearer\s+[0-9A-Za-z_\-./=]+|ghp_[0-9A-Za-z]+|xox[baprs]-[0-9A-Za-z\-]+)/g;

function maskTokens(text) {
  return text
    .replace(KEYISH_RE, "«redacted»")
    .replace(TOKEN_RUN_RE, (m) => (m.length >= 24 ? "«redacted»" : m));
}

export function scrubLogValue(value, depth = 0) {
  if (value == null) return value;
  // dptw: no length truncation — secrets are masked, text is kept whole.
  if (typeof value === "string") return maskTokens(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return `${value.name}: ${maskTokens(value.message ?? "")}`;
  }
  if (depth >= 3) return "[…]";
  if (typeof value === "object") {
    try {
      // Never invoke accessors while logging an untrusted tool result. Build a
      // bounded descriptor-only snapshot before JSON serialization.
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors).filter((key) => key !== "length").slice(0, 20);
      const out = Array.isArray(value) ? [] : {};
      for (const key of keys) {
        const descriptor = descriptors[key];
        out[key] = SECRET_KEY_RE.test(key)
          ? "«redacted»"
          : "value" in descriptor
          ? scrubLogValue(descriptor.value, depth + 1)
          : "[accessor]";
      }
      const total = Object.keys(descriptors).filter((key) => key !== "length").length;
      if (total > keys.length) out[Array.isArray(out) ? out.length : "…"] = `…(+${total - keys.length} items)`;
      const json = JSON.stringify(out);
      return json ?? "[object]";
    } catch {
      return "[unserialisable]";
    }
  }
  return String(value);
}

function pushRing(level, ns, msg) {
  ring.push({ ts: Date.now(), level, ns, msg });
  if (ring.length > MAX_RING) {
    dropped += ring.length - MAX_RING;
    ring.splice(0, ring.length - MAX_RING);
  }
}

/** Recent log lines for the trace dump. Bounded, redacted (already scrubbed). */
export function dumpLogBuffer() {
  return { entries: ring.slice(), dropped, capacity: MAX_RING };
}

export function clearLogBuffer() {
  ring.length = 0;
  dropped = 0;
}

const CONSOLE_FN = { debug: "debug", info: "info", warn: "warn", error: "error" };

/**
 * Create a namespaced logger. Every line is prefixed `[cap:<ns>]` with an ISO
 * timestamp and the elapsed ms since this namespace's previous line.
 */
export function capLog(ns) {
  const tag = `[cap:${ns}]`;
  let last = null;

  function enabled(level) {
    if (currentLevel === "off") return false;
    if (level === "debug") return currentLevel === "verbose";
    return true; // info/warn/error at normal+
  }

  function emit(level, args) {
    const now = Date.now();
    const delta = last == null ? "—" : `+${now - last}ms`;
    last = now;
    const scrubbed = args.map((a) => scrubLogValue(a));
    const plain = scrubbed
      .map((a) => (typeof a === "string" ? a : typeof a === "object" ? JSON.stringify(a) : String(a)))
      .join(" ");
    // The ring is an export boundary and stays redacted even when the owner
    // explicitly asks DevTools for full local detail.
    pushRing(level, ns, plain);
    if (!enabled(level)) return;
    const fn = console[CONSOLE_FN[level]] ?? console.log;
    try {
      fn(`${tag} ${new Date(now).toISOString()} ${delta}`, ...(currentFullDetail ? args : scrubbed));
    } catch { /* never throw from a logger */ }
  }

  return {
    debug: (...args) => emit("debug", args),
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
    /** Collapsed console group for a multi-step operation (verbose only). */
    group(label) {
      const scrubbedLabel = scrubLogValue(label);
      pushRing("group", ns, String(scrubbedLabel));
      if (currentLevel === "verbose") {
        try { console.groupCollapsed(`${tag} ${currentFullDetail ? String(label) : scrubbedLabel}`); } catch { /* noop */ }
      }
      let closed = false;
      return {
        end() {
          if (closed) return;
          closed = true;
          if (currentLevel === "verbose") {
            try { console.groupEnd(); } catch { /* noop */ }
          }
        },
      };
    },
    /** True when debug-level lines are being emitted (cheap guards). */
    get verbose() {
      return currentLevel === "verbose";
    },
  };
}

const toolLog = capLog("tool");
let toolCallSequence = 0;

/**
 * Observe one real tool dispatch without changing its result/error semantics.
 * Every source routes through this seam (lazy catalog, worker bridge, WebMCP).
 */
export async function observeToolCall(name, args, dispatch, { source = "unknown", runId = null } = {}) {
  const toolName = String(name ?? "unknown").slice(0, 160);
  const callId = `${toolName}#${++toolCallSequence}`;
  const started = globalThis.performance?.now?.() ?? Date.now();
  toolLog.debug("tool-call:start", { callId, name: toolName, source, runId, arguments: args });
  try {
    const result = await dispatch();
    const durationMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - started);
    let failed = false;
    if (result != null && typeof result === "object") {
      try {
        const descriptors = Object.getOwnPropertyDescriptors(result);
        failed = descriptors.ok?.value === false || typeof descriptors.error?.value === "string";
      } catch { /* hostile proxy: logging never gets to inspect it */ }
    }
    toolLog.debug("tool-call:end", {
      callId,
      name: toolName,
      source,
      runId,
      durationMs: Math.round(durationMs * 10) / 10,
      outcome: failed ? "error" : "ok",
      result,
    });
    return result;
  } catch (error) {
    const durationMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - started);
    // At full local detail DevTools receives the Error object (stack/cause
    // included); the export-safe ring still receives scrubLogValue(error).
    toolLog.debug("tool-call:end", {
      callId,
      name: toolName,
      source,
      runId,
      durationMs: Math.round(durationMs * 10) / 10,
      outcome: "threw",
      error,
    });
    throw error;
  }
}
