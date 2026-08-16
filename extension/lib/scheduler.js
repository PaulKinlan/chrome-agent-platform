// lib/scheduler.js — the ONE atomic scheduling implementation. Both the
// `register-task` route and the `schedule_task` agent tool call into this, so
// validation, persistence, and alarm creation stay in a single place.

import { kvGet, kvSet } from "./kv.js";
import { assertRunAlive, assertRunOwned } from "./run-fence.js";

const TASK_KEY = "cap:scheduledTasks";
const INFLIGHT_KEY = "cap:scheduledInflight";

/** The chrome.alarms API when the OPTIONAL `alarms` permission is granted,
 * else null. Scheduling degrades gracefully to a clear error when absent. */
function alarmsApi() {
  try {
    return typeof chrome !== "undefined" && chrome.alarms ? chrome.alarms : null;
  } catch {
    return null;
  }
}

// A same-boot run is tracked IN MEMORY (the active-runs map below), never
// inferred from a persisted timestamp. The single-threaded MV3 service worker
// means a run still registered in this module's state is, by definition, live —
// so a later firing can never re-acquire it from heartbeat age alone. The
// persisted heartbeat exists ONLY as a storage-failure canary: if a heartbeat
// renewal write starts failing, the run aborts rather than commit side effects
// as a silently-degraded owner. INFLIGHT_LEASE_MS is retained for test aging
// (pushing a heartbeat far past any plausible window) + documents the
// historical bound; re-acquisition is governed by the active-runs map, not by
// timestamp arithmetic.
export const INFLIGHT_LEASE_MS = 5 * 60 * 1000;

// How often a live in-flight task renews its lock's heartbeat. A failed renewal
// (storage error) marks the run for abort at the next fence check.
export const INFLIGHT_HEARTBEAT_MS = 30 * 1000;

// In-memory map of LIVE runs in THIS worker boot: name -> { token, controller }.
// This is the authoritative same-boot fence — a run present here is alive and
// can NEVER be overlapped by a later alarm firing. The persisted lock fences
// ACROSS worker boots (a killed SW instance's lock is re-acquirable because the
// dead instance's run is gone; this map is empty on a fresh boot).
const activeRuns = new Map();

