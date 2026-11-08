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

import { newId } from "./pure-text.js";

// dptw (2026-09-03): no size/count ceilings on granted-folder operations —
// reads, writes, listings, searches and grep all carry complete data at any
// size. The path TRAVERSAL guard (cleanRelativePath) is security and stays.
// grep: no match/file/line caps — matches of any size and count are returned
// whole. Only BINARY files are skipped (never decoded as garbage); that skip
// is content correctness, not a size bound.

import { capLog } from "./cap-log.js";

const grantsLog = capLog("fs-grants");

const DB_NAME = "cap_fs_grants";
const DB_VERSION = 1;
const STORE_NAME = "grants";

// In-memory fallback map for non-IndexedDB unit test environments
const memoryGrantsStore = new Map();
const activeWatchers = new Map();

export const DEFAULT_IGNORED_DIRS = new Set([".git", "node_modules", ".deno"]);


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
    req.onsuccess = () => {
      const db = req.result;
      // A factory reset deletes this database; an open connection would block
      // that delete forever (CAP-FB-20260830-PRIVACY-STATEMENT-01 found
      // `cap_fs_grants` surviving every reset). Let go the moment a
      // versionchange arrives — the next call opens afresh.
      if (db && typeof db.close === "function") db.onversionchange = () => db.close();
      resolve(db);
    };
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
 * @param {{ relativePath?: string, limit?: number | null }} [options]
 * @param {{ customIdb?: any }} [dbOptions]
 */
export async function listFsGrantEntries(
  grantId,
  { relativePath = "", limit = null } = {},
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
  // dptw: no listing ceiling — every entry is returned. An explicit caller
  // limit is a window request, honored exactly.
  const effectiveLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : Infinity;

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

/** Search file names across every stored grant without reading file content.
 * @param {string} [query]
 * @param {{ limit?: number | null, maxScanned?: number | null }} [options]
 * @param {{ customIdb?: any }} [dbOptions]
 */
export async function searchFsGrantFiles(
  query = "",
  { limit = null, maxScanned = null, includeIgnored = false } = {},
  { customIdb = null } = {},
) {
  const q = String(query ?? "").trim().toLowerCase();
  // dptw: no result/scan ceilings — an explicit caller limit is a window
  // request, honored exactly; the default is everything.
  const effectiveLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.trunc(Number(limit)) : Infinity;
  const effectiveScanLimit = Number.isFinite(Number(maxScanned)) && Number(maxScanned) > 0 ? Math.max(Math.trunc(Number(maxScanned)), 1) : Infinity;
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
      permissionIssues.push({ grantId: grant.grantId, name: grant.name, status });
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
        errors.push({ grantId: grant.grantId, path: relativePath, error: `get_file_failed: ${err?.message || err}` });
      }
    };

    if (grant.kind === "file") {
      await addFile(grant.handle, grant.name);
      continue;
    }

    const walk = async (dirHandle, prefix = "", depth = 0) => {
      if (truncated) {
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
            if (!includeIgnored && DEFAULT_IGNORED_DIRS.has(name)) {
              continue;
            }
            scanned += 1;
            await walk(handle, path, depth + 1);
          } else {
            await addFile(handle, path);
          }
        }
      } catch (err) {
        errors.push({ grantId: grant.grantId, path: prefix, error: `enumeration_failed: ${err?.message || err}` });
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
    scanned,
    truncated,
  };
}

/**
 * Bounded file reading within a granted handle (digest-pinned).
 *
 * A handle-backed read is NEVER refused or placeholder-substituted on size
 * alone. The read is local — the size of the file is irrelevant to reading
 * it — so a whole-file read returns the complete content and `offset`/`length`
 * windows read through files of ANY size in chunks (CAP-FB-20260902-NO-SILLY-
 * READ-CAPS-01: the old fs_file_too_large refusal at a caller-supplied
 * maxBytes default once refused a 9080-byte README; review r3 removed the
 * last size ceiling and its guidance placeholder — requested content always
 * comes back, never a notice in its place, and never truncated:false while
 * content was withheld). How much of a very large read the model sees inline
 * is the transport's decision, not a substitution in this read. Text windows
 * are aligned to whole UTF-8 characters: a window edge that splits a
 * multi-byte sequence is widened to the characters it falls inside (at most 3
 * bytes each side) so valid text never fails as fs_file_not_text, and
 * `start`/`end` report the exact byte span whose text came back. `sha256`
 * covers that returned span so a caller re-reading the same window can detect
 * drift.
 * @param {string} grantId
 * @param {{ relativePath?: string, asText?: boolean, offset?: number, length?: number, maxBytes?: number }} [options]
 * @param {{ customIdb?: any }} [dbOptions]
 */
