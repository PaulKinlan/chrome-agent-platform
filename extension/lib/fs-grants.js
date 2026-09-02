// lib/fs-grants.js — Persistent Local File System Access Grants Store, Picker Wiring, Bounded Reader, Re-grant & Watcher.
// (CAP-FB-20260823-PERSISTENT-FS-ACCESS-01).
//
// Invariants:
//   - Tranche 1: Manages persistence, query, enumeration, and revocation of
//     structured-cloned FileSystemDirectoryHandle / FileSystemFileHandle records.
//   - Tranche 2: Adds window-only, user-gesture-only owner pickers ("Add folder", "Add file")
//     with explicit mode selection ("read" | "readwrite") and truthful feature detection.
//   - Tranche 3: Adds owner-initiated bounded listing (enumerate granted directory entries,
//     bounded depth/count) and bounded file reading (digest-pinned content fetch via handle).
//   - Tranche 4: Implements the honest resume / re-grant model — owner-gesture requestPermission()
//     on the stored handle in page context when queryPermission returns "prompt", flipping status
//     back to "granted"; "denied" shows honest fail state; absolute paths (/ or \) rejected.
//   - Tranche 5: Adds primary FileSystemObserver watcher (unobserve/disconnect on revoke;
//     coalesced change signals; polling fallback where unsupported); bounded owner write (readwrite
//     grants only; size cap 5 MiB); bounded recursive manifest scan (depth cap 16, count cap 10k).
//   - Zero broadening: each grant binds strictly to the chosen directory/file subtree
//     and its requested mode.
//   - Honest permission state: uses handle.queryPermission({ mode }) to reflect
//     "granted" | "prompt" | "denied". Fails closed before every read/write/list when status != "granted".
//   - Revocation: deleting the record is the revocation authority and terminates active watchers.

import { newId } from "./pure.js";

export const MAX_FS_LIST_ENTRIES = 500;
export const MAX_FS_PATH_DEPTH = 16;
export const MAX_FS_READ_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_FS_TEXT_DECODE_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MAX_FS_WRITE_BYTES = 5 * 1024 * 1024; // 5 MiB
export const MAX_FS_SCAN_ENTRIES = 10000;
export const MAX_FS_SCAN_BYTES = 1024 * 1024; // 1 MiB
export const MAX_FS_SEARCH_RESULTS = 50;
export const MAX_FS_SEARCH_SCANNED = 5000;
// grep bounds: a recursive content search over a granted directory has to stay
// cheap and terminate. Matches, files scanned, per-file size, and line length
// are all capped; oversized/binary files are skipped, never decoded as garbage.
export const MAX_FS_GREP_MATCHES = 200;
export const MAX_FS_GREP_FILES_SCANNED = 2000;
export const MAX_FS_GREP_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB — larger files are skipped
export const MAX_FS_GREP_LINE_LENGTH = 2000; // a matched line is truncated to this many chars

const DB_NAME = "cap_fs_grants";
const DB_VERSION = 1;
const STORE_NAME = "grants";

// In-memory fallback map for non-IndexedDB unit test environments
const memoryGrantsStore = new Map();
const activeWatchers = new Map();

export function cleanRelativePath(pathStr) {
  if (typeof pathStr !== "string" || !pathStr.trim()) return [];
  const raw = pathStr.trim();
  if (raw.startsWith("/") || raw.startsWith("\\")) {
    throw new Error("invalid_path_absolute: absolute paths are prohibited");
  }
  const normalized = raw.replace(/\\/g, "/");
  const rawSegments = normalized.split("/");
  const clean = [];
  for (const seg of rawSegments) {
    const s = seg.trim();
    if (!s || s === ".") continue;
    if (s === "..") {
      throw new Error("invalid_path_traversal: path traversal '..' is prohibited");
    }
    clean.push(s);
  }
  return clean;
}

