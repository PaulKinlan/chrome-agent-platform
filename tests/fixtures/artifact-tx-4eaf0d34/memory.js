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

// The DURABLE VERSION AUTHORITY (the re-review's finding: the "store-global"
// counter was an in-memory Map keyed by a path ARRAY — a restart reset it and
// separate instances of the same store issued colliding sequences). The
// generation is a DURABLE per-store file (`__gen.json`): every write (plain,
// trusted, and CAS) issues the next generation from it under the global write
// mutex, so the sequence is monotonic, restart-safe, and consistent across
// every store instance of the same path.
const GEN_FILE = "__gen.json";
// The BOUNDED ABSENCE AUTHORITY: per-key tombstones live in a single
// `__tombs.json` value (a map key→generation) + a monotonic FLOOR (the highest
// folded generation). The floor is NOT a shared "current version": it only
// advances each absent key's DERIVED per-key version (a stale pre-fold token
// never matches, and two absent keys never share a token — the reviewer's
// cross-key + prune-ABA findings).
const MAX_TOMBSTONES = 512;
const TOMBS_FILE = "__tombs.json";
const INTERNAL_FILE_RE = /^(?:__gen\.json|__tombs\.json|__epoch\.json|.*\.tomb)$/;

/** FNV-1a 32-bit (a deterministic per-key absence seed). */
function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A per-key, NEGATIVE absence version — disjoint from the positive write
 * generations, distinct across keys (the low 20 bits are the key's hash), and
 * monotonic in the folded floor (an advancing floor changes every absent
 * version, so a stale pre-fold token never matches a post-fold absent key). */
function absentVersion(key, floor) {
  const f = Number.isSafeInteger(floor) && floor >= 0 ? floor : 0;
  return -((f + 1) * 0x100000 + (fnv1a32(String(key)) & 0xfffff) + 1);
}

/** Issue the next durable generation for a store directory. The caller holds
 * the global write mutex (atomic). Returns the generation. */
async function issueVersion(dir) {
  let genRaw;
  try {
    genRaw = await readJsonStrict(dir, GEN_FILE, { allowAbsent: true });
  } catch (e) {
    // The authority file is corrupt — FAIL CLOSED (never reset the sequence).
    throw new Error("the durable generation authority is corrupt");
  }
  if (!genRaw || genRaw.gen === undefined || genRaw.gen === null) {
    // The authority file may have been removed — restore the epoch (if a clear
    // carried it) so the sequence never restarts at 1.
    try {
      const epoch = await readJsonStrict(dir, "__epoch.json", { allowAbsent: true });
      if (epoch && Number.isSafeInteger(epoch.gen) && epoch.gen >= 0) genRaw = epoch;
    } catch { /* the epoch is best-effort; the __gen is authoritative */ }
  }
  const prev = genRaw?.gen;
  let gen;
  if (prev === undefined || prev === null) {
    gen = 1;
  } else if (Number.isSafeInteger(prev) && prev >= 0) {
    if (prev >= Number.MAX_SAFE_INTEGER) {
      throw new Error("the durable generation authority is exhausted");
    }
    gen = prev + 1;
  } else {
    // A corrupt/fractional/negative/unsafe generation is a FAILED authority —
    // never silently reset the sequence (the reviewer's finding).
    throw new Error("the durable generation authority is corrupt");
  }
  await writeJson(dir, GEN_FILE, { gen });
  return gen;
}

/** Read the bounded tombstone authority: { map: {key→gen}, floor } or null. */
async function readTombs(dir) {
  const raw = await readJsonStrict(dir, TOMBS_FILE, { allowAbsent: true });
  if (raw == null) return { map: new Map(), floor: 0 };
  if (typeof raw !== "object" || raw.map == null || typeof raw.map !== "object" ||
      (raw.floor != null && (!Number.isSafeInteger(raw.floor) || raw.floor < 0))) {
    throw new Error("the tombstone authority is corrupt");
  }
  const map = new Map();
  for (const [k, v] of Object.entries(raw.map)) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error("the tombstone authority is corrupt");
    map.set(k, v);
  }
  return { map, floor: Number.isSafeInteger(raw.floor) ? raw.floor : 0 };
}

/** Persist the bounded tombstone authority (map + floor), folding the oldest
 * entries into the floor when over the bound (a folded key NEVER returns to
 * version 0 — its absence resolves through the per-key DERIVED version). */
