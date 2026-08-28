// extension/background/routes/scheduler.js — the per-agent schedule routes
// (CAP owner request: "a user should be able to see the alarms they have per
// agent, so they can pause, resume, or update — also via conversations"),
// extracted from the inline SW handlers so they are unit-drivable.
//
// Authority model (review P1-1):
//   - `schedules.list` is ALWAYS scoped to the calling run's agent identity.
//     There is NO model-facing all:true flag — the global list is the owner's
//     task.list surface only.
//   - task.pause/resume/update enforce owner equality UNDER the scheduler
//     lock: a model principal passes its run context as expectedOwner and the
//     primitive refuses another agent's (or an ownerless) task. Owner-
//     extension principals (the owner's own UI click) bypass the scope check.
//   - Model-initiated mutations are gated by requireOwnerApproval; when the
//     card flow is enabled the gate's pending-approval denial is STRUCTURED
//     ({ waitingForPermission, permissionRequirement:{ reason, approvals } })
//     so the conversation renders the in-context approval card (P1-3) and the
//     owner's Allow resolves the exact pending approval for the retry.

const MAX_NAME = 400;
const MAX_TASK_TEXT = 4000;

function boundedName(value) {
  const name = String(value ?? "");
  if (!name || name.length > MAX_NAME) return "";
  return name;
}

export function createSchedulerRoutes({
  pauseScheduledTask,
  resumeScheduledTask,
  updateScheduledTask,
  retryScheduledTask,
  listScheduledTasks,
  requireOwnerApproval,
  currentRunContext,
  broadcastProgress,
  canonicalOperationTarget,
  canonicalScalar,
  payloadFields,
}) {
  // The expected-owner for a MODEL principal: the live run's agent identity.
  // Owner-extension callers (extension/owner-options) get undefined → the
  // primitive performs no scope check (the owner's own click is its authority).
  const expectedOwnerFor = (context) => {
    if (context?.principal !== "model") return undefined;
    const ctx = currentRunContext();
    if (!ctx) return null; // a model call with no run context can never own a task
    return { agentRole: ctx.agentRole ?? "", agentSurfaceRef: ctx.agentSurfaceRef ?? null };
  };

  const denialFor = (approval) => {
    if (approval?.ok !== true && approval?.waitingForPermission === true) return approval;
    return { ok: false, error: approval?.error ?? "This operation requires owner approval in Settings." };
  };

  return {
    async "schedules.list"() {
      // The schedules_list agent tool: the CALLING agent's own scheduled tasks
      // only (owner attribution matches this run's agentRole + agentSurfaceRef
      // exactly). Read-only; no approval gate; never the global list.
      const tasks = await listScheduledTasks();
      const ctx = currentRunContext();
      if (!ctx) return { tasks: [], scoped: true };
      const own = tasks.filter((t) => {
        const o = t.owner;
        if (!o) return false;
        return o.agentRole === ctx.agentRole && (o.agentSurfaceRef ?? null) === (ctx.agentSurfaceRef ?? null);
      });
      return { tasks: own, scoped: true };
    },

    async "task.pause"(m, context) {
      const name = boundedName(m?.name);
      if (!name) return { ok: false, error: "task name is required" };
      const expectedOwner = expectedOwnerFor(context);
      if (expectedOwner === null) return { ok: false, error: "no run context — the caller cannot own a scheduled task" };
      const approval = await requireOwnerApproval(
        context,
        "task.pause",
        canonicalOperationTarget("scheduled", { id: name }),
        payloadFields([["name", canonicalScalar(name)]]),
        { card: true, action: "task.pause" },
      );
      if (approval?.ok !== true) return denialFor(approval);
      const r = await pauseScheduledTask(name, { expectedOwner });
      if (r?.ok) broadcastProgress({ type: "scheduled-tasks-changed" });
      return r;
    },

    async "task.resume"(m, context) {
      const name = boundedName(m?.name);
      if (!name) return { ok: false, error: "task name is required" };
      const expectedOwner = expectedOwnerFor(context);
      if (expectedOwner === null) return { ok: false, error: "no run context — the caller cannot own a scheduled task" };
      const approval = await requireOwnerApproval(
        context,
        "task.resume",
        canonicalOperationTarget("scheduled", { id: name }),
        payloadFields([["name", canonicalScalar(name)]]),
        { card: true, action: "task.resume" },
      );
      if (approval?.ok !== true) return denialFor(approval);
      const r = await resumeScheduledTask(name, { expectedOwner });
      if (r?.ok) broadcastProgress({ type: "scheduled-tasks-changed" });
      return r;
    },

    async "task.update"(m, context) {
      const name = boundedName(m?.name);
      if (!name) return { ok: false, error: "task name is required" };
      const expectedOwner = expectedOwnerFor(context);
      if (expectedOwner === null) return { ok: false, error: "no run context — the caller cannot own a scheduled task" };
      const fields = [];
      if (m?.task !== undefined) fields.push(["task", canonicalScalar(String(m.task).slice(0, MAX_TASK_TEXT))]);
      if (m?.at !== undefined) fields.push(["at", canonicalScalar(Number(m.at))]);
      if (m?.delayMs !== undefined) fields.push(["delayMs", canonicalScalar(Number(m.delayMs))]);
      if (m?.periodInMinutes !== undefined) fields.push(["periodInMinutes", canonicalScalar(Number(m.periodInMinutes))]);
      const approval = await requireOwnerApproval(
        context,
        "task.update",
        canonicalOperationTarget("scheduled", { id: name }),
        payloadFields(fields),
        { card: true, action: "task.update" },
      );
      if (approval?.ok !== true) return denialFor(approval);
      try {
        const r = await updateScheduledTask(
          name,
          {
            task: m?.task !== undefined ? String(m.task) : undefined,
            at: m?.at !== undefined ? Number(m.at) : undefined,
            delayMs: m?.delayMs !== undefined ? Number(m.delayMs) : undefined,
            periodInMinutes: m?.periodInMinutes !== undefined ? Number(m.periodInMinutes) : undefined,
          },
          { expectedOwner },
        );
        if (r?.ok) broadcastProgress({ type: "scheduled-tasks-changed" });
        return r;
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },

    async "task.retry"(m, context) {
      // Re-arm a storage-blocked/quarantined task. The SAME owner-scope rule
      // applies: a model principal may only retry ITS OWN task (P1-1).
      const name = boundedName(m?.name);
      if (!name) return { ok: false, error: "task name is required" };
      const expectedOwner = expectedOwnerFor(context);
      if (expectedOwner === null) return { ok: false, error: "no run context — the caller cannot own a scheduled task" };
      return await retryScheduledTask(name, { expectedOwner });
    },
  };
}
