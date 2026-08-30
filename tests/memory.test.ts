// Unit test for the round-19 CRITICAL blocker: saveScreenshot re-acquired the
// non-reentrant global write mutex (withWriteLock → setTrusted → setValue →
// withWriteLock) and DEADLOCKED. This test drives saveScreenshot against a
// minimal in-memory OPFS fake and asserts it (a) completes (no deadlock), (b)
// writes the blob + commits the metadata index, and (c) charges the global quota.
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createMemoryRunLogHandles } from "../extension/lib/run-log-wal-memory.js";
import { masterMemory, siteMemory, MemoryStoreQuotaError, usageLedgerInspector, saveScreenshot, listScreenshots, journalAppend, journalAppendWithReceipt, journalCompensateExecution, journalAppendOnce, journalCommitCancellation, backgroundAgentMemory, namedAgentMemory, listNamedAgentIds, listBackgroundAgentIds, durableRunMemory, migrateLegacyDurableRunMemory, forgetDurableThread } from "../extension/lib/memory.js";
import { createDurableRunRegistry } from "../extension/lib/durable-runs.js";
import { createThread, deleteThread } from "../extension/lib/threads.js";

// ---- minimal in-memory OPFS fake ----
// A directory tree: { kind, children: Map<name, node>, content?: string }
function dirNode() {
  return { kind: "directory", children: new Map() };
}
function fileNode(content) {
  return { kind: "file", content };
}

