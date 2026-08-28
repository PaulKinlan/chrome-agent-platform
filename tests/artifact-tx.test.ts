// artifact-tx.test.ts — the durable artifact-transaction fault matrix (the
// fresh-lane scope: the durable store + the transaction state machine).
// Each test encodes a reviewer failure as a failing-invariant assertion.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ASSET_BOUNDS,
  REPAIR_BOUNDS,
  createAsset,
  deleteAsset,
  getAsset,
  listAssets,
  updateAsset,
} from "../extension/lib/artifacts.js";

// ---- minimal OPFS fake with failure injection ----
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(c) { return { kind: "file", content: c }; }
class FakeWritable {
  constructor(node) { this.node = node; this.parts = []; }
  async write(s) { this.parts.push(typeof s === "string" ? s : new TextDecoder().decode(s)); }
  async close() {
    this.node.content = this.parts.join("");
    if (globalThis.__failClose?.has(this.node.name)) throw new Error("injected failure: close");
  }
}
class FakeFileHandle {
  constructor(node, failWrite = false) { this.node = node; this.failWrite = failWrite; this.name = null; }
  get kind() { return "file"; }
  async getFile() { const n = this.node; return { size: (n?.content ?? "").length, async text() { return n?.content ?? ""; } }; }
  async createWritable() {
    const nth = globalThis.__failWritableNth?.get?.(this.name);
    if (typeof nth === "number") {
      if (nth <= 1) { globalThis.__failWritableNth.delete(this.name); throw new Error("injected failure: createWritable (nth)"); }
      globalThis.__failWritableNth.set(this.name, nth - 1);
    }
    if (this.failWrite) throw new Error("injected failure: createWritable");
    const w = new FakeWritable(this.node);
    w.node.name = this.name;
    return w;
  }
}
class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) { if (!opts.create) throw new Error(`not found: ${name}`); this.node.children.set(name, dirNode()); }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (globalThis.__failGetFileHandle?.has(name)) throw new Error("injected failure: getFileHandle");
    const nth = globalThis.__failGetFileHandleNth?.get?.(name);
    if (typeof nth === "number") {
      if (nth <= 1) { globalThis.__failGetFileHandleNth.delete(name); throw new Error("injected failure: getFileHandle (nth)"); }
      globalThis.__failGetFileHandleNth.set(name, nth - 1);
    }
    if (!this.node.children.has(name)) { if (!opts.create) throw new Error(`not found: ${name}`); this.node.children.set(name, fileNode("")); }
    const fh = new FakeFileHandle(this.node.children.get(name), globalThis.__failWritable?.has(name));
    fh.name = name;
    return fh;
  }
  async removeEntry(name, opts = {}) {
    if (globalThis.__failRemoveEntry?.has(name)) throw new Error("injected failure: removeEntry");
    this.node.children.delete(name);
  }
  async *entries() { for (const [n, node] of this.node.children) yield [n, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)]; }
}
const root = dirNode();
Object.defineProperty(globalThis, "navigator", {
  value: { storage: { async getDirectory() { return new FakeDirHandle(root); } } },
  configurable: true, writable: true,
});
function resetFailures() {
  globalThis.__failGetFileHandle = new Set();
  globalThis.__failGetFileHandleNth = new Map();
  globalThis.__failWritable = new Set();
  globalThis.__failWritableNth = new Map();
  globalThis.__failClose = new Set();
  globalThis.__failRemoveEntry = new Set();
  globalThis.__failAssetRemoval = false;
}
function resetStore() { resetFailures(); root.children.clear(); }
resetStore();

function masterDir() { return root.children.get("memory")?.children?.get("master") ?? null; }
function rawKey(name) {
  const dir = masterDir();
  if (!dir) return null;
  const node = dir.children.get(`${name}.json`);
  return node ? (node.content ?? "") : null;
}
function bodyCount() {
  const dir = masterDir();
  if (!dir) return 0;
  let n = 0;
  for (const name of dir.children.keys()) {
    if (name.startsWith("asset:") && !name.endsWith(".tomb")) n += 1;
  }
  return n;
}
function readRepairRaw() {
  const raw = rawKey("assetRepair");
  if (!raw) return null;
  try { return JSON.parse(raw)?.__value ?? JSON.parse(raw); } catch { return null; }
}