export async function readFsGrantFile(
  grantId,
  {
    relativePath = "",
    asText = true,
    offset = null,
    length = null,
    // Legacy transport knob: the 2000-byte default this bound once carried is
    // what refused whole files. Reads no longer consult it — a caller that
    // wants less than the whole file asks for a window with offset/length.
    // Kept in the signature so older callers do not break.
    maxBytes = null,
  } = {},
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

  const fileSize = typeof file?.size === "number" ? file.size : 0;

  // Byte window: whole file by default; offset/length pick a window (clamped
  // to EOF) so ANY file size is readable in chunks. No size bound lives here
  // and no content is substituted for the requested bytes: the read returns
  // the complete requested content at any size. Deciding how much of a very
  // large read the model sees inline is the transport's job (tool-result
  // bounds, payload-by-reference), never this read's.
  const hasOffset = Number.isInteger(offset);
  const hasLength = Number.isInteger(length);
  const explicitWindow = hasOffset || hasLength;
  const start = explicitWindow
    ? Math.min(Math.max(0, hasOffset ? offset : 0), fileSize)
    : 0;
  const end = explicitWindow
    ? Math.min(fileSize, start + (hasLength ? Math.max(0, length) : fileSize - start))
    : fileSize;

  // UTF-8 text is decoded as whole characters, never per arbitrary byte
  // window: a window edge that splits a multi-byte sequence would otherwise
  // fail a fatal decoder with fs_file_not_text on valid text. The span is
  // widened to the character boundaries the requested window falls inside
  // (at most 3 bytes each side) and the span actually returned is disclosed
  // in start/end; the digest covers exactly that span. Binary reads
  // (asText:false) use the requested window untouched.
  let spanStart = start;
  let spanEnd = end;
  if (asText && fileSize > 0) {
    spanStart = Math.max(0, start - 3);
    spanEnd = Math.min(fileSize, end + 3);
  }

  let windowBytes = new Uint8Array(0);
  try {
    if (typeof file.slice === "function") {
      // file.slice bounds the allocation to the span, so a huge file is read
      // a piece at a time without ever loading the whole file.
      windowBytes = new Uint8Array(await file.slice(spanStart, spanEnd).arrayBuffer());
    } else {
      const whole = typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : new ArrayBuffer(0);
      const wholeBytes = new Uint8Array(whole);
      windowBytes = wholeBytes.subarray(spanStart, Math.min(spanEnd, wholeBytes.byteLength));
    }
  } catch (err) {
    return { ok: false, error: `read_bytes_failed: ${err?.message || err}` };
  }

  // Align the requested byte window to whole characters for text reads.
  let effStart = start;
  let effEnd = end;
  if (asText && fileSize > 0 && windowBytes.byteLength > 0) {
    const isContinuation = (byte) => (byte & 0xc0) === 0x80;
    const charLengthAt = (byte) =>
      (byte & 0x80) === 0 ? 1
        : (byte & 0xe0) === 0xc0 ? 2
        : (byte & 0xf0) === 0xe0 ? 3
        : (byte & 0xf8) === 0xf0 ? 4
        : 0;
    // Snap start back to the leading byte of the character it falls inside.
    if (start >= spanStart && start < spanStart + windowBytes.byteLength) {
      let head = start;
      while (head > spanStart && isContinuation(windowBytes[head - spanStart])) head -= 1;
      if (!isContinuation(windowBytes[head - spanStart])) effStart = head;
      // A continuation at spanStart itself means the region starts mid-
      // character (invalid bytes): leave start put, the decode rejects below.
    }
    // Snap end forward past the character containing the last requested byte.
    if (end > start && end - 1 >= spanStart && end - 1 < spanStart + windowBytes.byteLength) {
      let head = end - 1;
      while (head > spanStart && isContinuation(windowBytes[head - spanStart])) head -= 1;
      const len = charLengthAt(windowBytes[head - spanStart]);
      if (len > 0) {
        const charEnd = Math.min(fileSize, head + len);
        if (charEnd > effEnd) effEnd = charEnd;
      }
    }
  }
  if (effEnd - spanStart > windowBytes.byteLength) {
    effEnd = spanStart + windowBytes.byteLength; // a short read cannot invent bytes
  }
  const decodeBytes = windowBytes.subarray(effStart - spanStart, effEnd - spanStart);
  const sha256 = await computeSha256(decodeBytes);

  let textContent = null;
  if (asText) {
    const hasBinaryControls = decodeBytes.some((byte) =>
      byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127
    );
    try {
      textContent = new TextDecoder("utf-8", { fatal: true }).decode(decodeBytes);
    } catch { /* rejected below */ }
    if (hasBinaryControls || textContent === null) {
      return { ok: false, error: "fs_file_not_text", grantId, path: segments.join("/"), size: fileSize, sha256 };
    }
  }

  const out = {
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
  if (explicitWindow) {
    out.start = effStart;
    out.end = effEnd;
  }
  return out;
}

// chrome-agent-platform-coz19: interim bounds on model-supplied regex grep,
// until tmdm admits the managed rregex Wasm tool (a guaranteed linear-time
// engine). V8 backtracks, and a single catastrophic re.test() is
// UNINTERRUPTIBLE in-process — one nested-quantifier pattern over a large line
// freezes the entire privileged service worker — so unsafe shapes are refused
// BEFORE compilation rather than raced with a deadline (which cannot fire
// mid-match anyway). The bound is a conservative syntactic admission, NOT a
// linearity proof:
//   - REFUSED: a quantifier applied to a group whose body contains a quantifier
//     or an alternation AT ANY DEPTH — the canonical exponential classes
//     ((a+)+, (a*)*, (a|b)+, ([a-z]+)*, (x(a|b)y)+, x(?=(a+)+b)) — and
//     backreferences (\1..\9, \k<name>), which are NP-hard alongside
//     quantifiers and unsupported by rregex anyway, so the interim admitted
//     language is a subset of what the eventual linear-time engine can run.
//   - ADMITTED: quantifier-free, alternation-free groups under quantifiers
//     ((ab)+ — fixed-string repetition, linear) and the polynomial ambiguity
//     classes a static bound cannot exclude (a+a+); those are contained by the
//     CONTENT bounds at the match site instead (MAX_REGEX_LINE_CHARS per line,
//     MAX_REGEX_SCAN_CHARS cumulative per call — both honestly reported).
// Scanning is escape- and character-class-aware; group prefixes ((?:, (?=,
// (?<=, (?<name>...) are consumed so their '?' is never mistaken for a
// quantifier. A literal '{' counts as a quantifier (conservative).
/** Per-line cap for regex matching; longer lines are skipped and counted. */
export const MAX_REGEX_LINE_CHARS = 8192;
/** Cumulative chars one grep call may feed to re.test(); hitting it stops the
 * scan with truncated=true and regexBounds.scanBudgetHit=true. */
export const MAX_REGEX_SCAN_CHARS = 4_000_000;

/** Wall-clock TIME BUDGET for the CUMULATIVE matching in one grep_files regex
 * call (coz19 round 2; RENAMED in round 3 per review: it is NOT a match
 * deadline). Checked BETWEEN lines — a single synchronous re.test() cannot be
 * interrupted inside a service worker (no preemption exists there), so
 * admission (regexComplexityViolation) bounds ONE match and this bounds their
 * ACCUMULATION. Hitting it is honest, never silent: truncated=true and
 * regexBounds.timeBudgetHit=true. */
export const REGEX_TIME_BUDGET_MS = 4_000;

/** coz19 round 3: an explicit bound {n,m} with m at or above this counts as
 * LARGE — scan-time indistinguishable from unbounded ({0,8192} over an
 * 8192-char line IS the whole line). Review falsification of round 2:
 * a{0,8192}a{0,8192}a{0,8192}b and (?=a{0,8192}a{0,8192}b)a were ADMITTED by
 * the unbounded-only counters and each froze the real V8 matcher under a 2s
 * bound (exit 124). */
const LARGE_REPETITION_MIN = 64;

/** coz19 round 3 product budget (coord: "a crude cost estimate - product of
 * quantifier maxima against the line length, refused above a threshold").
 * Worst-case work for ONE line ≈ (line start positions ≤ 8192) × (product of
 * per-quantifier choice counts). A budget of 10,000 keeps the zero-pruning
 * worst case under ~8.2e7 backtrack steps ≈ well under a second in V8; real
 * patterns with mandatory separators prune far below the bound. One repetition
 * of any shape stays inside the budget (≤ 8193 choices); two LARGE repetitions
 * (6.7e7) are refused — the syntactic scanner cannot know that a separator
 * prunes (\d+:\d+ measured 0.1ms, but \w+x\d+q-shaped patterns with the same
 * product freeze), so the actionable alternative is a small explicit bound:
 * \d{1,2}:\d{2} instead of \d+:\d+. */
const REGEX_PRODUCT_BUDGET = 10_000;

/** Refusal reasons — model-actionable by design (the model reads `detail`). */
const ADJACENT_LARGE_REASON = "two LARGE repetitions in direct concatenation (a+a+, a{0,8192}a{0,8192}, (a+)(a+), .*\\d+, .+a* — unbounded *, +, {n,} or an explicit {n,m} with m >= 64) are not admitted in grep regex mode — overlapping repetitions backtrack superlinearly inside ONE uninterruptible match, and the per-line content cap does not contain them (a+a+a+a+a+b and a{0,8192}a{0,8192}a{0,8192}b each froze the real V8 matcher on a single 8192-char line); put a mandatory literal between the repetitions, use a small explicit bound {m,n}, or use literal search";
const UNIVERSAL_LARGE_REASON = "more than one LARGE quantifier (unbounded *, +, {n,} or {n,m} with m >= 64) over a universal class ('.', '[^...]', '\\D', '\\W', '\\S') is not admitted in grep regex mode — two overlapping universal repetitions are O(line²) split points per start position inside ONE uninterruptible match; anchor the pattern, replace one repetition with a restricted class (\\d, \\w, [a-z]) or a small explicit bound, or split into multiple greps";
const TOTAL_LARGE_REASON = "more than two LARGE repetitions (unbounded *, +, {n,} or explicit {n,m} with m >= 64) in one alternation branch are not admitted in grep regex mode — each additional repetition multiplies the worst-case backtracking of ONE uninterruptible match by the line length (\\d+:\\d+:\\d+ over a colon-dense 8 KiB line is cubic); merge repetitions into one, use a small explicit bound, or split into multiple greps";
const PRODUCT_BUDGET_REASON = "the product of per-repetition choice counts in one alternation branch exceeds the admitted budget of 10,000 — worst-case backtracking for one line ≈ (start positions) × (that product) inside ONE uninterruptible match, and a syntactic scanner cannot know that a mandatory separator prunes the splits (review repro a{0,8192}a{0,8192}a{0,8192}b: 8193³ combinations, froze the real V8 matcher under a 2s bound; \\d+:\\d+ is 6.7e7 and is refused for the same reason); use small explicit bounds (\\d{1,2}:\\d{2} instead of \\d+:\\d+), fewer repetitions, or literal search";

/**
 * Conservative syntactic complexity bound for model-supplied grep patterns.
 * Returns null when the pattern is admitted, or a human/model-actionable
 * reason string when refused. Pure and synchronous — testable without a grant.
 *
 * coz19 ROUND 3 (second review falsification: BOUNDED quantifiers bypassed the
 * round-2 unbounded-only counters — 'a{0,8192}a{0,8192}a{0,8192}b' and the
 * lookaround '(?=a{0,8192}a{0,8192}b)a' were ADMITTED and each froze the real
 * V8 matcher under a 2s bound). The admitted language is provably tame for a
 * single uninterruptible re.test():
 *   1. quantified groups whose body contains a quantifier or alternation
 *      (exponential class) — refused  [round 1];
 *   2. backreferences — refused  [round 1];
 *   3. two LARGE repetitions in DIRECT concatenation (nothing mandatory
 *      between them, group boundaries transparent) — refused  [rounds 2+3];
 *   4. more than one LARGE quantifier over a universal class ('.', negated
 *      classes, \D \W \S — per alternation branch) — refused  [rounds 2+3];
 *   5. more than TWO LARGE repetitions in total per alternation branch —
 *      refused  [round 2, generalized in round 3];
 *   6. the PRODUCT of per-quantifier choice counts per alternation branch
 *      above 10,000 — refused  [round 3: worst-case line work ≈ start
 *      positions × product, and a syntactic scanner cannot know that a
 *      separator prunes].
 * LARGE = unbounded (*, +, {n,}) or an explicit {n,m} with m >= 64 —
 * {0,8192} over an 8192-char line is scan-time indistinguishable from +.
 * An exact {n} is deterministic (one split choice, like a literal) and a small
 * {n,m} contributes its m+1 choices to the product only. What survives has a
 * bounded product of split choices — worst case ~8.2e7 backtrack steps per
 * line even with zero pruning — and lookarounds are scanned like groups, so
 * their contents count too. The cumulative per-call budgets in grepFsGrant
 * bound the accumulation ACROSS lines (the time budget cannot interrupt one
 * synchronous match — nothing in a service worker can — and is documented as
 * the per-line budget it is), and every bound is honestly reported.
 * Structural invalidity stays RegExp's domain (fs_grep_invalid_regex).
 * The managed ReDoS-safe engine is tmdm.
 * @param {string} src the raw pattern source (without flags)
 * @returns {string | null}
 */
export function regexComplexityViolation(src) {
  const s = String(src ?? "");
  const LINE_CHOICES = MAX_REGEX_LINE_CHARS + 1; // split choices of one unbounded repetition on a full line
  const newFrame = () => ({
    risky: false,            // round-1 nested rule: a quantifier or alternation in this body
    bodyUniversal: false,    // this body contains a universal-class atom (for group quantifiers)
    univBranch: 0,           // LARGE universal quantifiers on the current alternation branch
    univMax: 0,              // max across completed branches
    largeBranch: 0,          // ALL LARGE quantifiers on the current alternation branch (r3: unbounded or {n,m} m>=64)
    largeMax: 0,             // max across completed branches
    prodBranch: 0,           // log2 of the product of per-quantifier choices on the current branch (r3)
    prodMax: 0,              // max across completed branches
    atomPending: null,       // the atom awaiting a possible quantifier {universal, endedLarge?}
    prevLarge: false,        // the last completed entity was LARGE-quantified (adjacency state)
  });
  // One frame per open group; the root frame never closes and is never refused.
  const stack = [newFrame()];
  let inClass = false;
  let classNegated = false;
  let justQuantified = false; // the previous token was a quantifier: a '?' now is the lazy modifier

  // An atom just finished (literal, escape, class, or a closed group). The
  // entity before it completes as bounded — unless it was a group whose body
  // ENDED unbounded ('(a+)' behaves like 'a+' for adjacency across the
  // boundary), in which case the adjacency state survives.
  const atomArrives = (frame, universal) => {
    if (frame.atomPending) {
      frame.prevLarge = frame.atomPending.endedLarge === true;
    }
    frame.atomPending = { universal };
    if (universal) frame.bodyUniversal = true;
    justQuantified = false;
  };

  const applyQuantifier = (frame, { large, choices }) => {
    if (large && frame.prevLarge) return ADJACENT_LARGE_REASON;
    if (large) {
      frame.largeBranch += 1;
      if (frame.atomPending?.universal) frame.univBranch += 1;
    }
    frame.prodBranch += Math.log2(choices);
    frame.prevLarge = large;
    frame.atomPending = null;
    frame.risky = true; // any quantifier marks the body risky (round-1 nested rule)
    justQuantified = true;
    return null;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const top = stack[stack.length - 1];
    if (inClass) {
      if (c === "\\") { i++; continue; }
      if (c === "]") {
        inClass = false;
        atomArrives(top, classNegated); // a negated class is universal-ish: it matches almost anything
      }
      continue;
    }
    if (c === "\\") {
      const n = s[++i];
      if (n === undefined) break;
      if ((n >= "1" && n <= "9") || n === "k") {
        return `backreference \\${n} is not admitted in grep regex mode — backreferences are NP-hard alongside quantifiers and unsupported by the ReDoS-safe engine (tmdm); restructure the pattern or use literal search`;
      }
      if (n === "b" || n === "B") { justQuantified = false; continue; } // zero-width: neutral, not an atom
      if (n === "p" || n === "P") { // \p{...} / \P{...}: consume the brace block; \P is universal-ish
        const end = s.indexOf("}", i);
        if (end !== -1) i = end;
        atomArrives(top, n === "P");
        continue;
      }
      atomArrives(top, n === "D" || n === "W" || n === "S");
      continue;
    }
    if (c === "[") {
      // Consume the class; a leading '^' makes it universal-ish. A ']' right
      // after '[' or '[^' is a literal per JS class parsing — the scan below
      // handles it because classNegated/first-position ']' ends the class the
      // same way RegExp would reject or accept it structurally (not our call).
      classNegated = s[i + 1] === "^";
      inClass = true;
      continue;
    }
    if (c === "(") {
      // Consume the group prefix so its '?' never reads as a quantifier.
      if (s[i + 1] === "?") {
        if (s[i + 2] === "<" && (s[i + 3] === "=" || s[i + 3] === "!")) i += 3; // (?<= (?<!
        else if (s[i + 2] === "=" || s[i + 2] === "!" || s[i + 2] === ":" || s[i + 2] === "#") i += 2; // (?= (?! (?: (?#
        else if (s[i + 2] === "<") { // (?<name>
          const end = s.indexOf(">", i + 3);
          i = end === -1 ? i + 2 : end;
        } else if (s[i + 2] === "P" && s[i + 3] === "<") { // (?P<name>
          const end = s.indexOf(">", i + 4);
          i = end === -1 ? i + 3 : end;
        } else {
          i += 1; // unknown (?... construct: skip the '?' only, stay conservative
        }
      }
      // The group is the parent's next atom; the child inherits the parent's
      // adjacency state so '(a+)(a+)' is caught across the boundary. The
      // pending atom (if any) COMPLETES at the group open, so the inherited
      // state must be read from it first — a closed group that ENDED large
      // ('(a+)') behaves like a large entity for the next atom.
      const inheritedLarge = top.atomPending
        ? top.atomPending.endedLarge === true
        : top.prevLarge;
      top.atomPending = null;
      const child = newFrame();
      child.prevLarge = inheritedLarge;
      stack.push(child);
      justQuantified = false;
      continue;
    }
    if (c === ")") {
      // Structural invalidity is RegExp's own verdict (fs_grep_invalid_regex),
      // never the bound's — stop scanning and admit; compilation refuses it.
      if (stack.length === 1) return null;
      const closed = stack.pop();
      if (closed.atomPending) closed.prevLarge = false; // body's last atom never got a quantifier
      const parent = stack[stack.length - 1];
      parent.univBranch += Math.max(closed.univMax, closed.univBranch);
      parent.largeBranch += Math.max(closed.largeMax, closed.largeBranch);
      parent.prodBranch += Math.max(closed.prodMax, closed.prodBranch);
      const next = s[i + 1];
      const quantified = next === "*" || next === "+" || next === "?" || next === "{";
      if (quantified && closed.risky) {
        return "a quantified group whose body contains a quantifier or an alternation is not admitted in grep regex mode — that shape backtracks exponentially in V8 and one catastrophic match freezes the whole service worker; simplify the group (quantifier-free bodies like (ab)+ are fine), use literal search, or wait for the ReDoS-safe engine (tmdm)";
      }
      // The closed group becomes the parent's pending atom; its adjacency
      // tail (did the body END large?) travels with it.
      if (parent.atomPending) parent.prevLarge = parent.atomPending.endedLarge === true;
      parent.atomPending = { universal: closed.bodyUniversal, endedLarge: closed.prevLarge };
      if (parent && (quantified || closed.risky)) parent.risky = true;
      justQuantified = false;
      continue;
    }
    if (c === "|") {
      top.risky = true;
      top.univMax = Math.max(top.univMax, top.univBranch);
      top.univBranch = 0;
      top.largeMax = Math.max(top.largeMax, top.largeBranch);
      top.largeBranch = 0;
      top.prodMax = Math.max(top.prodMax, top.prodBranch);
      top.prodBranch = 0;
      if (top.atomPending) top.prevLarge = top.atomPending.endedLarge === true;
      top.atomPending = null;
      justQuantified = false;
      continue;
    }
    if (c === "^" || c === "$") { justQuantified = false; continue; } // zero-width anchors: neutral
    if (c === "*" || c === "+" || c === "?") {
      if (justQuantified && c === "?") continue; // lazy modifier on the previous quantifier (a+?, .*?)
      const violation = applyQuantifier(top, c === "?" ? { large: false, choices: 2 } : { large: true, choices: LINE_CHOICES });
      if (violation) return violation;
      continue;
    }
    if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(s.slice(i));
      if (!m) { atomArrives(top, false); continue; } // a literal '{' (Annex B), not a quantifier
      let q;
      if (m[2] === undefined) q = { large: false, choices: 1 }; // exact {n}: deterministic, one split choice like a literal
      else if (m[3] === "") q = { large: true, choices: LINE_CHOICES }; // {n,}: repeats without an upper bound
      else {
        // r3: bounded counts TOO — {0,8192} over an 8192-char line is the
        // whole line; m >= 64 is scan-time indistinguishable from unbounded.
        const hi = Math.min(Number(m[3]), MAX_REGEX_LINE_CHARS);
        q = { large: hi >= LARGE_REPETITION_MIN, choices: hi + 1 };
      }
      const violation = applyQuantifier(top, q);
      if (violation) return violation;
      i += m[0].length - 1;
      continue;
    }
    if (c === ".") { atomArrives(top, true); continue; }
    atomArrives(top, false); // any other literal character
  }
  const root = stack[0];
  const universals = Math.max(root.univMax, root.univBranch);
  if (universals > 1) return UNIVERSAL_LARGE_REASON;
  const larges = Math.max(root.largeMax, root.largeBranch);
  if (larges > 2) return TOTAL_LARGE_REASON;
  const product = Math.max(root.prodMax, root.prodBranch);
  if (product > Math.log2(REGEX_PRODUCT_BUDGET)) return PRODUCT_BUDGET_REASON;
  // Unclosed groups/classes and dangling escapes are structural problems:
  // admitted here so new RegExp produces the genuine fs_grep_invalid_regex.
  return null;
}

