// Unit test for the round-19 CRITICAL blocker: saveScreenshot re-acquired the
// non-reentrant global write mutex (withWriteLock → setTrusted → setValue →
// withWriteLock) and DEADLOCKED. This test drives saveScreenshot against a
// minimal in-memory OPFS fake and asserts it (a) completes (no deadlock), (b)
// writes the blob + commits the metadata index, and (c) charges the global quota.
// @ts-nocheck — the OPFS fake is intentionally dynamic (no FileSystem types in Deno).

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createMemoryRunLogHandles } from "./fixtures/run-log-wal-memory.js";
import { stageMasterJournalCutover, stageMasterJournalFrame } from "../extension/lib/master-journal-wal.js";
import { withMasterJournalWebLock } from "../extension/lib/master-journal-lock.js";
import { masterMemory, siteMemory, MemoryStoreQuotaError, usageLedgerInspector, saveScreenshot, listScreenshots, journalAppend, journalAppendWithReceipt, journalCompensateExecution, journalAppendOnce, journalCommitCancellation, withStoreTransaction, backgroundAgentMemory, namedAgentMemory, listNamedAgentIds, listBackgroundAgentIds, durableRunMemory, migrateLegacyDurableRunMemory, forgetDurableThread } from "../extension/lib/memory.js";
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

// Count bytes ACTUALLY submitted to the journal value writer, not calls to
// setTrusted or the final file size. A 300-row whole-value rewrite is quadratic
// even though journal.json ends at only ~300 rows; the WAL must remove this cost.
let journalValueBytesWritten = 0;
let generationWriteGate = null;
class FakeWritable {
  constructor(node, name = "") {
    this.node = node;
    this.name = name;
    this.parts = [];
  }
  async write(s) {
    if (this.name === "__gen.json" && generationWriteGate) await generationWriteGate();
    const text = typeof s === "string" ? s : new TextDecoder().decode(s);
    this.parts.push(text);
    if (this.name === "journal.json") journalValueBytesWritten += new TextEncoder().encode(text).byteLength;
  }
  async close() {
    this.node.content = this.parts.join("");
  }
}
class FakeFileHandle {
  constructor(node, name = "") {
    this.node = node;
    this.name = name;
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
      async arrayBuffer() {
        return new TextEncoder().encode(node.content ?? "").buffer;
      },
    };
  }
  async createWritable() {
    return new FakeWritable(this.node, this.name);
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
      if (!opts.create) throw new DOMException(`not found: ${name}`, "NotFoundError");
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts.create) throw new DOMException(`not found: ${name}`, "NotFoundError");
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name), name);
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

