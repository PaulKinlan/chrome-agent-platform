// workers/agent-worker.js — the SHARED worker for ONE agent.
//
// Phase-1 shell (CAP-FB-20260826-AGENT-WORKERS-01). Each agent has its own
// shared worker, named by the agent's durable id (`new SharedWorker(url,
// { name: agentId })`). Chrome dedupes on (url, name): every creator — the
// offscreen host AND any UI page — gets a MessagePort to the SAME live
// instance. self.name is the agent id.
//
// The Phase-2 run loop (agent-do) will live here; phase 1 only proves the
// shell: identity, readiness broadcast, ping/pong, port-hold keep-alive.
// Extension shared workers DO have chrome.* — but the SW stays the authority
// for routing/auth/grant/redaction, so this worker talks to the SW, never to
// storage directly for credentials.

const AGENT_ID = (typeof self !== "undefined" && self.name) || "";
const CHANNEL = `cap:agent:${AGENT_ID}`;
const state = new BroadcastChannel(CHANNEL);

/** Broadcast a state snapshot on the agent's channel (connectionless — any
 * surface can render live state without holding a raw port). */
function broadcast(kind, detail = {}) {
  try {
    state.postMessage({
      agentId: AGENT_ID,
      kind,
      at: Date.now(),
      ...detail,
    });
  } catch {
    /* channel closed / not available — best effort */
  }
}

// Hold every connected port so the worker stays alive while a client is
// attached (the offscreen host also holds one for keep-alive-with-no-page).
const ports = new Set();
self.addEventListener("connect", (event) => {
  const port = event.ports?.[0];
  if (!port) return;
  ports.add(port);
  port.onmessage = (e) => handleMessage(port, e.data);
  port.onmessageerror = () => broadcast("message-error");
  port.start();
  // Acknowledge the attach so the host/client knows the worker is up.
  port.postMessage({ type: "agent-worker:hello", agentId: AGENT_ID, pid: token() });
  broadcast("connected", { clients: ports.size });
});

let pingSeq = 0;
function token() {
  pingSeq += 1;
  return `${Date.now().toString(36)}_${pingSeq}`;
}

function handleMessage(port, msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "agent-worker:ping":
      port.postMessage({ type: "agent-worker:pong", agentId: AGENT_ID, echo: msg.echo ?? null, at: Date.now() });
      break;
    case "agent-worker:close":
      // The host asked this worker to stop holding ports and wind down.
      broadcast("stopping", { clients: ports.size });
      for (const p of [...ports]) {
        try { p.close(); } catch { /* already closed */ }
      }
      ports.clear();
      try { state.close(); } catch { /* already closed */ }
      self.close();
      break;
    default:
      // Phase 2 will route run-lifecycle messages here.
      port.postMessage({ type: "agent-worker:ack", agentId: AGENT_ID, unknown: true });
  }
}

// Announce readiness once the worker is constructed (self.name is set at
// construction, so this runs after the shared worker is deduped/created).
broadcast("ready", { pid: token() });
