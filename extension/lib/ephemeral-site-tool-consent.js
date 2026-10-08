// In-process Q23 decisions for a browser-attested, unenrolled attached document.
// No siteMemory call, OPFS origin directory, or Site Agent is created here.
// Only the service worker may hold a minted token; attachment text is not one.
import { canonicalOrigin } from "./memory.js";
import { siteToolIdentity } from "./site-tool-consent.js";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

/** @param {string} value */
function boundedId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/** Each store is owned by one service-worker process, not durable across restart. */
export function createEphemeralSiteToolConsentStore() {
  const entries = new Map();
  const bindings = new Set();
  const promoting = new Set();

  function live(token) {
    const entry = entries.get(token);
    if (!entry || entry.ended) fail("ephemeral_site_tool_run_not_live");
    return entry;
  }

  function identityFor(entry, tool) {
    const identity = siteToolIdentity(entry.origin, tool);
    if (identity.source !== "declared") fail("ephemeral_site_tool_not_declared");
    return identity;
  }

  function current(entry, identity) {
    const record = entry.records.get(identity.name);
    return Object.freeze({
      ...identity,
      runId: entry.runId,
      threadId: entry.threadId,
      tabId: entry.tabId,
      documentId: entry.documentId,
      state: record?.state === "denied" ? "denied" :
        record?.state === "allowed" && record.identityDigest === identity.identityDigest ? "allowed" : "ask",
      revision: entry.revision,
      recordRevision: record?.revision ?? 0,
    });
  }

  return Object.freeze({
    /** The caller must pass the current top-level document attested by Chrome.
     * @param {{runId: string, threadId?: string | null, origin: string, tabId: number, documentId: string}} binding
     */
    begin({ runId, threadId = null, origin, tabId, documentId }) {
      const canonical = typeof origin === "string" ? canonicalOrigin(origin) : null;
      if (!boundedId(runId) || (threadId !== null && !boundedId(threadId)) || !canonical ||
        !Number.isSafeInteger(tabId) || tabId < 0 || !boundedId(documentId)) {
        fail("ephemeral_site_tool_binding_invalid");
      }
      if (promoting.has(canonical)) fail("ephemeral_site_tool_promotion_pending");
      const key = JSON.stringify([runId, canonical, tabId, documentId]);
      if (bindings.has(key)) fail("ephemeral_site_tool_binding_duplicate");
      // Opaque object identity, not a caller-provided string, is the capability.
      const token = Object.freeze({});
      bindings.add(key);
      entries.set(token, { key, runId, threadId, origin: canonical, tabId, documentId, records: new Map(), revision: 0, ended: false, promoting: false });
      return token;
    },

    binding(token) {
      const entry = live(token);
      return Object.freeze({
        origin: entry.origin,
        tabId: entry.tabId,
        documentId: entry.documentId,
        runId: entry.runId,
        threadId: entry.threadId,
      });
    },

    snapshot(token, tool) {
      const entry = live(token);
      return current(entry, identityFor(entry, tool));
    },

    decide(token, tool, state, { expected = null } = {}) {
      const entry = live(token);
      if (entry.promoting) fail("ephemeral_site_tool_promotion_pending");
      if (state !== "ask" && state !== "allowed" && state !== "denied") {
        fail("ephemeral_site_tool_consent_state");
      }
      const identity = identityFor(entry, tool);
      const before = current(entry, identity);
      if (expected && (
        expected.origin !== before.origin || expected.name !== before.name ||
        expected.identityDigest !== before.identityDigest || expected.runId !== before.runId ||
        expected.documentId !== before.documentId || expected.revision !== before.revision ||
        expected.state !== before.state
      )) fail("ephemeral_site_tool_consent_changed");
      // Deny cannot be undone by a fresh descriptor or a later model call.
      if (before.state === "denied" && state !== "denied") fail("ephemeral_site_tool_consent_denied");
      const revision = entry.revision + 1;
      if (!Number.isSafeInteger(revision)) fail("ephemeral_site_tool_revision");
      entry.revision = revision;
      if (state === "ask") entry.records.delete(identity.name);
      else entry.records.set(identity.name, Object.freeze({ ...identity, state, revision }));
      return current(entry, identity);
    },

    end(token) {
      const entry = entries.get(token);
      if (!entry) return false;
      entry.ended = true;
      entries.delete(token);
      bindings.delete(entry.key);
      entry.records.clear();
      return true;
    },

    /** Lock all live run decisions for one origin until one trusted persistence
     * callback atomically writes the enrolled envelope or fails. Never give
     * callback access to the opaque tokens. A failed callback keeps decisions
     * for retry; completed migration consumes them exactly once.
     * @param {string} origin
     * @param {(records: Array<{name: string, source: string, identityDigest: string, state: string}>, isCurrent: () => boolean) => Promise<unknown>} persist
     */
    async withPromotionForOrigin(origin, persist) {
      const canonical = typeof origin === "string" ? canonicalOrigin(origin) : null;
      if (!canonical || typeof persist !== "function" || promoting.has(canonical)) {
        fail("ephemeral_site_tool_promotion_invalid");
      }
      const candidates = [...entries.entries()].filter(([, entry]) => entry.origin === canonical && !entry.ended);
      if (!candidates.length) return null;
      promoting.add(canonical);
      for (const [, entry] of candidates) entry.promoting = true;
      const isCurrent = () => candidates.every(([token, entry]) => entries.get(token) === entry && !entry.ended);
      try {
        const byName = new Map();
        for (const [, entry] of candidates) {
          for (const record of entry.records.values()) {
            const prior = byName.get(record.name);
            if (prior?.state !== "denied" && (record.state === "denied" || !prior)) {
              byName.set(record.name, Object.freeze({
                name: record.name, source: record.source,
                identityDigest: record.identityDigest, state: record.state,
              }));
            }
          }
        }
        const records = Object.freeze([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)));
        if (!isCurrent()) fail("ephemeral_site_tool_run_not_live");
        const result = await persist(records, isCurrent);
        if (!isCurrent()) fail("ephemeral_site_tool_run_not_live");
        for (const [token, entry] of candidates) {
          entry.ended = true;
          entries.delete(token);
          bindings.delete(entry.key);
          entry.records.clear();
        }
        return result;
      } finally {
        for (const [, entry] of candidates) entry.promoting = false;
        promoting.delete(canonical);
      }
    },
  });
}