class FakeWritable {
  constructor(node) {
    this.node = node;
    this.parts = [];
  }
  async write(s) {
    this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s));
  }
  async close() {
    this.node.content = this.parts.join("");
  }
}
class FakeFileHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "file";
  }
  async getFile() {
    const node = this.node;
    return {
      // Real OPFS reports the file's BYTE size; the fake must agree so the
      // usage ledger (UTF-8 bytes) and a walk of the fake agree too.
      size: new TextEncoder().encode(node.content ?? "").byteLength,
      async text() {
        return node.content ?? "";
      },
    };
  }
  async createWritable() {
    return new FakeWritable(this.node);
  }
}
class FakeDirHandle {
  constructor(node) {
    this.node = node;
  }
  get kind() {
    return "directory";
  }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new Error(`not found: ${name}`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name, opts = {}) {
    this.node.children.delete(name);
  }
  async *entries() {
    directoryReads++;
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}

// Every `entries()` enumeration on the fake — the unit the usage ledger must
// NOT spend per write (CAP-FB-20260830-OPFS-USAGE-WALK-01).
let directoryReads = 0;
const root = dirNode();
function installNavigator() {
  const fakeStorageManager = {
    async getDirectory() {
      return new FakeDirHandle(root);
    },
  };
  Object.defineProperty(globalThis, "navigator", {
    value: { storage: fakeStorageManager },
    configurable: true,
    writable: true,
  });
}
installNavigator();

Deno.test("saveScreenshot completes without deadlocking (round-19 CRITICAL)", async () => {
  const mem = masterMemory();
  const dataURL = "data:image/png;base64," + "A".repeat(16);
  const result = await saveScreenshot(mem, { url: "https://example.com/", dataURL });
  assert(result?.id, "saveScreenshot must return an id");

  const index = await listScreenshots();
  assert(index.some((s) => s.id === result.id), "index must contain the saved screenshot id");
});

Deno.test("saveScreenshot commits the index and evicts beyond MAX_SCREENSHOTS", async () => {
  const mem = masterMemory();
  const make = (i) => "data:image/png;base64," + "B".repeat(16) + i;
  for (let i = 0; i < 7; i++) {
    await saveScreenshot(mem, { url: `https://example.com/${i}`, dataURL: make(i) });
  }
  const index = await listScreenshots();
  assert(index.length <= 5, "the screenshot index must be bounded to MAX_SCREENSHOTS");
  assert(index.length === 5, "the oldest two must be evicted");
});

Deno.test("memory.has distinguishes a stored null from an absent key (round-22 null-compensation)", async () => {
  const mem = masterMemory();
  const key = "null-compensation-key";
  // Absent key: has() is false AND get() is null (they coincide only here).
  assertEquals(await mem.has(key), false, "absent key must report has=false");
  // Store a LEGITIMATE null value: has() is true while get() is still null.
  await mem.set(key, null);
  assertEquals(await mem.has(key), true, "a stored null must report has=true");
  assertEquals(await mem.get(key), null, "get() returns null for a stored null");
  // The round-22 bug: `existed = prev !== undefined && prev !== null` classified
  // this stored null as absent and DELETED it on compensation. `has` keeps the
  // two cases distinct so compensation restores null rather than deleting the key.
  await mem.delete(key);
  assertEquals(await mem.has(key), false, "deleted key must report has=false");
});

Deno.test("journalAppendOnce commits exactly one terminal row per immutable executionId", async () => {
  const mem = masterMemory();
  await mem.delete("journal");
  await journalAppendOnce(mem, { type: "result", executionId: "exec-journal-001", result: "first" });
  await journalAppendOnce(mem, { type: "result", executionId: "exec-journal-001", result: "duplicate" });
  const rows = await mem.get("journal");
  assertEquals(rows.filter((row) => row.executionId === "exec-journal-001").length, 1);
  assertEquals(rows[0].result, "first");
});

Deno.test("journalCommitCancellation replaces a partial result with one cancellation row", async () => {
  const mem = masterMemory();
  await mem.delete("journal");
  await journalAppendOnce(mem, { type: "result", executionId: "exec-cancel-001", result: "partial" });
  await journalCommitCancellation(mem, { result: "Run cancelled by owner" }, "exec-cancel-001");
  await journalCommitCancellation(mem, { result: "Run cancelled by owner" }, "exec-cancel-001");
  const rows = await mem.get("journal");
  assertEquals(rows.filter((row) => row.executionId === "exec-cancel-001").length, 1);
  assertEquals(rows[0].type, "cancelled");
  assertEquals(rows[0].cancelled, true);
});

Deno.test("journalAppend compensation restores the EXACT pre-append state at the 500-entry cap (round-23)", async () => {
  const mem = masterMemory();
  // Seed a FULL 500-entry journal so the append would evict old-0 via the ring cap.
  const seed = Array.from({ length: 500 }, (_, i) => ({ ts: i, result: `old-${i}` }));
  await mem.setTrusted("journal", seed);

  let calls = 0;
  const guard = async () => {
    calls++;
    // First call (pre-commit) succeeds; second call (post-commit) throws so
    // compensation is exercised.
    if (calls >= 2) throw new Error("ownership lost during commit");
  };
  let threw = false;
  try {
    await journalAppend(mem, { result: "new-entry" }, guard);
  } catch {
    threw = true;
  }
  assert(threw, "journalAppend must rethrow the post-commit guard failure");
  const after = (await mem.get("journal")) ?? [];
  assertEquals(after.length, 500, "compensation must restore the full 500-entry pre-state (not 499)");
  assertEquals(after[0]?.result, "old-0", "old-0 must be restored — not lost to ring-buffer eviction (the round-23 blocker)");
  assert(!after.some((e) => e?.result === "new-entry"), "the appended row must be removed by compensation");
});

Deno.test("journalAppend does NOT restore old-enrollment data on a genMismatch compensation (round-26)", async () => {
  const mem = masterMemory();
  // Seed the OLD enrollment's journal (what journalAppend reads as `original`).
  await mem.setTrusted("journal", [{ ts: 1, result: "old-enrollment-secret" }]);

  let calls = 0;
  const guard = async () => {
    calls++;
    if (calls >= 2) {
      throw Object.assign(new Error("re-enrolled"), { genMismatch: true });
    }
  };
  let threw = false;
  try {
    await journalAppend(mem, { result: "new-entry" }, guard);
  } catch {
    threw = true;
  }
  assert(threw, "journalAppend must rethrow the gen-mismatch guard failure");
  const after = (await mem.get("journal")) ?? [];
  assert(
    !after.some((e) => e?.result === "old-enrollment-secret"),
    "the OLD enrollment's journal must NOT be restored into the new store (round-26)",
  );
  assert(
    !after.some((e) => e?.result === "new-entry"),
    "the stale appended row must be removed, not retained (round-26)",
  );
});

Deno.test("compareAndDelete/compareAndRestore are VERSION-scoped (round-27)", async () => {
  const mem = masterMemory();
  // `set` returns the durable version token for the write it made.
  const v1 = await mem.set("cas-key", "a");
  assert(typeof v1 === "number" && v1 > 0, "set must return a positive version token");
  // CAS delete on a VERSION mismatch must NOT fire (even though the value matches).
  assertEquals(await mem.compareAndDelete("cas-key", v1 + 999), false, "CAS delete must not fire on a version mismatch");
  assertEquals(await mem.get("cas-key"), "a", "the value must survive a version-mismatched CAS delete");
  // CAS delete on the matching VERSION deletes.
  assert((await mem.compareAndDelete("cas-key", v1)) !== false, "CAS delete must fire on the matching version");
  assertEquals(await mem.get("cas-key"), null, "the value must be deleted");
  // CAS restore on a version mismatch must NOT write.
  const v2 = await mem.set("cas-key", "x");
  assertEquals(await mem.compareAndRestore("cas-key", v2 + 1, "z"), false, "CAS restore must not fire on a version mismatch");
  assertEquals(await mem.get("cas-key"), "x", "the value must survive a version-mismatched CAS restore");
  // CAS restore on the matching version writes (bumping the version).
  assert((await mem.compareAndRestore("cas-key", v2, "z")) !== false, "CAS restore must fire on the matching version (returns the token)");
  assertEquals(await mem.get("cas-key"), "z", "the value must be restored");
  await mem.delete("cas-key");
});

Deno.test("identical-value ABA is detected by the version token (round-27 blocker)", async () => {
  const mem = masterMemory();
  // A stale run writes value "same" (version N), then a NEW enrollment writes the
  // IDENTICAL value "same" (version N+1). A value-equality CAS would delete the
  // legitimate new write; a VERSION-scoped CAS must NOT.
  const staleVersion = await mem.set("aba-key", "same"); // stale run's write
  const freshVersion = await mem.set("aba-key", "same"); // new enrollment, same value
  assert(freshVersion > staleVersion, "each write must bump the version (never reused)");
  // The stale run's compensation holds the OLD version — it must NOT delete the
  // new enrollment's identical-value write.
  assertEquals(
    await mem.compareAndDelete("aba-key", staleVersion),
    false,
    "an identical-value ABA must be detected: the stale version must not match",
  );
  assertEquals(await mem.get("aba-key"), "same", "the legitimate new write must survive");
  // The FRESH version IS the current one — it deletes (sanity).
  assert((await mem.compareAndDelete("aba-key", freshVersion)) !== false, "the fresh version must match and delete");
  assertEquals(await mem.get("aba-key"), null, "the key must be gone after the fresh-version delete");
});

Deno.test("compareAndSet does NOT recreate a directory on a mismatched CAS (round-27 cleanup-recreation)", async () => {
  const mem = masterMemory();
  // No store directory was created for a never-written key: a CAS against an
  // absent key/dir must return false WITHOUT recreating anything.
  assertEquals(
    await mem.compareAndDelete("never-written-key", 1),
    false,
    "a CAS against an absent store must fail closed without recreating a directory",
  );
  assertEquals(await mem.has("never-written-key"), false, "no key must materialize");
});

Deno.test("thread and durable-run authority keys are reserved from the model's memory_set", async () => {
  const mem = masterMemory();
  // The model's `set` (not trusted) must reject the thread index AND any
  // `thread:<id>` body — the wider-goal review forged a `threads` index through
  // `masterMemory().set` and `listThreads()` returned it.
  await assertRejects(
    () => mem.set("threads", [{ id: "t_forged", name: "forged" }]),
    /reserved/,
    "a forged threads index must be rejected",
  );
  await assertRejects(
    () => mem.set("thread:t_forged", { id: "t_forged", messages: [] }),
    /reserved/,
    "a forged thread body must be rejected",
  );
  for (const key of ["run-registry", "run:exec_forged", "run-outbox:exec_forged", "run-log:exec_forged:row", "run-resume:exec_forged:manifest", "run-payload:exec_forged:manifest", "wasmPkg", "wasmPkgRepair", "__wasmTx"]) {
    await assertRejects(
      () => mem.set(key, { phase: "terminal" }),
      /reserved/,
      `a forged ${key} authority value must be rejected`,
    );
  }
  // Internal TRUSTED writes still work (the thread module uses setTrusted).
  const version = await mem.setTrusted("threads", [{ id: "t_ok", name: "ok" }]);
  assert(typeof version === "number" && version > 0, "trusted write must return a version");
  assertEquals((await mem.get("threads"))[0].id, "t_ok");
});

Deno.test("backgroundAgentMemory + namedAgentMemory are isolated from masterMemory (all agents get their own OPFS)", async () => {
  const master = masterMemory();
  const bg = backgroundAgentMemory("recipe:auto-group-by-domain");
  const bg2 = backgroundAgentMemory("recipe:dedupe-tabs");
  const named = namedAgentMemory("my-pr-reviewer");

  // Each tier is a distinct store: a write to one must never surface in another.
  await master.set("k", "master-value");
  await bg.set("k", "sorting-hat-value");
  await bg2.set("k", "dedupe-value");
  await named.set("k", "named-value");

  assertEquals(await master.get("k"), "master-value", "master keeps its own value");
  assertEquals(await bg.get("k"), "sorting-hat-value", "the background agent keeps its own value");
  assertEquals(await bg2.get("k"), "dedupe-value", "a second background agent is isolated from the first");
  assertEquals(await named.get("k"), "named-value", "a named agent is isolated from the background agents + master");

  // A background agent's writes must NOT leak into the master journal (the
  // scheduled-run isolation Paul asked for: one background agent can never
  // read/write the master's or another's state).
  assertEquals((await master.keys()).includes("k"), true);
  assertEquals((await master.get("k")) === "sorting-hat-value", false, "the background write must not reach the master");
});

// The activity-log explorer needs to enumerate the named-agent + background-agent
// sandboxes (listNamedAgentIds / listBackgroundAgentIds) so the SW's
// `activity.list` can aggregate their journals. Writes create the directories;
// the lister then enumerates only REAL directories (never forges a worker from a
// stale dir — but does surface one that actually has data).
Deno.test("journal quota receipt restores absent vs empty and is idempotent", async () => {
  const mem = masterMemory();
  await mem.delete("journal");
  const absent = await journalAppendWithReceipt(mem, { type: "task", executionId: "exec_receipt_absent", task: "x" });
  assertEquals(absent.preState.exists, false);
  assertEquals(absent.executionId, "exec_receipt_absent");
  assertEquals((await journalCompensateExecution(mem, absent)).ok, true);
  assertEquals(await mem.has("journal"), false);
  assertEquals((await journalCompensateExecution(mem, absent)).idempotent, true);

  await mem.setTrusted("journal", []);
  const empty = await journalAppendWithReceipt(mem, { type: "task", executionId: "exec_receipt_empty", task: "x" });
  assertEquals(empty.preState.exists, true);
  assertEquals(empty.preState.value, []);
  assertEquals((await journalCompensateExecution(mem, empty)).ok, true);
  assertEquals(await mem.has("journal"), true);
  assertEquals(await mem.get("journal"), []);
});

Deno.test("journal quota compensation removes task/prompt rows and preserves foreign append + ring eviction", async () => {
  const mem = masterMemory();
  const seed = Array.from({ length: 500 }, (_, i) => ({ ts: i, type: "history", id: `old-${i}` }));
  await mem.setTrusted("journal", seed);
  const receipt = await journalAppendWithReceipt(mem, { type: "task", executionId: "exec_receipt_rows", task: "x" });
  await journalAppend(mem, { type: "prompt-attestation", executionId: "exec_receipt_rows", receipt: "opaque" });
  await journalAppend(mem, { type: "progress", executionId: "exec_receipt_rows", phase: "starting" });
  await journalAppend(mem, { type: "foreign", executionId: "exec_foreign_later", value: 7 });
  const result = await journalCompensateExecution(mem, receipt);
  assertEquals(result.ok, true);
  const rows = await mem.get("journal");
  assertEquals(rows.some((row) => row.executionId === "exec_receipt_rows"), false);
  assertEquals(rows.at(-1).executionId, "exec_foreign_later");
  assertEquals(rows.length, 500);
  assertEquals(rows[0].id, "old-1", "target eviction is restored; only the foreign append evicts old-0");
});

Deno.test("journal quota compensation fails closed on ABA and generation mismatch", async () => {
  const mem = masterMemory();
  await mem.setTrusted("journal", [{ type: "history", id: "keep" }]);
  const receipt = await journalAppendWithReceipt(mem, { type: "task", executionId: "exec_receipt_aba", task: "x" });
  await mem.setTrusted("journal", receipt.postState); // identical-value ABA, newer token
  const aba = await journalCompensateExecution(mem, receipt);
  assertEquals(aba.reason, "journal_version_mismatch");
  assertEquals((await mem.get("journal")).some((row) => row.executionId === receipt.executionId), true);

  const fenced = await journalAppendWithReceipt(mem, { type: "task", executionId: "exec_receipt_generation", task: "x" });
  const generation = await journalCompensateExecution(mem, fenced, async () => {
    throw Object.assign(new Error("re-enrolled"), { genMismatch: true });
  });
  assertEquals(generation.reason, "generation_mismatch");
  assertEquals((await mem.get("journal")).some((row) => row.executionId === fenced.executionId), true);
});

Deno.test("global generation bootstraps above legacy envelope and sidecar tokens", async () => {
  const memoryRoot = root.children.get("memory") ?? dirNode();
  root.children.set("memory", memoryRoot);
  const agents = memoryRoot.children.get("agents") ?? dirNode();
  memoryRoot.children.set("agents", agents);
  const legacy = dirNode();
  legacy.children.set("old.json", fileNode(JSON.stringify({ __v: 42, __value: "old" })));
  legacy.children.set(".old.version", fileNode(JSON.stringify(47)));
  agents.children.set("legacy-generation", legacy);

  const issued = await namedAgentMemory("legacy-generation").setTrusted("next", "value");
  assert(issued > 47, "the first global token must exceed every legacy authority token");
});

Deno.test("deleted key versions remain monotonic across absent ABA", async () => {
  const mem = masterMemory();
  const first = await mem.setTrusted("aba-delete", { same: true });
  assert((await mem.compareAndDelete("aba-delete", first)) !== false);
  const absentVersion = await mem.getVersion("aba-delete");
  assert(absentVersion > first);
  const recreated = await mem.setTrusted("aba-delete", { same: true });
  assert(recreated > absentVersion);
  assertEquals(await mem.compareAndDelete("aba-delete", first), false, "stale pre-delete token cannot delete recreation");
});

Deno.test("listNamedAgentIds + listBackgroundAgentIds enumerate the per-agent sandboxes", async () => {
  await journalAppend(namedAgentMemory("paul"), { type: "task", id: "t1", task: "hello" });
  await journalAppend(namedAgentMemory("reader"), { type: "result", id: "t2", result: "ok" });
  await journalAppend(backgroundAgentMemory("recipe:auto-group-by-domain"), { type: "tool-result", id: "t3", tool: "tab_group", result: "{}" });
  const named = await listNamedAgentIds();
  const background = await listBackgroundAgentIds();
  assertEquals(named.includes("paul"), true, "named agent paul sandbox must be listed");
  assertEquals(named.includes("reader"), true, "named agent reader sandbox must be listed");
  // backgroundAgentMemory slugifies the id (recipe:auto-group-by-domain →
  // recipe-auto-group-by-domain), and listBackgroundAgentIds returns that slug.
  assertEquals(background.includes("recipe-auto-group-by-domain"), true, "background agent sandbox must be listed (by slug)");
  // The named + background stores are ISOLATED (a named store never collides
  // with a background store, and neither with the master).
  assertEquals((await namedAgentMemory("paul").get("journal")).length > 0, true);
});

Deno.test("durable authority migrates out of master store without eviction and new runs complete with >500 keys", async () => {
  // Isolate this capacity fixture from the earlier memory tests.
  root.children.clear();
  const master = masterMemory();
  for (const [key, value] of [["owner-a", 1], ["owner-b", 2], ["owner-c", 3], ["owner-d", 4]]) {
    await master.set(key, value);
  }
  const ids = Array.from({ length: 99 }, (_, i) =>
    `exec:00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`
  );
  await master.setTrusted("run-registry", ids);
  for (const id of ids) {
    await master.setTrusted(`run:${id}`, { executionId: id, phase: "terminal", revision: 1 });
    await master.setTrusted(`run-log:${id}:task`, { executionId: id, type: "task" });
    await master.setTrusted(`run-log:${id}:terminal`, { executionId: id, type: "result" });
    await master.setTrusted(`run-payload:${id}:body:000000`, { executionId: id, data: "retained" });
    await master.setTrusted(`run-payload:${id}:body:manifest`, { executionId: id, chunkCount: 1 });
  }
  assertEquals((await master.keys()).length, 500, "owner + legacy authority initially fill 500 keys in master");

  const migration = await migrateLegacyDurableRunMemory();
  assertEquals(migration.migrated, 496);
  assertEquals(await master.keys(), ["owner-a", "owner-b", "owner-c", "owner-d"], "only durable authority moved");
  assertEquals(await master.get("owner-c"), 3, "owner value preserved exactly");

  // >500 tiny owner keys succeed without key count limitation (up to byte quota)
  for (let i = 0; i < 550; i += 1) {
    await master.set(`owner-tiny-${i}`, i);
  }
  assertEquals(await master.get("owner-tiny-549"), 549, ">500 tiny owner keys succeed");

  const durable = durableRunMemory();
  assertEquals(await durable.get("run-registry"), ids, "every retained run stays indexed");
  for (const id of ids) {
    assertEquals((await durable.get(`run:${id}`))?.executionId, id);
    assertEquals((await durable.get(`run-log:${id}:terminal`))?.type, "result");
  }
  const again = await migrateLegacyDurableRunMemory();
  assertEquals(again.migrated, 0, "restart migration is idempotent");

  const registry = createDurableRunRegistry({
    store: durable,
    logHandleFor: (durable.__logHandles ??= createMemoryRunLogHandles()),
    bootId: "boot-isolated",
    now: (() => { let n = 10_000; return () => ++n; })(),
    resolveJournalStore: async () => ({}),
    appendJournal: async () => {},
    replaceCancellationJournal: async () => {},
    commitThread: async () => {},
    replaceCancellationThread: async () => {},
  });
  const freshId = "exec:00000000-0000-4000-8000-999999999999";
  const started = await registry.start({
    executionId: freshId,
    kind: "scheduled",
    scheduleName: "recipe:dedupe-tabs",
    taskPreview: "dedupe tabs",
    journalTarget: "background:recipe:dedupe-tabs",
    resumeRequest: { id: "recipe:dedupe-tabs", task: "dedupe tabs" },
  });
  assertEquals(started.phase, "running");
  const terminal = await registry.settle(freshId, { ok: true, result: "done", logicalId: "recipe:dedupe-tabs" });
  assertEquals(terminal.phase, "terminal", "new scheduled execution reaches terminal authority");
  assertEquals((await master.keys()).some((key) => key.startsWith("run:")), false, "new runs consume zero master keys");
});

Deno.test("stores allow >500 tiny keys per execution until byte limits and keep byte limits unchanged", async () => {
  root.children.clear();
  const durable = durableRunMemory();
  const id = "exec:11111111-1111-4111-8111-111111111111";
  for (let i = 0; i < 550; i += 1) {
    await durable.setTrusted(`run-log:${id}:${String(i).padStart(6, "0")}`, { i });
  }
  const read549 = await durable.get(`run-log:${id}:000549`);
  assertEquals(read549?.i, 549, ">500 keys per execution succeed without key count limitation");

  const source = await Deno.readTextFile(new URL("../extension/lib/memory.js", import.meta.url));
  assert(source.includes("const MAX_VALUE_BYTES = 256 * 1024"));
  assert(!source.includes("const MAX_KEYS_PER_ORIGIN"));
  assert(source.includes("const MAX_BYTES_PER_ORIGIN = 8 * 1024 * 1024"));
  assert(source.includes("const MAX_BYTES_GLOBAL = 64 * 1024 * 1024"));
});

Deno.test("durable store routes the thread-runs reverse index instead of throwing", async () => {
  // Regression for the 0.2.257 log redesign: it introduced a `thread-runs:<threadId>`
  // key, but the durable key router only understood `run-registry` and the five
  // `run*:<executionId>` prefixes. Every run links its thread on the way in, so
  // durableStoreForKey threw `invalid durable-run key: thread-runs:<id>` and
  // agent.run failed outright — the demo journeys caught it as five dead checks.
  root.children.clear();
  const durable = durableRunMemory();
  const threadId = "t_1787665465268_mb0aqdzj";
  const key = `thread-runs:${threadId}`;
  const ids = ["exec:00000000-0000-4000-8000-000000000001"];

  await durable.setTrusted(key, ids);
  assertEquals(await durable.get(key), ids, "the reverse index must round-trip");
  assertEquals(await durable.has(key), true);
  assert((await durable.keys()).includes(key), "keys() must surface thread-runs entries");

  // Two threads must not share a store — one thread's index cannot leak into another.
  const otherKey = "thread-runs:t_1787665465269_zzzzzzzz";
  await durable.setTrusted(otherKey, ["exec:00000000-0000-4000-8000-000000000002"]);
  assertEquals(await durable.get(key), ids, "a second thread must not overwrite the first");

  // The execution namespace still routes as before.
  await durable.setTrusted("run-registry", ids);
  assertEquals(await durable.get("run-registry"), ids);

  // Fail closed on a thread id outside the bounded safe charset rather than
  // letting it reach a directory name. `..` matters most: encodeURIComponent
  // does NOT escape dots, so a charset permitting them would hand ".." straight
  // to a directory name and rely on OPFS refusing it.
  await assertRejects(() => durable.setTrusted("thread-runs:../escape", ["x"]));
  await assertRejects(() => durable.setTrusted("thread-runs:..", ["x"]));
  await assertRejects(() => durable.setTrusted("thread-runs:.", ["x"]));
  await assertRejects(() => durable.setTrusted("thread-runs:", ["x"]));
  await assertRejects(() => durable.setTrusted(`thread-runs:${"a".repeat(201)}`, ["x"]));
});

Deno.test("deleting a thread reclaims its durable reverse index", async () => {
  // Without this the durable/threads/<id> directory outlives every deleted
  // thread — one leaked directory per delete, which the memory-resilience
  // constraint forbids.
  root.children.clear();
  const durable = durableRunMemory();
  const created = await createThread("leak check");
  const threadId = created?.id ?? created;
  assertEquals(typeof threadId, "string");
  await durable.setTrusted(`thread-runs:${threadId}`, ["exec:00000000-0000-4000-8000-000000000009"]);
  assert((await durable.keys()).includes(`thread-runs:${threadId}`));

  assertEquals(await deleteThread(threadId), true);
  assertEquals(
    (await durable.keys()).includes(`thread-runs:${threadId}`),
    false,
    "the durable reverse index must not survive the thread",
  );
  // Cleanup is idempotent and never throws on an absent thread. The return
  // value is deliberately NOT asserted here: real OPFS raises NotFoundError for
  // a missing entry while the fake silently no-ops, and the contract that
  // matters on a cleanup path is "does not throw".
  await forgetDurableThread(threadId);
  await forgetDurableThread("t_does_not_exist");
  // A malformed id is refused before it can reach a directory name.
  assertEquals(await forgetDurableThread("../escape"), false);
  assertEquals(await forgetDurableThread(".."), false);
  assertEquals(await forgetDurableThread(""), false);
});

// ---- CAP-FB-20260830-OPFS-USAGE-WALK-01: incremental usage accounting ----
// A memory write used to enumerate the store directory AND walk the whole
// memory tree (getFile() on every .json) to enforce the quotas — O(files) per
// write, O(runs^2) over a session. The ledger replaces the walk; these tests
// pin (a) the ledger agrees with a real walk after writes/deletes/tombstones,
// (b) a write costs ZERO directory enumerations once the ledger is seeded, and
// (c) the quota rejection fires at exactly the same write with the same error.

async function walkBytes(dirNode_) {
  // An independent walk of the FAKE tree (not memory.js's walker): every .json
  // file, recursively, in UTF-8 bytes — the same unit the old globalUsage used.
  let bytes = 0;
  for (const [name, node] of dirNode_.children) {
    if (node.kind === "file") { if (name.endsWith(".json")) bytes += new TextEncoder().encode(node.content ?? "").byteLength; }
    else bytes += await walkBytes(node);
  }
  return bytes;
}
function storeNode(segments) {
  let node = root;
  for (const seg of segments) node = node.children.get(seg);
  return node;
}
function storeWalkBytes(segments) {
  const node = storeNode(segments);
  let bytes = 0;
  for (const [name, n] of node.children) {
    if (n.kind === "file" && name.endsWith(".json") && !/^(?:__gen\.json|__tombs\.json|__epoch\.json)$/.test(name)) {
      bytes += new TextEncoder().encode(n.content ?? "").byteLength;
    }
  }
  return bytes;
}

Deno.test("usage ledger matches a full walk after N writes and M deletes (OPFS-USAGE-WALK-01)", async () => {
  root.children.clear();
  usageLedgerInspector.reset();
  const stores = [
    { mem: masterMemory(), path: ["memory", "master"] },
    { mem: siteMemory("https://ledger-a.example"), path: ["memory", "origins", encodeURIComponent("https://ledger-a.example")] },
    { mem: namedAgentMemory("ledger-agent"), path: ["memory", "agents", "ledger-agent"] },
  ];
  // 50 writes across the 3 stores (varying sizes, including non-ASCII).
  const versions = new Map();
  for (let i = 0; i < 50; i++) {
    const s = stores[i % 3];
    const v = await s.mem.set(`k${i}`, { i, pad: "é".repeat(i * 7) });
    versions.set(i, v);
  }
  // 10 plain deletes (tombstone + file removal), 5 version-scoped CAS deletes.
  for (let i = 0; i < 10; i++) await stores[i % 3].mem.delete(`k${i}`);
  for (let i = 10; i < 15; i++) {
    assert((await stores[i % 3].mem.compareAndDelete(`k${i}`, versions.get(i))) !== false, "CAS delete must fire");
  }
  // A few overwrites that shrink and grow existing keys.
  await stores[0].mem.set("k15", 1);
  await stores[1].mem.set("k16", { big: "x".repeat(5000) });
  for (const s of stores) {
    assertEquals(usageLedgerInspector.storeBytes(s.path), storeWalkBytes(s.path), `ledger must equal a walk of ${s.path.join("/")}`);
    assertEquals(usageLedgerInspector.storeBytes(s.path), await usageLedgerInspector.walkStore(s.path), "memory.js's own walker must agree too");
  }
  assertEquals(usageLedgerInspector.globalBytes(), await walkBytes(root.children.get("memory")), "global ledger must equal a walk of the memory tree");
  assertEquals(usageLedgerInspector.globalBytes(), await usageLedgerInspector.walkGlobal(), "memory.js's own global walker must agree too");
  // clear() removes every value: the ledger follows.
  await stores[2].mem.clear();
  assertEquals(usageLedgerInspector.storeBytes(stores[2].path), storeWalkBytes(stores[2].path), "ledger must follow clear()");
  assertEquals(usageLedgerInspector.globalBytes(), await walkBytes(root.children.get("memory")), "global ledger must follow clear()");
});

Deno.test("a memory write performs zero directory enumerations once the ledger is seeded (OPFS-USAGE-WALK-01)", async () => {
  root.children.clear();
  usageLedgerInspector.reset();
  const mem = masterMemory();
  await mem.set("warm", 1); // seeds the ledger (one walk per SW lifetime)
  const before = directoryReads;
  for (let i = 0; i < 20; i++) await mem.set(`w${i}`, { i });
  await mem.delete("w3");
  assertEquals(directoryReads - before, 0, "writes must not enumerate directories (the per-write tree walk is gone)");
});

Deno.test("the per-origin quota rejects at exactly the same write with the same error (OPFS-USAGE-WALK-01)", async () => {
  root.children.clear();
  usageLedgerInspector.reset();
  const mem = siteMemory("https://quota.example");
  const path = ["memory", "origins", encodeURIComponent("https://quota.example")];
  const LIMIT = 8 * 1024 * 1024;
  // Fill the store to LIMIT - 100 bytes of value files using 200 KiB values.
  const chunk = 200 * 1024;
  const envelopeOverhead = (i) => JSON.stringify({ __v: 0, __value: "" }).length + String(i).length; // approximate
  let filled = 0;
  let i = 0;
  while (filled + chunk + 64 < LIMIT - 100) {
    await mem.setTrusted(`f${i}`, "x".repeat(chunk));
    filled = storeWalkBytes(path);
    i++;
  }
  // Top up with a value that lands the store EXACTLY at LIMIT - 100.
  const room = LIMIT - 100 - filled;
  const probeKey = "top";
  const envelopeBytes = (await mem.setTrusted(probeKey, "")) && storeWalkBytes(path) - filled; // bytes of an empty-string envelope
  await mem.setTrusted(probeKey, "y".repeat(room - envelopeBytes));
  assertEquals(storeWalkBytes(path), LIMIT - 100, "fixture: the store sits at LIMIT - 100 bytes");
  assertEquals(usageLedgerInspector.storeBytes(path), LIMIT - 100, "the ledger sees LIMIT - 100 too");
  void envelopeOverhead;
  // A 200-byte write must be rejected with the unchanged quota error...
  await assertRejects(
    () => mem.set("over", "z".repeat(200)),
    MemoryStoreQuotaError,
    `store exceeds the ${LIMIT}-byte bound`,
  );
  // ...and a write that fits still lands (the ledger did not drift upward on the rejection).
  await mem.set("fits", "");
  assert(storeWalkBytes(path) <= LIMIT, "the store never exceeds the bound");
  assertEquals(usageLedgerInspector.storeBytes(path), storeWalkBytes(path), "ledger still equals the walk after a rejection");
});
