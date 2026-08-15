// lib/scheduler.js — the ONE atomic scheduling implementation. Both the
// `register-task` route and the `schedule_task` agent tool call into this, so
// validation, persistence, and alarm creation stay in a single place.

const TASK_KEY = "cap:scheduledTasks";
const INFLIGHT_KEY = "cap:scheduledInflight";

// A bounded in-flight lease. A hung task (e.g. a provider call that never
// settles) must not block its alarm FOREVER — after this window the lock is
// considered stale and a later firing can re-acquire it.
const INFLIGHT_LEASE_MS = 5 * 60 * 1000;

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
    const now = Date.now();
    const existing = inflight[name];
    if (existing !== undefined) {
      // A numeric lock older than the lease is stale → re-acquire. A fresh
      // numeric lock (still within the lease) OR a malformed non-numeric lock
      // (which can never be released) blocks acquisition — fail closed.
      if (
        typeof existing === "number" && Number.isFinite(existing) &&
        now - existing > INFLIGHT_LEASE_MS
      ) {
        delete inflight[name];
      } else {
        return false;
      }
    }
    inflight[name] = now;
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

const BOOT_AT = Date.now(); // this worker lifetime's boot instant

/**
 * Recover in-flight locks on worker boot — but ONLY entries acquired before
 * this worker's boot. A live lock acquired AFTER boot (by a task that started
 * this lifetime) must never be cleared, or a slow run could be double-fired.
 */
export async function clearStaleInflight() {
  await withLock(async () => {
    const store = await chrome.storage.local.get(INFLIGHT_KEY);
    const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
    for (const name of Object.keys(inflight)) {
      const v = inflight[name];
      // Clear entries acquired BEFORE this boot (numeric, older than BOOT_AT)
      // AND malformed entries (non-numeric / non-finite) that can never be
      // released by a releaseInflight call. A live lock acquired AFTER boot
      // (numeric, >= BOOT_AT) must never be cleared (else a slow run double-fires).
      if (typeof v !== "number" || !Number.isFinite(v) || v < BOOT_AT) {
        delete inflight[name];
      }
    }
    await chrome.storage.local.set({ [INFLIGHT_KEY]: inflight });
  });
}

// One serialized, idempotent boot recovery: clear pre-boot locks + reconcile
// missing alarms. Multiple call sites (module eval + onStartup) are safe. A
// transient failure resets the promise so a later call RETRIES — it never
// permanently poisons recovery for the worker lifetime.
let bootRecoveryPromise = null;
export function recoverOnBoot() {
  if (bootRecoveryPromise) return bootRecoveryPromise;
  // NOTE: clearStaleInflight + reconcileScheduledTasks each take the lock
  // themselves; do NOT wrap them in another withLock (nested lock = deadlock).
  bootRecoveryPromise = (async () => {
    await clearStaleInflight();
    return await reconcileScheduledTasks();
  })().catch((err) => {
    bootRecoveryPromise = null; // reset so a later call retries
    throw err;
  });
  return bootRecoveryPromise;
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
  const failed = [];
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
      // Only record `resumed` when the alarm was ACTUALLY (re)created; a failed
      // create is surfaced, never silently claimed as resumed.
      try {
        await chrome.alarms.create(name, info);
        resumed.push(name);
      } catch (err) {
        failed.push(name);
        console.error(
          `reconcile: failed to recreate alarm "${name}":`,
          err?.message ?? err,
        );
      }
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `reconcile: failed to recreate ${failed.length} alarm(s): ${failed.join(", ")}`,
    );
  }
  return resumed;
}
