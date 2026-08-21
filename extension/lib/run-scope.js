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