async function writeTombs(dir, tombs) {
  let entries = [...tombs.map.entries()];
  let floor = tombs.floor;
  if (entries.length > MAX_TOMBSTONES) {
    entries.sort((a, b) => a[1] - b[1]);
    const folded = entries.slice(0, entries.length - MAX_TOMBSTONES);
    for (const [, v] of folded) if (v > floor) floor = v;
    entries = entries.slice(entries.length - MAX_TOMBSTONES);
  }
  const obj = {};
  for (const [k, v] of entries) obj[k] = v;
  await writeJson(dir, TOMBS_FILE, { map: obj, floor });
  return { map: new Map(entries), floor };
}

/** The current durable version of a key:
 *  1. the LIVE value envelope's version (a live key always reports its write
 *     token — the reviewer's floor-shadows-live finding),
 *  2. else the per-key tombstone generation (a deleted key),
 *  3. else a DERIVED per-key NEGATIVE absence version (never-created / folded) —
 *     per-key distinct (no cross-key token reuse) + never 0 (no expected-0 ABA). */
async function currentVersion(dir, key) {
  // Read the tombstone authority FIRST so a corrupt `__tombs.json` fails closed
  // on EVERY read (never a silent reset), then let the LIVE envelope WIN over
  // any tombstone/floor (the reviewer's floor-shadows-live finding).
  const tombs = await readTombs(dir);
  const entry = await readEntry(dir, `${key}.json`, true);
  if (entry) {
    if (!Number.isSafeInteger(entry.v) || entry.v < 0) {
      throw new Error("a value envelope authority is corrupt");
    }
    return entry.v;
  }
  if (tombs.map.has(key)) return tombs.map.get(key);
  return absentVersion(key, tombs.floor);
}

import { kvGet } from "./kv.js";

const ENROLL_KEY = "cap:enrollment";

// OPFS memory bounds (Constitution §4): a single value may not exceed this
// serialized size, and the master store may not write these reserved registry
// keys (the enrollment authority must never be reachable via the model's
// `memory_set`). Per-origin stores are keyed separately so one site's growth
// cannot crowd another; the journal is separately capped in journalAppend.
const MAX_VALUE_BYTES = 256 * 1024; // 256 KiB per value (serialized JSON)
// The thread authority (`threads` index + every `thread:<id>` body) must be
// reserved from the MODEL's `memory_set` too: the wider-goal review proved a
// forged `threads` index could be written through `masterMemory().set` and
// `listThreads()` returned it. Internal thread code uses `setTrusted`.
const MASTER_RESERVED_KEYS = new Set(["origins", "enrolled", "assets", "threads", "scripts"]);
// The INTERNAL namespace + the artifact/repair prefixes are reserved on EVERY
// store — the model's memory_set can never write the generation authority,
// the WAL, a tombstone, or an artifact body/repair record (the reviewer's
// finding: __gen / assetRepair / asset:<id> were model-writable).
const INTERNAL_PREFIX_RE = /^(?:__gen|__tx|__wal|__epoch|__tombs)/;
// The full hidden namespace (keys()/get/list exclusion + set reservation).
const INTERNAL_KEY_RE = /^(?:__gen|__tx|__wal|__epoch|__tombs|assets|assetRepair|asset:)/;
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
  "assets",
  "scripts",
  "agentConfig",
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
  return readJsonStrict(dir, name, { allowAbsent: true });
}

/** STRICT JSON read: a missing file → null; a parse/corruption/I-O failure
 * THROWS (the generation/envelope authority never silently resets to a
 * default — the reviewer's finding). */
async function readJsonStrict(dir, name, { allowAbsent = false } = {}) {
  let fh;
  try {
    fh = await dir.getFileHandle(name);
  } catch (e) {
    if (allowAbsent && isNotFound(e)) return null;
    throw e;
  }
  let text;
  try {
    const f = await fh.getFile();
    text = await f.text();
  } catch (e) {
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`durable authority file ${name} is corrupt`);
  }
}

async function writeJson(dir, name, value) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(value));
  await w.close();
}

