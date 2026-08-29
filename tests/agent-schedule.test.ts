// @ts-nocheck — stubs browser globals; runtime behavior under test.
// tests/agent-schedule.test.ts — the unified agent schedule model (REVISE-2):
//  P1-a  the set-schedule approval binds the normalized recurring PROMPT (an
//        exact retry with a different prompt is REJECTED);
//  P1-b  named-agent.get carries the same schedule enrichment as list
//        (source-pinned; the dialog behavior is KAT-covered);
//  P1-c  projectUnifiedAgents is the ONE projection — a same-id record in both
//        stores renders once, named wins, a recipe-side schedule fills in;
//  P1-d  delete-time schedule teardown is durably marked AFTER approval and
//        BEFORE row/OPFS deletion, aborts on marking failure, and never
//        crosses into the recipe:<slug> family.

import { assert, assertEquals } from "jsr:@std/assert@1";

// ── in-memory chrome mock (storage + OPFS + alarms with a live registry) ────
const store = new Map();
const fs = new Map();
const alarmRegistry = new Map();
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
function getDir(path) {
  let node = fs;
  for (const seg of path) {
    if (!node.has("d:" + seg)) node.set("d:" + seg, new Map());
    node = node.get("d:" + seg);
  }
  return node;
}
function dirHandle(node, name) {
  return {
    name,
    getDirectoryHandle: async (seg, { create } = {}) => {
      const key = "d:" + seg;
      if (!node.has(key)) {
        if (!create) throw new Error("missing " + seg);
        node.set(key, new Map());
      }
      return dirHandle(node.get(key), seg);
    },
    getFileHandle: async (seg, { create } = {}) => {
      const key = "f:" + seg;
      if (!node.has(key)) {
        if (!create) throw new Error("missing " + seg);
        node.set(key, { text: "" });
      }
      const rec = node.get(key);
      return {
        getFile: async () => ({ text: async () => rec.text, size: new TextEncoder().encode(rec.text).length }),
        createWritable: async () => ({
          write: async (s) => { rec.text = s; },
          close: async () => {},
        }),
      };
    },
    removeEntry: async (seg) => { node.delete("d:" + seg); node.delete("f:" + seg); },
    entries: async function* () {
      for (const [k, v] of node) {
        yield [k.slice(2), { kind: k.startsWith("d:") ? "directory" : "file", getFile: async () => ({ size: new TextEncoder().encode(v.text ?? "").length }) }];
      }
    },
  };
}
let poisonTaskStoreWrites = false;
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        if (poisonTaskStoreWrites && Object.keys(obj).some((k) => k.includes("scheduledTasks"))) {
          throw new Error("poisoned: task-store write failed");
        }
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
  alarms: {
    create: async (name, info) => {
      alarmRegistry.set(name, { name, scheduledTime: info?.when ?? Date.now(), ...(info?.periodInMinutes ? { periodInMinutes: info.periodInMinutes } : {}) });
      return true;
    },
    clear: async (name) => alarmRegistry.delete(name),
    get: async (name) => alarmRegistry.get(name),
    getAll: async () => [...alarmRegistry.values()],
    onAlarm: { addListener: () => {} },
  },
};
globalThis.navigator = globalThis.navigator ?? {};
Object.defineProperty(globalThis.navigator, "storage", {
  value: {
    getDirectory: async () => ({
      getDirectoryHandle: async (seg, { create } = {}) => {
        const node = create ? getDir([seg]) : (() => { const n = fs.get("d:" + seg); if (!n) throw new Error("missing"); return n; })();
        return dirHandle(node, seg);
      },
    }),
  },
  configurable: true,
});

const {
  createAgentScheduleRoutes,
  createNamedAgentDeleteGate,
  normalizeScheduleTask,
} = await import("../extension/background/routes/agent-schedule.js");
const oa = await import("../extension/lib/owner-approval.js");
const scheduler = await import("../extension/lib/scheduler.js");
const namedAgents = await import("../extension/lib/named-agents.js");

const payloadFields = (entries) =>
  oa.canonicalRecord(...entries.map(([name, value]) => oa.canonicalField(name, oa.canonicalScalar(value))));