export async function computeSha256(buffer) {
  if (typeof crypto !== "undefined" && crypto.subtle?.digest) {
    const hashBuf = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  return "0000000000000000000000000000000000000000000000000000000000000000";
}

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
  return newId("fsg");
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
 * Automatically tears down any active watcher on this grant.
 * @param {string} grantId
 * @param {{ customIdb?: any }} [options]
 */
export async function deleteFsGrant(grantId, { customIdb = null } = {}) {
  if (!grantId) return { ok: false, error: "grant_id_required" };
  unwatchFsGrant(grantId);
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
 * Re-grant access for a stored grant whose permission state is "prompt" (e.g. after a browser restart).
 * MUST be called from an owner gesture in a visible page context.
 * @param {string} grantId
 * @param {{
 *   isTrusted?: boolean,
 *   customIdb?: any
 * }} [options]
 */
export async function regrantFsGrantAccess(
  grantId,
  { isTrusted = true, customIdb = null } = {},
) {
  if (!isTrusted) {
    return { ok: false, error: "owner_gesture_required", message: "Re-grant requires a genuine user click." };
  }
  const grant = await getFsGrant(grantId, { customIdb });
  if (!grant) return { ok: false, error: "grant_not_found" };

  if (!grant.handle || typeof grant.handle.requestPermission !== "function") {
    return { ok: false, error: "handle_cannot_request_permission" };
  }

  try {
    const status = await grant.handle.requestPermission({ mode: grant.mode || "read" });
    if (status === "granted") {
      await saveFsGrant(
        {
          ...grant,
          lastUsedAt: Date.now(),
        },
        { customIdb },
      );
    }
    return {
      ok: true,
      grantId,
      status, // "granted" | "prompt" | "denied"
    };
  } catch (err) {
    return {
      ok: false,
      error: `regrant_failed: ${err?.message || err}`,
    };
  }
}

/**
 * Bounded listing of directory entries within a granted handle.
 * @param {string} grantId
 * @param {{ relativePath?: string, limit?: number }} [options]
 * @param {{ customIdb?: any }} [dbOptions]
 */
export async function listFsGrantEntries(
  grantId,
  { relativePath = "", limit = MAX_FS_LIST_ENTRIES } = {},
  { customIdb = null } = {},
) {
  const grant = await getFsGrant(grantId, { customIdb });
  if (!grant) return { ok: false, error: "grant_not_found" };

  const status = await queryFsGrantStatus(grant);
  if (status !== "granted") {
    return { ok: false, error: "fs_permission_lapsed", status, grantId };
  }

  let segments = [];
  try {
    segments = cleanRelativePath(relativePath);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }

  if (segments.length > MAX_FS_PATH_DEPTH) {
    return { ok: false, error: "max_depth_exceeded", maxDepth: MAX_FS_PATH_DEPTH };
  }

  if (grant.kind === "file") {
    if (segments.length > 0 && segments.join("/") !== grant.name) {
      return { ok: false, error: "file_grant_cannot_have_subpath" };
    }
    const file = typeof grant.handle?.getFile === "function" ? await grant.handle.getFile().catch(() => null) : grant.handle;
    const size = typeof file?.size === "number" ? file.size : 0;
    const lastModified = typeof file?.lastModified === "number" ? file.lastModified : 0;
    return {
      ok: true,
      grantId,
      kind: "file",
      path: "",
      name: grant.name,
      entries: [{ name: grant.name, kind: "file", size, lastModified }],
      truncated: false,
      total: 1,
    };
  }

  // Directory traversal
  let dirHandle = grant.handle;
  for (const seg of segments) {
    if (!dirHandle || typeof dirHandle.getDirectoryHandle !== "function") {
      return { ok: false, error: "invalid_directory_handle" };
    }
    try {
      dirHandle = await dirHandle.getDirectoryHandle(seg);
    } catch {
      return { ok: false, error: "directory_not_found", path: seg };
    }
  }

  const entries = [];
  let total = 0;
  let truncated = false;
  const effectiveLimit = Math.min(Math.max(1, limit || MAX_FS_LIST_ENTRIES), MAX_FS_LIST_ENTRIES);

  try {
    const iter = typeof dirHandle.values === "function"
      ? dirHandle.values()
      : typeof dirHandle.entries === "function"
      ? dirHandle.entries()
      : [];

    for await (const entry of iter) {
      total++;
      if (entries.length < effectiveLimit) {
        const itemHandle = Array.isArray(entry) ? entry[1] : entry;
        entries.push({
          name: itemHandle.name,
          kind: itemHandle.kind || (itemHandle.getFile ? "file" : "directory"),
        });
      } else {
        truncated = true;
      }
    }
  } catch (err) {
    return { ok: false, error: `enumeration_failed: ${err?.message || err}` };
  }

  return {
    ok: true,
    grantId,
    kind: "directory",
    path: segments.join("/"),
    entries,
    truncated,
    total,
  };
}

/** Search file names across every stored grant without reading file content. */
export async function searchFsGrantFiles(
  query = "",
  { limit = MAX_FS_SEARCH_RESULTS, maxScanned = MAX_FS_SEARCH_SCANNED } = {},
  { customIdb = null } = {},
) {
  const q = String(query ?? "").trim().toLowerCase();
  const effectiveLimit = Math.min(Math.max(1, Number(limit) || MAX_FS_SEARCH_RESULTS), MAX_FS_SEARCH_RESULTS);
  const effectiveScanLimit = Math.min(Math.max(effectiveLimit, Number(maxScanned) || MAX_FS_SEARCH_SCANNED), MAX_FS_SEARCH_SCANNED);
  const files = [];
  const permissionIssues = [];
  const errors = [];
  let scanned = 0;
  let truncated = false;

  // Composer search is global-owner context. Never leak a task/agent-scoped
  // handle into a different conversation; Settings-created folder grants are
  // global, while scoped grants remain available only through their owner.
  const grants = (await listFsGrants({}, { customIdb }))
    .filter((grant) => grant.scopeKey === "global");
  for (const grant of grants) {
    const status = await queryFsGrantStatus(grant);
    if (status !== "granted") {
      if (permissionIssues.length < MAX_FS_SEARCH_RESULTS) {
        permissionIssues.push({ grantId: grant.grantId, name: grant.name, status });
      }
      continue;
    }

    const addFile = async (handle, relativePath) => {
      scanned += 1;
      if (files.length >= effectiveLimit || scanned > effectiveScanLimit) {
        truncated = true;
        return;
      }
      const name = String(handle?.name ?? relativePath.split("/").pop() ?? "");
      if (q && !name.toLowerCase().includes(q)) return;
      try {
        const file = typeof handle?.getFile === "function" ? await handle.getFile() : handle;
        files.push({
          grantId: grant.grantId,
          folderName: grant.name,
          relativePath,
          name,
          size: Number(file?.size) || 0,
          type: String(file?.type ?? ""),
          lastModified: Number(file?.lastModified) || 0,
        });
      } catch (err) {
        if (errors.length < MAX_FS_SEARCH_RESULTS) {
          errors.push({ grantId: grant.grantId, path: relativePath, error: `get_file_failed: ${err?.message || err}` });
        }
      }
    };

    if (grant.kind === "file") {
      await addFile(grant.handle, grant.name);
      continue;
    }

    const walk = async (dirHandle, prefix = "", depth = 0) => {
      if (truncated || depth > MAX_FS_PATH_DEPTH) {
        truncated = true;
        return;
      }
      try {
        const iter = typeof dirHandle?.values === "function"
          ? dirHandle.values()
          : typeof dirHandle?.entries === "function"
          ? dirHandle.entries()
          : [];
        for await (const raw of iter) {
          if (files.length >= effectiveLimit || scanned >= effectiveScanLimit) {
            truncated = true;
            return;
          }
          const handle = Array.isArray(raw) ? raw[1] : raw;
          const name = String(handle?.name ?? "");
          const path = prefix ? `${prefix}/${name}` : name;
          if (handle?.kind === "directory") {
            scanned += 1;
            await walk(handle, path, depth + 1);
          } else {
            await addFile(handle, path);
          }
        }
      } catch (err) {
        if (errors.length < MAX_FS_SEARCH_RESULTS) {
          errors.push({ grantId: grant.grantId, path: prefix, error: `enumeration_failed: ${err?.message || err}` });
        }
      }
    };
    await walk(grant.handle);
    if (truncated) break;
  }

  return {
    ok: true,
    query: String(query ?? ""),
    files,
    permissionIssues,
    errors,
    scanned: Math.min(scanned, effectiveScanLimit),
    truncated,
  };
}

/**
 * Bounded file reading within a granted handle (digest-pinned).
 * @param {string} grantId
 * @param {{ relativePath?: string, asText?: boolean, maxBytes?: number }} [options]
 * @param {{ customIdb?: any }} [dbOptions]
 */
export async function readFsGrantFile(
  grantId,
  { relativePath = "", asText = true, maxBytes = MAX_FS_READ_BYTES } = {},
  { customIdb = null } = {},
) {
  const grant = await getFsGrant(grantId, { customIdb });
  if (!grant) return { ok: false, error: "grant_not_found" };

  const status = await queryFsGrantStatus(grant);
  if (status !== "granted") {
    return { ok: false, error: "fs_permission_lapsed", status, grantId };
  }

  let segments = [];
  try {
    segments = cleanRelativePath(relativePath);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }

  if (segments.length > MAX_FS_PATH_DEPTH) {
    return { ok: false, error: "max_depth_exceeded", maxDepth: MAX_FS_PATH_DEPTH };
  }

  let fileHandle = null;
  if (grant.kind === "file") {
    if (segments.length > 0 && segments.join("/") !== grant.name) {
      return { ok: false, error: "invalid_file_path" };
    }
    fileHandle = grant.handle;
  } else {
    if (segments.length === 0) {
      return { ok: false, error: "directory_path_is_not_file" };
    }
    let dirHandle = grant.handle;
    for (let i = 0; i < segments.length - 1; i++) {
      if (!dirHandle || typeof dirHandle.getDirectoryHandle !== "function") {
        return { ok: false, error: "invalid_directory_handle" };
      }
      try {
        dirHandle = await dirHandle.getDirectoryHandle(segments[i]);
      } catch {
        return { ok: false, error: "directory_not_found", path: segments[i] };
      }
    }
    const fileName = segments[segments.length - 1];
    if (!dirHandle || typeof dirHandle.getFileHandle !== "function") {
      return { ok: false, error: "invalid_directory_handle" };
    }
    try {
      fileHandle = await dirHandle.getFileHandle(fileName);
    } catch {
      return { ok: false, error: "file_not_found", name: fileName };
    }
  }

  let file = null;
  try {
    file = typeof fileHandle.getFile === "function" ? await fileHandle.getFile() : fileHandle;
  } catch (err) {
    return { ok: false, error: `get_file_failed: ${err?.message || err}` };
  }

  const effectiveMaxBytes = Math.min(Math.max(1, maxBytes || MAX_FS_READ_BYTES), MAX_FS_READ_BYTES);
  const fileSize = typeof file?.size === "number" ? file.size : 0;
  if (fileSize > effectiveMaxBytes) {
    return {
      ok: false,
      error: "fs_file_too_large",
      size: fileSize,
      maxBytes: effectiveMaxBytes,
    };
  }

  let arrayBuffer = null;
  try {
    arrayBuffer = typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : new ArrayBuffer(0);
  } catch (err) {
    return { ok: false, error: `read_bytes_failed: ${err?.message || err}` };
  }

  const bytes = new Uint8Array(arrayBuffer);
  const sha256 = await computeSha256(arrayBuffer);

  let textContent = null;
  if (asText) {
    if (bytes.byteLength > MAX_FS_TEXT_DECODE_BYTES) {
      textContent = `[Binary or text content exceeds decode limit (${MAX_FS_TEXT_DECODE_BYTES / (1024 * 1024)} MiB)]`;
    } else {
      const hasBinaryControls = bytes.some((byte) =>
        byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127
      );
      try {
        textContent = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch { /* rejected below */ }
      if (hasBinaryControls || textContent === null) {
        return { ok: false, error: "fs_file_not_text", grantId, path: segments.join("/"), size: fileSize, sha256 };
      }
    }
  }

  return {
    ok: true,
    grantId,
    path: segments.join("/"),
    name: file.name || fileHandle.name,
    size: fileSize,
    lastModified: typeof file.lastModified === "number" ? file.lastModified : 0,
    sha256,
    content: textContent,
    truncated: false,
  };
}

/**
 * Recursive, bounded content search (grep) over a granted directory handle.
 * Returns matching lines as `{ path, line, text }` — a real grep, never a
 * silent empty result. Binary and oversized files are skipped. `regex` opts
 * into RegExp matching (allowed under MV3 CSP — RegExp is not eval/new
 * Function); the default is a literal substring match, which cannot ReDoS.
 * @param {string} grantId
 * @param {{ query?: string, relativePath?: string, regex?: boolean, ignoreCase?: boolean, maxMatches?: number, maxDepth?: number }} [options]
 * @param {{ customIdb?: any }} [dbOptions]
 */
export async function grepFsGrant(
  grantId,
  { query = "", relativePath = "", regex = false, ignoreCase = false, maxMatches = MAX_FS_GREP_MATCHES, maxDepth = MAX_FS_PATH_DEPTH } = {},
  { customIdb = null } = {},
) {
  const grant = await getFsGrant(grantId, { customIdb });
  if (!grant) return { ok: false, error: "grant_not_found" };

  const status = await queryFsGrantStatus(grant);
  if (status !== "granted") {
    return { ok: false, error: "fs_permission_lapsed", status, grantId };
  }

  const q = String(query ?? "");
  if (!q.trim()) return { ok: false, error: "fs_grep_empty_query" };

  // Build the line matcher. RegExp is CSP-safe (unlike eval/new Function). A
  // literal substring is the default so a model-supplied pattern cannot ReDoS.
  let matcher;
  if (regex) {
    let re;
    try {
      re = new RegExp(q, ignoreCase ? "i" : "");
    } catch (err) {
      return { ok: false, error: "fs_grep_invalid_regex", detail: String(err?.message || err) };
    }
    matcher = (line) => re.test(line);
  } else {
    const needle = ignoreCase ? q.toLowerCase() : q;
    matcher = (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }

  let segments = [];
  try {
    segments = cleanRelativePath(relativePath);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
  if (segments.length > MAX_FS_PATH_DEPTH) {
    return { ok: false, error: "max_depth_exceeded", maxDepth: MAX_FS_PATH_DEPTH };
  }

  const matches = [];
  let filesScanned = 0;
  let truncated = false;
  const effectiveMax = Math.min(Math.max(1, Number(maxMatches) || MAX_FS_GREP_MATCHES), MAX_FS_GREP_MATCHES);

  const scanFile = async (handle, path) => {
    if (matches.length >= effectiveMax || filesScanned >= MAX_FS_GREP_FILES_SCANNED) {
      truncated = true;
      return;
    }
    let file;
    try {
      file = typeof handle?.getFile === "function" ? await handle.getFile() : handle;
    } catch { return; }
    const size = typeof file?.size === "number" ? file.size : 0;
    if (size > MAX_FS_GREP_FILE_BYTES) return; // skip oversized files
    filesScanned += 1;
    let buffer;
    try {
      buffer = typeof file?.arrayBuffer === "function" ? await file.arrayBuffer() : null;
    } catch { return; }
    if (!buffer) return;
    const bytes = new Uint8Array(buffer);
    // Skip binary files: a NUL or an unexpected control byte means "not text".
    const hasBinaryControls = bytes.some((byte) =>
      byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127
    );
    if (hasBinaryControls) return;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch { return; }
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= effectiveMax) {
        truncated = true;
        return;
      }
      let line = lines[i];
      if (matcher(line)) {
        if (line.length > MAX_FS_GREP_LINE_LENGTH) line = line.slice(0, MAX_FS_GREP_LINE_LENGTH);
        matches.push({ path, line: i + 1, text: line });
      }
    }
  };

  const walk = async (dir, prefix, depth) => {
    if (truncated || matches.length >= effectiveMax || filesScanned >= MAX_FS_GREP_FILES_SCANNED) return;
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    let iter;
    try {
      iter = typeof dir?.values === "function"
        ? dir.values()
        : typeof dir?.entries === "function"
        ? dir.entries()
        : [];
    } catch { return; }
    try {
      for await (const raw of iter) {
        if (matches.length >= effectiveMax || filesScanned >= MAX_FS_GREP_FILES_SCANNED) {
          truncated = true;
          return;
        }
        const handle = Array.isArray(raw) ? raw[1] : raw;
        const name = String(handle?.name ?? "");
        const path = prefix ? `${prefix}/${name}` : name;
        const kind = handle?.kind || (handle?.getFile ? "file" : "directory");
        if (kind === "directory") {
          await walk(handle, path, depth + 1);
        } else {
          await scanFile(handle, path);
        }
      }
    } catch { /* enumeration failure is bounded: return what we have */ }
  };

  if (grant.kind === "file") {
    await scanFile(grant.handle, grant.name);
    return { ok: true, grantId, query: q, matches, filesScanned, matchCount: matches.length, truncated };
  }

  // Optionally scope the grep to a subdirectory of the granted folder.
  let startDir = grant.handle;
  for (const seg of segments) {
    if (!startDir || typeof startDir.getDirectoryHandle !== "function") {
      return { ok: false, error: "invalid_directory_handle" };
    }
    try {
      startDir = await startDir.getDirectoryHandle(seg);
    } catch {
      return { ok: false, error: "directory_not_found", path: seg };
    }
  }

  await walk(startDir, segments.join("/"), 1);

  return { ok: true, grantId, query: q, matches, filesScanned, matchCount: matches.length, truncated };
}

/**
 * Bounded file writing within a granted handle (readwrite mode required).
 * @param {string} grantId
 * @param {{ relativePath?: string, content?: string|Uint8Array|ArrayBuffer, asBinary?: boolean }} options
 * @param {{ customIdb?: any }} [dbOptions]
 */
export async function writeFsGrantFile(
  grantId,
  { relativePath = "", content = "", asBinary = false } = {},
  { customIdb = null } = {},
) {
  const grant = await getFsGrant(grantId, { customIdb });
  if (!grant) return { ok: false, error: "grant_not_found" };

  if (grant.mode !== "readwrite") {
    return {
      ok: false,
      error: "fs_write_permission_denied",
      message: "Grant mode is read-only. Write operations require a read/write grant.",
    };
  }

  const status = await queryFsGrantStatus(grant);
  if (status !== "granted") {
    return { ok: false, error: "fs_permission_lapsed", status, grantId };
  }

  let segments = [];
  try {
    segments = cleanRelativePath(relativePath);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }

  if (segments.length === 0) {
    return { ok: false, error: "invalid_file_path", message: "A file name is required" };
  }

  if (segments.length > MAX_FS_PATH_DEPTH) {
    return { ok: false, error: "max_depth_exceeded", maxDepth: MAX_FS_PATH_DEPTH };
  }

  let bytes = null;
  if (content instanceof Uint8Array) {
    bytes = content;
  } else if (typeof content === "string") {
    bytes = new TextEncoder().encode(content);
  } else if (content instanceof ArrayBuffer) {
    bytes = new Uint8Array(content);
  } else {
    bytes = new Uint8Array(0);
  }

  if (bytes.byteLength > MAX_FS_WRITE_BYTES) {
    return {
      ok: false,
      error: "fs_file_too_large",
      size: bytes.byteLength,
      maxBytes: MAX_FS_WRITE_BYTES,
    };
  }

  let fileHandle = null;
  if (grant.kind === "file") {
    if (segments.length > 1 || (segments.length === 1 && segments[0] !== grant.name)) {
      return { ok: false, error: "invalid_file_path" };
    }
    fileHandle = grant.handle;
  } else {
    let dirHandle = grant.handle;
    for (let i = 0; i < segments.length - 1; i++) {
      if (!dirHandle || typeof dirHandle.getDirectoryHandle !== "function") {
        return { ok: false, error: "invalid_directory_handle" };
      }
      try {
        dirHandle = await dirHandle.getDirectoryHandle(segments[i], { create: true });
      } catch (err) {
        return { ok: false, error: `create_directory_failed: ${err?.message || err}` };
      }
    }
    const fileName = segments[segments.length - 1];
    if (!dirHandle || typeof dirHandle.getFileHandle !== "function") {
      return { ok: false, error: "invalid_directory_handle" };
    }
    try {
      fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    } catch (err) {
      return { ok: false, error: `create_file_failed: ${err?.message || err}` };
    }
  }

  try {
    if (typeof fileHandle.createWritable !== "function") {
      return { ok: false, error: "create_writable_unsupported" };
    }
    const writable = await fileHandle.createWritable();
    await writable.write(bytes);
    await writable.close();
  } catch (err) {
    return { ok: false, error: `write_failed: ${err?.message || err}` };
  }

  const sha256 = await computeSha256(bytes.buffer);

  return {
    ok: true,
    grantId,
    path: segments.join("/"),
    name: fileHandle.name,
    size: bytes.byteLength,
    sha256,
    written: true,
  };
}

/**
 * Recursive bounded manifest scan of a granted directory.
 * @param {string} grantId
 * @param {{ maxEntries?: number, maxDepth?: number }} [options]
 * @param {{ customIdb?: any }} [dbOptions]
 */
export async function scanFsGrantManifest(
  grantId,
  { maxEntries = MAX_FS_SCAN_ENTRIES, maxDepth = MAX_FS_PATH_DEPTH } = {},
  { customIdb = null } = {},
) {
  const grant = await getFsGrant(grantId, { customIdb });
  if (!grant) return { ok: false, error: "grant_not_found" };

  const status = await queryFsGrantStatus(grant);
  if (status !== "granted") {
    return { ok: false, error: "fs_permission_lapsed", status, grantId };
  }

  const entries = [];
  let truncated = false;
  let totalCount = 0;
  let estimatedBytes = 0;

  async function walk(dirHandle, currentPath, depth) {
    if (depth > maxDepth || entries.length >= maxEntries || estimatedBytes >= MAX_FS_SCAN_BYTES) {
      truncated = true;
      return;
    }

    const iter = typeof dirHandle.values === "function"
      ? dirHandle.values()
      : typeof dirHandle.entries === "function"
      ? dirHandle.entries()
      : [];

    for await (const entry of iter) {
      totalCount++;
      const item = Array.isArray(entry) ? entry[1] : entry;
      const relPath = currentPath ? `${currentPath}/${item.name}` : item.name;
      const kind = item.kind || (item.getFile ? "file" : "directory");

      let size = 0;
      let lastModified = 0;
      if (kind === "file" && typeof item.getFile === "function") {
        try {
          const f = await item.getFile();
          size = f.size || 0;
          lastModified = f.lastModified || 0;
        } catch { /* ignore */ }
      }

      const record = { path: relPath, name: item.name, kind, size, lastModified };
      const rowSize = JSON.stringify(record).length;

      if (entries.length < maxEntries && estimatedBytes + rowSize < MAX_FS_SCAN_BYTES) {
        entries.push(record);
        estimatedBytes += rowSize;
      } else {
        truncated = true;
      }

      if (kind === "directory" && !truncated) {
        await walk(item, relPath, depth + 1);
      }
    }
  }

  if (grant.kind === "file") {
    const file = typeof grant.handle?.getFile === "function" ? await grant.handle.getFile().catch(() => null) : grant.handle;
    return {
      ok: true,
      grantId,
      kind: "file",
      entries: [{
        path: grant.name,
        name: grant.name,
        kind: "file",
        size: file?.size || 0,
        lastModified: file?.lastModified || 0,
      }],
      totalCount: 1,
      truncated: false,
    };
  }

  await walk(grant.handle, "", 1);

  return {
    ok: true,
    grantId,
    kind: "directory",
    entries,
    totalCount,
    truncated,
  };
}

/**
 * Watch a granted directory for change events.
 * Uses FileSystemObserver when supported; falls back to polling manifest diff.
 * @param {string} grantId
 * @param {(event: { grantId: string, type: string, path: string, timestamp: number }) => void} callback
 * @param {{
 *   pollIntervalMs?: number,
 *   scope?: any,
 *   customIdb?: any
 * }} [options]
 */
export async function watchFsGrant(
  grantId,
  callback,
  {
    pollIntervalMs = 5000,
    scope = (typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis),
    customIdb = null,
  } = {},
) {
  const grant = await getFsGrant(grantId, { customIdb });
  if (!grant) return { ok: false, error: "grant_not_found" };

  const status = await queryFsGrantStatus(grant);
  if (status !== "granted") {
    return { ok: false, error: "fs_permission_lapsed", status, grantId };
  }

  // Teardown any existing watcher on this grant
  unwatchFsGrant(grantId);

  const hasObserver = typeof scope?.FileSystemObserver === "function";

  if (hasObserver) {
    try {
      const observer = new scope.FileSystemObserver((records) => {
        for (const record of records) {
          const path = Array.isArray(record?.relativePathComponents)
            ? record.relativePathComponents.join("/")
            : "";
          callback({
            grantId,
            type: record?.type || "changed",
            path,
            timestamp: Date.now(),
          });
        }
      });
      observer.observe(grant.handle, { recursive: true });

      const entry = {
        grantId,
        type: "observer",
        observer,
        unwatch: () => {
          try {
            if (typeof observer.unobserve === "function") observer.unobserve(grant.handle);
            if (typeof observer.disconnect === "function") observer.disconnect();
          } catch { /* ignore */ }
          activeWatchers.delete(grantId);
        },
      };
      activeWatchers.set(grantId, entry);

      return {
        ok: true,
        grantId,
        type: "observer",
        unwatch: entry.unwatch,
      };
    } catch (err) {
      console.warn("FileSystemObserver.observe failed, falling back to polling", err);
    }
  }

  // Fallback path: polling manifest diff
  let prevManifest = new Map();
  try {
    const scan = await scanFsGrantManifest(grantId, {}, { customIdb });
    if (scan.ok && Array.isArray(scan.entries)) {
      for (const e of scan.entries) {
        prevManifest.set(e.path, `${e.size}:${e.lastModified}`);
      }
    }
  } catch { /* ignore */ }

  const timer = setInterval(async () => {
    try {
      const scan = await scanFsGrantManifest(grantId, {}, { customIdb });
      if (!scan.ok || !Array.isArray(scan.entries)) return;
      const nextManifest = new Map();
      let changed = false;
      let firstChangedPath = "";

      for (const e of scan.entries) {
        const sig = `${e.size}:${e.lastModified}`;
        nextManifest.set(e.path, sig);
        if (!prevManifest.has(e.path) || prevManifest.get(e.path) !== sig) {
          changed = true;
          if (!firstChangedPath) firstChangedPath = e.path;
        }
      }
      for (const p of prevManifest.keys()) {
        if (!nextManifest.has(p)) {
          changed = true;
          if (!firstChangedPath) firstChangedPath = p;
        }
      }

      if (changed) {
        prevManifest = nextManifest;
        callback({
          grantId,
          type: "changed",
          path: firstChangedPath || "",
          timestamp: Date.now(),
        });
      }
    } catch { /* ignore poll errors */ }
  }, Math.max(1000, pollIntervalMs));

  const entry = {
    grantId,
    type: "polling",
    timer,
    unwatch: () => {
      clearInterval(timer);
      activeWatchers.delete(grantId);
    },
  };
  activeWatchers.set(grantId, entry);

  return {
    ok: true,
    grantId,
    type: "polling",
    unwatch: entry.unwatch,
  };
}

export function unwatchFsGrant(grantId) {
  const watcher = activeWatchers.get(grantId);
  if (watcher) {
    watcher.unwatch();
    activeWatchers.delete(grantId);
    return true;
  }
  return false;
}

export function getActiveFsWatchers() {
  return [...activeWatchers.keys()];
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
      if (!event?.isTrusted) {
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
      if (!event?.isTrusted) {
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

/**
 * Revoke every grant scoped to ANY of the given agent identities (review
 * P1-5): records are keyed by `grantId` (NOT `id` — the old inline revocation
 * passed an undefined field and exact-agent grants silently survived agent
 * deletion), and both identity spellings are honoured (grants saved
 * pre-instanceId carry the slug; newer state carries the instanceId). GLOBAL
 * and other-agent/task-scoped grants are never touched.
 * @param {string[]} agentIds
 * @param {{ customIdb?: any }} [opts]
 * @returns {Promise<{ ok: boolean, revoked: number, failures: string[] }>}
 */
export async function revokeAgentFsGrants(agentIds, { customIdb = null } = {}) {
  const ids = (Array.isArray(agentIds) ? agentIds : [agentIds])
    .map((v) => String(v ?? "").trim()).filter(Boolean);
  if (!ids.length) return { ok: true, revoked: 0, failures: [] };
  const wanted = new Set(ids.map((id) => `agent:${id}`));
  const failures = [];
  let revoked = 0;
  // The unscoped list returns every record; scope filtering here is STRICT —
  // a record without an exactly-matching agent scopeKey is preserved.
  const all = await listFsGrants({}, { customIdb });
  for (const g of Array.isArray(all) ? all : []) {
    if (!wanted.has(String(g?.scopeKey ?? ""))) continue;
    const d = await deleteFsGrant(g.grantId ?? g.id, { customIdb }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (d?.ok === false) failures.push(`${g.grantId ?? g.id}: ${d.error ?? "refused"}`);
    else revoked += 1;
  }
  return failures.length ? { ok: false, revoked, failures } : { ok: true, revoked, failures };
}
