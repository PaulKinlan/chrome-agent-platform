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

/** Bootstrap the global generation when upgrading from the former per-key
 * envelope/sidecar scheme. This runs only while `__gen.json` is absent and
 * takes the maximum durable token found in live envelopes, legacy `.version`
 * sidecars, the clear epoch, and tombstone authority. */
async function legacyGenerationFloor(dir) {
  let max = 0;
  for await (const [name] of dir.entries()) {
    if (name === GEN_FILE) continue;
    try {
      if (name === "__epoch.json") {
        const epoch = await readJsonStrict(dir, name, { allowAbsent: true });
        if (Number.isSafeInteger(epoch?.gen) && epoch.gen >= 0) max = Math.max(max, epoch.gen);
      } else if (name === TOMBS_FILE) {
        const raw = await readJsonStrict(dir, name, { allowAbsent: true });
        if (Number.isSafeInteger(raw?.floor) && raw.floor >= 0) max = Math.max(max, raw.floor);
        for (const value of Object.values(raw?.map ?? {})) {
          if (Number.isSafeInteger(value) && value >= 0) max = Math.max(max, value);
        }
      } else if (name.endsWith(".json")) {
        const entry = await readEntry(dir, name, true);
        if (Number.isSafeInteger(entry?.v) && entry.v >= 0) max = Math.max(max, entry.v);
      } else if (name.startsWith(".") && name.endsWith(".version")) {
        const marker = await readJsonStrict(dir, name, { allowAbsent: true });
        if (Number.isSafeInteger(marker) && marker >= 0) max = Math.max(max, marker);
      }
    } catch {
      // Any corrupt legacy authority fails the migration closed; resetting the
      // sequence could let stale compensation target a newer value.
      throw new Error("the legacy generation authority is corrupt");
    }
  }
  return max;
}

/** Issue the next durable generation for a store directory. The caller holds
 * the global write mutex (atomic). Returns the generation. */
