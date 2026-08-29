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

import { normalizeHostPattern, requestPermissionBundleFromGesture } from "./permission-orchestration.js";
import { safeProviderError } from "./pure.js";

/** Derive the exact host-permission origin pattern for a provider base URL.
 * Returns null for missing, malformed, credential-bearing, or non-http(s) URLs. */
export function providerOriginPattern(cfg) {
  try {
    const u = new URL(cfg?.baseURL ?? "");
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
// ── permission-request coordination THROUGH THE SW (the final review's HIGH)
// ────────────────────────────────────────────────────────────────────────────
// The in-flight registry lives in the SERVICE WORKER (lib/perm-lease.js via
// the perm-lease.* routes) so every extension page — Settings + each
// conversation surface — shares ONE slot per origin pattern: two pages can
// never launch duplicate prompts. The PAGE still performs
// chrome.permissions.request during ITS OWN user gesture (gesture context
// cannot cross into the SW), then settles the lease; a page that cannot get
// the lease waits for the settle broadcast (bounded) instead of prompting.
const LEASE_TIMEOUT_MS = 8_000;

function _swSend(message) {
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    return Promise.resolve(chrome.runtime.sendMessage(message)).catch((e) => ({ __sendError: String(e?.message ?? e) }));
  }
  return Promise.resolve({ __sendError: "no runtime" });
}

export async function requestProviderHostAccess(cfg, { onIssued = null } = {}) {
  const pattern = providerOriginPattern(cfg);
  if (!pattern) return { granted: true, pattern: null, error: null, generation: null };
  if (typeof chrome === "undefined" || !chrome.permissions?.contains) {
    return { granted: true, pattern, error: null, generation: null };
  }
  // 1. Acquire the single in-flight slot from the SW authority.
  const acquired = await _swSend({ type: "perm-lease.acquire", pattern });
  if (!acquired || acquired.__sendError) {
    // No SW coordination available (unit tests / non-extension): bounded
    // direct request, no dedupe possible; no generation exists to bind.
    const r = await _directBoundedRequest(pattern);
    return { ...r, generation: null };
  }
  if (!acquired.lease) {
    // Someone else's request is in flight. If it already timed out, deny
    // honestly NOW (never a duplicate prompt); otherwise wait (bounded) for
    // the settle broadcast, then report the RECONCILED outcome. The consumer
    // is bound to the OBSERVED in-flight generation (exact match in the
    // waiter), never a guess.
    if (onIssued) { try { onIssued({ pattern, generation: acquired.generation, ours: false }); } catch { /* consumer error */ } }
    if (acquired.timedOut) {
      return { granted: false, pattern, error: "permission request timed out (another surface's request is still pending)", generation: acquired.generation };
    }
    const r = await _awaitSettle(pattern, acquired.generation);
    return { ...r, generation: acquired.generation };
  }
  // 2. We hold the lease: OUR generation was issued atomically WITH the
  // acquisition — the onIssued callback (this caller's own subscription) is
  // invoked before any await can interleave, so a consumer registered this
  // way can never observe a stale or newer settlement.
  if (onIssued) { try { onIssued({ pattern, generation: acquired.generation, ours: true }); } catch { /* consumer error */ } }
  try {
    // requestPermissionBundleFromGesture performs no asynchronous work before
    // chrome.permissions.request. Callers must invoke this directly from the
    // owner click (never after provider.get/contains awaits). The provider's
    // perm-lease settle is preserved (generation/token) around the orchestrated
    // request.
    const granted = await requestPermissionBundleFromGesture({ origins: [pattern] });
    await _swSend({ type: "perm-lease.settle", pattern, generation: acquired.generation, token: acquired.token, granted: Boolean(granted) });
    return { granted: Boolean(granted), pattern, error: granted ? null : "permission request denied", generation: acquired.generation };
  } catch (e) {
    await _swSend({ type: "perm-lease.settle", pattern, generation: acquired.generation, token: acquired.token, granted: false, error: String(e?.message ?? e) });
    return { granted: false, pattern, error: safeProviderError(String(e?.message ?? e)), generation: acquired.generation };
  }
}

/** Wait (bounded) for another surface's in-flight request to settle, then
 *  report the reconciled outcome from the SW state. */
async function _awaitSettle(pattern, generation) {
  return await new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = async () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (typeof chrome !== "undefined") chrome.runtime.onMessage.removeListener(onSettled);
      const state = await _swSend({ type: "perm-lease.state", pattern });
      resolve({
        granted: state?.lastOutcome === "granted",
        pattern,
        error: state?.inFlight
          ? "permission request timed out (another surface's request was pending)"
          : (state?.lastOutcome === "granted" ? null : "permission request denied on another surface"),
      });
    };
    const onSettled = (msg) => {
      // EXACT-match consumer (the acceptance review): only the broadcast for
      // the EXACT expected pattern + generation resolves this wait — a
      // missing, older, OR newer generation is dropped.
      if (msg?.type === "provider-host-perm:settled" && msg.pattern === pattern &&
          msg.generation === generation) {
        finish();
      }
    };
    try { chrome.runtime.onMessage.addListener(onSettled); } catch { /* non-extension */ }
    timer = setTimeout(finish, LEASE_TIMEOUT_MS + 500);
  });
}

/** Fallback (no SW): a bounded install-grant VERIFICATION (no runtime request
 * exists — host access is granted at install via <all_urls>). */
async function _directBoundedRequest(pattern) {
  try {
    const outcome = await Promise.race([
      chrome.permissions.contains({ origins: [pattern] }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), LEASE_TIMEOUT_MS)),
    ]);
    if (outcome === "timeout") return { granted: false, pattern, error: "grant verification timed out" };
    return { granted: outcome === true, pattern, error: outcome === true ? null : "install grant not verified" };
  } catch (e) {
    return { granted: false, pattern, error: safeProviderError(String(e?.message ?? e)) };
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
  const hasHost = await hasProviderHostAccess(cfg);
  if (!hasHost) {
    const pattern = providerOriginPattern(cfg);
    return {
      ok: false,
      code: "permission_required",
      requestedScope: pattern ?? null,
      reason: `network access to the provider (${pattern ?? cfg?.baseURL ?? "unknown"}) is not granted — click "Use"/"Test connection" in Settings to grant it`,
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
