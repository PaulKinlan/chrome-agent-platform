// lib/agent-worker-client.js — the UI-side SHARED-WORKER port client
// (CAP-FB-20260826-AGENT-WORKERS-01, Phase 4).
//
// A UI surface (NTP / sidepanel) uses this to hold a LIVE MessagePort to the
// open agent's shared worker, so progress streams reach the UI directly
// (bounded/redacted by the SW + worker) AND the client's port contributes to
// keep-alive ("keep it running as much as possible"). The port is a TRANSPORT,
// never an authority bypass: the surface still routes every ACTION through the
// service worker (the validated routes). This module ONLY connects + subscribes
// to the redacted progress stream — it never issues tool calls over the port.
//
// Handshake (from docs/AGENT-EXECUTION-ARCHITECTURE.md):
//   client → SW `agent-worker.ensure` (validates the surface) → client
//   constructs the SAME shared worker (same URL + name) and
//   agentId })`) → holds its own live port. The offscreen host also holds a
//   keep-alive port so the worker survives zero visible pages.

/** Connect to an agent's shared worker and subscribe to its redacted progress.
 * Falls back to BroadcastChannel-only when a direct port can't be constructed
 * (e.g. file:// preview) — the channel still carries live state. */
export async function connectAgentWorker({ agentId, onProgress = null, onState = null } = {}) {
  const id = String(agentId ?? "");
  if (!id) return { ok: false, error: "missing agentId" };

  // 1. Validate + ensure via the SW (authority). This returns the worker URL +
  //    name the client uses to reconstruct the SAME instance.
  let ensured;
  try {
    ensured = await chrome.runtime.sendMessage({ type: "agent-worker.ensure", agentId: id });
  } catch (e) {
    return { ok: false, error: `ensure failed: ${e?.message ?? e}` };
  }
  if (!ensured?.ok) return { ok: false, error: ensured?.error || "worker not ensured" };

  // 2. BroadcastChannel — connectionless live state (works even without a port).
  const channelName = `cap:agent:${id}`;
  let channel = null;
  try {
    channel = new BroadcastChannel(channelName);
    channel.onmessage = (ev) => {
      const d = ev?.data;
      if (!d || typeof d !== "object") return;
      if (d.kind === "progress" && typeof onProgress === "function") onProgress(d);
      else if (typeof onState === "function") onState(d);
    };
  } catch { /* channel unavailable */ }

  // 3. Construct the SAME shared worker and hold a live port (keep-alive).
  let port = null;
  let worker = null;
  if (typeof SharedWorker === "function" && ensured.workerUrl) {
    try {
      worker = new SharedWorker(ensured.workerUrl, { type: "module", name: id });
      port = worker.port;
      port.start();
      port.onmessage = (ev) => {
        const d = ev?.data;
        if (!d || typeof d !== "object") return;
        if (d.type === "agent-worker:progress" && typeof onProgress === "function") onProgress(d);
      };
    } catch { /* direct port unavailable — channel-only fallback */ }
  }

  return {
    ok: true,
    agentId: id,
    hasPort: !!port,
    port,
    worker,
    channel,
    /** Drop this client's port + channel (the worker survives while the host
     *  or another client still holds a port). */
    disconnect() {
      try { port?.close(); } catch { /* ignore */ }
      try { channel?.close(); } catch { /* ignore */ }
    },
  };
}
