// Unit tests for the in-flight alarm lease (round-11 blocker): owner/fencing
// tokens, compare-and-release, and "timeout alone must never overlap agents".
// scheduler.js is tested with a minimal chrome.storage/chrome.alarms mock.
// @ts-nocheck — the chrome mock is intentionally dynamic (no chrome.* types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { INFLIGHT_LEASE_MS } from "../extension/lib/scheduler.js";
import { freshScheduler } from "./test-hooks.js";

// Module isolation: scheduler.js owns `activeRuns` + `BOOT_AT` in CLOSURE, so a
// simulated worker restart is a FRESH module instance (cache-busted), not a
// mutation of shipped state. The functions below are re-bound to the fresh
// instance's exports by initScheduler(), so bare references stay stable across
// the mid-test `await initScheduler()` restarts.
let cancelScheduledTask, clearStaleInflight, heartbeatInflight, listScheduledTasks,
  markScheduledDone, ownsInflight, reconcileScheduledTasks, releaseInflight,
  scheduleTask, tryAcquireInflight;
async function initScheduler() {
  const m = await freshScheduler();
  ({
    cancelScheduledTask, clearStaleInflight, heartbeatInflight, listScheduledTasks,
    markScheduledDone, ownsInflight, reconcileScheduledTasks, releaseInflight,
    scheduleTask, tryAcquireInflight,
  } = m);
}
await initScheduler(); // initial binding (fresh module for the first test)


// ---- in-memory chrome mock (mirrors chrome.storage.local serialization) ----
const store = new Map();
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
    },
  },
  alarms: {
    create: async () => true,
    clear: async () => true,
    get: async () => undefined, // absent by default (no alarm)
    getAll: async () => [],
  },
};

Deno.test("inflight lock blocks a second acquisition while the owner is alive", async () => {
  const a = await tryAcquireInflight("lease-a");
  assertEquals(a.acquired, true);
  assert(typeof a.token === "string" && a.token.length > 0);

  // A live owner's heartbeat is fresh → a second acquisition is BLOCKED.
  const b = await tryAcquireInflight("lease-a");
  assertEquals(b.acquired, false);

  // The owner's own release (matching token) clears the lock.
  await releaseInflight("lease-a", a.token);
  const c = await tryAcquireInflight("lease-a");
  assertEquals(c.acquired, true);
  await releaseInflight("lease-a", c.token);
});

Deno.test("a live same-boot owner is NEVER re-acquired from heartbeat age (round-13 blocker)", async () => {
  const a = await tryAcquireInflight("lease-b");
  assertEquals(a.acquired, true);

  // Age the persisted heartbeat far past the lease — the owner "looks" dead.
  const s1 = await chrome.storage.local.get("cap:scheduledInflight");
  s1["cap:scheduledInflight"]["lease-b"].heartbeatAt =
    Date.now() - INFLIGHT_LEASE_MS * 10;
  await chrome.storage.local.set({ "cap:scheduledInflight": s1["cap:scheduledInflight"] });

  // The owner is STILL LIVE in this worker's memory → re-acquisition is BLOCKED.
  // (The old code re-acquired here, letting a second run overlap a live one.)
  const b = await tryAcquireInflight("lease-b");
  assertEquals(b.acquired, false, "a live same-boot owner must block re-acquisition");
  assert(await ownsInflight("lease-b", a.token), "owner A still owns the lock");

  await releaseInflight("lease-b", a.token);
});

Deno.test("a previous worker instance's lock is re-acquired after a simulated restart", async () => {
  const a = await tryAcquireInflight("lease-b2");
  assertEquals(a.acquired, true);

  // Simulate the worker being killed: a fresh SW instance has no in-memory run
  // and a new boot instant, but the dead owner's persisted lock remains.
  await initScheduler();

  const b = await tryAcquireInflight("lease-b2");
  assertEquals(b.acquired, true, "a previous worker's lock is re-acquired");
  assert(b.token !== a.token, "re-acquisition must fence with a fresh token");

  // The stale owner A's late release must NOT delete B's lock (compare-and-release).
  await releaseInflight("lease-b2", a.token);
  assert(await ownsInflight("lease-b2", b.token), "B still owns after A's stale release");

  await releaseInflight("lease-b2", b.token);
});