/**
 * Recursive, bounded content search (grep) over a granted directory handle.
 * Returns matching lines as `{ path, line, text }` — a real grep, never a
 * silent empty result. Binary and oversized files are skipped. `regex` opts
 * into RegExp matching (allowed under MV3 CSP — RegExp is not eval/new
 * Function); chrome-agent-platform-coz19: a model-supplied pattern is
 * COMPLEXITY-BOUNDED before compilation (regexComplexityViolation refuses the
 * nested-quantifier, backreference, adjacent-unbounded-quantifier and
 * multiple-universal-repetition classes whose single catastrophic re.test() is
 * uninterruptible and would freeze the whole privileged service
 * worker) and CONTENT/WORK-BOUNDED during the scan (per-line cap + cumulative
 * budget + wall-clock deadline, all honestly reported via regexBounds and the
 * truncated flag - every partial-result path sets it). The
 * default remains a literal substring match, which cannot ReDoS. The managed
 * ReDoS-safe engine (guaranteed linear time) is tmdm.
 * @param {string} grantId
 * @param {{ query?: string, relativePath?: string, regex?: boolean, ignoreCase?: boolean, maxMatches?: number | null, maxDepth?: number | null, regexTimeBudgetMs?: number }} [options]
 * @param {{ customIdb?: any, _now?: () => number }} [dbOptions]
 */
