// Unit tests for lib/agent-seeds.js (chrome-agent-platform-wz6i): the seed
// records that merge built-in recipe-backed background agents into the
// named-agent store, the overlay/visibility rules, and the extracted startup
// re-key that moves built-ins from `recipe:<id>` to `agent:<id>` schedules.
// Pure module — no chrome/OPFS mock needed.
// @ts-nocheck — the seed/skill fixtures are intentionally dynamic (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  builtinBackgroundSeeds,
  createBuiltinScheduleRekey,
  isBuiltinBackgroundSkill,
  isSeedRecord,
  isVisibleAgentRow,
  seedOverlay,
  seedRecordForSkill,
} from "../extension/lib/agent-seeds.js";

const SORTING_HAT = {
  id: "auto-group-by-domain",
  name: "Sorting Hat",
  mode: "background",
  description: "Group open tabs by domain into colour-coded collapsed groups.",
  schedule: { periodInMinutes: 30 },
  prompt: "Group open tabs into tab groups by registered domain.",
};
const PRICE_WATCHER = {
  id: "price-watcher",
  name: "Price watcher",
  mode: "background",
  description: "Watch pages for change.",
  schedule: { periodInMinutes: 60 },
  prompt: "Watch the page.",
};
const ON_DEMAND = {
  id: "tab-hygiene",
  name: "Tab hygiene",
  mode: "on-demand",
  description: "Tidy tabs.",
};

Deno.test("seedRecordForSkill maps a background skill to an agent-shaped seed", () => {
  const seed = seedRecordForSkill(SORTING_HAT);
  assertEquals(seed.id, "auto-group-by-domain");
  assertEquals(seed.name, "Sorting Hat");
  assertEquals(seed.role, "");
  assertEquals(seed.skills, [
    {
      id: "auto-group-by-domain",
      name: "Sorting Hat",
      description: SORTING_HAT.description,
    },
  ]);
  assertEquals(seed.builtin, true);
  assertEquals(seed.seeded, true);
  // The legacy runtime identity rides the record so runs/memory/attribution
  // are byte-identical after the merge.
  assertEquals(seed.surfaceRef, "background:auto-group-by-domain");
  assertEquals(seed.memoryKey, "recipe:auto-group-by-domain");
  assertEquals(seed.defaultSchedule, { periodInMinutes: 30 });
  // A seed NEVER carries a live schedule — that arrives via task enrichment.
  assertEquals(seed.schedule, undefined);
});

Deno.test("seedRecordForSkill refuses non-background skills and junk", () => {
  assertEquals(seedRecordForSkill(ON_DEMAND), null);
  assertEquals(seedRecordForSkill(null), null);
  assertEquals(seedRecordForSkill({ mode: "background" }), null);
});

Deno.test("seedRecordForSkill: a skill with no schedule seeds with null defaultSchedule", () => {
  const seed = seedRecordForSkill({ ...PRICE_WATCHER, schedule: undefined });
  assertEquals(seed.defaultSchedule, null);
});

Deno.test("builtinBackgroundSeeds derives seeds for the built-in background registry only", () => {
  const seeds = builtinBackgroundSeeds([SORTING_HAT, ON_DEMAND, PRICE_WATCHER]);
  assertEquals(seeds.map((s) => s.id), ["auto-group-by-domain", "price-watcher"]);
});

Deno.test("isBuiltinBackgroundSkill: built-in yes, custom duplicate no", () => {
  const builtins = [SORTING_HAT];
  assertEquals(isBuiltinBackgroundSkill(SORTING_HAT, builtins), true);
  const customCopy = { ...SORTING_HAT, id: "auto-group-by-domain-custom-123" };
  assertEquals(isBuiltinBackgroundSkill(customCopy, builtins), false);
  assertEquals(isBuiltinBackgroundSkill(ON_DEMAND, builtins), false);
  assertEquals(isBuiltinBackgroundSkill(null, builtins), false);
});

Deno.test("seedOverlay: persisted records win an id collision, seeds fill the rest sorted", () => {
  const persisted = [
    { id: "zzz-agent", name: "Zed" },
    { id: "auto-group-by-domain", name: "My Hat", seeded: false },
  ];
  const seeds = builtinBackgroundSeeds([SORTING_HAT, PRICE_WATCHER]);
  const out = seedOverlay(persisted, seeds);
  assertEquals(out.length, 3);
  // The persisted Sorting Hat wins — the seed must NOT overwrite or duplicate it.
  assertEquals(out.filter((a) => a.id === "auto-group-by-domain"), [{ id: "auto-group-by-domain", name: "My Hat", seeded: false }]);
  // Persisted order preserved, seeds appended sorted by name.
  assertEquals(out[0].id, "zzz-agent");
  assertEquals(out[2].id, "price-watcher");
});

Deno.test("seedOverlay tolerates junk input", () => {
  assertEquals(seedOverlay(null, null), []);
  assertEquals(seedOverlay([{ name: "no id" }], [{ name: "no id either" }]), []);
});

