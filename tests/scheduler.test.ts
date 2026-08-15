// Unit tests for the in-flight alarm lease (round-11 blocker): owner/fencing
// tokens, compare-and-release, and "timeout alone must never overlap agents".
// scheduler.js is tested with a minimal chrome.storage/chrome.alarms mock.
// @ts-nocheck — the chrome mock is intentionally dynamic (no chrome.* types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  INFLIGHT_LEASE_MS,
  __resetBootForTest,
  clearStaleInflight,
  heartbeatInflight,
  markScheduledDone,
  ownsInflight,
  releaseInflight,
  scheduleTask,
  tryAcquireInflight,
} from "../extension/lib/scheduler.js";

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
  __resetBootForTest();

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
  __resetBootForTest();
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
  __resetBootForTest();
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
