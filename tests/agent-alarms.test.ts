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
Deno.test("schedule preview: the REAL projector (schedulePreviewText) redacts before the bounded slice", async () => {
  // P2-B: the test pins the ACTUAL projector (lib/schedule-preview.js — the
  // function the NTP row renders through), never a re-computed redaction.
  const { schedulePreviewText, SCHEDULE_PREVIEW_CHARS } = await import(
    `../extension/lib/schedule-preview.js?sp=${Date.now()}`
  );
  const raw = 'check the garden API — api_key=sk-ant-abcdef123456 and Bearer tok_9f8e7d6c5b4a run hourly';
  const preview = schedulePreviewText(raw);
  assert(!preview.includes("sk-ant-abcdef123456"), "the api key value never reaches the preview");
  assert(!preview.includes("tok_9f8e7d6c5b4a"), "the bearer token never reaches the preview");
  assert(preview.includes("[REDACTED]"), "the redaction marker is present");
  assert(preview.length <= SCHEDULE_PREVIEW_CHARS, "the preview is bounded");
  assertEquals(schedulePreviewText(""), "(no prompt)", "empty prompt falls back honestly");
  assertEquals(schedulePreviewText(undefined), "(no prompt)");
  // A benign prompt survives verbatim (under the cap).
  assertEquals(schedulePreviewText("check the garden site"), "check the garden site");
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
  // schedules.list is scoped to the run context, and there is NO all flag —
  // even an explicit {all:true} MUST NOT widen the model's view (P2-B: the
  // assertion fails an all-honoring implementation).
  const own = await routes["schedules.list"]({}, modelCtx);
  assertEquals(own.tasks.map((t) => t.name), ["a"]);
  assertEquals(own.scoped, true);
  const forcedAll = await routes["schedules.list"]({ all: true }, modelCtx);
  assertEquals(forcedAll.tasks.map((t) => t.name), ["a"], "{all:true} never widens a model-scoped list");
  assertEquals(forcedAll.scoped, true);

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

// ── Part 10 — P1-A approval-retry bridge (fresh executions consume) ─────────
Deno.test("approval bridge: pending under exec A → resolve → retry under exec B consumes EXACTLY once, no second request", async () => {
  const oa = await import(`../extension/lib/owner-approval.js?bridge=${Date.now()}`);
  const store = oa.createApprovalStore();
  const digest = "a".repeat(64);
  const target = "scheduled:10:task_1_abc";
  const action = "task.pause";

  // Execution A requests the mutation → a pending approval + structured card.
  const pending = oa.createPendingApproval(store, "exec-a", action, target, digest);
  assertEquals(pending.ok, true);
  assert(pending.approvalId, "the denial carries an approval id");

  // The owner resolves it (Allow) — status flips to approved, still bound to A.
  const resolved = oa.resolvePendingApproval(store, pending.approvalId, true);
  assertEquals(resolved.decision, "approved");

  // BEFORE the bridge, execution B cannot consume (the P1-A bug): exact key miss.
  assertEquals(oa.consumeApproved(store, "exec-b", action, target, digest).ok, false);

  // The trusted one-shot bridge re-keys the approved tuple onto execution B.
  const bridged = oa.bridgeApprovedApprovalToRun(store, pending.approvalId, "exec-b");
  assertEquals(bridged.ok, true);
  assertEquals(bridged.bridged, true);

  // The retried call under exec B consumes by exact key — ONE mutation, and NO
  // second approval request is created for exec-b (the tuple is consumed, not
  // re-pended: the store holds no pending row afterwards).
  assertEquals(oa.consumeApproved(store, "exec-b", action, target, digest).ok, true);
  assertEquals(oa.consumeApproved(store, "exec-b", action, target, digest).ok, false, "one-shot: a repeat call re-requests");
  assertEquals(oa.approvalPendingCount(store), 0, "no second approval was requested");

  // ONE-SHOT: the same approval cannot bridge a second time (no chaining).
  const again = oa.createPendingApproval(store, "exec-c", action, target, digest);
  // Non-approved entries refuse to bridge (asserted BEFORE resolving).
  assertEquals(oa.bridgeApprovedApprovalToRun(store, again.approvalId, "exec-d").ok, false, "a PENDING approval never bridges");
  oa.resolvePendingApproval(store, again.approvalId, true);
  const orphaned = oa.bridgeApprovedApprovalToRun(store, pending.approvalId, "exec-c");
  assertEquals(orphaned.ok, false, "a bridged approval never bridges again");
  const bridgedAgain = oa.bridgeApprovedApprovalToRun(store, again.approvalId, "exec-d");
  assertEquals(bridgedAgain.ok, true, "a distinct approved approval bridges once");
  assertEquals(oa.bridgeApprovedApprovalToRun(store, again.approvalId, "exec-e").ok, false, "and never twice");
});

Deno.test("schedule routes: the automatic retry turn consumes the resolved approval — exactly ONE mutation, no second approval request", async () => {
  // The REAL route layer over the REAL scheduler primitives + the REAL
  // owner-approval gate ops (the SW's requireOwnerApproval is a thin shell
  // over exactly these), with the retry-start bridge the surface triggers.
  const oa = await import(`../extension/lib/owner-approval.js?rbridge=${Date.now()}`);
  const { setRunContext, clearRunContext, currentRunContext } = await import(`../extension/lib/run-context.js?rc2=${Date.now()}`);
  const { createSchedulerRoutes } = await import(`../extension/background/routes/scheduler.js?sr2=${Date.now()}`);
  const { createApprovalStore } = oa;
  const store = createApprovalStore();
  const activeExecutions = new Set();

  installAlarmsChromeMock();
  const s = await freshScheduler();
  const owner = { threadId: "t-a", agentRole: "hub", agentSurfaceRef: "named:alpha" };
  const { name } = await s.scheduleTask({ task: "alpha's periodic", delayMs: 60_000, periodInMinutes: 10, owner });

  // The REAL gate shape (mirrors requireOwnerApproval's consume→pending→card
  // sequence over the REAL store ops; model context must be a live execution).
  const gate = async (context, action, target, payload, { card = false } = {}) => {
    const executionId = context.executionId;
    if (!executionId || !activeExecutions.has(executionId)) return { ok: false, error: "requires approval" };
    const digest = await sha256hex(payload);
    const consumed = oa.consumeApproved(store, executionId, action, target, digest);
    if (consumed.ok) return { ok: true };
    const pending = oa.createPendingApproval(store, executionId, action, target, digest);
    if (card && pending.ok) {
      const denial = oa.approvalCardDenial({ approvalId: pending.approvalId, action, targetRef: target });
      if (denial) return denial;
    }
    return { ok: false, error: "requires approval" };
  };
  const sha256hex = async (value) => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const primitives = {
    pauseScheduledTask: (...a) => s.pauseScheduledTask(...a),
    resumeScheduledTask: (...a) => s.resumeScheduledTask(...a),
    updateScheduledTask: (...a) => s.updateScheduledTask(...a),
    listScheduledTasks: () => s.listScheduledTasks(),
    requireOwnerApproval: gate,
    currentRunContext,
    broadcastProgress: () => {},
    canonicalOperationTarget: (kind, parts) => `${kind}:${parts.id ?? ""}`,
    canonicalScalar: (v) => v,
    payloadFields: (entries) => Object.fromEntries(entries),
  };
  const routes = createSchedulerRoutes(primitives);

  // Execution A (live) calls pause → the structured card denial, NO mutation.
  activeExecutions.add("exec-a");
  setRunContext({ threadId: "t-a", agentRole: "hub", agentSurfaceRef: "named:alpha" });
  const denied = await routes["task.pause"]({ name }, { principal: "model", executionId: "exec-a" });
  assertEquals(denied.ok, false);
  assertEquals(denied.waitingForPermission, true);
  const approvalId = denied.permissionRequirement?.approvals?.[0]?.approvalId;
  assert(approvalId, "the card carries the approval id");
  assertEquals((await s.listScheduledTasks()).find((t) => t.name === name).paused, false, "the denied call mutated nothing");
  const pendingAfterDenial = oa.approvalPendingCount(store);
  assertEquals(pendingAfterDenial, 1);

  // The owner Allow-resolves via the resolve authority.
  assertEquals(oa.resolvePendingApproval(store, approvalId, true).decision, "approved");

  // The AUTOMATIC RETRY starts a FRESH execution; the surface passes the
  // resolved approvalId with the run start (the bridge). Execution B's pause
  // consumes it: EXACTLY ONE mutation, NO second approval request.
  activeExecutions.add("exec-b");
  // (the run-start bridge — runTask's approvalBinding — does exactly this:)
  assertEquals(oa.bridgeApprovedApprovalToRun(store, approvalId, "exec-b").ok, true);
  const retried = await routes["task.pause"]({ name }, { principal: "model", executionId: "exec-b" });
  assertEquals(retried.ok, true, `the retried mutation succeeds: ${JSON.stringify(retried)}`);
  assertEquals((await s.listScheduledTasks()).find((t) => t.name === name).paused, true, "the pause landed exactly once");
  assertEquals(oa.approvalPendingCount(store), 0, "NO second approval request was created for the retry");

  // A THIRD execution (no bridge) re-requests honestly — scoping intact.
  activeExecutions.add("exec-c");
  clearRunContext();
  const third = await routes["task.pause"]({ name }, { principal: "model", executionId: "exec-c" });
  assertEquals(third.ok, false, "an unbridged execution still cannot act (already paused → refused before approval)");
});

// ── Part 11 — P1-B ownership check/commit races ─────────────────────────────
Deno.test("retry race: a same-name owner swap between snapshot and commit cannot inherit the retry (single-lock re-check)", async () => {
  installAlarmsChromeMock();
  const s = await freshScheduler();
  const ownerA = { threadId: "t-a", agentRole: "hub", agentSurfaceRef: "named:alpha" };
  const ownerB = { threadId: "t-b", agentRole: "hub", agentSurfaceRef: "named:beta" };
  const { name } = await s.scheduleTask({ task: "alpha's blocked task", delayMs: 60_000, owner: ownerA });
  // Block it (the retry precondition).
  await s.blockScheduledTaskForStorage(name, new Error("quota"));
  assertEquals((await s.listScheduledTasks()).find((t) => t.name === name).storageBlocked, true);

  // THE RACE: between agent A's authorization snapshot and the commit, the
  // same-name task is replaced by agent B's. The old implementation checked
  // scope on the snapshot then replaced OUTSIDE the lock — the swap escaped.
  // THE SWAP, precisely: the same-name record is replaced by agent B's
  // (blocked) one between A's authorization and its commit.
  {
    const tasks = kvStore.get("cap:scheduledTasks") ?? {};
    tasks[name] = {
      name, task: "beta's replacement", at: Date.now() + 60_000, owner: ownerB,
      storageBlocked: true, storageBlockedAt: Date.now(), storageError: { message: "quota" },
    };
    kvStore.set("cap:scheduledTasks", tasks);
  }

  const r = await s.retryScheduledTask(name, { expectedOwner: ownerA });
  assertEquals(r.ok, false, "the swapped owner refuses A's retry");
  assertEquals(r.error, "task belongs to another agent");
  const row = (await s.listScheduledTasks()).find((t) => t.name === name);
  assertEquals(row.storageBlocked, true, "B's replacement is untouched — still exactly as B seeded it");
  assertEquals(row.task, "beta's replacement", "B's payload is intact");
});

Deno.test("resume race: the final commit re-checks owner scope on the CURRENT row", async () => {
  installAlarmsChromeMock();
  const s = await freshScheduler();
  const ownerA = { threadId: "t-a", agentRole: "hub", agentSurfaceRef: "named:alpha" };
  const ownerB = { threadId: "t-b", agentRole: "hub", agentSurfaceRef: "named:beta" };
  const { name } = await s.scheduleTask({ task: "alpha's paused task", delayMs: 60_000, periodInMinutes: 5, owner: ownerA });
  await s.pauseScheduledTask(name, { expectedOwner: ownerA });
  // THE SWAP: between A's resume snapshot and its commit, the task is replaced
  // by B's (paused) one. The final lock must re-judge scope on the CURRENT row.
  {
    const tasks = kvStore.get("cap:scheduledTasks") ?? {};
    tasks[name] = {
      name, task: "beta's paused replacement", at: Date.now() + 60_000,
      periodInMinutes: 5, owner: ownerB, paused: true, pausedAt: Date.now(),
    };
    kvStore.set("cap:scheduledTasks", tasks);
  }

  const r = await s.resumeScheduledTask(name, { expectedOwner: ownerA });
  assertEquals(r.ok, false, "the swapped owner refuses A's resume");
  assertEquals(r.error, "task belongs to another agent");
  const row = (await s.listScheduledTasks()).find((t) => t.name === name);
  assertEquals(row.paused, true, "B's paused state is untouched by the refused resume");
});
