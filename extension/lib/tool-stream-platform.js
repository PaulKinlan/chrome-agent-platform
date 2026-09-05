// lib/tool-stream-platform.js — Platform streaming I/O and artifact promotion layer.
// CAP-FB-20260822-WASM-TOOL-PLATFORM-01 (Pillar 1: Streamed I/O + Artifact Promotion).
//
// This module provides the unified platform contracts that wrap and connect:
//   1. Task attachments & OPFS artifacts → sealed stream inputs (inputRef)
//   2. Stream chaining → passing step 1's output.ref directly as step 2's inputRef
//   3. Automatic artifact promotion → over-threshold outputs promote to permanent OPFS assets
//   4. Quota and abuse enforcement → bounded timeouts, active stream limits, and fail-closed cleanup

import {
  createWasmStreamInput,
  appendWasmStreamInput,
  sealWasmStreamInput,
  validateWasmStreamRef,
  validateSealedWasmStream,
  readWasmStreamWindow,
  discardWasmStream,
  removeWasmStream,
  listWasmStreamEntries,
} from "./wasm-stream-files.js";
import { decodeCanonicalBase64 } from "./wasm-base64.js";
import { createAssetKeyed } from "./artifacts.js";

export const STREAM_PLATFORM_LIMITS = Object.freeze({
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 180_000,
  inlineThresholdBytes: 64 * 1024, // 64 KiB inline preview ceiling
  maxActiveStreamsPerRun: 32,
  maxStreamNameBytes: 256,
});

function fail(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  throw error;
}

/**
 * Validate that a stream reference is structurally sound and can be chained
 * as an input to a downstream tool.
 */
export function validateStreamChaining(ref) {
  const validated = validateWasmStreamRef(ref, { kinds: ["input", "stdout"] });
  return Object.freeze({
    valid: true,
    ref: validated,
    chainable: true,
  });
}

/**
 * Stage a conversation turn attachment into a sealed OPFS stream input.
 * Accepts text, code, json, csv, and binary/media attachments with dataURLs.
 * Rejects host filesystem grants (local-folder) to ensure isolation.
 */
export async function stageAttachmentAsWasmStream(attachment, { owner, storage } = {}) {
  if (!attachment || typeof attachment !== "object") {
    fail("invalid_attachment", "attachment must be an object");
  }
  if (attachment.kind === "local-folder") {
    fail("unsupported_grant", "local folder grants are host-only and cannot be staged to Wasm streams");
  }

  const name = String(attachment.name ?? "attachment.bin");
  const inputRef = await createWasmStreamInput({ owner, storage });
  let totalBytes = 0;

  try {
    if (typeof attachment.dataURL === "string" && attachment.dataURL.startsWith("data:")) {
      const parts = attachment.dataURL.split(",");
      const base64 = parts[1] ?? "";
      const binary = decodeCanonicalBase64(base64);
      const chunkSize = 256 * 1024; // 256 KiB chunks
      for (let offset = 0; offset < binary.length; offset += chunkSize) {
        const chunk = binary.subarray(offset, Math.min(binary.length, offset + chunkSize));
        await appendWasmStreamInput({ ref: inputRef, owner, bytes: chunk, storage });
      }
      totalBytes = binary.byteLength;
    } else if (typeof attachment.content === "string") {
      const encoded = new TextEncoder().encode(attachment.content);
      await appendWasmStreamInput({ ref: inputRef, owner, bytes: encoded, storage });
      totalBytes = encoded.byteLength;
    } else {
      // Empty input
      totalBytes = 0;
    }

    await sealWasmStreamInput({ ref: inputRef, owner, storage });
    return Object.freeze({
      ok: true,
      inputRef,
      name,
      bytes: totalBytes,
    });
  } catch (err) {
    await discardWasmStream({ ref: inputRef, owner, storage }).catch(() => {});
    throw err;
  }
}

/**
 * Stage an existing OPFS artifact as a sealed stream input so Wasm tools
 * can process stored files without copying entire strings into memory.
 */
