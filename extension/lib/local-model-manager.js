// lib/local-model-manager.js — Real, publisher-source OPFS model download,
// incremental streaming SHA-256 verification, chunked install, and user-controlled deletion.
// (CAP-FB-20260819-LOCAL-MODEL-MANAGEMENT-01).
//
// Settled Policy & Engineering Hardening:
//   - Publisher/original-source downloads only (HuggingFace publisher URLs).
//   - Explicit owner-initiated actions only — NO silent network or model actions.
//   - True O(1) streaming incremental SHA-256 hasher (never buffers full file).
//   - Streamed chunk-by-chunk .part -> final promotion (O(1) peak memory).
//   - Strict resume support with prefix-hash continuity and 200-fallback restart.
//   - Storage quota preflight accounting for total payload + largest .part spike.
//   - User-controlled removal only — NO product cap or automatic eviction.

import {
  LOCAL_MODEL_CATALOG,
  isPublisherSourceUrl,
  isTrustedDeliveryUrl,
} from "./local-model-catalog.js";

export const LOCAL_MODEL_STATES = Object.freeze({
  IDLE: "idle",
  PROBING: "probing",
  DOWNLOADING: "downloading",
  VERIFYING: "verifying",
  INSTALLED: "installed",
  ERROR: "error",
});

export const DOWNLOAD_STREAM_CHUNK_BYTES = 64 * 1024; // 64 KiB I/O buffer
const MODELS_DIR_NAME = "models";

function failClosed(code, message = "") {
  const err = new Error(message ? `${code}: ${message}` : code);
  err.code = code;
  return err;
}

/**
 * True incremental streaming SHA-256 hasher with O(1) memory footprint (64 B block buffer).
 * Computes exact standard FIPS 180-4 SHA-256 without memory accumulation.
 */
export class StreamingSha256 {
  constructor() {
    this._h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this._block = new Uint8Array(64);
    this._blockLen = 0;
    this._totalBytes = 0;
    this._w = new Uint32Array(64);
  }

  static K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  _processBlock(block) {
    const w = this._w;
    const K = StreamingSha256.K;
    const view = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (w[i - 15] >>> 7 | w[i - 15] << 25) ^ (w[i - 15] >>> 18 | w[i - 15] << 14) ^ (w[i - 15] >>> 3);
      const s1 = (w[i - 2] >>> 17 | w[i - 2] << 15) ^ (w[i - 2] >>> 19 | w[i - 2] << 13) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this._h[0], b = this._h[1], c = this._h[2], d = this._h[3];
    let e = this._h[4], f = this._h[5], g = this._h[6], h = this._h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this._h[0] = (this._h[0] + a) >>> 0;
    this._h[1] = (this._h[1] + b) >>> 0;
    this._h[2] = (this._h[2] + c) >>> 0;
    this._h[3] = (this._h[3] + d) >>> 0;
    this._h[4] = (this._h[4] + e) >>> 0;
    this._h[5] = (this._h[5] + f) >>> 0;
    this._h[6] = (this._h[6] + g) >>> 0;
    this._h[7] = (this._h[7] + h) >>> 0;
  }

  update(chunk) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this._totalBytes += bytes.byteLength;
    let offset = 0;
    let len = bytes.byteLength;

    if (this._blockLen > 0) {
      const needed = 64 - this._blockLen;
      const copyLen = Math.min(needed, len);
      this._block.set(bytes.subarray(offset, offset + copyLen), this._blockLen);
      this._blockLen += copyLen;
      offset += copyLen;
      len -= copyLen;
      if (this._blockLen === 64) {
        this._processBlock(this._block);
        this._blockLen = 0;
      }
    }

    while (len >= 64) {
      this._processBlock(bytes.subarray(offset, offset + 64));
      offset += 64;
      len -= 64;
    }

