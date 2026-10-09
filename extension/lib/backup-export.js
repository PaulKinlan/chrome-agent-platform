// extension/lib/backup-export.js — the streaming EXPORT driver
// (chrome-agent-platform-0ymn / 11rm.3, Stage 3 of
// docs/STREAMED-BACKUP-RESTORE-ARCHITECTURE.md).
//
// OPTIONS-PAGE ONLY: this module is imported by options.js and must never be
// pulled into the service-worker bundle (whose budget has ~zero headroom —
// see the architecture doc, §2.3).
//
// It preserves the EXACT content contract of data-archive's collectExportData:
// the same exclusions (isExcludedOpfsPath), the same redacted-target dispatch
// (isManagedRedactedTarget → sanitizeRedactedTargetText, the 8fuc property),
// the same kv sanitization (sanitizeKvForExport) and provider/MCP summaries —
// but writes a standard uncompressed TAR through the landed encodeTarStream
// with CHUNKED payload reads, so nothing is buffered whole and no
// 512 MiB / 100,000-file cap exists or is consulted.

import {
  createOpfsAdapter,
  isExcludedOpfsPath,
  sanitizeKvForExport,
  summarizeMcpServers,
  summarizeProviders,
} from "./data-archive.js";
import { isManagedRedactedTarget, sanitizeRedactedTargetText } from "./logical-site-agent-config.js";
import { encodeTarStream } from "./tar-stream.js";
import { withMasterJournalWebLock } from "./master-journal-lock.js";

const ENCODER = new TextEncoder();

/** Re-chunk a byte stream into at-most `chunkSize` pieces (last one short).
 * Backpressured: chunks are pulled only as the encoder writes them. */
export function rechunk(stream, chunkSize) {
  let reader = null;
  let carry = null;
  return new ReadableStream({
    async pull(controller) {
      try {
        if (!reader) {
          reader = stream.getReader();
        }
        while (true) {
          if (carry) {
            if (carry.byteLength <= chunkSize) {
              const out = carry;
              carry = null;
              controller.enqueue(out);
              return;
            }
            controller.enqueue(carry.subarray(0, chunkSize));
            carry = carry.subarray(chunkSize);
            return;
          }
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          if (!value || value.byteLength === 0) continue;
          if (value.byteLength <= chunkSize) {
            controller.enqueue(value);
            return;
          }
          carry = value;
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) {
      try {
        if (reader) {
          return reader.cancel(reason);
        }
        return stream.cancel(reason);
      } catch {
        // the source may already be gone
      }
    },
  });
}

/** Wrap a body stream with cumulative byte counting + progress reporting.
 * The chunk framing is untouched — counting is a side-effect of the pipe. */
function countedBody(stream, label, onProgress, counter) {
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        counter.bytesSoFar += chunk.byteLength;
        controller.enqueue(chunk);
        if (typeof onProgress === "function") {
          try {
            onProgress({ path: label, fileBytes: chunk.byteLength, bytesSoFar: counter.bytesSoFar });
          } catch {
            // a progress observer must never break the export
          }
        }
      },
    }),
  );
}

/** Wrap an in-memory payload with the same progress accounting as a stream. */
function countedPass(bytes, label, onProgress, counter) {
  counter.bytesSoFar += bytes.length;
  if (typeof onProgress === "function") {
    try {
      onProgress({ path: label, fileBytes: bytes.length, bytesSoFar: counter.bytesSoFar });
    } catch {
      // never break the export on an observer error
    }
  }
  return bytes;
}

/**
 * Stream the profile into a TAR archive on `writable`.
 *
 * @param {object} opts
 * @param {WritableStream<Uint8Array>} opts.writable — the sink (a save-file-picker's writable).
 * @param {() => Promise<string[]>} opts.listFiles — relative OPFS paths (the same list collectExportData walks).
 * @param {(path: string) => Promise<{ size: number, stream: ReadableStream<Uint8Array> }>} opts.open — a chunked byte source per path.
 * @param {(key: null) => Promise<object>} opts.kvGet — chrome.storage.local read (null = whole store).
 * @param {{ getAll: () => Promise<any[]> }} opts.alarms — chrome.alarms adapter.
 * @param {string} [opts.extensionVersion]
 * @param {number} [opts.chunkSize] — payload re-chunk size (default 64 KiB).
 * @param {Function} [opts.onProgress] — { path, fileBytes, bytesSoFar } per chunk.
 * @param {number} [opts.exportedAt] — epoch millis (defaults to now).
 * @returns {Promise<{ files: number, totalBytes: bigint, archiveBytes: bigint }>}
 *
 * The OPFS walk preserves collectExportData's content contract exactly:
 * excluded paths are skipped, managed redacted targets are sanitized IN PLACE
 * through their registered sanitizer (small config documents — bounded), and
 * everything else streams chunked. No 512 MiB / 100,000-file bound exists
 * here, and none is consulted.
 */
