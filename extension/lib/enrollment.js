// lib/enrollment.js — per-origin content-script enrollment.
//
// The extension does NOT inject MAIN-world / isolated-world scripts into every
// page (the <all_urls> STATIC content_scripts are removed — that was the
// privacy issue: MAIN-world discovery enumerating every page's globals). A site
// becomes a sub-agent only after the user enrolls its origin: we register the
// discovery scripts for it with chrome.scripting.registerContentScripts
// (dynamic, per-origin, never a static <all_urls> content script). The host
// permission is OPTIONAL and per-origin (no permanent <all_urls> authority):
// the owner grants the exact origin from the Settings page (a real gesture),
// then this module registers only that origin's scripts.

import { canonicalOrigin } from "./memory.js";
import { kvGet, kvSet } from "./kv.js";

// content/bridge-auth.js runs FIRST in each world: it defines the shared MAC
// primitive (globalThis.CapBridgeAuth) that authenticates every MAIN↔isolated
// bridge message (the nonce never transits the broadcast postMessage channel).
const BRIDGE_AUTH_JS = "content/bridge-auth.js";
const MAIN_WORLD_JS = "content/main-world.js";
const BRIDGE_JS = "content/content-script.js";

// A cleanup-pending registry, stored INDEPENDENTLY of active enrollment so a
// tombstoned origin (hidden from listOrigins) still retains a retryable cleanup
// obligation until its dynamic scripts, host permission, and OPFS are each
// CONFIRMED removed (the round-17 non-retryable finding: listOrigins hides the
// tombstone, so Settings dropped the only Disenroll control with no Retry).
const CLEANUP_KEY = "cap:pendingCleanup";

// A GLOBAL mutex serializes the pending-cleanup registry read-modify-write.
// `markCleanupPending`/`clearCleanupPending` previously did unlocked
// kvGet→kvSet, so concurrent failures for DIFFERENT origins could overwrite one
// another (the round-18 finding: the registry RMW raced). One lock makes the
// registry authoritative across origins.
let cleanupMutex = Promise.resolve();
function withCleanupLock(fn) {
  const run = cleanupMutex.then(fn, fn);
  cleanupMutex = run.then(() => {}, () => {});
  return run;
}

export async function markCleanupPending(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return;
  return withCleanupLock(async () => {
    const s = await kvGet(CLEANUP_KEY);
    const map = { ...(s[CLEANUP_KEY] ?? {}) };
    map[canonical] = Date.now();
    await kvSet({ [CLEANUP_KEY]: map });
  });
}

export async function clearCleanupPending(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return;
  return withCleanupLock(async () => {
    const s = await kvGet(CLEANUP_KEY);
    const map = { ...(s[CLEANUP_KEY] ?? {}) };
    delete map[canonical];
    await kvSet({ [CLEANUP_KEY]: map });
  });
}

export async function listPendingCleanup() {
  return withCleanupLock(async () => {
    const s = await kvGet(CLEANUP_KEY);
    return Object.keys(s[CLEANUP_KEY] ?? {}).sort();
  });
}

/** Deterministic, injective script id per (origin, role). */
function scriptId(origin, role) {
  return `cap-${encodeURIComponent(origin)}-${role}`;
}

// A per-origin promise chain serializes create/delete/registration so two
// concurrent lifecycle operations for the SAME origin can never interleave
// (a delete racing a create, or a re-registration racing an unregister).
const originLocks = new Map();
/** Run `fn` serially per canonical origin. */
export function withOriginLock(origin, fn) {
  const key = canonicalOrigin(origin) ?? String(origin);
  const prev = originLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  originLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

/**
 * Register the MAIN-world + isolated-world discovery scripts for an origin ONLY
 * when the optional host permission is ALREADY granted. This route is called
 * from the owner-gesture enrollment path (Settings), where the permission was
 * requested via chrome.permissions.request — a service worker has no user
 * gesture, so it must NEVER attempt the request itself (it would be denied or
 * throw, and could hang an agent.create).
 */
export async function ensureOriginScriptsRegistered(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return { ok: false, error: "invalid origin" };
  const matches = [`${canonical}/*`];

  const has = await chrome.permissions.contains({ origins: matches });
  if (!has) {
    // Honest: the host permission was NOT granted — the origin can be enrolled
    // in memory but its scripts must not run until the owner grants it.
    return {
      ok: false,
      error: "host permission not granted — enroll this origin from Settings",
      origin: canonical,
    };
  }

  // Register ONLY the missing ids (never re-register an existing id: a
  // partial state — exactly one of the pair already present — would otherwise
  // collide and throw). Determine which of the two scripts already exist.
  const ids = [scriptId(canonical, "main"), scriptId(canonical, "bridge")];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids })
    .catch(() => []);
  const existingIds = new Set(existing.map((s) => s.id));

  const toRegister = [];
  if (!existingIds.has(scriptId(canonical, "main"))) {
    toRegister.push({
      id: scriptId(canonical, "main"),
      matches,
      js: [BRIDGE_AUTH_JS, MAIN_WORLD_JS],
      runAt: "document_start",
      world: "MAIN",
      allFrames: false,
    });
  }
  if (!existingIds.has(scriptId(canonical, "bridge"))) {
    toRegister.push({
      id: scriptId(canonical, "bridge"),
      matches,
      js: [BRIDGE_AUTH_JS, BRIDGE_JS],
      runAt: "document_idle",
      world: "ISOLATED",
      allFrames: false,
    });
  }
  if (toRegister.length > 0) {
    await chrome.scripting.registerContentScripts(toRegister);
  }
  return { ok: true, origin: canonical };
}

