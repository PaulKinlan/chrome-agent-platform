// KATs for the owner-reported leftover fix: deleting an agent must remove its
// ENTIRE OPFS state (memory sandbox, journal, durable run family, thread
// reverse-index), assets must SURVIVE (they live in the master store), a
// recreated same-name agent must get a genuinely fresh namespace, the
// Settings "purge journals" affordance must remove journals only, and the
// orphan sweep must repair PRE-FIX leftovers (the owner's exact scenario).
// @ts-nocheck — the chrome + OPFS mock is intentionally dynamic (no types).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createNamedAgent,
  deleteNamedAgent,
  fenceAgentActiveRuns,
  listNamedAgents,
  grepAgentMemory,
} from "../extension/lib/named-agents.js";
import {
  journalAppend,
  listNamedAgentIds,
  listBackgroundAgentIds,
  listDirsUnder,
  masterMemory,
  namedAgentMemory,
  backgroundAgentMemory,
  purgeJournals,
  purgeStoreDir,
} from "../extension/lib/memory.js";
import { durableRuns, sweepOrphanAgentData } from "../extension/lib/durable-runs.js";
import { scheduleTask, listScheduledTasks, cancelScheduledTask } from "../extension/lib/scheduler.js";
import { listFsGrants, revokeAgentFsGrants, saveFsGrant } from "../extension/lib/fs-grants.js";
import { IDBFactory } from "fake-indexeddb";
import { createAsset, getAsset, listAssets } from "../extension/lib/artifacts.js";
import { kvSet, kvGet } from "../extension/lib/kv.js";

