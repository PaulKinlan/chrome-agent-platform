// lib/fs-grants.js — Persistent Local File System Access Grants Store & Picker Wiring.
// (CAP-FB-20260823-PERSISTENT-FS-ACCESS-01).
//
// Invariants:
//   - Tranche 1: Manages persistence, query, enumeration, and revocation of
//     structured-cloned FileSystemDirectoryHandle / FileSystemFileHandle records.
//   - Tranche 2: Adds window-only, user-gesture-only owner pickers ("Add folder", "Add file")
//     with explicit mode selection ("read" | "readwrite") and truthful feature detection.
//   - Zero broadening: each grant binds strictly to the chosen directory/file subtree
//     and its requested mode.
//   - Honest permission state: uses handle.queryPermission({ mode }) to reflect
//     "granted" | "prompt" | "denied".
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

async function openDatabase(customIdb = null) {
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

/**
 * Wire the Settings "Local folders" picker buttons ("Add folder", "Add file") to the File System Access API.
 * @param {{
 *   win?: any,
 *   onSaved?: (grant: any) => void,
 *   onFlash?: (msg: string) => void,
 *   onRender?: () => void,
 * }} [options]
 */
export function wireLocalFolderPickers({
  win = (typeof window !== "undefined" ? window : null),
  onSaved = () => {},
  onFlash = () => {},
  onRender = () => {},
} = {}) {
  if (!win) return;
  const doc = win.document;
  if (!doc) return;

  const dirBtn = doc.getElementById("fs-add-directory-btn");
  const fileBtn = doc.getElementById("fs-add-file-btn");
  const modeSelect = doc.getElementById("fs-pick-mode");
  const notice = doc.getElementById("fs-picker-unsupported-notice");

  const hasDirPicker = typeof win.showDirectoryPicker === "function";
  const hasFilePicker = typeof win.showOpenFilePicker === "function";

  if (!hasDirPicker && !hasFilePicker) {
    if (notice) notice.style.display = "inline-flex";
    if (dirBtn) dirBtn.disabled = true;
    if (fileBtn) fileBtn.disabled = true;
    return;
  }

  if (notice) notice.style.display = "none";
  if (dirBtn) dirBtn.disabled = !hasDirPicker;
  if (fileBtn) fileBtn.disabled = !hasFilePicker;

  if (dirBtn && !dirBtn._pickerWired) {
    dirBtn._pickerWired = true;
    dirBtn.addEventListener("click", async (event) => {
      if (!event?.isTrusted && !win.allowUntrustedEventsForTesting) {
        onFlash("Folder picker requires a genuine user click.");
        return;
      }
      const mode = modeSelect?.value === "readwrite" ? "readwrite" : "read";
      try {
        const handle = await win.showDirectoryPicker({ mode });
        if (!handle) return;
        const saved = await saveFsGrant({
          handle,
          name: handle.name,
          kind: "directory",
          mode,
          scope: null,
        });
        onFlash(`Added access to folder "${handle.name}" (${mode === "readwrite" ? "read/write" : "read-only"}).`);
        onSaved(saved);
        onRender();
      } catch (err) {
        if (err?.name === "AbortError") return;
        onFlash(`Failed to add folder: ${err?.message || err}`);
      }
    });
  }

  if (fileBtn && !fileBtn._pickerWired) {
    fileBtn._pickerWired = true;
    fileBtn.addEventListener("click", async (event) => {
      if (!event?.isTrusted && !win.allowUntrustedEventsForTesting) {
        onFlash("File picker requires a genuine user click.");
        return;
      }
      const mode = modeSelect?.value === "readwrite" ? "readwrite" : "read";
      try {
        const handles = await win.showOpenFilePicker({ multiple: false });
        const handle = Array.isArray(handles) ? handles[0] : handles;
        if (!handle) return;
        const saved = await saveFsGrant({
          handle,
          name: handle.name,
          kind: "file",
          mode,
          scope: null,
        });
        onFlash(`Added access to file "${handle.name}" (${mode === "readwrite" ? "read/write" : "read-only"}).`);
        onSaved(saved);
        onRender();
      } catch (err) {
        if (err?.name === "AbortError") return;
        onFlash(`Failed to add file: ${err?.message || err}`);
      }
    });
  }
}
