// tools-memory.test.ts — a test SUITE per memory tool (memory_set/get/list/grep)
// against a shimmed in-memory store (no OPFS): the tool WRITES/READS/LISTS/
// SEARCHES + the error cases (not enrolled, re-enrolled generation mismatch,
// reserved-key + oversize rejection, and the scoped toolset omitting memory_set).
// @ts-nocheck

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { memoryToolset } from "../extension/lib/agent.js";

// A tiny in-memory memory store with a version token (mirrors the OPFS store's
// set→version contract used by the CAS compensation).
function makeMemory() {
  const map = new Map();
  let version = 0;
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async has(key) {
      return map.has(key);
    },
    async set(key, value) {
      // Reserved authority keys are owner-only (never model-writable) — mirror
      // the store's reserved-key rejection.
      if (key === "origins" || key === "enrollment") {
        throw new Error(`reserved key ${key} is not writable by the model`);
      }
      const s = JSON.stringify(value);
      if (s.length > 256 * 1024) throw new Error("value exceeds 256 KiB bound");
      map.set(key, value);
      version += 1;
      return version;
    },
    async keys() {
      return [...map.keys()];
    },
    async delete(key) {
      map.delete(key);
    },
    _map: map,
  };
}

function tools(mem, opts = {}) {
  return memoryToolset(mem, opts.enrollmentGuard ?? null, opts.getRunGen ?? null, opts.readOnly ?? false);
}

Deno.test("memory_set: writes a value and returns ok", async () => {
  const mem = makeMemory();
  const r = await tools(mem).memory_set.execute({ key: "note", value: { text: "hello" } });
  assert(r.ok, `memory_set should succeed, got ${JSON.stringify(r)}`);
  assertEquals((await mem.get("note")).text, "hello");
});

Deno.test("memory_get: reads a value back", async () => {
  const mem = makeMemory();
  await mem.set("note", { text: "hello" });
  const r = await tools(mem).memory_get.execute({ key: "note" });
  assertEquals(r.key, "note");
  assertEquals(r.value.text, "hello");
});

Deno.test("memory_get: returns null for an absent key", async () => {
  const mem = makeMemory();
  const r = await tools(mem).memory_get.execute({ key: "nope" });
  assertEquals(r.value, null);
});

Deno.test("memory_list: lists the keys", async () => {
  const mem = makeMemory();
  await mem.set("a", 1);
  await mem.set("b", 2);
  const r = await tools(mem).memory_list.execute({});
  assertEquals(r.keys.sort(), ["a", "b"]);
});

Deno.test("memory_grep: finds a matching key + a journal entry", async () => {
  const mem = makeMemory();
  await mem.set("pr-notes", "the PR reviewer flagged a bug");
  await mem.set("journal", [{ kind: "task", text: "review the PR" }]);
  const r = await tools(mem).memory_grep.execute({ query: "PR" });
  assert(r.matches && r.matches.length > 0, `grep should find matches, got ${JSON.stringify(r)}`);
});

Deno.test("memory_set: REJECTS a reserved authority key (never model-writable)", async () => {
  const mem = makeMemory();
  const r = await tools(mem).memory_set.execute({ key: "origins", value: ["evil"] });
  assert(!r.ok);
  assertStringIncludes(r.error, "reserved");
});

Deno.test("memory_set: REJECTS an oversized value", async () => {
  const mem = makeMemory();
  const big = { blob: "x".repeat(300 * 1024) };
  const r = await tools(mem).memory_set.execute({ key: "big", value: big });
  assert(!r.ok);
  assertStringIncludes(r.error, "256 KiB");
});

Deno.test("memory tools: REJECT when the origin is not enrolled", async () => {
  const mem = makeMemory();
  const t = tools(mem, { enrollmentGuard: async () => ({ ok: false, error: "origin not enrolled" }) });
  const w = await t.memory_set.execute({ key: "x", value: 1 });
  assert(!w.ok);
  assertStringIncludes(w.error, "not enrolled");
  const r = await t.memory_get.execute({ key: "x" });
  assert(!r.ok);
});

Deno.test("memory tools: REJECT on a re-enrolled generation mismatch (the ABA guard)", async () => {
  const mem = makeMemory();
  // The run started at gen 1; the origin was re-enrolled to gen 2 mid-run.
  const t = tools(mem, {
    enrollmentGuard: async () => ({ ok: true, gen: 2 }),
    getRunGen: () => 1,
  });
  const w = await t.memory_set.execute({ key: "x", value: 1 });
  assert(!w.ok);
  assertStringIncludes(w.error, "re-enrolled");
  const r = await t.memory_get.execute({ key: "x" });
  assert(!r.ok);
});

Deno.test("memory scoped (readOnly) toolset omits memory_set (side-effect-free)", () => {
  const t = tools(makeMemory(), { readOnly: true });
  assert(t.memory_get && t.memory_list, "read tools must be present");
  assert(!t.memory_set, "memory_set must NOT be in the readOnly (scoped) set");
});