Deno.test("saveScreenshot commits the index and RETAINS beyond the removed MAX_SCREENSHOTS (dptw)", async () => {
  const mem = masterMemory();
  const before = (await listScreenshots()).length;
  const make = (i) => "data:image/png;base64," + "B".repeat(16) + i;
  for (let i = 0; i < 7; i++) {
    await saveScreenshot(mem, { url: `https://example.com/${i}`, dataURL: make(i) });
  }
  const index = await listScreenshots();
  assertEquals(index.length - before, 7, "dptw: no screenshot count eviction — all 7 retained");
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

Deno.test("master writes share the journal Web Lock; site stores keep their own lock", async () => {
  const previous = navigator.locks;
  const names = [];
  navigator.locks = {
    request: async (name, options, fn) => {
      names.push({ name, mode: options.mode });
      return await fn();
    },
  };
  try {
    await masterMemory().setTrusted("journal", []);
    await siteMemory("https://journal-lock.example").set("site-key", "site-value");
    assertEquals(names, [{ name: "cap:master-journal", mode: "exclusive" }]);
  } finally {
    if (previous === undefined) delete navigator.locks;
    else navigator.locks = previous;
  }
});

Deno.test("master journal append holds one non-reentrant cross-context lock across its transaction", async () => {
  const mem = masterMemory();
  await mem.setTrusted("journal", []);
  const previous = navigator.locks;
  const names = [];
  let held = false;
  navigator.locks = {
    request: async (name, options, fn) => {
      if (held) throw new Error("nested master journal Web Lock acquisition");
      names.push({ name, mode: options.mode });
      held = true;
      try { return await fn(); } finally { held = false; }
    },
  };
  try {
    await journalAppend(mem, { type: "result", executionId: "exec-single-lock" });
    assertEquals(names, [{ name: "cap:master-journal", mode: "exclusive" }]);
    assertEquals((await mem.get("journal")).at(-1).executionId, "exec-single-lock");
  } finally {
    if (previous === undefined) delete navigator.locks;
    else navigator.locks = previous;
  }
});

Deno.test("owner export cannot interleave a master append between its snapshot and commit", async () => {
  const mem = masterMemory();
  await mem.setTrusted("journal", []);
  const previous = navigator.locks;
  let last = Promise.resolve();
  navigator.locks = {
    request: (_name, _options, fn) => {
      const run = last.then(fn);
      last = run.then(() => {}, () => {});
      return run;
    },
  };
  let enterGuard;
  let releaseGuard;
  const inGuard = new Promise((resolve) => { enterGuard = resolve; });
  const proceed = new Promise((resolve) => { releaseGuard = resolve; });
  try {
    let calls = 0;
    const append = journalAppend(mem, { executionId: "exec-export-no-interleave" }, async () => {
      if (++calls === 1) { enterGuard(); await proceed; }
    });
    await inGuard;
    let exportEntered = false;
    const exportRead = withMasterJournalWebLock(async () => {
      exportEntered = true;
      return await mem.get("journal");
    });
    // Advance the promise queue without timing assumptions: an unrelated
    // microtask cannot make a queued Web Lock enter until append releases it.
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(exportEntered, false);
    releaseGuard();
    await append;
    const exported = await exportRead;
    assertEquals(exported.at(-1).executionId, "exec-export-no-interleave");
  } finally {
    releaseGuard();
    if (previous === undefined) delete navigator.locks;
    else navigator.locks = previous;
  }
});

Deno.test("master 500-row append plus failed guard compensates inside one non-reentrant lock", async () => {
  const mem = masterMemory();
  const seed = Array.from({ length: 500 }, (_, i) => ({ id: `single-lock-old-${i}` }));
  await mem.setTrusted("journal", seed);
  const previous = navigator.locks;
  const names = [];
  let held = false;
  navigator.locks = {
    request: async (name, options, fn) => {
      if (held) throw new Error("nested master journal Web Lock acquisition");
      names.push({ name, mode: options.mode });
      held = true;
      try { return await fn(); } finally { held = false; }
    },
  };
  try {
    let calls = 0;
    await assertRejects(() => journalAppend(mem, { executionId: "exec-single-lock-compensation" }, async () => {
      if (++calls > 1) throw new Error("ownership lost after commit");
    }), Error, "ownership lost after commit");
    assertEquals(names, [{ name: "cap:master-journal", mode: "exclusive" }]);
    assertEquals(await mem.get("journal"), seed, "the ring eviction must be compensated exactly");
  } finally {
    if (previous === undefined) delete navigator.locks;
    else navigator.locks = previous;
  }
});

Deno.test("failed pre-commit append does not retain an absent archive overflow", async () => {
  const mem = masterMemory();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await mem.setTrusted("journal", seed);
  await mem.delete("journal-archive");
  await assertRejects(() => journalAppend(mem, { executionId: "exec-failed-precommit" }, async () => {
    throw new Error("owner fence lost before commit");
  }), Error, "owner fence lost before commit");
  assertEquals(await mem.get("journal"), seed);
  assertEquals(await mem.has("journal-archive"), false);
});

Deno.test("failed post-commit append restores a present-empty archive as well as the live ring", async () => {
  const mem = masterMemory();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await mem.setTrusted("journal", seed);
  await mem.setTrusted("journal-archive", []);
  let calls = 0;
  await assertRejects(() => journalAppend(mem, { executionId: "exec-failed-postcommit" }, async () => {
    if (++calls === 2) throw new Error("owner fence lost after commit");
  }), Error, "owner fence lost after commit");
  assertEquals(await mem.get("journal"), seed);
  assertEquals(await mem.has("journal-archive"), true);
  assertEquals(await mem.get("journal-archive"), []);
});

Deno.test("re-enrollment compensation deletes only its archived write, never restores old archive secrets", async () => {
  const mem = masterMemory();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await mem.setTrusted("journal", seed);
  await mem.setTrusted("journal-archive", [{ text: "prior-enrollment-private" }]);
  let calls = 0;
  await assertRejects(() => journalAppend(mem, { executionId: "exec-reenrolled-overflow" }, async () => {
    if (++calls === 2) throw Object.assign(new Error("re-enrolled"), { genMismatch: true });
  }), Error, "re-enrolled");
  assertEquals(await mem.has("journal"), false);
  assertEquals(await mem.has("journal-archive"), false);
});

Deno.test("an escaped transaction facade cannot write after its master lock is released", async () => {
  const mem = masterMemory();
  let escaped;
  await withStoreTransaction(mem, async (tx) => { escaped = tx; });
  await assertRejects(async () => await escaped.setTrusted("journal", [{ id: "unlocked-write" }]), Error, "expired");
  assertEquals(((await mem.get("journal")) ?? []).some((row) => row.id === "unlocked-write"), false);
});

Deno.test("master cancellation with archived overflow holds one cross-context lock", async () => {
  const mem = masterMemory();
  const seed = Array.from({ length: 500 }, (_, id) => ({ id }));
  await mem.setTrusted("journal", seed);
  const previous = navigator.locks;
  const names = [];
  let held = false;
  navigator.locks = {
    request: async (name, options, fn) => {
      if (held) throw new Error("nested master journal Web Lock acquisition");
      names.push({ name, mode: options.mode });
      held = true;
      try { return await fn(); } finally { held = false; }
    },
  };
  try {
    const rows = await journalCommitCancellation(mem, { result: "stopped" }, "exec-single-lock-cancel");
    assertEquals(names, [{ name: "cap:master-journal", mode: "exclusive" }]);
    assertEquals(rows.length, 500);
    assertEquals(rows.at(-1).type, "cancelled");
    assertEquals((await mem.get("journal-archive")).at(-1).id, 0);
  } finally {
    if (previous === undefined) delete navigator.locks;
    else navigator.locks = previous;
  }
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

Deno.test("9epn.10: measure 300 master-journal appends and pin zero keys() walks", async () => {
  const raw = masterMemory();
  await raw.delete("journal");
  let keysCalls = 0;
  const store = new Proxy(raw, {
    get(target, key) {
      if (key === "keys") return async () => { keysCalls++; return await target.keys(); };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const encoder = new TextEncoder();
  let rowBytes = 0;
  let at100 = 0;
  let at200 = 0;
  journalValueBytesWritten = 0;
  for (let i = 0; i < 300; i++) {
    const entry = { type: "result", executionId: `exec_journal_scale_${i}`, result: "x".repeat(64) };
    rowBytes += encoder.encode(JSON.stringify({ ts: Date.now(), ...entry })).byteLength;
    await journalAppend(store, entry);
    if (i === 99) at100 = journalValueBytesWritten;
    if (i === 199) at200 = journalValueBytesWritten;
  }
  const total = journalValueBytesWritten;
  const second100 = at200 - at100;
  const third100 = total - at200;
  assertEquals(keysCalls, 0, "zero store.keys() calls is already true on main; keep it pinned, not claimed as a RED");
  assertEquals((await raw.get("journal")).length, 300, "all measured appends remain readable");
  console.log(`9epn.10 journal.json bytes: first100=${at100} second100=${second100} third100=${third100} total=${total} rowBytes=${rowBytes}`);

  // This bead lands a GREEN baseline characterization plus an executable RED
  // for the dedicated WAL workstream. Opt in to the future budget on the SAME
  // unmodified tree: it MUST fail until WAL/compaction replaces whole rewrites.
  // jw7wf will make the bounded budget unconditional after its reader/receipt/
  // backup cutover is safe; do not turn an expected baseline RED into a gate RED.
  if (Deno.env.get("CAP_JOURNAL_WAL_EXPECT_BOUNDED") === "1") {
    assert(total <= 4 * rowBytes,
      `WAL byte budget exceeded: journal.json wrote ${total} bytes for ${rowBytes} row bytes`);
  } else {
    assert(total > 8 * rowBytes, "baseline must expose whole-value rewrite amplification");
    assert(second100 > 2 * at100, "the second hundred writes ~3x the first hundred on main");
    assert(third100 > 1.4 * second100, "the third hundred must still grow with row count");
  }
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

Deno.test("master journal readers use a checked cutover rather than stale legacy values", async () => {
  const mem = masterMemory();
  const legacyVersion = await mem.setTrusted("journal", [{ id: "stale-legacy" }]);
  const storage = new FakeDirHandle(root);
  const memory = await storage.getDirectoryHandle("memory", { create: true });
  const master = await memory.getDirectoryHandle("master", { create: true });
  try {
    await stageMasterJournalCutover(master, {
      journalExists: true, journal: [{ id: "checked-wal" }], archive: [{ id: "archived" }],
      allocateVersion: async () => legacyVersion + 1,
    });
    assertEquals(await mem.get("journal"), [{ id: "checked-wal" }]);
    assertEquals(await mem.getStrict("journal"), [{ id: "checked-wal" }]);
    assertEquals(await mem.has("journal"), true);
    assertEquals(await mem.getVersion("journal"), legacyVersion + 1);
    assertEquals(await mem.snapshot("journal"), {
      exists: true, value: [{ id: "checked-wal" }], version: legacyVersion + 1,
    });
    assertEquals(await mem.getStrict("journal-archive"), [{ id: "archived" }]);
    assertEquals((await mem.keys()).includes("journal"), true);
    await assertRejects(() => mem.setTrusted("journal", [{ id: "must-not-shadow-wal" }]), Error, "WAL");
    await assertRejects(() => mem.set("journal", [{ id: "untrusted-shadow" }]), Error, "WAL");
    await assertRejects(() => mem.setTrusted("journal-archive", []), Error, "WAL");
    await assertRejects(() => mem.compareAndRestore("journal", legacyVersion + 1, []), Error, "WAL");
    await assertRejects(() => mem.compareAndDelete("journal", legacyVersion + 1), Error, "WAL");
    await assertRejects(() => mem.delete("journal"), Error, "WAL");
    await assertRejects(() => mem.clear(), Error, "WAL");
    const head = await (await master.getDirectoryHandle("journal-wal")).getFileHandle("head-a.json");
    const published = head.node.content;
    head.node.content = "{\"torn\":";
    try {
      for (const read of [() => mem.get("journal"), () => mem.getStrict("journal"),
        () => mem.has("journal"), () => mem.snapshot("journal"),
        () => mem.getVersion("journal"), () => mem.keys()]) {
        await assertRejects(read, Error, "corrupt");
      }
    } finally {
      head.node.content = published;
    }
    await master.removeEntry("journal-wal", { recursive: true });
    await stageMasterJournalCutover(master, {
      journalExists: false, journal: [], archiveExists: true, archive: [],
      allocateVersion: async () => legacyVersion + 2,
    });
    assertEquals(await mem.get("journal"), null, "a stale legacy row cannot resurrect an absent WAL key");
    assertEquals(await mem.getStrict("journal"), null);
    assertEquals(await mem.has("journal"), false);
    assertEquals(await mem.snapshot("journal"), { exists: false, value: null, version: legacyVersion + 2 });
    assertEquals((await mem.keys()).includes("journal"), false);
    assertEquals(await mem.has("journal-archive"), true, "present-empty archive stays distinct from absence");
    assertEquals(await mem.getStrict("journal-archive"), []);
    assertEquals((await mem.keys()).includes("journal-archive"), true);
    await assertRejects(() => mem.delete("journal-archive"), Error, "WAL");
  } finally {
    await master.removeEntry("journal-wal", { recursive: true });
  }
  assertEquals(await mem.get("journal"), [{ id: "stale-legacy" }], "test fixture removal restores the old authority");
});

Deno.test("journal cancellation archives overflow and keeps the live 500-row boundary", async () => {
  const mem = masterMemory();
  const seed = Array.from({ length: 500 }, (_, i) => ({ ts: i, type: "history", id: `cancel-old-${i}` }));
  await mem.setTrusted("journal", seed);
  const rows = await journalCommitCancellation(mem, { result: "cancelled" }, "exec-cancel-overflow");
  assertEquals(rows.length, 500);
  assertEquals(rows[0].id, "cancel-old-1");
  assertEquals(rows.at(-1).executionId, "exec-cancel-overflow");
  const archive = await mem.get("journal-archive");
  assertEquals(archive.at(-1).id, "cancel-old-0", "the evicted whole row must remain in the archive");
});

Deno.test("journal cancellation refuses a stale snapshot without erasing a foreign append", async () => {
  const mem = masterMemory();
  await mem.setTrusted("journal", [{ type: "history", id: "original" }]);
  let injected = false;
  const inject = async (value) => {
    if (!injected) {
      injected = true;
      await mem.setTrusted("journal", [...value, { type: "foreign", id: "later" }]);
    }
  };
  const racing = {
    ...mem,
    async snapshot(key) {
      const state = await mem.snapshot(key);
      if (key === "journal") await inject(state.value);
      return state;
    },
    async get(key) {
      const value = await mem.get(key);
      if (key === "journal") await inject(value ?? []);
      return value;
    },
  };
  await assertRejects(() => journalCommitCancellation(racing, { result: "cancelled" }, "exec-cancel-race"), Error, "concurrent");
  const rows = await mem.get("journal");
  assertEquals(rows.map((row) => row.id), ["original", "later"]);
  assertEquals(rows.some((row) => row.executionId === "exec-cancel-race"), false);
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
  await mem.setTrusted("journal-archive", []);
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
  assertEquals((await mem.get("journal-archive")).map((row) => row.id), ["old-0", "old-1", "old-2", "old-3"],
    "legacy archive is an append-only HISTORY LOG: compensation restores live rows without retracting prior evictions");
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

Deno.test("post-compensation fence undo CAS uses its actual issued token, not journal version plus one", async () => {
  const mem = masterMemory();
  await mem.setTrusted("journal", [{ id: "before" }]);
  const receipt = await journalAppendWithReceipt(mem, { type: "task", executionId: "exec-undo-actual-token" });
  await mem.setTrusted("other-key-before-compensation", { changed: true });
  let calls = 0;
  const result = await journalCompensateExecution(mem, receipt, async () => {
    if (++calls === 3) throw new Error("ownership lost after compensation");
  });
  assertEquals(result.reason, "journal_fence_failed");
  assertEquals(await mem.get("journal"), receipt.postState, "failed compensation must undo itself");
});

Deno.test("staged master transaction exposes WAL verbs without re-entering the master lock", async () => {
  const isolated = dirNode();
  const previousNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { storage: { async getDirectory() { return new FakeDirHandle(isolated); } } },
    configurable: true, writable: true,
  });
  try {
    const api = await import("../extension/lib/memory.js");
    await api.withMasterJournalIssuer(async (master, issuer) => {
      await stageMasterJournalCutover(master, { journalExists: false,
        journal: [], archive: [], allocateVersion: issuer.allocateVersion });
    });
    let expired;
    const receipt = await withStoreTransaction(api.masterMemory(), async (tx) => {
      assertEquals(typeof tx.masterJournal?.appendWithReceipt, "function");
      assertEquals(typeof tx.masterJournal?.compensate, "function");
      assertEquals(typeof tx.masterJournal?.cancel, "function");
      expired = tx.masterJournal;
      return await tx.masterJournal.appendWithReceipt({ type: "task", executionId: "tx-authority" });
    });
    assertEquals(receipt.wal.operationId, "1:1");
    assertEquals((await api.masterMemory().get("journal"))[0].executionId, "tx-authority");
    const concurrent = await withStoreTransaction(api.masterMemory(), async (tx) =>
      Promise.all([
        tx.masterJournal.appendWithReceipt({ type: "task", executionId: "tx-concurrent-a" }),
        tx.masterJournal.appendWithReceipt({ type: "task", executionId: "tx-concurrent-b" }),
      ]));
    assertEquals(new Set(concurrent.map((r) => r.writeVersion)).size, 2,
      "two concurrent operations inside one transaction still issue distinct versions");
    assertEquals((await api.masterMemory().get("journal")).map((r) => r.executionId),
      ["tx-authority", "tx-concurrent-a", "tx-concurrent-b"]);
    let releaseGenerationWrites;
    const generationBarrier = new Promise((resolve) => { releaseGenerationWrites = resolve; });
    let waitingGenerationWrites = 0;
    generationWriteGate = async () => {
      if (++waitingGenerationWrites === 2) releaseGenerationWrites();
      await generationBarrier;
    };
    // On the old adapter both issuers read the same token and reach write()
    // before either closes. On the fixed shared queue the first advances,
    // then the second proceeds when the bounded one-writer timer releases it.
    const gateTimer = setTimeout(releaseGenerationWrites, 80);
    let keyVersion, mixedReceipt;
    try {
      [keyVersion, mixedReceipt] = await withStoreTransaction(api.masterMemory(), async (tx) =>
        Promise.all([
          tx.setTrusted("mixed-master-key", "value"),
          tx.masterJournal.appendWithReceipt({ type: "task", executionId: "tx-mixed-version" }),
        ]));
    } finally {
      generationWriteGate = null;
      clearTimeout(gateTimer);
    }
    assertEquals(keyVersion !== mixedReceipt.writeVersion, true,
      "a key write and WAL frame inside one transaction cannot issue the same version");
    const beforeGuard = (await api.masterMemory().get("journal")).length;
    await withStoreTransaction(api.masterMemory(), async (tx) => {
      const prior = await tx.masterJournal.head();
      const guardedReceipt = await tx.masterJournal.appendWithReceipt(
        { type: "task", executionId: "guard-boundary" }, { guard: async () => {
          await assertRejects(async () => tx.masterJournal.head(), Error, "reentrant");
          await assertRejects(async () => tx.setTrusted("guard-unexpected", true), Error, "reentrant");
        } });
      assertEquals(guardedReceipt.wal.sequence, prior.sequence + 1);
    });
    assertEquals((await api.masterMemory().get("journal")).length, beforeGuard + 1);
    assertEquals(isolated.children.get("memory").children.get("master").children.has("guard-unexpected.json"), false);
    const routed = await withStoreTransaction(api.masterMemory(), async (tx) => {
      const before = await tx.masterJournal.head();
      const receipt = await tx.masterJournal.appendWithReceipt(
        { type: "task", executionId: "compensated-tx" });
      const compensation = await tx.masterJournal.compensate(receipt);
      const cancelled = await tx.masterJournal.cancel(
        { executionId: "cancelled-tx", type: "cancelled" }, "cancelled-tx");
      return { before, compensation, cancelled, after: await tx.masterJournal.head() };
    });
    assertEquals(routed.compensation.ok, true);
    assertEquals(routed.cancelled.at(-1).executionId, "cancelled-tx");
    assertEquals(routed.after.sequence, routed.before.sequence + 3);
    assertEquals(isolated.children.get("memory").children.get("master").children.has("journal.json"), false);
    await assertRejects(async () => expired.appendWithReceipt(
      { type: "task", executionId: "after-scope" }), Error, "expired");
    await withStoreTransaction(api.siteMemory("https://site.test"), async (tx) => {
      assertEquals(tx.masterJournal, undefined, "site stores have no master authority");
    });
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      value: previousNavigator, configurable: true, writable: true,
    });
  }
});

Deno.test("master clear epoch reads the durable generation after a foreign realm writes", async () => {
  const isolated = dirNode();
  const previousNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { storage: { async getDirectory() { return new FakeDirHandle(isolated); } } },
    configurable: true, writable: true,
  });
  try {
    const realmA = await import("../extension/lib/memory.js?wal-clear-realm-a");
    const realmB = await import("../extension/lib/memory.js?wal-clear-realm-b");
    const a = realmA.masterMemory();
    const first = await a.setTrusted("first", true);
    const second = await realmB.masterMemory().setTrusted("second", true);
    assert(second > first);
    await a.clear();
    const master = isolated.children.get("memory").children.get("master");
    const epoch = JSON.parse(master.children.get("__epoch.json").content).gen;
    assert(epoch >= second, "clear must not publish a stale epoch after another realm advanced __gen");
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      value: previousNavigator, configurable: true, writable: true,
    });
  }
});

Deno.test("staged master issuer uses the real durable generation under one lock", async () => {
  const isolated = dirNode();
  const previousNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    value: { storage: { async getDirectory() { return new FakeDirHandle(isolated); } } },
    configurable: true, writable: true,
  });
  try {
    const memoryApi = await import("../extension/lib/memory.js");
    assertEquals(typeof memoryApi.masterJournalReadGeneration, "function");
    assertEquals(typeof memoryApi.withMasterJournalIssuer, "function");
    assertEquals(await memoryApi.masterJournalReadGeneration(), 0);
    assertEquals(isolated.children.has("memory"), false, "a read must not create a master store");
    const published = await memoryApi.withMasterJournalIssuer(async (master, issuer) => {
      await stageMasterJournalCutover(master, {
        journalExists: true, journal: [{ id: "seed" }], archive: [],
        allocateVersion: issuer.allocateVersion,
      });
      for (let id = 0; id < 129; id++) await stageMasterJournalFrame(master,
        { operation: "append", row: { id } }, issuer);
      return (await memoryApi.masterJournalReadGeneration());
    });
    assert(published > 129);
    assertEquals(await memoryApi.masterJournalReadGeneration(), published);
    const master = isolated.children.get("memory").children.get("master");
    assertEquals(master.children.has("journal.json"), false, "the staged issuer never mirrors legacy journal.json");
    assertEquals(master.children.get("journal-wal").children.has("claim-1-129.json"), false,
      "real generation compaction claim retires after both checked heads advance");
    let escapedIssuer;
    await memoryApi.withMasterJournalIssuer(async (_master, issuer) => {
      escapedIssuer = issuer;
      void issuer.allocateVersion(); // the lock must outlive this unawaited issuance
    });
    assertEquals(await memoryApi.masterJournalReadGeneration(), published + 1);
    await assertRejects(async () => escapedIssuer.allocateVersion(), Error, "expired");
    master.children.get("__gen.json").content = JSON.stringify({ gen: published - 1 });
    await assertRejects(() => memoryApi.masterJournalReadGeneration(), Error,
      "behind checked master journal head");
    master.children.get("__gen.json").content = JSON.stringify({ gen: published + 1 });
    master.children.delete("__gen.json");
    await assertRejects(() => memoryApi.masterJournalReadGeneration(), Error,
      "missing after cutover");
    await assertRejects(() => memoryApi.withMasterJournalIssuer(async (_master, issuer) =>
      issuer.allocateVersion()), Error, "missing after cutover");
    master.children.set("__gen.json", fileNode("{torn:"));
    await assertRejects(() => memoryApi.masterJournalReadGeneration(), Error, "corrupt");
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      value: previousNavigator, configurable: true, writable: true,
    });
  }
});