// This worker lifetime's boot instant (module-eval time). A persisted lock whose
// `at` predates this instant was acquired by a previous, now-dead worker instance.
let BOOT_AT = Date.now();

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

    // The abort must be re-checked at EVERY commit boundary, not just once at
    // the tool's start: an abort arriving DURING an await must prevent the
    // durable commit. The boundaries are: (1) before the first read, (2) after
    // the read + BEFORE the payload write (closes the read-abort crash window
    // — nothing is persisted, so no rollback is needed), (3) after the write +
    // before the IRREVERSIBLE alarm creation (roll back the payload), and
    // (4) after `alarms.create` resolves + before returning success (the
    // round-18 blocker reproduced an abort during `alarms.create` committing
    // the alarm + payload and returning ok).
    assertRunAlive();

    // Persist the task (inside the lock so the read-modify-write is atomic).
    const store = await kvGet(TASK_KEY);

    // Re-check the fence AFTER the read await but BEFORE the write: an abort
    // during the kvGet await must reject with NO payload persisted (the
    // round-17 crash-window finding: the old code wrote first, then rolled
    // back, leaving a window where a partial write could survive).
    await assertRunOwned();

    const tasks = { ...(store[TASK_KEY] ?? {}) };
    tasks[name] = { name, task, at: when, periodInMinutes, attachments };
    await kvSet({ [TASK_KEY]: tasks });

    // Re-check the fence before the IRREVERSIBLE alarm creation (a second abort
    // window exists between the persist and the alarm create). DUrable ownership
    // (not merely the signal) must be checked here — the round-21 finding that
    // this boundary used signal-only `runAborted()`, so a durable-ownership loss
    // after the payload write was not detected until the post-create check.
    try {
      await assertRunOwned();
    } catch {
      // Roll back the just-persisted payload so an aborted schedule leaves no
      // orphaned task behind.
      const cur = await kvGet(TASK_KEY);
      const rollback = { ...(cur[TASK_KEY] ?? {}) };
      delete rollback[name];
      await kvSet({ [TASK_KEY]: rollback });
      throw new Error("run aborted — task not scheduled");
    }

    // Create the alarm LAST. On failure, roll back the persisted task so it is
    // never orphaned.
    try {
      const alarms = alarmsApi();
      if (!alarms) {
        throw new Error(
          "alarms permission not granted — enable Scheduled tasks in Settings",
        );
      }
      const info = { when };
      if (periodInMinutes) info.periodInMinutes = periodInMinutes;
      await alarms.create(name, info);
      // Re-check the fence AFTER `alarms.create` resolves: an abort during the
      // await must roll back BOTH the now-created alarm AND the persisted
      // payload, and REJECT (never return ok) — the round-18 blocker.
      await assertRunOwned();
    } catch (e) {
      // Roll back the alarm (if it was created) AND the payload together.
      // `alarms.clear()` returning `false` is AMBIGUOUS: it means BOTH "clear
      // failed" AND "the alarm was already absent". For a FAILED schedule
      // (alarms.create rejected BEFORE creating an alarm), the alarm is absent
      // and the payload must be DELETED — a kept payload would be recreated +
      // rerun by reconcileScheduledTasks (the round-21 schedule-create-failure
      // replay blocker). For a periodic alarm whose clear FAILED, the alarm is
      // STILL present, so the payload must be KEPT for it to fire on (the
      // round-19 alarm-clear blocker). alarms.get disambiguates the two, but it
      // has a THIRD outcome — it can THROW (unknown state). Unknown must not be
      // treated as "absent" (that would keep a runnable payload that reconcile
      // later re-arms) nor as "present" blindly (that would also leave a runnable
      // payload). The round-22 blocker: create-throw + get-throw left a runnable
      // payload that a later boot recreated + ran. Unknown state must be
      // QUARANTINED (non-runnable) until the owner retries or cancels.
      let state = "unknown";
      try {
        await alarmsApi()?.clear(name);
        state = (await alarmsApi()?.get(name)) != null ? "present" : "absent";
      } catch {
        state = "unknown"; // cannot determine the alarm's state — fail closed
      }
      if (state === "absent") {
        // The alarm is confirmed gone → delete the payload (nothing to fire on).
        const cur = await kvGet(TASK_KEY);
        const rollback = { ...(cur[TASK_KEY] ?? {}) };
        delete rollback[name];
        await kvSet({ [TASK_KEY]: rollback });
      } else if (state === "unknown") {
        // QUARANTINE: mark the payload non-runnable so reconcileScheduledTasks
        // never re-arms a scheduling request that failed with unknown alarm state.
        // It is only ever re-runnable via an explicit owner retry (a fresh
        // scheduleTask creates a new name).
        const cur = await kvGet(TASK_KEY);
        const tasks = { ...(cur[TASK_KEY] ?? {}) };
        if (tasks[name]) {
          tasks[name] = { ...tasks[name], quarantined: true, quarantinedAt: Date.now() };
          await kvSet({ [TASK_KEY]: tasks });
        }
      }
      throw e;
    }
    return { name, when };
  });
}

/** List every persisted scheduled task (active AND quarantined) so the owner
 * can SEE a quarantined/failed schedule and retry or cancel it. The round-23
 * blocker required an owner-visible quarantine list — a quarantined task is
 * otherwise invisible and can never be cancelled. */
export async function listScheduledTasks() {
  await withLock(async () => {}); // serialize the read against concurrent writes
  const store = await kvGet(TASK_KEY);
  const tasks = store[TASK_KEY] ?? {};
  return Object.values(tasks).map((t) => ({
    name: t.name,
    task: t.task,
    at: t.at,
    periodInMinutes: t.periodInMinutes,
    quarantined: Boolean(t.quarantined),
    quarantinedAt: t.quarantinedAt ?? null,
  }));
}

