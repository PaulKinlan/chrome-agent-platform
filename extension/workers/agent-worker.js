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

// ── Owner-steer buffer (chrome-agent-platform-afiu, review r5 P1-1) ───────
// Steers arrive as control messages while a run is live; the run loop reads
// the buffer at EVERY model call (`readSteers`) and appends their text
// between steps. The buffer is per-run (cleared when a run starts/ends) and
// BOUNDED — past the cap a steer is REFUSED with the limit surfaced, never
// silently dropped after the owner was told "ok".
const MAX_PENDING_STEERS = 5;
const steerBuffer = [];

/** Record a validated steer against the ACTIVE run. Refuses when no run is
 * live or the steer names a different runId (a stale UI click must not land
 * on a newer run). Returns {ok:true} or {ok:false, error}. */
function pushSteer({ runId, steerId = null, mode = "inject", text = "" }) {
  const target = String(runId ?? "");
  if (!activeRun || target !== activeRun.runId) {
    return { ok: false, error: "run_not_live", runId: target };
  }
  if (!["inject", "stop-step", "stop-run"].includes(String(mode))) {
    return { ok: false, error: "invalid_steer_mode" };
  }
  if (steerBuffer.length >= MAX_PENDING_STEERS) {
    return { ok: false, error: "steer_buffer_full", count: steerBuffer.length, limit: MAX_PENDING_STEERS };
  }
  steerBuffer.push({
    id: steerId ? String(steerId).slice(0, 120) : `s${Date.now().toString(36)}`,
    mode: String(mode),
    text: String(text ?? "").slice(0, 1500),
  });
  return { ok: true, count: steerBuffer.length };
}

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
function buildProxyTools(toolSpecs, runId) {
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
  const controller = new AbortController();
  steerBuffer.length = 0; // steers are per-run: each run starts clean
  activeRun = { runId, controller };

  const progress = (record) => {
    if (record?.type === "steer") broadcast("steer", { runId, mode: record.mode, text: record.text });
    broadcast("progress", { runId, ...record });
    try { port.postMessage({ type: "agent-worker:progress", runId, ...record }); } catch { /* ignore */ }
  };

  let terminal = null; // { ok, result } | { ok:false, aborted, error }
  try {
    const tools = buildProxyTools(msg?.toolSpecs, runId);
    const result = await runAgentLoop({
      model: resolveModel(modelKind),
      system,
      tools,
      task,
      onProgress: progress,
      signal: controller.signal,
      maxIterations,
      // The loop reads the worker's local steer buffer at EVERY model call —
      // a steer that arrives mid-tool-call changes the agent's next action.
      readSteers: () => [...steerBuffer],
    });
    terminal = { ok: true, result };
    broadcast("run-complete", { runId, ok: true });
    port.postMessage({ type: "agent-worker:run-done", runId, ok: true, result });
  } catch (e) {
    const aborted = controller.signal.aborted;
    const error = String(e?.message ?? e).slice(0, 200);
    terminal = { ok: false, aborted, error };
    broadcast("run-complete", { runId, ok: false, aborted, error });
    port.postMessage({ type: "agent-worker:run-done", runId, ok: false, aborted, error });
  } finally {
    // Terminal relay (review r5 P1-1): the SW's agent-worker.result route
    // releases this run from the live run-control plane and settles its
    // durable record — WITHOUT it a finished worker run stays steerable and
    // consumes a 64-slot live-registry seat forever (and the rejected
    // fire-and-forget handleRun never relayed anything). The result rides
    // bounded (the route applies the same 64 KiB bound downstream).
    if (terminal) {
      try {
        const relay = {
          type: "agent-worker.result",
          executionId: runId,
          agentId: AGENT_ID,
          ok: terminal.ok === true,
        };
        if (terminal.ok === true) {
          relay.result = String(terminal.result ?? "").slice(0, 65536);
        } else {
          relay.error = String(terminal.error ?? "").slice(0, 2048);
          relay.aborted = terminal.aborted === true;
        }
        const reply = chrome.runtime.sendMessage(relay);
        if (reply && typeof reply?.catch === "function") reply.catch(() => {});
      } catch { /* SW may be gone — the port broadcast already carried the terminal */ }
    }
    activeRun = null;
    steerBuffer.length = 0;
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
      port.postMessage({ type: "agent-worker:run-started", runId: msg?.runId ?? "", agentId: AGENT_ID });
      handleRun(port, msg).catch((e) => {
        // A pre-loop failure (nothing past the runId/task parsing can throw,
        // but never a silently orphaned run): relay the hard rejection so the
        // SW releases the live control record. (review r5 P1-1)
        const error = String(e?.message ?? e).slice(0, 200);
        try { port.postMessage({ type: "agent-worker:run-done", runId: msg?.runId ?? "", ok: false, aborted: false, error }); } catch { /* ignore */ }
        try {
          const reply = chrome.runtime.sendMessage({
            type: "agent-worker.result",
            executionId: msg?.runId ?? "",
            agentId: AGENT_ID,
            ok: false,
            error,
          });
          if (reply && typeof reply?.catch === "function") reply.catch(() => {});
        } catch { /* SW gone — best effort */ }
      });
      break;
    case "agent-worker:steer": {
      // Owner steer control message (chrome-agent-platform-afiu), forwarded by
      // the validated SW route (agent-worker.steer). Review r5 P1-1: the
      // message is REJECTED when it names a run this worker is not running
      // (stale click / run already ended) and when the bounded buffer is
      // full — the reply is honest either way, never a silent "steered".
      const accepted = pushSteer({
        runId: msg?.runId ?? "",
        steerId: msg?.steerId ?? null,
        mode: msg?.mode ?? "inject",
        text: msg?.text ?? "",
      });
      if (!accepted.ok) {
        port.postMessage({
          type: "agent-worker:steer-refused",
          runId: msg?.runId ?? "",
          agentId: AGENT_ID,
          error: accepted.error,
        });
        break;
      }
      const mode = String(msg?.mode ?? "inject");
      const text = String(msg?.text ?? "").slice(0, 1500);
      // Broadcast so the transcript can render the owner interruption.
      broadcast("steer", { runId: msg?.runId ?? "", mode, text });
      port.postMessage({ type: "agent-worker:steered", runId: msg?.runId ?? "", agentId: AGENT_ID, mode });
      break;
    }
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