export async function stageAssetAsWasmStream(asset, { owner, storage } = {}) {
  if (!asset || typeof asset !== "object") {
    fail("invalid_asset", "asset must be an object");
  }

  // Reference-preserving transfer: if the asset is already backed by a sealed OPFS
  // stream reference, revalidate the sealed stream and chain it directly without reading
  // or duplicating bytes.
  if (asset.meta?.streamRef) {
    const streamOwner = asset.meta.streamOwner ?? owner;
    const validated = await validateSealedWasmStream({ ref: asset.meta.streamRef, owner: streamOwner, storage });
    return Object.freeze({
      ok: true,
      inputRef: validated.ref,
      name: asset.name ?? "stream.bin",
      bytes: validated.bytes ?? asset.meta.streamBytes ?? asset.meta.bytes ?? asset.size ?? 0,
      chained: true,
    });
  }

  if (typeof asset.content !== "string") {
    fail("invalid_asset", "asset has no readable content or stream reference");
  }

  const name = String(asset.name ?? "asset.bin");
  const inputRef = await createWasmStreamInput({ owner, storage });

  try {
    const encoded = new TextEncoder().encode(asset.content);
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < encoded.length; offset += chunkSize) {
      const chunk = encoded.subarray(offset, Math.min(encoded.length, offset + chunkSize));
      await appendWasmStreamInput({ ref: inputRef, owner, bytes: chunk, storage });
    }
    await sealWasmStreamInput({ ref: inputRef, owner, storage });
    return Object.freeze({
      ok: true,
      inputRef,
      name,
      bytes: encoded.byteLength,
      chained: false,
    });
  } catch (err) {
    await discardWasmStream({ ref: inputRef, owner, storage }).catch(() => {});
    throw err;
  }
}

/**
 * Read an inline preview of a sealed stream (up to inlineThresholdBytes).
 * Never reads beyond the bounded preview threshold.
 */
export async function readWasmStreamPreview(ref, { owner, storage, maxBytes = STREAM_PLATFORM_LIMITS.inlineThresholdBytes } = {}) {
  const validated = await validateSealedWasmStream({ ref, owner, storage });
  const readLen = Math.min(validated.bytes, maxBytes);
  if (readLen === 0) {
    return { preview: "", complete: true, bytes: 0 };
  }
  const windowRes = await readWasmStreamWindow({ ref, owner, offset: 0, length: readLen, storage });
  const binary = decodeCanonicalBase64(windowRes.base64);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(binary);
  return {
    preview: text,
    complete: validated.bytes <= maxBytes,
    bytes: validated.bytes,
  };
}

/**
 * Promote a completed stream output into a durable OPFS artifact.
 * When output size exceeds inlineThresholdBytes (or upon caller request),
 * this promotes the output into a permanent artifact under the origin's store
 * via createAssetKeyed (idempotent and crash-resilient).
 */
export async function promoteWasmStreamToArtifact(outputRef, {
  origin = "master",
  name = "tool-output.txt",
  type = "text",
  owner,
  storage,
  force = false,
} = {}) {
  const validated = await validateSealedWasmStream({ ref: outputRef, owner, storage });
  const shouldPromote = force || validated.bytes > STREAM_PLATFORM_LIMITS.inlineThresholdBytes;

  const previewData = await readWasmStreamPreview(outputRef, { owner, storage });

  if (!shouldPromote) {
    return Object.freeze({
      ok: true,
      promoted: false,
      outputRef,
      bytes: validated.bytes,
      stdout: previewData.preview,
      stdoutComplete: previewData.complete,
    });
  }

  // Mark stream metadata as promoted so orphan GC never sweeps it
  try {
    const metaHandle = await validated.directory.getFileHandle("authority.json");
    const metaObj = JSON.parse(await (await metaHandle.getFile()).text());
    metaObj.promoted = true;
    const metaWriter = await metaHandle.createWritable();
    await metaWriter.write(JSON.stringify(metaObj));
    await metaWriter.close();
  } catch { /* best effort */ }

  // Reference-preserving artifact promotion: large or binary outputs must NEVER
  // be whole-buffered into JS strings or re-encoded as UTF-8. The artifact records
  // the bounded preview for UI display and retains the immutable, sealed OPFS stream
  // reference under meta.streamRef (zero-copy, binary-safe).
  const isComplete = validated.bytes <= STREAM_PLATFORM_LIMITS.inlineThresholdBytes;
  const content = previewData.preview;
  const promotionKey = `stream-promo:${outputRef.id}`;
  const assetResult = await createAssetKeyed(origin, {
    key: promotionKey,
    type,
    name,
    content,
    meta: {
      streamRef: outputRef,
      streamId: outputRef.id,
      streamOwner: owner,
      bytes: validated.bytes,
      isStreamBacked: true,
      fileBacked: true,
      contentComplete: isComplete,
      contentIncomplete: !isComplete,
      streamBytes: validated.bytes,
    },
  });

  if (!assetResult.ok) {
    fail("artifact_promotion_failed", assetResult.error);
  }

  return Object.freeze({
    ok: true,
    promoted: true,
    artifactId: assetResult.id,
    asset: assetResult.asset,
    outputRef,
    bytes: validated.bytes,
    stdout: previewData.preview,
    stdoutComplete: previewData.complete,
  });
}

