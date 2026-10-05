// extension/lib/enclave-ledger.js — the in-memory request ledger for proxied enclave calls
// (chrome-agent-platform-vyhl).
//
// WHAT THIS IS:
// A bounded ring buffer recording outbound proxied requests through the Secure Enclave.
// Designed with defense-in-depth:
// - strips query parameters from paths (never records query secrets)
// - never stores headers, bodies, or decrypted secret tokens
// - newest-first list() projection
// - clear() support

/**
 * @param {{ maxEntries?: number }} [opts]
 */
export function createEnclaveLedger({ maxEntries = 100 } = {}) {
  /** @type {Array<Readonly<{ service: string, keyId: string, method: string, origin: string, path: string, status: number|null, ok: boolean, code: string|null, ms: number, timestamp: number }>>} */
  const entries = [];

  return Object.freeze({
    /**
     * @param {{
     *   service?: string,
     *   keyId?: string,
     *   method?: string,
     *   origin?: string,
     *   path?: string,
     *   status?: number|null,
     *   ok?: boolean,
     *   code?: string|null,
     *   ms?: number,
     *   timestamp?: number
     * }} [entry]
     */
    record({
      service = "",
      keyId = "",
      method = "GET",
      origin = "",
      path = "",
      status = null,
      ok = true,
      code = null,
      ms = 0,
      timestamp = Date.now(),
    } = {}) {
      // Strip any query strings from path
      let cleanPath = String(path ?? "");
      const qIndex = cleanPath.indexOf("?");
      if (qIndex !== -1) {
        cleanPath = cleanPath.slice(0, qIndex);
      }

      const entry = Object.freeze({
        service: String(service ?? ""),
        keyId: String(keyId ?? ""),
        method: String(method ?? "GET").toUpperCase(),
        origin: String(origin ?? ""),
        path: cleanPath,
        status: typeof status === "number" ? status : null,
        ok: Boolean(ok),
        code: code ? String(code) : null,
        ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0,
        timestamp: Number.isFinite(timestamp) ? Number(timestamp) : Date.now(),
      });

      entries.unshift(entry); // newest first
      while (entries.length > maxEntries) {
        entries.pop();
      }
      return entry;
    },

    list() {
      return Object.freeze([...entries]);
    },

    clear() {
      entries.length = 0;
    },

    get size() {
      return entries.length;
    },
  });
}
