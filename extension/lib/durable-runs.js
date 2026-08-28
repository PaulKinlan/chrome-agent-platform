// lib/durable-runs.js — durable service-worker run authority.
//
// The mounted UI is never an execution owner. Every accepted attempt is keyed by
// its immutable SW-issued executionId and persisted in the trusted master store.
// Terminal payloads use an outbox-first protocol so restart recovery can finish
// the journal/thread/registry triple idempotently before interruption recovery.

import {
  backgroundAgentMemory,
  durableRunLogHandle,
  durableRunMemory,
  removeDurableRunLog,
  journalAppendOnce,
  journalCommitCancellation,
  journalCompensateExecution,
  masterMemory,
  namedAgentMemory,
  siteMemory,
} from "./memory.js";
import { REPLAY_MUTATING, perCallIdempotencyKey, worstSafety } from "./tool-replay-safety.js";
import { commitThreadCancellation, commitThreadTerminal } from "./threads.js";
import { isNativeQuotaExceededError } from "./storage-errors.js";
import {
  appendRecords as walAppend,
  readAll as walReadAll,
  readRecent as walReadRecent,
} from "./run-log-wal.js";

const INDEX_KEY = "run-registry";
const RUN_PREFIX = "run:";
const OUTBOX_PREFIX = "run-outbox:";
const LOG_PREFIX = "run-log:";
const LOG_IDX_PREFIX = "run-log-idx:";
const RESUME_PREFIX = "run-resume:";
const PAYLOAD_PREFIX = "run-payload:";
const RESUME_CHUNK_CHARS = 64 * 1024;
// Bounded fan-out for independent log-row reads (see mapBounded).
const LOG_READ_CONCURRENCY = 32;
const MAX_PREVIEW_CHARS = 240;
const MAX_RESUME_ATTEMPTS = 3;

export const RUN_RETENTION_POLICY = Object.freeze({
  schemaVersion: 1,
  policyVersion: "run-retention-v1",
  mode: "retain-all",
  automaticCompaction: false,
  automaticEviction: false,
  explicitClearOnly: true,
});

export const DURABLE_RUN_POLICY = Object.freeze({
  schemaVersion: 1,
  cancellation: "explicit-owner-terminal-new-run-required",
  retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
  progress: "bounded-phase-with-durable-status",
  resume: "interruptions-auto-permission-resolution-only",
});

const TERMINAL_PHASES = new Set(["terminal", "cancelled"]);

function normalizeRetention(record) {
  const version = record?.retentionPolicyVersion;
  if (version == null) {
    return {
      ...record,
      retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
      retentionMigration: { from: "legacy-unversioned", to: RUN_RETENTION_POLICY.policyVersion },
    };
  }
  if (version !== RUN_RETENTION_POLICY.policyVersion) {
    throw new Error(`unknown durable run retention policy: ${version}`);
  }
  return record;
}

