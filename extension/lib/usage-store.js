// lib/usage-store.js — IndexedDB sole-authority usage ledger (minimal shippable
// increment). IndexedDB is the ONE authority (permissionless, durable, atomic
// single-transaction read-modify-write). chrome.storage.local is an OUTPUT-ONLY
// mirror drained through a UNIVERSAL outbox (Web Lock + conditional generation
// ACK). Migration is per-source and once-only. Corruption is quarantined in one
// transaction with a current-bytes CAS + exact readback.

import { kvGet, kvRemove, storageAvailable } from "./kv.js";

export const STORAGE_KEY = "cap:usage:v2";
// IMMUTABLE LEGACY MIGRATION SOURCE (cairn-rename): builds predating the
// project rename wrote usage rows under this exact key. The string is STORAGE
// IDENTITY, not branding — renaming it would orphan the already-stored rows
// the one-time migration below (kvGet(LEGACY_STORAGE_KEY) → migrate →
// kvRemove) exists to drain. It must remain readable FOREVER; do not rename.
export const LEGACY_STORAGE_KEY = "cairn:usage";
const SCHEMA_VERSION = 2;
const MAX_RECORDS = 5000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_AUTH_BYTES = 4 * 1024 * 1024; // preparse bound
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STRING = 128;
const MAX_ID = 64;
const MAX_COST = 1e9;
const MAX_GEN = Number.MAX_SAFE_INTEGER;
const MAX_QUARANTINE = 32;
const MAX_QUARANTINE_BYTES = 1 * 1024 * 1024;

const DB_NAME = "cap-usage";
const STORE_AUTHORITY = "authority";
const STORE_META = "meta";
const STORE_QUARANTINE = "quarantine";
const AUTHORITY_KEY = "ledger";
const META_LEGACY = "migratedLegacy";
const META_LOCAL = "migratedLocal";
const META_DISCARD = "localDiscarded";
const META_PENDING = "mirrorPending";

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_AUTHORITY)) db.createObjectStore(STORE_AUTHORITY, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: "id" });
        if (!db.objectStoreNames.contains(STORE_QUARANTINE)) db.createObjectStore(STORE_QUARANTINE, { autoIncrement: true });
      };
      req.onsuccess = () => {
        const db = req.result;
        // The worker keeps this connection for its lifetime, which blocked the
        // factory reset's deleteDatabase forever (CAP-FB-20260830-PRIVACY-
        // STATEMENT-01 found `cap-usage` surviving every reset). On a
        // versionchange (a delete in flight) close and forget the cached
        // promise so the next write reopens a fresh database.
        db.onversionchange = () => { try { db.close(); } catch { /* closed */ } dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("usage IDB blocked"));
    });
  }
  return dbPromise;
}
function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- serialization + strict schema ----
let mutex = Promise.resolve();
function withLock(fn) { const run = mutex.then(fn, fn); mutex = run.then(() => {}, () => {}); return run; }

