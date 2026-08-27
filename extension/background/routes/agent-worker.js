// extension/background/routes/agent-worker.js — the SW-side authority for the
// per-agent SHARED-WORKER execution architecture (CAP-FB-20260826-AGENT-WORKERS-01).
//
// The SW cannot construct workers; the single offscreen document (offscreen.js
// → lib/agent-worker-host.js) is the host. This module is the SW's authority:
//   - ensure a worker is alive (offscreen doc + per-agent shared worker);
//   - the durable ALIVE-SET — "which agents should be alive" — lives here
//     (chrome.storage kv), NOT in any worker;
//   - reconcile-on-wake re-ensures agents whose workers died;
//   - Phase 3 durability routes: progress/result/journal commitments from
//     worker runs are received, validated, redacted, and durably written.
//
// Clients (NTP/sidepanel) hold a port by constructing the SAME shared worker
// (`new SharedWorker(workerUrl, { name: agentId })`); the SW's `ensure` route
// validates the caller and returns the connection params. Validation stays in
// the SW (the design invariant): only extension surfaces may ensure/close.

import { capLog } from "../../lib/cap-log.js";

const ALIVE_KEY = "cap:agent-workers:alive";
const WORKER_PATH = "dist/workers/agent-worker.js";
const MAX_PREVIEW_CHARS = 240;

const log = capLog("agent-workers");

/** The validated extension-surface principal set (same as the owner-surface
 * routes: extension pages + Settings; never a content-script/page or model). */
function authorized(context) {
  return context?.principal === "extension" || context?.principal === "owner-options";
}

function workerUrl() {
  return typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL(WORKER_PATH)
    : WORKER_PATH;
}

function validExecutionId(value) {
  if (typeof value !== "string" || value.length > 200) return false;
  const lower = value.toLowerCase();
  if (["__proto__", "prototype", "constructor"].includes(lower)) return false;
  return /^exec:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    || /^exec_[a-zA-Z0-9][a-zA-Z0-9_-]{7,194}$/.test(value);
}