Deno.test("master generation remains monotonic across independent extension realms", async () => {
  const firstRealm = masterMemory();
  const first = await firstRealm.setTrusted("wal-realm-token-first", "first");
  const secondModule = await import("../extension/lib/memory.js?wal-independent-realm");
  const second = await secondModule.masterMemory().setTrusted("wal-realm-token-second", "second");
  const third = await firstRealm.setTrusted("wal-realm-token-third", "third");
  assert(second > first, "another realm must read the previously issued durable token");
  assert(third > second, "a cached local token must not overwrite another realm's issued version");
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

Deno.test("stores allow >500 tiny keys per execution with NO key count or byte limits (dptw)", async () => {
  root.children.clear();
  const durable = durableRunMemory();
  const id = "exec:11111111-1111-4111-8111-111111111111";
  for (let i = 0; i < 550; i += 1) {
    await durable.setTrusted(`run-log:${id}:${String(i).padStart(6, "0")}`, { i });
  }
  const read549 = await durable.get(`run-log:${id}:000549`);
  assertEquals(read549?.i, 549, ">500 keys per execution succeed without key count limitation");

  const source = await Deno.readTextFile(new URL("../extension/lib/memory.js", import.meta.url));
  assert(!source.includes("const MAX_VALUE_BYTES"), "dptw: per-value cap gone");
  assert(!source.includes("const MAX_KEYS_PER_ORIGIN"));
  assert(!source.includes("const MAX_BYTES_PER_ORIGIN"), "dptw: per-origin quota gone");
  assert(!source.includes("const MAX_BYTES_GLOBAL"), "dptw: global quota gone");
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

Deno.test("durable store routes the run-log-wal migration marker instead of throwing", async () => {
  // Regression for the 27s thread.get stall (chrome-agent-platform-gf82):
  // durable-runs.js marks an execution's WAL migration with a
  // `run-log-wal:<executionId>` key, but DURABLE_KEY_RE/DURABLE_PREFIXES
  // omitted `run-log-wal` while archive-target-registry.js already admitted it.
  // Every store.has/setTrusted for the marker threw
  // `invalid durable-run key: run-log-wal:<id>` and was swallowed by
  // `.catch(() => false)` — so the marker was NEVER persisted, and a cold
  // worker re-ran the full-OPFS migration walk on every boot.
  root.children.clear();
  const durable = durableRunMemory();
  const id = "exec:00000000-0000-4000-8000-000000000010";
  const key = `run-log-wal:${id}`;

  await durable.setTrusted(key, { schemaVersion: 1, retentionPolicyVersion: "run-retention-v1", executionId: id, migratedRows: 0 });
  assertEquals((await durable.get(key))?.executionId, id, "the migration marker must round-trip");
  assertEquals(await durable.has(key), true);
  assert((await durable.keys()).includes(key), "keys() must surface run-log-wal markers");

  // A second execution's marker must not overwrite the first.
  const otherId = "exec:00000000-0000-4000-8000-000000000011";
  await durable.setTrusted(`run-log-wal:${otherId}`, { schemaVersion: 1, retentionPolicyVersion: "run-retention-v1", executionId: otherId, migratedRows: 3 });
  assertEquals((await durable.get(key))?.executionId, id, "a second execution's marker must not overwrite the first");
});

Deno.test("cold-boot listLogs for a WAL execution makes zero store.keys() walks (the marker persists)", async () => {
  // The other half of the 27s stall: before `run-log-wal:` was routable, a cold
  // worker could not read the marker, so listLogs queued migrateExecutionLog on
  // the exclusive write lock and that migration walked the ENTIRE durable store
  // (every execution/payload/thread directory) once per worker lifetime. With
  // the marker persisted, a fresh worker reads it in one store.has() and never
  // walks the store at all.
  root.children.clear();
  const executionId = "exec:00000000-0000-4000-8000-000000000020";
  const logHandleFor = createMemoryRunLogHandles();
  const deps = {
    resolveJournalStore: async () => ({}),
    appendJournal: async () => {},
    replaceCancellationJournal: async () => {},
    commitThread: async () => {},
    replaceCancellationThread: async () => {},
  };

  // Seed a WAL execution the way a live worker does (marker written by start()).
  const seed = createDurableRunRegistry({
    store: durableRunMemory(),
    logHandleFor,
    bootId: "boot-gf82-seed",
    ...deps,
  });
  await seed.start({
    executionId,
    kind: "task",
    taskPreview: "gf82 cold-boot",
    journalTarget: "master",
    resumeRequest: { id: "task-gf82", task: "gf82 cold-boot" },
  });
  await seed.appendLog(executionId, { type: "tool-call", tool: "echo", callId: "c1" });
  await seed.settle(executionId, { ok: true, result: "done" });

  // A cold worker: a fresh registry + fresh durableRunMemory meeting the same
  // OPFS tree, with a counting wrapper over the store's keys() walk.
  let keysCalls = 0;
  const raw = durableRunMemory();
  const countingStore = new Proxy(raw, {
    get(target, name) {
      if (name === "keys") {
        return async (...args) => { keysCalls += 1; return await target.keys(...args); };
      }
      const value = target[name];
      if (typeof value === "function") return (...args) => value.apply(target, args);
      return value;
    },
  });
  const cold = createDurableRunRegistry({
    store: countingStore,
    logHandleFor,
    bootId: "boot-gf82-cold",
    ...deps,
  });

  const rows = await cold.listLogs(executionId, 10);
  assert(Array.isArray(rows) && rows.length >= 1, "a WAL execution still reads its rows on a cold worker");
  assertEquals(keysCalls, 0, "a cold worker reading a WAL execution must make 0 store.keys() walks");
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

Deno.test("a store grows past the removed 8 MiB per-origin quota (dptw); the ledger still tracks it", async () => {
  root.children.clear();
  usageLedgerInspector.reset();
  const mem = siteMemory("https://quota.example");
  const path = ["memory", "origins", encodeURIComponent("https://quota.example")];
  const OLD_LIMIT = 8 * 1024 * 1024;
  // dptw: write PAST the removed 8 MiB bound — every write lands.
  const chunk = 1024 * 1024;
  let i = 0;
  do {
    await mem.setTrusted(`f${i}`, "x".repeat(chunk - 64));
    i++;
  } while (storeWalkBytes(path) < OLD_LIMIT + chunk);
  const total = storeWalkBytes(path);
  assert(total > OLD_LIMIT, `the store sits past the removed 8 MiB bound (${total} bytes)`);
  assertEquals(usageLedgerInspector.storeBytes(path), total, "the diagnostics ledger still equals the walk");
  // And a further write still lands.
  await mem.set("fits", "");
  assertEquals(usageLedgerInspector.storeBytes(path), storeWalkBytes(path), "ledger still equals the walk after growth");
});

Deno.test("durable payload family: a 10MiB retained response persists through the REAL durableRunMemory quota path (kmpq P0)", async () => {
  // kmpq P0 regression: persistJsonPayload writes chunked run-payload keys into
  // the per-execution store, which is byte-capped at MAX_BYTES_PER_ORIGIN
  // (8MiB). The lane's earlier tests injected an unlimited FakeStore and missed
  // that a 10MiB response could never persist in production. Retained payloads
  // now route to their OWN store family (durable-runs/payloads/<execId>) whose
  // per-store byte bound is disabled (global budget + native OPFS only). This
  // test drives the REAL durableRunMemory quota path — write all chunks through
  // the actual store and read the retained payload back.
  root.children.clear();
  usageLedgerInspector.reset();
  const durable = durableRunMemory();
  const registry = createDurableRunRegistry({
    store: durable,
    logHandleFor: (durable.__logHandles ??= createMemoryRunLogHandles()),
    bootId: "boot-payload-quota",
    now: (() => { let n = 50_000; return () => ++n; })(),
    resolveJournalStore: async () => ({}),
    appendJournal: async () => {},
    replaceCancellationJournal: async () => {},
    commitThread: async () => {},
    replaceCancellationThread: async () => {},
  });
  const executionId = "exec:22222222-2222-4222-8222-222222222222";
  await registry.start({
    executionId,
    kind: "task",
    taskPreview: "10MiB",
    journalTarget: "master",
    resumeRequest: { id: "tenmib", task: "tenmib", route: "runTask", routeArgs: {}, idempotencyKey: executionId },
  });
  // 10MiB of ASCII (heterogeneous content by habit; the homogeneous-run
  // redactor quadratic was fixed in vj4s — bounded URL-userinfo scheme run).
  const unit = "The quick brown fox jumps over the lazy dog. 0123456789\n";
  const big = unit.repeat(Math.ceil((10 * 1024 * 1024) / unit.length));
  const terminal = await registry.settle(executionId, { ok: true, result: big, logicalId: "tenmib", at: Date.now() });
  assertEquals(terminal.phase, "terminal", "a 10MiB response settles through the REAL durable store");
  // The payload chunks live in the dedicated payload family, NOT the execution
  // KV store — so the per-execution store stays far under its byte bound while
  // the retained payload persists in full.
  const encoded = encodeURIComponent(executionId);
  const executionStoreBytes = usageLedgerInspector.storeBytes(["memory", "durable-runs", "executions", encoded]);
  assert(executionStoreBytes < 1024 * 1024,
    `execution store must not hold the payload chunks (${executionStoreBytes} bytes)`);
  const payloadStoreBytes = usageLedgerInspector.storeBytes(["memory", "durable-runs", "payloads", encoded]);
  assert(payloadStoreBytes > 8 * 1024 * 1024,
    `payload family holds the complete response (${payloadStoreBytes} bytes)`);
  // Round-trip through the real store: the log row's payloadRef reads back the
  // full 10MiB text from the payload family.
  const logs = await registry.listLogs(executionId);
  const terminalRow = [...logs].reverse().find((r) => r?.type === "terminal" || r?.type === "result");
  assert(terminalRow, "terminal log row present");
  const retained = terminalRow?.payload?.result ?? terminalRow?.result ?? "";
  assertEquals(retained.length, big.length, "the retained payload round-trips complete through the real store");
});