// ---- DURABLE VERSION TOKENS (the round-27 CAS blocker) ----
// Every store VALUE is persisted as a version envelope `{ __v, __value }` so the
// compensation CAS can compare a durable per-key VERSION — not JSON value
// equality. Value equality is not identity: an identical-value ABA (a new
// enrollment writing the same JSON value) and a lost-fresh-value overwrite both
// defeat a value-comparing CAS. A monotonic version that is NEVER reused, bumped
// on every write, makes the stale run's write uniquely identifiable.
//
// Legacy raw values (written before versioning, or non-envelope files like the
// screenshot blobs) read back as version 0 with the raw value — `readEntry` only
// unwraps a value whose shape IS an envelope, and it unwraps exactly ONE level
// (a model value that happens to look like `{ __v, __value }` is stored as the
// outer envelope's `__value` and round-trips intact).

/** Read a store key's versioned entry: `{ v, value }` or null when absent.
 * Legacy raw values (no envelope) are version 0. When `strict` is true a REAL
 * read/corruption failure (not a missing key) THROWS — never silently treated
 * as absent (the artifact-transaction finding). */
async function readEntry(dir, name, strict = false) {
  let fh;
  try {
    fh = await dir.getFileHandle(name);
  } catch (e) {
    if (strict && !isNotFound(e)) throw e;
    return null;
  }
  let text;
  try {
    const f = await fh.getFile();
    text = await f.text();
  } catch (e) {
    if (strict) throw e;
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    if (strict) throw e;
    return null;
  }
  if (
    parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
    typeof parsed.__v === "number" && Number.isFinite(parsed.__v) &&
    "__value" in parsed
  ) {
    return { v: parsed.__v, value: parsed.__value };
  }
  return { v: 0, value: parsed };
}

/** Is this error a benign "missing entry"? */
function isNotFound(e) {
  const name = e?.name ?? "";
  const msg = String(e?.message ?? "");
  return name === "NotFoundError" || msg.includes("not found") || msg.includes("no file") || msg.includes("missing");
}

/** Write a store key's versioned entry. */
async function writeEntry(dir, name, value, version) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ __v: version, __value: value }));
  await w.close();
}

/** Open a directory WITHOUT creating missing segments; returns null when the
 * path does not exist. Read paths (get/has/keys/CAS-compare) use this so a read
 * or a failed CAS can never RECREATE a directory that cleanup just removed
 * (the round-27 cleanup-recreation blocker: `openDir(create:true)` inside a CAS
 * resurrected a deleted origin directory even when the CAS mutated nothing). */
async function openDirOptional(segments) {
  let dir = await rootDir();
  for (const seg of segments) {
    try {
      dir = await dir.getDirectoryHandle(seg);
    } catch {
      return null;
    }
  }
  return dir;
}

/** Enumerate a store's existing .json keys + total serialized bytes (bounded
 * by the per-origin key cap). Used to enforce aggregate quotas on every write. */
