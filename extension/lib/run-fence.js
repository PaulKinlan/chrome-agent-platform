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

/** Re-check the run fence and THROW when the run has been aborted. Tools call
 * this immediately BEFORE and AFTER every durable/destructive await — an abort
 * that lands DURING an awaited side effect (alarm create, OPFS write, tab
 * mutation) must prevent the commit AND the success return (the round-18
 * blocker: the fence was check-only, so an abort during `alarms.create` still
 * committed the alarm+payload and returned ok). */
export function assertRunAlive() {
  if (runAborted()) {
    throw new Error("run aborted");
  }
}

/** Re-check DUrable ownership (not merely the signal) at every commit boundary.
 * A scheduled run's fence carries `assertOwned` — the PERSISTED in-flight lock
 * check that aborts on heartbeat-renewal failure OR ownership loss (re-
 * acquisition by a later firing), even when the in-memory AbortSignal has not
 * fired yet (durable ownership can disappear up to 30s before the heartbeat
 * abort). Ad-hoc runs (no in-flight lock) fall back to the signal check.
 * Tools call this AFTER every durable await, before reporting success — the
 * round-19 blocker where `assertRunAlive` only read the module-global signal. */
export async function assertRunOwned() {
  if (fence?.assertOwned) {
    await fence.assertOwned();
  }
  assertRunAlive();
}
