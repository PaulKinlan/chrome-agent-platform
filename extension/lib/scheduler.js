// lib/scheduler.js — the ONE atomic scheduling implementation. Both the
// `register-task` route and the `schedule_task` agent tool call into this, so
// validation, persistence, and alarm creation stay in a single place.

const TASK_KEY = "cap:scheduledTasks";
const INFLIGHT_KEY = "cap:scheduledInflight";

// A bounded in-flight lease. A hung task (e.g. a provider call that never
// settles) must not block its alarm FOREVER — after this window a lock whose
// owner has STOPPED HEARTBEATING is considered stale and a later firing can
// re-acquire it. Timeout ALONE never permits re-acquisition: a live owner
// heartbeats well inside the lease, so a live-but-slow run stays "fresh" and
// blocks the next firing (never overlaps side-effecting agents).
export const INFLIGHT_LEASE_MS = 5 * 60 * 1000;

// How often a live in-flight task renews its lock's heartbeat. Well inside the
// lease so a healthy owner can never be mistaken for a dead one.
export const INFLIGHT_HEARTBEAT_MS = 30 * 1000;

let lockSeq = 0;
function newToken() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `lock_${Date.now()}_${Math.random().toString(36).slice(2)}_${lockSeq++}`;
}

/** A lock value is well-formed only if it carries a unique owner token + finite
 * `at` + `heartbeatAt` timestamps. Anything else is malformed and can never be
 * released by compare-and-release → it blocks (fail closed) until boot clears it.
 * `at` must be finite too: clearStaleInflight trusts v.at < BOOT_AT, so a missing
 * or non-finite `at` must never pass validation and be cleared as "pre-boot". */
function validLock(v) {
  return Boolean(
    v && typeof v === "object" &&
      typeof v.token === "string" && v.token.length > 0 &&
      typeof v.at === "number" && Number.isFinite(v.at) &&
      typeof v.heartbeatAt === "number" && Number.isFinite(v.heartbeatAt),
  );
}

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

/** Remove a one-shot task only AFTER its result is committed (durable).
 * When a `token` is supplied, the removal is FENCED: it proceeds only if the
 * caller still owns the in-flight lock. A stale owner (whose lock was
 * re-acquired after its heartbeat lapsed) must NOT delete a later owner's
 * scheduled payload/alarm. */
export async function markScheduledDone(name, token) {
  await withLock(async () => {
    if (token) {
      const inflightStore = await chrome.storage.local.get(INFLIGHT_KEY);
      const inflight = { ...(inflightStore[INFLIGHT_KEY] ?? {}) };
      const existing = inflight[name];
      if (!validLock(existing) || existing.token !== token) {
        throw new Error("ownership lost — scheduled task NOT removed");
      }
    }
    const store = await chrome.storage.local.get(TASK_KEY);
    const tasks = { ...(store[TASK_KEY] ?? {}) };
    delete tasks[name];
    await chrome.storage.local.set({ [TASK_KEY]: tasks });
    await chrome.alarms.clear(name).catch(() => {});
  });
}

/** In-flight lock so overlapping alarms / slow runs can't double-fire.
 * Returns { acquired: true, token } on success or { acquired: false, reason }.
 * Ownership is FENCED by a unique token; a stale lock is re-acquired ONLY when
 * the prior owner has demonstrably stopped heartbeating for the FULL lease
 * (i.e. it is dead) — timeout alone never lets two agents overlap. */
export async function tryAcquireInflight(name) {
  return withLock(async () => {
    const store = await chrome.storage.local.get(INFLIGHT_KEY);
    const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
    const now = Date.now();
    const existing = inflight[name];
    if (existing !== undefined) {
      if (!validLock(existing)) {
        // A malformed lock can never be released by compare-and-release → block
        // (fail closed). Boot recovery clears it, never a later firing.
        return { acquired: false, reason: "malformed lock" };
      }
      // A fresh heartbeat means the owner is alive → block (NEVER overlap).
      if (now - existing.heartbeatAt <= INFLIGHT_LEASE_MS) {
        return { acquired: false, reason: "in flight" };
      }
      // Stale: the owner went silent for the full lease → it is dead. Replace
      // with OUR token so a late release from the (dead) owner can never match.
    }
    const token = newToken();
    inflight[name] = { token, at: now, heartbeatAt: now };
    await chrome.storage.local.set({ [INFLIGHT_KEY]: inflight });
    return { acquired: true, token };
  });
}

/** Whether `token` still owns the in-flight lock for `name`. This is the
 * execution fence: a run checks it at every durable/destructive boundary so a
 * stale owner (whose lock was re-acquired) aborts before committing side
 * effects (journal writes, notifications, task deletion). */
export async function ownsInflight(name, token) {
  const store = await chrome.storage.local.get(INFLIGHT_KEY);
  const existing = store[INFLIGHT_KEY]?.[name];
  return Boolean(validLock(existing) && existing.token === token);
}

/** Renew a live owner's heartbeat so a slow-but-alive run never looks stale. */
export async function heartbeatInflight(name, token) {
  await withLock(async () => {
    const store = await chrome.storage.local.get(INFLIGHT_KEY);
    const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
    const existing = inflight[name];
    if (validLock(existing) && existing.token === token) {
      inflight[name] = { ...existing, heartbeatAt: Date.now() };
      await chrome.storage.local.set({ [INFLIGHT_KEY]: inflight });
    }
  });
}

/** Compare-and-release: delete ONLY when the token matches. A stale owner
 * finishing late (after a re-acquisition) must NEVER delete the new owner's
 * lock — that was the exact stale-owner-unlock the reviewer reproduced. */
export async function releaseInflight(name, token) {
  await withLock(async () => {
    const store = await chrome.storage.local.get(INFLIGHT_KEY);
    const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
    const existing = inflight[name];
    if (validLock(existing) && existing.token === token) {
      delete inflight[name];
      await chrome.storage.local.set({ [INFLIGHT_KEY]: inflight });
    }
  });
}

const BOOT_AT = Date.now(); // this worker lifetime's boot instant

/**
 * Recover in-flight locks on worker boot — but ONLY entries acquired before
 * this worker's boot (a lock from a killed SW instance) and malformed entries
 * that can never be released by compare-and-release. A valid lock acquired
 * AFTER boot must never be cleared, or a slow run could be double-fired.
 */
export async function clearStaleInflight() {
  await withLock(async () => {
    const store = await chrome.storage.local.get(INFLIGHT_KEY);
    const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
    for (const name of Object.keys(inflight)) {
      const v = inflight[name];
      if (!validLock(v) || v.at < BOOT_AT) {
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
  // Serialize the read-modify-write against scheduleTask/markScheduledDone so
  // a recovery pass can never recreate an alarm whose payload was just deleted
  // (the round-11 race: snapshot outside the mutex, delete inside it).
  return withLock(async () => {
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
  });
}