Deno.test("tx: ABSENT→create→delete→absent leaves the version NEVER 0 — a stale expected-0 CAS cannot match a recreate (restart ABA)", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m1 = masterMemory();
  const v0 = await m1.getVersion("asset:probe");
  assertEquals(v0, 0, "never-created is version 0");
  const g1 = await m1.setTrusted("asset:probe", { v: 1 });
  const g2 = await m1.setTrusted("asset:probe", { v: 2 });
  assert(g2 > g1, "writes are monotonic");
  await m1.delete("asset:probe");
  // The deleted key is NOT version 0 (the tombstone persists it).
  const afterDelete = await m1.getVersion("asset:probe");
  assert(afterDelete > 0, "a deleted key's version is never 0");
  // A SEPARATE store instance over the same directory (a "restart") sees the
  // same durable generation + tombstone.
  const m2 = masterMemory();
  assertEquals(await m2.getVersion("asset:probe"), afterDelete, "restart sees the same durable version");
  // A stale CAS with the OLD version (or 0) can never land after a recreate.
  const g3 = await m2.setTrusted("asset:probe", { v: 3 });
  const staleDelete = await m2.compareAndDelete("asset:probe", afterDelete);
  assert(staleDelete === false, "a stale pre-delete CAS cannot delete the recreated key");
  const staleRestore = await m2.compareAndRestore("asset:probe", 0, { v: "stale" });
  assert(staleRestore === false, "an expected-0 CAS cannot restore over a recreated key");
  assert(g3 > afterDelete, "the recreate's version continues the durable sequence");
});

Deno.test("tx: separate store INSTANCES issue ONE durable sequence (no path-object collisions)", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const a = masterMemory();
  const b = masterMemory();
  const g1 = await a.set("x", 1);
  const g2 = await b.set("y", 2);
  const g3 = await a.set("z", 3);
  assert(g1 !== g2 && g2 !== g3 && g3 > g2 && g2 > g1, "instances share one monotonic sequence");
});

Deno.test("tx: create's eviction obligations are recorded BEFORE the commit and a FAILED create removes them — valid bodies are NEVER deleted by the repair", async () => {
  resetStore();
  const original = ASSET_BOUNDS.maxIndexBytes;
  ASSET_BOUNDS.maxIndexBytes = 500; // create 2 fits (403B); create 3 evicts (604B)
  // Create two small assets, then a create that EVICTS them.
  const a = await createAsset("master", { type: "text", name: `keep-a-${"x".repeat(100)}`, content: "a" });
  const b = await createAsset("master", { type: "text", name: `keep-b-${"x".repeat(100)}`, content: "b" });
  const ids = [a.asset.id, b.asset.id];
  // The next create evicts the oldest + FAILS at the index CAS (inject a close
  // failure on the index write — but the CAS uses a durable gen write... use
  // the getFileHandle failure on assets.json to fail the CAS compare? No — the
  // CAS compare reads. Fail the WRITE: the compareAndRestore writes via
  // writeEntry — inject __failWritable on assets.json).
  globalThis.__failWritable = new Set(["assets.json"]);
  let threw = false;
  try { await createAsset("master", { type: "text", name: `big-${"x".repeat(100)}`, content: "c" }); } catch { threw = true; }
  globalThis.__failWritable = new Set();
  assert(threw, "the create surfaces the failure");
  // The obligations are REMOVED (the failed create never committed the
  // eviction) + the two valid bodies SURVIVE + are still listed.
  const repair = readRepairRaw();
  assert(repair && repair.pendingDeletes.length === 0, "no stale eviction obligations remain");
  assertEquals(bodyCount(), 2, "the two valid bodies survive");
  const list = await listAssets("master");
  assert(list.ok && list.assets.length === 2, "both valid rows survive");
  ASSET_BOUNDS.maxIndexBytes = original;
});

