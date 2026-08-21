// Event-driven reconciliation for an already-open owner thread. Durable run
// records are only the terminal signal; thread.get remains the sole projection
// authority. Each execution/revision is consumed once and delayed reads commit
// only while the same page-local surface owner still owns the same thread.

const TERMINAL_PHASES = new Set(["terminal", "cancelled"]);

export function createTerminalThreadProjectionLifecycle({
  loadThread,
  commitThread,
  getOpenOwnerThreadId,
  captureSurfaceOwner,
  ownsSurfaceOwner,
}) {
  const observedTerminalRevisions = new Map();

  async function refresh(run, threadId) {
    const owner = captureSurfaceOwner();
    const response = await loadThread(threadId).catch(() => ({ ok: false }));
    if (!ownsSurfaceOwner(owner) || getOpenOwnerThreadId() !== threadId) return false;
    const thread = response?.ok === true ? response.thread : null;
    if (!thread || thread.id !== threadId) return false;
    commitThread(thread, run);
    return true;
  }

  function onRunSnapshot(snapshot) {
    const openThreadId = getOpenOwnerThreadId();
    const jobs = [];
    for (const run of (Array.isArray(snapshot?.runs) ? snapshot.runs : [])) {
      if (!run?.executionId || !run?.threadId || !Number.isFinite(run?.revision)) continue;
      if (!TERMINAL_PHASES.has(run.phase)) continue;

      const duplicate = observedTerminalRevisions.get(run.executionId) === run.revision;
      observedTerminalRevisions.set(run.executionId, run.revision);
      if (!duplicate && openThreadId && run.threadId === openThreadId) {
        jobs.push(refresh(run, openThreadId));
      }
    }
    if (!jobs.length) return Promise.resolve(false);
    return Promise.all(jobs).then((results) => results.some(Boolean));
  }

  return Object.freeze({ onRunSnapshot });
}
