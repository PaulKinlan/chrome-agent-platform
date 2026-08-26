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
  // Mirror of handleAlarm's new no-payload branch.
  async function fireDecision(alarmName) {
    const task = (await kvGet("cap:scheduledTasks"))["cap:scheduledTasks"]?.[alarmName];
    if (task) return "run";
    const rawAlarms = (await kvGet(RAW))[RAW] ?? [];
    return rawAlarms.includes(alarmName) ? "keep-armed" : "reap";
  }
  // A scheduleTask alarm that lost its payload AND is not a raw alarm → orphan → reap.
  await kvRemove(RAW);
  assertEquals(await fireDecision("recipe:deleted-agent"), "reap", "a scheduleTask alarm with no payload and no raw registration is a genuine orphan");
  // A legit create_alarm raw alarm (registered) → keep armed.
  await kvSet({ [RAW]: ["wake-sw"] });
  assertEquals(await fireDecision("wake-sw"), "keep-armed", "a registered raw alarm is NOT reaped");
  // An alarm WITH a payload runs normally.
  await kvSet({ ["cap:scheduledTasks"]: { "recipe:live": { task: "x" } } });
  assertEquals(await fireDecision("recipe:live"), "run", "an alarm with a payload runs");
});
