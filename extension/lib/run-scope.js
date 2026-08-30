// lib/run-scope.js — project retained run controls into the active conversation.

const ACTIONABLE_PHASES = new Set([
  "running",
  "settling",
  "cancel-requested",
  "paused-permission",
  "paused-interruption",
  "paused-side-effect-uncertain",
  "paused-provider-change",
  "resume-dispatching",
]);

export function runSurfaceIdentity({ threadId = null, agentId = null, agentKind = null } = {}) {
  if (threadId) return { type: "thread", id: String(threadId) };
  if (!agentId) return null;
  const id = String(agentId);
  if (agentKind === "site") return { type: "agent", id };
  if (agentKind === "background") return { type: "agent", id: `background:${id}` };
  return { type: "agent", id: `named:${id}` };
}

export function runsForSurface(runs, surface = {}) {
  const identity = runSurfaceIdentity(surface);
  if (!identity) return [];
  return (Array.isArray(runs) ? runs : []).filter((run) =>
    identity.type === "thread"
      ? run?.threadId === identity.id
      : run?.agentId === identity.id
  ).sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0));
}

export function actionableRunsForSurface(runs, surface = {}) {
  return runsForSurface(runs, surface).filter((run) =>
    ACTIONABLE_PHASES.has(String(run?.phase ?? ""))
  );
}

/** The most-recent retained run for a surface (any phase — running, terminal or
 * paused) so the agent view can project its transcript (the live run OR the
 * last completed/interrupted run). Read-only; returns null when none exists.
 * Ordered by `updatedAt` (the record's last-write timestamp) — NOT the per-run
 * `revision` counter, which is a CAS value that only orders a SINGLE run's own
 * writes and cannot rank different runs by recency. */
export function latestRunForSurface(runs, surface = {}) {
  const identity = runSurfaceIdentity(surface);
  if (!identity) return null;
  const matching = (Array.isArray(runs) ? runs : []).filter((run) =>
    identity.type === "thread"
      ? run?.threadId === identity.id
      : run?.agentId === identity.id,
  );
  matching.sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0));
  return matching[0] ?? null;
}

/** Terminal-reconciliation gate for a surface's LIVE status row (review P1-1,
 * 2026-08-29): reconcile ONLY from the settled record that IS the live run —
 * matched by the client's immutable per-attempt run id, projected onto the
 * durable record as clientCorrelationId. The previous timestamp heuristic
 * (settled.updatedAt >= liveStart − skew) let a FRESH terminal record for the
 * PREVIOUS run clear a NEW live run's row under queue saturation (the old run
 * settles inside the skew window while the follow-up is not yet registered).
 * Fail-closed: no known live run id, or a record with no clientCorrelationId
 * (e.g. delegate dispatches), never reconciles. */
export function isSettledLiveRunRecord(settled, liveClientRunId) {
  if (!settled || typeof settled !== "object") return false;
  if (typeof liveClientRunId !== "string" || !liveClientRunId) return false;
  return settled.clientCorrelationId === liveClientRunId;
}