async function storeUsage(dir) {
  let keys = 0;
  let bytes = 0;
  for await (const [name, handle] of dir.entries()) {
    if (!name.endsWith(".json") || INTERNAL_FILE_RE.test(name)) continue;
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
  const k = String(key);
  // Reserve both exact keys AND the `thread:` PREFIX on the master store: a
  // forged `thread:t_...` body must be as unreachable as a forged `threads`
  // index (the wider-goal review's thread-authority finding).
  const threadPrefix = isMaster && k.startsWith("thread:");
  // The internal namespace + the artifact prefixes are reserved on EVERY store
  // (trusted code may still write them via setTrusted).
  const internal = INTERNAL_PREFIX_RE.test(k) || k === "assetRepair" || k.startsWith("asset:");
  if (!trusted && (reserved.has(k) || threadPrefix || internal)) {
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
  // measured in the same unit (UTF-8 file bytes) as storeUsage/globalUsage. Also
  // read the OLD version (from the envelope) so the new write's version is
  // monotonic — a per-key version token that is NEVER reused (the round-27 CAS
  // blocker: value equality is not identity; the version is).
  let oldBytes = 0;
  let isNew = true;
  try {
    const fh = await dir.getFileHandle(`${key}.json`);
    oldBytes = (await fh.getFile()).size;
    isNew = false;
  } catch { /* absent → new key (or a deleted key with a tombstone) */ }
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
  // Issue the DURABLE generation and write the ENVELOPE. The returned version
  // is the write's durable identity token — callers capture it and pass it to
  // the version-scoped compareAndDelete/compareAndRestore so compensation
  // targets THIS write, never a same-value write (the round-27 blocker). A
  // recreate also clears any tombstone (the key is live again).
  const version = await issueVersion(dir);
  await writeEntry(dir, `${key}.json`, value, version);
  // A recreate clears the key from the tombstone MAP (the key is live again).
  const tombs = await readTombs(dir);
  if (tombs.map.has(key)) {
    tombs.map.delete(key);
    await writeTombs(dir, tombs);
  }
  return version;
}

async function setValue(path, key, value, { isMaster, trusted = false }) {
  return withWriteLock(() => setValueInner(path, key, value, { isMaster, trusted }));
}

/** Compare-and-swap on a single key, under the global write mutex (atomic with
 * every other `set`/`setTrusted`). The comparison is on the key's durable VERSION
 * TOKEN (the per-key monotonic version written into the envelope), NOT JSON value
 * equality. Writes `nextValue` (or DELETES when `nextValue === undefined`) only if
 * the key's CURRENT version equals `expectedVersion`; returns whether the swap
 * happened. This is the CAS primitive the compensation paths use so a stale run
 * can NEVER clobber a concurrent legitimate write — an identical-value ABA (a new
 * enrollment writing the SAME JSON value) bumps the version, so a stale
 * compensation holding the old version does NOT match and leaves the new write
 * intact (the round-27 value-CAS ABA blocker).
 *
 * The READ is non-creating: `openDirOptional` (not `openDir`) so a mismatched CAS
 * never recreates a directory that cleanup just removed (the round-27 cleanup-
 * recreation blocker). A write that DOES land creates the directory only for the
 * actual mutation. */
async function compareAndSet(path, key, expectedVersion, nextValue, { isMaster }) {
  return withWriteLock(async () => {
    const dir = await openDirOptional(path);
    const cur = dir ? await currentVersion(dir, key) : 0;
    if (cur !== expectedVersion) {
      // IDEMPOTENT delete: a retry of an already-tombstoned delete returns the
      // existing tombstone generation (the delete already happened) rather than
      // false — the reviewer's non-idempotent-retry finding. Only a CURRENTLY
      // tombstoned (absent) key qualifies; a recreated key has cleared its
      // tombstone and still returns false.
      if (nextValue === undefined && dir) {
        const existing = await readTombs(dir);
        if (existing.map.has(key)) return existing.map.get(key);
      }
      return false;
    }
    if (nextValue === undefined) {
      // ATOMIC delete authority (the reviewer's finding): the tombstone (a
      // NEWLY ISSUED generation) is persisted FIRST via the BOUNDED authority;
      // the live value removal follows best-effort (the reads honor the
      // tombstone — the orphan is invisible + retried by a later delete/clear).
      // The delete RETURNS the exact deleted generation.
      const targetDir = dir ?? await openDir(path);
      const deletedGen = await issueVersion(targetDir);
      const tombs = await readTombs(targetDir);
      tombs.map.set(key, deletedGen);
      await writeTombs(targetDir, tombs);
      if (dir) {
        try {
          await dir.removeEntry(`${key}.json`);
        } catch { /* the reads honor the tombstone */ }
      }
      return deletedGen;
    }
    // A CAS-restore onto a fresh/absent store legitimately writes: open the
    // directory (creating it) ONLY for the actual mutation, never for a compare.
    const targetDir = dir ?? await openDir(path);
    const version = await issueVersion(targetDir);
    await writeEntry(targetDir, `${key}.json`, nextValue, version);
    // A CAS-restore/recreate clears the key from the tombstone MAP.
    const tombs = await readTombs(targetDir);
    if (tombs.map.has(key)) {
      tombs.map.delete(key);
      await writeTombs(targetDir, tombs);
    }
    return version; // the EXACT token of THIS write (the compensation matches it)
  });
}

/** A single origin-scoped store. `origin` is a canonical origin string or "master". */
/** The shared store body: a path + a label, with the origin/master reserved-key
 * semantics. `memoryStore` (master + site origins) and `namedAgentMemory`
 * (named agents) both build their store through here so every store gets the
 * same bounds, version tokens, and CAS semantics. */
function memoryStoreAt(path, { isMaster, origin }) {
  return {
    isMaster,
    origin,
    async get(key) {
      // The AUTHORITY files are never readable (the model-facing memory.get
      // route + the agent memory_get tool apply the same refusal); the artifact
      // internals are read via getStrict by the transaction code.
      if (/^(?:__gen|__tx|__wal|__epoch|__tombs)$/.test(String(key))) {
        throw new Error(`key "${key}" is reserved on this store`);
      }
      const dir = await openDirOptional(path);
      if (!dir) return null;
      // The TOMBSTONE authority is honored: a deleted key reads as absent even
      // if a live orphan file coexists (the reviewer's tomb+live finding).
      const tombs = await readTombs(dir);
      if (tombs.map.has(key)) return null;
      const entry = await readEntry(dir, `${key}.json`, true);
      return entry?.value ?? null;
    },
    /** STRICT read: returns the unwrapped value or null when ABSENT (or a
     * tombstone exists), but THROWS on a real read/corruption failure (never
     * silently treats an unreadable store as empty). */
    async getStrict(key) {
      const dir = await openDirOptional(path);
      if (!dir) return null;
      const tombs = await readTombs(dir);
      if (tombs.map.has(key)) return null;
      const entry = await readEntry(dir, `${key}.json`, true);
      return entry?.value ?? null;
    },
    /** Whether `key` EXISTS (a stored `null` value is still present, distinct
     * from an absent key — `get` returns `null` for both, so compensation logic
     * must not conflate them). Honors the tombstone authority (a tombstoned key
     * with a live orphan file is ABSENT). */
    async has(key) {
      const dir = await openDirOptional(path);
      if (!dir) return false;
      const tombs = await readTombs(dir);
      if (tombs.map.has(key)) return false;
      try {
        await dir.getFileHandle(`${key}.json`);
        return true;
      } catch {
        return false;
      }
    },
    /** The key's CURRENT durable version token (0 only when NEVER created — a
     * deleted key returns its tombstone generation). */
    async getVersion(key) {
      const dir = await openDirOptional(path);
      if (!dir) return 0;
      return await currentVersion(dir, key);
    },
    async set(key, value) {
      return await setValue(path, key, value, { isMaster });
    },
    /** CAS delete: remove `key` ONLY if its current VERSION equals `expectedVersion`
     * (the write being rolled back). Never deletes a concurrent legitimate write
     * — even one with an identical value, because the version differs (the round-27
     * value-CAS ABA blocker). `expectedVersion` is the version `set`/`setTrusted`
     * RETURNED for the write being rolled back. */
    async compareAndDelete(key, expectedVersion) {
      return await compareAndSet(path, key, expectedVersion, undefined, { isMaster });
    },
    /** CAS restore: write `restoreValue` ONLY if the current VERSION equals
     * `expectedVersion` (the stale run's write). Never clobbers a concurrent
     * legitimate write. */
    async compareAndRestore(key, expectedVersion, restoreValue) {
      return await compareAndSet(path, key, expectedVersion, restoreValue, { isMaster });
    },
    /** Internal trusted write (approveTool/upsertTools/journalAppend/
     * enrollOrigin): same bounds + quotas, but reserved authority keys are
     * writable ONLY here — never via the model's `memory_set`/`set`. Returns the
     * version token (see `set`). */
    async setTrusted(key, value) {
      return await setValue(path, key, value, { isMaster, trusted: true });
    },
    async keys() {
      const dir = await openDirOptional(path);
      if (!dir) return [];
      const tombs = await readTombs(dir);
      const out = [];
      for await (const [name] of dir.entries()) {
        if (name.endsWith(".json") && !INTERNAL_FILE_RE.test(name)) {
          const key = name.slice(0, -5);
          if (!tombs.map.has(key)) out.push(key);
        }
      }
      // The FULL internal namespace is hidden from logical enumeration (the
      // reviewer's finding: __tx/assetRepair/assets/asset:/__epoch were
      // listed).
      return out.filter((k) => !INTERNAL_KEY_RE.test(k)).sort();
    },
    async delete(key) {
      // The plain delete runs UNDER the global write mutex (a race with
      // set/CAS could otherwise remove a newer write) + writes a DURABLE
      // tombstone with a NEWLY ISSUED generation (a tombstone failure FAILS
      // the delete — the reviewer's finding).
      await withWriteLock(async () => {
        const dir = await openDir(path);
        const deletedGen = await issueVersion(dir);
        const tombs = await readTombs(dir);
        tombs.map.set(key, deletedGen);
        await writeTombs(dir, tombs);
        try {
          await dir.removeEntry(`${key}.json`);
        } catch { /* the reads honor the tombstone */ }
      });
    },
    async clear() {
      // Serialized under the write mutex. PRESERVES the generation authority
      // AND every per-key TOMBSTONE — a stale expected-0 token can never land
      // after never-created → create → clear → absent (the reviewer's ABA
      // finding: clear reopened expected-0).
      await withWriteLock(async () => {
        const dir = await openDir(path);
        let genRaw = null;
        try { genRaw = await readJsonStrict(dir, GEN_FILE, { allowAbsent: true }); } catch { genRaw = null; }
        const removed = [];
        for await (const [name] of dir.entries()) {
          if (name === GEN_FILE || name === TOMBS_FILE || name === "__epoch.json" || name.endsWith(".tomb")) continue;
          try {
            removed.push(name);
            await dir.removeEntry(name, { recursive: true });
          } catch { /* absent */ }
        }
        // Every removed VALUE key gets a TOMBSTONE (a newly issued generation)
        // via the BOUNDED authority — a key that was set + cleared is NEVER
        // version-0 absent (the reviewer's finding). A failure to persist the
        // tombstone authority FAILS the clear (fail-closed).
        const tombs = await readTombs(dir);
        for (const name of removed) {
          const key = name.endsWith(".json") ? name.slice(0, -5) : name;
          if (INTERNAL_KEY_RE.test(key)) continue;
          const deletedGen = await issueVersion(dir);
          tombs.map.set(key, deletedGen);
        }
        await writeTombs(dir, tombs);
        if (genRaw && typeof genRaw.gen === "number") {
          await writeJson(dir, "__epoch.json", { gen: genRaw.gen });
        }
      });
    },
  };
}

export function memoryStore(origin) {
  const isMaster = origin === MASTER;
  // Guard: a site origin can never collide with the reserved master sentinel.
  const path = isMaster
    ? [ROOT, MASTER]
    : [ROOT, "origins", encodeOrigin(origin)];
  return memoryStoreAt(path, { isMaster, origin });
}

/** The OPFS sandbox for a NAMED agent (a persistent teammate — not an origin).
 * Lives at `memory/agents/<slug>/*`, distinct from the site-origin stores and
 * the master store, so a named agent has its own memory, history, and skills
 * (the chaos-extension-style per-agent sandbox). `id` is the agent's slug; the
 * `origin` label is `agent:<slug>` so journal/usage tagging never collides with
 * a real origin. */
export function namedAgentMemory(id) {
  const slug = String(id || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
  const path = [ROOT, "agents", encodeURIComponent(slug)];
  return memoryStoreAt(path, { isMaster: false, origin: `agent:${slug}` });
}

/** The OPFS sandbox for a BACKGROUND/SCHEDULED agent (a recipe like the
 * Sorting Hat, or a one-off scheduled task). Lives at `memory/background/<slug>/*`,
 * distinct from the named-agent store (`memory/agents/`) and the master store,
 * so a background agent has its own memory + run history + journal — one
 * background agent can never read/write another's or the master's. `id` is the
 * schedule name (e.g. `recipe:auto-group-by-domain`) or a recipe id; the `origin`
 * label is `background:<slug>` so journal/usage tagging never collides with a
 * real origin or a named agent. */
export function backgroundAgentMemory(id) {
  const slug = String(id || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed-background";
  const path = [ROOT, "background", encodeURIComponent(slug)];
  return memoryStoreAt(path, { isMaster: false, origin: `background:${slug}` });
}

/** Enumerate the named-agent ids that have an OPFS sandbox directory. (Read-only
 * introspection; the AUTHORITATIVE registry is in chrome.storage, see
 * lib/named-agents.js.) */
export async function listNamedAgentIds() {
  return listStoreIds("agents");
}

/** Enumerate the background/scheduled-agent ids that have an OPFS sandbox
 * directory (`memory/background/<slug>`). Read-only introspection for the
 * activity-log explorer — the AUTHORITATIVE schedule registry is in
 * chrome.storage (lib/scheduler.js listScheduledTasks). */
export async function listBackgroundAgentIds() {
  return listStoreIds("background");
}

/** Enumerate the id slugs directly under `memory/<dir>/`. Used by both the
 * named-agent (`agents`) and background-agent (`background`) sandboxes. */
async function listStoreIds(dir) {
  const root = await rootDir();
  let memDir;
  try {
    memDir = await root.getDirectoryHandle(ROOT);
  } catch {
    return [];
  }
  let agentsDir;
  try {
    agentsDir = await memDir.getDirectoryHandle(dir);
  } catch {
    return [];
  }
  const out = [];
  for await (const [name, handle] of agentsDir.entries()) {
    if (handle.kind === "directory") out.push(decodeURIComponent(name));
  }
  return out.sort();
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
// `guard` (optional) is an async function awaited IMMEDIATELY before the durable
// `setTrusted` commit — a scheduled run passes its fence so an ownership loss
// during the preceding `store.get("journal")` await cannot stale-commit a row
// (the round-21 finding: journals detected ownership loss only after the commit).
//
// A per-journal mutex serializes the WHOLE read-modify-write (read → push → trim
// → commit → compensation). The old code did an unlocked `get`→`setTrusted`, so
// two concurrent appends each read the same journal and the last write won, and
// a compensation read could see a concurrent append and overwrite it (the
// round-23 concurrency finding).
let journalMutex = Promise.resolve();
function withJournalLock(fn) {
  const run = journalMutex.then(fn, fn);
  journalMutex = run.then(() => {}, () => {});
  return run;
}

export async function journalAppend(store, entry, guard = null) {
  return withJournalLock(async () => {
  const MAX_ENTRY_TEXT = 16 * 1024;
  const MAX_JOURNAL_BYTES = 200 * 1024;
  // Capture the EXACT pre-append state so compensation can RESTORE it (the
  // round-23 blocker: compensation did `entries.slice(0, -1)`, which removed the
  // new row but did NOT restore the oldest row evicted by the 500-entry cap or
  // the byte-budget trim — a 500-row journal came back 499 rows with `old-0`
  // permanently lost).
  const original = (await store.get("journal")) ?? [];
  const journal = original.slice();
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
  // Re-check the caller's fence IMMEDIATELY before the commit (no other await
  // between this check and setTrusted).
  if (guard) await guard();
  // `setTrusted` returns the durable VERSION TOKEN for THIS write (the round-27
  // value-CAS ABA blocker). Capture it so compensation below targets this exact
  // write, never a same-value write made under a different enrollment.
  const wroteVersion = await store.setTrusted("journal", entries);
  // POST-commit guard: ownership lost DURING the setTrusted commit must be
  // COMPENSATED by restoring the EXACT pre-append state (`original`), not merely
  // removing the just-appended entry — otherwise a ring-buffer eviction is not
  // undone and valid older rows are lost (the round-23 finding). Compensation is
  // best-effort — the primary invariant is that the caller aborts, but the
  // forbidden row (and any eviction it caused) must not survive.
  if (guard) {
    try {
      await guard();
    } catch (e) {
      // GENERATION-SCOPED + VERSION-SCOPED CAS compensation (the round-26/27
      // blockers): the old code blindly restored `original` (the PRE-append
      // journal) on ANY post-commit guard failure, and compared the write by
      // JSON VALUE equality. When the guard failure is a RE-ENROLLMENT
      // (delete→re-enroll during the awaited setTrusted), restoring `original`
      // wrote the OLD enrollment's journal (with its secrets) into the NEW
      // enrollment's reused store. Two distinct cases, both version-scoped:
      //   1. genMismatch (re-enrollment): the stale append landed in a REUSED
      //      store — REMOVE it via CAS (delete only if the journal's VERSION is
      //      still the version THIS run wrote). Never restore `original`, never
      //      clobber a concurrent new-enrollment write.
      //   2. abort/ownership loss (same enrollment): restore the EXACT pre-append
      //      state, CAS-scoped (only if the version is still `wroteVersion`).
      try {
        if (e?.genMismatch === true) {
          await store.compareAndDelete("journal", wroteVersion);
        } else {
          await store.compareAndRestore("journal", wroteVersion, original);
        }
      } catch { /* best-effort compensation */ }
      throw e;
    }
  }
  return entries;
  });
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
