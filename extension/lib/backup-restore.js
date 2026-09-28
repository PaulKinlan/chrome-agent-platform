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
} from "./data-archive.js";

const DECODER = new TextDecoder("utf-8", { fatal: true });

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

/**
 * Stream-restore a profile from a TAR archive byte stream.
 *
 * @param {object} opts
 * @param {ReadableStream<Uint8Array> | Blob | File} opts.stream — the source byte stream.
 * @param {object} [opts.opfs] — OPFS adapter or root handle.
 * @param {Function} [opts.kvSet] — (items) => Promise<void>.
 * @param {Function} [opts.kvRemove] — (keys) => Promise<void>.
 * @param {Function} [opts.kvGet] — (key) => Promise<object>.
 * @param {object} [opts.alarms] — chrome.alarms adapter { create, clear, getAll }.
 * @param {Function} [opts.onProgress] — ({ path, bytes }) => void.
 * @param {boolean} [opts.overwrite] — whether to replace / prune existing data.
 * @returns {Promise<{ ok: boolean, manifest: object, report: { restored: object }, restored: object }>}
 */
export async function streamRestoreArchive({
  stream,
  opfs: customOpfs = null,
  kvSet: customKvSet = null,
  kvRemove: customKvRemove = null,
  kvGet: customKvGet = null,
  alarms: customAlarms = null,
  onProgress = null,
  overwrite = false,
} = {}) {
  let sourceStream = stream;
  if (!sourceStream) {
    throw new TypeError("stream is required for streamRestoreArchive");
  }
  if (typeof sourceStream.stream === "function") {
    sourceStream = sourceStream.stream();
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

  let manifest = null;
  let restoredKv = null;
  let restoredAlarms = null;
  const restoredFiles = [];
  const existingFiles = (opfs && typeof opfs.listFiles === "function")
    ? (await opfs.listFiles()).filter((p) => !isExcludedOpfsPath(p))
    : [];

  await decodeTarStream(sourceStream, async (entry) => {
    if (entry.typeflag === "5") {
      // Directory entry; no payload
      return;
    }

    if (entry.name === "manifest.json") {
      const bytes = await readStreamToBytes(entry.body);
      const text = DECODER.decode(bytes);
      manifest = JSON.parse(text);
      if (manifest?.magic !== "cap-archive" && manifest?.magic !== "cap-export") {
        throw new Error(`Invalid backup archive: unrecognized magic "${manifest?.magic}"`);
      }
      return;
    }

    if (entry.name === "kv.json") {
      const bytes = await readStreamToBytes(entry.body);
      const text = DECODER.decode(bytes);
      restoredKv = JSON.parse(text);
      return;
    }

    if (entry.name === "alarms.json") {
      const bytes = await readStreamToBytes(entry.body);
      const text = DECODER.decode(bytes);
      restoredAlarms = JSON.parse(text);
      return;
    }

    // OPFS file entry
    const relPath = entry.name.replace(/^opfs\//, "");
    if (isExcludedOpfsPath(relPath)) {
      return false; // skip
    }

    const bytes = await readStreamToBytes(entry.body);
    if (opfs && typeof opfs.writeFile === "function") {
      await opfs.writeFile(relPath, bytes);
    }
    restoredFiles.push(relPath);
    if (typeof onProgress === "function") {
      try {
        onProgress({ path: relPath, bytes: bytes.byteLength });
      } catch {
        // progress observer must not fail restore
      }
    }
  });

  // Apply restored KV settings
  if (restoredKv && typeof kvSet === "function") {
    if (Object.keys(restoredKv).length > 0) {
      await kvSet(restoredKv);
    }
    if (overwrite && typeof kvRemove === "function" && typeof kvGet === "function") {
      const currentKv = (await kvGet(null)) || {};
      const keysToRemove = Object.keys(currentKv).filter((k) => !Object.hasOwn(restoredKv, k));
      if (keysToRemove.length > 0) {
        await kvRemove(keysToRemove);
      }
    }
  }

  // Apply restored alarms
  if (Array.isArray(restoredAlarms) && alarms) {
    for (const a of restoredAlarms) {
      if (a?.name && typeof alarms.create === "function") {
        const info = {};
        if (typeof a.scheduledTime === "number") info.when = a.scheduledTime;
        if (typeof a.periodInMinutes === "number") info.periodInMinutes = a.periodInMinutes;
        await alarms.create(a.name, info);
      }
    }
  }

  // Prune pre-existing OPFS files if overwrite is true
  if (overwrite && opfs && typeof opfs.removeFile === "function") {
    const restoredSet = new Set(restoredFiles);
    for (const existing of existingFiles) {
      if (!restoredSet.has(existing)) {
        try {
          await opfs.removeFile(existing);
        } catch {
          // ignore cleanup failures
        }
      }
    }
  }

  const summary = {
    opfsFiles: restoredFiles.length,
    kvKeys: restoredKv ? Object.keys(restoredKv).length : 0,
    alarms: Array.isArray(restoredAlarms) ? restoredAlarms.length : 0,
  };

  return {
    ok: true,
    manifest,
    report: { restored: summary },
    restored: summary,
  };
}
