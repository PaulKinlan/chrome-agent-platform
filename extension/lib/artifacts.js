// lib/artifacts.js — the artifacts (asset) store — DURABLE TRANSACTION state
// machine (the fresh-lane re-design; scope: the durable artifact transaction
// store only — no approvals/redaction/UI).
//
// Every mutation is an EXPLICIT state machine over the store's DURABLE version
// authority (memory.js: a persistent per-store generation file + tombstones —
// restart-safe, consistent across store instances, never reused across
// delete/recreate).
//
//   create(id):   S0 read(index,idxGen) → S1 record eviction obligations
//                 DURABLY (before any commit) → S2 write body (→ bodyGen) →
//                 S3 CAS index (idxGen→new): true→S4 | false→S5 | throw→S6
//                 S4 mirror: ok→S7 (cleanup evicted bodies, index-checked) |
//                 throw→S4b CAS-rollback index (CHECKED) + compareAndDelete
//                 body only if the rollback landed
//                 S5 remove the (now-unapplied) eviction obligations +
//                 compareAndDelete(body,bodyGen) → fail "concurrent"
//                 S6 remove the obligations + compareAndDelete(body,bodyGen)
//                 → rethrow
//   update(id):   S0 read(index,idxGen,body,bodyGen) → S1 write new body (→
//                 newBodyGen) → S2 CAS index (idxGen→mutated): true→done |
//                 false/throw→S3 compareAndRestore(body,newBodyGen,old)
//                 CHECKED: true→fail "concurrent" (fully rolled back) |
//                 false→ record a DURABLE restore {row,oldBody,
//                 bodyVersion:newBodyGen, indexVersion:idxGen} + fail
//   delete(id):   S0 read(index,idxGen,body,bodyGen) → S1 CAS index (row
//                 removed, idxGen→remaining): true→S2 | false→fail | throw→fail
//                 S2 compareAndDelete(body,bodyGen) CHECKED: true→done |
//                 false/throw→S3 CAS-restore row (postIdxGen→index) CHECKED:
//                 true→fail (row restored) | false→ record a DURABLE restore
//                 {row, indexVersion:postIdxGen} + fail
//
// The REPAIR pass (retried under the lock on the next op):
//   - pendingDeletes: SKIP a deletion when the CURRENT authoritative index
//     still references the id (a valid body is never deleted — the reviewer's
//     finding); otherwise compareAndDelete(body, bodyGen) CHECKED (a false CAS
//     keeps the obligation pending).
//   - pendingRestores: version-guarded (bodyVersion/indexVersion captured at
//     the failed write — NON-NULL so the repair can complete) with CHECKED CAS.
// The corrupt-index heal: lastGood rows whose BODIES EXIST + restore rows with
// existing bodies (valid-body identity — never resurrects stale metadata).

import { masterMemory, siteMemory, canonicalOrigin } from "./memory.js";
import { newId, sha256Hex } from "./pure.js";
// The ONE diff core (jsdiff via ./shared/diff-core.js → dist bundle). The build
// rewrites this dist import to the source wrapper for every bundle (build.mjs
// `cap-diff-core-from-source`), so no second diff implementation ships and the
// line delta a `patch_asset` reports is the SAME core the viewer/thread render
// (CAP-FB-20260830-PATCH-ASSET-TOOL-01, DIFF-LIBRARY-01).
import { lineDiffSummary } from "../dist/shared/diff-core.bundle.js";

const INDEX_KEY = "assets"; // reserved authority key (see memory.js)
const REPAIR_KEY = "assetRepair"; // durable pending-deletion/restore state (reserved)

/** The durable repair budget: the WHOLE repair value must fit the memory
 * store's per-value cap (256 KiB) — pendingRestores can hold full bodies, so
 * the byte budget is enforced at PUSH time (an over-budget push FAILS the
 * operation closed — never silently truncated). */
export const REPAIR_BOUNDS = {
  maxPendingDeletes: 256,
  maxPendingRestores: 64,
  maxRepairBytes: 200 * 1024,
};

const utf8Bytes = (s) => new TextEncoder().encode(s).byteLength;

const WAL_KEY = "__tx"; // the durable write-ahead intent (reserved internal)

/** The durable WRITE-AHEAD INTENT (the reviewer's crash-durability finding):
 * every mutation records its intent { op, id, state, exact tokens } DURABLY
 * BEFORE the first destructive write, then advances prepared → committed |
 * compensated, then finalizes (clears). A crash at ANY await leaves a durable
 * intent that `recoverTx` resolves on the next operation — an orphan body is
 * cleaned by its EXACT token, a committed row is completed. The WAL record is
 * BOUNDED (tokens + small rows only — never bodies), so it always fits the
 * value cap. A WAL-write failure FAILS the operation (no mutation without a
 * durable intent). */
async function writeWal(store, intent) {
  await store.setTrusted(WAL_KEY, intent);
}

async function clearWal(store) {
  await store.setTrusted(WAL_KEY, { state: "none" });
}

async function readWal(store) {
  let raw;
  try {
    raw = await store.getStrict(WAL_KEY);
  } catch (e) {
    // An unreadable/corrupt WAL FAILS the operation (never treated as absent —
    // the reviewer's finding: a WAL I/O failure was swallowed as "no WAL").
    throw new Error(`the transaction WAL is unreadable: ${String(e?.message ?? e)}`);
  }
  if (!raw || typeof raw !== "object" || raw.state === "none") return null;
  if (!["prepared", "committed", "compensated"].includes(raw.state)) {
    throw new Error("the transaction WAL state is corrupt");
  }
  // Schema-validate the intent (the reviewer's finding: an unknown op / malformed
  // fields were silently finalized).
  if (typeof raw.op !== "string" || !["create", "update", "delete", "evict"].includes(raw.op)) {
    throw new Error("the transaction WAL op is corrupt");
  }
  if (typeof raw.id !== "string" || !raw.id) {
    throw new Error("the transaction WAL id is corrupt");
  }
  // OPERATION-SPECIFIC validation (the reviewer's finding: the WAL schema was
  // open): a PREPARED intent requires its exact safe tokens/shapes — a
  // malformed intent FAILS CLOSED (never discarded or applied blindly). A
  // terminal (committed/compensated) intent only needs op/id/state: recovery
  // just clears it, so the terminal write is not forced to carry the prepared
  // body/row fields (the reviewer's terminal-WAL schema finding).
  const safeTok = (v) => Number.isSafeInteger(v); // a token may be a write gen (positive) or a per-key absence version (negative)
  const safePos = (v) => Number.isSafeInteger(v) && v >= 0; // body/row tokens are always write generations
  if (raw.state === "prepared") {
    // The staged VERSION fields (CAP-FB-20260830-ARTIFACT-VERSIONS-01): a
    // create/update intent that staged a version row + blob carries them so
    // the compensation can release exactly what it staged. An intent WITHOUT
    // them is a pre-versions intent (an upgrade over a crashed write) — it
    // stays recoverable; an intent WITH them must carry the exact shape.
    if ((raw.op === "create" || raw.op === "update") && raw.newVersion != null) {
      if (!safePos(raw.newVersion) || raw.newVersion < 1 || typeof raw.blobSha !== "string" ||
        !/^[0-9a-f]{64}$/.test(raw.blobSha) || typeof raw.blobIsNew !== "boolean" || !safePos(raw.blobSize)) {
        throw new Error(`the transaction WAL (${raw.op} version) is corrupt`);
      }
    }
    if (raw.op === "create") {
      if (!Array.isArray(raw.newIndex) || !Array.isArray(raw.droppedIds) || !safeTok(raw.idxGen)) {
        throw new Error("the transaction WAL (create) is corrupt");
      }
    } else if (raw.op === "update") {
      if (raw.newBodyGen != null && !safePos(raw.newBodyGen)) throw new Error("the transaction WAL (update) is corrupt");
      if (raw.oldBody != null && (raw.oldBodyGen == null || !safePos(raw.oldBodyGen))) throw new Error("the transaction WAL (update) is corrupt");
      if (!raw.oldRow || !raw.newRow || !safeTok(raw.idxGen)) throw new Error("the transaction WAL (update) is corrupt");
    } else if (raw.op === "delete") {
      if (!safePos(raw.bodyGen) || !safeTok(raw.idxGen) || !Array.isArray(raw.index)) throw new Error("the transaction WAL (delete) is corrupt");
    } else if (raw.op === "evict") {
      if (!Array.isArray(raw.ids)) throw new Error("the transaction WAL (evict) is corrupt");
    }
  }
  return raw;
}

/** The crash recovery (run under the per-origin lock at the start of every
 * operation): resolve any leftover intent to a terminal state. */
