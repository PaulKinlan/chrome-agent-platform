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
async function setValue(path, key, value, { isMaster, trusted = false }) {
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
  if (serialized.length > MAX_VALUE_BYTES) {
    throw new Error(
      `value for "${key}" exceeds the ${MAX_VALUE_BYTES}-byte bound`,
    );
  }
  const dir = await openDir(path);
  const usage = await storeUsage(dir);
  const oldRaw = await readJson(dir, `${key}.json`);
  const isNew = oldRaw === null;
  const oldBytes = isNew ? 0 : JSON.stringify(oldRaw).length;
  // Aggregate quotas: a store may not grow past MAX_KEYS_PER_ORIGIN keys or
  // MAX_BYTES_PER_ORIGIN bytes (and the global tree past MAX_BYTES_GLOBAL).
  // Existing values can always be REPLACED (shrinking/rewriting is allowed);
  // growth beyond a quota fails closed.
  if (isNew && usage.keys + 1 > MAX_KEYS_PER_ORIGIN) {
    throw new Error(`key count exceeds the ${MAX_KEYS_PER_ORIGIN}-key bound`);
  }
  const delta = serialized.length - oldBytes;
  if (usage.bytes + Math.max(0, delta) > MAX_BYTES_PER_ORIGIN) {
    throw new Error(`store exceeds the ${MAX_BYTES_PER_ORIGIN}-byte bound`);
  }
  if (isNew && (await globalUsage()) + serialized.length > MAX_BYTES_GLOBAL) {
    throw new Error(`global memory exceeds the ${MAX_BYTES_GLOBAL}-byte bound`);
  }
  await writeJson(dir, `${key}.json`, value);
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
  while (
    entries.length > 1 && JSON.stringify(entries).length > MAX_JOURNAL_BYTES
  ) {
    entries = entries.slice(1); // cap bytes
  }
  await store.setTrusted("journal", entries);
  return entries;
}
