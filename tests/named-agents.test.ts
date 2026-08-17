// Unit tests for the named-agent layer: the registry (create/update/delete/
// list/get) + the name generator + the memory_grep tool. named-agents.js is
// tested with a minimal chrome.storage.local + OPFS mock (the optional
// "storage" permission drives the kv backend; OPFS is mocked for the sandbox).
// @ts-nocheck — the chrome + OPFS mock is intentionally dynamic (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  createNamedAgent,
  deleteNamedAgent,
  generateAgentName,
  getNamedAgent,
  grepAgentMemory,
  initialAvatar,
  listNamedAgents,
  slugifyAgentId,
  updateNamedAgent,
} from "../extension/lib/named-agents.js";
import { namedAgentMemory, masterMemory } from "../extension/lib/memory.js";

// ---- in-memory chrome + OPFS mock ----
const store = new Map();
const granted = new Set(["storage"]); // the optional "storage" backend is on
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
// A tiny fake OPFS tree: path.join("/") -> Map of name -> (dir|file value).
const fs = new Map();
function dirPath(path) {
  return "/" + path.join("/");
}
function getDir(path) {
  let node = fs;
  for (const seg of path) {
    if (!node.has("d:" + seg)) node.set("d:" + seg, new Map());
    node = node.get("d:" + seg);
  }
  return node;
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
    getDirectory: async () => ({
      getDirectoryHandle: async (seg, { create } = {}) => {
        const node = create ? getDir([seg]) : (() => { const n = fs.get("d:" + seg); if (!n) throw new Error("missing"); return n; })();
        return dirHandle(node, seg);
      },
    }),
  },
  configurable: true,
});
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
    removeEntry: async (seg, opts) => { node.delete("d:" + seg); node.delete("f:" + seg); },
    entries: async function* () {
      for (const [k, v] of node) {
        yield [k.slice(2), { kind: k.startsWith("d:") ? "directory" : "file", getFile: async () => ({ size: new TextEncoder().encode(v.text ?? "").length }) }];
      }
    },
  };
}

Deno.test("named agents: create → get → update → list → delete", async () => {
  const created = await createNamedAgent({ name: "PR Reviewer", role: "reviews my GitHub PRs" });
  assert(created.ok, "create ok");
  const id = created.agent.id;
  assertEquals(id, "pr-reviewer", "slugified id");

  const got = await getNamedAgent(id);
  assertEquals(got.name, "PR Reviewer");
  assertEquals(got.role, "reviews my GitHub PRs");

  const updated = await updateNamedAgent(id, { name: "PR Penguin", role: "reviews PRs" });
  assert(updated.ok);
  assertEquals(updated.agent.name, "PR Penguin");

  const list = await listNamedAgents();
  assertEquals(list.length, 1);
  assertEquals(list[0].name, "PR Penguin");

  const del = await deleteNamedAgent(id);
  assert(del.ok);
  assertEquals(await getNamedAgent(id), null);
  assertEquals((await listNamedAgents()).length, 0);
});

Deno.test("named agents: the name generator is deterministic + quirky", () => {
  const a = generateAgentName("pr-reviewer");
  const b = generateAgentName("pr-reviewer");
  assertEquals(a, b, "same seed → same name");
  assert(/[A-Z][a-z]+ [A-Z][a-z]+/.test(a), "an alliterative-ish two-word name");
});

Deno.test("named agents: slugify is safe + initialAvatar returns a data URL", () => {
  assertEquals(slugifyAgentId("My  Agent!!"), "my-agent");
  assertEquals(slugifyAgentId("   "), "");
  const av = initialAvatar("PR Penguin");
  assert(av.startsWith("data:image/svg+xml;base64,"), "an SVG data URL");
});

Deno.test("named agents: memory_grep searches the agent's own memory + history", async () => {
  const mem = namedAgentMemory("pr-reviewer");
  await mem.setTrusted("note", "the PR #42 needs a rebase before merge");
  await mem.setTrusted("journal", [
    { type: "task", task: "review PR #42" },
    { type: "result", result: "looks good, needs a rebase" },
  ]);
  const res = await grepAgentMemory(mem, "rebase");
  assert(res.count >= 2, "matches memory + history");
  assert(res.matches.some((m) => m.source === "memory"), "a memory match");
  assert(res.matches.some((m) => m.source === "history"), "a history match");
  const miss = await grepAgentMemory(mem, "zzz-not-present");
  assertEquals(miss.count, 0);
  await mem.clear();
});

Deno.test("named agents: the agent's run history lives in its OWN journal (isolated)", async () => {
  const created = await createNamedAgent({ name: "Summarizer" });
  assert(created.ok, "create ok");
  const mem = namedAgentMemory(created.agent.id);
  // The named-agent.run history (the named-agent.history route's data source):
  // task/result/tool-call rows in the agent's OWN journal.
  await mem.setTrusted("journal", [
    { type: "task", task: "summarise the page" },
    { type: "tool-call", tool: "open_tab", args: '{"url":"https://x.example"}' },
    { type: "result", result: "here is the summary" },
  ]);
  const journal = (await mem.get("journal")) ?? [];
  assertEquals(journal.length, 3, "the agent's journal holds its run history");
  assert(journal.some((e) => e.type === "tool-call"), "the run history includes tool calls");
  assert(journal.some((e) => e.type === "result"), "the run history includes the result");
  // Isolation: the MASTER journal is unaffected (the agent runs read/write their
  // own tier, never the master's).
  const masterJournal = (await masterMemory().get("journal")) ?? [];
  assertEquals(Array.isArray(masterJournal) ? masterJournal.length : 0, 0, "the master journal is separate");
  await deleteNamedAgent(created.agent.id);
});

Deno.test("named agents: create with an explicit id keeps the id", async () => {
  const created = await createNamedAgent({ id: "reader", name: "My Reader", role: "summarises articles" });
  assert(created.ok);
  assertEquals(created.agent.id, "reader");
  await deleteNamedAgent("reader");
});
