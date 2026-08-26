// tests/activity-explorer.test.ts — CAP-FB-20260826-RECENT-ACTIVITY-FILTER-01.
// @ts-nocheck — unit tests run under Deno (fakes are intentionally dynamic).
//
// The Recent Activity search box / 'All agents' filter died on real profiles:
// the activity.list route enumerated EVERY store (master + named + background
// + sites) with no fault isolation and no bound, so a slow/failing store could
// hang the route past the MV3 worker's lifetime — the page's load promise then
// never settled, leaving an empty agent select and an inert search box.
// These tests pin the extracted route factory's resilience + bounds and the
// pure filter's contract.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ACTIVITY_STORE_CAPS,
  createActivityRoutes,
  filterActivityEntries,
} from "../extension/background/routes/activity.js";

// ── filterActivityEntries (the pure contract) ─────────────────────────────

const E = (over) => ({ ts: 1000, type: "task", ...over });

Deno.test("filterActivityEntries: most-recent-first + limit clamped to [1,2000]", () => {
  const entries = [E({ ts: 1 }), E({ ts: 3 }), E({ ts: 2 })];
  assertEquals(filterActivityEntries(entries, {}).map((e) => e.ts), [3, 2, 1]);
  // limit 0/NaN falls back, negative clamps to 1, huge clamps to 2000.
  assertEquals(filterActivityEntries([E({ ts: 1 }), E({ ts: 2 })], { limit: 0 }).length, 2);
  assertEquals(filterActivityEntries([E({ ts: 1 }), E({ ts: 2 })], { limit: -5 }).length, 1);
  assertEquals(
    filterActivityEntries(Array.from({ length: 2100 }, (_, i) => E({ ts: i })), { limit: 99999 }).length,
    2000,
  );
});

Deno.test("filterActivityEntries: agent filter is an exact source match", () => {
  const entries = [
    E({ ts: 1, source: "master" }),
    E({ ts: 2, source: "agent:paul" }),
    E({ ts: 3, source: "agent:paul2" }),
  ];
  const out = filterActivityEntries(entries, { agent: "agent:paul" });
  assertEquals(out.length, 1);
  assertEquals(out[0].source, "agent:paul");
});

Deno.test("filterActivityEntries: query is case-insensitive across the readable fields", () => {
  const entries = [
    E({ ts: 1, task: "Summarise paul.kinlan.me" }),
    E({ ts: 2, tool: "list_agents", args: "{}" }),
    E({ ts: 3, result: "grouped 12 tabs", source: "background:recipe:x", agentLabel: "Sorting Hat" }),
  ];
  assertEquals(filterActivityEntries(entries, { query: "PAUL" }).length, 1);
  assertEquals(filterActivityEntries(entries, { query: "list_agents" }).length, 1);
  assertEquals(filterActivityEntries(entries, { query: "sorting" }).length, 1);
  assertEquals(filterActivityEntries(entries, { query: "nomatch" }).length, 0);
  // Empty/whitespace query matches everything.
  assertEquals(filterActivityEntries(entries, { query: "   " }).length, 3);
});

Deno.test("filterActivityEntries: since/until bound by ts (inclusive)", () => {
  const entries = [E({ ts: 10 }), E({ ts: 20 }), E({ ts: 30 })];
  assertEquals(filterActivityEntries(entries, { since: 20 }).map((e) => e.ts), [30, 20]);
  assertEquals(filterActivityEntries(entries, { until: 20 }).map((e) => e.ts), [20, 10]);
  assertEquals(filterActivityEntries(entries, { since: 15, until: 25 }).map((e) => e.ts), [20]);
});

// ── createActivityRoutes (the resilient, bounded aggregation) ─────────────

function fakeDeps(over = {}) {
  const calls = { reads: [], backgroundReads: 0 };
  const store = (journal, { fail = false } = {}) => ({
    async get(key) {
      calls.reads.push(key);
      if (fail) throw new Error("corrupt store");
      return journal;
    },
  });
  const bgStore = (journal) => ({
    async get() {
      calls.backgroundReads++;
      return journal;
    },
  });
  const deps = {
    masterMemory: () => store([E({ ts: 5, task: "hub task" })]),
    namedAgentMemory: (id) => store([E({ ts: 4, task: `named ${id}` })]),
    backgroundAgentMemory: (id) => bgStore([E({ ts: 3, task: `bg ${id}` })]),
    siteMemory: (origin) => store([E({ ts: 2, task: `site ${origin}` })]),
    listNamedAgents: async () => [{ id: "Paul", name: "Paul" }],
    listNamedAgentIds: async () => ["paul"],
    listBackgroundAgentIds: async () => ["recipe:a"],
    listOrigins: async () => ["https://example.com"],
    slugifyAgentId: (id) => String(id).toLowerCase(),
    ...over,
  };
  return { deps, calls, store };
}

