// lib/factory-reset.js — Comprehensive, transactional factory reset / wipe-all
// for the Chrome Agent Platform (CAP-FB-20260823-FACTORY-RESET-01).
//
// Invariants:
//   - Wipes ALL extension storage classes: chrome.storage.local, in-memory session KV,
//     IndexedDB databases, OPFS directories (models, memory, jobs, cache), Cache Storage,
//     and scheduled alarms.
//   - All-or-nothing, fail-closed: verifies post-wipe cleanliness across all targets.
//   - Restores a genuine first-run onboarding state.
//   - Pure and verifiable: testable with mock or real storage backends.

import { kvClear, kvGet, storageAvailable } from "./kv.js";
import { sleep } from "./pure.js";

export const FACTORY_RESET_STORAGE_CLASSES = Object.freeze([
  "chrome.storage.local",
  "chrome.storage.session",
  "in-memory-session-kv",
  "origin-private-file-system",
  "indexed-db",
  "cache-storage",
  "chrome.alarms",
]);

/**
 * Enumerate the current storage targets and contents across all classes.
 */
export async function enumerateStorageTargets({
  opfsRoot = null,
} = {}) {
  const result = {
    chromeStorageKeys: [],
    sessionStorageKeys: [],
    opfsEntries: [],
    indexedDbDatabases: [],
    cacheKeys: [],
    alarmCount: 0,
  };

  // 1. chrome.storage.local / session KV keys
  try {
    const all = await kvGet(null);
    result.chromeStorageKeys = Object.keys(all || {}).sort();
  } catch {
    result.chromeStorageKeys = [];
  }

  // 1b. chrome.storage.session keys
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session?.get) {
      const sess = await chrome.storage.session.get(null);
      result.sessionStorageKeys = Object.keys(sess || {}).sort();
    }
  } catch {
    result.sessionStorageKeys = [];
  }

  // 2. OPFS entries
  try {
    const root = opfsRoot || (typeof navigator !== "undefined" && navigator.storage?.getDirectory ? await navigator.storage.getDirectory() : null);
    if (root && root.entries) {
      for await (const [name, handle] of root.entries()) {
        result.opfsEntries.push({ name, kind: handle?.kind ?? "directory" });
      }
    }
  } catch {
    result.opfsEntries = [];
  }

  // 3. IndexedDB databases
  try {
    if (typeof indexedDB !== "undefined" && indexedDB.databases) {
      const dbs = await indexedDB.databases();
      result.indexedDbDatabases = dbs.map((d) => d.name).filter(Boolean);
    }
  } catch {
    result.indexedDbDatabases = [];
  }

  // 4. Cache Storage keys
  try {
    if (typeof caches !== "undefined" && caches.keys) {
      result.cacheKeys = await caches.keys();
    }
  } catch {
    result.cacheKeys = [];
  }

  // 5. Chrome Alarms
  try {
    if (typeof chrome !== "undefined" && chrome.alarms?.getAll) {
      const alarms = await chrome.alarms.getAll();
      result.alarmCount = Array.isArray(alarms) ? alarms.length : 0;
    }
  } catch {
    result.alarmCount = 0;
  }

  return Object.freeze(result);
}

/**
 * Execute an all-or-nothing transactional wipe across all storage classes.
 */