function bounded(value, max = MAX_PREVIEW_CHARS) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function redactedPreview(value, max = MAX_PREVIEW_CHARS) {
  return bounded(value, max)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|credential|access[_-]?key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

function sanitizeProgressEvent(event) {
  if (!event || typeof event !== "object") return { type: "progress" };
  const type = String(event.type ?? "progress").slice(0, 64);
  const out = { type };
  if (event.toolName != null) out.toolName = String(event.toolName).slice(0, 128);
  if (event.toolArgs != null) {
    let raw;
    try { raw = JSON.stringify(event.toolArgs); } catch { raw = String(event.toolArgs); }
    out.toolArgs = redactedPreview(raw, 2048);
  }
  if (event.result != null) {
    let raw;
    try { raw = typeof event.result === "string" ? event.result : JSON.stringify(event.result); } catch { raw = String(event.result); }
    out.result = redactedPreview(raw, 2048);
  }
  if (event.text != null) out.text = redactedPreview(event.text, 2048);
  if (event.step != null && Number.isFinite(event.step)) out.step = event.step;
  if (event.totalSteps != null && Number.isFinite(event.totalSteps)) out.totalSteps = event.totalSteps;
  if (event.durationMs != null && Number.isFinite(event.durationMs)) out.durationMs = event.durationMs;
  if (event.ok !== undefined) out.ok = Boolean(event.ok);
  return out;
}

function sanitizeJournalEntry(entry, executionId) {
  if (!entry || typeof entry !== "object") return { type: "task", executionId };
  const type = String(entry.type ?? "task").slice(0, 64);
  const id = entry.id ? String(entry.id).slice(0, 200) : String(Date.now());
  const out = { type, id, executionId };
  if (entry.task != null) out.task = redactedPreview(entry.task, 4096);
  if (entry.result != null) {
    let raw;
    try { raw = typeof entry.result === "string" ? entry.result : JSON.stringify(entry.result); } catch { raw = String(entry.result); }
    out.result = redactedPreview(raw, 65536);
  }
  if (entry.tool != null) out.tool = String(entry.tool).slice(0, 128);
  if (entry.args != null) out.args = redactedPreview(entry.args, 4096);
  if (entry.callId != null) out.callId = String(entry.callId).slice(0, 200);
  if (entry.run != null) out.run = String(entry.run).slice(0, 200);
  if (entry.ok !== undefined) out.ok = Boolean(entry.ok);
  if (entry.at != null && Number.isFinite(entry.at)) out.at = entry.at;
  return out;
}

export function createAgentWorkerRoutes({
  ensureOffscreen,
  kvGet,
  kvSet,
  executeTool,
  durableRegistry = null,
  broadcastProgress = null,
  markScheduledDone = null,
  resolveJournalStore = null,
  journalAppend = null,
}) {
  const readAliveSet = async () => {
    const s = await kvGet(ALIVE_KEY);
    const list = s?.[ALIVE_KEY];
    return Array.isArray(list) ? list.filter((x) => typeof x === "string").slice(0, 200) : [];
  };
  const writeAliveSet = (ids) => kvSet({ [ALIVE_KEY]: ids.slice(0, 200) });

  return {
    /** Validate + ensure an agent's shared worker is alive. Returns the
     * connection params so a validated client can construct the SAME shared
     * worker and hold its own live port. */
    async "agent-worker.ensure"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const agentId = String(m?.agentId ?? "");
      if (!agentId || agentId.length > 200) return { ok: false, error: "invalid agentId" };

      const host = await ensureOffscreen();
      if (!host?.ok) return { ok: false, error: host?.error || "offscreen unavailable" };

      let ensured;
      try {
        ensured = await chrome.runtime.sendMessage({ type: "agent-worker-host:ensure", agentId });
      } catch (e) {
        return { ok: false, error: `worker host unreachable: ${e?.message ?? e}` };
      }
      if (!ensured?.ok) return { ok: false, error: ensured?.error || "worker not ensured" };

      // Record liveness in the durable alive-set.
      const alive = await readAliveSet();
      if (!alive.includes(agentId)) await writeAliveSet([...alive, agentId]);

      return { ok: true, agentId, workerUrl: workerUrl(), name: agentId, created: ensured.created };
    },

    /** PHASE-2 run kick (SW → host → worker run descriptor). Validated: only
     * extension surfaces may start a worker run. The worker holds NO authority
     * — its tools RPC back here via `agent-worker.tool`. */
    async "agent-worker.run"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const agentId = String(m?.agentId ?? "");
      if (!agentId || agentId.length > 200) return { ok: false, error: "invalid agentId" };
      const runId = String(m?.runId ?? "").slice(0, 200);
      if (!runId) return { ok: false, error: "invalid runId" };

      const ensured = await this["agent-worker.ensure"]({ agentId }, context);
      if (!ensured?.ok) return ensured;

      const descriptor = {
        runId,
        task: String(m?.task ?? "").slice(0, 4000),
        system: String(m?.system ?? "").slice(0, 16000),
        modelKind: String(m?.modelKind ?? "demo").slice(0, 32),
        maxIterations: Math.min(Number(m?.maxIterations ?? 12) || 12, 64),
        toolSpecs: Array.isArray(m?.toolSpecs) ? m.toolSpecs.slice(0, 200) : [],
      };
      let posted;
      try {
        posted = await chrome.runtime.sendMessage({
          type: "agent-worker-host:post",
          agentId,
          msg: { type: "agent-worker:run", ...descriptor },
        });
      } catch (e) {
        return { ok: false, error: `worker host unreachable: ${e?.message ?? e}` };
      }
      if (!posted?.ok) return { ok: false, error: posted?.error || "worker run not posted" };
      return { ok: true, runId, agentId };
    },

    /** PHASE-2 tool bridge — the worker's RPC proxy resolves here. THIS is the
     * authority boundary: the worker cannot execute any tool itself; the SW
     * validates + executes the real tool (grant-lock / run-fence / redaction).
     * The full 130-tool grant-lock mapping is P3 — this route is the single
     * choke point. */
    async "agent-worker.tool"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const toolName = String(m?.toolName ?? "").slice(0, 128);
      if (!toolName) return { ok: false, error: "invalid toolName" };
      if (typeof executeTool !== "function") {
        return { ok: false, error: "tool execution not wired in this context" };
      }
      try {
        return await executeTool(toolName, m?.args ?? {}, context);
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
      }
    },

    /** List the durable alive-set (which agents the SW believes should be up). */
    async "agent-worker.alive"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      return { ok: true, agents: await readAliveSet() };
    },

    /** Authorized close: ask the host to drop its keep-alive port and remove
     * the agent from the alive-set (the worker dies when its last port closes). */
    async "agent-worker.close"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const agentId = String(m?.agentId ?? "");
      if (!agentId) return { ok: false, error: "invalid agentId" };
      try {
        await chrome.runtime.sendMessage({ type: "agent-worker-host:close", agentId });
      } catch { /* host may already be gone */ }
      const alive = await readAliveSet();
      await writeAliveSet(alive.filter((id) => id !== agentId));
      return { ok: true, agentId, closed: true };
    },

    /** Phase 3: Bounded, redacted progress commit from a worker run.
     * Records progress in durable registry logs + updates execution heartbeat
     * + broadcasts live progress to UI ports. */
    async "agent-worker.progress"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const executionId = String(m?.executionId ?? "");
      if (!validExecutionId(executionId)) return { ok: false, error: "invalid executionId" };
      const event = m?.event;
      if (!event || typeof event !== "object") return { ok: false, error: "missing event" };

      const sanitized = sanitizeProgressEvent(event);
      const rawType = sanitized.type || "progress";

      if (durableRegistry) {
        try {
          await durableRegistry.heartbeat(executionId, { progressed: true });
          const logKey = m?.logKey ? String(m.logKey).slice(0, 128) : `${rawType}:${Date.now()}`;
          await durableRegistry.appendLog(executionId, sanitized, logKey);
        } catch (err) {
          log.warn("progress log append failed", { executionId, error: err?.message ?? err });
        }
      }

      if (typeof broadcastProgress === "function") {
        try {
          broadcastProgress({
            ...sanitized,
            runId: executionId,
            agentId: m?.agentId ? String(m.agentId).slice(0, 128) : undefined,
          });
        } catch { /* best-effort broadcast */ }
      }

      return { ok: true, executionId };
    },

    /** Phase 3: Terminal result commitment from a worker run.
     * Settle execution in the durable-runs registry, update phase, and mark
     * scheduled alarms done if applicable. */
    async "agent-worker.result"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const executionId = String(m?.executionId ?? "");
      if (!validExecutionId(executionId)) return { ok: false, error: "invalid executionId" };

      const ok = m?.ok === true;
      const result = m?.result !== undefined ? bounded(m.result, 64 * 1024) : undefined;
      const error = m?.error ? bounded(m.error, 2048) : undefined;
      const errorCategory = m?.errorCategory ? String(m.errorCategory).slice(0, 64) : undefined;
      const errorReason = m?.errorReason ? bounded(m.errorReason, 512) : undefined;
      const errorAction = m?.errorAction ? bounded(m.errorAction, 512) : undefined;
      const logicalId = m?.logicalId ? bounded(m.logicalId, 200) : undefined;
      const scheduleName = m?.scheduleName ? bounded(m.scheduleName, 200) : undefined;
      const aborted = m?.aborted === true;

      let terminal = null;
      if (durableRegistry) {
        terminal = await durableRegistry.settle(executionId, {
          ok,
          result,
          error,
          errorCategory: aborted ? "aborted" : errorCategory,
          errorReason,
          errorAction,
          logicalId,
          aborted,
        });
      }

      if ((scheduleName || logicalId) && typeof markScheduledDone === "function") {
        try {
          const schedId = scheduleName || logicalId;
          await markScheduledDone(schedId, m?.scheduleToken ?? executionId);
        } catch (err) {
          log.warn("markScheduledDone failed", { executionId, scheduleName, error: err?.message ?? err });
        }
      }

      return {
        ok: true,
        executionId,
        phase: terminal?.phase ?? (ok ? "terminal" : aborted ? "cancelled" : "terminal"),
        cancelled: terminal?.phase === "cancelled" || aborted,
      };
    },

    /** Phase 3: Bounded journal entry append to persistent OPFS memory store. */
    async "agent-worker.journal-append"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const target = String(m?.target ?? "master").slice(0, 300);
      const entry = m?.entry;
      if (!entry || typeof entry !== "object") return { ok: false, error: "missing entry" };

      const executionId = m?.executionId ? String(m.executionId) : null;
      if (executionId && !validExecutionId(executionId)) {
        return { ok: false, error: "invalid executionId" };
      }

      const sanitized = sanitizeJournalEntry(entry, executionId);
      const memStore = resolveJournalStore ? await resolveJournalStore(target) : null;
      if (memStore && typeof journalAppend === "function") {
        try {
          await journalAppend(memStore, sanitized);
        } catch (err) {
          return { ok: false, error: `journal append failed: ${err?.message ?? err}` };
        }
      }

      if (executionId && durableRegistry) {
        try {
          const logKey = m?.logKey ? String(m.logKey).slice(0, 128) : `${sanitized.type || "entry"}:${sanitized.id || Date.now()}`;
          await durableRegistry.appendLog(executionId, sanitized, logKey);
        } catch { /* best-effort log */ }
      }

      return { ok: true, id: sanitized.id ?? null };
    },
  };
}