/**
 * Tracks active unsealed streams per owner to bound concurrent stream allocations.
 * Prevents memory exhaustion or file descriptor leakage from hostile flooding.
 */
export function createStreamQuotaTracker({ maxActive = STREAM_PLATFORM_LIMITS.maxActiveStreamsPerRun } = {}) {
  const activeCounts = new Map();
  return Object.freeze({
    claim(owner) {
      const current = activeCounts.get(owner) ?? 0;
      if (current >= maxActive) {
        fail("stream_quota_exceeded", `active stream quota exceeded (${maxActive} per owner)`);
      }
      activeCounts.set(owner, current + 1);
      return current + 1;
    },
    release(owner) {
      const current = activeCounts.get(owner) ?? 0;
      if (current <= 1) {
        activeCounts.delete(owner);
      } else {
        activeCounts.set(owner, current - 1);
      }
    },
    count(owner) {
      return activeCounts.get(owner) ?? 0;
    },
    clear() {
      activeCounts.clear();
    },
  });
}

/**
 * Clean up unsealed or corrupt streams older than maxAgeMs.
 * Bounded garbage collection ensuring abandoned streams never leak OPFS space.
 */
export async function gcOrphanStreams({ maxAgeMs = 3600_000, storage } = {}) {
  const entries = await listWasmStreamEntries({ storage });
  const now = Date.now();
  let collected = 0;
  for (const entry of entries) {
    const meta = entry.meta;
    // Promoted artifact streams are permanent — never sweep them!
    if (meta?.promoted === true) continue;
    const createdAt = meta && Number.isSafeInteger(meta.createdAt) ? meta.createdAt : 0;
    const isOld = (now - createdAt) > maxAgeMs;
    if (!meta || (!meta.sealed && isOld)) {
      try {
        const root = await storage?.getDirectory?.();
        if (root) {
          const streamsDir = await root.getDirectoryHandle("wasm-tool-streams-v1");
          await streamsDir.removeEntry(entry.id, { recursive: true });
          collected++;
        }
      } catch { /* best effort */ }
    }
  }
  return { collected };
}

/**
 * Execute a stream job with guaranteed wall-clock deadline enforcement.
 * If execution times out, onTimeout (terminating worker + cleaning up output stream)
 * is called and a typed timeout response is returned.
 */
export async function runManagedStreamJob(jobFn, {
  timeoutMs = STREAM_PLATFORM_LIMITS.defaultTimeoutMs,
  onTimeout = () => {},
} = {}) {
  const boundedTimeout = Math.max(100, Math.min(timeoutMs, STREAM_PLATFORM_LIMITS.maxTimeoutMs));
  let timer;
  let timedOut = false;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(async () => {
      timedOut = true;
      try { await onTimeout(); } catch { /* best effort */ }
      resolve(Object.freeze({
        ok: false,
        phase: "timeout",
        error: "wall deadline exceeded; worker terminated",
      }));
    }, boundedTimeout);
  });

  try {
    const jobPromise = Promise.resolve().then(() => jobFn());
    const result = await Promise.race([jobPromise, timeoutPromise]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
