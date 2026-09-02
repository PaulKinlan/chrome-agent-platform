import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createAlarmPermissionLifecycle } from "../extension/lib/alarm-permission-lifecycle.js";

function event() {
  const listeners: Array<(value: unknown) => unknown> = [];
  return {
    listeners,
    addListener(listener: (value: unknown) => unknown) {
      listeners.push(listener);
    },
    removeListener(listener: (value: unknown) => unknown) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    hasListener(listener: (value: unknown) => unknown) {
      return listeners.includes(listener);
    },
    fire(value: unknown) {
      return [...listeners].map((listener) => listener(value));
    },
  };
}

function harness({ alarmsAtStart = false, granted = true } = {}) {
  const permissionAdded = event();
  const permissionRemoved = event();
  const alarmEvent = event();
  const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
  let reloads = 0;
  const chromeApi: any = {
    permissions: {
      onAdded: permissionAdded,
      onRemoved: permissionRemoved,
      contains: async ({ permissions }: { permissions: string[] }) =>
        granted && permissions.length === 1 && permissions[0] === "alarms",
    },
    runtime: { reload: () => reloads += 1 },
  };
  if (alarmsAtStart) chromeApi.alarms = { onAlarm: alarmEvent };
  const runs: unknown[] = [];
  const onAlarm = (alarm: unknown) => runs.push(alarm);
  const lifecycle = createAlarmPermissionLifecycle({
    chromeApi,
    onAlarm,
    setTimer: ((fn: () => void) => {
      timers.push({ fn, cancelled: false });
      return timers.length - 1;
    }) as any,
    clearTimer: ((id: number) => {
      if (timers[id]) timers[id].cancelled = true;
    }) as any,
    reloadDelayMs: 0,
  });
  return {
    chromeApi,
    lifecycle,
    permissionAdded,
    permissionRemoved,
    alarmEvent,
    timers,
    onAlarm,
    runs,
    reloads: () => reloads,
  };
}

Deno.test("alarm lifecycle: zero-permission boot neither listens nor reloads", () => {
  const h = harness();
  assertEquals(h.lifecycle.status().listenerRegistered, false);
  assertEquals(h.timers.length, 0);
  assertEquals(h.reloads(), 0);
});

Deno.test("alarm lifecycle: late grant attaches exactly once when API appears", () => {
  const h = harness();
  h.chromeApi.alarms = { onAlarm: h.alarmEvent };
  h.permissionAdded.fire({ permissions: ["alarms"] });
  h.permissionAdded.fire({ permissions: ["alarms"] });
  h.lifecycle.ensureAlarmListener();
  assertEquals(h.alarmEvent.listeners, [h.onAlarm]);
  assertEquals(h.timers.length, 0);
});

Deno.test("alarm lifecycle: confirmed late grant schedules exactly one reload when API is absent", async () => {
  const h = harness();
  h.permissionAdded.fire({ permissions: ["alarms"] });
  const notified = await h.lifecycle.notifyGrantedFromOwner();
  h.permissionAdded.fire({ permissions: ["alarms"] });
  assertEquals(notified.granted, true);
  assertEquals(notified.reloadScheduled, true);
  assertEquals(h.timers.length, 1);
  h.timers[0].fn();
  h.timers[0].fn();
  assertEquals(h.reloads(), 1);
});

Deno.test("alarm lifecycle: unconfirmed notification never reloads", async () => {
  const h = harness({ granted: false });
  const result = await h.lifecycle.notifyGrantedFromOwner();
  assertEquals(result.ok, false);
  assertEquals(result.granted, false);
  assertEquals(h.timers.length, 0);
});

Deno.test("alarm lifecycle: removal detaches listener and a later grant can attach once", () => {
  const h = harness({ alarmsAtStart: true });
  assertEquals(h.alarmEvent.listeners, [h.onAlarm]);
  h.permissionRemoved.fire({ permissions: ["alarms"] });
  assertEquals(h.lifecycle.status().disarmed, true);
  assertEquals(h.alarmEvent.listeners, []);
  h.permissionAdded.fire({ permissions: ["alarms"] });
  assertEquals(h.alarmEvent.listeners, [h.onAlarm]);
});

Deno.test("alarm lifecycle: removal cancels a pending fallback reload", () => {
  const h = harness();
  h.permissionAdded.fire({ permissions: ["alarms"] });
  assertEquals(h.timers.length, 1);
  h.permissionRemoved.fire({ permissions: ["alarms"] });
  assertEquals(h.timers[0].cancelled, true);
  h.timers[0].fn();
  assertEquals(h.reloads(), 0);
});

Deno.test("alarm lifecycle: unrelated permission changes are ignored", () => {
  const h = harness();
  h.permissionAdded.fire({ permissions: ["storage"] });
  h.permissionRemoved.fire({ permissions: ["tabs"] });
  assertEquals(h.timers.length, 0);
  assertEquals(h.lifecycle.status().disarmed, false);
});

Deno.test("alarm lifecycle: alarms stay mandatory — Settings requests optional capabilities and verifies every grant", async () => {
  const optionsSource = await Deno.readTextFile(
    new URL("../extension/options/options.js", import.meta.url),
  );
  const workerSource = await Deno.readTextFile(
    new URL("../extension/background/service-worker.js", import.meta.url),
  );
  const lifecycleSource = await Deno.readTextFile(
    new URL("../extension/lib/alarm-permission-lifecycle.js", import.meta.url),
  );
  // OPTIONAL + JIT model (owner directive 2026-08-29): Settings IS the
  // request surface — requestCapability fires from the owner's click (a
  // genuine user gesture the SW can never provide). Alarms stay MANDATORY:
  // the scheduler registers chrome.alarms.onAlarm at boot and scheduled runs
  // die without it, so alarms are never runtime-requestable.
  assertStringIncludes(
    optionsSource,
    "await requestCapability(cap.id)",
    "the Permissions section requests optional capabilities from the owner's click",
  );
  assertStringIncludes(
    optionsSource,
    "await capabilityState(cap.id)",
    "the Permissions section VERIFIES each capability (live three-state display)",
  );
  // CAP-FB-20260830-SETTINGS-HOOKS-PERMISSIONS-TABLES-01: the mandatory boot
  // set is the fixed "Always on" group — text, never a control.
  assertStringIncludes(
    optionsSource,
    '"required", "Always on"',
    "the mandatory boot set is displayed as the fixed Always on group",
  );
  assertStringIncludes(
    optionsSource,
    'row.setAttribute("action-label", "Always on")',
    "a mandatory permission row shows Always on and no control",
  );
  // The worker-side activation route remains (harmless; the lifecycle listener
  // still owns disarm/re-arm on any permission change).
  assertStringIncludes(
    workerSource,
    'async "alarms.permission-granted"(_message, context)',
  );
  assertStringIncludes(workerSource, "requireSettingsSender(context)");
  assertStringIncludes(workerSource, "await disarmScheduledAlarms()");
  assert(
    !lifecycleSource.includes("permissions.request"),
    "worker lifecycle never requests permission",
  );
});
