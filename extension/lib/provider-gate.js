// lib/provider-gate.js — the provider network gate + the circuit-breaker.
//
// Two related fixes (Paul, 2026-08-17):
//
// 1. The provider FETCH can fail ("TypeError: Failed to fetch") when the
//    extension does not hold the host permission for the provider's origin.
//    Host access is install-granted (the manifest declares
//    host_permissions: ["<all_urls>"]), so every http(s) provider origin is
//    normally already covered; the service worker's cross-origin fetch to the
//    provider (OpenAI / Anthropic / Gemini / DeepSeek / a custom
//    OpenAI-compatible endpoint) still verifies the grant and fails closed if
//    it is somehow missing — otherwise Chrome refuses the request.
//
// 2. When the provider IS unreachable (bad key, bad base URL, no network, no
//    host permission), every hook/task run fails identically and the console
//    FLOODS with "AI_APICallError"/"No output generated" per event. The
//    circuit-breaker below trips after a small number of consecutive provider
//    failures, so subsequent hook/task runs back off (fail quietly, no run, no
//    per-event log) until a successful provider call resets it.

import { normalizeHostPattern, requestPermissionBundleFromGesture } from "./permission-orchestration.js";
import { safeProviderError } from "./pure.js";
import { effectiveBaseURL, PROVIDER_CHOICES } from "./provider.js";
import { defaultModelFor } from "./model-catalog.js";

/** Derive the exact host-permission origin pattern for a provider config's
 * EFFECTIVE base URL (the stored one, or the preset's when the stored one is
 * empty — CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01). Returns null for a
 * missing, malformed, credential-bearing, or non-http(s) URL. */
export function providerOriginPattern(cfg) {
  try {
    const u = new URL(effectiveBaseURL(cfg));
    if ((u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && !u.hostname.includes("*")) {
      return normalizeHostPattern(`${u.origin}/*`);
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

/** The user-facing reason for a NETWORK provider whose config cannot derive
 * an origin, or null when it can. Two distinct problems, named honestly:
 * no base URL at all (a BYO endpoint saved without one — presets never hit
 * this, they resolve to their endpoint), or a base URL that is not a valid
 * http(s) URL. Shared by the run gate, `provider.status` and the run-time
 * preflight so every surface says the same thing
 * (CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01). */
export function providerEndpointProblem(cfg) {
  if (isLocalProvider(cfg)) return null;
  if (providerOriginPattern(cfg)) return null;
  if (!effectiveBaseURL(cfg)) {
    return { code: "base_url_missing", reason: "this provider needs a base URL — set it in Settings → Providers" };
  }
  return { code: "base_url_invalid", reason: "the provider base URL is not a valid http(s) URL — fix it in Settings → Providers" };
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
 * Verify the provider's host permission install-grant.
 * Under Manifest V3 with <all_urls> install-granted, this verifies the grant
 * via chrome.permissions.contains({ origins: [pattern] }) with a bounded timeout.
 * Returns { granted, pattern, error, generation } — never swallows the result.
 */
const VERIFY_TIMEOUT_MS = 8_000;

export async function requestProviderHostAccess(cfg, { onIssued = null } = {}) {
  const pattern = providerOriginPattern(cfg);
  if (!pattern) return { granted: true, pattern: null, error: null, generation: null };
  if (typeof chrome === "undefined" || !chrome.permissions?.contains) {
    return { granted: true, pattern, error: null, generation: null };
  }
  if (onIssued) {
    try { onIssued({ pattern, generation: "install-verified", ours: true }); } catch { /* ignore */ }
  }
  let timer = null;
  try {
    const outcome = await Promise.race([
      chrome.permissions.contains({ origins: [pattern] }),
      new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), VERIFY_TIMEOUT_MS); }),
    ]);
    if (outcome === "timeout") {
      return { granted: false, pattern, error: "grant verification timed out", generation: null };
    }
    return {
      granted: outcome === true,
      pattern,
      error: outcome === true ? null : "network access to provider origin not verified — host access was not granted at install",
      generation: "install-verified",
    };
  } catch (e) {
    return {
      granted: false,
      pattern,
      error: safeProviderError(String(e?.message ?? e)),
      generation: null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Fallback / direct: a bounded install-grant VERIFICATION (no runtime request
 * exists — host access is granted at install via <all_urls>). */
async function _directBoundedRequest(pattern) {
  let timer = null;
  try {
    const outcome = await Promise.race([
      chrome.permissions.contains({ origins: [pattern] }),
      new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), VERIFY_TIMEOUT_MS); }),
    ]);
    if (outcome === "timeout") return { granted: false, pattern, error: "grant verification timed out" };
    return { granted: outcome === true, pattern, error: outcome === true ? null : "install grant not verified" };
  } catch (e) {
    return { granted: false, pattern, error: safeProviderError(String(e?.message ?? e)) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Late-settle broadcast consumer registry (pages call this to reconcile
 *  their UI when another surface's request settles). Returns an unlisten. */
export function onPermissionSettled(handler) {
  const listener = (msg) => {
    if (msg?.type === "provider-host-perm:settled") {
      try { handler(msg); } catch { /* consumer error never breaks the bus */ }
    }
  };
  try { chrome.runtime.onMessage.addListener(listener); } catch { /* non-extension */ }
  return () => { try { chrome.runtime.onMessage.removeListener(listener); } catch { /* noop */ } };
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
  if (isLocalProvider(cfg)) return { ok: true, reason: "", code: "ready" };
  if (providerBreakerOpen()) {
    return { ok: false, code: "provider_temporarily_unavailable", reason: `provider is temporarily unavailable (${lastReason || "recent failures"}) — paused, will retry automatically` };
  }
  // A network provider must be able to derive an origin: a BYO endpoint saved
  // without a base URL (or any malformed URL) is refused HERE, with the reason
  // that names the missing/invalid base URL, instead of passing the host check
  // with no pattern and dying at the run-time preflight as "origin is invalid"
  // (CAP-FB-20260829-PROVIDER-SET-NO-BASEURL-01).
  const endpoint = providerEndpointProblem(cfg);
  if (endpoint) return { ok: false, code: endpoint.code, reason: endpoint.reason };
  // A provider that NEEDS a model id must have one — either explicit or the
  // provider's catalogue default. An empty model with no catalogue would run
  // the demo model for a REAL provider id (the silent demo fallback), so the
  // gate refuses BEFORE the run and the hub shows the Settings remediation
  // bubble instead (CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01).
  const choice = PROVIDER_CHOICES?.find?.((p) => p.id === cfg?.provider) ?? null;
  const needsModel = choice?.needsModel !== false;
  if (needsModel) {
    const explicit = String(cfg?.model ?? "").trim();
    if (!explicit && !defaultModelFor(cfg?.provider)) {
      return { ok: false, code: "model id missing", reason: "model id missing — set it in Settings → Providers" };
    }
  }
  const hasHost = await hasProviderHostAccess(cfg);
  if (!hasHost) {
    const pattern = providerOriginPattern(cfg);
    return {
      ok: false,
      code: "permission_required",
      requestedScope: pattern ?? null,
      reason: `network access to the provider (${pattern ?? effectiveBaseURL(cfg) ?? "unknown"}) is not granted — click "Use"/"Test connection" in Settings to grant it`,
    };
  }
  return { ok: true, reason: "", code: "ready" };
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
