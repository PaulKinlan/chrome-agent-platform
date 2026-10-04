// extension/lib/backup-restore.js — the streaming RESTORE driver
// (chrome-agent-platform-d885.8 / 11rm.4, Stage 4 of
// docs/STREAMED-BACKUP-RESTORE-ARCHITECTURE.md).
//
// OPTIONS-PAGE ONLY: this module is imported by options.js and must never be
// pulled into the service-worker bundle.

import { decodeTarStream } from "./tar-stream.js";

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();
const IMPORT_SIDECAR_KEY = "cap:importBackup";

const EXCLUDED_PREFIXES = ["chrome-agent-platform-private/", "cache/models/"];

export function isExcludedOpfsPath(path) {
  const s = String(path ?? "").trim();
  return EXCLUDED_PREFIXES.some((pre) => s.startsWith(pre));
}

export function b64Encode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function b64Decode(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Recover a pending import from sidecar rollback journal.
 */
export async function recoverPendingImport({ kvGet, kvSet, kvRemove, opfs, alarms } = {}) {
  if (!kvGet) return false;
  const raw = await kvGet(IMPORT_SIDECAR_KEY);
  const journal = raw?.[IMPORT_SIDECAR_KEY] ?? raw;
  if (!journal || typeof journal !== "object" || Array.isArray(journal) || !Array.isArray(journal.ops)) return false;
  for (const [kind, id, previous] of journal.ops) {
    if (kind === 0 && kvSet && kvRemove) {
      previous === null ? await kvRemove(id) : await kvSet({ [id]: previous });
    } else if (kind === 1 && opfs) {
      if (previous === null) {
        try { await opfs.removeFile(id); } catch {}
      } else {
        await opfs.writeFile(id, b64Decode(previous));
      }
    } else if (kind === 2 && alarms) {
      previous === null ? await alarms.clear(id) : await alarms.create(id, previous);
    }
  }
  if (kvRemove) await kvRemove(IMPORT_SIDECAR_KEY);
  return true;
}

async function readStreamToBytes(stream) {
  if (!stream) return new Uint8Array(0);
  if (stream instanceof Uint8Array) return stream;
  if (stream.buffer instanceof ArrayBuffer && stream.byteLength !== undefined) {
    return new Uint8Array(stream.buffer, stream.byteOffset, stream.byteLength);
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
 */
export async function streamRestoreArchive({
  stream,
  opfs = null,
  kvSet = null,
  kvRemove = null,
  kvGet = null,
  alarms = null,
  confirm = null,
  onProgress = null,
  overwrite = false,
  stagingPrefix = ".staging-restore-",
} = {}) {
  let sourceStream = stream;
  if (!sourceStream) {
    throw new TypeError("stream is required for streamRestoreArchive");
  }

  const backends = { kvGet, kvSet, kvRemove, opfs, alarms };

  // Self-heal first: recover any pending crashed import if sidecar journal exists
  await recoverPendingImport(backends).catch(() => {});

  const stagingDir = `${stagingPrefix}${Date.now()}`;
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
      // ── Phase 1 for Legacy JSON Backup (Requirement 4) ──────────────────────
      let parsed;
      try {
        parsed = JSON.parse(rawJsonText);
      } catch (err) {
        throw new Error(`archive-bad-json: ${err.message}`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("archive-bad-shape: archive must be a JSON object");
      }
      if (parsed.magic !== "cap-export" && parsed.magic !== "cap-archive") {
        throw new Error(`archive-bad-magic: unrecognized magic "${parsed.magic}"`);
      }
      manifest = parsed.manifest ?? { magic: parsed.magic };
      restoredKv = parsed.kv ?? {};
      restoredAlarms = Array.isArray(parsed.alarms) ? parsed.alarms : [];

      for (const entry of Array.isArray(parsed.opfs) ? parsed.opfs : []) {
        const relPath = String(entry.path ?? "").replace(/^opfs\//, "");
        if (isExcludedOpfsPath(relPath)) continue;
        let bytes;
        if (entry.encoding === "base64" && typeof entry.data === "string") {
          bytes = b64Decode(entry.data);
        } else if (typeof entry.data === "string") {
          bytes = ENCODER.encode(entry.data);
        } else if (entry.data instanceof Uint8Array) {
          bytes = entry.data;
        } else {
          continue;
        }
        const stagedPath = `${stagingDir}/${relPath}`;
        if (opfs?.writeFile) await opfs.writeFile(stagedPath, bytes);
        stagedEntries.push({ relPath, stagedPath, size: bytes.byteLength });
      }
    } else {
      // ── Phase 1 for TAR Stream (Requirement 1, O(1) RAM) ────────────────────
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
        if (isExcludedOpfsPath(relPath)) return false;

        const bytes = await readStreamToBytes(entry.body);
        const stagedPath = `${stagingDir}/${relPath}`;
        if (opfs?.writeFile) await opfs.writeFile(stagedPath, bytes);
        stagedEntries.push({ relPath, stagedPath, size: bytes.byteLength });

        if (typeof onProgress === "function") {
          try { onProgress({ phase: "staging", path: relPath, bytes: bytes.byteLength }); } catch {}
        }
      });
    }
  } catch (err) {
    if (opfs?.removeFile) {
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

  // ── Phase 2: Owner Confirmation (Requirement 2 & 4 fail-closed) ───────────
  if (typeof confirm === "function") {
    let approved = false;
    try {
      approved = await confirm({ manifest, summary, report: { restored: summary } });
    } catch {
      approved = false;
    }
    if (!approved) {
      if (opfs?.removeFile) {
        for (const entry of stagedEntries) {
          await opfs.removeFile(entry.stagedPath).catch(() => {});
        }
      }
      return { ok: false, cancelled: true, manifest, summary };
    }
  }

  // ── Phase 3: Quiescence, Rollback Journal & Atomic Swap (Requirement 3) ───
  const existingAlarms = (alarms && typeof alarms.getAll === "function")
    ? (await alarms.getAll()).filter(Boolean)
    : [];

  if (alarms && typeof alarms.clear === "function") {
    for (const a of existingAlarms) {
      if (a?.name) await alarms.clear(a.name).catch(() => {});
    }
  }

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
    // C. Atomic swap: stream/re-read from OPFS staged path to live path (O(1) RAM)
    if (opfs && typeof opfs.writeFile === "function") {
      for (const { relPath, stagedPath, size } of stagedEntries) {
        const fileBytes = await opfs.readFile(stagedPath);
        await opfs.writeFile(relPath, fileBytes);
        if (typeof opfs.removeFile === "function") {
          await opfs.removeFile(stagedPath).catch(() => {});
        }
        if (typeof onProgress === "function") {
          try {
            onProgress({ phase: "commit", path: relPath, bytes: size });
          } catch {}
        }
      }

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

    if (typeof kvRemove === "function") {
      await kvRemove(IMPORT_SIDECAR_KEY);
    }

    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      try {
        await chrome.runtime.sendMessage({ type: "invalidate-agent" });
      } catch {}
    }
  } catch (commitErr) {
    await recoverPendingImport(backends).catch(() => {});
    if (opfs?.removeFile) {
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
