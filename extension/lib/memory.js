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
// The thread authority (`threads` index + every `thread:<id>` body) must be
// reserved from the MODEL's `memory_set` too: the wider-goal review proved a
// forged `threads` index could be written through `masterMemory().set` and
// `listThreads()` returned it. Internal thread code uses `setTrusted`.
const MASTER_RESERVED_KEYS = new Set(["origins", "enrolled", "assets", "threads", "scripts", "run-registry"]);
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
// — must be bounded. A site may hold at most this many total serialized bytes
// (and 64 MiB across all origins); beyond that, `set`/`setTrusted` fail closed
// rather than growing without bound (the round-15 aggregate-unbounded finding).
const MAX_BYTES_PER_ORIGIN = 8 * 1024 * 1024; // 8 MiB per origin
const MAX_BYTES_GLOBAL = 64 * 1024 * 1024; // 64 MiB across all origins

// Durable execution authority is not model memory. Older builds stored every
// `run:*`/log/outbox/payload file beside owner keys in `memory/master`, where an
// arbitrary file-count ceiling blocked routine work. Isolate each execution in
// its own byte-bounded store; the registry uses a separate store.
const DURABLE_ROOT = "durable-runs";
const DURABLE_INDEX_KEY = "run-registry";
const DURABLE_PREFIXES = ["run:", "run-outbox:", "run-log:", "run-resume:", "run-payload:"];
const EXECUTION_ID_SOURCE = "(?:exec:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|exec_[A-Za-z0-9][A-Za-z0-9_-]{7,194})";
const DURABLE_KEY_RE = new RegExp(`^(?:run|run-outbox|run-log|run-resume|run-payload):(${EXECUTION_ID_SOURCE})(?::|$)`, "i");

export class MemoryStoreQuotaError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "MemoryStoreQuotaError";
    this.code = kind === "key-count" ? "memory_key_count_bound" : `memory_${kind}_bound`;
    this.kind = kind;
  }
}

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
 * Legacy raw values (no envelope) are version 0. */
async function readEntry(dir, name) {
  try {
    const fh = await dir.getFileHandle(name);
    const f = await fh.getFile();
    const parsed = JSON.parse(await f.text());
    if (
      parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      typeof parsed.__v === "number" && Number.isFinite(parsed.__v) &&
      "__value" in parsed
    ) {
      return { v: parsed.__v, value: parsed.__value };
    }
    // Legacy raw value (pre-versioning): version 0.
    return { v: 0, value: parsed };
  } catch {
    return null;
  }
}

/** Write a store key's versioned entry. */
async function writeEntry(dir, name, value, version) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ __v: version, __value: value }));
  await w.close();
}

