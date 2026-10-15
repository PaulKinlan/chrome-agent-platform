// extension/lib/enclave-ledger.js — the request ledger and quota bounds for proxied enclave calls
// (chrome-agent-platform-vyhl, chrome-agent-platform-jao1.6).
//
// WHAT THIS IS:
// A persistent audit ledger and rate/quota controller for outbound proxied requests through the Secure Enclave.
// Designed with defense-in-depth:
// - strips query parameters and fragments from paths (never records query secrets)
// - strictly excludes request/response headers, bodies, or decrypted secret tokens
// - separates the quota counter (rollups) from the log ring buffer so log eviction cannot slip past limits
// - atomic reservation at grant time: increments counter inside checkQuota before returning grant
// - clock skew protection: backwards clock jumps cannot clear or extend quota (fail-closed)
// - fail-closed on storage read/write errors without permanently wedging the system
// - windowing semantics: fixed tumbling window (windowStartMs + windowMs)
// - bounded service rollups (max 50 services tracked)
// - newest-first list() projection
// - clear() and resetQuotas() support

/**
 * @typedef {{
 *   ok: boolean,
 *   code?: string|null,
 *   error?: string|null,
 *   remaining?: number,
 *   resetMs?: number,
 * }} QuotaCheckResult
 */

/**
 * Default service quotas grounded in upstream provider free tiers:
 * - brave-search: 50 calls / 24 hours (Brave Free plan: 2,000 queries / month ~ 66/day)
 * - github: 100 calls / 1 hour (GitHub authenticated API: 5,000 calls / hour; conservative token guard)
 */
export const DEFAULT_ENCLAVE_QUOTAS = Object.freeze({
  "brave-search": Object.freeze({ limit: 50, windowMs: 24 * 60 * 60 * 1000 }), // 50/day
  "github": Object.freeze({ limit: 100, windowMs: 60 * 60 * 1000 }),            // 100/hour
});

export const ENCLAVE_LEDGER_STORAGE_KEY = "cap:enclave:ledger";
export const MAX_TRACKED_SERVICES = 50;

/**
 * @param {{
 *   maxEntries?: number,
 *   storageArea?: any,
 *   storageKey?: string,
 *   quotas?: Record<string, { limit: number, windowMs: number }>,
 * }} [opts]
 */