async function recoverTx(store) {
  const intent = await readWal(store); // throws on an unreadable/corrupt WAL
  if (!intent) return null;
  const op = intent.op;
  if (intent.state === "prepared") {
    const index = await readIndexStrict(store).catch(() => null);
    if (index == null) {
      // The authoritative index is unreadable — FAIL CLOSED: the intent stays
      // and the CALLER'S operation is refused (the reviewer's finding: an
      // unreadable index must never lead to an empty reference set).
      throw new Error("cannot recover a transaction with an unreadable index");
    }
    // The orphan-body token is DERIVED from the CURRENT body version when the
    // intent's token is null (the create's body→token WAL gap — a crash after
    // the body write before the exact-token record: the body EXISTS, so its
    // current version IS the token).
    const bodyToken = async () => {
      if (intent.bodyGen != null) return intent.bodyGen;
      const v = await store.getVersion(`asset:${intent.id}`).catch(() => 0);
      return v > 0 ? v : null;
    };
    let terminal = null;
    if (op === "create") {
      const rowPresent = index.some((r) => r.id === intent.id && JSON.stringify(r) === JSON.stringify(intent.row ?? r));
      if (rowPresent) {
        terminal = "committed";
      } else {
        const tok = await bodyToken();
        if (tok != null) {
          const cleaned = await store.compareAndDelete(`asset:${intent.id}`, tok);
          if (cleaned === false) throw new Error("recovery cleanup was refused");
        }
        await releaseStagedVersion(store, intent);
        terminal = "compensated";
      }
    } else if (op === "update") {
      // An update's row exists BOTH before and after the index CAS — the exact
      // commit is distinguished by the INDEX TOKEN: if the current index token
      // equals the post-CAS token the update committed; otherwise the OLD BODY
      // (persisted in the intent — the reviewer's finding) is RESTORED by the
      // exact new-body token, never deleted.
      const idxToken = await store.getVersion(INDEX_KEY);
      if (intent.postIdxGen != null && idxToken === intent.postIdxGen) {
        terminal = "committed";
      } else {
        if (intent.oldBody != null) {
          // The new body's token is recorded (newBodyGen) or DERIVED from the
          // CURRENT body version (a crash after the body write but before the
          // newBodyGen record — the reviewer's incomplete-prepared-token
          // finding): a derived token still restores the old body exactly.
          const token = intent.newBodyGen ?? await store.getVersion(`asset:${intent.id}`).catch(() => 0);
          if (Number.isSafeInteger(token) && token > 0) {
            const curBody = await store.getStrict(`asset:${intent.id}`).catch(() => null);
            if (curBody && JSON.stringify(curBody) !== JSON.stringify(intent.oldBody)) {
              const restored = await store.compareAndRestore(`asset:${intent.id}`, token, intent.oldBody);
              if (restored === false) throw new Error("recovery restore was refused");
            }
          }
        }
        await releaseStagedVersion(store, intent);
        terminal = "compensated";
      }
    } else if (op === "delete") {
      const rowAbsent = !index.some((r) => r.id === intent.id);
      if (rowAbsent) {
        const tok = intent.bodyGen ?? await bodyToken();
        if (tok != null) {
          const cleaned = await store.compareAndDelete(`asset:${intent.id}`, tok);
          if (cleaned === false) throw new Error("recovery cleanup was refused");
        }
        terminal = "committed";
      } else {
        terminal = "compensated";
      }
    } else if (op === "evict") {
      const refs = new Set(index.map((r) => r.id));
      for (const d of intent.ids ?? []) {
        if (!refs.has(d.id)) {
          const cleaned = await store.compareAndDelete(`asset:${d.id}`, d.bodyGen);
          if (cleaned === false) throw new Error("recovery cleanup was refused");
        }
      }
      terminal = "committed";
    }
    if (terminal == null) throw new Error("the transaction intent could not be resolved");
    intent.state = terminal;
    await writeWal(store, intent);
  } else if (!["committed", "compensated"].includes(intent.state)) {
    throw new Error("the transaction WAL state is corrupt");
  }
  // A COMMITTED delete releases the artifact's version rows + blobs; the
  // committed WAL stays until they are gone, so a crash mid-release is redone
  // here (idempotent: every drop is a read-then-delete of one row).
  if (intent.state === "committed" && op === "delete") {
    const row = (intent.index ?? []).find((r) => r && r.id === intent.id);
    await dropAllVersions(store, intent.id, row?.version);
  }
  // A COMMITTED intent completes the lastGood mirror (the reviewer's finding:
  // lastGood must reflect EVERY commit — a best-effort write that failed left a
  // stale mirror that a later heal restored over a healthy index). The committed
  // WAL carries the post-commit index; recovery persists it before clearing.
  if (intent.state === "committed" && Array.isArray(intent.newIndex)) {
    const repair = await readRepair(store).catch(() => null);
    if (repair) {
      repair.lastGoodIndex = intent.newIndex;
      await writeRepair(store, repair);
    }
  }
  // Re-read + finalize (a terminal write failure propagates — never clears an
  // unresolved intent).
  await clearWal(store);
  return intent.state;
}

/** Read the repair state STRICTLY — a malformed shape THROWS (never silently
 * replaced with empty and persisted over). */
async function readRepair(store) {
  const raw = await store.getStrict(REPAIR_KEY);
  if (raw == null) return { pendingDeletes: [], pendingRestores: [], lastGoodIndex: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("asset repair state is corrupt");
  }
  const deletes = raw.pendingDeletes;
  const restores = raw.pendingRestores;
  const lastGood = raw.lastGoodIndex;
  if (!Array.isArray(deletes) || !Array.isArray(restores)) {
    throw new Error("asset repair state is corrupt");
  }
  // READ-TIME bounds (the reviewer's finding: an over-count/corrupt-token repair
  // state was ACCEPTED and silently truncated): the counts must not exceed the
  // push-time budgets, and every obligation token must be a safe integer or
  // null. Any violation FAILS CLOSED (never truncated or discarded).
  if (deletes.length > REPAIR_BOUNDS.maxPendingDeletes) {
    throw new Error("asset repair pending-delete state exceeds its bound");
  }
  if (restores.length > REPAIR_BOUNDS.maxPendingRestores) {
    throw new Error("asset repair pending-restore state exceeds its bound");
  }
  const safeTok = (v) => v == null || (Number.isSafeInteger(v) && v >= 0);
  if (deletes.some((x) => !x || typeof x.id !== "string" || !safeTok(x.bodyGen))) {
    throw new Error("asset repair pending-delete state is corrupt");
  }
  if (lastGood !== null && lastGood !== undefined && !Array.isArray(lastGood)) {
    throw new Error("asset repair lastGoodIndex is corrupt");
  }
  if (restores.some((r) => !r || typeof r.id !== "string" || r.row == null || !safeTok(r.bodyVersion) || !safeTok(r.indexVersion))) {
    throw new Error("asset repair pending-restore state is corrupt");
  }
  return { pendingDeletes: deletes, pendingRestores: restores, lastGoodIndex: Array.isArray(lastGood) ? lastGood : null };
}

/** Persist the repair state — the ENTIRE value must fit the byte budget. */
async function writeRepair(store, repair) {
  const value = {
    pendingDeletes: repair.pendingDeletes,
    pendingRestores: repair.pendingRestores,
    lastGoodIndex: repair.lastGoodIndex ?? null,
  };
  const size = utf8Bytes(JSON.stringify(value));
  if (size > REPAIR_BOUNDS.maxRepairBytes) {
    throw new Error("asset repair state exceeds the durable byte budget");
  }
  await store.setTrusted(REPAIR_KEY, value);
}

/** Record a failed compensation durably — a persistence failure here is a REAL
 * failure (never swallowed; the caller surfaces it). */
async function recordRepairEntry(store, mutate) {
  const repair = await readRepair(store);
  const changed = mutate(repair);
  if (changed === false) return;
  await writeRepair(store, repair);
}

/** The corrupt-index heal: LAST-KNOWN-GOOD rows + pending-restore rows, each
 * validated against its BODY (a row survives only if its body exists). A body
 * READ failure FAILS CLOSED (the reviewer's finding: transient I/O must not
 * silently drop a row) — the caller returns the repair state for a later retry. */
async function healCorruptIndexLocked(store, repair, restores) {
  const candidates = [...(repair.lastGoodIndex ?? []), ...restores.map((r) => r.row).filter(Boolean)];
  const seen = new Set();
  const healed = [];
  for (const row of candidates) {
    if (!row || typeof row.id !== "string" || seen.has(row.id)) continue;
    seen.add(row.id);
    // getStrict: an absent body is null (row dropped); a real read/corruption
    // failure THROWS — never treated as absent.
    const body = await store.getStrict(`asset:${row.id}`);
    if (body && typeof body === "object") healed.push(row);
  }
  await store.setTrusted(INDEX_KEY, healed);
  return healed;
}

/** The REPAIR state machine (retried under the per-origin lock on the next
 * operation). NEVER deletes a body the CURRENT authoritative index references;
 * every CAS result is CHECKED (a false CAS keeps the obligation pending). */
async function repairPendingLocked(store, origin) {
  const repair = await readRepair(store);
  const deletes = [...repair.pendingDeletes];
  const restores = [...repair.pendingRestores];
  let indexError = null;
  let currentIndex = null;
  try {
    currentIndex = await readIndexStrict(store);
  } catch (e) {
    indexError = e;
  }
  if (indexError) {
    // Classify the FIRST exception (the reviewer's finding: the prior code
    // discarded it, REREAD, and healed when the second read succeeded — a
    // transient I/O was healed as corruption). A parse/shape corruption is
    // healable; ANY other throw (transient I/O) is indeterminate — FAIL CLOSED.
    const msg = String(indexError?.message ?? "");
    const isCorruption = indexError instanceof SyntaxError || /corrupt/.test(msg);
    if (!isCorruption) {
      // The authoritative index cannot be established — NO deletion/heal
      // decision is safe.
      return repair;
    }
    try {
      currentIndex = await healCorruptIndexLocked(store, repair, restores);
    } catch { return repair; } // still corrupt — a later repair retries
  }
  const indexRefs = new Set((currentIndex ?? []).map((r) => r.id));
  const stillDeletes = [];
  for (const rec of deletes) {
    try {
      // A body the CURRENT index still references is VALID — never delete it.
      if (indexRefs.has(rec.id)) continue;
      if (rec.bodyGen != null) {
        const bodyVersion = await store.getVersion(`asset:${rec.id}`);
        if (bodyVersion !== rec.bodyGen) continue; // the body changed — not our orphan
        const ok = await store.compareAndDelete(`asset:${rec.id}`, rec.bodyGen);
        if (ok === false) throw new Error("body CAS refused the deletion");
      } else {
        // An obligation WITHOUT an exact token cannot be safely cleaned — keep
        // it pending (the reviewer's finding).
        stillDeletes.push(rec);
        continue;
      }
    } catch { stillDeletes.push(rec); }
  }
  const stillRestores = [];
  for (const rec of restores) {
    try {
      const index = currentIndex ?? await readIndexStrict(store);
      if (rec.row) {
        const idxVersion = await store.getVersion(INDEX_KEY);
        if (!index.some((e) => e.id === rec.row.id)) {
          if (rec.indexVersion == null || idxVersion !== rec.indexVersion) {
            throw new Error("index changed since the failed restore");
          }
          const ok = await store.compareAndRestore(INDEX_KEY, rec.indexVersion, [...index, rec.row]);
          if (ok === false) throw new Error("index CAS refused the restore");
        }
      }
      if (rec.body != null) {
        const bodyVersion = await store.getVersion(`asset:${rec.id}`);
        if (rec.bodyVersion == null || bodyVersion !== rec.bodyVersion) {
          throw new Error("body changed since the failed restore");
        }
        const ok = await store.compareAndRestore(`asset:${rec.id}`, rec.bodyVersion, rec.body);
        if (ok === false) throw new Error("body CAS refused the restore");
      }
    } catch { stillRestores.push(rec); }
  }
  const next = { pendingDeletes: stillDeletes, pendingRestores: stillRestores, lastGoodIndex: repair.lastGoodIndex };
  await writeRepair(store, next);
  return next;
}

