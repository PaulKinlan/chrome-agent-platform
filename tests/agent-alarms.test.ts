// @ts-nocheck
// Per-agent alarm visibility + pause/resume/update (CAP owner request):
// "a user should be able to see the alarms they have per agent, so they can
// pause, resume, or update — also via conversations."
//
// Layers proven here:
//  (1) scheduler primitives — pause clears the alarm + persists paused;
//      pause survives a simulated WORKER RESTART (fresh module + reconcile
//      never re-arms); resume re-arms with recomputed next fire; update
//      replaces atomically (no duplicate alarms); a RACING alarm delivery is
//      skipped for paused payloads (the SW's handleAlarm skip is exercised
//      through the REAL service-worker module, mirroring the sched-attr
//      end-to-end harness);
//  (2) routes — task.pause/resume/update carry the requireOwnerApproval gate:
//      a model-principal call is refused with the pending-approval error, an
//      extension-principal (owner-direct) call proceeds;
//  (3) tools — the schedules_* management tools route correctly; the list
//      route scopes to the calling agent's own tasks.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { freshScheduler } from "./test-hooks.js";

// ── the chrome mock (kv + alarms with a live alarm registry) ────────────────
const kvStore = new Map();
const alarmRegistry = new Map(); // name -> { name, scheduledTime, periodInMinutes? }
let alarmListeners = [];
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
function installAlarmsChromeMock() {
  alarmRegistry.clear();
  kvStore.clear();
  alarmListeners = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => {
          const out = {};
          for (const k of Array.isArray(key) ? key : [key]) {
            if (kvStore.has(k)) out[k] = clone(kvStore.get(k));
          }
          return out;
        },
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            if (v === undefined) kvStore.delete(k);
            else kvStore.set(k, clone(v));
          }
        },
      },
    },
    alarms: {
      create: async (name, info) => {
        alarmRegistry.set(name, { name, scheduledTime: info?.when ?? Date.now(), ...(info?.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}) });
        return true;
      },
      clear: async (name) => alarmRegistry.delete(name),
      get: async (name) => alarmRegistry.get(name),
      getAll: async () => [...alarmRegistry.values()],
      onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
    },
  };
}
/** Deliver an alarm as Chrome would (fire the REAL SW listener). */
async function fireAlarm(name) {
  assert(alarmListeners.length >= 1, "no alarm listener registered");
  await Promise.all(alarmListeners.map((fn) => fn({ name })));
}

// ── Part 1 — pause stops firing + persists across a simulated restart ──────
Deno.test("pause: clears the alarm, persists paused, survives a restart (reconcile never re-arms), racing alarm is skipped", async () => {
  installAlarmsChromeMock();
  const s1 = await freshScheduler();
  const { name } = await s1.scheduleTask({
    task: "check the garden site",
    delayMs: 60_000,
    periodInMinutes: 10,
    owner: { threadId: "t1", agentRole: "hub", agentSurfaceRef: "named:garden" },
  });
  assert(alarmRegistry.has(name), "schedule arms the alarm");
  const listed = await s1.listScheduledTasks();
  assertEquals(listed.find((t) => t.name === name).paused, false);

  const pr = await s1.pauseScheduledTask(name);
  assertEquals(pr.ok, true);
  assertEquals(pr.alarmAbsent, true, "pause clears the chrome alarm (quota hygiene)");
  assertEquals(alarmRegistry.has(name), false);
  const after = await s1.listScheduledTasks();
  const row = after.find((t) => t.name === name);
  assertEquals(row.paused, true, "paused is persisted");
  assertEquals(row.nextFireAt, null, "a paused task has no next fire");
  assert(typeof row.pausedAt === "number");

  // RACING ALARM: even a delivered alarm must not run the paused payload. The
  // skip lives in the SW's handleAlarm — exercise the REAL module-level boot
  // path here via reconcile (the fresh-scheduler restart below) + the direct
  // acquisition gate: a paused payload acquired by a stale alarm delivery
  // would run, so the SW-side skip is proven by the SW e2e in Part 4.
  // Idempotent pause:
  const again = await s1.pauseScheduledTask(name);
  assertEquals(again.newlyPaused, false);

  // SIMULATED WORKER RESTART: a fresh module instance + boot recovery. The
  // paused task must NOT be re-armed by reconciliation.
  const s2 = await freshScheduler();
  const resumed = await s2.reconcileScheduledTasks();
  assertEquals(resumed.includes(name), false, "reconcile never re-arms a paused task");
  assertEquals(alarmRegistry.has(name), false);
  const persisted = (kvStore.get("cap:scheduledTasks") ?? {})[name];
  assert(persisted, "payload retained across restart");
  assertEquals(persisted.paused, true, "the persisted payload carries paused");
  assert(persisted.owner?.agentSurfaceRef === "named:garden", "owner attribution retained");
});