Deno.test("heartbeat keeps a slow-but-alive owner from being evicted", async () => {
  const a = await tryAcquireInflight("lease-c");
  assertEquals(a.acquired, true);

  // A long run: the stored heartbeat drifts old, but the owner renews it each
  // cycle (heartbeatInflight), so it must never be considered stale.
  for (let i = 0; i < 3; i++) {
    const s = await chrome.storage.local.get("cap:scheduledInflight");
    s["cap:scheduledInflight"]["lease-c"].heartbeatAt =
      Date.now() - INFLIGHT_LEASE_MS * 2;
    await chrome.storage.local.set({ "cap:scheduledInflight": s["cap:scheduledInflight"] });
    await heartbeatInflight("lease-c", a.token);
  }
  const b = await tryAcquireInflight("lease-c");
  assertEquals(b.acquired, false, "a heartbeating owner must block re-acquisition");
  await releaseInflight("lease-c", a.token);
});

Deno.test("clearStaleInflight clears malformed locks but preserves live post-boot locks", async () => {
  const a = await tryAcquireInflight("lease-d");
  assertEquals(a.acquired, true);

  // Inject a malformed lock (a numeric value — unreleasable by compare-and-release).
  const s = await chrome.storage.local.get("cap:scheduledInflight");
  s["cap:scheduledInflight"]["malformed"] = 12345;
  await chrome.storage.local.set({ "cap:scheduledInflight": s["cap:scheduledInflight"] });

  await clearStaleInflight();
  const after = await chrome.storage.local.get("cap:scheduledInflight");
  assert(after["cap:scheduledInflight"]["lease-d"] !== undefined, "live lock preserved");
  assert(after["cap:scheduledInflight"]["malformed"] === undefined, "malformed lock cleared");
  await releaseInflight("lease-d", a.token);
});

Deno.test("ownsInflight is true for the owner and false after a restart re-acquisition", async () => {
  const a = await tryAcquireInflight("lease-e");
  assertEquals(a.acquired, true);
  assert(await ownsInflight("lease-e", a.token), "owner must own the lock");

  // Simulate a worker restart: the dead owner A's lock is re-acquired by B.
  await initScheduler();
  const b = await tryAcquireInflight("lease-e");
  assertEquals(b.acquired, true);
  assert(!(await ownsInflight("lease-e", a.token)), "stale owner A no longer owns");
  assert(await ownsInflight("lease-e", b.token), "new owner B owns the lock");
  await releaseInflight("lease-e", b.token);
});

Deno.test("markScheduledDone is fenced: a stale owner cannot delete a later owner's task", async () => {
  // Schedule a one-shot task + acquire its in-flight lock as owner A.
  const { name } = await scheduleTask({ task: "fenced-task", delayMs: 1000 });
  const a = await tryAcquireInflight(name);
  assertEquals(a.acquired, true);

  // Simulate a worker restart: owner A's worker died; B re-acquires.
  await initScheduler();
  const b = await tryAcquireInflight(name);
  assertEquals(b.acquired, true);

  // Stale owner A attempts markScheduledDone — it must THROW and NOT delete the
  // task payload (B owns the lock now).
  let threw = false;
  try {
    await markScheduledDone(name, a.token);
  } catch {
    threw = true;
  }
  assert(threw, "stale owner's fenced markScheduledDone must throw");
  const store = await chrome.storage.local.get("cap:scheduledTasks");
  assert(store["cap:scheduledTasks"][name] !== undefined, "task payload must survive");

  // The current owner B can mark it done.
  await markScheduledDone(name, b.token);
  const store2 = await chrome.storage.local.get("cap:scheduledTasks");
  assert(store2["cap:scheduledTasks"][name] === undefined, "owner B removed the task");
});