export const ASSET_BOUNDS = {
  // no-limits (owner directive 2026-09-03)
  maxContentBytes: Infinity,
  // A single append call carries at most this many UTF-8 bytes (a bounded
  // chunk of a body an artifact grows across calls); it is also the tool
  // argument transport bound for append_asset (tool-argument-contract.js).
  // no-limits (owner directive 2026-09-03)
  maxAppendBytes: Infinity,
  // The CEILING for ONE artifact body, measured the way the memory store
  // measures the asset-blob value it is written to (serialized JSON bytes,
  // memory.js MAX_ASSET_BLOB_VALUE_BYTES): append-grown bodies exceed the
  // 256 KiB single-call bound but never this one. This is a STORE write-path
  // ceiling only (p45y r5: the inspector mounts any stored or staged body in
  // full — rendering has no size cap of its own).
  // no-limits (owner directive 2026-09-03)
  maxBodySerializedBytes: Infinity,
  maxNameLength: 200,
  maxAssetsPerOrigin: 200,
  // The index byte bound used to be PER ORIGIN. The library is now one shared
  // index (CAP-FB-20260828-ARTIFACT-DURABILITY-01), so leaving it at 128 KiB
  // would have been a capacity REGRESSION: every origin's rows now compete for
  // one budget that previously each had to themselves. 128 KiB is ~940 rows;
  // 2 MiB is ~15,000, which is a realistic ceiling for one person's accumulated
  // work rather than a number that starts silently evicting inside a year.
  //
  // Silent eviction of the owner's OLDEST artifact is still the wrong terminal
  // behaviour for a library whose whole point is durability — raising the bound
  // defers that, it does not fix it. The evict-versus-refuse policy is
  // CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01.
  maxIndexBytes: 2 * 1024 * 1024,
  // Immutable per-artifact versions (CAP-FB-20260830-ARTIFACT-VERSIONS-01):
  // the last 20 versions of each artifact are kept; the bodies behind them are
  // content-addressed blobs whose total is capped library-wide. Over either
  // bound the OLDEST versions are evicted (never the head) and the eviction
  // is visible as `versionsTruncated` on the row — the same evict-versus-
  // refuse choice as CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01: a version
  // is a convenience the head does not depend on, so evicting one loses
  // history, not work, and the head is never refused for lack of history
  // space. Only a body that cannot fit even after every evictable version is
  // gone refuses (fail closed, readable error).
  maxVersionsPerAsset: 20,
  maxVersionBytes: 4 * 1024 * 1024,
};

// ---- immutable versions: rows, content-addressed blobs, refcounts ----
//
//   asset-version:<id>:<n>  = { n, at, size, sha256, by, summary? }  (no body)
//   asset-blob:<sha256>     = the body string (shared by every version with
//                             that content — an unchanged re-save adds a row
//                             and no blob)
//   asset-blob-ref:<sha256> = integer refcount (the last release deletes the blob)
//   asset-version-bytes     = integer total of live blob bytes (the cap's input)
//
// Every key is in the reserved `asset-` namespace (memory.js): unwritable
// through the model's memory_set and hidden from enumeration, like the bodies.
// The head pointer lives on the index row (`version`, `versionsTruncated`).
const versionKey = (id, n) => `asset-version:${id}:${n}`;
const blobKey = (sha) => `asset-blob:${sha}`;
const blobRefKey = (sha) => `asset-blob-ref:${sha}`;
const VERSION_BYTES_KEY = "asset-version-bytes";
const MAX_EVICTION_READS = 400; // bounded victim search per write

async function readVersionBytes(store) {
  const v = await store.getStrict(VERSION_BYTES_KEY).catch(() => null);
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}
async function adjustVersionBytes(store, delta) {
  const cur = await readVersionBytes(store);
  await store.setTrusted(VERSION_BYTES_KEY, Math.max(0, cur + delta));
}
async function readBlobRef(store, sha) {
  const v = await store.getStrict(blobRefKey(sha)).catch(() => null);
  return Number.isSafeInteger(v) && v > 0 ? v : 0;
}
async function readVersionRow(store, id, n) {
  const row = await store.getStrict(versionKey(id, n)).catch(() => null);
  if (!row || typeof row !== "object" || row.n !== n || typeof row.sha256 !== "string") return null;
  return row;
}

/** Plan (no writes) the version for `content`: its sha and whether a blob
 * already holds it. */
async function stageVersion(store, content, size) {
  const sha = sha256Hex(content);
  const ref = await readBlobRef(store, sha);
  return { sha, blobIsNew: ref === 0, size };
}

/** Write the staged version BEFORE the body mutation: blob → refcount → byte
 * accounting → row. The prepared WAL intent carries {newVersion, blobSha,
 * blobIsNew, blobSize}, so a crash anywhere in here is released by
 * `releaseStagedVersion` (recovery or the S3 compensation). */
async function writeVersion(store, id, n, content, staged, { by, summary, at }) {
  if (staged.blobIsNew) {
    await store.setTrusted(blobKey(staged.sha), content);
    await store.setTrusted(blobRefKey(staged.sha), 1);
    await adjustVersionBytes(store, staged.size);
  } else {
    await store.setTrusted(blobRefKey(staged.sha), (await readBlobRef(store, staged.sha)) + 1);
  }
  const row = { n, at, size: staged.size, sha256: staged.sha, by };
  if (typeof summary === "string" && summary) row.summary = summary.slice(0, 200);
  await store.setTrusted(versionKey(id, n), row);
  return row;
}

/** Release one reference to a blob; the last reference deletes it. */
async function releaseBlob(store, sha, size) {
  const ref = await readBlobRef(store, sha);
  if (ref <= 1) {
    await store.delete(blobKey(sha));
    await store.delete(blobRefKey(sha));
    await adjustVersionBytes(store, -(Number.isSafeInteger(size) ? size : 0));
  } else {
    await store.setTrusted(blobRefKey(sha), ref - 1);
  }
}

/** Drop one version row + its blob reference (idempotent). */
async function dropVersion(store, id, n) {
  const row = await readVersionRow(store, id, n);
  if (!row) return false;
  await store.delete(versionKey(id, n));
  await releaseBlob(store, row.sha256, row.size);
  return true;
}

/** Release everything an artifact's versions hold (delete / index eviction).
 * Walks down from the head; below the retention floor it stops at the first
 * absent row (earlier evictions already cleaned lower ones). */
async function dropAllVersions(store, id, head) {
  if (!Number.isSafeInteger(head) || head < 1) return;
  const floor = head - ASSET_BOUNDS.maxVersionsPerAsset;
  for (let k = head; k >= 1; k--) {
    const dropped = await dropVersion(store, id, k);
    if (!dropped && k <= floor) break;
  }
}

/** Compensate a staged (never committed) version from its WAL intent. */
async function releaseStagedVersion(store, intent) {
  if (intent?.newVersion == null) return;
  const dropped = await dropVersion(store, intent.id, intent.newVersion);
  if (dropped || !intent.blobIsNew || typeof intent.blobSha !== "string") return;
  // The row never landed but the blob/refcount may have. `blobIsNew` means no
  // reference existed before this intent, so anything present under the sha
  // is ours to release.
  const hasRef = (await readBlobRef(store, intent.blobSha)) > 0;
  const hasBlob = (await store.getStrict(blobKey(intent.blobSha)).catch(() => null)) != null;
  if (!hasRef && !hasBlob) return;
  await store.delete(blobKey(intent.blobSha));
  await store.delete(blobRefKey(intent.blobSha));
  if (hasRef) await adjustVersionBytes(store, -(intent.blobSize ?? 0));
}

/** Plan which versions the write at `id`/`n` (adding `addBytes` of new blob)
 * must evict to stay within the bounds. Reads only; the plan is applied
 * AFTER the commit. Marks every artifact that loses a version so the index
 * rows written by the SAME CAS carry `versionsTruncated`. Never evicts a
 * head. */
async function planVersionEvictions(store, index, { id, n, addBytes }) {
  const victims = [];
  const seen = new Set();
  const truncated = new Set();
  const take = (vid, k) => { victims.push({ id: vid, n: k }); seen.add(`${vid}:${k}`); truncated.add(vid); };
  // (a) the per-artifact count: everything at or below n - max goes; the scan
  // stops at the first absent row (lower ones were evicted by earlier writes).
  for (let k = n - ASSET_BOUNDS.maxVersionsPerAsset; k >= 1; k--) {
    if (!(await readVersionRow(store, id, k))) break;
    take(id, k);
  }
  // (b) the library-wide blob bytes: this artifact's oldest first, then the
  // oldest other artifacts' oldest versions.
  let total = (await readVersionBytes(store)) + addBytes;
  if (total > ASSET_BOUNDS.maxVersionBytes) {
    const others = index
      .filter((r) => r && r.id !== id && Number.isSafeInteger(r.version))
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const candidates = [{ id, version: n }, ...others];
    let reads = 0;
    outer: for (const r of candidates) {
      const head = r.version;
      for (let k = Math.max(1, head - ASSET_BOUNDS.maxVersionsPerAsset); k < head; k++) {
        if (reads++ >= MAX_EVICTION_READS) break outer;
        if (seen.has(`${r.id}:${k}`)) continue;
        const row = await readVersionRow(store, r.id, k);
        if (!row) continue;
        const ref = await readBlobRef(store, row.sha256);
        take(r.id, k);
        if (ref <= 1) total -= row.size;
        if (total <= ASSET_BOUNDS.maxVersionBytes) break outer;
      }
    }
    if (total > ASSET_BOUNDS.maxVersionBytes) {
      return { error: `artifact version storage is full (${ASSET_BOUNDS.maxVersionBytes} bytes) — delete artifacts to make room` };
    }
  }
  for (const r of index) {
    if (r && truncated.has(r.id)) r.versionsTruncated = true;
  }
  return { victims };
}