export async function streamExportArchive({
  writable,
  listFiles,
  open,
  kvGet,
  alarms,
  extensionVersion = "unknown",
  chunkSize = 64 * 1024,
  onProgress = null,
  exportedAt = null,
}) {
  if (!writable || typeof writable.getWriter !== "function") {
    throw new TypeError("writable must be a WritableStream");
  }

  const rawKv = (await kvGet(null)) || {};
  const kv = sanitizeKvForExport(rawKv);
  const configuredProviders = summarizeProviders(rawKv.providerConfig);
  const mcpServers = summarizeMcpServers(rawKv["cap:mcpServers"]);

  // Classify the tree up front: a TAR header declares the payload size, so
  // every path and size is known before the first byte is written — but the
  // PAYLOADS stay lazy (open() hands back a stream, never whole bytes).
  const paths = (await listFiles()).filter((p) => !isExcludedOpfsPath(p));

  const alarmList = ((await alarms.getAll()) || []).filter((a) => a && typeof a.name === "string").map((a) => {
    const rec = { name: a.name };
    if (typeof a.scheduledTime === "number") rec.scheduledTime = a.scheduledTime;
    if (typeof a.periodInMinutes === "number") rec.periodInMinutes = a.periodInMinutes;
    return rec;
  });

  const counter = { bytesSoFar: 0 };
  const manifest = {
    magic: "cap-archive",
    formatVersion: 2,
    exportedAt: new Date(exportedAt ?? Date.now()).toISOString(),
    extensionVersion,
    policy: { opfsPrefix: "opfs/", redactedTargets: "sanitized in place" },
    configuredProviders,
    mcpServers,
    manifest: {
      kvKeys: Object.keys(kv).length,
      opfsFiles: paths.length,
      alarms: alarmList.length,
    },
  };

  const kvBytes = ENCODER.encode(JSON.stringify(kv));
  const alarmsBytes = ENCODER.encode(JSON.stringify(alarmList));
  const manifestBytes = ENCODER.encode(JSON.stringify(manifest));

  async function* generateEntries() {
    yield {
      name: "manifest.json",
      size: manifestBytes.length,
      body: countedPass(manifestBytes, "manifest.json", onProgress, counter),
    };
    yield {
      name: "kv.json",
      size: kvBytes.length,
      body: countedPass(kvBytes, "kv.json", onProgress, counter),
    };
    yield {
      name: "alarms.json",
      size: alarmsBytes.length,
      body: countedPass(alarmsBytes, "alarms.json", onProgress, counter),
    };

    for (const path of paths) {
      const handle = await open(path);
      if (isManagedRedactedTarget(path)) {
        // Bounded by design: redacted targets are small config JSON documents.
        // The registered sanitizer runs HERE, before any byte can enter the
        // archive (the 8fuc property, inherited from collectExportData).
        const raw = new Uint8Array(await new Response(handle.stream).arrayBuffer());
        const sanitized = sanitizeRedactedTargetText(path, new TextDecoder("utf-8", { fatal: true }).decode(raw));
        const sanitizedBytes = ENCODER.encode(JSON.stringify(sanitized));
        yield {
          name: `opfs/${path}`,
          size: sanitizedBytes.length,
          body: countedPass(sanitizedBytes, `opfs/${path}`, onProgress, counter),
        };
      } else {
        yield {
          name: `opfs/${path}`,
          size: handle.size,
          body: countedBody(rechunk(handle.stream, chunkSize), `opfs/${path}`, onProgress, counter),
        };
      }
    }
  }

  const result = await encodeTarStream(generateEntries(), writable, {});
  return { files: result.files, totalBytes: BigInt(counter.bytesSoFar), archiveBytes: result.archiveBytes };
}

