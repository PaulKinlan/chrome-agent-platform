// extension/background/routes/agent-workspace.js — the owner surface's routes
// into an agent's PRIVATE workspace (CAP-FB-20260831-AGENT-PRIVATE-FS-01,
// review round-1 P1): usage (the Settings edit dialog's per-agent row) and the
// owner-gesture Clear. Without these registered the dialog's sends die in
// dispatchRoute as "unknown message" and the row renders "workspace
// unavailable" forever.
//
// Authority model: both routes are restricted to the OWNER surfaces (the same
// gate fs-grants uses). The MODEL principal never needs them — an agent's
// tools resolve its own workspace from the run stamp inside the worker; these
// routes exist so the owner can SEE and EMPTY a workspace by agent id,
// including for an agent that is not running. Clear-by-id from the model
// would be a privilege shortcut (clear ANY agent's workspace), so it fails
// closed for every non-owner principal.

import {
  workspaceKeyFromAgentId,
  backgroundWorkspaceKeyFromAgentId,
  getWorkspaceUsageByKey,
  clearAgentWorkspace,
} from "../../lib/agent-workspace.js";

const OWNER_SURFACES = new Set(["owner-options", "extension"]);

/** The id → workspace-key mapping is the SINGLE place the Settings surface's
 * agent id becomes a directory key; the slug itself is slugifyAgentId (the
 * run-context authority) inside the workspace lib. */
function workspaceKeyFor(id, kind) {
  return kind === "background"
    ? backgroundWorkspaceKeyFromAgentId(id)
    : workspaceKeyFromAgentId(id);
}

export function createAgentWorkspaceRoutes() {
  const ownerOnly = (context, route) => {
    if (OWNER_SURFACES.has(context?.principal)) return null;
    return { ok: false, error: `agent-workspace.${route} is restricted to extension surfaces` };
  };
  return Object.freeze({
    async "agent-workspace.usage"({ id, kind }, context) {
      const refused = ownerOnly(context, "usage");
      if (refused) return refused;
      return await getWorkspaceUsageByKey(workspaceKeyFor(id, kind));
    },

    async "agent-workspace.clear"({ id, kind }, context) {
      const refused = ownerOnly(context, "clear");
      if (refused) return refused;
      return await clearAgentWorkspace({ key: workspaceKeyFor(id, kind) });
    },
  });
}
