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
import {
  acquireBrowserCommandLease,
  enterBrowserCommandContext,
  exitBrowserCommandContext,
  readBrowserCommandLease,
  releaseBrowserCommandLease,
} from "../../lib/browser-command-lease.js";

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
const MAX_PREVIEW_CHARS = 240;

/** The destructive browser-command tool names (P4 single-driver): these drive
 * the browser state (open/close/navigate tabs+windows, tab groups, downloads,
 * extension enable/uninstall) and therefore require the browser-command lease.
 * Read-only tools (list_*, get_*, read_page, capture_screenshot, query_*) are
 * NOT gated — the lease is about WHO may drive mutations, not who may observe. */
const DESTRUCTIVE_BROWSER_TOOLS = new Set([
  "open_tab", "navigate_tab", "close_tab", "move_tab", "duplicate_tab",
  "set_tab_pinned", "reload_tab", "tab_go_back", "tab_go_forward", "set_tab_zoom",
  "discard_tab", "highlight_tabs", "create_window", "focus_window", "close_window",
  "move_window", "group_tabs", "update_tab_group", "ungroup_tabs", "move_tab_to_group",
  "download_file", "pause_download", "resume_download", "cancel_download",
  "erase_download", "open_download", "remove_download_file",
  "set_extension_enabled", "uninstall_extension",
  "add_network_rule", "update_network_rule", "remove_network_rule",
  "set_content_setting", "clear_content_settings", "wipe_browsing_data",
]);

function requiresBrowserCommandLease(toolName) {
  return DESTRUCTIVE_BROWSER_TOOLS.has(String(toolName ?? ""));
}

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