// ── P1-a: the approval binds the normalized recurring prompt ────────────────
Deno.test("P1-a: approve one prompt, retry with a DIFFERENT prompt → rejected (the digest binds the task)", async () => {
  const approvalStore = oa.createApprovalStore();
  // The model-path semantics of the SW's requireOwnerApproval, built on the
  // REAL store primitives: digest the route-built payload, consume on exact
  // match, else create a pending approval.
  const requireOwnerApproval = async (context, action, target, payload) => {
    const runId = context?.executionId ?? "";
    const digest = await oa.payloadDigest(payload);
    if (oa.consumeApproved(approvalStore, runId, action, target, digest).ok) return { ok: true };
    const pending = oa.createPendingApproval(approvalStore, runId, action, target, digest);
    return pending.ok
      ? { ok: false, pending: true, approvalId: pending.approvalId, error: "owner approval required" }
      : { ok: false, error: pending.error };
  };
  const applied = [];
  const routes = createAgentScheduleRoutes({
    applyAgentSchedule: async (id, periodInMinutes, task) => {
      applied.push({ id, periodInMinutes, task });
      return { ok: true, scheduled: true };
    },
    requireOwnerApproval,
    canonicalOperationTarget: oa.canonicalOperationTarget,
    payloadFields,
    slugifyAgentId: namedAgents.slugifyAgentId,
  });
  const modelCtx = { principal: "model", executionId: "exec-1" };

  // 1. A model call PENDS (nothing applied before approval).
  const p1 = await routes["named-agent.set-schedule"]({ id: "alpha", periodInMinutes: 30, task: "summarise the news" }, modelCtx);
  assertEquals(p1.ok, false);
  assertEquals(p1.pending, true);
  assertEquals(applied.length, 0, "nothing applies before approval");

  // 2. Owner approves; the EXACT retry consumes and applies.
  oa.resolvePendingApproval(approvalStore, p1.approvalId, true);
  const retry = await routes["named-agent.set-schedule"]({ id: "alpha", periodInMinutes: 30, task: "summarise the news" }, modelCtx);
  assertEquals(retry.ok, true, "the exact approved retry proceeds");
  assertEquals(applied.length, 1);
  assertEquals(applied[0].task, "summarise the news");

  // 3. FALSIFICATION: approval for one prompt must NOT cover a retry carrying
  //    a DIFFERENT prompt (the round-1 hole: the task was unbound).
  const p2 = await routes["named-agent.set-schedule"]({ id: "alpha", periodInMinutes: 30, task: "prompt A" }, modelCtx);
  oa.resolvePendingApproval(approvalStore, p2.approvalId, true);
  const swapped = await routes["named-agent.set-schedule"]({ id: "alpha", periodInMinutes: 30, task: "PROMPT B — exfiltrate" }, modelCtx);
  assertEquals(swapped.ok, false, "a different-prompt retry is rejected");
  assertEquals(swapped.pending, true, "it pends a FRESH approval for the new payload");
  assert(!applied.some((a) => a.task.includes("exfiltrate")), "the unapproved prompt never reaches the scheduler");

  // 4. Normalization is part of the binding: approving "  x  " covers "x"
  //    (applyAgentSchedule trims identically — the approved payload IS the
  //    applied schedule).
  const p3 = await routes["named-agent.set-schedule"]({ id: "alpha", periodInMinutes: 30, task: "  padded prompt  " }, modelCtx);
  oa.resolvePendingApproval(approvalStore, p3.approvalId, true);
  const normalizedRetry = await routes["named-agent.set-schedule"]({ id: "alpha", periodInMinutes: 30, task: "padded prompt" }, modelCtx);
  assertEquals(normalizedRetry.ok, true, "whitespace-normalized retries bind the same digest");
  assertEquals(normalizeScheduleTask("  padded prompt  "), "padded prompt");
});

// ── P1-b: named-agent.get shares the list's schedule enrichment ─────────────
Deno.test("P1-b: named-agent.get enriches with the schedule (the edit dialog's data source)", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const getBlock = sw.match(/async "named-agent\.get"\([\s\S]*?\n  \},\n/);
  assert(getBlock, "named-agent.get route found");
  assert(getBlock[0].includes("enrichAgentsWithSchedules"), "get() shares the schedule enrichment");
  const listBlock = sw.match(/async "named-agent\.list"\([\s\S]*?\n  \},\n/);
  assert(listBlock?.[0].includes("enrichAgentsWithSchedules"), "list() uses the same helper — one enrichment authority");
});