Deno.test("heartbeatInflight REJECTS a missing persisted lock (round-16 blocker)", async () => {
  const a = await tryAcquireInflight("lease-f");
  assertEquals(a.acquired, true);

  // Delete the durable lock (simulates a storage failure or external deletion)
  // while the owner is STILL live in memory.
  const s = await chrome.storage.local.get("cap:scheduledInflight");
  delete s["cap:scheduledInflight"]["lease-f"];
  await chrome.storage.local.set({ "cap:scheduledInflight": s["cap:scheduledInflight"] });

  // The heartbeat must REJECT (never silently succeed) — the owner cannot prove
  // durable ownership, so the run must abort rather than commit side effects.
  let threw = false;
  try {
    await heartbeatInflight("lease-f", a.token);
  } catch {
    threw = true;
  }
  assert(threw, "heartbeat on a missing durable lock must reject");
  await releaseInflight("lease-f", a.token);
});

Deno.test("heartbeatInflight REJECTS a mismatched-token persisted lock (round-16 blocker)", async () => {
  const a = await tryAcquireInflight("lease-g");
  assertEquals(a.acquired, true);

  // A different token now owns the persisted lock (re-acquisition by another
  // worker) while this owner is still in memory.
  const s = await chrome.storage.local.get("cap:scheduledInflight");
  s["cap:scheduledInflight"]["lease-g"].token = "some-other-token";
  await chrome.storage.local.set({ "cap:scheduledInflight": s["cap:scheduledInflight"] });

  let threw = false;
  try {
    await heartbeatInflight("lease-g", a.token);
  } catch {
    threw = true;
  }
  assert(threw, "heartbeat on a mismatched durable lock must reject");
  await releaseInflight("lease-g", a.token);
});

Deno.test("ownsInflight is false when the durable lock is lost (round-16 blocker)", async () => {
  const a = await tryAcquireInflight("lease-h");
  assertEquals(a.acquired, true);
  assert(await ownsInflight("lease-h", a.token), "owner owns while the durable lock exists");

  // Delete the durable lock — the in-memory run still exists, but durable
  // ownership is lost. ownsInflight must now return false (the execution fence
  // must abort, not commit side effects as a silently-degraded owner).
  const s = await chrome.storage.local.get("cap:scheduledInflight");
  delete s["cap:scheduledInflight"]["lease-h"];
  await chrome.storage.local.set({ "cap:scheduledInflight": s["cap:scheduledInflight"] });
  assert(!(await ownsInflight("lease-h", a.token)), "durable ownership loss must fail the fence");

  await releaseInflight("lease-h", a.token);
});

import { setRunFence, clearRunFence } from "../extension/lib/run-fence.js";

Deno.test("markScheduledDone keeps the payload when the alarm is STILL ARMED (round-19 + round-20)", async () => {
  const origClear = chrome.alarms.clear;
  const origGet = chrome.alarms.get;
  chrome.alarms.clear = async () => false; // clear failed
  chrome.alarms.get = async () => ({ name: "still-armed" }); // alarm STILL present
  try {
    const { name } = await scheduleTask({
      task: "periodic-clear-false",
      delayMs: 1000,
      periodInMinutes: 1,
    });
    await markScheduledDone(name);
    const store = await chrome.storage.local.get("cap:scheduledTasks");
    assert(
      store["cap:scheduledTasks"][name] !== undefined,
      "payload must survive when the alarm is STILL armed (clear failed)",
    );
  } finally {
    chrome.alarms.clear = origClear;
    chrome.alarms.get = origGet;
  }
});

