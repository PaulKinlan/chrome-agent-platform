// lib/memory.js — origin-keyed OPFS memory.
//
// Memory is the OPFS-backed store the agent reads/writes. Two tiers, both in
// the extension's OPFS origin (NOT shared with page origins):
//   - master memory  (the hub agent)  at memory/master/*
//   - per-site memory (sub-agents)    at memory/origins/<encoded-origin>/*
//
// One site origin must never access another's store: every per-site handle is
// keyed by the canonical origin string and opened via a lookup that returns a
// distinct subdirectory per origin. Reads/writes go through these helpers so
// callers never touch another origin's handle.

const ROOT = "memory";
const MASTER = "master";

import { kvGet } from "./kv.js";

const ENROLL_KEY = "cap:enrollment";

// OPFS memory bounds (Constitution §4): a single value may not exceed this
// serialized size, and the master store may not write these reserved registry
// keys (the enrollment authority must never be reachable via the model's
// `memory_set`). Per-origin stores are keyed separately so one site's growth
// cannot crowd another; the journal is separately capped in journalAppend.
const MAX_VALUE_BYTES = 256 * 1024; // 256 KiB per value (serialized JSON)
const MASTER_RESERVED_KEYS = new Set(["origins", "enrolled"]);
// Authority/registry keys that the MODEL's `memory_set` must never write on a
// SITE store: a worker that could write `approvals` or `toolDirectory` would
// bypass the owner's first-run approval or forge its own tool directory, and
// one that wrote `journal` could fabricate results. Internal TRUSTED code
// (approveTool/upsertTools/journalAppend/enrollOrigin) uses `setTrusted`, which
// bypasses this reservation; the model + page surfaces only reach `set`.
const SITE_RESERVED_KEYS = new Set([
  "approvals",
  "toolDirectory",
  "journal",
  "enrolled",
]);

// OPFS aggregate quotas (Constitution §4): stores — not just individual values
// — must be bounded. A site may hold at most this many keys and this many total
// serialized bytes; beyond that, `set`/`setTrusted` fail closed rather than
// growing without bound (the round-15 aggregate-unbounded finding).
const MAX_KEYS_PER_ORIGIN = 500;
const MAX_BYTES_PER_ORIGIN = 8 * 1024 * 1024; // 8 MiB per origin
const MAX_BYTES_GLOBAL = 64 * 1024 * 1024; // 64 MiB across all origins

/** Canonicalize an origin string (https://example.com:443 → https://example.com). */
export function canonicalOrigin(value) {
  try {
    const u = new URL(String(value));
    // Only http/https origins are supported; anything else (file:, data:,
    // about:, chrome-extension:) has a shared "null" or non-web origin that
    // must never be a storage boundary.
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Injective, reversible encoding of a canonical origin for a directory name.
 * encodeURIComponent is injective (every byte maps to a unique escape sequence)
 * and reversible; no lossy substitutions.
 */
function encodeOrigin(origin) {
  return encodeURIComponent(origin);
}

function decodeOrigin(encoded) {
  return decodeURIComponent(encoded);
}

/** Open (creating if needed) a directory handle for the given path segments. */
export async function openDir(segments) {
  let dir = await rootDir();
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

async function rootDir() {
  return await navigator.storage.getDirectory();
}

async function readJson(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    const f = await fh.getFile();
    return JSON.parse(await f.text());
  } catch {
    return null;
  }
}

async function writeJson(dir, name, value) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(value));
  await w.close();
}

/** Enumerate a store's existing .json keys + total serialized bytes (bounded
 * by the per-origin key cap). Used to enforce aggregate quotas on every write. */
async function storeUsage(dir) {
  let keys = 0;
  let bytes = 0;
  for await (const [name, handle] of dir.entries()) {
    if (!name.endsWith(".json")) continue;
    keys++;
    try {
      const f = await handle.getFile();
      bytes += f.size;
    } catch { /* unreadable — count the key, skip the size */ }
  }
  return { keys, bytes };
}

