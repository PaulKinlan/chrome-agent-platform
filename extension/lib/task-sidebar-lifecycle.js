// Event-driven lifecycle for the NTP Tasks sidebar. Thread storage remains the
// authority; durable run snapshots are only the signal that the authoritative
// thread list may have changed.

function threadRunRevisions(runs) {
  const revisions = new Map();
  for (const run of (Array.isArray(runs) ? runs : [])) {
    if (!run?.threadId || !run?.executionId || !Number.isFinite(run?.revision)) continue;
    revisions.set(run.executionId, run.revision);
  }
  return revisions;
}

function revisionsChanged(previous, next) {
  if (previous.size !== next.size) return true;
  for (const [id, revision] of next) {
    if (previous.get(id) !== revision) return true;
  }
  return false;
}

function isAuthoritativeThreadList(response) {
  return Array.isArray(response?.threads);
}

/**
 * Give one thread-list read a single MV3 restart grace period. A valid empty
 * list is authoritative and never retried; a rejection or malformed response
 * gets exactly one further read after the caller-provided bounded delay.
 */
export async function loadThreadsWithOneRestartRetry(loadThreads, waitForRestart) {
  const first = await loadThreads().catch(() => null);
  if (isAuthoritativeThreadList(first)) return first;
  await waitForRestart();
  return loadThreads();
}

/**
 * Bind durable thread-run events to authoritative thread-list rendering.
 * Each render gets a monotonic page-local owner token so a delayed older
 * thread.list response can never replace a newer sidebar state.
 */
export function createTaskSidebarLifecycle({ loadThreads, commitThreads }) {
  let renderOwner = 0;
  let observedRunRevisions = new Map();

  async function render(activeId = null) {
    const owner = ++renderOwner;
    const response = await loadThreads().catch(() => null);
    if (owner !== renderOwner || !isAuthoritativeThreadList(response)) return false;
    commitThreads(response.threads, activeId);
    return true;
  }

  async function onRunSnapshot(snapshot, activeId = null) {
    const next = threadRunRevisions(snapshot?.runs);
    if (!revisionsChanged(observedRunRevisions, next)) return false;
    const rendered = await render(activeId);
    if (!rendered) return false;
    // A run revision is acknowledged only with the successful authoritative
    // render that it invalidated. Failed or fenced reads remain retryable when
    // the durable registry repeats the same snapshot.
    observedRunRevisions = next;
    return true;
  }

  return { render, onRunSnapshot };
}