async function applyVersionEvictions(store, victims) {
  for (const v of victims ?? []) {
    try { await dropVersion(store, v.id, v.n); } catch { /* the next write's plan retries */ }
  }
}

export const ASSET_TYPES = new Set(["html", "text", "json", "image", "data"]);

// CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01 — the capacity policy.
//
// The library is the owner's accumulated work; silently dropping the OLDEST
// thing they made when a new row arrives is the wrong terminal behaviour for a
// store whose whole point is durability. So auto-eviction is REGENERABLE-ONLY:
// when a create would exceed the index byte bound, only rows the SYSTEM
// derives on a schedule — and can therefore regenerate — are rolled off
// (oldest first). If removing every regenerable row still does not fit, the
// create is REFUSED with `code: "library_full"` rather than dropping any
// owner-created artifact. Nothing owner-created ever leaves the library except
// via an explicit `asset.delete`.
//
// A row is regenerable iff its promotion key (`pk`) sits in one of these
// namespaces. These are the SYSTEM's own derived outputs (a scheduled report,
// a periodic tab snapshot) — never a model- or workspace-produced artifact,
// which is the owner's output and is filed under `model:` / `opfs:promote:`.
export const REGENERABLE_KEY_PREFIXES = ["scheduled-report:", "tab-list:"];

export function isRegenerableRow(row) {
  return typeof row?.pk === "string" && REGENERABLE_KEY_PREFIXES.some((p) => row.pk.startsWith(p));
}

// A per-origin asset mutex serializes EVERY index/body read-modify-write
// (reads AND writes — the re-review's read/list interleaving finding).
const assetLocks = new Map();
const MAX_ASSET_LOCKS = 256;
function withAssetLock(origin, fn) {
  // ONE store means ONE index, so every write serialises on a single chain.
  // Keeping a per-origin key here would let two origins interleave writes to
  // the same index; the CAS would catch it, but as a failure rather than as
  // the mutual exclusion the rest of this file is written to assume.
  const key = "library";
  const prev = (assetLocks.get(key)?.chain) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // The chain + a SETTLED flag (set when the chain finally lands) so the bound
  // can evict only finished chains (the reviewer's lock-eviction finding).
  const rec = { chain: next.catch(() => {}), settled: false };
  rec.chain.finally(() => { rec.settled = true; }).catch(() => {});
  assetLocks.set(key, rec);
  // Bound the map (the reviewer's finding: evicting ACTIVE chains breaks the
  // mutex) — only SETTLED chains are dropped (the settled flag is set in the
  // chain's finally); an active chain is retained even if the map exceeds the
  // bound (bounded by the number of distinct active origins, small in
  // practice).
  if (assetLocks.size > MAX_ASSET_LOCKS) {
    for (const [k, rec] of assetLocks) {
      if (k === key) continue;
      if (rec.settled) assetLocks.delete(k);
      if (assetLocks.size <= MAX_ASSET_LOCKS) break;
    }
  }
  return next;
}

// THE ARTIFACT LIBRARY IS ONE STORE (CAP-FB-20260828-ARTIFACT-DURABILITY-01).
//
// Artifacts used to be filed in the store of the origin that produced them, so
// `origin` selected the store. That had two consequences the owner named as
// exactly what the library exists to prevent: `agent.delete` clears a Site
// Agent's store, so deleting a Site Agent DESTROYED its artifacts; and the
// gallery only ever listed `origin:"master"`, so those artifacts were never
// visible in the library at all.
//
// Artifacts are the owner's accumulated work — a report written in one task is
// an input to a later task or a different agent — so their lifetime must not be
// coupled to any agent's or task's. `origin` is now PROVENANCE carried on the
// row (which it already was) and nothing more.
//
// This does not widen a read boundary: `asset.*` routes are only reachable from
// owner surfaces and the unscoped orchestrator — scoped (site/hook) runs get NO
// management tools (`scoped ? {} : managementToolset(...)`) — so no site agent
// could read another origin's artifacts before this change or after it.
function assetStore() {
  return masterMemory();
}

function canonical(origin) {
  return origin === "master" ? "master" : (canonicalOrigin(origin) ?? "master");
}

/** STRICT index read: a real read/corruption failure OR a malformed non-array
 * value THROWS — never treated as an empty index. */
async function readIndexStrict(store) {
  const value = await store.getStrict(INDEX_KEY);
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`asset index is corrupt: expected an array, got ${typeof value}`);
  }
  return value;
}

// Head rows written after the body-capacity change carry `sha256` (a
// reference to the content-addressed version blob that holds the COMPLETE
// body) and NO embedded content — a body can grow past the 256 KiB generic
// per-value bound, which an embedded head could never hold. LEGACY head rows
// (written before the change) still embed `content`; `readAssetContent` and
// `getAsset` serve both shapes. The head blob is the head VERSION's blob
// (every write stages its version first), so it is refcounted, byte-budgeted
// and never evicted while the row lives — exactly like today's bodies.
function boundAssetMeta({ type, name, content }, { allowBodyGrowth = false } = {}) {
  const at = type == null || type === "" ? "data" : String(type);
  if (!ASSET_TYPES.has(at)) return { error: `asset type must be one of ${[...ASSET_TYPES].join(", ")}` };
  const nm = String(name ?? "").trim();
  if (nm.length === 0) return { error: "asset needs a name" };
  if (nm.length > ASSET_BOUNDS.maxNameLength) return { error: `asset name exceeds ${ASSET_BOUNDS.maxNameLength} chars` };
  if (typeof content !== "string") return { error: "asset content must be a string" };
  const size = utf8Bytes(content);
  if (!allowBodyGrowth) {
    // The single-call bound: create_asset / update_asset / write_file carry one
    // COMPLETE body per call, so the advertised 256 KiB is the honest per-call
    // limit AND the full cap must actually store (the body lives in the blob
    // side of the head/version pair, which the memory store admits up to
    // maxBodySerializedBytes — CAP p45y r4).
    if (size > ASSET_BOUNDS.maxContentBytes) return { error: `asset content exceeds ${ASSET_BOUNDS.maxContentBytes} bytes` };
  } else if (utf8Bytes(JSON.stringify(content)) > ASSET_BOUNDS.maxBodySerializedBytes) {
    // The aggregate path (append/patch/restore on an already-grown body): the
    // body may exceed the single-call bound, but the blob write must still fit
    // the store's per-value bound — measured in the SAME unit the store uses.
    return { error: `asset body exceeds the ${ASSET_BOUNDS.maxBodySerializedBytes}-byte storage bound` };
  }
  return { ok: true, type: at, name: nm, size };
}

/** The COMPLETE body of a stored head row: legacy rows embed `content`; new
 * rows carry `sha256` and the body lives in the content-addressed blob.
 * Returns null when the head is a ref whose blob is missing (a repair in
 * progress) — callers fail closed on that, never silently empty. */
async function readAssetContent(store, value) {
  if (value == null || typeof value !== "object") return null;
  if (typeof value.content === "string") return value.content;
  if (typeof value.sha256 === "string") {
    const body = await store.getStrict(blobKey(value.sha256)).catch(() => null);
    return typeof body === "string" ? body : null;
  }
  return null;
}

/** S0→S7 — create. The shared core runs under the per-origin lock; `pk` is
 * the optional stable PROMOTION KEY (createAssetKeyed sets it — the exact-
 * token dedup record in the row). The wrapper never calls this unkeyed path
 * for promotion (a retry would create a duplicate). */