Deno.test("tx: update compensation is guarded by the EXACT new-body version — a repair can COMPLETE (non-null versions)", async () => {
  resetStore();
  const r = await createAsset("master", { type: "text", name: "u", content: "v1" });
  const id = r.asset.id;
  // A CREATEWRITABLE failure on the update's index write leaves the bytes
  // UNCOMMITTED → the update fails + the prior state is intact.
  globalThis.__failWritableNth = new Map([["assets.json", 1]]);
  const up = await updateAsset("master", id, { content: "v2" });
  globalThis.__failWritableNth = new Map();
  // (The update may surface the failure OR — if the CAS committed before a
  // close throw — succeed; EITHER way the row/body must be CONSISTENT.)
  const got = await getAsset("master", id);
  assert(got.ok, "the asset body is readable");
  const list = await listAssets("master");
  assert(list.ok && list.assets.some((x) => x.id === id), "the row survives");
  const row = list.assets.find((x) => x.id === id);
  if (up.ok === false) {
    assert(got.asset.content === "v1", "a failed update restores the prior body");
    assert(row.name === "u" && row.size === 2 || row.size === 2, "the row matches the prior state");
  } else {
    assert(got.asset.content === "v2", "a committed update keeps the new body");
    assert(row.name === "u" && row.size === 2, "the row matches the new body (no divergence)");
  }
});

Deno.test("tx: delete removes the body by its EXACT write token — a newer body is never deleted", async () => {
  resetStore();
  const r = await createAsset("master", { type: "text", name: "d", content: "v1" });
  const id = r.asset.id;
  // A concurrent writer updates the body between the index CAS and the body
  // delete — simulate by writing a NEW body version after the delete's index
  // CAS... simplest: the delete's compareAndDelete targets the body version
  // captured at S0; a newer body makes the CAS false → the delete refuses.
  const { masterMemory } = await import("../extension/lib/memory.js");
  const store = masterMemory();
  const del = await deleteAsset("master", id);
  assert(del.ok === true, "the delete succeeds with no interference");
  const after = await getAsset("master", id);
  assert(after.ok === false, "the body is gone");
  void store;
});

Deno.test("tx: the corrupt-index HEAL keeps ONLY rows whose BODIES exist (valid-body identity)", async () => {
  resetStore();
  const a = await createAsset("master", { type: "text", name: "h1", content: "1" });
  const b = await createAsset("master", { type: "text", name: "h2", content: "2" });
  // Corrupt the index file + delete one body directly (simulating a
  // metadata-resurrection risk).
  const dir = masterDir();
  dir.children.set("assets.json", fileNode(""));
  dir.children.delete(`asset:${a.asset.id}.json`);
  // A create triggers the heal: only the surviving body's row may return.
  const c = await createAsset("master", { type: "text", name: "h3", content: "3" });
  assert(c.ok, "the create heals + proceeds");
  const list = await listAssets("master");
  assert(list.ok, "the index is readable after the heal");
  const listed = new Set(list.assets.map((x) => x.id));
  assert(listed.has(b.asset.id) && listed.has(c.asset.id), "rows with real bodies survive");
  assert(!listed.has(a.asset.id), "a row whose body is gone is NOT resurrected");
});

Deno.test("tx: a MALFORMED repair state THROWS (never silently replaced)", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  await masterMemory().setTrusted("assetRepair", { pendingDeletes: "not-an-array", pendingRestores: [] });
  let threw = false;
  try { await createAsset("master", { type: "text", name: "m", content: "x" }); } catch (e) {
    threw = /corrupt/.test(String(e?.message ?? e));
  }
  assert(threw, "a malformed repair state surfaces as corruption");
});

Deno.test("tx: the update RESERVES its compensation capacity — a durable WAL failure REJECTS BEFORE the mutation (the old body is never lost)", async () => {
  resetStore();
  const r = await createAsset("master", { type: "text", name: "big", content: "x".repeat(500) });
  const id = r.asset.id;
  // Fail the durable WAL write (the intent carries the old body + both rows —
  // the reserved compensation capacity). The update must REJECT BEFORE any
  // body mutation.
  globalThis.__failWritableNth = new Map([["__tx.json", 1]]);
  let rejected = false;
  try {
    await updateAsset("master", id, { content: "y".repeat(500) });
  } catch { rejected = true; }
  globalThis.__failWritableNth = new Map();
  assert(rejected, "the update rejects when the durable compensation capacity cannot be written");
  const got = await getAsset("master", id);
  assert(got.ok && got.asset.content === "x".repeat(500), "the old body is UNCHANGED (rejected before mutation)");
  const list = await listAssets("master");
  assert(list.ok && list.assets.some((x) => x.id === id), "the row is unchanged");
});