// ── P1-c: the ONE unified projection ────────────────────────────────────────
Deno.test("P1-c: projectUnifiedAgents — same-id collision renders ONCE, named wins, recipe schedule fills in", () => {
  const { projectUnifiedAgents } = namedAgents;
  const named = [
    { id: "shared", name: "Shared Agent", role: "the persona" },
    { id: "solo", name: "Solo", role: "r" },
  ];
  const background = [
    { id: "shared", name: "Shared Agent", description: "recipe copy", schedule: { periodInMinutes: 60 } },
    { id: "recipe-only", name: "Recipe Only", description: "d", schedule: { periodInMinutes: 15 } },
  ];
  const rows = projectUnifiedAgents(named, background);
  assertEquals(rows.length, 3, "four records in two stores → three projected rows");
  const shared = rows.filter((r) => r.id === "shared");
  assertEquals(shared.length, 1, "the same-id record renders EXACTLY ONCE");
  assertEquals(shared[0].kind, "named", "the named record wins the collision");
  assertEquals(shared[0].role, "the persona", "the winner keeps its persona");
  assertEquals(shared[0].schedule?.periodInMinutes, 60, "the recipe-side schedule fills the named record's empty schedule");
  const recipeOnly = rows.find((r) => r.id === "recipe-only");
  assertEquals(recipeOnly.kind, "background");
  assertEquals(recipeOnly.schedule?.periodInMinutes, 15);
  // A named agent with its OWN schedule keeps it over the recipe's.
  const both = projectUnifiedAgents(
    [{ id: "x", name: "X", schedule: { periodInMinutes: 45, task: "t" } }],
    [{ id: "x", name: "X", schedule: { periodInMinutes: 60 } }],
  );
  assertEquals(both.length, 1);
  assertEquals(both[0].schedule.periodInMinutes, 45, "the named schedule wins over the recipe's");
  // Degenerate inputs never throw.
  assertEquals(projectUnifiedAgents(null, undefined), []);
  assertEquals(projectUnifiedAgents([{ name: "no id" }], [{}]), [], "id-less records are dropped");
});

// ── P1-d: deletion ordering + family crossing ───────────────────────────────
Deno.test("P1-d: delete durably cancels agent:<slug> BEFORE the row/OPFS deletion; failure aborts; recipe family untouched", async () => {
  const { createNamedAgent, deleteNamedAgent, getNamedAgent, slugifyAgentId } = namedAgents;
  const { namedAgentMemory } = await import("../extension/lib/memory.js");
  const { scheduleTask, cancelScheduledTaskBackground, listScheduledTasks } = scheduler;
  const okApproval = async () => ({ ok: true });
  const identityPayload = (payload) => payload;
  const gateDeps = {
    requireOwnerApproval: okApproval,
    canonicalOperationTarget: oa.canonicalOperationTarget,
    namedBoundMutationPayload: identityPayload,
    payloadFields,
    cancelScheduledTaskBackground,
  };

  // 1. Happy path: a scheduled agent is deleted — the schedule is DURABLY
  //    marked cancelling by the time the row is gone.
  const created = await createNamedAgent({ name: "Schedulable Agent", role: "runs on a schedule" });
  assert(created.ok);
  const slug = created.agent.id;
  await scheduleTask({ task: "recurring work", delayMs: 60_000, periodInMinutes: 30, name: `agent:${slug}` });
  assert(alarmRegistry.has(`agent:${slug}`), "the schedule armed a real alarm");

  const del = await deleteNamedAgent(slug, {
    gateBeforeDelete: createNamedAgentDeleteGate({ principal: "extension", documentId: "doc-1" }, gateDeps),
  });
  assertEquals(del.ok, true);
  assertEquals(await getNamedAgent(slug), null, "the row is gone");
  const payload = (await listScheduledTasks()).find((t) => t.name === `agent:${slug}`);
  // The mark landed BEFORE the row deletion completed: the payload is already
  // cancelling (inert) — never a live alarm owned by a deleted agent.
  assert(!payload || payload.cancelling === true, "the schedule is durably inert at deletion time");

  // 2. FAMILY CROSSING: an independent recipe:<slug> schedule sharing the slug
  //    SURVIVES the agent deletion (recipe teardown is recipe.delete's job).
  const cross = await createNamedAgent({ name: "Crossing Agent" });
  const cslug = cross.agent.id;
  await scheduleTask({ task: "recipe-side schedule", delayMs: 60_000, periodInMinutes: 60, name: `recipe:${cslug}` });
  await deleteNamedAgent(cslug, {
    gateBeforeDelete: createNamedAgentDeleteGate({ principal: "extension", documentId: "doc-1" }, gateDeps),
  });
  const recipeRow = (await listScheduledTasks()).find((t) => t.name === `recipe:${cslug}`);
  assert(recipeRow && recipeRow.cancelling !== true, "the recipe family's schedule is NOT touched by an agent deletion");
  assert(alarmRegistry.has(`recipe:${cslug}`), "the recipe alarm stays armed");

  // 3. FALSIFICATION (failure path): when the durable marking FAILS, the
  //    deletion aborts — the agent row AND its memory survive, and the
  //    schedule is not half-marked.
  const fragile = await createNamedAgent({ name: "Fragile Agent", role: "must survive a failed teardown" });
  const fslug = fragile.agent.id;
  await scheduleTask({ task: "fragile work", delayMs: 60_000, periodInMinutes: 30, name: `agent:${fslug}` });
  poisonTaskStoreWrites = true;
  let refused;
  try {
    refused = await deleteNamedAgent(fslug, {
      gateBeforeDelete: createNamedAgentDeleteGate({ principal: "extension", documentId: "doc-1" }, gateDeps),
    });
  } finally {
    poisonTaskStoreWrites = false;
  }
  assertEquals(refused.ok, false, "the deletion ABORTS when the schedule mark is not durable");
  assert(/schedule teardown failed/.test(refused.error ?? ""), "the error names the schedule teardown");
  const survivor = await getNamedAgent(fslug);
  assert(survivor, "the agent row SURVIVES the aborted deletion");
  const mem = namedAgentMemory(slugifyAgentId(fslug));
  assert(await mem.get("agents.md"), "the agent's OPFS memory survives too (nothing half-torn-down)");
  const stillArmed = (await listScheduledTasks()).find((t) => t.name === `agent:${fslug}`);
  assert(stillArmed && stillArmed.cancelling !== true, "the schedule was not half-marked — it is still live and retryable");
});