Deno.test("isVisibleAgentRow: a DISABLED seed is a template, never an agent row", () => {
  const seed = seedRecordForSkill(SORTING_HAT);
  assertEquals(isSeedRecord(seed), true);
  assertEquals(isVisibleAgentRow(seed), false);
  assertEquals(isVisibleAgentRow({ ...seed, enabled: true }), true);
  assertEquals(isVisibleAgentRow({ ...seed, enabled: false }), false);
  // Persisted agents are always rows, enabled flag or not.
  assertEquals(isVisibleAgentRow({ id: "x", name: "X" }), true);
});

// ---- the startup re-key (the REAL migration, driven with fakes) ----

function makeRekeyHarness(tasks) {
  const calls = [];
  const state = { tasks: tasks.map((t) => ({ ...t })) };
  const rekey = createBuiltinScheduleRekey({
    listScheduledTasks: async () => state.tasks.filter((t) => !t.cancelling),
    scheduleTask: async (payload) => {
      calls.push({ op: "mint", payload });
      state.tasks.push({ ...payload, name: payload.name });
      if (payload.failMint) throw new Error("mint boom");
      return { when: payload.at };
    },
    cancelScheduledTaskBackground: (name) => {
      calls.push({ op: "cancel", name });
      return {
        marked: (async () => {
          const t = state.tasks.find((x) => x.name === name);
          if (t?.failCancel) throw new Error("cancel boom");
          if (t) t.cancelling = true;
          return { ok: true };
        })(),
      };
    },
    isBuiltinBackgroundId: (id) => id === "auto-group-by-domain" || id === "price-watcher",
  });
  return { rekey, calls, state };
}

const LEGACY_TASK = {
  name: "recipe:auto-group-by-domain",
  task: SORTING_HAT.prompt,
  at: Date.now() + 25 * 60 * 1000,
  periodInMinutes: 30,
  attachments: [],
  owner: { agentRole: "background:auto-group-by-domain", agentSurfaceRef: "background:auto-group-by-domain" },
};

Deno.test("rekey: a built-in's recipe: task is re-minted as agent:<id> with the payload preserved verbatim", async () => {
  const { rekey, calls } = makeRekeyHarness([LEGACY_TASK]);
  const r = await rekey();
  assertEquals(r.errors, []);
  assertEquals(r.migrated, [{ from: "recipe:auto-group-by-domain", to: "agent:auto-group-by-domain" }]);
  // Mint BEFORE cancel: enabled state can never be lost in between.
  assertEquals(calls.map((c) => c.op), ["mint", "cancel"]);
  const mint = calls[0].payload;
  assertEquals(mint.name, "agent:auto-group-by-domain");
  assertEquals(mint.task, SORTING_HAT.prompt);
  assertEquals(mint.at, LEGACY_TASK.at); // the SAME next-fire, not a restarted period
  assertEquals(mint.periodInMinutes, 30);
  assertEquals(mint.owner, LEGACY_TASK.owner);
  assertEquals(calls[1].name, "recipe:auto-group-by-domain");
});

Deno.test("rekey: custom duplicates and non-recipe tasks are never touched", async () => {
  const custom = { ...LEGACY_TASK, name: "recipe:auto-group-by-domain-custom-99" };
  const other = { name: "task-123", task: "one-off", at: Date.now() + 1000 };
  const { rekey, calls } = makeRekeyHarness([custom, other]);
  const r = await rekey();
  assertEquals(r.migrated, []);
  assertEquals(r.errors, []);
  assertEquals(calls, []);
});

Deno.test("rekey: an already-cancelling legacy task is left to the teardown", async () => {
  const { rekey, calls } = makeRekeyHarness([{ ...LEGACY_TASK, cancelling: true }]);
  const r = await rekey();
  assertEquals(r.migrated, []);
  assertEquals(calls, []);
});

Deno.test("rekey: a mint failure leaves the legacy task LIVE and records the error", async () => {
  const { rekey, calls, state } = makeRekeyHarness([LEGACY_TASK]);
  // Sabotage the NEXT mint by wrapping scheduleTask's payload check.
  const sabotaged = createBuiltinScheduleRekey({
    listScheduledTasks: async () => state.tasks,
    scheduleTask: async () => {
      calls.push({ op: "mint" });
      throw new Error("alarm capacity");
    },
    cancelScheduledTaskBackground: (name) => {
      calls.push({ op: "cancel", name });
      return { marked: Promise.resolve({ ok: true }) };
    },
    isBuiltinBackgroundId: () => true,
  });
  void rekey;
  const r = await sabotaged();
  assertEquals(r.migrated, []);
  assertEquals(r.errors.length, 1);
  // The legacy task was never cancelled — the agent stays enabled on the old path.
  assertEquals(calls.map((c) => c.op), ["mint"]);
  assertEquals(state.tasks[0].cancelling, undefined);
});

Deno.test("rekey: a cancel failure after mint records the error and keeps both", async () => {
  const { rekey, state } = makeRekeyHarness([{ ...LEGACY_TASK, failCancel: true }]);
  const r = await rekey();
  assertEquals(r.migrated, []);
  assertEquals(r.errors.length, 1);
  assert(r.errors[0].error.includes("cancel failed after mint"));
  // The unified schedule exists AND the legacy task is still live (retried next startup).
  assert(state.tasks.some((t) => t.name === "agent:auto-group-by-domain"));
  assertEquals(state.tasks.find((t) => t.name === "recipe:auto-group-by-domain")?.cancelling, undefined);
});

