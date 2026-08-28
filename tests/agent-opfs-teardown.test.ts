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

  // ASSETS: an artifact written before deletion (master store by design).
  await masterMemory().setTrusted("assets", { index: { a_1: { id: "a_1", title: "Report" } } });

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
  // 4. memory sandbox emptied (fresh-namespace semantics) — the old memory
  //    note is unrecoverable through the store APIs.
  const memAfter = namedAgentMemory(slug);
  assertEquals(await memAfter.get("memory:note"), null, "memory content purged");
  // 5. ASSETS SURVIVE.
  const assets = await masterMemory().get("assets");
  assertEquals(assets?.index?.a_1?.title, "Report", "assets survive agent deletion");
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