function isSafeInt(v) { return typeof v === "number" && Number.isFinite(v) && v >= 0 && Number.isSafeInteger(v); }
function isFiniteNonNeg(v) { return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_COST; }
function str(v, f, m) { return typeof v === "string" ? v.slice(0, m) : f; }
function canonicalId(v) { return typeof v === "string" && v.length >= 1 && v.length <= MAX_ID && /^[A-Za-z0-9._:-]+$/.test(v) ? v : null; }
function isValidTimestamp(s) {
  if (typeof s !== "string" || s.length > 40) return false;
  const t = new Date(s).getTime();
  if (!Number.isFinite(t) || t <= 0 || t > Date.now()) return false;
  return new Date(s).toISOString() === s;
}
const ROW_KEYS = ["id", "timestamp", "agentId", "taskId", "provider", "model", "inputTokens", "outputTokens", "totalTokens", "estimatedCost"];
function sanitizeRow(r, now) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  for (const k of Object.keys(r)) if (!ROW_KEYS.includes(k)) return null;
  const id = canonicalId(r.id);
  if (!id) return null;
  if (!isValidTimestamp(r.timestamp)) return null;
  if (now - new Date(r.timestamp).getTime() > RETENTION_MS) return null;
  if (!isSafeInt(r.inputTokens) || !isSafeInt(r.outputTokens)) return null;
  const totalTokens = r.inputTokens + r.outputTokens;
  if (!Number.isSafeInteger(totalTokens)) return null;
  return { id, timestamp: r.timestamp, agentId: str(r.agentId, "hub", MAX_STRING), taskId: str(r.taskId, "adhoc", MAX_STRING), provider: str(r.provider, "unknown", MAX_STRING), model: str(r.model, "unknown", MAX_STRING), inputTokens: r.inputTokens, outputTokens: r.outputTokens, totalTokens, estimatedCost: isFiniteNonNeg(r.estimatedCost) ? r.estimatedCost : 0 };
}
function canonicalJson(env) { return JSON.stringify({ v: env.v, gen: env.gen, rows: env.rows, tombstones: env.tombstones }); }
function encodeEnvelope(env) { return new TextEncoder().encode(canonicalJson(env)); }
function emptyEnvelope(gen = 0) { return { v: SCHEMA_VERSION, gen, rows: [], tombstones: [] }; }
function envelopeBytes(rows, tombstones) { return new TextEncoder().encode(canonicalJson({ v: SCHEMA_VERSION, gen: 0, rows, tombstones })).byteLength; }
function sanitizeRows(rows, { now = Date.now(), tombstones = [] } = {}) {
  const valid = [];
  for (const r of Array.isArray(rows) ? rows : []) { const c = sanitizeRow(r, now); if (c) valid.push(c); }
  let kept = valid.length > MAX_RECORDS ? valid.slice(-MAX_RECORDS) : valid;
  const ts = []; const seen = new Set();
  for (const v of Array.isArray(tombstones) ? tombstones : []) { const c = canonicalId(v); if (c && !seen.has(c)) { seen.add(c); ts.push(c); } if (ts.length >= MAX_RECORDS) break; }
  while (envelopeBytes(kept, ts) > MAX_BYTES) { if (kept.length) kept = kept.slice(1); else if (ts.length) ts.shift(); else break; }
  return { rows: kept, tombstones: ts };
}
const ENVELOPE_KEYS = new Set(["v", "gen", "rows", "tombstones"]);
function parseEnvelope(bytes) {
  // PREPARSE byte bound (before decode/parse/traversal).
  if (bytes.byteLength > MAX_AUTH_BYTES) return null;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  for (const k of Object.keys(parsed)) if (!ENVELOPE_KEYS.has(k)) return null;
  if (parsed.v !== SCHEMA_VERSION) return null;
  if (!Number.isSafeInteger(parsed.gen) || parsed.gen < 0 || parsed.gen > MAX_GEN) return null;
  if (!Array.isArray(parsed.rows) || !Array.isArray(parsed.tombstones)) return null;
  if (parsed.rows.length > MAX_RECORDS || parsed.tombstones.length > MAX_RECORDS) return null;
  if (canonicalJson(parsed) !== text) return null;
  return parsed;
}

function bumpGen(gen) { if (gen >= MAX_GEN) throw new Error("usage generation overflow"); return gen + 1; }

// ---- IDB primitives ----
async function readAuthorityBytes() {
  const db = await openDb();
  const tx = db.transaction(STORE_AUTHORITY, "readonly");
  const r = await idbReq(tx.objectStore(STORE_AUTHORITY).get(AUTHORITY_KEY));
  return r?.bytes ?? null;
}
async function readMeta(key) {
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readonly");
  const r = await idbReq(tx.objectStore(STORE_META).get(key));
  return r?.done === true ? r : null;
}
async function readPendingGen() {
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readonly");
  const r = await idbReq(tx.objectStore(STORE_META).get(META_PENDING));
  return r?.gen ?? null;
}

/**
 * ONE atomic read-modify-write over authority + meta (+ quarantine for corrupt
 * disposition). The mutator is SYNCHRONOUS and returns the next envelope or null
 * (no change). On corruption the bytes are quarantined + the tx aborts (fail
 * closed — never silently overwrite).
 */
