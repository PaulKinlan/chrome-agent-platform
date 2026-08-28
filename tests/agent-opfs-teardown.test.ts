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
  assertEquals(calls.revoke, [slug], "revokeGrants got the agent slug");
  assertEquals(calls.close, [slug], "closeAgentWorker got the agent slug");

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
