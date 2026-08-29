// Persisted, bounded origin registry fed only by passive WebMCP detection.
import { kvGet, kvSet } from "./kv.js";

const KEY = "cap:knownWebmcpOrigins";
export const WEBMCP_REGISTRY_MAX = 100;
export const WEBMCP_REGISTRY_STALE_MS = 24 * 60 * 60 * 1000;
let queue = Promise.resolve();

function canonicalWebOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function pruneWebmcpRegistry(raw, now) {
  if (!Array.isArray(raw)) return [];
  const seenOrigins = new Set();
  const out = [];
  for (const item of raw) {
    const origin = canonicalWebOrigin(item?.origin);
    if (!origin || seenOrigins.has(origin) || !Array.isArray(item?.documents)) continue;
    const seenDocuments = new Set();
    const documents = [];
    for (const document of item.documents) {
      const tabId = Number(document?.tabId);
      const documentId = typeof document?.documentId === "string" ? document.documentId : "";
      const url = typeof document?.url === "string" ? document.url : "";
      const toolCount = Math.min(1000, Math.floor(Number(document?.toolCount)));
      const lastSeen = Number(document?.lastSeen);
      const key = `${tabId}\0${documentId}`;
      if (
        !Number.isInteger(tabId) || tabId < 0 || !documentId || seenDocuments.has(key) ||
        canonicalWebOrigin(url) !== origin || !Number.isFinite(lastSeen) ||
        now - lastSeen > WEBMCP_REGISTRY_STALE_MS || toolCount < 1
      ) continue;
      seenDocuments.add(key);
      documents.push({ tabId, documentId, url, toolCount, lastSeen });
    }
    documents.sort((a, b) => b.lastSeen - a.lastSeen);
    if (documents.length === 0) continue;
    seenOrigins.add(origin);
    out.push({ origin, lastSeen: documents[0].lastSeen, documents: documents.slice(0, WEBMCP_REGISTRY_MAX) });
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, WEBMCP_REGISTRY_MAX);
}

export function reportWebmcpDetection(origin, url, toolCount, identity, now = Date.now()) {
  return serial(async () => {
    const canonical = canonicalWebOrigin(origin);
    const tabId = Number(identity?.tabId);
    const documentId = typeof identity?.documentId === "string" ? identity.documentId : "";
    if (
      !canonical || canonicalWebOrigin(url) !== canonical ||
      !Number.isInteger(tabId) || tabId < 0 || !documentId
    ) throw new Error("invalid WebMCP detection identity");
    const stored = await kvGet(KEY);
    const entries = pruneWebmcpRegistry(stored[KEY], now);
    const existing = entries.find((entry) => entry.origin === canonical);
    const documents = (existing?.documents ?? []).filter((document) => document.tabId !== tabId);
    const count = Math.min(1000, Math.max(0, Math.floor(Number(toolCount) || 0)));
    if (count > 0) documents.unshift({ tabId, documentId, url, toolCount: count, lastSeen: now });
    const next = entries.filter((entry) => entry.origin !== canonical);
    if (documents.length > 0) next.unshift({ origin: canonical, lastSeen: documents[0].lastSeen, documents });
    await kvSet({ [KEY]: pruneWebmcpRegistry(next, now) });
    return { known: count > 0, origin: canonical, toolCount: count };
  });
}

export function listKnownWebmcpOrigins(now = Date.now()) {
  return serial(async () => {
    const stored = await kvGet(KEY);
    const raw = stored[KEY];
    const entries = pruneWebmcpRegistry(raw, now);
    if (JSON.stringify(raw ?? []) !== JSON.stringify(entries)) await kvSet({ [KEY]: entries });
    return entries;
  });
}
