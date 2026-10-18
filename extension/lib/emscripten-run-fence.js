// Model-run liveness is SW-owned, not a claim in the Emscripten message.
// A successful offscreen callback proves only native completion; cancellation
// and SW restart must leave it unpublished if the exact run is no longer live.

import { validExecutionId } from "./durable-runs.js";

const NOT_LIVE = Object.freeze({ ok: false, phase: "failed", error: "emscripten_run_not_live" });

export function isEmscriptenModelRunLive({
  runId, agentId, signal, active, cancelled, ended, workerRun,
} = {}) {
  if (!validExecutionId(runId) ||
      !(agentId === null || (typeof agentId === "string" && agentId.length > 0)) ||
      signal?.aborted || cancelled?.has(runId) || ended?.has(runId) ||
      active?.has(runId) !== true || !workerRun ||
      (workerRun.executionId && workerRun.executionId !== runId)) return false;
  if (workerRun.kind === "worker") {
    return agentId !== null && workerRun.surface === `agent-worker:${agentId}`;
  }
  // runControl registers ordinary hub, named and scheduled executions too.
  // A hub execution owns the null surface; a named run owns its exact agent
  // surface. Both need the live activeExecutions entry as well as this record.
  return ["task", "agent", "scheduled"].includes(workerRun.kind) && workerRun.surface === agentId;
}

// The caller supplies only a fresh SW-local liveness closure; neither the
// offscreen host nor a model-provided argument may assert a run is alive.
export async function runFencedEmscripten({ context, isLive, dispatch } = {}) {
  if (typeof isLive !== "function" || typeof dispatch !== "function" ||
      typeof context?.runId !== "string" ||
      !(context.agentId === null || (typeof context.agentId === "string" && context.agentId.length > 0)) ||
      !isLive(context)) return NOT_LIVE;
  const result = await dispatch();
  return isLive(context) ? result : NOT_LIVE;
}

// The SW sets preview only inside its trusted Settings route. Keep the two
// dispatch behaviours in one tested seam: preview has no model-run identity;
// model calls must be live before AND after offscreen completion.
export async function dispatchEmscriptenForRun({ preview = false, context, isLive, dispatch } = {}) {
  if (typeof dispatch !== "function") return NOT_LIVE;
  if (preview === true) return dispatch(() => true);
  return runFencedEmscripten({ context, isLive, dispatch: () => dispatch(isLive) });
}
