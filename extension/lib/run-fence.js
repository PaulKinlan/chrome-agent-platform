// lib/run-fence.js — the current run's abort signal, shared by the SW, the
// browser tools, and the agent's delegation path.
//
// The service worker threads the current run's abort signal (heartbeat failure
// / ownership loss) into EVERY side-effecting tool so an aborted run cannot
// commit an irreversible side effect (open/navigate/close a tab, delegate a
// worker task). The SW sets the fence around orch.run() and clears it
// afterward; tools + delegate_task check `runAborted()` at the mutation
// boundary. This is the "propagate one run context to every side-effecting
// tool" requirement from the round-15 review (the cached orchestrator is
// shared, so the fence is a module singleton the SW swaps per run — combined
// with run serialization, only one run is ever active).

let fence = null;

export function setRunFence(f) {
  fence = f ?? null;
}

export function clearRunFence() {
  fence = null;
}

export function runAborted() {
  return Boolean(fence?.signal?.aborted);
}

export function runSignal() {
  return fence?.signal ?? null;
}