    if (len > 0) {
      this._block.set(bytes.subarray(offset, offset + len), this._blockLen);
      this._blockLen += len;
    }
  }

  digestHex() {
    const finalH = new Uint32Array(this._h);
    const finalBlock = new Uint8Array(this._block);
    let finalBlockLen = this._blockLen;
    const totalBits = BigInt(this._totalBytes) * 8n;

    finalBlock[finalBlockLen++] = 0x80;

    if (finalBlockLen > 56) {
      finalBlock.fill(0, finalBlockLen, 64);
      this._processBlock(finalBlock);
      finalBlock.fill(0, 0, 64);
      finalBlockLen = 0;
    } else {
      finalBlock.fill(0, finalBlockLen, 56);
    }

    const view = new DataView(finalBlock.buffer, finalBlock.byteOffset, 64);
    view.setBigUint64(56, totalBits, false);
    this._processBlock(finalBlock);

    const out = [];
    for (let i = 0; i < 8; i++) {
      out.push(this._h[i].toString(16).padStart(8, "0"));
    }

    this._h.set(finalH);
    this._block.set(finalBlock);
    this._blockLen = finalBlockLen;

    return out.join("");
  }
}

/**
 * Get or create the root directory handle for OPFS models storage.
 */
export async function getModelsOpfsRoot(customRoot = null) {
  if (customRoot) return customRoot;
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    throw failClosed("opfs_unavailable", "Origin Private File System is not supported in this environment.");
  }
  const root = await navigator.storage.getDirectory();
  const modelsDir = await root.getDirectoryHandle(MODELS_DIR_NAME, { create: true });
  return modelsDir;
}

/**
 * Find a model specification by ID from the catalog.
 */
export function getCatalogModel(modelId, catalog = LOCAL_MODEL_CATALOG) {
  return catalog.find((m) => m.id === modelId) ?? null;
}

/**
 * Check if a model is installed in OPFS and read its manifest.
 */
export async function getInstalledModelRecord(modelId, { opfsRoot = null, catalog = LOCAL_MODEL_CATALOG } = {}) {
  const model = getCatalogModel(modelId, catalog);
  if (!model) return null;

  try {
    const root = await getModelsOpfsRoot(opfsRoot);
    const modelDir = await root.getDirectoryHandle(modelId, { create: false });
    const manifestHandle = await modelDir.getFileHandle("manifest.json", { create: false });
    const file = await manifestHandle.getFile();
    const text = await file.text();
    const manifest = JSON.parse(text);
    return Object.freeze({
      ...manifest,
      model,
      installed: true,
    });
  } catch {
    return null;
  }
}

/**
 * List all installed models in OPFS.
 */
export async function listInstalledModels({ opfsRoot = null, catalog = LOCAL_MODEL_CATALOG } = {}) {
  try {
    const root = await getModelsOpfsRoot(opfsRoot);
    const installed = [];
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== "directory") continue;
      const rec = await getInstalledModelRecord(name, { opfsRoot: root, catalog });
      if (rec) installed.push(rec);
    }
    return Object.freeze(installed);
  } catch {
    return Object.freeze([]);
  }
}

/**
 * Download a single model file with Range header resume and streaming SHA-256 verification.
 */
