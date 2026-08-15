// Unit tests for the in-flight alarm lease (round-11 blocker): owner/fencing
// tokens, compare-and-release, and "timeout alone must never overlap agents".
// scheduler.js is tested with a minimal chrome.storage/chrome.alarms mock.
// @ts-nocheck — the chrome mock is intentionally dynamic (no chrome.* types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  INFLIGHT_LEASE_MS,
  clearStaleInflight,
  heartbeatInflight,
  releaseInflight,
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

Deno.test("stale lock re-acquires with a NEW token and stale release is a no-op", async () => {
  const a = await tryAcquireInflight("lease-b");
  assertEquals(a.acquired, true);

  // Simulate the owner dying: heartbeat goes silent beyond the lease.
  const s1 = await chrome.storage.local.get("cap:scheduledInflight");
  s1["cap:scheduledInflight"]["lease-b"].heartbeatAt =
    Date.now() - INFLIGHT_LEASE_MS * 2;
  await chrome.storage.local.set({ "cap:scheduledInflight": s1["cap:scheduledInflight"] });

  // B re-acquires (owner demonstrably dead) with a DIFFERENT token.
  const b = await tryAcquireInflight("lease-b");
  assertEquals(b.acquired, true);
  assert(b.token !== a.token, "re-acquisition must fence with a fresh token");

  // The stale owner A's late release must NOT delete B's lock (compare-and-release).
  await releaseInflight("lease-b", a.token);
  const s2 = await chrome.storage.local.get("cap:scheduledInflight");
  assertEquals(s2["cap:scheduledInflight"]["lease-b"].token, b.token);

  // C cannot acquire concurrently with B.
  const c = await tryAcquireInflight("lease-b");
  assertEquals(c.acquired, false);

  // B's own release clears.
  await releaseInflight("lease-b", b.token);
  const d = await tryAcquireInflight("lease-b");
  assertEquals(d.acquired, true);
  await releaseInflight("lease-b", d.token);
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
