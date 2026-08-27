// workers/agent-worker.js — the SHARED worker for ONE agent.
//
// Phase-1 shell + Phase-2 run loop (CAP-FB-20260826-AGENT-WORKERS-01). Each
// agent has its own shared worker, named by the agent's durable id
// (`new SharedWorker(url, { name: agentId })`). Chrome dedupes on (url, name):
// every creator — the offscreen host AND any UI page — gets a MessagePort to
// the SAME live instance. self.name is the agent id.
//
// Phase 2: the worker RUNS the agent-do loop (lib/agent-loop.js) but holds NO
// authority — every tool `execute` is an RPC proxy back to the service worker
// (chrome.runtime.sendMessage), which validates + executes the real tool under
// its grant-lock / run-fence / redaction. Progress is streamed redacted (tool
// names / durations / ok / token counts only) to the port + BroadcastChannel.

import { runAgentLoop, proxyTool, passthroughSchema } from "../lib/agent-loop.js";
import { createDemoModel } from "../lib/models/demo-model.js";

const AGENT_ID = (typeof self !== "undefined" && self.name) || "";
const CHANNEL = `cap:agent:${AGENT_ID}`;
const state = new BroadcastChannel(CHANNEL);

/** Broadcast a state snapshot on the agent's channel (connectionless — any
 * surface can render live state without holding a raw port). */
function broadcast(kind, detail = {}) {
  try {
    state.postMessage({ agentId: AGENT_ID, kind, at: Date.now(), ...detail });
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
  port.postMessage({ type: "agent-worker:hello", agentId: AGENT_ID, pid: token() });
  broadcast("connected", { clients: ports.size });
});

let pingSeq = 0;
function token() {
  pingSeq += 1;
  return `${Date.now().toString(36)}_${pingSeq}`;
}

// ── Phase-2 run loop ──────────────────────────────────────────────────────
// The run is single-slot per worker (one agent = one live run). An abort
// controller lets the SW stop the loop between steps.
let activeRun = null; // { runId, controller }

/** Resolve the run model. P2 supports the keyless demo model (proves the loop
 * + tool-RPC end-to-end with no key); real keyed providers are P3 — the worker
 * must not hold an API key (the SW is the credential authority), so the P3
 * path is a proxy model whose doStream posts to the SW which fetches with the
 * key it never leaks. */
function resolveModel(modelKind) {
  if (modelKind === "demo") return createDemoModel();
  return createDemoModel(); // keyless fallback for P2 (honest, labelled demo)
}

/** Build the RPC-proxy tools from the SW-provided spec (names + descriptions
 * only — the worker holds no tool implementation). `execute` posts to the SW
 * and resolves the SW's structured result. */
function buildProxyTools(toolSpecs, runId, leaseId) {
  const tools = {};
  for (const spec of toolSpecs ?? []) {
    const name = String(spec?.name ?? "");
    if (!name) continue;
    tools[name] = proxyTool({
      name,
      description: String(spec?.description ?? name).slice(0, 200),
      // Permissive JSON schema — the SW validates the real args (worker holds
      // no authority, so it must not re-implement the real input contract).
      inputSchema: passthroughSchema(),
      send: async (toolName, args) => {
        const reply = await chrome.runtime.sendMessage({
          type: "agent-worker.tool",
          runId,
          agentId: AGENT_ID,
          toolName,
          args: args ?? {},
          // The single-driver lease (if this run holds one) — presented so the
          // SW authorizes destructive browser commands against the live holder.
          leaseId: leaseId ?? undefined,
        });
        if (reply && typeof reply === "object" && reply.error !== undefined && reply.ok === false) {
          return { error: reply.error };
        }
        return reply;
      },
    });
  }
  return tools;
}

async function handleRun(port, msg) {
  const runId = String(msg?.runId ?? "");
  const task = String(msg?.task ?? "");
  const system = String(msg?.system ?? "");
  const modelKind = String(msg?.modelKind ?? "demo");
  const maxIterations = Number(msg?.maxIterations ?? 12) || 12;
  const leaseId = msg?.leaseId ? String(msg.leaseId) : null;
  const controller = new AbortController();
  activeRun = { runId, controller };

  const progress = (record) => {
    broadcast("progress", { runId, ...record });
    try { port.postMessage({ type: "agent-worker:progress", runId, ...record }); } catch { /* ignore */ }
  };

  try {
    const tools = buildProxyTools(msg?.toolSpecs, runId, leaseId);
    const result = await runAgentLoop({
      model: resolveModel(modelKind),
      system,
      tools,
      task,
      onProgress: progress,
      signal: controller.signal,
      maxIterations,
    });
    broadcast("run-complete", { runId, ok: true });
    port.postMessage({ type: "agent-worker:run-done", runId, ok: true, result });
  } catch (e) {
    const aborted = controller.signal.aborted;
    broadcast("run-complete", { runId, ok: false, aborted, error: String(e?.message ?? e).slice(0, 200) });
    port.postMessage({ type: "agent-worker:run-done", runId, ok: false, aborted, error: String(e?.message ?? e).slice(0, 200) });
  } finally {
    activeRun = null;
  }
}

function handleMessage(port, msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "agent-worker:ping":
      port.postMessage({ type: "agent-worker:pong", agentId: AGENT_ID, echo: msg.echo ?? null, at: Date.now() });
      break;
    case "agent-worker:run":
      // The SW (validated) asked this worker to run the agent-do loop. Fire and
      // acknowledge immediately (the loop streams progress on the port/channel).
      handleRun(port, msg);
      port.postMessage({ type: "agent-worker:run-started", runId: msg?.runId ?? "", agentId: AGENT_ID });
      break;
    case "agent-worker:abort":
      activeRun?.controller?.abort();
      port.postMessage({ type: "agent-worker:aborted", runId: msg?.runId ?? "", agentId: AGENT_ID });
      break;
    case "agent-worker:close":
      activeRun?.controller?.abort();
      broadcast("stopping", { clients: ports.size });
      for (const p of [...ports]) {
        try { p.close(); } catch { /* already closed */ }
      }
      ports.clear();
      try { state.close(); } catch { /* already closed */ }
      self.close();
      break;
    default:
      port.postMessage({ type: "agent-worker:ack", agentId: AGENT_ID, unknown: true });
  }
}

// Announce readiness once the worker is constructed.
broadcast("ready", { pid: token() });
