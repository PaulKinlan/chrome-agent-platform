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

const WORKER_URL = "dist/workers/agent-worker.js";

const agents = new Map(); // agentId -> { worker, port }

// Review r6 P1-2: outstanding SW requests that await the WORKER's own reply
// (steered / steer-refused / aborted). The host posts the message and, when
// the worker answers on the host's keep-alive port, relays that answer back
// to the SW's request — a bare "posted" is never presented as the worker's
// decision.
const pendingReplies = new Map(); // `${agentId}::${key}` -> { matches, resolve, timer }

/** Route a worker's port reply to the SW request awaiting it (no-op when the
 * reply does not match any pending request). */
function routeWorkerReply(agentId, data) {
  if (!data || typeof data !== "object" || typeof data.type !== "string") return;
  const prefix = `${String(agentId)}::`;
  for (const [mapKey, waiter] of pendingReplies) {
    if (!mapKey.startsWith(prefix)) continue;
    let matched = false;
    try { matched = waiter.matches(data); } catch { matched = false; }
    if (!matched) continue;
    clearTimeout(waiter.timer);
    pendingReplies.delete(mapKey);
    waiter.resolve({ ok: true, agentId: String(agentId), posted: true, relayed: data });
    return;
  }
}

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
    worker = new SharedWorker(workerUrl(), { type: "module", name: id });
  } catch (e) {
    return { ok: false, error: `SharedWorker construction failed: ${e?.message ?? e}` };
  }
  const port = worker.port;
  port.start();
  // Review r6 P1-2: the host listens on its keep-alive port so a worker reply
  // to an SW-originated control message (steer/abort) can be relayed back to
  // the SW request that posted it.
  port.onmessage = (event) => {
    try { routeWorkerReply(id, event?.data); } catch { /* best effort */ }
  };
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

/** Post a message to a worker's keep-alive port (the SW is the only caller —
 * it cannot hold a port itself, so it routes the run kick through the host).
 * Returns the worker's immediate ack if it replies synchronously, else an
 * { posted: true } acknowledgement.
 *
 * Review r6 P1-2: when `expectReply` is given
 * ({ types: string[], keyField: string, timeoutMs: number }), this returns a
 * PROMISE that resolves with the worker's own reply — matched on
 * `relayed.type ∈ types` AND `relayed[keyField] === message[keyField]` — or,
 * when the worker never answers inside the timeout, an honest
 * { ok:false, posted:true, error:"worker_reply_timeout" }. The SW must never
 * report a control message as accepted on a bare "posted". */
export function postAgentWorkerMessage(agentId, message, { expectReply = null } = {}) {
  const id = String(agentId || "");
  const entry = agents.get(id);
  if (!entry) return { ok: false, error: "no such agent worker" };
  if (expectReply && message && typeof message === "object") {
    const keyField = String(expectReply.keyField ?? "").slice(0, 80);
    const key = keyField ? String(message[keyField] ?? "") : "";
    const types = Array.isArray(expectReply.types) ? expectReply.types.map((t) => String(t)).filter(Boolean) : [];
    const mapKey = `${id}::${key || String(expectReply.key ?? "")}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pendingReplies.has(mapKey)) return;
        pendingReplies.delete(mapKey);
        resolve({ ok: false, agentId: id, posted: true, error: "worker_reply_timeout" });
      }, Math.max(250, Number(expectReply.timeoutMs) || 8000));
      const waiter = {
        matches: (data) =>
          types.includes(String(data.type))
          && (!keyField || String(data[keyField] ?? "") === key),
        resolve,
        timer,
      };
      // A second outstanding request on the same key resolves the first
      // (never silently dropped — the SW mints unique steer ids).
      const prior = pendingReplies.get(mapKey);
      if (prior) { clearTimeout(prior.timer); prior.resolve({ ok: false, posted: true, error: "worker_reply_timeout" }); }
      pendingReplies.set(mapKey, waiter);
      try {
        entry.port.postMessage(message ?? {});
      } catch (e) {
        clearTimeout(timer);
        pendingReplies.delete(mapKey);
        resolve({ ok: false, error: `post failed: ${e?.message ?? e}` });
      }
    });
  }
  try {
    entry.port.postMessage(message ?? {});
  } catch (e) {
    return { ok: false, error: `post failed: ${e?.message ?? e}` };
  }
  return { ok: true, agentId: id, posted: true };
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
    if (message.type === "agent-worker-host:post") {
      // Review r6 P1-2: when the SW asked for the worker's own reply
      // (expectReply), answer the request once that reply lands — the
      // listener stays open (returns true) until then.
      const result = postAgentWorkerMessage(message.agentId, message.msg, {
        expectReply: message.expectReply ?? null,
      });
      if (result && typeof result.then === "function") {
        Promise.resolve(result)
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e).slice(0, 200) }));
        return true; // async response channel
      }
      sendResponse(result);
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
