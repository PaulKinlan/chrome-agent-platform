// lib/scheduler.js — the ONE atomic scheduling implementation. Both the
// `register-task` route and the `schedule_task` agent tool call into this, so
// validation, persistence, and alarm creation stay in a single place.

const TASK_KEY = "cap:scheduledTasks";
const INFLIGHT_KEY = "cap:scheduledInflight";

// A per-module promise mutex serializes the read-modify-write on the task store
// and the in-flight map, so concurrent schedules/acquisitions cannot lose an
// update or both acquire the same one-shot.
let mutex = Promise.resolve();
function withLock(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.then(() => {}, () => {});
  return run;
}

export const SCHEDULED_TASK_KEY = TASK_KEY;

/** Validate timing FIRST, then persist, then create the alarm (atomic order). */
export async function scheduleTask(
  { task, at, delayMs, periodInMinutes, attachments = [] },
) {
  return withLock(async () => {
    // Resolve `when` before any persistence so a bad time can't orphan a stored task.
    let when;
    if (typeof at === "number" && Number.isFinite(at) && at > Date.now()) {
      when = at; // absolute epoch-ms
    } else if (
      typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0
    ) {
      when = Date.now() + delayMs; // relative delay
    } else {
      throw new Error(
        "task needs a future `at` (absolute ms) or a positive `delayMs`",
      );
    }
    const name = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Persist the task (inside the lock so the read-modify-write is atomic).
    const store = await chrome.storage.local.get(TASK_KEY);
    const tasks = { ...(store[TASK_KEY] ?? {}) };
    tasks[name] = { name, task, at: when, periodInMinutes, attachments };
    await chrome.storage.local.set({ [TASK_KEY]: tasks });

    // Create the alarm LAST. On failure, roll back the persisted task so it is
    // never orphaned.
    try {
      const info = { when };
      if (periodInMinutes) info.periodInMinutes = periodInMinutes;
      await chrome.alarms.create(name, info);
    } catch (e) {
      const cur = await chrome.storage.local.get(TASK_KEY);
      const rollback = { ...(cur[TASK_KEY] ?? {}) };
      delete rollback[name];
      await chrome.storage.local.set({ [TASK_KEY]: rollback });
      throw e;
    }
    return { name, when };
  });
}

/** Remove a one-shot task only AFTER its result is committed (durable). */
export async function markScheduledDone(name) {
  await withLock(async () => {
    const store = await chrome.storage.local.get(TASK_KEY);
    const tasks = { ...(store[TASK_KEY] ?? {}) };
    delete tasks[name];
    await chrome.storage.local.set({ [TASK_KEY]: tasks });
    await chrome.alarms.clear(name).catch(() => {});
  });
}

/** In-flight lock so overlapping alarms / slow runs can't double-fire. */
export async function tryAcquireInflight(name) {
  return withLock(async () => {
    const store = await chrome.storage.local.get(INFLIGHT_KEY);
    const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
    if (inflight[name]) return false;
    inflight[name] = Date.now();
    await chrome.storage.local.set({ [INFLIGHT_KEY]: inflight });
    return true;
  });
}

export async function releaseInflight(name) {
  await withLock(async () => {
    const store = await chrome.storage.local.get(INFLIGHT_KEY);
    const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
    delete inflight[name];
    await chrome.storage.local.set({ [INFLIGHT_KEY]: inflight });
  });
}

/**
 * Recover in-flight locks on worker boot. A fresh worker lifetime means NO
 * prior run is still in flight — every entry is stale. Clear them all (not just
 * entries older than a window), so a quick restart never stays blocked.
 */
export async function clearStaleInflight() {
  await withLock(async () => {
    const store = await chrome.storage.local.get(INFLIGHT_KEY);
    const inflight = store[INFLIGHT_KEY];
    if (inflight && Object.keys(inflight).length > 0) {
      await chrome.storage.local.set({ [INFLIGHT_KEY]: {} });
    }
  });
}

/**
 * Reconcile persisted tasks against the browser's actual alarms on startup.
 * A one-shot alarm is consumed by Chrome when it fires; if the worker died
 * before runTask committed a result, the persisted payload remains but the
 * alarm is gone. Recreate missing alarms + resume due one-shots.
 */
export async function reconcileScheduledTasks() {
  const store = await chrome.storage.local.get(TASK_KEY);
  const tasks = { ...(store[TASK_KEY] ?? {}) };
  const names = Object.keys(tasks);
  if (names.length === 0) return [];

  const existing = new Set((await chrome.alarms.getAll()).map((a) => a.name));
  const resumed = [];
  const now = Date.now();
  for (const name of names) {
    const task = tasks[name];
    if (!existing.has(name)) {
      // The alarm is missing (fired + consumed, or the worker restarted). Recreate
      // it if the task is still in the future; a past one-shot is resumable.
      const when = task.periodInMinutes
        ? Math.max(task.at, now + 1000) // periodic: next tick
        : (task.at > now ? task.at : now + 1000); // one-shot: fire soon, then resume
      const info = { when };
      if (task.periodInMinutes) info.periodInMinutes = task.periodInMinutes;
      await chrome.alarms.create(name, info).catch(() => {});
      resumed.push(name);
    }
  }
  return resumed;
}