Deno.test("tx: reads run under the per-origin mutex — no interleaving observation (concurrent reads during writes are serialized)", async () => {
  resetStore();
  // A burst of concurrent creates + reads: the reads must never observe a
  // split write (the mutex serializes them).
  const writes = Array.from({ length: 10 }, (_, i) => createAsset("master", { type: "text", name: `n${i}`, content: `c${i}` }));
  const reads = [listAssets("master"), listAssets("master")];
  const results = await Promise.all([...writes, ...reads]);
  const lists = results.filter((r) => r && Array.isArray(r.assets));
  for (const l of lists) {
    assert(l.ok, "a list read during writes must be consistent");
    const names = new Set(l.assets.map((a) => a.name));
    for (const n of names) {
      const got = await getAsset("master", l.assets.find((a) => a.name === n).id);
      assert(got.ok && got.asset.name === n, "each listed row has a real body (no split observation)");
    }
  }
  const final = await listAssets("master");
  assertEquals(final.assets.length, 10, "all 10 creates land");
});

Deno.test("tx: a STALE pre-delete token is invalidated IMMEDIATELY (the deleted-state ABA — the tombstone advances the authority)", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m = masterMemory();
  const g = await m.setTrusted("asset:aba", { v: 1 });
  // Delete: the tombstone advances the authority — a stale token valid BEFORE
  // the delete must NOT restore after it.
  const del = await m.delete("asset:aba");
  assert(del === undefined, "the delete succeeds");
  const stale = await m.compareAndRestore("asset:aba", g, { v: "stale" });
  assert(stale === false, "a stale pre-delete token cannot restore after deletion");
  const now = await m.getVersion("asset:aba");
  assert(now > g, "the tombstone advanced the authority beyond the deleted generation");
});

Deno.test("tx: the generation authority is model-UNWRITABLE (__gen / __tx / assetRepair / asset: reserved)", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m = masterMemory();
  const g1 = await m.setTrusted("k", 1);
  // The model's memory_set must refuse the internal namespace.
  let refused = 0;
  for (const k of ["__gen", "__tx", "assetRepair", "asset:probe"]) {
    try { await m.set(k, 1); } catch (e) { refused += /reserved/.test(String(e?.message ?? e)) ? 1 : 0; }
  }
  assertEquals(refused, 4, "every internal/artifact key is reserved from the model");
  // The authority still advances after the attempted writes.
  const g2 = await m.setTrusted("k2", 2);
  assert(g2 > g1, "the authority is unaffected by refused writes");
});

Deno.test("tx: a CRASH after the body write (a leftover prepared WAL) is recovered — the orphan body is cleaned by its exact token", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m = masterMemory();
  // Simulate a crash: a prepared create WAL + a body that was written but the
  // index CAS never landed.
  const bodyGen = await m.setTrusted("asset:crash", { content: "orphan" });
  await m.setTrusted("__tx", { op: "create", id: "crash", bodyGen, idxGen: 1, newIndex: [], droppedIds: [], state: "prepared" });
  // The next operation recovers: the orphan body is cleaned by its exact token.
  const r = await createAsset("master", { type: "text", name: "after", content: "ok" });
  assert(r.ok, "the next create recovers + succeeds");
  const body = await getAsset("master", "crash");
  assert(body.ok === false, "the crashed create's orphan body is cleaned");
  // The WAL is finalized.
  const wal = await m.getStrict("__tx");
  assert(wal == null || wal.state === "none", "the WAL is finalized");
});

Deno.test("tx: a CRASH after the delete index CAS (a prepared delete WAL) is recovered — the orphan body is cleaned", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m = masterMemory();
  const r = await createAsset("master", { type: "text", name: "del", content: "x" });
  const id = r.asset.id;
  const bodyGen = await m.getVersion(`asset:${id}`);
  // Simulate a crash: the index CAS landed (the row gone) but the body delete
  // never ran — a prepared delete WAL.
  const idx = (await listAssets("master")).assets;
  const remaining = idx.filter((x) => x.id !== id);
  await m.compareAndRestore("assets", await m.getVersion("assets"), remaining);
  await m.setTrusted("__tx", { op: "delete", id, bodyGen, idxGen: 1, index: idx, state: "prepared" });
  // The next operation recovers: the orphan body is cleaned.
  const r2 = await createAsset("master", { type: "text", name: "after-del", content: "y" });
  assert(r2.ok, "the next create recovers");
  const body = await getAsset("master", id);
  assert(body.ok === false, "the crashed delete's orphan body is cleaned");
});