/** Remove the dynamic content scripts for an origin AND revoke the optional
 * host permission (authoritative revocation on agent.delete). Returns HONEST
 * results — ok is true ONLY when BOTH the scripts AND the host permission are
 * confirmed ABSENT (a partial revocation is never reported as success, the
 * round-14 transactional finding). `permissions.remove` resolving false means
 * "already absent" (a no-op, not a failure), so absence is re-confirmed via
 * `permissions.contains`. */
export async function unregisterOriginScripts(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return { ok: false, error: "invalid origin" };

  // Scripts: without the `scripting` permission no content scripts can be
  // registered, so they are absent by definition. With it, unregister + confirm.
  // The guard must check the PERMISSION (not just the API object): after a
  // capability.revoke("scripting") the `chrome.scripting` object still EXISTS but
  // every method throws "not available in this context", so a naive
  // `chrome.scripting?.unregisterContentScripts` truthiness check would enter the
  // block and report a cleanup failure for scripts that are genuinely absent.
  let scriptsRemoved = true;
  let error = null;
  let hasScripting = false;
  try {
    hasScripting = typeof chrome !== "undefined" &&
      !!(await chrome.permissions.contains({ permissions: ["scripting"] }));
  } catch {
    hasScripting = false;
  }
  if (hasScripting) {
    const ids = [scriptId(canonical, "main"), scriptId(canonical, "bridge")];
    const confirmAbsent = async () => {
      const remaining = await chrome.scripting
        .getRegisteredContentScripts({ ids })
        .catch(() => null);
      // A `null` confirmation read means the CONFIRMATION FAILED (the API threw
      // or was absent) — it is NOT proof the scripts are gone. Only an empty
      // array is authoritative absence (the round-15 finding: a failed
      // confirmation read must not be treated as "removed").
      return Array.isArray(remaining) && remaining.length === 0;
    };
    try {
      await chrome.scripting.unregisterContentScripts({ ids });
      scriptsRemoved = await confirmAbsent();
      if (!scriptsRemoved && !error) {
        error = "content scripts still registered after unregister";
      }
    } catch (e) {
      // A "no such script" throw can mean the scripts were ALREADY absent (an
      // origin enrolled via agent.create registers no scripts, or a prior partial
      // cleanup removed them). Absence is the GOAL, not a failure — confirm it
      // before declaring failure (the round-22 scripting-Disable honesty fix must
      // not report a cleanup failure for scripts that genuinely do not exist).
      scriptsRemoved = await confirmAbsent();
      if (!scriptsRemoved) {
        error = String(e?.message ?? e);
      }
    }
  }

  // Host permission: remove, then CONFIRM absence (a `false` remove result is
  // "already absent", which is the goal — not a failure). A `remove` throw for a
  // never-granted origin is also fine — absence is re-confirmed via contains.
  let permissionRemoved = true;
  try {
    await chrome.permissions.remove({ origins: [`${canonical}/*`] });
  } catch { /* remove may throw when the origin was never granted — confirm below */ }
  try {
    permissionRemoved = !(await chrome.permissions.contains({
      origins: [`${canonical}/*`],
    }));
    if (!permissionRemoved && !error) error = "host permission still present after remove";
  } catch {
    permissionRemoved = false;
  }
  return {
    ok: scriptsRemoved && permissionRemoved,
    origin: canonical,
    scriptsRemoved,
    permissionRemoved,
    error,
  };
}

/** Revoke ONLY the optional host permission for an origin (enrollment rollback).
 * Returns whether the permission is now ABSENT (confirmed via contains, not
 * merely the `remove` boolean, which is false for an already-absent permission). */
export async function removeOriginHostPermission(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return false;
  try {
    await chrome.permissions.remove({ origins: [`${canonical}/*`] });
    return !(await chrome.permissions.contains({ origins: [`${canonical}/*`] }));
  } catch {
    return false;
  }
}

/**
 * Reconcile dynamic content scripts for all enrolled origins on service-worker boot
 * (CAP-FB-20260825-SITE-DISCOVERABILITY-01). Confirms that every enrolled origin
 * whose host permission is still granted has its content scripts registered in
 * chrome.scripting, ensuring discovery and bridge scripts survive worker restarts.
 */
export async function reconcileEnrolledOriginScriptsOnBoot() {
  let hasScripting = false;
  try {
    hasScripting = typeof chrome !== "undefined" &&
      typeof chrome.permissions?.contains === "function" &&
      !!(await chrome.permissions.contains({ permissions: ["scripting"] }));
  } catch {
    hasScripting = false;
  }
  if (!hasScripting) {
    return { ok: false, error: "scripting permission not granted" };
  }

  const { listOrigins } = await import("./memory.js");
  const origins = await listOrigins().catch(() => []);
  const results = [];
  for (const origin of origins) {
    const res = await ensureOriginScriptsRegistered(origin).catch((e) => ({
      ok: false,
      origin,
      error: String(e?.message ?? e),
    }));
    results.push(res);
  }
  return { ok: true, count: origins.length, results };
}
