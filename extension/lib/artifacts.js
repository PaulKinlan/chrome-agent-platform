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
  maxContentBytes: 256 * 1024,
  maxNameLength: 200,
  maxAssetsPerOrigin: 200,
  maxIndexBytes: 128 * 1024,
};

export const ASSET_TYPES = new Set(["html", "text", "json", "image", "data"]);

// A per-origin asset mutex serializes EVERY index/body read-modify-write
// (reads AND writes — the re-review's read/list interleaving finding).
const assetLocks = new Map();
const MAX_ASSET_LOCKS = 256;
function withAssetLock(origin, fn) {
  const key = canonical(origin) ?? "master";
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

function assetStore(origin) {
  return origin === "master" ? masterMemory() : siteMemory(origin);
}

function canonical(origin) {
  return origin === "master" ? "master" : (canonicalOrigin(origin) ?? "master");
}

function newId() {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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

function boundAssetMeta({ type, name, content }) {
  const at = type == null || type === "" ? "data" : String(type);
  if (!ASSET_TYPES.has(at)) return { error: `asset type must be one of ${[...ASSET_TYPES].join(", ")}` };
  const nm = String(name ?? "").trim();
  if (nm.length === 0) return { error: "asset needs a name" };
  if (nm.length > ASSET_BOUNDS.maxNameLength) return { error: `asset name exceeds ${ASSET_BOUNDS.maxNameLength} chars` };
  if (typeof content !== "string") return { error: "asset content must be a string" };
  const size = utf8Bytes(content);
  if (size > ASSET_BOUNDS.maxContentBytes) return { error: `asset content exceeds ${ASSET_BOUNDS.maxContentBytes} bytes` };
  return { ok: true, type: at, name: nm, size };
}

/** S0→S7 — create. The shared core runs under the per-origin lock; `pk` is
 * the optional stable PROMOTION KEY (createAssetKeyed sets it — the exact-
 * token dedup record in the row). The wrapper never calls this unkeyed path
 * for promotion (a retry would create a duplicate). */
async function createAssetLocked(store, origin, o, { type, name, content, meta, pk }) {
  const bounded = boundAssetMeta({ type, name, content });
  if (bounded.error) return { ok: false, error: bounded.error };
  const id = newId();
  const now = Date.now();
  const asset = {
    id, type: bounded.type, name: bounded.name, origin: o,
    createdAt: now, updatedAt: now, size: bounded.size, content, meta: meta ?? {},
  };
  await recoverTx(store); // crash recovery (the durable WAL)
  await repairPendingLocked(store, origin);
  const index = await readIndexStrict(store); // S0
  if (index.length >= ASSET_BOUNDS.maxAssetsPerOrigin) {
    return { ok: false, error: `asset limit reached (${ASSET_BOUNDS.maxAssetsPerOrigin})` };
  }
  const idxGen = await store.getVersion(INDEX_KEY);
  const row = {
    id, type: bounded.type, name: bounded.name, origin: o, at: now, size: bounded.size,
    ...(pk ? { pk } : {}),
  };
    const next = [...index, row];
    let idx = next;
    while (idx.length > 1 && utf8Bytes(JSON.stringify(idx)) > ASSET_BOUNDS.maxIndexBytes) {
      idx = idx.slice(1);
    }
    const dropped = next.filter((r) => !idx.some((k) => k.id === r.id));
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
    await writeWal(store, { op: "create", id, bodyGen: null, idxGen, newIndex: idx, droppedIds, state: "prepared" });
    // S3 — write the body (capture the exact write's version token); the
    // exact-token WAL record MUST land — a failure compensates the body by its
    // exact token (the reviewer's body→token gap).
    const bodyGen = await store.setTrusted(`asset:${id}`, asset);
    try {
      await writeWal(store, { op: "create", id, bodyGen, idxGen, newIndex: idx, droppedIds, state: "prepared" });
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
        await writeWal(store, { op: "create", id, bodyGen, idxGen, newIndex: idx, droppedIds, state: "compensated" });
        await clearWal(store).catch(() => {});
      }
      throw e; // the caller observes the failure; the WAL/recovery state is consistent
    }
    if (casOk === false) {
      // S5 — a concurrent writer won: the obligations no longer apply; the
      // body is cleaned by its EXACT token + the intent is compensated.
      await removeObligations();
      await store.compareAndDelete(`asset:${id}`, bodyGen).catch(() => {});
      await writeWal(store, { op: "create", id, bodyGen, idxGen, newIndex: idx, droppedIds, state: "compensated" });
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
      }
      await removeObligations();
      await writeWal(store, { op: "create", id, bodyGen, idxGen, postIdxGen, newIndex: idx, droppedIds, state: "compensated" });
      throw e;
    } finally {
      await clearWal(store).catch(() => {});
    }
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
      }
      if (removed.length) {
        await recordRepairEntry(store, (repair) => {
          const before = repair.pendingDeletes.length;
          repair.pendingDeletes = repair.pendingDeletes.filter((d) => !removed.includes(d.id));
          return repair.pendingDeletes.length !== before;
        });
      }
    }
    return { ok: true, asset: { ...asset, content: undefined }, index: idx };
}

