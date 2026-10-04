// Event-driven lifecycle for the NTP Tasks sidebar. Thread storage remains the
// authority; durable run snapshots are only the signal that the authoritative
// thread list may have changed.

/** The THREAD-VISIBLE state of one run: everything a sidebar row can show.
 *  Deliberately excludes run.revision, heartbeatAt and progress counters —
 *  durableRuns.heartbeat() and preToolUse() bump run.revision every ~5s while
 *  a run's phase, preview and terminal state (and therefore every row) stay
 *  identical, and keying on the revision turned each of those bumps into a
 *  thread.list fetch + full sidebar rebuild (the hydration storm). */
function threadRunSignature(run) {
  const terminal = run?.terminal && typeof run.terminal === "object" ? run.terminal : null;
  return [
    typeof run?.phase === "string" ? run.phase : "",
    typeof run?.threadId === "string" ? run.threadId : "",
    typeof run?.taskPreview === "string" ? run.taskPreview : "",
    terminal ? String(terminal.ok === true) : "",
    terminal ? String(terminal.cancelled === true) : "",
    typeof terminal?.summary === "string" ? terminal.summary : "",
  ].join(" ");
}

function threadRunSignatures(runs) {
  const signatures = new Map();
  for (const run of (Array.isArray(runs) ? runs : [])) {
    if (!run?.executionId || !Number.isFinite(run?.revision)) continue;
    // threadId is part of the SIGNATURE, not a filter: a threadless run (a
    // failed dispatch) still moves the observed state, so the render it
    // triggers refreshes the sections that project it (failed runs).
    signatures.set(run.executionId, threadRunSignature(run));
  }
  return signatures;
}

function signaturesChanged(previous, next) {
  if (previous.size !== next.size) return true;
  for (const [id, signature] of next) {
    if (previous.get(id) !== signature) return true;
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
  let observedRunSignatures = new Map();

  async function render(activeId = null, meta = null) {
    const owner = ++renderOwner;
    const response = await loadThreads().catch(() => null);
    if (owner !== renderOwner || !isAuthoritativeThreadList(response)) return false;
    commitThreads(response.threads, activeId, meta);
    return true;
  }

  async function onRunSnapshot(snapshot, activeId = null) {
    const next = threadRunSignatures(snapshot?.runs);
    if (!signaturesChanged(observedRunSignatures, next)) return false;
    // runsChanged tells the commit that a run-visible change caused this
    // render: the thread LIST may still be byte-identical (the thread write
    // can lag the run record), but the failed-runs/board sections must
    // re-read because the run state they project just moved.
    const rendered = await render(activeId, { runsChanged: true });
    if (!rendered) return false;
    // A run signature is acknowledged only with the successful authoritative
    // render that it invalidated. Failed or fenced reads remain retryable when
    // the durable registry repeats the same snapshot.
    observedRunSignatures = next;
    return true;
  }

  return { render, onRunSnapshot };
}
