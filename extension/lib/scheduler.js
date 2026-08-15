// lib/scheduler.js — the ONE atomic scheduling implementation. Both the
// `register-task` route and the `schedule_task` agent tool call into this, so
// validation, persistence, and alarm creation stay in a single place.

const TASK_KEY = "cap:scheduledTasks";
const INFLIGHT_KEY = "cap:scheduledInflight";

/** Validate timing FIRST, then persist, then create the alarm (atomic order). */
export async function scheduleTask({ task, at, delayMs, periodInMinutes, attachments = [] }) {
  // Resolve `when` before any persistence so a bad time can't orphan a stored task.
  let when;
  if (typeof at === "number" && Number.isFinite(at) && at > Date.now()) {
    when = at; // absolute epoch-ms
  } else if (typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0) {
    when = Date.now() + delayMs; // relative delay
  } else {
    throw new Error("task needs a future `at` (absolute ms) or a positive `delayMs`");
  }
  const name = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const store = await chrome.storage.local.get(TASK_KEY);
  const tasks = store[TASK_KEY] ?? {};
  tasks[name] = { name, task, at: when, periodInMinutes, attachments };
  await chrome.storage.local.set({ [TASK_KEY]: tasks });

  const info = { when };
  if (periodInMinutes) info.periodInMinutes = periodInMinutes;
  await chrome.alarms.create(name, info); // awaited — a failed create must not leave the task orphaned
  return name;
}

/** Remove a one-shot task only AFTER its result is committed (durable). */
export async function markScheduledDone(name) {
  const store = await chrome.storage.local.get(TASK_KEY);
  const tasks = { ...(store[TASK_KEY] ?? {}) };
  delete tasks[name];
  await chrome.storage.local.set({ [TASK_KEY]: tasks });
  await chrome.alarms.clear(name).catch(() => {});
}

/** In-flight lock so overlapping alarms / slow runs can't double-fire. */
export async function tryAcquireInflight(name) {
  const store = await chrome.storage.local.get(INFLIGHT_KEY);
  const inflight = store[INFLIGHT_KEY] ?? {};
  if (inflight[name]) return false;
  inflight[name] = Date.now();
  await chrome.storage.local.set({ [INFLIGHT_KEY]: inflight });
  return true;
}

export async function releaseInflight(name) {
  const store = await chrome.storage.local.get(INFLIGHT_KEY);
  const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
  delete inflight[name];
  await chrome.storage.local.set({ [INFLIGHT_KEY]: inflight });
}

/** Recover stale in-flight entries on worker restart (clear any that predate this boot). */
export async function clearStaleInflight(bootTime = Date.now()) {
  const store = await chrome.storage.local.get(INFLIGHT_KEY);
  const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
  let changed = false;
  for (const [name, ts] of Object.entries(inflight)) {
    if (typeof ts === "number" && ts < bootTime - 10 * 60 * 1000) {
      delete inflight[name];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [INFLIGHT_KEY]: inflight });
}