Deno.test("activity.list: aggregates master + named + background + sites with source tags", async () => {
  const { deps } = fakeDeps();
  const routes = createActivityRoutes(deps);
  const res = await routes["activity.list"]({});
  assertEquals(res.count, 4);
  assertEquals(res.total, 4);
  const bySource = new Map(res.entries.map((e) => [e.source, e]));
  assert(bySource.has("master"), "master present");
  assert(bySource.has("agent:paul"), "named agent tagged");
  assert(bySource.has("background:recipe:a"), "background agent tagged");
  assert(bySource.has("https://example.com"), "site tagged");
  // The named agent carries its REGISTRY display name.
  assertEquals(bySource.get("agent:paul").agentLabel, "Paul");
  // Most-recent-first.
  assertEquals(res.entries.map((e) => e.ts), [5, 4, 3, 2]);
});

Deno.test("activity.list: a corrupt store contributes nothing but never fails the route", async () => {
  const { deps, store } = fakeDeps();
  deps.backgroundAgentMemory = () => store([], { fail: true });
  const routes = createActivityRoutes(deps);
  const res = await routes["activity.list"]({});
  // Master + named + site survive the background store's failure.
  assertEquals(res.count, 3);
  assert(!res.entries.some((e) => e.source.startsWith("background:")));
});

Deno.test("activity.list: a failing lister degrades that class, not the route", async () => {
  const { deps } = fakeDeps();
  deps.listNamedAgents = async () => { throw new Error("registry read failed"); };
  deps.listNamedAgentIds = async () => { throw new Error("opfs list failed"); };
  deps.listOrigins = async () => { throw new Error("kv read failed"); };
  const routes = createActivityRoutes(deps);
  const res = await routes["activity.list"]({});
  // Master + background still aggregate.
  assertEquals(res.count, 2);
  assert(res.entries.some((e) => e.source === "master"));
  assert(res.entries.some((e) => e.source === "background:recipe:a"));
});

Deno.test("activity.list: store enumeration is bounded per class", async () => {
  const { deps, calls } = fakeDeps();
  // More background agents than the cap (the real-profile flood shape).
  const flood = Array.from({ length: ACTIVITY_STORE_CAPS.backgroundAgents + 25 }, (_, i) => `recipe:${i}`);
  deps.listBackgroundAgentIds = async () => flood;
  const routes = createActivityRoutes(deps);
  const res = await routes["activity.list"]({});
  assertEquals(calls.backgroundReads, ACTIVITY_STORE_CAPS.backgroundAgents);
  // Each enumerated store still contributes its entry.
  assertEquals(
    res.entries.filter((e) => e.source.startsWith("background:")).length,
    ACTIVITY_STORE_CAPS.backgroundAgents,
  );
});

Deno.test("activity.list: each journal is capped before the global merge", async () => {
  const { deps } = fakeDeps();
  const big = Array.from({ length: 500 }, (_, i) => E({ ts: i, task: `t${i}` }));
  deps.masterMemory = () => ({ async get() { return big; } });
  deps.listNamedAgentIds = async () => [];
  deps.listBackgroundAgentIds = async () => [];
  deps.listOrigins = async () => [];
  const routes = createActivityRoutes(deps);
  const res = await routes["activity.list"]({});
  assertEquals(res.total, ACTIVITY_STORE_CAPS.perStoreEntries);
  // The cap keeps the MOST RECENT entries.
  assertEquals(res.entries[0].ts, 499);
  assertEquals(res.entries[res.entries.length - 1].ts, 499 - ACTIVITY_STORE_CAPS.perStoreEntries + 1);
});

Deno.test("activity.list: agent/query/window filters pass through to the merged set", async () => {
  const { deps } = fakeDeps();
  const routes = createActivityRoutes(deps);
  const only = await routes["activity.list"]({ agent: "master" });
  assertEquals(only.count, 1);
  assertEquals(only.entries[0].source, "master");
  const q = await routes["activity.list"]({ query: "site" });
  assertEquals(q.count, 1);
  assertEquals(q.entries[0].source, "https://example.com");
  const win = await routes["activity.list"]({ since: 4 });
  assertEquals(win.entries.map((e) => e.ts), [5, 4]);
});
