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
import { journalJson } from "../../shared/tool-tree.js";
import { redactSecretText } from "../../lib/pure.js";
import { RUN_BUDGET_BOUNDS, RUN_BUDGET_DEFAULTS } from "../../lib/run-budget.js";

const ALIVE_KEY = "cap:agent-workers:alive";

/** Alive-set persistence lives at module scope so agent deletion can prune it
 * without constructing the route table (the SW passes this as the
 * `closeAgentWorker` teardown injection into deleteNamedAgent). */
const readAliveSetWith = (kvGet) => async () => {
  const s = await kvGet(ALIVE_KEY);
  const list = s?.[ALIVE_KEY];
  return Array.isArray(list) ? list.filter((x) => typeof x === "string").slice(0, 200) : [];
};
const writeAliveSetWith = (kvSet) => (ids) => kvSet({ [ALIVE_KEY]: ids.slice(0, 200) });

/** Agent-deletion teardown: drop the keep-alive port (best-effort — the host
 * may already be gone) and prune the alive-set so the supervisor cannot
 * resurrect a deleted agent's worker. Exported for the SW's delete route. */
export async function closeAgentWorkerFor(agentId, { kvGet, kvSet } = {}) {
  const id = String(agentId ?? "");
  if (!id) return { ok: false, error: "invalid agentId" };
  try {
    await chrome.runtime.sendMessage({ type: "agent-worker-host:close", agentId: id });
  } catch { /* host may already be gone */ }
  const alive = await readAliveSetWith(kvGet)();
  await writeAliveSetWith(kvSet)(alive.filter((x) => x !== id));
  return { ok: true, agentId: id, closed: true };
}
const WORKER_PATH = "dist/workers/agent-worker.js";

// Review r6 P1-2: a steer control message is only reported "steered" once the
// WORKER confirms it (the host relays the worker's steered/steer-refused
// reply back). This bounds how long the SW waits for that confirmation.
const STEER_REPLY_TIMEOUT_MS = 8000;

let steerSeq = 0;
/** A fresh correlation id for a worker steer when the caller did not supply
 * one (the host matches the worker's reply on it — never guess across
 * concurrent steers). */
function steerToken() {
  steerSeq += 1;
  return `sw-${Date.now().toString(36)}-${steerSeq.toString(36)}`;
}

const log = capLog("agent-workers");

/** Review r6 P1-1: a worker run must be in the live run-control plane BEFORE
 * the run descriptor reaches the worker — the worker executes in another
 * realm and can complete + relay agent-worker.result while this route still
 * awaits the host's post response. Registering only after the post let that
 * early result unregister nothing and left a COMPLETED run registered
 * forever (steerable, 64-slot seat consumed). A null register (registry
 * full) REFUSES the kick — an accepted-but-unsteerable run would lie to the
 * owner. Every post/ensure failure releases the record. */
async function kickWorkerRun({ runId, identity, descriptor, runControl }) {
  if (runControl) {
    const record = runControl.register({ executionId: runId, surface: `agent-worker:${identity}`, kind: "worker" });
    if (!record) {
      return { ok: false, error: "live-run registry full — worker run refused (cannot be steered or stopped)", code: "run_control_full", runId };
    }
  }
  let posted;
  try {
    posted = await chrome.runtime.sendMessage({
      type: "agent-worker-host:post",
      agentId: identity,
      msg: { type: "agent-worker:run", ...descriptor },
    });
  } catch (e) {
    runControl?.unregister(runId);
    return { ok: false, error: `worker host unreachable: ${e?.message ?? e}` };
  }
  if (!posted?.ok) {
    runControl?.unregister(runId);
    return { ok: false, error: posted?.error || "worker run not posted" };
  }
  return { ok: true, runId, identity };
}

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

function bounded(value, max) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function redactedPreview(value, max) {
  // The CANONICAL redactor (the local regex missed the bare-whitespace form).
  return redactSecretText(bounded(value, max));
}