function bounded(value, max = MAX_PREVIEW_CHARS) {
  const s = String(value ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function redactedPreview(value) {
  return bounded(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|token|secret|password|credential|access[_-]?key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

function validExecutionId(value) {
  if (typeof value !== "string" || value.length > 200) return false;
  const lower = value.toLowerCase();
  if (["__proto__", "prototype", "constructor"].includes(lower)) return false;
  return /^exec:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    || /^exec_[a-zA-Z0-9][a-zA-Z0-9_-]{7,194}$/.test(value);
}

function publicRecord(record) {
  if (!record) return null;
  const { journalTarget: _journalTarget, resumeRequest: _resumeRequest, resumeRequestRef: _resumeRequestRef, registryAdmission: _registryAdmission, ...safe } = record;
  return structuredClone({ ...safe, resumeAvailable: !!record.resumeRequestRef || !!record.resumeRequest });
}

function storeForTarget(target) {
  const value = String(target ?? "master");
  if (value === "master") return masterMemory();
  if (value.startsWith("agent:")) return namedAgentMemory(value.slice(6));
  if (value.startsWith("background:")) return backgroundAgentMemory(value.slice(11));
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return siteMemory(value);
  }
  throw new Error(`unsupported durable-run journal target: ${value}`);
}

function newBootId() {
  return `boot_${Date.now().toString(36)}_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

/**
 * Create a registry. Dependencies are injectable so the crash-boundary matrix
 * can deterministically terminate and recreate a worker around the same store.
 */
/** Read independent keys with BOUNDED concurrency, preserving input order
 *  (CAP-FB-20260827-THREAD-OPEN-SEQUENTIAL-READS-01).
 *
 *  Measured: 97% of task-open time was `thread-view:logs`, which read a page of
 *  up to 250 log rows with `for (const key of keys) await store.get(key)` — 250
 *  sequential file opens for data that has no ordering dependency at all. The
 *  rows are independent; only the RESULT order matters, and that is restored by
 *  index rather than by completion order.
 *
 *  Bounded rather than a bare Promise.all: a 250-wide fan-out opens 250 OPFS
 *  handles at once, and a thread view issues that per execution. 32 is enough
 *  to hide per-file latency without that. */
async function mapBounded(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function createDurableRunRegistry({
  store = durableRunMemory(),
  // The run log's OPFS handle, injectable for the same reason `store` is: a
  // test that supplies its own store must be able to supply its own log, or the
  // registry reaches past its injected dependencies straight to real storage.
  logHandleFor = durableRunLogHandle,
  removeLogFor = removeDurableRunLog,
  now = () => Date.now(),
  bootId = newBootId(),
  resolveJournalStore = storeForTarget,
  appendJournal = journalAppendOnce,
  replaceCancellationJournal = journalCommitCancellation,
  commitThread = commitThreadTerminal,
  replaceCancellationThread = commitThreadCancellation,
  compensateJournal = journalCompensateExecution,
  injectFailure = null,
} = {}) {
  const active = new Set();
  const listeners = new Set();
  // READ/WRITE LOCK (CAP-FB-20260827-THREAD-OPEN-SEQUENTIAL-READS-01).
  //
  // This was ONE exclusive mutex over the whole registry, so no two operations
  // ever overlapped — including two reads of two unrelated executions. Opening a
  // thread reads up to 25 executions, and they queued behind each other for no
  // reason: a read mutates nothing, so reads can share.
  //
  // Writers stay fully exclusive against both writers and readers, so every
  // existing invariant (index/row atomicity, idempotency, recovery) is unchanged
  // — a reader simply never runs WHILE a write is in flight. Readers also wait
  // on the pending write chain before starting, which both prevents writer
  // starvation and means a read never sees a store mid-write.
  let writeChain = Promise.resolve();
  const activeReads = new Set();

  /** Exclusive: waits for pending writes, then for in-flight readers to drain. */
  function locked(fn) {
    const run = (async () => {
      await writeChain.catch(() => {});
      if (activeReads.size) await Promise.allSettled([...activeReads]);
      return await fn();
    })();
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  /** Shared: concurrent with other readers, never with a writer. Use ONLY for
   *  operations that cannot write — a read path that may repair or rebuild must
   *  take `locked` for that part. */
  function lockedRead(fn) {
    return (async () => {
      // Wait for pending writes FIRST, and only then count as an active reader.
      // Registering before this await deadlocks: with several reads in flight,
      // reader A would occupy a slot while waiting on a write chain that a
      // later writer had joined, and that writer waits for A's slot to clear.
      // A reader must never hold a slot while it is itself waiting on a write.
      await writeChain.catch(() => {});
      let release;
      const slot = new Promise((resolve) => { release = resolve; });
      activeReads.add(slot);
      try {
        return await fn();
      } finally {
        activeReads.delete(slot);
        release();
      }
    })();
  }

  async function boundary(name, executionId) {
    if (injectFailure) await injectFailure(name, executionId);
  }

  async function snapshotKey(key) {
    if (typeof store.snapshot === "function") return await store.snapshot(key);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await store.getVersion(key);
      const exists = await store.has(key);
      const value = exists ? await store.get(key) : null;
      const after = await store.getVersion(key);
      if (before === after && exists === await store.has(key)) return { exists, value, version: after };
    }
    throw new Error(`could not capture stable ${key} snapshot`);
  }

  async function indexIds() {
    const value = await store.get(INDEX_KEY);
    return Array.isArray(value) ? value.filter(validExecutionId) : [];
  }

  async function addToIndex(executionId) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const prior = await snapshotKey(INDEX_KEY);
      const ids = Array.isArray(prior.value) ? prior.value.filter(validExecutionId) : [];
      if (ids.includes(executionId)) throw new Error("execution is indexed without readable authority");
      const next = [executionId, ...ids];
      const admission = {
        preExists: prior.exists,
        preVersion: prior.version,
        preValue: structuredClone(prior.value),
        writeVersion: prior.version + 1,
      };
      let swapped;
      try {
        swapped = await store.compareAndRestore(INDEX_KEY, prior.version, next);
      } catch (cause) {
        const wrapped = new Error("run registry admission write failed", { cause });
        wrapped.registryAdmission = admission;
        throw wrapped;
      }
      if (swapped) return admission;
    }
    throw new Error("run registry admission CAS did not converge");
  }

  async function removeFromIndexExact(executionId, admission) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await snapshotKey(INDEX_KEY);
      const ids = Array.isArray(current.value) ? current.value.filter(validExecutionId) : [];
      if (!ids.includes(executionId)) return { ok: true, idempotent: true };
      const remaining = ids.filter((id) => id !== executionId);
      let swapped;
      if (remaining.length === 0 && admission?.preExists === false) {
        swapped = await store.compareAndDelete(INDEX_KEY, current.version);
      } else {
        // A pre-existing empty registry is a real file and remains one. Any
        // concurrent IDs survive in their observed order.
        swapped = await store.compareAndRestore(INDEX_KEY, current.version, remaining);
      }
      if (swapped) return { ok: true, idempotent: false };
    }
    return { ok: false, reason: "registry_cas_mismatch" };
  }

  function emit(record) {
    const event = {
      type: "run-update",
      executionId: record.executionId,
      revision: record.revision,
      run: publicRecord(record),
    };
    for (const listener of listeners) {
      try { listener(event); } catch { /* one observer cannot break authority */ }
    }
  }

  async function writeRecord(record, expectedRevision = null) {
    const key = `${RUN_PREFIX}${record.executionId}`;
    const currentRaw = await store.get(key);
    const current = currentRaw ? normalizeRetention(currentRaw) : null;
    if (expectedRevision !== null && current?.revision !== expectedRevision) {
      return null;
    }
    const next = {
      ...record,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: now(),
    };
    if (current) {
      const version = await store.getVersion(key);
      const swapped = await store.compareAndRestore(key, version, next);
      if (!swapped) return null;
    } else {
      await store.setTrusted(key, next);
    }
    emit(next);
    return next;
  }

  async function readRecord(executionId, { persistMigration = true } = {}) {
    const key = `${RUN_PREFIX}${executionId}`;
    const raw = await store.get(key);
    if (!raw) return null;
    const normalized = normalizeRetention(raw);
    if (persistMigration && raw.retentionPolicyVersion == null) {
      const version = await store.getVersion(key);
      const swapped = await store.compareAndRestore(key, version, normalized);
      if (!swapped) return await readRecord(executionId, { persistMigration: false });
    }
    return normalized;
  }

  async function persistJsonPayload(executionId, id, value) {
    const json = JSON.stringify(value);
    const ref = `${PAYLOAD_PREFIX}${executionId}:${id}`;
    const chunkCount = Math.max(1, Math.ceil(json.length / RESUME_CHUNK_CHARS));
    for (let index = 0; index < chunkCount; index += 1) {
      await store.setTrusted(`${ref}:${String(index).padStart(6, "0")}`, {
        schemaVersion: 1,
        retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
        executionId,
        index,
        data: json.slice(index * RESUME_CHUNK_CHARS, (index + 1) * RESUME_CHUNK_CHARS),
      });
    }
    await store.setTrusted(`${ref}:manifest`, {
      schemaVersion: 1,
      retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
      executionId,
      chunkCount,
    });
    return ref;
  }

  async function readJsonPayload(executionId, ref) {
    const manifest = await store.get(`${ref}:manifest`);
    if (!manifest || manifest.executionId !== executionId || manifest.retentionPolicyVersion !== RUN_RETENTION_POLICY.policyVersion) {
      throw new Error("invalid retained run payload");
    }
    let json = "";
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      const chunk = await store.get(`${ref}:${String(index).padStart(6, "0")}`);
      if (!chunk || chunk.executionId !== executionId || chunk.retentionPolicyVersion !== RUN_RETENTION_POLICY.policyVersion) {
        throw new Error("incomplete retained run payload");
      }
      json += chunk.data;
    }
    return JSON.parse(json);
  }

  // ── the run log, as a write-ahead log ───────────────────────────────────
  // CAP-FB-20260827-THREAD-OPEN-SEQUENTIAL-READS-01. Rows used to be one
  // key-value record each, plus a per-execution index that was rewritten in
  // full on EVERY append — O(n^2), measured at 171 s to write 1,000 rows. They
  // are now lines in one append-only file per execution: 1 ms for the same
  // 1,000 rows. See docs/THREAD-LOADING-REDESIGN.md.
  //
  // Idempotency used to come from the row KEY being the content hash of the
  // idempotency key, so a repeat could not be written twice. Here the key is a
  // field on the record, and duplicates are rejected against a per-execution
  // set of keys already in the log — seeded from the log itself the first time
  // this worker touches that execution, so a service-worker restart cannot
  // admit a duplicate.
  const seenKeys = new Map(); // executionId → Set<idempotencyKey>

  async function seenKeysFor(executionId, handle) {
    let set = seenKeys.get(executionId);
    if (set) return set;
    set = new Set();
    try {
      for (const row of await walReadAll(handle)) {
        if (typeof row?.idempotencyKey === "string") set.add(row.idempotencyKey);
      }
    } catch { /* an unreadable log seeds empty; a duplicate is better than a loss */ }
    // Bounded: this map is per live execution and cleared on settle/cancel.
    if (seenKeys.size > 64) seenKeys.clear();
    seenKeys.set(executionId, set);
    return set;
  }

  /** Append a row the registry itself writes — the `accepted` marker and the
   *  terminal marker — straight to the run log.
   *
   *  These were `store.setTrusted("run-log:<exec>:accepted"|":terminal")`, which
   *  bypassed appendLog. That was harmless while reads came from the key-value
   *  store. Once reads came from the log it became a DATA-LOSS path: the KV→log
   *  migration is one-time and marker-guarded, so a row written to KV AFTER the
   *  marker is set is never read again — and in a real run appendLog fires
   *  during the run, so the marker is set before settle(). They are log rows;
   *  they belong in the log. */
  // ── the run-log write buffer ────────────────────────────────────────────
  // CAP-FB-20260828-RUN-LOG-WRITE-BUFFER-01. The log is ONE file, but every
  // appendLog was its own open/write/close cycle, so 1,000 rows cost 1,000
  // cycles (~14 s) where 1,000 rows in ONE cycle cost ~1 ms. Rows arriving
  // close together — a tool-call and its result, several parallel tool calls in
  // one step — are coalesced into a single append.
  //
  // DURABILITY IS UNCHANGED. `appendLog` still resolves only once the row is ON
  // DISK: it returns a promise settled by the flush. A caller that awaits gets
  // exactly the guarantee it had before; what changed is that N concurrent
  // appends now share one file-open instead of forcing N.
  //
  // The buffer is flushed before anything READS the log and before a run
  // reaches a terminal state, so no reader misses an accepted row and no run
  // settles with unflushed history behind it.
  const pendingAppends = new Map(); // executionId → { rows, waiters, timer, handle }
  // Per-append storage reads that the write buffer exposed as the next
  // bottleneck: with file writes coalesced, the remaining cost was the preamble
  // — a marker read and a directory/file open on every single append. Both are
  // stable for the life of an execution, so both are memoised here and cleared
  // when the execution is purged.
  const migratedExecutions = new Set();
  const logHandles = new Map();
  const MAX_BUFFERED_ROWS = 256;    // bounds both memory and the loss window

  function queueAppend(executionId, handle, row) {
    let pending = pendingAppends.get(executionId);
    if (!pending) {
      pending = { rows: [], waiters: [], timer: null, handle };
      pendingAppends.set(executionId, pending);
    }
    pending.handle = handle;
    pending.rows.push(row);
    const settled = new Promise((resolve, reject) => pending.waiters.push({ resolve, reject }));
    if (pending.rows.length >= MAX_BUFFERED_ROWS) {
      void flushAppends(executionId);
    } else if (pending.timer == null) {
      // A macrotask, not a microtask: a microtask would fire before the sibling
      // appends of the same step were even queued, which is the coalescing this
      // exists for.
      pending.timer = setTimeout(() => { void flushAppends(executionId); }, 0);
    }
    return settled;
  }

  async function flushAppends(executionId) {
    const pending = pendingAppends.get(executionId);
    if (!pending || pending.rows.length === 0) return;
    pendingAppends.delete(executionId);
    if (pending.timer != null) clearTimeout(pending.timer);
    const { rows, waiters, handle } = pending;
    try {
      await walAppend(handle, rows);
      for (const w of waiters) w.resolve();
    } catch (error) {
      // Every queued caller learns the write failed. Silently dropping rows
      // would be the worst possible outcome for a durability log.
      for (const w of waiters) w.reject(error);
    }
  }

  /** Flush buffered rows. Call this from INSIDE a lock section (read or write);
   *  taking a lock here would deadlock against the section that already holds
   *  one. Never throws — a failed flush has already rejected the callers whose
   *  rows it carried. */
  async function flushExecution(executionId) {
    try {
      await flushAppends(executionId);
    } catch { /* already reported to the queuing callers */ }
  }

  async function handleFor(executionId) {
    let handle = logHandles.get(executionId);
    if (handle) return handle;
    handle = await logHandleFor(executionId, { create: true });
    if (handle) {
      if (logHandles.size > 64) logHandles.clear(); // bounded, like seenKeys
      logHandles.set(executionId, handle);
    }
    return handle;
  }

  async function appendRegistryRow(executionId, row) {
    // Flush first: a terminal marker must never land ahead of a tool row that
    // was already accepted. Written unbuffered because ordering matters more
    // than coalescing for the two rows the registry writes itself.
    await flushExecution(executionId);
    await migrateExecutionLog(executionId);
    const handle = await logHandleFor(executionId, { create: true });
    if (!handle) throw new Error("run log unavailable");
    await walAppend(handle, [row]);
  }

  async function appendLog(executionId, entry, idempotencyKey = crypto.randomUUID?.() ?? `${now()}-${Math.random()}`) {
    // The row is QUEUED under the write lock — so validation, dedup and the
    // buffer stay serialised — and the flush is awaited OUTSIDE it. Holding the
    // lock across the flush defeats the point entirely: concurrent appends then
    // serialise and each flushes alone (measured: 21 file writes for 20
    // appends, i.e. no coalescing at all).
    const queued = await locked(async () => {
      const record = await readRecord(executionId);
      if (!record) throw new Error("cannot log an unknown execution");
      const idText = bounded(String(idempotencyKey), 500);
      const at = Number.isFinite(entry?.at) ? entry.at : now();

      await migrateExecutionLog(executionId);
      const handle = await handleFor(executionId);
      if (!handle) throw new Error("run log unavailable");

      const seen = await seenKeysFor(executionId, handle);
      if (seen.has(idText)) {
        // Already logged. Return the existing row rather than appending a
        // second copy — the same guarantee the content-addressed key gave.
        const existing = (await walReadAll(handle)).find((r) => r?.idempotencyKey === idText);
        if (existing) return { row: existing, settled: null };
      }

      const cloned = structuredClone(entry);
      const serialized = JSON.stringify(cloned);
      // Large entries still spill to their own payload file, so one oversized
      // record cannot make every tail read of this log expensive.
      // The digest only names an overflow payload file, so it is computed only
      // when there is one — it was being hashed on every append for nothing.
      let payloadRef = null;
      if (serialized.length > RESUME_CHUNK_CHARS) {
        const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idText)))]
          .map((byte) => byte.toString(16).padStart(2, "0")).join("");
        payloadRef = await persistJsonPayload(executionId, digest, cloned);
      }
      const row = {
        ...(payloadRef ? { type: cloned?.type ?? "log", payloadRef } : cloned),
        schemaVersion: 1,
        retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
        executionId,
        at,
        idempotencyKey: idText,
      };
      // `seen` is updated NOW so a duplicate arriving before the flush is still
      // rejected by the same guarantee the content-addressed key used to give.
      seen.add(idText);
      return { row, settled: queueAppend(executionId, handle, row) };
    });
    if (!queued?.settled) return queued?.row ? structuredClone(queued.row) : queued;
    await queued.settled; // resolves only once the row is on disk
    return structuredClone(queued.row);
  }

  /** Move an execution's legacy key-value rows into its WAL. Runs at most ONCE
   *  per execution, guarded by a marker.
   *
   *  The marker is not an optimisation, it is the correctness fix. The first
   *  version of this deduplicated by `idempotencyKey` and deleted the legacy
   *  rows with `store.remove?.()` — a method the durable store does not have,
   *  so optional chaining silently deleted NOTHING. Migration therefore re-ran
   *  on every append, and the one legacy row that carries no idempotencyKey
   *  (the `accepted` row, written directly by `start()`) failed the dedup and
   *  was re-appended each time: 401 copies in an 802-row log, which is what
   *  made a 250-row page contain only 124 tool rows.
   *
   *  Write, VERIFY, delete, then mark. A crash between steps leaves both forms
   *  and the reader prefers the log; losing run history is worse than
   *  migrating twice. */
  const MIGRATED_PREFIX = "run-log-wal:";

  async function migrateExecutionLog(executionId) {
    // Fastest path: already migrated in this worker's lifetime — no storage
    // read at all.
    if (migratedExecutions.has(executionId)) return false;
    const marker = `${MIGRATED_PREFIX}${executionId}`;
    if (await store.has(marker).catch(() => false)) {
      migratedExecutions.add(executionId);
      return false;
    }

    const prefix = `${LOG_PREFIX}${executionId}:`;
    let legacyKeys;
    try {
      legacyKeys = (await store.keys()).filter((k) => k.startsWith(prefix));
    } catch {
      return false;
    }

    const handle = await logHandleFor(executionId, { create: true });
    if (!handle) return false;

    if (legacyKeys.length > 0) {
      const before = (await walReadAll(handle).catch(() => [])).length;
      const rows = [];
      for (const key of legacyKeys) {
        const row = await store.get(key).catch(() => null);
        if (row != null) rows.push(row);
      }
      // Legacy rows were stored under content-addressed keys with no inherent
      // order, so sort them the way the old reader did before writing them into
      // the log — after this point append order IS the order.
      rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || String(a.idempotencyKey ?? a.type).localeCompare(String(b.idempotencyKey ?? b.type)));
      if (rows.length > 0) await walAppend(handle, rows);

      // VERIFY the log actually grew by what we wrote before deleting anything.
      const after = (await walReadAll(handle).catch(() => [])).length;
      if (after < before + rows.length) return false; // keep the legacy rows

      for (const key of legacyKeys) {
        const version = await store.getVersion(key).catch(() => 0);
        await store.compareAndDelete(key, version).catch(() => {});
      }
      await store.setTrusted(`${LOG_IDX_PREFIX}${executionId}`, {
        schemaVersion: 1,
        retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
        executionId,
        entries: [],
      }).catch(() => {});
    }

    await store.setTrusted(marker, {
      schemaVersion: 1,
      retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
      executionId,
      migratedRows: legacyKeys.length,
    }).catch(() => {});
    migratedExecutions.add(executionId);
    seenKeys.delete(executionId);
    return legacyKeys.length > 0;
  }

  async function listLogs(executionId, opts = Infinity) {
    // A read may MIGRATE, which writes — so check the marker OUTSIDE any lock
    // and only take the exclusive lock when there is actually legacy data to
    // move. An execution already on the WAL (every execution, after its first
    // read) never acquires the write lock at all.
    const alreadyMigrated = await store.has(`${MIGRATED_PREFIX}${executionId}`).catch(() => false);
    if (!alreadyMigrated) await locked(() => migrateExecutionLog(executionId));
    return lockedRead(async () => {
      // Inside the shared lock, which has already awaited the write chain — so
      // every append initiated before this read has queued its row, and this
      // flush puts them on disk. Placed BEFORE the lock it would race an append
      // that had been called but had not yet queued. A read flushes rather than
      // merging the buffer: one source of truth (the file), and byte cursors
      // stay meaningful, since a buffered row has no offset yet.
      await flushExecution(executionId);
      const record = await readRecord(executionId);
      if (!record) throw new Error("unknown execution");
      const handle = await logHandleFor(executionId, { create: false });
      if (!handle) return [];

      const isObj = opts != null && typeof opts === "object" && !Array.isArray(opts);
      const limit = isObj ? (opts.limit ?? Infinity) : opts;
      const before = isObj ? (opts.before ?? null) : null;

      const page = await walReadRecent(handle, {
        limit: Number.isFinite(limit) && limit > 0 ? limit : Infinity,
        before: typeof before === "number" ? before : null,
      });
      for (const row of page.records) {
        if (row?.retentionPolicyVersion !== RUN_RETENTION_POLICY.policyVersion) {
          throw new Error(`unknown durable run log retention policy: ${row?.retentionPolicyVersion}`);
        }
      }
      const hydrated = await Promise.all(page.records.map(async (row) =>
        (row?.payloadRef ? { ...row, payload: await readJsonPayload(executionId, row.payloadRef) } : row)
      ));
      // The byte offset of the first row is the cursor for the previous page.
      // Attached non-enumerably so it cannot leak into a serialized response or
      // change what any existing consumer sees when it iterates the array.
      Object.defineProperty(hydrated, "nextBefore", { value: page.nextBefore, enumerable: false });
      Object.defineProperty(hydrated, "exhausted", { value: page.exhausted, enumerable: false });
      return hydrated;
    });
  }

  // ── thread → executions reverse index (log-redesign) ────────────────────
  // The thread is a VIEW over the single authoritative per-execution durable
  // log. The view needs the thread's execution set at read time; this small
  // index (executionId strings only, bounded) provides it. Legacy threads
  // (admitted before the index existed) self-migrate via a one-time registry
  // scan, which is then persisted — the owner's stuck pre-redesign threads
  // heal on their next open.
  const THREAD_RUNS_PREFIX = "thread-runs:";
  const THREAD_RUNS_MAX = 500;

  async function linkThreadExecution(threadId, executionId) {
    const key = `${THREAD_RUNS_PREFIX}${threadId}`;
    const current = (await store.get(key)) ?? [];
    const list = Array.isArray(current) ? current : [];
    if (list.includes(executionId)) return;
    list.push(executionId);
    await store.setTrusted(key, list.slice(-THREAD_RUNS_MAX));
  }

  async function listThreadExecutions(threadId) {
    if (!threadId) return [];
    return locked(async () => {
      const key = `${THREAD_RUNS_PREFIX}${threadId}`;
      let ids = (await store.get(key)) ?? [];
      ids = Array.isArray(ids) ? ids.filter(validExecutionId) : [];
      // Self-migration: a thread with no (or partial) index falls back to a
      // registry scan by record.threadId, then persists the union.
      const scanned = [];
      for (const executionId of await indexIds()) {
        if (ids.includes(executionId)) continue;
        const record = await readRecord(executionId);
        if (record?.threadId === threadId) scanned.push(executionId);
      }
      if (scanned.length) {
        const union = [...ids, ...scanned].slice(-THREAD_RUNS_MAX);
        await store.setTrusted(key, union);
        ids = union;
      }
      // Order chronologically by the run's start (admission order is append
      // order, but the migration scan appends registry order — sort by the
      // record's startedAt so the view is stable).
      const withTime = [];
      for (const executionId of ids) {
        const record = await readRecord(executionId);
        if (record) withTime.push({ executionId, at: record.startedAt ?? 0, record: publicRecord(record) });
      }
      withTime.sort((a, b) => a.at - b.at || a.executionId.localeCompare(b.executionId));
      return withTime;
    });
  }

  async function persistResumeRequest(executionId, request) {
    if (!request) return null;
    const json = JSON.stringify(request);
    const chunks = [];
    for (let offset = 0; offset < json.length; offset += RESUME_CHUNK_CHARS) {
      chunks.push(json.slice(offset, offset + RESUME_CHUNK_CHARS));
    }
    const ref = `${RESUME_PREFIX}${executionId}`;
    for (let index = 0; index < chunks.length; index += 1) {
      await store.setTrusted(`${ref}:${String(index).padStart(6, "0")}`, {
        schemaVersion: 1,
        retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
        executionId,
        index,
        data: chunks[index],
      });
    }
    await store.setTrusted(`${ref}:manifest`, {
      schemaVersion: 1,
      retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
      executionId,
      chunkCount: chunks.length,
    });
    return ref;
  }

  async function readResumeRequest(record) {
    if (record?.resumeRequest) return structuredClone(record.resumeRequest); // legacy successor draft
    const ref = record?.resumeRequestRef;
    if (!ref) return null;
    const manifest = await store.get(`${ref}:manifest`);
    if (!manifest || manifest.retentionPolicyVersion !== RUN_RETENTION_POLICY.policyVersion) {
      throw new Error("invalid or unknown resume-request policy");
    }
    let json = "";
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      const chunk = await store.get(`${ref}:${String(index).padStart(6, "0")}`);
      if (!chunk || chunk.executionId !== record.executionId || chunk.retentionPolicyVersion !== RUN_RETENTION_POLICY.policyVersion) {
        throw new Error("incomplete durable resume request");
      }
      json += chunk.data;
    }
    return JSON.parse(json);
  }

  async function start(meta) {
    return locked(async () => {
      const executionId = String(meta?.executionId ?? "");
      if (!validExecutionId(executionId)) throw new Error("invalid immutable executionId");
      const key = `${RUN_PREFIX}${executionId}`;
      const existing = await readRecord(executionId);
      if (existing) {
        if (existing.executionId !== executionId) throw new Error("execution identity mismatch");
        if (["running", "settling"].includes(existing.phase) && existing.bootId === bootId) active.add(executionId);
        return publicRecord(existing);
      }
      let registryAdmission = null;
      try {
      registryAdmission = await addToIndex(executionId);
      const resumeRequestRef = await persistResumeRequest(executionId, meta?.resumeRequest);
      const at = now();
      const record = await writeRecord({
        executionId,
        clientCorrelationId: bounded(meta?.clientCorrelationId, 200) || null,
        threadId: bounded(meta?.threadId, 200) || null,
        scheduleName: bounded(meta?.scheduleName, 200) || null,
        kind: ["task", "agent", "scheduled", "delegate"].includes(meta?.kind)
          ? meta.kind
          : "task",
        agentId: bounded(meta?.agentId, 200) || null,
        taskPreview: redactedPreview(meta?.taskPreview),
        journalTarget: bounded(meta?.journalTarget, 300) || "master",
        phase: "running",
        bootId,
        startedAt: at,
        heartbeatAt: at,
        progressCount: 0,
        toolSafety: null, // UNRECORDED until a tool's declared safety is recorded; the gate treats null as unknown/mutating (fail-closed)
        toolCallCounts: null, // per-tool-name call index authority: { [toolName]: count } — the STABLE per-call idempotency index across resume
        policy: DURABLE_RUN_POLICY,
        retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
        resumeRequestRef,
        // Private compensation receipt: never projected through publicRecord().
        registryAdmission,
      });
      active.add(executionId);
      await appendRegistryRow(executionId, {
        schemaVersion: 1,
        retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
        executionId,
        at,
        type: "accepted",
        kind: record.kind,
        taskPreview: record.taskPreview,
      });
      // The THREAD → EXECUTIONS reverse index (log-redesign): the thread view
      // projects tool rows from the per-execution durable logs at READ time, so
      // it must be able to enumerate a thread's executions without scanning the
      // whole registry. Appended here — at admission — so every admitted run is
      // linked to its thread exactly once (idempotent by executionId).
      if (record.threadId) await linkThreadExecution(record.threadId, executionId);
      return publicRecord(record);
      } catch (caught) {
        const error = caught?.cause && caught?.registryAdmission ? caught.cause : caught;
        registryAdmission ??= caught?.registryAdmission ?? null;
        // Free this failed start's auxiliary bytes before rewriting the index:
        // when OPFS is full, the old write-first compensation is itself
        // impossible and leaves a dangling registry ID. Keep the readable run
        // record until the index no longer names it, then delete it and verify.
        active.delete(executionId);
        const recordKey = `${RUN_PREFIX}${executionId}`;
        const owned = (candidate) => candidate === recordKey ||
          candidate === `${OUTBOX_PREFIX}${executionId}` ||
          candidate === `${LOG_IDX_PREFIX}${executionId}` ||
          candidate === `${MIGRATED_PREFIX}${executionId}` ||
          candidate.startsWith(`${RESUME_PREFIX}${executionId}:`) ||
          candidate.startsWith(`${LOG_PREFIX}${executionId}:`) ||
          candidate.startsWith(`${PAYLOAD_PREFIX}${executionId}:`);
        for (const candidate of (await store.keys()).filter((item) => owned(item) && item !== recordKey).sort()) {
          await store.delete(candidate);
        }
        // The run log is a FILE and is therefore not in store.keys(); purging an
        // execution has to remove it explicitly or it outlives its run. Drop any
        // buffered rows too — writing them after the purge would resurrect the
        // execution's log.
        migratedExecutions.delete(executionId);
        logHandles.delete(executionId);
        seenKeys.delete(executionId);
        const orphaned = pendingAppends.get(executionId);
        if (orphaned) {
          pendingAppends.delete(executionId);
          if (orphaned.timer != null) clearTimeout(orphaned.timer);
          for (const w of orphaned.waiters) w.reject(new Error("execution purged before its log was flushed"));
        }
        await removeLogFor(executionId).catch(() => {});
        // Remove only this admission. Preserve concurrent IDs, and restore the
        // registry's exact absent-vs-pre-existing-empty shape with CAS.
        if ((await indexIds()).includes(executionId)) {
          const removed = await removeFromIndexExact(executionId, registryAdmission);
          if (!removed.ok) throw new Error(`failed-start registry compensation failed for ${executionId}`, { cause: error });
        }
        const recordVersion = await store.getVersion(recordKey);
        if (recordVersion) await store.compareAndDelete(recordKey, recordVersion);
        const remnants = (await store.keys()).filter(owned);
        if (remnants.length || (await indexIds()).includes(executionId)) {
          throw new Error(`failed-start compensation verification failed for ${executionId}`, { cause: error });
        }
        throw error;
      }
    });
  }

  async function rollbackUnprogressedQuota(executionId, error, { journalReceipt = null, journalStore = null, journalGuard = null } = {}) {
    return locked(async () => {
      if (!validExecutionId(executionId)) throw new Error("invalid immutable executionId");
      if (!isNativeQuotaExceededError(error)) {
        throw new TypeError("quota rollback requires a native QuotaExceededError");
      }

      const recordKey = `${RUN_PREFIX}${executionId}`;
      const recordSnapshot = await snapshotKey(recordKey);
      const record = recordSnapshot.exists ? normalizeRetention(recordSnapshot.value) : null;
      const rawIndex = await store.get(INDEX_KEY);
      const ids = Array.isArray(rawIndex) ? rawIndex : [];
      const owned = (key) => key === recordKey ||
        key === `${OUTBOX_PREFIX}${executionId}` ||
        key === `${LOG_IDX_PREFIX}${executionId}` ||
        key === `${MIGRATED_PREFIX}${executionId}` ||
        key.startsWith(`${LOG_PREFIX}${executionId}:`) ||
        key.startsWith(`${RESUME_PREFIX}${executionId}:`) ||
        key.startsWith(`${PAYLOAD_PREFIX}${executionId}:`);

      // A completed rollback is a safe no-op on retry. Unknown IDs with any
      // remnant fail closed because there is no durable record to prove that
      // the execution was unprogressed.
      if (!record) {
        const remnants = (await store.keys()).filter(owned);
        if (remnants.length === 0 && !ids.includes(executionId)) {
          active.delete(executionId);
          return { ok: true, rolledBack: true, idempotent: true, executionId, remainingKeys: [] };
        }
        return { ok: false, rolledBack: false, preserved: true, reason: "execution_authority_unreadable", executionId };
      }

      // Make the destructive decision only from the persisted record projected
      // through the same public shape returned by list()/start(). Never trust
      // caller-supplied progress or replay-safety claims.
      const observed = publicRecord(record);
      const uncertain = observed.phase !== "running" ||
        observed.pause?.requiresOwnerDecision === true ||
        observed.cancellation != null;
      if (observed.progressCount !== 0 || uncertain) {
        active.delete(executionId);
        return {
          ok: false,
          rolledBack: false,
          preserved: true,
          reason: observed.progressCount !== 0 ? "execution_progressed" : "execution_side_effect_uncertain",
          executionId,
          run: observed,
        };
      }

      active.delete(executionId);
      // Delete payload/log/resume/outbox bytes first. This both frees quota for
      // the registry rewrite and keeps the readable run authority until every
      // auxiliary delete has succeeded, so an interrupted cleanup is retryable.
      const auxiliary = (await store.keys()).filter((key) => owned(key) && key !== recordKey).sort();
      for (const key of auxiliary) await store.delete(key);
      const auxiliaryRemnants = (await store.keys()).filter((key) => owned(key) && key !== recordKey);
      if (auxiliaryRemnants.length) throw new Error(`quota rollback left execution keys: ${auxiliaryRemnants.join(",")}`);

      // Journal compensation is the destructive boundary: keep the run record
      // and registry authority until the exact receipt has been restored (or a
      // concurrent append safely replayed without this execution's rows).
      if (journalReceipt) {
        const target = journalStore ?? await resolveJournalStore(record.journalTarget);
        const journalResult = await compensateJournal(target, journalReceipt, journalGuard);
        if (!journalResult?.ok) {
          return {
            ok: false,
            rolledBack: false,
            preserved: true,
            reason: journalResult?.reason ?? "journal_compensation_failed",
            executionId,
            run: observed,
          };
        }
      }

      // Finalize the exact registry shape without clobbering concurrent IDs.
      const removed = await removeFromIndexExact(executionId, record.registryAdmission);
      if (!removed.ok) {
        return { ok: false, rolledBack: false, preserved: true, reason: removed.reason, executionId, run: observed };
      }
      const deleted = await store.compareAndDelete(recordKey, recordSnapshot.version);
      if (!deleted) {
        return { ok: false, rolledBack: false, preserved: true, reason: "record_cas_mismatch", executionId };
      }

      const remainingKeys = (await store.keys()).filter(owned);
      const remainingIndex = await store.get(INDEX_KEY);
      const stillIndexed = Array.isArray(remainingIndex) && remainingIndex.includes(executionId);
      if (remainingKeys.length || stillIndexed) {
        throw new Error(`quota rollback verification failed for ${executionId}`);
      }
      return { ok: true, rolledBack: true, idempotent: false, executionId, remainingKeys: [] };
    });
  }

  /** Record the WORST progressed-tool replay safety so recovery can decide
   * auto-resume vs paused-side-effect-uncertain from the declaration, never
   * the progress count alone. Fail-closed: a missing/unknown/mutating tool
   * makes the run non-auto-resumable. */
  /** ATOMIC pre-tool-use record: persist the call identity + the normalized
   * safety + the stable per-tool call index BEFORE any external effect runs.
   * The caller MUST await this and refuse tool execution if it throws — a
   * possibly-effectful tool must never run before its authority is durable.
   * Returns the STABLE per-tool-call key (executionId:toolName:index) that is
   * byte-identical across resume (the index lives in THIS record, never a
   * fresh run-instance UUID). */
  async function preToolUse(executionId, { toolName, safety, args = null } = {}) {
    return locked(async () => {
      if (!active.has(executionId)) throw new Error("execution is not active in this boot");
      const key = `${RUN_PREFIX}${executionId}`;
      const current = await readRecord(executionId);
      if (!current || current.bootId !== bootId || !["running", "settling"].includes(current.phase)) {
        throw new Error("durable run ownership lost");
      }
      const counts = { ...(current.toolCallCounts ?? {}) };
      let name;
      try { name = String(toolName ?? "").slice(0, 128); } catch { name = ""; } // hostile names normalize to empty (unknown)
      const index = (counts[name] ?? 0) + 1;
      counts[name] = index;
      const next = await writeRecord({
        ...current,
        heartbeatAt: now(),
        progressCount: current.progressCount + 1,
        toolSafety: current.toolSafety == null ? safety : worstSafety(current.toolSafety, safety),
        toolCallCounts: counts,
      }, current.revision);
      if (!next) throw new Error("durable pre-tool CAS failed");
      return {
        ok: true,
        callId: `${executionId}:${name}:${index}`,
        callIndex: index,
        key: perCallIdempotencyKey({ executionId, toolName: name, callIndex: index }),
      };
    });
  }

  async function recordToolSafety(executionId, classification) {
    return locked(async () => {
      if (!active.has(executionId)) throw new Error("execution is not active in this boot");
      const key = `${RUN_PREFIX}${executionId}`;
      const current = await readRecord(executionId);
      if (!current || current.bootId !== bootId || !["running", "settling"].includes(current.phase)) {
        throw new Error("durable run ownership lost");
      }
      // The FIRST recorded classification is authoritative for the first tool;
      // later tools worst-merge (mutating always wins). A null (unrecorded)
      // current value must NOT poison the merge as mutating.
      const next = await writeRecord({
        ...current,
        toolSafety: current.toolSafety == null
          ? classification
          : worstSafety(current.toolSafety, classification),
      }, current.revision);
      if (!next) throw new Error("durable run toolSafety CAS failed");
      return publicRecord(next);
    });
  }

  async function heartbeat(executionId, { progressed = false } = {}) {
    return locked(async () => {
      if (!active.has(executionId)) throw new Error("execution is not active in this boot");
      const key = `${RUN_PREFIX}${executionId}`;
      const current = await readRecord(executionId);
      if (!current || current.bootId !== bootId || !["running", "settling"].includes(current.phase)) {
        throw new Error("durable run ownership lost");
      }
      const next = await writeRecord({
        ...current,
        heartbeatAt: now(),
        progressCount: current.progressCount + (progressed ? 1 : 0),
      }, current.revision);
      if (!next) throw new Error("durable run heartbeat CAS failed");
      return publicRecord(next);
    });
  }

  async function processOutbox(executionId) {
    const outboxKey = `${OUTBOX_PREFIX}${executionId}`;
    const outbox = await store.get(outboxKey);
    if (!outbox) return null;
    const recordKey = `${RUN_PREFIX}${executionId}`;
    let record = await readRecord(executionId);
    if (!record) throw new Error(`outbox ${executionId} has no registry record`);

    const cancelling = outbox.kind === "cancellation";
    const journalStore = await resolveJournalStore(outbox.journalTarget);
    if (cancelling) {
      await replaceCancellationJournal(journalStore, {
        ...outbox.journalEntry,
        type: "cancelled",
        executionId,
      }, executionId);
    } else {
      await appendJournal(journalStore, {
        ...outbox.journalEntry,
        type: outbox.journalEntry?.type ?? "result",
        executionId,
      }, null, executionId);
    }
    await boundary(cancelling ? "after-cancel-journal" : "after-journal", executionId);

    if (outbox.threadId && outbox.threadTerminal) {
      if (cancelling) await replaceCancellationThread(outbox.threadId, executionId, outbox.threadTerminal);
      else await commitThread(outbox.threadId, executionId, outbox.threadTerminal);
    }
    await boundary(cancelling ? "after-cancel-thread" : "after-thread", executionId);

    record = await readRecord(executionId);
    const terminalPhase = cancelling ? "cancelled" : "terminal";
    if (!TERMINAL_PHASES.has(record.phase)) {
      const terminal = await writeRecord({
        ...record,
        phase: terminalPhase,
        heartbeatAt: now(),
        terminal: outbox.terminal,
      }, record.revision);
      if (!terminal) throw new Error("terminal registry CAS failed");
      record = terminal;
    }
    active.delete(executionId);
    await boundary(cancelling ? "after-cancel-cas" : "after-cas", executionId);

    await appendRegistryRow(executionId, {
      schemaVersion: 1,
      retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
      executionId,
      at: outbox.terminal?.at ?? now(),
      type: cancelling ? "cancelled" : "terminal",
      terminal: outbox.terminal,
      ...(outbox.retainedPayloadRef ? { payloadRef: outbox.retainedPayloadRef } : {}),
    });
    await store.setTrusted(outboxKey, { ...outbox, acknowledgedAt: now() });
    await boundary(cancelling ? "after-cancel-outbox-ack" : "after-outbox-ack", executionId);
    await store.delete(outboxKey);
    await boundary(cancelling ? "after-cancel-outbox-removal" : "after-outbox-removal", executionId);
    return publicRecord(record);
  }

  function cancellationOutbox(record) {
    const requestedAt = record.cancellation?.requestedAt ?? now();
    const attemptedAt = Number.isFinite(record.cancellation?.abortAttempt?.attemptedAt)
      ? record.cancellation.abortAttempt.attemptedAt
      : null;
    // Reconciliation is terminal truth, distinct from the earlier owner request.
    // It can never predate a durably recorded attempt to abort live execution.
    const reconciledAt = Math.max(now(), requestedAt, attemptedAt ?? requestedAt);
    const reason = bounded(record.cancellation?.reason, 2 * 1024) || "explicit owner cancellation";
    return {
      kind: "cancellation",
      executionId: record.executionId,
      createdAt: reconciledAt,
      journalTarget: record.journalTarget,
      threadId: record.threadId,
      terminal: { ok: false, cancelled: true, aborted: true, at: reconciledAt, requestedAt, reconciledAt, summary: "Run cancelled by owner", reason },
      journalEntry: {
        type: "cancelled",
        id: record.scheduleName ?? record.threadId ?? record.clientCorrelationId ?? record.executionId,
        result: "Run cancelled by owner",
        ok: false,
        cancelled: true,
        aborted: true,
        requestedAt,
        reconciledAt,
        reason,
      },
      threadTerminal: record.threadId ? {
        role: "error",
        content: "Run cancelled by owner",
        status: "cancelled",
        category: "cancelled",
        reason,
      } : null,
    };
  }

  async function ensureCancellationOutbox(record) {
    const key = `${OUTBOX_PREFIX}${record.executionId}`;
    const current = await store.get(key);
    if (current?.kind !== "cancellation") {
      if (current?.retainedPayloadRef) {
        await store.setTrusted(`${LOG_PREFIX}${record.executionId}:superseded-terminal`, {
          schemaVersion: 1,
          retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
          executionId: record.executionId,
          at: current.createdAt ?? now(),
          type: "superseded-terminal",
          reason: "explicit owner cancellation won before terminal commit",
          payloadRef: current.retainedPayloadRef,
        });
      }
      await store.setTrusted(key, cancellationOutbox(record));
    }
    return key;
  }

  async function cancel(executionId, { reason = "explicit owner cancellation", requestId = null, onAuthorityPersisted = null } = {}) {
    const authority = await locked(async () => {
      let record = await readRecord(executionId);
      let createdAuthority = false;
      if (!record) return { done: true, result: { ok: false, error: "run_not_found", executionId } };
      if (record.phase === "cancelled") {
        return { done: true, result: { ok: true, cancelled: true, idempotent: true, executionId, run: publicRecord(record), abortAttempt: record.cancellation?.abortAttempt ?? null } };
      }
      if (record.phase === "terminal") {
        return { done: true, result: { ok: false, error: "run_already_terminal", executionId, run: publicRecord(record) } };
      }
      if (!record.cancellation) {
        const requestedAt = now();
        const authoritative = await writeRecord({
          ...record,
          phase: "cancel-requested",
          cancellation: {
            schemaVersion: 1,
            authority: "explicit-owner",
            requestedAt,
            requestId: bounded(requestId, 200) || null,
            reason: bounded(reason, 2 * 1024) || "explicit owner cancellation",
            terminal: true,
            restartAllowed: false,
            abortAttempt: { claimedAt: requestedAt, attempted: false, ok: null, error: null },
          },
        }, record.revision);
        if (!authoritative) throw new Error("cancellation authority CAS failed");
        record = authoritative;
        createdAuthority = true;
      }
      active.delete(executionId);
      await boundary("after-cancel-authority", executionId);
      return { done: false, record, shouldAbort: createdAuthority };
    });
    if (authority.done) return authority.result;

    let abortAttempt = authority.record.cancellation?.abortAttempt ?? null;
    if (!authority.shouldAbort && abortAttempt?.attempted !== true) {
      return { ok: true, cancelled: false, cancellationPending: true, idempotent: true, executionId, run: publicRecord(authority.record), abortAttempt };
    }
    if (authority.shouldAbort) {
      if (!onAuthorityPersisted) {
        abortAttempt = { ...abortAttempt, attempted: false, attemptCount: 0, attemptedAt: null, ok: null, error: "no live abort callback registered", errors: [] };
      } else {
        const errors = [];
        for (let attemptCount = 1; attemptCount <= 2; attemptCount += 1) {
          try {
            const outcome = await onAuthorityPersisted(publicRecord(authority.record));
            abortAttempt = outcome === false
              ? { ...abortAttempt, attempted: false, attemptCount, attemptedAt: null, ok: null, error: "no live execution to abort", errors }
              : { ...abortAttempt, attempted: true, attemptCount, attemptedAt: now(), ok: true, error: null, errors };
            break;
          } catch (error) {
            errors.push(bounded(error?.message ?? error, 500));
            abortAttempt = { ...abortAttempt, attempted: true, attemptCount, attemptedAt: now(), ok: false, error: errors.at(-1), errors: [...errors] };
          }
        }
      }
    }

    return await locked(async () => {
      let record = await readRecord(executionId);
      if (!record) return { ok: false, error: "run_not_found", executionId, abortAttempt };
      if (record.cancellation && abortAttempt) {
        const updated = await writeRecord({
          ...record,
          cancellation: { ...record.cancellation, abortAttempt },
        }, record.revision);
        if (!updated) throw new Error("abort-attempt record CAS failed");
        record = updated;
        // This boundary is authority-bearing: the callback outcome and its
        // attemptedAt timestamp are durable before any cancellation outbox is
        // created. A restart here can therefore prove authority → live abort →
        // outbox ordering without inferring an in-memory callback.
        await boundary("after-cancel-abort-recorded", executionId);
      }
      if (record.phase === "cancelled") {
        return { ok: true, cancelled: true, idempotent: true, executionId, run: publicRecord(record), abortAttempt };
      }
      await ensureCancellationOutbox(record);
      await boundary("after-cancel-outbox", executionId);
      const run = await processOutbox(executionId);
      return { ok: true, cancelled: true, idempotent: false, executionId, run, abortAttempt };
    });
  }

  async function pauseForPermission(executionId, permission) {
    return locked(async () => {
      const record = await readRecord(executionId);
      if (!record) throw new Error("cannot pause an unknown execution");
      if (TERMINAL_PHASES.has(record.phase) || record.phase === "cancel-requested") return publicRecord(record);
      const request = record.resumeRequestRef ? await readResumeRequest(record) : null;
      const boundProviderBinding = request?.providerBinding ?? null;
      const boundScope = boundProviderBinding?.requestedScope ?? null;
      if (boundScope !== (permission?.requestedScope ?? null)) throw new Error("permission scope does not match bound provider identity");
      if (permission?.providerBinding != null && JSON.stringify(boundProviderBinding) !== JSON.stringify(permission.providerBinding)) {
        throw new Error("permission provider identity does not match retained binding");
      }
      const paused = await writeRecord({
        ...record,
        phase: "paused-permission",
        pause: {
          schemaVersion: 1,
          kind: "permission",
          code: bounded(permission?.code, 100) || "permission_required",
          reason: bounded(permission?.reason, 2 * 1024),
          requestedScope: bounded(permission?.requestedScope, 500) || null,
          providerBinding: structuredClone(boundProviderBinding),
          pausedAt: now(),
          visible: true,
          recoverable: true,
        },
      }, record.revision);
      if (!paused) throw new Error("permission pause CAS failed");
      active.delete(executionId);
      return publicRecord(paused);
    });
  }

  async function prepareResume(executionId, allowedPhases) {
    return locked(async () => {
      const record = await readRecord(executionId);
      if (!record) return { ok: false, error: "run_not_found", executionId };
      if (["cancelled", "cancel-requested"].includes(record.phase)) {
        return { ok: false, cancelled: true, error: "cancelled_requires_new_run", executionId };
      }
      if (!allowedPhases.includes(record.phase)) {
        return { ok: false, error: "run_not_resumable", executionId, run: publicRecord(record) };
      }
      const attempt = (record.resumeAttemptCount ?? 0) + 1;
      if (attempt > MAX_RESUME_ATTEMPTS) {
        const terminal = await terminalizeResumeFailure(record, "resume attempt limit reached before dispatch");
        return { ok: false, error: "resume_attempt_limit_reached", executionId, run: terminal };
      }
      const resumeRequest = await readResumeRequest(record);
      if (!resumeRequest) return { ok: false, error: "run_missing_resume_request", executionId };
      const token = `resume_${crypto.randomUUID?.() ?? `${now()}_${Math.random()}`}`;
      const prepared = await writeRecord({
        ...record,
        phase: "resume-dispatching",
        resumeAttemptCount: attempt,
        resumeState: { token, fromPhase: record.phase, attempt, preparedAt: now(), maxAttempts: MAX_RESUME_ATTEMPTS },
      }, record.revision);
      if (!prepared) throw new Error("resume preparation CAS failed");
      return { ok: true, prepared: true, executionId, token, run: publicRecord(prepared), resumeRequest };
    });
  }

  async function pauseForProviderChange(executionId, identities) {
    return locked(async () => {
      const record = await readRecord(executionId);
      if (!record) return { ok: false, error: "run_not_found", executionId };
      if (["cancelled", "cancel-requested"].includes(record.phase)) return { ok: false, cancelled: true, error: "cancelled_requires_new_run", executionId };
      const paused = await writeRecord({
        ...record,
        phase: "paused-provider-change",
        pause: { schemaVersion: 1, kind: "provider-change", reason: "provider identity changed since this run was accepted", expected: identities?.expected ?? null, actual: identities?.actual ?? null, pausedAt: now(), visible: true, recoverable: true, automaticRetry: false },
      }, record.revision);
      active.delete(executionId);
      return { ok: false, paused: true, error: "provider_identity_changed", executionId, run: publicRecord(paused) };
    });
  }

  async function resumeAfterPermission(executionId) {
    return await prepareResume(executionId, ["paused-permission", "paused-provider-change", "paused-side-effect-uncertain"]);
  }

  async function resumeAfterInterruption(executionId) {
    return await prepareResume(executionId, ["paused-interruption"]);
  }

  async function activateResume(executionId, token, currentProviderBinding = null, allowProviderChange = false) {
    return locked(async () => {
      const record = await readRecord(executionId);
      if (!record) return { ok: false, error: "run_not_found", executionId };
      if (["cancelled", "cancel-requested"].includes(record.phase)) return { ok: false, cancelled: true, error: "cancelled_requires_new_run", executionId };
      if (record.phase !== "resume-dispatching" || record.resumeState?.token !== token) return { ok: false, error: "resume_dispatch_token_mismatch", executionId };
      const request = await readResumeRequest(record);
      const expected = request?.providerBinding ?? null;
      const sameProvider = expected && currentProviderBinding && JSON.stringify(expected) === JSON.stringify(currentProviderBinding);
      if (!sameProvider && !allowProviderChange) {
        const paused = await writeRecord({ ...record, phase: "paused-provider-change", pause: { schemaVersion: 1, kind: "provider-change", reason: "provider identity changed since this run was accepted", expected, actual: currentProviderBinding, pausedAt: now(), visible: true, recoverable: true, automaticRetry: false } }, record.revision);
        return { ok: false, paused: true, error: "provider_identity_changed", executionId, run: publicRecord(paused) };
      }
      if (!sameProvider && allowProviderChange) {
        request.providerBinding = structuredClone(currentProviderBinding);
        await persistResumeRequest(executionId, request);
      }
      const running = await writeRecord({ ...record, phase: "running", bootId, heartbeatAt: now(), resumedAt: now(), pause: null }, record.revision);
      if (!running) throw new Error("resume activation CAS failed");
      active.add(executionId);
      return { ok: true, executionId, run: publicRecord(running) };
    });
  }

  // Callers hold the registry mutex. processOutbox intentionally shares that
  // critical section with settle/cancel so the terminal triple is serialized.
  async function terminalizeResumeFailure(record, error) {
    const executionId = record.executionId;
    if (record.phase === "cancel-requested" || record.cancellation) {
      await ensureCancellationOutbox(record);
      return await processOutbox(executionId);
    }
    if (TERMINAL_PHASES.has(record.phase)) return publicRecord(record);
    const key = `${OUTBOX_PREFIX}${executionId}`;
    await boundary("before-resume-failure-outbox", executionId);
    if (!(await store.has(key))) {
      const at = now();
      await store.setTrusted(key, {
        kind: "resume-failure", executionId, createdAt: at, journalTarget: record.journalTarget, threadId: record.threadId,
        terminal: { ok: false, at, summary: "Run could not be resumed after three attempts", error: bounded(error, 2 * 1024) },
        journalEntry: { type: "result", id: record.threadId ?? record.clientCorrelationId ?? executionId, result: `Run could not be resumed: ${bounded(error, 2 * 1024)}`, ok: false },
        threadTerminal: record.threadId ? { role: "error", content: "Run could not be resumed after three attempts", status: "error", category: "resume-failed", reason: bounded(error, 2 * 1024), action: "Inspect retained logs and start a new run." } : null,
      });
    }
    await boundary("after-resume-failure-outbox", executionId);
    return await processOutbox(executionId);
  }

  async function failResumeDispatch(executionId, token, error) {
    return locked(async () => {
      const record = await readRecord(executionId);
      if (!record) return { ok: false, error: "run_not_found", executionId };
      if (["cancelled", "cancel-requested"].includes(record.phase)) return { ok: false, cancelled: true, error: "cancelled_requires_new_run", executionId };
      if (record.phase !== "resume-dispatching" || record.resumeState?.token !== token) return { ok: false, error: "resume_dispatch_already_resolved", executionId, run: publicRecord(record) };
      const exhausted = (record.resumeAttemptCount ?? 0) >= MAX_RESUME_ATTEMPTS;
      if (exhausted) {
        const terminal = await terminalizeResumeFailure(record, error);
        return { ok: false, error: "resume_attempt_limit_reached", executionId, run: terminal };
      }
      const phase = record.resumeState.fromPhase || "paused-interruption";
      const paused = await writeRecord({
        ...record,
        phase,
        pause: { schemaVersion: 1, kind: "resume-dispatch", reason: bounded(error, 2 * 1024), pausedAt: now(), visible: true, recoverable: true, automaticRetry: true },
        resumeState: { ...record.resumeState, failedAt: now(), error: bounded(error, 2 * 1024), exhausted: false },
      }, record.revision);
      if (!paused) throw new Error("resume failure CAS failed");
      active.delete(executionId);
      return { ok: false, error: "resume_dispatch_failed", executionId, run: publicRecord(paused) };
    });
  }

  async function settle(executionId, payload) {
    return locked(async () => {
      const recordKey = `${RUN_PREFIX}${executionId}`;
      let record = await readRecord(executionId);
      if (!record) throw new Error("cannot settle an unknown execution");
      const outboxKey = `${OUTBOX_PREFIX}${executionId}`;
      if (record.phase === "cancel-requested" || record.cancellation) {
        await ensureCancellationOutbox(record);
        return await processOutbox(executionId);
      }
      if (TERMINAL_PHASES.has(record.phase) && !(await store.has(outboxKey))) {
        active.delete(executionId);
        return publicRecord(record);
      }
      await boundary("before-outbox", executionId);
      if (!(await store.has(outboxKey))) {
        const at = Number.isFinite(payload?.at) ? payload.at : now();
        const ok = payload?.ok === true;
        const fullResult = String(payload?.result ?? payload?.error ?? "");
        const retainedPayloadRef = await persistJsonPayload(executionId, "terminal", {
          ok,
          at,
          result: fullResult,
          summary: payload?.summary ?? null,
          aborted: payload?.aborted === true,
          errorCategory: payload?.errorCategory ?? null,
          errorReason: payload?.errorReason ?? null,
          errorAction: payload?.errorAction ?? null,
        });
        const result = bounded(fullResult, 16 * 1024);
        const outbox = {
          executionId,
          createdAt: at,
          journalTarget: record.journalTarget,
          threadId: record.threadId,
          retainedPayloadRef,
          terminal: {
            ok,
            at,
            retainedPayloadRef,
            summary: bounded(payload?.summary ?? result),
            ...(payload?.aborted === true ? { aborted: true } : {}),
          },
          journalEntry: {
            type: "result",
            id: payload?.logicalId ?? record.scheduleName ?? record.threadId ?? record.clientCorrelationId ?? executionId,
            result,
            ok,
            ...(payload?.aborted === true ? { aborted: true } : {}),
          },
          threadTerminal: record.threadId
            ? ok
              ? { role: "assistant", content: result, status: "done" }
              : {
                role: "error",
                content: result || "run failed",
                status: "error",
                category: payload?.errorCategory ?? "error",
                reason: bounded(payload?.errorReason, 2 * 1024) || null,
                action: bounded(payload?.errorAction, 2 * 1024) || null,
                tool: bounded(payload?.failedTool, 200) || null,
              }
            : null,
        };
        // The full recoverable payload is durable before journal, thread, or
        // registry terminal state is changed.
        await store.setTrusted(outboxKey, outbox);
      }
      await boundary("after-outbox", executionId);
      record = await readRecord(executionId);
      if (record.phase === "running") {
        const settling = await writeRecord({ ...record, phase: "settling", heartbeatAt: now() }, record.revision);
        if (!settling) throw new Error("settling registry CAS failed");
      }
      return await processOutbox(executionId);
    });
  }

  async function recover() {
    return locked(async () => {
      const keys = await store.keys();
      const outboxIds = keys
        .filter((key) => key.startsWith(OUTBOX_PREFIX))
        .map((key) => key.slice(OUTBOX_PREFIX.length))
        .filter(validExecutionId)
        .sort();
      // A persisted cancellation tombstone wins over any partially processed
      // ordinary terminal outbox. Reconstruct its cancellation outbox after a
      // crash between authority and outbox persistence.
      for (const executionId of await indexIds()) {
        const record = await readRecord(executionId);
        if (record?.phase === "cancel-requested" || (record?.cancellation && !TERMINAL_PHASES.has(record.phase))) {
          await ensureCancellationOutbox(record);
          if (!outboxIds.includes(executionId)) outboxIds.push(executionId);
        }
      }
      outboxIds.sort();
      for (const executionId of [...new Set(outboxIds)]) await processOutbox(executionId);

      const ids = await indexIds();
      const interrupted = [];
      for (const executionId of ids) {
        const key = `${RUN_PREFIX}${executionId}`;
        const record = await readRecord(executionId);
        if (!record || !["running", "settling", "resume-dispatching"].includes(record.phase)) continue;
        if (active.has(executionId) && record.bootId === bootId) continue;
        if (await store.has(`${OUTBOX_PREFIX}${executionId}`)) continue;
        if (record.phase === "resume-dispatching" && (record.resumeAttemptCount ?? 0) >= MAX_RESUME_ATTEMPTS) {
          await terminalizeResumeFailure(record, record.resumeState?.error ?? "worker ended during the final resume dispatch attempt");
          continue;
        }
        const dispatchInterrupted = record.phase === "resume-dispatching";
        // The replay-safety gate: an interruption after progress is uncertain
        // ONLY when the progressed tools were not explicitly read-only/idempotent.
        // Fail-closed — the record defaults to mutating until a tool's declared
        // safety is recorded (unknown/missing/mutating -> uncertain).
        const progressed = (record.progressCount ?? 0) > 0;
        const progressedSafety = record.toolSafety ?? REPLAY_MUTATING;
        const uncertain = !dispatchInterrupted && progressed &&
          progressedSafety !== "read-only" && progressedSafety !== "idempotent";
        const phase = dispatchInterrupted
          ? (record.resumeState?.fromPhase || "paused-interruption")
          : uncertain ? "paused-side-effect-uncertain" : "paused-interruption";
        const next = await writeRecord({
          ...record,
          phase,
          lastKnownPhase: record.phase,
          pause: {
            schemaVersion: 1,
            kind: dispatchInterrupted ? "resume-dispatch" : uncertain ? "side-effect-uncertain" : "interruption",
            reason: dispatchInterrupted
              ? "service worker ended while resume dispatch ownership was being established"
              : uncertain
                ? "interruption followed tool progress; external side-effect outcome is uncertain"
                : "service-worker or browser execution ended before tool progress",
            pausedAt: now(),
            visible: true,
            ...(uncertain ? { requiresOwnerDecision: true } : { recoverable: true }),
            automaticRetry: dispatchInterrupted || !uncertain,
          },
          policy: DURABLE_RUN_POLICY,
        }, record.revision);
        if (next) interrupted.push(publicRecord(next));
      }
      return { recoveredOutboxes: outboxIds.length, interrupted, orphaned: [] };
    });
  }

  async function list() {
    return locked(async () => {
      const runs = [];
      for (const executionId of await indexIds()) {
        const record = await readRecord(executionId);
        if (record) runs.push(publicRecord(record));
      }
      return { bootId, policy: DURABLE_RUN_POLICY, retentionPolicy: RUN_RETENTION_POLICY, runs };
    });
  }

  /** UX-008 retry authority: the stored prompt + original dispatch route of a
   * TERMINAL FAILED (non-aborted) run, for owner-visible Retry. Read-only —
   * retry itself re-dispatches as a NEW execution (the failed record stays as
   * honest history; retention is retain-all/explicit-clear-only). */
  const DISMISSED_KEY = "run-dismissed-failed";
  const DISMISSED_CAP = 512;

  /** The dismissed-failed-runs tombstone: execution ids the owner explicitly
   * dismissed from the Tasks sidebar. Deliberately ONLY ids — no prompt text,
   * no summaries — so the tombstone can never leak run content. Bounded LRU:
   * the oldest ids fall off the cap (and die with their records anyway). */
  async function readDismissedIds() {
    const rec = await store.get(DISMISSED_KEY);
    const ids = Array.isArray(rec?.ids) ? rec.ids.filter(validExecutionId) : [];
    return new Set(ids);
  }

  async function dismissedFailedRuns() {
    return locked(async () => [...(await readDismissedIds())]);
  }

  async function dismissFailedRuns(ids) {
    return locked(async () => {
      const incoming = (Array.isArray(ids) ? ids : [ids])
        .map((id) => String(id ?? ""))
        .filter(validExecutionId);
      if (!incoming.length) return { ok: false, error: "no valid executionIds" };
      const current = await readDismissedIds();
      for (const id of incoming) current.add(id);
      // LRU by insertion: newest last, cap trims the oldest.
      const next = [...current].slice(-DISMISSED_CAP);
      await store.setTrusted(DISMISSED_KEY, {
        schemaVersion: 1,
        retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
        ids: next,
      });
      return { ok: true, dismissed: incoming.length, tracked: next.length };
    });
  }

  /** Agent-deletion cascade (owner: a deleted agent's failures must not linger
   * in the Tasks panel or the durable registry): purge the TERMINAL records of
   * the given agent surface refs ("named:<slug>", "background:<id>") — record,
   * index admission, resume-request payload (the stored prompt), logs, and
   * payload chunks. Running/paused runs are NEVER touched here; the live-run
   * abort in the delete path owns those. Aborted terminal records go too — the
   * agent itself is gone, and its history must not resurrect under a reused
   * id. Idempotent and per-record CAS-guarded: a concurrent writer only skips
   * that one record. */
  async function purgeFailedForAgent(agentIds) {
    return locked(async () => {
      const refs = (Array.isArray(agentIds) ? agentIds : [agentIds])
        .map((id) => String(id ?? ""))
        .filter(Boolean);
      if (!refs.length) return { ok: false, error: "no agentIds" };
      const refSet = new Set(refs);
      const index = await store.get(INDEX_KEY);
      const ids = Array.isArray(index) ? index.filter(validExecutionId) : [];
      let purged = 0;
      for (const executionId of ids) {
        const record = await readRecord(executionId);
        if (!record) continue;
        if (!refSet.has(record.agentId)) continue;
        if (!TERMINAL_PHASES.has(record.phase)) continue;
        const terminal = record.terminal ?? null;
        if (!terminal || terminal.ok !== false) continue;
        const recordKey = `${RUN_PREFIX}${executionId}`;
        const owned = (candidate) => candidate === recordKey ||
          candidate === `${OUTBOX_PREFIX}${executionId}` ||
          candidate === `${LOG_IDX_PREFIX}${executionId}` ||
          candidate === `${MIGRATED_PREFIX}${executionId}` ||
          candidate.startsWith(`${RESUME_PREFIX}${executionId}:`) ||
          candidate.startsWith(`${LOG_PREFIX}${executionId}:`) ||
          candidate.startsWith(`${PAYLOAD_PREFIX}${executionId}:`);
        for (const key of (await store.keys()).filter(owned).sort()) await store.delete(key);
        const removed = await removeFromIndexExact(executionId, record.registryAdmission);
        if (!removed.ok) continue; // CAS raced — the record stays, honestly
        const version = await store.getVersion(recordKey);
        if (recordKey && (await store.has(recordKey))) await store.compareAndDelete(recordKey, version);
        purged += 1;
      }
      // Tombstones for purged ids are dead weight — prune them with the records.
      const dismissed = await readDismissedIds();
      if (dismissed.size) {
        const alive = await store.get(INDEX_KEY);
        const aliveIds = new Set(Array.isArray(alive) ? alive.filter(validExecutionId) : []);
        const next = [...dismissed].filter((id) => aliveIds.has(id));
        if (next.length !== dismissed.size) {
          await store.setTrusted(DISMISSED_KEY, {
            schemaVersion: 1,
            retentionPolicyVersion: RUN_RETENTION_POLICY.policyVersion,
            ids: next,
          });
        }
      }
      return { ok: true, purged };
    });
  }

  async function getRetryRequest(executionId) {
    return locked(async () => {
      const id = String(executionId ?? "");
      if (!validExecutionId(id)) return { ok: false, error: "invalid executionId" };
      const record = await readRecord(id);
      if (!record) return { ok: false, error: "unknown execution" };
      if (!TERMINAL_PHASES.has(record.phase)) return { ok: false, error: "run is still active" };
      const terminal = record.terminal ?? null;
      if (!terminal || terminal.ok !== false) return { ok: false, error: "run did not fail" };
      if (terminal.aborted === true) return { ok: false, error: "an aborted run is not retryable" };
      let request = null;
      try {
        request = record.resumeRequestRef || record.resumeRequest
          ? await readResumeRequest(record)
          : null;
      } catch {
        request = null; // a corrupt/unreadable stored prompt is honestly "no stored prompt"
      }
      const task = String(request?.task ?? "");
      if (!task.trim()) return { ok: false, error: "no stored prompt" };
      return {
        ok: true,
        executionId: id,
        phase: record.phase,
        summary: bounded(terminal.summary ?? "", 300),
        request: {
          route: String(request.route ?? ""),
          task,
          attachments: structuredClone(Array.isArray(request.attachments) ? request.attachments : []),
          history: structuredClone(Array.isArray(request.history) ? request.history : []),
          scheduled: !!request.scheduled,
          scoped: !!request.scoped,
          threadId: request.threadId ?? null,
          routeArgs: structuredClone(request.routeArgs ?? {}),
        },
      };
    });
  }

  /** Register first, buffer mutations during snapshot, then drain only newer revisions. */
  function attachPort(port) {
    let buffering = true;
    let closed = false;
    const buffer = [];
    const listener = (event) => {
      if (closed) return;
      if (buffering) buffer.push(event);
      else {
        try { port.postMessage(event); } catch { /* disconnect races are benign */ }
      }
    };
    listeners.add(listener);
    const detach = () => {
      closed = true;
      listeners.delete(listener);
    };
    port.onDisconnect?.addListener(detach);
    (async () => {
      const snapshot = await list();
      if (closed) return;
      const seen = new Map(snapshot.runs.map((run) => [run.executionId, run.revision]));
      port.postMessage({ type: "run-snapshot", ...snapshot });
      buffering = false;
      for (const event of buffer) {
        if (event.revision <= (seen.get(event.executionId) ?? 0)) continue;
        port.postMessage(event);
        seen.set(event.executionId, event.revision);
      }
      buffer.length = 0;
    })().catch(() => detach());
    return detach;
  }

  return {
    bootId,
    start,
    heartbeat,
    preToolUse,
    recordToolSafety,
    rollbackUnprogressedQuota,
    settle,
    cancel,
    getRetryRequest,
    dismissedFailedRuns,
    dismissFailedRuns,
    purgeFailedForAgent,
    pauseForPermission,
    pauseForProviderChange,
    resumeAfterPermission,
    resumeAfterInterruption,
    activateResume,
    failResumeDispatch,
    appendLog,
    listLogs,
    listThreadExecutions,
    recover,
    list,
    attachPort,
    isActive: (executionId) => active.has(executionId),
  };
}

export const durableRuns = createDurableRunRegistry();
