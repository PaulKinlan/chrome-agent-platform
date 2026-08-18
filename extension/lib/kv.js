// lib/kv.js — guarded extension key-value storage over chrome.storage.local.
//
// ALL permissions are OPTIONAL (Paul's hard requirement). chrome.storage.local
// requires the optional "storage" permission, so until the owner grants it the
// extension must still boot and run. Two DISTINCT situations must never be
// conflated (the round-15 blocker):
//
//   1. storage PERMISSION ABSENT  → `chrome.storage.local` is undefined. The
//      extension degrades to an in-memory session store (nothing persists).
//   2. storage PERMISSION PRESENT but a WRITE/READ FAILS (quota exceeded, I/O
//      error) → this is a REAL backend failure and must REJECT (fail closed),
//      never silently fall back to a session value that contradicts what the
//      persistent backend actually holds.
//
// A destructive revocation or a heartbeat that silently "succeeds" against a
// failed backend is a security failure: the caller would report {revoked:true}
// while the grant persists, or keep committing side effects without durable
// heartbeat proof. So when the backend is AVAILABLE, `kvSet`/`kvRemove`/`kvGet`
// THROW on failure instead of swallowing it.
//
// SESSION FALLBACK + REALM AUTHORITY: the in-memory `session` Map is
// module/realm-local — the service worker, Settings, NTP and other extension
// pages each get their OWN copy. Shared state (provider, theme, browser-control
// grant, enrollment) must therefore have ONE authority. All page surfaces route
// their key-value access through the service worker (the `kv.get`/`kv.set`/
// `kv.remove` message routes), so the SW's session Map is the single authority
// when storage is absent. Pages must NEVER call kv* directly for shared state.
//
// The storage-mode state below is OWNED in this module's closure — it is NOT
// exported, and there is no reset/setter API (the unit-test harness resets by
// re-importing a FRESH module instance via a cache-busted dynamic import, so no
// shipped state/mutation surface exists for tests to reach).
const session = new Map();
let warned = false;
let migrated = false;

// ---- storage-mode state machine (round-18 blocker 3) ----
// Snapshot→remove→re-enable-migrate must be ATOMIC with respect to every
// concurrent KV read/write/remove. The reproduced race: a concurrent
// `kvSet(x=v2)` landed AFTER the disable snapshot copied `x=v1` but BEFORE the
// permission removal committed; the session then held stale `v1` and re-enable
// migration overwrote the newer `v2`. One storage-mode mutex serializes the
// snapshot, the permission removal, the onAdded migration, and EVERY KV
// operation, so a write is either (a) fully before the snapshot (the snapshot
// sees it), or (b) fully after the removal (it is a session write the
// re-enable migration merges).
let storageModeMutex = Promise.resolve();
/** Run `fn` while holding the storage-mode lock. All KV operations + the
 * storage permission transition run under this lock, so they are atomic w.r.t.
 * each other. */
export function withStorageModeLock(fn) {
  const run = storageModeMutex.then(fn, fn);
  storageModeMutex = run.then(() => {}, () => {});
  return run;
}

/** Is the persistent chrome.storage.local backend currently available?
 * Availability is checked at CALL time (never cached at module load) so a
 * freshly-granted permission is picked up without a worker reload. This is now
 * ASYNC: after `chrome.permissions.remove({permissions:["storage"]})` the
 * `chrome.storage.local` OBJECT remains truthy but its methods reject with
 * "not available in this context" (the round-17 blocker — the old truthiness
 * check classified permission absence as a backend failure). The authoritative
 * signal is `chrome.permissions.contains({permissions:["storage"]})`. */
export async function storageAvailable() {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return false;
    if (chrome.permissions?.contains) {
      try {
        return await chrome.permissions.contains({ permissions: ["storage"] });
      } catch {
        // permissions API threw — fall back to the object-truthiness check below
        // (unit-test mocks provide chrome.storage but no chrome.permissions).
      }
    }
    return true;
  } catch {
    return false;
  }
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function warnOnce() {
  if (!warned) {
    warned = true;
    console.warn(
      "storage permission not granted — changes are session-only until enabled in Settings",
    );
  }
}

/** The error thrown when the backend is AVAILABLE but the operation FAILS.
 * Callers (revocation, heartbeat) treat this as a real failure and fail closed. */
export class StorageBackendError extends Error {
  constructor(op, cause) {
    super(
      `chrome.storage.local.${op} failed: ${String(cause?.message ?? cause)}`,
    );
    this.name = "StorageBackendError";
    this.op = op;
    this.cause = cause;
  }
}

/** Mirror chrome.storage.local.get(key|array|null). */
export async function kvGet(keys) {
  return withStorageModeLock(async () => {
    await waitForMigration();
    if (!(await storageAvailable())) {
      warnOnce();
      const out = {};
      if (keys == null) {
        for (const [k, v] of session) out[k] = clone(v);
        return out;
      }
      for (const k of (Array.isArray(keys) ? keys : [keys])) {
        if (k != null && session.has(k)) out[k] = clone(session.get(k));
      }
      return out;
    }
    // Backend available: a read failure is a REAL failure — never return a
    // stale session value that contradicts the persistent backend.
    try {
      return await chrome.storage.local.get(keys);
    } catch (e) {
      throw new StorageBackendError("get", e);
    }
  });
}

