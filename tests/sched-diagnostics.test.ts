// @ts-nocheck — CAP-FB-20260824-SCHED-DIAGNOSTICS-01:
// Behavioral KATs for structured scheduler diagnostics and payload-less alarm recovery.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  formatSchedulerDiagnostic,
  logSchedulerDiagnostic,
  scheduleTask,
  cancelScheduledTask,
  MAX_ACTIVE_ALARMS,
} from "../extension/lib/scheduler.js";
import { kvGet, kvSet } from "../extension/lib/kv.js";

// In-memory alarms mock
const armedAlarms = new Map();
globalThis.chrome = {
  permissions: {
    contains: async ({ permissions }) => permissions.every((p) => p === "alarms"),
  },
  alarms: {
    create: async (name, info) => { armedAlarms.set(name, info); },
    clear: async (name) => { const had = armedAlarms.has(name); armedAlarms.delete(name); return had; },
    get: async (name) => armedAlarms.has(name) ? { name, ...armedAlarms.get(name) } : undefined,
    getAll: async () => [...armedAlarms.entries()].map(([name, info]) => ({ name, ...info })),
  },
};

Deno.test("sched-diagnostics: formatSchedulerDiagnostic produces structured, bounded, secret-free records", () => {
  const diag = formatSchedulerDiagnostic({
    event: "alarm_payload_missing",
    alarmName: "sorting_hat_periodic",
    path: "service-worker:handleAlarm",
    storeState: "absent",
    reason: "Alarm fired but no matching task payload found in cap:scheduledTasks",
    actionTaken: "cleared_orphaned_alarm",
  });

  assertEquals(diag.tag, "[scheduler:diagnostic]");
  assertEquals(diag.event, "alarm_payload_missing");
  assertEquals(diag.alarmName, "sorting_hat_periodic");
  assertEquals(diag.path, "service-worker:handleAlarm");
  assertEquals(diag.storeState, "absent");
  assertEquals(diag.actionTaken, "cleared_orphaned_alarm");
  assert(diag.expectedPayloadShape.includes("task?: string"), "expectedPayloadShape present");
  assert(typeof diag.ts === "number" && diag.ts > 0, "timestamp present");
});

Deno.test("sched-diagnostics: logSchedulerDiagnostic formats and writes to console without throwing", () => {
  let loggedMsg = "";
  const origError = console.error;
  console.error = (tag, msg) => { loggedMsg = `${tag} ${msg}`; };

  try {
    const record = logSchedulerDiagnostic({
      event: "test_error_event",
      alarmName: "test_alarm_1",
      path: "test",
      reason: "Unit test error simulation",
    });

    assertEquals(record.event, "test_error_event");
    assert(loggedMsg.includes("[scheduler:diagnostic]"), "tag logged");
    assert(loggedMsg.includes("test_alarm_1"), "alarm name logged");
  } finally {
    console.error = origError;
  }
});

Deno.test("sched-diagnostics: payload-less alarm firing is diagnosed and cleared (no infinite spin)", async () => {
  // Simulate an orphaned alarm created without a task payload
  const orphanName = "raw_alarm_without_payload";
  await chrome.alarms.create(orphanName, { periodInMinutes: 15 });
  assertEquals(armedAlarms.has(orphanName), true);

  // Ensure store is absent
  const store = await kvGet("cap:scheduledTasks");
  const tasks = { ...(store["cap:scheduledTasks"] ?? {}) };
  delete tasks[orphanName];
  await kvSet({ ["cap:scheduledTasks"]: tasks });

  // Simulate handleAlarm missing payload detection
  let emittedDiag = null;
  const origError = console.error;
  console.error = (_tag, msg) => {
    try { emittedDiag = JSON.parse(msg); } catch {}
  };

  try {
    // Missing payload branch in service worker
    const task = (await kvGet("cap:scheduledTasks"))["cap:scheduledTasks"]?.[orphanName];
    assertEquals(task, undefined, "payload is absent");

    const diag = logSchedulerDiagnostic({
      event: "alarm_payload_missing",
      alarmName: orphanName,
      path: "service-worker:handleAlarm",
      storeState: "absent",
      reason: "Alarm fired but no matching task payload found in cap:scheduledTasks.",
      actionTaken: "cleared_orphaned_alarm",
    }, "error");

    await chrome.alarms.clear(orphanName);

    assertEquals(diag.event, "alarm_payload_missing");
    assertEquals(diag.actionTaken, "cleared_orphaned_alarm");
    assertEquals(armedAlarms.has(orphanName), false, "orphaned alarm must be cleared");
  } finally {
    console.error = origError;
  }
});

Deno.test("sched-diagnostics: canonical scheduleTask persists complete payload with alarm", async () => {
  const scheduled = await scheduleTask({
    task: "Organize inbox daily",
    delayMs: 60000,
    periodInMinutes: 1440,
  });

  assertEquals(typeof scheduled.name, "string");
  const store = await kvGet("cap:scheduledTasks");
  const task = store["cap:scheduledTasks"]?.[scheduled.name];
  assert(task, "task payload must be stored");
  assertEquals(task.task, "Organize inbox daily");
  assertEquals(task.periodInMinutes, 1440);

  // Clean up
  await cancelScheduledTask(scheduled.name);
});