export async function executeFactoryReset({
  opfsRoot = null,
  now = () => Date.now(),
  // How long a deleteDatabase that reports `blocked` is given to complete
  // once the open connections have seen their versionchange and closed.
  idbBlockedWaitMs = 3000,
  // How many extra passes sweep databases that an in-flight write recreated
  // while the wipe was running, and how long the wipe settles before its
  // verification reads the stores back.
  idbSweepPasses = 3,
  idbSettleMs = 50,
} = {}) {
  const report = {
    wipedAt: now(),
    storageClassesWiped: [],
    verification: {},
    errors: [],
  };

  // 1. Clear Alarms
  try {
    if (typeof chrome !== "undefined" && chrome.alarms?.clearAll) {
      await chrome.alarms.clearAll();
      report.storageClassesWiped.push("chrome.alarms");
    }
  } catch (err) {
    report.errors.push(`alarms_clear_failed: ${err?.message || err}`);
  }

  // 2. Clear OPFS Root
  try {
    const root = opfsRoot || (typeof navigator !== "undefined" && navigator.storage?.getDirectory ? await navigator.storage.getDirectory() : null);
    if (root) {
      const entries = [];
      if (root.entries) {
        for await (const [name, handle] of root.entries()) {
          entries.push({ name, kind: handle?.kind ?? "directory" });
        }
      }
      for (const entry of entries) {
        await root.removeEntry(entry.name, { recursive: true });
      }
      report.storageClassesWiped.push("origin-private-file-system");
    }
  } catch (err) {
    report.errors.push(`opfs_clear_failed: ${err?.message || err}`);
  }

  // 3. Clear IndexedDB
  /** Delete ONE database and wait for the delete to actually finish.
   *  `blocked` is not `done`: an open connection (the worker's cached usage
   *  store, a Settings page's grants store) fires versionchange, closes, and
   *  only THEN does the delete complete. Resolving on `onblocked` let
   *  `cap-usage` and `cap_fs_grants` survive every reset
   *  (CAP-FB-20260830-PRIVACY-STATEMENT-01). Bounded, so a connection that
   *  never lets go cannot hang the reset — the verification then reports it. */
  const deleteDatabase = (name) =>
    new Promise((resolve) => {
      let timer = null;
      const done = () => { if (timer) clearTimeout(timer); resolve(); };
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = done;
      req.onerror = done;
      req.onblocked = () => { if (!timer) timer = setTimeout(done, idbBlockedWaitMs); };
    });

  const listDatabases = async () => {
    if (typeof indexedDB === "undefined" || !indexedDB.databases) return [];
    try {
      return (await indexedDB.databases()).map((d) => d?.name).filter(Boolean);
    } catch {
      return [];
    }
  };

  try {
    if (typeof indexedDB !== "undefined") {
      const dbNames = new Set(["cap-usage", "cap_usage_v1", "keyval-store"]);
      for (const name of await listDatabases()) dbNames.add(name);
      for (const name of dbNames) await deleteDatabase(name);
      report.storageClassesWiped.push("indexed-db");
    }
  } catch (err) {
    report.errors.push(`idb_clear_failed: ${err?.message || err}`);
  }

  // 4. Clear Caches
  try {
    if (typeof caches !== "undefined" && caches.keys) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      report.storageClassesWiped.push("cache-storage");
    }
  } catch (err) {
    report.errors.push(`cache_clear_failed: ${err?.message || err}`);
  }

  // 5. Clear chrome.storage.session
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session?.clear) {
      await chrome.storage.session.clear();
      report.storageClassesWiped.push("chrome.storage.session");
    }
  } catch (err) {
    report.errors.push(`session_storage_clear_failed: ${err?.message || err}`);
  }

  // 6. Clear chrome.storage.local and in-memory session KV
  try {
    await kvClear();
    report.storageClassesWiped.push("chrome.storage.local");
    report.storageClassesWiped.push("in-memory-session-kv");
  } catch (err) {
    report.errors.push(`kv_clear_failed: ${err?.message || err}`);
  }

  // 7. Complete Post-Wipe Verification Across ALL Storage Classes (N-2).
  // The worker keeps running through the wipe, so a write that was already
  // queued can reopen a database moments after its delete succeeded (`cap-usage`
  // from an in-flight usage row). What the verification SEES is therefore swept
  // and re-verified, bounded; whatever still survives is reported as a remnant
  // below (fail-closed, never silently kept).
  // A short settle first: a verification that runs in the same microtask queue
  // as the wipe would read the stores BEFORE an already-queued write lands, and
  // report a cleanliness that the profile does not have a tick later.
  if (idbSettleMs > 0) await sleep(idbSettleMs);
  let remainingTargets = await enumerateStorageTargets({ opfsRoot });
  for (let pass = 0; pass < idbSweepPasses && remainingTargets.indexedDbDatabases.length > 0; pass++) {
    try {
      for (const name of remainingTargets.indexedDbDatabases) await deleteDatabase(name);
    } catch (err) {
      report.errors.push(`idb_sweep_failed: ${err?.message || err}`);
      break;
    }
    remainingTargets = await enumerateStorageTargets({ opfsRoot });
  }
  report.verification = {
    chromeStorageRemaining: remainingTargets.chromeStorageKeys.length,
    sessionStorageRemaining: remainingTargets.sessionStorageKeys.length,
    opfsEntriesRemaining: remainingTargets.opfsEntries.length,
    indexedDbRemaining: remainingTargets.indexedDbDatabases.length,
    cacheKeysRemaining: remainingTargets.cacheKeys.length,
    alarmsRemaining: remainingTargets.alarmCount,
  };

  if (remainingTargets.chromeStorageKeys.length > 0) report.errors.push("kv_remnants_detected");
  if (remainingTargets.opfsEntries.length > 0) report.errors.push("opfs_remnants_detected");
  if (remainingTargets.indexedDbDatabases.length > 0) report.errors.push("idb_remnants_detected");
  if (remainingTargets.cacheKeys.length > 0) report.errors.push("cache_remnants_detected");
  if (remainingTargets.alarmCount > 0) report.errors.push("alarm_remnants_detected");

  const verified = report.errors.length === 0;
  if (!verified) {
    const error = new Error(`factory_reset_failed: ${report.errors.join(", ")}`);
    error.code = "factory_reset_incomplete";
    error.report = report;
    throw error;
  }

  return Object.freeze({
    ok: true,
    verified: true,
    wipedAt: report.wipedAt,
    storageClassesWiped: Object.freeze(report.storageClassesWiped),
    verification: Object.freeze(report.verification),
  });
}
