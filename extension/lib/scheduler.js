// lib/scheduler.js — the ONE atomic scheduling implementation. Both the
// `register-task` route and the `schedule_task` agent tool call into this, so
// validation, persistence, and alarm creation stay in a single place.

import { kvGet, kvSet } from "./kv.js";
import { assertRunAlive, assertRunOwned } from "./run-fence.js";

const TASK_KEY = "cap:scheduledTasks";
const INFLIGHT_KEY = "cap:scheduledInflight";

// Chrome permits at most 500 active alarms per extension. This is an alarm API
// capacity, not an OPFS/memory key ceiling; owner memory remains byte-bounded.
export const MAX_ACTIVE_ALARMS = 500;

// The owning run's surface attribution, persisted with the payload so the
// FIRED run can be attributed back to the agent/thread that scheduled it
// (CAP-FB-20260826 scheduled-run visibility). Bounded so a caller can never
// grow the payload without limit; unknown/non-string fields normalize away.
const OWNER_ATTRIB_MAX = 200;
function boundedOwner(owner) {
  if (!owner || typeof owner !== "object") return null;
  const bound = (v) => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t ? t.slice(0, OWNER_ATTRIB_MAX) : null;
  };
  const threadId = bound(owner.threadId);
  const agentRole = bound(owner.agentRole);
  const agentSurfaceRef = bound(owner.agentSurfaceRef);
  if (!threadId && !agentRole && !agentSurfaceRef) return null;
  return {
    ...(threadId ? { threadId } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(agentSurfaceRef ? { agentSurfaceRef } : {}),
  };
}

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

// How long `cancelScheduledTask` waits for an acquired run to acknowledge
// TERMINATION (releaseInflight) before reporting the cancel as still-pending +
// retryable. Cancel must not report success while a still-settling agent could
// commit side effects (the round-26 blocker).
export const CANCEL_TERMINATION_TIMEOUT_MS = 5000;

/**
 * Structured diagnostic record formatter for scheduler and alarm lifecycle events.
 * Emits clean, bounded, secret-free structured JSON logs (CAP-FB-20260824-SCHED-DIAGNOSTICS-01).
 */
export function formatSchedulerDiagnostic({
  event,
  alarmName,
  taskId = null,
  executionId = null,
  path = "scheduler",
  storeState = "unknown",
  reason = "",
  actionTaken = "none",
  details = null,
}) {
  return {
    tag: "[scheduler:diagnostic]",
    event: String(event ?? "unknown"),
    alarmName: String(alarmName ?? ""),
    taskId: taskId ? String(taskId) : String(alarmName ?? ""),
    executionId: executionId ? String(executionId) : null,
    path: String(path ?? "scheduler"),
    storeState: String(storeState ?? "unknown"),
    expectedPayloadShape: "{ task?: string, periodInMinutes?: number, scriptId?: string, attachments?: array }",
    reason: String(reason ?? ""),
    actionTaken: String(actionTaken ?? "none"),
    ...(details && typeof details === "object" ? { details } : {}),
    ts: Date.now(),
  };
}

export function logSchedulerDiagnostic(diag, level = "error") {
  const record = formatSchedulerDiagnostic(diag);
  const jsonStr = JSON.stringify(record);
  try {
    if (level === "warn") {
      console.warn(`${record.tag} ${jsonStr}`);
    } else {
      console.error(`${record.tag} ${jsonStr}`);
    }
  } catch {
    /* never throw from diagnostic logger */
  }
  return record;
}