// ── P1-e: the set-schedule/delete race leaves NO orphan recurring alarm ────
Deno.test("P1-e: an agent deleted mid-schedule-creation leaves no live agent:<slug> alarm (revalidation fence)", async () => {
  const { createNamedAgent, deleteNamedAgent, getNamedAgent, slugifyAgentId } = namedAgents;
  const { scheduleTask, cancelScheduledTaskBackground, listScheduledTasks } = scheduler;
  const { createApplyAgentSchedule } = await import("../extension/background/routes/agent-schedule.js");

  const created = await createNamedAgent({ name: "Race Target", role: "deleted mid-schedule" });
  assert(created.ok);
  const slug = created.agent.id;

  // Deterministic interleaving: the schedule's FIRST agent read resolves,
  // then applyAgentSchedule pauses BEFORE scheduleTask; the deletion runs to
  // completion while NO task exists (its gate's cancel is a no-op); then the
  // schedule resumes.
  let releaseRead;
  const readGate = new Promise((r) => { releaseRead = r; });
  let reads = 0;
  const pausingGet = async (id) => {
    reads++;
    const a = await getNamedAgent(id);
    if (reads === 1) await readGate;
    return a;
  };
  const applyAgentSchedule = createApplyAgentSchedule({
    getNamedAgent: pausingGet,
    scheduleTask,
    cancelScheduledTaskBackground,
    broadcastRegistryChanged: () => {},
    slugifyAgentId,
    withNamedAgentsLock: namedAgents.withNamedAgentsLock,
  });

  const applying = applyAgentSchedule(slug, 30, "recurring work");
  for (let i = 0; i < 100 && reads === 0; i++) await new Promise((r) => setTimeout(r, 1));
  assertEquals(reads, 1, "the schedule creation is parked after its agent read");

  const gateDeps = {
    requireOwnerApproval: async () => ({ ok: true }),
    canonicalOperationTarget: oa.canonicalOperationTarget,
    namedBoundMutationPayload: (p) => p,
    payloadFields,
    cancelScheduledTaskBackground,
  };
  const del = await deleteNamedAgent(slug, {
    gateBeforeDelete: createNamedAgentDeleteGate({ principal: "extension", documentId: "doc-race" }, gateDeps),
  });
  assertEquals(del.ok, true, "the deletion completes (no task existed to cancel)");
  assertEquals(await getNamedAgent(slug), null, "the row is gone before the schedule resumes");

  releaseRead();
  const res = await applying;
  assertEquals(res.ok, false, "the schedule is honestly NOT applied to a deleted agent");
  assert(/deleted while its schedule was being created/.test(res.error ?? ""), "the error names the race");
  assert(!alarmRegistry.has(`agent:${slug}`), "FALSIFICATION TARGET: no orphan recurring alarm survives");
  const live = (await listScheduledTasks()).find((t) => t.name === `agent:${slug}`);
  assert(!live || live.cancelling === true, "no live task row survives either");

  // Same-instance guard: a schedule created while the agent is REPLACED (new
  // instanceId, same slug) is torn down too — the new row never asked for it.
  const v1 = await createNamedAgent({ name: "Replaced Agent" });
  const rslug = v1.agent.id;
  const firstInstance = v1.agent.instanceId;
  let releaseRead2;
  const readGate2 = new Promise((r) => { releaseRead2 = r; });
  let reads2 = 0;
  const pausingGet2 = async (id) => {
    reads2++;
    const a = await getNamedAgent(id);
    if (reads2 === 1) await readGate2;
    return a;
  };
  const apply2 = createApplyAgentSchedule({
    getNamedAgent: pausingGet2, scheduleTask, cancelScheduledTaskBackground,
    broadcastRegistryChanged: () => {}, slugifyAgentId,
    withNamedAgentsLock: namedAgents.withNamedAgentsLock,
  });
  const applying2 = apply2(rslug, 15, "for the old instance");
  for (let i = 0; i < 100 && reads2 === 0; i++) await new Promise((r) => setTimeout(r, 1));
  await deleteNamedAgent(rslug, { gateBeforeDelete: createNamedAgentDeleteGate({ principal: "extension", documentId: "d2" }, gateDeps) });
  const v2 = await createNamedAgent({ name: "Replaced Agent" });
  assert(v2.agent.instanceId !== firstInstance, "the replacement has a fresh instanceId");
  releaseRead2();
  const res2 = await applying2;
  assertEquals(res2.ok, false, "the stale-instance schedule is not applied to the replacement");
  assert(!alarmRegistry.has(`agent:${rslug}`), "no schedule armed for an instance that never asked");
});