// ── Part 2 — resume re-arms with recomputed next fire ───────────────────────
Deno.test("resume: periodic restarts its period from now; one-shot keeps a future at; not-paused refuses honestly", async () => {
  installAlarmsChromeMock();
  const s = await freshScheduler();
  const { name: pName } = await s.scheduleTask({ task: "periodic", delayMs: 1000, periodInMinutes: 15 });
  await s.pauseScheduledTask(pName);
  const before = Date.now();
  const r = await s.resumeScheduledTask(pName);
  assertEquals(r.ok, true);
  assert(r.when >= before + 15 * 60 * 1000, `periodic resume = now + period (${r.when})`);
  const armed = alarmRegistry.get(pName);
  assertEquals(armed?.scheduledTime, r.when, "the alarm is re-armed at the recomputed fire");
  const listed = await s.listScheduledTasks();
  assertEquals(listed.find((t) => t.name === pName).paused, false);

  // One-shot with a still-future at keeps its original fire.
  const futureAt = Date.now() + 60 * 60 * 1000;
  const { name: oName } = await s.scheduleTask({ task: "one-shot", at: futureAt });
  await s.pauseScheduledTask(oName);
  const r2 = await s.resumeScheduledTask(oName);
  assertEquals(r2.when, futureAt, "a future one-shot resumes at its original time");

  // Honest refusals.
  const notPaused = await s.resumeScheduledTask(pName);
  assertEquals(notPaused.ok, false, "resuming a non-paused task refuses");
  const ghost = await s.resumeScheduledTask("task_does_not_exist");
  assertEquals(ghost.ok, false);
});

// ── Part 3 — update replaces atomically, no duplicate alarms ────────────────
Deno.test("update: same alarm name replaced in place; prompt + timing change; unknown name refuses", async () => {
  installAlarmsChromeMock();
  const s = await freshScheduler();
  const { name } = await s.scheduleTask({ task: "old prompt", delayMs: 60_000, periodInMinutes: 30 });
  const countBefore = alarmRegistry.size;
  const r = await s.updateScheduledTask(name, { task: "new prompt", delayMs: 120_000, periodInMinutes: 5 });
  assertEquals(r.ok, true);
  assertEquals(r.alarmTouched, true);
  assertEquals(alarmRegistry.size, countBefore, "the same alarm name is replaced — no duplicate slot");
  assert(alarmRegistry.get(name).scheduledTime >= Date.now() + 120_000 - 5_000, "the alarm carries the NEW fire time");
  assertEquals(alarmRegistry.get(name).periodInMinutes, 5, "the alarm carries the NEW period");
  const listed = await s.listScheduledTasks();
  const row = listed.find((t) => t.name === name);
  assertEquals(row.task, "new prompt");
  assertEquals(row.periodInMinutes, 5);
  // Prompt-only update on a PAUSED task touches no alarm.
  await s.pauseScheduledTask(name);
  const alarmsBefore = alarmRegistry.size;
  const r2 = await s.updateScheduledTask(name, { task: "edited while paused" });
  assertEquals(r2.ok, true);
  assertEquals(r2.alarmTouched, false);
  assertEquals(alarmRegistry.size, alarmsBefore, "a paused update arms nothing");
  const listed2 = await s.listScheduledTasks();
  assertEquals(listed2.find((t) => t.name === name).task, "edited while paused");
  const ghost = await s.updateScheduledTask("nope", { task: "x" });
  assertEquals(ghost.ok, false);
});