async function transactAuthority(mutator) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_AUTHORITY, STORE_META, STORE_QUARANTINE], "readwrite");
    const store = tx.objectStore(STORE_AUTHORITY);
    const metaStore = tx.objectStore(STORE_META);
    const qStore = tx.objectStore(STORE_QUARANTINE);
    const getReq = store.get(AUTHORITY_KEY);
    getReq.onsuccess = () => {
      let current = emptyEnvelope(0);
      if (getReq.result?.bytes) {
        current = parseEnvelope(new Uint8Array(getReq.result.bytes));
        if (!current) { qStore.add({ ts: Date.now(), bytes: getReq.result.bytes }); tx.abort(); reject(new Error("corrupt authority")); return; }
      }
      try {
        const next = mutator(current, { metaStore, store });
        if (next !== null && next !== undefined) store.put({ id: AUTHORITY_KEY, bytes: encodeEnvelope(next) });
      } catch (e) { tx.abort(); reject(e); return; }
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("usage IDB tx aborted"));
  });
}

/** Corrupt disposition: quarantine + replace in ONE tx, with a current-bytes CAS
 * (only replace if the authority still holds the bytes we read) + exact readback. */
async function transactQuarantineAndReplace(bytes, replacement) {
  const db = await openDb();
  const readBytes = new Uint8Array(bytes);
  // Reject an over-cap corrupt blob outright (fail closed, source preserved).
  if (readBytes.byteLength > MAX_QUARANTINE_BYTES) {
    throw new Error("corrupt authority exceeds the quarantine byte cap — fail closed");
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_AUTHORITY, STORE_META, STORE_QUARANTINE], "readwrite");
    const store = tx.objectStore(STORE_AUTHORITY);
    const qStore = tx.objectStore(STORE_QUARANTINE);
    const metaStore = tx.objectStore(STORE_META);
    const getReq = store.get(AUTHORITY_KEY);
    getReq.onsuccess = () => {
      // CAS: only proceed if the current bytes still match what we read.
      const cur = getReq.result?.bytes;
      const curBytes = cur ? new Uint8Array(cur) : null;
      const same = curBytes && curBytes.length === readBytes.length && curBytes.every((b, i) => b === readBytes[i]);
      if (!same) { tx.abort(); reject(new Error("authority changed during repair")); return; }
      // Enforce quarantine count + byte caps: evict OLDEST (lowest auto-increment
      // key) until both caps hold for the new record.
      const cursorReq = qStore.openCursor();
      const toDelete = [];
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          toDelete.push({ key: cursor.primaryKey, size: new Uint8Array(cursor.value?.bytes ?? new Uint8Array(0)).byteLength });
          cursor.continue();
        } else {
          let count = toDelete.length;
          let totalBytes = toDelete.reduce((n, r) => n + r.size, 0);
          let i = 0;
          while ((count >= MAX_QUARANTINE || totalBytes + readBytes.byteLength > MAX_QUARANTINE_BYTES) && i < toDelete.length) {
            qStore.delete(toDelete[i].key);
            totalBytes -= toDelete[i].size;
            count -= 1;
            i += 1;
          }
          const addReq = qStore.add({ ts: Date.now(), bytes: new Uint8Array(readBytes) });
          addReq.onsuccess = () => {
            store.put({ id: AUTHORITY_KEY, bytes: encodeEnvelope(replacement) });
            metaStore.put({ id: META_LOCAL, done: true });
            metaStore.put({ id: META_DISCARD, done: true });
            const qRead = qStore.get(addReq.result);
            qRead.onsuccess = () => {
              const back = new Uint8Array(qRead.result?.bytes ?? new Uint8Array(0));
              if (back.length !== readBytes.length || back.some((b, i) => b !== readBytes[i])) { tx.abort(); reject(new Error("quarantine readback mismatch")); return; }
            };
          };
          addReq.onerror = () => { tx.abort(); reject(addReq.error); };
        }
      };
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("repair aborted"));
  });
}