/** Reconcile-on-wake: re-ensure every agent in the durable alive-set. Idempotent
 * — a worker that is already alive is returned as-is (created:false). Surfaces
 * failures via the observability log, never throws (boot recovery must not
 * crash the SW). */
export async function reconcileAgentWorkers({ ensureOffscreen, kvGet }) {
  const s = await kvGet(ALIVE_KEY);
  const alive = (Array.isArray(s?.[ALIVE_KEY]) ? s[ALIVE_KEY] : []).filter((x) => typeof x === "string").slice(0, 200);
  if (alive.length === 0) return { ok: true, reconciled: 0 };
  const host = await ensureOffscreen();
  if (!host?.ok) {
    log.warn("reconcile: offscreen unavailable", { error: host?.error });
    return { ok: false, error: host?.error };
  }
  let ok = 0;
  for (const agentId of alive) {
    try {
      const r = await chrome.runtime.sendMessage({ type: "agent-worker-host:ensure", agentId });
      if (r?.ok) ok += 1;
      else log.warn("reconcile: worker not ensured", { agentId, error: r?.error });
    } catch (e) {
      log.warn("reconcile: host ensure failed", { agentId, error: e?.message ?? e });
    }
  }
  log.info("reconcile: agent workers re-ensured", { ensured: ok, total: alive.length });
  return { ok: true, reconciled: ok, total: alive.length };
}
