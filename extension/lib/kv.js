// lib/kv.js — guarded extension key-value storage over chrome.storage.local.
//
// ALL permissions are OPTIONAL (Paul's hard requirement). chrome.storage.local
// requires the optional "storage" permission, so until the owner grants it the
// extension must still boot and run. This shim therefore falls back to an
// in-memory session store when the permission is absent (nothing persists
// across worker restarts until storage is enabled). `storageAvailable()` lets
// the Settings capability panel surface the "session-only" state honestly.
//
// Availability is checked at CALL time (never cached at module load) so a
// freshly-granted permission is picked up without a worker reload.

const session = new Map();
let warned = false;

function available() {
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

/** Whether the persistent chrome.storage backend is currently available. */
export function storageAvailable() {
  return available();
}

/** Mirror chrome.storage.local.get(key|array|null). */
export async function kvGet(keys) {
  if (!available()) {
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
  try {
    return await chrome.storage.local.get(keys);
  } catch (e) {
    warnOnce();
    // Mirror the in-memory fallback on read failure too (storage can fail).
    const out = {};
    for (const k of (Array.isArray(keys) ? keys : [keys])) {
      if (k != null && session.has(k)) out[k] = clone(session.get(k));
    }
    return out;
  }
}

/** Mirror chrome.storage.local.set(obj). */
export async function kvSet(obj) {
  if (!available()) {
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
    warnOnce();
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) session.delete(k);
      else session.set(k, clone(v));
    }
  }
}

/** Mirror chrome.storage.local.remove(key|array). */
export async function kvRemove(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  if (!available()) {
    warnOnce();
    for (const k of list) session.delete(k);
    return;
  }
  try {
    await chrome.storage.local.remove(list);
  } catch (e) {
    warnOnce();
    for (const k of list) session.delete(k);
  }
}

/** Test hook: reset the in-memory fallback (unit tests). */
export function __resetSessionForTest() {
  session.clear();
  warned = false;
}
