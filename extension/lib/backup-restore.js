// extension/lib/backup-restore.js — the streaming RESTORE driver
// (chrome-agent-platform-0u8n / 11rm.4, Stage 4 of
// docs/STREAMED-BACKUP-RESTORE-ARCHITECTURE.md).
//
// OPTIONS-PAGE ONLY: this module is imported by options.js and must never be
// pulled into the service-worker bundle.

import { decodeTarStream } from "./tar-stream.js";
import { newId, sleep } from "./pure.js";
import { validateStagedMasterJournalBackup } from "./master-journal-backup.js";
import {
  createOpfsAdapter,
  createChromeAlarmsAdapter,
  isExcludedOpfsPath,
  b64Encode,
  b64Decode,
  recoverPendingImport,
  parseArchive,
} from "./data-archive.js";

const DECODER = new TextDecoder("utf-8", { fatal: true });
const ENCODER = new TextEncoder();
const IMPORT_SIDECAR_KEY = "cap:importBackup";
const RESTORE_FENCE_KEY = "cap:restoreFence";
const RESTORE_HEARTBEAT_KEY = "cap:restoreHeartbeat";
const RESTORE_CLAIM_KEY = "cap:restoreClaim";
export const RESTORE_INVALIDATION_KEY = "cap:invalidationPending";
const RESTORE_RECOVERY_ALARM = "cap-restore-recovery-alarm";
const INTERNAL_RESTORE_KEYS = new Set([
  IMPORT_SIDECAR_KEY,
  RESTORE_FENCE_KEY,
  RESTORE_HEARTBEAT_KEY,
  RESTORE_CLAIM_KEY,
  RESTORE_INVALIDATION_KEY,
]);

/**
 * Factory for Options page restore quiescence.
 * Fails closed if tasks are active without mutating or cancelling them.
 */
export function createOptionsQuiesce({
  send,
  setBackupStatus = () => {},
  setStorage = (items) => (typeof chrome !== "undefined" && chrome?.storage?.local ? chrome.storage.local.set(items) : Promise.resolve()),
  maxWaitMs = 5000,
  pollIntervalMs = 50,
} = {}) {
  if (typeof send !== "function") {
    throw new TypeError("createOptionsQuiesce requires a send function");
  }

  function validateRunListResponse(res, stepName) {
    if (!res || !Array.isArray(res.runs) || typeof res.activeWritersCount !== "number" || !Number.isInteger(res.activeWritersCount) || res.activeWritersCount < 0) {
      throw new Error(`Failed to query run list during quiescence (${stepName}): malformed response`);
    }
    for (const r of res.runs) {
      if (typeof r?.phase !== "string" || !r.phase.trim()) {
        throw new Error(`Malformed run record in ${stepName}: missing or non-string phase for ${r?.executionId || r?.id || "unknown"}`);
      }
    }
    return res;
  }

  return async function quiesce() {
    setBackupStatus("Quiescing active tasks and scheduled routines…");
    await setStorage({ [RESTORE_FENCE_KEY]: Date.now() });

    const TERMINAL_PHASES = new Set(["terminal", "cancelled"]);
    const startWait = Date.now();

    while (Date.now() - startWait < maxWaitMs) {
      const checkRes = validateRunListResponse(await send("run.list"), "polling");
      const activeRuns = checkRes.runs.filter((r) => !TERMINAL_PHASES.has(r.phase));
      if (activeRuns.length === 0 && checkRes.activeWritersCount === 0) break;
      await sleep(pollIntervalMs);
    }

    const finalCheck = validateRunListResponse(await send("run.list"), "final");
    const remaining = finalCheck.runs.filter((r) => !TERMINAL_PHASES.has(r.phase));
    if (remaining.length > 0 || finalCheck.activeWritersCount > 0) {
      throw new Error(`Profile restore cannot proceed while tasks are actively running (${remaining.length} active runs, ${finalCheck.activeWritersCount} active writers). Please allow them to complete or stop them before restoring.`);
    }
  };
}

function isSafeRelativePath(path) {
  if (typeof path !== "string" || !path) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  const segments = path.split(/[/\\]/);
  for (const s of segments) {
    if (s === ".." || s === "." || !s) return false;
  }
  return true;
}

async function readStreamToBytes(stream) {
  if (!stream) return new Uint8Array(0);
  if (stream instanceof Uint8Array) return stream;
  if (stream.buffer instanceof ArrayBuffer && stream.byteLength !== undefined) {
    return new Uint8Array(stream.buffer, stream.byteOffset, stream.byteLength);
  }
  if (typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks = [];
    let totalLen = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        chunks.push(value);
        totalLen += value.byteLength;
      }
    }
    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    return out;
  }
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function isJsonBytes(bytes) {
  if (!bytes || bytes.length === 0) return false;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    return b === 0x7b; // '{'
  }
  return false;
}