async function createAssetLocked(store, origin, o, { type, name, content, meta, pk, by, summary }) {
  const bounded = boundAssetMeta({ type, name, content });
  if (bounded.error) return { ok: false, error: bounded.error };
  const id = newId("a");
  const now = Date.now();
  const asset = {
    id, type: bounded.type, name: bounded.name, origin: o,
    createdAt: now, updatedAt: now, size: bounded.size, content, meta: meta ?? {},
  };
  await recoverTx(store); // crash recovery (the durable WAL)
  await repairPendingLocked(store, origin);
  const index = await readIndexStrict(store); // S0
  // The cap stays PER ORIGIN even though the index is now shared: it exists to
  // stop one noisy producer filling the library, and counting the whole library
  // against a single origin would let any one origin be starved by the others.
  if (index.filter((r) => r.origin === o).length >= ASSET_BOUNDS.maxAssetsPerOrigin) {
    return { ok: false, error: `asset limit reached (${ASSET_BOUNDS.maxAssetsPerOrigin})` };
  }
  const idxGen = await store.getVersion(INDEX_KEY);
  const row = {
    id, type: bounded.type, name: bounded.name, origin: o, at: now, size: bounded.size,
    ...(pk ? { pk } : {}),
    version: 1, versionsTruncated: false,
  };
    const next = [...index, row];
    let idx = next;
    if (utf8Bytes(JSON.stringify(idx)) > ASSET_BOUNDS.maxIndexBytes) {
      // At capacity. Reclaim space by rolling ONLY regenerable derived rows
      // (oldest first) — never the owner's own artifacts, and never the row
      // being created. If nothing regenerable is left to drop, REFUSE rather
      // than silently discarding the owner's oldest work
      // (CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01).
      idx = next.slice();
      for (let i = 0; i < idx.length && utf8Bytes(JSON.stringify(idx)) > ASSET_BOUNDS.maxIndexBytes;) {
        if (idx[i].id !== id && isRegenerableRow(idx[i])) {
          idx.splice(i, 1);
        } else {
          i++;
        }
      }
      if (utf8Bytes(JSON.stringify(idx)) > ASSET_BOUNDS.maxIndexBytes) {
        // No owner artifact is dropped — the create fails honestly so the owner
        // can delete something (the library UI shows the capacity indicator).
        return {
          ok: false,
          code: "library_full",
          error: `the artifact library is full (${ASSET_BOUNDS.maxIndexBytes} bytes) — delete an artifact to make room`,
        };
      }
    }
    const dropped = next.filter((r) => !idx.some((k) => k.id === r.id));
    // Version 1 is staged (planned, not written) here; the plan's evictions
    // land on the rows the index CAS writes.
    const staged = await stageVersion(store, content, bounded.size);
    const versionFields = { newVersion: 1, blobSha: staged.sha, blobIsNew: staged.blobIsNew, blobSize: staged.size };
    const plan = await planVersionEvictions(store, idx, { id, n: 1, addBytes: staged.blobIsNew ? staged.size : 0 });
    if (plan.error) return { ok: false, error: plan.error };
    // S1 — record the eviction obligations DURABLY BEFORE any commit, WITH the
    // evicted bodies' EXACT tokens (captured here — the repair can then clean
    // by checked token, never an unconditional delete).
    const droppedIds = dropped.map((r) => r.id);
    const droppedTokens = new Map();
    for (const did of droppedIds) {
      droppedTokens.set(did, await store.getVersion(`asset:${did}`));
    }
    if (droppedIds.length) {
      await recordRepairEntry(store, (repair) => {
        let added = false;
        for (const did of droppedIds) {
          if (!repair.pendingDeletes.some((d) => d.id === did)) {
            if (repair.pendingDeletes.length >= REPAIR_BOUNDS.maxPendingDeletes) {
              throw new Error("asset repair queue is full — surface the failure");
            }
            repair.pendingDeletes.push({ id: did, bodyGen: droppedTokens.get(did) ?? null });
            added = true;
          }
        }
        return added;
      });
    }
    const removeObligations = async () => {
      if (!droppedIds.length) return;
      await recordRepairEntry(store, (repair) => {
        const before = repair.pendingDeletes.length;
        repair.pendingDeletes = repair.pendingDeletes.filter((d) => !droppedIds.includes(d.id));
        return repair.pendingDeletes.length !== before;
      });
    };
    // S2 — WRITE THE DURABLE WAL INTENT (prepared) BEFORE the body write; a
    // crash at any await is recovered by exact tokens.
    await writeWal(store, { op: "create", id, bodyGen: null, idxGen, newIndex: idx, droppedIds, ...versionFields, state: "prepared" });
    // S2b — write version 1 (blob + refcount + row) BEFORE the body; the
    // prepared intent above carries exactly what was staged, so a crash here
    // is released by recovery.
    let bodyGen;
    try {
      await writeVersion(store, id, 1, content, staged, { by: by === "owner" ? "owner" : "model", summary, at: now });
      // S3 — write the body row (capture the exact write's version token); the
      // exact-token WAL record MUST land — a failure compensates the body by its
      // exact token (the reviewer's body→token gap). The head row carries a
      // REFERENCE to the content-addressed blob (`sha256`) instead of the body:
      // a body at the full advertised cap (or grown past it by appends) can
      // never fit a single JSON value, and the blob is already the durable,
      // refcounted home of the content.
      bodyGen = await store.setTrusted(`asset:${id}`, { ...asset, content: undefined, sha256: staged.sha });
    } catch (e) {
      await releaseStagedVersion(store, { id, ...versionFields }).catch(() => {});
      await removeObligations().catch(() => {});
      await writeWal(store, { op: "create", id, bodyGen: null, idxGen, newIndex: idx, droppedIds, ...versionFields, state: "compensated" }).catch(() => {});
      await clearWal(store).catch(() => {});
      throw e;
    }
    try {
      await writeWal(store, { op: "create", id, bodyGen, idxGen, newIndex: idx, droppedIds, ...versionFields, state: "prepared" });
    } catch (e) {
      await store.compareAndDelete(`asset:${id}`, bodyGen).catch(() => {});
      throw e;
    }
    // S3 — CAS the index (CHECKED).
    let casOk;
    try {
      casOk = await store.compareAndRestore(INDEX_KEY, idxGen, idx);
    } catch (e) {
      // A CAS that COMMITTED its bytes then threw on close is still committed —
      // reread the index strictly (the reviewer's close-throw finding).
      let committed = false;
      try {
        const cur = await readIndexStrict(store);
        committed = cur.some((r) => r.id === id);
      } catch { committed = false; }
      if (!committed) {
        // S6 — compensate with the EXACT-write delete + drop the obligations.
        await removeObligations();
        await store.compareAndDelete(`asset:${id}`, bodyGen).catch(() => {});
        await releaseStagedVersion(store, { id, ...versionFields }).catch(() => {});
        await writeWal(store, { op: "create", id, bodyGen, idxGen, newIndex: idx, droppedIds, ...versionFields, state: "compensated" });
        await clearWal(store).catch(() => {});
      }
      throw e; // the caller observes the failure; the WAL/recovery state is consistent
    }
    if (casOk === false) {
      // S5 — a concurrent writer won: the obligations no longer apply; the
      // body is cleaned by its EXACT token + the intent is compensated.
      await removeObligations();
      await store.compareAndDelete(`asset:${id}`, bodyGen).catch(() => {});
      await releaseStagedVersion(store, { id, ...versionFields }).catch(() => {});
      await writeWal(store, { op: "create", id, bodyGen, idxGen, newIndex: idx, droppedIds, ...versionFields, state: "compensated" });
      await clearWal(store);
      return { ok: false, error: "concurrent asset write — retry" };
    }
    // S4 — mark committed (durable) BEFORE the mirror; a mirror failure
    // CAS-ROLLS BACK the index against the EXACT post-CAS token (never a later
    // getVersion — the reviewer's finding 5); the body is deleted ONLY if the
    // rollback landed.
    const postIdxGen = casOk; // the CAS returns THIS write's exact token
    await writeWal(store, { op: "create", id, bodyGen, idxGen, postIdxGen, newIndex: idx, droppedIds, state: "committed" });
    try {
      const repair = await readRepair(store);
      repair.lastGoodIndex = idx;
      await writeRepair(store, repair);
    } catch (e) {
      const rollback = await store.compareAndRestore(INDEX_KEY, postIdxGen, index).catch(() => false);
      if (rollback !== false) {
        await store.compareAndDelete(`asset:${id}`, bodyGen).catch(() => {});
        await releaseStagedVersion(store, { id, ...versionFields }).catch(() => {});
      }
      await removeObligations();
      await writeWal(store, { op: "create", id, bodyGen, idxGen, postIdxGen, newIndex: idx, droppedIds, ...versionFields, state: "compensated" });
      throw e;
    } finally {
      await clearWal(store).catch(() => {});
    }
    // The planned version evictions (bounds) land after the commit; a crash
    // here is re-planned by the next write.
    await applyVersionEvictions(store, plan.victims);
    // S7 — cleanup the evicted bodies: the CURRENT index is authoritative — a
    // row still referenced is never deleted.
    if (dropped.length) {
      // The CURRENT index is authoritative — a row still referenced is never
      // deleted; the removed bodies are cleaned by their EXACT tokens with a
      // checked CAS.
      let curIndex = null;
      try {
        curIndex = await readIndexStrict(store);
      } catch {
        curIndex = null; // indeterminate — the obligations stay pending (fail closed)
      }
      const refs = new Set((curIndex ?? []).map((r) => r.id));
      const removed = [];
      for (const r of dropped) {
        if (refs.has(r.id)) continue;
        const tok = droppedTokens.get(r.id);
        if (tok == null) continue; // no exact token — keep the obligation
        try {
          const ok = await store.compareAndDelete(`asset:${r.id}`, tok);
          if (ok !== false) removed.push(r.id);
        } catch { /* stays pending */ }
        // An evicted artifact's versions go with it (best effort; an orphan
        // row is unreachable without its index row and bounded by its count).
        await dropAllVersions(store, r.id, r.version).catch(() => {});
      }
      if (removed.length) {
        await recordRepairEntry(store, (repair) => {
          const before = repair.pendingDeletes.length;
          repair.pendingDeletes = repair.pendingDeletes.filter((d) => !removed.includes(d.id));
          return repair.pendingDeletes.length !== before;
        });
      }
    }
    return { ok: true, asset: { ...asset, content: undefined }, index: idx, version: 1 };
}

/** S0→S7 — create (the UNKEYED path; never used for workspace promotion). */
export async function createAsset(origin, { type, name, content, meta }) {
  const store = assetStore();
  const o = canonical(origin);
  const bounded = boundAssetMeta({ type, name, content });
  if (bounded.error) return { ok: false, error: bounded.error };
  return withAssetLock(origin, async () => createAssetLocked(store, origin, o, { type, name, content, meta, pk: null }));
}

/** The KEYED create — the promotion idempotency entry (the reviewed v3 §8
 * exact-token dedup). A retry with the SAME stable key returns the SAME asset:
 * the prior row's `pk` is the dedup record and the body must still exist at a
 * valid token. CALLER CONTRACT: the key must bind the full operation identity,
 * including a digest of the already-bounded content. This function deliberately
 * does not compare retry content after a key match; a digest-free caller key
 * would make different content look like the same operation. The OPFS workspace
 * follows this contract. The create runs under the per-origin lock + the durable
 * __tx WAL — a crash at any await is recovered by exact tokens (prepared →
 * committed | compensated), never a direct index edit. */