Deno.test("markScheduledDone DELETES a completed one-shot whose alarm is already absent (round-20 replay blocker)", async () => {
  // A fired one-shot: Chrome consumed the alarm, so alarms.clear returns false
  // (nothing to clear) AND alarms.get returns undefined (the alarm is absent).
  // The old code treated clear-false as "still armed", KEPT the payload, and
  // reconcileScheduledTasks recreated + reran the completed task (replay loop).
  const origClear = chrome.alarms.clear;
  const origGet = chrome.alarms.get;
  chrome.alarms.clear = async () => false; // nothing to clear (already fired)
  chrome.alarms.get = async () => undefined; // alarm is ABSENT
  try {
    const { name } = await scheduleTask({
      task: "completed-one-shot",
      delayMs: 1000,
    });
    await markScheduledDone(name);
    const store = await chrome.storage.local.get("cap:scheduledTasks");
    assert(
      store["cap:scheduledTasks"][name] === undefined,
      "a completed one-shot's payload must be DELETED (never replayed)",
    );
  } finally {
    chrome.alarms.clear = origClear;
    chrome.alarms.get = origGet;
  }
});

Deno.test("scheduleTask rollback keeps the payload when a still-armed alarm's clear fails (round-19)", async () => {
  const origCreate = chrome.alarms.create;
  const origClear = chrome.alarms.clear;
  const origGet = chrome.alarms.get;
  const controller = new AbortController();
  // alarms.create succeeds; we abort DURING it so the post-create ownership
  // re-check throws (the round-19 scenario: a periodic alarm was created, then
  // ownership was lost). The alarm is STILL armed and its clear FAILS.
  chrome.alarms.create = async () => {
    controller.abort();
    return true;
  };
  chrome.alarms.clear = async () => false; // clear FAILS (alarm still armed)
  chrome.alarms.get = async () => ({ name: "still-armed" }); // alarm PRESENT
  setRunFence({ signal: controller.signal });
  try {
    let threw = false;
    try {
      await scheduleTask({
        task: "rollback-clear-false-armed",
        delayMs: 1000,
        periodInMinutes: 1,
      });
    } catch {
      threw = true;
    }
    assert(threw, "scheduleTask must reject when ownership is lost after create");
    const store = await chrome.storage.local.get("cap:scheduledTasks");
    const tasks = store["cap:scheduledTasks"] ?? {};
    const kept = Object.values(tasks).some((t) =>
      t?.task === "rollback-clear-false-armed"
    );
    assert(
      kept,
      "payload must be KEPT when the still-armed alarm's clear fails",
    );
  } finally {
    clearRunFence();
    chrome.alarms.create = origCreate;
    chrome.alarms.clear = origClear;
    chrome.alarms.get = origGet;
  }
});

Deno.test("scheduleTask deletes the payload when create fails and the alarm is absent (round-21 replay blocker)", async () => {
  const origCreate = chrome.alarms.create;
  const origClear = chrome.alarms.clear;
  const origGet = chrome.alarms.get;
  // alarms.create rejects BEFORE creating an alarm; clear returns false because
  // the alarm is ABSENT (not because it failed). The old code kept the payload
  // here, and reconcileScheduledTasks recreated + reran the failed task.
  chrome.alarms.create = async () => {
    throw new Error("create failed");
  };
  chrome.alarms.clear = async () => false; // nothing to clear (never created)
  chrome.alarms.get = async () => undefined; // alarm ABSENT
  try {
    let threw = false;
    try {
      await scheduleTask({
        task: "create-failed-absent",
        delayMs: 1000,
      });
    } catch {
      threw = true;
    }
    assert(threw, "scheduleTask must reject when alarms.create fails");
    const store = await chrome.storage.local.get("cap:scheduledTasks");
    const tasks = store["cap:scheduledTasks"] ?? {};
    const leaked = Object.values(tasks).some((t) =>
      t?.task === "create-failed-absent"
    );
    assert(!leaked, "a failed schedule must NOT leave a rerunnable payload");
  } finally {
    chrome.alarms.create = origCreate;
    chrome.alarms.clear = origClear;
    chrome.alarms.get = origGet;
  }
});