function sanitizeProgressEvent(event) {
  if (!event || typeof event !== "object") return { type: "progress" };
  const type = String(event.type ?? "progress").slice(0, 64);
  const out = { type };
  if (event.toolName != null) out.toolName = String(event.toolName).slice(0, 128);
  if (event.toolArgs != null) {
    // journalJson: ALWAYS valid bounded JSON (never a mid-string slice that
    // corrupts the payload — the replay-blob bug) with canonical redaction.
    out.toolArgs = journalJson(event.toolArgs, { maxBytes: 2048 });
  }
  if (event.result != null) {
    out.result = journalJson(event.result, { maxBytes: 2048 });
  }
  // The lazy protocol's resolved tool name rides the event so the UI card can
  // correct `execute_tool` to the tool that actually ran.
  if (event.selectedTool != null) out.selectedTool = String(event.selectedTool).slice(0, 128);
  if (event.text != null) out.text = redactedPreview(event.text, 2048);
  if (event.step != null && Number.isFinite(event.step)) out.step = event.step;
  if (event.totalSteps != null && Number.isFinite(event.totalSteps)) out.totalSteps = event.totalSteps;
  if (event.durationMs != null && Number.isFinite(event.durationMs)) out.durationMs = event.durationMs;
  if (event.ok !== undefined) out.ok = Boolean(event.ok);
  return out;
}

