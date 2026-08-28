// @ts-nocheck
// Orphaned-scheduled-alarm lifecycle KATs (owner P1, surfaced by observability):
// (a) create_alarm registers the raw alarm in cap:rawAlarms (so the fire-time
//     orphan reaper leaves legit raw alarms armed); (b) clear_alarm removes it;
// (c) the fire-time distinguisher — a no-payload alarm NOT in the registry is a
//     genuine orphan (reaped), one IN the registry is a legit raw alarm (kept).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { browserToolset } from "../extension/lib/browser-tools.js";
import { kvGet, kvSet, kvRemove } from "../extension/lib/kv.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

const store = new Map();
const granted = new Set(["storage", "alarms"]);
const armedAlarms = new Map(); // name -> info

function reset() {
  store.clear();
  granted.clear();
  granted.add("storage");
  granted.add("alarms");
  armedAlarms.clear();
  clearRunFence();
}

globalThis.chrome = {
  permissions: {
    contains: async ({ permissions }) => (permissions ?? []).every((p) => granted.has(p)),
  },
  storage: {
    local: {
      get: async (k) => (k === null || k === undefined ? Object.fromEntries(store) : { [k]: store.get(k) }),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      remove: async (keys) => { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
    },
  },
  alarms: {
    create: async (name, info) => { armedAlarms.set(name, info); },
    clear: async (name) => { const had = armedAlarms.delete(name); return had; },
    get: async (name) => armedAlarms.get(name) ?? null,
    getAll: async () => [...armedAlarms.entries()].map(([name, info]) => ({ name, ...info })),
  },
};

function tools() {
  return browserToolset(false);
}
const RAW = "cap:rawAlarms";

Deno.test("alarm-orphan: create_alarm registers the raw alarm in cap:rawAlarms; clear_alarm removes it", async () => {
  reset();
  await kvRemove(RAW);
  const r = await tools().create_alarm.execute({ name: "wake-sw", periodInMinutes: 15 });
  assertEquals(r.ok, true);
  assert((await kvGet(RAW))[RAW]?.includes("wake-sw"), "create_alarm registers the raw alarm");

  const c = await tools().clear_alarm.execute({ name: "wake-sw" });
  assertEquals(c.cleared, true);
  assert(!((await kvGet(RAW))[RAW] ?? []).includes("wake-sw"), "clear_alarm removes it from the registry");
});

Deno.test("alarm-orphan: the fire-time distinguisher — orphan reaped, registered raw alarm kept", async () => {
  reset();
  // Mirror of handleAlarm's new no-payload branch (with the boundedness prune).
  async function fireDecision(alarmName) {
    const task = (await kvGet("cap:scheduledTasks"))["cap:scheduledTasks"]?.[alarmName];
    if (task) return "run";
    const rawAlarms = (await kvGet(RAW))[RAW] ?? [];
    if (rawAlarms.includes(alarmName)) {
      const stillArmed = await chrome.alarms.get(alarmName);
      if (!stillArmed) {
        await kvSet({ [RAW]: rawAlarms.filter((n) => n !== alarmName) });
        return "prune";
      }
      return "keep-armed";
    }
    return "reap";
  }
  // A scheduleTask alarm that lost its payload AND is not a raw alarm → orphan → reap.
  await kvRemove(RAW);
  assertEquals(await fireDecision("recipe:deleted-agent"), "reap", "a scheduleTask alarm with no payload and no raw registration is a genuine orphan");
  // A legit create_alarm PERIODIC raw alarm (registered, still armed) → keep armed + entry.
  await kvSet({ [RAW]: ["wake-sw"] });
  armedAlarms.set("wake-sw", { periodInMinutes: 15 });
  assertEquals(await fireDecision("wake-sw"), "keep-armed", "a registered recurring raw alarm is NOT reaped");
  // An alarm WITH a payload runs normally.
  await kvSet({ ["cap:scheduledTasks"]: { "recipe:live": { task: "x" } } });
  assertEquals(await fireDecision("recipe:live"), "run", "an alarm with a payload runs");
});

Deno.test("alarm-orphan: boundedness — fired one-shot raw alarm is pruned from the registry; recurring keeps its entry across fires", async () => {
  reset();
  // Mirror of handleAlarm's raw branch prune (alarms.get(name) === null ⇒ one-shot already auto-removed).
  async function fireRaw(alarmName) {
    const rawAlarms = (await kvGet(RAW))[RAW] ?? [];
    if (!rawAlarms.includes(alarmName)) return "reap";
    const stillArmed = await chrome.alarms.get(alarmName);
    if (!stillArmed) await kvSet({ [RAW]: rawAlarms.filter((n) => n !== alarmName) });
    return stillArmed ? "keep-armed" : "pruned";
  }
  // One-shot: registered via the real tool, then Chrome auto-removes it on fire.
  await tools().create_alarm.execute({ name: "once", delayInMinutes: 0.1 });
  assert((await kvGet(RAW))[RAW]?.includes("once"), "registered before create");
  armedAlarms.delete("once"); // simulate Chrome auto-removal after the one-shot fired
  assertEquals(await fireRaw("once"), "pruned");
  assert(!((await kvGet(RAW))[RAW] ?? []).includes("once"), "registry no longer holds the fired one-shot (bounded)");
  // Recurring: entry survives repeated fires while the alarm stays armed.
  await tools().create_alarm.execute({ name: "every-15", periodInMinutes: 15 });
  assertEquals(await fireRaw("every-15"), "keep-armed");
  assertEquals(await fireRaw("every-15"), "keep-armed");
  assert((await kvGet(RAW))[RAW]?.includes("every-15"), "recurring raw alarm keeps its entry across fires");
  // Registry only ever holds live raw alarms.
  assertEquals((await kvGet(RAW))[RAW], ["every-15"]);
});

// ──────────────────────────────────────────────────────────────────────────
// Non-blocking delete (owner: deleting a background agent must be instant).
// ──────────────────────────────────────────────────────────────────────────
Deno.test("cancelScheduledTaskBackground: returns immediately, marks cancelling, aborts the live run, cleans up async", async () => {
  const mod = await import("../extension/lib/scheduler.js");
  // reset the module state via a fresh dynamic import each run is not possible;
  // instead exercise the shape contract: the background cancel resolves its
  // handle synchronously (no await needed) with { stopping: true }.
  const handle = mod.cancelScheduledTaskBackground("recipe:test-bg-agent");
  assert(handle.stopping === true, "must report stopping immediately");
  assert(handle.name === "recipe:test-bg-agent", "must echo the name");
  // The cleanup promise must settle without throwing (no task = no-op path).
  await handle.promise;
});

Deno.test("cancelScheduledTaskBackground: a RUNNING task's delete is NON-BLOCKING (never the 5s termination dance)", async () => {
  reset();
  const mod = await import("../extension/lib/scheduler.js");
  const name = "recipe:running-bg-agent";
  // A real scheduled task...
  const scheduled = await mod.scheduleTask({ task: "long-running agent prompt", delayMs: 3_600_000, name });
  assertEquals(scheduled.name, name);
  // ...with a LIVE run registered (tryAcquireInflight registers the run in the
  // scheduler's activeRuns map exactly as a real run does) that NEVER
  // acknowledges termination (a hung model round-trip).
  const acquire = await mod.tryAcquireInflight(name);
  assertEquals(acquire.acquired, true, "the simulated live run must acquire the in-flight lock");
  const t0 = Date.now();
  const handle = mod.cancelScheduledTaskBackground(name);
  assert(handle.stopping === true, "the handle must return synchronously (stopping)");
  await handle.promise; // resolves WITHOUT the live run ever terminating
  const elapsed = Date.now() - t0;
  assert(
    elapsed < 2_000,
    `background cancel must not block on the run's termination (took ${elapsed}ms; the blocking cancel waits ${5_000}ms)`,
  );
  assert(acquire.controller.signal.aborted === true, "the live run's controller must be aborted NOW");
  const tasks = await mod.listScheduledTasks();
  assert(!tasks.some((t) => t.name === name), "the cancelled task must be reaped from the store despite the run never terminating");
});