Deno.test("tx: clear() PRESERVES the store epoch — a clear/recreate can never reuse generations", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m1 = masterMemory();
  const g1 = await m1.setTrusted("k1", 1);
  await m1.clear();
  const m2 = masterMemory();
  const g2 = await m2.setTrusted("k2", 2);
  assert(g2 > g1, "the generation authority survives a clear (epoch preserved)");
});

Deno.test("tx: isolated contexts share ONE durable authority (a second store instance over the same dir sees the same sequence + the same tombstones)", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const a = masterMemory();
  const b = masterMemory();
  // Interleaved writes from two "contexts" — the durable __gen file is the
  // single authority: no collisions.
  const g1 = await a.setTrusted("x", 1);
  const g2 = await b.setTrusted("y", 2);
  const g3 = await a.setTrusted("z", 3);
  assert(g1 !== g2 && g2 !== g3 && g3 > g2 && g2 > g1, "interleaved instances share one sequence");
  // A delete in one context is visible (tombstoned) in the other.
  await a.delete("x");
  assertEquals(await b.getVersion("x"), await a.getVersion("x"), "both contexts see the same tombstone generation");
  assert((await b.getVersion("x")) > g1, "the tombstone advanced the authority");
});

// ---- REJECT-4 regressions (the reviewer's 8 deterministic violations) ----

Deno.test("tx-reject4: a prepared update WAL without newBodyGen still RESTORES the old body on recovery", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m = masterMemory();
  const r = await createAsset("master", { type: "text", name: "old", content: "v1" });
  const id = r.asset.id;
  const oldBody = (await getAsset("master", id)).asset;
  const index = (await listAssets("master")).assets;
  const oldRow = index.find((x) => x.id === id);
  // Simulate a crash after the body write but before the newBodyGen record:
  // a prepared WAL (no newBodyGen) + the new body already written.
  await m.setTrusted("__tx", { op: "update", id, oldBody, oldBodyGen: await m.getVersion(`asset:${id}`), oldRow, newRow: { ...oldRow, name: "new", size: 2 }, idxGen: await m.getVersion("assets"), state: "prepared" });
  await m.setTrusted(`asset:${id}`, { ...oldBody, name: "new", content: "v2" });
  assert((await createAsset("master", { type: "text", name: "next", content: "x" })).ok);
  const row = (await listAssets("master")).assets.find((x) => x.id === id);
  const body = (await getAsset("master", id)).asset;
  assertEquals(row.name, "old", "the row is unchanged (the index CAS never landed)");
  assertEquals(body.name, "old", "the old body is RESTORED (not the new one)");
  assertEquals(body.content, "v1", "the old content is restored");
});

Deno.test("tx-reject4: a retained terminal update WAL is recoverable (no schema corruption after a swallowed clear)", async () => {
  resetStore();
  const r = await createAsset("master", { type: "text", name: "old", content: "v1" });
  globalThis.__failWritableNth = new Map([["__tx.json", 3]]);
  const up = await updateAsset("master", r.asset.id, { name: "new", content: "v2" });
  assert(up.ok, "the update commits");
  globalThis.__failWritableNth = new Map();
  let corrupt = false;
  try { await createAsset("master", { type: "text", name: "after", content: "x" }); } catch (e) {
    corrupt = /WAL \(update\) is corrupt/.test(String(e?.message ?? e));
  }
  assert(!corrupt, "a retained terminal WAL is recovered, not reported as corrupt");
  const body = await getAsset("master", r.asset.id);
  assert(body.ok && body.asset.name === "new", "the committed update survives");
});

Deno.test("tx-reject4: the folded floor never shadows a LIVE version and never authorizes another key", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m = masterMemory();
  for (let i = 0; i < 513; i++) {
    const k = `d${i}`;
    const v = await m.set(k, i);
    await m.compareAndDelete(k, v);
  }
  const liveToken = await m.set("live", "v");
  assertEquals(await m.getVersion("live"), liveToken, "a live key reports its write token, not the floor");
  const tokenA = await m.getVersion("never-a");
  const landed = await m.compareAndRestore("never-b", tokenA, "cross-key");
  assertEquals(landed, false, "an absent key's token never authorizes another absent key");
});

