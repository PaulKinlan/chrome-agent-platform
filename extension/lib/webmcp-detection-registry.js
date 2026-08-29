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
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const origin = canonicalWebOrigin(item?.origin);
    const lastSeen = Number(item?.lastSeen);
    const toolCount = Math.min(1000, Math.floor(Number(item?.toolCount)));
    if (!origin || seen.has(origin) || !Number.isFinite(lastSeen) || now - lastSeen > WEBMCP_REGISTRY_STALE_MS || toolCount < 1) continue;
    seen.add(origin);
    out.push({ origin, toolCount, lastSeen });
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen).slice(0, WEBMCP_REGISTRY_MAX);
}

export function reportWebmcpDetection(origin, url, toolCount, now = Date.now()) {
  return serial(async () => {
    const canonical = canonicalWebOrigin(origin);
    if (!canonical || canonicalWebOrigin(url) !== canonical) throw new Error("invalid WebMCP detection origin");
    const stored = await kvGet(KEY);
    const entries = pruneWebmcpRegistry(stored[KEY], now).filter((entry) => entry.origin !== canonical);
    const count = Math.min(1000, Math.max(0, Math.floor(Number(toolCount) || 0)));
    if (count > 0) entries.unshift({ origin: canonical, toolCount: count, lastSeen: now });
    await kvSet({ [KEY]: entries.slice(0, WEBMCP_REGISTRY_MAX) });
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