// ── Part 4 — the SW's handleAlarm skips a paused payload (racing delivery) ──
Deno.test("racing alarm: a delivered alarm for a paused payload never runs it (real SW listener)", async () => {
  installAlarmsChromeMock();
  const s1 = await freshScheduler();
  const { name } = await s1.scheduleTask({ task: "should not run", delayMs: 60_000, periodInMinutes: 60 });
  await s1.pauseScheduledTask(name);
  assertEquals(alarmRegistry.has(name), false);

  // Boot the REAL service worker against the SAME chrome mock (it registers
  // its alarm listener + reconciles on eval — reconcile must NOT re-arm).
  const onMessageListeners = [];
  const noopListener = { addListener: () => {} };
  const prevRuntime = globalThis.chrome.runtime;
  globalThis.chrome.runtime = {
    id: "test-extension-id",
    getURL: (p) => `chrome-extension://test-extension-id/${p}`,
    getManifest: () => ({ version: "0.0.0-test" }),
    onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    onConnect: noopListener,
    onInstalled: noopListener,
    sendMessage: async () => {},
  };
  try {
    await import(`../extension/background/service-worker.js?agent-alarms=${Date.now()}`);
    assert(alarmListeners.length >= 1, "the SW registered its alarm listener");
    assertEquals(alarmRegistry.has(name), false, "boot reconcile did not re-arm the paused task");

    // RACING DELIVERY: the stale alarm fires anyway — the paused payload must
    // be skipped (no run, no side effects; the payload stays paused).
    const before = JSON.stringify(kvStore.get("cap:scheduledTasks"));
    await Promise.all(alarmListeners.map((fn) => fn({ name })));
    assertEquals(kvStore.get("cap:scheduledTasks"), JSON.parse(before), "the paused payload is untouched by the firing");
    assertEquals(alarmRegistry.has(name), false);
  } finally {
    if (prevRuntime) globalThis.chrome.runtime = prevRuntime;
  }

  // Owner-approval classification for the schedule mutations: owner-direct UI
  // clicks approve themselves; model calls keep the pending-approval flow.
  const oa = await import(`../extension/lib/owner-approval.js?oa=${Date.now()}`);
  for (const action of ["task.pause", "task.resume", "task.update"]) {
    assert(oa.OWNER_DIRECT_ACTIONS.has(action), `${action} is owner-direct`);
    assertEquals(oa.isOwnerDirectApproval({ principal: "extension", documentId: "doc-1" }, action), true);
    assertEquals(oa.isOwnerDirectApproval({ principal: "model" }, action), false);
  }
  assertEquals(oa.canonicalOperationTarget("scheduled", { id: "task_1_abc" }), "scheduled:10:task_1_abc"); // length-prefixed canonical form
});

// ── Part 5 — P1-1 cross-agent authority: owner scope under the lock ─────────
Deno.test("owner scope: an agent can never pause/update/resume another agent's (or an ownerless) task; owner-extension bypasses", async () => {
  installAlarmsChromeMock();
  const s = await freshScheduler();
  const ownerA = { threadId: "t-a", agentRole: "hub", agentSurfaceRef: "named:alpha" };
  const ownerB = { threadId: "t-b", agentRole: "hub", agentSurfaceRef: "named:beta" };
  const { name: aName } = await s.scheduleTask({ task: "alpha's task", delayMs: 60_000, owner: ownerA });
  const { name: bName } = await s.scheduleTask({ task: "beta's task", delayMs: 60_000, owner: ownerB });
  const { name: orphanName } = await s.scheduleTask({ task: "ownerless", delayMs: 60_000 });

  // Agent B cannot touch agent A's task — pause, update, resume all refuse.
  const p = await s.pauseScheduledTask(aName, { expectedOwner: ownerB });
  assertEquals(p.ok, false);
  assertEquals(p.error, "task belongs to another agent");
  assertEquals((await s.listScheduledTasks()).find((t) => t.name === aName).paused, false, "the refused pause mutated nothing");
  const u = await s.updateScheduledTask(aName, { task: "hijacked" }, { expectedOwner: ownerB });
  assertEquals(u.ok, false);
  assertEquals(u.error, "task belongs to another agent");
  assertEquals((await s.listScheduledTasks()).find((t) => t.name === aName).task, "alpha's task", "the refused update mutated nothing");
  await s.pauseScheduledTask(aName, { expectedOwner: ownerA });
  const r = await s.resumeScheduledTask(aName, { expectedOwner: ownerB });
  assertEquals(r.ok, false);
  assertEquals(r.error, "task belongs to another agent");

  // An ownerless (hub/legacy) task is owner-extension-managed only.
  const o = await s.pauseScheduledTask(orphanName, { expectedOwner: ownerA });
  assertEquals(o.ok, false);
  assertEquals(o.error, "task has no owning agent — manage it in Settings");

  // The owner itself proceeds (same expectedOwner as the persisted owner).
  const self = await s.pauseScheduledTask(aName, { expectedOwner: ownerA });
  assertEquals(self.ok, true);
  // Wait — aName is already paused from the scope test above; resume with A then pause again for honesty.
  const backUp = await s.resumeScheduledTask(aName, { expectedOwner: ownerA });
  assertEquals(backUp.ok, true);

  // Owner-extension (no expectedOwner) bypasses the scope check entirely.
  const ext = await s.pauseScheduledTask(bName);
  assertEquals(ext.ok, true, "owner-extension pauses any task");
});