async function readEnvelope() {
  const bytes = await readAuthorityBytes();
  if (bytes == null) return emptyEnvelope(0);
  const parsed = parseEnvelope(new Uint8Array(bytes));
  if (!parsed) {
    await transactQuarantineAndReplace(new Uint8Array(bytes), emptyEnvelope(1));
    return emptyEnvelope(1);
  }
  const sanitized = sanitizeRows(parsed.rows, { tombstones: parsed.tombstones });
  const env = { v: SCHEMA_VERSION, gen: parsed.gen, rows: sanitized.rows, tombstones: sanitized.tombstones };
  if (canonicalJson(env) !== canonicalJson(parsed)) {
    // COMPACTION (retention/5000-cap trim) — NOT corruption. Rewrite the
    // sanitized envelope + set the pending for the outbox; do NOT quarantine or
    // set the migration markers (those are corruption-only).
    await transactAuthority((current, { metaStore }) => {
      if (current.gen !== parsed.gen) return null; // a concurrent mutation won — keep it
      metaStore.put({ id: META_PENDING, gen: env.gen });
      return env;
    });
    return env;
  }
  return env;
}

// ---- chrome.storage.local mirror (output-only, universal outbox) ----
async function localGranted() { try { return await storageAvailable(); } catch { return false; } }
async function mirrorLocal(env) {
  if (!(await localGranted())) return false;
  try {
    const payload = { v: env.v, gen: env.gen, rows: env.rows, tombstones: env.tombstones };
    await chrome.storage.local.set({ [STORAGE_KEY]: payload });
    const read = await chrome.storage.local.get(STORAGE_KEY);
    const back = read?.[STORAGE_KEY];
    // EXACT full-canonical readback (not just v/gen).
    if (!back || JSON.stringify({ v: back.v, gen: back.gen, rows: back.rows, tombstones: back.tombstones }) !== canonicalJson(env)) return false;
    return true;
  } catch { return false; }
}
async function withMirrorLock(fn) {
  if (typeof navigator !== "undefined" && typeof navigator.locks?.request === "function") {
    return await navigator.locks.request("cap-usage-mirror", async () => await fn());
  }
  return await withLock(fn); // fallback (documented weaker; cross-realm needs Web Lock)
}
async function clearPendingIfGen(gen) {
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readwrite");
  const getReq = tx.objectStore(STORE_META).get(META_PENDING);
  getReq.onsuccess = () => { if (getReq.result?.gen === gen) tx.objectStore(STORE_META).delete(META_PENDING); };
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
/** UNIVERSAL outbox drain: every mutation (write/clear/migration/regrant) sets the
 * pending generation in the SAME authority tx, then drains the latest generation
 * with a conditional ACK under the Web Lock. */
async function drainMirror() {
  return withMirrorLock(async () => {
    for (let i = 0; i < 8; i++) {
      const pending = await readPendingGen();
      if (pending == null) return;
      const env = await readEnvelope();
      if (env.gen < pending) {
        // A corruption repair reset the authority to a lower generation while the
        // pending marker still held the higher pre-corruption gen: mirror the
        // REPAIRED envelope (not silently clear the stale pending without it).
        const ok = await mirrorLocal(env);
        await clearPendingIfGen(pending);
        if (ok) continue;
        return;
      }
      const ok = await mirrorLocal(env);
      if (!ok) return; // leave durable pending for a later drain
      await clearPendingIfGen(env.gen);
      if (env.gen === pending) return;
    }
  });
}

/** The UNIVERSAL mutation path: authority + pending committed in one tx, then
 * drain. */
async function mutate(mutator) {
  let committed = null;
  await transactAuthority((env, { metaStore }) => {
    committed = mutator(env, { metaStore });
    if (committed !== null && committed !== undefined) metaStore.put({ id: META_PENDING, gen: committed.gen });
    return committed;
  });
  if (committed) await drainMirror();
  return committed;
}

// ---- per-source migration ----
async function readLegacyOpfs() {
  try {
    if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") return { rows: [], tombstones: [], cleared: false };
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("usage");
    const fh = await dir.getFileHandle("usage-v2.json");
    const f = await fh.getFile();
    const parsed = JSON.parse(await f.text());
    return { rows: Array.isArray(parsed?.rows) ? parsed.rows : [], tombstones: Array.isArray(parsed?.pendingDeleteIds) ? parsed.pendingDeleteIds : [], cleared: parsed?.pendingClear === true };
  } catch { return { rows: [], tombstones: [], cleared: false }; }
}
async function readLegacyLocal() {
  if (!(await localGranted())) return { rows: [], tombstones: [], cleared: false };
  try {
    const store = await kvGet(STORAGE_KEY);
    const v = store?.[STORAGE_KEY];
    if (Array.isArray(v)) return { rows: v, tombstones: [], cleared: false };
    if (v && typeof v === "object") return { rows: Array.isArray(v.rows) ? v.rows : [], tombstones: [...(Array.isArray(v.tombstones) ? v.tombstones : []), ...(Array.isArray(v.pendingDeleteIds) ? v.pendingDeleteIds : [])], cleared: v.pendingClear === true };
    return { rows: [], tombstones: [], cleared: false };
  } catch { return { rows: [], tombstones: [], cleared: false }; }
}
let migrationDone = false;
let migrationPromise = null;
async function doMigration() {
  if (!(await readMeta(META_LEGACY))) {
    const legacy = await kvGet(LEGACY_STORAGE_KEY).catch(() => ({}));
    const legacyRows = Array.isArray(legacy?.[LEGACY_STORAGE_KEY]) ? legacy[LEGACY_STORAGE_KEY] : [];
    const opfs = await readLegacyOpfs();
    const byId = new Map(); const order = []; const tombstones = new Set();
    const absorb = (rows) => { for (const r of Array.isArray(rows) ? rows : []) { const c = sanitizeRow(r, Date.now()); if (c && !byId.has(c.id)) { byId.set(c.id, c); order.push(c.id); } } };
    if (!opfs.cleared) { absorb(legacyRows); absorb(opfs.rows); }
    for (const t of opfs.tombstones) { const c = canonicalId(t); if (c) tombstones.add(c); }
    const rows = order.map((id) => byId.get(id)).filter((r) => !tombstones.has(r.id));
    const env = { v: SCHEMA_VERSION, gen: 1, rows, tombstones: [...tombstones] };
    await transactAuthority((current, { metaStore }) => {
      if (current.gen > 0) return null; // loser — the winner's env wins
      metaStore.put({ id: META_LEGACY, done: true });
      metaStore.put({ id: META_PENDING, gen: env.gen });
      return env;
    });
    await kvRemove(LEGACY_STORAGE_KEY).catch(() => {});
  }
  if (!(await readMeta(META_LOCAL)) && !(await readMeta(META_DISCARD))) {
    if (!(await localGranted())) return; // still pending
    const local = await readLegacyLocal();
    // One tx that RE-CHECKS the discard/migrated markers INSIDE the transaction
    // (via chained metaStore.get requests) so a clear committed between our local
    // read and this tx cannot resurrect the cleared rows.
    await transactLocalMigration(local);
  }
}

/** Atomic optional-local migration with IN-TRANSACTION discard re-check. */
async function transactLocalMigration(local) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_AUTHORITY, STORE_META], "readwrite");
    const store = tx.objectStore(STORE_AUTHORITY);
    const metaStore = tx.objectStore(STORE_META);
    const discardReq = metaStore.get(META_DISCARD);
    discardReq.onsuccess = () => {
      if (discardReq.result?.done === true) { tx.abort(); resolve(false); return; } // a clear raced us — skip
      const migratedReq = metaStore.get(META_LOCAL);
      migratedReq.onsuccess = () => {
        if (migratedReq.result?.done === true) { tx.abort(); resolve(false); return; }
        const getReq = store.get(AUTHORITY_KEY);
        getReq.onsuccess = () => {
          const current = getReq.result?.bytes ? parseEnvelope(new Uint8Array(getReq.result.bytes)) : emptyEnvelope(0);
          if (!current) { tx.abort(); reject(new Error("corrupt authority")); return; }
          const byId = new Map(); const order = [];
          const absorb = (src) => { for (const r of src) { if (r && r.id) { if (!byId.has(r.id)) order.push(r.id); byId.set(r.id, r); } } };
          absorb(current.rows ?? []);
          if (!local.cleared) absorb(local.rows);
          const tombstones = new Set((current.tombstones ?? []).filter((v) => typeof v === "string"));
          for (const t of local.tombstones) { const c = canonicalId(t); if (c) tombstones.add(c); }
          const rows = order.map((id) => byId.get(id)).filter((r) => !tombstones.has(r.id));
          const s = sanitizeRows(rows, { tombstones: [...tombstones] });
          const next = { v: SCHEMA_VERSION, gen: bumpGen(current.gen), rows: s.rows, tombstones: s.tombstones };
          metaStore.put({ id: META_LOCAL, done: true });
          metaStore.put({ id: META_PENDING, gen: next.gen });
          store.put({ id: AUTHORITY_KEY, bytes: encodeEnvelope(next) });
        };
      };
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("local migration aborted"));
  });
}
/** Pre-migration corruption guard: quarantine + replace corrupt authority bytes
 * BEFORE any mutation/migration touches them (so a corrupt oversized blob never
 * reaches a transactAuthority mutation). */