// A non-enumerated tombstone keeps versions monotonic across delete/recreate.
// Without it an absent key reset to version 0 and a recreated identical value
// reused version 1: the real round-27 ABA remnant.
function versionName(key) { return `.${encodeURIComponent(String(key))}.version`; }
async function readVersion(dir, key, entry = null) {
  const marker = await readJson(dir, versionName(key));
  return Math.max(entry?.v ?? 0, Number.isSafeInteger(marker) && marker >= 0 ? marker : 0);
}
async function writeVersion(dir, key, version) {
  await writeJson(dir, versionName(key), version);
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
  const k = String(key);
  // Reserve both exact keys AND the `thread:` PREFIX on the master store: a
  // forged `thread:t_...` body must be as unreachable as a forged `threads`
  // index (the wider-goal review's thread-authority finding).
  const trustedPrefix = isMaster && (
    k.startsWith("thread:") || k.startsWith("run:") || k.startsWith("run-outbox:") || k.startsWith("run-log:") || k.startsWith("run-resume:") || k.startsWith("run-payload:")
  );
  if (!trusted && (reserved.has(k) || trustedPrefix)) {
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
  let prevVersion = 0;
  try {
    const fh = await dir.getFileHandle(`${key}.json`);
    oldBytes = (await fh.getFile()).size;
    isNew = false;
    const entry = await readEntry(dir, `${key}.json`);
    prevVersion = await readVersion(dir, key, entry);
  } catch { /* absent → new key */ }
  if (isNew) prevVersion = await readVersion(dir, key);
  // Aggregate quotas: a store may not grow past MAX_BYTES_PER_ORIGIN bytes
  // (and the global tree past MAX_BYTES_GLOBAL).
  // The delta is positive for BOTH new keys AND replacements that grow — a
  // replacement that enlarges an existing value must also be budgeted (the
  // round-16 finding: the global limit was only checked for new keys).
  const delta = newBytes - oldBytes;
  if (usage.bytes + Math.max(0, delta) > MAX_BYTES_PER_ORIGIN) {
    throw new MemoryStoreQuotaError(
      "bytes",
      `store exceeds the ${MAX_BYTES_PER_ORIGIN}-byte bound`,
    );
  }
  if ((await globalUsage()) + Math.max(0, delta) > MAX_BYTES_GLOBAL) {
    throw new MemoryStoreQuotaError(
      "global",
      `global memory exceeds the ${MAX_BYTES_GLOBAL}-byte bound`,
    );
  }
  // Bump the version and write the ENVELOPE. The returned version is the write's
  // durable identity token — callers capture it and pass it to the version-scoped
  // compareAndDelete/compareAndRestore so compensation targets THIS write, never
  // a same-value write made under a different enrollment (the round-27 blocker).
  const version = prevVersion + 1;
  await writeEntry(dir, `${key}.json`, value, version);
  await writeVersion(dir, key, version);
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
    const current = dir ? await readEntry(dir, `${key}.json`) : null;
    const currentVersion = dir ? await readVersion(dir, key, current) : 0;
    if (currentVersion !== expectedVersion) return false;
    if (nextValue === undefined) {
      if (dir) {
        // Publish the next token before removing the value, so absence itself
        // has a durable identity and recreation cannot reuse expectedVersion.
        await writeVersion(dir, key, expectedVersion + 1);
        try {
          await dir.removeEntry(`${key}.json`);
        } catch { /* absent */ }
      }
      return true;
    }
    // A CAS-restore onto a fresh/absent store legitimately writes: open the
    // directory (creating it) ONLY for the actual mutation, never for a compare.
    const targetDir = dir ?? await openDir(path);
    await writeEntry(targetDir, `${key}.json`, nextValue, expectedVersion + 1);
    await writeVersion(targetDir, key, expectedVersion + 1);
    return true;
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
      const dir = await openDirOptional(path);
      if (!dir) return null;
      const entry = await readEntry(dir, `${key}.json`);
      return entry?.value ?? null;
    },
    /** Whether `key` EXISTS (a stored `null` value is still present, distinct
     * from an absent key — `get` returns `null` for both, so compensation logic
     * must not conflate them). Non-creating read (does not recreate a deleted
     * store). */
    async has(key) {
      const dir = await openDirOptional(path);
      if (!dir) return false;
      try {
        await dir.getFileHandle(`${key}.json`);
        return true;
      } catch {
        return false;
      }
    },
    /** Atomic value/existence/version receipt under the same write mutex used by
     * all trusted writes and CAS compensation. */
    async snapshot(key) {
      return await withWriteLock(async () => {
        const dir = await openDirOptional(path);
        if (!dir) return { exists: false, value: null, version: 0 };
        const entry = await readEntry(dir, `${key}.json`);
        const version = await readVersion(dir, key, entry);
        return entry
          ? { exists: true, value: structuredClone(entry.value), version }
          : { exists: false, value: null, version };
      });
    },
    /** The key's CURRENT durable version token (0 when absent). */
    async getVersion(key) {
      const dir = await openDirOptional(path);
      if (!dir) return 0;
      const entry = await readEntry(dir, `${key}.json`);
      return await readVersion(dir, key, entry);
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
      const out = [];
      for await (const [name] of dir.entries()) {
        if (name.endsWith(".json")) out.push(name.slice(0, -5));
      }
      return out.sort();
    },
    async delete(key) {
      await withWriteLock(async () => {
        const dir = await openDirOptional(path);
        if (!dir) return;
        const entry = await readEntry(dir, `${key}.json`);
        if (!entry) return;
        const version = await readVersion(dir, key, entry);
        await writeVersion(dir, key, version + 1);
        try {
          await dir.removeEntry(`${key}.json`);
        } catch { /* absent */ }
      });
    },
    async clear() {
      // Delete THIS store's own directory (the `path` passed to memoryStoreAt),
      // not a hardcoded origins path — the wider-goal review found clear() was
      // deleting `memory/origins/<origin>` even for named/background agents
      // (memory/agents/<slug>, memory/background/<slug>), leaving their sandboxes.
      if (isMaster) {
        const parent = await openDir([ROOT]);
        try {
          await parent.removeEntry(MASTER, { recursive: true });
        } catch { /* absent */ }
        return;
      }
      // The store lives at `path` = [ROOT, <bucket>, <leaf>] — remove the leaf
      // from its parent bucket so the whole per-store subtree is gone.
      const leaf = path[path.length - 1];
      const parentPath = path.slice(0, -1);
      const parent = await openDir(parentPath);
      try {
        await parent.removeEntry(leaf, { recursive: true });
      } catch { /* absent */ }
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

function durableExecutionId(key) {
  if (String(key) === DURABLE_INDEX_KEY) return null;
  return DURABLE_KEY_RE.exec(String(key))?.[1] ?? null;
}

function isLegacyDurableKey(key) {
  const value = String(key);
  return value === DURABLE_INDEX_KEY || DURABLE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function durableStoreForKey(key) {
  if (String(key) === DURABLE_INDEX_KEY) {
    return memoryStoreAt([ROOT, DURABLE_ROOT, "registry"], { isMaster: false, origin: "durable:registry" });
  }
  const executionId = durableExecutionId(key);
  if (!executionId) throw new Error(`invalid durable-run key: ${String(key)}`);
  return memoryStoreAt(
    [ROOT, DURABLE_ROOT, "executions", encodeURIComponent(executionId)],
    { isMaster: false, origin: `durable:${executionId}` },
  );
}

async function durableExecutionStores() {
  const root = await openDirOptional([ROOT, DURABLE_ROOT, "executions"]);
  if (!root) return [];
  const stores = [];
  for await (const [leaf, handle] of root.entries()) {
    if (handle.kind !== "directory") continue;
    let executionId;
    try { executionId = decodeURIComponent(leaf); } catch { continue; }
    if (!new RegExp(`^${EXECUTION_ID_SOURCE}$`, "i").test(executionId)) continue;
    stores.push(memoryStoreAt(
      [ROOT, DURABLE_ROOT, "executions", leaf],
      { isMaster: false, origin: `durable:${executionId}` },
    ));
  }
  return stores;
}

async function migrateLegacyDurableKey(key) {
  const legacy = masterMemory();
  const target = durableStoreForKey(key);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const source = await legacy.snapshot(key);
    if (!source.exists) return { key, migrated: false, absent: true };
    const existing = await target.snapshot(key);
    if (!existing.exists || JSON.stringify(existing.value) !== JSON.stringify(source.value)) {
      await target.setTrusted(key, source.value);
    }
    const verified = await target.snapshot(key);
    if (!verified.exists || JSON.stringify(verified.value) !== JSON.stringify(source.value)) {
      throw new Error(`durable migration verification failed for ${key}`);
    }
    if (await legacy.compareAndDelete(key, source.version)) {
      return { key, migrated: true };
    }
    // A concurrent legacy update won the CAS. Re-copy its newer value; never
    // delete authority that was not exactly the value we verified.
  }
  throw new Error(`durable migration did not converge for ${key}`);
}

/** Copy-verify-delete migration for pre-isolation durable authority. Owner/model
 * keys are never selected or removed. It is idempotent across worker death: a
 * copied-but-not-deleted key is verified again, while a deleted source simply
 * becomes a no-op. */
export async function migrateLegacyDurableRunMemory() {
  const legacy = masterMemory();
  const keys = (await legacy.keys()).filter(isLegacyDurableKey);
  let migrated = 0;
  // Move execution bodies before the registry pointer. Reads remain dual-store
  // throughout, so interruption at any key boundary is safe.
  keys.sort((a, b) => Number(a === DURABLE_INDEX_KEY) - Number(b === DURABLE_INDEX_KEY));
  for (const key of keys) {
    const result = await migrateLegacyDurableKey(key);
    if (result.migrated) migrated += 1;
  }
  return { migrated, retained: keys.length };
}

/** Durable-run key/value adapter. New authority is routed to one bounded store
 * per execution; legacy master values remain readable until the idempotent boot
 * migration copy-verifies and removes them. */
export function durableRunMemory() {
  const legacy = masterMemory();
  async function selected(key) {
    const target = durableStoreForKey(key);
    if (await target.has(key)) return target;
    if (await legacy.has(key)) return legacy;
    return target;
  }
  return {
    isMaster: false,
    origin: "durable-runs",
    async get(key) { return await (await selected(key)).get(key); },
    async has(key) { return await (await selected(key)).has(key); },
    async snapshot(key) { return await (await selected(key)).snapshot(key); },
    async getVersion(key) { return await (await selected(key)).getVersion(key); },
    async set(key, value) { return await durableStoreForKey(key).set(key, value); },
    async setTrusted(key, value) {
      const store = await selected(key);
      return await store.setTrusted(key, value);
    },
    async compareAndDelete(key, expectedVersion) {
      return await (await selected(key)).compareAndDelete(key, expectedVersion);
    },
    async compareAndRestore(key, expectedVersion, value) {
      return await (await selected(key)).compareAndRestore(key, expectedVersion, value);
    },
    async delete(key) {
      const target = durableStoreForKey(key);
      await target.delete(key);
      // Cleanup can safely remove an interrupted migration's legacy duplicate.
      if (await legacy.has(key)) await legacy.delete(key);
    },
    async keys() {
      const keys = new Set();
      const registry = durableStoreForKey(DURABLE_INDEX_KEY);
      for (const key of await registry.keys()) keys.add(key);
      for (const store of await durableExecutionStores()) {
        for (const key of await store.keys()) keys.add(key);
      }
      for (const key of await legacy.keys()) if (isLegacyDurableKey(key)) keys.add(key);
      return [...keys].sort();
    },
    async clear() {
      const parent = await openDir([ROOT]);
      try { await parent.removeEntry(DURABLE_ROOT, { recursive: true }); } catch { /* absent */ }
    },
  };
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

const MAX_JOURNAL_ENTRY_TEXT = 16 * 1024;
const MAX_JOURNAL_BYTES = 200 * 1024;

function boundJournal(entries) {
  let bounded = entries.slice(-500);
  while (bounded.length > 1 && utf8Bytes(JSON.stringify(bounded)) > MAX_JOURNAL_BYTES) {
    bounded = bounded.slice(1);
  }
  return bounded;
}

async function exactStoreSnapshot(store, key) {
  if (typeof store.snapshot === "function") return await store.snapshot(key);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const beforeVersion = await store.getVersion(key);
    const exists = await store.has(key);
    const value = exists ? await store.get(key) : null;
    const afterVersion = await store.getVersion(key);
    const afterExists = await store.has(key);
    if (beforeVersion === afterVersion && exists === afterExists) {
      return { exists, version: afterVersion, value: exists ? value : null };
    }
  }
  throw new Error(`could not capture stable ${key} snapshot`);
}

async function journalAppendInternal(store, entry, guard, idempotencyExecutionId, receiptCapable) {
  return withJournalLock(async () => {
  const MAX_ENTRY_TEXT = MAX_JOURNAL_ENTRY_TEXT;
  // Capture the exact value, existence and version as one stable receipt.
  const pre = await exactStoreSnapshot(store, "journal");
  const original = pre.exists ? pre.value : [];
  if (!Array.isArray(original)) throw new Error("journal is not an array");
  // Terminal recovery is keyed by immutable executionId. A repeated outbox
  // reconciliation observes the already-committed row and becomes a no-op
  // under the same journal mutex, so no crash boundary can duplicate a result.
  if (
    idempotencyExecutionId &&
    original.some((row) => row?.type === (entry?.type ?? "result") && row?.executionId === idempotencyExecutionId)
  ) {
    return receiptCapable
      ? { schemaVersion: 1, key: "journal", executionId: String(entry?.executionId ?? idempotencyExecutionId), preState: structuredClone(pre), postState: structuredClone(original), writeVersion: pre.version, appended: false }
      : original;
  }
  const journal = original.slice();
  const bounded = { ...entry };
  for (const k of ["result", "task"]) {
    if (typeof bounded[k] === "string" && bounded[k].length > MAX_ENTRY_TEXT) {
      bounded[k] = bounded[k].slice(0, MAX_ENTRY_TEXT);
    }
  }
  journal.push({ ts: Date.now(), ...bounded });
  // The byte budget uses UTF-8 bytes, not UTF-16 `.length`.
  const entries = boundJournal(journal);
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
  if (!receiptCapable) return entries;
  const actualExecutionId = String(entries.at(-1)?.executionId ?? "");
  if (!actualExecutionId || actualExecutionId !== String(entry?.executionId ?? "")) {
    throw new Error("receipt-capable journal append requires the actual executionId");
  }
  return {
    schemaVersion: 1,
    key: "journal",
    executionId: actualExecutionId,
    preState: structuredClone(pre),
    postState: structuredClone(entries),
    writeVersion: wroteVersion,
    appended: true,
  };
  });
}

export async function journalAppend(store, entry, guard = null, idempotencyExecutionId = null) {
  return journalAppendInternal(store, entry, guard, idempotencyExecutionId, false);
}

/** Internal append used by exact quota compensation. */
export async function journalAppendWithReceipt(store, entry, guard = null) {
  if (!entry?.executionId) throw new Error("journalAppendWithReceipt requires executionId");
  return journalAppendInternal(store, entry, guard, null, true);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Version/fence-scoped removal of one execution's journal rows. */
export async function journalCompensateExecution(store, receipt, guard = null) {
  return withJournalLock(async () => {
    if (!receipt || receipt.schemaVersion !== 1 || receipt.key !== "journal" || !receipt.executionId) {
      throw new Error("invalid journal compensation receipt");
    }
    const fence = async () => {
      if (!guard) return null;
      try { await guard(); return null; } catch (error) {
        return { ok: false, compensated: false, preserved: true, reason: error?.genMismatch ? "generation_mismatch" : "journal_fence_failed" };
      }
    };
    const refused = await fence();
    if (refused) return refused;
    const current = await exactStoreSnapshot(store, "journal");
    if (receipt.compensatedState && current.exists === receipt.compensatedState.exists && sameJson(current.value, receipt.compensatedState.value)) {
      return { ok: true, compensated: true, idempotent: true };
    }
    const pre = receipt.preState;
    if (current.exists === pre.exists && sameJson(current.value, pre.value)) {
      if (receipt.appended === false) {
        receipt.compensatedState = structuredClone(current);
        return { ok: true, compensated: true, idempotent: true };
      }
      return { ok: false, compensated: false, preserved: true, reason: "journal_version_mismatch" };
    }
    if (!current.exists || !Array.isArray(current.value) || !Array.isArray(receipt.postState)) {
      return { ok: false, compensated: false, preserved: true, reason: "journal_state_unprovable" };
    }

    let next;
    if (current.version === receipt.writeVersion && sameJson(current.value, receipt.postState)) {
      next = pre.exists ? structuredClone(pre.value) : undefined;
    } else {
      if (sameJson(current.value, receipt.postState)) {
        return { ok: false, compensated: false, preserved: true, reason: "journal_version_mismatch" };
      }
      // Prove append-only concurrency from a surviving suffix of our post-state.
      // If the whole anchor was evicted, exact restoration is ambiguous.
      let matched = -1;
      for (let removed = 0; removed < receipt.postState.length; removed += 1) {
        const suffix = receipt.postState.slice(removed);
        if (suffix.length <= current.value.length && sameJson(current.value.slice(0, suffix.length), suffix)) {
          matched = removed;
          break;
        }
      }
      if (matched < 0) {
        return { ok: false, compensated: false, preserved: true, reason: "journal_concurrency_unprovable" };
      }
      const later = current.value.slice(receipt.postState.length - matched);
      if (!sameJson(boundJournal([...receipt.postState, ...later]), current.value)) {
        return { ok: false, compensated: false, preserved: true, reason: "journal_version_mismatch" };
      }
      const foreignLater = later.filter((row) => row?.executionId !== receipt.executionId);
      next = boundJournal([...(pre.exists ? pre.value : []), ...foreignLater]);
    }

    const preCommitRefusal = await fence();
    if (preCommitRefusal) return preCommitRefusal;
    const swapped = next === undefined
      ? await store.compareAndDelete("journal", current.version)
      : await store.compareAndRestore("journal", current.version, next);
    if (!swapped) return { ok: false, compensated: false, preserved: true, reason: "journal_cas_mismatch" };

    const postCommitRefusal = await fence();
    if (postCommitRefusal) {
      // Undo only this compensation; a concurrent append makes the CAS refuse.
      await store.compareAndRestore("journal", current.version + 1, current.value).catch(() => false);
      return postCommitRefusal;
    }
    const after = await exactStoreSnapshot(store, "journal");
    receipt.compensatedState = structuredClone(after);
    return { ok: true, compensated: true, idempotent: false, concurrentRowsPreserved: current.version !== receipt.writeVersion };
  });
}

/** Append one journal row for an immutable execution, or return the existing
 * journal unchanged. The check and write share journalAppend's mutex. */
export async function journalAppendOnce(store, entry, guard = null, executionId = entry?.executionId) {
  if (!executionId) throw new Error("journalAppendOnce requires executionId");
  return journalAppend(store, { ...entry, executionId }, guard, executionId);
}

/** Commit explicit owner cancellation as the sole terminal journal row for an
 * execution. Cancellation authority may be persisted after an ordinary result
 * row but before its terminal CAS; replacing that row is therefore required to
 * make the durable tombstone win without producing two terminal outcomes. */
export async function journalCommitCancellation(store, entry, executionId = entry?.executionId) {
  if (!executionId) throw new Error("journalCommitCancellation requires executionId");
  return withJournalLock(async () => {
    const original = (await store.get("journal")) ?? [];
    const kept = original.filter((row) => !(
      row?.executionId === executionId && ["result", "cancelled"].includes(row?.type)
    ));
    kept.push({ ts: Date.now(), ...entry, type: "cancelled", executionId, cancelled: true });
    await store.setTrusted("journal", kept);
    return kept;
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