/**
 * Stream-restore a profile from a TAR archive byte stream or legacy cap-export JSON
 * with three-phase transactional safety (staging -> confirmation -> commit with rollback journal).
 *
 * Constant O(1) memory contract: does NOT buffer file bytes in memory across phases.
 * Staged files reside in OPFS and are streamed/copied individually during commit.
 *
 * @param {object} opts
 * @param {ReadableStream<Uint8Array> | Blob | File | string} opts.stream — the source byte stream or file.
 * @param {object} [opts.opfs] — OPFS adapter or root handle.
 * @param {Function} [opts.kvSet] — (items) => Promise<void>.
 * @param {Function} [opts.kvRemove] — (keys) => Promise<void>.
 * @param {Function} [opts.kvGet] — (key) => Promise<object>.
 * @param {object} [opts.alarms] — chrome.alarms adapter { create, clear, getAll }.
 * @param {Function} [opts.confirm] — async ({ manifest, summary, report }) => Promise<boolean>.
 * @param {Function} [opts.quiesce] — async () => Promise<void> (suspends active runs/scheduler before commit).
 * @param {Function} [opts.onProgress] — ({ phase, path, bytes }) => void.
 * @param {boolean} [opts.overwrite] — whether to replace / prune existing data.
 * @param {string} [opts.stagingPrefix] — prefix for staging directory.
 * @returns {Promise<{ ok: boolean, cancelled?: boolean, manifest: object, report: { restored: object }, restored: object }>}
 */