// In-memory map of LIVE runs in THIS worker boot: name -> { token, controller }.
// This is the authoritative same-boot fence — a run present here is alive and
// can NEVER be overlapped by a later alarm firing. The persisted lock fences
// ACROSS worker boots (a killed SW instance's lock is re-acquirable because the
// dead instance's run is gone; this map is empty on a fresh boot). Owned in
// this module's closure — no exported map/setter/reset API (the test harness
// re-imports a FRESH module instance for a simulated worker restart).
const activeRuns = new Map();
// This worker lifetime's boot instant (module-eval time). A persisted lock whose
// `at` predates this instant was acquired by a previous, now-dead worker instance.
const BOOT_AT = Date.now();

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
  { task, at, delayMs, periodInMinutes, attachments = [], name: explicitName, scriptId, owner = null },
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
    const name = explicitName ??
      `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // The abort must be re-checked at EVERY commit boundary, not just once at
    // the tool's start: an abort arriving DURING an await must prevent the
    // durable commit.
    assertRunAlive();

    const alarms = alarmsApi();
    if (!alarms) {
      throw new Error(
        "alarms permission not granted — enable Scheduled tasks in Settings",
      );
    }
    // Fail before persistence when Chrome's extension-wide alarm capacity is
    // exhausted. Replacing the same alarm name consumes no additional slot.
    const activeAlarms = await alarms.getAll();
    await assertRunOwned();
    const replacing = activeAlarms.some((alarm) => alarm?.name === name);
    if (!replacing && activeAlarms.length >= MAX_ACTIVE_ALARMS) {
      logSchedulerDiagnostic({
        event: "schedule_capacity_exceeded",
        alarmName: name,
        path: "scheduler:scheduleTask",
        storeState: "capacity_exceeded",
        reason: `Chrome allows at most ${MAX_ACTIVE_ALARMS} active alarms per extension`,
        actionTaken: "schedule_refused",
      }, "error");
      throw new Error(
        `Chrome allows at most ${MAX_ACTIVE_ALARMS} active alarms per extension — cancel an existing scheduled task before adding another`,
      );
    }

    // Persist the canonical task payload only after timing, permission, alarm
    // capacity, and run ownership are known valid.
    const store = await kvGet(TASK_KEY);

    // Re-check the fence AFTER the read await but BEFORE the write: an abort
    // during the kvGet await must reject with NO payload persisted (the
    // round-17 crash-window finding: the old code wrote first, then rolled
    // back, leaving a window where a partial write could survive).
    await assertRunOwned();

    const tasks = { ...(store[TASK_KEY] ?? {}) };
    const boundedScheduleOwner = boundedOwner(owner);
    tasks[name] = { name, task, at: when, periodInMinutes, attachments, ...(scriptId ? { scriptId } : {}), ...(boundedScheduleOwner ? { owner: boundedScheduleOwner } : {}) };
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

/** Disarm only alarms backed by the canonical cap:scheduledTasks authority.
 * Payloads remain untouched so an explicit future grant can re-arm them during
 * ordinary boot reconciliation. Used before owner-driven permission removal. */
export async function disarmScheduledAlarms() {
  return withLock(async () => {
    const store = await kvGet(TASK_KEY);
    const names = Object.keys(store[TASK_KEY] ?? {});
    const alarms = alarmsApi();
    if (!alarms) {
      return { ok: true, disarmed: 0, retained: names.length, apiAvailable: false };
    }
    const failed = [];
    let disarmed = 0;
    for (const name of names) {
      try {
        await alarms.clear(name);
        const stillArmed = await alarms.get(name);
        if (stillArmed != null) failed.push(name);
        else disarmed += 1;
      } catch {
        failed.push(name);
      }
    }
    if (failed.length > 0) {
      return {
        ok: false,
        disarmed,
        retained: names.length,
        failed,
        retryable: true,
        error: `${failed.length} scheduled alarm(s) could not be confirmed disarmed`,
      };
    }
    return { ok: true, disarmed, retained: names.length, apiAvailable: true };
  });
}

/** List every persisted scheduled task (active AND quarantined) so the owner
 * can SEE a quarantined/failed schedule and retry or cancel it. The round-23
 * blocker required an owner-visible quarantine list — a quarantined task is
 * otherwise invisible and can never be cancelled. */
export async function listScheduledTasks() {
  // Serialize the read INSIDE the scheduling lock so a concurrent schedule/cancel
  // cannot interleave with the snapshot (the list must be atomic w.r.t. writes).
  return withLock(async () => {
    const store = await kvGet(TASK_KEY);
    const tasks = store[TASK_KEY] ?? {};
    // nextFireAt: the LIVE alarm's scheduledTime when one is armed; a paused,
    // quarantined, cancelling, or storage-blocked task has NO next fire.
    const alarms = alarmsApi();
    const liveFire = new Map();
    if (alarms) {
      try {
        for (const a of await alarms.getAll()) {
          if (a?.name && typeof a.scheduledTime === "number") liveFire.set(a.name, a.scheduledTime);
        }
      } catch { /* alarms API hiccup — nextFireAt stays null */ }
    }
    return Object.values(tasks).map((t) => ({
      name: t.name,
      task: t.task,
      at: t.at,
      periodInMinutes: t.periodInMinutes,
      // Pause state (the owner-facing pause/resume feature): a paused task
      // holds its full schedule metadata but is disarmed + never fires.
      paused: Boolean(t.paused),
      pausedAt: t.pausedAt ?? null,
      nextFireAt: (t.paused || t.quarantined || t.cancelling || t.storageBlocked)
        ? null
        : (liveFire.get(t.name) ?? null),
      // The owning agent/thread (when the task was scheduled from inside an
      // agent run) — surfaced so the owner can see WHICH agent a scheduled
      // task belongs to.
      owner: t.owner ?? null,
      quarantined: Boolean(t.quarantined),
      quarantinedAt: t.quarantinedAt ?? null,
      cancelling: Boolean(t.cancelling),
      cancellingAt: t.cancellingAt ?? null,
      storageBlocked: Boolean(t.storageBlocked),
      storageBlockedAt: t.storageBlockedAt ?? null,
      storageError: t.storageError ?? null,
      remediation: t.storageBlocked
        ? "Execution storage was full. Retry now that retained run data has been isolated, or cancel this task."
        : null,
    }));
  });
}

/** Stop a quota-failing alarm from flooding every tick. The task stays visible
 * and owner-controlled; no task, journal, run, or memory data is evicted. */
export async function blockScheduledTaskForStorage(name, error) {
  return withLock(async () => {
    const store = await kvGet(TASK_KEY);
    const tasks = { ...(store[TASK_KEY] ?? {}) };
    const task = tasks[name];
    if (!task) return { ok: false, name, error: "no such task" };
    if (task.storageBlocked) {
      return { ok: true, name, blocked: true, newlyBlocked: false, alarmAbsent: null };
    }
    const newlyBlocked = true;
    tasks[name] = {
      ...task,
      storageBlocked: true,
      storageBlockedAt: Date.now(),
      storageError: {
        code: "memory_key_count_bound",
        message: "Execution storage reached its safe key limit. No owner data was removed.",
      },
    };
    await kvSet({ [TASK_KEY]: tasks });
    const alarms = alarmsApi();
    let alarmAbsent = true;
    if (alarms) {
      try { await alarms.clear(name); } catch { /* get below is authority */ }
      try { alarmAbsent = (await alarms.get(name)) == null; } catch { alarmAbsent = false; }
    }
    return { ok: true, name, blocked: true, newlyBlocked, alarmAbsent };
  });
}

/** Explicit owner retry for a storage-blocked schedule. Reuses the same logical
 * name/configuration but creates a fresh alarm after clearing blocked state. */
export async function retryScheduledTask(name, { expectedOwner } = {}) {
  const task = await withLock(async () => {
    const store = await kvGet(TASK_KEY);
    const found = structuredClone(store[TASK_KEY]?.[name] ?? null);
    if (found) {
      const scopeError = assertOwnerScope(found, expectedOwner);
      if (scopeError) return { scopeError };
    }
    return found;
  });
  if (!task) return { ok: false, name, error: "no such task" };
  if (task.scopeError) return { ok: false, name, error: task.scopeError };
  if (!task.storageBlocked && !task.quarantined) {
    return { ok: false, name, error: "task is not blocked" };
  }
  const scheduled = await scheduleTask({
    name,
    task: task.task,
    delayMs: 1000,
    periodInMinutes: task.periodInMinutes,
    attachments: task.attachments ?? [],
    scriptId: task.scriptId,
    // A retry re-arms the SAME logical task — its surface attribution must
    // survive, or the retried run loses its agent/thread projection.
    owner: task.owner ?? null,
  });
  return { ok: true, name, retried: true, when: scheduled.when };
}

/** Pause a scheduled task (owner action): the payload + full schedule metadata
 * are RETAINED (owner attribution, prompt, period/one-shot semantics) but the
 * chrome.alarms alarm is CLEARED (quota hygiene — a paused task must not hold
 * one of Chrome's 500 extension alarm slots). A paused task never fires:
 *   - the alarm is gone (primary),
 *   - reconcileScheduledTasks never re-arms it (restart persistence),
 *   - handleAlarm skips paused payloads (defense in depth for a racing alarm
 *     delivered between the persist and the confirmed clear).
 * Fail-closed mirror of the cancel/retry semantics: if the alarm's absence
 * cannot be CONFIRMED via alarms.get, the pause still holds (the firing path
 * skips paused payloads) but the result reports alarmAbsent:false so the
 * caller knows a slot may still be occupied. */
/** Owner-scope equality: the SAME attribution the per-agent list filter uses
 * (agentRole + agentSurfaceRef exactly). A model principal may only mutate a
 * task whose persisted owner matches ITS run context — never another agent's
 * task, and never an ownerless (hub/legacy) task (P1-1: cross-agent
 * authority). Owner-extension callers omit expectedOwner entirely. */
export function scheduledTaskOwnerMatches(task, expected) {
  const o = task?.owner;
  if (!o) return false; // ownerless tasks are owner-extension-managed only
  if (!expected || typeof expected !== "object") return false;
  return o.agentRole === expected.agentRole &&
    (o.agentSurfaceRef ?? null) === (expected.agentSurfaceRef ?? null);
}
function assertOwnerScope(task, expectedOwner) {
  if (expectedOwner === undefined) return null; // owner-extension: no scope check
  if (!scheduledTaskOwnerMatches(task, expectedOwner)) {
    return task?.owner
      ? "task belongs to another agent"
      : "task has no owning agent — manage it in Settings";
  }
  return null;
}
export async function pauseScheduledTask(name, { expectedOwner } = {}) {
  return withLock(async () => {
    const store = await kvGet(TASK_KEY);
    const tasks = { ...(store[TASK_KEY] ?? {}) };
    const task = tasks[name];
    if (!task) return { ok: false, name, error: "no such task" };
    const scopeError = assertOwnerScope(task, expectedOwner);
    if (scopeError) return { ok: false, name, error: scopeError };
    if (task.cancelling) return { ok: false, name, error: "task is cancelling — cannot pause" };
    if (task.paused) {
      // P2-1: a first pause that could not CONFIRM the alarm's absence (a
      // transient alarms.get/clear failure) used to exit early forever — the
      // paused flag short-circuited before any retry. Retry the disarm here
      // until absence is confirmed (idempotent, bounded to one extra attempt
      // per call); the firing-skip stays the safety net throughout.
      if (task.alarmUnconfirmed !== true) return { ok: true, name, paused: true, newlyPaused: false, alarmAbsent: null };
      const alarms = alarmsApi();
      let alarmAbsent = true;
      if (alarms) {
        try { await alarms.clear(name); } catch { /* get below is the authority */ }
        try {
          alarmAbsent = (await alarms.get(name)) == null;
        } catch {
          alarmAbsent = false;
        }
      }
      tasks[name] = { ...task, ...(alarmAbsent ? { alarmUnconfirmed: false } : {}) };
      await kvSet({ [TASK_KEY]: tasks });
      return { ok: true, name, paused: true, newlyPaused: false, alarmAbsent, retriedDisarm: true };
    }
    tasks[name] = { ...task, paused: true, pausedAt: Date.now() };
    await kvSet({ [TASK_KEY]: tasks });
    const alarms = alarmsApi();
    let alarmAbsent = true; // no alarms API → nothing armed by us at all
    if (alarms) {
      try { await alarms.clear(name); } catch { /* get below is the authority */ }
      try {
        alarmAbsent = (await alarms.get(name)) == null;
      } catch {
        alarmAbsent = false; // cannot confirm — the firing skip still protects the run
      }
    }
    // Persist the confirmation state so a later pause can RETRY the disarm
    // (P2-1) instead of trusting an unconfirmed absence forever.
    tasks[name] = { ...tasks[name], alarmUnconfirmed: alarms ? !alarmAbsent : false };
    await kvSet({ [TASK_KEY]: tasks });
    return { ok: true, name, paused: true, newlyPaused: true, alarmAbsent };
  });
}

/** Resume a paused scheduled task: re-arms the alarm with a RECOMPUTED next
 * fire. Documented resume semantics: a PERIODIC task restarts its period from
 * NOW (now + periodInMinutes*60000 — we do not replay the missed ticks while
 * paused); a ONE-SHOT whose original `at` is still in the future keeps that
 * `at`; a one-shot whose `at` passed while paused fires soon (now + 1s).
 * The paused flag is only lifted AFTER the alarm is confirmed created — a
 * failed re-arm leaves the task paused + reports an honest error (never a
 * silently-unpaused task with no alarm, which reconcile would then re-arm
 * with stale semantics). */
export async function resumeScheduledTask(name, { expectedOwner } = {}) {
  const task = await withLock(async () => {
    const store = await kvGet(TASK_KEY);
    const found = structuredClone(store[TASK_KEY]?.[name] ?? null);
    if (found) {
      const scopeError = assertOwnerScope(found, expectedOwner);
      if (scopeError) return { scopeError };
    }
    return found;
  });
  if (!task) return { ok: false, name, error: "no such task" };
  if (task.scopeError) return { ok: false, name, error: task.scopeError };
  if (!task.paused) return { ok: false, name, error: "task is not paused" };
  if (task.cancelling) return { ok: false, name, error: "task is cancelling — cannot resume" };
  if (task.quarantined) return { ok: false, name, error: "task is quarantined — retry or cancel it instead" };
  if (task.storageBlocked) return { ok: false, name, error: "task is storage-blocked — retry or cancel it instead" };
  const now = Date.now();
  const when = task.periodInMinutes
    ? now + task.periodInMinutes * 60 * 1000
    : (task.at > now ? task.at : now + 1000);
  const alarms = alarmsApi();
  if (!alarms) {
    return { ok: false, name, error: "alarms permission not granted — enable Scheduled tasks in Settings" };
  }
  try {
    await assertRunOwned();
  } catch {
    return { ok: false, name, error: "run aborted — task not resumed" };
  }
  // Capacity: re-arming consumes a slot that the pause released; refuse before
  // touching the persisted paused flag when Chrome's cap is exhausted.
  try {
    const active = await alarms.getAll();
    if (!active.some((a) => a?.name === name) && active.length >= MAX_ACTIVE_ALARMS) {
      return { ok: false, name, error: `Chrome allows at most ${MAX_ACTIVE_ALARMS} active alarms per extension` };
    }
  } catch (e) {
    return { ok: false, name, error: String(e?.message ?? e) };
  }
  return withLock(async () => {
    // Re-read under the lock: the task may have changed (or vanished) while we
    // awaited the capacity check outside the lock.
    const store = await kvGet(TASK_KEY);
    const tasks = { ...(store[TASK_KEY] ?? {}) };
    const cur = tasks[name];
    if (!cur) return { ok: false, name, error: "no such task" };
    if (!cur.paused) return { ok: true, name, resumed: false, when: cur.at };
    const nextWhen = cur.periodInMinutes
      ? Date.now() + cur.periodInMinutes * 60 * 1000
      : (cur.at > Date.now() ? cur.at : Date.now() + 1000);
    const restore = { ...cur };
    tasks[name] = { ...cur, paused: false, at: nextWhen };
    delete tasks[name].pausedAt;
    await kvSet({ [TASK_KEY]: tasks });
    try {
      const info = { when: nextWhen };
      if (cur.periodInMinutes) info.periodInMinutes = cur.periodInMinutes;
      await alarms.create(name, info);
    } catch (e) {
      // Roll back to paused so the task is never unpaused-but-unarmed.
      const curStore = await kvGet(TASK_KEY);
      const curTasks = { ...(curStore[TASK_KEY] ?? {}) };
      if (curTasks[name]) {
        curTasks[name] = { ...restore };
        await kvSet({ [TASK_KEY]: curTasks });
      }
      return { ok: false, name, error: String(e?.message ?? e) };
    }
    return { ok: true, name, resumed: true, when: nextWhen };
  });
}

/** Update an existing scheduled task in place: the prompt text, the timing
 * (at/delayMs), and/or the period. The SAME alarm name is reused — Chrome
 * replaces an existing alarm on create, so an update consumes no additional
 * alarm slot. An update of a PAUSED task changes the stored schedule only
 * (pause semantics still govern firing; resume arms the NEW schedule).
 * Atomic: the payload is only committed after validation, and a FAILED alarm
 * replace rolls the payload back (never a payload whose alarm disagrees). */
export async function updateScheduledTask(
  name,
  { task, at, delayMs, periodInMinutes, attachments, scriptId } = {},
  { expectedOwner } = {},
) {
  return withLock(async () => {
    const store = await kvGet(TASK_KEY);
    const tasks = { ...(store[TASK_KEY] ?? {}) };
    const existing = tasks[name];
    if (!existing) return { ok: false, name, error: "no such task" };
    const scopeError = assertOwnerScope(existing, expectedOwner);
    if (scopeError) return { ok: false, name, error: scopeError };
    if (existing.cancelling) return { ok: false, name, error: "task is cancelling — cannot update" };
    if (existing.quarantined) return { ok: false, name, error: "task is quarantined — retry or cancel it instead" };
    if (existing.storageBlocked) return { ok: false, name, error: "task is storage-blocked — retry or cancel it instead" };
    // Resolve the next fire EXACTLY like scheduleTask when a timing change was
    // requested; with no timing input the existing `at` anchor is kept.
    let when = existing.at;
    let timingChanged = false;
    if (at !== undefined || delayMs !== undefined) {
      if (typeof at === "number" && Number.isFinite(at) && at > Date.now()) {
        when = at;
      } else if (typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0) {
        when = Date.now() + delayMs;
      } else {
        throw new Error("update needs a future `at` (absolute ms) or a positive `delayMs`");
      }
      timingChanged = true;
    }
    const period = periodInMinutes !== undefined ? periodInMinutes : existing.periodInMinutes;
    const nextTask = task !== undefined ? String(task).slice(0, 4000) : existing.task;
    if (!nextTask || !nextTask.trim()) return { ok: false, name, error: "task text is required" };
    const next = {
      ...existing,
      task: nextTask,
      at: when,
      ...(periodInMinutes !== undefined ? { periodInMinutes: period || undefined } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(scriptId !== undefined ? { scriptId: scriptId || undefined } : {}),
    };
    try {
      await assertRunOwned();
    } catch {
      return { ok: false, name, error: "run aborted — task not updated" };
    }
    const restore = { ...existing };
    tasks[name] = next;
    await kvSet({ [TASK_KEY]: tasks });
    // A PAUSED task keeps no alarm: persist the new schedule, arm nothing.
    if (existing.paused) {
      return { ok: true, name, updated: true, when, paused: true, alarmTouched: false };
    }
    // P1-5 (anchor reset): a payload-only change (no at/delayMs input) keeps
    // the existing `at` — and must ALSO keep the LIVE alarm untouched.
    // Replacing it via alarms.create(name, { when: existing.at }) would
    // restart a periodic task's advance anchor (and expedite a periodic whose
    // `at` anchor is in the past), so editing only the text of an advanced
    // task must never re-arm it.
    if (!timingChanged) {
      return { ok: true, name, updated: true, when, timingChanged: false, paused: false, alarmTouched: false };
    }
    const alarms = alarmsApi();
    if (!alarms) {
      // Roll back: an ACTIVE task must never be left without a live alarm path.
      const curStore = await kvGet(TASK_KEY);
      const curTasks = { ...(curStore[TASK_KEY] ?? {}) };
      if (curTasks[name]) {
        curTasks[name] = restore;
        await kvSet({ [TASK_KEY]: curTasks });
      }
      return { ok: false, name, error: "alarms permission not granted — enable Scheduled tasks in Settings" };
    }
    try {
      const info = { when };
      if (next.periodInMinutes) info.periodInMinutes = next.periodInMinutes;
      await alarms.create(name, info); // same name → Chrome replaces in place
    } catch (e) {
      const curStore = await kvGet(TASK_KEY);
      const curTasks = { ...(curStore[TASK_KEY] ?? {}) };
      if (curTasks[name]) {
        curTasks[name] = restore;
        await kvSet({ [TASK_KEY]: curTasks });
      }
      return { ok: false, name, error: String(e?.message ?? e) };
    }
    return { ok: true, name, updated: true, when, timingChanged, paused: false, alarmTouched: true };
  });
}

/** Authoritatively CANCEL a scheduled task (an owner-visible route for a
 * quarantined or unwanted task). The round-23 blocker required "authoritative
 * cancel" for quarantined records: the alarm is cleared, absence is CONFIRMED
 * via alarms.get (a `clear` false is ambiguous), and the payload is removed
 * atomically under the scheduling lock.
 *
 * FAIL CLOSED (the round-24 blocker): when the alarm is STILL ARMED after the
 * clear attempt, the old code deleted the payload + returned ok:true anyway —
 * leaving a periodic alarm firing forever on a deleted payload. Now: if absence
 * cannot be confirmed, the payload is retained as a NON-RUNNABLE cancel-pending
 * record (reconciliation + alarm delivery both skip it) and the call returns
 * ok:false + retryable:true. Re-invoking this same route RETRIES until alarms.get
 * confirms absence, at which point the record is finally deleted. */
export async function cancelScheduledTask(name, terminationTimeoutMs = CANCEL_TERMINATION_TIMEOUT_MS) {
  // ---- Phase 1 (under the scheduling lock): mark the payload cancelling -------
  // This is the crash-safe FIRST durable transition — a crash after this write
  // leaves a non-runnable payload regardless of the alarm state. The live
  // same-boot run (if any) is captured here so it can be aborted + awaited
  // OUTSIDE the lock (awaiting the run's termination while holding the lock
  // would DEADLOCK: releaseInflight needs the same lock to resolve `terminated`).
  let existingTask = null;
  let live = null;
  await withLock(async () => {
    const store = await kvGet(TASK_KEY);
    const tasks = { ...(store[TASK_KEY] ?? {}) };
    const existing = tasks[name];
    if (!existing) return;
    existingTask = existing;
    tasks[name] = { ...existing, cancelling: true, cancellingAt: Date.now() };
    await kvSet({ [TASK_KEY]: tasks });
    live = activeRuns.get(name) ?? null;
  });

  if (!existingTask) {
    return { ok: true, name, cancelled: false, error: "no such task" };
  }

  // ---- Await termination (OUTSIDE the scheduling lock) -----------------------
  // Abort the live run's controller, then AWAIT its termination (bounded) so
  // cancel never reports success while a still-settling agent/tools could commit
  // side effects (the round-26 blocker: cancel aborted the controller but
  // returned {ok:true} before handleAlarm/runTask acknowledged termination). If it
  // does not settle in the bound, the cancel stays PENDING + retryable (the
  // payload is already `cancelling` — inert — so a retry confirms removal later).
  if (live) {
    try {
      live.controller.abort();
    } catch { /* already aborted */ }
    const settled = await Promise.race([
      live.terminated.then(() => true),
      new Promise((r) => setTimeout(() => r(false), terminationTimeoutMs)),
    ]);
    if (!settled) {
      return {
        ok: false,
        name,
        cancelled: false,
        retryable: true,
        alarmAbsent: false,
        pendingTermination: true,
        error: "task is still terminating — retry cancel to confirm removal",
      };
    }
  }

  // ---- Phase 2 (under the scheduling lock): clear + confirm + delete ---------
  return finalizeCancellation(name);
}

/** Phase-2 of cancellation (alarm clear + confirm-absent + payload delete),
 * extracted so the non-blocking delete path shares the SAME fail-closed logic. */
async function finalizeCancellation(name) {
  return withLock(async () => {
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
    if (!alarmAbsent) {
      // The alarm is STILL armed (clear failed or the state could not be
      // confirmed) — FAIL CLOSED. The payload is ALREADY `cancelling` (inert),
      // so it stays retryable until alarms.get confirms absence (reconciliation
      // + alarm delivery both skip it). The payload is ONLY deleted once alarms.get
      // confirms the alarm is absent.
      return {
        ok: false,
        name,
        cancelled: false,
        retryable: true,
        alarmAbsent: false,
        error: "alarm still armed — cancel is pending (retry to confirm removal)",
      };
    }
    // Confirmed absent → terminal: delete the (already-inert) payload.
    const store = await kvGet(TASK_KEY);
    const tasks = { ...(store[TASK_KEY] ?? {}) };
    delete tasks[name];
    await kvSet({ [TASK_KEY]: tasks });
    return { ok: true, name, cancelled: true, alarmAbsent: true };
  });
}

/** NON-BLOCKING cancel for agent deletion / background-agent disable
 * (owner: deleting a background agent must be instant, not a 5s termination
 * dance). Marks the payload `cancelling` (inert — no NEW run starts), aborts
 * the live run's controller NOW (side-effecting tools fence off the abort),
 * and finishes the alarm-clear + payload-delete ASYNC. The caller returns
 * immediately; reconciliation reaps any residue if the background cleanup is
 * interrupted (a service-worker kill mid-cleanup leaves the inert cancelling
 * payload, which handleAlarm skips and reconcileScheduledTasks reaps). */
export function cancelScheduledTaskBackground(name) {
  const done = (async () => {
    let live = null;
    await withLock(async () => {
      const store = await kvGet(TASK_KEY);
      const tasks = { ...(store[TASK_KEY] ?? {}) };
      const existing = tasks[name];
      if (!existing) return;
      tasks[name] = { ...existing, cancelling: true, cancellingAt: Date.now() };
      await kvSet({ [TASK_KEY]: tasks });
      live = activeRuns.get(name) ?? null;
    });
    if (live) {
      try { live.controller.abort(); } catch { /* already aborted */ }
    }
    await finalizeCancellation(name);
  })();
  // The returned promise is fire-and-forget by the callers; expose it so tests
  // can await the cleanup without blocking the delete route.
  return { promise: done, name, stopping: true };
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
    // A `terminated` promise per run, resolved by releaseInflight when the run
    // acknowledges termination (deletes the active-runs entry). cancelScheduledTask
    // awaits it (bounded) so it never reports success before a still-running agent
    // settles (the round-26 cancel-await-termination blocker).
    let resolveTerminated;
    const terminated = new Promise((resolve) => { resolveTerminated = resolve; });
    activeRuns.set(name, { token, controller, terminated, resolveTerminated });
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
        active.resolveTerminated?.();
      }
    }
  });
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
  let activeAlarmCount = existing.size;
  const resumed = [];
  const failed = [];
  const now = Date.now();
  for (const name of names) {
    const task = tasks[name];
    // A QUARANTINED task (a schedule that failed with UNKNOWN alarm state) must
    // NEVER be re-armed by reconciliation — it is non-runnable until the owner
    // explicitly retries (a fresh scheduleTask) or cancels (the round-22
    // unknown-state replay blocker: reconcile recreated + ran a failed schedule).
    // A CANCELLING task (a cancel that failed closed because the alarm was still
    // armed) must also never be re-armed — it is cancel-pending, retryable via the
    // owner's cancel route (the round-24 fail-closed cancel blocker).
    // A PAUSED task must never be re-armed by reconciliation — pause cleared the
    // alarm deliberately (quota hygiene); re-arming it on boot would silently
    // resume the task without the owner's action.
    if (task?.quarantined || task?.cancelling || task?.storageBlocked || task?.paused) continue;
    if (!existing.has(name)) {
      // Chrome's extension-wide 500-active-alarm cap is distinct from memory
      // capacity. Preserve the task payload but report that it was not re-armed.
      if (activeAlarmCount >= MAX_ACTIVE_ALARMS) {
        failed.push(`${name} (Chrome ${MAX_ACTIVE_ALARMS}-alarm limit)`);
        continue;
      }
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
        activeAlarmCount += 1;
        resumed.push(name);
      } catch (err) {
        failed.push(name);
        logSchedulerDiagnostic({
          event: "reconcile_alarm_failed",
          alarmName: name,
          path: "scheduler:reconcileScheduledTasks",
          storeState: "reconcile_failed",
          reason: err?.message ?? String(err),
          actionTaken: "recorded_failure",
        }, "error");
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