Deno.test("scheduleTask QUARANTINES the payload when create throws AND get throws (round-22 unknown-state blocker)", async () => {
  const origCreate = chrome.alarms.create;
  const origClear = chrome.alarms.clear;
  const origGet = chrome.alarms.get;
  // Both alarms.create AND the alarms.get confirmation throw: the alarm's state
  // is UNKNOWN. The old code left an ordinary runnable payload here, which a
  // later reconcileScheduledTasks recreated + ran. The fix must QUARANTINE the
  // payload (non-runnable) so reconciliation never re-arms it.
  chrome.alarms.create = async () => {
    throw new Error("create failed");
  };
  chrome.alarms.clear = async () => {
    throw new Error("clear failed");
  };
  chrome.alarms.get = async () => {
    throw new Error("get failed (unknown state)");
  };
  try {
    let threw = false;
    try {
      await scheduleTask({ task: "create-failed-unknown", delayMs: 1000 });
    } catch {
      threw = true;
    }
    assert(threw, "scheduleTask must reject when alarms.create fails");
    const store = await chrome.storage.local.get("cap:scheduledTasks");
    const tasks = store["cap:scheduledTasks"] ?? {};
    const entry = Object.values(tasks).find((t) =>
      t?.task === "create-failed-unknown"
    );
    assert(entry, "the payload must be retained (its alarm state is unknown)");
    assert(
      entry?.quarantined === true,
      "an unknown-state payload must be QUARANTINED (non-runnable)",
    );
  } finally {
    chrome.alarms.create = origCreate;
    chrome.alarms.clear = origClear;
    chrome.alarms.get = origGet;
  }
});

Deno.test("reconcileScheduledTasks does NOT re-arm a quarantined payload (round-22)", async () => {
  const origGetAll = chrome.alarms.getAll;
  const origCreate = chrome.alarms.create;
  const created = [];
  chrome.alarms.getAll = async () => []; // no alarms exist
  chrome.alarms.create = async (name) => {
    created.push(name);
    return true;
  };
  // Seed a QUARANTINED payload (as the unknown-state schedule rollback would).
  await chrome.storage.local.set({
    "cap:scheduledTasks": {
      "task_quarantined": {
        name: "task_quarantined",
        task: "should-not-rerun",
        at: Date.now() - 1000,
        quarantined: true,
      },
    },
  });
  try {
    await reconcileScheduledTasks();
    assert(
      !created.includes("task_quarantined"),
      "a quarantined payload must NOT be re-armed by reconciliation",
    );
  } finally {
    chrome.alarms.getAll = origGetAll;
    chrome.alarms.create = origCreate;
    await chrome.storage.local.set({ "cap:scheduledTasks": {} });
  }
});

Deno.test("cancelScheduledTask removes a quarantined payload + confirms alarm absence (round-23)", async () => {
  const origClear = chrome.alarms.clear;
  const origGet = chrome.alarms.get;
  chrome.alarms.clear = async () => true;
  chrome.alarms.get = async () => undefined; // absent
  await chrome.storage.local.set({
    "cap:scheduledTasks": {
      "task_cancel_me": {
        name: "task_cancel_me",
        task: "should-not-run",
        at: Date.now() - 1000,
        quarantined: true,
      },
    },
  });
  try {
    const res = await cancelScheduledTask("task_cancel_me");
    assert(res?.cancelled === true, "cancel must remove the task");
    assert(res?.alarmAbsent === true, "alarm absence must be confirmed");
    const store = await chrome.storage.local.get("cap:scheduledTasks");
    assert(
      !(store["cap:scheduledTasks"]?.["task_cancel_me"]),
      "the quarantined payload must be removed",
    );
  } finally {
    chrome.alarms.clear = origClear;
    chrome.alarms.get = origGet;
    await chrome.storage.local.set({ "cap:scheduledTasks": {} });
  }
});

