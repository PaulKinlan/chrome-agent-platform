// lib/perm-lease.js — the SINGLE-AUTHORITY permission-request lease registry
// (the final review's HIGH): lives in the SERVICE WORKER so every extension
// page coordinates through ONE map — two pages can never launch duplicate
// origin-permission prompts.
//
// Semantics (the acceptance round):
//   - PATTERNS are strictly canonicalized (URL parse → lowercase scheme+host,
//     explicit port kept; the path must be exactly "/*") into a BOUNDED map.
//   - Capacity is BACKPRESSURE, never eviction: at capacity, a new acquire is
//     REJECTED ("busy") — an ACTIVE lease is never dropped, so churn can
//     never enable duplicate prompts.
//   - A timed-out lease EXPIRES (dropped) — recoverable: a crashed page
//     cannot block an origin; the next acquire starts fresh.
//   - Settling requires the UNGUESSABLE OWNER TOKEN + exact generation while
//     in flight; settled entries are deleted.
//   - GENERATIONS survive settle/expiry AND worker restarts via a bounded
//     persisted high-water map (chrome.storage.session when available), so a
//     generation is never reused even after churn or an MV3 restart.
//   - Consumers must match the EXACT expected pattern+generation.

const MAX_LEASE_MS = 8_000;
const MAX_ENTRIES = 64;   // bounded ACTIVE-lease slots (backpressure beyond)
const MAX_MEMO = 64;     // bounded last-outcome memo

const _leases = new Map(); // pattern -> { generation, token, inFlight, expiresAt, timer }
const _memo = new Map();   // pattern -> { lastOutcome, lastGrantedAt }

// A cryptographically unique OPAQUE generation per request: boot UUID + a
// random UUID (the successor review's HIGH). Uniqueness is by construction —
// no counter can be reused across restarts or churn, and nothing is
// persisted. Consumers compare for EXACT equality against the generation the
// waiter/consumer was issued (also opaque).
// Cryptographically random ONLY — no Date/Math fallback: crypto.randomUUID
// must exist (Chrome 92+, and the module runs in the extension SW). Absent
// crypto is a broken environment: FAIL CLOSED rather than mint predictable ids.
function _cryptoUUID() {
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("crypto.randomUUID unavailable — refusing to mint permission-request ids (fail closed)");
  }
  return globalThis.crypto.randomUUID();
}
const BOOT_ID = _cryptoUUID();
function newGeneration() {
  return `${BOOT_ID}:${_cryptoUUID()}`;
}

/** Strict canonicalization: parse as a URL, require http/https, host present
 *  (a valid registered name or IP, optional explicit port), path exactly "/*".
 *  Returns the canonical pattern or null. */
export function canonicalPattern(pattern) {
  let u;
  try { u = new URL(String(pattern ?? "").trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== "/*") return null;
  return `${u.protocol}//${u.host.toLowerCase()}/*`;
}

/** Try to acquire the single in-flight request slot for a pattern.
 *  Returns { lease:true, generation, token } | { lease:false, reason }. */
export function acquireLease(pattern, now = Date.now()) {
  const key = canonicalPattern(pattern);
  if (!key) return { lease: false, reason: "invalid pattern" };
  const entry = _leases.get(key);
  if (entry && entry.inFlight) {
    return { lease: false, generation: entry.generation, reason: entry.expiresAt <= now ? "expired-pending-reap" : "in-flight" };
  }
  // BACKPRESSURE: at capacity, REJECT — an active lease is never evicted.
  if (_leases.size >= MAX_ENTRIES) {
    return { lease: false, reason: "busy" };
  }
  // The generation is a FRESH cryptographically unique opaque id (never a
  // reused counter) and the token a separate unguessable owner secret.
  const generation = newGeneration();
  const token = _cryptoUUID();
  const fresh = { generation, token, inFlight: true, expiresAt: now + MAX_LEASE_MS, timer: null };
  fresh.timer = setTimeout(() => {
    // EXPIRY (recoverable): the lease is DROPPED; the origin can never be
    // blocked by a crashed page. The next acquire issues a NEW unique id.
    _leases.delete(key);
  }, MAX_LEASE_MS);
  _leases.set(key, fresh);
  return { lease: true, generation, token, pattern: key };
}

/** Settle: requires the exact owner token + generation while in flight;
 *  deletes the entry (no replay). */
export function settleLease(pattern, { generation, token, granted, error = null } = {}, now = Date.now()) {
  const key = canonicalPattern(pattern);
  if (!key) return { ok: false, stale: true, reason: "invalid pattern" };
  const entry = _leases.get(key);
  if (!entry || !entry.inFlight) return { ok: false, stale: true, reason: "no in-flight lease" };
  if (entry.generation !== generation || entry.token !== token) {
    return { ok: false, stale: true, reason: "not the lease owner" };
  }
  if (entry.timer) clearTimeout(entry.timer);
  _leases.delete(key);
  _memo.set(key, { lastOutcome: granted ? "granted" : "denied", lastGrantedAt: granted ? now : null });
  while (_memo.size > MAX_MEMO) _memo.delete(_memo.keys().next().value);
  return {
    ok: true,
    stale: false,
    broadcast: { type: "provider-host-perm:settled", pattern: key, generation, granted: Boolean(granted) },
  };
}

/** The current state of a pattern (in-flight info + the last settled outcome). */
export function leaseState(pattern) {
  const key = canonicalPattern(pattern);
  if (!key) return { invalid: true };
  const entry = _leases.get(key);
  const memo = _memo.get(key) ?? null;
  if (!entry) return { inFlight: false, lastOutcome: memo?.lastOutcome ?? null };
  return { inFlight: entry.inFlight, generation: entry.generation, expiresAt: entry.expiresAt, lastOutcome: memo?.lastOutcome ?? null };
}
