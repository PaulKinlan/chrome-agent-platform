// lib/agent-worker-host.js — the offscreen document's SHARED-WORKER host.
//
// The service worker cannot construct workers (no `Worker`/`SharedWorker` in
// ServiceWorkerGlobalScope). The single offscreen document (a Window context)
// is the worker host: it creates/holds the per-agent shared workers and answers
// the SW's ensure/connect/close requests. This module is imported by
// offscreen/offscreen.js so the EXISTING offscreen singleton hosts both the
// script sandbox and the agent workers (Chrome allows one offscreen doc per
// profile — do NOT add a second).
//
// Invariants (from docs/AGENT-EXECUTION-ARCHITECTURE.md):
//   - one authoritative port map `agentId -> { worker, port }`, held here;
//   - the host holds a port per live agent (keep-alive with zero visible pages);
//   - the SW is the only caller (validated routes stay in the SW).

const WORKER_URL = "workers/agent-worker.js";

const agents = new Map(); // agentId -> { worker, port }

function workerUrl() {
  return typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL(WORKER_URL)
    : WORKER_URL;
}

/** Create (or return the existing) shared worker for `agentId`, holding a
 * keep-alive port. Idempotent: the same (url, name) returns the same instance. */
export function ensureAgentWorker(agentId) {
  const id = String(agentId || "");
  if (!id) return { ok: false, error: "missing agentId" };
  const existing = agents.get(id);
  if (existing) return { ok: true, agentId: id, created: false };

  let worker;
  try {
    worker = new SharedWorker(workerUrl(), { name: id });
  } catch (e) {
    return { ok: false, error: `SharedWorker construction failed: ${e?.message ?? e}` };
  }
  const port = worker.port;
  port.start();
  const entry = { worker, port };
  agents.set(id, entry);
  return { ok: true, agentId: id, created: true };
}

/** Close a worker's ports so it can be destroyed (the last port closes it). */
export function closeAgentWorker(agentId) {
  const id = String(agentId || "");
  const entry = agents.get(id);
  if (!entry) return { ok: false, error: "no such agent worker" };
  try { entry.port.postMessage({ type: "agent-worker:close" }); } catch { /* ignore */ }
  try { entry.port.close(); } catch { /* ignore */ }
  agents.delete(id);
  return { ok: true, agentId: id, closed: true };
}

/** The live agent ids this host currently holds (for the SW's reconciliation). */
export function liveAgentIds() {
  return [...agents.keys()];
}

/**
 * Register the host's chrome.runtime.onMessage listener. Messages come from
 * the service worker (the validated authority). Returns an unregister fn.
 */
export function registerAgentWorkerHost() {
  const listener = (message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (message.type === "agent-worker-host:ensure") {
      sendResponse(ensureAgentWorker(message.agentId));
      return false;
    }
    if (message.type === "agent-worker-host:close") {
      sendResponse(closeAgentWorker(message.agentId));
      return false;
    }
    if (message.type === "agent-worker-host:list") {
      sendResponse({ ok: true, agents: liveAgentIds() });
      return false;
    }
    return false;
  };
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener(listener);
  }
  return () => {
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(listener);
    }
  };
}