export function createEnclaveLedger({
  maxEntries = 100,
  storageArea = null,
  storageKey = ENCLAVE_LEDGER_STORAGE_KEY,
  quotas = DEFAULT_ENCLAVE_QUOTAS,
} = {}) {
  /** @type {Array<Readonly<{ service: string, keyId: string, method: string, origin: string, path: string, status: number|null, ok: boolean, code: string|null, ms: number, timestamp: number }>>} */
  const entries = [];

  /** @type {Record<string, { windowStartMs: number, count: number, lastUpdatedMs: number }>} */
  const rollups = {};

  let storageLoaded = false;
  let lastWriteError = null;

  function pruneRollupsIfNeeded() {
    const keys = Object.keys(rollups);
    if (keys.length <= MAX_TRACKED_SERVICES) return;
    keys.sort((a, b) => (rollups[a].lastUpdatedMs || 0) - (rollups[b].lastUpdatedMs || 0));
    while (keys.length > MAX_TRACKED_SERVICES) {
      const oldest = keys.shift();
      delete rollups[oldest];
    }
  }

  async function loadFromStorage() {
    if (!storageArea || typeof storageArea.get !== "function") return;
    try {
      const data = await storageArea.get(storageKey);
      const saved = data?.[storageKey];
      if (saved && typeof saved === "object") {
        if (Array.isArray(saved.entries)) {
          entries.length = 0;
          for (const e of saved.entries) entries.push(Object.freeze({ ...e }));
        }
        if (saved.rollups && typeof saved.rollups === "object") {
          for (const [k, v] of Object.entries(saved.rollups)) {
            if (v && typeof v === "object") {
              const local = rollups[k];
              const storedStart = Number(v.windowStartMs) || 0;
              const storedCount = Number(v.count) || 0;
              const storedLast = Number(v.lastUpdatedMs) || 0;
              if (!local) {
                rollups[k] = { windowStartMs: storedStart, count: storedCount, lastUpdatedMs: storedLast };
              } else if (storedStart > local.windowStartMs) {
                rollups[k] = { windowStartMs: storedStart, count: storedCount, lastUpdatedMs: storedLast };
              } else if (storedStart === local.windowStartMs) {
                // Same window: adopt monotonic upper bound
                local.count = Math.max(local.count, storedCount);
                local.lastUpdatedMs = Math.max(local.lastUpdatedMs, storedLast);
              }
            }
          }
        }
      }
      storageLoaded = true;
    } catch (err) {
      storageLoaded = false;
      throw err;
    }
  }

  async function persistToStorage() {
    if (!storageArea || typeof storageArea.set !== "function") return;
    try {
      await storageArea.set({
        [storageKey]: {
          entries: [...entries],
          rollups: { ...rollups },
          updatedAt: Date.now(),
        },
      });
      lastWriteError = null;
    } catch (err) {
      lastWriteError = err;
      throw err;
    }
  }

  return Object.freeze({
    /**
     * Records an audit ledger entry.
     * Note: Does NOT increment quota count by default because quota is atomically
     * reserved at checkQuota grant time (P1-1). Set countUsage: true only if calling
     * standalone without prior checkQuota reservation.
     *
     * @param {{
     *   service?: string,
     *   keyId?: string,
     *   method?: string,
     *   origin?: string,
     *   path?: string,
     *   url?: string,
     *   status?: number|null,
     *   ok?: boolean,
     *   code?: string|null,
     *   ms?: number,
     *   timestamp?: number,
     *   countUsage?: boolean,
     * }} [entry]
     */
    async record({
      service = "",
      keyId = "",
      method = "GET",
      origin = "",
      path = "",
      url = "",
      status = null,
      ok = true,
      code = null,
      ms = 0,
      timestamp = Date.now(),
      countUsage = false,
    } = {}) {
      if (!storageLoaded && storageArea) {
        try {
          await loadFromStorage();
        } catch { /* best-effort load on record */ }
      }

      // Strip query parameters and hash fragments from path/url
      let cleanPath = String(path || url || "");
      let derivedOrigin = String(origin ?? "");

      // If a full absolute URL was supplied, separate origin and pathname
      if (cleanPath.startsWith("http://") || cleanPath.startsWith("https://")) {
        try {
          const parsed = new URL(cleanPath);
          if (!derivedOrigin) derivedOrigin = parsed.origin;
          cleanPath = parsed.pathname;
        } catch {
          const cut = cleanPath.search(/[?#]/);
          if (cut !== -1) cleanPath = cleanPath.slice(0, cut);
        }
      } else {
        const cut = cleanPath.search(/[?#]/);
        if (cut !== -1) cleanPath = cleanPath.slice(0, cut);
      }

      const serviceId = String(service ?? "");
      const ts = Number.isFinite(timestamp) ? Number(timestamp) : Date.now();

      const entry = Object.freeze({
        service: serviceId,
        keyId: String(keyId ?? ""),
        method: String(method ?? "GET").toUpperCase(),
        origin: derivedOrigin,
        path: cleanPath,
        status: typeof status === "number" ? status : null,
        ok: Boolean(ok),
        code: code ? String(code) : null,
        ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0,
        timestamp: ts,
      });

      // 1. Unshift into visible log ring buffer
      entries.unshift(entry);
      while (entries.length > maxEntries) {
        entries.pop();
      }

      // 2. Optional standalone counter increment (default false)
      if (serviceId && countUsage === true) {
        const quota = quotas[serviceId] ?? DEFAULT_ENCLAVE_QUOTAS[serviceId];
        const windowMs = quota?.windowMs ?? 24 * 60 * 60 * 1000;

        if (!rollups[serviceId] || ts - rollups[serviceId].windowStartMs >= windowMs) {
          rollups[serviceId] = {
            windowStartMs: ts,
            count: 1,
            lastUpdatedMs: ts,
          };
        } else {
          rollups[serviceId].count += 1;
          rollups[serviceId].lastUpdatedMs = Math.max(rollups[serviceId].lastUpdatedMs, ts);
        }
        pruneRollupsIfNeeded();
      }

      // 3. Persist asynchronously
      try {
        await persistToStorage();
      } catch {
        // Log persistence failure does not crash in-memory record
      }

      return entry;
    },

    /**
     * Atomically checks and reserves quota for an outbound proxied service call.
     * Increments the service rollup count immediately upon grant before returning (P1-1).
     * If storageArea is provided and writes fail, rolls back reservation and refuses (P1-2).
     *
     * @param {string} serviceId
     * @param {{ now?: number, customQuotas?: Record<string, { limit: number, windowMs: number }> }} [options]
     * @returns {Promise<QuotaCheckResult>}
     */
    async checkQuota(serviceId, { now = Date.now(), customQuotas = null } = {}) {
      if (storageArea && !storageLoaded) {
        try {
          await loadFromStorage();
        } catch (err) {
          return Object.freeze({
            ok: false,
            code: "ledger_unavailable",
            error: `secure enclave ledger storage is unavailable (${String(err?.message ?? err)})`,
          });
        }
      }

      const effectiveQuotas = customQuotas || quotas || DEFAULT_ENCLAVE_QUOTAS;
      const quota = effectiveQuotas[serviceId] ?? DEFAULT_ENCLAVE_QUOTAS[serviceId];
      if (!quota || !Number.isFinite(quota.limit) || quota.limit <= 0) {
        return Object.freeze({ ok: true });
      }

      const windowMs = Number(quota.windowMs) || 24 * 60 * 60 * 1000;
      let rollup = rollups[serviceId];

      if (!rollup) {
        rollup = { windowStartMs: now, count: 0, lastUpdatedMs: now };
        rollups[serviceId] = rollup;
        pruneRollupsIfNeeded();
      }

      // Clock skew check: backwards clock jumps must NOT reset or grant quota
      if (Number.isFinite(rollup.lastUpdatedMs) && now < rollup.lastUpdatedMs) {
        return Object.freeze({
          ok: false,
          code: "clock_skew",
          error: "clock skew detected (system clock moved backwards); refusing proxied request",
        });
      }

      // Fixed tumbling window: reset on boundary elapse
      if (now - rollup.windowStartMs >= windowMs) {
        rollup.windowStartMs = now;
        rollup.count = 0;
        rollup.lastUpdatedMs = now;
      }

      // Quota limit enforcement
      if (rollup.count >= quota.limit) {
        const resetMs = Math.max(0, (rollup.windowStartMs + windowMs) - now);
        return Object.freeze({
          ok: false,
          code: "quota_exceeded",
          error: `quota exceeded for service "${serviceId}" (${rollup.count}/${quota.limit} calls in window)`,
          remaining: 0,
          resetMs,
        });
      }

      // ATOMIC RESERVATION AT GRANT TIME (P1-1):
      // Increment counter immediately upon grant!
      rollup.count += 1;
      rollup.lastUpdatedMs = now;

      // Fail-closed storage write enforcement (P1-2):
      // If storage is configured and writes fail, rollback reservation and refuse!
      if (storageArea) {
        try {
          await persistToStorage();
        } catch (err) {
          rollup.count -= 1; // rollback reservation
          return Object.freeze({
            ok: false,
            code: "ledger_unavailable",
            error: `secure enclave ledger storage is unavailable (${String(err?.message ?? err)})`,
          });
        }
      }

      const resetMs = Math.max(0, (rollup.windowStartMs + windowMs) - now);
      return Object.freeze({
        ok: true,
        remaining: Math.max(0, quota.limit - rollup.count),
        resetMs,
      });
    },

    list() {
      return Object.freeze([...entries]);
    },

    /**
     * @returns {Record<string, { windowStartMs: number, count: number, lastUpdatedMs: number }>}
     */
    getRollups() {
      const copy = {};
      for (const [k, v] of Object.entries(rollups)) {
        copy[k] = Object.freeze({ ...v });
      }
      return Object.freeze(copy);
    },

    async clear() {
      entries.length = 0;
      await persistToStorage();
    },

    async resetQuotas(serviceId = null) {
      if (serviceId) {
        delete rollups[serviceId];
      } else {
        for (const k of Object.keys(rollups)) delete rollups[k];
      }
      await persistToStorage();
    },

    async sync() {
      await loadFromStorage();
      await persistToStorage();
    },

    get size() {
      return entries.length;
    },
  });
}