/** Total bytes across ALL per-site stores + master (the global budget). */
async function globalUsage() {
  let bytes = 0;
  const root = await rootDir();
  try {
    const memDir = await root.getDirectoryHandle(ROOT);
    async function walk(dir) {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "file" && name.endsWith(".json")) {
          try {
            bytes += (await handle.getFile()).size;
          } catch { /* skip */ }
        } else if (handle.kind === "directory") {
          await walk(handle);
        }
      }
    }
    await walk(memDir);
  } catch { /* memory tree absent — 0 bytes */ }
  return bytes;
}

/** The shared write path: bounds + reserved-key protection + aggregate quotas.
 * `trusted` bypasses the reserved-key protection (internal authority writes)
 * but NOT the byte/key quotas. */
// A global write mutex serializes the check-then-write of the aggregate quotas
// (per-store + global byte/key budgets). Without it, two concurrent writes each
// observe the available quota and jointly exceed it (the round-16 quota race).
let writeMutex = Promise.resolve();
function withWriteLock(fn) {
  const run = writeMutex.then(fn, fn);
  writeMutex = run.then(() => {}, () => {});
  return run;
}

/** UTF-8 byte length of a string (quota accounting must use BYTES, not UTF-16
 * code-unit `.length`, which under-counts non-ASCII data — the round-16 finding). */
function utf8Bytes(str) {
  return new TextEncoder().encode(str).byteLength;
}

/** The LOCKED body of setValue (no lock acquisition). Exported so callers that
 * ALREADY hold the global write mutex (saveScreenshot) can perform a nested
 * write without re-acquiring the same non-reentrant mutex (the round-19
 * critical deadlock: withWriteLock → setTrusted → setValue → withWriteLock hung
 * forever and poisoned all later OPFS writes). */
async function setValueInner(path, key, value, { isMaster, trusted = false }) {
  const reserved = isMaster ? MASTER_RESERVED_KEYS : SITE_RESERVED_KEYS;
  if (!trusted && reserved.has(String(key))) {
    throw new Error(`key "${key}" is reserved on this store`);
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`value for "${key}" is not JSON-serializable`);
  }
  const newBytes = utf8Bytes(serialized);
  if (newBytes > MAX_VALUE_BYTES) {
    throw new Error(
      `value for "${key}" exceeds the ${MAX_VALUE_BYTES}-byte bound`,
    );
  }
  const dir = await openDir(path);
  const usage = await storeUsage(dir);
  // Read the OLD value's ACTUAL file bytes (not a re-stringify) so the delta is
  // measured in the same unit (UTF-8 file bytes) as storeUsage/globalUsage.
  let oldBytes = 0;
  let isNew = true;
  try {
    const fh = await dir.getFileHandle(`${key}.json`);
    oldBytes = (await fh.getFile()).size;
    isNew = false;
  } catch { /* absent → new key */ }
  // Aggregate quotas: a store may not grow past MAX_KEYS_PER_ORIGIN keys or
  // MAX_BYTES_PER_ORIGIN bytes (and the global tree past MAX_BYTES_GLOBAL).
  // The delta is positive for BOTH new keys AND replacements that grow — a
  // replacement that enlarges an existing value must also be budgeted (the
  // round-16 finding: the global limit was only checked for new keys).
  if (isNew && usage.keys + 1 > MAX_KEYS_PER_ORIGIN) {
    throw new Error(`key count exceeds the ${MAX_KEYS_PER_ORIGIN}-key bound`);
  }
  const delta = newBytes - oldBytes;
  if (usage.bytes + Math.max(0, delta) > MAX_BYTES_PER_ORIGIN) {
    throw new Error(`store exceeds the ${MAX_BYTES_PER_ORIGIN}-byte bound`);
  }
  if ((await globalUsage()) + Math.max(0, delta) > MAX_BYTES_GLOBAL) {
    throw new Error(`global memory exceeds the ${MAX_BYTES_GLOBAL}-byte bound`);
  }
  await writeJson(dir, `${key}.json`, value);
}

async function setValue(path, key, value, { isMaster, trusted = false }) {
  return withWriteLock(() => setValueInner(path, key, value, { isMaster, trusted }));
}