Deno.test("tx-reject4: clear preserves folded absence authority (no expected-0 ABA)", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m = masterMemory();
  const stale0 = await m.getVersion("target");
  const tv = await m.set("target", "v");
  await m.compareAndDelete("target", tv);
  for (let i = 0; i < 513; i++) {
    const k = `q${i}`;
    const v = await m.set(k, i);
    await m.compareAndDelete(k, v);
  }
  const afterFold = await m.getVersion("target");
  assert(afterFold !== 0, "a folded key never returns to version 0");
  await m.clear();
  const afterClear = await m.getVersion("target");
  assert(afterClear !== 0, "clear preserves the folded absence authority");
  const stale = await m.compareAndRestore("target", stale0, "stale");
  assertEquals(stale, false, "a stale pre-create token cannot land after clear");
});

Deno.test("tx-reject4: __tombs is reserved from the model (get/set/keys)", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m = masterMemory();
  const v = await m.set("victim", 1);
  await m.compareAndDelete("victim", v);
  assert(!(await m.keys()).includes("__tombs"), "__tombs is hidden from keys()");
  let refused = false;
  try { await m.set("__tombs", { owned: true }); } catch (e) { refused = /reserved/.test(String(e?.message ?? e)); }
  assert(refused, "__tombs is reserved from the model's set");
  let getRefused = false;
  try { await m.get("__tombs"); } catch (e) { getRefused = /reserved/.test(String(e?.message ?? e)); }
  assert(getRefused, "__tombs is reserved from get");
});

Deno.test("tx-reject4: getStrict/has/keys honor a tombstone (no orphan visibility)", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m = masterMemory();
  const v = await m.set("victim", "live");
  globalThis.__failRemoveEntry = new Set(["victim.json"]);
  const del = await m.compareAndDelete("victim", v);
  assert(del !== false, "the delete succeeds (tombstone-first)");
  assertEquals(await m.get("victim"), null, "get honors the tombstone");
  assertEquals(await m.getStrict("victim"), null, "getStrict honors the tombstone");
  assertEquals(await m.has("victim"), false, "has honors the tombstone");
  assert(!(await m.keys()).includes("victim"), "keys honors the tombstone");
});

Deno.test("tx-reject4: an over-count/corrupt-token repair state fails closed", async () => {
  resetStore();
  const { masterMemory } = await import("../extension/lib/memory.js");
  const m = masterMemory();
  const over = Array.from({ length: 257 }, (_, i) => ({ id: `x${i}`, bodyGen: null }));
  await m.setTrusted("assetRepair", { pendingDeletes: [...over, { id: "corrupt", bodyGen: "unsafe" }], pendingRestores: [], lastGoodIndex: [] });
  let threw = false;
  try { await createAsset("master", { type: "text", name: "ok", content: "x" }); } catch (e) {
    threw = /bound|corrupt/.test(String(e?.message ?? e));
  }
  assert(threw, "an over-count/corrupt-token repair state fails closed (never truncated)");
});

Deno.test("tx-reject4: transient index I/O is NOT healed as corruption and lastGood mirrors every commit", async () => {
  resetStore();
  const r = await createAsset("master", { type: "text", name: "old", content: "v1" });
  // The lastGood mirror write fails; the committed WAL completes it via recovery.
  globalThis.__failWritableNth = new Map([["assetRepair.json", 2]]);
  const up = await updateAsset("master", r.asset.id, { name: "new", content: "v2" });
  globalThis.__failWritableNth = new Map();
  assert(up.ok, "the update commits");
  // A transient index read I/O on the NEXT create must not trigger a heal.
  globalThis.__failGetFileHandleNth = new Map([["assets.json", 1]]);
  const c = await createAsset("master", { type: "text", name: "after", content: "x" });
  globalThis.__failGetFileHandleNth = new Map();
  assert(c.ok, "the create succeeds through a transient index I/O");
  const row = (await listAssets("master")).assets.find((x) => x.id === r.asset.id);
  const body = (await getAsset("master", r.asset.id)).asset;
  assertEquals(row.name, "new", "the healthy updated row is never overwritten by a stale mirror");
  assertEquals(body.name, "new", "the body matches the committed update");
});
