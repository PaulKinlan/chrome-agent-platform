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

export function actionableRunsForSurface(runs, surface = {}) {
  const identity = runSurfaceIdentity(surface);
  if (!identity) return [];
  return (Array.isArray(runs) ? runs : []).filter((run) => {
    if (!ACTIONABLE_PHASES.has(String(run?.phase ?? ""))) return false;
    return identity.type === "thread"
      ? run?.threadId === identity.id
      : run?.agentId === identity.id;
  });
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