async function downloadSingleFile({
  fileSpec,
  targetDirHandle,
  onProgress = null,
  signal = null,
  fetchImpl = globalThis.fetch,
}) {
  if (!isPublisherSourceUrl(fileSpec.url)) {
    throw failClosed("invalid_source_url", `Rejected non-publisher URL: ${fileSpec.url}`);
  }

  // 1. Check if target file already exists and matches expected size + hash
  try {
    const existingFileHandle = await targetDirHandle.getFileHandle(fileSpec.name, { create: false });
    const existingFile = await existingFileHandle.getFile();
    if (existingFile.size === fileSpec.bytes) {
      const hasher = new StreamingSha256();
      const reader = existingFile.stream().getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
      }
      const existingHash = hasher.digestHex();
      if (existingHash === fileSpec.sha256) {
        onProgress?.({
          fileName: fileSpec.name,
          loadedBytes: fileSpec.bytes,
          totalBytes: fileSpec.bytes,
          percent: 100,
          phase: "verified-existing",
        });
        return { ok: true, name: fileSpec.name, size: fileSpec.bytes, sha256: existingHash };
      }
    }
  } catch {
    // Proceed with download
  }

  // 2. Prepare .part file and resume range if present
  const partFileName = `${fileSpec.name}.part`;
  const partFileHandle = await targetDirHandle.getFileHandle(partFileName, { create: true });

  let startByte = 0;
  try {
    const partFile = await partFileHandle.getFile();
    startByte = partFile.size;
  } catch {}

  if (startByte >= fileSpec.bytes) {
    startByte = 0;
  }

  const headers = {};
  if (startByte > 0) {
    headers["Range"] = `bytes=${startByte}-${fileSpec.bytes - 1}`;
  }

  const response = await fetchImpl(fileSpec.url, {
    method: "GET",
    headers,
    credentials: "omit",
    redirect: "follow",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal,
  });

  // Strict Final URL check (Nit N1): response.url must directly pass allowlist
  if (!isTrustedDeliveryUrl(response.url)) {
    throw failClosed("untrusted_delivery_url", "Download response URL left the publisher delivery allowlist.");
  }

  // If server replied 200 instead of requested 206 Range, restart from byte 0
  if (startByte > 0 && response.status === 200) {
    startByte = 0;
  } else if (startByte > 0 && response.status !== 206) {
    throw failClosed("range_request_failed", `Expected HTTP 206 for range download; received ${response.status}.`);
  } else if (startByte === 0 && response.status !== 200 && response.status !== 206) {
    throw failClosed("download_failed", `Expected HTTP 200/206 from publisher; received ${response.status}.`);
  }

  let writableStream = null;
  if (partFileHandle.createWritable) {
    writableStream = await partFileHandle.createWritable({ keepExistingData: startByte > 0 });
    if (startByte > 0 && writableStream.seek) {
      await writableStream.seek(startByte);
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw failClosed("stream_unavailable", "Response body is not a readable stream.");
  }

  let downloadedBytes = startByte;
  let hasher = new StreamingSha256();

  // If resuming, hash existing partial prefix bytes in 64 KiB chunks (O(1) memory)
  if (startByte > 0) {
    const partFile = await partFileHandle.getFile();
    const existingReader = partFile.slice(0, startByte).stream().getReader();
    while (true) {
      const { done, value } = await existingReader.read();
      if (done) break;
      hasher.update(value);
    }
  }

  try {
    while (true) {
      if (signal?.aborted) {
        throw failClosed("download_aborted", signal.reason ?? "Download aborted by user.");
      }

      const { done, value } = await reader.read();
      if (done) break;

      hasher.update(value);
      downloadedBytes += value.byteLength;

      if (writableStream) {
        await writableStream.write(value);
      }

      onProgress?.({
        fileName: fileSpec.name,
        loadedBytes: downloadedBytes,
        totalBytes: fileSpec.bytes,
        percent: Math.min(100, (downloadedBytes / fileSpec.bytes) * 100),
        phase: "downloading",
      });
    }

    if (writableStream) {
      await writableStream.close();
    }
  } catch (err) {
    if (writableStream) {
      await writableStream.abort().catch(() => {});
    }
    throw err;
  }

  if (downloadedBytes !== fileSpec.bytes) {
    throw failClosed("size_mismatch", `Expected ${fileSpec.bytes} bytes, received ${downloadedBytes} bytes.`);
  }

  onProgress?.({
    fileName: fileSpec.name,
    loadedBytes: downloadedBytes,
    totalBytes: fileSpec.bytes,
    percent: 100,
    phase: "verifying",
  });

  const computedHash = hasher.digestHex();
  if (computedHash !== fileSpec.sha256) {
    await targetDirHandle.removeEntry(partFileName).catch(() => {});
    throw failClosed("integrity_mismatch", `SHA-256 mismatch for ${fileSpec.name}: expected ${fileSpec.sha256}, got ${computedHash}`);
  }

  // 3. Streamed chunk-by-chunk copy from .part to final file (O(1) peak memory; Blocker B1)
  const partFileObj = await partFileHandle.getFile();
  const finalFileHandle = await targetDirHandle.getFileHandle(fileSpec.name, { create: true });
  if (finalFileHandle.createWritable) {
    const finalWritable = await finalFileHandle.createWritable();
    const copyReader = partFileObj.stream().getReader();
    try {
      while (true) {
        const { done, value } = await copyReader.read();
        if (done) break;
        await finalWritable.write(value);
      }
      await finalWritable.close();
    } catch (copyErr) {
      await finalWritable.abort().catch(() => {});
      throw copyErr;
    }
  }
  await targetDirHandle.removeEntry(partFileName).catch(() => {});

  return {
    ok: true,
    name: fileSpec.name,
    size: downloadedBytes,
    sha256: computedHash,
  };
}

