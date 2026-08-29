// routes/agent-schedule.js — the named-agent schedule route, extracted from
// the service worker so tests drive the REAL route with synthetic principals
// (the same pattern as routes/scheduler.js).
//
// The approval payload binds the FULL schedule mutation — id, period, AND the
// normalized recurring prompt (the REVISE-2 P1: binding only {id, period}
// while passing an unbound task let a model approve one prompt and consume
// the digest retrying with a different one). The normalization here MUST
// match applyAgentSchedule's own normalization (trim; empty → the route's
// default prompt) so the approved payload IS the applied schedule.

/** Normalize the requested recurring prompt the way applyAgentSchedule does. */
export function normalizeScheduleTask(task) {
  return typeof task === "string" ? task.trim() : "";
}

export function createAgentScheduleRoutes({
  applyAgentSchedule,
  requireOwnerApproval,
  canonicalOperationTarget,
  payloadFields,
  slugifyAgentId,
}) {
  return {
    async "named-agent.set-schedule"({ id, periodInMinutes, task }, context) {
      // Add/edit/remove an agent's schedule (the ONE creation flow's schedule
      // backing). Set: the agent runs on a recurring alarm as a REAL named-agent
      // run (its own memory, role layer, saved skills — the fire path's `agent:`
      // branch). Remove (null): the alarm goes, the agent stays. The owner's
      // in-dialog click approves directly; a model-initiated call pends.
      const gate = await requireOwnerApproval(
        context,
        "named-agent.set-schedule",
        canonicalOperationTarget("named", { id: slugifyAgentId(id) }),
        payloadFields([
          ["id", String(id ?? "")],
          ["periodInMinutes", periodInMinutes == null ? "none" : String(periodInMinutes)],
          // The recurring PROMPT is part of the approved mutation — a retry
          // with a different task has a different digest and is rejected.
          ["task", normalizeScheduleTask(task)],
        ]),
      );
      if (!gate?.ok) return gate;
      return await applyAgentSchedule(id, periodInMinutes, task);
    },
  };
}

/**
 * The ONE named-agent schedule application path (extracted from the service
 * worker so tests drive the REAL function with controlled interleavings).
 * Create-with-schedule and edit-schedule both land here. A scheduled agent
 * fires as a REAL named-agent run (its own OPFS memory, its role layer, its
 * saved skills — the fire path's `agent:` branch); removing the schedule
 * cancels the alarm and the agent itself is untouched.
 *
 * REVISE-3 race fix: the agent read and the schedule creation are NOT one
 * atomic section — a deletion can complete in between (the delete gate saw no
 * task to cancel). The REVALIDATION FENCE after scheduleTask re-reads the
 * agent; if it is gone (or replaced — a different instanceId), the
 * just-created schedule is durably cancelled, so no orphan recurring
 * `agent:<slug>` alarm survives for a ghost (the alarm handler intentionally
 * leaves recurring orphans armed). Every interleaving converges: a deletion
 * after the fence cancels through its own gate; a deletion before it is
 * caught here.
 */
export function createApplyAgentSchedule({
  getNamedAgent,
  scheduleTask,
  cancelScheduledTaskBackground,
  broadcastRegistryChanged,
  slugifyAgentId,
  withNamedAgentsLock,
}) {
  return async function applyAgentSchedule(id, periodInMinutes, task = null) {
    const agent = await getNamedAgent(id);
    if (!agent) return { ok: false, error: `no agent ${id}` };
    const slug = slugifyAgentId(id);
    const name = `agent:${slug}`;
    if (periodInMinutes == null || periodInMinutes === 0) {
      const handle = cancelScheduledTaskBackground(name);
      try {
        await handle.marked;
      } catch (err) {
        return { ok: false, error: `schedule removal failed before it was durable: ${err?.message ?? String(err)}` };
      }
      broadcastRegistryChanged();
      return { ok: true, scheduled: false, name, stopping: handle.stopping };
    }
    const minutes = Number(periodInMinutes);
    if (!Number.isFinite(minutes) || minutes < 1) {
      return { ok: false, error: "periodInMinutes must be a number ≥ 1" };
    }
    const prompt = typeof task === "string" && task.trim()
      ? task.trim()
      : `Perform your scheduled run as ${agent.name ?? slug}, per your role.`;
    await scheduleTask({
      task: prompt,
      delayMs: minutes * 60 * 1000,
      periodInMinutes: minutes,
      name,
      owner: { agentRole: `named:${slug}`, agentSurfaceRef: `named:${slug}` },
    });
    // REVISE-5 P1-a: the fence re-read runs UNDER the named-agents lock.
    // deleteNamedAgent holds that same lock across gate-cancel → prompt
    // cleanup → row delete, so the read either lands BEFORE the deletion
    // (the deletion's own gate then cancels the just-created schedule) or
    // AFTER it (the row reads gone and we cancel here). An unlocked read can
    // observe the still-present row between the gate's cancel and the row
    // delete and return success for a schedule nothing will ever cancel.
    // REVISE-5 P1-b: the identity compare is UNCONDITIONAL — persisted legacy
    // rows have no instanceId, and `undefined !== <new id>` must still detect
    // a delete+recreate that happened mid-schedule.
    const after = await withNamedAgentsLock(() => getNamedAgent(id));
    if (!after || after.instanceId !== agent.instanceId) {
      const undo = cancelScheduledTaskBackground(name);
      try {
        await undo.marked;
      } catch (err) {
        return {
          ok: false,
          error: `the agent was deleted while its schedule was being created, and the schedule teardown failed (${err?.message ?? String(err)}) — cancel ${name} from Tasks`,
        };
      }
      broadcastRegistryChanged();
      return { ok: false, error: `agent ${id} was deleted while its schedule was being created — the schedule was not applied` };
    }
    broadcastRegistryChanged();
    return { ok: true, scheduled: true, name, periodInMinutes: minutes };
  };
}

/**
 * The named-agent delete-time schedule teardown, composed as the
 * deleteNamedAgent gate so the ordering is structural (REVISE-2 P1): approval
 * FIRST, then the durable cancelling mark + live-run abort for `agent:<slug>`,
 * and ONLY then may the row/OPFS deletion proceed. A marking failure aborts
 * the deletion — the row survives, no orphan alarm. ONLY the `agent:` family
 * is touched: a `recipe:<slug>` schedule belongs to the recipe store, and an
 * independent recipe schedule that happens to share the slug must survive an
 * agent deletion (recipe teardown stays under recipe.delete).
 */
export function createNamedAgentDeleteGate(context, {
  requireOwnerApproval,
  canonicalOperationTarget,
  namedBoundMutationPayload,
  payloadFields,
  cancelScheduledTaskBackground,
}) {
  return async function gateBeforeDelete({ slug, existing }) {
    let payload;
    try { payload = namedBoundMutationPayload(payloadFields([["id", slug]]), existing); }
    catch { return { ok: false, error: "delete payload is not approvable" }; }
    const gate = await requireOwnerApproval(
      context,
      "named-agent.delete",
      canonicalOperationTarget("named", { id: slug }),
      payload,
    );
    if (!gate?.ok) return gate;
    try {
      await cancelScheduledTaskBackground(`agent:${slug}`).marked;
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        error: `schedule teardown failed before it was durable (${err?.message ?? String(err)}) — the agent was NOT deleted; retry`,
      };
    }
    return { ok: true };
  };
}