/** Authoritatively CANCEL a scheduled task (an owner-visible route for a
 * quarantined or unwanted task). The round-23 blocker required "authoritative
 * cancel" for quarantined records: the alarm is cleared, absence is CONFIRMED
 * via alarms.get (a `clear` false is ambiguous), and the payload is removed
 * atomically under the scheduling lock. Returns whether the task is now gone. */
export async function cancelScheduledTask(name) {
  return withLock(async () => {
    const store = await kvGet(TASK_KEY);
    const tasks = { ...(store[TASK_KEY] ?? {}) };
    const existing = tasks[name];
    if (!existing) {
      return { ok: true, name, cancelled: false, error: "no such task" };
    }
    // Clear the alarm (best-effort — a one-shot may already be consumed), then
    // CONFIRM absence via alarms.get so a periodic alarm whose clear FAILED is
    // not silently left armed (the round-19/20 alarm-clear ambiguity).
    const alarms = alarmsApi();
    let alarmAbsent = true;
    if (alarms) {
      try {
        await alarms.clear(name);
      } catch { /* clear may throw if already gone; get() decides */ }
      try {
        alarmAbsent = (await alarms.get(name)) == null;
      } catch {
        alarmAbsent = false; // fail closed — cannot confirm absence
      }
    }
    delete tasks[name];
    await kvSet({ [TASK_KEY]: tasks });
    return { ok: true, name, cancelled: true, alarmAbsent };
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
      const inflightStore = await kvGet(INFLIGHT_KEY);
      const inflight = { ...(inflightStore[INFLIGHT_KEY] ?? {}) };
      const existing = inflight[name];
      if (!validLock(existing) || existing.token !== token) {
        throw new Error("ownership lost — scheduled task NOT removed");
      }
    }
    const store = await kvGet(TASK_KEY);
    const tasks = { ...(store[TASK_KEY] ?? {}) };
    delete tasks[name];
    // Clear the alarm, then AUTHORITATIVELY determine whether it still exists via
    // alarms.get — `clear` returning false is AMBIGUOUS: it means BOTH "clear
    // failed" AND "the alarm was already absent". For a COMPLETED one-shot the
    // alarm is legitimately GONE (Chrome consumed it when it fired), so the
    // payload must be DELETED — a kept payload would be recreated + rerun by
    // reconcileScheduledTasks (the round-20 one-shot replay blocker). For a
    // periodic alarm whose clear FAILED, the alarm is STILL present, so the
    // payload must be KEPT for it to fire on (the round-19 alarm-clear blocker).
    // alarms.get disambiguates: absent → delete payload; present → keep it.
    try {
      await alarmsApi()?.clear(name);
    } catch { /* clear may throw if the alarm is already gone; get() below decides */ }
    let stillArmed = true;
    try {
      stillArmed = (await alarmsApi()?.get(name)) != null;
    } catch {
      stillArmed = true; // fail closed — cannot confirm absence → keep the payload
    }
    // Re-verify the ownership fence at the DESTRUCTIVE commit (not just up front):
    // the token check above ran before the kvGet + clear awaits, so a
    // re-acquisition during those awaits must not let a stale owner delete a
    // later owner's payload (the round-20 durable-ownership-at-commit finding).
    if (token) {
      const inflightNow = await kvGet(INFLIGHT_KEY);
      const cur = inflightNow[INFLIGHT_KEY]?.[name];
      if (!validLock(cur) || cur.token !== token) {
        throw new Error("ownership lost — scheduled task NOT removed");
      }
    }
    if (!stillArmed) {
      await kvSet({ [TASK_KEY]: tasks });
    }
  });
}

