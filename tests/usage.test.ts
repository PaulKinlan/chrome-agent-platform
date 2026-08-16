// Unit test for the usage ledger read-modify-write atomicity (round-24 blocker 6):
// concurrent onUsage events (parallel tool calls resolve via Promise.all) must NOT
// lose a row — the old unlocked kvGet→append→kvSet let two concurrent appends read
// the same rows and overwrite each other.
// @ts-nocheck — the chrome mock is intentionally dynamic (no chrome.* types in Deno).

import { assert } from "jsr:@std/assert@1";
import { recordUsage, getUsage, clearUsage } from "../extension/lib/usage.js";
import { __resetSessionForTest } from "../extension/lib/kv.js";

const store = new Map();
let delayMs = 0;
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
globalThis.chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
};

Deno.test("concurrent recordUsage appends do not lose rows (round-24 usage-RMW blocker)", async () => {
  __resetSessionForTest();
  store.clear();
  delayMs = 5; // widen the read-modify-write window so the race would be observable
  try {
    await Promise.all([
      recordUsage({ agentId: "agent-a", inputTokens: 10, outputTokens: 1 }),
      recordUsage({ agentId: "agent-b", inputTokens: 20, outputTokens: 2 }),
    ]);
    const rows = (await getUsage()).rows;
    assert(
      rows.filter((r) => r.agentId === "agent-a").length === 1,
      "record A must survive the concurrent append (no lost update)",
    );
    assert(
      rows.filter((r) => r.agentId === "agent-b").length === 1,
      "record B must survive the concurrent append (no lost update)",
    );
  } finally {
    delayMs = 0;
    await clearUsage();
  }
});

Deno.test("clearUsage serializes against a concurrent append (round-25 blocker)", async () => {
  __resetSessionForTest();
  store.clear();
  // A controllable gate: once armed, the next storage READ blocks until released,
  // so we can deterministically hold the append inside the usage mutex while a
  // clear arrives (without any timing-dependent setTimeout).
  let release;
  const gate = new Promise((r) => { release = r; });
  let blockReads = false;
  let signalBlocked = null;
  const blockedP = new Promise((r) => { signalBlocked = r; });
  const origGet = chrome.storage.local.get;
  chrome.storage.local.get = async (key) => {
    if (blockReads) {
      signalBlocked?.();
      await gate;
    }
    return origGet(key);
  };
  try {
    await recordUsage({ agentId: "seed", inputTokens: 1, outputTokens: 0 });
    blockReads = true;
    // Start an append; it enters the usage mutex and blocks on its storage read.
    const append = recordUsage({ agentId: "late", inputTokens: 2, outputTokens: 0 });
    await blockedP; // the append now HOLDS the usage mutex (mid read-modify-write)
    // The clear must QUEUE behind the append, not interleave with it. With clear
    // OUTSIDE the mutex, its kvRemove would run now and the append's later write
    // would resurrect the rows (the round-25 blocker).
    const cleared = clearUsage();
    release();
    await Promise.all([append, cleared]);
    const rows = (await getUsage()).rows;
    assert(
      rows.length === 0,
      "clear must not be resurrected by a concurrent append (clear is serialized)",
    );
  } finally {
    blockReads = false;
    release?.();
    chrome.storage.local.get = origGet;
    delayMs = 0;
    await clearUsage();
  }
});