export async function streamRestoreArchive({
  stream,
  opfs: customOpfs = null,
  kvSet: customKvSet = null,
  kvRemove: customKvRemove = null,
  kvGet: customKvGet = null,
  alarms: customAlarms = null,
  confirm: confirmAction = null,
  quiesce = null,
  postCommit = null,
  onRollback = null,
  onProgress = null,
  lockAcquirer = null,
  quiesceBackupDir = null,
  overwrite = false,
  stagingPrefix = ".staging-restore-",
} = {}) {
  let sourceStream = stream;
  if (!sourceStream) {
    throw new TypeError("stream is required for streamRestoreArchive");
  }

  // Resolve OPFS adapter
  let opfs = customOpfs;
  if (opfs && typeof opfs.writeFile !== "function" && typeof opfs.getFileHandle === "function") {
    opfs = createOpfsAdapter(opfs);
  } else if (!opfs && typeof navigator !== "undefined" && navigator.storage?.getDirectory) {
    opfs = createOpfsAdapter(await navigator.storage.getDirectory());
  }

  // Resolve alarms adapter
  let alarms = customAlarms;
  if (!alarms && typeof chrome !== "undefined" && chrome.alarms) {
    alarms = createChromeAlarmsAdapter();
  }

  // Resolve storage functions
  const kvSet = customKvSet || (typeof chrome !== "undefined" && chrome.storage?.local?.set ? (items) => chrome.storage.local.set(items) : null);
  const kvRemove = customKvRemove || (typeof chrome !== "undefined" && chrome.storage?.local?.remove ? (keys) => chrome.storage.local.remove(keys) : null);
  const kvGet = customKvGet || (typeof chrome !== "undefined" && chrome.storage?.local?.get ? (key) => chrome.storage.local.get(key ?? null) : null);

  const backends = { kvGet, kvSet, kvRemove, opfs, alarms };

  const restoreSessionId = newId("restore");
  let restoreHeartbeatTimer = null;
  let committed = false;

  const executeWithLock = async (fn) => {
    if (typeof lockAcquirer === "function") {
      return await lockAcquirer("cap:restoreLock", fn);
    }
    // Only engage navigator.locks if lockAcquirer was not provided AND we are in a real browser extension runtime
    // (avoid colliding with Deno's process-wide Web Locks during unit tests with custom mocks)
    if (typeof chrome !== "undefined" && chrome.runtime?.id && typeof navigator !== "undefined" && navigator.locks?.request) {
      return await navigator.locks.request("cap:restoreLock", { mode: "exclusive" }, async () => {
        return await fn();
      });
    }
    return await fn();
  };

  return await executeWithLock(async () => {
    // 1. Refuse if another restore operation is actively running in another tab/process
    if (typeof kvGet === "function") {
      const activeFence = await kvGet([RESTORE_HEARTBEAT_KEY, RESTORE_CLAIM_KEY, RESTORE_FENCE_KEY, IMPORT_SIDECAR_KEY, RESTORE_INVALIDATION_KEY]);
      const hasActiveHeartbeat = activeFence?.[RESTORE_HEARTBEAT_KEY] && (Date.now() - Number(activeFence[RESTORE_HEARTBEAT_KEY])) < 30000;
      if (hasActiveHeartbeat) {
        throw new Error("Another restore operation is currently in progress. Please wait for it to complete.");
      }

      // If invalidation was pending from a prior committed restore, resolve invalidation before clearing fence!
      if (activeFence?.[RESTORE_INVALIDATION_KEY]) {
        if (typeof postCommit === "function") {
          await postCommit();
        } else if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
          const invRes = await chrome.runtime.sendMessage({ type: "invalidate-agent" });
          if (invRes && invRes.invalidated === false) {
            throw new Error("Worker reported failure during cache invalidation");
          }
        }
        if (typeof kvRemove === "function") {
          await kvRemove([RESTORE_INVALIDATION_KEY]).catch(() => {});
        }
      }

      // If a stale fence or claim exists without a journal and without a fresh heartbeat (pre-journal crash), clean it up
      if (!activeFence?.[IMPORT_SIDECAR_KEY] && (activeFence?.[RESTORE_FENCE_KEY] || activeFence?.[RESTORE_CLAIM_KEY])) {
        if (typeof kvRemove === "function") {
          await kvRemove([RESTORE_FENCE_KEY, RESTORE_CLAIM_KEY, RESTORE_HEARTBEAT_KEY]).catch(() => {});
        }
      }
    }

    // 2. Self-heal first: recover any truly abandoned crashed import BEFORE acquiring new claim
    try {
      await recoverPendingImport(backends);
    } catch (healErr) {
      throw new Error(`Self-heal rollback failed: ${healErr?.message || healErr}`);
    }

    // 3. Acquire exclusive admission claim with read-after-write verification
    if (typeof kvGet === "function" && typeof kvSet === "function") {
      // Must not swallow write errors on admission claim
      await kvSet({
        [RESTORE_CLAIM_KEY]: { sessionId: restoreSessionId, timestamp: Date.now() },
        [RESTORE_HEARTBEAT_KEY]: Date.now(),
      });
      // Small pause to let any racing writer settle, then verify exclusive ownership
      await sleep(20);
      const verified = await kvGet(RESTORE_CLAIM_KEY);
      if (verified?.[RESTORE_CLAIM_KEY]?.sessionId !== restoreSessionId) {
        throw new Error("Another restore operation is currently in progress. Please wait for it to complete.");
      }
      restoreHeartbeatTimer = setInterval(() => {
        try { kvSet({ [RESTORE_HEARTBEAT_KEY]: Date.now() }); } catch { /* heartbeat timer best-effort */ }
      }, 5000);
    }

    try {
      const now = Date.now();
  const stagingDir = `${stagingPrefix}${now}`;
  const rollbackDir = `.rollback-backup-${now}`;
  let manifest = null;
  let restoredKv = null;
  let restoredAlarms = null;
  const stagedEntries = []; // { relPath, stagedPath, size }

  // ── Format detection ──────────────────────────────────────────────────────
  let isJson = false;
  let rawJsonText = null;

  if (typeof sourceStream === "string") {
    isJson = isJsonBytes(ENCODER.encode(sourceStream.slice(0, 32)));
    if (isJson) rawJsonText = sourceStream;
  } else if (sourceStream instanceof Blob) {
    const head = new Uint8Array(await sourceStream.slice(0, 64).arrayBuffer());
    if (isJsonBytes(head)) {
      isJson = true;
      rawJsonText = await sourceStream.text();
    } else {
      sourceStream = sourceStream.stream();
    }
  } else if (typeof sourceStream.stream === "function") {
    sourceStream = sourceStream.stream();
  }

  try {
    if (isJson && rawJsonText) {
      // ── Phase 1 for Legacy JSON Backup (validated via parseArchive) ──────────
      const parsed = parseArchive(rawJsonText);
      manifest = parsed.manifest;
      restoredKv = parsed.kv;
      restoredAlarms = parsed.alarms;

      for (const entry of parsed.opfs) {
        const relPath = String(entry.path).replace(/^opfs\//, "");
        if (!isSafeRelativePath(relPath)) {
          throw new Error(`archive-unsafe-path: invalid path "${relPath}"`);
        }
        if (isExcludedOpfsPath(relPath)) continue;

        const bytes = entry._bytes;
        const stagedPath = `${stagingDir}/${relPath}`;
        stagedEntries.push({ relPath, stagedPath, size: bytes.byteLength });
        if (opfs?.writeFile) await opfs.writeFile(stagedPath, bytes);
      }
    } else {
      // ── Phase 1 for TAR Stream (O(1) RAM streaming staging) ──────────────────
      await decodeTarStream(sourceStream, async (entry) => {
        if (entry.typeflag === "5") return;

        if (entry.name === "manifest.json") {
          const bytes = await readStreamToBytes(entry.body);
          manifest = JSON.parse(DECODER.decode(bytes));
          if (manifest?.magic !== "cap-archive" && manifest?.magic !== "cap-export") {
            throw new Error(`Invalid backup archive: unrecognized magic "${manifest?.magic}"`);
          }
          return;
        }

        if (entry.name === "kv.json") {
          const bytes = await readStreamToBytes(entry.body);
          restoredKv = JSON.parse(DECODER.decode(bytes));
          return;
        }

        if (entry.name === "alarms.json") {
          const bytes = await readStreamToBytes(entry.body);
          restoredAlarms = JSON.parse(DECODER.decode(bytes));
          return;
        }

        const relPath = entry.name.replace(/^opfs\//, "");
        if (!isSafeRelativePath(relPath)) {
          throw new Error(`Invalid path in archive: "${relPath}"`);
        }
        if (isExcludedOpfsPath(relPath)) return;

        const stagedPath = `${stagingDir}/${relPath}`;
        stagedEntries.push({ relPath, stagedPath, size: entry.size || 0 });

        if (typeof opfs?.writeStream === "function") {
          await opfs.writeStream(stagedPath, entry.body);
        } else {
          const bytes = await readStreamToBytes(entry.body);
          if (opfs?.writeFile) await opfs.writeFile(stagedPath, bytes);
        }

        if (typeof onProgress === "function") {
          try {
            onProgress({ phase: "staging", path: relPath, bytes: entry.size || 0 });
          } catch {
            // progress reporting must not abort restore
          }
        }
      });
    }

    // Validate mandatory archive sections and manifest consistency before proceeding
    if (!manifest) {
      throw new Error("Invalid backup archive: missing manifest.json");
    }
    const version = manifest.formatVersion;
    if (version !== undefined && version !== 2 && version !== 1 && version !== "2.0.0" && version !== "1.0.0") {
      throw new Error(`Invalid backup archive: unsupported formatVersion "${version}"`);
    }
    if (!restoredKv || typeof restoredKv !== "object" || Array.isArray(restoredKv)) {
      throw new Error("Invalid backup archive: missing or malformed kv.json");
    }
    if (!Array.isArray(restoredAlarms)) {
      throw new Error("Invalid backup archive: missing or malformed alarms.json");
    }
    for (const k of INTERNAL_RESTORE_KEYS) {
      if (Object.hasOwn(restoredKv, k)) {
        throw new Error(`Invalid backup archive: reserved key "${k}" in settings dump`);
      }
    }

    // Cross-check declared manifest counts if present
    const counts = manifest.manifest || manifest;
    if (typeof counts.kvKeys === "number" && counts.kvKeys !== Object.keys(restoredKv).length) {
      throw new Error(`Invalid backup archive: manifest kvKeys mismatch (${counts.kvKeys} vs ${Object.keys(restoredKv).length})`);
    }
    if (typeof counts.alarms === "number" && counts.alarms !== restoredAlarms.length) {
      throw new Error(`Invalid backup archive: manifest alarms mismatch (${counts.alarms} vs ${restoredAlarms.length})`);
    }
    if (typeof counts.opfsFiles === "number" && counts.opfsFiles !== stagedEntries.length) {
      throw new Error(`Invalid backup archive: manifest opfsFiles mismatch (${counts.opfsFiles} vs ${stagedEntries.length})`);
    }
    // A raw WAL archive is a unit: reject torn heads, absent dependencies and
    // unpublished frames BEFORE owner confirmation or any live-file mutation.
    // Legacy profiles (no WAL records) retain their existing import path.
    await validateStagedMasterJournalBackup(stagedEntries, opfs?.readFile);
  } catch (err) {
    if (typeof opfs?.removeDirectory === "function") {
      await opfs.removeDirectory(stagingDir, { recursive: true }).catch(() => {});
    } else if (opfs && typeof opfs.removeFile === "function") {
      for (const entry of stagedEntries) {
        await opfs.removeFile(entry.stagedPath).catch(() => {});
      }
      if (typeof opfs.listFiles === "function") {
        try {
          const files = await opfs.listFiles();
          for (const f of files) {
            if (f.startsWith(stagingDir)) await opfs.removeFile(f).catch(() => {});
          }
        } catch { /* ignore staging scan failure */ }
      }
    }
    throw err;
  }

  const summary = {
    opfsFiles: stagedEntries.length,
    kvKeys: Object.keys(restoredKv).length,
    alarms: restoredAlarms.length,
  };

  // ── Phase 2: Owner Confirmation (fail-closed cancellation) ────────────────
  if (typeof confirmAction === "function") {
    let approved = false;
    try {
      approved = await confirmAction({ manifest, summary, report: { restored: summary } });
    } catch { /* confirmation threw or was cancelled */
      approved = false;
    }
    if (!approved) {
      if (restoreHeartbeatTimer) clearInterval(restoreHeartbeatTimer);
      if (typeof kvGet === "function" && typeof kvRemove === "function") {
        try {
          const cur = await kvGet(RESTORE_CLAIM_KEY);
          if (cur?.[RESTORE_CLAIM_KEY]?.sessionId === restoreSessionId) {
            await kvRemove([RESTORE_CLAIM_KEY, RESTORE_FENCE_KEY, RESTORE_HEARTBEAT_KEY]);
          }
        } catch { /* ignore cancel coordination removal error */ }
      }
      if (typeof opfs?.removeDirectory === "function") {
        await opfs.removeDirectory(stagingDir, { recursive: true }).catch(() => {});
      } else if (opfs && typeof opfs.removeFile === "function") {
        for (const entry of stagedEntries) {
          await opfs.removeFile(entry.stagedPath).catch(() => {});
        }
        if (typeof opfs.listFiles === "function") {
          try {
            const files = await opfs.listFiles();
            for (const f of files) {
              if (f.startsWith(stagingDir)) await opfs.removeFile(f).catch(() => {});
            }
          } catch { /* ignore cancel staging scan failure */ }
        }
      }
      return { ok: false, cancelled: true, manifest, report: { restored: summary }, restored: summary };
    }
  }

  // Helper to cleanup on backup preparation failure
  async function cleanupOnBackupFailure() {
    if (typeof opfs?.removeDirectory === "function") {
      await opfs.removeDirectory(stagingDir, { recursive: true }).catch(() => {});
      await opfs.removeDirectory(rollbackDir, { recursive: true }).catch(() => {});
    } else if (opfs && typeof opfs.listFiles === "function" && typeof opfs.removeFile === "function") {
      try {
        const files = await opfs.listFiles();
        for (const f of files) {
          if (f.startsWith(stagingDir) || f.startsWith(rollbackDir)) {
            await opfs.removeFile(f).catch(() => {});
          }
        }
      } catch { /* best-effort cleanup of fallback files */ }
    }
  }

  // ── Phase 2 -> Phase 3 Transition: Quiescence & Journaling ───────────────
  let existingAlarms = [];
  let existingFiles = [];
  let existingFilesSet = new Set();
  const journalOps = [];
  let existingKv = {};
  let journalPersisted = false;

  try {
    // Verify that this session still owns the exclusive restore claim
    if (typeof kvGet === "function") {
      const checkClaim = await kvGet(RESTORE_CLAIM_KEY);
      if (!checkClaim?.[RESTORE_CLAIM_KEY] || checkClaim[RESTORE_CLAIM_KEY].sessionId !== restoreSessionId) {
        throw new Error("Restore claim was lost or superseded by another session.");
      }
    }

    // Establish admission fence and live heartbeat before snapshotting profile — propagate errors
    if (kvSet) {
      await kvSet({ [RESTORE_FENCE_KEY]: Date.now(), [RESTORE_HEARTBEAT_KEY]: Date.now() });
    }

    // Capture PRE-quiescence KV snapshot BEFORE any quiescence hook runs!
    // This ensures any in-flight runs in storage are recorded in the journal at their pre-quiescence state,
    // preventing the crash-safety hazard where a mid-swap crash leaves runs cancelled with running files.
    // Use structuredClone so in-memory mutations by quiesce cannot alter the captured pre-quiescence snapshot.
    const rawKvSnapshot = (kvGet ? await kvGet(null) : {}) || {};
    existingKv = structuredClone(rawKvSnapshot);

    // Halt active task runs and ensure live writers quiesce BEFORE snapshotting profile files
    // so active writers cannot race or mutate files during/after snapshotting.
    if (typeof quiesce === "function") {
      await quiesce();
    } else if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        await chrome.runtime.sendMessage({ type: "restore.quiesce" }).catch(() => {});
      } catch { /* best-effort quiesce message */ }
    }

    existingAlarms = (alarms && typeof alarms.getAll === "function")
      ? (await alarms.getAll()).filter((a) => a && a.name !== RESTORE_RECOVERY_ALARM)
      : [];

    const rawFiles = (opfs && typeof opfs.listFiles === "function") ? (await opfs.listFiles()) : [];
    existingFiles = [];
    const reclaimedDirs = new Set();
    for (const p of rawFiles) {
      if (p.startsWith(stagingDir) || p.startsWith(rollbackDir)) continue;
      const rootDir = p.split("/")[0];
      if (rootDir.startsWith(".staging-restore-") || rootDir.startsWith(".rollback-backup-") || rootDir.startsWith(".staging-export-")) {
        // Abandoned temporary files left by prior crashes are reclaimed only if older than 60s
        // so live in-flight exports or concurrent operations are never touched.
        const match = rootDir.match(/\.(staging-restore|rollback-backup|staging-export)-(\d+)/);
        const fileTs = match ? Number(match[2]) : 0;
        if (!fileTs || (Date.now() - fileTs) >= 60000) {
          if (typeof opfs.removeDirectory === "function" && !reclaimedDirs.has(rootDir)) {
            reclaimedDirs.add(rootDir);
            await opfs.removeDirectory(rootDir, { recursive: true }).catch(() => {});
          } else {
            await opfs.removeFile(p).catch(() => {});
          }
          continue;
        }
      }
      if (isExcludedOpfsPath(p)) continue;
      existingFiles.push(p);
    }
    existingFilesSet = new Set(existingFiles);

    // 1. Journal KV operations (kind 0) — use __cap_val to preserve existing null values vs non-existent keys
    for (const k of Object.keys(restoredKv)) {
      if (INTERNAL_RESTORE_KEYS.has(k)) continue;
      const hasKey = Object.hasOwn(existingKv, k);
      journalOps.push([0, k, hasKey ? { __cap_val: existingKv[k] } : null]);
    }
    if (overwrite) {
      for (const k of Object.keys(existingKv)) {
        if (!Object.hasOwn(restoredKv, k) && !INTERNAL_RESTORE_KEYS.has(k)) {
          journalOps.push([0, k, { __cap_val: existingKv[k] }]);
        }
      }
    }

    // 2. Journal File operations (kind 1) — stream backup copies to rollbackDir in OPFS.
    // CRITICAL: Any backup failure MUST abort before writing the journal; never substitute null.
    for (const { relPath } of stagedEntries) {
      if (existingFilesSet.has(relPath)) {
        const backupPath = `${rollbackDir}/${relPath}`;
        try {
          if (typeof opfs?.openStream === "function" && typeof opfs?.writeStream === "function") {
            await opfs.writeStream(backupPath, await opfs.openStream(relPath));
            journalOps.push([1, relPath, `opfs-backup:${backupPath}`]);
          } else if (typeof opfs?.readFile === "function" && typeof opfs?.writeFile === "function") {
            const oldBytes = await opfs.readFile(relPath);
            await opfs.writeFile(backupPath, oldBytes);
            journalOps.push([1, relPath, `opfs-backup:${backupPath}`]);
          } else {
            await cleanupOnBackupFailure();
            throw new Error(`Cannot backup existing file "${relPath}": OPFS write operations unavailable`);
          }
        } catch (backupErr) {
          await cleanupOnBackupFailure();
          throw new Error(`Failed to create rollback backup for existing file "${relPath}": ${backupErr?.message || backupErr}`);
        }
      } else {
        journalOps.push([1, relPath, null]);
      }
    }

    if (overwrite) {
      const stagedRelSet = new Set(stagedEntries.map((e) => e.relPath));
      for (const oldFile of existingFiles) {
        if (!stagedRelSet.has(oldFile)) {
          const backupPath = `${rollbackDir}/${oldFile}`;
          try {
            if (typeof opfs?.openStream === "function" && typeof opfs?.writeStream === "function") {
              await opfs.writeStream(backupPath, await opfs.openStream(oldFile));
              journalOps.push([1, oldFile, `opfs-backup:${backupPath}`]);
            } else if (typeof opfs?.readFile === "function" && typeof opfs?.writeFile === "function") {
              const oldBytes = await opfs.readFile(oldFile);
              await opfs.writeFile(backupPath, oldBytes);
              journalOps.push([1, oldFile, `opfs-backup:${backupPath}`]);
            } else {
              await cleanupOnBackupFailure();
              throw new Error(`Cannot backup unreferenced file "${oldFile}": OPFS write operations unavailable`);
            }
          } catch (backupErr) {
            await cleanupOnBackupFailure();
            throw new Error(`Failed to create rollback backup for unreferenced file "${oldFile}": ${backupErr?.message || backupErr}`);
          }
        }
      }
    }

    // 3. Journal Alarms (kind 2) — journal incoming new alarms for deletion on rollback,
    // and existing alarms with full { when, periodInMinutes } for recreation.
    const existingAlarmsMap = new Map();
    for (const a of existingAlarms) {
      if (a?.name) {
        const info = {};
        if (typeof a.scheduledTime === "number") info.when = a.scheduledTime;
        if (typeof a.periodInMinutes === "number") info.periodInMinutes = a.periodInMinutes;
        existingAlarmsMap.set(a.name, info);
      }
    }

    for (const a of restoredAlarms) {
      if (a?.name && !existingAlarmsMap.has(a.name)) {
        journalOps.push([2, a.name, null]);
      }
    }
    for (const [name, info] of existingAlarmsMap.entries()) {
      journalOps.push([2, name, info]);
    }

    // Persist sidecar rollback journal BEFORE any destination mutation.
    // Clean up both temporary directories if journal write fails.
    if (kvSet && journalOps.length > 0) {
      try {
        await kvSet({ [IMPORT_SIDECAR_KEY]: { version: 2, ops: journalOps, rollbackDir, stagingDir, quiesceBackupDir, preRestoreFiles: existingFiles, timestamp: Date.now() } });
        journalPersisted = true;
      } catch (journalErr) {
        await cleanupOnBackupFailure();
        throw new Error(`Failed to persist rollback journal: ${journalErr?.message || journalErr}`);
      }

      if (alarms && typeof alarms.create === "function") {
        try {
          await alarms.create(RESTORE_RECOVERY_ALARM, { delayInMinutes: 0.6 });
        } catch (alarmErr) {
          let journalRemoved = false;
          if (typeof kvRemove === "function") {
            try {
              await kvRemove(IMPORT_SIDECAR_KEY);
              journalRemoved = true;
              journalPersisted = false;
            } catch { /* best-effort journal removal */ }
          }
          if (journalRemoved) {
            await cleanupOnBackupFailure();
          }
          throw new Error(`Failed to arm recovery alarm (${alarmErr?.message || alarmErr}); ${journalRemoved ? "journal removed" : "journal remains durable, retaining rollback backups"}`);
        }
      }
    }
  } catch (prepErr) {
    if (typeof onRollback === "function") {
      try { await onRollback(); } catch { /* best-effort onRollback callback */ }
    }
    let hasJournal = journalPersisted;
    if (typeof kvGet === "function") {
      try {
        const cur = await kvGet([RESTORE_CLAIM_KEY, IMPORT_SIDECAR_KEY]);
        if (cur && typeof cur === "object") {
          hasJournal = Boolean(cur[IMPORT_SIDECAR_KEY]);
        }
        if (cur?.[RESTORE_CLAIM_KEY]?.sessionId === restoreSessionId) {
          const keysToRemove = [RESTORE_CLAIM_KEY, RESTORE_HEARTBEAT_KEY];
          // Only release admission fence if no durable recovery journal remains!
          if (!hasJournal) {
            keysToRemove.push(RESTORE_FENCE_KEY);
          }
          if (typeof kvRemove === "function") {
            await kvRemove(keysToRemove).catch(() => {});
          }
        }
      } catch {
        // kvGet failed: treat journal state as POSSIBLY DURABLE if it was persisted
      }
    }
    // Only clean rollback backups if journal absence is confirmed.
    // If a durable journal is confirmed or possibly durable, retain rollbackDir!
    if (!hasJournal) {
      await cleanupOnBackupFailure();
    }
    if (opfs && typeof opfs.removeFile === "function") {
      for (const entry of stagedEntries) {
        await opfs.removeFile(entry.stagedPath).catch(() => {});
      }
    }
    throw prepErr;
  }

  let heartbeatTimer = null;
  if (kvSet) {
    heartbeatTimer = setInterval(() => {
      try { kvSet({ [RESTORE_HEARTBEAT_KEY]: Date.now() }); } catch { /* heartbeat timer best-effort */ }
    }, 5000);
  }

  try {
    // Quiesce: clear alarms now that journal is persistent (do NOT swallow errors)
    if (alarms && typeof alarms.clear === "function") {
      for (const a of existingAlarms) {
        if (a?.name) await alarms.clear(a.name);
      }
    }

    // Atomic swap: stream from OPFS staged path to live path (O(1) RAM)
    for (const { relPath, stagedPath, size } of stagedEntries) {
      if (typeof opfs?.openStream === "function" && typeof opfs?.writeStream === "function") {
        await opfs.writeStream(relPath, await opfs.openStream(stagedPath));
      } else if (typeof opfs?.readFile === "function" && typeof opfs?.writeFile === "function") {
        const fileBytes = await opfs.readFile(stagedPath);
        await opfs.writeFile(relPath, fileBytes);
      }
      if (typeof opfs?.removeFile === "function") {
        await opfs.removeFile(stagedPath).catch(() => {});
      }
      if (typeof onProgress === "function") {
        try {
          onProgress({ phase: "commit", path: relPath, bytes: size });
        } catch { /* progress callback error swallowed */ }
      }
    }

    // Prune obsolete unreferenced files on overwrite (do NOT swallow errors)
    if (overwrite && typeof opfs?.removeFile === "function") {
      const stagedRelSet = new Set(stagedEntries.map((e) => e.relPath));
      for (const oldFile of existingFiles) {
        if (!stagedRelSet.has(oldFile)) {
          await opfs.removeFile(oldFile);
        }
      }
    }

    // Apply restored KV settings
    if (restoredKv && typeof kvSet === "function") {
      if (Object.keys(restoredKv).length > 0) {
        await kvSet(restoredKv);
      }
      if (overwrite && typeof kvRemove === "function") {
        const keysToRemove = Object.keys(existingKv).filter(
          (k) => !Object.hasOwn(restoredKv, k) && !INTERNAL_RESTORE_KEYS.has(k),
        );
        if (keysToRemove.length > 0) {
          await kvRemove(keysToRemove);
        }
      }
    }

    // Recreate restored alarms
    if (Array.isArray(restoredAlarms) && alarms && typeof alarms.create === "function") {
      for (const a of restoredAlarms) {
        if (a?.name) {
          const info = {};
          if (typeof a.scheduledTime === "number") info.when = a.scheduledTime;
          if (typeof a.periodInMinutes === "number") info.periodInMinutes = a.periodInMinutes;
          await alarms.create(a.name, info);
        }
      }
    }

    // CRITICAL: Set invalidation-pending marker and remove durable journal.
    // The journal deletion is the commit point.
    // Retain backups whenever journal removal fails.
    if (typeof kvSet === "function") {
      await kvSet({ [RESTORE_INVALIDATION_KEY]: Date.now() });
    }
    if (typeof kvRemove === "function") {
      await kvRemove([IMPORT_SIDECAR_KEY]);
      committed = true;
    } else {
      committed = true;
    }

    // ONLY AFTER journal removal succeeds, clean up the rollback backup directory on disk
    if (typeof opfs?.removeDirectory === "function") {
      await opfs.removeDirectory(rollbackDir, { recursive: true }).catch(() => {});
      await opfs.removeDirectory(stagingDir, { recursive: true }).catch(() => {});
    } else if (opfs && typeof opfs.listFiles === "function" && typeof opfs.removeFile === "function") {
      try {
        const remaining = await opfs.listFiles();
        for (const f of remaining) {
          if (f.startsWith(rollbackDir) || f.startsWith(stagingDir) || (quiesceBackupDir && f.startsWith(quiesceBackupDir))) {
            await opfs.removeFile(f).catch(() => {});
          }
        }
      } catch { /* ignore remaining files scan error */ }
    }
  } catch (commitErr) {
    if (committed) {
      throw commitErr;
    }
    if (kvRemove && typeof kvGet === "function") {
      try {
        const cur = await kvGet(RESTORE_CLAIM_KEY);
        if (cur?.[RESTORE_CLAIM_KEY]?.sessionId === restoreSessionId) {
          await kvRemove([RESTORE_HEARTBEAT_KEY]);
        }
      } catch { /* ignore heartbeat removal error */ }
    }
    // On swap failure: invoke rollback from journal and clean staging
    let rolledBack = false;
    try {
      rolledBack = await recoverPendingImport({ ...backends, preserveClaimSessionId: restoreSessionId, onRollback });
    } catch (rbErr) {
      if (opfs && typeof opfs.removeFile === "function") {
        for (const entry of stagedEntries) {
          await opfs.removeFile(entry.stagedPath).catch(() => {});
        }
      }
      throw new Error(`Commit failed (${commitErr?.message || commitErr}) AND rollback failed (${rbErr?.message || rbErr}). Manual recovery may be required.`);
    }
    if (opfs && typeof opfs.removeFile === "function") {
      for (const entry of stagedEntries) {
        await opfs.removeFile(entry.stagedPath).catch(() => {});
      }
    }
    if (!rolledBack) {
      throw new Error(`Commit failed (${commitErr?.message || commitErr}) and rollback could not be completed.`);
    }
    // Only remove RESTORE_FENCE_KEY once rollback has successfully recovered original profile!
    if (kvRemove && typeof kvGet === "function") {
      try {
        const cur = await kvGet(RESTORE_CLAIM_KEY);
        if (cur?.[RESTORE_CLAIM_KEY]?.sessionId === restoreSessionId) {
          await kvRemove([RESTORE_CLAIM_KEY, RESTORE_FENCE_KEY, RESTORE_HEARTBEAT_KEY]);
          if (alarms && typeof alarms.clear === "function") {
            try { await alarms.clear(RESTORE_RECOVERY_ALARM); } catch { /* ignore alarm clear */ }
          }
        }
      } catch { /* ignore coordination keys cleanup error */ }
    }
    throw new Error(`Commit failed (${commitErr?.message || commitErr}); profile rolled back to original state.`);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }

  // Post-commit cache invalidation runs AFTER commit and BEFORE releasing the admission fence.
  // Invalidation failure keeps the fence up so no run can execute against stale in-memory worker caches.
  if (typeof postCommit === "function") {
    try {
      await postCommit();
    } catch (postErr) {
      throw new Error(`Profile restore committed successfully, but cache invalidation failed: ${postErr?.message || postErr}. Reload storage via chrome://extensions.`);
    }
  } else if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      const invRes = await chrome.runtime.sendMessage({ type: "invalidate-agent" });
      if (invRes && invRes.invalidated === false) {
        throw new Error("Worker reported failure during cache invalidation");
      }
    } catch (postErr) {
      throw new Error(`Profile restore committed successfully, but cache invalidation failed: ${postErr?.message || postErr}. Reload storage via chrome://extensions.`);
    }
  }

  // ONLY AFTER cache invalidation succeeds: release invalidation marker, admission fence, and coordination keys
  if (typeof kvRemove === "function") {
    let coordinationRemoved = false;
    let lastCoordErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await kvRemove([RESTORE_INVALIDATION_KEY, RESTORE_CLAIM_KEY, RESTORE_FENCE_KEY, RESTORE_HEARTBEAT_KEY]);
        if (typeof kvGet === "function") {
          const check = await kvGet(RESTORE_FENCE_KEY);
          if (!check?.[RESTORE_FENCE_KEY]) {
            coordinationRemoved = true;
            break;
          }
        } else {
          coordinationRemoved = true;
          break;
        }
      } catch (coordErr) {
        lastCoordErr = coordErr;
        await sleep(50);
      }
    }
    if (!coordinationRemoved) {
      throw new Error(`Profile restore committed, but failed to release admission fence (${RESTORE_FENCE_KEY}): ${lastCoordErr?.message || lastCoordErr || "fence verification failed"}. Storage reload required via chrome://extensions.`);
    }

    if (alarms && typeof alarms.clear === "function") {
      try { await alarms.clear(RESTORE_RECOVERY_ALARM); } catch { /* ignore alarm clear */ }
    }
  }

  return {
    ok: true,
    manifest,
    report: { restored: summary },
    restored: summary,
  };
} finally {
  if (restoreHeartbeatTimer) clearInterval(restoreHeartbeatTimer);
  if (!committed && typeof kvGet === "function" && typeof kvRemove === "function") {
    try {
      const cur = await kvGet([RESTORE_CLAIM_KEY, IMPORT_SIDECAR_KEY]);
      if (cur?.[RESTORE_CLAIM_KEY]?.sessionId === restoreSessionId) {
        const keysToRemove = [RESTORE_CLAIM_KEY, RESTORE_HEARTBEAT_KEY];
        // CRITICAL: If an unrecovered rollback journal remains (rollback failed),
        // RETAIN RESTORE_FENCE_KEY so admitDurableRun continues to protect the profile!
        // Only remove RESTORE_FENCE_KEY if no recovery journal is left.
        if (!cur?.[IMPORT_SIDECAR_KEY]) {
          keysToRemove.push(RESTORE_FENCE_KEY);
          if (alarms && typeof alarms.clear === "function") {
            try { await alarms.clear(RESTORE_RECOVERY_ALARM); } catch { /* ignore alarm clear */ }
          }
        }
        await kvRemove(keysToRemove);
      }
    } catch { /* ignore finally coordination keys cleanup error */ }
  }
}
});
}