// ── P1-e2: deletion parked BETWEEN the gate's cancel and the row delete ────
Deno.test("P1-e2: a schedule armed while deletion sits between gate-cancel and row-delete is still torn down (fence re-read under the agents lock)", async () => {
  const { createNamedAgent, deleteNamedAgent, getNamedAgent, slugifyAgentId } = namedAgents;
  const { scheduleTask, cancelScheduledTaskBackground, listScheduledTasks } = scheduler;
  const { createApplyAgentSchedule } = await import("../extension/background/routes/agent-schedule.js");

  const created = await createNamedAgent({ name: "Parked Deletion", role: "deleted mid-flight" });
  assert(created.ok);
  const slug = created.agent.id;

  const gateDeps = {
    requireOwnerApproval: async () => ({ ok: true }),
    canonicalOperationTarget: oa.canonicalOperationTarget,
    namedBoundMutationPayload: (p) => p,
    payloadFields,
    cancelScheduledTaskBackground,
  };
  // Park the deletion AFTER its gate (approval + cancel mark) but BEFORE the
  // prompt cleanup + row delete — the exact window the unlocked fence read
  // used to observe the still-present row.
  const realGate = createNamedAgentDeleteGate({ principal: "extension", documentId: "doc-parked" }, gateDeps);
  let releaseMidDelete;
  const midDelete = new Promise((r) => { releaseMidDelete = r; });
  let gateResolved;
  const gateDone = new Promise((r) => { gateResolved = r; });
  const pausingGate = async (args) => {
    const r = await realGate(args);
    gateResolved();
    await midDelete;
    return r;
  };
  const deleting = deleteNamedAgent(slug, { gateBeforeDelete: pausingGate });
  await gateDone;

  // While the deletion is parked (agents lock held, cancel already marked — a
  // no-op, no task existed), the schedule creation runs: the row still reads
  // present, scheduleTask arms `agent:<slug>`, then the fence read blocks on
  // the agents lock until the deletion finishes.
  const applyAgentSchedule = createApplyAgentSchedule({
    getNamedAgent,
    scheduleTask,
    cancelScheduledTaskBackground,
    broadcastRegistryChanged: () => {},
    slugifyAgentId,
    withNamedAgentsLock: namedAgents.withNamedAgentsLock,
  });
  const applying = applyAgentSchedule(slug, 30, "recurring work");
  for (let i = 0; i < 400 && !alarmRegistry.has(`agent:${slug}`); i++) await new Promise((r) => setTimeout(r, 1));
  assert(alarmRegistry.has(`agent:${slug}`), "the schedule armed while the deletion was parked mid-flight");

  releaseMidDelete();
  const res = await applying;
  await deleting;
  assertEquals(res.ok, false, "the schedule is honestly NOT applied — the fence saw the row gone after the lock");
  assert(/deleted while its schedule was being created/.test(res.error ?? ""), "the error names the race");
  for (let i = 0; i < 400 && alarmRegistry.has(`agent:${slug}`); i++) await new Promise((r) => setTimeout(r, 1));
  assert(!alarmRegistry.has(`agent:${slug}`), "FALSIFICATION TARGET: no orphan recurring alarm survives the mid-delete arming");
  const live = (await listScheduledTasks()).find((t) => t.name === `agent:${slug}`);
  assert(!live || live.cancelling === true, "no live task row survives either");
});

