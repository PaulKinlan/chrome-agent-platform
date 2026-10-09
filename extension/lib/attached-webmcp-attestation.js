// Browser-owned document attestation for an owner-picked attached tab. This
// yields a count-only candidate; it is never an invocation or disclosure grant.
import { selectAttachedWebmcpOrigins } from "./attached-webmcp-origins.js";

/**
 * @param {number} tabId
 * @param {{getTab: (tabId: number) => Promise<{id?: number, url?: string} | null>,
 *  executeTopFrame: (tabId: number) => Promise<Array<{frameId?: number, documentId?: string}>>,
 *  registry: Array<{origin: string, documents: Array<object>}>, enrolledOrigins?: string[],
 *  attachment?: unknown}} dependencies
 * @returns {Promise<{origin: string, tabId: number, documentId: string, toolCount: number} | null>}
 */
export async function attestCurrentAttachedWebmcpTab(tabId, {
  getTab, executeTopFrame, registry, enrolledOrigins = [],
} = {}) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof getTab !== "function" ||
    typeof executeTopFrame !== "function" || !Array.isArray(registry) || !Array.isArray(enrolledOrigins)) return null;
  try {
    const before = await getTab(tabId);
    if (before?.id !== tabId || typeof before.url !== "string") return null;
    const results = await executeTopFrame(tabId);
    // The injection result is Chrome-owned and restricted to the top frame;
    // never substitute an attachment's URL/documentId or a page-sent field.
    const live = Array.isArray(results) && results.length === 1 && results[0]?.frameId === 0
      ? results[0] : null;
    if (typeof live?.documentId !== "string" || !live.documentId) return null;
    const after = await getTab(tabId);
    if (after?.id !== tabId || typeof after.url !== "string") return null;
    const [candidate] = selectAttachedWebmcpOrigins({
      attachments: [{ kind: "tab", tabId, documentId: live.documentId }],
      registry,
      attestedDocuments: [{ tabId, documentId: live.documentId, url: after.url }],
      enrolledOrigins,
    });
    return candidate ?? null;
  } catch {
    return null; // Chrome navigation, permission revocation, or probe failure.
  }
}
