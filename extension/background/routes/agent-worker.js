// extension/background/routes/agent-worker.js — the SW-side authority for the
// per-agent SHARED-WORKER execution architecture (CAP-FB-20260826-AGENT-WORKERS-01).
//
// The SW cannot construct workers; the single offscreen document (offscreen.js
// → lib/agent-worker-host.js) is the host. This module is the SW's authority:
//   - ensure a worker is alive (offscreen doc + per-agent shared worker);
//   - the durable ALIVE-SET — "which agents should be alive" — lives here
//     (chrome.storage kv), NOT in any worker;
//   - reconcile-on-wake re-ensures agents whose workers died.
//
// Clients (NTP/sidepanel) hold a port by constructing the SAME shared worker
// (`new SharedWorker(workerUrl, { name: agentId })`); the SW's `ensure` route
// validates the caller and returns the connection params. Validation stays in
// the SW (the design invariant): only extension surfaces may ensure/close.

import { capLog } from "../../lib/cap-log.js";

const ALIVE_KEY = "cap:agent-workers:alive";
const WORKER_PATH = "workers/agent-worker.js";

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

export function createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet }) {
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