/** In-flight lock so overlapping alarms / slow runs can't double-fire.
 * Returns { acquired: true, token, signal } on success or
 * { acquired: false, reason }. A live same-boot run (present in `activeRuns`)
 * is NEVER re-acquired — not even from heartbeat age. Only a persisted lock
 * whose owner is NOT live in this boot (a killed worker instance, or a run that
 * already released with a failed persist) is re-acquired with a FRESH token, so
 * a late release from a dead owner can never match. */
export async function tryAcquireInflight(name) {
  return withLock(async () => {
    // Authoritative same-boot fence: a run registered in this worker's memory
    // is alive, period. Heartbeat age can NEVER evict it (the round-13 blocker).
    if (activeRuns.has(name)) {
      return { acquired: false, reason: "running in this worker" };
    }
    const store = await kvGet(INFLIGHT_KEY);
    const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
    const existing = inflight[name];
    if (existing !== undefined && !validLock(existing)) {
      // A malformed lock can never be released by compare-and-release → block
      // (fail closed). Boot recovery clears it, never a later firing.
      return { acquired: false, reason: "malformed lock" };
    }
    // Any VALID persisted lock here belongs to a dead or already-released owner
    // (a live same-boot owner is caught by the activeRuns check above), so
    // re-acquiring with OUR token is safe — it never overlaps a running agent.
    const token = newToken();
    const controller = new AbortController();
    inflight[name] = { token, at: Date.now(), heartbeatAt: Date.now() };
    try {
      await kvSet({ [INFLIGHT_KEY]: inflight });
    } catch {
      return { acquired: false, reason: "persist failed" };
    }
    activeRuns.set(name, { token, controller });
    // Expose BOTH the signal (for listening) and the controller (for aborting)
    // — the heartbeat-failure path must call controller.abort() (an AbortSignal
    // has no `abort` method; that was the round-13 TypeError).
    return { acquired: true, token, signal: controller.signal, controller };
  });
}

/** Whether `token` still owns the in-flight lock for `name`. This is the
 * execution fence: a run checks it at every durable/destructive boundary so a
 * stale owner (whose lock was re-acquired) aborts before committing side
 * effects (journal writes, notifications, task deletion).
 *
 * The PERSISTED lock is the authority for ownership — not the in-memory map
 * alone. A same-boot run whose durable lock was lost (a storage failure or an
 * external deletion) no longer durably owns it, so the fence must abort rather
 * than commit side effects as a silently-degraded owner (the round-16 blocker). */
export async function ownsInflight(name, token) {
  // A same-boot run registered under a DIFFERENT token is a stale owner.
  const active = activeRuns.get(name);
  if (active && active.token !== token) return false;
  // Consult the persisted lock in EVERY case (live in-memory OR released): the
  // durable lock must still exist AND match the token. The in-memory map only
  // rules out a stale token faster; it never substitutes for durable ownership.
  const store = await kvGet(INFLIGHT_KEY);
  const existing = store[INFLIGHT_KEY]?.[name];
  return Boolean(validLock(existing) && existing.token === token);
}

/** Renew a live owner's heartbeat so a slow-but-alive run never looks stale.
 * FAILS CLOSED: a missing, malformed, or differently-owned persisted lock must
 * REJECT (never silently succeed) — otherwise the owner would keep committing
 * side effects without durable heartbeat proof (the round-16 blocker: a missing/
 * mismatched persisted heartbeat silently succeeded). */
export async function heartbeatInflight(name, token) {
  await withLock(async () => {
    const store = await kvGet(INFLIGHT_KEY);
    const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
    const existing = inflight[name];
    if (!validLock(existing) || existing.token !== token) {
      throw new Error(
        `durable heartbeat lock for "${name}" is missing or owned by another token — aborting run`,
      );
    }
    inflight[name] = { ...existing, heartbeatAt: Date.now() };
    await kvSet({ [INFLIGHT_KEY]: inflight });
  });
}

/** Compare-and-release: delete ONLY when the token matches. A stale owner
 * finishing late (after a re-acquisition) must NEVER delete the new owner's
 * lock — that was the exact stale-owner-unlock the reviewer reproduced. */