/** One-click owner export driver for Options page — handles File System Access picker
 * and temporary OPFS fallback stream without double-close errors. */
export async function executeOptionsExport({
  storageRoot = null,
  showPicker = typeof window !== "undefined" && typeof window.showSaveFilePicker === "function" ? window.showSaveFilePicker.bind(window) : null,
  createDownloadUrl = (f) => URL.createObjectURL(f),
  revokeDownloadUrl = (u) => URL.revokeObjectURL(u),
  triggerDownload = (url, filename) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
  onStatus = () => {},
  extensionVersion = "unknown",
  kvGet = (key) => chrome.storage.local.get(key ?? null),
  alarms = { getAll: () => chrome.alarms.getAll() },
  lockAcquirer = null,
} = {}) {
  const executeUnderLock = async (fn) => {
    if (typeof lockAcquirer === "function") {
      return await lockAcquirer(fn);
    }
    if (typeof navigator !== "undefined" && navigator?.locks?.request) {
      return await navigator.locks.request("cap:restoreLock", fn);
    }
    return await fn();
  };

  return await executeUnderLock(async () => {
    if (typeof kvGet === "function") {
      const coordination = await kvGet([
        "cap:restoreFence",
        "cap:importBackup",
        "cap:invalidationPending",
      ]);
      if (
        coordination?.["cap:restoreFence"] ||
        coordination?.["cap:importBackup"] ||
        coordination?.["cap:invalidationPending"]
      ) {
        throw new Error(
          "Cannot export profile: a profile restore, rollback, or cache invalidation is currently pending in storage. Wait for recovery or check Settings → Advanced.",
        );
      }
    }

    const root = storageRoot ?? (await navigator.storage.getDirectory());
    const adapter = createOpfsAdapter(root);
    const when = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

    if (typeof showPicker === "function") {
      const handle = await showPicker({
        suggestedName: `cap-backup-${when}.tar`,
        types: [{ description: "CAP backup (TAR)", accept: { "application/x-tar": [".tar"] } }],
      });
      const writable = await handle.createWritable();
      try {
        // The journal writer takes this same cross-context lock. Hold it from
        // inventory through the last streamed byte, but not while the owner is
        // deciding in the save picker. Other profile stores keep their existing
        // (not globally point-in-time) backup semantics.
        const result = await withMasterJournalWebLock(() => streamExportArchive({
          writable,
          listFiles: () => adapter.listFiles(),
          open: (path) => adapter.open(path),
          kvGet,
          alarms,
          extensionVersion,
          onProgress: (p) => onStatus(`Exported ${p.bytesSoFar} bytes…`),
        }));
        onStatus(`Exported ${result.files - 3} stored files, ${result.totalBytes} payload bytes to ${handle.name}. Keep the file safe — it contains your agents' memories.`);
        return result;
      } finally {
        try { await writable.close(); } catch { /* already closed on error */ }
      }
    }

    // ── fallback when showSaveFilePicker is unavailable: stream to an OPFS temp file in Options ──
    const tempName = `.staging-export-${when}.tar`;
    const tempHandle = await root.getFileHandle(tempName, { create: true });
    const writable = await tempHandle.createWritable();
    let downloaded = false;
    try {
      const result = await withMasterJournalWebLock(() => streamExportArchive({
        writable,
        listFiles: () => adapter.listFiles(),
        open: (path) => adapter.open(path),
        kvGet,
        alarms,
        extensionVersion,
        onProgress: (p) => onStatus(`Exported ${p.bytesSoFar} bytes…`),
      }));
      const file = await tempHandle.getFile();
      const url = createDownloadUrl(file);
      triggerDownload(url, `cap-backup-${when}.tar`);
      downloaded = true;
      setTimeout(async () => {
        revokeDownloadUrl(url);
        try { await root.removeEntry(tempName); } catch { /* temp file already cleaned or missing */ }
      }, 10000);
      onStatus(`Exported ${result.files - 3} stored files, ${result.totalBytes} payload bytes. Keep the file safe — it contains your agents' memories.`);
      return result;
    } finally {
      try { await writable.close(); } catch { /* writable stream already closed */ }
      if (!downloaded) {
        try { await root.removeEntry(tempName); } catch { /* temp file already cleaned or missing */ }
      }
    }
  });
}
