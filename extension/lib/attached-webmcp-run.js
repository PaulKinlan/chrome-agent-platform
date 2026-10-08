// Run-scoped, in-process binding for an owner-attached declared WebMCP document.
// This is not a worker, model descriptor grant, or invocation authority.
/**
 * @param {{attachments?: Array<{kind?: string, tabId?: number, documentId?: string}>,
 *  runId: string, threadId?: string | null,
 *  consentStore: {begin: (binding: {runId: string, threadId?: string | null, origin: string, tabId: number, documentId: string}) => object, end: (token: object) => boolean},
 *  attest: (tabId: number) => Promise<{origin: string, tabId: number, documentId: string, toolCount: number} | null>,
 *  allowOrigin: (origin: string) => boolean,
 *  runActive?: () => boolean}} options
 * @returns {Promise<{bindings: ReadonlyArray<{candidate: {origin: string, tabId: number, documentId: string, toolCount: number}, token: object}>, end: () => void}>}
 */
export async function bindAttachedWebmcpRun({
  attachments = [], runId, threadId = null, consentStore, attest, allowOrigin, runActive = () => true,
}) {
  if (!Array.isArray(attachments) || typeof attest !== "function" || typeof allowOrigin !== "function" ||
    typeof runActive !== "function" || !consentStore || typeof consentStore.begin !== "function" ||
    typeof consentStore.end !== "function") throw new Error("invalid attached WebMCP run binding");
  const bindings = [];
  const seen = new Set();
  const end = () => {
    for (const { token } of bindings.splice(0)) consentStore.end(token);
  };
  try {
    // Keep one owner's attachment from pinning the worker on unbounded
    // chrome.scripting calls. Other tabs stay ordinary conversation context.
    const tabs = attachments.filter((a) => a?.kind === "tab" && Number.isSafeInteger(a.tabId)).slice(0, 8);
    for (const attachment of tabs) {
      if (!runActive()) break;
      if (attachment?.kind !== "tab" || !Number.isSafeInteger(attachment.tabId) || attachment.tabId < 0 ||
        typeof attachment.documentId !== "string" || !attachment.documentId || attachment.documentId.length > 200) continue;
      let candidate = null;
      try { candidate = await attest(attachment.tabId); } catch { /* navigation or permission loss */ }
      if (!runActive()) break;
      if (!candidate || candidate.tabId !== attachment.tabId || candidate.documentId !== attachment.documentId ||
        !Number.isSafeInteger(candidate.toolCount) || candidate.toolCount < 1 ||
        seen.has(candidate.origin) || !allowOrigin(candidate.origin)) continue;
      const token = consentStore.begin({
        runId, threadId, origin: candidate.origin, tabId: candidate.tabId, documentId: candidate.documentId,
      });
      if (!runActive()) { consentStore.end(token); break; }
      seen.add(candidate.origin);
      bindings.push(Object.freeze({ candidate: Object.freeze({
        origin: candidate.origin, tabId: candidate.tabId,
        documentId: candidate.documentId, toolCount: candidate.toolCount,
      }), token }));
    }
    return Object.freeze({ bindings: Object.freeze(bindings.slice()), end });
  } catch (error) {
    end();
    throw error;
  }
}
