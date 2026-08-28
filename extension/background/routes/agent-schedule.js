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
