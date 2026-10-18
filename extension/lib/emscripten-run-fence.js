// Model-run liveness is SW-owned, not a claim in the Emscripten message.
// A successful offscreen callback proves only native completion; cancellation
// and SW restart must leave it unpublished if the exact run is no longer live.

const RUN_ID_RE = /^exec:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const NOT_LIVE = Object.freeze({ ok: false, phase: "failed", error: "emscripten_run_not_live" });

export function isEmscriptenModelRunLive({
  runId, agentId, signal, active, cancelled, ended, workerRun,
} = {}) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId) ||
      typeof agentId !== "string" || !agentId || signal?.aborted ||
      cancelled?.has(runId) || ended?.has(runId)) return false;
  if (workerRun?.kind === "worker") {
    return workerRun.surface === `agent-worker:${agentId}`;
  }
  // Ordinary hub/named agent executions ALSO register in runControl with
  // kind "task"/"agent". Their authoritative liveness is activeExecutions.
  return active?.has(runId) === true;
}

// The caller supplies only a fresh SW-local liveness closure; neither the
// offscreen host nor a model-provided argument may assert a run is alive.
export async function runFencedEmscripten({ context, isLive, dispatch } = {}) {
  if (typeof isLive !== "function" || typeof dispatch !== "function" ||
      typeof context?.runId !== "string" || typeof context?.agentId !== "string" ||
      !isLive(context)) return NOT_LIVE;
  const result = await dispatch();
  return isLive(context) ? result : NOT_LIVE;
}