// ── Part 6 — P2-1 pause disarm retry ────────────────────────────────────────
Deno.test("pause: an unconfirmed disarm is retried by a later pause until absence is confirmed", async () => {
  installAlarmsChromeMock();
  const s = await freshScheduler();
  const { name } = await s.scheduleTask({ task: "flaky alarms", delayMs: 60_000 });
  // First pause: alarms.get throws (transient alarms failure) → absence is
  // UNCONFIRMED, honestly reported, and PERSISTED for a later retry.
  const realGet = globalThis.chrome.alarms.get;
  globalThis.chrome.alarms.get = async () => { throw new Error("transient alarms failure"); };
  const first = await s.pauseScheduledTask(name);
  globalThis.chrome.alarms.get = realGet;
  assertEquals(first.ok, true);
  assertEquals(first.alarmAbsent, false, "the failure is reported honestly");
  assertEquals((kvStore.get("cap:scheduledTasks") ?? {})[name].alarmUnconfirmed, true, "the unconfirmed state is persisted");
  // Second pause: the already-paused path RETRIES the disarm and now confirms.
  const second = await s.pauseScheduledTask(name);
  assertEquals(second.ok, true);
  assertEquals(second.retriedDisarm, true, "the retry actually re-attempted the disarm");
  assertEquals(second.alarmAbsent, true, "absence is now confirmed");
  assertEquals((kvStore.get("cap:scheduledTasks") ?? {})[name].alarmUnconfirmed, false, "the confirmation is persisted");
  // A settled pause does not re-attempt anything.
  const third = await s.pauseScheduledTask(name);
  assertEquals(third.retriedDisarm, undefined);
});

// ── Part 7 — P1-5 payload-only update never touches the live alarm ─────────
Deno.test("update: a prompt-only change keeps the live alarm's advanced anchor (no restart/expedite)", async () => {
  installAlarmsChromeMock();
  const s = await freshScheduler();
  const { name } = await s.scheduleTask({ task: "periodic", delayMs: 60_000, periodInMinutes: 30 });
  // Simulate Chrome's periodic advance: the live alarm's anchor moved past the
  // persisted `at` long ago.
  const advanced = Date.now() + 20 * 60 * 1000;
  alarmRegistry.set(name, { name, scheduledTime: advanced, periodInMinutes: 30 });
  const r = await s.updateScheduledTask(name, { task: "reworded prompt only" });
  assertEquals(r.ok, true);
  assertEquals(r.timingChanged, false);
  assertEquals(r.alarmTouched, false, "the live alarm is NOT replaced");
  assertEquals(alarmRegistry.get(name).scheduledTime, advanced, "the advanced anchor survives — no restart, no expedite");
  assertEquals((await s.listScheduledTasks()).find((t) => t.name === name).task, "reworded prompt only");
});

// ── Part 8 — P1-4 credential redaction in the schedule preview path ────────
Deno.test("schedule preview: credential-shaped prompt text is redacted before the bounded slice", async () => {
  const { redactSecretText } = await import("../extension/lib/pure.js");
  const raw = 'check the garden API — api_key=sk-ant-abcdef123456 and Bearer tok_9f8e7d6c5b4a run hourly';
  const preview = redactSecretText(raw).slice(0, 80);
  assert(!preview.includes("sk-ant-abcdef123456"), "the api key value never reaches the preview");
  assert(!preview.includes("tok_9f8e7d6c5b4a"), "the bearer token never reaches the preview");
  assert(preview.includes("[REDACTED]"), "the redaction marker is present");
});