/** Mirror chrome.storage.local.set(obj). Returns "durable" when the
 * persistent backend was written, "session" when the permissionless in-memory
 * fallback was used (nothing survives a worker restart), and FAILS CLOSED
 * (throws StorageBackendError) when the backend is available but the write
 * fails. */
export async function kvSet(obj) {
  return withStorageModeLock(async () => {
    await waitForMigration();
    if (!(await storageAvailable())) {
      warnOnce();
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) session.delete(k);
        else session.set(k, clone(v));
      }
      return "session";
    }
    try {
      await chrome.storage.local.set(obj);
      return "durable";
    } catch (e) {
      throw new StorageBackendError("set", e);
    }
  });
}

/** Mirror chrome.storage.local.remove(key|array). Fails closed on failure. */
export async function kvRemove(keys) {
  return withStorageModeLock(async () => {
    await waitForMigration();
    const list = Array.isArray(keys) ? keys : [keys];
    if (!(await storageAvailable())) {
      warnOnce();
      for (const k of list) session.delete(k);
      return;
    }
    try {
      await chrome.storage.local.remove(list);
    } catch (e) {
      throw new StorageBackendError("remove", e);
    }
  });
}

let migrationInFlight = null;

/** Await any in-flight session→storage migration so a concurrent KV operation
 * cannot race the migration and lose a write (the round-17 "serialize migration
 * with every KV operation" finding). migrateSessionToStorage itself must NOT
 * await this (it would deadlock on its own promise). */
async function waitForMigration() {
  if (migrationInFlight) await migrationInFlight;
}

/** Snapshot the persistent backend into the in-memory session Map. Called BEFORE
 * the optional `storage` permission is removed so the session-only period starts
 * with the current data (a Disable must not make settings appear empty, and a
 * re-enable must merge session changes back rather than resurrect stale values).
 * Runs under the storage-mode lock; the SW's storage-Disable path holds the SAME
 * lock across snapshot + permission removal so no concurrent write can slip
 * between them (the round-18 storage-transition race). */
export async function snapshotPersistentToSession() {
  return withStorageModeLock(snapshotPersistentToSessionLocked);
}

/** The LOCKED snapshot body (no re-acquisition). Exported so the SW can hold
 * the storage-mode lock across snapshot + permission removal + reset in one
 * atomic transition — see `capability.revoke("storage")`. */
export async function snapshotPersistentToSessionLocked() {
  if (!(await storageAvailable())) return;
  try {
    const all = await chrome.storage.local.get(null);
    for (const [k, v] of Object.entries(all)) session.set(k, clone(v));
  } catch (e) {
    // A failed snapshot must not be silent: the owner is about to Disable
    // storage, and losing the persistent state would be a data-loss bug.
    throw new StorageBackendError("snapshot", e);
  }
}

/** Reset the migration state on every storage-permission TRANSITION (grant or
 * removal). After a Disable→Enable cycle the session fallback holds changes made
 * during the disabled period; `migrated` must be cleared so the next grant
 * re-migrates them (the round-17 blocker: `migrated` never reset → re-enable
 * restored only the old persistent values). */
export function resetStorageTransition() {
  migrated = false;
}

/** Migrate the SW's session fallback into chrome.storage.local when the optional
 * `storage` permission is granted LATER. Until then, kv* used the realm-local
 * session Map; once storage becomes available, kv* switches straight to the
 * persistent backend, which would otherwise ORPHAN the session data (a genuine
 * probe showed the configured provider resetting to demo on grant — the round-16
 * migration finding). Migrate transactionally + idempotently: copy every session
 * entry into the persistent store, then clear the session fallback. A failure
 * leaves the session Map intact (never silently lose the configured state).
 * Runs under the storage-mode lock so a re-enable migration is atomic w.r.t.
 * concurrent KV writes (the round-18 storage-transition race). */
export async function migrateSessionToStorage() {
  if (migrated) return;
  // Install the migration barrier SYNCHRONOUSLY (set `migrationInFlight` BEFORE
  // any await) so a concurrent KV operation that enters AFTER the permission
  // grant but BEFORE this migration runs cannot read stale persistent state
  // (the round-19 blocker: the old code awaited `storageAvailable()` FIRST, so
  // `migrationInFlight` was still null during that await and a concurrent kvGet
  // passed `waitForMigration()` and read the stale persistent backend). The
  // availability check now runs INSIDE the storage-mode lock, so it is atomic
  // with every KV operation.
  if (!migrationInFlight) {
    migrationInFlight = withStorageModeLock(async () => {
      if (migrated) return;
      if (!(await storageAvailable())) return;
      const entries = {};
      for (const [k, v] of session) entries[k] = clone(v);
      if (Object.keys(entries).length === 0) {
        migrated = true;
        return;
      }
      // Write session values to the persistent store. A write failure REJECTS (the
      // session Map is preserved for a retry, never silently dropped).
      try {
        await chrome.storage.local.set(entries);
        session.clear();
        migrated = true;
      } catch (e) {
        throw new StorageBackendError("set", e);
      }
    }).finally(() => {
      migrationInFlight = null;
    });
  }
  await migrationInFlight;
}