async function issueVersion(dir) {
  let genRaw;
  try {
    genRaw = await readJsonStrict(dir, GEN_FILE, { allowAbsent: true });
  } catch {
    // The authority file is corrupt — fail closed, never reset the sequence.
    throw new Error("the durable generation authority is corrupt");
  }
  const prev = genRaw == null ? await legacyGenerationFloor(dir) : genRaw.gen;
  if (!Number.isSafeInteger(prev) || prev < 0) {
    throw new Error("the durable generation authority is corrupt");
  }
  if (prev >= Number.MAX_SAFE_INTEGER) {
    throw new Error("the durable generation authority is exhausted");
  }
  const gen = prev + 1;
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
const MASTER_RESERVED_KEYS = new Set([
  "origins",
  "enrolled",
  "assets",
  "threads",
  "scripts",
  "run-registry",
  // Failed-runs dismiss tombstones (owner 2026-08-28): a single bounded
  // registry-level record, same reservation class as the run registry index —
  // authority state the model's memory_set must never write.
  "run-dismissed-failed",
  "wasmPkg",
  "wasmPkgRepair",
  // The inter-agent board logs (jobs + messages, agent-board.js): event-
  // sourced AUTHORITY — a forged replacement would let the model rewrite who
  // posted/claimed/settled what (review P1-1). The board's store writes
  // through setTrusted and reads through getStrict, like the thread code.
  "cap:board-jobs",
  "cap:board-messages",
]);
// The INTERNAL namespace + the artifact/repair/package/profile prefixes are reserved on EVERY
// store — the model's memory_set can never write the generation authority,
// the WAL, a tombstone, or an artifact body/repair record.
const INTERNAL_PREFIX_RE = /^(?:__gen|__tx|__wal|__epoch|__tombs|__wasmTx|profile:)/;
// The full hidden namespace (keys()/get/list exclusion + set reservation).
// `asset-` covers the immutable artifact version rows, the content-addressed
// blobs, their refcounts and the byte accounting
// (CAP-FB-20260830-ARTIFACT-VERSIONS-01) — authority state like the bodies.
const INTERNAL_KEY_RE = /^(?:__gen|__tx|__wal|__epoch|__tombs|__wasmTx|assets|assetRepair|asset[:-]|wasmPkg|wasmPkgRepair|profile:|profile$|cap:board-)/;
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
// The per-execution write-ahead log, beside that execution's KV records.
const RUN_LOG_FILE = "run.log";
const DURABLE_INDEX_KEY = "run-registry";
const DURABLE_PREFIXES = ["run:", "run-outbox:", "run-log:", "run-log-idx:", "run-resume:", "run-payload:"];
const EXECUTION_ID_SOURCE = "(?:exec:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|exec_[A-Za-z0-9][A-Za-z0-9_-]{7,194})";
const DURABLE_KEY_RE = new RegExp(`^(?:run|run-outbox|run-log|run-log-idx|run-resume|run-payload):(${EXECUTION_ID_SOURCE})(?::|$)`, "i");
// The thread → executions reverse index (the log redesign). It is keyed by
// THREAD id, not execution id, so it needs its own bounded store per thread —
// the per-execution router below cannot place it, and before this existed every
// `agent.run` threw `invalid durable-run key: thread-runs:<threadId>` because a
// run links its thread on the way in.
const THREAD_RUNS_PREFIX = "thread-runs:";
// No "." in the charset ON PURPOSE. `encodeURIComponent("..")` is ".." — it does
// not escape dots — so a permissive charset would hand ".." straight to a
// directory name and depend on OPFS rejecting it. Thread ids are
// `t_<ms>_<base36>` and never contain a dot, so nothing is lost by refusing it.
const THREAD_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

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

/** The slug the background-agent memory path uses for a schedule/agent id
 * (the same slug rules as backgroundAgentMemory). Exported so the background
 * teardown and the orphan sweep address the SAME directory the store writes —
 * never a divergent re-slugification. */
export function backgroundAgentSlug(id) {
  return String(id || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed-background";
}

/** Names of the child DIRECTORIES under the given path (absent → []).
 * Read-only walk for the orphan sweep / maintenance surfaces. */
export async function listDirsUnder(segments) {
  const dir = await openDirOptional(segments);
  if (!dir) return [];
  const out = [];
  for await (const entry of dir.values()) {
    if (entry.kind === "directory") out.push(entry.name);
  }
  return out.sort();
}

/** Remove the ENTIRE store directory at `segments` (authority files included).
 * For namespaces whose owner is GONE (a deleted agent's execution/thread dirs,
 * orphan stores): no tombstone semantics apply because nothing may ever
 * address this path again — deletion IS the guarantee. Absent → ok.
 * NEVER call this on a LIVE store (clear() is the live-store API: it preserves
 * the generation authority so stale CAS tokens can't land post-recreate). */
export async function purgeStoreDir(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("purgeStoreDir: refusing to remove the storage root");
  }
  let dir = await rootDir();
  for (const seg of segments.slice(0, -1)) {
    try {
      dir = await dir.getDirectoryHandle(seg);
    } catch {
      return { ok: true, absent: true };
    }
  }
  try {
    await dir.removeEntry(segments[segments.length - 1], { recursive: true });
    return { ok: true };
  } catch (e) {
    if (e?.name === "NotFoundError") return { ok: true, absent: true };
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Delete ONLY the journal entry (the capped journalAppend log) from the store
 * at `segments` — via the store's own tombstoning delete so the generation
 * authority stays consistent. Memory content, run history, skills, and assets
 * are untouched. Absent store or absent journal → ok with removed:false.
 * The Settings → Data & memory "Purge journals" affordance uses this. */
export async function purgeStoreJournal(segments) {
  const store = memoryStoreAt(segments, { isMaster: false, origin: "journal-purge" });
  try {
    if (!(await store.has("journal"))) return { ok: true, removed: false };
    await store.delete("journal");
    return { ok: true, removed: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Purge journal entries across agent stores. `target` forms:
 *  - `{ agent: "<slug>" }` → that named agent's journal only.
 *  - `{ background: "<slug>" }` → that background agent's journal only.
 *  - `null` → GLOBAL: every named-agent, background-agent, and site-origin
 *    store's journal (the master journal is NEVER purged — it is the owner's
 *    own hub journal, not an agent's).
 * Memory content, run history, skills, and assets are never touched. */
export async function purgeJournals(target = null) {
  const removed = [];
  const failures = [];
  const segs = {
    agent: (slug) => [ROOT, "agents", encodeURIComponent(slug)],
    background: (slug) => ["memory", "background", encodeURIComponent(slug)],
  };
  if (target && typeof target === "object") {
    if (typeof target.agent === "string") {
      const r = await purgeStoreJournal(segs.agent(target.agent));
      if (r.ok) removed.push(`agents/${target.agent}`);
      else failures.push(r.error);
      return { ok: failures.length === 0, removed, failures };
    }
    if (typeof target.background === "string") {
      const r = await purgeStoreJournal(segs.background(target.background));
      if (r.ok) removed.push(`background/${target.background}`);
      else failures.push(r.error);
      return { ok: failures.length === 0, removed, failures };
    }
  }
  for (const slug of await listNamedAgentIds()) {
    const r = await purgeStoreJournal(segs.agent(slug));
    if (r.ok) { if (r.removed) removed.push(`agents/${slug}`); }
    else failures.push(`agents/${slug}: ${r.error}`);
  }
  for (const slug of await listBackgroundAgentIds()) {
    const r = await purgeStoreJournal(segs.background(slug));
    if (r.ok) { if (r.removed) removed.push(`background/${slug}`); }
    else failures.push(`background/${slug}: ${r.error}`);
  }
  const originsDir = await openDirOptional([ROOT, "origins"]);
  if (originsDir) {
    for await (const [name] of originsDir.entries()) {
      const r = await purgeStoreJournal([ROOT, "origins", name]);
      if (r.ok) { if (r.removed) removed.push(`origins/${name}`); }
      else failures.push(`origins/${name}: ${r.error}`);
    }
  }
  return { ok: failures.length === 0, removed, failures };
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
  const trustedPrefix = isMaster && (
    k.startsWith("thread:") || k.startsWith("run:") ||
    k.startsWith("run-outbox:") || k.startsWith("run-log:") ||
    k.startsWith("run-resume:") || k.startsWith("run-payload:")
  );
  // The internal namespace + artifact/package prefixes are reserved on EVERY
  // store; trusted product code alone may write them through setTrusted.
  const internal = INTERNAL_PREFIX_RE.test(k) || k === "assetRepair" ||
    k === "wasmPkg" || k === "wasmPkgRepair" || k.startsWith("asset:") || k.startsWith("asset-");
  if (!trusted && (reserved.has(k) || trustedPrefix || internal)) {
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
  try {
    const fh = await dir.getFileHandle(`${key}.json`);
    oldBytes = (await fh.getFile()).size;
  } catch { /* absent → new key (or a deleted key with a tombstone) */ }
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
      // Idempotent delete: retrying an already-tombstoned delete returns the
      // existing token. A recreated key clears that tombstone and returns false.
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
    return version; // exact token of this write
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
      // The AUTHORITY files and reserved profile dossiers are never readable
      // via the model-facing memory.get route + agent memory_get tool; trusted
      // internal subsystems use getStrict. The board logs join them: a forged
      // board history must be neither writable (MASTER_RESERVED_KEYS) nor
      // readable here (review P1-1).
      if (/^(?:__gen|__tx|__wal|__epoch|__tombs|profile:|profile$|cap:board-)/.test(String(key))) {
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
    /** Atomic value/existence/version receipt under the same write mutex used by
     * all trusted writes and CAS compensation. */
    async snapshot(key) {
      return await withWriteLock(async () => {
        const dir = await openDirOptional(path);
        if (!dir) return { exists: false, value: null, version: 0 };
        const tombs = await readTombs(dir);
        const entry = tombs.map.has(key)
          ? null
          : await readEntry(dir, `${key}.json`, true);
        const version = await currentVersion(dir, key);
        return entry
          ? { exists: true, value: structuredClone(entry.value), version }
          : { exists: false, value: null, version };
      });
    },
    /** The key's current durable token; deleted keys retain a tombstone token. */
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
      // Plain delete is serialized and publishes the durable tombstone before
      // removing the value. A tombstone failure therefore leaves the live value.
      await withWriteLock(async () => {
        const dir = await openDir(path);
        const deletedGen = await issueVersion(dir);
        const tombs = await readTombs(dir);
        tombs.map.set(key, deletedGen);
        await writeTombs(dir, tombs);
        try {
          await dir.removeEntry(`${key}.json`);
        } catch { /* reads honor the tombstone */ }
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
        const removedKeys = [];
        for await (const [name] of dir.entries()) {
          if (name === GEN_FILE || name === TOMBS_FILE || name === "__epoch.json") continue;
          if (name.endsWith(".json")) {
            const key = name.slice(0, -5);
            if (!INTERNAL_KEY_RE.test(key)) removedKeys.push(key);
          }
          try {
            await dir.removeEntry(name, { recursive: true });
          } catch { /* absent */ }
        }
        // Every removed logical value gets a tombstone. Legacy `.version`
        // sidecars and internal transaction files are removed but never exposed
        // as user keys in the new authority.
        const tombs = await readTombs(dir);
        for (const key of removedKeys) {
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
  const slug = backgroundAgentSlug(id);
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

/** The thread id inside a `thread-runs:<threadId>` key, or null. Fails closed on
 * anything outside the bounded safe charset rather than letting an odd id reach
 * a directory name. */
function durableThreadId(key) {
  const value = String(key);
  if (!value.startsWith(THREAD_RUNS_PREFIX)) return null;
  const threadId = value.slice(THREAD_RUNS_PREFIX.length);
  return THREAD_ID_RE.test(threadId) ? threadId : null;
}

/** The OPFS directory segments for one execution's durable store
 * (`memory/durable-runs/executions/<execId>`). Shared by the run teardown and
 * the orphan sweep so purge and write address the SAME path. */
export function durableExecutionDirSegments(executionId) {
  return [ROOT, DURABLE_ROOT, "executions", encodeURIComponent(String(executionId))];
}

/** The OPFS directory segments for one thread's reverse-index store. */
export function durableThreadDirSegments(threadId) {
  return [ROOT, DURABLE_ROOT, "threads", encodeURIComponent(String(threadId))];
}

function durableStoreForKey(key) {
  if (String(key) === DURABLE_INDEX_KEY) {
    return memoryStoreAt([ROOT, DURABLE_ROOT, "registry"], { isMaster: false, origin: "durable:registry" });
  }
  // The failed-runs dismiss tombstone lives WITH the registry (a single
  // bounded record pruned against the index), not under an execution.
  if (String(key) === "run-dismissed-failed") {
    return memoryStoreAt([ROOT, DURABLE_ROOT, "registry"], { isMaster: false, origin: "durable:registry" });
  }
  if (String(key).startsWith(THREAD_RUNS_PREFIX)) {
    const threadId = durableThreadId(key);
    if (!threadId) throw new Error(`invalid durable thread-runs key: ${String(key)}`);
    return memoryStoreAt(
      [ROOT, DURABLE_ROOT, "threads", encodeURIComponent(threadId)],
      { isMaster: false, origin: `durable-thread:${threadId}` },
    );
  }
  const executionId = durableExecutionId(key);
  if (!executionId) throw new Error(`invalid durable-run key: ${String(key)}`);
  return memoryStoreAt(
    [ROOT, DURABLE_ROOT, "executions", encodeURIComponent(executionId)],
    { isMaster: false, origin: `durable:${executionId}` },
  );
}

/** The OPFS file handle for an execution's run log (the WAL —
 *  CAP-FB-20260827-THREAD-OPEN-SEQUENTIAL-READS-01).
 *
 *  Deliberately inside the execution's OWN directory, alongside its key-value
 *  records, so that everything which already removes an execution — retention,
 *  registry pruning, a store clear — takes the log with it. A log filed
 *  somewhere else would outlive its run and leak.
 *
 *  Returns null rather than throwing when `create` is false and nothing is
 *  there: "this execution has no WAL yet" is the normal pre-migration state,
 *  not an error. */
export async function durableRunLogHandle(executionId, { create = false } = {}) {
  const id = String(executionId ?? "");
  if (!id) return null;
  const segments = [ROOT, DURABLE_ROOT, "executions", encodeURIComponent(id)];
  try {
    const dir = create ? await openDir(segments) : await openDirOptional(segments);
    if (!dir) return null;
    return await dir.getFileHandle(RUN_LOG_FILE, { create });
  } catch {
    return null; // absent, or an unreadable directory — the caller falls back
  }
}

/** Remove an execution's run log. Used by the migration's verify-then-delete
 *  and by retention; never on a read path. */
export async function removeDurableRunLog(executionId) {
  const id = String(executionId ?? "");
  if (!id) return false;
  const dir = await openDirOptional([ROOT, DURABLE_ROOT, "executions", encodeURIComponent(id)]);
  if (!dir) return false;
  try {
    await dir.removeEntry(RUN_LOG_FILE);
    return true;
  } catch {
    return false; // already gone
  }
}

/** Remove a thread's durable reverse-index directory. Called when a thread is
 * deleted: without it every deleted thread leaks its `durable/threads/<id>`
 * directory forever, which the memory-resilience constraint forbids. Absent or
 * malformed ids are a no-op — never a throw on a cleanup path. */
export async function forgetDurableThread(threadId) {
  if (!THREAD_ID_RE.test(String(threadId ?? ""))) return false;
  const root = await openDirOptional([ROOT, DURABLE_ROOT, "threads"]);
  if (!root) return false;
  try {
    await root.removeEntry(encodeURIComponent(String(threadId)), { recursive: true });
    return true;
  } catch {
    return false; // already gone
  }
}

async function durableThreadStores() {
  const root = await openDirOptional([ROOT, DURABLE_ROOT, "threads"]);
  if (!root) return [];
  const stores = [];
  for await (const [leaf, handle] of root.entries()) {
    if (handle.kind !== "directory") continue;
    let threadId;
    try { threadId = decodeURIComponent(leaf); } catch { continue; }
    if (!THREAD_ID_RE.test(threadId)) continue;
    stores.push(memoryStoreAt(
      [ROOT, DURABLE_ROOT, "threads", leaf],
      { isMaster: false, origin: `durable-thread:${threadId}` },
    ));
  }
  return stores;
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
      for (const store of await durableThreadStores()) {
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
  // FAIL-CLOSED for the orphan sweep: an I/O error while iterating must not
  // be read as "no sandboxes exist" (the sweep would then judge every dir an
  // orphan). Absent root/dir is a genuine empty list; iteration errors THROW.
  try {
    for await (const [name, handle] of agentsDir.entries()) {
      if (handle.kind === "directory") out.push(decodeURIComponent(name));
    }
  } catch (e) {
    if (out.length === 0 && e?.name === "NotFoundError") return out;
    throw e;
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