// ── P1-f: a LEGACY row (no instanceId) replaced mid-schedule is caught ─────
Deno.test("P1-f: a legacy agent row (no instanceId) deleted+recreated mid-schedule leaves no orphan (unconditional identity compare)", async () => {
  const { scheduleTask, cancelScheduledTaskBackground, listScheduledTasks } = scheduler;
  const { slugifyAgentId } = namedAgents;
  const { createApplyAgentSchedule } = await import("../extension/background/routes/agent-schedule.js");

  const slug = "legacy-agent";
  // The persisted shape of a pre-instanceId record: no instanceId field at
  // all (backfill happens only on create/update, named-agents.js:194,244).
  const legacyRow = { id: slug, name: "Legacy Agent", role: "old", createdAt: 1, updatedAt: 1 };
  const replacementRow = { ...legacyRow, instanceId: "fresh-instance", createdAt: 2, updatedAt: 2 };
  let releaseRead;
  const readGate = new Promise((r) => { releaseRead = r; });
  let reads = 0;
  const swappingGet = async () => {
    reads++;
    if (reads === 1) { await readGate; return legacyRow; }
    return replacementRow; // the delete+recreate landed while we scheduled
  };
  const applyAgentSchedule = createApplyAgentSchedule({
    getNamedAgent: swappingGet,
    scheduleTask,
    cancelScheduledTaskBackground,
    broadcastRegistryChanged: () => {},
    slugifyAgentId,
    withNamedAgentsLock: namedAgents.withNamedAgentsLock,
  });
  const applying = applyAgentSchedule(slug, 20, "legacy recurring work");
  for (let i = 0; i < 100 && reads === 0; i++) await new Promise((r) => setTimeout(r, 1));
  assertEquals(reads, 1, "parked before the first read resolves");
  releaseRead();
  const res = await applying;
  assertEquals(res.ok, false, "the legacy row's schedule is NOT applied to the replacement instance (undefined !== fresh id)");
  assert(/deleted while its schedule was being created/.test(res.error ?? ""), "the error names the race");
  for (let i = 0; i < 400 && alarmRegistry.has(`agent:${slug}`); i++) await new Promise((r) => setTimeout(r, 1));
  assert(!alarmRegistry.has(`agent:${slug}`), "FALSIFICATION TARGET: no orphan recurring alarm for a replaced legacy row");
  const live = (await listScheduledTasks()).find((t) => t.name === `agent:${slug}`);
  assert(!live || live.cancelling === true, "no live task row survives either");
});

// ── wiring pins ─────────────────────────────────────────────────────────────
Deno.test("wiring: the SW routes through the extracted factory + the gate, and never crosses recipe: on agent delete", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes("agentScheduleRoutes"), "the merged handlers include the extracted schedule routes");
  assert(sw.includes("createApplyAgentSchedule({"), "the SW wires the extracted applyAgentSchedule factory (the revalidation fence lives in it)");
  assert(!/async function applyAgentSchedule/.test(sw), "no inline applyAgentSchedule remains in the SW (the fence would be untestable)");
  assert(sw.includes("createNamedAgentDeleteGate(context"), "named-agent.delete composes the extracted gate");
  const deleteBlock = sw.match(/async "named-agent\.delete"[\s\S]*?\n  \},\n/);
  assert(deleteBlock, "named-agent.delete route found");
  assert(!deleteBlock[0].includes("recipe:${slug}"), "named-agent.delete never touches the recipe:<slug> family");
  assert(!deleteBlock[0].includes('cancelScheduledTaskBackground(`agent:'), "the cancel lives inside the gate (before deletion), not after it");
  // The fire path routes agent: schedules as named-agent runs (round-1 work, pinned).
  assert(/alarm\.name\.startsWith\("agent:"\)/.test(sw), "the fire path's agent: branch is present");
});