/** A single origin-scoped store. `origin` is a canonical origin string or "master". */
export function memoryStore(origin) {
  const isMaster = origin === MASTER;
  // Guard: a site origin can never collide with the reserved master sentinel.
  const path = isMaster
    ? [ROOT, MASTER]
    : [ROOT, "origins", encodeOrigin(origin)];
  return {
    isMaster,
    origin,
    async get(key) {
      const dir = await openDir(path);
      return await readJson(dir, `${key}.json`);
    },
    async set(key, value) {
      return await setValue(path, key, value, { isMaster });
    },
    /** Internal trusted write (approveTool/upsertTools/journalAppend/
     * enrollOrigin): same bounds + quotas, but reserved authority keys are
     * writable ONLY here — never via the model's `memory_set`/`set`. */
    async setTrusted(key, value) {
      return await setValue(path, key, value, { isMaster, trusted: true });
    },
    async keys() {
      const dir = await openDir(path);
      const out = [];
      for await (const [name] of dir.entries()) {
        if (name.endsWith(".json")) out.push(name.slice(0, -5));
      }
      return out.sort();
    },
    async delete(key) {
      const dir = await openDir(path);
      try {
        await dir.removeEntry(`${key}.json`);
      } catch { /* absent */ }
    },
    async clear() {
      if (isMaster) {
        const parent = await openDir([ROOT]);
        try {
          await parent.removeEntry(MASTER, { recursive: true });
        } catch { /* absent */ }
        return;
      }
      // Remove ONLY this origin's subdirectory — never the whole origins tree.
      const origins = await openDir([ROOT, "origins"]);
      try {
        await origins.removeEntry(encodeOrigin(origin), { recursive: true });
      } catch { /* absent */ }
    },
  };
}

export const masterMemory = () => memoryStore(MASTER);

/** siteMemory accepts a raw origin string; it is canonicalized before use. */
export function siteMemory(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) {
    // Return a store that refuses to work on an invalid origin.
    const invalid = memoryStore(`invalid:${origin}`);
    return {
      ...invalid,
      async get() {
        return null;
      },
      async set() {
        throw new Error(`invalid origin: ${origin}`);
      },
      async setTrusted() {
        throw new Error(`invalid origin: ${origin}`);
      },
    };
  }
  return memoryStore(canonical);
}

/** Enumerate all enrolled site origins (the sub-agent directory).
 * Derived from the AUTHORITATIVE enrollment registry (`cap:enrollment` in
 * chrome.storage — NOT writable by the model's `memory_set`), never from OPFS
 * directory existence or the model-writable master-memory `origins` key. A
 * delayed write that recreates an OPFS directory after a delete, or a model
 * overwriting the `origins` key, must never resurrect or forge a worker in the
 * listing (the round-13/14 delete-race + enrollment findings). */
export async function listOrigins() {
  const s = await kvGet(ENROLL_KEY);
  const map = s[ENROLL_KEY] ?? {};
  return Object.keys(map)
    .filter((o) => map[o]?.enrolled === true)
    .sort();
}

// A small journal abstraction over a store (agent-do's memory pattern). The
// journal is bounded by BOTH count (500 entries) AND serialized size (a long
// model result must not blow past the value bound); long result/task text is
// truncated.
export async function journalAppend(store, entry) {
  const MAX_ENTRY_TEXT = 16 * 1024;
  const MAX_JOURNAL_BYTES = 200 * 1024;
  const journal = (await store.get("journal")) ?? [];
  const bounded = { ...entry };
  for (const k of ["result", "task"]) {
    if (typeof bounded[k] === "string" && bounded[k].length > MAX_ENTRY_TEXT) {
      bounded[k] = bounded[k].slice(0, MAX_ENTRY_TEXT);
    }
  }
  journal.push({ ts: Date.now(), ...bounded });
  let entries = journal.slice(-500); // cap count
  // The byte budget must use UTF-8 BYTES, not UTF-16 `.length` (which under-
  // counts non-ASCII result text — the round-18 medium finding).
  while (
    entries.length > 1 && utf8Bytes(JSON.stringify(entries)) > MAX_JOURNAL_BYTES
  ) {
    entries = entries.slice(1); // cap bytes
  }
  await store.setTrusted("journal", entries);
  return entries;
}