Deno.test("listScheduledTasks surfaces quarantined tasks so the owner can cancel them (round-23)", async () => {
  await chrome.storage.local.set({
    "cap:scheduledTasks": {
      "task_active": {
        name: "task_active",
        task: "ok",
        at: Date.now() + 60000,
      },
      "task_quar": {
        name: "task_quar",
        task: "bad",
        at: Date.now() - 1000,
        quarantined: true,
      },
    },
  });
  const list = await listScheduledTasks();
  const q = list.find((t) => t.name === "task_quar");
  assert(q?.quarantined === true, "a quarantined task must be visible");
  const a = list.find((t) => t.name === "task_active");
  assert(a && a.quarantined === false, "an active task must be visible + not quarantined");
  await chrome.storage.local.set({ "cap:scheduledTasks": {} });
});

Deno.test("an abort during the first storage await prevents scheduleTask persisting (round-17)", async () => {
  const controller = new AbortController();
  setRunFence({ signal: controller.signal });
  try {
    // scheduleTask validates + then awaits kvGet(TASK_KEY). Abort synchronously
    // so the fence flips during that await — the persist-boundary re-check must
    // reject and leave NO persisted payload (the round-17 blocker reproduced an
    // aborted schedule_task still persisting + creating an alarm).
    const p = scheduleTask({ task: "aborted-task", delayMs: 5000 });
    controller.abort();
    let threw = false;
    try {
      await p;
    } catch {
      threw = true;
    }
    assert(threw, "an aborted scheduleTask must reject");
    const store = await chrome.storage.local.get("cap:scheduledTasks");
    const tasks = store["cap:scheduledTasks"] ?? {};
    const leaked = Object.values(tasks).some((t) => t?.task === "aborted-task");
    assert(!leaked, "no aborted payload may be persisted");
  } finally {
    clearRunFence();
  }
});

