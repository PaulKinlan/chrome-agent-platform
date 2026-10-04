// extension/lib/backup-restore.js — the streaming RESTORE driver
// (chrome-agent-platform-d885.8 / 11rm.4, Stage 4 of
// docs/STREAMED-BACKUP-RESTORE-ARCHITECTURE.md).
//
// OPTIONS-PAGE ONLY: this module is imported by options.js and must never be
// pulled into the service-worker bundle.

import { decodeTarStream } from "./tar-stream.js";
import {
  createOpfsAdapter,
  createChromeAlarmsAdapter,
  isExcludedOpfsPath,
  importArchive,
  recoverPendingImport,
  b64Encode,
} from "./data-archive.js";

const DECODER = new TextDecoder("utf-8", { fatal: true });
const IMPORT_SIDECAR_KEY = "cap:importBackup";

async function readStreamToBytes(stream) {
  if (!stream) return new Uint8Array(0);
  if (stream instanceof Uint8Array) return stream;
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

/** Check if leading bytes represent a JSON object (skipping optional whitespace). */
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
 * Stream-restore a profile from a TAR archive byte stream with three-phase
 * transactional safety (staging -> confirmation -> commit with rollback journal)
 * and legacy cap-export JSON fallback.
 *
 * @param {object} opts
 * @param {ReadableStream<Uint8Array> | Blob | File | string} opts.stream — the source byte stream, file, or JSON string.
 * @param {object} [opts.opfs] — OPFS adapter or root handle.
 * @param {Function} [opts.kvSet] — (items) => Promise<void>.
 * @param {Function} [opts.kvRemove] — (keys) => Promise<void>.
 * @param {Function} [opts.kvGet] — (key) => Promise<object>.
 * @param {object} [opts.alarms] — chrome.alarms adapter { create, clear, getAll }.
 * @param {Function} [opts.confirm] — async ({ manifest, summary, report }) => Promise<boolean>.
 * @param {Function} [opts.onProgress] — ({ phase, path, bytes }) => void.
 * @param {boolean} [opts.overwrite] — whether to replace / prune existing data.
 * @param {string} [opts.stagingPrefix] — prefix for temporary staging directory.
 * @returns {Promise<{ ok: boolean, cancelled?: boolean, manifest?: object, report?: { restored: object }, restored?: object }>}
 */
export async function streamRestoreArchive({
  stream,
  opfs: customOpfs = null,
  kvSet: customKvSet = null,
  kvRemove: customKvRemove = null,
  kvGet: customKvGet = null,
  alarms: customAlarms = null,
  confirm = null,
  onProgress = null,
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

  // Self-heal first: recover any pending crashed import if sidecar journal exists
  await recoverPendingImport(backends).catch(() => {});

  // ── Format detection: Legacy JSON fallback (Requirement 4) ──────────────
  let isJson = false;
  let rawJsonText = null;

  if (typeof sourceStream === "string") {
    isJson = isJsonBytes(new TextEncoder().encode(sourceStream.slice(0, 32)));
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

  if (isJson && rawJsonText) {
    if (typeof confirm === "function") {
      try {
        const parsed = JSON.parse(rawJsonText);
        const approved = await confirm({
          manifest: parsed.manifest,
          summary: {
            opfsFiles: parsed.opfs?.length ?? 0,
            kvKeys: Object.keys(parsed.kv ?? {}).length,
            alarms: parsed.alarms?.length ?? 0,
          },
        });
        if (!approved) {
          return { ok: false, cancelled: true };
        }
      } catch {}
    }
    return await importArchive(rawJsonText, { ...backends, overwrite });
  }

  // ── Phase 1: Staging Directory Extraction (Requirement 1) ───────────────
  const stagingDir = `${stagingPrefix}${Date.now()}`;
  let manifest = null;
  let restoredKv = null;
  let restoredAlarms = null;
  const stagedEntries = []; // { relPath, stagedPath, bytes }

  try {
    await decodeTarStream(sourceStream, async (entry) => {
      if (entry.typeflag === "5") {
        return; // directory entry; no body
      }

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

      // OPFS file entry: extract into staging directory
      const relPath = entry.name.replace(/^opfs\//, "");
      if (isExcludedOpfsPath(relPath)) {
        return false;
      }

      const bytes = await readStreamToBytes(entry.body);
      const stagedPath = `${stagingDir}/${relPath}`;
      if (opfs && typeof opfs.writeFile === "function") {
        await opfs.writeFile(stagedPath, bytes);
      }
      stagedEntries.push({ relPath, stagedPath, bytes });

      if (typeof onProgress === "function") {
        try {
          onProgress({ phase: "staging", path: relPath, bytes: bytes.byteLength });
        } catch {}
      }
    });
  } catch (err) {
    // Error during extraction: clean up staging directory and fail closed
    if (opfs && typeof opfs.removeFile === "function") {
      for (const entry of stagedEntries) {
        await opfs.removeFile(entry.stagedPath).catch(() => {});
      }
    }
    throw err;
  }

  const summary = {
    opfsFiles: stagedEntries.length,
    kvKeys: restoredKv ? Object.keys(restoredKv).length : 0,
    alarms: Array.isArray(restoredAlarms) ? restoredAlarms.length : 0,
  };

  // ── Phase 2: Owner Confirmation (Requirement 2) ──────────────────────────
  if (typeof confirm === "function") {
    let approved = false;
    try {
      approved = await confirm({ manifest, summary, report: { restored: summary } });
    } catch {
      approved = false;
    }
    if (!approved) {
      if (opfs && typeof opfs.removeFile === "function") {
        for (const entry of stagedEntries) {
          await opfs.removeFile(entry.stagedPath).catch(() => {});
        }
      }
      return { ok: false, cancelled: true, manifest, summary };
    }
  }

  // ── Phase 3: Quiescence, Rollback Journal & Atomic Swap (Requirement 3) ──
  // A. Suspend active alarms during swap
  const existingAlarms = (alarms && typeof alarms.getAll === "function")
    ? (await alarms.getAll()).filter(Boolean)
    : [];

  if (alarms && typeof alarms.clear === "function") {
    for (const a of existingAlarms) {
      if (a?.name) await alarms.clear(a.name).catch(() => {});
    }
  }

  // B. Construct rollback journal
  const existingFiles = (opfs && typeof opfs.listFiles === "function")
    ? (await opfs.listFiles()).filter((p) => !isExcludedOpfsPath(p) && !p.startsWith(stagingDir))
    : [];
  const existingFilesSet = new Set(existingFiles);
  const existingKv = (kvGet ? await kvGet(null) : {}) || {};

  const journalOps = [];

  // 1. Journal KV operations
  if (restoredKv) {
    for (const k of Object.keys(restoredKv)) {
      journalOps.push([0, k, Object.hasOwn(existingKv, k) ? existingKv[k] : null]);
    }
    if (overwrite) {
      for (const k of Object.keys(existingKv)) {
        if (!Object.hasOwn(restoredKv, k) && k !== IMPORT_SIDECAR_KEY) {
          journalOps.push([0, k, existingKv[k]]);
        }
      }
    }
  }

  // 2. Journal File operations
  for (const { relPath } of stagedEntries) {
    if (existingFilesSet.has(relPath) && opfs?.readFile) {
      try {
        const oldBytes = await opfs.readFile(relPath);
        journalOps.push([1, relPath, b64Encode(oldBytes)]);
      } catch {
        journalOps.push([1, relPath, null]);
      }
    } else {
      journalOps.push([1, relPath, null]);
    }
  }

  if (overwrite && opfs?.readFile) {
    const stagedRelSet = new Set(stagedEntries.map((e) => e.relPath));
    for (const oldFile of existingFiles) {
      if (!stagedRelSet.has(oldFile)) {
        try {
          const oldBytes = await opfs.readFile(oldFile);
          journalOps.push([1, oldFile, b64Encode(oldBytes)]);
        } catch {}
      }
    }
  }

  // 3. Journal Alarms
  for (const a of existingAlarms) {
    if (a?.name) {
      journalOps.push([2, a.name, { scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes }]);
    }
  }

  // Persist sidecar rollback journal before any destination mutation
  if (kvSet && journalOps.length > 0) {
    await kvSet({ [IMPORT_SIDECAR_KEY]: { ops: journalOps, timestamp: Date.now() } });
  }

  try {
    // C. Atomic swap: move files from staging into live OPFS paths
    if (opfs && typeof opfs.writeFile === "function") {
      for (const { relPath, stagedPath, bytes } of stagedEntries) {
        await opfs.writeFile(relPath, bytes);
        if (typeof opfs.removeFile === "function") {
          await opfs.removeFile(stagedPath).catch(() => {});
        }
        if (typeof onProgress === "function") {
          try {
            onProgress({ phase: "commit", path: relPath, bytes: bytes.byteLength });
          } catch {}
        }
      }

      // If overwrite, prune files not in the archive
      if (overwrite && typeof opfs.removeFile === "function") {
        const stagedRelSet = new Set(stagedEntries.map((e) => e.relPath));
        for (const oldFile of existingFiles) {
          if (!stagedRelSet.has(oldFile)) {
            await opfs.removeFile(oldFile).catch(() => {});
          }
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
          (k) => !Object.hasOwn(restoredKv, k) && k !== IMPORT_SIDECAR_KEY,
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

    // Successful commit: delete rollback journal
    if (typeof kvRemove === "function") {
      await kvRemove(IMPORT_SIDECAR_KEY);
    }

    // Invalidate service worker agent caches (zero-SW-byte design)
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        await chrome.runtime.sendMessage({ type: "invalidate-agent" });
      } catch {}
    }
  } catch (commitErr) {
    // Commit failure: trigger automatic rollback from sidecar journal
    await recoverPendingImport(backends).catch(() => {});
    if (opfs && typeof opfs.removeFile === "function") {
      for (const entry of stagedEntries) {
        await opfs.removeFile(entry.stagedPath).catch(() => {});
      }
    }
    throw commitErr;
  }

  return {
    ok: true,
    manifest,
    report: { restored: summary },
    restored: summary,
  };
}