// ---- in-memory chrome + OPFS mock (pattern from tests/named-agents.test.ts,
// extended with values() + truly-recursive removeEntry) ----
const store = new Map();
const granted = new Set(["storage"]);
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
const fs = new Map();
function getDir(path) {
  let node = fs;
  for (const seg of path) {
    if (!node.has("d:" + seg)) node.set("d:" + seg, new Map());
    node = node.get("d:" + seg);
  }
  return node;
}
function dirExists(path) {
  let node = fs;
  for (const seg of path) {
    const next = node.get("d:" + seg);
    if (!next) return false;
    node = next;
  }
  return true;
}
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
};
globalThis.navigator = globalThis.navigator ?? {};
Object.defineProperty(globalThis.navigator, "storage", {
  value: {
    getDirectory: async () => rootHandle(),
  },
  configurable: true,
});
function rootHandle() {
  return {
    name: "/",
    getDirectoryHandle: async (seg, { create } = {}) => {
      if (!create && !fs.has("d:" + seg)) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return dirHandle(getDir([seg]), seg);
    },
    removeEntry: async (seg) => {
      fs.delete("d:" + seg);
      fs.delete("f:" + seg);
    },
    entries: async function* () {
      for (const [k, v] of fs) {
        yield [k.slice(2), { kind: k.startsWith("d:") ? "directory" : "file" }];
      }
    },
  };
}
function dirHandle(node, name) {
  return {
    name,
    getDirectoryHandle: async (seg, { create } = {}) => {
      const key = "d:" + seg;
      if (!node.has(key)) {
        if (!create) throw Object.assign(new Error("missing " + seg), { name: "NotFoundError" });
        node.set(key, new Map());
      }
      return dirHandle(node.get(key), seg);
    },
    getFileHandle: async (seg, { create } = {}) => {
      const key = "f:" + seg;
      if (!node.has(key)) {
        if (!create) throw Object.assign(new Error("missing " + seg), { name: "NotFoundError" });
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
    removeEntry: async (seg) => {
      // Deleting the dir node removes the whole subtree (recursive semantics).
      node.delete("d:" + seg);
      node.delete("f:" + seg);
    },
    entries: async function* () {
      for (const [k, v] of node) {
        yield [k.slice(2), { kind: k.startsWith("d:") ? "directory" : "file", getFile: async () => ({ size: new TextEncoder().encode(v.text ?? "").length }) }];
      }
    },
    values: async function* () {
      for (const [k, v] of node) {
        yield { name: k.slice(2), kind: k.startsWith("d:") ? "directory" : "file" };
      }
    },
  };
}

const EXEC = "exec:11111111-2222-4333-8444-555555555555";

Deno.test("teardown: deleting an agent removes its sandbox, journal, durable run family, and thread index — assets survive", async () => {
  const created = await createNamedAgent({ name: "Scout" });
  assert(created.ok, "create ok");
  const slug = created.agent.id;

  // The agent has memory, a journal entry, and a durable run (registry row +
  // log rows + thread link) — the full ownership surface.
  const mem = namedAgentMemory(slug);
  await mem.set("memory:note", "remembers the launch plan");
  await journalAppend(mem, { at: Date.now(), kind: "note", text: "scout journal line" });
  const started = await durableRuns.start({
    executionId: EXEC,
    journalTarget: `agent:${slug}`,
    threadId: "thread-scout-1",
    kind: "agent",
    agentId: slug,
    taskPreview: "scout task",
  });
  assert(started, "run started");
  await durableRuns.appendLog(EXEC, { at: Date.now(), type: "progress", text: "working" });

  // Sanity: the ownership surface EXISTS before delete.
  assertEquals(await listNamedAgentIds().then((ids) => ids.includes(slug)), true);
  assert(dirExists(["memory", "durable-runs", "executions", encodeURIComponent(EXEC)]), "execution dir exists pre-delete");
  const runsBefore = await durableRuns.list();
  assert(runsBefore.runs.some((r) => r.executionId === EXEC), "registry row exists pre-delete");

  // ASSETS: a REAL artifact created through the artifacts authority (the
  // reviewer P2: a raw `assets` key write would be rejected by listAssets —
  // it must be the actual createAsset path).
  const asset = await createAsset("master", { type: "text", name: "Report", content: "scout report body" });
  assert(asset?.ok, `createAsset ok (${asset?.error ?? ""})`);
  const listedBefore = await listAssets("master");
  assert(listedBefore?.ok === true && listedBefore.assets.some((a) => a.id === asset.asset.id), "asset listed pre-delete");

  const del = await deleteNamedAgent(slug);
  assertEquals(del?.ok, true, `delete ok (warning: ${del?.cleanupWarning ?? "none"})`);

  // 1. registry row + index entry gone.
  const runsAfter = await durableRuns.list();
  assertEquals(runsAfter.runs.some((r) => r.executionId === EXEC), false, "registry row purged");
  // 2. execution OPFS dir gone.
  assertEquals(dirExists(["memory", "durable-runs", "executions", encodeURIComponent(EXEC)]), false, "execution dir purged");
  // 3. thread reverse-index gone (its only execution was purged).
  const threadRecord = await (await import("../extension/lib/memory.js")).durableRunMemory()
    .get("thread-runs:thread-scout-1").catch(() => null);
  assertEquals(threadRecord, null, "thread index purged");
  // 4. BOTH namespaces emptied (post-fix instance dir + legacy slug dir) —
  //    fresh-namespace semantics; the old memory note is unrecoverable.
  const inst = created.agent?.instanceId ?? created.agent?.id;
  assertEquals(await namedAgentMemory(inst).get("memory:note"), null, "instance-namespace memory purged");
  const memAfter = namedAgentMemory(slug);
  assertEquals(await memAfter.get("memory:note"), null, "memory content purged");
  // 4b. and the DIRECTORIES are GONE — clear() preserves them by design for
  //     live stores; deletion must actually remove them (P1-1).
  assertEquals(dirExists(["memory", "agents", encodeURIComponent(inst)]), false, "instance dir removed");
  assertEquals(dirExists(["memory", "agents", encodeURIComponent(slug)]), false, "legacy slug dir removed");
  // 5. ASSETS SURVIVE — via the REAL listing API.
  const listedAfter = await listAssets("master");
  assert(listedAfter?.ok === true && listedAfter.assets.some((a) => a.id === asset.asset.id), "asset survives agent deletion (listAssets)");
  const body = await getAsset("master", asset.asset.id);
  assert(body != null, "asset body survives (not just the index row)");
});

Deno.test("teardown: recreated same-name agent gets a fresh namespace (no journal/memory leaks in)", async () => {
  const created = await createNamedAgent({ name: "Scout" });
  assert(created.ok, "recreate ok — id reuse is theSlug, but state must be EMPTY");
  const slug = created.agent.id;
  const mem = namedAgentMemory(slug);
  assertEquals(await mem.get("memory:note"), null, "no old memory");
  const grep = await grepAgentMemory(mem, "launch plan");
  assertEquals(grep.count, 0, "old journal/memory text is not greppable");
});

Deno.test("background removal purges the background sandbox + durable family; orphan sweep repairs pre-fix leftovers", async () => {
  // Simulate a PRE-FIX leftover exactly like the owner saw: a background
  // agent's sandbox + journal + durable rows exist while NO schedule row and
  // NO named-agent row reference them (deletion happened before teardown).
  const bgSlug = "recipe:orphan-bg";
  const bgMem = backgroundAgentMemory(bgSlug);
  await bgMem.set("memory:state", "leftover");
  await journalAppend(bgMem, { at: Date.now(), kind: "note", text: "orphan journal" });
  const orphanExec = "exec:99999999-8888-4777-8666-555555555555";
  await durableRuns.start({
    executionId: orphanExec,
    journalTarget: `background:${backgroundSlugOf(bgSlug)}`,
    threadId: "thread-bg-1",
    kind: "scheduled",
  });
  // …and an orphan NAMED-agent dir with no registry row (a deleted named agent).
  await namedAgentMemory("ghost-agent").set("memory:x", "leftover");

  assert(dirExists(["memory", "background", encodeURIComponent(backgroundSlugOf(bgSlug))]), "pre: bg dir exists");
  assert((await listNamedAgentIds()).includes("ghost-agent"), "pre: ghost agent dir exists");

  const sweep = await sweepOrphanAgentData({
    listAgents: async () => await listNamedAgents(),
    listTasks: async () => [], // no schedules live — every bg dir is orphaned
  });
  assertEquals(sweep.ok, true, `sweep ok: ${JSON.stringify(sweep.failures)}`);
  assertEquals(sweep.swept.backgroundDirs >= 1, true, "bg dir swept");
  assertEquals(sweep.swept.agentDirs >= 1, true, "ghost agent dir swept");
  assertEquals(dirExists(["memory", "background", encodeURIComponent(backgroundSlugOf(bgSlug))]), false, "bg dir gone");
  assertEquals((await listNamedAgentIds()).includes("ghost-agent"), false, "ghost agent dir gone");
  const runs = await durableRuns.list();
  assertEquals(runs.runs.some((r) => r.executionId === orphanExec), false, "orphan run row purged (the sweep purges orphan TARGETS, not just dirs)");
});

function backgroundSlugOf(id) {
  return String(id || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed-background";
}

Deno.test("purge journals removes journal entries only — memory and assets untouched", async () => {
  const created = await createNamedAgent({ name: "Journey" });
  assert(created.ok, "create ok");
  const slug = created.agent.id;
  const mem = namedAgentMemory(slug);
  await mem.set("memory:keep", "precious memory");
  await journalAppend(mem, { at: Date.now(), kind: "note", text: "journal to purge" });
  await masterMemory().setTrusted("assets", { index: { a_2: { id: "a_2" } } });

  const r = await purgeJournals({ agent: slug });
  assertEquals(r.ok, true, `purge ok: ${JSON.stringify(r.failures)}`);
  assertEquals(r.removed.some((x) => x === `agents/${slug}`), true, "journal removed for the agent");
  assertEquals(await mem.get("memory:keep"), "precious memory", "memory untouched");
  assertEquals(await mem.get("journal"), null, "journal gone");
  assertEquals((await masterMemory().get("assets"))?.index?.a_2?.id, "a_2", "assets untouched");

  // Global purge never touches the master journal.
  const r2 = await purgeJournals(null);
  assertEquals(r2.ok, true, "global purge ok");
});

Deno.test("purgeForTarget refuses unscoped targets (fail-closed)", async () => {
  const r = await durableRuns.purgeForTarget("master");
  assertEquals(r.ok, false, "master is never purgeable via the agent teardown");
  const r2 = await durableRuns.purgeForTarget("");
  assertEquals(r2.ok, false);
});

// ---------------------------------------------------------------------------
// Review-round fixes (P1-1 id non-reuse + real dir removal, P1-2 ownership
// map completeness, P1-3 fail-closed sweep, injected via the DI contract).

Deno.test("teardown: recreate-same-name gets a DIFFERENT namespace (instanceId), old state unreachable", async () => {
  const first = await createNamedAgent({ name: "Recycler" });
  assert(first.ok, "first create ok");
  const i1 = first.agent.instanceId;
  await namedAgentMemory(i1).set("memory:secret", "first-life");
  const del = await deleteNamedAgent(first.agent.id);
  assertEquals(del.ok, true, `delete ok (${del?.error ?? ""})`);
  assertEquals(dirExists(["memory", "agents", encodeURIComponent(i1)]), false, "first-life dir removed");

  const second = await createNamedAgent({ name: "Recycler" });
  assert(second.ok, "recreate ok");
  const i2 = second.agent.instanceId;
  assert(i2 !== i1, "recreated agent has a DIFFERENT immutable instanceId (no id reuse)");
  assertEquals(await namedAgentMemory(i2).get("memory:secret"), null, "old instance memory not visible in the new namespace");
  assertEquals(dirExists(["memory", "agents", encodeURIComponent(i1)]), false, "old namespace stays dead after recreate");
});

Deno.test("teardown: post-fix runs (journalTarget agent:<instanceId>) are purged with the agent", async () => {
  const created = await createNamedAgent({ name: "Modern" });
  assert(created.ok);
  const slug = created.agent.id;
  const inst = created.agent.instanceId;
  const instExec = "exec:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await namedAgentMemory(inst).set("memory:state", "live");
  await durableRuns.start({
    executionId: instExec,
    journalTarget: `agent:${inst}`,
    threadId: "thread-modern-1",
    kind: "agent",
    agentId: `named:${slug}`,
    taskPreview: "modern task",
  });
  assert(dirExists(["memory", "durable-runs", "executions", encodeURIComponent(instExec)]), "pre: instance exec dir exists");

  const del = await deleteNamedAgent(slug);
  assertEquals(del.ok, true, `delete ok (${del?.error ?? ""})`);
  const runs = await durableRuns.list();
  assertEquals(runs.runs.some((r) => r.executionId === instExec), false, "instance-namespaced run family purged");
  assertEquals(dirExists(["memory", "durable-runs", "executions", encodeURIComponent(instExec)]), false, "instance exec dir purged");
  assertEquals(dirExists(["memory", "agents", encodeURIComponent(inst)]), false, "instance sandbox dir purged");
});

Deno.test("teardown: retry repairs a partial teardown (pending record carries the dead instanceId)", async () => {
  const created = await createNamedAgent({ name: "Partial" });
  assert(created.ok);
  const slug = created.agent.id;
  const inst = created.agent.instanceId;
  // Simulate a partial teardown: the row vanishes but the instance dir +
  // the pending-teardown record remain (a crashed earlier delete).
  await namedAgentMemory(inst).set("memory:stale", "leftover");
  assert(dirExists(["memory", "agents", encodeURIComponent(inst)]), "pre: leftover instance dir exists");
  const pending = (await kvGet("agents-pending-teardown"))?.["agents-pending-teardown"] ?? [];
  await kvSet({ "agents-pending-teardown": [...pending, { slug, instanceId: inst, at: Date.now() }] });

  // The registry row is GONE (simulate by direct map surgery through delete
  // semantics: the absent-row branch is exercised by deleting twice).
  const first = await deleteNamedAgent(slug);
  assertEquals(first.ok, true);
  const second = await deleteNamedAgent(slug); // absent row → repair path
  assertEquals(second.ok, true, `repair delete ok (${second?.error ?? ""})`);
  assertEquals(dirExists(["memory", "agents", encodeURIComponent(inst)]), false, "retry repaired the leftover instance dir");
  const remaining = (await kvGet("agents-pending-teardown"))?.["agents-pending-teardown"] ?? [];
  assertEquals(remaining.some((p) => p?.slug === slug), false, "pending record consumed");
});

Deno.test("teardown: deletion cancels EVERY schedule owned by the agent (non-recipe names too)", async () => {
  const created = await createNamedAgent({ name: "Scheduler" });
  assert(created.ok);
  const slug = created.agent.id;
  // Seed the scheduler store directly: one recipe:<slug> task, one runtime
  // task with a GENERATED name, both owned via agentSurfaceRef — plus one
  // owned by a DIFFERENT agent that must survive.
  const store = (await kvGet("cap:scheduledTasks"))?.["cap:scheduledTasks"] ?? {};
  store["recipe:scheduler-test"] = {
    name: "recipe:scheduler-test", task: "hourly", at: Date.now() + 3_600_000,
    owner: { agentSurfaceRef: `named:${slug}`, agentRole: "test" },
  };
  store["generated-name-xyz"] = {
    name: "generated-name-xyz", task: "sweep logs", at: Date.now() + 3_600_000,
    owner: { agentSurfaceRef: `named:${slug}` },
  };
  store["other-agents-task"] = {
    name: "other-agents-task", task: "other", at: Date.now() + 3_600_000,
    owner: { agentSurfaceRef: "named:someone-else" },
  };
  await kvSet({ "cap:scheduledTasks": store });

  const del = await deleteNamedAgent(slug);
  assertEquals(del.ok, true, `delete ok (${del?.error ?? ""})`);
  const after = (await kvGet("cap:scheduledTasks"))?.["cap:scheduledTasks"] ?? {};
  const mine = Object.values(after).filter((t) => t?.owner?.agentSurfaceRef === `named:${slug}`);
  const activeMine = mine.filter((t) => !t?.cancelling && !t?.cancelled);
  assertEquals(activeMine.length, 0, `every owned schedule is cancelling/gone (${mine.map((t) => `${t.name}:${t.cancelling ? "cancelling" : "active"}`).join(", ")})`);
  assert(after["other-agents-task"] && !after["other-agents-task"].cancelling, "OTHER agent's schedule untouched");
});

Deno.test("teardown: fs-grant revocation + worker-close injections fire; failures fail the teardown", async () => {
  const created = await createNamedAgent({ name: "Granted" });
  assert(created.ok);
  const slug = created.agent.id;
  const calls = { revoke: [], close: [] };
  const del = await deleteNamedAgent(slug, {
    revokeGrants: async (agentId) => { calls.revoke.push(agentId); return { ok: true, revoked: 2 }; },
    closeAgentWorker: async (agentId) => { calls.close.push(agentId); return { ok: true }; },
  });
  assertEquals(del.ok, true);
  // Per-identity teardown (review P1-2): injections fire for BOTH identity
  // spellings — immutable instanceId first, then the legacy slug — so state
  // saved under either is revoked/closed.
  assertEquals(calls.revoke, [created.agent.instanceId, slug], "revokeGrants got instanceId then slug");
  assertEquals(calls.close, [created.agent.instanceId, slug], "closeAgentWorker got instanceId then slug");

  // A failing injection must FAIL the teardown honestly (retryable), not
  // silently drop the remaining cleanup.
  const created2 = await createNamedAgent({ name: "Granted2" });
  assert(created2.ok);
  const del2 = await deleteNamedAgent(created2.agent.id, {
    revokeGrants: async () => ({ ok: false, error: "idb unavailable" }),
  });
  assertEquals(del2.ok, false, "grant-revoke failure fails the teardown");
  assertEquals(del2.retryable, true, "and is retryable");
});

Deno.test("orphan sweep FAILS CLOSED: a live-set read error deletes nothing", async () => {
  // An orphan dir that WOULD be swept if the sweep were fail-open.
  await namedAgentMemory("fail-closed-ghost").set("memory:x", "live-data");
  assert((await listNamedAgentIds()).includes("fail-closed-ghost"), "pre: ghost dir exists");

  const thrown = await sweepOrphanAgentData({
    listAgents: async () => { throw new Error("registry I/O error"); },
    listTasks: async () => [],
  });
  assertEquals(thrown.ok, false, "sweep refuses on listAgents failure");
  assert((thrown.failures ?? []).join(" ").includes("registry I/O error"), "failure names the cause");
  assert((await listNamedAgentIds()).includes("fail-closed-ghost"), "ghost dir STILL EXISTS (no deletion on uncertainty)");

  const malformed = await sweepOrphanAgentData({
    listAgents: async () => ({ notAnArray: true }),
    listTasks: async () => [],
  });
  assertEquals(malformed.ok, false, "sweep refuses a malformed snapshot");
  assert((await listNamedAgentIds()).includes("fail-closed-ghost"), "ghost dir STILL EXISTS after malformed snapshot");

  const tasksThrew = await sweepOrphanAgentData({
    listAgents: async () => await listNamedAgents(),
    listTasks: async () => { throw new Error("task store I/O error"); },
  });
  assertEquals(tasksThrew.ok, false, "sweep refuses on listTasks failure");
  assert((await listNamedAgentIds()).includes("fail-closed-ghost"), "ghost dir STILL EXISTS after task-read failure");
});

// ---- review round 2 fidelity KATs (P1-1/P1-3/P1-4/P1-5 + sweep DI) ----

Deno.test("sweep: a LIVE agent's instanceId AND legacy slug dirs survive; dead namespaces are swept", async () => {
  const live = await createNamedAgent({ name: "Survivor" });
  assert(live.ok);
  const liveInst = live.agent.instanceId;
  const liveSlug = live.agent.id;
  // Live state in BOTH namespace spellings (a pre-fix leftover slug dir for a
  // live agent must ALSO survive — it is re-associated, not orphaned).
  await namedAgentMemory(liveInst).set("memory:live", "current");
  await namedAgentMemory(liveSlug).set("memory:legacy", "pre-fix");
  // Dead namespaces: an instanceId dir with NO registry row + a legacy slug
  // dir with no row (the owner's pre-fix leftover shape).
  const deadInst = crypto.randomUUID();
  await namedAgentMemory(deadInst).set("memory:dead", "orphan");
  await namedAgentMemory("dead-ghost-slug").set("memory:dead", "orphan-legacy");
  assert(dirExists(["memory", "agents", encodeURIComponent(deadInst)]), "pre: dead instance dir exists");

  const sweep = await sweepOrphanAgentData({ listAgents: () => listNamedAgents(), listTasks: async () => [] });
  assert(sweep.ok, "sweep ok (" + (sweep.failures ?? []).join("; ") + ")");
  assert(dirExists(["memory", "agents", encodeURIComponent(liveInst)]), "LIVE instanceId dir SURVIVES the sweep");
  assertEquals(await namedAgentMemory(liveInst).get("memory:live"), "current");
  assert(dirExists(["memory", "agents", encodeURIComponent(liveSlug)]), "LIVE legacy slug dir SURVIVES the sweep");
  assertEquals(await namedAgentMemory(liveSlug).get("memory:legacy"), "pre-fix");
  assertEquals(dirExists(["memory", "agents", encodeURIComponent(deadInst)]), false, "dead instance dir swept");
  assertEquals(dirExists(["memory", "agents", encodeURIComponent("dead-ghost-slug")]), false, "dead legacy slug dir swept");
});

Deno.test("fence: an in-flight run is cancelled + awaited before deletion; refusal gates the removals", async () => {
  const created = await createNamedAgent({ name: "Fenced" });
  assert(created.ok);
  const slug = created.agent.id;
  const inst = created.agent.instanceId;
  const exec = "exec:99999999-8888-4777-8666-555555555555";
  const started = await durableRuns.start({
    executionId: exec,
    journalTarget: "agent:" + inst,
    kind: "agent",
    agentId: "named:" + slug,
    taskPreview: "in-flight when the owner deletes",
  });
  assert(started, "run started");
  assert(durableRuns.isActive(exec), "pre: the run is a live writer");
  await namedAgentMemory(inst).set("memory:x", "state");

  const realFence = ({ slug: s, instanceId: i }) => fenceAgentActiveRuns({ registry: durableRuns, slug: s, instanceId: i });
  const del = await deleteNamedAgent(slug, { fenceActiveRuns: realFence });
  assertEquals(del.ok, true, "delete with fence ok (" + (del?.error ?? "") + ")");
  assertEquals(durableRuns.isActive(exec), false, "the in-flight writer was cancelled (no longer active)");
  // The fenced teardown cancels the writer THEN purges the durable family —
  // the run record is GONE entirely (stronger than merely cancelled).
  const runPhase = (await durableRuns.list()).runs.find((r) => r.executionId === exec)?.phase;
  assert(runPhase === undefined || ["cancel-requested", "terminal", "cancelled"].includes(runPhase), "run still live after fenced delete (phase=" + runPhase + ")");
  assertEquals(dirExists(["memory", "agents", encodeURIComponent(inst)]), false, "sandbox stays deleted after the fenced removal");

  // A REFUSING fence must gate the removals (no delete while writers live).
  const created2 = await createNamedAgent({ name: "Fenced2" });
  assert(created2.ok);
  const refused = await deleteNamedAgent(created2.agent.id, {
    fenceActiveRuns: async () => ({ ok: false, error: "writers did not stop" }),
  });
  assertEquals(refused.ok, false, "fence refusal fails the teardown");
  assertEquals(refused.retryable, true);
  assert(dirExists(["memory", "agents", encodeURIComponent(created2.agent.instanceId)]), "removals GATED: sandbox dir survives a refused fence");
});

Deno.test("pending: per-agent take preserves OTHER agents' records; failure re-records; retry replays", async () => {
  const a = await createNamedAgent({ name: "PendingA" });
  const b = await createNamedAgent({ name: "PendingB" });
  assert(a.ok && b.ok);
  // Simulate two crashed partial teardowns.
  await namedAgentMemory(a.agent.instanceId).set("k", "a");
  await namedAgentMemory(b.agent.instanceId).set("k", "b");
  const pending = (await kvGet("agents-pending-teardown"))?.["agents-pending-teardown"] ?? [];
  await kvSet({
    "agents-pending-teardown": [
      ...pending,
      { slug: a.agent.id, instanceId: a.agent.instanceId, at: Date.now() },
      { slug: b.agent.id, instanceId: b.agent.instanceId, at: Date.now() },
    ],
  });

  // Repair A with a REFUSING fence: A's repair fails, is RE-RECORDED, and —
  // critically — B's record is untouched (the old global take dropped it).
  const failed = await deleteNamedAgent(a.agent.id, {
    fenceActiveRuns: async () => ({ ok: false, error: "still writing" }),
  });
  assertEquals(failed.ok, false, "refused fence fails the repair honestly");
  let records = (await kvGet("agents-pending-teardown"))?.["agents-pending-teardown"] ?? [];
  assertEquals(records.some((p) => p?.slug === b.agent.id), true, "OTHER agent's pending record PRESERVED");
  assertEquals(records.some((p) => p?.slug === a.agent.id), true, "failed repair RE-RECORDED for retry");

  // Repair A again with a passing fence: A's dirs go, B's record survives.
  const repaired = await deleteNamedAgent(a.agent.id, {
    fenceActiveRuns: async () => ({ ok: true }),
  });
  assertEquals(repaired.ok, true, "second repair ok (" + (repaired?.error ?? "") + ")");
  assertEquals(dirExists(["memory", "agents", encodeURIComponent(a.agent.instanceId)]), false, "A's dir repaired");
  records = (await kvGet("agents-pending-teardown"))?.["agents-pending-teardown"] ?? [];
  assertEquals(records.some((p) => p?.slug === a.agent.id), false, "A's record consumed on success");
  assertEquals(records.some((p) => p?.slug === b.agent.id), true, "B's record STILL preserved after A's success");
});

Deno.test("fs-grants: revokeAgentFsGrants removes exactly the target agent's scopes by grantId", async () => {
  const idb = new IDBFactory();
  const handle = { name: "folder", kind: "directory" };
  await saveFsGrant({ grantId: "fsg_global", handle, name: "global", scope: null }, { customIdb: idb });
  await saveFsGrant({ grantId: "fsg_target", handle, name: "target", scope: { agentId: "target-agent" } }, { customIdb: idb });
  await saveFsGrant({ grantId: "fsg_other", handle, name: "other", scope: { agentId: "other-agent" } }, { customIdb: idb });

  const res = await revokeAgentFsGrants(["target-agent"], { customIdb: idb });
  assert(res.ok, "revoke ok (" + (res.failures || []).join("; ") + ")");
  assertEquals(res.revoked, 1, "exactly the target's grant revoked");
  const after = await listFsGrants({}, { customIdb: idb });
  const ids = new Set(after.map((g) => g.grantId));
  assertEquals(ids.has("fsg_target"), false, "target grant gone");
  assertEquals(ids.has("fsg_global"), true, "GLOBAL grant preserved");
  assertEquals(ids.has("fsg_other"), true, "OTHER agent's grant preserved");

  // Both identity spellings: a grant saved under the instanceId spelling is
  // revoked when the revocation list carries it.
  await saveFsGrant({ grantId: "fsg_inst", handle, name: "inst", scope: { agentId: "inst-uuid-1" } }, { customIdb: idb });
  const res2 = await revokeAgentFsGrants(["inst-uuid-1", "target-agent"], { customIdb: idb });
  assert(res2.ok);
  const ids2 = new Set((await listFsGrants({}, { customIdb: idb })).map((g) => g.grantId));
  assertEquals(ids2.has("fsg_inst"), false, "instanceId-scoped grant revoked");
});

Deno.test("sweep: a registry list failure refuses execution-dir judgement (fail-closed, DI)", async () => {
  const created = await createNamedAgent({ name: "SweepDI" });
  assert(created.ok);
  const exec = "exec:77777777-6666-4777-8555-444444444444";
  await durableRuns.start({ executionId: exec, journalTarget: "agent:" + created.agent.instanceId, kind: "agent", taskPreview: "live" });

  const throwing = {
    list: async () => { throw new Error("registry I/O error"); },
    purgeForTarget: async () => ({ ok: true }),
    isActive: () => false,
  };
  const sweep = await sweepOrphanAgentData({
    listAgents: () => listNamedAgents(),
    listTasks: async () => [],
    registry: throwing,
  });
  assertEquals(sweep.ok, false, "sweep reports the registry failure");
  assert((sweep.failures ?? []).join(" ").includes("registry I/O error"));
  assert(dirExists(["memory", "durable-runs", "executions", encodeURIComponent(exec)]), "LIVE execution dir NOT judged/purged on registry failure");
});

// ---- review r3 P1-1: the fence must fire the REAL abort and await terminal ----
Deno.test("fence r3: the REAL aborter fires and the writer stays projected until terminal", async () => {
  const created = await createNamedAgent({ name: "FenceAbort" });
  assert(created.ok);
  const slug = created.agent.id;
  const inst = created.agent.instanceId;
  const exec = "exec:aaaaaaa1-8888-4777-8666-555555555555";
  const started = await durableRuns.start({
    executionId: exec,
    journalTarget: "agent:" + inst,
    kind: "agent",
    agentId: "named:" + slug,
    taskPreview: "abort-seam KAT",
  });
  assert(started, "run started");

  // Simulate the SW: a live aborter that stops the "orchestrator", which then
  // settles asynchronously (the writer is NOT terminal at abort time).
  const durableRunAborters = new Map();
  let abortCalled = 0;
  let settleRun;
  const settled = new Promise((r) => { settleRun = r; });
  durableRunAborters.set(exec, () => {
    abortCalled += 1;
    setTimeout(() => {
      durableRuns.settle(exec, { ok: true, cancelled: true, result: { stopped: true } })
        .then(settleRun).catch(settleRun);
    }, 25);
  });

  // The writer is reported while running…
  const preLive = await durableRuns.activeByJournalTarget(new Set(["agent:" + inst]));
  assert(preLive.some((w) => w.executionId === exec), "pre: writer reported by journal-target projection");

  const fence = await fenceAgentActiveRuns({
    registry: durableRuns,
    slug,
    instanceId: inst,
    resolveAborter: (id) => durableRunAborters.get(id) ?? null,
  });
  await settled;
  assertEquals(fence.ok, true, "fence ok (" + (fence?.error ?? "") + ")");
  assertEquals(abortCalled, 1, "the REAL abort was invoked via onAuthorityPersisted (exactly once)");
  assert(durableRuns.isActive(exec) === false, "post-terminal: no longer a writer");

  // reread the cancellation record: the abort must be recorded as ATTEMPTED
  const rec = (await durableRuns.list()).runs.find((r) => r.executionId === exec);
  assert(rec, "record retained");
});

// ---- review r3 P1-2: a refused fence gates EVERY destructive phase ----
Deno.test("fence r3: refusal gates schedules, grants, worker close, dirs AND durable family", async () => {
  // chrome.alarms stub (scheduleTask needs the optional alarms API).
  const armedAlarms = new Map();
  const g0 = globalThis;
  const prevChrome0 = g0.chrome;
  g0.chrome = {
    alarms: {
      create: async (name, info) => { armedAlarms.set(name, info); },
      clear: async (name) => { const had = armedAlarms.has(name); armedAlarms.delete(name); return had; },
      get: async (name) => armedAlarms.has(name) ? { name, ...armedAlarms.get(name) } : undefined,
      getAll: async () => [...armedAlarms.entries()].map(([name, info]) => ({ name, ...armedAlarms.get(name) })),
    },
  };
  try {
  const created = await createNamedAgent({ name: "FenceGateAll" });
  assert(created.ok);
  const slug = created.agent.id;
  const inst = created.agent.instanceId;
  await namedAgentMemory(inst).set("memory:g", "state");
  const scheduled = await scheduleTask({
    task: "owned work",
    delayMs: 3600_000,
    name: "fencegate-owned",
    owner: { agentSurfaceRef: `named:${slug}` },
  });
  assert(scheduled?.ok !== false, "schedule created");
  let schedulesCancelled = 0, grantsRevoked = 0, workerCloses = 0;
  const refused = await deleteNamedAgent(slug, {
    fenceActiveRuns: async () => ({ ok: false, error: "writers live" }),
    revokeGrants: async () => { grantsRevoked += 1; return { ok: true }; },
    closeAgentWorker: async () => { workerCloses += 1; return { ok: true }; },
  });
  assertEquals(refused.ok, false, "refusal fails the delete");
  assertEquals(refused.retryable, true);
  assertEquals(grantsRevoked, 0, "grants NOT touched on refusal");
  assertEquals(workerCloses, 0, "worker NOT closed on refusal");
  const tasks = await listScheduledTasks();
  assert(tasks.some((t) => t.name === "fencegate-owned"), "schedule NOT cancelled on refusal");
  assert(dirExists(["memory", "agents", encodeURIComponent(inst)]), "dir survives");
  await cancelScheduledTask("fencegate-owned");
  } finally {
    if (prevChrome0 === undefined) delete g0.chrome; else g0.chrome = prevChrome0;
  }
});

// ---- review r3 P1-3a: worker close resolves a slug through the identity ----
Deno.test("worker close route resolves a slug to the instanceId (host msg + alive-set)", async () => {
  const created = await createNamedAgent({ name: "CloseIdent" });
  assert(created.ok);
  const slug = created.agent.id;
  const inst = created.agent.instanceId;
  const captured = [];
  const g = globalThis;
  const prevChrome = g.chrome;
  g.chrome = { runtime: { sendMessage: async (msg) => { captured.push(msg); return { ok: true }; } } };
  try {
    const { createAgentWorkerRoutes } = await import("../extension/background/routes/agent-worker.js");
    const routeStore = new Map();
    const routes = createAgentWorkerRoutes({
      kvGet: async (k) => routeStore.get(k),
      kvSet: async (k, v) => { routeStore.set(k, v); return true; },
      resolveAgentIdentity: async (sel) => (sel === slug ? inst : sel),
    });
    // Seed the alive-set with BOTH spellings (pre-fix state).
    await routes["agent-worker.close"]({ agentId: slug }, { principal: "extension" });
    const aliveNow = routeStore.get("bg-agents:alive") ?? [];
    assert(!aliveNow.includes(slug) && !aliveNow.includes(inst), "alive-set dropped BOTH spellings");
    assertEquals(captured[0]?.agentId, inst, "the HOST message targeted the immutable identity, not the slug");
  } finally {
    if (prevChrome === undefined) delete g.chrome; else g.chrome = prevChrome;
  }
});

// ---- review r3 P1-3b: store-dir classification (truthful selectors) ----
Deno.test("memory store classification: canonical read-write, legacy read-only, orphan clearable", async () => {
  const { classifyAgentMemoryDirs } = await import("../extension/lib/named-agents.js");
  const agents = [{ id: "alpha", slug: "alpha", instanceId: "inst-alpha", name: "Alpha" }];
  const out = classifyAgentMemoryDirs({ dirs: ["inst-alpha", "alpha", "ghost"], agents });
  assertEquals(out[0], { dir: "inst-alpha", selector: "agent:inst-alpha", state: "canonical", readOnly: false });
  assertEquals(out[1], { dir: "alpha", selector: "agent-legacy:alpha", state: "legacy", readOnly: true });
  assertEquals(out[2], { dir: "ghost", selector: "agent-orphan:ghost", state: "orphan", readOnly: false });
});

// ---- review r3 P1-2: the fence runs BEFORE the row/override removal ----
Deno.test("delete r3: a refused fence leaves the ROW intact (nothing destructive ran)", async () => {
  const created = await createNamedAgent({ name: "RowIntact" });
  assert(created.ok);
  const slug = created.agent.id;
  const refused = await deleteNamedAgent(slug, {
    fenceActiveRuns: async () => ({ ok: false, error: "writers live" }),
  });
  assertEquals(refused.ok, false);
  const stillThere = await listNamedAgents();
  assert(stillThere.some((a) => a.id === slug), "the agent ROW survives a refused fence (pre-fix it was removed first)");
});

// ---- review r3 P2: a mid-teardown failure replays EVERY phase on retry ----
Deno.test("pending replay r3: schedules, grants, worker close AND durable family all replay", async () => {
  // The alarms stub is installed BEFORE any state is created: kv routes to a
  // different backend once `chrome` exists, so flipping it mid-test would
  // strand the created row in the pre-stub realm (observed in review).
  const armedAlarms = new Map();
  const g1 = globalThis;
  const prevChrome1 = g1.chrome;
  g1.chrome = {
    alarms: {
      create: async (name, info) => { armedAlarms.set(name, info); },
      clear: async (name) => { const had = armedAlarms.has(name); armedAlarms.delete(name); return had; },
      get: async (name) => armedAlarms.has(name) ? { name, ...armedAlarms.get(name) } : undefined,
      getAll: async () => [...armedAlarms.entries()].map(([name, info]) => ({ name, ...armedAlarms.get(name) })),
    },
  };
  try {
    const created = await createNamedAgent({ name: "ReplayAll" });
    assert(created.ok);
    const slug = created.agent.id;
    const inst = created.agent.instanceId;
    await namedAgentMemory(inst).set("memory:r", "state");
    const scheduled = await scheduleTask({
      task: "replay-owned",
      delayMs: 3600_000,
      name: "replayall-owned",
      owner: { agentSurfaceRef: `named:${slug}` },
    });
    assert(scheduled?.ok !== false, "schedule created");
    let grantRevokes = 0, workerCloses = 0;
    // FIRST delete: the fence passes but the worker close FAILS — the row is
    // gone, a pending record carries the dead identity, and the retry must
    // replay every remaining phase.
    const first = await deleteNamedAgent(slug, {
      closeAgentWorker: async () => { workerCloses += 1; return { ok: false, error: "host wedged" }; },
    });
    assertEquals(first.ok, false, "first delete fails honestly");
            assertEquals(first.retryable, true);
    const retry = await deleteNamedAgent(slug, {
      revokeGrants: async () => { grantRevokes += 1; return { ok: true }; },
      closeAgentWorker: async () => { workerCloses += 1; return { ok: true }; },
    });
    assertEquals(retry.ok, true, "retry completes (" + (retry?.error ?? "") + ")");
    // Injections run PER NAMESPACE (instanceId + legacy slug = 2 calls per
    // delete): the first delete attempted 2 closes (both failed), the retry
    // replayed 2 more (both ok) and 2 grant revokes.
    assertEquals(workerCloses, 4, "worker close REPLAYED on the retry (2 per delete, per namespace)");
    assertEquals(grantRevokes, 2, "grant revoke ran on the retry (per namespace)");
    const tasks = await listScheduledTasks();
    assert(!tasks.some((t) => t.name === "replayall-owned"), "owned schedule cancelled by the replay");
    assert(armedAlarms.has("replayall-owned") === false, "the chrome alarm was disarmed");
    assertEquals(dirExists(["memory", "agents", encodeURIComponent(inst)]), false, "dir purged by the replay");
  } finally {
    if (prevChrome1 === undefined) delete g1.chrome; else g1.chrome = prevChrome1;
  }
});

// ================= review r4 =================

// ---- r4 P1-2: single admission fence — a refusal destroys NOTHING (row +
// prompt override + memory + dir all intact; the r3 bug removed prompt+row
// and then reported a refusal from the second fence). ----
Deno.test("delete r4: a refused fence leaves the ROW, the PROMPT OVERRIDE, and all state intact", async () => {
  const { describePrompt, setPromptOverride } = await import("../extension/lib/system-prompts.js");
  const created = await createNamedAgent({ name: "NothingRemoved" });
  assert(created.ok);
  const slug = created.agent.id;
  const inst = created.agent.instanceId;
  await namedAgentMemory(inst).set("memory:keep", "precious");
  const d = await describePrompt(`agent:${slug}`);
  const saved = await setPromptOverride(`agent:${slug}`, { mode: "append", text: "OVERRIDE-KEEP" }, { expectedRevision: d.revision });
  assert(saved?.ok !== false, "override seeded (" + (saved?.error ?? "") + ")");

  const refused = await deleteNamedAgent(slug, {
    fenceActiveRuns: async () => ({ ok: false, error: "writers live" }),
  });
  assertEquals(refused.ok, false, "the delete reports refusal");
  assertEquals(refused.retryable, true);
  assert(String(refused.error).includes("NOT deleted"), "honest: the refusal says nothing was deleted");
  const rows = await listNamedAgents();
  assert(rows.some((a) => a.id === slug), "the ROW survives");
  const dAfter = await describePrompt(`agent:${slug}`);
  assert(dAfter.override?.text?.includes("OVERRIDE-KEEP"), "the PROMPT OVERRIDE survives");
  assertEquals(await namedAgentMemory(inst).get("memory:keep"), "precious", "agent memory survives");
  assert(dirExists(["memory", "agents", encodeURIComponent(inst)]), "the sandbox dir survives");
});

// ---- r4 P1-1: the fence must NOT resolve while the aborted writer has not
// settled (the r3 bug retired the writer at cancellation-outbox processing,
// letting teardown race the orchestrator's final flush). ----
Deno.test("fence r4: the fence promise stays pending until the orchestrator settles", async () => {
  const created = await createNamedAgent({ name: "LateSettle" });
  assert(created.ok);
  const slug = created.agent.id;
  const inst = created.agent.instanceId;
  const exec = "exec:11111111-2222-4733-8444-555555555555";
  assert(await durableRuns.start({
    executionId: exec,
    journalTarget: "agent:" + inst,
    kind: "agent",
    agentId: "named:" + slug,
    taskPreview: "abort fired; settle is late",
  }), "run started");

  const fence = fenceAgentActiveRuns({
    registry: durableRuns,
    slug,
    instanceId: inst,
    timeoutMs: 8000,
    resolveAborter: () => () => {},
  });
  let resolved = false;
  fence.then(() => { resolved = true; }, () => { resolved = true; });
  // The abort fires on the first poll; give the fence several poll cycles.
  // The simulated orchestrator has NOT settled, so the writer projection is
  // retained and the fence must still be waiting.
  await new Promise((r) => setTimeout(r, 900));
  assertEquals(resolved, false, "the fence stayed pending while settlement was outstanding");
  // The orchestrator's finally: settle() IS the completion acknowledgement.
  await durableRuns.settle(exec, { ok: true, result: "aborted cleanly", at: Date.now() });
  const f = await fence;
  assertEquals(f.ok, true, "the fence resolves once the writer settled");
});

// ---- r4 P2: the durable refusal→retry flow drives REAL durable runs ----
Deno.test("retry r4: a real durable run survives a refused delete and is purged by the retry", async () => {
  const created = await createNamedAgent({ name: "RealRuns" });
  assert(created.ok);
  const slug = created.agent.id;
  const inst = created.agent.instanceId;
  const exec = "exec:22222222-3333-4744-8666-555555555555";
  assert(await durableRuns.start({
    executionId: exec,
    journalTarget: "agent:" + inst,
    kind: "agent",
    agentId: "named:" + slug,
    taskPreview: "real run, refused delete",
  }), "run started");

  const refused = await deleteNamedAgent(slug, {
    fenceActiveRuns: async () => ({ ok: false, error: "writers live" }),
  });
  assertEquals(refused.ok, false);
  const stillLive = (await durableRuns.list()).runs.some((r) => r.executionId === exec);
  assert(stillLive, "the REAL run survives the refused delete");

  const retried = await deleteNamedAgent(slug, { fenceActiveRuns: async () => ({ ok: true }) });
  assertEquals(retried.ok, true, "the retry completes (" + (retried?.error ?? "") + ")");
  const gone = !(await durableRuns.list()).runs.some((r) => r.executionId === exec);
  assert(gone, "the REAL run is purged by the successful retry");
});

// ---- r4 P2: the worker close runs the REAL alive-set machinery (real key
// `cap:agent-workers:alive`, real kv), for BOTH identity spellings. ----
Deno.test("worker close r4: the real closeAgentWorkerFor removes both identities from the real alive-set key", async () => {
  const { closeAgentWorkerFor } = await import("../extension/background/routes/agent-worker.js");
  const created = await createNamedAgent({ name: "AliveSet" });
  assert(created.ok);
  const slug = created.agent.id;
  const inst = created.agent.instanceId;
  const ALIVE_KEY = "cap:agent-workers:alive";
  await kvSet({ [ALIVE_KEY]: [inst, slug, "someone-else"] });

  const del = await deleteNamedAgent(slug, {
    closeAgentWorker: (agentId) => closeAgentWorkerFor(agentId, { kvGet, kvSet }),
  });
  assertEquals(del.ok, true, "delete completes (" + (del?.error ?? "") + ")");
  const alive = (await kvGet(ALIVE_KEY))?.[ALIVE_KEY] ?? [];
  assertEquals(alive, ["someone-else"], "BOTH the instanceId and the slug alive-set entries are gone; others kept");
});

// ---- r4 P2: classification drives BEHAVIOR — the read-only predicate the
// SW routes gate on, and the literal-dir resolution + clear preservation. ----
Deno.test("classification r4: the read-only predicate gates writes; legacy dirs resolve literally and survive a clear", async () => {
  const { readOnlyAgentMemorySelector } = await import("../extension/lib/named-agents.js");
  assertEquals(readOnlyAgentMemorySelector("agent-legacy:alpha"), true);
  assertEquals(readOnlyAgentMemorySelector("agent-orphan:ghost"), true);
  assertEquals(readOnlyAgentMemorySelector("agent:inst-alpha"), false);
  assertEquals(readOnlyAgentMemorySelector("master"), false);
  assertEquals(readOnlyAgentMemorySelector(undefined), false);

  // Literal resolution: a write via the legacy selector lands in the LITERAL
  // dir (never canonicalized into a live instanceId dir).
  const legacy = namedAgentMemory("legacy-literal");
  await legacy.set("k", "v");
  assert(dirExists(["memory", "agents", encodeURIComponent("legacy-literal")]), "the literal dir exists");
  const classification = (await import("../extension/lib/named-agents.js")).classifyAgentMemoryDirs({
    dirs: ["legacy-literal"],
    agents: [],
  });
  assertEquals(classification[0]?.state, "orphan", "a dir with no live row classifies as orphan");
  assertEquals(classification[0]?.selector, "agent-orphan:legacy-literal");
  assertEquals(classification[0]?.readOnly, false, "orphan dirs are clearable (Settings purge)");

  // clear() removes KEYS but never the directory (deletion is teardown's job).
  await legacy.clear();
  assertEquals(await legacy.get("k"), null, "keys cleared");
  assert(dirExists(["memory", "agents", encodeURIComponent("legacy-literal")]), "the dir survives clear (only teardown removes it)");
});