/**
 * Main explicit download orchestrator for a local model.
 */
export async function downloadLocalModel({
  modelId,
  opfsRoot = null,
  catalog = LOCAL_MODEL_CATALOG,
  onProgress = null,
  signal = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const model = getCatalogModel(modelId, catalog);
  if (!model) {
    throw failClosed("unknown_model", `Model "${modelId}" is not in the product catalog.`);
  }

  // Quota Preflight (Nit N4): model total bytes + largest temporary .part spike
  const totalModelBytes = model.installedBytes;
  const largestFileBytes = Math.max(...model.files.map((f) => f.bytes), 0);
  const requiredQuotaBytes = totalModelBytes + largestFileBytes;

  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)) {
        const available = Math.max(0, estimate.quota - estimate.usage);
        if (available < requiredQuotaBytes) {
          throw failClosed(
            "insufficient_storage",
            `Available browser storage (${(available / (1024 * 1024 * 1024)).toFixed(2)} GiB) is below the required payload + staging capacity (${(requiredQuotaBytes / (1024 * 1024 * 1024)).toFixed(2)} GiB).`,
          );
        }
      }
    } catch (e) {
      if (e.code === "insufficient_storage") throw e;
    }
  }

  const root = await getModelsOpfsRoot(opfsRoot);
  const modelDirHandle = await root.getDirectoryHandle(modelId, { create: true });

  let accumulatedBytes = 0;
  const verifiedFiles = [];

  for (let i = 0; i < model.files.length; i++) {
    const fileSpec = model.files[i];

    const fileResult = await downloadSingleFile({
      fileSpec,
      targetDirHandle: modelDirHandle,
      onProgress: (p) => {
        const overallLoaded = accumulatedBytes + (p.loadedBytes || 0);
        const overallPercent = Math.min(100, (overallLoaded / totalModelBytes) * 100);
        onProgress?.({
          modelId,
          modelName: model.name,
          fileIndex: i + 1,
          totalFiles: model.files.length,
          fileName: fileSpec.name,
          filePercent: p.percent,
          loadedBytes: overallLoaded,
          totalBytes: totalModelBytes,
          percent: overallPercent,
          phase: p.phase,
        });
      },
      signal,
      fetchImpl,
    });

    accumulatedBytes += fileSpec.bytes;
    verifiedFiles.push(fileResult);
  }

  const manifest = {
    schemaVersion: 1,
    id: model.id,
    name: model.name,
    publisher: model.publisher,
    license: model.license,
    repo: model.repo,
    revision: model.revision,
    installedBytes: totalModelBytes,
    installedGiB: model.installedGiB,
    files: verifiedFiles,
    installedAt: Date.now(),
    integrityVerified: true,
    status: "installed",
  };

  const manifestHandle = await modelDirHandle.getFileHandle("manifest.json", { create: true });
  if (manifestHandle.createWritable) {
    const writer = await manifestHandle.createWritable();
    await writer.write(new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"));
    await writer.close();
  }

  onProgress?.({
    modelId,
    modelName: model.name,
    percent: 100,
    loadedBytes: totalModelBytes,
    totalBytes: totalModelBytes,
    phase: "installed",
  });

  return Object.freeze({
    ok: true,
    modelId,
    manifest,
  });
}

