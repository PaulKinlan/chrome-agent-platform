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

const session = new Map();
let warned = false;

/** Is the persistent chrome.storage.local backend currently available?
 * Availability is checked at CALL time (never cached at module load) so a
 * freshly-granted permission is picked up without a worker reload. */
export function storageAvailable() {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
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
  if (!storageAvailable()) {
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
}

/** Mirror chrome.storage.local.set(obj). Fails closed on backend failure. */
export async function kvSet(obj) {
  if (!storageAvailable()) {
    warnOnce();
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) session.delete(k);
      else session.set(k, clone(v));
    }
    return;
  }
  try {
    await chrome.storage.local.set(obj);
  } catch (e) {
    throw new StorageBackendError("set", e);
  }
}

/** Mirror chrome.storage.local.remove(key|array). Fails closed on failure. */
export async function kvRemove(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (!storageAvailable()) {
    warnOnce();
    for (const k of list) session.delete(k);
    return;
  }
  try {
    await chrome.storage.local.remove(list);
  } catch (e) {
    throw new StorageBackendError("remove", e);
  }
}

/** Test hook: reset the in-memory fallback (unit tests). */
export function __resetSessionForTest() {
  session.clear();
  warned = false;
}