Deno.test("rekey: a past-due legacy `at` falls forward to the period, never the past", async () => {
  const past = { ...LEGACY_TASK, at: Date.now() - 60_000, periodInMinutes: 30 };
  const { rekey, calls } = makeRekeyHarness([past]);
  const before = Date.now();
  await rekey();
  const mintAt = calls[0].payload.at;
  assert(mintAt >= before + 29 * 60 * 1000, `mint at ${mintAt} should be ~30min out`);
});

Deno.test("rekey: idempotent — a second run has nothing to migrate", async () => {
  const { rekey, calls } = makeRekeyHarness([LEGACY_TASK]);
  await rekey();
  const r2 = await rekey();
  assertEquals(r2.migrated, []);
  assertEquals(r2.errors, []);
  assertEquals(calls.length, 2); // exactly one mint + one cancel across both runs
});

// ---- the background-agent.set BUILT-IN branch (the REAL route logic) ----

import { createBuiltinBackgroundSet } from "../extension/lib/agent-seeds.js";

function makeSetHarness({ applyResult = { ok: true, scheduled: true, name: "agent:auto-group-by-domain", periodInMinutes: 30 } } = {}) {
  const calls = [];
  const setEnabled = createBuiltinBackgroundSet({
    applyAgentSchedule: async (id, period, task) => {
      calls.push({ op: "apply", id, period, task });
      return applyResult;
    },
    subscribeHook: async ({ hookId, recipeId }) => {
      calls.push({ op: "subscribe", hookId, recipeId });
    },
    unsubscribeHook: async ({ hookId, recipeId }) => {
      calls.push({ op: "unsubscribe", hookId, recipeId });
    },
    cancelScheduledTaskBackground: (name) => {
      calls.push({ op: "cancelLegacy", name });
      return { marked: Promise.resolve({ ok: true }) };
    },
  });
  return { setEnabled, calls };
}

const HOOKED_HAT = { ...SORTING_HAT, hooks: ["tabs.onCreated", "tabs.onUpdated"] };

Deno.test("builtin set ENABLE: hooks first, then the unified agent schedule with the skill prompt, then legacy cancel", async () => {
  const { setEnabled, calls } = makeSetHarness();
  const r = await setEnabled(HOOKED_HAT, true);
  assertEquals(r, { ok: true, enabled: true, id: "auto-group-by-domain", name: "agent:auto-group-by-domain", periodInMinutes: 30 });
  assertEquals(calls.map((c) => c.op), ["subscribe", "subscribe", "apply", "cancelLegacy"]);
  assertEquals(calls[2], { op: "apply", id: "auto-group-by-domain", period: 30, task: SORTING_HAT.prompt });
  assertEquals(calls[3], { op: "cancelLegacy", name: "recipe:auto-group-by-domain" });
  // Hooks ride the skill's id, as the legacy path did.
  assertEquals(calls[0].recipeId, "auto-group-by-domain");
});

Deno.test("builtin set ENABLE: no schedule on the skill is an error BEFORE any hook or schedule write", async () => {
  const { setEnabled, calls } = makeSetHarness();
  const r = await setEnabled({ ...SORTING_HAT, schedule: undefined }, true);
  assertEquals(r.ok, false);
  assert(r.error.includes("no schedule"));
  assertEquals(calls, []);
});

Deno.test("builtin set ENABLE: a schedule failure propagates and the legacy task is NOT cancelled", async () => {
  const { setEnabled, calls } = makeSetHarness({ applyResult: { ok: false, error: "agent deleted mid-schedule" } });
  const r = await setEnabled(HOOKED_HAT, true);
  assertEquals(r, { ok: false, error: "agent deleted mid-schedule" });
  assertEquals(calls.some((c) => c.op === "cancelLegacy"), false);
});

Deno.test("builtin set DISABLE: cancels the unified schedule, unsubscribes the hooks, and belts-and-braces cancels the legacy task", async () => {
  const { setEnabled, calls } = makeSetHarness({ applyResult: { ok: true, scheduled: false, name: "agent:auto-group-by-domain", stopping: true } });
  const r = await setEnabled(HOOKED_HAT, false);
  assertEquals(r, { ok: true, enabled: false, id: "auto-group-by-domain", stopping: true, name: "agent:auto-group-by-domain" });
  assertEquals(calls.map((c) => c.op), ["apply", "unsubscribe", "unsubscribe", "cancelLegacy"]);
  assertEquals(calls[0], { op: "apply", id: "auto-group-by-domain", period: null, task: undefined });
});

Deno.test("builtin set DISABLE: a teardown failure propagates honestly", async () => {
  const { setEnabled } = makeSetHarness({ applyResult: { ok: false, error: "schedule removal failed before it was durable" } });
  const r = await setEnabled(HOOKED_HAT, false);
  assertEquals(r.ok, false);
  assert(r.error.includes("durable"));
});
