// Select declared WebMCP documents for a run without trusting attachment URLs.
// The caller must obtain attestedDocuments from Chrome's current top-level
// InjectionResult, never from a message or an attachment supplied by a page.
function webOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   attachments?: Array<{kind?: string, tabId?: number, documentId?: string}>,
 *   registry?: Array<{origin?: string, documents?: Array<{tabId?: number, documentId?: string, url?: string, toolCount?: number}>}>,
 *   attestedDocuments?: Array<{tabId?: number, documentId?: string, url?: string}>,
 *   enrolledOrigins?: string[],
 * }} options
 */
export function selectAttachedWebmcpOrigins({
  attachments = [], registry = [], attestedDocuments = [], enrolledOrigins = [],
} = {}) {
  if (![attachments, registry, attestedDocuments, enrolledOrigins].every(Array.isArray)) {
    return Object.freeze([]);
  }
  const enrolled = new Set(enrolledOrigins);
  const selected = [];
  const seen = new Set();
  for (const attachment of attachments) {
    if (attachment?.kind !== "tab" || !Number.isSafeInteger(attachment.tabId) || attachment.tabId < 0 ||
      typeof attachment.documentId !== "string" || !attachment.documentId || attachment.documentId.length > 200) continue;
    const live = attestedDocuments.find((document) =>
      document?.tabId === attachment.tabId && document.documentId === attachment.documentId
    );
    const origin = webOrigin(live?.url);
    if (!origin || enrolled.has(origin) || seen.has(origin)) continue;
    const entry = registry.find((row) => row?.origin === origin && Array.isArray(row.documents));
    const report = entry?.documents.find((document) =>
      document?.tabId === attachment.tabId && document.documentId === attachment.documentId &&
      webOrigin(document.url) === origin && Number.isSafeInteger(document.toolCount) && document.toolCount > 0
    );
    if (!report) continue;
    seen.add(origin);
    selected.push(Object.freeze({ origin, tabId: live.tabId, documentId: live.documentId, toolCount: report.toolCount }));
  }
  return Object.freeze(selected);
}