export async function releaseInflight(name, token) {
  await withLock(async () => {
    try {
      const store = await kvGet(INFLIGHT_KEY);
      const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
      const existing = inflight[name];
      if (validLock(existing) && existing.token === token) {
        delete inflight[name];
        await kvSet({ [INFLIGHT_KEY]: inflight });
      }
    } finally {
      // Same-boot: abort + drop the in-memory run REGARDLESS of the persisted
      // compare-and-release result (the run is ending either way). A failed
      // persist must never leave the active-runs map poisoned (the round-14
      // medium: a storage failure before activeRuns.delete blocked the task).
      const active = activeRuns.get(name);
      if (active && active.token === token) {
        try {
          active.controller.abort();
        } catch { /* already aborted */ }
        activeRuns.delete(name);
      }
    }
  });
}

/** Test hook (Deno unit tests): simulate a worker restart by clearing the
 * in-memory run map + advancing the boot instant, leaving the persisted lock
 * in place (as a killed worker would). */
export function __resetBootForTest() {
  activeRuns.clear();
  BOOT_AT = Date.now();
}

/**
 * Recover in-flight locks on worker boot — but ONLY entries acquired before
 * this worker's boot (a lock from a killed SW instance) and malformed entries
 * that can never be released by compare-and-release. A valid lock acquired
 * AFTER boot must never be cleared, or a slow run could be double-fired.
 */
export async function clearStaleInflight() {
  await withLock(async () => {
    const store = await kvGet(INFLIGHT_KEY);
    const inflight = { ...(store[INFLIGHT_KEY] ?? {}) };
    for (const name of Object.keys(inflight)) {
      const v = inflight[name];
      if (!validLock(v) || v.at < BOOT_AT) {
        delete inflight[name];
      }
    }
    await kvSet({ [INFLIGHT_KEY]: inflight });
  });
}

// One serialized, idempotent boot recovery: clear pre-boot locks + reconcile
// missing alarms. Multiple call sites (module eval + onStartup) are safe. A
// transient failure resets the promise so a later call RETRIES — it never
// permanently poisons recovery for the worker lifetime.
let bootRecoveryPromise = null;
let bootRecoveryTimer = null;
export function recoverOnBoot() {
  if (bootRecoveryPromise) return bootRecoveryPromise;
  // NOTE: clearStaleInflight + reconcileScheduledTasks each take the lock
  // themselves; do NOT wrap them in another withLock (nested lock = deadlock).
  bootRecoveryPromise = (async () => {
    await clearStaleInflight();
    return await reconcileScheduledTasks();
  })().catch((err) => {
    bootRecoveryPromise = null; // reset so a later call retries
    // Schedule an automatic retry (bounded) so a transient boot failure is not
    // left un-reconciled until an unrelated caller wakes the worker (the
    // round-13 medium: boot recovery had no scheduled retry).
    if (bootRecoveryTimer) clearTimeout(bootRecoveryTimer);
    bootRecoveryTimer = setTimeout(() => {
      bootRecoveryTimer = null;
      recoverOnBoot().catch(() => {});
    }, 30 * 1000);
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
  const store = await kvGet(TASK_KEY);
  const tasks = { ...(store[TASK_KEY] ?? {}) };
  const names = Object.keys(tasks);
  if (names.length === 0) return [];

  const alarms = alarmsApi();
  if (!alarms) return []; // alarms not granted — nothing to reconcile (graceful)
  const existing = new Set((await alarms.getAll()).map((a) => a.name));
  const resumed = [];
  const failed = [];
  const now = Date.now();
  for (const name of names) {
    const task = tasks[name];
    // A QUARANTINED task (a schedule that failed with UNKNOWN alarm state) must
    // NEVER be re-armed by reconciliation — it is non-runnable until the owner
    // explicitly retries (a fresh scheduleTask) or cancels (the round-22
    // unknown-state replay blocker: reconcile recreated + ran a failed schedule).
    if (task?.quarantined) continue;
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
        await alarms.create(name, info);
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