Deno.test("an abort DURING alarms.create rolls back the alarm + payload (round-18)", async () => {
  // A controllable alarms.create that resolves only when released, so we can
  // abort while the await is in flight.
  const origCreate = chrome.alarms.create;
  const origClear = chrome.alarms.clear;
  const created = [];
  const cleared = [];
  let releaseCreate;
  chrome.alarms.create = (_name) => {
    created.push(_name);
    return new Promise((resolve) => {
      releaseCreate = () => resolve(true);
    });
  };
  chrome.alarms.clear = async (name) => {
    cleared.push(name);
    return true;
  };
  const controller = new AbortController();
  setRunFence({ signal: controller.signal });
  try {
    const p = scheduleTask({ task: "aborted-alarm-task", delayMs: 5000 });
    // Wait until alarms.create has been CALLED (the payload is already written).
    for (let i = 0; i < 100 && created.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert(created.length === 1, "alarms.create must have been called");
    // Abort DURING the pending alarms.create, then let it resolve.
    controller.abort();
    releaseCreate?.();
    let threw = false;
    try {
      await p;
    } catch {
      threw = true;
    }
    assert(threw, "scheduleTask must reject when aborted during alarms.create");
    // The created alarm must be rolled back (cleared) AND the payload removed.
    assert(cleared.includes(created[0]), "the created alarm must be rolled back");
    const store = await chrome.storage.local.get("cap:scheduledTasks");
    const tasks = store["cap:scheduledTasks"] ?? {};
    const leaked = Object.values(tasks).some((t) =>
      t?.task === "aborted-alarm-task"
    );
    assert(!leaked, "no aborted payload may be persisted");
  } finally {
    clearRunFence();
    chrome.alarms.create = origCreate;
    chrome.alarms.clear = origClear;
  }
});

Deno.test("cancelScheduledTask FAILS CLOSED when the alarm is STILL armed (round-24 blocker)", async () => {
  const origClear = chrome.alarms.clear;
  const origGet = chrome.alarms.get;
  chrome.alarms.clear = async () => false; // clear FAILED (alarm still armed)
  chrome.alarms.get = async () => ({ name: "still-armed" }); // alarm PRESENT
  try {
    await chrome.storage.local.set({
      "cap:scheduledTasks": {
        "task_cancel_armed": {
          name: "task_cancel_armed",
          task: "periodic",
          at: Date.now() + 60000,
          periodInMinutes: 1,
        },
      },
    });
    const res = await cancelScheduledTask("task_cancel_armed");
    assert(res?.ok === false, "cancel must FAIL CLOSED when the alarm is still armed");
    assert(res?.retryable === true, "cancel must be retryable");
    const store = await chrome.storage.local.get("cap:scheduledTasks");
    const t = store["cap:scheduledTasks"]?.["task_cancel_armed"];
    assert(t !== undefined, "the payload must be RETAINED (cancel-pending, not deleted)");
    assert(t?.cancelling === true, "the payload must be marked cancelling (non-runnable)");
  } finally {
    chrome.alarms.clear = origClear;
    chrome.alarms.get = origGet;
    await chrome.storage.local.set({ "cap:scheduledTasks": {} });
  }
});

Deno.test("cancelScheduledTask RETRY confirms removal once the alarm is absent (round-24 blocker)", async () => {
  const origClear = chrome.alarms.clear;
  const origGet = chrome.alarms.get;
  let armed = true;
  let clearCalls = 0;
  chrome.alarms.clear = async () => {
    clearCalls++;
    if (clearCalls === 1) return false; // first clear FAILS (alarm still armed)
    armed = false;
    return true;
  };
  chrome.alarms.get = async () => (armed ? { name: "still-armed" } : undefined);
  try {
    await chrome.storage.local.set({
      "cap:scheduledTasks": {
        "task_cancel_retry": {
          name: "task_cancel_retry",
          task: "periodic",
          at: Date.now() + 60000,
          periodInMinutes: 1,
        },
      },
    });
    // First attempt: clear fails (armed remains true) → fail closed + pending.
    const first = await cancelScheduledTask("task_cancel_retry");
    assert(first?.ok === false && first?.retryable === true, "first attempt must fail closed");
    // Retry (clear now succeeds → alarm absent) → the record is finally deleted.
    const second = await cancelScheduledTask("task_cancel_retry");
    assert(second?.ok === true && second?.cancelled === true, "retry must confirm removal");
    const store = await chrome.storage.local.get("cap:scheduledTasks");
    assert(
      store["cap:scheduledTasks"]?.["task_cancel_retry"] === undefined,
      "the record is deleted only after confirmed absence",
    );
  } finally {
    chrome.alarms.clear = origClear;
    chrome.alarms.get = origGet;
    await chrome.storage.local.set({ "cap:scheduledTasks": {} });
  }
});

Deno.test("reconcileScheduledTasks does NOT re-arm a cancelling payload (round-24 blocker)", async () => {
  const origGetAll = chrome.alarms.getAll;
  const origCreate = chrome.alarms.create;
  const created = [];
  chrome.alarms.getAll = async () => []; // no alarms exist
  chrome.alarms.create = async (name) => {
    created.push(name);
    return true;
  };
  await chrome.storage.local.set({
    "cap:scheduledTasks": {
      "task_cancelling": {
        name: "task_cancelling",
        task: "should-not-rerun",
        at: Date.now() - 1000,
        cancelling: true,
      },
    },
  });
  try {
    await reconcileScheduledTasks();
    assert(
      !created.includes("task_cancelling"),
      "a cancelling payload must NOT be re-armed by reconciliation",
    );
  } finally {
    chrome.alarms.getAll = origGetAll;
    chrome.alarms.create = origCreate;
    await chrome.storage.local.set({ "cap:scheduledTasks": {} });
  }
});

Deno.test("cancelScheduledTask persists cancelling BEFORE touching the alarm (round-25 crash-safety blocker)", async () => {
  let payloadAtClear = null;
  const origClear = chrome.alarms.clear;
  const origGet = chrome.alarms.get;
  chrome.alarms.clear = async () => {
    // At the instant clear runs, the payload must ALREADY be cancelling (inert),
    // so a crash between this point and the final delete leaves a non-runnable
    // payload — never a normal runnable one that reconcile would re-arm.
    const s = await chrome.storage.local.get("cap:scheduledTasks");
    payloadAtClear = s["cap:scheduledTasks"]?.["task_crash"];
    return true;
  };
  chrome.alarms.get = async () => undefined; // absent → the normal delete path
  try {
    await chrome.storage.local.set({
      "cap:scheduledTasks": {
        "task_crash": {
          name: "task_crash",
          task: "should-not-rerun",
          at: Date.now() + 60000,
        },
      },
    });
    await cancelScheduledTask("task_crash");
    assert(
      payloadAtClear?.cancelling === true,
      "the payload must be marked cancelling BEFORE the alarm is cleared",
    );
  } finally {
    chrome.alarms.clear = origClear;
    chrome.alarms.get = origGet;
    await chrome.storage.local.set({ "cap:scheduledTasks": {} });
  }
});

Deno.test("cancelScheduledTask aborts a live same-boot run + reports pending until it terminates (round-25/26 blocker)", async () => {
  const lock = await tryAcquireInflight("task_running");
  assert(lock.acquired === true, "precondition: the run must be acquired");

  const origClear = chrome.alarms.clear;
  const origGet = chrome.alarms.get;
  chrome.alarms.clear = async () => true;
  chrome.alarms.get = async () => undefined;
  try {
    await chrome.storage.local.set({
      "cap:scheduledTasks": {
        "task_running": {
          name: "task_running",
          task: "should-not-rerun",
          at: Date.now() + 60000,
        },
      },
    });
    // Pass a SMALL termination timeout so the test does not wait the full 5s: the
    // run never terminates during the cancel, so the result is PENDING + retryable
    // (the round-26 cancel-await-termination behavior).
    const result = await cancelScheduledTask("task_running", 30);
    assert(
      lock.signal.aborted === true,
      "cancel must abort the already-acquired run's controller (fence the running agent/tools)",
    );
    assert(
      result.ok === false && result.pendingTermination === true && result.retryable === true,
      "cancel must NOT report success while the run is still terminating (round-26)",
    );
  } finally {
    chrome.alarms.clear = origClear;
    chrome.alarms.get = origGet;
    await releaseInflight("task_running", lock.token);
    await chrome.storage.local.set({ "cap:scheduledTasks": {} });
  }
});

Deno.test("cancelScheduledTask completes once the acquired run terminates (round-26 blocker)", async () => {
  const lock = await tryAcquireInflight("task_terminate");
  assert(lock.acquired === true, "precondition: the run must be acquired");

  const origClear = chrome.alarms.clear;
  const origGet = chrome.alarms.get;
  chrome.alarms.clear = async () => true;
  chrome.alarms.get = async () => undefined;
  try {
    await chrome.storage.local.set({
      "cap:scheduledTasks": {
        "task_terminate": {
          name: "task_terminate",
          task: "should-not-rerun",
          at: Date.now() + 60000,
        },
      },
    });
    // Release the run shortly after the cancel starts its await-termination so
    // the cancel observes the termination and completes (not deadlock: the await
    // happens OUTSIDE the scheduling lock, so releaseInflight can acquire it).
    const cancelPromise = cancelScheduledTask("task_terminate", 2000);
    setTimeout(() => {
      releaseInflight("task_terminate", lock.token).catch(() => {});
    }, 10);
    const result = await cancelPromise;
    assert(
      result.ok === true && result.cancelled === true,
      "cancel must complete once the run terminates (round-26)",
    );
  } finally {
    chrome.alarms.clear = origClear;
    chrome.alarms.get = origGet;
    await releaseInflight("task_terminate", lock.token);
    await chrome.storage.local.set({ "cap:scheduledTasks": {} });
  }
});