async function handleCorruption() {
  const bytes = await readAuthorityBytes();
  if (bytes == null) return;
  if (!parseEnvelope(new Uint8Array(bytes))) {
    await transactQuarantineAndReplace(new Uint8Array(bytes), emptyEnvelope(1));
  }
}

export async function migrateLegacy() {
  if (migrationDone) return;
  if (!migrationPromise) {
    migrationPromise = withLock(async () => { await handleCorruption(); await doMigration(); await drainMirror(); }).then(() => { migrationDone = true; }).finally(() => { migrationPromise = null; });
  }
  await migrationPromise;
}
export function resetUsageMigration() { migrationDone = false; migrationPromise = null; dbPromise = null; }

// ---- public API ----
export async function usageRead() {
  await migrateLegacy();
  return withLock(async () => {
    const env = await readEnvelope();
    const pending = new Set((env.tombstones ?? []).filter((v) => typeof v === "string"));
    return { rows: (env.rows ?? []).filter((r) => !pending.has(r.id)), durability: "indexeddb" };
  });
}
export async function usageWrite(rows) {
  await migrateLegacy();
  return withLock(async () => {
    await mutate((env) => {
      const merged = [...(env.rows ?? [])];
      const existing = new Map(merged.map((r) => [r.id, JSON.stringify(r)]));
      let changed = false;
      for (const r of Array.isArray(rows) ? rows : []) {
        const clean = sanitizeRow(r, Date.now());
        if (!clean) continue;
        const canon = JSON.stringify(clean);
        if (existing.has(clean.id)) { if (existing.get(clean.id) !== canon) throw new Error(`usage event id conflict: ${clean.id}`); continue; }
        merged.push(clean); existing.set(clean.id, canon); changed = true;
      }
      if (!changed) return null; // pure duplicate → no-op
      const s = sanitizeRows(merged, { tombstones: env.tombstones ?? [] });
      return { v: SCHEMA_VERSION, gen: bumpGen(env.gen), rows: s.rows, tombstones: s.tombstones };
    });
    return { durability: "indexeddb" };
  });
}
export async function usageRemoveRow(id) {
  await migrateLegacy();
  return withLock(async () => {
    await mutate((env) => {
      const rows = (env.rows ?? []).filter((r) => r.id !== id);
      const s = sanitizeRows(rows, { tombstones: env.tombstones ?? [] });
      return { v: SCHEMA_VERSION, gen: bumpGen(env.gen), rows: s.rows, tombstones: s.tombstones };
    });
    return { durability: "indexeddb" };
  });
}
export async function usageClear() {
  await migrateLegacy();
  return withLock(async () => {
    const localMigrated = !!(await readMeta(META_LOCAL));
    await mutate((env, { metaStore }) => {
      if (!localMigrated) metaStore.put({ id: META_DISCARD, done: true });
      return emptyEnvelope(bumpGen(env.gen));
    });
  });
}
export async function usageOverwriteMirror() {
  return withLock(async () => { await drainMirror(); });
}
export async function usageDurability() { const r = await usageRead(); return r.durability; }
