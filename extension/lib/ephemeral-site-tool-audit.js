// A distinct audit principal for an attached, unenrolled, declared WebMCP
// document. This never relaxes the enrolled appendRequiredSiteToolAudit gate.
// Instantiate only in the service worker with a browser attestor and its WAL.
import { canonicalOrigin } from "./memory.js";

function unavailable() {
  const error = new Error("site_tool_audit_unavailable");
  error.code = "site_tool_audit_unavailable";
  throw error;
}

/**
 * @param {{
 *   consentStore: {binding: (token: object) => {origin: string, tabId: number, documentId: string, runId: string}},
 *   attest: (tabId: number) => Promise<{tabId: number, documentId: string, origin: string} | null>,
 *   runActive: (runId: string) => boolean,
 *   append: (record: object) => Promise<object>,
 *   profileEpoch: () => number,
 *   resetting: () => boolean,
 * }} dependencies
 */
export function createEphemeralSiteToolAuditPrincipal({ consentStore, attest, runActive, append, profileEpoch, resetting }) {
  if (!consentStore || typeof consentStore.binding !== "function" || typeof attest !== "function" ||
    typeof runActive !== "function" || typeof append !== "function" ||
    typeof profileEpoch !== "function" || typeof resetting !== "function") unavailable();

  return Object.freeze({
    async append(token, row) {
      const epoch = profileEpoch();
      let binding;
      try { binding = consentStore.binding(token); } catch { unavailable(); }
      if (resetting() || !runActive(binding.runId) ||
        row?.ephemeral !== true || row?.enrollmentGen !== 0 || row?.source !== "declared" ||
        row?.origin !== binding.origin || row?.runId !== binding.runId ||
        row?.documentId !== binding.documentId || !row?.tool) unavailable();
      const current = await attest(binding.tabId).catch(() => null);
      let attestedOrigin = null;
      try { attestedOrigin = canonicalOrigin(current?.origin); } catch { /* malformed browser result fails closed */ }
      if (!current || current.tabId !== binding.tabId || current.documentId !== binding.documentId ||
        attestedOrigin !== binding.origin ||
        resetting() || profileEpoch() !== epoch || !runActive(binding.runId)) unavailable();
      // A run may end while Chrome reattests. The opaque token must still be
      // live before queuing the WAL; an MV3 restart loses the token entirely.
      try {
        const latest = consentStore.binding(token);
        if (latest !== binding && (
          latest.runId !== binding.runId || latest.documentId !== binding.documentId ||
          latest.tabId !== binding.tabId || latest.origin !== binding.origin
        )) unavailable();
      } catch { unavailable(); }
      if (resetting() || profileEpoch() !== epoch) unavailable();
      // Append is awaited before any site side effect; a reset's exclusive WAL
      // barrier runs AFTER any append already queued and prevents resurrection.
      try { return await append(row); } catch { unavailable(); }
    },
  });
}