export async function grepFsGrant(
  grantId,
  { query = "", relativePath = "", regex = false, ignoreCase = false, maxMatches = null, maxDepth = null, includeIgnored = false, regexTimeBudgetMs = REGEX_TIME_BUDGET_MS } = {},
  { customIdb = null, _now = Date.now } = {},
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
  // coz19: regex mode IS model-supplied and V8 backtracks, so the pattern is
  // complexity-bounded BEFORE compilation and the content is bounded during
  // the scan — a single catastrophic re.test() is uninterruptible, and the
  // blast radius is the entire service worker.
  let matcher;
  let regexBounds = null;
  let regexStartedAt = 0;
  if (regex) {
    const violation = regexComplexityViolation(q);
    if (violation) {
      return { ok: false, error: "fs_grep_regex_too_complex", detail: violation };
    }
    let re;
    try {
      re = new RegExp(q, ignoreCase ? "i" : "");
    } catch (err) {
      return { ok: false, error: "fs_grep_invalid_regex", detail: String(err?.message || err) };
    }
    matcher = (line) => re.test(line);
    regexBounds = { skippedLongLines: 0, scanBudgetHit: false, timeBudgetHit: false, charsTested: 0 };
    regexStartedAt = _now();
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
  const matches = [];
  let filesScanned = 0;
  let truncated = false;
  // dptw: no match/file-scan ceilings and no per-file skip — an explicit
  // maxMatches is a window request, honored exactly. (coz19 adds a SAFETY
  // budget to REGEX mode only — a cumulative scanned-char cap reported via
  // regexBounds.scanBudgetHit and the truncated flag; it bounds adversarial
  // work, never the caller's requested window, and it is never silent.)
  const effectiveMax = Number.isFinite(Number(maxMatches)) && Number(maxMatches) > 0 ? Math.trunc(Number(maxMatches)) : Infinity;
  const effectiveDepth = Number.isFinite(Number(maxDepth)) && Number(maxDepth) > 0 ? Math.trunc(Number(maxDepth)) : Infinity;

  const scanFile = async (handle, path) => {
    if (matches.length >= effectiveMax) {
      truncated = true;
      return;
    }
    let file;
    try {
      file = typeof handle?.getFile === "function" ? await handle.getFile() : handle;
    } catch { return; }
    const size = typeof file?.size === "number" ? file.size : 0;
    filesScanned += 1;
    let buffer;
    try {
      buffer = typeof file?.arrayBuffer === "function" ? await file.arrayBuffer() : null;
    } catch { return; }
    if (!buffer) return;
    const bytes = new Uint8Array(buffer);
    // Skip binary files: check binary control bytes on the first 8192 bytes.
    const probe = bytes.subarray(0, 8192);
    if (probe.some((b) => b === 0)) return;
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
      if (regexBounds) {
        // coz19 content bounds (defense in depth for the residue a static
        // bound cannot exclude): cap what one re.test() can be asked to
        // swallow, cap the cumulative regex work per call, and cap the
        // wall-clock spent matching ACROSS lines (round-3 honesty: the time
        // budget is checked between lines and CANNOT interrupt one
        // synchronous match — admission bounds a single match, this bounds
        // their accumulation). All three are honest: skips count, and EVERY
        // partial-result path sets the truncated flag the model reads.
        if (_now() - regexStartedAt > regexTimeBudgetMs) {
          regexBounds.timeBudgetHit = true;
          truncated = true;
          return;
        }
        if (line.length > MAX_REGEX_LINE_CHARS) {
          regexBounds.skippedLongLines += 1;
          truncated = true;
          continue;
        }
        if (regexBounds.charsTested + line.length > MAX_REGEX_SCAN_CHARS) {
          regexBounds.scanBudgetHit = true;
          truncated = true;
          return;
        }
        regexBounds.charsTested += line.length;
      }
      if (matcher(line)) {
        matches.push({ path, line: i + 1, text: line });
      }
    }
  };

  const walk = async (dir, prefix, depth) => {
    if (truncated || matches.length >= effectiveMax) return;
    if (depth > effectiveDepth) {
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
        if (matches.length >= effectiveMax) {
          truncated = true;
          return;
        }
        const handle = Array.isArray(raw) ? raw[1] : raw;
        const name = String(handle?.name ?? "");
        const path = prefix ? `${prefix}/${name}` : name;
        const kind = handle?.kind || (handle?.getFile ? "file" : "directory");
        if (kind === "directory") {
          if (!includeIgnored && DEFAULT_IGNORED_DIRS.has(name)) continue;
          await walk(handle, path, depth + 1);
        } else {
          await scanFile(handle, path);
        }
      }
    } catch { /* enumeration failure is bounded: return what we have */ }
  };

  if (grant.kind === "file") {
    await scanFile(grant.handle, grant.name);
    return { ok: true, grantId, query: q, matches, filesScanned, matchCount: matches.length, truncated, ...(regexBounds ? { regexBounds } : {}) };
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

  return { ok: true, grantId, query: q, matches, filesScanned, matchCount: matches.length, truncated, ...(regexBounds ? { regexBounds } : {}) };
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
 * @param {{ maxEntries?: number | null, maxDepth?: number | null }} [options]
 * @param {{ customIdb?: any }} [dbOptions]
 */
export async function scanFsGrantManifest(
  grantId,
  { maxEntries = null, maxDepth = null, includeIgnored = false } = {},
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

  // dptw: no entry/byte/depth ceilings — the manifest walks everything.
  // Explicit caller maxEntries/maxDepth are window requests, honored exactly.
  const effectiveMaxEntries = Number.isFinite(Number(maxEntries)) && Number(maxEntries) > 0 ? Math.trunc(Number(maxEntries)) : Infinity;
  const effectiveMaxDepth = Number.isFinite(Number(maxDepth)) && Number(maxDepth) > 0 ? Math.trunc(Number(maxDepth)) : Infinity;

  async function walk(dirHandle, currentPath, depth) {
    if (depth > effectiveMaxDepth || entries.length >= effectiveMaxEntries) {
      truncated = true;
      return;
    }

    const iter = typeof dirHandle.values === "function"
      ? dirHandle.values()
      : typeof dirHandle.entries === "function"
      ? dirHandle.entries()
      : [];

    for await (const entry of iter) {
      const item = Array.isArray(entry) ? entry[1] : entry;
      const kind = item.kind || (item.getFile ? "file" : "directory");
      if (kind === "directory" && !includeIgnored && DEFAULT_IGNORED_DIRS.has(item.name)) {
        continue;
      }
      totalCount++;
      const relPath = currentPath ? `${currentPath}/${item.name}` : item.name;

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

      if (entries.length < effectiveMaxEntries) {
        entries.push(record);
        estimatedBytes += JSON.stringify(record).length;
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
      grantsLog.warn("FileSystemObserver.observe failed, falling back to polling", err);
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
