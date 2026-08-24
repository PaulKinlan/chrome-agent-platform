// lib/fs-grants.js — Persistent Local File System Access Grants Store (IndexedDB).
// (CAP-FB-20260823-PERSISTENT-FS-ACCESS-01).
//
// Invariants:
//   - Tranche 1: Manages persistence, query, enumeration, and revocation of
//     structured-cloned FileSystemDirectoryHandle / FileSystemFileHandle records.
//   - Zero broadening: each grant binds strictly to the chosen directory/file subtree
//     and its requested mode ("read" | "readwrite").
//   - Honest permission state: uses handle.queryPermission({ mode }) to reflect
//     "granted" | "prompt" | "denied". A browser restart sets status to "prompt"
//     until the owner re-authorizes via a user gesture in a page.
//   - Revocation: deleting the record is the revocation authority.

const DB_NAME = "cap_fs_grants";
const DB_VERSION = 1;
const STORE_NAME = "grants";

// In-memory fallback map for non-IndexedDB unit test environments
const memoryGrantsStore = new Map();

function scopeKey(scope) {
  if (!scope || typeof scope !== "object") return "global";
  if (scope.taskId) return `task:${scope.taskId}`;
  if (scope.agentId) return `agent:${scope.agentId}`;
  return "global";
}

function openDatabase(customIdb = null) {
  const idb = customIdb || (typeof indexedDB !== "undefined" ? indexedDB : null);
  if (!idb) return null;

  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "grantId" });
        store.createIndex("by_scope", "scopeKey", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IDB open failed"));
    req.onblocked = () => reject(new Error("IDB open blocked"));
  });
}

function generateGrantId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `fsg_${crypto.randomUUID()}`;
  }
  return `fsg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Save or update a persistent file system access grant record.
 * @param {{
 *   grantId?: string|null,
 *   handle: any,
 *   name?: string|null,
 *   kind?: "directory"|"file",
 *   mode?: "read"|"readwrite",
 *   scope?: { taskId?: string|null, agentId?: string|null }|null,
 *   createdAt?: number|null,
 *   lastUsedAt?: number|null,
 *   now?: () => number
 * }} params
 * @param {{ customIdb?: any }} [options]
 */
export async function saveFsGrant({
  grantId = null,
  handle,
  name = null,
  kind = "directory",
  mode = "read",
  scope = null,
  createdAt = null,
  lastUsedAt = null,
  now = () => Date.now(),
}, { customIdb = null } = {}) {
  if (!handle) {
    throw new Error("saveFsGrant: handle is required");
  }
  const id = grantId || generateGrantId();
  const ts = now();
  const record = {
    grantId: id,
    handle,
    name: String(name || handle.name || "Unnamed local folder"),
    kind: kind === "file" ? "file" : "directory",
    mode: mode === "readwrite" ? "readwrite" : "read",
    scope: scope && typeof scope === "object" ? { taskId: scope.taskId || null, agentId: scope.agentId || null } : null,
    scopeKey: scopeKey(scope),
    createdAt: typeof createdAt === "number" ? createdAt : ts,
    lastUsedAt: typeof lastUsedAt === "number" ? lastUsedAt : ts,
  };

  const db = await openDatabase(customIdb).catch(() => null);
  if (db) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } else {
    memoryGrantsStore.set(id, record);
  }

  return Object.freeze(record);
}

/**
 * Retrieve a grant record by ID.
 * @param {string} grantId
 * @param {{ customIdb?: any }} [options]
 */
export async function getFsGrant(grantId, { customIdb = null } = {}) {
  if (!grantId) return null;
  const db = await openDatabase(customIdb).catch(() => null);
  if (db) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(grantId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }
  return memoryGrantsStore.get(grantId) || null;
}

/**
 * List all stored file system access grants, optionally filtered by scope.
 * @param {{ scope?: { taskId?: string|null, agentId?: string|null }|null }} [filter]
 * @param {{ customIdb?: any }} [options]
 */
export async function listFsGrants({ scope = null } = {}, { customIdb = null } = {}) {
  let records = [];
  const db = await openDatabase(customIdb).catch(() => null);
  if (db) {
    records = await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } else {
    records = [...memoryGrantsStore.values()];
  }

  if (scope) {
    const targetKey = scopeKey(scope);
    records = records.filter((r) => r.scopeKey === targetKey || r.scopeKey === "global");
  }

  records.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  return Object.freeze(records);
}

/**
 * Delete / revoke a stored grant record by ID.
 * @param {string} grantId
 * @param {{ customIdb?: any }} [options]
 */
export async function deleteFsGrant(grantId, { customIdb = null } = {}) {
  if (!grantId) return { ok: false, error: "grant_id_required" };
  const db = await openDatabase(customIdb).catch(() => null);
  if (db) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(grantId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } else {
    memoryGrantsStore.delete(grantId);
  }
  return Object.freeze({ ok: true, grantId, deleted: true });
}

/**
 * Query the browser's live permission status for a grant record's handle.
 * @param {any} grant
 */
export async function queryFsGrantStatus(grant) {
  if (!grant?.handle) return "prompt";
  if (typeof grant.handle.queryPermission === "function") {
    try {
      const status = await grant.handle.queryPermission({ mode: grant.mode || "read" });
      return status; // "granted" | "prompt" | "denied"
    } catch {
      return "prompt";
    }
  }
  return "granted";
}

/**
 * Serialize a grant record for safe IPC messaging without handle cloning errors.
 * @param {any} grant
 * @param {string|null} [liveStatus]
 */
export function serializeFsGrantSummary(grant, liveStatus = null) {
  if (!grant) return null;
  return Object.freeze({
    grantId: grant.grantId,
    name: grant.name,
    kind: grant.kind,
    mode: grant.mode,
    scope: grant.scope,
    createdAt: grant.createdAt,
    lastUsedAt: grant.lastUsedAt,
    status: liveStatus || "unknown",
  });
}
