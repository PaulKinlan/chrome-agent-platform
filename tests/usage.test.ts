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
