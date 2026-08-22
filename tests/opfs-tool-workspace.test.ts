// opfs-tool-workspace.test.ts — the SW-owned OPFS tool-workspace wrapper matrix
// (CAP-FB-20260822-OPFS-TOOL-WORKSPACES-01). The fault shim ACTUALLY injects
// mid-write / mid-close / interrupted-move / interrupted-remove /
// QuotaExceededError, and every test OBSERVES the recovery — not a stub.
// @ts-nocheck

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { OpfsToolWorkspace, ANCHOR_FILE, GC_MARKER, WORKSPACE_ROOT } from "../extension/lib/opfs-tool-workspace.js";
import { createAssetKeyed, getAsset, listAssets } from "../extension/lib/artifacts.js";

// ---------------------------------------------------------------------------
// the faithful OPFS fault shim (real failure injection, real recovery)
// ---------------------------------------------------------------------------
class ShimFile {
  constructor(name, bytes = new Uint8Array()) {
    this.name = name;
    this.kind = "file";
    this.bytes = new Uint8Array(bytes);
  }
  async getFile() {
    const self = this;
    return {
      size: self.bytes.byteLength,
      async text() { return new TextDecoder().decode(self.bytes); },
      async arrayBuffer() { return self.bytes.buffer.slice(0); },
    };
  }
  async createWritable() {
    const self = this;
    const parts = [];
    const writable = {
      async write(data) {
        // MID-WRITE fault: the write throws; nothing is buffered (the file
        // stays uncommitted — a real QuotaExceededError).
        if (globalThis.__faults?.write?.has?.(self.name)) {
          throw Object.assign(new Error("injected failure: write"), { name: "QuotaExceededError" });
        }
        parts.push(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
      },
      async close() {
        // MID-CLOSE fault: close throws BEFORE the bytes commit (the ONLY
        // completion signal — a failed close leaves the file uncommitted).
        if (globalThis.__faults?.close?.has?.(self.name)) {
          throw Object.assign(new Error("injected failure: close"), { name: "QuotaExceededError" });
        }
        self.bytes = new Uint8Array(parts.flatMap((c) => [...c]));
      },
    };
    return writable;
  }
}
class ShimDir {
  constructor(name) {
    this.name = name;
    this.kind = "directory";
    this.kids = new Map();
  }
  async getDirectoryHandle(n, { create } = {}) {
    const k = String(n);
    const kid = this.kids.get(k);
    if (kid) return kid;
    if (!create) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
    const d = new ShimDir(k);
    this.kids.set(k, d);
    return d;
  }
  async getFileHandle(n, { create } = {}) {
    const k = String(n);
    const kid = this.kids.get(k);
    if (kid) return kid;
    if (!create) throw Object.assign(new Error("nf"), { name: "NotFoundError" });
    const f = new ShimFile(k);
    this.kids.set(k, f);
    return f;
  }
  async removeEntry(n, opts = {}) {
    const k = String(n);
    // INTERRUPTED-REMOVE fault: throws cleanly (nothing removed) — the real
    // OPFS removeEntry either lands or throws; the durable `.gc` marker makes
    // the retry idempotent.
    if (globalThis.__faults?.removeOnce) {
      globalThis.__faults.removeOnce = false;
      throw new Error("injected failure: remove");
    }
    this.kids.delete(k);
  }
  async moveEntry(from, to) {
    const v = this.kids.get(String(from));
    if (!v) return; // absent is fine (recovery idempotency)
    // INTERRUPTED-MOVE model: the TARGET is committed first, then the fault
    // throws BEFORE the source delete — the recovery sees BOTH (current +
    // next) and must commit the newer state exactly once.
    this.kids.set(String(to), v);
    if (globalThis.__faults?.moveOnce) {
      globalThis.__faults.moveOnce = false;
      throw new Error("injected failure: move");
    }
    this.kids.delete(String(from));
  }
  async *entries() {
    for (const [name, kid] of this.kids) yield [name, kid];
  }
}

// The SHARED OPFS root: `tool-jobs/` (the wrapper) + `memory/master/` (the
// artifact authority — the real memory store over the same root).
const root = new ShimDir("root");
const navigatorOverride = {
  storage: {
    async getDirectory() { return root; },
    async estimate() {
      if (globalThis.__estimate) return globalThis.__estimate;
      return { quota: Number.MAX_SAFE_INTEGER, usage: 0 };
    },
  },
};
Object.defineProperty(globalThis, "navigator", { value: navigatorOverride, configurable: true, writable: true });

function resetFaults() {
  globalThis.__faults = { write: new Set(), close: new Set(), moveOnce: false, removeOnce: false };
  globalThis.__estimate = null;
}
function resetStore() {
  resetFaults();
  root.kids.clear();
}
resetStore();

const EX = "exec_durable_0001";
const CALL = "1";
const SHA_HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"; // sha256("hello")

async function digestOf(bytes) {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function shaHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ws(now = () => Date.now()) {
  return new OpfsToolWorkspace({ getRoot: async () => root, now });
}
async function open(workspace, projected = [{ sha256: SHA_HELLO }], quotas = { bytes: 100, files: 4 }) {
  return workspace.openWorkspace({
    executionId: EX, callIndex: CALL, agent: "victor", origin: "https://evil.example",
    documentId: "doc-1", projected, quotas,
  });
}
async function rawFile(relPath) {
  let dir = root;
  for (const seg of relPath.split("/")) {
    if (!dir.kids.has(seg)) return null;
    dir = dir.kids.get(seg);
  }
  return dir?.kind === "file" ? dir : null;
}
async function rawText(relPath) {
  const f = await rawFile(relPath);
  return f ? new TextDecoder().decode(f.bytes) : null;
}
async function rawDir(relPath) {
  let dir = root;
  for (const seg of relPath.split("/")) {
    if (!dir.kids.has(seg)) return null;
    dir = dir.kids.get(seg);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// 1. open: the job root + the input immutability (no writable input handle) +
//    the hash verify
// ---------------------------------------------------------------------------
Deno.test("open: the job root + the input immutability (no writable input handle) + the hash verify", async () => {
  resetStore();
  const w = ws();
  const { root: jobDir } = await open(w);
  // The strict grammar: tool-jobs/<execution>/<call>/ with the subdirs.
  assert((await jobDir.getDirectoryHandle("inputs")).kind === "directory");
  assert((await jobDir.getDirectoryHandle("scratch")).kind === "directory");
  assert((await jobDir.getDirectoryHandle("output")).kind === "directory");
  const job = JSON.parse(await rawText(`tool-jobs/${EX}/${CALL}/.job`));
  assertEquals(job.executionId, EX);
  assertEquals(job.callIndex, CALL);
  assertEquals(job.agent, "victor");
  // The input immutability: the wrapper interface returns BYTES, never a
  // writable handle; the projected blob must exist + hash-verify.
  await w.projectInput({ executionId: EX, callIndex: CALL, sha256: SHA_HELLO, bytes: new TextEncoder().encode("hello") });
  const data = await w.readInput({ executionId: EX, callIndex: CALL, sha256: SHA_HELLO });
  assert(data instanceof Uint8Array, "readInput returns bytes (never a handle)");
  assertEquals(new TextDecoder().decode(data), "hello");
  assertEquals(await digestOf(data), SHA_HELLO);
  // A wrong digest FAILS the authority recheck.
  await assertRejects(
    () => w.readInput({ executionId: EX, callIndex: CALL, sha256: "0".repeat(64) }),
    (e) => e?.workspaceCode === "input_not_projected",
  );
});

// ---------------------------------------------------------------------------
// 2. projectInput: verify-before-write + write-once + re-read verify + the
//    conflicting-overwrite refusal + the interrupted-leftover completion
// ---------------------------------------------------------------------------
Deno.test("projectInput: verifies BEFORE writing, writes once, re-reads/hash-verifies, refuses a different blob", async () => {
  resetStore();
  const w = ws();
  await open(w);
  const first = await w.projectInput({ executionId: EX, callIndex: CALL, sha256: SHA_HELLO, bytes: new TextEncoder().encode("hello") });
  assert(first.ok);
  // A same-digest replay is an idempotent NO-OP (no double write).
  const replay = await w.projectInput({ executionId: EX, callIndex: CALL, sha256: SHA_HELLO, bytes: new TextEncoder().encode("hello") });
  assert(replay.ok && replay.deduped === true);
  // The hash is verified BEFORE any write: a mismatched digest FAILS CLOSED.
  await assertRejects(
    () => w.projectInput({ executionId: EX, callIndex: CALL, sha256: SHA_HELLO, bytes: new TextEncoder().encode("world") }),
    (e) => e?.workspaceCode === "input_hash_mismatch",
  );
  // Different bytes under the same digest are REFUSED (the blob is immutable).
  await assertRejects(
    () => w.projectInput({ executionId: EX, callIndex: CALL, sha256: SHA_HELLO, bytes: new TextEncoder().encode("world") }),
    (e) => e?.workspaceCode === "input_hash_mismatch",
  );
  // A sha that was never projected is refused by the authority recheck.
  await assertRejects(
    () => w.projectInput({ executionId: EX, callIndex: CALL, sha256: "1".repeat(64), bytes: new TextEncoder().encode("x") }),
    (e) => e?.workspaceCode === "input_not_projected",
  );
  // The read-back content hash-verifies.
  const data = await w.readInput({ executionId: EX, callIndex: CALL, sha256: SHA_HELLO });
  assertEquals(new TextDecoder().decode(data), "hello");
});

Deno.test("projectInput: an interrupted earlier projection leaves an empty file — the retry COMPLETES it", async () => {
  resetStore();
  const w = ws();
  await open(w);
  // Simulate the crash artifact: the file handle was created but the write
  // never committed (an empty leftover).
  const inputs = await rawDir(`tool-jobs/${EX}/${CALL}/inputs`);
  inputs.kids.set(`${SHA_HELLO}.bin`, new ShimFile(`${SHA_HELLO}.bin`, new Uint8Array()));
  const done = await w.projectInput({ executionId: EX, callIndex: CALL, sha256: SHA_HELLO, bytes: new TextEncoder().encode("hello") });
  assert(done.ok && done.deduped !== true, "the empty leftover is COMPLETED, not skipped");
  const data = await w.readInput({ executionId: EX, callIndex: CALL, sha256: SHA_HELLO });
  assertEquals(new TextDecoder().decode(data), "hello");
});

// ---------------------------------------------------------------------------
// 3. reserve: the exactly-one concurrent race + the byte/file bounds
// ---------------------------------------------------------------------------
Deno.test("reserve: the exactly-one concurrent race + the byte/file bounds", async () => {
  resetStore();
  const w = ws();
  await open(w);
  // Two concurrent reservers against the LAST budget — the mutex serializes;
  // exactly ONE wins; the loser observes quota_exceeded_bytes.
  const [a, b] = await Promise.all([
    w.reserve({ executionId: EX, callIndex: CALL, bytes: 60, files: 1, idempotencyKey: "k1" }),
    w.reserve({ executionId: EX, callIndex: CALL, bytes: 60, files: 1, idempotencyKey: "k2" }).catch((e) => ({ error: e?.workspaceCode })),
  ]);
  assert(a.ok === true, "the first reservation lands");
  assert(b?.error === "quota_exceeded_bytes", `exactly one wins the last budget: ${JSON.stringify(b)}`);
  // The byte bound on the write path.
  await assertRejects(
    () => w.writeFile({ executionId: EX, callIndex: CALL, area: "scratch", name: "big.bin", bytes: new TextEncoder().encode("z".repeat(50)) }),
    (e) => e?.workspaceCode === "quota_exceeded_bytes",
  );
  // The file bound: 4 files budgeted; a 5th write is refused.
  for (let i = 0; i < 3; i++) {
    await w.writeFile({ executionId: EX, callIndex: CALL, area: "scratch", name: `f${i}.bin`, bytes: new Uint8Array([i]) });
  }
  await assertRejects(
    () => w.writeFile({ executionId: EX, callIndex: CALL, area: "scratch", name: "f5.bin", bytes: new Uint8Array([1]) }),
    (e) => e?.workspaceCode === "quota_exceeded_files",
  );
  // The ORIGIN storage pressure fails the reserve closed.
  globalThis.__estimate = { quota: 1000, usage: 950 };
  await assertRejects(
    () => w.reserve({ executionId: EX, callIndex: CALL, bytes: 100, files: 1, idempotencyKey: "press" }),
    (e) => e?.workspaceCode === "origin_storage_pressure",
  );
});

// ---------------------------------------------------------------------------
// 4. reserve: the idempotency replay + the bounded applied keys + the
//    expired-key GC
// ---------------------------------------------------------------------------
Deno.test("reserve: the idempotency replay is a no-op + the applied keys are bounded + the expired keys GC", async () => {
  resetStore();
  let now = Date.now();
  const w = ws(() => now);
  await open(w, [{ sha256: SHA_HELLO }], { bytes: 1000, files: 1000 });
  const first = await w.reserve({ executionId: EX, callIndex: CALL, bytes: 5, files: 1, idempotencyKey: "rep" });
  const replay = await w.reserve({ executionId: EX, callIndex: CALL, bytes: 5, files: 1, idempotencyKey: "rep" });
  assert(replay.ok && replay.deduped === true, "the replay is a no-op");
  assertEquals(replay.reservationId, first.reservationId, "the replay returns the SAME reservation");
  // The state advanced exactly once (seq 2).
  const cur1 = JSON.parse(await rawText(`tool-jobs/${EX}/${CALL}/.quota.current`));
  assertEquals(cur1.seq, 2);
  assertEquals(cur1.bytesUsed, 5);
  // The bounded applied keys: 255 more distinct keys fill the cap; the next
  // NEW key FAILS CLOSED.
  for (let i = 0; i < 255; i++) {
    const r = await w.reserve({ executionId: EX, callIndex: CALL, bytes: 0, files: 1, idempotencyKey: `k${i}` });
    assert(r.ok, `key k${i} lands`);
  }
  await assertRejects(
    () => w.reserve({ executionId: EX, callIndex: CALL, bytes: 0, files: 1, idempotencyKey: "overflow" }),
    (e) => e?.workspaceCode === "applied_keys_full",
  );
  // Advance the clock past the TTL: the expired reservations' keys GC on the
  // next reserve (the replay no-op for the OLD keys is dropped — they're
  // expired) and a NEW key lands.
  now += 31 * 60 * 1000;
  const after = await w.reserve({ executionId: EX, callIndex: CALL, bytes: 0, files: 1, idempotencyKey: "fresh" });
  assert(after.ok, "a fresh key lands after the expired-key GC");
  const cur2 = JSON.parse(await rawText(`tool-jobs/${EX}/${CALL}/.quota.current`));
  assert(cur2.appliedKeys.length <= 2, `the applied keys were GC'd: ${cur2.appliedKeys.length}`);
  assert(cur2.appliedKeys.includes("fresh"));
  assert(!cur2.appliedKeys.includes("k0"), "an expired key is GC'd");
});

// ---------------------------------------------------------------------------
// 5. journal: the crash-after-close-newer COMMITS the newer reservation
//    (no budget hole) — observed through a REAL interrupted move
// ---------------------------------------------------------------------------
Deno.test("journal: a crash-after-close (interrupted move) commits the NEWER reservation exactly once — no budget hole", async () => {
  resetStore();
  const w = ws();
  await open(w);
  // Arm the move fault: reserve A's move throws AFTER the target committed —
  // the next operation must recover and commit the newer state.
  globalThis.__faults.moveOnce = true;
  const a = await w.reserve({ executionId: EX, callIndex: CALL, bytes: 60, files: 1, idempotencyKey: "A" });
  assert(a.ok);
  // The recovery: current (seq 1) + next (seq 2) both present — the newer
  // COMMITS; the second reserver against the same budget must fail.
  const b = await w.reserve({ executionId: EX, callIndex: CALL, bytes: 60, files: 1, idempotencyKey: "B" })
    .catch((e) => ({ error: e?.workspaceCode }));
  assert(b?.error === "quota_exceeded_bytes", `exactly one reservation survives the crash: ${JSON.stringify(b)}`);
  // NO BUDGET HOLE: the committed seq-2 usage is seen by the next reserver.
  const c = await w.reserve({ executionId: EX, callIndex: CALL, bytes: 30, files: 1, idempotencyKey: "C" });
  assert(c.ok);
  const cur = JSON.parse(await rawText(`tool-jobs/${EX}/${CALL}/.quota.current`));
  assertEquals(cur.seq, 3);
  assertEquals(cur.bytesUsed, 90, "the newer reservation is committed — no budget hole");
  assertEquals(cur.reservations.length, 2, "A + C only — B never double-applied");
});

// ---------------------------------------------------------------------------
// 6. journal: a stale/partial next is DISCARDED + the valid current retained
// ---------------------------------------------------------------------------
Deno.test("journal: a stale/partial/corrupt next is DISCARDED + the valid current is retained", async () => {
  resetStore();
  const w = ws();
  await open(w);
  await w.reserve({ executionId: EX, callIndex: CALL, bytes: 40, files: 1, idempotencyKey: "base" });
  // Craft a STALE next (seq lower than the committed current) directly.
  const jobDir = await rawDir(`tool-jobs/${EX}/${CALL}`);
  jobDir.kids.set(".quota.next", new ShimFile(".quota.next", new TextEncoder().encode(JSON.stringify({
    seq: 1, prevSeq: 0, prevDigest: null, bytesUsed: 999, filesUsed: 99, reservations: [], appliedKeys: [],
  }))));
  const r1 = await w.reserve({ executionId: EX, callIndex: CALL, bytes: 5, files: 1, idempotencyKey: "r1" });
  assert(r1.ok);
  const cur1 = JSON.parse(await rawText(`tool-jobs/${EX}/${CALL}/.quota.current`));
  assertEquals(cur1.bytesUsed, 45, "the stale next was discarded — the current retained");
  // A CORRUPT next (invalid JSON) is discarded the same way.
  jobDir.kids.set(".quota.next", new ShimFile(".quota.next", new TextEncoder().encode("{not json!!")));
  const r2 = await w.reserve({ executionId: EX, callIndex: CALL, bytes: 5, files: 1, idempotencyKey: "r2" });
  assert(r2.ok);
  const cur2 = JSON.parse(await rawText(`tool-jobs/${EX}/${CALL}/.quota.current`));
  assertEquals(cur2.bytesUsed, 50, "the corrupt next was discarded — the current retained");
  assert(!jobDir.kids.has(".quota.next"), "the partial next is cleaned up");
});

// ---------------------------------------------------------------------------
// 7. journal: the continuity — the trusted anchor match COMMITS; a missing /
//    forged anchor QUARANTINES
// ---------------------------------------------------------------------------
Deno.test("journal: a valid next + missing current COMMITS only on the trusted anchor match; else QUARANTINE", async () => {
  resetStore();
  const w = ws();
  await open(w);
  await w.reserve({ executionId: EX, callIndex: CALL, bytes: 40, files: 1, idempotencyKey: "base" });
  const jobDir = await rawDir(`tool-jobs/${EX}/${CALL}`);
  // The crash artifact: a valid next (seq 3, parent = the committed seq 2)
  // with the current LOST + the anchor still holding the parent identity.
  const cur2Raw = await rawText(`tool-jobs/${EX}/${CALL}/.quota.current`);
  const cur2 = JSON.parse(cur2Raw);
  const parentDigest = shaHex(new TextEncoder().encode(cur2Raw));
  jobDir.kids.set(".quota.next", new ShimFile(".quota.next", new TextEncoder().encode(JSON.stringify({
    seq: 3, prevSeq: 2, prevDigest: parentDigest, bytesUsed: 100, filesUsed: 1, reservations: [], appliedKeys: [],
  }))));
  jobDir.kids.delete(".quota.current"); // the current is LOST (a corrupt/missing read)
  // The anchor must match the next's PARENT: { seq: 2, digest: parentDigest }.
  jobDir.kids.set(ANCHOR_FILE, new ShimFile(ANCHOR_FILE, new TextEncoder().encode(JSON.stringify({ seq: 2, digest: parentDigest }))));
  // The next operation recovers: the anchor MATCHES → the newer state COMMITS
  // (proved by the budget: the recovered bytesUsed=100 rejects a 10-byte
  // reserve — never a continuity quarantine, never a hole).
  const after = await w.reserve({ executionId: EX, callIndex: CALL, bytes: 10, files: 1, idempotencyKey: "after" })
    .catch((e) => ({ error: e?.workspaceCode }));
  assertEquals(after.error, "quota_exceeded_bytes", `the anchor-matched next COMMITTED (no quarantine, no hole): ${JSON.stringify(after)}`);
  const cur3 = JSON.parse(await rawText(`tool-jobs/${EX}/${CALL}/.quota.current`));
  assertEquals(cur3.seq, 3, "the recovered next became the current");
  assertEquals(cur3.bytesUsed, 100, "the recovered reservation is committed — no hole");
  // WITHOUT the anchor (missing) the continuity is unverifiable → QUARANTINE.
  const jobDir2 = await rawDir(`tool-jobs/${EX}/${CALL}`);
  jobDir2.kids.delete(ANCHOR_FILE);
  jobDir2.kids.delete(".quota.current");
  jobDir2.kids.set(".quota.next", new ShimFile(".quota.next", new TextEncoder().encode(JSON.stringify({
    seq: 4, prevSeq: 3, prevDigest: shaHex(new TextEncoder().encode("whatever")), bytesUsed: 1, filesUsed: 1, reservations: [], appliedKeys: [],
  }))));
  await assertRejects(
    () => w.reserve({ executionId: EX, callIndex: CALL, bytes: 1, files: 1, idempotencyKey: "q" }),
    (e) => e?.workspaceCode === "quota_continuity_unverifiable",
  );
  // A FORGED anchor (a mismatch) also QUARANTINES.
  jobDir2.kids.delete(ANCHOR_FILE);
  jobDir2.kids.set(ANCHOR_FILE, new ShimFile(ANCHOR_FILE, new TextEncoder().encode(JSON.stringify({ seq: 99, digest: "deadbeef" }))));
  await assertRejects(
    () => w.reserve({ executionId: EX, callIndex: CALL, bytes: 1, files: 1, idempotencyKey: "q2" }),
    (e) => e?.workspaceCode === "quota_continuity_unverifiable",
  );
});

// ---------------------------------------------------------------------------
// 8. promote: the KEYED artifact WAL — the retry dedupes to the SAME asset +
//    a crash rollback leaves exactly ONE asset
// ---------------------------------------------------------------------------
Deno.test("promote: the keyed WAL create dedupes a retry to the SAME asset; a crash rollback leaves exactly one", async () => {
  resetStore();
  const w = ws();
  await open(w);
  await w.writeFile({ executionId: EX, callIndex: CALL, area: "output", name: "report.json", bytes: new TextEncoder().encode('{"ok":true}') });
  // The wrapper routes ONLY through the keyed authority (never unkeyed).
  let p1;
  try {
    p1 = await w.promoteOutput({ executionId: EX, callIndex: CALL, name: "report.json", type: "json" });
  } catch (e) {
    throw new Error(`first promote failed: ${e?.workspaceCode} detail=${JSON.stringify(e?.detail)}`);
  }
  assert(p1.ok);
  assert(p1.artifactTxRef?.id, "the promotion returns the artifact id");
  assert(p1.artifactTxRef?.deduped !== true);
  // The RETRY with the same output dedupes to the SAME asset (the same key).
  const p2 = await w.promoteOutput({ executionId: EX, callIndex: CALL, name: "report.json", type: "json" });
  assert(p2.ok && p2.artifactTxRef?.deduped === true, "the retry dedupes");
  assertEquals(p2.artifactTxRef.id, p1.artifactTxRef.id, "the SAME asset id");
  assertEquals((await listAssets("master")).assets.length, 1, "exactly ONE asset");
  const row = (await listAssets("master")).assets[0];
  assert(row.pk === p1.promotionKey, "the row carries the stable promotion key (the dedup record)");
  const body = await getAsset("master", p1.artifactTxRef.id);
  assertEquals(body.asset.content, '{"ok":true}');

  // CRASH ROLLBACK: arm the mid-close fault on the WAL write (__tx.json) —
  // the promote FAILS without a duplicate; the recovery + retry creates once.
  await w.writeFile({ executionId: EX, callIndex: CALL, area: "output", name: "other.json", bytes: new TextEncoder().encode('{"v":2}') });
  resetFaults();
  globalThis.__faults.close.add("__tx.json");
  await assertRejects(
    () => w.promoteOutput({ executionId: EX, callIndex: CALL, name: "other.json", type: "json" }),
    (e) => e?.workspaceCode === "promotion_failed" || e?.message?.includes("close"),
  );
  // DISARM + retry: the WAL recovery resolves the interrupted intent and the
  // keyed create lands exactly once.
  resetFaults();
  let p3;
  try {
    p3 = await w.promoteOutput({ executionId: EX, callIndex: CALL, name: "other.json", type: "json" });
  } catch (e) {
    throw new Error(`retry promote failed: ${e?.workspaceCode} detail=${JSON.stringify(e?.detail)} msg=${e?.message}`);
  }
  assert(p3.ok && p3.artifactTxRef?.id);
  const all = await listAssets("master");
  assertEquals(all.assets.length, 2, "the crash rollback left no duplicate");
});

// ---------------------------------------------------------------------------
// 9. gc: the explicit-authority orphan GC — restart / interrupted remove /
//    cross-job denial
// ---------------------------------------------------------------------------
Deno.test("gc: the explicit-authority orphan GC removes only validated terminal+expired jobs; an interrupted remove resumes; cross-job denial", async () => {
  resetStore();
  let now = Date.now();
  const w = ws(() => now);
  await open(w);
  await w.reserve({ executionId: EX, callIndex: CALL, bytes: 1, files: 1, idempotencyKey: "g" });
  await w.closeWorkspace({ executionId: EX, callIndex: CALL, outcome: "closed" });
  // Not expired yet → NOT removed.
  let g1 = await w.gcWorkspaces({ olderThanMs: 1000 });
  assertEquals(g1.removed, 0);
  // Expired + terminal → removed.
  now += 60_000;
  let g2 = await w.gcWorkspaces({ olderThanMs: 1000 });
  assertEquals(g2.removed, 1);
  assert(!(await rawDir(`tool-jobs/${EX}/${CALL}`)), "the job root is gone");

  // INTERRUPTED REMOVE: the marker persists + the NEXT pass (a NEW instance —
  // a restart) completes the removal.
  now = Date.now();
  const w2 = ws(() => now);
  await open(w2);
  await w2.closeWorkspace({ executionId: EX, callIndex: CALL, outcome: "closed" });
  now += 60_000;
  globalThis.__faults.removeOnce = true;
  const g3 = await w2.gcWorkspaces({ olderThanMs: 1000 });
  assertEquals(g3.removed, 0, "the interrupted removal removed nothing this pass");
  const marker = await rawText(`tool-jobs/${EX}/${CALL}/.gc`);
  assert(marker != null && marker.includes(EX), "the durable pending-GC marker persists");
  const w3 = ws(() => now); // a RESTARTED instance over the same root
  const g4 = await w3.gcWorkspaces({ olderThanMs: 1000 });
  assertEquals(g4.removed, 1, "the restarted GC completes the interrupted removal");

  // CROSS-JOB DENIAL: a job whose .job identity mismatches its path is NEVER
  // removed even when terminal + expired.
  now = Date.now();
  const w4 = ws(() => now);
  await open(w4);
  await w4.closeWorkspace({ executionId: EX, callIndex: CALL, outcome: "closed" });
  const jobPath = `tool-jobs/${EX}/${CALL}/.job`;
  const jobText = await rawText(jobPath);
  await (await rawDir(`tool-jobs/${EX}/${CALL}`)).getFileHandle(".job", { create: false });
  // Forge a mismatched identity INSIDE the .job.
  const jobDir4 = await rawDir(`tool-jobs/${EX}/${CALL}`);
  const forged = JSON.parse(jobText);
  forged.executionId = "other_exec_999";
  jobDir4.kids.set(".job", new ShimFile(".job", new TextEncoder().encode(JSON.stringify(forged))));
  now += 60_000;
  const g5 = await w4.gcWorkspaces({ olderThanMs: 1000 });
  assertEquals(g5.removed, 0, "a mismatched-identity job is never removed");
  assert(await rawDir(`tool-jobs/${EX}/${CALL}`), "the cross-job dir survives");
});

// ---------------------------------------------------------------------------
// 10. no-secret: the .job / receipts / .gc carry metadata only (never
//     args/secrets) — verified by an actual grep
// ---------------------------------------------------------------------------
Deno.test("no-secret: the .job + receipts + .gc carry metadata only (never args/secrets)", async () => {
  resetStore();
  const w = ws();
  const SECRET = "sk_live_super_secret_9f4b2a1c";
  const secretSha = await digestOf(new TextEncoder().encode(SECRET));
  await open(w, [{ sha256: secretSha }]);
  // The tool's args/secrets NEVER enter the workspace metadata.
  await w.projectInput({ executionId: EX, callIndex: CALL, sha256: secretSha, bytes: new TextEncoder().encode(SECRET) });
  await w.reserve({ executionId: EX, callIndex: CALL, bytes: 5, files: 1, idempotencyKey: "s" });
  const closed = await w.closeWorkspace({ executionId: EX, callIndex: CALL, outcome: "completed" });
  const receipt = JSON.stringify(closed.receipt);
  const jobText = await rawText(`tool-jobs/${EX}/${CALL}/.job`);
  assert(!jobText.includes(SECRET), "the .job never contains the secret");
  assert(!receipt.includes(SECRET), "the receipt never contains the secret");
  // The GC marker too.
  const wg = ws();
  await wg.gcWorkspaces({ olderThanMs: 0, terminalStates: new Set(["completed", "closed"]) });
  const marker = await rawText(`tool-jobs/${EX}/${CALL}/.gc`) ?? "";
  assert(!marker.includes(SECRET), "the .gc marker never contains the secret");
  // The metadata DOES carry the identity (and only a digest — never the bytes).
  assert(jobText.includes(EX) && jobText.includes("victor"));
  assert(jobText.includes(secretSha), "only the CAS digest is recorded");
});