// Screenshots are LARGE media (a single base64 PNG is ~300 KiB) that cannot fit
// in the 256 KiB per-value memory bound. They are stored as SEPARATE OPFS files
// under memory/master/screenshots/*.json (each bounded by MAX_SCREENSHOT_BYTES),
// with a small metadata index (id/at/url ONLY — never the dataURL inline) kept
// in the `screenshots` memory key. The index + files are bounded by
// MAX_SCREENSHOTS; the oldest file is evicted when a new one arrives (the
// round-17 blocker: the old code pushed up to 20 base64 dataURLs into ONE value,
// overflowing the 256 KiB bound before a single image could be stored).
const MAX_SCREENSHOTS = 5;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024; // 4 MiB per screenshot

/** Persist a screenshot as a dedicated OPFS file + bounded metadata index.
 * ATOMIC: the blob write + index update + oldest-eviction run under the global
 * write mutex, and a failed index update compensates by deleting the just-
 * written blob — so two concurrent captures can never read the same index, lose
 * one metadata entry, and orphan an unbounded file (the round-18 screenshot
 * race). */
export async function saveScreenshot(mem, { url, dataURL }) {
  if (!dataURL || !String(dataURL).startsWith("data:image/")) {
    throw new Error("screenshot must be a data:image/* dataURL");
  }
  const bytes = utf8Bytes(String(dataURL));
  if (bytes > MAX_SCREENSHOT_BYTES) {
    throw new Error(`screenshot exceeds the ${MAX_SCREENSHOT_BYTES}-byte bound`);
  }
  return withWriteLock(async () => {
    const id = `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const dir = await openDir([ROOT, MASTER, "screenshots"]);
    // The metadata index lives on the same store `mem` points at (master). The
    // index write must NOT re-acquire the global write mutex (it is already held
    // by the surrounding withWriteLock) — call setValueInner directly with the
    // store's own path + trusted (the round-19 re-entrant deadlock).
    const indexPath = mem.isMaster
      ? [ROOT, MASTER]
      : [ROOT, "origins", encodeOrigin(mem.origin)];
    // Screenshots are LARGE media — charge the new blob against the GLOBAL quota
    // BEFORE writing (five 4 MiB blobs are 20 MiB and must count toward the
    // 64 MiB budget, the round-18 screenshot-quota finding).
    if ((await globalUsage()) + bytes > MAX_BYTES_GLOBAL) {
      throw new Error(`global memory exceeds the ${MAX_BYTES_GLOBAL}-byte bound`);
    }
    try {
      // Write the blob first, under ONE lock acquisition.
      await writeJson(dir, `${id}.json`, { url, dataURL, at: Date.now() });

      // Metadata index (small): id/at/url only, never the dataURL inline.
      const index = (await mem.get("screenshots")) ?? [];
      index.push({ id, at: Date.now(), url });
      const next = index.slice(-MAX_SCREENSHOTS);

      // COMMIT the index FIRST (the authoritative step), THEN evict the
      // orphaned blobs. If the index commit fails, the just-written blob is
      // removed and NO old blob is deleted — the persisted index still matches
      // the retained blobs (the round-18 "old blobs deleted before the index
      // commits" orphan bug).
      await setValueInner(indexPath, "screenshots", next, {
        isMaster: mem.isMaster,
        trusted: true,
      });
      const kept = new Set(next.map((s) => s.id));
      for (const s of index) {
        if (!kept.has(s.id)) {
          try {
            await dir.removeEntry(`${s.id}.json`);
          } catch { /* absent */ }
        }
      }
      return { id, url };
    } catch (e) {
      // Compensate: a failed index commit must not leave an orphaned blob.
      try {
        await dir.removeEntry(`${id}.json`);
      } catch { /* absent */ }
      throw e;
    }
  });
}

/** Read a stored screenshot blob by id (the dataURL + url). */
export async function loadScreenshot(id) {
  const dir = await openDir([ROOT, MASTER, "screenshots"]);
  return await readJson(dir, `${id}.json`);
}

/** List the screenshot metadata index (id/at/url only — never the dataURL). */
export async function listScreenshots() {
  return (await masterMemory().get("screenshots")) ?? [];
}