function sanitizeJournalEntry(entry, executionId) {
  if (!entry || typeof entry !== "object") return { type: "task", executionId };
  const type = String(entry.type ?? "task").slice(0, 64);
  const id = entry.id ? String(entry.id).slice(0, 200) : String(Date.now());
  const out = { type, id, executionId };
  if (entry.task != null) out.task = redactedPreview(entry.task, 4096);
  if (entry.result != null) {
    out.result = journalJson(entry.result, { maxBytes: 65536 });
  }
  if (entry.tool != null) out.tool = String(entry.tool).slice(0, 128);
  if (entry.selectedTool != null) out.selectedTool = String(entry.selectedTool).slice(0, 128);
  if (entry.args != null) out.args = journalJson(entry.args, { maxBytes: 4096 });
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
  resolveAgentIdentity = null,
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
        maxIterations: Math.min(Number(m?.maxIterations ?? 12) || 12, 64),
        toolSpecs: Array.isArray(m?.toolSpecs) ? m.toolSpecs.slice(0, 200) : [],
      };
      let posted;
      try {
        posted = await chrome.runtime.sendMessage({
          type: "agent-worker-host:post",
          agentId: identity,
          msg: { type: "agent-worker:run", ...descriptor },
        });
      } catch (e) {
        return { ok: false, error: `worker host unreachable: ${e?.message ?? e}` };
      }
      if (!posted?.ok) return { ok: false, error: posted?.error || "worker run not posted" };
      return { ok: true, runId, agentId: identity };
    },

    /** P4 dispatch seam: a background/foreground run KICKED through the worker
     * with the single-driver lease held for the run's lifetime. This is the
     * seam the alarm path (handleAlarm) will call — it ensures the worker,
     * acquires the lease (honest refusal if another surface drives), posts the
     * run with the leaseId threaded into the descriptor (so the worker's
     * destructive tool RPCs present it), and returns. The FULL handleAlarm→worker
     * reroute is the documented next increment (runTask's fence/heartbeat/journal
     * are SW authority and decompose separately). */
    async "agent-worker.dispatch"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const agentId = String(m?.agentId ?? "").slice(0, 200);
      if (!agentId) return { ok: false, error: "invalid agentId" };
      const runId = String(m?.runId ?? "").slice(0, 200);
      if (!runId) return { ok: false, error: "invalid runId" };
      const surfaceId = String(m?.surfaceId ?? agentId).slice(0, 200);

      // Ensure the worker is alive (idempotent).
      const identity = await workerIdentity(agentId);
      const ensured = await this["agent-worker.ensure"]({ agentId: identity }, context);
      if (!ensured?.ok) return ensured;

      // Acquire the single-driver lease for this run's lifetime.
      const lease = await acquireBrowserCommandLease(kvGet, kvSet, {
        surfaceId,
        runId,
        ttlMs: Number(m?.ttlMs) || undefined,
      });
      if (!lease.ok) return lease;

      const descriptor = {
        runId,
        leaseId: lease.lease.id,
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
          agentId: identity,
          msg: { type: "agent-worker:run", ...descriptor },
        });
      } catch (e) {
        await releaseBrowserCommandLease(kvGet, kvSet, lease.lease.id).catch(() => {});
        return { ok: false, error: `worker host unreachable: ${e?.message ?? e}` };
      }
      if (!posted?.ok) {
        await releaseBrowserCommandLease(kvGet, kvSet, lease.lease.id).catch(() => {});
        return { ok: false, error: posted?.error || "worker run not posted" };
      }
      return { ok: true, runId, agentId, leaseId: lease.lease.id };
    },

    /** PHASE-2 tool bridge — the worker's RPC proxy resolves here. THIS is the
     * authority boundary: the worker cannot execute any tool itself; the SW
     * validates + executes the real tool (grant-lock / run-fence / redaction).
     * P4: destructive browser commands additionally require the single-driver
     * LEASE (the caller presents a live leaseId it holds). */
    async "agent-worker.tool"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const toolName = String(m?.toolName ?? "").slice(0, 128);
      if (!toolName) return { ok: false, error: "invalid toolName" };
      if (typeof executeTool !== "function") {
        return { ok: false, error: "tool execution not wired in this context" };
      }
      // P4 single-driver: destructive browser commands need a held lease.
      let leaseSurface = null;
      if (requiresBrowserCommandLease(toolName)) {
        const leaseId = m?.leaseId ? String(m.leaseId).slice(0, 200) : "";
        const live = await readBrowserCommandLease(kvGet);
        if (!live || live.expired || live.id !== leaseId) {
          return { ok: false, error: "browser command lease required — another surface may be driving the browser" };
        }
        leaseSurface = live.surfaceId;
      }
      // Enter the run context so the destructive tool's OWN grant-lock lease
      // gate (browser-tools.js withGrantLock) sees THIS run as the holder.
      enterBrowserCommandContext(leaseSurface);
      try {
        return await executeTool(toolName, m?.args ?? {}, context);
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
      } finally {
        exitBrowserCommandContext();
      }
    },

    /** P4 single-driver lease: acquire/release the browser-command session
     * lease (the worker's run acquires it before driving the browser; the UI
     * releases it on task end). Validated surfaces only. */
    async "agent-worker.lease"(m, context) {
      if (!authorized(context)) return { ok: false, error: "unauthorized_principal" };
      const action = String(m?.action ?? "").slice(0, 16);
      if (action === "acquire") {
        const surfaceId = String(m?.surfaceId ?? "").slice(0, 200);
        if (!surfaceId) return { ok: false, error: "missing surfaceId" };
        return await acquireBrowserCommandLease(kvGet, kvSet, {
          surfaceId,
          runId: m?.runId ? String(m.runId).slice(0, 200) : null,
          ttlMs: Number(m?.ttlMs) || undefined,
        });
      }
      if (action === "release") {
        return await releaseBrowserCommandLease(kvGet, kvSet, m?.leaseId ? String(m.leaseId).slice(0, 200) : "");
      }
      if (action === "read") {
        const live = await readBrowserCommandLease(kvGet);
        return { ok: true, lease: live && !live.expired ? live : null };
      }
      return { ok: false, error: "unknown action (acquire|release|read)" };
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
