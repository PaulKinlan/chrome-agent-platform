// tests/usage.test.ts — usage ledger (IndexedDB authority) integration.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { recordUsage, getUsage, clearUsage } from "../extension/lib/usage.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";

const store = new Map();
function mock() {
  globalThis.chrome = { permissions: { contains: async () => true }, storage: { local: {
    get: async (key) => { const out = {}; for (const k of (Array.isArray(key)?key:[key])) if (store.has(k)) out[k]=JSON.parse(JSON.stringify(store.get(k))); return out; },
    set: async (obj) => { for (const [k,v] of Object.entries(obj)) store.set(k, JSON.parse(JSON.stringify(v))); },
    remove: async (keys) => { for (const k of (Array.isArray(keys)?keys:[keys])) store.delete(k); },
  } } };
}
function reset() { resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); mock(); store.clear(); }

Deno.test("concurrent recordUsage appends do not lose rows", async () => {
  reset();
  await Promise.all([
    recordUsage({ agentId: "agent-a", inputTokens: 10, outputTokens: 1 }),
    recordUsage({ agentId: "agent-b", inputTokens: 20, outputTokens: 2 }),
  ]);
  const rows = (await getUsage()).rows;
  assert(rows.filter((r) => r.agentId === "agent-a").length === 1, "record A must survive");
  assert(rows.filter((r) => r.agentId === "agent-b").length === 1, "record B must survive");
});

Deno.test("clearUsage empties the ledger", async () => {
  reset();
  await recordUsage({ agentId: "seed", inputTokens: 1, outputTokens: 0 });
  await clearUsage();
  assertEquals((await getUsage()).rows.length, 0, "clear empties the ledger");
});

Deno.test("getUsage aggregates by provider/model/agent/task/day", async () => {
  reset();
  await recordUsage({ agentId: "agent-a", taskId: "task-1", provider: "gemini", model: "gemini-3.7-flash", inputTokens: 100, outputTokens: 10, estimatedCost: 0.001 });
  await recordUsage({ agentId: "agent-b", taskId: "task-1", provider: "anthropic", model: "claude-opus-5", inputTokens: 50, outputTokens: 5, estimatedCost: 0.005 });
  const u = await getUsage();
  assert(u.totals.calls === 2, "2 calls total");
  assert(u.totals.inputTokens === 150, "input tokens summed");
  assert(u.byProvider.length === 2, "two providers");
  assert(u.byModel.length === 2, "two models");
  assert(u.byAgent.length === 2, "two agents");
});

Deno.test("usage panel: the detail-toggle listener is wired EXACTLY once, outside renderUsage", async () => {
  // The open Usage panel re-renders per page-load + nav + 1.5s poll. If the
  // #usage-detail-toggle click were added inside renderUsage, each render would
  // stack a listener and produce parity-dependent dead/inverted toggles. It must
  // be a single, static, one-time wiring.
  const src = await Deno.readTextFile("extension/options/options.js");
  const matches = src.match(/#usage-detail-toggle"\)\.addEventListener/g) ?? [];
  assertEquals(matches.length, 1, "usage-detail-toggle must be wired exactly once");
  // The single wiring must be OUTSIDE the renderUsage body (which is polled).
  const fn = src.match(/async function renderUsage\(\) \{[\s\S]*?\n\}/);
  assert(fn, "renderUsage must exist");
  assert(!fn[0].includes('#usage-detail-toggle").addEventListener'), "the toggle listener must NOT be inside renderUsage");
});