export async function createAssetKeyed(origin, { key, type, name, content, meta }) {
  if (typeof key !== "string" || !key || key.length > ASSET_BOUNDS.maxNameLength) {
    return { ok: false, error: "promotion key must be a non-empty string" };
  }
  const store = assetStore();
  const o = canonical(origin);
  const bounded = boundAssetMeta({ type, name, content });
  if (bounded.error) return { ok: false, error: bounded.error };
  return withAssetLock(origin, async () => {
    await recoverTx(store); // a crashed keyed create resolves BEFORE the dedup scan
    await repairPendingLocked(store, origin);
    const index = await readIndexStrict(store);
    const prior = index.find((r) => r.pk === key);
    if (prior) {
      // EXACT-TOKEN dedup: the row is the record; the body must still exist.
      const v = await store.getVersion(`asset:${prior.id}`).catch(() => 0);
      if (v != null && v > 0) {
        const asset = await store.get(`asset:${prior.id}`);
        const content = await readAssetContent(store, asset);
        if (typeof content !== "string") {
          // A ref-head whose blob is missing is a repair-in-progress/corruption
          // state — FAIL CLOSED (never a silent duplicate row under the key).
          return { ok: false, error: "promotion body missing — repair in progress" };
        }
        return { ok: true, deduped: true, id: prior.id, asset: { ...asset, content } };
      }
      // A row with the key but NO body is a repair-in-progress/corruption
      // state — FAIL CLOSED (never a silent duplicate row under the same key).
      return { ok: false, error: "promotion body missing — repair in progress" };
    }
    const res = await createAssetLocked(store, origin, o, { type, name, content, meta, pk: key });
    if (res?.ok && res.id == null) res.id = res.asset?.id;
    return res;
  });
}

/** S0→S3 — update (the exact-write compensation: the restored body is guarded
 * by the NEW body's version token, so a repair can actually complete). */
export async function updateAsset(origin, id, patch, opts = {}) {
  const store = assetStore();
  if (!id || typeof id !== "string") return { ok: false, error: "update_asset needs an id" };
  return withAssetLock(origin, async () => updateAssetLocked(store, origin, id, patch, opts));
}

/** The S0→S3 compensated-update body (shared by updateAsset + the keyed
 * create-or-update); the caller holds the origin lock. */
async function updateAssetLocked(store, origin, id, patch, opts = {}) {
  const by = opts.by === "owner" ? "owner" : "model";
  await recoverTx(store); // crash recovery (the durable WAL — FAILS closed)
  await repairPendingLocked(store, origin);
  const existing = await store.get(`asset:${id}`); // S0
  if (!existing) return { ok: false, error: "asset not found" };
  const existingContent = await readAssetContent(store, existing);
  const nextType = patch.type ?? existing.type;
  const nextName = patch.name ?? existing.name;
  const nextContent = patch.content ?? existingContent;
  if (typeof nextContent !== "string") {
    return { ok: false, error: "asset body missing — repair in progress" };
  }
  // The aggregate write path (append/patch/restore on a body that may exceed
  // the single-call bound) validates against the BLOB storage bound instead of
  // the 256 KiB single-call cap; a single-call update_asset is still transport-
  // capped at maxContentBytes by the tool argument contract.
  const meta = boundAssetMeta({ type: nextType, name: nextName, content: nextContent }, { allowBodyGrowth: true });
  if (meta.error) return { ok: false, error: meta.error };
  const updated = {
    ...existing, type: meta.type, name: meta.name, content: nextContent,
    size: meta.size, updatedAt: Date.now(),
  };
  const index = await readIndexStrict(store);
  const i = index.find((e) => e.id === id);
  if (!i) {
    try { await store.setTrusted(`asset:${id}`, existing); } catch { /* store failing */ }
    return { ok: false, error: "asset is not indexed — update refused" };
  }
  const idxGen = await store.getVersion(INDEX_KEY);
  // The next immutable version (CAP-FB-20260830-ARTIFACT-VERSIONS-01): a
  // legacy row without a head pointer starts its history here.
  const n = (Number.isSafeInteger(i.version) && i.version > 0 ? i.version : 0) + 1;
  const staged = await stageVersion(store, nextContent, meta.size);
  const versionFields = { newVersion: n, blobSha: staged.sha, blobIsNew: staged.blobIsNew, blobSize: staged.size };
  const oldRow = { ...i };
  const plan = await planVersionEvictions(store, index, { id, n, addBytes: staged.blobIsNew ? staged.size : 0 });
  if (plan.error) return { ok: false, error: plan.error };
  // S1 — WRITE THE DURABLE WAL INTENT (prepared) BEFORE the body mutation.
  // The intent carries the OLD body + BOTH rows (old + new) + the exact
  // tokens + the staged version — a write failure (e.g. the old body + rows
  // exceed the value cap) REJECTS the update BEFORE any mutation: the
  // compensation capacity is RESERVED (the reviewer's finding — the old body
  // must never be lost).
  const walIntent = {
    op: "update", id,
    oldBody: existing, oldBodyGen: await store.getVersion(`asset:${id}`),
    oldRow, newRow: { ...i, type: meta.type, name: meta.name, size: meta.size, version: n },
    idxGen, ...versionFields, state: "prepared",
  };
  await writeWal(store, walIntent); // throws (over-cap) → the update rejects
  // S2a — write the version (blob + refcount + row) BEFORE the body; S2b —
  // write the new body; the returned version is the EXACT write token. A
  // throw in either releases what was staged (the old body is untouched
  // until S2b lands, and a failed S2b leaves it in place).
  let newBodyGen;
  try {
    await writeVersion(store, id, n, nextContent, staged, { by, summary: opts.summary, at: updated.updatedAt });
    // S2b — the new head row: same reference shape as create (blob sha, no
    // embedded content) — small, token-CAS-able, and never over the per-value
    // bound however large the body grew.
    newBodyGen = await store.setTrusted(`asset:${id}`, { ...updated, content: undefined, sha256: staged.sha });
  } catch (e) {
    await releaseStagedVersion(store, walIntent).catch(() => {});
    await writeWal(store, { ...walIntent, state: "compensated" }).catch(() => {});
    await clearWal(store).catch(() => {});
    throw e;
  }
  i.type = meta.type;
  i.name = meta.name;
  i.size = meta.size;
  i.version = n;
  if (i.versionsTruncated !== true) i.versionsTruncated = false;
  // S2 — CAS the index (CHECKED).
  let casOk;
  try {
    casOk = await store.compareAndRestore(INDEX_KEY, idxGen, index);
  } catch {
    // A CAS whose bytes COMMITTED then threw on close is still committed:
    // strictly reread the index TOKEN + the row CONTENT (the reviewer's
    // update close-throw finding — no row/body divergence).
    casOk = false;
    try {
      const curIdx = await readIndexStrict(store);
      const row = curIdx.find((r) => r.id === id);
      if (row && JSON.stringify(row) === JSON.stringify(index.find((r) => r.id === id))) {
        casOk = await store.getVersion(INDEX_KEY);
      }
    } catch { casOk = false; }
  }
  if (casOk === false) {
    // S3 — restore the prior body guarded by the NEW body's version.
    let restored;
    try {
      restored = await store.compareAndRestore(`asset:${id}`, newBodyGen, existing);
    } catch {
      restored = false; // a CAS commit-then-close-throw is reread below
    }
    if (restored === false) {
      // The restore may have COMMITTED despite a close throw — reread the
      // exact CONTENT.
      const curBody = await store.getStrict(`asset:${id}`).catch(() => null);
      if (curBody && JSON.stringify(curBody) === JSON.stringify(existing)) restored = true;
    }
    if (restored === false) {
      // Record a DURABLE restore with the NON-NULL versions so the repair
      // can complete — the mutation already happened, so a failure to record
      // FAILS CLOSED (the WAL intent stays prepared for the recovery).
      await recordRepairEntry(store, (repair) => {
        if (repair.pendingRestores.some((r) => r.id === id)) return false;
        if (repair.pendingRestores.length >= REPAIR_BOUNDS.maxPendingRestores) {
          throw new Error("asset repair queue is full — surface the failure");
        }
        repair.pendingRestores.push({ id, row: oldRow, body: existing, bodyVersion: newBodyGen, indexVersion: idxGen });
        return true;
      });
    }
    // S3 — the staged version goes with the failed update (no orphan row, the
    // blob refcount back where it was).
    await releaseStagedVersion(store, walIntent).catch(() => {});
    await writeWal(store, { op: "update", id, newBodyGen, row: i, idxGen, ...versionFields, state: "compensated" });
    await clearWal(store).catch(() => {});
    return { ok: false, error: "concurrent asset write — retry" };
  }
  await writeWal(store, { op: "update", id, newBodyGen, row: i, idxGen, postIdxGen: casOk, newIndex: index, state: "committed" });
  // The LAST-GOOD index mirrors the committed mutation (the reviewer's
  // finding: only create refreshed it — a later heal must never restore
  // stale update metadata). If this write fails, the committed WAL stays (it
  // carries newIndex) and the NEXT operation's recovery persists the mirror —
  // never a silently-stale lastGood.
  try {
    const repair = await readRepair(store);
    repair.lastGoodIndex = index;
    await writeRepair(store, repair);
  } catch { /* the committed WAL completes the mirror via recovery */ return { ok: true, asset: { ...updated, content: undefined }, version: n }; }
  await clearWal(store).catch(() => {});
  await applyVersionEvictions(store, plan.victims);
  return { ok: true, asset: { ...updated, content: undefined }, version: n };
}

/** The CREATE-OR-UPDATE keyed path — the model-facing idempotency entry
 * (CAP-FB-20260823-FIRST-RUN-DUPLICATE-TEST-ASSET-01). A key that already
 * exists in the origin's index finds that EXACT row and UPDATES it in place
 * (find-then-update via the keyed lookup — a repeated or interrupted first
 * run can never duplicate the artifact); a key that does not exist creates
 * exactly one row carrying the key (pk). The key grammar is caller-checked
 * (normalizeModelAssetKey at the route) and the `model:` namespace keeps
 * these rows disjoint from workspace promotion keys (`opfs:promote:`). */