/**
 * User-controlled model removal / deletion.
 */
export async function deleteLocalModel({
  modelId,
  opfsRoot = null,
} = {}) {
  const root = await getModelsOpfsRoot(opfsRoot);
  try {
    await root.removeEntry(modelId, { recursive: true });
    return { ok: true, modelId, deleted: true };
  } catch (err) {
    if (err.name === "NotFoundError" || err.code === "ENOENT") {
      return { ok: true, modelId, deleted: false };
    }
    throw failClosed("delete_failed", `Failed to remove model directory for "${modelId}": ${err.message}`);
  }
}

/**
 * Verify integrity of an already-installed model against catalog hashes using streaming chunk reads.
 */
export async function verifyModelIntegrity({
  modelId,
  opfsRoot = null,
  catalog = LOCAL_MODEL_CATALOG,
} = {}) {
  const model = getCatalogModel(modelId, catalog);
  if (!model) return { ok: false, error: "unknown_model" };

  try {
    const root = await getModelsOpfsRoot(opfsRoot);
    const modelDir = await root.getDirectoryHandle(modelId, { create: false });

    for (const fileSpec of model.files) {
      const fileHandle = await modelDir.getFileHandle(fileSpec.name, { create: false });
      const file = await fileHandle.getFile();
      if (file.size !== fileSpec.bytes) {
        return { ok: false, error: `size_mismatch for ${fileSpec.name}` };
      }
      const hasher = new StreamingSha256();
      const reader = file.stream().getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
      }
      const hash = hasher.digestHex();
      if (hash !== fileSpec.sha256) {
        return { ok: false, error: `hash_mismatch for ${fileSpec.name}` };
      }
    }

    return { ok: true, modelId, integrityVerified: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Unified LocalModelManager facade for OPFS model management and inference lifecycle.
 */
export class LocalModelManager {
  constructor({ rootDir = null } = {}) {
    this._rootDir = rootDir;
  }

  async isModelInstalled(modelId) {
    try {
      const root = await getModelsOpfsRoot(this._rootDir);
      const modelDir = await root.getDirectoryHandle(modelId, { create: false });
      const manifestHandle = await modelDir.getFileHandle("manifest.json", { create: false });
      const file = await manifestHandle.getFile();
      return file.size > 0;
    } catch {
      return false;
    }
  }

  async getModelManifest(modelId) {
    try {
      const root = await getModelsOpfsRoot(this._rootDir);
      const modelDir = await root.getDirectoryHandle(modelId, { create: false });
      const manifestHandle = await modelDir.getFileHandle("manifest.json", { create: false });
      const file = await manifestHandle.getFile();
      const text = await file.text();
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async downloadModel({ modelId, onProgress = null, signal = null, fetchFn = null, fetchImpl = null } = {}) {
    return await downloadLocalModel({
      modelId,
      opfsRoot: this._rootDir,
      onProgress,
      signal,
      fetchImpl: fetchImpl || fetchFn || globalThis.fetch,
    });
  }

  async deleteModel({ modelId } = {}) {
    return await deleteLocalModel({
      modelId,
      opfsRoot: this._rootDir,
    });
  }

  async verifyIntegrity({ modelId } = {}) {
    return await verifyModelIntegrity({
      modelId,
      opfsRoot: this._rootDir,
    });
  }
}

