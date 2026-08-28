// run-retry.js — UX-008 (CAP-FB-20260828-SILENT-DISPATCH-LOSS-01): a run that
// fails must be RETRYABLE from its stored prompt, never retyped. This module
// holds the pure decision logic for that flow: which failed runs are retryable,
// and how a stored resume-request maps back onto its original dispatch route.
// The SW route (run.retry) composes these with the durable registry's retry
// authority (durableRuns.getRetryRequest) and the live route table.

/** The routes a failed run may be re-dispatched through. `runTask` records the
 * hub path as "runTask" (its default resume route) — that maps onto agent.run's
 * dispatch shape; the named/background routes record themselves. */
const RETRYABLE_ROUTES = new Set(["agent.run", "named-agent.run", "background-agent.run", "runTask"]);

/** A fresh, collision-safe client runId for a retry dispatch. */
export function retryRunId(now = Date.now) {
  return `retry:${now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Map a stored resume-request (the failed run's durable dispatch record) back
 * onto its original route's argument shape. Returns null when the route is not
 * retryable — the caller surfaces an honest refusal, never a silent drop.
 *
 * @param {{route?: string, task?: string, attachments?: unknown[], history?: unknown[], threadId?: string|null, routeArgs?: object}} request
 * @param {{runId?: string}} [opts]
 * @returns {{route: string, args: object} | null}
 */
export function buildRetryDispatch(request, opts = {}) {
  const route = String(request?.route ?? "");
  if (!RETRYABLE_ROUTES.has(route)) return null;
  const task = String(request?.task ?? "");
  if (!task.trim()) return null;
  const attachments = Array.isArray(request?.attachments) ? request.attachments : [];
  const runId = opts.runId ?? retryRunId();
  if (route === "named-agent.run") {
    const args = request?.routeArgs ?? {};
    return {
      route,
      args: {
        id: args.id,
        task,
        attachments,
        runId,
        threadId: args.threadId ?? null,
      },
    };
  }
  if (route === "background-agent.run") {
    const args = request?.routeArgs ?? {};
    return { route, args: { id: args.id, task, runId, attachments } };
  }
  // agent.run (and its recorded default "runTask"): a fresh hub task carries a
  // fresh client task id; an existing threadId continues its thread.
  return {
    route: "agent.run",
    args: {
      task,
      id: String(Date.now()),
      runId,
      attachments,
      history: Array.isArray(request?.history) ? request.history : [],
      threadId: request?.threadId ?? null,
    },
  };
}

/**
 * Project the durable run list onto the bounded failed-runs section the Tasks
 * sidebar renders: terminal failures that kept their stored prompt (retryable),
 * most-recent first, capped. Aborted runs are the owner's own choice — never
 * offered back as failures.
 *
 * Lifecycle opts (failed-runs lifecycle, owner 2026-08-28):
 *   - dismissedIds: execution ids the owner explicitly dismissed (persisted
 *     tombstones) — never rendered again.
 *   - knownAgentIds: the agent surface refs that still exist ("named:<slug>",
 *     "background:<id>"). A failed run whose owning agent no longer exists is
 *     defensively filtered even if the delete-path purge missed it (SW restart
 *     between delete and purge, etc.). Hub runs carry no agentId and stay.
 *
 * @param {Array<{executionId: string, phase?: string, resumeAvailable?: boolean, terminal?: {ok?: boolean, aborted?: boolean, at?: number, summary?: string|null}, taskPreview?: string|null, kind?: string|null, agentId?: string|null}>} runs
 * @param {{limit?: number, dismissedIds?: Iterable<string>, knownAgentIds?: Iterable<string>}} [opts]
 */
export function selectFailedRuns(runs, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 5;
  const dismissed = opts.dismissedIds instanceof Set ? opts.dismissedIds : new Set(opts.dismissedIds ?? []);
  // A set that was never passed means the caller could not know which agents
  // exist (transient fetch failure) — no cascade filtering. An EXPLICIT set
  // (even empty: zero agents exist) is authoritative and filters.
  const knowsAgents = opts.knownAgentIds !== undefined && opts.knownAgentIds !== null;
  const knownAgents = opts.knownAgentIds instanceof Set ? opts.knownAgentIds : new Set(opts.knownAgentIds ?? []);
  return (Array.isArray(runs) ? runs : [])
    .filter((r) =>
      r?.phase === "terminal"
      && r?.terminal && r.terminal.ok === false
      && r.terminal.aborted !== true
      && r.resumeAvailable === true
      && typeof r.executionId === "string" && r.executionId
      && !dismissed.has(r.executionId)
      // Cascade filter: an agent-owned surface must have an existing owner.
      && (!knowsAgents || typeof r.agentId !== "string" || !r.agentId || knownAgents.has(r.agentId))
    )
    .sort((a, b) => (b.terminal.at ?? 0) - (a.terminal.at ?? 0))
    .slice(0, limit)
    .map((r) => ({
      executionId: r.executionId,
      at: r.terminal.at ?? 0,
      summary: typeof r.terminal.summary === "string" ? r.terminal.summary : "",
      taskPreview: typeof r.taskPreview === "string" ? r.taskPreview : "",
      kind: typeof r.kind === "string" ? r.kind : "task",
      agentId: typeof r.agentId === "string" ? r.agentId : null,
    }));
}