export async function createOrUpdateAssetKeyed(origin, { key, type, name, content, meta }) {
  if (typeof key !== "string" || !key || key.length > ASSET_BOUNDS.maxNameLength) {
    return { ok: false, error: "asset key must be a non-empty bounded string" };
  }
  const store = assetStore();
  const o = canonical(origin);
  const bounded = boundAssetMeta({ type, name, content });
  if (bounded.error) return { ok: false, error: bounded.error };
  return withAssetLock(origin, async () => {
    await recoverTx(store);
    await repairPendingLocked(store, origin);
    const index = await readIndexStrict(store);
    const prior = index.find((r) => r.pk === key);
    if (prior) {
      const v = await store.getVersion(`asset:${prior.id}`).catch(() => 0);
      if (v == null || v <= 0) {
        return { ok: false, error: "keyed asset body missing — repair in progress" };
      }
      const res = await updateAssetLocked(store, origin, prior.id, { type, name, content });
      if (res?.ok === true) return { ...res, id: prior.id, updated: true };
      return res;
    }
    const res = await createAssetLocked(store, origin, o, { type, name, content, meta, pk: key });
    if (res?.ok && res.id == null) res.id = res.asset?.id;
    if (res?.ok === true) return { ...res, created: true };
    return res;
  });
}

/** The bounded model-facing key grammar (checked at the ROUTE). `model:` is
 * prefixed by the route so these keys can never collide with `opfs:promote:`
 * promotion keys or any future authority-owned namespace. */
export function normalizeModelAssetKey(key) {
  if (typeof key !== "string") return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._\-]{0,63}$/.test(key)) return null;
  return key.trim() === "" ? null : `model:${key}`;
}

/** S0→S3 — delete (the body is removed by the EXACT-write CAS token; a failure
 * CAS-restores the row; a double failure is recorded durably). */
export async function deleteAsset(origin, id) {
  const store = assetStore();
  if (!id || typeof id !== "string") return { ok: false, error: "delete_asset needs an id" };
  return withAssetLock(origin, async () => {
    await recoverTx(store); // crash recovery (the durable WAL)
    await repairPendingLocked(store, origin);
    const index = await readIndexStrict(store); // S0
    const row = index.find((e) => e.id === id);
    const remaining = index.filter((e) => e.id !== id);
    if (!row) return { ok: false, error: "asset not found" };
    const idxGen = await store.getVersion(INDEX_KEY);
    const bodyGen = await store.getVersion(`asset:${id}`);
    // S1 — WRITE THE DURABLE WAL INTENT (prepared) BEFORE the index CAS.
    await writeWal(store, { op: "delete", id, bodyGen, idxGen, index, state: "prepared" });
    // S2 — CAS the index (row removed) — the returned value is the EXACT
    // post-CAS token (the compensation matches it, never a later getVersion).
    let casOk;
    try {
      casOk = await store.compareAndRestore(INDEX_KEY, idxGen, remaining);
    } catch {
      // A CAS that committed its bytes then threw on close is still committed.
      casOk = false;
      try {
        const cur = await readIndexStrict(store);
        if (!cur.some((r) => r.id === id)) casOk = await store.getVersion(INDEX_KEY);
      } catch { casOk = false; }
    }
    if (casOk === false) {
      await writeWal(store, { op: "delete", id, bodyGen, idxGen, index, state: "compensated" });
      await clearWal(store).catch(() => {});
      return { ok: false, error: "concurrent asset write — retry" };
    }
    const postIdxGen = casOk;
    // S3 — delete the body by its EXACT write token (a newer body is never
    // deleted).
    let deleted = false;
    try {
      deleted = (await store.compareAndDelete(`asset:${id}`, bodyGen)) !== false;
    } catch { deleted = false; }
    if (deleted) {
      await writeWal(store, { op: "delete", id, bodyGen, idxGen, index, postIdxGen, newIndex: remaining, state: "committed" });
      // The versions go with the artifact, inside the committed intent: a
      // crash here leaves the committed WAL, and recovery redoes the release.
      await dropAllVersions(store, id, row.version);
      try {
        const repair = await readRepair(store);
        repair.lastGoodIndex = remaining;
        await writeRepair(store, repair);
      } catch { /* the committed WAL completes the mirror via recovery */ return { ok: true }; }
      await clearWal(store).catch(() => {});
      return { ok: true };
    }
    // S4 — the body could not be removed: CAS-restore the row against the
    // EXACT post-CAS token.
    const restored = await store.compareAndRestore(INDEX_KEY, postIdxGen, index).catch(() => false);
    if (restored === false) {
      await recordRepairEntry(store, (repair) => {
        if (repair.pendingRestores.some((r) => r.id === id)) return false;
        if (repair.pendingRestores.length >= REPAIR_BOUNDS.maxPendingRestores) {
          throw new Error("asset repair queue is full — surface the failure");
        }
        repair.pendingRestores.push({ id, row, body: null, bodyVersion: null, indexVersion: postIdxGen });
        return true;
      });
    }
    await writeWal(store, { op: "delete", id, bodyGen, idxGen, index, postIdxGen, state: "compensated" });
    await clearWal(store).catch(() => {});
    return { ok: false, error: "asset body removal failed — retry" };
  });
}

/** Read one asset (with its content). Reads run under the per-origin mutex so
 * they never observe a split write (the re-review's interleaving finding).
 * New head rows reference the body's blob (`sha256`); the content is composed
 * here so every caller (routes, gallery, inspector) sees the complete body.
 * Legacy rows (embedded `content`) are served unchanged. */
export async function getAsset(origin, id) {
  if (!id || typeof id !== "string") return { ok: false, error: "get_asset needs an id" };
  return withAssetLock(origin, async () => {
    const store = assetStore();
    const asset = await store.get(`asset:${id}`);
    if (!asset) return { ok: false, error: "asset not found" };
    if (typeof asset.sha256 === "string") {
      const content = await readAssetContent(store, asset);
      if (typeof content !== "string") {
        return { ok: false, error: "asset body missing — repair in progress" };
      }
      return { ok: true, asset: { ...asset, content } };
    }
    return { ok: true, asset };
  });
}

/** The immutable version rows of one artifact (newest last): `{n, at, size,
 * sha256, by, summary?}` — never a body. `head` is the current version,
 * `truncated` whether older versions were evicted under the bounds. */
export async function listAssetVersions(origin, id) {
  if (!id || typeof id !== "string") return { ok: false, error: "asset.versions needs an id" };
  return withAssetLock(origin, async () => {
    const store = assetStore();
    let index;
    try { index = await readIndexStrict(store); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    const row = index.find((r) => r.id === id);
    if (!row) return { ok: false, error: "asset not found" };
    const head = Number.isSafeInteger(row.version) && row.version > 0 ? row.version : 0;
    const versions = [];
    for (let k = Math.max(1, head - ASSET_BOUNDS.maxVersionsPerAsset + 1); k <= head; k++) {
      const v = await readVersionRow(store, id, k);
      if (v) versions.push(v);
    }
    return { ok: true, id, head, truncated: row.versionsTruncated === true, versions };
  });
}

/** One version's body + sha256 (an evicted or unknown version fails closed). */
export async function getAssetVersion(origin, id, n) {
  if (!id || typeof id !== "string") return { ok: false, error: "asset.version-get needs an id" };
  if (!Number.isSafeInteger(n) || n < 1) return { ok: false, error: "asset.version-get needs a version number" };
  return withAssetLock(origin, async () => {
    const store = assetStore();
    const row = await readVersionRow(store, id, n);
    if (!row) return { ok: false, error: "version not found" };
    const content = await store.getStrict(blobKey(row.sha256)).catch(() => null);
    if (typeof content !== "string") return { ok: false, error: "version body missing" };
    return { ok: true, id, version: row, content, sha256: row.sha256 };
  });
}

/** Restore version `n` as a NEW head version (never a rewind): the same
 * S0→S3 compensated update as any edit, with the restored body and
 * `by:"owner"` (or `"model"`, behind the approval card). */
export async function restoreAssetVersion(origin, id, n, opts = {}) {
  if (!id || typeof id !== "string") return { ok: false, error: "asset.restore needs an id" };
  if (!Number.isSafeInteger(n) || n < 1) return { ok: false, error: "asset.restore needs a version number" };
  const store = assetStore();
  return withAssetLock(origin, async () => {
    const row = await readVersionRow(store, id, n);
    if (!row) return { ok: false, error: "version not found" };
    const content = await store.getStrict(blobKey(row.sha256)).catch(() => null);
    if (typeof content !== "string") return { ok: false, error: "version body missing" };
    const res = await updateAssetLocked(store, origin, id, { content }, { by: opts.by, summary: `restored v${n}` });
    return res?.ok ? { ...res, restoredFrom: n } : res;
  });
}

// ---- patch (exact search/replace) editing (CAP-FB-20260830-PATCH-ASSET-TOOL-01) ----
// The maximum number of edits one patch may carry (also enforced by the model
// tool's Zod schema; the seam re-checks so a direct/route caller cannot exceed it).
export const PATCH_MAX_EDITS = 20;

/** First N chars of a search string for a "not found" message — bounded and
 * single-line so a failed patch never echoes the whole body back to the model
 * (and never leaks another artifact: this is the caller's own search text). */
function patchSnippet(s) {
  const oneLine = String(s ?? "").replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/** PURE resolver: apply exact-substring search/replace edits to `oldBody` in
 * order and return the new body, or a readable, fail-closed error. Each search
 * must occur exactly once in the CURRENT working text unless `all` is set (then
 * every occurrence is replaced). Zero matches or an ambiguous (>1) match without
 * `all` is refused WITHOUT partial application. Shared by `patchAsset` (the
 * authoritative apply under the lock) and the `asset.patch` route (the approval
 * preview), so the two can never diverge. No store, no I/O. */
export function resolveAssetPatch(oldBody, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: "patch_asset needs at least one edit" };
  }
  if (edits.length > PATCH_MAX_EDITS) {
    return { ok: false, error: `patch_asset accepts at most ${PATCH_MAX_EDITS} edits per call` };
  }
  let body = typeof oldBody === "string" ? oldBody : "";
  for (const edit of edits) {
    const search = edit?.search;
    const replace = edit?.replace ?? "";
    if (typeof search !== "string" || search.length === 0) {
      return { ok: false, error: "each edit needs a non-empty search string" };
    }
    if (typeof replace !== "string") {
      return { ok: false, error: "each edit's replace must be a string" };
    }
    // Count NON-OVERLAPPING occurrences with indexOf in the current working body.
    let count = 0;
    for (let from = 0; ; ) {
      const idx = body.indexOf(search, from);
      if (idx === -1) break;
      count++;
      from = idx + search.length;
    }
    if (count === 0) {
      return { ok: false, error: `search text not found: ${patchSnippet(search)}` };
    }
    if (count > 1 && edit.all !== true) {
      return { ok: false, error: `search text matches ${count} times; add all:true or make it unique` };
    }
    if (edit.all === true) {
      body = body.split(search).join(replace);
    } else {
      const at = body.indexOf(search);
      body = body.slice(0, at) + replace + body.slice(at + search.length);
    }
  }
  return { ok: true, content: body };
}