/** S0→S7 — create (the UNKEYED path; never used for workspace promotion). */
export async function createAsset(origin, { type, name, content, meta }) {
  const store = assetStore(origin);
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
  const store = assetStore(origin);
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
        return { ok: true, deduped: true, id: prior.id, asset };
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
export async function updateAsset(origin, id, patch) {
  const store = assetStore(origin);
  if (!id || typeof id !== "string") return { ok: false, error: "update_asset needs an id" };
  return withAssetLock(origin, async () => {
    await recoverTx(store); // crash recovery (the durable WAL — FAILS closed)
    await repairPendingLocked(store, origin);
    const existing = await store.get(`asset:${id}`); // S0
    if (!existing) return { ok: false, error: "asset not found" };
    const nextType = patch.type ?? existing.type;
    const nextName = patch.name ?? existing.name;
    const nextContent = patch.content ?? existing.content;
    const meta = boundAssetMeta({ type: nextType, name: nextName, content: nextContent });
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
    // S1 — WRITE THE DURABLE WAL INTENT (prepared) BEFORE the body mutation.
    // The intent carries the OLD body + BOTH rows (old + new) + the exact
    // tokens — a write failure (e.g. the old body + rows exceed the value
    // cap) REJECTS the update BEFORE any mutation: the compensation capacity
    // is RESERVED (the reviewer's finding — the old body must never be
    // lost).
    const walIntent = {
      op: "update", id,
      oldBody: existing, oldBodyGen: await store.getVersion(`asset:${id}`),
      oldRow: i, newRow: { ...i, type: meta.type, name: meta.name, size: meta.size },
      idxGen, state: "prepared",
    };
    await writeWal(store, walIntent); // throws (over-cap) → the update rejects
    // S2 — write the new body; the returned version is the EXACT write token.
    const newBodyGen = await store.setTrusted(`asset:${id}`, updated);
    i.type = meta.type;
    i.name = meta.name;
    i.size = meta.size;
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
          repair.pendingRestores.push({ id, row: i, body: existing, bodyVersion: newBodyGen, indexVersion: idxGen });
          return true;
        });
      }
      await writeWal(store, { op: "update", id, newBodyGen, row: i, idxGen, state: "compensated" });
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
    } catch { /* the committed WAL completes the mirror via recovery */ return { ok: true, asset: { ...updated, content: undefined } }; }
    await clearWal(store).catch(() => {});
    return { ok: true, asset: { ...updated, content: undefined } };
  });
}

/** S0→S3 — delete (the body is removed by the EXACT-write CAS token; a failure
 * CAS-restores the row; a double failure is recorded durably). */
export async function deleteAsset(origin, id) {
  const store = assetStore(origin);
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
 * they never observe a split write (the re-review's interleaving finding). */
export async function getAsset(origin, id) {
  if (!id || typeof id !== "string") return { ok: false, error: "get_asset needs an id" };
  return withAssetLock(origin, async () => {
    const store = assetStore(origin);
    const asset = await store.get(`asset:${id}`);
    if (!asset) return { ok: false, error: "asset not found" };
    return { ok: true, asset };
  });
}

/** List an origin's assets. Reads run under the per-origin mutex; a strict
 * read failure surfaces (never a silently-empty successful list). */
export async function listAssets(origin) {
  return withAssetLock(origin, async () => {
    const store = assetStore(origin);
    try {
      const index = await readIndexStrict(store);
      return { ok: true, assets: index };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  });
}
