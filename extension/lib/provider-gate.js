// lib/provider-gate.js — the provider network gate + the circuit-breaker.
//
// Two related fixes (Paul, 2026-08-17):
//
// 1. The provider FETCH fails ("TypeError: Failed to fetch") because the
//    extension's OPTIONAL host permission for the provider's origin is not
//    granted. The manifest has only optional_host_permissions [http/https *],
//    so the service worker's cross-origin fetch to the provider (OpenAI /
//    Anthropic / Gemini / DeepSeek / a custom OpenAI-compatible endpoint)
//    needs the host permission granted — otherwise Chrome refuses the request.
//
// 2. When the provider IS unreachable (bad key, bad base URL, no network, no
//    host permission), every hook/task run fails identically and the console
//    FLOODS with "AI_APICallError"/"No output generated" per event. The
//    circuit-breaker below trips after a small number of consecutive provider
//    failures, so subsequent hook/task runs back off (fail quietly, no run, no
//    per-event log) until a successful provider call resets it.

/** Derive the host-permission origin pattern for a provider's base URL.
 * Returns null for localhost-ish / non-http(s) endpoints (nothing to grant). */
export function providerOriginPattern(cfg) {
  try {
    const u = new URL(cfg?.baseURL ?? "");
    if (u.protocol === "http:" || u.protocol === "https:") {
      return `${u.protocol}//${u.host}/*`;
    }
  } catch { /* invalid URL — no pattern */ }
  return null;
}

/** The providers that run LOCALLY (no network fetch → no host permission
 * needed). The demo model is deterministic + on-device; the Prompt API is
 * on-device Gemini nano. Neither makes a cross-origin fetch, so the network
 * gate must not block them (a stale baseURL from a previously-selected
 * network provider must not gate the local provider either). */
const LOCAL_PROVIDER_IDS = new Set(["demo", "prompt-api"]);

/** Whether the provider runs locally (no host permission needed). */
export function isLocalProvider(cfg) {
  const id = cfg?.provider ?? cfg?.id ?? "";
  return LOCAL_PROVIDER_IDS.has(String(id).toLowerCase());
}

/** Whether the provider's origin host permission is currently granted.
 * Outside a real extension (tests), there is no chrome.permissions — return
 * true so the gate does not block pure-logic tests. */
export async function hasProviderHostAccess(cfg) {
  const pattern = providerOriginPattern(cfg);
  if (!pattern) return true; // localhost / nothing to grant
  if (typeof chrome === "undefined" || !chrome.permissions?.contains) return true;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * Request the provider's host permission. MUST be called from a real user
 * gesture (the Settings Set/Update button, the Test connection button). Returns
 * { granted, pattern, error } — never swallows the result.
 */
export async function requestProviderHostAccess(cfg) {
  const pattern = providerOriginPattern(cfg);
  if (!pattern) return { granted: true, pattern: null, error: null };
  if (typeof chrome === "undefined" || !chrome.permissions?.request) {
    return { granted: true, pattern, error: null };
  }
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    return { granted: !!granted, pattern, error: granted ? null : "permission request denied" };
  } catch (e) {
    return { granted: false, pattern, error: String(e?.message ?? e) };
  }
}

// ── the circuit-breaker ─────────────────────────────────────────────────────

const MAX_CONSECUTIVE_FAILURES = 3;
const BREAKER_OPEN_MS = 60_000; // back off for 60s once tripped

let consecutiveFailures = 0;
let trippedAt = 0;
let lastReason = "";

/** Whether the breaker is currently OPEN (provider is down / blocked). */
export function providerBreakerOpen() {
  if (!trippedAt) return false;
  if (Date.now() - trippedAt < BREAKER_OPEN_MS) return true;
  // The cooldown elapsed — allow a retry probe (half-open) + reset the timer.
  trippedAt = 0;
  consecutiveFailures = 0;
  return false;
}

/** Record a provider failure. Trips the breaker once the threshold is hit. */
export function recordProviderFailure(reason) {
  consecutiveFailures += 1;
  lastReason = String(reason ?? "provider call failed");
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    trippedAt = Date.now();
    return { tripped: true, reason: lastReason };
  }
  return { tripped: false, reason: lastReason };
}

/** Record a provider success — closes the breaker. */
export function recordProviderSuccess() {
  consecutiveFailures = 0;
  trippedAt = 0;
  lastReason = "";
}

/** The combined pre-run gate: returns { ok, reason } — false when the provider
 * should not run (breaker open OR the host permission is missing). */
export async function providerRunGate(cfg) {
  // Local providers (demo + Prompt API) never fetch a remote origin — they
  // must not be gated by a host permission (or a stale baseURL inherited from
  // a previously-selected network provider).
  if (isLocalProvider(cfg)) return { ok: true, reason: "" };
  if (providerBreakerOpen()) {
    return { ok: false, reason: `provider is temporarily unavailable (${lastReason || "recent failures"}) — paused, will retry automatically` };
  }
  const hasHost = await hasProviderHostAccess(cfg);
  if (!hasHost) {
    const pattern = providerOriginPattern(cfg);
    return {
      ok: false,
      reason: `network access to the provider (${pattern ?? cfg?.baseURL ?? "unknown"}) is not granted — click "Use"/"Test connection" in Settings to grant it`,
    };
  }
  return { ok: true, reason: "" };
}

/** A clear, user-facing run refusal (the gate or a config problem). */
export class ProviderUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/** Whether an error is a PROVIDER failure (network/config/credential), as
 * opposed to a tool error or a fence abort. Only provider failures trip the
 * circuit-breaker (a bad tool call must not pause the agent). */
export function isProviderError(e) {
  const m = String(e?.message ?? e?.name ?? e ?? "").toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("ai_apicallerror") ||
    m.includes("ai_nooutputgeneratederror") ||
    m.includes("ai_retryerror") ||
    m.includes("failed after") ||
    m.includes("network") ||
    m.includes("unauthorized") ||
    m.includes("401") ||
    m.includes("403") ||
    m.includes("429") ||
    m.includes("api key") ||
    m.includes("fetch")
  );
}

// ── flood suppression: log a gate refusal ONCE per reason, not per event ───

let lastLoggedGate = "";

/**
 * Log a provider-gate refusal at most once per reason (the hook/task callers
 * call this instead of a per-event console.error — a missing host permission
 * or an open breaker must not flood the console with one identical line per
 * tab event / alarm tick). Returns true if this call actually logged.
 */
export function logGateOnce(reason) {
  const key = String(reason ?? "");
  if (key === lastLoggedGate) return false;
  lastLoggedGate = key;
  console.warn(`[provider-gate] ${key}`);
  return true;
}

/** Clear the dedupe so a NEW distinct reason can log (used on success). */
export function resetGateLog() {
  lastLoggedGate = "";
}