/** The per-call append bound (exported for the tools + the contract tests):
 * one append carries at most 64 KiB of UTF-8 text; an artifact body grows
 * across calls up to ASSET_BOUNDS.maxBodySerializedBytes. */
export const APPEND_MAX_BYTES = ASSET_BOUNDS.maxAppendBytes;

/** S0→S3 — append `text` to an artifact's body as a NEW head version (the
 * model's chunked write path: CAP p45y acceptance B — a body larger than any
 * single-call bound is built across bounded calls instead of one giant tool
 * argument). Runs the SAME compensated update as any edit (WAL + immutable
 * version + head reference via updateAssetLocked), so the store contract is
 * shared. `expectVersion`, when supplied, refuses a stale append (the head has
 * moved since the model last saw the body) — mirrors patch_asset. The owner
 * approval for a model-initiated append is the caller's (the `asset.append`
 * route, action class asset.update); this seam is authoritative but unguarded,
 * exactly like updateAsset. */
export async function appendAsset(origin, id, text, opts = {}) {
  if (!id || typeof id !== "string") return { ok: false, error: "append_asset needs an existing id (use list_assets)" };
  if (typeof text !== "string" || text.length === 0) return { ok: false, error: "append_asset needs the text to append" };
  if (utf8Bytes(text) > APPEND_MAX_BYTES) {
    return { ok: false, error: `one append carries at most ${APPEND_MAX_BYTES} UTF-8 bytes (append in pieces)` };
  }
  const store = assetStore();
  return withAssetLock(origin, async () => {
    const existing = await store.get(`asset:${id}`);
    if (!existing) return { ok: false, error: "asset not found" };
    if (opts.expectVersion !== undefined && opts.expectVersion !== null) {
      let index;
      try { index = await readIndexStrict(store); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
      const row = index.find((e) => e.id === id);
      const head = Number.isSafeInteger(row?.version) && row.version > 0 ? row.version : 0;
      if (opts.expectVersion !== head) {
        return { ok: false, error: "version_conflict", version: head };
      }
    }
    const body = await readAssetContent(store, existing);
    if (typeof body !== "string") return { ok: false, error: "asset body missing — repair in progress" };
    const res = await updateAssetLocked(store, origin, id, { content: body + text }, {
      by: opts.by, summary: opts.summary ?? `appended ${utf8Bytes(text)} bytes`,
    });
    if (!res?.ok) return res;
    return {
      ok: true, id, asset: res.asset, version: res.version,
      appendedBytes: utf8Bytes(text), totalBytes: utf8Bytes(body) + utf8Bytes(text),
    };
  });
}

/** Apply exact search/replace `edits` to an artifact and commit the result as a
 * NEW head version — the cheap alternative to `update_asset` resending the whole
 * body (CAP-FB-20260830-PATCH-ASSET-TOOL-01). Runs the SAME S0→S3 compensated
 * update as any edit (WAL + immutable version via `updateAssetLocked`), so the
 * store contract is shared. `expectVersion`, when supplied, refuses a stale edit
 * (the head has moved since the model last saw the body) with `version_conflict`
 * and the current head, WITHOUT mutating. Returns `{ok, id, asset, version,
 * added, removed}` with the line delta from the shared diff core. The owner
 * approval for a model-initiated patch is the caller's (the `asset.patch` route);
 * this seam is authoritative but unguarded, exactly like `updateAsset`. */
export async function patchAsset(origin, id, edits, opts = {}) {
  if (!id || typeof id !== "string") return { ok: false, error: "patch_asset needs an existing id (use list_assets)" };
  const store = assetStore();
  return withAssetLock(origin, async () => {
    const existing = await store.get(`asset:${id}`);
    if (!existing) return { ok: false, error: "asset not found" };
    const oldBody = (await readAssetContent(store, existing)) ?? "";
    // expectVersion guards against editing a body the model has not seen: read
    // the head from the index and refuse if it has moved (no mutation).
    if (opts.expectVersion !== undefined && opts.expectVersion !== null) {
      let index;
      try { index = await readIndexStrict(store); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
      const row = index.find((e) => e.id === id);
      const head = Number.isSafeInteger(row?.version) && row.version > 0 ? row.version : 0;
      if (opts.expectVersion !== head) {
        return { ok: false, error: "version_conflict", version: head };
      }
    }
    const resolved = resolveAssetPatch(oldBody, edits);
    if (!resolved.ok) return resolved;
    if (resolved.content === oldBody) {
      return { ok: false, error: "the edits made no change" };
    }
    const res = await updateAssetLocked(store, origin, id, { content: resolved.content }, { by: opts.by, summary: opts.summary });
    if (!res?.ok) return res;
    const delta = lineDiffSummary(oldBody, resolved.content);
    return { ok: true, id, asset: res.asset, version: res.version, added: delta.added, removed: delta.removed };
  });
}

/** List an origin's assets. Reads run under the per-origin mutex; a strict
 * read failure surfaces (never a silently-empty successful list). */
/** Rows produced by ONE origin. The store is shared, so this filters on the
 *  row's provenance rather than reading a per-origin store. */
export async function listAssets(origin) {
  const o = canonical(origin);
  return withAssetLock(origin, async () => {
    const store = assetStore();
    try {
      const index = await readIndexStrict(store);
      return { ok: true, assets: index.filter((r) => r.origin === o) };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

/** THE LIBRARY: every artifact the owner has, whatever made it and whether or
 *  not that agent or task still exists. This is what the artifacts gallery
 *  shows — the owner asked for one central place their work accumulates. */
export async function listAllAssets() {
  return withAssetLock("master", async () => {
    const store = assetStore();
    try {
      return { ok: true, assets: await readIndexStrict(store) };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

/** The library's capacity state (CAP-FB-20260828-ARTIFACT-LIBRARY-CAPACITY-01)
 *  — what the artifacts gallery shows so the owner sees a full library COMING
 *  before a create is refused, rather than discovering it as a silent drop.
 *  `usedBytes`/`maxBytes` are the real index byte budget that governs the
 *  refusal; `regenerableCount` is how many rows would roll before any refusal. */
export async function assetLibraryCapacity() {
  return withAssetLock("master", async () => {
    const store = assetStore();
    try {
      const index = await readIndexStrict(store);
      const usedBytes = utf8Bytes(JSON.stringify(index));
      const maxBytes = ASSET_BOUNDS.maxIndexBytes;
      return {
        ok: true,
        count: index.length,
        usedBytes,
        maxBytes,
        fraction: maxBytes > 0 ? usedBytes / maxBytes : 0,
        regenerableCount: index.filter(isRegenerableRow).length,
        full: usedBytes >= maxBytes,
      };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}

/**
 * Move any artifacts still filed in a SITE store into the library
 * (CAP-FB-20260828-ARTIFACT-DURABILITY-01).
 *
 * Profiles created before the library became one store have artifacts sitting
 * in per-origin stores, where `agent.delete` would destroy them. This copies
 * them across and only then removes the originals, so a crash at any point
 * leaves the artifact readable from at least one place — never neither.
 *
 * Idempotent: an id already present in the library is skipped, so running this
 * on boot AND again immediately before a delete is safe. Returns what it did
 * rather than throwing; a migration failure must not block the operation that
 * triggered it, because refusing to delete an agent because a migration failed
 * would be a worse outcome than a retry on the next boot.
 */
export async function migrateSiteAssetsToLibrary(origin) {
  const o = canonical(origin);
  if (!o || o === "master") return { ok: true, moved: 0 };
  const site = siteMemory(o);
  let siteIndex;
  try {
    siteIndex = await site.get(INDEX_KEY);
  } catch {
    return { ok: false, moved: 0, error: "could not read the site asset index" };
  }
  if (!Array.isArray(siteIndex) || siteIndex.length === 0) return { ok: true, moved: 0 };

  let moved = 0;
  const failed = [];
  for (const row of siteIndex) {
    const id = row?.id;
    if (typeof id !== "string" || !id) continue;
    try {
      const body = await site.get(`asset:${id}`);
      if (body == null) continue; // an index row with no body migrates nothing
      const copied = await withAssetLock("master", async () => {
        const store = assetStore();
        const index = await readIndexStrict(store);
        if (index.some((r) => r.id === id)) return true; // already migrated
        // Body BEFORE index: a crash between them leaves an unreferenced body,
        // which the existing repair path collects. The reverse would leave an
        // index row pointing at nothing.
        await store.setTrusted(`asset:${id}`, { ...body, origin: o });
        await store.setTrusted(INDEX_KEY, [...index, { ...row, origin: o }]);
        return true;
      });
      if (copied) {
        // Verify the copy is readable before removing the original. Losing the
        // artifact is the exact failure this whole task exists to prevent.
        const check = await assetStore().get(`asset:${id}`).catch(() => null);
        if (check == null) { failed.push(id); continue; }
        await site.remove(`asset:${id}`).catch(() => {});
        moved += 1;
      }
    } catch {
      failed.push(id);
    }
  }
  // Clear the site index only when every row made it across.
  if (failed.length === 0) await site.setTrusted(INDEX_KEY, []).catch(() => {});
  return { ok: failed.length === 0, moved, failed: failed.length };
}