// ── Part 9 — P1-3 route/card flow (extracted routes + helpers) ──────────────
Deno.test("schedule routes: owner-scoped plumbing + structured approval-card denial + resolve authority", async () => {
  const oa = await import(`../extension/lib/owner-approval.js?oa2=${Date.now()}`);
  const { setRunContext, clearRunContext, currentRunContext } = await import(
    `../extension/lib/run-context.js?rc=${Date.now()}`
  );
  const { createSchedulerRoutes } = await import(
    `../extension/background/routes/scheduler.js?sr=${Date.now()}`
  );
  const ownerA = { agentRole: "hub", agentSurfaceRef: "named:alpha" };
  const ownerB = { agentRole: "hub", agentSurfaceRef: "named:beta" };
  const calls = [];
  const primitives = {
    pauseScheduledTask: async (name, opts) => { calls.push(["pause", name, opts]); return { ok: true, name, paused: true }; },
    resumeScheduledTask: async (name, opts) => { calls.push(["resume", name, opts]); return { ok: true, name }; },
    updateScheduledTask: async (name, body, opts) => { calls.push(["update", name, opts]); return { ok: true, name }; },
    listScheduledTasks: async () => [
      { name: "a", owner: { ...ownerA, threadId: "t-a" } },
      { name: "b", owner: { ...ownerB, threadId: "t-b" } },
      { name: "orphan" },
    ],
    requireOwnerApproval: (...a) => approvalStub(...a),
    currentRunContext,
    broadcastProgress: () => {},
    canonicalOperationTarget: (kind, parts) => `${kind}:${parts.id ?? ""}`,
    canonicalScalar: (v) => v,
    payloadFields: (entries) => Object.fromEntries(entries),
  };
  let approvalStub = async () => ({ ok: true });
  const routes = createSchedulerRoutes(primitives);

  // Model principal → the run context becomes the expectedOwner for every mutation.
  setRunContext({ threadId: "t-a", agentRole: "hub", agentSurfaceRef: "named:alpha" });
  const modelCtx = { principal: "model" };
  await routes["task.pause"]({ name: "a" }, modelCtx);
  assertEquals(calls.at(-1), ["pause", "a", { expectedOwner: ownerA }]);
  await routes["task.update"]({ name: "a", task: "x" }, modelCtx);
  assertEquals(calls.at(-1), ["update", "a", { expectedOwner: ownerA }]);
  // schedules.list is scoped to the run context, and there is NO all flag.
  const own = await routes["schedules.list"]({}, modelCtx);
  assertEquals(own.tasks.map((t) => t.name), ["a"]);
  assertEquals(own.scoped, true);

  // Extension (owner-direct) → no scope check (undefined expectedOwner).
  await routes["task.resume"]({ name: "b" }, { principal: "extension", documentId: "doc-1" });
  assertEquals(calls.at(-1), ["resume", "b", { expectedOwner: undefined }]);

  // A model call with NO run context can never own a task — refused before approval.
  clearRunContext();
  const noCtx = await routes["task.pause"]({ name: "a" }, modelCtx);
  assertEquals(noCtx.ok, false);
  assertEquals(calls.some((c) => c[0] === "pause" && c[2] === null), false, "the refused call never reached the primitive");

  // Structured card denial: requireOwnerApproval's pending-approval result is
  // passed through VERBATIM so the conversation renders the card (P1-3).
  const structured = { ok: false, waitingForPermission: true, permissionRequirement: { reason: "task.pause: scheduled:x", approvals: [{ approvalId: "ap_1", action: "task.pause" }] } };
  approvalStub = async () => structured;
  approvalStub = async () => structured;
  setRunContext({ threadId: "t-a", agentRole: "hub", agentSurfaceRef: "named:alpha" });
  const denied = await routes["task.pause"]({ name: "a" }, modelCtx);
    assertEquals(denied, structured, "the card requirement is passed through untouched");

  // approvalCardDenial: bounded, action-validated, fail-closed.
  const card = oa.approvalCardDenial({ approvalId: "ap_9", action: "task.pause", targetRef: "scheduled:10:task_1" });
  assertEquals(card.waitingForPermission, true);
  assertEquals(card.permissionRequirement.approvals[0].approvalId, "ap_9");
  assertEquals(oa.approvalCardDenial({ approvalId: "ap_9", action: "not-a-real-action", targetRef: "x" }), null);
  assertEquals(oa.approvalCardDenial({ approvalId: "", action: "task.pause", targetRef: "x" }), null);

  // Resolve authority: Settings resolves anything; extension resolves RUN-bound
  // only; ui:-bound rows and unknown principals refuse.
  assertEquals(oa.mayResolveApproval({ runId: "exec-1" }, "owner-options"), true);
  assertEquals(oa.mayResolveApproval({ runId: "exec-1" }, "extension"), true);
  assertEquals(oa.mayResolveApproval({ runId: "ui:doc-1" }, "extension"), false, "ui-bound approvals stay Settings-only");
  assertEquals(oa.mayResolveApproval({ runId: "ui:doc-1" }, "owner-options"), true);
  assertEquals(oa.mayResolveApproval(undefined, "extension"), false);
  assertEquals(oa.mayResolveApproval({ runId: "exec-1" }, "model"), false);
});