// dptw: the journal stores every field WHOLE — redacted for secrets, never
// clipped. (The structured renderer parses serialized fields; JSON.stringify
// keeps them valid, and redaction is the same text-level pass journalJson
// applies.)
function journalWhole(value) {
  try {
    return redactSecretText(typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    return "\"[unserializable value]\"";
  }
}

function sanitizeJournalEntry(entry, executionId) {
  if (!entry || typeof entry !== "object") return { type: "task", executionId };
  const type = String(entry.type ?? "task");
  const id = entry.id ? String(entry.id) : String(Date.now());
  const out = { type, id, executionId };
  if (entry.task != null) out.task = redactSecretText(String(entry.task));
  if (entry.result != null) {
    out.result = journalWhole(entry.result);
  }
  if (entry.tool != null) out.tool = String(entry.tool);
  if (entry.selectedTool != null) out.selectedTool = String(entry.selectedTool);
  if (entry.args != null) out.args = journalWhole(entry.args);
  if (entry.callId != null) out.callId = String(entry.callId);
  if (entry.run != null) out.run = String(entry.run);
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
  resolveAgentIdentity = null,
  runControl = null,
}) {
  // Review P1-2: worker identity must be the agent's IMMUTABLE instanceId —
  // a caller-supplied reusable slug would key the host worker + alive-set by
  // a name a recreated agent reuses, inheriting the previous instance's
  // worker. When the SW injects a resolver, both ensure and run re-key to
  // the resolved identity; without it (tests), the literal is used.
  const workerIdentity = async (agentId) => {
    if (typeof resolveAgentIdentity !== "function") return agentId;
    try { return (await resolveAgentIdentity(agentId)) || agentId; } catch { return agentId; }
  };
  const readAliveSet = readAliveSetWith(kvGet);
  const writeAliveSet = (ids) => writeAliveSetWith(kvSet)(ids);

  return {
    /** Validate + ensure an agent's shared worker is alive. Returns the
     * connection params so a validated client can construct the SAME shared
     * worker and hold its own live port. */
    async "agent-worker.ensure"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const agentId = String(m?.agentId ?? "");
      if (!agentId || agentId.length > 200) return { ok: false, error: "invalid agentId" };

      const identity = await workerIdentity(agentId);
      const host = await ensureOffscreen();
      if (!host?.ok) return { ok: false, error: host?.error || "offscreen unavailable" };

      let ensured;
      try {
        ensured = await chrome.runtime.sendMessage({ type: "agent-worker-host:ensure", agentId: identity });
      } catch (e) {
        return { ok: false, error: `worker host unreachable: ${e?.message ?? e}` };
      }
      if (!ensured?.ok) return { ok: false, error: ensured?.error || "worker not ensured" };

      // Record liveness in the durable alive-set (identity-keyed).
      const alive = await readAliveSet();
      if (!alive.includes(identity)) await writeAliveSet([...alive, identity]);

      return { ok: true, agentId: identity, workerUrl: workerUrl(), name: identity, created: ensured.created };
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

      const identity = await workerIdentity(agentId);
      const ensured = await this["agent-worker.ensure"]({ agentId: identity }, context);
      if (!ensured?.ok) return ensured;

      const descriptor = {
        runId,
        task: String(m?.task ?? "").slice(0, 4000),
        system: String(m?.system ?? "").slice(0, 16000),
        modelKind: String(m?.modelKind ?? "demo").slice(0, 32),
        maxIterations: Math.min(Number(m?.maxIterations ?? RUN_BUDGET_DEFAULTS.maxIterations) || RUN_BUDGET_DEFAULTS.maxIterations, RUN_BUDGET_BOUNDS.maxIterations),
        toolSpecs: Array.isArray(m?.toolSpecs) ? m.toolSpecs.slice(0, 200) : [],
      };
      // Review r6 P1-1: register BEFORE the host post (kickWorkerRun owns the
      // order) — see the helper's comment for the race it closes.
      const kicked = await kickWorkerRun({ runId, identity, descriptor, runControl });
      if (!kicked?.ok) return kicked;
      return { ok: true, runId, agentId: kicked.identity };
    },

    /** P4 dispatch seam: a background/foreground run KICKED through the worker.
     * This is the seam the alarm path (handleAlarm) will call — it ensures the
     * worker, posts the run descriptor, and returns. The FULL handleAlarm→worker
     * reroute is the documented next increment (runTask's fence/heartbeat/journal
     * are SW authority and decompose separately). */
    async "agent-worker.dispatch"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const agentId = String(m?.agentId ?? "").slice(0, 200);
      if (!agentId) return { ok: false, error: "invalid agentId" };
      const runId = String(m?.runId ?? "").slice(0, 200);
      if (!runId) return { ok: false, error: "invalid runId" };

      // Ensure the worker is alive (idempotent).
      const identity = await workerIdentity(agentId);
      const ensured = await this["agent-worker.ensure"]({ agentId: identity }, context);
      if (!ensured?.ok) return ensured;

      const descriptor = {
        runId,
        task: String(m?.task ?? "").slice(0, 4000),
        system: String(m?.system ?? "").slice(0, 16000),
        modelKind: String(m?.modelKind ?? "demo").slice(0, 32),
        maxIterations: Math.min(Number(m?.maxIterations ?? RUN_BUDGET_DEFAULTS.maxIterations) || RUN_BUDGET_DEFAULTS.maxIterations, RUN_BUDGET_BOUNDS.maxIterations),
        toolSpecs: Array.isArray(m?.toolSpecs) ? m.toolSpecs.slice(0, 200) : [],
      };
      // Review r6 P1-1: same register-before-post discipline as agent-worker.run.
      const kicked = await kickWorkerRun({ runId, identity, descriptor, runControl });
      if (!kicked?.ok) return kicked;
      return { ok: true, runId, agentId: kicked.identity };
    },

    /** PHASE-2 tool bridge — the worker's RPC proxy resolves here. THIS is the
     * authority boundary: the worker cannot execute any tool itself; the SW
     * validates + executes the real tool (grant-lock / run-fence / redaction). */
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
      // review r3 P1-3: resolve through the SAME identity resolver as
      // ensure/run — a slug close used to message/remove the SLUG key while
      // the host worker + alive-set entry live under the instanceId, leaving
      // the instance worker alive after a "successful" close.
      const identity = await workerIdentity(agentId);
      try {
        await chrome.runtime.sendMessage({ type: "agent-worker-host:close", agentId: identity });
      } catch { /* host may already be gone */ }
      const alive = await readAliveSet();
      await writeAliveSet(alive.filter((id) => id !== agentId && id !== identity));
      return { ok: true, agentId: identity, closed: true };
    },
    /** chrome-agent-platform-afiu: the run protocol's STEER control message
     * for a live WORKER run. Only a validated extension surface may steer;
     * the control record is forwarded to the worker (its run loop honors it
     * between steps). stop-run maps to the worker's abort (clean cancel — the
     * worker reports the aborted terminal, never an orphaned run). */
    async "agent-worker.steer"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const agentId = String(m?.agentId ?? "").slice(0, 200);
      const executionId = String(m?.runId ?? m?.executionId ?? "");
      if (!executionId) return { ok: false, error: "invalid runId" };
      const mode = String(m?.mode ?? "inject").slice(0, 16);
      if (!["inject", "stop-step", "stop-run"].includes(mode)) return { ok: false, error: "invalid_steer_mode" };
      const text = String(m?.text ?? "").slice(0, 1500);
      // The agent identity comes from the live control record (surface
      // `agent-worker:<identity>`) when the caller did not name it — a steer
      // is always keyed to a LIVE run, never to a slug that could re-target
      // a newer run.
      let identity = null;
      const live = runControl?.get?.(executionId) ?? null;
      if (agentId) identity = await workerIdentity(agentId);
      else if (live?.surface?.startsWith("agent-worker:")) identity = live.surface.slice("agent-worker:".length);
      if (!identity) return { ok: false, error: "run_not_live", executionId };
      try {
        if (mode === "stop-run") {
          // Stop the worker's loop (its abort relay ends the run and settles
          // the durable record through agent-worker.result). Review r6 P1-2:
          // the host relays the worker's aborted ack back — the owner is
          // never told "stopped" against a dead host or a missed abort.
          const relayed = await chrome.runtime.sendMessage({
            type: "agent-worker-host:post",
            agentId: identity,
            msg: { type: "agent-worker:abort", runId: executionId },
            expectReply: { types: ["agent-worker:aborted"], keyField: "runId", timeoutMs: STEER_REPLY_TIMEOUT_MS },
          });
          if (relayed?.ok !== true) {
            return { ok: false, executionId, error: relayed?.error || "worker stop not confirmed", code: "stop_unconfirmed" };
          }
          return { ok: true, executionId, stopped: true };
        }
        // inject / stop-step — review r6 P1-2: the SW asks the host to relay
        // the WORKER's own decision back (steered / steer-refused), keyed by
        // a steerId the worker echoes. A bare host "posted" acknowledgement
        // never reaches the owner as "steered" — a steer_buffer_full refusal
        // (or a dead worker) is surfaced as the honest error it is.
        const steerId = m?.steerId ? String(m.steerId).slice(0, 120) : steerToken();
        const relayed = await chrome.runtime.sendMessage({
          type: "agent-worker-host:post",
          agentId: identity,
          msg: {
            type: "agent-worker:steer",
            runId: executionId,
            steerId,
            mode,
            text,
          },
          expectReply: {
            types: ["agent-worker:steered", "agent-worker:steer-refused"],
            keyField: "steerId",
            timeoutMs: STEER_REPLY_TIMEOUT_MS,
          },
        });
        if (relayed?.ok !== true) {
          // Host unreachable, no such worker, or the worker never answered:
          // the steer was NOT confirmed — never report it as steered.
          return { ok: false, executionId, steerId, error: relayed?.error || "worker steer post failed", code: "steer_unconfirmed" };
        }
        if (relayed.relayed?.type === "agent-worker:steer-refused") {
          const refused = relayed.relayed;
          const code = String(refused.error ?? "steer_refused");
          return { ok: false, executionId, steerId, error: code, code };
        }
        return { ok: true, executionId, steered: true, mode, steerId };
      } catch (e) {
        return { ok: false, error: `worker host unreachable: ${e?.message ?? e}` };
      }
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
      // chrome-agent-platform-afiu review r5 P1-1: the live control record is
      // released FIRST — before the durable-execution shape gate — because
      // the registry holds whatever runId the run was registered under (the
      // worker relays the SAME id it was given). A worker run that finishes
      // must never stay steerable / consume a 64-slot live-registry seat
      // because its id was not exec:-shaped.
      runControl?.unregister(executionId);
      if (!validExecutionId(executionId)) return { ok: false, error: "invalid executionId" };

      const ok = m?.ok === true;
      // dptw: the result passes through WHOLE — the old 64 KiB bound here
      // truncated the result BEFORE settle, so even the retained payload was
      // clipped. The durable-runs settle path retains large results by
      // reference (kmpq); the transport record stays small by design there.
      const result = m?.result !== undefined ? String(m.result) : undefined;
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
